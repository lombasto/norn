// META-GUARD R1 (DIR-23, DIR-30): Norn guards the tokens while runs run.
// RUNAWAY WATCH: every live Claude run, from its transcript as it grows (standing.mjs - the one reader: turns, context per call,
// cumulative cache reads + output). Alarm when it passes k x the median of its PEERS (ended runs of the same kind + agent + effort,
// last peer_days) above a floor, or sits above its hand-off line for over_handoff_turns calls without handing off.
// CONTEXT GROWTH BY SOURCE: each piece of text a run appends (tool output by tool - test runners apart -, the model's own text,
// injected text) x the calls that re-read it from the cache = the cache reads it causes. TOOL-SPAM: one tool result over
// tool_result_k, or tool output over tool_share_pct of the run's cache reads.
// An alarm is a GRD record (guard.jsonl): the check-in reads it in the digest and rules it (let it run / mail it / stop it) - Norn
// never kills a run by itself. Chips on the run; notice class "usage" (batched into the FYI digest unless policy guard.push).
import { loadState, record, readEvents, recordsFile, fold, RecordError } from './records.mjs';
import { measureRun, roleOfRun, familyOf, runTranscript, scan, transcriptTrace } from './standing.mjs';
import { POLICY_DEFAULTS } from './policy.mjs';
import { ctxRole, ctxLimits } from './ctxlimit.mjs';

export const GUARD_DEFAULTS = POLICY_DEFAULTS.guard;   // policy.guard (policy.mjs: the defaults + settings rows)
export const GUARD_ACTIONS = ['let-run', 'mail', 'stop'];
export const SOURCES_METHOD = '~tokens = characters / 4 of each piece of text a run appends (a tool result, the model\'s own text / thinking / tool inputs, '
  + 'injected user / hook / mail text); it is cached by the next call and read again by every call after that (until a compaction drops the '
  + 'context below half), so the cache reads it causes = ~tokens x those calls; share = that / the run\'s cache reads (main transcript)';
const DAY = 86400000;
export const guardPolicy = policy => ({ ...GUARD_DEFAULTS, ...(policy?.guard || {}) });
const median = xs => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
export const M = x => (x === null || x === undefined ? '-' : x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : Math.round(x / 1e3) + 'k');
const label = key => key.replace(/^tool:/, '');

/** a trace (transcriptTrace) -> { turns, cache_read, standing, sources [{ key, cls, tokens, reread, share }], max, tool_share } */
export function contextSources(t) {
  const e = t?.e || [], n = e.length, ctx = e.map(x => x[1] + x[2] + x[3]);
  const cr = e.reduce((a, x) => a + x[1], 0), resets = [];
  for (let i = 1; i < n; i++) if (ctx[i] < ctx[i - 1] / 2) resets.push(i);   // a compaction: what came before is gone
  const reads = at => Math.max(0, (resets.find(r => r > at) ?? n) - at - 1);
  const by = new Map();
  for (const [at, src, chars] of t?.items || []) {
    let x = by.get(src);
    if (!x) by.set(src, x = { key: src, cls: src.startsWith('tool:') ? 'tool' : src, tokens: 0, reread: 0 });
    const tok = Math.round(chars / 4);
    x.tokens += tok; x.reread += tok * reads(at);
  }
  const share = v => (cr ? v / cr : null);
  const sources = [...by.values()].map(x => ({ ...x, share: share(x.reread) })).sort((a, b) => b.reread - a.reread);
  const t1 = n ? ctx[0] : 0, sr = t1 * reads(0);
  const tool = sources.filter(x => x.cls === 'tool').reduce((a, x) => a + x.reread, 0);
  return { turns: n, cache_read: cr, standing: { tokens: t1, reread: sr, share: share(sr) }, sources,
    max: t?.max ? { ...t.max, tokens: Math.round(t.max.chars / 4) } : null, tool_share: share(tool), last_ctx: n ? ctx[n - 1] : null, ctx };
}

/** the hand-off line of a run's role (policy.context: ctxlimit.mjs ctxRole - check-ins their own row, the chat the controller's) */
export const handoffK = (r, policy) => ctxLimits(policy, ctxRole(r.data || {})).handoff_k;   // META-CTX-ENFORCE R1: the one role mapping
const peerKey = r => [roleOfRun(r), r.data?.agent || '-', r.data?.effort || '-'].join(' / ');

