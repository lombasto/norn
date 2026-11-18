// META-TEND TESTS (owner DIR-19 + DIR-47): the lean-tests measures - never-failing / duplicate tests by mutant kill sets, coverage
// unions, slowest-with-cause, tests vs code over git history, copy-paste share, the merge-time advisories and the wave gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { measureFile, coverageUnion, coveragePct, leafNames, slowest, testCause, classify, gitHistory, copyPaste,
  mutationMatrix, neverFailing, duplicates, mergeCheck, leanGate } from '../engine/lib/testlean.mjs';

test.after(cleanTmp);
const F = (file, ms, tests, cov = {}, totals = {}) => ({ file, ms, tests: tests.map(([name, nesting = 0, t = 1]) => ({ name, nesting, ms: t, ok: true })), cov, totals });
const M = (files, coverage = true) => ({ at: 'x', coverage, suite_ms: 9, files });

test('measureFile: the reporter lines -> tests and the repo-relative covered lines per source file', () => {
  const cwd = path.resolve('/r');
  const text = [{ t: 'test', name: 'a', nesting: 0, ms: 3, ok: true }, { t: 'cov', path: path.join(cwd, 'engine', 'x.mjs'), total: 10, lines: [1, 2] }].map(x => JSON.stringify(x)).join('\n') + '\n';
  assert.deepEqual(measureFile('tests\\a.test.mjs', 7, text, cwd), { file: 'tests/a.test.mjs', ms: 7, tests: [{ name: 'a', nesting: 0, ms: 3, ok: true }],
    cov: { 'engine/x.mjs': [1, 2] }, totals: { 'engine/x.mjs': 10 } });
});

test('coverage: the union over test files (one left out on request), the suite % of lines; null without --coverage', () => {
  const m = M([F('a', 1, [['t']], { 's.mjs': [1, 2] }, { 's.mjs': 10 }), F('b', 1, [['u']], { 's.mjs': [2, 3] }, { 's.mjs': 10 })]);
  assert.deepEqual([...coverageUnion(m).get('s.mjs')].sort(), [1, 2, 3]);
  assert.deepEqual([...coverageUnion(m, ['b']).get('s.mjs')], [1, 2]);
  assert.deepEqual(coveragePct(m), { covered: 3, total: 10, pct: 30 });
  assert.equal(coveragePct(M([], false)), null);
});

test('leafNames: subtests count, their parent (reported right after them, one level up) does not', () => {
  const m = M([F('tests/a.test.mjs', 1, [['in', 1], ['out', 0], ['solo', 0]])]);
  assert.deepEqual(leafNames(m), ['a.test.mjs :: in', 'a.test.mjs :: solo']);
});

test('slowest: top-level tests by ms with the cause markers found in each test body', () => {
  const src = "test('slow one', () => {\n  const r = spawnSync('git', ['log']);\n  setTimeout(() => {}, 5);\n});\ntest('fast', () => { assert.ok(1); });\n";
  const m = M([F('t.mjs', 1, [['fast', 0, 2], ['slow one', 0, 900], ['sub', 1, 999]])]);
  const s = slowest(m, 5, () => src);
  assert.deepEqual(s.map(x => [x.name, x.ms]), [['slow one', 900], ['fast', 2]]);
  assert.deepEqual(s[0].cause, ['spawns a process', 'git', 'waits / polls']);
  assert.deepEqual(s[1].cause, ['in-process work']);
  assert.deepEqual(testCause(src, 'not here'), ['not found in the source (a generated name)']);
});

test('classify: tests by path convention (tests/, *.test.*, test_*.py, *_test.rs); vendor and non-source skipped', () => {
  assert.deepEqual(['tests/a.test.mjs', 'engine/lib/x.mjs', 'pkg/test_x.py', 'src/a_test.rs', 'engine/dash/vendor/m.js', 'README.md', 'tests/fixtures/x.json']
    .map(classify), ['test', 'code', 'test', 'test', null, null, null]);
});

