// NORN-UI-NAV (SPEC 4.1): the shell - one flat bar (Talk, Lanes, Runs, Inbox, More) as link nav, the More sheet, the status strip
// from GET /api/strip (never the run tree), the router (unknown / retired ids open Lanes), keyed refetch (a pulse refreshes the strip
// only), one needs-you count (the badge, the title, the strip and each /api/lanes row's `needs`); the header (UI redesign 2026-11-20):
// the worker pool, the check-ins group box, the cog that opens Settings over the page, local times. Sandbox only: the shared dash
// fixture (temp dirs) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record } from '../engine/lib/records.mjs';
import { isNeed } from '../engine/dash/terms.mjs';
import { TABS } from '../engine/dash/ui.mjs';
import { BAR, MORE, COG, routeTab, renderBar, renderMore, renderStatus, renderCog, checkinStatus, PAGE_KEYS, keysOf, refetchFor } from '../engine/dash/shell.mjs';
import { poolLine } from '../engine/dash/widgets.mjs';
import { fmtTime, fmtDate } from '../engine/dash/cells.mjs';
import { agentOf, agentSessions } from '../engine/lib/agentprocs.mjs';
import { fixture, ENGINE } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const RETIRED = ['overview', 'work', 'health', 'history', 'home'], IDS = TABS.map(t => t[0]);

