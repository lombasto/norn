// Norn's Rust parts, built one way (SPEC code-graph 3.2). RUST_PARTS is the one table: norn-hook (engine/hook-rs; hook-fast S1, owner
// 2026-11-20: a claude run's PostToolUse mail hook and PreToolUse scope hook, which answer "nothing to do" without starting Node) and
// norn-code (engine/code-rs; the code graph, docs/code-graph.md). Each binary is named by its SOURCE CONTENT and kept in one store
// that every checkout of this clone shares (NORN-RUST-FRESH, the measured choice: a cold norn-code is ~4 min and 166 MB of target/,
// too much per lane worktree): <git common dir>/norn/rust/bin/<bin>-<source sha12>[.exe], built by `cargo build --release --locked`
// (the committed Cargo.lock is what gets built) into the store's one target dir per part, then copied out. So a worktree whose part
// equals main's costs no build; a pull that changes a part names a new binary, and a live run keeps executing the one it started with
// (Windows cannot replace a running exe: cargo exit 101, os error 5 - cargo's own output file is never what a run executes). A process
// pins the hash of its own engine's sources at first use: a supervisor whose checkout is pulled under it reads the binary of the
// engine it loaded, never a newer one. `norn setup`, every run start and every Done check build a missing one (ensurePart /
// ensureParts); one that cannot be had is ONE reason naming the part, the cause and the build command. norn-code's grammars are C
// (the cc crate), so its build needs a C compiler (DEC-a-574 Q1 a): it is checked first and this OS's install named.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fwd, pathKey } from './config.mjs';
import { which } from './paths.mjs';
import { linuxFamily } from './prereqs.mjs';
import { boundedAsync } from './bounded.mjs';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const META_BIN = path.join(ENGINE, 'bin', 'norn.mjs');
export const RUST_PARTS = {
  hook: { dir: 'hook-rs', bin: 'norn-hook', why: 'the per-tool-call hooks of every claude run', cc: false },
  code: { dir: 'code-rs', bin: 'norn-code', why: 'the code graph (docs/code-graph.md)', cc: true },
};
/** the store schema this engine reads; `norn-code version` must print the same, or the binary is not this engine's */
export const CODE_STORE_SCHEMA = 3;
/** the limit of one cargo build, the one named place (a cold norn-code: 224 s on a 20-core Windows machine; a CI runner is slower) */
export const BUILD_MS = 600000;

const EXE = process.platform === 'win32' ? '.exe' : '';
const part = p => { const x = RUST_PARTS[p]; if (!x) throw new Error(`unknown Rust part ${p}`); return x; };
export const srcOf = (p, engine = ENGINE) => path.join(path.resolve(engine), part(p).dir);

/** the store every checkout of the engine's clone shares (the main one and each `git worktree`): <git common dir>/norn/rust, beside the
 *  code graph's <git common dir>/norn/code. A worktree's .git is a file naming its gitdir, whose commondir file names the common one.
 *  An engine outside any git checkout shares nothing: <its root>/.norn/rust */
export function storeOf(engine = ENGINE) {
  const root = path.resolve(engine, '..'), dot = path.join(root, '.git');
  let st;
  try { st = fs.statSync(dot); } catch { return path.join(root, '.norn', 'rust'); }
  if (st.isDirectory()) return path.join(dot, 'norn', 'rust');
  const gd = path.resolve(root, /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dot, 'utf8'))?.[1] ?? '.git');
  let common = gd;
  try { common = path.resolve(gd, fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim()); } catch { /* no commondir: the gitdir is the common dir */ }
  return path.join(common, 'norn', 'rust');
}
let STORE = null;
const store = () => (STORE ??= storeOf());
export const targetOf = (p, st = store()) => path.join(st, 'target', p);

// the source files of a crate dir, target/ left out, repo-style relative paths, sorted
const files = (d, rel = '') => fs.readdirSync(path.join(d, rel), { withFileTypes: true })
  .flatMap(e => e.name === 'target' ? [] : e.isDirectory() ? files(d, path.posix.join(rel, e.name)) : [path.posix.join(rel, e.name)]);
/** sha256 (12 hex) of a crate's sources: every file's relative path and bytes, Cargo.toml and Cargo.lock included; 'nosource' without one */
export function sourceHash(src) {
  if (!fs.existsSync(path.join(src, 'Cargo.toml'))) return 'nosource';
  const h = crypto.createHash('sha256');
  for (const f of files(src).sort()) h.update(f).update('\0').update(fs.readFileSync(path.join(src, f))).update('\0');
  return h.digest('hex').slice(0, 12);
}
// this engine's own sources are hashed once per process (the pin above); any other checkout's are read as they are now
const PINNED = {};
const hashOf = (p, src) => (pathKey(src) === pathKey(srcOf(p)) ? (PINNED[p] ??= sourceHash(src)) : sourceHash(src));
/** the binary of part `p` for the sources in `src` (default: this engine's), in store `st` */
export const binOf = (p, { src = srcOf(p), store: st = store() } = {}) => path.join(st, 'bin', `${part(p).bin}-${hashOf(p, src)}${EXE}`);
/** the command a BLOCK names: the build ensurePart runs (it then copies target/release/<bin> to binOf) */
export const buildOf = (p, { src = srcOf(p), store: st = store() } = {}) =>
  `cargo build --release --locked --target-dir "${fwd(targetOf(p, st))}" --manifest-path "${fwd(path.join(src, 'Cargo.toml'))}"`;

