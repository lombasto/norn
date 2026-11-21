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
import { suiteMode } from './mergebrief.mjs';
import { classify } from './testcmd.mjs';
import { testsPolicy, policyWords, pickInRepo, BROWSER_SKIP_ENV } from './testpolicy.mjs';
import { repoIndex, runCached, cacheDir } from './testcache.mjs';

// The paths CI's ci.yml ignores (its push paths-ignore; tests/dod.test.mjs pins the lists equal): a change only here is docs.
export const DOCS_ONLY = ['**/*.md', 'docs/**', '**/docs/**', '**/*.png', '**/*.html'];

export const READY_MODES = ['off', 'warn', 'refuse'];
const fwd = p => String(p).replace(/\\/g, '/');

const modeOf = policy => { const m = policy?.dod?.ready ?? 'off'; return READY_MODES.includes(m) ? m : 'off'; };
/**
 * The Ready gate of `norn run`: { refused: reason | null, warning: text | null, dod: the spec's dod part | null }. A MERGE stage
 * brief is Norn's own (merge-brief) and exempt. dod = { mode, ok, missing, ready, gate, test_cmd, timeout_min, tests } (null when off);
 * gate.suite = the project's suiteMode (policy.merge.suite: changed | skip), which the Done check's gate follows; tests = the project's
 * policy.tests at dispatch (testpolicy.mjs testsPolicy), which picks what the Done check runs.
 */
