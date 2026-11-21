// The Runs page (owner 2026-11-19, 2026-11-20): one table of every run - running first, then queued, then ended; its age = 'ran' (start
// to end) and 'ended' (how long ago) from the run's own start / end events, never an age since birth; tools / words / commits counted
// from the transcript; one filter-chip row (state with "need a look", kind, window, project) and a lane box, all in the URL; a row opens
// the run document in the drawer. Sandbox only: temp state dirs, the shared dash fixture and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { record, loadState } from '../engine/lib/records.mjs';
import { agentsTree, endedAt, windowMs, RUN_WINDOWS } from '../engine/lib/agents.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { runTimes, runsOrder, runsFilter, runsViewOf, runsViewQs, runStateOf, runKindOf, runShowOf, RUNS_WINDOWS } from '../engine/dash/pages/runs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const iso = ms => new Date(ms).toISOString();
const runsOf = s => Object.values(loadState(s).items).filter(i => i.kind === 'run');
// one table row of the Runs page (from its id to its end marker)
const rowOf = (html, id) => html.match(new RegExp(`<tr class="rrow[^"]*" id="node-${id}"[^]*?<!--/row-->`))?.[0] ?? '';
const at = (r, ev, ms) =>{ r.history.find(h => h.ev === ev).ts = iso(ms); if (ev === 'start') r.created = iso(ms); };

test('agentsTree: a finished run carries its start and end; ran = start to end, not now minus its birth; a later review moves neither', () => {
  const s = mkTmp('runs-view-'), now = Date.parse('2026-11-19T12:00:00Z');
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'seabed' } });
  record(s, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome: 'done' } });
  record(s, { kind: 'run', ev: 'review', id: 'RUN-1', by: 'checkin', data: { refs: [], routine: true, why: 'ok' } });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'gen' } });
  const runs = runsOf(s), [a, b] = runs;
  at(a, 'start', now - 90 * 60000); at(a, 'end', now - 50 * 60000); a.history.find(h => h.ev === 'review').ts = iso(now - 1 * 60000); a.updated = iso(now - 60000);
  at(b, 'start', now - 25 * 60000);
  assert.equal(endedAt(a), iso(now - 50 * 60000), 'the end event, not the review after it');
  assert.equal(endedAt(b), null, 'a running run has no end');
  const tree = agentsTree(runs, { now }), [ta, tb] = [tree.find(n => n.id === 'RUN-1'), tree.find(n => n.id === 'RUN-2')];
  assert.equal(ta.ran_min, 40, 'ran 40 min (start to end), though born 90 min ago');
  assert.equal(ta.ended, iso(now - 50 * 60000));
  assert.equal(tb.ran_min, 25, 'a running run ran from its start to now');
  assert.equal(tb.ended, null);
  assert.equal('age_min' in ta, false, 'no age field left');
  const t = runTimes(ta, now);
  assert.deepEqual([t.ran_min, t.ended_min, t.queued_min], [40, 50, null], 'ran 40 min, ended 50 min ago');
  const html = renderTab('runs', { tree }, { now, projects: [] });
  assert.match(rowOf(html, 'RUN-1'), /<span class="rtime">40 min<\/span>/, 'the ended row: ran 40 min');
  assert.match(rowOf(html, 'RUN-1'), /ended 50 min ago/);
  assert.match(rowOf(html, 'RUN-2'), /<span class="rtime">25 min<\/span>/, 'the live row: ran 25 min so far');
  assert.doesNotMatch(rowOf(html, 'RUN-2'), /ago/, 'no end while running');
  assert.ok(html.includes('<thead><tr><th>state</th><th>run</th><th>lane · stage</th><th>model</th><th>age</th><th>tools</th><th>words</th><th>commits</th><th>pace</th></tr></thead>'), 'the columns');
});

