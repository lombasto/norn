// RM-18 S2 + stage NAV: the status strip of the three Norns (server stripOf -> /api/strip .strip): Urd landed today + last landed,
// Verdandi running + parked, Skuld open questions + queued + next check-in; the rendered strip links running to Runs, needs to Inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/dash-fixture.mjs';
import { record } from '../engine/lib/records.mjs';
import { renderStatus } from '../engine/dash/shell.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';
import { mkTmp } from './helpers/tmp.mjs';

test('the strip counts landed, running, parked, questions, queued and times the next check-in', async () => {
  const f = await fixture();
  try {
    const S = f.pa.state, s0 = (await f.get('/api/strip?project=kestrel')).data.strip;   // the fixture's own parked lane + question
    assert.equal(s0.landed_today, 0); assert.equal(s0.last_landed, null); assert.equal(s0.checkin.next, null, 'no check-in yet: no next time');
    const m = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'gen', stage: 'MERGE' } });
    record(S, { kind: 'run', ev: 'end', id: m.id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
    record(S, { kind: 'lane', ev: 'park', id: 'L:seabed', by: 'controller', data: { why: 'waits on the owner' } });
    record(S, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'render', not_before: '2099-01-01T00:00:00Z' } });
    const ck = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin' } });
    const ov = (await f.get('/api/strip?project=kestrel')).data, s = ov.strip;
    assert.equal(s.landed_today, 1, 'the MERGE run that ended done landed today');
    assert.equal(s.last_landed.run, m.id); assert.equal(s.last_landed.lane, 'gen'); assert.equal(s.last_landed.project, 'kestrel');
    const ln = (await f.get('/api/lanes?project=kestrel')).data.lanes;
    assert.equal(s.running, ln.filter(l => l.status.state === 'running').length, 'Verdandi counts the running lanes Lanes lists');
    assert.equal(s.parked, s0.parked + 1); assert.equal(s.questions, s0.questions); assert.equal(s.queued, s0.queued + 1);
    const every = s.checkin.every_min;
    assert.ok(Number.isFinite(every), 'the cadence comes from the policy');
    const start = ck.ts;   // the start event's own time
    assert.equal(s.checkin.next, new Date(Date.parse(start) + every * 60000).toISOString(), 'next check-in = last check-in start + cadence');
    const h = renderStatus(ov, { look: 'norn', project: 'kestrel', now: Date.parse(ov.now) });
    for (const [tone, tab] of [['verd', 'runs'], ['skuld', 'inbox']])
      assert.match(h, new RegExp(`<span class="np tone-${tone}"><b>[A-Za-z]+</b><span><a href="\\?project=kestrel&amp;tab=${tab}" data-tab="${tab}"`), `${tone} links to ${tab}`);
  } finally { await f.done(); }
});

// the strip in a real browser: both looks x both grounds at phone width (390 px, no sideways scroll, every part on screen and
// keyboard reachable), a tap opens its page; screenshots of each + one at desktop width go to a temp dir (named in the diagnostics)
test('the status strip fits a phone in both looks and grounds, and each link is reachable', async t => {
  if (skipWhy) { t.diagnostic(`browser part skipped: ${skipWhy}`); return; }
  const f = await fixture(), shots = mkTmp('meta-strip-shots-');
  const shot = async (pg, name) => { const r = await pg.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64')); t.diagnostic(`screenshot ${path.join(shots, name)}`); };
  try {
    for (const look of ['norn', 'classic']) for (const theme of ['dark', 'light']) {
      const pg = await openPage([390, 844]);
      try {
        await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await pg.go(`${f.url}/?project=kestrel&tab=lanes&look=${look}&theme=${theme}`);
        assert.ok(await pg.until(`document.querySelector('#status-strip a')`, 60000), `${look}/${theme}: the strip shows`);
        assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, `${look}/${theme}: no sideways scroll on a phone`);
        assert.equal(await pg.ev(`document.querySelectorAll('#status-strip a[href]').length`), 2, 'two real links: running -> Runs, need you -> Inbox');
        assert.ok(await pg.ev(`[...document.querySelectorAll('#status-strip a')].every(a => { const r = a.getBoundingClientRect(); return r.left >= 0 && r.right <= 390 && r.width > 0 && r.height > 0; })`), `${look}/${theme}: every part on screen`);
        assert.ok(await pg.ev(`[...document.querySelectorAll('#status-strip a')].every(a => { a.focus(); return document.activeElement === a; })`), 'every part takes keyboard focus');
        await shot(pg, `strip-${look}-${theme}-390.png`);
        if (look === 'norn' && theme === 'dark') {
          await pg.ev(`document.querySelector('#status-strip a[data-tab=inbox]').click()`);
          assert.ok(await pg.until(`new URLSearchParams(location.search).get('tab') === 'inbox'`, 30000), 'the needs-you count opens Inbox');
        }
      } finally { await pg.close(); }
    }
    const pg = await openPage([1440, 900]);
    try {
      await pg.go(`${f.url}/?project=kestrel&tab=lanes&look=norn&theme=dark`);
      assert.ok(await pg.until(`document.querySelector('#status-strip a')`, 60000));
      await shot(pg, 'strip-norn-dark-1440.png');
    } finally { await pg.close(); }
  } finally { await f.done(); }
});
