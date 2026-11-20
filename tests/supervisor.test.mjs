// NORN-WATCH S5 (DIR-83, DEC-683): runs that end badly leave evidence, and a run's whole process tree ends with it. FAKE executor,
// temp dirs and temp git repos only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startRun, sweepLost } from '../engine/lib/runs.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { jobguardExe, jobguardExeAsync, winQuote, holdGone } from '../engine/lib/jobguard.mjs';
import { killsFile, readKills } from '../engine/lib/kills.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 30000) {
  const t0 = performance.now();
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

function sandbox() {
  const t = mkTmp('meta-sup-');
  const d = { t, state: path.join(t, 'state', 'demo'), locks: path.join(t, 'state', 'locks'), wt: path.join(t, 'wt'), notes: path.join(t, 'NOTES.md') };
  for (const k of ['state', 'locks', 'wt']) fs.mkdirSync(d[k], { recursive: true });
  d.brief = body => { const f = path.join(t, `brief-${Math.random().toString(36).slice(2)}.md`); fs.writeFileSync(f, body); return f; };
  d.run = (brief, o = {}) => startRun({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt, notes: d.notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0, trigger_on_exit: false }, budget: {}, brief: d.brief(brief), ...o }).run;
  d.end = async id => waitFor(() => { const it = loadState(d.state).items[id]; return settled(it) && it.history.find(h => h.ev === 'end'); });   // + its supervisor gone (FINDING L1)
  return d;
}
function repo(dir) {
  git(dir, 'init', '-q', '-b', 'feat/x'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); git(dir, 'add', 'a.txt'); git(dir, 'commit', '-q', '-m', 'a');
}

test('S5 end evidence: exit 143 with no kill event = external_term; a dirty git worktree = counts + branch + head at the end', async () => {
  const d = sandbox();
  repo(d.wt);
  fs.writeFileSync(path.join(d.wt, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(d.wt, 'new1.txt'), 'n'); fs.writeFileSync(path.join(d.wt, 'new2.txt'), 'n');
  const head = git(d.wt, 'rev-parse', 'HEAD');
  const e = (await d.end(d.run('mode: term\n'))).data;
  assert.equal(e.exit, 143); assert.equal(e.outcome, 'crash');
  assert.equal(e.external_term, true);
  assert.deepEqual(e.dirty, { files: 1, untracked: 2 });
  assert.equal(e.branch, 'feat/x'); assert.equal(e.head, head);
  const ok = (await d.end(d.run('mode: done\n'))).data;
  assert.equal(ok.external_term, undefined, 'a clean exit is no external kill');
});

test('S5 end evidence: a worktree git cannot read = no dirty / branch / head fields, the end is still recorded', async () => {
  const d = sandbox();   // d.wt is a plain folder (git fails there, or finds no repo)
  const e = (await d.end(d.run('mode: done\n'))).data;
  assert.equal(e.outcome, 'done');
  for (const k of ['dirty', 'branch', 'head']) assert.equal(e[k], undefined, k);
});

// DEC-1088: the end record keeps WHICH processes were reaped (pid + image), not a count; each has its receipt in kills.jsonl
test('S5 reap: an orphaned grandchild (its parent already exited) dies with the run; the end lists the reaped pids + images, each receipted', { skip: process.platform !== 'win32' && 'job objects: Windows; POSIX = process group' }, async () => {
  const d = sandbox();
  const pids = path.join(d.t, 'pids.json');
  const id = d.run(`mode: orphan\npids: ${pids}\n`);
  const e = (await d.end(id)).data;
  const p = JSON.parse(fs.readFileSync(pids, 'utf8'));
  await waitFor(() => !alive(p.orphan), 5000).catch(() => {});
  assert.equal(alive(p.orphan), false, `orphan ${p.orphan} still alive after the run ended`);
  assert.ok(e.reaped.some(k => k.pid === p.orphan && /^node(\.exe)?$/i.test(k.image)), `reaped ${JSON.stringify(e.reaped)}`);
  const rec = readKills(killsFile(d.state)).find(k => k.pid === p.orphan);
  assert.equal(rec?.action, 'kill'); assert.equal(rec.reason, `reap: ${id} ended`); assert.match(rec.killer, new RegExp(`^${id} supervisor \\d+$`));
  assert.match(rec.job, /^meta-run-/);
});

test('S5 jobguard: a held process keeps itself, reap kills its job; spawnOutside escapes the job', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  assert.ok(jobguardExe(), 'csc.exe of .NET Framework 4 compiles the helper');
  assert.equal(winQuote('a b"c\\'), '"a b\\"c\\\\"');
  const t = mkTmp('meta-jg-'), out = path.join(t, 'out.json');
  const lib = new URL('../engine/lib/jobguard.mjs', import.meta.url).href;
  const src = `import { holdJob, reapJob, spawnOutside } from ${JSON.stringify(lib)};
import { spawn } from 'node:child_process'; import fs from 'node:fs';
const job = await holdJob(process.pid);
const inside = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { detached: true, stdio: 'ignore' }); inside.unref();
const outside = spawnOutside(process.execPath, ['-e', 'setTimeout(()=>{},60000)']);
const r = reapJob(job);
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ error: job.error, inside: inside.pid, outside, r }));
process.exit(0);`;
  const f = path.join(t, 'held.mjs'); fs.writeFileSync(f, src);
  const c = spawn(process.execPath, [f], { stdio: 'ignore' });
  await new Promise(r => c.on('exit', r));
  const o = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(o.error, undefined);
  assert.ok(o.r.killed.some(k => k.pid === o.inside));
  await waitFor(() => !alive(o.inside), 5000).catch(() => {});
  assert.equal(alive(o.inside), false);
  assert.equal(o.outside.breakaway, true);
  assert.equal(alive(o.outside.pid), true, 'the breakaway process lives on');
  process.kill(o.outside.pid);
});

