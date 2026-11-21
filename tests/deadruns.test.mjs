// META-CATCH S1 piece 1 - dead runs by code: a run whose supervisor is gone, one started before the machine's boot, and a resume that
// never started are recorded lost (with their cause) by the sweep, and the HANDOFF auto-resume policy relaunches them once. Synthetic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { sweepLost, relaunchLost, lostNotice, hbPath, pidGone } from '../engine/lib/runs.mjs';
import { record, loadState, RecordError } from '../engine/lib/records.mjs';
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

// 2026-11-18: on a machine busy starting processes, live runs' heartbeats fell 210-297 s behind and the sweep recorded them lost
// (cause stale); their heartbeats came back but `end` is accepted only from running, so their own end would have been refused
test('sweep: a run lost for a stale heartbeat comes back alive when its heartbeat is fresh again and its supervisor lives; its end is then accepted', () => {
  const d = sandbox(), a = d.start(), b = d.start(), c = d.start();
  for (const id of [a, b, c]) { d.hb(id, { supervisor_pid: process.pid }); stale(d, id); }
  assert.deepEqual(sweepLost(d.state, { load: () => 0 }).sort(), [a, b, c].sort());   // load: a busy box would make the beats late (MAIL-22)
  for (const id of [a, b, c]) { assert.equal(d.item(id).state, 'lost'); assert.equal(d.item(id).lost.cause, 'stale'); }
  d.hb(a, { supervisor_pid: process.pid });            // a: the beat comes back, supervisor alive -> alive
  d.hb(b, { supervisor_pid: deadPid() });              // b: a fresh file but the supervisor is gone -> stays lost
  sweepLost(d.state, { load: () => 0 });               // c: still stale -> stays lost
  assert.equal(d.item(a).state, 'running');
  assert.match(d.item(a).history.at(-1).data.why, /heartbeat \d+ s old again/);
  assert.equal(d.item(b).state, 'lost'); assert.equal(d.item(c).state, 'lost');
  record(d.state, { kind: 'run', ev: 'end', id: a, by: 'launcher', data: { outcome: 'done', exit: 0 } });
  assert.equal(d.item(a).state, 'exited', 'its own end is accepted after it came back');
  sweepLost(d.state); assert.equal(d.item(a).state, 'exited', 'an ended run is never revived');
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
  assert.deepEqual(sweepLost(d.state, { now: () => new Date(Date.now() + 60e3), load: () => 0 }), [s], 'inside 2 min the resume is only starting');   // load: a busy box would make the beat late (MAIL-22)
  assert.equal(d.item(s).lost.cause, 'stale');
  assert.deepEqual(sweepLost(d.state, { now: () => new Date(Date.now() + 121e3) }), [r]);
  assert.equal(d.item(r).lost.cause, 'no-start'); assert.match(d.item(r).lost.why, /never started/);
});

