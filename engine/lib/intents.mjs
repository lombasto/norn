// lane-collide S1a (SPEC 3.2): the intents of one home - every piece of open work as the record collide.mjs judges - gathered from the
// records, the briefs and git. Open work = a running or queued run, an open deliverable not on main, and a lane branch ahead of main
// whose last run ended within recent_days. Git facts: the changed files (merge-base with main), the commits ahead, the tip, and which
// unmerged branch another one contains (order / stacked). Also the work claim of a launch (claims.mjs's `me`): runs.mjs imports it back.
// Not here yet: the other homes' claims and the upstream branches (SPEC stage S8), the item's lead (S6).
// git-perf S1: every git fact comes from gitfacts.mjs (HEAD and refs from the files, sha-keyed answers memoized, bounded children).
import fs from 'node:fs';
import path from 'node:path';
import { readEvents, recordsFile, fold, idNum, record } from './records.mjs';
import { parseReady } from './ready.mjs';
import { readScope, ahead, caseKey, pairKey } from './collide.mjs';
import { gitOut, gitDirs, shaOf, mergeBase, diffNames, countOf, isAncestorOf, worktreeFacts, lines, memo } from './gitfacts.mjs';

const have = p => !!p && fs.existsSync(p);
/** the files a worktree changes against its merge-base with origin/main (SPEC 3.6 touched; [] without a worktree or origin/main).
 * ttlMs: a list read within ttlMs for the same HEAD and merge-base is reused (gitfacts worktreeFacts) */
export const touchedOf = (worktree, { ttlMs = 0 } = {}) => worktreeFacts(worktree, { ttlMs, commits: false })?.touched ?? [];
// the open roadmap items linking one of `links`, from the item events (roadmap.mjs imports runs.mjs: its fold here would close a cycle)
export function laneItems(events, links) {
  const L = {}, open = {};
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.kind !== 'item') continue;
    const d = e.data || {};
    if (e.ev === 'create') { L[e.id] = new Set(d.links || []); open[e.id] = true; }
    if (!L[e.id]) continue;
    if (e.ev === 'link') for (const x of d.links || []) L[e.id].add(x);
    if (e.ev === 'unlink') for (const x of d.links || []) L[e.id].delete(x);
    if (e.ev === 'drop' || e.ev === 'reopen') open[e.id] = e.ev === 'reopen';
  }
  return Object.keys(L).filter(id => open[id] && links.some(l => L[id].has(l)));
}
const itemEvents = state => { try { return readEvents(recordsFile(state, 'item')); } catch { return []; } };
/** the work claim of a launch: branch + touched from its worktree (merge-base with origin/main), scope from its brief's Scope: line
 *  (none = the whole repo), items = the open roadmap items linking its lane (this home's roadmap until S1d merges the others).
 *  ttlMs: touched may be up to ttlMs old for an unchanged HEAD (the queue walk's pre-check; a start reads it fresh) */
export function workOf(o, home, project, { ttlMs = 0 } = {}) {
  const f = worktreeFacts(o.worktree, { ttlMs, commits: false }), br = f?.branch, touched = f?.touched ?? [];
  let scope = [];
  try { scope = parseReady(fs.readFileSync(o.brief, 'utf8')).scope; } catch { /* no brief file: the whole repo */ }
  const items = laneItems(itemEvents(o.state), [`lane:${home}/${o.lane}`, `lane:${o.lane}`]);
  return { project, home, lane: o.lane, branch: br && br !== 'HEAD' ? br : null, items, scope, touched, run: o.resumeOf ?? null };
}

// ---------- the intent of a brief ----------
const LANDING = /^(merge\d*|resolve)$/i;
/** the role of a run for the judge: work | landing | review | helper | none (writes nothing) */
export const roleOf = d => (['checkin', 'audit', 'talk', 'interactive'].includes(d.kind) ? 'none' : d.role === 'helper' ? 'helper'
  : LANDING.test(String(d.stage ?? '')) ? 'landing' : d.critique || /REVIEW/i.test(String(d.stage ?? '')) ? 'review' : 'work');