test('gitHistory: per day the last first-parent commit -> test cases, test lines, code lines', () => {
  const repo = mkTmp('meta-tl-git-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: process.env.D, GIT_COMMITTER_DATE: process.env.D } });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, 'tests')); fs.mkdirSync(path.join(repo, 'src'));
  const commit = (day, files) => { for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), t); process.env.D = `${day}T12:00:00Z`; g('add', '-A'); g('commit', '-q', '-m', day); };
  commit('2026-01-01', { 'src/a.mjs': 'a\nb\n', 'tests/a.test.mjs': "test('x', () => {});\n" });
  commit('2026-01-02', { 'tests/a.test.mjs': "test('x', () => {});\ntest('y', () => {});\n", 'tests/b.py': 'def test_z():\n  pass\n' });
  commit('2026-01-02', { 'src/a.mjs': 'a\nb\nc\n' });
  delete process.env.D;
  const h = gitHistory(repo);
  assert.deepEqual(h.map(({ sha, ...x }) => x), [
    { day: '2026-01-01', tests: 1, test_lines: 1, code_lines: 2, test_files: 1 },
    { day: '2026-01-02', tests: 3, test_lines: 4, code_lines: 3, test_files: 2 }]);
});

test('copyPaste: the share of tokens in a repeated 50-token run, in the file itself or in another file, with the clone lines', () => {
  const block = n => `test('case ${n}', () => {\n  const r = run(['a', 'b', 'c'], { cwd: dir, env: { A: 1, B: 2 } });\n  assert.equal(r.code, 0); assert.match(r.out, /ok/); assert.deepEqual(r.list, [1, 2, 3]);\n});\n`;
  const same = block(1) + block(1);
  const c = copyPaste(same);
  assert.ok(c.pct > 40 && c.pct <= 100, `pct ${c.pct}`);
  assert.deepEqual(c.clones[0], { line: 5, with: 'itself' });
  assert.equal(copyPaste(block(1)).pct, 0, 'one copy alone is not a clone');
  const o = copyPaste(block(1), [{ name: 'tests/o.test.mjs', text: '// x\n' + block(1) }]);
  assert.equal(o.pct, 100); assert.equal(o.clones[0].with, 'tests/o.test.mjs');
});

const REPORT = { files: { 'engine/lib/x.mjs': { mutants: [
  { id: '1', mutatorName: 'Eq', status: 'Killed', location: { start: { line: 3 } } }, { id: '2', mutatorName: 'Str', status: 'Killed', location: { start: { line: 4 } } },
  { id: '3', mutatorName: 'Bool', status: 'Survived', location: { start: { line: 5 } } }, { id: '4', mutatorName: 'Arith', status: 'Timeout', location: { start: { line: 6 } } }] } } };
const KILLS = [{ mutant: 'dry', fails: [] }, { mutant: '1', fails: ['a :: big', 'a :: small'], ms: 10 }, { mutant: '2', fails: ['a :: big'], ms: 20 },
  { mutant: '3', fails: [], ms: 5 }, { mutant: '4', fails: [], ms: 99 }];

test('mutationMatrix: per file the score and test-process ms; per test its killed mutants; per mutant its killers', () => {
  const m = mutationMatrix(REPORT, KILLS, ['a :: big', 'a :: small', 'a :: idle']);
  assert.deepEqual(m.files, [{ file: 'engine/lib/x.mjs', mutants: 4, killed: 2, survived: 1, timeout: 1, other: 0, ms: 134, score: 75 }]);
  assert.deepEqual(m.tests, { 'a :: big': ['1', '2'], 'a :: small': ['1'], 'a :: idle': [] });
  assert.deepEqual(m.mutants['1'], { file: 'engine/lib/x.mjs', line: 3, mutator: 'Eq', replacement: null, status: 'killed', by: ['a :: big', 'a :: small'] });
});

test('neverFailing + duplicates: no kill = never fails; a kill set inside another = duplicate; equal sets keep the faster test', () => {
  const m = mutationMatrix(REPORT, KILLS, ['a :: big', 'a :: small', 'a :: idle']);
  assert.deepEqual(neverFailing(m), ['a :: idle']);
  assert.deepEqual(duplicates(m), [{ test: 'a :: small', within: 'a :: big', kills: 1, same: false }]);
  const eq = { tests: { p: ['1', '2'], q: ['2', '1'] } };
  assert.deepEqual(duplicates(eq, { p: 50, q: 5 }), [{ test: 'p', within: 'q', kills: 2, same: true }]);
  assert.deepEqual(duplicates(eq, {}), [{ test: 'q', within: 'p', kills: 2, same: true }], 'a tie: one of the two, never both');
});

