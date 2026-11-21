// TESTS-RUNTIME (owner ask 2026-11-19): the per-test timing table (node:test + pytest), its grouping sums, the one-line descriptions,
// test impact, the pytest measurer on a small fixture suite, and the code viewer's path guard (only a file inside the project repo opens).
// Sandbox only: temp dirs (mkTmp), the CLI against --state / --repo, a dashboard on temp state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';
import { measureFile } from '../engine/lib/testlean.mjs';
import { suiteKind, pythonOf, parseJunit, pytestMeasure, pytestCov, describeTest, timesTable, breakdown, slowestTests, impactMap, testsFor, repoFile, testId } from '../engine/lib/testtimes.mjs';
process.env.TZ = 'UTC';   // the dash prints local time (cells.mjs fmtTime): pin the zone these expectations are written in

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

// the dashboard: /api/tests = the summary (+ the open alerts the test machinery raised), ?part= one sub-view; /api/tests/source opens a
// test's file only from inside the project repo
async function tabFixture() {
  const { fixture } = await import('./helpers/dash-fixture.mjs'), { record } = await import('../engine/lib/records.mjs');
  const f = await fixture(), d = path.join(f.pa.state, 'tests'), repo = f.pa.root;
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true }); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', 'a.test.mjs'), Array.from({ length: 80 }, (_, i) => (i === 59 ? "test('two <slow>', async () => { await new Promise(r => setTimeout(r, 300)); });" : `// line ${i + 1} of a long test file that wraps on a phone: ${'x'.repeat(i % 7 * 20)}`)).join('\n'));
  fs.writeFileSync(path.join(f.root, 'secret.txt'), 'outside the repo');
  const t = timesTable(NODE_MEASURE, { sha: 'abc123', run: 'RUN-7', exit: 0 });
  fs.writeFileSync(path.join(d, 'times.json'), JSON.stringify(t)); fs.writeFileSync(path.join(d, 'impact.json'), JSON.stringify(impactMap(NODE_MEASURE, { sha: 'abc123' })));
  fs.writeFileSync(path.join(d, 'history.jsonl'), JSON.stringify({ at: NODE_MEASURE.at, sha: 'abc123', files: 2, tests: 6, suite_ms: 900, file_ms: 900, coverage: { covered: 3, total: 7, pct: 42.9 } }) + '\n');
  fs.writeFileSync(path.join(d, 'costs.json'), JSON.stringify({ at: NODE_MEASURE.at, cpu_pct: 12, tests: { 'tests/a.test.mjs::outer::two': { cpu_s: 2.5, peak_mb: 180, children: { browser: 1, git: 2 }, alone_ms: 300, load_ms: 900 } } }));
  fs.mkdirSync(path.join(f.pa.state, 'mq'), { recursive: true });
  fs.writeFileSync(path.join(f.pa.state, 'mq', 'batch-3.json'), JSON.stringify({ n: 3, status: 'merged', result: 'green', gate: 'node engine/bin/ci-suite.mjs', built: NODE_MEASURE.at, done_at: NODE_MEASURE.at, members: [{ id: 'RUN-5' }], runs: [{ label: 'tip', ok: true, ms: 61000 }] }));
  record(f.pa.state, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'tests/a.test.mjs::outer::two failed 3 times under load', lane: 'gen', area: 'tests', options: [{ key: 'a', text: 'quarantine this test' }, { key: 'b', text: 'open a fix lane' }], recommend: { key: 'a', why: 'passes alone' } } });
  return f;
}
test('Tests tab: the summary (when, which run, alerts as Inbox questions) and each sub-view\'s part; Impact for files; the source guard', async () => {
  const { loadTab, loadParts, renderTab } = await import('../engine/dash/ui.mjs'), { TESTS_SUBS, codeView } = await import('../engine/dash/testparts.mjs');
  const f = await tabFixture(), get = async p => (await f.get(p)).data, now = Date.parse('2026-11-19T12:00:00Z');
  try {
    const view = async (sub, batch) => { const d = await loadTab('tests', 'kestrel', get, { sub, batch }); return { d, html: renderTab('tests', { ...d, ...(await loadParts('tests', 'kestrel', d, get)), parts_loading: false }, { now }) }; };
    assert.deepEqual(TESTS_SUBS.map(x => x[1]), ['Suite', 'Costs and health', 'Impact', 'Run time'], '4 sub-views (CLAUDE.md: never a fifth)');
    const s = await view('suite');
    assert.equal(s.d.times.run, 'RUN-7'); assert.equal(s.d.alerts.length, 1);
    assert.match(s.html, /id="tests-when"[^]*Timings taken <b>10:00<\/b> at <span class="mono">abc123<\/span> by <button[^>]*>RUN-7<\/button>/);
    assert.match(s.html, /id="tests-alerts"[^]*failed 3 times under load[^]*data-act="answer"[^]*data-choice="a"[^]*quarantine this test - recommended[^]*data-tab="inbox"/);
    assert.match(s.html, /id="tests-sum"[^]*<b class="mono">6<\/b><span class="small mute">node:test tests timed[^]*<b class="mono">300 ms<\/b><span class="small mute">slowest: two/);
    assert.match(s.html, /id="tests-breakdown"[^]*tests\/a\.test\.mjs<\/span> <b class="mono">600 ms<\/b> <span class="small mute">66\.7 %[^]*outer<\/span> <b class="mono">400 ms<\/b> <span class="small mute">44\.4 %/);
    assert.match(s.html, /id="tests-rows"[^]*<li data-test="tests\/a\.test\.mjs::outer::two"><div><b>two<\/b> <b class="mono">300 ms<\/b>/);
    assert.match(s.html, /data-act="test-src" data-file="tests\/a\.test\.mjs" data-line="4"/);
    assert.match(s.html, /no description: no docstring, no comment above it, and its name says little/);
    assert.match(s.html, /id="tests-time"[^]*id="tests-cpu"[^]*not measured yet/, 'the charts over time sit under Suite');
    assert.doesNotMatch(s.html, /tests-lanemin/);
    const c = await view('costs');
    assert.match(c.html, /id="tests-pertest"[^]*measured: costs[^]*with the machine at 12 % CPU[^]*not measured yet<\/span> health, tiers/);
    assert.match(c.html, /CPU 2\.5 s · peak 180 MB · children: 1 browser, 2 git · alone 300 ms \/ under load 900 ms/);
    assert.doesNotMatch(c.html, /id="tests-runs"/, 'the per-run share lives in Run time');
    assert.match(c.html, /id="tests-merges"[^]*batch-3<\/b> <b class="mono">61 s<\/b>[^]*node engine\/bin\/ci-suite\.mjs/);
    const i = await view('impact', 'files:engine/z.mjs,engine/none.mjs');
    assert.match(i.html, /2 file\(s\) → <b>1 test file\(s\)<\/b>/); assert.match(i.html, /engine\/none\.mjs<\/span> <span class="small mute">not in the measure/);
    assert.match(i.html, /norn tests for engine\/z\.mjs engine\/none\.mjs/);
    const nl = await view('impact', 'lane:nope');
    assert.match(nl.html, /refused<\/span> no lane nope in kestrel/);
    const rt = await view('runtime');
    assert.match(rt.html, /id="tests-runtime"[^]*aria-pressed="true"[^>]*>24 h[^]*over budget[^]*In force: <b>policy\.tests: mode light, budget 3 min, browser ci, full suite deny<\/b>/);
    assert.match(rt.html, /data-act="open-setting" data-setting="policy\.tests\.run_budget_min"/);
    assert.match(rt.html, /id="tests-rt-rows"><li data-run="RUN-\d+"/, "the fixture's worker run is listed");
    // the code viewer: inside the repo only
    const r = await f.get('/api/tests/source?project=kestrel&file=tests/a.test.mjs');
    assert.equal(r.status, 200); assert.equal(r.data.lines, 80); assert.match(r.data.text, /two <slow>/);
    for (const bad of ['../secret.txt', 'tests/../../secret.txt', path.join(f.root, 'secret.txt'), '.git/config', ''])
      assert.equal((await f.get(`/api/tests/source?project=kestrel&file=${encodeURIComponent(bad)}`)).status, 403, bad);
    const cv = codeView({ file: 'tests/a.test.mjs', text: r.data.text, line: 60 });
    assert.match(cv, /<tr id="srcl-60" class="focus" data-focus="1"><td class="ln mute">60<\/td><td class="lt"><code class="hljs"><span class="hljs-title function_">test<\/span>/);
    assert.match(cv, /&lt;slow&gt;/, 'escaped');
  } finally { await f.done(); }
});

