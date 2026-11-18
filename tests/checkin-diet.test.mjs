// META-CHECKIN-DIET R1: routine ends handled by code (no tick, a launcher record), the end debounce, per-lane check-in levels,
// the settings that steer them and the per-day count. Temp state dirs only; FAKE claude only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, loadState } from '../engine/lib/records.mjs';
import { checkinGate, noteCheckin, wakeClass, routineIds } from '../engine/lib/gate.mjs';
import { routineOf, handleRoutineEnds, checkinPolicy, laneLevel, debounceOf, checkinDays, checkinDayText, wokeBy, checkinDoctorLines } from '../engine/lib/checkins.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { tick } from '../engine/lib/tick.mjs';
import { applySettings, withDefaults, settingsFor, sectionOf } from '../engine/lib/policy.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse('2026-11-08T10:00:00Z');
const at = min => () => new Date(T0 + min * 60000);
const start = (state, min, data = {}) => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'a', ...data } }, { now: at(min), run: null });
const end = (state, id, min, outcome = 'done', extra = {}) => record(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome, exit: 0, ...extra } }, { now: at(min), run: null });
const items = state => loadState(state).items;
const cp = (o = {}) => checkinPolicy({ checkin: o });

test('routine ends: MERGE DONE and a pushed worker DONE on an auto-stage lane are routine; STOPPED / HANDOFF / no-result / unpushed / asked are not', () => {
  const state = path.join(mkTmp('meta-diet-r-'), 'state', 'demo');
  const m = start(state, 0, { lane: 'a', stage: 'MERGE' }), mq = start(state, 0, { lane: 'mq', stage: 'MERGE' });
  const w = start(state, 0, { lane: 'meta-x', worktree: 'W' }), s = start(state, 0, { lane: 'b' }), h = start(state, 0, { lane: 'b' }), n = start(state, 0, { lane: 'b' });
  const u = start(state, 0, { lane: 'meta-y', worktree: 'W' }), q = start(state, 0, { lane: 'meta-z', worktree: 'W' }), ms = start(state, 0, { lane: 'a', stage: 'MERGE' });
  const git = { head: 'a'.repeat(40), branch: 'feat/x', dirty: { files: 0, untracked: 0 } };
  end(state, m.id, 5); end(state, mq.id, 5); end(state, w.id, 5, 'done', git); end(state, s.id, 5, 'stopped'); end(state, h.id, 5, 'handoff'); end(state, n.id, 5, 'no-result');
  end(state, u.id, 5, 'done', { ...git, branch: 'feat/u' }); end(state, q.id, 5, 'done', git); end(state, ms.id, 5, 'stopped');
  const recEvs = [{ kind: 'question', ev: 'create', run: q.id }], pushed = (_wt, b) => b === 'feat/x' || b === 'feat/z';
  const it = items(state), c = cp({ auto_stage: ['meta-*'] }), of = id => routineOf(it[id], { cp: c, recEvs, pushed })?.kind ?? null;
  assert.equal(of(m.id), 'merge_done'); assert.equal(of(mq.id), 'merge_done');
  assert.equal(of(w.id), 'worker_done_stage'); assert.equal(routineOf(it[w.id], { cp: c, pushed }).sha, git.head);
  for (const id of [s.id, h.id, n.id, ms.id]) assert.equal(of(id), null, `${it[id].end.outcome} wakes a model`);
  assert.equal(of(u.id), null, 'an unpushed head wakes a model');
  assert.equal(of(q.id), null, 'a run that asked a question wakes a model');
  assert.equal(routineOf(it[w.id], { cp: cp(), pushed })?.kind ?? null, null, 'no auto-stage lane by default: a worker DONE wakes a model');
  assert.equal(routineOf(it[m.id], { cp: cp({ routine: [] }), pushed }), null, 'routine [] = every end wakes');
  // the wake class of an end that is NOT routine stays MAJOR (a full tick); minor facts stay minor
  assert.equal(wakeClass({ changes: [`+end:${s.id}:exited`, `-run:${s.id}`] }), 'major');
  assert.equal(wakeClass({ changes: [`-run:${m.id}`, '+owner:3'] }), 'minor');
});

