// RM-39: a run's progress against its brief, its pace, why it is slow and its alarms in words (engine/lib/progress.mjs), on fixtures
// trimmed from real runs: norn RUN-123 + RUN-148 (lane-purpose S1, two sessions; tests/fixtures/progress - tool calls and their
// commit / test lines only, home paths replaced) and small hand-made transcripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefPlan, workInit, onWork, checklist, doneLines, runProgress, alarmWords, testCounts, laneSteps, mergeWork, sessionsOf } from '../engine/lib/progress.mjs';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'progress');
const read = f => fs.readFileSync(path.join(FX, f), 'utf8');
const fold = (...files) => { const w = workInit(); for (const f of files) for (const l of read(f).split('\n').filter(Boolean)) onWork(w, JSON.parse(l)); return w; };
const BRIEF = read('lane-purpose-brief.md'), NOTES = read('lane-purpose-NOTES.md');
const MAIL29 = { id: 'MAIL-29', kind: 'mail', created: '2026-11-19T01:14:35Z', data: { to: 'lane:lane-purpose', subject: "Owner: show each lane's type and its output (design vs code)" } };
const GRD9 = { id: 'GRD-9', cls: 'runaway', state: 'ruled', action: 'mail', why: '10.3M cache reads = 6.3x the median 1.6M of 5 peers (worker / - / high); 79 turns (median 10)' };
const run = (id, { data, ...o } = {}) => ({ id, kind: 'run', state: 'running', created: '2026-11-18T23:28:02Z', updated: '2026-11-18T23:28:02Z', history: [],
  data: { kind: 'worker', lane: 'lane-purpose', stage: 'S1', agent: 'implementer', ...(data || {}) }, ...o });
const R123 = run('RUN-123'), at = w => Date.parse(w.last) + 60000;

test('briefPlan reads the first numbered list, the time budget and the Done line', () => {
  const p = briefPlan(BRIEF);
  assert.deepEqual(p.items.map(x => x.n), [1, 2, 3, 4]);
  assert.deepEqual(p.items.slice(0, 3).map(x => x.title), ["A lane's driver", 'Lanes page', 'Runs page']);
  assert.equal(p.budget_min, 120);
  assert.equal(p.done, '## DONE');
  // a later list that restarts at 1 is not the plan; a bold lead is the title
  const q = briefPlan('# t\n1. **Alpha**: a\n2. **Beta**: b\n\n## Tests\n1. one\n2. two\n3. three\n');
  assert.deepEqual(q.items.map(x => x.title), ['Alpha', 'Beta']);
  assert.equal(briefPlan('no list').items.length, 0);
});

test('the transcript fold: commits (a quiet commit + git log, a test-then-commit line), test counts, edits', () => {
  const w = fold('run-123.jsonl');
  assert.deepEqual(w.commits.map(c => c.sha), ['336f6e8', '79dc9ef']);   // base commits the run printed before (ab296e2 ...) never count
  const tests = w.calls.filter(x => x.kind === 'test');
  assert.ok(tests.length >= 10);
  assert.ok(tests.some(x => x.counts && x.counts.pass === 7 && x.counts.fail === 0));
  assert.ok(w.calls.some(x => x.kind === 'edit' && /purpose\.mjs$/.test(x.files[0])));
  assert.deepEqual(testCounts('ℹ pass 3\nℹ fail 1\nℹ pass 2\nℹ fail 0'), { pass: 5, fail: 1 });
  assert.deepEqual(testCounts('ci-suite: 2 listed red(s), 1 new, 0 leak(s), 0 hang(s)'), { pass: null, fail: 1 });
  assert.equal(testCounts('nothing'), null);
});

