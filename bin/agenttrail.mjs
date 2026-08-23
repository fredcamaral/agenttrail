#!/usr/bin/env node
// agenttrail v0 — codebase-grounded daemon.
// Spine: fs watcher on the repo + PLAN.md convention. No hooks required
// (hooks become an optional fidelity adapter later).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------- CLI ----------
const argv = process.argv.slice(2)
let cmd = null
let repo = process.cwd()
let port = 5330
let openBrowser = false
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === 'init') cmd = 'init'
  else if (a === '--port') port = parseInt(argv[++i], 10)
  else if (a === '--open') openBrowser = true
  else repo = path.resolve(a)
}
const planPath = path.join(repo, 'PLAN.md')
const atDir = path.join(repo, '.agenttrail')

if (cmd === 'init') { init(); process.exit(0) }

// ---------- PLAN.md parser (convention v2: components, owner-first names) ----------
// `## Plain-language name {#id}` = a component of the system, not a phase.
// `tech:` under a component or task carries the engineer phrasing.
// `needs: [id]` = directed sequencing edge; `links: [id]` = undirected coupling.
const NODE_RE = /^##\s+(.+?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i
const TASK_RE = /^\s*[-*]\s+\[( |x|~|!)\]\s+(.+?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i
const NEEDS_RE = /^needs:\s*\[([^\]]*)\]\s*$/i
const LINKS_RE = /^links:\s*\[([^\]]*)\]\s*$/i
const FILES_RE = /^files:\s*\[([^\]]*)\]\s*$/i
const TECH_RE = /^\s*tech:\s*(.+?)\s*$/i
const BY_RE = /^\s*by:\s*(.+?)\s*$/i
const DECISIONS_RE = /^##\s+decisions\s*$/i
const idList = s => s.split(',').map(x => x.trim()).filter(Boolean)

function parsePlan(text) {
  const nodes = [] // ordered
  const decisions = []
  let title = ''
  let curComponent = null
  let lastNode = null // tech: lines attach to the most recent component or task
  let inDecisions = false
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!title && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, ''); continue }
    if (DECISIONS_RE.test(line)) { inDecisions = true; curComponent = null; lastNode = null; continue }
    let m
    if ((m = line.match(NODE_RE))) {
      inDecisions = false
      curComponent = { id: m[2], title: m[1], level: 'component', parent: null, needs: [], links: [], files: [], tech: '', by: '', status: 'pending' }
      lastNode = curComponent
      nodes.push(curComponent)
      continue
    }
    if (inDecisions) {
      if (/^\s*[-*]\s+/.test(line)) decisions.push(line.replace(/^\s*[-*]\s+/, ''))
      continue
    }
    if ((m = line.match(TASK_RE))) {
      const status = m[1] === 'x' ? 'done' : m[1] === '~' ? 'active' : m[1] === '!' ? 'blocked' : 'pending'
      lastNode = { id: m[3], title: m[2], level: 'task', parent: curComponent ? curComponent.id : null, needs: [], links: [], tech: '', by: '', status }
      nodes.push(lastNode)
      continue
    }
    if ((m = line.match(TECH_RE))) { if (lastNode) lastNode.tech = m[1]; continue }
    if ((m = line.match(BY_RE))) { if (lastNode) lastNode.by = m[1]; continue }
    if ((m = line.match(NEEDS_RE))) { if (curComponent) curComponent.needs = idList(m[1]); continue }
    if ((m = line.match(LINKS_RE))) { if (curComponent) curComponent.links = idList(m[1]); continue }
    if ((m = line.match(FILES_RE))) { if (curComponent) curComponent.files = idList(m[1]); continue }
  }
  // derive component status from its tasks — blocked wins (it demands attention)
  for (const c of nodes.filter(n => n.level === 'component')) {
    const kids = nodes.filter(n => n.parent === c.id)
    if (kids.some(k => k.status === 'blocked')) c.status = 'blocked'
    else if (kids.some(k => k.status === 'active')) c.status = 'active'
    else if (kids.length && kids.every(k => k.status === 'done')) c.status = 'done'
  }
  return { nodes, decisions, title }
}

// ---------- live state ----------
const session = { id: Math.random().toString(36).slice(2, 10), project: path.basename(repo), startedAt: new Date().toISOString() }
let planText = safeRead(planPath)
let parsed = parsePlan(planText)
let activity = null // { file, at } — most recent non-plan repo write
let recentActivity = [] // last N writes, newest first — feeds the live-view drill-down
let planMtime = statMtime(planPath)
const clients = new Set()

