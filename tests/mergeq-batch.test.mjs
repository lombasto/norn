// META-GTP-MERGEQ batch + bisect + integration branches (split out of mergeq.test.mjs so the two git-heavy halves run in parallel).
// Gas Town refinery batch.go / engineer.go - cited, not ported. Every git case runs on temp repos; no live state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record, loadState } from '../engine/lib/records.mjs';
import { renderMergeBrief, briefMarker } from '../engine/lib/mergebrief.mjs';
import { mergeWtPath } from '../engine/lib/mergewt.mjs';
import { startRun, lockPath, readiness } from '../engine/lib/runs.mjs';
import { deliverablesView, askDeliverable, resolveDeliverable } from '../engine/lib/deliverables.mjs';
import { main } from '../engine/bin/norn.mjs';
import { mrScore, mergeQueue, formatMq, autoUpdate, mergeConfig, mergeqRun, loadBatch, loadMq, setBatching, mqProbe, intoSha, mainShaOf } from '../engine/lib/mergeq.mjs';
import { makeGit } from '../engine/lib/dlvgit.mjs';
import { tick, gateProbes } from '../engine/lib/tick.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { fromTemplate } from './helpers/git-template.mjs';
import { waitForSync, supervisorAlive } from './helpers/wait.mjs';

const tmp = p => mkTmp('meta-mq-' + p + '-');
test.after(cleanTmp);
const fwd = p => String(p).replace(/\\/g, '/');
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg);
  return g(repo, 'rev-parse', 'HEAD');
};
const NOW = Date.parse('2026-11-08T12:00:00Z');
const at = h => new Date(NOW + h * 3600e3);
function cli(argv, env = {}) {
  const o = [], e = [];
  const code = main(argv, env, s => o.push(s), s => e.push(s));
  return { code, out: o.join('\n'), err: e.join('\n') };
}
const P = { name: 'norn', root: '/h/dev/sdd-codex', meta: '/h/dev/sdd-codex', deliverables: { main: 'main' }, policy: {} };
const O = { lane: 'meta-vis', branch: 'feat/vis', worktree: '/h/dev/sdd-codex-vis', notes: '/h/r/meta-vis/MERGE-NOTES.md' };

// a live run holding worktree wt: a running record + a fresh heartbeat + its lock (what the supervisor keeps)
function liveRun(state, locks, { lane, worktree, stage = 'S3' }) {
  const e = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane, worktree: fwd(worktree), stage, brief: 'x' } }, { views: false });
  fs.mkdirSync(path.join(state, 'hb'), { recursive: true });
  fs.writeFileSync(path.join(state, 'hb', e.id + '.hb'), '{}');
  fs.mkdirSync(locks, { recursive: true });
  fs.writeFileSync(lockPath(locks, worktree), JSON.stringify({ run: e.id, pid: 1, ts: new Date().toISOString() }));
  return e.id;
}

