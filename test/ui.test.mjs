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
// Every tree row as {g,k,v}, in document order. The guide is the feature, so it
// is read as data instead of grepped for — a wrong glyph fails on the value.
const rows = html => html.split(/<(?:div|summary) class="row /).slice(1).map(r => ({
  g: (r.match(/class="g">([^<]*)</) || [, ''])[1],
  k: (r.match(/class="k">([^<]*)</) || [, ''])[1],
  v: (r.match(/class="v">([^<]*)</) || [, ''])[1]
}))
// the same tree under either heading: `tree` on the phone panel, `subagents` in
// the sheet. Stops at the next section so the log below never leaks in.
const treeOf = html => rows(html.split(/<h2>(?:tree|subagents[^<]*)<\/h2>/)[1].split('<h2>')[0])
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
    // the page asks one question — is this screen at least 760px — and answers
    // "phone" if the environment cannot say. boot({phone:true}) is that screen.
    matchMedia: () => ({ matches: !opts.phone }),
    encodeURIComponent,
    Number, Math, JSON, String, Object, Map, Set, Array, Date, isFinite, isNaN, Promise
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

// ---- hero identity and the one line under it ------------------------------
// A session's birth name is a guess made in its first second. canonical is what
// it still is on day three, so it outranks the name whenever the adapter has it.

test('canonical repo and branch outrank the birth name', () => {
  const ui = boot()
  ui.send({ sessions: [S('a', { name: 'lively-otter', canonical: { repo: 'agenttrail', branch: 'feat/live-context' } })] })
  const html = ui.grid.children[0].innerHTML
  assert.match(html, /<span class="name" title="agenttrail · feat\/live-context">agenttrail <span class="sep">·<\/span> <span class="br">feat\/live-context<\/span>/)
  assert.ok(!html.includes('lively-otter'), 'the birth name is gone, not appended')
})

test('a detached HEAD or missing branch leaves the repo standing alone', () => {
  const ui = boot()
  ui.send({ sessions: [
    S('h', { canonical: { repo: 'midaz', branch: 'HEAD' } }),
    S('n', { canonical: { repo: 'matcher', branch: null }, lastEventAt: 0 })
  ] })
  for (const el of ui.grid.children) {
    assert.ok(!/HEAD|class="br"/.test(el.innerHTML), 'no branch chip when there is no real branch')
  }
  assert.match(ui.grid.children[0].innerHTML, /title="midaz">midaz<\/span>/)
})

test('no canonical falls back to the name, and the meta line keeps cwd and branch', () => {
  const ui = boot()
  ui.send({ sessions: [S('a', { name: 'lively-otter', cwd: '/srv/worktrees/live-context', gitBranch: 'feat/x' })] })
  const html = ui.grid.children[0].innerHTML
  assert.match(html, /class="name" title="lively-otter">lively-otter</)
  assert.match(html, /live-context <span class="sep">·<\/span> <span class="br">feat\/x<\/span>/)
})

test('the meta line stops repeating what the head already said', () => {
  const ui = boot()
  ui.send({ sessions: [S('a', { canonical: { repo: 'agenttrail', branch: 'feat/x' }, cwd: '/srv/worktrees/agenttrail', gitBranch: 'feat/x', model: 'opus', account: '005' })] })
  const meta = ui.grid.children[0].innerHTML.split('class="meta"')[1]
  assert.ok(!/feat\/x/.test(meta), 'the branch is stated once, in the head')
  assert.match(meta, /opus <span class="sep">·<\/span> 005/, 'and the width goes to what is left')
})

test('the line under the name is summary, then last prompt, then title', () => {
  const ui = boot()
  const full = { title: 'born title', lastPrompt: { text: 'ship the tree', at: 20 }, summary: { text: 'reviewing the mini-log', at: 30 } }
  ui.send({ sessions: [S('a', full)] })
  assert.match(ui.grid.children[0].innerHTML, /class="v">reviewing the mini-log<\/span><span class="a t-ago" data-at="30"/, 'summary wins, and shows its age')

  ui.send({ sessions: [S('a', { ...full, summary: null })] })
  assert.match(ui.grid.children[0].innerHTML, /class="v">ship the tree<\/span>/)
  assert.ok(!/class="a t-ago"/.test(ui.grid.children[0].innerHTML), 'only a summary is dated; a prompt is not')

  ui.send({ sessions: [S('a', { ...full, summary: null, lastPrompt: null })] })
  assert.match(ui.grid.children[0].innerHTML, /class="v">born title<\/span>/)
})

