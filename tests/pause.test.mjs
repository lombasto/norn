// RM-37 safe pause (pause.mjs): each pause mode's effect on the tick / the fill / the sweep / a hand-off resume; the safe pause of one
// run (the urgent order, a fake worker reaching a paused hand-off, never auto-resumed); the owner's resume queued first; pause half's
// pick; resume all (merges first); the late report. FAKE executor, temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRun, queueRun, fillQueue, readiness, stopRun } from '../engine/lib/runs.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { loadMail } from '../engine/lib/mail.mjs';
import { setPause, clearPause, pauseRun, resumeRun, pickHalf, resumeAll, lateNotice, PauseError, PAUSE_SUBJECT } from '../engine/lib/pause.mjs';
import { PAUSE_MODES, pauseFiles, readPause } from '../engine/lib/pausemode.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 30000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
function sandbox() {
  const t = mkTmp('meta-pause-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  let n = 0;
  d.brief = body => { const f = path.join(t, `brief-${++n}.md`); fs.writeFileSync(f, body); return f; };
  d.wtOf = name => { const w = path.join(t, 'wt-' + name); fs.mkdirSync(w, { recursive: true }); return w; };
  d.item = id => loadState(d.state).items[id];
  d.opts = (o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt, notes: d.notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 3 }, budget: {}, tick: null, paused: pauseFiles(d.state), ...o });
  d.ended = id => waitFor(() => { const it = d.item(id); return settled(it) && it; });
  d.project = (policy = {}) => ({ name: 'demo', root: d.wt, state: d.state, ledger: path.join(t, 'progress.md'), policy });
  return d;
}

// ---------- (1) the modes ----------
test('pause modes: one record per PAUSED file; a hand-made file is Pause everything; each mode says what it does', () => {
  const d = sandbox();
  assert.equal(readPause(pauseFiles(d.state)), null);
  const p = setPause(d.state, { mode: 'queue', by: 'owner', why: 'machine is hot' });
  assert.deepEqual([p.mode, p.label, p.by, p.why], ['queue', 'Hold the queue', 'owner', 'machine is hot']); assert.match(p.at, /^\d{4}-/);
  assert.throws(() => setPause(d.state, { mode: 'nap', by: 'owner' }), PauseError);
  assert.equal(clearPause(d.state), null);
  fs.writeFileSync(path.join(path.dirname(d.state), 'PAUSED'), '');   // the machine-level file, made by hand
  assert.equal(readPause(pauseFiles(d.state)).mode, 'all');
  assert.equal(clearPause(d.state).label, 'Pause everything', 'clearing the project file leaves the machine-level one in force');
  for (const m of Object.values(PAUSE_MODES)) assert.ok(m.label && m.says.length < 140, m.label);
});

