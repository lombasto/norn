// MERGE-FIRST (merge-first lane, owner 11-19): finished work lands before new work starts. A MERGE / resolve run runs at the priority
// of the work it lands, never below P1; in the fill order it outranks the other runs of its own priority and one level above; the fill
// keeps policy.fill.merge_reserve slots for a queued merge; `norn requeue --priority` keeps the after: conditions. Temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fillQueue, queueRun, queueOf, readiness, requeueRun, landingPriority, workPriority, lockPath } from '../engine/lib/runs.mjs';
import { loadState, record } from '../engine/lib/records.mjs';
import { parseAfter } from '../engine/lib/after.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { runEnded } from './helpers/wait.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const meta = args => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1' } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const PIN = { free_gb: 64, cpu_pct: 5 };   // the machine's own load never gates these fills
const runs = d => Object.values(loadState(d.state).items).filter(i => i.kind === 'run');

function sandbox() {
  const t = mkTmp('meta-mergefirst-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks']) fs.mkdirSync(d[k], { recursive: true });
  d.wt = n => { const w = path.join(t, 'wt' + n); fs.mkdirSync(w, { recursive: true }); return w; };
  d.brief = (name = 'brief.md') => { const f = path.join(t, name); fs.writeFileSync(f, 'mode: done\n'); return f; };
  d.item = id => loadState(d.state).items[id];
  let nb = 0;
  d.q = (o = {}) => {
    const budget = o.budget ?? { max_claude_workers: 1 }, budget_file = path.join(t, `budget-${++nb}.json`);
    fs.writeFileSync(budget_file, JSON.stringify(budget));
    return queueRun({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt(nb), notes: d.notes, hbMs: 150, staleMs: 3000,
      policy: { auto_resume_max: 0 }, tick: null, brief: d.brief(`b${nb}.md`), ...o, budget, budget_file }).run;
  };
  return d;
}

test('a landing run (MERGE, resolve) runs at the priority of the work it lands, never below P1', () => {
  const d = sandbox();
  const build = d.q({ lane: 'water', stage: 'BUILD', priority: 'P0' });
  assert.equal(workPriority(runs(d), 'water'), 'P0');
  const m = d.q({ lane: 'water', stage: 'MERGE' });
  assert.equal(d.item(m).data.priority, 'P0', 'the lane\'s work is P0: so is its merge');
  d.q({ lane: 'fog', stage: 'BUILD' });
  assert.equal(d.item(d.q({ lane: 'fog', stage: 'MERGE' })).data.priority, 'P1', 'default P2 work: the merge is raised to P1');
  assert.equal(d.item(d.q({ lane: 'dew', stage: 'resolve', priority: 'P3' })).data.priority, 'P1', 'a resolve given P3: raised to P1');
  assert.equal(d.item(d.q({ lane: 'ice', stage: 'BUILD', priority: 'P3' })).data.priority, 'P3', 'a build keeps its own priority');
  assert.equal(landingPriority({ stage: 'MERGE', priority: 'P4' }).priority, 'P1');
  assert.equal(landingPriority({ stage: 'PLAN' }).priority, undefined, 'not a landing run: untouched');
  assert.ok(build);
});

test('fill order: a queued MERGE outranks the build and plan runs of its own priority and one level above', () => {
  const d = sandbox();
  const p0 = d.q({ lane: 'a', stage: 'BUILD', priority: 'P0' }), p1 = d.q({ lane: 'b', stage: 'PLAN', priority: 'P1' });
  const m1 = d.q({ lane: 'c', stage: 'MERGE', priority: 'P1' }), m2 = d.q({ lane: 'e', stage: 'MERGE', priority: 'P2' });
  const p0b = d.q({ lane: 'f', stage: 'BUILD', priority: 'P0' });
  assert.equal(d.item(m2).data.priority, 'P1', 'P2 merge raised to P1');
  const m0 = d.q({ lane: 'g', stage: 'MERGE', priority: 'P0' });
  assert.deepEqual(queueOf(runs(d)).map(x => x.id), [m0, m1, m2, p0, p0b, p1]);
});

test('one queued MERGE and one P1 build with one slot: the MERGE starts', async () => {
  const d = sandbox();
  const build = d.q({ lane: 'build', stage: 'BUILD', priority: 'P1' });
  const merge = d.q({ lane: 'land', stage: 'MERGE' });
  const rows = readiness(d.state, { resources: () => PIN });
  assert.deepEqual(rows.map(r => [r.id, r.ready]), [[merge, true], [build, false]]);
  assert.match(rows[1].terms.join(), /^cap: 1 claude workers running, budget max_claude_workers=1$/);
  const got = fillQueue(d.state, { resources: () => PIN });
  assert.deepEqual(got.map(x => x.queued), [merge], 'the merge took the one slot');
  assert.equal(d.item(build).state, 'queued');
  await runEnded(d.state, got[0].next);
});

