// fair-slots 5a / 5b (2026-11-19 ~15:50Z, CPU 94 %: two full ci-suites at once, and test processes from 11-17 / 11-18 still alive).
// 5a: one heavy gate per machine - the second waits (bounded, with a clear line), it never fails; a dead or reused holder is taken
// over; a gate inside a gate (runGate -> ci-suite) and a gate inside a test take no lock. 5b: nothing a ci-suite test file starts
// outlives the file's cap or the suite itself, however the suite ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireGate, gateLocksDir, holderGone, GATE_FILE, HELD_ENV } from '../engine/lib/gatelock.mjs';
import { runGate } from '../engine/lib/mergeq.mjs';
import { suiteEnv } from '../engine/lib/cisuite.mjs';
import { TEST_OWNER } from '../engine/lib/derelict.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

test.after(cleanTmp);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI = path.join(REPO, 'engine', 'bin', 'ci-suite.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitFor(fn, ms = 60000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) return null; await sleep(50); }
}
const ME = Math.round(performance.timeOrigin);
// outside a test (no META_TEST_OWNER: a real gate), this process's start without a PowerShell probe
const real = (locksDir, o = {}) => ({ locksDir, env: {}, pollMs: 50, start: pid => (pid === process.pid ? ME : null), ...o });
const deadPid = () => { const c = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); return Number(c.stdout); };

test('gateLocksDir: the calling run\'s state root, else <META_ROOT>/state/locks', () => {
  assert.equal(gateLocksDir({ META_RUN_STATE: '/x/state/norn', META_ROOT: '/r' }), path.join(path.resolve('/x/state'), 'locks'));
  assert.equal(gateLocksDir({ META_ROOT: '/r' }).split(path.sep).join('/'), '/r/state/locks');
});

test('acquireGate: the first takes the lock (pid, start, what); the second waits with a line, then takes it once the first releases', async () => {
  const dir = path.join(mkTmp('meta-gl-'), 'locks');
  const a = await acquireGate(real(dir, { what: 'ci-suite A' }));
  assert.equal(a.held, true);
  const cur = JSON.parse(fs.readFileSync(path.join(dir, GATE_FILE), 'utf8'));
  assert.deepEqual([cur.pid, cur.started, cur.what], [process.pid, ME, 'ci-suite A']);
  assert.deepEqual(a.env, { [HELD_ENV]: path.join(dir, GATE_FILE) });
  const said = [];
  const b = acquireGate(real(dir, { what: 'gate B', pid: process.pid + 1, started: 1, say: l => said.push(l) }));
  await sleep(400);
  assert.match(said[0], new RegExp(`^gate lock: one heavy gate per machine - waiting for pid ${process.pid} \\(ci-suite A, since .*\\), up to 90 min$`));
  a.release();
  const got = await b;
  assert.equal(got.held, true); assert.ok(got.waited_ms >= 300, String(got.waited_ms));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, GATE_FILE), 'utf8')).what, 'gate B');
  a.release();   // a release by a non-holder leaves the holder's lock
  assert.ok(fs.existsSync(path.join(dir, GATE_FILE)));
  got.release();
  assert.equal(fs.existsSync(path.join(dir, GATE_FILE)), false);
});

