// fair-slots 5c / 6 (2026-11-19): test processes that outlive their test. A supervisor started under a test exits once its test
// process is gone, every supervisor exits once its run's state is deleted, and the tick kills a derelict test process only on the
// evidence rule (parent dead or dir deleted, no live run owns it, older than 2 h), recording each kill. Fake process lists and
// processes these tests start themselves only: nothing here lists or kills a real process of the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startRun } from '../engine/lib/runs.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { TEST_OWNER, testOwner, testOwnerValue, ownerGoneWhy, testDirOf, derelictVerdict, derelictFacts, sweepDerelicts, tickDerelicts, DERELICTS_FILE } from '../engine/lib/derelict.mjs';
import { tick } from '../engine/lib/tick.mjs';
import { mkTmp, cleanTmp, SYSTEM_TMP } from './helpers/tmp.mjs';

test.after(cleanTmp);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 30000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) return null; await sleep(50); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const NOW = Date.parse('2026-11-19T16:10:00Z'), h = n => NOW - n * 3600e3;
const TMP = 'C:/Work/Temp';

test('the test owner: tests/helpers/tmp.mjs names this process (pid + start); ownerGoneWhy - a dead pid, a failed probe, a reused pid (other start time) are gone', () => {
  assert.deepEqual(testOwner(process.env), { pid: process.pid, started: testOwner(process.env).started });
  assert.ok(Math.abs(testOwner(process.env).started - performance.timeOrigin) < 1000, 'the start is this process\'s');
  assert.equal(process.env[TEST_OWNER], testOwnerValue());
  assert.equal(testOwner({}), null); assert.equal(testOwner({ [TEST_OWNER]: 'x:1' }), null);
  const o = { pid: 5, started: 1_000_000 };
  assert.equal(ownerGoneWhy(o, { alive: true, start: undefined }), null, 'not probed yet: the pid decides');
  assert.equal(ownerGoneWhy(o, { alive: true, start: 1_000_000 + 30e3 }), null, 'the same process (within 120 s)');
  assert.match(ownerGoneWhy(o, { alive: false }), /its test process 5 is gone/);
  assert.match(ownerGoneWhy(o, { alive: true, start: null }), /is gone/);
  assert.match(ownerGoneWhy(o, { alive: true, start: 1_000_000 + 10 * 60e3 }), /the pid now names a process started/, 'pid reuse');
});

test('testDirOf: the deepest test temp dir a command line names (ci-suite-X[/parallel-n[/meta-Y]] or meta-Y), never the jobguard exe, never outside the temp root', () => {
  const win = { win: true };
  assert.equal(testDirOf(String.raw`node C:\Work\Temp\ci-suite-Jb1Xo1\parallel-4\meta-tp-abc\state\kestrel\runs\RUN-1.spec.json`, [TMP], win),
    `C:/Work/Temp/ci-suite-Jb1Xo1/parallel-4/meta-tp-abc`);
  assert.equal(testDirOf(String.raw`"C:\Program Files\msedge.exe" --headless=new --user-data-dir=c:\work\temp\meta-shot-XjdDP8 --x`, [TMP], win), 'c:/work/temp/meta-shot-XjdDP8');
  assert.equal(testDirOf(String.raw`node.exe -e "setInterval(() => {}, 1e6)" C:\Work\Temp\meta-leak-q1`, [TMP], win), `${TMP}/meta-leak-q1`);
  assert.equal(testDirOf(String.raw`node x.mjs C:\Work\Temp\ci-suite-a1\parallel-7 --y`, [TMP], win), `${TMP}/ci-suite-a1/parallel-7`);
  assert.equal(testDirOf(String.raw`C:\Work\Temp\meta-jobguard-0123456789ab.exe hold 12 meta-run-12-1`, [TMP], win), null, 'the job helper exe');
  assert.equal(testDirOf('node --test tests/livecost.test.mjs', [TMP], win), null);
  assert.equal(testDirOf(String.raw`node D:\work\meta-tp-x\a.mjs`, [TMP], win), null, 'a meta-* dir outside the temp root');
  assert.equal(testDirOf('node /tmp/meta-agn-p7poxu/state/x', ['/tmp'], { win: false }), '/tmp/meta-agn-p7poxu');
  assert.equal(testDirOf('node /tmp/META-agn-p7poxu/x', ['/TMP'], { win: false }), null, 'POSIX paths are case-sensitive');
});

