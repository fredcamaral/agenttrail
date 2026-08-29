#!/usr/bin/env node
// agenttrail — one daemon per machine. Reads coding-agent transcripts and
// serves a live map of every session on this host. No hooks, no PLAN.md.
// The adapters own all fs watching; this file is CLI + HTTP + SSE only.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const PRODUCT = 'agenttrail' // /whoami identity — the daemon probe requires it
const PUBLIC_DIR = path.join(path.dirname(SELF), '..', 'public')
const VERSION = readVersion()
const DEFAULT_PORT = 5330
const TICK_MS = 1000 // SSE ticks are coalesced to at most one per second
const KEEPALIVE_MS = 25000
const HEAVY = ['agents', 'todos', 'recentTools']
const AGENT_CAP = 12 // list views carry a slice of the tree; /session/<id> serves all of it

// A long-running session accumulates thousands of subagents — one real session
// on mordor had 2603, a megabyte of JSON on its own. Cards need the newest
// slice plus honest totals; the full tree is one request away.
function listView(s) {
  const agents = s.agents || []
  const running = agents.reduce((n, a) => n + (a && a.status === 'running' ? 1 : 0), 0)
  const ranked = agents.length > AGENT_CAP
    ? [...agents]
      .sort((a, b) => (b.status === 'running') - (a.status === 'running') || (b.lastEventAt || b.startedAt || 0) - (a.lastEventAt || a.startedAt || 0))
      .slice(0, AGENT_CAP)
    : agents
  return { ...s, agents: ranked, agentCount: agents.length, agentsRunning: running }
}

// ---------- adapter merge ----------
// One daemon, several sources. The composite presents the SAME adapter
// interface, so createServer never learns there is more than one of them.
export function composeAdapters(adapters) {
  const live = adapters.filter(Boolean)
  // Whoever lists the id owns it, and only that adapter is asked about it — an
  // opencode session must answer "no file" for /export rather than fall through
  // to the Claude adapter and match some unrelated transcript. An id NOBODY
  // lists (a session that ended, transcript still on disk) is offered to every
  // adapter, so downloading by uuid keeps working as it does with one source.
  const owners = id => {
    const own = live.filter(a => a.sessions().some(s => s.id === id))
    return own.length ? own : live
  }
  const firstOf = (id, f) => { for (const a of owners(id)) { const v = f(a); if (v) return v } return null }
  return {
    sessions: () => live.flatMap(a => a.sessions()).sort((x, y) => y.lastEventAt - x.lastEventAt),
    digestEvents: since => live.flatMap(a => a.digestEvents(since)).sort((x, y) => x.at - y.at),
    exportPath: id => firstOf(id, a => a.exportPath(id)),
    distill: id => firstOf(id, a => a.distill(id)),
    stop: () => { for (const a of live) { try { a.stop() } catch {} } },
  }
}

function readVersion() {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version }
  catch { return '0.0.0' }
}

const USAGE = `agenttrail ${VERSION} — live map of the coding-agent sessions on this machine

usage:
  agenttrail [--port N] [--no-open]     run the daemon (default)
  agenttrail up [--port N]              start it if it is not already running
  agenttrail autostart [-y]             start at login (launchd / systemd user)
  agenttrail autostart --print          print the unit file, write nothing
  agenttrail autostart --remove         remove the unit file
`

// ---------- CLI ----------
export function parseArgs(argv) {
  const out = { cmd: 'run', port: DEFAULT_PORT, open: !!process.stdout.isTTY, yes: false, print: false, remove: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'up' || a === 'autostart') out.cmd = a
    else if (a === '--port') { out.port = parseInt(argv[++i], 10); if (!Number.isInteger(out.port)) return { error: '--port needs a number' } }
    else if (a === '--no-open') out.open = false
    else if (a === '-y' || a === '--yes') out.yes = true
    else if (a === '--print') out.print = true
    else if (a === '--remove') out.remove = true
    else if (a === '-h' || a === '--help') return { cmd: 'help' }
    else return { error: `unknown argument: ${a}` }
  }
  return out
}

