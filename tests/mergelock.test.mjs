// META-MERGELOCK R1 (DEC-103 / DEC-104) + GAP-6: every MERGE-stage run holds one merge slot of its repo for its whole life, beside
// its own merge worktree's lock; policy.merge.parallel says how many slots (here 1: one merge at a time). The owner's checkout is
// never locked by a merge. FAKE executor only, temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRun, stopRun, fillQueue, readiness, lockPath, writeTrees, sweepLost, mergeSpec } from '../engine/lib/runs.mjs';
import { renderMergeBrief } from '../engine/lib/mergebrief.mjs';
import { mergeWtPath, slotKey } from '../engine/lib/mergewt.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { waitForSync, supervisorAlive } from './helpers/wait.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
const RES = () => ({ free_gb: 64, cpu_pct: 1 });
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function sandbox() {
  const t = mkTmp('meta-mergelock-');
  const d = { t, state: path.join(t, 'state', 'norn'), locks: path.join(t, 'state', 'locks'), main: path.join(t, 'main'), wtA: path.join(t, 'wt-a'), wtB: path.join(t, 'wt-b') };
  for (const k of ['state', 'locks', 'main', 'wtA', 'wtB']) fs.mkdirSync(d[k], { recursive: true });
  for (const a of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'init']]) assert.equal(spawnSync('git', ['-C', d.main, ...a], { env: GENV, windowsHide: true }).status, 0);
  d.P = { name: 'norn', root: fwd(d.main), meta: '/h/dev/sdd-codex', state: fwd(d.state), deliverables: { main: 'main' }, policy: { merge: { parallel: 1 } } };
  // a staged MERGE brief of one lane; the fake executor finishes once `until` exists (a test releases it)
  d.staged = (lane, wt, until) => {
    const f = path.join(t, `merge-${lane}.md`);
    fs.writeFileSync(f, renderMergeBrief(d.P, { lane, branch: `feat/${lane}`, worktree: fwd(wt), notes: fwd(path.join(t, `${lane}-NOTES.md`)), sha: 'abcdef1' }) + `mode: done\nuntil: ${fwd(until)}\n`);
    return f;
  };
  d.opts = (lane, wt, brief, o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'fake', lane, worktree: wt, brief, stage: 'MERGE', notes: path.join(t, `${lane}-NOTES.md`),
    tick: null, hbMs: 150, staleMs: 3000, policy: { auto_resume_max: 0 }, budget: {}, ...o });
  d.item = id => loadState(d.state).items[id];
  d.slot = () => { try { return JSON.parse(fs.readFileSync(lockPath(d.locks, slotKey(fwd(d.main), 0)), 'utf8')); } catch { return null; } };
  d.filled = qid => Object.values(loadState(d.state).items).find(x => x.kind === 'run' && x.data.from_queue === qid) || null;
  // ended AND its supervisor gone: the lock release + the queue fill of its exit are done
  d.ends = id => waitForSync(() => settled(d.item(id)), { producer: supervisorAlive(d.state, () => d.item(id)), what: `${id} ends` });
  return d;
}

test('writeTrees: a MERGE run writes its own merge worktree (whatever --worktree said), never the owner checkout; other stages only their own', () => {
  const d = sandbox();
  const b = d.staged('a', d.wtA, path.join(d.t, 'go-a'));
  assert.deepEqual(writeTrees(mergeSpec(d.opts('a', d.wtA, b))).map(fwd), [mergeWtPath(d.state, 'a', 'abcdef1')]);
  assert.deepEqual(writeTrees(d.opts('a', d.wtA, b, { stage: 'S2' })).map(fwd), [fwd(d.wtA)]);
  // a hand-written MERGE brief (no marker): its own worktree only
  const hand = path.join(d.t, 'hand.md'); fs.writeFileSync(hand, '# merge by hand\n');
  assert.deepEqual(writeTrees(mergeSpec(d.opts('a', d.wtA, hand))).map(fwd), [fwd(d.wtA)]);
});

