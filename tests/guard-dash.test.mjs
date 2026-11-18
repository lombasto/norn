// META-TEND P6: the Guard on the dashboard - GET /api/guard (a sandboxed fixture: temp HOME, no real ~/.claude) over SloppaChoppa's
// open BLOCK findings, the tests advisories and the instruction scan (a worker, never on the request path); the Guard tab; the chips
// in place on Agents, Docs and Settings; pop-ups ship off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/dash-fixture.mjs';
import { advisory } from '../engine/lib/advisory.mjs';
import { renderTab, renderNav, NAV } from '../engine/dash/ui.mjs';
import { GUARD_SUBS, guardSummary, guardPart } from '../engine/dash/guardparts.mjs';

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

test('Slop sits in Health beside Usage, Tests and Context; chips in place on Docs', () => {
  assert.deepEqual(NAV.find(d => d[0] === 'health')[2], ['usage', 'slop', 'tests', 'context']);
  assert.match(renderNav('slop', {}), /id="tab-slop"[^>]*aria-selected="true"/);
  // META-UX-BUILD S3: the Docs list carries each file's finding count (the same scan findings the Guard lists)
  const docs = renderTab('docs', { files: 2, groups: [{ id: 'project', label: 'Project docs', n: 2, rows: [{ key: 'doc-0', name: 'Plan', path: 'P', exists: true, findings: 0 }, { key: 'doc-1', name: 'Spec', path: 'S', exists: true, findings: 1 }] }] }, {});
  assert.match(docs, /id="docf-doc-1"[^]*?Spec[^]*?<span class="gchip"[^>]*><span class="chip warn">1 finding<\/span>/);
  assert.ok(!docs.split('id="docf-doc-1"')[0].includes('class="gchip"'), 'no chip on a file without findings');
});
