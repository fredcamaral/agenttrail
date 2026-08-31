// Daemon tests. The adapter is a stub, so nothing here reads ~/.claude or
// ~/.agenttrail; the one file on disk is a fixture written into a tmpdir.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { buildUnit, createServer, digest, findDaemon, hostAllowed, loadEnvFile, parseArgs } from '../bin/agenttrail.mjs'

test('loadEnvFile fills only absent vars, skips junk, strips quotes, tolerates a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-env-'))
  const f = path.join(dir, 'env')
  fs.writeFileSync(f, '# comment\n\nOPENROUTER_API_KEY="k-from-file"\nALREADY_SET=nope\n=bad\n1BAD=x\nPLAIN=  spaced  \n')
  const env = { ALREADY_SET: 'kept' }
  const n = loadEnvFile(f, env)
  assert.equal(n, 2)
  assert.equal(env.OPENROUTER_API_KEY, 'k-from-file')
  assert.equal(env.ALREADY_SET, 'kept')
  assert.equal(env.PLAIN, 'spaced')
  assert.equal(loadEnvFile(path.join(dir, 'absent'), {}), 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-server-'))
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

const TRANSCRIPT = [
  '{"type":"user","message":{"role":"user","content":"hello"}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  '{"type":"system","subtype":"turn_duration","durationMs":1200}',
].join('\n') + '\n'

function session(over = {}) {
  return {
    id: 'sess-a', source: 'claude', name: 'br-sfn-32', title: 'wiring the rail',
    status: 'busy', kind: 'interactive', pid: 2000501, account: null,
    cwd: '/srv/repos/br-sfn', gitBranch: 'feat/spi', model: 'opus', version: '2.0.1',
    tmux: 'work:@1.%3', startedAt: 1000, lastEventAt: 2000,
    transcriptPath: path.join(tmp, 'sess-a.jsonl'), transcriptBytes: TRANSCRIPT.length,
    cost: { totalUSD: 1.25, linesAdded: 40, linesRemoved: 3 },
    currentTool: { name: 'Edit', detail: 'spi/pacs008.go', at: 2000 },
    recentTools: [{ name: 'Read', detail: 'spi/pacs008.go', at: 1900, ms: 12 }],
    todos: [{ content: 'map pacs.008', status: 'in_progress' }],
    turns: 4, agents: [{ agentId: 'a1b2c3d4e5f6a7b8c', parentAgentId: null, type: 'Explore', description: 'find the mapper', model: 'opus', workflowId: null, status: 'running', startedAt: 1500, lastEventAt: 1900, transcriptPath: '/x' }],
    workflows: [], prs: [{ number: 12, url: 'https://github.com/o/r/pull/12', repo: 'o/r' }],
    ...over,
  }
}

// A stub adapter with the contract's surface and nothing else.
function stubAdapter(over = {}) {
  const state = { sessions: [session(), session({ id: 'sess-b', name: 'matcher-7', status: 'idle', lastEventAt: 2500 })], events: [] }
  return {
    state,
    sessions: () => state.sessions,
    digestEvents: since => state.events.filter(e => e.at >= since),
    exportPath: id => path.join(tmp, `${id}.jsonl`),
    material: id => ({ version: `${id}:1`, text: `material for ${id}` }),
    distill: async function* (id) { yield `# ${id}\n`; yield '\n## turn 1\n'; yield 'hello\n' },
    stop: () => {},
    ...over,
  }
}

// The summarizer seam: `summaries` is read live, so a test can make one land
// mid-run the way a real background refresh does. `asked` records what the
// daemon considered worth an LLM call.
function stubSummarizer(over = {}) {
  const asked = []
  return {
    asked,
    get: (id, material) => { asked.push({ id, material }); return (over.summaries || {})[id] ?? null },
    history: (id, since) => ((over.log || {})[id] || []).filter(e => e.at >= since),
    stop: () => {},
  }
}

async function withServer(adapter, fn, summarizer) {
  const server = createServer({ adapter, summarizer, host: 'testbox', version: '9.9.9' })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try { return await fn({ server, base }) }
  finally { await new Promise(r => server.close(r)) }
}

const get = (base, p) => fetch(base + p)
const getJson = async (base, p) => {
  const r = await get(base, p)
  return { status: r.status, body: await r.json(), headers: r.headers }
}

async function waitFor(pred, ms = 4000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('timed out waiting for condition')
}

// Reads an SSE stream and pushes each parsed `data:` frame into `frames`.
function subscribe(base) {
  const frames = []
  const req = http.get(base + '/events', res => {
    res.setEncoding('utf8')
    let buf = ''
    res.on('data', chunk => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 2)
        if (raw.startsWith('data: ')) frames.push(JSON.parse(raw.slice(6)))
      }
    })
  })
  req.on('error', () => {})
  return { frames, close: () => req.destroy() }
}

