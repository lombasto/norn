// Norn's Rust parts, built one way (SPEC code-graph 3.2). RUST_PARTS is the one table: norn-hook (engine/hook-rs; hook-fast S1, owner
// 2026-11-20: a claude run's PostToolUse mail hook and PreToolUse scope hook, which answer "nothing to do" without starting Node) and
// norn-code (engine/code-rs; the code graph, docs/code-graph.md). `norn setup` builds each with `cargo build --release --locked` (the
// committed Cargo.lock is what gets built) when it is missing or stale, `norn doctor` names a missing or stale one; a machine without
// either binary is a setup error that names the build command. norn-code's grammars are C (the cc crate), so its build needs a C
// compiler (DEC-a-574 Q1 a): setup checks for one first and names this OS's install.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fwd } from './config.mjs';
import { which } from './paths.mjs';
import { linuxFamily } from './prereqs.mjs';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const META_BIN = path.join(ENGINE, 'bin', 'norn.mjs');
export const RUST_PARTS = {
  hook: { dir: 'hook-rs', bin: 'norn-hook', why: 'the per-tool-call hooks of every claude run', cc: false },
  code: { dir: 'code-rs', bin: 'norn-code', why: 'the code graph (docs/code-graph.md)', cc: true },
};
/** the store schema this engine reads; `norn-code version` must print the same, or the binary is not this engine's */
export const CODE_STORE_SCHEMA = 2;

const part = p => { const x = RUST_PARTS[p]; if (!x) throw new Error(`unknown Rust part ${p}`); return x; };
export const srcOf = p => path.join(ENGINE, part(p).dir);
export const binOf = p => path.join(srcOf(p), 'target', 'release', process.platform === 'win32' ? `${part(p).bin}.exe` : part(p).bin);
export const buildOf = p => `cargo build --release --locked --manifest-path "${fwd(path.join(srcOf(p), 'Cargo.toml'))}"`;

/** the --settings hook entry of `sub` (mail | scope): Claude Code's exec form (command + args, spawned with no shell - seen on 2.1.329;
 *  Git Bash costs ~220 ms more per call on this machine). norn-hook reads the run from META_RUN_ID (the run's env); node + norn.mjs are
 *  this engine's, for the calls it hands to Node. The scope hook blocks the call when it cannot answer (onFailure block: a missing
 *  binary, a crash, a timeout - the guard fails closed); a failed mail hook only leaves that mail for the next call. */
export const hookEntry = (sub, state) => ({ type: 'command', command: fwd(binOf('hook')), args: [sub, '--state', fwd(path.resolve(state)), '--node', fwd(process.execPath), '--norn', fwd(META_BIN)],
  timeout: 30, ...(sub === 'scope' ? { onFailure: 'block' } : {}) });

// the newest source file, Cargo.lock included and target/ left out: a binary older than it is stale (a pull changed the part)
const newest = d => fs.readdirSync(d, { withFileTypes: true }).reduce((m, e) => e.name === 'target' ? m
  : Math.max(m, e.isDirectory() ? newest(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).mtimeMs), 0);
/** what is wrong with this engine's binary of part `p`: null = built, newer than its sources, and (norn-code) of this store schema */
export function partProblem(p, { run = spawnSync, src = srcOf(p), exe = binOf(p) } = {}) {
  const { bin } = part(p);
  let t;
  try { t = fs.statSync(exe).mtimeMs; } catch { return `${bin} is not built (${fwd(exe)})`; }
  if (t < newest(src)) return `${bin} is older than its source (${fwd(src)})`;
  if (p !== 'code') return null;
  // a binary copied in gets a new mtime: its own word on the schema is the check that catches it
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

/** build part `p` when missing or stale -> { ok, built, why? } (why names the build command; cargo's own output goes to err) */
export function ensurePart(p, { err = () => {}, run = spawnSync, cc = ccProblem, src = srcOf(p), exe = binOf(p) } = {}) {
  const { bin, why } = part(p);
  if (!partProblem(p, { run, src, exe })) return { ok: true, built: false };
  const noCc = part(p).cc ? cc() : null;
  if (noCc) return { ok: false, built: false, why: `${bin} (${why}) cannot build: ${noCc}, then run ${buildOf(p)}` };
  const r = run('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(src, 'Cargo.toml')], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
  if (r.error || r.status !== 0) {
    if (r.stderr) err(String(r.stderr).trimEnd());
    return { ok: false, built: false, why: `${bin} (${why}) did not build${r.error ? ` (${r.error.code || r.error.message})` : ''}: install Rust (https://rustup.rs), then run ${buildOf(p)}` };
  }
  const left = partProblem(p, { run, src, exe });
  return left ? { ok: false, built: false, why: `${left} after ${buildOf(p)}` } : { ok: true, built: true };
}
