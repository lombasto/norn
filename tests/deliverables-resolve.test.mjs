// META-DLV-R2 (GT-4): merge rehearsal (`git merge-tree --write-tree main <tip>`) per DONE deliverable, cached by the (main, tip)
// pair, and the rebase / resolve lane (`norn deliverables resolve DLV-n`). Temp repos + temp state dirs only (removed after).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record } from '../engine/lib/records.mjs';
import { scanRepo, makeGit } from '../engine/lib/dlvgit.mjs';
import { deliverablesView, deliverableConfig, formatDeliverable, resolveDeliverable } from '../engine/lib/deliverables.mjs';
import { renderDeliverable } from '../engine/dash/ui.mjs';
import { main } from '../engine/bin/norn.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { fromTemplate } from './helpers/git-template.mjs';

const tmp = p => mkTmp('meta-dlvr2-' + p + '-');
test.after(cleanTmp);
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg);
  return g(repo, 'rev-parse', 'HEAD');
};
const loose = repo => Number(g(repo, 'count-objects', '-v').match(/^count: (\d+)/m)[1]);
// main + feat/c (conflicts on README.md) + feat/d (clean, docs) + feat/n (native .rs, conflicts too); all "pushed"
// (DEC-85) built once per process (helpers/git-template.mjs), each test gets its own copy: same tree, same SHAs
const fixture = () => fromTemplate('dlvr-fixture', buildFixture, tmp('repo'));
function buildFixture(repo) {
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'README.md', 'r\n', 'init');
  const tips = {};
  for (const [b, files] of [['feat/c', [['README.md', 'c\n']]], ['feat/d', [['docs/d.md', 'd\n']]], ['feat/n', [['crates/x/src/lib.rs', 'fn n() {}\n'], ['README.md', 'n\n']]]]) {
    g(repo, 'checkout', '-q', '-b', b, 'main');
    for (const [f, t] of files) tips[b] = commit(repo, f, t, `${b}: ${f}`);
    g(repo, 'update-ref', `refs/remotes/origin/${b}`, tips[b]);
  }
  g(repo, 'checkout', '-q', 'main');
  commit(repo, 'README.md', 'm\n', 'main moves README');
  return { repo, tips };
}
const NOW = Date.parse('2026-11-08T12:00:00Z');
const at = h => new Date(NOW + h * 3600e3);
const project = (repo, extra = {}) => ({ name: 't', root: repo, state: null, lane_defaults: {}, deliverables: { native: ['**/*.rs'], receipts: [], ...extra } });
const mkDlv = (state, data) => record(state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { done_utc: at(-48).toISOString(), ...data } }, { now: () => at(-48), views: false });
function stateWith(f) {
  const state = tmp('state');
  mkDlv(state, { repo: f.repo, branch: 'feat/c', tip: f.tips['feat/c'], lane: 'c', delivers: 'c work' });
  mkDlv(state, { repo: f.repo, branch: 'feat/d', tip: f.tips['feat/d'], lane: 'd', delivers: 'd docs' });
  mkDlv(state, { repo: f.repo, branch: 'feat/n', tip: f.tips['feat/n'], lane: 'n', delivers: 'n native' });
  return state;
}

test('rehearsal: merge-tree says clean or names the conflicting paths; cached by (main, tip); the repo object store is untouched', () => {
  const f = fixture();
  const before = loose(f.repo);
  const git = makeGit(), cache = {};
  const s = scanRepo(f.repo, { cache, git });
  assert.deepEqual(s.rehearse(f.tips['feat/c']), { clean: false, files: ['README.md'] });
  assert.deepEqual(s.rehearse(f.tips['feat/d']), { clean: true, files: [] });
  assert.equal(loose(f.repo), before, 'merge-tree writes into a scratch object dir, never the repo');
  const warm = makeGit();
  const s2 = scanRepo(f.repo, { cache, git: warm });
  s2.rehearse(f.tips['feat/c']); s2.rehearse(f.tips['feat/d']);
  assert.equal(warm.calls, 1, 'warm: the one for-each-ref, no merge-tree');
  g(f.repo, 'checkout', '-q', 'main'); commit(f.repo, 'docs/d.md', 'other\n', 'main touches d');
  const moved = makeGit();
  const s3 = scanRepo(f.repo, { cache, git: moved });
  assert.deepEqual(s3.rehearse(f.tips['feat/d']), { clean: false, files: ['docs/d.md'] }, 'a main move re-rehearses');
  assert.ok(moved.calls >= 2);
});

