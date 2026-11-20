// RM-48 S1 (DEC-1088 finding Q2): an independent run started from inside a run's job must leave that job. When a job around the
// caller forbids breakaway, the launch is refused, naming the run's job - never a supervisor started inside it (nested: the job's
// reap or close would kill it). The fixture: a held process whose META_JOB (the run's job, outer) holds a second job nested inside
// it (KILL_ON_JOB_CLOSE, no BREAKAWAY_OK; a worker's 'jobguard run'). Windows does NOT fail that breakaway: the child silently stays
// in every job up to the forbidding one, so the old launch reported "breakaway" for a nested start. Temp dirs, the fake executor only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';

const WIN = process.platform !== 'win32' && 'job objects: Windows only';
const lib = f => JSON.stringify(new URL(`../engine/lib/${f}`, import.meta.url).href);

// run `body` in a child whose META_JOB (outer) holds a nested job forbidding breakaway (inner); returns its out.json
async function nested(t, body) {
  const out = path.join(t, 'out.json'), f = path.join(t, 'nested.mjs');
  fs.writeFileSync(f, `import { holdJob, spawnOutside, reapJob } from ${lib('jobguard.mjs')};
import { startRun } from ${lib('runs.mjs')};
import { loadState } from ${lib('records.mjs')};
import fs from 'node:fs';
const outer = await holdJob(process.pid), inner = await holdJob(process.pid, { name: 'meta-inner-' + process.pid });
process.env.META_JOB = outer.name; process.env.META_RUN_ID = 'RUN-OUTER';
const o = { outer: outer.error ?? null, inner: inner.error ?? null, job: outer.name };
try { ${body} } catch (e) { o.threw = e.message; }
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(o));
process.exit(0);`);
  const c = spawn(process.execPath, [f], { stdio: 'ignore', windowsHide: true });
  await new Promise(r => c.on('exit', r));
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

test('spawnOutside strict: an outer job forbidding breakaway = refused, the program never starts (no "inside" fallback)', { skip: WIN }, async () => {
  const t = mkTmp('meta-jgi-'), mark = path.join(t, 'started.txt');
  const args = ['-e', `require('fs').writeFileSync(${JSON.stringify(mark.replace(/\\/g, '/'))}, 'x')`];
  const o = await nested(t, `o.r = spawnOutside(process.execPath, ${JSON.stringify(args)}, { strict: true });`);
  assert.equal(o.outer, null); assert.equal(o.inner, null);
  assert.equal(o.r?.pid, undefined, JSON.stringify(o.r));
  assert.match(o.r?.refused ?? '', /breakaway/, JSON.stringify(o.r));
  assert.equal(fs.existsSync(mark), false, 'nothing was started inside the job');
});

test('startRun from inside a run\'s job that cannot be left: refused naming the job, no nested supervisor, the run ends', { skip: WIN }, async () => {
  const t = mkTmp('meta-jgi-'), state = path.join(t, 'state', 'demo'), wt = path.join(t, 'wt');
  fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(path.join(t, 'brief.md'), 'mode: done\n');
  const opts = { state, locksDir: path.join(t, 'state', 'locks'), executor: 'fake', lane: 'demo', worktree: wt, notes: path.join(t, 'NOTES.md'), hbMs: 150,
    staleMs: 3000, policy: { auto_resume_max: 0 }, budget: {}, tick: null, brief: path.join(t, 'brief.md') };
  const o = await nested(t, `try { o.r = startRun(${JSON.stringify(opts)}); } finally { o.runs = Object.values(loadState(${JSON.stringify(state)}).items).filter(i => i.kind === 'run').map(i => ({ state: i.state, refused: i.end?.refused })); }`);
  assert.equal(o.outer, null); assert.equal(o.inner, null);
  assert.equal(o.r, undefined, `no launch: ${JSON.stringify(o.r)}`);
  assert.ok(o.threw?.includes(o.job), `the refusal names the job ${o.job}: ${o.threw}`);
  assert.equal(o.runs.length, 1);
  assert.notEqual(o.runs[0].state, 'running', JSON.stringify(o.runs));
  assert.ok(o.runs[0].refused?.includes(o.job), JSON.stringify(o.runs));
});

test('spawnOutside strict: a run job that lets the child leave = it is resumed and runs, no member of that job', { skip: WIN }, async () => {
  const t = mkTmp('meta-jgi-'), mark = path.join(t, 'started.txt').split(path.sep).join('/'), kills = path.join(t, 'kills.jsonl');
  const args = ['-e', `require('fs').writeFileSync(${JSON.stringify(mark)}, 'x'); setTimeout(() => {}, 60000)`];
  const o = await nested(t, `o.r = spawnOutside(process.execPath, ${JSON.stringify(args)}, { strict: true, job: inner.name });
for (let i = 0; i < 400 && !fs.existsSync(${JSON.stringify(mark)}); i++) await new Promise(r => setTimeout(r, 50));
o.ran = fs.existsSync(${JSON.stringify(mark)});
o.reaped = reapJob(inner, process.pid, { file: ${JSON.stringify(kills)} }).killed?.map(k => k.pid);`);
  assert.ok(Number.isInteger(o.r?.pid) && o.r.breakaway === true, JSON.stringify(o.r));
  assert.equal(o.ran, true, 'the suspended child was resumed');
  assert.ok(Array.isArray(o.reaped) && !o.reaped.includes(o.r.pid), `not in the job it left: ${JSON.stringify(o.reaped)}`);
});
