// META-DELIVERABLES (norn-projects norn/design/DELIVERABLES-SPEC.md): a deliverable's state DONE -> MERGED -> INSTALLED is derived from git and
// the install receipts, never typed. Fixture git repos in temp dirs only; no live state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record, loadState, RecordError } from '../engine/lib/records.mjs';
import { scanRepo, globToRe, makeGit } from '../engine/lib/dlvgit.mjs';
import { deliverablesView, loadDeliverables, lastInstall, deliverableConfig, formatDeliverable, latchMerged } from '../engine/lib/deliverables.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { fromTemplate } from './helpers/git-template.mjs';

// every temp dir is <mkdtemp>/state/<x> (helpers/tmp.mjs): runs.liveRuns() scans the siblings of a state dir for runs.jsonl
const tmp = p => mkTmp('meta-dlv-' + p + '-');
test.after(cleanTmp);
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
export const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const commit = (repo, file, text, msg) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg);
  return g(repo, 'rev-parse', 'HEAD');
};
// main + feat/a (touches a .rs file) + fix/b (docs only); both "pushed" (refs/remotes/origin/*)
// (DEC-85) built once per process (helpers/git-template.mjs), each test gets its own copy: same tree, same SHAs
export const fixture = () => fromTemplate('dlv-fixture', buildFixture, tmp('repo'));
function buildFixture(repo) {
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'README.md', 'r\n', 'init');
  g(repo, 'checkout', '-q', '-b', 'feat/a');
  const a = commit(repo, 'crates/x/src/lib.rs', 'fn a() {}\n', 'feat(a): native a');
  g(repo, 'checkout', '-q', 'main');
  g(repo, 'checkout', '-q', '-b', 'fix/b');
  const b = commit(repo, 'docs/b.md', 'b\n', 'fix(b): docs b');
  g(repo, 'checkout', '-q', 'main');
  g(repo, 'update-ref', 'refs/remotes/origin/feat/a', a);
  g(repo, 'update-ref', 'refs/remotes/origin/fix/b', b);
  return { repo, a, b };
}
const NOW = Date.parse('2026-11-08T12:00:00Z');
const at = h => new Date(NOW + h * 3600e3);
export function project(repo, doors, extra = {}) {
  return { name: 't', root: repo, state: null, lane_defaults: {}, deliverables: {
    native: ['**/*.rs', '**/Cargo.*', 'engine/prism/**'], receipts: [path.join(doors, '*', 'installed.json').replace(/\\/g, '/')],
    receipt_keys: ['main_merge', 'source_head'], ...extra } };
}
export const mkDlv = (state, data, h = -48) => record(state, { kind: 'deliverable', ev: 'create', by: 'controller', data }, { now: () => at(h), views: false });

test('state machine: DONE -> MERGED -> INSTALLED, derived from git + the newest install receipt', () => {
  const { repo, a } = fixture();
  const doors = tmp('doors'), state = tmp('state');
  const p = { ...project(repo, doors), state };
  mkDlv(state, { repo, branch: 'feat/a', target: 'install', delivers: 'native a', done_utc: at(-48).toISOString(), tip: a, lane: 'a' });
  const v0 = deliverablesView({ stateDir: state, project: p, now: NOW });
  assert.equal(v0.rows.length, 1);
  const r0 = v0.rows[0];
  assert.equal(r0.id, 'DLV-1');
  assert.equal(r0.state, 'done');
  assert.equal(r0.behind, 0); assert.equal(r0.ahead, 1);
  assert.equal(r0.native, true); assert.deepEqual(r0.native_files, ['crates/x/src/lib.rs']);
  assert.equal(r0.days, 2);
  // main moves on: commits behind main counts it
  commit(repo, 'm1.txt', '1', 'main 1'); commit(repo, 'm2.txt', '2', 'main 2');
  assert.equal(deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0].behind, 2);
  // merged into main
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'feat/a');
  const r1 = deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0];
  assert.equal(r1.state, 'merged');
  // an OLDER receipt that predates the merge does not install it; the NEWEST one does
  fs.mkdirSync(path.join(doors, 'd1')); fs.writeFileSync(path.join(doors, 'd1', 'installed.json'), JSON.stringify({ main_merge: g(repo, 'rev-parse', '--short', 'main~1') }));
  fs.utimesSync(path.join(doors, 'd1', 'installed.json'), new Date(NOW - 7200e3), new Date(NOW - 7200e3));
  assert.equal(deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0].state, 'merged');
  fs.mkdirSync(path.join(doors, 'd2')); fs.writeFileSync(path.join(doors, 'd2', 'installed.json'), JSON.stringify({ scope: 'x', source_head: g(repo, 'rev-parse', 'main') }));
  const inst = lastInstall(deliverableConfig(p));
  assert.equal(path.basename(path.dirname(inst.file)), 'd2');
  const v2 = deliverablesView({ stateDir: state, project: p, now: NOW });
  assert.equal(v2.rows[0].state, 'installed');
  assert.equal(v2.rows[0].at_target, true);
});

