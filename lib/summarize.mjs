// OpenRouter summarizer: one short line per id, from the material handed in.
// The defaults answer "what is this session doing now"; every knob is an option,
// so a second instance can answer a different question over the same machinery.
//
// Standalone by design — it knows nothing about transcripts, the adapter or the
// daemon, only about the {version, text} material handed to it. get() never
// blocks and never throws: it answers from cache and, at most once per
// minIntervalMs per session, fires a refresh in the background. A model that is
// down, slow or rate-limited must read as a missing summary, never as a broken
// dashboard, so every failure path ends in a cooldown and silence.
//
// The API key is passed in, never read from the environment here, and never
// reaches a log line, an error, a thrown value or a file on disk.
//
// Nothing reaches OpenRouter unscrubbed and nothing comes back unscrubbed
// either: the material is redacted on the way out (the choke point every
// adapter passes through, whatever it did to its own text) and the reply is
// redacted on the way in, because a model handed a secret can echo it straight
// back into a line this file persists to disk and the dashboard renders.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { redact } from './redact.mjs';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.5-flash';
const TIMEOUT_MS = 10_000;
// Slack, not the cap: OpenRouter counts reasoning tokens against max_tokens, so
// a budget sized to the answer alone is spent thinking and comes back empty —
// silently, forever. Reasoning is off below and TEXT_MAX is the real cut.
const MAX_TOKENS = 64;
const TEXT_MAX = 64;        // hard cut on the reply, however the model reads the word limit
const MATERIAL_MAX = 4000;  // what one summary is allowed to cost, in chars
const COOLDOWN_MS = 300_000;
const RETENTION = 7 * 86_400_000;
// A ceiling on what this instance can have in the air at once, whatever the
// caller's cadence is: sessions trickle in, but a tree of subagents does not,
// and one tick meeting eighty unseen ids would be the whole cost of a feature
// spent in a single breath. An id over the cap is not claimed and buys no
// cooldown — the next get() picks it up once a slot is free.
const MAX_INFLIGHT = 4;

// Two caps, always: the prompt asks for 4 words and the code cuts at 64 chars.
// A model that ignores the instruction still cannot push a paragraph into a card.
const SYSTEM = 'Write a 3-4 word title for what this coding session is doing right now. '
  + 'Same language as the conversation. No preamble. No trailing punctuation.';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// Every knob below defaults to the session-title summarizer this file was
