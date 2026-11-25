// norn-hook and norn-code for tests that start `norn setup`, `norn smoke` or anything else that builds a Rust part. Called in a file's
// test.before (NORN-DONE-FRESH), so a cold build (norn-code: minutes from an empty store, as on every CI runner) runs before any step
// and never counts against a step's time limit. The sandbox PATH (fake bin, git, node) often has no cargo, so a sandboxed setup could
// not build them anyway: this builds each once in the test process (its real PATH), as norn setup would.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RUST_PARTS, ensurePart, binOf, srcOf, storeOf } from '../../engine/lib/rustbin.mjs';

let built = null;
/** build each Rust part (engine/hook-rs, engine/code-rs) once per process when missing; fails with the build command when cargo cannot */
export function rustReady() {
  built ??= Object.keys(RUST_PARTS).map(p => ensurePart(p, { err: s => process.stderr.write(s + '\n') }));
  for (const b of built) assert.ok(b.ok, b.why);
}
/** a fresh clone's engine has its own empty store: each part whose sources equal this engine's gets this store's binary (built by
 *  rustReady) under the clone's name, as smoke.mjs does; a part whose sources differ is left for the clone's own setup to build */
export function rustInto(engine) {
  rustReady();
  for (const p of Object.keys(RUST_PARTS)) {
    const dst = binOf(p, { src: srcOf(p, engine), store: storeOf(engine) });
    if (path.basename(dst) !== path.basename(binOf(p)) || fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(binOf(p), dst);
  }
}
