import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createClaudeAdapter, sameDomain, selfPidDomain } from '../lib/claude.mjs';
import { makeFixture, deadPid, rec } from './fixtures.mjs';

/** Build fixture + adapter, run body, always clean up. */
async function withFx(body, adapterOpts = {}) {
  const fx = makeFixture();
  let a = null;
  try {
    await body(fx, (extra = {}) => {
      a = createClaudeAdapter(fx.opts({ ...adapterOpts, ...extra }));
      return a;
    });
  } finally {
    a?.stop();
    fx.cleanup();
  }
}

const byId = (list, id) => list.find((s) => s.id === id);

test('liveness: busy, idle and ended come from the pid file plus transcript mtime', async () => {
  await withFx(async (fx, start) => {
    const busy = fx.session({ name: 'busy-one' });
    busy.add('turn', {});                       // transcript touched just now

    const idle = fx.session({ name: 'idle-one' });
    idle.add('turn', {});
    idle.touch(120_000);                        // last touched 2 min ago

    const gone = fx.session({ name: 'dead-one' });
    gone.add('turn', {});
    gone.touch(120_000);
    gone.kill();                                // pid file stays, process is gone

    const a = start();
    a.refresh();
    const s = a.sessions();

    assert.equal(byId(s, busy.id).status, 'busy');
    assert.equal(byId(s, idle.id).status, 'idle');
    assert.equal(byId(s, gone.id).status, 'ended');
    assert.equal(byId(s, gone.id).pid, gone.pid, 'ended session keeps its pid');
    assert.equal(byId(s, busy.id).tmux, 'sess:@1.%1');
  });
});

test('liveness: an explicit shell status passes through, and accounts are labelled', async () => {
  await withFx(async (fx, start) => {
    const sh = fx.session({ name: 'shelling' });
    sh.live({ status: 'shell' });
    const acct = fx.session({ account: '005-galadriel', name: 'other-acct' });
    acct.add('turn', {});

    const a = start();
    a.refresh();
    const s = a.sessions();

    assert.equal(byId(s, sh.id).status, 'shell');
    assert.equal(byId(s, sh.id).account, null);
    assert.equal(byId(s, acct.id).account, '005-galadriel');
  });
});

test('tail: a half-written trailing line is held back, then read once completed', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('turn', { durationMs: 111 });

    const a = start();
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).turns, 1);

    // Split one record across two appends, mid-JSON, with no newline.
    const half = JSON.stringify({
      type: 'system', subtype: 'turn_duration', durationMs: 222, messageCount: 2,
      sessionId: s.id, cwd: s.cwd, timestamp: new Date().toISOString(),
    });
    const cut = Math.floor(half.length / 2);
    s.raw(half.slice(0, cut));

    a.refresh();
    assert.equal(byId(a.sessions(), s.id).turns, 1, 'partial line must not be parsed');

    s.raw(half.slice(cut) + '\n');
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).turns, 2, 'completed line is picked up exactly once');

    a.refresh();
    assert.equal(byId(a.sessions(), s.id).turns, 2, 'no double counting on a re-scan');
  });
});

test('restart: state is rebuilt from the transcript without re-announcing it', async () => {
  const fx = makeFixture();
  const offsetOf = (p) => JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'offsets.json'), 'utf8'))[p];
  try {
    const s = fx.session({ name: 'long-runner' });
    s.add('aiTitle', { title: 'ledger repair' })
      .add('turn', {}).add('turn', {})
      .add('costState', { totalCostUSD: 3.5, totalLinesAdded: 40, totalLinesRemoved: 4 })
      .add('prLink', { prNumber: 21 })
      .add('assistantTool', { name: 'Bash', input: { command: 'go test ./...' } });

    const a1 = createClaudeAdapter(fx.opts());
    a1.refresh();
    const before = byId(a1.sessions(), s.id);
    const journalBefore = a1.digestEvents(0);
    a1.stop();

    const eof = fs.statSync(s.transcriptPath).size;
    assert.equal(offsetOf(s.transcriptPath), eof, 'the first run consumed the whole file');
    assert.ok(before.turns === 2 && before.title && before.cost && before.prs.length === 1);

    const a2 = createClaudeAdapter(fx.opts());
    a2.refresh();
    const after = byId(a2.sessions(), s.id);

    // Everything a card shows lives ONLY in the transcript. Resuming at EOF used
    // to leave a running session blank until it happened to speak again.
    assert.equal(after.title, before.title, 'title survives the restart');
    assert.equal(after.turns, before.turns, 'so does the turn count');
    assert.deepEqual(after.cost, before.cost);
    assert.deepEqual(after.prs, before.prs);
    assert.equal(after.model, before.model);
    assert.equal(after.currentTool?.name, 'Bash', 'and the tool still in flight');

    // Rebuilding state must not re-announce a single byte of it.
    assert.deepEqual(a2.digestEvents(0), journalBefore, 'the replay journals nothing twice');
    assert.equal(offsetOf(s.transcriptPath), eof, 'and the offset lands back at EOF');

    // Records that arrive AFTER the restart are still announced, exactly once.
    s.add('prLink', { prNumber: 22 }).add('turn', {});
    a2.refresh();
    a2.refresh();
    const v = byId(a2.sessions(), s.id);
    assert.equal(v.turns, 3, 'the rebuilt count keeps counting');
    assert.deepEqual(a2.digestEvents(0).filter((e) => e.kind === 'pr').map((e) => e.data.number), [21, 22]);
    assert.equal(a2.digestEvents(0).filter((e) => e.kind === 'turn').length, 3);
    a2.stop();
  } finally { fx.cleanup(); }
});

test('restart: a session that was not running is still not re-announced later', async () => {
  const fx = makeFixture();
  const offsets = () => JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'offsets.json'), 'utf8'));
  let a3 = null;
  try {
    const s = fx.session({ name: 'comes-and-goes' });
    s.add('turn', {}).add('prLink', { prNumber: 31 });

    const a1 = createClaudeAdapter(fx.opts());
    a1.refresh();
    const eof = fs.statSync(s.transcriptPath).size;
    assert.equal(offsets()[s.transcriptPath], eof);
    a1.stop();

    // It exits. A daemon run now boots with the session gone: nothing tails that
    // transcript, so its mark has to be carried through untouched.
    fs.rmSync(s.pidFile);
    const a2 = createClaudeAdapter(fx.opts());
    a2.refresh();
    a2.stop();
    assert.equal(offsets()[s.transcriptPath], eof, 'the mark of an absent session survives');

    // Weeks later, --resume brings the same sessionId and transcript back.
    s.live({ startedAt: Date.now() });
    a3 = createClaudeAdapter(fx.opts());
    a3.refresh();
    const v = byId(a3.sessions(), s.id);
    assert.equal(v.turns, 1, 'state is rebuilt from the transcript');
    assert.deepEqual(v.prs.map((p) => p.number), [31]);
    assert.equal(a3.digestEvents(0).filter((e) => e.kind === 'pr').length, 1,
      'and the PR it already announced is not announced again');
  } finally { a3?.stop(); fx.cleanup(); }
});

test('restart: a run killed mid-replay does not lower the mark and re-announce the gap', async () => {
  const fx = makeFixture();
  const mark = () => JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'offsets.json'), 'utf8'))[s.transcriptPath];
  let s, a3 = null;
  try {
    s = fx.session({ name: 'big-one' });
    for (const n of [41, 42, 43, 44]) s.add('prLink', { prNumber: n });

    const a1 = createClaudeAdapter(fx.opts());
    a1.refresh();
    const eof = fs.statSync(s.transcriptPath).size;
    assert.equal(a1.digestEvents(0).filter((e) => e.kind === 'pr').length, 4);
    a1.stop();
    assert.equal(mark(), eof);

    // A real boot replays a large transcript over several passes. Stop after one.
    const a2 = createClaudeAdapter(fx.opts({ maxDelta: 300 }));
    a2.refresh();
    assert.ok(byId(a2.sessions(), s.id).prs.length < 4, 'the fixture must really stop mid-file');
    a2.stop();
    assert.equal(mark(), eof, 'a half-finished replay must not lower the announced mark');

    // Whatever it did not reach is still announced-already, not new.
    a3 = createClaudeAdapter(fx.opts());
    a3.refresh();
    assert.deepEqual(byId(a3.sessions(), s.id).prs.map((p) => p.number), [41, 42, 43, 44]);
    assert.equal(a3.digestEvents(0).filter((e) => e.kind === 'pr').length, 4,
      'the gap the killed run never replayed is not announced a second time');
  } finally { a3?.stop(); fx.cleanup(); }
});

