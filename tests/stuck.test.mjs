// META-CATCH S1 piece 2 + 3: the stuck-item alarm (stuck.mjs) on synthetic records - the fold and its three thresholds, the merge
// reset, the roadmap row words, the tick's one notice per flag, the gate fact + wake text, the run refusal and its approach review,
// the replay. No test sleeps: every clock is a passed timestamp.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stuckTimeline, stuckOf, stuckSweep, stuckProbe, stuckWake, stuckRefusal, reviewBrief, replayLines, readStuck } from '../engine/lib/stuck.mjs';
import { worldOf, derive, renderItem, reach } from '../engine/lib/roadmap.mjs';
import { record } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const H = 36e5, T0 = Date.parse('2030-01-06T08:00:00Z');
const iso = t => new Date(t).toISOString();
const POL = { stopped_rounds: 3, runs_without_merge: 8, days_without_merge: 3 };
let n = 0;
/** a synthetic ended work run: start at h hours after T0, ends 1 h later with outcome (why for stopped) */
const run = (h, outcome, o = {}) => ({ id: `RUN-${++n}`, kind: 'run', state: outcome ? 'exited' : 'running', created: iso(T0 + h * H),
  data: { kind: 'worker', lane: 'water', stage: 'FIX', executor: 'claude', model: 'm-a', ...o.data },
  history: [{ ev: 'start', ts: iso(T0 + h * H) }, ...(outcome ? [{ ev: 'end', ts: iso(T0 + (h + 1) * H) }] : [])],
  end: outcome ? { outcome, ...(outcome === 'stopped' ? { why: o.why || `check failed at h${h}` } : {}) } : undefined });

test('fold: the third stopped round in a row fires stopped_rounds at its end; a handoff neither counts nor breaks, a done breaks', () => {
  const rs = [run(0, 'stopped'), run(2, 'handoff'), run(4, 'stopped'), run(6, 'stopped')];
  const { fires } = stuckTimeline(rs, [], POL, T0 + 10 * H);
  assert.deepEqual(fires, [{ ts: iso(T0 + 7 * H), threshold: 'stopped_rounds', value: 3 }]);
  const broken = [run(0, 'stopped'), run(2, 'stopped'), run(4, 'done'), run(6, 'stopped'), run(8, 'stopped')];
  assert.deepEqual(stuckTimeline(broken, [], POL, T0 + 10 * H).fires, [], 'done breaks the row: 2 + 2 never reach 3');
  const s = stuckOf(rs, [], POL, T0 + 10 * H);
  assert.equal(s.stopped_row, 3); assert.equal(s.runs, 4); assert.deepEqual(s.flag, { ts: iso(T0 + 7 * H), why: ['3 stopped in a row'] });
  assert.deepEqual(s.reasons.map(x => x.why), ['check failed at h0', 'check failed at h4', 'check failed at h6'], 'the last three stop reasons');
});

test('#161: an approach-review run is never a round of the flag it reviews: its stop neither counts nor joins the rounds', () => {
  const rs = [run(0, 'stopped'), run(2, 'stopped'), run(4, 'stopped')], review = run(8, 'stopped', { data: { stage: 'approach-review', executor: 'codex', model: 'm-b' } });
  const s = stuckOf([...rs, review], [], POL, T0 + 10 * H);
  assert.equal(s.runs, 3); assert.equal(s.stopped_row, 3);
  assert.deepEqual(s.rounds.map(x => `${x.executor}/${x.model}`), ['claude/m-a', 'claude/m-a', 'claude/m-a'], 'the reviewer\'s model is not a stuck model');
  assert.ok(!s.reasons.some(x => x.run === review.id));
});

test('fold: runs_without_merge fires at the n-th start, days_without_merge at the first run + d days; 0 switches a threshold off', () => {
  const rs = Array.from({ length: 8 }, (_, i) => run(i * 2, 'handoff'));
  assert.deepEqual(stuckTimeline(rs, [], POL, T0 + 20 * H).fires, [{ ts: iso(T0 + 14 * H), threshold: 'runs_without_merge', value: 8 }]);
  assert.deepEqual(stuckTimeline(rs, [], { ...POL, runs_without_merge: 0 }, T0 + 20 * H).fires, [], '0 = off');
  const slow = [run(0, 'handoff'), run(30, 'handoff')];
  assert.deepEqual(stuckTimeline(slow, [], POL, T0 + 71 * H).fires, [], 'not yet 3 days');
  assert.deepEqual(stuckTimeline(slow, [], POL, T0 + 73 * H).fires, [{ ts: iso(T0 + 72 * H), threshold: 'days_without_merge', value: 3 }]);
  assert.deepEqual(stuckTimeline(slow, [], { ...POL, days_without_merge: 0 }, T0 + 99 * H).fires, []);
  assert.equal(stuckOf(slow, [], POL, T0 + 73 * H).flag.why[0], '3 days without a merge');
});

