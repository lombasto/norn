// META-GTP-MERGEQ (GT-PARITY-PLAN sec. 2.4; Gas Town refinery batch.go / score.go / engineer.go, done_rebase.go - cited, not
// ported): staged merges (--sha), the supersede event, the MR score queue, auto-update, batch + bisect, integration branches.
// Every git case runs on temp repos; no live state.
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
import { mrScore, mergeQueue, formatMq, autoUpdate, mergeqRun, intoSha, mainShaOf } from '../engine/lib/mergeq.mjs';
import { mergeConfig } from '../engine/lib/mergecfg.mjs';
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
const P = { name: 'norn', root: '/h/dev/sdd-codex', meta: '/h/dev/sdd-codex', state: '/h/state/norn', deliverables: { main: 'main' }, policy: {} };
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

// ---------- piece 0: staged lanes ----------
test('merge brief --sha: merges THAT commit in its own merge worktree and never touches the lane worktree; marker says staged', () => {
  const sha = '03f9b94'.padEnd(40, 'a');
  const txt = renderMergeBrief(P, { ...O, sha, ui: true });
  assert.doesNotMatch(txt, /\{\{/);
  assert.match(txt, new RegExp(`merge --no-ff --no-commit ${sha}`));
  assert.match(txt, new RegExp(`merge-base --is-ancestor ${sha} origin/feat/vis`));
  assert.doesNotMatch(txt, /rebase origin|force-with-lease|-C \/h\/dev\/sdd-codex-vis (fetch|rebase|push|merge)/, 'nothing runs in the lane worktree');
  assert.match(txt, /NEVER touch the lane worktree \/h\/dev\/sdd-codex-vis/);
  for (const s of ['merge-land --project', '--branch feat/vis', 'norn.mjs" smoke', 'norn.mjs" done', 'MERGE-NOTES.md', 'SHOTS AFTER']) assert.ok(txt.includes(s), s);
  const land = { repo: '/h/dev/sdd-codex', slots: 2, main_branch: 'main', remote: 'origin' };
  assert.deepEqual(briefMarker(txt), { mode: 'staged', lane: 'meta-vis', branch: 'feat/vis', worktree: '/h/dev/sdd-codex-vis', sha, merge_wt: mergeWtPath(P.state, 'meta-vis', sha), ...land, notes: '/h/r/meta-vis/MERGE-NOTES.md' });
  assert.match(txt, new RegExp(`git -C ${mergeWtPath(P.state, 'meta-vis', sha)} merge --no-ff --no-commit ${sha}`), 'the merge is made in the merge worktree');
  assert.doesNotMatch(txt, /git -C \/h\/dev\/sdd-codex (pull|merge|commit|push)/, 'never in the owner checkout');
  // the rebase brief keeps its text and names the lane worktree it rebases in
  const rb = renderMergeBrief(P, O);
  assert.match(rb, /rebase origin\/main/);
  assert.deepEqual(briefMarker(rb), { mode: 'rebase', lane: 'meta-vis', branch: 'feat/vis', worktree: '/h/dev/sdd-codex-vis', merge_wt: mergeWtPath(P.state, 'meta-vis'), ...land, notes: '/h/r/meta-vis/MERGE-NOTES.md' });
  assert.throws(() => renderMergeBrief({ ...P, state: undefined }, O), /no state dir/);
  assert.equal(briefMarker('# a hand-written brief'), null);
  assert.throws(() => renderMergeBrief(P, { ...O, sha: 'nothex' }), /sha/);
});

function nornProject(t, extra = {}) {
  const pj = path.join(t, 'project.json');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 'norn', title: 'n', root: fwd(t), ledger: '${root}/L.md', briefs_dir: '${root}', policy: {}, ...extra }));
  return pj;
}

