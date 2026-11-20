// NORN-UI-NAV (SPEC 4.1): the shell - one flat bar (Lanes, Runs, Inbox, Talk, More) as link nav, the More sheet, the status strip
// from GET /api/strip (never the run tree), the router (unknown / retired ids open Lanes), keyed refetch (a pulse refreshes the strip
// only), one needs-you count (the badge, the title, the strip and each /api/lanes row's `needs`). Sandbox only: the shared dash
// fixture (temp dirs) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record } from '../engine/lib/records.mjs';
import { isNeed } from '../engine/dash/terms.mjs';
import { TABS as SERVER_TABS } from '../engine/dash/server.mjs';
import { TABS } from '../engine/dash/ui.mjs';
import { BAR, MORE, routeTab, renderBar, renderMore, renderStatus, PAGE_KEYS, keysOf, refetchFor } from '../engine/dash/shell.mjs';
import { fixture, ENGINE } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const RETIRED = ['overview', 'work', 'health', 'history', 'home'];

test('the bar is Lanes, Runs, Inbox, Talk + More: links with aria-current, the Inbox badge, no tablist; More lists every other page', () => {
  assert.deepEqual(BAR.map(b => b[0]), ['lanes', 'runs', 'inbox', 'talk']);
  assert.deepEqual(TABS.map(t => t[0]), SERVER_TABS, 'one page list');
  for (const r of RETIRED) assert.ok(!SERVER_TABS.includes(r), `${r} retired`);
  const more = MORE.flatMap(([, ids]) => ids);
  assert.deepEqual([...BAR.map(b => b[0]), ...more].sort(), [...SERVER_TABS].sort(), 'every page once: on the bar or in More');
  assert.deepEqual(MORE.map(g => g[0]), ['Health', 'History', 'Plan', '']);
  const html = renderBar('runs', { project: 'p', needs: 4 });
  assert.match(html, /^<nav class="bar" id="tabs" aria-label="Pages">/); assert.ok(!/role="tab/.test(html), 'link nav, not a tablist');
  assert.equal((html.match(/<a /g) || []).length, 4); assert.equal((html.match(/data-act="more"/g) || []).length, 1, '4 links + More');
  assert.match(html, /<a href="\?project=p&amp;tab=runs" id="tab-runs" data-tab="runs" aria-current="page">/);
  assert.match(html, /id="tab-inbox"[^>]*>[^]*?Inbox<\/span><span class="count" aria-label="4 need you">4<\/span><\/a>/);
  assert.match(renderBar('lanes', { project: 'p', needs: 0 }), /Inbox<\/span><\/a>/, 'no badge at 0');
  for (const [k] of BAR) assert.match(html, new RegExp(`id="tab-${k}"[^>]*><svg [^>]*aria-hidden="true"`), `${k}: a drawn glyph beside its word`);
  assert.ok(!/[⚙☰✉⚑]/.test(html), 'no gear / burger / envelope glyph for a page');
  // a More page open: More is current, the sheet marks the page; a Health page in a bad state dots More and its entry
  const m = renderBar('slop', { project: 'p', health: { slop: 'warn' } });
  assert.match(m, /<button[^>]*id="tab-more"[^>]*data-act="more"[^>]*aria-current="page"/); assert.match(m, /class="dot tone-warn"/);
  const sh = renderMore('slop', { project: 'p', health: { slop: 'warn' } });
  for (const id of more) assert.match(sh, new RegExp(`<a href="\\?project=p&amp;tab=${id}" data-tab="${id}"`), `${id} in the sheet`);
  assert.match(sh, /data-tab="slop" aria-current="page"/); assert.match(sh, /<h3>Health<\/h3>/);
  assert.match(sh, /id="more-sheet"[^>]*role="dialog"[^>]*aria-label="More pages"/);
});

test('the router: a page id opens itself; unknown or retired ids open Lanes (no alias table)', () => {
  for (const id of SERVER_TABS) assert.equal(routeTab(id), id);
  assert.equal(routeTab('adopt'), 'adopt', 'the setup page');
  for (const id of [...RETIRED, null, '', 'nope']) assert.equal(routeTab(id), 'lanes', String(id));
  const html = fs.readFileSync(path.join(ENGINE, 'dash', 'index.html'), 'utf8');
  assert.ok(!/renderNav|renderBottomBar|destOf|\bNAV\./.test(html), 'the old bars are gone');
});

test('keyed refetch: a pulse refreshes the strip only; a rec refetches the open page only when it reads that file', () => {
  for (const t of SERVER_TABS) assert.ok(Array.isArray(PAGE_KEYS[t]) && PAGE_KEYS[t].length, `${t} declares its keys`);
  assert.deepEqual(keysOf('pulse', {}), ['strip']);
  assert.deepEqual(refetchFor('runs', keysOf('pulse', {})), { strip: true, page: false });
  assert.deepEqual(refetchFor('runs', keysOf('rec', { file: 'runs' })), { strip: true, page: true });
  assert.deepEqual(refetchFor('records', keysOf('rec', { file: 'runs' })), { strip: true, page: false }, 'Records reads records.jsonl only');
  assert.deepEqual(refetchFor('records', keysOf('rec', { file: 'records' })), { strip: true, page: true });
  assert.deepEqual(refetchFor('settings', keysOf('reset', { file: 'runs' })), { strip: true, page: true }, 'a reset refetches everything');
  assert.deepEqual(refetchFor('lanes', ['chat']), { strip: false, page: false }, 'a chat line is the thread only (Talk)');
  assert.deepEqual(refetchFor('usage', keysOf('derived', {})), { strip: true, page: true });
});

test('the status strip: running / cap, usage vs guard and hourly cap, the next check-in, the needs count; "…" until its data comes', () => {
  const none = renderStatus(null, { look: 'classic' });
  assert.match(none, /id="status-strip"/); assert.equal((none.match(/…/g) || []).length, 4);
  const s = { needs_you: 2, running: { claude: { n: 1, cap: 2 }, codex: { n: 1, cap: 5 } }, usage: { weeklyUsed: 40, weeklyStopPct: 95, rate: 0.2, cap: 0.43, guard: 'ok' },
    checkin: { next: '2030-01-10T12:30:00.000Z', every_min: 30 }, strip: { landed_today: 3, last_landed: null, running: 2, parked: 1, questions: 2, queued: 4 } };
  const txt = h => h.replace(/<[^>]+>/g, '');
  const c = txt(renderStatus(s, { look: 'classic', project: 'p', now: Date.parse('2030-01-10T12:00:00.000Z') }));
  assert.match(c, /2 running \/ 7/); assert.match(c, /40\.0 % of 95 %/); assert.match(c, /0\.20 %\/h of 0\.43/); assert.match(c, /next check-in/); assert.match(c, /2 need you/);
  assert.ok(!/Urd|Verdandi|Skuld/.test(c), 'classic: plain labels');
  const n = txt(renderStatus(s, { look: 'norn', project: 'p', now: Date.parse('2030-01-10T12:00:00.000Z') }));
  assert.match(n, /Urd[^]*Verdandi[^]*Skuld/); assert.match(n, /2 running \/ 7/); assert.match(n, /2 need you/);
});

test('the Overview parts re-homed: Lanes shows the first task + setup gaps from the strip, Usage the API spend from the strip and the forecast from /api/plan', async () => {
  const { stripCards, loadTab, renderTab } = await import('../engine/dash/ui.mjs');
  const s = { first_run: { project: 'tide', lane: 'first', caps: {} }, setup: { project: 'tide', rules: false, rules_from: [], gate: null, roadmap: 0, caps: {} },
    usage: { billing: { type: 'api', usd: 3, cap: 20, runs: 2, live_usd: 0 } } };
  const l = stripCards('lanes', s); assert.match(l, /^<div id="strip-cards">/); assert.match(l, /id="first-task"/); assert.match(l, /id="setup-gaps"/); assert.doesNotMatch(l, /burn-api/);
  const u = stripCards('usage', s); assert.match(u, /id="usage-burn"[^]*id="burn-api"/); assert.doesNotMatch(u, /first-task/);
  assert.equal(stripCards('usage', { usage: { billing: { type: 'plan' } } }), '<div id="strip-cards"></div>', 'plan billing: no spend card');
  assert.equal(stripCards('lanes', null), '<div id="strip-cards"></div>', 'the strip not here yet: an empty slot the strip fills');
  const asked = [], get = async r => { asked.push(r.split('?')[0]); return r.startsWith('/api/plan') ? { parts: [{ project: 'tide', forecast: { weekly: null } }] } : { parts: [] }; };
  const d = await loadTab('usage', 'tide', get);
  assert.deepEqual(asked.sort(), ['/api/plan', '/api/usage']); assert.deepEqual(d.forecasts, { tide: { weekly: null } });
  assert.match(renderTab('usage', d, { project: 'tide', strip: s }), /id="panel-usage"[^]*id="strip-cards"[^]*id="usage-burn"/);
});

test('/api/strip: counts from the run records, never the run tree; /api/lanes rows carry `needs` = their Inbox isNeed rows', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state;
    // a parked lane on an answered question (not a need), an open question on render (a need), an answered one on seabed
    record(S, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'render: which pass', lane: 'render', options: [{ key: 'a', text: 'x' }] } });
    const q3 = record(S, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'seabed: depth', lane: 'seabed', options: [{ key: 'a', text: 'x' }] } });
    record(S, { kind: 'question', ev: 'answer', id: q3.id, by: 'owner', data: { text: 'a', via: 'chat' } });
    const ov = (await f.get('/api/overview?project=kestrel')).data, st = (await f.get('/api/strip?project=kestrel')).data;
    assert.equal(st.needs_you, ov.needs_you, 'one needs-you count'); assert.deepEqual(st.running, { claude: ov.running.claude, codex: ov.running.codex });
    assert.deepEqual(st.usage, ov.burn.usage); assert.deepEqual(st.checkin, ov.strip.checkin); assert.equal(st.strip.questions, ov.strip.questions);
    const items = (await f.get('/api/inbox?project=kestrel')).data.items, lanes = (await f.get('/api/lanes?project=kestrel')).data.lanes;
    for (const l of lanes) assert.equal(l.needs, items.filter(i => isNeed(i) && i.lane === l.name && i.project === l.project).length, l.name);
    assert.ok(lanes.find(l => l.name === 'render').needs >= 1); assert.ok(!items.some(i => i.id === q3.id && isNeed(i)), 'answered: not a need');
    // the strip never builds the run tree: its builder names neither agents() nor overview(), and it answers with the transcripts gone
    const src = fs.readFileSync(path.join(ENGINE, 'dash', 'server.mjs'), 'utf8'), body = src.slice(src.indexOf('async function statusStrip('), src.indexOf('// end statusStrip'));
    assert.ok(body.length > 50 && !/\bagents\(|\boverview\(/.test(body), 'statusStrip reads records, not the tree');
    fs.rmSync(path.join(f.root, 'claude-projects'), { recursive: true, force: true });
    assert.equal((await f.get('/api/strip?project=kestrel')).status, 200);
    assert.equal((await f.get('/api/strip?project=all')).status, 200, 'All projects sums');
  } finally { await f.done(); }
});

