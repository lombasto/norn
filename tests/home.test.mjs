// META-CONTROLLER C2 (SPEC sec. 8 + 10, owner Q-25 = Look 3 "Thread home"): the Norn group's Home tab = the thread. Pure parts
// (the thread assembly, the renderers) on a fixture thread; the server parts (/api/home, /api/file with allow-listed roots) on the
// dashboard fixture; the phone width (390 CSS px: document scrollWidth == viewport width) in a real headless browser when the
// norn shot launcher (engine/lib/shot.mjs) and a browser are present.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { homeEvents, renderThread, renderHome, renderBottomBar, imagePaths, fileUrl, HOME_FILTERS } from '../engine/dash/home.mjs';
import { TABS, NAV, renderNav, renderTab, loadTab } from '../engine/dash/ui.mjs';
import { TABS as SERVER_TABS } from '../engine/dash/server.mjs';
import { record } from '../engine/lib/records.mjs';
import { threadFile } from '../engine/lib/chatact.mjs';
import { ENGINE, fixture } from './helpers/dash-fixture.mjs';

const T = m => new Date(Date.parse('2026-11-13T00:00:00.000Z') + m * 60000).toISOString();
const SHOT = 'C:/rev/meta/shots/plan-desktop-dark.png';
// a fixture thread: every card kind the surface draws; approval / done (action) cards exist only here until C3 gives them verbs
const FIX = [
  { key: 'k1', ts: T(1), cat: 'checkin', kind: 'checkin', headline: 'reviewed RUN-401', subs: [{ label: 'skipped', text: 'meta-ledger (held by chat)' }] },
  { key: 'c1', ts: T(2), cat: 'chat', kind: 'you', text: 'stop RUN-399 <script>x</script>\nre-queue it' },
  { key: 'c2', ts: T(3), cat: 'chat', kind: 'tools', names: ['norn_boot', 'norn_status'] },
  { key: 'c3', ts: T(4), cat: 'chat', kind: 'controller', text: `Done. Shots: ${SHOT}`, images: [SHOT] },
  { key: 'r1', ts: T(5), cat: 'run', kind: 'run-start', run: 'RUN-413', lane: 'meta-ledger', stage: 'R2', executor: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { key: 'r2', ts: T(6), cat: 'run', kind: 'run-end', run: 'RUN-399', lane: 'meta-notify', outcome: 'stopped', why: 'stalled 40 min', images: [] },
  { key: 'm1', ts: T(7), cat: 'merge', kind: 'run-end', run: 'RUN-420', lane: 'mq', stage: 'MERGE', outcome: 'done', why: null, images: [] },
  { key: 'q1', ts: T(8), cat: 'needs', kind: 'question', id: 'Q-17', project: 'kestrel', title: 'Plan tab: where does the forecast sit?', lane: 'meta-plan',
    options: [{ key: 'a', text: 'top strip' }, { key: 'b', text: 'own card' }], recommend: { key: 'a', why: 'one glance' } },
  { key: 'a1', ts: T(9), cat: 'needs', kind: 'approval', title: 'Force-push needs you', text: 'RUN-413 will rebase the branch.', command: 'git push --force-with-lease origin feat/x', timeout_min: 30 },
  { key: 'd1', ts: T(10), cat: 'chat', kind: 'done', title: 'Stopped RUN-399 · queued RUN-413', lines: ['RUN-399 killed (whole tree)'], hold: 'meta-ledger', until: T(40) },
];

test('C2 homeEvents: the chat thread, check-in ledger lines, run starts / ends, merges and needs-you rows in ONE time-ordered thread', () => {
  const thread = [
    { ts: T(0), seg: 1, kind: 'segment', n: 1, why: 'first' }, { ts: T(0), seg: 1, kind: 'owner', text: 'hello' },
    { ts: T(0.1), seg: 1, kind: 'start', resume: false }, { ts: T(0.2), seg: 1, kind: 'session', session_id: 's' },
    { ts: T(0.3), seg: 1, kind: 'tool', name: 'mcp__norn__norn_boot' }, { ts: T(0.4), seg: 1, kind: 'result', text: 'ok' },
    { ts: T(0.5), seg: 1, kind: 'tool', name: 'mcp__norn__norn_status' }, { ts: T(0.6), seg: 1, kind: 'usage', ctx: 62000 },
    { ts: T(0.7), seg: 1, kind: 'text', text: `See ${SHOT} and D:/x/y.txt` }, { ts: T(0.8), seg: 1, kind: 'turn', ok: true, cost_usd: 0.1 },
    { ts: T(20), seg: 1, kind: 'stop', why: 'idle', code: 0 },
  ];
  const runs = [
    { id: 'RUN-5', kind: 'run', created: T(1), state: 'exited', data: { kind: 'worker', lane: 'gen', stage: 'R1', executor: 'claude', model: 'claude-opus-5-5', effort: 'high' },
      history: [{ ev: 'start', ts: T(1) }, { ev: 'end', ts: T(9) }], end: { outcome: 'done', summary: `shots ${SHOT}` } },
    { id: 'RUN-6', kind: 'run', created: T(2), state: 'running', data: { kind: 'checkin', lane: null }, history: [{ ev: 'start', ts: T(2) }] },
    { id: 'RUN-7', kind: 'run', created: T(3), state: 'running', data: { kind: 'worker', role: 'helper', parent: 'RUN-5' }, history: [{ ev: 'start', ts: T(3) }] },
    { id: 'RUN-8', kind: 'run', created: T(4), state: 'exited', data: { kind: 'worker', lane: 'mq', stage: 'MERGE' }, history: [{ ev: 'start', ts: T(4) }, { ev: 'end', ts: T(5) }], end: { outcome: 'done' } },
  ];
  const ledger = [{ kind: 'check-in', ts: T(6), headline: 'reviewed RUN-5', subs: [] }, { kind: 'other', ts: null, headline: '# heading', subs: [] },
    { kind: 'minor', ts: T(7), headline: 'nothing new', subs: [] }];
  const needs = [{ type: 'question', id: 'Q-1', title: 'pick', created: T(8), options: [] }, { type: 'answered', id: 'Q-2', title: 'old', updated: T(8) }];
  const ev = homeEvents({ thread, runs, ledger, needs });
  assert.deepEqual(ev.map(e => [e.cat, e.kind]), [
    ['chat', 'segment'], ['chat', 'you'], ['chat', 'tools'], ['chat', 'controller'], ['run', 'run-start'], ['merge', 'run-start'], ['merge', 'run-end'],
    ['checkin', 'checkin'], ['needs', 'question'], ['run', 'run-end'], ['chat', 'stop']]);
  assert.deepEqual(ev[2].names, ['norn_boot', 'norn_status'], 'consecutive tool lines fold into one, the MCP prefix dropped');
  assert.deepEqual(ev[3].images, [SHOT], 'images named in the controller text (not the .txt)');
  assert.deepEqual(ev.find(e => e.kind === 'run-end' && e.run === 'RUN-5').images, [SHOT], 'a run marker line carries its shots');
  assert.ok(!ev.some(e => e.run === 'RUN-6' || e.run === 'RUN-7'), 'check-in runs (the ledger line says it) and helpers are not thread items');
  assert.ok(!ev.some(e => e.kind === 'answered'), 'only what needs you now');
  assert.equal(new Set(ev.map(e => e.key)).size, ev.length, 'a unique key per item');
  assert.equal(homeEvents({ thread, runs, ledger, needs, count: 3 }).length, 3, 'the newest count items');
  assert.deepEqual(imagePaths('a C:\\x\\y.PNG b /srv/u/s.webp c http://x/y.png d rel/z.png'), ['C:/x/y.PNG', '/srv/u/s.webp']);
  assert.equal(fileUrl('kestrel', SHOT), `/api/file?project=kestrel&path=${encodeURIComponent(SHOT)}`);
});

test('C2 renderThread on a fixture thread: every card kind, escaped text, shots through /api/file, filters hide by category, action cards disabled until C3', () => {
  const html = renderThread(FIX, { project: 'kestrel', now: Date.parse(T(60)) });
  for (const k of ['checkin', 'you', 'tools', 'controller', 'run-start', 'run-end', 'question', 'approval', 'done']) assert.match(html, new RegExp(`class="ev ev-${k}`), k);
  assert.ok(!html.includes('<script>x'), 'owner text escaped'); assert.match(html, /&lt;script&gt;x/);
  assert.ok(html.includes(`src="${fileUrl('kestrel', SHOT).replace(/&/g, '&amp;')}"`), 'the shot inline through /api/file');
  assert.match(html, /plan-desktop-dark\.png/);
  assert.match(html, /data-act="answer"[^>]*data-id="Q-17"[^>]*data-choice="a"/, 'a question card answers through the existing answer verb');
  assert.match(html, /class="[^"]*primary[^"]*"[^>]*data-choice="a"/, 'the recommended option stands out');
  const appr = html.slice(html.indexOf('ev-approval'), html.indexOf('ev-done'));
  assert.match(appr, /Approve once<\/button>/); assert.match(appr, /Deny<\/button>/);
  for (const b of appr.match(/<button[^>]*>/g)) assert.match(b, /disabled/, 'approval verbs come in C3');
  assert.match(html.slice(html.indexOf('ev-done')), /<button[^>]*disabled[^>]*>Undo/);
  assert.match(html, /RUN-413/); assert.match(html, /opus/); assert.match(html, /STOPPED/); assert.match(html, /MERGE/);
  // filters: the items of other categories carry hidden
  const only = (f, cat) => { const h = renderThread(FIX, { project: 'kestrel', filter: f }); const lis = [...h.matchAll(/<li class="ev [^"]*" data-cat="(\w+)"( hidden)?/g)];
    assert.equal(lis.length, FIX.length); for (const [, c, hid] of lis) assert.equal(!hid, f === 'all' || c === cat, `${f}: ${c}`); };
  only('all'); only('talk', 'chat'); only('needs', 'needs'); only('checkin', 'checkin'); only('run', 'run'); only('merge', 'merge');
  assert.deepEqual(HOME_FILTERS.map(f => f[1]), ['everything', 'you + controller', 'needs you', 'check-ins', 'runs', 'merges']);
  assert.match(renderThread([], { project: 'kestrel' }), /class="thread-empty/);
});

const HOME = {
  project: 'kestrel', now: T(60), events: FIX, needs_you: 2,
  status: { running: false, busy: false, segment: 1, executor: 'claude', model: 'claude-opus-5-5', effort: 'medium', ctx: 62000, handoff_k: 110 },
  side: { now: [{ run: 'RUN-411', lane: 'meta-autonomy', state: 'running', age_min: 38, ctx: 71000 }, { run: 'RUN-413', lane: 'meta-ledger', state: 'queued' }],
    usage: { used: 38, stop: 95 }, interval_min: 15, paused: false,
    waiting: [{ id: 'Q-17', type: 'question', title: 'Plan tab forecast', created: T(0) }],
    ruled: [{ id: 'DEC-112', text: 'autonomy R1 first' }], orders: [{ id: 'DIR-15', text: 'no merges 23-07', created: T(0) }] },
};

test('C2 renderHome (Look 3): the side columns, the thread header (harness, context vs hand-off), the filters with the needs count, the composer', () => {
  const html = renderTab('home', HOME, { project: 'kestrel', look: 'norn', now: Date.parse(T(60)) });
  assert.match(html, /id="panel-home"/);
  for (const h of ['Now', 'Held by this chat', 'Usage this week', 'Next check-in', 'Waiting for you', 'Ruled for you today', 'Your standing orders']) assert.ok(html.includes(`>${h}<`), h);
  assert.match(html, /class="home-l"/); assert.match(html, /class="home-r"/); assert.match(html, /class="home-c"/);
  const text = html.replace(/<[^>]+>/g, '');
  assert.match(text, /Claude Code · opus · medium/); assert.match(text, /62k \/ 110k/);
  assert.match(html, /<span class="heff"> · medium<\/span>/); assert.match(html, /<span class="hlim"> \/ 110k<\/span>/, 'effort and the hand-off limit can drop on a phone');
  assert.match(html, /data-act="home-filter" data-filter="needs"[^>]*>needs you <b id="home-needs">2<\/b>/);   // UX review 4: the Inbox's count (terms.mjs)
  assert.match(html, /data-act="home-filter" data-filter="all" aria-pressed="true"/);
  assert.match(html, /<textarea id="chat-text"[^>]*maxlength="8000"/); assert.match(html, /data-act="chat-send"/);
  assert.match(html, /data-rid="DEC-112"/); assert.match(html, /data-rid="DIR-15"/); assert.match(html, /RUN-411/);
  assert.match(html, /38 % of the weekly guard/); assert.match(html, /every 15 min/);
  assert.match(renderTab('home', HOME, { project: 'kestrel', homeFilter: 'run' }), /data-filter="run" aria-pressed="true"/);
  assert.match(renderTab('home', { one: true }, { project: 'all' }), /belongs to one project/);
});

test('C2 nav: Home is the first tab, alone in the Norn group (the thread); the phone bottom bar Home / Inbox / Runs / Plan / More (UX review 4: the same names as the top bar)', async () => {
  assert.deepEqual(TABS[0], ['home', 'Home']); assert.equal(SERVER_TABS[0], 'home');
  assert.deepEqual(NAV[0], ['home', 'Home', []]);
  assert.match(renderNav('home', {}), /^<div class="dests"[^>]*><button role="tab" id="tab-home"[^>]*aria-selected="true"/);   // UX review 2: Home first in the bar
  const bar = renderBottomBar('home', { inbox: 2 });
  assert.deepEqual([...bar.matchAll(/data-tab="(\w+)"/g)].map(m => m[1]), ['home', 'inbox', 'runs', 'plan']);
  assert.match(bar, /data-act="more"/); assert.match(bar, /Home/); assert.match(bar, /Runs/); assert.match(bar, /aria-label="2 need you">2</);
  assert.match(bar, /data-tab="home"[^>]*aria-current="page"/);
  const seen = [];
  const d = await loadTab('home', 'kestrel', async p => { seen.push(p); return p.startsWith('/api/home') ? { project: 'kestrel', events: [] } : {}; });
  assert.deepEqual(seen, ['/api/home?project=kestrel']); assert.equal(d.project, 'kestrel');
  assert.deepEqual(await loadTab('home', 'all', async () => assert.fail('no fetch for all')), { one: true });
});

test('C2 /api/home on the fixture state: the thread file, runs, needs, the side columns and the chat status (no process started)', async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(path.dirname(threadFile(f.pa.state)), { recursive: true });
    fs.writeFileSync(threadFile(f.pa.state), [{ ts: T(0), seg: 1, kind: 'segment', n: 1, why: 'first', executor: 'claude' }, { ts: T(0), seg: 1, kind: 'owner', text: 'hi' },
      { ts: T(1), seg: 1, kind: 'usage', ctx: 62000 }, { ts: T(1), seg: 1, kind: 'text', text: 'hello' }].map(l => JSON.stringify(l)).join('\n') + '\n');
    fs.appendFileSync(path.join(f.pa.root, 'progress.md'), `- meta ${new Date().toISOString().slice(0, 19)}Z: reviewed RUN-1; next idle\n`);
    record(f.pa.state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'gen', question: 'which', choice: 'a', why: 'cheap' } });
    const r = await f.get('/api/home?project=kestrel');
    assert.equal(r.status, 200);
    const d = r.data, kinds = d.events.map(e => e.kind);
    assert.ok(kinds.includes('you') && kinds.includes('controller') && kinds.includes('question') && kinds.includes('run-end') && kinds.includes('checkin'), kinds.join());
    assert.equal(d.needs_you, d.events.filter(e => e.cat === 'needs' && e.kind !== 'approval').length); assert.equal(d.approvals, 0);   // UX review 4: the Inbox's count (terms.mjs needsYou); approvals beside it
    const un = d.events.find(e => e.kind === 'unreviewed' && e.id === 'RUN-1');
    assert.ok(un && Date.parse(un.ts) > 0, 'an unreviewed run sits in the thread at its end, not at the top');
    assert.equal(d.status.running, false); assert.equal(d.status.ctx, 62000); assert.equal(d.status.handoff_k, 110); assert.equal(d.status.executor, 'claude');
    assert.ok(d.side.now.some(n => n.run === 'RUN-2' && n.state === 'running'));
    assert.ok(d.side.waiting.some(w => w.id === 'Q-1')); assert.ok(d.side.orders.some(o => o.text === 'keep going'));
    assert.ok(d.side.ruled.some(x => /which/.test(x.text)), 'a decision made today'); assert.equal(d.side.interval_min, 15);
    assert.equal(f.app.sessions && (await f.get('/api/chat?project=kestrel')).data.status.running, false, 'reading the home starts no chat');
    assert.equal((await f.get('/api/home?project=all')).status, 400, 'one project');
  } finally { await f.done(); }
});