test('merge-brief refuses a lane whose worktree holds a live run unless --sha (exit 3); --sha needs no worktree write', () => {
  const t = tmp('mb');
  const pj = nornProject(t, { policy: { slop: { enabled: false } } });   // no repo behind 03f9b94: the slop door (slop-gate.test) would refuse it
  const state = path.join(t, 'state', 'norn'), locks = path.join(t, 'state', 'locks'), wt = path.join(t, 'wt-vis');
  fs.mkdirSync(wt, { recursive: true });
  const run = liveRun(state, locks, { lane: 'meta-vis', worktree: wt });
  const base = ['merge-brief', '--project', pj, '--lane', 'meta-vis', '--branch', 'feat/vis', '--worktree', fwd(wt), '--notes', fwd(t) + '/N.md', '--out', path.join(t, 'B.md')];
  const env = { META_ROOT: t };
  const no = cli(base, env);
  assert.equal(no.code, 3, no.err);
  assert.match(no.out, new RegExp(`REFUSED: .*${run}.*--sha`));
  assert.ok(!fs.existsSync(path.join(t, 'B.md')));
  const ok = cli([...base, '--sha', '03f9b94'], env);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /merge-brief -> .*B\.md \(staged 03f9b94/);
  assert.match(fs.readFileSync(path.join(t, 'B.md'), 'utf8'), /merge --no-ff --no-commit 03f9b94/);
});

test('norn run --stage MERGE refuses (exit 3) a rebase brief while the lane worktree holds a live run; a staged brief starts; the fill waits too', () => {
  const t = tmp('mr');
  const state = path.join(t, 'state', 'norn'), locks = path.join(t, 'state', 'locks'), wt = path.join(t, 'wt-vis'), mainCo = path.join(t, 'main');
  fs.mkdirSync(wt, { recursive: true }); fs.mkdirSync(mainCo, { recursive: true });
  g(mainCo, 'init', '-q', '-b', 'main'); g(mainCo, 'config', 'commit.gpgsign', 'false'); commit(mainCo, 'README.md', 'r\n', 'init');   // the repo merge worktrees come from
  const PP = { ...P, root: fwd(mainCo), state: fwd(state) };
  const run = liveRun(state, locks, { lane: 'meta-vis', worktree: wt });
  const rb = path.join(t, 'rebase.md'), st = path.join(t, 'staged.md'), hand = path.join(t, 'hand.md');
  fs.writeFileSync(rb, renderMergeBrief(PP, { ...O, worktree: fwd(wt) }));
  fs.writeFileSync(st, renderMergeBrief(PP, { ...O, worktree: fwd(wt), sha: 'abcdef1' }));
  fs.writeFileSync(hand, '# MERGE by hand\n');
  const o = { state, locksDir: locks, executor: 'fake', lane: 'meta-vis', worktree: mainCo, stage: 'MERGE', tick: null, env: { FAKE_MS: '1' } };
  assert.throws(() => startRun({ ...o, brief: rb }), e => e.code === 3 && new RegExp(`${run}.*--sha`).test(e.message));
  // no marker (a hand-written brief): the lane's own live run still refuses
  assert.throws(() => startRun({ ...o, brief: hand }), e => e.code === 3 && /lane meta-vis/.test(e.message));
  // a queued MERGE with the rebase brief waits in the fill / norn ready with the same reason
  const q = startRun({ ...o, brief: rb, after: [{ kind: 'run', id: run, state: 'ended' }] });
  assert.ok(q.queued);
  record(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { outcome: 'done', exit: 0 } }, { views: false });
  // the lane run ended but its worktree lock is still fresh (the lane's next stage started there): still refused
  const row = readiness(state, { resources: () => ({ free_gb: 64, cpu_pct: 1 }) }).find(r => r.id === q.run);
  assert.equal(row.ready, false);
  assert.ok(row.terms.some(x => /MERGE .*--sha/.test(x)), row.terms.join('; '));
  // META-AUTONOMY R1: one MERGE run of the lane at a time (lane + stage + round) - the queued rebase MERGE gives way to the staged one
  record(state, { kind: 'run', ev: 'withdraw', id: q.run, by: 'controller', data: { why: 'replaced by the staged brief' } }, { views: false });
  const s = startRun({ ...o, brief: st });
  assert.ok(s.run, 'a staged brief starts while the lane writes');
  // progress-based (DEC-84 B): wait while its supervisor lives, never 400 x 50 ms (CI 43207062452: still 'running' on the loaded Windows leg)
  const item = () => loadState(state).items[s.run];
  waitForSync(() => item()?.state !== 'running', { producer: supervisorAlive(state, item), what: `${s.run} ends` });
  assert.equal(loadState(state).items[s.run].state, 'exited');
  // the supervisor removes the merge worktree after it records the end: wait for that while it lives
  waitForSync(() => !fs.existsSync(mergeWtPath(state, 'meta-vis', 'abcdef1')), { producer: supervisorAlive(state, item), what: `${s.run} removes its merge worktree` });
});

