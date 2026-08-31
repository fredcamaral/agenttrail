// The summarizer talks to OpenRouter, so every test here stubs fetchImpl and
// every byte it writes goes to a tmpdir. No test reads OPENROUTER_API_KEY, no
// test reaches the network, and the fake key below is what proves the real one
// would never surface in a log, a throw or a file.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSummarizer } from '../lib/summarize.mjs';

const KEY = 'sk-or-v1-FAKE-KEY-NEVER-REAL-0000000000';
const dirs = [];

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-sum-')); dirs.push(d); return d; };

/** Let the background refresh run to completion: it is all microtasks over the stub. */
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)));

const reply = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });

/** A fetch stub that records every request and answers from `answer(nthCall)`. */
function stub(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return typeof answer === 'function' ? answer(calls.length) : answer;
  };
  fn.calls = calls;
  return fn;
}

const material = (version, text = 'prompt: fix the ledger\ntool: Bash make test') => ({ version, text });

test.after(() => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

test('get() answers from cache immediately and refreshes behind the caller', async () => {
  const fetchImpl = stub(reply('Corrigindo o razão: roda os testes do ledger.'));
  const updated = [];
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl, onUpdate: (id) => updated.push(id) });

  assert.equal(s.get('sess-1', material('v1')), null, 'the first call cannot have an answer yet and must not block for one');
  assert.equal(fetchImpl.calls.length, 1, 'but it did start the request');

  await settle();
  const hit = s.get('sess-1', material('v1'));
  assert.equal(hit.text, 'Corrigindo o razão: roda os testes do ledger.');
  assert.equal(Number.isFinite(hit.at), true);
  assert.deepEqual(Object.keys(hit).sort(), ['at', 'text'], 'the Session contract carries text and at, nothing else');
  assert.deepEqual(updated, ['sess-1'], 'onUpdate is what tells the daemon to push an SSE tick');
  s.stop();
});

test('an unchanged version costs nothing; a new one costs exactly one request', async () => {
  const fetchImpl = stub(reply('working'));
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });

  s.get('sess-1', material('10:2'));
  await settle();
  assert.equal(fetchImpl.calls.length, 1);

  for (let i = 0; i < 5; i++) s.get('sess-1', material('10:2'));
  await settle();
  assert.equal(fetchImpl.calls.length, 1, 'same material, same summary — a tick every 2s must not be a request every 2s');

  // A burst of ticks while the new version is already in flight is still one call.
  s.get('sess-1', material('88:3'));
  s.get('sess-1', material('88:3'));
  s.get('sess-1', material('88:3'));
  await settle();
  assert.equal(fetchImpl.calls.length, 2, 'new turns landed: exactly one refresh, coalesced');
  s.stop();
});

test('minIntervalMs floors the cadence even when every tick brings new turns', async () => {
  const fetchImpl = stub(reply('working'));
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 300_000, fetchImpl });

  s.get('sess-1', material('v1'));
  await settle();
  assert.equal(fetchImpl.calls.length, 1);

  for (const v of ['v2', 'v3', 'v4']) s.get('sess-1', material(v));
  await settle();
  assert.equal(fetchImpl.calls.length, 1, 'a busy session summarized 12x/hour would be the whole cost of the feature');

  // A different session is never held back by another session's cadence.
  s.get('sess-2', material('v1'));
  await settle();
  assert.equal(fetchImpl.calls.length, 2);
  s.stop();
});