test('target main: a deliverable on another repo is done once MERGED (no install receipt applies)', () => {
  const { repo, a } = fixture();
  const other = fixture();
  const state = tmp('state'), p = { ...project(repo, tmp('doors')), state };
  mkDlv(state, { repo: other.repo, branch: 'fix/b', delivers: 'docs b', done_utc: at(-30).toISOString() });
  const r = deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0];
  assert.equal(r.target, 'main'); assert.equal(r.state, 'done'); assert.equal(r.native, null, 'native globs are the project repo\'s');
  g(other.repo, 'merge', '-q', '--no-ff', '-m', 'merge b', 'fix/b');
  const r2 = deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0];
  assert.equal(r2.state, 'merged'); assert.equal(r2.at_target, true);
  void a;
});

test('the PR norn merge-land opened shows on its row and listing line; the newest pr event wins', () => {
  const { repo } = fixture();
  const state = tmp('state'), p = { ...project(repo, tmp('doors')), state };
  const id = mkDlv(state, { repo, branch: 'fix/b', delivers: 'docs b', done_utc: at(-30).toISOString() }).id;
  const row = () => deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0];
  assert.equal(row().pr, null);
  assert.doesNotMatch(formatDeliverable(row()), /PR #/);
  for (const n of [4, 7]) record(state, { kind: 'deliverable', ev: 'pr', id, by: 'launcher', data: { url: `https://github.com/o/r/pull/${n}`, number: n, repo: 'o/r', head: 'fix/b', base: 'main' } }, { now: () => at(-1), views: false });
  assert.deepEqual(row().pr, { url: 'https://github.com/o/r/pull/7', number: 7 });
  assert.match(formatDeliverable(row()), /fix\/b +PR #7 \| DUE \| clean \| docs b$/);
});

test('lane-outputs item 6: every PR of a deliverable, newest first, with the GitHub state and merge date (the tick asks, the view reads); a closed PR is never asked again', () => {
  const { repo } = fixture();
  const state = tmp('state'), p = { ...project(repo, tmp('doors')), state };
  const id = mkDlv(state, { repo, branch: 'fix/b', delivers: 'docs b', done_utc: at(-30).toISOString() }).id;
  for (const n of [4, 7]) record(state, { kind: 'deliverable', ev: 'pr', id, by: 'launcher', data: { url: `https://github.com/o/r/pull/${n}`, number: n, repo: 'o/r', head: 'fix/b', base: 'main' } }, { now: () => at(-1), views: false });
  const prs = () => deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0].prs.map(x => [x.number, x.state, x.merged_at]);
  assert.deepEqual(prs(), [[7, 'open', null], [4, 'open', null]], 'no GitHub answer: open');
  const asked = [], ans = { 'https://github.com/o/r/pull/4': { state: 'CLOSED', closedAt: '2026-11-02T00:00:00Z' }, 'https://github.com/o/r/pull/7': { state: 'OPEN', reviewDecision: 'APPROVED' } };
  const gh = args => { asked.push(args[2]); return { code: 0, out: JSON.stringify(ans[args[2]]) }; };
  latchMerged(state, { project: p, gh, nowMs: NOW });
  assert.deepEqual(asked.sort(), ['https://github.com/o/r/pull/4', 'https://github.com/o/r/pull/7'], 'every PR of the deliverable is asked, not only the last');
  assert.deepEqual(prs(), [[7, 'approved', null], [4, 'closed', null]]);
  ans['https://github.com/o/r/pull/7'] = { state: 'MERGED', mergedAt: at(-0.5).toISOString() };
  asked.length = 0; latchMerged(state, { project: p, gh, nowMs: NOW + 60e3 });
  assert.deepEqual(asked, [], 'an open PR is asked again only after 10 min; a closed one never');
  latchMerged(state, { project: p, gh, nowMs: NOW + 11 * 60e3 });
  assert.deepEqual(asked, ['https://github.com/o/r/pull/7']);
  assert.deepEqual(prs(), [[7, 'merged', at(-0.5).toISOString()], [4, 'closed', null]]);
});

test('a deliverable whose branch is gone falls back to its recorded tip (not on main: cannot tell, never plain done)', () => {
  const { repo, a } = fixture();
  const state = tmp('state'), p = { ...project(repo, tmp('doors')), state };
  mkDlv(state, { repo, branch: 'feat/gone', tip: a, delivers: 'x', done_utc: at(-30).toISOString() });
  const r0 = deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0];
  assert.equal(r0.state, 'unknown'); assert.match(r0.unknown_why, /the branch feat\/gone is deleted/);
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'feat/a');
  assert.equal(deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0].state, 'merged');
});