// the pytest project's page: every section that reads node:test only says so itself - no banner over the whole tab
test('Tests tab of a pytest project: the merge check and lean tests each say node:test only; the banner is only for a suite Norn cannot read', async () => {
  const { renderTab } = await import('../engine/dash/ui.mjs');
  const base = { project: 'ss', history: [], git: null, alerts: [], advisories: null, commands: { measure: 'norn tests measure', lean: 'norn tests lean', for: 'norn tests for' } };
  const p = timesTable(pytestMeasure(parseJunit(JUNIT), { at: 'T' }));
  const head = { at: p.at, suite: 'pytest', tests: p.tests.length, files: p.files.length, total_ms: p.total_ms, failed: 1, slowest: { name: p.tests[0].name, ms: p.tests[0].ms } };
  const costs = renderTab('tests', { ...base, suite: 'pytest', times: head, sub: 'costs', sources: {}, rows: { rows: [], n: 0 }, runs: [], merges: [], lean: null, mutation: null }, {});
  assert.doesNotMatch(costs, /id="tests-scope"/, 'no banner for a pytest suite');
  assert.match(costs, /id="tests-adv"[^]*node:test only[^]*this project's suite is pytest/); assert.match(costs, /id="tests-lean"[^]*node:test only/);
  assert.match(costs, /suite wall \(one process\)/);
  const neither = renderTab('tests', { ...base, suite: false, times: null, sub: 'suite', breakdown: null, tests: { rows: [], n: 0 }, cpu: [], wave: null }, {});
  assert.match(neither, /id="tests-scope"[^]*node:test suites \(tests\/\*\.test\.mjs\) and pytest suites/);
});

test('the browser: Tests at 390 px - every sub-view without sideways scroll; a test\'s file opens in the code viewer at its line', { skip: skipWhy, timeout: 240000 }, async () => {
  const f = await tabFixture();
  // the slowest row points at the long file's test (line 60)
  const tf = path.join(f.pa.state, 'tests', 'times.json'), t = JSON.parse(fs.readFileSync(tf, 'utf8')); t.tests[0].line = 60; fs.writeFileSync(tf, JSON.stringify(t));
  const pg = await openPage([390, 844]);
  try {
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=tests`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'tests' && !!document.querySelector('#tests-rows')`, 90000), 'Suite loads its part');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (Suite)');
    for (const sub of ['costs', 'impact', 'runtime']) {
      await pg.ev(`document.querySelector('#tests-sub-${sub}').click()`);
      assert.ok(await pg.until(`document.querySelector('#tests-sub')?.dataset.sub === '${sub}' && !document.querySelector('#tests-sub-loading')`, 60000), sub);
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, `no sideways scroll (${sub})`);
    }
    assert.match(await pg.ev('location.search'), /sub=runtime/);
    await pg.ev(`document.querySelector('#tests-sub-suite').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#tests-rows [data-act=test-src]')`, 60000));
    await pg.ev(`document.querySelector('#tests-rows [data-act=test-src]').click()`);
    assert.ok(await pg.until(`!document.querySelector('#srcview').hidden && !!document.querySelector('#srcview-code tr.focus')`, 30000), 'the viewer opens at the line');
    assert.equal(await pg.ev(`document.querySelector('#srcview-code tr.focus').id`), 'srcl-60');
    assert.ok(await pg.ev(`(() => { const r = document.querySelector('#srcview-code tr.focus').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`), 'scrolled to the test\'s line');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll (viewer)');
  } finally { await pg.close(); await f.done(); }
});