test('RUN-123 (session 1): 3 of 5 items done by commit evidence, MAIL-29 added scope, the runaway alarm in words with its ratio', () => {
  const w = fold('run-123.jsonl');
  const p = runProgress(R123, { runs: { 'RUN-123': R123 }, brief: BRIEF, mails: [MAIL29], work: w, guard: [GRD9], cpu: 97, ctx: 197078, now: at(w) });
  assert.deepEqual(p.items.map(x => x.state), ['done', 'done', 'done', 'todo', 'todo']);
  assert.match(p.items[0].evidence, /^commit 336f6e8 /);
  assert.match(p.items[1].evidence, /^commit 79dc9ef /);
  assert.equal(p.items[4].mail, 'MAIL-29');
  assert.match(p.line, /^3 of 5 items done/);
  assert.equal(p.pace.state, 'slow');   // 2 h 07 min of a 2 h budget
  assert.match(p.pace.words, /2 h 07 min of a 2 h 00 min budget/);
  assert.deepEqual(p.slow.repeats, { key: 'lane-purpose-dash.test.mjs', n: 5 });
  assert.match(p.slow.line, /^slow: \d+ % of the last hour in test runs; the machine is at 97 % CPU; the same file re-run 5 times \(lane-purpose-dash\.test\.mjs\); 1 mail added scope \(MAIL-29\)$/);
  const a = p.alarms[0];
  assert.equal(a.cls, 'runaway');
  assert.match(a.words, /^uses 6\.3x the tokens of similar runs - most of it re-reading a 197k context on every call$/);
  assert.match(a.numbers, /10\.3M cache reads vs a median 1\.6M of 5 ended runs/);
  assert.match(a.ruled, /^ruled: mail it/);
  assert.match(a.act[0], /nothing needed/);   // it was still committing / editing: nothing needed comes first
});

