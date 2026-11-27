// GAP-6 + RM-7: merges no longer queue behind each other on the owner's checkout. Each MERGE run works in its own merge worktree
// (<state>/mq/merge-<lane>-<sha7>), up to policy.merge.parallel at once, and ends with `norn merge-land` (mergeland.mjs): the PR of
// each lane branch to main, opened (or found open) with gh and recorded on the branch's deliverable. Norn never pushes main.
// Real temp git repos (a bare origin + its clone), a fake gh (no network), the FAKE executor for the run tests; temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startRun, readiness, writeTrees, lockPath, mergeSpec, slotsFull, mergeWtInUse } from '../engine/lib/runs.mjs';
import { pathKey } from '../engine/lib/config.mjs';
import { renderMergeBrief, briefMarker } from '../engine/lib/mergebrief.mjs';
import { mergeWtPath, ensureMergeWorktree, slotKey, mergeParallel } from '../engine/lib/mergewt.mjs';
import { openPrs, openProjectPrs, prLine, ghSlug } from '../engine/lib/mergeland.mjs';
import { makeGit } from '../engine/lib/dlvgit.mjs';
import { waitWords } from '../engine/lib/waitwords.mjs';
import { record, loadState } from '../engine/lib/records.mjs';
import { loadDeliverables } from '../engine/lib/deliverables.mjs';
import { main as nornMain } from '../engine/bin/norn.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { fromTemplate } from './helpers/git-template.mjs';
import { waitForSync, supervisorAlive } from './helpers/wait.mjs';
import { settled } from './helpers/settled.mjs';

test.after(cleanTmp);
const tmp = p => mkTmp('meta-mwt-' + p + '-');
const fwd = p => String(p).replace(/\\/g, '/');
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg);
  return g(repo, 'rev-parse', 'HEAD');
};

// origin (bare) + co/repo (the owner's main checkout, on main): base.txt, feat/a (a.txt), feat/b (b.txt), feat/c (base.txt changed)
function buildRepo(root) {
  const origin = path.join(root, 'origin');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GENV });
  const repo = path.join(root, 'co', 'repo');
  execFileSync('git', ['clone', '-q', origin, repo], { env: GENV, stdio: 'ignore' });
  g(repo, 'config', 'user.name', 't'); g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'commit.gpgsign', 'false');
  g(repo, 'config', 'core.autocrlf', 'false');   // the tests' git (no system config) and Norn's (the machine's) must see one tree
  g(repo, 'checkout', '-q', '-b', 'main');
  commit(repo, 'base.txt', 'base\n', 'base');
  g(repo, 'push', '-q', '-u', 'origin', 'main');
  const tips = {};
  for (const [b, file, text] of [['feat/a', 'a.txt', 'a\n'], ['feat/b', 'b.txt', 'b\n'], ['feat/c', 'base.txt', 'c changes base\n']]) {
    g(repo, 'checkout', '-q', '-b', b, 'main');
    tips[b] = commit(repo, file, text, `${b} work`);
    g(repo, 'push', '-q', 'origin', b);
  }
  g(repo, 'checkout', '-q', 'main');
  return { origin, repo, tips };
}
const fixture = () => fromTemplate('mwt-repo', buildRepo, tmp('repo'));
const ORIGIN_MAIN = f => g(f.origin, 'rev-parse', 'main');
// a merge worktree with branches bs merged into main (what the worker's steps 1-5 make)
function merged(f, wt, ...bs) {
  ensureMergeWorktree({ repo: f.repo, wt });
  for (const b of bs) g(wt, 'merge', '-q', '--no-ff', '-m', `merge: ${b}`, `origin/${b}`);
  return g(wt, 'rev-parse', 'HEAD');
}
// the real git, except the origin's URL reads as a GitHub repo (the fixture's origin is a bare folder: fetches still go there)
const ghGit = () => makeGit((repo, args, env, input) => (args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/o/r.git\n'
  : execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }), env: { ...GENV, ...(env || {}) } })));
