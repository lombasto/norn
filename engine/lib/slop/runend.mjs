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

// the resume prompt names at most SLOP_GROUPS (rule, file) groups and SLOP_FIRST lines of each: a BLOCK list of thousands of hits
// (one fixture's trailing whitespace) once made a prompt too long to start the resume (solve-shack RUN-140)
export const SLOP_GROUPS = 20, SLOP_FIRST = 3;
/** the full BLOCK list, one finding a line (the file the resume prompt names) */
export const slopList = open => open.map(f => '- ' + findingLine(f)).join('\n') + '\n';
/** the resume prompt: per rule and file a count and the first lines, the full list in listFile, and what to do with it */
export function slopPrompt(open, brief, listFile) {
  const groups = new Map();
  for (const f of open) { const k = `${f.rule} ${f.file}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
  const shown = [...groups].slice(0, SLOP_GROUPS), rest = groups.size - shown.length;
  return [`Norn's slop check found ${open.length} BLOCK finding(s) your branch adds, in ${groups.size} rule / file group(s):`,
    ...shown.flatMap(([k, fs_]) => [`- ${k}: ${fs_.length}`, ...fs_.slice(0, SLOP_FIRST).map(f => '  - ' + findingLine(f)), ...(fs_.length > SLOP_FIRST ? [`  - ... ${fs_.length - SLOP_FIRST} more`] : [])]),
    ...(rest > 0 ? [`- ... ${rest} more group(s)`] : []),
    ...(listFile ? [`The full list: ${listFile}`] : []),
    'Fix each one in this worktree and commit; run `norn slop check` until it lists none; then end with `norn done` as before.',
    'A finding that must stay needs a waiver from the owner or the controller: say so and end with `norn done --outcome stopped --why "slop waiver needed"`.',
    ...(brief ? [`Your brief: ${brief}`] : [])].join('\n');
}