test('parseArgs: default is the daemon, port 5330', () => {
  assert.deepEqual(parseArgs([]).cmd, 'run')
  assert.equal(parseArgs([]).port, 5330)
  assert.equal(parseArgs(['--port', '6100']).port, 6100)
  assert.equal(parseArgs(['--no-open']).open, false)
  assert.equal(parseArgs(['-y']).yes, true)
  assert.equal(parseArgs(['up']).cmd, 'up')
  assert.equal(parseArgs(['autostart', '--print']).cmd, 'autostart')
  assert.equal(parseArgs(['autostart', '--print']).print, true)
  assert.ok(parseArgs(['/some/repo']).error, 'a stray path is no longer a repo argument')
  assert.ok(parseArgs(['init']).error, 'init is gone')
})

test('autostart units survive a checkout path with & and a space', () => {
  const execPath = '/opt/node v22/bin/node'
  const script = '/srv/R&D projects/agenttrail/bin/agenttrail.mjs'

  const plist = buildUnit({ platform: 'darwin', execPath, script, port: 5330 })
  assert.match(plist, /<string>\/srv\/R&amp;D projects\/agenttrail\/bin\/agenttrail\.mjs<\/string>/)
  assert.equal(plist.includes('R&D'), false, 'a raw & would make the plist unparseable')
  const strings = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1])
  const decoded = strings.map(s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
  assert.deepEqual(decoded.slice(1), [execPath, script, '--port', '5330', '--no-open'], 'round-trips')

  const service = buildUnit({ platform: 'linux', execPath, script, port: 5330 })
  const exec = service.match(/^ExecStart=(.*)$/m)[1]
  assert.equal(exec, `"${execPath}" "${script}" "--port" "5330" "--no-open"`, 'each word stays one word')
})

// launchd must match systemd's on-failure semantics. Bare KeepAlive=true
// relaunches on a *clean* exit too, so the "agenttrail is already running"
// exit-0 path would put the login agent in a throttled respawn loop forever.
test('autostart restarts on failure only, on both platforms', () => {
  const args = { execPath: '/usr/bin/node', script: '/srv/agenttrail/bin/agenttrail.mjs', port: 5330 }
  const plist = buildUnit({ platform: 'darwin', ...args })
  assert.match(plist, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/)
  assert.equal(/<key>KeepAlive<\/key><true\/>/.test(plist), false, 'bare KeepAlive respawns after a clean exit')
  assert.match(buildUnit({ platform: 'linux', ...args }), /^Restart=on-failure$/m)
})

// The allowlist is a security boundary, so the classic suffix confusions get
// pinned directly: a name that merely *contains* a loopback address, and one
// that merely *ends* in the tailnet's letters, are both strangers.
test('the host allowlist matches whole names, not substrings', () => {
  for (const h of ['localhost', 'localhost:5330', '127.0.0.1:5330', '[::1]:5330', 'mordor', 'MORDOR:5330', 'mordor.tail1a2b.ts.net'])
    assert.equal(hostAllowed(h, 'mordor'), true, `${h} should reach the daemon`)
  for (const h of ['', undefined, 'evil.com', 'localhost.evil.com', '127.0.0.1.evil.com', 'notts.net', 'ts.net', 'mordor.evil.com', 'evil.com:5330'])
    assert.equal(hostAllowed(h, 'mordor'), false, `${h} must not reach the daemon`)
})

// A stranger squatting the asked-for port makes the daemon fall forward, so a
// live agenttrail may be answering a few ports up. Probing only `port` sees the
// stranger, concludes nothing is running, and spawns another daemon — on every
// single invocation, until the machine is stacked with them.
test('findDaemon walks past a stranger squatting the asked-for port', async () => {
  const listenOn = (server, port) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port) })
  })
  // `/whoami` is not ours alone. The stranger answers it with a perfectly
  // well-formed host+version payload — the probe must reject it on the missing
  // product name, not merely because some other service failed to reply JSON.
  const stranger = http.createServer((req, res) => {
    if (req.url !== '/whoami') return res.writeHead(200, { 'content-type': 'text/plain' }).end('some other dev server')
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ host: 'testbox', port: stranger.address().port, version: '4.5.6' }))
  })
  const daemon = http.createServer((req, res) => {
    if (req.url !== '/whoami') return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'agenttrail', host: 'testbox', port: daemon.address().port, version: '9.9.9' }))
  })
  try {
    const base = await listenOn(stranger, 0)
    let offset = 1
    for (; offset <= 6; offset++) { try { await listenOn(daemon, base + offset); break } catch {} }
    assert.ok(offset <= 6, 'the fixture needs a free port just above the stranger')

    const found = await findDaemon(base, offset)
    assert.ok(found, 'a daemon that fell forward is still this machine daemon')
    assert.equal(found.port, base + offset, 'and the stranger on the asked-for port is not it')
    assert.equal(found.host, 'testbox')
    assert.equal(found.version, '9.9.9', 'the answer came from the daemon, not the squatter')
    assert.equal(await findDaemon(base, 0), null, 'the stranger alone is not a daemon')
  } finally {
    await new Promise(r => stranger.close(r))
    await new Promise(r => daemon.close(r))
  }
})

