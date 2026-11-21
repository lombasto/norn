// LEDGER-UX R1: the Ledger tab parses each ledger line into an entry (kind, label, ts, headline + labelled sub-lines) and renders
// it through the one prose renderer (prose.mjs: record ids link, shas / `code` are recognised, everything is escaped), one chip per
// kind (UI redesign 2026-11-20). Synthetic lines only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLedgerLine, splitClauses, parseLedger } from '../engine/dash/ledger.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { ledgerView } from '../engine/dash/pages/ledger.mjs';
import { LEDGER_KINDS } from '../engine/dash/ledger.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

test('the Ledger text goes through the prose renderer: ids are chips, code stays code, all escaped', () => {
  const html = renderTab('ledger', { file: 'L.md', ledger: ['- meta 2026-01-02T03:04Z: DEC-3 and DIR-4 ruled Q-5 for RUN-6; dispatched: `x<y>`'], total: 1, count: 100, offset: 0, more: false }, { project: 'demo', now: Date.parse('2026-01-02T05:00Z') });
  for (const id of ['DEC-3', 'DIR-4', 'Q-5', 'RUN-6']) assert.match(html, new RegExp(`data-rid="${id}"`), id);
  assert.match(html, /<code>x&lt;y&gt;<\/code>/);
  assert.match(html, /class="prose pinline"/, 'the headline and sub-lines are inline prose');
});

test('XSS: a hostile ledger line renders escaped in the Ledger tab', () => {
  const bad = '- meta 2026-01-02T03:04Z: <img src=x onerror=alert(1)> "q" \'s\'; dispatched: <script>alert(2)</script>; `</code><b>`';
  const d = { file: 'L.md', ledger: [bad, '<script>alert(3)</script>', '# <i>h</i>'], total: 3, count: 100, offset: 0, more: false };
  const html = renderTab('ledger', d, { project: 'demo', now: Date.parse('2026-01-02T05:00Z') });
  assert.ok(!/<img|<script|<i>/i.test(html), html); assert.match(html, /<code>&lt;\/code&gt;&lt;b&gt;<\/code>/);
  assert.match(html, /&lt;img src=x/); assert.match(html, /&lt;script&gt;alert\(3\)/);
});

test('the Ledger tab: newest first, one row per entry, time + kind chip, a filter chip per kind, search, show older', () => {
  const now = Date.parse('2026-01-02T05:00Z');
  const lines = ['# Ledger', '- meta 2026-01-01T22:20Z: older RUN-1 entry; rate 1 %/h', '- auto 2026-01-02T02:14Z: lane z HANDOFF', '- meta 2026-01-02T03:00Z minor: quiet'];
  const d = { file: 'L.md', ledger: lines, total: 120, count: 100, offset: 0, more: true };
  const html = renderTab('ledger', d, { project: 'demo', now });
  const rows = [...html.matchAll(/<tr id="led-(\d+)" data-state="([\w-]+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(rows.map(r => r[1]), ['minor', 'auto', 'check-in', 'other'], 'newest first, kind in data-state');
  assert.match(html, /03:00Z/); assert.match(html, /02:14Z/); assert.match(html, /01-01 22:20Z/);
  assert.match(html, /<span class="chip [^"]*">check-in<\/span>/); assert.match(html, /<span class="chip [^"]*">auto<\/span>/);
  assert.match(html, /class="fchips"[^>]*aria-label="Kinds"/, 'the kinds are one filter-chip row');
  assert.match(html, /data-act="ledger-kind" data-show="check-in" aria-pressed="true">check-in <b>1<\/b>/);
  assert.match(html, /data-filter="ledger"/); assert.match(html, /data-rows="ledger"/); assert.doesNotMatch(html, /data-filter-state="ledger"/);
  assert.match(html, /data-act="ledger-more"/, 'more lines exist: a show-older button');
  assert.match(html, /class="ledsub"><b>rate<\/b>/);
  assert.match(html, /class="ph"><b>Ledger<\/b>/, 'a heading line renders through prose');
  const off = renderTab('ledger', d, { project: 'demo', now, ledgerView: { kinds: new Set(['auto']) } });
  assert.deepEqual([...off.matchAll(/data-state="([\w-]+)"/g)].map(m => m[1]), ['auto'], 'a chip turned off hides its kind');
  assert.equal(ledgerView.kinds.size, LEDGER_KINDS.length, 'every kind shows by default');
  const none = renderTab('ledger', { ...d, total: 4, more: false }, { project: 'demo', now });
  assert.ok(!none.includes('data-act="ledger-more"'));
});

test('parseLedger keeps the entry shapes (the Talk thread reads them too)', () => {
  const e = parseLedgerLine('- meta 2026-01-02T03:04Z minor: a; rate 1 %/h; records: none new');
  assert.equal(e.kind, 'minor'); assert.equal(e.headline, 'a'); assert.deepEqual(e.subs, [{ label: 'rate', text: '1 %/h' }, { label: 'records', text: 'none new' }]);
  assert.deepEqual(splitClauses('a (b; c); d'), ['a (b; c)', 'd']);
  assert.equal(parseLedger(['', '- auto 2026-01-02T03:04Z: x']).length, 1);
});

test('/api/ledger: default 100 lines, count + offset page older lines, total / more, the prose keys', async () => {
  const f = await fixture();
  try {
    const all = (await f.get('/api/ledger')).data;
    assert.equal(all.ledger.length, 30); assert.equal(all.total, 30); assert.equal(all.more, false); assert.ok(Array.isArray(all.prose.lanes));
    const pg = (await f.get('/api/ledger?count=10&offset=5')).data;
    assert.deepEqual([pg.ledger[0], pg.ledger.at(-1)], ['p16', 'p25']); assert.equal(pg.more, true); assert.equal(pg.count, 10); assert.equal(pg.offset, 5);
    assert.equal((await f.get('/api/ledger?count=99999')).data.count, 2000, 'count is capped');
  } finally { await f.done(); }
});
