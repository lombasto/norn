// META-TEND P6 (DEC-264, owner DIR-36 / DIR-49): SloppaChoppa's badge, his line and the pop-up gate - only a NEW warn-level finding,
// once each, the daily cap, never while the owner types, Mute, one at a time, pop-ups off unless Settings turns them on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ORC_STRIPS } from '../engine/dash/norn/assets.mjs';
import { badgeCount, bestAction, orcLine, inWords, badgeLabel, mayAppear, logAppearance, stillOnly, stageBottom, avoidRects, STRIPS } from '../engine/dash/norn/orc.mjs';

const now = Date.parse('2026-11-14T12:00:00Z');
const rows = [
  { id: 'a', severity: 'high', new: true, first_seen: '2026-11-14T11:00:00Z', why: 'MEMORY.md is over 200 lines.', go: { tab: 'docs', ins: 'm' } },
  { id: 'b', severity: 'medium', new: false, first_seen: '2026-11-10T00:00:00Z', why: 'x', go: { tab: 'tests' } },
  { id: 'c', severity: 'low', new: true, first_seen: '2026-11-14T11:30:00Z', why: 'y', go: { tab: 'docs', doc: 1 } }];

test('the badge: warn-level findings new since the Guard was last opened (never opened = new today); low never counts', () => {
  assert.equal(badgeCount(rows, 0), 1);
  assert.equal(badgeCount(rows, Date.parse('2026-11-09T00:00:00Z')), 2);
  assert.equal(badgeCount(rows, now), 0, 'opening the Guard clears it');
  assert.equal(badgeLabel(2), 'SloppaChoppa: two new findings');
});

test('his line: a template with the number in plain words; the one best action goes to the tab that fixes it', () => {
  assert.equal(inWords(3), 'three'); assert.equal(inWords(0), 'no'); assert.equal(inWords(21), '21');
  assert.equal(orcLine({ rows, fresh: 1 }), 'One new finding. The worst: MEMORY.md is over 200 lines.');
  assert.equal(orcLine({ rows, fresh: 0 }), 'Three open findings. The worst: MEMORY.md is over 200 lines.');
  assert.equal(orcLine({ rows: [] }), 'Nothing open. The tree is tended.');
  assert.equal(orcLine({ rows: [], pending: true }), 'Still looking: the instruction-file scan is running.', 'an unfinished scan is not a tended tree');
  assert.deepEqual(bestAction(rows), { label: 'Fix it in Docs', go: { tab: 'docs', ins: 'm' }, row: rows[0] });
  assert.equal(bestAction([{ go: { tab: 'slop', jump: 'slop-S-f' } }]).label, 'Fix it in Slop', 'a branch block is fixed from its Slop row');
  assert.deepEqual(bestAction([]).go, { tab: 'slop' });
});

test('the pop-up gate: off by default, then once per new warn finding, the daily cap, typing, one at a time', () => {
  assert.equal(mayAppear({ rows, now }).ok, false, 'pop-ups ship off');
  const on = { mode: 'on', rows, now };
  assert.deepEqual([mayAppear(on).ok, mayAppear(on).row.id], [true, 'a']);
  assert.equal(mayAppear({ ...on, typing: true }).why, 'the owner is typing');
  assert.equal(mayAppear({ ...on, onStage: true }).why, 'one appearance at a time');
  let log = logAppearance({}, 'a', now);
  assert.equal(mayAppear({ ...on, log }).why, 'nothing new', 'once per finding; the low one never pops up');
  const many = Array.from({ length: 5 }, (_, i) => ({ id: 'n' + i, severity: 'medium', new: true }));
  log = {}; for (let i = 0; i < 3; i++) { const g = mayAppear({ ...on, rows: many, log }); assert.ok(g.ok); log = logAppearance(log, g.row.id, now); }
  assert.equal(mayAppear({ ...on, rows: many, log }).why, 'daily cap reached (3)');
  assert.ok(mayAppear({ ...on, rows: many, log, now: now + 86400000 }).ok, 'the cap is per day');
  assert.equal(mayAppear({ ...on, rows: many, log: {}, cap: 0 }).ok, false);
});

test('still frames when the mode is quiet or nothing may move; the stage clears Send and the bottom bar; strip times from the art', () => {
  assert.equal(stillOnly('on', true), false); assert.equal(stillOnly('quiet', true), true); assert.equal(stillOnly('on', false), true);
  assert.equal(stageBottom({ innerHeight: 800, avoid: [] }), 16);
  assert.equal(stageBottom({ innerHeight: 800, avoid: [{ top: 700, height: 40 }, { top: 744, height: 56 }, null, { top: 900, height: 10 }] }), 112);
  assert.deepEqual(Object.fromEntries(Object.entries(STRIPS).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0)])),
    { appear: 770, idle: 1800, speak: 740, 'fidget-axe': 1350, 'fidget-look': 2220, chop: 1450, warn: 1280, exit: 1170 });
  for (const [k, v] of Object.entries(STRIPS)) assert.equal(v.length, ORC_STRIPS[k], `${k}: one time per frame of the strip`);
});

test('the stage clears the phone bottom nav: a fixed nav (offsetParent null) is measured by its real rect, a hidden one is skipped; index.html uses it', async () => {
  const el = (rect, fixed) => ({ offsetParent: fixed ? null : {}, getBoundingClientRect: () => rect });
  for (const W of [320, 360, 390, 430]) {                                  // every phone width: the nav's own top, no fixed offset
    const nav = { top: 844 - 58, height: 58, width: W }, send = { top: 0, height: 0, width: 0 };
    const r = avoidRects([el(send, false), el(nav, true), null]);
    assert.deepEqual(r, [nav], 'the fixed nav is measured; a display:none Send (0 x 0) is not');
    assert.equal(stageBottom({ innerHeight: 844, avoid: r }), 58 + 12, 'the stage bottom sits above the nav');
  }
  const nav2 = { top: 900 - 72, height: 72, width: 390 };                 // a taller nav (font scale) -> the stage moves with it
  assert.equal(stageBottom({ innerHeight: 900, avoid: avoidRects([el(nav2, true)]) }), 72 + 12);
  const fs = await import('node:fs'), html = fs.readFileSync(new URL('../engine/dash/index.html', import.meta.url), 'utf8');
  const call = html.match(/avoid:\s*\(\)\s*=>[^\n]*/)?.[0] ?? '';
  assert.match(call, /avoidRects\(/, 'the dash measures the avoided elements with avoidRects');
  assert.ok(!/offsetParent/.test(call), 'no offsetParent test (null for a position:fixed nav)');
});
