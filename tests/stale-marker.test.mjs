// A lane's NOTES reused by a later run: the old "## DONE" made a run that wrote nothing end DONE (a second fixer on docs-fixer "drafted"
// nothing and still counted). Only an end marker written during the run counts; an older one = no-marker. FAKE executor, temp dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { runEnded } from './helpers/wait.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const meta = args => {
  const r = spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROLE: '', META_PROJECT: '', META_STATE: '', META_NO_TICK: '1' } });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
function sandbox(writes) {
  const t = mkTmp('meta-stale-marker-'), d = { state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), notes: path.join(t, 'NOTES.md'), other: path.join(t, 'OTHER.md') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  fs.writeFileSync(d.notes, '# an earlier run\n\n## DONE\n');
  const old = new Date(Date.now() - 3600e3); fs.utimesSync(d.notes, old, old);
  d.brief = path.join(t, 'brief.md');
  fs.writeFileSync(d.brief, `mode: done\nwrites: ${(writes === 'other' ? d.other : d.notes).replace(/\\/g, '/')}\n`);
  d.run = () => meta(['run', '--executor', 'fake', '--lane', 'fixer', '--brief', d.brief, '--notes', d.notes, '--worktree', d.wt, '--state', d.state, '--locks', d.locks, '--no-tick']);
  return d;
}

test('a run that never writes its NOTES does not inherit the old ## DONE: no-marker', async () => {
  const d = sandbox('other'), r = d.run();
  assert.equal(r.code, 0, r.err);
  const id = r.out.match(/RUN-\d+/)[0];
  await runEnded(d.state, id);
  assert.equal(loadState(d.state).items[id].end.outcome, 'no-marker');
});

test('a run that appends its own ## DONE to the same NOTES ends done', async () => {
  const d = sandbox('notes'), r = d.run();
  assert.equal(r.code, 0, r.err);
  const id = r.out.match(/RUN-\d+/)[0];
  await runEnded(d.state, id);
  assert.equal(loadState(d.state).items[id].end.outcome, 'done');
});
