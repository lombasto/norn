// OVERVIEW-TRUTH (owner report 2026-11-19): the Overview, Lanes and run counts said what their sources do not. Fixtures for each fix:
// (2) every 'why not merged' reason, rendered; (3) the one done-not-merged count; (5) the Lanes page (withdrawn, shipped, lost);
// (6) run counts (bookkeeping apart, hand-off chains as one piece, unfinished with cost) and the withdraw why. Pure folds + temp state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { whyNotMerged, stoppedLine } from '../engine/lib/dlvwhy.mjs';
import { mergeBacklog } from '../engine/lib/deliverables.mjs';
import { deliverablesCard, renderDeliverable } from '../engine/dash/ui.mjs';
import { lanesView } from '../engine/lib/lanes.mjs';
import { laneHooks } from '../engine/lib/lifecycle.mjs';
import { runCounts, countsLine, withdrawClass } from '../engine/lib/runcount.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { stopRun } from '../engine/lib/runs.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

test.after(cleanTmp);
const NOW = Date.parse('2026-11-19T18:00:00Z'), T = h => new Date(NOW + h * 3600e3).toISOString();
const run = (n, o = {}) => { const { lane = 'a', stage = null, state = 'exited', outcome = 'done', h = -5, ev = [], data = {}, end = {}, ...rest } = o;
  return { id: `RUN-${n}`, kind: 'run', state, data: { lane, stage, ...data }, ...(state === 'exited' ? { end: { outcome, ...end } } : {}),
    history: [{ ev: 'start', ts: T(h) }, ...ev], created: T(h), updated: T(h + 1), ...rest }; };
const lane = (name, o = {}) => ({ id: `L:${name}`, kind: 'lane', state: 'active', data: {}, history: [{ ev: 'create', ts: T(-30) }], created: T(-30), updated: T(-30), ...o });
const items = (...xs) => Object.fromEntries(xs.map(x => [x.id, x]));
const row = (o = {}) => ({ id: 'DLV-21', project: 'solve-shack', record_state: 'open', state: 'done', target: 'install', at_target: false, repo: 'C:/r', branch: 'norn/a',
  lane: 'a', delivers: 'the thing', done_utc: T(-10), days: 0.4, behind: 2, ahead: 3, native: false, pr: null, ...o });

