#!/usr/bin/env node
// Run the node suite and fail only on a red NOT listed in tests/KNOWN-REDS.txt.
// usage: node engine/bin/ci-suite.mjs [--known F] [--concurrency N] [--file-cap S] [--gate-wait MIN] [--cpu-prof DIR]
//   [--changed BASE [--max N]] [glob ...]   (default: tests/KNOWN-REDS.txt, 3, FILE_CAP_S, GATE_WAIT_MIN, "tests/*.test.mjs", --max 20).
//   --changed BASE runs only the matched files the change BASE...HEAD touches (lib/cisuite.mjs pickTests: the
//   fast PR job; the full suite runs after the merge and nightly); --max N caps the files picked only for importing a changed file.
// The suite is one `node --test` per matched file, N at a time, plus a reporter that writes the reds; smoke.test.mjs
// then runs alone (DEC-78). CI and the merge lanes call this script: it is the one home of the suite command.
// exit 0 = no new red, 1 = a new red, a file that left a process alive or one past the wall cap (named on stdout), 2 = usage / the suite produced no result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseKnown, judge, suiteEnv, pickTests, isBrowserTest } from '../lib/cisuite.mjs';
import { procsNaming, leakText } from '../lib/testprocs.mjs';
import { killTree } from '../lib/runs.mjs';
import { listProcs } from '../lib/strays.mjs';
import { acquireGate, GATE_WAIT_MIN } from '../lib/gatelock.mjs';
import { holdJob } from '../lib/jobguard.mjs';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const REPORTER = pathToFileURL(path.join(LIB, 'ci-reporter.mjs')).href;
const fwd = s => s.split('\\').join('/');
const argv = process.argv.slice(2), globs = [];
// CI-HANG-B7F6833: the per-file wall cap - a file that has not exited by then is a hang: its process tree is killed, its output so
// far printed and the suite fails naming it (a watchdog that turns a hang into a named red, well under the CI job's 60 min)
const FILE_CAP_S = 600;
let known = 'tests/KNOWN-REDS.txt', conc = '3', capS = FILE_CAP_S, cpuProf = null, gateWait = GATE_WAIT_MIN, changed = null, max = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--known') known = argv[++i];
  else if (argv[i] === '--gate-wait') gateWait = Number(argv[++i]);
  else if (argv[i] === '--changed') changed = argv[++i];
  else if (argv[i] === '--max') max = Number(argv[++i]);
  else if (argv[i] === '--concurrency') conc = argv[++i];
  else if (argv[i] === '--file-cap') capS = Number(argv[++i]);
  else if (argv[i] === '--cpu-prof') cpuProf = argv[++i];
  else if (argv[i].startsWith('--')) { console.error(`ci-suite: unknown flag ${argv[i]}`); process.exit(2); }
  else globs.push(argv[i]);
}
if (!globs.length) globs.push('tests/*.test.mjs');
if (!(capS > 0)) { console.error('ci-suite: --file-cap needs a number of seconds > 0'); process.exit(2); }
if (!(gateWait >= 0)) { console.error('ci-suite: --gate-wait needs a number of minutes >= 0'); process.exit(2); }
if (max != null && !changed) { console.error('ci-suite: --max needs --changed BASE'); process.exit(2); }
if (max != null && !(max >= 0)) { console.error('ci-suite: --max needs a number of files >= 0'); process.exit(2); }
if (changed === undefined || changed?.startsWith('--')) { console.error('ci-suite: --changed needs a base ref'); process.exit(2); }

