// META-LIMIT-GATE R1: the usage-limit reset is read with its date (RUN-562: "try again at Nov 15th, 2026 5:01 PM" was recorded as
// tonight), and an executor out of quota is never dispatched: refused at start (exit 4) and skipped at queue fill until its reset.
// Temp dirs only; the fake executor stands in for every agent (a codex run is only ever refused, never launched).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startRun, queueRun, requeueRun, fillQueue, readiness, classifyLimit, RunRefused } from '../engine/lib/runs.mjs';
import { limitPatterns } from '../engine/lib/executors.mjs';
import { limitRefusal, openLimits, limitLines } from '../engine/lib/limitgate.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { renderHome } from '../engine/dash/home.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const RUN562 = 'ERROR: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 15th, 2026 5:01 PM.';
const NOV6 = 'ERROR: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 6th, 2026 3:08 PM.';
const RESET = '2026-11-15T23:01:00Z';
const BEFORE = Date.parse('2026-11-13T14:48:00Z'), AFTER = Date.parse('2026-11-15T23:05:00Z');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
function sandbox() {
  const t = mkTmp('meta-limitgate-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks']) fs.mkdirSync(d[k], { recursive: true });
  d.wt = n => { const w = path.join(t, 'wt' + n); fs.mkdirSync(w, { recursive: true }); return w; };
  d.brief = (body, name = 'brief.md') => { const f = path.join(t, name); fs.writeFileSync(f, body); return f; };
  d.item = id => loadState(d.state).items[id];
  d.opts = (o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt(1), notes: d.notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0 }, budget: { max_claude_workers: 1 }, tick: null, brief: d.brief('mode: done\n'), ...o });
  d.ended = id => waitFor(() => { const it = d.item(id); return settled(it) && it; });
  // an ended run of `executor` with outcome `outcome` (+ reset): the record the supervisor writes on a limit exit
  d.ended_as = (executor, outcome, reset) => {
    const s = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: executor === 'fake' ? 'fake' : 'codex', executor, lane: 'x' } });
    record(d.state, { kind: 'run', ev: 'end', id: s.id, by: 'launcher', data: { exit: 1, outcome, ...(outcome === 'limit' ? { reset, limit_line: 'try again at Nov 15th, 2026 5:01 PM' } : {}) } });
    return s.id;
  };
  return d;
}

// ---------- 1. the reset parser reads the date ----------
test('limit reset: a dated codex line keeps its date + year (RUN-562, the 11-06 line); local time in the machine zone', () => {
  const codex = limitPatterns('codex-sol'), now = new Date(2026, 10, 13, 8, 48, 0);
  assert.equal(classifyLimit(RUN562, codex, now).reset, new Date(2026, 10, 15, 17, 1, 0).toISOString(), 'not tonight: Nov 15th');
  assert.equal(classifyLimit(NOV6, codex, new Date(2026, 10, 4, 9, 0, 0)).reset, new Date(2026, 10, 6, 15, 8, 0).toISOString());
  // a clock-only line is unchanged: the next such time from now
  assert.equal(classifyLimit('You’ve hit your usage limit. try again at 6:14 PM.', codex, now).reset, new Date(2026, 10, 13, 18, 14, 0).toISOString());
});

test('limit reset: a claude "resets <date>, <time>" line keeps its date; no year = the next such date', () => {
  const claude = limitPatterns('claude'), now = new Date(2026, 10, 13, 8, 48, 0);
  assert.equal(classifyLimit("You've hit your limit · resets Nov 15, 5pm (Europe/Berlin)", claude, now).reset, new Date(2026, 10, 15, 17, 0, 0).toISOString());
  assert.equal(classifyLimit("You've hit your limit · resets Nov 15 at 5:30pm", claude, now).reset, new Date(2026, 10, 15, 17, 30, 0).toISOString());
  assert.equal(classifyLimit("You've hit your limit · resets Jan 2, 9am", claude, now).reset, new Date(2027, 0, 2, 9, 0, 0).toISOString(), 'past in this year = next year');
  assert.equal(classifyLimit("You've hit your limit · resets 3pm (Europe/Berlin)", claude, now).reset, new Date(2026, 10, 13, 15, 0, 0).toISOString());
});

