// MERGE-FIRST (3): mechanical landing (engine/lib/landing.mjs, run by the mergeq pass where no fast gate batches). A clean pushed
// deliverable merges in a merge worktree, the quick check runs (syntax + the changed test files), merge-land opens its PR: no Claude
// run. A red check or a conflict
// queues an LLM MERGE run whose brief carries the failure. Temp repos + a bare origin; gh and the norn CLI are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record, loadState } from '../engine/lib/records.mjs';
import { loadDeliverables, deliverablesView } from '../engine/lib/deliverables.mjs';
import { loadMqWhy } from '../engine/lib/mqwhy.mjs';
import { laneNow } from '../engine/lib/laneout.mjs';
import { makeGit } from '../engine/lib/dlvgit.mjs';
import { mergeqRun } from '../engine/lib/mergeq.mjs';
import { loadLand, landGate, landOutcome } from '../engine/lib/landing.mjs';
import { mergeConfig } from '../engine/lib/mergecfg.mjs';
import { mergeWtPath } from '../engine/lib/mergewt.mjs';
import { briefMarker } from '../engine/lib/mergebrief.mjs';
import { queueRun } from '../engine/lib/runs.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

test.after(cleanTmp);
const fwd = p => String(p).replace(/\\/g, '/');
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); };
// the remote reads as a GitHub repo (merge-land needs owner/name); every other git call is real
const ghGit = () => makeGit((repo, args, env, input) => (args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/o/r.git\n'
  : execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }), env: { ...GENV, ...(env || {}) } })));
function fakeGh() {
  let n = 40; const prs = new Map();
  const gh = args => {
    const opt = k => args[args.indexOf(k) + 1];
    if (args[1] === 'list') return { code: 0, out: JSON.stringify(prs.has(opt('--head')) ? [prs.get(opt('--head'))] : []), err: '' };
    if (args[1] === 'create') { const pr = { url: `https://github.com/o/r/pull/${++n}`, number: n }; prs.set(opt('--head'), pr); return { code: 0, out: pr.url + '\n', err: '' }; }
    return { code: 1, out: '', err: 'unexpected gh call' };
  };
  return { gh, prs };
}
// a fake norn CLI: `run --queue` answers a queued run id; every call is kept
function fakeCli() { const calls = []; return { calls, cli: args => { calls.push(args); return args[0] === 'run' ? { code: 0, out: 'RUN-90 queued' } : { code: 0, out: '' }; } }; }

// origin + checkout; lane branches pushed (one worktree each), one deliverable each; main may move after (a conflict)
function fixture(branches, { mainEdit = null } = {}) {
  const t = mkTmp('meta-land-'), origin = path.join(t, 'origin'), repo = path.join(t, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GENV });
  execFileSync('git', ['clone', '-q', origin, repo], { env: GENV, stdio: 'ignore' });
  g(repo, 'config', 'user.name', 't'); g(repo, 'config', 'user.email', 't@t'); g(repo, 'config', 'commit.gpgsign', 'false');
  g(repo, 'checkout', '-q', '-b', 'main');
  commit(repo, 'README.md', 'base\n', 'base');
  g(repo, 'push', '-q', '-u', 'origin', 'main');
  const state = path.join(t, 'state', 't'), tips = {};
  for (const [b, files] of branches) {
    const wt = path.join(t, 'wt-' + b.slice(5));
    g(repo, 'worktree', 'add', '-q', '-b', b, wt, 'main');
    for (const [file, text] of Object.entries(files)) tips[b] = commit(wt, file, text, `${b} ${file}`);
    g(wt, 'push', '-q', '-u', 'origin', b);
    record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: fwd(repo), branch: b, tip: tips[b], lane: b.slice(5), delivers: `feat: ${b}`, done_utc: new Date(Date.now() - 3600e3).toISOString() } }, { views: false });
  }
  if (mainEdit) { commit(repo, mainEdit[0], mainEdit[1], 'main moves'); g(repo, 'push', '-q', 'origin', 'main'); }
  const file = path.join(t, 'project.json');
  const project = { name: 't', root: fwd(repo), file: fwd(file), state: fwd(state), briefs_dir: fwd(path.join(t, 'briefs')), deliverables: { receipts: [] },
    policy: { slop: { enabled: false } } };
  fs.writeFileSync(file, JSON.stringify(project));
  return { t, origin, repo, state, tips, project, locks: path.join(t, 'state', 'locks') };
}
const pass = (f, x) => mergeqRun({ stateDir: f.state, project: f.project, locksDir: f.locks, git: ghGit(), cli: x.cli, gh: x.gh, hbMs: 60000 });
const runIds = f => Object.values(loadState(f.state).items).filter(i => i.kind === 'run');

