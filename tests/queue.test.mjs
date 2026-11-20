// META-GT12: auto-fill queue under the cap (norn run --queue, fill on exit / status, withdraw) + usage-limit exits
// (outcome `limit`, re-queued after the reset). Temp dirs only; the fake executor stands in for claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRun, stopRun, queueRun, fillQueue, queueOf, classifyLimit, lockPath, readiness } from '../engine/lib/runs.mjs';
import { buildPlan } from '../engine/lib/plan.mjs';
import { limitPatterns, LIMIT_PATTERNS } from '../engine/lib/executors.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { agentsTree } from '../engine/lib/agents.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { tick } from '../engine/lib/tick.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const t0 = performance.now();   // monotonic: a wall-clock step (the WSL runner's ~16 s) never expires the deadline early
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
function sandbox() {
  const t = mkTmp('meta-queue-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks']) fs.mkdirSync(d[k], { recursive: true });
  d.wt = n => { const w = path.join(t, 'wt' + n); fs.mkdirSync(w, { recursive: true }); return w; };
  d.brief = (body, name = 'brief.md') => { const f = path.join(t, name); fs.writeFileSync(f, body); return f; };
  d.runs = () => Object.values(loadState(d.state).items).filter(i => i.kind === 'run');
  d.item = id => loadState(d.state).items[id];
  // GAP-2: a queued run reads its budget FILE at fill (no copy is kept): each launch writes the budget it is given to a file of its own
  let nb = 0;
  d.opts = (o = {}) => {
    const budget = o.budget ?? { max_claude_workers: 1 }, budget_file = o.budget_file ?? path.join(t, `budget-${++nb}.json`);
    if (!o.budget_file) fs.writeFileSync(budget_file, JSON.stringify(budget));
    return { state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt(1), notes: d.notes, hbMs: 150, staleMs: 3000,
      policy: { auto_resume_max: 0 }, tick: null, ...o, budget, budget_file };
  };
  // ended AND its supervisor gone: the run's own end-of-run fill (under queue.lock) is done (FINDING L1)
  d.ended = id => waitFor(() => { const it = d.item(id); return settled(it) && it; });
  return d;
}

// ---------- usage-limit classifier: patterns are executor data ----------
test('limit patterns: claude (Gas Town list) / codex / grok rows are data; an entry.limit overrides', () => {
  const now = new Date(2026, 10, 8, 12, 0, 0);   // local 12:00
  const claude = limitPatterns('claude'), codex = limitPatterns('codex-sol');
  assert.ok(LIMIT_PATTERNS.claude.match.length >= 7 && LIMIT_PATTERNS.codex.match.length && LIMIT_PATTERNS.grok.match.length);
  assert.deepEqual(limitPatterns('fake'), claude, 'the fake executor stands in for claude');
  assert.deepEqual(limitPatterns('codex-astra'), codex);
  assert.deepEqual(limitPatterns('grok', { type: 'cli', exe: 'grok' }), LIMIT_PATTERNS.grok);
  assert.deepEqual(limitPatterns('local', { type: 'openai-compatible' }), codex, 'an openai-compatible entry runs the codex CLI');
  const own = { match: ['quota gone'], reset: [] };
  assert.deepEqual(limitPatterns('grok', { type: 'cli', limit: own }), own);

  const epoch = Math.floor(now.getTime() / 1000) + 3600;
  assert.equal(classifyLimit(`x\nClaude AI usage limit reached|${epoch}\n`, claude, now).reset, new Date(epoch * 1000).toISOString());
  const at3 = classifyLimit("You've hit your limit · resets 3pm (Europe/Berlin)", claude, now);
  assert.equal(at3.reset, new Date(2026, 10, 8, 15, 0, 0).toISOString());
  assert.equal(classifyLimit('API Error: Rate limit reached', claude, now).reset, null);
  assert.equal(classifyLimit('TypeError: x is not a function', claude, now), null);
  // RUN-1614's log line (curly apostrophe); 6:14 PM is later today
  const cx = 'ERROR: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 6:14 PM.';
  assert.equal(classifyLimit(cx, codex, now).reset, new Date(2026, 10, 8, 18, 14, 0).toISOString());
  // a clock time already past today means tomorrow
  assert.equal(classifyLimit(cx, codex, new Date(2026, 10, 8, 19, 0, 0)).reset, new Date(2026, 10, 9, 18, 14, 0).toISOString());
});

