// test-diet S1 (owner 2026-11-21, P1: "stop over-testing in runs"): policy.tests, the ONE home of what a claude run may test and how.
// Measured 2026-11-20 (norn speed, 123 norn worker runs in 48 h): a median 24 % of a run's wall time went to tests, five concurrent UI
// lanes ran the same browser page tests at once, and GitHub CI runs the full suite on every PR and nightly anyway. So:
//   mode            light (default: the test files that directly cover the changed files, picked by code: lightPick) | changed (every test
//                   file touching the change: ci-suite's pickTests) | off (CI only)
//   run_budget_min  the test wall time a run may spend (its transcript's test calls: runTestMs); past it the hook refuses the next test
//                   command with "stop testing and finish". 0 = no budget. The Done check (dod.mjs) stays inside it too.
//   browser         ci (default: a lane run never starts a page test; `norn tests run` sets META_TEST_BROWSER=skip, tests/helpers/cdp.mjs
//                   skips them) | allow
//   full_suite      deny (TEST-GOVERNANCE S1, owner Q-28) | allow
// testsCheck is the scope hook's test rule (scope.mjs scopeCheck); it supersedes TEST-GOVERNANCE S3's share budget (25 % / 50 % of the
// run's wall time, a budgets.jsonl nothing wrote) with one number the owner sets in Settings. Node tests in a guarded run go through `norn tests run`
// (testcache.mjs: one result per file and content, shared by every run on the machine), so a direct `node --test` is refused with that
// command. Pure but for readTestMs (a transcript read) and the browser check (reads the named test files).
import fs from 'node:fs';
import path from 'node:path';
import { classify } from './testcmd.mjs';
import { POLICY_DEFAULTS } from './policy.mjs';
import { isBrowserTest, importsOf, pickTests } from './cisuite.mjs';
import { workInit, onWork } from './progress.mjs';
import { TIMES_FILE, IMPACT_FILE } from './testtimes.mjs';

export const TEST_MODES = ['light', 'changed', 'off'], BROWSER_MODES = ['ci', 'allow'], FULL_SUITE = ['deny', 'allow'];
/** the env a run's test process gets while policy.tests.browser = ci: tests/helpers/cdp.mjs skipWhy reads it */
export const BROWSER_SKIP_ENV = { META_TEST_BROWSER: 'skip' };
const fwd = s => String(s).replace(/\\/g, '/');

/** a project policy -> its policy.tests with every default filled and every bad value replaced by the default */
export function testsPolicy(policy) {
  const d = POLICY_DEFAULTS.tests, t = policy?.tests ?? {}, b = Number(t.run_budget_min);
  return { mode: TEST_MODES.includes(t.mode) ? t.mode : d.mode, run_budget_min: Number.isFinite(b) && b >= 0 ? b : d.run_budget_min,
    browser: BROWSER_MODES.includes(t.browser) ? t.browser : d.browser, full_suite: FULL_SUITE.includes(t.full_suite) ? t.full_suite : d.full_suite };
}
/** nothing to enforce on a test command: the hook passes every one (norn-hook decides this from the scope file's tests_free) */
export const testsFree = t => t.full_suite === 'allow' && t.mode === 'changed' && t.browser === 'allow' && !(t.run_budget_min > 0);
/** one line naming the policy in force, for the hook's reasons, `norn tests run` and the Tests tab */
export const policyWords = t => `policy.tests: mode ${t.mode}, budget ${t.run_budget_min > 0 ? `${t.run_budget_min} min` : 'none'}, browser ${t.browser}, full suite ${t.full_suite}`;

// ---------- the hook's reasons: one line each, with the command that works ----------
const CI = 'GitHub CI runs the full suite on every PR and nightly';
export function fullSuiteDeny(r) {
  const how = r.runner === 'pytest' ? '`python -m pytest <tests/test_x.py>` (the test files of the modules you changed, one at a time)'
    : '`norn tests run --changed` (the tests that directly cover the files your branch changed) or `norn tests run tests/<file>.test.mjs`';
  return `a full test suite (${r.runner}) never runs in a worker or MERGE run, a resumed run and a hand-off's "then one full suite" included (owner rulings Q-26 / Q-28; policy.tests.full_suite = deny): `
    + `the full suite runs in CI on every PR and on main after a batch lands. Run only the tests relevant to your change: ${how}; docs/TESTING.md has the rules`;
}
const offDeny = () => `tests do not run in a run of this project (policy.tests.mode = off): ${CI}. Commit, write your NOTES and finish without running tests`;
const budgetDeny = (ms, t) => `this run has spent ${(ms / 60000).toFixed(1)} min in tests, past its budget (policy.tests.run_budget_min = ${t.run_budget_min}): stop testing and finish - commit, write your NOTES, \`norn done\`. ${CI}`;
const browserDeny = files => `${files.join(' ')} hold${files.length === 1 ? 's' : ''} browser (page) tests, which never run in a lane run (policy.tests.browser = ci; ${CI}): \`norn tests run ${files.join(' ')}\` runs the other tests of the file with the browser ones skipped`;
const viaNorn = (r, t) => r.runner === 'ci-suite'
  ? `in a run the changed-file tests go through Norn: \`norn tests run --changed\` (${t.mode === 'light' ? 'policy.tests.mode = light: the test files that directly cover the files you changed' : 'policy.tests.mode = changed: the pick of ci-suite --changed'}; a file another run already passed on the same content is reused, not rerun)`
  : `in a run node tests go through Norn: \`norn tests run ${r.paths?.length ? r.paths.join(' ') : 'tests/<file>.test.mjs'}\` (the same files with an empty META_ROOT; a file another run already passed on the same content is reused and one running now is waited for, never started twice; ${policyWords(t)})`;