test('deliverable supersede --by DLV-n | merge sha: terminal, never due / asked / resolved / listed again; bad citations refused', () => {
  const repo = tmp('repo');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'README.md', 'r\n', 'init');
  g(repo, 'checkout', '-q', '-b', 'feat/dv');
  const tip = commit(repo, 'README.md', 'dv\n', 'dash visual');
  g(repo, 'update-ref', 'refs/remotes/origin/feat/dv', tip);
  g(repo, 'checkout', '-q', 'main');
  const port = commit(repo, 'README.md', 'ported\n', 'port of dash visual');
  const state = tmp('state');
  const mk = (branch, t2) => record(state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo, branch, tip: t2, lane: 'dv', done_utc: at(-200).toISOString() } }, { now: () => at(-200), views: false });
  mk('feat/dv', tip); mk('feat/other', tip);
  const project = { name: 't', root: repo, deliverables: { receipts: [], ask_after_h: 4 } };
  assert.ok(deliverablesView({ stateDir: state, project, now: NOW }).rows.find(r => r.id === 'DLV-1').due, 'due before');
  const pj = path.join(tmp('pj'), 'project.json');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 't', title: 't', root: fwd(repo), deliverables: { receipts: [] } }));
  const base = ['deliverables', '--project', pj, '--state', state, '--as', 'checkin'];
  for (const [by, re] of [['DLV-9', /DLV-9.*does not exist/], ['DLV-1', /itself/], ['zz12', /DLV-n or a commit sha/]]) {
    const r = cli([...base, 'supersede', 'DLV-1', '--by', by, '--why', 'w']);
    assert.equal(r.code, 2, by); assert.match(r.err, re);
  }
  assert.equal(cli([...base, 'supersede', 'DLV-1', '--by', '0000000', '--why', 'w']).code, 2, 'a sha the repo lacks is refused');
  assert.equal(cli([...base, 'supersede', 'DLV-1', '--by', port.slice(0, 7)]).code, 2, '--why is required');
  const ok = cli([...base, 'supersede', 'DLV-1', '--by', port.slice(0, 7), '--why', 'ported by VISUAL-B']);
  assert.equal(ok.code, 0, ok.err); assert.match(ok.out, /DLV-1 superseded by [0-9a-f]{7}/);
  const row = deliverablesView({ stateDir: state, project, now: NOW + 30 * 864e5 }).rows.find(r => r.id === 'DLV-1');
  assert.equal(row.record_state, 'superseded');
  assert.deepEqual({ due: row.due, at: row.at_target, resolve: row.resolve, by: row.superseded.by }, { due: false, at: true, resolve: null, by: port.slice(0, 7) });
  assert.match(askDeliverable(state, 'DLV-1', { project, nowMs: NOW }).refused, /superseded/);
  assert.match(resolveDeliverable(state, 'DLV-1', { project, nowMs: NOW }).refused, /superseded/);
  assert.doesNotMatch(cli(['deliverables', '--project', pj, '--state', state]).out, /DLV-1/);
  // terminal: no park / unpark / second supersede
  for (const sub of [['park', '--why', 'x'], ['unpark'], ['supersede', '--by', 'DLV-2', '--why', 'x']]) assert.notEqual(cli([...base, sub[0], 'DLV-1', ...sub.slice(1)]).code, 0, sub[0]);
  // --by DLV-n works
  assert.equal(cli([...base, 'supersede', 'DLV-2', '--by', 'DLV-1', '--why', 'same work']).code, 0);
});

// ---------- piece 1: the MR score queue ----------

