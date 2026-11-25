// code-graph S1a / S2 (SPEC code-graph section 9): norn-code (engine/code-rs) built by rustbin.mjs, its file-level extraction for
// JavaScript / TypeScript, Python and Rust, and the store. Each fixture under tests/fixtures/code-graph/<lang>/ is committed into a
// fresh repo; `norn-code index` must write a tree snapshot whose edges, unresolved imports and files equal its expected.json, `how`
// and `kind` included. A second commit that changes one file parses exactly that one blob. rustbin's checks run on a fake crate dir.
// S2: `query symbols` per file equals expected.json defs (bounds, qual, exported); the body hash matches a renamed copy. S3: `query calls`
// per call fixture equals expected.json calls (how, candidates, targets), and the fixtures cover every how class.
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
  // NORN-RUST-FRESH: a binary is named by its source content (binOf), so a stale one is a binary not built for its source
  const d = mkTmp('cg-part-'), src = path.join(d, 'code-rs');
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Cargo.lock'), '');
  const says = schema => () => ({ status: 0, stdout: JSON.stringify({ crate: '0.1.0', store_schema: schema }) });
  assert.match(partProblem('code', { src, exe: path.join(d, 'x'), run: says(CODE_STORE_SCHEMA) }), /^norn-code's source is missing \(/);
  fs.writeFileSync(path.join(src, 'Cargo.toml'), '[package]\n');
  const exe = binOf('code', { src, store: d });
  assert.match(partProblem('code', { src, exe, run: says(CODE_STORE_SCHEMA) }), /^norn-code is not built for its source \(/);
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, '');
  assert.equal(partProblem('code', { src, exe, run: says(CODE_STORE_SCHEMA) }), null);
  fs.writeFileSync(path.join(src, 'src', 'main.rs'), 'fn main() {}\n');
  assert.notEqual(binOf('code', { src, store: d }), exe, 'a changed source names another binary: the old one is stale');
  assert.match(partProblem('code', { src, exe, run: says(CODE_STORE_SCHEMA + 1) }), /answers store_schema \d+, this engine reads/);
  fs.rmSync(exe);
  const r = ensurePart('code', { src, exe, cc: () => 'no C compiler found (x): install y', run: () => assert.fail('no cargo without a C compiler') });
  assert.equal(r.ok, false);
  assert.match(r.why, /^norn-code \(the code graph \(docs\/code-graph\.md\)\) cannot build: no C compiler found .*; build command: cargo build --release --locked /);
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

// S3: each fixture's calls file resolves call site by call site as expected.json `calls` says, and together the fixtures hold every
// how class of the call table (SPEC 4.2), an ambiguous site with its full list and an external one included
const HOW_CLASSES = ['local', 'import', 'qualified', 'self', 'method-unique', 'ambiguous', 'external'];
for (const lang of ['js', 'py', 'rs']) {
  test(`norn-code query calls on fixture ${lang}: every call site's how, candidate count and targets equal expected.json calls`, () => {
    const r = repoOf(lang), want = JSON.parse(fs.readFileSync(path.join(FIX, lang, 'expected.json'), 'utf8')).calls;
    for (const [file, calls] of Object.entries(want)) {
      const got = code('query', 'calls', '--file', file, '--repo', r.repo, '--state', r.state);
      assert.deepEqual(got.calls.map(({ line, col, name, how, candidates, targets }) => ({ line, col, name, how, candidates, targets })), calls, file);
      assert.ok(got.calls.every(c => (c.how === 'external' || c.how === 'unresolved') === (c.candidates === 0) && typeof c.why === (c.candidates ? 'undefined' : 'string')), file);
      const amb = calls.filter(c => c.how === 'ambiguous');
      assert.ok(amb.length && amb.every(c => c.candidates > 1 && c.targets.length === c.candidates), `${file}: an ambiguous site keeps its whole list`);
    }
  });
}
test('the call fixtures together cover every how class of the call table', () => {
  const seen = new Set(['js', 'py', 'rs'].flatMap(l => Object.values(JSON.parse(fs.readFileSync(path.join(FIX, l, 'expected.json'), 'utf8')).calls).flat().map(c => c.how)));
  for (const h of HOW_CLASSES) assert.ok(seen.has(h), `no fixture call site is ${h}`);
});

/** files committed into their own repo -> { repo, state } */
function repoFiles(files) {
  const d = mkTmp('cg-inline-'), repo = path.join(d, 'repo');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); }
  git(repo, 'init', '-q'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'fixture');
  return { repo, state: path.join(d, 'graph-state') };
}
const sitesOf = (r, file) => code('query', 'calls', '--file', file, '--repo', r.repo, '--state', r.state).calls;

