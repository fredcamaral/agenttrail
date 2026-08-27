# The zoom model

agenttrail's canvas has two layers with different physics. Getting this distinction right is the whole design.

## Space and work

**Space is zoomable. Work is paint.**

- **Space** is the durable containment hierarchy: fleet ⊃ repo ⊃ component ⊃ file. Zoom traverses it, whole→part, and the representation changes at each altitude (semantic zoom, not magnification). Space is stable: positions never reshuffle, geography is trustworthy.
- **Work** — sessions, tasks, tool calls, file activity — is ephemeral, so it is never a zoom destination. Work is rendered as **overlays** painted onto space at the address where it happens: a ring on the component being edited, an agent mark on the card a session occupies, heat on a touched file. Overlays are toggleable and exist at every altitude, drawn with altitude-appropriate detail — the way a maps product draws traffic on roads at every zoom level without ever making traffic a place.

How you "see the work" if it isn't geography: every piece of work has an address in space, and it is drawn at that address. The run cards are the one work-first surface — an index of what's in flight that *points into* space (click a run's location to fly there), not a place of its own.

## Altitudes

| Level | Subject | What renders |
|---|---|---|
| L0 · Fleet | all repos | repo cards: mini status map, live glow, agent marks, current tool |
| L1 · Repo | one repo | the component map: cards, needs/links edges, status circles |
| L1.5 · close | components in view | task capsules auto-unfold as the camera closes in |
| L2 · Component interior | one component | its owned files (`files:` globs) as a constellation with heat *(planned)* |
| L3 · Symbols | classes/functions | **deferred** — needs per-language parsing (breaks the zero-dep promise) and no honest observed signal maps agents to symbols; the work lines already narrate at this grain |

Rules: zoom only ever moves within containment (never switches subject); altitudes are discrete and named, not free scale; zoom centers on the cursor; the grid is bounded — no empty void.

## Overlays

| Overlay | Content | Fleet | Repo |
|---|---|---|---|
| Activity (observed) | file writes, rings, `Revising · file ×n`, heat | glow + hot squares | rings, labels, observed child rows |
| Runs | live sessions: todos, tool line, trails, handoffs | agent marks + tool line | run cards, pink session rows, (planned) trails + handoff pulses |
| Plan (declared) | components, tasks, statuses, provenance | mini status squares | cards, capsules, pills |

Tasks live in the Plan overlay as annotations on components — they are work, not geography, which is why "zoom into a task" doesn't exist.

## What earns a card (the organ test)

Cards are **anatomy, not history**. A new prompt or session never creates a card: its todos render as ephemeral Session-plan rows inside whichever card its file-writes pin to, and durable outcomes graduate as tasks. A card is born only when the system grows a lasting new part — and "lasting" is tested in the present, never predicted: something already depends on it (load-bearing), deleting it would change what the product does, a plausible second task exists for it, and it owns files no card claims (logged under `## decisions`). Time corrects the misjudgments cheaply: merge a card that never earned a second change; promote a task whose work keeps clustering in files its siblings never touch. Housekeeping never enters the plan; cards die only when their subsystem is deleted; the 5–9 governor forces merges before sprawl.

## Why this shape (precedents)

- **Semantic zoom + containment-only**: Pad++/ZUI research; the Prezi failure mode ("Prezilepsy") is zoom across arbitrary spatial relationships.
- **Overlays independent of zoom**: Google Maps' traffic/transit layers.
- **Persistent overview beats zoom-only**: Cockburn/Karlson/Bederson, ACM Computing Surveys 2008 — a corner minimap is planned once L2 lands.
- **Bounded canvas, no free scale**: Muse's infinite-canvas memos.
- **Render only what's visible**: tldraw/Figma culling practice.
- **Scope note from the code-map graveyard**: general "visualize the whole codebase" tools (Sourcetrail, CodeSee) died on use-frequency and scope, while narrow daily-use graphs survived. agenttrail stays scoped to one job — watching agent work — and never becomes a code-relationship explorer.

## Deferred on purpose

- **Symbol altitude (L3)** — until there's an honest source.
- **Data-flow edges between components** — flow isn't observable from the filesystem; inferred arrows would be the first dishonest pixels on the board. If it ever matters, the path is agents declaring flows in the convention.
