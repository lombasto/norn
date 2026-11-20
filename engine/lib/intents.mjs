// lane-collide S1a (SPEC 3.2): the intents of one home - every piece of open work as the record collide.mjs judges - gathered from the
// records, the briefs and git. Open work = a running or queued run, an open deliverable not on main, and a lane branch ahead of main
// whose last run ended within recent_days. Git facts: the changed files (merge-base with main), the commits ahead, the tip, and which
// unmerged branch another one contains (order / stacked). Also the work claim of a launch (claims.mjs's `me`): runs.mjs imports it back.
// Not here yet: the other homes' claims and the upstream branches (SPEC stage S8), the item's lead (S6).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEvents, recordsFile, fold } from './records.mjs';
import { parseReady } from './ready.mjs';
import { readScope, ahead } from './collide.mjs';

const gitOut = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 2 ** 20 }); return r.status === 0 ? r.stdout.trim() : null; };
const lines = s => String(s ?? '').split('\n').map(x => x.trim()).filter(Boolean);
const have = p => !!p && fs.existsSync(p);
/** the files a worktree changes against its merge-base with origin/main (SPEC 3.6 touched; [] without a worktree or origin/main) */
export function touchedOf(worktree) {
  const wt = have(worktree) ? worktree : null, base = wt && gitOut(wt, ['merge-base', 'HEAD', 'origin/main']);
  return base ? lines(gitOut(wt, ['diff', '--name-only', base])) : [];
}
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
 *  (none = the whole repo), items = the open roadmap items linking its lane (this home's roadmap until S1d merges the others) */
export function workOf(o, home, project) {
  const wt = have(o.worktree) ? o.worktree : null, br = wt && gitOut(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), touched = touchedOf(wt);
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
/** the main ref git compares against: <remote>/<main> when it exists, else <main> */
export const mainRef = (repo, { main = 'main', remote = 'origin' } = {}) => (gitOut(repo, ['rev-parse', '--verify', '-q', `${remote}/${main}`]) ? `${remote}/${main}` : main);
/** a tip's facts against main: { touched, commits } */
function tipFacts(repo, tip, ref) {
  const base = tip && gitOut(repo, ['merge-base', tip, ref]);
  return base ? { touched: lines(gitOut(repo, ['diff', '--name-only', base, tip])), commits: Number(gitOut(repo, ['rev-list', '--count', `${ref}..${tip}`]) || 0) } : { touched: [], commits: 0 };
}
/** a worktree's facts: { branch, tip, touched (commits + tracked edits), commits } | null */
function treeFacts(wt, ref) {
  if (!have(wt)) return null;
  const br = gitOut(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), tip = gitOut(wt, ['rev-parse', 'HEAD']), base = tip && gitOut(wt, ['merge-base', 'HEAD', ref]);
  return { branch: br && br !== 'HEAD' ? br : null, tip, touched: base ? lines(gitOut(wt, ['diff', '--name-only', base])) : [], commits: base ? Number(gitOut(wt, ['rev-list', '--count', `${ref}..HEAD`]) || 0) : 0 };
}
const onMain = (repo, tip, ref) => !!tip && spawnSync('git', ['merge-base', '--is-ancestor', tip, ref], { cwd: repo, windowsHide: true }).status === 0;
/** order / stacked (a git fact): for each pair whose merge-base is not on main, the later one is stacked on the one whose tip it holds */
export function stackPairs(repo, intents, ref) {
  const t = intents.filter(x => x.tip);
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
    const a = t[i], b = t[j], mb = a.tip !== b.tip && gitOut(repo, ['merge-base', a.tip, b.tip]);
    if (!mb || onMain(repo, mb, ref)) continue;
    const n = Number(gitOut(repo, ['rev-list', '--count', mb, `^${ref}`]) || 0), [base, top] = mb === a.tip ? [a, b] : mb === b.tip ? [b, a] : ahead(b, a) ? [b, a] : [a, b];
    if (n) top.stacked_on = [...(top.stacked_on || []), { lane: base.lane, n }];
  }
}

const LIVE = { running: 'running', queued: 'queued', claimed: 'queued' };
const tsOf = r => Date.parse(r.history?.[0]?.ts ?? r.created ?? 0) || 0;
const endOf = r => Date.parse(r.history?.at(-1)?.ts ?? 0) || 0;
const num = id => Number(String(id).match(/(\d+)$/)?.[1] ?? 0);

/**
 * gatherIntents({ state, repo, main, remote, now, recent_days, home }) -> { intents, runs, dlvs, ref, tracked, itemEvents } - the open work
 * of one home, newest run per lane. Read-only: git reads and record reads, nothing written.
 */
export function gatherIntents({ state, repo, main = 'main', remote = 'origin', now = Date.now(), recent_days = 3, home = null }) {
  const runs = fold(readEvents(recordsFile(state, 'run'))).items, dlvs = fold(readEvents(recordsFile(state, 'deliverable'))).items, ev = itemEvents(state);
  const ref = have(repo) ? mainRef(repo, { main, remote }) : null, out = new Map();
  const itemsOf = (lane, run, extra = []) => [...new Set([...laneItems(ev, [`lane:${lane}`, ...(home ? [`lane:${home}/${lane}`] : []), ...(run ? [`run:${run}`] : [])]), ...extra])];
  const intentOf = (r, state0) => {
    const d = r.data || {}, b = briefFacts(d.brief), g = state0 === 'running' && ref ? treeFacts(d.worktree, ref) : null;
    return { lane: d.lane, run: r.id, stage: d.stage ?? null, state: state0, since: tsOf(r), role: roleOf(d), items: itemsOf(d.lane, r.id, b.items), part_of: d.part_of ?? null,
      scope: b.scope, scope_why: b.why, exclusive: b.exclusive, touched: g?.touched || [], commits: g?.commits || 0, branch: g?.branch ?? null, tip: g?.tip ?? null,
      dlv: null, stacked_on: [], names: b.names, tests: b.tests, done: b.done, brief: d.brief ?? null, worktree: d.worktree ?? null };
  };
  const all = Object.values(runs).filter(r => r.kind === 'run' && r.data?.lane).sort((a, b) => num(a.id) - num(b.id));
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
    const g = treeFacts(r.data.worktree, ref);
    if (g?.commits) out.set(lane, { ...intentOf(r, 'unlanded'), ...g, since: endOf(r) });
  }
  const intents = [...out.values()];
  if (ref) stackPairs(repo, intents, ref);
  return { intents, runs, dlvs, ref, tracked: ref ? lines(gitOut(repo, ['ls-files'])) : null, itemEvents: ev };
}