test('the request carries both caps: a 3-4 word title asked, 4000 chars of material sent, 64 chars kept', async () => {
  const long = 'palavra '.repeat(200);                       // ~1600 chars, far past the cap
  const fetchImpl = stub(reply(`  ${long}  `));
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl, model: 'test/model' });

  s.get('sess-1', material('v1', 'M'.repeat(9000)));
  await settle();

  const { url, body } = fetchImpl.calls[0];
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.model, 'test/model');
  // Reasoning is billed against max_tokens, so a budget the model can spend
  // thinking returns empty content and the card never gets a line. Off, plus
  // slack — TEXT_MAX is what actually bounds the answer.
  assert.equal(body.max_tokens, 64);
  assert.deepEqual(body.reasoning, { enabled: false }, 'thinking tokens must not eat the answer');
  assert.match(body.messages[0].content, /3-4 word title/);
  assert.match(body.messages[0].content, /No preamble\./);
  assert.match(body.messages[0].content, /No trailing punctuation\./);
  assert.equal(body.messages[1].content.length, 4000, 'oversized material is cut before it is paid for');

  const hit = s.get('sess-1', material('v1'));
  assert.equal(hit.text.length, 64, 'a model that ignores the word limit is cut by the code');
  assert.equal(hit.text, long.trim().slice(0, 64));
  s.stop();
});

// ---- a second summarizer ----------------------------------------------------
// The knobs exist so agent briefs can reuse this machine to answer a different
// question. The tests above are the defaults, untouched, and they are what says
// the session titles did not change shape when the options arrived.

test('every knob is an option: a second summarizer asks its own question, into its own file', async () => {
  const dir = tmp();
  const fetchImpl = stub(reply('X'.repeat(500)));
  const s = createSummarizer({
    apiKey: KEY, dir, minIntervalMs: 0, fetchImpl,
    system: 'Summarize the task prompt in 1-2 sentences.',
    textMax: 360, maxTokens: 160, cacheFile: 'agent-briefs.json', history: false,
  });

  s.get('agent-1', material('v1', 'M'.repeat(9000)));
  await settle();

  const { body } = fetchImpl.calls[0];
  assert.equal(body.max_tokens, 160);
  assert.equal(body.messages[0].content, 'Summarize the task prompt in 1-2 sentences.');
  assert.equal(body.messages[1].content.length, 4000, 'what one call may cost is the module\'s rule, not a knob');
  assert.equal(s.get('agent-1', material('v1')).text.length, 360, 'and the reply is cut at the caller\'s limit');

  assert.deepEqual(fs.readdirSync(dir), ['agent-briefs.json'], 'its own cache, and history:false writes no log at all');
  assert.deepEqual(s.history('agent-1'), [], 'not a log nobody reads — no log');
  s.stop();
});

// A tree of subagents arrives all at once, so the first tick after a boot can
// meet eighty ids nobody has ever summarized. Without a global cap that is
// eighty requests in one breath.
test('the in-flight cap bounds a burst, and the ids over it are only postponed', async () => {
  const fetchImpl = stub(() => new Promise(() => {}));   // every request stays in the air
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });
  for (const id of ['a', 'b', 'c', 'd', 'e']) s.get(id, material('v1'));
  await settle();
  assert.equal(fetchImpl.calls.length, 4, 'four slots, four requests — the fifth id costs nothing');
  s.stop();

  // Nothing was consumed by being turned away: the id that waited is picked up
  // by the next call, once a slot is actually free.
  const pending = [];
  const f2 = stub(() => new Promise((r) => pending.push(r)));
  const s2 = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl: f2, maxInflight: 1 });
  s2.get('a', material('v1'));
  s2.get('b', material('v1'));
  await settle();
  assert.equal(f2.calls.length, 1, 'one slot, one request');

  pending.shift()(reply('done'));
  await settle();
  s2.get('b', material('v1'));
  await settle();
  assert.equal(f2.calls.length, 2, 'the slot freed and the id that waited was retried, not blacklisted');
  s2.stop();
});

test('peek() reads the cache and never fires anything', async () => {
  const fetchImpl = stub(reply('a brief'));
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });

  assert.equal(s.peek('agent-1'), null);
  await settle();
  assert.equal(fetchImpl.calls.length, 0, 'serving a payload must never cost a model call');

  assert.deepEqual(await s.generate('agent-1', material('v1')), { text: 'a brief' });
  const hit = s.peek('agent-1');
  assert.equal(hit.text, 'a brief');
  assert.equal(Number.isFinite(hit.at), true);
  assert.deepEqual(Object.keys(hit).sort(), ['at', 'text']);
  s.stop();
});

