// UX review 4: one count per thing. The needs-you count in the status strip (/api/strip), the Inbox page, the Inbox badge, the page
// title, the Talk filter and the project picker come from ONE function (engine/dash/terms.mjs needsYou) and agree on the fixture state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/dash-fixture.mjs';
import { renderTab, needsCount, pageTitle } from '../engine/dash/ui.mjs';
import { renderBar } from '../engine/dash/shell.mjs';
import { renderHome } from '../engine/dash/home.mjs';
import { isNeed, needsYou } from '../engine/dash/terms.mjs';

test('terms.mjs: a resolved question and an enforce card already asked for are listed in the Inbox but do not need you; every other row does', () => {
  const items = [{ type: 'question' }, { type: 'resolved' }, { type: 'enforce', asked: { id: 'DIR-1' } }, { type: 'enforce' }, { type: 'fixresult' }, { type: 'login' }, { type: 'setup' }];
  assert.equal(needsYou(items), 5); assert.equal(needsYou(null), 0); assert.equal(isNeed(null), false);
});

test('the needs-you count: status strip = Inbox page = Inbox badge = page title = Talk filter = project picker, per project and for all', async () => {
  const f = await fixture();
  try {
    for (const project of ['kestrel', 'all']) {
      const q = `project=${project}`;
      const ov = (await f.get(`/api/strip?${q}`)).data, ib = (await f.get(`/api/inbox?${q}`)).data;
      const n = needsYou(ib.items), qs = ib.items.filter(i => i.type === 'question').length;
      assert.ok(n > 0, `${project}: the fixture has an open question`);
      assert.equal(ov.needs_you, n, `${project}: the strip = Inbox rows that need you`);
      assert.equal(ib.needs_you, n, `${project}: /api/inbox says the same count`);
      const ctx = { project, now: Date.parse(ov.now) };
      // the Inbox page counts on its chips (Questions, Cards): its questions all need you
      assert.match(renderTab('inbox', ib, ctx), new RegExp(`id="inbox-needs"[^]*?Questions <b>${qs}</b>`), `${project}: Inbox page head`);
      // index.html: S.needs = needsCount(the strip) feeds the badge and the title
      assert.match(renderBar('talk', { project, needs: needsCount(ov) }), new RegExp(`id="tab-inbox"[^]*?Inbox</span><span class="count" aria-label="${n} need you">${n}</span>`), `${project}: tab badge`);
      assert.match(pageTitle(needsCount(ov), project), new RegExp(`^\\(${n}\\) `), `${project}: page title`);
      if (project === 'all') continue;
      const home = (await f.get(`/api/home?${q}`)).data;
      assert.equal(home.needs_you, n, 'Talk = the same count');
      assert.match(renderHome(home, { project }), new RegExp(`id="home-needs">${n}</b>`), 'the Talk "needs you" filter');
      const picker = (await f.get('/api/projects')).data.projects.find(p => p.name === project);
      assert.equal(picker.needs, n, 'the project picker');
    }
  } finally { await f.done(); }
});

test('a failing Inbox is an error in the project picker, never "nothing needs you"', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.pa.state, 'adopt.jsonl'), '{not json\n');
    const r = await f.get('/api/projects');
    assert.equal(r.status, 500, JSON.stringify(r.data));
    assert.match(r.data.error, /adopt\.jsonl/);
  } finally { await f.done(); }
});
