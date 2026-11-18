// RM-7 S2: a deliverable with a PR follows the PR to merged. Open PR = not merged, whatever git shows (no pushed-branch fallback); GitHub's
// merged = merged (the queue lets the next merge start, run / DLV conditions are met). gh is a fake: no network. Temp repos only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record, RecordError } from '../engine/lib/records.mjs';
import { deliverablesView, loadDeliverables, formatDeliverable } from '../engine/lib/deliverables.mjs';
import { prOf, prVerdict, readPr, syncPrStates } from '../engine/lib/prstate.mjs';
import { mergeQueue } from '../engine/lib/mergeq.mjs';
import { makeEval } from '../engine/lib/after.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

const tmp = p => mkTmp('meta-prs-' + p + '-');
test.after(cleanTmp);
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => { fs.writeFileSync(path.join(repo, file), text); g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); };
const NOW = Date.parse('2026-11-08T12:00:00Z');
const at = h => new Date(NOW + h * 3600e3);
const URL = 'https://github.com/o/r/pull/7';

// main + fix/b (one docs commit, pushed as origin/fix/b); one deliverable on fix/b, its run DONE with head = the branch tip
function setup() {
  const repo = tmp('repo'), state = tmp('state');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'README.md', 'r\n', 'init');
  g(repo, 'checkout', '-q', '-b', 'fix/b');
  const b = commit(repo, 'b.md', 'b\n', 'fix(b): docs b');
  g(repo, 'checkout', '-q', 'main');
  g(repo, 'update-ref', 'refs/remotes/origin/fix/b', b);
  const p = { name: 't', root: repo, state, lane_defaults: {}, deliverables: {} };
  const id = record(state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo, branch: 'fix/b', delivers: 'docs b', done_utc: at(-30).toISOString(), tip: b, lane: 'b', run: 'RUN-1' } }, { now: () => at(-30), views: false }).id;
  const ev = (e, data, h) => record(state, { kind: 'deliverable', ev: e, id, by: 'launcher', data }, { now: () => at(h), views: false });
  const row = () => deliverablesView({ stateDir: state, project: p, now: NOW }).rows[0];
  return { repo, state, p, id, b, ev, row, item: () => loadDeliverables(state)[id] };
}
const fakeGh = answers => { const calls = []; const gh = args => { calls.push(args); const a = answers[args[2]]; return typeof a === 'function' ? a() : a; }; gh.calls = calls; return gh; };
const view = (state, json) => ({ code: 0, out: JSON.stringify(json), err: '' });

test('readPr: gh pr view --json state,mergedAt -> open | merged (+ time) | closed; a failed or odd answer is an error, never a state', () => {
  const gh = fakeGh({ [URL]: view(null, { state: 'MERGED', mergedAt: '2026-11-08T10:00:00Z' }), 'u2': view(null, { state: 'OPEN', mergedAt: null }),
    'u3': view(null, { state: 'CLOSED', mergedAt: null }), 'u4': { code: 1, out: '', err: 'HTTP 401' }, 'u5': { code: 0, out: 'not json', err: '' }, 'u6': view(null, { state: 'DRAFT' }) });
  assert.deepEqual(readPr(URL, gh), { state: 'merged', merged_at: '2026-11-08T10:00:00Z' });
  assert.deepEqual(gh.calls[0], ['pr', 'view', URL, '--json', 'state,mergedAt']);
  assert.deepEqual(readPr('u2', gh), { state: 'open', merged_at: null });
  assert.deepEqual(readPr('u3', gh), { state: 'closed', merged_at: null });
  for (const u of ['u4', 'u5', 'u6']) assert.ok(readPr(u, gh).error, u);
});