/** the intent of a run that would start now: lane L, brief F (its worktree = the lane's newest run's, when it is still there) */
export function briefIntent({ lane, brief, item = null, stage = null, role = null, kind = 'worker', now = Date.now(), home = null }, g, { repo } = {}) {
  const b = briefFacts(brief), prev = Object.values(g.runs).filter(r => r.kind === 'run' && r.data?.lane === lane && r.data.worktree).sort((a, b2) => num(b2.id) - num(a.id))[0];
  const t = g.ref ? treeFacts(prev?.data.worktree, g.ref) : null, d = { kind, role, stage };
  const me = { lane, run: null, stage, state: 'new', since: now, role: roleOf(d), items: [...new Set([...laneItems(g.itemEvents, [`lane:${lane}`, ...(home ? [`lane:${home}/${lane}`] : [])]), ...b.items, ...(item ? [item] : [])])],
    part_of: null, scope: b.scope, scope_why: b.why, exclusive: b.exclusive, touched: t?.touched || [], commits: t?.commits || 0, branch: t?.branch ?? null, tip: t?.tip ?? null,
    dlv: null, stacked_on: [], names: b.names, tests: b.tests, done: b.done, brief: brief ? path.resolve(brief) : null };
  if (g.ref && me.tip) stackPairs(repo, [me, ...g.intents.filter(x => x.lane !== lane).map(x => ({ ...x, stacked_on: [] }))], g.ref);   // copies: only me's facts change
  return me;
}
