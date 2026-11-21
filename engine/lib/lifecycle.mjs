// Lane lifecycle (lane norn-lifecycle, owner 2026-11-18: "why was the lane orphaned? why didn't norn handle that itself?"): no lane
// sits. One rule per lane, pure over a loadState() fold (laneRules); the tick acts on the `tick` rules (tickLanes), the check-in on the
// `checkin` ones (digest section `lanes`, CHECKIN.md 2j, a gate wake through lanesProbe), the Lanes page shows each row's words.
//   orphan   a lane a check-in created and dispatched no run on before that check-in ended (solve-shack docs-fixer-2: the brief went to
//            RUN-26 on docs-fixer) - the tick archives it. Archive, not a refusal at create time: the check-in cannot know at its
//            `rec add lane` whether it will dispatch on it later in the same pass, and its end is the first moment that is known.
//   idle     an active lane with no live run, and no run at all or none ended for policy.idle_lanes.hours (model-tab-visualization:
//            a brief, no run, its item on horizon next) - a check-in finding: start it, park it with a why, or archive it
//   stopped  the latest run exited STOPPED and no run is live: archived by the tick when its work landed anyway (a `norn runs landed`
//            ruling, or the lane's deliverables merged: solve-shack run-efficiency); else a check-in finding every pass (resume it,
//            park it with a question, or archive it) - never archived by the tick while its work did not land
//   archive  a done lane (record done, or its latest run exited DONE) whose work is merged, with no open deliverable (no open PR) and no
//            live run: the tick archives it policy.done_lanes.archive_days after its end (0 = never). Its worktree goes only when it is
//            clean and fully on main; otherwise it stays and the archive records it as work at risk.
//   shipped  (LANE-TRUTH) a parked lane, or an active one whose last run ended without DONE, whose work is on main (dlvmerge.mjs
//            laneShipped) and no live run: the tick archives it at the next tick - parked / stopped + shipped is the contradiction the
//            owner saw on rm29 and model-tab-residual-trail, never a resting state. A done lane that shipped ages out (archive).
// An archive by the tick is the owner's Archive event by role `tick` with its why; the Lanes page Unarchive undoes it.
//   path     (item 9, MAIL-20) a lane whose last work run ended DONE with commits not on main reaches a PR by code: lanepaths.mjs tickPaths.
import fs from 'node:fs';
import path from 'node:path';
import { loadState, record, readEvents, recordsFile, fold, idNum as runNum, homeOf, laneNameIn, homeOfId, copyItems } from './records.mjs';
import { makeEval } from './after.mjs';
import { makeGit, workOnMain } from './dlvgit.mjs';
import { laneShipped } from './dlvmerge.mjs';
import { readJsonS } from './fsnap.mjs';

export const IDLE_H = 6, ARCHIVE_DAYS = 7;
const H = 3600e3, D = 24 * H;
export const LIVE = ['queued', 'claimed', 'running'];
export const endTs = r => r?.history.findLast(h => ['end', 'lost', 'kill', 'withdraw', 'fill'].includes(h.ev))?.ts ?? r?.updated ?? null;
const inDays = ms => { const d = Math.ceil(ms / D); return d <= 0 ? 'at the next tick' : `in ${d} day${d === 1 ? '' : 's'}`; };

/** the lane policy in force: { idleH, archiveDays } from a project policy (policy.idle_lanes.hours, policy.done_lanes.archive_days) */
export const lanePolicy = (policy = {}) => ({ idleH: Number.isFinite(policy?.idle_lanes?.hours) ? policy.idle_lanes.hours : IDLE_H,
  archiveDays: Number.isFinite(policy?.done_lanes?.archive_days) ? policy.done_lanes.archive_days : ARCHIVE_DAYS });

/**
 * One rule per active / done / parked lane that has one: [{ lane (name), id, rule: orphan | idle | stopped | archive | shipped, act: tick | checkin | wait,
 * at (ISO: when the tick acts, archive only), run (the latest run id), text (the Lanes page words), why (the archive why / the finding) }].
 * o: { now, idleH, archiveDays, landed (lane, run) -> the stopped run's work landed, merged (lane, run) -> the done lane's work is merged
 * and nothing of it is open (git: the tick's probe; default false = the tick never archives on a guess), shipped (lane, run) -> why its
 * work is on main | null (laneShipped over the records: laneHooks / tickLanes) }
 */
