// META-UX-BUILD S2: ONE sub-view pattern for a dense tab (engine/dash/subviews.mjs) - a summary row of at most 4 numbers, a row of
// 3-4 sub-views, each loading its own capped part on demand, the chosen one in the URL - applied to the Guard page (guardparts.mjs).
// Sandbox only: pure renders, the shared dash fixture (temp dirs, no real ~/.claude) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SUB_CAP, capList, pickSub, subviewPage } from '../engine/dash/subviews.mjs';
import { GUARD_SUBS, guardSummary, guardPart, BATCH_ROWS } from '../engine/dash/guardparts.mjs';
import { renderTab, loadTab, loadParts, partsKey } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const n = k => Array.from({ length: k }, (_, i) => i);
/** a Guard view as guardOf builds it: 100 rows, 12 of them rules rows */
function bigGuard() {
  const rows = n(100).map(i => ({ id: `A-${i}`, type: i < 12 ? 'rules' : 'instructions', severity: i < 30 ? 'medium' : 'low', new: i < 3, why: `why ${i}`, surface: 's',
    path: 'C:/r/CLAUDE.md', line: i + 1, go: { tab: 'context' } }));
  const types = [['code', 'code', 'agents', 0], ['instructions', 'instruction files', 'instructions', 88], ['rules', 'rules', 'instructions', 12]]
    .map(([type, label, tab, open]) => ({ type, label, tab, open, warn: 0, new: 0 }));
  return { project: 'kestrel', rows, types, total: 100, new: 3, pending: false, slop: true, voice: { popups: 'off', daily_cap: 3 }, errors: [],
    ledger: { prose: 7, repeated: 1, enforced: 2, retired: 0 }, trend: { days: ['2026-11-13', '2026-11-14'], series: [{ key: 'rules', label: 'rules', points: [{ x: '2026-11-13', y: 1 }, { x: '2026-11-14', y: 12 }] }] } };
}