test('mergeCheck: a new test file with no new line, a copy-paste file over 25 %, the suite over +10 % -> one advisory each', () => {
  const base = M([F('tests/a.test.mjs', 1000, [['a']], { 's.mjs': [1, 2] }), F('tests/b.test.mjs', 1000, [['b']], { 's.mjs': [3] })]);
  const head = M([F('tests/n.test.mjs', 500, [['n1'], ['n2']], { 's.mjs': [1, 3] })]);
  const dup = "test('x', () => { const r = run(['a', 'b', 'c'], { cwd: dir, env: { A: 1, B: 2 } }); assert.equal(r.code, 0); assert.match(r.out, /ok/); });\n";
  const out = mergeCheck({ base, head, added: ['tests/n.test.mjs'], texts: { 'tests/n.test.mjs': dup + dup }, corpus: [] });
  assert.deepEqual(out.map(a => [a.key, a.path, a.phase, a.fix.tier]), [['tests-no-new-coverage', 'tests/n.test.mjs', 'TESTS', 'card'],
    ['tests-copy-paste', 'tests/n.test.mjs', 'TESTS', 'card'], ['tests-suite-slower', null, 'TESTS', 'card']]);
  assert.match(out[2].why, /~2 s to ~3 s .*\+25%/);
  const fresh = M([F('tests/n.test.mjs', 50, [['n1']], { 's.mjs': [9] })]);
  assert.deepEqual(mergeCheck({ base, head: fresh, added: ['tests/n.test.mjs'], texts: { 'tests/n.test.mjs': dup } }), [], 'a new line, no copy, +2.5 %: quiet');
});

test('leanGate: a wave that loses no covered line and no last killer passes; one that does fails and names what it lost', () => {
  const base = M([F('tests/a.test.mjs', 9, [['big'], ['small']], { 's.mjs': [1, 2, 3] }, { 's.mjs': 10 }), F('tests/b.test.mjs', 9, [['b']], { 's.mjs': [3] }, { 's.mjs': 10 })]);
  const matrix = mutationMatrix(REPORT, KILLS, ['a.test.mjs :: big', 'a.test.mjs :: small'].map(x => x));
  const m2 = { ...matrix, mutants: Object.fromEntries(Object.entries(matrix.mutants).map(([k, v]) => [k, { ...v, by: v.by.map(t => t.replace('a ::', 'a.test.mjs ::')) }])) };
  const ok = leanGate({ base, after: M([F('tests/a.test.mjs', 5, [['big']], { 's.mjs': [1, 2] }, { 's.mjs': 10 })]), matrix: m2, removed: ['a.test.mjs :: small'] });
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.before.tests, ok.after.tests, ok.before.cov.pct, ok.after.cov.pct, ok.score.before, ok.score.after], [3, 2, 30, 30, 75, 75]);
  const bad = leanGate({ base, after: M([F('tests/a.test.mjs', 5, [['small']], { 's.mjs': [1] }, { 's.mjs': 10 })]), matrix: m2, removed: ['a.test.mjs :: big'] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.lost_lines, [{ src: 's.mjs', line: 2 }]);
  assert.deepEqual(bad.lost_mutants, ['2']);
  assert.deepEqual(bad.score, { before: 75, after: 50 });
});