test('relaunch: a certain death goes through the auto-resume policy once (relaunched + routine review); refused -> the resume record says why; a stale one stays for the check-in', () => {
  const d = sandbox(), a = d.start(), capped = d.start(), off = d.start(), st = d.start(), ck = d.start({ kind: 'checkin' });
  d.spec(a); d.spec(capped, { resumes: 2 }); d.spec(off, { policy: { auto_resume_handoff: false } }); d.spec(st); d.spec(ck);
  for (const id of [a, capped, off, ck]) d.hb(id, { supervisor_pid: deadPid() });
  d.hb(st, { supervisor_pid: process.pid }); stale(d, st);
  sweepLost(d.state, { load: () => 0 });
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

// slop C10: only a state race (RecordError code 2) is the sweep's to skip; a log that does not read (torn line, lock busy: code 1)
// throws - a swallowed resume left the relaunched run relaunchable, and the next sweep started it again
test('relaunch: a resume record that fails on a torn log throws (code 1), never read as done', () => {
  const d = sandbox(), a = d.start();
  d.spec(a); d.hb(a, { supervisor_pid: deadPid() });
  sweepLost(d.state, { load: () => 0 });
  const start = o => { const next = d.start({ resume_of: o.resumeOf }); fs.appendFileSync(path.join(d.state, 'runs.jsonl'), '{"torn"'); return { run: next }; };
  assert.throws(() => relaunchLost(d.state, { start }), e => e instanceof RecordError && e.code === 1 && /torn last line/.test(e.message));
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
  assert.equal(d.item(a).resume.refused, 'cap 0/0');
  assert.equal(d.item(a).state, 'exited', 'refused, its pids gone: the sweep ends it'); assert.equal(d.item(a).end.outcome, 'crash');
  assert.match(r.lost_notice.body, /^run supervisor gone: 1 run lost, 0 relaunched/);
  assert.equal(go().lost_notice, undefined, 'once');
});

// norn RUN-33: start 15:16, lost 15:30 (a stale beat: maybe a stall), reviewed 15:36, no end - it listed as live for hours. Once its
// supervisor and executor are gone the sweep ends it (outcome crash, the lost why); never while a pid lives, never twice.
test('end the lost: start + lost + no live pid -> the sweep writes ONE end (crash, the why) and drops the heartbeat; a live pid is left alone', async () => {
  const { endLost } = await import('../engine/lib/runs.mjs');
  const d = sandbox(), a = d.start(), alive = d.start(), fresh = d.start();
  const dead = deadPid();
  d.hb(a, { supervisor_pid: dead, pid: null }); stale(d, a);
  d.hb(alive, { supervisor_pid: process.pid }); stale(d, alive);
  record(d.state, { kind: 'run', ev: 'lost', id: a, by: 'status', data: { why: 'heartbeat 878 s old', supervisor_pid: dead } });   // RUN-33's record (before causes)
  record(d.state, { kind: 'run', ev: 'review', id: a, by: 'checkin', data: { refs: [] } });
  record(d.state, { kind: 'run', ev: 'lost', id: alive, by: 'status', data: { why: 'heartbeat 900 s old', cause: 'stale', supervisor_pid: process.pid } });
  d.spec(fresh); d.hb(fresh, { supervisor_pid: dead }); sweepLost(d.state);   // a certain death the auto-resume policy has not seen yet
  assert.deepEqual(endLost(d.state), [a], 'not the live supervisor, not a run the relaunch still owns');
  const e = d.item(a);
  assert.equal(e.state, 'exited'); assert.equal(e.end.outcome, 'crash'); assert.match(e.end.why, /lost: heartbeat 878 s old/);
  assert.equal(e.history.filter(h => h.ev === 'end').length, 1);
  assert.equal(fs.existsSync(hbPath(d.state, a)), false, 'no heartbeat file is left to look live');
  assert.equal(d.item(alive).state, 'lost');
  assert.deepEqual(endLost(d.state), [], 'idempotent');
  relaunchLost(d.state, { start: () => { throw new Error('no slot'); } });   // the policy has its say (refused) -> then the sweep ends it
  assert.deepEqual(endLost(d.state), [fresh]);
  assert.equal(d.item(fresh).end.cause, 'gone');
});

// MAIL-22 (norn RUN-80): lost at a 210 s beat while 11 workers held the CPU at 97-100 %; its heartbeat came back 8 min later. A late
// beat is not a death: the sweep revokes `lost` when the beat returns, the end-of-lost never ends it, and a busy CPU stretches the cut.
test('lost, then the heartbeat returns -> alive again (one alive record, running), never ended; lost with a live pid -> not ended', async () => {
  const { endLost } = await import('../engine/lib/runs.mjs');
  const d = sandbox(), a = d.start(), b = d.start();
  d.hb(a, { supervisor_pid: process.pid }); stale(d, a);
  assert.deepEqual(sweepLost(d.state, { load: () => 10 }), [a]);
  assert.equal(d.item(a).state, 'lost');
  // the beat returns after the lost record (the record's ts is whole seconds: the beat is written a second later)
  const back = new Date(Date.now() + 2000); fs.utimesSync(hbPath(d.state, a), back, back);
  assert.deepEqual(endLost(d.state, { now: back.getTime(), gone: () => true }), [], 'a beat newer than the lost record: never ended, whatever the pids say');
  assert.deepEqual(sweepLost(d.state, { now: () => back, load: () => 10 }), []);
  const it = d.item(a);
  assert.equal(it.state, 'running', 'alive again: it counts against the cap and the pages show it running');
  assert.equal(it.history.filter(h => h.ev === 'alive').length, 1);
  assert.match(it.alive.why, /heartbeat \d+ s old again \(lost for a stale heartbeat/);
  sweepLost(d.state, { now: () => back, load: () => 10 });
  assert.equal(d.item(a).history.filter(h => h.ev === 'alive').length, 1, 'idempotent');
  // lost with a live supervisor pid and an old beat: not ended, not revived
  d.hb(b, { supervisor_pid: process.pid }); stale(d, b);
  sweepLost(d.state, { load: () => 10 });
  assert.deepEqual(endLost(d.state), []);
  assert.equal(d.item(b).state, 'lost');
});

test('a busy CPU stretches the cut: a live supervisor\'s beat 210 s old at CPU 98 % is late, not lost (up to 3x the threshold); a quiet CPU, a dead pid or 3x late -> lost', () => {
  const d = sandbox(), late = d.start(), quiet = d.start(), dead = d.start(), hung = d.start();
  const at = (id, s) => { const t = new Date(Date.now() - s * 1000); fs.utimesSync(hbPath(d.state, id), t, t); };
  d.hb(late, { supervisor_pid: process.pid }); at(late, 210);
  d.hb(dead, { supervisor_pid: deadPid() }); at(dead, 210);
  d.hb(hung, { supervisor_pid: process.pid }); at(hung, 400);
  let samples = 0;
  assert.deepEqual(sweepLost(d.state, { load: () => { samples++; return 98; } }).sort(), [dead, hung].sort());
  assert.equal(samples, 1, 'one CPU sample per sweep');
  assert.equal(d.item(late).state, 'running');
  assert.equal(d.item(dead).lost.cause, 'gone');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d.state, 'hb', 'load.json'), 'utf8')).cpu_pct, 98, 'the sample is kept for the pages');
  d.hb(quiet, { supervisor_pid: process.pid }); at(quiet, 210);
  assert.deepEqual(sweepLost(d.state, { load: () => 30 }).sort(), [late, quiet].sort());
  assert.equal(d.item(quiet).lost.cause, 'stale');
  // a sweep with no stale live beat never samples (a sample costs time)
  const e = d.start(); d.hb(e, { supervisor_pid: process.pid });
  assert.deepEqual(sweepLost(d.state, { load: () => { throw new Error('sampled'); } }), []);
});

