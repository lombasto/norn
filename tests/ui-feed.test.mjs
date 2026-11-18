// Feed drawer UI (LANE-MAP-DESIGN 2, 4 slice 3): pure renderers for the drawer head / lines, the Agents rows that open it,
// and the shell wiring (one EventSource per open drawer on /api/feed; the drawer lives outside the 15 s re-render).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFeedHead, renderFeedEvent, loadTab, renderTab } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

const DASH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'dash');
const clean = (html, where) => assert.ok(!/undefined|NaN|\[object Object\]/.test(html.replace(/<[^>]*>/g, m => m.replace(/"[^"]*"/g, '""'))), `${where}: undefined / NaN in text`);
const NOW = Date.parse('2026-11-08T12:00:00Z');

test('drawer head: name, run id, lane, executor chip, state word, elapsed vs budget bar, context vs hand-off bar, last commit, marker', () => {
  const h = { run: 'RUN-7', name: 'calm-wombat', project: 'kestrel', lane: 'gen', executor: 'claude', model: 'claude-opus-5-5', effort: 'high', state: 'running',
    elapsed_min: 75, budget_min: 240, ctx: 96000, ctx_limit: 110000, commit: { sha: 'bafe528', subject: 'feat(dash): <feed>', age_min: 3 }, marker: 'HANDOFF' };
  const html = renderFeedHead(h, NOW);
  clean(html, 'head');
  for (const s of ['calm-wombat', 'RUN-7', 'gen', 'running', '1 h 15', '4 h 00', '96k', '110k', 'bafe528', 'feat(dash): &lt;feed&gt;', 'HANDOFF']) assert.ok(html.includes(s), s);
  assert.equal((html.match(/class="bar/g) || []).length, 2, 'two bars: time and context');
  const bare = renderFeedHead({ run: 'RUN-8', state: 'exited', outcome: 'done' }, NOW);
  clean(bare, 'bare head'); assert.match(bare, /RUN-8/); assert.match(bare, /DONE/);
});

test('drawer lines: one line per event, tool = name + summary, ids for the duration pairing, text escaped', () => {
  const t = renderFeedEvent({ ts: '2026-11-08T10:00:05.200Z', kind: 'tool', name: 'Bash', id: 'toolu_1', summary: 'cat <x> & y' });
  assert.match(t, /data-tid="toolu_1"/); assert.match(t, /Bash/); assert.match(t, /cat &lt;x&gt; &amp; y/); assert.match(t, /10:00:05/);
  const m = renderFeedEvent({ ts: null, kind: 'marker', summary: '## DONE' });
  assert.match(m, /k-marker/); clean(m, 'marker');
  for (const kind of ['text', 'step', 'error']) { const h = renderFeedEvent({ ts: null, kind, summary: kind + ' line' }); assert.match(h, new RegExp(`k-${kind}`)); clean(h, kind); }
});

test('Agents rows of runs open the feed (data-feed); subagents and talk sessions do not', async () => {
  const f = await fixture();
  try {
    const get = async p => (await f.get(p)).data;
    const html = renderTab('runs', await loadTab('runs', 'kestrel', get), { project: 'kestrel' });
    assert.match(html, /id="node-RUN-1"[^>]*data-feed="RUN-1"/); assert.match(html, /data-feed="RUN-2"/);
    assert.ok(!/data-feed="(?!RUN-)/.test(html), 'only runs');
  } finally { await f.done(); }
});

test('shell: the drawer sits outside #main, one EventSource on /api/feed, closed on end / close; follow toggle; Esc closes', () => {
  const html = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
  const main = html.indexOf('<main id="main">'), drawer = html.indexOf('id="feed"');
  assert.ok(drawer > 0 && !html.slice(main, html.indexOf('</main>', main)).includes('id="feed"'), 'not re-rendered by the 15 s tick');
  assert.match(html, /new EventSource\(`\/api\/feed\?/);
  assert.match(html, /addEventListener\('end'/); assert.match(html, /\.close\(\)/);
  assert.match(html, /id="feed-follow"/); assert.match(html, /Escape/);
  assert.ok(!/animation\s*:|transition\s*:|@keyframes/.test(html), 'no animation');
});