test('history: after main restarts on a new root, a branch merged on the EARLIER line is merged once deliverables.history names it', () => {
  const { repo, a, b } = fixture();
  const state = tmp('state');
  mkDlv(state, { repo, branch: 'feat/a', tip: a, delivers: 'native a', done_utc: at(-30).toISOString() });
  mkDlv(state, { repo, branch: 'fix/b', tip: b, delivers: 'docs b', done_utc: at(-30).toISOString() });
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'feat/a');
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge b', 'fix/b');
  g(repo, 'tag', 'old-main');
  // fix/b landed, then main was merged INTO it (a merge-queue update): its tip is no ancestor of the old line, its work is on it
  g(repo, 'checkout', '-q', 'fix/b'); g(repo, 'merge', '-q', '--no-ff', '-m', 'merge: main into fix/b', 'main');
  g(repo, 'update-ref', 'refs/remotes/origin/fix/b', g(repo, 'rev-parse', 'HEAD'));
  // main restarts: a new root commit with the same files and none of the old history (a repo moved without its history)
  g(repo, 'checkout', '-q', '--orphan', 'fresh'); g(repo, 'commit', '-q', '-m', 'fresh root');
  g(repo, 'branch', '-q', '-f', 'main', 'fresh'); g(repo, 'checkout', '-q', 'main'); g(repo, 'branch', '-q', '-D', 'fresh');
  const states = p => deliverablesView({ stateDir: state, project: p, now: NOW }).rows.map(r => [r.branch, r.state, r.ahead]);
  assert.deepEqual(states({ ...project(repo, tmp('doors')), state }).map(r => r[1]), ['done', 'done'], 'neither is on the new main');
  const p = { ...project(repo, tmp('doors'), { history: ['old-main'] }), state };
  assert.deepEqual(states(p), [['feat/a', 'merged', 0], ['fix/b', 'merged', 0]], 'feat/a by ancestry, fix/b by its work');
  // an unknown history entry is skipped, not an error
  const p2 = { ...project(repo, tmp('doors'), { history: ['no-such-ref', 'old-main'] }), state };
  assert.deepEqual(states(p2).map(r => r[1]), ['merged', 'merged']);
});

test('git cost: a warm scan of every feat/* + fix/* ref is ONE git call; a main move re-checks with batched calls', () => {
  const { repo } = fixture();
  for (let i = 0; i < 6; i++) { g(repo, 'checkout', '-q', '-b', `feat/n${i}`, 'main'); const s = commit(repo, `n${i}.txt`, String(i), `n${i}`); g(repo, 'update-ref', `refs/remotes/origin/feat/n${i}`, s); }
  g(repo, 'checkout', '-q', 'main');
  const cache = {};
  const scan = () => { const git = makeGit(); const s = scanRepo(repo, { cache, git, native: ['**/*.rs'] }); for (const b of s.branches(['feat/*', 'fix/*'])) s.info(b); return git.calls; };
  const cold = scan();
  assert.ok(cold > 1, `cold scan calls ${cold}`);
  assert.equal(scan(), 1, 'warm = only the for-each-ref listing');
  commit(repo, 'm.txt', 'm', 'main moves');
  const moved = scan();
  assert.ok(moved <= 2 + 8, `after a main move: merged set (1 batched) + behind counts of the unmerged, got ${moved}`);
  assert.equal(scan(), 1);
});

// ENGINE-GIT (DEC-88): ahead / behind and merged-on-main of every ref ride the one for-each-ref (%(ahead-behind:main)): a cold scan
// of N unmerged branches is O(1) git spawns, not one rev-list per branch; the counts equal rev-list --left-right --count main...tip
test('git cost: a cold scan of N unmerged branches is ONE git call; behind / ahead equal rev-list counts', () => {
  const { repo } = fixture();
  const cold = (pre, n) => {
    for (let i = 0; i < n; i++) { g(repo, 'checkout', '-q', '-b', `feat/${pre}${i}`, 'main'); const s = commit(repo, `${pre}${i}.txt`, String(i), `${pre}${i}`); g(repo, 'update-ref', `refs/remotes/origin/feat/${pre}${i}`, s); }
    g(repo, 'checkout', '-q', 'main');
    commit(repo, `${pre}-main.txt`, 'm', 'main moves');
    const git = makeGit(), s = scanRepo(repo, { cache: {}, git });
    const rows = s.branches([`feat/${pre}*`]).map(b => s.info(b));
    return { calls: git.calls, rows };
  };
  const small = cold('s', 2), big = cold('k', 8);
  assert.equal(small.calls, 1, 'one for-each-ref carries tip, merged and ahead / behind');
  assert.equal(big.calls, small.calls, 'N branches -> the same spawns');
  assert.equal(big.rows.length, 8);
  for (const r of big.rows) {
    const [behind, ahead] = g(repo, 'rev-list', '--left-right', '--count', `main...${r.tip}`).split(/\s+/).map(Number);
    assert.deepEqual([r.behind, r.ahead, r.merged], [behind, ahead, false], r.branch);
  }
});