// S6 (S4b grade: JS method-unique below bar): `x.f()` matched by name to the one repo method f stays method-unique only when x's local
// binding does not say it is another value; else it is ambiguous with that one candidate and the why
const RECV = {
  'package.json': '{ "name": "recv", "type": "module" }\n',
  'src/lock.mjs': 'export function startRun() {\n  return { release() { return 1; } };\n}\nexport class Pool {\n  drain() { return 0; }\n}\n',
  'src/use.mjs': [
    "import http from 'node:http';",
    "import { startRun, Pool } from './lock.mjs';",
    'function rig() { return { n: 1 }; }',
    'export function main(x, acquire) {',
    '  const lit = { n: 2 };',
    '  lit.release();',
    '  const g = rig();',
    '  g.release();',
    '  const run = startRun();',
    '  run.release();',
    '  const srv = http.createServer();',
    '  srv.drain();',
    '  const p = new Pool();',
    '  p.drain();',
    '  const m = new Map();',
    '  m.drain();',
    '  let lock;',
    '  lock = acquire();',
    '  lock.release();',
    '  x.release();',
    '  const y = x;',
    '  y.drain();',
    '}',
    '',
  ].join('\n'),
  'src/typed.ts': "import type { Server } from 'node:http';\nimport { Pool } from './lock.mjs';\nexport function stop(s: Server, q: Pool) {\n  s.drain();\n  q.drain();\n}\n",
};
test('JS method-unique: kept for an unknown receiver or one bound to the owner; a literal, another call\'s result, a package or non-repo value is ambiguous', () => {
  const r = repoFiles(RECV);
  index(r);
  const pick = (file, names) => sitesOf(r, file).filter(c => names.includes(c.name)).map(c => [c.line, c.name, c.how, c.candidates, c.why ?? null]);
  const amb = why => ['ambiguous', 1, why];
  assert.deepEqual(pick('src/use.mjs', ['release', 'drain']), [
    [6, 'release', ...amb('receiver lit holds a literal, not an object of startRun')],
    [8, 'release', ...amb('receiver g is the result of rig, not of startRun')],
    [10, 'release', 'method-unique', 1, null],
    [12, 'drain', ...amb('receiver srv is the result of http.createServer, not of Pool')],
    [14, 'drain', 'method-unique', 1, null],
    [16, 'drain', ...amb('receiver m is a new Map, not an object of Pool')],
    [19, 'release', ...amb('receiver lock is the result of acquire, not of startRun')],
    [20, 'release', 'method-unique', 1, null],
    [22, 'drain', 'method-unique', 1, null],
  ]);
  assert.deepEqual(pick('src/typed.ts', ['drain']), [[4, 'drain', ...amb('receiver s is typed Server, not an object of Pool')], [5, 'drain', 'method-unique', 1, null]]);
});

// S6 (S4b grade on a Rust tree): a local variable (a closure, a fn pointer parameter) shadows an import of its name; a fn nested in a
// fn is local to it, never to its sibling's nested fn of the same name
const SHADOW = {
  'Cargo.toml': '[package]\nname = "shadow"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': [
    'mod shape {',
    '    pub fn surface() -> f64 {',
    '        1.0',
    '    }',
    '}',
    'use shape::surface;',
    '',
    'pub fn bed(a: f64) -> f64 {',
    '    let surface = |q: f64| q * 2.0;',
    '    surface(a)',
    '}',
    '',
    'pub fn top() -> f64 {',
    '    surface()',
    '}',
    '',
    'pub fn param(surface: fn() -> f64) -> f64 {',
    '    surface()',
    '}',
    '',
    'pub fn first() -> u32 {',
    '    fn calls(n: u32) -> u32 {',
    '        if n == 0 { 0 } else { calls(n - 1) }',
    '    }',
    '    calls(3)',
    '}',
    '',
    'pub fn second() -> u32 {',
    '    fn calls(n: u32) -> u32 {',
    '        if n == 0 { 1 } else { calls(n - 1) }',
    '    }',
    '    calls(2)',
    '}',
    '',
  ].join('\n'),
};
test('Rust: a local variable shadows the import of its name; a nested fn resolves inside its own fn, never its sibling\'s', () => {
  const r = repoFiles(SHADOW);
  index(r);
  assert.deepEqual(sitesOf(r, 'src/lib.rs').map(c => [c.line, c.name, c.how, c.targets.join(), c.why ?? null]), [
    [10, 'surface', 'unresolved', '', 'surface is a local variable (a closure or fn pointer), not a definition'],
    [14, 'surface', 'import', 'src/lib.rs#crate::shape::surface#0', null],
    [18, 'surface', 'unresolved', '', 'surface is a local variable (a closure or fn pointer), not a definition'],
    [23, 'calls', 'local', 'src/lib.rs#crate::first::calls#0', null],
    [25, 'calls', 'local', 'src/lib.rs#crate::first::calls#0', null],
    [30, 'calls', 'local', 'src/lib.rs#crate::second::calls#0', null],
    [32, 'calls', 'local', 'src/lib.rs#crate::second::calls#0', null],
  ]);
});

// S7 (S6 follow-up): a Rust `use super::*` / `self::` / `super::` path inside an inline `mod` starts at that inline module, not at the
// file's module: `deposit()` in `mod tests` is the fn of the file, never the parent's `mod deposit`
const INLINE = {
  'Cargo.toml': '[package]\nname = "inline"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': 'pub mod deposit;\n',
  'src/deposit.rs': [
    'pub fn deposit() -> u32 {',
    '    1',
    '}',
    '',
    'mod tests {',
    '    use super::*;',
    '    use self::inner::probe;',
    '',
    '    fn check() -> u32 {',
    '        deposit() + probe()',
    '    }',
    '',
    '    fn path() -> u32 {',
    '        super::deposit() + self::check()',
    '    }',
    '',
    '    mod inner {',
    '        use super::super::deposit as d;',
    '',
    '        pub fn probe() -> u32 {',
    '            d() + super::check()',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n'),
};
test('Rust: super / self inside an inline mod (and a nested one) start at that module and reach the file\'s own definitions', () => {
  const r = repoFiles(INLINE);
  index(r);
  const at = q => `src/deposit.rs#crate::deposit::${q}#0`;
  assert.deepEqual(sitesOf(r, 'src/deposit.rs').map(c => [c.line, c.name, c.how, c.targets.join(), c.why ?? null]), [
    [10, 'deposit', 'import', at('deposit'), null],
    [10, 'probe', 'import', at('tests::inner::probe'), null],
    [14, 'deposit', 'qualified', at('deposit'), null],
    [14, 'check', 'qualified', at('tests::check'), null],
    [21, 'd', 'import', at('deposit'), null],
    [21, 'check', 'qualified', at('tests::check'), null],
  ]);
});
