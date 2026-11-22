// META-UX-BUILD S1: the Instructions view never blocks the dash - the scan runs in the worker thread (lib/guard-scan.mjs), the last
// view is served at once (kept on disk under the project state, so a restart is not cold), one rebuild at a time per project; the
// first answer is a small summary and each list comes as its own capped part (?part=); the page shows a "refreshing" chip.
// Sandbox only: the shared dash fixture (temp dirs, no real ~/.claude).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import wt from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './helpers/dash-fixture.mjs';
import { createDashboard } from '../engine/dash/server.mjs';
import { INS_PARTS, INS_CAPS, insSummary, insPart, contextParts } from '../engine/dash/insparts.mjs';
import { renderTab, loadTab, loadParts } from '../engine/dash/ui.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const VIEW_FILE = 'instructions-view.json';

/** a big synthetic view: every list over its cap */
function bigView() {
  const n = k => Array.from({ length: k }, (_, i) => i);
  const rules = ['prose', 'repeated', 'enforced', 'retired'].flatMap(st => n(55).map(i => ({ id: `${st}-${i}`, state: st, text: `rule ${st} ${i}`, homes: n(i % 3 + 1), repeats: i, home: { path: 'C:/r/CLAUDE.md', line: i + 1 } })));
  return { project: 'kestrel', day: '2026-11-14', method: 'm', sessions: 2, total: 10, standing: [], measured: null, checkins: [], managed: { files: 3, open: 300 },
    rows: n(3).map(i => ({ id: `r${i}`, path: `C:/r/F${i}.md`, name: `F${i}.md`, exists: true, tokens: 10, load: 'session' })),
    hints: n(200).map(i => ({ id: 'r0', path: 'C:/r/F0.md', kind: 'missing-path', line: i, text: `h${i}` })),
    suggest: n(700).map(i => ({ id: `S-${i}`, class: 'large', file: 'F0.md', head: 'x', saved_per_day: 700 - i, why: 'w', action: 'a' })),
    findings: n(300).map(i => ({ id: `A-${i}`, check: 3, severity: 'low', surface: 's', path: i % 2 ? 'C:/r/F0.md' : 'C:/r/F1.md', line: i, why: 'y', fix: { action: 'f' } })),
    rules: { rules, counts: { prose: 55, repeated: 55, enforced: 55, retired: 55 }, advisories: n(90).map(i => ({ id: `R-${i}`, key: i < 80 ? 'rule-several-homes' : 'rule-drift-path', severity: 'low', path: 'C:/r/F0.md', why: 'w', source: 's', fix: { action: 'a' } })), cards: [] },
    evidence: { files: {} }, memory_map: null, audits: null };
}

test('the summary carries no list, only its count; each part is capped at what the page shows + its full count', () => {
  const v = bigView(), s = insSummary(v);
  for (const k of ['rows', 'hints', 'suggest', 'findings', 'rules', 'evidence']) assert.equal(s[k], undefined, `${k} is a part, not in the first answer`);
  assert.deepEqual(s.counts, { files: 3, hints: 200, suggest: 700, findings: 300, rules: 220, advisories: 90 });
  assert.equal(s.managed.open, 300);
  assert.deepEqual(INS_PARTS, ['files', 'rules', 'findings', 'hints', 'suggest']);
  assert.equal(insPart(v, 'files').rows.length, 3);
  const sg = insPart(v, 'suggest');
  assert.equal(sg.suggest.length, INS_CAPS.suggest); assert.equal(sg.suggest_n, 700); assert.equal(sg.suggest[0].id, 'S-0');
  const h = insPart(v, 'hints'); assert.equal(h.hints.length, INS_CAPS.hints); assert.equal(h.hints_n, 200);
  const f = insPart(v, 'findings'); assert.equal(f.findings.length, INS_CAPS.findings); assert.equal(f.findings_n, 300);
  const r = insPart(v, 'rules').rules;
  for (const st of ['prose', 'repeated', 'enforced', 'retired']) assert.equal(r.rules.filter(x => x.state === st).length, INS_CAPS.ladder, `${st}: the ladder's column cap`);
  assert.equal(r.rules.filter(x => x.state === 'repeated')[0].repeats, 54, 'the column keeps its top cards (the ladder order: most repeats first)');
  assert.deepEqual(r.counts, v.rules.counts);
  assert.equal(r.advisories.filter(a => a.key === 'rule-several-homes').length, INS_CAPS.advisories);
  assert.deepEqual(r.adv_counts, { 'rule-several-homes': 80, 'rule-drift-path': 10 });
  assert.throws(() => insPart(v, 'nope'), /unknown part/);
  assert.ok(JSON.stringify(insPart(v, 'suggest')).length < JSON.stringify(v.suggest).length / 10);
});

