# Session-centric pivot — plan

Fork of sodiumsun/agenttrail → fredcamaral/agenttrail.
Pivot: from repo-centric (one daemon per repo, PLAN.md + hooks) to
**session-centric** (one daemon per machine, transcript files as the source).

## Product

A local dashboard that answers, live and retroactively:
- what is every coding-agent session on this machine doing right now
  (busy/idle, current tool, cwd/branch, model, cost)
- what subagents/workflows each session spawned, and their status
- what happened while I was away (digest since a timestamp)
- let me download any session transcript (raw JSONL or distilled Markdown)

Sources: Claude Code (`~/.claude`) now; opencode (`opencode.db`, SQLite) in wave 2.
No database. Daemon state = the transcripts themselves + a small JSON/JSONL
cache under `~/.agenttrail/`. Zero npm dependencies. Node >= 22 (node:sqlite).
Binds 127.0.0.1 (tailnet exposure via tailscale serve, not by binding).

## Module layout

```
bin/agenttrail.mjs    CLI + HTTP + SSE + state cache + journal   (lane B)
lib/claude.mjs        Claude Code adapter                        (lane A)
lib/opencode.mjs      opencode adapter                           (wave 2)
public/index.html     UI, single file, no build                  (lane C)
test/*.test.mjs       node:test, synthetic fixtures              (per lane)
```

Delete in wave 1: PLAN.md convention (init/hook/backfill/nudge code paths),
repo-root PLAN.md, the convention blocks in repo CLAUDE.md/AGENTS.md,
`/spawn`, `/suggest`, `/setup*`, sibling-port discovery, hooks installer.
Keep: `up`/`autostart` (single daemon), theming, SSE pattern, run-card UI
language, camera/zoom code (parked until wave 2 if lane C prefers).

## THE CONTRACT (lanes code against this; changes go through the orchestrator)

### Adapter interface (lib/claude.mjs exports)

```js
// Start watching. Emits via callbacks; owns all fs watching/tailing.
// opts: { claudeDir?: string, accountsDir?: string, onChange: () => void }
// Returns { sessions(), digestEvents(sinceMs), exportPath(sessionId),
//           distill(sessionId) -> async iterable of markdown chunks, stop() }
export function createClaudeAdapter(opts)
```

`sessions()` returns `Session[]` (below), recomputed cheaply from in-memory
state; `onChange` fires (debounced <= 500ms) whenever state moved.
`exportPath(id)` returns the absolute transcript path for raw download.
`digestEvents(sinceMs)` returns `DigestEvent[]`. The journal is OWNED by the
adapter: it appends events to `~/.agenttrail/journal.jsonl` as it observes
them and reads them back for digests. The daemon only serves.

### Session (the unit of the whole product)

```js
{
  id: "<session-uuid>",            // == transcript filename stem
  source: "claude",                // "opencode" in wave 2
  name: "br-sfn-32",               // sessions/<pid>.json .name, else title
  title: "...",                    // last ai-title/custom-title record wins
  status: "busy"|"idle"|"shell"|"ended", // ended = pid dead or no pid
  kind: "interactive"|"bg",
  pid: 2000501|null,
  account: "005-x"|null,           // which ~/.claude-accounts dir, null = main
  cwd, gitBranch, model, version,  // last-seen values from records
  tmux: "sess:@win.%pane"|null,
  startedAt, lastEventAt,          // epoch ms
  transcriptPath, transcriptBytes,
  cost: { totalUSD, linesAdded, linesRemoved }|null,   // cost-state record
  currentTool: {name, detail, at}|null,
  recentTools: [{name, detail, at, ms}],               // cap 8
  todos: [{content, status}],                          // TodoWrite, cap 20
  turns: n,                        // count of system/turn_duration
  agents: [Agent],                 // subagent tree, flat with parent links
  workflows: [{id, agents, done, running, startedAt}],
  prs: [{number, url, repo}],      // pr-link records
}
```

### Agent (subagent)