test('RUN-148 (session 2 after a hand-off): MAIL-29 done by the commit naming it, item 4 by a NOTES line; 2 sessions, 1 hand-off', () => {
  const r123 = { ...R123, state: 'exited', end: { outcome: 'handoff' }, history: [{ ev: 'end', ts: '2026-11-19T01:34:01Z' }] };
  const r148 = run('RUN-148', { created: '2026-11-19T01:34:01Z' }), w = fold('run-123.jsonl', 'run-148.jsonl');
  const p = runProgress(r148, { runs: { 'RUN-123': r123, 'RUN-148': r148 }, brief: BRIEF, notes: NOTES, mails: [MAIL29], work: w, now: at(w) });
  assert.equal(p.items[4].state, 'done');
  assert.match(p.items[4].evidence, /^commit 7873296 "feat\(lanes\): laneType/);
  assert.equal(p.items[3].state, 'done');
  assert.match(p.items[3].evidence, /^NOTES: "RM-30's shared renderer is not on main/);
  assert.match(p.line, /^5 of 5 items done/);
  assert.equal(p.pace.sessions, 2);
  assert.equal(p.pace.handoffs, 1);
  assert.match(p.pace.words, /session 2 \(1 hand-off\)/);
  assert.ok(p.slow.reasons.some(x => /^1 hand-off/.test(x)));
});

// a hand-made transcript: tool_use + tool_result records at given minutes after t0
const T0 = Date.parse('2026-11-19T10:00:00Z'), iso = m => new Date(T0 + m * 60000).toISOString();
let seq = 0;
const call = (m0, m1, name, input, text = '') => { const id = `t${++seq}`; return [{ type: 'assistant', timestamp: iso(m0), message: { content: [{ type: 'tool_use', id, name, input }] } },
  { type: 'user', timestamp: iso(m1), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }]; };
const work = recs => { const w = workInit(); for (const j of recs.flat()) onWork(w, j); return w; };
const FIVE = '# task demo S1\n## Build\n1. **Queue lock**: the queue takes a lock\n2. **Retry backoff**: failed sends retry with backoff\n3. **Digest table**: the digest lists the queue\n'
  + '4. **Settings row**: a setting for the backoff\n5. **Docs**: the README says how\nTime budget 90 min\nDone: ## DONE\n';

test('2 of 5 items done by commit evidence; editing a file named like item 3 = testing / doing item 3', () => {
  const w = work([
    call(5, 6, 'Bash', { command: 'git commit -m "feat(queue): the queue takes a lock before the fill"' }, '[norn/demo 1111111] feat(queue): the queue takes a lock before the fill'),
    call(20, 21, 'Bash', { command: 'git commit -m "feat(send): failed sends retry with an exponential backoff"' }, '[norn/demo 2222222] feat(send): failed sends retry with an exponential backoff'),
    call(30, 31, 'Edit', { file_path: '/fx/repo/engine/lib/digest-table.mjs' }),
    call(32, 33, 'Bash', { command: 'node --test tests/digest-table.test.mjs' }, 'ℹ pass 2\nℹ fail 1'),
  ]);
  w.open.x = { name: 'Bash', ts: iso(34), cmd: 'node --test tests/digest-table.test.mjs', file: null };   // the test is running now
  const r = run('RUN-1', { created: iso(0), data: { lane: 'demo', stage: 'S1' } });
  const p = runProgress(r, { runs: { 'RUN-1': r }, brief: FIVE, work: w, now: T0 + 35 * 60000 });
  assert.deepEqual(p.items.map(x => x.state), ['done', 'done', 'doing', 'todo', 'todo']);
  assert.equal(p.line, '2 of 5 items done, testing item 3');
  assert.equal(p.pace.state, 'on track');
  assert.equal(p.pace.budget_min, 90);
});

test('a stalled run: no commit, edit or test change for N min - the same failing test re-run does not count as a change', () => {
  const recs = [call(0, 2, 'Edit', { file_path: '/fx/repo/a.mjs' })];
  for (let i = 0; i < 6; i++) recs.push(call(10 + i * 10, 18 + i * 10, 'Bash', { command: 'node --test tests/queue-lock.test.mjs' }, 'ℹ pass 4\nℹ fail 1'));
  const w = work(recs), r = run('RUN-2', { created: iso(0), data: { lane: 'demo', stage: 'S1' } });
  const p = runProgress(r, { runs: { 'RUN-2': r }, brief: FIVE, work: w, cpu: 98, now: T0 + 70 * 60000 });
  assert.equal(p.pace.state, 'stalled');
  assert.equal(p.pace.still_min, 52);   // the first run of the test (min 18) was its last change
  assert.match(p.pace.words, /^stalled: no commit, edit or test change for 52 min/);
  assert.deepEqual(p.slow.repeats, { key: 'queue-lock.test.mjs', n: 6 });
  assert.match(p.slow.line, /^stalled: (8\d|9\d) % of the last hour in test runs; the machine is at 98 % CPU; the same file re-run 6 times \(queue-lock\.test\.mjs\)$/);
});

test('the estimate: the lane\'s own finished stages first (every session of a stage summed), else similar runs of the same agent', () => {
  const ended = (id, lane, stage, startMin, endMin, outcome = 'done') => ({ id, kind: 'run', state: 'exited', created: iso(startMin), updated: iso(endMin), end: { outcome },
    history: [{ ev: 'end', ts: iso(endMin) }], data: { kind: 'worker', lane, stage, agent: 'implementer' } });
  const runs = { 'RUN-1': ended('RUN-1', 'demo', 'S1', -500, -440, 'handoff'), 'RUN-2': ended('RUN-2', 'demo', 'S1', -440, -400),
    'RUN-3': ended('RUN-3', 'demo', 'S2', -300, -200), 'RUN-9': run('RUN-9', { created: iso(0), data: { lane: 'demo', stage: 'S3' } }) };
  const p = runProgress(runs['RUN-9'], { runs, brief: FIVE, work: workInit(), now: T0 + 10 * 60000 });
  assert.deepEqual(p.pace.estimate, { min: 100, n: 2, from: 'the lane\'s own stages' });   // S1 = 60 + 40, S2 = 100
  const other = run('RUN-10', { created: iso(0), data: { lane: 'other', stage: 'S1' } });
  assert.equal(runProgress(other, { runs: { ...runs, 'RUN-10': other }, brief: FIVE, now: T0 }).pace.estimate.from, 'similar runs (implementer)');
});

test('alarm words: over-handoff and tool-spam name what they mean and the owner\'s moves', () => {
  const o = alarmWords({ cls: 'over-handoff', why: 'context 180k above the hand-off line (150k) for the last 12 calls, no HANDOFF yet' });
  assert.equal(o.words, 'its context is past the size where it should hand off (180k vs 150k, 12 calls) and it has not handed off yet');
  assert.match(o.act[0], /^mail it/);
  const t = alarmWords({ cls: 'tool-spam', why: '62 % of its cache reads are tool output (Read 40 %)' });
  assert.equal(t.words, 'tool output fills most of what it re-reads every call (62 %)');
  const r = alarmWords(GRD9, { test_share: 0.7 });
  assert.equal(r.words, 'uses 6.3x the tokens of similar runs - most of it re-reading a long context while waiting on tests');
  assert.match(r.act[0], /^mail it/);   // not moving: mail first
});

test('doneLines: bullets under a "What was built" heading and lines with a done word; checklist with no brief items', () => {
  assert.deepEqual(doneLines('# n\n## What was built\n- a\n- b\n## Findings\n- c\n- d is done\n## DONE\n'), ['- a', '- b', '- d is done']);
  const p = runProgress(run('RUN-5'), { brief: '# no list', now: Date.parse('2026-11-19T00:00:00Z') });
  assert.match(p.line, /^no numbered items in the brief/);
  assert.deepEqual(checklist({ plan: briefPlan(FIVE), mails: [], notes: '- item 4 done' }).map(x => x.state), ['todo', 'todo', 'todo', 'done', 'todo']);
});

test('a records change (a new fold) re-derives the sessions and the estimate: the run index never outlives its fold', () => {
  const ended = (id, stage, startMin, endMin, outcome = 'done') => ({ id, kind: 'run', state: 'exited', created: iso(startMin), updated: iso(endMin), end: { outcome },
    history: [{ ev: 'end', ts: iso(endMin) }], data: { kind: 'worker', lane: 'demo', stage, agent: 'implementer' } });
  const live = run('RUN-9', { created: iso(0), data: { lane: 'demo', stage: 'S3' } });
  const a = { 'RUN-1': ended('RUN-1', 'S1', -500, -440), 'RUN-2': ended('RUN-2', 'S2', -300, -200), 'RUN-9': live };
  const p = runProgress(live, { runs: a, brief: FIVE, now: T0 + 10 * 60000 });
  assert.deepEqual([p.pace.sessions, p.pace.estimate], [1, { min: 80, n: 2, from: 'the lane\'s own stages' }]);   // median of 60, 100
  // the next fold: a hand-off session of S3 before RUN-9, a third done stage of 20 min
  const b = { ...a, 'RUN-5': ended('RUN-5', 'S3', -30, -10, 'handoff'), 'RUN-6': ended('RUN-6', 'S4', -100, -80) };
  const q = runProgress(live, { runs: b, brief: FIVE, now: T0 + 10 * 60000 });
  assert.deepEqual([q.pace.sessions, q.pace.handoffs, q.pace.estimate], [2, 1, { min: 60, n: 3, from: 'the lane\'s own stages' }]);
  assert.deepEqual(laneSteps('demo', b, T0).last, 'S4 done 1 h 20 min ago (RUN-6)');
  assert.deepEqual(laneSteps('demo', a, T0).last, 'S2 done 3 h 20 min ago (RUN-2)');
});

test('mergeWork: a stage\'s sessions as one fold - calls in order, a commit seen in an earlier session once, the open calls and last of the newest', () => {
  const w = (n, shas, o = {}) => ({ ...workInit(), calls: [{ kind: 'edit', n }], commits: shas.map(sha => ({ sha, n })), first: `f${n}`, last: `l${n}`, open: { [n]: { n } }, ...o });
  const m = mergeWork([w(1, ['a', 'b']), null, w(2, ['b', 'c']), w(3, ['c', 'd'], { last: null })]);
  assert.deepEqual(m.calls.map(c => c.n), [1, 2, 3]);
  assert.deepEqual(m.commits.map(c => `${c.sha}${c.n}`), ['a1', 'b1', 'c2', 'd3']);
  assert.deepEqual([m.first, m.last, Object.keys(m.open)], ['f1', 'l2', ['3']]);
  const one = w(1, ['a']), s = mergeWork([one]);
  s.calls.push({}); assert.equal(one.calls.length, 1, 'the cached fold is not changed by its reader');
  assert.deepEqual(mergeWork([]), workInit());
});

test('one long test is not a stall: an open test call reads "running a test for N min, limit M min"; a background test process too; no test = stalled', () => {
  const edit = call(0, 1, 'Edit', { file_path: '/fx/repo/engine/lib/dlvwhy.mjs' }), r = run('RUN-326', { created: iso(0), data: { lane: 'demo', stage: 'MERGE' } });
  // the owner's case: one test file 17 min into a `timeout 1500` (25 min), nothing else moved for 34 min
  const recs = [edit, [{ type: 'assistant', timestamp: iso(17), message: { content: [{ type: 'tool_use', id: 'long', name: 'Bash', input: { command: 'cd wt && timeout 1500 node --test tests/dlv-merged-truth.test.mjs', timeout: 600000 } }] } }]];
  const p = runProgress(r, { runs: { 'RUN-326': r }, brief: FIVE, work: work(recs), now: T0 + 34 * 60000 });
  assert.equal(p.pace.state, 'testing');
  assert.equal(p.pace.still_min, null);
  assert.match(p.pace.words, /^running a test for 17 min, limit 25 min \(dlv-merged-truth\.test\.mjs\)/);
  assert.deepEqual(p.pace.test, { min: 17, limit_min: 25, what: 'dlv-merged-truth.test.mjs', from: 'call' });
  // past its limit it says so
  assert.match(runProgress(r, { runs: { 'RUN-326': r }, brief: FIVE, work: work(recs), now: T0 + 50 * 60000 }).pace.words, /^running a test for 33 min, limit 25 min \(dlv-merged-truth\.test\.mjs\) - past its limit/);
  // no timeout arg: the tool call's own timeout is the limit
  const w2 = work([edit, [{ type: 'assistant', timestamp: iso(20), message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'node --test tests/a.test.mjs', timeout: 600000 } }] } }]]);
  assert.equal(runProgress(r, { runs: { 'RUN-326': r }, brief: FIVE, work: w2, now: T0 + 34 * 60000 }).pace.test.limit_min, 10);
  // a test started in the background: the transcript call has its result, the process under the run's pid is still running
  const bg = work([edit, call(10, 10, 'Bash', { command: 'node --test tests/x.test.mjs', run_in_background: true }, 'Command running in background with ID: b1')]);
  const procs = [{ pid: 100, ppid: 1, cmd: 'claude.exe -p' }, { pid: 200, ppid: 100, cmd: 'bash -c "timeout 25m node --test tests/x.test.mjs"', created: T0 + 10 * 60000 },
    { pid: 300, ppid: 200, cmd: 'node --test tests/x.test.mjs', created: T0 + 10 * 60000 }, { pid: 400, ppid: 9, cmd: 'node --test tests/other.test.mjs', created: T0 }];
  const b = runProgress(r, { runs: { 'RUN-326': r }, brief: FIVE, work: bg, procs, pid: 100, now: T0 + 40 * 60000 });
  assert.equal(b.pace.state, 'testing');
  assert.match(b.pace.words, /^running a test for 30 min, limit 25 min \(x\.test\.mjs\) - past its limit/);
  // the same run with no test process under it (another run's test does not count) is stalled
  const s = runProgress(r, { runs: { 'RUN-326': r }, brief: FIVE, work: bg, procs: procs.filter(x => x.pid < 200 || x.pid === 400), pid: 100, now: T0 + 40 * 60000 });
  assert.equal(s.pace.state, 'stalled');
  assert.match(s.pace.words, /^stalled: no commit, edit or test change for (30|39) min/);
});

