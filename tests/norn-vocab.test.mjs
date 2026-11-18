// Norn vocabulary as display labels (META-VISUAL-B S3; CONCEPTS "Urd what was, Verdandi what is, Skuld what shall be"): the title /
// header say Norn, the Overview hero carries the Norns' lore lines, the picked art sits where the asset map says. The bar is the plain
// NAV in both looks (UX review 2): no Norn name in it, and label = tab id = URL for every page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS, NAV, NORN_LORE, renderNav, renderTab } from '../engine/dash/ui.mjs';
import { TABS as SERVER_TABS } from '../engine/dash/server.mjs';

test('the Norn look: no Norn name in the bar; the lore on the Overview hero; every page its own button, its label the word of its id', () => {
  assert.deepEqual(Object.keys(NORN_LORE), ['verdandi', 'urd', 'skuld', 'wyrd']);
  for (const [k, label] of TABS) {
    const nav = renderNav(k, { inbox: 3 });
    for (const n of ['Verdandi', 'Urd', 'Skuld', 'Wyrd']) assert.ok(!nav.includes(`>${n}<`), `no ${n} in the bar (${k})`);
    assert.match(nav, new RegExp(`id="tab-${k}" data-tab="${k}" aria-selected="true"[^>]*>${label}<`), k);
    assert.equal(label.toLowerCase(), k, `${k}: label, id and URL are one word`);
  }
  assert.deepEqual(TABS.map(t => t[0]), SERVER_TABS);
  assert.deepEqual(NAV.flatMap(([g, , ids]) => [g, ...ids]), SERVER_TABS, 'the bar order is the page order');
  const ov = { now: '2026-11-17T00:00:00Z', projects: ['x'], needs_you: 0, needs: [], running: { claude: { n: 0, cap: 1 }, codex: { n: 0, cap: 0 }, lanes: [] },
    burn: { usage: { source: 'none' }, top: [] } };
  const h = renderTab('overview', { overview: ov, agents: { tree: [] } }, { project: 'x', look: 'norn', art: n => `<i data-art="${n}"></i>` });
  for (const l of Object.values(NORN_LORE)) assert.ok(h.includes(l), 'lore line on the hero');
});