const GREEN_TEST = "import test from 'node:test';\ntest('a', () => {});\n", RED_TEST = "import test from 'node:test';\ntest('b', () => { throw new Error('red'); });\n";

test('a clean deliverable lands with no Claude run: merged in a merge worktree, quick check green, its PR opened and recorded; main untouched', async () => {
  const f = fixture([['feat/a', { 'engine/a.mjs': 'export const a = 1;\n', 'tests/a.test.mjs': GREEN_TEST }]]), x = { ...fakeCli(), ...fakeGh() };
  // a MERGE the check-in queued for the lane would merge the same work: withdrawn by the landing
  const brief = path.join(f.t, 'm.md'); fs.writeFileSync(brief, 'mode: done\n');
  const budget_file = path.join(f.t, 'budget.json'); fs.writeFileSync(budget_file, '{}');
  const q = queueRun({ state: f.state, locksDir: f.locks, executor: 'fake', lane: 'a', stage: 'MERGE', worktree: path.join(f.t, 'wt-a'), notes: path.join(f.t, 'N.md'), brief, budget: {}, budget_file, policy: { auto_resume_max: 0 }, tick: null }).run;
  const mainBefore = g(f.origin, 'rev-parse', 'main');
  const r = await pass(f, x);
  assert.deepEqual(r.land.landed, ['DLV-1'], r.why);
  assert.match(r.why, /DLV-1 LANDED by code: PR https:\/\/github\.com\/o\/r\/pull\/41 \(gate green\)/);
  const log = fs.readFileSync(path.join(f.state, 'mq', 'land', 'DLV-1-gate.log'), 'utf8');
  assert.match(log, /GREEN syntax engine\/a\.mjs/); assert.match(log, /GREEN syntax tests\/a\.test\.mjs/); assert.match(log, /GREEN test tests\/a\.test\.mjs/);
  assert.equal(x.prs.get('feat/a').number, 41);
  assert.deepEqual(x.calls.map(c => c[0]), ['notify'], 'no norn run: the only CLI call is the merge notice');
  assert.equal(loadState(f.state).items[q].state, 'withdrawn');
  assert.deepEqual(runIds(f).map(i => i.id), [q], 'no run started');
  assert.equal(loadDeliverables(f.state)['DLV-1'].history.findLast(h => h.ev === 'pr').data.url, 'https://github.com/o/r/pull/41');
  assert.equal(g(f.origin, 'rev-parse', 'main'), mainBefore, 'Norn never pushes main');
  assert.equal(loadLand(f.state, 'DLV-1').status, 'landed');
  assert.ok(!fs.existsSync(mergeWtPath(f.state, 'a', f.tips['feat/a'])), 'the merge worktree is removed');
  const again = await pass(f, x);
  assert.deepEqual(again.land.landed, [], 'a PR is open: the row is on its way, not landed twice');
});

test('land-reuse (DEC-b-56): a reused deliverable whose PR merged lands again after a newer DONE: a new PR, not "nothing to land"', async () => {
  const f = fixture([['feat/a', { 'engine/a.mjs': 'export const a = 1;\n' }]]), x = { ...fakeCli(), ...fakeGh() };
  assert.deepEqual((await pass(f, x)).land.landed, ['DLV-1']);
  // PR #41 merges (the tick latches it) and leaves GitHub's open list; the lane's next round ends DONE at a new head
  const merged_at = new Date(Date.now() - 60e3).toISOString();
  record(f.state, { kind: 'deliverable', ev: 'merged', id: 'DLV-1', by: 'checkin', data: { how: 'pr', pr: 41, url: 'https://github.com/o/r/pull/41', merged_at } }, { views: false });
  x.prs.delete('feat/a');
  const wt = path.join(f.t, 'wt-a'), tip = commit(wt, 'engine/a2.mjs', 'export const b = 2;\n', 'round 2'); g(wt, 'push', '-q', 'origin', 'feat/a');
  record(f.state, { kind: 'deliverable', ev: 'done', id: 'DLV-1', by: 'launcher', data: { run: 'RUN-9', tip, done_utc: new Date().toISOString() } }, { views: false });
  const row = deliverablesView({ stateDir: f.state, project: f.project, git: ghGit() }).rows[0];
  assert.deepEqual([row.state, row.pr], ['done', null]);
  const r = await pass(f, x);
  assert.deepEqual(r.land.landed, ['DLV-1'], r.why);
  assert.equal(x.prs.get('feat/a').number, 42);
  assert.deepEqual(deliverablesView({ stateDir: f.state, project: f.project, git: ghGit() }).rows[0].pr, { url: 'https://github.com/o/r/pull/42', number: 42 });
});