// a fake gh: open PRs by head branch; `pr list` finds them, `pr create` adds one (fail: create exits 1)
function fakeGh({ fail = false } = {}) {
  const prs = new Map(), calls = [];
  let n = 40;
  const gh = args => {
    calls.push(args);
    const opt = k => args[args.indexOf(k) + 1];
    if (args[0] === 'pr' && args[1] === 'list') return { code: 0, out: JSON.stringify(prs.has(opt('--head')) ? [prs.get(opt('--head'))] : []), err: '' };
    if (args[0] === 'pr' && args[1] === 'create') {
      if (fail) return { code: 1, out: '', err: 'GraphQL: no permission' };
      const pr = { url: `https://github.com/${opt('--repo')}/pull/${++n}`, number: n };
      prs.set(opt('--head'), pr);
      return { code: 0, out: `Creating pull request\n${pr.url}\n`, err: '' };
    }
    return { code: 1, out: '', err: 'unexpected gh call' };
  };
  return { gh, prs, calls, creates: () => calls.filter(c => c[1] === 'create') };
}
const stateOf = f => { const s = path.join(path.dirname(f.repo), 'st'); fs.mkdirSync(s, { recursive: true }); return s; };
const mkDlv = (state, f, branch, delivers) => record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: fwd(f.repo), branch, lane: branch.slice(5), delivers } }, { views: false }).id;

test('merge-land opens one PR per lane branch of the tested merge, records it on the deliverable, and never touches main; a second land reuses the open PR', () => {
  const f = fixture(), wt = path.join(path.dirname(f.repo), 'mq', 'merge-ab'), state = stateOf(f);
  const head = merged(f, wt, 'feat/a', 'feat/b');
  const da = mkDlv(state, f, 'feat/a', 'feat(a): the a file');
  const mainBefore = ORIGIN_MAIN(f), localBefore = g(f.repo, 'rev-parse', 'main');
  const fg = fakeGh();
  const rs = openPrs({ repo: f.repo, wt, branches: ['feat/a', 'feat/b'], stateDir: state, run: 'RUN-7', git: ghGit(), gh: fg.gh });
  assert.deepEqual(rs.map(r => [r.branch, r.status, r.number]), [['feat/a', 'opened', 41], ['feat/b', 'opened', 42]], JSON.stringify(rs));
  const [ca, cb] = fg.creates();
  for (const [k, v] of [['--repo', 'o/r'], ['--base', 'main'], ['--head', 'feat/a'], ['--title', 'feat(a): the a file']]) assert.equal(ca[ca.indexOf(k) + 1], v, k);
  assert.equal(cb[cb.indexOf('--title') + 1], 'feat/b', 'no deliverable: the branch is the title');
  assert.match(prLine(rs[0]), /^PR OPENED https:\/\/github\.com\/o\/r\/pull\/41: feat\/a -> o\/r main \(recorded on DLV-1\)$/);
  const ev = loadDeliverables(state)[da].history.filter(h => h.ev === 'pr');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].data, { url: 'https://github.com/o/r/pull/41', number: 41, repo: 'o/r', head: 'feat/a', base: 'main', merge: head, run: 'RUN-7' });
  assert.equal(ORIGIN_MAIN(f), mainBefore, 'origin main untouched');
  assert.equal(g(f.repo, 'rev-parse', 'main'), localBefore, 'the local main untouched');
  // again (a resumed MERGE run): the open PRs are found, none created, nothing recorded twice
  const again = openPrs({ repo: f.repo, wt, branches: ['feat/a', 'feat/b'], stateDir: state, git: ghGit(), gh: fg.gh });
  assert.deepEqual(again.map(r => r.status), ['open', 'open']);
  assert.match(prLine(again[0]), /^PR ALREADY OPEN https:\/\/github\.com\/o\/r\/pull\/41: /);
  assert.equal(fg.creates().length, 2);
  assert.equal(loadDeliverables(state)[da].history.filter(h => h.ev === 'pr').length, 1);
});

