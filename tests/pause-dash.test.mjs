// RM-37 safe pause on the dashboard: POST /api/pause sets a named mode / pauses runs / resumes; the overview says the mode and what
// waits on it; the header's pause menu (ui.mjs pauseMenu) lists each mode with its effect, the waiting runs, Pause half and Resume all;
// a Runs / Lanes row offers Pause (running), says pausing (asked) and Resume (a paused hand-off); the menu fits a phone (390 px).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/dash-fixture.mjs';
import { record } from '../engine/lib/records.mjs';
import { pauseMenu, renderTab } from '../engine/dash/ui.mjs';
import { pauseAct } from '../engine/dash/cells.mjs';
import { PAUSE_MODES } from '../engine/lib/pausemode.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

test('pause routes: a named mode, a safe pause of one run, the pick of pause half, resume all; the overview and the rows say each', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state, ov = async () => (await f.get('/api/overview?project=kestrel')).data;
    const lane = async n => (await f.get('/api/lanes?project=kestrel')).data.lanes.find(l => l.name === n);
    assert.equal((await ov()).pause, null);
    assert.equal((await f.post('/api/pause', { project: 'kestrel', mode: 'nap' })).status >= 400, true, 'an unknown mode is refused');
    assert.equal((await f.post('/api/pause', { project: 'kestrel', mode: 'queue', runs: ['RUN-2'] })).status, 400, 'one ask at a time');
    assert.equal((await f.post('/api/pause', { project: 'kestrel', runs: ['two'] })).status, 400);
    const r = await f.post('/api/pause', { project: 'kestrel', mode: 'queue', why: 'machine is hot' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    record(S, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'gen' } });
    let o = await ov();
    assert.deepEqual([o.pause.mode, o.pause.label, o.pause.by, o.pause.why, o.pause.checkins], ['queue', 'Hold the queue', 'dashboard', 'machine is hot', false]);
    assert.deepEqual(o.modes.map(m => m.mode), Object.keys(PAUSE_MODES));
    assert.ok(o.waiting.held >= 1, 'Hold the queue counts the queued runs it holds');
    const h = pauseMenu(o, { now: Date.parse(o.now) });
    for (const m of Object.values(PAUSE_MODES)) { assert.ok(h.includes(m.label), m.label); assert.ok(h.includes(m.says.replace(/'/g, '&#39;')), m.says); }
    assert.match(h, /Now: Hold the queue/); assert.match(h, /by dashboard/); assert.match(h, /machine is hot/);
    assert.match(h, /data-act="pause-mode" data-mode="queue" aria-pressed="true" disabled/, 'the mode in force is marked');
    assert.match(h, /\d+ queued runs? held until release/);
    assert.match(h, /data-act="pause-half"/); assert.match(h, /data-act="pause-resume-all">/, 'Resume all is live while a pause holds');

    // the safe pause of one run: RUN-2 (lane render) is a running work run
    assert.equal((await lane('render')).pause, 'running');
    assert.match(renderTab('lanes', { lanes: [await lane('render')] }, { now: Date.now() }), /data-act="run-pause" data-project="kestrel" data-run="RUN-2"/);
    const half = (await f.post('/api/pause/half', { project: 'kestrel' })).data;
    assert.deepEqual(half.pick.map(p => p.id), ['RUN-2']); assert.match(half.line, /^Pause 1 of 1 running: RUN-2 \(render\)/);
    assert.equal((await f.post('/api/pause', { project: 'kestrel', runs: ['RUN-2'], why: 'pause half' })).status, 200);
    assert.equal((await lane('render')).pause, 'asked');
    o = await ov();
    assert.deepEqual(o.waiting.asked.map(x => x.run), ['RUN-2']);
    assert.match(pauseMenu(o), /Asked to pause: RUN-2 \(render\)/);
    assert.equal((await f.post('/api/pause/half', { project: 'kestrel' })).data.pick.length, 0, 'a run asked already is not picked again');
    // it reaches a paused hand-off: the row and the menu offer Resume
    record(S, { kind: 'run', ev: 'end', id: 'RUN-2', by: 'launcher', data: { exit: 0, outcome: 'handoff', handoff: 'H.md', paused: { mail: 'MAIL-1' } } });
    assert.equal((await lane('render')).pause, 'handoff');
    const node = (await f.get('/api/agents?project=kestrel')).data.tree.find(n => n.id === 'RUN-2');
    assert.equal(node.pause, 'handoff');
    assert.match(renderTab('runs', { tree: [node] }, { now: Date.now() }), /data-act="run-resume" data-project="kestrel" data-run="RUN-2"/);
    o = await ov();
    assert.match(pauseMenu(o), /Paused hand-off RUN-2 \(render\) <button[^>]*data-act="run-resume"/);
    // Resume all: the hold released (RUN-2 has no spec file here: its resume reports the error, the release still happens)
    const ra = await f.post('/api/pause', { project: 'kestrel', resume: 'all' });
    assert.equal(ra.status, 200, JSON.stringify(ra.data));
    assert.equal((await ov()).pause, null);
  } finally { await f.done(); }
});

test('a row pause action: Pause a running work run, pausing once asked, Resume a paused hand-off, nothing otherwise', () => {
  assert.match(pauseAct('running', 'p', 'RUN-3'), /<button[^>]*data-act="run-pause" data-project="p" data-run="RUN-3"[^>]*>Pause<\/button>/);
  assert.match(pauseAct('asked', 'p', 'RUN-3'), /pausing/); assert.doesNotMatch(pauseAct('asked', 'p', 'RUN-3'), /<button/);
  assert.match(pauseAct('handoff', 'p', 'RUN-3'), /data-act="run-resume"[^>]*>Resume<\/button>/);
  assert.equal(pauseAct(undefined, 'p', 'RUN-3'), '');
  assert.match(pauseMenu({ pause: null, modes: [], waiting: { held: 0, asked: [], handoffs: [] } }), /Now: nothing paused[\s\S]*data-act="pause-resume-all" disabled/, 'nothing to resume');
});

// the menu in a real browser at phone width: More, then the pause control opens the menu; no sideways scroll, every part on screen;
// Pause half shows its pick line; a mode tap names the mode in the header
test('the pause menu fits a phone and a mode tap sets the mode', async t => {
  if (skipWhy) { t.diagnostic(`browser part skipped: ${skipWhy}`); return; }
  const f = await fixture();
  try {
    const pg = await openPage([390, 844]);
    try {
      await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
      assert.ok(await pg.until(`document.querySelector('[data-act=more]')`, 60000));
      await pg.ev(`document.querySelector('[data-act=more]').click()`);
      await pg.ev(`document.querySelector('#pause').click()`);
      assert.ok(await pg.until(`document.querySelectorAll('#pause-pop [data-act=pause-mode]').length === 3 && !document.querySelector('#pause-pop').hidden`, 30000), 'the menu opens with three modes');
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll with the menu open');
      assert.ok(await pg.ev(`[...document.querySelectorAll('#pause-pop, #pause-pop button')].every(x => { const r = x.getBoundingClientRect(); return r.left >= 0 && r.right <= 390 && r.width > 0; })`), 'the menu and every button on screen');
      await pg.ev(`document.querySelector('#pause-pop [data-act=pause-half]').click()`);
      assert.ok(await pg.until(`/Pause 1 of 1 running: RUN-2/.test(document.querySelector('#pause-half')?.textContent || '')`, 30000), 'Pause half shows its pick');
      assert.ok(await pg.ev(`!!document.querySelector('#pause-half [data-act=pause-half-go][data-runs="RUN-2"]')`), 'and a Confirm for it');
      await pg.ev(`document.querySelector('#pause-pop [data-mode=queue]').click()`);
      assert.ok(await pg.until(`/Hold the queue/.test(document.querySelector('#status').textContent) && /Now: Hold the queue/.test(document.querySelector('#pause-pop').textContent)`, 30000), 'the header names the mode');
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390);
    } finally { await pg.close(); }
  } finally { await f.done(); }
});