test('first boot: a pre-existing transcript is read into state, not skipped', async () => {
  await withFx(async (fx, start) => {
    // Nothing has ever watched this machine: no offsets, no journal, and every
    // record predates the daemon.
    const s = fx.session({ name: 'was-here-first' });
    s.add('aiTitle', { title: 'yesterday work' })
      .add('turn', {}).add('turn', {}).add('turn', {})
      .add('costState', { totalCostUSD: 4.25, totalLinesAdded: 7, totalLinesRemoved: 1 })
      .add('prLink', { prNumber: 9 });

    const a = start();
    a.refresh();
    const v = byId(a.sessions(), s.id);

    assert.equal(v.title, 'yesterday work');
    assert.equal(v.turns, 3);
    assert.deepEqual(v.cost, { totalUSD: 4.25, linesAdded: 7, linesRemoved: 1 });
    assert.equal(v.model, null, 'nothing invented: this transcript has no assistant record');
    assert.deepEqual(v.prs.map((p) => p.number), [9]);
  });
});

test('tail: bytes consumed are persisted even when only ignored records arrived', async () => {
  await withFx(async (fx, start) => {
    // Everything the session already has is minutes old and its status is pinned
    // busy by the pid file, so the ignored record is the ONLY thing that can
    // move anything — no status flip, no 1ms-granularity coin flip.
    const s = fx.session({ pidPatch: { status: 'busy', updatedAt: Date.now() - 300_000 } });
    s.add('turn', { at: Date.now() - 300_000 });
    s.touch(120_000);

    const a = start();
    a.refresh();                 // settles the status, so the next pass reports no movement
    assert.equal(a.refresh(), false, 'a settled session does not move on its own');

    s.add('noise', { text: 'nothing the adapter cares about' });
    // The record is dropped, but the session's clock moved — and a partial SSE
    // tick filters on lastEventAt, so staying silent here strands the dashboard
    // on a frozen "elapsed" until the next record the adapter happens to parse.
    assert.equal(a.refresh(), true, 'an advanced lastEventAt is reportable movement');
    assert.equal(byId(a.sessions(), s.id).status, 'busy', 'and nothing else changed');
    assert.equal(a.refresh(), false, 'a pass that changed nothing stays quiet');

    const before = byId(a.sessions(), s.id).turns;
    const saved = JSON.parse(fs.readFileSync(path.join(fx.stateDir, 'offsets.json'), 'utf8'));
    assert.equal(saved[s.transcriptPath], fs.statSync(s.transcriptPath).size,
      'ignored records still move the offset, so a restart must not re-read them');
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).turns, before,
      'and nothing in the skipped record is applied twice');
  });
});

test('tail: a transcript replaced by a shorter one is re-read from the start', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('aiTitle', { title: 'before' }).add('turn', {}).add('turn', {});

    const a = start();
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).title, 'before');

    // Rewrite the file shorter than the stored offset.
    fs.writeFileSync(s.transcriptPath, '');
    s.add('aiTitle', { title: 'after' });
    a.refresh();

    assert.equal(byId(a.sessions(), s.id).title, 'after',
      'a stale offset past EOF must reset instead of stranding the reader');
  });
});

test('index: a session whose project dir appeared after boot still resolves', async () => {
  await withFx(async (fx, start) => {
    const known = fx.session();
    known.add('turn', {});

    const a = start();
    a.refresh();                          // index built without the session below

    const late = fx.session({ cwd: '/work/brand-new-repo' });
    late.add('aiTitle', { title: 'late arrival' }).add('turn', {});
    a.refresh();

    const v = byId(a.sessions(), late.id);
    assert.ok(v, 'the late session must be present');
    assert.equal(v.transcriptPath, late.transcriptPath, 'the index refreshes on a miss');
    assert.equal(v.title, 'late arrival');
  });
});

test('records: tools, todos, PRs and turn counting; noise and compaction are ignored', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('noise', { text: 'y'.repeat(50_000) });
    s.add('assistantTool', { name: 'Bash', input: { command: 'go test ./...', description: 'run tests' } });
    s.add('turn', {});
    s.add('assistantTool', {
      name: 'TodoWrite',
      input: { todos: [{ content: 'ship it', status: 'in_progress', activeForm: 'Shipping' }] },
    });
    s.add('assistantTool', { name: 'Read', input: { file_path: '/work/repo-1/main.go' } });
    s.add('compactBoundary', {});
    s.add('prLink', { prNumber: 7 });
    s.add('prLink', { prNumber: 7 });          // duplicate must collapse

    const a = start();
    a.refresh();
    const v = byId(a.sessions(), s.id);

    assert.equal(v.turns, 1, 'compact_boundary is a graft point, not a turn or an end');
    assert.notEqual(v.status, 'ended');
    assert.equal(v.currentTool.name, 'Read');
    assert.equal(v.currentTool.detail, '/work/repo-1/main.go');
    // Only Bash ever got an ending here — the turn boundary closed it. TodoWrite
    // and Read were issued together and neither result has landed, so they are
    // both still in flight and neither is "recent" yet.
    assert.deepEqual(v.recentTools.map((t) => t.name), ['Bash']);
    assert.equal(v.recentTools[0].detail, 'go test ./...');
    assert.deepEqual(v.todos, [{ content: 'ship it', status: 'in_progress' }]);
    assert.deepEqual(v.prs, [{ number: 7, url: 'https://github.com/acme/repo/pull/7', repo: 'acme/repo' }]);
    assert.equal(v.model, 'claude-opus-5[1m]');
    assert.equal(v.gitBranch, 'develop');
  });
});

test('currentTool: a tool_use with no result yet is the current tool, cleared when it lands', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('assistantTool', { name: 'Bash', input: { command: 'go test ./...' }, toolId: 'toolu_a' });

    const a = start();
    a.refresh();
    let v = byId(a.sessions(), s.id);
    assert.equal(v.currentTool?.name, 'Bash', 'an unanswered tool_use is a tool in flight');
    assert.equal(v.currentTool.detail, 'go test ./...');
    assert.equal(v.recentTools.length, 0, 'and it is not recent while it is still running');

    s.add('toolResult', { toolId: 'toolu_a', at: Date.now() + 1500 });
    a.refresh();
    v = byId(a.sessions(), s.id);
    assert.equal(v.currentTool, null, 'the matching result ends it');
    assert.deepEqual(v.recentTools.map((t) => t.name), ['Bash']);
    assert.ok(v.recentTools[0].ms > 0, 'and it is filed with how long it took');
  });
});

test('currentTool: parallel tool calls close by name, not by whichever was newest', async () => {
  await withFx(async (fx, start) => {
    // Three tools issued in one turn is ordinary — real transcripts on mordor do
    // it constantly. Their results come back one record each, in any order.
    // Treating any result as "the current one finished" left a demonstrably busy
    // session reporting no current tool at all.
    const s = fx.session();
    s.add('assistantTool', { name: 'Read', input: { file_path: '/work/a.go' }, toolId: 'toolu_1' })
      .add('assistantTool', { name: 'Grep', input: { pattern: 'ledger' }, toolId: 'toolu_2' })
      .add('assistantTool', { name: 'Bash', input: { command: 'make test' }, toolId: 'toolu_3' });

    const a = start();
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).currentTool?.name, 'Bash', 'the newest unmatched one');

    s.add('toolResult', { toolId: 'toolu_1' });      // the OLDEST finishes first
    a.refresh();
    let v = byId(a.sessions(), s.id);
    assert.equal(v.currentTool?.name, 'Bash', 'another tool finishing must not blank the current one');
    assert.deepEqual(v.recentTools.map((t) => t.name), ['Read']);

    s.add('toolResult', { toolId: 'toolu_3' });      // the newest finishes next
    a.refresh();
    v = byId(a.sessions(), s.id);
    assert.equal(v.currentTool?.name, 'Grep', 'the one still unanswered takes over');

    s.add('toolResult', { toolId: 'toolu_2' });
    a.refresh();
    v = byId(a.sessions(), s.id);
    assert.equal(v.currentTool, null);
    assert.deepEqual(v.recentTools.map((t) => t.name), ['Grep', 'Bash', 'Read']);
  });
});

test('currentTool: an unmatched tool_use is closed by the turn boundary', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('assistantTool', { name: 'Read', input: { file_path: '/work/a.go' }, toolId: 'toolu_1' })
      .add('assistantTool', { name: 'Bash', input: { command: 'make' }, toolId: 'toolu_2' })
      .add('turn', {});                       // the turn ends; nothing can still be running

    const a = start();
    a.refresh();
    const v = byId(a.sessions(), s.id);
    assert.equal(v.currentTool, null, 'a finished turn has no tool in flight');
    assert.deepEqual(v.recentTools.map((t) => t.name), ['Bash', 'Read'], 'newest first');
  });
});