// ---------- 2. the gate ----------
test('limit gate: a recorded future reset closes the executor family until then; a later good run or the reset opens it', () => {
  const d = sandbox();
  const run = d.ended_as('codex-sol', 'limit', RESET);
  const r = limitRefusal(d.state, { executor: 'codex-astra' }, { now: BEFORE });
  assert.match(r, /codex-astra out of quota until 2026-11-15T23:01:00Z/);
  assert.match(r, new RegExp(run));
  assert.match(r, /route .*open executor.*claude/, 'the refusal names the open executor (Claude when Codex is closed)');
  assert.doesNotMatch(r.split('open executor')[1], /codex/);
  assert.equal(limitRefusal(d.state, { executor: 'claude' }, { now: BEFORE }), null, 'another family stays open');
  assert.equal(limitRefusal(d.state, { executor: 'codex-sol' }, { now: AFTER }), null, 'open after the reset');
  assert.deepEqual(Object.keys(openLimits(d.state, { now: BEFORE })), ['codex']);
  assert.match(limitLines(d.state, { now: BEFORE }).join('\n'), /codex \(codex-sol, codex-astra\): out of quota until 2026-11-15T23:01:00Z/);
  assert.deepEqual(limitLines(d.state, { now: AFTER }), []);
  d.ended_as('codex-sol', 'done');
  assert.equal(limitRefusal(d.state, { executor: 'codex-sol' }, { now: BEFORE }), null, 'a later good run shows the quota is back');
  d.ended_as('codex-astra', 'limit', null);
  assert.equal(limitRefusal(d.state, { executor: 'codex-sol' }, { now: BEFORE }), null, 'an unread reset closes nothing (the re-queue waits 60 min)');
});

test('limit gate: a decision on lane limit-<family> opens the family before its reset (the quota came back early; no run can prove it)', () => {
  const d = sandbox();
  const at = s => ({ now: () => new Date(Date.parse('2026-11-13T10:00:00Z') + s * 1000) });   // records keep two seq counters: order = time
  const back = s => record(d.state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'limit-claude', question: 'quota back', choice: 'open', why: 'owner reset' } }, at(s));
  const endAt = (executor, s) => {
    const r = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: executor === 'claude' ? 'worker' : 'codex', executor, lane: 'x' } }, at(s));
    record(d.state, { kind: 'run', ev: 'end', id: r.id, by: 'launcher', data: { exit: 1, outcome: 'limit', reset: RESET, limit_line: 'resets Nov 15' } }, at(s));
  };
  back(0);   // BEFORE the limit: opens nothing that closes later
  endAt('claude', 10);
  assert.match(limitRefusal(d.state, { executor: 'claude' }, { now: BEFORE }) ?? '', /claude out of quota until/, 'an earlier decision does not open a later limit');
  endAt('codex-sol', 20);
  back(30);
  assert.equal(limitRefusal(d.state, { executor: 'claude' }, { now: BEFORE }), null, 'a later limit-claude decision opens claude');
  assert.deepEqual(Object.keys(openLimits(d.state, { now: BEFORE })), ['codex'], 'only its own family: codex stays closed');
  endAt('claude', 40);
  assert.match(limitRefusal(d.state, { executor: 'claude' }, { now: BEFORE }) ?? '', /claude out of quota until/, 'a new limit after the decision closes it again');
  assert.equal(openLimits(d.state, { now: BEFORE }).claude.at, undefined, 'the timestamp stays internal');
});

test('limit gate: a family stays closed 2 min past its reset (a launch on the dot can meet the old limit and read the NEXT day\'s reset)', () => {
  const d = sandbox();
  d.ended_as('codex-sol', 'limit', RESET);
  const r = Date.parse(RESET);
  assert.deepEqual(Object.keys(openLimits(d.state, { now: r + 60000 })), ['codex'], '1 min after the reset: still closed');
  assert.deepEqual(openLimits(d.state, { now: r + 121000 }), {}, 'past the 2 min grace: open');
});

// DEC-337: an early quota reset reopened claude, but two limit re-queues sat queued with
// not_before = the old reset + 2 min (11-18): a clock the reopen cannot move. The gate alone holds a limit re-queue now.
test('limit gate: a queued limit re-queue waits on the gate, not a clock - a limit-<family> decision releases it at once', () => {
  const d = sandbox();
  d.ended_as('fake', 'limit', RESET);
  const { run } = queueRun(d.opts());   // as the supervisor queues it now: no not_before when the reset was read
  const row = () => readiness(d.state, { now: BEFORE }).find(x => x.id === run);
  assert.equal(row().ready, false);
  assert.ok(row().terms.some(t => /^limit: fake out of quota/.test(t)), row().terms.join('; '));
  record(d.state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'limit-fake', question: 'quota back', choice: 'open', why: 'owner reset' } }, { now: () => new Date(Date.now() + 5000) });
  assert.equal(row().ready, true, row().terms.join('; '));
});

