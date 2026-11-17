// META-UX-BUILD S6 (REPORT s.3 "End to end" 1-2, DIR-65 Q2 A): Fix all = ONE sheet over Slop's batches (ready + to draft ticked; your
// call = two buttons, a pick adds it; count rows not offered; stale paragraphs and the owner's own files never pre-ticked) and ONE send
// = one decision + one directive through the existing record path, with the chosen finding ids and the usage approval. Nothing is
// edited, no run starts. Sandbox only: pure renders, the shared dash fixture (temp dirs) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { advisory } from '../engine/lib/advisory.mjs';
import { CHECKS } from '../engine/lib/instrchecks.mjs';
import { guardRows, guardView } from '../engine/lib/guardview.mjs';
import { guardSummary, fixSheet, fixPick } from '../engine/dash/guardparts.mjs';
import { renderTab, loadTab } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

/** an instructions view: drafts (check 16, one row in the owner's own file), a ready tighten, a stale (call) tighten, a call rule, a count row */
function insView() {
  const f = (check, i, severity = 'medium', path = 'C:/r/CLAUDE.md') => advisory({ phase: 'P1', check, key: `instr-c${check}`, severity, surface: CHECKS[check].title, path, line: i + 1, why: `c${check} ${i}`, source: 's', subject: `${check}|${i}`,
    fix: { tier: 'card', action: `fix ${check}`, kind: severity === 'count' ? CHECKS[check].info ?? CHECKS[check].fix.kind : CHECKS[check].fix.kind, ways: CHECKS[check].fix.ways } });
  return { rows: [{ id: 'claude', path: 'C:/r/CLAUDE.md' }, { id: 'user', path: 'C:/u/.claude/CLAUDE.md', machine_only: true }],
    findings: [f(16, 0), f(16, 1), f(16, 2, 'medium', 'C:/u/.claude/CLAUDE.md'), f(9, 4, 'count')],
    rules: { advisories: [advisory({ phase: 'P3', key: 'rule-drift-claim', severity: 'medium', surface: 'rule', path: 'C:/r/CLAUDE.md', line: 9, why: 'claims', source: 's', fix: { tier: 'card', action: 'add or drop', kind: 'call', ways: ['Add the enforcement', 'Drop the claim'] } })] },
    hints: [],
    suggest: [{ id: 'S-1', class: 'stale', path: 'C:/r/CLAUDE.md', line: 20, head: 'old para', why: 'old', action: 'delete it, or confirm it', patch: '@@ -20,1 +19,0 @@', saved_per_day: 50, owner_file: false },
      { id: 'S-2', class: 'superseded', path: 'C:/r/CLAUDE.md', line: 30, head: 'cites DEC-1', why: 'DEC-1 is superseded', action: 'delete it', patch: '@@ -30,1 +29,0 @@', saved_per_day: 9, owner_file: false },
      { id: 'S-3', class: 'superseded', path: 'C:/u/.claude/CLAUDE.md', line: 3, head: 'cites DEC-2', why: 'DEC-2 is superseded', action: 'delete it', patch: '@@ -3,1 +2,0 @@', saved_per_day: 4, owner_file: true }] };
}
const view = () => ({ ...guardView(guardRows({ ins: insView() })), project: 'kestrel', pending: false, slop: true, voice: { popups: 'off' }, errors: [] });

test('the sheet: ready + to draft ticked, your call as two ways (never ticked), counts not offered, the owner\'s files never pre-ticked; counts match the summary', () => {
  const g = view(), rows = g.rows, s = guardSummary(g), sh = fixSheet(g);
  assert.ok(rows.find(r => r.id === 'T-S-3').owner_file && rows.filter(r => r.owner_file).length === 2, 'a row on the owner\'s own file says so');
  assert.ok(!sh.items.some(i => i.kind === 'count'), 'rows that only count are not offered');
  for (const k of ['ready', 'drafts', 'call']) assert.equal(sh.items.filter(i => i.kind === k).reduce((n, i) => n + i.n, 0), s.kinds[k], `the sheet's ${k} = the Slop summary's`);
  assert.deepEqual(sh.kinds, s.kinds);
  const by = k => sh.items.find(i => i.key === k);
  assert.deepEqual([by('instr-c16|drafts').tick, by('instr-c16|drafts').n], [true, 2], 'to draft: ticked, without the owner\'s file');
  assert.deepEqual([by('instr-c16|drafts|own').tick, by('instr-c16|drafts|own').own, by('instr-c16|drafts|own').n], [false, true, 1], 'the owner\'s file: offered, never pre-ticked');
  assert.deepEqual([by('tighten-superseded|ready').tick, by('tighten-superseded|ready').n, by('tighten-superseded|ready|own').tick], [true, 1, false]);
  const stale = by('tighten-stale|call'), claim = by('rule-drift-claim|call');
  assert.deepEqual([stale.tick, stale.ways], [false, ['Delete it', 'Confirm it']], 'a stale paragraph is your call: never ticked for you');
  assert.deepEqual([claim.tick, claim.ways], [false, ['Add the enforcement', 'Drop the claim']]);
  assert.equal(sh.ticked, 3, 'Fix all (n) = the ticked findings');
  assert.equal(s.fixable, 3, 'the summary carries the same n for the button');
  assert.equal(sh.sig, s.sig);
});