// main + feat/a, feat/b, feat/c (clean docs) + feat/n (native .rs); all "pushed"; main moved once (each branch is 1 behind)
// (DEC-85) every fixture repo is built once per file (helpers/git-template.mjs) and copied per test: same tree, same tips
const qRepo = () => fromTemplate('mq-qrepo', buildQRepo, tmp('qrepo'));
function buildQRepo(repo) {
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'README.md', 'r\n', 'init');
  const tips = {};
  for (const [b, f] of [['feat/a', 'docs/a.md'], ['feat/b', 'docs/b.md'], ['feat/c', 'docs/c.md'], ['feat/n', 'crates/x/lib.rs']]) {
    g(repo, 'checkout', '-q', '-b', b, 'main');
    tips[b] = commit(repo, f, b + '\n', `${b} work`);
    g(repo, 'update-ref', `refs/remotes/origin/${b}`, tips[b]);
  }
  g(repo, 'checkout', '-q', 'main');
  commit(repo, 'docs/main.md', 'm\n', 'main moves');
  g(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  return { repo, tips };
}
function qState(f, extra = {}) {
  const state = tmp('qstate');
  const mk = (branch, lane, h) => record(state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo: f.repo, branch, tip: f.tips[branch], lane, delivers: lane + ' work', done_utc: at(-h).toISOString() } }, { now: () => at(-h), views: false });
  mk('feat/a', 'a', 48); mk('feat/b', 'b', 24); mk('feat/c', 'c', 72); mk('feat/n', 'n', 30);
  if (extra.epic !== false) record(state, { kind: 'epic', ev: 'create', by: 'controller', data: { title: 'b first', priority: 'P0', members: ['DLV-2'] } }, { now: () => at(-10), views: false });
  const run = data => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', worktree: '/x', ...data } }, { now: () => at(-1), views: false });
  run({ lane: 'c', brief: fwd(path.join(state, 'resolve', 'DLV-3-aaaaaaa-bbbbbbb.md')), stage: 'resolve' });
  run({ lane: 'c', brief: fwd(path.join(state, 'resolve', 'DLV-3-ccccccc-ddddddd.md')), stage: 'resolve' });
  run({ lane: 'c', brief: '/b/fix.md', stage: 'fix-1' });
  run({ lane: 'a', brief: '/b/s2.md', stage: 'S2' });   // not a fix round
  return state;
}
const qProject = (repo, merge) => ({ name: 't', root: repo, deliverables: { native: ['**/*.rs'], receipts: [] }, ...(merge ? { merge } : {}) });

// ENGINE-GIT (DEC-88): a branch tip lookup (remote ref first, then the local one) is ONE git spawn wherever the branch lives, and the
// mergeq view asks each target branch once per call
test('git cost: intoSha / mainShaOf are one git call (remote, local or missing); the answer is the remote tip first, exact names only', () => {
  const f = qRepo();
  g(f.repo, 'branch', 'int/x', 'main~1');                              // local only
  g(f.repo, 'update-ref', 'refs/remotes/origin/int/r', f.tips['feat/a']);  // remote only
  g(f.repo, 'update-ref', 'refs/remotes/origin/int/x', f.tips['feat/b']);  // both: the remote's wins
  const cfg = mergeConfig(qProject(f.repo));
  const one = fn => { const git = makeGit(); const v = fn(git); return [v, git.calls]; };
  assert.deepEqual(one(git => intoSha(cfg, 'int/x', git)), [f.tips['feat/b'], 1]);
  assert.deepEqual(one(git => intoSha(cfg, 'int/r', git)), [f.tips['feat/a'], 1]);
  assert.deepEqual(one(git => intoSha(cfg, 'feat/a', git)), [f.tips['feat/a'], 1]);
  assert.deepEqual(one(git => intoSha(cfg, 'int', git)), [null, 1], 'refs/heads/int/x is not the branch int');
  assert.deepEqual(one(git => intoSha(cfg, 'nope', git)), [null, 1]);
  assert.deepEqual(one(git => mainShaOf(f.repo, { main: 'main', git })), [g(f.repo, 'rev-parse', 'refs/heads/main'), 1], 'local main first');
  assert.deepEqual(one(git => mainShaOf(f.repo, { main: 'int/r', git })), [f.tips['feat/a'], 1], 'else the remote main');
  assert.deepEqual(one(git => mainShaOf(f.repo, { main: 'nope', git })), [null, 1]);
});

