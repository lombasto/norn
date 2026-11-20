// Runs page data (META-GENERAL-DESIGN 6, 12-S6): one root per RUN, children from the transcript. Transcripts and Codex rollouts
// are tailed incrementally (byte offset cache; only complete appended lines are parsed). Unknown records are ignored (design 13).
import fs from 'node:fs';
import path from 'node:path';
import { parseCodexLog } from './runs.mjs';
import { runName } from './names.mjs';
import { handoffOf } from './lanes.mjs';
import { findTranscript, findTranscriptA, usageCtx } from './harness/claude.mjs';
import { ctxView } from './ctxlimit.mjs';
import { critiqueOfNode } from './critique.mjs';
import { findRollout, findRolloutA } from './harness/codex.mjs';
import { statS, statA, readdirS, readdirA, readJsonS, readText as readTextS, readTextA } from './fsnap.mjs';

// the Runs page's window (owner 2026-11-19): ended runs stay in the tree for 2 h by default; the page widens it to 12 h, 24 h or
// since local midnight so last night's runs can be checked. windowMs(key, now) = the window in ms (null: not a window key)
export const RUN_WINDOWS = ['2h', '12h', '24h', 'today'];
export const windowMs = (key, now = Date.now()) => key === 'today' ? now - new Date(now).setHours(0, 0, 0, 0) : { '2h': 2, '12h': 12, '24h': 24 }[key] * 3600000 || null;
const RECENT_MS = windowMs('2h');
const BURN_MS = 30 * 60000;      // "burning" window (design 6)

// tail(file, cache, onRecord): parse the complete lines appended since the cached offset; returns { c, bytesRead }
// META-DASH-ASYNC R1: the stat is snapshot-aware; tailA (fs.promises) advances the same cache first, so inside a primed request the
// sync tail finds offset == size and reads nothing
function tailStart(file, cache, init, st) {
  let c = cache.get(file);
  if (!c || st.size < c.offset) { c = { offset: 0, ...init() }; cache.set(file, c); }
  return c;
}
function tailParse(c, buf, n, onRecord) {
  const nl = buf.subarray(0, n).lastIndexOf(10);
  if (nl < 0) return 0;
  for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    onRecord(c, j);
  }
  c.offset += nl + 1; return nl + 1;
}
export function tail(file, cache, init, onRecord) {
  const st = statS(file); if (!st) return null;
  const c = tailStart(file, cache, init, st);
  let bytesRead = 0;
  if (st.size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.offset);
      bytesRead = tailParse(c, buf, fs.readSync(fd, buf, 0, buf.length, c.offset), onRecord);
    } finally { fs.closeSync(fd); }
  }
  return { c, bytesRead };
}
/** tail on fs.promises (the same cache and parse) */
export async function tailA(file, cache, init, onRecord) {
  const st = await statA(file); if (!st) return null;
  const c = tailStart(file, cache, init, st);
  let bytesRead = 0;
  if (st.size > c.offset) {
    const at = c.offset, fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - at);
      const { bytesRead: n } = await fh.read(buf, 0, buf.length, at);
      if (c.offset === at) bytesRead = tailParse(c, buf, n, onRecord);   // a concurrent tailA of the same file may have advanced it
    } finally { await fh.close(); }
  }
  return { c, bytesRead };
}

function onTranscript(c, j) {
  if (j.timestamp && (!c.first || j.timestamp < c.first)) c.first = j.timestamp;
  if (j.timestamp && (!c.last || j.timestamp > c.last)) c.last = j.timestamp;
  const m = j.message, u = m?.usage;
  if (j.type !== 'assistant' || !u) return;
  const key = (m.id || '') + ':' + (j.requestId || '');
  if (c.seen.has(key)) return;
  c.seen.add(key);
  if (m.model) c.model = m.model;
  if (j.effort) c.effort = j.effort;
  c.ctx = usageCtx(u);
  c.peak = Math.max(c.peak ?? 0, c.ctx);
  c.entries.push([Date.parse(j.timestamp), u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0]);
}
const tInit = () => ({ seen: new Set(), entries: [], model: null, effort: null, ctx: null, peak: null, first: null, last: null });