test('worker_done_stage: the staged merge (merge-brief --sha, then meta run --queue) or, with a fast merge-queue gate, the queue; each a launcher review', () => {
  const t = mkTmp('meta-diet-s-'), state = path.join(t, 'state', 'demo');
  const w = start(state, 0, { lane: 'meta-x', worktree: 'C:/wt/x', notes: 'C:/rev/meta-x/NOTES.md' });
  end(state, w.id, 5, 'done', { head: 'b'.repeat(40), branch: 'feat/x', dirty: { files: 0, untracked: 0 } });
  const calls = [], cli = a => { calls.push(a); return a[0] === 'run' ? { code: 0, out: 'queued RUN-77 (position 1)' } : { code: 0, out: 'merge-brief -> x' }; };
  const p = { name: 'demo', file: 'C:/p/project.json', root: t, briefs_dir: 'C:/briefs', state, policy: { checkin: { auto_stage: ['meta-*'], merge_agent: 'runner' } } };
  const r = handleRoutineEnds(state, p, { cli, pushed: () => true });
  assert.deepEqual(r.map(x => [x.id, x.kind, x.ok]), [[w.id, 'worker_done_stage', true]]);
  assert.deepEqual(calls[0].slice(0, 1), ['merge-brief']); assert.ok(calls[0].includes('--sha') && calls[0].includes('b'.repeat(40)));
  assert.equal(calls[0][calls[0].indexOf('--notes') + 1], 'C:/rev/meta-x/MERGE-NOTES.md');
  assert.deepEqual(calls[1].slice(0, 2), ['run', '--queue']); assert.equal(calls[1][calls[1].indexOf('--stage') + 1], 'MERGE');
  assert.equal(calls[1][calls[1].indexOf('--agent') + 1], 'runner'); assert.equal(calls[1][calls[1].indexOf('--model') + 1], 'claude-sonnet-5-5');
  const rv = items(state)[w.id].history.find(h => h.ev === 'review');
  assert.equal(rv.by, 'launcher'); assert.equal(rv.data.routine, 'worker_done_stage'); assert.equal(rv.data.queued, 'RUN-77'); assert.match(rv.data.why, /pushed bbbbbbb on feat\/x/);
  // a failed stage leaves the end for the check-in
  const s2 = path.join(t, 'state', 'two'), w2 = start(s2, 0, { lane: 'meta-x', worktree: 'W' });
  end(s2, w2.id, 5, 'done', { head: 'c'.repeat(40), branch: 'feat/y', dirty: { files: 0 } });
  assert.equal(handleRoutineEnds(s2, { ...p, state: s2 }, { cli: () => ({ code: 3, out: 'REFUSED' }), pushed: () => true })[0].ok, false);
  assert.equal(items(s2)[w2.id].review, undefined);
  // the fast merge-queue gate batches the deliverable itself: review only, no CLI
  const r3 = handleRoutineEnds(s2, { ...p, state: s2, merge: { gate: { fast: true } } }, { cli: () => { throw new Error('no CLI'); }, pushed: () => true });
  assert.equal(r3[0].ok, true); assert.match(items(s2)[w2.id].history.find(h => h.ev === 'review').data.why, /merge-queue gate batches/);
});

test('lane levels: none = no fact of its runs; on-end = its ends and stalls only; full = today (starts and progress stalls too)', () => {
  const state = path.join(mkTmp('meta-diet-l-'), 'state', 'demo');
  const c = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin' } }, { now: at(0), run: null });
  noteCheckin(state, { run: c.id, start: new Date(T0).toISOString() });
  end(state, c.id, 1);
  const pol = cp({ none_lanes: ['mq'], on_end_lanes: ['design-*'] }), levelOf = l => laneLevel(pol, l);
  assert.deepEqual(['mq', 'design-x', 'a'].map(levelOf), ['none', 'on-end', 'full']);
  const g = min => checkinGate({ state, budget: {}, now: new Date(T0 + min * 60000), levelOf });
  const n = start(state, 2, { lane: 'mq' }), d = start(state, 2, { lane: 'design-x', budget_min: 10 });
  assert.equal(g(3).run, false, `none + on-end starts: ${g(3).why}`);
  assert.equal(g(25).run, true, 'on-end: past its budget x 2 = a stall still wakes'); assert.match(g(25).why, new RegExp(`stall:${d.id}`));
  end(state, d.id, 26, 'stopped'); end(state, n.id, 26, 'stopped');
  assert.match(g(27).why, new RegExp(`end:${d.id}`)); assert.doesNotMatch(g(27).why, new RegExp(`end:${n.id}`), 'none: not even its end');
  const f = start(state, 28, { lane: 'a' });
  const v = g(29);
  assert.equal(v.run, true); assert.match(v.why, new RegExp(`run:${f.id}`));
});

