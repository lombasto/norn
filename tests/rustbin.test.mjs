// NORN-RUST-FRESH: Norn's Rust parts are named by their source content in one store every checkout of the clone shares, and built
// (rustbin.mjs ensurePart / ensurePartAsync / ensureParts) when missing; one that cannot be had is ONE reason naming the part, the
// cause and the build command. Fake crate dirs and an injected cargo, but for the last test: real cargo builds a tiny crate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { RUST_PARTS, storeOf, sourceHash, binOf, partsOf, partProblem, ensurePart, ensurePartAsync, ensureParts, targetOf, lockOf, graphReads, BUILD_MS, CODE_STORE_SCHEMA } from '../engine/lib/rustbin.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const EXE = process.platform === 'win32' ? '.exe' : '';
/** a fake Norn checkout at `root`: engine/<dir>/Cargo.toml + src/main.rs (and a target/ the hash must ignore) */
function checkout(root, { dirs = ['hook-rs'], main = 'fn main() {}\n' } = {}) {
  for (const d of dirs) {
    const c = path.join(root, 'engine', d);
    fs.mkdirSync(path.join(c, 'src'), { recursive: true }); fs.mkdirSync(path.join(c, 'target', 'release'), { recursive: true });
    fs.writeFileSync(path.join(c, 'Cargo.toml'), '[package]\nname = "x"\n'); fs.writeFileSync(path.join(c, 'src', 'main.rs'), main);
  }
  return path.join(root, 'engine');
}
// an injected cargo: records its args; a build writes <target-dir>/release/<bin> as a real build would, a clean succeeds
const fakeCargo = (bin, calls) => async args => { calls.push(args); if (args[0] === 'clean') return { status: 0, stdout: '', stderr: '' }; const t = args[args.indexOf('--target-dir') + 1]; fs.mkdirSync(path.join(t, 'release'), { recursive: true }); fs.writeFileSync(path.join(t, 'release', bin + EXE), 'bin'); return { status: 0, stdout: '', stderr: '' }; };
const noCargo = () => assert.fail('a fresh part costs no build');