```js
{
  agentId: "<17hex>", parentAgentId: null|"<17hex>",
  type: "Explore"|"general-purpose"|"workflow-subagent"|...,  // meta.json
  description, model,              // meta.json (model may be null)
  workflowId: null|"wf_...",
  status: "running"|"done",        // journal result / parent tool_result /
                                   // jsonl mtime idle > 10 min => done
  startedAt, lastEventAt, transcriptPath,
}
```

### DigestEvent (daemon journal, `~/.agenttrail/journal.jsonl`, append-only)

One line per observed event, pruned to 7 days on boot:
```js
{at, sessionId, name, kind: "turn"|"pr"|"cost"|"title"|"session-start"|"session-end",
 data: {...}}   // turn: {durationMs, messageCount}; pr: {number,url,repo};
                // cost: {totalUSD}; title: {title}
```
Digest = group journal by session since `sinceMs`, plus per-session deltas
(turns, cost delta, PRs, last title). Gaps while daemon was down are
acceptable; autostart closes them in practice.

### HTTP endpoints (bin/agenttrail.mjs)

```
GET /                 UI
GET /events           SSE: full model on connect, coalesced ticks (<= 1/s)
GET /model            full model JSON
GET /whoami           {host, port, version}
GET /digest?since=ms  {since, entries: [...]}   (entries per session)
GET /export?session=<id>&format=jsonl|md
                      jsonl: stream the raw file, Content-Disposition attach
                      md: stream distill() output
GET /session/<id>     one Session with full agents[] (list views may trim)
```

### SSE model envelope

```js
{host, port, now, sessions: [Session]}          // full
{partial: true, now, sessions: [Session]}       // tick: only changed sessions
```
UI merges by `session.id`. Heavy fields (`agents`, `todos`, `recentTools`)
ride the tick only for sessions whose lastEventAt changed.

## Source-of-truth notes (from the mordor investigation, 2026-08-29)

Liveness — authoritative, no mtime guessing:
- `~/.claude/sessions/<pid>.json` + `~/.claude-accounts/*/sessions/<pid>.json`
  → {pid, sessionId, cwd, name, status: busy|idle|shell, kind, tmux, startedAt}.
  Verify pid with `process.kill(pid, 0)`. Dead pid + file present = ended.
  `status` lags; combine with transcript mtime for "busy".
- projects dir is SHARED across accounts (symlinks) — watch once.

Transcripts — `~/.claude/projects/<slug>/<session-uuid>.jsonl`:
- NEVER decode cwd from slug (lossy). Map sessionId→path by scanning project
  dirs' entries (73 dirs; cache the index, refresh on miss).
- Append-only; `--resume` reuses the SAME file for weeks. Session start =
  sessions/<pid>.json startedAt, not file birth.
- Lines up to ~880KB; appends NOT atomic. Tail with persisted byte offsets
  (`~/.agenttrail/offsets.json`), buffer to last `\n`, then parse.
- Parse ONLY: assistant tool_use blocks (currentTool: name + detail),
  user.toolUseResult (agent spawns: agentId/status/description),
  system.turn_duration (turn boundary; pendingBackgroundAgentCount),
  system.compact_boundary (graft point, not session end),
  ai-title / custom-title / agent-name (last-write-wins),
  cost-state, pr-link, TodoWrite tool_use input.todos.
  Skip everything else without JSON.parse when cheap (prefix sniff on
  `"type":"x"` before parsing big lines).
- assistant records: one per content block, same message.id — never count
  records as messages. Count turns via turn_duration.

Subagents — `<projects>/<slug>/<session-uuid>/subagents/`:
- `agent-<17hex>.jsonl` + `agent-<17hex>.meta.json`
  (agentType, description, model, spawnDepth, parentAgentId?, toolUseId).
- Nested agents stored FLAT in the root session's dir; tree via parentAgentId.
- Workflows: `subagents/workflows/wf_*/` with agent files + journal.jsonl
  ({type:"started"|"result", agentId}). started w/o result = running.