// ---------- HTTP + SSE ----------
// adapter is injected so tests can drive the server with a stub. The daemon
// passes the real Claude Code adapter; wave 2 merges opencode sessions in.
export function createServer({ adapter, host = os.hostname(), version = VERSION } = {}) {
  if (!adapter) throw new Error('createServer needs an adapter')
  const clients = new Set()
  const seen = new Map() // session id -> {sig, lastEventAt, heavySig} — what subscribers already hold
  let tickTimer = null
  let lastTick = 0

  const boundPort = () => { const a = server.address(); return a && typeof a === 'object' ? a.port : null }
  const fullModel = () => ({ host, port: boundPort(), now: Date.now(), sessions: adapter.sessions().map(listView) })

  function sig(s) { return JSON.stringify(s) }
  function heavySig(s) { return JSON.stringify(HEAVY.map(k => s[k])) }
  function trim(s) { const o = { ...s }; for (const k of HEAVY) delete o[k]; return o }

  // A tick carries only the sessions that moved. Heavy fields ride along for a
  // session whose activity or subagent/todo/tool state actually changed.
  function changedSessions(sessions) {
    const out = []
    for (const s of sessions) {
      const prev = seen.get(s.id)
      const now = { sig: sig(s), lastEventAt: s.lastEventAt, heavySig: heavySig(s) }
      if (prev && prev.sig === now.sig) continue
      const heavy = !prev || prev.lastEventAt !== now.lastEventAt || prev.heavySig !== now.heavySig
      out.push(heavy ? listView(s) : trim(s))
      seen.set(s.id, now)
    }
    return out
  }

  function sendAll(obj) {
    const frame = `data: ${JSON.stringify(obj)}\n\n`
    for (const res of clients) { try { res.write(frame) } catch { clients.delete(res) } }
  }

  // `seen` is what every current subscriber holds, so it is only ever reset
  // together with a full model sent to all of them. It always signs the RAW
  // adapter sessions, never the trimmed list view, or every tick looks changed.
  function reseed(sessions) {
    seen.clear()
    for (const s of sessions) seen.set(s.id, { sig: sig(s), lastEventAt: s.lastEventAt, heavySig: heavySig(s) })
  }

  function flush() {
    tickTimer = null
    lastTick = Date.now()
    if (!clients.size) return
    const sessions = adapter.sessions()
    const ids = new Set(sessions.map(s => s.id))
    // a session disappearing cannot be expressed as a merge — resend the world
    for (const id of seen.keys()) if (!ids.has(id)) { reseed(sessions); sendAll(fullModel()); return }
    const changed = changedSessions(sessions)
    if (changed.length) sendAll({ partial: true, now: Date.now(), sessions: changed })
  }

  function notify() {
    if (tickTimer) return
    tickTimer = setTimeout(flush, Math.max(0, TICK_MS - (Date.now() - lastTick)))
  }

  const server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.destroy() } catch {} }) })

  async function handle(req, res) {
    if (!hostAllowed(req.headers.host, host)) return res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden host')

    const u = new URL(req.url, 'http://localhost')
    const p = u.pathname

    if (p === '/') return serveUI(res)
    if (p === '/whoami') return json(res, { name: PRODUCT, host, port: boundPort(), version })
    if (p === '/model') return json(res, fullModel())
    if (p === '/events') return openStream(req, res)
    if (p === '/digest') return json(res, digestResponse(u))
    if (p === '/export') return exportSession(req, res, u)
    if (p.startsWith('/session/')) return sessionDetail(res, safeDecode(p.slice('/session/'.length)))
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  }

  // A new subscriber is a resync point for everyone: seeding `seen` from the
  // model only the newcomer received would swallow a pending delta for the
  // subscribers already connected.
  function openStream(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    clients.add(res)
    req.on('close', () => clients.delete(res))
    const sessions = adapter.sessions()
    reseed(sessions)
    sendAll({ host, port: boundPort(), now: Date.now(), sessions: sessions.map(listView) })
  }

  function digestResponse(u) {
    const raw = Number(u.searchParams.get('since'))
    const since = Number.isFinite(raw) && raw > 0 ? raw : Date.now() - 24 * 3600e3
    return { since, entries: digest(adapter.digestEvents(since), since) }
  }

  function sessionDetail(res, id) {
    const s = adapter.sessions().find(x => x.id === id)
    if (!s) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"unknown session"}')
    return json(res, s)
  }

  async function exportSession(req, res, u) {
    const id = u.searchParams.get('session') || ''
    const format = u.searchParams.get('format') || 'jsonl'
    if (!id) return res.writeHead(400, { 'content-type': 'text/plain' }).end('session required')
    if (format !== 'jsonl' && format !== 'md') return res.writeHead(400, { 'content-type': 'text/plain' }).end('format must be jsonl or md')
    const name = `${String(id).replace(/[^\w.-]/g, '_')}.${format}`
    const disposition = `attachment; filename="${name}"`

    if (format === 'jsonl') {
      const file = adapter.exportPath(id)
      let size = null
      try { size = fs.statSync(file).size } catch { return res.writeHead(404, { 'content-type': 'text/plain' }).end('no transcript for that session') }
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-disposition': disposition, 'content-length': String(size) })
      if (!size) return res.end()
      // Transcripts are append-only and a live session keeps writing during the
      // seconds this takes. Reading to live EOF would send more bytes than the
      // Content-Length we just promised, and the surplus is parsed as the start
      // of the next reply on a keep-alive socket. Pin the read to the snapshot.
      const stream = fs.createReadStream(file, { end: size - 1 })
      stream.on('error', () => res.destroy())
      req.on('close', () => stream.destroy())
      return stream.pipe(res)
    }

    // A cancelled download must not park the write loop forever: once the client
    // is gone no 'drain' is ever emitted, and distill() holds an open fd for as
    // long as its generator stays suspended. Watch for the disconnect from the
    // moment the iterator exists — the very first chunk can already be slow —
    // and always return the iterator so the adapter releases that fd.
    const ac = new AbortController()
    let aborted = false
    res.on('close', () => { aborted = true; ac.abort() })
    const release = async () => { try { await iter?.return?.() } catch {} }

    // Pull the first chunk before committing to a 200 — a session we cannot
    // distill should be a 404, not a download that tears mid-flight.
    const fail = () => { try { res.writeHead(404, { 'content-type': 'text/plain' }).end('cannot distill that session') } catch {} }
    let iter, first
    try {
      const src = adapter.distill(id)
      iter = src?.[Symbol.asyncIterator]?.() ?? src?.[Symbol.iterator]?.()
      if (!iter) return fail()
      first = await iter.next()
      // An empty distill is an unknown session, not a zero-byte download.
      if (first.done) { await release(); return fail() }
    } catch { return fail() }

    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': disposition })
    try {
      for (let step = first; !step.done; step = await iter.next()) {
        if (aborted || res.destroyed) break
        if (!res.write(step.value)) await once(res, 'drain', { signal: ac.signal })
      }
      if (!aborted) res.end()
    } catch { res.destroy() }
    finally { await release() }
  }

  const keepalive = setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n') } catch { clients.delete(res) } } }, KEEPALIVE_MS)
  keepalive.unref()

  // SSE streams never end on their own, so a plain close() would hang waiting
  // for them. Hang up the subscribers first, then close.
  const httpClose = server.close.bind(server)
  server.close = cb => {
    clearInterval(keepalive)
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null }
    for (const res of clients) { try { res.end() } catch {} }
    clients.clear()
    const r = httpClose(cb)
    try { server.closeAllConnections() } catch {}
    return r
  }
  server.notify = notify
  server.model = fullModel
  return server
}