test('merge-land refuses a branch it cannot stand behind: not pushed, not in the tested merge, a dirty or mid-merge worktree, no GitHub remote, gh failing', () => {
  const f = fixture(), wt = path.join(path.dirname(f.repo), 'mq', 'merge-a');
  merged(f, wt, 'feat/a');
  const fg = fakeGh(), run = (branches, o = {}) => openPrs({ repo: f.repo, wt, branches, git: ghGit(), gh: fg.gh, ...o });
  assert.match(run(['feat/none'])[0].why, /feat\/none is not on origin: push the lane branch first/);
  assert.match(run(['feat/b'])[0].why, /the tested merge [0-9a-f]{7} holds none of feat\/b's commits past main/);
  assert.match(run([])[0].why, /no lane branch named/);
  assert.match(run(['feat/a'], { git: makeGit() })[0].why, /the origin remote of .* is no GitHub repo/);
  assert.match(run(['feat/a'], { gh: fakeGh({ fail: true }).gh })[0].why, /gh pr create failed: GraphQL: no permission/);
  fs.writeFileSync(path.join(wt, 'base.txt'), 'dirty\n');
  assert.match(run(['feat/a'])[0].why, /has uncommitted changes/);
  assert.equal(fg.creates().length, 0, 'no refusal opened a PR');
  // the lane branch moved on after the tested merge: a lane commit the merge never tested is refused, and the words say which
  g(wt, 'checkout', '--', 'base.txt');
  g(f.repo, 'checkout', '-q', 'feat/a'); const a2 = commit(f.repo, 'a2.txt', 'a2\n', 'feat/a more'); g(f.repo, 'push', '-q', 'origin', 'feat/a'); g(f.repo, 'checkout', '-q', 'main');
  const r = run(['feat/a'])[0];
  assert.equal(r.status, 'refused');
  assert.equal(r.why, `feat/a has 1 commit(s) the tested merge ${g(wt, 'rev-parse', 'HEAD').slice(0, 7)} does not hold (${a2.slice(0, 7)}): test them in a new MERGE run`);
  assert.equal(fg.creates().length, 0);
  assert.match(prLine({ branch: 'feat/x', status: 'refused', why: 'w' }), /^NOT OPENED feat\/x: w$/);
  assert.deepEqual(['https://github.com/o/r.git', 'git@github.com:o/r.git', 'https://github.com/o/r/', '/srv/git/r.git'].map(ghSlug), ['o/r', 'o/r', 'o/r', null]);
});

// solve-shack RUN-128: the MERGE stage tested its merge; during its suite the merge queue merged main into the lane branch and pushed;
// merge-land then judged the moved tip (a merge base on main) and said the tested merge held none of the branch's commits - false
test('merge-land after the merge queue moved the branch (main into branch): the tested merge still holds every lane commit -> the PR opens', () => {
  const f = fixture(), wt = path.join(path.dirname(f.repo), 'mq', 'merge-a');
  g(f.repo, 'checkout', '-q', 'feat/a'); commit(f.repo, 'a1.txt', 'a1\n', 'feat/a second'); g(f.repo, 'push', '-q', 'origin', 'feat/a'); g(f.repo, 'checkout', '-q', 'main');
  commit(f.repo, 'm1.txt', 'm1\n', 'main moves'); g(f.repo, 'push', '-q', 'origin', 'main');
  const head = merged(f, wt, 'feat/a');   // the tested merge: main + feat/a as of now
  commit(f.repo, 'm2.txt', 'm2\n', 'main moves again'); g(f.repo, 'push', '-q', 'origin', 'main');
  // the mergeq update: main into the lane branch, first parent the lane tip (mergeq.mjs autoUpdate), pushed
  const up = path.join(path.dirname(f.repo), 'upd');
  g(f.repo, 'worktree', 'add', '-q', '--detach', up, 'origin/feat/a');
  g(up, 'merge', '-q', '--no-ff', '-m', 'merge: main into feat/a (mergeq update DLV-12)', 'main'); g(up, 'push', '-q', 'origin', 'HEAD:refs/heads/feat/a');
  const fg = fakeGh(), r = openPrs({ repo: f.repo, wt, branches: ['feat/a'], git: ghGit(), gh: fg.gh })[0];
  assert.equal(r.status, 'opened', r.why);
  assert.equal(g(wt, 'rev-parse', 'HEAD'), head);
  assert.match(r.why, /^feat\/a -> o\/r main; the branch is past the tested merge by main updates only/);
});

test('norn merge-land: one line per branch, exit 3 when a branch has no PR, 2 without --branch; the project settings are used', () => {
  const f = fixture(), wt = path.join(path.dirname(f.repo), 'mq', 'merge-a');
  merged(f, wt, 'feat/a');
  const pf = path.join(path.dirname(f.repo), 'project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'mwt', title: 'm', root: fwd(f.repo), ledger: '${root}/L.md', briefs_dir: '${root}', policy: {} }));
  const cli = argv => { const out = [], err = []; const code = nornMain(['merge-land', ...argv], { META_ROOT: fwd(path.dirname(f.repo)) }, s => out.push(s), s => err.push(s)); return { code, out: out.join('\n'), err: err.join('\n') }; };
  const r = cli(['--project', pf, '--worktree', wt, '--branch', 'feat/a']);   // the fixture's origin is a folder: no GitHub repo, no PR
  assert.equal(r.code, 3, r.out + r.err);
  assert.match(r.out, /^NOT OPENED feat\/a: the origin remote of .* is no GitHub repo/);
  const u = cli(['--project', pf, '--worktree', wt]);
  assert.equal(u.code, 2);
  assert.match(u.err, /--project, --worktree and --branch are required/);
  // openProjectPrs: base and remote from project deliverables
  // a state folder: the merge-land door stores its slop check of the branch head there (RM-44 D1)
  const fg = fakeGh(), P = { name: 'mwt', root: fwd(f.repo), state: fwd(path.join(path.dirname(f.repo), 'state', 'mwt')), deliverables: { main: 'main' }, policy: {} };
  const rs = openProjectPrs(P, { wt, branches: ['feat/a'], git: ghGit(), gh: fg.gh });
  assert.equal(rs[0].status, 'opened', JSON.stringify(rs));
  assert.equal(fg.creates()[0][fg.creates()[0].indexOf('--base') + 1], 'main');
});

// ---------- the runs: the merge worktree, the slots, the cleanup (FAKE executor) ----------
function runBox() {
  const f = fixture(), t = path.dirname(f.repo);
  const d = { f, t, state: path.join(t, 'state', 'mwt'), locks: path.join(t, 'state', 'locks') };
  fs.mkdirSync(d.state, { recursive: true });
  d.P = { name: 'mwt', root: fwd(f.repo), state: fwd(d.state), meta: '/m', deliverables: { main: 'main' }, policy: {} };
  d.brief = (lane, sha, until, mode = 'done') => {
    const b = path.join(t, `merge-${lane}.md`);
    fs.writeFileSync(b, renderMergeBrief(d.P, { lane, branch: `feat/${lane}`, worktree: fwd(path.join(t, 'wt-' + lane)), notes: fwd(path.join(t, `${lane}-NOTES.md`)), sha }) + `mode: ${mode}\nuntil: ${fwd(until)}\n`);
    return b;
  };
  // --worktree names the lane worktree as the check-in's run line does (lane_defaults): the brief's merge worktree wins
  d.opts = (lane, brief, o = {}) => ({ state: d.state, locksDir: d.locks, executor: 'fake', lane, worktree: path.join(t, 'wt-' + lane), brief, stage: 'MERGE', notes: path.join(t, `${lane}-NOTES.md`),
    tick: null, hbMs: 150, staleMs: 3000, policy: { auto_resume_max: 0 }, budget: {}, ...o });
  d.item = id => loadState(d.state).items[id];
  d.filled = qid => Object.values(loadState(d.state).items).find(x => x.kind === 'run' && x.data.from_queue === qid) || null;
  d.ends = id => waitForSync(() => settled(d.item(id)), { producer: supervisorAlive(d.state, () => d.item(id)), what: `${id} ends` });
  return d;
}

test('the brief: a merge names its merge worktree and merge-land, never the owner checkout; policy.merge.parallel 1-16', () => {
  const d = runBox(), sha = d.f.tips['feat/a'];
  const text = renderMergeBrief(d.P, { lane: 'a', branch: 'feat/a', worktree: '/w/a', notes: '/n/a.md', sha });
  const m = briefMarker(text), wt = mergeWtPath(d.state, 'a', sha);
  assert.equal(m.merge_wt, wt);
  assert.match(wt, /\/mq\/merge-a-[0-9a-f]{7}$/);
  assert.equal(m.main, undefined, 'no main checkout lock');
  assert.equal(m.slots, 2);
  assert.ok(text.includes(`git -C ${wt} merge --no-ff --no-commit ${sha}`));
  assert.ok(text.includes(`merge-land --project <project.json> --worktree ${wt} --branch feat/a`), 'merge-land opens the PR of the lane branch');
  assert.ok(!/revert|push origin main|push .*HEAD:main/.test(text), 'the brief never lands, pushes or reverts main');
  assert.ok(!text.includes(`git -C ${fwd(d.f.repo)} merge`), 'never merges in the owner checkout');
  const rb = renderMergeBrief(d.P, { lane: 'a', branch: 'feat/a', worktree: '/w/a', notes: '/n/a.md' });
  assert.equal(briefMarker(rb).mode, 'rebase');
  assert.ok(rb.includes(`git -C ${mergeWtPath(d.state, 'a')} merge --no-ff`));
  assert.equal(briefMarker(renderMergeBrief({ ...d.P, policy: { merge: { parallel: 3 } } }, { lane: 'a', branch: 'feat/a', worktree: '/w/a', notes: '/n/a.md', sha })).slots, 3);
  for (const bad of [0, -1, 17, 1.5]) assert.throws(() => mergeParallel({ policy: { merge: { parallel: bad } } }), /policy\.merge\.parallel must be a whole number 1-16/);
  assert.throws(() => renderMergeBrief({ ...d.P, state: undefined }, { lane: 'a', branch: 'feat/a', worktree: '/w/a', notes: '/n/a.md', sha }), /no state dir/);
  // writeTrees: the merge worktree only (mergeSpec makes it the run's); a rebase brief also the lane worktree
  const b = d.brief('a', sha, '/never');
  assert.deepEqual(writeTrees(mergeSpec(d.opts('a', b))).map(fwd), [wt]);
  const rbf = path.join(d.t, 'rb.md'); fs.writeFileSync(rbf, rb);
  assert.deepEqual(writeTrees(mergeSpec(d.opts('a', rbf))).map(fwd), [mergeWtPath(d.state, 'a'), '/w/a']);
  assert.equal(waitWords('merge slots full: 2 merge(s) running in /r (RUN-1, RUN-2; policy.merge.parallel 2)').text, 'waits for a merge slot (2 merges running)');
});

test('MERGE runs: two start at once (policy.merge.parallel 2) in their own merge worktrees, the third waits for a slot; ends remove the worktrees; the owner checkout is never locked', () => {
  const d = runBox(), go = l => path.join(d.t, 'go-' + l);
  const shaA = d.f.tips['feat/a'], shaB = d.f.tips['feat/b'], shaC = d.f.tips['feat/c'];
  // a leftover of a crashed merge: swept by the next merge start
  const left = mergeWtPath(d.state, 'old', 'abcdef1');
  ensureMergeWorktree({ repo: d.f.repo, wt: left });
  const a = startRun(d.opts('a', d.brief('a', shaA, go('a'))));
  assert.equal(fs.existsSync(left), false, 'the leftover merge worktree was swept');
  const b = startRun(d.opts('b', d.brief('b', shaB, go('b'), 'stopped')));
  const wtA = mergeWtPath(d.state, 'a', shaA), wtB = mergeWtPath(d.state, 'b', shaB);
  assert.equal(fwd(d.item(a.run).data.worktree), wtA);
  assert.ok(fs.existsSync(path.join(wtA, 'base.txt')) && fs.existsSync(path.join(wtB, 'base.txt')), 'both merge worktrees exist, checked out at main');
  assert.equal(g(wtA, 'rev-parse', 'HEAD'), g(d.f.repo, 'rev-parse', 'origin/main'));
  assert.equal(fs.existsSync(lockPath(d.locks, d.f.repo)), false, 'no MERGE run holds the owner checkout');
  assert.ok(fs.existsSync(lockPath(d.locks, slotKey(fwd(d.f.repo), 0))) && fs.existsSync(lockPath(d.locks, slotKey(fwd(d.f.repo), 1))));
  // the third: refused without --queue (exit 3), queued with it, waiting on the slots
  const cb = d.brief('c', shaC, go('c'));
  assert.throws(() => startRun(d.opts('c', cb)), e => e.code === 3 && /merge slots full: 2 merge/.test(e.message));
  assert.equal(fs.existsSync(mergeWtPath(d.state, 'c', shaC)), false, 'a refused start makes no worktree');
  const q = startRun(d.opts('c', cb, { queue: true }));
  assert.ok(q.queued);
  assert.match(q.why, /merge slots full/);
  const row = readiness(d.state, { resources: () => ({ free_gb: 64, cpu_pct: 1 }) }).find(r => r.id === q.run);
  assert.ok(row.terms.some(x => /^merge slots full: 2 merge\(s\) running .*RUN-\d+, RUN-\d+/.test(x)), row.terms.join('; '));
  // b ends STOPPED (its merge conflicted, say): its worktree goes, main untouched, and its exit's fill starts c
  const mainBefore = ORIGIN_MAIN(d.f);
  fs.writeFileSync(go('b'), 'go');
  d.ends(b.run);
  assert.equal(d.item(b.run).end.outcome, 'stopped');
  assert.equal(fs.existsSync(wtB), false, `a STOPPED merge removes its worktree; log: ${fs.readFileSync(d.item(b.run).data.log, 'utf8').slice(-1500)}`);
  assert.equal(ORIGIN_MAIN(d.f), mainBefore);
  const c = d.filled(q.run);
  assert.ok(c, 'the freed slot started the waiting merge');
  assert.ok(fs.existsSync(mergeWtPath(d.state, 'c', shaC)));
  for (const l of ['a', 'c']) fs.writeFileSync(go(l), 'go');
  d.ends(a.run); d.ends(c.id);
  assert.equal(fs.existsSync(wtA), false, 'a DONE merge removes its worktree');
  assert.equal(fs.existsSync(mergeWtPath(d.state, 'c', shaC)), false);
  assert.equal(slotsFull(mergeSpec(d.opts('c', cb)), 3000), null, 'every slot is free again');
  assert.equal(g(d.f.repo, 'worktree', 'list').split('\n').length, 1, 'git knows no merge worktree any more');
});

// MAIL-10 (solve-shack RUN-134): a check-in relaunched a merge as stage MERGE2. Only MERGE is a merge stage, so mergeSpec skipped the
// brief's merge worktree: the run started in the lane worktree, its merge worktree was never made, and no sweep knew it was in use
test('a merge brief starts only as stage MERGE (MERGE2 is refused, no record, no worktree); a MERGE brief that names no merge worktree is refused', () => {
  const d = runBox(), sha = d.f.tips['feat/a'], b = d.brief('a', sha, path.join(d.t, 'go-a'));
  for (const stage of ['MERGE2', 'S1', undefined]) {
    assert.throws(() => startRun(d.opts('a', b, { stage })), e => e.code === 2 && /is a merge brief .*start it as --stage MERGE/.test(e.message), String(stage));
    assert.throws(() => startRun(d.opts('a', b, { stage, queue: true })), e => e.code === 2, `${stage} queued`);
  }
  assert.equal(Object.values(loadState(d.state).items).filter(x => x.kind === 'run').length, 0, 'no run recorded');
  assert.equal(fs.existsSync(mergeWtPath(d.state, 'a', sha)), false, 'no merge worktree made');
  // a meta-merge marker without merge_wt (written before GAP-6, or by hand): refused, never run in the lane worktree
  const old = path.join(d.t, 'old.md');
  fs.writeFileSync(old, fs.readFileSync(b, 'utf8').replace(/"merge_wt":"[^"]*",/, ''));
  assert.equal(briefMarker(fs.readFileSync(old, 'utf8')).merge_wt, undefined);
  assert.throws(() => startRun(d.opts('a', old)), e => e.code === 2 && /names no merge worktree/.test(e.message));
  // a hand-written brief (no marker) still runs under any stage: it is no merge brief
  const plain = path.join(d.t, 'plain.md'); fs.writeFileSync(plain, '# task\nmode: done\n');
  assert.deepEqual(mergeSpec(d.opts('a', plain, { stage: 'MERGE2' })).worktree, path.join(d.t, 'wt-a'));
});

test('a merge start never sweeps a merge worktree a live run works in: one its brief names (whatever the run recorded), or a lost run (it may only be stalled)', () => {
  const d = runBox(), shaA = d.f.tips['feat/a'], shaB = d.f.tips['feat/b'], shaC = d.f.tips['feat/c'];
  const wtA = mergeWtPath(d.state, 'a', shaA), wtC = mergeWtPath(d.state, 'c', shaC);
  // RUN-134's shape: a running run whose record names the lane worktree, its brief the merge worktree it made by hand
  ensureMergeWorktree({ repo: d.f.repo, wt: wtA });
  record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'a', stage: 'MERGE', worktree: fwd(path.join(d.t, 'wt-a')), brief: d.brief('a', shaA, '/never') } });
  // a lost MERGE run: its heartbeat went stale, its executor may still be running the suite
  ensureMergeWorktree({ repo: d.f.repo, wt: wtC });
  const c = record(d.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'c', stage: 'MERGE', worktree: wtC, brief: d.brief('c', shaC, '/never') } }).id;
  record(d.state, { kind: 'run', ev: 'lost', id: c, by: 'status', data: { why: 'heartbeat 900 s old', cause: 'stale' } });
  const keep = mergeWtInUse(d.state);
  assert.ok(keep.has(pathKey(wtA)) && keep.has(pathKey(wtC)), [...keep].join(', '));
  // another lane's merge starts: it sweeps, and both stay
  const go = path.join(d.t, 'go-b'), b = startRun(d.opts('b', d.brief('b', shaB, go)));
  assert.ok(fs.existsSync(path.join(wtA, 'base.txt')), 'the merge worktree a live run works in was kept');
  assert.ok(fs.existsSync(path.join(wtC, 'base.txt')), 'a lost run\'s merge worktree was kept');
  fs.writeFileSync(go, 'go'); d.ends(b.run);
});
