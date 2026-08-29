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

You have six agent sessions open across four repos. Which ones are working,
which are waiting on you, which quietly finished an hour ago, and what did they
do while you were at lunch?

agenttrail is a local, session-centric monitor for AI coding agents. One daemon
per machine reads the transcript files Claude Code (and, next, opencode) already
write, and serves a live map of every session on the host: busy or idle, current
tool, working directory and branch, model, cost, the subagents and workflows it
spawned, a digest of what happened while you were away, and a one-click download
of any session's transcript as raw JSONL or distilled Markdown.

Nothing to install into your repos. No hooks, no `PLAN.md`, no convention file
to keep up to date, no account, no telemetry.

## Quick start

```bash
npx agenttrail
```

The browser opens on `http://localhost:5330` and every agent session on the
machine appears. That is the whole setup.

```bash
npx agenttrail up          # start it if it is not already running
npx agenttrail autostart   # start at login, restart if it dies
```

## Local by construction

The daemon is one dependency-free Node file. The interface is one static HTML
file. There is no database, build step, cloud service, or account.

It binds **127.0.0.1 only** and checks the `Host` header, so a web page cannot
rebind its own domain to your loopback and read your transcripts. To reach it
from your phone, put `tailscale serve` in front of it — its `*.ts.net` name is
allowed — rather than widening the bind. It reads transcripts and process
state and never writes into a repo, never edits agent state, and never sends a
prompt. Its only writes live under `~/.agenttrail/`.

Read the core: [`bin/agenttrail.mjs`](bin/agenttrail.mjs).

## Develop

No install step — there is nothing to install.

```bash
npm test                        # node --test 'test/*.test.mjs'
node bin/agenttrail.mjs         # run the daemon from the checkout
```

## Supported agents

| Agent | Source | Status |
|---|---|---|
| Claude Code | `~/.claude` sessions + transcripts | live |
| opencode | `opencode.db`, opened read-only | next |

## License

MIT
