# Live Context (canonical names, workflow themes, LLM summaries, mobile tree) — Mini Plan

> **For implementers:** one-phase plan. Epics are parallel streams: dispatch every
> epic whose dependencies are met, at the same time, one agent per epic, same
> branch. All work lands in a single PR.

**Goal:** a session card answers, on a phone, "what is this session doing right now,
through which workflows/agents, and what happened in the last hours" — with stable
canonical names instead of birth names.
**Scope:** lib/claude.mjs (adapter enrichment), lib/summarize.mjs (new, OpenRouter),
bin/agenttrail.mjs (wiring), public/index.html (mobile-first card tree).

## Streams

| Epic | Delivers | Depends on | Files |
|------|----------|------------|-------|
| 1.1  | adapter emits canonical identity, last prompt, workflow themes/phases, live tool per running agent, summary material | none | `lib/claude.mjs`, `test/claude.test.mjs`, `test/fixtures.mjs` |
| 1.2  | standalone OpenRouter summarizer with cache, cadence, cap, history | none | `lib/summarize.mjs`, `test/summarize.test.mjs` |
| 1.3  | mobile-first card: hero identity, inline tree, mini-log | none | `public/index.html`, `test/ui.test.mjs` |
| 1.4  | wiring (summarizer + new fields into SSE//session) + cross-stream verification and live smoke | 1.1, 1.2, 1.3 | `bin/agenttrail.mjs`, `test/server.test.mjs` |

## Contracts

Frozen. An agent that needs a change here STOPS and reports; it never edits these shapes.

**Session — new/changed fields (SSE envelope and /session/<id>):**
```js
{
  // existing fields unchanged, plus:
  canonical: { repo: "agenttrail", branch: "feat/live-context" } | null, // from cwd basename + gitBranch
  lastPrompt: { text: "...", at: 1756600000000 } | null,   // last-prompt record, text capped at 280 chars
  summary:    { text: "...", at: 1756600000000 } | null,   // LLM, absent when summarizer off
  workflows: [{
    id: "wf_b77c8066-311",
    name: "wave1-session-pivot" | null,        // from the saved script's meta
    description: "..." | null,                  // idem, capped at 200 chars
    phase: { current: "Review", done: 3, total: 9 } | null, // null when underivable
    agents: n, done: n, running: n, startedAt,  // existing counters stay
    runningAgents: [{ agentId, description, currentTool: {name, detail, at}|null }] // cap 6
  }],
  // Agent (subagent) gains, for status "running" only:
  //   currentTool: { name, detail, at } | null
}
```

**Adapter — new method (lib/claude.mjs):**
```js
// Summary material for one session. version changes iff new turns landed.
// text = the distilled last window (<= 4000 chars), ready to send to an LLM.
material(sessionId) -> { version: string, text: string } | null
```

**Summarizer (lib/summarize.mjs):**
```js
export function createSummarizer({
  apiKey,                      // required; caller only constructs when key exists
  model,                       // default 'google/gemini-2.5-flash'
  dir,                         // state dir, default ~/.agenttrail
  minIntervalMs = 300000,      // never re-summarize a session more often
  fetchImpl = fetch,           // injection for tests
  onUpdate = () => {},         // fired when a summary refreshes (daemon -> SSE tick)
}) -> {
  get(sessionId, material),    // -> {text, at}|null from cache, NON-BLOCKING:
                               //    triggers async refresh iff material.version
                               //    changed AND minIntervalMs elapsed
  history(sessionId, sinceMs), // -> [{text, at}] oldest-first
  stop(),
}
```

**Ops caps and env:**
- Env: `OPENROUTER_API_KEY` (existing on both machines) enables summaries;
  `AGENTTRAIL_SUMMARY_MODEL` overrides the model; `AGENTTRAIL_NO_SUMMARY=1` disables.
- Endpoint: `POST https://openrouter.ai/api/v1/chat/completions`, 10s AbortSignal timeout.
- Prompt asks: same language as the conversation, at most 25 words, no preamble.
  Code truncates the reply hard at 180 chars. Both caps always.
- On any error: return null, 5-min cooldown per session, never throw, never log the key.
- Persistence: `<dir>/summaries.json` (cache) and `<dir>/summaries-log.jsonl`
  (append-only history, pruned to 7 days on boot).

**Timeline (served by /session/<id> after 1.4):**
```js
timeline: [{ at, kind: "turn"|"pr"|"cost"|"title"|"summary", data }]  // merged, oldest-first, last 24h
```

---

### Epic 1.1: Adapter enrichment

**Goal:** every Session carries canonical identity, last prompt, workflow theme/phase,
and a live tool line per running subagent; `material()` exists for the summarizer.
**Scope:** lib/claude.mjs + its tests/fixtures.
**Dependencies:** none
**Done when:** fixture tests prove each new field; `node --test 'test/*.test.mjs'` green.
**Status:** Complete

#### Task 1.1.1: Canonical identity and last prompt

- [x] Done

**Context:** Session name today comes from sessions/<pid>.json `.name` or the ai-title
record (`lib/claude.mjs:450`), both minted at session birth — useless on multi-day
sessions. The `last-prompt` record type is NOT in the parse allowlist (`lib/claude.mjs:22`).

**Implementation vision:** add `"last-prompt"` to the sniff allowlist and a case that
stores `{text: r.lastPrompt.slice(0, 280), at}` last-write-wins next to the existing
title handling. Derive `canonical` at Session build time: repo = basename(cwd) with
two named exceptions — a cwd inside `.claude/worktrees/<wt>` or `/srv/worktrees/<wt>`
uses `<wt>`; a cwd equal to the user home uses `"home"`. branch = gitBranch as-is
(may be "HEAD"). canonical is null only when cwd is unknown. Keep `name`/`title`
fields untouched (UI decides precedence).

**Files:**
- Modify: `lib/claude.mjs`
- Test: `test/claude.test.mjs`, fixture support in `test/fixtures.mjs`

**Verification:** new tests: last-prompt record surfaces capped text; worktree cwd
maps to worktree name; home cwd maps to "home". Suite green.

**Done when:** both fields present in `sessions()` output for fixture sessions.

#### Task 1.1.2: Workflow theme and phase

- [x] Done

**Context:** workflows are counted but themeless (`lib/claude.mjs:566`). The Workflow
tool saves each script at `<projectDir>/<sessionId>/workflows/scripts/<name>-<wfId>.js`,
and its first statement is `export const meta = {...}` — a pure literal by the tool's
own contract, carrying name, description and phases[].titles.

**Implementation vision:** when scanning `subagents/workflows/wf_*/`, locate the
script by matching `*-<wfId>.js` in the sibling `workflows/scripts/` dir. Extract with
regexes, never eval: `name:\s*'((?:[^'\\]|\\.)*)'` (and the double-quote variant),
same for description (cap 200 chars), and all `title:` strings inside `phases: [...]`
for the phase list. Cache per wfId (script is immutable). Phase derivation: each
workflow agent's meta.json `description` is the agent() label; the journal gives
done/total-so-far. current = the phase title that is a prefix/substring of any running
agent's label when that matches (labels like `review:D-ui` map via the meta.phases
scan order — when no label matches a phase title, current = null, never a guess).
done = count of journal results, total = agents seen so far (journal starteds).
Missing script, unreadable meta, or no phases → name/description/phase = null;
counters keep working. runningAgents = up to 6 running agents' {agentId, description,
currentTool: null} (tool filled by 1.1.3).