export function laneRules(st, { now = Date.now(), idleH = IDLE_H, archiveDays = ARCHIVE_DAYS, landed = () => false, merged = () => false, shipped = () => null, home = null } = {}) {
  const items = Object.values(st.items), byLane = {};
  for (const r of items) if (r.kind === 'run' && r.data?.lane) (byLane[r.data.lane] ??= []).push(r);
  const out = [];
  for (const l of items) {
    if (l.kind !== 'lane' || !['active', 'done', 'parked'].includes(l.state)) continue;
    const name = laneNameIn(l.id, home), runs = (byLane[name] || []).sort((a, b) => runNum(a.id) - runNum(b.id)), r = runs.at(-1);
    if (runs.some(x => LIVE.includes(x.state))) continue;
    const row = (rule, act, text, why, at = null) => out.push({ lane: name, id: l.id, rule, act, at, run: r?.id ?? null, text, why });
    // b = its newest run that is no queue bookkeeping (lanes.mjs BOOKKEEPING: a MERGE entry withdrawn before it started is no outcome)
    const b = runs.filter(x => !['withdrawn', 'filled'].includes(x.state)).at(-1) ?? r;
    const doneLane = l.state !== 'parked' && (l.state === 'done' || (b?.state === 'exited' && b.end?.outcome === 'done'));
    // LANE-TRUTH: a parked lane, or one whose last run ended without DONE, whose work is on main archives at the next tick (its one state
    // is shipped; a done one ages out below). Its words never repeat "stopped" / "parked": the row already says shipped.
    const sh = doneLane ? null : shipped(name, r);
    if (sh) { row('shipped', 'tick', 'archives at the next tick', `${l.state === 'parked' ? 'parked' : r ? `${r.id} ended ${r.end?.outcome ?? r.state}` : 'no run'}, but its work is on main (${sh})`); continue; }
    if (l.state === 'parked') continue;
    const maker = l.run ? st.items[l.run] : null;
    if (l.state === 'active' && !r && maker?.data?.kind === 'checkin' && maker.state !== 'running') {
      row('orphan', 'tick', 'orphan: its check-in dispatched nothing on it - archives at the next tick', `created by check-in ${maker.id}, which ended with no run on it (its work went to another lane or nowhere)`);
      continue;
    }
    if (doneLane) {
      if (!archiveDays || !b) continue;
      const ended = Date.parse(endTs(b) ?? l.updated);
      if (!merged(name, b)) { row('archive', 'wait', 'done, not merged: stays until its work is on main', null); continue; }
      const at = ended + archiveDays * D;
      row('archive', 'tick', `archives ${inDays(at - now)}`, `done, its work merged, nothing open: archived ${archiveDays} d after its end (policy.done_lanes.archive_days)`, new Date(at).toISOString());
      continue;
    }
    if (l.state !== 'active') continue;
    if (r?.state === 'exited' && r.end?.outcome === 'stopped') {
      if (landed(name, r)) row('stopped', 'tick', 'stopped, its work landed - archives at the next tick', `stopped (${r.id}) but its work landed (${r.landed ? `ruled landed: ${r.landed.why}` : 'its deliverables merged'})`);
      else row('stopped', 'checkin', 'stopped: needs a check-in decision', `${r.id} stopped${r.end.why ? `: ${r.end.why}` : ''} - resume it, park it with a question, or archive it`);
      continue;
    }
    const since = Date.parse(r ? endTs(r) : l.created);
    if (now - since > idleH * H) row('idle', 'checkin', r ? `idle: no run for ${Math.floor((now - since) / H)} h` : 'idle: no run',
      `${r ? `no run since ${r.id} ended ${Math.floor((now - since) / H)} h ago` : `no run since it was created ${Math.floor((now - since) / H)} h ago`} - start it, park it with a why, or archive it`);
  }
  return out;
}

// the tick's git answers for the Lanes page (the dash never runs git per lane): { at, landed: [lane], merged: [lane] }
export const laneRulesFile = state => path.join(state, 'lane-rules.json');
/** lanesView's hooks from the tick's caches: landed / merged (a ruling, or the lane named there) and path (lane -> its path to main
 * with its words, or null). A snapshot read in a dash GET: it primes both files. */
