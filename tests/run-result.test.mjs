// gap #3: a worker run's outcome is its own result (<state>/results/RUN-n/: result.json + HANDOFF.md, written by `norn done`; the
// supervisor passes the directory as META_RESULT_DIR) and nothing else: no result = no-result, whatever its NOTES say. The end
// records outcome_source result | exit | none. A hand-off carries its text; the auto-resume hands it to the next run. FAKE executor, temp dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState } from '../engine/lib/records.mjs';
import { makeResult, readResult, writeResult, resultDir, ResultError } from '../engine/lib/result.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { runEnded } from './helpers/wait.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const BASE_ENV = { META_ROLE: '', META_PROJECT: '', META_STATE: '', META_RUN_ID: '', META_RUN_STATE: '', META_RESULT: '', META_RESULT_DIR: '', META_NO_TICK: '1' };
const meta = (args, env = {}) => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...BASE_ENV, ...env } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
function sandbox(brief, { notes = null } = {}) {
  const t = mkTmp('meta-run-result-'), d = { state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  if (notes !== null) fs.writeFileSync(d.notes, notes);
  d.brief = path.join(t, 'brief.md');
  fs.writeFileSync(d.brief, brief);
  d.end = async () => {
    const r = meta(['run', '--executor', 'fake', '--lane', 'fixer', '--brief', d.brief, '--notes', d.notes, '--worktree', d.wt, '--state', d.state, '--locks', d.locks, '--no-tick']);
    assert.equal(r.code, 0, r.err);
    const id = r.out.match(/RUN-\d+/)[0];
    await runEnded(d.state, id);
    return { id, it: loadState(d.state).items[id], end: loadState(d.state).items[id].end };
  };
  return d;
}

test('makeResult / readResult: outcomes, the why of a stop, the text of a hand-off, the run it names, its age', () => {
  assert.deepEqual(makeResult({ run: 'RUN-3', at: 'T' }).record, { v: 1, run: 'RUN-3', outcome: 'done', at: 'T' });
  assert.throws(() => makeResult({ run: 'RUN-3', outcome: 'stopped' }), ResultError);
  assert.throws(() => makeResult({ run: 'RUN-3', outcome: 'handoff' }), /needs the hand-off text/);
  assert.throws(() => makeResult({ run: 'RUN-3', outcome: 'done', handoff: 'x' }), /for --outcome handoff only/);
  assert.throws(() => makeResult({ run: 'RUN-3', outcome: 'done', why: 'x' }), /--why is for --outcome stopped/);
  assert.throws(() => makeResult({ run: 'RUN-3', outcome: 'finished' }), /--outcome must be/);
  assert.throws(() => makeResult({ run: 'x' }), /RUN-n/);
  assert.equal(makeResult({ run: 'RUN-wsl-3' }).record.run, 'RUN-wsl-3', 'a node run (federation) ends itself too');
  const t = mkTmp('meta-run-result-'), dir = resultDir(t, 'RUN-4');
  assert.equal(readResult(dir, { run: 'RUN-4' }), null, 'absent');
  writeResult(dir, { run: 'RUN-4', outcome: 'stopped', why: ' the gate\n is red ', summary: 'tried twice' });
  const at = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')).at;
  assert.deepEqual(readResult(dir, { run: 'RUN-4', since: Date.now() - 60000 }), { outcome: 'stopped', why: 'the gate is red', summary: 'tried twice', at });
  assert.match(readResult(dir, { run: 'RUN-5' }).error, /names "RUN-4"/);
  assert.match(readResult(dir, { run: 'RUN-4', since: Date.now() + 60000 }).error, /before this run started/);
  writeResult(dir, { run: 'RUN-4', outcome: 'handoff', handoff: '# next\nstep 3' });
  assert.equal(fs.readFileSync(readResult(dir, { run: 'RUN-4' }).handoff, 'utf8'), '# next\nstep 3\n');
  fs.rmSync(path.join(dir, 'HANDOFF.md'));
  assert.match(readResult(dir, { run: 'RUN-4' }).error, /handoff without its HANDOFF\.md/);
  fs.writeFileSync(path.join(dir, 'result.json'), '{nope');
  assert.deepEqual(readResult(dir, { run: 'RUN-4' }), { error: 'not JSON' });
});

test('norn done: inside a run it writes META_RESULT_DIR; a hand-off from a file; a run ends itself only; a typo run / no state refuses (exit 2)', () => {
  const t = mkTmp('meta-run-result-'), state = path.join(t, 'state');
  fs.mkdirSync(path.join(state, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(state, 'runs', 'RUN-7.spec.json'), '{}');
  const hf = path.join(t, 'h.md'); fs.writeFileSync(hf, 'state: half way\nnext: step 4\n');
  const env = { META_RUN_ID: 'RUN-7', META_RUN_STATE: state, META_RESULT_DIR: resultDir(state, 'RUN-7') };
  const ok = meta(['done', '--outcome', 'handoff', '--handoff-file', hf, '--summary', 'half way'], env);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /RUN-7 HANDOFF -> .*results\/RUN-7\/result\.json \+ HANDOFF\.md/);
  const r = readResult(resultDir(state, 'RUN-7'), { run: 'RUN-7' });
  assert.equal(r.summary, 'half way');
  assert.equal(fs.readFileSync(r.handoff, 'utf8'), 'state: half way\nnext: step 4\n');
  assert.match(meta(['done', '--outcome', 'handoff'], env).err, /needs the hand-off text/);
  assert.match(meta(['done', '--outcome', 'handoff', '--handoff', 'a', '--handoff-file', hf], env).err, /give one/);
  assert.match(meta(['done', '--outcome', 'handoff', '--handoff-file', path.join(t, 'nope.md')], env).err, /--handoff-file .*ENOENT/);
  assert.match(meta(['done', '--run', 'RUN-8'], env).err, /a run ends itself only/);
  assert.match(meta(['done', '--outcome', 'stopped'], env).err, /needs --why/);
  const typo = meta(['done', '--run', 'RUN-9', '--state', state]);
  assert.equal(typo.code, 2); assert.match(typo.err, /RUN-9 is not a run of/);
  assert.match(meta(['done']).err, /no run/);
  const outside = meta(['done', '--run', 'RUN-7', '--state', state, '--outcome', 'stopped', '--why', 'by hand']);
  assert.equal(outside.code, 0, outside.err);
  assert.equal(readResult(resultDir(state, 'RUN-7'), { run: 'RUN-7' }).why, 'by hand');
  assert.match(meta(['done', '--help']).out, /^usage: norn done/);
});

test('the result is the outcome: a run that ends through the real norn done CLI ends done (source result); the end names its result', async () => {
  const d = sandbox('mode: done\ndone_via: cli\n');
  const { id, end } = await d.end();
  assert.equal(end.outcome, 'done');
  assert.equal(end.outcome_source, 'result');
  assert.equal(end.result, resultDir(d.state, id).split(path.sep).join('/'));
  assert.equal(end.marker_line, undefined, 'no marker line any more');
});

test('a stop carries its why; NOTES saying "## DONE" change nothing', async () => {
  const d = sandbox('mode: stopped\n', { notes: '# log\n\n## DONE\n' });
  const { end } = await d.end();
  assert.equal(end.outcome, 'stopped');
  assert.equal(end.why, 'c - fixture says so');
});

test('no result = no-result (source none), even when the NOTES end with ## DONE', async () => {
  const d = sandbox('mode: no-result\n', { notes: '# an earlier run\n\n## DONE\n' });
  const { end } = await d.end();
  assert.equal(end.outcome, 'no-result');
  assert.equal(end.outcome_source, 'none');
});

test('a hand-off: the end names HANDOFF.md and the auto-resume hands it to the next run (its prompt cites it)', async () => {
  const d = sandbox('mode: handoff-once\n');
  const { id, it, end } = await d.end();
  assert.equal(end.outcome, 'handoff');
  assert.ok(end.handoff.endsWith(`results/${id}/HANDOFF.md`), end.handoff);
  assert.equal(fs.readFileSync(end.handoff, 'utf8'), 'next: the fake step\n');
  const next = loadState(d.state).items[id].resume?.next;
  assert.ok(next, 'auto-resumed');
  await runEnded(d.state, next);
  const spec = JSON.parse(fs.readFileSync(path.join(d.state, 'runs', `${next}.spec.json`), 'utf8'));
  assert.equal(spec.handoffFile, end.handoff);
  assert.equal(loadState(d.state).items[next].end.outcome, 'done');
  assert.ok(it);
});

test('a crash is its exit (source exit), whatever result it wrote', async () => {
  const { end } = await sandbox('mode: crash\n').end();
  assert.equal(end.outcome, 'crash');
  assert.equal(end.outcome_source, 'exit');
});
