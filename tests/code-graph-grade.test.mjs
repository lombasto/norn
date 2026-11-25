// code-graph S4a (SPEC code-graph sections 5 and 9): `norn-code grade files` grades the file-level edges of a commit against each
// language's own toolchain (tools/grade: Node's resolver and the pinned typescript, Python's PathFinder on uv's Python, rustc's
// dep-info and cargo metadata). Each fixture under tests/fixtures/code-graph/<lang>/ grades 100 % in every class it has; a repo
// with one wrong edge and one missed import shows both, below the bar; the draw is stratified by how and the seed is recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { ensurePart, ensurePartAsync, binOf, targetOf } from '../engine/lib/rustbin.mjs';

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
const grade = ({ repo, state }, ...extra) => {
  const r = spawnSync(binOf('code'), ['grade', 'files', '--graders', GRADERS, '--repo', repo, '--state', state, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  const j = JSON.parse(r.stdout); assert.ok(j.ok, j.why); return j;
};
const uv = spawnSync('uv', ['--version'], { windowsHide: true }).status === 0;
/** the Wilson 95 % interval's low end, computed here from the formula (z = 1.96) */
const wilsonLo = (k, n) => { const z = 1.96, p = k / n, d = 1 + z * z / n; return Math.round(Math.max(0, (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d) * 10000) / 10000; };

test('norn-code is built', () => assert.ok(built.ok, built.why));

// the binary graded above must be built from THIS checkout's sources: the store's target dir is shared, and cargo, finding another
// checkout's fingerprint of the same package, checks only the files that build listed (a new grade.rs is not among them) and calls
// it fresh - its old binary was then stored under this source's name (Done check RUN-a-2003: every grade call read "usage")
test('a build drops the part\'s own cargo fingerprints first, so another checkout\'s build is never taken as fresh; deps keep theirs', async () => {
  const t = mkTmp('cg-fp-'), src = path.join(t, 'engine', 'hook-rs'), store = path.join(t, 'store'), fp = path.join(targetOf('hook', store), 'release', '.fingerprint');
  fs.mkdirSync(path.join(src, 'src'), { recursive: true }); fs.writeFileSync(path.join(src, 'Cargo.toml'), '[package]\nname = "norn-hook"\n'); fs.writeFileSync(path.join(src, 'src', 'main.rs'), 'fn main() {}\n');
  for (const d of ['norn-hook-18ae1f6be3a3883e', 'norn-hook-0123456789abcdef', 'serde-0123456789abcdef']) fs.mkdirSync(path.join(fp, d), { recursive: true });
  const seen = [], exe = process.platform === 'win32' ? '.exe' : '';
  const cargo = async args => { seen.push(fs.readdirSync(fp).sort()); const out = path.join(args[args.indexOf('--target-dir') + 1], 'release'); fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'norn-hook' + exe), 'bin'); return { status: 0, stdout: '', stderr: '' }; };
  assert.deepEqual(await ensurePartAsync('hook', { src, store, cargo }), { ok: true, built: true });
  assert.deepEqual(seen, [['serde-0123456789abcdef']]);
});

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