// ---------- records ----------
test('records: queue creates RUN-n queued (start fields kept); fill / withdraw end it; end outcome limit is valid', () => {
  const d = sandbox();
  const data = { kind: 'fake', executor: 'fake', lane: 'demo', worktree: 'w', brief: 'b', not_before: '2026-11-08T00:00:00Z' };
  const q = record(d.state, { kind: 'run', ev: 'queue', by: 'launcher', data });
  assert.equal(q.id, 'RUN-1');
  assert.equal(d.item('RUN-1').state, 'queued');
  assert.equal(d.item('RUN-1').data.lane, 'demo');
  record(d.state, { kind: 'run', ev: 'fill', id: 'RUN-1', by: 'launcher', data: { next: 'RUN-2' } });
  assert.equal(d.item('RUN-1').state, 'filled');
  const w = record(d.state, { kind: 'run', ev: 'queue', by: 'launcher', data });
  record(d.state, { kind: 'run', ev: 'withdraw', id: w.id, by: 'controller', data: { why: 'not needed' } });
  assert.equal(d.item(w.id).state, 'withdrawn');
  assert.throws(() => record(d.state, { kind: 'run', ev: 'fill', id: w.id, by: 'launcher', data: { next: 'RUN-9' } }), /withdrawn/);
  const s = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', executor: 'fake', lane: 'demo' } });
  record(d.state, { kind: 'run', ev: 'end', id: s.id, by: 'launcher', data: { exit: 1, outcome: 'limit', reset: null } });
  assert.equal(d.item(s.id).end.outcome, 'limit');
});

// ---------- fill ----------
test('fill: FIFO per cap, a queued run never jumps a writer lock, not_before is honoured, PAUSED holds the queue', async () => {
  const d = sandbox();
  const brief = d.brief('mode: done\n');
  const q1 = queueRun(d.opts({ brief, worktree: d.wt(1), lane: 'one' })).run;      // its worktree has a live writer
  const q2 = queueRun(d.opts({ brief, worktree: d.wt(2), lane: 'two' })).run;
  const q3 = queueRun(d.opts({ brief, worktree: d.wt(3), lane: 'three' })).run;
  fs.writeFileSync(lockPath(d.locks, d.wt(1)), JSON.stringify({ run: 'RUN-99', pid: 1, ts: new Date().toISOString() }));
  assert.deepEqual(queueOf(d.runs()).map(x => [x.id, x.position]), [[q1, 1], [q2, 2], [q3, 3]]);
  const got = fillQueue(d.state);
  assert.equal(got.length, 1);
  assert.equal(got[0].queued, q2);
  assert.equal(d.item(q2).state, 'filled');
  assert.equal(d.item(q2).fill.next, got[0].next);
  assert.equal(d.item(got[0].next).data.from_queue, q2);
  assert.equal(d.item(q1).state, 'queued', 'writer-locked: waits');
  assert.equal(d.item(q3).state, 'queued', 'cap full after q2: waits (FIFO)');
  assert.equal((await d.ended(got[0].next)).end.outcome, 'done');

  const p = sandbox();
  const later = queueRun(p.opts({ brief: p.brief('mode: done\n'), notBefore: new Date(Date.now() + 3600000).toISOString() })).run;
  assert.deepEqual(fillQueue(p.state), []);
  assert.equal(p.item(later).state, 'queued');
  const paused = path.join(p.t, 'PAUSED'); fs.writeFileSync(paused, '');
  const held = queueRun(p.opts({ brief: p.brief('mode: done\n', 'b2.md'), worktree: p.wt(2), paused: [paused] })).run;
  assert.deepEqual(fillQueue(p.state), []);
  assert.equal(p.item(held).state, 'queued');
});

