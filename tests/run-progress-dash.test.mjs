// RM-39 on the dashboard: a run's progress line on its Runs row and its lane's Lanes row ("1 of 4 items done", the pace chip), and
// the lane overview card (objective, type, the stage's checklist, pace, why slow, alarms, last / next) on a Runs row's lane;
// on Lanes the checklist is in the open row (the chevron opens it, Esc closes it), with no sideways scroll at 390 px. Sandbox only: the shared dash
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
    const html = renderTab('lanes', data, { project: 'kestrel', now: Date.now() }), row = html.match(/id="lane-gen"[^]*?<\/article>/)[0];
    assert.match(row, /<div class="lprog small">[^]*?<span class="pline">1 of 4 items done/, 'the closed row: the brief line');
    assert.match(row, /<div class="lexp" id="lx-gen" hidden>/, 'the checklist waits in the open row');
    assert.match(row, /<ol class="prog-items small"><li class="prog-done">.*Relief shading/);
    assert.match(row, /<b>Pace<\/b> (on track|slow|stalled)/);
    const runs = await f.get('/api/agents?project=kestrel'), node = runs.data.tree.find(n => n.id === id);
    assert.match(node.progress.line, /^1 of 4 items done/);
    assert.equal(node.lane_card.lane, 'gen');
    const rhtml = renderTab('runs', { tree: runs.data.tree }, { project: 'kestrel', now: Date.now() }), rnode = rhtml.split('id="node-').find(x => x.startsWith(`${id}"`));
    assert.match(rnode, /<td class="rlane" data-label="lane"><span class="lhov"><a class="lanelink" data-act="rid" data-rid="L:gen"[^>]*>gen<\/a> · S1<div class="lcard" role="dialog"/);
    assert.match(rnode, /<div class="rline small">1 of 4 items done/, 'the live row: the brief line');
    // worker-speed: a worker run with model requests shows its tok/s line; a live one its last 10 min
    const now = Date.now(), ts = s => new Date(now - s * 1000).toISOString(), sid = 'aaaaaaaa-2222-4333-8444-555555555555';
    const lines = [{ type: 'user', timestamp: ts(130), message: { role: 'user', content: 'go' } }, { type: 'api-request', id: 'r1', timestamp: ts(120) },
      { type: 'assistant', timestamp: ts(110), requestId: 'q1', requestRef: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { output_tokens: 500 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node --test tests/a.test.mjs' } }] } },
      { type: 'user', timestamp: ts(50), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }];
    fs.writeFileSync(path.join(f.root, 'claude-projects', 'C--fx-wt', sid + '.jsonl'), lines.map(j => JSON.stringify(j)).join('\n') + '\n');
    const sp = record(f.pa.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'render', session_id: sid } }, { now: () => new Date(now - 140000) }).id;
    const snode = (await f.get('/api/agents?project=kestrel')).data.tree.find(n => n.id === sp);
    assert.equal(snode.speed.rolling, true); assert.equal(snode.speed.tok_s, 50, '500 tokens in 10 s');
    assert.match(snode.speed.line, /^tok\/s 50 · model \d+ % · tests \d+ %$/);
    assert.match(renderTab('runs', { tree: [snode] }, { project: 'kestrel', now }), /<div class="speed small mute"[^>]*>tok\/s 50 · model \d+ % · tests \d+ % \(10 min\)<\/div>/);
  } finally { await f.done(); }
});

test('a runaway alarm on the card in words: the ratio, its numbers and the owner\'s moves', () => {
  const g = { run: 'RUN-5', line: '2 of 5 items done, testing item 3', items: [], pace: { state: 'slow', words: 'slow · 2 h 10 min of a 2 h 00 min budget' },
    slow: { line: 'slow: 70 % of the last hour in test runs; the machine is at 98 % CPU; the same file re-run 6 times (a.test.mjs)' },
    alarms: [{ cls: 'runaway', words: 'uses 4.2x the tokens of similar runs - most of it re-reading a long context while waiting on tests', numbers: '310M cache reads vs a median 74M of 9 ended runs',
      act: ['mail it', 'stop it', 'nothing needed - let it run'], ruled: null }] };
  const html = renderTab('runs', { tree: [{ id: 'RUN-5', name: 'x', kind: 'worker', state: 'running', executor: 'claude', lane: 'gen', stage: 'S1', project: 'kestrel', started: new Date().toISOString(), children: [],
    progress: g, lane_card: { lane: 'gen', objective: 'relief maps', type: 'build', stage: 'S1 · RUN-5', progress: g, last: null, next: 'MERGE queued (RUN-6)' } }] }, { project: 'kestrel', now: Date.now(), run: 'RUN-5' });
  assert.match(html, /<td class="rpace" data-label="pace"><div class="rtimes small"><span class="chip warn">slow<\/span>/, 'the pace chip on the live row');
  assert.match(html, /<b>S1 · RUN-5<\/b>: 2 of 5 items done, testing item 3/);
  assert.match(html, /<div class="rline small warn">slow: 70 % of the last hour in test runs; the machine is at 98 % CPU; the same file re-run 6 times \(a\.test\.mjs\)<\/div>/);
  assert.match(html, /runaway<\/span> uses 4\.2x the tokens of similar runs - most of it re-reading a long context while waiting on tests/);
  assert.match(html, /You can: mail it \/ stop it \/ nothing needed - let it run/);
  assert.match(html, /no stage finished yet · next: MERGE queued \(RUN-6\)/);
});