test('/whoami names the product, host, port and version', async () => {
  await withServer(stubAdapter(), async ({ base, server }) => {
    const { status, body } = await getJson(base, '/whoami')
    assert.equal(status, 200)
    assert.deepEqual(Object.keys(body).sort(), ['host', 'name', 'port', 'version'])
    assert.equal(body.name, 'agenttrail', 'the probe identifies the daemon by this')
    assert.equal(body.host, 'testbox')
    assert.equal(body.version, '9.9.9')
    assert.equal(body.port, server.address().port)
  })
})

test('/model is the full envelope', async () => {
  await withServer(stubAdapter(), async ({ base }) => {
    const { status, body } = await getJson(base, '/model')
    assert.equal(status, 200)
    assert.deepEqual(Object.keys(body).sort(), ['host', 'now', 'port', 'sessions'])
    assert.equal(body.sessions.length, 2)
    assert.equal(body.sessions[0].id, 'sess-a')
    assert.equal(body.sessions[0].agents.length, 1)
  })
})

test('list views trim a big subagent tree but keep honest totals; /session/<id> keeps all of it', async () => {
  const agents = Array.from({ length: 40 }, (_, i) => ({
    agentId: `a${i}`, parentAgentId: null, type: 'general-purpose', description: `task ${i}`,
    model: 'opus', workflowId: null, status: i < 3 ? 'running' : 'done',
    startedAt: 1000 + i, lastEventAt: 1000 + i, transcriptPath: `/x/${i}`,
  }))
  const adapter = stubAdapter()
  adapter.state.sessions = [session({ agents })]
  await withServer(adapter, async ({ base }) => {
    const list = (await getJson(base, '/model')).body.sessions[0]
    assert.equal(list.agents.length, 12, 'the card gets a slice, not 40 agents')
    assert.equal(list.agentCount, 40)
    assert.equal(list.agentsRunning, 3)
    assert.equal(list.agents.filter(a => a.status === 'running').length, 3, 'running agents survive the trim')
    assert.equal(list.agents[3].agentId, 'a39', 'then the most recent')

    const detail = (await getJson(base, '/session/sess-a')).body
    assert.equal(detail.agents.length, 40, 'the detail endpoint serves the whole tree')
  })
})

test('/ serves the UI and unknown routes 404', async () => {
  await withServer(stubAdapter(), async ({ base }) => {
    const ui = await get(base, '/')
    assert.equal(ui.status, 200)
    assert.match(ui.headers.get('content-type'), /text\/html/)
    assert.ok((await ui.text()).length > 0)
    assert.equal((await get(base, '/hook')).status, 404)
    assert.equal((await get(base, '/spawn')).status, 404)
    assert.equal((await get(base, '/tree')).status, 404)
  })
})

// Binding 127.0.0.1 stops other machines, not other *origins*. A page in a
// browser on this machine can rebind its own domain to 127.0.0.1 and then read
// transcripts same-origin, so every endpoint checks the name it was asked for.
test('a forged Host header is refused on every endpoint', async () => {
  await withServer(stubAdapter(), async ({ server }) => {
    const port = server.address().port
    const ask = (p, host) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p, headers: { host } }, res => { res.resume(); resolve(res.statusCode) }).on('error', reject)
    })
    for (const p of ['/', '/whoami', '/model', '/events', '/digest', '/session/sess-a', '/export?session=sess-a&format=jsonl']) {
      assert.equal(await ask(p, 'attacker.example.com'), 403, `${p} answered a rebound origin`)
    }
    for (const h of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'testbox', 'mordor.tail1a2b.ts.net']) {
      assert.equal(await ask('/model', h), 200, `${h} is a name that legitimately reaches this daemon`)
    }
  })
})

test('/session/<id> returns one session with agents, 404 otherwise', async () => {
  await withServer(stubAdapter(), async ({ base }) => {
    const { status, body } = await getJson(base, '/session/sess-a')
    assert.equal(status, 200)
    assert.equal(body.id, 'sess-a')
    assert.equal(body.agents[0].type, 'Explore')
    assert.equal((await get(base, '/session/nope')).status, 404)
  })
})

// A summary is a model call, so the daemon only pays for sessions someone could
// be looking at. The ones it skips must never even be ASKED — a cooldown inside
// the summarizer would hide a daemon that is calling it for every dead session.
test('a summary rides only the sessions worth one: busy, or idle and still warm', async () => {
  const now = Date.now()
  const ids = ['busy-1', 'warm-idle', 'cold-idle', 'gone', 'oc-1']
  const adapter = stubAdapter()
  adapter.state.sessions = [
    session({ id: 'busy-1', status: 'busy' }),
    session({ id: 'warm-idle', status: 'idle', lastEventAt: now - 60e3 }),
    session({ id: 'cold-idle', status: 'idle', lastEventAt: now - 90 * 60e3 }),
    session({ id: 'gone', status: 'ended' }),
    session({ id: 'oc-1', source: 'opencode', status: 'busy' }),
  ]
  const sum = stubSummarizer({ summaries: Object.fromEntries(ids.map(id => [id, { text: `doing ${id}`, at: now }])) })
  await withServer(adapter, async ({ base }) => {
    const by = Object.fromEntries((await getJson(base, '/model')).body.sessions.map(s => [s.id, s]))
    assert.equal(by['busy-1'].summary.text, 'doing busy-1')
    assert.equal(by['warm-idle'].summary.text, 'doing warm-idle')
    assert.equal('summary' in by['cold-idle'], false, 'idle and cold for an hour is not worth a model call')
    assert.equal('summary' in by['gone'], false, 'an ended session is not doing anything right now')
    assert.equal('summary' in by['oc-1'], false, 'only the claude adapter has material to summarize')
    assert.deepEqual(sum.asked.map(a => a.id).sort(), ['busy-1', 'warm-idle'], 'and the skipped ones were never even asked')
    assert.equal(sum.asked[0].material.version, `${sum.asked[0].id}:1`, 'the adapter material is what gets handed over')
  }, sum)
})