// ---------- piece 3: batch + bisect ----------
// a bare origin + main checkout whose main carries the gate script: red when a file bad*.txt is in the tree, or when both x1.txt and
// x2.txt are (an interaction); flaky.mjs is red on odd calls (a counter outside the tree). Branches (one worktree each) add files.
function batchFixture(branches, { flakyCounter, mainRed } = {}) {
  // the git part is one template per recipe (the branch list), on top of one template of main with the gate scripts (DEC-85)
  const recipe = JSON.stringify([branches, !!mainRed]);
  const { origin, repo, tips } = fromTemplate('mq-batch:' + recipe, root => {
    const base = fromTemplate('mq-batch-base', buildBatchBase, root);
    const tips = {};
    for (const [b, file] of branches) {
      const wt = path.join(path.dirname(base.repo), 'wt-' + b.slice(5));
      g(base.repo, 'worktree', 'add', '-q', '-b', b, wt, 'main');
      tips[b] = commit(wt, file, b + '\n', `${b} work`);
      g(wt, 'push', '-q', '-u', 'origin', b);
    }
    if (mainRed) { commit(base.repo, 'bad-main.txt', 'x\n', 'main breaks the gate'); g(base.repo, 'push', '-q', 'origin', 'main'); }
    return { ...base, tips };
  }, tmp('batch'));
  const state = path.join(tmp('bst'), 'state', 'norn');
  branches.forEach(([b], i) => record(state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo: fwd(repo), branch: b, tip: tips[b], lane: b.slice(5), delivers: b, done_utc: at(-(20 - i)).toISOString() } }, { now: () => at(-(20 - i)), views: false }));
  const gate = { cmd: flakyCounter ? `node flaky.mjs "${fwd(flakyCounter)}"` : 'node gate.mjs', timeout_min: 2, fast: true };
  const project = { name: 'norn', root: fwd(repo), meta: '/m', state: fwd(state), deliverables: { receipts: [] }, merge: { gate, batch_max: 4, ui: ['engine/dash/**'] }, policy: {} };
  return { origin, repo, tips, state, project, locks: path.join(path.dirname(state), 'locks') };
}
function buildBatchBase(root) {
  const origin = path.join(root, 'origin');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GENV });
  const repo = path.join(root, 'co', 'sdd-codex');
  execFileSync('git', ['clone', '-q', origin, repo], { env: GENV, stdio: 'ignore' });
  g(repo, 'config', 'user.name', 't'); g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'commit.gpgsign', 'false');
  g(repo, 'checkout', '-q', '-b', 'main');
  commit(repo, 'gate.mjs', "import fs from 'node:fs';\nconst f = fs.readdirSync('.');\nfor (const x of f.filter(x => /^bad.*\\.txt$/.test(x))) console.log('NEW RED: ' + x + ' :: in the tree');\nprocess.exit(f.some(x => /^bad.*\\.txt$/.test(x)) || (f.includes('x1.txt') && f.includes('x2.txt')) ? 1 : 0);\n", 'gate');
  commit(repo, 'flaky.mjs', "import fs from 'node:fs';\nconst c = process.argv[2];\nconst n = fs.existsSync(c) ? Number(fs.readFileSync(c, 'utf8')) : 0;\nfs.writeFileSync(c, String(n + 1));\nprocess.exit(n % 2 === 0 ? 1 : 0);\n", 'flaky gate');
  commit(repo, 'engine/dash/x.css', 'a\n', 'ui');
  g(repo, 'push', '-q', '-u', 'origin', 'main');
  return { origin, repo };
}
// the MERGE worker's step 3 + 4, as the brief says: fast-forward main to the gated tip, push
const mergeBatch = (f, rec) => { g(f.repo, 'merge', '-q', '--ff-only', rec.merge_tip); g(f.repo, 'push', '-q', 'origin', 'main'); };

