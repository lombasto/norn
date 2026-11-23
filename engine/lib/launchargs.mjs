// GAP-4 (the check-in invents launch arguments: `--agent worker` once, launchpolicy.mjs agentRefusal): every value a `norn run` caller
// can make up is checked against what exists BEFORE the run starts or is queued, and a refusal names the valid choices - a model that
// reads it can fix its line in the same pass. One home for the value lists: `norn run` checks with them (norn.mjs runSpec) and the
// check-in prompt shows them on its launch line (tick.mjs renderCheckin, CHECKIN.md {{executors}} {{models}} {{efforts}}).
//   --executor  a built-in or an enabled typed executor of the project (executors.mjs)
//   --model     claude: the Claude ids Norn knows (floor.mjs FLOOR_MODELS, the aliases, any Claude model the budget / policy / executor
//               entry names); codex-*: its model + the entry's. fake / a typed executor: not checked (the entry's provider decides)
//   --effort    claude / codex-*: floor.mjs EFFORT_ORDER; fake / typed: not checked
//   --stage     a stage name (STAGE_RE): stages are the lane plan's own names (A1, S3, MERGE ...), so only the shape is checked
//   --lane      an existing lane record, or a new name matching the lane naming rule (lanenew.mjs LANE_RE)
//   --round / --budget-min   whole numbers
//   --brief     an existing file ('-' = no brief file)
//   --worktree / --notes   for a CHECK-IN caller with a project: inside the project's roots (launchRoots); the owner may point anywhere
// --after / --inputs are parsed by after.mjs (a parse error is a usage error) and their records checked by queueRun (checkRefs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BUILTIN, isTyped } from './executors.mjs';
import { FLOOR_MODELS, EFFORT_ORDER, claudeRank } from './floor.mjs';
import { LANE_RE } from './lanenew.mjs';
import { loadState } from './records.mjs';
import { expandLate } from './config.mjs';

export const STAGE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
export const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'];
// the budget keys that name a Claude model (Settings: policy.mjs)
const BUDGET_MODEL_KEYS = ['claude_model', 'checkin_model', 'checkin_minor_model', 'chat_model', 'worker_min_model'];
const uniq = a => [...new Set(a.filter(x => typeof x === 'string' && x))];
const words = a => a.join(', ') || 'none';

/** the executors `norn run` takes for this project: the built-ins (fake = the test executor) + its enabled typed executors */
export function knownExecutors(project, { fake = true } = {}) {
  const ex = project?.executors || {};
  return [...Object.keys(BUILTIN).filter(n => (fake || n !== 'fake') && ex[n]?.enabled !== false),
    ...Object.entries(ex).filter(([n, x]) => isTyped(x) && !BUILTIN[n] && x.enabled !== false).map(([n]) => n)];
}
const isCodex = executor => BUILTIN[executor]?.kind === 'codex';
/** the models of executor `executor` -> [ids], or null = not checked (fake, a typed executor) */
export function knownModels(executor, { project, budget = {} } = {}) {
  const xc = project?.executors?.[executor] || {};
  if (executor === 'claude') {
    const pol = project?.policy || {};
    const named = [...BUDGET_MODEL_KEYS.map(k => budget[k]), xc.model, pol.checkin?.merge_model, ...Object.values(pol.executors || {}).map(e => e?.model)];
    return uniq([...FLOOR_MODELS, ...named.filter(m => claudeRank(m) && !CLAUDE_ALIASES.includes(m)), ...CLAUDE_ALIASES]);
  }
  if (isCodex(executor)) return uniq([BUILTIN[executor].model, xc.model]);
  return null;
}
/** the efforts of executor `executor` -> [names], or null = not checked */
export const knownEfforts = executor => (executor === 'claude' || isCodex(executor) ? EFFORT_ORDER : null);

/** the existing lane names of a state dir (sorted) */
export function laneNames(state) {
  try { return Object.values(loadState(state).items).filter(i => i.kind === 'lane').map(i => i.data.name).filter(Boolean).sort(); } catch { return []; }
}