// ---------- (2) why a DONE deliverable is not merged ----------
test('why not merged: each reason from a fixture, in words with its link, rendered on the card and the drawer', () => {
  const notes = path.join(mkTmp('ot-notes-'), 'MERGE-NOTES.md');
  fs.writeFileSync(notes, '# merge\n\nran the suite\n\nSTOPPED: main moved; conflict in engine/lib/x.mjs needs a design call\n');
  const cases = [
    ['pr', row({ pr: { url: 'https://github.com/o/r/pull/15', number: 15 } }), {}, 'PR #15 open, awaiting approval'],
    ['queued', row(), { items: items(lane('a'), run(9, { stage: 'MERGE', state: 'queued', h: -1 })), queue: [{ id: 'RUN-9', position: 2 }] }, 'merge queued as RUN-9 (#2)'],
    ['stopped', row(), { items: items(lane('a'), run(235, { stage: 'MERGE', outcome: 'stopped', h: -2, data: { notes } })), readNotes: x => fs.readFileSync(x, 'utf8') },
      'merge stopped by RUN-235: main moved; conflict in engine/lib/x.mjs needs a design call'],
    ['build', row(), { items: items(lane('a'), run(7, { state: 'running', h: -1 })) }, 'waits for build RUN-7 on the same lane'],
    ['outside', row({ id: 'DLV-25', branch: 'feat/solve-shack-unattended-reconnect', lane: null }), {}, 'not a Norn lane: branch made outside Norn - land it by hand, or adopt it'],
    ['none', row(), { items: items(lane('a'), run(5, { h: -11 })) }, 'no merge queued'],
  ];
  for (const [kind, r, o, text] of cases) {
    const w = whyNotMerged(r, o);
    assert.equal(w.kind, kind); assert.equal(w.text, text, kind);
    const html = deliverablesCard({ rows: [{ ...r, why_not: w }] }, { project: 'solve-shack' });
    assert.ok(html.includes(`data-why="${kind}"`), kind);
    assert.ok(html.includes(text.replace(/&/g, '&amp;')), `${kind} renders its words`);
    if (w.run) assert.match(html, new RegExp(`data-feed="${w.run}"`), `${kind} links its run to the live feed`);
    assert.equal(/class="small dlvwhy"[^>]*><span class="chip warn/.test(html), w.warn, `${kind}: warn chip only for a stop / nothing queued / outside`);
  }
  assert.match(renderDeliverable({ ...row(), why_not: cases[0][3] && whyNotMerged(cases[0][1]) }), /not merged[\s\S]*PR #15 open, awaiting approval[\s\S]*href="https:\/\/github.com\/o\/r\/pull\/15"/);
  // an older stopped merge before the latest DONE is no reason; a merged / parked / superseded row has none
  assert.equal(whyNotMerged(row(), { items: items(lane('a'), run(3, { stage: 'MERGE', outcome: 'stopped', h: -20 })) }).kind, 'none');
  for (const r of [row({ state: 'merged' }), row({ record_state: 'parked' }), row({ superseded: { by: 'DLV-3' } })]) assert.equal(whyNotMerged(r, {}), null);
  assert.equal(stoppedLine('- STOPPED - red gate'), 'red gate');
});

// ---------- (3) one done-not-merged count, shared with the merge backlog ----------
test('the card heading counts done-not-merged by mergeBacklog: same N and oldest as the Lanes and Plan line', () => {
  const rows = [row({ id: 'DLV-1', done_utc: T(-13) }), row({ id: 'DLV-2', done_utc: T(-2) }), row({ id: 'DLV-3', pr: { url: 'u', number: 4 } }), row({ id: 'DLV-4', state: 'merged' })];
  const b = mergeBacklog(rows, { now: NOW, max: 3 });
  assert.equal(b.text, 'done, not merged: 2 (oldest 13h)');
  const html = deliverablesCard({ rows, backlog: b }, {});
  assert.match(html, /id="dlv-counts"[^]*done, not merged: 2 \(oldest 13h\)[^]*1 with a PR open[^]*1 merged, not installed/);
});

// ---------- (5) the Lanes page ----------
test('Lanes: a withdrawn run says why; bookkeeping never stands for the lane; an old lost behind a DONE does not colour it; a newest lost does', () => {
  const wd = run(12, { stage: 'MERGE', state: 'withdrawn', h: -1, withdraw: { why: 'landed by hand: PR #33' }, ev: [{ ev: 'withdraw', ts: T(-1), data: { why: 'landed by hand: PR #33' } }] });
  const st = { items: items(lane('rt'), run(10, { lane: 'rt', state: 'lost', h: -9 }), run(11, { lane: 'rt', h: -6 }), { ...wd, data: { ...wd.data, lane: 'rt' } },
    lane('lo'), run(20, { lane: 'lo', h: -9 }), run(21, { lane: 'lo', state: 'lost', h: -4 }),
    lane('only'), { ...wd, id: 'RUN-30', data: { lane: 'only', stage: 'MERGE' } }) };
  const v = Object.fromEntries(lanesView(st, { now: NOW, all: true }).map(l => [l.name, l]));
  assert.equal(v.rt.run, 'RUN-11', 'the DONE is the newest meaningful run');
  const said = l => `${l.status.state}: ${l.status.why}`;   // RM-21 S1: laneState
  assert.equal(said(v.rt), 'idle: RUN-11 done; nothing follows · then RUN-12 withdrawn: landed by hand: PR #33'); assert.equal(v.rt.group, 'done');
  assert.equal(said(v.lo), 'stopped: not responding', 'a lost run that is the newest meaningful run shows'); assert.equal(v.lo.group, 'needs');
  assert.equal(said(v.only), 'stopped: withdrawn: landed by hand: PR #33', 'never "ended with no result"');
});

test('Lanes: a lane whose work is on main is shipped and leaves the active list, whatever its last run says (laneHooks from the records)', () => {
  const state = mkTmp('ot-state-');
  const at = h => () => new Date(NOW + h * 3600e3);
  const mk = (lane, h) => record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: 'C:/r', branch: `norn/${lane}`, lane, tip: 'abc1234', delivers: lane } }, { views: false, now: at(h) });
  const d1 = mk('inbox-replies', -8), d2 = mk('rm9', -8); mk('open', -8);
  record(state, { kind: 'deliverable', ev: 'merged', id: d1.id, by: 'checkin', data: { how: 'pr', pr: 34, url: 'u' } }, { views: false, now: at(-2) });
  record(state, { kind: 'deliverable', ev: 'merged', id: d2.id, by: 'checkin', data: { how: 'ruling', q: 'Q-1', why: 'w' } }, { views: false, now: at(-2) });
  const st = { items: items(lane('inbox-replies'), run(1, { lane: 'inbox-replies', state: 'lost', h: -3 }), lane('rm9'), run(2, { lane: 'rm9', outcome: 'no-result', h: -3 }),
    lane('open'), run(3, { lane: 'open', state: 'lost', h: -3 }), lane('busy'), run(4, { lane: 'busy', state: 'running', h: -1 })) };
  const h = laneHooks(state);
  const v = Object.fromEntries(lanesView(st, { now: NOW, ...h }).map(l => [l.name, l]));
  const said = l => `${l.status.state}: ${l.status.why}`;   // RM-21 S1: laneState
  assert.equal(said(v['inbox-replies']), `shipped: ${d1.id} PR #34`); assert.equal(v['inbox-replies'].group, 'done');
  assert.equal(said(v.rm9), `shipped: ${d2.id} ruled merged`); assert.equal(v.rm9.group, 'done');
  assert.equal(said(v.open), 'stopped: not responding', 'its deliverable is not merged: still needs a look'); assert.equal(v.open.group, 'needs');
  assert.equal(v.busy.status.state, 'running', 'a live run still shows');
});