test('currentTool: in-flight calls are a window, not an unbounded log', async () => {
  await withFx(async (fx, start) => {
    // The turn boundary normally sweeps these (3 at once is the real-world peak).
    // A truncated or interleaved transcript that never closes a turn must not
    // grow the daemon's memory one entry per tool call, forever.
    const s = fx.session();
    for (let i = 0; i < 200; i++) s.add('assistantTool', { name: `T${i}`, toolId: `toolu_${i}` });

    const a = start();
    a.refresh();
    const v = byId(a.sessions(), s.id);
    assert.equal(v.currentTool?.name, 'T199', 'the newest call is still the current one');
    assert.equal(v.recentTools.length, 8, 'the oldest fall out through recentTools, capped');
    // The very first call is long gone from both.
    assert.ok(!v.recentTools.some((t) => t.name === 'T0'));
  });
});

test('currentTool: a result identified only by the assistant record uuid still matches', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('assistantTool', { name: 'Bash', input: { command: 'ls' }, toolId: 'toolu_x', uuid: 'asst-uuid-1' });

    const a = start();
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).currentTool?.name, 'Bash');

    // No tool_use_id on the block — only sourceToolAssistantUUID.
    s.add('toolResult', { assistantUuid: 'asst-uuid-1' });
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).currentTool, null, 'sourceToolAssistantUUID closes it too');
  });
});

test('currentTool: spawning a subagent does not pin Task as the current tool', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('assistantTool', { name: 'Task', input: { description: 'explore the wiring' }, toolId: 'toolu_task' });
    // The spawn result carries the agent bookkeeping AND the Task tool's result.
    // Returning early on the agent branch used to leave Task "running" for the
    // rest of the turn, while the agent itself ran for minutes in the tree.
    s.add('agentResult', { agentId: 'a1', status: 'async_launched', toolId: 'toolu_task' });

    const a = start();
    a.refresh();
    const v = byId(a.sessions(), s.id);
    assert.equal(v.currentTool, null, 'the launch answered the Task call');
    assert.deepEqual(v.recentTools.map((t) => t.name), ['Task']);
  });
});

// ~/.claude syncs between machines, so sessions/<pid>.json can describe a pid on
// a DIFFERENT host — where the same number belongs to whatever local process
// happens to hold it, and a session that ended on the laptop yesterday shows up
// here as busy. Real records carry `pidDomain`, measured on mordor 2026-08-30:
//   linux:<contents of /etc/machine-id>:pid:[<pid-namespace-inode>]
const OTHER_OS = process.platform === 'linux' ? 'darwin' : 'linux';

test('liveness: a record stamped with another machine pid domain is not alive here', async () => {
  await withFx(async (fx, start) => {
    const mine = fx.session({ name: 'this-machine' });
    mine.add('turn', {});

    const otherOs = fx.session({ name: 'the-laptop' });
    otherOs.add('turn', {});
    otherOs.live({ pidDomain: `${OTHER_OS}:e5a1b2c3d4:pid:[4026531836]` });

    const a = start();
    a.refresh();
    const v = a.sessions();

    assert.equal(byId(v, otherOs.id).status, 'ended', 'a foreign pid number proves nothing here');
    assert.notEqual(byId(v, mine.id).status, 'ended', 'and a local session is untouched');
  });
});

test('liveness: a same-OS record from a different machine is foreign too', {
  skip: selfPidDomain() ? false : 'this host cannot establish its own pid domain',
}, async () => {
  await withFx(async (fx, start) => {
    const twin = fx.session({ name: 'the-other-devbox' });
    twin.add('turn', {});
    // Same OS, same shape, different machine — the ordinary two-Linux-boxes case.
    twin.live({ pidDomain: `${process.platform}:ffffffffffffffffffffffffffffffff:pid:[4026531836]` });

    const a = start();
    a.refresh();
    assert.equal(byId(a.sessions(), twin.id).status, 'ended');
  });
});

test('liveness: our own domain and a record with no domain at all are both trusted', async () => {
  await withFx(async (fx, start) => {
    const stamped = fx.session({ name: 'stamped' });
    stamped.add('turn', {});
    const domain = selfPidDomain();
    if (domain) stamped.live({ pidDomain: domain });

    // Older Claude Code writes no pidDomain — that must not read as foreign.
    const bare = fx.session({ name: 'no-domain' });
    bare.add('turn', {});

    const a = start();
    a.refresh();
    const v = a.sessions();

    assert.notEqual(byId(v, stamped.id).status, 'ended', 'our own domain is alive');
    assert.notEqual(byId(v, bare.id).status, 'ended', 'an unstamped record keeps the old behaviour');
    assert.equal(sameDomain(undefined), true, 'nothing claimed, nothing judged');
    assert.equal(sameDomain('nonsense-without-colons'), true, 'an unknown shape is not judged either');
    if (domain) assert.equal(sameDomain(domain), true, 'and this host recognises itself');
  });
});

test('title: last write wins across ai-title, custom-title and agent-name', async () => {
  await withFx(async (fx, start) => {
    const noName = fx.session();               // pid file carries no .name
    noName.add('aiTitle', { title: 'first' })
      .add('customTitle', { title: 'second' })
      .add('agentName', { title: 'third' });

    const named = fx.session({ name: 'br-sfn-32' });
    named.add('aiTitle', { title: 'ignored for name' });

    const a = start();
    a.refresh();
    const s = a.sessions();

    assert.equal(byId(s, noName.id).title, 'third');
    assert.equal(byId(s, noName.id).name, 'third', 'name falls back to the title');
    assert.equal(byId(s, named.id).title, 'ignored for name');
    assert.equal(byId(s, named.id).name, 'br-sfn-32', 'the pid file name outranks the title');
  });
});

test('lastPrompt: the newest last-prompt record wins, capped, and survives a restart', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const long = 'p'.repeat(400);
    s.add('turn', { at: Date.now() - 120_000 })
      .add('lastPrompt', { text: 'primeira pergunta' })
      .add('lastPrompt', {})                        // real records sometimes carry no text
      .add('lastPrompt', { text: long });

    const bare = fx.session();
    bare.add('turn', {});

    const a = start();
    a.refresh();
    const v = byId(a.sessions(), s.id);

    assert.equal(v.lastPrompt.text.length, 280, 'the text is capped at 280 chars');
    assert.equal(v.lastPrompt.text, long.slice(0, 280), 'last write wins');
    assert.ok(v.lastPrompt.at > 0, 'a record with no timestamp still gets the session clock');
    assert.ok(v.lastPrompt.at <= Date.now());
    assert.equal(byId(a.sessions(), bare.id).lastPrompt, null, 'no prompt record means null');

    // A pasted prompt is far past the sniff threshold: the allowlist must carry it.
    s.add('lastPrompt', { text: 'LEDGER ' + 'z'.repeat(60_000) });
    a.refresh();
    assert.match(byId(a.sessions(), s.id).lastPrompt.text, /^LEDGER z+$/,
      'a big last-prompt line is not skipped by the big-line sniff');
  });
});

test('canonical: worktree, home and plain repo cwds each get a stable name', async () => {
  await withFx(async (fx, start) => {
    const plain = fx.session({ cwd: '/work/lerianstudio/matcher', gitBranch: 'feat/dedupe' });
    plain.add('turn', {});
    const srvWt = fx.session({ cwd: '/srv/worktrees/live-context', gitBranch: 'feat/live-context' });
    srvWt.add('turn', {});
    const deepWt = fx.session({ cwd: '/srv/worktrees/live-context/lib', gitBranch: 'HEAD' });
    deepWt.add('turn', {});
    const claudeWt = fx.session({ cwd: '/work/repo/.claude/worktrees/wave-3/bin' });
    claudeWt.add('turn', {});
    const atHome = fx.session({ cwd: '/fake/home' });
    atHome.add('turn', {});

    const a = start({ home: '/fake/home' });
    a.refresh();
    const v = a.sessions();
    const c = (h) => byId(v, h.id).canonical;

    assert.deepEqual(c(plain), { repo: 'matcher', branch: 'feat/dedupe' });
    assert.deepEqual(c(srvWt), { repo: 'live-context', branch: 'feat/live-context' });
    assert.deepEqual(c(deepWt), { repo: 'live-context', branch: 'HEAD' },
      'a cwd INSIDE a worktree still names the worktree, and HEAD passes through');
    assert.deepEqual(c(claudeWt), { repo: 'wave-3', branch: 'develop' });
    assert.deepEqual(c(atHome), { repo: 'home', branch: 'develop' });
    assert.equal(byId(v, plain.id).name, plain.id.slice(0, 8),
      'canonical is additive: the birth name is left exactly as it was');
  });
});

