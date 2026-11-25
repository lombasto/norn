// GAP-1 (holds.mjs): a blocked Norn says so. ALL queued work held on one machine-level term (usage guard / PAUSED) past
// policy.holds.notice_min = ONE needs-you item, ONE digest row, ONE notice per episode; all leave by themselves when the hold clears.
// Temp state dirs only; the fake executor never starts (every run stays queued).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { queueRun, readiness } from '../engine/lib/runs.mjs';
import { wholeHold, trackHold, readHold, holdItem, holdNoticeDue, holdReason, noticeMin, NOTICE_MIN } from '../engine/lib/holds.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { fixture } from './helpers/dash-fixture.mjs';

const W = 'usage: weekly unknown';
const row = (id, terms, o = {}) => ({ id, ready: false, terms, account: true, ...o });

test('wholeHold: every queued (Claude) run on the same machine-level term, else null', () => {
  assert.equal(wholeHold([]), null, 'an empty queue holds nothing');
  const h = wholeHold([row('RUN-1', [W]), row('RUN-2', ['after run:RUN-1:merged unmet', W], { stage: 'MERGE' })]);
  assert.deepEqual(h, { term: W, scope: 'all', runs: ['RUN-1', 'RUN-2'], merges: 1 });
  assert.equal(wholeHold([row('RUN-1', [W]), row('RUN-2', [])]), null, 'a free Claude run: not everything is held');
  assert.equal(wholeHold([row('RUN-1', ['usage: RATE_OK=0']), row('RUN-2', [], { stage: 'MERGE' })]), null, 'a MERGE free at RATE_OK=0 clears it');
  assert.equal(wholeHold([row('RUN-1', [W]), row('RUN-2', ['usage: RATE_OK=0'])]), null, 'two different terms: no single reason');
  assert.equal(wholeHold([row('RUN-1', ['cap: max_claude_workers 1/1'])]), null, 'a cap is not machine-level');
  assert.deepEqual(wholeHold([row('RUN-1', [W]), row('RUN-2', [], { account: false })]).scope, 'claude', 'a Codex run free to go: every Claude run is still held');
  assert.equal(wholeHold([row('RUN-1', ['PAUSED all (C:/s/PAUSED)']), row('RUN-2', [], { account: false })]), null, 'PAUSED must hold every row');
  assert.equal(wholeHold([row('RUN-1', ['PAUSED all (C:/s/PAUSED)', W]), row('RUN-2', ['PAUSED all (C:/s/PAUSED)'], { account: false })]).term, 'PAUSED all (C:/s/PAUSED)');
});

test('holdReason: a pinned dwarf busy on a home run (RUN-b-7) gets its reason, not the raw term', () => {
  assert.equal(holdReason('dwarf: Dun Testbeard is busy on RUN-b-7').reason, 'the lane is pinned to Dun Testbeard, who is busy on RUN-b-7');
  assert.equal(holdReason('dwarf: Dun Testbeard is busy on RUN-b-7', { name: () => 'Adopt A1' }).short, 'waits for Dun Testbeard, its pinned dwarf (busy on Adopt A1)', 'the short form (plan holdWords) names the run');
});
test('holdReason: the reason and the exact fix, in the billing mode in force', () => {
  assert.match(holdReason(W).fix, /set Billing \(Settings\): on API billing choose api.*norn calib --pct N/);
  assert.equal(holdReason(W).setting, 'billing');
  const plan = holdReason(W, { billing: 'max-5x' });
  assert.match(plan.fix, /^run norn calib --pct N/); assert.match(plan.reason, /billing: /);
  assert.match(holdReason('usage: RATE_OK=0').clears, /trailing 2 h rate/);
  assert.match(holdReason('usage: weekly 96.0 % >= guard 95 %', { status: '- reset 2026-11-20T08:00Z\n' }).clears, /weekly reset \(2026-11-20 08:00Z\)/);
  assert.match(holdReason('usage: api spend $12.00 in 24 h >= cap $10.00').reason, /\$10.00 daily cap/);
  const p = holdReason('PAUSED all (C:/s/PAUSED)');
  assert.equal(p.file, 'C:/s/PAUSED'); assert.equal(p.resume, true); assert.match(p.fix, /norn resume --all/); assert.match(p.reason, /Pause everything/);
  assert.equal(noticeMin({}), NOTICE_MIN); assert.equal(noticeMin({ holds: { notice_min: 15 } }), 15);
});

