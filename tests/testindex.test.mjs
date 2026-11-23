// SPEC dash-owner-1123 s.1 (T1, T2, T4-T7 data side): `norn tests index` (lib/testindex.mjs) and the Tests tab's parts over it
// (testscli testsPart: suite, case, impact, runtime). A synthetic repo: 3 test files, 1 helper, 4 sources, a fixture folder; a synthetic
// cache log and case log. Sandbox only (mkTmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { scanCases } from '../engine/lib/testindex.mjs';
import { repoIndex, depsOf, cacheDirOf } from '../engine/lib/testcache.mjs';
import { testsPart, tickTests } from '../engine/lib/testscli.mjs';
import { pickInRepo } from '../engine/lib/testpolicy.mjs';

test.after(cleanTmp);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const NORN = path.join(REPO, 'engine', 'bin', 'norn.mjs');
const ONE = `import test from 'node:test';
import { a } from '../engine/a.mjs';
test('alpha: reads a ) in a string', async t => {
  const s = ')', r = /\\)/, u = \`(\${'('}\`;   // a ( in a comment
  /* ) */
  await t.test('inner one', () => {});
});
test('plain title', () => {});
`;
const TWO = `import test from 'node:test';
import { h } from './helpers/h.mjs';
import { b } from '../engine/b.mjs';
// the comment line wins
test('two: covers b and c', () => {
});
`;
const THREE = `import test from 'node:test';
import { b } from '../engine/b.mjs';
const data = 'tests/fixtures/fx/data.txt';
test('three: reads its fixture', () => {});
`;
function world() {
  const d = mkTmp('meta-tix-'), repo = path.join(d, 'repo'), state = path.join(d, 'state', 'kestrel'), w = (f, t) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
  w('engine/a.mjs', "import { b } from './b.mjs';\nexport const a = b;\n"); w('engine/b.mjs', 'export const b = 1;\n'); w('engine/c.mjs', 'export const c = 1;\n'); w('engine/d.mjs', 'export const d = 1;\n');
  w('tests/helpers/h.mjs', "export { c as h } from '../../engine/c.mjs';\n"); w('tests/fixtures/fx/data.txt', 'x\n');
  w('tests/one.test.mjs', ONE); w('tests/two.test.mjs', TWO); w('tests/three.test.mjs', THREE);
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('add', '-A'); g('commit', '-q', '-m', 'base');
  const cache = cacheDirOf(state), rows = (f, xs) => { fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, f), xs.map(x => JSON.stringify(x) + '\n').join('')); };
  const norn = (...a) => spawnSync(process.execPath, [NORN, 'tests', ...a, '--state', state, '--repo', repo], { encoding: 'utf8', cwd: repo });
  const read = f => JSON.parse(fs.readFileSync(path.join(state, 'tests', f), 'utf8'));
  return { repo, state, rows, norn, read, sha: execFileSync('git', ['-C', repo, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim() };
}
const ran = (file, ms, at) => ({ at, run: 'RUN-1', file, key: 'k', how: 'ran', ok: true, ms, saved_ms: 0, by: 'RUN-1' });

test('T1 norn tests index: cases.json (id, line, span, desc), impact.json = the inverse of depsOf minus tests/ and fixtures, times.json medians', () => {
  const w = world();
  w.rows('log.jsonl', [10, 20, 30, 40, 50, 60].map((ms, i) => ran('tests/one.test.mjs', ms, `2026-11-2${i}T00:00:00Z`)).concat([{ ...ran('tests/two.test.mjs', 7, '2026-11-22T00:00:00Z') }, { ...ran('tests/two.test.mjs', 900, '2026-11-22T01:00:00Z'), how: 'reused' }, ran('tests/elsewhere.test.mjs', 5, '2026-11-22T00:00:00Z')]));
  const r = w.norn('index');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tests index: 5 test cases in 3 files; 3 source files covered, 1 not; 2 files timed/);
  const c = w.read('cases.json');
  assert.equal(c.sha, w.sha); assert.ok(c.at);
  const by = Object.fromEntries(c.cases.map(x => [x.id, x]));
  assert.deepEqual(Object.keys(by).sort(), ['tests/one.test.mjs::alpha: reads a ) in a string', 'tests/one.test.mjs::alpha: reads a ) in a string::inner one', 'tests/one.test.mjs::plain title', 'tests/three.test.mjs::three: reads its fixture', 'tests/two.test.mjs::two: covers b and c']);
  const alpha = by['tests/one.test.mjs::alpha: reads a ) in a string'];
  assert.deepEqual([alpha.file, alpha.name, alpha.line, alpha.lines, alpha.desc], ['tests/one.test.mjs', 'alpha: reads a ) in a string', 3, 5, 'reads a ) in a string'], 'the span skips the ) in a string, a regex, a template and comments');
  assert.deepEqual([by['tests/one.test.mjs::alpha: reads a ) in a string::inner one'].line, by['tests/one.test.mjs::plain title'].desc, by['tests/two.test.mjs::two: covers b and c'].desc], [6, 'plain title', 'the comment line wins']);
  assert.deepEqual(c.files['tests/two.test.mjs'], { lines: 7, cases: 1 });
  const im = w.read('impact.json'), ix = repoIndex(w.repo), inv = {};
  for (const t of ['tests/one.test.mjs', 'tests/three.test.mjs', 'tests/two.test.mjs']) for (const f of depsOf(t, ix)) if (!f.startsWith('tests/')) (inv[f] ??= []).push(t);
  assert.deepEqual(im.sources, inv, 'exactly the inverse of depsOf, tests/ (the helper, the fixture) dropped');
  assert.deepEqual(im.sources, { 'engine/a.mjs': ['tests/one.test.mjs'], 'engine/b.mjs': ['tests/one.test.mjs', 'tests/three.test.mjs', 'tests/two.test.mjs'], 'engine/c.mjs': ['tests/two.test.mjs'] });
  assert.deepEqual([im.suite, im.sha, im.uncovered], ['node:test', w.sha, ['engine/d.mjs']]);
  assert.deepEqual(w.read('times.json').files, [{ file: 'tests/one.test.mjs', ms: 40 }, { file: 'tests/two.test.mjs', ms: 7 }], 'the median of the last 5 ran rows; reused rows and other repos\' files left out');
});

