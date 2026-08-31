// Claude Code adapter: turns ~/.claude into Session[] per THE CONTRACT.
// Owns all fs watching/tailing and the ~/.agenttrail journal.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { distill as distillTranscript } from './distill.mjs';
import { redact } from './redact.mjs';

const DAY = 86_400_000;
const JOURNAL_RETENTION = 7 * DAY;
const AGENT_IDLE_DONE = 10 * 60_000; // jsonl idle > 10min => done
const AGENT_RESWEEP = 15_000;        // how often finished agents are re-checked
const BUSY_WINDOW = 15_000;          // transcript touched this recently => busy
const MAX_DELTA = 16 << 20;          // bytes tailed per file per refresh
const BIG_LINE = 32 << 10;           // above this, sniff before JSON.parse
const RECENT_TOOLS = 8;
const MAX_TODOS = 20;
const MAX_PENDING = 64;              // in-flight tool calls held per session
const PROMPT_CHARS = 280;            // last-prompt text kept per session
const WF_DESC_CHARS = 200;           // workflow description kept from the script
const WF_RUNNING = 6;                // running agents listed per workflow
const LIVE_TOOLS = 12;               // agent transcripts tailed for a live tool, per pass
const TOOL_TAIL = 64 << 10;          // bytes read from the end of an agent transcript
const SCRIPT_HEAD = 32 << 10;        // bytes of a workflow script read for its meta
const MATERIAL_CHARS = 4000;         // summary material handed to the summarizer

// Substrings that make a big line worth parsing. Everything else is skipped
// without JSON.parse (plan: transcript lines reach ~880KB).
const MARKERS = ['"tool_use"', '"toolUseResult"', '"turn_duration"', '"cost-state"',
  '"pr-link"', '"ai-title"', '"custom-title"', '"agent-name"', '"last-prompt"'];

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const statOr = (p) => { try { return fs.statSync(p); } catch { return null; } };
const lsOr = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const ts = (v) => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : 0; };

// ---- pid domain ------------------------------------------------------------
// ~/.claude syncs between machines, so sessions/<pid>.json can describe a pid on
// a DIFFERENT host. process.kill(pid,0) would then answer about whatever local
// process happens to hold that number, and a session that ended days ago on the
// laptop shows up as busy here. Claude Code stamps the record with the domain
// the number is meaningful in:
//
//   linux:<machine-id>:pid:[<pid-namespace-inode>]
//
// Measured on mordor 2026-08-30: the middle token is /etc/machine-id, NOT
// /proc/sys/kernel/random/boot_id (which is a different value on the same host,
// and would mark every live session ended). The trailing part is the pid
// namespace — the same number in another namespace is another process.
//
// Judging is opt-in on both sides: a record without pidDomain (older Claude
// Code), or a host whose own domain we cannot compute (darwin, no /proc), keeps
// trusting kill(). We only ever declare a record foreign when we positively
// know our own identity and it differs.
const selfDomain = (() => {
  const d = { platform: process.platform, tokens: new Set(), ns: '' };
  if (process.platform !== 'linux') return d;      // darwin: no comparable id
  const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim().toLowerCase(); } catch { return ''; } };
  for (const t of [read('/etc/machine-id'), read('/var/lib/dbus/machine-id')]) if (t) d.tokens.add(t);
  const boot = read('/proc/sys/kernel/random/boot_id');
  if (boot) { d.tokens.add(boot); d.tokens.add(boot.replace(/-/g, '')); }
  try { d.ns = fs.readlinkSync('/proc/self/ns/pid'); } catch {}
  return d;
})();

/** This host's own pid domain, or null where it cannot be established. */
export const selfPidDomain = () => (selfDomain.tokens.size
  ? `${selfDomain.platform}:${[...selfDomain.tokens][0]}${selfDomain.ns ? ':' + selfDomain.ns : ''}`
  : null);

/**
 * Whether the record's pid number is meaningful on THIS host. Judged only on
 * what we can actually establish: a record from another OS is foreign anywhere,
 * a machine-id mismatch is foreign where we can read our own, and everything
 * else — no domain claimed, an unknown shape, a host we cannot identify —
 * stays trusted rather than guessed.
 */
export function sameDomain(pidDomain) {
  if (typeof pidDomain !== 'string' || !pidDomain) return true;  // nothing claimed
  const i = pidDomain.indexOf(':');
  const j = pidDomain.indexOf(':', i + 1);
  if (i < 0 || j < 0) return true;                               // unknown shape: do not judge
  if (pidDomain.slice(0, i).toLowerCase() !== selfDomain.platform) return false;
  if (selfDomain.tokens.size && !selfDomain.tokens.has(pidDomain.slice(i + 1, j).toLowerCase())) return false;
  const ns = pidDomain.slice(j + 1);
  return !selfDomain.ns || !ns.startsWith('pid:[') || ns === selfDomain.ns;
}

function pidAlive(pid, pidDomain) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // A foreign number never reaches kill(), so EPERM ("taken, but not ours to
  // signal") counts as alive only for records from this domain.
  if (!sameDomain(pidDomain)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Human-readable one-liner for a tool_use block.
function toolDetail(name, input) {
  if (!input || typeof input !== 'object') return '';
  const pick = (...keys) => { for (const k of keys) if (typeof input[k] === 'string' && input[k]) return input[k]; return ''; };
  let d;
  switch (name) {
    case 'Bash': d = pick('command'); break;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': d = pick('file_path', 'notebook_path'); break;
    case 'Grep': case 'Glob': d = pick('pattern'); break;
    case 'WebFetch': case 'WebSearch': d = pick('url', 'query'); break;
    case 'Skill': d = pick('skill'); break;
    case 'Task': case 'Agent': d = pick('description', 'subagent_type'); break;
    default: d = pick('description', 'prompt', 'path', 'file_path', 'command', 'query');
  }
  return d.replace(/\s+/g, ' ').trim().slice(0, 200);
}

// A cwd that lives in a worktree names the FEATURE, not the checkout: every
// agent worktree under /srv/worktrees or <repo>/.claude/worktrees would
// otherwise collapse to whatever the basename happens to be.
const WORKTREE = /(?:^\/srv|(?:^|\/)\.claude)\/worktrees\/([^/]+)(?:\/|$)/;
const trimSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/**
 * Stable identity for a session: the repo/worktree it works in plus its branch.
 * The birth name in sessions/<pid>.json is minted once and never revised, which
 * is useless on a session that has been resumed for days.
 */
function canonicalOf(cwd, branch, home) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const p = trimSlash(cwd);
  const wt = WORKTREE.exec(p);
  const repo = wt ? wt[1] : (p === trimSlash(home) ? 'home' : path.basename(p) || null);
  return repo ? { repo, branch: branch || null } : null;
}