test('a red quick check (a changed test file fails) queues an LLM MERGE with the failure attached; the same tip is not tried again', async () => {
  const f = fixture([['feat/b', { 'tests/b.test.mjs': RED_TEST }]]), x = { ...fakeCli(), ...fakeGh() };
  const r = await pass(f, x);
  assert.deepEqual(r.land.fallback, [{ id: 'DLV-1', kind: 'red', queued: 'RUN-90', stage: 'MERGE' }], r.why);
  assert.match(fs.readFileSync(path.join(f.state, 'mq', 'land', 'DLV-1-gate.log'), 'utf8'), /RED test tests\/b\.test\.mjs/);
  const run = x.calls.find(c => c[0] === 'run');
  assert.deepEqual(run.slice(0, 8), ['run', '--queue', '--project', f.project.file, '--lane', 'b', '--stage', 'MERGE']);
  const text = fs.readFileSync(run[run.indexOf('--brief') + 1], 'utf8');
  assert.match(text, /## Mechanical landing failed \(norn mergeq, DLV-1 at [0-9a-f]{7}\)\nQuick check red: `node ".*quick-check\.mjs" --base [0-9a-f]{40}` exit 1/);
  assert.match(text, /Gate log: .*mq\/land\/DLV-1-gate\.log/);
  assert.equal(briefMarker(text).mode, 'staged', 'the marker stays last and readable');
  assert.equal(briefMarker(text).sha, f.tips['feat/b']);
  assert.equal(x.prs.size, 0, 'no PR');
  const again = await pass(f, x);
  assert.equal(x.calls.filter(c => c[0] === 'run').length, 1, 'tried at this tip: no second MERGE');
  assert.deepEqual(again.land.fallback, []);
  // land-push: the skip stays in words while the tip stands - on the deliverable (why_not) and the lane's next line
  const w = loadMqWhy(f.state)['feat/b'];
  assert.equal(w.kind, 'gate'); assert.equal(w.tip, f.tips['feat/b']);
  assert.match(w.why, /^quick check red at [0-9a-f]{7}: .* exit 1 on the merge of .*; RUN-90 is queued$/, 'the fake CLI records no run: no stage to name');
  const row = deliverablesView({ stateDir: f.state, project: f.project, git: ghGit() }).rows.find(r => r.id === 'DLV-1');
  assert.deepEqual([row.why_not.kind, row.why_not.text], ['mq', w.why]);
});

test('a conflict with main queues the MERGE naming the files', async () => {
  const f = fixture([['feat/c', { 'README.md': 'lane\n' }]], { mainEdit: ['README.md', 'main\n'] }), x = { ...fakeCli(), ...fakeGh() };
  const r = await pass(f, x);
  assert.equal(r.land.fallback[0].kind, 'conflict', r.why);
  const run = x.calls.find(c => c[0] === 'run');
  assert.match(fs.readFileSync(run[run.indexOf('--brief') + 1], 'utf8'), /Merge conflict: merging feat\/c [0-9a-f]{7} into main conflicts in README\.md/);
  assert.match(loadMqWhy(f.state)['feat/c'].why, /^merge conflict at [0-9a-f]{7}: merging feat\/c .* conflicts in README\.md; its MERGE RUN-90 is queued$/);
});

// lane-collide S3 (SPEC 4A.6 merge): the conflict path is kept when the fixed tip lands later - the outcome reads it with the run it queued
test('landOutcome: a conflict, then the fixed tip lands clean - the deliverable still took the conflict path, with its queued MERGE', async () => {
  const f = fixture([['feat/c', { 'README.md': 'lane\n' }]], { mainEdit: ['README.md', 'main\n'] }), x = { ...fakeCli(), ...fakeGh() };
  assert.deepEqual(landOutcome(f.state, 'DLV-1'), { merge: 'none', queued: [] }, 'not tried yet');
  await pass(f, x);
  assert.deepEqual(landOutcome(f.state, 'DLV-1'), { merge: 'conflict', queued: ['RUN-90'] });
  const wt = path.join(f.t, 'wt-c');
  g(wt, 'fetch', '-q', 'origin');
  try { g(wt, 'merge', '-q', '--no-edit', 'origin/main'); } catch { /* the conflict: resolved below */ }
  fs.writeFileSync(path.join(wt, 'README.md'), 'main\nlane\n'); g(wt, 'add', 'README.md'); g(wt, 'commit', '-q', '--no-edit');
  const tip = g(wt, 'rev-parse', 'HEAD'); g(wt, 'push', '-q', 'origin', 'feat/c');
  record(f.state, { kind: 'deliverable', ev: 'done', id: 'DLV-1', by: 'launcher', data: { tip, done_utc: new Date().toISOString() } }, { views: false });
  const r = await pass(f, x);
  assert.deepEqual(r.land.landed, ['DLV-1'], r.why);
  assert.equal(loadLand(f.state, 'DLV-1').status, 'landed');
  assert.deepEqual(landOutcome(f.state, 'DLV-1'), { merge: 'conflict', queued: ['RUN-90'] }, 'the landing at the new tip keeps the earlier conflict');
  assert.deepEqual(landOutcome(f.state, 'DLV-9'), { merge: 'none', queued: [] });
});

// merge-slot: on a home that is not the merge leader the MERGE queue is refused (exit 3): the conflicting branch gets its resolve run
test('a conflict on a non-leader home queues the resolve run, not a MERGE', async () => {
  const f = fixture([['feat/r', { 'README.md': 'lane\n' }]], { mainEdit: ['README.md', 'main\n'] }), calls = [];
  const cli = args => { calls.push(args); return args[0] === 'run' ? { code: 3, out: 'refused: MERGE: merge leader is a - this home only opens PRs' } : { code: 0, out: 'RUN-91 queued' }; };
  const r = await pass(f, { cli, ...fakeGh() });
  assert.deepEqual(r.land.fallback, [{ id: 'DLV-1', kind: 'conflict', queued: 'RUN-91', stage: 'resolve' }], r.why);
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [['run', '--queue', '--project'], ['deliverables', 'resolve', 'DLV-1']]);
  assert.match(loadMqWhy(f.state)['feat/r'].why, /; its resolve RUN-91 is queued$/);
});