const heading = text => String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
const ids = (s, re) => [...new Set(String(s ?? '').match(re) || [])];
/** what a brief file says: { scope, why, exclusive, tests, done, heading items, names: { runs, dlvs, lanes } } (no file = nothing) */
export function briefFacts(file) {
  let text = null;
  try { text = file ? fs.readFileSync(file, 'utf8') : null; } catch { /* a brief that is gone: nothing declared */ }
  if (text == null) return { scope: null, why: 'no brief file', exclusive: [], tests: null, done: null, items: [], names: {} };
  const r = parseReady(text), s = readScope(r.scope);
  return { scope: s.scope, why: s.why ?? null, exclusive: r.exclusive, tests: r.tests, done: r.done, items: ids(heading(text), /\bRM-\d+\b/g),
    names: { runs: ids(text, /\bRUN-(?:[a-z][a-z0-9]{0,7}-)?\d+\b/g), dlvs: ids(text, /\bDLV-\d+\b/g), lanes: [...String(text).matchAll(/\blane `?([A-Za-z0-9][A-Za-z0-9_.-]*)`?/g)].map(m => m[1]) } };
}

// ---------- git facts ----------
/** the main ref git compares against: { name (<remote>/<main> when it exists, else <main>), ref (its full name), sha } */
export function mainRef(repo, { main = 'main', remote = 'origin' } = {}) {
  const r = shaOf(repo, `refs/remotes/${remote}/${main}`);
  return r ? { name: `${remote}/${main}`, ref: `refs/remotes/${remote}/${main}`, sha: r } : { name: main, ref: `refs/heads/${main}`, sha: shaOf(repo, `refs/heads/${main}`) };
}
const commonOf = repo => gitDirs(repo)?.common ?? repo;
/** a tip's facts against main: { touched, commits } (memoized by commit id) */
function tipFacts(repo, tip, ref) {
  const c = commonOf(repo), base = tip && ref.sha && mergeBase(repo, c, tip, ref.sha);
  return base ? { touched: diffNames(repo, c, base, tip) ?? [], commits: countOf(repo, c, ref.sha, tip) } : { touched: [], commits: 0 };
}
/** a worktree's facts: { branch, tip, touched (commits + tracked edits), commits } | null */
function treeFacts(wt, ref, ttlMs = 0) {
  const f = worktreeFacts(wt, { main: ref.ref, ttlMs });
  return f && { branch: f.branch, tip: f.tip, touched: f.touched, commits: f.commits };
}
const onMain = (repo, tip, ref) => !!tip && !!ref.sha && isAncestorOf(repo, commonOf(repo), tip, ref.sha);
// each tip's commits ahead of main, from ONE `git rev-list --parents` of all tips (the DAG walked here): a merge-base per pair cost the
// door a git child per other lane for every new tip (SPEC 4.2 cost, 8 live lanes)
function aheadSets(repo, tips, ref) {
  const par = new Map(lines(gitOut(repo, ['rev-list', '--parents', ...new Set(tips), `^${ref.sha}`]) ?? '').map(l => { const [h, ...p] = l.split(' '); return [h, p]; }));
  return new Map(tips.map(t => { const seen = new Set(), st = [t]; while (st.length) { const h = st.pop(); if (!seen.has(h) && par.has(h)) { seen.add(h); st.push(...par.get(h)); } } return [t, seen]; }));
}
/** order / stacked (a git fact): for each pair that shares commits not on main (n of them), the later one is stacked on the one whose tip
 *  it holds (neither: the one ahead in the queue is the base); memoized per main tip and pair */
export function stackPairs(repo, intents, ref) {
  const t = intents.filter(x => x.tip), c = commonOf(repo);
  if (!ref.sha) return;
  let sets;
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
    const a = t[i], b = t[j];
    if (a.tip === b.tip) continue;
    const [x, y] = [a.tip, b.tip].sort(), k = memo(c, `stack ${ref.sha} ${x} ${y}`, () => {
      sets ??= aheadSets(repo, t.map(z => z.tip), ref);
      const X = sets.get(x), Y = sets.get(y), n = [...X].filter(h => Y.has(h)).length;
      return { n, holds: Y.has(x) ? x : X.has(y) ? y : null };   // holds: the tip the other one holds (its base)
    });
    if (!k?.n) continue;
    const [base, top] = k.holds === a.tip ? [a, b] : k.holds === b.tip ? [b, a] : ahead(b, a) ? [b, a] : [a, b];
    top.stacked_on = [...(top.stacked_on || []), { lane: base.lane, n: k.n }];
  }
}

const LIVE = { running: 'running', queued: 'queued', claimed: 'queued' };
const tsOf = r => Date.parse(r.history?.[0]?.ts ?? r.created ?? 0) || 0;
const endOf = r => Date.parse(r.history?.at(-1)?.ts ?? 0) || 0;

