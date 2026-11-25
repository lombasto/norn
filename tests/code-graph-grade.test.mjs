// code-graph S4a (SPEC code-graph sections 5 and 9): `norn-code grade files` grades the file-level edges of a commit against each
// language's own toolchain (tools/grade: Node's resolver and the pinned typescript, Python's PathFinder on uv's Python, rustc's
// dep-info and cargo metadata). Each fixture under tests/fixtures/code-graph/<lang>/ grades 100 % in every class it has; a repo
// with one wrong edge and one missed import shows both, below the bar; the draw is stratified by how and the seed is recorded.
// S4b: `norn-code grade calls` grades definition bounds and call edges (scip-typescript, jedi, rust-analyzer's SCIP): on each fixture
// no definition is wrong, no chosen call edge is wrong and an ambiguous site lists the grader's target among its candidates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { ensurePart, binOf } from '../engine/lib/rustbin.mjs';

const FIX = path.join(import.meta.dirname, 'fixtures', 'code-graph'), GRADERS = path.join(import.meta.dirname, '..', 'tools', 'grade');
const built = ensurePart('code', { err: s => process.stderr.write(s + '\n') });
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
/** a folder committed into its own repo -> { repo, state } */
function repoOf(src, files = null) {
  const d = mkTmp('cg-grade-'), repo = path.join(d, 'repo');
  if (src) { fs.cpSync(src, repo, { recursive: true }); fs.rmSync(path.join(repo, 'expected.json')); }
  for (const [f, text] of Object.entries(files || {})) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); }
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture');
  return { repo, state: path.join(d, 'state') };
}
const grade = ({ repo, state }, ...extra) => gradeAt('files', { repo, state }, ...extra);
const gradeAt = (level, { repo, state }, ...extra) => {
  const r = spawnSync(binOf('code'), ['grade', level, '--graders', GRADERS, '--repo', repo, '--state', state, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  const j = JSON.parse(r.stdout); assert.ok(j.ok, j.why); return j;
};
const uv = spawnSync('uv', ['--version'], { windowsHide: true }).status === 0;
/** the Wilson 95 % interval's low end, computed here from the formula (z = 1.96) */
const wilsonLo = (k, n) => { const z = 1.96, p = k / n, d = 1 + z * z / n; return Math.round(Math.max(0, (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d) * 10000) / 10000; };

test('norn-code is built', () => assert.ok(built.ok, built.why));

const LANGS = { js: ['javascript', 'typescript'], py: ['python'], rs: ['rust'] };
for (const [fx, langs] of Object.entries(LANGS)) {
  test(`grade files on fixture ${fx}: every graded class at 100 % precision and recall, nothing below the bar, the grade file written`, t => {
    const r = repoOf(path.join(FIX, fx)), g = grade(r);
    if (fx === 'py' && !uv) { t.skip('uv is not on PATH: the Python grader reads n/a'); return; }
    assert.deepEqual(g.below_bar, []);
    assert.equal(g.seed, 1);
    assert.equal(g.per_lang, 400);
    for (const l of langs) {
      const L = g.langs[l];
      assert.ok(L, `${l} graded`);
      assert.equal(L.recall.p, 1);
      assert.equal(L.precision.lo, wilsonLo(L.precision.n, L.precision.n));
      for (const [how, c] of Object.entries(L.classes)) {
        assert.equal(c.sampled, c.population, `${l}/${how}: a population under 400 is graded whole`);
        assert.equal(c.fp, 0, `${l}/${how}: ${JSON.stringify(L.disagreements)}`);
        if (c.precision) assert.ok(c.graded === 0 || c.precision.p === 1, `${l}/${how}`);
        assert.equal(c.recall_units, c.recall_hits, `${l}/${how}`);
        // what a grader cannot say has a reason: only Python's Rust extension modules here
        assert.deepEqual(Object.keys(c.na), l === 'python' && ['config', 'name'].includes(how) ? ['a Rust extension module: PathFinder has no source file for it'] : [], `${l}/${how}`);
      }
      for (const how of ['exact', 'probed', 'config', 'ambiguous'].filter(h => L.classes[h] && !(l === 'python' && h === 'config'))) assert.ok(L.classes[how].graded > 0, `${l}/${how} graded`);
    }
    if (fx === 'js') assert.equal(g.langs.javascript.dynamic, 2);
    const file = path.join(r.state, 'code', 'grade', `${g.commit}.json`);
    const { file: _, ...stored } = g;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), stored);
  });
}

test('a wrong edge and a missed import: the class and the language read below the bar, each disagreement named', () => {
  const r = repoOf(null, { 'package.json': '{ "name": "bad" }\n', 'src/main.cjs': "const t = require('./thing');\nconst d = require('./data');\n", 'src/thing.ts': 'export const a = 1;\n', 'src/thing.js': 'module.exports = 1;\n', 'src/data.json': '{}\n' });
  const g = grade(r), L = g.langs.javascript;
  assert.deepEqual(g.below_bar, ['javascript/file/ambiguous', 'javascript/file recall']);
  assert.deepEqual([L.classes.ambiguous.tp, L.classes.ambiguous.fp, L.classes.unresolved.missed], [0, 1, 1]);
  assert.deepEqual(L.disagreements.map(d => [d.spec, d.ours, d.grader]), [['./thing', 'src/thing.ts', ['src/thing.js']], ['./data', null, ['src/data.json']]]);
});

test('the draw: stratified by how (equal shares, a small stratum whole), the seed recorded, the same seed the same grade', () => {
  const r = repoOf(path.join(FIX, 'js')), a = grade(r, '--per-lang', '12', '--seed', '7'), b = grade(r, '--per-lang', '12', '--seed', '7');
  assert.equal(a.seed, 7);
  const sampled = Object.fromEntries(Object.entries(a.langs.javascript.classes).map(([h, c]) => [h, c.sampled]));
  assert.deepEqual(sampled, { ambiguous: 1, config: 3, exact: 3, external: 2, probed: 2, unresolved: 1 });
  const strip = ({ graded_at, ...g }) => g;
  assert.deepEqual(strip(a), strip(b));
});

for (const [fx, langs] of Object.entries(LANGS)) {
  test(`grade calls on fixture ${fx}: no definition wrong, no chosen call edge wrong, an ambiguous site contains the target, the grade file written`, t => {
    if (fx === 'py' && !uv) { t.skip('uv is not on PATH: jedi reads n/a'); return; }
    const r = repoOf(path.join(FIX, fx)), g = gradeAt('calls', r);
    assert.equal(g.level, 'calls');
    assert.deepEqual(g.below_bar, []);
    for (const l of langs) {
      const L = g.langs[l];
      assert.ok(L && L.na === null, `${l} graded`);
      for (const [kind, c] of Object.entries(L.defs.classes)) assert.equal(c.wrong, 0, `${l}/def/${kind}: ${JSON.stringify(L.defs.disagreements)}`);
      assert.ok(Object.values(L.defs.classes).some(c => c.graded > 0), `${l} defs graded`);
      assert.equal(L.defs.recall.p, 1, `${l} def recall: ${JSON.stringify(L.defs.missed)}`);
      for (const [how, c] of Object.entries(L.calls.classes)) {
        if (c.graded !== undefined) assert.equal(c.fp, 0, `${l}/call/${how}: ${JSON.stringify(L.calls.disagreements)}`);
        if (how === 'ambiguous') assert.equal(c.contains, c.recall_units, 'an ambiguous site lists the grader target among its candidates');
      }
      if (l !== 'typescript') for (const how of ['local', 'import', 'self']) assert.ok(L.calls.classes[how].graded > 0, `${l}/call/${how} graded`);
    }
    const file = path.join(r.state, 'code', 'grade', `${g.commit}.calls.json`);
    const { file: _, ...stored } = g;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), stored);
  });
}