export function laneHooks(state) {
  const c = readJsonS(laneRulesFile(state)), ps = readJsonS(lanePathsFile(state))?.paths || {};
  // OVERVIEW-TRUTH (5) / LANE-TRUTH: a lane whose work is on main is shipped (dlvmerge.mjs laneShipped: the Lanes page takes it off the
  // active list), and landed / merged for its rule too - the row never says shipped while its rule still waits
  const shipped = laneShippedIn(state, ps), home = homeOf(state)?.id ?? null;
  const has = k => (l, r) => !!r.landed || !!c?.[k]?.includes(l) || !!shipped(l, r);
  // LANE-TRUTH: the lane's branch (branches.json, the tick's `norn branches --refresh`): gone (none of its names is a branch), merged (every
  // one left is on main: ancestry or cherry - nothing left to land), open, or null (no scan yet: unknown)
  const br = readJsonS(path.join(state, 'branches.json')), refs = br ? new Map((br.refs || []).map(r => [r.name, r])) : null;
  const branchOf = (l, lane = null) => { if (!refs) return null; const xs = laneBranchNames(l, { home, lane, dlvs: shipped.dlvs(l) }).map(b => refs.get(b)).filter(Boolean);
    return !xs.length ? 'gone' : xs.every(r => r.merged) ? 'merged' : 'open'; };
  return { home, landed: has('landed'), merged: has('merged'), shipped, branchOf, path: (l, now = Date.now()) => ps[l] ? { ...ps[l], ...pathWords(ps[l], now) } : null };
}
// LANE-TRUTH: shipped (lane, ...runs) -> why | null over a state dir's deliverable records (superseded ones included) and its lane paths:
// dlvmerge.mjs laneShipped, the one rule. .dlvs(lane) = the lane's deliverable records.
export function laneShippedIn(state, ps = readJsonS(lanePathsFile(state))?.paths || {}) {
  const dl = (() => { try { return Object.values(fold(readEvents(recordsFile(state, 'deliverable'))).items).filter(d => d.kind === 'deliverable'); } catch { return []; } })();
  const dlvs = l => dl.filter(d => d.data?.lane === l);
  return Object.assign((l, ...runs) => laneShipped({ dlvs: dlvs(l), path: ps[l] ?? null, runs }), { dlvs });
}
/** LANE-TRUTH: the other homes' lanes (read-only here) whose work is on main by what this machine holds: their deliverable copies
 * (records.mjs copyItems) by laneShipped, or one of their branches on main in branches.json -> [{ id, home, state, why }]. Listed for
 * that home (`norn deliverables recheck`), never written: a home writes only its own records. */
export function othersShipped(state) {
  const me = homeOf(state); if (!me) return [];
  const st = loadState(state), copies = copyItems(state, 'deliverable'), on = new Map((readJsonS(path.join(state, 'branches.json'))?.refs || []).map(r => [r.name, r]));
  return Object.values(st.items).filter(l => l.kind === 'lane' && l.state !== 'archived' && homeOfId(l.id, me.bare_home) !== me.id).flatMap(l => {
    const home = homeOfId(l.id, me.bare_home), name = laneNameIn(l.id, home), dlvs = copies.filter(d => d.home === home && d.data?.lane === name);
    const why = laneShipped({ dlvs }) || laneBranchNames(name, { home, lane: l, dlvs }).map(b => on.get(b)).filter(r => r?.merged).map(r => `${r.name} on main`)[0] || null;
    return why ? [{ id: l.id, home, state: l.state, why }] : [];
  });
}
/** LANE-TRUTH: does an Inbox row about a lane need the owner? Needs you holds an open question, or a lane stopped with no shipped work:
 * a parked lane (parked: true; rec = its LANE record) whose work shipped, that has no branch left or whose branch holds nothing off main
 * asks nothing, nor does an unreviewed stopped run of a shipped lane. h = laneHooks(state); no lane = not a lane row (true). The dash
 * Inbox and norn_inbox (mcp.mjs) read it. */
export const laneAsksOwner = (h, lane, { parked = false, rec = null } = {}) => !lane || (!h.shipped(lane) && !(parked && ['gone', 'merged'].includes(h.branchOf(lane, rec))));
// the names a lane's branch may have: its LANE record's, its deliverables', norn/<lane> and the multi-home form norn/<home>/<lane>
export const laneBranchNames = (l, { home = null, lane = null, dlvs = [] } = {}) =>
  [...new Set([lane?.data?.branch, ...dlvs.map(d => d.data?.branch), `norn/${l}`, home ? `norn/${home}/${l}` : null].filter(Boolean))];

/** the gate probe: a lane finding the check-in must act on (idle / stopped, from the facts the gate folded at that time) = `lanes:<rule>:L:x`, a MAJOR wake once */
export const lanesProbe = (policy, home = null) => ({ at, items, runs }) => {
  const st = { items: Object.fromEntries([...(items || []), ...(runs || [])].map(i => [i.id, i])) };
  return laneRules(st, { now: at, ...lanePolicy(policy), home }).filter(x => x.act === 'checkin').map(x => `lanes:${x.rule}:${x.id}`);
};