test('the window: an end 5 h ago is out at 2 h and in at 12 h; today = since local midnight; an unknown window is refused', () => {
  const s = mkTmp('runs-view-win-'), now = Date.parse('2026-11-19T12:00:00Z');
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'night' } });
  record(s, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome: 'done' } });
  const runs = runsOf(s); at(runs[0], 'start', now - 6 * 3600000); at(runs[0], 'end', now - 5 * 3600000);
  assert.deepEqual(agentsTree(runs, { now }).map(n => n.id), [], 'default 2 h');
  assert.deepEqual(agentsTree(runs, { now, window: windowMs('2h', now) }).map(n => n.id), []);
  assert.deepEqual(agentsTree(runs, { now, window: windowMs('12h', now) }).map(n => n.id), ['RUN-1']);
  assert.deepEqual(agentsTree(runs, { now, window: windowMs('24h', now) }).map(n => n.id), ['RUN-1']);
  assert.equal(windowMs('today', now), now - new Date(now).setHours(0, 0, 0, 0));
  assert.equal(windowMs('3d', now), null);
  assert.deepEqual(RUN_WINDOWS, RUNS_WINDOWS.map(w => w[0]), 'the page offers the windows the server takes');
});

test('runsOrder: running (newest start first), then queued (longest waiting first), then ended (latest end first)', () => {
  const now = Date.parse('2026-11-19T12:00:00Z'), m = x => iso(now - x * 60000);
  const roots = [
    { id: 'RUN-1', state: 'exited', outcome: 'done', started: m(100), ended: m(80) },
    { id: 'RUN-2', state: 'running', started: m(60) },
    { id: 'RUN-3', state: 'exited', outcome: 'crash', started: m(50), ended: m(10) },
    { id: 'RUN-4', state: 'queued', queued: m(5) },
    { id: 'RUN-5', state: 'running', started: m(5) },
    { id: 'RUN-6', state: 'lost', started: m(40), ended: m(30) },
    { id: 'RUN-7', state: 'queued', queued: m(20) },
    { id: 'talk:ask', kind: 'talk', state: 'alive', started: m(30) },
  ];
  assert.deepEqual(runsOrder(roots).map(n => n.id), ['RUN-5', 'talk:ask', 'RUN-2', 'RUN-7', 'RUN-4', 'RUN-3', 'RUN-6', 'RUN-1']);
  assert.deepEqual(runTimes(roots[3], now), { ran_min: null, ended_min: null, queued_min: 5 }, 'a queued run: how long it has waited');
  const html = renderTab('runs', { tree: roots.filter(n => n.state !== 'queued').map(n => ({ ...n, children: [] })), queue: [{ id: 'RUN-7', state: 'queued', lane: 'q', kind: 'worker', queued: m(20) }] }, { now, projects: [] });
  const ids = [...html.matchAll(/id="node-([^"]+)"/g)].map(x => x[1]);
  assert.deepEqual(ids, ['RUN-5', 'talk:ask', 'RUN-2', 'RUN-7', 'RUN-3', 'RUN-6', 'RUN-1'], 'the page renders that order; the queue is in the tree');
  assert.match(rowOf(html, 'RUN-7'), /waited 20 min/, 'a queued row: how long it has waited');
  assert.doesNotMatch(html, /id="node-RUN-7"[^>]*data-feed/, 'a queued run has no feed yet');
});

