// RM-34 on the dashboard: each Lanes row says why the lane exists (its objective + source links, or the 'no recorded driver' chip),
// the Docs reader opens a lane's brief, and the Runs page has a Lane column (lane · stage; "check-in" for a check-in) with the
// Session column cut to the session's id + name. Sandbox only: the shared dash fixture (temp dirs) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record } from '../engine/lib/records.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

// gen: a roadmap item links it and its run ran a brief; render: a directive scoped to it; seabed: nothing -> the finding
function drivers(f) {
  const S = f.pa.state, briefs = path.join(S, 'briefs');
  fs.mkdirSync(briefs, { recursive: true });
  const theme = record(S, { kind: 'item', ev: 'create', by: 'owner', data: { title: 'Maps', kind: 'theme' } }, { views: false }).id;
  const rm = record(S, { kind: 'item', ev: 'create', by: 'owner', data: { title: 'Relief maps for every survey', kind: 'item', parent: theme, horizon: 'now', links: ['lane:gen'] } }, { views: false }).id;
  fs.writeFileSync(path.join(briefs, 'task-gen-S1-brief.md'), `# task gen S1 (${rm}) - relief maps the owner can read at a glance\n\nbody\n`);
  record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen', stage: 'S1', brief: path.join(briefs, 'task-gen-S1-brief.md') } });
  const dir = record(S, { kind: 'directive', ev: 'create', by: 'owner', data: { text: '## 2. Render the seabed in colour\nmore words', scope: ['render'], via: 'cli' } }).id;
  return { rm, dir };
}

test('the Lanes rows: an RM source, a DIR source and none (the finding); the brief opens in the Docs reader, nothing outside briefs_dir does', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const { rm, dir } = drivers(f);
    const { data } = await f.get('/api/lanes?project=kestrel'), by = n => data.lanes.find(l => l.name === n);
    assert.equal(by('gen').driver.objective, 'Relief maps for every survey');
    assert.deepEqual(by('gen').driver.sources.map(s => s.kind + ':' + s.id), [`rm:${rm}`, 'brief:task-gen-S1-brief.md']);
    assert.deepEqual(by('render').driver.sources.map(s => s.kind + ':' + s.id), [`dir:${dir}`]);
    assert.equal(by('render').driver.objective, 'Render the seabed in colour');
    assert.deepEqual(by('seabed').driver, { objective: null, sources: [], finding: 'no recorded driver' });
    const html = renderTab('lanes', data, { project: 'kestrel', now: Date.now() }), row = n => html.match(new RegExp(`<tr id="lane-${n}"[^]*?</tr>`))[0];
    assert.match(row('gen'), /<details class="lane-why"><summary title="Relief maps for every survey">Relief maps for every survey<\/summary>/);
    assert.match(row('gen'), new RegExp(`<a class="lane-src" data-rid="${rm}" href="\\?project=kestrel&amp;tab=roadmap#rm-${rm}"`));
    assert.match(row('gen'), /data-go="docs" data-goins="brief:task-gen-S1-brief.md"[^>]*>brief</);
    assert.match(row('render'), new RegExp(`data-rid="${dir}"[^>]*>${dir}</a>`));
    assert.match(row('seabed'), /class="lane-why"><span class="chip[^"]*">no recorded driver/);
    const doc = await f.get('/api/docs?project=kestrel&part=file&file=' + encodeURIComponent('brief:task-gen-S1-brief.md'));
    assert.equal(doc.status, 200); assert.match(doc.data.doc.text, /relief maps the owner can read/);
    for (const bad of ['brief:..\\kestrel.json', 'brief:../x.md', 'doc:../../etc/passwd']) assert.notEqual((await f.get('/api/docs?project=kestrel&part=file&file=' + encodeURIComponent(bad))).status, 200, bad);
  } finally { await f.done(); }
});

test('the Runs page: a Lane column - a worker (lane · stage, linked to its row), a MERGE, a check-in; Session is the id + name, the rest its title', () => {
  const tree = [
    { id: 'RUN-7', name: 'amber-fox', kind: 'worker', state: 'running', executor: 'claude', lane: 'gen', stage: 'S1', project: 'kestrel', started: new Date().toISOString(), children: [], helpers: { n: 1, running: 0, tokens: 1200 } },
    { id: 'RUN-8', name: 'bold-heron', kind: 'worker', state: 'exited', outcome: 'done', executor: 'claude', lane: 'gen', stage: 'MERGE', project: 'kestrel', started: new Date().toISOString(), children: [] },
    { id: 'RUN-9', name: 'calm-ibis', kind: 'checkin', state: 'exited', outcome: 'done', executor: 'claude', lane: 'checkin', project: 'kestrel', started: new Date().toISOString(), children: [] },
  ];
  const html = renderTab('runs', { tree }, { project: 'kestrel', now: Date.now() }), node = id => html.split('id="node-').find(x => x.startsWith(`${id}"`));
  assert.match(html, /<div class="node head"><div>session<\/div><div class="lanecol">lane<\/div>/);
  assert.match(node('RUN-7'), /<div class="lanecol small"><a class="lanelink" data-rid="L:gen" href="\?project=kestrel&tab=lanes&lanes=active,done,old,archived">gen<\/a> · S1<\/div>/);
  assert.match(node('RUN-7'), /<span class="t" title="gen · S1 · helpers 1, 1,200 tok"><span class="id">RUN-7<\/span> <b class="aname">amber-fox<\/b><\/span>/);
  assert.match(node('RUN-8'), />gen<\/a> · MERGE<\/div>/);
  assert.match(node('RUN-8'), /title="gen · MERGE · DONE"/);
  assert.match(node('RUN-9'), /<div class="lanecol small">check-in<\/div>/);
});

test('the browser at 390 px: Lanes (objective + links) and Runs (the Lane column on the second line) never scroll sideways', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    drivers(f);
    record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'a very long objective that keeps going and going so that the row would be far wider than a phone if it did not truncate on the page', scope: ['seabed'], via: 'cli' } });
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('#lane-seabed .lane-why summary')`, 90000), 'Lanes shows the objective');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Lanes at 390 px');
    const cut = await pg.ev(`(() => { const s = document.querySelector('#lane-seabed .lane-why summary'); return s.scrollWidth > s.clientWidth; })()`);
    assert.equal(cut, true, 'the long objective is truncated');
    await pg.ev(`document.querySelector('#lane-seabed .lane-why summary').click()`);
    assert.equal(await pg.ev(`document.querySelector('#lane-seabed .lane-why').open`), true, 'a tap opens it in full');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'still no sideways scroll with the objective open');
    await pg.go(`${f.url}/?project=kestrel&tab=runs`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && !!document.querySelector('#node-RUN-3 .lanecol a')`, 90000), 'Runs shows the Lane column');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Runs at 390 px');
    const below = await pg.ev(`(() => { const n = document.querySelector('#node-RUN-3'); return n.querySelector('.lanecol').getBoundingClientRect().top >= n.querySelector('.name').getBoundingClientRect().bottom - 1; })()`);
    assert.equal(below, true, 'the lane sits on the row\'s second line on the phone');
  } finally { await pg.close(); await f.done(); }
});
