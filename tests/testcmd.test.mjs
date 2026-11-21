// TEST-GOVERNANCE S1 (design §3 B1): the one test-command classifier - a table of shell commands -> kind (full / test / watch / null),
// the test files named and the runner. Pure: no files, no processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, isTest } from '../engine/lib/testcmd.mjs';

const TABLE = [
  // the full suite in its spellings
  ['node engine/bin/ci-suite.mjs', 'full', 'ci-suite', []],
  ['cd C:/wt && node "C:/a b/engine/bin/ci-suite.mjs" --measure out.json > ci.log 2>&1 &', 'full', 'ci-suite', []],
  ['node engine/bin/ci-suite.mjs --changed origin/main', 'test', 'ci-suite', []],
  ['pytest', 'full', 'pytest', []],
  ['pytest tests', 'full', 'pytest', []],
  ['python -m pytest -q -k slow', 'full', 'pytest', []],
  ['".venv/Scripts/python.exe" -m pytest tests -q', 'full', 'pytest', []],
  ['pytest tests/test_x.py', 'test', 'pytest', ['test_x.py']],
  ['python -m pytest tests/test_x.py::TestA::test_b -k foo --tb short', 'test', 'pytest', ['test_x.py']],
  ['cd x && uv run --no-sync pytest tests/a.py -q', 'test', 'pytest', []],
  ['uv run pytest', 'full', 'pytest', []],
  ['node --test tests/', 'full', 'node', []],
  ['node --test', 'full', 'node', []],
  ['node --test "tests/*.test.mjs"', 'full', 'node', []],
  ['META_ROOT="$TEMP/r" node --test tests/a.test.mjs tests/b.test.mjs 2>&1 | tail -5', 'test', 'node', ['a.test.mjs', 'b.test.mjs']],
  ['node --test-reporter spec --test tests/x.test.mjs', 'test', 'node', ['x.test.mjs']],
  ['$env:META_ROOT="x"; node --test tests/a.test.mjs', 'test', 'node', ['a.test.mjs']],
  ['timeout 600 node --test tests/a.test.mjs', 'test', 'node', ['a.test.mjs']],
  ['bash -c "node engine/bin/ci-suite.mjs"', 'full', 'ci-suite', []],
  ['if true; then node engine/bin/ci-suite.mjs; fi', 'full', 'ci-suite', []],
  ['npm test', 'full', 'npm', []],
  ['npm run test', 'full', 'npm', []],
  // a bounded for loop over named files is a test run, not a watcher
  ['for f in a b; do node --test tests/$f.test.mjs; done', 'test', 'node', []],
  ['node "C:/n/engine/bin/norn.mjs" smoke', 'test', 'node', []],
  ['cargo test', 'test', 'cargo', []],
  // test-diet S1: the run's node runner, with the paths it names
  ['norn tests run tests/a.test.mjs --changed', 'test', 'norn', ['a.test.mjs']],
  ['node engine/bin/norn.mjs tests run --changed --base origin/main', 'test', 'norn', []],
  // watchers: no bound but the run's own end
  ['tail -f state/x.log', 'watch', 'tail', []],
  ['tail -n 20 -F log.txt', 'watch', 'tail', []],
  ['Get-Content log.txt -Wait', 'watch', 'get-content', []],
  ['timeout 580 bash -c "until [ -s out.txt ]; do sleep 10; done"', 'watch', 'loop', []],
  ['until grep -q done x.log; do sleep 5; done', 'watch', 'loop', []],
  ['while ($true) { Start-Sleep 5 }', 'watch', 'loop', []],
  // not tests
  ['tail -5 log.txt', null, null, []],
  ['git status && git log --oneline -3', null, null, []],
  ['grep -n "--test" engine/lib/x.mjs', null, null, []],
  ['for i in 1 2 3; do echo $i; done', null, null, []],
  // ci-suite.mjs read, not run (these were refused as a full suite before test-diet S1)
  ['cat engine/bin/ci-suite.mjs', null, null, []],
  ['grep -n browser engine/bin/ci-suite.mjs', null, null, []],
  ['node --check engine/bin/ci-suite.mjs', null, null, []],
  ['norn tests for engine/lib/x.mjs', null, null, []],
];

test('classify: each command -> its kind, runner and test files', () => {
  for (const [cmd, kind, runner, files] of TABLE) {
    const r = classify(cmd);
    assert.equal(r.kind, kind, `kind of: ${cmd}`);
    assert.equal(r.runner, runner, `runner of: ${cmd}`);
    assert.deepEqual(r.files, files, `files of: ${cmd}`);
  }
});

test('classify: the strongest segment wins (a full suite after a test file is full); isTest = test or full', () => {
  assert.equal(classify('node --test tests/a.test.mjs && node engine/bin/ci-suite.mjs').kind, 'full');
  assert.equal(classify('node --test tests/a.test.mjs; tail -f x.log').kind, 'test');
  assert.equal(isTest('pytest tests/test_a.py'), true);
  assert.equal(isTest('node engine/bin/ci-suite.mjs'), true);
  assert.equal(isTest('tail -f x.log'), false);
  assert.equal(isTest(undefined), false);
  assert.deepEqual(classify('META_ROOT=x node --test tests/a.test.mjs ./tests/b.test.mjs').paths, ['tests/a.test.mjs', './tests/b.test.mjs'], 'the paths as written (the hook reads them)');
});