test('cost: the last cost-state record populates cost', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const bare = fx.session();
    s.add('costState', { totalCostUSD: 1.5, totalLinesAdded: 10, totalLinesRemoved: 2 });
    s.add('costState', { totalCostUSD: 939.4295384999997, totalLinesAdded: 11467, totalLinesRemoved: 1350 });

    const a = start();
    a.refresh();

    assert.deepEqual(byId(a.sessions(), s.id).cost,
      { totalUSD: 939.4295384999997, linesAdded: 11467, linesRemoved: 1350 });
    assert.equal(byId(a.sessions(), bare.id).cost, null, 'no cost-state means null, not zero');
  });
});

test('subagents: flat list with parent links, including a depth-2 agent', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const parent = s.agent({ agentType: 'Explore', description: 'map the wiring', spawnDepth: 1, model: 'sonnet' });
    // Nested agents are stored FLAT in the root session dir, linked by parentAgentId.
    const child = s.agent({ agentType: 'general-purpose', description: 'read one file', spawnDepth: 2, parentAgentId: parent });
    s.add('agentResult', { agentId: parent, status: 'async_launched', description: 'map the wiring' });

    const a = start();
    a.refresh();
    const agents = byId(a.sessions(), s.id).agents;

    assert.equal(agents.length, 2);
    const p = agents.find((x) => x.agentId === parent);
    const c = agents.find((x) => x.agentId === child);
    assert.equal(p.parentAgentId, null);
    assert.equal(p.type, 'Explore');
    assert.equal(p.model, 'sonnet');
    assert.equal(p.workflowId, null);
    assert.equal(c.parentAgentId, parent, 'the tree is rebuilt from parentAgentId, not from nesting');
    assert.equal(c.description, 'read one file');
    assert.ok(c.transcriptPath.endsWith(`agent-${child}.jsonl`));
  });
});

test('subagents: a completed parent tool_result and a stale jsonl both mean done', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const finished = s.agent({ description: 'already answered' });
    const stale = s.agent({ description: 'silent for hours', mtimeMs: Date.now() - 45 * 60_000 });
    // Spawn record landed, completion record never did (parent killed).
    const orphan = s.agent({ description: 'orphaned background agent', mtimeMs: Date.now() - 45 * 60_000 });
    const live = s.agent({ description: 'still going' });
    s.add('agentResult', { agentId: finished, status: 'completed' });
    s.add('agentResult', { agentId: orphan, status: 'async_launched' });

    const a = start();
    a.refresh();
    const agents = byId(a.sessions(), s.id).agents;
    const st = (id) => agents.find((x) => x.agentId === id).status;

    assert.equal(st(finished), 'done', 'parent tool_result says completed');
    assert.equal(st(stale), 'done', 'jsonl idle past 10 minutes');
    assert.equal(st(orphan), 'done', 'a spawn record must not pin an idle agent to running forever');
    assert.equal(st(live), 'running');
  });
});

test('workflows: started without a result is running; a result closes it', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const wf = 'wf_8d8221bc-7c5';
    const a1 = s.agent({ workflowId: wf, description: 'phase 1', agentType: 'workflow-subagent' });
    const a2 = s.agent({ workflowId: wf, description: 'phase 2', agentType: 'workflow-subagent' });
    s.workflowJournal(wf, [
      { type: 'started', agentId: a1 },
      { type: 'result', agentId: a1, result: { claim: 'phase 1 landed' } },
      { type: 'started', agentId: a2 },
    ]);

    const a = start();
    a.refresh();
    const v = byId(a.sessions(), s.id);

    assert.equal(v.workflows.length, 1);
    assert.deepEqual(
      { id: v.workflows[0].id, agents: v.workflows[0].agents, done: v.workflows[0].done, running: v.workflows[0].running },
      { id: wf, agents: 2, done: 1, running: 1 },
    );
    assert.ok(v.workflows[0].startedAt > 0);

    const inWf = v.agents.filter((x) => x.workflowId === wf);
    assert.equal(inWf.length, 2, 'workflow agents also appear in the flat agent list');
    assert.equal(inWf.find((x) => x.agentId === a1).status, 'done');
    assert.equal(inWf.find((x) => x.agentId === a2).status, 'running');
  });
});

test('workflows: the saved script gives the workflow its name, description and phases', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const wf = 'wf_b77c8066-311';
    const long = 'D'.repeat(400);
    s.workflowScript(wf, {
      name: 'wave1-session-pivot', description: long,
      phases: ['Implement', 'Review', 'Ship'],
    });
    const a1 = s.agent({ workflowId: wf, description: 'implement:A-adapter' });
    const a2 = s.agent({ workflowId: wf, description: 'review:D-ui' });
    const a3 = s.agent({ workflowId: wf, description: 'review:E-server' });
    s.workflowJournal(wf, [
      { type: 'started', agentId: a1 }, { type: 'result', agentId: a1 },
      { type: 'started', agentId: a2 },
      { type: 'started', agentId: a3 },
    ]);

    const a = start();
    a.refresh();
    const w = byId(a.sessions(), s.id).workflows[0];

    assert.equal(w.name, 'wave1-session-pivot');
    assert.equal(w.description, long.slice(0, 200), 'the description is capped at 200 chars');
    assert.deepEqual(w.phase, { current: 'Review', done: 1, total: 3 },
      'the running agents label the phase; the journal counts it');
    assert.deepEqual([w.agents, w.done, w.running], [3, 1, 2], 'the existing counters stay');
    assert.ok(w.startedAt > 0);

    assert.deepEqual(w.runningAgents.map((r) => r.description), ['review:D-ui', 'review:E-server']);
    assert.ok(w.runningAgents.every((r) => 'currentTool' in r), 'every running agent carries a tool slot');
    assert.ok(!w.runningAgents.some((r) => r.agentId === a1), 'a finished agent is not listed as running');
  });
});

test('workflows: a missing or corrupt script yields nulls and never throws', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const bare = 'wf_no_script';
    const torn = 'wf_torn_script';
    const themeless = 'wf_no_phases';

    s.agent({ workflowId: bare, description: 'orphan' });
    s.workflowJournal(bare, [{ type: 'started', agentId: 'x' }]);

    s.agent({ workflowId: torn, description: 'orphan' });
    s.workflowScript(torn, { source: "export const meta = {\n  name: 'half-writ" });

    s.agent({ workflowId: themeless, description: 'orphan' });
    s.workflowScript(themeless, { source: "export const meta = {\n  name: 'themeless',\n}\n" });

    const a = start();
    a.refresh();
    const byWf = Object.fromEntries(byId(a.sessions(), s.id).workflows.map((w) => [w.id, w]));

    for (const id of [bare, torn]) {
      assert.deepEqual([byWf[id].name, byWf[id].description, byWf[id].phase], [null, null, null], id);
      assert.equal(byWf[id].agents, 1, `${id} still counts its agents`);
    }
    assert.equal(byWf[themeless].name, 'themeless');
    assert.equal(byWf[themeless].phase, null, 'no phases in the meta means no phase, not a guess');
  });
});

test('workflows: a phase no running label matches stays null, and the script is read once', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const wf = 'wf_unlabelled';
    // Real workflow agents carry NO description in meta.json: the labels the
    // phase match needs simply are not there, and inventing one is worse than
    // showing none.
    s.workflowScript(wf, { name: 'nightly', phases: ['Implement', 'Review'] });
    const id = s.agent({ workflowId: wf });
    s.workflowJournal(wf, [{ type: 'started', agentId: id }]);
    fs.writeFileSync(path.join(s.projDir, s.id, 'subagents', 'workflows', wf, `agent-${id}.meta.json`),
      JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1, model: 'opus' }));

    const a = start({ resweepMs: 0 });
    a.refresh();
    let w = byId(a.sessions(), s.id).workflows[0];
    assert.equal(w.name, 'nightly');
    assert.deepEqual(w.phase, { current: null, done: 0, total: 1 });

    // The script is immutable, so a later rewrite must not be re-read.
    const scriptPath = path.join(s.projDir, s.id, 'workflows', 'scripts', `nightly-${wf}.js`);
    fs.writeFileSync(scriptPath, "export const meta = { name: 'rewritten' }\n");
    a.refresh();
    w = byId(a.sessions(), s.id).workflows[0];
    assert.equal(w.name, 'nightly', 'the per-workflow script read is cached');
  });
});

test('workflows: a script that lands after the workflow dir is picked up on the sweep', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const wf = 'wf_late_script';
    const id = s.agent({ workflowId: wf, description: 'implement:A' });
    s.workflowJournal(wf, [{ type: 'started', agentId: id }]);

    const a = start({ resweepMs: 0 });
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).workflows[0].name, null);

    s.workflowScript(wf, { name: 'arrived-late', phases: ['Implement'] });
    a.refresh();
    const w = byId(a.sessions(), s.id).workflows[0];
    assert.equal(w.name, 'arrived-late', 'a miss is retried, not cached forever');
    assert.equal(w.phase.current, 'Implement');
  });
});

