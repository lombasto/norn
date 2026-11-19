// RM-37 safe pause: the actions of every pause; what a pause mode holds is pausemode.mjs (a leaf runs.mjs reads). (1) Set / clear a
// project's pause mode (state/PAUSED). (2) The safe pause of ONE running run: an urgent mail order (the PostToolUse hook injects it)
// to finish the step, commit, write the hand-off and end HANDOFF; that hand-off is marked paused and never auto-resumed - `norn
// resume RUN-n` queues its resume at the front. A run that reaches no clean point within policy.pause.clean_min is reported, never
// killed. (3) Pause half: N running runs, newest first, never a MERGE, never one near its end estimate. (4) Resume all: the hold
// released, the paused hand-offs queued, merges first.
import fs from 'node:fs';
import path from 'node:path';
import { record, readEvents, recordsFile, fold, RecordError } from './records.mjs';
import { queueRun, fillQueue, renameRetry } from './runs.mjs';
import { sendMail } from './mail.mjs';
import { isMergeStage } from './usageguard.mjs';
import { POLICY_DEFAULTS } from './policy.mjs';
import { MODE_NAMES, pauseFiles, readPause } from './pausemode.mjs';

export class PauseError extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const runsOf = state => fold(readEvents(recordsFile(state, 'run'))).items;

