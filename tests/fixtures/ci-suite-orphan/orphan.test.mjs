// fair-slots 5b: a file that starts a detached orphan (it names the file's temp dir, as a test's supervisor does) and then never ends -
// for the ci-suite checks that the whole tree dies at the per-file cap and when the suite itself is killed. Run only by
// tests/gatelock.test.mjs; CI_SUITE_PIDS = the file it writes { orphan, file } to.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';

test('starts an orphan, then hangs', () => new Promise(() => {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', os.tmpdir()], { detached: true, stdio: 'ignore', windowsHide: true });
  g.unref();
  if (process.env.CI_SUITE_PIDS) { fs.writeFileSync(process.env.CI_SUITE_PIDS + '.tmp', JSON.stringify({ orphan: g.pid, file: process.pid })); fs.renameSync(process.env.CI_SUITE_PIDS + '.tmp', process.env.CI_SUITE_PIDS); }
  setInterval(() => {}, 1e6);
}));
