// RM-a-65 refactoring targets (engine/lib/codetargets.mjs): split-file, break-cycle and extract-function targets from the code graph
// (docs/code-graph.md: symbols, call edges, cycles) and the code signals (docs/code-signals.md: the fix-first rank), no model. A synthetic
// graph and reader in the contract's shapes; the ESLint numbers from a fake measure tool in ESLint's own message shapes. Each target is a
// brief whose Ready lines parse; candidates are judged lazily in rank order, so a short --top reads only what it prints. Sandbox only (mkTmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { refactorTargets, groupsOf, readTargets, writeTargets, pageTargets, TARGET_LIMITS } from '../engine/lib/codetargets.mjs';
import { codeCmd } from '../engine/lib/codecli.mjs';
import { parseReady } from '../engine/lib/ready.mjs';
import { MEASURE_RUN, FILE_CAP } from '../engine/lib/slop/measure.mjs';

test.after(cleanTmp);
const SHA = 'a'.repeat(40);
const edge = (from, to) => ({ from, to, line: 1, col: 1, kind: 'import', how: 'exact', spec: to, trust: 'unmeasured' });
const def = (file, name, line, end_line, kind = 'function') => ({ id: `${file}#${file}#${name}#0`, file, name, qual: `${file}#${name}`, kind, line, end_line, col: 1, exported: true });
const code = n => Array.from({ length: n }, (_, i) => `x${i};`).join('\n') + '\n';

