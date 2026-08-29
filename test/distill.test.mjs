// distill() turns a transcript into something a human reads back. Every fixture
// here is written into a tmpdir; the real ~/.claude is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { distill } from '../lib/distill.mjs';
import { rec } from './fixtures.mjs';

const T0 = Date.parse('2026-08-30T12:00:00.000Z');
const dirs = [];

function transcript(records, tail = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-distill-'));
  dirs.push(dir);
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '') + tail);
  return p;
}

/** Build with the shared record builders, with this session's defaults filled in. */
const r = (kind, o = {}) => rec[kind]({ sessionId: 's-1', cwd: '/work/repo', version: '2.1.251', gitBranch: 'develop', ...o });

async function run(p, meta = {}) {
  let md = '';
  for await (const chunk of distill(p, meta)) {
    assert.equal(typeof chunk, 'string', 'distill yields markdown chunks');
    md += chunk;
  }
  return md;
}

const count = (md, re) => (md.match(re) || []).length;

test.after(() => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

test('the header carries what the session knows, and nothing it does not', async () => {
  const p = transcript([r('assistantText', { text: 'hi', at: T0 })]);

  const full = await run(p, {
    id: 's-1', title: 'Ledger reconciliation', cwd: '/work/br-sfn', gitBranch: 'feat/pix',
    model: 'claude-opus-5[1m]', cost: { totalUSD: 1.2345, linesAdded: 120, linesRemoved: 8 },
  });
  assert.match(full, /^# Ledger reconciliation\n/);
  assert.match(full, /\*\*cwd\*\* `\/work\/br-sfn`/);
  assert.match(full, /\*\*branch\*\* `feat\/pix`/);
  assert.match(full, /\*\*model\*\* claude-opus-5\[1m\]/);
  assert.match(full, /\*\*cost\*\* \$1\.23 \(\+120 \/ -8 lines\)/);

  // An untitled session still gets an h1, and absent fields print nothing at all.
  const bare = await run(p, { id: 'abc-123' });
  assert.match(bare, /^# Session abc-123\n/);
  assert.doesNotMatch(bare, /cwd|model|cost|branch/);
});

test('a transcript reads back as turns of prompt, prose and tool one-liners', async () => {
  const p = transcript([
    r('userPrompt', { text: 'fix the ledger', at: T0 }),
    r('assistantText', { text: 'Looking at the balances.', at: T0 + 100 }),
    r('assistantTool', { name: 'Bash', toolId: 'toolu_a', input: { command: 'make test' }, at: T0 + 200 }),
    r('toolResult', { toolId: 'toolu_a', at: T0 + 1700 }),
    r('turn', { at: T0 + 2000 }),
    r('userPrompt', { text: 'now ship it', at: T0 + 3000 }),
    r('assistantTool', { name: 'Read', toolId: 'toolu_b', input: { file_path: '/work/repo/main.go' }, at: T0 + 3100 }),
    r('toolResult', { toolId: 'toolu_b', at: T0 + 3400 }),
    r('turn', { at: T0 + 4000 }),
  ]);

  const md = await run(p, { id: 's-1' });

  assert.equal(count(md, /^## Turn \d+$/gm), 2, 'turn_duration is what closes a turn');
  assert.match(md, /## Turn 1[\s\S]*## Turn 2/);
  assert.match(md, /```\nfix the ledger\n```/, 'a prompt is fenced verbatim');
  assert.match(md, /Looking at the balances\./);
  assert.match(md, /- `Bash` make test _\(1\.5s\)_/, 'duration comes from the result that closes the call');
  assert.match(md, /- `Read` \/work\/repo\/main\.go _\(300ms\)_/);
  assert.equal(md.indexOf('now ship it') > md.indexOf('## Turn 2'), true, 'turn 2 owns its own prompt');
});

test('thinking never reaches the markdown', async () => {
  const p = transcript([
    {
      type: 'assistant', uuid: 'u-think', timestamp: new Date(T0).toISOString(), sessionId: 's-1',
      message: {
        role: 'assistant', model: 'claude-opus-5[1m]', content: [
          { type: 'thinking', thinking: 'SECRET REASONING the user must not read back', signature: 'sig' },
          { type: 'redacted_thinking', data: 'REDACTED PAYLOAD' },
          { type: 'text', text: 'the visible answer' },
        ],
      },
    },
    r('turn', { at: T0 + 10 }),
  ]);

  const md = await run(p, { id: 's-1' });
  assert.match(md, /the visible answer/);
  assert.doesNotMatch(md, /SECRET REASONING/);
  assert.doesNotMatch(md, /REDACTED PAYLOAD/);
  assert.doesNotMatch(md, /thinking/);
});

test('a pasted dump is cut down and says where it was cut', async () => {
  const paste = 'LEDGER DUMP\n' + 'z'.repeat(9000);
  const p = transcript([r('userPrompt', { text: paste, at: T0 }), r('turn', { at: T0 + 10 })]);

  const md = await run(p, { id: 's-1' });
  assert.match(md, /LEDGER DUMP/, 'the head of the paste is what identifies it');
  assert.match(md, /… \[truncated 5012 chars\]/);
  assert.equal(md.length < paste.length, true, 'the dump is not carried whole into the export');
  assert.equal(/z{9000}/.test(md), false);
});

test('a prompt containing a code fence does not break out of its own fence', async () => {
  const p = transcript([r('userPrompt', { text: 'run this:\n```sh\nmake test\n```\nthanks', at: T0 })]);

  const md = await run(p, { id: 's-1' });
  const body = md.slice(md.indexOf('### Prompt'));
  const open = body.match(/^`{4,}$/m);
  assert.notEqual(open, null, 'a fence longer than the backticks inside it');
  assert.equal(count(body, new RegExp(`^${open[0]}$`, 'gm')), 2, 'opens and closes exactly once');
});

test('a subagent spawn is reported by description, not as Task plumbing', async () => {
  const p = transcript([
    r('assistantTool', { name: 'Task', toolId: 'toolu_t', input: { description: 'find callers' }, at: T0 }),
    r('agentResult', { agentId: 'a0000001', description: 'find callers', agentType: 'Explore', toolId: 'toolu_t', at: T0 + 500 }),
    r('turn', { at: T0 + 900 }),
  ]);

  const md = await run(p, { id: 's-1' });
  assert.match(md, /- spawned \*\*Explore\*\* — find callers/);
  assert.doesNotMatch(md, /`Task`/, 'the Task call and the spawn it produced are one event, not two');
});

test('a compact boundary marks the seam without ending the turn', async () => {
  const p = transcript([
    r('userPrompt', { text: 'before', at: T0 }),
    r('compactBoundary', { at: T0 + 100 }),
    r('assistantText', { text: 'after', at: T0 + 200 }),
    r('turn', { at: T0 + 300 }),
  ]);

  const md = await run(p, { id: 's-1' });
  assert.match(md, /_context compacted_/);
  assert.equal(count(md, /^## Turn \d+$/gm), 1, 'compaction is a graft, not a turn');
  assert.match(md, /before[\s\S]*context compacted[\s\S]*after/);
});

test('a tool still in flight when the turn ends is reported without a duration', async () => {
  const p = transcript([
    r('assistantTool', { name: 'Bash', toolId: 'toolu_x', input: { command: 'sleep 600' }, at: T0 }),
    r('turn', { at: T0 + 1000 }),
    r('assistantTool', { name: 'Grep', toolId: 'toolu_y', input: { pattern: 'never answered' }, at: T0 + 2000 }),
  ]);

  const md = await run(p, { id: 's-1' });
  assert.match(md, /- `Bash` sleep 600\n/, 'no duration is invented for a call that never returned');
  assert.match(md, /- `Grep` never answered\n/, 'end of file flushes what the last turn left open');
});

// Transcripts are appended to while they are read, so the last line is routinely
// half-written. The tailer refuses to advance past a partial line; distill drops it.
test('a half-written final line is dropped and everything before it survives', async () => {
  const p = transcript([
    r('userPrompt', { text: 'fix the ledger', at: T0 }),
    r('assistantText', { text: 'first answer', at: T0 + 100 }),
    r('turn', { at: T0 + 200 }),
  ], '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"HALF WRITT');

  const md = await run(p, { id: 's-1' });
  assert.match(md, /fix the ledger/);
  assert.match(md, /first answer/);
  assert.doesNotMatch(md, /HALF WRITT/, 'a truncated record is not half-reported');
});

// 60MB transcripts exist. Peak RSS is not assertable here, but "never read the
// file whole" is: poison readFileSync and the whole-file implementation dies.
test('a 5MB transcript distills without ever reading the file whole', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-distill-big-'));
  dirs.push(dir);
  const p = path.join(dir, 'big.jsonl');
  const filler = 'x'.repeat(10_000);
  for (let turn = 0; turn < 25; turn++) {
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push(r('assistantText', { text: `${filler} block ${turn}-${i}`, at: T0 + turn * 1000 + i }));
    lines.push(r('turn', { at: T0 + turn * 1000 + 999 }));
    fs.appendFileSync(p, lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
  }
  assert.equal(fs.statSync(p).size > 5_000_000, true, 'the fixture is big enough to matter');

  const readFileSync = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('distill must not read a transcript whole'); };
  let md;
  try { md = await run(p, { id: 's-1' }); } finally { fs.readFileSync = readFileSync; }

  assert.equal(count(md, /^## Turn \d+$/gm), 25);
  assert.match(md, /block 24-19/, 'the last record of the last turn is still in the export');
});

test('a transcript that is not there yields a header and stops', async () => {
  const md = await run(path.join(os.tmpdir(), 'agenttrail-distill-missing', 'nope.jsonl'), { id: 'gone' });
  assert.equal(md, '# Session gone\n\n');
});
