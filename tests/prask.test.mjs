// RM-7 S3: a deliverable's PR closed without a merge, or open past policy.pr.stuck_h, asks the owner ONE question on that deliverable
// (reopen / re-run merge-land, park, or drop), through the `deliverables ask` path; a closed PR's row leaves the merge queue. Temp repos only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { record, fold, readEvents, recordsFile, RecordError } from '../engine/lib/records.mjs';
import { deliverablesView, askDeliverable, askPrQuestions, closeLandedQuestions, formatDeliverable, prStuckH, PR_STUCK_H } from '../engine/lib/deliverables.mjs';
import { mergeQueue } from '../engine/lib/mergeq.mjs';
import { main as nornMain } from '../engine/bin/norn.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

const tmp = p => mkTmp('meta-prask-' + p + '-');
test.after(cleanTmp);
const GENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: GENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text, msg) => { fs.writeFileSync(path.join(repo, file), text); g(repo, 'add', file); g(repo, 'commit', '-q', '-m', msg); return g(repo, 'rev-parse', 'HEAD'); };
const NOW = Date.parse('2026-11-08T12:00:00Z');
const at = h => new Date(NOW + h * 3600e3);
const URL = 'https://github.com/o/r/pull/7';
const fwd = p => p.replace(/\\/g, '/');

// main + fix/b (pushed as origin/fix/b); one deliverable on fix/b, DONE 30 h ago. policy: the project's policy block
function setup(policy = {}) {
  const repo = tmp('repo'), state = tmp('state');
  g(repo, 'init', '-q', '-b', 'main'); g(repo, 'config', 'commit.gpgsign', 'false');
  commit(repo, 'README.md', 'r\n', 'init');
  g(repo, 'checkout', '-q', '-b', 'fix/b');
  const b = commit(repo, 'b.md', 'b\n', 'fix(b): docs b');
  g(repo, 'checkout', '-q', 'main');
  g(repo, 'update-ref', 'refs/remotes/origin/fix/b', b);
  const p = { name: 't', root: repo, state, lane_defaults: {}, deliverables: {}, policy };
  const id = record(state, { kind: 'deliverable', ev: 'create', by: 'controller', data: { repo, branch: 'fix/b', delivers: 'docs b', done_utc: at(-30).toISOString(), tip: b, lane: 'b', run: 'RUN-1' } }, { now: () => at(-30), views: false }).id;
  const ev = (e, data, h, by = 'launcher') => record(state, { kind: 'deliverable', ev: e, id, by, data }, { now: () => at(h), views: false });
  const row = (now = NOW) => deliverablesView({ stateDir: state, project: p, now }).rows[0];
  const ask = (h = 0) => askPrQuestions(state, { project: p, now: () => at(h), nowMs: NOW + h * 3600e3 });
  const qs = () => Object.values(fold(readEvents(recordsFile(state, 'question'))).items).filter(q => q.kind === 'question');
  const mq = () => mergeQueue({ stateDir: state, project: p, now: NOW });
  return { repo, state, p, id, ev, row, ask, qs, mq };
}
const pr = (s, h, url = URL, number = 7) => s.ev('pr', { url, number, repo: 'o/r', head: 'fix/b', base: 'main' }, h);