// test-diet S1: the Run time view - per worker run its wall vs test time, the duplicates the test cache spared it, over budget, the policy
test('Run time: runtimePart folds runs + the cache log + policy.tests; the view filters by window, over budget and saved', async () => {
  const { runtimePart } = await import('../engine/lib/testscli.mjs'), { renderTab } = await import('../engine/dash/ui.mjs');
  const now = Date.parse('2026-11-20T12:00:00Z'), ago = h => new Date(now - h * 3600e3).toISOString();
  const runs = [{ id: 'RUN-1', lane: 'ui', state: 'exited', started: ago(2), ended: ago(1), speed: { wall_ms: 3600e3, test_ms: 900e3 } },
    { id: 'RUN-2', lane: 'git', state: 'running', started: ago(0.5), ended: null, speed: { wall_ms: 1800e3, test_ms: 60e3 } },
    { id: 'RUN-3', lane: 'old', state: 'exited', started: ago(40), ended: ago(39), speed: null },
    { id: 'RUN-4', lane: 'gone', state: 'exited', started: ago(100), ended: ago(99), speed: null }];
  const cache = [{ run: 'RUN-2', how: 'reused', saved_ms: 20000 }, { run: 'RUN-2', how: 'waited', saved_ms: 5000 }, { run: 'RUN-1', how: 'ran', saved_ms: 0 }, { run: null, how: 'reused', saved_ms: 1 }];
  const p = runtimePart({ runs, cache, policy: { tests: { run_budget_min: 5 } }, now });
  assert.equal(p.words, 'policy.tests: mode light, budget 5 min, browser ci, full suite deny');
  assert.deepEqual(p.settings, ['policy.tests.mode', 'policy.tests.run_budget_min', 'policy.tests.browser', 'policy.tests.full_suite']);
  assert.deepEqual(p.rows.map(r => [r.id, r.test_pct, r.over, r.dup, r.saved_ms]), [['RUN-2', 3.3, false, 2, 25000], ['RUN-1', 25, true, 0, 0], ['RUN-3', null, false, 0, 0]], 'newest first; 3 days only');
  const page = (testsRt = {}) => renderTab('tests', { project: 'k', history: [], git: null, alerts: [], commands: { measure: 'norn tests measure' }, sub: 'runtime', ...p }, { now, testsRt });
  const day = page();
  assert.match(day, /2 runs: 16 min of 1 h 30 in tests \(18 %\), 25 s saved by the cache/);
  assert.match(day, /data-run="RUN-2"[^]*running[^]*cache: 2 duplicates spared, 25 s saved/);
  assert.match(day, /data-run="RUN-1"[^]*over budget[^]*\(<b>25 %<\/b>\)/);
  assert.doesNotMatch(day, /data-run="RUN-3"/, '24 h window');
  assert.match(page({ window: '3d' }), /data-run="RUN-3"[^]*no transcript: no split/);
  assert.deepEqual([...page({ over: true }).matchAll(/<li data-run="([^"]+)"/g)].map(m => m[1]), ['RUN-1']);
  assert.deepEqual([...page({ saved: true }).matchAll(/<li data-run="([^"]+)"/g)].map(m => m[1]), ['RUN-2']);
  assert.match(day, /data-go="runs" data-gojump="node-RUN-1"/);
});
