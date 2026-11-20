// META-DOD 1 (owner DIR-68: "physical hooks force a DoR and DoD"). Definition of Ready: a brief carries three plain lines - Scope:
// (the paths / globs the run may change), Tests: (the test files or a `command` that prove it), Done: (the marker) - checked by
// `norn run` per project policy.dod.ready (off | warn | refuse). Definition of Done: at the run end Norn itself checks the branch -
// no uncommitted / untracked files, every changed path inside Scope (+ the NOTES file and its shots), the brief's Tests and the
// project's fast gate (merge.gate) run by Norn with exit code, counts and log path. The run's DONE counts only on Norn's own green
// record (the supervisor); a fail resumes the worker once with this evidence (as the slop check does), a second fail is STOPPED.
import fs from 'node:fs';
import path from 'node:path';
import { gitRun } from './slop/check.mjs';
import { branchBase } from './slop/runend.mjs';
import { runGate } from './mergeq.mjs';
import { parseReady, inScope, clean } from './ready.mjs';

// The paths CI's ci.yml ignores (its push paths-ignore; tests/dod.test.mjs pins the lists equal): a change only here is docs.
export const DOCS_ONLY = ['**/*.md', 'docs/**', '**/docs/**', '**/*.png', '**/*.html'];

export const READY_MODES = ['off', 'warn', 'refuse'];
const fwd = p => String(p).replace(/\\/g, '/');

const modeOf = policy => { const m = policy?.dod?.ready ?? 'off'; return READY_MODES.includes(m) ? m : 'off'; };
/**
 * The Ready gate of `norn run`: { refused: reason | null, warning: text | null, dod: the spec's dod part | null }. A MERGE stage
 * brief is Norn's own (merge-brief) and exempt. dod = { mode, ok, missing, ready, gate, test_cmd, timeout_min } (null when off).
 */
export function readyGate({ brief, policy, stage, gate = null }) {
  const mode = modeOf(policy);
  if (mode === 'off' || String(stage ?? '').toUpperCase() === 'MERGE') return { refused: null, warning: null, dod: null };
  let text = null;
  try { text = brief && brief !== '-' ? fs.readFileSync(brief, 'utf8') : null; } catch { /* unreadable: text stays null, the gate names it not readable */ }
  const ready = parseReady(text), ok = text !== null && !ready.missing.length;
  const why = text === null ? `brief ${fwd(brief ?? '-')} is not readable` : `brief ${fwd(brief)} lacks ${ready.missing.join(', ')}`;
  const msg = `${why} (policy.dod.ready = ${mode}): add the lines Scope: / Tests: / Done: (the paths the run may change, the tests that prove it, what done means)`;
  const dod = { mode, ok, missing: ready.missing, ...(ok ? { ready } : {}), ...(gate?.cmd ? { gate: { cmd: gate.cmd, timeout_min: gate.timeout_min, ...(gate.dir ? { dir: gate.dir } : {}) } } : {}),
    ...(policy?.dod?.test_cmd ? { test_cmd: policy.dod.test_cmd } : {}), timeout_min: policy?.dod?.timeout_min ?? 20, ...(ok ? {} : { why: msg }) };
  if (ok) return { refused: null, warning: null, dod };
  return mode === 'refuse' ? { refused: msg, warning: null, dod } : { refused: null, warning: msg, dod };
}

