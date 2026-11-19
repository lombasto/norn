// GAP-12 (overlap): a running lane's changed files against the remote's branches and open PRs. Temp git repos: a bare "origin",
// the home clone (main + a lane worktree on norn/k/feat), and a second clone ("upstream", another machine) that pushes a branch
// touching the same file. gh is a stub (the PR list); no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';
import { refreshOverlap, projectOverlap, readOverlap, githubRepo, overlapText, overlapFile, overlapOn } from '../engine/lib/overlap.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderTab } from '../engine/dash/ui.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const fwd = p => p.split(path.sep).join('/');

function fixture() {
  const t = mkTmp('meta-overlap-'), origin = path.join(t, 'origin.git'), home = path.join(t, 'home'), up = path.join(t, 'up'), wt = path.join(t, 'wt');
  git(t, 'init', '-q', '--bare', '-b', 'main', origin);
  git(t, 'clone', '-q', origin, home);
  git(home, 'checkout', '-q', '-b', 'main');
  for (const f of ['a.js', 'b.js', 'c.js', 'd.js']) put(path.join(home, 'src', f), `// ${f}\n`);
  git(home, 'add', '-A'); git(home, 'commit', '-qm', 'base'); git(home, 'push', '-q', 'origin', 'main');
  // another machine: a branch touching a.js + c.js, pushed
  git(t, 'clone', '-q', origin, up);
  git(up, 'checkout', '-q', '-b', 'feat/same-thing');
  put(path.join(up, 'src', 'a.js'), '// a, upstream\n'); put(path.join(up, 'src', 'c.js'), '// c, upstream\n');
  git(up, 'commit', '-qam', 'upstream work'); git(up, 'push', '-q', 'origin', 'feat/same-thing');
  // and one touching only d.js (no overlap)
  git(up, 'checkout', '-q', '-b', 'feat/elsewhere', 'origin/main');
  put(path.join(up, 'src', 'd.js'), '// d, upstream\n'); git(up, 'commit', '-qam', 'elsewhere'); git(up, 'push', '-q', 'origin', 'feat/elsewhere');
  // the lane: a worktree of home on norn/k/feat, a commit on a.js and an uncommitted edit of b.js; pushed (our own branch on origin)
  git(home, 'worktree', 'add', '-q', '-b', 'norn/k/feat', wt, 'main');
  put(path.join(wt, 'src', 'a.js'), '// a, the lane\n'); git(wt, 'commit', '-qam', 'lane work'); git(wt, 'push', '-q', 'origin', 'norn/k/feat');
  put(path.join(wt, 'src', 'b.js'), '// b, uncommitted\n');
  const state = path.join(t, 'state', 'k');
  fs.mkdirSync(state, { recursive: true });
  return { t, origin, home, up, wt, state };
}
const startLane = (state, wt, lane = 'feat') => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane, worktree: fwd(wt) } }).id;
const counter = () => { const calls = []; return { calls, git: (args, cwd) => { calls.push(args.join(' ')); try { return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } } }; };

test('overlap: a remote branch touching the lane\'s files is listed with the shared files; one touching others is not; our own pushed branch is not', () => {
  const f = fixture();
  const run = startLane(f.state, f.wt);
  const c = refreshOverlap({ root: f.home, lanes: [{ lane: 'feat', run, worktree: f.wt }], cacheFile: overlapFile(f.state), gh: () => null });
  const l = c.lanes.feat;
  assert.equal(l.branch, 'norn/k/feat');
  assert.equal(l.files, 2, 'the lane: a.js (committed) + b.js (uncommitted)');
  assert.deepEqual(l.overlaps.map(o => [o.kind, o.ref, o.n, o.files]), [['branch', 'feat/same-thing', 1, ['src/a.js']]]);
  assert.equal(overlapText(l.overlaps[0]), 'overlaps upstream: feat/same-thing (1 file)');
  assert.equal(c.fetch_error, null);
  assert.deepEqual(Object.keys(c.remote).sort(), ['feat/elsewhere', 'feat/same-thing'], 'origin/main and our own norn/k/feat (a local branch) are not upstream');
});

