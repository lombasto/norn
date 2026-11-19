// META-PLAN R1 (norn DIR-13): the Plan - what happens next, and when. ONE home: buildPlan is pure (records + the fill walk's rows +
// STATUS.md text + the merge queue in -> the plan model out); loadPlan gathers those inputs from a state dir; the dashboard tab
// (/api/plan), `norn plan` and the MCP tool norn_plan are thin front ends over it. Nothing here re-implements a gate: the hold-ups
// are the words for the terms the fill's own walk wrote (runs.mjs readiness), the order is queueOf (the fill's order), run
// successors are after.mjs follow, usage is the STATUS.md the usage guard reads.
// R2: one line per real chain (a step = one lane + stage, newest run wins), a run's time = its whole family, ETAs count the merge,
// one day-aware clock ("today 21:41", "Fri 02:13") with the zone named once, plain names (lane title, else the lane humanized).
import fs from 'node:fs';
import path from 'node:path';
import { readEvents, fold, recordsFile } from './records.mjs';
import { queueOf, readiness } from './runs.mjs';
import { follow } from './after.mjs';
import { isMergeStage } from './usageguard.mjs';
import { mergeQueue } from './mergeq.mjs';
import { loadRoadmap } from './roadmap.mjs';
import { lanePins } from './crew.mjs';

const MIN = 60000, DAY = 24 * 3600000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = n => String(n).padStart(2, '0');
const num = x => (Number.isFinite(x) ? +x.toFixed(Math.abs(x) < 1 ? 2 : 1) : x);
const midnight = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** one day-aware local clock: "today 21:41", within the week "Fri 02:13", farther "Fri 11-20 02:13" (the dash's ui.mjs dayClock = the same) */
export function dayClock(ms, now = Date.now()) {
  const d = new Date(ms), n = new Date(now), hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  const days = Math.round(Math.abs(midnight(d) - midnight(n)) / DAY);
  return days === 0 ? `today ${hm}` : days < 7 ? `${DAYS[d.getDay()]} ${hm}` : `${DAYS[d.getDay()]} ${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}`;
}
export const clock = dayClock;
/** the zone the clock speaks (named once per plan) */
export const zoneName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; } catch { return 'local time'; } };
/** a rough duration: "~45 min", "~1.5 h" (never false precision) */
export const approx = min => (min < 60 ? `~${Math.max(5, Math.round(min / 5) * 5)} min` : `~${Math.round(min / 30) / 2} h`);
const cap1 = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const evTs = (r, ev) => { const h = [...(r.history || [])].reverse().find(x => x.ev === ev); return h ? Date.parse(h.ts) : null; };
const endTs = r => evTs(r, 'end');
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const onClaude = d => !d?.executor || ['claude', 'fake'].includes(d.executor);
const idn = id => Number(String(id).slice(4)) || 0;

// ---------- names: the lane's title, else the lane in plain words; never a raw sha ----------
const SHA = /-[0-9a-f]{7,40}$/i;
const STAGE_WORD = { CIRED: 'fix', MERGE: 'merge' };
const ACRONYM = /^(?:[^aeiou\d]{2,4}|ci|ui|ux|ai|api|io|os|qa|gpu|cpu)$/i;
const isCode = s => /^[A-Z]{1,2}\d+[A-Z]?$/.test(s);   // A4, S2B, R1
/**
 * makeLabeler({ project, runs, roadmap: [{ title, links }], lanes: [{ name, title }] }) -> (run data) => "Adopt A4 (MCP)".
 * Base = the lane record's title, else the first roadmap item linking lane:<lane> (its title up to ':'), else the lane without the
 * project prefix (`<project>-`, or a first word most of the project's lanes share), humanized; then the stage in plain words (a code
 * like A4 kept, words the base already says dropped, a sha suffix dropped), "R<n>" for a later round of a worded stage.
 */
