// procs.mjs: a pid's start time (Linux /proc, sub-second) and whether it runs (an unreaped zombie does not). Fake /proc trees in temp dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { procStart, running } from '../engine/lib/procs.mjs';
import { mkTmp } from './helpers/tmp.mjs';

// CI-RED-C1159BD R1: Linux procStart was `ps -o lstart=` - whole seconds. The test process and the supervisor it spawned 0.2 s
// later had the same "start time", so a reused pid read as the same process. Linux reads /proc/<pid>/stat starttime (clock ticks
// since boot) + /proc/stat btime: two processes started 0.3 s apart in the same second differ.
test('procStart on Linux: /proc starttime ticks + btime, sub-second (two processes in the same second differ)', () => {
  const proc = mkTmp('meta-proc-'), hz = 100, btime = 1763340000;
  fs.writeFileSync(path.join(proc, 'stat'), `cpu  1 2 3 4\nintr 5\nbtime ${btime}\nprocesses 9\n`);
  const stat = (pid, ticks) => { fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (node (x) y) S 1 ${pid} ${pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 11 0 ${ticks} 1000 10 18446744073709551615\n`); };
  stat(process.pid, 123410); stat(process.ppid, 123440);
  const a = procStart(process.pid, 'linux', { proc, hz }), b = procStart(process.ppid, 'linux', { proc, hz });
  assert.equal(a, btime * 1000 + 1234100, 'btime + starttime / CLK_TCK, in ms');
  assert.equal(b - a, 300, 'started 0.3 s apart in the same second: two processes');
  assert.equal(procStart(999999999, 'linux', { proc, hz }), null, 'no such pid');
});

// CI ubuntu (green main run 44138764892): `norn run --wait` blocks its loop (Atomics.wait) while it waits for the supervisor it
// spawned; that exited child stays a zombie (never reaped) and kill(pid, 0) still answers - four OOTB tests waited the whole 120 s
// net (121 s on ubuntu, 2.5 s on Windows). running() reads /proc/<pid>/stat: state Z = gone.
test('running(pid): a live pid runs; one whose /proc stat says Z (an unreaped zombie) does not; a gone pid does not', () => {
  const proc = mkTmp('meta-proc-'), me = String(process.pid);
  fs.mkdirSync(path.join(proc, me));
  fs.writeFileSync(path.join(proc, me, 'stat'), `${me} (node (x) y) S 1 2 3\n`);
  assert.equal(running(process.pid, { proc }), true, 'state S: runs (a ")" in the name is skipped)');
  fs.writeFileSync(path.join(proc, me, 'stat'), `${me} (node (x) y) Z 1 2 3\n`);
  assert.equal(running(process.pid, { proc }), false, 'state Z: an exited child nobody reaped');
  assert.equal(running(process.pid, { proc: path.join(proc, 'none') }), true, 'no /proc (Windows, macOS): kill(pid, 0) decides');
  assert.equal(running(2 ** 30), false, 'no such pid');
});