// the CLI end to end in a temp node:test repo: measure -> history; check -> advisories; gate -> FAIL + --restore puts the test back
test('norn tests measure / check / lean / gate in a temp repo (state = a temp dir)', () => {
  const st = mkTmp('meta-tl-cli-'), repo = path.join(path.dirname(path.dirname(st)), 'repo');
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
  const norn = (...a) => spawnSync(process.execPath, [path.join(REPO, 'engine', 'bin', 'norn.mjs'), 'tests', ...a, '--state', st, '--repo', repo], { encoding: 'utf8', cwd: repo });
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'engine'), { recursive: true }); fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'engine', 'x.mjs'), 'export function a(n) {\n  return n + 1;\n}\nexport function b(n) {\n  return n * 2;\n}\n');
  const t = (n, f) => `test('${n}', () => { assert.equal(${f}, ${f === 'a(1)' ? 2 : 4}); });\n`;
  const head = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a, b } from '../engine/x.mjs';\n";
  fs.writeFileSync(path.join(repo, 'tests', 'x.test.mjs'), head + t('adds', 'a(1)') + t('doubles', 'b(2)'));
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  let r = norn('measure');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /measured 2 tests in 1 files: .*line coverage/);
  const hist = fs.readFileSync(path.join(st, 'tests', 'history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(hist.length, 1); assert.equal(hist[0].tests, 2); assert.ok(hist[0].coverage.covered > 0);
  r = norn('check', '--base', 'HEAD'); assert.equal(r.status, 0); assert.match(r.stdout, /no test file changed/);
  // a new file that only repeats what x.test.mjs covers: no new coverage (advisory, exit 0)
  fs.writeFileSync(path.join(repo, 'tests', 'y.test.mjs'), head + t('adds again', 'a(1)'));
  g('add', '-A'); g('commit', '-q', '-m', 'y');
  r = norn('check', '--base', 'HEAD~1');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /NEW tests-no-new-coverage tests\/y\.test\.mjs/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(st, 'tests', 'advisories.json'), 'utf8')).list[0].key, 'tests-no-new-coverage');
  const folded = JSON.parse(fs.readFileSync(path.join(st, 'tests', 'measure.json'), 'utf8'));
  assert.deepEqual([folded.files.map(x => x.file), folded.folded], [['tests/x.test.mjs', 'tests/y.test.mjs'], ['tests/y.test.mjs']], 'the next merge compares with this one');
  assert.match(fs.readFileSync(path.join(st, 'tests', 'history.jsonl'), 'utf8'), /"tests":3,.*"via":"merge check"/);
  assert.equal(norn('lean').status, 0);
  // a wave that cuts 'doubles' loses b()'s body: FAIL, --restore puts it back
  fs.writeFileSync(path.join(repo, 'tests', 'x.test.mjs'), head + t('adds', 'a(1)'));
  r = norn('gate', '--base', 'HEAD', '--restore');
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stdout, /FAIL - 1 test\(s\) cut, tests 3 -> 2/); assert.match(r.stdout, /engine\/x\.mjs:5/);
  assert.match(fs.readFileSync(path.join(repo, 'tests', 'x.test.mjs'), 'utf8'), /doubles/);
  // a measure with y: a wave that drops y (its lines are x's too) passes
  r = norn('measure'); assert.equal(r.status, 0);
  fs.rmSync(path.join(repo, 'tests', 'y.test.mjs'));
  r = norn('gate', '--base', 'HEAD');
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /PASS - 1 test\(s\) cut, tests 3 -> 2/);
  const waves = fs.readFileSync(path.join(st, 'tests', 'waves.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(waves.map(w => [w.ok, w.removed, w.restored]), [[false, ['x.test.mjs :: doubles'], ['tests/x.test.mjs']], [true, ['y.test.mjs :: adds again'], []]]);
});