function serveUI(res) {
  const file = path.join(PUBLIC_DIR, 'index.html')
  let html
  try { html = fs.readFileSync(file) } catch { return res.writeHead(500, { 'content-type': 'text/plain' }).end('public/index.html missing') }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
}

function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
}

function safeDecode(s) { try { return decodeURIComponent(s) } catch { return s } }

// Binding 127.0.0.1 keeps other machines out; it does not keep a *browser* out.
// A page you visit can point its own domain at 127.0.0.1 (DNS rebinding) and
// then read /model, /session and /export same-origin — whole transcripts, repo
// code and secrets included. Absence of CORS headers does not help: after the
// rebind the attacker's origin *is* this host. So check the name the client
// asked for, the way dev servers have since CVE-2018-14732. Legitimate names:
// loopback, this machine's own name, and the tailnet name `tailscale serve`
// forwards when the daemon is reached from a phone.
export function hostAllowed(header, self = os.hostname()) {
  if (!header) return false
  // `[::1]:5330` -> `::1`, `localhost:5330` -> `localhost`
  const name = (header.startsWith('[') ? header.slice(1, header.indexOf(']')) : header.replace(/:\d+$/, '')).toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
    || name === String(self).toLowerCase() || name.endsWith('.ts.net')
}

// ---------- digest ----------
// Journal events since `since`, grouped per session, with the deltas that
// answer "what happened while I was away": turns, spend, PRs, retitles.
export function digest(events, since = 0) {
  const groups = new Map()
  for (const e of events || []) {
    if (!e || typeof e.at !== 'number' || e.at < since || !e.sessionId) continue
    let g = groups.get(e.sessionId)
    if (!g) groups.set(e.sessionId, g = {
      sessionId: e.sessionId, name: e.name || null, turns: 0, durationMs: 0,
      prs: [], title: null, started: false, ended: false,
      firstAt: e.at, lastAt: e.at, costUSD: null, costDeltaUSD: null, events: 0, _cost0: null,
    })
    g.events++
    if (e.name) g.name = e.name
    if (e.at < g.firstAt) g.firstAt = e.at
    if (e.at > g.lastAt) g.lastAt = e.at
    const d = e.data || {}
    if (e.kind === 'turn') { g.turns++; g.durationMs += Number(d.durationMs) || 0 }
    else if (e.kind === 'pr') { if (!g.prs.some(x => x.url === d.url && x.number === d.number)) g.prs.push({ number: d.number ?? null, url: d.url ?? null, repo: d.repo ?? null }) }
    else if (e.kind === 'cost') { const v = Number(d.totalUSD); if (Number.isFinite(v)) { if (g._cost0 === null) g._cost0 = v; g.costUSD = v } }
    else if (e.kind === 'title') { g.title = d.title ?? null }
    else if (e.kind === 'session-start') g.started = true
    else if (e.kind === 'session-end') g.ended = true
  }
  return [...groups.values()]
    .map(({ _cost0, ...g }) => ({ ...g, costDeltaUSD: g.costUSD !== null && _cost0 !== null ? Number((g.costUSD - _cost0).toFixed(6)) : null }))
    .sort((a, b) => b.lastAt - a.lastAt)
}

