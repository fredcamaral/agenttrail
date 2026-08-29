// Evaluates public/index.html's UI script against a stub DOM. No browser,
// no network, no real ~/.claude — the page is a string and the model is JSON.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const SRC = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1]

class El {
  constructor (tag) { this.tag = tag; this.children = []; this.parent = null; this.dataset = {}; this.className = ''; this.innerHTML = ''; this.textContent = ''; this.style = {}; this._cls = new Set(); this._ev = [] }
  get classList () { const s = this._cls; return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) } }
  get firstChild () { return this.children[0] || null }
  get nextSibling () { if (!this.parent) return null; return this.parent.children[this.parent.children.indexOf(this) + 1] || null }
  remove () { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null } }
  insertBefore (el, ref) { el.remove(); const i = ref ? this.children.indexOf(ref) : -1; i < 0 ? this.children.push(el) : this.children.splice(i, 0, el); el.parent = this; return el }
  appendChild (el) { return this.insertBefore(el, null) }
  setAttribute () {}
  addEventListener (ev, fn, cap) { this._ev.push({ ev, fn, cap: !!cap }) }
  showModal () { this.open = true }
  close () { this.open = false; fire(this, 'close', this) }
}

// Invoke a registered listener the way the browser would: the panels use
// delegation, so the event target is a stand-in that answers closest().
function fire (el, ev, target, arg) {
  const l = el._ev.find(x => x.ev === ev)
  if (ev === 'close' && !l) return
  assert.ok(l, `no ${ev} listener on <${el.tag}>`)
  return l.fn({ target, ...arg })
}
// closest() over a tiny selector→element map; anything else is a miss.
const hit = map => ({ closest: sel => map[sel] || null })
const flush = () => new Promise(r => setTimeout(r, 0))

function boot (opts = {}) {
  const byId = new Map(['sessions', 'empty', 'counts', 'host', 'link', 'theme-toggle', 'theme-toggle-label',
    'sheet', 'sheet-body', 'sheet-title', 'sheet-sub'].map(id => [id, new El('div')]))
  const document = {
    documentElement: { dataset: { theme: 'dark' } },
    getElementById: id => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: t => new El(t)
  }
  const sse = {}
  const calls = []
  const ctx = {
    document,
    localStorage: { getItem: k => (k === 'at-seen' && opts.seen ? String(opts.seen) : null), setItem: () => {} },
    EventSource: function () { Object.assign(sse, this); return sse },
    setInterval: () => 0,
    fetch: url => { calls.push(url); return (opts.fetch || (() => ({ ok: false })))(url) },
    encodeURIComponent,
    Number, Math, JSON, String, Object, Map, Set, Array, Date, isFinite, Promise
  }
  const fn = new Function(...Object.keys(ctx), SRC + '\n;return {send:d=>es.onmessage({data:JSON.stringify(d)}),grid:document.getElementById("sessions"),counts:document.getElementById("counts"),host:document.getElementById("host"),sheet:document.getElementById("sheet"),body:document.getElementById("sheet-body"),title:document.getElementById("sheet-title"),sub:document.getElementById("sheet-sub"),openDetail,openDigest,closeSheet}')
  const ui = fn(...Object.values(ctx))
  ui.calls = calls
  ui.card = id => fire(ui.grid, 'click', hit({ '.card': { dataset: { id } } }))
  return ui
}

const S = (id, over = {}) => ({ id, source: 'claude', name: id, status: 'idle', startedAt: 1, lastEventAt: 1, ...over })
const order = ui => ui.grid.children.map(el => el.dataset.id)

test('full snapshot sorts busy, idle, shell, ended, then lastEventAt desc', () => {
  const ui = boot()
  ui.send({ host: 'mordor', port: 4317, now: 9, sessions: [
    S('e1', { status: 'ended', lastEventAt: 50 }),
    S('i1', { status: 'idle', lastEventAt: 10 }),
    S('b1', { status: 'busy', lastEventAt: 20 }),
    S('sh', { status: 'shell', lastEventAt: 30 }),
    S('i2', { status: 'idle', lastEventAt: 40 }),
    S('b2', { status: 'busy', lastEventAt: 99 })
  ] })
  assert.deepEqual(order(ui), ['b2', 'b1', 'i2', 'i1', 'sh', 'e1'])
  assert.equal(ui.host.textContent, 'mordor:4317')
  assert.match(ui.counts.innerHTML, /2 busy/)
  assert.match(ui.counts.innerHTML, /badge working/)
  assert.equal(ui.grid.children[0].className, 'card busy')
  assert.equal(ui.grid.children[5].className, 'card ended')
})

