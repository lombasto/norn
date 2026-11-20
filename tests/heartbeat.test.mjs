// Heartbeat resilience (owner report 2026-11-19: solve-shack RUN-257 read 'lost' for 3 min while alive - the rename onto its .hb failed
// on Windows while another process held the file, and the beat swallowed the error). The writer lands a fresh beat past a blocked
// rename and logs the streak; a stale .hb with a live supervisor and advancing output reads 'heartbeat late', never lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { hbWriter, hbPath, hbLate, sweepLost, liveRuns } from '../engine/lib/runs.mjs';
import { lanesView } from '../engine/lib/lanes.mjs';
import { stateChip } from '../engine/dash/widgets.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';

function sandbox() {
  const t = mkTmp('meta-hb-'), state = path.join(t, 'state', 'demo');
  for (const d of ['hb', 'runs', 'logs']) fs.mkdirSync(path.join(state, d), { recursive: true });
  const item = id => loadState(state).items[id];
  const start = (data = {}) => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'demo', ...data } }).id;
  const hb = (id, o) => fs.writeFileSync(hbPath(state, id), JSON.stringify({ run: id, ts: new Date().toISOString(), ...o }));
  const age = (f, ms) => { const old = new Date(Date.now() - ms); fs.utimesSync(f, old, old); };
  return { t, state, item, start, hb, age };
}
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });

test('hbWriter: a rename that keeps failing EPERM -> the beat is written in place; one log line for the streak, one for the recovery', () => {
  const d = sandbox(), f = hbPath(d.state, 'RUN-1'), logs = [];
  let blocked = true, calls = 0;
  const beat = hbWriter(f, { log: s => logs.push(s), rename: (a, b) => { calls++; if (blocked) throw eperm(); fs.renameSync(a, b); }, waitMs: 1 });
  assert.equal(beat({ n: 1 }), 'in place');
  assert.equal(calls, 5, 'the transient code is retried before the fallback');
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).n, 1);
  assert.ok(!fs.existsSync(`${f}.${process.pid}.tmp`), 'no tmp left behind');
  assert.equal(beat({ n: 2 }), 'in place'); assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).n, 2);
  assert.equal(logs.length, 1); assert.match(logs[0], /rename onto RUN-1\.hb failed \(EPERM\); wrote it in place/);
  blocked = false;
  assert.equal(beat({ n: 3 }), 'rename'); assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).n, 3);
  assert.equal(logs.length, 2); assert.match(logs[1], /rename works again after 2 failed beats/);
  beat({ n: 4 }); assert.equal(logs.length, 2, 'a healthy beat logs nothing');
});

test('hbWriter: rename and in-place write both refused -> its mtime is touched (the age readers go by); nothing at all -> logged as not written', () => {
  const d = sandbox(), f = hbPath(d.state, 'RUN-1'), logs = [];
  d.hb('RUN-1', { n: 0 }); d.age(f, 300e3);
  const refuse = (a, b) => { if (a === f) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); fs.writeFileSync(a, b); };
  assert.equal(hbWriter(f, { log: s => logs.push(s), rename: () => { throw eperm(); }, write: refuse, waitMs: 1 })({ n: 1 }), 'mtime');
  assert.ok(Date.now() - fs.statSync(f).mtimeMs < 60e3, 'the beat is fresh');
  assert.match(logs[0], /wrote its mtime only/);
  const none = hbWriter(f, { log: s => logs.push(s), rename: () => { throw eperm(); }, write: () => { throw eperm(); }, touch: () => { throw eperm(); }, waitMs: 1 });
  assert.equal(none({ n: 2 }), null); assert.match(logs.at(-1), /not written/);
});

// the real thing: a process holding the .hb open the way RUN-257's blocker did (no FILE_SHARE_DELETE) - Windows only
async function holder(f, share) {
  const ps = `$h=[System.IO.File]::Open('${f.replace(/'/g, "''")}','Open','Read','${share}'); 'ready'; Start-Sleep -Seconds 60`;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  await new Promise((res, rej) => { p.stdout.on('data', b => { if (String(b).includes('ready')) res(); }); p.on('exit', c => rej(new Error(`holder exited ${c}`))); });
  return p;
}
for (const [share, how] of [['ReadWrite', 'in place'], ['Read', 'mtime']]) {
  test(`hbWriter (Windows): a reader holding the .hb with FileShare ${share} blocks the rename - the beat still lands (${how})`, { skip: process.platform !== 'win32' }, async () => {
    const d = sandbox(), f = hbPath(d.state, 'RUN-1'), logs = [];
    d.hb('RUN-1', { n: 0 }); d.age(f, 300e3);
    const p = await holder(f, share);
    try {
      assert.equal(hbWriter(f, { log: s => logs.push(s), waitMs: 5 })({ n: 1 }), how);
      assert.ok(Date.now() - fs.statSync(f).mtimeMs < 60e3, 'a fresh beat');
      if (how === 'in place') assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).n, 1);
      assert.equal(logs.length, 1);
    } finally { p.kill(); }
  });
}