/**
 * The tick's step: archive every `tick` rule (orphan, stopped + landed, done + merged past archive_days), each a lane archive event by
 * role tick with { why, rule, worktree: removed | kept, at_risk? }. o: { now (ms), git, project (deliverables main), dry }. -> [{ id, rule, why, worktree, at_risk }]
 */
export function tickLanes(state, { project = {}, now = Date.now(), git = makeGit(), dry = false } = {}) {
  const st = loadState(state), ev = makeEval(state, { git }), main = project.deliverables?.main || 'main';
  const dlvs = Object.values(fold(readEvents(recordsFile(state, 'deliverable'))).items).filter(d => d.kind === 'deliverable');
  const laneDlvs = lane => dlvs.filter(d => d.data.lane === lane && d.state !== 'superseded');
  const dlvMerged = d => ev({ kind: 'dlv', id: d.id }).met;
  // LANE-TRUTH: work the records say is on main (laneShipped) is landed and merged here too - the answer the Lanes page shows
  const shipped = laneShippedIn(state);
  const landed = (lane, r) => !!r.landed || !!shipped(lane, r) || (laneDlvs(lane).length > 0 && laneDlvs(lane).every(dlvMerged));
  const merged = (lane, r) => !!shipped(lane, r) || (ev({ kind: 'run', id: r.id, state: 'merged' }).met && laneDlvs(lane).every(dlvMerged));
  const out = [], seen = { landed: [], merged: [] };
  const rules = laneRules(st, { now, ...lanePolicy(project.policy), home: homeOf(state)?.id ?? null, shipped,
    landed: (l, r) => landed(l, r) && !!seen.landed.push(l), merged: (l, r) => merged(l, r) && !!seen.merged.push(l) });
  if (!dry) try { fs.writeFileSync(laneRulesFile(state), JSON.stringify({ at: new Date(now).toISOString(), ...seen }) + '\n'); } catch { /* no cache: the Lanes page shows the rulings alone */ }
  for (const x of rules) {
    if (x.act !== 'tick' || (x.at && Date.parse(x.at) > now)) continue;
    const wt = x.run ? st.items[x.run]?.data?.worktree : null, w = x.rule === 'orphan' || dry ? { worktree: 'none' } : worktreeVerdict(wt, { main, git });
    const data = { why: `${x.why} - by the tick`, rule: x.rule, ...w };
    // a guard's refusal (records.mjs archiveGuard: a deliverable done and not merged) leaves this lane as it is, the others go on
    if (!dry) try { record(state, { kind: 'lane', ev: 'archive', id: x.id, by: 'tick', data }, { views: project.views || {} }); } catch (e) { out.push({ id: x.id, rule: x.rule, refused: e.message }); continue; }
    if (w.worktree === 'removed' && !removeWorktree(wt, { root: project.root, git })) { w.worktree = 'kept'; w.at_risk = `${wt}: git worktree remove failed`; }
    out.push({ id: x.id, rule: x.rule, why: data.why, worktree: w.worktree, ...(w.at_risk ? { at_risk: w.at_risk } : {}) });
  }
  return out;
}

// the archived lane's worktree goes only when it is clean (no change, no untracked file) and its HEAD is on main; otherwise it stays
// and the archive names it: { worktree: removed | kept | none, at_risk?: '<path>: <why>' } (removed = to remove, after the archive is written)
function worktreeVerdict(wt, { main, git }) {
  if (!wt || !fs.existsSync(wt)) return { worktree: 'none' };
  const dirty = git(wt, ['status', '--porcelain'], { allowFail: true });
  const head = git(wt, ['rev-parse', 'HEAD'], { allowFail: true })?.trim();
  const why = dirty === null || dirty === undefined ? 'not a git worktree' : dirty.trim() ? 'uncommitted changes' : !head || !workOnMain(wt, head, main, { git }) ? 'commits not on main' : null;
  return why ? { worktree: 'kept', at_risk: `${wt}: ${why}` } : { worktree: 'removed' };
}
const removeWorktree = (wt, { root, git }) => git(root && fs.existsSync(root) ? root : path.dirname(wt), ['worktree', 'remove', wt], { allowFail: true }) !== null && !fs.existsSync(wt);