// ---------- backfill (DELIVERABLES-SPEC 2): dry run first, a printed table; --apply writes; never touches a branch ----------
import { backfillPlan, applyBackfill, formatBackfill, onRunDone } from '../engine/lib/deliverables.mjs';

function runDone(state, data, h = -30) {
  const s = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'codex-sol', ...data } }, { now: () => at(h - 1), views: false });
  record(state, { kind: 'run', ev: 'end', id: s.id, by: 'launcher', data: { exit: 0, outcome: 'done' } }, { now: () => at(h), views: false });
  return s.id;
}
// the git part (fixture + b merged + feat/c, feat/d + a worktree of feat/a) is one template too
function buildBackfill(root) {
  const repo = path.join(root, 'repo');
  const { a, b } = fromTemplate('dlv-fixture', buildFixture, repo);
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge b', 'fix/b');
  g(repo, 'checkout', '-q', '-b', 'feat/c', 'main'); const c = commit(repo, 'c.py', 'c', 'feat(c): c'); g(repo, 'update-ref', 'refs/remotes/origin/feat/c', c);
  g(repo, 'checkout', '-q', '-b', 'feat/d', 'main'); const d = commit(repo, 'd.py', 'd', 'feat(d): d'); g(repo, 'update-ref', 'refs/remotes/origin/feat/d', d);
  g(repo, 'checkout', '-q', 'main');
  const wt = path.join(root, 'wt', 'a'); g(repo, 'worktree', 'add', '-q', wt, 'feat/a');
  return { repo, a, b, c, d, wt };
}
function backfillFixture() {
  const { repo, a, b, c, d, wt } = fromTemplate('dlv-backfill', buildBackfill, tmp('bf'));
  const notesRoot = tmp('notes'), state = tmp('state'), doors = tmp('doors');
  const brief = path.join(notesRoot, 'brief-a.md'); fs.writeFileSync(brief, '# task A-1 - the native a layer\nbody\n');
  fs.mkdirSync(path.join(notesRoot, 'd')); fs.writeFileSync(path.join(notesRoot, 'd', 'NOTES.md'), '# D lane\n## DONE\n');
  const p = { ...project(repo, doors), state, lane_defaults: { notes: notesRoot.split(path.sep).join('/') + '/${lane}/NOTES.md' } };
  const run = runDone(state, { lane: 'a', worktree: wt, brief, notes: path.join(notesRoot, 'a.md') });
  return { repo, a, b, c, d, wt, state, p, run };
}

test('backfill dry run: one row per unmerged origin feat/* fix/* branch + DONE runs, evidence named, nothing written', () => {
  const f = backfillFixture();
  const before = fs.readdirSync(f.state).sort();
  const plan = backfillPlan({ stateDir: f.state, project: f.p, now: NOW });
  assert.deepEqual(fs.readdirSync(f.state).filter(n => n !== 'deliverables-cache.json').sort(), before, 'a dry run writes no record');
  assert.equal(plan.merged, 1, 'fix/b is on main');
  const by = Object.fromEntries(plan.rows.map(r => [r.branch, r]));
  assert.deepEqual(Object.keys(by).sort(), ['feat/a', 'feat/c', 'feat/d']);
  assert.equal(by['feat/a'].evidence, f.run); assert.equal(by['feat/a'].lane, 'a'); assert.equal(by['feat/a'].delivers, 'task A-1 - the native a layer');
  assert.equal(by['feat/a'].native, true); assert.equal(by['feat/a'].action, 'create');
  assert.equal(by['feat/d'].evidence, null, 'a lane NOTES ending ## DONE is no evidence (gap #3)'); assert.equal(by['feat/d'].action, 'skip: no DONE evidence');
  assert.equal(by['feat/c'].evidence, null); assert.equal(by['feat/c'].action, 'skip: no DONE evidence'); assert.equal(by['feat/c'].delivers, 'feat(c): c');
  const table = formatBackfill(plan);
  assert.match(table, /feat\/a .*create/); assert.match(table, /feat\/c .*skip: no DONE evidence/);
  // branches are never touched
  assert.equal(g(f.repo, 'rev-parse', 'refs/remotes/origin/feat/c'), f.c);
});