// FILE_SHARE_DELETE on the reader is not enough on Windows: MoveFileEx's replace fails on any open handle of the target. A Node reader
// (libuv opens with every share flag) holding the .hb open still blocks the rename, so the writer's fallback is what lands the beat
test('a Node reader holding the .hb open: the beat still lands (in place on Windows, where it blocks the rename)', () => {
  const d = sandbox(), f = hbPath(d.state, 'RUN-1'), logs = [];
  d.hb('RUN-1', { n: 0 });
  const fd = fs.openSync(f, 'r');
  try { assert.equal(hbWriter(f, { log: s => logs.push(s), waitMs: 5 })({ n: 1 }), process.platform === 'win32' ? 'in place' : 'rename'); } finally { fs.closeSync(fd); }
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).n, 1);
  assert.equal(hbWriter(f, { log: s => logs.push(s) })({ n: 2 }), 'rename', 'the handle closed: the rename works again');
});

test('second signal: a stale .hb with a live supervisor and an advancing log or transcript reads "heartbeat late" and is never swept lost', () => {
  const d = sandbox(), logOf = n => path.join(d.state, 'logs', `demo-${n}.log`);
  const a = d.start({ log: logOf('a') }), b = d.start({ log: logOf('b') }), c = d.start({ log: logOf('c') }), e = d.start({ log: logOf('e'), session_id: 'sid-e' });
  const proj = path.join(d.t, 'projects'); fs.mkdirSync(path.join(proj, 'wt'), { recursive: true });
  fs.writeFileSync(path.join(d.state, 'runs', e + '.spec.json'), JSON.stringify({ run: e, projectsDir: proj, session_id: 'sid-e' }));
  for (const [id, n] of [[a, 'a'], [b, 'b'], [c, 'c'], [e, 'e']]) { fs.writeFileSync(logOf(n), 'x'); d.hb(id, { supervisor_pid: id === c ? deadPid() : process.pid }); d.age(hbPath(d.state, id), 300e3); }
  d.age(logOf('b'), 300e3);                                                       // b: its output is stale too -> lost
  d.age(logOf('e'), 300e3); fs.writeFileSync(path.join(proj, 'wt', 'sid-e.jsonl'), '{}');   // e: the transcript advances, the log does not
  assert.ok(hbLate(d.state, d.item(a))); assert.equal(hbLate(d.state, d.item(b)), null); assert.equal(hbLate(d.state, d.item(c)), null); assert.ok(hbLate(d.state, d.item(e)));
  // the dashboard's lane status and chip, with the same rule the server passes in
  const st = loadState(d.state);
  const status = id => lanesView({ items: { 'L:demo': { kind: 'lane', id: 'L:demo', state: 'active', data: {}, history: [], created: st.items[id].created, updated: st.items[id].created }, [id]: st.items[id] } },
    { hbAge: () => 300e3, hbLate: (_, r) => hbLate(d.state, r) })[0].status;
  assert.equal(status(a).state, 'running'); assert.match(status(a).why, / - heartbeat late \(300 s, output \d+ s ago\)$/); assert.match(stateChip(status(a), { why: true }), /heartbeat late/);
  assert.equal(status(b).state, 'stopped'); assert.match(status(b).why, /^not responding/);
  assert.deepEqual(liveRuns(d.state).map(r => r.id).sort(), [a, e].sort(), 'a late run still counts as live (caps, the lane writer gate)');
  assert.deepEqual(sweepLost(d.state).sort(), [b, c].sort());
  assert.equal(d.item(a).state, 'running'); assert.equal(d.item(e).state, 'running');
  assert.equal(d.item(b).lost.cause, 'stale'); assert.equal(d.item(c).lost.cause, 'gone');
});