test('parallel 1: the second MERGE refuses exit 3 on the merge slot; --queue stays queued; the first exit frees it and the fill starts the second', () => {
  const d = sandbox();
  const goA = path.join(d.t, 'go-a'), goB = path.join(d.t, 'go-b');
  const a = startRun(d.opts('a', d.wtA, d.staged('a', d.wtA, goA)));
  assert.ok(a.run);
  assert.equal(d.slot()?.run, a.run, 'the MERGE run holds the merge slot');
  assert.equal(fs.existsSync(lockPath(d.locks, d.main)), false, 'never the owner checkout');
  const bb = d.staged('b', d.wtB, goB);
  assert.throws(() => startRun(d.opts('b', d.wtB, bb)), e => e.code === 3 && new RegExp(`merge slots full: 1 merge.*${a.run}`).test(e.message));
  assert.equal(fs.existsSync(lockPath(d.locks, mergeWtPath(d.state, 'b', 'abcdef1'))), false, 'a refused start leaves no lock behind on its own worktree');
  const q = startRun(d.opts('b', d.wtB, bb, { queue: true }));
  assert.ok(q.queued, '--queue: a full slot queues the MERGE');
  const row = readiness(d.state, { resources: RES }).find(r => r.id === q.run);
  assert.equal(row.ready, false);
  assert.ok(row.terms.some(x => x.includes(a.run)), row.terms.join('; '));
  assert.deepEqual(fillQueue(d.state, { resources: RES }), [], 'the fill does not start it while the slot is held');
  fs.writeFileSync(goA, 'go');
  d.ends(a.run);
  const bRun = d.filled(q.run);
  assert.ok(bRun, 'the fill started the queued MERGE once the slot freed');
  fs.writeFileSync(goB, 'go');
  d.ends(bRun.id);
  assert.equal(d.slot(), null, 'every MERGE exit frees its slot');
});

test('a fill with two eligible MERGE runs and one slot starts one; the other waits for the slot', () => {
  const d = sandbox();
  const goA = path.join(d.t, 'go-a'), goB = path.join(d.t, 'go-b');
  const wtC = path.join(d.t, 'wt-c'); fs.mkdirSync(wtC, { recursive: true });
  // the blocker is a plain S1 worker that holds wt-a only (a merge brief under S1 is refused: MAIL-10)
  const bx = path.join(d.t, 'x-brief.md'); fs.writeFileSync(bx, `mode: done\nuntil: ${fwd(path.join(d.t, 'go-x'))}\n`);
  const blocker = startRun(d.opts('x', d.wtA, bx, { stage: 'S1' }));
  const after = [{ kind: 'run', id: blocker.run, state: 'ended' }];
  const qa = startRun(d.opts('a', d.wtB, d.staged('a', d.wtB, goA), { after }));
  const qb = startRun(d.opts('b', wtC, d.staged('b', wtC, goB), { after }));
  assert.ok(qa.queued && qb.queued);
  fs.writeFileSync(path.join(d.t, 'go-x'), 'go');
  d.ends(blocker.run);   // its supervisor fills: exactly one MERGE starts, the other waits for the slot
  const first = d.filled(qa.run) || d.filled(qb.run);
  assert.ok(first, 'one MERGE started');
  const waiting = d.filled(qa.run) ? qb.run : qa.run;
  assert.equal(d.filled(waiting), null, 'the second MERGE stays queued');
  assert.equal(d.item(waiting).state, 'queued');
  assert.equal(d.slot()?.run, first.id);
  const row = readiness(d.state, { resources: RES }).find(r => r.id === waiting);
  assert.ok(row.terms.some(x => x.startsWith('merge slots full') && x.includes(first.id)), row.terms.join('; '));
  fs.writeFileSync(goA, 'go'); fs.writeFileSync(goB, 'go');
  d.ends(first.id);
  const second = d.filled(waiting);
  assert.ok(second, 'the waiting MERGE starts when the slot frees');
  d.ends(second.id);
  assert.equal(d.slot(), null);
});