// ---------- daemon ----------
// `/whoami` is a path any local dev server may answer. Accepting "it replied
// with JSON that has a host and a version" makes an unrelated service on 5330
// look like a live daemon, and `up` then reports success while agenttrail is
// not running at all. Require the daemon to name itself.
async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/whoami`, { signal: AbortSignal.timeout(500) })
    const j = await r.json()
    return j && j.name === PRODUCT && j.host && typeof j.version === 'string' ? j : null
  } catch { return null }
}

// A stranger squatting the asked-for port makes the daemon fall forward, so a
// live agenttrail may be answering a few ports up. Probing only `port` would
// see the stranger, decide nothing is running, and spawn yet another daemon on
// every invocation. Walk the same range `listen` walks.
export async function findDaemon(port, tries = 20) {
  const hits = await Promise.all(
    Array.from({ length: tries + 1 }, (_, i) => port + i).map(p => probe(p).then(j => j && { ...j, port: j.port || p }))
  )
  return hits.find(Boolean) || null
}

function listen(server, port, tries = 20) {
  return new Promise((resolve, reject) => {
    let left = tries
    const onError = e => {
      if (e.code === 'EADDRINUSE' && left-- > 0) server.listen(++port, '127.0.0.1')
      else reject(e)
    }
    server.on('error', onError)
    server.once('listening', () => { server.off('error', onError); resolve(server.address().port) })
    server.listen(port, '127.0.0.1')
  })
}

async function runDaemon(args) {
  // One daemon per machine. A different process on the asked-for port is a port
  // clash, not a duplicate — we fall forward, so look for ourselves up-range too.
  const live = await findDaemon(args.port)
  if (live) {
    console.log(`agenttrail is already running on this machine · http://localhost:${live.port || args.port}`)
    return
  }
  const { createClaudeAdapter } = await import('../lib/claude.mjs')
  const { createOpencodeAdapter } = await import('../lib/opencode.mjs')
  let notify = () => {}
  const onChange = () => notify()
  const adapter = composeAdapters([createClaudeAdapter({ onChange }), createOpencodeAdapter({ onChange })])
  const server = createServer({ adapter })
  notify = () => server.notify()

  let port
  try { port = await listen(server, args.port) }
  catch (e) { console.error('could not bind a port:', e.message); process.exitCode = 1; try { adapter.stop() } catch {}; return }

  console.log(`agenttrail · ${os.hostname()} · http://localhost:${port}`)
  if (args.open) openBrowser(`http://localhost:${port}`)
  const shutdown = () => {
    try { adapter.stop() } catch {}
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, shutdown)
}