test('overlap: open PRs from gh (stub) - the PR is the row (not its branch twice), with its number, title and link; gh absent = branches only', () => {
  const f = fixture();
  git(f.home, 'fetch', '-q', 'origin');   // the refs a last online fetch left
  git(f.home, 'remote', 'set-url', 'origin', 'https://github.com/someone/proj.git');   // GitHub for the PR lookup
  const off = counter(), offline = (args, cwd) => (args[0] === 'fetch' ? null : off.git(args, cwd));   // offline: the fetch fails (no network in a test)
  const run = startLane(f.state, f.wt);
  const ghCalls = [];
  const gh = args => { ghCalls.push(args); return JSON.stringify([
    { number: 12, title: 'Same feature, upstream', headRefName: 'feat/same-thing', url: 'https://github.com/someone/proj/pull/12', files: [{ path: 'src/a.js' }, { path: 'src/c.js' }] },
    { number: 13, title: 'Our own lane', headRefName: 'norn/k/feat', url: 'u13', files: [{ path: 'src/a.js' }] },
    { number: 14, title: 'Docs', headRefName: 'docs/x', url: 'u14', files: [{ path: 'README.md' }] }]); };
  const c = refreshOverlap({ root: f.home, lanes: [{ lane: 'feat', run, worktree: f.wt }], cacheFile: overlapFile(f.state), gh, git: offline });
  assert.match(c.fetch_error, /fetch origin failed/, 'offline: said, and the last fetched refs still answer');
  assert.deepEqual(ghCalls[0].slice(0, 4), ['pr', 'list', '--repo', 'someone/proj']);
  assert.ok(ghCalls[0].join(' ').includes('number,title,headRefName,files'));
  assert.deepEqual(c.lanes.feat.overlaps.map(o => [o.kind, o.number ?? o.ref, o.n]), [['pr', 12, 1]], 'PR 12 once; our own PR 13 and the non-overlapping 14 are not rows');
  assert.equal(overlapText(c.lanes.feat.overlaps[0]), 'overlaps upstream: PR #12 (1 file)');
  assert.equal(c.lanes.feat.overlaps[0].url, 'https://github.com/someone/proj/pull/12');
  const none = refreshOverlap({ root: f.home, lanes: [{ lane: 'feat', run, worktree: f.wt }], cacheFile: overlapFile(f.state) + '2', gh: () => null, git: offline });
  assert.deepEqual(none.lanes.feat.overlaps.map(o => [o.kind, o.ref]), [['branch', 'feat/same-thing']], 'gh absent / failing: no PR rows, no error, branches still');
  assert.equal(none.prs, null);
});

test('overlap: rate-limited - the fetch and the gh call run once per TTL; force runs them again; no origin = no lanes, no fetch', () => {
  const f = fixture();
  const run = startLane(f.state, f.wt);
  const { calls, git: g } = counter();
  let ghN = 0;
  const o = { root: f.home, lanes: [{ lane: 'feat', run, worktree: f.wt }], cacheFile: overlapFile(f.state), git: g, gh: () => { ghN++; return '[]'; } };
  refreshOverlap({ ...o, now: 1e12 });
  refreshOverlap({ ...o, now: 1e12 + 60000 });
  assert.equal(calls.filter(x => x.startsWith('fetch')).length, 1, 'one fetch inside the TTL');
  refreshOverlap({ ...o, now: 1e12 + 11 * 60000 });
  assert.equal(calls.filter(x => x.startsWith('fetch')).length, 2, 'a new fetch after the TTL');
  refreshOverlap({ ...o, now: 1e12 + 11 * 60000 + 1, force: true });
  assert.equal(calls.filter(x => x.startsWith('fetch')).length, 3, 'force (a lane start) fetches at once');
  assert.equal(ghN, 0, 'origin is not GitHub: gh never asked');
  const bare = mkTmp('meta-overlap-noorigin-');
  git(bare, 'init', '-q', '-b', 'main');
  const n = counter();
  const c = refreshOverlap({ root: bare, lanes: [{ lane: 'x', run: 'RUN-9', worktree: bare }], cacheFile: path.join(bare, 'o.json'), git: n.git, gh: () => { throw new Error('never'); } });
  assert.deepEqual(c.lanes, {});
  assert.ok(!n.calls.some(x => x.startsWith('fetch')), 'no origin: no fetch');
});