/** pass / fail counts of a test log (node test spec / TAP summary lines, a pytest summary), or null when it has none */
export function testCounts(text) {
  const s = String(text ?? ''), c = { pass: 0, fail: 0 };
  let seen = false;
  for (const m of s.matchAll(/^\s*(?:#|ℹ)\s*(pass|fail)\s+(\d+)\s*$/gm)) { c[m[1]] += Number(m[2]); seen = true; }
  if (seen) return c;
  const py = [...s.matchAll(/=+ (.*\b(?:passed|failed)\b.*) in [\d.]+s/g)].at(-1)?.[1];
  if (!py) return null;
  return { pass: Number(py.match(/(\d+) passed/)?.[1] ?? 0), fail: Number(py.match(/(\d+) failed/)?.[1] ?? 0) };
}

/** the commands of a Tests: line - every `backticked` command, else its test files that exist in the worktree through test_cmd */
function testCmds(tests, worktree, testCmd) {
  const ticks = [...String(tests ?? '').matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).filter(Boolean);
  if (ticks.length) return { cmds: ticks };
  const files = [...new Set(String(tests ?? '').split(/[\s,+]+/).map(clean).filter(w => /[\\/.]/.test(w) && fs.statSync(path.join(worktree, w), { throwIfNoEntry: false })?.isFile()))];
  if (!files.length) return { problem: 'Tests: nothing runnable (name test files or a `command`)' };
  if (!testCmd) return { problem: `Tests: no policy.dod.test_cmd to run ${files.join(' ')}` };
  return { cmds: [testCmd.includes('{files}') ? testCmd.replace('{files}', files.join(' ')) : `${testCmd} ${files.join(' ')}`] };
}

/**
 * Norn's Done check on the worktree's branch. dod = the spec's dod part ({ ready, gate, test_cmd, timeout_min, notes }); logDir
 * gets one log per command (<run>-dod-<name>.log). -> { ok, why, at, branch, base, head, dirty: [path], changed: [path],
 * out_of_scope: [path], tests: [{ name, cmd, code, ok, ms, counts, log, timed_out }], problems: [text] }
 */
export async function doneCheck({ worktree, dod, logDir, run }) {
  const ready = dod.ready, out = { ok: false, why: null, at: new Date().toISOString(), dirty: [], changed: [], out_of_scope: [], tests: [], problems: [] };
  const st = gitRun(worktree, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  out.dirty = st.filter(l => /^.. /.test(l)).map(l => l.slice(3));
  const bb = branchBase(worktree);
  out.head = gitRun(worktree, ['rev-parse', 'HEAD']).trim();
  if (bb) {
    Object.assign(out, { branch: bb.branch, base: bb.base });
    out.changed = gitRun(worktree, ['diff', '--name-only', '--no-renames', '-z', bb.base, 'HEAD']).split('\0').filter(Boolean);
    // the NOTES file and the shots beside it (images in its folder) belong to the run whatever Scope says
    const nd = dod.notes ? fwd(path.relative(worktree, path.dirname(path.resolve(dod.notes)))) : null, nf = dod.notes ? fwd(path.relative(worktree, path.resolve(dod.notes))) : null;
    const own = p => p === nf || (nd !== null && !nd.startsWith('..') && path.posix.dirname(p) === (nd || '.') && /\.(png|jpe?g|webp|gif)$/i.test(p));
    out.out_of_scope = out.changed.filter(p => !inScope(p, ready.scope) && !own(p));
  } else out.problems.push('no lane branch to diff against main');
  const t = testCmds(ready.tests, worktree, dod.test_cmd);
  if (t.problem) out.problems.push(t.problem);
  // a docs-only branch runs no gate: CI ignores such a push and its MERGE runs no suite (RUN-1063 / RUN-1072 timed out on README + pictures)
  const docs = bb && out.changed.length > 0 && out.changed.every(p => inScope(p, DOCS_ONLY));
  if (docs && dod.gate?.cmd) out.gate_skipped = `docs-only branch (every changed path in the CI paths-ignore: ${DOCS_ONLY.join(' ')})`;
  const jobs = [...(t.cmds || []).map((cmd, i) => ({ name: t.cmds.length > 1 ? `tests-${i + 1}` : 'tests', cmd, timeout_min: dod.timeout_min ?? 20 })),
    ...(dod.gate?.cmd && !docs ? [{ name: 'gate', cmd: dod.gate.cmd, dir: dod.gate.dir, timeout_min: dod.gate.timeout_min ?? dod.timeout_min ?? 20 }] : [])];
  for (const j of jobs) {
    const log = path.join(logDir, `${run}-dod-${j.name}.log`), r = await runGate({ cmd: j.cmd, timeout_min: j.timeout_min, ...(j.dir ? { dir: j.dir } : {}) }, { cwd: worktree, log });
    let text = '';
    try { text = fs.readFileSync(log, 'utf8'); } catch { /* no log */ }
    out.tests.push({ name: j.name, cmd: j.cmd, code: r.code, ok: r.ok, ms: r.ms, counts: testCounts(text), log: fwd(log), ...(r.timedOut ? { timed_out: true } : {}) });
  }
  const why = [out.dirty.length ? `${out.dirty.length} uncommitted / untracked file(s)` : null, out.out_of_scope.length ? `${out.out_of_scope.length} changed path(s) outside Scope` : null,
    ...out.tests.filter(x => !x.ok).map(x => `${x.name} exit ${x.code}${x.timed_out ? ' (timed out)' : ''}`), ...out.problems].filter(Boolean);
  out.ok = !why.length;
  out.why = why.length ? why.join('; ') : null;
  return out;
}

/** one line of a Done check's evidence (Agents, the feed, the resume prompt) */
export const testLine = x => `${x.name} exit ${x.code}${x.counts ? `, ${x.counts.pass} pass ${x.counts.fail} fail` : ''}`;

/** the resume prompt of a failed Done check: the evidence and what to do with it */
export function dodPrompt(d, brief) {
  return [`Norn's Done check failed on your branch (${d.why}). Your DONE does not count until Norn's own check is green:`,
    ...d.dirty.map(p => `- uncommitted / untracked: ${p}`), ...d.out_of_scope.map(p => `- changed outside the brief's Scope: ${p}`),
    ...d.tests.map(x => `- ${x.ok ? 'green' : 'RED'}: \`${x.cmd}\` ${testLine(x)} (log ${x.log})`), ...d.problems.map(p => `- ${p}`),
    'Fix each one in this worktree (commit your work; revert what the brief\'s Scope does not allow; make the tests green - never loosen one), then end with `norn done` as before.',
    'If the Scope or the Tests line itself is wrong, say so and end with `norn done --outcome stopped --why "Done check: <why>"`.',
    ...(brief ? [`Your brief: ${brief}`] : [])].join('\n');
}