test('generate() awaits one request per id: a second click joins the first, a cached one is free', async () => {
  const fetchImpl = stub(reply('what the agent was asked to do'));
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });

  const [a, b, c] = await Promise.all([
    s.generate('agent-1', material('v1')),
    s.generate('agent-1', material('v1')),   // the impatient second click
    s.generate('agent-2', material('v1')),
  ]);
  assert.equal(a.text, 'what the agent was asked to do');
  assert.deepEqual(b, a, 'the second caller was answered by the first caller\'s request');
  assert.equal(c.text, 'what the agent was asked to do');
  assert.equal(fetchImpl.calls.length, 2, 'two agents, two requests — never three');

  assert.deepEqual(await s.generate('agent-1', material('v1')), { text: 'what the agent was asked to do' });
  assert.equal(fetchImpl.calls.length, 2, 'and material that never changes is never paid for twice');
  s.stop();
});

test('generate() answers null on failure and on nothing to send, never a throw', async () => {
  const fetchImpl = stub(() => ({ ok: false, status: 500, json: async () => ({}) }));
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });

  assert.equal(await s.generate('agent-1', material('v1')), null, 'a dead model is a missing brief, not a 500 at the caller');
  assert.equal(await s.generate('agent-1', null), null);
  assert.equal(await s.generate('agent-1', { version: 'v1', text: '' }), null);
  assert.equal(fetchImpl.calls.length, 1, 'and nothing to summarize was never a request');
  s.stop();

  const after = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });
  after.stop();
  assert.equal(await after.generate('agent-1', material('v1')), null, 'a stopped summarizer generates nothing');
});

// A transport that throws before it ever suspends runs refresh()'s finally
// synchronously, so the slot is already released by the time the promise for it
// exists. Publishing it anyway would leave an id holding a settled promise no
// caller can ever be answered by.
test('a fetch that throws before it suspends releases the slot instead of wedging the id', async () => {
  // Deliberately NOT the async stub above, whose throw is only ever a rejected
  // promise: a plain function that throws runs refresh()'s catch and finally
  // synchronously, before the promise to publish for that id even exists.
  let n = 0;
  const fetchImpl = () => {
    if (++n === 1) throw new Error('ECONNREFUSED');
    return Promise.resolve(reply('second time lucky'));
  };
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });

    assert.equal(await s.generate('agent-1', material('v1')), null);
    mock.timers.tick(300_001);   // the cooldown that failure bought, waited out
    assert.deepEqual(await s.generate('agent-1', material('v1')), { text: 'second time lucky' },
      'the next click really is a new request, not an await on something long dead');
    s.stop();
  } finally { mock.timers.reset(); }
});

// /brief calls generate() straight off a click, so without this gate a reader
// tapping a dead button is an unbounded stream of paid requests — precisely the
// bound get() has always had, and the reason the cooldown exists at all.
test('generate() waits out the cooldown a failure bought, then really does retry', async () => {
  const fetchImpl = stub((n) => (n === 1 ? { ok: false, status: 500, json: async () => ({}) } : reply('worth the wait')));
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });

    assert.equal(await s.generate('ag', material('v1')), null, 'the model is down');
    assert.equal(fetchImpl.calls.length, 1);

    for (let i = 0; i < 5; i++) assert.equal(await s.generate('ag', material('v1')), null, 'an impatient reader keeps clicking');
    assert.equal(fetchImpl.calls.length, 1, 'and every one of those clicks was free');

    mock.timers.tick(299_999);
    assert.equal(await s.generate('ag', material('v1')), null);
    assert.equal(fetchImpl.calls.length, 1, 'a second short of the cooldown is still inside it');

    mock.timers.tick(2);
    assert.deepEqual(await s.generate('ag', material('v1')), { text: 'worth the wait' }, 'past it, the click pays again');
    assert.equal(fetchImpl.calls.length, 2, 'exactly one retry, not the six clicks that waited');
    s.stop();
  } finally { mock.timers.reset(); }
});

