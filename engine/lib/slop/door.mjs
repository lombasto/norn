// RM-44 stage A (audit D1): the merge doors fail closed. merge-brief, the merge queue (each pick and the batch result) and merge-land
// pass a head only on a stored check of (branch, head, rule-set hash) - checks.jsonl, written by hostWrite - and run the check
// (3-10 s) when none fits. A branch with no hold entry is no pass: the hold view is for people, the stored check is the gate.
import { gitRun, slopCheck, rulesHash } from './check.mjs';
import { makeTool } from './tools.mjs';
import { hostWrite, slopChecks, unwaived, findingLine } from './host.mjs';
import { mainBase, projectSlop } from './runend.mjs';

/** the last stored check of this branch at this head with this rule set, or null */
export const storedCheck = (state, { branch, head, hash }) => slopChecks(state).findLast(c => c.branch === branch && c.head === head && c.hash === hash) || null;

/**
 * doorCheck({ state, repo, branch, head, base?, projectDir, rules?, tool, main, remote }) -> { check (the stored line), open (its BLOCKs no waiver
 * covers), ran (the check ran now) }. base: the merge base the diff starts at (default: head's merge base with main). Throws when
 * the head or main cannot be read: a door that cannot check does not pass.
 */
export function doorCheck({ state, repo, branch, head, base = null, projectDir = null, rules = null, tool = makeTool(), main = 'main', remote = 'origin', lane = null, run = null }) {
  const ps = projectSlop({ state, projectDir }), set = rules || ps.rules;   // the project's effective rules: the hash the run end stored
  const H = gitRun(repo, ['rev-parse', '--verify', `${head}^{commit}`]).trim(), hash = rulesHash(set);
  let check = storedCheck(state, { branch, head: H, hash }), ran = false;
  if (!check) {
    const B = base || mainBase(repo, H, { main, remote });
    if (!B) throw new Error(`slop: no ${main} with a common history to diff ${branch} ${H.slice(0, 7)} against`);
    const r = slopCheck({ repo, base: B, head: H, rules: set, tool, resolve: ps.resolve, state });
    check = hostWrite(state, { type: 'check', branch, lane, run, base: r.base, head: r.head, hash: r.hash, blocks: r.blocks, findings: r.findings }).check;
    ran = true;
  }
  return { check, open: unwaived(state, check.findings.filter(f => f.new && f.level === 'BLOCK' && !f.shadow)), ran };
}

/** the PR body's words on a passed door (RM-44 B): the WARN findings of the stored check at that head, one line each */
export function doorWarns(d) {
  const w = d.check.findings.filter(f => f.new !== false && f.level === 'WARN' && !f.shadow), at = d.check.head.slice(0, 7);
  return w.length ? [`SloppaChoppa at ${at}: ${w.length} WARN finding(s) (they do not hold the merge):`, ...w.map(f => '- ' + findingLine(f))].join('\n') : `SloppaChoppa at ${at}: no WARN finding.`;
}

/** the refusal words of a door: null (pass) or "N open slop BLOCK finding(s) at <sha7>: <first lines>" */
export function doorWhy(d) {
  if (!d.open.length) return null;
  return `${d.open.length} open slop BLOCK finding(s) at ${d.check.head.slice(0, 7)} - fix them (norn slop check in its worktree) or waive each (norn rec add waiver): ${d.open.map(findingLine).join('; ')}`;
}
