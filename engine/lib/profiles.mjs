// META-OOTB-POLISH F-6: settings profiles are DATA (engine/presets/profiles/<name>.json, kind "profile") plus one orthogonal cost
// switch (cost.json, kind "cost": cheap / balanced / quality changes model + effort only). A profile is a starting point, never a
// silent rewrite: `norn setup` writes it only into an absent budget (or an existing one when the human names --profile),
// `norn project new --profile` only into the new project, and the dashboard only fills the Settings form (Save stays the human step).
// A profile routes only to the executors setup found and the generic role agents (or the project's own agent of that role).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORK_CLASSES } from './policy.mjs';
import { raiseToFloor } from './floor.mjs';

export const PROFILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'profiles');
export const COSTS = ['cheap', 'balanced', 'quality'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const ROLES = ['implementer', 'planner', 'runner'];
const CODEX = ['codex-sol', 'codex-astra'];
// the stand-in when a profile's class route names an executor this machine does not have (the starterPolicy picks)
const STAND_IN = { review: 'planner', diagnosis: 'planner' };

const read = f => JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8').replace(/^﻿/, ''));
/** { profiles (by order, the default first), cost: { cheap, balanced, quality } } */
// META-DASH-ASYNC R1: shipped engine data, read once at module load (as config.mjs reads its schemas) - a dash request never re-reads it
const ALL = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json')).sort().map(read);
export function loadProfiles() {
  const all = structuredClone(ALL);
  return { profiles: all.filter(x => x.kind === 'profile').sort((a, b) => a.order - b.order), cost: all.find(x => x.kind === 'cost')?.levels ?? {} };
}
const known = (what, n, list) => new Error(`unknown ${what} ${n} (known: ${list.join(', ')})`);
export function getProfile(name) {
  const { profiles } = loadProfiles(), p = name == null ? profiles.find(x => x.default) : profiles.find(x => x.name === name);
  if (!p) throw known('profile', name, profiles.map(x => x.name));
  return p;
}
function costOf(cost = 'balanced') {
  const c = loadProfiles().cost[cost];
  if (!COSTS.includes(cost) || !c) throw known('cost', cost, COSTS);
  return c;
}
export function checkChoice({ profile, cost } = {}) { if (profile !== undefined) getProfile(profile); if (cost !== undefined) costOf(cost); }
const step = (e, n) => (e ? EFFORTS[Math.max(0, Math.min(EFFORTS.length - 1, EFFORTS.indexOf(e) + n))] : e);
const model = (m, c) => c.model[m] ?? m;
const OWN_CAP = { max_sol: 'codex-sol', max_astra: 'codex-astra' };
const hasCodex = found => CODEX.some(x => found.includes(x));

/** The machine budget keys of a profile: its budget + its Codex caps (0 when setup found no Codex), check-in / worker model + effort by cost. */
export function profileBudget(p, { found = ['claude'], cost, floor = null } = {}) {
  const c = costOf(cost), on = k => (k === 'max_codex' ? hasCodex(found) : found.includes(OWN_CAP[k]));   // a closed / retired executor keeps 0
  const b = { ...p.budget, ...Object.fromEntries(Object.entries(p.codex).map(([k, v]) => [k, on(k) ? v : 0])) };
  for (const k of ['checkin_model', 'claude_model']) if (b[k]) b[k] = model(b[k], c);
  for (const k of ['checkin_effort', 'claude_effort']) if (b[k]) b[k] = step(b[k], c.effort_step);
  const w = raiseToFloor({ model: b.claude_model, effort: b.claude_effort }, floor);   // the worker floor in force (floor.mjs); check-ins keep theirs
  if (w.raised) Object.assign(b, { ...(b.claude_model ? { claude_model: w.model } : {}), ...(b.claude_effort ? { claude_effort: w.effort } : {}) });
  return b;
}

/** { executors, fallbacks } of a profile for this machine: executors not found -> the Claude stand-in (fallbacks: wait), the generic
 *  roles -> the project's own agent of that role (agents), model / effort by cost. */
export function profilePolicy(p, { found = ['claude'], cost, agents = [], floor = null } = {}) {
  const c = costOf(cost);
  const role = r => agents.find(a => a === r) ?? agents.find(a => a.endsWith('-' + r)) ?? r;
  const name = x => (ROLES.includes(x) ? role(x) : x);
  const executors = {};
  for (const cls of Object.keys(WORK_CLASSES)) {
    let [ex, m, e] = p.routing[cls];
    if (CODEX.includes(ex) && !found.includes(ex)) [ex, m, e] = [STAND_IN[cls] ?? 'implementer', 'claude-sonnet-5-5', 'medium'];
    const r = raiseToFloor({ model: model(m, c), effort: step(e, c.effort_step) }, floor);   // the worker floor in force (floor.mjs)
    executors[cls] = { executor: name(ex), model: r.model, effort: r.effort };
  }
  const fallbacks = Object.fromEntries(Object.entries(p.fallbacks).map(([k, v]) => [k, CODEX.includes(v) && !found.includes(v) ? 'wait' : name(v)]));
  return { executors, fallbacks };
}

/** The profile as Settings changes (key -> value): what the dashboard drop-down fills into the form. */
export function profileChanges(p, o = {}) {
  const { executors, fallbacks } = profilePolicy(p, o), ch = { ...profileBudget(p, o) };
  for (const [cls, r] of Object.entries(executors)) for (const k of ['executor', 'model', 'effort']) ch[`policy.executors.${cls}.${k}`] = r[k];
  for (const [k, v] of Object.entries(fallbacks)) ch[`policy.fallbacks.${k}`] = v;
  ch['policy.cadence.checkin_interval_min'] = p.scheduler.interval_min;
  return ch;
}

/** The dashboard's profile list: name, label, summary and the changes per cost level. */
export function profileChoices(o = {}) {
  return loadProfiles().profiles.map(p => ({ name: p.name, label: p.label, summary: p.summary, default: !!p.default,
    changes: Object.fromEntries(COSTS.map(c => [c, profileChanges(p, { ...o, cost: c })])) }));
}