test('debounce: a wake of ends only waits for the oldest new end + the window; anything else is now', () => {
  const runEvs = [{ kind: 'run', ev: 'start', id: 'RUN-2', ts: '2026-11-08T10:00:00Z', data: {} }, { kind: 'run', ev: 'end', id: 'RUN-2', ts: '2026-11-08T10:10:00Z', data: {} },
    { kind: 'run', ev: 'start', id: 'RUN-3', ts: '2026-11-08T10:00:00Z', data: {} }, { kind: 'run', ev: 'end', id: 'RUN-3', ts: '2026-11-08T10:12:00Z', data: {} }];
  const gate = { run: true, changes: ['+end:RUN-2:exited', '-run:RUN-2', '+end:RUN-3:exited', '-run:RUN-3', '+dlv:DLV-1:done'] };
  const now = min => T0 + min * 60000;
  assert.deepEqual(debounceOf(gate, { runEvs, minutes: 5, now: now(13) }), { until: '2026-11-08T10:15:00.000Z', ends: 2 });
  assert.equal(debounceOf(gate, { runEvs, minutes: 5, now: now(15) }), null, 'the window is over: check in');
  assert.equal(debounceOf(gate, { runEvs, minutes: 0, now: now(13) }), null, 'debounce_min 0 = every end at once');
  for (const x of ['+q:Q-1:open', '+owner:4', '+stall:RUN-9', '+mail:MAIL-1']) assert.equal(debounceOf({ ...gate, changes: [...gate.changes, x] }, { runEvs, minutes: 5, now: now(13) }), null, x);
  assert.equal(debounceOf({ ...gate, forced: true }, { runEvs, minutes: 5, now: now(13) }), null, 'forced');
});

// the dry-tick fixture of tests/gate.test.mjs (fake claude, the status budget fixture)
function tickFixture(policy = {}) {
  const t = mkTmp('meta-diet-t-');
  const root = path.join(t, 'root'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(root, { recursive: true });
  const p = { name: 'demo', root, state, ledger: path.join(t, 'progress.md'), briefs_dir: t, checkin: { cwd: root }, policy };
  const budget = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), 'utf8').replace(/^﻿/, ''));
  const o = { project: p, machine: { claude: { exe: 'x', projects_dir: path.join(t, 'none') } }, budget: { ...budget, calib_time_utc: new Date().toISOString() },
    budgetFile: path.join(t, 'budget.json'), reason: 'test', dry: true, hbMs: 100, staleMs: 600000, fakeMs: 100, mergeq: false };   // the hand-started workers have no heartbeat: never lost here
  const done = id => { for (let i = 0; i < 1200; i++) { if (loadState(state).items[id]?.state === 'exited' && settled(loadState(state).items[id])) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } throw new Error('timeout'); };
  const live = (data = {}) => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'a', ...data } }, { run: null });
  // a record's ts has SECOND resolution and the gate counts an event at ts <= a check-in's start as seen by it: an end written in
  // the same wall second as the check-in it follows (fake claude ends in ~100 ms) would be invisible. Each end is recorded at least
  // one second after the newest record - it happened after them (injected clock, as at() above).
  const after = () => new Date(Math.max(Date.now(), ...Object.values(loadState(state).items).flatMap(i => i.history.map(h => Date.parse(h.ts) + 1000))));
  const fin = (id, outcome = 'done') => record(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome, exit: 0 } }, { now: after, run: null });
  const checkins = () => Object.values(loadState(state).items).filter(i => i.data?.kind === 'checkin').length;
  return { o, state, done, live, fin, checkins };
}