/** the --settings hook entry of `sub` (mail | scope): Claude Code's exec form (command + args, spawned with no shell - seen on 2.1.329;
 *  Git Bash costs ~220 ms more per call on this machine). norn-hook reads the run from META_RUN_ID (the run's env); node + norn.mjs are
 *  this engine's, for the calls it hands to Node. The scope hook blocks the call when it cannot answer (onFailure block: a missing
 *  binary, a crash, a timeout - the guard fails closed); a failed mail hook only leaves that mail for the next call. */
export const hookEntry = (sub, state) => ({ type: 'command', command: fwd(binOf('hook')), args: [sub, '--state', fwd(path.resolve(state)), '--node', fwd(process.execPath), '--norn', fwd(META_BIN)],
  timeout: 30, ...(sub === 'scope' ? { onFailure: 'block' } : {}) });

/** what is wrong with the binary of part `p` for the sources in `src`: null = built (its content-named file exists) and (norn-code)
 *  of this store schema. A changed source names another file, so "stale" reads as "not built for its source" */
export function partProblem(p, { run = spawnSync, src = srcOf(p), exe = binOf(p, { src }) } = {}) {
  const { bin } = part(p);
  if (!fs.existsSync(path.join(src, 'Cargo.toml'))) return `${bin}'s source is missing (${fwd(src)})`;
  if (!fs.existsSync(exe)) return `${bin} is not built for its source (${fwd(exe)})`;
  if (p !== 'code') return null;
  // the binary's own word on the schema: a file copied in under the right name but built from other sources is caught here
  const r = run(exe, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  let v = null; try { v = JSON.parse(r.stdout); } catch { /* no JSON: named below */ }
  if (v?.store_schema !== CODE_STORE_SCHEMA) return `${bin} at ${fwd(exe)} answers store_schema ${v?.store_schema ?? `n/a (${r.error?.code || `exit ${r.status}`})`}, this engine reads ${CODE_STORE_SCHEMA}`;
  return null;
}

const CC_INSTALL = {
  win32: 'the MSVC build tools (winget install Microsoft.VisualStudio.2022.BuildTools, the "Desktop development with C++" workload) for the msvc Rust toolchain, or WinLibs gcc (winget install BrechtSanders.WinLibs.POSIX.UCRT) for the gnu one',
  darwin: 'xcode-select --install', apt: 'sudo apt-get install build-essential', dnf: 'sudo dnf install gcc', other: 'your distribution\'s gcc or clang package',
};
const VSWHERE = env => path.join(env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
/** null = a C compiler the cc crate finds (CC, cc / gcc / clang / cl on PATH, or the MSVC tools vswhere knows); else the install line */
export function ccProblem({ env = process.env, platform = process.platform, exists = fs.existsSync, osRelease } = {}) {
  if (env.CC || ['cc', 'gcc', 'clang', 'cl'].some(n => which(n, { platform, env }))) return null;
  if (platform === 'win32' && exists(VSWHERE(env))) return null;
  const fam = platform === 'win32' || platform === 'darwin' ? platform : linuxFamily(osRelease ?? (() => { try { return fs.readFileSync('/etc/os-release', 'utf8'); } catch { return ''; } })());
  return `no C compiler found (norn-code's tree-sitter grammars are C): install ${CC_INSTALL[fam]}`;
}

// the build of part `p`, split so ensurePart (spawnSync) and ensurePartAsync (off the event loop: a supervisor's heartbeat beats on)
// share every step: plan -> { done } when nothing is to build or it cannot start, else { args } for cargo; settle -> the result
function plan(p, o) {
  const { bin, why, cc: needsCc } = part(p);
  if (!partProblem(p, o)) return { done: { ok: true, built: false } };
  const noCc = needsCc ? o.cc() : null;
  if (noCc) return { done: { ok: false, built: false, part: p, why: `${bin} (${why}) cannot build: ${noCc}; build command: ${buildOf(p, o)}` } };
  // the target dir is shared by every checkout, and a crate's artifact name ignores its path: cargo, finding another checkout's
  // fingerprint of this package, checks only the files THAT build listed (a new module is not among them) and may call it fresh, so
  // the old binary would be stored under this source's name. No binary for this source = this crate must compile: drop its own
  // fingerprints (its dependencies keep theirs and stay built)
  const fp = path.join(targetOf(p, o.store), 'release', '.fingerprint');
  let fps = []; try { fps = fs.readdirSync(fp); } catch { /* a cold target dir: nothing to drop */ }
  for (const d of fps.filter(d => d.startsWith(`${bin}-`) && /^[0-9a-f]{16}$/.test(d.slice(bin.length + 1)))) fs.rmSync(path.join(fp, d), { recursive: true, force: true });
  return { args: ['build', '--release', '--locked', '--target-dir', targetOf(p, o.store), '--manifest-path', path.join(o.src, 'Cargo.toml')] };
}
const lastError = s => { const ls = String(s ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean); return ls.find(l => /^error\b/.test(l)) ?? ls.at(-1) ?? ''; };
function settle(p, r, o) {
  const { bin, why } = part(p), name = `${bin} (${why})`, no = w => ({ ok: false, built: false, part: p, why: w });
  if (r.error?.code === 'ENOENT') return no(`${name} cannot build: cargo is not on PATH (install Rust: https://rustup.rs); build command: ${buildOf(p, o)}`);
  if (r.error || r.status !== 0) {
    if (r.stderr) o.err(String(r.stderr).trimEnd());
    const e = lastError(r.stderr);
    return no(`${name} did not build (${r.error ? r.error.code || r.error.message : `cargo exit ${r.status}`}${e ? `: ${e}` : ''}); build command: ${buildOf(p, o)}`);
  }
  // cargo's output is copied to the content-named file (temp + rename: a racer building the same sources leaves one whole file)
  const out = path.join(targetOf(p, o.store), 'release', part(p).bin + EXE), tmp = `${o.exe}.${process.pid}.tmp`;
  try { fs.mkdirSync(path.dirname(o.exe), { recursive: true }); fs.copyFileSync(out, tmp); fs.renameSync(tmp, o.exe); }
  catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* the copy never started */ }
    if (!fs.existsSync(o.exe)) return no(`${name} built but not stored at ${fwd(o.exe)} (${e.code || e.message}); build command: ${buildOf(p, o)}`);
  }
  const left = partProblem(p, o);
  return left ? no(`${left} after its build (${buildOf(p, o)})`) : { ok: true, built: true };
}
const opts = (p, { err = () => {}, start = () => {}, run = spawnSync, cc = ccProblem, src = srcOf(p), store: st = store(), exe } = {}) => ({ err, start, run, cc, src, store: st, exe: exe ?? binOf(p, { src, store: st }) });