test('the browser: the chevron opens the lane in place (the checklist), Esc closes it; a stream repaint keeps it open; at 390 px nothing scrolls sideways', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage([1280, 900]);
  try {
    genRun(f);
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('#lane-gen .lopen')`, 90000), 'Lanes shows the open chevron');
    const shown = `!document.querySelector('#lx-gen').hidden && getComputedStyle(document.querySelector('#lx-gen')).display !== 'none'`, exp = `document.querySelector('#lane-gen .lopen').getAttribute('aria-expanded')`;
    assert.equal(await pg.ev(shown), false, 'closed at first');
    assert.equal(await pg.ev(exp), 'false');
    await pg.ev(`document.querySelector('#lane-gen .lopen').click()`);
    assert.equal(await pg.ev(shown), true, 'the chevron opens it');
    assert.equal(await pg.ev(exp), 'true', 'aria-expanded follows');
    assert.match(await pg.ev(`document.querySelector('#lx-gen .prog-items')?.textContent ?? ''`), /Relief shading/, 'the brief checklist is in the open row');
    await pg.ev(`document.querySelector('#lx-gen .rowacts button').focus()`);
    assert.equal(await pg.ev(`!!document.activeElement.closest('#lx-gen')`), true, 'the focus is inside the open row');
    await pg.ev(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    assert.equal(await pg.ev(shown), false, 'Esc closes it');
    assert.equal(await pg.ev(`document.activeElement === document.querySelector('#lane-gen .lopen')`), true, 'the focus goes back to the chevron');
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('#lane-gen .lopen')`, 90000));
    await pg.ev(`document.querySelector('#lane-gen .lopen').click()`);
    assert.equal(await pg.ev(shown), true);
    // a stream repaint (a new record; the stream's hello does the same after the first paint) keeps the open row open (S.laneOpen)
    await pg.ev(`window.__oldRow = document.querySelector('#lane-gen')`);
    record(f.pa.state, { kind: 'mail', ev: 'create', by: 'controller', data: { from: 'role:controller', to: 'lane:gen', subject: 'Owner: a north arrow', body: 'a north arrow' } });
    assert.ok(await pg.until(`!document.contains(window.__oldRow) && document.body.dataset.ready === 'lanes'`, 90000), 'the stream repaints Lanes');
    assert.equal(await pg.ev(shown), true, 'the repaint keeps the open row open');
    assert.equal(await pg.ev(`document.querySelector('#lane-gen .lopen').getBoundingClientRect().height >= 44`), true, 'the chevron is a 44 px target on the phone');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Lanes with the row open');
    await pg.go(`${f.url}/?project=kestrel&tab=runs`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && !!document.querySelector('.rrow .rline')`, 90000), 'Runs shows the progress line');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Runs at 390 px');
  } finally { await pg.close(); await f.done(); }
});

test('issue #153: a check-in after older ones is its own session, not stalled while live, and once exited never renders stalled', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const S = f.pa.state, brief = path.join(S, 'briefs', 'checkin-brief.md'), now = Date.now(), ago = m => ({ now: () => new Date(now - m * 60000) });
    fs.mkdirSync(path.dirname(brief), { recursive: true }); fs.writeFileSync(brief, BRIEF);
    const ck = { kind: 'checkin', executor: 'claude', lane: 'checkin', agent: 'checkin', brief };
    const old = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: ck }, ago(180)).id;
    record(S, { kind: 'run', ev: 'end', id: old, by: 'launcher', data: { exit: 0, outcome: 'done' } }, ago(179));
    record(S, { kind: 'mail', ev: 'create', by: 'controller', data: { from: 'role:controller', to: 'lane:checkin', subject: 'Owner: an old note', body: 'old' } }, ago(170));
    const id = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: ck }, ago(1)).id;
    const live = (await f.get('/api/agents?project=kestrel')).data.tree.find(n => n.id === id);
    assert.notEqual(live.progress.pace.state, 'stalled');
    assert.deepEqual([live.progress.pace.sessions, live.progress.pace.elapsed_min], [1, 1]);
    assert.ok(!live.progress.slow.reasons.some(x => /mail/.test(x)), 'no mail added scope to a check-in');
    record(S, { kind: 'run', ev: 'end', id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
    const tree = (await f.get('/api/agents?project=kestrel')).data.tree, node = tree.find(n => n.id === id);
    assert.notEqual(node.progress?.pace?.state, 'stalled');
    assert.doesNotMatch(renderTab('runs', { tree }, { project: 'kestrel', now: Date.now() }).split('id="node-').find(x => x.startsWith(`${id}"`)) ?? '', /stalled/);
  } finally { await f.done(); }
});
