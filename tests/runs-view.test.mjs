// The Runs page (owner 2026-11-19): running first, then queued, then ended; 'ran' (start to end) and 'ended' (how long ago) from the
// run's own start / end events instead of an 'age' since birth; state / kind / project chips, a lane box and the window (2 h / 12 h /
// 24 h / all today), all in the URL. Sandbox only: temp state dirs, the shared dash fixture and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { record, loadState } from '../engine/lib/records.mjs';
import { agentsTree, endedAt, windowMs, RUN_WINDOWS } from '../engine/lib/agents.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { runTimes, runsOrder, runsFilter, runsViewOf, runsViewQs, runStateOf, runKindOf, RUNS_WINDOWS } from '../engine/dash/pages/runs.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const iso = ms => new Date(ms).toISOString();
const runsOf = s => Object.values(loadState(s).items).filter(i => i.kind === 'run');
const at = (r, ev, ms) => { r.history.find(h => h.ev === ev).ts = iso(ms); if (ev === 'start') r.created = iso(ms); };

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
  assert.match(html, /id="node-RUN-1"[^]*?<div class="small run-ran">40 min<\/div><div class="small run-ended">50 min ago<\/div>/);
  assert.match(html, /id="node-RUN-2"[^]*?<div class="small run-ran">25 min<\/div><div class="small run-ended"><\/div>/, 'ended is empty while running');
  assert.match(html, /<div title="How long the run ran: [^"]+">ran<\/div><div title="How long ago the run ended[^"]+">ended<\/div>/, 'each time header says what it measures');
  assert.doesNotMatch(html, />age</, 'no age column');
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
  assert.match(html, /id="node-RUN-7"[^]*?<div class="small run-ran">queued for 20 min<\/div>/);
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
  assert.match(html, /ended in the last 24 h/);
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
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && !!document.querySelector('[data-act=runs-show][data-show=failed]')`, 90000), 'Runs shows the chips');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Runs at 390 px');
    await pg.ev(`document.querySelector('[data-act=runs-show][data-group=state][data-show=running]').click()`);
    assert.ok(await pg.until(`document.querySelector('[data-group=state][data-show=running]')?.getAttribute('aria-pressed') === 'false'`, 30000), 'the tap turns running off');
    assert.ok(await pg.until(`!document.querySelector('#node-RUN-2')`, 30000), 'the running codex run is hidden');
    assert.match(await pg.ev('location.search'), /state=queued%2Cfinished%2Cfailed/);
    await pg.ev(`document.querySelector('[data-act=runs-window][data-window="12h"]').click()`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && document.querySelector('[data-window="12h"]')?.getAttribute('aria-pressed') === 'true'`, 60000), 'the 12 h window is on');
    assert.match(await pg.ev('location.search'), /window=12h/);
    await pg.ev('location.reload()');
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && document.querySelector('[data-group=state][data-show=running]')?.getAttribute('aria-pressed') === 'false' && document.querySelector('[data-window="12h"]')?.getAttribute('aria-pressed') === 'true'`, 90000), 'the view is kept after a reload');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'still no sideways scroll');
    const type = t => pg.ev(`(() => { const b = document.querySelector('[data-runs-lane]'); b.focus(); b.value = ${JSON.stringify(t)}; b.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.ok(await pg.until(`!!document.querySelector('#node-RUN-1')`, 30000), 'the stopped seabed run shows');
    await type('zzz');
    assert.ok(await pg.until(`!document.querySelector('#node-RUN-1') && /No runs under these filters/.test(document.querySelector('.tree').textContent)`, 30000), 'a lane that matches nothing hides it');
    await type('sea');
    assert.ok(await pg.until(`!!document.querySelector('#node-RUN-1') && document.activeElement?.matches('[data-runs-lane]') && document.activeElement.value === 'sea'`, 30000), 'the box keeps its focus across the repaint');
    assert.match(await pg.ev('location.search'), /lane=sea/);
  } finally { await pg.close(); await f.done(); }
});
