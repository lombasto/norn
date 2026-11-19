// RM-21 S1 (CAPACITY-UX 4.4): a lane has one of six states - running, waiting, parked, stopped, shipped, idle - each with one reason.
// laneState over record folds on temp dirs: a queued run's why is the fill walk's first reason, shipped comes from a `landed` record or
// a merged deliverable, a running record with an old heartbeat is stopped (not responding).
import test from 'node:test';
import assert from 'node:assert/strict';
import { record, loadState } from '../engine/lib/records.mjs';
import { laneState, lanesView, LANE_STATES } from '../engine/lib/lanes.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const lane = (s, n) => record(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name: n } });
const start = (s, n, extra = {}) => record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: n, ...extra } }).id;
const end = (s, id, data) => record(s, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, ...data } });
const view = (s, o = {}) => Object.fromEntries(lanesView(loadState(s), { all: true, ...o }).map(l => [l.name, l.status]));

test('the six states: running, waiting (the walk\'s first reason), parked (the question text), stopped (its why), shipped, idle', () => {
  const s = mkTmp('rm21-lanes-');
  for (const n of ['run', 'wait', 'park', 'stop', 'ship', 'idle', 'fin']) lane(s, n);
  start(s, 'run', { model: 'claude-opus-5-5', effort: 'high', budget_min: 90 });
  const q = record(s, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'wait' } }).id;
  const Q = record(s, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'choose a relief model', lane: 'park', blocks: ['park'] } }).id;   // parks the lane
  end(s, start(s, 'stop'), { outcome: 'stopped', why: 'red test' });
  const shipped = start(s, 'ship'); end(s, shipped, { outcome: 'stopped', why: 'merge run stopped' });
  record(s, { kind: 'run', ev: 'landed', id: shipped, by: 'controller', data: { why: 'DEC-3: PR #6 is on main' } });
  end(s, start(s, 'fin'), { outcome: 'done' });
  const walk = new Map([[q, { id: q, ready: false, terms: ['cap: 5 claude workers running, budget max_claude_workers=5', 'resources: CPU busy 94 % > fill.max_cpu_pct 90'] }]]);
  const v = view(s, { walk, hbAge: () => 1000 });
  assert.deepEqual(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.state])),
    { run: 'running', wait: 'waiting', park: 'parked', stop: 'stopped', ship: 'shipped', idle: 'idle', fin: 'idle' });
  for (const x of Object.values(v)) assert.ok(LANE_STATES.includes(x.state) && x.why, JSON.stringify(x));
  assert.match(v.run.why, /^claude claude-opus-5-5 high for \d+ min \/ budget 90$/);
  assert.equal(v.wait.why, 'Waiting for a free Claude slot (5 / 5). Next in line. (+ 1 more)');
  assert.equal(v.park.why, `${Q} needs your answer: choose a relief model`, 'the question text, not only its id');
  assert.equal(v.stop.why, 'red test');
  assert.match(v.ship.why, /landed on main \(DEC-3: PR #6 is on main\)/);
  assert.equal(v.idle.why, 'no run yet');
  const noWalk = view(s).wait;
  assert.equal(noWalk.state, 'waiting'); assert.doesNotMatch(noWalk.why, /^queued$/, 'never the bare word');
});

test('shipped: a landed record on the newest work run or a later run; a merged deliverable; a finished lane whose deliverable is not merged waits to merge', () => {
  const s = mkTmp('rm21-ship-');
  for (const n of ['a', 'b', 'c', 'd']) lane(s, n);
  const w = start(s, 'a'); end(s, w, { outcome: 'done' });
  const m = start(s, 'a', { stage: 'MERGE' }); end(s, m, { outcome: 'stopped', why: 'push refused' });
  record(s, { kind: 'run', ev: 'landed', id: m, by: 'controller', data: { why: 'counted merged' } });   // the later (MERGE) run carries it
  const old = start(s, 'b'); end(s, old, { outcome: 'done' });
  record(s, { kind: 'run', ev: 'landed', id: old, by: 'controller', data: { why: 'old work' } });
  end(s, start(s, 'b'), { outcome: 'stopped', why: 'new work stopped' });   // newer work than the landed run: not shipped
  end(s, start(s, 'c'), { outcome: 'done' });
  end(s, start(s, 'd'), { outcome: 'done' });
  const deliverables = [{ id: 'DLV-1', lane: 'c', state: 'merged', pr: { number: 6 } }, { id: 'DLV-2', lane: 'd', state: 'done' }];
  const v = view(s, { deliverables });
  assert.equal(v.a.state, 'shipped'); assert.match(v.a.why, /counted merged/);
  assert.deepEqual([v.b.state, v.b.why], ['stopped', 'new work stopped'], 'a landed OLDER run does not ship newer work');
  assert.deepEqual([v.c.state, v.c.why], ['shipped', 'DLV-1 is on main (PR #6)']);
  assert.deepEqual([v.d.state, v.d.why], ['waiting', 'finished; DLV-2 waits to merge']);
  const rows = lanesView(loadState(s), { all: true, deliverables });
  assert.equal(rows.find(l => l.name === 'a').group, 'done', 'a shipped lane sits with the done lanes');
});

test('not responding: a running record whose heartbeat is older than staleMs is stopped, with the minutes; a fresh one runs', () => {
  const s = mkTmp('rm21-hb-');
  lane(s, 'x'); const id = start(s, 'x');
  const st = loadState(s), r = st.items[id];
  const old = laneState(st.items['L:x'], r, { items: st.items, runs: [r], hbAge: () => 14 * 60000, staleMs: 60000 });
  assert.deepEqual(old, { state: 'stopped', why: 'not responding, no heartbeat for 14 min' });
  assert.equal(laneState(st.items['L:x'], r, { items: st.items, runs: [r], hbAge: () => Infinity, staleMs: 60000 }).why, 'not responding, no heartbeat');
  assert.equal(laneState(st.items['L:x'], r, { items: st.items, runs: [r], hbAge: () => 5000, staleMs: 60000 }).state, 'running');
  assert.equal(lanesView(st, { hbAge: () => 14 * 60000, staleMs: 60000 })[0].group, 'needs', 'a lane that does not respond needs a look');
});
