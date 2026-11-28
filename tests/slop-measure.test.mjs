// SloppaChoppa 2 S4 (SPEC 4.1, 4.4 U2): growth and structure numbers - the size line of a branch, the function and file ratchets
// (shadow), one point per landing, the week's top merges by growth, hotspots, fan-in and fan-out. Synthetic repos only (the repo is
// public); the ESLint numbers come from a fake tool that writes ESLint's own message shapes (recorded from a real run below).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { functionsOf, ratchets, measureDiff, sizeLine, sizeOfNumstat, landingPoints, topMerges, hotspots, fanList, growthOf, renderGrowth, measureReplay, CAPS, MEASURE_RUN } from '../engine/lib/slop/measure.mjs';
import { graphAt, cycles } from '../engine/lib/codegraph.mjs';
import { hostWrite, slopSeries, slopLandings } from '../engine/lib/slop/host.mjs';
import { renderDaily } from '../engine/lib/slop/daily.mjs';
import { openPrs } from '../engine/lib/mergeland.mjs';
import { makeGit } from '../engine/lib/dlvgit.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
const commit = (dir, files, msg) => { put(dir, files); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
function repo() {
  const dir = mkTmp('meta-slop-measure-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}
const lines = (n, s = 'x') => Array.from({ length: n }, (_, i) => `const ${s}${i} = ${i};`).join('\n') + '\n';

// a fake ESLint for the measure run: each `function NAME(` line with a `// m c=C l=L d=D p=P` tail reports as the real rules do
// (head position, the numbers in the message); depth D is one max-depth report per level on the function's second line
function fakeEslint(run, side, { texts }) {
  assert.equal(run.id, MEASURE_RUN.id);
  return JSON.stringify([...texts].map(([f, text]) => ({ filePath: f, messages: text.split('\n').flatMap((l, i) => {
    const m = /function (\w*)\(.*\/\/ m c=(\d+) l=(\d+) d=(\d+) p=(\d+)/.exec(l);
    if (!m) return [];
    const at = { line: i + 1, column: l.indexOf('function') + 1, endLine: i + 1, endColumn: l.indexOf('(') + 1 }, fn = m[1] ? `Function '${m[1]}'` : 'Function';
    return [{ ruleId: 'max-lines-per-function', message: `${fn} has too many lines (${m[3]}). Maximum allowed is 0.`, ...at },
      ...(Number(m[5]) ? [{ ruleId: 'max-params', message: `${fn} has too many parameters (${m[5]}). Maximum allowed is 0.`, ...at }] : []),
      { ruleId: 'complexity', message: `${fn} has a complexity of ${m[2]}. Maximum allowed is 0.`, ...at },
      ...Array.from({ length: Number(m[4]) }, (_, d) => ({ ruleId: 'max-depth', message: `Blocks are nested too deeply (${d + 1}). Maximum allowed is 0.`, line: i + 2, column: 3 + d, endLine: i + 2, endColumn: 5 + d }))];
  }) })));
}
const fn = (name, { c = 1, l = 3, d = 0, p = 0, body = '' } = {}) => `export function ${name}(a) { // m c=${c} l=${l} d=${d} p=${p}\n${body}  return a;\n}\n`;

test('functionsOf reads the numbers out of ESLint\'s messages (recorded from a real run): name, span, complexity, lines, depth, params', () => {
  const text = 'export function foo(a, b) {\n  if (a) {\n    for (const x of b) {\n      if (x) return 1;\n    }\n  }\n  return 2;\n}\nconst bar = (p) =>\n  p + 1;\n';
  const raw = [['max-lines-per-function', 1, 8, 20, "Function 'foo' has too many lines (8). Maximum allowed is 0."], ['max-params', 1, 8, 20, "Function 'foo' has too many parameters (2). Maximum allowed is 0."],
    ['max-statements', 1, 8, 20, "Function 'foo' has too many statements (4). Maximum allowed is 0."], ['complexity', 1, 8, 20, "Function 'foo' has a complexity of 4. Maximum allowed is 0."],
    ['max-depth', 2, 3, 5, 'Blocks are nested too deeply (1). Maximum allowed is 0.'], ['max-depth', 3, 5, 8, 'Blocks are nested too deeply (2). Maximum allowed is 0.'],
    ['max-depth', 4, 7, 9, 'Blocks are nested too deeply (3). Maximum allowed is 0.'], ['max-lines-per-function', 9, 13, 19, 'Arrow function has too many lines (2). Maximum allowed is 0.'],
    ['max-params', 9, 13, 19, 'Arrow function has too many parameters (1). Maximum allowed is 0.'], ['complexity', 9, 13, 19, 'Arrow function has a complexity of 1. Maximum allowed is 0.']]
    .map(([rule, line, column, endColumn, msg]) => ({ file: 'a.mjs', rule, line, column, endLine: line, endColumn, msg }));
  const fs2 = functionsOf(raw, text);
  assert.deepEqual(fs2.map(f => [f.key, f.line, f.end, f.complexity, f.lines, f.depth, f.params, f.statements]), [['foo#1', 1, 8, 4, 8, 3, 2, 4], ['bar#1', 9, 10, 1, 2, 0, 1, 0]]);
  assert.deepEqual(fs2[0].extract, [2, 6], 'the largest nested block: the if at depth 1 and its closing brace');
});

test('function ratchet: over a cap and grew, or newly crossing, is a shadow finding with base and head numbers; under the caps or not grown is none', () => {
  const at = (text, file = 'a.mjs') => ({ text, fns: functionsOf(JSON.parse(fakeEslint(MEASURE_RUN, 'head', { texts: new Map([[file, text]]) }))[0].messages.map(m => ({ file, rule: m.ruleId, line: m.line, column: m.column, endLine: m.endLine, endColumn: m.endColumn, msg: m.message })), text) });
  const base = at(fn('big', { c: 25, l: 90 }) + fn('small', { c: 3 }) + fn('cross', { c: 19 }) + fn('same', { c: 30 }));
  const head = at(fn('big', { c: 27, l: 90 }) + fn('small', { c: 4 }) + fn('cross', { c: 21, d: 5, l: 6, body: '  if (a) {\n    a++;\n  }\n' }) + fn('same', { c: 30 }) + fn('fresh', { p: 7 }));
  const r = ratchets({ file: 'a.mjs', base, head });
  assert.deepEqual(r.map(x => [x.ratchet, x.name, x.metrics]), [
    ['function', 'big', { complexity: [25, 27] }], ['function', 'cross', { complexity: [19, 21], depth: [0, 5] }], ['function', 'fresh', { params: [null, 7] }],
    ['excess', 'a.mjs', { excess: [25, 30] }]]);
  assert.ok(r.every(x => x.shadow), 'the ratchets run in shadow');
  assert.match(r[0].msg, /big .*complexity 25 -> 27 \(cap 20\)/);
  assert.match(r[1].msg, /extract lines \d+-\d+/, 'the remedy names the extraction candidate');
});

test('function ratchet anti-gaming: a new helper with one caller in the same file counts with its caller (main split into main2 is no escape)', () => {
  const at = text => ({ text, fns: functionsOf(JSON.parse(fakeEslint(MEASURE_RUN, 'head', { texts: new Map([['a.mjs', text]]) }))[0].messages.map(m => ({ file: 'a.mjs', rule: m.ruleId, line: m.line, column: m.column, endLine: m.endLine, endColumn: m.endColumn, msg: m.message })), text) });
  const base = at(fn('main', { c: 22, l: 6 }));
  const head = at(`export function main(a) { // m c=12 l=4 d=0 p=1\n  main2(a);\n  return a;\n}\nfunction main2(a) { // m c=14 l=3 d=0 p=1\n  return a;\n}\n`);
  const r = ratchets({ file: 'a.mjs', base, head });
  assert.deepEqual(r.filter(x => x.ratchet === 'function').map(x => [x.name, x.metrics]), [['main', { complexity: [22, 25] }]], 'main2 folds into main: 12 + 14 - 1');
});

test('function ratchet pairing: an anonymous or same-named function pairs with itself, not with its neighbour, when one is added or removed above it', () => {
  const at = text => ({ text, fns: functionsOf(JSON.parse(fakeEslint(MEASURE_RUN, 'head', { texts: new Map([['a.mjs', text]]) }))[0].messages.map(m => ({ file: 'a.mjs', rule: m.ruleId, line: m.line, column: m.column, endLine: m.endLine, endColumn: m.endColumn, msg: m.message })), text) });
  const anon = (word, c, l = 3) => `run(function (a) { // m c=${c} l=${l} d=0 p=1\n${Array.from({ length: l - 2 }, (_, i) => `  ${word}${i}(a);\n`).join('')}});\n`;
  const fnr = r => r.filter(x => x.ratchet === 'function').map(x => [x.name, x.line, x.metrics]);
  const big = anon('keep', 30, 5), small = anon('small', 2), other = anon('other', 26, 4);
  assert.equal(at(small + big).fns.map(f => f.name).join(), '(anonymous),(anonymous)', 'the fake reports unnamed functions');
  assert.deepEqual(fnr(ratchets({ file: 'a.mjs', base: at(other + big), head: at(small + other + big) })), [], 'one added above: the unchanged ones pair with themselves');
  assert.deepEqual(fnr(ratchets({ file: 'a.mjs', base: at(small + other + big), head: at(other + big) })), [], 'one removed above: no ratchet');
  assert.deepEqual(fnr(ratchets({ file: 'a.mjs', base: at(other + big), head: at(small + other + anon('keep', 32, 6)) })), [['(anonymous)', 8, { complexity: [30, 32] }]], 'a real growth keeps its own base number');
  const cls = (n, c, l) => `class ${n} {\n  run(a) { // m c=${c} l=${l} d=0 p=1\n${Array.from({ length: l - 2 }, (_, i) => `    ${n}${i}(a);\n`).join('')}  }\n}\n`;
  const meth = text => text.replace(/  run\(a\) \{/g, '  function run(a) {');   // the fake reads `function NAME(`: the same name twice in one file
  assert.deepEqual(fnr(ratchets({ file: 'a.mjs', base: at(meth(cls('A', 22, 4) + cls('B', 25, 5))), head: at(meth(cls('B', 25, 5))) })), [], 'two methods run, the first removed: the other is not reported');
});

test('function ratchet pairing: two unnamed functions on one line pair with themselves by their numbers when one is added above', () => {
  const fn = (n, line, complexity) => ({ name: '(anonymous)', key: `(anonymous)#${n}`, line, end: line, complexity, lines: 1, depth: 0, params: 1, statements: 1, extract: null });
  const fnr = r => r.filter(x => x.ratchet === 'function').map(x => [x.name, x.line, x.metrics]);
  const row = 'xs.filter(a => (a.p ? a.q : a.r)).map(b => b.id);', base = { text: `${row}\n`, fns: [fn(1, 1, 25), fn(2, 1, 2)] };
  const head = c => ({ text: `ys.forEach(z => z());\n${row}\n`, fns: [fn(1, 1, 1), fn(2, 2, c), fn(3, 2, 2)] });
  assert.deepEqual(fnr(ratchets({ file: 'a.mjs', base, head: head(25) })), [], 'unchanged, one added above: the neighbour on the same line is not its partner');
  assert.deepEqual(fnr(ratchets({ file: 'a.mjs', base, head: head(27) })), [['(anonymous)', 2, { complexity: [25, 27] }]], 'a real growth keeps its own base number');
});

test('file ratchet: a file over 1,500 lines that grew by more than 20 net lines; 20 lines is no finding', () => {
  const big = lines(1501);
  assert.deepEqual(ratchets({ file: 'b.mjs', base: { text: big, fns: [] }, head: { text: big + lines(21, 'y'), fns: [] } }).map(x => [x.ratchet, x.metrics]), [['file', { lines: [1501, 1522] }]]);
  assert.deepEqual(ratchets({ file: 'b.mjs', base: { text: big, fns: [] }, head: { text: big + lines(20, 'y'), fns: [] } }), []);
  assert.deepEqual(ratchets({ file: 'n.mjs', base: null, head: { text: lines(1600), fns: [] } }).map(x => x.metrics), [{ lines: [0, 1600] }], 'a new big file grew from nothing');
});

test('size line: net code lines by area, tests apart, from numstat and the loc classes; WARN past 600, or when a fix brief makes code bigger', () => {
  const dir = repo();
  commit(dir, { 'engine/lib/a.mjs': lines(10), 'README.md': 'r\n' }, 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  const head = commit(dir, { 'engine/lib/a.mjs': lines(5), 'engine/dash/p.mjs': lines(12, 'p'), 'tests/a.test.mjs': lines(4, 't'), 'docs/x.md': 'd\nd\n' }, 'head');
  const m = measureDiff({ repo: dir, base: 'main', head, tool: fakeEslint });
  assert.deepEqual(m.size, { code: 7, tests: 4, docs: 2, config: 0, areas: { 'engine/dash': 12, 'engine/lib': -5 } });
  assert.equal(sizeLine(m.size), 'size: code +7 net (engine/dash +12, engine/lib -5), tests +4, docs +2');
  assert.match(sizeLine({ ...m.size, code: 601 }), /^WARN size: code \+601 net .*past 600/);
  assert.match(sizeLine(m.size, { brief: '# Fix the queue\n' }), /^WARN size: .*a fix brief made the code bigger/);
  assert.doesNotMatch(sizeLine(m.size, { brief: '# Feature: a new page\n' }), /WARN/);
  assert.deepEqual(sizeOfNumstat('3\t1\tengine/lib/a.mjs\0-\t-\tbin.png\0' + '2\t0\t\0old.mjs\0engine/new.mjs\0').areas, { 'engine/lib': 2, engine: 2 }, 'a rename counts at its new path; a binary not at all');
});

test('measureDiff: the ratchets over the touched JS files of both sides (renames carried); a tool that fails is said, never a crash', () => {
  const dir = repo();
  commit(dir, { 'engine/a.mjs': fn('big', { c: 25 }), 'engine/old.mjs': fn('mv', { c: 21 }) }, 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x'); git(dir, 'mv', 'engine/old.mjs', 'engine/new.mjs');
  const head = commit(dir, { 'engine/a.mjs': fn('big', { c: 26 }) }, 'head');
  const m = measureDiff({ repo: dir, base: 'main', head, tool: fakeEslint });
  assert.deepEqual(m.ratchets.filter(x => x.ratchet === 'function').map(x => [x.file, x.name]), [['engine/a.mjs', 'big']], 'mv kept its numbers through the rename');
  const bad = measureDiff({ repo: dir, base: 'main', head, tool: () => { throw new Error('no eslint'); } });
  assert.equal(bad.error, 'no eslint'); assert.deepEqual(bad.ratchets, []); assert.equal(bad.size.code, 0);
});

test('landing points: one per first-parent landing { sha, branch, item, code_net, tests_net, over_cap }; the week\'s top five merges by code growth', () => {
  const dir = repo();
  commit(dir, { 'a.mjs': lines(2) }, 'base');
  const grow = [30, 5, 50, 10, 40, 20];
  grow.forEach((n, k) => {
    git(dir, 'checkout', '-q', '-b', `norn/a/l${k}`, 'main'); commit(dir, { [`m${k}.mjs`]: lines(n), [`tests/t${k}.test.mjs`]: lines(k) }, `l${k}`);
    git(dir, 'checkout', '-q', 'main'); git(dir, 'merge', '-q', '--no-ff', '-m', `Merge pull request #${k + 1} from someone/norn/a/l${k}`, `norn/a/l${k}`);
  });
  const pts = landingPoints(dir, 'main', '2000-01-01', { tool: fakeEslint, items: { 'norn/a/l2': 'DLV-9' } });
  assert.equal(pts.length, 7, 'six merges and the base commit');
  const l2 = pts.find(p => p.branch === 'norn/a/l2');
  assert.deepEqual({ ...l2, sha: 0, day: 0 }, { sha: 0, day: 0, branch: 'norn/a/l2', item: 'DLV-9', subject: 'Merge pull request #3 from someone/norn/a/l2', code_net: 50, tests_net: 2, over_cap: 0 });
  assert.deepEqual(topMerges(pts).map(p => [p.branch, p.code_net]), [['norn/a/l2', 50], ['norn/a/l4', 40], ['norn/a/l0', 30], ['norn/a/l5', 20], ['norn/a/l3', 10]]);
  const known = new Set(pts.slice(2).map(p => p.sha));
  assert.equal(landingPoints(dir, 'main', '2000-01-01', { tool: fakeEslint, skip: known }).length, 2, 'a stored point is not measured again');
});

test('host: landing points are stored once per sha; a missed daily day is filled from git, never over a real point', () => {
  const state = mkTmp('meta-slop-measure-st-');
  hostWrite(state, { type: 'landings', points: [{ sha: 'a1', code_net: 3 }, { sha: 'b2', code_net: 4 }] });
  hostWrite(state, { type: 'landings', points: [{ sha: 'b2', code_net: 4 }, { sha: 'c3', code_net: 5 }] });
  assert.deepEqual(slopLandings(state).map(p => p.sha), ['a1', 'b2', 'c3']);
  hostWrite(state, { type: 'daily', day: '2026-11-03', report: '#\n', line: 'l', point: { loc: { totals: { code: 9 } }, sweep: {} }, fill: { '2026-11-01': { loc: { totals: { code: 7 } }, filled: true }, '2026-11-03': { loc: { totals: { code: 1 } }, filled: true } } });
  assert.deepEqual(Object.entries(slopSeries(state).days).map(([d, p]) => [d, p.loc.totals.code, !!p.filled]).sort(), [['2026-11-01', 7, true], ['2026-11-03', 9, false]]);
});

test('hotspots: commits in 30 days times the file\'s complexity sum, top five; graph: fan-in and fan-out over the tree, cycles as before', () => {
  const dir = repo();
  commit(dir, { 'engine/a.mjs': fn('fa', { c: 10 }) + fn('fb', { c: 5 }), 'engine/b.mjs': fn('fc', { c: 40 }), 'engine/c.mjs': fn('fd', { c: 2 }), 'README.md': 'r\n' }, 'one');
  for (let k = 0; k < 3; k++) commit(dir, { 'engine/a.mjs': fn('fa', { c: 10 }) + fn('fb', { c: 5 }) + `// ${k}\n` }, `a${k}`);
  commit(dir, { 'engine/c.mjs': fn('fd', { c: 2 }) + '// c\n', 'README.md': 'r2\n' }, 'c');
  const hs = hotspots(dir, 'main', { tool: fakeEslint, now: Date.now() });
  assert.deepEqual(hs.map(h => [h.file, h.commits, h.complexity, h.score]), [['engine/a.mjs', 4, 15, 60], ['engine/b.mjs', 1, 40, 40], ['engine/c.mjs', 2, 2, 4]]);
  const state = mkTmp('fan-state-');
  assert.deepEqual(fanList(dir, 'main', { state }).in, [], 'no imports in that tree: no fan rows');
  commit(dir, { 'e/a.mjs': "import './b.mjs';\nimport './c.mjs';\n", 'e/b.mjs': "import './c.mjs';\n", 'e/c.mjs': "import './a.mjs';\n", 'e/d.mjs': "import './c.mjs';\n" }, 'graph');
  const fl = fanList(dir, 'main', { state });   // the code graph (codegraph.mjs) at main
  assert.deepEqual(fl.in.map(r => [r.file, r.in, r.out]), [['e/c.mjs', 3, 1], ['e/a.mjs', 1, 2], ['e/b.mjs', 1, 1]]);
  assert.deepEqual(fl.out.map(r => [r.file, r.out]), [['e/a.mjs', 2], ['e/b.mjs', 1], ['e/c.mjs', 1], ['e/d.mjs', 1]]);
  assert.deepEqual(cycles(graphAt({ state, repo: dir, at: 'main' }), { within: ['e/**'] }).cycles, [['e/a.mjs', 'e/b.mjs', 'e/c.mjs']]);
  assert.match(fanList(dir, 'no-such-ref', { state }).why, /unknown rev/, 'no graph: n/a with the why, never a guess');
});

test('the daily report names the five merges that grew the code most this week, the five hotspots, fan-in / fan-out and each area\'s share of the growth', () => {
  const day = '2026-11-08', then = { day: '2026-11-01', totals: { code: 100, tests: 0, docs: 0, config: 0 }, areas: { 'engine/lib': { code: 80 }, 'engine/dash': { code: 20 } } };
  const loc = { ref: 'main', head: 'abcdef0123', totals: { code: 160, tests: 0, docs: 0, config: 0 }, apart: { generated: 0, vendored: 0, fixtures: 0 },
    areas: { 'engine/lib': { code: 125 }, 'engine/dash': { code: 35 } }, languages: {}, series: [then, ...Array.from({ length: 7 }, (_, i) => ({ ...then, day: `2026-11-0${i + 2}` }))], landings: [] };
  const merges = Array.from({ length: 6 }, (_, k) => ({ sha: `${k}`.repeat(8), day: '2026-11-05', branch: `norn/a/l${k}`, item: null, subject: `Merge pull request #${k}`, code_net: 10 * k, tests_net: k, over_cap: k % 2 }));
  const growth = growthOf({ loc, points: merges, hotspots: [{ file: 'engine/a.mjs', commits: 4, complexity: 15, score: 60 }], fan: { in: [{ file: 'engine/c.mjs', in: 3, out: 1 }], out: [{ file: 'engine/a.mjs', in: 1, out: 16 }] } });
  const md = renderGrowth(growth).join('\n');
  assert.match(md, /## Growth: the five merges that grew the code most in 7 d/);
  assert.deepEqual([...md.matchAll(/^\d\. `([0-9]{7})` (norn\/a\/l\d) code \+(\d+)/gm)].map(m => [m[2], Number(m[3])]), [['norn/a/l5', 50], ['norn/a/l4', 40], ['norn/a/l3', 30], ['norn/a/l2', 20], ['norn/a/l1', 10]]);
  assert.match(md, /\| engine\/lib \| 125 \| \+45 \(\+56\.3 %\) \| 75 % \|/, 'the area share: 45 of the week\'s 60 lines');
  assert.match(md, /## Hotspots[\s\S]*1\. `engine\/a\.mjs` 60 = 4 commits x complexity 15/);
  assert.match(md, /fan-out[\s\S]*`engine\/a\.mjs` imports 16 \(over 15\)/);
  const sw = { real: [], empty: [], dead: [], at_risk: [], remote_merged: [], unrelated: [] };
  const { markdown } = renderDaily(loc, sw, { day, growth });
  assert.ok(markdown.includes(md), 'the daily carries the growth section');
  assert.match(renderDaily(loc, sw, { day, growth: { error: 'boom' } }).markdown, /## Growth: could not run\n\nboom/);
});

test('merge-land: the PR body carries the size line of the branch (its merge base with main to its tip)', () => {
  const root = mkTmp('meta-slop-measure-ml-'), origin = path.join(root, 'origin'), dir = path.join(root, 'repo'), wt = path.join(root, 'mwt');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, dir); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'checkout', '-q', '-b', 'main');
  commit(dir, { 'base.txt': 'b\n' }, 'base'); git(dir, 'push', '-q', '-u', 'origin', 'main');
  git(dir, 'checkout', '-q', '-b', 'feat/ok'); commit(dir, { 'engine/ok.mjs': lines(3) }, 'ok'); git(dir, 'push', '-q', 'origin', 'feat/ok');
  git(dir, 'checkout', '-q', 'main'); git(dir, 'worktree', 'add', '-q', '--detach', wt, 'main'); git(wt, 'merge', '-q', '--no-ff', '-m', 'merge', 'origin/feat/ok');
  const ghGit = makeGit((cwd, args) => (args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/o/r.git\n' : git(cwd, ...args) + '\n'));
  let body = null;
  const gh = args => { if (args[1] === 'list') return { code: 0, out: '[]', err: '' }; body = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8'); return { code: 0, out: 'https://github.com/o/r/pull/1\n', err: '' }; };
  const door = (branch, tip) => ({ check: { head: tip, findings: [] }, open: [] });
  const [r] = openPrs({ repo: dir, wt, branches: ['feat/ok'], git: ghGit, gh, door });
  assert.equal(r.status, 'opened', r.why);
  assert.match(body, /^size: code \+3 net \(engine \+3\)$/m);
});

test('measureReplay: the ratchets over the last merged branches of main, each from its merge base', () => {
  const dir = repo();
  commit(dir, { 'a.mjs': fn('big', { c: 21 }) }, 'base');
  git(dir, 'checkout', '-q', '-b', 'f1'); commit(dir, { 'a.mjs': fn('big', { c: 23 }) }, 'grow');
  git(dir, 'checkout', '-q', 'main'); git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge branch f1', 'f1');
  git(dir, 'checkout', '-q', '-b', 'f2'); commit(dir, { 'b.mjs': fn('ok') }, 'ok');
  git(dir, 'checkout', '-q', 'main'); git(dir, 'merge', '-q', '--no-ff', '-m', 'Merge branch f2', 'f2');
  const rp = measureReplay({ repo: dir, main: 'main', last: 50, tool: fakeEslint });
  assert.deepEqual(rp.map(x => [x.subject, x.ratchets.map(h => `${h.ratchet} ${h.name}`)]), [['Merge branch f2', []], ['Merge branch f1', ['function big', 'excess a.mjs']]]);
  assert.equal(CAPS.complexity, 20);
});
