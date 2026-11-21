// UX review 6: a time chart says what it plots - a labelled 0 baseline, the top of the y axis with its unit, the first / last point and
// the period on the x axis - and the Slop "by age" chart says plainly that it is NOT the open count over time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { columns, lines } from '../engine/dash/widgets.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { GUARD_SUBS } from '../engine/dash/guardparts.mjs';

const yax = h => [...h.matchAll(/<div class="wyax[^>]*><span>([^<]*)<\/span><span>([^<]*)<\/span><\/div>/g)].map(m => [m[1], m[2]]);
const xax = h => [...h.matchAll(/<div class="wcolax small mute"><span>([^<]*)<\/span><span>([^<]*)<\/span><span>([^<]*)<\/span><\/div>/g)].map(m => m.slice(1));

test('columns: the y axis runs from a labelled 0 to the largest value with its unit; the x axis names the ends and the period', () => {
  const h = columns([{ label: '11-01', value: 3 }, { label: '11-02', value: 0 }, { label: '11-03', value: 12 }], { title: 'test cases per day', unit: 'tests', per: 'day' });
  assert.deepEqual(yax(h), [['12 tests', '0']]);
  assert.deepEqual(xax(h), [['11-01', '3 days', '11-03']]);
  assert.match(h, /aria-label="test cases per day \(tests\): 11-01 3, 11-02 0, 11-03 12"/);
  assert.match(h, /style="height:0\.0%"/, 'a zero is a zero-height column on the baseline');
  assert.ok(!/>max /.test(h), 'no bare "max" in the middle of the x axis');
  assert.deepEqual(xax(columns([{ label: 'a', value: 1 }], { per: 'measure' }))[0][1], '1 measure');
});

test('lines: the same axes; the period is the number of days; the aria label names the dates', () => {
  const days = ['2026-11-01', '2026-11-02'], h = lines([{ key: 'a', label: 'A', points: [{ x: days[0], y: 2 }, { x: days[1], y: 5 }] }], { days, title: 'standing tokens', unit: 'tokens' });
  assert.deepEqual(yax(h), [['5 tokens', '0']]);
  assert.deepEqual(xax(h), [['2026-11-01', '2 days', '2026-11-02']]);
  assert.match(h, /aria-label="standing tokens \(tokens\), 2026-11-01 to 2026-11-02: A 5"/);
  assert.match(h, /<line class="lnax" x1="0" y1="146"/, 'the baseline sits at 0');
});

test('Slop: the sub-view is "By age" and the chart says it plots the findings open NOW by the day first seen, not the open count over time', () => {
  assert.deepEqual(GUARD_SUBS.find(x => x[0] === 'age'), ['age', 'By age']);
  const days = ['2026-11-15', '2026-11-16', '2026-11-17'];
  const html = renderTab('slop', { sub: 'age', age: { trend: { days, series: [{ key: 'docs', label: 'Docs', points: days.map((x, i) => ({ x, y: i })) }] } }, total: 2, new: 0, kinds: {}, counts: {} }, { project: 'p' });
  assert.match(html, /id="slop-trend-card"><h2>Open findings by age <span class="mute small">the findings open now, per type, counted from the day each was first seen · last 3 days/);
  assert.match(html, /id="slop-trend-help"><summary[^>]*>\?<\/summary><div class="small">[^<]*not the open count over time/, 'the chart\'s ? help says it');
  assert.ok(!/Is it growing\?/.test(html), 'the old title implied a trend of the open count');
  assert.deepEqual(yax(html), [['2 findings', '0']]);
});
