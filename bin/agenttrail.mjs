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
const baselinePath = path.join(atDir, 'baseline.json')
const reviewsPath = path.join(atDir, 'reviews.jsonl')

if (cmd === 'init') { init(); process.exit(0) }

// ---------- PLAN.md parser ----------
const PHASE_RE = /^##\s+(.+?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i
const TASK_RE = /^\s*[-*]\s+\[( |x|~)\]\s+(.+?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i
const NEEDS_RE = /^needs:\s*\[([^\]]*)\]\s*$/i
const DECISIONS_RE = /^##\s+decisions\s*$/i

function parsePlan(text) {
  const nodes = [] // ordered
  const decisions = []
  let title = ''
  let curPhase = null
  let inDecisions = false
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (!title && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, ''); continue }
    if (DECISIONS_RE.test(line)) { inDecisions = true; curPhase = null; continue }
    let m
    if ((m = line.match(PHASE_RE))) {
      inDecisions = false
      curPhase = { id: m[2], title: m[1], level: 'phase', parent: null, needs: [], status: 'pending' }
      nodes.push(curPhase)
      continue
    }
    if (inDecisions) {
      if (/^\s*[-*]\s+/.test(line)) decisions.push(line.replace(/^\s*[-*]\s+/, ''))
      continue
    }
    if ((m = line.match(NEEDS_RE))) {
      if (curPhase) curPhase.needs = m[1].split(',').map(s => s.trim()).filter(Boolean)
      continue
    }
    if ((m = line.match(TASK_RE))) {
      const status = m[1] === 'x' ? 'done' : m[1] === '~' ? 'active' : 'pending'
      nodes.push({ id: m[3], title: m[2], level: 'task', parent: curPhase ? curPhase.id : null, needs: [], status })
    }
  }
  // derive phase status from children
  for (const p of nodes.filter(n => n.level === 'phase')) {
    const kids = nodes.filter(n => n.parent === p.id)
    if (kids.some(k => k.status === 'active')) p.status = 'active'
    else if (kids.length && kids.every(k => k.status === 'done')) p.status = 'done'
  }
  return { nodes, decisions, title }
}

// ---------- baseline / drift ----------
// Drift = structure and intent changes ONLY (title, needs, add/remove, decisions).
// Status flips ([ ] -> [x]) are progress, never drift.
function snapshotOf(parsed) {
  const nodes = {}
  for (const n of parsed.nodes) nodes[n.id] = { title: n.title, needs: n.needs, parent: n.parent, level: n.level }
  return { nodes, decisions: [...parsed.decisions] }
}

function loadBaseline(parsed) {
  try { return JSON.parse(fs.readFileSync(baselinePath, 'utf8')) } catch {
    const snap = snapshotOf(parsed)
    saveBaseline(snap)
    return snap
  }
}
function saveBaseline(snap) {
  fs.mkdirSync(atDir, { recursive: true })
  fs.writeFileSync(baselinePath, JSON.stringify(snap, null, 2))
}

function repr(n) {
  return `${n.title}${n.needs && n.needs.length ? `  needs: [${n.needs.join(', ')}]` : ''}`
}

function computeDrift(parsed, base) {
  const diffs = {} // id -> DiffEntry
  const removed = [] // nodes gone from plan
  for (const n of parsed.nodes) {
    const b = base.nodes[n.id]
    if (!b) diffs[n.id] = { kind: 'added', removed: [], added: [repr(n)] }
    else if (b.title !== n.title || JSON.stringify(b.needs) !== JSON.stringify(n.needs)) {
      diffs[n.id] = { kind: 'changed', removed: [repr(b)], added: [repr(n)] }
    }
  }
  for (const [id, b] of Object.entries(base.nodes)) {
    if (!parsed.nodes.some(n => n.id === id)) removed.push({ id, title: b.title, level: b.level, parent: b.parent })
  }
  const newDecisions = parsed.decisions.filter(d => !base.decisions.includes(d))
  return { diffs, removed, newDecisions }
}

// ---------- live state ----------
const session = { id: Math.random().toString(36).slice(2, 10), project: path.basename(repo), startedAt: new Date().toISOString() }
let planText = safeRead(planPath)
let parsed = parsePlan(planText)
const baseline = loadBaseline(parsed) // last-reviewed plan state, persisted in .agenttrail/baseline.json
let activity = null // { file, at } — most recent non-plan repo write
let recentActivity = [] // last N writes, newest first — feeds the live-view drill-down
let planMtime = statMtime(planPath)
const driftSeen = new Map() // drift key -> first-seen ts, so the feed can say "N min ago"
const clients = new Set()