test('subagents: the incremental scan still sees new agents and later completions', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const wf = 'wf_incremental';
    const first = s.agent({ workflowId: wf, description: 'first' });
    s.workflowJournal(wf, [{ type: 'started', agentId: first }]);

    const a = start();
    a.refresh();
    let v = byId(a.sessions(), s.id);
    assert.equal(v.agents.length, 1);
    assert.equal(v.agents[0].status, 'running');
    assert.deepEqual([v.workflows[0].agents, v.workflows[0].done], [1, 0]);

    // A result lands in the journal — the dir listing is unchanged, only the file.
    s.workflowJournal(wf, [{ type: 'started', agentId: first }, { type: 'result', agentId: first }]);
    a.refresh();
    v = byId(a.sessions(), s.id);
    assert.equal(v.agents[0].status, 'done', 'a later journal result must close a cached agent');

    // A second agent appears in the same directory.
    const second = s.agent({ workflowId: wf, description: 'second' });
    a.refresh();
    v = byId(a.sessions(), s.id);
    assert.equal(v.agents.length, 2, 'a newly spawned agent must show up');
    assert.deepEqual([v.workflows[0].agents, v.workflows[0].done, v.workflows[0].running], [2, 1, 1]);
    assert.equal(v.agents.find((x) => x.agentId === second).status, 'running');
  });
});

test('subagents: an agent that starts writing again goes back to running', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const id = s.agent({ description: 'idle then resumed', mtimeMs: Date.now() - 45 * 60_000 });

    const a = start({ resweepMs: 0 });   // re-check finished agents every pass
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).agents[0].status, 'done');

    // The agent is resumed and appends again.
    const jsonl = byId(a.sessions(), s.id).agents[0].transcriptPath;
    fs.appendFileSync(jsonl, '{"type":"assistant"}\n');
    a.refresh();

    assert.equal(byId(a.sessions(), s.id).agents[0].status, 'running',
      'a resumed agent must not stay marked done');
  });
});

// A subagent writes its own transcript, so the parent's in-flight bookkeeping
// can never see what it is doing. These read the tail of the agent's own file.
const agentLine = (o) => JSON.stringify(rec[o.kind]({ cwd: '/work/x', sessionId: 'sid', ...o }));

test('currentTool: a running subagent exposes the tool it has not finished yet', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const busy = s.agent({
      description: 'the busy one',
      lines: [
        agentLine({ kind: 'assistantTool', name: 'Read', input: { file_path: '/work/a.go' }, toolId: 'toolu_done' }),
        agentLine({ kind: 'toolResult', toolId: 'toolu_done' }),
        agentLine({ kind: 'assistantTool', name: 'Bash', input: { command: 'go test ./...' }, toolId: 'toolu_live' }),
      ],
    });
    const quiet = s.agent({
      description: 'between tools',
      lines: [
        agentLine({ kind: 'assistantTool', name: 'Grep', input: { pattern: 'ledger' }, toolId: 'toolu_x' }),
        agentLine({ kind: 'toolResult', toolId: 'toolu_x' }),
      ],
    });

    const a = start();
    a.refresh();
    const agents = byId(a.sessions(), s.id).agents;
    const get = (id) => agents.find((x) => x.agentId === id);

    assert.equal(get(busy).currentTool.name, 'Bash');
    assert.equal(get(busy).currentTool.detail, 'go test ./...');
    assert.ok(get(busy).currentTool.at > 0, 'the tool line carries the record timestamp');
    assert.equal(get(quiet).currentTool, null, 'every tool_use answered means no live tool');
  });
});

test('currentTool: only the tail of a huge agent transcript is read, and only for running agents', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    // The 64KB window lands mid-record; skipping to the first newline is what
    // keeps a torn head from poisoning the whole read.
    const padding = JSON.stringify({ type: 'assistant', pad: 'p'.repeat(120_000) });
    const big = s.agent({
      description: 'long runner',
      lines: [padding, agentLine({ kind: 'assistantTool', name: 'Edit', input: { file_path: '/work/big.go' }, toolId: 'toolu_tail' })],
    });
    const finished = s.agent({
      description: 'already done',
      mtimeMs: Date.now() - 45 * 60_000,
      lines: [agentLine({ kind: 'assistantTool', name: 'Bash', input: { command: 'stale' }, toolId: 'toolu_old' })],
    });

    const a = start();
    a.refresh();
    const agents = byId(a.sessions(), s.id).agents;
    const get = (id) => agents.find((x) => x.agentId === id);

    assert.ok(fs.statSync(get(big).transcriptPath).size > 65536, 'the fixture is really past the window');
    assert.equal(get(big).currentTool.name, 'Edit', 'the newest record is inside the tail window');
    assert.equal(get(finished).status, 'done');
    assert.equal(get(finished).currentTool, null, 'a finished agent is never reported as holding a tool');
  });
});

test('currentTool: the workflow tree carries the same live tool line, under a per-pass cap', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const wf = 'wf_live_tools';
    s.workflowScript(wf, { name: 'live', phases: ['Implement'] });
    const ids = [];
    for (let i = 0; i < 14; i++) {
      ids.push(s.agent({
        workflowId: wf, description: `implement:lane-${i}`,
        lines: [agentLine({ kind: 'assistantTool', name: 'Bash', input: { command: `lane ${i}` }, toolId: `toolu_${i}` })],
      }));
    }
    s.workflowJournal(wf, ids.map((id) => ({ type: 'started', agentId: id })));

    const a = start();
    a.refresh();
    const v = byId(a.sessions(), s.id);
    const w = v.workflows[0];

    assert.equal(w.runningAgents.length, 6, 'the workflow lists at most six running agents');
    const withTool = v.agents.filter((x) => x.currentTool);
    assert.equal(withTool.length, 12, 'at most twelve agent transcripts are tailed per pass');
    assert.match(withTool[0].currentTool.detail, /^lane \d+$/);
    for (const r of w.runningAgents.filter((x) => x.currentTool)) {
      assert.equal(r.currentTool.name, 'Bash', 'the tree entry carries the same tool line as the agent');
    }
  });
});

// A workflow agent has no description of its own, so the dashboard renders it
// as a raw hex id. The prompt it was spawned with is the intent, and it is the
// FIRST user record of the agent's own transcript.
test('spawnPrompt: the first user record of an agent transcript, trimmed and capped', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const body = 'Fix the remaining wave-3 review findings in lib/claude.mjs\n\nLeave the UI alone.';
    const long = 'Reconcile the ledger. ' + 'x'.repeat(5000);
    const plain = s.agent({ description: 'work', prompt: `\n\n  ${body}  \n\n` });
    const big = s.agent({ prompt: long });
    const blocks = s.agent({ prompt: [{ type: 'text', text: 'Review the dedupe lane\nand report back' }] });
    const noText = s.agent({ prompt: [{ type: 'image', source: { data: 'x' } }] });
    const torn = s.agent({ lines: ['{"type":"user","message":{"role":"user","content":"cut off mid-', '{"type":"assistant"}'] });
    const silent = s.agent({ lines: ['{"type":"assistant"}'] });

    const a = start();
    a.refresh();
    const agents = byId(a.sessions(), s.id).agents;
    const p = (id) => agents.find((x) => x.agentId === id).spawnPrompt;

    assert.equal(p(plain), body, 'the whole prompt, whitespace-trimmed');
    assert.equal(p(big).length, 4000, 'hard-cut at the summarizer budget');
    assert.equal(p(big), long.slice(0, 4000), 'and it keeps the head, not a random slice');
    assert.equal(p(blocks), 'Review the dedupe lane\nand report back', 'content can be an array of blocks');
    assert.equal(p(noText), null, 'a block carrying no text is not a prompt');
    assert.equal(p(torn), null, 'a torn first record yields null, not a guess');
    assert.equal(p(silent), null, 'no user record at all means no prompt');
    assert.ok(agents.every((x) => 'spawnPrompt' in x), 'every agent object carries the field');
  });
});

test('spawnPrompt: a workflow running agent carries it in the tree entry too', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const wf = 'wf_spawn';
    s.workflowScript(wf, { name: 'wave3', phases: ['Implement'] });
    const live = s.agent({ workflowId: wf, description: 'implement:A-adapter', prompt: 'Implement the adapter lane' });
    const done = s.agent({ workflowId: wf, description: 'implement:B-ui', prompt: 'Implement the UI lane' });
    s.workflowJournal(wf, [
      { type: 'started', agentId: live },
      { type: 'started', agentId: done }, { type: 'result', agentId: done },
    ]);

    const a = start();
    a.refresh();
    const v = byId(a.sessions(), s.id);

    assert.deepEqual(v.workflows[0].runningAgents.map((r) => r.spawnPrompt), ['Implement the adapter lane'],
      'the running entry carries the same prompt as the flat one');
    assert.equal(v.agents.find((x) => x.agentId === done).spawnPrompt, 'Implement the UI lane');
  });
});

