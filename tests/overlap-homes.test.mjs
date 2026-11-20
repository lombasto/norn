// RM-46 S6b (multi-home SPEC 4.9): cross-home conflict warnings. A synced project (home.json: home a) with a running lane on norn/a/feat
// and an open deliverable on norn/a/held; another home (b) pushes norn/b/* branches to the same origin. A pair that shares files gets a
// git merge-tree; a predicted conflict is a digest row "norn/a/x conflicts with norn/b/y (on b): n files". Temp repos only; synthetic names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';
import { refreshOverlap, projectOverlap, readOverlap, overlapFile, overlapRows } from '../engine/lib/overlap.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { loadState } from '../engine/lib/records.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const fwd = p => p.split(path.sep).join('/');
const BASE = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
const edit = (at, s) => BASE.split('\n').map((l, i) => (i === at ? s : l)).join('\n');

// origin; home a's clone + lane worktree (norn/a/feat: line 1 of src/a.js) + a local deliverable branch (norn/a/held: line 1 of src/c.js);
// home b's clone pushes norn/b/clash (line 1 of src/a.js: a conflict), norn/b/calm (line 15 of src/a.js: shares the file, merges clean),
// norn/b/clash2 (line 1 of src/c.js: conflicts with the deliverable) and feat/other (line 1 of src/a.js: not a home branch)
function fixture({ synced = true } = {}) {
  const t = mkTmp('meta-ovlh-'), origin = path.join(t, 'origin.git'), home = path.join(t, 'home'), b = path.join(t, 'b'), wt = path.join(t, 'wt');
  git(t, 'init', '-q', '--bare', '-b', 'main', origin);
  git(t, 'clone', '-q', origin, home);
  git(home, 'checkout', '-q', '-b', 'main');
  for (const f of ['a.js', 'c.js', 'd.js']) put(path.join(home, 'src', f), BASE);
  git(home, 'add', '-A'); git(home, 'commit', '-qm', 'base'); git(home, 'push', '-q', 'origin', 'main');
  git(t, 'clone', '-q', origin, b);
  const push = (br, file, at, s) => { git(b, 'checkout', '-q', '-b', br, 'origin/main'); put(path.join(b, 'src', file), edit(at, s)); git(b, 'commit', '-qam', br); git(b, 'push', '-q', 'origin', br); };
  push('norn/b/clash', 'a.js', 1, 'b says one'); push('norn/b/calm', 'a.js', 15, 'b says fifteen'); push('norn/b/clash2', 'c.js', 1, 'b says c'); push('feat/other', 'a.js', 1, 'other says one');
  git(home, 'worktree', 'add', '-q', '-b', 'norn/a/feat', wt, 'main');
  put(path.join(wt, 'src', 'a.js'), edit(1, 'a says one')); git(wt, 'commit', '-qam', 'lane work');
  git(home, 'branch', 'norn/a/held', 'main'); git(home, 'checkout', '-q', 'norn/a/held');
  put(path.join(home, 'src', 'c.js'), edit(1, 'a says c')); git(home, 'commit', '-qam', 'held work'); git(home, 'checkout', '-q', 'main');
  const state = path.join(t, 'state', 'k');
  fs.mkdirSync(state, { recursive: true });
  if (synced) fs.writeFileSync(path.join(state, 'home.json'), JSON.stringify({ id: 'a', bare_home: 'a', cut_at: '2026-11-20T10:00:00Z' }) + '\n');
  return { t, origin, home, wt, state };
}
const startLane = (state, wt, lane = 'feat') => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane, worktree: fwd(wt) } }).id;
const openDlv = (state, home) => record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: fwd(home), branch: 'norn/a/held', lane: 'held', delivers: 'held work' } }).id;
const counting = () => { const calls = []; const real = (a, b, cwd) => { const r = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { cwd, encoding: 'utf8' }); return r.status === 0 ? { conflict: false, files: [] } : r.status === 1 ? { conflict: true, files: r.stdout.trim().split('\n').slice(1) } : null; };
  return { calls, mergeTree: (a, b, cwd) => { calls.push(`${a} ${b}`); return real(a, b, cwd); } }; };