// ---- workflow script meta ---------------------------------------------------
// The Workflow tool saves each script at <projectDir>/<sessionId>/workflows/
// scripts/<name>-<wfId>.js and its first statement is `export const meta = {...}`
// — a pure literal by the tool's own contract. It is read with regexes over the
// bounded literal and NEVER evaluated: the file is model-written code with the
// full reach of the machine, and a dashboard must not run it to draw a label.

/** End of the object/array literal opening at `open`, or -1. Skips strings. */
function literalEnd(text, open) {
  let depth = 0, q = '';
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '\\') i++;
      else if (ch === q) q = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') q = ch;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { if (--depth === 0) return i + 1; }
  }
  return -1;
}

const unquote = (s) => s.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
// Known ceiling, accepted: this is a scan, not a parse, so it cannot tell a real
// key from a key-lookalike sitting INSIDE an earlier string value — a meta whose
// description reads `"pass name: 'x' to the agent"` before the real `name:` hands
// back `x`. The blast radius is one wrong label on one card, and the alternative
// (a JS parser, or eval) costs far more than the defect: the script is
// model-written code with the full reach of the machine, and a dashboard must
// never run it to draw a label. First match wins, so a normally-ordered meta —
// name first, as the tool writes it — is unaffected.
const strField = (key) =>
  new RegExp(`\\b${key}\\s*:\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`, 'g');

function firstString(block, key) {
  const m = strField(key).exec(block);
  return m ? oneLine(unquote(m[1] ?? m[2])) || null : null;
}

function phaseTitles(block) {
  const at = block.search(/\bphases\s*:\s*\[/);
  if (at < 0) return [];
  const open = block.indexOf('[', at);
  const end = literalEnd(block, open);
  if (end < 0) return [];
  const span = block.slice(open, end);
  const out = [];
  const re = strField('title');
  for (let m; (m = re.exec(span)) && out.length < 20;) {
    const t = oneLine(unquote(m[1] ?? m[2]));
    if (t) out.push(t);
  }
  return out;
}

/** `{name, description, phases}` from the script owning wfId, or null. */
function readScriptMeta(dir, wfId) {
  let file = null;
  for (const f of lsOr(dir)) {
    if (!f.isDirectory() && f.name.endsWith(`-${wfId}.js`)) { file = path.join(dir, f.name); break; }
  }
  if (!file) return null;
  let head = '', fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.allocUnsafe(SCRIPT_HEAD);
    head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, SCRIPT_HEAD, 0));
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }

  const at = head.indexOf('export const meta');
  const open = at < 0 ? -1 : head.indexOf('{', at);
  const end = open < 0 ? -1 : literalEnd(head, open);
  if (end < 0) return null;                 // absent, truncated or malformed: no guessing
  const block = head.slice(open, end);
  const name = firstString(block, 'name');
  const description = firstString(block, 'description');
  const phases = phaseTitles(block);
  if (!name && !description && !phases.length) return null;
  return { name, description: description ? description.slice(0, WF_DESC_CHARS) : null, phases };
}

/** The first phase whose title appears in a running agent's label, else null. */
function currentPhase(titles, running) {
  for (const t of titles) {
    const needle = t.toLowerCase();
    for (const a of running) {
      const label = (a.description || '').toLowerCase();
      if (label && label.includes(needle)) return t;
    }
  }
  return null;                              // never a guess
}

// ---- live tool line for a running subagent ---------------------------------
/**
 * The tool a subagent is executing right now, read from the END of its own
 * transcript: only the last TOOL_TAIL bytes are touched, so a 300MB agent log
 * costs one read of 64KB. The window can start mid-record, so the first
 * newline is the first line worth trusting.
 */
function tailTool(p, size) {
  const from = Math.max(0, size - TOOL_TAIL);
  const want = size - from;
  if (want <= 0) return null;
  let buf, fd;
  try {
    fd = fs.openSync(p, 'r');
    buf = Buffer.allocUnsafe(want);
    const read = fs.readSync(fd, buf, 0, want, from);
    if (read < want) buf = buf.subarray(0, read);
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }

  let text = buf.toString('utf8');
  if (from > 0) text = text.slice(text.indexOf('\n') + 1);

  const lines = text.split('\n');
  const closedIds = new Set(), closedUuids = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let r; try { r = JSON.parse(lines[i]); } catch { continue; }
    const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
    if (r.type === 'user') {
      for (const b of blocks) if (b?.type === 'tool_result' && b.tool_use_id) closedIds.add(b.tool_use_id);
      if (r.sourceToolAssistantUUID) closedUuids.add(r.sourceToolAssistantUUID);
      continue;
    }
    if (r.type !== 'assistant' || (r.uuid && closedUuids.has(r.uuid))) continue;
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k];
      if (b?.type !== 'tool_use' || (b.id && closedIds.has(b.id))) continue;
      return { name: String(b.name || 'tool'), detail: toolDetail(b.name, b.input), at: ts(r.timestamp) };
    }
  }
  return null;
}

