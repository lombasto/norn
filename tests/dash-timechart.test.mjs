// Owner list 2026-11-23 items 2 and 9 (SPEC dash-owner-1123 s.2, s.1.4, s.9): the chart kit - timeChart (nice-number ticks, a date
// axis, round dots, a legend that toggles series, an overview strip, the view window), the <norn-chart> wrapper's data + kept window,
// outliers (ranked bars + a log dot strip, Tukey's fence, spread marks, every point a button) and the header's machine line poolLine.
// Pure renders on synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timeChart, nornChart, CHART_VIEWS, niceTicks, outliers, tukey, poolLine } from '../engine/dash/widgets.mjs';

const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];
const S = [{ key: 'checkin', label: 'check-in', points: days.map((x, i) => ({ x, y: [30000, 41000, 52100, 58200][i] })) },
  { key: 'worker', label: 'worker', points: days.map((x, i) => ({ x, y: [20000, 21000, 39400, 41000][i] })) }];
const yLabels = h => [...h.matchAll(/<text class="tcy"[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);
const xLabels = h => [...h.matchAll(/<text class="tcx"[^>]*>([^<]*)<\/text>/g)].map(m => m[1]);
const dots = h => (h.match(/<circle /g) || []).length;
const txt = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('timeChart: nice-number y ticks (Heckbert) with gridlines - the 0..58200 axis reads 0, 20k, 40k, 60k', () => {
  assert.deepEqual(niceTicks(0, 58200), [0, 20000, 40000, 60000]);
  assert.deepEqual(niceTicks(0, 7), [0, 2, 4, 6, 8]);
  const h = timeChart(S, { days, title: 'standing tokens', unit: 'tokens', id: 't1' });
  assert.deepEqual(yLabels(h), ['0', '20k', '40k', '60k']);
  assert.equal((h.match(/<line class="tcgrid"/g) || []).length, 4, 'one gridline per tick');
  assert.deepEqual(xLabels(h), ['11-01', '11-02', '11-03', '11-04'], 'a date axis with day ticks');
});

test('timeChart: round dots on an unstretched viewBox; the aria label is a text summary', () => {
  const h = timeChart(S, { days, title: 'standing tokens', unit: 'tokens', fmt: v => `${v / 1000}k` });
  assert.doesNotMatch(h, /preserveAspectRatio="none"/); assert.match(h, /preserveAspectRatio="xMidYMid meet"/);
  assert.equal(dots(h), 8); assert.ok([...h.matchAll(/<circle [^>]*>/g)].every(m => / r="\d/.test(m[0]) && !/ rx=| ry=/.test(m[0])), 'circles, not ellipses');
  assert.match(h, /role="img"[^>]*aria-label="standing tokens \(tokens\), 2026-11-01 to 2026-11-04: check-in 58.2k, worker 41k"/);
  assert.match(h, /tabindex="0"/, 'focusable for the keys');
});

test('timeChart: the view window clips the points and the axis follows it', () => {
  const h = timeChart(S, { days, view: [1, 2] });
  assert.equal(dots(h), 4, 'two days x two series');
  assert.deepEqual(xLabels(h), ['11-02', '11-03']);
  assert.match(h, /2026-11-02 to 2026-11-03/);
  assert.match(h, /<clipPath id="[^"]+"><rect /, 'a line leaving the window is clipped, not drawn over the axis');
  assert.match(h, /<rect class="tcwin" x="[\d.]+" y="[\d.]+" width="[\d.]+"/, 'the overview strip draws the window');
  assert.match(h, /<button type="button" class="tcreset"[^>]*>Reset<\/button>/);
  assert.match(timeChart(S, { days }), /class="tcreset" disabled/, 'nothing to reset at the full view');
});

test('timeChart: a legend item toggles its series (aria-pressed); a hidden series draws no dots and is named hidden', () => {
  const h = timeChart(S, { days, hidden: ['worker'] });
  assert.match(h, /<button type="button" class="tcleg ln-1" data-series="checkin" aria-pressed="true">/);
  assert.match(h, /<button type="button" class="tcleg ln-2" data-series="worker" aria-pressed="false">/);
  assert.equal(dots(h), 4); assert.match(h, /worker hidden/);
  assert.deepEqual(yLabels(h), ['0', '20k', '40k', '60k']);
  assert.deepEqual(yLabels(timeChart(S, { days, hidden: ['checkin'] })), ['0', '10k', '20k', '30k', '40k', '50k'], 'the y axis fits the shown series');
});

test('timeChart: the per-day read-out names every shown series on that day', () => {
  assert.match(timeChart(S, { days, fmt: v => `${v / 1000}k` }), /<title>2026-11-03: check-in 52.1k · worker 39.4k<\/title>/);
});

test('nornChart: the data rides in a JSON script child (safe against </script>); the kept window (module Map by chart id) survives a repaint', () => {
  const evil = [{ key: 'a', label: '</script><b>x', points: [{ x: days[0], y: 1 }, { x: days[1], y: 2 }] }];
  const h = nornChart(evil, { days, id: 'tc-evil', title: 't' });
  assert.match(h, /^<norn-chart id="tc-evil"><script type="application\/json">/);
  assert.equal((h.match(/<\/script>/g) || []).length, 1, 'the label cannot close the script');
  const json = JSON.parse(h.match(/<script type="application\/json">([^]*?)<\/script>/)[1]);
  assert.equal(json.series[0].label, '</script><b>x'); assert.deepEqual(json.days, days);
  assert.equal(json.series[0].points[1].t, '2', 'each point carries its formatted value (a function cannot ride in JSON)');
  try {
    CHART_VIEWS.set('tc-kept', { view: [2, 3], hidden: [] });
    const r = nornChart(S, { days, id: 'tc-kept' });
    assert.equal(dots(r), 4); assert.deepEqual(xLabels(r), ['11-03', '11-04'], 'a repaint keeps the window');
  } finally { CHART_VIEWS.delete('tc-kept'); }
});

// Tukey (1977) on a fixture: n = 9, linear-interpolated quartiles (type 7, as d3.quantile / numpy): Q1 12, Q3 16, IQR 4, fence 22
const PTS = [10, 11, 12, 13, 14, 15, 16, 100, 200].map((v, i) => ({ id: `t${i}`, label: `test ${i}`, value: v }));
PTS[1].max = 50;   // 50 / 11 > 3: slow sometimes

test('outliers: Tukey upper fence on a fixture; the spread mark; ranked top-N bars; every point a button with the caller\'s act and id', () => {
  assert.deepEqual(tukey(PTS.map(p => p.value)), { q1: 12, q3: 16, fence: 22 });
  const h = outliers(PTS, { top: 3, id: 'slow', act: 'test-open', fmt: v => `${v} ms`, unit: 'ms' });
  const bars = [...h.matchAll(/<button type="button" class="wobar[^"]*" data-act="test-open" data-id="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(bars, ['t8', 't7', 't6'], 'the top 3, slowest first');
  const dotIds = [...h.matchAll(/<button type="button" class="wodot[^"]*" data-act="test-open" data-id="(\w+)"/g)].map(m => m[1]);
  assert.equal(dotIds.length, 9, 'every point in the strip');
  const out = [...h.matchAll(/class="wodot out[^"]*" data-act="test-open" data-id="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(out.sort(), ['t7', 't8'], 'exactly the points past Q3 + 1.5 IQR');
  assert.deepEqual([...h.matchAll(/class="wodot[^"]*spread[^"]*" data-act="test-open" data-id="(\w+)"/g)].map(m => m[1]), ['t1']);
  assert.match(txt(h), /fence 22 ms/); assert.match(txt(h), /outliers \(2\)/);
  assert.match(h, /id="slow"/); assert.match(h, /aria-label="[^"]*9 measured[^"]*2 past the fence/);
  assert.equal(outliers([], {}), '', 'no points: nothing');
});

test('poolLine: the machine line - Claude u / cap · merge n / cap (reserved) · Codex n / cap · other Claude n', () => {
  assert.match(poolLine(null), /id="pool"[^]*…/, 'only before the first strip answer');
  const pool = { claude: { using: 5, cap: 8 }, sessions: { claude: { norn: 5, other: 2 }, codex: { norn: 0, other: 1 } } };
  const running = { claude: { n: 3, cap: 8 }, merge: { n: 1, cap: 1, reserved: true }, codex: { n: 0, cap: 2 } };
  assert.equal(txt(poolLine(pool, running)), 'Claude 5 / 8 · merge 1 / 1 (reserved) · Codex 0 / 2 · other Claude 2');
  assert.match(poolLine(pool, running), /role="group" aria-label="Agent sessions on this computer"/);
  assert.match(poolLine(pool, running), /title="Codex sessions on this computer: 0 started by Norn, 1 others"/);
  assert.equal(txt(poolLine(pool, { ...running, share: { reserve: 2, ceiling: null } })), 'Claude 5 / 8 · merge 1 / 1 (reserved) · Codex 0 / 2 · other Claude 2 · this project: reserve 2, max any');
});

test('poolLine: a field the strip answered as null reads "not counted", never a bare …', () => {
  const h = poolLine({ claude: { using: 0, cap: null }, sessions: null }, { merge: null, codex: { n: 0, cap: 2 } });
  assert.equal(txt(h), 'Claude 0 / no cap · merge not counted · Codex not counted / 2 · other Claude not counted');
  assert.doesNotMatch(h, /…/);
  assert.equal(txt(poolLine({ claude: { using: null, cap: 8 }, sessions: null })), 'Claude not counted / 8 · Codex not counted · other Claude not counted', 'no running yet: no merge part');
});