/**
 * gatherIntents({ state, repo, main, remote, now, recent_days, home, ttlMs, tracked }) -> { intents, runs, dlvs, ref, tracked, itemEvents } - the open
 * work of one home, newest run per lane. Read-only: git reads and record reads, nothing written. ttlMs: a worktree's changed files may be
 * that old for an unchanged HEAD (the fill walk's); tracked: false = no `git ls-files` (only the scopes grade reads it, and it never holds)
 */
export function gatherIntents({ state, repo, main = 'main', remote = 'origin', now = Date.now(), recent_days = 3, home = null, ttlMs = 0, tracked = true }) {
  const runs = fold(readEvents(recordsFile(state, 'run'))).items, dlvs = fold(readEvents(recordsFile(state, 'deliverable'))).items, ev = itemEvents(state);
  const ref = have(repo) ? mainRef(repo, { main, remote }) : null, out = new Map();
  const itemsOf = (lane, run, extra = []) => [...new Set([...laneItems(ev, [`lane:${lane}`, ...(home ? [`lane:${home}/${lane}`] : []), ...(run ? [`run:${run}`] : [])]), ...extra])];
  const intentOf = (r, state0) => {
    const d = r.data || {}, b = briefFacts(d.brief), g = state0 === 'running' && ref ? treeFacts(d.worktree, ref, ttlMs) : null;
    return { lane: d.lane, run: r.id, stage: d.stage ?? null, state: state0, since: tsOf(r), role: roleOf(d), items: itemsOf(d.lane, r.id, b.items), part_of: d.part_of ?? null,
      scope: b.scope, scope_why: b.why, exclusive: b.exclusive, touched: g?.touched || [], commits: g?.commits || 0, branch: g?.branch ?? null, tip: g?.tip ?? null,
      dlv: null, stacked_on: [], names: b.names, tests: b.tests, done: b.done, brief: d.brief ?? null, worktree: d.worktree ?? null };
  };
  const all = Object.values(runs).filter(r => r.kind === 'run' && r.data?.lane).sort((a, b) => idNum(a.id) - idNum(b.id));
  for (const r of all) if (LIVE[r.state] && !(out.get(r.data.lane)?.state === 'running')) out.set(r.data.lane, intentOf(r, LIVE[r.state]));
  // an open deliverable not on main: the lane's unlanded work (a live run on the lane carries its DLV id)
  for (const x of Object.values(dlvs).filter(x => x.kind === 'deliverable' && ['open', 'parked'].includes(x.state) && x.data?.lane)) {
    const h = [...(x.history || [])].reverse().find(e => ['merged', 'done', 'create'].includes(e.ev)), d = x.data, tip = x.history?.filter(e => e.data?.tip).at(-1)?.data.tip ?? d.tip;
    if (h?.ev === 'merged' || (ref && onMain(repo, tip, ref))) continue;
    const live = out.get(d.lane);
    if (live) { live.dlv ??= x.id; continue; }
    const r = runs[d.run], base = r ? intentOf(r, 'unlanded') : { lane: d.lane, run: null, stage: null, since: 0, role: 'work', items: itemsOf(d.lane, null), part_of: null, scope: null, exclusive: [], stacked_on: [], names: {} };
    out.set(d.lane, { ...base, state: 'unlanded', since: Date.parse(d.done_utc ?? '') || base.since, dlv: x.id, branch: d.branch ?? null, tip, ...(ref ? tipFacts(repo, tip, ref) : { touched: [], commits: 0 }) });
  }
  // a lane branch ahead of main whose last run ended within recent_days (paused work with commits)
  const last = new Map();
  for (const r of all) last.set(r.data.lane, r);
  for (const [lane, r] of last) {
    if (out.has(lane) || LIVE[r.state] || now - endOf(r) > recent_days * 864e5 || !ref) continue;
    const g = treeFacts(r.data.worktree, ref, ttlMs);
    if (g?.commits) out.set(lane, { ...intentOf(r, 'unlanded'), ...g, since: endOf(r) });
  }
  const intents = [...out.values()];
  if (ref) stackPairs(repo, intents, ref);
  return { intents, runs, dlvs, ref, tracked: ref && tracked ? lines(gitOut(repo, ['ls-files'])) : null, itemEvents: ev };
}

/** the intent of a run that would start now: lane L, brief F (its worktree = the one given, else the lane's newest run's, when it is still
 *  there). S1b: a queued run judged by the fill walk passes state 'queued', its run id and its queue time as since */