export function makeLabeler({ project = null, runs = [], roadmap = [], lanes = [] } = {}) {
  const titles = new Map();
  for (const l of lanes) if (l?.name && l.title) titles.set(l.name, String(l.title));
  const names = [...new Set(runs.map(r => r?.data?.lane).filter(Boolean))];
  const firsts = names.filter(n => n.includes('-')).map(n => n.split('-')[0]), cnt = {};
  for (const f of firsts) cnt[f] = (cnt[f] || 0) + 1;
  const common = Object.entries(cnt).find(([, c]) => c >= 2 && c * 2 >= names.length)?.[0] ?? null;
  const strip = lane => {
    if (project && lane.startsWith(`${project}-`)) return lane.slice(project.length + 1);
    if (common && lane.startsWith(`${common}-`)) return lane.slice(common.length + 1);
    return lane;
  };
  const rmTitle = lane => {
    const hit = roadmap.find(i => (i.links || []).includes(`lane:${lane}`));
    return hit?.title ? String(hit.title).split(':')[0].trim() : null;
  };
  return d => {
    if (!d?.lane) return d?.id || 'a run';
    const raw = strip(d.lane), segs = raw.split(/[-_]+/).filter(Boolean);
    let base = titles.get(d.lane) ?? rmTitle(d.lane), acr = [];
    if (!base) {
      const [head, ...rest] = segs;
      acr = rest.filter(w => ACRONYM.test(w)).map(w => w.toUpperCase());
      base = [ACRONYM.test(head) ? head.toUpperCase() : cap1(head), ...rest.filter(w => !ACRONYM.test(w))].join(' ');
    }
    const have = new Set([...base.toLowerCase().split(/[^a-z0-9]+/), ...d.lane.toLowerCase().split(/[^a-z0-9]+/)]);
    const st = String(d.stage ?? '').replace(SHA, '');
    let stage = '';
    if (isCode(st)) stage = st;
    else if (st) {
      const words = st.split(/[-_ ]+/).filter(Boolean).map(w => STAGE_WORD[w.toUpperCase()] ?? (w.length >= 3 && w === w.toUpperCase() ? w.toLowerCase() : w));
      stage = [...words.filter(w => !have.has(w.toLowerCase())), ...(Number(d.round) > 1 ? [`R${d.round}`] : [])].join(' ');
    }
    return [base, stage, acr.length ? `(${acr.join(' ')})` : ''].filter(Boolean).join(' ');
  };
}
/** a run in plain words without context: lane + stage ("Adopt A2"), else its id */
export const labelOf = d => makeLabeler({})(d);

// ---------- estimates: this project's own history, one sample per run family ----------
export const ESTIMATE_METHOD = 'Estimates: the median of this project\'s finished (DONE) work with the same lane, stage and executor - a run counts with its whole family '
  + '(fill successors, resumes, re-queues: their running time added up, never a fragment alone); for Claude runs the cost as their cache reads / the calibration (weekly %), '
  + 'else that executor + model\'s median %/h x the time ("rough"); with no such run, the run\'s own time budget; else "no estimate". A step waiting for a merge adds the '
  + 'median MERGE run. "~" = rough.';