opencode (wave 2) — `~/.local/share/opencode/opencode.db`, SQLite WAL:
- open READ-ONLY (`node:sqlite`, `file:...?mode=ro`); never read-write.
- v2 tables: session (parent_id = subagent link, cost/tokens columns),
  session_message (type, seq, data JSON), part-equivalents inside data.
  Probe `session_message`, fall back to legacy `message`+`part`.
- Change detection: opencode.db-wal mtime. Liveness: pgrep + time_updated.
- Zero rows on mordor today — build against a synthetic fixture DB.

## Waves

### Wave 1 — motor (lanes A, B, C in parallel; disjoint files)
- A: lib/claude.mjs per contract + test/claude.test.mjs with a synthetic
  ~/.claude fixture tree (fixture builder in test/fixtures.mjs).
- B: bin/agenttrail.mjs rewrite per contract + raw jsonl /export +
  test/server.test.mjs (adapter stubbed via injection; journal is lane A's).
- C: public/index.html prune (dead CSS, PLAN.md scaffolding, port-keyed
  world) + session-card grid over SSE: name, status dot, cwd/branch, model,
  current tool line, elapsed, cost. Minimal but real. Keep theming tokens
  and run-card visual language; camera/zoom may be parked, not deleted.
- Also in wave 1 (lane B): delete init/hook/spawn/suggest paths; rewrite
  repo CLAUDE.md (dev notes) and drop root PLAN.md; README stub note.
Exit: daemon on mordor shows real live sessions with tool lines; tests pass.

### Wave 2 — features (lanes D, E, F in parallel; disjoint files)
Status: wave 1 DONE (commit 3f74727) — adapter, daemon, session-card UI,
86 tests, smoke against 11 real sessions. Journal + /digest + /session/<id>
already exist from wave 1; wave 2 builds on them.

Decision: NO spatial zoom map. Cards + drill-in answer the session question
better than a canvas; wave 3 may add flourish. Camera code lives in git
history if ever wanted.

- D (public/index.html only): session detail drill-in (click card → panel
  via /session/<id>): subagent/workflow tree with live status, recent tools
  timeline, todos, PRs. Digest panel: "since I left" default from a
  localStorage last-seen timestamp, custom since picker, per-session deltas
  from /digest. Refresh detail panel from SSE ticks.
- E (lib/distill.mjs + test/distill.test.mjs + a <=3-line delegate edit in
  lib/claude.mjs): Markdown distill of a transcript — session header (title,
  cwd, model, cost), then per turn: user prompt, assistant text (thinking
  skipped), tool calls as one-liners (name + detail + ms), subagent spawns
  as links. Async iterable of chunks; bounded memory on 60MB files.
- F (lib/opencode.mjs + test/opencode.test.mjs + adapter-merge edit in
  bin/agenttrail.mjs): createOpencodeAdapter(opts) — same interface;
  node:sqlite READ-ONLY on opencode.db (v2 session/session_message tables,
  legacy message/part fallback), sessions with source:"opencode",
  parent_id → child sessions folded as agents[], liveness = pgrep +
  time_updated + db-wal mtime polling. exportPath() null (no file);
  distill()/digestEvents() minimal or empty v1. Fixture DB built in tests
  via node:sqlite. Daemon composes [claude, opencode] adapters; /export
  404s politely when exportPath is null and UI hides downloads then.
Exit: tree visible with live status, digest answers the overnight question,
md export streams, opencode sessions merge (fixture-proven).

### Wave 3 — beautify + responsividade
Visual polish pass over the whole UI (tokens, spacing, type scale, light/dark
parity), responsive layouts (narrow/mobile: cards stack, tree collapses),
LOD thresholds table-driven, minimap fixed or removed, empty states.
Exit: usable on a phone over tailnet; no dead CSS; consistent both themes.

## Verification

- Unit: `node --test 'test/*.test.mjs'` (quote the glob; `node --test test/`
  fails on Node 24), synthetic fixtures only. NEVER read the real
  ~/.claude in tests; never write outside tmp dirs. No synthetic CPU load.
- Wave 1 end-to-end on mordor against real data, read-only.
- Fable review inside each wave workflow + orchestrator review after.
