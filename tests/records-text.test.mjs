// The Records page (UI redesign 2026-11-20): each text cell (directive text, decision question / choice / why) is structured by
// ledger.mjs recordMarkdown (owner prefix in italics, quoted owner words as a quote, "(1) .. (2) .." as a list, top-level "; "
// clauses as lines) and rendered by the one prose renderer (ids / paths / `code` inline, a long text clamps behind "more").
// Directives / Decisions are filter chips; state, age and lane filter; each row carries its weight and opens its drawer. Synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordMarkdown } from '../engine/dash/ledger.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { recView, renderRecord } from '../engine/dash/pages/ledger.mjs';
process.env.TZ = 'UTC';   // the dash prints local time (cells.mjs fmtTime): pin the zone these expectations are written in

const NOW = Date.parse('2026-01-20T05:00Z');
const W = (o = {}) => ({ cited: { records: 1, runs: 2, notes: 3, ledger: 0, total: 6 }, by: { runs: ['RUN-4'], lanes: ['alpha'], records: ['DEC-2'], notes: ['state/notes/x/NOTES.md'] },
  edits: 1, supersedes: [], superseded_by: null, conflicts: [], age_days: 19, stood_days: 19, violations: [], ...o });
const rec = (id, kind, state, data, o = {}) => ({ id, kind, state, data, by: 'controller', created: '2026-01-01T03:04Z', history: [{ seq: 1, ts: '2026-01-01T03:04Z', ev: 'create', by: 'owner' }], weight: W(), ...o });

test('recordMarkdown: meta / quote / head + clause lines / list, as markdown for the prose renderer', () => {
  const m = recordMarkdown("Owner 01-02 ~03:04Z: 'yes' -> DIR-4 at 53a3f65; why: because; (1) DEC-5 (2) see docs/plan.md");
  assert.equal(m, '*Owner 01-02 ~03:04Z*\n\n> yes\n\n-> DIR-4 at 53a3f65\n**why** because\n\n1. DEC-5\n2. see docs/plan.md');
  assert.equal(recordMarkdown('plain words'), 'plain words');
});

test('XSS: hostile directive text and decision fields render escaped in the Records tab and its drawer', () => {
  const bad = `Owner 01-02 (<img src=x onerror=alert(1)>): '<script>alert(2)</script>' -> <b>x</b>; (1) <i>y</i> (2) \`</code><svg>\``;
  const d = { project: 'demo', directives: [rec('DIR-1', 'directive', 'active', { text: bad, via: '<em>chat</em>' })],
    decisions: [rec('DEC-1', 'decision', 'in-force', { question: bad, choice: bad, why: bad, lane: '<s>l</s>', source: '<a>' }, { by: 'controller<u>' })] };
  const html = renderTab('records', d, { project: 'demo', now: NOW }) + renderRecord(d.decisions[0], d, { now: NOW });
  assert.ok(!/<(?:img|script|svg|u|s|i)[ >]|<em>chat/i.test(html), html);   // prose itself writes <em> / <strong>
  assert.match(html, /&lt;img src=x/); assert.match(html, /<code>&lt;\/code&gt;&lt;svg&gt;<\/code>/);
});

