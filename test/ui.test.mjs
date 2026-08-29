// Evaluates public/index.html's UI script against a stub DOM. No browser,
// no network, no real ~/.claude — the page is a string and the model is JSON.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const SRC = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1]

class El {
  constructor (tag) { this.tag = tag; this.children = []; this.parent = null; this.dataset = {}; this.className = ''; this.innerHTML = ''; this.textContent = ''; this.style = {}; this._cls = new Set() }
  get classList () { const s = this._cls; return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) } }
  get firstChild () { return this.children[0] || null }
  get nextSibling () { if (!this.parent) return null; return this.parent.children[this.parent.children.indexOf(this) + 1] || null }
  remove () { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null } }
  insertBefore (el, ref) { el.remove(); const i = ref ? this.children.indexOf(ref) : -1; i < 0 ? this.children.push(el) : this.children.splice(i, 0, el); el.parent = this; return el }
  appendChild (el) { return this.insertBefore(el, null) }
  setAttribute () {}
}

function boot () {
  const byId = new Map(['sessions', 'empty', 'counts', 'host', 'link', 'theme-toggle', 'theme-toggle-label'].map(id => [id, new El('div')]))
  const document = {
    documentElement: { dataset: { theme: 'dark' } },
    getElementById: id => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: t => new El(t)
  }
  const sse = {}
  const ctx = {
    document,
    localStorage: { getItem: () => null, setItem: () => {} },
    EventSource: function () { Object.assign(sse, this); return sse },
    setInterval: () => 0,
    encodeURIComponent,
    Number, Math, JSON, String, Object, Map, Set, Array, Date, isFinite
  }
  const fn = new Function(...Object.keys(ctx), SRC + '\n;return {send:d=>es.onmessage({data:JSON.stringify(d)}),grid:document.getElementById("sessions"),counts:document.getElementById("counts"),host:document.getElementById("host")}')
  return fn(...Object.values(ctx))
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

test('page keeps theme bootstrap, persisted toggle and drops the deleted families', () => {
  assert.match(HTML, /localStorage\.getItem\('at-theme'\)/, 'pre-paint theme bootstrap')
  assert.match(HTML, /localStorage\.setItem\('at-theme',next\)/, 'persisted toggle')
  assert.match(HTML, /:root\[data-theme="light"\]/, 'light token block')
  for (const dead of ['fleet', 'inspector', 'expanded-node', 'expanded-plan', 'expanded-phase', 'plan-view', 'all-clear', 'switcher', 'canvas-hint', 'minimap', 'graph', 'PLAN.md', 'backfill', 'zoom', 'handoff', 'constellation']) {
    assert.ok(!HTML.includes(dead), `deleted: ${dead}`)
  }
  assert.ok(HTML.length < 118632 / 4, `file is ${HTML.length} bytes`)
})