// S6: rust-analyzer gives two same-named fns nested in sibling fns ONE symbol (the grader then names the first for every call of
// either): such a site is n/a with the reason, not a wrong edge. A closure shadowing an import is no import edge. cargo, run by
// rust-analyzer, writes a Cargo.lock into a lockless workspace: grade calls indexes a copy, the checkout stays as committed.
test('grade calls on Rust: a symbol of several definitions is n/a, a shadowed import no wrong edge, no Cargo.lock written into the repo', () => {
  const lib = ['mod shape {', '    pub fn surface() -> f64 {', '        1.0', '    }', '}', 'use shape::surface;', '',
    'pub fn bed(a: f64) -> f64 {', '    let surface = |q: f64| q * 2.0;', '    surface(a)', '}', '', 'pub fn top() -> f64 {', '    surface()', '}', '',
    'pub fn first() -> u32 {', '    fn calls(n: u32) -> u32 {', '        if n == 0 { 0 } else { calls(n - 1) }', '    }', '    calls(3)', '}', '',
    'pub fn second() -> u32 {', '    fn calls(n: u32) -> u32 {', '        if n == 0 { 1 } else { calls(n - 1) }', '    }', '    calls(2)', '}', ''].join('\n');
  const r = repoOf(null, { 'Cargo.toml': '[package]\nname = "shadow"\nversion = "0.1.0"\nedition = "2021"\n', 'src/lib.rs': lib }), g = gradeAt('calls', r), C = g.langs.rust.calls.classes;
  for (const [how, c] of Object.entries(C)) if (c.graded !== undefined) assert.equal(c.fp, 0, `rust/call/${how}: ${JSON.stringify(g.langs.rust.calls.disagreements)}`);
  assert.equal(C.local.na["the grader's symbol has several definitions (same-named items in sibling fns): no one target"], 4);
  assert.equal(C.import.tp, 1);
  assert.equal(fs.existsSync(path.join(r.repo, 'Cargo.lock')), false, 'no Cargo.lock in the checkout');
  assert.equal(git(r.repo, 'status', '--porcelain'), '');
});