export function readyGate({ brief, policy, stage, gate = null }) {
  const mode = modeOf(policy);
  if (mode === 'off' || String(stage ?? '').toUpperCase() === 'MERGE') return { refused: null, warning: null, dod: null };
  let text = null;
  try { text = brief && brief !== '-' ? fs.readFileSync(brief, 'utf8') : null; } catch { /* unreadable: text stays null, the gate names it not readable */ }
  const ready = parseReady(text), ok = text !== null && !ready.missing.length;
  const why = text === null ? `brief ${fwd(brief ?? '-')} is not readable` : `brief ${fwd(brief)} lacks ${ready.missing.join(', ')}`;
  const msg = `${why} (policy.dod.ready = ${mode}): add the lines Scope: / Tests: / Done: (the paths the run may change, the tests that prove it, what done means)`;
  const dod = { mode, ok, missing: ready.missing, ...(ok ? { ready } : {}), ...(gate?.cmd ? { gate: { cmd: gate.cmd, timeout_min: gate.timeout_min, suite: suiteMode({ policy }), ...(gate.dir ? { dir: gate.dir } : {}) } } : {}),
    ...(policy?.dod?.test_cmd ? { test_cmd: policy.dod.test_cmd } : {}), timeout_min: policy?.dod?.timeout_min ?? 20, tests: testsPolicy(policy), ...(ok ? {} : { why: msg }) };
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

// test-diet S1: policy.tests.mode = light - the Done check runs the light set, never the brief's whole Tests line: the node test files
// the Tests line names (bare, or inside a node --test / norn tests run command) plus pickRun's light pick of the branch's changed files,
// through the machine's test cache (a file the worker already passed on the same content is reused, not rerun); a Tests command that
// is not a node test (pytest of a file, a `node -e` check) still runs as written. A node suite command (ci-suite --changed, norn tests
// run --changed) adds nothing: the pick replaces it.
const NODE_RUNNERS = new Set(['node', 'ci-suite', 'norn']), NODE_TEST = /\.test\.[cm]?js$/;
function lightJobs(tests, worktree, testCmd, changed, state) {
  const files = new Set(), cmds = [], ticks = [...String(tests ?? '').matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).filter(Boolean);
  const exists = w => fs.statSync(path.join(worktree, w), { throwIfNoEntry: false })?.isFile();
  if (ticks.length) for (const c of ticks) { const r = classify(c); if (NODE_RUNNERS.has(r.runner)) for (const p of r.paths || []) files.add(fwd(p)); else cmds.push(c); }
  else {
    const words = [...new Set(String(tests ?? '').split(/[\s,+]+/).map(clean).filter(w => /[\\/.]/.test(w) && exists(w)))].map(fwd), other = words.filter(w => !NODE_TEST.test(w));
    for (const w of words.filter(w => NODE_TEST.test(w))) files.add(w);
    if (other.length && testCmd) cmds.push(testCmd.includes('{files}') ? testCmd.replace('{files}', other.join(' ')) : `${testCmd} ${other.join(' ')}`);
  }
  const pick = pickInRepo(worktree, state, 'light', changed);
  for (const f of pick.run) files.add(f);
  return { files: [...files].filter(exists).sort(), cmds, uncovered: pick.none };
}

// NORN-DOD-GATE-FAST (test governance #73, DIR-23: never the full suite in a worker run): the Done check's gate follows the project's
// suiteMode, as mergeq and landing do. changed: a ci-suite gate runs on the change only (`--changed <the branch's merge base>`, ci-suite's
// pickTests; RUN-1491 timed out at file 209/227 of the full suite); skip: no gate; a gate that is not ci-suite runs as configured.
const CI_SUITE = /\bci-suite\.mjs\b/;
function gateJob(gate, base) {
  if (gate.suite === 'skip') return { skipped: 'policy merge.suite = skip: the Done check runs no gate (as the batch gate and the landing check)' };
  if (!CI_SUITE.test(gate.cmd)) return { cmd: gate.cmd, mode: 'as-configured' };
  if (/\s--changed\b/.test(gate.cmd)) return { cmd: gate.cmd, mode: 'changed' };
  if (!base) return { skipped: 'no merge base to run the changed-file tests from (never the full suite in a run)' };
  return { cmd: `${gate.cmd} --changed ${base}`, mode: 'changed' };
}
/** a ci-suite log -> { files: the test files it runs, done: the files finished } (null, null when the log has no suite lines) */
export function gateProgress(text) {
  const s = String(text ?? ''), m = s.match(/^ci-suite: (\d+) test file\(s\) to run/m), none = /^ci-suite: no test file to run/m.test(s);
  return m || none ? { files: m ? Number(m[1]) : 0, done: (s.match(/^ci-suite: done /gm) || []).length } : { files: null, done: null };
}

/**
 * Norn's Done check on the worktree's branch. dod = the spec's dod part ({ ready, gate, test_cmd, timeout_min, notes }); logDir
 * gets one log per command (<run>-dod-<name>.log). -> { ok, why, at, branch, base, head, dirty: [path], changed: [path],
 * out_of_scope: [path], tests: [{ name, cmd, code, ok, ms, counts, log, timed_out }], problems: [text] }. locksDir: the machine's
 * locks dir - the project gate waits there for the machine gate lock (fair-slots 5a); the brief's own tests take none.
 * test-diet S1: dod.tests (policy.tests) picks the tests. changed: the brief's Tests line and the gate, as written. light: the light
 * set (lightJobs) one file at a time through the test cache (cache: its dir; state: the project state dir, for the last measure's
 * times), no gate; once run_budget_min is spent no further file starts - the rest is named in tests_left, left to CI (unknown, not a
 * pass, not red). off: no tests at all. out.tests_policy names the policy, out.tests_uncovered the changed modules no test covers directly.
 */
export async function doneCheck({ worktree, dod, logDir, run, locksDir, state = null, cache = cacheDir() }) {
  const ready = dod.ready, tp = testsPolicy({ tests: dod.tests }), out = { ok: false, why: null, at: new Date().toISOString(), dirty: [], changed: [], out_of_scope: [], tests: [], problems: [], tests_policy: policyWords(tp) };
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
  // NORN-DOD-TESTS-NONE: a design run's `Tests: none - ...` is green only on a branch that changed nothing (no commit, no edit of a
  // tracked or untracked file); with any change it is red, so a writing run cannot dodge its tests by writing "none"
  const none = /^\s*none\b/i.test(String(ready.tests ?? '')), touched = none ? new Set([...out.changed, ...out.dirty]).size : 0;
  const light = !none && tp.mode === 'light' ? lightJobs(ready.tests, worktree, dod.test_cmd, out.changed, state) : null;
  const t = none || tp.mode === 'off' ? {} : light ? { cmds: light.cmds } : testCmds(ready.tests, worktree, dod.test_cmd);
  if (t.problem) out.problems.push(t.problem);
  if (none && touched) out.problems.push(`the branch changed ${touched} file${touched === 1 ? '' : 's'} but the brief declares no tests`);
  else if (none && bb) out.tests_none = 'none declared, nothing changed';
  if (!none && tp.mode === 'off') out.tests_off = 'policy.tests.mode = off: the Done check runs no tests and no gate - CI runs them on the pull request';
  if (light?.uncovered.length) out.tests_uncovered = light.uncovered;
  // a docs-only branch runs no gate: CI ignores such a push and its MERGE runs no suite (RUN-1063 / RUN-1072 timed out on README + pictures)
  const docs = bb && out.changed.length > 0 && out.changed.every(p => inScope(p, DOCS_ONLY));
  if (docs && dod.gate?.cmd) out.gate_skipped = `docs-only branch (every changed path in the CI paths-ignore: ${DOCS_ONLY.join(' ')})`;
  else if (tp.mode !== 'changed' && dod.gate?.cmd) out.gate_skipped = tp.mode === 'off' ? 'policy.tests.mode = off: no gate in a run' : 'policy.tests.mode = light: the light set replaces the gate; CI runs the rest';
  const g = docs || tp.mode !== 'changed' || !dod.gate?.cmd ? null : gateJob(dod.gate, bb?.base);
  if (g?.skipped) out.gate_skipped = g.skipped;
  // the budget clock starts with the first job (that one always runs); a job that would start past it is left to CI
  const budget = tp.run_budget_min > 0 ? tp.run_budget_min * 60000 : Infinity, left = [];
  let t0 = null;
  const spent = () => { if (!light) return false; t0 ??= Date.now(); return Date.now() - t0 >= budget; };
  if (light?.files.length) {
    const log = path.join(logDir, `${run}-dod-light.log`), skip = tp.browser === 'ci', ix = repoIndex(worktree);
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(log, `the Done check's light set (${policyWords(tp)}): ${light.files.join(' ')}\n`);
    for (const f of light.files) {
      if (spent()) { left.push(f); continue; }
      const r = await runCached(f, { ix, dir: cache, run, childEnv: skip ? BROWSER_SKIP_ENV : {}, extra: skip ? 'browser:skip' : '', capMs: (dod.timeout_min ?? 20) * 60000 });
      fs.appendFileSync(log, `${r.ok ? 'pass' : 'FAIL'} ${f} ${r.how}${r.how === 'ran' ? '' : ` (the pass of ${r.by ?? 'a hand run'} at ${r.at})`} ${Math.round(r.ms / 1000)} s\n${r.ok || !r.tail ? '' : r.tail.trimEnd() + '\n'}`);
      out.tests.push({ name: f, cmd: `norn tests run ${f}`, code: r.ok ? 0 : 1, ok: r.ok, ms: r.ms, counts: r.counts ?? null, log: fwd(log), cached: r.how,
        ...(r.how === 'ran' ? {} : { by: r.by, saved_ms: r.saved_ms }), ...(r.timed_out ? { timed_out: true, timeout_min: dod.timeout_min ?? 20 } : {}) });
    }
  }
  const jobs = [...(t.cmds || []).map((cmd, i) => ({ name: t.cmds.length > 1 ? `tests-${i + 1}` : 'tests', cmd, timeout_min: dod.timeout_min ?? 20, heavy: false })),
    ...(g?.cmd ? [{ name: 'gate', cmd: g.cmd, mode: g.mode, dir: dod.gate.dir, timeout_min: dod.gate.timeout_min ?? dod.timeout_min ?? 20, heavy: true }] : [])];
  for (const j of jobs) {
    if (spent()) { left.push(j.cmd); continue; }
    const log = path.join(logDir, `${run}-dod-${j.name}.log`), r = await runGate({ cmd: j.cmd, timeout_min: j.timeout_min, ...(j.dir ? { dir: j.dir } : {}) }, { cwd: worktree, log, heavy: j.heavy, ...(locksDir ? { locksDir } : {}) });
    let text = '';
    try { text = fs.readFileSync(log, 'utf8'); } catch { /* no log */ }
    out.tests.push({ name: j.name, cmd: j.cmd, code: r.code, ok: r.ok, ms: r.ms, counts: testCounts(text), log: fwd(log),
      ...(j.mode ? { suite: { mode: j.mode, ...gateProgress(j.mode === 'as-configured' ? '' : text) } } : {}), ...(r.timedOut ? { timed_out: true, timeout_min: j.timeout_min } : {}) });
  }
  if (left.length) Object.assign(out, { tests_left: left, tests_left_why: `policy.tests.run_budget_min = ${tp.run_budget_min} spent in the Done check: left to CI (unknown, not a pass)` });
  const why = [out.dirty.length ? `${out.dirty.length} uncommitted / untracked file(s)` : null, out.out_of_scope.length ? `${out.out_of_scope.length} changed path(s) outside Scope` : null,
    ...out.tests.filter(x => !x.ok).map(x => `${x.name} exit ${x.code}${x.timed_out ? ` (timed out after ${x.timeout_min} min${x.suite ? `: ${x.suite.mode}${x.suite.files != null ? `, ${x.suite.done}/${x.suite.files} files done` : ''}` : ''})` : ''}`), ...out.problems].filter(Boolean);
  out.ok = !why.length;
  out.why = why.length ? why.join('; ') : null;
  return out;
}

/** one line of a Done check's evidence (Agents, the feed, the resume prompt) */
export const testLine = x => `${x.name} exit ${x.code}${x.counts ? `, ${x.counts.pass} pass ${x.counts.fail} fail` : ''}${x.suite ? ` (${suiteLine(x)})` : ''}`;
/** a gate job's mode, files and time: "gate: changed, 6 files, 41 s" (a cut run: "209/227 files"); dash/widgets.mjs dodTest says the same */
const suiteLine = x => `gate: ${x.suite.mode}${x.suite.files == null ? '' : `, ${x.suite.done < x.suite.files ? `${x.suite.done}/` : ''}${x.suite.files} file${x.suite.files === 1 ? '' : 's'}`}${x.ms != null ? `, ${Math.round(x.ms / 1000)} s` : ''}`;

/** the resume prompt of a failed Done check: the evidence and what to do with it */
export function dodPrompt(d, brief) {
  return [`Norn's Done check failed on your branch (${d.why}). Your DONE does not count until Norn's own check is green:`,
    ...d.dirty.map(p => `- uncommitted / untracked: ${p}`), ...d.out_of_scope.map(p => `- changed outside the brief's Scope: ${p}`),
    ...d.tests.map(x => `- ${x.ok ? 'green' : 'RED'}: \`${x.cmd}\` ${testLine(x)} (log ${x.log})`), ...d.problems.map(p => `- ${p}`),
    'Fix each one in this worktree (commit your work; revert what the brief\'s Scope does not allow; make the tests green - never loosen one), then end with `norn done` as before.',
    'If the Scope or the Tests line itself is wrong, say so and end with `norn done --outcome stopped --why "Done check: <why>"`.',
    ...(brief ? [`Your brief: ${brief}`] : [])].join('\n');
}