// The whole epic renders fields the wiring epic has not shipped yet. Absent is
// the normal case in production too, whenever the summarizer is switched off.
test('a session with none of the new fields still renders', () => {
  const ui = boot()
  ui.send({ sessions: [S('bare')] })
  const html = ui.grid.children[0].innerHTML
  assert.match(html, /class="name" title="bare">bare</)
  assert.match(html, /class="title none"[^>]*><span class="v">no title yet<\/span>/)
  assert.ok(!/class="exp"/.test(html), 'and nothing unfolds until it is tapped')
})

test('a hostile summary, prompt and canonical name are escaped', () => {
  const bad = '<img src=q onerror=alert(1)>'
  const ui = boot()
  ui.send({ sessions: [S('a', { canonical: { repo: bad, branch: bad }, summary: { text: bad, at: 3 }, lastPrompt: { text: bad, at: 2 } })] })
  const html = ui.grid.children[0].innerHTML
  assert.ok(!/<img /.test(html), 'nothing raw from the LLM or the human')
  assert.match(html, /title="&lt;img src=q onerror=alert\(1\)&gt; · &lt;img/, 'not even inside the tooltip')
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
  // depth ships as box-drawing glyphs, computed from real position: a segment
  // per ancestor, `└─` only where the parent has nothing left below.
  const r = treeOf(html)
  const by = Object.fromEntries(r.map(x => [x.v || x.k, x.g]))
  const depth = g => (g.length - 2) / 3
  assert.equal(r[0].g, '', 'the session is the root, and a root hangs off nothing')
  assert.equal(r[0].k, 'br-sfn')
  assert.equal(depth(by.CH9), 9, 'the chain guides down to the cap')
  assert.ok(r.every(x => !x.g || depth(x.g) <= 9), 'and never past it')
  assert.match(html, /subagents · 17/, 'the header counts every agent it drew')
  assert.equal(by.EE, '│  └─', 'a child of a drawn parent hangs off a line still open above it')
  assert.equal(by.CC, '├─', 'a top-level row with siblings after it keeps its line going')
  assert.equal(by.CH11, '└─', 'and the very last one closes it')
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
  // same guides as the phone panel: the workflow hangs off the root, its agents
  // off the workflow, and the finished one sorts under the one still running
  assert.deepEqual(treeOf(ui.body.innerHTML).map(x => [x.g, x.v]),
    [['', ''], ['└─', 'wf_1'], ['   ├─', 'phase 1'], ['   └─', 'phase 0']])

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

// ---- the phone card: inline tree and mini-log ------------------------------
// Under 760px a modal covers the card the thumb just hit, so the card unfolds
// in place. The tree comes from the SSE session and keeps ticking with the
// grid; only the log needs the fetch the sheet was already making.

const WF = {
  id: 'wf_b77c8066-311',
  name: 'wave1-session-pivot',
  description: 'pivot the session model onto canonical identity',
  agents: 9,
  done: 3,
  running: 1,
  phase: { current: 'Review', done: 3, total: 9 },
  runningAgents: [{ agentId: 'ag1', description: 'review:D-ui', currentTool: { name: 'Edit', detail: 'public/index.html', at: 555 } }]
}
const TL = [
  { at: 1756600000000, kind: 'turn', data: { text: 'first' } },
  { at: 1756600060000, kind: 'pr', data: { number: 7, repo: 'agenttrail' } },
  { at: 1756600120000, kind: 'summary', data: 'newest' }
]
const clock = ms => new Date(ms).toTimeString().slice(0, 5)

test('on a phone the card unfolds in place instead of opening the sheet', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: TL })) })
  ui.send({ sessions: [S('a1', { workflows: [WF] })] })
  ui.card('a1'); await flush()
  assert.ok(!ui.sheet.open, 'no modal on top of the card the thumb just hit')
  const html = ui.grid.children[0].innerHTML
  assert.match(html, /class="exp"/)
  assert.match(html, /aria-expanded="true"/)
  assert.deepEqual(ui.calls, ['/session/a1'], 'one fetch, for the log the SSE session does not carry')
})