test('T2 pickRun: the new impact.json leaves the light pick unchanged (static deps include every direct import); times.json orders it fastest-first', () => {
  const w = world(), changed = ['engine/a.mjs', 'engine/b.mjs', 'engine/c.mjs'];
  const before = pickInRepo(w.repo, w.state, 'light', changed);
  w.rows('log.jsonl', [ran('tests/two.test.mjs', 7, '2026-11-22T00:00:00Z'), ran('tests/three.test.mjs', 900, '2026-11-22T00:00:00Z')]);
  assert.equal(w.norn('index').status, 0);
  const timed = pickInRepo(w.repo, w.state, 'light', changed);
  fs.rmSync(path.join(w.state, 'tests', 'times.json'));
  const withImpact = pickInRepo(w.repo, w.state, 'light', changed);
  assert.deepEqual(withImpact, before, 'impact.json alone: the same pick');
  assert.deepEqual(before.run, ['tests/one.test.mjs', 'tests/three.test.mjs'], 'untimed: by name');
  assert.deepEqual(timed.run, ['tests/one.test.mjs', 'tests/two.test.mjs'], 'timed: b.mjs takes its fastest importer');
});

test('tickTests also starts tests index, detached, when impact.json is not at HEAD and no index started in the last 10 min', () => {
  const w = world(), calls = [], spawnFn = (exe, args) => (calls.push(args.slice(1, 3).join(' ')), { pid: 1 }), p = { file: 'p.json', root: w.repo }, now = Date.parse('2026-11-22T12:00:00Z'); // midday UTC: now + 30 min stays on git-history's day
  fs.mkdirSync(path.join(w.state, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(w.state, 'tests', 'git-history.json'), JSON.stringify({ at: new Date(now).toISOString(), points: [] }));
  assert.match(tickTests(p, w.state, { metaCmd: 'norn.mjs', spawnFn, now }), /tests index: started pid 1/);
  assert.equal(tickTests(p, w.state, { metaCmd: 'norn.mjs', spawnFn, now: now + 60e3 }), null, 'not again within 10 min');
  assert.match(tickTests(p, w.state, { metaCmd: 'norn.mjs', spawnFn, now: now + 11 * 60e3 }), /tests index: started/);
  fs.writeFileSync(path.join(w.state, 'tests', 'impact.json'), JSON.stringify({ at: 'x', sha: w.sha, sources: {} }));
  assert.equal(tickTests(p, w.state, { metaCmd: 'norn.mjs', spawnFn, now: now + 30 * 60e3 }), null, 'the map is at HEAD: nothing to start');
  assert.deepEqual(calls, ['tests index', 'tests index']);
});

const caseRow = (id, ms, at, o = {}) => ({ at, run: o.run ?? 'RUN-a-1', state: o.state ?? 'kestrel', file: id.split('::')[0], id, ms, ok: o.ok ?? true });
function indexed() {
  const w = world();
  assert.equal(w.norn('index').status, 0);
  const A = 'tests/one.test.mjs::alpha: reads a ) in a string', P = 'tests/one.test.mjs::plain title', T = 'tests/two.test.mjs::two: covers b and c';
  w.rows('cases.jsonl', [caseRow(A, 10, '2026-11-22T10:00:00Z'), caseRow(A, 30, '2026-11-22T11:00:00Z', { ok: false }), caseRow(A, 12, '2026-11-22T12:00:00Z', { run: 'RUN-a-9' }),
    caseRow(P, 2, '2026-11-22T10:00:00Z'), caseRow(T, 500, '2026-11-22T09:00:00Z'), caseRow(T, 700, '2026-11-22T09:30:00Z', { state: 'other-project' })]);
  return { ...w, A, P, T, now: Date.parse('2026-11-23T00:00:00Z') };
}

test('T4 suite part: every case with lines, last and median ms, runs; "not run here" = no row; sort, filter, the cap', () => {
  const w = indexed(), part = o => testsPart(w.state, 'suite', { now: w.now, ...o }).list;
  const s = part();
  assert.deepEqual([s.total, s.files, s.sort, s.shown], [5, 3, 'slowest', 5]);
  assert.deepEqual(s.rows.map(r => [r.id, r.last, r.median, r.runs]), [[w.T, 500, 500, 1], [w.A, 12, 12, 3], [w.P, 2, 2, 1],
    ['tests/one.test.mjs::alpha: reads a ) in a string::inner one', null, null, 0], ['tests/three.test.mjs::three: reads its fixture', null, null, 0]], 'slowest median first; another project\'s row is not ours; unrun last');
  assert.deepEqual(part({ sort: 'longest' }).rows.slice(0, 2).map(r => [r.id, r.lines]), [[w.A, 5], ['tests/two.test.mjs::two: covers b and c', 2]]);
  assert.deepEqual(part({ sort: 'file' }).rows.map(r => r.file), ['tests/one.test.mjs', 'tests/one.test.mjs', 'tests/one.test.mjs', 'tests/three.test.mjs', 'tests/two.test.mjs']);
  assert.deepEqual(part({ sort: 'newest' }).rows.slice(0, 2).map(r => r.id), [w.A, w.P], 'the latest run first');
  assert.deepEqual(part({ q: 'TWO.test' }).rows.map(r => r.id), [w.T], 'the filter matches name or file, any case');
  const capped = part({ limit: 2 });
  assert.deepEqual([capped.rows.length, capped.shown, capped.matched], [2, 2, 5]);
  assert.equal(testsPart(mkTmp('meta-tix-none-'), 'suite', {}).list, null, 'no index yet');
});

test('T5 case part: its runs newest first, its file\'s sole-guard sources, the alerts whose title starts with its id', () => {
  const w = indexed(), alerts = [{ id: 'Q-7', title: `${w.A} failed 3 times under load` }, { id: 'Q-8', title: `${w.P} failed` }];
  const c = testsPart(w.state, 'case', { case: w.A, alerts, now: w.now }).case;
  assert.deepEqual([c.id, c.line, c.lines, c.desc], [w.A, 3, 5, 'reads a ) in a string']);
  assert.deepEqual(c.runs.map(r => [r.run, r.ms, r.ok]), [['RUN-a-9', 12, true], ['RUN-a-1', 30, false], ['RUN-a-1', 10, true]]);
  assert.deepEqual([c.median, c.max, c.fails], [12, 30, 1]);
  assert.deepEqual([c.reaches, c.sole], [['engine/a.mjs', 'engine/b.mjs'], ['engine/a.mjs']]);
  assert.deepEqual(c.alerts.map(a => a.id), ['Q-7']);
  assert.equal(testsPart(w.state, 'case', { case: 'tests/nope.test.mjs::x' }).case, null);
});

test('T6 impact part: per test file what it reaches and is the sole guard of; the sources no test reaches', () => {
  const w = indexed(), im = testsPart(w.state, 'impact', {});
  assert.deepEqual(im.files.map(f => [f.file, f.reaches, f.sole]), [['tests/one.test.mjs', 2, ['engine/a.mjs']], ['tests/two.test.mjs', 2, ['engine/c.mjs']], ['tests/three.test.mjs', 1, []]]);
  assert.deepEqual(im.files[0].areas, [['engine', 2]]);
  assert.deepEqual(im.uncovered, ['engine/d.mjs']);
  assert.deepEqual(im.impact.sources, ['engine/a.mjs', 'engine/b.mjs', 'engine/c.mjs'], 'the existing Impact fields stay');
});

test('T7 runtime part: per case its median and max over the last 7 days, for outliers()', () => {
  const w = indexed(), rt = testsPart(w.state, 'runtime', { now: w.now });
  assert.deepEqual(rt.medians.map(c => [c.id, c.value, c.max, c.runs]), [[w.T, 500, 500, 1], [w.A, 12, 30, 3], [w.P, 2, 2, 1]]);
  assert.equal(rt.medians[1].label, 'alpha: reads a ) in a string');
  assert.deepEqual(testsPart(w.state, 'runtime', { now: w.now + 8 * 86400e3 }).medians, [], 'older than 7 days: gone');
});

test('scanCases: describe and it make a title path; a title with ${} has no static id', () => {
  const cs = scanCases('tests/x.test.mjs', "describe('d', () => {\n  it('x', () => {});\n  for (const n of [1]) test(`n ${n}`, () => { it('in', () => {}); });\n});\n");
  assert.deepEqual(cs.map(c => [c.name, c.line, c.lines]), [['d::x', 2, 1]]);
});
