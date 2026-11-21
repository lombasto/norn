// fair-slots item 8 (owner 2026-11-19), the dashboard part: Settings > Capacity holds every registered project's reserve + ceiling on
// one screen, a save that overflows the machine cap is refused with the overflow named, each capacity change is a decision record with
// an Undo (the before-values written back through the same save path), and the Lanes page shows the Claude pool per project (8c).
// Sandbox only: the shared dash fixture (temp dirs, two projects kestrel + other, max_claude_workers 2) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { record, loadState } from '../engine/lib/records.mjs';
import { renderTab, loadTab } from '../engine/dash/ui.mjs';
import { capStrip } from '../engine/dash/widgets.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const R = p => `project_workers.${p}.reserve_claude_workers`, C = p => `project_workers.${p}.max_claude_workers_project`;
const budgetOf = f => JSON.parse(fs.readFileSync(f.budgetFile, 'utf8'));
const caps = f => Object.values(loadState(f.pa.state).items).filter(i => i.kind === 'decision' && i.data?.question === 'capacity');

test('Settings > Capacity: every project\'s reserve + ceiling, the overflow refused by name, a save records a decision, Undo writes the old values back', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    let g = (await f.get('/api/settings?project=kestrel')).data;
    const rows = g.settings.filter(s => s.section?.join('/') === 'workers/capacity').map(s => s.key);
    assert.deepEqual(rows.sort(), [C('kestrel'), C('other'), R('kestrel'), R('other')].sort(), 'both registered projects, on one screen');
    assert.ok(g.settings.filter(s => rows.includes(s.key)).every(s => s.basic), 'on the Basic screen');
    assert.deepEqual(g.capacity.rows.map(r => [r.project, r.reserved, r.using, r.queued, r.ceiling]), [['kestrel', 0, 0, 0, 2], ['other', 0, 0, 0, 2]]);
    assert.equal(g.capacity.cap, 2); assert.equal(g.capacity_undo, null);
    // the reserves may not add up past max_claude_workers (2): Review and Save refuse it and name the overflow
    const over = { [R('kestrel')]: 2, [R('other')]: 1 };
    for (const route of ['/api/settings/review', '/api/settings']) {
      const r = await f.post(route, { project: 'kestrel', version: g.version, changes: over });
      assert.equal(r.status, 400, route); assert.match(r.data.error, /reserves add up to 3 \(kestrel 2 \+ other 1\), 1 more than max_claude_workers 2/, route);
    }
    assert.equal(budgetOf(f).project_workers, undefined, 'nothing written');
    // a save: written to the machine budget, recorded as a capacity decision with the values before and after
    const s1 = await f.post('/api/settings', { project: 'kestrel', version: g.version, changes: { [R('kestrel')]: 1, [C('other')]: 1 } });
    assert.equal(s1.status, 200, JSON.stringify(s1.data)); assert.match(s1.data.capacity, /^DEC-/);
    assert.deepEqual(budgetOf(f).project_workers, { kestrel: { reserve_claude_workers: 1 }, other: { max_claude_workers_project: 1 } });
    const d1 = loadState(f.pa.state).items[s1.data.capacity];
    assert.deepEqual(d1.data.from, { [R('kestrel')]: null, [C('other')]: null }); assert.deepEqual(d1.data.to, { [R('kestrel')]: 1, [C('other')]: 1 });
    assert.equal(d1.data.choice, 'kestrel reserve unset -> 1, other max unset -> 1');
    g = (await f.get('/api/settings?project=kestrel')).data;
    assert.deepEqual(g.capacity_undo?.id, s1.data.capacity, 'the last change offers an Undo');
    assert.deepEqual(g.capacity.rows.map(r => [r.project, r.reserved, r.ceiling]), [['kestrel', 1, 2], ['other', 0, 1]]);
    const html = renderTab('settings', await loadTab('settings', 'kestrel', async r => (await f.get(r)).data), { project: 'kestrel', setCat: 'workers' });
    assert.match(html, /id="sub-workers-capacity"[\s\S]*id="set-capstrip"[\s\S]*id="cap-undo"[\s\S]*data-act="cap-undo"/);
    // Undo: the before-values (unset) through the same save path, recorded again with `undoes`; an Undo is not undone again
    const u = await f.post('/api/settings/capacity-undo', { project: 'kestrel', id: s1.data.capacity });
    assert.equal(u.status, 200, JSON.stringify(u.data));
    assert.deepEqual(budgetOf(f).project_workers, { kestrel: { reserve_claude_workers: null }, other: { max_claude_workers_project: null } });
    const d2 = loadState(f.pa.state).items[u.data.capacity];
    assert.equal(d2.data.undoes, s1.data.capacity); assert.deepEqual(d2.data.to, d1.data.from);
    g = (await f.get('/api/settings?project=kestrel')).data;
    assert.equal(g.capacity_undo, null);
    assert.deepEqual(g.capacity.rows.map(r => [r.project, r.reserved, r.ceiling]), [['kestrel', 0, 2], ['other', 0, 2]], 'unset again: reserve 0, ceiling = the cap');
    assert.equal((await f.post('/api/settings/capacity-undo', { project: 'kestrel', id: s1.data.capacity })).status, 409, 'undone already');
    assert.equal(caps(f).length, 2);
    // a later change elsewhere: the Undo is offered only while the decision's values are still in force
    const s3 = await f.post('/api/settings', { project: 'kestrel', version: g.version, changes: { [R('other')]: 1 } });
    const b = budgetOf(f); b.project_workers.other.reserve_claude_workers = 0; fs.writeFileSync(f.budgetFile, JSON.stringify(b));
    assert.equal((await f.get('/api/settings?project=kestrel')).data.capacity_undo, null, `${s3.data.capacity}'s values are no longer in force`);
  } finally { await f.done(); }
});