export function briefIntent({ lane, brief, item = null, stage = null, role = null, kind = 'worker', critique = null, now = Date.now(), home = null, worktree = null,
  state = 'new', run = null, since = now, part_of = null, ttlMs = 0 }, g, { repo } = {}) {
  const b = briefFacts(brief), prev = Object.values(g.runs).filter(r => r.kind === 'run' && r.data?.lane === lane && r.data.worktree).sort((a, b2) => idNum(b2.id) - idNum(a.id))[0];
  const t = g.ref ? treeFacts(worktree ?? prev?.data.worktree, g.ref, ttlMs) : null, d = { kind, role, stage, critique };
  const me = { lane, run, stage, state, since, role: roleOf(d), items: [...new Set([...laneItems(g.itemEvents, [`lane:${lane}`, ...(home ? [`lane:${home}/${lane}`] : [])]), ...b.items, ...(item ? [item] : [])])],
    part_of, scope: b.scope, scope_why: b.why, exclusive: b.exclusive, touched: t?.touched || [], commits: t?.commits || 0, branch: t?.branch ?? null, tip: t?.tip ?? null,
    dlv: null, stacked_on: [], names: b.names, tests: b.tests, done: b.done, brief: brief ? path.resolve(brief) : null };
  if (g.ref && me.tip) stackPairs(repo, [me, ...g.intents.filter(x => x.lane !== lane).map(x => ({ ...x, stacked_on: [] }))], g.ref);   // copies: only me's facts change
  return me;
}

// ---------- S1b: the cases (COL-n, records.mjs kind collision) and the pair rulings ----------
/** the collision records of a home: { COL-n: item } */
export const casesOf = state => { try { return fold(readEvents(recordsFile(state, 'collision'))).items; } catch { return {}; } };
const undoneOf = c => new Set(c.history.filter(h => h.ev === 'undo').map(h => h.data.action));
/** the actions of a case, each with its history index and whether it was undone */
export const actionsOf = c => { const u = undoneOf(c); return c.history.map((h, i) => ({ ...h, i })).filter(h => h.ev === 'action').map(h => ({ ...h.data, at: h.ts, by: h.by, i: h.i, undone: u.has(h.i) })); };
/** the pair rulings the judge reads: { pairKey: { verdict: 'allow', kinds: [] (every kind) | [kind], col, by, at, why } } - every allow
 *  action not undone, on any case (a ruling outlives the case that took it: an allow is per pair, not per case) */
export function rulingsOf(cases) {
  const out = {};
  for (const c of Object.values(cases)) for (const a of actionsOf(c)) {
    if (a.action !== 'allow' || a.undone) continue;
    const k = a.args?.pair, r = out[k], kinds = a.args?.kinds || [];
    out[k] = { verdict: 'allow', kinds: r && (!r.kinds.length || !kinds.length) ? [] : [...new Set([...(r?.kinds || []), ...kinds])], col: c.id, by: a.by, at: a.at, why: a.why ?? null };
  }
  return out;
}
const side = x => Object.fromEntries(Object.entries({ lane: x.lane, run: x.run ?? null, state: x.state, branch: x.branch ?? null, tip: x.tip ?? null, dlv: x.dlv ?? null }).filter(([, v]) => v != null));
/** the open case of hit h for intent me (one per key while it is open), else a new one -> COL id */
export function openCase(state, h, me, other, { door, by = 'launcher', cases = casesOf(state) } = {}) {
  const key = caseKey(h, me), was = Object.values(cases).find(c => c.state === 'open' && c.data.key === key);
  if (was) return was.id;
  const files = h.files || [];
  return record(state, { kind: 'collision', ev: 'open', by, data: { key, kind: h.kind, grade: h.grade ?? null, verdict: h.verdict, door, a: side(other ?? { lane: h.other }), b: side(me),
    ...(h.items?.length ? { item: h.items[0] } : {}), files: files.slice(0, 20), files_n: files.length, why: String(h.why).slice(0, 2000), recommended: h.pick ?? null, pair: pairKey(h.other, me.lane) } }).id;
}
/** one action on a case (S1b: hold, after, told, released, allow) */
export const caseAction = (state, id, action, { by = 'launcher', auto = by === 'launcher', args, why } = {}) =>
  record(state, { kind: 'collision', ev: 'action', id, by, data: { action, auto, ...(args ? { args } : {}), ...(why ? { why } : {}) } });
/** the planned stages per roadmap item from the item events (create / edit `stages`): { RM-n: { stages } } - the judge's order / planned
 *  input (the door cannot import roadmap.mjs: it imports runs.mjs) */
export function itemStages(events) {
  const out = {};
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) if (e.kind === 'item' && (e.ev === 'create' || e.ev === 'edit') && Array.isArray(e.data?.stages)) out[e.id] = { stages: [...e.data.stages] };
  return out;
}
