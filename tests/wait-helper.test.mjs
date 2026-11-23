// CI-HANG-6E54DAB R2 (DEC-355): waitFor / waitForSync reject an option they do not know (a `timeoutMs` was silently ignored, so a
// stuck wait ran the 10-min hang guard past the file cap: a nameless HANG). A wait whose producer is gone fails within seconds,
// naming the condition.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { waitFor, waitForSync, runEnded, stateBusy } from './helpers/wait.mjs';
import { record } from '../engine/lib/records.mjs';
import { alive, settled } from './helpers/settled.mjs';
import { procStart } from '../engine/lib/procs.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const fwd = p => p.split(path.sep).join('/');

test('waitFor / waitForSync throw a TypeError on an option they do not know', async () => {
  await assert.rejects(waitFor(() => true, { what: 'x', timeoutMs: 60000 }), { name: 'TypeError', message: /unknown option.*timeoutMs/ });
  assert.throws(() => waitForSync(() => true, { what: 'x', timeoutMs: 60000 }), { name: 'TypeError', message: /unknown option.*timeoutMs/ });
  assert.equal(await waitFor(() => 7, { producer: () => true, what: 'x', capMs: 1000, pollMs: 5 }), 7, 'the known options still work');
});

test('a waitFor whose condition never comes true fails within seconds once its producer is gone, naming the condition', async () => {
  const t0 = performance.now();
  let n = 0;
  await assert.rejects(waitFor(() => false, { producer: () => ++n < 3, what: 'the never-true thing', pollMs: 10 }),
    /^Error: the never-true thing: its producer is gone/);
  assert.ok(performance.now() - t0 < 5000);
});

// P2 (CI-HANG-6E54DAB R2 toy, Windows 11: a freed pid went to a new long-lived process after 33 s / ~800 spawns, and kill(pid, 0)
// called that new process alive): a process is (pid, OS start time) - psutil create_time practice; the supervisor records its own.
test('alive(pid, started): a live pid whose OS start time is not the recorded one is another process (a reused pid), not ours', async () => {
  const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  await new Promise(r => c.once('spawn', r));
  try {
    const started = procStart(c.pid);
    assert.ok(Number.isFinite(started), 'the OS start time of a live child');
    assert.equal(alive(c.pid, started), true, 'pid + its own start time: ours');
    assert.equal(alive(c.pid, started - 60000), false, 'the same pid with another start time: a reused pid, not ours');
    assert.equal(alive(c.pid), true, 'no start time known yet (the launcher\'s birth hb): the pid decides');
  } finally { c.kill(); }
  await new Promise(r => c.once('exit', r));
  assert.equal(alive(c.pid, 1), false, 'exited');
});

test('a supervisor records its own OS start time beside its pid (hb + end); settled() holds it to that identity', async () => {
  const t = mkTmp('meta-wait-ident-'), wt = path.join(t, 'wt'), state = path.join(t, 'state', 'k'), pf = path.join(t, 'project.json');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'k', title: 'k', root: fwd(wt), ledger: '${root}/L.md', briefs_dir: '${root}', policy: { slop: { enabled: false } } }));
  const bf = path.join(t, 'brief.md'); fs.writeFileSync(bf, 'mode: done\n');
  const env = { ...process.env, META_ROOT: t, HOME: t, USERPROFILE: t, META_HB_MS: '150' };
  const r = spawnSync(process.execPath, [NORN, 'run', '--executor', 'fake', '--project', pf, '--state', state, '--locks', path.join(t, 'locks'), '--lane', 'x',
    '--brief', bf, '--worktree', wt, '--notes', path.join(t, 'NOTES.md'), '--no-tick'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const it = await runEnded(state, 'RUN-1');
  assert.ok(Number.isFinite(it.end.supervisor_started), 'the end names the supervisor\'s start time');
  assert.equal(settled(it), true);
  assert.equal(settled({ ...it, end: { ...it.end, supervisor_pid: process.pid, supervisor_started: procStart(process.pid) } }), false, 'a live supervisor identity: not settled');
  assert.equal(settled({ ...it, end: { ...it.end, supervisor_pid: process.pid, supervisor_started: it.end.supervisor_started } }), true, 'its pid now names another process (this one): settled');
});

// CI-RED-18A9C0A R2 (critique cause B, 4 parallel runs under load: 7 of 47 red): stateBusy read the state once, then probed each
// run's supervisor - a sync start-time probe of 1.1-1.5 s on a loaded box. RUN-1's supervisor started RUN-2 and exited DURING that
// probe: the stale snapshot had no RUN-2, so "its producer is gone" while RUN-2's supervisor lived. A false answer is re-checked on
// a fresh state until the runs did not change under it.
test('stateBusy: a run started while the previous producer was being probed (and then exited) keeps the state busy', () => {
  const t = mkTmp('meta-busy-'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(state, { recursive: true });
  const one = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'a' } }).id;
  let two = null;
  const live = (_st, it) => {
    if (it.id === one) { two ??= record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'b' } }).id; return false; }   // its successor starts, then it exits
    return it.id === two;
  };
  assert.equal(stateBusy(state, { live })(), true, 'the successor RUN-2 (live) is the producer now');
  assert.equal(stateBusy(state, { live: () => false })(), false, 'nothing lives: not busy');
});