test('overlap: the digest row (running lanes only, level-triggered), the Lanes chip linking to the PR, and policy.overlap.enabled false = off', () => {
  const f = fixture();
  const run = startLane(f.state, f.wt);
  const project = { name: 'k', root: fwd(f.home), state: f.state, policy: {} };
  const gh = () => JSON.stringify([{ number: 12, title: 'Same feature', headRefName: 'feat/same-thing', url: 'https://github.com/someone/proj/pull/12', files: [{ path: 'src/a.js' }] }]);
  assert.ok(projectOverlap(project, { gh }), 'refreshed');
  assert.equal(readOverlap(f.state).prs, null, 'origin is a local path: no PR lookup');
  const d = digest(f.state, project, { dlv: [], ready: [], evalAfter: () => ({ met: true }) });
  assert.deepEqual(d.sections.overlap.map(r => [r.id, r.lane, r.run, r.why]), [['OVL-feat-feat/same-thing', 'feat', run, 'overlaps upstream: feat/same-thing (1 file)']]);
  assert.deepEqual(d.sections.overlap[0].files, ['src/a.js']);
  // the dashboard: the chip on the lane row, a PR one links to the PR
  const c = readOverlap(f.state);
  c.lanes.feat.overlaps = [{ kind: 'pr', ref: 'feat/same-thing', number: 12, title: 'Same feature', url: 'https://github.com/someone/proj/pull/12', n: 3, files: ['src/a.js'] }];
  const html = renderTab('lanes', { lanes: [{ name: 'feat', id: 'L-feat', state: 'active', data: {}, run, dwarf: null, kind_word: null, executor: 'fake', run_state: 'running', text: 'running fake for 1 min', project: 'k', overlap: c.lanes.feat.overlaps }] }, {});
  assert.match(html, /<a [^>]*href="https:\/\/github\.com\/someone\/proj\/pull\/12"[^>]*>[^<]*overlaps upstream: PR #12 \(3 files\)/);
  // the lane stops: the row leaves
  record(f.state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { outcome: 'done', exit: 0 } });
  const rows = digest(f.state, project, { dlv: [], ready: [], evalAfter: () => ({ met: true }) }).sections.overlap ?? [];
  assert.deepEqual(rows, [], 'an ended lane has no overlap row');
  // off: no refresh, no row
  const run2 = startLane(f.state, f.wt);
  const off = { ...project, policy: { overlap: { enabled: false } } };
  assert.equal(overlapOn(off.policy), false);
  assert.equal(projectOverlap(off, { gh }), null, 'off: nothing fetched');
  assert.equal(digest(f.state, off, { dlv: [], ready: [], evalAfter: () => ({ met: true }) }).sections.overlap, undefined, 'off: no digest section');
  assert.ok(run2);
});

test('githubRepo: https / ssh / scp forms; anything else null', () => {
  assert.equal(githubRepo('https://github.com/lombasto/norn.git'), 'lombasto/norn');
  assert.equal(githubRepo('https://github.com/lombasto/norn'), 'lombasto/norn');
  assert.equal(githubRepo('git@github.com:lombasto/norn-public.git'), 'lombasto/norn-public');
  assert.equal(githubRepo('ssh://git@github.com/a/b.git'), 'a/b');
  assert.equal(githubRepo('https://gitlab.com/a/b.git'), null);
  assert.equal(githubRepo('C:/x/origin.git'), null);
  assert.equal(githubRepo(null), null);
});

test('norn overlap --project: refreshes and prints each running lane\'s overlaps; policy off prints that it is off', () => {
  const f = fixture();
  startLane(f.state, f.wt);
  const pf = path.join(f.t, 'project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'k', title: 'k', root: fwd(f.home), ledger: '${root}/L.md', briefs_dir: '${root}', policy: { slop: { enabled: false } } }));
  const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
  const env = { ...ENV, META_ROOT: f.t, HOME: f.t, USERPROFILE: f.t, PATH: process.env.PATH };
  const r = spawnSync(process.execPath, [NORN, 'overlap', '--project', pf, '--state', f.state], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /feat: overlaps upstream: feat\/same-thing \(1 file\): src\/a\.js/);
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'k', title: 'k', root: fwd(f.home), ledger: '${root}/L.md', briefs_dir: '${root}', policy: { slop: { enabled: false }, overlap: { enabled: false } } }));
  const off = spawnSync(process.execPath, [NORN, 'overlap', '--project', pf, '--state', f.state], { encoding: 'utf8', env });
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /overlap check is off/);
});
