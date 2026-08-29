<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/agenttrail-mark-dark.svg">
  <img src="assets/brand/agenttrail-mark-black.svg" alt="agenttrail" width="96">
</picture>

# agenttrail

**Know what every coding agent on this machine is doing, while it is doing it.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-2dd4bf)](package.json)

</div>

## The problem

You have fifteen agent sessions open across a dozen repos. Some are mid-turn.
Some finished an hour ago. Some are waiting on a question you never saw scroll
past. Several spawned subagents of their own, and one of those spawned a
workflow with another twelve underneath it. Then you went to lunch.

You come back to fifteen terminals and no idea which one moved. Tabs cannot
tell you: what actually happened is in the transcript file each agent is
already writing, and nothing reads it.

agenttrail reads it. One daemon for the whole machine, watching the files the
agents write anyway. Nothing to install into your repos: no hooks, no
convention file to keep up to date, no account, no telemetry.

## What you see

A live grid of every session on the host, sorted busy first.

- **Session cards.** Name and title, busy / idle / shell / ended, working
  directory and git branch, model, account, the tool running right now with its
  argument, turns, spend in dollars, todo progress, subagent count with how many
  are still running, and any pull request the session opened.
- **The tree.** Click a card and the subagents come with it: workflows grouped
  and collapsible, each agent with its type, description, model and live status,
  nested agents linked to their parent. Plus the recent tool timeline with
  durations, the todo list, and the PRs.
- **Digest.** "Since I left" defaults to your last visit, or pick a window
  (2h, 8h, 24h, or a custom timestamp). Per session: turns run, time spent,
  dollars added, PRs opened, retitles, whether it started or ended. This is the
  answer to what happened overnight.
- **Transcripts.** Download any session as raw JSONL, or as distilled Markdown:
  a header with title, cwd, model and cost, then per turn the prompt, the
  assistant text, tool calls as one-liners, and subagent spawns as links.
- **Cost.** Per session on the card, as a delta in the digest.

Dark and light themes. One HTML file, no build step, no framework.

## Quick start

Node 22 or newer, and nothing else. There are no dependencies to install.

```bash
npx github:fredcamaral/agenttrail
```

Or from a checkout:

```bash
git clone https://github.com/fredcamaral/agenttrail
cd agenttrail
node bin/agenttrail.mjs
```

Your browser opens on `http://localhost:5330` and every agent session on the
machine is there. That is the whole setup. If 5330 is taken the daemon walks
up until it finds a free port and prints where it landed.

Leave it running:

```bash
node bin/agenttrail.mjs up          # start in the background if not already running
node bin/agenttrail.mjs autostart   # start at login, restart if it dies
```

`autostart` writes a launchd agent on macOS or a systemd user unit on Linux,
and tells you the one command that activates it. `autostart --print` shows the
unit without writing anything; `autostart --remove` takes it back out.

Only one daemon runs per machine. Starting a second one finds the first,
prints its URL, and exits.

## How it reads your machine

Everything comes from files the agents already write. There is no database and
no agent-side integration.

| What | Where | How it is read |
|---|---|---|
| Live sessions | `~/.claude/sessions/<pid>.json` | status, cwd, name, tmux pane; the pid is verified with a signal-0 check, so a dead pid reads as ended |
| Extra accounts | `~/.claude-accounts/*/sessions/` | same, and each card is labelled with the account it came from |
| Transcripts | `~/.claude/projects/<slug>/<session>.jsonl` | tailed from a saved byte offset, never loaded whole |
| Subagents | `.../<session>/subagents/agent-*.meta.json` | type, description, model, parent, spawn depth |
| Workflows | `.../subagents/workflows/wf_*/journal.jsonl` | a start without a result is an agent still running |
| opencode | `~/.local/share/opencode/opencode.db` | SQLite, opened read only, WAL polled for changes |

The browser gets one SSE stream, coalesced to at most one update per second,
and only the sessions that actually moved ride each tick. The HTTP surface is
small enough to read in one sitting: [`bin/agenttrail.mjs`](bin/agenttrail.mjs).

## Trust

- **Read only on everything that belongs to an agent.** agenttrail never writes
  into a repo, never edits agent state, never sends a prompt, never resumes or
  kills a session. `opencode.db` is opened with the read-only flag, not merely
  read politely.
- **Its own writes fit in two files.** `~/.agenttrail/offsets.json` remembers how
  far it has read each transcript so a restart does not replay history, and
  `~/.agenttrail/journal.jsonl` is the event log the digest is computed from,
  pruned to seven days on every boot. Nothing else on disk is touched.
- **No network beyond loopback.** It binds `127.0.0.1`, makes no outbound calls,
  has no account and no telemetry. It also checks the `Host` header on every
  request, because a loopback bind stops other machines but not other origins:
  a page you visit can point its own domain at `127.0.0.1` and read your
  transcripts same-origin. Loopback names, this machine's own name, and
  `*.ts.net` are allowed, so putting `tailscale serve` in front of it works for
  reading the dashboard from your phone. Any other front door means widening
  that allowlist, never widening the bind.

## FAQ

**My transcripts are enormous. Will this eat my RAM?**
A resumed session writes to the same file for weeks, and single lines get close
to a megabyte. agenttrail never holds one whole. It tails from a saved byte
offset, buffers to the last complete newline, and sniffs the record type before
parsing a long line. Markdown export streams as it is generated. Cards carry the
newest twelve subagents plus honest totals, and the full tree is fetched only
when you open a session; one workflow-heavy session here had 2603 of them.

**I run several Claude accounts. Does it see all of them?**
Yes. It reads `~/.claude` plus every `~/.claude-accounts/*/sessions`, and each
card shows which account it belongs to. The projects directory is shared across
accounts, so transcripts are watched once rather than once per account.

**I do not use opencode.**
Then the opencode source switches itself off. No `opencode.db`, or a Node build
without `node:sqlite`, and the daemon simply serves your Claude Code sessions
with nothing missing and no error. The same holds in reverse.

**Do I need to install hooks or add a file to my repo?**
No. That was the old design. Nothing is added to a repo, ever.

## Develop

There is no install step and no build step.

```bash
npm test                        # node --test 'test/*.test.mjs'
node bin/agenttrail.mjs         # run the daemon from the checkout
```

Tests use synthetic fixtures in a tmpdir. They never read the real `~/.claude`.
Conventions and the module layout are in [`CLAUDE.md`](CLAUDE.md).

## Supported agents

| Agent | Source | Status |
|---|---|---|
| Claude Code | `~/.claude` sessions, transcripts, subagents | live |
| opencode | `opencode.db`, opened read only | live |

## License

MIT. See [`LICENSE`](LICENSE).

Forked from [sodiumsun/agenttrail](https://github.com/sodiumsun/agenttrail) by
Kelly Sun. Upstream runs one daemon per repository and learns what agents are
doing from installed hooks and a `PLAN.md` convention; this fork runs one daemon
per machine and reads the agents' own transcript files instead, so there is
nothing to install into a repo.
