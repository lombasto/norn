// META-SLOP-A (REVIEW-FABLE 3.1-3.2): the run-end backstop. A lane run that ends DONE is checked on its branch's diff against
// main (the merge base); open BLOCK findings go back to the SAME lane as one resume with the list (the supervisor), and the
// branch's merge waits (merge-brief, the merge queue) until the list is empty or each finding is waived.
import { gitRun, slopCheck } from './check.mjs';
import { makeTool } from './tools.mjs';
import { baselineOf, findingLine } from './host.mjs';

/** the branch and merge base of a checkout against main (the remote's main first: it is the fresher), or null (no branch / no main) */
export function branchBase(repo, { main = 'main', remote = 'origin' } = {}) {
  let branch;
  try { branch = gitRun(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim(); } catch { return null; }   // detached or not a repo: no lane branch
  if (branch === main) return null;
  for (const ref of [`refs/remotes/${remote}/${main}`, `refs/heads/${main}`]) {
    const got = gitRun(repo, ['rev-parse', '--verify', '--quiet', ref], { ok: [0, 1] }).trim();
    if (got) return { branch, base: gitRun(repo, ['merge-base', 'HEAD', got]).trim() };
  }
  return null;
}

/** check a checkout's committed branch: { branch, base, result } | null (no lane branch to check) */
export function checkBranch({ repo, state = null, base = null, head = 'HEAD', rules, tool } = {}) {
  const bb = base ? { branch: branchBase(repo)?.branch ?? null, base } : branchBase(repo);
  if (!bb) return null;
  const t = tool || makeTool({ baseline: state ? { K14: baselineOf(state, 'K14') } : {} });
  return { branch: bb.branch, base: bb.base, result: slopCheck({ repo, base: bb.base, head, tool: t, ...(rules ? { rules } : {}) }) };
}

/** the resume prompt: the list and what to do with it */
export function slopPrompt(open, brief) {
  return [`Norn's slop check found ${open.length} BLOCK finding(s) your branch adds:`, ...open.map(f => '- ' + findingLine(f)),
    'Fix each one in this worktree and commit; run `norn slop check` until it lists none; then end with `norn done` as before.',
    'A finding that must stay needs a waiver from the owner or the controller: say so and end with `norn done --outcome stopped --why "slop waiver needed"`.',
    ...(brief ? [`Your brief: ${brief}`] : [])].join('\n');
}
