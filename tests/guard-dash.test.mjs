// META-TEND P6: the Guard on the dashboard - GET /api/guard (a sandboxed fixture: temp HOME, no real ~/.claude) over SloppaChoppa's
// open BLOCK findings, the tests advisories and the instruction scan (a worker, never on the request path); the Guard tab; the chips
// in place on Agents, Docs and Settings; pop-ups ship off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/dash-fixture.mjs';
import { advisory } from '../engine/lib/advisory.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { MORE, renderMore } from '../engine/dash/shell.mjs';
import { GUARD_SUBS, guardSummary, guardPart } from '../engine/dash/guardparts.mjs';
import { explainOf } from '../engine/lib/slop/check.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('GET /api/guard: code, tests and the instruction scan in one ranked list, each with the tab that fixes it; pop-ups off', { timeout: 180000 }, async () => {
  const f = await fixture();
  try {
    const S = f.pa.state;
    fs.mkdirSync(path.join(S, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(S, 'tests', 'advisories.json'), JSON.stringify({ at: new Date().toISOString(), list: [advisory({ phase: 'TESTS', key: 'tests-copy-paste', severity: 'medium', surface: 'test file', path: 'tests/a.test.mjs', why: 'copy-paste', source: 't', fix: { tier: 'flag', kind: 'drafts', action: 'look' } })] }));
    let g0 = (await f.get('/api/guard?project=kestrel')).data;
    assert.ok(g0.rows.every(r => !r.new), 'while the instruction scan is pending there is no baseline yet: nothing is new');
    for (let i = 0; g0.pending && i < 1200; i++) { await sleep(100); g0 = (await f.get('/api/guard?project=kestrel')).data; }
    assert.equal(g0.pending, false, 'the instruction scan lands from its worker');
    assert.ok(g0.rows.some(r => r.type === 'tests') && g0.rows.every(r => !r.new), 'the first full scan is the baseline: nothing in it is new');
    assert.ok(fs.existsSync(path.join(S, 'advisory', 'guard-baseline.json')));
    await sleep(5);
    fs.mkdirSync(path.join(S, 'slop'), { recursive: true });
    fs.writeFileSync(path.join(S, 'slop', 'holds.json'), JSON.stringify({ 'feat/x': { lane: 'seabed', run: 'RUN-1', base: 'a', head: 'b', at: new Date().toISOString(),
      blocks: [{ rule: 'K2', level: 'BLOCK', file: 'engine/a.mjs', line: 4, msg: 'an empty catch', fp: 'fp1' }] } }));
    let g = (await f.get('/api/guard?project=kestrel')).data;
    const code = g.rows.find(r => r.type === 'code');
    assert.deepEqual([code.severity, code.go], ['high', { tab: 'slop', jump: 'slop-S-fp1' }], 'a branch block opens its own Slop row (its run may have ended)');
    assert.equal(code.new, true, 'first seen after the baseline = new');
    assert.deepEqual(code.explain, { ...explainOf('K2'), waiver: 'norn rec add waiver --rule K2 --scope fp1 --why "<why it may stay>"' }, 'RM-27: the row explains its rule and names the waiver path');
    assert.equal(g.rows[0].id, code.id, 'the new blocker ranks first');
    assert.ok(g.rows.some(r => r.type === 'tests' && r.go.tab === 'tests' && !r.new), 'a baseline row stays not new on a later scan');
    assert.deepEqual(g.voice, { popups: 'off', daily_cap: 3 }, 'pop-ups ship off (DIR-36)');
    assert.equal(g.types.find(t => t.type === 'code').open, 1);
    assert.deepEqual(g.errors, []);
    assert.ok(g.ledger && Number.isInteger(g.ledger.prose), 'the rule ledger summary');
    assert.ok(fs.existsSync(path.join(S, 'advisory', 'seen.json')), 'first_seen lives in the one seen store');
    // META-UX-BUILD S2: the page = the summary + one sub-view's part at a time; every sub-view together shows what the one page did
    const html = GUARD_SUBS.map(([sub]) => renderTab('slop', { ...guardSummary(g), sub, limit: 40, ...guardPart(g, sub), parts_loading: false }, { project: 'kestrel' })).join('');
    for (const id of ['slop-orc', 'slop-line', 'slop-types', 'slop-ledger', 'slop-rows', `slop-${code.id}`]) assert.ok(html.includes(`id="${id}"`), id);
    assert.match(html, /data-go="slop" data-gojump="slop-S-fp1"/);
    for (const s of [explainOf('K2').what, explainOf('K2').why, 'norn rec add waiver --rule K2 --scope fp1']) assert.ok(html.includes(s.replace(/"/g, '&quot;')), `RM-27: the Slop row shows ${s}`);
    assert.match(html, /Pop-ups: <b>off<\/b>/);
    assert.match(html, /data-act="orc-call"/);
    // a chip in place on the run that owns the block
    const ag = { ...(await f.get('/api/agents?project=kestrel')).data, top: [], guard: g };
    assert.match(renderTab('runs', ag, { project: 'kestrel' }), /id="node-RUN-1"[^]*?Slop finding/);
    // a chip in place on the Settings class row a model advice is about
    const set = { ...(await f.get('/api/settings?project=kestrel')).data, guard: { rows: [{ id: 'M-1', type: 'models', cls: 'chores', severity: 'medium', why: 'Chores on a top model' }] } };
    assert.match(renderTab('settings', set, { project: 'kestrel' }), /id="grp-executors-routing-chores"[^>]*><div class="sl"><b>Chores<\/b> <button class="lnk gchip" data-go="usage" data-gojump="usage-advice"/);
    assert.equal((await f.get('/api/guard?project=all')).status, 400, 'one project');
  } finally { await f.done(); }
});

test('Slop sits in More under Health beside Usage, Tests and Context; chips in place on Docs', () => {
  assert.deepEqual(MORE.find(g => g[0] === 'Health')[1], ['usage', 'slop', 'tests', 'context']);
  assert.match(renderMore('slop', {}), /data-tab="slop" aria-current="page"/);
  // META-UX-BUILD S3: the Docs list carries each file's finding count (the same scan findings the Guard lists)
  const docs = renderTab('docs', { files: 2, groups: [{ id: 'project', label: 'Project docs', n: 2, rows: [{ key: 'doc-0', name: 'Plan', path: 'P', exists: true, findings: 0 }, { key: 'doc-1', name: 'Spec', path: 'S', exists: true, findings: 1 }] }] }, {});
  assert.match(docs, /id="docf-doc-1"[^]*?Spec[^]*?<span class="gchip"[^>]*><span class="chip warn">1 finding<\/span>/);
  assert.ok(!docs.split('id="docf-doc-1"')[0].includes('class="gchip"'), 'no chip on a file without findings');
});

// RM-27: on a phone the explanation opens under its row and nothing scrolls sideways (the waiver command wraps)
test('the Slop row explains its finding on a phone: what / why / what to do / the waiver path, no sideways scroll', { skip: skipWhy, timeout: 300000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    const S = f.pa.state;
    fs.mkdirSync(path.join(S, 'slop'), { recursive: true });
    fs.writeFileSync(path.join(S, 'slop', 'holds.json'), JSON.stringify({ 'feat/a-rather-long-branch-name-for-a-phone': { lane: 'seabed', run: 'RUN-1', base: 'a', head: 'b', at: new Date().toISOString(),
      blocks: [{ rule: 'K2', level: 'BLOCK', file: 'engine/lib/some/deep/folder/a-module-with-a-long-name.mjs', line: 4, msg: 'an empty catch', fp: '0123456789abcdef' }] } }));
    let g = (await f.get('/api/guard?project=kestrel')).data;   // the instruction scan lands from its worker first, as in the test above
    for (let i = 0; g.pending && i < 1200; i++) { await sleep(100); g = (await f.get('/api/guard?project=kestrel')).data; }
    assert.ok(g.rows.find(r => r.id === 'S-0123456789abcdef')?.explain, 'the API row carries the explanation');
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await pg.go(`${f.url}/?project=kestrel&tab=slop&sub=fix`, 60000);
    assert.ok(await pg.until(`!!document.querySelector('#slop-S-0123456789abcdef .sexplain')`, 60000), 'the row and its explanation are painted');
    await pg.ev(`document.querySelectorAll('#slop-sub details').forEach(d => { d.open = true; })`);
    const text = await pg.ev(`document.querySelector('#slop-S-0123456789abcdef .sexplain').innerText`);
    for (const s of [explainOf('K2').what, explainOf('K2').fix, 'norn rec add waiver --rule K2 --scope 0123456789abcdef']) assert.ok(text.includes(s), s);
    assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on a phone');
  } finally { await pg.close(); await f.done(); }
});
