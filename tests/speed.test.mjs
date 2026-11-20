// worker-speed: a run's tok/s and wall split from its transcript, the workers running beside it, the CPU samples, the grouped summary
// and `norn speed` (engine/lib/speed.mjs), on a hand-made transcript whose timestamps give known numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { speedInit, onSpeed, speedOf, runSpeed, workersDuring, workerSpans, cpuDuring, speedReport, formatSpeed, speedWords, isWorker } from '../engine/lib/speed.mjs';
import { noteCpu, readCpu } from '../engine/lib/runs.mjs';
import { speedLine } from '../engine/dash/cells.mjs';
import { record } from '../engine/lib/records.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
test.after(cleanTmp);
const T0 = Date.parse('2026-11-19T10:00:00Z'), at = s => new Date(T0 + s * 1000).toISOString();
const usage = (out, ctx = 1000) => ({ input_tokens: 2, cache_read_input_tokens: ctx - 2, cache_creation_input_tokens: 0, output_tokens: out });
const asst = (s, mid, req, ref, content, out) => ({ type: 'assistant', timestamp: at(s), requestId: req, ...(ref ? { requestRef: ref } : {}), message: { id: mid, model: 'claude-opus-5-5', usage: usage(out), content } });
const result = (s, id) => ({ type: 'user', timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
// requests: 2 -> 7 s (200 out; a test command 7 -> 67 s), 68 -> 73 s (300 out; Read 73 -> 83 s), 84 -> 94 s (500 out), and one with no
// api-request line: from the user line before it, 120 -> 124 s (100 out). A synthetic line counts nothing.
const LINES = [
  { type: 'user', timestamp: at(1), message: { role: 'user', content: 'Read the brief' } },
  { type: 'api-request', id: 'r1', timestamp: at(2) },
  asst(5, 'm1', 'q1', 'r1', [{ type: 'thinking', thinking: '' }], 120),
  asst(7, 'm1', 'q1', 'r1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'node --test tests/speed.test.mjs' } }], 200),
  result(67, 't1'),
  { type: 'api-request', id: 'r2', timestamp: at(68) },
  asst(73, 'm2', 'q2', 'r2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.mjs' } }], 300),
  result(83, 't2'),
  { type: 'api-request', id: 'r3', timestamp: at(84) },
  asst(94, 'm3', 'q3', 'r3', [{ type: 'text', text: 'done' }], 500),
  { type: 'user', timestamp: at(120), message: { role: 'user', content: 'more' } },
  asst(124, 'm4', 'q4', null, [{ type: 'text', text: 'ok' }], 100),
  { type: 'assistant', timestamp: at(125), message: { id: 'syn', model: '<synthetic>', usage: usage(999), content: [{ type: 'text', text: 'x' }] } },
];
const fold = (lines = LINES) => { const c = speedInit(); for (const j of lines) onSpeed(c, j); return c; };

test('speedOf: tok/s of generation time, the wall split model / tools / tests / idle, tokens per wall hour', () => {
  const s = speedOf(fold(), { from: T0, to: T0 + 200000 });
  assert.equal(s.requests, 4);
  assert.equal(s.out, 1100, 'a request counts once at its largest usage; the synthetic line not at all');
  assert.equal(s.model_ms, 24000);
  assert.equal(s.tok_s, 1100 / 24, '1100 output tokens in 5 + 5 + 10 + 4 s');
  assert.deepEqual([s.test_ms, s.tool_ms, s.idle_ms], [60000, 10000, 106000]);
  assert.deepEqual(s.pct, { model: 12, tools: 5, tests: 30, idle: 53 });
  assert.equal(s.out_per_h, 1100 * 18);
  assert.equal(s.ctx_per_h, 4000 * 18);
  assert.equal(speedWords(s), 'tok/s 46 · model 12 % · tests 30 %');
});

test('speedOf: a window counts the requests that ended in it and the part of each call in it; an open call runs to the window end', () => {
  const c = fold(LINES.slice(0, 4));   // the test command is still running
  const s = speedOf(c, { from: T0 + 30000, to: T0 + 50000 });
  assert.equal(s.requests, 0); assert.equal(s.tok_s, null);
  assert.deepEqual(s.pct, { model: 0, tools: 0, tests: 100, idle: 0 }, 'the test command still running is test time');
  assert.deepEqual(speedOf(fold([...LINES.slice(0, 3), asst(7, 'm1', 'q1', 'r1', [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], 200)]), { from: T0 + 30000, to: T0 + 50000 }).pct.tools, 100);
  const w = speedOf(fold(), { from: T0 + 60000, to: T0 + 100000 });
  assert.equal(w.requests, 2); assert.equal(w.model_ms, 15000); assert.equal(w.test_ms, 7000); assert.equal(w.tool_ms, 10000);
});