test('storeOf: the main checkout and each of its worktrees share <git common dir>/norn/rust; no git = the root\'s own', () => {
  const t = mkTmp('rb-store-'), main = path.join(t, 'main'), wt = path.join(t, 'wt'), gd = path.join(main, '.git', 'worktrees', 'wt');
  fs.mkdirSync(gd, { recursive: true }); fs.mkdirSync(path.join(wt, 'engine'), { recursive: true }); fs.mkdirSync(path.join(main, 'engine'));
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gd}\n`); fs.writeFileSync(path.join(gd, 'commondir'), '../..\n');
  assert.equal(storeOf(path.join(main, 'engine')), path.join(main, '.git', 'norn', 'rust'));
  assert.equal(storeOf(path.join(wt, 'engine')), path.join(main, '.git', 'norn', 'rust'));
  const bare = path.join(t, 'bare'); fs.mkdirSync(path.join(bare, 'engine'), { recursive: true });
  assert.equal(storeOf(path.join(bare, 'engine')), path.join(bare, '.norn', 'rust'));
});

test('sourceHash: the same sources = the same binary name whatever the folder; a changed file = another; target/ does not count', () => {
  const t = mkTmp('rb-hash-'), a = checkout(path.join(t, 'a')), b = checkout(path.join(t, 'b')), src = d => path.join(d, 'hook-rs');
  assert.equal(sourceHash(src(a)), sourceHash(src(b)));
  assert.equal(path.basename(binOf('hook', { src: src(a), store: t })), path.basename(binOf('hook', { src: src(b), store: t })));
  fs.writeFileSync(path.join(src(b), 'target', 'release', 'junk'), 'x');
  assert.equal(sourceHash(src(a)), sourceHash(src(b)), 'target/ is no source');
  fs.writeFileSync(path.join(src(b), 'src', 'main.rs'), 'fn main() { }\n');
  assert.notEqual(sourceHash(src(a)), sourceHash(src(b)), 'a pull that changes the part names a new binary');
  assert.equal(sourceHash(path.join(t, 'none')), 'nosource');
});

test('partsOf: a Norn worktree adds its own engine\'s parts; a project worktree adds none', () => {
  const t = mkTmp('rb-parts-'), eng = checkout(path.join(t, 'wt'), { dirs: ['hook-rs', 'code-rs'] });
  const l = partsOf({ parts: [], worktree: path.join(t, 'wt') });
  assert.deepEqual(l.map(x => x.p), ['hook', 'code']);
  assert.equal(l[0].src, path.join(eng, 'hook-rs')); assert.equal(l[0].store, storeOf(eng));
  assert.equal(l[0].exe, binOf('hook', { src: path.join(eng, 'hook-rs'), store: storeOf(eng) }));
  fs.mkdirSync(path.join(t, 'project'));
  assert.deepEqual(partsOf({ parts: [], worktree: path.join(t, 'project') }), []);
});

test('ensurePartAsync: a missing part is built into the store\'s target dir and stored under its hash; a fresh one costs no build', async () => {
  const t = mkTmp('rb-build-'), src = path.join(checkout(path.join(t, 'wt')), 'hook-rs'), store = path.join(t, 'store'), calls = [];
  const exe = binOf('hook', { src, store });
  assert.match(partProblem('hook', { src, exe }), /^norn-hook is not built for its source \(/);
  const r = await ensurePartAsync('hook', { src, store, cargo: fakeCargo('norn-hook', calls) });
  assert.deepEqual(r, { ok: true, built: true });
  assert.deepEqual(calls, ['clean', 'build'].map(c => [c, ...(c === 'clean' ? ['-p', 'norn-hook', '--release'] : ['--release', '--locked']), '--target-dir', targetOf('hook', store), '--manifest-path', path.join(src, 'Cargo.toml')]),
    'the clean of the package by cargo itself, then the build: no layout of the target dir assumed');
  assert.equal(fs.readFileSync(exe, 'utf8'), 'bin');
  assert.equal(partProblem('hook', { src, exe }), null);
  assert.deepEqual(await ensurePartAsync('hook', { src, store, cargo: noCargo }), { ok: true, built: false });
  assert.deepEqual(ensurePart('hook', { src, store, run: noCargo }), { ok: true, built: false }, 'the sync form reads the same store');
});

test('ensurePartAsync: cargo absent, a failed build and no C compiler are each ONE reason naming the part, the cause and the build command', async () => {
  const t = mkTmp('rb-fail-'), eng = checkout(path.join(t, 'wt'), { dirs: ['hook-rs', 'code-rs'] }), store = path.join(t, 'store');
  const src = path.join(eng, 'hook-rs'), cmd = /build command: cargo build --release --locked --target-dir "[^"]+\/target\/hook" --manifest-path "[^"]+\/hook-rs\/Cargo\.toml"$/;
  const absent = await ensurePartAsync('hook', { src, store, cargo: async () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn cargo ENOENT'), { code: 'ENOENT' }) }) });
  assert.equal(absent.ok, false); assert.equal(absent.part, 'hook');
  assert.match(absent.why, /^norn-hook \(the per-tool-call hooks of every claude run\) cannot build: cargo is not on PATH \(install Rust: https:\/\/rustup\.rs\); /);
  assert.match(absent.why, cmd);
  const errs = [];
  const failed = await ensurePartAsync('hook', { src, store, err: s => errs.push(s), cargo: async a => a[0] === 'clean' ? { status: 0 } : ({ status: 101, stdout: '', stderr: '   Compiling norn-hook\nerror: failed to remove file `x\\norn-hook.exe`\n\nCaused by:\n  Access is denied. (os error 5)\n' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.why, /^norn-hook \(.*\) did not build \(cargo exit 101: error: failed to remove file `x\\norn-hook\.exe`\); /);
  assert.match(failed.why, cmd);
  assert.match(errs.join('\n'), /Access is denied/, 'cargo\'s own output goes to err');
  assert.equal(fs.existsSync(binOf('hook', { src, store })), false, 'a failed build stores nothing');
  const unclean = await ensurePartAsync('hook', { src, store, cargo: async a => a[0] === 'clean' ? { status: 101, stdout: '', stderr: 'error: x is locked\n' } : assert.fail('no build after a failed clean') });
  assert.match(unclean.why, /^norn-hook \(.*\) did not build \(cargo clean exit 101: error: x is locked\); clean command: cargo clean -p norn-hook --release --target-dir "[^"]+\/target\/hook" --manifest-path "[^"]+\/hook-rs\/Cargo\.toml"; /);
  assert.match(unclean.why, cmd, 'a failed clean is the ONE reason, like a failed build');
  const csrc = path.join(eng, 'code-rs');
  const noCc = await ensurePartAsync('code', { src: csrc, store, cc: () => 'no C compiler found (x): install y', cargo: () => assert.fail('no cargo without a C compiler') });
  assert.match(noCc.why, /^norn-code \(the code graph \(docs\/code-graph\.md\)\) cannot build: no C compiler found \(x\): install y; build command: cargo build /);
});

test('ensurePartAsync: a built norn-code is asked its store schema; a wrong one is the reason', async () => {
  const t = mkTmp('rb-schema-'), src = path.join(checkout(path.join(t, 'wt'), { dirs: ['code-rs'] }), 'code-rs'), store = path.join(t, 'store');
  const says = n => () => ({ status: 0, stdout: JSON.stringify({ ok: true, store_schema: n }) + '\n' });
  const ok = await ensurePartAsync('code', { src, store, cc: () => null, run: says(CODE_STORE_SCHEMA), cargo: fakeCargo('norn-code', []) });
  assert.deepEqual(ok, { ok: true, built: true });
  const bad = partProblem('code', { src, exe: binOf('code', { src, store }), run: says(CODE_STORE_SCHEMA - 1) });
  assert.match(bad, new RegExp(`answers store_schema ${CODE_STORE_SCHEMA - 1}, this engine reads ${CODE_STORE_SCHEMA}$`));
});

test('ensureParts: every part in order, what was built named; the first that cannot be had is the ONE reason and stops the list', async () => {
  const t = mkTmp('rb-list-'), wt = path.join(t, 'wt'); checkout(wt, { dirs: ['hook-rs', 'code-rs'] });
  const list = partsOf({ parts: [], worktree: wt }), calls = [];
  const r = await ensureParts(list.slice(0, 1), { cargo: fakeCargo('norn-hook', calls) });
  assert.deepEqual(r, { ok: true, built: [list[0].exe.split(path.sep).join('/')] });
  const seen = [];
  const f = await ensureParts(list, { cc: () => 'no C compiler found (x): install y', cargo: async a => { seen.push(a); return { status: 0 }; } });
  assert.equal(f.ok, false); assert.equal(f.part, 'code'); assert.match(f.why, /^norn-code .* cannot build: no C compiler found/);
  assert.deepEqual(f.built, [], 'the hook was fresh: no build');
  assert.equal(seen.length, 0);
});

test('graphReads: the ONE condition for norn-code - an `imports` rule with a root the worktree holds; no such root or rule = no graph', () => {
  const t = mkTmp('rb-reads-'), k10 = { id: 'K10', kind: 'imports', roots: ['engine/'] }, other = { id: 'K15', kind: 'names', roots: ['engine/'] };
  assert.equal(graphReads([other, k10], t), false, 'the worktree holds no root');
  fs.mkdirSync(path.join(t, 'engine'));
  assert.equal(graphReads([other, k10], t), true);
  assert.equal(graphReads([other], t), false, 'no imports rule');
  assert.equal(graphReads([{ id: 'P-x', kind: 'imports' }], t), false, 'an imports rule without roots');
});

test('ensurePartAsync / ensurePart: start(p) is said once before cargo runs, never for a fresh part', async () => {
  const t = mkTmp('rb-start-'), src = path.join(checkout(path.join(t, 'wt')), 'hook-rs'), store = path.join(t, 'store'), said = [], calls = [];
  const cargo = fakeCargo('norn-hook', calls), seen = args => { assert.deepEqual(said, ['hook'], 'said before cargo'); return cargo(args); };
  assert.deepEqual(await ensurePartAsync('hook', { src, store, start: p => said.push(p), cargo: seen }), { ok: true, built: true });
  assert.deepEqual(said, ['hook']);
  await ensurePartAsync('hook', { src, store, start: p => said.push(p), cargo: noCargo });
  ensurePart('hook', { src, store, start: p => said.push(p), run: noCargo });
  assert.deepEqual(said, ['hook'], 'a fresh part: nothing said');
  const s2 = path.join(checkout(path.join(t, 'wt2'), { main: 'fn main() { }\n' }), 'hook-rs'), sync = [];
  ensurePart('hook', { src: s2, store, start: p => sync.push(p), run: (c, a) => { assert.deepEqual(sync, ['hook']); const d = a[a.indexOf('--target-dir') + 1]; fs.mkdirSync(path.join(d, 'release'), { recursive: true }); fs.writeFileSync(path.join(d, 'release', 'norn-hook' + EXE), 'b'); return { status: 0 }; } });
  assert.deepEqual(sync, ['hook'], 'the sync form says it too');
});

// NORN-DONE-FRESH S2, S3: a fake cargo that models the store's shared target dir as cargo 1.100 was measured: ONE output file
// <target>/release/norn-hook for every checkout's sources, and ONE build state of the package whatever its source path
// (<target>/release/build/norn-hook/<hash>/) - while it is there a build reads "fresh" and leaves the output as it is; `clean -p` drops
// it; else the build's output = the built source's main.rs, and the state is written. The real-cargo test below proves the real thing
function sharedCargo(log = []) {
  return args => {
    const t = args[args.indexOf('--target-dir') + 1], src = path.dirname(args[args.indexOf('--manifest-path') + 1]);
    const rel = path.join(t, 'release'), st = path.join(rel, 'build', 'norn-hook');
    if (args[0] === 'clean') { fs.rmSync(st, { recursive: true, force: true }); return { status: 0, stdout: '', stderr: '' }; }
    const fresh = fs.existsSync(st);
    log.push(`${path.basename(path.dirname(path.dirname(src)))} ${fresh ? 'fresh' : 'built'}`);
    if (!fresh) { fs.mkdirSync(path.join(st, '0123456789abcdef'), { recursive: true }); fs.writeFileSync(path.join(rel, 'norn-hook' + EXE), fs.readFileSync(path.join(src, 'src', 'main.rs'))); }
    return { status: 0, stdout: '', stderr: '' };
  };
}
/** two checkouts a and b of one part with different sources, and one store */
function twoSources(prefix) {
  const t = mkTmp(prefix), store = path.join(t, 'store');
  const [A, B] = ['a', 'b'].map(n => path.join(checkout(path.join(t, n), { main: `// ${n}\n` }), 'hook-rs'));
  return { t, store, A, B, holds: s => fs.readFileSync(binOf('hook', { src: s, store }), 'utf8') };
}
const tick = () => new Promise(res => setImmediate(res));

