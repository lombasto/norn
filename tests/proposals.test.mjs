// RM-28 S1: a finished planner run = a proposal (proposals.mjs) - its summary, plan path and stages from the notes folder; each stage
// ruled queue / later / drop by `norn proposal rule`: one decision each, queue = a queued run of the brief linked to the roadmap item,
// later = a child roadmap item (horizon next), drop = the decision only; a ruled or launched stage leaves the open list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { proposalsOf, summaryOf, briefTitle, openStage, queueArgv } from '../engine/lib/proposals.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const READY = '\nScope: engine/lib/**\nTests: tests/x.test.mjs\nDone: it works.\n';
const NOTES = `# sizing / plan (RUN-1)\n\nDesign run.\n\n## Summary for the owner (10 lines)\n\n${Array.from({ length: 12 }, (_, i) => `${i + 1}. point ${i + 1}`).join('\n')}\n\n## Checked\n\n- x\n\n## DONE\n`;

/** a state with one planner run that ended DONE (notes folder: NOTES.md, SIZING.md, brief-S1..S3) + a theme and an item linking its lane */
function fixture({ outcome = 'done', agent = 'planner', item = true, executor = 'fake' } = {}) {
  const root = mkTmp('proposals'), state = path.join(root, 'state'), notesDir = path.join(state, 'notes', 'sizing'), wt = path.join(root, 'wt');
  fs.mkdirSync(notesDir, { recursive: true }); fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(notesDir, 'NOTES.md'), NOTES.replace('Design run.', 'Design run. Plan: `SIZING.md`.'));
  fs.writeFileSync(path.join(notesDir, 'SIZING.md'), '# the plan\n');
  for (const [k, t] of [['S1', 'record the marks'], ['S2', 'show the verdict'], ['S10', 'split lanes']]) fs.writeFileSync(path.join(notesDir, `brief-${k}.md`), `# sizing / ${k}: ${t} (roadmap RM-2)\n${READY}`);
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor, lane: 'sizing', stage: 'plan', agent, worktree: wt, brief: path.join(state, 'b.md'), notes: path.join(notesDir, 'NOTES.md') } });
  record(state, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome } });
  if (item) {
    record(state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'theme', title: 'Engine' } }, { views: false });
    record(state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'item', title: 'Sizing', parent: 'RM-1', horizon: 'now', links: ['lane:sizing'] } }, { views: false });
  }
  return { root, state, notesDir, wt };
}
const props = (state, o) => proposalsOf(loadState(state).items, loadRoadmap(state), o);
const norn = (args, root) => spawnSync(process.execPath, [NORN, ...args], { encoding: 'utf8', env: { ...process.env, META_ROOT: root, META_STATE: '', META_PROJECT: '' } });

test('summaryOf: the lines under the summary heading, at most 10; none without one. briefTitle: the words after "S<n>:"', () => {
  assert.deepEqual(summaryOf(NOTES), Array.from({ length: 10 }, (_, i) => `${i + 1}. point ${i + 1}`));
  assert.deepEqual(summaryOf('# x\n\n## Findings\n\n- a\n'), []);
  assert.equal(briefTitle('# sizing / S3: one resolver (roadmap RM-25)\n\nbody'), 'one resolver (roadmap RM-25)');
  assert.equal(briefTitle('no heading'), '');
});

test('proposalsOf: a planner DONE with briefs = one proposal (summary, plan first, stages in number order, the lane item); others none', () => {
  const { state, notesDir } = fixture();
  const [p, ...rest] = props(state);
  assert.equal(rest.length, 0);
  assert.equal(p.run, 'RUN-1'); assert.equal(p.lane, 'sizing'); assert.equal(p.item, 'RM-2'); assert.equal(p.summary.length, 10); assert.equal(p.open, 3);
  assert.deepEqual(p.plans, [path.join(notesDir, 'SIZING.md').replace(/\\/g, '/')]);
  assert.deepEqual(p.stages.map(s => [s.key, s.title, s.state]), [['S1', 'record the marks (roadmap RM-2)', 'open'], ['S2', 'show the verdict (roadmap RM-2)', 'open'], ['S10', 'split lanes (roadmap RM-2)', 'open']]);
  for (const o of [{ outcome: 'stopped' }, { agent: 'implementer' }]) assert.deepEqual(props(fixture(o).state), [], JSON.stringify(o));
  const e = fixture(); for (const f of fs.readdirSync(e.notesDir).filter(x => x.startsWith('brief-'))) fs.unlinkSync(path.join(e.notesDir, f));
  assert.deepEqual(props(e.state), [], 'no brief = no proposal');
});

