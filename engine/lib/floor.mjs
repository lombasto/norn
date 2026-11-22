// The worker floor: the lowest Claude model and effort any worker run may use, machine-wide (local/budget.json worker_min_model +
// worker_min_effort; blank or absent = no floor). Every place a worker model or effort is chosen obeys it:
//   - the launch (runs.mjs startRun / queueRun): a run below the floor is raised to it and the start record says so (floor: { from, to });
//     an explicit --model / --effort is raised too, never refused, so a check-in that asks for less still gets its work done
//   - Settings (policy.mjs applySettings): a worker setting saved below the floor is refused; raising the floor raises the settings
//     that are now below it in the same save (floorChanges)
//   - profiles (profiles.mjs): a profile's worker models / efforts are raised to the floor in force
//   - the check-in prompt (tick.mjs policyLine) and the generated policy lines name it
// Check-ins and the controller chat are not workers: their own model settings stand. Only Claude models are compared; a run on another
// family (codex, a typed executor's own model, fake) is left as it is.
export const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'];
const FAMILY = ['haiku', 'sonnet', 'opus', 'fable'];
// the Claude models a floor may name (lowest first); the model id the floor raises to is the floor's own value
export const FLOOR_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'];

/**
 * A Claude model name -> { family (0 haiku .. 3 fable), version [major, minor] | null (an alias: the latest of its family) }, or null
 * (not a Claude model: a codex / typed-executor model, 'fake', blank).
 */
export function claudeRank(model) {
  const s = String(model ?? '').trim().toLowerCase();
  if (!s) return null;
  const alias = FAMILY.indexOf(s);
  if (alias >= 0) return { family: alias, version: null };
  const m = s.match(/^claude-(haiku|sonnet|opus|fable)-(\d+)(?:-(\d+))?(?:[-@\[].*)?$/) || s.match(/^claude-(\d+)(?:-(\d+))?-(haiku|sonnet|opus)(?:[-@\[].*)?$/);
  if (!m) return null;
  return m[1] && FAMILY.includes(m[1]) ? { family: FAMILY.indexOf(m[1]), version: [Number(m[2]), Number(m[3] ?? 0)] }
    : { family: FAMILY.indexOf(m[3]), version: [Number(m[1]), Number(m[2] ?? 0)] };
}
/** a < b: -1, equal: 0, a > b: 1 (both Claude ranks; an alias counts as the latest of its family) */
function cmpRank(a, b) {
  if (a.family !== b.family) return a.family < b.family ? -1 : 1;
  if (!a.version || !b.version) return !a.version && !b.version ? 0 : !a.version ? 1 : -1;
  for (const i of [0, 1]) if (a.version[i] !== b.version[i]) return a.version[i] < b.version[i] ? -1 : 1;
  return 0;
}
/** true when Claude model `model` is below Claude model `floor` (false for a non-Claude model or no floor) */
export function modelBelow(model, floor) {
  const a = claudeRank(model), b = claudeRank(floor);
  return !!(a && b && cmpRank(a, b) < 0);
}
/** true when effort `e` is below effort floor `floor` (blank = the executor default: not below; an unknown effort is not judged) */
export function effortBelow(e, floor) {
  const i = EFFORT_ORDER.indexOf(String(e ?? '')), f = EFFORT_ORDER.indexOf(String(floor ?? ''));
  return i >= 0 && f >= 0 && i < f;
}
/** the floor in force from a machine budget: { model, effort } (each '' = none), or null when neither is set */
export function floorOf(budget = {}) {
  const model = claudeRank(budget?.worker_min_model) ? String(budget.worker_min_model) : '';
  const effort = EFFORT_ORDER.includes(budget?.worker_min_effort) ? budget.worker_min_effort : '';
  return model || effort ? { model, effort } : null;
}
/** the floor in words: "claude-opus-5-5 at medium effort or higher" */
export const floorText = f => (!f ? 'none' : [f.model && `${f.model} or a stronger Claude model`, f.effort && `effort ${f.effort} or higher`].filter(Boolean).join(', '));

/**
 * { model, effort } raised to floor f -> { model, effort, raised: { model?: [from, to], effort?: [from, to] } | null }.
 * Only a Claude model is raised; the effort is raised only on a Claude model (or no model given), since effort names are Claude's here.
 */
export function raiseToFloor({ model, effort } = {}, f) {
  if (!f) return { model, effort, raised: null };
  const raised = {}, claude = !model || claudeRank(model);
  let m = model, e = effort;
  if (f.model && model && modelBelow(model, f.model)) { raised.model = [model, f.model]; m = f.model; }
  if (f.effort && claude && effortBelow(effort, f.effort)) { raised.effort = [effort, f.effort]; e = f.effort; }
  return { model: m, effort: e, raised: Object.keys(raised).length ? raised : null };
}
// RM-26 the check-in floor: a check-in decides and delegates on its own, so it needs a competent model and effort (owner 2026-11-18).
// Fixed, not a setting. Unlike the worker floor it never refuses or raises (a check-in keeps its own model): the settings review flags
// a checkin_model / checkin_effort below it (policy checkinBelowFloor), the dashboard shows a notice while one is in force, and a
// decision a check-in run below it records is marked (records.mjs made_under.below_floor).
export const CHECKIN_FLOOR = { model: 'claude-opus-5-5', effort: 'medium' };
export const CHECKIN_FLOOR_TEXT = `the check-in floor (${CHECKIN_FLOOR.model}, effort ${CHECKIN_FLOOR.effort})`;
/** a check-in's { model, effort } below CHECKIN_FLOOR: [{ kind: 'model' | 'effort', value, to }] (the effort only on a Claude model) */
export function checkinBelow({ model, effort } = {}) {
  const out = [];
  if (modelBelow(model, CHECKIN_FLOOR.model)) out.push({ kind: 'model', value: model, to: CHECKIN_FLOOR.model });
  if (claudeRank(model) && effortBelow(effort, CHECKIN_FLOOR.effort)) out.push({ kind: 'effort', value: effort, to: CHECKIN_FLOOR.effort });
  return out;
}
/** the run kinds the floor binds: every run except a check-in (its own checkin_model / checkin_effort) */
export const floorBinds = o => o?.kind !== 'checkin';