test('the lanes view: a live supervisor\'s late beat under a busy CPU reads "heartbeat late (N s, CPU x %)"; with no evidence (CPU unknown or quiet, output still) "lost"', async () => {
  const { lanesView } = await import('../engine/lib/lanes.mjs');
  const { hbLate } = await import('../engine/lib/runs.mjs');
  const d = sandbox();
  record(d.state, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'demo', worktree: '/wt/demo' } });
  d.hb(d.start(), { supervisor_pid: process.pid });
  const st = loadState(d.state), view = o => lanesView(st, { hbAge: () => 210e3, hbLate: (_, r, x) => hbLate(d.state, r, x), ...o }).find(l => l.name === 'demo').text;
  assert.match(view({ cpu: 98 }), /^running .* - heartbeat late \(210 s, CPU 98 %\)$/);
  assert.equal(view({}), 'lost');
  assert.equal(view({ cpu: 30 }), 'lost');
  const { stateOf } = await import('../engine/dash/cells.mjs');
  assert.deepEqual(stateOf(view({ cpu: 98 })), ['warn', 'heartbeat late']);
});

// MAIL-28 (2): a supervisor that exits deletes its heartbeat; when its end was refused (RUN-80, RUN-89) the run still read running,
// and the sweep saw no heartbeat and recorded it lost, cause no-start ("the run never started") - a certain death, so relaunchLost
// tried to relaunch a run that had finished. A run that leaves its supervisor's end data, a result.json or an exit line is ended
// from them, never lost; no-start stays for a run with none of them.
test('sweep: a finished run whose end was not recorded (no heartbeat) is ended from its evidence - end.json, result.json, the log exit line - never lost no-start, never relaunched', async () => {
  const { resultDir } = await import('../engine/lib/result.mjs');
  const d = sandbox(), byEnd = d.start(), byResult = d.start(), byExit = d.start(), none = d.start(), wrongRun = d.start();
  const later = { now: () => new Date(Date.now() + 3 * 3600e3), load: () => 0 };
  const res = (id, j) => { fs.mkdirSync(resultDir(d.state, id), { recursive: true }); fs.writeFileSync(path.join(resultDir(d.state, id), j.file), JSON.stringify(j.body)); };
  for (const id of [byEnd, byResult, byExit, none, wrongRun]) d.spec(id, { log: path.join(d.t, id + '.log') });
  res(byEnd, { file: 'end.json', body: { run: byEnd, data: { exit: 0, outcome: 'done', outcome_source: 'result', dod: { ok: true }, supervisor_pid: 4242 } } });
  res(byResult, { file: 'result.json', body: { run: byResult, outcome: 'stopped', why: 'blocked', at: new Date().toISOString() } });
  fs.writeFileSync(path.join(d.t, byExit + '.log'), `${new Date().toISOString()} start\n2026-11-18T10:00:00.000Z exit=1\n`);
  res(wrongRun, { file: 'result.json', body: { run: 'RUN-999', outcome: 'done', at: new Date().toISOString() } });
  assert.deepEqual(sweepLost(d.state, later).sort(), [none, wrongRun].sort(), 'only the runs with no evidence of their own are lost');
  const end = id => d.item(id).history.find(h => h.ev === 'end')?.data;
  assert.equal(d.item(byEnd).state, 'exited');
  assert.equal(end(byEnd).outcome, 'done'); assert.deepEqual(end(byEnd).dod, { ok: true }, "the supervisor's own end data, Done check included");
  assert.match(end(byEnd).swept, /end\.json/);
  assert.equal(end(byResult).outcome, 'stopped'); assert.equal(end(byResult).why, 'blocked'); assert.equal(end(byResult).outcome_source, 'result');
  assert.equal(end(byExit).outcome, 'crash'); assert.equal(end(byExit).exit, 1); assert.match(end(byExit).swept, /exit line/);
  assert.equal(d.item(none).lost.cause, 'no-start');
  assert.deepEqual(relaunchLost(d.state, { start: () => ({ run: 'RUN-X' }) }).map(r => r.id).sort(), [none, wrongRun].sort(), 'no finished run is relaunched');
  assert.deepEqual(sweepLost(d.state, later), [], 'idempotent');
});