**Files:**
- Modify: `lib/claude.mjs`
- Test: `test/claude.test.mjs`, fixture: a fake script file + journal in `test/fixtures.mjs`

**Verification:** fixture workflow with script meta yields name/description/phases;
corrupted script yields nulls without throwing. Suite green.

**Done when:** `workflows[]` matches the Contracts shape on fixtures.

#### Task 1.1.3: Live tool line for running agents

- [x] Done

**Context:** parent-session currentTool already works via unmatched tool_use
(`lib/claude.mjs:526`). Subagent transcripts are separate files; running agents
(`lib/claude.mjs:580` area) show no current activity.

**Implementation vision:** for agents with status running ONLY (cap: 12 per session
per scan), read the LAST 64KB of the agent's jsonl (fs.open + read at
max(0, size-65536), split on newline, drop the first partial line), walk backwards
for the newest assistant tool_use without a later matching tool_result →
`currentTool {name, detail (reuse the existing detail extractor), at: record timestamp}`.
Cache by (agentId, file size) so an unchanged file costs one stat. Torn/huge lines:
the 64KB window may start mid-record — skipping to the first newline handles it; if
no complete record parses, currentTool = null. Populate both `Agent.currentTool` and
`workflows[].runningAgents[].currentTool`.

**Files:**
- Modify: `lib/claude.mjs`
- Test: `test/claude.test.mjs` (fixture agent jsonl with unmatched tool_use; with
  matched pair → null; with >64KB padding before the tail)

