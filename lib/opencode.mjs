// opencode adapter: turns opencode.db into Session[] per THE CONTRACT.
// STRICTLY READ-ONLY on the sqlite file — never write, never checkpoint.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// node:sqlite needs a flag on Node 22 and can be compiled out entirely. A Node
// that cannot load it must cost the daemon its opencode sessions, not its life,
// and a static import would take the whole process down at load time.
let DatabaseSync = null;
try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); } catch {}

const BUSY_WINDOW = 60_000;            // row touched this recently + live process => busy
const AGENT_IDLE_DONE = 10 * 60_000;   // child session quiet this long => done
const MAX_TODOS = 20;
const POLL_MS = 2000;

const statOr = (p) => { try { return fs.statSync(p); } catch { return null; } };

// opencode stamps epoch milliseconds. Anything below 1e12 read as ms would be
// pre-2001 and is therefore seconds — a unit slip here does not fail loudly, it
// silently reports every session as ended and decades old.
const ms = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n < 1e12 ? n * 1000 : n);
};

const push = (m, k, v) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };

// Any opencode process on this machine. `-x` matches the process NAME exactly:
// `-f` would also match this daemon (its argv carries the module path) and any
// test whose file path contains "opencode", making liveness always true.
function pgrepOpencode() {
  try {
    const r = spawnSync('pgrep', ['-x', 'opencode'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    return r.status === 0;
  } catch { return false; }
}

const inert = () => ({
  sessions: () => [],
  refresh: () => false,
  tick: () => {},
  digestEvents: () => [],
  exportPath: () => null,
  distill: () => null,
  stop: () => {},
});

export function createOpencodeAdapter(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.home || os.homedir();
  const dataDir = opts.dataDir || env.OPENCODE_DATA_DIR
    || (env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, 'opencode') : path.join(home, '.local', 'share', 'opencode'));
  const dbPath = path.join(dataDir, 'opencode.db');
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const now = () => (opts.now ? opts.now() : Date.now());
  const pollMs = opts.pollMs ?? POLL_MS;
  const processAlive = opts.processAlive ?? pgrepOpencode;

  // No opencode on this machine: hand back something that answers every call
  // and watches nothing. Most machines running this daemon are in this branch.
  if (!DatabaseSync || !statOr(dbPath)) return inert();

  let db = null, tables = null;
  let rows = { roots: [], byParent: new Map(), turns: new Map(), todos: new Map() };
  let sessions = [];
  let lastSig = '';
  let alive = false, stopped = false, timer = null, warned = false;

  // ---- read-only connection ------------------------------------------------
  // Reopened on any failure: a WAL mid-recovery refuses read-only openers, and
  // that is a transient state, not a reason to go blind for the process's life.
  function open() {
    if (db) return db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      tables = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((r) => r.name));
    } catch { close(); }
    return db;
  }

  function close() {
    try { db?.close(); } catch {}
    db = null; tables = null;
  }

  const all = (sql) => { try { return db.prepare(sql).all(); } catch { close(); return []; } };

  // ---- rows ----------------------------------------------------------------
  // Both schemas can be present at once (the live db on mordor carries v2
  // session_message alongside the legacy message/part tables), so v2 wins
  // whenever it exists rather than whenever legacy is missing.
  function readRows() {
    const empty = { roots: [], byParent: new Map(), turns: new Map(), todos: new Map() };
    if (!open() || !tables.has('session')) return empty;
    const list = all(`select id, parent_id, title, directory, model, version, cost,
      summary_additions, summary_deletions, time_created, time_updated from session`);
    if (!list.length) return empty;

    const ids = new Set(list.map((r) => r.id));
    const roots = [], byParent = new Map();
    for (const r of list) {
      // A child whose parent is gone would otherwise vanish from the dashboard.
      if (r.parent_id && ids.has(r.parent_id)) push(byParent, r.parent_id, r);
      else roots.push(r);
    }
    return { roots, byParent, turns: readTurns(), todos: readTodos() };
  }

  // `tables` is nulled by close(), and close() runs on ANY failed query — so a
  // table vanishing under a live connection (the migration this dual-schema
  // support exists for) nulls it mid-readRows. Every read past the first query
  // must therefore tolerate a closed connection: the next pass reopens and
  // re-reads sqlite_master, so one empty pass is the whole cost.
  /** Turns = user prompts. json_extract keeps the legacy count out of JS. */
  function readTurns() {
    const t = new Map();
    const sql = tables?.has('session_message')
      ? "select session_id, count(*) n from session_message where type = 'user' group by session_id"
      : tables?.has('message')
        ? "select session_id, count(*) n from message where json_extract(data, '$.role') = 'user' group by session_id"
        : null;
    if (sql) for (const r of all(sql)) t.set(r.session_id, Number(r.n) || 0);
    return t;
  }

  function readTodos() {
    const m = new Map();
    if (!tables?.has('todo')) return m;
    for (const r of all('select session_id, content, status from todo order by session_id, position')) {
      const list = m.get(r.session_id);
      if (list && list.length >= MAX_TODOS) continue;
      push(m, r.session_id, { content: String(r.content ?? ''), status: String(r.status ?? 'pending') });
    }
    return m;
  }

  // ---- projection ----------------------------------------------------------
  // Liveness is process-wide: opencode has no per-session pid file, so a live
  // process plus a recently touched row is the strongest claim available.
  const statusOf = (updatedAt) => !alive ? 'ended'
    : (updatedAt && now() - updatedAt < BUSY_WINDOW ? 'busy' : 'idle');

  // Child sessions are this source's subagents. Flattened with parent links,
  // exactly like the Claude adapter's tree: a direct child hangs off the
  // session (parentAgentId null), a deeper one off the child above it.
  function foldAgents(rootId) {
    const out = [], seen = new Set([rootId]);
    const walk = (parentId, parentAgentId) => {
      for (const k of rows.byParent.get(parentId) || []) {
        if (seen.has(k.id)) continue;            // parent_id has no FK: a cycle would hang us
        seen.add(k.id);
        const lastEventAt = ms(k.time_updated);
        out.push({
          agentId: k.id,
          parentAgentId,
          type: 'opencode-subagent',
          description: k.title || null,
          model: k.model || null,
          workflowId: null,
          status: alive && lastEventAt && now() - lastEventAt < AGENT_IDLE_DONE ? 'running' : 'done',
          startedAt: ms(k.time_created),
          lastEventAt,
          transcriptPath: null,
        });
        walk(k.id, k.id);
      }
    };
    walk(rootId, null);
    return out;
  }

  function project(r) {
    const agents = foldAgents(r.id);
    // A working subagent is session activity: without this the parent sorts as
    // stale and a partial SSE tick sees no reason to resend its tree.
    let lastEventAt = ms(r.time_updated);
    for (const a of agents) if (a.lastEventAt > lastEventAt) lastEventAt = a.lastEventAt;

    const totalUSD = Number(r.cost) || 0;
    const linesAdded = Number(r.summary_additions) || 0;
    const linesRemoved = Number(r.summary_deletions) || 0;

    return {
      id: r.id,
      source: 'opencode',
      name: r.title || String(r.id).slice(0, 8),
      title: r.title || null,
      status: statusOf(lastEventAt),
      kind: 'interactive',
      pid: null,
      account: null,
      cwd: r.directory || null,
      gitBranch: null,
      model: r.model || null,
      version: r.version || null,
      tmux: null,
      startedAt: ms(r.time_created),
      lastEventAt,
      transcriptPath: null,        // opencode keeps no per-session file: /export 404s
      transcriptBytes: 0,
      cost: totalUSD || linesAdded || linesRemoved ? { totalUSD, linesAdded, linesRemoved } : null,
      currentTool: null,           // v1: the tool in flight lives in message parts
      recentTools: [],
      todos: rows.todos.get(r.id) || [],
      turns: rows.turns.get(r.id) || 0,
      agents,
      workflows: [],
      prs: [],
    };
  }

  // ---- refresh -------------------------------------------------------------
  // The rows are re-read every pass, deliberately: an mtime/size gate looks
  // free but is wrong. Two commits inside one filesystem timestamp tick leave
  // opencode.db byte-identical in size and mtime (measured here 2026-08-30), so
  // the gate drops the second write and the dashboard goes stale until some
  // later, luckier write. Three indexed queries over a local sqlite file every
  // two seconds is not the expensive thing in this daemon.
  function refresh() {
    rows = readRows();
    // No sessions to judge means no reason to spawn pgrep — the ordinary state
    // of a machine that has opencode installed but is not running it.
    alive = rows.roots.length > 0 && processAlive() === true;
    sessions = rows.roots.map(project).sort((a, b) => b.lastEventAt - a.lastEventAt);
    const sig = sessions.map((s) => `${s.id}:${s.status}:${s.lastEventAt}:${s.turns}:${s.cost?.totalUSD ?? ''}:${s.agents.map((a) => a.status).join('')}`).join('|');
    const moved = sig !== lastSig;
    lastSig = sig;
    return moved;
  }

  // Runs inside a timer, where an escaping exception is an uncaughtException and
  // the daemon dies with every Claude session it was serving. Nothing this
  // source can do is worth that, so nothing gets out.
  // Warned once, not per tick: a broken source that logs every two seconds
  // buries the daemon's real output, and a silent one is never diagnosed.
  function tick() {
    try { if (!stopped && refresh()) onChange(); }
    catch (e) {
      if (!warned) { warned = true; console.warn('agenttrail: opencode source failing, sessions may be stale:', e.message); }
    }
  }

  refresh();

  // A plain heartbeat, no fs.watchFile: refresh() re-reads the db every pass
  // regardless, so watching dbPath/db-wal could not lower staleness below one
  // interval. It also covers the transition watching cannot see — opencode
  // exiting changes nothing on disk, and its sessions must still turn "ended".
  if (pollMs > 0) {
    timer = setInterval(tick, pollMs);
    timer.unref?.();
  }

  return {
    sessions: () => [...sessions],
    refresh,
    tick,                        // the timer's body, callable for deterministic polls
    digestEvents: () => [],      // v1: no journal for this source
    exportPath: () => null,      // no transcript file to hand over
    distill: () => null,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      close();
    },
  };
}
