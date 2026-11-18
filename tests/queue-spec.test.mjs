// META-QUEUE-SPEC R1 (RUN-819: RUN-814 was queued before policy.launch.memory existed and filled after it - it launched with no memory
// key): a queued run takes the CURRENT project policy at fill time (memory, launch profile, model / effort / agent, the class table);
// what the dispatcher gave on the command line (--model / --effort / --agent / --class) stays as given. Temp state + the fake executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fillQueue, readiness } from '../engine/lib/runs.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { runEnded } from './helpers/wait.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');

function sandbox(policy, executors = {}) {
  const t = mkTmp('meta-queue-spec-');
  const d = { t, state: path.join(t, 'state', 'p'), wt: path.join(t, 'wt'), brief: path.join(t, 'brief.md'), project: path.join(t, 'project.json') };
  fs.mkdirSync(d.state, { recursive: true }); fs.mkdirSync(d.wt); fs.mkdirSync(path.join(t, 'local'));
  fs.writeFileSync(d.brief, 'mode: done\n');
  d.policy = (pol, ex = executors) => fs.writeFileSync(d.project, JSON.stringify({ schema: 1, name: 'p', title: 'P', root: t.replace(/\\/g, '/'), executors: ex, policy: pol }));
  d.policy(policy);
  d.cli = args => {
    const r = spawnSync(process.execPath, [META, 'run', '--executor', 'fake', '--project', d.project, '--state', d.state, '--brief', d.brief, '--worktree', d.wt, '--no-tick', ...args],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROOT: t, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_RUN_ID: '', META_NO_TICK: '1' } });
    return { code: r.status, out: r.stdout.trim() + r.stderr.trim() };
  };
  // CI-RED-A0994AB: the started run's supervisor outlived the file on Linux (LEAK RED): each test awaits it settled (runEnded)
  // a synthetic RUN the queued run waits on (after run:RUN-1:done); its end lets the fill start it
  d.gate = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', executor: 'fake', lane: 'gate', worktree: d.wt } }, { views: false }).id;
  d.open = () => record(d.state, { kind: 'run', ev: 'end', id: d.gate, by: 'launcher', data: { exit: 0, outcome: 'done' } }, { views: false });
  d.started = () => {
    const filled = fillQueue(d.state, { resources: () => ({ free_gb: 64, cpu_pct: 0 }) });
    assert.equal(filled.length, 1, 'the fill starts the queued run');
    const id = filled[0].next;
    return { id, rec: loadState(d.state).items[id].data, spec: JSON.parse(fs.readFileSync(path.join(d.state, 'runs', id + '.spec.json'), 'utf8')) };
  };
  return d;
}