test('every failure is silent, keeps the old cache, and buys a cooldown', async () => {
  const cases = [
    ['a thrown fetch', () => { throw new Error('ECONNREFUSED'); }],
    ['a 500', () => ({ ok: false, status: 500, json: async () => ({}) })],
    ['a timeout', () => Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }))],
    ['an empty choice', () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })],
    ['a blank reply', () => reply('   ')],
    ['unparseable json', () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } })],
  ];

  for (const [name, answer] of cases) {
    const fetchImpl = stub(answer);
    const updated = [];
    // minIntervalMs 0 proves the 5-min cooldown is its own gate, not the cadence.
    const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl, onUpdate: (id) => updated.push(id) });

    assert.equal(s.get('sess-1', material('v1')), null, `${name}: no summary`);
    await settle();
    assert.equal(s.get('sess-1', material('v2')), null, `${name}: still no summary, and no throw`);
    await settle();
    assert.equal(fetchImpl.calls.length, 1, `${name}: the second attempt waits out the cooldown`);
    assert.deepEqual(updated, [], `${name}: nothing to push`);
    s.stop();
  }
});

test('a failure never destroys the summary that was already there', async () => {
  const fetchImpl = stub((n) => (n === 1 ? reply('first answer') : { ok: false, status: 429, json: async () => ({}) }));
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });

  s.get('sess-1', material('v1'));
  await settle();
  s.get('sess-1', material('v2'));
  await settle();

  assert.equal(s.get('sess-1', material('v2')).text, 'first answer', 'a stale line beats an empty card');
  assert.equal(fetchImpl.calls.length, 2);
  s.stop();
});

test('the API key never reaches a log line, a throw or a file', async () => {
  const dir = tmp();
  // The nastiest realistic leak: a transport that puts the whole request,
  // headers included, into the error it throws.
  const fetchImpl = stub((n) => {
    if (n === 1) return reply('summary one');
    throw new Error(`request failed: POST /chat/completions authorization=Bearer ${KEY}`);
  });

  // console.* is captured by name (so a console.log lands here, not on the
  // runner's stdout) and process.stderr.write covers the raw path plus any
  // unhandled-rejection warning the refresh might leak.
  const written = [];
  const spied = ['log', 'warn', 'error', 'debug', 'info', 'trace'];
  const orig = {};
  const stderr = process.stderr.write;
  const s = createSummarizer({ apiKey: KEY, dir, minIntervalMs: 0, fetchImpl });
  try {
    for (const k of spied) { orig[k] = console[k]; console[k] = (...a) => written.push(a.map(String).join(' ')); }
    process.stderr.write = (c) => { written.push(String(c)); return true; };

    s.get('sess-1', material('v1'));
    await settle();
    s.get('sess-1', material('v2'));   // this one throws with the key inside
    await settle();
  } finally {
    for (const k of spied) console[k] = orig[k];
    process.stderr.write = stderr;
  }

  assert.equal(fetchImpl.calls.length, 2, 'both requests really happened');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, `Bearer ${KEY}`,
    'the key IS sent — otherwise this test would pass on a module that never used it');
  assert.equal(written.join('\n').includes(KEY), false, 'nothing the module wrote carries the key');
  assert.equal(written.length, 0, 'a failing summary is silent, not noisy');

  for (const f of fs.readdirSync(dir)) {
    assert.equal(fs.readFileSync(path.join(dir, f), 'utf8').includes(KEY), false, `${f} carries the key`);
  }
  assert.equal(s.get('sess-1', material('v2')).text, 'summary one');
  s.stop();
});

// ---- redaction --------------------------------------------------------------
// A transcript carries whatever the human pasted, and people paste keys into
// prompts — there is one on this machine's real ~/.claude right now. Everything
// below asserts on the value that actually reaches the stub's request body,
// which is the last thing that happens before the socket.

