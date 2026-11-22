// META-TEST-PROCS (DEC-219, SPEC 9.6 PR-14): a test file must not leave a Norn process (supervisor, fake executor, ...) alive. 11-13
// 22 supervisor + fake-executor pairs from meta-agn- / meta-dlg- temp states were found 23-28 h old. The teardown home is
// tests/helpers/tmp.mjs (every temp dir comes from mkTmp: it kills what names one); ci-suite is the hard check behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { suiteEnv } from '../engine/lib/cisuite.mjs';
import { procsNaming, leakText } from '../engine/lib/testprocs.mjs';
import { killTree } from '../engine/lib/runs.mjs';
import { listProcs } from '../engine/lib/strays.mjs';
import { mkTmp, orphanHolds } from './helpers/tmp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempEnv = dir => ({ ...suiteEnv(process.env), TEMP: dir, TMP: dir, TMPDIR: dir });
const show = ps => ps.map(p => `pid ${p.pid}: ${p.cmd}`).join('\n');

test('a test that holds a supervisor + fake executor and has no teardown of its own leaves no process alive after its file', () => {
  const dir = mkTmp('meta-tp-');
  let left = [];
  try {
    const r = spawnSync(process.execPath, ['--test', 'tests/fixtures/test-procs/no-teardown.test.mjs'], { cwd: REPO, encoding: 'utf8', env: tempEnv(dir) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    left = procsNaming([dir]);
    assert.deepEqual(left, [], `still alive after the file ended:\n${show(left)}`);
  } finally { for (const p of left) killTree(p.pid); }
});

// the hard check: ci-suite runs each file with its own temp dir; a process still naming it after the file is a red no KNOWN-REDS
// line can hold, the pids named, and the suite kills it
const ci = (glob, known) => spawnSync(process.execPath, [path.join(REPO, 'engine', 'bin', 'ci-suite.mjs'), '--known', known, glob],
  { cwd: REPO, encoding: 'utf8', env: suiteEnv(process.env) });
test('ci-suite: a file that leaves a process alive fails naming its pid (even when KNOWN-REDS lists the file), and the process is killed; a file whose teardown is the shared helper passes', () => {
  const dir = mkTmp('meta-tp-known-');
  const known = path.join(dir, 'known.txt');
  fs.writeFileSync(known, 'tests/fixtures/ci-suite-leak/leak.test.mjs :: \n');
  const bad = ci('tests/fixtures/ci-suite-leak/leak.test.mjs', known);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  const m = bad.stdout.match(/LEAK RED: tests\/fixtures\/ci-suite-leak\/leak\.test\.mjs :: left 1 process\(es\) alive after the file: pid (\d+) \(/);
  assert.ok(m, bad.stdout);
  assert.match(bad.stdout, /ci-suite: 0 listed red\(s\), 0 new, 1 leak\(s\)/);
  assert.deepEqual(listProcs().filter(p => p.pid === Number(m[1])), [], `pid ${m[1]} still alive after ci-suite`);

  const ok = ci('tests/fixtures/test-procs/no-teardown.test.mjs', known);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ci-suite: 0 listed red\(s\), 0 new, 0 leak\(s\)/);
});

// CHECK bug (CI-RED R1 note): procsNaming matched with includes(), so ci-suite's parallel-2 dir also "named" every process of
// parallel-25 (and -20..-29, -200..): a live process of a later file could be counted (and killed) as an earlier file's leak.
// A dir is named only when the path segment ends there (end, a separator, a quote, a space ...), never mid-name.
test('procsNaming matches a dir only at a path-segment boundary: parallel-2 does not name a process of parallel-25', () => {
  const base = 'C:\\' + String.raw`Users\u1\AppData\Local\Temp\ci-suite-2Jtx4d`;   // split: no literal home path (lint S3)
  const p = (pid, cmd) => ({ pid, name: 'node.exe', cmd });
  const procs = [
    p(1, String.raw`node supervisor.mjs --state ${base}\parallel-25\meta-x\RUN-3.spec.json`),
    p(2, String.raw`node fake.mjs "${base}\parallel-2\meta-y\RUN-1.spec.json"`),
    p(3, String.raw`node fake.mjs --dir ${base}\parallel-2`),
    p(4, String.raw`node fake.mjs --dir="${base}\parallel-2" --x`),
    p(5, `node fake.mjs ${base}/parallel-2.old/z`),
  ];
  assert.deepEqual(procsNaming([String.raw`${base}\parallel-2`], procs).map(x => x.pid), [2, 3, 4]);
  assert.deepEqual(procsNaming([String.raw`${base}\parallel-25`], procs).map(x => x.pid), [1]);
  assert.deepEqual(procsNaming([`${base}/PARALLEL-2/`], procs).map(x => x.pid), [2, 3, 4]);
});

// CI-RED-7D65D2D (DEC-383): a LEAK RED named a bare pid (a jobguard hold whose supervisor was already gone) and the cause had to be
// guessed. Each leftover now carries its parent pid, its creation time and whether that parent is still alive.
test('leakText names each leftover with its parent pid, its creation time and whether the parent is alive', () => {
  const at = Date.parse('2026-11-16T10:00:00.000Z');
  const procs = [
    { pid: 10, ppid: 3036, name: 'meta-jobguard-x.exe', created: at, cmd: 'jobguard hold 3036 meta-run-3036-1' },
    { pid: 11, ppid: 20, name: 'node.exe', created: null, cmd: 'node fake.mjs' },
    { pid: 20, ppid: 1, name: 'node.exe', created: at, cmd: 'node supervisor.mjs' },
  ];
  assert.equal(leakText([procs[0], procs[1]], procs),
    'pid 10 (jobguard hold 3036 meta-run-3036-1) [parent 3036 gone, created 2026-11-16T10:00:00.000Z]; ' +
    'pid 11 (node fake.mjs) [parent 20 alive, created ?]');
  assert.equal(leakText([{ pid: 12, cmd: 'x' }], []), 'pid 12 (x) [parent ? gone, created ?]', 'no ppid known');
  assert.deepEqual(Object.keys(procsNaming(['fake.mjs'], procs)[0]).sort(), ['cmd', 'created', 'name', 'pid', 'ppid']);
});

// CI 44658557500 (delegate LEAK RED): a supervisor killed while its jobguard hold was starting left the hold alive past the file;
// the hold names no mkTmp dir (only its exe in the OS temp dir and the held pid), so reapTmp also reaps a hold whose held pid is gone
test('orphanHolds: a jobguard hold whose held pid is gone or reused is an orphan; a live run\'s hold is not', () => {
  const at = Date.parse('2026-11-20T02:11:41.605Z'), exe = 'C:\T\meta-jobguard-c45ee2b19bda.exe';
  const procs = [
    { pid: 8900, ppid: 7820, name: 'meta-jobguard-c45ee2b19bda.exe', created: at, cmd: `${exe} hold 7820 meta-run-7820-1` },   // supervisor gone
    { pid: 8901, ppid: 30, name: 'meta-jobguard-c45ee2b19bda.exe', created: at, cmd: `"${exe}" hold 30 meta-run-30-1` },      // supervisor lives
    { pid: 30, ppid: 1, name: 'node.exe', created: at - 1000, cmd: 'node supervisor.mjs' },
    { pid: 8902, ppid: 40, name: 'meta-jobguard-c45ee2b19bda.exe', created: at, cmd: `${exe} hold 40 meta-run-40-1` },        // pid 40 reused
    { pid: 40, ppid: 1, name: 'git.exe', created: at + 5000, cmd: 'git status' },
    { pid: 8903, ppid: 1, name: 'meta-jobguard-c45ee2b19bda.exe', created: at, cmd: `${exe} reap meta-run-9 9 r.jsonl k why` },
  ];
  assert.deepEqual(orphanHolds(procs).map(p => p.pid), [8900, 8902]);
});