test('an unknown status is counted and styled as ended, and sorts last', () => {
  const ui = boot()
  ui.send({ sessions: [S('w', { status: 'weird', lastEventAt: 99 }), S('i', { status: 'idle', lastEventAt: 1 })] })
  assert.deepEqual(order(ui), ['i', 'w'])
  assert.equal(ui.grid.children[1].className, 'card ended')
  assert.match(ui.counts.innerHTML, /1 ended/)
})

test('partial tick merges by id and keeps heavy fields it omits', () => {
  const ui = boot()
  ui.send({ sessions: [S('a', { todos: [{ content: 'x', status: 'completed' }, { content: 'y', status: 'pending' }], agents: [{ agentId: '1', status: 'running' }], turns: 3 })] })
  assert.match(ui.grid.children[0].innerHTML, /todos <b>1\/2<\/b>/)
  ui.send({ partial: true, sessions: [S('a', { status: 'busy', turns: 9, lastEventAt: 77 })] })
  const html = ui.grid.children[0].innerHTML
  assert.match(html, /todos <b>1\/2<\/b>/, 'todos survive a tick that omits them')
  assert.match(html, /agents <b>1<\/b> <span class="run">1 running<\/span>/)
  assert.match(html, /<b>9<\/b> turns/)
  assert.equal(ui.grid.children[0].className, 'card busy')
  assert.equal(ui.grid.children.length, 1)
})

test('a later full snapshot drops sessions the daemon no longer reports', () => {
  const ui = boot()
  ui.send({ sessions: [S('a'), S('b')] })
  assert.equal(ui.grid.children.length, 2)
  ui.send({ sessions: [S('b')] })
  assert.deepEqual(order(ui), ['b'])
})

test('every interpolated field is escaped', () => {
  const ui = boot()
  ui.send({ sessions: [S('x"><img src=q onerror=alert(1)>', {
    name: '<script>bad()</script>',
    title: 'fix "auth" & <b>redirects</b>',
    cwd: "/repos/'; DROP--",
    gitBranch: '<em>br</em>',
    model: '<i>m</i>',
    account: '<u>005</u>',
    currentTool: { name: '<b>Bash</b>', detail: '<img>', at: 5 },
    prs: [{ number: '<b>7</b>', url: 'javascript:alert(1)', repo: '<x>' }]
  })] })
  const html = ui.grid.children[0].innerHTML
  assert.ok(!/<script>|<img |<b>7<\/b>|<em>|<u>/.test(html), 'no raw markup from session data')
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/)
  assert.match(html, /fix &quot;auth&quot; &amp; &lt;b&gt;/)
  assert.match(html, /href="#"/, 'javascript: PR url is neutralised')
})

test('card carries tool line, ticking spans and both export links', () => {
  const ui = boot()
  ui.send({ sessions: [S('s p a c e/1', { startedAt: 111, lastEventAt: 222, currentTool: { name: 'Edit', detail: 'lib/claude.mjs', at: 333 }, cost: { totalUSD: 4.2 } })] })
  const html = ui.grid.children[0].innerHTML
  assert.match(html, /<span class="tn">Edit<\/span><span class="td">lib\/claude\.mjs<\/span>/)
  assert.match(html, /class="t-ago" data-at="111"/, 'elapsed since startedAt')
  assert.match(html, /class="t-ago" data-at="222"/, 'elapsed since lastEventAt')
  assert.match(html, /class="ta t-ago" data-at="333"/)
  assert.match(html, /<b>\$4\.20<\/b>/)
  const q = encodeURIComponent('s p a c e/1')
  assert.ok(html.includes(`/export?session=${q}&amp;format=jsonl`), 'raw jsonl link')
  assert.ok(html.includes(`/export?session=${q}&amp;format=md`), 'markdown link')
})