test('routineIds: a launcher routine review in the same (whole) second as the check-in start still counts - record ts has second resolution', () => {
  const ev = ts => ({ kind: 'run', ev: 'review', id: 'RUN-1', by: 'launcher', ts, data: { routine: 'merge_done' } });
  assert.ok(routineIds([ev('2026-11-08T10:00:00Z')], Date.parse('2026-11-08T10:00:00Z')).has('RUN-1'), 'same second as the baseline start');
  assert.ok(!routineIds([ev('2026-11-08T09:59:59Z')], Date.parse('2026-11-08T10:00:00Z')).has('RUN-1'), 'an older review is not this window');
});

test('tick: a routine MERGE DONE end is handled with NO check-in and a launcher record; a STOPPED end still wakes a full one', () => {
  const f = tickFixture({ checkin: { debounce_min: 0 } });
  const m = f.live({ lane: 'a', stage: 'MERGE' }), w = f.live({ lane: 'b' });
  let r = tick(f.o);
  assert.match(r.msg, /check-in RUN-3 /, r.msg); f.done('RUN-3');
  f.fin(m.id);
  r = tick(f.o);
  assert.match(r.msg, /skip: no change since RUN-3/, r.msg);
  assert.equal(f.checkins(), 1, 'no tick for the routine end');
  const rv = loadState(f.state).items[m.id].history.find(h => h.ev === 'review');
  assert.equal(rv.by, 'launcher'); assert.equal(rv.data.routine, 'merge_done'); assert.match(rv.data.why, /ended DONE \(its norn done result\)/);
  assert.match(fs.readFileSync(path.join(f.state, 'tick.log'), 'utf8'), new RegExp(`routine merge_done ${m.id}: reviewed`));
  f.fin(w.id, 'stopped');
  r = tick(f.o);
  assert.match(r.msg, new RegExp(`check-in RUN-4 fake claude-opus-5-5 medium .*gate: major changed: \\+end:${w.id}:exited`), r.msg);
  assert.equal(loadState(f.state).items['RUN-4'].data.tick_class, 'major');
  f.done('RUN-4');
  // the setting obeyed: routine [] = the MERGE end wakes a check-in
  const g = tickFixture({ checkin: { routine: [], debounce_min: 0 } });
  const m2 = g.live({ stage: 'MERGE' });
  assert.match(tick(g.o).msg, /check-in RUN-2 /); g.done('RUN-2');
  g.fin(m2.id);
  assert.match(tick(g.o).msg, new RegExp(`check-in RUN-3 .*end:${m2.id}`));
  g.done('RUN-3');
});

test('tick: the debounce window folds 3 run ends into ONE check-in (one delayed tick spawned at the oldest end + the window)', () => {
  const f = tickFixture({ checkin: { debounce_min: 5 } });
  const ws = [f.live({ lane: 'a' }), f.live({ lane: 'b' }), f.live({ lane: 'c' })];
  assert.match(tick(f.o).msg, /check-in RUN-4 /); f.done('RUN-4');
  const spawned = [], o = { ...f.o, spawnTick: a => spawned.push(a) };
  for (const w of ws) {
    f.fin(w.id, 'stopped');
    const r = tick(o);
    assert.match(r.msg, /skip: debounce: \d end\(s\), one check-in at /, r.msg);
  }
  assert.equal(spawned.length, 1, 'one delayed tick for the window');
  assert.deepEqual(spawned[0].slice(1, 5), ['tick', '--reason', 'debounce', '--at']);
  const later = { ...o, now: () => new Date(Date.parse(spawned[0][5]) + 1000) };
  const r = tick(later);
  assert.match(r.msg, /check-in RUN-5 .*gate: major changed: /, r.msg);
  for (const w of ws) assert.match(r.msg + fs.readFileSync(path.join(f.state, 'tick.log'), 'utf8'), new RegExp(`end:${w.id}`));
  assert.equal(f.checkins(), 2, 'baseline + ONE for the three ends');
  f.done('RUN-5');
});