**Verification:** suite green; the three fixture cases pass.

**Done when:** running fixture agents expose currentTool per contract.

#### Task 1.1.4: Summary material

- [x] Done

**Context:** the summarizer (epic 1.2) needs a bounded text window per session; the
adapter owns transcript access and already tracks turns via turn_duration.

**Implementation vision:** implement `material(sessionId)` per the frozen contract.
version = `${transcriptBytes}:${turns}` (changes iff the file grew a turn).
text = from in-memory state, no file re-read: the last user prompt (capped 500 chars),
the newest 8 recentTools one-liners, todo statuses, and the last title — labeled
lines, total capped at 4000 chars. Unknown sessionId or opencode-sourced id → null.

**Files:**
- Modify: `lib/claude.mjs`
- Test: `test/claude.test.mjs`

**Verification:** test asserts shape, 4000-char cap, version stability when nothing
changed, and null for unknown id.

**Done when:** material() matches the contract on fixtures.

---

### Epic 1.2: OpenRouter summarizer

**Goal:** a standalone, injectable summarizer module with cache, cadence, hard caps,
history, and silent failure.
**Scope:** new lib/summarize.mjs + tests. No imports from lib/claude.mjs or bin.
**Dependencies:** none
**Done when:** tests prove cadence, caps, cooldown, persistence; suite green.
**Status:** Complete

#### Task 1.2.1: Summarizer core

- [x] Done

**Context:** greenfield module; the frozen Contracts block defines the full surface.

**Implementation vision:** implement createSummarizer exactly per contract. get() is
non-blocking: serve cache, and when material.version differs from the cached version
AND now - lastAttempt >= minIntervalMs, fire an async refresh (single in-flight per
session, coalesce). Refresh: POST chat/completions with system prompt "Summarize what
this coding session is doing right now. Same language as the conversation. At most
25 words. No preamble." + material.text as user message, `max_tokens: 80`,
AbortSignal.timeout(10000). Reply → trim, hard-truncate 180 chars, store
{text, at, version}, append to summaries-log.jsonl, call onUpdate(sessionId).
Any error (non-200, timeout, empty choice): keep old cache, set 5-min cooldown for
that session, never throw, never include the key in any error string. Load cache file
on boot (tolerate missing/corrupt as empty); write-through on refresh (atomic tmp+rename).
history() reads the log lazily once, then serves from memory; prune >7d on boot.

**Files:**
- Create: `lib/summarize.mjs`
- Test: `test/summarize.test.mjs`

**Verification:** with fetchImpl stubs: no call when version unchanged; call when
changed after interval; 200-word reply truncated to 180 chars; failing fetch → null
+ no second call within cooldown; cache survives a re-create from the same dir
(tmpdir). Suite green.

**Done when:** all five stub tests pass; module has zero non-node imports.

---

### Epic 1.3: Mobile-first card tree and mini-log

**Goal:** on a phone, an active session card shows canonical name, live summary, last
prompt, an expandable tree (workflow theme → phase → running agents with tool lines),
and a mini-log of the last hours.
**Scope:** public/index.html (+ its test file).
**Dependencies:** none (codes against the frozen contract; degrade gracefully while
fields are absent).
**Done when:** cards render every contract field with escaping, expand/collapse works
without layout shift, suite green.
**Status:** Complete

#### Task 1.3.1: Hero identity and summary line

- [x] Done

**Context:** cardHtml (`public/index.html:208`) leads with `s.name` (birth name).

**Implementation vision:** name precedence in the card head: `canonical.repo · branch`
(branch omitted when "HEAD"/null) → fallback existing name. Under it, one line:
`summary.text` when present, else `lastPrompt.text` (single line, ellipsis, with the
full text on the expanded card), else the current title. Show summary age subtly
(`t-ago` span). Every interpolation through esc(). No new fetches — all fields arrive
in the SSE Session already.

