// The Lanes page: the board groups of the rows, newest first in a group, the filter chips (URL), one-tap
// Archive with Undo, and the owner's archive that "did not take effect" (a guard refusal wiped by the next live re-render).
// Sandbox only: the shared dash fixture (temp dirs), fixture git repos and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record, loadState } from '../engine/lib/records.mjs';
import { lanesView, sortLanes, boardOf } from '../engine/lib/lanes.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';
import { loadTab, renderTab } from '../engine/dash/ui.mjs';

const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => { fs.writeFileSync(path.join(repo, file), text); g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); };
// a deliverable on lane seabed whose branch is not merged into main: archiveGuard refuses `lane archive` on seabed
function unmergedDlv(f) {
  const repo = f.pa.root;
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false'); commit(repo, 'README.md', 'r', 'init');
  g(repo, 'checkout', '-q', '-b', 'feat/s'); commit(repo, 's.txt', 's', 'feat: s'); g(repo, 'checkout', '-q', 'main');
  record(f.pa.state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo, branch: 'feat/s', lane: 'seabed', delivers: 'the seabed' } }, { views: false });
}
// wait for the next paint of the Lanes page: a mark on the row is gone once #main is painted again
const repainted = async (pg, lane) => { await pg.ev(`document.querySelector('#lane-${lane}') && (document.querySelector('#lane-${lane}').dataset.mark = '1')`);
  return pg.until(`document.body.dataset.ready === 'lanes' && !document.querySelector('#lane-${lane}[data-mark]')`, 60000); };

test('the browser: a refused Archive keeps its reason on the row through a live re-render (the owner\'s archive that did not take effect)', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    unmergedDlv(f);
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('[data-act=archive][data-lane=seabed]')`, 90000), 'Lanes shows seabed with Archive');
    await pg.ev(`window.confirm = () => true; document.querySelector('[data-act=archive][data-lane=seabed]').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#lane-seabed')`, 30000), 'the refused lane is back on the page');
    record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'poke the stream', via: 'chat' } });
    assert.ok(await repainted(pg, 'seabed'), 'the stream re-renders the page');
    assert.match(await pg.ev(`document.querySelector('#lane-seabed .lane-refused')?.textContent ?? ''`), /cannot be archived/, 'the refusal is still on the row');
  } finally { await pg.close(); await f.done(); }
});

// DWARVES S1: every page that names a run shows the dwarf who ran it (the server row's dwarf: { id, name }); a run with no dwarf shows its kind word
// UI redesign 2026-11-20 (ui-inbox-ledger): the Inbox holds questions and owner cards only - an unreviewed run shows in Lanes
test('Lanes and Runs show the dwarf who ran it, the unreviewed stopped run in its Lanes row too; a run with no dwarf shows its kind word, never data.name', async () => {
  const f = await fixture();
  try {
    const get = async p => (await f.get(p)).data;
    const lanes = (await f.get('/api/lanes?project=kestrel')).data.lanes;
    assert.deepEqual(lanes.find(l => l.name === 'render').dwarf, { id: 'vondrak-torchgrip', name: 'Vondrak Torchgrip' }, 'the name from the crew store');
    assert.ok(!lanes.some(l => 'run_name' in l), 'no run_name any more');
    const oin = '<b class="aname" data-dwarf="vondrak-torchgrip">Vondrak Torchgrip</b>';
    for (const tab of ['runs', 'lanes']) assert.ok(renderTab(tab, await loadTab(tab, 'kestrel', get), { project: 'kestrel' }).includes(oin), tab);
    assert.match(renderTab('lanes', await loadTab('lanes', 'kestrel', get), { project: 'kestrel' }), /<span class="fl-run t-stopped">[\s\S]{0,200}?<b>RUN-1<\/b> <b class="aname" data-dwarf="harvald-marblekeg">Harvald Marblekeg<\/b>/, 'lanes: the unreviewed stopped run');
    record(f.pa.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'claude', lane: 'seabed', name: 'tawny-falcon' } });
    const html = renderTab('lanes', await loadTab('lanes', 'kestrel', get), { project: 'kestrel' });
    assert.ok(html.includes('<span class="mute">check-in</span>'), 'no dwarf: the kind word');
    assert.ok(!html.includes('tawny-falcon'), 'a run\'s old data.name is never read');
  } finally { await f.done(); }
});

