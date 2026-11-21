// RM-26 S2: a decision a check-in records carries the model / effort its run started with (made_under) and the mark "below floor"
// when they were below the check-in floor; the dashboard marks it on Records / Overview, and Settings shows a notice while the check-in
// model / effort in force is below the floor (and not otherwise). Sandbox only: temp state, the shared dash fixture, a private browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { record, loadState } from '../engine/lib/records.mjs';
import { checkinBelow } from '../engine/lib/floor.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { decMark } from '../engine/dash/pages/settings.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture, budget0 } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const decData = { lane: 'gen', question: 'q', choice: 'c', why: 'w', cost: '', source: 's' };
const startRun = (dir, model, effort) => record(dir, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', model, effort } }, { views: false }).id;
const decide = (dir, by, run, data = decData) => record(dir, { kind: 'decision', ev: 'create', by, data }, { run, views: false });

test('checkinBelow: the model below Opus 5.5, the effort below medium on a Claude model; a non-Claude model is not judged', () => {
  assert.deepEqual(checkinBelow({ model: 'claude-opus-5-5', effort: 'medium' }), []);
  assert.deepEqual(checkinBelow({ model: 'claude-sonnet-5-5', effort: 'low' }).map(r => [r.kind, r.value, r.to]), [['model', 'claude-sonnet-5-5', 'claude-opus-5-5'], ['effort', 'low', 'medium']]);
  assert.deepEqual(checkinBelow({ model: 'gpt-5', effort: 'low' }), []);
});

test('a check-in decision carries made_under from its run start; below the floor it is marked, others are not stamped', () => {
  const dir = mkTmp('meta-ckfloor-');
  const low = startRun(dir, 'claude-sonnet-5-5', 'medium'), ok = startRun(dir, 'claude-opus-5-5', 'medium'), bare = record(dir, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin' } }, { views: false }).id;
  const d1 = decide(dir, 'checkin', low), d2 = decide(dir, 'checkin', ok), d3 = decide(dir, 'owner', low), d4 = decide(dir, 'checkin', bare), d5 = decide(dir, 'checkin', null);
  const d6 = decide(dir, 'checkin', ok, { ...decData, made_under: { model: 'claude-haiku-5-5', effort: 'low', below_floor: true } });
  const items = loadState(dir).items;
  assert.deepEqual(items[d1.id].data.made_under, { model: 'claude-sonnet-5-5', effort: 'medium', below_floor: true });
  assert.deepEqual(items[d2.id].data.made_under, { model: 'claude-opus-5-5', effort: 'medium', below_floor: false });
  assert.equal(items[d3.id].data.made_under, undefined, 'an owner decision is not a check-in\'s');
  assert.equal(items[d4.id].data.made_under, undefined, 'a run start without a model: no stamp');
  assert.equal(items[d5.id].data.made_under, undefined, 'no run: no stamp');
  assert.deepEqual(items[d6.id].data.made_under, { model: 'claude-opus-5-5', effort: 'medium', below_floor: false }, 'a caller\'s own made_under is replaced by the run\'s');
  assert.match(decMark(items[d1.id]), /below-floor[^>]*title="made under claude-sonnet-5-5, effort medium">below floor</);
  assert.equal(decMark(items[d2.id]), '');
  assert.equal(decMark(items[d3.id]), '', 'a record without made_under (as every older one) is simply unmarked');
  const html = renderTab('records', { project: 'p', decisions: [items[d1.id], items[d2.id]], directives: [] }, { project: 'p' });
  assert.equal(html.match(/>below floor</g)?.length, 1, 'Records marks the below-floor decision only');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings: the notice shows while the check-in model / effort is below the floor, not otherwise; Records marks the decision', async () => {
  const f = await fixture();
  try {
    let s = await f.get('/api/settings?project=kestrel');
    assert.deepEqual(s.data.checkin_below, [], 'the fixture budget (Opus 5.5, medium) meets the floor');
    assert.doesNotMatch(renderTab('settings', s.data, {}), /checkin-floor-notice/);
    fs.writeFileSync(f.budgetFile, JSON.stringify({ ...budget0, checkin_model: 'claude-sonnet-5-5', checkin_effort: 'low' }, null, 2) + '\n');
    s = await f.get('/api/settings?project=kestrel');
    assert.deepEqual(s.data.checkin_below.map(r => r.key), ['checkin_model', 'checkin_effort']);
    assert.match(renderTab('settings', s.data, {}), /id="checkin-floor-notice".*Model claude-sonnet-5-5 \(floor claude-opus-5-5\) · Effort low \(floor medium\)/s);
    const run = startRun(f.pa.state, 'claude-sonnet-5-5', 'low'), dec = decide(f.pa.state, 'checkin', run);
    const r = await f.get('/api/records?project=kestrel');
    assert.equal(r.data.decisions.find(x => x.id === dec.id).data.made_under.below_floor, true, '/api/records carries the stamp');
  } finally { await f.done(); }
});

test('the browser: the Settings notice and the Records mark at 390 px, no sideways scroll', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    fs.writeFileSync(f.budgetFile, JSON.stringify({ ...budget0, checkin_model: 'claude-sonnet-5-5', checkin_effort: 'low' }, null, 2) + '\n');
    decide(f.pa.state, 'checkin', startRun(f.pa.state, 'claude-sonnet-5-5', 'low'));
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=settings`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'settings' && !!document.querySelector('#checkin-floor-notice')`, 90000), 'Settings shows the notice');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Settings at 390 px');
    await pg.go(`${f.url}/?project=kestrel&tab=records`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'records' && !!document.querySelector('.below-floor')`, 90000), 'Records marks the decision');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Records at 390 px');
  } finally { await pg.close(); await f.done(); }
});