for (const form of ['sync', 'async']) {
  test(`two sources of one part into one store (${form}): A B A, then A's entry deleted and A again - each entry holds its own source's output`, async () => {
    const { store, A, B, holds } = twoSources('rb-two-'), log = [], cargo = sharedCargo(log);
    const build = s => form === 'sync' ? ensurePart('hook', { src: s, store, run: (c, a) => cargo(a) }) : ensurePartAsync('hook', { src: s, store, cargo: async a => cargo(a) });
    for (const s of [A, B, A]) assert.equal((await build(s)).ok, true);
    assert.equal(holds(A), '// a\n'); assert.equal(holds(B), '// b\n');
    assert.deepEqual(log, ['a built', 'b built'], 'the second A is its stored file: no build');
    fs.rmSync(binOf('hook', { src: A, store }));
    assert.deepEqual(await build(A), { ok: true, built: true });
    assert.equal(holds(A), '// a\n', 'the package was cleaned first: A was built, not called fresh with B\'s output');
    assert.equal(holds(B), '// b\n');
    assert.deepEqual(log, ['a built', 'b built', 'a built']);
  });
}

test('the race: a build of other sources that would replace the shared output before the first build copies it cannot - one lock per part', async () => {
  const { store, A, B, holds } = twoSources('rb-race-'), log = [], cargo = sharedCargo(log);
  let pB;
  const cargoA = async a => {
    if (a[0] === 'clean') return cargo(a);
    const r = cargo(a);   // A's output is in <target>/release; before it is copied out, B's build of the same part starts
    pB = ensurePartAsync('hook', { src: B, store, cargo: async b => cargo(b) });
    for (let i = 0; i < 10; i++) await tick();
    return r;
  };
  assert.deepEqual(await ensurePartAsync('hook', { src: A, store, cargo: cargoA }), { ok: true, built: true });
  assert.deepEqual(await pB, { ok: true, built: true });
  assert.equal(holds(A), '// a\n', 'A\'s entry holds A\'s build, never B\'s');
  assert.equal(holds(B), '// b\n');
  assert.deepEqual(log, ['a built', 'b built']);
  assert.equal(fs.existsSync(lockOf('hook', store)), false, 'released');
});

