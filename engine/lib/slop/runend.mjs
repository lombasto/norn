// META-SLOP-A (REVIEW-FABLE 3.1-3.2): the run-end backstop. Every lane run end that leaves commits is checked on its branch's diff
// against main (the merge base; RM-44 D1: stopped, Done-red and hand-off too); a DONE's open BLOCK findings go back to the SAME lane
// as one resume with the list (the supervisor). The merge doors (door.mjs) check the head they merge.
import { gitRun, slopCheck, effectiveRules, fingerprint, rulesHash } from './check.mjs';
import { loadState, loadShared } from '../records.mjs';
import { makeTool } from './tools.mjs';
import { findingLine, explainLines, hostWrite, slopChecks, unwaived, voiceReadsToday } from './host.mjs';
import { voiceGate } from './voice.mjs';
import { codeRisk } from '../coderisk.mjs';

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
// K22 cites DEC / DIR / Q (the records) and RM (the roadmap items, a shared kind: every home's). Folded here, not through roadmap.mjs:
// that module reaches the merge queue, which reaches this one (a K10 cycle).
function recordResolver(state) {
  const items = { ...loadState(state).items, ...loadShared(state, 'item').items };
  return id => items[id]?.state ?? null;
}

/** check a checkout's committed branch: { branch, base, result } | null (no lane branch to check). state + projectDir: projectSlop;
 * brief: the run's brief text; machine false: skip the machine rules (slopCheck) */
export function checkBranch({ repo, state = null, base = null, head = 'HEAD', rules, tool = makeTool(), projectDir = null, brief = null, machine = true } = {}) {
  const bb = base ? { branch: branchBase(repo)?.branch ?? null, base } : branchBase(repo);
  if (!bb) return null;
  const ps = projectSlop({ state, projectDir });
  return { branch: bb.branch, base: bb.base, result: slopCheck({ repo, base: bb.base, head, tool, resolve: ps.resolve, rules: rules || ps.rules, brief, machine, state }) };
}

/** SloppaChoppa 2 S2: a run's branch check, once per (branch, head, rule set) - `norn done` runs it in the worker's session, the run end
 * reads the check stored at that head instead of running it again. -> null (no lane branch, or no commits past main) |
 * { branch, check (the stored line), open (its BLOCKs no waiver covers), result (slopCheck's; null = read from the store), risk (the
 * one-line risk rank, coderisk.mjs), gate (voiceGate's answer; null = no voice) }. The voice reads only when the gate says read: a
 * skipped diff's model rules are the WARN "could not run: skipped by the risk rank: ..." with the gate's words. Throws as checkBranch. */
export function endCheck({ repo, state, projectDir = null, voice = null, brief = null, lane = null, run = null, now = Date.now() }) {
  const bb = branchBase(repo), head = bb && gitRun(repo, ['rev-parse', 'HEAD']).trim();
  if (!bb || bb.base === head) return null;
  const rules = projectSlop({ projectDir }).rules, hash = rulesHash(rules), had = slopChecks(state).findLast(c => c.branch === bb.branch && c.head === head && c.hash === hash);
  if (had) return { branch: bb.branch, check: had, open: unwaived(state, had.findings.filter(f => f.new && f.level === 'BLOCK' && !f.shadow)), result: null, risk: had.risk ?? null, gate: null };
  let rk;
  try { rk = codeRisk({ dir: repo, state, base: bb.base, head }); } catch (e) { const w = String(e.stderr || e.message).trim().split('\n')[0]; rk = { pct: null, na: w, line: `risk rank n/a: ${w}` }; }
  const risk = rk.line;
  const used = voice ? voiceReadsToday(state, now) : 0, gate = voice ? voiceGate({ risk: rk, cap: voice.cap, used, checks: slopChecks(state), now }) : null;
  const t = makeTool({ voice, used }), tool = gate && !gate.read ? Object.assign((rule, ...a) => { if (rule.kind === 'model') throw new Error(gate.why); return t(rule, ...a); }, { reads: 0 }) : t;   // the voice's daily cap: today's reads so far
  const c = checkBranch({ repo, state, base: bb.base, rules, projectDir, tool, brief });
  return { branch: c.branch, ...hostWrite(state, { type: 'check', branch: c.branch, lane, run, base: c.base, head: c.result.head, hash: c.result.hash, blocks: c.result.blocks, findings: c.result.findings, voice_reads: tool.reads, risk }), result: c.result, risk, gate };
}

/** SPEC 1.3 F7: the hold of a run-end check that threw - one BLOCK "could not check" on the branch, stored under a hash no rule set has
 * (no door reads it as a check: the door runs its own) -> a hostWrite check payload | null (no lane branch, or no commits past main) */
export function couldNotCheck(repo, why) {
  const bb = branchBase(repo), head = bb && gitRun(repo, ['rev-parse', 'HEAD']).trim();
  if (!bb || bb.base === head) return null;
  const f = { rule: 'check', level: 'BLOCK', file: '*', line: 0, msg: `could not check: ${why}`, snippet: 'could-not-check', fp: fingerprint('check', '*', 'could-not-check'), new: true };
  return { type: 'check', branch: bb.branch, base: bb.base, head, hash: 'could-not-check', blocks: [f], findings: [f] };
}

// the resume prompt names at most SLOP_GROUPS (rule, file) groups and SLOP_FIRST lines of each: a BLOCK list of thousands of hits
// (one fixture's trailing whitespace) once made a prompt too long to start the resume (solve-shack RUN-140)
export const SLOP_GROUPS = 20, SLOP_FIRST = 3;
/** the full BLOCK list, one finding a line (the file the resume prompt names) */
export const slopList = open => open.map(f => '- ' + findingLine(f)).join('\n') + '\n';
/** the resume prompt: per rule and file a count and the first lines, the rule's what / why / fix under its first shown finding (RM-27),
 *  the full list in listFile, and what to do with it */
export function slopPrompt(open, brief, { listFile = null, projectDir = null } = {}) {
  const groups = new Map(), told = new Set();
  for (const f of open) { const k = `${f.rule} \`${f.file}\``; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }   // the path in backticks, as findingLine
  const shown = [...groups].slice(0, SLOP_GROUPS), rest = groups.size - shown.length;
  const lines = f => ['  - ' + findingLine(f), ...(told.has(f.rule) ? [] : (told.add(f.rule), explainLines(f, { pad: '    ', projectDir })))];
  return [`Norn's slop check found ${open.length} BLOCK finding(s) your branch adds, in ${groups.size} rule / file group(s):`,
    ...shown.flatMap(([k, fs_]) => [`- ${k}: ${fs_.length}`, ...fs_.slice(0, SLOP_FIRST).flatMap(lines), ...(fs_.length > SLOP_FIRST ? [`  - ... ${fs_.length - SLOP_FIRST} more`] : [])]),
    ...(rest > 0 ? [`- ... ${rest} more group(s)`] : []),
    ...(listFile ? [`The full list: ${listFile}`] : []),
    'Fix each one in this worktree and commit; run `norn slop check` until it lists none; then end with `norn done` as before.',
    'A finding that must stay needs a waiver from the owner or the controller: say so and end with `norn done --outcome stopped --why "slop waiver needed"`.',
    ...(brief ? [`Your brief: ${brief}`] : [])].join('\n');
}