test('norn run --queue: cap full -> QUEUED (exit 0), runs shows it, the exit of the holder starts it; stop withdraws; no --queue still refuses', async () => {
  const d = sandbox();
  const budget = path.join(d.t, 'budget.json'); fs.writeFileSync(budget, JSON.stringify({ max_claude_workers: 1 }));
  const env = { ...process.env, META_HB_MS: '150', META_NO_TICK: '1', META_FILL_SAMPLE: '{"free_gb":64,"cpu_pct":0}' };   // META-GTP-DAG: the resource gate is not under test here
  const cli = (...a) => { const x = spawnSync(process.execPath, [META, ...a], { env, encoding: 'utf8' }); return { code: x.status, out: x.stdout, err: x.stderr }; };
  const common = ['--executor', 'fake', '--state', d.state, '--locks', d.locks, '--budget', budget, '--notes', d.notes];
  const release = path.join(d.t, 'release-holder');   // the holder lives until the test releases it: no 1.5 s race with four CLI spawns
  const a = cli('run', ...common, '--lane', 'one', '--worktree', d.wt(1), '--brief', d.brief(`mode: done\nuntil: ${release}\n`));
  assert.equal(a.code, 0, a.err);
  const holder = a.out.match(/STARTED (RUN-\d+)/)[1];
  const r = cli('run', ...common, '--lane', 'two', '--worktree', d.wt(2), '--brief', d.brief('mode: done\n', 'b2.md'));
  assert.equal(r.code, 4, r.out + r.err);
  const q = cli('run', ...common, '--lane', 'two', '--worktree', d.wt(2), '--brief', d.brief('mode: done\n', 'b2.md'), '--queue');
  assert.equal(q.code, 0, q.out + q.err);
  const qid = q.out.match(/QUEUED (RUN-\d+) lane two .*position 1/)[1];
  const w = cli('run', ...common, '--lane', 'three', '--worktree', d.wt(3), '--brief', d.brief('mode: done\n', 'b3.md'), '--queue');
  const wid = w.out.match(/QUEUED (RUN-\d+)/)[1];
  const ls = cli('runs', '--state', d.state);
  assert.match(ls.out, new RegExp(`${qid}  queued  #1 `));
  assert.match(ls.out, new RegExp(`${wid}  queued  #2 `));
  const s = cli('stop', wid, '--as', 'controller', '--state', d.state, '--locks', d.locks, '--why', 'not needed');
  assert.equal(s.code, 0, s.err); assert.match(s.out, new RegExp(`${wid} withdrawn`));
  assert.equal(d.item(wid).state, 'withdrawn'); assert.equal(d.item(wid).withdraw.why, 'not needed');
  fs.writeFileSync(release, '');
  assert.equal((await d.ended(holder)).end.outcome, 'done');
  const filled = await waitFor(() => d.item(qid).fill);
  assert.equal(d.item(filled.next).data.lane, 'two');
  assert.equal((await d.ended(filled.next)).end.outcome, 'done');
  assert.equal(d.item(wid).state, 'withdrawn');
});

test('norn status fills a slot a kill freed', async () => {
  const d = sandbox();
  const budget = path.join(d.t, 'budget.json'); fs.writeFileSync(budget, JSON.stringify({ max_claude_workers: 1 }));
  const holder = startRun(d.opts({ brief: d.brief('mode: sleep\nms: 60000\n', 'hold.md') })).run;
  const r = startRun(d.opts({ brief: d.brief('mode: done\n'), worktree: d.wt(2), queue: true }));
  assert.ok(r.queued, 'cap full: queued');
  const q = r.run;
  stopRun({ state: d.state, locksDir: d.locks, run: holder, by: 'controller', why: 'test' });   // a kill fills nothing by itself
  assert.equal(d.item(q).state, 'queued');
  // scratch machine (none) + scratch Claude config dir: status reads no live usage
  const env = { ...process.env, META_HB_MS: '150', META_NO_TICK: '1', CLAUDE_CONFIG_DIR: d.t };
  const x = spawnSync(process.execPath, [META, 'status', '--state', d.state, '--budget', budget, '--machine', path.join(d.t, 'no-machine.json'), '--out', path.join(d.t, 'STATUS.md')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(x.status, 0, x.stderr);
  assert.match(x.stdout, new RegExp(`queue: ${q} -> STARTED RUN-\\d+`));
  const next = d.item(q).fill?.next;
  assert.ok(next, 'status started the queued run');
  assert.equal((await d.ended(next)).end.outcome, 'done');
});

test('the tick fills a slot a kill freed before its gate (tick.log names the fill)', async () => {
  const d = sandbox();
  const holder = startRun(d.opts({ brief: d.brief('mode: sleep\nms: 60000\n', 'hold.md') })).run;
  const q = startRun(d.opts({ brief: d.brief('mode: done\n'), worktree: d.wt(2), queue: true })).run;
  stopRun({ state: d.state, locksDir: d.locks, run: holder, by: 'controller', why: 'test' });
  const root = d.wt('root');
  const project = { name: 'demo', root, state: d.state, ledger: path.join(d.t, 'progress.md'), briefs_dir: d.t, checkin: { cwd: root } };
  const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), 'utf8').replace(/^﻿/, ''));
  const r = tick({ project, machine: { claude: { exe: 'x', projects_dir: path.join(d.t, 'none') } }, budget: { ...fixture, max_claude_workers: 1, calib_time_utc: new Date().toISOString() },
    budgetFile: path.join(d.t, 'budget.json'), reason: 'test', dry: true, hbMs: 150, staleMs: 3000, fakeMs: 200 });
  assert.equal(r.code, 0, r.msg);
  const next = d.item(q).fill?.next;
  assert.ok(next, 'the tick started the queued run');
  assert.match(fs.readFileSync(path.join(d.state, 'tick.log'), 'utf8'), new RegExp(`queue: ${q} -> STARTED ${next}`));
  assert.equal((await d.ended(next)).end.outcome, 'done');
  for (const c of d.runs().filter(i => i.data.kind === 'checkin')) await d.ended(c.id);
});