test('a summary that lands between ticks is a session that moved', async () => {
  const summaries = {}
  const sum = stubSummarizer({ summaries })
  const adapter = stubAdapter()
  await withServer(adapter, async ({ base, server }) => {
    const sub = subscribe(base)
    try {
      await waitFor(() => sub.frames.length >= 1)
      assert.equal('summary' in sub.frames[0].sessions[0], false, 'nothing cached yet is an absent field, not a null')
      summaries['sess-a'] = { text: 'wiring the SPI rail', at: Date.now() }  // a background refresh landed
      server.notify()
      await waitFor(() => sub.frames.length >= 2)
      assert.equal(sub.frames[1].sessions[0].id, 'sess-a')
      assert.equal(sub.frames[1].sessions[0].summary.text, 'wiring the SPI rail')
    } finally { sub.close() }
  }, sum)
})

const TL_NOW = Date.now()
const tlEvent = (minutesAgo, kind, data, sessionId = 'sess-a') =>
  ({ at: TL_NOW - minutesAgo * 60e3, sessionId, name: 'br-sfn-32', kind, data })
const TL_EVENTS = [
  tlEvent(26 * 60, 'turn', { durationMs: 1 }),          // outside the 24h window
  tlEvent(180, 'turn', { durationMs: 1200 }),
  tlEvent(120, 'cost', { totalUSD: 1.5 }),
  tlEvent(60, 'pr', { number: 12, url: 'https://github.com/o/r/pull/12' }),
  tlEvent(45, 'session-start', {}),                     // not one of the contract's kinds
  tlEvent(30, 'title', { title: 'map pacs.008' }),
  tlEvent(10, 'turn', { durationMs: 900 }, 'sess-b'),   // a different session
]

test('/session/<id> merges journal events and past summaries into one 24h timeline', async () => {
  const adapter = stubAdapter({ digestEvents: since => TL_EVENTS.filter(e => e.at >= since) })
  const sum = stubSummarizer({ log: { 'sess-a': [
    { at: TL_NOW - 25 * 3600e3, text: 'yesterday, out of the window' },
    { at: TL_NOW - 150 * 60e3, text: 'refactoring the mapper' },
    { at: TL_NOW - 20 * 60e3, text: 'running the suite' },
  ] } })
  await withServer(adapter, async ({ base }) => {
    const tl = (await getJson(base, '/session/sess-a')).body.timeline
    assert.deepEqual(tl.map(x => x.kind), ['turn', 'summary', 'cost', 'pr', 'title', 'summary'],
      'both sources interleaved, oldest-first')
    assert.deepEqual(Object.keys(tl[0]).sort(), ['at', 'data', 'kind'], 'the frozen row shape')
    assert.equal(tl.at(-1).data.text, 'running the suite', 'the newest thing sits at the end')
    assert.equal(tl.some(x => x.data && x.data.text === 'yesterday, out of the window'), false)
    assert.equal(tl.some(x => x.kind === 'session-start'), false, 'the contract names what a log row can be')
    assert.equal(tl.some(x => x.data && x.data.durationMs === 900), false, 'another session events stay out')
  }, sum)
})

// An open detail panel refetches on every tick that touches its session. Going
// through the list view to find one session would build a model material window
// for every warm session on the machine, once a second, to answer about one.
test('/session/<id> summarizes the session it was asked for, not the whole fleet', async () => {
  const now = Date.now()
  const adapter = stubAdapter()
  adapter.state.sessions = ['sess-a', 'sess-b', 'sess-c'].map(id => session({ id, status: 'busy', lastEventAt: now }))
  const sum = stubSummarizer({ summaries: { 'sess-b': { text: 'just this one', at: now } } })
  await withServer(adapter, async ({ base }) => {
    const body = (await getJson(base, '/session/sess-b')).body
    assert.equal(body.summary.text, 'just this one', 'the card asked for still gets its line')
    assert.deepEqual(sum.asked.map(a => a.id), ['sess-b'], 'and the other two were never priced')
    assert.equal((await getJson(base, '/session/nope')).status, 404, 'an unknown id is still a 404')
  }, sum)
})

