// RM-19 S1: the Lanes page shows what is live first - group order, done ages, the Old fade, the filter chips (URL), one-tap
// Archive with Undo, and the owner's archive that "did not take effect" (a guard refusal wiped by the next live re-render).
// Sandbox only: the shared dash fixture (temp dirs), fixture git repos and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record, loadState } from '../engine/lib/records.mjs';
import { lanesView, sortLanes } from '../engine/lib/lanes.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

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

test('lanesView: running, needs you, queued, done, archived; ended and Old from oldDays; sortLanes is newest first in a group', () => {
  const s = mkTmp('rm19-lanes-');
  for (const n of ['run', 'stop', 'idle', 'fin', 'gone', 'parkd']) record(s, { kind: 'lane', ev: 'create', by: 'controller', data: { name: n } });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'stop' } });
  record(s, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome: 'stopped', why: 'red' } });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'fin' } });
  record(s, { kind: 'run', ev: 'end', id: 'RUN-2', by: 'launcher', data: { exit: 0, outcome: 'done' } });
  record(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'run' } });
  record(s, { kind: 'lane', ev: 'archive', id: 'L:gone', by: 'controller', data: {} });
  record(s, { kind: 'lane', ev: 'park', id: 'L:parkd', by: 'controller', data: { why: 'owner call' } });
  const st = loadState(s), v = lanesView(st, { all: true, oldDays: 2 });
  // records written in the same second tie on `at`, so the needs pair is checked as a set; sortLanes' newest-first is checked below
  assert.deepEqual(v.map(l => l.group), ['running', 'needs', 'needs', 'queued', 'done', 'archived']);
  assert.deepEqual(v.map(l => l.name).filter(n => n !== 'stop' && n !== 'parkd'), ['run', 'idle', 'fin', 'gone']);
  assert.deepEqual(v.filter(l => l.group === 'needs').map(l => l.name).sort(), ['parkd', 'stop']);
  const fin = v.find(l => l.name === 'fin');
  assert.equal(fin.ended, st.items['RUN-2'].history.findLast(h => h.ev === 'end').ts); assert.equal(fin.at, fin.ended); assert.equal(fin.old, false);
  assert.equal(lanesView(st, { now: Date.now() + 3 * 864e5, oldDays: 2 }).find(l => l.name === 'fin').old, true, 'ended 3 d ago, threshold 2 d: Old');
  assert.equal(lanesView(st, { now: Date.now() + 3 * 864e5, oldDays: 5 }).find(l => l.name === 'fin').old, false, 'threshold 5 d: not Old');
  assert.deepEqual(lanesView(st).map(l => l.group).filter(g => g === 'archived' || g === 'done'), ['done'], 'without all: no archived lane; an active lane whose run exited DONE is done');
  const rows = [{ name: 'd1', group: 'done', at: '2026-01-01' }, { name: 'a', group: 'archived', at: '2026-12-01' }, { name: 'd2', group: 'done', at: '2026-02-01' }, { name: 'r', group: 'running', at: '2025-01-01' }];
  assert.deepEqual(sortLanes(rows).map(r => r.name), ['r', 'd2', 'd1', 'a']);
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
    assert.match(await pg.ev('location.search'), /lanes=active%2Cdone%2Cold|lanes=active,done,old/);
    record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'poke the stream', via: 'chat' } });
    assert.ok(await repainted(pg, 'seabed'), 'the stream re-renders the page');
    assert.equal(await pg.ev(`document.querySelector('[data-show=old]').getAttribute('aria-pressed')`), 'true', 'Old is still on after a re-render');
    await pg.ev('location.reload()');
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && document.querySelector('[data-show=old]')?.getAttribute('aria-pressed') === 'true'`, 90000), 'Old is still on after a reload');
    await pg.ev(`document.querySelector('[data-act=lane-show][data-show=active]').click()`);
    assert.ok(await pg.until(`document.querySelector('[data-show=active]')?.getAttribute('aria-pressed') === 'false' && !document.querySelector('#lane-seabed')`, 30000), 'Active off hides the active lanes');
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