// ---------- observed activity per component (files: globs) ----------
// Declared status ([~]/[x]) says what the agent claims; this says what the
// filesystem shows. A component whose files are being written is live no
// matter what its checkbox says — that is how "revising done work" stays visible.
const compTouched = {} // component id -> last matching write ts
const compRecent = {} // component id -> [{file, at}] newest first — feeds capsule work lines
function globToRe(g) {
  if (!/[*?]/.test(g)) return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&') + '(/|$)')
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')
  return new RegExp('^' + esc + '$')
}
let compMatchers = []
function rebuildMatchers() {
  compMatchers = parsed.nodes.filter(n => n.level === 'component' && n.files.length)
    .map(c => ({ id: c.id, res: c.files.map(globToRe) }))
}
function touchComponents(file, at) {
  for (const m of compMatchers) if (m.res.some(re => re.test(file))) {
    compTouched[m.id] = at
    const arr = compRecent[m.id] || (compRecent[m.id] = [])
    if (arr[0] && arr[0].file === file) arr[0] = { file, at }
    else arr.unshift({ file, at })
    if (arr.length > 6) arr.length = 6
  }
}

// ---------- repo tree (vs-code-style explorer, folders first) ----------
const IGNORE = /(^|\/)(\.git|node_modules|\.agenttrail|dist|build|\.next|__pycache__|\.venv|\.build|\.pytest_cache|\.ruff_cache|\.cache|\.DS_Store)(\/|$)/
// editor/tool atomic-write droppings — not real activity targets
const TMP_FILE = /(\.tmp(\.|$)|~$|\.swp$|\.swx$|(^|\/)\.#|(^|\/)#.+#$|\.DS_Store$)/

function buildTree(rootDir, budgetN = 4000, perDir = 250) {
  treeTruncated = false
  const root = []
  const queue = [{ dir: rootDir, rel: '', depth: 0, out: root }]
  let budget = budgetN
  while (queue.length) {
    const { dir, rel, depth, out } = queue.shift()
    if (depth > 8) continue
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    let taken = 0
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name
      if (IGNORE.test(r) || TMP_FILE.test(r)) continue
      if (taken >= perDir || budget <= 0) { treeTruncated = true; break }
      taken++; budget--
      if (e.isDirectory()) {
        const node = { name: e.name, path: r, dir: true, children: [] }
        out.push(node)
        queue.push({ dir: path.join(dir, e.name), rel: r, depth: depth + 1, out: node.children })
      } else if (e.isFile()) out.push({ name: e.name, path: r, dir: false })
    }
    out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
  }
  return root
}
let treeTruncated = false
let tree = buildTree(repo)
let treeDirty = false
let lastTreeSent = Date.now()
rebuildMatchers()

function safeRead(p) { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
function statMtime(p) { try { return fs.statSync(p).mtimeMs } catch { return null } }

function model() {
  if (treeDirty) { tree = buildTree(repo); treeDirty = false }
  return {
    session, plan: parsed.nodes.map(n => n.level === 'component' ? { ...n, touchedAt: compTouched[n.id] || null, recent: compRecent[n.id] || [] } : n), tree,
    planTitle: parsed.title,
    hasPlan: planText.length > 0, treeTruncated,
    activity, recentActivity, planMtime,
    now: Date.now(),
  }
}

function send(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`
  for (const res of clients) res.write(data)
}
function broadcast() { send(model()) }
// activity ticks carry only what moved — the 600KB tree stays home
function broadcastTick() {
  send({ partial: true, activity, recentActivity, touched: { ...compTouched }, compRecent, now: Date.now() })
}

// ---------- watcher ----------
let planDebounce = null
try {
  fs.watch(repo, { recursive: true }, (_ev, filename) => {
    if (!filename) return
    const f = filename.toString()
    if (IGNORE.test(f) || TMP_FILE.test(f)) return
    if (path.resolve(repo, f) === planPath) {
      clearTimeout(planDebounce)
      planDebounce = setTimeout(() => {
        planText = safeRead(planPath)
        parsed = parsePlan(planText)
        rebuildMatchers()
        planMtime = statMtime(planPath)
        broadcast()
      }, 150)
      return
    }
    // plain repo churn → liveness signal
    treeDirty = true
    activity = { file: f, at: Date.now() }
    touchComponents(f, activity.at)
    if (!recentActivity.length || recentActivity[0].file !== f) recentActivity.unshift(activity)
    else recentActivity[0] = activity
    recentActivity = recentActivity.slice(0, 12)
    throttleBroadcast()
  })
} catch (e) {
  console.error('watcher failed:', e.message)
}
let lastActivityPush = 0
function throttleBroadcast() {
  const now = Date.now()
  if (now - lastActivityPush <= 1000) return
  lastActivityPush = now
  if (treeDirty && now - lastTreeSent > 10000) { lastTreeSent = now; broadcast() } // tree refresh, at most every 10s
  else broadcastTick()
}

// ---------- http ----------
const indexPath = path.join(__dirname, '..', 'public', 'index.html')
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(fs.readFileSync(indexPath, 'utf8'))
  } else if (u.pathname === '/model') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(model()))
  } else if (u.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify(model())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
  } else res.writeHead(404).end()
})
server.listen(port, '127.0.0.1', () => {
  console.log(`agenttrail · ${session.project} · http://localhost:${port}`)
  if (!planText) console.log('no PLAN.md found — run `agenttrail init` in the repo to scaffold one')
  if (openBrowser) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    import('node:child_process').then(cp => cp.spawn(opener, [`http://localhost:${port}`], { stdio: 'ignore', detached: true }))
  }
})