// ---------- (1) set / clear the mode ----------
/** set this project's pause (state/PAUSED) -> the pause read back */
export function setPause(state, { mode, by, why, now = new Date() }) {
  if (!MODE_NAMES.includes(mode)) throw new PauseError(`mode must be one of ${MODE_NAMES.join(' | ')} (got ${JSON.stringify(mode)})`);
  pauser(by, 'pause');
  fs.mkdirSync(state, { recursive: true });
  const f = path.join(state, 'PAUSED'), t = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(t, JSON.stringify({ mode, by, ...(why ? { why: String(why).slice(0, 300) } : {}), at: now.toISOString() }) + '\n');
  renameRetry(t, f);
  return readPause([f]);
}
/** clear this project's own pause -> the pause still in force (the machine-level file), or null */
export function clearPause(state) {
  try { fs.unlinkSync(path.join(state, 'PAUSED')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return readPause(pauseFiles(state));
}

// ---------- (2) the safe pause of one running run ----------
// policy.pause.clean_min: a run that has not ended this long after its pause order is reported; near_end_min: pause half leaves a run this close to its end estimate alone
const { clean_min: CLEAN_MIN, near_end_min: NEAR_END_MIN } = POLICY_DEFAULTS.pause;
const pol = (p, k, d) => { const n = Number(p?.pause?.[k]); return Number.isFinite(n) && n >= 0 ? n : d; };
export const cleanMin = p => pol(p, 'clean_min', CLEAN_MIN);
export const nearEndMin = p => pol(p, 'near_end_min', NEAR_END_MIN);
const isWork = r => r.kind === 'run' && !['checkin', 'interactive', 'audit'].includes(r.data.kind) && r.data.role !== 'helper';
export const PAUSERS = ['owner', 'dashboard', 'controller'];   // who pauses and resumes (never a check-in or a worker)
const pauser = (by, verb) => { if (!PAUSERS.includes(by)) throw new PauseError(`a ${by || 'caller with no role'} does not ${verb}: the owner or the controller does`); };
export const PAUSE_SUBJECT = 'PAUSE: stop at a clean point and hand off';
export const pauseOrder = (run, why) => `The owner pauses ${run}${why ? ` (${why})` : ''}. Ack this mail, then: finish the step in progress (do not start a new one), `
  + 'commit your work on your branch, write the hand-off (state, commits, the exact next step, open questions) and end with '
  + '`norn done --outcome handoff --handoff-file <file>`. Norn marks the hand-off paused: it is not auto-resumed; the owner resumes it.';
/** the pause order of a run, or of the run its nudge resumed (the order went to that session) -> the pause event data | null */
export function pauseOf(state, run, spec = {}) {
  const items = runsOf(state);
  return items[run]?.pause ?? (spec.nudge && spec.resumeOf ? items[spec.resumeOf]?.pause ?? null : null);
}
/** mail RUN-n the pause order (urgent) and record it -> { run, mail } */
export function pauseRun(state, { run, by, why }) {
  pauser(by, 'pause a run');
  const it = runsOf(state)[run];
  if (!it || it.kind !== 'run') throw new PauseError(`${run}: no such run`);
  if (it.state !== 'running') throw new PauseError(`${run} is ${it.state}, not running`);
  if (!isWork(it)) throw new PauseError(`${run} is a ${it.data.role === 'helper' ? 'helper' : it.data.kind} run: only a work run is paused (a helper ends with its parent)`);
  if (it.pause) throw new PauseError(`${run} was asked to pause at ${it.history.findLast(h => h.ev === 'pause').ts} (${it.pause.mail})`);
  const m = sendMail(state, { by, to: run, subject: PAUSE_SUBJECT, body: pauseOrder(run, why), urgent: true });
  record(state, { kind: 'run', ev: 'pause', id: run, by, data: { mail: m.id, ...(why ? { why: String(why).slice(0, 300) } : {}) } });
  return { run, mail: m.id };
}
/** a run's pause row state (the Runs / Lanes row actions): running = a work run that can be paused, asked = its order is out,
 *  handoff = a paused hand-off not yet resumed; null = no pause action */
export const pauseState = r => r?.kind !== 'run' ? null : r.state === 'running' && isWork(r) ? (r.pause ? 'asked' : 'running')
  : r.state === 'exited' && r.end?.paused && !r.resume?.next ? 'handoff' : null;
/** the paused hand-offs not yet resumed, merges first, then oldest first */
export function pausedHandoffs(state) {
  return Object.values(runsOf(state)).filter(r => pauseState(r) === 'handoff')
    .sort((a, b) => (isMergeStage(b.data.stage) - isMergeStage(a.data.stage)) || Number(a.id.slice(4)) - Number(b.id.slice(4)));
}
/** queue the resume of paused hand-off RUN-n at the front (P0, or the owner's priority) -> { run, next } */
export function resumeRun(state, { run, by, priority = 'P0' }) {
  pauser(by, 'resume a run');
  const it = runsOf(state)[run];
  if (!it || it.kind !== 'run') throw new PauseError(`${run}: no such run`);
  if (!(it.state === 'exited' && it.end?.paused)) throw new PauseError(`${run} is not a paused hand-off (${it.state}${it.end ? ' ' + it.end.outcome : ''})`);
  if (it.resume?.next) throw new PauseError(`${run} is resumed already: ${it.resume.next}`);
  const spec = readJson(path.join(state, 'runs', run + '.spec.json'));
  if (!spec) throw new PauseError(`${run}: its spec file is gone - start the lane again`);
  // a fresh agent on the same brief + the hand-off (as the auto-resume), never the nudged session or its mail prompt; a pause costs no resume
  const { run: _r, log: _l, final: _f, session_id: _s, lockFile: _k, lockFiles: _ks, resumeSid: _rs, nudge: _n, fromQueue: _q, ...rest } = spec;
  if (spec.nudge) delete rest.promptText;
  const count = spec.resumes || 0, q = queueRun({ ...rest, resumes: count, resumeOf: run, handoffFile: it.end.handoff, priority });
  try { record(state, { kind: 'run', ev: 'resume', id: run, by: 'launcher', data: { next: q.run, count, asked_by: by, why: `paused hand-off resumed by ${by} (${priority})` } }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; }
  return { run, next: q.run };
}

/** the runs whose pause order is older than min minutes and that still run, each once (pause-late.json) -> { title, body } | null */
export function lateNotice(state, { min = CLEAN_MIN, now = Date.now(), project = '' } = {}) {
  const f = path.join(state, 'pause-late.json'), items = runsOf(state), told = new Set((readJson(f)?.runs ?? []).filter(id => items[id]?.state === 'running'));
  const late = Object.values(items).filter(r => r.kind === 'run' && r.state === 'running' && r.pause && !told.has(r.id)
    && now - Date.parse(r.history.findLast(h => h.ev === 'pause').ts) >= min * 60000);
  if (!late.length) return null;
  fs.writeFileSync(f, JSON.stringify({ runs: [...told, ...late.map(r => r.id)] }));
  const list = late.map(r => `${r.id} (${r.data.lane})`).join(', ');
  return { title: `${project ? project + ': ' : ''}${late.length} run${late.length === 1 ? '' : 's'} not at a clean point`,
    body: `${list}: asked to pause over ${min} min ago and still running. Norn does not kill it: wait, mail it, or stop it (norn stop RUN-n).` };
}

// ---------- (3) pause half ----------
/** pick n running work runs to pause safely: newest first; never a MERGE, never one within nearEnd min of its end estimate -> { pick, skip, line } */
export function pickHalf(state, { n, nearEnd = NEAR_END_MIN, now = Date.now() } = {}) {
  const live = Object.values(runsOf(state)).filter(r => r.state === 'running' && isWork(r)).sort((a, b) => Number(b.id.slice(4)) - Number(a.id.slice(4)));
  const want = Number.isInteger(n) && n >= 0 ? n : Math.ceil(live.length / 2), pick = [], skip = [];
  for (const r of live) {
    const end = r.data.budget_min ? Date.parse(r.created) + r.data.budget_min * 60000 : null;
    const why = isMergeStage(r.data.stage) ? 'a merge' : r.pause ? 'asked to pause already' : end !== null && end - now <= nearEnd * 60000 ? `within ${nearEnd} min of its end estimate` : null;
    if (why) skip.push({ id: r.id, lane: r.data.lane, why });
    else if (pick.length < want) pick.push({ id: r.id, lane: r.data.lane, stage: r.data.stage ?? null });
  }
  const line = pick.length ? `Pause ${pick.length} of ${live.length} running: ${pick.map(r => `${r.id} (${r.lane})`).join(', ')}${skip.length ? `; left running: ${skip.map(r => `${r.id} (${r.why})`).join(', ')}` : ''}`
    : `Nothing to pause: ${live.length ? skip.map(r => `${r.id} (${r.why})`).join(', ') : 'no work run is running'}`;
  return { pick, skip, line };
}
/** pause the given runs (the confirmed pick) -> [{ run, mail } | { run, error }] */
export const pauseRuns = (state, runs, { by, why = 'pause half' }) => runs.map(run => { try { return pauseRun(state, { run, by, why }); } catch (e) { if (e instanceof PauseError || e instanceof RecordError) return { run, error: e.message }; throw e; } });

// ---------- (4) resume all ----------
/** release this project's pause and queue every paused hand-off (merges first), then fill -> { cleared, still, resumed, started } */
export function resumeAll(state, { by }) {
  pauser(by, 'resume');
  const was = readPause([path.join(state, 'PAUSED')]), still = clearPause(state);
  const resumed = pausedHandoffs(state).map(r => { try { return resumeRun(state, { run: r.id, by, priority: isMergeStage(r.data.stage) ? 'P0' : 'P1' }); } catch (e) { if (e instanceof PauseError) return { run: r.id, error: e.message }; throw e; } });
  return { cleared: was, still, resumed, started: fillQueue(state) };
}