/** One transcript: { model, effort, first, last, ctx (last call in+cacheR+cacheC), peak (its largest call), cacheR (sum), burn30, bytesRead }. */
export function transcriptInfo(file, cache = new Map(), { now = Date.now() } = {}) {
  const r = tail(file, cache, tInit, onTranscript);
  if (!r) return null;
  const { c } = r;
  let cacheR = 0, burn30 = 0;
  for (const [t, cr, cc] of c.entries) { cacheR += cr; if (t >= now - BURN_MS) burn30 += cr + cc; }
  return { model: c.model, effort: c.effort, first: c.first, last: c.last, ctx: c.ctx, peak: c.peak, cacheR, burn30, said: c.entries.length > 0, bytesRead: r.bytesRead };
}

const readJson = readJsonS;

const subNames = ents => ents.map(e => e.name).filter(n => /^agent-.+\.jsonl$/.test(n)).sort();
const subDir = mainFile => path.join(mainFile.replace(/\.jsonl$/, ''), 'subagents');
/** Subagents of a main transcript: <sid>/subagents/agent-<id>.jsonl + agent-<id>.meta.json. */
export function subagents(mainFile, cache = new Map(), { now = Date.now() } = {}) {
  const dir = subDir(mainFile), names = subNames(readdirS(dir));
  return names.map(n => {
    const id = n.slice('agent-'.length, -'.jsonl'.length);
    const meta = readJson(path.join(dir, `agent-${id}.meta.json`)) || {};
    const t = transcriptInfo(path.join(dir, n), cache, { now }) || {};
    const finished = meta.finished === true;
    return { id, kind: 'subagent', agentType: meta.agentType ?? null, description: meta.description ?? null, model: t.model ?? null,
      effort: meta.effort ?? t.effort ?? null, finished, state: finished ? 'finished' : 'running', first: t.first ?? null,
      last: t.last ?? null, ctx: t.ctx ?? null, cacheR: t.cacheR ?? 0, burn30: t.burn30 ?? 0 };
  });
}

/** Codex rollout: the last token_count event -> { total, last, window, ts }. */
const cInit = () => ({ total: null, last: null, window: null, ts: null });
function onRollout(c, j) {
  const info = j.type === 'event_msg' && j.payload?.type === 'token_count' ? j.payload.info : null;
  if (!info) return;
  c.total = info.total_token_usage?.total_tokens ?? c.total;
  c.last = info.last_token_usage?.total_tokens ?? c.last;
  c.window = info.model_context_window ?? c.window;
  c.ts = j.timestamp ?? c.ts;
}
export function codexInfo(file, cache = new Map()) {
  const r = tail(file, cache, cInit, onRollout);
  return r ? { total: r.c.total, last: r.c.last, window: r.c.window, ts: r.c.ts } : null;
}

// the file locations are the adapters' (harness-agnostic feed, LANE-MAP-DESIGN 2); re-exported for the Runs page and its tests
export { findTranscript } from './harness/claude.mjs';
export { findRollout } from './harness/codex.mjs';

const readText = f => { try { return readTextS(f); } catch { return null; } };
/**
 * handoffOf's talked(id) (lanes.mjs): has run r's session produced its first model event? Claude: an assistant call with usage in
 * its transcript (the prompt line alone is not the session talking); Codex: a token_count event in its rollout; an executor with
 * no session file (cli) has nothing to wait for: true. o: { projectsDir, codexDir, cache } (the tree's own tail cache).
 */
export function runTalked(r, o = {}) {
  const d = r?.data || {}, end = r?.end || {}, exe = d.executor || '', cache = o.cache || new Map();
  if (exe.startsWith('codex')) { const b = d.log ? parseCodexLog(readText(d.log)) : {}, f = findRollout(o.codexDir, end.codex_session ?? b.session_id); return !!(f && codexInfo(f, cache)?.ts); }
  if (d.kind === 'cli') return true;
  const f = end.transcript || d.transcript || findTranscript(o.projectsDir, d.session_id);
  return !!(f && transcriptInfo(f, cache)?.said);
}
const ended = r => r.state !== 'running';
/** when run r ended: the ts of its last end / lost / kill event (a later review or resume verdict is no end); null while running */
export const endedAt = r => ended(r) ? [...(r.history || [])].reverse().find(h => h.ev === 'end' || h.ev === 'lost' || h.ev === 'kill')?.ts ?? null : null;
const QUEUE_STATES = ['queued', 'claimed', 'filled', 'withdrawn'];   // claimed: a node runs it under its own id
// a queue entry is no session: the Runs page lists the queued ones apart (META-GT12); ended runs stay `win` ms (RECENT_MS)
const shown = (r, now, win = RECENT_MS) => !QUEUE_STATES.includes(r.state) && !(ended(r) && now - Date.parse(endedAt(r)) > win);
// NORN-UI-RUNS: the Runs page asks its live runs first (part 'live') and the ended ones after (part 'history'); no part = both
export const RUN_PARTS = ['live', 'history'];
// a helper goes with its parent run (it nests under it), so a live run keeps its ended helpers
const inPart = (r, part, items) => { const p = r.data?.role === 'helper' && items[r.data.parent]; return !part || (part === 'live') === !ended(p || r); };
/** why run r ended: its last end / lost / kill event as { ev, by, why } (who stopped it and the reason); null while running */
export const stopOf = r => { const h = ended(r) ? [...(r.history || [])].reverse().find(x => x.ev === 'end' || x.ev === 'lost' || x.ev === 'kill') : null;
  return h ? { ev: h.ev, by: h.by ?? null, why: h.data?.why ?? null } : null; };
