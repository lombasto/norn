// META-CATCH S1 piece 1 - dead runs by code: a run whose supervisor is gone, one started before the machine's boot, and a resume that
// never started are recorded lost (with their cause) by the sweep, and the HANDOFF auto-resume policy relaunches them once. Synthetic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sweepLost, relaunchLost, lostNotice, hbPath, pidGone } from '../engine/lib/runs.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';

function sandbox() {
  const t = mkTmp('meta-dead-'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(path.join(state, 'hb'), { recursive: true }); fs.mkdirSync(path.join(state, 'runs'), { recursive: true });
  const item = id => loadState(state).items[id];
  const start = (data = {}) => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'demo', ...data } }).id;
  const hb = (id, o) => fs.writeFileSync(hbPath(state, id), JSON.stringify({ run: id, ts: new Date().toISOString(), ...o }));
  const spec = (id, o = {}) => fs.writeFileSync(path.join(state, 'runs', id + '.spec.json'), JSON.stringify({ state, run: id, executor: 'fake', lane: 'demo', brief: 'b.md', resumes: 0, policy: { auto_resume_max: 2 }, ...o }));
  return { t, state, item, start, hb, spec };
}
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;   // a process that has exited: its pid names nothing now
const stale = (d, id) => { const old = new Date(Date.now() - 300e3); fs.utimesSync(hbPath(d.state, id), old, old); };

test('sweep: a supervisor pid that names no process -> lost at once (cause gone), no 120 s wait; a live pid with a fresh beat stays', () => {
  const d = sandbox(), a = d.start(), b = d.start();
  const pid = deadPid();
  assert.equal(pidGone(pid), true); assert.equal(pidGone(process.pid), false);
  d.hb(a, { supervisor_pid: pid }); d.hb(b, { supervisor_pid: process.pid });
  assert.deepEqual(sweepLost(d.state), [a]);
  assert.equal(d.item(a).lost.cause, 'gone'); assert.match(d.item(a).lost.why, new RegExp(`supervisor pid ${pid} gone`));
  assert.equal(d.item(b).state, 'running');
});

test('sweep: the first sweep after a boot -> every run started before it is lost (cause boot), even when its pid is alive again (pid reuse)', () => {
  const d = sandbox(), a = d.start(), b = d.start();
  d.hb(a, { supervisor_pid: process.pid });   // the pid names a live process again: reused after the boot
  const boot = Date.now() + 5 * 60e3;          // the machine booted after both runs started
  assert.deepEqual(sweepLost(d.state, { boot: () => boot }).sort(), [a, b].sort());
  for (const id of [a, b]) { assert.equal(d.item(id).lost.cause, 'boot'); assert.equal(d.item(id).lost.boot, new Date(boot).toISOString()); }
  // a run started after the boot is judged by its heartbeat as before
  const c = d.start(); d.hb(c, { supervisor_pid: process.pid });
  assert.deepEqual(sweepLost(d.state, { boot: () => Date.now() - 3600e3 }), []);
});

test('sweep: a resume that shows no start (no heartbeat) within 2 min -> lost, cause no-start; a stale beat of a live pid -> cause stale', () => {
  const d = sandbox(), r = d.start({ resume_of: 'RUN-1', resumes: 1 }), s = d.start();
  d.hb(s, { supervisor_pid: process.pid }); stale(d, s);
  assert.deepEqual(sweepLost(d.state, { now: () => new Date(Date.now() + 60e3) }), [s], 'inside 2 min the resume is only starting');
  assert.equal(d.item(s).lost.cause, 'stale');
  assert.deepEqual(sweepLost(d.state, { now: () => new Date(Date.now() + 121e3) }), [r]);
  assert.equal(d.item(r).lost.cause, 'no-start'); assert.match(d.item(r).lost.why, /never started/);
});

test('relaunch: a certain death goes through the auto-resume policy once (relaunched + routine review); refused -> the resume record says why; a stale one stays for the check-in', () => {
  const d = sandbox(), a = d.start(), capped = d.start(), off = d.start(), st = d.start(), ck = d.start({ kind: 'checkin' });
  d.spec(a); d.spec(capped, { resumes: 2 }); d.spec(off, { policy: { auto_resume_handoff: false } }); d.spec(st); d.spec(ck);
  for (const id of [a, capped, off, ck]) d.hb(id, { supervisor_pid: deadPid() });
  d.hb(st, { supervisor_pid: process.pid }); stale(d, st);
  sweepLost(d.state);
  const calls = [];
  const start = o => { calls.push(o); return { run: d.start({ resume_of: o.resumeOf, resumes: o.resumes }) }; };
  const rows = relaunchLost(d.state, { start });
  assert.deepEqual(rows.map(r => r.id).sort(), [a, capped, off].sort(), 'not the stale one, not a check-in');
  assert.equal(calls.length, 1); assert.equal(calls[0].resumeOf, a); assert.equal(calls[0].resumes, 1); assert.equal(calls[0].run, undefined, 'a fresh run id');
  assert.equal(d.item(a).resume.next, rows.find(r => r.id === a).next); assert.equal(d.item(a).review.routine, 'lost_resume');
  assert.match(d.item(capped).resume.refused, /^cap 2\/2/); assert.equal(d.item(capped).review, undefined, 'a refused one stays for the check-in');
  assert.equal(d.item(off).resume.refused, 'auto-resume off');
  assert.deepEqual(relaunchLost(d.state, { start }), [], 'once per run');
  assert.equal(calls.length, 1);
});

test('relaunch: the one owner notice per sweep names the boot, n lost and m relaunched', () => {
  const boot = '2026-01-02T03:04:05.000Z';
  const n = lostNotice([{ id: 'RUN-1', cause: 'boot', boot, next: 'RUN-3' }, { id: 'RUN-2', cause: 'boot', boot, refused: 'cap 2/2' }], 'demo');
  assert.equal(n.body, 'machine rebooted at 2026-01-02 03:04Z: 2 runs lost, 1 relaunched (RUN-1 -> RUN-3, RUN-2 (not relaunched: cap 2/2))');
  assert.match(n.title, /^demo: machine rebooted/);
  assert.match(lostNotice([{ id: 'RUN-1', cause: 'gone', next: 'RUN-4' }]).body, /^run supervisor gone: 1 run lost, 1 relaunched/);
  assert.equal(lostNotice([]), null);
});

test('tick: dead runs are swept and handled by code before any model, with ONE notice', async () => {
  const { tick } = await import('../engine/lib/tick.mjs');
  const d = sandbox(), wt = path.join(d.t, 'wt'); fs.mkdirSync(wt, { recursive: true });
  const a = d.start(); d.spec(a, { policy: { auto_resume_max: 0 } }); d.hb(a, { supervisor_pid: deadPid() });
  const ck = d.start({ kind: 'checkin', lane: 'checkin' }); d.hb(ck, { supervisor_pid: process.pid });   // a live check-in: the tick stops there
  const project = { name: 'demo', root: wt, state: d.state, ledger: path.join(d.t, 'progress.md') };
  const go = () => tick({ project, machine: {}, budget: {}, reason: 'test', dry: true, mergeq: false, fix: false, slop: false, overlap: false });
  const r = go();
  assert.match(r.msg, /check-in .* running/);
  assert.equal(d.item(a).state, 'lost'); assert.equal(d.item(a).resume.refused, 'cap 0/0');
  assert.match(r.lost_notice.body, /^run supervisor gone: 1 run lost, 0 relaunched/);
  assert.equal(go().lost_notice, undefined, 'once');
});
