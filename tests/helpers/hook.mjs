// norn-hook for tests that run `norn setup` in a sandbox: setup refuses without a built norn-hook, and the sandbox PATH (fake bin,
// git, node) has no cargo, so setup cannot build it there. This builds it once in the test process (its real PATH), as norn setup
// would; a file that ran before norn-hook.test.mjs no longer depends on that file having built it.
import assert from 'node:assert/strict';
import { ensureHook } from '../../engine/lib/hookbin.mjs';

let built = null;
/** build engine/hook-rs once per process when missing or stale; fails the test with the build command when cargo cannot */
export function hookReady() {
  built ??= ensureHook({ err: s => process.stderr.write(s + '\n') });
  assert.ok(built.ok, built.why);
}
