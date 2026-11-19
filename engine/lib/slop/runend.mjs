// META-SLOP-A (REVIEW-FABLE 3.1-3.2): the run-end backstop. Every lane run end that leaves commits is checked on its branch's diff
// against main (the merge base; RM-44 D1: stopped, Done-red and hand-off too); a DONE's open BLOCK findings go back to the SAME lane
// as one resume with the list (the supervisor). The merge doors (door.mjs) check the head they merge.
import { gitRun, slopCheck, effectiveRules } from './check.mjs';
import { loadState, readEvents, recordsFile } from '../records.mjs';
import { makeTool } from './tools.mjs';
import { findingLine } from './host.mjs';

/** main's sha: the remote's main first (it is the fresher), else the local branch, else null */
export function mainTip(repo, { main = 'main', remote = 'origin' } = {}) {
  for (const ref of [`refs/remotes/${remote}/${main}`, `refs/heads/${main}`]) {
    const got = gitRun(repo, ['rev-parse', '--verify', '--quiet', ref], { ok: [0, 1] }).trim();
    if (got) return got;
  }
  return null;
}
/** the merge base of a commit with main (mainTip), or null (no main, or no common history) */
export function mainBase(repo, head = 'HEAD', o = {}) {
  const tip = mainTip(repo, o);
  return tip ? gitRun(repo, ['merge-base', head, tip], { ok: [0, 1] }).trim() || null : null;
}
/** the branch and merge base of a checkout against main, or null (no branch / no main) */
export function branchBase(repo, o = {}) {
  let branch;
  try { branch = gitRun(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(); } catch { return null; }   // detached or not a repo: no lane branch
  if (branch === (o.main || 'main')) return null;
  const base = mainBase(repo, 'HEAD', o);
  return base ? { branch, base } : null;
}

/**
 * The project's side of every check (RM-45 + RM-44): its effective rule set (built-ins + <project folder>/rules/slop/ P-*.json +
 * overrides.json) and K22's record resolver (state: the cited ids resolve there). The run end, the doors and the queue all take it
 * from here, so the rule-set hash a stored check carries is the one the door looks for.
 */
export function projectSlop({ state = null, projectDir = null } = {}) {
  return { rules: effectiveRules({ projectDir }), resolve: state ? recordResolver(state) : null };
}
// K22 cites DEC / DIR / Q (the records) and RM (the roadmap's item events: open until dropped, reopen opens it again). Read here from the
// item events, not through roadmap.mjs: that module reaches the merge queue, which reaches this one (a K10 cycle).
function recordResolver(state) {
  const items = loadState(state).items, rm = {};
  for (const e of readEvents(recordsFile(state, 'item'))) if (e.kind === 'item') rm[e.id] = e.ev === 'drop' ? 'dropped' : e.ev === 'create' || e.ev === 'reopen' ? 'open' : rm[e.id];
  return id => (id.startsWith('RM-') ? rm[id] : items[id]?.state) ?? null;
}

/** check a checkout's committed branch: { branch, base, result } | null (no lane branch to check). state + projectDir: projectSlop;
 * machine false: skip the machine rules (slopCheck) */
export function checkBranch({ repo, state = null, base = null, head = 'HEAD', rules, tool = makeTool(), projectDir = null, machine = true } = {}) {
  const bb = base ? { branch: branchBase(repo)?.branch ?? null, base } : branchBase(repo);
  if (!bb) return null;
  const ps = projectSlop({ state, projectDir });
  return { branch: bb.branch, base: bb.base, result: slopCheck({ repo, base: bb.base, head, tool, resolve: ps.resolve, rules: rules || ps.rules, machine }) };
}

/** the resume prompt: the list and what to do with it */
export function slopPrompt(open, brief) {
  return [`Norn's slop check found ${open.length} BLOCK finding(s) your branch adds:`, ...open.map(f => '- ' + findingLine(f)),
    'Fix each one in this worktree and commit; run `norn slop check` until it lists none; then end with `norn done` as before.',
    'A finding that must stay needs a waiver from the owner or the controller: say so and end with `norn done --outcome stopped --why "slop waiver needed"`.',
    ...(brief ? [`Your brief: ${brief}`] : [])].join('\n');
}