test('fill + direct start: Pause check-ins holds nothing; Hold the queue and Pause everything queue every new start, named by mode', async () => {
  const d = sandbox();
  setPause(d.state, { mode: 'checkins', by: 'owner' });
  const a = startRun(d.opts({ brief: d.brief('mode: done\n'), lane: 'a', worktree: d.wtOf('a') }));
  assert.ok(!a.queued, 'Pause check-ins never holds work');
  await d.ended(a.run);
  setPause(d.state, { mode: 'queue', by: 'owner' });
  const b = startRun(d.opts({ brief: d.brief('mode: done\n'), lane: 'b', worktree: d.wtOf('b') }));
  assert.equal(b.queued, true); assert.match(b.why, /^held: Hold the queue \(/);
  const [row] = readiness(d.state);
  assert.deepEqual(row.terms, [`PAUSED queue (${path.join(d.state, 'PAUSED').replace(/\\/g, '/')})`]);
  assert.deepEqual(fillQueue(d.state), []);
  setPause(d.state, { mode: 'all', by: 'owner' });
  assert.match(readiness(d.state)[0].terms[0], /^PAUSED all \(/);
  setPause(d.state, { mode: 'checkins', by: 'owner' });
  const [f] = fillQueue(d.state);
  assert.equal(f.queued, b.run, 'switching to Pause check-ins releases the queue');
  await d.ended(f.next);
});

test('tick: Pause everything exits before the sweep; Pause check-ins sweeps, fills and writes STATUS but launches no check-in; Hold the queue runs the check-in', async () => {
  const { tick } = await import('../engine/lib/tick.mjs');
  const d = sandbox(), go = () => tick({ project: d.project(), machine: {}, budget: {}, reason: 'test', dry: true, mergeq: false, fix: false, slop: false, tests: false, overlap: false });
  // a run whose supervisor is gone: the status sweep records it lost (Pause everything: no sweep)
  const ghost = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', executor: 'fake', lane: 'g', worktree: d.wt, brief: 'b' } }).id;
  fs.mkdirSync(path.join(d.state, 'hb'), { recursive: true }); fs.writeFileSync(path.join(d.state, 'hb', ghost + '.hb'), JSON.stringify({ run: ghost, supervisor_pid: 999999 }));
  setPause(d.state, { mode: 'all', by: 'owner' });
  const r1 = go();
  assert.match(r1.msg, /PAUSED \(Pause everything\) - exit before status or check-in/);
  assert.ok(!fs.existsSync(path.join(d.state, 'STATUS.md')));
  assert.equal(d.item(ghost).state, 'running', 'no sweep');
  setPause(d.state, { mode: 'checkins', by: 'owner' });
  const q = queueRun(d.opts({ brief: d.brief('mode: done\n'), lane: 'q', worktree: d.wtOf('q') }));
  const r2 = go();
  assert.match(r2.msg, /PAUSED \(Pause check-ins\) - no check-in/);
  assert.match(fs.readFileSync(path.join(d.state, 'STATUS.md'), 'utf8'), /- pause: Pause check-ins by owner since .* - Check-ins do not run/);
  assert.ok(!Object.values(loadState(d.state).items).some(i => i.kind === 'run' && i.data.kind === 'checkin'), 'no check-in');
  assert.equal(d.item(q.run).state, 'filled', 'the fill goes on');
  // the sweep goes on: lost (cause gone); with no spec to resume and every pid gone, the same tick's endLost (9cd28e6) ends it
  assert.equal(d.item(ghost).lost?.cause, 'gone', 'the sweep goes on');
  assert.equal(d.item(ghost).state, 'exited', 'endLost goes on');
  await d.ended(d.item(q.run).fill.next);
  setPause(d.state, { mode: 'queue', by: 'owner' });
  const r3 = go();
  assert.match(r3.msg, /check-in RUN-\d+ fake/, 'Hold the queue: the check-in still runs');
  const ck = Object.values(loadState(d.state).items).find(i => i.kind === 'run' && i.data.kind === 'checkin');
  await d.ended(ck.id);
});

// ---------- (2) the safe pause of one run ----------
test('safe pause: the urgent order reaches the worker, it hands off, the hand-off is paused (not auto-resumed); norn resume queues it first', async () => {
  const d = sandbox();
  const other = queueRun(d.opts({ brief: d.brief('mode: done\n'), lane: 'other', worktree: d.wtOf('other'), notBefore: new Date(Date.now() + 3600e3).toISOString() }));
  const r = startRun(d.opts({ brief: d.brief('mode: sleep\nms: 60000\non_pause: 1\n'), lane: 'busy' }));
  await waitFor(() => fs.existsSync(path.join(d.state, 'hb', r.run + '.hb')));
  assert.throws(() => pauseRun(d.state, { run: 'RUN-999', by: 'owner' }), /no such run/);
  const p = pauseRun(d.state, { run: r.run, by: 'owner', why: 'machine is hot' });
  const m = loadMail(d.state)[p.mail];
  assert.deepEqual([m.data.to, m.data.urgent, m.data.subject, m.data.from], [r.run, true, PAUSE_SUBJECT, 'role:owner']);
  assert.match(m.data.body, /commit your work.*norn done --outcome handoff/s);
  assert.throws(() => pauseRun(d.state, { run: r.run, by: 'owner' }), /asked to pause/, 'once');
  const it = await d.ended(r.run);
  assert.equal(it.end.outcome, 'handoff'); assert.deepEqual(it.end.paused, { mail: p.mail, why: 'machine is hot' });
  assert.equal(it.resume, undefined, 'no verdict: the owner resume records it');
  assert.equal(loadMail(d.state)[p.mail].state, 'acked');
  assert.ok(!Object.values(loadState(d.state).items).some(i => i.data?.resume_of === r.run), 'never auto-resumed');
  assert.throws(() => resumeRun(d.state, { run: other.run, by: 'owner' }), /not a paused hand-off/);
  const x = resumeRun(d.state, { run: r.run, by: 'owner' });
  const q = d.item(x.next);
  assert.deepEqual([q.state, q.data.priority, q.data.resume_of], ['queued', 'P0', r.run]);
  assert.equal(readiness(d.state)[0].id, x.next, 'at the front, before the older queued run');
  assert.throws(() => resumeRun(d.state, { run: r.run, by: 'owner' }), /resumed already/);
  assert.equal(d.item(r.run).resume.next, x.next);
  stopRun({ state: d.state, locksDir: d.locks, run: x.next, by: 'owner', why: 'test end' });
});

test('safe pause refuses a helper, a check-in and an ended run; a run asked to pause past clean_min is reported once, never killed', async () => {
  const d = sandbox();
  const r = startRun(d.opts({ brief: d.brief('mode: sleep\nms: 60000\n'), lane: 'slow' }));
  const ck = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin', worktree: d.wt, brief: 'b' } }).id;
  assert.throws(() => pauseRun(d.state, { run: ck, by: 'owner' }), /only a work run is paused/);
  assert.throws(() => pauseRun(d.state, { run: r.run, by: 'checkin' }), /a checkin does not pause a run/, 'a check-in may not pause a run');
  assert.equal(Object.keys(loadMail(d.state)).length, 0, 'refused before any mail');
  pauseRun(d.state, { run: r.run, by: 'owner' });
  assert.equal(lateNotice(d.state, { min: 20 }), null, 'not yet');
  const later = Date.now() + 21 * 60000;
  const n = lateNotice(d.state, { min: 20, now: later, project: 'demo' });
  assert.match(n.title, /demo: 1 run not at a clean point/); assert.match(n.body, new RegExp(`${r.run} \\(slow\\).*does not kill it`));
  assert.equal(lateNotice(d.state, { min: 20, now: later + 60000 }), null, 'once per run');
  assert.equal(d.item(r.run).state, 'running');
  stopRun({ state: d.state, locksDir: d.locks, run: r.run, by: 'owner', why: 'test end' });
  assert.throws(() => pauseRun(d.state, { run: r.run, by: 'owner' }), /not running/);
});

// ---------- (3) pause half, (4) resume all ----------
test('pause half: newest first, never a MERGE, never a run within near_end of its end estimate, never one asked already', () => {
  const d = sandbox(), now = Date.now();
  const mk = (lane, data = {}) => record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', executor: 'fake', lane, worktree: d.wt, brief: 'b', ...data } }).id;
  const a = mk('a'), b = mk('b', { stage: 'MERGE' }), c = mk('c', { budget_min: 1 }), e = mk('e'), f = mk('f'), h = mk('h', { role: 'helper' });
  const pk = pickHalf(d.state, { nearEnd: 10, now });
  assert.deepEqual(pk.pick.map(r => r.id), [f, e, a].slice(0, 3), 'ceil(5 / 2) = 3: newest first, skipping the merge and the near-end run');
  assert.deepEqual(pk.skip.map(r => [r.id, r.why]), [[c, 'within 10 min of its end estimate'], [b, 'a merge']]);
  assert.ok(!pk.pick.concat(pk.skip).some(r => r.id === h), 'a helper is never counted');
  assert.match(pk.line, new RegExp(`^Pause 3 of 5 running: ${f} \\(f\\), ${e} \\(e\\), ${a} \\(a\\); left running: `));
  assert.deepEqual(pickHalf(d.state, { n: 1, nearEnd: 10, now }).pick.map(r => r.id), [f]);
  const cli = spawnSync(process.execPath, [NORN, 'pause', '--half', '--n', '2', '--state', d.state], { encoding: 'utf8', env: { ...process.env, META_ROLE: '' } });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, new RegExp(`confirm: norn pause ${f} ${e} --why "pause half"`));
});

test('resume all: the pause released, every paused hand-off queued (merges first, ahead of new work), then the fill starts them', async () => {
  const d = sandbox();
  const spec = (id, o) => { fs.mkdirSync(path.join(d.state, 'runs'), { recursive: true }); fs.writeFileSync(path.join(d.state, 'runs', id + '.spec.json'), JSON.stringify(d.opts({ brief: d.brief('mode: done\n'), ...o }))); };
  const ended = (lane, o = {}) => {
    const id = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', executor: 'fake', lane, worktree: d.wtOf(lane), brief: 'b', ...o } }).id;
    record(d.state, { kind: 'run', ev: 'pause', id, by: 'owner', data: { mail: 'MAIL-1' } });
    record(d.state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, outcome: 'handoff', paused: { mail: 'MAIL-1' } } });
    spec(id, { lane, worktree: d.wtOf(lane), ...(o.stage ? { stage: o.stage } : {}) });
    return id;
  };
  const w = ended('work'), mg = ended('merge', { stage: 'MERGE' });
  setPause(d.state, { mode: 'queue', by: 'owner' });
  const r = resumeAll(d.state, { by: 'owner' });
  assert.equal(r.cleared.label, 'Hold the queue'); assert.equal(r.still, null);
  assert.deepEqual(r.resumed.map(x => x.run), [mg, w], 'merges first');
  assert.deepEqual(r.resumed.map(x => d.item(x.next).data.priority), ['P0', 'P1']);
  assert.equal(r.started.length, 2);
  for (const s of r.started) await d.ended(s.next);
});