test('spawnPrompt: only the newest agents are read, and the accessor still answers for an old one', async () => {
  await withFx(async (fx, start) => {
    // A real session reaches thousands of subagents (2734 on mordor), so a tick
    // reads the newest 80 and leaves the rest untouched rather than walking
    // every transcript. Ranking is by startedAt — created first is oldest — and
    // the backdated mtimes only settle every agent here as done.
    const s = fx.session();
    const old = [];
    for (let i = 0; i < 4; i++) old.push(s.agent({ prompt: `old lane ${i}`, mtimeMs: Date.now() - 90 * 60_000 }));
    await new Promise((r) => setTimeout(r, 25));        // birth times must not collide
    const fresh = [];
    for (let i = 0; i < 80; i++) fresh.push(s.agent({ prompt: `lane ${i}`, mtimeMs: Date.now() - 45 * 60_000 }));

    const a = start();
    a.refresh();
    const agents = byId(a.sessions(), s.id).agents;
    const p = (id) => agents.find((x) => x.agentId === id).spawnPrompt;

    assert.equal(agents.length, 84);
    assert.ok(agents.every((x) => x.status === 'done'), 'the cap is what is under test here, not liveness');
    assert.equal(agents.filter((x) => x.spawnPrompt).length, 80, 'exactly the newest 80 were read');
    for (const id of old) assert.equal(p(id), null, 'an agent past the cap is left unread');
    for (const id of fresh) assert.ok(p(id), 'and every agent inside it carries its prompt');

    // A click names one specific agent, which can be any of the thousands.
    assert.equal(a.spawnPrompt(s.id, old[0]), 'old lane 0', 'the accessor has no recency cap');
    assert.equal(a.spawnPrompt(s.id, 'no-such-agent'), null, 'an unknown agent is null, not a throw');
    assert.equal(a.spawnPrompt('no-such-session', old[0]), null, 'and so is an unknown session');

    a.refresh();
    assert.equal(byId(a.sessions(), s.id).agents.find((x) => x.agentId === old[0]).spawnPrompt, null,
      'reading one on demand does not put it back into every tick');
  });
});

test('spawnPrompt: the read is cached per agent, so a rewritten transcript keeps it', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.agent({ description: 'long runner', prompt: 'Fix the wave-3 findings' });

    const a = start({ resweepMs: 0 });
    a.refresh();
    const jsonl = byId(a.sessions(), s.id).agents[0].transcriptPath;
    assert.equal(byId(a.sessions(), s.id).agents[0].spawnPrompt, 'Fix the wave-3 findings');

    // The prompt an agent was spawned with is immutable, so its transcript head
    // is never read twice — proven the way the workflow script cache is, by
    // rewriting the file and watching the first read stand.
    fs.writeFileSync(jsonl, JSON.stringify({ type: 'user', message: { role: 'user', content: 'REWRITTEN' } }) + '\n');
    a.refresh();

    const v = byId(a.sessions(), s.id).agents[0];
    assert.equal(v.spawnPrompt, 'Fix the wave-3 findings', 'the per-agent read is cached for the daemon lifetime');
    assert.equal(a.spawnPrompt(s.id, v.agentId), 'Fix the wave-3 findings', 'and the accessor answers from the same cache');
  });
});

test('digest: the journal is written by the adapter and read back by window', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session({ name: 'digest-me' });
    s.add('turn', { durationMs: 4321, messageCount: 9 })
      .add('aiTitle', { title: 'overnight work' })
      .add('costState', { totalCostUSD: 12.5 })
      .add('prLink', { prNumber: 42 });

    const a = start();
    a.refresh();

    const all = a.digestEvents(0);
    const kinds = all.filter((e) => e.sessionId === s.id).map((e) => e.kind);
    for (const k of ['session-start', 'turn', 'title', 'cost', 'pr']) {
      assert.ok(kinds.includes(k), `journal is missing a ${k} event`);
    }

    const turn = all.find((e) => e.kind === 'turn');
    assert.deepEqual(turn.data, { durationMs: 4321, messageCount: 9 });
    assert.equal(all.find((e) => e.kind === 'pr').data.number, 42);
    assert.equal(all.find((e) => e.kind === 'cost').data.totalUSD, 12.5);
    assert.equal(all.find((e) => e.kind === 'title').data.title, 'overnight work');
    assert.ok(all.every((e, i, arr) => i === 0 || arr[i - 1].at <= e.at), 'events come back in order');

    assert.deepEqual(a.digestEvents(Date.now() + 60_000), [], 'a future window is empty');

    // A second refresh must not re-journal records that were already tailed.
    a.refresh();
    assert.equal(a.digestEvents(0).length, all.length);
  });
});

// /digest and every open detail panel ask for this file, and a week of journal
// is thousands of lines to parse. It is parsed once per (size, mtimeMs) — the
// same key journalResults uses for a workflow journal. Proven by rewriting the
// file in place at the same size and stamp: without a cache the new content
// would come back, and the ceiling that lets that through is the point.
test('digest: the journal is parsed once per (size, mtimeMs), not once per request', async () => {
  await withFx(async (fx, start) => {
    const journalPath = path.join(fx.stateDir, 'journal.jsonl');
    const at = Date.now() - 3600_000;
    const row = (id) => JSON.stringify({ at, sessionId: id, name: id, kind: 'turn', data: {} }) + '\n';
    fs.writeFileSync(journalPath, row('aaa'));

    const a = start();                                    // boot rewrites the file, so stamp after it
    const stamp = Math.floor(Date.now() / 1000) - 60;     // whole seconds round-trip through utimes exactly
    fs.utimesSync(journalPath, stamp, stamp);
    assert.deepEqual(a.digestEvents(0).map((e) => e.sessionId), ['aaa']);

    const st = fs.statSync(journalPath);
    fs.writeFileSync(journalPath, row('bbb'));
    fs.utimesSync(journalPath, stamp, stamp);
    const st2 = fs.statSync(journalPath);
    assert.equal(st2.size, st.size, 'the rewrite really is byte-for-byte the same size');
    assert.equal(st2.mtimeMs, st.mtimeMs, 'and the stamp really was put back');
    assert.deepEqual(a.digestEvents(0).map((e) => e.sessionId), ['aaa'], 'answered from the parse, not the file');

    fs.appendFileSync(journalPath, row('ccc'));   // any real append moves the size
    assert.deepEqual(a.digestEvents(0).map((e) => e.sessionId), ['bbb', 'ccc'], 'and a real write invalidates it');
  });
});

// A summary costs a model call and is then cached under the version it was
// built at, so one written from a half-replayed transcript is wrong AND sticky.
// caughtUp() is the adapter saying "not yet" out loud.
test('replay: caughtUp() is false until the boot replay passes the persisted floor', async () => {
  const fx = makeFixture();
  let a2 = null;
  try {
    const s = fx.session({ name: 'long-runner' });
    for (let i = 0; i < 40; i++) {
      s.add('assistantTool', { name: 'Bash', input: { command: `step ${i}` }, toolId: `t${i}` })
        .add('toolResult', { toolId: `t${i}` });
    }
    const a1 = createClaudeAdapter(fx.opts());
    a1.refresh();
    assert.equal(a1.caughtUp(s.id), true, 'a first run has no floor to climb');
    a1.stop();

    // A restart replays the whole file from byte 0; maxDelta is what a real
    // daemon's 16MB chunk is to a 50MB transcript, shrunk to fixture scale. It
    // has to clear one whole record or the tail can never advance at all.
    const CHUNK = 4096;
    assert.ok(fs.statSync(s.transcriptPath).size > CHUNK * 4, 'the fixture is big enough to replay in pieces');
    a2 = createClaudeAdapter(fx.opts({ maxDelta: CHUNK }));
    assert.equal(a2.caughtUp(s.id), false, 'still climbing the floor an earlier run left');
    assert.equal(a2.caughtUp('no-such-session'), true, 'an id with no transcript is not held back');

    for (let i = 0; i < 200 && !a2.caughtUp(s.id); i++) a2.refresh();
    assert.equal(a2.caughtUp(s.id), true, 'and true once the replay reaches what was already announced');
  } finally { a2?.stop(); fx.cleanup(); }
});

test('digest: entries older than 7 days are pruned on boot', async () => {
  await withFx(async (fx, start) => {
    const journalPath = path.join(fx.stateDir, 'journal.jsonl');
    const old = Date.now() - 9 * 86_400_000;
    const fresh = Date.now() - 3600_000;
    fs.writeFileSync(journalPath, [
      JSON.stringify({ at: old, sessionId: 'x', name: 'x', kind: 'turn', data: {} }),
      JSON.stringify({ at: fresh, sessionId: 'y', name: 'y', kind: 'turn', data: {} }),
    ].join('\n') + '\n');

    const a = start();
    const kept = a.digestEvents(0);

    assert.equal(kept.length, 1);
    assert.equal(kept[0].sessionId, 'y');
  });
});