test('the page: a pending first scan shows the refreshing chip (never blank); parts load by themselves and their caps say so', async () => {
  const pend = renderTab('context', { project: 'kestrel', pending: true, refreshing: true });
  assert.match(pend, /id="ins-refreshing"/); assert.match(pend, /first scan/);
  const v = bigView(), s = { ...insSummary(v), at: '2026-11-14T10:00:00.000Z', refreshing: true };
  const first = renderTab('context', { ...s, sub: 'checks', parts_loading: true });   // META-UX-BUILD S4: the lists live on Context's checks page
  assert.match(first, /id="ins-refreshing"/); assert.match(renderTab('context', { ...s, sub: 'file', parts_loading: true }), /id="context-sub-loading"/);
  assert.equal((first.match(/class="small mute inspart">loading/g) || []).length, 2, 'each list part shows its own loading line (the files are in Per file; S5: hints + Tighten are Slop rows)');
  const calls = [];
  const parts = await loadParts('context', 'kestrel', { ...s, sub: 'checks' }, async u => { calls.push(u); return insPart(v, new URL(u, 'http://x').searchParams.get('part')); });
  assert.deepEqual(calls, contextParts('checks').map(k => `/api/instructions?project=kestrel&part=${k}`));
  assert.deepEqual(contextParts('checks'), ['files', 'rules', 'findings']);
  const html = renderTab('context', { ...s, sub: 'checks', refreshing: false, ...parts });
  assert.doesNotMatch(html, /id="ins-refreshing"/); assert.doesNotMatch(html, /inspart">loading/);
  assert.match(html, /data-go="slop" data-gosub="fix"/, 'S5: Hints + Tighten moved to Slop, one link away');
  assert.match(html, /showing 120 of 300/);
  assert.match(html, /<b>80<\/b> × one rule in several homes/);
  assert.match(html, /220 must \/ never rules/);
  // loadTab: the summary; parts already fetched for this view (same project + at) paint at once (S3: a file opens in the Docs reader)
  const got = [];
  const d = await loadTab('context', 'kestrel', async u => { got.push(u); return s; }, { sub: 'checks', parts: { context: { key: `kestrel|${s.at}|checks`, data: parts } } });
  assert.deepEqual(got, ['/api/instructions?project=kestrel']);
  assert.equal(d.parts_loading, false); assert.equal(d.rows.length, 3);
  const d2 = await loadTab('context', 'kestrel', async () => s, { sub: 'checks', parts: { context: { key: 'kestrel|older', data: parts } } });
  assert.equal(d2.parts_loading, true, 'a new view: its parts are fetched again'); assert.equal(d2.rows, undefined);
});

test('GET /api/instructions never scans in the handler: pending at once, the worker lands, parts on request, the view on disk, a restart is warm', { timeout: 180000 }, async () => {
  const f = await fixture({ dash: { insTtlMs: 60000 } });
  try {
    fs.writeFileSync(path.join(f.pa.root, 'CLAUDE.md'), '# Rules\n\nRead `docs/missing.md` first.\n');
    const t0 = Date.now();
    const a = await f.get('/api/instructions?project=kestrel');
    assert.equal(a.status, 200); assert.equal(a.data.pending, true); assert.equal(a.data.refreshing, true);
    assert.ok(Date.now() - t0 < 2000, 'the first answer does not wait for the scan');
    const b = await f.get('/api/instructions?project=kestrel');
    assert.equal(b.data.pending, true, 'still the one rebuild');
    let s = a.data;
    for (let i = 0; s.pending && i < 1200; i++) { await sleep(100); s = (await f.get('/api/instructions?project=kestrel')).data; }
    assert.equal(s.pending, false); assert.equal(s.refreshing, false); assert.ok(Date.parse(s.at));
    assert.equal(s.rows, undefined); assert.ok(s.counts.files >= 1);
    const files = (await f.get('/api/instructions?project=kestrel&part=files')).data;
    const row = files.rows.find(r => r.path.endsWith('/CLAUDE.md') && r.where === 'repo');
    assert.ok(row);
    assert.ok((await f.get('/api/instructions?project=kestrel&part=hints')).data.hints.some(h => /missing\.md/.test(h.text)));
    assert.equal((await f.get('/api/instructions?project=kestrel&part=nope')).status, 400);
    const one = (await f.get(`/api/instructions/${row.id}?project=kestrel`)).data;
    assert.match(one.text, /# Rules/); assert.ok(Array.isArray(one.findings), 'the open file carries its own findings');
    const g = (await f.get('/api/guard?project=kestrel')).data;
    assert.equal(g.pending, false, 'the Guard reads the same scan');
    const disk = JSON.parse(fs.readFileSync(path.join(f.pa.state, VIEW_FILE), 'utf8'));
    assert.equal(disk.at, s.at); assert.ok(disk.v.rows.some(r => r.id === row.id));
    // a restart on the same state: content at once from disk, no pending
    const app2 = createDashboard({ projects: [f.pa, f.pb], machine: { home: f.root }, budgetFile: f.budgetFile, platform: {}, insTtlMs: 60000 });
    await new Promise(r => app2.server.listen(0, '127.0.0.1', r));
    try {
      const u2 = `http://127.0.0.1:${app2.server.address().port}`;
      const w = await (await fetch(`${u2}/api/instructions?project=kestrel`)).json();
      assert.equal(w.pending, false); assert.equal(w.at, s.at); assert.equal(w.refreshing, false, 'a fresh view on disk: no rebuild');
      assert.equal((await (await fetch(`${u2}/api/instructions/${row.id}?project=kestrel`)).json()).id, row.id, 'the file reader works from the disk view');
    } finally { await app2.close(); }
  } finally { await f.done(); }
});

test('a stale view is served at once while ONE rebuild runs; the rebuild ends with a new view', { timeout: 180000 }, async () => {
  const f = await fixture({ dash: { insTtlMs: 0 } });
  try {
    fs.writeFileSync(path.join(f.pa.root, 'CLAUDE.md'), '# Rules\n');
    let s = (await f.get('/api/instructions?project=kestrel')).data;
    for (let i = 0; s.pending && i < 1200; i++) { await sleep(100); s = (await f.get('/api/instructions?project=kestrel')).data; }
    const x = (await f.get('/api/instructions?project=kestrel')).data;   // ttl 0: stale -> served at once + a rebuild runs
    assert.equal(x.refreshing, true); assert.equal(x.pending, false); assert.ok(Date.parse(x.at));
    const at0 = x.at, y = (await f.get('/api/instructions?project=kestrel')).data;
    assert.equal(y.refreshing, true); assert.equal(y.at, at0, 'no second rebuild while one runs');
    let z = y;
    for (let i = 0; z.at === at0 && i < 1200; i++) { await sleep(100); z = (await f.get('/api/instructions?project=kestrel')).data; }
    assert.ok(Date.parse(z.at) > Date.parse(at0));
  } finally { await f.done(); }
});

// CI-HANG-B7F6833 R2: close() ends every worker the server started - the instructions worker too, not only the account refresh.
// CI-RED-ADFF31D: a thread has ended at its 'exit' (the thread is joined); an async_hooks destroy comes a loop turn or more
// later (Node's deferred destroy queue), so it is not the oracle. Every Worker the server constructs is tracked through the
// worker_threads export (syncBuiltinESMExports: the server's live import binding sees the subclass).
test('close() ends a running instructions worker: no worker thread is left alive after close', { timeout: 60000 }, async () => {
  const Real = wt.Worker, started = [];
  wt.Worker = class extends Real { constructor(...a) { super(...a); const t = { exited: false }; started.push(t); this.once('exit', () => { t.exited = true; }); } };
  syncBuiltinESMExports();
  const f = await fixture({ dash: { insTtlMs: 60000, accountRefresh: false } });
  try {
    fs.writeFileSync(path.join(f.pa.root, 'CLAUDE.md'), '# Rules\n');
    assert.equal((await f.get('/api/instructions?project=kestrel')).data.pending, true, 'a scan is running');
    assert.ok(started.length >= 1, 'the scan runs in a worker thread');
    await f.app.close();
    const alive = started.filter(t => !t.exited).length;
    assert.equal(alive, 0, `${alive} worker thread(s) still alive after close()`);
  } finally { wt.Worker = Real; syncBuiltinESMExports(); await f.done(); }
});
