
<!-- agenttrail -->
## agenttrail plan convention
Maintain PLAN.md as the living plan. It is read by the project OWNER, not by you — write it for them.
- nodes are COMPONENTS of the system being built (`## Plain-language name {#id}`), not phases or sprints; keep the map at 5-9 components regardless of repo size — grow tasks, not cards, and split a component only when one agent could no longer own it for a session
- naming rule: titles are verb-led, plain-language, and CONCRETE — the owner can tell when it is done ("Read alerts out loud", "Watch the repo"). Never engineer-speak ("fs watcher + activity signal") and never vague vibes ("Decide what matters"); put the engineer phrasing on a `tech:` line under the heading
- tasks inside a component: `- [ ] Plain outcome {#id}`, optional indented `tech:` line beneath; mark a task `[~]` BEFORE you start it and save PLAN.md immediately — this drives the live in-progress view; flip it to `[x]` the moment it completes, `[!]` if stuck (clear once unblocked). Never batch plan updates for the end of the session
- when you mark a task `[~]`, add an indented `by: <your name>` line under it (claude, codex, cursor, …) and leave it there when done — it is the record of who did what
- edges under a component heading: `needs: [id, id]` = must come after those components; `links: [id, id]` = interconnected with / talks to
- `files: [src/audio/**, config.py]` under a component declares which paths it owns — keep it current; it is how the live view knows which component you are really working in, including when you revisit finished work
- `{#id}`s are stable — never rename, only add or remove nodes
- open tasks carry an indented `from:` line naming their provenance — `from: agent` when YOU are declaring it as your own imminent build intent (the owner corrects these on sight if wrong), `from: roadmap` when it comes from planning documents (durable intent, backloggable); omit when neither
- new work NEVER creates a component by default: it lands as your session todos plus tasks under the component whose files it touches. Add a NEW component only when the system grows a durable new part — it will own files no component claims, has an edge, one agent could own it for a session, and the owner would name it when describing the product; record the addition under `## decisions`. Remove a component only when that part is deleted from the product
- before ending a session, graduate your plan-worthy completed todos into PLAN.md as `[x]` tasks (with `by:`) — housekeeping todos stay out of the plan
- record any plan-affecting decision under `## decisions` BEFORE implementing it