test('a queued run launches with the policy current at FILL time: memory key, launch profile, model / effort, the class table', async () => {
  const d = sandbox({ launch: { memory: { worker: 'on' } } }, { fake: { model: 'm-old', effort: 'low' } });
  const q = d.cli(['--lane', 'work', '--after', `run:${d.gate}:done`]);
  assert.equal(q.code, 0, q.out); assert.match(q.out, /QUEUED/);
  d.policy({ launch: { memory: { worker: 'off' }, roles: { worker: 'lean' } }, executors: { chores: { executor: 'fake' } } }, { fake: { model: 'm-new', effort: 'high' } });
  d.open();
  const { id, rec, spec } = d.started();
  assert.equal(spec.memory, 'off'); assert.equal(spec.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1', 'the launch env carries the switch');
  assert.equal(rec.memory, 'off');
  assert.equal(spec.profile.name, 'lean'); assert.equal(rec.launch_profile, 'lean');
  assert.equal(rec.model, 'm-new'); assert.equal(rec.effort, 'high');
  assert.equal(rec.class, 'chores'); assert.equal(rec.class_basis, 'policy');
  assert.deepEqual(rec.at_fill?.parts, ['memory', 'profile', 'model', 'effort', 'agent', 'class']);
  assert.deepEqual(rec.at_fill?.from, [d.project.replace(/\\/g, '/')]);
  assert.deepEqual(rec.at_fill?.explicit, []);
  assert.equal(spec.atFill, undefined, 'the run spec (what a resume reads) carries no fill record');
  await runEnded(d.state, id);
});

test('at fill, an explicit --model / --effort / --class survives a policy change; memory still follows the policy', async () => {
  const d = sandbox({ launch: { memory: { worker: 'off' } } }, { fake: { model: 'm-old' } });
  const q = d.cli(['--lane', 'work', '--after', `run:${d.gate}:done`, '--model', 'm-flag', '--effort', 'xhigh', '--class', 'review']);
  assert.equal(q.code, 0, q.out);
  d.policy({ launch: { memory: { worker: 'on' } }, executors: { chores: { executor: 'fake' } } }, { fake: { model: 'm-new', effort: 'low' } });
  d.open();
  const { id, rec, spec } = d.started();
  assert.equal(rec.model, 'm-flag'); assert.equal(rec.effort, 'xhigh'); assert.equal(rec.class, 'review');
  assert.equal(spec.memory, 'on'); assert.equal(spec.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, null, 'on deletes an inherited switch'); assert.equal(rec.memory, undefined);
  assert.deepEqual(rec.at_fill?.explicit, ['model', 'effort', 'class']);
  await runEnded(d.state, id);
});

// GAP-2: the machine budget (local/budget.json: caps, the usage guard, the worker floor) is read at FILL time, not copied at queue time
test('a queued run obeys the machine budget in force at fill: the worker cap, the usage guard, the worker floor', async () => {
  const d = sandbox({}), bf = path.join(d.t, 'local', 'budget.json'), budget = b => fs.writeFileSync(bf, JSON.stringify(b));
  budget({ max_claude_workers: 2 });
  const q = d.cli(['--lane', 'work', '--after', `run:${d.gate}:done`, '--model', 'claude-sonnet-5-5', '--effort', 'low']);
  assert.equal(q.code, 0, q.out); assert.match(q.out, /QUEUED (RUN-\d+)/);
  const qid = q.out.match(/QUEUED (RUN-\d+)/)[1];
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.state, 'runs', qid + '.queue.json'), 'utf8')).budget_file, bf);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.state, 'runs', qid + '.queue.json'), 'utf8')).budget, undefined, 'no copy of the budget is kept');
  d.open();
  const fill = () => fillQueue(d.state, { resources: () => ({ free_gb: 64, cpu_pct: 0 }) });
  const terms = () => readiness(d.state, { resources: () => ({ free_gb: 64, cpu_pct: 0 }) }).find(r => r.id === qid).terms.join('; ');
  budget({ max_claude_workers: 0 });
  assert.deepEqual(fill(), [], 'the cap lowered to 0 after queueing holds it');
  assert.match(terms(), /budget max_claude_workers=0/);
  budget({ max_claude_workers: 2, weekly_stop_pct: 95 });
  assert.deepEqual(fill(), [], 'a weekly guard set after queueing holds it (no STATUS estimate = unknown, fail closed)');
  assert.match(terms(), /usage: weekly unknown/);
  budget({ max_claude_workers: 2, worker_min_model: 'claude-opus-5-5', worker_min_effort: 'high' });
  const { id, rec, spec } = d.started();
  assert.equal(rec.model, 'claude-opus-5-5', 'the floor set after queueing raises the run'); assert.equal(rec.effort, 'high');
  assert.deepEqual(rec.floor, { model: ['claude-sonnet-5-5', 'claude-opus-5-5'], effort: ['low', 'high'] });
  assert.deepEqual(spec.budget, { max_claude_workers: 2, worker_min_model: 'claude-opus-5-5', worker_min_effort: 'high' }, 'the run spec carries the budget it started under');
  await runEnded(d.state, id);
});