// issue #153: a check-in is its own piece of work, and no run is stalled for longer than it has existed
const ended = (id, created, endAt, data, outcome = 'done') => ({ id, kind: 'run', state: 'exited', created, updated: endAt, end: { outcome }, history: [{ ev: 'end', ts: endAt }], data });
const CK = { kind: 'checkin', lane: 'checkin', stage: undefined, agent: 'checkin' };   // a check-in's lane has no stage
test('a live check-in 60 s old after 3 ended check-ins (one re-ran a test 6 times, 2 h ago) and an old mail: 1 session, 1 min, not stalled, no repeat or mail reason', () => {
  const runs = { 'RUN-1': ended('RUN-1', iso(-300), iso(-299), CK), 'RUN-2': ended('RUN-2', iso(-200), iso(-120), CK), 'RUN-3': ended('RUN-3', iso(-60), iso(-59), CK),
    'RUN-4': run('RUN-4', { created: iso(0), data: CK }) };
  const old = []; for (let i = 0; i < 6; i++) old.push(call(-200 + i * 10, -195 + i * 10, 'Bash', { command: 'node --test tests/a.test.mjs tests/b.test.mjs' }, 'ℹ pass 3\nℹ fail 0'));
  const folds = { 'RUN-2': work(old), 'RUN-4': work([]) };
  const sess = sessionsOf(runs['RUN-4'], runs);
  assert.deepEqual(sess.map(r => r.id), ['RUN-4'], 'the earlier check-ins are not sessions of this one');
  const AU = { kind: 'audit', lane: 'audit', stage: 'audit' }, au = { 'RUN-5': ended('RUN-5', iso(-90), iso(-80), AU), 'RUN-6': run('RUN-6', { created: iso(0), data: AU }) };
  assert.deepEqual(sessionsOf(au['RUN-6'], au).map(r => r.id), ['RUN-6'], 'an audit (a standing lane too) is its own session');
  const mail = { id: 'MAIL-7', kind: 'mail', created: iso(-150), data: { to: 'lane:checkin', subject: 'Owner: look at the queue' } };
  const p = runProgress(runs['RUN-4'], { runs, brief: FIVE, mails: [mail], work: mergeWork(sess.map(r => folds[r.id] ?? null)), now: T0 + 60000 });
  assert.notEqual(p.pace.state, 'stalled');
  assert.deepEqual([p.pace.sessions, p.pace.handoffs, p.pace.elapsed_min], [1, 0, 1]);
  assert.equal(p.slow.repeats, null);
  assert.ok(!p.slow.reasons.some(x => /mail|re-run/.test(x)), p.slow.reasons.join('; '));
  assert.ok(!p.items.some(x => x.mail), 'a check-in has no brief Scope: a mail adds no item');
});

