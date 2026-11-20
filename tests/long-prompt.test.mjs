// A long prompt never rides the command line (Windows caps one at 32 767 chars: `spawn ENAMETOOLONG`, solve-shack RUN-140): the
// harness hands it over on stdin, and the slop resume prompt summarises a big BLOCK list (the full list in a file it names).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildCommand, startRun } from '../engine/lib/runs.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { PROMPT_ARG_MAX } from '../engine/lib/harness/common.mjs';
import { slopPrompt } from '../engine/lib/slop/runend.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 30000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
const LONG = 'x'.repeat(45000) + ' THE END';

test('claude and fake: a short prompt stays on -p / --prompt; a long one leaves the command line and comes as the input', () => {
  const base = { exe: '/x/claude', brief: 'B', worktree: 'W', notes: 'N', model: 'm', effort: 'e', session_id: 'sid-1', lane: 'l' };
  const short = buildCommand({ ...base, executor: 'claude', promptText: 'NUDGE x' });
  assert.equal(short.args[short.args.indexOf('-p') + 1], 'NUDGE x'); assert.equal(short.input, undefined);
  for (const executor of ['claude', 'fake']) {
    const c = buildCommand({ ...base, executor, resumeSid: 'sid-1', promptText: LONG });
    assert.ok(c.args.every(a => a.length <= PROMPT_ARG_MAX), `${executor}: no argument carries the prompt`);
    assert.ok(c.args.join(' ').length < 20000, `${executor}: the command line stays short`);
    assert.equal(c.input, LONG, `${executor}: the whole prompt is the input`);
  }
  const c = buildCommand({ ...base, executor: 'claude', promptText: LONG });
  assert.equal(c.args[0], '-p'); assert.ok(c.args[1].startsWith('--'), 'claude -p reads the prompt from stdin');
});

test('a run whose prompt is over 40 000 chars starts and its executor receives the whole text (fake executor, on stdin)', async () => {
  const t = mkTmp('meta-longprompt-'), state = path.join(t, 'state', 'demo'), locks = path.join(t, 'state', 'locks'), wt = path.join(t, 'wt'), notes = path.join(t, 'NOTES.md');
  for (const d of [state, locks, wt]) fs.mkdirSync(d, { recursive: true });
  const b = path.join(t, 'brief.md');
  fs.writeFileSync(b, 'mode: done\nresumed_mode: done\n');
  const run = startRun({ state, locksDir: locks, executor: 'fake', lane: 'demo', worktree: wt, notes, brief: b, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0 }, budget: {}, tick: null, resumeSid: 'sid-old', promptText: LONG }).run;
  const it = await waitFor(() => { const x = loadState(state).items[run]; return settled(x) && x; });
  assert.equal(it.end?.error ?? null, null, 'no spawn error');
  assert.equal(it.end?.outcome, 'done');
  assert.ok(fs.readFileSync(notes, 'utf8').includes(`prompt: ${LONG}\n`), 'the executor got the whole prompt');
});

test('slop resume prompt: 5 000 BLOCK hits render in a few KB - per rule and file a count and the first lines, the full list in a named file', () => {
  const open = [];
  for (let i = 0; i < 5000; i++) open.push({ rule: 'K1', file: i < 4900 ? 'tests/fixtures/huge.txt' : `src/f${i % 7}.mjs`, line: i + 1, msg: 'trailing whitespace', fp: 'fp' + i });
  open.push({ rule: 'K14', file: 'src/a.mjs', line: 3, msg: 'a shim', fp: 'k14' });
  const p = slopPrompt(open, '/b/brief.md', { listFile: '/s/results/RUN-1/slop-blocks.md' });
  assert.ok(p.length < 4096, `prompt is ${p.length} chars`);
  assert.match(p, /5001 BLOCK finding/);
  assert.match(p, /K1 `tests\/fixtures\/huge\.txt`: 4900/);
  assert.match(p, /K14 `src\/a\.mjs`: 1/);
  assert.match(p, /K1 `tests\/fixtures\/huge\.txt:1` trailing whitespace/, 'the first lines are listed');
  assert.ok(!p.includes('huge.txt:4 '), 'not every line');
  assert.match(p, /\/s\/results\/RUN-1\/slop-blocks\.md/, 'names the full list');
  assert.match(p, /Your brief: \/b\/brief\.md/);
});