// owner 2026-11-18: the Lanes row's Log opened /log (the supervisor's plain-text tail, a line with a file path) in a new browser
// tab. Stage NAV (SPEC: one run URL): every Feed link goes to ?tab=runs&run=RUN-n; stage RUNS: the run's document and its live feed
// open there, and Back returns to Lanes.
test('the browser: a lane row\'s Feed opens its run\'s document and live feed at the run URL (no new tab, no /log link)', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('[data-act=lane-feed]')`, 90000), 'a lane row has Feed');
    assert.equal(await pg.ev(`document.querySelectorAll('#main a[href^="/log"]').length`), 0, 'no /log link left on the page');
    const run = await pg.ev(`document.querySelector('[data-act=lane-feed]').dataset.run`);
    await pg.ev(`document.querySelector('[data-act=lane-feed]').click()`);
    assert.ok(await pg.until(`document.querySelector('#run-doc')?.dataset.run === '${run}' && !!document.querySelector('#run-feed #feed-head')?.textContent.includes('${run}')`, 30000), `the run document shows ${run}`);
    assert.equal(await pg.ev(`document.body.dataset.tab`), 'runs', 'the run URL is a Runs page');
    assert.equal(await pg.ev(`new URL(location.href).searchParams.get('run')`), run, 'the URL names the run, so a reload keeps it open');
  } finally { await pg.close(); await f.done(); }
});

test('lanesView + boardOf: running, stopped, waiting, done today, archived, parked; ended and at; sortLanes is newest first', () => {
  const s = mkTmp('rm19-lanes-');
  for (const n of ['run', 'stop', 'idle', 'fin', 'gone', 'parkd']) record(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name: n } });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'stop' } });
  record(s, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome: 'stopped', why: 'red' } });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'fin' } });
  record(s, { kind: 'run', ev: 'end', id: 'RUN-2', by: 'launcher', data: { exit: 0, outcome: 'done' } });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'run' } });
  record(s, { kind: 'lane', ev: 'archive', id: 'L:gone', by: 'controller', data: {} });
  record(s, { kind: 'lane', ev: 'park', id: 'L:parkd', by: 'controller', data: { why: 'owner call' } });
  const st = loadState(s), v = lanesView(st, { all: true }), by = n => v.find(l => l.name === n);
  assert.deepEqual(Object.fromEntries(v.map(l => [l.name, boardOf({ ...l, needs: 0 })])), { run: 'running', stop: 'stopped', idle: 'waiting', fin: 'today', gone: 'archived', parkd: 'parked' });
  const fin = by('fin');
  assert.equal(fin.ended, st.items['RUN-2'].history.findLast(h => h.ev === 'end').ts); assert.equal(fin.at, fin.ended, 'an ended lane sorts by its end');
  assert.equal(by('run').at, st.items['RUN-3'].created, 'a live lane sorts by the start of its run');
  assert.equal(boardOf({ ...fin, needs: 0 }, Date.now() + 3 * 864e5), 'old', 'done before today: Old');
  assert.deepEqual(lanesView(st).map(l => l.name).sort(), ['fin', 'idle', 'parkd', 'run', 'stop'], 'without all: no archived lane');
  const rows = [{ name: 'd1', at: '2026-01-01' }, { name: 'a', at: '2026-12-01' }, { name: 'd2', at: '2026-02-01' }, { name: 'r', at: '2025-01-01' }];
  assert.deepEqual(sortLanes(rows).map(r => r.name), ['a', 'd2', 'd1', 'r']);
});

// fair-slots items 2 + 3 (owner 2026-11-19): a lane whose build is DONE and whose MERGE waits read only 'queued'; once merge-land
// opened the PR it reads 'awaiting PR approval'. Each queued / running lane says its run's priority (none = the default P2, marked)
// and a queued one its place in the fill order.
test('lanesView: done - awaiting merge, awaiting PR approval; the run priority on every lane with a run (P2 default marked, live while queued / running), the fill position; who runs it', () => {
  const s = mkTmp('fair-lanes-');
  for (const n of ['mrg', 'prd', 'fast', 'live', 'red']) record(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name: n } });
  const run = (lane, extra = {}, outcome) => { const e = record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane, ...extra } });
    if (outcome) record(s, { kind: 'run', ev: 'end', id: e.id, by: 'launcher', data: { exit: 0, outcome } }); return e.id; };
  const queue = (lane, extra = {}) => record(s, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane, ...extra } });
  run('mrg', {}, 'done'); queue('mrg', { stage: 'MERGE' });         // build DONE, its MERGE queued (no priority: P2)
  run('prd', {}, 'done'); run('prd', { stage: 'MERGE', priority: 'P1' }, 'done');   // merged by merge-land: a PR is open
  queue('fast', { priority: 'P1' });                                // a queued build at P1: after the P2 MERGEs (MERGE-FIRST)
  run('live', { priority: 'P0', agent: 'kestrel-implementer', model: 'claude-opus-5-5', effort: 'medium' });   // running at P0
  run('red', {}, 'stopped'); queue('red', { stage: 'MERGE' });      // the build did not finish: its queued MERGE is plain queued
  const v = lanesView(loadState(s), { prs: { prd: { url: 'https://github.com/o/r/pull/7', number: 7 } } }), by = n => v.find(l => l.name === n);
  assert.equal(by('mrg').land, 'awaiting-merge'); assert.equal(by('mrg').text, 'done - awaiting merge'); assert.equal(boardOf({ ...by('mrg'), needs: 0 }), 'waiting');
  assert.equal(by('prd').land, 'awaiting-pr'); assert.equal(by('prd').text, 'awaiting PR approval: PR #7'); assert.equal(by('prd').pr.number, 7);
  assert.equal(boardOf({ ...by('prd'), needs: 0, dlv: { step: 'pr', pr: 7 } }), 'land', 'a PR to approve: To land');
  assert.equal(by('red').land, null); assert.equal(by('red').text, 'queued');
  assert.deepEqual(by('mrg').priority, { p: 'P2', dflt: true, live: true }, 'no priority: the default P2, marked as the default');
  assert.deepEqual(by('fast').priority, { p: 'P1', dflt: false, live: true }); assert.deepEqual(by('live').priority, { p: 'P0', dflt: false, live: true });
  assert.deepEqual(by('prd').priority, { p: 'P1', dflt: false, live: false }, 'an ended run keeps its priority (not changeable)');
  assert.deepEqual([by('live').agent, by('live').model, by('live').effort], ['kestrel-implementer', 'claude-opus-5-5', 'medium'], 'who runs it');
  assert.deepEqual([by('fast').agent, by('fast').model, by('fast').effort], [null, null, null]);
  // MERGE-FIRST (runs.mjs fillKey): a landing run outranks the runs of one priority level above, so the two P2 MERGEs go before the P1 build
  assert.deepEqual([by('mrg').position, by('red').position, by('fast').position], [1, 2, 3], 'the fill order: landing first (FIFO), then the P1 build');
  assert.equal(by('live').position, null, 'a running run has no queue position');
  assert.equal(lanesView(loadState(s)).find(l => l.name === 'prd').land, null, 'no PR known: no awaiting PR approval');
});

test('the browser: the filter chips survive a live re-render and a reload (the URL); the phone has no sideways scroll', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('[data-act=lane-show][data-show=old]')`, 90000), 'Lanes shows the chips');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Lanes at 390 px');
    assert.equal(await pg.ev(`!!document.querySelector('[data-act=lanes-all]')`), false, 'the old checkbox is gone');
    assert.equal(await pg.ev(`document.querySelector('[data-show=old]').getAttribute('aria-pressed')`), 'false');
    await pg.ev(`document.querySelector('[data-act=lane-show][data-show=old]').click()`);
    assert.ok(await pg.until(`document.querySelector('[data-show=old]')?.getAttribute('aria-pressed') === 'true'`, 30000), 'the tap turns Old on');
    assert.match(decodeURIComponent(await pg.ev('location.search')), /show=needs,running,stopped,waiting,land,old(&|$)/, 'the groups are in the URL');
    record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'poke the stream', via: 'chat' } });
    assert.ok(await repainted(pg, 'seabed'), 'the stream re-renders the page');
    assert.equal(await pg.ev(`document.querySelector('[data-show=old]').getAttribute('aria-pressed')`), 'true', 'Old is still on after a re-render');
    await pg.ev('location.reload()');
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && document.querySelector('[data-show=old]')?.getAttribute('aria-pressed') === 'true'`, 90000), 'Old is still on after a reload');
    // gen (its open Q-1) is the Needs-you lane; seabed's unreviewed stopped run is Stopped - no Inbox row names it since ui-inbox-ledger
    await pg.ev(`document.querySelector('[data-act=lane-show][data-show=needs]').click()`);
    assert.ok(await pg.until(`document.querySelector('[data-show=needs]')?.getAttribute('aria-pressed') === 'false' && !document.querySelector('#lane-gen') && !!document.querySelector('#lane-seabed')`, 30000), 'Needs you off hides its lanes');
  } finally { await pg.close(); await f.done(); }
});

test('the browser: Archive acts on the tap - the row leaves at once, an Undo shows, Undo brings it back', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage();
  try {
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('[data-act=archive][data-lane=seabed]')`, 90000), 'Lanes shows seabed with Archive');
    const gone = await pg.ev(`window.confirm = () => { throw new Error('no confirm on Archive'); }; document.querySelector('[data-act=archive][data-lane=seabed]').click(); !document.querySelector('#lane-seabed')`);
    assert.equal(gone, true, 'the row leaves on the tap, before the server answers');
    assert.ok(await pg.until(`!!document.querySelector('#lane-undo [data-act=lane-undo]')`, 30000), 'the Undo shows');
    assert.equal(loadState(f.pa.state).items['L:seabed'].state, 'archived');
    assert.equal(await pg.ev(`!!document.querySelector('#lane-seabed')`), false, 'still gone after the archive lands');
    await pg.ev(`document.querySelector('#lane-undo [data-act=lane-undo]').click()`);
    assert.ok(await pg.until(`!!document.querySelector('#lane-seabed') && !document.querySelector('#lane-undo')`, 30000), 'Undo brings the row back');
    assert.equal(loadState(f.pa.state).items['L:seabed'].state, 'active');
  } finally { await pg.close(); await f.done(); }
});
