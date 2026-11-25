// META-UX-BUILD S5 (REPORT s.2-3, DIR-64): the Guard tab is Slop - one list in batches. Each check DECLARES its kind of fix where the
// check is written (ready / drafts / your call with its two ways / only counts); rows group by check + kind; the three kinds sit apart;
// Hints and Tighten join as rows. Sandbox only: pure renders, the shared dash fixture (temp dirs) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { advisory, FIX_KINDS } from '../engine/lib/advisory.mjs';
import { CHECKS } from '../engine/lib/instrchecks.mjs';
import { HINT_FIX, TIGHTEN_FIX } from '../engine/lib/instructions.mjs';
import { ADVICE_FIX } from '../engine/lib/advice.mjs';
import { guardRows, guardView, SLOP_FIX } from '../engine/lib/guardview.mjs';
import { GUARD_SUBS, guardSummary, guardPart, BATCH_ROWS, KIND_ORDER, chipView } from '../engine/dash/guardparts.mjs';
import { renderTab, loadParts, TABS } from '../engine/dash/ui.mjs';
import { ageLine } from '../engine/dash/pages/slop.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const okFix = (f, where) => {
  assert.ok(f && FIX_KINDS.includes(f.kind), `${where}: declares a kind of fix (${FIX_KINDS.join(' | ')}), got ${JSON.stringify(f)}`);
  if (f.kind === 'call') assert.ok(Array.isArray(f.ways) && f.ways.length === 2 && f.ways.every(w => typeof w === 'string' && w), `${where}: your call names its two ways`);
};

test('every check declares its kind of fix where it is written - none is guessed from its text', () => {
  assert.deepEqual(FIX_KINDS, ['ready', 'drafts', 'call', 'count']);
  assert.deepEqual(KIND_ORDER, FIX_KINDS, 'the page orders the kinds as the checks declare them');
  for (const [n, c] of Object.entries(CHECKS)) { okFix(c.fix, `check ${n}`); if (c.info) assert.ok(FIX_KINDS.includes(c.info), `check ${n} info rows`); }
  for (const [k, f] of Object.entries(HINT_FIX)) { okFix(f, `hint ${k}`); assert.ok(f.title, `hint ${k} title`); }
  for (const k of ['missing-path', 'unknown-command', 'stale-citation', 'directive-clash', 'duplicate']) assert.ok(HINT_FIX[k], `hint kind ${k}`);
  for (const k of ['superseded', 'duplicate', 'stale', 'one-role', 'large', 'lean']) { okFix(TIGHTEN_FIX[k], `tighten ${k}`); assert.ok(TIGHTEN_FIX[k].title); }
  okFix(ADVICE_FIX, 'model advice'); okFix(SLOP_FIX, 'code (slop) blocks');
  // a check written without its kind fails at once
  const base = { key: 'x-check', severity: 'low', why: 'w', source: 's' };
  assert.throws(() => advisory({ ...base, fix: { tier: 'card', action: 'do it' } }), /kind of fix/);
  assert.throws(() => advisory({ ...base, fix: { tier: 'card', action: 'do it', kind: 'call', ways: ['one'] } }), /two ways/);
  assert.throws(() => advisory({ ...base, fix: { tier: 'card', action: 'do it', kind: 'ready' } }), /ready.*patch/);
  const a = advisory({ ...base, fix: { tier: 'card', action: 'a or b', kind: 'call', ways: ['A', 'B'] } });
  assert.deepEqual([a.fix.kind, a.fix.ways], ['call', ['A', 'B']]);
});