test('the filters: state, kind, project and lane; the view round-trips through the URL and a plain link stays plain', () => {
  const roots = [
    { id: 'RUN-1', state: 'running', kind: 'worker', lane: 'seabed', project: 'kestrel' },
    { id: 'RUN-2', state: 'exited', outcome: 'no-result', kind: 'checkin', lane: null, project: 'kestrel' },
    { id: 'RUN-3', state: 'exited', outcome: 'done', kind: 'helper', lane: 'gen', project: 'other' },
    { id: 'RUN-4', state: 'queued', kind: 'codex', lane: 'render', project: 'other' },
    { id: 'RUN-5', state: 'killed', kind: 'worker', lane: 'Seabed-2', project: 'other' },
    { id: 'talk:ask', state: 'stopped', kind: 'talk', project: 'kestrel' },
  ];
  assert.deepEqual(roots.map(runStateOf), ['running', 'failed', 'finished', 'queued', 'failed', 'finished']);
  assert.deepEqual(roots.map(runKindOf), ['worker', 'checkin', 'helper', 'worker', 'worker', 'talk']);
  const v0 = runsViewOf(new URLSearchParams(''));
  assert.equal(runsViewQs(v0), '', 'the default view adds nothing to the URL');
  assert.deepEqual(runsFilter(roots, v0).map(n => n.id), roots.map(n => n.id), 'by default every root shows');
  const ids = q => runsFilter(roots, runsViewOf(new URLSearchParams(q))).map(n => n.id);
  assert.deepEqual(ids('state=failed'), ['RUN-2', 'RUN-5']);
  assert.deepEqual(ids('state=running,queued'), ['RUN-1', 'RUN-4']);
  assert.deepEqual(ids('kind=worker'), ['RUN-1', 'RUN-4', 'RUN-5']);
  assert.deepEqual(ids('proj=other'), ['RUN-3', 'RUN-4', 'RUN-5']);
  assert.deepEqual(ids('lane=seabed'), ['RUN-1', 'RUN-5'], 'the lane box matches part of the lane, any case');
  assert.deepEqual(ids('state=failed&kind=worker&proj=other'), ['RUN-5']);
  assert.deepEqual(ids('state='), [], 'every state chip off shows nothing');
  const v = runsViewOf(new URLSearchParams('state=running,failed&kind=worker,talk&proj=other&lane=sea bed&window=12h'));
  const back = runsViewOf(new URLSearchParams(runsViewQs(v).slice(1)));
  assert.deepEqual([[...back.state], [...back.kind], [...back.proj], back.lane, back.window], [['running', 'failed'], ['worker', 'talk'], ['other'], 'sea bed', '12h']);
  assert.equal(runsViewOf(new URLSearchParams('window=3d&state=bogus')).window, '2h', 'an unknown window falls to the default');
  // the page: the chips carry their counts and pressed state; a filter that hides everything says so
  const html = renderTab('runs', { tree: roots.filter(n => n.state !== 'queued').map(n => ({ ...n, children: [] })), queue: [{ ...roots[3] }] }, { now: Date.now(), project: 'all', runsView: runsViewOf(new URLSearchParams('state=failed&window=24h')) });
  assert.match(html, /data-group="state" data-show="failed" aria-pressed="true">failed <b>2<\/b>/);
  assert.match(html, /data-group="state" data-show="running" aria-pressed="false">running <b>1<\/b>/);
  assert.match(html, /data-group="kind" data-show="checkin" aria-pressed="true">check-in <b>1<\/b>/);
  assert.match(html, /data-group="proj" data-show="other" aria-pressed="false">other <b>3<\/b>/, 'project chips when the tree spans projects');
  assert.match(html, /data-act="runs-window" data-window="24h" aria-pressed="true"/);
  assert.deepEqual([...html.matchAll(/id="node-([^"]+)"/g)].map(x => x[1]), ['RUN-2', 'RUN-5']);
  assert.match(html, /the runs that ended in the last 24 h/, 'the ? popover names the window');
  const none = renderTab('runs', { tree: [{ ...roots[0], children: [] }] }, { now: Date.now(), projects: [], runsView: runsViewOf(new URLSearchParams('lane=zzz')) });
  assert.match(none, /No runs under these filters\./);
  assert.doesNotMatch(none, /data-group="proj"/, 'one project: no project chips');
});

test('/api/agents: ?window= widens the tree; an unknown window is refused (400)', async () => {
  const f = await fixture();
  try {
    const st = f.pa.state, now = Date.now();
    record(st, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'night' } });
    const id = `RUN-${Object.keys(loadState(st).items).filter(k => k.startsWith('RUN-')).length}`;
    record(st, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
    // move the night run's events back 5 h in the records file (the server folds the file)
    const fs = await import('node:fs'), path = await import('node:path'), file = path.join(st, 'runs.jsonl');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').map(l => { if (!l) return l; const e = JSON.parse(l); if (e.id === id) e.ts = iso(now - 5 * 3600000); return JSON.stringify(e); }).join('\n'));
    const ids = async w => (await f.get(`/api/agents?project=kestrel${w ? '&window=' + w : ''}`)).data.tree.map(n => n.id);
    assert.equal((await ids('')).includes(id), false, 'not in the default 2 h');
    assert.equal((await ids('12h')).includes(id), true, 'in the 12 h window');
    assert.equal((await f.get('/api/agents?project=kestrel&window=3d')).status, 400);
  } finally { await f.done(); }
});