// A summary is cached under the material version it was built at, so one written
// from a half-replayed transcript is both wrong and stuck for the whole cadence.
test('a session still replaying its transcript is not summarized until it catches up', async () => {
  const now = Date.now()
  let replaying = true
  const adapter = stubAdapter({ caughtUp: id => !(replaying && id === 'sess-a') })
  adapter.state.sessions = ['sess-a', 'sess-b'].map(id => session({ id, status: 'busy', lastEventAt: now }))
  const sum = stubSummarizer({ summaries: Object.fromEntries(['sess-a', 'sess-b'].map(id => [id, { text: `doing ${id}`, at: now }])) })
  await withServer(adapter, async ({ base }) => {
    const by = Object.fromEntries((await getJson(base, '/model')).body.sessions.map(s => [s.id, s]))
    assert.equal('summary' in by['sess-a'], false, 'a half-read transcript is not worth summarizing')
    assert.equal(by['sess-b'].summary.text, 'doing sess-b', 'and it holds back only itself')
    assert.deepEqual(sum.asked.map(a => a.id), ['sess-b'], 'the skipped one was never even asked')

    replaying = false                                   // the replay finished between ticks
    const after = Object.fromEntries((await getJson(base, '/model')).body.sessions.map(s => [s.id, s]))
    assert.equal(after['sess-a'].summary.text, 'doing sess-a', 'and it is picked up on the next pass')
  }, sum)
})

test('with no summarizer the timeline is the journal alone and no session carries a summary', async () => {
  const adapter = stubAdapter({ digestEvents: since => TL_EVENTS.filter(e => e.at >= since) })
  await withServer(adapter, async ({ base }) => {
    for (const s of (await getJson(base, '/model')).body.sessions) assert.equal('summary' in s, false)
    const body = (await getJson(base, '/session/sess-a')).body
    assert.equal('summary' in body, false)
    assert.deepEqual(body.timeline.map(x => x.kind), ['turn', 'cost', 'pr', 'title'])
    assert.equal(body.agents.length, 1, 'and the session itself is served exactly as before')
  })
})

test('/export&format=jsonl streams the raw transcript as an attachment', async () => {
  fs.writeFileSync(path.join(tmp, 'sess-a.jsonl'), TRANSCRIPT)
  await withServer(stubAdapter(), async ({ base }) => {
    const r = await get(base, '/export?session=sess-a&format=jsonl')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="sess-a.jsonl"')
    assert.match(r.headers.get('content-type'), /ndjson/)
    assert.equal(r.headers.get('content-length'), String(TRANSCRIPT.length))
    assert.equal(await r.text(), TRANSCRIPT)
  })
})

test('/export&format=md streams distill() chunks', async () => {
  await withServer(stubAdapter(), async ({ base }) => {
    const r = await get(base, '/export?session=sess-a&format=md')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /text\/markdown/)
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="sess-a.md"')
    assert.equal(await r.text(), '# sess-a\n\n## turn 1\nhello\n')
  })
})

test('/export rejects a bad format, a missing session and a missing file', async () => {
  await withServer(stubAdapter(), async ({ base }) => {
    assert.equal((await get(base, '/export?session=sess-a&format=csv')).status, 400)
    assert.equal((await get(base, '/export?format=jsonl')).status, 400)
    assert.equal((await get(base, '/export?session=ghost&format=jsonl')).status, 404)
  })
})

test('/export&format=md 404s when distill refuses, and accepts a sync iterable', async () => {
  const refusing = stubAdapter({ distill: () => { throw new Error('unknown session') } })
  await withServer(refusing, async ({ base }) => {
    const r = await get(base, '/export?session=ghost&format=md')
    assert.equal(r.status, 404)
    assert.match(await r.text(), /cannot distill/)
  })
  const lazy = stubAdapter({ distill: async function* () { throw new Error('gone') } })
  await withServer(lazy, async ({ base }) => {
    assert.equal((await get(base, '/export?session=ghost&format=md')).status, 404)
  })
  const empty = stubAdapter({ distill: async function* () {} })
  await withServer(empty, async ({ base }) => {
    const r = await get(base, '/export?session=ghost&format=md')
    assert.equal(r.status, 404, 'an empty distill is an unknown session, not a 200 with an empty body')
    assert.match(await r.text(), /cannot distill/)
  })
  const sync = stubAdapter({ distill: id => ['# ', id, '\n'] })
  await withServer(sync, async ({ base }) => {
    const r = await get(base, '/export?session=sess-a&format=md')
    assert.equal(r.status, 200)
    assert.equal(await r.text(), '# sess-a\n')
  })
})

