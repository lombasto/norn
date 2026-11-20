// META-GUARD R1 item 2 (DIR-23): where the week's tokens went - one row per (project, lane, stage): runs, tokens by type (input /
// cache write / cache read / output - never summed: they cost 10 / 12.5-20 / 1 / 50 cache-read units each), ~share of the weekly
// plan (costRollup's calibration: the window's Claude cache reads per weighted token; "~" always), outcomes (done / stopped / handoff,
// merged = a deliverable of the group's runs on main), tokens per merged branch; the top 5 spenders with why (turns x mean context).
// Derived only: run records + cost.mjs (usageOfRun, costRollup) + standing.mjs (turns, the context split) + deliverable facts (cv.mjs).
import { usageOfRun, costRollup, weekStart, parseReset } from './cost.mjs';
import { measureRun, runTranscript, transcriptTrace } from './standing.mjs';
import { contextSources, M } from './guard.mjs';
import { runCounts, countsLine, BOOKKEEPING } from './runcount.mjs';

const DAY = 86400000;
const OUTS = ['done', 'stopped', 'handoff'];
const zero = () => ({ input: 0, cache_create: 0, cache_read: 0, output: 0 });

/**
 * parts: [{ project, items (fold items), dlvs: [{ id, runs, merged_at }] }]; o: { now, week (bool: the plan's weekly window from
 * resetAt), resetAt, cacheRPerPct, projectsDir, codexDir, cache, memo, sources (bool: read every run's transcript for its producers) }
 * -> { since, days, window, rows, totals, top, producers? }
 */
export function usageWeek(parts, o = {}) {
  const now = o.now ?? Date.now(), resetMs = Date.parse(parseReset(o.resetAt) ?? o.resetAt ?? '');
  const week = !!o.week && Number.isFinite(resetMs), since = week ? weekStart(resetMs, now) : now - 7 * DAY;
  const cache = o.cache || new Map(), memo = o.memo || new Map(), smemo = o.smemo || new Map(), perPct = o.cacheRPerPct || null;
  const rows = new Map(), runsOut = [], prod = new Map(), windowRuns = [];
  for (const p of parts) {
    const inWin = (p.items || []).filter(i => i.kind === 'run' && Date.parse(i.created) >= since && Date.parse(i.created) <= now);
    windowRuns.push(...inWin);
    const runs = inWin.filter(r => !BOOKKEEPING.includes(r.state));   // OVERVIEW-TRUTH (6): a queue entry is no run of the group
    const ro = { now, days: Math.max(1, Math.ceil((now - since) / DAY)), cacheRPerPct: perPct, projectsDir: o.projectsDir, codexDir: o.codexDir, cache, memo, project: p.project };
    const mix = costRollup(runs, ro).calib.mix;
    const merged = new Map();
    for (const d of p.dlvs || []) if (d.merged_at) for (const id of d.runs || []) merged.set(id, d.id);
    for (const r of runs) {
      const d = r.data || {}, key = [p.project, d.lane ?? '-', d.stage ?? '-'].join('|');
      let x = rows.get(key);
      if (!x) rows.set(key, x = { project: p.project, lane: d.lane ?? '-', stage: d.stage ?? '-', runs: 0, running: 0, tokens: zero(), weighted: 0, other_tokens: 0,
        pct: null, pct_approx: true, outcomes: { done: 0, stopped: 0, handoff: 0, other: 0, merged: 0 }, branches: new Set() });
      x.runs++;
      if (r.state === 'running') x.running++;
      const u = usageOfRun(r, ro);
      let pct = null;
      if (u.tokens) {
        for (const k of Object.keys(x.tokens)) x.tokens[k] += u.tokens[k];
        x.weighted += u.tokens.weighted;
        if (u.family === 'claude' && perPct && mix !== null) { pct = (u.tokens.weighted * mix) / perPct; x.pct = (x.pct ?? 0) + pct; }
      } else if (Number.isFinite(u.total)) x.other_tokens += u.total;
      const out = r.state === 'exited' ? r.end?.outcome : null;
      if (r.state !== 'running') x.outcomes[OUTS.includes(out) ? out : 'other']++;
      if (merged.has(r.id)) x.branches.add(merged.get(r.id));
      if (u.tokens) {
        const m = measureRun(r, { projectsDir: o.projectsDir, codexDir: o.codexDir, cache, memo: smemo, project: p });
        const turns = m.turns ?? null, ctx = turns ? u.tokens.cache_read / turns : null;
        runsOut.push({ id: r.id, project: p.project, lane: d.lane ?? '-', stage: d.stage ?? '-', state: r.state, outcome: out, weighted: u.tokens.weighted, pct,
          cache_read: u.tokens.cache_read, output: u.tokens.output, turns, ctx_mean: ctx, turn1: m.turn1,
          why: `${turns ?? '?'} turns x ~${M(ctx)} context${m.turn1 ? ` (turn 1 ${M(m.turn1)})` : ''}, output ${M(u.tokens.output)}` });
      }
      if (o.sources && u.family === 'claude') {
        const f = runTranscript(r, { projectsDir: o.projectsDir }), t = f ? transcriptTrace(f, cache) : null;
        if (!t) continue;
        const s = contextSources(t), lane = d.lane ?? '-';
        for (const y of s.sources) {
          const k = lane + '|' + y.key;
          const z = prod.get(k) || { lane, key: y.key, cls: y.cls, tokens: 0, reread: 0, runs: 0 };
          z.tokens += y.tokens; z.reread += y.reread; z.runs++; prod.set(k, z);
        }
        if (o.lean) cache.delete('\u0000standing:' + f);   // a full-week scan: keep the memory flat
      }
    }
  }
  const out = [...rows.values()].map(({ branches, ...x }) => {
    const n = branches.size;
    return { ...x, outcomes: { ...x.outcomes, merged: n }, merged: n, per_merged: n ? { cache_read: x.tokens.cache_read / n, output: x.tokens.output / n, pct: x.pct === null ? null : x.pct / n } : null };
  }).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.weighted - a.weighted);
  const totals = { runs: out.reduce((a, x) => a + x.runs, 0), tokens: out.reduce((a, x) => { for (const k of Object.keys(a)) a[k] += x.tokens[k]; return a; }, zero()),
    pct: out.some(x => x.pct !== null) ? out.reduce((a, x) => a + (x.pct ?? 0), 0) : null, merged: out.reduce((a, x) => a + x.merged, 0) };
  const top = runsOut.sort((a, b) => b.weighted - a.weighted).slice(0, 5);
  const c = runCounts(windowRuns), counts = { ...c, text: countsLine(c) };   // OVERVIEW-TRUTH (6): the one count rule (runcount.mjs)
  const res = { now: new Date(now).toISOString(), since: new Date(since).toISOString(), days: Math.round((now - since) / DAY * 10) / 10, window: week ? 'week' : 'rolling', rows: out, totals, counts, top };
  if (o.sources) {
    const all = [...prod.values()], byKey = new Map();
    for (const z of all) { const k = byKey.get(z.key) || { key: z.key, cls: z.cls, tokens: 0, reread: 0, runs: 0 }; k.tokens += z.tokens; k.reread += z.reread; k.runs += z.runs; byKey.set(z.key, k); }
    const cr = totals.tokens.cache_read || null;
    res.producers = { method: 'norn guard sources, summed over the window\'s runs', ranked: [...byKey.values()].sort((a, b) => b.reread - a.reread).map(z => ({ ...z, share: cr ? z.reread / cr : null })),
      lanes: Object.fromEntries([...new Set(all.map(z => z.lane))].map(l => [l, all.filter(z => z.lane === l && z.cls !== 'model').sort((a, b) => b.reread - a.reread).slice(0, 3)])) };
  }
  return res;
}