// the Tests tab (beside Usage): /api/tests = testsView(<state>/tests) -> the renderer; a project with nothing measured says how
test('Tests tab: /api/tests reads <state>/tests; the view shows counts over time, slowest, never / duplicate lists, the last wave', async () => {
  const st = mkTmp('meta-tl-view-'), d = path.join(st, 'tests');
  fs.mkdirSync(d, { recursive: true });
  const row = (at, tests, ms) => JSON.stringify({ at, sha: 'abc123', files: 3, tests, suite_ms: ms, file_ms: ms * 2, coverage: { covered: 90, total: 100, pct: 90 } });
  fs.writeFileSync(path.join(d, 'history.jsonl'), row('2026-11-12T10:00:00Z', 961, 900000) + '\n' + row('2026-11-14T10:00:00Z', 805, 500000) + '\n');
  fs.writeFileSync(path.join(d, 'git-history.json'), JSON.stringify({ at: '2026-11-14T10:00:00Z', points: [{ day: '2026-11-13', sha: 'a', tests: 961, test_lines: 200, code_lines: 400, test_files: 9 }, { day: '2026-11-14', sha: 'b', tests: 805, test_lines: 150, code_lines: 400, test_files: 8 }] }));
  fs.writeFileSync(path.join(d, 'candidates.json'), JSON.stringify({ slowest: [{ file: 'tests/a.test.mjs', name: 'walks <SETUP>', ms: 49000, cause: ['spawns the CLI', 'git'] }],
    never: [{ test: 'a.test.mjs :: idle one', ms: 3 }], duplicates: [{ test: 'a.test.mjs :: small', within: 'a.test.mjs :: big', kills: 4, same: false, ms: 9 }] }));
  fs.writeFileSync(path.join(d, 'mutation.json'), JSON.stringify({ files: [{ file: 'engine/lib/drift.mjs', mutants: 256, killed: 154, survived: 102, timeout: 0, score: 60.2, ms: 390000 }], trials: [{ label: 'drift' }], tests: {}, mutants: {} }));
  fs.writeFileSync(path.join(d, 'waves.jsonl'), JSON.stringify({ at: '2026-11-14T11:00:00Z', base: 'main', head: 'def456', ok: true, removed: ['a.test.mjs :: small'], before: { tests: 805, cov: { pct: 90 } }, after: { tests: 804, cov: { pct: 90 } }, score: { before: 60.2, after: 60.2 }, lost_lines: 0, restored: [], ms_before: 9000, ms_after: 8000 }) + '\n');
  const { createDashboard } = await import('../engine/dash/server.mjs');
  const { loadTab, renderTab, renderNav } = await import('../engine/dash/ui.mjs');
  const app = createDashboard({ projects: [{ name: 'kestrel', state: st }], machine: {}, budgetFile: path.join(st, 'budget.json'), platform: {}, sessionsDir: path.join(st, 'sessions') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  let data;
  try { data = await loadTab('tests', 'kestrel', async p => (await fetch(url + p)).json()); } finally { await app.close(); }
  assert.equal(data.project, 'kestrel'); assert.equal(data.history.length, 2);
  const html = renderTab('tests', data, { now: Date.parse('2026-11-14T12:00:00Z') });
  for (const id of ['tests-head', 'tests-time', 'tests-count', 'tests-suite', 'tests-slow', 'tests-mut', 'tests-never', 'tests-dup', 'tests-wave']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /805 tests in 3 files · 1000 s of file time · suite 500 s wall/);
  assert.match(html, /walks &lt;SETUP&gt;/, 'names are escaped');
  assert.match(html, /aria-label="test cases per day \(tests\): 11-13 961, 11-14 805"/);   // UX review 6: the unit in the label
  assert.match(html, /gate passed/); assert.match(html, /kills 0/); assert.match(html, /inside: <span class="mute">a\.test\.mjs<\/span> big/);
  assert.match(renderNav('tests', {}), /id="tab-health"[^>]*aria-selected="true"[^]*id="pages-health"[^]*data-tab="usage"[^]*data-tab="tests"/, 'beside Usage under Health (UX review 2)');
  const empty = renderTab('tests', { history: [], git: null, lean: null, mutation: null, advisories: null, waves: [], commands: { measure: 'norn tests measure', history: 'norn tests history' } }, {});
  assert.match(empty, /not measured yet/); assert.match(empty, /norn tests history/);
  assert.match(empty, /id="tests-scope"[^>]*>Nothing measured yet\. The tick fills/, 'an empty page says why and what fills it');
  const py = renderTab('tests', { suite: false, history: [], git: { points: [{ day: '2026-11-17', tests: 566, test_lines: 14848, code_lines: 39556 }] }, waves: [], commands: { measure: 'norn tests measure' } }, {});
  assert.match(py, /not a node:test suite/); assert.match(py, /id="tests-time"/, 'the git charts still fill');
  assert.doesNotMatch(py, /id="tests-head"|norn tests measure/, 'no command that would refuse');
});

// a pytest project (Solve Shack): check answers that it read nothing (it said "no test file changed" on every merge); measure refuses in words;
// the tick starts `norn tests history` once a day so the charts fill
test('a project without tests/*.test.mjs: check says so (exit 0), measure refuses (exit 2), history still works; tickTests once a day', async () => {
  const st = mkTmp('meta-tl-py-'), repo = path.join(path.dirname(path.dirname(st)), 'repo');
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
  const norn = (...a) => spawnSync(process.execPath, [path.join(REPO, 'engine', 'bin', 'norn.mjs'), 'tests', ...a, '--state', st, '--repo', repo], { encoding: 'utf8', cwd: repo });
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tests', 'test_x.py'), 'def test_x():\n    assert 1\n');
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  let r = norn('check', '--base', 'HEAD');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /no node:test suite .*nothing checked/);
  r = norn('measure'); assert.equal(r.status, 2); assert.match(r.stderr, /no node:test suite/);
  r = norn('history'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /day\(s\) of history/);
  const { tickTests } = await import('../engine/lib/testscli.mjs');
  const calls = [], spawnFn = (exe, args) => (calls.push(args), { pid: 1 });
  const st2 = mkTmp('meta-tl-tick-');
  assert.match(tickTests({ file: 'p.json', root: repo }, st2, { metaCmd: 'norn.mjs', spawnFn }), /tests history: started pid 1/);
  assert.equal(tickTests({ file: 'p.json', root: repo }, st2, { metaCmd: 'norn.mjs', spawnFn }), null, 'not twice within 30 min');
  assert.deepEqual(calls[0].slice(1, 3), ['tests', 'history']);
  assert.equal(tickTests({ file: 'p.json', root: repo }, st, { metaCmd: 'norn.mjs', spawnFn }), null, 'history written today: nothing to start');
});
