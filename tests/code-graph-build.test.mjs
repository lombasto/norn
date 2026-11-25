// code-graph S1a / S2 (SPEC code-graph section 9): norn-code (engine/code-rs) built by rustbin.mjs, its file-level extraction for
// JavaScript / TypeScript, Python and Rust, and the store. Each fixture under tests/fixtures/code-graph/<lang>/ is committed into a
// fresh repo; `norn-code index` must write a tree snapshot whose edges, unresolved imports and files equal its expected.json, `how`
// and `kind` included. A second commit that changes one file parses exactly that one blob. rustbin's checks run on a fake crate dir.
// S2: `query symbols` per file equals expected.json defs (bounds, qual, exported); the body hash matches a renamed copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { ensurePart, partProblem, binOf, ccProblem, CODE_STORE_SCHEMA } from '../engine/lib/rustbin.mjs';

const FIX = path.join(import.meta.dirname, 'fixtures', 'code-graph');
const built = ensurePart('code', { err: s => process.stderr.write(s + '\n') });
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
/** a fixture committed into its own repo -> { repo, state } */
function repoOf(lang) {
  const d = mkTmp(`cg-${lang}-`), repo = path.join(d, 'repo');
  fs.cpSync(path.join(FIX, lang), repo, { recursive: true });
  fs.rmSync(path.join(repo, 'expected.json'));
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture');
  return { repo, state: path.join(d, 'graph-state') };
}
const code = (...a) => { const r = spawnSync(binOf('code'), a, { encoding: 'utf8', windowsHide: true }); const j = JSON.parse(r.stdout); assert.ok(j.ok !== false, j.why); return j; };
const index = ({ repo, state }, ...extra) => code('index', '--repo', repo, '--state', state, ...extra);
const snapshot = (state, tree) => JSON.parse(fs.readFileSync(path.join(state, 'code', 'graph', 'trees', `v${CODE_STORE_SCHEMA}`, `${tree}.json`), 'utf8'));

test('norn setup\'s build of norn-code: built, fresh, and its version names the store schema this engine reads', () => {
  assert.ok(built.ok, built.why);
  assert.equal(partProblem('code'), null);
  assert.deepEqual(code('version'), { crate: '0.1.0', store_schema: CODE_STORE_SCHEMA });
});

for (const lang of ['js', 'py', 'rs']) {
  test(`norn-code index on fixture ${lang}: the snapshot's edges, unresolved imports and files equal expected.json`, () => {
    const r = repoOf(lang), out = index(r);
    const s = snapshot(r.state, out.tree), want = JSON.parse(fs.readFileSync(path.join(FIX, lang, 'expected.json'), 'utf8'));
    assert.equal(s.commit, out.commit);
    assert.deepEqual(s.edges, want.edges);
    assert.deepEqual(s.unresolved, want.unresolved);
    assert.deepEqual(s.files, want.files);
  });
}

test('a commit that changes one file parses exactly that blob; the same tree again comes from the store, unparsed', () => {
  const r = repoOf('rs'), first = index(r);
  assert.equal(first.parsed, first.counts.sources);
  fs.appendFileSync(path.join(r.repo, 'crates', 'util', 'src', 'text.rs'), 'pub fn whisper() {}\n');
  git(r.repo, 'commit', '-qam', 'one file');
  const second = index(r);
  assert.equal(second.parsed, 1);
  assert.equal(second.reused, first.counts.sources - 1);
  assert.notEqual(second.tree, first.tree);
  const again = index(r, '--at', 'HEAD~1');
  assert.equal(again.cached, true);
  assert.equal(again.parsed, 0);
  const commits = JSON.parse(fs.readFileSync(path.join(r.state, 'code', 'graph', 'commits.json'), 'utf8'));
  assert.deepEqual(commits.map(c => c.commit), [first.commit, second.commit]);
  assert.equal(fs.readFileSync(path.join(r.state, 'code', 'graph', 'HEAD'), 'utf8').trim(), second.commit);
});