test('runSpeed reads the run\'s transcript once through the tail cache; a live run adds its last 10 min', () => {
  const t = mkTmp('norn-speed-'), projects = path.join(t, 'projects'), dir = path.join(projects, 'C--wt');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'sid-1.jsonl');
  fs.writeFileSync(f, LINES.map(j => JSON.stringify(j)).join('\n') + '\n');
  const ended = { id: 'RUN-1', kind: 'run', state: 'exited', created: at(0), history: [{ ev: 'end', ts: at(200) }], data: { kind: 'worker', session_id: 'sid-1' } };
  const cache = new Map(), s = runSpeed(ended, { projectsDir: projects, cache });
  assert.equal(s.tok_s, 1100 / 24); assert.equal(s.wall_ms, 200000); assert.equal(s.last10, undefined);
  assert.equal(runSpeed(ended, { projectsDir: projects, cache }).out, 1100, 'the second read parses nothing new and counts the same');
  const live = runSpeed({ ...ended, state: 'running', history: [] }, { projectsDir: projects, cache, now: T0 + 130000 });
  assert.equal(live.last10.out, 1100, 'all four requests ended in the last 10 min'); assert.equal(live.last10.wall_ms, 130000, 'clipped to the run start');
  assert.equal(runSpeed({ ...ended, data: { kind: 'worker', session_id: 'none' } }, { projectsDir: projects, cache }), null);
});

test('workersDuring: the worker runs running at once over a window, this one included; isWorker leaves out helpers, check-ins and queue entries', () => {
  const spans = [{ from: 0, to: 100 }, { from: 50, to: 150 }, { from: 60, to: 70 }];
  assert.deepEqual(workersDuring(spans, 0, 100), { min: 1, avg: 1.6, max: 3 });
  assert.deepEqual(workersDuring(spans, 100, 150), { min: 1, avg: 1, max: 1 });
  assert.deepEqual(workersDuring(spans, 5, 5), { min: null, avg: null, max: null });
  const r = (id, state, data = {}) => ({ id, kind: 'run', state, created: at(0), history: state === 'running' ? [] : [{ ev: 'end', ts: at(60) }], data: { kind: 'worker', ...data } });
  const runs = [r('RUN-1', 'exited'), r('RUN-2', 'running'), r('RUN-3', 'queued'), r('RUN-4', 'exited', { role: 'helper' }), r('RUN-5', 'exited', { kind: 'checkin' })];
  assert.deepEqual(runs.filter(isWorker).map(x => x.id), ['RUN-1', 'RUN-2']);
  assert.deepEqual(workerSpans(runs, T0 + 120000), [{ from: T0, to: T0 + 60000 }, { from: T0, to: T0 + 120000 }]);
});

test('cpu samples: noteCpu appends, readCpu reads a window, cpuDuring averages; the log keeps its newer half past 1 MB', () => {
  const t = mkTmp('norn-speed-cpu-'), file = path.join(t, 'local', 'cpu.jsonl');
  noteCpu(40, 'dash', { file, now: T0 }); noteCpu(60, 'fill', { file, now: T0 + 1000 }); noteCpu(NaN, 'dash', { file, now: T0 + 2000 });
  const s = readCpu({ file });
  assert.deepEqual(s, [{ t: T0, cpu: 40, src: 'dash' }, { t: T0 + 1000, cpu: 60, src: 'fill' }]);
  assert.deepEqual(cpuDuring(s, T0, T0 + 5000), { avg: 50, n: 2 });
  assert.deepEqual(cpuDuring(s, T0 + 5000, T0 + 9000), { avg: null, n: 0 });
  assert.deepEqual(readCpu({ file: path.join(t, 'none.jsonl') }), []);
  fs.writeFileSync(file, `${JSON.stringify({ ts: at(0), cpu: 1, src: 'dash' })}\n`.repeat(25000));
  noteCpu(99, 'dash', { file, now: T0 + 60000 });
  const after = readCpu({ file });
  assert.ok(fs.statSync(file).size < 1 << 20 && after.length > 5000, 'trimmed to about half');
  assert.deepEqual(after.at(-1), { t: T0 + 60000, cpu: 99, src: 'dash' }, 'the newest sample kept, every line whole');
});

