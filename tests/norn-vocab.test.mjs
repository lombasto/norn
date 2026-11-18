// Norn vocabulary as display labels (META-VISUAL-B S3; CONCEPTS "Urd what was, Verdandi what is, Skuld what shall be"): the title /
// header say Norn, the Overview strip names the three Norns (RM-18 S2), the picked art sits where the asset map says. The bar is the plain
// NAV in both looks (UX review 2): no Norn name in it, and label = tab id = URL for every page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TABS, NAV, renderNav, renderTab } from '../engine/dash/ui.mjs';
import { TABS as SERVER_TABS } from '../engine/dash/server.mjs';

test('the Norn look: no Norn name in the bar; the three Norns on the Overview strip, each a link to its destination; every page its own button, its label the word of its id', () => {
  for (const [k, label] of TABS) {
    const nav = renderNav(k, { inbox: 3 });
    for (const n of ['Verdandi', 'Urd', 'Skuld', 'Wyrd']) assert.ok(!nav.includes(`>${n}<`), `no ${n} in the bar (${k})`);
    assert.match(nav, new RegExp(`id="tab-${k}" data-tab="${k}" aria-selected="true"[^>]*>${label}<`), k);
    assert.equal(label.toLowerCase(), k, `${k}: label, id and URL are one word`);
  }
  assert.deepEqual(TABS.map(t => t[0]), SERVER_TABS);
  assert.deepEqual(NAV.flatMap(([g, , ids]) => [g, ...ids]), SERVER_TABS, 'the bar order is the page order');
  const ov = { now: '2026-11-17T00:00:00Z', projects: ['x'], needs_you: 0, needs: [], running: { claude: { n: 0, cap: 1 }, codex: { n: 0, cap: 0 }, lanes: [] },
    burn: { usage: { source: 'none' }, top: [] }, paused: false,
    strip: { landed_today: 2, last_landed: { run: 'RUN-9', lane: 'rm18', project: 'x', ts: '2026-11-16T22:00:00Z' }, running: 1, parked: 0, questions: 1, queued: 3, checkin: { every_min: 30, next: '2026-11-17T00:30:00Z' } } };
  const h = renderTab('overview', { overview: ov, agents: { tree: [] } }, { project: 'x', now: Date.parse(ov.now), look: 'norn', art: n => `<i data-art="${n}"></i>` });
  assert.ok(!h.includes('class="hero"'), 'no hero');
  for (const [tone, tab, name] of [['urd', 'history', 'Urd'], ['verd', 'work', 'Verdandi'], ['skuld', 'inbox', 'Skuld']])
    assert.ok(h.includes(`<a class="np tone-${tone}" id="strip-${tone}" href="?project=x&amp;tab=${tab}" data-tab="${tab}"><b>${name}</b>`), name);
  for (const t of ['2 landed today', 'last rm18', '1 running', '0 parked', '1 open question', '3 queued', 'next check-in 00:30Z']) assert.ok(h.includes(t), t);
});