// land-push: ui-shell, dwarf-names, ui-runs-lanes sat DONE with "not pushed" only in the mergeq output; the Lanes row said nothing
test('a DONE branch the queue skips says why on its deliverable and its Lanes row: not pushed; a landed row clears it', async () => {
  const f = fixture([['feat/d', { 'engine/d.mjs': 'export const d = 1;\n' }]]), x = { ...fakeCli(), ...fakeGh() };
  const wt = path.join(f.t, 'wt-d'), tip = f.tips['feat/d'];
  g(wt, 'push', '-q', 'origin', '--delete', 'feat/d');   // never pushed, as on home b
  const run = record(f.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'd', worktree: fwd(wt) } }, { views: false }).id;
  record(f.state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { exit: 0, outcome: 'done', branch: 'feat/d', head: tip } }, { views: false });
  const r = await pass(f, x);
  assert.deepEqual(r.land.landed, [], r.why);
  assert.match(r.why, new RegExp(`DLV-1: not pushed at ${tip.slice(0, 7)}`));
  assert.deepEqual([loadMqWhy(f.state)['feat/d'].kind, loadMqWhy(f.state)['feat/d'].tip], ['unpushed', tip]);
  const rows = deliverablesView({ stateDir: f.state, project: f.project, git: ghGit() }).rows;
  assert.match(rows[0].why_not.text, /^not pushed at [0-9a-f]{7}: the tick's path to main pushes it$/); assert.equal(rows[0].why_not.warn, true);
  const next = laneNow({ lane: 'd', items: loadState(f.state).items, rows }).next;
  assert.deepEqual([next.words, next.cls], [`awaiting merge: ${rows[0].why_not.text}`, 'warn'], 'the Lanes row says why, not "no PR yet"');
  g(wt, 'push', '-q', 'origin', 'feat/d');   // the tick's path to main pushes it: the next pass lands it and the skip goes
  const r2 = await pass(f, x);
  assert.deepEqual(r2.land.landed, ['DLV-1'], r2.why);
  assert.equal(loadMqWhy(f.state)['feat/d'], undefined);
});

test('landGate: the quick check, never the full suite; a pytest merge gate lends its python and folder; merge.suite = skip runs none', () => {
  const base = 'f'.repeat(40), P = (o = {}) => ({ name: 'p', root: '/r', ...o });
  const plain = landGate(P(), { base, cfg: mergeConfig(P()) });
  assert.match(plain.cmd, /^node ".*\/engine\/bin\/quick-check\.mjs" --base f{40}$/); assert.equal(plain.timeout_min, 30);
  const ss = P({ subdir: 'solve-shack', merge: { gate: { cmd: '"C:\\v\\python.exe" -m pytest tests -q -p no:cacheprovider' } } });
  assert.match(landGate(ss, { base, cfg: mergeConfig(ss) }).cmd, /--base f{40} --python "C:\/v\/python\.exe" --dir "solve-shack"$/);
  assert.doesNotMatch(landGate(ss, { base, cfg: mergeConfig(ss) }).cmd, /pytest tests/, 'never the whole pytest suite');
  assert.match(landGate(P({ policy: { merge: { suite: 'skip' } } }), { base, cfg: mergeConfig(P()) }).skip, /merge\.suite = skip/);
});