let list;
try { list = parseKnown(fs.readFileSync(known, 'utf8')); } catch (e) { console.error(`ci-suite: ${e.message}`); process.exit(2); }
// DEC-78: smoke.test.mjs has a < 60 s wall-clock budget that picked up contention from the parallel set, so it is left out of
// the parallel run and runs alone (concurrency 1) after it. Both phases feed ONE red report and ONE exit code.
const SERIAL = new Set(['smoke.test.mjs']);
let files = [...new Set(globs.flatMap(g => fs.globSync(fwd(g))).map(fwd))].sort();
if (!files.length) { console.error(`ci-suite: no test file matches ${globs.join(' ')}`); process.exit(2); }
if (changed) {
  let diff;
  try { diff = execFileSync('git', ['diff', '--name-only', '--relative', `${changed}...HEAD`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { console.error(`ci-suite: git diff ${changed}...HEAD failed: ${String(e.stderr || e.message).trim()}`); process.exit(2); }
  const paths = diff.split('\n').map(fwd).filter(Boolean);
  const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const p = pickTests(paths, files, read, max ?? 20);
  console.log(`ci-suite: ${paths.length} file(s) changed since ${changed}: ${p.run.length} test file(s) picked`);
  if (p.left.length) console.log(`ci-suite: ${p.left.length} more import a changed file, left to the full suite after the merge: ${p.left.join(' ')}`);
  if (!p.run.length) { console.log('ci-suite: no test file to run'); process.exit(0); }
  files = p.run;
}
// NORN-DOD-GATE-FAST: the files to run and one `done` line per finished file (lib/dod.mjs gateProgress: a timed-out Done check names
// how far it got, e.g. 209/227)
console.log(`ci-suite: ${files.length} test file(s) to run`);
const parFiles = files.filter(f => !SERIAL.has(path.basename(f))), serFiles = files.filter(f => SERIAL.has(path.basename(f)));
// fair-slots 5a: one heavy gate per machine (gatelock.mjs) - a second full suite waits for the first, then runs (never fails on it)
const gate = await acquireGate({ what: `ci-suite ${globs.join(' ')}`, waitMs: gateWait * 60e3, say: l => console.log(`ci-suite: ${l}`) });
if (!gate.held) console.log(`ci-suite: no machine gate lock taken (${gate.why})`);
// a ci-suite started from inside a test must run its files (no NODE_TEST_CONTEXT), and a calling run's identity stays out (suiteEnv);
// a project gate its files start runs under this suite's gate lock (META_GATE_HELD)
const childEnv = { ...suiteEnv(process.env), ...gate.env };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-suite-'));
// fair-slots 5b / 6b: nothing a test file starts outlives the suite. Windows: the suite holds itself in a Job Object (jobguard.mjs,
// KILL_ON_JOB_CLOSE) before the first file, so every process born below it - detached supervisors, headless Edge, orphans whose parent
// already exited - dies when the suite ends however it ends (exit, crash, a hard kill of this process: its hold sees the exit). Any
// platform: an exit before the files are done (a throw, SIGINT / SIGTERM / SIGHUP) kills every process naming the suite's temp dir.
let filesDone = false;
process.on('exit', () => { if (!filesDone) for (const p of procsNaming([tmp])) killTree(p.pid); });
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { console.error(`ci-suite: ${s}: stopping, the test processes are killed`); process.exit(130); });
if (process.platform === 'win32') { const j = await holdJob(process.pid, { name: `meta-ci-suite-${process.pid}-${Date.now()}` }); if (j.error) console.log(`ci-suite: no job object (${j.error}): a hard kill of the suite leaves its test processes`); }
// META-TEST-PROCS (DEC-219, SPEC 9.6 PR-14; Jest's --detectOpenHandles, made a hard check): each test file runs as its own
// `node --test` with its own temp dir (TEMP / TMP / TMPDIR), so every temp state it makes - and every process it starts there -
// names that dir. When the file is done, a process whose command line still names it is that file's leak: the file fails, naming
// the pids (never a listed red: KNOWN-REDS cannot hold it), and the suite kills them. 11-13: 22 supervisor + fake-executor pairs.
// META-CI-WORKCLASS R4 (DEC-336): --cpu-prof DIR - a browser test file (it imports shot.mjs or helpers/cdp.mjs) runs with
// NODE_OPTIONS --cpu-prof into DIR/<file>, so its node processes leave a sampling profile that names a sync call blocking the loop
// by its JS caller (tests/helpers/profgap.mjs reads them; the Windows CI job)
const isBrowserFile = f => isBrowserTest(fs.readFileSync(f, 'utf8'));
const profEnv = f => !cpuProf || !isBrowserFile(f) ? {}
  : { NODE_OPTIONS: `${childEnv.NODE_OPTIONS ?? ''} --cpu-prof --cpu-prof-dir="${fwd(path.resolve(cpuProf, path.basename(f, '.mjs')))}"`.trim() };
const runFile = (name, f, i) => new Promise(resolve => {
  const ft = path.join(tmp, `${name}-${i}`), out = path.join(tmp, `${name}-${i}.jsonl`);
  fs.mkdirSync(ft);
  console.log(`ci-suite: start ${f}`);
  const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${REPORTER}`, `--test-reporter-destination=${out}`, f], { env: { ...childEnv, ...profEnv(f), TEMP: ft, TMP: ft, TMPDIR: ft } });
  const buf = [];
  child.stdout.on('data', d => buf.push(d)); child.stderr.on('data', d => buf.push(d));
  let hung = false, ended = false;
  // DEC-1088: its kills are receipted (kills.mjs: the calling run's state, else <tmp>/norn-kills.jsonl)
  const cap = setTimeout(() => { hung = true; killTree(child.pid, { killer: `ci-suite pid ${process.pid}`, reason: `${f}: no exit within the ${capS} s per-file cap` }); }, capS * 1000);
  // a killed file ends at its exit even if a stray grandchild still holds its pipes
  child.on('exit', () => { if (hung) setTimeout(() => end(null, 'killed'), 5000).unref(); });
  const end = (status, signal) => {
    if (ended) return; ended = true; clearTimeout(cap);
    process.stdout.write(Buffer.concat(buf));
    console.log(`ci-suite: done ${f}`);
    const hang = hung ? { file: f, name: `no exit within the ${capS} s per-file cap (killed)` } : null;
    const fails = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .map(x => ({ file: x.file ? fwd(path.relative(process.cwd(), x.file)) : f, name: x.name })) : hung ? [] : null;
    const procs = listProcs(), left = procsNaming([ft], procs);
    for (const p of left) killTree(p.pid, { killer: `ci-suite pid ${process.pid}`, reason: `${f}: left alive after the file (its command line names ${fwd(ft)})` });
    const leak = left.length ? { file: f, name: `left ${left.length} process(es) alive after the file: ${leakText(left, procs)}` } : null;
    resolve({ f, status, signal, fails, leak, hang });
  };
  child.on('close', end);
});
const phase = async (name, c, files) => {
  console.log(`ci-suite: ${name} phase: ${name === 'serial' ? files.join(' ') : `${files.length} file(s)`}, concurrency ${c}`);
  const t0 = Date.now(), res = [], todo = files.map((f, i) => [f, i]);
  const worker = async () => { while (todo.length) { const [f, i] = todo.shift(); res.push(await runFile(name, f, i)); } };
  await Promise.all(Array.from({ length: Math.max(1, Number(c) || 1) }, worker));
  const status = Math.max(0, ...res.map(r => r.status ?? 1));
  console.log(`ci-suite: ${name} phase took ${((Date.now() - t0) / 1000).toFixed(2)} s (exit ${status})`);
  const none = res.find(r => !r.fails);
  if (none) { console.error(`ci-suite: ${none.f} wrote no result (exit ${none.status}, signal ${none.signal})`); process.exit(2); }
  const quiet = res.filter(r => r.status !== 0 && !r.fails.length && !r.hang).map(r => r.f);
  return { name, status, quiet, fails: res.flatMap(r => r.fails), leaks: res.map(r => r.leak).filter(Boolean), hangs: res.map(r => r.hang).filter(Boolean) };
};
// CI 44335427788: a fresh runner's first browser launch is slow (ubuntu: 25-36 s; two at once passed the 30 s DevTools wait). With a
// browser test in the run, one launch to the DevTools port and down goes first: the one-time cost lands here, measured, not on a
// test's clock. A failed warm-up is logged and the suite goes on: the browser tests then fail with their own message.
if (files.some(isBrowserFile)) {
  const { findBrowser, warmBrowser } = await import('../lib/shot.mjs'), browser = findBrowser();
  if (browser) { const w = await warmBrowser({ browser, tmp });
    console.log(`ci-suite: browser warm-up ${w.ms} ms (${browser.exe})${w.error ? `, failed: ${w.error}` : ''}`);
    if (w.ms > 5000 && !w.error && w.stderr) console.log(`ci-suite: the slow warm-up's browser stderr ends:\n${w.stderr}`); }
}
const runs = [];
if (parFiles.length) runs.push(await phase('parallel', conc, parFiles));
if (serFiles.length) runs.push(await phase('serial', '1', serFiles));
filesDone = true;   // every file ended and its leftovers were swept (runFile)
const j = judge(runs.flatMap(r => r.fails), list);
for (const f of j.listed) console.log(`listed red: ${f.file} :: ${f.name}`);
for (const k of j.fixed) console.log(`listed red now passes (remove it): ${k.file} :: ${k.name}`);
for (const f of j.fresh) console.log(`NEW RED: ${f.file} :: ${f.name}`);
const leaks = runs.flatMap(r => r.leaks);
for (const f of leaks) console.log(`LEAK RED: ${f.file} :: ${f.name}`);
const hangs = runs.flatMap(r => r.hangs);
for (const f of hangs) console.log(`HANG RED: ${f.file} :: ${f.name}`);
console.log(`ci-suite: ${j.listed.length} listed red(s), ${j.fresh.length} new, ${leaks.length} leak(s), ${hangs.length} hang(s)`);
for (const r of runs) for (const f of r.quiet) { console.error(`ci-suite: ${f} (${r.name} phase) exited non-zero with no red reported`); process.exit(1); }
process.exit(j.ok && !leaks.length && !hangs.length ? 0 : 1);
