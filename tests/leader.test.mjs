// RM-46 S6a (multi-home SPEC 4.8): the merge leader - one merge queue per project. leader/<project>/merge.json on the claims branch with
// the work claim's CAS, renew, fence and stale clock (claims.mjs claimLeader, tick.mjs claimsPass); the queue step and a MERGE stage's
// start refuse on a non-leader; a stale leader is taken over at once; an old leader that comes back stops its MERGE run; a non-leader
// opens the PRs of its DONE pushed lane branches (mergeland.mjs followerPrs, the lane worktree as the tested merge; the slop door applies).
// Synthetic homes a and b of project demo, one temp bare ledger remote, temp git repos, a fake gh; clocks are injected, nothing sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { claimsPass } from '../engine/lib/tick.mjs';
import { tickMergeq } from '../engine/lib/mergeq.mjs';
import { followerPrs } from '../engine/lib/mergeland.mjs';
import { claimDoor, RunRefused, hbPath, queueRun, readiness, fillQueue } from '../engine/lib/runs.mjs';
import { readSync, leaderKey, workKey } from '../engine/lib/claims.mjs';
import { makeGit } from '../engine/lib/dlvgit.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const S = 1000, POL = { lease_s: 3600, renew_s: 600, fence_s: 3000, stale_grace_s: 300 }, T0 = Date.UTC(2026, 10, 20), KEY = 'leader/demo/merge.json';
function rig() {
  const t = mkTmp('meta-leader-'), remote = path.join(t, 'remote.git');
  spawnSync('git', ['init', '-q', '--bare', remote], { windowsHide: true });
  const at = key => { const r = spawnSync('git', ['show', `refs/heads/claims:${key}`], { env: { ...process.env, GIT_DIR: remote }, encoding: 'utf8', windowsHide: true }); return r.status ? null : JSON.parse(r.stdout); };
  const home = id => {
    const root = path.join(t, id), state = path.join(root, 'state', 'demo');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'home.json'), JSON.stringify({ id, bare_home: 'a' }));
    const ledger = { dir: path.join(root, 'ledger.git'), remote, branch: `machine/host-${id}` }, offline = { ...ledger, remote: path.join(t, 'gone.git') }, killed = [];
    const pass = (now, o = {}) => claimsPass(state, { ledger, policy: { sync: POL }, now, mergeq: true, kill: p => killed.push(p), ...o });
    // a running MERGE run with no process behind it (stopped through the kill seam)
    const merging = () => { const e = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'x', stage: 'MERGE' } });
      fs.mkdirSync(path.dirname(hbPath(state, e.id)), { recursive: true }); fs.writeFileSync(hbPath(state, e.id), JSON.stringify({ run: e.id, pid: 424242, supervisor_pid: 434343 })); return e.id; };
    const door = now => claimDoor({ state, stage: 'MERGE', kind: 'worker', lane: 'x', git_ledger: ledger, now, policy: { sync: POL } });
    return { id, state, ledger, offline, pass, killed, merging, door, item: x => loadState(state).items[x] };
  };
  return { t, at, a: home('a'), b: home('b') };
}
const project = h => ({ name: 'demo', file: path.join(h.state, 'project.json'), deliverables: {}, root: h.state });

test('one queue per project: the first home claims the leader; the other home\'s queue step and MERGE start refuse ("merge leader is a")', () => {
  const g = rig();
  const la = g.a.pass(T0).leader, lb = g.b.pass(T0).leader;
  assert.equal(la.leader, true);
  assert.equal(g.at(KEY).home, 'a'); assert.equal(g.at(KEY).kind, 'leader'); assert.equal(g.at(KEY).n, 1);
  assert.deepEqual([lb.leader, lb.holder, lb.why], [false, 'a', 'merge leader is a']);
  const spawned = [], spawnFn = (exe, args) => { spawned.push(args); return { pid: 7 }; };
  assert.equal(tickMergeq(project(g.a), g.a.state, { metaCmd: 'norn.mjs', spawnFn, leader: la }), 'mergeq: started pid 7');
  assert.equal(tickMergeq(project(g.b), g.b.state, { metaCmd: 'norn.mjs', spawnFn, leader: lb }), 'mergeq: refused - merge leader is a');
  assert.equal(spawned.length, 1, 'only the leader runs the queue');
  assert.equal(tickMergeq(project(g.b), g.b.state, { metaCmd: 'norn.mjs', spawnFn }), 'mergeq: started pid 7', 'not synced (no leader state): the queue runs as on one home');
  assert.equal(g.a.door(T0 + S), null, 'a MERGE stage starts on the leader');
  assert.throws(() => g.b.door(T0 + S), e => e instanceof RunRefused && e.code === 3 && /MERGE: merge leader is a/.test(e.message));
  // the leader renews with its work claims; b keeps following
  const tip = g.at(KEY).nonce;
  assert.equal(g.a.pass(T0 + 601 * S).leader.leader, true);
  assert.deepEqual([g.at(KEY).n, g.at(KEY).nonce], [2, tip]);
  assert.equal(g.b.pass(T0 + 601 * S).leader.leader, false);
});