**Files:**
- Modify: `public/index.html`
- Test: `test/ui.test.mjs`

**Verification:** ui tests: canonical precedence, fallback chain, escaping of a
hostile summary string. Suite green.

**Done when:** fixture sessions render the precedence chain correctly.

#### Task 1.3.2: Inline tree and mini-log on the expanded card

- [x] Done

**Context:** today the detail lives in the desktop-ish sheet (`public/index.html:173`);
on a phone there is no at-a-glance tree.

**Implementation vision:** tapping a card toggles an inline expansion (no sheet on
narrow screens; keep the sheet for >=760px): tree of workflows — line 1 name+phase
(`wave1-session-pivot · Review 3/9`), line 2 description (2-line clamp), then one row
per runningAgent: description + mono tool line, ticking `t-ago`. Lone running agents
and bg sessions listed after workflows. Mini-log below: `timeline` from
`/session/<id>` (fetched on expand, refreshed on SSE tick while expanded), rendered
as `HH:MM kind — text` rows, newest last, capped at 40 rows. Empty states:
"nothing in the last 24h" when the timeline is empty; tree section omitted when
nothing runs. Collapse on second tap; only one card expanded at a time; expansion sets
aria-expanded; 44px touch targets per the existing phone rules.

**Files:**
- Modify: `public/index.html`
- Test: `test/ui.test.mjs`

**Verification:** ui tests: tree renders workflow name/phase/agents from a contract
fixture; timeline rows render and are escaped; expanded state toggles. Suite green.

**Done when:** phone-width DOM carries tree + mini-log for a fixture session.

---

### Epic 1.4: Wiring + integration (runs alone, last)

**Goal:** daemon composes the summarizer, ships the new fields over SSE and
/session/<id> with the merged timeline; whole-repo verification and live smoke.
**Scope:** bin/agenttrail.mjs, test/server.test.mjs; repo-wide checks.
**Dependencies:** 1.1, 1.2, 1.3
**Done when:** live smoke on this machine shows canonical names, a workflow theme,
a running agent tool line, and (key present) a summary; suite green.
**Status:** Complete

#### Task 1.4.1: Wire summarizer and new fields into the daemon

- [x] Done

**Context:** adapter composition at `bin/agenttrail.mjs:378-382`; full model at
`:103`; tick at `:146`.

**Implementation vision:** construct the summarizer only when
`process.env.OPENROUTER_API_KEY` is set and `AGENTTRAIL_NO_SUMMARY` is not — pass
onUpdate = the existing onChange. On each tick, for sessions with status busy or
(idle and lastEventAt < 30 min old) and source claude: call
`summarizer.get(id, adapter.material(id))` and attach the result as `session.summary`
(listView keeps it; nulls omitted). `/session/<id>` gains `timeline`: merge
adapter.digestEvents filtered to the session with summarizer.history(id), map to the
frozen timeline shape, last 24h, oldest-first. No summarizer → summary absent and
timeline = digest events only. server tests: stub adapter + stub summarizer via the
existing injection seam; assert summary attachment respects the status filter and
timeline merges/sorts both sources.

**Files:**
- Modify: `bin/agenttrail.mjs`
- Test: `test/server.test.mjs`

**Verification:** suite green; new server tests pass.

**Done when:** SSE Session carries summary; /session/<id> carries timeline.

#### Task 1.4.2: Cross-stream verification and live smoke

- [x] Done

**Context:** three sibling streams coded against frozen contracts; this is the only
place repo-wide claims are checkable (Stream Rule 4).

**Implementation vision:** (a) `node --test 'test/*.test.mjs'` — everything green;
(b) grep both sides of each contract field name (adapter emit vs UI consume vs daemon
attach) and reconcile drift by fixing the NON-contract side; (c) live smoke on this
machine, bounded with `timeout` on the process itself, on a spare port: /model shows
canonical names for real sessions; at least one real workflow shows name+phase when
one is running (else state that none was running); with OPENROUTER_API_KEY present
expect a summary on a busy session within ~30s of ticks or document the cooldown;
/session/<id> timeline non-empty for an active session; confirm zero writes outside
~/.agenttrail.

**Files:** — (verification only; fixes land in the file's owning epic scope, which is
unblocked by then)

**Verification:** the smoke evidence itself.

**Done when:** smoke evidence reported with real session names and the suite green.