// One line per family the redactor claims to know, each with the surrounding
// text that has to survive it.
const SECRETS = [
  ['Bearer header', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
  ['OpenAI-style sk-', 'sk-proj-Ab3d0f9KkLmNoPqRsTuVwXyZ012345'],
  ['OpenRouter sk-or', 'sk-or-v1-9f2a1c4e8b7d6a5f3e2c1b0a9d8e7f6a'],
  ['GitHub classic PAT', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['GitHub OAuth token', 'gho_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210'],
  ['GitHub fine-grained PAT', 'github_pat_11ABCDEFG0abcdefghij_KLMNOPqrstuvwx'],
  ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['AWS session key id', 'ASIAIOSFODNN7EXAMPLE'],
  // Built at runtime: a literal realistic xoxb- string trips GitHub push protection.
  ['Slack bot token', ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-')],
  ['JWT', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ['32-char hex run', '5d41402abc4b2a76b9719d911017c592'],
  ['40-char hex run (a git SHA is redacted too)', '9f2a1c4e8b7d6a5f3e2c1b0a9d8e7f6a5b4c3d2e'],
  ['base64-ish run', 'QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTBhYmNkZWY0Mg=='],
  ['keyed: password=', 'hunter2seven'],
  ['keyed: api_key:', 'nothing-shaped-like-a-secret'],
  ['keyed: authorization =>', 'plainwordvalue'],
  ['keyed: CREDENTIAL:', 'mixedCase99'],
];

// What a real material window is mostly made of, and what must come out the
// other side intact or the summary is worthless.
const INNOCENT = [
  '/Users/fredamaral/repos/LerianStudio/midaz/components/onboarding/main.go',
  '/srv/worktrees/live-context/lib/summarize.mjs',
  'feat/live-context',
  'aaaaaaaa-0000-4000-8000-000000000001',
  'reconcile the PSP statement against the ledger',
  'node --test test/*.test.mjs',
];

const MATERIAL_WITH_SECRETS = [
  `Title: rotating the gateway credential on ${INNOCENT[2]}`,
  `Last prompt: curl -H "Authorization: ${SECRETS[0][1]}" https://api.example.com/v1/ping`,
  'Recent tools (newest first):',
  `- Read ${INNOCENT[0]}`,
  `- Edit ${INNOCENT[1]}`,
  `- Bash export OPENAI_API_KEY=${SECRETS[1][1]}`,
  `- Bash export OPENROUTER_API_KEY=${SECRETS[2][1]}`,
  `- Bash gh auth login --with-token <<< ${SECRETS[3][1]}`,
  `- Bash echo ${SECRETS[4][1]} | gh auth login`,
  `- Bash git remote set-url origin https://${SECRETS[5][1]}@github.com/o/r`,
  `- Bash AWS_ACCESS_KEY_ID=${SECRETS[6][1]} aws s3 ls`,
  `- Bash AWS_ACCESS_KEY_ID=${SECRETS[7][1]} aws sts get-caller-identity`,
  `- Bash curl -d token=${SECRETS[8][1]} https://slack.com/api/auth.test`,
  `- Bash jwt=${SECRETS[9][1]}`,
  `- Bash echo -n x | md5sum   # ${SECRETS[10][1]}`,
  `- Bash git show ${SECRETS[11][1]}`,
  `- Bash echo ${SECRETS[12][1]} | base64 -d`,
  `- Bash psql "password=${SECRETS[13][1]} host=db"`,
  `- Read config.yml   api_key: ${SECRETS[14][1]}`,
  `- Edit client.js    authorization => ${SECRETS[15][1]}`,
  `- Edit vault.json   "CREDENTIAL": "${SECRETS[16][1]}"`,
  'Todos:',
  `- [in_progress] ${INNOCENT[4]}`,
  `- [pending] ${INNOCENT[5]} for ${INNOCENT[3]}`,
].join('\n');

test('every secret family is scrubbed out of the material before it reaches the wire', async () => {
  const fetchImpl = stub(reply('Rotacionando a credencial do gateway.'));
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });

  s.get('sess-1', material('v1', MATERIAL_WITH_SECRETS));
  await settle();

  assert.equal(fetchImpl.calls.length, 1, 'the request the assertions below judge really happened');
  const sent = fetchImpl.calls[0].body.messages[1].content;
  for (const [family, secret] of SECRETS) {
    assert.equal(sent.includes(secret), false, `${family} left this machine intact`);
  }
  assert.equal(/\[redacted\]/.test(sent), true, 'and the masks are actually in there');

  // A redactor that scrubs everything is not a redactor, it is a delete key.
  for (const kept of INNOCENT) {
    assert.equal(sent.includes(kept), true, `the summary lost something it needed: ${kept}`);
  }
  assert.match(sent, /^Title: rotating the gateway credential on feat\/live-context$/m);
  assert.match(sent, /^Recent tools \(newest first\):$/m);
  assert.match(sent, /^- \[in_progress\] reconcile the PSP statement against the ledger$/m);
  // the key NAMES survive; only their values die
  assert.match(sent, /OPENROUTER_API_KEY=\[redacted\]/);
  assert.match(sent, /api_key: \[redacted\]/);
  assert.match(sent, /"CREDENTIAL": "\[redacted\]"/);
  s.stop();
});

test('a model that echoes a secret back never gets it cached, logged or rendered', async () => {
  const dir = tmp();
  const LEAKED = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const fetchImpl = stub(reply(`Rotating the GitHub token ${LEAKED} in the deploy script.`));
  const s = createSummarizer({ apiKey: KEY, dir, minIntervalMs: 0, fetchImpl });

  s.get('sess-1', material('v1'));
  await settle();

  const hit = s.get('sess-1', material('v1'));
  assert.equal(hit.text, 'Rotating the GitHub token [redacted] in the deploy script.',
    'the reply is scrubbed on the way in, not just on the way out');
  assert.equal(s.history('sess-1')[0].text.includes(LEAKED), false, 'nor in the history the mini-log renders');
  for (const f of fs.readdirSync(dir)) {
    assert.equal(fs.readFileSync(path.join(dir, f), 'utf8').includes(LEAKED), false, `${f} persisted the echo`);
  }
  s.stop();
});

test('the cache survives a restart, so a daemon reboot is not a fleet of blank cards', async () => {
  const dir = tmp();
  const first = stub(reply('Reconciliando extratos do PSP.'));
  const a = createSummarizer({ apiKey: KEY, dir, minIntervalMs: 0, fetchImpl: first });
  a.get('sess-1', material('42:7'));
  await settle();
  a.stop();

  const second = stub(reply('should never be asked for'));
  const b = createSummarizer({ apiKey: KEY, dir, minIntervalMs: 0, fetchImpl: second });
  const hit = b.get('sess-1', material('42:7'));
  assert.equal(hit.text, 'Reconciliando extratos do PSP.', 'read back from summaries.json');
  await settle();
  assert.equal(second.calls.length, 0, 'the version it was summarized at survived too');

  assert.deepEqual(b.history('sess-1').map((e) => e.text), ['Reconciliando extratos do PSP.']);
  b.stop();
});

test('a corrupt cache file boots as an empty one', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'summaries.json'), '{"sess-1": {"text": "half writ');
  const fetchImpl = stub(reply('fresh'));
  const s = createSummarizer({ apiKey: KEY, dir, minIntervalMs: 0, fetchImpl });

  assert.equal(s.get('sess-1', material('v1')), null);
  await settle();
  assert.equal(s.get('sess-1', material('v1')).text, 'fresh', 'it regenerates instead of refusing to boot');
  s.stop();
});