test('a stale leader is taken over at once by a home that runs the queue (no owner step); before lease_s + grace it is not', () => {
  const g = rig();
  g.a.pass(T0);
  g.b.pass(T0);   // b first sees n=1
  assert.equal(g.b.pass(T0 + 3899 * S).leader.leader, false, 'one second short of lease_s + grace');
  assert.equal(g.b.pass(T0 + 3899 * S, { mergeq: false }).leader.leader, false);
  const l = g.b.pass(T0 + 3900 * S).leader;
  assert.equal(l.leader, true); assert.equal(l.took, 'a');
  assert.equal(g.at(KEY).home, 'b');
  assert.match(readSync(g.b.state, 'rows').events.at(-1).why, /a\/merge leader was stale: taken over by b/);
  assert.equal(g.b.door(T0 + 3901 * S), null);
});

test('the old leader fences its MERGE run: unconfirmed past fence_s (offline), and when it comes back to find its claim gone', () => {
  const g = rig();
  g.a.pass(T0);
  const r1 = g.a.merging();
  assert.deepEqual(g.a.pass(T0 + 3000 * S, { ledger: g.a.offline }).leader.fenced, [], 'at fence_s: not yet');
  const off = g.a.pass(T0 + 3001 * S, { ledger: g.a.offline }).leader;
  assert.deepEqual([off.leader, off.fenced], [false, [r1]]);
  assert.equal(g.a.item(r1).state, 'lost');
  assert.match(g.a.item(r1).history.find(h => h.ev === 'lost').data.why, /^fenced: merge leader claim not confirmed for 3001 s/);
  assert.deepEqual(g.a.killed, [434343, 424242]);
  assert.throws(() => g.a.door(T0 + 3002 * S), /MERGE: merge leader claim not confirmed for 3002 s \(fenced\)/);
  // b takes the stale leader over; a wakes with network, starts a MERGE meanwhile, and its renew finds the claim gone
  g.b.pass(T0); g.b.pass(T0 + 3900 * S);
  assert.equal(g.at(KEY).home, 'b');
  const r2 = g.a.merging();
  const back = g.a.pass(T0 + 4000 * S).leader;
  assert.deepEqual([back.leader, back.holder, back.fenced], [false, 'b', [r2]]);
  assert.match(g.a.item(r2).history.find(h => h.ev === 'lost').data.why, /^merge leader taken over on /);
  assert.equal(readSync(g.a.state, 'rows').events.find(e => e.kind === 'taken').id, leaderKey('demo'));
  assert.equal(g.at(KEY).home, 'b', 'a does not take it back');
  assert.throws(() => g.a.door(T0 + 4001 * S), /merge leader is b/);
});

// ---------- a non-leader opens the PRs of its DONE pushed lane branches ----------
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const ghGit = () => makeGit((cwd, args) => (args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/o/r.git\n' : git(cwd, ...args) + '\n'));
function laneRepo(t) {
  const origin = path.join(t, 'origin.git'), repo = path.join(t, 'repo');
  fs.mkdirSync(origin, { recursive: true }); git(origin, 'init', '-q', '--bare', '-b', 'main');
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'commit.gpgsign', 'false'); git(repo, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base'); git(repo, 'push', '-q', 'origin', 'main');
  const lane = (name, file) => {
    const wt = path.join(t, `wt-${name}`), branch = `norn/b/${name}`;
    git(repo, 'worktree', 'add', '-q', '-b', branch, wt);
    fs.writeFileSync(path.join(wt, file), `${name}\n`); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', `${name} work`); git(wt, 'push', '-q', 'origin', branch);
    return { wt, branch };
  };
  return { repo, lane };
}
function doneLane(state, name, { wt, branch }) {
  record(state, { kind: 'lane', ev: 'create', by: 'controller', data: { name } }, { views: false });
  const r = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: name, worktree: wt } });
  record(state, { kind: 'run', ev: 'end', id: r.id, by: 'launcher', data: { exit: 0, outcome: 'done', branch, head: git(wt, 'rev-parse', 'HEAD') } });
  return r.id;
}