export function createClaudeAdapter(opts = {}) {
  const home = opts.home || os.homedir();
  const claudeDir = opts.claudeDir || path.join(home, '.claude');
  const accountsDir = opts.accountsDir || path.join(home, '.claude-accounts');
  const stateDir = opts.stateDir || path.join(home, '.agenttrail');
  const offsetsPath = opts.offsetsPath || path.join(stateDir, 'offsets.json');
  const journalPath = opts.journalPath || path.join(stateDir, 'journal.jsonl');
  const projectsDir = path.join(claudeDir, 'projects');
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const pollMs = opts.pollMs ?? 2000;
  // Bytes read per file per pass. A boot replay of a 50MB transcript arrives in
  // chunks so no single tick carries the whole file; tests shrink it to reach
  // the half-replayed state a real daemon hits for a second or two.
  const maxDelta = opts.maxDelta ?? MAX_DELTA;
  const resweepMs = opts.resweepMs ?? AGENT_RESWEEP;
  const debounceMs = Math.min(opts.debounceMs ?? 250, 500);
  const now = () => (opts.now ? opts.now() : Date.now());

  const S = new Map();        // sessionId -> mutable session state
  const offsets = new Map();  // transcript path -> byte offset (newline-aligned)
  const index = new Map();    // sessionId -> transcript path
  const watchers = new Set();
  const watched = new Set();  // dirs already watched
  const openInJournal = new Map(); // sessionId -> name, announced on disk and not yet ended
  let timer = null, debounce = null, stopped = false, offsetsDirty = false, booted = false;
  let quiet = false;          // true while replaying bytes a previous run journalled

  // ---- state dir + persisted offsets --------------------------------------
  // A persisted offset records what an earlier run already ANNOUNCED, not what
  // this run knows. Everything in a Session except liveness — title, cost,
  // model, turns, PRs, todos, the tool in flight — exists only inside the
  // transcript, so resuming at EOF hands the dashboard a fleet of blank cards
  // and keeps them blank until each session happens to speak again; a resumed
  // session can sit quiet for hours.
  //
  // So each boot REPLAYS every transcript from byte 0 to rebuild state, and the
  // persisted offset becomes a per-session journal floor: records below it were
  // observed by an earlier run and must not be announced a second time. The
  // cost is one sequential pass over the live transcripts at boot (177MB across
  // the 11 live sessions on mordor, 2026-08-30), split into MAX_DELTA chunks so
  // no single tick carries the whole file.
  const floors = new Map();
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
  for (const [k, v] of Object.entries(readJson(offsetsPath) || {})) {
    if (Number.isFinite(v) && v > 0) floors.set(k, v);
  }
  // What gets persisted is "announced up to here", which is the offset once the
  // replay has caught up and the floor until then — a run killed mid-replay must
  // not lower the mark and let the next boot re-announce the gap. Floors for
  // sessions this run never tailed (ended before it started) are carried through
  // untouched, so a --resume weeks later still knows where it left off.
  const saveOffsets = () => {
    const out = Object.fromEntries(floors);
    for (const [k, v] of offsets) out[k] = Math.max(v, floors.get(k) ?? 0);
    try { fs.writeFileSync(offsetsPath, JSON.stringify(out)); } catch {}
  };

  // ---- journal -------------------------------------------------------------
  // Also seeds openInJournal, so a daemon restart does not re-announce a
  // session-start for every session that is still alive. Lines are in append
  // order, so a later session-end reopens the id for a resumed session.
  function pruneJournal() {
    const cut = now() - JOURNAL_RETENTION;
    let raw; try { raw = fs.readFileSync(journalPath, 'utf8'); } catch { return; }
    const keep = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (ts(e.at) < cut) continue;
      keep.push(line);
      if (e.kind === 'session-start') openInJournal.set(e.sessionId, e.name || e.sessionId.slice(0, 8));
      else if (e.kind === 'session-end') openInJournal.delete(e.sessionId);
    }
    try { fs.writeFileSync(journalPath, keep.length ? keep.join('\n') + '\n' : ''); } catch {}
  }

  function journal(at, sessionId, name, kind, data) {
    if (quiet) return;                       // replaying bytes an earlier run announced
    if (!Number.isFinite(at) || at < now() - JOURNAL_RETENTION) return;
    try {
      fs.appendFileSync(journalPath, JSON.stringify({ at, sessionId, name, kind, data }) + '\n');
    } catch {}
  }

  // Every /digest and every /session/<id> asks for this file, and a week of
  // journal is thousands of lines to parse per request. Cached exactly the way
  // journalResults caches a workflow journal — on (size, mtimeMs), which any
  // append moves — so a burst of requests parses it once.
  let journalCache = null;
  function journalAll() {
    const st = statOr(journalPath);
    if (!st) return [];
    if (journalCache && journalCache.size === st.size && journalCache.mtimeMs === st.mtimeMs) return journalCache.events;
    let raw = ''; try { raw = fs.readFileSync(journalPath, 'utf8'); } catch { return []; }
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      events.push(e);
    }
    events.sort((a, b) => a.at - b.at);
    journalCache = { size: st.size, mtimeMs: st.mtimeMs, events };
    return events;
  }

  pruneJournal();

  // ---- sessionId -> transcript path ---------------------------------------
  // NEVER decode cwd from the project slug (lossy). Scan the dirs instead.
  function buildIndex() {
    index.clear();
    for (const d of lsOr(projectsDir)) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      const dir = path.join(projectsDir, d.name);
      for (const f of lsOr(dir)) {
        if (f.isDirectory() || !f.name.endsWith('.jsonl')) continue;
        index.set(f.name.slice(0, -6), path.join(dir, f.name));
      }
    }
  }

  function findTranscript(sessionId) {
    let p = index.get(sessionId);
    if (p && statOr(p)) return p;
    buildIndex();                       // refresh on miss
    p = index.get(sessionId);
    return p && statOr(p) ? p : null;
  }

  buildIndex();

  // ---- liveness: sessions/<pid>.json is authoritative ----------------------
  function sessionDirs() {
    const dirs = [{ dir: path.join(claudeDir, 'sessions'), account: null }];
    for (const d of lsOr(accountsDir)) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      dirs.push({ dir: path.join(accountsDir, d.name, 'sessions'), account: d.name });
    }
    return dirs;
  }

  // One sessionId can own SEVERAL pid files at once: a kill -9 or an OOM leaves
  // sessions/<pid>.json behind, and --resume reuses the same sessionId under a
  // fresh pid. Applying those records one by one in readdir order announces the
  // session on the live record and buries it on the dead one, every single pass.
  // So the records are collapsed to one winner per session BEFORE anything is
  // applied: alive beats dead, and among equals the newest record wins.
  function pickLiveRecords() {
    const best = new Map();
    for (const { dir, account } of sessionDirs()) {
      for (const f of lsOr(dir)) {
        if (!f.name.endsWith('.json')) continue;
        const rec = readJson(path.join(dir, f.name));
        if (!rec?.sessionId) continue;
        const alive = pidAlive(rec.pid, rec.pidDomain);
        const cur = best.get(rec.sessionId);
        if (!cur || (alive && !cur.alive) ||
            (alive === cur.alive && ts(rec.updatedAt) > ts(cur.rec.updatedAt))) {
          best.set(rec.sessionId, { rec, account, alive });
        }
      }
    }
    return best;
  }

  function scanLiveness() {
    const live = pickLiveRecords();
    for (const [sessionId, { rec, account, alive }] of live) {
      let s = S.get(sessionId);
      if (!s) {
        s = newSession(sessionId);
        // Already announced by an earlier daemon run: do not repeat it.
        s.announced = openInJournal.has(sessionId);
        S.set(sessionId, s);
      }
      s.account = account;
      s.pid = Number.isInteger(rec.pid) ? rec.pid : null;
      s.alive = alive;
      s.fileStatus = rec.status || 'idle';
      s.liveName = rec.name || null;
      s.kind = rec.kind || s.kind || 'interactive';
      s.tmux = rec.tmux || null;
      s.startedAt = ts(rec.startedAt) || s.startedAt;
      if (rec.cwd) s.cwd = rec.cwd;
      if (rec.version) s.version = rec.version;
      s.lastEventAt = Math.max(s.lastEventAt, ts(rec.updatedAt));

      if (s.alive && !s.announced) {
        s.announced = true;
        s.closed = false;
        openInJournal.set(s.id, sessionName(s));
        journal(s.startedAt || now(), s.id, sessionName(s), 'session-start', { cwd: s.cwd, kind: s.kind });
      }
      if (!s.alive) closeSession(s);         // every record for this id is dead
    }
    // Claude Code DELETES sessions/<pid>.json on a clean exit, so the vanished
    // file — not the dead pid — is the ordinary end of a session.
    for (const s of S.values()) {
      if (live.has(s.id)) continue;
      s.alive = false;
      closeSession(s);
    }
    // A session that exited while the daemon was down owns no pid file, so it
    // never enters S and closeSession can never reach it — yet the journal
    // still shows it as open. Close it here, once, or the digest carries it as
    // perpetually running and a later --resume is swallowed as "already
    // announced". The end time is unknowable; boot time is the honest bound.
    if (!booted) {
      booted = true;
      for (const [id, name] of [...openInJournal]) {
        if (live.has(id)) continue;
        openInJournal.delete(id);
        journal(now(), id, name, 'session-end', {});
      }
    }
  }

  // Reopens the id: --resume reuses the same sessionId for weeks, so a session
  // that ends and comes back inside one daemon run must announce itself again.
  function closeSession(s) {
    if (!s.announced || s.closed) return;
    s.closed = true;
    s.announced = false;
    openInJournal.delete(s.id);
    journal(now(), s.id, sessionName(s), 'session-end', { cwd: s.cwd });
  }

  function newSession(id) {
    return {
      id, account: null, pid: null, alive: false, fileStatus: 'idle',
      liveName: null, title: null, lastPrompt: null, kind: 'interactive', tmux: null,
      cwd: null, gitBranch: null, model: null, version: null,
      startedAt: 0, lastEventAt: 0, turns: 0,
      cost: null, pending: new Map(), toolSeq: 0, recentTools: [], todos: [], prs: [],
      prKeys: new Set(), agentResults: new Map(),
      announced: false, closed: false, transcriptPath: null, transcriptBytes: 0,
      lastCost: null, lastTitle: null, treeFp: '',
    };
  }

  const sessionName = (s) => s.liveName || s.title || s.id.slice(0, 8);

  // ---- tailing -------------------------------------------------------------
  // Appends are NOT atomic: only ever advance the offset to a newline, so a
  // half-written trailing line is simply re-read on the next pass.
  function tail(s) {
    const p = s.transcriptPath || findTranscript(s.id);
    if (!p) return false;
    s.transcriptPath = p;
    const st = statOr(p);
    if (!st) return false;
    s.transcriptBytes = st.size;
    s.mtimeMs = st.mtimeMs;

    let from = offsets.get(p) ?? 0;
    if (from > st.size) from = 0;            // truncated / rotated
    if (floors.get(p) > st.size) floors.delete(p);   // ...and its floor went with it
    if (from === st.size) return false;

    const want = Math.min(st.size - from, maxDelta);
    let buf;
    let fd;
    try {
      fd = fs.openSync(p, 'r');
      buf = Buffer.allocUnsafe(want);
      const read = fs.readSync(fd, buf, 0, want, from);
      if (read < want) buf = buf.subarray(0, read);
    } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }

    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return false;            // no complete line yet; keep offset
    const end = from + lastNl + 1;
    offsets.set(p, end);
    offsetsDirty = true;                     // consumed bytes must survive a restart

    // Split the chunk at this file's journal floor. Everything below it is
    // replayed into state with the journal muted; everything at or above it is
    // new. The floor is itself a persisted offset, so it always sits on a line
    // boundary — the two halves are whole lines. Once passed, it is spent.
    const floor = floors.get(p) ?? 0;
    const cut = floor > from ? Math.min(lastNl + 1, floor - from) : 0;
    if (floor && end >= floor) floors.delete(p);

    let moved = false;
    const feed = (text, muted) => {
      quiet = muted;
      try {
        for (const line of text.split('\n')) {
          if (!line) continue;
          if (line.length > BIG_LINE && !MARKERS.some((m) => line.includes(m))) continue;
          let rec; try { rec = JSON.parse(line); } catch { continue; }
          if (applyRecord(s, rec)) moved = true;
        }
      } finally { quiet = false; }
    };
    if (cut > 0) feed(buf.toString('utf8', 0, cut), true);
    if (cut < lastNl + 1) feed(buf.toString('utf8', cut, lastNl + 1), false);
    return moved;
  }

  // ---- record application (only the types THE CONTRACT lists) --------------
  function applyRecord(s, r) {
    const at = ts(r.timestamp);
    if (at) s.lastEventAt = Math.max(s.lastEventAt, at);
    if (r.cwd) s.cwd = r.cwd;
    if (r.gitBranch) s.gitBranch = r.gitBranch;
    if (r.version) s.version = r.version;
    if (r.sessionKind) s.kind = r.sessionKind;

    switch (r.type) {
      case 'assistant': {
        if (r.message?.model) s.model = r.message.model;
        const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
        for (const b of blocks) {
          if (b?.type !== 'tool_use') continue;
          if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
            s.todos = b.input.todos.slice(0, MAX_TODOS)
              .map((t) => ({ content: String(t?.content ?? ''), status: String(t?.status ?? 'pending') }));
          }
          openTool(s, b, r.uuid, at);
        }
        return blocks.length > 0;
      }

      case 'user': {
        // A tool_result closes the tool it NAMES, never "whichever was last".
        // Issuing several tools in one turn is ordinary (3 at once in real
        // transcripts), and their results come back one record each, in any
        // order — closing the newest on the first result that arrives is what
        // left a demonstrably busy session reporting no current tool.
        let moved = false;
        for (const b of (Array.isArray(r.message?.content) ? r.message.content : [])) {
          if (b?.type === 'tool_result' && closeTool(s, at, b.tool_use_id, null)) moved = true;
        }
        if (!moved && r.sourceToolAssistantUUID && closeTool(s, at, null, r.sourceToolAssistantUUID)) moved = true;

        const tur = r.toolUseResult;
        if (tur && typeof tur === 'object' && tur.agentId) {
          // Subagent spawn / completion observed from the parent's side. This
          // record ALSO carries the Task tool's result, closed just above —
          // returning early here used to pin `Task` as the current tool for the
          // rest of the turn.
          s.agentResults.set(tur.agentId, {
            status: tur.status === 'completed' || tur.status === 'error' ? 'done' : 'running',
            description: tur.description || null,
            type: tur.agentType || null,
            model: tur.resolvedModel || null,
            at,
          });
          return true;
        }
        return moved || !!tur;
      }

      case 'system': {
        if (r.subtype === 'turn_duration') {
          s.turns += 1;
          endTurn(s, at);
          journal(at || now(), s.id, sessionName(s), 'turn',
            { durationMs: r.durationMs ?? 0, messageCount: r.messageCount ?? 0 });
          return true;
        }
        return false;                        // compact_boundary is a graft, not an end
      }

      // Written every time the user speaks, and carries NO timestamp of its own
      // (measured on real transcripts), so it borrows the session clock:
      // s.lastEventAt. Be precise about what that clock is — scanLiveness runs
      // before tail() on every pass and seeds it from sessions/<pid>.json
      // updatedAt, so on a boot replay it is the pid file's time, not the
      // timestamp of the transcript line above. That is a live session's own
      // "last seen", which is the honest bound available here; the point of not
      // using now() is that a replayed three-day-old prompt must not be dated
      // to this boot. Only a session with no pid record and no timestamped line
      // yet falls through to now().
      case 'last-prompt': {
        if (typeof r.lastPrompt !== 'string' || !r.lastPrompt) return false;
        s.lastPrompt = { text: r.lastPrompt.slice(0, PROMPT_CHARS), at: at || s.lastEventAt || now() };
        return true;
      }

      case 'ai-title': return setTitle(s, r.aiTitle, at);
      case 'custom-title': return setTitle(s, r.customTitle, at);
      case 'agent-name': return setTitle(s, r.agentName, at);

      case 'cost-state': {
        if (!Number.isFinite(r.totalCostUSD)) return false;
        s.cost = {
          totalUSD: r.totalCostUSD,
          linesAdded: r.totalLinesAdded ?? 0,
          linesRemoved: r.totalLinesRemoved ?? 0,
        };
        if (s.lastCost !== r.totalCostUSD) {
          s.lastCost = r.totalCostUSD;
          journal(at || now(), s.id, sessionName(s), 'cost', { totalUSD: r.totalCostUSD });
        }
        return true;
      }

      case 'pr-link': {
        if (!r.prNumber) return false;
        const key = `${r.prRepository || ''}#${r.prNumber}`;
        if (s.prKeys.has(key)) return false;
        s.prKeys.add(key);
        const pr = { number: r.prNumber, url: r.prUrl || null, repo: r.prRepository || null };
        s.prs.push(pr);
        journal(ts(r.timestamp) || at || now(), s.id, sessionName(s), 'pr', pr);
        return true;
      }

      default: return false;
    }
  }

  function setTitle(s, title, at) {
    if (typeof title !== 'string' || !title) return false;
    s.title = title;                         // last write wins across all three
    if (s.lastTitle !== title) {
      s.lastTitle = title;
      journal(at || now(), s.id, sessionName(s), 'title', { title });
    }
    return true;
  }

  // ---- in-flight tool calls -------------------------------------------------
  // A tool is in flight from its tool_use block until the tool_result naming it
  // arrives (matched on tool_use_id, or on the assistant record's uuid via
  // sourceToolAssistantUUID). `currentTool` is the newest one still unmatched.
  function openTool(s, b, uuid, at) {
    const key = String(b.id || uuid || `${s.toolSeq}`);
    s.toolSeq++;
    s.pending.set(key, { name: String(b.name || 'tool'), detail: toolDetail(b.name, b.input), at, uuid: uuid || null });
    // Results normally arrive within the turn, and the turn boundary sweeps
    // whatever is left. A truncated or interleaved transcript could still feed
    // this forever, so keep it a window, not a log.
    if (s.pending.size > MAX_PENDING) closeTool(s, at, s.pending.keys().next().value, null);
  }

  /** Close the named tool. Returns whether anything matched. */
  function closeTool(s, at, id, uuid) {
    let key = id && s.pending.has(id) ? id : null;
    if (key === null && !id && uuid) {
      for (const [k, t] of s.pending) if (t.uuid === uuid) { key = k; break; }
    }
    if (key === null) return false;
    const t = s.pending.get(key);
    s.pending.delete(key);
    s.recentTools.unshift({ name: t.name, detail: t.detail, at: t.at, ms: Math.max(0, (at || now()) - (t.at || 0)) });
    if (s.recentTools.length > RECENT_TOOLS) s.recentTools.length = RECENT_TOOLS;
    return true;
  }

  /** The turn ended: nothing can still be in flight. Newest lands newest. */
  function endTurn(s, at) {
    for (const key of [...s.pending.keys()]) closeTool(s, at, key, null);
  }

  const currentTool = (s) => {
    let last = null;
    for (const t of s.pending.values()) last = t;
    return last ? { name: last.name, detail: last.detail, at: last.at } : null;
  };

  // ---- subagents + workflows ----------------------------------------------
  // Nested agents are stored FLAT in the root session dir; the tree is rebuilt
  // from parentAgentId. Workflow agents live under subagents/workflows/wf_*/.
  // A real session reaches thousands of agents, so the scan is incremental: the
  // directories ARE listed every pass (see listAgents — caching that on dir
  // mtime hides an agent created in the same millisecond as the last scan), but
  // meta.json reads and workflow journal parses are cached, and only agents
  // still running are re-stat'ed. Terminal ones are re-checked on a slower
  // sweep, because an agent CAN be resumed and start appending again.
  function scanAgents(s) {
    const tp = s.transcriptPath;
    if (!tp) return { agents: [], workflows: [] };
    const root = path.join(path.dirname(tp), s.id, 'subagents');
    if (!statOr(root)) return { agents: [], workflows: [] };
    const c = (s.agentCache ||= { dirs: new Map(), journals: new Map(), sweptAt: 0 });
    const sweep = now() - c.sweptAt >= resweepMs;
    if (sweep) c.sweptAt = now();

    const agents = [];
    for (const a of listAgents(c, root, null)) agents.push(resolve(s, a, null, sweep));

    // The Workflow tool writes its scripts one level ABOVE subagents/.
    const scriptsDir = path.join(path.dirname(tp), s.id, 'workflows', 'scripts');
    const workflows = [];
    const pendingLive = [];    // running agents per workflow, resolved after the tool pass
    for (const d of lsOr(path.join(root, 'workflows'))) {
      if (!d.isDirectory() || !d.name.startsWith('wf_')) continue;
      const dir = path.join(root, 'workflows', d.name);
      const j = journalResults(c, dir);
      let n = 0, closed = 0, startedAt = 0;
      const live = [];
      for (const raw of listAgents(c, dir, d.name)) {
        const a = resolve(s, raw, j?.done ?? null, sweep);
        agents.push(a);
        n++;
        if (a.status === 'done') closed++;
        else if (live.length < WF_RUNNING) live.push(a);
        if (a.startedAt && (!startedAt || a.startedAt < startedAt)) startedAt = a.startedAt;
      }
      const meta = scriptMeta(c, scriptsDir, d.name, sweep);
      workflows.push({
        id: d.name,
        name: meta?.name ?? null,
        description: meta?.description ?? null,
        // done/total come from the journal, which is what the workflow itself
        // records; the agent counters below are what the filesystem shows.
        phase: meta?.phases.length
          ? { current: currentPhase(meta.phases, live), done: j ? j.done.size : 0, total: j ? j.started.size : 0 }
          : null,
        agents: n, done: closed, running: n - closed, startedAt,
        runningAgents: [],                     // filled after the tool pass below
      });
      pendingLive.push(live);
    }

    // Live tool lines cost one stat per running agent and one bounded read per
    // agent that actually moved, so the budget is per pass, not per agent.
    let budget = LIVE_TOOLS;
    for (const a of agents) {
      const on = a.status === 'running' && budget > 0;
      if (on) budget--;
      a.currentTool = on ? agentTool(c, a) : null;
    }
    workflows.forEach((w, i) => {
      w.runningAgents = pendingLive[i].map((a) => ({
        agentId: a.agentId, description: a.description, currentTool: a.currentTool,
      }));
    });
    return { agents, workflows };
  }

  /** Per-wfId script meta. The script is immutable, so a hit is kept forever. */
  function scriptMeta(c, dir, wfId, sweep) {
    const cache = (c.scripts ||= new Map());
    if (cache.has(wfId)) {
      const hit = cache.get(wfId);
      // A miss can be the window before the script lands: retry on the sweep.
      if (hit || !sweep) return hit;
    }
    const meta = readScriptMeta(dir, wfId);
    cache.set(wfId, meta);
    return meta;
  }

  /**
   * Cached on (agentId, size): an agent that has not written costs nothing at
   * all here. The size comes from the stat resolve() already did this pass —
   * every agent that reaches this is `running`, and running is exactly the
   * branch of resolve() that stats — so a live agent is not stat'ed twice.
   */
  function agentTool(c, a) {
    if (!a.transcriptPath || !Number.isFinite(a.size)) return null;
    const cache = (c.tools ||= new Map());
    const hit = cache.get(a.agentId);
    if (hit && hit.size === a.size) return hit.tool;
    const tool = tailTool(a.transcriptPath, a.size);
    cache.set(a.agentId, { size: a.size, tool });
    return tool;
  }

  /**
   * Immutable per-agent facts. The directory is listed every pass — a dir
   * mtime cache would hide an agent created in the same millisecond as the
   * previous scan — but meta.json is read only once per agent.
   */
  function listAgents(c, dir, workflowId) {
    let e = c.dirs.get(dir);
    if (!e) { e = { list: [], seen: new Set() }; c.dirs.set(dir, e); }
    for (const f of lsOr(dir)) {
      if (f.isDirectory() || !f.name.startsWith('agent-') || !f.name.endsWith('.meta.json')) continue;
      const agentId = f.name.slice('agent-'.length, -'.meta.json'.length);
      if (e.seen.has(agentId)) continue;
      e.seen.add(agentId);
      const metaPath = path.join(dir, f.name);
      const meta = readJson(metaPath) || {};
      const jsonl = path.join(dir, `agent-${agentId}.jsonl`);
      const js = statOr(jsonl);
      e.list.push({
        agentId,
        parentAgentId: meta.parentAgentId ?? null,
        type: meta.agentType || null,
        description: meta.description || null,
        model: meta.model ?? null,
        workflowId,
        startedAt: js ? Math.round(js.birthtimeMs || js.mtimeMs) : 0,
        lastEventAt: js ? Math.round(js.mtimeMs) : 0,
        transcriptPath: js ? jsonl : null,
        status: 'running',
        // internal, stripped by projectAgent(): an agent can be listed in the
        // window between meta.json and its jsonl, or from a torn meta read.
        jsonlPath: jsonl, metaPath,
      });
    }
    return e.list;
  }

  /**
   * The workflow's own record of itself: {type:"started"} is a task dispatched,
   * {type:"result"} is one that came back — which closes the agent AND is the
   * only honest source for phase progress (the filesystem cannot tell a task
   * the workflow retried from one it never ran).
   */
  function journalResults(c, dir) {
    const p = path.join(dir, 'journal.jsonl');
    const st = statOr(p);
    if (!st) return null;
    let e = c.journals.get(dir);
    if (e && e.mtimeMs === st.mtimeMs && e.size === st.size) return e;
    e = { mtimeMs: st.mtimeMs, size: st.size, done: new Set(), started: new Set() };
    let raw = ''; try { raw = fs.readFileSync(p, 'utf8'); } catch {}
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (!j.agentId) continue;
      if (j.type === 'result') { e.done.add(j.agentId); e.started.add(j.agentId); }
      else if (j.type === 'started') e.started.add(j.agentId);
    }
    c.journals.set(dir, e);
    return e;
  }

  // The listing caches each agent's first observation forever, so anything that
  // could have been missing at that instant is retried here.
  function backfill(a) {
    if (!a.transcriptPath) {
      const js = statOr(a.jsonlPath);
      if (js) {
        a.transcriptPath = a.jsonlPath;
        a.startedAt = Math.round(js.birthtimeMs || js.mtimeMs);
        a.lastEventAt = Math.round(js.mtimeMs);
      }
    }
    if (a.type) return;
    const meta = readJson(a.metaPath);
    if (!meta) return;
    a.type = meta.agentType || null;
    a.description ||= meta.description || null;
    a.model ??= meta.model ?? null;
    a.parentAgentId ??= meta.parentAgentId ?? null;
  }

  function resolve(s, a, journalDone, sweep) {
    if (!a.transcriptPath || (sweep && !a.type)) backfill(a);
    const parent = s.agentResults.get(a.agentId);
    if (parent) {
      a.type ||= parent.type;
      a.description ||= parent.description;
      a.model ??= parent.model;
    }
    if (a.status === 'done' && !sweep) return a;   // skip the stat until the sweep
    const st = a.transcriptPath ? statOr(a.transcriptPath) : null;
    // The size is kept so agentTool() can read the tail without stat'ing the
    // same file a second time in the same pass.
    a.size = st ? st.size : null;
    if (st) a.lastEventAt = Math.round(st.mtimeMs);

    // The parent record can only CLOSE an agent, never pin it open: virtually
    // every background agent has a spawn-time "async_launched" record, and an
    // orphaned one (parent killed) never gets its completion record — mtime
    // idle is the only signal left for exactly those.
    if (journalDone?.has(a.agentId) || parent?.status === 'done') a.status = 'done';
    else if (a.lastEventAt && now() - a.lastEventAt > AGENT_IDLE_DONE) a.status = 'done';
    else a.status = 'running';
    return a;
  }

  // ---- refresh -------------------------------------------------------------
  function refresh() {
    // lastEventAt is a contract field and the key a partial SSE tick filters on,
    // so it must never advance silently: a pass that only saw records the
    // adapter ignores still moves the session's clock, and a dashboard told
    // nothing shows a frozen "elapsed" until the next parsed record lands.
    const was = new Map();
    for (const s of S.values()) was.set(s.id, s.lastEventAt);
    scanLiveness();
    let moved = false;
    for (const s of S.values()) {
      if (tail(s)) moved = true;
      const st = s.transcriptPath ? statOr(s.transcriptPath) : null;
      if (st) {
        s.transcriptBytes = st.size;
        s.mtimeMs = st.mtimeMs;
        s.lastEventAt = Math.max(s.lastEventAt, Math.round(st.mtimeMs));
      }
      const prev = s.statusCache;
      s.statusCache = statusOf(s);
      if (prev !== s.statusCache) moved = true;
      s.tree = scanAgents(s);   // cached here so sessions() stays a pure read
      // Agent.status is Session state: a background workflow progressing while
      // the parent transcript is quiet is still movement the UI must see.
      const fp = treeFingerprint(s.tree);
      if (s.treeFp !== fp) moved = true;
      s.treeFp = fp;
      // A subagent writing is session activity too: without this the session
      // sorts as stale and a partial tick sees no reason to resend its tree.
      for (const a of s.tree.agents) {
        if (a.lastEventAt > s.lastEventAt) s.lastEventAt = a.lastEventAt;
      }
      // One rule for every source that can advance the clock — pid file, parsed
      // record, transcript mtime, subagent append. It only fires when the value
      // really moved, so it costs one tick per write, not one per pass.
      if (s.lastEventAt > (was.get(s.id) ?? 0)) moved = true;
      watchDir(s.transcriptPath && path.dirname(s.transcriptPath));
    }
    if (offsetsDirty) { saveOffsets(); offsetsDirty = false; }
    return moved;
  }

  // Cheap enough to run every pass on a session with thousands of agents.
  function treeFingerprint({ agents, workflows }) {
    let done = 0;
    for (const a of agents) if (a.status === 'done') done++;
    return `${agents.length}:${done}:${workflows.map((w) => `${w.id}=${w.done}/${w.agents}`).join(',')}`;
  }

  function statusOf(s) {
    if (!s.alive || s.pid === null) return 'ended';
    if (s.fileStatus === 'shell') return 'shell';
    if (s.fileStatus === 'busy') return 'busy';
    // sessions/<pid>.json status lags — a freshly touched transcript means busy.
    if (s.mtimeMs && now() - s.mtimeMs < BUSY_WINDOW) return 'busy';
    return 'idle';
  }

  // Exactly the Agent contract, copied: resolve() mutates the cached objects in
  // place, so a snapshot handed out by sessions() must not alias them.
  const projectAgent = (a) => ({
    agentId: a.agentId, parentAgentId: a.parentAgentId, type: a.type,
    description: a.description, model: a.model, workflowId: a.workflowId,
    status: a.status, startedAt: a.startedAt, lastEventAt: a.lastEventAt,
    transcriptPath: a.transcriptPath, currentTool: a.currentTool ?? null,
  });

  function project(s) {
    const status = s.statusCache || statusOf(s);
    const { agents, workflows } = s.tree || { agents: [], workflows: [] };
    return {
      id: s.id,
      source: 'claude',
      name: sessionName(s),
      title: s.title,
      canonical: canonicalOf(s.cwd, s.gitBranch, home),
      lastPrompt: s.lastPrompt ? { ...s.lastPrompt } : null,
      status,
      kind: s.kind,
      pid: s.pid,
      account: s.account,
      cwd: s.cwd,
      gitBranch: s.gitBranch,
      model: s.model,
      version: s.version,
      tmux: s.tmux,
      startedAt: s.startedAt,
      lastEventAt: s.lastEventAt,
      transcriptPath: s.transcriptPath,
      transcriptBytes: s.transcriptBytes,
      cost: s.cost,
      currentTool: status === 'ended' ? null : currentTool(s),
      recentTools: [...s.recentTools],
      todos: [...s.todos],
      turns: s.turns,
      agents: agents.map(projectAgent),
      workflows: workflows.map((w) => ({ ...w, runningAgents: (w.runningAgents || []).map((r) => ({ ...r })) })),
      prs: [...s.prs],
    };
  }

  const exportPath = (sessionId) =>
    S.get(sessionId)?.transcriptPath || findTranscript(sessionId);

  // ---- watching ------------------------------------------------------------
  function watchDir(dir) {
    if (!dir || watched.has(dir) || !statOr(dir)) return;
    watched.add(dir);
    try {
      const w = fs.watch(dir, { persistent: false }, () => kick());
      w.on('error', () => {});
      watchers.add(w);
    } catch {}
  }

  function kick() {
    if (stopped || debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      if (stopped) return;
      if (refresh()) onChange();
    }, debounceMs);
    debounce.unref?.();
  }

  refresh();
  for (const { dir } of sessionDirs()) watchDir(dir);
  watchDir(projectsDir);
  if (pollMs > 0) {
    // A dead pid produces no fs event, so liveness needs a heartbeat.
    timer = setInterval(() => { if (refresh()) onChange(); }, pollMs);
    timer.unref?.();
  }

  return {
    sessions() {
      return [...S.values()].map(project).sort((a, b) => b.lastEventAt - a.lastEventAt);
    },

    // Additive to THE CONTRACT: a synchronous pass so callers (and tests) never
    // have to race fs.watch. The watcher and the poll timer call the same thing.
    refresh,

    /**
     * The bounded window a summarizer needs, built entirely from state the tail
     * already holds — a summary must never cost a second pass over a 50MB
     * transcript. `version` is what the caller compares to decide whether the
     * session has said anything new since the last call.
     *
     * The text is redacted here, at the point it stops being adapter-internal
     * state: prompts and tool lines routinely carry a pasted key (there is one
     * on this machine right now), and this is the only value in the whole
     * adapter that is built to be handed to a third party.
     */
    material(sessionId) {
      const s = S.get(sessionId);
      if (!s) return null;                   // unknown, or owned by another source
      const lines = [];
      if (s.title) lines.push(`Title: ${s.title}`);
      if (s.lastPrompt?.text) lines.push(`Last prompt: ${s.lastPrompt.text}`);
      if (s.recentTools.length) {
        lines.push('Recent tools (newest first):');
        for (const t of s.recentTools.slice(0, RECENT_TOOLS)) {
          lines.push(`- ${t.name}${t.detail ? ` ${t.detail}` : ''}`);
        }
      }
      if (s.todos.length) {
        lines.push('Todos:');
        for (const t of s.todos) lines.push(`- [${t.status}] ${t.content}`);
      }
      return {
        version: `${s.transcriptBytes}:${s.turns}`,
        text: redact(lines.join('\n')).slice(0, MATERIAL_CHARS),
      };
    },

    digestEvents(sinceMs = 0) {
      return journalAll().filter((e) => ts(e.at) >= sinceMs);
    },

    /**
     * Whether this session's transcript has finished the boot replay. A summary
     * built mid-replay describes a window that stops halfway through the file
     * and is paid for at full price, so the caller waits. Additive to THE
     * CONTRACT — the shapes it names are untouched.
     */
    caughtUp(sessionId) {
      const p = S.get(sessionId)?.transcriptPath;
      return !p || !floors.has(p);
    },

    exportPath,

    async *distill(sessionId) {
      const p = exportPath(sessionId);
      const s = S.get(sessionId);
      if (p) yield* distillTranscript(p, s ? project(s) : { id: sessionId });
    },

    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      timer = debounce = null;
      for (const w of watchers) { try { w.close(); } catch {} }
      watchers.clear();
      saveOffsets();
    },
  };
}
