// Stage LANES (SPEC 4.2): the attention board's data - the board groups (boardOf), the run strip a lane row carries (the Map's
// lane band folded into beads: hand-off joins, helpers, the open question), the "waits for" runs and the PR track step (prStep).
// Pure over a temp records fold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { record, loadState } from '../engine/lib/records.mjs';
import { lanesView, boardOf, prStep } from '../engine/lib/lanes.mjs';
import { LANE_SHOW } from '../engine/dash/pages/lanes.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const run = (s, lane, extra = {}) => record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane, ...extra } }).id;
const end = (s, id, outcome, extra = {}) => record(s, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, outcome, ...extra } });

test('the run strip: oldest left, at most 6, joined on a hand-off chain, a gap on a fresh start, helpers counted, the open question', () => {
  const s = mkTmp('lanes-board-');
  record(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'reef' } });
  const ids = [];
  for (let i = 0; i < 5; i++) { const id = run(s, 'reef'); end(s, id, 'stopped', { why: 'red' }); ids.push(id); }
  const a = run(s, 'reef'); end(s, a, 'handoff'); ids.push(a);
  const b = run(s, 'reef', { resume_of: a }); ids.push(b);   // the hand-off resume, running
  run(s, null, { role: 'helper', parent: b }); run(s, null, { role: 'helper', parent: b });
  const q = record(s, { kind: 'question', ev: 'create', by: 'controller', data: { lane: 'reef', title: 'which tile?' } }).id;
  const l = lanesView(loadState(s)).find(x => x.name === 'reef');
  assert.deepEqual(l.runs.map(r => r.id), ids.slice(-6), 'the last 6 runs, oldest first');
  assert.deepEqual(l.runs.map(r => r.cont), [false, false, false, false, false, true], 'only the resume joins its predecessor');
  assert.equal(l.runs.at(-1).helpers, 2, 'the running bead counts its helpers');
  assert.equal(l.runs.at(-1).cls, 'running'); assert.equal(l.runs[0].cls, 'stopped');
  assert.ok(l.runs.every(r => Number.isInteger(r.min) && r.min >= 0), 'each bead has its minutes');
  assert.equal(l.ask, q, 'the open question on the lane');
  assert.equal(l.runs_total, 7, 'the strip says how many runs it left out');
  assert.equal(l.runs.at(-1).by, null, 'started by hand, not by a check-in');
  assert.equal(l.budget_min, null); assert.equal(l.started, loadState(s).items[b].created);
});

test('waits for: a queued run\'s after-runs are the row\'s waits', () => {
  const s = mkTmp('lanes-board-');
  for (const n of ['up', 'down']) record(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name: n } });
  const u = run(s, 'up');
  record(s, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'down', after: [{ kind: 'run', id: u, state: 'done' }] } });
  const v = lanesView(loadState(s));
  assert.deepEqual(v.find(x => x.name === 'down').waits, [u]);
  assert.deepEqual(v.find(x => x.name === 'up').waits, []);
});

test('boardOf: needs you (Inbox rows only), running, stopped, waiting, to land, parked, done today, old, archived', () => {
  const now = Date.parse('2026-11-20T12:00:00Z'), h = n => new Date(now - n * 3600e3).toISOString();
  const B = (l, n = now) => boardOf({ state: 'active', needs: 0, group: 'needs', run_state: 'exited', outcome: null, ended: h(1), ...l }, n);
  assert.equal(B({ needs: 2, run_state: 'running' }), 'needs', 'an Inbox row names it: needs you, whatever runs');
  assert.equal(B({ state: 'archived', needs: 1 }), 'archived');
  assert.equal(B({ run_state: 'running', group: 'running' }), 'running');
  assert.equal(B({ outcome: 'stopped' }), 'stopped', 'stopped in the last 7 days, no Inbox row');
  assert.equal(B({ run_state: 'lost' }), 'stopped');
  assert.equal(B({ outcome: 'killed', ended: h(8 * 24) }), 'old', 'ended over 7 days ago, not done: Old (Q6)');
  assert.equal(B({ run_state: 'queued', group: 'queued' }), 'waiting');
  assert.equal(B({ run_state: null, group: 'queued' }), 'waiting', 'a lane with no run yet waits for its launch');
  assert.equal(B({ state: 'parked' }), 'parked', 'parked and no Inbox row: Parked');
  assert.equal(B({ group: 'queued', ruled: true }), 'parked', 'its question answered, waiting for the check-in: Parked');
  assert.equal(B({ group: 'done', outcome: 'done', dlv: { step: 'pr', pr: 7 } }), 'land', 'done, not on main: To land');
  assert.equal(B({ group: 'done', outcome: 'done', dlv: { step: 'merged' } }), 'today');
  assert.equal(B({ group: 'done', outcome: 'done', ended: h(30) }), 'old');
  assert.deepEqual(LANE_SHOW.map(g => g[0]), ['needs', 'running', 'stopped', 'waiting', 'land', 'parked', 'today', 'old', 'archived']);
});

test('prStep: done -> PR -> merged -> installed, with the PR number of the newest deliverable', () => {
  assert.equal(prStep([]), null);
  assert.deepEqual(prStep([{ id: 'DLV-1', state: 'done' }]), { step: 'done', install: false, pr: null, url: null, branch: null });
  assert.deepEqual(prStep([{ id: 'DLV-1', state: 'done', pr: { number: 9, url: 'https://github.com/o/r/pull/9' } }]), { step: 'pr', install: false, pr: 9, url: 'https://github.com/o/r/pull/9', branch: null });
  assert.equal(prStep([{ id: 'DLV-2', state: 'merged', merge_pr: 4 }, { id: 'DLV-1', state: 'done' }]).step, 'merged');
  assert.deepEqual(prStep([{ id: 'DLV-3', state: 'installed', pr: { number: 3 } }]), { step: 'installed', install: false, pr: 3, url: null, branch: null });
});