test('the bar is Talk, Lanes, Runs, Inbox + More: links with aria-current, the Inbox badge, no tablist; More lists every other page but Settings (the cog)', () => {
  assert.deepEqual(BAR.map(b => b[0]), ['talk', 'lanes', 'runs', 'inbox']);
  for (const r of RETIRED) assert.ok(!IDS.includes(r), `${r} retired`);
  const more = MORE.flatMap(([, ids]) => ids);
  assert.deepEqual([...BAR.map(b => b[0]), ...more, COG].sort(), [...IDS].sort(), 'every page once: on the bar, in More or the cog');
  assert.equal(COG, 'settings'); assert.ok(!more.includes('settings'), 'Settings is not a page in More');
  assert.deepEqual(MORE.map(g => g[0]), ['Health', 'History', 'Plan']);
  const html = renderBar('runs', { project: 'p', needs: 4 });
  assert.match(html, /^<nav class="pagebar" id="tabs" aria-label="Pages">/); assert.ok(!/role="tab/.test(html), 'link nav, not a tablist');
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
  for (const id of IDS) assert.equal(routeTab(id), id);
  assert.equal(routeTab('adopt'), 'adopt', 'the setup page');
  for (const id of [...RETIRED, null, '', 'nope']) assert.equal(routeTab(id), 'lanes', String(id));
  const html = fs.readFileSync(path.join(ENGINE, 'dash', 'index.html'), 'utf8');
  assert.ok(!/renderNav|renderBottomBar|destOf|\bNAV\./.test(html), 'the old bars are gone');
});

test('keyed refetch: a pulse refreshes the strip only; a rec refetches the open page only when it reads that file', () => {
  for (const t of IDS) assert.ok(Array.isArray(PAGE_KEYS[t]) && PAGE_KEYS[t].length, `${t} declares its keys`);
  assert.deepEqual(keysOf('pulse', {}), ['strip']);
  assert.deepEqual(refetchFor('runs', keysOf('pulse', {})), { strip: true, page: false });
  assert.deepEqual(refetchFor('runs', keysOf('rec', { file: 'runs' })), { strip: true, page: true });
  assert.deepEqual(refetchFor('records', keysOf('rec', { file: 'runs' })), { strip: true, page: false }, 'Records reads records.jsonl only');
  assert.deepEqual(refetchFor('records', keysOf('rec', { file: 'records' })), { strip: true, page: true });
  assert.deepEqual(refetchFor('settings', keysOf('reset', { file: 'runs' })), { strip: true, page: true }, 'a reset refetches everything');
  assert.deepEqual(refetchFor('lanes', ['chat']), { strip: false, page: false }, 'a chat line is the thread only (Talk)');
  assert.deepEqual(refetchFor('spend', keysOf('derived', {})), { strip: true, page: true });
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
  // merge-slot: the merge slot is its own pool beside the lane workers
  const m = txt(renderStatus({ ...s, running: { ...s.running, merge: { n: 1, cap: 1 } } }, { look: 'classic', project: 'p', now: Date.parse('2030-01-10T12:00:00.000Z') }));
  assert.match(m, /2 running \/ 7 · merge 1 \/ 1/);
});

test('the header: the cog links Settings, the check-ins status line, the worker pool counted apart; times print local, no Z', () => {
  const cog = renderCog('lanes', { project: 'p' });
  assert.match(cog, /^<a href="\?project=p&amp;tab=settings" id="tab-settings" class="cog" data-tab="settings" title="Settings" aria-label="Settings"><svg /);
  assert.match(renderCog('settings', { project: 'p' }), /aria-current="page"/); assert.doesNotMatch(cog, /aria-current/);
  const prev = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Kolkata';   // +05:30, no DST: 22:34Z is 04:04 the next day there
    const now = Date.parse('2026-11-21T00:00:00Z');
    assert.equal(fmtTime('2026-11-20T22:34:00Z', now), '04:04', 'local wall time, no Z');
    assert.equal(fmtTime('2026-11-20T10:00:00Z', now), '11-20 15:30', 'another local day: month-day + time');
    assert.equal(fmtTime('2025-11-20T10:00:00Z', now), '2025-11-20 15:30', 'another year: the full date');
    assert.equal(fmtDate('2026-11-20T22:34:00Z'), '2026-11-21'); assert.equal(fmtTime('nope'), '-'); assert.equal(fmtDate(null), '-');
    const st = checkinStatus({ now: '2026-11-20T22:34:00Z', pause: null, checkin_locked: true }, { live: true });
    assert.equal(st.replace(/<[^>]+>/g, ''), `status ${fmtTime('2026-11-20T22:34:00Z')} · check-ins on · tick running · live`);
    assert.match(checkinStatus({ now: '2026-11-20T22:34:00Z', pause: { label: 'Hold the queue' } }, { live: false, remote: 'phone' }), /<b>Hold the queue<\/b> · reconnecting \.\.\. · remote: phone$/);
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  const txt = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.match(poolLine(null), /id="pool"[^]*…/, 'not come yet');
  const p = poolLine({ claude: { using: 1, cap: 2 }, sessions: { claude: { norn: 1, other: 3 }, codex: { norn: 1, other: 1 } } });
  assert.equal(txt(p), 'Claude 1 / 2 · Codex 1 · other Claude 3'); assert.match(p, /role="group" aria-label="Agent sessions on this computer"/);
  assert.match(p, /title="Codex sessions on this computer: 1 started by Norn, 1 others"/);
  assert.equal(txt(poolLine({ claude: { using: 0, cap: null }, sessions: null })), 'Claude 0 / no cap · Codex not counted · other Claude not counted', 'no cap; a null field reads not counted, never a bare …');
});

test("agentSessions: the Claude Code and Codex CLI sessions on the machine, Norn's apart from the others; one per process tree; the desktop app is not a session", () => {
  assert.equal(agentOf({ name: 'claude.exe', cmd: 'C:\\u\\x\\.local\\bin\\claude.exe -p' }), 'claude');
  assert.equal(agentOf({ name: 'node.exe', cmd: 'node C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' }), 'claude');
  assert.equal(agentOf({ name: 'Claude.exe', cmd: '"C:\\u\\x\\AppData\\Local\\AnthropicClaude\\app-1.0\\Claude.exe"' }), null, 'the desktop app');
  assert.equal(agentOf({ name: 'codex', cmd: '/usr/bin/codex exec' }), 'codex'); assert.equal(agentOf({ name: 'node', cmd: 'node /x/@openai/codex/bin/codex.js' }), 'codex');
  assert.equal(agentOf({ name: 'node.exe', cmd: 'node server.mjs' }), null);
  const procs = [
    { pid: 10, ppid: 1, name: 'node.exe', cmd: 'node engine/bin/supervisor.mjs' },        // a Norn run's supervisor
    { pid: 11, ppid: 10, name: 'claude.exe', cmd: 'claude -p' },                           // its executor: Norn's
    { pid: 20, ppid: 1, name: 'pwsh.exe', cmd: 'pwsh' }, { pid: 21, ppid: 20, name: 'claude.exe', cmd: 'claude' },   // a terminal session
    { pid: 30, ppid: 1, name: 'Code.exe', cmd: 'Code.exe' }, { pid: 31, ppid: 30, name: 'node.exe', cmd: 'node /x/@anthropic-ai/claude-code/cli.js' },
    { pid: 32, ppid: 31, name: 'claude.exe', cmd: 'claude' },                              // under another Claude: the same session
    { pid: 40, ppid: 1, name: 'node.exe', cmd: 'node /x/@openai/codex/bin/codex.js' }, { pid: 41, ppid: 40, name: 'codex.exe', cmd: 'codex.exe' },
    { pid: 50, ppid: 1, name: 'Claude.exe', cmd: 'AnthropicClaude\\Claude.exe' }, { pid: 51, ppid: 50, name: 'Claude.exe', cmd: 'AnthropicClaude\\Claude.exe --type=renderer' },
    { pid: 52, ppid: 50, name: 'claude.exe', cmd: 'C:\\x\\claude-code\\2.1\\claude.exe' },  // a session the desktop app started
  ];
  assert.deepEqual(agentSessions(procs, { norn: new Set([10]) }), { claude: { norn: 1, other: 3 }, codex: { norn: 0, other: 1 } });
  assert.deepEqual(agentSessions([], {}), { claude: { norn: 0, other: 0 }, codex: { norn: 0, other: 0 } });
});

test('the Overview parts re-homed: Lanes shows the first task + setup gaps from the strip, Spend its tiles from the strip and the forecast from /api/plan', async () => {
  const { stripCards, loadTab, renderTab } = await import('../engine/dash/ui.mjs');
  const s = { first_run: { project: 'tide', lane: 'first', caps: {} }, setup: { project: 'tide', rules: false, rules_from: [], gate: null, roadmap: 0, caps: {} },
    usage: { billing: { type: 'api', usd: 3, cap: 20, runs: 2, live_usd: 0 } } };
  const l = stripCards('lanes', s); assert.match(l, /^<div id="strip-cards">/); assert.match(l, /id="first-task"/); assert.match(l, /id="setup-gaps"/); assert.doesNotMatch(l, /burn-api/);
  assert.equal(stripCards('spend', s), '<div id="strip-cards"></div>', 'Spend reads the strip in its tiles: no strip card');
  assert.equal(stripCards('lanes', null), '<div id="strip-cards"></div>', 'the strip not here yet: an empty slot the strip fills');
  const asked = [], get = async r => { asked.push(r.split('?')[0]); return r.startsWith('/api/plan') ? { parts: [{ project: 'tide', forecast: { weekly: null } }] } : { parts: [] }; };
  const d = await loadTab('spend', 'tide', get, { sub: 'forecast' });
  assert.deepEqual(asked.sort(), ['/api/plan', '/api/usage']); assert.deepEqual(d.forecasts, { tide: { weekly: null } }); assert.equal(d.sub, 'forecast');
  assert.match(renderTab('spend', d, { project: 'tide', strip: s }), /id="panel-spend"[^]*id="spend-head"[^]*id="spend-drawer"[^]*id="spend-view-forecast"/);
});

test('shared fixes: fmtMin shows days past 48 h; the server sets the wordmark src (no empty <img> before the art loads)', async () => {
  const { fmtMin } = await import('../engine/dash/cells.mjs');
  assert.equal(fmtMin(59), '59 min'); assert.equal(fmtMin(2879), '47 h 59'); assert.equal(fmtMin(2880), '2 d 0 h'); assert.equal(fmtMin(4 * 1440 + 5 * 60 + 30), '4 d 5 h');
  const f = await fixture();
  try { assert.match(await (await fetch(`${f.url}/`)).text(), /<img class="art h1-norn" data-asset="wordmark" src="\/norn\/art\/wordmark\.png"/); } finally { await f.done(); }
});

test('/api/strip: counts from the run records, never the run tree; /api/lanes rows carry `needs` = their Inbox isNeed rows', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state;
    // a parked lane on an answered question (not a need), an open question on render (a need), an answered one on seabed
    record(S, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'render: which pass', lane: 'render', options: [{ key: 'a', text: 'x' }] } });
    const q3 = record(S, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'seabed: depth', lane: 'seabed', options: [{ key: 'a', text: 'x' }] } });
    record(S, { kind: 'question', ev: 'answer', id: q3.id, by: 'owner', data: { text: 'a', via: 'chat' } });
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