test('batch: a green gate -> ONE MERGE brief for the batch (one PR per branch); one batch at a time; merged -> the next', async () => {
  const f = batchFixture([['feat/a', 'docs/a.md'], ['feat/b', 'docs/b.md'], ['feat/u', 'engine/dash/u.css']]);
  f.project.merge.batch_max = 2;
  const r = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.match(r.why, /^batch-1 GREEN \(2 branches, 1 gate run\)/);
  const b = r.batch;
  assert.deepEqual(b.members.map(m => m.id), ['DLV-1', 'DLV-2'], 'score order, batch_max 2');
  assert.equal(g(f.repo, 'rev-parse', 'mq/batch-1'), b.merge_tip);
  assert.equal(g(f.repo, 'rev-list', '--count', '--first-parent', `${b.base}..${b.merge_tip}`), '2', 'one --no-ff merge commit per branch');
  assert.equal(g(f.repo, 'rev-parse', 'main'), b.base, 'main is untouched: the MERGE stage merges');
  const brief = fs.readFileSync(b.brief, 'utf8');
  assert.doesNotMatch(brief, /revert -m 1/, 'RM-7: the batch opens PRs, it never reverts on main');
  // GAP-6: the batch lands from its own merge worktree (the tip checked out there, then norn merge-land), never the owner checkout
  const mwt = briefMarker(brief).merge_wt;
  assert.equal(mwt, mergeWtPath(f.state, 'mq-batch-1'));
  assert.ok(brief.includes(`git -C ${mwt} checkout --quiet --detach ${b.merge_tip}`));
  assert.ok(brief.includes(`merge-land --project <project.json> --worktree ${mwt}${b.members.map(m => ` --branch ${m.branch}`).join('')}`), 'one --branch per member: one PR each');
  assert.doesNotMatch(brief, new RegExp(`git -C ${fwd(f.repo)} (pull|merge|push)`));
  assert.match(brief, /no dash \/ UI change in the batch/);
  assert.equal(briefMarker(brief).mode, 'staged');
  assert.deepEqual(b.dispatch.slice(0, 5), ['run', '--lane', 'mq', '--stage', 'MERGE']);
  assert.equal(b.dispatch[b.dispatch.indexOf('--worktree') + 1], mwt);
  // one batch at a time: the green batch waits for its MERGE stage
  const w = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.match(w.why, /batch-1 green: waiting for its MERGE stage/);
  // a writer holding the scratch worktree: no batch either (the owner checkout's lock no longer matters: no merge writes there)
  mergeBatch(f, b);
  const scratch = mergeConfig(f.project).scratch;
  fs.mkdirSync(f.locks, { recursive: true });
  fs.writeFileSync(lockPath(f.locks, scratch), JSON.stringify({ run: 'RUN-77', pid: 1, ts: new Date().toISOString() }));
  const held = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.match(held.why, /no batch now: the scratch worktree: .*RUN-77/);
  fs.unlinkSync(lockPath(f.locks, scratch));
  const n2 = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.equal(loadBatch(f.state, 1).status, 'merged');
  assert.equal(g(f.repo, 'branch', '--list', 'mq/batch-1'), '', 'landed: Norn deletes its batch branch (META-SLOP-A)');
  assert.equal(g(f.repo, 'rev-parse', 'mq/batch-2'), n2.batch.merge_tip, 'a green batch waiting for its MERGE stage keeps its branch');
  assert.deepEqual(n2.batch.members.map(m => m.id), ['DLV-3']);
  assert.ok(n2.batch.ui, 'engine/dash/** changed: the brief takes shots');
  assert.match(fs.readFileSync(n2.batch.brief, 'utf8'), /SHOTS AFTER/);
});

test('batch: policy.merge.suite = skip -> the batch gate does not run; clean members go green with no gate run; the brief says so (DIR-24)', async () => {
  const f = batchFixture([['feat/a', 'docs/a.md'], ['feat/c', 'bad-c.txt']]);   // bad-c.txt turns the gate red: skip never runs it
  f.project.policy = { merge: { suite: 'skip' } };
  let ran = 0;
  const r = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks, gateRunner: async () => { ran++; return { ok: false, code: 1 }; } });
  assert.equal(ran, 0, 'no gate run');
  assert.match(r.why, /^batch-1 GREEN \(2 branches, 0 gate run\)/);
  assert.equal(r.batch.status, 'green');
  assert.equal(r.batch.gate_skipped, 'policy merge.suite = skip');
  const brief = fs.readFileSync(r.batch.brief, 'utf8');
  assert.match(brief, /No gate ran \(project policy merge\.suite = skip/);
  assert.match(brief, /gate skipped \(policy merge\.suite = skip\) \+ smoke green/);
  assert.doesNotMatch(brief, /ran GREEN/);
  f.project.policy = { merge: { suite: 'never' } };
  await assert.rejects(mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks }), /merge\.suite must be one of full, skip/);
});

