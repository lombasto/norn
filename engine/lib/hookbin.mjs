// hook-fast S1 (owner 2026-11-20; narrows Q-b-43 "no Rust rewrite" to the per-tool-call hooks): a claude run's PostToolUse mail hook
// and PreToolUse scope hook are ONE Rust binary, norn-hook (engine/hook-rs). A bare `node -e 0` costs ~1 s on a busy machine, so no
// Node hook could answer "nothing to do" fast; norn-hook answers that case itself and starts the Node hook (norn mail check --inject,
// norn scope check) only when Node has something to do. `norn setup` builds it (cargo), `norn doctor` checks it; there is no Node
// hook line to fall back to: a machine without the binary is a setup error that names the build command.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const META_BIN = path.join(ENGINE, 'bin', 'norn.mjs');
export const HOOK_SRC = path.join(ENGINE, 'hook-rs');
export const HOOK_BIN = path.join(HOOK_SRC, 'target', 'release', process.platform === 'win32' ? 'norn-hook.exe' : 'norn-hook');
const fwd = p => String(p).replace(/\\/g, '/');
export const HOOK_BUILD = `cargo build --release --manifest-path "${fwd(path.join(HOOK_SRC, 'Cargo.toml'))}"`;

/** the hook command line of `sub` (mail | scope). Claude Code runs hook commands in Git Bash / sh: $META_RUN_ID expands there (norn-hook
 *  reads the env itself when it was not expanded); node + norn.mjs are this engine's, for the calls norn-hook hands to Node */
export const hookLine = (sub, state) => `"${fwd(HOOK_BIN)}" ${sub} --run $META_RUN_ID --state "${fwd(path.resolve(state))}" --node "${fwd(process.execPath)}" --norn "${fwd(META_BIN)}"`;

// the newest source file: a binary older than it is stale (a pull changed the hook; setup rebuilds it)
const newest = d => fs.readdirSync(d, { withFileTypes: true }).reduce((m, e) => e.name === 'target' ? m
  : Math.max(m, e.isDirectory() ? newest(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).mtimeMs), 0);
/** what is wrong with this engine's norn-hook: null = built and newer than its sources */
export function hookProblem() {
  let bin;
  try { bin = fs.statSync(HOOK_BIN).mtimeMs; } catch { return `norn-hook is not built (${fwd(HOOK_BIN)})`; }
  return bin < newest(HOOK_SRC) ? `norn-hook is older than its source (${fwd(HOOK_SRC)})` : null;
}
/** build norn-hook when it is missing or stale -> { ok, built, why? } (why names the build command; cargo's own output goes to err) */
export function ensureHook({ err = () => {}, run = spawnSync } = {}) {
  if (!hookProblem()) return { ok: true, built: false };
  const r = run('cargo', ['build', '--release', '--manifest-path', path.join(HOOK_SRC, 'Cargo.toml')], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
  if (r.error || r.status !== 0) {
    if (r.stderr) err(String(r.stderr).trimEnd());
    return { ok: false, built: false, why: `norn-hook (the per-tool-call hooks of every claude run) did not build${r.error ? ` (${r.error.code || r.error.message})` : ''}: install Rust (https://rustup.rs), then run ${HOOK_BUILD}` };
  }
  const left = hookProblem();
  return left ? { ok: false, built: false, why: `${left} after ${HOOK_BUILD}` } : { ok: true, built: true };
}