test('merge reserve: while a merge waits (here on its held worktree), other runs leave policy.fill.merge_reserve slots free', async () => {
  const d = sandbox();
  const budget = { max_claude_workers: 2 };
  const mwt = d.wt(99);
  fs.writeFileSync(lockPath(d.locks, mwt), JSON.stringify({ run: 'RUN-other', pid: process.pid, ts: new Date().toISOString() }));
  const merge = d.q({ lane: 'land', stage: 'MERGE', worktree: mwt, budget });
  const a = d.q({ lane: 'a', stage: 'BUILD', budget, policy: { auto_resume_max: 0, fill: { merge_reserve: 1 } } });
  const b = d.q({ lane: 'b', stage: 'BUILD', budget, policy: { auto_resume_max: 0, fill: { merge_reserve: 1 } } });
  let rows = readiness(d.state, { resources: () => PIN });
  assert.match(rows.find(r => r.id === merge).terms.join(), /worktree held by RUN-other/);
  assert.equal(rows.find(r => r.id === a).ready, true, 'one slot of two is free beyond the reserve');
  assert.match(rows.find(r => r.id === b).terms.join(), /1 slot\(s\) kept for the queued merges \(fill\.merge_reserve\)/);
  // merge_reserve 0: no slot kept
  const c = d.q({ lane: 'c', stage: 'BUILD', budget, policy: { auto_resume_max: 0, fill: { merge_reserve: 0 } } });
  rows = readiness(d.state, { resources: () => PIN });
  assert.equal(rows.find(r => r.id === c).ready, true, 'its own merge_reserve 0: it may take the last slot');
  // the merge no longer waits: the lock is gone, so it takes a slot and the reserve is spent
  fs.rmSync(lockPath(d.locks, mwt));
  rows = readiness(d.state, { resources: () => PIN });
  assert.deepEqual(rows.filter(r => r.ready).map(r => r.id), [merge, a]);
});

test('norn requeue --priority keeps the after: conditions (and the dashboard role may set it)', () => {
  const d = sandbox();
  const up = d.q({ lane: 'up', stage: 'BUILD' });
  const after = parseAfter(`run:${up}:done`);
  const w = d.q({ lane: 'w', stage: 'BUILD', after });
  const r = requeueRun({ state: d.state, run: w, by: 'dashboard', why: 'priority from the Plan page', priority: 'P0' });
  assert.equal(d.item(w).state, 'withdrawn');
  assert.deepEqual(d.item(r.next).data.after, d.item(w).data.after, 'the after: conditions kept');
  assert.equal(d.item(r.next).data.priority, 'P0');
  assert.equal(r.priority, 'P0');
  assert.throws(() => requeueRun({ state: d.state, run: r.next, by: 'owner', why: 'x', priority: 'P9' }), /--priority "P9": want P0 \| P1 \| P2 \| P3 \| P4/);
  // the CLI: --priority alone (no --after) keeps the conditions; a MERGE re-queued at P3 stays at P1
  const cli = meta(['requeue', r.next, '--priority', 'P2', '--why', 'back to normal', '--as', 'owner', '--state', d.state, '--locks', d.locks]);
  assert.equal(cli.code, 0, cli.err);
  assert.match(cli.out, /REQUEUED .* \(its after: kept; priority P2\)/);
  const next = cli.out.match(/-> (RUN-\d+)/)[1];
  assert.deepEqual(d.item(next).data.after, d.item(w).data.after);
  assert.equal(meta(['requeue', next, '--why', 'nothing', '--as', 'owner', '--state', d.state]).code, 2, 'nothing to change: refused');
  const m = d.q({ lane: 'land', stage: 'MERGE', after });
  const cm = meta(['requeue', m, '--priority', 'P3', '--why', 'x', '--as', 'owner', '--state', d.state, '--locks', d.locks]);
  assert.equal(cm.code, 0, cm.err);
  assert.equal(d.item(cm.out.match(/-> (RUN-\d+)/)[1]).data.priority, 'P1', 'a merge never below P1');
  assert.ok(record);
});

test('digest row 0c: over policy.merge.backlog_max finished deliverables, the check-in is told to land before starting', () => {
  const d = sandbox(), now = Date.parse('2026-11-19T12:00:00Z');
  const row = n => ({ id: 'DLV-' + n, state: 'done', record_state: 'open', superseded: null, pr: null, lane: 'l' + n, branch: 'norn/l' + n, delivers: 'x', done_utc: '2026-11-19T02:00:00Z', days: 0.4 });
  const git = { run: () => ({ ok: false, out: '' }) }, dg = (rows, policy) => digest(d.state, { policy }, { now, git, dlv: rows, evalAfter: () => ({ met: true, gone: false }), ready: [] });
  assert.equal(dg([1, 2, 3].map(row)).sections.backlog, undefined, '3 = the default max: no row');
  const g = dg([1, 2, 3, 4].map(row));
  assert.deepEqual(g.sections.backlog, [{ id: 'MERGE-BACKLOG', n: 4, oldest_h: 10, max: 3, ids: ['DLV-1', 'DLV-2', 'DLV-3', 'DLV-4'] }]);
  assert.match(renderDigest(g), /0c MERGE BACKLOG[^\n]*\n- MERGE BACKLOG 4 \(oldest 10 h\): over max 3 - land work before starting new lanes: DLV-1, DLV-2, DLV-3, DLV-4/);
  assert.equal(dg([1, 2, 3, 4].map(row), { merge: { backlog_max: 5 } }).sections.backlog, undefined, 'the setting raises the line');
  assert.equal(dg([1, 2, 3, 4].map(n => ({ ...row(n), pr: { number: n } }))).sections.backlog, undefined, 'a PR opened = on its way: not backlog');
});