/** an instructions view as the scan builds it: findings of two checks (one at count level), a rule advisory, hints, tighten */
function insView() {
  const f = (check, i, severity = 'medium') => ({ ...advisory({ phase: 'P1', check, key: `instr-c${check}`, severity, surface: CHECKS[check].title, path: 'C:/r/CLAUDE.md', line: i + 1, why: `c${check} ${i}`, source: 's', subject: `${check}|${i}`,
    fix: { tier: 'card', action: `fix ${check}`, kind: severity === 'count' ? CHECKS[check].info ?? CHECKS[check].fix.kind : CHECKS[check].fix.kind, ways: CHECKS[check].fix.ways } }) });
  return { rows: [{ id: 'claude', path: 'C:/r/CLAUDE.md' }], findings: [f(16, 0), f(16, 1), f(16, 2), f(16, 5), f(19, 3, 'count'), f(9, 4, 'count')],
    rules: { advisories: [advisory({ phase: 'P3', key: 'rule-drift-claim', severity: 'medium', surface: 'rule', path: 'C:/r/CLAUDE.md', line: 9, why: 'claims', source: 's', fix: { tier: 'card', action: 'add or drop', kind: 'call', ways: ['Add the enforcement', 'Drop the claim'] } })] },
    hints: [{ id: 'claude', path: 'C:/r/CLAUDE.md', kind: 'missing-path', line: 4, text: 'docs/x.md does not exist' }],
    suggest: [{ id: 'S-1', class: 'stale', path: 'C:/r/CLAUDE.md', file: 'CLAUDE.md', line: 20, head: 'old para', why: 'not touched in 90 days', action: 'delete it, or confirm it', patch: '@@ -20,1 +19,0 @@', saved_per_day: 50 },
      { id: 'S-2', class: 'superseded', path: 'C:/r/CLAUDE.md', file: 'CLAUDE.md', line: 30, head: 'cites DEC-1', why: 'DEC-1 is superseded', action: 'delete it', patch: '@@ -30,1 +29,0 @@', saved_per_day: 9 }] };
}

test('rows carry their kind and batch; Hints and Tighten join as rows; batches group by check + kind, the kinds in order', () => {
  const rows = guardRows({ ins: insView() });
  const by = id => rows.find(r => r.id === id);
  assert.equal(rows.length, 10, 'six findings + one rule advisory + one hint + two tighten candidates');
  const c16 = rows.filter(r => r.batch === 'instr-c16|drafts');
  assert.equal(c16.length, 4); assert.equal(c16[0].kind, 'drafts');
  assert.equal(rows.find(r => /^c19/.test(r.why)).kind, 'call', 'check 19 is your call even at count level (its info rows are not declared counts)');
  assert.equal(rows.find(r => /^c9/.test(r.why)).kind, 'count', 'check 9 declares its info rows only count');
  const h = rows.find(r => r.id.startsWith('H-')), t1 = by('T-S-1'), t2 = by('T-S-2');
  assert.deepEqual([h.kind, h.severity, h.go.tab], [HINT_FIX['missing-path'].kind, 'low', 'docs']);
  assert.deepEqual([t1.kind, t1.ways, t2.kind], ['call', TIGHTEN_FIX.stale.ways, 'ready']);
  const g = { ...guardView(rows), project: 'kestrel', pending: false, slop: true, voice: {}, errors: [] };
  const s = guardSummary(g);
  assert.deepEqual(s.kinds, { ready: 1, drafts: 5, call: 3, count: 1 });
  assert.equal(s.batches, 6);
  const { fix } = guardPart(g, 'fix');
  assert.equal(fix.batches.length, 7, 'six batches to fix or decide + one of rows that only count');
  const order = fix.batches.map(b => b.kind), rank = k => FIX_KINDS.indexOf(k);
  assert.ok(order.every((k, i) => i === 0 || rank(order[i - 1]) <= rank(k)), `kinds in order: ${order}`);
  const b16 = fix.batches.find(b => b.key === 'instr-c16|drafts');
  assert.deepEqual([b16.title, b16.n, b16.action], [CHECKS[16].title, 4, 'fix 16']);
  assert.ok(b16.rows.length <= BATCH_ROWS);
  const claim = fix.batches.find(b => b.key === 'rule-drift-claim|call');
  assert.deepEqual(claim.ways, ['Add the enforcement', 'Drop the claim']);
  assert.equal(fix.n, 10);
  const one = guardPart(g, 'fix', 40, 'instr-c16|drafts').fix;
  assert.equal(one.open, 'instr-c16|drafts'); assert.equal(one.batches.find(b => b.key === 'instr-c16|drafts').rows.length, 4, 'an opened batch lists every row (capped at the limit)');
});