test('a non-leader opens the PR of its DONE pushed lane branch through a fake gh (the lane worktree as wt), once; the slop door can refuse', () => {
  const g = rig(), t = mkTmp('meta-leader-pr-'), rp = laneRepo(t), ok = rp.lane('x', 'x.txt'), bad = rp.lane('y', 'y.orig');
  const rx = doneLane(g.b.state, 'x', ok); doneLane(g.b.state, 'y', bad);
  const created = [], calls = [];
  const gh = args => { calls.push(args); if (args[1] === 'list') return { code: 0, out: '[]', err: '' }; created.push(args[args.indexOf('--head') + 1]); return { code: 0, out: `https://github.com/o/r/pull/${created.length}\n`, err: '' }; };
  const bl = { rule: 'K2', level: 'BLOCK', file: 'y.orig', line: 1, msg: 'synthetic' };
  const door = (branch, tip) => ({ check: { head: tip, findings: branch.endsWith('/y') ? [bl] : [] }, open: branch.endsWith('/y') ? [bl] : [] });
  const p = { name: 'demo', file: path.join(t, 'project.json'), state: g.b.state, deliverables: { repo: rp.repo, main: 'main' } };
  const rs = followerPrs(p, g.b.state, { git: ghGit(), gh, door });
  assert.deepEqual(rs.map(r => [r.lane, r.status]), [['x', 'opened'], ['y', 'refused']], JSON.stringify(rs));
  assert.equal(rs[0].run, rx); assert.equal(rs[0].url, 'https://github.com/o/r/pull/1');
  assert.match(rs[1].why, /1 open slop BLOCK finding\(s\)/);
  assert.deepEqual(created, ['norn/b/x'], 'no PR for the refused branch');
  assert.equal(git(rp.repo, 'rev-parse', 'main'), git(path.join(t, 'origin.git'), 'rev-parse', 'main'), 'main untouched');
  const n = calls.length;
  assert.deepEqual(followerPrs(p, g.b.state, { git: ghGit(), gh, door }), [], 'the open PR costs no gh call again; the same refusal says nothing new');
  assert.equal(calls.length, n);
  assert.equal(readSync(g.b.state, 'prs')['norn/b/x'].url, 'https://github.com/o/r/pull/1');
});

// DLV-a-237 (DEC-a-681): ci-fix lanes are reused and a check-in may not unarchive, so a DONE run can end on an archived lane; its work
// is newer than the archive and gets its PR. A lane archived after its last DONE run stays skipped: no git, no gh.
test('followerPrs opens the PR of a DONE run on an archived lane; a lane archived after its DONE run is skipped with no gh call', () => {
  const g = rig(), t = mkTmp('meta-leader-arch-'), rp = laneRepo(t), at = s => () => new Date(T0 + s * S);
  const lane = (name, archiveAt, startAt, endAt) => {
    const w = rp.lane(name, `${name}.txt`), id = record(g.b.state, { kind: 'lane', ev: 'create', by: 'controller', data: { name } }, { now: at(0), views: false }).id;
    const archive = () => record(g.b.state, { kind: 'lane', ev: 'archive', id, by: 'tick', data: { why: 'test' } }, { now: at(archiveAt), views: false });
    if (archiveAt < startAt) archive();
    const r = record(g.b.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: name, worktree: w.wt } }, { now: at(startAt) });
    record(g.b.state, { kind: 'run', ev: 'end', id: r.id, by: 'launcher', data: { exit: 0, outcome: 'done', branch: w.branch, head: git(w.wt, 'rev-parse', 'HEAD') } }, { now: at(endAt) });
    if (archiveAt > endAt) archive();
    return r.id;
  };
  const p = { name: 'demo', file: path.join(t, 'project.json'), state: g.b.state, deliverables: { repo: rp.repo, main: 'main' } };
  const calls = [], gh = args => { calls.push(args); return args[1] === 'list' ? { code: 0, out: '[]', err: '' } : { code: 0, out: 'https://github.com/o/r/pull/1\n', err: '' }; };
  const late = lane('late', 10, 20, 30);
  lane('old', 40, 1, 2);
  const st = n => Object.values(loadState(g.b.state).items).find(i => i.kind === 'lane' && i.data?.name === n)?.state;
  assert.deepEqual([st('late'), st('old')], ['archived', 'archived']);
  const rs = followerPrs(p, g.b.state, { git: ghGit(), gh, door: null });
  assert.deepEqual(rs.map(r => [r.lane, r.status, r.run]), [['late', 'opened', late]], JSON.stringify(rs));
  assert.ok(calls.every(a => !a.includes('norn/b/old')), 'no gh call for the lane archived after its DONE run');
  // only the archived-before-DONE lane: the stale one costs no gh call at all
  const g2 = rig(), t2 = mkTmp('meta-leader-arch2-'), rp2 = laneRepo(t2), w = rp2.lane('old', 'old.txt');
  const id = record(g2.b.state, { kind: 'lane', ev: 'create', by: 'controller', data: { name: 'old' } }, { now: at(0), views: false }).id;
  const r = record(g2.b.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'old', worktree: w.wt } }, { now: at(1) });
  record(g2.b.state, { kind: 'run', ev: 'end', id: r.id, by: 'launcher', data: { exit: 0, outcome: 'done', branch: w.branch, head: git(w.wt, 'rev-parse', 'HEAD') } }, { now: at(2) });
  record(g2.b.state, { kind: 'lane', ev: 'archive', id, by: 'tick', data: { why: 'test' } }, { now: at(3), views: false });
  const calls2 = [], gits = [], spy = makeGit((cwd, args) => { gits.push(args); return git(cwd, ...args) + '\n'; });
  assert.deepEqual(followerPrs({ ...p, state: g2.b.state, deliverables: { repo: rp2.repo, main: 'main' } }, g2.b.state, { git: spy, gh: a => { calls2.push(a); return { code: 0, out: '[]', err: '' }; }, door: null }), []);
  assert.deepEqual([calls2.length, gits.length], [0, 0], 'no gh and no git call');
});