/** The run ids the Runs tree lists now (the Ledger tab links only those, LEDGER-UX R1). */
export const shownRunIds = (runs, now = Date.now()) => new Set([...runs].filter(r => r.kind === 'run' && shown(r, now)).map(r => r.id));

/**
 * META-DASH-ASYNC R1: every file agentsTree(runs, o) reads, read on fs.promises into the request snapshot (lib/fsnap.mjs) and the
 * transcript / rollout tails advanced in o.cache - the same file choices as agentsTree, so its sync reads are lookups after this.
 */
export async function primeAgents(runs, o = {}) {
  const now = o.now ?? Date.now(), cache = o.cache || new Map();
  const one = async r => {
    const d = r.data || {}, end = r.end || {}, exe = d.executor || '';
    if (exe.startsWith('codex')) {
      const b = d.log ? parseCodexLog(await readTextA(d.log).catch(() => null)) : {};
      const rollout = await findRolloutA(o.codexDir, end.codex_session ?? b.session_id);
      if (rollout) await tailA(rollout, cache, cInit, onRollout);
    } else if (d.kind !== 'cli') {
      const file = end.transcript || d.transcript || await findTranscriptA(o.projectsDir, d.session_id);
      if (!file || !await tailA(file, cache, tInit, onTranscript)) return;
      const dir = subDir(file), names = subNames(await readdirA(dir));
      await Promise.all(names.flatMap(n => [readTextA(path.join(dir, n.replace(/\.jsonl$/, '.meta.json'))).catch(() => null), tailA(path.join(dir, n), cache, tInit, onTranscript)]));
    }
  };
  const items = Object.fromEntries([...runs].map(x => [x.id, x]));
  await Promise.all([...runs].filter(x => x.kind === 'run' && shown(x, now, o.window) && inPart(x, o.part, items)).map(one));
}
/**
 * Agents tree (design 6): one root per RUN (running, or ended within o.window ms, default 2 h) + one root per talk session.
 * o: { projectsDir, codexDir, cache (Map, kept by the server), now, window, part ('live' | 'history' | none: RUN_PARTS), policy (the project's: each run's context lines), sessions [{name, model, effort, alive, context}] }
 * Times: started = the start event, ended = endedAt (null while running), ran_min = start to end (start to now while running).
 * META-CTX-ENFORCE R1: ctx = the run's CURRENT context (its last request), ctx_peak beside it, ctx_limit / ctx_hard = its role's policy lines.
 */
