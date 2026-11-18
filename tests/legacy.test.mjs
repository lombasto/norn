// S9 legacy runs: workers from the old launcher are adopted (heartbeat + worktree lock + one watcher on pid + start time) and their
// exit records `end` with the NOTES outcome and triggers a tick - no auto-resume. Temp dirs, fake probes, a real short-lived child.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { adoptLegacy, watch, legacyOutcome, procStart, sameProcess, running } from '../engine/lib/legacy.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { hbPath, liveRuns, sweepLost, acquireLock, RunRefused } from '../engine/lib/runs.mjs';
import { mkTmp } from './helpers/tmp.mjs';

// waits for the completion itself; the deadline (monotonic clock) only bounds a hang
async function waitFor(fn, what = 'condition', ms = 20000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error(`timeout waiting: ${what}`); await new Promise(r => setTimeout(r, 50)); }
}

const tmp = () => mkTmp('meta-legacy-');
// mkTmp = <mkdtemp>/state/kestrel: liveRuns lists the runs of every sibling state dir (account-wide, D11), so a state dir straight in
// the system temp dir walks every leftover temp dir of the runner (CI 43116967024: 127 s, the adopted lock went stale before acquireLock)
const stateDir = tmp;
const T0 = '2026-10-31T04:00:00.000Z';
function claudeRun(state, extra = {}) {
  return record(state, { kind: 'run', ev: 'start', by: 'migration', data: { kind: 'worker', project: 'kestrel', lane: 'gen', executor: 'claude',
    worktree: path.join(state, 'wt'), legacy: true, pid: 4242, ...extra } }, { views: false }).id;
}

test('adopt: same process -> heartbeat + lock + watcher spawned; reused pid -> skipped; liveRuns counts it, sweepLost spares it', () => {
  const s = stateDir(), locks = path.join(s, 'locks');
  const r1 = claudeRun(s), r2 = claudeRun(s, { lane: 'relief', worktree: path.join(s, 'wt2'), pid: 4343 });
  const probe = pid => pid === 4242 ? Date.parse(T0) : pid === 4343 ? Date.parse(T0) + 600e3 : null;
  const spawned = [];
  const res = adoptLegacy({ state: s, locksDir: locks, tick: null, probe, spawnWatcher: f => { spawned.push(f); return 1; },
    specs: [{ run: r1, pid: 4242, started: T0, executor: 'claude', worktree: path.join(s, 'wt') },
            { run: r2, pid: 4343, started: T0, executor: 'claude', worktree: path.join(s, 'wt2') }] });
  assert.deepEqual(res.map(r => r.adopted ?? r.skipped), [4242, 'pid 4343 not running (or reused)']);
  assert.equal(spawned.length, 1); assert.ok(fs.existsSync(hbPath(s, r1)));
  assert.ok(liveRuns(s).some(r => r.id === r1 && r.state_dir === path.resolve(s)));  // account-wide list (D11)
  assert.throws(() => acquireLock(locks, path.join(s, 'wt'), { run: 'RUN-99' }), RunRefused);  // one writer per worktree
  const later = new Date(Date.now() + 200e3); fs.utimesSync(hbPath(s, r1), later, later);  // the watcher keeps r1's heartbeat fresh
  assert.deepEqual(sweepLost(s, { now: () => later }), [r2]);  // only the un-adopted one goes lost
});

test('adopt without run id (Codex: no lane json) records a legacy RUN start by launcher', () => {
  const s = tmp();
  const res = adoptLegacy({ state: s, locksDir: path.join(s, 'locks'), tick: null, probe: () => Date.parse(T0), spawnWatcher: () => 1,
    specs: [{ pid: 7, started: T0, executor: 'codex-sol', project: 'kestrel', lane: 'store', worktree: path.join(s, 'wt'), brief: 'b.md', final: 'f.md' }] });
  const it = loadState(s).items[res[0].run];
  assert.equal(it.state, 'running'); assert.equal(it.data.kind, 'codex'); assert.equal(it.data.legacy, true); assert.equal(it.history[0].by, 'launcher');
});

test('legacyOutcome: an old-launcher worker writes no result (gap #3): exit 0 -> no-result, exit != 0 -> crash; NOTES are never read', () => {
  const d = tmp(), f = (n, t) => { fs.writeFileSync(path.join(d, n), t); return path.join(d, n); };
  const notes = f('NOTES.md', '## S1\nx\n## HANDOFF\nnext\n');
  assert.deepEqual(legacyOutcome({ executor: 'claude', notes, lane_file: f('a.json', '{"exit":0}') }), { exit: 0, outcome: 'no-result' });
  assert.deepEqual(legacyOutcome({ executor: 'claude', notes, lane_file: f('b.json', '﻿{"exit":1}') }), { exit: 1, outcome: 'crash' });
  assert.deepEqual(legacyOutcome({ executor: 'codex-sol', final: f('fin.md', 'done\n## DONE\n') }), { exit: null, outcome: 'no-result' });
  assert.equal(legacyOutcome({ executor: 'codex-sol', final: path.join(d, 'none.md') }).outcome, 'crash');
});

test('watch: heartbeats while alive, then end (no-result: an old-launcher worker writes no result) + tick spawned + lock freed; no resume event', async () => {
  const s = tmp(), d = tmp();
  const notes = path.join(d, 'NOTES.md'); fs.writeFileSync(notes, '## S9\n## DONE\n');
  const laneFile = path.join(d, 'gen.json'); fs.writeFileSync(laneFile, JSON.stringify({ exit: null }));
  // like worker-run.ps1: the process writes its exit into the lane json, then ends - here once the test closes its stdin (after the
  // watcher's first beat), not on a timer: two PowerShell start-time probes (procStart) can outlast any fixed lifetime under load
  const child = spawn(process.execPath, ['-e', `process.stdin.resume(); process.stdin.on('end', () => require('fs').writeFileSync(${JSON.stringify(laneFile)}, '{"exit":0}'))`], { stdio: ['pipe', 'ignore', 'ignore'] });
  const started = new Date(procStart(child.pid)).toISOString();
  const tickMark = path.join(d, 'ticked');
  const run = claudeRun(s, { pid: child.pid });
  const res = adoptLegacy({ state: s, locksDir: path.join(s, 'locks'), hbMs: 200, spawnWatcher: () => 0,
    tick: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(tickMark)}, 'x')`],
    specs: [{ run, pid: child.pid, started, executor: 'claude', worktree: path.join(s, 'wt'), notes, lane_file: laneFile }] });
  assert.equal(res[0].adopted, child.pid);
  const watching = watch(path.join(s, 'hb', `${run}.legacy.json`));
  await waitFor(() => { try { return JSON.parse(fs.readFileSync(hbPath(s, run), 'utf8')).supervisor_pid === process.pid; } catch { return false; } });   // a watcher beat
  child.stdin.end();
  const outcome = await watching;
  assert.equal(outcome, 'no-result');
  const it = loadState(s).items[run];
  assert.equal(it.state, 'exited'); assert.equal(it.history.at(-1).data.exit, 0); assert.equal(it.resume, undefined);
  assert.equal(fs.existsSync(hbPath(s, run)), false);
  assert.equal(fs.readdirSync(path.join(s, 'locks')).length, 0);
  await waitFor(() => fs.existsSync(tickMark), 'tick spawned');   // a detached node start: its completion, not a 5 s budget
});

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