test('fold: a merge resets the episode (no flag after it until a threshold is crossed again); a merge run and a past item never flag', () => {
  const rs = [run(0, 'stopped'), run(2, 'stopped'), run(4, 'stopped'), run(8, 'stopped')];
  const merged = stuckOf(rs, [T0 + 6 * H], POL, T0 + 10 * H);
  assert.equal(merged.flag, null); assert.equal(merged.stopped_row, 1); assert.equal(merged.runs, 1); assert.equal(merged.last_merge, iso(T0 + 6 * H));
  assert.equal(stuckTimeline(rs, [T0 + 6 * H], POL, T0 + 10 * H).fires.length, 1, 'the replay keeps the crossing before the merge');
  const mq = [run(0, 'stopped', { data: { stage: 'MERGE' } }), run(2, 'stopped', { data: { stage: 'MERGE' } }), run(4, 'stopped', { data: { stage: 'MERGE' } })];
  assert.equal(stuckOf(mq, [], POL, T0 + 10 * H).runs, 0, 'a merge run is no round');
  assert.equal(stuckOf(rs, [], POL, T0 + 10 * H, { past: true }).flag, null);
});

test('roadmap: derive carries the fold (policy.stuck from the world) and road show prints "n runs, d days, k stopped in a row"', () => {
  const rs = [run(0, 'stopped'), run(2, 'stopped'), run(4, 'stopped')];
  const items = Object.fromEntries(rs.map(r => [r.id, r]));
  const node = { id: 'RM-7', kind: 'item', title: 'water picture', state: 'open', links: ['lane:water'], stages: [] };
  const W = worldOf({ now: T0 + 50 * H, items, policy: { stuck: { stopped_rounds: 3 } } });
  const d = derive(node, W);
  assert.equal(d.stuck.flag.ts, iso(T0 + 5 * H));
  const lines = renderItem({ ...node, ...d, flags: { claimed: null, drift: [], idle: null, gone: [] }, children: [] });
  assert.ok(lines.some(l => /3 runs, 2 days, 3 stopped in a row - STUCK since 2030-01-06T13:00Z: 3 stopped in a row/.test(l)), lines.join('\n'));
  const off = derive(node, worldOf({ now: T0 + 50 * H, items, policy: { stuck: { stopped_rounds: 0, runs_without_merge: 0, days_without_merge: 0 } } }));
  assert.equal(off.stuck.flag, null, 'every threshold 0 = no flag');
});

test('land-reuse (DEC-b-56): a deliverable\'s merged events reset the clock after a newer DONE (state done); a git-found merged row with none keeps its round\'s end', () => {
  const rs = [run(0, 'stopped'), run(2, 'stopped'), run(4, 'stopped'), run(6, 'stopped')];
  const items = Object.fromEntries(rs.map(r => [r.id, r]));
  const node = { id: 'RM-7', kind: 'item', title: 'water picture', state: 'open', links: ['lane:water'], stages: [] };
  const dlv = { id: 'DLV-1', branch: 'norn/water', lane: 'water', state: 'done', done_utc: iso(T0 + 7 * H), merges: [iso(T0 + 3.5 * H)] };
  const W = worldOf({ now: T0 + 10 * H, items, dlv: [dlv], policy: { stuck: POL } });
  assert.deepEqual(reach(node, W).branches[0].merges, [T0 + 3.5 * H], 'reach carries the deliverable\'s merges');
  const d = derive(node, W);
  assert.equal(d.stuck.last_merge, iso(T0 + 3.5 * H), 'the earlier round\'s merge still counts');
  assert.equal(d.stuck.stopped_row, 2); assert.equal(d.stuck.flag, null);
  const git = derive(node, worldOf({ now: T0 + 10 * H, items, dlv: [{ ...dlv, state: 'merged', merges: [] }], policy: { stuck: POL } }));
  assert.equal(git.stuck.last_merge, iso(T0 + 7 * H), 'merged by git, not yet latched: its round\'s end');
});

