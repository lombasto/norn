// RM-34 on the dashboard: each Lanes row says why the lane exists (its objective + source links, or the 'no recorded driver' chip),
// the Docs reader opens a lane's brief, and each Runs row carries its lane (lane · stage; "check-in" for a check-in) on the line
// under the session's id + name. MAIL-29: each row's type word (its tooltip = the deciding signal), the output words in
// the open row, and the type filter beside the groups (URL &type=). Sandbox only: the shared dash fixture (temp dirs) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { record } from '../engine/lib/records.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { LANE_SHOW } from '../engine/dash/pages/lanes.mjs';
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
    const html = renderTab('lanes', data, { project: 'kestrel', now: Date.now() }), row = n => html.match(new RegExp(`id="lane-${n}"[^]*?</article>`))[0];
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

// MAIL-29: a planner lane (design, documents to its notes) next to gen (build, code)
function sketch(f) {
  const S = f.pa.state;
  record(S, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'sketch' } });
  record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'sketch', stage: 'plan', agent: 'planner', notes: path.join(S, 'notes', 'sketch', 'NOTES.md') } });
}

test('the Lanes rows: a type chip naming its signal and the output in words; the type filter', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    drivers(f); sketch(f);
    const { data } = await f.get('/api/lanes?project=kestrel'), by = n => data.lanes.find(l => l.name === n);
    assert.deepEqual(by('sketch').lane_type, { type: 'design', signal: `${by('sketch').run}: agent planner`, now: null });
    assert.equal(by('sketch').output.kind, 'documents');
    assert.match(by('sketch').output.text, /^documents → (.+\/)?notes\/sketch\/ \(not in git; backed up only if the ledger is on\)$/);
    assert.equal(by('gen').lane_type.type, 'build');
    assert.match(by('gen').output.text, /^code → PR to .+ · no PR yet$/);
    assert.equal(by('seabed').lane_type.type, null, 'a run with no stage, brief, item or commit: no type');
    // a code lane whose PR is open (the deliverables cache's row), rendered
    const lanes = data.lanes.map(l => l.name !== 'gen' ? l : { ...l, output: { kind: 'code', text: 'code → PR to example/kestrel · PR #18 open', href: 'https://github.com/example/kestrel/pull/18' } });
    const ALL = LANE_SHOW.map(g => g[0]), html = renderTab('lanes', { lanes }, { project: 'kestrel', now: Date.now(), laneShow: ALL }), row = n => html.match(new RegExp(`id="lane-${n}"[^]*?</article>`))?.[0];
    // the type is a quiet word by the name (its signal the title); "no type" shows once, as a filter count (SPEC 4.2 item 4)
    assert.match(row('gen'), /<span class="ltype small mute" title="type from RUN-\d+: stage S1">build<\/span>/);
    assert.match(row('gen'), /<div class="lane-kind small"><a class="lane-out" href="https:\/\/github.com\/example\/kestrel\/pull\/18" target="_blank" rel="noopener">code → PR to example\/kestrel · PR #18 open<\/a><\/div>/);
    assert.match(row('sketch'), /title="type from RUN-\d+: agent planner">design<\/span>[^]*<span class="lane-out">documents → [^<]*notes\/sketch\/ \(not in git; backed up only if the ledger is on\)<\/span>/);
    assert.doesNotMatch(row('seabed'), /no type/, 'no amber "no type" chip on the row');
    assert.match(html, /data-type="no type" aria-pressed="false">no type <b>2<\/b>/, 'seabed and render, counted once in the filter');
    assert.match(html, /aria-label="Lane type"><button class="hf" data-act="lane-type" data-type="build" aria-pressed="false">build <b>1<\/b><\/button><button class="hf" data-act="lane-type" data-type="design" aria-pressed="false">design <b>1<\/b>/);
    const only = renderTab('lanes', { lanes }, { project: 'kestrel', now: Date.now(), laneShow: ALL, laneType: 'design' });
    assert.ok(only.includes('id="lane-sketch"') && !only.includes('id="lane-gen"') && !only.includes('id="lane-seabed"'), 'the filter keeps one type');
    assert.match(only, /data-type="design" aria-pressed="true">design <b>1<\/b>/);
    const none = renderTab('lanes', { lanes }, { project: 'kestrel', now: Date.now(), laneShow: ['needs'], laneType: 'audit' });
    assert.match(none, /data-type="audit" aria-pressed="true">audit <b>0<\/b>/, 'a picked type with no row keeps its chip, so a tap can clear it');
    assert.match(none, /No lanes under these filters\./);
  } finally { await f.done(); }
});