// LEAK RED (CI 44141688462 mergelock, 43996467416 queue, Windows): a `jobguard hold` was alive after its test file, its supervisor
// gone. The hold now ends with the held process itself, not only at stdin EOF: here its stdin stays open in THIS process (as an
// inherited pipe end would), the held process exits, and the hold must follow. And holdGone(job) resolves once the hold has exited.
test('jobguard hold: ends when the held process exits even while its stdin stays open; holdGone waits for its exit', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const exe = jobguardExe({ dir: mkTmp('meta-jgh-') });
  assert.ok(exe, 'csc.exe of .NET Framework 4 compiles the helper');
  const held = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise(r => held.once('spawn', r));
  const hold = spawn(exe, ['hold', String(held.pid), `meta-test-${held.pid}-${Date.now()}`], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  try {
    let out = '';
    await new Promise((res, rej) => { hold.stdout.on('data', d => { out += d; if (/^ok/m.test(out)) res(); if (/^err/m.test(out)) rej(new Error(out)); }); hold.once('exit', c => rej(new Error(`hold exited ${c}: ${out}`))); });
    const gone = new Promise(r => hold.once('exit', r));
    held.kill();   // the held process ends; the hold's stdin is still open here
    assert.equal(await Promise.race([gone.then(() => true), new Promise(r => setTimeout(() => r(false), 20000))]), true, 'the hold exited with the held process');
  } finally { try { hold.kill(); } catch { /* gone */ } try { held.kill(); } catch { /* gone */ } }
  // CI 44343850063 (queue: a stop right after the start): the supervisor died while its hold started. A hold given a pid that is gone
  // (or reused by a later process) refuses with "err" and exits, its stdin still open here - it never waits on a stranger
  const dead = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(r => dead.once('exit', r));
  const late = spawn(exe, ['hold', String(dead.pid), `meta-test-${dead.pid}-${Date.now()}`], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  try {
    let out = ''; late.stdout.on('data', d => { out += d; });
    const code = await Promise.race([new Promise(r => late.once('exit', r)), new Promise(r => setTimeout(() => r('alive'), 20000))]);
    assert.equal(code, 1, `the hold of a gone pid exits 1 (${out.trim()})`); assert.match(out, /^err /m);
  } finally { late.kill(); }   // a no-op (false) once it has exited
  const p = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => setTimeout(() => process.exit(0), 200))'], { stdio: ['pipe', 'ignore', 'ignore'] });
  await new Promise(r => p.once('spawn', r));
  assert.equal(await holdGone({ proc: p }), true, 'holdGone ends its stdin and resolves at its exit');
  assert.ok(p.exitCode !== null, 'exited before holdGone resolved');
});

// CI-RED-D5B3788 (agnostic delegate --mode, Windows): holdJob compiled the helper with a blocking spawnSync (csc, cap 60 s) right after
// the supervisor's first beat - in a fresh TEMP (every ci-suite file's first run) its heartbeat stopped for the whole compile and a
// 3 s staleMs sweep marked the live parent lost. The compile is async: the event loop (the beat timer) runs through it.
test('jobguard: the first-use csc compile does not block the event loop (the heartbeat beats through it)', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = mkTmp('meta-jgc-');
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 5);
  const p = jobguardExeAsync({ dir });
  assert.ok(p instanceof Promise, 'async: returns before the compile ends');
  const exe = await p;
  clearInterval(iv);
  assert.ok(exe && fs.existsSync(exe), 'compiled into the given dir');
  assert.ok(ticks >= 3, `the timer ran ${ticks} time(s) during the compile`);
  assert.equal(await jobguardExeAsync({ dir }), exe, 'cached: the same exe, no second compile');
  assert.equal(jobguardExe({ dir }), exe, 'the sync lookup finds the same cache');
});