test('the browser: Runs chips and the lane box survive a re-render and a reload (the URL); no sideways scroll at 390 px', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=runs`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && !!document.querySelector('[data-act=runs-show][data-show=failed]')`, 90000), 'Runs shows its state chips at once (no Filters disclosure)');
    assert.equal(await pg.ev(`!!document.querySelector('#runs-sum')`), false, 'no counter row: the counts are on the chips');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Runs at 390 px');
    await pg.ev(`document.querySelector('[data-act=runs-show][data-group=state][data-show=running]').click()`);
    assert.ok(await pg.until(`document.querySelector('[data-group=state][data-show=running]')?.getAttribute('aria-pressed') === 'false'`, 30000), 'the tap turns running off');
    assert.ok(await pg.until(`!document.querySelector('#node-RUN-2')`, 30000), 'the running codex run is hidden');
    assert.match(await pg.ev('location.search'), /state=look%2Cqueued%2Cfinished%2Cfailed/);
    await pg.ev(`document.querySelector('[data-act=runs-window][data-window="12h"]').click()`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && document.querySelector('[data-window="12h"]')?.getAttribute('aria-pressed') === 'true'`, 60000), 'the 12 h window is on');
    assert.match(await pg.ev('location.search'), /window=12h/);
    await pg.ev('location.reload()');
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && document.querySelector('[data-group=state][data-show=running]')?.getAttribute('aria-pressed') === 'false' && document.querySelector('[data-window="12h"]')?.getAttribute('aria-pressed') === 'true'`, 90000), 'the view is kept after a reload');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'still no sideways scroll');
    const type = t => pg.ev(`(() => { const b = document.querySelector('[data-runs-lane]'); b.focus(); b.value = ${JSON.stringify(t)}; b.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok(await pg.until(`!!document.querySelector('#node-RUN-1')`, 30000), 'the stopped seabed run shows');
    await type('zzz');
    assert.ok(await pg.until(`!document.querySelector('#node-RUN-1') && /No runs under these filters/.test(document.querySelector('.runtab').textContent)`, 30000), 'a lane that matches nothing hides it');
    await type('sea');
    assert.ok(await pg.until(`!!document.querySelector('#node-RUN-1') && document.activeElement?.matches('[data-runs-lane]') && document.activeElement.value === 'sea'`, 30000), 'the box keeps its focus across the repaint');
    assert.match(await pg.ev('location.search'), /lane=sea/);
  } finally { await pg.close(); await f.done(); }
});

// ---------- NORN-UI-RUNS (SPEC 4.3) + owner 2026-11-20: the table and the run drawer ----------
test('agentsTree: an ended run says why it ended (its end / lost event: who and why); part=live keeps the running runs, part=history the ended ones', () => {
  const s = mkTmp('runs-stop-'), now = Date.now();
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'seabed' } });
  record(s, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome: 'stopped', why: 'red test' } });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'gen' } });
  record(s, { kind: 'run', ev: 'lost', id: 'RUN-2', by: 'launcher', data: { why: 'no heartbeat for 12 min' } });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'render' } });
  const runs = runsOf(s), tree = agentsTree(runs, { now }), by = id => tree.find(n => n.id === id);
  assert.deepEqual(by('RUN-1').stop, { ev: 'end', by: 'launcher', why: 'red test' });
  assert.deepEqual(by('RUN-2').stop, { ev: 'lost', by: 'launcher', why: 'no heartbeat for 12 min' });
  assert.equal(by('RUN-3').stop, null, 'a running run has no stop');
  assert.deepEqual(agentsTree(runs, { now, part: 'live' }).map(n => n.id), ['RUN-3']);
  assert.deepEqual(agentsTree(runs, { now, part: 'history' }).map(n => n.id), ['RUN-1', 'RUN-2']);
});

test('/api/agents?part=live answers the running runs and the queue; part=history the ended runs only', async () => {
  const f = await fixture();
  try {
    const live = (await f.get('/api/agents?project=kestrel&part=live')).data, hist = (await f.get('/api/agents?project=kestrel&part=history')).data;
    assert.ok(live.tree.some(n => n.id === 'RUN-2') && !live.tree.some(n => n.id === 'RUN-1'), 'live: the running codex run, not the stopped one');
    assert.ok(hist.tree.some(n => n.id === 'RUN-1') && !hist.tree.some(n => n.id === 'RUN-2'), 'history: the stopped run only');
    assert.equal(hist.queue, undefined, 'the queue is live data');
    assert.ok(Array.isArray(live.queue));
    assert.equal(hist.tree.find(n => n.id === 'RUN-1').stop?.why, 'red test');
    assert.equal((await f.get('/api/agents?project=kestrel&part=all')).status, 400, 'an unknown part is refused');
  } finally { await f.done(); }
});

test('agentsTree: tools / words / commits from a Claude transcript (every line counts: a message comes one block per line); none read = null', () => {
  const s = mkTmp('runs-acts-'), file = path.join(s, 't.jsonl'), ts = new Date().toISOString();
  const line = (id, content, usage = { input_tokens: 1, output_tokens: 1 }) => JSON.stringify({ type: 'assistant', timestamp: ts, requestId: `r-${id}`, message: { id, model: 'claude-opus-5-5', usage, content } });
  fs.writeFileSync(file, [line('m1', [{ type: 'text', text: 'Reading the brief now.' }]), line('m1', [{ type: 'tool_use', name: 'Read', input: { file_path: 'a' } }]),
    line('m2', [{ type: 'tool_use', name: 'Bash', input: { command: 'git add -A && git commit -m "fix(x): y"' } }]), line('m3', [{ type: 'tool_use', name: 'Bash', input: { command: 'git -C wt commit -m z' } }]),
    line('m4', [{ type: 'tool_use', name: 'Bash', input: { command: 'git log --grep commit' } }]), JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'text', text: 'not the agent' }] } })].join('\n') + '\n');
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'seabed', transcript: file } });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'codex', lane: 'gen' } });
  const tree = agentsTree(runsOf(s), { now: Date.now() }), by = id => tree.find(n => n.id === id);
  assert.deepEqual(by('RUN-1').acts, { tools: 4, words: 4, commits: 2 }, '4 tool calls, the 4 words it wrote, 2 commits (git log --grep is not one)');
  assert.equal(by('RUN-2').acts, null, 'a codex run: not counted');
  const html = renderTab('runs', { tree }, { now: Date.now(), projects: [] });
  assert.match(rowOf(html, 'RUN-1'), /data-label="tools">4<\/td><td class="rnum mono" data-label="words">4<\/td><td class="rnum mono" data-label="commits">2<\/td>/, 'the counts in the row');
  assert.match(rowOf(html, 'RUN-2'), /data-label="tools"><span class="mute">-<\/span><\/td>/, 'none read: a dash');
});

const NOW = Date.parse('2026-11-19T12:00:00Z'), ago = x => iso(NOW - x * 60000);
const pace = (state, extra = {}) => ({ line: '2 of 4 items done, editing item 3', items: [1, 2, 3, 4].map(n => ({ n, title: `item ${n}`, state: n <= 2 ? 'done' : n === 3 ? 'doing' : 'open' })), done: 2, total: 4,
  pace: { state, elapsed_min: 100, budget_min: 90, sessions: 1, handoffs: 0, estimate: { min: 60, n: 4 } }, slow: { line: state === 'on track' ? null : `${state}: 40 % of the last hour in test runs` }, alarms: [], ...extra });
const listFixture = () => ({
  tree: [
    { id: 'RUN-1', name: 'amber-fox', kind: 'worker', executor: 'claude', lane: 'seabed', stage: 'S2', state: 'exited', outcome: 'stopped', stop: { ev: 'end', by: 'launcher', why: 'red test' }, started: ago(120), ended: ago(30), project: 'kestrel', progress: pace('slow'), children: [] },
    { id: 'RUN-2', name: 'quiet-heron', dwarf: { id: 'quiet-heron', name: 'quiet-heron' }, kind: 'worker', executor: 'claude', model: 'claude-opus-5-5', effort: 'medium', lane: 'render', stage: 'R1', state: 'running', started: ago(100), project: 'kestrel', progress: pace('slow'), acts: { tools: 41, words: 1200, commits: 3 }, children: [] },
    { id: 'RUN-3', name: 'still-moth', kind: 'worker', executor: 'claude', lane: 'gen', state: 'running', started: ago(40), project: 'kestrel', progress: pace('stalled'), children: [] },
    { id: 'RUN-4', name: 'swift-wren', kind: 'worker', executor: 'claude', lane: 'gen', state: 'running', started: ago(10), project: 'kestrel', progress: pace('on track'), children: [] },
    ...[50, 20, 9].map((m, i) => ({ id: `RUN-${10 + i}`, name: `check-${i}`, kind: 'checkin', executor: 'claude', state: 'exited', outcome: 'done', started: ago(m + 3), ended: ago(m), project: 'kestrel', children: [] })),
  ],
  queue: [{ id: 'RUN-9', name: 'next-owl', kind: 'worker', lane: 'gen', stage: 'G2', queued: ago(25), project: 'kestrel' }],
  plan: { parts: [{ project: 'kestrel', priorities: ['P0', 'P1', 'P2'], upnext: [{ id: 'RUN-9', position: 1, label: 'gen G2', status: 'waiting', priority: 'P1',
    estimate: { word: '~40 min', basis: 'history', n: 3 }, start: { at: null, word: 'after RUN-3 is done' }, holds: ['after RUN-3 is done'] }] }] },
});

test('the Runs table: one row per run by attention (live, queued, ended), the state chips with "need a look" and their counts, no counter row; check-ins fold into one row', () => {
  const d = listFixture(), html = renderTab('runs', d, { now: NOW, projects: [], runsView: runsViewOf(new URLSearchParams()) });
  assert.doesNotMatch(html, /class="subnum|id="runs-sum"/, 'no counter row');
  assert.doesNotMatch(html, /class="rband"/, 'no bands: one table');
  assert.deepEqual([...html.matchAll(/id="node-([^"]+)"/g)].map(x => x[1]), ['RUN-3', 'RUN-2', 'RUN-4', 'RUN-9', 'RUN-1'], 'stalled, slow, on track, the queue, the ended run');
  assert.deepEqual(d.tree.map(runShowOf), ['failed', 'look', 'look', 'running', 'finished', 'finished', 'finished'], 'a stalled or slow live run needs a look');
  assert.match(html, /<span class="fchips" role="group" aria-label="state"><button class="hf" data-act="runs-show" data-group="state" data-show="running" aria-pressed="true">running <b>1<\/b><\/button><button class="hf" data-act="runs-show" data-group="state" data-show="look" aria-pressed="true">need a look <b>2<\/b>/, 'the state chips are filterChips with counts');
  const live = rowOf(html, 'RUN-2');
  assert.match(live, /RUN-2/); assert.match(live, /quiet-heron/, 'name and id always in the row');
  assert.match(live, /chip warn">slow</, 'a live row: its pace');
  assert.match(live, /40 % of the last hour in test runs/, 'why slow, in words');
  assert.match(live, /2 of 4/, 'items as n of m');
  assert.match(live, /1 h 40 \/ 1 h 30/, 'time against the budget in words');
  assert.match(live, /data-label="tools">41<\/td>[^]*data-label="words">1,?200<\/td>[^]*data-label="commits">3<\/td>/, 'the counts');
  assert.match(live, /data-feed="RUN-2"/, 'a row opens its run');
  const ended = rowOf(html, 'RUN-1');
  assert.match(ended, /red test/, 'an ended row says why it ended');
  assert.match(ended, /ended 30 min ago/);
  assert.doesNotMatch(ended, /chip (warn|bad|ok|idle)">(slow|on track|stalled)</, 'no pace chip on an ended run');
  assert.match(ended, /class="[^"]*\bended\b/, 'ended rows read in the muted tone');
  const q = rowOf(html, 'RUN-9');
  assert.match(q, /after RUN-3 is done/, 'a queued row says what it waits for');
  assert.match(q, /~40 min/, 'its estimate');
  assert.match(q, /waited 25 min/);
  assert.match(q, /<select class="pl-prio" data-act="prio" data-project="kestrel" data-run="RUN-9"[^>]*>[^]*<option selected>P1<\/option>/, 'the priority control');
  assert.doesNotMatch(html, /id="node-RUN-1[012]"/, 'check-ins are folded');
  assert.match(html, /3 check-ins · last 9 min ago · all done/);
  assert.match(html, /data-act="runs-checkins"/);
  const open = renderTab('runs', d, { now: NOW, projects: [], runsView: { ...runsViewOf(new URLSearchParams()), ck: true } });
  assert.match(open, /id="node-RUN-12"/, 'show them: the check-in rows');
  assert.match(html, /aria-label="Filter by lane"/, 'the lane box has a label');
  const look = renderTab('runs', d, { now: NOW, projects: [], runsView: runsViewOf(new URLSearchParams('state=look')) });
  assert.deepEqual([...look.matchAll(/id="node-([^"]+)"/g)].map(x => x[1]), ['RUN-3', 'RUN-2'], 'need a look alone: the stalled and the slow run');
});

test('the run drawer: none without &run=; the picked run with Close, Stop and Pause on a live run, Copy link always; an ended run shows its result', () => {
  const d = listFixture(), view = runsViewOf(new URLSearchParams());
  assert.doesNotMatch(renderTab('runs', d, { now: NOW, projects: [], runsView: view }), /id="run-doc"/, 'no &run=: the table alone');
  const live = renderTab('runs', d, { now: NOW, projects: [], runsView: view, run: 'RUN-2' });
  const doc = live.slice(live.indexOf('id="run-doc"'));
  assert.match(live, /<article class="rdoc drawer" id="run-doc" data-run="RUN-2"/, 'the run document is the drawer');
  assert.match(doc, /data-act="runs-close"/, 'Close');
  assert.match(doc, /data-act="stop" data-project="kestrel" data-run="RUN-2"/, 'Stop on a live run');
  assert.match(doc, /data-act="run-link"/, 'Copy link');
  assert.match(doc, /id="run-feed-slot"/, 'the live feed slot');
  assert.match(doc, /item 3/, 'the checklist');
  assert.match(live, /class="rrow[^"]*\bsel\b[^"]*" id="node-RUN-2"/, 'the table marks the open run');
  const end = renderTab('runs', d, { now: NOW, projects: [], runsView: view, run: 'RUN-1' }), ed = end.slice(end.indexOf('id="run-doc"'));
  assert.doesNotMatch(ed, /data-act="stop"/, 'no Stop on an ended run');
  assert.match(ed, /id="run-result"[^]*stopped[^]*red test/, 'the result card: the outcome and why');
  assert.match(ed, /data-act="run-link"/);
  const gone = renderTab('runs', d, { now: NOW, projects: [], runsView: view, run: 'RUN-999' });
  assert.match(gone, /id="run-doc"[^]*data-act="runs-close"[^]*RUN-999 is not in this window/, 'a run outside the window says so, and closes');
});

test('the browser: a row opens the run drawer at its URL (reload, Back), Esc and Close shut it, Stop posts with confirm, the live rows paint with part=history held back; 390 px: no sideways scroll', { skip: skipWhy, timeout: 240000 }, async () => {
  const f = await fixture(), pg = await openPage([1440, 900]);
  try {
    await pg.send('Fetch.enable', { patterns: [{ urlPattern: '*part=history*' }] });   // the history part never answers: the live rows must not wait for it
    await pg.go(`${f.url}/?project=kestrel&tab=runs`, 60000);
    const t0 = Date.now();
    assert.ok(await pg.until(`!!document.querySelector('.runtab #node-RUN-2')`, 30000), 'the live row paints');
    assert.ok(Date.now() - t0 < 1000, 'within 1 s of the page being ready');
    assert.equal(await pg.ev(`!!document.querySelector('#run-doc')`), false, 'no drawer until a row is picked');
    assert.match(await pg.ev(`document.querySelector('.runtab')?.textContent ?? ''`), /loading the ended runs/, 'the ended runs wait, marked');
    await pg.send('Fetch.disable');
    await pg.ev(`document.querySelector('#node-RUN-2').click()`);
    assert.ok(await pg.until(`document.querySelector('#run-doc')?.dataset.run === 'RUN-2' && /run=RUN-2/.test(location.search)`, 30000), 'a click opens the drawer at the run URL');
    await pg.ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.ok(await pg.until(`!document.querySelector('#run-doc') && !/run=/.test(location.search)`, 30000), 'Esc closes the drawer');
    await pg.until(`document.activeElement?.id === 'node-RUN-2'`, 5000).catch(() => null);
    assert.equal(await pg.ev(`document.activeElement?.id || document.activeElement?.outerHTML?.slice(0, 120)`), 'node-RUN-2', 'the focus back on the row');
    await pg.ev(`document.querySelector('#node-RUN-2').click()`);
    assert.ok(await pg.until(`document.querySelector('#run-doc')?.dataset.run === 'RUN-2' && /run=RUN-2/.test(location.search)`, 30000), 'a click opens the drawer at the run URL');
    await pg.ev(`(() => { window.__posts = []; const f0 = window.fetch; window.fetch = (u, o) => { if (o?.method === 'POST') window.__posts.push([String(u), o.body]); return f0(u, o); }; window.confirm = () => true; })()`);
    await pg.ev(`document.querySelector('#run-doc [data-act=stop]').click()`);
    assert.ok(await pg.until(`window.__posts.some(([u]) => u.includes('/api/stop'))`, 10000), 'Stop posts /api/stop');
    assert.deepEqual(JSON.parse(await pg.ev(`window.__posts.find(([u]) => u.includes('/api/stop'))[1]`)), { project: 'kestrel', run: 'RUN-2', confirm: true });
    await pg.go(`${f.url}/?project=kestrel&tab=runs&window=12h`, 60000);
    assert.ok(await pg.until(`!!document.querySelector('#node-RUN-1')`, 60000), 'the ended run in the table');
    await pg.ev(`document.querySelector('#node-RUN-1').click()`);
    assert.ok(await pg.until(`document.querySelector('#run-doc')?.dataset.run === 'RUN-1' && /run=RUN-1/.test(location.search)`, 30000), 'a click opens the run at its URL');
    await pg.ev('location.reload()');
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && document.querySelector('#run-doc')?.dataset.run === 'RUN-1'`, 60000), 'a reload keeps the run');
    await pg.ev('history.back()');
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && !/run=/.test(location.search) && !document.querySelector('#run-doc')`, 60000), 'Back: the table without the drawer');
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=runs`, 60000);
    assert.ok(await pg.until(`!!document.querySelector('#node-RUN-2')`, 30000), 'a phone: the table');
    assert.ok(await pg.ev(`document.querySelector('#node-RUN-2').getBoundingClientRect().top < 844`), 'the first run row is on the first screen');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on the table');
    await pg.ev(`document.querySelector('#node-RUN-2').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#run-doc')`, 30000), 'the drawer opens');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll with the drawer');
    await pg.ev(`document.querySelector('[data-act=runs-close]').click()`);
    assert.ok(await pg.until(`!document.querySelector('#run-doc') && !/run=/.test(location.search) && document.activeElement?.id === 'node-RUN-2'`, 30000), 'Close returns to the table, focus on the run');
  } finally { await pg.close(); await f.done(); }
});