// merge-slot (11-21: RUN-b-580 / RUN-b-581 sat queued on home b "held by the cap / the CPU" while every start was refused): a home that
// is not the merge leader never queues a MERGE run, and one queued before is withdrawn with the leader's words - never a cap or CPU term
test('a non-leader home refuses to queue a MERGE; a MERGE queued there before is withdrawn naming the leader', () => {
  const g = rig();
  g.a.pass(T0); g.b.pass(T0);
  const brief = path.join(g.t, 'brief.md'), wt = path.join(g.t, 'wt-m'), budget_file = path.join(g.t, 'budget.json');
  fs.writeFileSync(brief, 'mode: done\n'); fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(budget_file, JSON.stringify({ max_claude_workers: 0 }));
  const o = { state: g.b.state, locksDir: path.join(g.t, 'locks'), executor: 'fake', lane: 'm', stage: 'MERGE', brief, worktree: wt, notes: path.join(g.t, 'N.md'),
    policy: { auto_resume_max: 0, sync: POL }, tick: null, budget_file, now: T0 + S };
  assert.throws(() => queueRun({ ...o, git_ledger: g.b.ledger }), e => e instanceof RunRefused && e.code === 3 && /^MERGE: merge leader is a - this home only opens PRs$/.test(e.message));
  // queued before the door (no ledger in its spec then); the ledger is in the spec now: the walk withdraws it with the leader's words
  const id = queueRun(o).run, specFile = path.join(g.b.state, 'runs', `${id}.queue.json`);
  fs.writeFileSync(specFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(specFile, 'utf8')), git_ledger: g.b.ledger }));
  const row = readiness(g.b.state, { now: T0 + S, resources: () => ({ free_gb: 64, cpu_pct: 99 }) }).find(r => r.id === id);
  assert.deepEqual([row.ready, row.withdraw], [false, 'MERGE: merge leader is a - this home only opens PRs']);
  assert.ok(!row.terms.some(t => /^(cap|resources)/.test(t)), row.terms.join('; '));
  fillQueue(g.b.state, { now: T0 + S, resources: () => ({ free_gb: 64, cpu_pct: 99 }) });
  assert.equal(g.b.item(id).state, 'withdrawn');
});

// slop C16: the stage is case-insensitive everywhere (usageguard isMergeStage) - `--stage merge` is a MERGE for the leader gate and
// the claim exemption too, not only for its merge worktree
test('--stage merge (lower case): the non-leader refuses it like MERGE; on the leader it takes no work claim', () => {
  const g = rig();
  g.a.pass(T0); g.b.pass(T0);
  const wt = path.join(g.t, 'wt-x'); fs.mkdirSync(wt, { recursive: true });
  const door = (h, now) => claimDoor({ state: h.state, stage: 'merge', kind: 'worker', lane: 'x', worktree: wt, git_ledger: h.ledger, now, policy: { sync: POL } });
  assert.throws(() => door(g.b, T0 + S), e => e instanceof RunRefused && e.code === 3 && /MERGE: merge leader is a/.test(e.message));
  assert.equal(door(g.a, T0 + S), null);
  assert.equal(g.at(workKey('demo', 'a', 'x')), null, 'a MERGE stage is exempt from the work claim');
});