test('cross-home conflict: a file-sharing pair with another home\'s branch that merge-tree says conflicts is one row; a clean merge, a non-home branch and the own home are not', () => {
  const f = fixture();
  const run = startLane(f.state, f.wt);
  const m = counting();
  const c = refreshOverlap({ root: f.home, lanes: [{ lane: 'feat', run, worktree: f.wt }], cacheFile: overlapFile(f.state), gh: () => null, home: 'a', mergeTree: m.mergeTree });
  assert.deepEqual(c.lanes.feat.overlaps.map(o => o.ref).sort(), ['feat/other', 'norn/b/calm', 'norn/b/clash'], 'all three share src/a.js');
  assert.equal(m.calls.length, 2, 'merge-tree runs only on the other home\'s file-sharing branches (clash, calm), never on feat/other or norn/b/clash2 (no shared file)');
  assert.deepEqual(c.lanes.feat.conflicts, [{ ref: 'norn/b/clash', home: 'b', n: 1, files: ['src/a.js'] }]);
  const rows = overlapRows(f.state, loadState(f.state).items).filter(r => r.kind === 'conflict');
  assert.deepEqual(rows.map(r => [r.id, r.lane, r.run, r.ref, r.home, r.why]), [['CFL-feat-norn/b/clash', 'feat', run, 'norn/b/clash', 'b', 'norn/a/feat conflicts with norn/b/clash (on b): 1 file']]);
  // cached per (own tip, their tip) under the TTL: a second refresh runs no merge-tree; a new own tip runs it again
  refreshOverlap({ root: f.home, lanes: [{ lane: 'feat', run, worktree: f.wt }], cacheFile: overlapFile(f.state), gh: () => null, home: 'a', mergeTree: m.mergeTree });
  assert.equal(m.calls.length, 2, 'cached');
  put(path.join(f.wt, 'src', 'a.js'), edit(1, 'b says one')); git(f.wt, 'commit', '-qam', 'take b\'s line');
  const c2 = refreshOverlap({ root: f.home, lanes: [{ lane: 'feat', run, worktree: f.wt }], cacheFile: overlapFile(f.state), gh: () => null, home: 'a', mergeTree: m.mergeTree });
  assert.equal(m.calls.length, 4, 'a new own tip: merge-tree again');
  assert.deepEqual(c2.lanes.feat.conflicts, [], 'the same line on both sides merges clean: the row goes');
});

test('cross-home conflict: projectOverlap checks a synced project\'s open deliverable too, and the digest carries both rows; the ended lane\'s row leaves', () => {
  const f = fixture();
  const run = startLane(f.state, f.wt), dlv = openDlv(f.state, f.home);
  const project = { name: 'k', root: fwd(f.home), state: f.state, policy: {} };
  assert.ok(projectOverlap(project, { gh: () => null }));
  assert.equal(readOverlap(f.state).lanes.held.open, 'deliverable');
  const d = digest(f.state, project, { dlv: [], ready: [], evalAfter: () => ({ met: true }) });
  const cf = d.sections.overlap.filter(r => r.kind === 'conflict');
  assert.deepEqual(cf.map(r => r.why).sort(), ['norn/a/feat conflicts with norn/b/clash (on b): 1 file', 'norn/a/held conflicts with norn/b/clash2 (on b): 1 file']);
  assert.ok(!d.sections.overlap.some(r => r.lane === 'held' && r.kind !== 'conflict'), 'a deliverable lane gets conflict rows only, never the upstream overlap rows');
  record(f.state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { outcome: 'done', exit: 0 } });
  const after = digest(f.state, project, { dlv: [], ready: [], evalAfter: () => ({ met: true }) }).sections.overlap ?? [];
  assert.deepEqual(after.map(r => r.lane), ['held'], 'the ended lane leaves; the open deliverable stays');
  assert.ok(dlv);
});

test('cross-home conflict: a solo project (no home.json) runs no merge-tree and has no conflict rows', () => {
  const f = fixture({ synced: false });
  const run = startLane(f.state, f.wt);
  const m = counting();
  const c = refreshOverlap({ root: f.home, lanes: [{ lane: 'feat', run, worktree: f.wt }], cacheFile: overlapFile(f.state), gh: () => null, mergeTree: m.mergeTree });
  assert.equal(m.calls.length, 0);
  assert.deepEqual(c.lanes.feat.conflicts, []);
  openDlv(f.state, f.home);
  projectOverlap({ name: 'k', root: fwd(f.home), state: f.state, policy: {} }, { gh: () => null });
  assert.equal(readOverlap(f.state).lanes.held, undefined, 'a solo project checks no deliverable lanes');
});
