// Builds a synthetic ~/.claude tree in a tmpdir. Tests NEVER touch the real one.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
const uuid = () => `0000${(++seq).toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;

const isAlive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * A distinct pid that IS running, so the adapter's real process.kill(pid,0)
 * check sees it as live. sessions/<pid>.json is keyed by pid, so two fixture
 * sessions must never share one.
 */
function alivePid(used) {
  for (const p of [process.pid, process.ppid, 1]) {
    if (p > 0 && !used.has(p) && isAlive(p)) { used.add(p); return p; }
  }
  for (let p = process.pid - 1; p > 1; p--) {
    if (!used.has(p) && isAlive(p)) { used.add(p); return p; }
  }
  throw new Error('no live pid available for the fixture');
}

/** A pid that is guaranteed not to be running right now. */
export function deadPid() {
  for (let i = 0; i < 20; i++) {
    const { pid } = spawnSync(process.execPath, ['-e', '0']);
    if (!pid) continue;
    try { process.kill(pid, 0); } catch { return pid; }   // ESRCH => reaped
  }
  throw new Error('could not obtain a dead pid');
}

// ---- record builders: shapes copied from real ~/.claude transcripts --------
const base = (o) => ({
  parentUuid: null, isSidechain: false, uuid: o.uuid ?? uuid(),
  timestamp: iso(o.at ?? Date.now()), userType: 'external', entrypoint: 'cli',
  cwd: o.cwd, sessionId: o.sessionId, version: o.version, gitBranch: o.gitBranch,
});

export const rec = {
  // Pass `toolId` (and/or `uuid`) when a matching toolResult has to name it.
  assistantTool: (o) => ({
    ...base(o), type: 'assistant', requestId: `req_${uuid()}`,
    message: {
      model: o.model ?? 'claude-opus-5[1m]', id: `msg_${uuid()}`, type: 'message', role: 'assistant',
      content: [{ type: 'tool_use', id: o.toolId ?? `toolu_${uuid()}`, name: o.name, input: o.input ?? {}, caller: { type: 'direct' } }],
      stop_reason: 'tool_use', usage: {},
    },
  }),

  // The result that ends one in-flight tool call. Real records carry BOTH the
  // block's tool_use_id and sourceToolAssistantUUID (the uuid of the assistant
  // record that opened it); omit `toolId` to exercise the uuid path alone.
  toolResult: (o) => ({
    ...base(o), type: 'user',
    toolUseResult: o.result ?? { stdout: 'ok', stderr: '', interrupted: false },
    ...(o.assistantUuid ? { sourceToolAssistantUUID: o.assistantUuid } : {}),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', ...(o.toolId ? { tool_use_id: o.toolId } : {}), content: 'ok' }],
    },
  }),

  assistantText: (o) => ({
    ...base(o), type: 'assistant',
    message: { model: o.model ?? 'claude-opus-5[1m]', id: `msg_${uuid()}`, type: 'message', role: 'assistant', content: [{ type: 'text', text: o.text }] },
  }),

  userPrompt: (o) => ({ ...base(o), type: 'user', message: { role: 'user', content: o.text } }),

  // user record carrying a subagent spawn/completion (parent's tool_result view)
  agentResult: (o) => ({
    ...base(o), type: 'user',
    toolUseResult: {
      isAsync: o.status !== 'completed', status: o.status ?? 'async_launched',
      agentId: o.agentId, description: o.description ?? null,
      agentType: o.agentType ?? 'general-purpose', resolvedModel: o.resolvedModel ?? 'claude-opus-5[1m]',
      prompt: o.prompt ?? 'go',
    },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: o.toolId ?? `toolu_${uuid()}`, content: 'ok' }] },
  }),

  turn: (o) => ({
    ...base(o), type: 'system', subtype: 'turn_duration',
    durationMs: o.durationMs ?? 1000, messageCount: o.messageCount ?? 1,
    pendingWorkflowCount: o.pendingWorkflowCount ?? 0, isMeta: false,
    sessionKind: o.sessionKind ?? 'interactive',
  }),

  compactBoundary: (o) => ({
    ...base(o), type: 'system', subtype: 'compact_boundary',
    content: 'Conversation compacted', level: 'info',
    compactMetadata: { trigger: 'manual', preTokens: 200000, postTokens: 20000 },
  }),

  aiTitle: (o) => ({ type: 'ai-title', aiTitle: o.title, sessionId: o.sessionId }),
  customTitle: (o) => ({ type: 'custom-title', customTitle: o.title, sessionId: o.sessionId }),
  agentName: (o) => ({ type: 'agent-name', agentName: o.title, sessionId: o.sessionId }),

  costState: (o) => ({
    type: 'cost-state', sessionId: o.sessionId, totalCostUSD: o.totalCostUSD,
    totalLinesAdded: o.totalLinesAdded ?? 0, totalLinesRemoved: o.totalLinesRemoved ?? 0,
    totalDuration: 1000, startTime: o.at ?? Date.now(), modelUsage: {},
  }),

  prLink: (o) => ({
    type: 'pr-link', sessionId: o.sessionId, prNumber: o.prNumber,
    prUrl: o.prUrl ?? `https://github.com/acme/repo/pull/${o.prNumber}`,
    prRepository: o.prRepository ?? 'acme/repo', timestamp: iso(o.at ?? Date.now()),
  }),

  // A record type the adapter must ignore entirely.
  noise: (o) => ({ ...base(o), type: 'attachment', content: o.text ?? 'x'.repeat(100) }),
};

