// LEDGER-UX R1: the Ledger tab parses each ledger line into an entry (kind, label, ts, headline + labelled sub-lines) and renders
// it in the Records look; record ids link, shas / `code` are recognised, everything is escaped. Synthetic lines only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLedgerLine, splitClauses, ledgerInline, parseLedger } from '../engine/dash/ledger.mjs';
import { shownRunIds } from '../engine/lib/agents.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
process.env.TZ = 'UTC';   // the dash prints local time (cells.mjs fmtTime): pin the zone these expectations are written in

test('ledgerInline: ids link (records rows / inbox / agents only when shown / deliverables), shas + code, all escaped', () => {
  const h = ledgerInline('DEC-3 DIR-4 Q-5 RUN-6 RUN-7 DLV-8 EP-9 at 53a3f65 and `x<y>`', { runs: new Set(['RUN-6']), project: 'demo' });
  assert.match(h, /<a class="rid r-dec" href="#rec-DEC-3" data-rid="DEC-3">DEC-3<\/a>/);
  assert.match(h, /<a class="rid r-dir" href="#rec-DIR-4" data-rid="DIR-4">DIR-4<\/a>/);
  assert.match(h, /<a class="rid r-q" href="#q-Q-5" data-rid="Q-5">Q-5<\/a>/);
  assert.match(h, /<a class="rid r-run" href="#node-RUN-6" data-rid="RUN-6">RUN-6<\/a>/);
  assert.match(h, /<span class="id">RUN-7<\/span>/, 'a run the Runs page does not show stays plain mono');
  assert.match(h, /data-dlv="DLV-8"/); assert.match(h, /<span class="id">EP-9<\/span>/);
  assert.match(h, /<span class="sha">53a3f65<\/span>/); assert.match(h, /<code>x&lt;y&gt;<\/code>/);
  assert.ok(!/<span class="sha">(?:1234567|abcdefa)</.test(ledgerInline('1234567 abcdefa')), 'all-digit / all-letter words are no sha');
});

test('XSS: a hostile ledger line renders escaped in the Ledger tab and the Overview card', () => {
  const bad = '- meta 2026-01-02T03:04Z: <img src=x onerror=alert(1)> "q" \'s\'; dispatched: <script>alert(2)</script>; `</code><b>`';
  const d = { file: 'L.md', ledger: [bad, '<script>alert(3)</script>', '# <i>h</i>'], total: 3, count: 100, offset: 0, more: false, runs: [] };
  const html = renderTab('ledger', d, { project: 'demo', now: Date.parse('2026-01-02T05:00Z') });
  assert.ok(!/<img|<script|<i>|<b>(?!dispatched)/i.test(html), html); assert.match(html, /<code>&lt;\/code&gt;&lt;b&gt;<\/code>/);
  assert.match(html, /&lt;img src=x/); assert.match(html, /&lt;script&gt;alert\(3\)/);
});

test('the Ledger tab: newest first, one row per entry, time + kind chip, search + kind filter, show older', () => {
  const now = Date.parse('2026-01-02T05:00Z');
  const lines = ['# Ledger', '- meta 2026-01-01T22:20Z: older RUN-1 entry; rate 1 %/h', '- auto 2026-01-02T02:14Z: lane z HANDOFF', '- meta 2026-01-02T03:00Z minor: quiet'];
  const html = renderTab('ledger', { file: 'L.md', ledger: lines, total: 120, count: 100, offset: 0, more: true, runs: [] }, { project: 'demo', now });
  const rows = [...html.matchAll(/<tr id="led-(\d+)" data-state="([\w-]+)"/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(rows.map(r => r[1]), ['minor', 'auto', 'check-in', 'other'], 'newest first, kind in data-state');
  assert.match(html, />03:00</); assert.match(html, />02:14</); assert.match(html, />01-01 22:20</);
  assert.match(html, /<span class="chip [^"]*">check-in<\/span>/); assert.match(html, /<span class="chip [^"]*">auto<\/span>/);
  assert.match(html, /data-filter="ledger"/); assert.match(html, /data-filter-state="ledger"/); assert.match(html, /data-rows="ledger"/);
  assert.match(html, /data-act="ledger-more"/, 'more lines exist: a show-older button');
  assert.match(html, /class="ledsub"><b>rate<\/b>/);
  assert.match(html, /<h1[^>]*>Ledger<\/h1>/, 'a heading line falls back to markdown');
  const none = renderTab('ledger', { file: 'L.md', ledger: lines, total: 4, count: 100, offset: 0, more: false, runs: [] }, { project: 'demo', now });
  assert.ok(!none.includes('data-act="ledger-more"'));
});

test('shownRunIds = the runs the Agents tree lists (live, or ended within 2 h; never queue entries)', () => {
  // an ended run carries its end event: the window counts from the run's own end, not its last record (7f2927b)
  const now = Date.parse('2026-01-02T05:00Z'), r = (id, state, updated) => ({ kind: 'run', id, state, updated, created: updated, data: {}, history: state === 'exited' ? [{ ev: 'end', ts: updated }] : [] });
  const ids = shownRunIds([r('RUN-1', 'running', '2026-01-01T00:00Z'), r('RUN-2', 'exited', '2026-01-02T04:00Z'), r('RUN-3', 'exited', '2026-01-02T01:00Z'), r('RUN-4', 'queued', '2026-01-02T04:59Z')], now);
  assert.deepEqual([...ids].sort(), ['RUN-1', 'RUN-2']);
});

test('/api/ledger: default 100 lines, count + offset page older lines, total / more, runs the Runs page shows', async () => {
  const f = await fixture();
  try {
    const all = (await f.get('/api/ledger')).data;
    assert.equal(all.ledger.length, 30); assert.equal(all.total, 30); assert.equal(all.more, false); assert.ok(Array.isArray(all.runs));
    const pg = (await f.get('/api/ledger?count=10&offset=5')).data;
    assert.deepEqual([pg.ledger[0], pg.ledger.at(-1)], ['p16', 'p25']); assert.equal(pg.more, true); assert.equal(pg.count, 10); assert.equal(pg.offset, 5);
    assert.equal((await f.get('/api/ledger?count=99999')).data.count, 2000, 'count is capped');
  } finally { await f.done(); }
});