test('bisect: a red batch retries once, then ceil(log2 K) gate runs pin the culprit; the branches before it go on; the culprit gets a fix ask', async () => {
  const f = batchFixture([['feat/a', 'docs/a.md'], ['feat/b', 'docs/b.md'], ['feat/c', 'bad-c.txt'], ['feat/d', 'docs/d.md']]);
  const r = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  const b = r.batch;
  assert.equal(b.result, 'pinned');
  assert.deepEqual(b.runs.map(x => [x.label, x.prefix, x.ok]), [['batch', 4, false], ['retry', 4, false], ['bisect', 2, true], ['bisect', 3, false]]);
  assert.equal(b.bisect_runs, Math.ceil(Math.log2(4)));
  assert.equal(b.culprit.id, 'DLV-3');
  assert.deepEqual(b.merge_members.map(m => m.id), ['DLV-1', 'DLV-2'], 'the green prefix goes on in this batch');
  assert.equal(g(f.repo, 'rev-parse', 'mq/batch-1'), b.merge_tip);
  const fix = fs.readFileSync(r.fix.brief, 'utf8');
  assert.match(fix, /feat\/c turns the merge-queue gate red/); assert.match(fix, /never a rebase/); assert.match(fix, /no force-push/);
  assert.deepEqual(r.fix.run.slice(0, 7), ['run', '--executor', 'claude', '--lane', 'c', '--stage', 'fix-mq']);
  assert.equal(loadMq(f.state).red['DLV-3'], f.tips['feat/c']);
  mergeBatch(f, b);
  // next pass: DLV-3 stays out (red at this sha); DLV-4 batches alone and is green
  const n2 = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.deepEqual(n2.batch.members.map(m => m.id), ['DLV-4']);
  assert.equal(n2.batch.result, 'green');
  const q = cli(['mergeq', '--project', (() => { const pj = path.join(tmp('pj'), 'project.json'); fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 'norn', title: 'n', root: fwd(f.repo), deliverables: { receipts: [] }, merge: f.project.merge })); return pj; })(), '--state', f.state]);
  assert.match(q.out, /red: DLV-3 at [0-9a-f]{7}/);
  assert.match(q.out, /batch-2 -> main: GREEN, waiting for its MERGE stage: norn run --lane mq --stage MERGE/);
});

test('bisect: an interaction pins the branch that completes it; a red first branch probes main once', async () => {
  const f = batchFixture([['feat/a', 'x1.txt'], ['feat/b', 'docs/b.md'], ['feat/c', 'x2.txt']]);
  const r = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.equal(r.batch.culprit.id, 'DLV-3', 'x1 + x2: the branch whose merge turns it red');
  assert.deepEqual(r.batch.merge_members.map(m => m.id), ['DLV-1', 'DLV-2']);
  const m = batchFixture([['feat/a', 'bad-a.txt']]);
  const r1 = await mergeqRun({ stateDir: m.state, project: m.project, locksDir: m.locks });
  assert.equal(r1.batch.result, 'pinned');
  assert.deepEqual(r1.batch.runs.map(x => x.label), ['batch', 'retry', 'base']);
});