test('settings: the policy.checkin rows (checkins/schedule) save, lane globs are accepted, unknown routine kinds refused; per-day count', () => {
  const rows = settingsFor().filter(s => s.key.startsWith('policy.checkin.'));
  assert.deepEqual(rows.map(s => s.key).sort(), ['policy.checkin.auto_stage', 'policy.checkin.debounce_min', 'policy.checkin.merge_agent', 'policy.checkin.merge_effort',
    'policy.checkin.merge_model', 'policy.checkin.none_lanes', 'policy.checkin.on_end_lanes', 'policy.checkin.routine']);
  for (const s of rows) assert.deepEqual(sectionOf(s), ['checkins', 'schedule']);
  const b = withDefaults({});
  assert.deepEqual(b.policy.checkin.routine, ['merge_done', 'worker_done_stage']); assert.equal(b.policy.checkin.debounce_min, 5);
  const out = applySettings(b, { 'policy.checkin.on_end_lanes': ['meta-*'], 'policy.checkin.routine': ['merge_done'], 'policy.checkin.debounce_min': 10 });
  assert.deepEqual(out.policy.checkin.on_end_lanes, ['meta-*']); assert.deepEqual(out.policy.checkin.routine, ['merge_done']);
  assert.throws(() => applySettings(b, { 'policy.checkin.routine': ['anything'] }), /policy.checkin.routine/);
  assert.throws(() => applySettings(b, { 'policy.critical_lanes': ['meta-*'] }), /lane names/, 'other lane lists stay plain names');
  // the dashboard line: model check-ins by class + the launcher's routine reviews, per day
  const state = path.join(mkTmp('meta-diet-d-'), 'state', 'demo');
  for (const cls of ['major', 'minor', 'major']) record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin', tick_class: cls } }, { now: at(0), run: null });
  const m = start(state, 1, { stage: 'MERGE' }); end(state, m.id, 2);
  handleRoutineEnds(state, { name: 'demo', state, policy: {} }, { now: at(3) });
  const d = checkinDays(state, { now: T0 + 3600e3 });
  assert.deepEqual(d, [{ day: '2026-11-08', n: 4, mechanical: 1, minor: 1, full: 2 }]);
  assert.equal(checkinDayText(d[0]), 'check-ins: 4 (1 mechanical, 1 minor, 2 full)');
  assert.match(renderTab('context', { sub: 'checkins', rows: [], standing: [], hints: [], suggest: [], checkins: d }, { project: 'demo' }), /2026-11-08<\/td><td>check-ins: <b>4<\/b> \(1 mechanical, 1 minor, 2 full\)/);
  // doctor: the diet in force, and a knob that does nothing
  assert.deepEqual(checkinDoctorLines({ name: 'demo', policy: {} }), [{ level: 'ok', text: 'demo: check-ins: run ends within 5 min share one check-in; done by code, no model turn: a finished merge is reviewed, a finished worker on an auto-merge lane gets its merge queued; auto-merge lanes: none; lanes that never wake a check-in: none; lanes checked only when a run ends: none' }]);
  // SHIP-READY R1: a stranger reads this line in doctor - plain words, no policy keys
  assert.match(checkinDoctorLines({ name: 'demo', policy: { checkin: { auto_stage: ['docs'], none_lanes: ['ci-*'], routine: ['merge_done'] } } })[0].text, /: a finished merge is reviewed; auto-merge lanes: docs; lanes that never wake a check-in: ci-\*;/);
  assert.match(checkinDoctorLines({ name: 'demo', policy: { checkin: { routine: ['merge_done'], auto_stage: ['a'] } } })[1].text, /auto_stage lists lanes but routine has no worker_done_stage/);
  assert.deepEqual(wokeBy('changed: +end:RUN-1:exited, -run:RUN-1, +owner:3'), { lead: 'end', kinds: ['end', 'owner'], facts: ['+end:RUN-1:exited', '-run:RUN-1', '+owner:3'] });
});