// the 2026-11-19 evidence (item 6), as a process list: what the rule kills and what it keeps, and why
const P = (pid, ppid, name, hours, cmd) => ({ pid, ppid, name, created: h(hours), cmd });
const EVIDENCE = [
  P(1, 0, 'System', 200, ''),
  P(43596, 9001, 'node.exe', 23, String.raw`node.exe engine\lib\supervisor.mjs C:\Work\Temp\ci-suite-Jb1Xo1\parallel-4\meta-tp-q\state\kestrel\runs\RUN-1.spec.json`),
  P(64056, 43596, 'node.exe', 23, String.raw`node.exe engine\bin\fake-executor.mjs --brief C:\Work\Temp\ci-suite-Jb1Xo1\parallel-4\meta-tp-q\b.md`),
  P(56356, 9002, 'node.exe', 22, String.raw`node.exe engine\lib\supervisor.mjs C:\Work\Temp\meta-agn-p7poxu\state\kestrel\runs\RUN-2.spec.json`),
  P(30220, 12068, 'msedge.exe', 22, String.raw`msedge.exe --headless=new --user-data-dir=C:\Work\Temp\meta-shot-XjdDP8`),
  P(12068, 9003, 'node.exe', 22, 'node.exe --test guard-dash.test.mjs'),
  P(39280, 9004, 'node.exe', 23, String.raw`node.exe -e "setInterval(() => {}, 1e6)" C:\Work\Temp\meta-leak-z9`),
  P(500, 1, 'node.exe', 0.5, String.raw`node.exe supervisor.mjs C:\Work\Temp\meta-young-a\runs\RUN-1.spec.json`),   // young
  P(600, 601, 'node.exe', 5, String.raw`node.exe supervisor.mjs C:\Work\Temp\meta-alive-b\runs\RUN-1.spec.json`),     // parent lives, dir there
  P(601, 1, 'node.exe', 6, 'node.exe --test x.test.mjs'),
  P(700, 701, 'node.exe', 5, String.raw`node.exe x.mjs C:\Work\Temp\meta-run-c\x`),       // under a live run
  P(701, 9005, 'node.exe', 6, 'node.exe supervisor.mjs D:/norn/state/norn/runs/RUN-9.spec.json'),
  P(800, 802, 'node.exe', 5, String.raw`node.exe x.mjs C:\Work\Temp\meta-reuse-d\x`),      // its parent pid now names a younger process
  P(802, 1, 'node.exe', 1, 'node.exe unrelated.mjs'),
  P(900, 901, 'node.exe', 5, String.raw`node.exe x.mjs C:\Work\Temp\meta-gone-e\x`),       // parent lives, dir deleted
  P(901, 1, 'node.exe', 6, 'node.exe holder.mjs'),
];
const EXISTS = new Set([`${TMP}/meta-alive-b`, `${TMP}/meta-run-c`, `${TMP}/meta-reuse-d`, `${TMP}/meta-young-a`].map(d => d.toLowerCase()));
const factsOpts = { live: new Set([701]), now: NOW, tmpRoots: [TMP], exists: d => EXISTS.has(d.toLowerCase()), self: 4242, win: true };

test('derelictVerdict (pure, the rule the proc-hygiene sweep shares): kill only with a test dir + no live owner + older than 2 h + (dead parent or deleted dir)', () => {
  const p = { pid: 9, ppid: 8, created: h(3), cmd: 'x' };
  const f = { now: NOW, dir: `${TMP}/meta-x`, dirGone: false, parentDead: true, owner: null };
  assert.deepEqual(derelictVerdict(p, f), { kill: true, why: 'parent 8 gone; no live run owns it; 3.0 h old' });
  assert.deepEqual(derelictVerdict(p, { ...f, parentDead: false, dirGone: true }), { kill: true, why: `${TMP}/meta-x deleted; no live run owns it; 3.0 h old` });
  assert.deepEqual(derelictVerdict(p, { ...f, dir: null }), { kill: false, why: 'names no test temp dir' });
  assert.deepEqual(derelictVerdict(p, { ...f, owner: 'live run pid 3' }), { kill: false, why: 'owned by live run pid 3' });
  assert.deepEqual(derelictVerdict({ ...p, created: h(1.5) }, f), { kill: false, why: '1.5 h old (< 2 h)' });
  assert.deepEqual(derelictVerdict(p, { ...f, parentDead: false }), { kill: false, why: `its parent 8 lives and ${TMP}/meta-x exists` });
  assert.deepEqual(derelictVerdict({ ...p, created: null }, f), { kill: false, why: 'start time unknown' });
  assert.equal(derelictVerdict({ ...p, created: h(1.5) }, { ...f, hours: 1 }).kill, true, 'the age bound is a fact');
});