// MQ-STARVE (DEC-72 b): batches 12-17 were main-red at one base while the branch that fixed main scored 5th of batch_max 4
function mainRedFixture(n) {
  // main breaks the gate after the branches (bad-main.txt committed + pushed): part of the template recipe
  return batchFixture([['feat/a', 'docs/a.md'], ['feat/b', 'docs/b.md'], ['feat/c', 'docs/c.md'], ['feat/d', 'docs/d.md']].slice(0, n), { mainRed: true });
}
test('main-red: no row shown to fix main -> the same member set is not rebuilt at the same base (one why); then the row whose diff touches the base gate failing files goes first and lands though it scores 5th', async () => {
  const f = mainRedFixture(4);
  const r1 = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.deepEqual(r1.batch.members.map(m => m.id), ['DLV-1', 'DLV-2', 'DLV-3', 'DLV-4']);
  assert.equal(r1.batch.result, 'main-red'); assert.equal(r1.batch.status, 'main-red');
  assert.equal(g(f.repo, 'branch', '--list', 'mq/batch-1'), '', 'abandoned (no green prefix): Norn deletes its batch branch (META-SLOP-A)');
  assert.equal(r1.fix, null); assert.deepEqual(loadMq(f.state).red, {}, 'a red main pins nobody');
  assert.deepEqual(r1.batch.main_reds, [{ file: 'bad-main.txt', name: 'in the tree' }], 'the base gate log names the reds of main');
  const r2 = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.equal(r2.batch, null);
  assert.match(r2.why, /^main [0-9a-f]{7} is red under the gate \(batch-1: bad-main\.txt\) and no queued row's diff touches those files: batch-1's members are not rebuilt at the same base/);
  assert.equal(loadMq(f.state).n, 1, 'no batch-2 built');
  assert.match(fs.readFileSync(path.join(f.state, 'mq', 'run.log'), 'utf8'), /no queued row's diff touches those files/);
  // the fix arrives as a 5th row (newest, so it scores last)
  const wt = path.join(path.dirname(f.repo), 'wt-fix');
  g(f.repo, 'worktree', 'add', '-q', '-b', 'feat/fix', wt, 'main');
  g(wt, 'rm', '-q', 'bad-main.txt'); g(wt, 'commit', '-q', '-m', 'fix main'); g(wt, 'push', '-q', '-u', 'origin', 'feat/fix');
  record(f.state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo: fwd(f.repo), branch: 'feat/fix', tip: g(wt, 'rev-parse', 'HEAD'), lane: 'fix', delivers: 'fix', done_utc: at(-1).toISOString() } }, { now: () => at(-1), views: false });
  const r3 = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.equal(r3.batch.members[0].id, 'DLV-5', 'the row that fixes main goes first');
  assert.deepEqual(r3.batch.members.map(m => m.id), ['DLV-5', 'DLV-1', 'DLV-2', 'DLV-3'], 'the rest by score');
  assert.deepEqual(r3.batch.fixes_main, ['DLV-5']);
  assert.equal(r3.batch.result, 'green');
});

test('kill criterion: red then green on the one retry = unpinned; twice in a row turns batching off (recorded why); never a second retry', async () => {
  const counter = path.join(tmp('ctr'), 'n');
  const f = batchFixture([['feat/a', 'docs/a.md'], ['feat/b', 'docs/b.md']], { flakyCounter: counter });
  f.project.merge.batch_max = 1;
  const r = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.equal(r.batch.result, 'flaky');
  assert.deepEqual(r.batch.runs.map(x => [x.label, x.ok]), [['batch', false], ['retry', true]]);
  assert.equal(r.batch.status, 'green', "Gas Town's retry: a green retry merges");
  assert.match(fs.readFileSync(r.batch.brief, 'utf8'), /on its one retry/);
  assert.equal(loadMq(f.state).unpinned, 1);
  mergeBatch(f, r.batch);
  const r2 = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.equal(r2.batch.result, 'flaky');
  assert.match(r2.why, /batching now OFF: the gate is not deterministic: 2 red batches in a row/);
  mergeBatch(f, r2.batch);
  const off = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.match(off.why, /^batching OFF since/);
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 4, 'two gate runs per batch, never a third');
  assert.equal(setBatching(f.state, true).batching.off, false);
  assert.equal(loadMq(f.state).unpinned, 0);
});

test('no fast gate (kestrel): auto-update only, no batch', async () => {
  const f = batchFixture([['feat/a', 'docs/a.md']]);
  delete f.project.merge;
  const r = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.match(r.why, /no fast merge gate declared/);
  assert.equal(r.batch, null);
  assert.ok(!fs.existsSync(path.join(f.state, 'mq', 'state.json')), 'no batch state');
  assert.match(fs.readFileSync(path.join(f.state, 'mq', 'run.log'), 'utf8'), /no fast merge gate declared/);
  assert.ok(!fs.existsSync(path.join(f.state, 'mq', 'run.lock')), 'the pass lock is released');
});