test('acquireGate: the wait is bounded - past it the gate runs beside the holder, saying so (never a failure)', async () => {
  const dir = path.join(mkTmp('meta-gl-'), 'locks');
  const a = await acquireGate(real(dir, { what: 'A' }));
  const said = [];
  const b = await acquireGate(real(dir, { what: 'B', pid: process.pid + 1, waitMs: 200, say: l => said.push(l) }));
  assert.equal(b.held, false); assert.match(b.why, /^waited out \(pid \d+ \(A, since/);
  assert.match(said.at(-1), /^gate lock: waited 0\.0 min for pid \d+ \(A, since .*\): running beside it$/);
  assert.deepEqual(b.env, {});
  a.release();
});

test('acquireGate: a dead holder, a reused pid (other start time) and a torn file are taken over; holderGone probes a holder once', async () => {
  const dir = path.join(mkTmp('meta-gl-'), 'locks'), file = path.join(dir, GATE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const take = async lock => { fs.writeFileSync(file, lock); const said = []; const g = await acquireGate(real(dir, { what: 'new', say: l => said.push(l) })); g.release(); return { g, said }; };
  const dead = deadPid();
  let r = await take(JSON.stringify({ pid: dead, started: 5, what: 'old suite' }));
  assert.equal(r.g.held, true); assert.match(r.said[0], new RegExp(`^gate lock: pid ${dead} \\(old suite\\) is gone - taken over$`));
  r = await take(JSON.stringify({ pid: process.pid, started: ME - 3600e3, what: 'reused' }));
  assert.equal(r.g.held, true, 'this pid, but another start time: the holder is gone');
  fs.writeFileSync(file, ''); fs.utimesSync(file, new Date(Date.now() - 60e3), new Date(Date.now() - 60e3));
  const said = []; const g = await acquireGate(real(dir, { say: l => said.push(l) })); g.release();
  assert.equal(g.held, true); assert.match(said[0], /a torn lock file - taken over/);
  let probes = 0;
  const seen = new Map(), o = { alive: () => true, start: () => { probes++; return 1000; }, seen };
  assert.equal(holderGone({ pid: 7, started: 1000 }, o), false); assert.equal(holderGone({ pid: 7, started: 1000 }, o), false);
  assert.equal(probes, 1);
  assert.equal(holderGone({ pid: 7 }, { alive: () => false }), true);
});

test('acquireGate: inside a test (META_TEST_OWNER) no lock; inside a live holder\'s gate (META_GATE_HELD) none either, and the token passes on', async () => {
  const dir = path.join(mkTmp('meta-gl-'), 'locks');
  const t = await acquireGate({ locksDir: dir, env: { [TEST_OWNER]: '1:2' } });
  assert.deepEqual([t.held, t.why], [false, 'inside a test: no machine gate lock']);
  assert.equal(fs.existsSync(path.join(dir, GATE_FILE)), false);
  const a = await acquireGate(real(dir, { what: 'mergeq gate' }));
  const n = await acquireGate(real(path.join(dir, 'elsewhere'), { env: a.env, waitMs: 0 }));
  assert.equal(n.held, false); assert.equal(n.why, `inside the gate of pid ${process.pid} (mergeq gate)`);
  assert.deepEqual(n.env, a.env);
  a.release();
  const after = await acquireGate(real(dir, { env: a.env }));
  assert.equal(after.held, true, 'a token whose holder is gone is no gate');
  after.release();
});

test('runGate: a heavy gate waits for the machine lock (its lines in the gate log) and its command runs under it (META_GATE_HELD); a brief\'s own tests (heavy false) do not wait', async () => {
  const t = mkTmp('meta-glr-'), dir = path.join(t, 'locks'), log = path.join(t, 'gate.log'), log2 = path.join(t, 'tests.log');
  const a = await acquireGate(real(dir, { what: 'other suite' }));
  const acquire = o => acquireGate({ ...o, env: {}, pollMs: 50, pid: process.pid + 1, start: pid => (pid === process.pid ? ME : null) });
  const cmd = `node -e "console.log('held=' + process.env.${HELD_ENV})"`;
  const light = await runGate({ cmd, timeout_min: 1 }, { cwd: t, log: log2, heavy: false, locksDir: dir, acquire });
  assert.equal(light.code, 0); assert.match(fs.readFileSync(log2, 'utf8'), /^held=undefined/m);
  const heavy = runGate({ cmd, timeout_min: 1 }, { cwd: t, log, locksDir: dir, acquire });
  await waitFor(() => fs.existsSync(log) && /waiting for pid/.test(fs.readFileSync(log, 'utf8')), 10000);
  a.release();
  const r = await heavy;
  assert.equal(r.code, 0);
  const text = fs.readFileSync(log, 'utf8');
  assert.match(text, new RegExp(`^norn: gate lock: one heavy gate per machine - waiting for pid ${process.pid} \\(other suite, since`, 'm'));
  assert.ok(text.includes(`held=${path.join(dir, GATE_FILE)}`), text);
  assert.equal(fs.existsSync(path.join(dir, GATE_FILE)), false, 'released at the gate\'s end');
});

// the real ci-suite, outside a test (no META_TEST_OWNER), its machine root a temp dir
// a SECOND suite, not a child of this one's gate: under a gate-holding ci-suite (CI) the inherited META_GATE_HELD made it skip the lock
const ciEnv = (root, extra = {}) => { const e = { ...suiteEnv(process.env), META_ROOT: root, ...extra }; delete e[TEST_OWNER]; delete e[HELD_ENV]; return e; };
const ciRun = (args, env) => {
  const c = spawn(process.execPath, [CI, ...args], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '', code: undefined };
  c.stdout.on('data', d => { out.text += d; }); c.stderr.on('data', d => { out.text += d; });
  out.done = new Promise(r => c.on('close', code => { out.code = code; r(code); }));
  return { c, out };
};

test('ci-suite: a second full suite waits for the machine gate lock (a line naming the holder), runs once it is free, and frees it at its end', { timeout: 180000 }, async () => {
  const root = path.dirname(path.dirname(mkTmp('meta-glc-'))), dir = path.join(root, 'state', 'locks');
  const a = await acquireGate(real(dir, { what: 'ci-suite (the other merge)' }));
  const { out } = ciRun(['--known', 'tests/fixtures/ci-suite/known.txt', 'tests/fixtures/ci-suite-hang/ok.test.mjs'], ciEnv(root));
  assert.ok(await waitFor(() => /gate lock: one heavy gate per machine - waiting for pid/.test(out.text), 60000), out.text);
  assert.doesNotMatch(out.text, /ci-suite: start /, 'no file starts while it waits');
  a.release();
  assert.equal(await out.done, 0, out.text);
  assert.match(out.text, new RegExp(`waiting for pid ${process.pid} \\(ci-suite \\(the other merge\\), since .*\\), up to 90 min`));
  assert.match(out.text, /ci-suite: gate lock: taken after \d+\.\d min/);
  assert.match(out.text, /ci-suite: start tests\/fixtures\/ci-suite-hang\/ok\.test\.mjs/);
  assert.equal(fs.existsSync(path.join(dir, GATE_FILE)), false, 'freed at exit');
  const bad = spawnSync(process.execPath, [CI, '--gate-wait', 'x', 'tests/fixtures/ci-suite-hang/ok.test.mjs'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /--gate-wait/);
});

test('ci-suite: a file past its cap dies with its whole tree - a detached orphan naming its temp dir too', { timeout: 180000 }, async () => {
  const t = mkTmp('meta-glo-'), pids = path.join(t, 'pids.json');
  const { out } = ciRun(['--file-cap', '8', 'tests/fixtures/ci-suite-orphan/orphan.test.mjs'], { ...suiteEnv(process.env), CI_SUITE_PIDS: pids });
  const p = await waitFor(() => { try { return JSON.parse(fs.readFileSync(pids, 'utf8')); } catch { return null; } });
  assert.ok(p, out.text);
  assert.equal(await out.done, 1, out.text);
  assert.match(out.text, /HANG RED: tests\/fixtures\/ci-suite-orphan\/orphan\.test\.mjs :: no exit within the 8 s per-file cap \(killed\)/);
  assert.ok(await waitFor(() => !alive(p.orphan) && !alive(p.file), 20000), `alive: orphan ${alive(p.orphan)} file ${alive(p.file)}`);
});

test('ci-suite: killed itself mid-file (no teardown of its own runs), its test file and the file\'s detached orphan die too', { timeout: 180000 }, async () => {
  const t = mkTmp('meta-glk-'), pids = path.join(t, 'pids.json');
  const { c, out } = ciRun(['tests/fixtures/ci-suite-orphan/orphan.test.mjs'], { ...suiteEnv(process.env), CI_SUITE_PIDS: pids });
  const p = await waitFor(() => { try { return JSON.parse(fs.readFileSync(pids, 'utf8')); } catch { return null; } });
  assert.ok(p, out.text);
  c.kill('SIGTERM');   // Windows: TerminateProcess (no handler runs: the job object kills the tree); POSIX: the suite's SIGTERM handler
  await out.done;
  assert.ok(await waitFor(() => !alive(p.orphan) && !alive(p.file), 30000), `alive: orphan ${alive(p.orphan)} file ${alive(p.file)}\n${out.text}`);
});