test('history is oldest-first, per session, and pruned to 7 days on boot', async () => {
  const dir = tmp();
  const now = Date.now();
  const day = 86_400_000;
  const rows = [
    { at: now - 9 * day, sessionId: 'sess-1', text: 'ancient history' },
    { at: now - 3 * day, sessionId: 'sess-1', text: 'three days ago' },
    { at: now - 2 * day, sessionId: 'sess-2', text: 'another session' },
    { at: now - 1 * day, sessionId: 'sess-1', text: 'yesterday' },
  ];
  fs.writeFileSync(path.join(dir, 'summaries-log.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n{ this line is garbage\n');

  const fetchImpl = stub(reply('right now'));
  const s = createSummarizer({ apiKey: KEY, dir, minIntervalMs: 0, fetchImpl });

  assert.deepEqual(s.history('sess-1').map((e) => e.text), ['three days ago', 'yesterday']);
  assert.deepEqual(s.history('sess-1', now - 2 * day).map((e) => e.text), ['yesterday'], 'sinceMs windows the mini-log');
  assert.deepEqual(s.history('sess-2').map((e) => e.text), ['another session'], 'never another session\'s lines');
  assert.deepEqual(s.history('sess-nope'), []);

  const onDisk = fs.readFileSync(path.join(dir, 'summaries-log.jsonl'), 'utf8');
  assert.equal(onDisk.includes('ancient history'), false, 'the file itself was pruned, not just the view');
  assert.equal(onDisk.includes('this line is garbage'), false);

  // A new summary joins the tail, in both places.
  s.get('sess-1', material('v1'));
  await settle();
  assert.deepEqual(s.history('sess-1').map((e) => e.text), ['three days ago', 'yesterday', 'right now']);
  assert.match(fs.readFileSync(path.join(dir, 'summaries-log.jsonl'), 'utf8'), /right now/);
  s.stop();
});

test('stop() ends the summarizer: no further requests', async () => {
  const fetchImpl = stub(reply('working'));
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });
  s.stop();
  assert.equal(s.get('sess-1', material('v1')), null);
  await settle();
  assert.equal(fetchImpl.calls.length, 0);
});