test('view: done rows carry the rehearsal and a resolve flag (conflict, or more than resolve_behind commits behind); default 100', () => {
  const f = fixture();
  assert.equal(deliverableConfig({}).resolve_behind, 100);
  const state = stateWith(f);
  const v = deliverablesView({ stateDir: state, project: project(f.repo), now: NOW });
  const by = Object.fromEntries(v.rows.map(r => [r.branch, r]));
  assert.deepEqual(by['feat/c'].rehearsal, { clean: false, files: ['README.md'] });
  assert.deepEqual(by['feat/c'].resolve, { why: 'conflict: README.md' });
  assert.deepEqual(by['feat/d'].rehearsal, { clean: true, files: [] });
  assert.equal(by['feat/d'].resolve, null, 'clean and 1 behind');
  const tight = deliverablesView({ stateDir: state, project: project(f.repo, { resolve_behind: 0 }), now: NOW });
  assert.deepEqual(tight.rows.find(r => r.branch === 'feat/d').resolve, { why: '1 behind main (> 0)' });
  assert.match(formatDeliverable(by['feat/c']), /conflict: README\.md/);
  assert.match(formatDeliverable(by['feat/d']), /\bclean\b/);
  // merged: no rehearsal
  g(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge d', 'feat/d');
  const m = deliverablesView({ stateDir: state, project: project(f.repo), now: NOW }).rows.find(r => r.branch === 'feat/d');
  assert.equal(m.state, 'merged'); assert.equal(m.rehearsal, null); assert.equal(m.resolve, null);
});

// ENGINE-GIT (DEC-88): the view rehearses every DONE tip in ONE `merge-tree --stdin` (N tips -> 1 spawn), with the per-pair answer;
// a tip git cannot merge (gone) fails the batch; each tip is then asked alone, so every answer stays the per-pair one
test('git cost: the view rehearses N done tips with one merge-tree spawn; same answers as one merge-tree per pair', () => {
  const f = fixture();
  const state = stateWith(f);
  for (let i = 0; i < 3; i++) {
    g(f.repo, 'checkout', '-q', '-b', `feat/e${i}`, 'main~1');
    const t = commit(f.repo, `docs/e${i}.md`, `e${i}\n`, `e${i}`);
    g(f.repo, 'update-ref', `refs/remotes/origin/feat/e${i}`, t);
    mkDlv(state, { repo: f.repo, branch: `feat/e${i}`, tip: t, lane: `e${i}`, delivers: `e${i}` });
  }
  g(f.repo, 'checkout', '-q', 'main');
  const counted = () => {
    const exec = (repo, args, env, input) => { if (args[0] === 'merge-tree') exec.mt++; return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }), ...(env ? { env: { ...process.env, ...env } } : {}) }); };
    exec.mt = 0;
    return { git: makeGit(exec), exec };
  };
  const a = counted();
  const v = deliverablesView({ stateDir: state, project: project(f.repo), now: NOW, git: a.git });
  assert.equal(v.rows.filter(r => r.rehearsal).length, 6);
  assert.equal(a.exec.mt, 1, 'six done tips, one merge-tree');
  const s = scanRepo(f.repo, { cache: {}, git: makeGit() });
  for (const r of v.rows) assert.deepEqual(r.rehearsal, s.rehearse(r.tip), r.branch);
  // a done tip that is no commit here any more: the per-pair answer (merge-tree exits 1), the others unchanged. Its branch is gone, so it
  // is DONE only by the owner's still-open ruling (DLV-MERGED-TRUTH: else 'cannot tell', never rehearsed)
  const gone = mkDlv(state, { repo: f.repo, branch: 'feat/gone', tip: 'deadbeef'.repeat(5), lane: 'gone', delivers: 'gone' });
  record(state, { kind: 'deliverable', ev: 'still_open', id: gone.id, by: 'owner', data: { q: 'Q-1' } }, { now: () => at(-47), views: false });
  fs.rmSync(path.join(state, 'deliverables-cache.json'), { force: true });
  const v2 = deliverablesView({ stateDir: state, project: project(f.repo), now: NOW, git: counted().git });
  assert.equal(v2.rows.length, 7);
  assert.equal(v2.rows.find(r => r.branch === 'feat/gone').state, 'done', 'ruled still open');
  for (const r of v2.rows) assert.deepEqual(r.rehearsal, s.rehearse(r.tip), r.branch);
});