test('backfill --apply creates the evidenced rows (--all: every row); a second plan shows them as existing', () => {
  const f = backfillFixture();
  const made = applyBackfill(f.state, backfillPlan({ stateDir: f.state, project: f.p, now: NOW }), { by: 'controller', now: () => at(0) });
  assert.deepEqual(made.map(m => m.branch).sort(), ['feat/a']);
  const dl = Object.values(loadDeliverables(f.state));
  assert.equal(dl.find(i => i.data.branch === 'feat/a').data.run, f.run);
  assert.equal(dl.find(i => i.data.branch === 'feat/a').data.source, 'backfill');
  const again = backfillPlan({ stateDir: f.state, project: f.p, now: NOW });
  assert.match(again.rows.find(r => r.branch === 'feat/a').action, /^exists DLV-\d+$/);
  const all = applyBackfill(f.state, again, { by: 'controller', all: true, now: () => at(0) });
  assert.deepEqual(all.map(m => m.branch).sort(), ['feat/c', 'feat/d']);
});

test('the launcher records a deliverable at a DONE exit: one per repo + branch, a later DONE appends; main / helpers none', () => {
  const f = backfillFixture();
  const r1 = onRunDone(f.state, f.run, { now: () => at(-30) });
  assert.equal(r1.id, 'DLV-1');
  const r2 = runDone(f.state, { lane: 'a', worktree: f.wt, brief: 'x.md' }, -2);
  assert.equal(onRunDone(f.state, r2, { now: () => at(-2) }).ev, 'done');
  const row = deliverablesView({ stateDir: f.state, project: f.p, now: NOW }).rows[0];
  assert.equal(row.run, r2); assert.equal(row.days, 0.1); assert.equal(row.lane, 'a');
  assert.equal(onRunDone(f.state, runDone(f.state, { lane: 'm', worktree: f.repo, brief: 'x.md' }), {}), null, 'main checkout: no deliverable');
  assert.equal(onRunDone(f.state, runDone(f.state, { lane: 'a', worktree: f.wt, brief: 'x.md', role: 'helper', parent: f.run }), {}), null, 'helper: none');
  assert.equal(onRunDone(f.state, runDone(f.state, { lane: 'a', worktree: path.join(f.wt, 'gone'), brief: 'x.md' }), {}), null, 'no git worktree: none');
});

test('a lane whose first run handed off and whose resume ended DONE gets its deliverable (launcher + backfill)', () => {
  const f = backfillFixture();
  const st = loadState(f.state).items[f.run];
  const first = record(f.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'a', worktree: f.wt, brief: 'x.md' } }, { now: () => at(-40), views: false });
  record(f.state, { kind: 'run', ev: 'end', id: first.id, by: 'launcher', data: { exit: 0, outcome: 'handoff' } }, { now: () => at(-39), views: false });
  const resume = runDone(f.state, { lane: 'a', worktree: f.wt, brief: 'x.md', parent: first.id }, -3);
  assert.ok(st, 'the fixture run exists');
  const plan = backfillPlan({ stateDir: f.state, project: f.p, now: NOW });
  assert.equal(plan.rows.find(r => r.branch === 'feat/a').evidence, resume, 'the backfill takes the resume as the evidence');
  const r = onRunDone(f.state, resume, { now: () => at(-3) });
  assert.ok(r && r.id, 'the launcher records it');
  assert.equal(loadDeliverables(f.state)[r.id].data.branch, 'feat/a');
});

// ---------- CLI (DELIVERABLES-SPEC 6): norn deliverables [--json] | backfill [--apply] | park / unpark ----------
import { main } from '../engine/bin/norn.mjs';
function cli(argv) {
  const o = [], e = [];
  const code = main(argv, {}, s => o.push(s), s => e.push(s));
  return { code, out: o.join('\n'), err: e.join('\n') };
}
function projectFile(p) {
  const f = path.join(tmp('pj'), 'project.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 't', title: 't', root: p.root.split(path.sep).join('/'), lane_defaults: p.lane_defaults, deliverables: p.deliverables }));
  return f;
}

test('norn deliverables: list / --json / backfill dry run + --apply / park + unpark (state override keeps tests off live state)', () => {
  const f = backfillFixture();
  const pf = projectFile(f.p), base = ['deliverables', '--project', pf, '--state', f.state];
  const dry = cli([...base, 'backfill']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /feat\/a .*create/);
  assert.equal(Object.keys(loadDeliverables(f.state)).length, 0, 'dry run by default');
  const ap = cli([...base, 'backfill', '--apply', '--as', 'controller']);
  assert.equal(ap.code, 0, ap.err); assert.match(ap.out, /DLV-1/);
  const ls = cli(base);
  assert.equal(ls.code, 0, ls.err); assert.match(ls.out, /DLV-\d+ +done .*feat\/a/);
  const js = JSON.parse(cli([...base, '--json']).out);
  assert.equal(js.rows.length, 1, 'feat/a only: a lane NOTES ending ## DONE is no evidence (gap #3)'); assert.ok(js.rows.every(r => r.state === 'done'));
  const id = js.rows.find(r => r.branch === 'feat/a').id;
  assert.equal(cli([...base, 'park', id, '--why', 'owner: after the door', '--as', 'controller']).code, 0);
  const parked = JSON.parse(cli([...base, '--json']).out).rows.find(r => r.id === id);
  assert.equal(parked.record_state, 'parked'); assert.equal(parked.park.why, 'owner: after the door');
  assert.match(cli(base).out, new RegExp(id + ' .*parked 0d: owner: after the door'));
  assert.equal(cli([...base, 'park', id, '--as', 'controller']).code, 2, 'a park needs the reason');
  assert.equal(cli([...base, 'unpark', id, '--as', 'controller']).code, 0);
  assert.equal(cli(['deliverables', '--state', f.state]).code, 2, 'no project: the repo is unknown');
});

test('backfill --only: the named branches are created whatever their evidence (pre-record lanes the owner names DONE)', () => {
  const f = backfillFixture();
  const plan = backfillPlan({ stateDir: f.state, project: f.p, now: NOW });
  assert.deepEqual(applyBackfill(f.state, plan, { by: 'controller', only: ['feat/c'], now: () => at(0) }).map(m => m.branch), ['feat/c']);
  const pf = projectFile(f.p);
  const r = cli(['deliverables', '--project', pf, '--state', f.state, 'backfill', '--apply', '--only', 'feat/a,feat/c', '--as', 'controller']);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /DLV-2 feat\/a/); assert.doesNotMatch(r.out, /DLV-3/);
});

