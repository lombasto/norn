// RM-39: a run's progress against its brief, its pace, why it is slow and its alarms in words (engine/lib/progress.mjs), on fixtures
// trimmed from real runs: norn RUN-123 + RUN-148 (lane-purpose S1, two sessions; tests/fixtures/progress - tool calls and their
// commit / test lines only, home paths replaced) and small hand-made transcripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefPlan, workInit, onWork, checklist, doneLines, runProgress, alarmWords, testCounts } from '../engine/lib/progress.mjs';

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
