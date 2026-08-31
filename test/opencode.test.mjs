// opencode adapter tests. Builds a synthetic opencode.db in a tmpdir with
// node:sqlite — the real ~/.local/share/opencode is NEVER touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createOpencodeAdapter } from '../lib/opencode.mjs';
import { composeAdapters, createServer } from '../bin/agenttrail.mjs';

// Column lists copied from the live schema on mordor (2026-08-30), so a fixture
// that satisfies the adapter satisfies the real database.
const V2_SCHEMA = [
  `create table session (
     id text primary key, project_id text not null, workspace_id text, parent_id text,
     slug text not null, directory text not null, path text, title text not null,
     version text not null, share_url text,
     summary_additions integer, summary_deletions integer, summary_files integer,
     summary_diffs text, metadata text,
     cost real default 0 not null,
     tokens_input integer default 0 not null, tokens_output integer default 0 not null,
     tokens_reasoning integer default 0 not null, tokens_cache_read integer default 0 not null,
     tokens_cache_write integer default 0 not null,
     revert text, permission text, agent text, model text,
     time_created integer not null, time_updated integer not null,
     time_compacting integer, time_archived integer)`,
  `create table session_message (
     id text primary key, session_id text not null, type text not null, seq integer not null,
     time_created integer not null, time_updated integer not null, data text not null)`,
  `create table todo (
     session_id text not null, content text not null, status text not null,
     priority text not null, position integer not null,
     time_created integer not null, time_updated integer not null,
     constraint todo_pk primary key (session_id, position))`,
];

const LEGACY_SCHEMA = [
  V2_SCHEMA[0],
  `create table message (
     id text primary key, session_id text not null,
     time_created integer not null, time_updated integer not null, data text not null)`,
  `create table part (
     id text primary key, message_id text not null, session_id text not null,
     time_created integer not null, time_updated integer not null, data text not null)`,
];

let seq = 0;