test('a live round-2 worker run 2 min old whose round 1 last moved 3 h ago is not stalled; its stall clock starts at its own start', () => {
  const runs = { 'RUN-1': ended('RUN-1', iso(-240), iso(-170), { kind: 'worker', lane: 'demo', stage: 'S1', agent: 'implementer' }),
    'RUN-2': run('RUN-2', { created: iso(0), data: { lane: 'demo', stage: 'S1' } }) };
  const w = work([call(-200, -180, 'Edit', { file_path: '/fx/repo/a.mjs' })]);
  const p = runProgress(runs['RUN-2'], { runs, brief: FIVE, work: w, now: T0 + 2 * 60000 });
  assert.notEqual(p.pace.state, 'stalled');
  assert.equal(p.pace.still_min, null);
  // still quiet 40 min into its own life: stalled for 40 min (its own age), not 3 h
  const q = runProgress(runs['RUN-2'], { runs, brief: FIVE, work: w, now: T0 + 40 * 60000 });
  assert.equal(q.pace.state, 'stalled');
  assert.equal(q.pace.still_min, 40);
});

test('a hand-off chain still sums its sessions: 2 ended hand-offs + the live session = 3 sessions, their time summed', () => {
  const d = { kind: 'worker', lane: 'demo', stage: 'S2', agent: 'implementer' };
  const runs = { 'RUN-1': ended('RUN-1', iso(-100), iso(-70), d, 'handoff'), 'RUN-2': ended('RUN-2', iso(-70), iso(-50), d, 'handoff'), 'RUN-3': run('RUN-3', { created: iso(0), data: d }) };
  const p = runProgress(runs['RUN-3'], { runs, brief: FIVE, work: work([call(1, 2, 'Edit', { file_path: '/fx/repo/a.mjs' })]), now: T0 + 10 * 60000 });
  assert.deepEqual([p.pace.sessions, p.pace.handoffs, p.pace.elapsed_min], [3, 2, 60]);
  assert.match(p.pace.words, /session 3 \(2 hand-offs\)/);
});