// lib/big.mjs: over the file ratchet; a1-a3 call each other, b1-b3 call each other, main calls a1 and b1, b2 reads the const K;
// lib/user.mjs calls b2. lib/x.mjs <-> lib/y.mjs: x calls y.f and y.g, y calls x.h only (the cheap edge). lib/long.mjs: one JS function
// over the caps; lib/p.py: one Python function of 120 lines.
function world() {
  const B = 'lib/big.mjs', X = 'lib/x.mjs', Y = 'lib/y.mjs', U = 'lib/user.mjs', L = 'lib/long.mjs', P = 'lib/p.py';
  const defs = {
    [B]: [def(B, 'a1', 1, 400), def(B, 'a2', 401, 800), def(B, 'inner', 402, 410), def(B, 'a3', 801, 1000), def(B, 'b1', 1001, 1200), def(B, 'b2', 1201, 1400), def(B, 'b3', 1401, 1500), def(B, 'main', 1501, 1600), def(B, 'K', 1601, 1601, 'const')],
    [X]: [def(X, 'h', 1, 5), def(X, 'useY', 6, 10)], [Y]: [def(Y, 'f', 1, 5), def(Y, 'g', 6, 8), def(Y, 'useX', 9, 12)],
    [U]: [def(U, 'u', 1, 3)], [L]: [def(L, 'huge', 1, 120)], [P]: [def(P, 'long_one', 1, 120), def(P, 'short', 121, 125)],
  };
  const site = (file, caller, line) => ({ file, line, col: 3, how: 'local', candidates: 1, caller: caller && def(file, caller, 0, 0), depth: 1, trust: 'unmeasured' });
  const calls = {   // callee -> its call sites
    [`${B}:a1`]: [site(B, 'a3', 900), site(B, 'main', 1510), site(B, 'main', 1515)], [`${B}:a2`]: [site(B, 'a1', 10), site(B, 'a1', 20)], [`${B}:a3`]: [site(B, 'a2', 500), site(B, 'inner', 405)],
    [`${B}:b1`]: [site(B, 'b3', 1450), site(B, 'main', 1520)], [`${B}:b2`]: [site(B, 'b1', 1010), site(U, 'u', 2)], [`${B}:b3`]: [site(B, 'b2', 1300)],
    [`${Y}:f`]: [site(X, 'useY', 7)], [`${Y}:g`]: [site(X, 'useY', 8), site(Y, 'useX', 10)], [`${X}:h`]: [site(Y, 'useX', 11)],
  };
  const refs = { [`${B}:K`]: [{ file: B, line: 1250, col: 5, name: 'K' }, { file: B, line: 1601, col: 7, name: 'K' }] };
  const asked = [];
  const read = {
    symbols: ({ file }) => (asked.push(`symbols ${file}`), defs[file] ? { stamp: { commit: SHA }, file, defs: defs[file] } : { ok: false, why: `unknown file ${file}` }),
    callers: ({ symbol }) => { asked.push(`callers ${symbol}`); const d = Object.values(defs).flat().find(x => x.id === symbol); return { stamp: { commit: SHA }, symbol: d, rows: calls[`${d.file}:${d.name}`] || [], truncated: 0 }; },
    references: ({ name, file }) => (asked.push(`refs ${name}`), { stamp: { commit: SHA }, name, defs: [], rows: refs[`${file}:${name}`] || [], truncated: 0 }),
  };
  const texts = { [B]: code(FILE_CAP.lines + 101), [X]: code(10), [Y]: code(12), [U]: code(3), [P]: code(125),
    [L]: 'export function huge(a) { // c=30 l=120 d=5\n' + code(30) + '  if (a) {\n' + code(40) + '  }\n' + code(48) + '}\n' };
  const files = new Map([B, X, Y, U, L, P].map(f => [f, { lang: f.endsWith('.py') ? 'python' : 'javascript', excluded: null }]));
  const graph = { ok: true, stamp: { commit: SHA, tree: 'b'.repeat(40), indexed_at: '2026-11-20T10:00:00Z', age_s: 60, asked: 'HEAD', exact: true, worktree: false }, root: '/r', prefix: '',
    files, edges: [edge(X, Y), edge(Y, X), edge(U, B)], unresolved: [], indexed: null };
  const signals = { sha: 'c'.repeat(12), at: '2026-11-20T10:00:00Z', basis: 'measured', fixes: { status: 'measured' },
    files: { [L]: { fix_first: 90 }, [B]: { fix_first: 70 }, [X]: { fix_first: 50 }, [Y]: { fix_first: 60 }, [P]: { fix_first: 10 }, [U]: { fix_first: 5 } } };
  const impact = { sha: 'e'.repeat(12), at: '2026-11-20T09:00:00Z', sources: { [B]: ['tests/big.test.mjs'], [U]: ['tests/user.test.mjs'] } };
  // the fake measure run: a `// c= l= d=` tail on a function line reports as ESLint's rules do; depth = one max-depth per level on the `if` line
  const tool = (run, side, { texts: ts }) => {
    assert.equal(run.id, MEASURE_RUN.id); asked.push(`measure ${[...ts.keys()].join(',')}`);
    return JSON.stringify([...ts].map(([f, t]) => ({ filePath: f, messages: t.split('\n').flatMap((l, i) => {
      const m = /function (\w+)\(.*\/\/ c=(\d+) l=(\d+) d=(\d+)/.exec(l);
      if (!m) return [];
      const at = { line: i + 1, column: 8, endLine: i + 1, endColumn: 20 }, fn = `Function '${m[1]}'`, ifLine = t.split('\n').findIndex(x => /^\s+if \(/.test(x)) + 1;
      return [{ ruleId: 'max-lines-per-function', message: `${fn} has too many lines (${m[3]}). Maximum allowed is 0.`, ...at }, { ruleId: 'complexity', message: `${fn} has a complexity of ${m[2]}. Maximum allowed is 0.`, ...at },
        ...Array.from({ length: Number(m[4]) }, (_, d) => ({ ruleId: 'max-depth', message: `Blocks are nested too deeply (${d + 1}). Maximum allowed is 0.`, line: ifLine, column: 3, endLine: ifLine, endColumn: 5 }))];
    }) })));
  };
  return { read, asked, graph, signals, impact, tool, text: f => texts[f] ?? null };
}
const run = (w, o = {}) => refactorTargets({ state: null, repo: '/r', graph: w.graph, read: w.read, signals: w.signals, impact: w.impact, tool: w.tool, text: w.text, ...o });

test('the three kinds, ranked by the fix-first rank of their file, each with the exact symbols', async () => {
  const w = world(), r = await run(w, { top: 10 });
  assert.deepEqual(r.targets.map(t => [t.kind, t.rank]), [['extract', 90], ['split', 70], ['cycle', 60], ['extract', 10]]);
  const [ex, sp, cy, py] = r.targets;
  assert.equal(ex.file, 'lib/long.mjs'); assert.equal(ex.name, 'huge'); assert.deepEqual(ex.metrics, { complexity: 30, lines: 120, depth: 5 });
  assert.deepEqual(ex.block, [32, 73], 'the largest nested block the size numbers point at');
  assert.equal(sp.file, 'lib/big.mjs'); assert.equal(sp.groups.length, 1, 'one group moves, the larger one stays');
  assert.deepEqual(sp.groups[0].symbols, ['b1', 'b2', 'b3', 'K']); assert.deepEqual(sp.stays.symbols, ['a1', 'a2', 'a3', 'main']);
  assert.deepEqual(sp.groups[0].importers, ['lib/user.mjs'], 'the files that import a moving symbol change their import');
  assert.equal(sp.cut.edges, 1, 'one call edge (main -> b1) crosses');
  assert.deepEqual(cy.cycle, ['lib/x.mjs', 'lib/y.mjs']); assert.deepEqual([cy.edge.from, cy.edge.to], ['lib/y.mjs', 'lib/x.mjs'], 'the edge with the fewest symbols crossing');
  assert.deepEqual(cy.symbols, ['h']); assert.equal(cy.move.to, 'lib/y.mjs', 'h is used only by y: it moves into y');
  assert.equal(py.file, 'lib/p.py'); assert.equal(py.name, 'long_one'); assert.deepEqual(py.metrics, { lines: 120 }); assert.equal(py.block, null);
  assert.match(py.block_na, /JS only/);
  assert.equal(r.basis, 'inferred'); assert.equal(r.stamp.graph, SHA.slice(0, 12)); assert.equal(r.stamp.signals, 'c'.repeat(12));
});

test('each target is a brief: title, the symbols that move, Ready lines that parse (Scope the files touched, Tests from the index)', async () => {
  const w = world(), r = await run(w, { top: 10 }), sp = r.targets.find(t => t.kind === 'split');
  for (const t of r.targets) { const rd = parseReady(t.text); assert.deepEqual(rd.missing, [], `${t.kind} ${t.file}: ${t.text}`); assert.match(t.text, /^## /); assert.match(t.text, /nothing is edited/); }
  assert.deepEqual(parseReady(sp.text).scope, ['lib/big.mjs', sp.groups[0].to, 'lib/user.mjs']);
  assert.match(sp.text, /b1, b2, b3, K/); assert.match(parseReady(sp.text).tests, /tests\/big\.test\.mjs/); assert.match(parseReady(sp.text).tests, /tests\/user\.test\.mjs/);
  const py = r.targets.find(t => t.file === 'lib/p.py');
  assert.match(parseReady(py.text).tests, /^none known/, 'no test the index knows covers it: said, never guessed');
});

test('lazy in rank order: --top 1 measures only the top file and asks the graph for no call edges', async () => {
  const w = world(), r = await run(w, { top: 1 });
  assert.deepEqual(r.targets.map(t => t.file), ['lib/long.mjs']);
  assert.deepEqual(w.asked, ['measure lib/long.mjs']);
});

test('no stored signals: every rank reads n/a with the reason, the targets still listed (biggest file first)', async () => {
  const w = world(), r = await run(w, { top: 10, signals: null });
  assert.ok(r.targets.every(t => t.rank === null)); assert.match(r.rank_na, /no code signals stored/);
  assert.equal(r.targets[0].file, 'lib/big.mjs'); assert.match(r.targets[0].text, /fix first n\/a/);
});

test('a measure run that fails: JS extract targets are n/a with its reason, nothing guessed', async () => {
  const w = world(), r = await run(w, { top: 10, tool: () => { throw new Error('no eslint here'); } });
  assert.ok(!r.targets.some(t => t.file === 'lib/long.mjs')); assert.match(r.na.find(x => x.file === 'lib/long.mjs').why, /no eslint here/);
});

test('a file with many functions over the caps gives its per_file largest, the rest counted; a long Tests list keeps the tests named for it', async () => {
  const w = world(), L = 'lib/long.mjs', many = Array.from({ length: TARGET_LIMITS.per_file + 2 }, (_, i) => `export function f${i}(a) { // c=${30 + i} l=10 d=0\n  return a;\n}\n`).join('');
  const tests = [...Array.from({ length: TARGET_LIMITS.tests + 4 }, (_, i) => `tests/other${i}.test.mjs`), 'tests/long.test.mjs', 'tests/long-edge.test.mjs'];
  const r = await run(w, { top: 10, text: f => (f === L ? many : w.text(f)), impact: { sha: 'e'.repeat(12), sources: { [L]: tests } } });
  const mine = r.targets.filter(t => t.file === L);
  assert.deepEqual(mine.map(t => t.name), [`f${TARGET_LIMITS.per_file + 1}`, `f${TARGET_LIMITS.per_file}`, `f${TARGET_LIMITS.per_file - 1}`], 'largest excess first');
  assert.match(mine.at(-1).text, /2 more function\(s\)/);
  assert.equal(parseReady(mine[0].text).tests, `tests/long-edge.test.mjs, tests/long.test.mjs +${TARGET_LIMITS.tests + 4} more (\`norn tests for lib/long.mjs\` lists all ${tests.length})`);
});

test('a cycle is cut where the fewest symbols move: the ones used and what they call in their own file', async () => {
  const w = world(), X = 'lib/x.mjs', Y = 'lib/y.mjs', base = w.read.callers;
  // h now calls x's useY: moving h means moving useY too (2), while x -> y moves f and g (2, but f, g call nothing): ties go to fewer used
  w.read.callers = q => { const r = base(q); return r.symbol.name === 'useY' && r.symbol.file === X ? { ...r, rows: [{ file: X, line: 3, col: 3, how: 'local', candidates: 1, caller: def(X, 'h', 1, 5), depth: 1 }] } : r; };
  const cy = (await run(w, { top: 10 })).targets.find(t => t.kind === 'cycle');
  assert.deepEqual([cy.edge.from, cy.edge.to], [Y, X]); assert.deepEqual(cy.move.symbols, ['h', 'useY']); assert.equal(cy.move.to, Y, 'nothing else in x uses h or useY: both move into y');
});

test('groupsOf: greedy modularity keeps tight groups apart and leaves units with no edge where they are', () => {
  const g = groupsOf(['a', 'b', 'c', 'd', 'e', 'f', 'lone'], [['a', 'b', 1], ['b', 'c', 1], ['c', 'a', 1], ['d', 'e', 1], ['e', 'f', 1], ['f', 'd', 1], ['c', 'd', 1]]);
  assert.deepEqual(g.map(x => [...x].sort()), [['a', 'b', 'c'], ['d', 'e', 'f'], ['lone']]);
});

test('stored for the Slop page and printed by `norn code targets`', async () => {
  const d = mkTmp('meta-targets-'), state = path.join(d, 'state'); fs.mkdirSync(state, { recursive: true });
  const w = world(), r = await run(w, { top: 3 });
  writeTargets(state, r); assert.deepEqual(readTargets(state).targets.map(t => t.kind), ['extract', 'split', 'cycle']);
  assert.equal(readTargets(path.join(d, 'none')), null);
  const pg = pageTargets(state);   // the Slop page's slice: at most TARGET_LIMITS.page, each with the brief text it copies
  assert.ok(pg.list.length <= TARGET_LIMITS.page); assert.deepEqual(pg.list.map(t => t.text), r.targets.slice(0, TARGET_LIMITS.page).map(t => t.text));
  assert.deepEqual(Object.keys(pg.list[0]).sort(), ['kind', 'rank', 'scope', 'text', 'title']); assert.equal(pageTargets(path.join(d, 'none')), null);
  const out = [], err = [];
  const code = await codeCmd(['targets', '--top', 'x'], { out: s => out.push(s), err: s => err.push(s), where: () => ({ state }) });
  assert.equal(code, 2); assert.match(err.join('\n'), /--top/);
  assert.ok(TARGET_LIMITS.top >= 1 && TARGET_LIMITS.page >= 1);
});
