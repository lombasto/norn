// Norn vocabulary as display labels (META-VISUAL-B S3; CONCEPTS "Urd what was, Verdandi what is, Skuld what shall be"): the title /
// header say Norn, the status strip names the three Norns in the norn look (RM-18 S2, stage NAV). The bar and the More sheet are plain
// words in both looks: no Norn name in them, and label = tab id = URL for every page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS } from '../engine/dash/ui.mjs';
import { BAR, MORE, COG, renderBar, renderMore, renderCog, renderStatus } from '../engine/dash/shell.mjs';
import { TABS as SERVER_TABS } from '../engine/dash/server.mjs';

test('the Norn look: no Norn name in the bar or More; the three Norns on the status strip, Verdandi and Skuld linking to Runs and Inbox; every page its own link, its label the word of its id', () => {
  for (const [k, label] of TABS) {
    const nav = renderBar(k, { project: 'x', needs: 3 }) + renderMore(k, { project: 'x' }) + renderCog(k, { project: 'x' });
    for (const n of ['Verdandi', 'Urd', 'Skuld', 'Wyrd']) assert.ok(!nav.includes(`>${n}<`), `no ${n} in the bar (${k})`);
    assert.match(nav, k === COG ? new RegExp(`data-tab="${k}"[^>]*aria-label="${label}" aria-current="page"`) : new RegExp(`data-tab="${k}"[^>]*aria-current="page"[^>]*>(?:<svg[^]*?</svg><span class="bl">)?${label}<`), k);   // the cog: its label is its aria-label
    assert.equal(label.toLowerCase(), k, `${k}: label, id and URL are one word`);
  }
  assert.deepEqual(TABS.map(t => t[0]), SERVER_TABS);
  assert.deepEqual([...BAR.map(b => b[0]), ...MORE.flatMap(([, ids]) => ids), COG], SERVER_TABS, 'the bar + More + the cog order is the page order');
  const s = { now: '2026-11-17T00:00:00Z', needs_you: 1, running: { claude: { n: 1, cap: 1 }, codex: { n: 0, cap: 0 } }, usage: { weeklyUsed: 40, weeklyStopPct: 95 },
    strip: { landed_today: 2, parked: 0, queued: 3 }, checkin: { every_min: 30, next: '2026-11-17T00:30:00Z' } };
  const h = renderStatus(s, { look: 'norn', project: 'x', now: Date.parse(s.now) });
  for (const [tone, name] of [['urd', 'Urd'], ['verd', 'Verdandi'], ['skuld', 'Skuld']]) assert.ok(h.includes(`<span class="np tone-${tone}"><b>${name}</b>`), name);
  assert.match(h, /tone-verd[^]*href="\?project=x&amp;tab=runs"/); assert.match(h, /tone-skuld[^]*href="\?project=x&amp;tab=inbox"/);
  for (const t of ['2 landed today', '1 running', '0 parked', '1</b> need you', '3 queued', 'next check-in']) assert.ok(h.includes(t), t);
});