// ---------- one CI-fix lane (lane norn-lifecycle item 7: ci-fix2, ci-fix3, ci-fix4 were a new lane per red; ci-fix2 died at start and sat) ----------
// Every red on main is a new stage (CI-<run id>) on THE one lane ci-fix - created on the first red, unarchived when the rules above
// archived it, never a second lane. Its branch is reset from main before the new stage when its previous work landed (the worker's
// first step: the lane worktree is clean and its HEAD is on main). A red met while a fix run is live waits for it (one writer).
// -> { lane, stage, round, create, unarchive, live (RUN id | null), reset, line (the digest's words) }
export const CI_FIX_LANE = 'ci-fix';
export function ciFixPlan(st, red, { landed = r => !!r.landed } = {}) {
  const l = st.items[`L:${CI_FIX_LANE}`], stage = `CI-${red.run}`;
  const runs = Object.values(st.items).filter(r => r.kind === 'run' && r.data?.lane === CI_FIX_LANE).sort((a, b) => runNum(a.id) - runNum(b.id));
  const live = runs.find(r => LIVE.includes(r.state))?.id ?? null, last = runs.at(-1);
  const round = Math.max(0, ...runs.filter(r => r.data.stage === stage).map(r => Number(r.data.round) || 1)) + 1;
  const reset = !!last && last.data.stage !== stage && landed(last);
  const steps = [!l ? `META rec add lane --name ${CI_FIX_LANE}` : l.state === 'archived' ? `META rec unarchive L:${CI_FIX_LANE}` : l.state === 'parked' ? `unpark L:${CI_FIX_LANE} (or rule its Q)` : null,
    live ? `queue it after ${live} (--after run:${live}:ended)` : null, reset ? `the brief's first step: reset the lane branch from main (its last work ${last.id} landed)` : null].filter(Boolean);
  return { lane: CI_FIX_LANE, stage, round, create: !l, unarchive: l?.state === 'archived', live, reset,
    line: `fix it on lane ${CI_FIX_LANE} stage ${stage} round ${round}${steps.length ? ' - ' + steps.join('; ') : ''}` };
}

// ---------- path to main (item 9, MAIL-20; owner 2026-11-18: "can't lose completed work or not merge it") ----------
// Finished work reaches a PR by code, never by check-in judgement: dash-latency (RUN-84), rm9, rm26, rm28 and ci-fix3 ended DONE with
// pushed commits not on main and no merge run, ever - the merge was left to a check-in and none staged it. Each tick (lanepaths.mjs
// tickPaths), for every active / done lane whose last work run ended DONE (a hand-off chain: its last run) and has no live work run, its branch is read:
//   no commits off main (a planner / design run) -> no path;  on main (workOnMain: ancestry, clean merges, git cherry, squash) -> merged
//   a MERGE run of the lane after that run is live -> merge step queued;  an open deliverable of the branch -> PR open / in the merge queue
//   commits not pushed -> pushed (a plain push, never a force); a refused push, or unpushed commits beside uncommitted files -> work at
//   risk, named, never staged;  a dirty worktree with its commits pushed -> staged, and named at risk
//   else -> its MERGE stage queued: merge-brief --sha <head> + norn run --queue --stage MERGE --priority P1 (checkins.mjs stageArgs).
//   A MERGE run after it that ended without landing the work is not re-queued (a loop): a finding.
// Work not on main for OFF_MAIN_H with no merge step is red (Lanes page + digest). The paths go to lane-paths.json for the dash, the
// digest and records.mjs (a lane whose work is not on main is archived only with the owner's override).
export const OFF_MAIN_H = 2;
export const lanePathsFile = state => path.join(state, 'lane-paths.json');
const ago = (since, now) => since ? Math.floor((now - Date.parse(since)) / H) : 0;
/** a path's words for the Lanes page / digest: { text, red } */
export function pathWords(x, now = Date.now()) {
  const risk = x.risk ? `; at risk: ${x.risk}` : '';
  if (x.state === 'merged') return { text: `merged (${x.sha})`, red: false };
  if (x.state === 'staged') return { text: `done: merge step queued (${x.merge})${risk}`, red: !!x.risk };
  if (x.state === 'pr') return { text: `${x.pr ? `PR #${x.pr} open` : `${x.dlv} open: in the merge queue`}${risk}`, red: !!x.risk };
  if (x.state === 'at_risk') return { text: `work at risk: ${x.why}`, red: true };
  const h = ago(x.since, now);
  return h >= OFF_MAIN_H ? { text: `work not on main for ${h} h: no merge step - ${x.why}${risk}`, red: true } : { text: `done, not on main yet: ${x.why}${risk}`, red: !!x.risk };
}