/** build part `p` for `src` when its binary is missing -> { ok, built, part?, why? } (why: the ONE reason, naming the part, the cause
 *  and the build command; cargo's own output goes to err). run: spawnSync-shaped, for cargo and `norn-code version`; start(p) is said
 *  just before cargo runs (a caller names the wait: a cold norn-code takes minutes) */
export function ensurePart(p, o = {}) {
  const x = opts(p, o), pl = plan(p, x);
  if (pl.done) return pl.done;
  x.start(p);
  return settle(p, x.run('cargo', pl.args, { encoding: 'utf8', windowsHide: true, timeout: BUILD_MS }), x);
}
/** ensurePart without blocking the event loop: cargo (default boundedAsync: the tree dies at BUILD_MS) resolves spawnSync's shape */
export async function ensurePartAsync(p, { cargo = args => boundedAsync('cargo', args, { timeout: BUILD_MS }), ...o } = {}) {
  const x = opts(p, o), pl = plan(p, x);
  if (pl.done) return pl.done;
  x.start(p);
  return settle(p, await cargo(pl.args), x);
}

/** the ONE condition on which a slop check reads the code graph, so needs norn-code: one of its `imports` rules (K10) has a root the
 *  worktree holds. The supervisor (run start, run end) and `norn done` (its stored check) build norn-code on it; `rules` is the check's */
export const graphReads = (rules, worktree) => rules.some(r => r.kind === 'imports' && r.roots?.some(x => fs.existsSync(path.join(worktree, x))));

/** the parts a run reads -> [{ p, src, store, exe }]: `parts` of this engine, and every part of the worktree's own engine when the
 *  worktree is a checkout of Norn that is not this engine's (its tests import that engine); one entry per binary */
export function partsOf({ parts = Object.keys(RUST_PARTS), worktree = null } = {}) {
  const out = parts.map(p => ({ p, src: srcOf(p), store: store() }));
  const eng = worktree ? path.join(path.resolve(worktree), 'engine') : null;
  if (eng && pathKey(eng) !== pathKey(ENGINE)) for (const p of Object.keys(RUST_PARTS)) if (fs.existsSync(path.join(srcOf(p, eng), 'Cargo.toml'))) out.push({ p, src: srcOf(p, eng), store: storeOf(eng) });
  const seen = new Set();
  return out.map(x => ({ ...x, exe: binOf(x.p, x) })).filter(x => !seen.has(pathKey(x.exe)) && seen.add(pathKey(x.exe)));
}
/** ensurePartAsync over a list, in order -> { ok, built: [bin path], part?, why? }: the first part that cannot be had is the ONE reason */
export async function ensureParts(list, o = {}) {
  const built = [];
  for (const x of list) {
    const r = await ensurePartAsync(x.p, { ...o, src: x.src, store: x.store, exe: x.exe });
    if (!r.ok) return { ok: false, built, part: x.p, why: r.why };
    if (r.built) built.push(fwd(x.exe));
  }
  return { ok: true, built };
}