// ---- the tree -------------------------------------------------------------
export function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrail-fx-'));
  const claudeDir = path.join(root, '.claude');
  const accountsDir = path.join(root, '.claude-accounts');
  const stateDir = path.join(root, '.agenttrail');
  fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'projects'), { recursive: true });
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  let n = 0;
  const usedPids = new Set();
  const fx = {
    root, claudeDir, accountsDir, stateDir,

    /** opts for createClaudeAdapter — polling and watching off by default. */
    opts(extra = {}) {
      return { claudeDir, accountsDir, stateDir, pollMs: 0, debounceMs: 1, ...extra };
    },

    session(o = {}) {
      const i = ++n;
      const id = o.id ?? `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const cwd = o.cwd ?? `/work/repo-${i}`;
      const slug = o.slug ?? cwd.replace(/\//g, '-');
      const pid = o.pid ?? alivePid(usedPids);          // distinct and alive
      const account = o.account ?? null;
      const version = o.version ?? '2.1.251';
      const gitBranch = o.gitBranch ?? 'develop';
      const startedAt = o.startedAt ?? Date.now() - 60_000;

      const projDir = path.join(claudeDir, 'projects', slug);
      const transcriptPath = path.join(projDir, `${id}.jsonl`);
      fs.mkdirSync(projDir, { recursive: true });
      if (!fs.existsSync(transcriptPath)) fs.writeFileSync(transcriptPath, '');

      const sessDir = account
        ? path.join(accountsDir, account, 'sessions')
        : path.join(claudeDir, 'sessions');

      const h = {
        id, cwd, slug, pid, account, transcriptPath, projDir,
        pidFile: path.join(sessDir, `${pid}.json`),

        live(patch = {}) {
          const cur = fs.existsSync(h.pidFile) ? JSON.parse(fs.readFileSync(h.pidFile, 'utf8')) : {};
          w(h.pidFile, JSON.stringify({
            pid: h.pid, sessionId: id, cwd, startedAt, version, kind: o.kind ?? 'interactive',
            entrypoint: 'cli', tmux: o.tmux ?? 'sess:@1.%1', name: o.name ?? null,
            nameSource: 'user', updatedAt: Date.now(), status: 'idle', statusUpdatedAt: Date.now(),
            ...cur, ...patch,
          }));
          return h;
        },

        /** Replace the live pid with one that is guaranteed dead. */
        kill() {
          const rec0 = JSON.parse(fs.readFileSync(h.pidFile, 'utf8'));
          fs.rmSync(h.pidFile);
          h.pid = deadPid();
          h.pidFile = path.join(sessDir, `${h.pid}.json`);
          w(h.pidFile, JSON.stringify({ ...rec0, pid: h.pid }));
          return h;
        },

        /** Append records built from the shared builders, with session defaults. */
        add(kind, extra = {}) {
          const r = rec[kind]({ sessionId: id, cwd, version, gitBranch, ...extra });
          fs.appendFileSync(transcriptPath, JSON.stringify(r) + '\n');
          return h;
        },

        /** Append arbitrary bytes — use to leave a half-written trailing line. */
        raw(text) { fs.appendFileSync(transcriptPath, text); return h; },

        /** Backdate the transcript so it falls outside the "busy" window. */
        touch(msAgo) { const t = (Date.now() - msAgo) / 1000; fs.utimesSync(transcriptPath, t, t); return h; },

        agent(a = {}) {
          const dir = a.workflowId
            ? path.join(projDir, id, 'subagents', 'workflows', a.workflowId)
            : path.join(projDir, id, 'subagents');
          const agentId = a.agentId ?? `a${String(++n).padStart(17, '0')}`;
          w(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({
            agentType: a.agentType ?? 'general-purpose', description: a.description ?? 'work',
            toolUseId: `toolu_${agentId}`, spawnDepth: a.spawnDepth ?? 1,
            model: a.model ?? 'opus',
            ...(a.parentAgentId ? { parentAgentId: a.parentAgentId } : {}),
          }));
          const jsonl = path.join(dir, `agent-${agentId}.jsonl`);
          fs.writeFileSync(jsonl, (a.lines ?? ['{"type":"assistant"}']).join('\n') + '\n');
          if (a.mtimeMs) { const t = a.mtimeMs / 1000; fs.utimesSync(jsonl, t, t); }
          return agentId;
        },

        workflowJournal(workflowId, entries) {
          const dir = path.join(projDir, id, 'subagents', 'workflows', workflowId);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'journal.jsonl'),
            entries.map((e) => JSON.stringify({ key: 'v2:k', ...e })).join('\n') + '\n');
          return h;
        },
      };

      return h.live(o.pidPatch);
    },

    cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} },
  };

  return fx;
}