test('capStrip: one line per project - slots in use, reserved, past the ceiling - and its numbers as text', () => {
  const html = capStrip({ cap: 3, rows: [{ project: 'norn', reserved: 1, using: 2, queued: 4, ceiling: 3 }, { project: 'solve-shack', reserved: 1, using: 0, queued: 5, ceiling: 2 }] }, { mine: 'norn' });
  assert.match(html, /Claude worker pool <b>2 of 3<\/b> in use/);
  assert.match(html, /data-project="norn"[^>]*><span class="wcapn"><b>norn<\/b><\/span><span class="wslots" aria-hidden="true"><i class="use"><\/i><i class="use"><\/i><i class=""><\/i><\/span>/);
  assert.match(html, /data-project="solve-shack"[\s\S]*?<i class="res"><\/i><i class=""><\/i><i class="off"><\/i>/, 'a reserved free slot, then the one past its ceiling');
  assert.match(html, /0 using · 5 queued · reserve 1 · max 2/);
  assert.match(html, /aria-label="Claude worker pool: 2 of 3 in use; norn 2 using/);
  assert.equal(capStrip({ cap: 3, rows: [] }), '');
});

test('the browser: Lanes shows each lane\'s priority (no pool card: it moved to the top banner); Settings > Capacity fits the phone (no sideways scroll at 390 px)', { skip: skipWhy, timeout: 180000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    record(f.pa.state, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen', priority: 'P1' } });
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=lanes`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('#lane-gen')`, 90000), 'Lanes shows the queued lane');
    assert.equal(await pg.ev(`!!document.querySelector('#lanes-capstrip')`), false, 'no pool card on Lanes');
    assert.ok(await pg.until(`document.querySelector('#lane-gen select.pl-prio')?.value === 'P1' || document.querySelector('#lane-gen .chip.prio')?.textContent === 'P1 #1'`, 30000), 'the queued lane: its priority (the control once the plan is worked out)');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Lanes at 390 px');
    await pg.go(`${f.url}/?project=kestrel&tab=settings&setcat=workers`);
    assert.ok(await pg.until(`document.body.dataset.ready === 'settings' && !!document.querySelector('#set-capstrip') && !!document.querySelector('#in-project_workers\\\\.other\\\\.reserve_claude_workers')`, 90000), 'Capacity shows the pool and the other project\'s rows');
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on Settings at 390 px');
  } finally { await pg.close(); await f.done(); }
});
