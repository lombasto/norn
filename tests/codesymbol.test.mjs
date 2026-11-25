// RM-a-64: `norn code symbol <file>::<name>` (codesymbol.mjs) - one symbol's source and exact line range from the graph reader, checked
// against the worktree file: a file changed since the index re-locates the symbol from the file, or says "moved since the index" with
// the file's current symbols; never stale lines. An unknown name lists the file's symbols.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { ensurePart } from '../engine/lib/rustbin.mjs';
import { readSymbols, parseSpec } from '../engine/lib/codesymbol.mjs';
import { codeCmd } from '../engine/lib/codecli.mjs';

const built = ensurePart('code', { err: s => process.stderr.write(s + '\n') });
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const SHAPES = 'export class Shape {\n  area() {\n    return 0;\n  }\n}\n\nexport function scale(s, k) {\n  return s * k;\n}\n';
function repo() {
  const d = mkTmp('csym-'), r = path.join(d, 'repo');
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'shapes.mjs'), SHAPES);
  fs.writeFileSync(path.join(r, 'package.json'), '{"name":"fx","type":"module"}\n');
  git(r, 'init', '-q'); git(r, 'add', '-A'); git(r, 'commit', '-qm', 'fixture');
  return { repo: r, state: path.join(d, 'state') };
}
const run = (argv, r) => { const o = [], e = []; const code = codeCmd(['symbol', ...argv, '--state', r.state, '--repo', r.repo], { out: s => o.push(s), err: s => e.push(s), where: f => ({ project: null, state: f.state }) }); return { code, out: o.join('\n'), err: e.join('\n') }; };

test('norn-code is built', () => assert.ok(built.ok, built.why));

test('parseSpec: file::name, the first :: splits (Rust names keep theirs), backslashes and ./ normalised; no :: is an error', () => {
  assert.deepEqual(parseSpec('src\\a.rs::cli::Args'), { file: 'src/a.rs', name: 'cli::Args' });
  assert.deepEqual(parseSpec('./src/a.mjs::area'), { file: 'src/a.mjs', name: 'area' });
  assert.throws(() => parseSpec('src/a.mjs'), /file::name/);
  assert.throws(() => parseSpec('src/a.mjs::'), /file::name/);
});

test('an unchanged file: the source and exact bounds, the indexed commit and its age; several symbols in one call', () => {
  const r = repo(), head = git(r.repo, 'rev-parse', 'HEAD');
  const x = readSymbols({ state: r.state, repo: r.repo, specs: ['src/shapes.mjs::Shape.area', 'src/shapes.mjs::scale'] });
  assert.equal(x.results.length, 2);
  const [a, s] = x.results;
  assert.equal(a.status, 'current'); assert.equal(a.stamp.commit, head); assert.equal(typeof a.stamp.age_s, 'number');
  assert.deepEqual([a.defs[0].line, a.defs[0].end_line, a.defs[0].kind], [2, 4, 'method']);
  assert.equal(a.defs[0].source, '  area() {\n    return 0;\n  }');
  assert.deepEqual([s.status, s.defs[0].line, s.defs[0].end_line], ['current', 7, 9]);
  const t = run(['src/shapes.mjs::area', 'src/shapes.mjs::scale'], r);
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, new RegExp(`^src/shapes\\.mjs::area  method src/shapes\\.mjs#Shape\\.area  lines 2\\.\\.4  at ${head.slice(0, 12)} \\(\\d+ s\\), current\\n {2}area\\(\\) \\{`));
  assert.match(t.out, /src\/shapes\.mjs::scale {2}function .* lines 7\.\.9 /);
  const j = JSON.parse(run(['src/shapes.mjs::scale', '--json'], r).out);
  assert.equal(j.results[0].defs[0].source, 'export function scale(s, k) {\n  return s * k;\n}');
});

test('a file changed since the index: the symbol re-located from the worktree file, never the indexed lines', () => {
  const r = repo();
  readSymbols({ state: r.state, repo: r.repo, specs: ['src/shapes.mjs::scale'] });   // index HEAD first
  fs.writeFileSync(path.join(r.repo, 'src', 'shapes.mjs'), '// a new header\n// two lines\n' + SHAPES);
  const [s] = readSymbols({ state: r.state, repo: r.repo, specs: ['src/shapes.mjs::scale'] }).results;
  assert.equal(s.status, 'relocated');
  assert.deepEqual([s.defs[0].line, s.defs[0].end_line, s.indexed[0].line], [9, 11, 7]);
  assert.equal(s.defs[0].source, 'export function scale(s, k) {\n  return s * k;\n}');
  const t = run(['src/shapes.mjs::scale'], r);
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, /lines 9\.\.11 .*changed since the index: re-located in the worktree file \(indexed at 7\.\.9\)/);
});

test('a symbol gone from the changed file: "moved since the index" with the current symbols; an unknown name lists them; exit 1', () => {
  const r = repo();
  fs.writeFileSync(path.join(r.repo, 'src', 'shapes.mjs'), SHAPES.replace(/\nexport function scale[^]*$/, '\nexport function grow(s) {\n  return s + 1;\n}\n'));
  const [m] = readSymbols({ state: r.state, repo: r.repo, specs: ['src/shapes.mjs::scale'] }).results;
  assert.equal(m.status, 'moved'); assert.equal(m.defs.length, 0);
  assert.deepEqual(m.symbols.map(d => d.name), ['Shape', 'area', 'grow']);
  const t = run(['src/shapes.mjs::scale'], r);
  assert.equal(t.code, 1);
  assert.match(t.out, /src\/shapes\.mjs::scale: moved since the index \(indexed at 7\.\.9 at [0-9a-f]{12} \(\d+ s\); not in the worktree file\); its symbols now: Shape \(class 1\.\.5\), area \(method 2\.\.4\), grow \(function 7\.\.9\)/);
  assert.doesNotMatch(t.out, /return s \* k/, 'no stale lines');
  const u = readSymbols({ state: r.state, repo: r.repo, specs: ['src/shapes.mjs::nope'] }).results[0];
  assert.equal(u.status, 'unknown'); assert.deepEqual(u.symbols.map(d => d.name), ['Shape', 'area', 'grow']);
  assert.match(run(['src/shapes.mjs::nope'], r).out, /no symbol nope in src\/shapes\.mjs; its symbols now: Shape/);
  fs.rmSync(path.join(r.repo, 'src', 'shapes.mjs'));
  const g = readSymbols({ state: r.state, repo: r.repo, specs: ['src/shapes.mjs::area'] }).results[0];
  assert.equal(g.status, 'moved'); assert.match(g.why, /deleted in the worktree/); assert.deepEqual(g.symbols, []);
});

test('n/a: an unknown file (exit 3, the reader\'s why); usage errors exit 2', () => {
  const r = repo();
  const [n] = readSymbols({ state: r.state, repo: r.repo, specs: ['nope.mjs::x'] }).results;
  assert.equal(n.status, 'n/a'); assert.match(n.why, /unknown file nope\.mjs/);
  const t = run(['nope.mjs::x'], r);
  assert.equal(t.code, 3); assert.match(t.out, /nope\.mjs::x: n\/a: unknown file/);
  assert.equal(run([], r).code, 2); assert.equal(run(['src/shapes.mjs'], r).code, 2);
});