test('a PR closed without a merge: ONE reopen / park / drop question on the deliverable, at once; the row leaves the merge queue', () => {
  const s = setup();
  pr(s, -2);
  s.ev('pr-state', { url: URL, number: 7, state: 'closed', merged_at: null }, -1);
  const r = s.row();
  assert.equal(r.state, 'done'); assert.equal(r.due, true, 'closed: due at once');
  let q = s.mq();
  assert.deepEqual(q.rows, [], 'no merge retries it'); assert.deepEqual(q.awaiting, []);
  assert.deepEqual(q.held.map(h => h.id), [s.id]); assert.match(q.held[0].why, /^PR #7 closed without a merge: the owner is asked/);
  const a = s.ask();
  assert.equal(a.length, 1); assert.match(a[0].q, /^Q-\d+$/);
  const [Q] = s.qs();
  assert.equal(Q.id, a[0].q); assert.equal(Q.state, 'open'); assert.equal(Q.data.deliverable, s.id);
  assert.match(Q.data.title, /^DLV-1 fix\/b: PR #7 closed without a merge - reopen, park or drop\?$/);
  assert.deepEqual(Q.data.options.map(o => o.key), ['reopen', 'park', 'drop']);
  assert.match(Q.data.options[0].text, /norn merge-land --branch fix\/b/);
  assert.match(Q.data.options[2].text, /norn deliverables drop DLV-1 --why/);
  assert.equal(Q.data.recommend.key, 'reopen'); assert.ok(Q.data.body.includes(URL));
  // the next ticks ask nothing more; a direct ask is refused
  assert.deepEqual(s.ask(0.5), []); assert.deepEqual(s.ask(30), []);
  assert.equal(s.qs().length, 1, 'exactly one question');
  assert.match(askDeliverable(s.state, s.id, { project: s.p, nowMs: NOW }).refused, /already asked Q-/);
  assert.match(s.mq().held[0].why, new RegExp(`asked ${Q.id}`));
  assert.match(formatDeliverable(s.row()), /PR #7 closed \| asked Q-\d+ \|/);
  // the open question does not go stale while the deliverable is still unmerged
  assert.deepEqual(closeLandedQuestions(s.state, { project: s.p, nowMs: NOW }), []);
});

test('a PR open past policy.pr.stuck_h (default 72 h): ONE question; younger, or the key 0, asks nothing; the row stays awaiting', () => {
  assert.equal(PR_STUCK_H, 72); assert.equal(prStuckH({}), 72); assert.equal(prStuckH({ pr: { stuck_h: 0 } }), 0); assert.equal(prStuckH({ pr: { stuck_h: 'x' } }), 72);
  const s = setup();
  pr(s, -2);
  assert.equal(s.row().pr.stuck, false); assert.equal(s.row().due, false, 'a young open PR is the ask itself');
  assert.deepEqual(s.ask(), []);
  assert.match(askDeliverable(s.state, s.id, { project: s.p, nowMs: NOW }).refused, /PR #7 is open: it waits for the owner on GitHub/);
  assert.equal(s.row(NOW + 70 * 3600e3).pr.stuck, false, '72 h not reached');
  const late = 74;   // 76 h after merge-land recorded the PR
  assert.equal(s.row(NOW + late * 3600e3).pr.stuck, true);
  const a = s.ask(late);
  assert.equal(a.length, 1);
  const [Q] = s.qs();
  assert.match(Q.data.title, /^DLV-1 fix\/b: PR #7 open 76 h - reopen, park or drop\?$/);
  assert.deepEqual(Q.data.options.map(o => o.key), ['reopen', 'park', 'drop']);
  assert.deepEqual(s.ask(late + 1), []); assert.equal(s.qs().length, 1, 'exactly one question');
  const q = mergeQueue({ stateDir: s.state, project: s.p, now: NOW + late * 3600e3 });
  assert.deepEqual(q.rows, []); assert.deepEqual(q.awaiting.map(r => r.id), [s.id], 'still open on GitHub: it waits for the owner there');
  assert.match(formatDeliverable(s.row(NOW + late * 3600e3)), /PR #7 open \(stuck\) \| asked Q-/);
  // a project's own threshold, and 0 = off
  const t = setup({ pr: { stuck_h: 10 } }); pr(t, -2);
  assert.equal(t.ask(9).length, 1, '11 h > 10 h');
  const off = setup({ pr: { stuck_h: 0 } }); pr(off, -2);
  assert.deepEqual(off.ask(1000), []); assert.equal(off.row(NOW + 1000 * 3600e3).due, false);
});

test('answers: a new PR (merge-land again) starts a new cycle and the row waits on it; drop ends the deliverable for good', () => {
  const s = setup();
  pr(s, -3);
  s.ev('pr-state', { url: URL, number: 7, state: 'closed', merged_at: null }, -2);
  s.ask(-1.5);
  assert.equal(s.qs().length, 1);
  // reopen: merge-land opens PR #9 -> open, awaiting, no question while young
  pr(s, -1, 'https://github.com/o/r/pull/9', 9);
  assert.equal(s.row().asked, null, 'a new PR: a new ask cycle'); assert.equal(s.row().due, false);
  assert.deepEqual(s.mq().awaiting.map(r => r.id), [s.id]); assert.deepEqual(s.mq().held, []);
  // #9 closed too: a second question, one for this PR
  s.ev('pr-state', { url: 'https://github.com/o/r/pull/9', number: 9, state: 'closed', merged_at: null }, -0.5);
  assert.equal(s.ask().length, 1); assert.deepEqual(s.ask(), []);
  assert.equal(s.qs().length, 2);
  // drop: terminal - out of the queue, at its end, never asked; the open question is withdrawn by the tick
  assert.throws(() => s.ev('drop', {}, -0.2, 'owner'), RecordError, 'drop needs a why');
  s.ev('drop', { why: 'not wanted' }, -0.2, 'owner');
  const r = s.row();
  assert.equal(r.record_state, 'dropped'); assert.equal(r.at_target, true); assert.equal(r.due, false); assert.equal(r.dropped.why, 'not wanted');
  assert.match(formatDeliverable(r), /dropped: not wanted/);
  const q = s.mq(); assert.deepEqual([q.rows, q.awaiting, q.held], [[], [], []]);
  assert.match(askDeliverable(s.state, s.id, { project: s.p, nowMs: NOW }).refused, /is dropped \(not wanted\)/);
  const w = closeLandedQuestions(s.state, { project: s.p, nowMs: NOW });
  assert.equal(w.length, 2, 'both PR questions (#7, #9) are withdrawn'); for (const x of w) assert.match(x.why, /is dropped: nothing left to ask/);
  assert.throws(() => s.ev('pr-state', { url: 'https://github.com/o/r/pull/9', number: 9, state: 'merged', merged_at: null }, 0), RecordError, 'dropped is terminal');
});

test('norn deliverables drop DLV-n --why W records the drop (needs a role and a DLV-n)', () => {
  const s = setup();
  const pf = path.join(tmp('pf'), 'project.json');
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 't', title: 't', root: fwd(s.repo), ledger: '${root}/L.md', briefs_dir: '${root}', policy: {} }));
  const cli = argv => { const out = [], err = []; let code; try { code = nornMain(['deliverables', ...argv, '--project', pf, '--state', s.state], { META_ROOT: fwd(path.dirname(s.state)) }, x => out.push(x), x => err.push(x)); } catch (e) { code = e; } return { code, out: out.join('\n'), err: err.join('\n') }; };
  assert.notEqual(cli(['drop', s.id, '--why', 'w']).code, 0, 'no role');
  const r = cli(['drop', s.id, '--why', 'not wanted', '--as', 'owner']);
  assert.equal(r.code, 0, r.out + r.err); assert.equal(r.out, `${s.id} dropped`);
  assert.equal(s.row().record_state, 'dropped');
});