test('a session with no transcript file offers no export links anywhere', async () => {
  const s = S('nf', { transcriptPath: null })
  const ui = boot({ fetch: () => ok({ ...s, agents: [] }) })
  ui.send({ sessions: [s] })
  assert.ok(!ui.grid.children[0].innerHTML.includes('/export'), 'no export menu on the card')
  ui.card('nf'); await flush()
  assert.ok(!ui.body.innerHTML.includes('/export'), 'no transcript section in the detail panel')
})

test('agent stat reports the daemon totals, not the trimmed slice', () => {
  const ui = boot()
  // lane B caps agents[] at 12 and ships the honest totals alongside it
  const trimmed = Array.from({ length: 12 }, (_, i) => ({ agentId: String(i), status: 'running' }))
  ui.send({ sessions: [S('big', { agents: trimmed, agentCount: 2603, agentsRunning: 40 })] })
  assert.match(ui.grid.children[0].innerHTML, /agents <b>2603<\/b> <span class="run">40 running<\/span>/)
})

test('agent stat falls back to the array when the daemon sends no totals', () => {
  const ui = boot()
  ui.send({ sessions: [S('a', { agents: [{ agentId: '1', status: 'running' }, { agentId: '2', status: 'done' }] })] })
  assert.match(ui.grid.children[0].innerHTML, /agents <b>2<\/b> <span class="run">1 running<\/span>/)
  ui.send({ sessions: [S('b', { agents: [{ agentId: '1', status: 'done' }], agentCount: null, agentsRunning: null })] })
  assert.match(ui.grid.children[0].innerHTML, /agents <b>1<\/b>/)
  assert.ok(!/running/.test(ui.grid.children[0].innerHTML), 'no running badge when none run')
})

