// TESTS-RUNTIME (owner ask 2026-11-19): the per-test timing table (node:test + pytest), its grouping sums, the one-line descriptions,
// test impact, the pytest measurer on a small fixture suite, and the code viewer's path guard (only a file inside the project repo opens).
// Sandbox only: temp dirs (mkTmp), the CLI against --state / --repo, a dashboard on temp state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { measureFile } from '../engine/lib/testlean.mjs';
import { suiteKind, pythonOf, parseJunit, pytestMeasure, pytestCov, describeTest, timesTable, breakdown, slowestTests, impactMap, testsFor, repoFile, testId } from '../engine/lib/testtimes.mjs';

test.after(cleanTmp);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const NORN = path.join(REPO, 'engine', 'bin', 'norn.mjs');
const L = xs => xs.map(x => JSON.stringify(x)).join('\n') + '\n';

test('measureFile: describe() suites and parent tests become each test\'s group; the test keeps its line; a parent is marked', () => {
  // node:test reports a child before its parent: one › two, outer › inner › deep, parent › child
  const text = L([{ t: 'test', name: 'one', nesting: 1, line: 3, ms: 5, ok: true }, { t: 'test', name: 'deep', nesting: 2, line: 4, ms: 7, ok: false },
    { t: 'suite', name: 'inner', nesting: 1, line: 4, ms: 8 }, { t: 'suite', name: 'outer', nesting: 0, line: 2, ms: 14 },
    { t: 'test', name: 'child', nesting: 1, line: 6, ms: 2, ok: true }, { t: 'test', name: 'parent', nesting: 0, line: 6, ms: 3, ok: true },
    { t: 'test', name: 'plain', nesting: 0, line: 7, ms: 1, ok: true }]);
  const m = measureFile('tests/x.test.mjs', 40, text, '/r');
  assert.deepEqual(m.tests.map(t => [t.name, t.group.join(' › '), t.line, !!t.parent]),
    [['one', 'outer', 3, false], ['deep', 'outer › inner', 4, false], ['child', 'parent', 6, false], ['parent', '', 6, true], ['plain', '', 7, false]]);
});