function safeRead(p) { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
function statMtime(p) { try { return fs.statSync(p).mtimeMs } catch { return null } }

function model() {
  const { diffs, removed, newDecisions } = computeDrift(parsed, baseline)
  const keys = new Set([
    ...Object.keys(diffs),
    ...removed.map(r => 'rm:' + r.id),
    ...newDecisions.map(d => 'dec:' + d),
  ])
  for (const k of keys) if (!driftSeen.has(k)) driftSeen.set(k, Date.now())
  for (const k of [...driftSeen.keys()]) if (!keys.has(k)) driftSeen.delete(k)
  const driftAt = driftSeen.size ? Math.max(...driftSeen.values()) : null
  const plan = parsed.nodes.map(n => ({ ...n, diff: diffs[n.id] || null }))
  return {
    session, plan, removed, newDecisions, driftAt,
    planTitle: parsed.title,
    hasPlan: planText.length > 0,
    activity, recentActivity, planMtime,
    now: Date.now(),
  }
}

function broadcast() {
  const data = `data: ${JSON.stringify(model())}\n\n`
  for (const res of clients) res.write(data)
}

// ---------- watcher ----------
const IGNORE = /(^|\/)(\.git|node_modules|\.agenttrail|dist|build|\.next|__pycache__|\.venv)(\/|$)/
// editor/tool atomic-write droppings — not real activity targets
const TMP_FILE = /(\.tmp(\.|$)|~$|\.swp$|\.swx$|(^|\/)\.#|(^|\/)#.+#$|\.DS_Store$)/
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
        planMtime = statMtime(planPath)
        broadcast()
      }, 150)
      return
    }
    // plain repo churn → liveness signal
    activity = { file: f, at: Date.now() }
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
  if (now - lastActivityPush > 1000) { lastActivityPush = now; broadcast() }
}

// ---------- accept / reviews ----------
// Accepting a change moves the baseline forward for that node (or the
// decisions list) and logs the review — this is what clears amber everywhere.
function accept(body) {
  const { kind, id } = body
  if (kind === 'node' && id) {
    const n = parsed.nodes.find(x => x.id === id)
    if (n) baseline.nodes[id] = { title: n.title, needs: n.needs, parent: n.parent, level: n.level }
  } else if (kind === 'removed' && id) {
    delete baseline.nodes[id]
  } else if (kind === 'decisions') {
    baseline.decisions = [...parsed.decisions]
  } else return false
  saveBaseline(baseline)
  fs.appendFileSync(reviewsPath, JSON.stringify({ ...body, at: new Date().toISOString() }) + '\n')
  broadcast()
  return true
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
  } else if (u.pathname === '/accept' && req.method === 'POST') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      let ok = false
      try { ok = accept(JSON.parse(body)) } catch {}
      res.writeHead(ok ? 200 : 400).end()
    })
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

## phase 1 · setup {#p1}
- [ ] first task {#p1-first}

## decisions
`)
    console.log('wrote PLAN.md skeleton')
  }
  const claudeMd = path.join(repo, 'CLAUDE.md')
  const marker = '<!-- agenttrail -->'
  const snippet = `\n${marker}\n## agenttrail plan convention\nMaintain PLAN.md as the living plan:\n- every phase (\`## title {#id}\`) and task (\`- [ ] title {#id}\`) carries a stable \`{#id}\` — never rename ids, only add or remove nodes\n- mark the task you are currently working on \`[~]\`, completed tasks \`[x]\`\n- declare cross-phase dependencies with a \`needs: [id, id]\` line under the phase heading\n- record any plan-affecting decision under \`## decisions\` BEFORE implementing it\n`
  const existing = safeRead(claudeMd)
  if (!existing.includes(marker)) {
    fs.appendFileSync(claudeMd, snippet)
    console.log('appended agenttrail convention block to CLAUDE.md')
  }
  const gi = path.join(repo, '.gitignore')
  const giText = safeRead(gi)
  if (!giText.includes('.agenttrail')) fs.appendFileSync(gi, (giText.endsWith('\n') || !giText ? '' : '\n') + '.agenttrail/\n')
  console.log('done — start the daemon with: agenttrail ' + repo)
}