test('trackHold / holdItem / holdNoticeDue: one episode, its since kept, one notice, gone when the hold clears', () => {
  const state = path.join(mkTmp('meta-holds-'), 'state', 'demo');
  fs.mkdirSync(state, { recursive: true });
  const T = Date.parse('2026-11-17T00:00:00Z'), rows = [row('RUN-1', [W]), row('RUN-2', [W], { stage: 'MERGE' })];
  assert.equal(trackHold(state, rows, { now: T }).since, '2026-11-17T00:00:00.000Z');
  assert.equal(trackHold(state, rows, { now: T + 30 * 60000 }).since, '2026-11-17T00:00:00.000Z', 'the same term = the same episode');
  assert.equal(holdItem(readHold(state), { now: T + 59 * 60000 }), null, 'under the threshold: nothing');
  const it = holdItem(readHold(state), { now: T + 61 * 60000, project: 'demo' });
  assert.equal(it.type, 'hold'); assert.equal(it.minutes, 61); assert.deepEqual(it.runs, ['RUN-1', 'RUN-2']);
  assert.match(it.title, /^All 2 queued runs \(1 merge\) held since 2026-11-17 00:00Z: the weekly usage is not measured yet/);
  assert.equal(holdNoticeDue(state, { now: T + 10 * 60000 }), null, 'no notice before the threshold');
  const n = holdNoticeDue(state, { now: T + 61 * 60000, project: 'demo' });
  assert.match(n.title, /^Norn demo: all queued work held 1 h/); assert.match(n.body, /Fix: set Billing/);
  assert.equal(holdNoticeDue(state, { now: T + 120 * 60000 }), null, 'ONE notice per episode, not every tick');
  assert.equal(trackHold(state, [row('RUN-1', ['usage: RATE_OK=0'])], { now: T + 130 * 60000 }).since, '2026-11-17T02:10:00.000Z', 'a new term = a new episode');
  assert.equal(readHold(state).notified, null);
  assert.equal(trackHold(state, [row('RUN-1', [])], { now: T + 140 * 60000 }), null);
  assert.equal(fs.existsSync(path.join(state, 'hold.json')), false, 'level-triggered: the file is gone with the hold');
});

test('the queue + the digest: a weekly-unknown hold of every queued run is digest row 0b (and leaves with the hold)', () => {
  const t = mkTmp('meta-holds-q-'), state = path.join(t, 'state', 'demo'), locks = path.join(t, 'state', 'locks');
  for (const d of [state, locks]) fs.mkdirSync(d, { recursive: true });
  const status = path.join(state, 'STATUS.md'), budget_file = path.join(t, 'budget.json');
  fs.writeFileSync(budget_file, JSON.stringify({ max_claude_workers: 1, weekly_stop_pct: 95, billing: 'max-5x' }));   // GAP-2: the fill reads the budget file live
  for (const [n, stage] of [[1, 'S1'], [2, 'MERGE']]) {
    const wt = path.join(t, 'wt' + n), brief = path.join(t, `b${n}.md`);
    fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(brief, 'mode: done\n');
    queueRun({ state, locksDir: locks, executor: 'fake', lane: 'l' + n, stage, worktree: wt, notes: path.join(t, 'NOTES.md'), brief, budget_file, statusFile: status, policy: { auto_resume_max: 0 }, tick: null });
  }
  const now = Date.now(), rows = readiness(state, { now });
  assert.ok(rows.every(r => r.account === true && r.terms.includes(W)), JSON.stringify(rows));
  trackHold(state, rows, { now: now - 90 * 60000 });
  assert.equal(readHold(state).billing, 'max-5x', 'the billing key from the held run\'s queue spec');
  const d = digest(state, { policy: { holds: { notice_min: 60 } } }, { now, git: () => null, dlv: [] });
  assert.equal(d.sections.hold.length, 1);
  assert.equal(d.sections.hold[0].merges, 1);
  const md = renderDigest(d);
  assert.match(md, /0b EVERYTHING HELD .*\n- HOLD 2 queued run\(s\) incl\. 1 merge\(s\) held since .* \(90 min\) on "usage: weekly unknown": .*fix: run norn calib --pct N/);
  assert.equal(digest(state, { policy: { holds: { notice_min: 120 } } }, { now, git: () => null, dlv: [] }).sections.hold, undefined, 'under its own threshold: no row');
  fs.writeFileSync(status, '- estimated weekly now ~40.0 %\nRATE_OK=1\n');
  assert.equal(digest(state, {}, { now, git: () => null, dlv: [] }).sections.hold, undefined, 'the walk no longer holds: the row leaves (hold.json is stale until the tick)');
});

