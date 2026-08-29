// Markdown distill of a Claude Code transcript: what a human wants to read back,
// not what the adapter needs to track state.
//
// Streams the file line by line (readline over a read stream) and yields chunks
// as it goes, so a 60MB transcript costs one line of memory, not 60MB. The
// generator is the backpressure: the daemon's write loop suspends it whenever
// the socket is full, and closing the iterator closes the fd.
import fs from 'node:fs';
import readline from 'node:readline';

const PROMPT_MAX = 4000;             // a pasted log is context, not content
const BIG_LINE = 32 << 10;           // above this, sniff before JSON.parse
const MAX_PENDING = 64;              // in-flight tool calls held per turn

// Substrings that make a big line worth parsing. Transcript lines reach ~880KB
// (a pasted dump), and most of those are records distill has nothing to say
// about. Everything without one of these is skipped without JSON.parse.
const MARKERS = ['"role":"user"', '"text"', '"tool_use"', '"toolUseResult"',
  '"turn_duration"', '"compact_boundary"'];

/** One-line summary of a tool call's input. */
function detail(name, input) {
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

const ts = (v) => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : 0; };

function human(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Wrap a prompt in a fence long enough to survive the backticks inside it, and
 * cut a pasted dump down to something readable, saying so where it was cut.
 */
function block(text) {
  let body = text;
  let cut = 0;
  if (body.length > PROMPT_MAX) { cut = body.length - PROMPT_MAX; body = body.slice(0, PROMPT_MAX); }
  let longest = 0;
  for (const run of body.match(/`+/g) || []) longest = Math.max(longest, run.length);
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}\n${body}${cut ? `\n… [truncated ${cut} chars]` : ''}\n${f}\n`;
}

export async function* distill(transcriptPath, meta = {}) {
  yield* header(meta);
  yield* body(transcriptPath);
}

function* header(meta) {
  yield `# ${meta.title || `Session ${meta.id || 'transcript'}`}\n\n`;
  const lines = [];
  if (meta.cwd) lines.push(`- **cwd** \`${meta.cwd}\``);
  if (meta.gitBranch) lines.push(`- **branch** \`${meta.gitBranch}\``);
  if (meta.model) lines.push(`- **model** ${meta.model}`);
  if (meta.cost && Number.isFinite(meta.cost.totalUSD)) {
    const { totalUSD, linesAdded = 0, linesRemoved = 0 } = meta.cost;
    lines.push(`- **cost** $${totalUSD.toFixed(2)} (+${linesAdded} / -${linesRemoved} lines)`);
  }
  if (lines.length) yield `${lines.join('\n')}\n`;
}

// Errors that mean "this transcript is not readable", as opposed to a bug in
// here. A file can be rotated or deleted mid-export; that ends the markdown
// early, it does not tear the download down.
const FS_ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'ENAMETOOLONG']);

async function* body(transcriptPath) {
  const stream = fs.createReadStream(transcriptPath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // A tool call is held from its tool_use block until the tool_result naming it
  // arrives, so the line can carry a real duration. Whatever is still in flight
  // when the turn ends gets written without one — same rule the adapter uses.
  const pending = new Map();
  let turn = 0;
  let open = false;

  function* openTurn() { if (!open) { open = true; yield `\n## Turn ${++turn}\n`; } }

  function* toolLine(t, ms) {
    yield* openTurn();
    const d = t.detail ? ` ${t.detail}` : '';
    const took = ms > 0 ? ` _(${human(ms)})_` : '';
    yield `\n- \`${t.name}\`${d}${took}\n`;
  }

  function* flush() {
    for (const t of pending.values()) yield* toolLine(t, 0);
    pending.clear();
  }

  /** Take a held tool off the pending list, by result id or by opening record. */
  const take = (id, uuid) => {
    if (id && pending.has(id)) { const t = pending.get(id); pending.delete(id); return t; }
    if (uuid) for (const [k, t] of pending) if (t.uuid === uuid) { pending.delete(k); return t; }
    return null;
  };

  try {
    for await (const raw of rl) {
      if (!raw) continue;
      if (raw.length > BIG_LINE && !MARKERS.some((m) => raw.includes(m))) continue;
      // A transcript is appended to while we read it, so the last line can be
      // half-written. It fails to parse and is simply dropped, exactly like the
      // adapter's tailer refuses to advance past a partial line.
      let r; try { r = JSON.parse(raw); } catch { continue; }
      const at = ts(r.timestamp);

      switch (r.type) {
        case 'assistant': {
          for (const b of (Array.isArray(r.message?.content) ? r.message.content : [])) {
            // thinking / redacted_thinking are never written: reasoning is not
            // the record of what happened, and it is the bulk of a transcript.
            if (b?.type === 'text' && b.text) { yield* openTurn(); yield `\n${b.text}\n`; }
            else if (b?.type === 'tool_use') {
              pending.set(String(b.id || r.uuid || pending.size), {
                name: String(b.name || 'tool'), detail: detail(b.name, b.input), at, uuid: r.uuid || null,
              });
              if (pending.size > MAX_PENDING) yield* toolLine(take(pending.keys().next().value, null), 0);
            }
          }
          break;
        }

        case 'user': {
          if (r.isMeta) break;
          const blocks = Array.isArray(r.message?.content) ? r.message.content : [];

          // A spawn record also carries the Task tool's result. Report the
          // subagent, not the plumbing that started it.
          const spawn = r.toolUseResult;
          if (spawn && typeof spawn === 'object' && spawn.agentId) {
            for (const b of blocks) if (b?.type === 'tool_result') take(b.tool_use_id, null);
            take(null, r.sourceToolAssistantUUID);
            yield* openTurn();
            yield `\n- spawned **${spawn.agentType || 'subagent'}**${spawn.description ? ` — ${spawn.description}` : ''}\n`;
            break;
          }

          let closed = false;
          for (const b of blocks) {
            if (b?.type !== 'tool_result') continue;
            const t = take(b.tool_use_id, null);
            if (t) { closed = true; yield* toolLine(t, at && t.at ? at - t.at : 0); }
          }
          if (!closed && r.sourceToolAssistantUUID) {
            const t = take(null, r.sourceToolAssistantUUID);
            if (t) { closed = true; yield* toolLine(t, at && t.at ? at - t.at : 0); }
          }
          if (closed || r.toolUseResult) break;

          const text = typeof r.message?.content === 'string'
            ? r.message.content
            : blocks.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n');
          if (text.trim()) { yield* openTurn(); yield `\n### Prompt\n\n${block(text)}`; }
          break;
        }

        case 'system': {
          if (r.subtype === 'turn_duration') { yield* flush(); open = false; }
          else if (r.subtype === 'compact_boundary') yield '\n---\n\n_context compacted_\n';
          break;
        }
      }
    }
    yield* flush();
  } catch (e) {
    if (!FS_ERRORS.has(e?.code)) throw e;
  } finally {
    rl.close();
    stream.destroy();
  }
}
