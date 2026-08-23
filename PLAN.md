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
- [x] flow graph view (zero-dep svg) {#v1-graph}
- [x] mockup-fidelity card ui + drill-down {#v1-card-ui}

## decisions
- 2026-08-21: spine is the codebase (fs watcher + PLAN.md), not agent hooks; hooks become an optional fidelity adapter
- 2026-08-21: serve index.html fresh per request (no startup cache) so UI edits land without daemon restart
- 2026-08-21: filter editor atomic-write tmp files from the activity signal
- 2026-08-21: graph is hand-rolled svg, not react-flow — keeps the daemon zero-dep and the page build-free; revisit if graphs outgrow ~50 nodes
- 2026-08-21: flow nodes remain visible while tethered PLAN.md cards open beneath them; multiple cards can coexist
- 2026-08-21: adopted the codex ui redesign wholesale but kept the review loop — the monitor never edits PLAN.md, yet accept/ask-why stay first-class (baseline in .agenttrail/, not the plan file)
- 2026-08-23: K. removed the plan-changes mechanism entirely (drift detection, change history, accept/ask-why, baseline) — agenttrail is a live read-only status monitor; the codex restyles that stripped it were intentional