test('on a wide screen the card does not unfold; the sheet still does the work', async () => {
  const ui = boot({ fetch: () => ok(D({ timeline: TL })) })
  ui.send({ sessions: [S('a1', { workflows: [WF] })] })
  ui.card('a1'); await flush()
  assert.equal(ui.sheet.open, true)
  assert.ok(!/class="exp"/.test(ui.grid.children[0].innerHTML), 'the grid stays a grid of summaries')
})

test('the tree names the workflow, its phase and what each agent is running', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [] })) })
  ui.send({ sessions: [S('a1', { workflows: [WF] })] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  assert.match(html, /class="v">wave1-session-pivot<\/span><span class="r">Review 3\/9<\/span>/)
  assert.match(html, /class="hint c2">pivot the session model/, 'the blurb is clamped, not dropped')
  assert.match(html, /class="k">review:D-ui<\/span><span class="v">Edit public\/index\.html<\/span>/)
  assert.match(html, /class="t-ago" data-at="555"/, 'the tool line keeps ticking')
})

test('a themeless workflow falls back to its counters, and lone agents follow it', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [] })) })
  ui.send({ sessions: [S('a1', {
    workflows: [{ id: 'wf_2', agents: 5, done: 2, running: 1, runningAgents: [{ agentId: 'x', description: 'phase 3' }] }],
    agents: [{ agentId: 'solo', status: 'running', description: 'lone explorer', currentTool: { name: 'Grep', detail: 'lib/', at: 9 } }]
  })] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  assert.match(html, /class="v">wf_2<\/span><span class="r">2\/5 done<\/span>/, 'the id stands in for a missing theme')
  assert.match(html, /class="k">phase 3<\/span><span class="v">—<\/span>/, 'an agent between tools says so')
  assert.ok(html.indexOf('lone explorer') > html.indexOf('phase 3'), 'lone agents come after the workflows')
})

test('nothing running leaves the root standing alone, and the log below it', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: TL })) })
  ui.send({ sessions: [S('a1', { workflows: [{ id: 'wf_3', agents: 4, done: 4, running: 0 }], agents: [{ agentId: 'z', status: 'done' }] })] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  assert.deepEqual(treeOf(html).map(x => x.k), ['a1'], 'a finished workflow belongs in the log, not the live tree')
  assert.match(html, /last 24h/)
})

// The panel is read as a shape, not a list: the session at the root, what it
// spawned hanging off it, and a glyph column that says which lines are still
// open below. Every guide is computed from position — the same row deeper in
// the tree draws a different prefix.
test('the inline tree roots on the session and guides each child off its position', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [] })) })
  ui.send({ sessions: [S('a1', {
    status: 'busy',
    canonical: { repo: 'agenttrail', branch: 'feat/session-tree' },
    currentTool: { name: 'Read', detail: 'CLAUDE.md', at: 7 },
    workflows: [WF],
    agents: [{ agentId: 'solo', status: 'running', description: 'lone explorer', currentTool: { name: 'Grep', detail: 'lib/', at: 9 } }]
  })] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  assert.deepEqual(treeOf(html).map(x => [x.g, x.k || x.v]), [
    ['', 'agenttrail · feat/session-tree'],
    ['├─', 'wave1-session-pivot'],
    ['│  ├─', 'review:D-ui'],
    ['│  └─', '3 done'],
    ['└─', 'lone explorer']
  ])
  assert.match(html, /class="k">agenttrail · feat\/session-tree<\/span><span class="v">Read CLAUDE\.md<\/span>/, 'a busy root says what it is doing')
  assert.match(html, /class="t-ago" data-at="7"/, 'and keeps ticking')
})

