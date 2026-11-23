// Feed drawer UI (LANE-MAP-DESIGN 2, 4 slice 3): pure renderers for the drawer head / lines, the Agents rows that open it,
// and the shell wiring (one EventSource per open drawer on /api/feed; the drawer lives outside the 15 s re-render).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTab, loadParts, renderTab } from '../engine/dash/ui.mjs';
import { renderFeedHead, renderFeedEvent } from '../engine/dash/cells.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { dashCss } from './helpers/dash-css.mjs';

const DASH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'dash');
const clean = (html, where) => assert.ok(!/undefined|NaN|\[object Object\]/.test(html.replace(/<[^>]*>/g, m => m.replace(/"[^"]*"/g, '""'))), `${where}: undefined / NaN in text`);

test('drawer head: the dwarf, run id, lane, executor chip, state word, elapsed vs budget bar, context vs hand-off bar, last commit, marker', () => {
  const h = { run: 'RUN-7', dwarf: { id: 'oin', name: 'Óin' }, project: 'kestrel', lane: 'gen', executor: 'claude', model: 'claude-opus-5-5', effort: 'high', state: 'running',
    elapsed_min: 75, budget_min: 240, ctx: 96000, ctx_limit: 110000, commit: { sha: 'bafe528', subject: 'feat(dash): <feed>', age_min: 3 }, marker: 'HANDOFF' };
  const html = renderFeedHead(h);
  clean(html, 'head');
  assert.ok(html.includes('<b class="aname" data-dwarf="oin">Óin</b>'), 'the dwarf, by its display name');
  for (const s of ['RUN-7', 'gen', 'running', '1 h 15', '4 h 00', '96k', '110k', 'bafe528', 'feat(dash): &lt;feed&gt;', 'HANDOFF']) assert.ok(html.includes(s), s);
  assert.equal((html.match(/class="bar/g) || []).length, 2, 'two bars: time and context');
  const bare = renderFeedHead({ run: 'RUN-8', state: 'exited', outcome: 'done' });
  clean(bare, 'bare head'); assert.match(bare, /RUN-8/); assert.match(bare, /DONE/); assert.doesNotMatch(bare, /aname/, 'no dwarf: no name');
  assert.ok(renderFeedHead({ run: 'RUN-9', kind_word: 'check-in', state: 'running' }).includes('RUN-9</span> <span class="mute">check-in</span>'), 'no dwarf: the kind word');
});

test('drawer lines: one line per event, tool = name + summary, ids for the duration pairing, text escaped', () => {
  const t = renderFeedEvent({ ts: '2026-11-08T10:00:05.200Z', kind: 'tool', name: 'Bash', id: 'toolu_1', summary: 'cat <x> & y' });
  assert.match(t, /data-tid="toolu_1"/); assert.match(t, /Bash/); assert.match(t, /cat &lt;x&gt; &amp; y/); const d = new Date('2026-11-08T10:00:05.200Z'), p2 = n => String(n).padStart(2, '0'); assert.ok(t.includes(`${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`), 'the local time, as the feed formats it');
  const m = renderFeedEvent({ ts: null, kind: 'marker', summary: '## DONE' });
  assert.match(m, /k-marker/); clean(m, 'marker');
  for (const kind of ['text', 'step', 'error']) { const h = renderFeedEvent({ ts: null, kind, summary: kind + ' line' }); assert.match(h, new RegExp(`k-${kind}`)); clean(h, kind); }
});

test('Runs rows of runs open their drawer (run-open); subagents and talk sessions do not', async () => {
  const f = await fixture();
  try {
    const get = async p => (await f.get(p)).data;
    const d = await loadTab('runs', 'kestrel', get), html = renderTab('runs', { ...d, ...await loadParts('runs', 'kestrel', d, get), parts_loading: false }, { project: 'kestrel' });   // the live part + its history part (the ended RUN-1)
    assert.match(html, /id="node-RUN-1" data-act="run-open" data-run="RUN-1"/); assert.match(html, /data-act="run-open" data-run="RUN-2"/);
    assert.ok(!/data-act="run-open" data-run="(?!RUN-)/.test(html), 'only runs');
  } finally { await f.done(); }
});

test('shell: the feed is one section the module owns, mounted into the run document slot after each paint; one EventSource on /api/feed, closed on end; follow toggle', () => {
  const page = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8'), mod = fs.readFileSync(path.join(DASH, 'pages', 'runs-feed.mjs'), 'utf8'), html = page + mod + dashCss();
  assert.ok(mod.includes("box.id = 'run-feed'") && mod.includes('slot.replaceWith(box)') && !page.includes('id="feed"') && !page.includes('id="run-feed"'), 'the section lives outside the page markup: a re-render of #main never rebuilds it');
  assert.ok(page.includes('mountFeed()'), 'paintMain mounts it');
  assert.match(html, /new EventSource\(`\/api\/feed\?/);
  assert.match(html, /addEventListener\('end'/); assert.match(html, /\.close\(\)/);
  assert.match(html, /id="feed-follow"/);
  assert.ok(!/animation\s*:|transition\s*:|@keyframes/.test(html), 'no animation');
});
