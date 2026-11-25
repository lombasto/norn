// norn-hook and norn-code for tests that run `norn setup` in a sandbox: setup refuses without both Rust parts built, and the
// sandbox PATH (fake bin, git, node) has no cargo, so setup cannot build them there. This builds each once in the test process
// (its real PATH), as norn setup would; a file that ran before norn-hook.test.mjs no longer depends on that file having built it.
import assert from 'node:assert/strict';
import { RUST_PARTS, ensurePart } from '../../engine/lib/rustbin.mjs';

let built = null;
/** build each Rust part (engine/hook-rs, engine/code-rs) once per process when missing or stale; fails the test with the build command when cargo cannot */
export function rustReady() {
  built ??= Object.keys(RUST_PARTS).map(p => ensurePart(p, { err: s => process.stderr.write(s + '\n') }));
  for (const b of built) assert.ok(b.ok, b.why);
}