// the browser: hold the given routes server-side until release()
function hold(f, re) {
  const srv = f.app.server, hs = srv.listeners('request'), waiting = [];
  srv.removeAllListeners('request');
  srv.on('request', (req, res) => { if (re.test(req.url)) waiting.push(() => hs.forEach(h => h(req, res))); else hs.forEach(h => h(req, res)); });
  return () => { srv.removeAllListeners('request'); hs.forEach(h => srv.on('request', h)); waiting.splice(0).forEach(go => go()); };
}
const BAR_IDS = `[...document.querySelectorAll('#tabs > a, #tabs > button')].map(x => x.id).join()`;

test('the browser: the bar paints before /api/strip and /api/overview answer; both looks; the badge on every page at 1440 and 390 px', { skip: skipWhy, timeout: 300000 }, async () => {
  const f = await fixture(), need = String((await f.get('/api/inbox?project=kestrel')).data.needs_you);
  for (const size of [[1440, 900], [390, 844]]) {
    const pg = await openPage(size);
    try {
      const release = hold(f, /^\/api\/(strip|overview)\b/);
      await pg.send('Page.navigate', { url: `${f.url}/?project=kestrel&tab=lanes` });
      assert.equal(await pg.until(BAR_IDS, 30000), 'tab-lanes,tab-runs,tab-inbox,tab-talk,tab-more', 'the bar while the strip is held');
      assert.ok(await pg.until(`document.querySelector('#status-strip')?.textContent.includes('…')`), 'the strip waits with "…"');
      release();
      for (const look of ['norn', 'classic']) for (const t of [...SERVER_TABS, ...RETIRED]) {
        await pg.go(`${f.url}/?project=kestrel&tab=${t}&look=${look}`, 90000);
        const open = RETIRED.includes(t) ? 'lanes' : t;
        assert.equal(await pg.ev('document.body.dataset.tab'), open, `${t} -> ${open}`);
        assert.equal(await pg.ev(BAR_IDS), 'tab-lanes,tab-runs,tab-inbox,tab-talk,tab-more', `${look} ${t}: 5 items`);
        assert.ok(await pg.until(`document.querySelector('#tab-inbox .count')?.textContent === '${need}'`), `${look} ${t} ${size[0]}: the badge`);
        assert.ok(!(await pg.ev(`[...document.querySelectorAll('.pages, .subnav')].some(x => !x.closest('.phead'))`)), `${t}: no second nav row`);
        assert.ok(await pg.ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `${look} ${t} ${size[0]}: no sideways scroll`);
        if (look === 'norn' && size[0] === 1440) assert.equal(await pg.ev(`document.title`), `(${need}) Norn - kestrel`);
      }
      if (size[0] === 390) {   // phone: 44 px targets, the project name shows
        const small = await pg.ev(`[...document.querySelectorAll('header button:not([hidden]), header select, #tabs a, #tabs button, .hf')].filter(x => x.offsetParent && x.getBoundingClientRect().height < 44).map(x => x.id || x.className || x.tagName).join()`);
        assert.equal(small, '', 'every phone control is at least 44 px tall');
        assert.ok(await pg.ev(`(() => { const s = document.querySelector('#project'); return s.getBoundingClientRect().width >= parseFloat(getComputedStyle(s).fontSize) * 9 * 0.5; })()`), 'the project select keeps ~9ch');
      }
    } finally { await pg.close(); }
  }
  await f.done();
});