test('the shared pattern: the view switch on the page title line (aria-pressed buttons, no tablist), at most 4 numbers, 3-4 sub-views, its part or a loading line; lists capped with their count', () => {
  const views = [['a', 'Alpha', 3], ['b', 'Beta', null], ['c', 'Gamma', 9]];
  const html = subviewPage('kx', { title: 'Kx', lead: '<p id="kx-lead"></p>', numbers: [{ n: 3, label: 'open' }, { n: 1, label: 'new', cls: 'warn' }], views, active: 'c', body: '<ol id="kx-list"></ol>' });
  assert.match(html, /^<div class="phead pagehead" id="kx-head"><h2 class="ptitle">Kx<\/h2><div class="subnav" id="kx-subs" role="group" aria-label="Kx views">/, 'the switch sits in the page header, on the title line');
  assert.ok(!/role="tab/.test(html), 'buttons with aria-pressed, not a tablist (A-10)');
  assert.ok(html.indexOf('id="kx-head"') < html.indexOf('id="kx-lead"') && html.indexOf('id="kx-lead"') < html.indexOf('id="kx-sum"'), 'the header first, then the lead, then the numbers');
  assert.match(html, /id="kx-sum"/);
  assert.equal((html.match(/class="subnum/g) || []).length, 2);
  assert.match(html, /id="kx-sub-c"[^>]*data-act="sub" data-sub="c"[^>]*aria-pressed="true"/);
  assert.match(html, /id="kx-sub-a"[^>]*aria-pressed="false"[^>]*>Alpha <span class="mute">3<\/span>/);
  assert.ok(html.indexOf('id="kx-subs"') < html.indexOf('id="kx-list"'), 'the sub-view row sits above the part');
  assert.match(subviewPage('kx', { numbers: [], views, active: 'a', loading: true }), /id="kx-sub-loading"/);
  assert.throws(() => subviewPage('kx', { numbers: n(5).map(i => ({ n: i, label: 'x' })), views, active: 'a' }), /at most 4 numbers/);
  assert.throws(() => subviewPage('kx', { numbers: [], views: [...views, ['d', 'D'], ['e', 'E']], active: 'a' }), /3-4 sub-views/);
  assert.equal(pickSub(views, 'b'), 'b'); assert.equal(pickSub(views, 'nope'), 'a'); assert.equal(pickSub(views, null), 'a');
  assert.deepEqual(capList(n(100)), { rows: n(SUB_CAP), n: 100 }); assert.equal(SUB_CAP, 40);
  assert.deepEqual(capList(n(100), 80).rows.length, 80);
});

test('the Guard parts: the summary has no list (counts + the top row for his line); each sub-view is one capped part', () => {
  const g = bigGuard(), s = guardSummary(g);
  assert.equal(s.rows, undefined); assert.equal(s.trend, undefined); assert.equal(s.types, undefined);
  assert.deepEqual([s.total, s.new, s.warn, s.ledger.prose], [100, 3, 30, 7]);
  assert.deepEqual(s.counts, { fix: 100, types: 2, rules: 12, age: null });
  assert.equal(s.top.length, 1); assert.equal(s.top[0].id, 'A-0');
  assert.equal(s.labels.rules, 'rules');
  assert.equal(typeof s.sig, 'string');
  assert.notEqual(guardSummary({ ...g, rows: g.rows.map((r, i) => (i ? r : { ...r, new: false })) }).sig, s.sig, 'a row turning old changes the sig');
  assert.deepEqual(GUARD_SUBS.map(x => x[0]), ['fix', 'types', 'rules', 'age']);
  // META-UX-BUILD S5: To fix = batches (check + kind of fix), each with its first BATCH_ROWS rows; one open batch has every row up to the limit
  const fix = guardPart(g, 'fix').fix; assert.deepEqual([fix.nb, fix.n, fix.batches.length], [2, 100, 2]);
  assert.ok(fix.batches.every(b => b.rows.length === BATCH_ROWS), 'a closed batch: its first rows');
  const open = guardPart(g, 'fix', 80, 'instructions|drafts').fix;
  assert.equal(open.open, 'instructions|drafts'); assert.equal(open.batches.find(b => b.key === 'instructions|drafts').rows.length, 80);
  const rules = guardPart(g, 'rules').rules; assert.equal(rules.n, 12); assert.ok(rules.rows.every(r => r.type === 'rules')); assert.equal(rules.ledger.prose, 7);
  assert.equal(guardPart(g, 'types').types.rows.length, 3);
  assert.equal(guardPart(g, 'age').age.trend.series.length, 1);
  assert.throws(() => guardPart(g, 'nope'), e => e.status === 400);
});

test('loadTab(slop): only the summary first; a part of this view already fetched paints at once; loadParts asks for the one sub-view', async () => {
  const g = bigGuard(), s = guardSummary(g), got = [];
  const d = await loadTab('slop', 'kestrel', async u => { got.push(u); return s; }, { sub: 'rules' });
  assert.deepEqual(got, ['/api/guard?project=kestrel&part=summary']);
  assert.deepEqual([d.sub, d.parts_loading, d.limit], ['rules', true, SUB_CAP]);
  const asked = [];
  const part = await loadParts('slop', 'kestrel', d, async u => { asked.push(u); return guardPart(g, new URL(u, 'http://x').searchParams.get('part')); });
  assert.deepEqual(asked, [`/api/guard?project=kestrel&part=rules&limit=${SUB_CAP}`]);
  const d2 = await loadTab('slop', 'kestrel', async () => s, { sub: 'rules', parts: { slop: { key: partsKey('slop', 'kestrel', d), data: part } } });
  assert.equal(d2.parts_loading, false); assert.equal(d2.rules.n, 12);
  const d3 = await loadTab('slop', 'kestrel', async () => s, { sub: 'fix', parts: { slop: { key: partsKey('slop', 'kestrel', d), data: part } } });
  assert.equal(d3.parts_loading, true, 'another sub-view = another part');
  assert.equal((await loadTab('slop', 'kestrel', async () => s, {})).sub, 'fix', 'no sub in the URL = the first sub-view');
  assert.equal((await loadTab('slop', 'kestrel', async () => s, { kind: 'ready' })).kind, 'ready', 'the To fix chip (&kind=) rides into the page');
});

test('the Slop page: no banner, no counter row, no footer - 4 sub-views, then the list; the lead holds only what is acted on', () => {
  const g = bigGuard(), s = guardSummary(g), base = { ...s, limit: SUB_CAP };
  const view = sub => renderTab('slop', { ...base, sub, ...guardPart(g, sub), parts_loading: false }, { project: 'kestrel' });
  const fix = view('fix');
  for (const id of ['slop-subs', 'slop-rows', 'slop-A-0']) assert.ok(fix.includes(`id="${id}"`), id);
  for (const id of ['slop-orc', 'slop-line', 'slop-sum', 'slop-about', 'slop-menu', 'slop-plain', 'slop-fixhead']) assert.ok(!fix.includes(`id="${id}"`), `${id} is gone`);
  assert.equal((fix.match(/class="subnum/g) || []).length, 0, 'no counter row');
  assert.ok(!/SloppaChoppa|data-act="orc-/.test(fix), 'no banner, no More menu');
  assert.equal((fix.match(/data-act="sub"/g) || []).length, 4);
  assert.match(fix, /data-act="slop-batch" data-batch="instructions\|drafts">all 88</, 'a batch shows its first rows; "all n" opens it');
  assert.match(renderTab('slop', { ...base, sub: 'fix', ...guardPart(g, 'fix', SUB_CAP, 'instructions|drafts'), parts_loading: false }, {}), /showing 40 of 88[^]*data-act="sub-more"/);
  assert.match(view('types'), /id="slop-types"/);
  assert.match(view('rules'), /id="slop-ledger"[^]*id="slop-rule-rows"[^]*id="slop-A-11"/);
  const age = view('age');
  assert.match(age, /id="slop-trend"/);
  assert.match(age, /<details class="lhelp" id="slop-trend-help"><summary aria-label="About this chart">\?<\/summary><div class="small">[^<]*not the open count over time/, 'the By age note is a ? popover');
  assert.match(renderTab('slop', { ...base, sub: 'rules', parts_loading: true }, {}), /id="slop-sub-loading"/);
});

test('the Slop lead: the errors line, one primary action (Fix all), the sent line, the fixer cards', () => {
  const g = bigGuard(), s = guardSummary(g), base = { ...s, limit: SUB_CAP, offer: 3, fixable: 3, errors: ['tests: broke'], sent: [{ id: 'DEC-1', directive: 'DIR-1', open: 2, fixer: { at: 'queued', run: 'RUN-1' } }] };
  const fix = renderTab('slop', { ...base, sub: 'fix', ...guardPart(g, 'fix'), parts_loading: false }, { project: 'kestrel' });
  const lead = fix.slice(fix.indexOf('id="slop-head"'), fix.indexOf('id="slop-rows"'));
  assert.match(lead, /id="slop-errors">tests: broke</);
  assert.equal((lead.match(/class="primary"/g) || []).length, 1, 'one primary action');
  assert.match(lead, /<button class="primary" data-act="fixall-open" id="slop-fixall">Fix all \(3\)<\/button>/);
  assert.match(lead, /id="slop-sent">[^]*fixer RUN-1 queued/);
  assert.ok(lead.indexOf('id="slop-errors"') < lead.indexOf('id="slop-fixall"') && lead.indexOf('id="slop-fixall"') < lead.indexOf('id="slop-sent"'));
});

test('To fix: the Open / Ready chips (&kind=ready filters what the part holds) and plain section heads', () => {
  const g = bigGuard(), s = guardSummary(g), base = { ...s, limit: SUB_CAP, total: 100, kinds: { ...s.kinds, ready: 0 } };
  const fix = renderTab('slop', { ...base, sub: 'fix', ...guardPart(g, 'fix'), parts_loading: false }, {});
  assert.match(fix, /class="fchips slop-show"[^]*data-act="slop-kind" data-kind="" aria-pressed="true">Open <b>100<\/b>[^]*data-act="slop-kind" data-kind="ready" aria-pressed="false">Ready <b>0<\/b>/);
  assert.match(fix, /id="slop-drafts" data-kind="drafts"><h2>To draft <span class="mute small">\d+<\/span><\/h2>/, 'just the kind and its count');
  const ready = renderTab('slop', { ...base, sub: 'fix', kind: 'ready', ...guardPart(g, 'fix'), parts_loading: false }, {});
  assert.ok(!ready.includes('id="slop-drafts"') && !ready.includes('id="slop-count"'), 'Ready shows only the ready kind');
  assert.match(ready, /data-kind="ready" aria-pressed="true"/);
  assert.match(ready, /nothing ready/);
});

test('Per type: the closed store (lib/slophist.mjs) adds closed and 7-day counts per bar, the types that never caught anything and the fastest growing', () => {
  const g = bigGuard(), s = guardSummary(g), base = { ...s, limit: SUB_CAP };
  const hist = { since: '2026-11-01T00:00:00.000Z', types: { instructions: { closed: 5, opened7: 9, closed7: 2, net7: 7 }, rules: { closed: 1, opened7: 0, closed7: 1, net7: -1 } } };
  const html = renderTab('slop', { ...base, sub: 'types', types: { ...guardPart(g, 'types').types, hist }, parts_loading: false }, {});
  assert.match(html, /id="slop-type-sum">Nothing caught since 2026-11-01: code\. Growing fastest \(7 days, opened minus closed\): instruction files \+7\.<\/p>/);
  assert.match(html, /5 closed · 7 days: \+9 \/ -2/);
  assert.match(renderTab('slop', { ...base, sub: 'types', ...guardPart(g, 'types'), parts_loading: false }, {}), /id="slop-type-sum">Closed findings are counted from the next full scan/, 'no store yet: one line says so');
  assert.equal(guardPart({ ...g, hist }, 'types').types.hist, hist, 'the part carries it');
});

test('GET /api/guard?part=: the summary + one part; no part = the full view the chips on other tabs read', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    let s = (await f.get('/api/guard?project=kestrel&part=summary')).data;
    for (let i = 0; s.pending && i < 1200; i++) { await new Promise(r => setTimeout(r, 100)); s = (await f.get('/api/guard?project=kestrel&part=summary')).data; }
    assert.equal(s.rows, undefined); assert.ok(Number.isInteger(s.total) && s.counts && s.sig);
    const fix = (await f.get('/api/guard?project=kestrel&part=fix&limit=2')).data.fix;
    assert.ok(fix.batches.length <= 2 && fix.n === s.total && Number.isInteger(fix.nb), JSON.stringify(fix).slice(0, 200));
    assert.equal((await f.get('/api/guard?project=kestrel&part=nope')).status, 400);
    assert.ok(Array.isArray((await f.get('/api/guard?project=kestrel')).data.rows), 'the full view stays for the chips');
  } finally { await f.done(); }
});

// RM-18 S1 moved `const nav` into paintNav() and left render()'s scroll-into-view on the bare name: the FIRST visit to each tab threw
// "Refresh failed: nav is not defined" (S.navTab was already set, so a second click worked). Every nav tab, first visit, no error.
test('every page of the bar and the More sheet paints on its first visit: no "Refresh failed"', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage([1280, 900]);
  try {
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes'`, 60000), 'lanes painted');
    const tabs = JSON.parse(await pg.ev(`JSON.stringify([...document.querySelectorAll('#tabs [data-tab], #more-sheet [data-tab]')].map(b => b.dataset.tab).filter(t => t !== 'lanes'))`));
    assert.ok(tabs.length >= 3, `nav tabs found: ${tabs}`);
    for (const t of tabs) {
      const was = await pg.ev(`document.body.dataset.tab`);
      if (was === t) continue;
      await pg.ev(`document.querySelector('#tabs [data-tab="${t}"], #more-sheet [data-tab="${t}"]').click()`);
      assert.ok(await pg.until(`document.body.dataset.tab !== '${was}' && (document.body.dataset.ready === document.body.dataset.tab || document.body.dataset.ready === 'error')`, 60000), `${t}: painted or failed`);
      assert.notEqual(await pg.ev(`document.body.dataset.ready`), 'error', `${t}: ${await pg.ev(`document.querySelector('#error').textContent`)}`);
      assert.equal(await pg.ev(`document.querySelector('#error').textContent`), '', `${t}: no error line`);
    }
  } finally { await pg.close(); await f.done(); }
});

test('the chosen sub-view lives in the URL: a shared link lands on it, a tap pushes it, Back returns, reload keeps it', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(); let pg;
  try {
    pg = await openPage([390, 844]);
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });   // the phone, as the Instructions phone test
    const sel = () => pg.ev(`document.querySelector('#slop-subs [aria-pressed=true]')?.dataset.sub ?? null`);
    const painted = sub => pg.until(`document.querySelector('#slop-sub[data-sub=${sub}]') && !document.querySelector('#slop-sub-loading') && document.querySelector('#slop-subs [aria-pressed=true]')?.dataset.sub === '${sub}'`, 60000);
    await pg.go(`${f.url}/?project=kestrel&tab=slop&sub=rules`);
    assert.ok(await painted('rules'), 'a shared link lands on its sub-view');
    assert.equal(await sel(), 'rules');
    await pg.ev(`document.querySelector('#slop-sub-fix').click()`);
    assert.ok(await painted('fix'));
    assert.match(await pg.ev('location.search'), /[?&]sub=fix/);
    await pg.ev('history.back()');
    assert.ok(await painted('rules'), 'Back returns to the sub-view before');
    assert.match(await pg.ev('location.search'), /[?&]sub=rules/);
    await pg.go(`${f.url}/${await pg.ev('location.search')}`);
    assert.ok(await painted('rules'), 'reload keeps it');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on a phone');
  } finally { await pg?.close(); await f.done(); }
});