test('fixPick: the ticked keys + the picked ways -> the finding ids; a wrong way or key is refused; the same set has the same hash', () => {
  const g = view(), ids = k => g.rows.filter(r => r.batch === k && !r.owner_file).map(r => r.id).sort();
  const x = fixPick(g, { keys: ['instr-c16|drafts', 'tighten-superseded|ready'], picks: { 'rule-drift-claim|call': 'Drop the claim' } });
  assert.deepEqual(x.ids, [...ids('instr-c16|drafts'), ...ids('tighten-superseded|ready'), ...ids('rule-drift-claim|call')].sort());
  assert.deepEqual(x.picks, [{ key: 'rule-drift-claim|call', way: 'Drop the claim', ids: ids('rule-drift-claim|call') }]);
  assert.equal(x.batches, 3);
  const own = fixPick(g, { keys: ['instr-c16|drafts|own'], picks: {} });
  assert.deepEqual(own.ids, g.rows.filter(r => r.batch === 'instr-c16|drafts' && r.owner_file).map(r => r.id), 'ticked by hand, the owner\'s rows go');
  assert.equal(fixPick(g, { keys: ['tighten-superseded|ready', 'instr-c16|drafts'], picks: { 'rule-drift-claim|call': 'Drop the claim' } }).set, x.set);
  assert.notEqual(fixPick(g, { keys: ['instr-c16|drafts', 'tighten-superseded|ready'], picks: { 'rule-drift-claim|call': 'Add the enforcement' } }).set, x.set);
  assert.throws(() => fixPick(g, { keys: [], picks: { 'rule-drift-claim|call': 'Burn it' } }), /way/);
  assert.throws(() => fixPick(g, { keys: ['rule-drift-claim|call'], picks: {} }), /pick one of its two ways/);
  assert.throws(() => fixPick(g, { keys: ['nope|drafts'], picks: {} }), /no batch/);
  assert.throws(() => fixPick(g, { keys: ['instr-c9|count'], picks: {} }), /no batch/);
  assert.throws(() => fixPick(g, { keys: [], picks: {} }), /nothing/);
});