function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  import('node:child_process')
    .then(cp => cp.spawn(opener, [url], { stdio: 'ignore', detached: true }).unref())
    .catch(() => {})
}

// ---------- lifecycle ----------
async function up(args) {
  const live = await findDaemon(args.port)
  if (live) { console.log(`already up · http://localhost:${live.port || args.port}`); return }
  const cp = await import('node:child_process')
  const child = cp.spawn(process.execPath, [SELF, '--port', String(args.port), '--no-open'], { detached: true, stdio: 'ignore' })
  child.unref()
  // It may not land on the port we asked for, so report where it actually bound.
  const deadline = Date.now() + 4000
  let started = null
  while (!started && Date.now() < deadline) {
    started = await findDaemon(args.port)
    if (!started) await new Promise(r => setTimeout(r, 150))
  }
  console.log(started
    ? `started agenttrail · http://localhost:${started.port}`
    : `started agenttrail · could not confirm the port, try http://localhost:${args.port}`)
}

async function askYesNo(q) {
  if (!process.stdin.isTTY) return true
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout })
  const ans = await new Promise(r => rl.question(q, r))
  rl.close()
  return !/^n/i.test(ans.trim())
}

const AUTOSTART_LABEL = 'dev.agenttrail.daemon'

// A checkout under a path with '&' or a space is ordinary; a unit file that
// splits or fails to parse on one is not. Escape for each format's own rules:
// XML entities inside <string>, systemd double-quoting for ExecStart words.
const xmlText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const shWord = s => `"${String(s).replace(/([\\"$`])/g, '\\$1')}"`

export function buildUnit({ platform, execPath, script, port, label = AUTOSTART_LABEL }) {
  const argsv = [script, '--port', String(port), '--no-open']
  if (platform === 'linux') {
    const exec = [execPath, ...argsv].map(shWord).join(' ')
    return `[Unit]\nDescription=agenttrail — coding-agent session map for this machine\n\n[Service]\nExecStart=${exec}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`
  }
  // KeepAlive must match systemd's Restart=on-failure. Bare `<true/>` relaunches
  // on ANY exit, including the clean "already running" exit-0 path — one manual
  // daemon and the login agent respawns it every few seconds, forever.
  const program = [execPath, ...argsv].map(a => `<string>${xmlText(a)}</string>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xmlText(label)}</string>\n  <key>ProgramArguments</key><array>${program}</array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n</dict></plist>\n`
}

async function autostart(args) {
  const linux = process.platform === 'linux'
  if (!linux && process.platform !== 'darwin') {
    console.log('autostart: macOS and Linux only — elsewhere add "agenttrail up" to your startup apps')
    return
  }
  const label = AUTOSTART_LABEL
  const unit = buildUnit({ platform: process.platform, execPath: process.execPath, script: SELF, port: args.port, label })
  const dest = linux
    ? path.join(os.homedir(), '.config', 'systemd', 'user', 'agenttrail.service')
    : path.join(os.homedir(), 'Library', 'LaunchAgents', label + '.plist')

  if (args.print) { console.log(unit); return }
  if (args.remove) {
    try { fs.unlinkSync(dest); console.log(`removed ${dest}`) } catch { console.log('nothing to remove'); return }
    console.log(linux ? 'deactivate now:  systemctl --user disable --now agenttrail' : `deactivate now:  launchctl unload ${dest}`)
    return
  }
  if (fs.existsSync(dest) && !args.yes && !await askYesNo(`${dest} already exists — overwrite? [Y/n] `)) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, unit)
  console.log(`wrote ${dest}`)
  console.log(linux ? 'activate now:  systemctl --user enable --now agenttrail' : `activate now:  launchctl load ${dest}`)
}

// ---------- entry ----------
function isMain() {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF) } catch { return false }
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) { console.error(args.error + '\n\n' + USAGE); process.exit(2) }
  else if (args.cmd === 'help') console.log(USAGE)
  else if (args.cmd === 'up') await up(args)
  else if (args.cmd === 'autostart') await autostart(args)
  else await runDaemon(args)
}