function sandbox() {
  const t = mkTmp('meta-stuck-'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(state, { recursive: true });
  return { t, state };
}
const flagged = (over = {}) => ({ id: 'RM-7', title: 'water picture', links: ['lane:water'],
  stuck: { runs: 3, days: 2, stopped_row: 3, reasons: [{ run: 'RUN-1', ts: iso(T0), why: 'a' }, { run: 'RUN-2', ts: iso(T0), why: 'b' }, { run: 'RUN-3', ts: iso(T0), why: 'c' }],
    rounds: [{ executor: 'claude', model: 'm-a' }], flag: { ts: iso(T0 + 5 * H), why: ['3 stopped in a row'] }, ...over } });

test('tick sweep: a new flag = ONE notice (stuck.json noticed); the same flag again = none; a cleared flag leaves stuck.json', () => {
  const { state } = sandbox();
  const a = stuckSweep(state, [flagged()], { project: 'demo' });
  assert.equal(a.notices.length, 1); assert.match(a.notices[0].title, /RM-7 stuck - 3 stopped in a row/); assert.match(a.notices[0].body, /norn stuck brief RM-7/);
  assert.deepEqual(readStuck(state)['RM-7'].lanes, ['water']);
  assert.equal(stuckSweep(state, [flagged()], { project: 'demo' }).notices.length, 0, 'one notice per flag');
  assert.equal(stuckSweep(state, [flagged({ flag: { ts: iso(T0 + 99 * H), why: ['8 runs without a merge'] } })]).notices.length, 1, 'a new flag after a reset notices again');
  stuckSweep(state, [flagged({ flag: null })]);
  assert.deepEqual(readStuck(state), {}, 'a merged round clears it');
});

test('gate: an open flag is the fact stuck:RM-n; the wake text carries the last three stop reasons side by side', () => {
  const { state } = sandbox();
  assert.deepEqual(stuckProbe(state)(), []);
  stuckSweep(state, [flagged()]);
  assert.deepEqual(stuckProbe(state)(), ['stuck:RM-7']);
  const w = stuckWake(state, 'changed: stuck:RM-7');
  assert.match(w, /RM-7 stuck \(3 stopped in a row; 3 runs, 2 days, 3 stopped in a row\); last stops:\n {2}RUN-1 .*: a\n {2}RUN-2 .*: b\n {2}RUN-3 .*: c/);
  assert.equal(stuckWake(state, 'changed: run:RUN-9'), '', 'no stuck fact in the wake = no lines');
});

test('run refusal: a round on a stuck item is refused until an approach review newer than the flag, by the owner or another executor / model', () => {
  const { state } = sandbox();
  stuckSweep(state, [flagged()]);
  assert.match(stuckRefusal(state, { lane: 'water' }), /^stuck: approach review owed on RM-7/);
  assert.match(stuckRefusal(state, { lane: 'other', item: 'RM-7' }), /approach review owed/, '--item names it too');
  assert.equal(stuckRefusal(state, { lane: 'other' }), null, 'another lane goes');
  assert.equal(stuckRefusal(state, { lane: 'water', stage: 'APPROACH-REVIEW', executor: 'codex', model: 'm-b' }), null, 'the review run on another executor goes');
  assert.match(stuckRefusal(state, { lane: 'water', stage: 'APPROACH-REVIEW', executor: 'claude', model: 'm-a' }), /owed/, 'not by the stuck executor / model');
  const dec = (by, at, o = {}) => record(state, { kind: 'decision', ev: 'create', by, data: { lane: 'water', question: 'RM-7 approach review', choice: 'change', why: 'w', approach_review: 'RM-7' } }, { now: () => new Date(at), ...o });
  const same = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', lane: 'water', executor: 'claude', model: 'm-a' } }).id;
  const other = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', lane: 'water', executor: 'codex', model: 'm-b' } }).id;
  dec('owner', T0);   // older than the flag
  dec('controller', T0 + 9 * H, { run: same });   // the stuck executor / model
  assert.match(stuckRefusal(state, { lane: 'water' }), /owed/, 'an old review or one by the stuck rounds does not count');
  assert.deepEqual(stuckProbe(state)(), ['stuck:RM-7']);
  dec('controller', T0 + 9 * H, { run: other });
  assert.equal(stuckRefusal(state, { lane: 'water' }), null, 'a review by another executor / model frees the item');
  assert.deepEqual(stuckProbe(state)(), [], 'and the fact leaves');
  assert.throws(() => record(state, { kind: 'decision', ev: 'create', by: 'owner', data: { lane: 'water', question: 'q', choice: 'c', why: 'w', approach_review: 'DEC-1' } }), /approach_review must name a roadmap item/);
});

test('DEC-a-682 item 5: a worker run of stage APPROACH-REVIEW records its one decision itself; it clears the flag. Every other worker decision is refused, saying why', () => {
  const { state } = sandbox();
  stuckSweep(state, [flagged()]);
  const start = (stage, executor = 'codex', model = 'm-b') => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', lane: 'water', stage, executor, model } }).id;
  const data = (o = {}) => ({ lane: 'water', question: 'RM-7 approach review', choice: 'change', why: 'w', approach_review: 'RM-7', ...o });
  const dec = (run, d = data()) => record(state, { kind: 'decision', ev: 'create', by: 'worker', data: d }, { run, now: () => new Date(T0 + 9 * H) });
  const fix = start('FIX'), review = start('approach-review'), bare = start('APPROACH-REVIEW');
  assert.throws(() => dec(fix), /role worker may record one decision, only from stage APPROACH-REVIEW with --approach-review RM-n: RUN-\S+ is stage FIX/, 'another stage');
  assert.throws(() => dec(null), /role worker may record one decision.*no run id/, 'no run');
  const { approach_review: _a, ...noReview } = data();
  assert.throws(() => dec(bare, noReview), /role worker may record one decision.*no --approach-review/, 'no approach_review');
  assert.match(stuckRefusal(state, { lane: 'water' }), /owed/, 'nothing recorded yet');
  const id = dec(review).id;
  assert.equal(stuckRefusal(state, { lane: 'water' }), null, 'the review run\'s decision (another executor / model) frees the item');
  assert.throws(() => dec(review, data({ choice: 'keep' })), new RegExp(`role worker may record one decision.*${review} already recorded ${id}`), 'a second decision by that run');
  assert.throws(() => record(state, { kind: 'decision', ev: 'supersede', id, by: 'worker', data: { by: id, why: 'w' } }, { run: review }), /role worker may not decision supersede/, 'no other worker write widens');
});

test('norn run: a round on a stuck item is REFUSED (exit 7); the owner\'s approach review lets it go', () => {
  const { t, state } = sandbox();
  stuckSweep(state, [flagged({ flag: { ts: iso(Date.now() - H), why: ['3 stopped in a row'] } })]);   // the CLI's decision is dated now
  const wt = path.join(t, 'wt'); fs.mkdirSync(wt); const bf = path.join(t, 'brief.md'); fs.writeFileSync(bf, 'Scope: a\nTests: b\nDone: c\n');
  const env = { ...process.env, META_ROOT: t, HOME: t, USERPROFILE: t, META_HB_MS: '150' };
  const go = () => spawnSync(process.execPath, [NORN, 'run', '--executor', 'fake', '--state', state, '--locks', path.join(t, 'locks'), '--lane', 'water', '--brief', bf, '--worktree', wt,
    '--notes', path.join(t, 'NOTES.md'), '--no-tick', '--queue'], { encoding: 'utf8', env });
  const a = go();
  assert.equal(a.status, 7, a.stdout + a.stderr); assert.match(a.stdout, /^REFUSED: stuck: approach review owed on RM-7/m);
  const d = spawnSync(process.execPath, [NORN, 'rec', 'add', 'decision', '--state', state, '--as', 'owner', '--lane', 'water', '--question', 'RM-7 approach review', '--choice', 'change the approach',
    '--why', 'the first cause is still open', '--approach-review', 'RM-7'], { encoding: 'utf8', env });
  assert.equal(d.status, 0, d.stdout + d.stderr);
  const b = go();
  assert.notEqual(b.status, 7, b.stdout + b.stderr); assert.doesNotMatch(b.stdout, /REFUSED: stuck/);
});

test('review brief + replay: the brief names the first diagnosis, the stop reasons and the two questions; the replay prints each crossing', () => {
  const rs = [run(0, 'stopped', { why: 'the diagnosis: cause A' }), run(2, 'stopped'), run(4, 'stopped')];
  rs[0].end.summary = undefined;
  const node = { id: 'RM-7', kind: 'item', title: 'water picture', state: 'open', links: ['lane:water'], stages: [] };
  const W = worldOf({ now: T0 + 80 * H, items: Object.fromEntries(rs.map(r => [r.id, r])), policy: {} });
  const b = reviewBrief('RM-7', { ...node, ...derive(node, W) }, reach(node, W).runs);
  assert.match(b, /## The first diagnosis\nRUN-\d+ \(FIX, stopped\): the diagnosis: cause A/);
  assert.match(b, /Is the approach wrong\?/); assert.match(b, /Which diagnosed cause is still open\?/); assert.match(b, /--approach-review RM-7/);
  assert.deepEqual(replayLines([node], W, W.stuck, reach), [`RM-7: ${iso(T0 + 5 * H).slice(0, 16)}Z stopped_rounds = 3`, `RM-7: ${iso(T0 + 72 * H).slice(0, 16)}Z days_without_merge = 3`]);
});
