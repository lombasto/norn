// lane-collide S1a (SPEC 3.2): the intents of one home - every piece of open work as the record collide.mjs judges - gathered from the
// records, the briefs and git. Open work = a running or queued run, an open deliverable not on main, and a lane branch ahead of main
// whose last run ended within recent_days. Git facts: the changed files (merge-base with main), the commits ahead, the tip, and which
// unmerged branch another one contains (order / stacked). Also the work claim of a launch (claims.mjs's `me`): runs.mjs imports it back.
// Not here yet: the other homes' claims and the upstream branches (SPEC stage S8), the item's lead (S6).
// git-perf S1: every git fact comes from gitfacts.mjs (HEAD and refs from the files, sha-keyed answers memoized, bounded children).
import fs from 'node:fs';
import path from 'node:path';
import { readEvents, recordsFile, fold, idNum, record, NID, homeOfId } from './records.mjs';
import { boundedSync } from './bounded.mjs';
import { parseReady } from './ready.mjs';
import { readScope, ahead, caseKey, pairKey, foldLine } from './collide.mjs';
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
const itemEvents = state => readEvents(recordsFile(state, 'item'));
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
    names: { runs: ids(text, new RegExp(`\\b${NID('RUN')}\\b`, 'g')), dlvs: ids(text, new RegExp(`\\b${NID('DLV')}\\b`, 'g')), lanes: [...String(text).matchAll(/\blane `?([A-Za-z0-9][A-Za-z0-9_.-]*)`?/g)].map(m => m[1]) } };
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
export const onMain = (repo, tip, ref) => !!tip && !!ref.sha && isAncestorOf(repo, commonOf(repo), tip, ref.sha);
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
  // only this home's work is a live side (a record of another home is its copy: that home judges it; lifecycle laneRules, #252)
  const mine = x => !home || homeOfId(x.id, home) === home;
  const all = Object.values(runs).filter(r => r.kind === 'run' && r.data?.lane && mine(r)).sort((a, b) => idNum(a.id) - idNum(b.id));
  for (const r of all) if (LIVE[r.state] && !(out.get(r.data.lane)?.state === 'running')) out.set(r.data.lane, intentOf(r, LIVE[r.state]));
  // an open deliverable not on main: the lane's unlanded work (a live run on the lane carries its DLV id)
  for (const x of Object.values(dlvs).filter(x => x.kind === 'deliverable' && ['open', 'parked'].includes(x.state) && x.data?.lane && mine(x))) {
    const h = [...(x.history || [])].reverse().find(e => ['merged', 'done', 'create'].includes(e.ev)), d = x.data, tip = x.history?.filter(e => e.data?.tip).at(-1)?.data.tip ?? d.tip;
    if (h?.ev === 'merged' || (ref && onMain(repo, tip, ref))) continue;
    const live = out.get(d.lane);
    if (live) { live.dlv ??= x.id; continue; }
    const r = runs[d.run], base = r ? intentOf(r, 'unlanded') : { lane: d.lane, run: null, stage: null, since: 0, role: 'work', items: itemsOf(d.lane, null), part_of: null, scope: null, exclusive: [], stacked_on: [], names: {} };
    out.set(d.lane, { ...base, state: 'unlanded', since: Date.parse(d.done_utc ?? '') || base.since, dlv: x.id, branch: d.branch ?? null, tip, ...(ref ? tipFacts(repo, tip, ref) : { touched: [], commits: 0 }) });
  }
  // a lane branch ahead of main whose last run ended within recent_days (paused work with commits)
  // - not a lane whose deliverable merged after that run ended: its branch is landed work (a worker's own-branch merge left it "ahead")
  const last = new Map(), mergedAt = new Map();
  for (const r of all) last.set(r.data.lane, r);
  for (const x of Object.values(dlvs)) for (const e of x.kind === 'deliverable' && x.data?.lane ? x.history || [] : []) if (e.ev === 'merged')
    mergedAt.set(x.data.lane, Math.max(mergedAt.get(x.data.lane) ?? 0, Date.parse(e.ts) || 0));
  for (const [lane, r] of last) {
    if (out.has(lane) || LIVE[r.state] || now - endOf(r) > recent_days * 864e5 || !ref || (mergedAt.get(lane) ?? -1) >= endOf(r)) continue;
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
/** the collision records of a home: { COL-n: item }; a torn log throws (read as empty it would erase every owner allow ruling) */
export const casesOf = state => fold(readEvents(recordsFile(state, 'collision'))).items;
const undoneOf = c => new Set(c.history.filter(h => h.ev === 'undo').map(h => h.data.action));
/** the actions of a case, each with its history index and whether it was undone */
export const actionsOf = c => { const u = undoneOf(c); return c.history.map((h, i) => ({ ...h, i })).filter(h => h.ev === 'action').map(h => ({ ...h.data, at: h.ts, by: h.by, i: h.i, undone: u.has(h.i) })); };
/** the pair rulings the judge reads: { pairKey: { verdict: 'allow' | 'hold' (a wait: waiter, holder), kinds: [] (every kind) | [kind],
 *  col, by, at, why, part?: { lane, of, col } } } - every allow, wait and part action not undone, on any case, in time order: the later of
 *  an allow and a wait rules the pair (a ruling outlives the case that took it: it is per pair, not per case) */
export function rulingsOf(cases) {
  const out = {}, acts = Object.values(cases).flatMap(c => actionsOf(c).filter(a => ['allow', 'wait', 'part'].includes(a.action) && !a.undone).map(a => ({ ...a, col: c.id })));
  for (const a of acts.sort((x, y) => String(x.at).localeCompare(String(y.at)))) {
    const k = a.args?.pair, r = out[k], kinds = a.args?.kinds || [], base = { col: a.col, by: a.by, at: a.at, why: a.why ?? null, ...(r?.part ? { part: r.part } : {}) };
    if (a.action === 'part') out[k] = { ...(r || {}), part: { lane: a.args.lane, of: a.args.of, col: a.col } };
    else if (a.action === 'wait') out[k] = { verdict: 'hold', kinds, waiter: a.args.waiter, holder: a.args.holder, ...base };
    else out[k] = { verdict: 'allow', kinds: r?.verdict === 'allow' && (!r.kinds.length || !kinds.length) ? [] : [...new Set([...(r?.verdict === 'allow' ? r.kinds : []), ...kinds])], ...base };
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
// ---------- S2b: the folds (SPEC 4A.4 fold) - action `fold` on a case: { lane (folded), into, pending: RUN-n } while a live run on the
// folded lane holds it (the tick applies it when that run ends, as a second fold action naming pending_of), else the applied steps ----------
/** every fold action of the cases -> [{ col, i, at, by, why, undone, ...args }] */
export const foldsOf = cases => Object.values(cases).flatMap(c => actionsOf(c).filter(a => a.action === 'fold').map(a => ({ col: c.id, i: a.i, at: a.at, by: a.by, why: a.why ?? null, undone: a.undone, ...a.args })));
/** the pending folds the tick has still to apply: not undone, no applied fold names them */
export const pendingFolds = cases => { const fs2 = foldsOf(cases); return fs2.filter(f => f.pending && !f.undone && !fs2.some(g => g.col === f.col && g.pending_of === f.i)); };
/** the prompt lines of a start on lane `lane` (SPEC 4A.4 fold step 4): one per applied fold of a lane into it, until a run there that started after
 *  the fold (a run id above the fold's since_run) has ended DONE */
export function foldLines(state, lane, { cases = casesOf(state), runs = fold(readEvents(recordsFile(state, 'run'))).items } = {}) {
  const done = f => Object.values(runs).some(r => r.kind === 'run' && r.data?.lane === lane && idNum(r.id) > (f.since_run ?? 0) && r.state === 'exited' && (r.end?.outcome ?? 'done') === 'done');
  return foldsOf(cases).filter(f => f.into === lane && !f.pending && !f.undone && !done(f)).map(f => foldLine({ lane: f.lane, col: f.col, branch: f.branch, commits: f.commits_n }));
}
/** the planned stages per roadmap item from the item events (create / edit `stages`): { RM-n: { stages } } - the judge's order / planned
 *  input (the door cannot import roadmap.mjs: it imports runs.mjs) */
export function itemStages(events) {
  const out = {};
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) if (e.kind === 'item' && (e.ev === 'create' || e.ev === 'edit') && Array.isArray(e.data?.stages)) out[e.id] = { stages: [...e.data.stages] };
  return out;
}

// ---------- S1c: <state>/collide.json, the tick's cache (tick.mjs collidePass writes it; the digest and the pages only read it) ----------
/** { at, rows: [open collision rows, each with its COL id and SloppaChoppa's pick], handled: [Norn's automatic actions of the last day],
 *  wide: [other homes' claims of the whole repo] } */
export const collideFile = state => path.join(state, 'collide.json');
export const readCollide = state => { try { return JSON.parse(fs.readFileSync(collideFile(state), 'utf8')) || {}; } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } };

// ---------- S3 (SPEC 4A.6): the case as the report reads it, and the git facts of its outcome and of the replay ----------
const SIDE_KEYS = ['home', 'lane', 'run', 'state', 'branch', 'tip'];
const sideView = x => ({ ...Object.fromEntries(SIDE_KEYS.map(k => [k, x?.[k] ?? null])), ...(x?.dlv ? { dlv: x.dlv } : {}) });
/** caseView(c) -> the case with every field of 4A.6 (absent ones null): its sides, its actions (each with before, dec and as_recommended)
 *  and its undos ({ at, by, action (the undone action's name), i (its history index), why }) */
export function caseView(c) {
  const d = c.data || {}, acts = actionsOf(c);
  return { id: c.id, state: c.state, key: d.key ?? null, kind: d.kind ?? null, grade: d.grade ?? null, verdict: d.verdict ?? null, door: d.door ?? null, a: sideView(d.a), b: sideView(d.b),
    item: d.item ?? null, files: d.files || [], files_n: d.files_n ?? (d.files || []).length, resource: d.resource ?? null, recommended: d.recommended ?? null, why: d.why ?? null, pair: d.pair ?? null,
    actions: acts.map(a => ({ at: a.at, action: a.action, by: a.by, auto: !!a.auto, args: a.args ?? null, before: a.args?.before ?? null, dec: a.args?.dec ?? null,
      as_recommended: !a.auto && !!d.recommended && a.action === d.recommended.remedy, undone: a.undone, i: a.i, ...(a.why ? { why: a.why } : {}) })),
    undone: c.history.filter(h => h.ev === 'undo').map(h => ({ at: h.ts, by: h.by, action: c.history[h.data.action]?.data?.action ?? null, i: h.data.action, why: h.data.why ?? null })),
    outcome: c.outcome ?? null };
}
/** the commit a first-parent walk from sha finds before ms (main as it was then) | null */
export const firstParentBefore = (repo, sha, ms) => (sha && Number.isFinite(ms) ? gitOut(repo, ['rev-list', '-1', '--first-parent', `--before=${new Date(ms - 1000).toISOString()}`, sha]) || null : null);
// a port: a worker's "merge: main into ..." or git's own "Merge (remote-tracking) branch 'origin/main' into ..."
const PORT = /^(?:merge:?\s+(?:origin\/)?main|merge (?:remote-tracking )?branch '(?:origin\/)?main')\s+into\b/i;
/** git merge-tree of two commits -> clean | conflict | unknown (git failed); --quiet: the exit only, no objects kept */
const replayMerge = (repo, x, y) => { const r = boundedSync('git', ['-C', repo, 'merge-tree', '--write-tree', '--quiet', x, y], { timeout: 60000 }); return r.status === 0 ? 'clean' : r.status === 1 ? 'conflict' : 'unknown'; };
/**
 * landedMerge(repo, { tip, merge_commit }) -> { merge: clean | conflict | unknown, base } - how a merged branch landed, from git alone (SPEC 4A.6
 * merge for the landings that are not mechanical: a PR, a check-in's git merge). The landing merge is merge_commit, else the first merge on
 * main's ancestry path from tip with tip as a parent; base = its first parent (main just before). Each two-parent merge on the branch's
 * first parent since base (the ports) and the landing merge are replayed with merge-tree: one conflict = conflict (someone resolved it).
 * No landing merge found (a fast-forward, a rebase) or git unable to answer: unknown, never guessed. Memoized per repo, tip and merge commit.
 */
const LANDED = new Map();
export function landedMerge(repo, { tip, merge_commit = null } = {}) {
  const k = `${repo}|${tip}|${merge_commit}`;
  if (!LANDED.has(k)) LANDED.set(k, landedOnce(repo, tip, merge_commit));
  return LANDED.get(k);
}
function landedOnce(repo, tip, merge_commit) {
  if (!tip || !repo || !fs.existsSync(repo) || gitOut(repo, ['cat-file', '-e', `${tip}^{commit}`]) === null) return { merge: 'unknown', base: null };
  const parents = h => (gitOut(repo, ['rev-list', '--parents', '-n', '1', h]) ?? '').split(' ').slice(1);
  let M = merge_commit && merge_commit !== tip && parents(merge_commit).includes(tip) ? merge_commit : null;
  if (!M) { const ref = mainRef(repo); M = ref.sha ? lines(gitOut(repo, ['rev-list', '--merges', '--ancestry-path', '--reverse', '--parents', `${tip}..${ref.sha}`]) ?? '').map(l => l.split(' ')).find(([, ...p]) => p.includes(tip))?.[0] ?? null : null; }
  if (!M) return { merge: 'unknown', base: null };
  const base = parents(M)[0] ?? null, ports = lines(gitOut(repo, ['rev-list', '--first-parent', '--merges', '--parents', `${base}..${tip}`]) ?? '').map(l => l.split(' ').slice(1)).filter(p => p.length === 2);
  const got = [...ports, parents(M).slice(0, 2)].map(([x, y]) => replayMerge(repo, x, y));
  return { merge: got.includes('conflict') ? 'conflict' : got.includes('unknown') ? 'unknown' : 'clean', base };
}
/** ownWork(repo, tip, base) -> { files (the first-parent non-merge commits' changed files), from (ms: the first of them), ports: [{ at, files }]
 *  (each first-parent "merge: main into" commit and the files it brought onto the branch) } - a branch's own work since base */
export function ownWork(repo, tip, base) {
  if (!tip || !base) return { files: [], from: null, ports: [] };
  const own = gitOut(repo, ['log', '--first-parent', '--no-merges', '--name-only', '--format=@%ct', `${base}..${tip}`]) ?? '', files = new Set(), at = [];
  for (const l of lines(own)) if (l.startsWith('@')) at.push(Number(l.slice(1)) * 1000); else files.add(l);
  const ports = lines(gitOut(repo, ['log', '--first-parent', '--merges', '--format=%H%x09%ct%x09%s', `${base}..${tip}`]) ?? '').map(l => l.split('\t')).filter(([, , s]) => PORT.test(s ?? ''))
    .map(([h, t]) => ({ at: Number(t) * 1000, files: lines(gitOut(repo, ['diff', '--name-only', `${h}^1`, h]) ?? '') }));
  return { files: [...files].sort(), from: at.length ? Math.min(...at) : null, ports };
}
/** historySides(state, repo, { since, main, remote }) -> one side per deliverable merged at or after since (ms): { lane, dlv, pr, merged_at (ms),
 *  tip, files, from, ports } - its own work against main just before it merged (the landing merge's first parent: landedMerge, else main by date) */
export function historySides(state, repo, { since = 0, main = 'main', remote = 'origin' } = {}) {
  const ref = mainRef(repo, { main, remote }), out = [];
  for (const x of Object.values(fold(readEvents(recordsFile(state, 'deliverable'))).items)) {
    const m = (x.history || []).filter(h => h.ev === 'merged').at(-1), at = Date.parse(m?.data?.merged_at ?? m?.ts ?? '');
    if (!m || !(at >= since)) continue;
    const tip = m.data.tip ?? x.data?.tip, base = landedMerge(repo, { tip, merge_commit: m.data.merge_commit }).base ?? firstParentBefore(repo, ref.sha, at);
    out.push({ lane: x.data?.lane ?? null, dlv: x.id, pr: (x.history || []).filter(h => h.ev === 'pr').at(-1)?.data?.number ?? null, merged_at: at, tip, ...ownWork(repo, tip, base) });
  }
  return out;
}