test('a killed MERGE run frees its slot (norn stop); a lost one (no heartbeat) goes stale and is broken like any lock', () => {
  const d = sandbox();
  const a = startRun(d.opts('a', d.wtA, d.staged('a', d.wtA, path.join(d.t, 'never'))));
  assert.equal(d.slot()?.run, a.run);
  stopRun({ state: d.state, locksDir: d.locks, run: a.run, by: 'controller', why: 'test' });
  assert.equal(d.slot(), null, 'norn stop frees the merge slot too');
  assert.equal(fs.existsSync(lockPath(d.locks, mergeWtPath(d.state, 'a', 'abcdef1'))), false);
  // a lost run: its slot lock stays but its ts goes stale (no supervisor refresh) - the next MERGE breaks it
  fs.writeFileSync(lockPath(d.locks, slotKey(fwd(d.main), 0)), JSON.stringify({ run: 'RUN-999', pid: 1, ts: new Date(Date.now() - 60000).toISOString() }));
  const go = path.join(d.t, 'go-b');
  const b = startRun(d.opts('b', d.wtB, d.staged('b', d.wtB, go)));
  assert.equal(d.slot()?.run, b.run);
  fs.writeFileSync(go, 'go');
  d.ends(b.run);
  assert.equal(d.slot(), null);
});

// CIRED-7b3d67d (CI Linux, main 7b3d67d): a 4 s machine stall let a fill's sweep mark the running first MERGE `lost`; its supervisor
// lived on, its `end` was refused (lost, not running) and it exited WITHOUT freeing its lock or filling - the queued MERGE waited
// for ever (until the lock went stale and someone else filled). The sweep is simulated here by a clock 60 s ahead.
test('a MERGE run swept lost while its supervisor lives: its exit still frees the slot and the fill starts the waiting MERGE', () => {
  const d = sandbox();
  const goA = path.join(d.t, 'go-a'), goB = path.join(d.t, 'go-b');
  const a = startRun(d.opts('a', d.wtA, d.staged('a', d.wtA, goA)));
  const q = startRun(d.opts('b', d.wtB, d.staged('b', d.wtB, goB), { queue: true }));
  assert.ok(q.queued);
  waitForSync(() => JSON.parse(fs.readFileSync(path.join(d.state, 'hb', a.run + '.hb'), 'utf8')).pid, { producer: supervisorAlive(d.state, () => d.item(a.run)), what: `${a.run} beats` });
  assert.deepEqual(sweepLost(d.state, { staleMs: 3000, by: 'launcher', now: () => new Date(Date.now() + 60000) }), [a.run]);
  assert.equal(d.item(a.run).state, 'lost');
  assert.equal(d.slot()?.run, a.run, 'the lost run\'s supervisor still holds the slot');
  fs.writeFileSync(goA, 'go');
  d.ends(a.run);
  assert.notEqual(d.slot()?.run, a.run, 'the lost run\'s exit frees the slot');
  const bRun = d.filled(q.run);
  assert.ok(bRun, 'the lost run\'s exit fill starts the waiting MERGE');
  fs.writeFileSync(goB, 'go');
  d.ends(bRun.id);
  assert.equal(d.slot(), null);
});

// slop C6: the supervisor refreshes its locks every beat; a lock that names another run now (taken over, or broken as stale and
// re-taken) is no longer this run's - its run log says so once, never a silent skip
test('a MERGE run whose slot lock another run took over: its supervisor logs it once (not every beat)', () => {
  const d = sandbox();
  const go = path.join(d.t, 'go-a'), a = startRun(d.opts('a', d.wtA, d.staged('a', d.wtA, go)));
  const log = JSON.parse(fs.readFileSync(path.join(d.state, 'runs', a.run + '.spec.json'), 'utf8')).log, said = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').match(/lock .* names RUN-999/g) || [];
  fs.writeFileSync(lockPath(d.locks, slotKey(fwd(d.main), 0)), JSON.stringify({ run: 'RUN-999', pid: 1, ts: new Date().toISOString() }));
  waitForSync(() => said().length, { producer: supervisorAlive(d.state, () => d.item(a.run)), what: `${a.run} logs the lost slot`, capMs: 30000 });
  fs.writeFileSync(go, 'go');
  d.ends(a.run);
  assert.equal(said().length, 1, 'once per streak');
  assert.equal(d.slot()?.run, 'RUN-999', 'the other run\'s lock is never undone');
});
