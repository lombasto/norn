// Stage LANES (SPEC 4.2, Tests): the attention board as the page draws it - every group with its count (Old / Archived as links,
// Parked / Done today off until asked), "Needs you" = the lanes the Inbox's isNeed rows name, the run strip (no legend footer: titles and the ? popover), the PR
// track per step, no timer in the page module, nothing under engine/dash imports three.js, and in a private headless browser: 390 px
// with no sideways scroll and 44 px actions in both looks on both grounds. Synthetic rows and the shared dash fixture only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTab } from '../engine/dash/ui.mjs';
import { LANE_SHOW, LANE_SHOW_DEFAULT, strip, track } from '../engine/dash/pages/lanes.mjs';
import { isNeed } from '../engine/dash/terms.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const DASH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'dash');
const ALL = LANE_SHOW.map(g => g[0]);
const lane = (name, board, extra = {}) => ({ name, id: `L:${name}`, project: 'k', board, state: 'active', data: {}, run: `RUN-${name.length}`, run_state: 'exited', text: 'exited: DONE', ...extra });
const ROWS = [lane('ask', 'needs', { ask: 'Q-7', needs: 1 }), lane('go', 'running', { run_state: 'running', text: 'running claude for 5 min / budget 60', started: new Date(Date.now() - 3e5).toISOString(), budget_min: 60 }),
  lane('halt', 'stopped', { text: 'exited: STOPPED: red test' }), lane('wait', 'waiting', { run_state: 'queued', text: 'queued', waits: ['RUN-3'] }),
  lane('ship', 'land', { dlv: { step: 'pr', pr: 12, url: 'https://example.invalid/pr/12' } }), lane('rest', 'parked', { state: 'parked' }),
  lane('fresh', 'today'), lane('dusty', 'old'), lane('gone', 'archived', { state: 'archived' })];
const page = (show = ALL) => renderTab('lanes', { lanes: ROWS }, { project: 'k', now: Date.now(), laneShow: show });

test('every group from rows: its heading and count in page order; Old and Archived are links with counts; Parked and Done today start off', () => {
  const h = page();
  const heads = [...h.matchAll(/<h2 class="lgh" id="lg-(\w+)">([^<]+) <b>(\d+)<\/b>/g)].map(m => `${m[1]}:${m[2]}:${m[3]}`);
  assert.deepEqual(heads, LANE_SHOW.map(([k, w]) => `${k}:${w}:1`), 'one panel per group, in LANE_SHOW order');
  for (const k of ['old', 'archived']) assert.match(h, new RegExp(`<button class="lnk" data-act="lane-show" data-show="${k}" aria-pressed="true">[^<]+ <b>1</b>`), k);
  for (const k of ['needs', 'running', 'stopped', 'waiting', 'land', 'parked', 'today']) assert.match(h, new RegExp(`<button class="hf" data-act="lane-show" data-show="${k}"`), k);
  assert.deepEqual(LANE_SHOW_DEFAULT, ['needs', 'running', 'stopped', 'waiting', 'land'], 'Parked, Done today, Old and Archived are off by default');
  const d = page(LANE_SHOW_DEFAULT);
  for (const k of ['rest', 'fresh', 'dusty', 'gone']) assert.ok(!d.includes(`id="lane-${k}"`), `${k} is folded away by default`);
  assert.match(d, /data-show="parked" aria-pressed="false">Parked <b>1<\/b>/, 'a folded group still shows its count');
  assert.match(h, /aria-label="Filter lanes"/, 'the filter box is labelled (A-09)');
  assert.match(h, /<details class="lhelp"><summary aria-label="About this list">\?<\/summary>[^]*LANE records only/, 'the LANE-records note is in the ? popover');
  assert.match(h, /id="lane-wait"[^]*?<span class="waits small">waits for RUN-3<\/span>/, 'a waits-for chip');
  assert.match(h, /id="lane-ask"[^]*?<div class="rowacts"><button class="primary" data-tab="inbox">Answer<\/button>/, 'Needs you: Answer first, in the accent');
  assert.match(h, /id="lane-halt"[^]*?class="lnow small"[^>]*>Stopped: red test\.</, 'the now line in plain words');
  for (const r of h.split('<div class="rowacts">').slice(1, -1)) assert.ok((r.split('</div>')[0].match(/<(button|a) /g) ?? []).length <= 3, 'at most 3 actions');
});

test('Needs you = the lanes the Inbox\'s isNeed rows name; its count is never above the badge', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const lanes = (await f.get('/api/lanes?project=kestrel')).data.lanes, items = (await f.get('/api/inbox?project=kestrel')).data.items;
    const named = new Set(items.filter(isNeed).map(i => i.lane).filter(Boolean)), needs = lanes.filter(l => l.board === 'needs').map(l => l.name);
    assert.ok(needs.length > 0, 'the fixture has a lane that needs the owner');
    assert.deepEqual(needs.sort(), lanes.filter(l => named.has(l.name)).map(l => l.name).sort());
    assert.ok(needs.length <= items.filter(isNeed).length, 'never more than the badge');
    assert.match(renderTab('lanes', { lanes }, { project: 'kestrel', now: Date.now() }), new RegExp(`id="lg-needs">Needs you <b>${needs.length}</b>`));
  } finally { await f.done(); }
});

