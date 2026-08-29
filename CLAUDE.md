# agenttrail — dev notes

A local dashboard that answers, live and retroactively: what is every
coding-agent session on this machine doing right now, what subagents and
workflows it spawned, what happened while I was away, and let me download any
session transcript. One daemon per machine. It reads the agents' own transcript
files directly — there are no hooks to install and no convention file to keep
up to date.

## Layout

| Path | What lives there |
|---|---|
| `bin/agenttrail.mjs` | CLI, HTTP, SSE. Watches nothing itself. |
| `lib/claude.mjs` | Claude Code adapter: `~/.claude` sessions, transcripts, subagents |
| `lib/opencode.mjs` | opencode adapter: `opencode.db`, read-only (wave 2) |
| `public/index.html` | The whole UI. One file, no build step. |
| `test/*.test.mjs` | `node:test`, synthetic fixtures only |

The adapter interface and the `Session` shape are specified in
`docs/plans/2026-08-30-session-centric-pivot.md`. Adapters own all fs watching,
tailing, and the event journal; the daemon only serves what they compute.

## Rules

- **Node >= 22, zero npm dependencies.** Stdlib only (`node:sqlite` covers
  opencode). Never add a package, never add a build step.
- **Read-only by construction.** The daemon observes. It never writes into a
  repo, never edits agent state, never sends a prompt. Its only writes live
  under `~/.agenttrail/`.
- **Binds 127.0.0.1, and checks the `Host` header.** A loopback bind stops other
  machines but not other origins: a page in your browser can rebind its own
  domain to 127.0.0.1 and read transcripts same-origin. Every endpoint answers
  403 unless the host is loopback, this machine's name, or a `*.ts.net` tailnet
  name (what `tailscale serve` forwards). Any other front door needs that
  allowlist widened — never a wider bind.
- Transcripts are append-only and huge. Tail with persisted byte offsets, buffer
  to the last newline, and sniff the record type before parsing a big line.
- Tests never touch the real `~/.claude` or `~/.agenttrail`, and never write
  outside a tmpdir fixture.

## Test

```bash
node --test 'test/*.test.mjs'      # everything
node --test test/server.test.mjs   # one file
```

Quote the glob: Node expands it itself, so the command works from any shell.
`node --test test/` does **not** work on Node 24 — it resolves the directory as
a module and reports one failing test named `test`. Never write it that way.