// CI-RED-7D65D2D (DEC-383, Windows LEAK RED): a `hold` outlived its supervisor - it waited only for stdin EOF, and while anything
// still held the write end of its stdin it never saw one. The hold also waits on the supervisor's process handle (SYNCHRONIZE) and
// exits on whichever comes first; a supervisor already gone at start = exit at once.
test('jobguard hold exits when its supervisor dies even while its stdin write end stays open elsewhere', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const exe = jobguardExe({ dir: mkTmp('meta-jgp-') });
  assert.ok(exe, 'csc.exe of .NET Framework 4 compiles the helper');
  const sup = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore', windowsHide: true });
  const hold = spawn(exe, ['hold', String(sup.pid), `meta-jgp-${sup.pid}-${Date.now()}`], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const exited = new Promise(r => hold.on('exit', r));
  try {
    let out = '';
    await new Promise((res, rej) => { hold.stdout.on('data', d => { out += d; if (/^(ok|err)/m.test(out)) res(); }); hold.on('exit', () => rej(new Error(`hold exited: ${out}`))); });
    assert.match(out, /^ok/m);
    sup.kill();   // the supervisor dies; this test still holds the hold's stdin write end open
    const r = await Promise.race([exited.then(() => 'exited'), sleep(5000).then(() => 'alive')]);
    assert.equal(r, 'exited', `hold ${hold.pid} still alive 5 s after its supervisor ${sup.pid} died`);
    const gone = spawn(exe, ['hold', String(sup.pid), `meta-jgp-gone-${Date.now()}`], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const r2 = await Promise.race([new Promise(res => gone.on('exit', () => res('exited'))), sleep(5000).then(() => 'alive')]);
    if (r2 !== 'exited') gone.kill();
    assert.equal(r2, 'exited', 'a hold whose supervisor is already gone exits at once');
  } finally { try { hold.stdin.end(); } catch { /* the hold already exited and closed its stdin: nothing to end, the kills below still run */ } if (hold.exitCode === null) hold.kill(); if (sup.exitCode === null) sup.kill(); }
});

test('K3 round 2: a run the supervisor starts itself (auto-resume) breaks away from the supervisor\'s own job', { skip: process.platform !== 'win32' && 'job objects: Windows only' }, async () => {
  const d = sandbox();
  const id = d.run('mode: handoff-once\nms: 300\n', { policy: { auto_resume_max: 1, trigger_on_exit: false } });
  const next = await waitFor(() => loadState(d.state).items[id]?.resume?.next);
  await d.end(next);
  const log = fs.readFileSync(loadState(d.state).items[id].data.log, 'utf8');
  assert.match(log, new RegExp(`auto-resume -> ${next} \\(1/1\\) breakaway`), log);
});

test('S5 doctor strays: old headless browsers / node in an ended run\'s worktree with no live run above them; live, young or unrelated ones are not', async () => {
  const { strays, strayLine } = await import('../engine/lib/strays.mjs');
  const now = Date.parse('2026-11-09T12:00:00Z'), h = n => now - n * 3600e3;
  const procs = [
    { pid: 1, ppid: 0, name: 'explorer.exe', created: h(50), cmd: 'explorer' },
    { pid: 10, ppid: 999, name: 'msedge.exe', created: h(10), cmd: 'msedge.exe --headless=new --user-data-dir=X' },        // orphan: stray
    { pid: 11, ppid: 10, name: 'msedge.exe', created: h(10), cmd: 'msedge.exe --type=renderer --headless' },                // its child: stray too
    { pid: 12, ppid: 1, name: 'msedge.exe', created: h(10), cmd: 'msedge.exe' },                                              // a person's browser
    { pid: 20, ppid: 30, name: 'msedge.exe', created: h(10), cmd: 'msedge.exe --headless' },                                 // under a live run
    { pid: 30, ppid: 1, name: 'node.exe', created: h(10), cmd: 'node supervisor.mjs' },
    { pid: 40, ppid: 999, name: 'node.exe', created: h(9), cmd: 'node C:\\wt\\vis\\tools\\shot.mjs' },                         // ended run's worktree
    { pid: 41, ppid: 999, name: 'node.exe', created: h(9), cmd: 'node C:\\meta\\engine\\bin\\norn.mjs dash' },                // the dash: not a run's
    { pid: 42, ppid: 999, name: 'node.exe', created: h(9), cmd: 'node C:\\wt\\vis-dlv\\x.mjs' },                              // another worktree (prefix only)
    { pid: 50, ppid: 999, name: 'msedge.exe', created: h(2), cmd: 'msedge.exe --headless' },                                 // young
  ];
  const s = strays(procs, { live: new Set([30]), ended: [{ run: 'RUN-7', worktree: 'c:/wt/vis', ts: 'x' }], now, self: -1 });
  assert.deepEqual(s.map(x => [x.pid, x.kind, x.run]), [[10, 'browser', null], [11, 'browser', null], [40, 'node', 'RUN-7']]);
  assert.match(strayLine(s[2]), /pid 40 node\.exe 9 h old, no live run \(worktree of ended RUN-7\)/);
});

test('S5 durable lane output: a --notes path under a gitignored folder of the worktree = a recorded start warning; elsewhere none', async () => {
  const d = sandbox();
  repo(d.wt);
  fs.writeFileSync(path.join(d.wt, '.gitignore'), 'ux/\n'); fs.mkdirSync(path.join(d.wt, 'ux'));
  const notes = path.join(d.wt, 'ux', 'NOTES.md');
  const r = startRun({ state: d.state, locksDir: d.locks, executor: 'fake', lane: 'demo', worktree: d.wt, notes, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0, trigger_on_exit: false }, budget: {}, brief: d.brief('mode: done\n') });
  assert.match(r.warnings?.[0] || '', /gitignored.*worktree remove/);
  await d.end(r.run);
  assert.deepEqual(loadState(d.state).items[r.run].data.warnings, r.warnings);
  const ok = d.run('mode: done\n');   // notes outside the worktree
  await d.end(ok);
  assert.equal(loadState(d.state).items[ok].data.warnings, undefined);
});

