// DEC-1088 (NORN-KILL-RECEIPTS): every process Norn terminates leaves a receipt in <state>/kills.jsonl BEFORE the kill (who, why,
// pid, image, command line, parent, job), and the end-of-run reap kills only through a handle re-checked as a member of the job.
// Temp dirs and node sleepers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killTree, stopOrphans, hbPath } from '../engine/lib/runs.mjs';
import { record } from '../engine/lib/records.mjs';
import { killsFile, readKills } from '../engine/lib/kills.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function gone(pid, ms = 5000) { const t0 = performance.now(); while (alive(pid) && performance.now() - t0 < ms) await sleep(50); return !alive(pid); }
const sleeper = marker => spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)', marker], { stdio: 'ignore', windowsHide: true });
const spawned = c => new Promise(r => c.once('spawn', r));

// one held process: it enters a job, starts a sleeper inside it, reaps with the given receipt options and writes what it saw. `also`:
// a pid of THIS (unjobbed) test process handed to the reap as if the job listed it - a member gone, its pid now a stranger's
async function heldReap(t, { receipts, also = null }) {
  const out = path.join(t, 'out.json'), lib = new URL('../engine/lib/jobguard.mjs', import.meta.url).href;
  const src = `import { holdJob, reapJob } from ${JSON.stringify(lib)};
import { spawn } from 'node:child_process'; import fs from 'node:fs';
const job = await holdJob(process.pid);
const inside = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)', 'kr-inside-marker'], { detached: true, stdio: 'ignore' }); inside.unref();
await new Promise(r => setTimeout(r, 300));
const r = reapJob(job, process.pid, { file: ${JSON.stringify(receipts)}, killer: 'RUN-T supervisor ' + process.pid, reason: 'reap: test'${also ? `, also: [${also}]` : ''} });
const insideAlive = (() => { try { process.kill(inside.pid, 0); return true; } catch { return false; } })();
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ error: job.error, job: job.name, inside: inside.pid, insideAlive, r }));
process.exit(0);`;
  const f = path.join(t, 'held.mjs'); fs.writeFileSync(f, src);
  const c = spawn(process.execPath, [f], { stdio: 'ignore', windowsHide: true });
  await new Promise(r => c.on('exit', r));
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

test('reap: each job member gets a receipt (image + command line + parent + job) and is killed; the result names pid + image', { skip: process.platform !== 'win32' && 'job objects: Windows' }, async () => {
  const t = mkTmp('meta-kr-'), receipts = path.join(t, 'kills.jsonl');
  const o = await heldReap(t, { receipts });
  assert.equal(o.error, undefined);
  assert.ok(o.r.killed.some(k => k.pid === o.inside && /^node(\.exe)?$/i.test(k.image)), JSON.stringify(o.r));
  const rec = readKills(receipts).find(k => k.pid === o.inside);
  assert.ok(rec, `a receipt for ${o.inside}: ${fs.readFileSync(receipts, 'utf8')}`);
  assert.equal(rec.action, 'kill'); assert.equal(rec.reason, 'reap: test'); assert.match(rec.killer, /^RUN-T supervisor \d+$/);
  assert.equal(rec.job, o.job); assert.match(rec.image, /^node(\.exe)?$/i); assert.match(rec.cmd, /kr-inside-marker/);
  assert.ok(Number.isInteger(rec.ppid) && rec.ppid > 0, `ppid ${rec.ppid}`); assert.ok(!Number.isNaN(Date.parse(rec.at)));
  assert.equal(await gone(o.inside), true);
});

test('reap: no receipt, no kill - an unwritable receipt file is an error before any process dies', { skip: process.platform !== 'win32' && 'job objects: Windows' }, async () => {
  const t = mkTmp('meta-kr-'), receipts = path.join(t, 'a-dir');
  fs.mkdirSync(receipts);
  const o = await heldReap(t, { receipts });
  assert.ok(o.r.error, JSON.stringify(o.r));
  assert.equal(o.insideAlive, true, 'the member was not killed without its receipt');
  await gone(o.inside);   // the hold ended with its process: the job closed (KILL_ON_JOB_CLOSE) and took the member
});

test('reap: a pid that is not in the job (left it / reused) is skipped with a receipt, never killed', { skip: process.platform !== 'win32' && 'job objects: Windows' }, async () => {
  const t = mkTmp('meta-kr-'), receipts = path.join(t, 'kills.jsonl');
  const outside = sleeper('kr-outside-marker'); await spawned(outside);
  try {
    const o = await heldReap(t, { receipts, also: outside.pid });
    assert.equal(alive(outside.pid), true, 'the non-member lives');
    assert.ok(o.r.skipped.some(k => k.pid === outside.pid), JSON.stringify(o.r));
    assert.ok(!o.r.killed.some(k => k.pid === outside.pid));
    const rec = readKills(receipts).find(k => k.pid === outside.pid);
    assert.equal(rec?.action, 'skipped'); assert.match(rec.why, /not in the job/); assert.match(rec.cmd, /kr-outside-marker/);
    assert.ok(o.r.killed.some(k => k.pid === o.inside), 'the member still died');
  } finally { try { outside.kill(); } catch { /* already exited: nothing left to stop */ } }
});

test('killTree: the receipt (pid, image, command line, parent) is in <state>/kills.jsonl before the tree dies', async () => {
  const t = mkTmp('meta-kr-'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(state, { recursive: true });
  const c = sleeper('kr-tree-marker'); await spawned(c);
  killTree(c.pid, { state, killer: 'tick 4242', reason: 'claim taken over' });
  assert.equal(await gone(c.pid), true);
  const rec = readKills(killsFile(state)).find(k => k.pid === c.pid);
  assert.ok(rec, 'a receipt for the killed pid');
  assert.equal(rec.action, 'kill'); assert.equal(rec.killer, 'tick 4242'); assert.equal(rec.reason, 'claim taken over');
  assert.match(rec.image, /^node(\.exe)?$/i); assert.match(rec.cmd, /kr-tree-marker/); assert.equal(rec.ppid, process.pid);
  assert.ok(rec.cmd.length <= 300);
});

test('stopOrphans: only the registered heartbeat pids of an orphaned helper die, each with a receipt naming the helper', async () => {
  const t = mkTmp('meta-kr-'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(path.join(state, 'hb'), { recursive: true });
  const c = sleeper('kr-orphan-marker'), bystander = sleeper('kr-orphan-marker'); await Promise.all([spawned(c), spawned(bystander)]);
  try {
    record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'p' } });
    record(state, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome: 'done' } });
    record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'h', role: 'helper', parent: 'RUN-1' } });
    fs.writeFileSync(hbPath(state, 'RUN-2'), JSON.stringify({ pid: c.pid }));
    assert.deepEqual(stopOrphans(state), ['RUN-2']);
    assert.equal(await gone(c.pid), true);
    assert.equal(alive(bystander.pid), true, 'the same command line but not registered: untouched');
    const rec = readKills(killsFile(state)).find(k => k.pid === c.pid);
    assert.equal(rec?.action, 'kill'); assert.match(rec.reason, /RUN-2.*parent RUN-1/); assert.match(rec.cmd, /kr-orphan-marker/);
  } finally { for (const p of [c, bystander]) { try { p.kill(); } catch { /* already exited: nothing left to stop */ } } }
});