// A phone card has room for what is moving. Finished agents are context for
// that, so they arrive as a count instead of pushing the live rows off-screen.
test('when the full tree lands, finished agents collapse to one row per parent', async () => {
  const agents = [
    { agentId: 'r1', workflowId: 'wf_1', description: 'still going', status: 'running', startedAt: 3 },
    { agentId: 'd1', workflowId: 'wf_1', description: 'finished one', status: 'ended' },
    { agentId: 'd2', workflowId: 'wf_1', description: 'finished two', status: 'ended' },
    { agentId: 'l1', description: 'lone runner', status: 'running' },
    { agentId: 'l2', description: 'lone finished', status: 'ended' }
  ]
  const wfs = [{ id: 'wf_1', name: 'wave1', running: 1, agents: 3, done: 2 }]
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [], agents, workflows: wfs })) })
  ui.send({ sessions: [S('a1', { workflows: [{ ...wfs[0], runningAgents: [{ agentId: 'r1', description: 'still going' }] }] })] })
  ui.card('a1')
  assert.deepEqual(treeOf(ui.grid.children[0].innerHTML).map(x => x.k || x.v),
    ['a1', 'wave1', 'still going', '2 done'], 'the SSE slice draws the tree while the fetch is in flight')

  await flush()
  const html = ui.grid.children[0].innerHTML
  assert.deepEqual(treeOf(html).map(x => [x.g, x.k || x.v]), [
    ['', 'a1'],
    ['├─', 'wave1'],
    ['│  ├─', 'still going'],
    ['│  └─', '2 done'],
    ['├─', 'lone runner'],
    ['└─', '1 done']
  ], 'and the full list only deepens it')
  assert.ok(!/finished one|finished two|lone finished/.test(html), 'five agents, two counts, no wall of finished rows')
})

// Two sources describe the same session — the fetched tree and the SSE slice —
// and reading one list off each produces a tree that never existed: a workflow
// named by the live session, counted off the stale fetch, with the agent that is
// actually running in neither. The choice is one decision for the whole snapshot.
test('the tree reads one source: a fetch with rows wins whole, an empty one yields', async () => {
  const live = { id: 'wf_1', name: 'wave1', agents: 6, done: 4, running: 1, runningAgents: [{ agentId: 'r1', description: 'still going' }] }
  const ended = [{ agentId: 'd1', description: 'finished one', status: 'ended' }]

  // the fetch landed carrying only ended agents and no workflows at all
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [], agents: ended })) })
  ui.send({ sessions: [S('a1', { workflows: [live] })] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  assert.deepEqual(treeOf(html).map(x => [x.g, x.k || x.v]), [
    ['', 'a1'],
    ['└─', '1 done']
  ], 'the fetch describes this session whole: its one ended agent, and no workflow')
  assert.ok(!/wave1|still going/.test(html), 'nothing from the live slice leaks in beside it')

  // same live session, but the fetch has nothing to say — the slice draws it all
  const ui2 = boot({ phone: true, fetch: () => ok(D({ timeline: [] })) })
  ui2.send({ sessions: [S('a1', { workflows: [live] })] })
  ui2.card('a1'); await flush()
  assert.deepEqual(treeOf(ui2.grid.children[0].innerHTML).map(x => [x.g, x.k || x.v]), [
    ['', 'a1'],
    ['└─', 'wave1'],
    ['   ├─', 'still going'],
    ['   └─', '4 done']
  ], 'and its counters come from the same place its rows do')
})

test('a session the daemon dropped falls back to the live tree, not its last fetch', async () => {
  let n = 0
  const ui = boot({
    phone: true,
    fetch: () => (++n === 1 ? ok(D({ timeline: [], agents: [{ agentId: 'd1', description: 'finished one', status: 'ended' }] })) : { ok: false, status: 404 })
  })
  ui.send({ sessions: [S('a1', { workflows: [{ id: 'wf_1', name: 'wave1', running: 1, runningAgents: [{ agentId: 'r1', description: 'still going' }] }] })] })
  ui.card('a1'); await flush()
  assert.deepEqual(treeOf(ui.grid.children[0].innerHTML).map(x => x.k || x.v), ['a1', '1 done'], 'the fetch is in charge while it is tracked')

  ui.send({ partial: true, sessions: [{ id: 'a1', lastEventAt: 2 }] })   // moves, refetches, 404s
  await flush()
  assert.deepEqual(treeOf(ui.grid.children[0].innerHTML).map(x => x.k || x.v), ['a1', 'wave1', 'still going'],
    'a snapshot the daemon no longer stands behind is not a tree to keep painting')
})

