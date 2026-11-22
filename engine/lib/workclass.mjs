// META-TEND P2 (REPORT 4.2 gaps 1-2): the work class of a run. The launcher stamps it on EVERY run (runs.mjs runTail: `class` +
// `class_basis`); a run recorded before that is inferred at read time by the same rules and marked inferred, never stored back.
// The class table = the policy's work classes (policy.mjs WORK_CLASSES) + the coordinator roles (check-ins, merges, audit, chat).
// basis = how the class was decided:
//   given   the launch named it (--class, norn_run class, delegate / ask, a flow step)
//   role    a coordinator role (check-in major / minor by its tick class; the adopt read = audit)
//   stage   the stage says it (MERGE; PLAN / SPEC; DIAG; REVIEW; DOCS / PUBLISH)
//   agent   the role agent: *-planner = planning, *-runner = docs, *-implementer = implementation (critical on a policy critical lane)
//   policy  the policy table routes the executor (+ model / effort) to this class (the first in table order when several)
//   default none of these: implementation
import { WORK_CLASSES } from './policy.mjs';
import { isMergeStage } from './usageguard.mjs';

export const COORD_CLASSES = { checkin_major: 'Check-in (major)', checkin_minor: 'Check-in (minor)', merge: 'Merge', audit: 'Audit (adopt read)', chat: 'Chat' };
export const CLASS_LABELS = { ...WORK_CLASSES, ...COORD_CLASSES };
const STAGE_WORDS = [[/^(PLAN|SPEC)/i, 'planning'], [/^DIAG/i, 'diagnosis'], [/REVIEW/i, 'review'], [/^(DOCS?|PUBLISH)/i, 'docs']];

/** Fable = the cost class (owner Q4): a Fable model or the fable executor. */
export const isFable = d => /fable/i.test(String(d?.model ?? '')) || d?.executor === 'fable';

/**
 * The class of launch spec / run start data `d` (cls | class, kind, tickClass | tick_class, stage, lane, agent, executor, model,
 * effort) under policy `pol` ({ executors, critical_lanes }) -> { class, basis }.
 */
export function workClass(d = {}, pol = {}) {
  const given = d.cls ?? d.class;
  if (given) return { class: given, basis: 'given' };
  if (d.kind === 'checkin') return { class: (d.tickClass ?? d.tick_class) === 'minor' ? 'checkin_minor' : 'checkin_major', basis: 'role' };
  if (d.lane === 'adopt' && d.role === 'helper') return { class: 'audit', basis: 'role' };
  if (isMergeStage(d.stage)) return { class: 'merge', basis: 'stage' };
  const sw = STAGE_WORDS.find(([re]) => re.test(String(d.stage ?? '')));
  if (sw) return { class: sw[1], basis: 'stage' };
  const a = String(d.agent ?? '');
  if (/(^|-)planner$/.test(a)) return { class: 'planning', basis: 'agent' };
  if (/(^|-)runner$/.test(a)) return { class: 'docs', basis: 'agent' };
  if (/(^|-)implementer$/.test(a)) return { class: (pol.critical_lanes || []).includes(d.lane) ? 'critical_implementation' : 'implementation', basis: 'agent' };
  const names = [d.agent, d.executor].filter(Boolean), table = Object.entries(pol.executors || {}).filter(([k, e]) => Object.hasOwn(WORK_CLASSES, k) && names.includes(e?.executor));
  const exact = table.filter(([, e]) => (!e.model || e.model === d.model) && (!e.effort || e.effort === d.effort));
  const hit = (exact.length ? exact : table)[0];
  if (hit) return { class: hit[0], basis: 'policy' };
  return { class: 'implementation', basis: 'default' };
}

/** The class of a recorded run's start data: { class, basis, inferred } (stamped = class_basis on the record, or a class given at launch). */
export function classOfRun(d = {}, pol = {}) {
  if (d.class) return { class: d.class, basis: d.class_basis || 'given', inferred: false };
  return { ...workClass(d, pol), inferred: true };
}