test('the Slop page: no "one voice of the Guard"; 4 numbers (open, ready, to draft, your call); the kinds apart; counts folded; label Slop', () => {
  const rows = guardRows({ ins: insView() });
  const g = { ...guardView(rows), project: 'kestrel', pending: false, slop: true, voice: { popups: 'off' }, errors: [] };
  const s = guardSummary(g), base = { ...s, limit: 40, sub: 'fix' };
  const html = renderTab('slop', { ...base, ...guardPart(g, 'fix'), parts_loading: false }, { project: 'kestrel' });
  assert.doesNotMatch(html, /one voice of the Guard/);
  assert.doesNotMatch(html, /\bGuard\b/, 'no "Guard" left in the page text');
  // bddb2b4c (ui-spend-slop): no counter row, no banner, no footer - open / ready are the To fix chips, each kind's count heads its section
  assert.equal((html.match(/class="subnum/g) || []).length, 0);
  assert.match(html, /data-kind="" aria-pressed="true">Open <b>10<\/b>/); assert.match(html, /data-kind="ready" aria-pressed="false">Ready <b>1<\/b>/);
  assert.match(html, /<h2>Ready <span class="mute small">1<\/span>/); assert.match(html, /<h2>To draft <span class="mute small">5<\/span>/); assert.match(html, /<h2>Your call <span class="mute small">3<\/span>/);
  for (const id of ['slop-head', 'slop-subs', 'slop-ready', 'slop-drafts', 'slop-call', 'slop-count']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.indexOf('id="slop-ready"') < html.indexOf('id="slop-drafts"') && html.indexOf('id="slop-drafts"') < html.indexOf('id="slop-call"') && html.indexOf('id="slop-call"') < html.indexOf('id="slop-count"'));
  assert.match(html, /id="slop-call"[^]*Add the enforcement[^]*Drop the claim/);
  assert.match(html, /data-act="slop-batch" data-batch="instr-c16\|drafts"/);
  assert.ok(TABS.some(([id, label]) => id === 'slop' && label === 'Slop') && !TABS.some(([id]) => id === 'guard'), 'the tab is Slop');
  assert.equal(GUARD_SUBS[0][0], 'fix');
  // Context's checks page: Hints and Tighten moved to Slop - its link lands there
  const ctx = renderTab('context', { project: 'kestrel', sub: 'checks', at: 'x', hints: [{ id: 'a', path: 'C:/r/a.md', kind: 'missing-path', line: 1, text: 't' }], suggest: [], rules: null, findings: [], parts_loading: false }, {});
  assert.doesNotMatch(ctx, /id="ins-hints-card"|id="ins-suggest-card"/);
  assert.match(ctx, /data-go="slop"[^>]*>[^<]*Slop/);
});

test('the chip view (the full /api/guard every page reads): no hint / tighten rows and no patch text - the Slop parts keep them', () => {
  const rows = guardRows({ ins: insView() }), g = { ...guardView(rows), project: 'kestrel', pending: false, slop: true, voice: {}, errors: [] };
  assert.ok(rows.some(r => r.id.startsWith('H-')) && rows.find(r => r.id === 'T-S-1').patch === '@@ -20,1 +19,0 @@', 'the Slop row keeps its patch');
  const c = chipView(g);
  assert.equal(c.rows.length, 7, 'six findings + one rule advisory; the hint and the two candidates live on Slop only');
  assert.ok(c.rows.every(r => !r.id.startsWith('H-') && !r.id.startsWith('T-') && typeof r.patch !== 'string'));
  assert.equal(c.total, g.total, 'the counts stay whole');
  assert.ok(guardPart(g, 'fix').fix.batches.some(b => b.rows.some(r => r.id === 'T-S-2')));
});

test('loadParts(slop) reads /api/guard and asks for one batch when one is open', async () => {
  const asked = [];
  await loadParts('slop', 'kestrel', { sub: 'fix', limit: 40, batch: 'instr-c16|drafts', sig: 'x' }, async u => { asked.push(u); return {}; });
  assert.deepEqual(asked, ['/api/guard?project=kestrel&part=fix&limit=40&batch=instr-c16%7Cdrafts']);
});

test('GET /api/guard?part=fix: batches with kinds; &batch= opens one; tab=slop on a phone with no sideways scroll', { timeout: 240000 }, async t => {
  const f = await fixture();
  try {
    let s = (await f.get('/api/guard?project=kestrel&part=summary')).data;
    for (let i = 0; s.pending && i < 1200; i++) { await new Promise(r => setTimeout(r, 100)); s = (await f.get('/api/guard?project=kestrel&part=summary')).data; }
    assert.ok(s.kinds && Number.isInteger(s.batches), JSON.stringify(s).slice(0, 300));
    const fix = (await f.get('/api/guard?project=kestrel&part=fix')).data.fix;
    assert.equal(fix.n, s.total);
    assert.equal(fix.batches.reduce((n, b) => n + b.n, 0), s.total, 'every row is in one batch');
    for (const b of fix.batches) { assert.ok(FIX_KINDS.includes(b.kind), b.key); assert.ok(b.rows.length <= BATCH_ROWS); }
    const big = fix.batches.find(b => b.n > BATCH_ROWS);
    if (big) assert.equal((await f.get(`/api/guard?project=kestrel&part=fix&batch=${encodeURIComponent(big.key)}`)).data.fix.batches.find(b => b.key === big.key).rows.length, Math.min(big.n, 40));
    if (skipWhy) { t.diagnostic(`browser part skipped: ${skipWhy}`); return; }
    const pg = await openPage([390, 844]);
    try {
      await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await pg.go(`${f.url}/?project=kestrel&tab=slop`);
      assert.ok(await pg.until(`document.querySelector('#slop-sub[data-sub=fix]') && !document.querySelector('#slop-sub-loading') && document.querySelector('#slop-ready, #slop-drafts, #slop-call, #slop-count')`, 60000), 'an old Guard link lands on Slop');
      assert.match(await pg.ev('location.search'), /[?&]tab=slop/);
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on a phone');
    } finally { await pg.close(); }
  } finally { await f.done(); }
});

// owner 11-24: every row says when it was first seen and how old it is, in the viewer's local days; a batch header gives its oldest row's
test('every row prints its first-seen day and age (local days), every batch header its oldest', () => {
  const local = (d, h) => new Date(2026, 2, d, h).getTime(), iso = ms => new Date(ms).toISOString();
  const now = local(10, 1);
  assert.equal(ageLine(iso(local(10, 0)), now), 'first seen 2026-03-10 · today');
  assert.equal(ageLine(iso(local(9, 23)), now), 'first seen 2026-03-09 · 1 d', 'two hours ago but yesterday on the viewer clock: 1 d');
  assert.equal(ageLine(iso(local(1, 12)), now), 'first seen 2026-03-01 · 9 d');
  assert.equal(ageLine(null, now), '', 'no store: no age');
  const rows = guardRows({ ins: insView() }).map((r, i) => ({ ...r, first_seen: iso(local(9 - (i % 3), 12)) }));
  const g = { ...guardView(rows), project: 'kestrel', pending: false, slop: true, voice: {}, errors: [] };
  const b = guardPart(g, 'fix').fix.batches.find(x => x.key === 'instr-c16|drafts');
  assert.equal(b.oldest, iso(local(7, 12)), 'the batch keeps its oldest first_seen, past the rows it shows');
  const html = renderTab('slop', { ...guardSummary(g), sub: 'fix', limit: 40, ...guardPart(g, 'fix'), parts_loading: false }, { project: 'kestrel' });
  assert.match(html, /class="gage">first seen \d{4}-\d\d-\d\d · (today|\d+ d)</, 'a row prints its age');
  assert.match(html, /class="gage">oldest: first seen \d{4}-\d\d-\d\d · (today|\d+ d)</, 'a batch prints its oldest');
  assert.equal((html.match(/<li class="grow/g) || []).length, (html.match(/<li class="grow[^]*?class="gage">first seen/g) || []).length, 'every row has one');
});
