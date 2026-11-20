// RECORDS-TEXT R1: the Records tab text cells (directive text, decision question / choice / why) get the Ledger treatment -
// owner prefix as a muted meta line, quoted owner words as a quote, "(1) .. (2) .." as a list, top-level "; " clauses as lines,
// "->" as an arrow, ids / shas / paths / `code` inline; long text clamps behind a "more" button. Synthetic strings only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecordText, recordBlocks } from '../engine/dash/ledger.mjs';
import { renderTab } from '../engine/dash/ui.mjs';

test('recordBlocks: meta / quote / head / clause lines / list, ids + shas + paths + code + arrows, a line estimate', () => {
  const { html, lines } = recordBlocks("Owner 01-02 ~03:04Z: 'yes' -> DIR-4 at 53a3f65 in state/x/PAUSED and `a<b`; (1) DEC-5 (2) see docs/plan.md", { cpl: 60 });
  assert.match(html, /^<div class="rmeta">Owner 01-02 ~03:04Z<\/div><blockquote class="rquote">yes<\/blockquote><div class="ledhead">/);
  assert.match(html, /<span class="arr">→<\/span> <a class="rid r-dir" href="#rec-DIR-4" data-rid="DIR-4">DIR-4<\/a>/);
  assert.match(html, /<span class="sha">53a3f65<\/span>/); assert.match(html, /<span class="path">state\/x\/PAUSED<\/span>/);
  assert.match(html, /<code>a&lt;b<\/code>/);
  assert.match(html, /<ol class="rlist"><li><a class="rid r-dec"[^>]*>DEC-5<\/a><\/li><li>see <span class="path">docs\/plan.md<\/span><\/li><\/ol>$/);
  assert.ok(lines >= 5, `meta + quote + head + 2 items, got ${lines}`);
  assert.ok(!/class="path">(?:and\/or|a\/b)</.test(recordBlocks('and/or a/b').html), 'a single short slash pair is no path');
  assert.ok(!recordBlocks('x -> y').html.includes('-&gt;'));
});

test('XSS: hostile directive text and decision fields render escaped in the Records tab', () => {
  const bad = `Owner 01-02 (<img src=x onerror=alert(1)>): '<script>alert(2)</script>' -> <b>x</b>; (1) <i>y</i> (2) \`</code><svg>\``;
  const rec = (id, kind, state, data) => ({ id, kind, state, data, by: 'controller<u>', created: '2026-01-02T03:04Z', history: [] });
  const d = { project: 'demo', directives: [rec('DIR-1', 'DIR', 'active', { text: bad, via: '<em>chat</em>' })],
    decisions: [rec('DEC-1', 'DEC', 'in-force', { question: bad, choice: bad, why: bad, lane: '<s>l</s>', source: '<a>' })] };
  const html = renderTab('records', d, { project: 'demo', now: Date.parse('2026-01-02T05:00Z') });
  assert.ok(!/<(?:img|script|b|i|svg|em|u|s)[ >]/i.test(html.replace(/<b class="aname" data-dwarf="[a-z0-9-]*">/g, '')), html);
  assert.match(html, /&lt;img src=x/); assert.match(html, /<code>&lt;\/code&gt;&lt;svg&gt;<\/code>/);
});

test('Records tab: every text cell uses the formatter; long text clamps behind a keyboard "more" button with the full text in the DOM', () => {
  const long = 'Owner 01-02 ~03:04Z: ' + Array.from({ length: 12 }, (_, i) => `clause ${i} with some words to make it long enough`).join('; ');
  const rec = (id, state, data) => ({ id, state, data, by: 'controller', created: '2026-01-01T03:04Z', history: [] });
  const d = { project: 'demo', directives: [rec('DIR-7', 'active', { text: long, via: 'chat' }), rec('DIR-8', 'done', { text: 'short one', via: 'chat' })],
    decisions: [rec('DEC-9', 'in-force', { question: 'Q text; with -> arrow', choice: 'pick (1) a (2) b', why: 'because DIR-7', lane: 'l' })] };
  const html = renderTab('records', d, { project: 'demo', now: Date.parse('2026-01-02T05:00Z') });
  const row = id => html.match(new RegExp(`<tr id="rec-${id}"[\\s\\S]*?</tr>`))[0];
  assert.match(row('DIR-7'), /<div class="rtext rclamp" data-key="DIR-7:text">/);
  assert.match(row('DIR-7'), /<button type="button" class="ghost rmore" data-act="rec-more" aria-expanded="false">more<\/button>/);
  assert.ok(row('DIR-7').includes('clause 11 with some words'), 'the full text stays in the DOM, so the search filter matches it');
  assert.ok(!row('DIR-8').includes('rmore'), 'short text has no expander');
  assert.match(row('DIR-7'), /<td class="id rnw">DIR-7<\/td>/); assert.match(row('DIR-7'), /<td class="small mute rnw">01-01 03:04Z · chat<\/td>/);
  assert.match(row('DEC-9'), /<td class="rt" data-label="question"><div class="rtext" data-key="DEC-9:q"><div class="ledhead">Q text<\/div><div class="ledsub">with <span class="arr">→<\/span> arrow<\/div>/);
  assert.match(row('DEC-9'), /<ol class="rlist"><li>a<\/li><li>b<\/li><\/ol><div class="rwhy small mute"><div class="ledhead">because <a class="rid r-dir"/);
  assert.match(html, /<table class="rectab" data-rows="records">/);
});