// Six is what a 320px card holds. The rows past it are still RUNNING, so
// dropping them silently understates the session and adding them to "N done"
// would state the opposite — they get their own line.
test('running agents past the cap arrive as a count, not silence', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [] })) })
  ui.send({ sessions: [S('a1', { workflows: [{
    id: 'wf_1', name: 'wave1', agents: 12, done: 3, running: 9,
    runningAgents: Array.from({ length: 9 }, (_, i) => ({ agentId: 'r' + i, description: 'runner ' + i }))
  }] })] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  const t = treeOf(html)
  assert.deepEqual(t.slice(-2).map(x => [x.g, x.k || x.v]), [['   ├─', '+3 more'], ['   └─', '3 done']],
    'the overflow is its own row, above the done count and never folded into it')
  assert.equal(t.length, 10, 'root, the workflow, six runners, the overflow, the done count')
  assert.ok(!/runner 6|runner 7|runner 8/.test(html), 'the rows themselves stay cut')

  // lone agents hit the same cap and say so the same way
  const ui2 = boot({ phone: true, fetch: () => ok(D({ timeline: [] })) })
  ui2.send({ sessions: [S('a1', { agents: Array.from({ length: 8 }, (_, i) => ({ agentId: 'l' + i, description: 'lone ' + i, status: 'running' })) })] })
  ui2.card('a1'); await flush()
  const t2 = treeOf(ui2.grid.children[0].innerHTML)
  assert.equal(t2.length, 8, 'root, six runners, the overflow')
  assert.deepEqual([t2[7].g, t2[7].v], ['└─', '+2 more'])
})

test('a workflow with no named phase falls back to its own counters', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [] })) })
  ui.send({ sessions: [S('a1', { workflows: [
    { id: 'w1', name: 'named', phase: { current: 'Review', done: 3, total: 9 }, agents: 5, done: 2, running: 1 },
    { id: 'w2', name: 'unnamed phase', phase: { current: null, done: 3, total: 9 }, agents: 5, done: 2, running: 1 },
    { id: 'w3', name: 'no phase at all', agents: 4, done: 1, running: 1 }
  ] })] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  assert.match(html, /class="v">named<\/span><span class="r">Review 3\/9</)
  assert.match(html, /class="v">unnamed phase<\/span><span class="r">2\/5 done</)
  assert.match(html, /class="v">no phase at all<\/span><span class="r">1\/4 done</)
})

test('the root label, a workflow name and an aggregated tree are all escaped', async () => {
  const bad = '<img src=q onerror=alert(1)>'
  const agents = [
    { agentId: 'r', workflowId: 'w', type: bad, description: bad, status: 'running', startedAt: 1 },
    { agentId: 'd', workflowId: 'w', description: bad, status: 'ended' }
  ]
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [], agents, workflows: [{ id: 'w', name: bad, description: bad, running: 1 }] })) })
  ui.send({ sessions: [S('a1', { canonical: { repo: bad, branch: bad }, currentTool: { name: bad, detail: bad, at: 1 }, status: 'busy', workflows: [{ id: 'w', name: bad, running: 1 }] })] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  assert.ok(!/<img /.test(html), 'nothing raw from the root, a workflow, an agent or its tool')
  assert.match(html, /class="k">&lt;img src=q onerror=alert\(1\)&gt; · &lt;img/, 'not even the canonical root label')
  assert.match(html, /class="v">1 done<\/span>/, 'and the aggregate is a number, not a name')
})

test('a log row is time, kind and whatever the daemon put in data', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: TL })) })
  ui.send({ sessions: [S('a1')] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  assert.match(html, new RegExp(`class="k">${clock(1756600000000)}</span><span class="v">turn — first`))
  assert.match(html, /pr — #7/, 'an object with no text still reads as what it is')
  assert.match(html, /summary — newest/, 'and a bare string is used as-is')
})

// A row saying `turn — {"durationMs":45000,"messageCount":3}` is a row nobody
// reads. The kinds the contract names get read as what they mean; everything
// else keeps the raw JSON, which is still better than dropping the row.
test('the log formats the kinds it knows: a turn is how long it took, a cost is money', async () => {
  const tl = [
    { at: 1756600000000, kind: 'turn', data: { durationMs: 45000, messageCount: 3 } },
    { at: 1756600060000, kind: 'cost', data: { totalUSD: 1.5 } },
    { at: 1756600120000, kind: 'turn', data: { messageCount: 2 } },
    { at: 1756600180000, kind: 'blimp', data: { durationMs: 45000 } }
  ]
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: tl })) })
  ui.send({ sessions: [S('a1')] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  assert.match(html, /turn — 45s/, 'a duration, not the object it came in')
  assert.match(html, /cost — \$1\.50/, 'money reads as money')
  assert.match(html, /turn — \{&quot;messageCount&quot;:2\}/, 'a turn with no duration still shows what there is')
  assert.match(html, /blimp — \{&quot;durationMs&quot;:45000\}/, 'and an unknown kind is never guessed at')
})

