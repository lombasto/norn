// S7 dashboard UI (META-GENERAL-DESIGN 7, 12-S7): every tab renders from the S6 /api endpoints on fixture state; server-side
// render check of the ids; no "undefined" / "NaN" in any tab; section-7 rules (status = text + colour, one 15 s tick, badge).
// Temp dirs only; the server binds 127.0.0.1 on a random port; no real claude / codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, ENGINE } from './helpers/dash-fixture.mjs';
import { TABS as SERVER_TABS } from '../engine/dash/server.mjs';
import { TABS, loadTab, loadParts, renderTab, healthStates, pageTitle, needsCount, RM_VIEWS, rmScopeNext, rmHash, rmUrlHash, parseRmHash, rmMatch } from '../engine/dash/ui.mjs';
import { worstState } from '../engine/dash/cells.mjs';
import { MORE } from '../engine/dash/shell.mjs';
import { decorate } from '../engine/dash/docs.mjs';
import { ledgerInline } from '../engine/dash/ledger.mjs';
import { dashCss } from './helpers/dash-css.mjs';

const getter = f => async r => { const x = await f.get(r); if (x.status !== 200) throw new Error(`${r} -> ${x.status} ${x.data.error}`); return x.data; };
const clean = (html, where) => {
  assert.ok(!/undefined|NaN|\[object Object\]|null<|>null\b/.test(html.replace(/<[^>]*>/g, m => m.replace(/"[^"]*"/g, '""'))), `${where}: undefined / NaN / null in text`);
  assert.ok(!/<span class="chip[^"]*">\s*<\/span>/.test(html), `${where}: a chip without text (status = text + colour)`);
};

test('the UI tab list is the server tab list (Lanes ... Settings)', () => {
  assert.deepEqual(TABS.map(t => t[0]), SERVER_TABS);
});

test('Health states: each Health page its own state, the worst one dots More (shell.mjs); unknown = neutral', () => {
  // Health: each page its own state, the destination the worst; unknown = neutral
  assert.deepEqual(healthStates({}), { usage: null, slop: null, tests: null, context: null });
  const h = healthStates({ usage: { guard: 'ok' }, rows: [{ type: 'tests', severity: 'low' }, { type: 'memory', severity: 'medium' }] });
  assert.deepEqual(h, { usage: 'ok', slop: 'ok', tests: 'ok', context: 'warn' });
  assert.equal(worstState(h), 'warn'); assert.equal(worstState({ a: 'ok', b: 'bad', c: 'warn' }), 'bad'); assert.equal(worstState({ a: null }), null);
  assert.equal(healthStates({ usage: { guard: 'ok', rateOK: false } }).usage, 'bad'); assert.equal(healthStates({ usage: { guard: 'STOP' } }).usage, 'bad');
  assert.equal(healthStates({ usage: { guard: 'ok', billing: { type: 'api' } } }).usage, null, 'API billing: no weekly guard to colour');
  assert.equal(healthStates({ rows: [{ type: 'code', severity: 'high' }] }).slop, 'warn');
});

test('every tab renders with fixture state: ids from records / runs / transcripts, no undefined / NaN', async () => {
  const f = await fixture();
  try {
    const get = getter(f), out = {};
    for (const [tab] of TABS) { const d0 = await loadTab(tab, 'kestrel', get), d = tab === 'runs' ? { ...d0, ...await loadParts(tab, 'kestrel', d0, get), parts_loading: false } : d0; out[tab] = renderTab(tab, d, { project: 'kestrel' });
      clean(out[tab], tab); if (tab === 'runs') { out.runDoc = renderTab(tab, d, { project: 'kestrel', run: 'RUN-1' }); clean(out.runDoc, 'run doc'); out.runDoc2 = renderTab(tab, d, { project: 'kestrel', run: 'RUN-2' }); }   // Runs: the live part, then its history part
      assert.ok(out[tab].includes(`id="panel-${tab}"`), tab); }
    const has = (tab, ...ids) => { for (const id of ids) assert.ok(out[tab].includes(id), `${tab} shows ${id}`); };
    has('inbox', 'id="q-Q-1"', 'Choose (a) - recommended', 'Choose (b)', 'RUN-1', 'L:gen', 'STOPPED');
    has('lanes', 'id="lane-gen"', 'id="lane-render"', 'id="lane-seabed"', 'parked by Q-1', 'exited: STOPPED: red test', 'codex-sol', 'RUN-2');
    has('runs', 'id="node-RUN-1"', 'id="node-RUN-2"', 'gpt-5.4'); has('runDoc2', '60,559');   // the tokens: in the run drawer's facts
    has('runDoc', 'id="run-doc" data-run="RUN-1"', 'kestrel-implementer', '65k');   // stage RUNS: an ended run's subagents and context are in its document
    has('records', 'id="rec-DEC-1"', 'id="rec-DIR-1"', 'keep going', 'in-force', 'active');
    has('docs', 'id="docf-doc-0"', 'id="docf-doc-1"', 'Plan', 'missing', 'Project docs');   // META-UX-BUILD S3: the list; the file is its own part (docs.test)
    // LEDGER-UX R1: /api/ledger serves 100 lines by default (the fixture has 30), one row per entry
    has('ledger', 'id="ledger-lines"', '>p1<', '>p30<'); assert.equal((out.ledger.match(/<tr id="led-/g) || []).length, 30, 'one row per line');
    has('settings', 'id="settings-machine"', 'id="settings-project"', 'id="set-max_claude_workers"', 'id="set-policy.critical_lanes"');
    // META-UX-R1: rows are grouped by category (owner mental model), each row still says which file it lives in
    const rowOf = k => out.settings.slice(out.settings.indexOf(`id="set-${k}"`)).split('<div class="srow')[0];
    assert.match(rowOf('max_claude_workers'), /class="tag"[^>]*>machine</, 'machine key tagged machine');
    assert.match(rowOf('policy.critical_lanes'), /class="tag"[^>]*>project</, 'policy key tagged project');
    // one accent colour = "needs you": Inbox, and on Lanes only a row's first action (its way out of the group, SPEC 4.2 item 2)
    for (const a of out.lanes.split('<div class="rowacts">').slice(1).map(x => x.split('</div>')[0])) assert.ok(!a.includes('class="primary"') || /^<(button|a) class="(btn )?primary"/.test(a), `lanes: the accent only on a row's first action: ${a}`);
    for (const t of ['runs', 'records', 'docs', 'ledger', 'settings']) assert.ok(!out[t].includes('class="primary"'), `${t}: no accent button`);
  } finally { await f.done(); }
});

test('All projects: inbox / lanes / runs sum both projects; one-project tabs say so instead of failing', async () => {
  const f = await fixture();
  try {
    const get = getter(f);
    for (const [tab] of TABS) { const html = renderTab(tab, await loadTab(tab, 'all', get), { project: 'all' }); clean(html, 'all ' + tab); assert.ok(html.includes(`id="panel-${tab}"`)); }
    const ib = renderTab('inbox', await loadTab('inbox', 'all', get), { project: 'all' });
    assert.ok(ib.includes('other project question'), 'other project in the all inbox');
    assert.match(ib, /Needs you <b>4<\/b>/);
    assert.match(renderTab('records', await loadTab('records', 'all', get), { project: 'all' }), /Choose one project/);
  } finally { await f.done(); }
});

test('title badge "(n) norn" when something needs you', () => {
  assert.equal(pageTitle(3, 'kestrel'), '(3) norn - kestrel');
  assert.equal(pageTitle(0, 'kestrel'), 'norn - kestrel');
  assert.equal(needsCount({ needs_you: 2 }), 2); assert.equal(needsCount(null), 0);
});

test('GET / serves the UI shell with the token; /ui.mjs is the same module; no timer (the state stream re-renders on change, META-VISUAL-B), no animation', async () => {
  const f = await fixture();
  try {
    const r = await fetch(f.url + '/'), html = await r.text(); assert.equal(r.status, 200);
    assert.ok(html.includes(f.app.token)); assert.ok(html.includes('src="/ui.mjs"') || html.includes("from '/ui.mjs'"));
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    const m = await fetch(f.url + '/ui.mjs'); assert.equal(m.status, 200); assert.match(m.headers.get('content-type'), /javascript/);
    assert.equal(await m.text(), fs.readFileSync(path.join(ENGINE, 'dash', 'ui.mjs'), 'utf8'));
    const all = html + fs.readFileSync(path.join(ENGINE, 'dash', 'ui.mjs'), 'utf8') + dashCss();
    const sheet = await fetch(f.url + '/css/base.css'); assert.equal(sheet.status, 200); assert.match(sheet.headers.get('content-type'), /text\/css/);
    assert.ok(!/animation\s*:|transition\s*:|@keyframes/.test(all), 'no animation');
    assert.deepEqual([...all.matchAll(/setInterval\(([^)]*)\)/g)].length, 0, 'no refetch timer'); assert.ok(!/requestAnimationFrame/.test(all), 'no frame loop');
    assert.match(html, /new EventSource\(`\/api\/stream/);
    assert.match(dashCss(), /prefers-color-scheme:dark/); assert.match(dashCss(), /:root\.light/); assert.match(dashCss(), /:root\.dark/);
    assert.match(dashCss(), /font-variant-numeric:tabular-nums/);
  } finally { await f.done(); }
});

test('phone width (<= 700 px, both looks): the header wraps, the project select shrinks, the page bar at the bottom, cards / setting rows scroll or reflow; no page-level overflow mask', () => {
  const css = dashCss().replace(/\/\*[\s\S]*?\*\//g, '');
  const phone = [...css.matchAll(/@media \(max-width:700px\)\{([\s\S]*?\})\}/g)].map(m => '}' + m[1]).join('\n');
  const rule = sel => [...phone.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(m => m[1].split(',').map(s => s.trim()).includes(sel)).map(m => m[2]).join(';');
  assert.match(rule('header'), /flex-wrap:wrap/, 'header row wraps');
  assert.match(rule('header select'), /min-width:0/); assert.match(rule('header select'), /max-width:100%/);
  assert.match(rule('.pagebar'), /position:fixed/, 'the page bar sits at the bottom'); assert.match(rule('.pagebar>a'), /flex:1;min-width:0/, 'its 5 items share the width');
  assert.match(phone, /\.card,\.tablecard\{[^}]*min-width:0[^}]*overflow-x:auto/, 'wide tables scroll inside their card');
  assert.match(rule('.srow'), /grid-template-columns:minmax\(0,1fr\)/, 'setting rows stack');
  assert.ok(!/(?:html|body)[^{]*\{[^}]*overflow(?:-x)?:(?:hidden|clip)/.test(css), 'no overflow mask on html / body');
});

// ---------- META-ROADMAP S2: the Roadmap tab, view A (tree with a NOW line), the scope switch, the per-item time line ----------
const RNOW = '2030-01-10T12:00:00.000Z', rd = d => new Date(Date.parse(RNOW) - d * 864e5).toISOString();
const rmItem = (id, title, phase, status, o = {}) => ({ id, kind: 'item', title, phase, status, why: o.why || `why ${id}`, links: o.links || [], horizon: o.horizon || null,
  live: o.live || [], queued: [], stages: o.stages || [], branches: o.branches || [], spans: o.spans || [], first: o.spans?.[0]?.from ?? null,
  progress: o.progress || { done: 0, total: 0 }, last: o.last || null, last_evidence: o.last || null, flags: { claimed: null, drift: o.drift || [], idle: null, gone: [] }, children: [] });
const rmTree = () => {
  const core = [
    rmItem('RM-2', 'Shipped thing', 'past', 'shipped', { spans: [{ run: 'RUN-1', from: rd(8), to: rd(7), state: 'done' }], last: rd(7), links: ['dir:DIR-1', 'lane:gen'] }),
    rmItem('RM-3', 'Building thing with a long title that must wrap and never be cut by the time line', 'present', 'building', { live: ['RUN-3'], links: ['dec:DEC-2', 'dlv:DLV-4', 'branch:feat/x'],
      spans: [{ run: 'RUN-2', from: rd(4), to: rd(3), state: 'stopped' }, { run: 'RUN-3', from: rd(1), to: null, state: 'live' }], last: rd(1), drift: ['typed BUILT, records say building'],
      stages: [{ key: 'S1', lane: 'gen', runs: 1, state: 'stopped', run: 'RUN-2' }, { key: 'S2 tab', lane: null, runs: 0, state: 'planned' }], progress: { done: 0, total: 2 } }),
    rmItem('RM-4', 'Planned thing', 'future', 'planned', { horizon: 'next', stages: [{ key: 'S1', lane: null, runs: 0, state: 'planned' }] }),
  ];
  const ui = [rmItem('RM-6', 'Other present', 'present', 'built', { spans: [{ run: 'RUN-9', from: rd(2), to: rd(1.5), state: 'done' }], last: rd(1.5) })];
  const th = (id, title, children) => ({ id, kind: 'theme', title, state: 'open', children,
    counts: { past: children.filter(i => i.phase === 'past').length, present: children.filter(i => i.phase === 'present').length, future: children.filter(i => i.phase === 'future').length } });
  return { project: 'p', title: 'P', generated: RNOW, themes: [th('RM-1', 'Core', core), th('RM-5', 'Dashboard', ui)], unplaced: [{ id: 'L:stray', why: 'live lane, no item' }],
    counts: { items: 4, past: 1, present: 2, future: 1, live: 1, drift: 1, claimed: 0, idle: 0, gone: 0, unplaced: 1 } };
};
const rmRender = (rm = {}, look = 'norn') => renderTab('roadmap', rmTree(), { project: 'p', look, rm, now: Date.parse(RNOW) });
const rmIds = h => [...h.matchAll(/class="rmi[^"]*" id="rm-(RM-\d+)"/g)].map(m => m[1]);
const pressed = h => [...h.matchAll(/data-rm-scope="(\w+)" aria-pressed="(true|false)"/g)].map(m => `${m[1]}:${m[2]}`);
const views = h => [...h.matchAll(/data-rm-view="(\w+)" aria-pressed="(true|false)"/g)].map(m => `${m[1]}:${m[2]}`);

test('roadmap tab: in More under Plan (stage NAV); one-project tab; the view switch Tree / Board, Tree the default', () => {
  assert.deepEqual(MORE.find(g => g[0] === 'Plan')[1], ['roadmap']);
  assert.deepEqual(RM_VIEWS.map(v => v[0]), ['tree', 'board']);
  const h = rmRender(); clean(h, 'roadmap');
  assert.ok(h.includes('id="panel-roadmap"')); assert.deepEqual(views(h), ['tree:true', 'board:false'], 'the switch, Tree pressed by default');
  assert.match(h, /<div class="rm rm-tree">/); assert.deepEqual(views(rmRender({ view: 'bogus' })), ['tree:true', 'board:false'], 'an unknown view falls back to the tree');
  assert.match(renderTab('roadmap', { one: true }, { project: 'all' }), /belongs to one project/);
  assert.match(renderTab('roadmap', { project: 'p', title: 'P', generated: RNOW, themes: [], unplaced: [], counts: { items: 0, past: 0, present: 0, future: 0, live: 0, drift: 0, claimed: 0, idle: 0, gone: 0, unplaced: 0 } }, { project: 'p' }), /No roadmap yet[^]*norn road/);
});

test('roadmap scope switch: Urd / Verdandi / Skuld tap-to-filter (classic: Past / Now / Next), counts stay, tap again = all, state in the hash', () => {
  const all = rmRender();
  assert.deepEqual(rmIds(all), ['RM-2', 'RM-3', 'RM-4', 'RM-6']); assert.deepEqual(pressed(all), ['past:false', 'present:false', 'future:false']);
  assert.match(all, /<button type="button" class="sc sc-past" data-rm-scope="past"[^>]*>[^]*?>Urd<[^]*?>was<[^]*?<b>1<\/b>/);
  assert.match(all, />Verdandi<[^]*?>is<[^]*?<b>2<\/b>[^]*?>Skuld<[^]*?>shall be<[^]*?<b>1<\/b>/);
  const past = rmRender({ scope: 'past' });
  assert.deepEqual(rmIds(past), ['RM-2']); assert.deepEqual(pressed(past), ['past:true', 'present:false', 'future:false']);
  assert.match(past, /<details class="rmfold f-past" open>/, 'the past unfolded');
  assert.match(past, /<b>2<\/b>[^]*<b>1<\/b>/, 'counts stay visible');
  assert.deepEqual(rmIds(rmRender({ scope: 'present' })), ['RM-3', 'RM-6']);
  const fut = rmRender({ scope: 'future' }); assert.deepEqual(rmIds(fut), ['RM-4']); assert.match(fut, /<details class="rmfold f-future" open>/);
  assert.ok(!fut.includes('id="rmt-RM-5"'), 'a theme with nothing in scope is not drawn'); assert.ok(rmRender().includes('id="rmt-RM-5"'));
  assert.deepEqual([rmScopeNext(null, 'past'), rmScopeNext('past', 'future'), rmScopeNext('future', 'future')], ['past', 'future', null], 'tap the active one again = all');
  assert.deepEqual([rmHash('past'), rmHash(null)], ['#past', '']);
  assert.deepEqual([parseRmHash('#present'), parseRmHash('#rm-RM-3'), parseRmHash('#bogus'), parseRmHash('')], [{ scope: 'present' }, { item: 'RM-3' }, {}, {}]);
  const classic = rmRender({}, 'classic');
  assert.match(classic, />Past<[^]*>Now<[^]*>Next</); assert.ok(!/Urd|Verdandi|Skuld/.test(classic), 'classic: no Norn words');
  const deep = rmRender({ item: 'RM-2' });
  assert.match(deep, /<details class="rmfold f-past" open>[^]*class="rmi c ph-past hit" id="rm-RM-2"/, 'a deep link opens its fold and marks the row');
});

test('roadmap time line on every row: first activity -> now, run stretches by run state, a NOW tick, one shared window per theme, planned = dashed stub', () => {
  const h = rmRender(), row = id => h.slice(h.indexOf(`id="rm-${id}"`)).split(/class="rmi /)[0];
  for (const id of ['RM-2', 'RM-3', 'RM-4', 'RM-6']) { assert.match(row(id), /class="rmtl[^"]*"/, `${id} has a time line`); assert.match(row(id), /class="rmnow"/, `${id} NOW tick`); }
  // the Core window: oldest first activity (RM-2, 8 d ago) .. now = 0 .. 88 % of the track (the rest is the future side)
  const sp = id => [...row(id).matchAll(/class="rmsp sg-(\w+)" style="left:([\d.]+)%;width:([\d.]+)%"/g)].map(m => [m[1], Number(m[2]), Number(m[3])]);
  assert.deepEqual(sp('RM-2'), [['ok', 0, 11]], 'RM-2 starts the window: 8 d -> 7 d of 8 d');
  assert.deepEqual(sp('RM-3').map(s => s[0]), ['bad', 'running'], 'stopped / live by run state');
  assert.deepEqual(sp('RM-3')[0].slice(1), [44, 11]); assert.equal(sp('RM-3')[1][1] + sp('RM-3')[1][2], 88, 'the live run runs up to NOW');
  assert.match(row('RM-4'), /class="rmstub"/); assert.deepEqual(sp('RM-4'), [], 'planned: a stub, no fake dates');
  assert.deepEqual(sp('RM-6'), [['ok', 0, 22]], 'Dashboard has its own window (2 d)');
  assert.match(h, /Core[^]*?time line 01-02 to now/, 'the theme says its window');
  assert.match(row('RM-3'), /<b class="rmt">Building thing with a long title that must wrap and never be cut by the time line<\/b>/, 'the title is whole');
});

test('roadmap row content and filters: status word, live pill to the feed, links as id chips (DLV -> drawer), stages, drift; theme / status / live / drift / text', () => {
  const h = rmRender(), r3 = h.slice(h.indexOf('id="rm-RM-3"'));
  assert.match(r3, /<span class="chip running">building<\/span>/); assert.match(r3, /data-feed="RUN-3" data-project="p"/);
  assert.match(r3, /data-rid="DEC-2"/); assert.match(r3, /data-dlv="DLV-4" data-project="p"/); assert.match(r3, /feat\/x/);
  assert.match(r3, /class="rmst sg-bad"[^]*S1[^]*class="rmst sg-plan"[^]*S2 tab/); assert.match(r3, /Drift: typed BUILT/);
  assert.match(h.slice(h.indexOf('id="rm-RM-2"')), /data-rid="L:gen"/);
  assert.deepEqual(rmIds(rmRender({ theme: 'RM-5' })), ['RM-6']);
  assert.deepEqual(rmIds(rmRender({ status: 'planned' })), ['RM-4']);
  assert.deepEqual(rmIds(rmRender({ live: true })), ['RM-3']);
  assert.deepEqual(rmIds(rmRender({ drift: true })), ['RM-3']);
  assert.deepEqual(rmIds(rmRender({ q: 'feat/x' })), ['RM-3'], 'text over branches'); assert.deepEqual(rmIds(rmRender({ q: 'rm-6' })), ['RM-6'], 'over ids');
  assert.deepEqual(rmIds(rmRender({ q: 'shipped THING' })), ['RM-2'], 'over titles');
  assert.match(rmRender({ q: 'zzz' }), /No item matches/);
  assert.equal(rmMatch(rmTree().themes[0].children[1], { scope: 'present', live: true }), true);
  assert.match(rmRender({ status: 'planned' }), /showing 1 of 4/);
});

// ---------- META-ROADMAP S2b: view B, the three Norns board, behind the view switch (owner Q-17) ----------
const cols = h => [...h.matchAll(/<div class="rmcolh col-(\w+)"/g)].map(m => m[1]);
const cell = (h, theme, k) => {
  const a = h.indexOf(`<div class="rmcell col-${k}" data-theme="${theme}"`); if (a < 0) return '';
  const ends = [h.indexOf('<div class="rmcell ', a + 1), h.indexOf('</section>', a)].filter(x => x > 0);
  return h.slice(a, Math.min(...ends));
};
test('roadmap board (view B): Urd was / Verdandi is / Skuld shall be columns, each theme a row with its heading in every column, compact cards with the time line', () => {
  const h = rmRender({ view: 'board' }); clean(h, 'roadmap');
  assert.match(h, /<div class="rm rm-board">/); assert.deepEqual(views(h), ['tree:false', 'board:true']);
  assert.ok(!/class="rmth"|class="nowline"/.test(h), 'no tree on the board');
  assert.deepEqual(cols(h), ['past', 'present', 'future']);
  assert.match(h, /class="rmcolh col-past"[^]*?>Urd<[^]*?>was<[^]*?<b>1<\/b>[^]*?>Verdandi<[^]*?>is<[^]*?<b>2<\/b>[^]*?>Skuld<[^]*?>shall be<[^]*?<b>1<\/b>/);
  // the themes are rows: Core past / present / future, then Dashboard - the headings line up across the three columns
  const order = [...h.matchAll(/<div class="rmcell col-(\w+)" data-theme="(RM-\d+)"/g)].map(m => `${m[2]}:${m[1]}`);
  assert.deepEqual(order, ['RM-1:past', 'RM-1:present', 'RM-1:future', 'RM-5:past', 'RM-5:present', 'RM-5:future']);
  for (const k of ['past', 'present', 'future']) assert.match(cell(h, 'RM-1', k), /<h4 class="rmgh">[^]*Core/, `Core heading in ${k}`);
  assert.match(cell(h, 'RM-5', 'past'), /nothing/, 'an empty cell says so and keeps the row');
  assert.deepEqual(rmIds(h), ['RM-2', 'RM-3', 'RM-4', 'RM-6']);
  assert.deepEqual(rmIds(cell(h, 'RM-1', 'present')), ['RM-3']); assert.deepEqual(rmIds(cell(h, 'RM-1', 'future')), ['RM-4']);
  const r3 = h.slice(h.indexOf('id="rm-RM-3"')).split(/class="rmi /)[0];
  assert.match(r3, /<span class="chip running">building<\/span>/); assert.match(r3, /data-feed="RUN-3"/); assert.match(r3, /class="rmtl/, 'the time line on the card');
  assert.match(r3, /<b class="rmt">Building thing with a long title that must wrap and never be cut by the time line<\/b>/);
  assert.ok(!/class="rmw|class="rmstages|Drift: /.test(r3), 'compact: no reason text, stages or drift lines on the card (the time line replaces them)');
  assert.match(r3, /<span class="chip bad">drift<\/span>/, 'drift still flagged');
  const classic = rmRender({ view: 'board' }, 'classic');
  assert.match(classic, /class="rmcolh col-past"[^]*?>Past<[^]*?>Now<[^]*?>Next</); assert.ok(!/Urd|Verdandi|Skuld/.test(classic));
});

test('roadmap board: the same filters and scope switch act on both views; a scope leaves one column; a deep link opens its fold and marks the card', () => {
  const both = f => [rmIds(rmRender(f)).sort(), rmIds(rmRender({ ...f, view: 'board' })).sort()];
  for (const f of [{}, { scope: 'past' }, { scope: 'present' }, { scope: 'future' }, { theme: 'RM-5' }, { status: 'planned' }, { live: true }, { drift: true }, { q: 'feat/x' }, { q: 'rm-6' }]) {
    const [a, b] = both(f); assert.deepEqual(b, a, JSON.stringify(f));
  }
  const past = rmRender({ view: 'board', scope: 'past' });
  assert.deepEqual(cols(past), ['past'], 'a scope leaves its column'); assert.deepEqual(pressed(past), ['past:true', 'present:false', 'future:false']);
  assert.ok(!past.includes('data-theme="RM-5"'), 'a theme with nothing in scope is not drawn');
  assert.match(rmRender({ view: 'board', status: 'planned' }), /showing 1 of 4/);
  assert.match(rmRender({ view: 'board', q: 'zzz' }), /No item matches/);
  // five past items in one theme: four shown, the rest folded; a deep link to a folded one opens the fold and marks it
  const d = rmTree(), old = n => ({ ...d.themes[0].children[0], id: `RM-${10 + n}`, title: `Old ${n}` });
  d.themes[0].children.push(...[1, 2, 3, 4].map(old)); d.themes[0].counts.past = 5; d.counts.past = 5; d.counts.items = 8;
  const big = rm => renderTab('roadmap', d, { project: 'p', look: 'norn', rm, now: Date.parse(RNOW) });
  assert.match(big({ view: 'board' }), /<details class="rmfold f-past"><summary>1 more<\/summary>/);
  const last = rmIds(cell(big({ view: 'board' }), 'RM-1', 'past')).at(-1);
  assert.match(big({ view: 'board', item: last }), new RegExp(`<details class="rmfold f-past" open>[^]*class="rmi rmcard ph-past hit" id="rm-${last}"`));
});

test('roadmap view in the URL hash: #board, #board-past, #board-rm-RM-3; the tree keeps the S2 links (#past, #rm-RM-3)', () => {
  assert.deepEqual([rmHash('past', 'board'), rmHash(null, 'board'), rmHash('past', 'tree'), rmHash(null), rmHash('past')], ['#board-past', '#board', '#past', '', '#past']);
  assert.deepEqual([rmUrlHash({ view: 'board', item: 'RM-3' }), rmUrlHash({ item: 'RM-3' }), rmUrlHash({ view: 'board', scope: 'future' }), rmUrlHash({ view: 'tree', scope: 'past' })],
    ['#board-rm-RM-3', '#rm-RM-3', '#board-future', '#past']);
  assert.deepEqual([parseRmHash('#board'), parseRmHash('#board-past'), parseRmHash('#board-rm-RM-3'), parseRmHash('#tree'), parseRmHash('#tree-future'), parseRmHash('#board-bogus')],
    [{ view: 'board' }, { view: 'board', scope: 'past' }, { view: 'board', item: 'RM-3' }, { view: 'tree' }, { view: 'tree', scope: 'future' }, {}]);
});

test('roadmap row: a stuck item shows the stuck chip (since + why + the review it waits for) and "n runs, d days, k stopped in a row" (META-CATCH S1)', () => {
  const tr = rmTree(), it = tr.themes[0].children.find(i => i.id === 'RM-3');
  it.stuck = { runs: 9, days: 4, stopped_row: 3, flag: { ts: rd(2), why: ['3 stopped in a row'] } };
  const h = renderTab('roadmap', tr, { project: 'p', look: 'norn', rm: {}, now: Date.parse(RNOW) }), r3 = h.slice(h.indexOf('id="rm-RM-3"'), h.indexOf('id="rm-RM-4"'));
  assert.match(r3, /<span class="chip bad" title="stuck since 2030-01-08T12:00Z: 3 stopped in a row - further rounds wait for an approach review">stuck<\/span>/);
  assert.match(r3, /9 runs, 4 days, 3 stopped in a row/);
  const r2 = h.slice(h.indexOf('id="rm-RM-2"'), h.indexOf('id="rm-RM-3"'));
  assert.doesNotMatch(r2, />stuck</); assert.doesNotMatch(r2, /stopped in a row/);
});