test('a stage a run was already launched from (the check-in did it by hand) is "launched", not open', () => {
  const { state, notesDir, wt } = fixture();
  record(state, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'sizing', stage: 'S1', worktree: wt, brief: path.join(notesDir, 'brief-S1.md') } });
  const [p] = props(state);
  assert.deepEqual(p.stages.map(s => s.state), ['launched', 'open', 'open']);
  assert.equal(p.stages[0].ref, 'RUN-2');
  assert.match(openStage(props(state), 'RUN-1', 's1').why, /decided already: launched -> RUN-2/);
  assert.deepEqual(queueArgv(p, p.stages[1]).slice(0, 9), ['run', '--queue', '--executor', 'fake', '--lane', 'sizing', '--stage', 'S2', '--brief']);
});

test('norn proposal rule: queue = a queued run of the brief (--item) + a decision; later = a child item horizon next; drop = a decision', () => {
  const { root, state, notesDir } = fixture();
  let r = norn(['proposal', 'rule', 'RUN-1', 'S1', 'queue', '--state', state, '--as', 'dashboard'], root);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /(QUEUED|STARTED) RUN-2 lane sizing/, 'queued; the fill starts it at once when a slot is free'); assert.match(r.stdout, /DEC-1 RUN-1 S1: queue -> RUN-2/);
  const s = loadState(state), q = s.items['RUN-2'], d = s.items['DEC-1'];
  assert.ok(['queued', 'running', 'exited'].includes(q.state), q.state); assert.equal(q.data.stage, 'S1'); assert.equal(q.data.lane, 'sizing');
  assert.equal(path.resolve(q.data.brief), path.resolve(notesDir, 'brief-S1.md'));
  assert.equal(path.resolve(q.data.notes), path.resolve(notesDir, 'NOTES-S1.md'));
  assert.ok(loadRoadmap(state).items['RM-2'].links.includes('run:RUN-2'), '--item links the run to the roadmap item');
  assert.deepEqual([d.by, d.data.proposal, d.data.stage, d.data.pick, d.data.run], ['dashboard', 'RUN-1', 'S1', 'queue', 'RUN-2']);

  r = norn(['proposal', 'rule', 'RUN-1', 'S2', 'later', '--state', state, '--as', 'owner'], root);
  assert.equal(r.status, 0, r.stderr);
  const it = loadRoadmap(state).items['RM-3'];
  assert.deepEqual([it.kind, it.parent, it.horizon, it.title], ['item', 'RM-2', 'next', 'sizing S2: show the verdict (roadmap RM-2)']);
  assert.deepEqual(it.links, ['doc:' + path.join(notesDir, 'brief-S2.md').replace(/\\/g, '/')]);
  assert.deepEqual(loadState(state).items['DEC-2'].data.item, 'RM-3');

  r = norn(['proposal', 'rule', 'RUN-1', 'S10', 'drop', '--state', state, '--as', 'owner'], root);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loadState(state).items['DEC-3'].data.pick, 'drop');
  assert.deepEqual(props(state), [], 'every stage ruled: the proposal leaves the open list');
  assert.deepEqual(props(state, { all: true })[0].stages.map(x => [x.state, x.ref]), [['queue', 'RUN-2'], ['later', 'RM-3'], ['drop', null]]);

  r = norn(['proposal', 'rule', 'RUN-1', 'S1', 'drop', '--state', state, '--as', 'owner'], root);
  assert.equal(r.status, 2); assert.match(r.stderr, /decided already: queue \(DEC-1\) -> RUN-2/);
  r = norn(['proposal', 'list', '--state', state], root);
  assert.equal(r.status, 0); assert.equal(r.stdout.trim(), 'no open proposal');
});

test('norn proposal rule refuses: later with no roadmap item, a launch the launcher refuses (nothing recorded), no role, a bad pick', () => {
  const { root, state } = fixture({ item: false, executor: 'nosuch' });
  let r = norn(['proposal', 'rule', 'RUN-1', 'S1', 'later', '--state', state, '--as', 'owner'], root);
  assert.equal(r.status, 2); assert.match(r.stderr, /no open roadmap item/);
  r = norn(['proposal', 'rule', 'RUN-1', 'S2', 'queue', '--state', state, '--as', 'owner'], root);
  assert.equal(r.status, 2); assert.match(r.stderr, /nosuch[\s\S]*launch was refused \(exit 2\); nothing recorded/);
  assert.deepEqual(Object.values(loadState(state).items).filter(i => i.kind === 'decision'), []);
  r = norn(['proposal', 'rule', 'RUN-1', 'S1', 'drop', '--state', state], root);
  assert.equal(r.status, 2); assert.match(r.stderr, /no role/);
  r = norn(['proposal', 'rule', 'RUN-1', 'S1', 'maybe', '--state', state, '--as', 'owner'], root);
  assert.equal(r.status, 2); assert.match(r.stderr, /queue\|later\|drop/);
  r = norn(['proposal', 'list', '--state', state, '--json'], root);
  assert.equal(JSON.parse(r.stdout)[0].open, 3);
});