const pc = x => (x === null || x === undefined ? '-' : '~' + (x < 1 ? x.toFixed(2) : x.toFixed(1)) + ' %');
/** text for `norn usage` */
export function formatUsageWeek(u) {
  const L = [`Where the tokens went: ${u.window === 'week' ? 'this plan week' : 'last 7 days'} since ${u.since.slice(0, 16)}Z (${u.days} d) - ${u.totals.runs} runs, ~plan ${pc(u.totals.pct)}, ${u.totals.merged} merged`];
  L.push(`  ${u.counts.text}`);
  L.push('lane          stage    runs  input  cache-w  cache-r  output  ~plan     done/stop/hand  merged  per merged (cache-r / output)');
  for (const r of u.rows) {
    const t = r.tokens;
    L.push(`${r.lane.padEnd(13)} ${r.stage.padEnd(8)} ${String(r.runs).padStart(4)}  ${M(t.input).padStart(5)}  ${M(t.cache_create).padStart(7)}  ${M(t.cache_read).padStart(7)}  ${M(t.output).padStart(6)}  ${pc(r.pct).padEnd(8)}  `
      + `${`${r.outcomes.done}/${r.outcomes.stopped}/${r.outcomes.handoff}`.padEnd(14)}  ${String(r.merged).padStart(6)}  ${r.per_merged ? `${M(r.per_merged.cache_read)} / ${M(r.per_merged.output)}` : '-'}`
      + `${r.other_tokens ? `  (+${M(r.other_tokens)} other-plan tokens)` : ''}`);
  }
  L.push('', 'Top 5 spenders:');
  for (const t of u.top) L.push(`- ${t.id} ${t.lane} ${t.stage} ${t.outcome ?? t.state}: ${pc(t.pct)} plan, ${M(t.cache_read)} cache reads - ${t.why}`);
  if (u.producers) {
    L.push('', 'Context producers (cache reads each causes; norn guard sources RUN-n for one run):');
    for (const z of u.producers.ranked.slice(0, 10)) L.push(`- ${z.key.replace(/^tool:/, 'tool ')}: ~${M(z.tokens)} tokens written -> ${M(z.reread)} cache reads (${pc(z.share === null ? null : z.share * 100)} of the window's), ${z.runs} runs`);
  }
  L.push('', 'Tokens by type are never added up: a cache read costs 1, a cache write 12.5-20, input 10, output 50 (cost.mjs WEIGHTS). ~plan = the usage calibration.');
  return L.join('\n');
}