test('MR score = Gas Town score.go: 1000 + epic_h*10 + (4-P)*100 - min(retries*50, 300) + dlv_h; the queue sorts by it', () => {
  assert.equal(mrScore({}), 1200, 'no epic = P2');
  assert.equal(mrScore({ epicHours: 10, priority: 'P0', dlvHours: 24 }), 1524);
  assert.equal(mrScore({ retries: 9 }), 900, 'the retry penalty caps at 300');
  const f = qRepo(), state = qState(f);
  const { rows } = mergeQueue({ stateDir: state, project: qProject(f.repo, { gate: { cmd: 'node -e 0', timeout_min: 5, fast: true } }), now: NOW });
  assert.deepEqual(rows.map(r => [r.id, r.score, r.priority, r.epic, r.retries, r.gate, r.word]), [
    ['DLV-2', 1524, 'P0', 'EP-1', 0, 'batch', 'clean'],
    ['DLV-1', 1248, 'P2', null, 0, 'batch', 'clean'],
    ['DLV-4', 1230, 'P2', null, 0, 'door', 'clean'],
    ['DLV-3', 1122, 'P2', null, 3, 'batch', 'clean'],
  ]);
  assert.match(formatMq(rows[0]), /^DLV-2 +1524 +P0 EP-1 +batch +clean +-1 +SLOP \? +feat\/b/);   // SLOP ?: no stored check of its tip yet
  // no fast gate declared (kestrel): every non-native row is its own MERGE stage
  assert.deepEqual(mergeQueue({ stateDir: state, project: qProject(f.repo), now: NOW }).rows.map(r => r.gate), ['stage', 'stage', 'door', 'stage']);
  // parked / superseded / merged rows are not queued
  record(state, { kind: 'deliverable', ev: 'park', id: 'DLV-1', by: 'controller', data: { why: 'owner: later' } }, { views: false });
  record(state, { kind: 'deliverable', ev: 'supersede', id: 'DLV-4', by: 'controller', data: { by: 'DLV-2', why: 'same work' } }, { views: false });
  g(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge c', 'feat/c');
  assert.deepEqual(mergeQueue({ stateDir: state, project: qProject(f.repo), now: NOW }).rows.map(r => r.id), ['DLV-2']);
});

// META-CATCH S2: the entry check of a look item's row - a DONE whose end names an image newer than its start, and a pass verdict
// newer than the row's head; nothing else in the queue changes (the other rows keep their order)
test('look item: its row enters the queue only with a proven DONE and a pass verdict newer than the head; held rows are named', () => {
  const f = qRepo(), state = qState(f), d = tmp('look-img'), shot = path.join(d, 'after.png'), sheet = path.join(d, 'sheet.png');
  fs.writeFileSync(shot, 'png'); fs.writeFileSync(sheet, 'png');
  const ct = Number(g(f.repo, 'show', '-s', '--format=%ct', f.tips['feat/a'])) * 1000, start = Date.now() - 3600e3;
  const run = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', worktree: '/x', lane: 'a', brief: '/b/s3.md', stage: 'S3' } }, { now: () => new Date(start), views: false }).id;
  record(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { exit: 0, outcome: 'done', look: fwd(shot) } }, { views: false });
  record(state, { kind: 'deliverable', ev: 'done', id: 'DLV-1', by: 'controller', data: { run, tip: f.tips['feat/a'] } }, { views: false });
  const item = (ev, data, id, by = 'controller', now) => record(state, { kind: 'item', ev, id, by, data }, { views: false, ...(now ? { now: () => new Date(now) } : {}) });
  item('create', { title: 'Theme', kind: 'theme' }); item('create', { title: 'Look', kind: 'item', parent: 'RM-1', links: ['lane:a'] });
  const q = () => mergeQueue({ stateDir: state, project: qProject(f.repo), now: NOW });
  const base = q().rows.map(r => r.id);
  assert.deepEqual([[...base].sort(), q().held], [['DLV-1', 'DLV-2', 'DLV-3', 'DLV-4'], []], 'no look item: every row queued');
  item('edit', { proof: 'look', views: ['front'] }, 'RM-2');
  const old = (start - 60e3) / 1000;
  fs.utimesSync(shot, old, old);
  assert.deepEqual(q().rows.map(r => r.id), base.filter(x => x !== 'DLV-1'), 'an unproven DONE does not enter; the others keep their order');
  assert.match(q().held[0].why, /^RM-2 look: unproven done: RUN-\d+: look image .*after\.png is older than the run's start/);
  fs.utimesSync(shot, Date.now() / 1000, Date.now() / 1000);
  assert.match(q().held[0].why, /^RM-2 look: no look verdict/);
  item('verdict', { verdict: 'pass', image: fwd(sheet) }, 'RM-2', 'owner', ct - 5000);
  assert.match(q().held[0].why, /verdict .* is older than the head of DLV-1/, 'a verdict older than the head is stale');
  item('verdict', { verdict: 'fail', image: fwd(sheet) }, 'RM-2', 'checkin', ct + 60e3);
  assert.match(q().held[0].why, /latest verdict is fail/);
  item('verdict', { verdict: 'pass', image: fwd(sheet) }, 'RM-2', 'controller', ct + 120e3);
  assert.deepEqual([q().rows.map(r => r.id), q().held], [base, []], 'the pass path');
  const pj = path.join(tmp('pj'), 'project.json');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 't', title: 't', root: fwd(f.repo), deliverables: { native: ['**/*.rs'], receipts: [] } }));
  item('verdict', { verdict: 'fail', image: fwd(sheet) }, 'RM-2', 'owner', ct + 180e3);
  assert.match(cli(['mergeq', '--project', pj, '--state', state]).out, /^HELD DLV-1 feat\/a: RM-2 look: the latest verdict is fail/m);
});