test('the Runs page: a row\'s lane - a worker (lane · stage, linked to its row), a MERGE, a check-in; the row heads with the id + the dwarf (else the kind word)', () => {
  const tree = [
    { id: 'RUN-7', dwarf: { id: 'oin', name: 'Óin' }, kind_word: null, kind: 'worker', state: 'running', executor: 'claude', lane: 'gen', stage: 'S1', project: 'kestrel', started: new Date().toISOString(), children: [], helpers: { n: 1, running: 0, tokens: 1200 } },
    { id: 'RUN-8', dwarf: null, kind_word: 'merge', kind: 'worker', state: 'exited', outcome: 'done', executor: 'claude', lane: 'gen', stage: 'MERGE', project: 'kestrel', started: new Date().toISOString(), children: [] },
    { id: 'RUN-9', dwarf: null, kind_word: 'check-in', kind: 'checkin', state: 'exited', outcome: 'done', executor: 'claude', lane: 'checkin', project: 'kestrel', started: new Date().toISOString(), children: [] },
  ];
  const html = renderTab('runs', { tree }, { project: 'kestrel', now: Date.now() }), node = id => html.split('id="node-').find(x => x.startsWith(`${id}"`));
  // a8b060ac: Runs is one table again (a row's cells are <td>), and the run document is the drawer of the picked row (ctx.run)
  assert.match(node('RUN-7'), /<td class="rlane" data-label="lane"><a class="lanelink" data-rid="L:gen" href="\?project=kestrel&tab=lanes&show=needs,running,stopped,waiting,land,parked,today,old,archived">gen<\/a> · S1<\/td>/);
  assert.match(node('RUN-7'), /<td class="rwho" data-label="run"><span class="id">RUN-7<\/span> <b class="aname" data-dwarf="oin">Óin<\/b> <\/td>/);
  assert.match(node('RUN-8'), /<td class="rwho" data-label="run"><span class="id">RUN-8<\/span> <span class="mute">merge<\/span> <\/td>/, 'no dwarf: the kind word');
  assert.match(renderTab('runs', { tree }, { project: 'kestrel', now: Date.now(), run: 'RUN-7' }), /id="run-doc" data-run="RUN-7"[^]*?<span class="mute">helpers<\/span><span>1, 1,200 tok<\/span>/, 'the helpers in the run document');
  assert.match(node('RUN-8'), /<span class="chip done">done<\/span>[^]*?<td class="rlane" data-label="lane"><a [^>]*>gen<\/a> · MERGE<\/td>/);
  assert.match(node('RUN-9'), /<td class="rlane" data-label="lane">check-in<\/td>/);
});

test('the browser at 390 px: Lanes (objective + links, type + output, the type filter) and Runs (the lane on a row\'s second line) never scroll sideways', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    drivers(f);
    record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'a very long objective that keeps going and going so that the row would be far wider than a phone if it did not truncate on the page', scope: ['seabed'], via: 'cli' } });
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('#lane-seabed .lane-why summary')`, 90000), 'the open row holds the objective');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Lanes at 390 px');
    assert.equal(await pg.ev(`document.querySelector('#lx-seabed').hidden`), true, 'the objective waits in the closed row (A-08: rows stay short)');
    await pg.ev(`document.querySelector('#lane-seabed .lopen').click()`);
    assert.ok(await pg.until(`document.querySelector('#lx-seabed')?.hidden === false && document.querySelector('#lane-seabed .lopen').getAttribute('aria-expanded') === 'true'`, 30000), 'the chevron opens it');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll with the row open');
    await pg.ev(`document.querySelector('#lane-seabed .lane-why summary').click()`);
    assert.equal(await pg.ev(`document.querySelector('#lane-seabed .lane-why').open`), true, 'a tap opens it in full');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'still no sideways scroll with the objective open');
    // MAIL-29: the type filter - a tap keeps one type and writes it to the URL; still no sideways scroll
    assert.ok(await pg.until(`!!document.querySelector('[data-act="lane-type"][data-type="build"]')`, 30000), 'the type chips show');
    await pg.ev(`document.querySelector('[data-act="lane-type"][data-type="build"]').click()`);
    assert.ok(await pg.until(`location.search.includes('&type=build') && !document.querySelector('#lane-seabed') && !!document.querySelector('#lane-gen .lane-kind')`, 30000), 'the filter keeps build lanes, in the URL');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll with the type line and the filter');
    await pg.go(`${f.url}/?project=kestrel&tab=runs`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'runs' && !!document.querySelector('#node-RUN-3 .rlane a')`, 90000), 'a Runs row shows its lane');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Runs at 390 px');
    const below = await pg.ev(`(() => { const n = document.querySelector('#node-RUN-3'); return n.querySelector('.rlane').getBoundingClientRect().top >= n.querySelector('.rwho').getBoundingClientRect().bottom - 1; })()`);
    assert.equal(below, true, 'the lane sits on the row\'s second line on the phone');
  } finally { await pg.close(); await f.done(); }
});