test('derelictFacts + sweepDerelicts on the 11-19 evidence: the orphaned supervisors / executor / headless Edge / leak keeper go; young, parented, run-owned and non-test processes stay; each kill carries its evidence', () => {
  const facts = new Map(derelictFacts(EVIDENCE, factsOpts).map(({ p, f }) => [p.pid, f]));
  assert.equal(facts.get(64056).parentDead, false, 'the executor\'s supervisor lives in the list');
  assert.equal(facts.get(64056).dirGone, true);
  assert.equal(facts.get(800).parentDead, true, 'a parent pid that names a younger process = the parent is gone');
  assert.equal(facts.get(700).owner, 'live run pid 701');
  const killed = [];
  const rows = sweepDerelicts(EVIDENCE, { ...factsOpts, kill: pid => killed.push(pid) });
  assert.deepEqual(rows.map(r => r.pid).sort((a, b) => a - b), [30220, 39280, 43596, 56356, 64056, 800, 900].sort((a, b) => a - b));
  assert.deepEqual(killed.sort((a, b) => a - b), rows.map(r => r.pid).sort((a, b) => a - b));
  const r = rows.find(x => x.pid === 43596);
  assert.equal(r.dir, `${TMP}/ci-suite-Jb1Xo1/parallel-4/meta-tp-q`);
  assert.match(r.why, /^parent 9001 gone; .*meta-tp-q deleted; no live run owns it; 23\.0 h old$/);
  assert.equal(r.created, new Date(h(23)).toISOString());
  assert.match(rows.find(x => x.pid === 900).why, /^C:\/Work\/Temp\/meta-gone-e deleted; no live run owns it; 5\.0 h old$/);
  // the sweeper itself (and its ancestors) is never derelict
  const self = sweepDerelicts([P(77, 76, 'node.exe', 9, `node.exe tick ${TMP}/meta-me-f`)], { ...factsOpts, self: 77, kill: () => assert.fail('killed itself') });
  assert.deepEqual(self, []);
  // a kill that throws is recorded as not killed
  const bad = sweepDerelicts([EVIDENCE[6]], { ...factsOpts, kill: () => { throw new Error('access denied'); } });
  assert.deepEqual([bad[0].killed, bad[0].error], [false, 'access denied']);
});

test('tickDerelicts: once per window machine-wide (a stamp in <state root>/locks), each kill in <state>/derelicts.jsonl + a line; inside a test or on a temp-dir state, with no listing given, it lists nothing', () => {
  const state = mkTmp('meta-drl-');
  const killed = [];
  const o = { list: () => EVIDENCE, kill: pid => killed.push(pid), live: new Set([701]), now: NOW, tmpRoots: [TMP] };
  // the dirs of the fake list are not on this disk: every named one counts as deleted here (the live run still keeps 700)
  const lines = tickDerelicts(state, o);
  assert.ok(killed.includes(43596) && killed.includes(39280) && !killed.includes(700) && !killed.includes(500) && !killed.includes(12068), killed.join(','));
  assert.ok(lines.length === killed.length && lines.every(l => /^derelict killed: pid \d+ /.test(l)), lines.join('\n'));
  const rec = fs.readFileSync(path.join(state, DERELICTS_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rec.length, killed.length);
  assert.deepEqual(Object.keys(rec[0]).sort(), ['at', 'by', 'cmd', 'created', 'dir', 'killed', 'name', 'pid', 'ppid', 'why'].sort());
  assert.equal(rec[0].by, 'tick'); assert.equal(rec[0].at, new Date(NOW).toISOString());
  assert.ok(fs.existsSync(path.join(path.dirname(state), 'locks', 'derelict-sweep.stamp')));
  assert.deepEqual(tickDerelicts(state, { ...o, now: NOW + 60e3 }), [], 'the next tick in the window does not sweep');
  assert.deepEqual(tickDerelicts(mkTmp('meta-drl2-'), { kill: () => assert.fail('killed a real process') }), [], 'inside a test: no real listing');
  assert.deepEqual(tickDerelicts(mkTmp('meta-drl3-'), { env: {}, kill: () => assert.fail('killed a real process') }), [], 'a state in the temp dir (a fixture whose spawn dropped META_*): no real listing');
});

test('tick: the dry tick sweeps with the injected listing and logs each kill in tick.log', async () => {
  const t = mkTmp('meta-drlt-');
  const root = path.join(t, 'root'), state = path.join(t, 'state', 'demo');
  fs.mkdirSync(root, { recursive: true });
  const p = { name: 'demo', root, state, ledger: path.join(t, 'progress.md'), briefs_dir: t, checkin: { cwd: root } };
  const budget = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), 'utf8').replace(/^﻿/, ''));
  const killed = [];
  const r = tick({ project: p, machine: { claude: { exe: 'x', projects_dir: path.join(t, 'none') } }, budget: { ...budget, calib_time_utc: new Date().toISOString() },
    budgetFile: path.join(t, 'budget.json'), reason: 'test', dry: true, hbMs: 100, staleMs: 3000, fakeMs: 100,
    listProcs: () => [{ pid: 39280, ppid: 9004, name: 'node.exe', created: Date.now() - 23 * 3600e3, cmd: `node.exe -e x ${path.join(SYSTEM_TMP, `meta-leak-gone${process.pid}`)}` }], killProc: pid => killed.push(pid) });
  assert.equal(r.code, 0, r.msg);
  assert.deepEqual(killed, [39280]);
  assert.match(fs.readFileSync(path.join(state, 'tick.log'), 'utf8'), /tick demo \(test\): derelict killed: pid 39280 node\.exe \(parent 9004 gone; .*meta-leak-gone\d+ deleted; no live run owns it; 23\.0 h old\)/);
  const id = r.msg.match(/check-in (RUN-\d+)/)?.[1];
  if (id) await waitFor(() => loadState(state).items[id]?.state === 'exited', 30000);
});