// dialog.close() dispatches on a QUEUED task, so in a browser the close for the
// sheet openDetail() just dismissed arrives AFTER the inline panel is installed.
// The stub fires close synchronously, so the second fire below IS that ordering.
test('a queued sheet close does not fold the card it just opened', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [] })) })
  ui.send({ sessions: [S('a1')] })
  ui.openDetail('a1', true)              // drilled in from a digest row: the sheet
  await flush()
  assert.equal(ui.sheet.open, true)

  ui.card('a1'); await flush()           // then tapped on the phone: sheet out, card open
  assert.match(ui.grid.children[0].innerHTML, /class="exp"/)

  fire(ui.sheet, 'close', ui.sheet)      // the browser's late close event lands here
  ui.send({ partial: true, sessions: [S('a1', { lastEventAt: 2 })] })
  assert.match(ui.grid.children[0].innerHTML, /class="exp"/, 'the panel the thumb opened is still open')

  ui.closeSheet()                        // an explicit close still closes everything
  ui.send({ partial: true, sessions: [S('a1', { lastEventAt: 3 })] })
  assert.ok(!/class="exp"/.test(ui.grid.children[0].innerHTML))
})

test('the mini-log reads oldest to newest and caps at 40 rows', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ at: 1756600000000 + i * 1000, kind: 'turn', data: 'e' + i }))
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [...TL, ...many] })) })
  ui.send({ sessions: [S('a1')] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML.split('<h2>last 24h</h2>')[1]
  assert.equal(html.split('class="k">').length - 1, 40, 'the cap counts rows, and the oldest are the ones dropped')
  assert.ok(!html.includes('turn — e19'), 'row 20 of 63 is past the cap')
  assert.ok(html.indexOf('turn — e58') < html.indexOf('turn — e59'), 'newest stays at the bottom')
})

test('an empty window says so, and so does a daemon with no timeline yet', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [] })) })
  ui.send({ sessions: [S('a1')] })
  ui.card('a1'); await flush()
  assert.match(ui.grid.children[0].innerHTML, /nothing in the last 24h/)

  const ui2 = boot({ phone: true, fetch: () => ok(D({})) })
  ui2.send({ sessions: [S('a1')] })
  ui2.card('a1'); await flush()
  assert.match(ui2.grid.children[0].innerHTML, /nothing in the last 24h/, 'an absent timeline is an empty one, not a crash')
})

test('a second tap folds the card, and only one card is ever open', async () => {
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [] })) })
  ui.send({ sessions: [S('a1', { lastPrompt: { text: 'the whole prompt, uncut', at: 4 } }), S('a2')] })
  ui.card('a1'); await flush()
  assert.match(ui.grid.children[0].innerHTML, /last prompt<\/h2><div class="hint">the whole prompt, uncut/, 'the head clips it, the expansion does not')
  ui.card('a2'); await flush()
  assert.ok(!/class="exp"/.test(ui.grid.children[0].innerHTML), 'the first card folded when the second opened')
  assert.match(ui.grid.children[1].innerHTML, /class="exp"/)
  ui.card('a2')
  assert.ok(!/class="exp"/.test(ui.grid.children[1].innerHTML), 'and a second tap closes it')
  assert.match(ui.grid.children[1].innerHTML, /aria-expanded="false"/)
})

test('workflow themes, tool lines and log rows are escaped', async () => {
  const bad = '<img src=q onerror=alert(1)>'
  const ui = boot({ phone: true, fetch: () => ok(D({ timeline: [{ at: 1756600000000, kind: bad, data: { text: bad } }] })) })
  ui.send({ sessions: [S('a1', {
    lastPrompt: { text: bad, at: 1 },
    workflows: [{ id: bad, name: bad, description: bad, running: 1, runningAgents: [{ agentId: bad, description: bad, currentTool: { name: bad, detail: bad, at: 2 } }] }]
  })] })
  ui.card('a1'); await flush()
  const html = ui.grid.children[0].innerHTML
  assert.ok(!/<img /.test(html), 'nothing raw from a workflow script, a tool line or the log')
  for (const spot of [/class="hint">&lt;img/, /class="hint c2">&lt;img/, /class="k">&lt;img/, /class="v">&lt;img/]) {
    assert.match(html, spot)
  }
})

