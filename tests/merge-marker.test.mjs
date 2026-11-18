// META-MERGE-MARKER R1 (DEC-275 / DEC-285 / DEC-287): a MERGE run launched without --notes read the lane default NOTES while its
// worker wrote `## DONE` into the file its merge brief names (merge-brief --notes) -> no-marker although the merge landed (the outcome is the run result now: gap #3).
// The ONE home of a MERGE brief's notes path is the brief (its meta-merge marker). FAKE executor only, temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderMergeBrief, briefMarker } from '../engine/lib/mergebrief.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { runEnded } from './helpers/wait.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const fwd = p => String(p).replace(/\\/g, '/');
const meta = args => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1' } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

function sandbox() {
  const t = mkTmp('meta-merge-marker-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), main: path.join(t, 'main'), wt: path.join(t, 'wt'), x: path.join(t, 'reviews', 'P2-MERGE-NOTES.md') };
  for (const k of ['state', 'locks', 'main', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  fs.mkdirSync(path.dirname(d.x), { recursive: true });
  // GAP-6: the main checkout is a git repo with a main branch - the MERGE run's own merge worktree is made from it under the state dir
  const genv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const a of [['init', '-q', '-b', 'main'], ['commit', '-q', '--allow-empty', '-m', 'init']]) assert.equal(spawnSync('git', ['-C', d.main, ...a], { env: genv, windowsHide: true }).status, 0);
  const P = { name: 'demo', root: fwd(d.main), meta: '/h/dev/sdd-codex', state: fwd(d.state), deliverables: { main: 'main' }, policy: {} };
  // the staged merge brief names X; the fake worker writes its NOTES there, as a live merge worker does (`writes:`)
  d.brief = path.join(t, 'merge.md');
  fs.writeFileSync(d.brief, renderMergeBrief(P, { lane: 'tend', branch: 'feat/tend', worktree: fwd(d.wt), notes: fwd(d.x), sha: 'abcdef1' }) + `mode: done\nwrites: ${fwd(d.x)}\n`);
  d.run = (...more) => meta(['run', '--executor', 'fake', '--lane', 'tend', '--stage', 'MERGE', '--brief', d.brief, '--worktree', d.wt, '--state', d.state, '--locks', d.locks, '--no-tick', ...more]);
  d.item = id => loadState(d.state).items[id];
  return d;
}

test('merge-brief records its notes path in the meta-merge marker', () => {
  const d = sandbox();
  assert.equal(briefMarker(fs.readFileSync(d.brief, 'utf8')).notes, fwd(d.x));
});

test('norn run --stage MERGE without --notes: the run records the notes file its brief names (its log); its outcome is its result', async () => {
  const d = sandbox();
  const r = d.run();
  assert.equal(r.code, 0, r.err);
  const id = r.out.match(/RUN-\d+/)[0];
  await runEnded(d.state, id);
  assert.equal(fwd(d.item(id).data.notes), fwd(d.x), 'the run\'s notes = the brief\'s');
  assert.match(fs.readFileSync(d.x, 'utf8'), /work: done/, 'the worker logged there');
  assert.equal(d.item(id).end.outcome, 'done'); assert.equal(d.item(id).end.outcome_source, 'result');
});

test('norn run --stage MERGE --notes Y with a brief naming X refuses (exit 2): one home for the path', async () => {
  const d = sandbox();
  const r = d.run('--notes', path.join(d.t, 'NOTES.md'));
  assert.equal(r.code, 2);
  assert.match(r.err, /names notes .*P2-MERGE-NOTES\.md/);
  const ok = d.run('--notes', d.x);
  assert.equal(ok.code, 0, ok.err);
  return runEnded(d.state, ok.out.match(/RUN-\d+/)[0]);
});