test('digest: a session ending is journalled once', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session({ name: 'short-lived' });
    s.add('turn', {});

    const a = start();
    a.refresh();
    assert.equal(a.digestEvents(0).filter((e) => e.kind === 'session-end').length, 0);

    s.kill();
    a.refresh();
    a.refresh();

    const ends = a.digestEvents(0).filter((e) => e.kind === 'session-end');
    assert.equal(ends.length, 1, 'session-end is emitted exactly once');
    assert.equal(ends[0].name, 'short-lived');
  });
});

test('digest: a vanished pid file also journals session-end', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session({ name: 'clean-exit' });
    s.add('turn', {});

    const a = start();
    a.refresh();

    // Claude Code deletes sessions/<pid>.json on a clean exit — the common path.
    fs.rmSync(s.pidFile);
    a.refresh();
    a.refresh();

    assert.equal(byId(a.sessions(), s.id).status, 'ended');
    const ends = a.digestEvents(0).filter((e) => e.kind === 'session-end');
    assert.equal(ends.length, 1, 'a clean exit is journalled exactly once');
    assert.equal(ends[0].name, 'clean-exit');
  });
});

test('digest: a session resumed inside one daemon run starts and ends again', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session({ name: 'resumable' });
    s.add('turn', {});

    const a = start();
    a.refresh();

    fs.rmSync(s.pidFile);                     // exits
    a.refresh();

    // --resume: same sessionId (same transcript for weeks), fresh pid file.
    s.live({ startedAt: Date.now() });
    a.refresh();

    fs.rmSync(s.pidFile);                     // and exits again
    a.refresh();

    const kinds = a.digestEvents(0)
      .filter((e) => e.sessionId === s.id && e.kind.startsWith('session-'))
      .map((e) => e.kind);
    assert.deepEqual(kinds, ['session-start', 'session-end', 'session-start', 'session-end'],
      'a resume cycle inside one daemon run must not be invisible to the digest');
  });
});

test('digest: a daemon restart does not re-announce a still-running session', async () => {
  const fx = makeFixture();
  try {
    const s = fx.session({ name: 'long-runner' });
    s.add('turn', {});

    const a1 = createClaudeAdapter(fx.opts());
    a1.refresh();
    const starts = (a) => a.digestEvents(0).filter((e) => e.kind === 'session-start').length;
    assert.equal(starts(a1), 1);
    a1.stop();

    const a2 = createClaudeAdapter(fx.opts());
    a2.refresh();
    assert.equal(starts(a2), 1, 'the journal already records this session starting');
    a2.stop();
  } finally { fx.cleanup(); }
});

test('liveness: a crash leftover pid file does not bury the resumed session', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session({ name: 'resumed-after-crash' });
    s.add('turn', {});

    // kill -9 / OOM leaves sessions/<pid>.json behind; --resume then reuses the
    // SAME sessionId under a fresh pid file, so both exist at once. The stale
    // one is deliberately the NEWER record: liveness must not be a timestamp race.
    const stale = { ...JSON.parse(fs.readFileSync(s.pidFile, 'utf8')), pid: deadPid(), updatedAt: Date.now() + 5000 };
    fs.writeFileSync(path.join(path.dirname(s.pidFile), `${stale.pid}.json`), JSON.stringify(stale));

    const a = start();
    for (let i = 0; i < 6; i++) a.refresh();

    const v = byId(a.sessions(), s.id);
    assert.notEqual(v.status, 'ended', 'the live process outranks the leftover file');
    assert.equal(v.pid, s.pid, 'and the reported pid is the one still running');

    const mine = a.digestEvents(0).filter((e) => e.sessionId === s.id && e.kind.startsWith('session-'));
    assert.deepEqual(mine.map((e) => e.kind), ['session-start'],
      'the journal must not flap start/end once per refresh pass');
  });
});

test('digest: a session that exited while the daemon was down is closed at boot', async () => {
  const fx = makeFixture();
  let a2 = null;
  try {
    const s = fx.session({ name: 'gone-while-away' });
    s.add('turn', {});

    const a1 = createClaudeAdapter(fx.opts());
    a1.refresh();
    a1.stop();

    fs.rmSync(s.pidFile);                 // exits with nothing watching

    a2 = createClaudeAdapter(fx.opts());
    a2.refresh();
    const ends = a2.digestEvents(0).filter((e) => e.kind === 'session-end');
    assert.equal(ends.length, 1, 'the open session is closed once, at boot');
    assert.equal(ends[0].name, 'gone-while-away', 'and it keeps the name it was announced under');

    // The stale open entry must also stop swallowing the next start.
    s.live({ startedAt: Date.now() });
    a2.refresh();
    const kinds = a2.digestEvents(0)
      .filter((e) => e.sessionId === s.id && e.kind.startsWith('session-')).map((e) => e.kind);
    assert.deepEqual(kinds, ['session-start', 'session-end', 'session-start'],
      'a resume after the gap must announce itself again');
  } finally { a2?.stop(); fx.cleanup(); }
});

test('material: a bounded, labelled window whose version moves only when the session speaks', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('aiTitle', { title: 'ledger repair' })
      .add('lastPrompt', { text: 'conserta o saldo do tenant lastlink' })
      .add('assistantTool', { name: 'Bash', input: { command: 'go test ./...' }, toolId: 'toolu_1' })
      .add('toolResult', { toolId: 'toolu_1' })
      .add('assistantTool', {
        name: 'TodoWrite',
        input: { todos: [{ content: 'reconcile balances', status: 'in_progress' }] },
      })
      .add('turn', {});

    const a = start();
    a.refresh();
    const m = a.material(s.id);

    assert.ok(m.text.includes('Title: ledger repair'));
    assert.ok(m.text.includes('Last prompt: conserta o saldo do tenant lastlink'));
    assert.ok(m.text.includes('- Bash go test ./...'), 'recent tools are one line each');
    assert.ok(m.text.includes('- [in_progress] reconcile balances'), 'todo statuses come through');
    assert.ok(m.text.length <= 4000);

    assert.deepEqual(a.material(s.id), m, 'nothing changed, so neither does the version');
    a.refresh();
    assert.equal(a.material(s.id).version, m.version, 'a pass that reads nothing new keeps it');

    s.add('lastPrompt', { text: 'agora reconcilia o outro tenant' }).add('turn', {});
    a.refresh();
    const after = a.material(s.id);
    assert.notEqual(after.version, m.version, 'a new turn moves the version');
    assert.ok(after.text.includes('agora reconcilia o outro tenant'));

    assert.equal(a.material('no-such-session'), null, 'an unknown id has no material');
  });
});

// material() is the ONLY value this adapter builds to be handed to a third
// party, and the two things it is built from — the last prompt and the tool
// lines — are exactly where a pasted key lands. The scrub happens here, not
// only at the summarizer, so any future caller of material() is covered too.
test('material: a key pasted into a prompt or printed by a tool is redacted', async () => {
  await withFx(async (fx, start) => {
    const PASTED = 'sk-or-v1-9f2a1c4e8b7d6a5f3e2c1b0a9d8e7f6a';
    const HEADER = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkYXRhcHJldiJ9.Hs4bJk2mQpR7tWxYzA1bCd3EfGhIjKlMn';
    const s = fx.session();
    s.add('aiTitle', { title: 'rotate the gateway credential' })
      .add('lastPrompt', { text: `use this for the sandbox: Authorization: Bearer ${HEADER}` })
      .add('assistantTool', { name: 'Bash', input: { command: `OPENROUTER_API_KEY=${PASTED} node bin/agenttrail.mjs` }, toolId: 'toolu_1' })
      .add('toolResult', { toolId: 'toolu_1' })
      .add('assistantTool', { name: 'Read', input: { file_path: '/srv/worktrees/live-context/lib/summarize.mjs' }, toolId: 'toolu_2' })
      .add('toolResult', { toolId: 'toolu_2' })
      .add('turn', {});

    const a = start();
    a.refresh();
    const { text } = a.material(s.id);

    assert.equal(text.includes(PASTED), false, 'the pasted key would have gone straight to the model');
    assert.equal(text.includes(HEADER), false, 'and so would the bearer token above it');
    assert.match(text, /OPENROUTER_API_KEY=\[redacted\]/, 'the name of the variable is not the secret');
    assert.ok(text.includes('Title: rotate the gateway credential'), 'the readable part is untouched');
    assert.ok(text.includes('- Read /srv/worktrees/live-context/lib/summarize.mjs'),
      'and a file path is not mistaken for a base64 blob');
  });
});