// ---------- (6) run counts and the withdraw why ----------
test('run counts: queue bookkeeping apart, a hand-off chain is one piece of work, unfinished = stopped + lost + crash + no-result with cost', () => {
  const rs = [run(1, { outcome: 'handoff', end: { cost_usd: 2 } }), run(2, { data: { resume_of: 'RUN-1' }, outcome: 'handoff', end: { cost_usd: 1 } }), run(3, { data: { resume_of: 'RUN-2' }, end: { cost_usd: 1 } }),
    run(4, { outcome: 'stopped', end: { cost_usd: 1.5 } }), run(5, { state: 'lost' }), run(6, { outcome: 'crash', end: { cost_usd: 0.25 } }), run(7, { outcome: 'no-result' }), run(8, { state: 'running' }),
    run(9, { state: 'withdrawn', withdraw: {} }), run(10, { state: 'withdrawn', withdraw: { why: 'landed by hand: PR #12' } }), run(11, { state: 'withdrawn', withdraw: { why: 'owner bump to P0', next: 'RUN-12' } }),
    run(13, { state: 'withdrawn', withdraw: { why: 'priority P0 by the owner' } }), run(14, { state: 'filled', fill: { next: 'RUN-4' } })];
  const c = runCounts(rs);
  assert.equal(c.runs, 8, 'withdrawn and filled are not runs');
  assert.deepEqual(c.work, { pieces: 6, sessions: 8, chained: 1 });
  assert.equal(c.unfinished.n, 4); assert.equal(c.unfinished.usd, 1.75);
  assert.deepEqual(Object.fromEntries(Object.entries(c.unfinished.by).map(([k, x]) => [k, x.n])), { stopped: 1, lost: 1, crash: 1, 'no-result': 1 });
  assert.deepEqual(c.bookkeeping, { withdrawn: 4, filled: 1, why: { 'no reason recorded': 1, 'landed another way': 1, 're-queued': 1, 'priority / hold': 1 } });
  assert.equal(countsLine(c), '8 runs as 6 pieces of work (1 continued by hand-off) · unfinished 4 ($1.75: 1 stopped, 1 lost, 1 crash, 1 no-result) · queue bookkeeping, not runs: 4 withdrawn before start (1 no reason recorded, 1 landed another way, 1 re-queued, 1 priority / hold), 1 filled');
  assert.equal(withdrawClass({ history: [{ ev: 'withdraw', data: { why: 'mergeq lands DLV-3 mechanically' } }] }), 'landed another way');
});

test('every run withdraw records its why: a bare withdraw is refused; norn stop with no --why names the caller and the command', () => {
  const state = mkTmp('ot-wd-');
  const q = () => record(state, { kind: 'run', ev: 'queue', by: 'launcher', data: { lane: 'a', kind: 'fake', executor: 'fake', brief: 'b', worktree: 'w' } }, { views: false });
  const a = q(), b = q();
  assert.throws(() => record(state, { kind: 'run', ev: 'withdraw', id: a.id, by: 'owner', data: {} }, { views: false }), /why/);
  stopRun({ state, locksDir: mkTmp('ot-locks-'), run: b.id, by: 'owner' });
  const it = loadState(state).items[b.id];
  assert.equal(it.state, 'withdrawn'); assert.equal(it.withdraw.why, `no reason given: owner ran norn stop ${b.id}`);
});