test('norn mergeq [--json] lists the queue in score order with the rehearsal word and the gate kind', () => {
  const f = qRepo(), state = qState(f);
  const pj = path.join(tmp('pj'), 'project.json');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 't', title: 't', root: fwd(f.repo), deliverables: { native: ['**/*.rs'], receipts: [] }, merge: { gate: { cmd: 'node -e 0', timeout_min: 5, fast: true }, batch_max: 3 } }));
  const j = cli(['mergeq', '--project', pj, '--state', state, '--json']);
  assert.equal(j.code, 0, j.err);
  const rows = JSON.parse(j.out).rows;
  assert.deepEqual(rows.map(r => r.id), ['DLV-2', 'DLV-1', 'DLV-4', 'DLV-3']);
  assert.ok(rows.every(r => Number.isInteger(r.score) && r.word === 'clean'));
  const t = cli(['mergeq', '--project', pj, '--state', state]);
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, /^batching on \(unpinned in a row: 0\)$/m, 'a fast-gated project names its batching state first');
  assert.match(t.out.split('\n').find(l => l.startsWith('DLV-')), /^DLV-2 +\d+ +P0 EP-1 +batch +clean/);
  assert.match(t.out, /DLV-4 +\d+ +P2 +door +clean/);
  assert.equal(cli(['mergeq', '--project', pj, '--bogus']).code, 2);
});

