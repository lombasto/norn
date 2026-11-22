// The check-in diet: a check-in thinks only when there is something to decide, sized to the wake (the owner wants it tunable per task).
//   routine ends   - a run end the policy calls routine (policy.checkin.routine) is handled by code in the tick, never by a model:
//                    merge_done = a MERGE run ended DONE (its norn done result) -> reviewed; worker_done_stage = a worker DONE with a
//                    pushed head on an auto-stage lane -> reviewed: mergeq lands its deliverable (a fast gate's batch, else by code:
//                    landing.mjs; a failed landing queues the LLM MERGE). Every action is a run review record by: launcher
//                    with { routine, why }. STOPPED / HANDOFF / no-result / an unpushed head / a question by the run: a model.
//   debounce       - run ends within policy.checkin.debounce_min wake ONE tick (at the oldest new end + the window).
//   lane levels    - full (today) | on-end (its running / stall / idle facts never wake: a long design run is not re-reviewed
//                    while it runs) | none (merge-line-only lanes: none of its run facts wake; forced ticks still read STATUS).
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { boundedSync } from './bounded.mjs';
import { readEvents, recordsFile, fold, record, homeOf, roleAddrIn } from './records.mjs';
import { endOf, isWork } from './gate.mjs';
import { isMergeStage } from './usageguard.mjs';
import { POLICY_DEFAULTS, laneMatch } from './policy.mjs';

export const ROUTINE_KINDS = ['merge_done', 'worker_done_stage'];   // = the policy.checkin.routine row's options
export const LEVELS = ['none', 'on-end', 'full'];
// the defaults live in policy.mjs (the Settings rows): merge_done only reviews; worker_done_stage acts only on auto_stage lanes (none by default)
export const checkinPolicy = policy => ({ ...POLICY_DEFAULTS.checkin, ...(policy?.checkin || {}) });

/** the check-in level of a lane: none | on-end | full (a lane in both lists = none, the narrower promise) */
export const laneLevel = (cp, lane) => (laneMatch(cp.none_lanes, lane) ? 'none' : laneMatch(cp.on_end_lanes, lane) ? 'on-end' : 'full');
export const isMergeRun = d => isMergeStage(d?.stage) || /(^|[-_])merge$|^mq$/i.test(String(d?.lane || ''));

// ---------- routine ends ----------
/** a ref is on the remote: the worktree's remote-tracking branch is at (or past) the head - local refs only, no fetch */
export function pushedHead(wt, branch, head, git = 'git') {
  if (!wt || !branch || !head) return false;
  const r = boundedSync(git, ['merge-base', '--is-ancestor', head, `refs/remotes/origin/${branch}`], { cwd: wt, timeout: 10000 });   // proc-hygiene: tree-killing timeout
  return r.status === 0 && !r.error;
}
// the run itself asked something: a question it created, or a mail it sent to the check-in
const askedBy = (recEvs, mailEvs, id, home) => recEvs.some(e => e.run === id && e.kind === 'question' && e.ev === 'create')
  || mailEvs.some(e => e.run === id && e.ev === 'send' && e.data?.to === roleAddrIn('checkin', home));

/** a routine end -> { kind, action: review | stage, why, ... } or null (a model decides). ctx: { cp, recEvs, mailEvs, pushed(wt, branch, head), home } */
export function routineOf(r, { cp, recEvs = [], mailEvs = [], pushed = pushedHead, home = null }) {
  const d = r.data || {}, end = r.end || {};
  if (!isWork(d) || r.state !== 'exited' || r.review || end.outcome !== 'done') return null;
  if (askedBy(recEvs, mailEvs, r.id, home)) return null;
  if (isMergeRun(d)) return cp.routine.includes('merge_done') ? { kind: 'merge_done', action: 'review', why: `MERGE ${r.id} (${d.lane}) ended DONE (its norn done result): nothing to decide` } : null;
  if (!cp.routine.includes('worker_done_stage') || !laneMatch(cp.auto_stage, d.lane)) return null;
  if (!end.head || !end.branch || end.branch === 'main' || end.dirty?.files) return null;
  if (!pushed(d.worktree, end.branch, end.head)) return null;
  return { kind: 'worker_done_stage', action: 'stage', sha: end.head, branch: end.branch,
    why: `${r.id} (${d.lane}) ended DONE at pushed ${end.head.slice(0, 7)} on ${end.branch}; the lane auto-stages: the standard staged merge` };
}