/**
 * The test rule of the scope hook: shell command -> refusal reason | null. t = testsPolicy(...); o: { testMs: the run's test time so far
 * (null = unknown: no budget check), cwd: where relative test paths resolve, read(abs) -> text | null (the browser check) }.
 */
export function testsCheck(cmd, t, { testMs = null, cwd = '.', read = readOr } = {}) {
  const r = classify(cmd);
  if (r.kind !== 'test' && r.kind !== 'full') return null;
  if (r.kind === 'full' && t.full_suite === 'deny') return fullSuiteDeny(r);
  if (t.mode === 'off') return offDeny();
  if (t.run_budget_min > 0 && Number.isFinite(testMs) && testMs >= t.run_budget_min * 60000) return budgetDeny(testMs, t);
  if (testsFree(t) || (r.runner !== 'node' && r.runner !== 'ci-suite')) return null;
  if (t.browser === 'ci' && r.runner === 'node') {
    const br = (r.paths || []).filter(p => isBrowserTest(read(path.resolve(cwd, p))));
    if (br.length) return browserDeny(br);
  }
  return viaNorn(r, t);
}
const readOr = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// ---------- the run's test time, from its own transcript (the same fold as norn speed: progress.mjs onWork + testcmd classify) ----------
/** the wall time of a transcript's finished test calls (their union: background calls may overlap), ms */
export function testMsOf(text) {
  const c = workInit();
  for (const l of String(text ?? '').split('\n')) { if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; } onWork(c, j); }
  const iv = c.calls.filter(x => x.kind === 'test').map(x => [Date.parse(x.ts), Date.parse(x.end)]).filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  let sum = 0, cur = null;
  for (const [a, b] of iv) { if (!cur || a > cur[1]) { if (cur) sum += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b); }
  return cur ? sum + cur[1] - cur[0] : 0;
}
/** testMsOf a transcript file (Claude Code's hook payload names it: transcript_path); null when it cannot be read */
export const readTestMs = file => { const t = file ? readOr(file) : null; return t === null ? null : testMsOf(t); };

// ---------- which test files a run runs (norn tests run --changed; the Done check) ----------
const stem = f => (/\.m?js$/.test(f) && !f.startsWith('tests/') ? f.split('/').pop().replace(/\.m?js$/, '') : null);
/**
 * mode light: the test files that DIRECTLY cover the changed files - every changed test file, then per changed source module `per` (1)
 * of: its own test (<stem>.test.mjs), the tests named after it (<stem>-*.test.mjs), the tests that import it directly (when an impact
 * map from `norn tests measure` exists, only those its coverage confirms); fastest first by `ms` (file -> ms of the last measure). A
 * module none of them reaches is named in `none` (left to CI). mode changed: ci-suite's pick (cisuite.mjs pickTests, importers capped
 * at 20). -> { run: [test files], none: [changed modules no test covers directly], left: [importers past the cap] }
 */
export function pickRun({ mode, changed, tests, read, impact = null, ms = {}, per = 1 }) {
  const ch = [...new Set(changed.map(fwd))], all = tests.map(fwd);
  if (mode === 'changed') { const p = pickTests(ch, all, read, 20); return { run: p.run, none: [], left: p.left }; }
  const run = new Set(all.filter(t => ch.includes(t))), none = [], text = new Map();
  const src = f => { if (!text.has(f)) text.set(f, read(f)); return text.get(f); };
  const fast = (a, b) => (ms[a] ?? Infinity) - (ms[b] ?? Infinity) || a.localeCompare(b);
  for (const f of ch) {
    const s = stem(f);
    if (!s) continue;
    const name = t => t.split('/').pop(), own = all.filter(t => name(t) === `${s}.test.mjs`), named = all.filter(t => name(t).startsWith(`${s}-`)).sort(fast);
    const cov = impact?.sources?.[f], imp = all.filter(t => !own.includes(t) && !named.includes(t) && (!cov || cov.includes(t)) && importsOf(t, src(t) ?? '').includes(f)).sort(fast);
    const pick = [...own, ...named, ...imp].slice(0, per);
    if (!pick.length) none.push(f);
    for (const t of pick) run.add(t);
  }
  return { run: [...run].sort(), none, left: [] };
}
/** pickRun over a repo's own tests/*.test.mjs (none when it has no tests/ folder: a project that is not node-tested), with the last
 * `norn tests measure` of project state dir `state` (its times.json for fastest-first, impact.json) when there (state null: none) */
export function pickInRepo(repo, state, mode, changed) {
  let tests = [];
  try { tests = fs.readdirSync(path.join(repo, 'tests')).filter(x => x.endsWith('.test.mjs')).map(x => `tests/${x}`); } catch { /* no tests folder */ }
  const m = f => { const t = state ? readOr(path.join(state, 'tests', f)) : null; try { return t === null ? null : JSON.parse(t); } catch { return null; } };
  const ms = Object.fromEntries((m(TIMES_FILE)?.files ?? []).map(x => [x.file, x.ms]));
  return pickRun({ mode: mode === 'off' ? 'light' : mode, changed, tests, read: f => readOr(path.join(repo, f)), impact: m(IMPACT_FILE), ms });
}
