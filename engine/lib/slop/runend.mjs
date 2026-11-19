// META-SLOP-A (REVIEW-FABLE 3.1-3.2): the run-end backstop. Every lane run end that leaves commits is checked on its branch's diff
// against main (the merge base; RM-44 D1: stopped, Done-red and hand-off too); a DONE's open BLOCK findings go back to the SAME lane
// as one resume with the list (the supervisor). The merge doors (door.mjs) check the head they merge.
import { gitRun, slopCheck } from './check.mjs';
import { makeTool } from './tools.mjs';
import { findingLine } from './host.mjs';

/** the merge base of a commit with main (the remote's main first: it is the fresher), or null (no main, or no common history) */
export function mainBase(repo, head = 'HEAD', { main = 'main', remote = 'origin' } = {}) {
  for (const ref of [`refs/remotes/${remote}/${main}`, `refs/heads/${main}`]) {
    const got = gitRun(repo, ['rev-parse', '--verify', '--quiet', ref], { ok: [0, 1] }).trim();
    if (got) return gitRun(repo, ['merge-base', head, got], { ok: [0, 1] }).trim() || null;
  }
  return null;
}
/** the branch and merge base of a checkout against main, or null (no branch / no main) */
export function branchBase(repo, o = {}) {
  let branch;
  try { branch = gitRun(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(); } catch { return null; }   // detached or not a repo: no lane branch
  if (branch === (o.main || 'main')) return null;
  const base = mainBase(repo, 'HEAD', o);
  return base ? { branch, base } : null;
}

/** check a checkout's committed branch: { branch, base, result } | null (no lane branch to check) */
export function checkBranch({ repo, base = null, head = 'HEAD', rules, tool = makeTool() } = {}) {
  const bb = base ? { branch: branchBase(repo)?.branch ?? null, base } : branchBase(repo);
  if (!bb) return null;
  return { branch: bb.branch, base: bb.base, result: slopCheck({ repo, base: bb.base, head, tool, ...(rules ? { rules } : {}) }) };
}

/** the resume prompt: the list and what to do with it */
export function slopPrompt(open, brief) {
  return [`Norn's slop check found ${open.length} BLOCK finding(s) your branch adds:`, ...open.map(f => '- ' + findingLine(f)),
    'Fix each one in this worktree and commit; run `norn slop check` until it lists none; then end with `norn done` as before.',
    'A finding that must stay needs a waiver from the owner or the controller: say so and end with `norn done --outcome stopped --why "slop waiver needed"`.',
    ...(brief ? [`Your brief: ${brief}`] : [])].join('\n');
}
