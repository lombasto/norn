// Item 8 of lane norn-lifecycle (MAIL-8 / MAIL-9, owner 2026-11-18: "it says i have 2 in my inbox that need my input but ... i don't see
// anything to rule on"): a lane parked on a question the owner ANSWERED is not needs-you - it waits for a check-in to apply the ruling,
// and says so; an answer starts a tick at once; and the check-in can apply a "waive" ruling itself (RUN-61 / RUN-68 passed Q-1 twice:
// a waiver was owner / controller only, so each mailed the controller and left the lane parked).
import test from 'node:test';
import assert from 'node:assert/strict';
import { record, loadState, readEvents, recordsFile, fold, RecordError } from '../engine/lib/records.mjs';
import { lanesView } from '../engine/lib/lanes.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

const rec = (state, ev) => record(state, ev, { views: false });
function parkedOnQ(state, lane = 'ci-fix4') {
  rec(state, { kind: 'lane', ev: 'create', by: 'checkin', data: { name: lane } });
  return rec(state, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'Slop BLOCK on ci-fix4: 3 orphan codex packs', lane, blocks: [lane],
    options: [{ key: 'waive', text: 'waive K14 for state/norn/packs/**' }, { key: 'delete', text: 'delete them' }] } }).id;
}

test('RUN-61 / RUN-68: the owner answered "waive" - the check-in writes that waiver itself (citing the Q), then applies the Q and the lane unparks', () => {
  const state = mkTmp('ruled-wvr-'), q = parkedOnQ(state);
  const waiver = { rule: 'K14', scope: 'state/norn/packs/**', why: 'the owner waived it' };
  assert.throws(() => rec(state, { kind: 'waiver', ev: 'create', by: 'checkin', data: waiver }), RecordError, 'never on its own word');
  assert.throws(() => rec(state, { kind: 'waiver', ev: 'create', by: 'checkin', data: { ...waiver, q } }), /not answered/, 'not before the owner answered');
  rec(state, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'waive', text: 'yes. waive', via: 'chat' } });
  const w = rec(state, { kind: 'waiver', ev: 'create', by: 'checkin', data: { ...waiver, q } });
  assert.equal(fold(readEvents(recordsFile(state, 'waiver'))).items[w.id].state, 'active');
  rec(state, { kind: 'question', ev: 'apply', id: q, by: 'checkin', data: { refs: [w.id] } });
  assert.equal(loadState(state).items['L:ci-fix4'].state, 'active', 'the apply unparks the lane');
});

test('a lane parked on an answered question reads "waiting: your ruling is being applied", not parked / needs you', () => {
  const state = mkTmp('ruled-lane-'), q = parkedOnQ(state);
  rec(state, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'waive', text: 'yes', via: 'chat' } });
  const l = lanesView(loadState(state)).find(x => x.name === 'ci-fix4');
  assert.equal(l.status.state, 'waiting');   // RM-21 S1: the lane's state + its one reason
  assert.match(l.status.why, /^your ruling is being applied \(you ruled: waive/);
  assert.notEqual(l.group, 'needs');
});

test('the dashboard: an answer starts a tick at once; the parked lane leaves the needs-you count and says what it waits for', async () => {
  const f = await fixture();
  try {
    const before = (await f.get('/api/inbox?project=kestrel')).data;
    const row = before.items.find(i => i.type === 'parked' && i.id === 'L:gen');
    assert.ok(row && !row.ruled, 'parked on an open Q: needs you'); assert.equal(row.lane, 'gen', 'the lane name (records.mjs laneName), for the Inbox');
    const t0 = f.counts.ticks;
    const r = await f.post('/api/answer', { project: 'kestrel', id: 'Q-1', choice: 'b', text: 'go' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(f.counts.ticks, t0 + 1, 'the answer starts a tick');
    const after = (await f.get('/api/inbox?project=kestrel')).data;
    const p = after.items.find(i => i.type === 'parked' && i.id === 'L:gen');
    assert.equal(p.ruled?.q, 'Q-1'); assert.equal(p.ruled?.choice, 'b');
    assert.equal(after.needs_you, before.needs_you - 2, 'the Q and its parked lane both leave the count');
  } finally { await f.done(); }
});

test('RUN-61 / RUN-68 in the digest: a check-in that ended after the answer without applying it is named on the Q row - a finding', async () => {
  const { digest } = await import('../engine/lib/digest.mjs');
  const { renderDigest } = await import('../engine/lib/views.mjs');
  const state = mkTmp('ruled-miss-'), q = parkedOnQ(state);
  rec(state, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'waive', text: 'yes', via: 'chat' } });
  const ck = rec(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'claude', lane: 'checkin' } }).id;
  let row = digest(state, {}, { git: () => null }).sections.questions.find(x => x.id === q);
  assert.deepEqual(row.missed ?? [], [], 'a check-in still running has not missed it yet');
  rec(state, { kind: 'run', ev: 'end', id: ck, by: 'launcher', data: { exit: 0, outcome: 'done' } });
  const d = digest(state, {}, { git: () => null });
  row = d.sections.questions.find(x => x.id === q);
  assert.deepEqual(row.missed, [ck]);
  assert.match(renderDigest(d), new RegExp(`${q} answered .*MISSED by ${ck}: apply it first`));
});

test('after the apply the lane says who applied the ruling and what it did, until its next run', () => {
  const state = mkTmp('ruled-applied-'), q = parkedOnQ(state);
  rec(state, { kind: 'question', ev: 'answer', id: q, by: 'owner', data: { choice: 'waive', text: 'yes', via: 'chat' } });
  record(state, { kind: 'question', ev: 'apply', id: q, by: 'checkin', data: { refs: ['WVR-1'] } }, { views: false, run: 'RUN-69' });
  assert.equal(lanesView(loadState(state)).find(x => x.name === 'ci-fix4').status.why, `Applied by RUN-69: your ruling on ${q} (waive) -> WVR-1`);
});