test('a held lock: the async form waits with its event loop free (a supervisor\'s heartbeat beats on); the sync form holds it over cargo', async () => {
  const { store, A, B, holds } = twoSources('rb-held-'), lock = lockOf('hook', store), calls = [];
  fs.mkdirSync(store, { recursive: true }); fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: new Date().toISOString() }));
  let settled = false, beats = 0;
  const p = ensurePartAsync('hook', { src: A, store, cargo: fakeCargo('norn-hook', calls) }).finally(() => { settled = true; });
  for (; beats < 20; beats++) await tick();
  assert.equal(beats, 20, 'the event loop ran while the build waited');
  assert.equal(settled, false); assert.equal(calls.length, 0, 'no cargo while another build holds the part');
  fs.unlinkSync(lock);
  assert.deepEqual(await p, { ok: true, built: true });
  assert.deepEqual(calls.map(a => a[0]), ['clean', 'build']); assert.equal(fs.existsSync(lock), false, 'released');
  let held = null;
  assert.deepEqual(ensurePart('hook', { src: B, store, run: (c, a) => { held = JSON.parse(fs.readFileSync(lock, 'utf8')).pid; return sharedCargo()(a); } }), { ok: true, built: true });
  assert.equal(held, process.pid, 'the sync form holds the lock while cargo runs');
  assert.equal(holds(B), '// b\n'); assert.equal(fs.existsSync(lock), false, 'released');
});