test('norn requeue: --not-before none clears a stale not_before (a limit re-queue made before the gate held it); an ISO sets one; omitted keeps it', () => {
  const d = sandbox();
  const stale = '2026-11-18T14:02:00.000Z';
  const q = queueRun(d.opts({ notBefore: stale })).run;
  const kept = requeueRun({ state: d.state, run: q, by: 'controller', why: 'DEC-337' }).next;
  assert.equal(d.item(kept).data.not_before, stale, 'omitted: kept');
  const cleared = requeueRun({ state: d.state, run: kept, by: 'controller', why: 'DEC-337', notBefore: null }).next;
  assert.equal(d.item(cleared).data.not_before, undefined, 'none: cleared');
  assert.ok(!readiness(d.state, { now: BEFORE }).find(x => x.id === cleared).terms.some(t => /not_before/.test(t)));
  const set = requeueRun({ state: d.state, run: cleared, by: 'controller', why: 'later', notBefore: '2026-11-16T09:00:00Z' }).next;
  assert.equal(d.item(set).data.not_before, '2026-11-16T09:00:00.000Z');
  assert.throws(() => requeueRun({ state: d.state, run: set, by: 'controller', why: 'x', notBefore: 'tomorrow' }), /--not-before/);
  assert.equal(d.item(set).state, 'queued', 'a refusal changes nothing');
});

test('limit gate: norn run refuses a closed executor (exit 4, names the reset) and accepts it after the reset (fake clock)', async () => {
  const d = sandbox();
  d.ended_as('fake', 'limit', RESET);
  assert.throws(() => startRun(d.opts({ now: BEFORE })), e => e instanceof RunRefused && e.code === 4 && /out of quota until 2026-11-15T23:01:00Z/.test(e.message));
  // the codex family closed too: refused before any launch (no Codex spent)
  d.ended_as('codex-sol', 'limit', RESET);
  assert.throws(() => startRun(d.opts({ executor: 'codex-sol', worktree: d.wt(2), now: BEFORE })), e => e.code === 4 && /open executor.*claude/.test(e.message));
  // --queue: the refusal queues the run instead
  const q = startRun(d.opts({ worktree: d.wt(3), queue: true, now: BEFORE, brief: d.brief('mode: done\n', 'q.md') }));
  assert.equal(q.queued, true);
  assert.match(q.why, /out of quota until/);
  // after the reset the queued run goes first (fair-slots item 4: a direct start never passes a ready run of its priority); the fill starts it
  assert.throws(() => startRun(d.opts({ now: AFTER })), e => e instanceof RunRefused && e.code === 4 && new RegExp(`go first: demo ${q.run} P2 #1`).test(e.message));
  const got = fillQueue(d.state, { now: AFTER });
  assert.deepEqual(got.map(x => x.queued), [q.run]);
  assert.equal((await d.ended(got[0].next)).end.outcome, 'done');
});

test('limit gate: queue fill skips a closed executor until its reset, then starts it', async () => {
  const d = sandbox();
  d.ended_as('fake', 'limit', RESET);
  const { run } = queueRun(d.opts());
  assert.deepEqual(fillQueue(d.state, { now: BEFORE }), []);
  const row = readiness(d.state, { now: BEFORE }).find(x => x.id === run);
  assert.equal(row.ready, false);
  assert.ok(row.terms.some(t => /^limit: fake out of quota until 2026-11-15T23:01:00Z/.test(t)), row.terms.join('; '));
  assert.equal(d.item(run).state, 'queued');
  const started = fillQueue(d.state, { now: AFTER });
  assert.equal(started.length, 1);
  assert.equal((await d.ended(started[0].next)).end.outcome, 'done');
});

test('limit gate: the dashboard home shows "out of quota until X"; nothing when every executor is open', () => {
  const d = sandbox();
  d.ended_as('codex-sol', 'limit', RESET);
  const side = { now: [], usage: {}, limits: limitLines(d.state, { now: BEFORE }) };
  const html = renderHome({ project: 'demo', events: [], status: {}, side }, { now: new Date(BEFORE) });
  assert.match(html, /Out of quota/);
  assert.match(html, /codex \(codex-sol, codex-astra\): out of quota until 2026-11-15T23:01:00Z/);
  assert.doesNotMatch(renderHome({ project: 'demo', events: [], status: {}, side: { ...side, limits: [] } }, { now: new Date(BEFORE) }), /Out of quota/);
});