/**
 * Read-only: every live Claude run of project p with its numbers, its peers and its flags.
 * o: { projectsDir, now, cache (tail Map), memo } -> { at, policy, runs: [{ id, lane, stage, key, turns, ctx, cache_read, output, handoff_k,
 *   peers { n, median_cr, median_turns }, ratio, sources, flags [{ cls, why }] }] }
 */
export function guardScan(state, p = {}, o = {}) {
  const G = guardPolicy(p.policy), now = o.now ?? Date.now(), cache = o.cache || new Map(), memo = o.memo || new Map();
  const items = loadState(state).items;
  const runs = Object.values(items).filter(i => i.kind === 'run' && familyOf(i.data || {}, p) === 'claude');
  const peers = new Map();
  for (const r of runs) {
    if (r.state !== 'exited' || !(Date.parse(r.created) >= now - G.peer_days * DAY)) continue;
    const m = measureRun(r, { projectsDir: o.projectsDir, cache, memo, project: p });
    if (!Number.isFinite(m.cache_read)) continue;
    const k = peerKey(r);
    if (!peers.has(k)) peers.set(k, []);
    peers.get(k).push(m);
  }
  const out = [];
  for (const r of runs.filter(x => x.state === 'running')) {
    const file = runTranscript(r, o), t0 = Date.parse(r.created) - 5000;
    const tot = file ? scan(file, t0, cache) : null, tr = file ? transcriptTrace(file, cache) : null;
    if (!tot) continue;
    const s = contextSources(tr), key = peerKey(r), pm = peers.get(key) || [];
    const mc = median(pm.map(x => x.cache_read)), mt = median(pm.map(x => x.turns)), hk = handoffK(r, p.policy);
    const x = { id: r.id, lane: r.data?.lane ?? null, stage: r.data?.stage ?? null, key, turns: tot.turns, ctx: s.last_ctx, cache_read: tot.cache_read, output: tot.output,
      handoff_k: hk, peers: { n: pm.length, median_cr: mc, median_turns: mt }, ratio: mc ? tot.cache_read / mc : null, flags: [],
      sources: { standing: s.standing, top: s.sources.slice(0, 5), tool_share: s.tool_share, max: s.max } };
    // 1. runaway: k x the peers' median (cache reads or turns), above the floor
    if (pm.length >= G.min_peers && tot.cache_read >= G.floor_m * 1e6 && ((mc && tot.cache_read > G.k * mc) || (mt && tot.turns > G.k * mt)))
      x.flags.push({ cls: 'runaway', why: `${M(tot.cache_read)} cache reads = ${x.ratio.toFixed(1)}x the median ${M(mc)} of ${pm.length} peers (${key}); ${tot.turns} turns (median ${mt ?? '-'})` });
    // 2. above the hand-off line for the last N calls and still going
    let above = 0;
    for (let i = s.ctx.length - 1; i >= 0 && s.ctx[i] > hk * 1000; i--) above++;
    if (above >= G.over_handoff_turns) x.flags.push({ cls: 'over-handoff', why: `context ${M(s.last_ctx)} above the hand-off line (${hk}k) for the last ${above} calls, no HANDOFF yet` });
    // 3. tool spam: tool output's share of the cache reads, one oversized result
    const why = [];
    if (s.tool_share !== null && s.tool_share * 100 >= G.tool_share_pct && s.cache_read >= G.tool_share_floor_m * 1e6) {
      const top = s.sources.find(y => y.cls === 'tool');
      why.push(`${Math.round(s.tool_share * 100)} % of its cache reads are tool output (${label(top.key)} ${Math.round(top.share * 100)} %)`);
    }
    if (s.max && s.max.tokens >= G.tool_result_k * 1000) why.push(`one ${s.max.tool} result ~${Math.round(s.max.tokens / 1000)}k tokens (call ${s.max.at})`);
    if (why.length) x.flags.push({ cls: 'tool-spam', why: why.join('; ') });
    out.push(x);
  }
  return { at: new Date(now).toISOString(), policy: G, runs: out };
}