test('a dead holder does not block: a lock older than any build can hold it is broken, in the sync and the async form', async () => {
  const { store, A, B, holds } = twoSources('rb-dead-'), lock = lockOf('hook', store), dead = () => fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: new Date(Date.now() - 2 * BUILD_MS - 3600e3).toISOString() }));
  fs.mkdirSync(store, { recursive: true });
  dead();
  assert.deepEqual(ensurePart('hook', { src: A, store, run: (c, a) => sharedCargo()(a) }), { ok: true, built: true });
  dead();
  assert.deepEqual(await ensurePartAsync('hook', { src: B, store, cargo: async a => sharedCargo()(a) }), { ok: true, built: true });
  assert.equal(holds(A), '// a\n'); assert.equal(holds(B), '// b\n'); assert.equal(fs.existsSync(lock), false);
});

// NORN-DONE-FRESH S3: REAL cargo, because a fake models a layout and cargo's changes (1.100 keeps a package's fingerprint under
// <target>/release/build/<package>/<hash>/, one dir for every source path, and called another source's build fresh). A tiny crate with
// no dependencies (its `fn main` prints one letter), in two source dirs that differ in that letter, registered as a part for this test
// only; after each step the stored file is RUN and must answer its own source's letter. A short temp folder (docs/code-graph.md)
test('real cargo: two sources of one part into one store - A B A; A B, A\'s entry deleted, A; A and B at once - each stored file answers its own source', async t => {
  assert.equal(spawnSync('cargo', ['--version'], { windowsHide: true }).error?.code, undefined, 'cargo is not on PATH: install Rust (https://rustup.rs)');
  RUST_PARTS.tiny = { dir: 'tiny-rs', bin: 'norn-tiny', why: 'a test crate', cc: false };
  t.after(() => { delete RUST_PARTS.tiny; });
  const d = mkTmp('rbc-'), src = n => path.join(d, n, 'engine', 'tiny-rs');
  for (const n of ['a', 'b']) {
    fs.mkdirSync(path.join(src(n), 'src'), { recursive: true });
    fs.writeFileSync(path.join(src(n), 'Cargo.toml'), '[package]\nname = "norn-tiny"\nversion = "0.1.0"\nedition = "2021"\n');
    fs.writeFileSync(path.join(src(n), 'Cargo.lock'), 'version = 4\n\n[[package]]\nname = "norn-tiny"\nversion = "0.1.0"\n');
    fs.writeFileSync(path.join(src(n), 'src', 'main.rs'), `fn main() { print!("${n}"); }\n`);
  }
  const answers = (n, store) => spawnSync(binOf('tiny', { src: src(n), store }), [], { encoding: 'utf8', windowsHide: true }).stdout;
  const err = s => process.stderr.write(s + '\n'), s1 = path.join(d, 's');
  for (const [n, built] of [['a', true], ['b', true], ['a', false]]) {
    const r = ensurePart('tiny', { src: src(n), store: s1, err });
    assert.deepEqual(r, { ok: true, built }, r.why);
    assert.equal(answers(n, s1), n, `after ${n}: its stored file answers its own source`);
  }
  fs.rmSync(binOf('tiny', { src: src('a'), store: s1 }));
  assert.deepEqual(ensurePart('tiny', { src: src('a'), store: s1, err }), { ok: true, built: true });
  assert.equal(answers('a', s1), 'a', 'A rebuilt after B: A\'s, never B\'s called fresh');
  assert.equal(answers('b', s1), 'b');
  const s2 = path.join(d, 't'), both = await Promise.all(['a', 'b'].map(n => ensurePartAsync('tiny', { src: src(n), store: s2, err })));
  assert.deepEqual(both, [{ ok: true, built: true }, { ok: true, built: true }], both.map(r => r.why).join('; '));
  assert.equal(answers('a', s2), 'a'); assert.equal(answers('b', s2), 'b');
});
