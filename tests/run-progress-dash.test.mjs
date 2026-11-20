// RM-39 on the dashboard: a run's progress line on its Runs row and its lane's Lanes row ("1 of 4 items done", the pace chip), and
// the lane overview card (objective, type, the stage's checklist, pace, why slow, alarms, last / next) on the lane name and on the
// Runs page's Lane cell: focus opens it, Esc closes it, a bottom sheet at 390 px with no sideways scroll. Sandbox only: the shared dash
// fixture (temp dirs) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record } from '../engine/lib/records.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { fixture, SID } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const BRIEF = '# task gen S1 (relief) - relief maps\n## Build\n1. **Relief shading**: shade the relief\n2. **Contour labels**: label the contours\n3. **Legend box**: a legend\nTime budget 60 min\nDone: ## DONE\n';
// lane gen: a running S1 worker with a brief (3 items), NOTES naming item 1 done, and a mail to the lane sent after it started
function genRun(f) {
  const S = f.pa.state, briefs = path.join(S, 'briefs'), notes = path.join(S, 'notes', 'gen');
  fs.mkdirSync(briefs, { recursive: true }); fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(briefs, 'task-gen-S1-brief.md'), BRIEF);
  fs.writeFileSync(path.join(notes, 'NOTES.md'), '# gen S1\n## What was built\n- item 1: relief shading\n');
  const id = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen', stage: 'S1', agent: 'implementer',
    brief: path.join(briefs, 'task-gen-S1-brief.md'), notes: path.join(notes, 'NOTES.md'), session_id: SID } }).id;
  record(S, { kind: 'mail', ev: 'create', by: 'controller', data: { from: 'role:controller', to: 'lane:gen', subject: 'Owner: add a scale bar', body: 'a scale bar under the legend' } });
  return id;
}

test('the API: a Lanes row and a Runs node carry the run\'s progress and the lane card; the rows render the line and the card', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const id = genRun(f);
    const { data } = await f.get('/api/lanes?project=kestrel'), gen = data.lanes.find(l => l.name === 'gen');
    assert.equal(gen.run, id);
    assert.deepEqual(gen.progress.items.map(x => x.state), ['done', 'todo', 'todo', 'todo']);
    assert.match(gen.progress.items[0].evidence, /^NOTES: "item 1: relief shading"/);
    assert.equal(gen.progress.items[3].title.replace(/^MAIL-\d+: /, ''), 'Owner: add a scale bar');
    assert.match(gen.progress.line, /^1 of 4 items done/);
    assert.equal(gen.progress.pace.budget_min, 60);
    assert.equal(gen.card.lane, 'gen');
    assert.equal(gen.card.stage, `S1 · ${id}`);
    assert.equal(gen.card.progress.run, id);
    assert.match(gen.card.last ?? 'no stage finished yet', /./);
    const html = renderTab('lanes', data, { project: 'kestrel', now: Date.now() }), row = html.match(/<tr id="lane-gen"[^]*?<\/tr>/)[0];
    assert.match(row, /<span class="lhov"><button class="lnk lname" aria-haspopup="dialog"><b>gen<\/b><\/button><div class="lcard" role="dialog" aria-label="Lane gen">/);
    assert.match(row, /<div class="prog small" title="[^"]*">.*1 of 4 items done/);
    assert.match(row, /<ol class="prog-items small"><li class="prog-done">.*Relief shading/);
    assert.match(row, /<b>Pace<\/b> (on track|slow|stalled)/);
    const runs = await f.get('/api/agents?project=kestrel'), node = runs.data.tree.find(n => n.id === id);
    assert.match(node.progress.line, /^1 of 4 items done/);
    assert.equal(node.lane_card.lane, 'gen');
    const rhtml = renderTab('runs', { tree: runs.data.tree }, { project: 'kestrel', now: Date.now() }), rnode = rhtml.split('id="node-').find(x => x.startsWith(`${id}"`));
    assert.match(rnode, /<div class="lanecol small"><span class="lhov"><a class="lanelink" data-rid="L:gen"[^>]*>gen<\/a> · S1<div class="lcard" role="dialog"/);
    assert.match(rnode, /<div class="prog small"[^>]*>.*1 of 4 items done/);
  } finally { await f.done(); }
});

