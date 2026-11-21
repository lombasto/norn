// test-diet S1: policy.tests (engine/lib/testpolicy.mjs) - its defaults, the scope hook's test rule (testsCheck), the run's test time
// from its transcript (testMsOf) and which test files a run runs (pickRun). Pure but for one temp test file (the browser check's read).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp } from './helpers/tmp.mjs';
import { classify } from '../engine/lib/testcmd.mjs';
import { testsPolicy, testsFree, policyWords, fullSuiteDeny, testsCheck, testMsOf, pickRun } from '../engine/lib/testpolicy.mjs';

const DEF = { mode: 'light', run_budget_min: 3, browser: 'ci', full_suite: 'deny' };
const FREE = { mode: 'changed', run_budget_min: 0, browser: 'allow', full_suite: 'allow' };

test('testsPolicy: the defaults fill a missing policy, a bad value gets its default, a good one stays; testsFree only when nothing is checked', () => {
  assert.deepEqual(testsPolicy(undefined), DEF);
  assert.deepEqual(testsPolicy({ tests: {} }), DEF);
  assert.deepEqual(testsPolicy({ tests: { mode: 'heavy', run_budget_min: -1, browser: 'yes', full_suite: 1 } }), DEF);
  assert.deepEqual(testsPolicy({ tests: { mode: 'off', run_budget_min: '0', browser: 'allow', full_suite: 'allow' } }), { mode: 'off', run_budget_min: 0, browser: 'allow', full_suite: 'allow' });
  assert.equal(testsPolicy({ tests: { run_budget_min: 'x' } }).run_budget_min, 3);
  assert.equal(testsFree(FREE), true);
  for (const k of Object.keys(DEF)) assert.equal(testsFree({ ...FREE, [k]: DEF[k] }), false, k);
  assert.equal(policyWords(DEF), 'policy.tests: mode light, budget 3 min, browser ci, full suite deny');
  assert.match(policyWords(FREE), /budget none/);
});

test('fullSuiteDeny: names norn tests run --changed for node, the pytest command for pytest, the rulings and CI', () => {
  const node = fullSuiteDeny(classify('node engine/bin/ci-suite.mjs'));
  assert.match(node, /`norn tests run --changed`/);
  assert.match(node, /`norn tests run tests\/<file>\.test\.mjs`/);
  assert.match(node, /Q-28/);
  assert.match(node, /runs in CI/);
  assert.match(node, /resumed run/);
  assert.match(fullSuiteDeny(classify('pytest tests')), /python -m pytest <tests\/test_x\.py>/);
});