test('Records: one chip row Directives / Decisions, state / age / lane filters, prose text that clamps, a weight per row', () => {
  const long = 'Owner 01-02 ~03:04Z: ' + Array.from({ length: 12 }, (_, i) => `clause ${i} with some words to make it long enough`).join('; ');
  const d = { project: 'demo', directives: [rec('DIR-7', 'directive', 'active', { text: long, via: 'chat' }), rec('DIR-8', 'directive', 'done', { text: 'short one', via: 'chat' }, { weight: W({ age_days: 2, stood_days: 1 }) })],
    decisions: [rec('DEC-9', 'decision', 'in-force', { question: 'Q text; with arrow', choice: 'pick (1) a (2) b', why: 'because DIR-7', lane: 'alpha' }, { weight: W({ conflicts: [{ id: 'owner', why: 'overruled' }], violations: [{ source: 'scope hook', run: 'RUN-3', why: 'DEC-9 says no' }] }) })] };
  const html = renderTab('records', d, { project: 'demo', now: NOW });
  const row = id => html.match(new RegExp(`<tr id="rec-${id}"[\\s\\S]*?</tr>`))[0];
  assert.match(html, /class="fchips" role="group" aria-label="Show"><button class="hf" data-act="rec-kind" data-show="directive" aria-pressed="true">Directives <b>2<\/b><\/button><button class="hf" data-act="rec-kind" data-show="decision" aria-pressed="true">Decisions <b>1<\/b>/);
  assert.match(html, /data-act="rec-state" data-show="force" aria-pressed="true">In force <b>2<\/b>/); assert.match(html, /data-act="rec-state" data-show="ended" aria-pressed="true">Ended <b>1<\/b>/);
  assert.match(html, /data-act="rec-age" data-show="7"/); assert.match(html, /data-act="rec-lane" data-show="alpha"/); assert.match(html, /data-act="rec-sort" data-show="cited"/);
  assert.match(row('DIR-7'), /class="prose pclamp" data-key="rec:DIR-7"/); assert.match(row('DIR-7'), /data-act="prose-more"/);
  assert.ok(row('DIR-7').includes('clause 11 with some words'), 'the full text stays in the DOM, so the search filter matches it');
  assert.ok(!row('DIR-8').includes('pclamp'), 'short text has no expander');
  assert.match(row('DIR-7'), /data-act="rec-open" data-id="DIR-7"/); assert.match(row('DIR-7'), /cited <b>6<\/b> · 1 edit · stood 19 d/);
  assert.match(row('DIR-7'), /data-act="revoke"/); assert.match(row('DEC-9'), /data-act="overrule"/); assert.doesNotMatch(row('DIR-8'), /data-act="revoke"/);
  assert.match(row('DEC-9'), /1 conflict/); assert.match(row('DEC-9'), /1 violation recorded/);
  assert.match(row('DEC-9'), /<strong>choice<\/strong> pick/); assert.match(row('DEC-9'), /<ol>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ol>/); assert.match(row('DEC-9'), /data-rid="DIR-7"/);
  assert.doesNotMatch(html, /\d+ decisions · \d+ directives/, 'no counter row: the counts live on the chips');
  // the filters
  const only = v => renderTab('records', d, { project: 'demo', now: NOW, recView: { ...recView, ...v } });
  assert.doesNotMatch(only({ kinds: new Set(['decision']) }), /id="rec-DIR-7"/, 'Directives off hides them');
  const forced = only({ states: new Set(['force']) }); assert.match(forced, /id="rec-DIR-7"/); assert.doesNotMatch(forced, /id="rec-DIR-8"/);
  const young = only({ age: '7' }); assert.match(young, /id="rec-DIR-8"/); assert.doesNotMatch(young, /id="rec-DIR-7"/);
  const lane = only({ lane: 'alpha' }); assert.match(lane, /id="rec-DEC-9"/); assert.doesNotMatch(lane, /id="rec-DIR-7"/);
});

test('the record drawer: the numbers, who cites it (links where each lives), the conflicts, violations as recorded, history', () => {
  const r = rec('DIR-3', 'directive', 'superseded', { text: 'do x', via: 'chat' }, { weight: W({ supersedes: ['DIR-1'], superseded_by: 'DIR-5', conflicts: [{ id: 'DIR-2', why: 'possible duplicate: same words' }] }) });
  const h = renderRecord(r, { project: 'demo' }, { now: NOW });
  assert.match(h, /cited<\/dt><dd>6 <span class="mute">\(records 1 · runs 2 · notes 3 · ledger lines 0\)/);
  for (const id of ['RUN-4', 'L:alpha', 'DEC-2', 'DIR-1', 'DIR-5', 'DIR-2']) assert.match(h, new RegExp(`data-rid="${id}"`), id);
  assert.match(h, /state\/notes\/x\/NOTES\.md/); assert.match(h, /none recorded/); assert.match(h, /create by owner/);
  assert.match(renderRecord(null, {}, {}), /not found/);
});
