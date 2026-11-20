// WORK-SIZING S1 (RM-25): the size of a session from its transcript (floor, first real edit, peak, commits), the verdict on a lane
// stage against the marks each session RAN under (never today's policy), the marks on a run's start record and `norn size`.
// FAKE executor, temp dirs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sizeOfRun, stageSizes, verdict, sizingThresholds } from '../engine/lib/sizing.mjs';
import { startRun } from '../engine/lib/runs.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { POLICY_DEFAULTS, SETTINGS, sectionOf } from '../engine/lib/policy.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 30000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
const U = c => ({ input_tokens: 4, cache_read_input_tokens: c - 1004, cache_creation_input_tokens: 1000, output_tokens: 50 });
// one request: its context + the tool uses it made ([name, input]); side = a sidechain line (not the main chain)
const req = (i, c, tools = [], side = false) => JSON.stringify({ type: 'assistant', isSidechain: side, timestamp: new Date(Date.parse('2026-11-18T10:00:00Z') + i * 60000).toISOString(),
  requestId: `req-${i}`, message: { id: `msg-${i}`, role: 'assistant', usage: U(c),
    content: tools.length ? tools.map(([name, input], k) => ({ type: 'tool_use', id: `tu-${i}-${k}`, name, input })) : [{ type: 'text', text: 'x' }] } });
const write = (file, rows) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rows.join('\n') + '\n'); return file; };

test('sizeOfRun: floor, first real edit (not the notes folder, not a hand-off file; a git commit is one), peak, end, commits', () => {
  const t = mkTmp('norn-size-'), notes = path.join(t, 'notes', 'lane'), wt = path.join(t, 'wt');
  const f = write(path.join(t, 'p', 'x', 's.jsonl'), [
    req(0, 39000, [['Read', { file_path: path.join(wt, 'brief.md') }]]),
    req(1, 50000, [['Write', { file_path: path.join(notes, 'NOTES.md') }]]),
    req(2, 60000, [['Write', { file_path: path.join(wt, 'HANDOFF-1.md') }]]),
    req(3, 70000, [['Bash', { command: 'cat src/a.mjs' }]]),
    req(4, 999000, [['Edit', { file_path: path.join(wt, 'src', 'side.mjs') }]], true),   // a subagent's sidechain line: not this session
    req(5, 74000, [['Bash', { command: 'git add src/a.mjs && git commit -m "fix(a): b"' }]]),
    req(6, 90000, [['Edit', { file_path: path.join(wt, 'src', 'a.mjs') }]]),
    req(7, 95000, [['PowerShell', { command: 'git -C x commit -m "c"' }]]),
    req(8, 88000)]);
  assert.deepEqual(sizeOfRun(f, { notesDir: notes }), { floor: 39000, first_edit: 74000, peak: 95000, end: 88000, requests: 8, commits: 2 });
  const g = write(path.join(t, 'p', 'x', 'e.jsonl'), [req(0, 30000), req(1, 41000, [['Write', { file_path: path.join(notes, 'NOTES.md') }]]), req(2, 52000, [['Edit', { file_path: path.join(wt, 'b.mjs') }]])]);
  assert.equal(sizeOfRun(g, { notesDir: notes }).first_edit, 52000, 'the first Edit outside the notes folder');
  const h = write(path.join(t, 'p', 'x', 'n.jsonl'), [req(0, 30000), req(1, 41000, [['Write', { file_path: path.join(t, 'handoff.md') }]])]);
  assert.deepEqual(sizeOfRun(h, { notesDir: notes }), { floor: 30000, first_edit: null, peak: 41000, end: 41000, requests: 2, commits: 0 });
  assert.equal(sizeOfRun(path.join(t, 'none.jsonl')), null);
});

const M = (no_new_step_k, handoff_k, hard_max_k = handoff_k + 50) => ({ role: 'implementer', no_new_step_k, handoff_k, hard_max_k, src: 'role' });
const S = (run, outcome, size, marks = M(110, 130)) => ({ run, outcome, live: false, size: { floor: 39000, first_edit: null, peak: 0, end: 0, requests: 20, commits: 1, ...size }, marks, orders: [] });

