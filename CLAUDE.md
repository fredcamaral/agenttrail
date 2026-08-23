
<!-- agenttrail -->
## agenttrail plan convention
Maintain PLAN.md as the living plan. It is read by the project OWNER, not by you — write it for them.
- nodes are COMPONENTS of the system being built (`## Plain-language name {#id}`), not phases or sprints
- naming rule: titles are verb-led, plain-language outcomes a non-engineer understands ("Watch the repo", "Draw the live map" — never "fs watcher + activity signal"); put the engineer phrasing on a `tech:` line under the heading
- tasks inside a component: `- [ ] Plain outcome {#id}`, optional indented `tech:` line beneath; mark a task `[~]` BEFORE you start it and save PLAN.md immediately — this drives the live in-progress view; flip it to `[x]` the moment it completes, `[!]` if stuck (clear once unblocked). Never batch plan updates for the end of the session
- when you mark a task `[~]`, add an indented `by: <your name>` line under it (claude, codex, cursor, …) and leave it there when done — it is the record of who did what
- edges under a component heading: `needs: [id, id]` = must come after those components; `links: [id, id]` = interconnected with / talks to
- `{#id}`s are stable — never rename, only add or remove nodes
- record any plan-affecting decision under `## decisions` BEFORE implementing it