test('the browser: the bar paints before /api/strip answers; both looks; the badge on every page at 1440 and 390 px', { skip: skipWhy, timeout: 300000 }, async () => {
  const f = await fixture(), need = String((await f.get('/api/inbox?project=kestrel')).data.needs_you);
  for (const size of [[1440, 900], [390, 844]]) {
    const pg = await openPage(size);
    try {
      const release = hold(f, /^\/api\/strip\b/);
      await pg.send('Page.navigate', { url: `${f.url}/?project=kestrel&tab=lanes` });
      assert.equal(await pg.until(BAR_IDS, 30000), 'tab-talk,tab-lanes,tab-runs,tab-inbox,tab-more', 'the bar while the strip is held');
      assert.ok(await pg.until(`document.querySelector('#status-strip')?.textContent.includes('…')`), 'the strip waits with "…"');
      release();
      for (const look of ['norn', 'classic']) for (const t of [...IDS, ...RETIRED]) {
        await pg.go(`${f.url}/?project=kestrel&tab=${t}&look=${look}`, 90000);
        const open = RETIRED.includes(t) ? 'lanes' : t;
        assert.equal(await pg.ev('document.body.dataset.tab'), open, `${t} -> ${open}`);
        assert.equal(await pg.ev(BAR_IDS), 'tab-talk,tab-lanes,tab-runs,tab-inbox,tab-more', `${look} ${t}: 5 items`);
        assert.ok(await pg.until(`document.querySelector('#tab-inbox .count')?.textContent === '${need}'`), `${look} ${t} ${size[0]}: the badge`);
        // the bar is drawn, not squashed by another .bar rule (the 6 px meter): full height, the badge inside it
        assert.ok(await pg.ev(`(() => { const n = document.querySelector('#tabs').getBoundingClientRect(), b = document.querySelector('#tab-inbox .count').getBoundingClientRect(); return n.height >= 36 && b.height > 0 && b.top >= n.top - 1 && b.bottom <= n.bottom + 1; })()`), `${look} ${t} ${size[0]}: the bar shows its items`);
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

test('the browser: ?tab=runs&run=RUN-n opens that run\'s document and feed, a reload keeps it, Back leaves it; More opens and Escape returns focus', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    await pg.go(`${f.url}/?project=kestrel&tab=runs&run=RUN-2`, 90000);
    assert.ok(await pg.until(`document.querySelector('#run-doc')?.dataset.run === 'RUN-2' && !!document.querySelector('#run-doc #run-feed #feed-head')?.textContent.includes('RUN-2')`, 30000), 'the run document and its feed show RUN-2');
    assert.match(await pg.ev('location.search'), /tab=runs&run=RUN-2/, 'opening the feed keeps the run URL');
    await pg.go(`${f.url}/?project=kestrel&tab=runs&run=RUN-2`, 90000);
    assert.ok(await pg.until(`document.querySelector('#run-doc')?.dataset.run === 'RUN-2' && !!document.querySelector('#run-feed') && location.search.includes('run=RUN-2')`, 30000), 'a reload keeps it open');
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`, 90000);
    assert.ok(await pg.until(`!!document.querySelector('#main [data-act="lane-feed"]')`, 30000), 'a lane row with a Feed button');
    await pg.ev(`document.querySelector('#main [data-act="lane-feed"]').click()`);
    assert.ok(await pg.until(`location.search.includes('tab=runs') && /run=RUN-/.test(location.search) && !!document.querySelector('#run-feed')`, 30000), 'a Feed link navigates to the run URL');
    await pg.ev('history.back()');
    assert.ok(await pg.until(`document.body.dataset.tab === 'lanes' && !document.querySelector('#run-feed')`, 30000), 'Back leaves the run (its feed stops)');
    await pg.ev(`document.querySelector('#tab-more').focus(); document.querySelector('#tab-more').click()`);
    assert.ok(await pg.until(`!document.querySelector('#more-sheet').hidden`), 'More opens');
    await pg.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.ok(await pg.until(`document.querySelector('#more-sheet').hidden && document.activeElement?.id === 'tab-more'`), 'Escape closes it, focus back on More');
  } finally { await pg.close(); await f.done(); }
});

test('the browser: the header holds the pool, the check-ins box and the cog; the cog opens Settings over the page (Look and Theme inside), Close puts the page back; 1440 and 390 px', { skip: skipWhy, timeout: 300000 }, async () => {
  const f = await fixture();
  try {
    for (const size of [[1440, 900], [390, 844]]) {
      const pg = await openPage(size);
      try {
        await pg.go(`${f.url}/?project=kestrel&tab=lanes`, 90000);
        assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && /^status \\d\\d:\\d\\d · /.test(document.querySelector('#ckbox #status')?.textContent ?? '')`, 30000), 'the status line in the check-ins box: a local time, no Z');
        assert.ok(await pg.ev(`!!document.querySelector('#ckbox #pause') && !!document.querySelector('#ckbox #tick') && !document.querySelector('header #look, header #theme, #more-sheet [data-tab=settings]')`), 'Pause + Run tick in the box; no Look / Theme in the header, no Settings in More');
        assert.ok(await pg.until(`/^Claude workers \\d+ of 2/.test(document.querySelector('#pool')?.textContent ?? '')`, 30000), 'the pool: Claude workers of the machine cap');
        await pg.ev(`document.querySelector('#tab-settings').click()`);
        assert.ok(await pg.until(`document.body.dataset.ready === 'settings' && !document.querySelector('#setview').hidden && !!document.querySelector('#setview .settings')`, 60000), 'the cog opens Settings in the overlay');
        assert.ok(await pg.ev(`!!document.querySelector('#main #panel-lanes') && document.querySelector('#tab-settings').getAttribute('aria-current') === 'page'`), 'the page under it stays; the cog is current');
        const modes = ['system', 'light', 'dark'], was = (await pg.ev(`document.querySelector('#setview [data-act=theme]').textContent`)).slice(7);
        assert.match(await pg.ev(`document.querySelector('#setview [data-act=look]').textContent`), /^Look: (norn|classic)$/); assert.ok(modes.includes(was), was);
        await pg.ev(`document.querySelector('#setview [data-act=theme]').click()`);
        assert.equal(await pg.ev(`document.querySelector('#setview [data-act=theme]').textContent`), `Theme: ${modes[(modes.indexOf(was) + 1) % 3]}`, 'Theme cycles in place');
        assert.ok(await pg.ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `${size[0]}: no sideways scroll with Settings open`);
        await pg.ev(`document.querySelector('#setview [data-act=settings-close]').click()`);
        assert.ok(await pg.until(`document.querySelector('#setview').hidden && document.body.dataset.ready === 'lanes' && /tab=lanes/.test(location.search)`, 60000), 'Close puts the page back');
        assert.ok(await pg.ev(`document.documentElement.scrollWidth <= innerWidth + 1`), `${size[0]}: no sideways scroll`);
      } finally { await pg.close(); }
    }
  } finally { await f.done(); }
});
