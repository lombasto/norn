// NORN-RUST-FRESH: Norn's Rust parts are named by their source content in one store every checkout of the clone shares, and built
// (rustbin.mjs ensurePart / ensurePartAsync / ensureParts) when missing; one that cannot be had is ONE reason naming the part, the
// cause and the build command. Fake crate dirs and an injected cargo only: no real cargo runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { storeOf, sourceHash, binOf, partsOf, partProblem, ensurePart, ensurePartAsync, ensureParts, targetOf, CODE_STORE_SCHEMA } from '../engine/lib/rustbin.mjs';
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
// an injected cargo: records its args and writes <target-dir>/release/<bin> as a real build would
const fakeCargo = (bin, calls) => async args => { calls.push(args); const t = args[args.indexOf('--target-dir') + 1]; fs.mkdirSync(path.join(t, 'release'), { recursive: true }); fs.writeFileSync(path.join(t, 'release', bin + EXE), 'bin'); return { status: 0, stdout: '', stderr: '' }; };
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
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['build', '--release', '--locked']);
  assert.equal(calls[0][calls[0].indexOf('--target-dir') + 1], targetOf('hook', store));
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
  const failed = await ensurePartAsync('hook', { src, store, err: s => errs.push(s), cargo: async () => ({ status: 101, stdout: '', stderr: '   Compiling norn-hook\nerror: failed to remove file `x\\norn-hook.exe`\n\nCaused by:\n  Access is denied. (os error 5)\n' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.why, /^norn-hook \(.*\) did not build \(cargo exit 101: error: failed to remove file `x\\norn-hook\.exe`\); /);
  assert.match(failed.why, cmd);
  assert.match(errs.join('\n'), /Access is denied/, 'cargo\'s own output goes to err');
  assert.equal(fs.existsSync(binOf('hook', { src, store })), false, 'a failed build stores nothing');
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