test('prototype keys from the daemon never resolve to inherited values', () => {
  const ui = boot()
  ui.send({ sessions: [
    S('p', { status: 'constructor', source: 'constructor', lastEventAt: 5 }),
    S('t', { status: 'toString', source: '__proto__', lastEventAt: 4 })
  ] })
  assert.deepEqual(order(ui), ['p', 't'], 'unknown statuses still sort deterministically')
  for (const el of ui.grid.children) {
    assert.equal(el.className, 'card ended')
    assert.ok(!/function|\[object |native code/.test(el.innerHTML), 'no inherited value in markup')
    assert.match(el.innerHTML, /class="src" style="color:hsl\(/, 'falls back to the hashed colour')
  }
  assert.match(ui.counts.innerHTML, /2 ended/, 'both sessions are counted')
})

// ---- detail panel ---------------------------------------------------------

const D = (over = {}) => ({ ...S('a1', { name: 'br-sfn', status: 'busy' }), ...over })
const ok = body => ({ ok: true, json: () => body })

test('clicking a card opens the panel and asks the daemon for the full tree', async () => {
  const ui = boot({ fetch: () => ok(D({ agents: [{ agentId: 'a', type: 'Explore', description: 'read the plan', status: 'running', startedAt: 5 }] })) })
  ui.send({ sessions: [S('a1', { name: 'br-sfn', agents: [] })] })
  ui.card('a1')
  assert.equal(ui.sheet.open, true, 'the dialog is open, so esc and focus containment are the browser\'s job')
  assert.equal(ui.title.textContent, 'br-sfn')
  assert.match(ui.body.innerHTML, /loading the tree…/, 'the grid slice is not passed off as the tree')
  await flush()
  assert.deepEqual(ui.calls, ['/session/a1'])
  assert.match(ui.body.innerHTML, /subagents · 1/)
  assert.match(ui.body.innerHTML, /read the plan/)
  assert.ok(!/loading the tree/.test(ui.body.innerHTML))
})

test('a cyclic, self-parented or orphaned agent renders exactly once', async () => {
  const agents = [
    { agentId: 'a', parentAgentId: 'b', description: 'AA', status: 'done' },
    { agentId: 'b', parentAgentId: 'a', description: 'BB', status: 'done' },
    { agentId: 'c', parentAgentId: 'c', description: 'CC', status: 'done' },
    { agentId: 'd', parentAgentId: 'missing', description: 'DD', status: 'done' },
    { agentId: 'e', parentAgentId: 'd', description: 'EE', status: 'running', startedAt: 9 },
    // a 12-deep chain: indentation must stop growing, without losing anyone
    ...Array.from({ length: 12 }, (_, i) => ({ agentId: `c${i}`, parentAgentId: i ? `c${i - 1}` : null, description: `CH${i}`, status: 'done' }))
  ]
  const ui = boot({ fetch: () => ok(D({ agents })) })
  ui.send({ sessions: [S('a1')] })
  ui.card('a1'); await flush()
  const html = ui.body.innerHTML
  for (const d of ['AA', 'BB', 'CC', 'DD', 'EE', ...Array.from({ length: 12 }, (_, i) => `CH${i}`)]) {
    assert.equal(html.split(`>${d}<`).length - 1, 1, `${d} rendered once`)
  }
  assert.match(html, /margin-left:126px/, 'the chain indents to the cap')
  assert.ok(!/margin-left:1[4-9]\dpx|margin-left:[2-9]\d\dpx/.test(html), 'and never past it')
  assert.match(html, /subagents · 17/, 'the header counts every agent it drew')
  assert.match(html, /margin-left:14px"><span class="d"><\/span><span class="k">agent<\/span><span class="v">EE/, 'a child of a drawn parent is indented')
})

test('a workflow group the reader closed stays closed when the panel repaints', async () => {
  let seen = 10
  const agents = [
    { agentId: 'x', workflowId: 'wf_1', description: 'phase 1', status: 'running', startedAt: 1 },
    { agentId: 'y', workflowId: 'wf_1', description: 'phase 0', status: 'done', startedAt: 0 }
  ]
  const ui = boot({ fetch: () => ok(D({ lastEventAt: ++seen, agents, workflows: [{ id: 'wf_1' }] })) })
  ui.send({ sessions: [S('a1')] })
  ui.card('a1'); await flush()
  assert.match(ui.body.innerHTML, /<details class="wf" data-wf="wf_1" open>/, 'a running workflow opens itself')
  assert.match(ui.body.innerHTML, /1\/2 done · 1 running/, 'the header agrees with the rows under it')

  const before = ui.body.innerHTML
  fire(ui.body, 'toggle', { dataset: { wf: 'wf_1' }, open: false })
  ui.send({ partial: true, sessions: [{ id: 'a1', lastEventAt: 99 }] })
  await flush()
  assert.notEqual(ui.body.innerHTML, before, 'the moving session really did repaint')
  assert.ok(!/data-wf="wf_1" open/.test(ui.body.innerHTML), 'and the repaint did not force it open again')

  fire(ui.body, 'toggle', { dataset: { wf: 'wf_1' }, open: true })
  ui.send({ partial: true, sessions: [{ id: 'a1', lastEventAt: 100 }] })
  await flush()
  assert.match(ui.body.innerHTML, /<details class="wf" data-wf="wf_1" open>/, 'reopening sticks too')
})

test('a session the daemon dropped says so instead of showing its last numbers', async () => {
  const ui = boot({ fetch: () => ({ ok: false, status: 404 }) })
  ui.send({ sessions: [S('a1', { cost: { totalUSD: 4.2 }, turns: 7, status: 'busy', cwd: '/repos/x' })] })
  ui.card('a1')
  assert.match(ui.body.innerHTML, /\$4\.20/, 'the grid snapshot paints while the daemon is asked')
  assert.match(ui.sub.textContent, /busy/)
  await flush()
  const html = ui.body.innerHTML
  assert.match(html, /the daemon no longer tracks this session/)
  assert.equal(ui.sub.textContent, '', 'the header stops claiming a status too')
  assert.ok(!/\$4\.20|turns/.test(html), 'no stale numbers left under the banner')
  assert.ok(!/loading/.test(html), 'and no perpetual loading hint')
})

test('an open panel refetches when its session moves, one flight at a time', async () => {
  let release
  const gate = new Promise(r => { release = r })
  let n = 0
  const ui = boot({ fetch: () => (++n === 1 ? gate : ok(D({ agents: [] }))) })
  ui.send({ sessions: [S('a1')] })
  ui.card('a1')
  ui.send({ partial: true, sessions: [{ id: 'a1', lastEventAt: 3 }] })
  ui.send({ partial: true, sessions: [{ id: 'a1', lastEventAt: 4 }] })
  ui.send({ partial: true, sessions: [{ id: 'other', lastEventAt: 5 }] })
  assert.equal(ui.calls.length, 1, 'ticks during a flight do not pile up fetches')
  release(ok(D({ agents: [] })))
  await flush()
  assert.deepEqual(ui.calls, ['/session/a1', '/session/a1'], 'exactly one catch-up fetch, and none for another session')
})

test('the digest opens on the last visit and drills into a live session by keyboard', async () => {
  const entries = [
    { sessionId: 'a1', name: 'br-sfn', title: 'ship it', turns: 4, costDeltaUSD: 1.5, lastAt: 7 },
    { sessionId: 'dropped', name: 'old', ended: true, lastAt: 6 }
  ]
  const ui = boot({ seen: 5000, fetch: url => ok(url.startsWith('/digest') ? { entries } : D({ agents: [] })) })
  ui.send({ sessions: [S('a1', { name: 'br-sfn' })] })
  ui.openDigest(); await flush()
  assert.deepEqual(ui.calls, ['/digest?since=5000'], '"since I left" is the previous visit, not a guess')
  const html = ui.body.innerHTML
  assert.match(html, /<button class="row big" type="button" data-sid="a1">/, 'a live row is a real button, so it is keyboard-reachable')
  assert.ok(!/cursor:pointer/.test(html), 'no mouse-only affordance left behind')
  assert.match(html, /<div class="row big done">/, 'a session that already ended is not clickable')
  assert.match(html, /<b>4<\/b> turns/)
  assert.match(html, /<b>\+\$1\.50<\/b>/)
  fire(ui.body, 'click', hit({ '[data-i]': { dataset: { i: '2' } } }))
  assert.match(ui.calls[1], /^\/digest\?since=\d+$/, 'a range button re-asks for a new window')
  fire(ui.body, 'click', hit({ '[data-sid]': { dataset: { sid: 'a1' } } }))
  assert.equal(ui.title.textContent, 'br-sfn', 'the row drills into that session')
  await flush()
  assert.ok(ui.calls.includes('/session/a1'))
})

test('agent, workflow, todo and digest fields are escaped', async () => {
  const bad = '<img src=q onerror=alert(1)>'
  const ui = boot({
    fetch: url => ok(url.startsWith('/digest')
      ? { entries: [{ sessionId: 'a1', name: bad, title: bad, prs: [{ number: bad, url: 'javascript:alert(1)' }], lastAt: 1 }] }
      : D({ agents: [{ agentId: bad, type: bad, description: bad, status: 'done', workflowId: bad }], workflows: [{ id: bad }], todos: [{ content: bad, status: 'pending' }], recentTools: [{ name: bad, detail: bad, at: 1, ms: 5 }] }))
  })
  ui.send({ sessions: [S('a1')] })
  ui.card('a1'); await flush()
  assert.ok(!/<img /.test(ui.body.innerHTML), 'nothing raw from the tree, todos or tools')
  assert.match(ui.body.innerHTML, /data-wf="&lt;img/, 'not even inside an attribute')
  ui.openDigest(); await flush()
  assert.ok(!/<img /.test(ui.body.innerHTML), 'nothing raw from the digest')
  assert.match(ui.body.innerHTML, /href="#"/, 'a javascript: PR url is neutralised')
})

test('page keeps theme bootstrap, persisted toggle and drops the deleted families', () => {
  assert.match(HTML, /localStorage\.getItem\('at-theme'\)/, 'pre-paint theme bootstrap')
  assert.match(HTML, /localStorage\.setItem\('at-theme',next\)/, 'persisted toggle')
  assert.match(HTML, /:root\[data-theme="light"\]/, 'light token block')
  for (const dead of ['fleet', 'inspector', 'expanded-node', 'expanded-plan', 'expanded-phase', 'plan-view', 'all-clear', 'switcher', 'canvas-hint', 'minimap', 'graph', 'PLAN.md', 'backfill', 'zoom', 'handoff', 'constellation']) {
    assert.ok(!HTML.includes(dead), `deleted: ${dead}`)
  }
  // wave 2 added the detail panel and the digest to the same single file;
  // the budget is deliberate, not a high-water mark — 40KB is the next wall.
  assert.ok(HTML.length < 40000, `file is ${HTML.length} bytes`)
})