test('testsCheck: the full suite, mode off, the budget, a browser file and a direct node run are refused with the command that works; the rest passes', () => {
  const read = f => /page\.test/.test(f) ? "import { skipWhy } from './helpers/cdp.mjs';" : 'plain';
  const chk = (cmd, t = DEF, o = {}) => testsCheck(cmd, t, { read, ...o });
  // not a test command: never refused, whatever the policy
  for (const t of [DEF, { ...DEF, mode: 'off' }]) assert.equal(chk('git status', t, { testMs: 1e9 }), null);
  // the full suite: refused under deny (every mode), allowed under allow (then the other rules apply)
  assert.match(chk('node engine/bin/ci-suite.mjs'), /^a full test suite \(ci-suite\).*full_suite = deny/);
  assert.match(chk('node engine/bin/ci-suite.mjs', { ...DEF, full_suite: 'allow' }), /norn tests run --changed/);
  assert.equal(chk('node engine/bin/ci-suite.mjs', FREE), null);
  // mode off: every test command, `norn tests run` too
  for (const c of ['norn tests run --changed', 'node --test tests/a.test.mjs', 'python -m pytest tests/test_x.py'])
    assert.match(chk(c, { ...DEF, mode: 'off' }), /policy\.tests\.mode = off/, c);
  // the budget: refused at or past it (min -> ms), passed under it, unknown time (null) = no check, 0 = no budget
  assert.match(chk('norn tests run tests/a.test.mjs', DEF, { testMs: 180000 }), /spent 3\.0 min in tests, past its budget \(policy\.tests\.run_budget_min = 3\): stop testing and finish/);
  assert.equal(chk('norn tests run tests/a.test.mjs', DEF, { testMs: 179999 }), null);
  assert.equal(chk('norn tests run tests/a.test.mjs', DEF, { testMs: null }), null);
  assert.equal(chk('norn tests run tests/a.test.mjs', { ...DEF, run_budget_min: 0 }, { testMs: 1e9 }), null);
  assert.match(chk('python -m pytest tests/test_x.py', DEF, { testMs: 1e6 }), /past its budget/, 'the budget counts every runner');
  // a browser file run straight by node: refused under browser ci, naming the file and the norn command; allow -> the norn redirect
  assert.match(chk('node --test tests/page.test.mjs tests/a.test.mjs'), /^tests\/page\.test\.mjs holds browser \(page\) tests.*`norn tests run tests\/page\.test\.mjs`/);
  assert.match(chk('node --test tests/page.test.mjs', { ...DEF, browser: 'allow' }), /^in a run node tests go through Norn: `norn tests run tests\/page\.test\.mjs`/);
  // a direct node --test / ci-suite --changed: sent to norn tests run (the cache, the browser skip)
  assert.match(chk('META_ROOT=/tmp/r node --test tests/a.test.mjs'), /`norn tests run tests\/a\.test\.mjs`.*policy\.tests: mode light/);
  assert.match(chk('node engine/bin/ci-suite.mjs --changed origin/main'), /`norn tests run --changed` \(policy\.tests\.mode = light/);
  assert.match(chk('node engine/bin/ci-suite.mjs --changed origin/main', { ...DEF, mode: 'changed' }), /policy\.tests\.mode = changed/);
  // the norn runner itself and other runners pass under budget; a free policy passes them all
  for (const c of ['norn tests run --changed', 'norn tests run tests/a.test.mjs', 'python -m pytest tests/test_x.py']) assert.equal(chk(c), null, c);
  for (const c of ['node --test tests/page.test.mjs', 'node engine/bin/ci-suite.mjs --changed origin/main']) assert.equal(chk(c, FREE, { testMs: 1e9 }), null, c);
});

test('testsCheck: the browser check reads the named file relative to cwd (its default read)', () => {
  const d = mkTmp('meta-tp-');
  fs.mkdirSync(path.join(d, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(d, 'tests', 'p.test.mjs'), "import { cdp } from './helpers/cdp.mjs';\n");
  fs.writeFileSync(path.join(d, 'tests', 'q.test.mjs'), "import test from 'node:test';\n");
  assert.match(testsCheck('node --test tests/p.test.mjs', DEF, { cwd: d }), /holds browser/);
  assert.match(testsCheck('node --test tests/q.test.mjs', DEF, { cwd: d }), /^in a run node tests go through Norn/);
  assert.match(testsCheck('node --test tests/missing.test.mjs', DEF, { cwd: d }), /^in a run node tests go through Norn/, 'an unreadable file is not a browser test');
});

test('testMsOf: the union of the finished test calls of a transcript (overlaps once, open and non-test calls not at all)', () => {
  const use = (id, ts, command) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const res = (id, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
  const t = s => `2026-11-20T10:${s}Z`;
  const two = [use('a', t('00:00'), 'norn tests run tests/a.test.mjs'), res('a', t('01:00')), use('g', t('01:00'), 'git status'), res('g', t('05:00')),
    use('b', t('02:00'), 'node --test tests/b.test.mjs'), res('b', t('02:30'))].join('\n');
  assert.equal(testMsOf(two), 90000);
  const overlap = [use('a', t('00:00'), 'norn tests run tests/a.test.mjs'), use('b', t('00:30'), 'node --test tests/b.test.mjs'), res('a', t('01:00')), res('b', t('01:30')),
    use('c', t('03:00'), 'norn tests run --changed'), 'not json'].join('\n');
  assert.equal(testMsOf(overlap), 90000, 'a and b overlap: 0:00-1:30; c never finished');
  assert.equal(testMsOf(''), 0);
  assert.equal(testMsOf(null), 0);
});

test('pickRun: light = the changed tests plus ONE direct test per changed module (own, else named after it, else an importer, fastest first); changed = the ci-suite pick', () => {
  const src = {
    'tests/alpha.test.mjs': "import { a } from '../engine/lib/alpha.mjs';",
    'tests/beta-x.test.mjs': "import { b } from '../engine/lib/beta.mjs';",
    'tests/beta-y.test.mjs': "import { b } from '../engine/lib/beta.mjs';",
    'tests/uses-gamma.test.mjs': "import { g } from '../engine/lib/gamma.mjs';",
    'tests/also-gamma.test.mjs': "import { g } from '../engine/lib/gamma.mjs'; import { a } from '../engine/lib/alpha.mjs';",
    'tests/other.test.mjs': "import test from 'node:test';",
  };
  const tests = Object.keys(src), read = f => src[f] ?? null;
  const light = (changed, o = {}) => pickRun({ mode: 'light', changed, tests, read, ...o });
  assert.deepEqual(light(['engine/lib/alpha.mjs']), { run: ['tests/alpha.test.mjs'], none: [], left: [] }, 'its own test, not the other importer');
  assert.deepEqual(light(['engine/lib/beta.mjs']).run, ['tests/beta-x.test.mjs'], 'one named after it');
  assert.deepEqual(light(['engine/lib/beta.mjs'], { ms: { 'tests/beta-x.test.mjs': 9000, 'tests/beta-y.test.mjs': 100 } }).run, ['tests/beta-y.test.mjs'], 'the fastest');
  assert.deepEqual(light(['engine/lib/gamma.mjs']).run, ['tests/also-gamma.test.mjs'], 'a direct importer (by name when no times)');
  assert.deepEqual(light(['engine/lib/gamma.mjs'], { ms: { 'tests/uses-gamma.test.mjs': 5 } }).run, ['tests/uses-gamma.test.mjs']);
  assert.deepEqual(light(['engine/lib/gamma.mjs'], { per: 2 }).run, ['tests/also-gamma.test.mjs', 'tests/uses-gamma.test.mjs']);
  const r = light(['engine/lib/delta.mjs', 'tests/other.test.mjs', 'docs/TESTING.md', 'engine\\lib\\alpha.mjs']);
  assert.deepEqual(r, { run: ['tests/alpha.test.mjs', 'tests/other.test.mjs'], none: ['engine/lib/delta.mjs'], left: [] }, 'a changed test runs; a module no test reaches is named; a doc is no module');
  assert.deepEqual(light(['engine/lib/gamma.mjs'], { impact: { sources: { 'engine/lib/gamma.mjs': ['tests/uses-gamma.test.mjs'] } } }).run, ['tests/uses-gamma.test.mjs'], 'the impact map confirms importers');
  const ch = pickRun({ mode: 'changed', changed: ['engine/lib/gamma.mjs'], tests, read });
  assert.deepEqual([...ch.run].sort(), ['tests/also-gamma.test.mjs', 'tests/uses-gamma.test.mjs']);
  assert.deepEqual(ch.none, []);
});