// ---------- init ----------
function init() {
  fs.mkdirSync(atDir, { recursive: true })
  if (!fs.existsSync(planPath)) {
    fs.writeFileSync(planPath, `# ${path.basename(repo)}

## Set up the project {#setup}
tech: scaffolding
- [ ] First task {#setup-first}

## decisions
`)
    console.log('wrote PLAN.md skeleton')
  }
  const marker = '<!-- agenttrail -->'
  const snippet = `\n${marker}\n## agenttrail plan convention\nMaintain PLAN.md as the living plan. It is read by the project OWNER, not by you — write it for them.\n- nodes are COMPONENTS of the system being built (\`## Plain-language name {#id}\`), not phases or sprints\n- naming rule: titles are verb-led, plain-language, and CONCRETE — the owner can tell when it is done ("Read alerts out loud", "Watch the repo"). Never engineer-speak ("fs watcher + activity signal") and never vague vibes ("Decide what matters"); put the engineer phrasing on a \`tech:\` line under the heading\n- tasks inside a component: \`- [ ] Plain outcome {#id}\`, optional indented \`tech:\` line beneath; mark a task \`[~]\` BEFORE you start it and save PLAN.md immediately — this drives the live in-progress view; flip it to \`[x]\` the moment it completes, \`[!]\` if stuck (clear once unblocked). Never batch plan updates for the end of the session\n- when you mark a task \`[~]\`, add an indented \`by: <your name>\` line under it (claude, codex, cursor, …) and leave it there when done — it is the record of who did what\n- edges under a component heading: \`needs: [id, id]\` = must come after those components; \`links: [id, id]\` = interconnected with / talks to\n- \`files: [src/audio/**, config.py]\` under a component declares which paths it owns — keep it current; it is how the live view knows which component you are really working in, including when you revisit finished work\n- \`{#id}\`s are stable — never rename, only add or remove nodes\n- record any plan-affecting decision under \`## decisions\` BEFORE implementing it\n`
  // CLAUDE.md is read by Claude Code, AGENTS.md by Codex/Cursor and friends —
  // the convention block goes in both so any agent maintains the same plan.
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(repo, name)
    if (!safeRead(p).includes(marker)) {
      fs.appendFileSync(p, snippet)
      console.log(`appended agenttrail convention block to ${name}`)
    }
  }
  const gi = path.join(repo, '.gitignore')
  const giText = safeRead(gi)
  if (!giText.includes('.agenttrail')) fs.appendFileSync(gi, (giText.endsWith('\n') || !giText ? '' : '\n') + '.agenttrail/\n')
  console.log('done — start the daemon with: agenttrail ' + repo)
  console.log('\nnext: have your agent draw the real map. Paste this to Claude Code or Codex in this repo:\n')
  console.log('  Read the "agenttrail plan convention" section in CLAUDE.md or AGENTS.md. Then study this repo — README, roadmap/design docs, and the directory layout — and rewrite PLAN.md as the real map of this codebase: components with stable {#id}s, needs:/links: edges between them, files: globs for the paths each owns, and verb-led concrete titles with tech: sublines. Statuses must be honest — [x] only for what verifiably exists, [~] only for what you are working on right now, everything else [ ]. Record the backfill under ## decisions.')
}