test('a runaway alarm on the card in words: the ratio, its numbers and the owner\'s moves', () => {
  const g = { run: 'RUN-5', line: '2 of 5 items done, testing item 3', items: [], pace: { state: 'slow', words: 'slow · 2 h 10 min of a 2 h 00 min budget' },
    slow: { line: 'slow: 70 % of the last hour in test runs; the machine is at 98 % CPU; the same file re-run 6 times (a.test.mjs)' },
    alarms: [{ cls: 'runaway', words: 'uses 4.2x the tokens of similar runs - most of it re-reading a long context while waiting on tests', numbers: '310M cache reads vs a median 74M of 9 ended runs',
      act: ['mail it', 'stop it', 'nothing needed - let it run'], ruled: null }] };
  const html = renderTab('runs', { tree: [{ id: 'RUN-5', name: 'x', kind: 'worker', state: 'running', executor: 'claude', lane: 'gen', stage: 'S1', project: 'kestrel', started: new Date().toISOString(), children: [],
    progress: g, lane_card: { lane: 'gen', objective: 'relief maps', type: 'build', stage: 'S1 · RUN-5', progress: g, last: null, next: 'merge waiting (RUN-6)' } }] }, { project: 'kestrel', now: Date.now() });
  assert.match(html, /<span class="chip warn">slow<\/span> 2 of 5 items done, testing item 3/);
  assert.match(html, /title="slow: 70 % of the last hour in test runs; the machine is at 98 % CPU; the same file re-run 6 times \(a\.test\.mjs\)"/);
  assert.match(html, /runaway<\/span> uses 4\.2x the tokens of similar runs - most of it re-reading a long context while waiting on tests/);
  assert.match(html, /You can: mail it \/ stop it \/ nothing needed - let it run/);
  assert.match(html, /no stage finished yet · next: merge waiting \(RUN-6\)/);
});

test('the browser: focus opens the lane card, Esc closes it; at 390 px it is a bottom sheet and nothing scrolls sideways', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage([1280, 900]);
  try {
    genRun(f);
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('#lane-gen .lname')`, 90000), 'Lanes shows the lane name button');
    const shown = `getComputedStyle(document.querySelector('#lane-gen .lcard')).display !== 'none'`;
    assert.equal(await pg.ev(shown), false, 'closed at first');
    await pg.ev(`document.querySelector('#lane-gen .lname').focus()`);
    assert.equal(await pg.ev(shown), true, 'focus opens it');
    const clear = await pg.ev(`(() => { const c = document.querySelector('#lane-gen .lcard').getBoundingClientRect(); return [...document.querySelectorAll('#lane-gen td:last-child button')]
      .every(b => { const r = b.getBoundingClientRect(); return r.right <= c.left || r.left >= c.right || r.bottom <= c.top || r.top >= c.bottom; }); })()`);
    assert.equal(clear, true, 'the card never covers the row\'s buttons');
    await pg.ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await pg.ev(shown), false, 'Esc closes it');
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('#lane-gen .lname')`, 90000));
    await pg.ev(`document.querySelector('#lane-gen .lname').focus()`);
    assert.equal(await pg.ev(shown), true);
    // a stream repaint (a new record; the stream's hello does the same after the first paint) keeps the open card open
    await pg.ev(`window.__oldCard = document.querySelector('#lane-gen .lcard')`);
    record(f.pa.state, { kind: 'mail', ev: 'create', by: 'controller', data: { from: 'role:controller', to: 'lane:gen', subject: 'Owner: a north arrow', body: 'a north arrow' } });
    assert.ok(await pg.until(`!document.contains(window.__oldCard) && document.body.dataset.ready === 'lanes'`, 90000), 'the stream repaints Lanes');
    assert.equal(await pg.ev(shown), true, 'the repaint keeps the focused lane card open');
    const sheet = await pg.ev(`(() => { const r = document.querySelector('#lane-gen .lcard').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.bottom)]; })()`);
    assert.deepEqual(sheet, [0, 390, 844], 'a bottom sheet the width of the phone');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Lanes with the card open');
    await pg.go(`${f.url}/?project=kestrel&tab=runs`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && !!document.querySelector('.lanecol .prog')`, 90000), 'Runs shows the progress line');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Runs at 390 px');
  } finally { await pg.close(); await f.done(); }
});
