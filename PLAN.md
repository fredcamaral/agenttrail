# agenttrail

## Read the plan file {#plan-reader}
tech: PLAN.md parser + derived model
files: [bin/**]
- [x] Read the plan file into a live model {#plan-parse}
  by: claude
  tech: stable {#id}s, needs/links edges, [~] active marker
- [x] Re-read it the moment the agent edits it {#plan-watch}
  tech: fs watcher + 150ms debounce

## Watch the repo {#watcher}
tech: recursive fs watcher
links: [explorer]
files: [bin/**]
- [x] Notice every file the agent touches {#watch-files}
  by: claude
- [x] Ignore editor droppings and junk folders {#watch-filter}
  tech: tmp/swap filter + .git, node_modules excludes

## Draw the live map {#map}
tech: svg flow diagram + task capsules
needs: [plan-reader]
links: [explorer]
files: [public/**]
- [x] Show components and how they connect {#map-graph}
  tech: needs = arrows, links = dashed, deterministic layout
  by: claude
- [x] Unfold a component into its tasks {#map-capsules}
  by: codex
- [x] Name things for the owner, not the agent {#map-naming}
  tech: convention v2 — verb-led titles + tech: sublines

## Show the repo like an editor {#explorer}
tech: vs-code-style file tree
needs: [watcher]
files: [public/**]
- [x] Folder tree with live "just touched" accents {#explorer-tree}
  by: claude

## Watch live runs {#runs}
tech: claude code hooks adapter — PostToolUse/TodoWrite → POST /events
needs: [plan-reader]
links: [map]
files: [bin/**, public/**]
- [~] Receive hook events and track sessions {#runs-endpoint}
  by: claude
  tech: /events endpoint; per-session todos, current tool, recent calls
- [ ] Hook relay command + settings install {#runs-relay}
  tech: agenttrail hook (stdin → POST, fail-silent); init merges .claude/settings.json
- [ ] Run cards on the board with the live tool line {#runs-ui}
- [ ] Pin runs to components so the map glows where work happens {#runs-pin}

## Ship to GitHub and npm {#ship}
needs: [map, explorer]
files: [README.md, docs/**, package.json]
- [x] Public repo and readme {#ship-repo}
- [x] Fresh demo gif of the current look {#ship-gif}
  by: claude
- [ ] Publish to npm {#ship-npm}

## decisions
- 2026-08-21: spine is the codebase (fs watcher + PLAN.md), not agent hooks; hooks become an optional fidelity adapter
- 2026-08-21: serve index.html fresh per request (no startup cache) so UI edits land without daemon restart
- 2026-08-21: filter editor atomic-write tmp files from the activity signal
- 2026-08-21: graph is hand-rolled svg, not react-flow — keeps the daemon zero-dep and the page build-free
- 2026-08-23: K. removed the plan-changes mechanism entirely — agenttrail is a live read-only status monitor
- 2026-08-23: convention v2 — plan nodes are components (needs + links edges), titles are plain verb-led outcomes for the owner with tech: sublines; layout stays deterministic, the authoring agent is the generative part
- 2026-08-23: run foreground, map as stage — hooks adapter is core (the 30-minute question is the product); file spine stays the fallback for hook-less agents