export function agentsTree(runs, o = {}) {
  const now = o.now ?? Date.now(), cache = o.cache || new Map();
  const roots = [], items = Object.fromEntries([...runs].map(x => [x.id, x]));
  // the live hand-off state (lanes.mjs handoffOf): o.wrote(id) = the run's result says HANDOFF; talked from the same tail cache
  const ho = { now, wrote: o.wrote, talked: id => runTalked(items[id], { ...o, cache }) };
  for (const r of [...runs].filter(x => x.kind === 'run').sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)))) {
    if (!shown(r, now, o.window) || !inPart(r, o.part, items)) continue;
    const d = r.data || {}, end = r.end || {};
    const node = { id: r.id, name: runName(r), kind: d.kind ?? null, executor: d.executor ?? null, lane: d.lane ?? null, stage: d.stage ?? null,
      model: end.model ?? d.model ?? null, effort: end.effort ?? d.effort ?? null, state: r.state, outcome: end.outcome ?? null, stop: stopOf(r),
      critique: d.class === 'planning' ? critiqueOfNode(runs, r.id) : null,   // META-DOD 3: the plan's review
      dod_ready: d.dod_ready ?? null, dod: end.dod ? { ok: end.dod.ok, why: end.dod.why ?? null, tests: (end.dod.tests || []).map(({ name, code, counts, log }) => ({ name, code, counts, log })) } : null,   // META-DOD 1
      started: r.created, ended: endedAt(r), ran_min: Math.max(0, Math.round(((ended(r) ? Date.parse(endedAt(r)) : now) - Date.parse(r.created)) / 60000)), budget_min: d.budget_min ?? null,
      ctx: null, ctx_peak: null, ctx_limit: null, ctx_hard: null, cacheR: null, burn30: null, tokens: null, tokens_src: null, children: [],
      handoff: d.role === 'helper' ? null : handoffOf(r, items, ho) };
    const exe = d.executor || '';
    if (exe.startsWith('codex')) {
      const b = d.log ? parseCodexLog(readText(d.log)) : {};
      node.model = b.model ?? node.model; node.effort = b.effort ?? node.effort;
      const rollout = findRollout(o.codexDir, end.codex_session ?? b.session_id);
      const ci = rollout ? codexInfo(rollout, cache) : null;
      if (ci && ci.total !== null) { node.tokens = ci.total; node.tokens_src = 'live'; node.ctx = ci.last; }
      else if (Number.isInteger(end.tokens ?? b.tokens)) { node.tokens = end.tokens ?? b.tokens; node.tokens_src = 'end'; }
    } else if (d.kind === 'cli') {   // a cli executor's plain output carries no usage
      node.tokens = '-';
    } else {   // a check-in too: its end usage SUMS its requests (RUN-869: "1176k" for a 64k session) - the transcript has the truth
      const file = end.transcript || d.transcript || findTranscript(o.projectsDir, d.session_id);
      const t = file ? transcriptInfo(file, cache, { now }) : null;
      if (t) {
        Object.assign(node, { ctx: t.ctx, ctx_peak: t.peak, cacheR: t.cacheR, burn30: t.burn30, model: t.model ?? node.model, effort: t.effort ?? node.effort });
        node.children = subagents(file, cache, { now });
      }
      // a claude-compatible provider bills its own account: no Claude-plan burn; tokens from the CLI final json (META-EXEC-S1)
      if (d.kind === 'provider') {
        node.burn30 = null; node.billing = exe; node.children = node.children.map(c => ({ ...c, burn30: null }));
        const u = end.usage;
        if (u) { node.tokens = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((a, k) => a + (Number(u[k]) || 0), 0); node.tokens_src = 'end'; }
      }
    }
    if (d.kind !== 'interactive' && d.kind !== 'cli') { const v = ctxView(d, o.policy); node.ctx_limit = v.ctx_limit; node.ctx_hard = v.ctx_hard; node.ctx_role = v.ctx_role; }
    if (d.role === 'helper') Object.assign(node, { kind: 'helper', parent: d.parent ?? null, q: d.q ?? null, class: d.class ?? null });
    if (node.tokens === null && end.usage) { node.tokens = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((a, k) => a + (Number(end.usage[k]) || 0), 0); node.tokens_src = 'end'; }
    roots.push(node);
  }
  // helpers (norn delegate) nest under their parent run; the parent carries its helper usage { n, running, tokens }
  const byId = new Map(roots.map(n => [n.id, n]));
  for (const n of [...roots]) {
    const p = n.kind === 'helper' && byId.get(n.parent);
    if (!p || p === n) continue;
    roots.splice(roots.indexOf(n), 1);
    p.children.push(n);
    const h = p.helpers ??= { n: 0, running: 0, tokens: 0 };
    h.n++; if (n.state === 'running') h.running++; if (Number.isFinite(n.tokens)) h.tokens += n.tokens;
  }
  for (const s of o.part === 'history' ? [] : o.sessions || []) roots.push({ id: `talk:${s.name}`, kind: 'talk', executor: 'claude', lane: null, model: s.model ?? null,
    effort: s.effort ?? null, state: s.alive ? 'alive' : 'stopped', started: s.created ?? null, ctx: s.context ?? null, children: [] });
  return roots;
}