// written for; a second one is the same machine asked a different question.
export function createSummarizer({
  apiKey,
  model = process.env.AGENTTRAIL_SUMMARY_MODEL || MODEL,
  dir,
  minIntervalMs = COOLDOWN_MS,
  fetchImpl = fetch,
  onUpdate = () => {},
  system = SYSTEM,
  textMax = TEXT_MAX,
  maxTokens = MAX_TOKENS,
  maxInflight = MAX_INFLIGHT,
  cacheFile = 'summaries.json',
  logFile = 'summaries-log.jsonl',
  history = true,
} = {}) {
  if (!apiKey) throw new TypeError('createSummarizer needs an apiKey');

  const stateDir = dir || path.join(os.homedir(), '.agenttrail');
  const cachePath = path.join(stateDir, cacheFile);
  const logPath = path.join(stateDir, logFile);
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}

  const cache = new Map();       // sessionId -> {text, at, version}
  const nextAt = new Map();      // sessionId -> earliest ms for the next attempt
  const inflight = new Map();    // sessionId -> the refresh promise in the air
  const controllers = new Set(); // live requests, so stop() does not hold the process for 10s
  let stopped = false;

  const cut = Date.now() - RETENTION;

  // ---- cache -----------------------------------------------------------------
  // A corrupt or half-written cache is the same as no cache: summaries are
  // regenerated in minutes, and refusing to boot over them would be worse.
  // Entries older than the log retention are dropped so the file a daemon
  // rewrites on every refresh stays small on a machine that runs for months.
  for (const [id, v] of Object.entries(readJson(cachePath) || {})) {
    if (v && typeof v.text === 'string' && Number.isFinite(v.at) && v.at >= cut) {
      cache.set(id, { text: v.text, at: v.at, version: String(v.version ?? '') });
    }
  }

  const save = () => {
    const tmp = `${cachePath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(cache)));
      fs.renameSync(tmp, cachePath);
    } catch {}
  };

  // ---- history log -----------------------------------------------------------
  // Read and pruned once at construction, then served from memory and appended
  // to in step with the file — the parse already happened, so keeping the rows
  // costs nothing a lazy read would have saved. With history off the file is
  // never read, written or created: a summary of something immutable is written
  // once and never changes, so its history would only ever repeat one line.
  const log = [];
  let dropped = false;
  for (const line of (() => { try { return history ? fs.readFileSync(logPath, 'utf8').split('\n') : []; } catch { return []; } })()) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { dropped = true; continue; }
    if (!e || typeof e.text !== 'string' || !Number.isFinite(e.at) || e.at < cut) { dropped = true; continue; }
    log.push({ at: e.at, sessionId: String(e.sessionId ?? ''), text: e.text });
  }
  // Rewritten only when something actually went, so a boot with a fresh log is a
  // pure read. Not atomic: this is a history of one-liners, not a ledger.
  if (dropped) {
    try { fs.writeFileSync(logPath, log.length ? log.map((e) => JSON.stringify(e)).join('\n') + '\n' : ''); } catch {}
  }

  const append = (entry) => {
    if (!history) return;
    log.push(entry);
    try { fs.appendFileSync(logPath, JSON.stringify(entry) + '\n'); } catch {}
  };

  // ---- refresh ---------------------------------------------------------------
  async function refresh(id, material) {
    try {
      // Last stop before the wire. The adapter scrubs its own material too, but
      // this is the line that is actually load-bearing: a future adapter that
      // forgets, or one whose text is assembled somewhere else, still cannot
      // put a key in a request body from here.
      const sending = redact(String(material.text)).slice(0, MATERIAL_MAX);
      const ac = new AbortController();
      controllers.add(ac);
      let res;
      try {
        res = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            reasoning: { enabled: false },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: sending },
            ],
          }),
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        });
      } finally { controllers.delete(ac); }

      // Every error below is thrown bare and swallowed by the catch: nothing
      // derived from the request — headers included — is ever put in a message.
      if (!res || !res.ok) throw new Error('summary request failed');
      const data = await res.json();
      // The reply is scrubbed too, and before anything keeps it: it is about to
      // be written to summaries.json, appended to the history log and rendered
      // in a card, so a model that quoted a key back at us would leak it three
      // times over from a single request.
      const text = redact(String(data?.choices?.[0]?.message?.content ?? '')).trim().slice(0, textMax);
      if (!text) throw new Error('summary reply empty');
      if (stopped) return;

      const at = Date.now();
      cache.set(id, { text, at, version: material.version });
      save();
      append({ at, sessionId: id, text });
      onUpdate(id);
    } catch {
      // Cooldown, not a retry loop: a session whose summary just failed waits
      // five minutes before costing another request, whatever the cadence is.
      nextAt.set(id, Date.now() + Math.max(COOLDOWN_MS, minIntervalMs));
    } finally {
      inflight.delete(id);
    }
  }

  // Claimed before the first await so a burst of ticks produces one request, and
  // the promise published after — a fetch that throws synchronously has already
  // run refresh()'s finally by the time this line is reached, and re-adding the
  // id there would leave a dead entry blocking every later attempt.
  function start(id, material) {
    inflight.set(id, null);
    const p = refresh(id, material);
    if (inflight.has(id)) inflight.set(id, p);
    return p;
  }

  return {
    /** Cached summary for a session; may fire a background refresh. Never blocks. */
    get(sessionId, material) {
      const hit = cache.get(sessionId) || null;
      const due = !stopped
        && material && material.text
        && (!hit || hit.version !== material.version)
        && !inflight.has(sessionId)
        && inflight.size < maxInflight
        && Date.now() >= (nextAt.get(sessionId) ?? 0);
      if (due) {
        nextAt.set(sessionId, Date.now() + minIntervalMs);
        start(sessionId, material);
      }
      return hit ? { text: hit.text, at: hit.at } : null;
    },

    /** Cache only. Never fires anything — what serving a payload is allowed to cost. */
    peek(sessionId) {
      const hit = cache.get(sessionId) || null;
      return hit ? { text: hit.text, at: hit.at } : null;
    },

    /** One summary, awaited: for the caller who asked for it and is waiting.
     *  A cached answer costs no request, concurrent callers for the same id
     *  share the one in the air, and a failure is null — never a throw.
     *  The cooldown a failure buys binds here exactly as it does in get(), or a
     *  reader clicking a dead button is an unbounded stream of paid requests. */
    async generate(sessionId, material) {
      const hit = cache.get(sessionId) || null;
      if (hit && material && hit.version === material.version) return { text: hit.text };
      if (stopped || !material || !material.text) return null;
      const live = inflight.get(sessionId);
      if (!live && Date.now() < (nextAt.get(sessionId) ?? 0)) return null;
      await (live ?? start(sessionId, material));
      const fresh = cache.get(sessionId) || null;
      return fresh && fresh.version === material.version ? { text: fresh.text } : null;
    },

    /** Every summary this session has had since sinceMs, oldest-first. */
    history(sessionId, sinceMs = 0) {
      return log
        .filter((e) => e.sessionId === sessionId && e.at >= sinceMs)
        .map((e) => ({ text: e.text, at: e.at }));
    },

    stop() {
      stopped = true;
      for (const ac of controllers) ac.abort();
      controllers.clear();
    },
  };
}
