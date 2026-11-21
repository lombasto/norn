// merge-slot (owner 11-21: "a dedicated merge worker"): budget.merge_workers Claude slots on top of max_claude_workers that only a
// landing run (MERGE / resolve) may take, machine-wide; the CPU gate never holds a merge in that slot (the memory gate does); a merge
// waiting in any project counts against fill.merge_reserve. Temp dirs only; live runs are recorded starts with a fresh heartbeat file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { queueRun, readiness, fillQueue, hbPath, resourceRefusal, mergeWorkers } from '../engine/lib/runs.mjs';
import { record } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { runEnded } from './helpers/wait.mjs';

const HOT = { free_gb: 64, cpu_pct: 95 }, COOL = { free_gb: 64, cpu_pct: 5 };
// one machine: t/state/<project> per project, one budget file, fake executor (on the Claude cap)
function machine(budget) {
  const t = mkTmp('meta-mslot-'), locks = path.join(t, 'state', 'locks'), budget_file = path.join(t, 'budget.json');
  fs.mkdirSync(locks, { recursive: true });
  fs.writeFileSync(budget_file, JSON.stringify(budget));
  const brief = path.join(t, 'brief.md'); fs.writeFileSync(brief, 'mode: done\n');
  let n = 0;
  const project = name => {
    const state = path.join(t, 'state', name);
    fs.mkdirSync(state, { recursive: true });
    const p = { name, state };
    p.opts = (o = {}) => { const wt = path.join(t, `wt-${name}-${++n}`); fs.mkdirSync(wt, { recursive: true });
      return { state, locksDir: locks, executor: 'fake', lane: `${name}-${n}`, brief, worktree: wt, notes: path.join(t, `n${n}.md`), hbMs: 150, staleMs: 120000,
        policy: { auto_resume_max: 0, fill: { min_free_gb: 4, max_cpu_pct: 90, merge_reserve: 1 } }, tick: null, budget, budget_file, ...o }; };
    p.queue = (o = {}) => queueRun(p.opts(o)).run;
    // a live Claude worker with no process (stage MERGE = a live merge): a start record + a fresh heartbeat file
    p.live = (stage = 'BUILD') => { const id = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: `${name}-live-${++n}`, stage, worktree: 'w', brief } }).id;
      fs.mkdirSync(path.join(state, 'hb'), { recursive: true }); fs.writeFileSync(hbPath(state, id), JSON.stringify({ run: id })); return id; };
    p.row = (id, res = COOL) => readiness(state, { resources: () => res }).find(r => r.id === id);
    return p;
  };
  return { t, project };
}

test('cap 3 + merge_workers 1, 3 lanes running and CPU over the gate: a queued MERGE starts in one fill, a queued lane waits', async () => {
  const m = machine({ max_claude_workers: 3, merge_workers: 1 });
  const a = m.project('norn');
  for (let i = 0; i < 3; i++) a.live();
  const lane = a.queue({ stage: 'BUILD' }), merge = a.queue({ stage: 'MERGE' });
  const rows = readiness(a.state, { resources: () => HOT });
  assert.equal(rows.find(r => r.id === merge).ready, true, 'the merge takes the merge slot; the CPU gate does not hold it');
  assert.match(rows.find(r => r.id === lane).terms.join(), /^cap: 4 claude workers running, budget max_claude_workers=3 \(\+ 1 merging, merge_workers=1\)$/, 'the dry walk counts the merge, and lane work never takes its slot');
  const got = fillQueue(a.state, { resources: () => HOT });
  assert.deepEqual(got.map(x => x.queued), [merge]);
  await runEnded(a.state, got[0].next);
});

test('lane work never takes the merge slot; a second merge waits for a slot (the merge slot is taken, the cap is full)', () => {
  const m = machine({ max_claude_workers: 3 });   // merge_workers unset: the default 1
  assert.equal(mergeWorkers({}), 1);
  const a = m.project('norn');
  for (let i = 0; i < 3; i++) a.live();
  const lane = a.queue({ stage: 'BUILD' });
  assert.match(a.row(lane).terms.join(), /^cap: 3 claude workers running, budget max_claude_workers=3$/);
  a.live('MERGE');
  const merge = a.queue({ stage: 'resolve' });
  assert.match(a.row(merge).terms.join(), /^cap: 4 claude workers running, budget max_claude_workers=3 \+ merge_workers=1 \(1 merging\)$/);
});

test('a merge may take a normal slot when one is free; there the CPU gate holds it like a lane', () => {
  const m = machine({ max_claude_workers: 3, merge_workers: 1 });
  const a = m.project('norn');
  a.live(); a.live('MERGE');
  const merge = a.queue({ stage: 'MERGE' });
  assert.equal(a.row(merge).ready, true, 'the merge slot is taken: a normal slot is free');
  assert.match(a.row(merge, HOT).terms.join(), /^resources: CPU busy 95 % > fill\.max_cpu_pct 90$/);
});

test('the memory gate still holds a merge in the merge slot', () => {
  const m = machine({ max_claude_workers: 1, merge_workers: 1 });
  const a = m.project('norn');
  a.live();
  const merge = a.queue({ stage: 'MERGE' });
  assert.match(a.row(merge, { free_gb: 1, cpu_pct: 95 }).terms.join(), /^resources: free RAM 1\.0 GB < fill\.min_free_gb 4$/);
  assert.equal(resourceRefusal(HOT, {}, { cpu: false }), null);
});

test('reserve across projects: a merge waiting in project B is reserved against project A\'s lane once the merge slots are taken', () => {
  const m = machine({ max_claude_workers: 3, merge_workers: 1 });
  const a = m.project('norn'), b = m.project('shack');
  a.live(); a.live();
  const bm = b.queue({ stage: 'MERGE' });
  const lane = a.queue({ stage: 'BUILD' });
  assert.equal(a.row(lane).ready, true, 'the merge slot is free: B\'s merge goes there, A\'s lane takes the last normal slot');
  b.live('MERGE');   // the merge slot taken: B's waiting merge now needs a normal slot
  assert.match(a.row(lane).terms.join(), /^cap: 3 claude workers running, budget max_claude_workers=3: 1 slot\(s\) kept for the queued merges \(fill\.merge_reserve\)$/);
  assert.equal(b.row(bm).ready, true, 'B\'s merge takes the kept slot');
});