test('material: the window is capped even when the session is enormous', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('aiTitle', { title: 'T'.repeat(3000) })
      .add('lastPrompt', { text: 'P'.repeat(600) });
    for (let i = 0; i < 30; i++) {
      s.add('assistantTool', { name: `Bash`, input: { command: `step ${i} ${'c'.repeat(300)}` }, toolId: `t${i}` })
        .add('toolResult', { toolId: `t${i}` });
    }
    s.add('assistantTool', {
      name: 'TodoWrite',
      input: { todos: Array.from({ length: 20 }, (_, i) => ({ content: 'x'.repeat(200), status: 'pending' })) },
    });

    const a = start();
    a.refresh();
    const m = a.material(s.id);

    assert.equal(m.text.length, 4000, 'the window is hard-capped');
    assert.ok(m.text.startsWith('Title: TTT'), 'and it keeps the head, not a random slice');
    assert.match(m.version, /^\d+:\d+$/);
  });
});

test('export and distill resolve the transcript by session id alone', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('userPrompt', { text: 'fix the ledger' })
      .add('assistantTool', { name: 'Bash', input: { command: 'make test' } })
      .add('assistantText', { text: 'done' });

    const a = start();
    a.refresh();

    assert.equal(a.exportPath(s.id), s.transcriptPath);
    assert.equal(a.exportPath('no-such-session'), null);

    let md = '';
    for await (const chunk of a.distill(s.id)) md += chunk;
    assert.match(md, /# Session/);
    assert.match(md, /fix the ledger/);
    assert.match(md, /`Bash` make test/);
    assert.match(md, /done/);
  });
});

test('onChange fires from the adapter itself when a live session moves', async () => {
  const fx = makeFixture();
  let a = null;
  try {
    const s = fx.session();
    s.add('turn', {});
    let hits = 0;
    a = createClaudeAdapter(fx.opts({ pollMs: 20, onChange: () => hits++ }));

    s.add('turn', {});                        // nothing here ever calls refresh()
    const deadline = Date.now() + 5000;
    while (hits === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    assert.ok(hits >= 1, 'the adapter must reach onChange through its own watcher/timer');
    assert.equal(byId(a.sessions(), s.id).turns, 2);
  } finally { a?.stop(); fx.cleanup(); }
});

test('onChange: a workflow result alone counts as movement', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const wf = 'wf_quiet';
    const id = s.agent({ workflowId: wf, description: 'phase 1' });
    s.workflowJournal(wf, [{ type: 'started', agentId: id }]);
    s.add('turn', {});
    s.touch(120_000);                       // the parent transcript goes quiet

    const a = start();
    a.refresh();
    assert.equal(a.refresh(), false, 'a settled session does not move on its own');
    assert.equal(byId(a.sessions(), s.id).agents[0].status, 'running');

    // Only the background workflow progresses; the parent writes nothing.
    s.workflowJournal(wf, [{ type: 'started', agentId: id }, { type: 'result', agentId: id }]);
    assert.equal(a.refresh(), true, 'a subagent finishing is state movement');

    const v = byId(a.sessions(), s.id);
    assert.equal(v.agents[0].status, 'done');
    assert.ok(v.lastEventAt >= v.agents[0].lastEventAt,
      'subagent activity keeps the session from looking stale to a partial tick');
    assert.ok(v.lastEventAt > Date.now() - 60_000,
      'and it beats the backdated parent transcript');
  });
});

test('onChange: a still-running subagent appending is movement on its own', async () => {
  await withFx(async (fx, start) => {
    // Everything the parent contributes is minutes old, so the only thing that
    // can advance lastEventAt is the agent — no 1ms-granularity coin flip.
    const s = fx.session({ pidPatch: { updatedAt: Date.now() - 300_000 } });
    const id = s.agent({ description: 'long runner', mtimeMs: Date.now() - 60_000 });
    s.add('turn', { at: Date.now() - 300_000 });
    s.touch(120_000);                       // the parent transcript goes quiet

    const a = start();
    a.refresh();
    assert.equal(a.refresh(), false, 'a settled session does not move on its own');
    const before = byId(a.sessions(), s.id);
    assert.equal(before.agents[0].status, 'running');

    // Same agent, same status, same count: only its transcript grows.
    fs.appendFileSync(before.agents[0].transcriptPath, '{"type":"assistant"}\n');
    assert.equal(a.refresh(), true, 'a running subagent writing must move the session');

    const after = byId(a.sessions(), s.id);
    assert.equal(after.agents[0].status, 'running', 'the fingerprint did not change — only the mtime');
    assert.ok(after.lastEventAt > before.lastEventAt, 'and the session stops looking stale');
    assert.equal(after.agents[0].agentId, id);
  });
});

test('sessions() hands out snapshots that a later refresh cannot mutate', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const wf = 'wf_snapshot';
    const id = s.agent({ workflowId: wf, description: 'phase 1' });
    s.workflowJournal(wf, [{ type: 'started', agentId: id }]);
    s.add('turn', {});

    const a = start();
    a.refresh();
    const before = byId(a.sessions(), s.id);
    assert.equal(before.agents[0].status, 'running');
    assert.equal(before.prs.length, 0);

    s.workflowJournal(wf, [{ type: 'started', agentId: id }, { type: 'result', agentId: id }]);
    s.add('prLink', { prNumber: 5 });
    a.refresh();

    assert.equal(before.agents[0].status, 'running', 'a retained snapshot must not change under the caller');
    assert.equal(before.prs.length, 0, 'nor may its arrays grow');
    const after = byId(a.sessions(), s.id);
    assert.equal(after.agents[0].status, 'done');
    assert.equal(after.prs.length, 1);
    assert.equal(after.agents[0].jsonlPath, undefined, 'internal fields stay out of the contract shape');
  });
});

test('subagents: an agent seen before its jsonl exists is backfilled later', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const id = s.agent({ description: 'meta landed first' });
    const jsonl = path.join(s.projDir, s.id, 'subagents', `agent-${id}.jsonl`);
    fs.rmSync(jsonl);                       // the window between meta.json and the transcript

    const a = start();
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).agents[0].transcriptPath, null);

    fs.writeFileSync(jsonl, '{"type":"assistant"}\n');
    a.refresh();

    const v = byId(a.sessions(), s.id).agents[0];
    assert.equal(v.transcriptPath, jsonl, 'the path must be picked up once the file lands');
    assert.ok(v.startedAt > 0, 'and so must the start time');
    assert.equal(v.status, 'running');
  });
});

test('subagents: a torn meta.json read is retried on the sweep', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    const id = s.agent({ agentType: 'Explore', description: 'map the wiring' });
    const meta = path.join(s.projDir, s.id, 'subagents', `agent-${id}.meta.json`);
    const good = fs.readFileSync(meta, 'utf8');
    fs.writeFileSync(meta, good.slice(0, 20));   // half-written JSON

    const a = start({ resweepMs: 0 });
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).agents[0].type, null);

    fs.writeFileSync(meta, good);
    a.refresh();
    assert.equal(byId(a.sessions(), s.id).agents[0].type, 'Explore',
      'a partial read must not freeze the agent metadata forever');
  });
});

test('distill: a large pasted prompt is not skipped', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.add('userPrompt', { text: 'LEDGER DUMP ' + 'z'.repeat(60_000) });
    s.add('assistantText', { text: 'ok' });

    const a = start();
    a.refresh();

    let md = '';
    for await (const chunk of a.distill(s.id)) md += chunk;
    assert.match(md, /LEDGER DUMP/, 'a prompt bigger than the sniff threshold still exports');
  });
});

test('every path the adapter reports stays inside the tree it was given', async () => {
  await withFx(async (fx, start) => {
    const s = fx.session();
    s.agent({ description: 'plain' });
    s.agent({ workflowId: 'wf_paths', description: 'in a workflow' });
    s.add('turn', {});
    const acct = fx.session({ account: '005-galadriel' });
    acct.add('turn', {});

    const a = start();
    a.refresh();

    const list = a.sessions();
    assert.equal(list.length, 2, 'both fixture sessions are present');
    let agents = 0;
    for (const v of list) {
      assert.ok(v.transcriptPath.startsWith(fx.root), `transcript escaped: ${v.transcriptPath}`);
      for (const g of v.agents) {
        agents++;
        assert.ok(g.transcriptPath.startsWith(fx.root), `agent transcript escaped: ${g.transcriptPath}`);
      }
    }
    assert.equal(agents, 2, 'both agents were actually checked');
    assert.ok(a.exportPath(s.id).startsWith(fx.root));
    assert.ok(fs.existsSync(path.join(fx.stateDir, 'offsets.json')), 'state lands in the fixture state dir');
  });
});

test('an empty tree yields no sessions', async () => {
  await withFx(async (fx, start) => {
    const a = start();
    a.refresh();
    assert.deepEqual(a.sessions(), []);
  });
});