// ---------- 6a: the supervisor itself. A fake run that sleeps 60 s, with a grandchild (pids file); hb every 150 ms.
function sandbox() {
  const t = mkTmp('meta-drls-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), notes: path.join(t, 'NOTES.md'), pids: path.join(t, 'pids.json') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  d.brief = path.join(t, 'brief.md'); fs.writeFileSync(d.brief, `mode: sleep\nms: 60000\npids: ${d.pids}\n`);
  d.opts = { state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt, notes: d.notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0, trigger_on_exit: false }, budget: {}, brief: d.brief };
  return d;
}
const logOf = (d, run) => { try { return fs.readFileSync(loadState(d.state).items[run].data.log, 'utf8'); } catch { return ''; } };

test('6a: a supervisor exits once its run\'s state is deleted (its spec file gone), killing its executor and the executor\'s child; no end is recorded', async () => {
  const d = sandbox();
  const r = startRun(d.opts);
  const p = await waitFor(() => { try { return JSON.parse(fs.readFileSync(d.pids, 'utf8')); } catch { return null; } });
  assert.ok(p, 'the executor started');
  assert.equal(alive(r.pid), true);
  const log = loadState(d.state).items[r.run].data.log;
  fs.rmSync(path.join(d.state, 'runs'), { recursive: true, force: true });   // the spec goes; on Windows the executor's open log keeps logs/
  const gone = await waitFor(() => !alive(r.pid) && !alive(p.pid) && !alive(p.grandchild), 60000);
  assert.ok(gone, `still alive: supervisor ${alive(r.pid)} executor ${alive(p.pid)} grandchild ${alive(p.grandchild)}`);
  assert.match(fs.readFileSync(log, 'utf8'), /supervisor exits: its state is deleted \(.*RUN-1\.spec\.json is gone\); the executor's tree is killed/);
  assert.equal(loadState(d.state).items[r.run].history.some(x => x.ev === 'end'), false, 'no end record');
});

test('6a: a supervisor started under a test process exits once that process is killed (no teardown ran), killing its executor tree; one with a live owner runs on', async () => {
  const d = sandbox();
  const out = path.join(d.t, 'owner.json');
  const runs = new URL('../engine/lib/runs.mjs', import.meta.url).href, der = new URL('../engine/lib/derelict.mjs', import.meta.url).href;
  // the owner: a test process of its own (not this one), with no teardown - killed below as ci-suite kills a file at its cap
  const src = `import { startRun } from ${JSON.stringify(runs)}; import { TEST_OWNER, testOwnerValue } from ${JSON.stringify(der)}; import fs from 'node:fs';
process.env[TEST_OWNER] = testOwnerValue();
const r = startRun(JSON.parse(process.argv[2]));
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(r)); setInterval(() => {}, 1e6);`;
  const f = path.join(d.t, 'owner.mjs'); fs.writeFileSync(f, src);
  const owner = spawn(process.execPath, [f, JSON.stringify(d.opts)], { stdio: 'ignore' });
  try {
    const r = await waitFor(() => { try { return JSON.parse(fs.readFileSync(out, 'utf8')); } catch { return null; } });
    assert.ok(r, 'the owner started a run');
    const p = await waitFor(() => { try { return JSON.parse(fs.readFileSync(d.pids, 'utf8')); } catch { return null; } });
    assert.ok(p, 'the executor started');
    await sleep(600);
    assert.equal(alive(r.pid), true, 'a live owner: the supervisor runs on');
    owner.kill('SIGKILL');
    const gone = await waitFor(() => !alive(r.pid) && !alive(p.pid) && !alive(p.grandchild), 60000);
    assert.ok(gone, `still alive: supervisor ${alive(r.pid)} executor ${alive(p.pid)} grandchild ${alive(p.grandchild)}`);
    assert.match(logOf(d, r.run), new RegExp(`supervisor exits: its test process ${owner.pid} is gone; the executor's tree is killed`));
  } finally { try { owner.kill('SIGKILL'); } catch { /* gone */ } }
});