// A live session appends to its transcript while we stream it. Sending the
// surplus would overrun the promised Content-Length, and the extra bytes are
// then read as the head of the next reply on the same keep-alive socket —
// which is how exporting a busy session used to break the very next fetch.
test('a transcript growing mid-stream never exceeds Content-Length, and the socket survives', async () => {
  const file = path.join(tmp, 'growing.jsonl')
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(200) } }) + '\n'
  fs.writeFileSync(file, line.repeat(9000))
  const declared = fs.statSync(file).size
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  try {
    await withServer(stubAdapter({ exportPath: () => file }), async ({ server }) => {
      const port = server.address().port
      const req1 = { host: '127.0.0.1', port, agent, path: '/export?session=growing&format=jsonl' }
      let got = 0, grew = false
      const headers = await new Promise((resolve, reject) => {
        const r = http.get(req1, res => {
          res.on('data', c => {
            got += c.length
            if (!grew && got > 50000) { grew = true; fs.appendFileSync(file, line.repeat(9000)) }
          })
          res.on('end', () => resolve(res.headers))
          res.on('error', reject)
        })
        r.on('error', reject)
      })
      assert.equal(headers['content-length'], String(declared))
      assert.ok(grew, 'the fixture really did grow while the response was in flight')
      assert.ok(fs.statSync(file).size > declared, 'and it is bigger than what we promised')
      assert.equal(got, declared, 'the client got exactly the bytes we declared')

      // The proof the framing held: the pooled socket is reusable.
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, agent, path: '/whoami' }, res => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        }).on('error', reject)
      })
      assert.equal(status, 200, 'the next request on the same keep-alive socket still parses')
    })
  } finally { agent.destroy() }
})

// distill() holds an open fd per call. A browser-cancelled download must run
// the generator's finally, or a weeks-running daemon leaks one fd per cancel.
test('a client that disconnects mid-distill releases the adapter iterator', async () => {
  let released = false
  const endless = stubAdapter({
    distill: async function* () {
      try {
        for (let i = 0; i < 500; i++) { yield 'x'.repeat(64 * 1024); await new Promise(r => setTimeout(r, 5)) }
      } finally { released = true }
    },
  })
  await withServer(endless, async ({ server }) => {
    const port = server.address().port
    await new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: '/export?session=sess-a&format=md' }, res => {
        let got = 0
        res.on('data', c => { got += c.length; if (got > 200000) req.destroy() })
        res.on('error', () => {})
      })
      req.on('error', () => resolve())
      req.on('close', () => resolve())
    })
    await waitFor(() => released, 3000)
  })
  assert.ok(released, 'the generator ran its finally, so the adapter closed its fd')
})

// The same leak, one moment earlier: a slow first chunk means the client can
// vanish before any header is written.
test('a client that disconnects before the first chunk still releases the iterator', async () => {
  let released = false
  const slowStart = stubAdapter({
    distill: async function* () {
      try { await new Promise(r => setTimeout(r, 250)); yield '# late\n' }
      finally { released = true }
    },
  })
  await withServer(slowStart, async ({ server }) => {
    const port = server.address().port
    await new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port, path: '/export?session=sess-a&format=md' }, res => res.resume())
      req.on('error', () => resolve())
      setTimeout(() => { req.destroy(); resolve() }, 40)
    })
    await waitFor(() => released, 3000)
  })
  assert.ok(released, 'no header was ever sent, and the fd was still released')
})

// The leak the other two cancel tests cannot see: they keep reading, so the
// write loop is never parked and `res.destroyed` alone ends it. A real browser
// that stops reading (a paused download, a backgrounded tab) parks the daemon
// in `await once(res, 'drain')` — and a socket that is gone never drains. Only
// the disconnect listener unparks it; without one the generator stays suspended
// for the life of the daemon, holding its transcript fd.
test('a client that stops reading and then vanishes unparks the write loop', async () => {
  let released = false, yields = 0
  const firehose = stubAdapter({
    distill: async function* () {
      try { for (let i = 0; i < 400; i++) { yields++; yield 'x'.repeat(1024 * 1024) } }
      finally { released = true }
    },
  })
  await withServer(firehose, async ({ server }) => {
    const sock = net.connect(server.address().port, '127.0.0.1')
    try {
      await once(sock, 'connect')
      sock.write('GET /export?session=sess-a&format=md HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
      await once(sock, 'data')
      sock.pause() // stop draining: the server fills the socket and parks on 'drain'
      // Wait for the write loop to actually stall, not for a deadline: "stopped
      // making progress" is the real precondition, and a loaded box then only
      // makes the wait longer, never makes the test wrong.
      let prev = -1
      await waitFor(() => { const stalled = yields > 0 && yields === prev; prev = yields; return stalled }, 5000)
      assert.equal(released, false, 'the generator should be parked mid-stream, still holding its fd')

      sock.destroy()
      await waitFor(() => released, 3000)
    } finally { sock.destroy() }
  })
  assert.ok(released, 'the disconnect ran the generator finally, so the adapter closed its fd')
})

// Same cancel, the raw-download path. Cancelling mid-file parks the pipe: the
// socket is gone, so nothing ever drains it again and the read stream sits at
// its last offset with the transcript fd open for the life of the daemon.
// Only an explicit destroy on disconnect releases it — unpiping does not.
// The fixture must be far bigger than what Node buffers before parking
// (measured: it swallows 4-8MB), or the read finishes and self-closes and the
// test proves nothing; `bytesRead < size` is what keeps that honest.
test('a cancelled jsonl download destroys the file stream', async () => {
  const file = path.join(tmp, 'cancelled.jsonl')
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(500) } }) + '\n'
  const fh = fs.openSync(file, 'w')
  for (let i = 0; i < 36; i++) fs.writeSync(fh, line.repeat(1000)) // ~20MB
  fs.closeSync(fh)
  const size = fs.statSync(file).size

  const realCreate = fs.createReadStream
  const opened = []
  fs.createReadStream = (...a) => { const s = realCreate(...a); opened.push(s); return s }
  try {
    await withServer(stubAdapter({ exportPath: () => file }), async ({ server }) => {
      const port = server.address().port
      await new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port, path: '/export?session=cancelled&format=jsonl' }, res => {
          res.once('data', () => { res.pause(); setTimeout(() => req.destroy(), 100) })
          res.on('error', () => {})
        })
        req.on('error', () => resolve())
        req.on('close', () => resolve())
      })
      assert.equal(opened.length, 1, 'the export opened exactly one read stream')
      await waitFor(() => opened[0].destroyed, 3000)
      assert.ok(opened[0].bytesRead < size, `the read must still be mid-file (${opened[0].bytesRead}/${size}) or this proves nothing`)
    })
  } finally { fs.createReadStream = realCreate }
})