// ---------- usage-limit exits ----------
// 11-15 (DEC-337): a read reset is held by the limit gate (open at reset + 2 min, or at once on a limit-<family> decision), no longer by a
// not_before clock the early reopen could not move; the unread reset keeps its 60 min clock (the gate closes nothing then)
test('limit exit: outcome limit + reset; re-queued, held by the limit gate until reset + 2 min (unparsed: not_before + 60 min); a crash stays a crash', async () => {
  let d = sandbox();
  const epoch = Math.floor(Date.now() / 1000) + 7200;
  const r = startRun(d.opts({ brief: d.brief(`mode: crash\nsay: Claude AI usage limit reached|${epoch}\n`), budget: {} }));
  const it = await d.ended(r.run);
  assert.equal(it.end.outcome, 'limit');
  assert.equal(it.end.reset, new Date(epoch * 1000).toISOString());
  const rq = await waitFor(() => d.runs().find(x => x.data.requeue_of === r.run));
  assert.equal(rq.state, 'queued');
  assert.equal(rq.data.not_before, undefined, 'no clock: the gate holds it');
  const held = now => readiness(d.state, { now }).find(x => x.id === rq.id).terms.some(t => /^limit: /.test(t));
  assert.ok(held(epoch * 1000 + 60000), 'held 1 min past the reset');
  assert.ok(!held(epoch * 1000 + 121000), 'released past reset + 2 min');
  assert.equal(rq.data.lane, 'demo'); assert.equal(rq.data.brief, it.data.brief);
  d = sandbox();   // META-LIMIT-GATE: that limit closes the fake family until its reset (norn run refuses it) - the next exits in a fresh state

  const u = startRun(d.opts({ brief: d.brief('mode: crash\nsay: API Error: Rate limit reached\n', 'b2.md'), worktree: d.wt(2), budget: {} }));
  const t0 = Date.now();
  assert.equal((await d.ended(u.run)).end.reset, null);
  const uq = await waitFor(() => d.runs().find(x => x.data.requeue_of === u.run));
  assert.ok(Math.abs(Date.parse(uq.data.not_before) - (t0 + 3600000)) < 30000, uq.data.not_before);

  const c = startRun(d.opts({ brief: d.brief('mode: crash\nsay: TypeError: boom\n', 'b3.md'), worktree: d.wt(3), budget: {} }));
  assert.equal((await d.ended(c.run)).end.outcome, 'crash');
  await sleep(300);
  assert.ok(!d.runs().some(x => x.data.requeue_of === c.run));
  // a broken project pattern never costs the end record
  const b = startRun(d.opts({ brief: d.brief('mode: crash\nsay: x\n', 'b4.md'), worktree: d.wt(4), budget: {}, limit: { match: ['('], reset: [] } }));
  assert.equal((await d.ended(b.run)).end.outcome, 'crash');
});