// ---------- piece 2: auto-update ----------
// a bare origin + the main checkout (a clone) + lane worktrees: feat/a idle, feat/b live-locked, feat/c checked out nowhere,
// feat/d dirty, feat/e conflicting with main, feat/f current; main moved after the branches
const remoteFixture = () => fromTemplate('mq-remote', buildRemote, tmp('remote'));
function buildRemote(root) {
  const origin = path.join(root, 'origin');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GENV });
  const repo = path.join(root, 'co', 'sdd-codex');
  execFileSync('git', ['clone', '-q', origin, repo], { env: GENV, stdio: 'ignore' });
  g(repo, 'config', 'user.name', 't'); g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'commit.gpgsign', 'false');
  g(repo, 'checkout', '-q', '-b', 'main');
  commit(repo, 'README.md', 'r\n', 'init');
  g(repo, 'push', '-q', '-u', 'origin', 'main');
  const wts = {}, tips = {};
  for (const [b, file, text] of [['feat/a', 'docs/a.md', 'a\n'], ['feat/b', 'docs/b.md', 'b\n'], ['feat/c', 'docs/c.md', 'c\n'], ['feat/d', 'docs/d.md', 'd\n'], ['feat/e', 'README.md', 'e\n'], ['feat/f', 'docs/f.md', 'f\n']]) {
    const wt = path.join(path.dirname(repo), 'wt-' + b.slice(5));
    g(repo, 'worktree', 'add', '-q', '-b', b, wt, 'main');
    tips[b] = commit(wt, file, text, `${b} work`);
    g(wt, 'push', '-q', '-u', 'origin', b);
    wts[b] = wt;
  }
  commit(repo, 'README.md', 'm\n', 'main moves README');
  g(repo, 'push', '-q', 'origin', 'main');
  g(wts['feat/f'], 'merge', '-q', '--no-edit', 'main'); g(wts['feat/f'], 'push', '-q', 'origin', 'feat/f');
  tips['feat/f'] = g(wts['feat/f'], 'rev-parse', 'HEAD');
  g(repo, 'worktree', 'remove', wts['feat/c']); delete wts['feat/c'];
  fs.writeFileSync(path.join(wts['feat/d'], 'docs/d.md'), 'half-done edit\n');
  return { origin, repo, wts, tips };
}
function remoteState(f, branches) {
  const state = path.join(tmp('rs'), 'state', 't');
  branches.forEach((b, i) => record(state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo: fwd(f.repo), branch: b, tip: f.tips[b], lane: b.slice(5), delivers: b, done_utc: at(-(10 + i)).toISOString() } }, { now: () => at(-(10 + i)), views: false }));
  return state;
}

test('auto-update: merges main into an idle branch and pushes (a fast-forward, never a force); skips live / dirty / conflicting / current', () => {
  const f = remoteFixture();
  const B = ['feat/a', 'feat/b', 'feat/c', 'feat/d', 'feat/e', 'feat/f'];
  const state = remoteState(f, B), locks = path.join(path.dirname(state), 'locks');
  liveRun(state, locks, { lane: 'b', worktree: f.wts['feat/b'] });
  const project = { name: 't', root: fwd(f.repo), deliverables: { receipts: [] } };
  const cfg = mergeConfig(project);
  const { rows } = mergeQueue({ stateDir: state, project, now: NOW });
  const res = Object.fromEntries(rows.map(r => [r.branch, autoUpdate(r, { cfg, locksDir: locks })]));
  const word = b => `${res[b].action}: ${res[b].why}`;
  assert.match(word('feat/a'), /^updated: merged main [0-9a-f]{7}, pushed/);
  assert.match(word('feat/b'), /^skip: .*held by RUN-1/);
  assert.match(word('feat/c'), /^updated:/, 'checked out nowhere: updated in the scratch worktree');
  assert.ok(fs.existsSync(cfg.scratch) && cfg.scratch.endsWith('sdd-codex-mq'));
  assert.match(word('feat/d'), /^skip: .*uncommitted changes/);
  assert.match(word('feat/e'), /^skip: conflict: README\.md: the resolve path/);
  assert.match(word('feat/f'), /^skip: current with main/);
  const mainSha = g(f.repo, 'rev-parse', 'main');
  for (const b of ['feat/a', 'feat/c']) {
    const now = g(f.origin, 'rev-parse', b);
    assert.equal(now, res[b].sha);
    assert.equal(g(f.origin, 'rev-parse', `${b}^1`), f.tips[b], 'first parent = the old tip: a merge, the push a fast-forward');
    assert.equal(g(f.origin, 'rev-parse', `${b}^2`), mainSha);
  }
  assert.equal(g(f.wts['feat/a'], 'rev-parse', 'HEAD'), res['feat/a'].sha, 'the lane worktree sits at the pushed merge');
  for (const b of ['feat/b', 'feat/d', 'feat/e', 'feat/f']) assert.equal(g(f.origin, 'rev-parse', b), f.tips[b], `${b} untouched`);
  assert.equal(fs.readFileSync(path.join(f.wts['feat/d'], 'docs/d.md'), 'utf8'), 'half-done edit\n');
  assert.ok(!fs.existsSync(lockPath(locks, f.wts['feat/a'])), 'the update released its lock');
  // the merge commit after the update: behind 0 now, the next pass leaves it alone
  const again = mergeQueue({ stateDir: state, project, now: NOW }).rows.find(r => r.branch === 'feat/a');
  assert.equal(again.behind, 0);
  assert.equal(autoUpdate(again, { cfg, locksDir: locks }).action, 'skip');
  // the CLI pass: the remaining rows say why they stay
  const pj = path.join(tmp('pj'), 'project.json');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 't', title: 't', root: fwd(f.repo), deliverables: { receipts: [] } }));
  const c = cli(['mergeq', '--update', '--project', pj, '--state', state, '--locks', locks]);
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /DLV-1 feat\/a update skip: current with main/);
  assert.match(c.out, /DLV-2 feat\/b update skip: .*held by RUN-1/);
});