// ---------- check-in rule (DELIVERABLES-SPEC 4): DONE > 24 h and not MERGED = ONE question per deliverable, never one per tick ----------
import { askDeliverable, closeLandedQuestions } from '../engine/lib/deliverables.mjs';

test('a merge / batch / park question is withdrawn once its deliverable lands; an open one stays; a dry pass writes nothing', () => {
  const { repo, a, b } = fixture();
  const state = tmp('state'), p = { ...project(repo, tmp('doors'), { target: 'main' }), state };
  mkDlv(state, { repo, branch: 'feat/a', tip: a, lane: 'a', delivers: 'native a', done_utc: at(-30).toISOString() }, -30);
  mkDlv(state, { repo, branch: 'fix/b', tip: b, lane: 'b', delivers: 'docs b', done_utc: at(-30).toISOString() }, -30);
  for (const id of ['DLV-1', 'DLV-2']) assert.ok(askDeliverable(state, id, { project: p, by: 'checkin', nowMs: NOW }).id);
  assert.deepEqual(closeLandedQuestions(state, { project: p, nowMs: NOW }), [], 'nothing landed yet');
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'feat/a');
  assert.deepEqual(closeLandedQuestions(state, { project: p, nowMs: NOW, dry: true }).map(c => c.q), ['Q-1']);
  assert.equal(loadState(state).items['Q-1'].state, 'open', 'dry: nothing written');
  const closed = closeLandedQuestions(state, { project: p, nowMs: NOW });
  assert.deepEqual(closed.map(c => [c.q, c.dlv]), [['Q-1', 'DLV-1']]);
  assert.match(closed[0].why, /^landed on main \(git [0-9a-f]{9}\): DLV-1 feat\/a is on main, nothing left to ask/);
  const items = loadState(state).items;
  assert.equal(items['Q-1'].state, 'withdrawn'); assert.equal(items['Q-2'].state, 'open', 'fix/b is not on main: still asked');
  assert.deepEqual(closeLandedQuestions(state, { project: p, nowMs: NOW }), [], 'a second pass finds nothing');
});

// OVERVIEW-TRUTH (1), solve-shack DLV-8: target install, asked Q-1 at 04:48, merged as PR #15 at 14:18 but not installed - the old rule
// waited for the install target, so the owner answered 'merge' for work already merged. Landing withdraws every question it makes moot.
test('a merged deliverable with an earlier question shows no asked and its questions are withdrawn: landed as PR #n', () => {
  const { repo, a } = fixture();
  const state = tmp('state'), p = { ...project(repo, tmp('doors')), state };   // target install (the default): merged is not at its target
  mkDlv(state, { repo, branch: 'feat/a', tip: a, lane: 'a', delivers: 'native a', done_utc: at(-30).toISOString() }, -30);
  assert.ok(askDeliverable(state, 'DLV-1', { project: p, by: 'checkin', nowMs: NOW }).id);
  record(state, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'feat/a conflicts with main: resolve now or wait?', lane: 'a', options: [] } }, { views: false, now: () => at(-2) });
  record(state, { kind: 'question', ev: 'create', by: 'checkin', data: { title: 'an unrelated question', lane: 'other', options: [] } }, { views: false, now: () => at(-2) });
  record(state, { kind: 'deliverable', ev: 'pr', id: 'DLV-1', by: 'launcher', data: { url: 'https://github.com/o/r/pull/15', number: 15 } }, { views: false, now: () => at(-1) });
  assert.equal(deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0].asked, 'Q-1', 'not landed yet: asked');
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'feat/a');
  const r = deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0];
  assert.equal(r.state, 'merged'); assert.equal(r.at_target, false, 'merged, not installed');
  assert.equal(r.asked, null, 'a merged row never reads asked');
  const closed = closeLandedQuestions(state, { project: p, nowMs: NOW });
  assert.deepEqual(closed.map(c => c.q).sort(), ['Q-1', 'Q-2'], 'its own question and the one naming its branch');
  const items = loadState(state).items;
  assert.equal(items['Q-1'].state, 'withdrawn'); assert.match(items['Q-1'].history.at(-1).data.why, /^landed as PR #15: DLV-1 feat\/a is on main/);
  assert.equal(items['Q-2'].state, 'withdrawn'); assert.equal(items['Q-3'].state, 'open', 'a question about other work stays');
});