/** A fixture opencode data dir. `legacy: true` swaps session_message for message/part. */
function makeDb({ legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-oc-'));
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  for (const sql of legacy ? LEGACY_SCHEMA : V2_SCHEMA) db.exec(sql);

  const fx = {
    dir, dbPath,

    session(o = {}) {
      const id = o.id ?? `ses_${(++seq).toString(16).padStart(8, '0')}`;
      const updated = o.timeUpdated ?? Date.now();
      db.prepare(`insert into session (id, project_id, workspace_id, parent_id, slug, directory,
        title, version, summary_additions, summary_deletions, cost, model, time_created, time_updated)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, o.projectId ?? 'prj_1', o.workspaceId ?? null, o.parentId ?? null,
        o.slug ?? id, o.directory ?? '/work/oc-repo', o.title ?? 'a session',
        o.version ?? '1.2.3', o.linesAdded ?? 0, o.linesRemoved ?? 0,
        o.cost ?? 0, o.model ?? 'anthropic/claude-opus-5', o.timeCreated ?? updated - 60_000, updated);
      return id;
    },

    message(sessionId, role, at = Date.now()) {
      const id = `msg_${++seq}`;
      const data = JSON.stringify({ id, role, sessionID: sessionId });
      if (legacy) db.prepare('insert into message (id, session_id, time_created, time_updated, data) values (?,?,?,?,?)').run(id, sessionId, at, at, data);
      else db.prepare('insert into session_message (id, session_id, type, seq, time_created, time_updated, data) values (?,?,?,?,?,?,?)').run(id, sessionId, role, ++seq, at, at, data);
      return id;
    },

    todo(sessionId, content, status, position) {
      db.prepare(`insert into todo (session_id, content, status, priority, position, time_created, time_updated)
        values (?,?,?,?,?,?,?)`).run(sessionId, content, status, 'medium', position, Date.now(), Date.now());
    },

    /** Close the writer: the adapter must never need one. */
    seal() { db.close(); return fx; },

    cleanup() { try { db.close(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
  return fx;
}

/** Adapter options: watching and polling off, liveness stubbed, no real pgrep. */
const opts = (fx, extra = {}) => ({ dataDir: fx.dir, pollMs: 0, processAlive: () => true, ...extra });

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---- mapping ---------------------------------------------------------------

test('maps session rows onto the Session contract', () => {
  const fx = makeDb();
  const id = fx.session({
    title: 'br-sfn spike', directory: '/work/br-sfn', model: 'anthropic/claude-opus-5',
    cost: 1.25, linesAdded: 40, linesRemoved: 3, version: '1.9.0',
    timeCreated: Date.now() - 300_000, timeUpdated: Date.now() - 5_000,
  });
  fx.message(id, 'user');
  fx.message(id, 'assistant');
  fx.message(id, 'user');
  fx.todo(id, 'write the adapter', 'completed', 0);
  fx.todo(id, 'ship it', 'in_progress', 1);
  fx.seal();

  const a = createOpencodeAdapter(opts(fx));
  try {
    const [s] = a.sessions();
    assert.equal(s.id, id);
    assert.equal(s.source, 'opencode');
    assert.equal(s.name, 'br-sfn spike');
    assert.equal(s.title, 'br-sfn spike');
    assert.equal(s.cwd, '/work/br-sfn');
    assert.equal(s.model, 'anthropic/claude-opus-5');
    assert.equal(s.version, '1.9.0');
    assert.deepEqual(s.cost, { totalUSD: 1.25, linesAdded: 40, linesRemoved: 3 });
    assert.equal(s.turns, 2, 'turns count user messages, not every record');
    assert.deepEqual(s.todos, [
      { content: 'write the adapter', status: 'completed' },
      { content: 'ship it', status: 'in_progress' },
    ]);
    assert.equal(s.kind, 'interactive');
    assert.equal(s.pid, null);
    assert.equal(s.account, null);
    assert.equal(s.tmux, null);
    assert.equal(s.gitBranch, null);
    assert.equal(s.transcriptPath, null);
    assert.equal(s.transcriptBytes, 0);
    assert.equal(s.currentTool, null);
    assert.deepEqual(s.recentTools, []);
    assert.deepEqual(s.workflows, []);
    assert.deepEqual(s.prs, []);
    assert.ok(s.startedAt > 0 && s.startedAt < s.lastEventAt);
  } finally { a.stop(); fx.cleanup(); }
});

test('a zero-cost session reports no cost rather than $0', () => {
  const fx = makeDb();
  fx.session({ cost: 0 });
  fx.seal();
  const a = createOpencodeAdapter(opts(fx));
  try { assert.equal(a.sessions()[0].cost, null); } finally { a.stop(); fx.cleanup(); }
});

test('an untitled session still gets a name', () => {
  const fx = makeDb();
  const id = fx.session({ title: '' });
  fx.seal();
  const a = createOpencodeAdapter(opts(fx));
  try {
    const [s] = a.sessions();
    assert.equal(s.title, null);
    assert.equal(s.name, id.slice(0, 8));
  } finally { a.stop(); fx.cleanup(); }
});

test('seconds-based timestamps are not read as 1970', () => {
  const fx = makeDb();
  const nowS = Math.floor(Date.now() / 1000);
  fx.session({ timeCreated: nowS - 60, timeUpdated: nowS });
  fx.seal();
  const a = createOpencodeAdapter(opts(fx));
  try {
    const [s] = a.sessions();
    assert.ok(Math.abs(s.lastEventAt - Date.now()) < 5_000, `lastEventAt ${s.lastEventAt}`);
    assert.equal(s.status, 'busy');
  } finally { a.stop(); fx.cleanup(); }
});

// ---- parent / child --------------------------------------------------------

test('child sessions fold into the parent as agents and never list themselves', () => {
  const fx = makeDb();
  const parent = fx.session({ title: 'parent', timeUpdated: Date.now() - 1000 });
  const child = fx.session({ title: 'explore the repo', parentId: parent, model: 'gpt-5', timeUpdated: Date.now() });
  const grandchild = fx.session({ title: 'nested', parentId: child, timeUpdated: Date.now() });
  fx.seal();

  const a = createOpencodeAdapter(opts(fx));
  try {
    const list = a.sessions();
    assert.deepEqual(list.map((s) => s.id), [parent], 'only root sessions are Sessions');
    const [s] = list;
    assert.equal(s.agents.length, 2);
    const byId = new Map(s.agents.map((x) => [x.agentId, x]));
    assert.equal(byId.get(child).parentAgentId, null, 'a direct child hangs off the session');
    assert.equal(byId.get(child).type, 'opencode-subagent');
    assert.equal(byId.get(child).description, 'explore the repo');
    assert.equal(byId.get(child).model, 'gpt-5');
    assert.equal(byId.get(child).status, 'running');
    assert.equal(byId.get(child).workflowId, null);
    assert.equal(byId.get(child).transcriptPath, null);
    assert.equal(byId.get(grandchild).parentAgentId, child, 'flat list, parent links');
    assert.ok(s.lastEventAt >= byId.get(child).lastEventAt, 'child activity advances the parent');
  } finally { a.stop(); fx.cleanup(); }
});

test('a long-quiet child is done, and every child is done once opencode exits', () => {
  const fx = makeDb();
  const parent = fx.session({ title: 'parent' });
  fx.session({ title: 'stale', parentId: parent, timeUpdated: Date.now() - 40 * 60_000 });
  fx.session({ title: 'fresh', parentId: parent, timeUpdated: Date.now() });
  fx.seal();

  const live = createOpencodeAdapter(opts(fx));
  try {
    const byName = new Map(live.sessions()[0].agents.map((a) => [a.description, a.status]));
    assert.deepEqual(byName, new Map([['stale', 'done'], ['fresh', 'running']]));
  } finally { live.stop(); }

  const dead = createOpencodeAdapter(opts(fx, { processAlive: () => false }));
  try {
    assert.deepEqual(dead.sessions()[0].agents.map((a) => a.status), ['done', 'done']);
  } finally { dead.stop(); fx.cleanup(); }
});

test('an orphaned child is promoted to a session instead of disappearing', () => {
  const fx = makeDb();
  const orphan = fx.session({ title: 'orphan', parentId: 'ses_deleted' });
  fx.seal();
  const a = createOpencodeAdapter(opts(fx));
  try { assert.deepEqual(a.sessions().map((s) => s.id), [orphan]); } finally { a.stop(); fx.cleanup(); }
});

test('a parent_id cycle terminates', () => {
  const fx = makeDb();
  const x = fx.session({ id: 'ses_x', title: 'x' });
  fx.session({ id: 'ses_y', title: 'y', parentId: x });
  // parent_id carries no foreign key, so a loop is representable on disk.
  const db = new DatabaseSync(fx.dbPath);
  db.exec("update session set parent_id = 'ses_y' where id = 'ses_x'");
  db.close();
  fx.seal();

  const a = createOpencodeAdapter(opts(fx));
  try {
    // Both rows are children now, so neither is a root and nothing is listed —
    // the point is that resolving them returns at all.
    assert.deepEqual(a.sessions(), []);
  } finally { a.stop(); fx.cleanup(); }
});

// ---- status ----------------------------------------------------------------

test('status: busy when fresh, idle when quiet, ended with no opencode process', () => {
  const fx = makeDb();
  fx.session({ id: 'ses_fresh', timeUpdated: Date.now() - 2_000 });
  fx.session({ id: 'ses_quiet', timeUpdated: Date.now() - 10 * 60_000 });
  fx.seal();

  const live = createOpencodeAdapter(opts(fx));
  try {
    const byId = new Map(live.sessions().map((s) => [s.id, s.status]));
    assert.equal(byId.get('ses_fresh'), 'busy');
    assert.equal(byId.get('ses_quiet'), 'idle');
  } finally { live.stop(); }

  const dead = createOpencodeAdapter(opts(fx, { processAlive: () => false }));
  try {
    assert.deepEqual([...new Set(dead.sessions().map((s) => s.status))], ['ended']);
  } finally { dead.stop(); fx.cleanup(); }
});

test('no rows means no process probe at all', () => {
  const fx = makeDb();
  fx.seal();
  let probes = 0;
  const a = createOpencodeAdapter(opts(fx, { processAlive: () => { probes++; return true; } }));
  try {
    assert.deepEqual(a.sessions(), []);
    a.refresh();
    assert.equal(probes, 0, 'pgrep must not be spawned for an empty database');
  } finally { a.stop(); fx.cleanup(); }
});

// ---- legacy schema ---------------------------------------------------------

test('legacy message/part schema still yields sessions and turns', () => {
  const fx = makeDb({ legacy: true });
  const id = fx.session({ title: 'legacy', timeUpdated: Date.now() });
  fx.message(id, 'user');
  fx.message(id, 'assistant');
  fx.message(id, 'user');
  fx.message(id, 'user');
  fx.seal();

  const a = createOpencodeAdapter(opts(fx));
  try {
    const [s] = a.sessions();
    assert.equal(s.id, id);
    assert.equal(s.turns, 3);
    assert.deepEqual(s.todos, [], 'no todo table in the legacy schema');
  } finally { a.stop(); fx.cleanup(); }
});

test('a session table with no message table at all is still served', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-oc-'));
  const db = new DatabaseSync(path.join(dir, 'opencode.db'));
  db.exec(V2_SCHEMA[0]);
  db.prepare(`insert into session (id, project_id, slug, directory, title, version, cost, time_created, time_updated)
    values ('ses_bare','prj_1','s','/work/bare','bare','1.0.0',0,?,?)`).run(Date.now() - 1000, Date.now());
  db.close();

  const a = createOpencodeAdapter({ dataDir: dir, pollMs: 0, processAlive: () => true });
  try {
    const [s] = a.sessions();
    assert.equal(s.id, 'ses_bare');
    assert.equal(s.turns, 0);
  } finally { a.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- inertness -------------------------------------------------------------

test('an absent opencode.db yields an inert adapter, not a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-oc-'));
  let changes = 0;
  const a = createOpencodeAdapter({ dataDir: dir, onChange: () => changes++ });
  try {
    assert.deepEqual(a.sessions(), []);
    assert.deepEqual(a.digestEvents(0), []);
    assert.equal(a.exportPath('ses_1'), null);
    assert.equal(a.distill('ses_1'), null);
    assert.equal(changes, 0);
    a.stop();
    a.stop();                                  // idempotent
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dataDir resolution: OPENCODE_DATA_DIR wins, then XDG_DATA_HOME, then ~/.local/share', () => {
  const fx = makeDb();
  fx.session({ title: 'found me' });
  fx.seal();
  const probe = (env, home) => {
    const a = createOpencodeAdapter({ env, home, pollMs: 0, processAlive: () => true });
    try { return a.sessions().map((s) => s.title); } finally { a.stop(); }
  };
  try {
    assert.deepEqual(probe({ OPENCODE_DATA_DIR: fx.dir, XDG_DATA_HOME: '/nope' }, '/nope'), ['found me']);
    assert.deepEqual(probe({ XDG_DATA_HOME: path.dirname(fx.dir) }, '/nope'), [], 'XDG wants <dir>/opencode');
    // ~/.local/share/opencode/opencode.db under a fixture home
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-home-'));
    const target = path.join(home, '.local', 'share', 'opencode');
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(fx.dbPath, path.join(target, 'opencode.db'));
    assert.deepEqual(probe({}, home), ['found me']);
    fs.rmSync(home, { recursive: true, force: true });
  } finally { fx.cleanup(); }
});

test('exportPath, distill and digestEvents are empty for this source', () => {
  const fx = makeDb();
  const id = fx.session({ title: 'no file' });
  fx.seal();
  const a = createOpencodeAdapter(opts(fx));
  try {
    assert.equal(a.exportPath(id), null);
    assert.equal(a.distill(id), null);
    assert.deepEqual(a.digestEvents(0), []);
  } finally { a.stop(); fx.cleanup(); }
});

// ---- read-only -------------------------------------------------------------

test('reading a session leaves the database byte-identical and creates no wal', () => {
  const fx = makeDb();
  const id = fx.session({ title: 'untouched', cost: 0.5 });
  fx.message(id, 'user');
  fx.todo(id, 'a todo', 'pending', 0);
  fx.seal();

  const before = sha(fx.dbPath);
  const a = createOpencodeAdapter(opts(fx));
  try {
    assert.equal(a.sessions().length, 1);
    a.refresh();
    a.refresh();
  } finally { a.stop(); }

  assert.equal(sha(fx.dbPath), before, 'the adapter wrote to opencode.db');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert.equal(fs.existsSync(fx.dbPath + suffix), false, `adapter created opencode.db${suffix}`);
  }
  fx.cleanup();
});

test('a read-only adapter cannot write even when asked to', () => {
  const fx = makeDb();
  fx.session({ title: 'guarded' });
  fx.seal();
  // Same open the adapter performs, proving readOnly is what forbids the write.
  const db = new DatabaseSync(fx.dbPath, { readOnly: true });
  try {
    assert.throws(() => db.exec("update session set title = 'tampered'"), /readonly|read-only/i);
  } finally { db.close(); fx.cleanup(); }
});

// ---- change notification ---------------------------------------------------

test('refresh reports movement only when the projection actually changed', () => {
  const fx = makeDb();
  const id = fx.session({ title: 'first', timeUpdated: Date.now() });
  fx.seal();

  const a = createOpencodeAdapter(opts(fx));
  try {
    assert.equal(a.refresh(), false, 'a quiet database moves nothing');
    const db = new DatabaseSync(fx.dbPath);
    db.prepare('insert into session (id, project_id, slug, directory, title, version, cost, time_created, time_updated) values (?,?,?,?,?,?,?,?,?)')
      .run('ses_second', 'prj_1', 's2', '/work/two', 'second', '1.0.0', 0, Date.now(), Date.now());
    db.close();
    assert.equal(a.refresh(), true, 'a new session is movement');
    assert.deepEqual(a.sessions().map((s) => s.title).sort(), ['first', 'second']);
    assert.equal(a.refresh(), false);
    assert.ok(id);
  } finally { a.stop(); fx.cleanup(); }
});

// ---- merged into the daemon -------------------------------------------------

/** A Claude-shaped adapter over one real file, so /export has something to serve. */
function claudeStub(dir) {
  const file = path.join(dir, 'claude-sess.jsonl');
  fs.writeFileSync(file, '{"type":"user"}\n');
  const s = {
    id: 'claude-sess', source: 'claude', name: 'br-sfn-32', status: 'busy',
    lastEventAt: Date.now(), transcriptPath: file, agents: [], todos: [], recentTools: [],
  };
  return {
    file,
    sessions: () => [s],
    digestEvents: () => [{ at: 5, sessionId: 'claude-sess', name: 'br-sfn-32', kind: 'turn', data: {} }],
    exportPath: (id) => (id === 'claude-sess' ? file : null),
    distill: async function* (id) { yield `# ${id}\n`; },
    stop() { this.stopped = true; },
  };
}

async function withMerged(fx, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-merge-'));
  const claude = claudeStub(dir);
  const oc = createOpencodeAdapter(opts(fx));
  const adapter = composeAdapters([claude, oc]);
  const server = createServer({ adapter, host: 'testbox', version: '9.9.9' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn({ base, adapter, claude, oc }); }
  finally {
    await new Promise((r) => server.close(r));
    adapter.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the daemon serves both sources from one model', async () => {
  const fx = makeDb();
  const id = fx.session({ title: 'opencode work', timeUpdated: Date.now() });
  fx.seal();
  await withMerged(fx, async ({ base }) => {
    const model = await (await fetch(base + '/model')).json();
    assert.deepEqual(model.sessions.map((s) => s.source).sort(), ['claude', 'opencode']);
    // newest first, across sources
    assert.deepEqual([...model.sessions].sort((a, b) => b.lastEventAt - a.lastEventAt).map((s) => s.id),
      model.sessions.map((s) => s.id));
    const detail = await (await fetch(`${base}/session/${id}`)).json();
    assert.equal(detail.source, 'opencode');
    assert.equal(detail.title, 'opencode work');
  });
  fx.cleanup();
});

test('/export 404s plainly for an opencode session and still serves a Claude one', async () => {
  const fx = makeDb();
  const id = fx.session({ title: 'no file here' });
  fx.seal();
  await withMerged(fx, async ({ base, claude }) => {
    for (const format of ['jsonl', 'md']) {
      const r = await fetch(`${base}/export?session=${id}&format=${format}`);
      assert.equal(r.status, 404, `${format} export of an opencode session`);
      assert.match(r.headers.get('content-type') || '', /text\/plain/);
      assert.ok((await r.text()).length > 0, 'the 404 says something');
    }
    const ok = await fetch(`${base}/export?session=claude-sess&format=jsonl`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), fs.readFileSync(claude.file, 'utf8'));
  });
  fx.cleanup();
});

test('composeAdapters merges digests in time order and stops every source', () => {
  const fx = makeDb();
  fx.session({ title: 'x' });
  fx.seal();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-merge-'));
  const claude = claudeStub(dir);
  const oc = createOpencodeAdapter(opts(fx));
  const adapter = composeAdapters([claude, oc, null]);
  try {
    assert.deepEqual(adapter.digestEvents(0).map((e) => e.at), [5]);
    assert.equal(adapter.exportPath('nobody-owns-this'), null);
    // The replay flag is opt-in per source: opencode defines none at all, and a
    // source that says nothing is not holding a summary back.
    assert.equal(adapter.caughtUp('claude-sess'), true);
    claude.caughtUp = (id) => id !== 'claude-sess';
    assert.equal(adapter.caughtUp('claude-sess'), false, 'one source still replaying is enough to wait');
    adapter.stop();
    assert.equal(claude.stopped, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fx.cleanup(); }
});

// ---- schema shifting under a live adapter ----------------------------------

test('a table vanishing mid-refresh degrades to empty instead of throwing', () => {
  // The exact scenario the dual-schema support exists for: an opencode migration
  // drops the legacy `message` table while the daemon holds an open connection.
  // A throw here escapes the poll timer and takes the whole daemon down, Claude
  // sessions included.
  const fx = makeDb({ legacy: true });
  const id = fx.session({ title: 'mid-migration', timeUpdated: Date.now() });
  fx.message(id, 'user');
  fx.seal();

  const a = createOpencodeAdapter(opts(fx));
  try {
    assert.equal(a.sessions()[0].turns, 1);

    const db = new DatabaseSync(fx.dbPath);
    db.exec('drop table message');
    db.close();

    assert.doesNotThrow(() => a.refresh(), 'refresh must survive a dropped table');
    // Connection was dropped and reopened, so the next pass re-reads the schema
    // and the session is served again — now as the v2-less shape, turns 0.
    const [s] = a.sessions();
    assert.equal(s.id, id);
    assert.equal(s.turns, 0);
  } finally { a.stop(); fx.cleanup(); }
});

test('a poll tick never throws out of the timer', () => {
  const fx = makeDb();
  fx.session({ title: 'first' });
  fx.seal();
  // onChange is the daemon's code, on the other side of the fence; if it throws,
  // the timer callback must still not become an uncaughtException.
  let calls = 0;
  const a = createOpencodeAdapter(opts(fx, {
    pollMs: 0,
    onChange: () => { calls++; throw new Error('boom'); },
  }));
  try {
    // A quiet database moves nothing, so onChange would never be reached and the
    // guard would never be exercised: make the projection actually change first.
    const db = new DatabaseSync(fx.dbPath);
    db.prepare('insert into session (id, project_id, slug, directory, title, version, cost, time_created, time_updated) values (?,?,?,?,?,?,?,?,?)')
      .run('ses_mover', 'prj_1', 's', '/work/mover', 'mover', '1.0.0', 0, Date.now(), Date.now());
    db.close();

    assert.doesNotThrow(() => a.tick());
    assert.equal(calls, 1, 'onChange never ran, so the guard was never tested');
  } finally { a.stop(); fx.cleanup(); }
});

test('a wal write is picked up and reported through onChange', async () => {
  const fx = makeDb();
  fx.session({ title: 'watched', timeUpdated: Date.now() });
  fx.seal();

  let changes = 0;
  const a = createOpencodeAdapter(opts(fx, { pollMs: 30, onChange: () => changes++ }));
  try {
    const db = new DatabaseSync(fx.dbPath);
    db.exec('pragma journal_mode = wal');
    db.prepare('insert into session (id, project_id, slug, directory, title, version, cost, time_created, time_updated) values (?,?,?,?,?,?,?,?,?)')
      .run('ses_late', 'prj_1', 's3', '/work/three', 'late arrival', '1.0.0', 0, Date.now(), Date.now());
    db.close();
    const deadline = Date.now() + 4000;
    while (changes === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok(changes > 0, 'the poller never noticed the write');
    assert.ok(a.sessions().some((s) => s.title === 'late arrival'));
  } finally { a.stop(); fx.cleanup(); }
});