test('C2 /api/file: images inside the allow-listed roots (project root, state, run worktrees and NOTES folders) only; a path outside is refused', async () => {
  const f = await fixture();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  try {
    const inState = path.join(f.pa.state, 'shots', 'a.png'), inRoot = path.join(f.pa.root, 'b.png'), outside = path.join(f.root, 'outside', 'c.png');
    const wt = path.join(f.root, 'wt-gen'), notesDir = path.join(f.root, 'reviews');
    for (const x of [inState, inRoot, outside, path.join(wt, 'd.png'), path.join(notesDir, 'shots', 'e.png')]) { fs.mkdirSync(path.dirname(x), { recursive: true }); fs.writeFileSync(x, png); }
    fs.writeFileSync(path.join(f.pa.root, 'secret.txt'), 'no');
    record(f.pa.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen', worktree: wt.replace(/\\/g, '/'), notes: path.join(notesDir, 'NOTES.md') } });
    const get = async (p, project = 'kestrel') => fetch(`${f.url}/api/file?project=${project}&path=${encodeURIComponent(p)}`);
    for (const ok of [inState, inRoot, path.join(wt, 'd.png'), path.join(notesDir, 'shots', 'e.png'), inState.replace(/\\/g, '/')]) {
      const r = await get(ok); assert.equal(r.status, 200, ok); assert.equal(r.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
    }
    const refused = async (p, code, project) => { const r = await get(p, project); assert.equal(r.status, code, p); assert.ok(!(r.headers.get('content-type') || '').startsWith('image/')); };
    await refused(outside, 403);
    await refused(path.join(f.pa.state, '..', '..', 'outside', 'c.png'), 403);   // .. out of the state dir
    await refused(f.pa.root + '-evil/b.png', 403);                              // a sibling whose name starts like the root
    await refused('outside/c.png', 400);                                        // relative
    await refused(path.join(f.pa.root, 'secret.txt'), 415);                     // inside a root, not an image
    await refused(path.join(f.pa.root, 'missing.png'), 404);
    await refused(inState, 400, 'all');
    assert.equal((await fetch(`${f.url}/api/file?project=kestrel`)).status, 400, 'no path');
  } finally { await f.done(); }
});

// ---------- the phone width (SPEC row: scrollWidth == width at 390) ----------
const css = () => { const h = fs.readFileSync(path.join(ENGINE, 'dash', 'index.html'), 'utf8'); return h.slice(h.indexOf('<style>'), h.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, ''); };

// CI-RED-44384DB (windows): this test drove its own CDP socket with unbounded waits (the load event, the ready poll, every reply), so a
// stalled step ran into the 120 s test timeout without a word and the finally (browser + server close) never ran - the file hung to
// the 600 s cap. The shared openPage: every wait bounded, a timeout fails naming the page's state, pg.close in the finally.
import { openPage, skipWhy } from './helpers/cdp.mjs';
test('C2 the Home tab at 390 x 844 (phone, both grounds): document scrollWidth == the viewport width; at 1440 the three columns sit side by side', {
  skip: skipWhy, timeout: 120000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    fs.mkdirSync(path.dirname(threadFile(f.pa.state)), { recursive: true });
    const long = 'x'.repeat(300), cmd = 'git push --force-with-lease origin feat/dash-phone-header-and-a-very-long-branch-name-that-does-not-break';
    fs.writeFileSync(threadFile(f.pa.state), [{ ts: T(0), seg: 1, kind: 'owner', text: `look at ${long}` }, { ts: T(1), seg: 1, kind: 'text', text: `run \`${cmd}\` ${long} C:/nowhere/a-very-long-shot-name-for-the-phone-test.png` }]
      .map(l => JSON.stringify(l)).join('\n') + '\n');
    const measure = async (w, h, ground, mobile) => {
      await pg.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await pg.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: ground }] });
      // read only the NEW page, and only once it says it painted (go: the load event, then body data-ready = the tab or 'error')
      const ready = await pg.go(`${f.url}/?project=kestrel&tab=home&theme=${ground}`);
      return { ready, ...await pg.ev(`new Promise(r => setTimeout(() => r({ error: document.querySelector('#error')?.textContent || null,
        sw: document.documentElement.scrollWidth, w: innerWidth, ev: document.querySelectorAll('#panel-home .ev').length,
        bar: getComputedStyle(document.querySelector('.bbar')).display, l: document.querySelector('.home-l') && getComputedStyle(document.querySelector('.home-l')).display,
        cols: [...document.querySelectorAll('.home > *')].filter(e => getComputedStyle(e).display !== 'none').map(e => Math.round(e.getBoundingClientRect().left)) }), 300))`) };
    };
    for (const ground of ['dark', 'light']) {
      const m = await measure(390, 844, ground, true);
      assert.equal(m.ready, 'home', `${ground}: the page painted the Home tab (${JSON.stringify(m)})`);
      assert.ok(m.ev >= 3, `${ground}: the thread rendered (${JSON.stringify(m)})`);
      assert.equal(m.sw, m.w, `${ground}: no sideways scroll at 390 (${JSON.stringify(m)})`); assert.equal(m.w, 390);
      assert.equal(m.bar, 'flex'); assert.equal(m.l, 'none');
    }
    const d = await measure(1440, 900, 'dark', false);
    assert.equal(d.sw, 1440); assert.equal(d.bar, 'none'); assert.equal(d.cols.length, 3, JSON.stringify(d)); assert.ok(d.cols[0] < d.cols[1] && d.cols[1] < d.cols[2]);
  } finally { await pg.close(); await f.done(); }
});