const fwd = p => String(p).replace(/\\/g, '/');
/** the standard staged merge of a routine worker end: merge-brief --sha, then the MERGE run queued in the merge line (norn run --queue) */
export function stageArgs(p, r, rt, cp) {
  const d = r.data || {}, lane = d.lane, up = String(lane).toUpperCase();
  const reviews = d.notes ? path.dirname(d.notes) : path.join(p.briefs_dir || p.root || '.', lane);
  const out = fwd(path.join(p.briefs_dir || p.root || '.', `task-${up}-MERGE-brief.md`));
  const brief = ['merge-brief', '--project', fwd(p.file), '--lane', lane, '--branch', rt.branch, '--worktree', fwd(d.worktree), '--notes', fwd(path.join(reviews, 'MERGE-NOTES.md')),
    '--out', out, '--sha', rt.sha];
  const run = ['run', '--queue', '--project', fwd(p.file), '--lane', lane, '--stage', 'MERGE', '--brief', out, '--executor', 'claude',
    ...(cp.merge_agent ? ['--agent', cp.merge_agent] : []), '--model', cp.merge_model, '--effort', cp.merge_effort, '--as', 'launcher'];
  return { brief, run, out };
}
export const metaCli = metaCmd => args => { const r = spawnSync(process.execPath, [metaCmd, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true }); return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}`.trim() }; };

/**
 * The tick's code pass over unreviewed ends: every routine one is handled and recorded (run review by: launcher, data { refs, routine,
 * why }). o: { pushed, now }. Returns [{ id, kind, ok, note }]. MERGE-FIRST (3): a routine worker end is never staged as an LLM MERGE
 * any more - mergeq lands its deliverable (a fast gate's batch, else landing.mjs); only a failed landing queues a MERGE run.
 */
export function handleRoutineEnds(state, p, o = {}) {
  const cp = checkinPolicy(p.policy);
  if (!cp.routine.length) return [];
  const runEvs = readEvents(recordsFile(state, 'run')), recEvs = readEvents(recordsFile(state, 'question')), mailEvs = readEvents(recordsFile(state, 'mail'));
  const out = [];
  for (const r of Object.values(fold(runEvs).items)) {
    if (r.kind !== 'run') continue;
    const rt = routineOf(r, { cp, recEvs, mailEvs, pushed: o.pushed || pushedHead, home: homeOf(state)?.id });
    if (!rt) continue;
    const data = { refs: [r.id], routine: rt.kind, why: rt.why };
    if (rt.action === 'stage') data.why += p.merge?.gate?.fast ? ' (the fast merge-queue gate batches its deliverable: meta mergeq)'
      : ' (mergeq lands it by code: a conflict, red check or slop block queues its MERGE)';
    record(state, { kind: 'run', ev: 'review', id: r.id, by: 'launcher', data }, { run: null, ...(o.now ? { now: o.now } : {}) });
    out.push({ id: r.id, kind: rt.kind, ok: true, note: 'reviewed' });
  }
  return out;
}

// ---------- debounce ----------
/**
 * gate verdict (run, changes) -> null (check in now) or { until ISO } (fold into one tick at the oldest new end + the window).
 * Only a wake whose MAJOR facts are all run ends waits; anything else (a question, owner words, a stall, forced / follow-up) is now.
 */
export function debounceOf(gate, { runEvs, minutes, now = Date.now(), minor = [] }) {
  if (!gate?.run || !(minutes > 0) || gate.forced || !gate.changes?.length) return null;
  const plus = gate.changes.filter(x => x.startsWith('+')), kind = x => x.slice(1).split(':')[0];
  const ends = plus.filter(x => kind(x) === 'end');
  if (!ends.length || gate.changes.some(x => !['end', 'run', 'dlv', ...minor].includes(kind(x)))) return null;
  const at = ends.map(x => endOf(runEvs, x.slice(1).split(':')[1])).filter(Number.isFinite);
  if (!at.length) return null;
  const until = Math.min(...at) + minutes * 60000;
  return now < until ? { until: new Date(until).toISOString(), ends: ends.length } : null;
}

// ---------- the dashboard line ----------
/** routine reviews by the launcher per day: { day: n } */
export function mechanicalByDay(state, { since = 0 } = {}) {
  const out = {};
  for (const e of readEvents(recordsFile(state, 'run'))) if (e.ev === 'review' && e.by === 'launcher' && e.data?.routine && Date.parse(e.ts) >= since) out[e.ts.slice(0, 10)] = (out[e.ts.slice(0, 10)] || 0) + 1;
  return out;
}
/** the dashboard line per day: [{ day, n, mechanical, minor, full }] (n = model check-ins + mechanical ends), newest first */
export function checkinDays(state, { now = Date.now(), days = 7 } = {}) {
  const since = now - days * 86400e3, by = {}, row = d => (by[d] ??= { day: d, n: 0, mechanical: 0, minor: 0, full: 0 });
  for (const r of Object.values(fold(readEvents(recordsFile(state, 'run'))).items)) {
    if (r.kind !== 'run' || r.data?.kind !== 'checkin') continue;
    const t = Date.parse(r.created);
    if (t < since || t > now) continue;
    row(r.created.slice(0, 10))[r.data.tick_class === 'minor' ? 'minor' : 'full']++;
  }
  for (const [d, n] of Object.entries(mechanicalByDay(state, { since }))) row(d).mechanical += n;
  return Object.values(by).map(x => ({ ...x, n: x.mechanical + x.minor + x.full })).sort((a, b) => b.day.localeCompare(a.day));
}
/** doctor rows: the check-in diet in force for project p ({ level: ok | warn, text }) */
export function checkinDoctorLines(p) {
  const c = checkinPolicy(p.policy), L = x => (x.length ? x.join(', ') : 'none'), out = [];
  // SHIP-READY R1: plain words for a reader who never saw the policy keys (the warn lines below name the keys to edit)
  const said = { merge_done: 'a finished merge is reviewed', worker_done_stage: 'a finished worker on an auto-merge lane is reviewed (mergeq lands its work)' };
  const byCode = c.routine.filter(k => said[k]).map(k => said[k]);
  out.push({ level: 'ok', text: `${p.name}: check-ins: run ends within ${c.debounce_min} min share one check-in; done by code, no model turn: ${byCode.length ? byCode.join(', ') : 'nothing'}; auto-merge lanes: ${L(c.auto_stage)}; lanes that never wake a check-in: ${L(c.none_lanes)}; lanes checked only when a run ends: ${L(c.on_end_lanes)}` });
  for (const k of c.routine) if (!ROUTINE_KINDS.includes(k)) out.push({ level: 'warn', text: `${p.name}: policy.checkin.routine names ${k}, not a routine kind (${ROUTINE_KINDS.join(' | ')}): ignored` });
  if (c.auto_stage.length && !c.routine.includes('worker_done_stage')) out.push({ level: 'warn', text: `${p.name}: policy.checkin.auto_stage lists lanes but routine has no worker_done_stage: no lane is staged by code` });
  return out;
}