test('an open PR holds the deliverable not merged even when git sees the work on main; GitHub merged makes it merged', () => {
  const s = setup();
  s.ev('pr', { url: URL, number: 7, repo: 'o/r', head: 'fix/b', base: 'main' }, -2);
  g(s.repo, 'merge', '-q', '--no-ff', '-m', 'merge b', 'fix/b');   // the work is on local main (a test merge, a hand merge): not the PR
  let r = s.row();
  assert.equal(r.state, 'done', 'the PR is open: not merged');
  assert.deepEqual(r.pr, { url: URL, number: 7, state: 'open', merged_at: null });
  assert.equal(r.due, false, 'the open PR is the ask: no merge / park question');
  assert.match(formatDeliverable(r), /fix\/b +PR #7 open \| +clean \| docs b$/);
  assert.equal(prVerdict(s.item()), 'held');
  s.ev('pr-state', { url: URL, number: 7, state: 'merged', merged_at: at(-1).toISOString() }, -1);
  r = s.row();
  assert.equal(r.state, 'merged'); assert.equal(r.pr.state, 'merged');
});

test('GitHub merged counts with no git evidence (a squash on GitHub, origin not fetched); closed unmerged never counts', () => {
  const s = setup();
  s.ev('pr', { url: URL, number: 7, repo: 'o/r', head: 'fix/b', base: 'main' }, -2);
  s.ev('pr-state', { url: URL, number: 7, state: 'closed', merged_at: null }, -1.5);
  assert.equal(s.row().state, 'done');
  assert.equal(prVerdict(s.item()), 'held');
  s.ev('pr', { url: 'https://github.com/o/r/pull/9', number: 9, repo: 'o/r', head: 'fix/b', base: 'main' }, -1.2);   // a new PR: open again
  const p9 = prOf(s.item());
  assert.deepEqual({ ...p9, at: Date.parse(p9.at) }, { url: 'https://github.com/o/r/pull/9', number: 9, state: 'open', merged_at: null, at: at(-1.2).getTime() });
  s.ev('pr-state', { url: 'https://github.com/o/r/pull/9', number: 9, state: 'merged', merged_at: at(-1).toISOString() }, -1);
  assert.equal(s.row().state, 'merged');
});

test('a DONE round after the PR merged is not covered by it: git decides that round', () => {
  const s = setup();
  s.ev('pr', { url: URL, number: 7, repo: 'o/r', head: 'fix/b', base: 'main' }, -3);
  s.ev('pr-state', { url: URL, number: 7, state: 'merged', merged_at: at(-2).toISOString() }, -2);
  assert.equal(s.row().state, 'merged');
  g(s.repo, 'checkout', '-q', 'fix/b'); const b2 = commit(s.repo, 'c.md', 'c\n', 'fix(b): round 2'); g(s.repo, 'checkout', '-q', 'main');
  s.ev('done', { run: 'RUN-2', tip: b2, done_utc: at(-1).toISOString() }, -1);
  assert.equal(prVerdict(s.item()), null);
  assert.equal(s.row().state, 'done', 'round 2 is on no main');
});

test('syncPrStates: reads only open PRs, records a change once, leaves an open or unreadable PR as it is; dry writes nothing', () => {
  const s = setup();
  assert.deepEqual(syncPrStates(s.state, { gh: fakeGh({}) }), [], 'no PR: no gh call');
  s.ev('pr', { url: URL, number: 7, repo: 'o/r', head: 'fix/b', base: 'main' }, -2);
  let answer = view(null, { state: 'OPEN', mergedAt: null });
  const gh = fakeGh({ [URL]: () => answer });
  assert.deepEqual(syncPrStates(s.state, { gh }), []);
  answer = { code: 1, out: '', err: 'gh: not logged in' };
  const e = syncPrStates(s.state, { gh });
  assert.equal(e.length, 1); assert.match(e[0].error, /not logged in/);
  assert.equal(s.row().state, 'done', 'an unreadable PR stays open: no fallback');
  answer = view(null, { state: 'MERGED', mergedAt: '2026-11-08T11:00:00Z' });
  assert.deepEqual(syncPrStates(s.state, { gh, dry: true }), [{ id: s.id, url: URL, state: 'merged', merged_at: '2026-11-08T11:00:00Z' }]);
  assert.equal(s.row().state, 'done', 'dry: nothing written');
  syncPrStates(s.state, { gh });
  assert.equal(s.row().state, 'merged');
  const n = gh.calls.length;
  assert.deepEqual(syncPrStates(s.state, { gh }), []); assert.equal(gh.calls.length, n, 'a merged PR is not read again');
  assert.equal(s.item().history.filter(h => h.ev === 'pr-state').length, 1);
});

test('the merge queue: an open PR waits for the owner (awaiting, not a row); merged on GitHub it leaves the queue', () => {
  const s = setup();
  assert.deepEqual(mergeQueue({ stateDir: s.state, project: s.p, now: NOW }).rows.map(r => r.id), [s.id]);
  s.ev('pr', { url: URL, number: 7, repo: 'o/r', head: 'fix/b', base: 'main' }, -2);
  let q = mergeQueue({ stateDir: s.state, project: s.p, now: NOW });
  assert.deepEqual(q.rows, []); assert.deepEqual(q.awaiting.map(r => r.id), [s.id]);
  s.ev('pr-state', { url: URL, number: 7, state: 'merged', merged_at: at(-1).toISOString() }, -1);
  q = mergeQueue({ stateDir: s.state, project: s.p, now: NOW });
  assert.deepEqual(q.rows, []); assert.deepEqual(q.awaiting, []);
});

test('a dlv condition: held while the PR is open (even with the work on main), met once GitHub merged it', () => {
  const s = setup();
  s.ev('pr', { url: URL, number: 7, repo: 'o/r', head: 'fix/b', base: 'main' }, -2);
  g(s.repo, 'merge', '-q', '--no-ff', '-m', 'merge b', 'fix/b');
  const dlv = () => makeEval(s.state)({ kind: 'dlv', id: s.id });
  assert.deepEqual(dlv(), { met: false, gone: null });
  s.ev('pr-state', { url: URL, number: 7, state: 'merged', merged_at: at(-1).toISOString() }, -1);
  assert.deepEqual(dlv(), { met: true, gone: null });
});

test('records: pr-state needs the url and a state open | merged | closed', () => {
  const s = setup();
  assert.throws(() => s.ev('pr-state', { url: URL, state: 'approved' }, -1), RecordError);
  assert.throws(() => s.ev('pr-state', { state: 'merged' }, -1), RecordError);
});