test('the browser: ?tab=runs&run=RUN-n opens that run\'s feed, a reload keeps it, Back closes it; More opens and Escape returns focus', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    await pg.go(`${f.url}/?project=kestrel&tab=runs&run=RUN-2`, 90000);
    assert.ok(await pg.until(`!document.querySelector('#feed').hidden && document.querySelector('#feed').textContent.includes('RUN-2')`, 30000), 'the feed is open on RUN-2');
    assert.match(await pg.ev('location.search'), /tab=runs&run=RUN-2/, 'opening the feed keeps the run URL');
    await pg.go(`${f.url}/?project=kestrel&tab=runs&run=RUN-2`, 90000);
    assert.ok(await pg.until(`!document.querySelector('#feed').hidden && document.querySelector('#feed').textContent.includes('RUN-2') && location.search.includes('run=RUN-2')`, 30000), 'a reload keeps it open');
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`, 90000);
    assert.ok(await pg.until(`!!document.querySelector('#main [data-act="lane-feed"]')`, 30000), 'a lane row with a Feed button');
    await pg.ev(`document.querySelector('#main [data-act="lane-feed"]').click()`);
    assert.ok(await pg.until(`location.search.includes('tab=runs') && /run=RUN-/.test(location.search) && !document.querySelector('#feed').hidden`, 30000), 'a Feed link navigates to the run URL');
    await pg.ev('history.back()');
    assert.ok(await pg.until(`document.body.dataset.tab === 'lanes' && document.querySelector('#feed').hidden`, 30000), 'Back closes it');
    await pg.ev(`document.querySelector('#tab-more').focus(); document.querySelector('#tab-more').click()`);
    assert.ok(await pg.until(`!document.querySelector('#more-sheet').hidden`), 'More opens');
    await pg.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.ok(await pg.until(`document.querySelector('#more-sheet').hidden && document.activeElement?.id === 'tab-more'`), 'Escape closes it, focus back on More');
  } finally { await pg.close(); await f.done(); }
});