test('resolve: refuses native (door work), clean + current, merged; writes a ready brief and plans a norn run on its own worktree', () => {
  const f = fixture();
  const state = stateWith(f);
  const p = project(f.repo);
  assert.match(resolveDeliverable(state, 'DLV-3', { project: p, nowMs: NOW }).refused, /native-touching.*controller \/ door/);
  assert.match(resolveDeliverable(state, 'DLV-2', { project: p, nowMs: NOW }).refused, /nothing to resolve/);
  assert.match(resolveDeliverable(state, 'DLV-9', { project: p, nowMs: NOW }).refused, /does not exist/);
  const r = resolveDeliverable(state, 'DLV-1', { project: p, nowMs: NOW, executor: 'fake' });
  assert.equal(r.refused, undefined);
  const brief = fs.readFileSync(r.brief, 'utf8');
  for (const s of ['DLV-1', 'feat/c', 'README.md', 'git merge', 'no force-push', 'norn done', r.notes]) assert.ok(brief.includes(s), s);
  assert.deepEqual(r.run.slice(0, 6), ['run', '--executor', 'fake', '--lane', 'c', '--brief']);
  for (const k of ['--worktree', '--notes', '--stage', '--queue']) assert.ok(r.run.includes(k), k);
  assert.equal(r.run[r.run.indexOf('--stage') + 1], 'resolve');
  assert.ok(!r.worktree.toLowerCase().startsWith(f.repo.toLowerCase() + path.sep), 'its own worktree, not the main checkout');
  g(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge d', 'feat/d');
  assert.match(resolveDeliverable(state, 'DLV-2', { project: p, nowMs: NOW }).refused, /merged/);
});

test('resolve: one live resolve run per deliverable (a running / queued one refuses a second)', () => {
  const f = fixture();
  const state = stateWith(f);
  const r = resolveDeliverable(state, 'DLV-1', { project: project(f.repo), nowMs: NOW, executor: 'fake' });
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', lane: 'c', brief: r.brief, worktree: r.worktree, stage: 'resolve' } }, { views: false });
  assert.match(resolveDeliverable(state, 'DLV-1', { project: project(f.repo), nowMs: NOW }).refused, /already has a live resolve run RUN-\d+/);
});

function projectFile(p) {
  const fl = path.join(tmp('pj'), 'project.json');
  fs.writeFileSync(fl, JSON.stringify({ schema: 1, name: 't', title: 't', root: p.root.split(path.sep).join('/'), lane_defaults: {}, deliverables: p.deliverables }));
  return fl;
}
function cli(argv) {
  const o = [], e = [];
  const code = main(argv, {}, s => o.push(s), s => e.push(s));
  return { code, out: o.join('\n'), err: e.join('\n') };
}

test('norn deliverables --resolve lists the dispatchable rows; resolve --dry prints the run; a refusal exits 3', () => {
  const f = fixture();
  const state = stateWith(f);
  const base = ['deliverables', '--project', projectFile(project(f.repo)), '--state', state];
  const ls = cli([...base, '--resolve']);
  assert.equal(ls.code, 0);
  assert.match(ls.out, /DLV-1 .*feat\/c/); assert.doesNotMatch(ls.out, /DLV-2|DLV-3/, 'clean / native rows are not dispatchable');
  const dry = cli([...base, 'resolve', 'DLV-1', '--dry', '--executor', 'fake']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /DRY RUN/); assert.match(dry.out, /norn run --executor fake --lane c --brief .*DLV-1/);
  const no = cli([...base, 'resolve', 'DLV-3', '--dry']);
  assert.equal(no.code, 3); assert.match(no.out, /REFUSED: .*native/);
});
