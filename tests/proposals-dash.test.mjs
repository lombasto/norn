// RM-28 S1 + S2: the Inbox proposal card (and the Decisions section that batches every open one) - a planner DONE shows as ONE needs-you decision (its summary, the plan path, Queue now / Later /
// Drop per open stage); a tap = POST /api/proposal = `norn proposal rule` (a decision by dashboard + the act); a decided stage shows
// what it became and the card goes when none is open. On a phone (390 px) no sideways scroll and every button reachable. Sandbox
// only: pure renders, the shared dash fixture (temp dirs) and a private headless browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { proposalCard, decisionsSection } from '../engine/dash/ui.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';
import { stopRun } from '../engine/lib/runs.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { openPage, skipWhy } from './helpers/cdp.mjs';

const READY = '\nScope: engine/lib/**\nTests: tests/x.test.mjs\nDone: it works.\n';
const LONG = 'a-very-long-plan-file-name-that-would-push-a-narrow-screen-sideways-if-the-card-did-not-wrap-it.md';

/** a planner run that ended DONE in kestrel: notes/sizing (NOTES with a summary, the plan, brief-S1..S3), an item linking lane sizing */
function planner(f, lane = 'sizing') {
  const S = f.pa.state, dir = path.join(S, 'notes', lane), wt = path.join(f.root, `wt-${lane}`);
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(dir, 'NOTES.md'), `# sizing / plan\n\n## Summary for the owner (10 lines)\n\n${Array.from({ length: 10 }, (_, i) => `${i + 1}. finding number ${i + 1} with enough words to wrap on a phone screen`).join('\n')}\n\n## DONE\n`);
  fs.writeFileSync(path.join(dir, LONG), '# plan\n');
  for (const [k, t] of [['S1', 'record the marks'], ['S2', 'show the verdict on every page that lists runs'], ['S3', 'split lanes']]) fs.writeFileSync(path.join(dir, `brief-${k}.md`), `# ${lane} / ${k}:${t}\n${READY}`);
  const r = record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane, stage: 'plan', agent: 'planner', worktree: wt, brief: path.join(S, 'b.md'), notes: path.join(dir, 'NOTES.md') } });
  record(S, { kind: 'run', ev: 'end', id: r.id, by: 'launcher', data: { exit: 0, outcome: 'done' } });
  const th = record(S, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'theme', title: 'Engine' } }, { views: false });
  const it = record(S, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'item', title: lane, parent: th.id, horizon: 'now', links: [`lane:${lane}`] } }, { views: false });
  return { run: r.id, item: it.id, dir };
}
const props = async f => (await f.get('/api/inbox?project=kestrel')).data.items.filter(x => x.type === 'proposal');