test('verdict: thrashing, tight, fits, loose, none - each against the marks the session ran under', () => {
  const th = sizingThresholds({});
  assert.deepEqual(th, { thrash_startup_pct: 60, loose_pct: 40 });
  const thr = verdict(['RUN-1', 'RUN-2', 'RUN-3'].map(r => S(r, 'handoff', { first_edit: 85800, peak: 112000 })), th);
  assert.equal(thr.code, 'thrashing');
  assert.match(thr.words, /78 %/); assert.match(thr.words, /floor 39k/); assert.match(thr.words, /first edit 86k/); assert.match(thr.words, /mark 110k/);
  assert.equal(verdict([S('RUN-1', 'handoff', { first_edit: 30000, commits: 0 }), S('RUN-2', 'handoff', { first_edit: 30000 })], th).code, 'thrashing', 'a hand-off without a commit');
  const tight = verdict([S('RUN-1', 'handoff', { first_edit: 44000, peak: 131000, commits: 4 }), S('RUN-2', 'done', { peak: 60000 })], th);
  assert.equal(tight.code, 'tight'); assert.equal(tight.words, 'tight: one hand-off at 131k after 4 commits');
  const fits = verdict([S('RUN-1', 'done', { peak: 0.47 * 130000 })], th);
  assert.equal(fits.code, 'fits'); assert.equal(fits.words, 'limit fits: peak 61k of 130k');
  const loose = verdict([S('RUN-1', 'done', { peak: 39000 }), S('RUN-2', 'done', { peak: 90000 }, M(270, 300))], th);
  assert.equal(loose.code, 'loose', 'each against its own hand-off mark: 30 % and 30 %');
  assert.equal(loose.words, 'never above 30 %: the mark could be lower');
  assert.equal(verdict([S('RUN-1', 'done', { peak: 90000 })], th).code, 'fits', '90k of 130k: the same peak under smaller marks fits');
  const old = verdict([S('RUN-1', 'handoff', { first_edit: 85800 }, null), S('RUN-2', 'handoff', { first_edit: 85800 }, null)], th);
  assert.equal(old.code, 'none'); assert.equal(old.words, 'marks not recorded', 'a run started before S1 never borrows today\'s policy');
  assert.equal(verdict([], th).code, 'none');
  assert.equal(verdict([{ ...S('RUN-1', 'running', { peak: 90000 }), live: true }], th).words, 'not measured yet', 'a live session is not judged');
  assert.equal(verdict(['RUN-1', 'RUN-2'].map(r => S(r, 'handoff', { first_edit: 85800 })), { thrash_startup_pct: 80 }).code, 'tight', 'the threshold is the policy\'s');
});

test('policy: sizing defaults, two Settings rows under Agents & context', () => {
  assert.deepEqual(POLICY_DEFAULTS.sizing, { thrash_startup_pct: 60, loose_pct: 40 });
  const rows = SETTINGS.filter(s => s.key.startsWith('policy.sizing.'));
  assert.deepEqual(rows.map(s => [s.key, s.min, s.max]), [['policy.sizing.thrash_startup_pct', 30, 95], ['policy.sizing.loose_pct', 5, 90]]);
  for (const s of rows) assert.deepEqual(sectionOf(s), ['agents', 'context', 'sizing']);
  assert.deepEqual(sizingThresholds({ sizing: { loose_pct: 25 } }), { thrash_startup_pct: 60, loose_pct: 25 });
});