const JUNIT = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" errors="0" failures="1" skipped="1" tests="5" time="2.500">
<testcase classname="tests.test_a" name="test_plain" file="tests\\test_a.py" line="4" time="0.003" />
<testcase classname="tests.test_a" name="test_slow" file="tests/test_a.py" line="10" time="1.250" />
<testcase classname="tests.test_a.TestGroup" name="test_in_class[a&amp;b]" file="tests/test_a.py" line="15" time="0.500"></testcase>
<testcase classname="tests.test_a.TestGroup" name="test_fails" file="tests/test_a.py" line="18" time="0.200"><failure message="assert False">E  assert False</failure></testcase>
<testcase classname="tests.test_b" name="test_skipped" file="tests/test_b.py" line="0" time="0.000"><skipped message="no" /></testcase>
</testsuite></testsuites>`;

test('parseJunit + pytestMeasure: 1-based lines, the class as the group, a failure is not ok, a skipped test is left out', () => {
  const j = parseJunit(JUNIT);
  assert.equal(j.suite_ms, 2500); assert.equal(j.cases.length, 5);
  assert.deepEqual(j.cases[0], { classname: 'tests.test_a', name: 'test_plain', file: 'tests/test_a.py', line: 5, ms: 3, ok: true, skipped: false });
  assert.equal(j.cases[2].name, 'test_in_class[a&b]', 'XML entities decoded');
  const m = pytestMeasure(j, { at: 'T' });
  assert.equal(m.suite, 'pytest'); assert.equal(m.suite_ms, 2500); assert.equal(m.coverage, false);
  assert.deepEqual(m.files.map(f => [f.file, f.ms, f.tests.length]), [['tests/test_a.py', 1953, 4]], 'the skipped file is gone; file ms = the sum of its tests');
  assert.deepEqual(m.files[0].tests.map(t => [t.name, t.group, t.line, t.ok]), [['test_plain', [], 5, true], ['test_slow', [], 11, true], ['test_in_class[a&b]', ['TestGroup'], 16, true], ['test_fails', ['TestGroup'], 19, false]]);
});

test('describeTest: a docstring, else the comment right above (decorators skipped), else a name of 3+ words, else none', () => {
  const py = ['# helper', 'import x', '', '# reads a big file in one chunk', '@pytest.mark.slow', 'def test_chunk():', '    assert 1', '',
    'def test_doc(', '    a,', '):', '    """Adds two numbers.', '', '    More text."""', '', 'def test_x():', '    pass', '', 'def test_one_mebibyte_chunk_is_fast():', "    '''one'''"].join('\n');
  assert.deepEqual(describeTest(py, 6, 'test_chunk', true), { desc: 'reads a big file in one chunk', from: 'comment' });
  assert.deepEqual(describeTest(py, 9, 'test_doc', true), { desc: 'Adds two numbers.', from: 'docstring' });
  assert.deepEqual(describeTest(py, 16, 'test_x', true), { desc: null, from: null }, 'none: say so');
  assert.deepEqual(describeTest(py, 19, 'test_one_mebibyte_chunk_is_fast', true), { desc: 'one', from: 'docstring' });
  assert.deepEqual(describeTest('', null, 'test_one_mebibyte_chunk_is_fast[x]', true), { desc: 'one mebibyte chunk is fast', from: 'name' });
  const js = ["import test from 'node:test';", '', '// the queue drains', '// in order', "test('drains', () => {});", '/**', ' * a block', ' */', "test('b', () => {});", '', "test('a reporter line per test', () => {});"].join('\n');
  assert.deepEqual(describeTest(js, 5, 'drains', false), { desc: 'the queue drains in order', from: 'comment' });
  assert.deepEqual(describeTest(js, 9, 'b', false), { desc: 'a block', from: 'comment' });
  assert.deepEqual(describeTest(js, 11, 'a reporter line per test', false), { desc: 'a reporter line per test', from: 'name' });
});

// the timing table and its sums: the shares are of the suite total; a group's time is the sum of its tests
const NODE_MEASURE = { at: '2026-11-19T10:00:00Z', coverage: true, suite_ms: 900, files: [
  { file: 'tests/a.test.mjs', ms: 600, tests: [{ name: 'one', nesting: 1, line: 3, ms: 100, ok: true, group: ['outer'] }, { name: 'two', nesting: 1, line: 4, ms: 300, ok: true, group: ['outer'] },
    { name: 'deep', nesting: 2, line: 6, ms: 50, ok: false, group: ['outer', 'inner'] }, { name: 'solo', nesting: 0, line: 9, ms: 120, ok: true, group: [] },
    { name: 'kid', nesting: 1, line: 11, ms: 5, ok: true, group: ['parent'] }, { name: 'parent', nesting: 0, line: 11, ms: 8, ok: true, group: [], parent: true }],
  cov: { 'engine/x.mjs': [1, 2], 'engine/y.mjs': [] }, totals: { 'engine/x.mjs': 4, 'engine/y.mjs': 3 } },
  { file: 'tests/b.test.mjs', ms: 300, tests: [{ name: 'b1', nesting: 0, line: 2, ms: 250, ok: true, group: [] }], cov: { 'engine/x.mjs': [3], 'engine/z.mjs': [1] }, totals: {} }] };

test('timesTable: one row per leaf test (a parent is its group), ids pytest-style, slowest first, the suite total, when and which run', () => {
  const t = timesTable(NODE_MEASURE, { sha: 'abc', run: 'RUN-7', exit: 0, wall_ms: 700, readFile: f => (f === 'tests/a.test.mjs' ? "\n// first one\ntest('x')" : null) });
  assert.deepEqual([t.at, t.sha, t.run, t.via, t.suite, t.exit, t.total_ms, t.wall_ms, t.coverage], ['2026-11-19T10:00:00Z', 'abc', 'RUN-7', 'measure', 'node:test', 0, 900, 700, true]);
  assert.deepEqual(t.tests.map(x => x.id), ['tests/a.test.mjs::outer::two', 'tests/b.test.mjs::b1', 'tests/a.test.mjs::solo', 'tests/a.test.mjs::outer::one', 'tests/a.test.mjs::outer::inner::deep', 'tests/a.test.mjs::parent::kid']);
  assert.equal(t.tests.find(x => x.name === 'one').desc, 'first one');
  assert.equal(t.tests.find(x => x.name === 'b1').desc, null, 'no source, a 1-word name: no description');
  assert.deepEqual(t.files.map(f => [f.file, f.tests]), [['tests/a.test.mjs', 5], ['tests/b.test.mjs', 1]]);
  assert.equal(testId('f.py', ['A', 'B'], 'test_x'), 'f.py::A::B::test_x');
});

test('breakdown: per file the share of the suite, per group the summed test time and its share; slowestTests shares', () => {
  const t = timesTable(NODE_MEASURE), b = breakdown(t);
  assert.equal(b.total_ms, 900);
  assert.deepEqual(b.files.map(f => [f.file, f.ms, f.share, f.tests]), [['tests/a.test.mjs', 600, 66.7, 5], ['tests/b.test.mjs', 300, 33.3, 1]]);
  assert.deepEqual(b.files[0].groups.map(g => [g.group, g.ms, g.tests, g.share]), [['outer', 400, 2, 44.4], ['', 120, 1, 13.3], ['outer › inner', 50, 1, 5.6], ['parent', 5, 1, 0.6]]);
  assert.equal(b.files[0].groups.reduce((n, g) => n + g.ms, 0), 575, 'the groups sum to the file\'s test time (the rest is the file\'s own load / setup)');
  assert.deepEqual(slowestTests(t, 2).map(x => [x.name, x.share]), [['two', 33.3], ['b1', 27.8]]);
  // pytest: the total is the suite wall from the junit file (one process)
  const p = timesTable(pytestMeasure(parseJunit(JUNIT), { at: 'T' }));
  assert.equal(p.total_ms, 2500); assert.equal(p.wall_ms, 2500); assert.equal(p.suite, 'pytest');
  assert.deepEqual(breakdown(p).files[0].groups.map(g => [g.group, g.ms]), [['', 1253], ['TestGroup', 700]]);
  assert.deepEqual(breakdown(null), { total_ms: 0, files: [] });
});

test('impactMap + testsFor: a source file -> the test files whose coverage touches it; a test file is itself; unknown says so', () => {
  const im = impactMap(NODE_MEASURE, { sha: 'abc' });
  assert.deepEqual(im.sources, { 'engine/x.mjs': ['tests/a.test.mjs', 'tests/b.test.mjs'], 'engine/z.mjs': ['tests/b.test.mjs'] }, 'a file with no covered line is no source');
  const a = testsFor(im, ['engine\\z.mjs', 'tests/a.test.mjs', 'engine/none.mjs']);
  assert.deepEqual(a.rows, [{ file: 'engine/z.mjs', tests: ['tests/b.test.mjs'], known: true }, { file: 'tests/a.test.mjs', tests: ['tests/a.test.mjs'], known: true }, { file: 'engine/none.mjs', tests: [], known: false }]);
  assert.deepEqual(a.tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.equal(impactMap({ ...NODE_MEASURE, coverage: false }), null);
  // pytest-cov's JSON with contexts: per test file the lines of each source it ran (test files themselves are not sources)
  const cov = pytestCov({ files: { 'pkg/mod.py': { summary: { num_statements: 10 }, contexts: { 3: ['tests/test_a.py::test_x|run', 'tests/test_b.py::T::test_y|setup'], 4: ['tests/test_a.py::test_x|run', ''] } },
    'tests/test_a.py': { contexts: { 1: ['tests/test_a.py::test_x|run'] } } } }, '/r');
  assert.deepEqual(cov, { 'tests/test_a.py': { cov: { 'pkg/mod.py': [3, 4] }, totals: { 'pkg/mod.py': 10 } }, 'tests/test_b.py': { cov: { 'pkg/mod.py': [3] }, totals: { 'pkg/mod.py': 10 } } });
});

test('suiteKind + pythonOf: which suite a folder holds; the gate command\'s python (quoted path, its pytest args), else the repo .venv, else why not', () => {
  const d = mkTmp('meta-tt-kind-');
  assert.equal(suiteKind(d), null);
  fs.mkdirSync(path.join(d, 'tests', 'unit'), { recursive: true }); fs.writeFileSync(path.join(d, 'tests', 'unit', 'test_a.py'), '');
  assert.equal(suiteKind(d), 'pytest', 'one folder down');
  fs.writeFileSync(path.join(d, 'tests', 'x.test.mjs'), '');
  assert.equal(suiteKind(d), 'node:test');
  assert.deepEqual(pythonOf('"C:\\v env\\Scripts\\python.exe" -m pytest tests -q -p no:cacheprovider', d), { python: 'C:\\v env\\Scripts\\python.exe', args: ['tests', '-q', '-p', 'no:cacheprovider'], from: 'project.json merge.gate.cmd' });
  assert.deepEqual(pythonOf('python3 run_tests.py', d), { python: 'python3', args: null, from: 'project.json merge.gate.cmd' });
  assert.match(pythonOf('npm test', d).error, /`npm test` \(not a python command\) and .* has no \.venv/);
  fs.mkdirSync(path.join(d, '.venv', 'bin'), { recursive: true }); fs.writeFileSync(path.join(d, '.venv', 'bin', 'python'), '');
  assert.match(pythonOf(null, d).python, /\.venv\/bin\/python$/);
});

test('repoFile (the code viewer\'s guard): only a file inside the project repo - no absolute path, no .. out, no link out, nothing under .git', () => {
  const root = mkTmp('meta-tt-guard-'), repo = path.join(root, 'repo'), out = path.join(root, 'outside');
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true }); fs.mkdirSync(path.join(repo, '.git')); fs.mkdirSync(out);
  fs.writeFileSync(path.join(repo, 'tests', 'a.test.mjs'), 'x'); fs.writeFileSync(path.join(repo, '.git', 'config'), 'secret'); fs.writeFileSync(path.join(out, 'b.txt'), 'secret');
  assert.equal(repoFile(repo, 'tests/a.test.mjs'), fs.realpathSync.native(path.join(repo, 'tests', 'a.test.mjs')));
  assert.ok(repoFile(repo, 'tests\\a.test.mjs'), 'a backslash path inside is fine');
  for (const bad of ['../outside/b.txt', 'tests/../../outside/b.txt', path.join(out, 'b.txt'), '/etc/passwd', 'C:/Windows/win.ini', '.git/config', 'tests', 'tests/missing.mjs', '', 'tests/a.test.mjs\0'])
    assert.equal(repoFile(repo, bad), null, JSON.stringify(bad));
  let linked = true;
  try { fs.symlinkSync(out, path.join(repo, 'tests', 'link'), 'junction'); } catch { linked = false; }
  if (linked) assert.equal(repoFile(repo, 'tests/link/b.txt'), null, 'a junction / link out of the repo');
});

// the pytest measurer end to end: a small fixture suite, run with the python the gate command names (python on PATH here)
const pyOk = spawnSync('python', ['-c', 'import pytest'], { stdio: 'ignore', windowsHide: true }).status === 0;
test('norn tests measure on a pytest suite: the gate\'s python, --junitxml -> the same timing table; check / lean say node:test only', { skip: pyOk ? false : 'no python with pytest on PATH' }, () => {
  const root = mkTmp('meta-tt-py-'), repo = path.join(root, 'repo'), st = path.join(root, 'state'), pf = path.join(root, 'project.json');
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', 'test_a.py'), ['import time', '', '', 'def test_plain():', '    """Adds two numbers."""', '    assert 1 + 1 == 2', '', '',
    '# sleeps so it is the slowest', 'def test_slow():', '    time.sleep(0.2)', '', '', 'class TestGroup:', '    def test_in_class(self):', '        assert True', ''].join('\n'));
  fs.writeFileSync(path.join(repo, 'tests', 'test_b.py'), 'def test_b():\n    assert True\n');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'pyfix', title: 'pyfix', root: repo.split('\\').join('/'), merge: { gate: { cmd: 'python -m pytest tests -q -p no:cacheprovider' } } }));
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const norn = (...a) => spawnSync(process.execPath, [NORN, 'tests', ...a, '--project', pf, '--state', st, '--repo', repo], { encoding: 'utf8', cwd: repo, env: { ...process.env, META_RUN_ID: 'RUN-42' } });
  let r = norn('measure');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /measured 4 pytest tests in 2 files/);
  const t = JSON.parse(fs.readFileSync(path.join(st, 'tests', 'times.json'), 'utf8'));
  assert.deepEqual([t.suite, t.run, t.via, t.exit], ['pytest', 'RUN-42', 'measure', 0]);
  assert.equal(t.tests[0].id, 'tests/test_a.py::test_slow', 'slowest first');
  assert.deepEqual([t.tests[0].line, t.tests[0].desc, t.tests[0].from], [10, 'sleeps so it is the slowest', 'comment']);
  const by = Object.fromEntries(t.tests.map(x => [x.id, x]));
  assert.deepEqual([by['tests/test_a.py::test_plain'].desc, by['tests/test_a.py::test_plain'].line], ['Adds two numbers.', 4]);
  assert.deepEqual(by['tests/test_a.py::TestGroup::test_in_class'].group, ['TestGroup']);
  assert.equal(by['tests/test_b.py::test_b'].desc, null);
  assert.ok(t.total_ms >= 200, 'the suite wall from the junit file');
  assert.match(fs.readFileSync(path.join(st, 'tests', 'history.jsonl'), 'utf8'), /"suite":"pytest","run":"RUN-42"/);
  assert.match(fs.readFileSync(path.join(st, 'tests', 'measure.log'), 'utf8'), /^python -m pytest tests -q -p no:cacheprovider --junitxml=.* -o junit_family=xunit1/);
  r = norn('check', '--base', 'HEAD'); assert.equal(r.status, 0); assert.match(r.stdout, /a pytest suite .*read node:test only - nothing checked/);
  r = norn('lean'); assert.equal(r.status, 2); assert.match(r.stderr, /a pytest suite/);
  // no pytest-cov in a bare python: no impact map, and `for` says what writes it
  if (!fs.existsSync(path.join(st, 'tests', 'impact.json'))) { r = norn('for', 'pkg/x.py'); assert.equal(r.status, 2); assert.match(r.stderr, /no impact map yet/); }
});

test('norn tests measure on a node:test suite writes times.json + impact.json; `norn tests for` answers from them', () => {
  const root = mkTmp('meta-tt-node-'), repo = path.join(root, 'repo'), st = path.join(root, 'state');
  fs.mkdirSync(path.join(repo, 'engine'), { recursive: true }); fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'engine', 'x.mjs'), 'export const a = n => n + 1;\nexport const b = n => n * 2;\n');
  fs.writeFileSync(path.join(repo, 'tests', 'x.test.mjs'), "import test, { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../engine/x.mjs';\n"
    + "describe('adding', () => {\n  // one more than n\n  it('adds', () => { assert.equal(a(1), 2); });\n});\ntest('plain', () => {});\n");
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const norn = (...a) => spawnSync(process.execPath, [NORN, 'tests', ...a, '--state', st, '--repo', repo], { encoding: 'utf8', cwd: repo });
  let r = norn('measure');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /measured 2 node:test tests in 1 files/);
  const t = JSON.parse(fs.readFileSync(path.join(st, 'tests', 'times.json'), 'utf8')), adds = t.tests.find(x => x.name === 'adds');
  assert.deepEqual([adds.id, adds.line, adds.desc, adds.from], ['tests/x.test.mjs::adding::adds', 6, 'one more than n', 'comment']);
  assert.ok(t.wall_ms > 0 && t.total_ms > 0);
  r = norn('for', 'engine/x.mjs', 'engine/nope.mjs');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /engine\/x\.mjs: tests\/x\.test\.mjs/); assert.match(r.stdout, /engine\/nope\.mjs: not in the last measure's coverage/); assert.match(r.stdout, /1 test file\(s\) to run/);
  assert.equal(norn('for').status, 2);
});