// slop C3: questions are a shared kind - on a synced home a question another home asked about this home's deliverable counts as
// asked (loadState's set, records.loadShared), and a records log that does not read is an error, never "never asked" (asked twice)
test('two homes: home a\'s question on home b\'s DLV-b-1 reads asked on b; a torn records log throws instead of reading unasked', () => {
  const { repo, a } = fixture();
  const home = id => { const d = tmp(`home-${id}`); fs.writeFileSync(path.join(d, 'home.json'), JSON.stringify({ id, bare_home: 'a', cut_at: '2026-11-01T00:00:00Z' }) + '\n'); return d; };
  const ha = home('a'), hb = home('b'), p = { ...project(repo, tmp('doors'), { target: 'main' }), state: hb };
  assert.equal(mkDlv(hb, { repo, branch: 'feat/a', tip: a, lane: 'a', delivers: 'native a', done_utc: at(-30).toISOString() }, -30).id, 'DLV-b-1');
  const q = record(ha, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'DLV-b-1 feat/a: merge, batch or park?', lane: 'a', deliverable: 'DLV-b-1', options: [] } }, { views: false, now: () => at(-2) }).id;
  fs.mkdirSync(path.join(hb, 'homes', 'a'), { recursive: true });
  fs.copyFileSync(path.join(ha, 'records.jsonl'), path.join(hb, 'homes', 'a', 'records.jsonl'));   // the fetch (foldhomes.test)
  assert.equal(loadState(hb).items[q]?.state, 'open', 'b\'s loadState holds a\'s question');
  assert.equal(deliverablesView({ stateDir: hb, project: p, now: NOW }).rows[0].asked, q);
  assert.match(askDeliverable(hb, 'DLV-b-1', { project: p, by: 'checkin', nowMs: NOW }).refused, new RegExp(`already asked ${q}`));
  fs.appendFileSync(path.join(hb, 'records.jsonl'), '{"torn"');
  assert.throws(() => deliverablesView({ stateDir: hb, project: p, now: NOW }), /integrity error/);
});

test('due + ask: one question per deliverable; parked = quiet; a park resurfaces after 7 days and may be asked again', () => {
  const { repo, a } = fixture();
  const state = tmp('state'), p = { ...project(repo, tmp('doors')), state };
  mkDlv(state, { repo, branch: 'feat/a', tip: a, lane: 'a', delivers: 'native a', done_utc: at(-20).toISOString() }, -20);
  const view = (h = 0) => deliverablesView({ stateDir: state, project: p, now: NOW + h * 3600e3 }).rows[0];
  assert.equal(view().due, false, '20 h: not yet');
  assert.equal(view(5).due, true, '25 h: due');
  const clock = h => () => at(h);
  const q = askDeliverable(state, 'DLV-1', { project: p, by: 'checkin', now: clock(5), nowMs: NOW + 5 * 3600e3 });
  assert.equal(q.id, 'Q-1');
  const Q = loadState(state).items['Q-1'];
  assert.equal(Q.data.deliverable, 'DLV-1'); assert.equal(Q.data.class, 'iii'); assert.equal(Q.data.lane, 'a');
  assert.deepEqual(Q.data.options.map(o => o.key), ['merge', 'batch', 'park']);
  assert.equal(Q.data.recommend.key, 'merge');
  assert.match(Q.data.title, /feat\/a/); assert.ok(Q.data.title.length <= 120);
  assert.match(Q.data.body, /native/);
  assert.deepEqual(Q.data.blocks, [], 'a deliverable question parks no lane');
  assert.equal(view(6).due, false, 'asked: not due on the next tick');
  assert.equal(view(6).asked, 'Q-1');
  assert.match(askDeliverable(state, 'DLV-1', { project: p, by: 'checkin', now: clock(6), nowMs: NOW + 6 * 3600e3 }).refused, /already asked Q-1/);
  // even after the question is closed, the same deliverable is not asked again in this park cycle
  record(state, { kind: 'question', ev: 'withdraw', id: 'Q-1', by: 'controller', data: { why: 'ruled' } }, { now: clock(7), views: false });
  assert.equal(view(8).due, false);
  // parked with the owner's reason: quiet for 7 days, then back up (and askable once more)
  record(state, { kind: 'deliverable', ev: 'park', id: 'DLV-1', by: 'controller', data: { why: 'owner: batch with the Prism door' } }, { now: clock(8), views: false });
  assert.equal(view(9).park.why, 'owner: batch with the Prism door');
  assert.equal(view(9).due, false); assert.equal(view(8 + 7 * 24 - 1).due, false);
  const back = view(8 + 7 * 24 + 1);
  assert.equal(back.park.expired, true); assert.equal(back.due, true); assert.equal(back.asked, null);
  assert.equal(askDeliverable(state, 'DLV-1', { project: p, by: 'checkin', now: clock(8 + 7 * 24 + 1), nowMs: NOW + (8 + 7 * 24 + 1) * 3600e3 }).id, 'Q-2');
  // merged: never due
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'feat/a');
  assert.equal(view(400).due, false);
  assert.match(askDeliverable(state, 'DLV-1', { project: p, by: 'checkin' }).refused, /merged/);
});