test('--worktree resolves uncommitted work over HEAD in memory: stamped, the changed files listed, no snapshot stored', () => {
  const r = repoOf('js'), base = index(r);
  fs.writeFileSync(path.join(r.repo, 'src', 'fresh.mjs'), "import { a } from './a.mjs';\n");
  const w = index(r, '--worktree');
  assert.equal(w.worktree, true);
  assert.deepEqual(w.changed, ['src/fresh.mjs']);
  assert.equal(w.parsed, 1);
  assert.equal(w.tree, base.tree);
  assert.ok(w.snapshot.edges.some(e => e.from === 'src/fresh.mjs' && e.to === 'src/a.mjs' && e.how === 'exact'));
  assert.deepEqual(fs.readdirSync(path.join(r.state, 'code', 'graph', 'trees', `v${CODE_STORE_SCHEMA}`)).filter(f => f.endsWith('.json')), [`${base.tree}.json`]);
});

test('rustbin names a missing, a stale and a wrong-schema norn-code, and a build without a C compiler names the install', () => {
  const d = mkTmp('cg-part-'), src = path.join(d, 'code-rs'), exe = path.join(src, 'target', 'release', 'norn-code');
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Cargo.lock'), '');
  const says = schema => () => ({ status: 0, stdout: JSON.stringify({ crate: '0.1.0', store_schema: schema }) });
  assert.match(partProblem('code', { src, exe, run: says(CODE_STORE_SCHEMA) }), /^norn-code is not built \(/);
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
  const old = new Date(Date.now() - 60000); fs.utimesSync(exe, old, old);
  assert.match(partProblem('code', { src, exe, run: says(CODE_STORE_SCHEMA) }), /^norn-code is older than its source \(/);
  fs.utimesSync(exe, new Date(), new Date());
  assert.equal(partProblem('code', { src, exe, run: says(CODE_STORE_SCHEMA) }), null);
  assert.match(partProblem('code', { src, exe, run: says(CODE_STORE_SCHEMA + 1) }), /answers store_schema \d+, this engine reads/);
  fs.rmSync(exe);
  const r = ensurePart('code', { src, exe, cc: () => 'no C compiler found (x): install y', run: () => assert.fail('no cargo without a C compiler') });
  assert.equal(r.ok, false);
  assert.match(r.why, /^norn-code \(the code graph \(docs\/code-graph\.md\)\) cannot build: no C compiler found .*then run cargo build --release --locked /);
  assert.match(ccProblem({ env: { PATH: '' }, platform: 'linux', osRelease: 'ID=ubuntu\n' }), /install sudo apt-get install build-essential$/);
  assert.equal(ccProblem({ env: { PATH: '', CC: 'zig cc' }, platform: 'linux' }), null);
});

for (const lang of ['js', 'py', 'rs']) {
  test(`norn-code query symbols on fixture ${lang}: each file's definitions, exact line..end_line, equal expected.json defs`, () => {
    const r = repoOf(lang), want = JSON.parse(fs.readFileSync(path.join(FIX, lang, 'expected.json'), 'utf8')).defs;
    for (const [file, defs] of Object.entries(want)) {
      const got = code('query', 'symbols', '--file', file, '--repo', r.repo, '--state', r.state);
      assert.equal(got.file, file);
      assert.deepEqual(got.defs.map(({ id, name, qual, kind, line, end_line, col, exported }) => ({ id, name, qual, kind, line, end_line, col, exported })), defs, file);
      assert.ok(got.defs.every(d => d.file === file && /^[0-9a-f]{16}$/.test(d.hash) && d.tokens > 0), file);
    }
  });
}

test('the body hash leaves out comments and the def\'s own name: helper and its renamed copy share it, a different body does not', () => {
  const r = repoOf('js'), defs = code('query', 'symbols', '--file', 'src/shapes.mjs', '--repo', r.repo, '--state', r.state).defs, by = n => defs.find(d => d.name === n);
  assert.equal(by('helper').hash, by('copy').hash);
  assert.notEqual(by('helper').hash, by('twice').hash);
});