// ---------- dash ----------
// META-PLAN R1: the queue moved from the Runs page to the Plan tab (Up next)
test('dash Plan tab: queued runs are listed (position, not before); not agentsTree roots; the Runs page shows them as queued rows', () => {
  const d = sandbox();
  queueRun(d.opts({ brief: d.brief('mode: done\n'), lane: 'qlane', notBefore: '2026-11-09T18:16:00.000Z' }));
  const runs = d.runs();
  assert.equal(agentsTree(runs, {}).length, 0);
  const queue = queueOf(runs);
  assert.equal(queue[0].not_before, '2026-11-09T18:16:00.000Z');
  // owner 2026-11-19: the Runs page lists queued runs after the running ones (a queued row, 'waited' since queued); what they wait for stays on Plan
  assert.match(renderTab('runs', { tree: [], queue: queue.map(x => ({ ...x, project: 'demo' })) }, { project: 'demo', now: Date.now() }), /id="runs-queued"[^]*?id="node-RUN-1"[^]*?qlane[^]*?waited \d+ min/);
  const now = Date.parse('2026-11-09T12:00:00Z');
  const html = renderTab('plan', { parts: [buildPlan({ project: 'demo', runs, ready: readiness(d.state, { now, resources: () => ({ free_gb: 64, cpu_pct: 0 }) }), now })] }, { project: 'demo', now });
  assert.match(html, /Up next/);
  assert.match(html, /RUN-1/); assert.match(html, /Qlane/); assert.match(html, /#1/); assert.match(html, /not before/);
});

// CHECKIN-V2 piece 0 (GT-PARITY FINDING): the fill obeys the weekly guard and RATE_OK like a dispatch; a MERGE stage keeps
// only its RATE_OK exemption (NORN-WATCH S4 / DEC-688); a run off the Claude account (codex / typed) is not held by either
test('fill: a Claude run stays queued past the weekly guard or at RATE_OK=0; MERGE is exempt from RATE_OK only', async () => {
  const d = sandbox();
  const status = path.join(d.t, 'STATUS.md');
  const setStatus = (weekly, ok) => fs.writeFileSync(status, `## Usage\r\n- estimated weekly now ~${weekly} % (calib 1 %)\r\nRATE_OK=${ok}\r\n`);
  const budget = { max_claude_workers: 1, weekly_stop_pct: 95, usage_rate_cap_pct_per_h: 0.43 };
  const q = (stage, n) => queueRun(d.opts({ brief: d.brief('mode: done\n', `b${n}.md`), worktree: d.wt(n), lane: `l${n}`, stage, budget, statusFile: status })).run;
  const work = q('S1', 1), merge = q('MERGE', 2);
  setStatus(96, 1);
  assert.deepEqual(fillQueue(d.state), [], 'past the guard: nothing starts, MERGE included');
  assert.equal(d.item(work).state, 'queued');
  assert.equal(d.item(merge).state, 'queued');
  setStatus(50, 0);
  const got = fillQueue(d.state);
  assert.deepEqual(got.map(x => x.queued), [merge], 'RATE_OK=0: only the MERGE stage starts');
  assert.equal(d.item(work).state, 'queued');
  await d.ended(got[0].next);
  setStatus(50, 1);
  assert.deepEqual(fillQueue(d.state).map(x => x.queued), [work], 'under the guard and RATE_OK=1: it starts');
  const u = sandbox();
  const held = queueRun(u.opts({ brief: u.brief('mode: done\n'), budget, statusFile: path.join(u.t, 'none.md') })).run;
  assert.deepEqual(fillQueue(u.state), [], 'no STATUS: weekly unknown = held (as the auto-resume)');
  assert.equal(u.item(held).state, 'queued');
});

test('usageRefusal: one home for the weekly guard + RATE_OK (fill and auto-resume)', async () => {
  const { usageRefusal } = await import('../engine/lib/usageguard.mjs');
  const t = mkTmp('meta-guard-'), sf = path.join(t, 'STATUS.md');
  fs.writeFileSync(sf, '- estimated weekly now ~80.0 % (calib 1 %)\nRATE_OK=0\n');
  const spec = (budget, stage) => ({ budget, stage, statusFile: sf });
  assert.equal(usageRefusal(spec({}), t), null, 'no guard, no cap: nothing to check');
  assert.equal(usageRefusal(spec({ weekly_stop_pct: 80 }), t), 'weekly 80.0 % >= guard 80 %');
  assert.equal(usageRefusal(spec({ weekly_stop_pct: 95, usage_rate_cap_pct_per_h: 0.4 }), t), 'RATE_OK=0');
  assert.equal(usageRefusal(spec({ weekly_stop_pct: 95, usage_rate_cap_pct_per_h: 0.4 }, 'MERGE'), t), null);
  assert.equal(usageRefusal(spec({ weekly_stop_pct: 95, usage_rate_cap_pct_per_h: 0.4 }), t, { rate: false }), null, 'the auto-resume checks the guard only');
  assert.equal(usageRefusal({ budget: { weekly_stop_pct: 95 }, statusFile: path.join(t, 'x') }, t), 'weekly unknown');
});

// META-GTP-CI-FILLWAKE F2: a fill that finds queue.lock held must not lose its wakeup. Deterministic interleave via the onPass seam
// (no sleeps): the holder's pass has just found q blocked (its worktree writer-locked); the writer then goes and a second filler
// runs while the holder still holds queue.lock. Before the fix the second filler returned [] and q stayed queued until the next fill.
test('fill: a filler that loses queue.lock leaves a re-fill flag; the holder passes again and starts what it unblocked', async () => {
  const d = sandbox();
  const q = queueRun(d.opts({ brief: d.brief('mode: done\n'), worktree: d.wt(1) })).run;
  const writer = lockPath(d.locks, d.wt(1));
  fs.writeFileSync(writer, JSON.stringify({ run: 'RUN-99', pid: 1, ts: new Date().toISOString() }));
  let inner = null, passes = 0;
  const got = fillQueue(d.state, { onPass() {
    passes++;
    if (inner) return;
    assert.equal(d.item(q).state, 'queued', 'the holder\'s first pass found it blocked');
    fs.unlinkSync(writer);                          // the state change lands while the holder is past its check
    inner = fillQueue(d.state);                     // the losing filler: queue.lock is held
  } });
  assert.deepEqual(inner, [], 'the loser starts nothing itself');
  assert.equal(passes, 2, 'the holder saw the flag and passed once more');
  assert.equal(got.length, 1);
  assert.equal(got[0].queued, q);
  assert.equal(d.item(q).state, 'filled');
  assert.ok(!fs.existsSync(path.join(d.state, 'queue.lock')) && !fs.existsSync(path.join(d.state, 'queue.refill')), 'lock + flag gone');
  assert.equal((await d.ended(got[0].next)).end.outcome, 'done');
});

test('fill: a stale queue.lock (holder died) is still broken; a fresh one held by another filler is not', () => {
  const d = sandbox();
  const lock = path.join(d.state, 'queue.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: new Date(Date.now() - 10 * 60000).toISOString() }));
  assert.deepEqual(fillQueue(d.state), []);
  assert.ok(!fs.existsSync(lock), 'stale: broken, filled, released');
  fs.writeFileSync(lock, JSON.stringify({ pid: 1, ts: new Date().toISOString() }));
  assert.deepEqual(fillQueue(d.state), []);
  assert.ok(fs.existsSync(lock), 'fresh: left to its holder');
  assert.ok(fs.existsSync(path.join(d.state, 'queue.refill')), 'the loser left the re-fill flag for it');
});

// META-OOTB-FIX FLOW-STALL (CI 43536392454, Windows: the art-round flow stalled 60 s): the queue.lock windows on the step-advance path.
// A fake fs for queue.lock only (fillQueue's io seam); every other path passes through. Deterministic: counts, never sleeps.
function lockIo(lock, { pendingCreates = 0, busyUnlinks = 0 } = {}) {
  const n = { create: 0, unlink: 0 }, err = code => Object.assign(new Error(code), { code });
  const pending = () => n.create < pendingCreates;   // Windows delete-pending: create / open / delete fail EPERM until the last handle closes
  return { n,
    writeFileSync(f, data, o) { if (f === lock && o?.flag === 'wx' && pending()) { n.create++; throw err('EPERM'); } return fs.writeFileSync(f, data, o); },
    readFileSync(f, enc) { if (f === lock && pending()) throw err('EPERM'); return fs.readFileSync(f, enc); },
    unlinkSync(f) {
      if (f === lock && pending()) throw err('EPERM');
      if (f === lock && n.unlink < busyUnlinks && fs.existsSync(f)) { n.unlink++; throw err('EBUSY'); }   // a scanner's handle without share-delete
      return fs.unlinkSync(f);
    },
    statSync: (f, o) => fs.statSync(f, o),
  };
}
// suspect (i): 'wx' creates the file, the JSON lands in a second write - a loser reading in between saw null and broke a live lock
test('fill: a queue.lock just created by another filler (its JSON not yet written) is held, not broken as stale', async () => {
  const d = sandbox();
  const q = queueRun(d.opts({ brief: d.brief('mode: done\n') })).run;
  const lock = path.join(d.state, 'queue.lock'), flag = path.join(d.state, 'queue.refill');
  fs.writeFileSync(lock, '');   // created, content not yet written
  assert.deepEqual(fillQueue(d.state), [], 'no second filler beside the live one');
  assert.equal(fs.readFileSync(lock, 'utf8'), '', 'left to its holder');
  assert.ok(fs.existsSync(flag), 'the loser left the re-fill flag for it');
  assert.equal(d.item(q).state, 'queued');
  const old = new Date(Date.now() - 10 * 60000);   // a crash between create and write: the empty lock's mtime is its age
  fs.utimesSync(lock, old, old);
  const got = fillQueue(d.state);
  assert.equal(got.length, 1, 'stale by its mtime: broken, filled');
  assert.ok(!fs.existsSync(lock) && !fs.existsSync(flag));
  assert.equal((await d.ended(got[0].next)).end.outcome, 'done');
});
// suspect (ii): the holder released, its lock is delete-pending (a handle still open): the loser's two tries both failed EPERM, it
// returned after its flag - and the holder's after-release re-check had already passed. Nobody filled.
test('fill: a queue.lock in Windows delete-pending (released, a handle still open) is waited out - the wakeup is never lost', async () => {
  const d = sandbox();
  const q = queueRun(d.opts({ brief: d.brief('mode: done\n') })).run;
  const lock = path.join(d.state, 'queue.lock');
  const io = lockIo(lock, { pendingCreates: 4 });
  const got = fillQueue(d.state, { io });
  assert.equal(io.n.create, 4, 'every create met the pending delete until the handle closed');
  assert.equal(got.length, 1, 'the filler waited it out and filled');
  assert.equal(got[0].queued, q);
  assert.ok(!fs.existsSync(lock));
  assert.equal((await d.ended(got[0].next)).end.outcome, 'done');
});
// window (iii): the release's unlink met a transient sharing error and was swallowed: a fresh-looking lock with no holder made every
// filler a loser for STALE_MS (120 s - past the flow test's 60 s wait)
test('fill: a release that meets a transient sharing error (EBUSY) still frees queue.lock', async () => {
  const d = sandbox();
  const lock = path.join(d.state, 'queue.lock');
  const io = lockIo(lock, { busyUnlinks: 2 });
  assert.deepEqual(fillQueue(d.state, { io }), []);
  assert.equal(io.n.unlink, 2);
  assert.ok(!fs.existsSync(lock), 'released after the handle closed');
  const q = queueRun(d.opts({ brief: d.brief('mode: done\n') })).run;
  const got = fillQueue(d.state);
  assert.equal(got.length, 1, 'the next fill is not locked out');
  assert.equal(got[0].queued, q);
  assert.equal((await d.ended(got[0].next)).end.outcome, 'done');
});
// the release removes only its own lock: a holder whose lock was broken as stale meanwhile must not free its successor's
test('fill: a holder whose queue.lock was taken over meanwhile leaves the successor\'s lock in place', () => {
  const d = sandbox();
  const lock = path.join(d.state, 'queue.lock'), other = JSON.stringify({ pid: 1, token: 'other', ts: new Date().toISOString() });
  fillQueue(d.state, { onPass() { fs.writeFileSync(lock, other); } });
  assert.equal(fs.readFileSync(lock, 'utf8'), other);
});