test('norn deliverables --due lists only the due rows; ask through the CLI refuses a second time (exit 3)', () => {
  const { repo, a } = fixture();
  const state = tmp('state'), p = { ...project(repo, tmp('doors')), state };
  mkDlv(state, { repo, branch: 'feat/a', tip: a, delivers: 'native a', done_utc: new Date(Date.now() - 48 * 3600e3).toISOString() }, -48);
  mkDlv(state, { repo, branch: 'fix/b', delivers: 'docs b', done_utc: new Date(Date.now() - 3600e3).toISOString() }, -1);
  const base = ['deliverables', '--project', projectFile(p), '--state', state];
  const due = cli([...base, '--due']);
  assert.match(due.out, /DLV-1 .*DUE/); assert.doesNotMatch(due.out, /DLV-2/);
  assert.equal(cli([...base, 'ask', 'DLV-1', '--as', 'checkin']).code, 0);
  const again = cli([...base, 'ask', 'DLV-1', '--as', 'checkin']);
  assert.equal(again.code, 3); assert.match(again.out, /REFUSED: .*already asked Q-1/);
  assert.match(cli([...base, '--due']).out, /no deliverable due/);
});

// ---------- lane lifecycle (DELIVERABLES-SPEC 5): no archive while a deliverable is DONE-not-merged, unless parked with a reason ----------
test('lane archive guard: refused while its deliverable is not merged; allowed once parked or merged', () => {
  const { repo, a } = fixture();
  const state = tmp('state');
  const rec = (e, h) => record(state, e, { now: () => at(h), views: false });
  rec({ kind: 'lane', ev: 'create', by: 'controller', data: { name: 'a' } }, -50);
  rec({ kind: 'lane', ev: 'create', by: 'controller', data: { name: 'free' } }, -50);
  mkDlv(state, { repo, branch: 'feat/a', tip: a, lane: 'a', delivers: 'native a', done_utc: at(-48).toISOString() });
  assert.equal(rec({ kind: 'lane', ev: 'archive', id: 'L:free', by: 'owner', data: {} }, 0).ev, 'archive', 'no deliverable: archive as before');
  assert.throws(() => rec({ kind: 'lane', ev: 'archive', id: 'L:a', by: 'dashboard', data: {} }, 0), e => e instanceof RecordError && e.code === 2 && /DLV-1 \(feat\/a\) is done but not merged/.test(e.message));
  rec({ kind: 'deliverable', ev: 'park', id: 'DLV-1', by: 'owner', data: { why: 'owner: superseded by the C4 sink' } }, 1);
  assert.equal(rec({ kind: 'lane', ev: 'archive', id: 'L:a', by: 'controller', data: {} }, 2).ev, 'archive', 'parked with a reason');
  rec({ kind: 'lane', ev: 'unarchive', id: 'L:a', by: 'controller', data: {} }, 3);
  rec({ kind: 'deliverable', ev: 'unpark', id: 'DLV-1', by: 'controller', data: {} }, 4);
  assert.throws(() => rec({ kind: 'lane', ev: 'archive', id: 'L:a', by: 'controller', data: {} }, 5), /not merged/);
  g(repo, 'merge', '-q', '--no-ff', '-m', 'merge a', 'feat/a');
  assert.equal(rec({ kind: 'lane', ev: 'archive', id: 'L:a', by: 'controller', data: {} }, 6).ev, 'archive', 'merged: archive');
});