const parentOf = r => r.data?.from_queue ?? r.data?.resume_of ?? r.data?.requeue_of ?? r.data?.parent ?? null;
/** families(runs) -> [{ root, members (by id), last (the newest member that ran), min (running time summed), cache (cache reads summed) }] */
export function families(runs) {
  const map = Object.fromEntries(runs.map(r => [r.id, r])), up = new Map();
  for (const r of runs) {
    const p = parentOf(r); if (p && map[p]) up.set(r.id, p);
    for (const n of [r.fill?.next, r.resume?.next]) if (n && map[n] && !up.has(n)) up.set(n, r.id);
  }
  const rootOf = id => { const seen = new Set(); while (up.has(id) && !seen.has(id)) { seen.add(id); id = up.get(id); } return id; };
  const by = new Map();
  for (const r of runs) { const k = rootOf(r.id); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return [...by.entries()].map(([root, ms]) => {
    ms.sort((a, b) => idn(a.id) - idn(b.id));
    const ran = ms.filter(m => m.state !== 'filled' && m.state !== 'queued' && m.state !== 'withdrawn');
    let min = 0, cache = null;
    for (const m of ran) {
      const s = evTs(m, 'start') ?? Date.parse(m.created), e = endTs(m);
      if (Number.isFinite(s) && Number.isFinite(e) && e > s) min += (e - s) / MIN;
      const cr = Number(m.end?.usage?.cache_read_input_tokens);
      if (Number.isFinite(cr)) cache = (cache ?? 0) + cr;
    }
    return { root, members: ms, last: ran.at(-1) ?? null, min, cache };
  });
}
/** estimator(runs, { per }) -> (run data) => { min, cost, costBasis: history | rough | null, basis: history | budget | null, n, word }; .mergeMin */
export function estimator(runs, { per = null } = {}) {
  const by = new Map(), rates = new Map(), merges = [];
  for (const f of families(runs.filter(r => r.kind === 'run'))) {
    const l = f.last;
    if (!l || l.state !== 'exited' || l.end?.outcome !== 'done' || !(f.min > 0)) continue;
    const k = `${l.data.lane}|${l.data.stage}|${l.data.executor}`, x = by.get(k) || { min: [], cost: [] };
    x.min.push(f.min);
    if (isMergeStage(l.data.stage)) merges.push(f.min);
    if (onClaude(l.data) && per > 0 && f.cache !== null) {
      x.cost.push(f.cache / per);
      const rk = `${l.data.executor}|${l.data.model ?? ''}`; if (!rates.has(rk)) rates.set(rk, []);
      rates.get(rk).push(f.cache / per / (f.min / 60));
    }
    by.set(k, x);
  }
  const rateOf = d => { const xs = rates.get(`${d.executor}|${d.model ?? ''}`); return xs ? median(xs) : null; };
  const est = d => {
    const x = by.get(`${d.lane}|${d.stage}|${d.executor}`);
    let o;
    if (x) { const min = median(x.min); o = { min, cost: median(x.cost), basis: 'history', n: x.min.length, word: approx(min) }; }
    else if (Number(d.budget_min) > 0) o = { min: Number(d.budget_min), cost: null, basis: 'budget', n: 0, word: approx(Number(d.budget_min)) };
    else o = { min: null, cost: null, basis: null, n: 0, word: 'no estimate' };
    o.costBasis = o.cost !== null ? 'history' : null;
    if (o.cost === null && o.min !== null && onClaude(d)) { const r = rateOf(d); if (r !== null) { o.cost = r * o.min / 60; o.costBasis = 'rough'; } }
    return o;
  };
  est.mergeMin = median(merges);
  return est;
}

// ---------- hold-ups: the fill walk's terms in plain words ----------
const AFTER_WORD = { merged: 'merge', done: 'finish', ended: 'end' };
/** one readiness term -> plain words. ctx: { runs (array), now, label (run data -> name) } */
export function holdWords(term, { runs = [], now = Date.now(), label = labelOf } = {}) {
  const t = String(term), byId = id => runs.find(r => r.id === id);
  const name = id => { const r = byId(id); return r ? label({ ...r.data, id }) : id; };
  let m;
  if ((m = t.match(/^after run:(RUN-\d+):(\w+) unmet$/))) return `waits for ${name(m[1])} to ${AFTER_WORD[m[2]] ?? m[2]}`;
  if ((m = t.match(/^after q:(Q-\d+):(\w+) unmet$/))) return m[2] === 'applied' ? `waits for your answer (${m[1]}) to be applied` : `waits for your answer (${m[1]})`;
  if ((m = t.match(/^after dlv:(DLV-\d+):\w+ unmet$/))) return `waits for finished work ${m[1]} to reach main`;
  if ((m = t.match(/^after dir:(DIR-\d+):\w+ unmet$/))) return `waits for instruction ${m[1]} to be done`;
  if ((m = t.match(/^not_before (\S+)$/))) return `not before ${dayClock(Date.parse(m[1]), now)}`;
  if (t.startsWith('PAUSED')) return 'held: paused';
  if (t === 'usage: RATE_OK=0') return 'held: usage over the hourly cap';
  if (t === 'usage: RATE_OK unknown') return 'held: hourly usage not measured yet';
  if (t === 'usage: weekly unknown') return 'held: weekly usage not measured yet (on API billing, set Billing to api)';
  if ((m = t.match(/^usage: api spend \$([\d.]+) in 24 h >= cap \$([\d.]+)$/))) return `held: API spend $${m[1]} in 24 h reached the $${m[2]} daily cap`;
  if ((m = t.match(/^usage: weekly ([\d.]+) % >= guard ([\d.]+) %$/))) return `held: weekly usage at the stop (${m[1]} % of ${m[2]} %)`;
  if (t.startsWith('cap ') || t.startsWith('cap:')) return 'waits for a worker slot';
  if ((m = t.match(/^worktree held by (\S+)/))) return `waits for its folder (${/^RUN-\d+$/.test(m[1]) ? name(m[1]) : 'another run'} is writing there)`;
  if ((m = t.match(/^lane worktree \S+ held by (\S+)/))) return `waits for its lane's folder (${/^RUN-\d+$/.test(m[1]) ? name(m[1]) : 'another run'} is writing there)`;
  if ((m = t.match(/^merge slots full: (\d+) merge/))) return `waits for a merge slot (${m[1]} merge${m[1] === '1' ? '' : 's'} running)`;   // GAP-6
  if (/^MERGE /.test(t)) return 'held: its lane is still writing (a merge needs a prepared merge brief)';
  if (t.startsWith('labels ')) return 'offered to another machine';
  if ((m = t.match(/^dwarf: (.+) is busy on (RUN-\d+)$/))) return `waits for ${m[1]}, its pinned dwarf (busy on ${name(m[2])})`;   // DWARVES 1.3 rule 1
  if (t.startsWith('crew store ')) return 'held: the crew store is unreadable';
  if (t.startsWith('resources:')) return 'held: CPU / memory gate';
  if (t.startsWith('withdraw:')) return 'withdrawn: a condition can no longer be met';
  if (t.startsWith('needs a ruling: ')) return `needs a ruling (the check-in repairs it): ${t.slice(16)}`;   // META-AUTONOMY R1
  return t;
}
const isHeld = t => /^(usage:|resources:|PAUSED|MERGE )/.test(t);

// ---------- forecast: STATUS.md (the file the usage guard reads) + the budget ----------
/** forecastOf({ status (STATUS.md text), budget, now, queuedCost? {pct, n, of, rough} }) */
export function forecastOf({ status = '', budget = {}, now = Date.now(), queuedCost = null } = {}) {
  const n = s => (s === undefined ? null : Number(String(s).replaceAll(',', '')));
  const rm = status.match(/=\s*([\d.,]+)\s*%\/h vs cap\s*([\d.,]+)/), wm = status.match(/estimated weekly now ~([\d.,]+)\s*%/);
  const xm = status.match(/reset (\d{4}-\d\d-\d\dT\d\d:\d\dZ)/), ok = status.match(/^RATE_OK=([01])/m);
  const rate = n(rm?.[1]), cap = n(rm?.[2]), weekly = n(wm?.[1]), stop = typeof budget.weekly_stop_pct === 'number' ? budget.weekly_stop_pct : null;
  const reset = xm ? new Date(Date.parse(xm[1].replace('Z', ':00Z'))).toISOString() : null, resetMs = reset ? Date.parse(reset) : null;
  const headroom = weekly !== null && stop !== null ? stop - weekly : null;
  // line = pre + the clock of lineAt + post: the dash re-draws the time in the viewer's zone
  const f = { rate, cap, over: rate !== null && cap !== null ? rate > cap : null, rateOk: ok ? ok[1] === '1' : null, weekly, stop, headroom, reset, stopAt: null, line: '', costLine: null,
    lineAt: null, linePre: '', linePost: '' };
  const at = (pre, ms, post = '') => { f.lineAt = new Date(ms).toISOString(); f.linePre = pre; f.linePost = post; f.line = `${pre}${dayClock(ms, now)}${post}`; };
  // API billing (billing.mjs): STATUS says the last 24 h of spend and the daily cap; no weekly limit to forecast
  // the total the cap counts: "= $T" after the parts (ended + running + chats, gap #9), else the one figure of an older STATUS
  const api = status.match(/^- billing: API .*$/m), usd = api?.[0].match(/api spend last 24 h [^;]*?= \$([\d.,]+)/) ?? api?.[0].match(/api spend last 24 h \$([\d.,]+)/), capM = api?.[0].match(/of the \$([\d.,]+) daily cap/);
  if (api) { f.api = { usd: usd ? n(usd[1]) : null, cap: capM ? n(capM[1]) : null }; f.over = null; f.weekly = null; f.stop = null; f.headroom = null;
    const $ = v => `$${(v ?? 0).toFixed(2)}`;
    f.line = f.api.cap === null ? `API billing: ${$(f.api.usd)} in the last 24 h, no daily cap` : f.api.usd >= f.api.cap ? `API daily cap reached: ${$(f.api.usd)} of ${$(f.api.cap)} in 24 h - new Claude work waits` : `API billing: ${$(f.api.usd)} of the ${$(f.api.cap)} daily cap in the last 24 h`;
    return f; }
  if (weekly === null) f.line = 'usage not measured yet';
  else if (stop === null) f.line = 'no weekly stop set';
  else if (headroom <= 0) { if (resetMs) at('weekly stop reached: new Claude work waits for the reset (', resetMs, ')'); else f.line = 'weekly stop reached: new Claude work waits for the reset'; }
  else if (!(rate > 0)) { if (resetMs) at('no usage this hour: it lasts to the reset (', resetMs, ')'); else f.line = 'no usage this hour: it lasts to the reset'; }
  else {
    const t = now + headroom / rate * 3600000;
    if (resetMs && t >= resetMs) at('at this rate it lasts to the reset (', resetMs, ')');
    else { f.stopAt = new Date(t).toISOString(); at('at this rate the weekly stop is reached ', t); }
  }
  if (queuedCost?.of) f.costLine = queuedCost.n ? `queued work ~${num(queuedCost.pct)} %${queuedCost.rough ? ' (rough)' : ''}${headroom !== null ? ` of the ${num(headroom)} % left` : ''} (${queuedCost.n} of ${queuedCost.of} runs estimated)`
    : 'queued work: no cost estimate yet (no finished Claude run of that kind with a measured cost)';
  return f;
}

// ---------- the plan ----------
const SHAPE = { done: 'check', merged: 'check', running: 'play', ready: 'ring', waiting: 'ring', offered: 'ring', held: 'pause', ruling: '!', stopped: 'stop', withdrawn: 'stop' };
const LIVE = ['queued', 'running', 'claimed'];
/**
 * buildPlan({ project, runs: run items (fold), ready: the fill walk's rows (runs.readiness), status: STATUS.md text, budget,
 *   merges: { rows (mergeQueue order), error? }, roadmap: [{ id, title, links }], lanes: [{ name, title }], now, zone })
 *   -> { upnext, chains, landing, forecast, method, zone }
 */
export function buildPlan({ project = null, runs = [], ready = [], status = '', budget = {}, merges = null, roadmap = [], lanes = [], pins = {}, now = Date.now(), zone = zoneName() } = {}) {
  runs = runs.filter(r => r.kind === 'run');
  const map = Object.fromEntries(runs.map(r => [r.id, r])), rowOf = new Map(ready.map(r => [r.id, r]));
  const est = estimator(runs, { per: Number(budget.cacheR_per_pct) || null }), mergeMin = est.mergeMin;
  const label = makeLabeler({ project, runs, roadmap, lanes });
  const ctx = { runs, now, label }, words = t => holdWords(t, ctx);
  const queued = queueOf(runs, pins);
  const at = ms => ({ at: new Date(ms).toISOString(), word: `~${dayClock(ms, now)}` });

  // a queued run's status from its walk row
  const qStatus = id => {
    const row = rowOf.get(id);
    if (!row) return 'waiting';
    if (row.ready) return 'ready';
    if (row.hold) return 'ruling';   // META-AUTONOMY R1: a condition can no longer be met - the check-in rules it
    if (row.terms.some(isHeld)) return 'held';
    if (row.offer) return 'offered';
    return 'waiting';
  };
  // the run that will merge a lane's work: its queued / running MERGE-stage run
  const mergeRunOf = lane => runs.filter(r => LIVE.includes(r.state) && r.data.lane === lane && isMergeStage(r.data.stage)).sort((a, b) => idn(b.id) - idn(a.id))[0] ?? null;
  // start / finish estimates (ms | null) with the reason in words when null; memoised; a cycle = no estimate
  const fin = new Map(), sta = new Map(), why = new Map();
  const no = (m, id, w) => { if (!why.has(`${m}${id}`)) why.set(`${m}${id}`, w); return null; };
  // when an after condition on run c lets go (ms; now when met); null = no basis, its reason in why 'c<run>'
  const condAt = (c, row) => {
    if (!row.terms.includes(`after run:${c.id}:${c.state} unmet`)) return now;
    const up = map[c.id]; if (!up) return no('c', c.id, `${c.id} is not in this project`);
    const f = follow(map, up), done = f.state === 'exited' && f.end?.outcome === 'done', name = label({ ...up.data, id: c.id });
    if (c.state === 'merged' && done) {   // finished, its merge still to come: its lane's merge run, else the merge median from now
      const mr = mergeRunOf(up.data.lane);
      if (mr) { const v = finishOf(mr.id); return v ?? no('c', c.id, why.get(`f${mr.id}`) ?? `${label({ ...mr.data, id: mr.id })} has no estimate`); }
      return mergeMin === null ? no('c', c.id, `${name} waits for a merge and no merge has been timed yet`) : now + mergeMin * MIN;
    }
    const v = finishOf(c.id);
    if (v === null) return no('c', c.id, why.get(`f${c.id}`) ?? `${name} has no estimate`);
    if (c.state !== 'merged') return v;
    return mergeMin === null ? no('c', c.id, `${name} waits for a merge and no merge has been timed yet`) : v + mergeMin * MIN;
  };
  // a walk term that waits for another run to END: its folder held by a live run, a MERGE held while its lane has a live writer
  const writerOf = t => String(t).match(/^worktree held by (RUN-\d+)/)?.[1] ?? String(t).match(/^MERGE .*\blive run (RUN-\d+)/)?.[1] ?? null;
  const startOf = id => {
    if (sta.has(id)) return sta.get(id);
    sta.set(id, null);
    const r = map[id], row = rowOf.get(id);
    let s = null;
    if (!r) s = null;
    else if (row?.ready) s = now;
    else if (!row) s = no('s', id, 'not checked by the fill yet');
    else {
      const other = row.terms.find(t => !/^after run:|^not_before /.test(t) && !(writerOf(t) && map[writerOf(t)]));
      if (other) s = no('s', id, words(other));
      else {
        const conds = (r.data.after || []).filter(c => c.kind === 'run');
        const ups = conds.map(c => condAt(c, row));
        const writers = [...new Set(row.terms.map(writerOf).filter(Boolean))];
        const ws = writers.map(w => finishOf(w) ?? no('c', w, why.get(`f${w}`) ?? `${label({ ...map[w].data, id: w })} has no estimate`));
        const nb = Date.parse(r.data.not_before ?? '');
        const bad = [...conds.map(c => c.id), ...writers].find((x, i) => [...ups, ...ws][i] === null);
        if (bad) s = no('s', id, why.get(`c${bad}`) ?? `${bad} has no estimate`);
        else s = Math.max(now, ...(Number.isFinite(nb) ? [nb] : []), ...ups, ...ws);
      }
    }
    sta.set(id, s);
    return s;
  };
  const finishOf = id => {
    if (fin.has(id)) return fin.get(id);
    fin.set(id, null);
    const r = map[id];
    let v = null;
    if (!r) v = null;
    else if (r.state === 'withdrawn') v = no('f', id, `${label({ ...r.data, id })} was withdrawn`);
    else {
      const f = follow(map, r), e = est(f.data ?? r.data), name = label({ ...r.data, id });
      if (f.state === 'exited') v = f.end?.outcome === 'done' ? endTs(f) : no('f', id, `${name} ended ${f.end?.outcome ?? 'without a marker'}`);
      else if (e.min === null) v = no('f', id, `${name} has no time history or budget`);
      else if (['running', 'claimed'].includes(f.state)) v = Math.max(now, (evTs(f, 'start') ?? Date.parse(f.created)) + e.min * MIN);
      else if (f.state === 'queued') {
        const s = startOf(f.id);
        v = s === null ? no('f', id, why.get(`s${f.id}`) ?? `${name} has no start estimate`) : s + e.min * MIN;
      } else v = no('f', id, `${name} is ${f.state}`);
      if (v === null && f.id !== id && why.has(`f${f.id}`)) why.set(`f${id}`, why.get(`f${f.id}`));
    }
    fin.set(id, v);
    return v;
  };

  // 1. Up next
  const upnext = queued.map(q => {
    const r = map[q.id], row = rowOf.get(q.id), e = est(r.data), s = startOf(q.id);
    const holds = row ? (row.ready ? ['ready to start'] : row.terms.map(words)) : ['not checked yet'];
    const holdAt = row && !row.ready ? row.terms.map(t => { const m = String(t).match(/^not_before (\S+)$/); return m && Number.isFinite(Date.parse(m[1])) ? new Date(Date.parse(m[1])).toISOString() : null; }) : holds.map(() => null);
    return { id: q.id, dwarf: q.dwarf, label: label({ ...r.data, id: q.id }), position: q.position, lane: q.lane, stage: q.stage, executor: q.executor,
      priority: q.priority, status: qStatus(q.id), holds, holdAt, estimate: e,
      start: s === null ? { at: null, word: 'no estimate', why: why.get(`s${q.id}`) ?? null } : s <= now ? { at: new Date(now).toISOString(), word: 'now' } : at(s) };
  });

  // 2. Chains. A step = one lane + stage: re-queues, fill successors and resumes of it collapse into ONE step, the newest run wins (a live
  // one first). A chain = the connected set of the live steps (queued / running) plus their immediate upstream steps; a withdrawn step
  // with no live successor (withdrawn in the last 24 h) is a live end too - the actionable "chain broken"; a finished chain (every step
  // done, its last one ended in the last 24 h) shows as finished, then drops.
  const keyOf = r => (r.data.lane ? `${r.data.lane}|${r.data.stage ?? ''}` : r.id);
  const groups = new Map();
  for (const r of runs) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const repOf = new Map();
  for (const [k, ms] of groups) {
    const cand = ms.filter(m => !(m.state === 'filled' && m.fill?.next && map[m.fill.next]));
    const live = cand.filter(m => LIVE.includes(m.state));
    repOf.set(k, (live.length ? live : cand.length ? cand : ms).reduce((a, b) => (idn(b.id) > idn(a.id) ? b : a)));
  }
  const rep = k => repOf.get(k);
  const recentW = r => r.state === 'withdrawn' && evTs(r, 'withdraw') >= now - DAY;
  const repState = k => follow(map, rep(k)).state;
  const isLiveKey = k => LIVE.includes(repState(k)) || recentW(rep(k));
  const edgesOf = seeds => {
    const nodes = new Set(), edges = [];
    for (const k of seeds) {
      nodes.add(k);
      // the step's conditions: its run's, and those of the queued runs it was filled from (a fill successor may not copy them)
      const r = rep(k), conds = [r, ...groups.get(k).filter(m => m !== r && follow(map, m) === follow(map, r))].flatMap(m => m.data.after || []);
      for (const c of conds) {
        if (c.kind !== 'run' || !map[c.id]) continue;
        const u = keyOf(map[c.id]);
        if (u === k) continue;
        nodes.add(u); edges.push([u, k, c.state]);
      }
    }
    return { nodes, edges };
  };
  const components = ({ nodes, edges }) => {
    const par = new Map([...nodes].map(n => [n, n])), find = x => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
    for (const [a, b] of edges) par.set(find(a), find(b));
    const out = new Map();
    for (const n of nodes) { const r = find(n); if (!out.has(r)) out.set(r, []); out.get(r).push(n); }
    return [...out.values()];
  };
  const liveG = edgesOf([...groups.keys()].filter(isLiveKey));
  const inLive = new Set(liveG.nodes);
  const doneRecently = k => { const f = follow(map, rep(k)); return f.state === 'exited' && f.end?.outcome === 'done' && endTs(f) >= now - DAY; };
  const finSeeds = [...groups.keys()].filter(k => !inLive.has(k) && doneRecently(k) && (rep(k).data.after || []).some(c => c.kind === 'run' && map[c.id]));
  const finG = edgesOf(finSeeds);
  const allEdges = [...liveG.edges, ...finG.edges];
  // in order of depth (a step after everything it waits for), then oldest first: parallel upstreams sit side by side
  const topo = keys => {
    const set = new Set(keys), lv = new Map();
    const level = (k, seen = new Set()) => {
      if (lv.has(k)) return lv.get(k);
      if (seen.has(k)) return 0;   // a cycle: no order to keep
      seen.add(k);
      const v = Math.max(0, ...allEdges.filter(([x, y]) => y === k && set.has(x)).map(([x]) => 1 + level(x, seen)));
      lv.set(k, v);
      return v;
    };
    return [...keys].sort((x, y) => level(x) - level(y) || idn(rep(x).id) - idn(rep(y).id));
  };
  const unmetMerge = id => ready.some(row => row.terms.includes(`after run:${id}:merged unmet`));
  const stepOf = k => {
    const r = rep(k), id = r.id, f = follow(map, r), lbl = label({ ...r.data, id });
    const ids = groups.get(k).map(m => m.id);
    let status, word;
    if (r.state === 'withdrawn') { status = 'withdrawn'; word = 'withdrawn'; }
    else if (['running', 'claimed'].includes(f.state)) { status = 'running'; word = 'running'; }
    else if (f.state === 'queued') { status = qStatus(f.id); word = status === 'ready' ? 'ready to start' : (rowOf.get(f.id)?.terms || []).map(words)[0] ?? 'waiting'; if (status === 'ready') status = 'waiting'; }
    else if (f.state === 'exited' && f.end?.outcome === 'done') { const pend = ids.some(unmetMerge); status = 'done'; word = pend ? 'done, not merged yet' : 'done'; }
    else { status = 'stopped'; word = f.state === 'exited' ? `ended ${f.end?.outcome ?? '?'}` : f.state; }
    return { id, now: f.id !== id ? f.id : null, label: lbl, lane: r.data.lane ?? null, stage: r.data.stage ?? null, epic: r.data.epic ?? null, status, shape: SHAPE[status], word };
  };
  const rmOf = steps => {
    for (const s of [...steps].reverse()) {   // the chain's goal (its last step) first
      const hit = roadmap.find(i => (i.links || []).some(l => (s.lane && l === `lane:${s.lane}`) || (s.epic && l === `ep:${s.epic}`) || l === `run:${s.id}`));
      if (hit) return { id: hit.id, title: hit.title };
    }
    return null;
  };
  const span = xs => (xs.length > 1 ? `${xs[0].label}..${xs.at(-1).label}` : xs[0].label);
  const posOf = k => queued.find(q => q.id === follow(map, rep(k)).id)?.position ?? Infinity;
  const chainOf = (keys, finished) => {
    const order = topo(keys), steps = order.map(stepOf);
    const wd = steps.filter(s => s.status === 'withdrawn'), auto = wd.filter(s => String(map[s.id].withdraw?.why ?? '').startsWith('after:'));
    const causes = steps.filter(s => s.status === 'stopped' || (s.status === 'withdrawn' && !auto.includes(s)));
    const broken = wd.length ? `chain broken: ${[...causes.map(s => `${s.label} ${s.status === 'withdrawn' ? 'withdrawn' : 'stopped'}`), ...(auto.length ? [`${span(auto)} withdrawn`] : [])].join(', ')}` : null;
    let finish;
    if (finished) { const end = Math.max(...steps.map(s => endTs(follow(map, map[s.id])) ?? 0)); finish = { at: new Date(end).toISOString(), word: `finished ${dayClock(end, now)}` }; }
    else if (broken) finish = { at: null, word: 'no estimate: the chain is broken' };
    else {
      // every step's finish; a sink (nothing here waits for it) that is no merge itself lands with one more merge
      const sinks = new Set(order.filter(k => !allEdges.some(([a, b]) => a === k && keys.includes(b))));
      let end = -Infinity, miss = null, unmerged = false;
      for (const k of order) {
        const r = rep(k), v = finishOf(r.id);
        if (v === null) { miss = miss ?? why.get(`f${r.id}`) ?? `${label({ ...r.data, id: r.id })} has no estimate`; continue; }
        const merge = sinks.has(k) && !isMergeStage(r.data.stage) && v > now ? mergeMin : 0;
        if (merge === null) unmerged = true;   // no MERGE run timed yet: the finish before its merge, said so
        end = Math.max(end, v + (merge ?? 0) * MIN);
      }
      finish = miss ? { at: null, word: `no estimate: ${miss}` } : { ...at(end), ...(unmerged ? { note: 'before its merge (no merge timed yet)' } : {}) };
    }
    const first = Math.min(...keys.map(posOf));
    return { steps, broken, finished: !!finished, shape: finished ? 'check' : broken || steps.some(s => s.status === 'ruling') ? '!' : steps.some(s => s.status === 'held') ? 'pause' : 'ring', rm: rmOf(steps), finish,
      first: finished ? Infinity : broken && first === Infinity ? Infinity - 1 : first, firstId: Math.min(...keys.map(k => idn(rep(k).id))) };
  };
  const chains = [...components(liveG).filter(ks => ks.length > 1).map(ks => chainOf(ks, false)),
    ...components(finG).filter(ks => ks.length > 1 && ks.every(k => { const f = follow(map, rep(k)); return f.state === 'exited' && f.end?.outcome === 'done'; })).map(ks => chainOf(ks, true))]
    .sort((a, b) => (a.finished - b.finished) || (a.first === b.first ? 0 : a.first < b.first ? -1 : 1) || a.firstId - b.firstId)
    .map(({ first: _f, firstId: _i, ...c }) => c);

  // 3. Landing next: merging now, then the merge queue in its order (a queued MERGE run joins its lane's row), then other queued MERGE runs
  const ciRed = /^CI \S+: failure\b/m.test(status);
  const mergeRunWord = id => {
    const row = rowOf.get(id);
    if (!row) return 'waits to start';
    if (row.ready) return 'starts next';
    return words(row.terms.find(t => t.startsWith('merge slots full')) || row.terms[0]);   // GAP-6: a merge waits for a merge slot first
  };
  const live = runs.filter(r => ['running', 'claimed'].includes(r.state) && isMergeStage(r.data.stage));
  const qm = queued.filter(q => isMergeStage(q.stage)), used = new Set();
  const landing = live.map(r => ({ kind: 'run', id: r.id, label: label({ ...r.data, id: r.id }), word: 'merging now' }));
  for (const d of merges?.rows || []) {
    if (d.lane && live.some(r => r.data.lane === d.lane)) continue;
    const q = d.lane ? qm.find(x => x.lane === d.lane && !used.has(x.id)) : null;
    if (q) used.add(q.id);
    const word = ciRed ? 'blocked: CI red on main' : d.red ? 'blocked: its last merge test was red' : q ? mergeRunWord(q.id)
      : String(d.word || '').startsWith('conflict') ? 'needs a conflict fix first' : d.word === 'clean' ? 'ready to merge' : 'not checked against main yet';
    landing.push({ kind: 'work', id: d.id, run: q?.id ?? null, label: d.lane ? label({ lane: d.lane }) : String(d.branch ?? d.id).replace(SHA, ''), branch: d.branch ?? null, what: d.delivers ?? null, word });
  }
  for (const q of qm) if (!used.has(q.id)) landing.push({ kind: 'run', id: q.id, label: label({ ...map[q.id].data, id: q.id }), word: mergeRunWord(q.id) });

  // 4. Forecast: usage now + the queued Claude work's rough cost
  const qc = upnext.filter(u => onClaude(map[u.id].data));
  const costed = qc.filter(u => u.estimate.cost !== null);
  const forecast = forecastOf({ status, budget, now, queuedCost: { pct: costed.reduce((s, u) => s + u.estimate.cost, 0), n: costed.length, of: qc.length, rough: costed.some(u => u.estimate.costBasis === 'rough') } });

  return { project, now: new Date(now).toISOString(), zone, upnext, chains, landing, landing_error: merges?.error ?? null, forecast, method: ESTIMATE_METHOD };
}

/** gather the inputs from a state dir and build the plan. o: { state, project (loaded project.json), budget, now, git } */
export function loadPlan({ state, project = null, budget = {}, now = Date.now(), git } = {}) {
  const runs = Object.values(fold(readEvents(recordsFile(state, 'run'))).items);
  let lanes = [];
  try { lanes = Object.values(fold(readEvents(recordsFile(state, 'lane'))).items).filter(l => l.kind === 'lane').map(l => ({ name: l.data?.name ?? String(l.id).slice(2), title: l.data?.title ?? null })); } catch { /* none */ }
  const ready = readiness(state, { now });
  let status = '';
  try { status = fs.readFileSync(path.join(state, 'STATUS.md'), 'utf8'); } catch { /* not written yet */ }
  let merges = null;
  if (project) { try { merges = mergeQueue({ stateDir: state, project, now, ...(git ? { git } : {}) }); } catch (e) { merges = { rows: [], error: String(e.message).slice(0, 300) }; } }
  let roadmap = [];
  try { roadmap = Object.values(loadRoadmap(state).items).filter(i => i.state !== 'dropped').map(i => ({ id: i.id, title: i.title, links: i.links })); } catch { /* none */ }
  return buildPlan({ project: project?.name ?? path.basename(path.resolve(state)), runs, ready, status, budget, merges, roadmap, lanes, pins: lanePins(state), now });
}

// ---------- text (norn plan, norn_plan) ----------
export const GLYPH = { check: '✓', play: '▶', ring: '○', pause: '‖', stop: '■', '!': '!' };
export function formatPlan(p) {
  const L = [`Plan - ${p.project ?? '-'}   (times in ${p.zone ?? 'local time'})`, '', 'Up next'];
  if (!p.upnext.length) L.push('  nothing is waiting to start');
  for (const u of p.upnext) L.push(`  ${u.position}. ${u.label} (${u.id})  ${u.estimate.word}  start ${u.start.word}${u.start.why ? ` (${u.start.why})` : ''}  - ${u.holds.join('; ')}`);
  L.push('', 'Chains');
  if (!p.chains.length) L.push('  no queued run waits for another');
  for (const c of p.chains) {
    L.push(`  ${c.steps.map(s => `${GLYPH[s.shape]} ${s.label}`).join(' > ')}   ${c.finished ? c.finish.word : `finish ${c.finish.word}${c.finish.note ? ` ${c.finish.note}` : ''}`}${c.rm ? `   [${c.rm.id} ${c.rm.title}]` : ''}`);
    if (c.broken) L.push(`    ! ${c.broken}`);
  }
  L.push('', 'Landing next');
  if (!p.landing.length) L.push(`  nothing is heading to main${p.landing_error ? ` (${p.landing_error})` : ''}`);
  p.landing.forEach((l, i) => L.push(`  ${i + 1}. ${l.label} (${l.id})  ${l.word}`));
  const f = p.forecast;
  L.push('', 'Forecast');
  if (f.weekly !== null) L.push(`  usage ${f.rate ?? '-'} %/h (cap ${f.cap ?? '-'} %/h); this week ~${f.weekly} %${f.stop !== null ? ` of the ${f.stop} % stop` : ''}`);
  L.push(`  ${f.line}`);
  if (f.costLine) L.push(`  ${f.costLine}`);
  L.push('', p.method);
  return L.join('\n');
}