test('proposalCard: the summary as a list, the plan, three buttons per open stage, a decided stage as its outcome; no item = Later disabled', () => {
  const i = { type: 'proposal', id: 'RUN-9', project: 'kestrel', lane: 'sizing', item: 'RM-2', title: 'Decide: sizing plan', summary: ['1. one', '2. two'], plans: ['C:/s/notes/sizing/PLAN.md'], open: 1, created: '2026-11-18T10:00:00Z',
    stages: [{ key: 'S1', title: 'record', brief: 'C:/s/notes/sizing/brief-S1.md', state: 'queue', dec: 'DEC-4', ref: 'RUN-10' }, { key: 'S2', title: 'show', brief: 'C:/s/notes/sizing/brief-S2.md', state: 'open' }] };
  const h = proposalCard(i, { now: Date.parse('2026-11-18T11:00:00Z') });
  assert.match(h, /<ol class="psum"><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(h, /Plan: <span class="mono ppath">C:\/s\/notes\/sizing\/PLAN.md<\/span>/);
  assert.equal((h.match(/data-act="proposal"/g) || []).length, 3, 'buttons only on the open stage');
  assert.match(h, /data-stage="S2" data-pick="queue">Queue now/); assert.match(h, /data-pick="later">Later/); assert.match(h, /data-pick="drop">Drop/);
  assert.match(h, /queued<\/span> <span class="mono">RUN-10<\/span> <span class="mute">\(DEC-4\)/);
  assert.match(h, /RUN-9 · RM-2 · 1 h 00 ago/);
  const n = proposalCard({ ...i, item: null }, { now: Date.parse('2026-11-18T11:00:00Z') });
  assert.match(n, /data-pick="later" disabled title="No roadmap item links this lane or run">Later/);
  assert.match(proposalCard({ ...i, summary: [] }, { now: 0 }), /no summary section/);
});

test('Inbox: a planner DONE = one needs-you proposal; each tap records a decision and acts; a decided stage is refused; 390 px', async t => {
  const f = await fixture();
  try {
    const before = (await f.get('/api/inbox?project=kestrel')).data.needs_you;
    const { run, item, dir } = planner(f);
    const [p, ...rest] = await props(f);
    assert.equal(rest.length, 0);
    assert.deepEqual([p.id, p.lane, p.item, p.title, p.summary.length, p.open], [run, 'sizing', item, 'Decide: sizing plan', 10, 3]);
    assert.equal((await f.get('/api/inbox?project=kestrel')).data.needs_you, before + 1, 'counted once in Needs you');

    if (skipWhy) t.diagnostic(`browser part skipped: ${skipWhy}`);
    else {
      const pg = await openPage([390, 844]);
      try {
        await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await pg.go(`${f.url}/?project=kestrel&tab=inbox`);
        assert.ok(await pg.until(`document.querySelector('#prop-${run} [data-pick=queue]')`, 60000), 'the card shows');
        assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on a phone');
        assert.ok(await pg.ev(`[...document.querySelectorAll('#prop-${run} [data-act=proposal]')].every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= 390 && r.width > 0; })`), 'every pick reachable');
        await pg.ev(`document.querySelector('#prop-${run}-S2 [data-pick=drop]').click()`);
        assert.ok(await pg.until(`/dropped/.test(document.querySelector('#prop-${run}-S2')?.textContent || '')`, 60000), 'the stage shows dropped after the tap');
        assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'still no sideways scroll');
      } finally { await pg.close(); }
    }
    if (skipWhy) assert.equal((await f.post('/api/proposal', { project: 'kestrel', run, stage: 'S2', pick: 'drop' })).status, 200);
    const drop = Object.values(loadState(f.pa.state).items).find(i => i.kind === 'decision' && i.data.proposal === run && i.data.stage === 'S2');
    assert.deepEqual([drop.by, drop.data.pick], ['dashboard', 'drop']);

    let r = await f.post('/api/proposal', { project: 'kestrel', run, stage: 'S2', pick: 'queue' });
    assert.equal(r.status, 409); assert.match(r.data.error, /decided already: drop/);
    r = await f.post('/api/proposal', { project: 'kestrel', run, stage: 'S1', pick: 'later' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const R = loadRoadmap(f.pa.state), later = Object.values(R.items).find(x => x.parent === item);
    assert.deepEqual([later.horizon, later.title], ['next', 'sizing S1: record the marks']);
    r = await f.post('/api/proposal', { project: 'kestrel', run, stage: 'S3', pick: 'queue' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const q = Object.values(loadState(f.pa.state).items).find(i => i.kind === 'run' && i.data.stage === 'S3');
    assert.equal(path.resolve(q.data.brief), path.resolve(dir, 'brief-S3.md'));
    assert.ok(loadRoadmap(f.pa.state).items[item].links.includes('run:' + q.id), 'queued with --item');
    assert.deepEqual(await props(f), [], 'no open stage left: the card is gone');
    assert.equal((await f.get('/api/inbox?project=kestrel')).data.needs_you, before);
    assert.equal((await f.post('/api/proposal', { project: 'kestrel', run, stage: 'S1', pick: 'maybe' })).status, 400);
    // a free slot may have started it (the fill): a live fake run must not hold the temp dir at teardown
    for (const x of Object.values(loadState(f.pa.state).items).filter(i => i.kind === 'run' && (i.id === q.id || i.data?.from_queue === q.id) && ['queued', 'running'].includes(i.state)))
      stopRun({ state: f.pa.state, run: x.id, by: 'owner', why: 'test end' });
  } finally { await f.done(); }
});

// RM-28 S2: Decisions - every open proposal in one Inbox section (a count, an index, the S1 cards and their buttons)
test('decisionsSection: nothing without a proposal; two proposals = one section with the totals, an index and both cards', () => {
  const st = (key, state = 'open') => ({ key, title: key, brief: `C:/s/brief-${key}.md`, state });
  const a = { type: 'proposal', id: 'RUN-9', project: 'kestrel', lane: 'sizing', item: 'RM-2', title: 'Decide: sizing plan', summary: ['1. one'], plans: [], open: 2, created: null, stages: [st('S1'), st('S2')] };
  const b = { ...a, id: 'RUN-12', lane: 'docs', title: 'Decide: docs plan', open: 1, stages: [st('S1', 'drop'), st('S2')] };
  const ctx = { now: 0 };
  assert.equal(decisionsSection([{ type: 'question', id: 'Q-1' }], ctx), '');
  const h = decisionsSection([{ type: 'question', id: 'Q-1' }, a, b], ctx);
  assert.match(h, /^<section id="inbox-decisions" class="decisions"><h2>Decisions <span class="mute small">2 proposals · 3 open stages/);
  assert.match(h, /<a href="#prop-RUN-9"><b>sizing<\/b> RUN-9 · 2 open stages<\/a><a href="#prop-RUN-12"><b>docs<\/b> RUN-12 · 1 open stage<\/a>/);
  assert.ok(h.includes(proposalCard(a, ctx)) && h.includes(proposalCard(b, ctx)), 'the S1 cards, unchanged');
  assert.equal((h.match(/data-act="proposal"/g) || []).length, 9);
  assert.doesNotMatch(decisionsSection([a], ctx), /pindex/, 'one proposal needs no index');
});

test('Inbox Decisions: two proposals ruled in one sitting on a phone (390 px); each tap is its own decision', async t => {
  const f = await fixture();
  try {
    const A = planner(f, 'sizing'), B = planner(f, 'docs');
    assert.deepEqual((await props(f)).map(p => p.lane).sort(), ['docs', 'sizing']);
    const pick = async (run, stage, p) => {
      if (skipWhy) return assert.equal((await f.post('/api/proposal', { project: 'kestrel', run, stage, pick: p })).status, 200);
      await pg.ev(`document.querySelector('#prop-${run}-${stage} [data-pick=${p}]').click()`);
      assert.ok(await pg.until(`/${p === 'drop' ? 'dropped' : 'later'}/.test(document.querySelector('#prop-${run}-${stage} .small')?.textContent || '')`, 60000), `${run} ${stage} shows ${p}`);
    };
    let pg = null;
    if (skipWhy) t.diagnostic(`browser part skipped: ${skipWhy}`);
    else {
      pg = await openPage([390, 844]);
      await pg.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await pg.go(`${f.url}/?project=kestrel&tab=inbox`);
      assert.ok(await pg.until(`document.querySelectorAll('#inbox-decisions .proposal').length === 2`, 60000), 'both cards in the one section');
      assert.match(await pg.ev(`document.querySelector('#inbox-decisions h2').textContent`), /2 proposals · 6 open stages/);
      assert.equal(await pg.ev(`document.querySelectorAll('#inbox-decisions .pindex a').length`), 2);
      assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'no sideways scroll on a phone');
      assert.ok(await pg.ev(`[...document.querySelectorAll('#inbox-decisions [data-act=proposal]')].every(b => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= 390 && r.width > 0; })`), 'every pick reachable');
    }
    try {
      await pick(A.run, 'S1', 'drop'); await pick(B.run, 'S2', 'later'); await pick(B.run, 'S3', 'drop');
      if (pg) {
        assert.match(await pg.ev(`document.querySelector('#inbox-decisions h2').textContent`), /2 proposals · 3 open stages/);
        assert.equal(await pg.ev('document.documentElement.scrollWidth'), 390, 'still no sideways scroll');
      }
    } finally { await pg?.close(); }
    const decs = Object.values(loadState(f.pa.state).items).filter(i => i.kind === 'decision' && i.data.proposal).map(i => `${i.data.proposal} ${i.data.stage} ${i.data.pick} ${i.by}`).sort();
    assert.deepEqual(decs, [`${A.run} S1 drop dashboard`, `${B.run} S2 later dashboard`, `${B.run} S3 drop dashboard`].sort());
    assert.equal(Object.values(loadRoadmap(f.pa.state).items).find(x => x.parent === B.item)?.title, 'docs S2: show the verdict on every page that lists runs');
  } finally { await f.done(); }
});