test('/export filename cannot smuggle a header break', async () => {
  fs.writeFileSync(path.join(tmp, 'x_y.jsonl'), 'x\n')
  await withServer(stubAdapter({ exportPath: () => path.join(tmp, 'x_y.jsonl') }), async ({ base }) => {
    const r = await get(base, '/export?session=' + encodeURIComponent('x"\r\ny') + '&format=jsonl')
    assert.equal(r.status, 200)
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="x___y.jsonl"')
  })
})

test('SSE sends the full model on connect, then a partial tick with only the changed session', async () => {
  const adapter = stubAdapter()
  await withServer(adapter, async ({ base, server }) => {
    const sub = subscribe(base)
    try {
      await waitFor(() => sub.frames.length >= 1)
      const full = sub.frames[0]
      assert.equal(full.partial, undefined)
      assert.equal(full.host, 'testbox')
      assert.equal(full.sessions.length, 2)

      adapter.state.sessions[0].lastEventAt = 3000
      adapter.state.sessions[0].currentTool = { name: 'Bash', detail: 'go test ./...', at: 3000 }
      server.notify()
      await waitFor(() => sub.frames.length >= 2)
      const tick = sub.frames[1]
      assert.equal(tick.partial, true)
      assert.equal(typeof tick.now, 'number')
      assert.equal(tick.sessions.length, 1, 'only the session that moved rides the tick')
      assert.equal(tick.sessions[0].id, 'sess-a')
      assert.equal(tick.sessions[0].currentTool.name, 'Bash')
      assert.ok(Array.isArray(tick.sessions[0].agents), 'heavy fields ride when activity moved')
    } finally { sub.close() }
  })
})

test('a tick that only changes light fields drops the heavy ones', async () => {
  const adapter = stubAdapter()
  await withServer(adapter, async ({ base, server }) => {
    const sub = subscribe(base)
    try {
      await waitFor(() => sub.frames.length >= 1)
      adapter.state.sessions[0].status = 'idle' // lastEventAt and agents/todos/tools untouched
      server.notify()
      await waitFor(() => sub.frames.length >= 2)
      const s = sub.frames[1].sessions[0]
      assert.equal(s.status, 'idle')
      for (const k of ['agents', 'todos', 'recentTools']) assert.equal(k in s, false, `${k} should not ride an idle-status tick`)
    } finally { sub.close() }
  })
})

test('ticks coalesce: a burst of changes produces one frame', async () => {
  const adapter = stubAdapter()
  await withServer(adapter, async ({ base, server }) => {
    const sub = subscribe(base)
    try {
      await waitFor(() => sub.frames.length >= 1)
      adapter.state.sessions[0].lastEventAt = 3000
      server.notify()
      adapter.state.sessions[0].lastEventAt = 3100
      server.notify()
      adapter.state.sessions[1].status = 'ended'
      server.notify()
      await waitFor(() => sub.frames.length >= 2)
      await new Promise(r => setTimeout(r, 300))
      assert.equal(sub.frames.length, 2, 'three changes inside one second collapse into one tick')
      assert.equal(sub.frames[1].sessions.length, 2)
    } finally { sub.close() }
  })
})

test('an unchanged model produces no tick', async () => {
  const adapter = stubAdapter()
  await withServer(adapter, async ({ base, server }) => {
    const sub = subscribe(base)
    try {
      await waitFor(() => sub.frames.length >= 1)
      server.notify()
      await new Promise(r => setTimeout(r, 300))
      assert.equal(sub.frames.length, 1)
    } finally { sub.close() }
  })
})

test('a session disappearing resends the full model', async () => {
  const adapter = stubAdapter()
  await withServer(adapter, async ({ base, server }) => {
    const sub = subscribe(base)
    try {
      await waitFor(() => sub.frames.length >= 1)
      adapter.state.sessions = [adapter.state.sessions[0]]
      server.notify()
      await waitFor(() => sub.frames.length >= 2)
      assert.equal(sub.frames[1].partial, undefined, 'a removal cannot be merged, so the world is resent')
      assert.equal(sub.frames[1].sessions.length, 1)
    } finally { sub.close() }
  })
})