// CHECKIN-V2 piece 4: a trial check-in (spec.fallback) that ends non-DONE (crash / limit / an empty final) is re-run on the
// fallback executor at once; the new run records fallback_of and becomes the gate baseline; a DONE trial tick has no fallback
test('trial check-in: a non-DONE tick falls back to its fallback executor (fallback_of recorded, gate baseline moved); DONE = none', async () => {
  const { readGate, noteCheckin } = await import('../engine/lib/gate.mjs');
  const d = sandbox();
  const ck = (brief, fb) => d.run(brief, { kind: 'checkin', lane: 'checkin', lock: false, notes: undefined, trial: 'codex-sol', fallback: fb });
  const id = ck('mode: crash\n', { executor: 'fake', model: 'claude-opus-5-5', effort: 'medium', brief: d.brief('mode: done\n') });   // the fake stands in for both executors
  noteCheckin(d.state, { run: id, start: loadState(d.state).items[id].created, live: { band: 1 }, budget: { max_codex: 2 }, forced: true, quiet_n: 1 });
  assert.equal((await d.end(id)).data.outcome, 'crash');
  const fb = await waitFor(() => Object.values(loadState(d.state).items).find(i => i.kind === 'run' && i.data.fallback_of === id));
  assert.equal(fb.data.kind, 'checkin'); assert.equal(fb.data.model, 'claude-opus-5-5'); assert.equal(fb.data.trial, undefined);
  assert.equal((await d.end(fb.id)).data.outcome, 'done');
  const g = readGate(d.state);
  assert.equal(g.run, fb.id); assert.deepEqual(g.live, { band: 1 }); assert.deepEqual(g.caps, { max_codex: 2 }); assert.equal(g.quiet_n, 1);
  const ok = ck('mode: done\n', { executor: 'fake' });
  await d.end(ok);
  await sleep(500);
  assert.equal(Object.values(loadState(d.state).items).filter(i => i.kind === 'run' && i.data.fallback_of === ok).length, 0);
});

// CI-RED-18A9C0A R2 (ask.test cold, CI: "RUN-2 lost (heartbeat 5 s old)"): the supervisor's OS start-time probe (a PowerShell
// spawn on Windows, 0.5-2.4 s on a slow runner) ran SYNC before its first beat - until it returned only the launcher's birth hb
// existed and a 3 s staleMs sweep marked the healthy run lost. META_TEST_PROBE_DELAY_MS makes the probe slower than staleMs.
test('a slow start-time probe: the supervisor beats first - no lost sweep before its first beat; the end names the start time once known', async () => {
  const d = sandbox();
  const prev = process.env.META_TEST_PROBE_DELAY_MS;
  process.env.META_TEST_PROBE_DELAY_MS = '4500';
  let id;
  try { id = d.run('mode: done\n'); } finally { if (prev === undefined) delete process.env.META_TEST_PROBE_DELAY_MS; else process.env.META_TEST_PROBE_DELAY_MS = prev; }
  const swept = [];
  const it = await waitFor(() => { swept.push(...sweepLost(d.state, { staleMs: 3000 })); const x = loadState(d.state).items[id]; return settled(x) && x; }, 30000);
  assert.deepEqual(swept, [], 'never swept lost while its probe ran');
  const end = it.history.find(h => h.ev === 'end')?.data;
  assert.equal(end?.outcome, 'done', JSON.stringify(it.history.map(h => h.ev)));
  assert.ok(Number.isFinite(end.supervisor_started), 'the end waits for the start time and names it');
});