test('material the adapter could not build is not a summary request', async () => {
  const fetchImpl = stub(reply('working'));
  const s = createSummarizer({ apiKey: KEY, dir: tmp(), minIntervalMs: 0, fetchImpl });
  s.get('sess-1', null);          // unknown session or an opencode id
  s.get('sess-1', { version: 'v1', text: '' });
  await settle();
  assert.equal(fetchImpl.calls.length, 0);
  s.stop();
});

test('a summarizer without a key is a construction error, not a 401 later', () => {
  assert.throws(() => createSummarizer({ dir: tmp() }), /apiKey/);
});

// The runtime test above can only see what escapes. An error built WITH the key
// inside and then swallowed leaves no trace to assert on — so the guarantee is
// made where it is visible: the key is interpolated in exactly one place, the
// request headers, and nowhere a message, a path or a file could be built.
test('the key is interpolated into the request headers and nowhere else', () => {
  const src = fs.readFileSync(new URL('../lib/summarize.mjs', import.meta.url), 'utf8');
  const uses = src.split('\n').filter((l) => /\bapiKey\b/.test(l));
  assert.equal(uses.length >= 3, true, 'the scan found the uses it is judging');
  for (const line of uses) {
    assert.match(line.trim(), /^apiKey,$|^if \(!apiKey\)|headers: \{[^}]*authorization/,
      `apiKey reaches a string that is not the auth header: ${line.trim()}`);
  }
});

// The daemon must be able to load this module before it knows anything else
// exists: no npm packages, and no import of the adapter it summarizes. The one
// local import allowed is the redactor, which is itself dependency-free — and
// which BOTH this module and the adapter import, so neither owns it.
test('the module imports node stdlib and the redactor, and nothing else', () => {
  const src = fs.readFileSync(new URL('../lib/summarize.mjs', import.meta.url), 'utf8');
  const specs = [...src.matchAll(/(?:^|\n)\s*import[^\n]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.equal(specs.length > 0, true, 'the scan found the imports it is judging');
  for (const spec of specs) assert.match(spec, /^node:|^\.\/redact\.mjs$/, `${spec} is neither stdlib nor the redactor`);
  assert.equal(/from\s+['"][^'"]*claude\.mjs['"]/.test(src), false);
  assert.equal(/OPENROUTER_API_KEY/.test(src), false, 'the key is passed in, never read from the environment here');

  const red = fs.readFileSync(new URL('../lib/redact.mjs', import.meta.url), 'utf8');
  assert.equal(/(?:^|\n)\s*import\b/.test(red), false, 'the redactor imports nothing at all');
});