test('a second subscriber resyncs everyone instead of swallowing a pending delta', async () => {
  const adapter = stubAdapter()
  await withServer(adapter, async ({ base, server }) => {
    const a = subscribe(base)
    let b
    try {
      await waitFor(() => a.frames.length >= 1)
      b = subscribe(base)
      await waitFor(() => b.frames.length >= 1)
      await waitFor(() => a.frames.length >= 2, 2000)
      assert.equal(a.frames[1].partial, undefined, 'the already-connected tab gets the full model too')
      assert.equal(a.frames[1].sessions.length, 2)

      adapter.state.sessions[0].lastEventAt = 4000
      server.notify()
      await waitFor(() => a.frames.length >= 3 && b.frames.length >= 2, 3000)
      assert.equal(a.frames[2].sessions[0].lastEventAt, 4000)
      assert.equal(b.frames[1].sessions[0].lastEventAt, 4000)
    } finally { a.close(); if (b) b.close() }
  })
})

test('a malformed session id answers 404 instead of resetting the connection', async () => {
  await withServer(stubAdapter(), async ({ base }) => {
    const r = await get(base, '/session/%ZZ')
    assert.equal(r.status, 404)
  })
})

const EVENTS = [
  { at: 500, sessionId: 'sess-a', name: 'br-sfn-32', kind: 'session-start', data: {} },
  { at: 900, sessionId: 'sess-a', name: 'br-sfn-32', kind: 'cost', data: { totalUSD: 0.5 } },
  { at: 2000, sessionId: 'sess-a', name: 'br-sfn-32', kind: 'cost', data: { totalUSD: 1.0 } },
  { at: 2100, sessionId: 'sess-a', name: 'br-sfn-32', kind: 'turn', data: { durationMs: 1200, messageCount: 3 } },
  { at: 2200, sessionId: 'sess-a', name: 'br-sfn-32', kind: 'turn', data: { durationMs: 800, messageCount: 2 } },
  { at: 2300, sessionId: 'sess-a', name: 'br-sfn-32', kind: 'cost', data: { totalUSD: 1.75 } },
  { at: 2400, sessionId: 'sess-a', name: 'br-sfn-32', kind: 'pr', data: { number: 12, url: 'https://github.com/o/r/pull/12', repo: 'o/r' } },
  { at: 2450, sessionId: 'sess-a', name: 'br-sfn-32', kind: 'pr', data: { number: 12, url: 'https://github.com/o/r/pull/12', repo: 'o/r' } },
  { at: 2500, sessionId: 'sess-a', name: 'br-sfn-32', kind: 'title', data: { title: 'map pacs.008' } },
  { at: 2600, sessionId: 'sess-b', name: 'matcher-7', kind: 'turn', data: { durationMs: 400, messageCount: 1 } },
  { at: 2700, sessionId: 'sess-b', name: 'matcher-7', kind: 'session-end', data: {} },
]

test('digest groups by session and aggregates the deltas', () => {
  const entries = digest(EVENTS, 1000)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].sessionId, 'sess-b', 'newest activity first')

  const a = entries.find(e => e.sessionId === 'sess-a')
  assert.equal(a.name, 'br-sfn-32')
  assert.equal(a.turns, 2)
  assert.equal(a.durationMs, 2000)
  assert.equal(a.costUSD, 1.75)
  assert.equal(a.costDeltaUSD, 0.75, 'delta is measured inside the window, not since zero')
  assert.equal(a.prs.length, 1, 'the same PR observed twice is one entry')
  assert.equal(a.title, 'map pacs.008')
  assert.equal(a.started, false, 'the session-start at 500 is outside the window')
  assert.equal(a.ended, false)

  const b = entries.find(e => e.sessionId === 'sess-b')
  assert.equal(b.turns, 1)
  assert.equal(b.ended, true)
})

test('/digest?since= filters even when the adapter hands back everything', async () => {
  const adapter = stubAdapter({ digestEvents: () => EVENTS })
  await withServer(adapter, async ({ base }) => {
    const { status, body } = await getJson(base, '/digest?since=2400')
    assert.equal(status, 200)
    assert.equal(body.since, 2400)
    const a = body.entries.find(e => e.sessionId === 'sess-a')
    assert.equal(a.turns, 0, 'turns before 2400 are out of the window')
    assert.equal(a.prs.length, 1)
    assert.equal(a.title, 'map pacs.008')

    const wide = await getJson(base, '/digest?since=1')
    assert.equal(wide.body.entries.find(e => e.sessionId === 'sess-a').turns, 2)

    const none = await getJson(base, '/digest?since=99999')
    assert.deepEqual(none.body.entries, [])
  })
})

test('/digest without since falls back to a 24h window', async () => {
  const now = Date.now()
  const adapter = stubAdapter({ digestEvents: since => [{ at: now - 3600e3, sessionId: 's', name: 's', kind: 'turn', data: { durationMs: 1 } }].filter(e => e.at >= since) })
  await withServer(adapter, async ({ base }) => {
    const { body } = await getJson(base, '/digest')
    assert.ok(body.since <= now - 24 * 3600e3 + 5000 && body.since > now - 25 * 3600e3)
    assert.equal(body.entries.length, 1)
  })
})