test('dashboard: ONE needs-you Inbox item with the fix; it leaves when hold.json goes', async () => {
  const f = await fixture();
  try {
    const since = new Date(Date.now() - 3 * 3600000).toISOString();
    fs.writeFileSync(path.join(f.pa.state, 'hold.json'), JSON.stringify({ term: W, scope: 'all', runs: ['RUN-7', 'RUN-8'], merges: 1, since, billing: null, notified: null }));
    const items = (await f.get('/api/inbox?project=kestrel')).data.items, h = items.filter(i => i.type === 'hold');
    assert.equal(h.length, 1);
    assert.match(h[0].title, /All 2 queued runs \(1 merge\) held since/);
    assert.match(h[0].fix, /set Billing \(Settings\)/);
    const html = renderTab('inbox', { items }, { project: 'kestrel', now: Date.now() });
    assert.match(html, /all held/); assert.match(html, /Open Settings/); assert.match(html, /norn calib --pct N/);
    const needs = async () => (await f.get('/api/strip?project=kestrel')).data.needs_you, n0 = await needs();
    fs.unlinkSync(path.join(f.pa.state, 'hold.json'));
    assert.equal((await f.get('/api/inbox?project=kestrel')).data.items.filter(i => i.type === 'hold').length, 0);
    assert.equal(await needs(), n0 - 1, 'it counted as needs-you');
  } finally { await f.done(); }
});

test('tick: a PAUSED tick still tracks the hold, and returns ONE hold notice past the threshold', async () => {
  const { tick } = await import('../engine/lib/tick.mjs');
  const t = mkTmp('meta-holds-t-'), state = path.join(t, 'state', 'demo'), locks = path.join(t, 'state', 'locks'), wt = path.join(t, 'wt');
  for (const d of [state, locks, wt]) fs.mkdirSync(d, { recursive: true });
  const pausedF = path.join(state, 'PAUSED'), brief = path.join(t, 'b.md');
  fs.writeFileSync(brief, 'mode: done\n'); fs.writeFileSync(pausedF, 'x\n');
  queueRun({ state, locksDir: locks, executor: 'fake', lane: 'l1', worktree: wt, notes: path.join(t, 'NOTES.md'), brief, budget: { max_claude_workers: 1 }, paused: [pausedF], policy: { auto_resume_max: 0 }, tick: null });
  const project = { name: 'demo', root: wt, state, ledger: path.join(t, 'progress.md'), policy: { holds: { notice_min: 30 } } };
  const go = () => tick({ project, machine: {}, budget: {}, reason: 'test', dry: true });
  const r1 = go();
  assert.match(r1.msg, /PAUSED/);
  assert.match(readHold(state).term, /^PAUSED all \(/); assert.equal(r1.hold_notice, undefined, 'not before notice_min');
  fs.writeFileSync(path.join(state, 'hold.json'), JSON.stringify({ ...readHold(state), since: new Date(Date.now() - 31 * 60000).toISOString() }));
  const r2 = go();
  assert.match(r2.hold_notice.title, /all queued work held .*Norn is paused/);
  assert.equal(go().hold_notice, undefined, 'once per episode');
  fs.unlinkSync(pausedF);
  assert.equal(holdReason(readHold(state).term).resume, true);
});

// HOME-MAIL S3 (REPORT 3.3): the tick tells the sender once per mail another home has not acked past policy.mail.unacked_alert_min
test('tick: a mail to home b unacked 31 min gives ONE notice over two ticks, with the reason (b holds it, nobody read it)', async () => {
  const { tick } = await import('../engine/lib/tick.mjs');
  const { sendMail } = await import('../engine/lib/mail.mjs');
  const t = mkTmp('meta-holds-mail-'), state = path.join(t, 'state', 'demo'), wt = path.join(t, 'wt');
  for (const d of [state, wt]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(state, 'home.json'), JSON.stringify({ id: 'a', bare_home: 'a' }));
  fs.writeFileSync(path.join(state, 'PAUSED'), 'x\n');
  const m = sendMail(state, { by: 'controller', to: 'role:controller@b', subject: 'are you there', body: 'x' }), T = Date.parse(m.ts);
  const seen = ms => { fs.mkdirSync(path.join(state, 'homes', 'b'), { recursive: true });
    fs.writeFileSync(path.join(state, 'homes', 'b', 'seen.json'), JSON.stringify({ polled_at: new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'), held: { a: { 'mail.jsonl': m.seq } } })); };
  const project = { name: 'demo', root: wt, state, ledger: path.join(t, 'progress.md'), policy: {} };
  const go = min => { seen(T + (min - 1) * 60000); return tick({ project, machine: {}, budget: {}, reason: 'test', dry: true, now: () => new Date(T + min * 60000) }); };
  assert.equal(go(29).sync_notices, undefined, 'not before 30 min');
  const [n, ...more] = go(31).sync_notices;
  assert.deepEqual(more, []);
  assert.match(n.title, new RegExp(`${m.id} to role:controller@b unacked 31 min`));
  assert.match(n.body, /b holds it; nobody there has read it/);
  assert.equal(go(32).sync_notices, undefined, 'once per mail');
});
