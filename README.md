# agenttrail

A live map of what your coding agents are doing. Plan and position, watched in real time.

agenttrail watches your **repo**, not your agent. It renders the plan your agent maintains in `PLAN.md` as a live view: what's done, what's in progress right now, and what the agent is touching in the repo this second. Works with Claude Code, Codex, or any agent that can follow a file convention.

> agentmap helps your agent see your code. agenttrail helps you see your agent.

![agenttrail watching a live session: phases and tasks updating as the agent works](docs/demo.gif)

## quick start

```
npx agenttrail init          # scaffolds PLAN.md + appends the convention block to CLAUDE.md
npx agenttrail               # starts the daemon → http://localhost:5330
```

All local. No cloud, no accounts, no hooks required.

## the PLAN.md convention (the spec)

```markdown
# my project

## phase 1 · audio pipeline {#p1}
- [x] capture layer {#p1-capture}
- [~] ring buffer {#p1-ring}

## phase 2 · classification {#p2}
needs: [p1]
- [ ] dedupe window {#p2-dedupe}

## decisions
- 2026-08-21: dropped redis for summaries; in-process queue instead
```

- every phase (`## title {#id}`) and task (`- [ ] title {#id}`) carries a **stable `{#id}`** — never renamed, only added or removed
- `- [~]` marks the task in progress, `- [x]` done
- `needs: [id, id]` under a phase heading declares cross-phase dependencies
- plan-affecting decisions are recorded under `## decisions` **before** implementing them

`agenttrail init` writes the instruction block that tells your agent to maintain this.

## what you see

- phases and tasks with live status; the in-progress task carries a live "editing src/… · 4s ago" line from the fs watcher
- a pan/zoom flow diagram of the phases along their `needs:` edges; click a node to unfold its tasks as capsules with per-task detail
- an inspector panel with phase progress, dependencies, and the latest repository activity

The monitor is read-only — it never modifies PLAN.md or anything else in your repo.

## architecture

Codebase-grounded: fs watcher + PLAN.md are the spine. Agent-specific event streams (Claude Code hooks etc.) are optional adapters that add fidelity — sub-second tool lines, subagent trees — but nothing breaks without them. Single zero-dependency node daemon serves the UI and an SSE model stream; every view is a stateless projection of one derived model.

## roadmap

- scryer teardown + positioning notes
- ARCHITECTURE.md layer: component globs, import-edge drift, deny rules
- Claude Code hooks adapter (live tool line, todo sync)
- menu bar / vscode / tui renderers on the same stream

MIT