test('fake run: the start record keeps the marks it launched under after the policy changes; the end record its size; norn size --lane --json', async () => {
  const t = mkTmp('norn-size-'), state = path.join(t, 'state', 'demo'), locks = path.join(t, 'state', 'locks'), wt = path.join(t, 'wt'), notes = path.join(t, 'NOTES.md');
  const projects = path.join(t, 'projects');
  for (const d of [state, locks, wt]) fs.mkdirSync(d, { recursive: true });
  const pf = path.join(t, 'project.json'), proj = context => fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'demo', title: 'Demo', root: t.replace(/\\/g, '/'), policy: { context } }));
  proj({ implementer: { no_new_step_k: 170, handoff_k: 200, hard_max_k: 220 } });
  const brief = path.join(t, 'brief.md');
  fs.writeFileSync(brief, `mode: done\nms: 1500\nctx_dir: ${path.join(projects, 'C--wt')}\nctx_steps: 40000,95000,80000\nctx_ms: 100\n`);
  const r = startRun({ state, locksDir: locks, executor: 'fake', lane: 'demo', stage: 'S1', worktree: wt, notes, hbMs: 100, staleMs: 3000, projectsDir: projects, ctx_from: pf,
    policy: { trigger_on_exit: false }, budget: {}, brief });
  const row = { role: 'implementer', no_new_step_k: 170, handoff_k: 200, hard_max_k: 220, src: 'role' };
  assert.deepEqual(loadState(state).items[r.run].data.ctx_marks, row, 'the role row of the policy at launch');
  proj({ implementer: { no_new_step_k: 30, handoff_k: 40, hard_max_k: 300 } });
  const end = await waitFor(() => { const it = loadState(state).items[r.run]; return settled(it) && it.history.find(h => h.ev === 'end'); });
  assert.equal(end.data.outcome, 'done');
  assert.deepEqual(loadState(state).items[r.run].data.ctx_marks, row, 'still the launch marks after the policy file changed');
  assert.deepEqual(end.data.ctx, { floor: 40000, first_edit: null, peak: 95000, end: 80000, requests: 3, commits: 0 });
  const s = stageSizes(state, { lane: 'demo' }, { projectsDir: projects });
  assert.equal(s.stage, 'S1'); assert.deepEqual(s.sessions.map(x => [x.run, x.outcome]), [[r.run, 'done']]);
  const cli = spawnSync(process.execPath, [META, 'size', '--lane', 'demo', '--json', '--state', state], { encoding: 'utf8', timeout: 60000 });
  assert.equal(cli.status, 0, cli.stderr);
  const j = JSON.parse(cli.stdout);
  assert.equal(j.lane, 'demo'); assert.equal(j.stage, 'S1');
  assert.deepEqual(j.sessions[0].marks, row); assert.deepEqual(j.sessions[0].size, end.data.ctx);
  assert.deepEqual([j.verdict.code, j.verdict.words], ['fits', 'limit fits: peak 95k of 200k'], 'judged on the launch marks (95k of 40k would be a hand-off)');
  const txt = spawnSync(process.execPath, [META, 'size', r.run, '--state', state], { encoding: 'utf8', timeout: 60000 });
  assert.equal(txt.status, 0, txt.stderr);
  assert.match(txt.stdout, new RegExp(`- ${r.run} done: floor 40k, first edit -, peak 95k; marks 170/200/220k; orders none; commits 0`));
  assert.match(txt.stdout, /^verdict: limit fits: peak 95k of 200k$/m);
  assert.equal(spawnSync(process.execPath, [META, 'size', '--state', state], { encoding: 'utf8', timeout: 60000 }).status, 2, 'a run or a lane is required');
});

test('a launch with no project.json (a check-in, RUN-188) starts and records the default marks of its role', async () => {
  const t = mkTmp('norn-size-'), state = path.join(t, 'state', 'demo'), locks = path.join(t, 'state', 'locks'), wt = path.join(t, 'wt');
  for (const d of [state, locks, wt]) fs.mkdirSync(d, { recursive: true });
  const brief = path.join(t, 'brief.md');
  fs.writeFileSync(brief, 'mode: done\nms: 300\n');
  const r = startRun({ state, locksDir: locks, executor: 'fake', lane: 'demo', kind: 'checkin', worktree: wt, hbMs: 100, staleMs: 3000, ctx_from: path.join(t, 'project.json'),
    policy: { trigger_on_exit: false }, budget: {}, brief });
  assert.deepEqual(loadState(state).items[r.run].data.ctx_marks, { role: 'checkin', ...POLICY_DEFAULTS.context.checkin, src: 'role' });
  const end = await waitFor(() => { const it = loadState(state).items[r.run]; return settled(it) && it.history.find(h => h.ev === 'end'); });
  assert.equal(end.data.outcome, 'done');
});