// the folder part of a lane_defaults template: what comes before ${lane} (the whole path when it names none)
function templateRoot(tpl, root) {
  if (!tpl) return null;
  try { const s = expandLate(tpl, { lane: '\u0000' }), cut = s.indexOf('\u0000'); return path.resolve(root || '.', cut < 0 ? s : path.dirname(s.slice(0, cut) + 'x')); } catch { return null; }
}
/**
 * The folders a check-in's --worktree / --notes may name: the project root and state, its briefs dir, the lane_defaults worktree /
 * notes folders, every worktree and notes folder a lane or run record names, and every git worktree of the project repo.
 */
export function launchRoots(project, state) {
  const items = (() => { try { return Object.values(loadState(state).items); } catch { return []; } })();
  const recs = items.filter(i => i.kind === 'lane' || i.kind === 'run');
  const git = project?.root ? spawnSync('git', ['-C', project.root, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', windowsHide: true, timeout: 10000 }) : null;
  const wts = git?.status === 0 ? git.stdout.split(/\r?\n/).filter(l => l.startsWith('worktree ')).map(l => l.slice(9)) : [];
  return uniq([project?.root, state, project?.state, project?.briefs_dir, templateRoot(project?.lane_defaults?.worktree, project?.root), templateRoot(project?.lane_defaults?.notes, project?.root),
    ...recs.flatMap(i => [i.data.worktree, i.data.notes && path.dirname(String(i.data.notes))]), ...wts]).map(r => path.resolve(r));
}
const inside = (roots, f, { self = false } = {}) => {
  const key = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  return roots.some(r => { const rel = path.relative(key(r), key(path.resolve(f))); return (self && rel === '') || (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)); });
};

/**
 * null = every value exists; else the refusal text naming the valid choices. o: { executor, model?, effort? (the flags as given, not the
 * policy's), stage?, lane, round?, budgetMin?, brief?, worktree?, notes?, project (loaded) | null, budget, state, caller }
 */
export function launchArgsRefusal(o) {
  const { executor: ex, project, budget = {} } = o;
  const exs = knownExecutors(project);
  const x = project?.executors?.[ex], disabled = x?.enabled === false && (BUILTIN[ex] || isTyped(x));   // a disabled one: its own message (norn.mjs)
  if (!exs.includes(ex) && !disabled) return `unknown executor ${JSON.stringify(ex)} (known here: ${words(exs)})`;
  if (o.model) {   // blank = the policy's
    const ms = knownModels(ex, { project, budget });
    if (ms && !ms.includes(String(o.model).replace(/\[[^\]]*\]$/, ''))) return `--model ${o.model}: not a model of executor ${ex} (known: ${words(ms)}; or leave --model out for the policy's)`;
  }
  if (o.effort) {
    const es = knownEfforts(ex);
    if (es && !es.includes(o.effort)) return `--effort ${o.effort}: not an effort of executor ${ex} (known: ${words(es)}; or leave --effort out for the policy's)`;
  }
  if (o.stage !== undefined && !STAGE_RE.test(o.stage)) return `--stage ${JSON.stringify(o.stage)}: a stage name is letters, digits, _ . - (up to 40, starting with a letter or digit), e.g. A1, S3, MERGE`;
  if (!LANE_RE.test(o.lane || '')) {
    const ls = laneNames(o.state);
    return `--lane ${JSON.stringify(o.lane)}: not a lane name (lanes here: ${words(ls)}; a new lane name is letters, digits, _ . - starting with a letter or digit)`;
  }
  for (const [k, v] of [['round', o.round], ['budget-min', o.budgetMin]]) if (v !== undefined && !/^\d+$/.test(String(v))) return `--${k} ${v}: a whole number`;
  if (o.brief && o.brief !== '-' && !fs.existsSync(o.brief)) return `--brief ${o.brief.replace(/\\/g, '/')}: no such file (write the brief first)`;
  if (o.caller === 'checkin' && project) {
    const roots = launchRoots(project, o.state), show = () => roots.map(r => r.replace(/\\/g, '/')).join(', ');
    if (o.worktree && !inside(roots, o.worktree, { self: true })) return `--worktree ${String(o.worktree).replace(/\\/g, '/')}: outside the project's folders (${show()}); leave it out for the lane's own worktree`;
    if (o.notes && !inside(roots, o.notes)) return `--notes ${String(o.notes).replace(/\\/g, '/')}: outside the project's folders (${show()}); leave it out for the lane's own notes`;
  }
  return null;
}
