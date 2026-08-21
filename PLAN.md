# agenttrail

## v0 · live plan view {#v0}
- [x] PLAN.md parser + derived model {#v0-parser}
- [x] fs watcher + activity signal {#v0-watcher}
- [x] drift detection + accept loop {#v0-drift}
- [x] dark web ui {#v0-ui}

## v0.5 · polish {#v05}
needs: [v0]
- [x] --open flag {#v05-open}
- [x] favicon + tab title status {#v05-favicon}
- [x] readme gif {#v05-gif}

## v1 · flow graph {#v1}
needs: [v05]
- [ ] scryer teardown {#v1-scryer}
- [ ] react-flow live graph {#v1-graph}

## decisions
- 2026-08-21: spine is the codebase (fs watcher + PLAN.md), not agent hooks; hooks become an optional fidelity adapter
- 2026-08-21: serve index.html fresh per request (no startup cache) so UI edits land without daemon restart
- 2026-08-21: filter editor atomic-write tmp files from the activity signal
