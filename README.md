<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/agenttrail-mark-dark.svg">
  <img src="assets/brand/agenttrail-mark-black.svg" alt="agenttrail" width="96">
</picture>

# agenttrail

**A live map of what your coding agents are doing.**

[![npm](https://img.shields.io/npm/v/agenttrail?color=e9a23b&label=npm)](https://www.npmjs.com/package/agenttrail)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-2dd4bf)](package.json)
[![stars](https://img.shields.io/github/stars/sodiumsun/agenttrail?style=social)](https://github.com/sodiumsun/agenttrail)

![agenttrail watching itself being built: a claude session appears with its plan, edits stream live, and the demo task ticks green on camera](docs/demo.gif)

</div>

agenttrail is a local, open-source **live dashboard for AI coding agents** — Claude Code, Codex, Cursor, or anything that edits files. One command gives you a real-time board for any repo: which part of the codebase the agent is in, the task it's working on, the tool call it's running *right now*, and what got done while you were away.

> agentmap helps your agent see your code. **agenttrail helps you see your agent.**

## why

You kick off an agent, it runs for thirty minutes, and your only window into it is terminal scrollback. You can't tell where it is in the plan, whether it's building or stuck, or what it quietly revised while you got coffee. Agent work is invisible by default.

agenttrail makes it visible without driving anything: it **observes** — the filesystem, the plan, the agent's own event stream — and draws. It never sends a prompt, never edits your code, never phones home.

## quick start

```bash
cd your-repo
npx agenttrail --open
```

That's level 1, zero setup: a VS Code-style file tree with live "just touched" accents, a **Working** badge, and — for Claude Code — **run cards** showing each session's task list and current tool call as it happens.

Level 2 is the map. Run `npx agenttrail init` once, then click **Copy backfill prompt** on the board and paste it to your agent. The agent studies the repo (code first, git history second, docs last) and writes `PLAN.md` — a component map with dependencies, evidence-cited history, and honest statuses. You never write the plan by hand; your agent does, and every agent session after that maintains it as it works.

## what you see

- **The map** — 5–9 component cards laid out by real structure: `needs:` edges as arrows, `links:` as dashed ties. Green tick, amber spinner, red `!` per card.
- **Live runs** — each Claude Code session as a card: its todo list, the streaming tool line (`Bash · pnpm test · 41s`), elapsed time, and which component it's inside.
- **The session's own plan** — the agent's TodoWrite scratchpad rendered as pink *Session plan* rows inside the component it's working on; fades out a couple of hours after the session ends.
- **Two layers of truth on every card** — *declared* (the checkbox: done / in progress / blocked) and *observed* (actual file writes: an amber ring with `Revising · daemon.py ×7 · 3s`). Revisiting finished work is never invisible, and a live card always has a child row explaining it.
- **Provenance pills** — open tasks say who claims them: pink **Session plan** (an agent's imminent intent — correct it on sight) vs muted **Roadmap** (planning-doc intent, backloggable).
- **Attribution** — tasks carry the mark of the agent that did them: the Claude spark, the OpenAI blossom, initials for anyone else.
- **Multi-repo** — one daemon per repo; boards discover each other and appear as switcher tabs.

## works with

| Agent | Live activity | Run cards + todos | Maintains the plan |
|---|---|---|---|
| Claude Code | ✅ file watcher | ✅ via hooks (auto-installed, local) | ✅ via `CLAUDE.md` |
| Codex | ✅ file watcher | — | ✅ via `AGENTS.md` |
| Cursor / anything | ✅ file watcher | — | ✅ via `AGENTS.md` |
| You, a human | ✅ file watcher | — | up to you |

## how it works

A single dependency-free Node file (~900 lines — read it: [`bin/agenttrail.mjs`](bin/agenttrail.mjs)). It watches the repo filesystem, parses `PLAN.md` into a model, accepts Claude Code hook events on localhost, and streams one derived model to a static page over SSE. Every pixel is a projection of two sources: the plan file (durable, agent-curated) and observed events (live, decaying). No database, no build step, no cloud.

<details>
<summary><b>The PLAN.md convention (the spec)</b></summary>

```markdown
# my project

## Capture the audio {#capture}
tech: coreaudio tap + ring buffer
files: [src/audio/**]
- [x] Grab the mic feed {#capture-mic}
  by: claude
- [~] Keep the last 30 seconds ready {#capture-ring}
  by: claude

## Decide what matters {#classify}
needs: [capture]
links: [notify]
- [ ] Score events by urgency {#classify-score}
  from: roadmap

## decisions
- 2026-08-21: dropped redis for summaries; in-process queue instead
```

- nodes are **components** of the system (`## Plain-language name {#id}`) — verb-led, concrete titles the owner can verify done; engineer phrasing goes on a `tech:` line
- 5–9 components regardless of repo size; grow tasks, not cards
- `- [~]` in progress · `- [x]` done · `- [!]` stuck — cards roll these up as spinner / tick / red `!`
- `needs: [id]` = ordering (arrows) · `links: [id]` = coupling (dashed)
- `files: [globs]` = the paths a component owns; powers the observed-activity ring
- `by: <agent>` = who did it · `from: agent|roadmap` = who claims an open task
- backfilled `[x]` tasks must cite their implementing file as evidence; decisions are logged under `## decisions` before acting

`agenttrail init` writes this convention into `CLAUDE.md` and `AGENTS.md` so agents maintain it natively.

</details>

## private by construction

The daemon binds to **127.0.0.1 only** — nothing is reachable from outside your machine, nothing leaves it, zero telemetry, no accounts. The optional Claude Code hooks are additive entries in your repo's gitignored `.claude/settings.local.json`, relaying tool events to your local daemon and nowhere else. If you want to verify any of this, it's one file.

## faq

**Does it work on a repo with no plan?** Yes — the live layer (tree, activity, run cards) needs nothing. The map appears when your agent writes `PLAN.md`.

**Huge repo?** Tested on a 78k-file repo: breadth-first tree with per-directory caps, tiny SSE ticks, an honest "tree abridged" note.

**Does it drive my agent?** Never. agenttrail observes and draws. The only thing it ever hands you is a prompt on your clipboard.

**Stale plan?** Tell any agent session: *"re-verify PLAN.md against the code."* The board heals as the file does.

## license

MIT