test('the Slop page: Fix all (n) beside his line; the sheet: ticks, two buttons per your call, Send the fixer (n), the usage line', () => {
  const g = view(), s = guardSummary(g), base = { ...s, limit: 40, sub: 'fix', fix: { batches: [], nb: 0, n: 0 }, parts_loading: false };
  const page = renderTab('slop', base, { project: 'kestrel' });
  assert.match(page, /id="slop-orc"[^]*<button[^>]*data-act="fixall-open"[^>]*>Fix all \(3\)<\/button>/);
  const usage = { line: 'One fixer run (docs work: runner, claude-sonnet-5-5 medium) · the median is ~0.2 M cache reads (4 runs, 7 days)' };
  const html = renderTab('slop', { ...base, sheet: { ...fixSheet(g), usage } }, { project: 'kestrel' });
  assert.match(html, /id="fixall"/);
  assert.equal((html.match(/data-fx-key="[^"]*"[^>]* checked/g) || []).length, 2, 'ready + to draft (not the owner\'s) ticked');
  assert.match(html, /data-fx-key="instr-c16\|drafts\|own"(?![^>]* checked)/);
  assert.match(html, /data-act="fx-way" data-key="rule-drift-claim\|call" data-way="Add the enforcement"[^]*data-way="Drop the claim"/);
  assert.match(html, /data-act="fx-way" data-key="tighten-stale\|call" data-way="Delete it"/);
  assert.doesNotMatch(html, /instr-c9\|count/);
  assert.match(html, /<button[^>]*data-act="fixall-send"[^>]*>Send the fixer \(<span id="fx-n">3<\/span>\)<\/button>/);
  assert.ok(html.includes(usage.line));
  assert.match(html, /Nothing is edited when you tap/i);
  const sent = renderTab('slop', { ...base, sheet: { ...fixSheet(g), usage }, sheet_sent: { id: 'DEC-9', directive: 'DIR-4', n: 3 } }, { project: 'kestrel' });
  assert.match(sent, /DEC-9[^]*DIR-4/);
  assert.match(sent, /data-act="fixall-send"[^>]* disabled/);
});

test('after a Send: the sent findings are not offered again, the summary and the page say they are with the fixer', () => {
  const g0 = view(), ids = g0.rows.filter(r => r.batch === 'instr-c16|drafts' && !r.owner_file).map(r => r.id);
  const g = { ...g0, rows: g0.rows.map(r => (ids.includes(r.id) ? { ...r, sent: 'DEC-9' } : r)), sent: [{ id: 'DEC-9', directive: 'DIR-4', n: ids.length, open: ids.length }] };
  const sh = fixSheet(g), s = guardSummary(g);
  assert.ok(!sh.items.some(i => i.key === 'instr-c16|drafts'), 'the sent batch is not on the sheet');
  assert.ok(sh.items.some(i => i.key === 'instr-c16|drafts|own'), 'the rest of the batch still is');
  assert.equal(sh.ticked, 1); assert.equal(s.fixable, 1);
  assert.notEqual(sh.sig, fixSheet(g0).sig, 'a send changes the sheet sig');
  assert.throws(() => fixPick(g, { keys: ['instr-c16|drafts'], picks: {} }), /no batch/, 'a sent batch cannot be sent again');
  const page = renderTab('slop', { ...s, limit: 40, sub: 'fix', fix: { batches: [], nb: 0, n: 0 }, parts_loading: false }, { project: 'kestrel' });
  assert.match(page, /id="slop-sent"[^]*DEC-9 \+ DIR-4: 2 finding/);
  assert.match(page, /Fix all \(1\)/);
  // everything sent: no Fix all button, the line says so
  const all = g0.rows.map(r => ({ ...r, sent: 'DEC-9' })), ga = { ...g0, rows: all, sent: [{ id: 'DEC-9', directive: 'DIR-4', n: all.length, open: all.length }] };
  const pa = renderTab('slop', { ...guardSummary(ga), limit: 40, sub: 'fix', fix: { batches: [], nb: 0, n: 0 }, parts_loading: false }, { project: 'kestrel' });
  assert.doesNotMatch(pa, /data-act="fixall-open"/);
  assert.match(pa, /Nothing else to send/);
});

test('loadTab(slop) with the sheet open asks for part=sheet', async () => {
  const asked = [];
  const d = await loadTab('slop', 'kestrel', async u => { asked.push(u); return u.includes('part=sheet') ? { sheet: { items: [] } } : { sig: 'x' }; }, { sub: 'fix', fixall: {} });
  assert.ok(asked.includes('/api/guard?project=kestrel&part=sheet'), asked.join(' '));
  assert.deepEqual(d.sheet, { items: [] });
});

test('POST /api/fixall: ONE decision + ONE directive with the ids, the picked way and the usage approval; a second tap writes nothing; the phone sheet', { timeout: 240000 }, async t => {
  const f = await fixture();
  try {
    let s = (await f.get('/api/guard?project=kestrel&part=summary')).data;
    for (let i = 0; s.pending && i < 1200; i++) { await new Promise(r => setTimeout(r, 100)); s = (await f.get('/api/guard?project=kestrel&part=summary')).data; }
    const sh = (await f.get('/api/guard?project=kestrel&part=sheet')).data.sheet;
    assert.equal(sh.sig, s.sig);
    for (const k of ['ready', 'drafts', 'call']) assert.equal(sh.items.filter(i => i.kind === k).reduce((n, i) => n + i.n, 0), s.kinds[k], k);
    assert.match(sh.usage.line, /One fixer run \(docs work: runner, claude-sonnet-5-5 medium\)/);
    const keys = sh.items.filter(i => i.tick).map(i => i.key), call = sh.items.find(i => i.kind === 'call');
    assert.ok(keys.length && call, 'the fixture has ticked batches and a your-call batch');
    const before = (await f.get('/api/records?project=kestrel')).data;
    assert.equal((await f.post('/api/fixall', { project: 'kestrel', sig: 'stale', keys, picks: {} })).status, 409, 'a sheet of an older scan is refused');
    const body = { project: 'kestrel', sig: sh.sig, keys, picks: { [call.key]: call.ways[1] } };
    const r = await f.post('/api/fixall', body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const after = (await f.get('/api/records?project=kestrel')).data;
    assert.equal(after.decisions.length, before.decisions.length + 1); assert.equal(after.directives.length, before.directives.length + 1);
    const dec = after.decisions.find(x => x.id === r.data.id), dir = after.directives.find(x => x.id === r.data.directive);
    const n = sh.items.filter(i => i.tick).reduce((a, i) => a + i.n, 0) + call.n;
    assert.equal(r.data.n, n);
    assert.equal(dec.data.lane, 'fixall'); assert.equal(dec.data.findings.length, n);
    assert.deepEqual(dec.data.picks.map(p => [p.key, p.way]), [[call.key, call.ways[1]]]);
    const m = Math.ceil(n / sh.usage.batch); assert.equal(dec.data.runs, m, 'the tap approves the real number of runs (S7)'); assert.ok(dec.data.why.includes(`approves ${m} fixer run(s) of at most ${sh.usage.batch} findings`), dec.data.why); assert.equal(dec.data.usage, sh.usage.line);
    assert.deepEqual(dir.data.findings, dec.data.findings); assert.equal(dir.data.fixall, dec.id);
    assert.match(dir.data.text, new RegExp(`${dec.id}[^]*${dec.data.findings[0]}`));
    assert.match(dir.data.text, /edits nothing/);
    assert.match(dir.data.text, /the engine starts the fixer by code \(\d+ runs? of at most \d+ findings \(docs work: runner, claude-sonnet-5-5 medium\)[^)]*\)[^]*never reads these ids/); assert.doesNotMatch(dir.data.text, /One fixer run/, 'the usage is said once');
    const again = await f.post('/api/fixall', body);
    assert.equal(again.status, 409, 'the sheet it was drawn from changed: its findings are with the fixer now');
    // the server remembers the send: the summary + a fresh sheet leave the sent findings out (leaving the tab no longer loses it)
    const s2 = (await f.get('/api/guard?project=kestrel&part=summary')).data, sh2 = (await f.get('/api/guard?project=kestrel&part=sheet')).data.sheet;
    assert.deepEqual(s2.sent.map(x => [x.id, x.directive, x.open]), [[dec.id, dir.id, n]]);
    assert.ok(!sh2.items.some(i => keys.includes(i.key) || i.key === call.key), 'the sent batches are not offered again');
    const last = (await f.get('/api/records?project=kestrel')).data;
    assert.equal(last.decisions.length + last.directives.length, after.decisions.length + after.directives.length);
    const rec = renderTab('records', last, { project: 'kestrel' });
    assert.match(rec, new RegExp(`id="rec-${dir.id}"[^]*${n} finding ids[^]*${dec.data.findings.at(-1)}`), 'Records shows the directive with its ids');
    if (skipWhy) { t.diagnostic(`browser part skipped: ${skipWhy}`); return; }
    const pg = await openPage([390, 844]);
    try {
      await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await pg.go(`${f.url}/?project=kestrel&tab=slop`);
      assert.ok(await pg.until(`document.querySelector('[data-act=fixall-open]')`, 60000));
      await pg.ev(`document.querySelector('[data-act=fixall-open]').click()`);
      assert.ok(await pg.until(`document.querySelector('#fixall [data-act=fx-way]')`, 60000), 'the sheet opens');
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on a phone');
      assert.ok(await pg.ev(`[...document.querySelectorAll('#fixall [data-act=fx-way]')].every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= 390 && r.width > 0; })`), 'the two-way buttons are reachable');
      const n0 = Number(await pg.ev(`document.querySelector('#fx-n').textContent`));
      await pg.ev(`document.querySelector('#fixall [data-act=fx-way]').click()`);
      assert.ok(Number(await pg.ev(`document.querySelector('#fx-n').textContent`)) > n0, 'a pick adds its batch to the count');
      await pg.ev(`document.querySelector('#fixall [data-act=fixall-send]').click()`);
      assert.ok(await pg.until(`document.querySelector('#fixall-sent') && document.querySelector('#fixall [data-act=fixall-send]').disabled`, 60000), 'the send says what it wrote and cannot be sent twice');
      const end = (await f.get('/api/records?project=kestrel')).data;
      assert.equal(end.directives.length, last.directives.length + 1, 'the page tap wrote its own pair (another set: the first way)');
    } finally { await pg.close(); }
  } finally { await f.done(); }
});