test('sweep: a supervisor that is gone (cause gone) but left its end data is ended from it, not lost', async () => {
  const { resultDir } = await import('../engine/lib/result.mjs');
  const d = sandbox(), a = d.start();
  d.hb(a, { supervisor_pid: deadPid() });
  fs.mkdirSync(resultDir(d.state, a), { recursive: true });
  fs.writeFileSync(path.join(resultDir(d.state, a), 'end.json'), JSON.stringify({ run: a, data: { exit: 0, outcome: 'handoff', outcome_source: 'result' } }));
  assert.deepEqual(sweepLost(d.state, { load: () => 0 }), []);
  assert.equal(d.item(a).state, 'exited'); assert.equal(d.item(a).end.outcome, 'handoff');
  assert.equal(fs.existsSync(hbPath(d.state, a)), false, 'its heartbeat goes with the end');
});

test('endLost: a lost run whose supervisor left its end data is ended with that data, not as a crash', async () => {
  const { endLost } = await import('../engine/lib/runs.mjs');
  const { resultDir } = await import('../engine/lib/result.mjs');
  const d = sandbox(), a = d.start();
  d.spec(a, { log: path.join(d.t, 'a.log') });
  const sup = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);   // a supervisor that stalls (lost, stale), then exits
  d.hb(a, { supervisor_pid: sup.pid }); stale(d, a);
  sweepLost(d.state, { load: () => 0 });
  assert.equal(d.item(a).lost.cause, 'stale');
  fs.mkdirSync(resultDir(d.state, a), { recursive: true });
  fs.writeFileSync(path.join(resultDir(d.state, a), 'end.json'), JSON.stringify({ run: a, data: { exit: 0, outcome: 'done', outcome_source: 'result' } }));
  await new Promise(r => { sup.on('exit', r); sup.kill(); });
  stale(d, a);
  assert.deepEqual(endLost(d.state), [a]);
  assert.equal(d.item(a).end.outcome, 'done'); assert.match(d.item(a).end.swept, /end\.json/);
});

// the supervisor's end lands on a run that reads lost (a stall it lived through); a killed run stays refused
test('recordEnd: a run that reads lost takes its end directly; a killed run stays refused', async () => {
  const { recordEnd } = await import('../engine/lib/runs.mjs');
  const d = sandbox(), a = d.start(), k = d.start();
  record(d.state, { kind: 'run', ev: 'lost', id: a, by: 'status', data: { why: 'heartbeat 300 s old', cause: 'stale' } });
  recordEnd(d.state, a, { exit: 0, outcome: 'done' });
  assert.deepEqual(d.item(a).history.map(h => h.ev), ['start', 'lost', 'end']);
  assert.equal(d.item(a).state, 'exited'); assert.equal(d.item(a).end.outcome, 'done');
  record(d.state, { kind: 'run', ev: 'kill', id: k, by: 'owner', data: {} });
  assert.throws(() => recordEnd(d.state, k, { exit: 0, outcome: 'done' }), /is killed/);
});