test('the run strip: oldest left, a hand-off bead joined, a fresh start apart, helpers on the running bead, "!" for an open question, "+n" older; no legend footer (owner 2026-11-20): the words are in the bead titles and the ? popover', () => {
  const l = { name: 'reef', ask: 'Q-9', runs_total: 5, runs: [{ id: 'RUN-1', cls: 'stopped', word: 'STOPPED', min: 3, cont: false, helpers: 0 },
    { id: 'RUN-2', cls: 'handoff', word: 'HANDOFF', min: 40, cont: false, helpers: 0 }, { id: 'RUN-3', cls: 'running', word: 'running', min: 12, cont: true, helpers: 2 }] };
  const s = strip(l), beads = [...s.matchAll(/<li class="bd t-(\w+)( cont)?( ask)?"/g)].map(m => m[1] + (m[2] ? '+' : '') + (m[3] ? '?' : ''));
  assert.deepEqual(beads, ['stopped', 'handoff', 'running+', 'needs?'], 'oldest left; only the resume joins; the question last');
  assert.match(s, /<li class="bmore small mute" title="2 older runs">\+2<\/li>/);
  assert.match(s, /RUN-3: running, 12 min, resumes the run before, 2 helpers<\/span>[^]*?<b class="hc">2<\/b>/, 'the helper count on the running bead, said in words too');
  assert.match(s, /^<ol class="lstrip" aria-label="Runs of reef, oldest first">/);
  assert.match(strip({ name: 'x', runs: [] }), /no runs/);
  const h = page(), help = h.slice(h.indexOf('class="lhelp'), h.indexOf('</details>', h.indexOf('class="lhelp')));
  assert.ok(!h.includes('class="llegend'), 'no legend footer');
  for (const w of ['hand-off', 'fresh start', 'open question', 'done → PR → merged (→ installed, for a project that installs)']) assert.ok(help.includes(w), `the ? popover: ${w}`);
});

test('the PR track: done -> PR -> merged (-> installed for an install target, c3d33977), the reached steps filled, the current one marked, the PR number linked', () => {
  ['done', 'pr', 'merged', 'installed'].forEach((step, k) => {
    const t = track({ step, install: true, pr: 7, url: 'https://example.invalid/pr/7' });
    assert.equal((t.match(/<i /g) ?? []).length, 4, `${step}: an install target has 4 pips`);
    assert.equal((t.match(/<i class="on/g) ?? []).length, k + 1, `${step}: ${k + 1} filled`);
    assert.equal((t.match(/ at"/g) ?? []).length, 1, `${step}: one current`);
    assert.match(t, new RegExp(`aria-label="PR track: ${['done', 'PR', 'merged', 'installed'][k]} \\(PR #7\\)"`));
    assert.match(t, /<a href="https:\/\/example\.invalid\/pr\/7" target="_blank" rel="noopener">#7<\/a>/);
  });
  const m = track({ step: 'merged', install: false, pr: 7, url: 'https://example.invalid/pr/7' });
  assert.equal((m.match(/<i /g) ?? []).length, 3, 'a main target ends at merged: no fourth pip');
  assert.equal((m.match(/<i class="on/g) ?? []).length, 3, 'merged fills the whole main track');
  assert.match(m, /title="done → PR → merged: merged"/);
  assert.match(track({ step: 'done', pr: null }), />done<\/span><\/span>$/, 'no PR yet: the step word');
  assert.equal(track(null), '<span class="ltrack none"></span>');
});

test('no timer in the Lanes page module (the elapsed bar is a CSS animation); nothing under engine/dash imports three.js', () => {
  for (const f of ['lanes.mjs', 'lanes-acts.mjs']) assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(fs.readFileSync(path.join(DASH, 'pages', f), 'utf8')), f);
  assert.match(page(), /<span class="ebar" role="img" aria-label="\d+ of 60 min"><i style="--from:[\d.]+%;--dur:\d+s"><\/i><\/span>/, 'the bar carries its start and its duration');
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const src = walk(DASH).filter(f => /\.(mjs|js|html)$/.test(f));
  for (const f of src) assert.ok(!/from\s+['"][^'"]*three[^'"]*['"]|import\(['"][^'"]*three/.test(fs.readFileSync(f, 'utf8')), `${path.relative(DASH, f)} imports three.js`);
  assert.ok(!walk(path.join(DASH, 'vendor')).some(f => /three/i.test(path.basename(f))), 'no three.js file is vendored');
});

test('the browser at 390 px: no sideways scroll and every row action at least 44 px tall, in both looks on both grounds', { skip: skipWhy, timeout: 240000 }, async () => {
  const f = await fixture(), pg = await openPage([390, 844]);
  try {
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    for (const look of ['classic', 'norn']) for (const theme of ['light', 'dark']) {
      await pg.go(`${f.url}/?project=kestrel&tab=lanes&look=${look}&theme=${theme}`);
      assert.ok(await pg.until(`document.body.dataset.ready === 'lanes' && !!document.querySelector('.lrow .rowacts button')`, 90000), `${look} ${theme}: rows`);
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, `${look} ${theme}: no sideways scroll`);
      const small = await pg.ev(`[...document.querySelectorAll('.lrow > .rowacts > *, .lrow > .lopen')].filter(b => b.getBoundingClientRect().height < 44).map(b => b.textContent.trim() || b.className)`);
      assert.deepEqual(small, [], `${look} ${theme}: 44 px actions`);
    }
  } finally { await pg.close(); await f.done(); }
});