// a records error throws (the tick logs it): read as none, the watch would close every alarm as "run gone" or raise each one again
const guards = state => Object.values(fold(readEvents(recordsFile(state, 'guard'))).items);
/** open GRD records (the digest rows) */
export const openGuards = state => guards(state).filter(g => g.state === 'open');

/**
 * The watch (the tick runs it before its status): guardScan + one GRD record per (run, class) ever + close the alarms of ended runs.
 * -> { scan, raised [{ id, run, cls, why }], closed [ids] }
 */
export function guardWatch(state, p = {}, o = {}) {
  const s = guardScan(state, p, o), have = new Set(guards(state).map(g => `${g.data?.run}|${g.data?.cls}`)), raised = [], closed = [];
  const by = o.by || 'launcher';
  for (const r of s.runs) for (const f of r.flags) {
    if (have.has(`${r.id}|${f.cls}`)) continue;
    const ev = record(state, { kind: 'guard', ev: 'create', by, data: { run: r.id, cls: f.cls, why: f.why, lane: r.lane ?? undefined,
      cache_read: r.cache_read, turns: r.turns, ctx: r.ctx, ratio: r.ratio === null ? undefined : Number(r.ratio.toFixed(2)) } });
    raised.push({ id: ev.id, run: r.id, cls: f.cls, why: f.why, lane: r.lane });
  }
  const items = loadState(state).items;
  for (const g of guards(state)) {
    if (g.state !== 'open' && g.state !== 'ruled') continue;
    const run = items[g.data?.run];
    if (run && run.state === 'running') continue;
    try { record(state, { kind: 'guard', ev: 'close', id: g.id, by: 'launcher', data: { why: `run ${run?.state ?? 'gone'}` } }); closed.push(g.id); }
    catch (e) { if (!(e instanceof RecordError)) throw e; }
  }
  return { scan: s, raised, closed };
}

/** gate probe: an open alarm is a material change - it wakes the check-in */
export const guardProbe = state => ({ at }) => openGuards(state).filter(g => Date.parse(g.created) <= at).map(g => 'guard:' + g.id);

/** run id -> [{ id, cls, why, state, action }] for the run chips (open + ruled; closed alarms leave) */
export function guardChips(state) {
  const m = new Map();
  for (const g of guards(state)) {
    if (g.state !== 'open' && g.state !== 'ruled') continue;
    const run = g.data?.run;
    if (!m.has(run)) m.set(run, []);
    m.get(run).push({ id: g.id, cls: g.data.cls, why: g.data.why, state: g.state, action: g.rule?.action ?? null });
  }
  return m;
}

/** the digest rows: one per open alarm */
export const guardRows = state => openGuards(state).map(g => ({ id: g.id, run: g.data.run, cls: g.data.cls, lane: g.data.lane ?? null, why: g.data.why, created: g.created }));

/** text for `norn guard` */
export function formatGuard(s, open = []) {
  const L = [`Usage guard ${s.at.slice(0, 16)}Z - k ${s.policy.k} x the peers' median, floor ${s.policy.floor_m}M cache reads; tool spam ${s.policy.tool_share_pct} % / ${s.policy.tool_result_k}k`];
  L.push('', 'Live runs:');
  for (const r of s.runs) {
    L.push(`- ${r.id} ${r.lane ?? '-'} (${r.key}): ${r.turns} turns, context ${M(r.ctx)}, cache reads ${M(r.cache_read)}${r.ratio !== null ? ` = ${r.ratio.toFixed(1)}x ${r.peers.n} peers` : ` (${r.peers.n} peers)`}, output ${M(r.output)}`
      + `${r.sources.tool_share !== null ? `; tool output ${Math.round(r.sources.tool_share * 100)} % of cache reads` : ''}`);
    for (const f of r.flags) L.push(`  ! ${f.cls}: ${f.why}`);
  }
  if (!s.runs.length) L.push('- (none)');
  L.push('', `Open alarms (${open.length}) - the check-in rules each: norn guard rule GRD-n --action let-run|mail|stop --why W`);
  for (const g of open) L.push(`- ${g.id} ${g.data.run} ${g.data.cls}: ${g.data.why}`);
  return L.join('\n');
}