test('speedReport: one row per ended worker run in the window, grouped by workers running; formatSpeed prints the table', () => {
  const t = mkTmp('norn-speed-rep-'), projects = path.join(t, 'projects'), dir = path.join(projects, 'C--wt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sid-a.jsonl'), LINES.map(j => JSON.stringify(j)).join('\n') + '\n');
  const H = 3600000, run = (id, from, to, data = {}, outcome = 'done') => ({ id, kind: 'run', state: to === null ? 'running' : 'exited', created: new Date(T0 + from).toISOString(),
    history: to === null ? [] : [{ ev: 'end', ts: new Date(T0 + to).toISOString() }], end: to === null ? undefined : { outcome }, data: { kind: 'worker', lane: id.toLowerCase(), model: 'claude-opus-5-5', effort: 'medium', ...data } });
  // hour 0: RUN-1 alone (A: the transcript); hour 1: RUN-2 + RUN-3 together; RUN-4 still running; RUN-5 ended before the window
  const items = [run('RUN-1', 0, 200000, { session_id: 'sid-a' }), run('RUN-2', H, 2 * H), run('RUN-3', H, 2 * H, {}, 'handoff'), run('RUN-4', 2 * H + 60000, null), run('RUN-5', -30 * H, -29 * H)];
  const cpu = [{ t: T0 + 1000, cpu: 30 }, { t: T0 + H + 1000, cpu: 80 }];
  const rep = speedReport([{ project: 'demo', items }], { now: T0 + 3 * H, hours: 24, projectsDir: projects, cpu });
  assert.deepEqual(rep.rows.map(x => x.run), ['RUN-2', 'RUN-3', 'RUN-1'], 'newest end first; the running and the old run are no rows');
  const r1 = rep.rows.find(x => x.run === 'RUN-1');
  assert.deepEqual(r1.workers, { min: 1, avg: 1, max: 1 }); assert.deepEqual(r1.cpu, { avg: 30, n: 1 }); assert.equal(r1.speed.tok_s, 1100 / 24);
  assert.deepEqual(rep.rows[0].workers, { min: 2, avg: 2, max: 2 }); assert.equal(rep.rows[0].speed, null, 'no transcript: no speed');
  assert.deepEqual(rep.groups.map(g => [g.workers, g.runs, g.tok_s, g.cpu]), [[1, 1, 1100 / 24, 30], [2, 2, null, 80]]);
  // the clock hours of the window: 10:00 (RUN-1 ran 200 s of it: 0.06 workers, rounds to 0: no group) .. 12:00 (RUN-4: 1 from 12:01)
  const h = Object.fromEntries(rep.hourly.map(x => [x.from.slice(11, 16), x]));
  assert.equal(h['11:00'].workers, 2); assert.equal(h['11:00'].done, 0, 'RUN-2 ended done at 12:00, in the next hour');
  assert.equal(h['12:00'].done, 1); assert.ok(Math.abs(h['12:00'].workers - 59 / 60) < 1e-9);
  assert.deepEqual(rep.groups.map(g => [g.workers, g.hours, g.done_per_h]), [[1, 1, 1], [2, 1, 0]]);
  const txt = formatSpeed(rep);
  assert.match(txt, /RUN-1 +run-1 +opus-5-5 +medium +1\/1\.0\/1 +30 +46 +12 +5 +30 +53 +3 +1k +done/);
  assert.match(txt, /RUN-2 .* no transcript/);
  assert.match(txt, /^2 +2 +- +- +80 +1 +0\.0$/m);
  assert.doesNotMatch(txt, /demo:RUN-1/, 'one project: bare run ids');
});

test('the Runs line: the server\'s words, a live run marked as its last 10 min', () => {
  assert.equal(speedLine(null), '');
  const html = speedLine({ line: 'tok/s 42 · model 35 % · tests 40 %', rolling: true });
  assert.match(html, /class="speed small mute"/); assert.match(html, /tok\/s 42 · model 35 % · tests 40 % \(10 min\)/);
  assert.doesNotMatch(speedLine({ line: 'tok/s 1 · model 1 % · tests 1 %', rolling: false }), /10 min/);
});

test('norn speed: the table and --json from the records, the transcripts and the CPU log; bad flags exit 2', () => {
  const t = mkTmp('norn-speed-cli-'), root = path.resolve(t, '..', '..'), state = t, projects = path.join(root, 'claude', 'projects'), dir = path.join(projects, 'C--wt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sid-c.jsonl'), LINES.map(j => JSON.stringify(j)).join('\n') + '\n');
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'gen', session_id: 'sid-c', model: 'claude-opus-5-5', effort: 'medium' } }, { now: () => new Date(T0) });
  record(state, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome: 'done' } }, { now: () => new Date(T0 + 200000) });
  noteCpu(55, 'dash', { file: path.join(root, 'local', 'cpu.jsonl'), now: T0 + 100000 });
  const env = { ...process.env, META_ROOT: root, CLAUDE_CONFIG_DIR: path.join(root, 'claude') };
  const run = (...a) => spawnSync(process.execPath, [META, 'speed', '--state', state, '--now', at(3600), ...a], { encoding: 'utf8', timeout: 60000, env });
  const txt = run();
  assert.equal(txt.status, 0, txt.stderr);
  assert.match(txt.stdout, /RUN-1 +gen +opus-5-5 +medium +1\/1\.0\/1 +55 +46 +12 +5 +30 +53/);
  const j = JSON.parse(run('--json', '--hours', '2').stdout);
  assert.equal(j.hours, 2); assert.equal(j.rows[0].speed.out, 1100); assert.equal(j.rows[0].cpu.avg, 55); assert.match(j.method, /api-request/);
  assert.equal(run('--hours', '0').status, 2); assert.equal(run('--bogus').status, 2);
});