test('page keeps theme bootstrap, persisted toggle and drops the deleted families', () => {
  assert.match(HTML, /localStorage\.getItem\('at-theme'\)/, 'pre-paint theme bootstrap')
  assert.match(HTML, /localStorage\.setItem\('at-theme',next\)/, 'persisted toggle')
  assert.match(HTML, /:root\[data-theme="light"\]/, 'light token block')
  for (const dead of ['fleet', 'inspector', 'expanded-node', 'expanded-plan', 'expanded-phase', 'plan-view', 'all-clear', 'switcher', 'canvas-hint', 'minimap', 'graph', 'PLAN.md', 'backfill', 'zoom', 'handoff', 'constellation']) {
    assert.ok(!HTML.includes(dead), `deleted: ${dead}`)
  }
  // The 48KB wall bought the session tree: box-drawing guides computed from
  // real position, the session itself as the root of both panels, and finished
  // agents aggregated so a 320px card shows what is moving. It paid part of its
  // own way — --ind/--ind-step went out, the glyph column being the indent now.
  // Checked first, again: no class selector in the file is unused, so the wall
  // moved on new behaviour, not on slack. 52KB is the next one, and the only
  // thing left to sell for it is a real feature, not dead CSS.
  assert.ok(HTML.length < 52000, `file is ${HTML.length} bytes`)
})

// A thumb needs ~44px, and every control the phone layout keeps reachable has to
// clear it — not just the ones sitting on a card. The two row selectors earn it
// with padding instead: .row aligns on the baseline, so a min-height would leave
// the text stranded at the top of a tall box.
test('every phone touch target clears the 44px floor', () => {
  const phone = HTML.split('@media(max-width:720px){')[1].split('@media')[0].replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = phone.split('}').map(r => r.split('{'))
  const tall = rules.filter(([, body]) => body && body.includes('min-height:44px'))
    .flatMap(([sel]) => sel.split(',').map(s => s.trim()))
  for (const sel of ['.act', '.card .act', '.dl>summary', '.dls a', '.dl-menu a', '.theme-toggle', '.bar input', '.pr']) {
    assert.ok(tall.includes(sel), `${sel} is under 44px on a phone`)
  }
  const rows = rules.find(([sel]) => sel.includes('button.row'))
  assert.match(rows[1], /padding:1[4-9]px 0/, 'drill-in rows and workflow summaries clear 44px by padding')
})

// The comment at the top of <style> claims a 4px spacing scale, and nothing was
// checking it, so it drifted. Every spacing declaration is read here, not a
// sampled few: what is left off the scale must be exactly the optical insets and
// touch floors the comment names. deepEqual, not "includes" — a new off-scale
// value fails, and so does an exemption that stopped being needed.
test('spacing sits on the 4px scale, bar the exemptions the comment names', () => {
  const CSS = HTML.split('<style>')[1].split('</style>')[0].replace(/\/\*[\s\S]*?\*\//g, '')
  const SPACING = new Set(['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'gap', 'row-gap', 'column-gap', 'top', 'right', 'bottom', 'left', 'inset', '--ind-step', '--card-min'])
  const off = new Set()
  for (const decl of CSS.replace(/[{}]/g, ';').split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    if (!SPACING.has(prop)) continue
    for (const [, n] of decl.slice(i + 1).matchAll(/(\d+(?:\.\d+)?)px/g)) if (+n % 4) off.add(`${prop}:${n}px`)
  }
  assert.deepEqual([...off].sort(), [
    'left:2px',        // .theme-thumb centres a 12px thumb in a 16px track
    'margin-top:5px',  // .row .d centres a 6px dot on a 17px line box
    'padding:14px',    // phone touch floors: .pr across, drill-in rows down
    'padding:1px',     // .pr keeps its pill at 18px inside a 24px card footer
    'padding:2px',     // .dl>summary and .card .act match at 22px in that footer
    'top:17px',        // .card:before centres the status rail on the head row
    'top:2px'          // .theme-thumb, as left:2px
  ])
})