// ---------- piece 4: an epic's integration branch ----------
test('integration branch: an epic with integration_branch batches into it (a fast-forward push, no MERGE stage); main stays; the rest batch into main', async () => {
  const f = batchFixture([['feat/a', 'docs/a.md'], ['feat/b', 'docs/b.md'], ['feat/c', 'docs/c.md']]);
  record(f.state, { kind: 'epic', ev: 'create', by: 'controller', data: { title: 'ep', priority: 'P0', members: ['DLV-1', 'DLV-3'], integration_branch: 'int/ep1' } }, { now: () => at(-5), views: false });
  const q = mergeQueue({ stateDir: f.state, project: f.project, now: NOW }).rows;
  assert.deepEqual(q.map(r => [r.id, r.into]), [['DLV-1', 'int/ep1'], ['DLV-3', 'int/ep1'], ['DLV-2', 'main']]);
  const mainBefore = g(f.origin, 'rev-parse', 'main');
  const r = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.deepEqual(r.batch.members.map(m => m.id), ['DLV-1', 'DLV-3'], 'one target per batch: the top row\'s');
  assert.equal(r.batch.into, 'int/ep1');
  assert.equal(r.batch.base, mainBefore, 'a new integration branch starts at main');
  assert.equal(r.batch.status, 'merged'); assert.equal(r.batch.brief, undefined, 'no MERGE stage for an integration branch');
  assert.match(r.why, /GREEN .*pushed origin\/int\/ep1 = [0-9a-f]{40}/);
  assert.equal(g(f.origin, 'rev-parse', 'int/ep1'), r.batch.merge_tip);
  assert.equal(g(f.origin, 'rev-parse', 'main'), mainBefore, 'main untouched');
  // the integrated rows left the queue; the next batch is main's
  assert.deepEqual(mergeQueue({ stateDir: f.state, project: f.project, now: NOW }).rows.map(r2 => r2.id), ['DLV-2']);
  const r2 = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.equal(r2.batch.into, 'main'); assert.equal(r2.batch.status, 'green'); assert.ok(r2.batch.brief);
  // a second epic member later batches onto the existing integration branch (a fast-forward on top of it)
  const wt = path.join(path.dirname(f.repo), 'wt-e');
  g(f.repo, 'worktree', 'add', '-q', '-b', 'feat/e', wt, 'main');
  const te = commit(wt, 'docs/e.md', 'e\n', 'e work'); g(wt, 'push', '-q', '-u', 'origin', 'feat/e');
  record(f.state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo: fwd(f.repo), branch: 'feat/e', tip: te, lane: 'e', delivers: 'e', done_utc: at(-1).toISOString() } }, { now: () => at(-1), views: false });
  record(f.state, { kind: 'epic', ev: 'add', id: 'EP-1', by: 'controller', data: { members: ['DLV-4'] } }, { views: false });
  mergeBatch(f, r2.batch);
  const r3 = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.equal(r3.batch.into, 'int/ep1'); assert.equal(r3.batch.base, r.batch.merge_tip);
  assert.equal(g(f.origin, 'rev-parse', 'int/ep1^1'), r.batch.merge_tip);
});

test('the check-in gate probe: a green batch / a fix ask / batching OFF wake the check-in once the pass wrote them', async () => {
  const f = batchFixture([['feat/a', 'docs/a.md'], ['feat/c', 'bad-c.txt']]);
  const before = Date.now() - 1000;
  const r = await mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks });
  assert.equal(r.batch.culprit.id, 'DLV-2');
  const probe = mqProbe(f.state);
  assert.deepEqual(probe({ at: before }), [], 'the gate baseline (the last check-in) lacks them');
  assert.deepEqual(probe({ at: Date.now() + 1000 }), ['mq:batch-1:green', `mq:fix:DLV-2:${f.tips['feat/c'].slice(0, 7)}`]);
  const probes = gateProbes({ ...f.project, state: f.state }, {});
  assert.ok(probes.length >= 2 && probes.some(p => p({ at: Date.now() + 1000, running: [], runs: [], items: [] }).includes('mq:batch-1:green')));
  assert.ok(!gateProbes({ ...f.project, merge: undefined, state: f.state }, {}).some(p => p({ at: Date.now() + 1000, running: [], runs: [], items: [] }).some(x => x.startsWith('mq:'))));
});