// ---------- piece 5: the tick ----------
test('the tick starts `norn mergeq --run` right after the fill (detached, one pass per state dir); every project with a file (it lands its work)', async () => {
  const t = tmp('tick');
  const root = path.join(t, 'root'), state = path.join(t, 'state', 'norn');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(state, { recursive: true });
  const p = { name: 'norn', root, state, file: fwd(path.join(t, 'project.json')), ledger: path.join(t, 'L.md'), briefs_dir: t, checkin: { cwd: root }, views: {}, deliverables: { receipts: [] } };
  const calls = [];
  const spawnMergeq = (exe, args) => { calls.push(args); return { pid: 4242 }; };
  tick({ project: p, budget: {}, dry: true, spawnMergeq, reason: 'test' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(1), ['mergeq', '--run', '--project', p.file, '--state', state]);
  assert.match(calls[0][0], /engine.bin.norn.mjs$/);
  assert.match(fs.readFileSync(path.join(state, 'tick.log'), 'utf8'), /mergeq: started pid 4242/);
  // a live pass (its lock names a live pid) -> no second one
  fs.mkdirSync(path.join(state, 'mq'), { recursive: true });
  fs.writeFileSync(path.join(state, 'mq', 'run.lock'), JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  tick({ project: p, budget: {}, dry: true, spawnMergeq, reason: 'test' });
  assert.equal(calls.length, 1);
  assert.match(fs.readFileSync(path.join(state, 'tick.log'), 'utf8'), new RegExp(`mergeq: pass pid ${process.pid} running`));
  const r = await mergeqRun({ stateDir: state, project: p });
  assert.match(r.why, /a mergeq pass is running/);
  fs.unlinkSync(path.join(state, 'mq', 'run.lock'));
  const { deliverables: _d, ...bare } = p;
  tick({ project: bare, budget: {}, dry: true, spawnMergeq, reason: 'test' });
  assert.equal(calls.length, 2, 'no deliverables, no merge: the pass still runs (MERGE-FIRST: mechanical landing; no auto-update there)');
  tick({ project: { ...bare, file: undefined }, budget: {}, dry: true, spawnMergeq, reason: 'test' });
  assert.equal(calls.length, 2, 'no project file: no pass');
});

test('auto-update leaves native code to the door: no update of a native branch, nor one that would pull main native changes into a lane worktree', () => {
  const f = remoteFixture();
  const state = remoteState(f, ['feat/a']), locks = path.join(path.dirname(state), 'locks');
  const project = { name: 't', root: fwd(f.repo), deliverables: { receipts: [], native: ['README.md'] } };   // main moved README.md
  const [row] = mergeQueue({ stateDir: state, project, now: NOW }).rows;
  const r = autoUpdate(row, { cfg: mergeConfig(project), locksDir: locks });
  assert.equal(r.action, 'skip'); assert.match(r.why, /main brings native changes \(README\.md\): the update is door work/);
  assert.equal(g(f.origin, 'rev-parse', 'feat/a'), f.tips['feat/a']);
  const q = qRepo(), qs = qState(q);
  const n = mergeQueue({ stateDir: qs, project: qProject(q.repo), now: NOW }).rows.find(x => x.id === 'DLV-4');
  assert.match(autoUpdate(n, { cfg: mergeConfig(qProject(q.repo)), locksDir: path.join(qs, 'locks') }).why, /native-touching \(crates\/x\/lib\.rs\): its update is door work/);
});

