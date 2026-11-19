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
import { claimDoor, RunRefused, hbPath } from '../engine/lib/runs.mjs';
import { readSync, leaderKey } from '../engine/lib/claims.mjs';
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
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  const door = (branch, tip) => (branch.endsWith('/y') ? `1 open slop BLOCK finding(s) at ${tip.slice(0, 7)}` : null);
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
