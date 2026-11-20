// NORN-WATCH S5 (DEC-683): every descendant of a run dies with the run. A tree walk at the end misses orphans (VISUAL-A2's shot tool
// left 20 headless Edge alive 10 h: their parents had exited), so membership is decided at birth:
//   Windows: the supervisor puts ITSELF in a named Job Object before it spawns the executor (jobguard.cs `hold`, KILL_ON_JOB_CLOSE);
//            every process born below it is in the job, parent alive or not. At its end `reap` kills all but the supervisor and
//            clears KILL_ON_JOB_CLOSE (its after-end spawns - tick, auto-resume - live on); DEC-1088: only through a handle re-checked
//            as a job member, each target receipted in <state>/kills.jsonl first (kills.mjs). The supervisor dying = the hold process
//            sees stdin EOF, its handle closes, the job kills the rest. An independent run started from inside (norn run / a queue
//            fill) breaks away (jobguard `spawn`, CREATE_BREAKAWAY_FROM_JOB); a helper of the run stays inside and dies with it.
//   POSIX:   the executor is its own process group (spawn detached); the end kills the group (setsid escapes: documented gap).
// The helper is C# compiled on first use with the csc.exe of .NET Framework 4 (every Windows 10 / 11; no native npm build), cached
// as <tmp>/meta-jobguard-<source sha>.exe. No csc / compile failure = null: the run goes on unguarded and says so in its log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { receiptsOf, writeReceipts, jsonLines } from './kills.mjs';
import { listProcs } from './strays.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jobguard.cs');
const CSC = ['Framework64', 'Framework'].map(f => path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'));

// the cached helper path + what a compile needs: { exe } when cached, { exe, c, tmp } to compile, null when it cannot be had
function jobguardPlan({ platform, dir, csc }) {
  if (platform !== 'win32') return null;
  let src;
  try { src = fs.readFileSync(SRC); } catch { return null; }
  const exe = path.join(dir, `meta-jobguard-${crypto.createHash('sha256').update(src).digest('hex').slice(0, 12)}.exe`);
  if (fs.existsSync(exe)) return { exe };
  const c = csc.find(f => fs.existsSync(f));
  return c ? { exe, c, tmp: `${exe}.${process.pid}.tmp.exe` } : null;
}
const CSC_ARGS = tmp => ['-nologo', '-optimize', `-out:${tmp}`, SRC];
function jobguardSettle(p, ok) {
  if (!ok || !fs.existsSync(p.tmp)) { try { fs.unlinkSync(p.tmp); } catch { /* none */ } return null; }
  try { fs.renameSync(p.tmp, p.exe); } catch { try { fs.unlinkSync(p.tmp); } catch { /* a racer won */ } }
  return fs.existsSync(p.exe) ? p.exe : null;
}

/** the helper's path when it is already compiled (never compiles), else null: kills.mjs lists processes with it, without a stall */
export function jobguardCached({ platform = process.platform, dir = os.tmpdir(), csc = CSC } = {}) {
  const p = jobguardPlan({ platform, dir, csc });
  return p && !p.c ? p.exe : null;
}

/** every process now, [{ pid, ppid, name, cmd }] (a kill's receipts, kills.mjs): the compiled helper's `procs` (~0.2 s), else
 * strays.listProcs (PowerShell CIM / ps) */
export function procList() {
  const exe = jobguardCached();
  if (exe) { const r = spawnSync(exe, ['procs'], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64 << 20 }); if (r.status === 0) return jsonLines(r.stdout); }
  return listProcs();
}
/** procList off the event loop (killTreeAsync: the dash server) */
export function procListAsync() {
  const exe = jobguardCached();
  if (!exe) return Promise.resolve(listProcs());
  return new Promise(ok => execFile(exe, ['procs'], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64 << 20 }, (e, out) => ok(e ? listProcs() : jsonLines(out))));
}

/** the compiled helper's path (compiled once per source version), or null off Windows / without csc. Blocks while it compiles:
 * a process with a heartbeat (the supervisor) uses jobguardExeAsync */
export function jobguardExe({ platform = process.platform, dir = os.tmpdir(), csc = CSC } = {}) {
  const p = jobguardPlan({ platform, dir, csc });
  if (!p?.c) return p?.exe ?? null;
  const r = spawnSync(p.c, CSC_ARGS(p.tmp), { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return jobguardSettle(p, r.status === 0);
}

/** jobguardExe without blocking the event loop (CI-RED-D5B3788: a first-use compile in a fresh TEMP stopped the supervisor's
 * heartbeat for the whole csc run - seconds under load - and a sweep marked the live run lost). Resolves the path or null. */
export function jobguardExeAsync({ platform = process.platform, dir = os.tmpdir(), csc = CSC, timeoutMs = 60000 } = {}) {
  const p = jobguardPlan({ platform, dir, csc });
  if (!p?.c) return Promise.resolve(p?.exe ?? null);
  return new Promise(res => {
    let child, done = false;
    const resolve = ok => { if (!done) { done = true; res(jobguardSettle(p, ok)); } };
    try { child = spawn(p.c, CSC_ARGS(p.tmp), { stdio: 'ignore', windowsHide: true, timeout: timeoutMs }); }
    catch { return resolve(false); }
    child.on('error', () => resolve(false));
    child.on('exit', code => resolve(code === 0));
  });
}

/** put `pid` (the caller) in a new named job; resolves { name, exe, proc } or { error } (never rejects) */
export async function holdJob(pid, { exe, name = `meta-run-${pid}-${Date.now()}`, timeoutMs = 15000 } = {}) {
  if (exe === undefined) exe = await jobguardExeAsync();
  if (!exe) return Promise.resolve({ error: 'no jobguard helper (not Windows, or no .NET Framework csc.exe)' });
  return new Promise(resolve => {
    let buf = '', done = false;
    // a failed / timed-out hold is ended: left running it would still put the caller in a job nobody reaps, and outlive it
    const end = v => { if (!done) { done = true; clearTimeout(t); if (v.error) { try { proc?.kill(); } catch { /* gone */ } } resolve(v); } };
    let proc;
    try { proc = spawn(exe, ['hold', String(pid), name], { detached: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
    catch (e) { return end({ error: e.message }); }
    const t = setTimeout(() => end({ error: 'jobguard hold timed out' }), timeoutMs);
    proc.on('error', e => end({ error: e.message }));
    proc.stdout.on('data', d => {
      buf += d;
      if (/^ok/m.test(buf)) { proc.stdout.removeAllListeners('data'); proc.stdout.destroy(); proc.unref(); end({ name, exe, proc }); }
      else if (/^err/m.test(buf)) end({ error: buf.trim() });
    });
  });
}

/** kill every process of the job but `keep`; KILL_ON_JOB_CLOSE off afterwards. Each target is receipted first in rc's file
 * (kills.mjs receiptsOf: rc { file | state, killer, reason }); a pid whose handle is no job member is skipped (`also`: pids added to
 * the job's list, the test seam). Returns { killed: [{ pid, image }], skipped: [{ pid, image }] } or { error } */
export function reapJob(job, keep = process.pid, rc = {}) {
  if (!job?.name) return { error: job?.error || 'no job' };
  const args = ['reap', job.name, String(keep), receiptsOf(rc), rc.killer || `supervisor ${keep}`, rc.reason || 'reap', ...(rc.also?.length ? [rc.also.join(',')] : [])];
  const r = spawnSync(job.exe, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const out = String(r.stdout || ''), rows = verb => [...out.matchAll(new RegExp(`^${verb} (\\d+) ?(.*?)\\r?$`, 'gm'))].map(m => ({ pid: Number(m[1]), image: m[2] }));
  try { job.proc?.stdin?.end(); } catch { /* gone */ }
  return /^reaped \d+/m.test(out) ? { killed: rows('killed'), skipped: rows('skipped') } : { error: String(out || r.error?.message || `exit ${r.status}`).trim().slice(0, 200) };
}

// MSVCRT command-line quoting of one argument (CommandLineToArgvW rules)
export function winQuote(a) {
  if (a !== '' && !/[\s"]/.test(a)) return a;
  let out = '"', bs = 0;
  for (const ch of a) {
    if (ch === '\\') { bs++; continue; }
    if (ch === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
    out += '\\'.repeat(bs) + ch; bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}

/** start exe + args OUTSIDE the caller's job (detached, no window). `job` (the run's job, META_JOB) allows breakaway for this one
 * start only (jobguard.cs). Returns { pid, breakaway } or null when it cannot (the caller then spawns as before). */
export function spawnOutside(exePath, args, { cwd = process.cwd(), exe = jobguardExe(), job = process.env.META_JOB } = {}) {
  if (!exe) return null;
  const r = spawnSync(exe, ['spawn', job || '-', cwd,[exePath, ...args].map(winQuote).join(' ')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const m = /^pid (\d+) (breakaway|inside)/m.exec(r.stdout || '');
  return m ? { pid: Number(m[1]), breakaway: m[2] === 'breakaway' } : null;
}

// proc-hygiene (B, C; census 2026-11-19): the 33 git.exe and 7 powershell.exe found orphaned had never run - one thread, SUSPENDED,
// no CPU: their parent (a node of Norn, gh, Git's cmd\git.exe launcher) was killed between CreateProcess and the resume (a taskkill
// /T, a spawnSync timeout, a reap). No timeout on the direct child reaches them; a job does. boundedSync runs the child under
// `jobguard run`, whose own job holds every descendant from birth and dies at the timeout, at the child's exit, or with the helper.
let jgExe;
const PATHEXT = ['.exe', '.com'];
// the program's full path from PATH (CreateProcess would search the cwd first: a worktree's git.exe must never run); else as given
function resolveExe(file, env = process.env) {
  if (/[\\/]/.test(file)) return file;
  const p = env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  const names = path.extname(file) ? [file] : PATHEXT.map(e => file + e);
  for (const d of p.split(';').filter(Boolean)) for (const n of names) { const f = path.join(d.replace(/"/g, ''), n); if (fs.existsSync(f)) return f; }
  return file;
}
/** spawnSync's shape ({ status, signal, stdout, stderr, error }) with a timeout that kills the child's whole tree (Windows: jobguard
 * run; POSIX or no helper: spawnSync's own timeout, direct child only). opts: timeout (ms, required), cwd, env, input, encoding, maxBuffer */
export function boundedSync(file, args, { timeout, cwd, env, input, encoding = 'utf8', maxBuffer = 64 << 20, exe } = {}) {
  if (!(timeout > 0)) throw new Error('boundedSync needs a timeout');
  const base = { cwd, env, encoding, maxBuffer, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) };
  if (exe === undefined) exe = process.platform === 'win32' ? (jgExe ??= jobguardExe() || '') : '';
  if (!exe) return spawnSync(file, args, { ...base, timeout });
  const r = spawnSync(exe, ['run', String(timeout), cwd || '-', [resolveExe(file, env), ...args].map(winQuote).join(' ')], { ...base, timeout: timeout + 10000 });
  const e = String(r.stderr || '');
  if (r.status === 124 && /^jobguard-timeout/m.test(e)) return { ...r, status: null, signal: 'SIGTERM', error: Object.assign(new Error(`spawnSync ${file} ETIMEDOUT`), { code: 'ETIMEDOUT' }) };
  if (r.status === 127 && /^jobguard-err/m.test(e)) return { ...r, status: null, error: Object.assign(new Error(`spawnSync ${file} ENOENT (${e.trim()})`), { code: 'ENOENT' }) };
  return r;
}

/** the hold process's exit (its stdin ended by reapJob, or the held process gone), at most ms: a supervisor awaits it before its
 * own exit, so "the supervisor is gone" (settled) means its hold is gone too - never a hold seen alive after the file (LEAK RED) */
export function holdGone(job, ms = 5000) {
  const p = job?.proc;
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve(true);
  try { p.stdin?.end(); } catch { /* gone */ }
  return new Promise(r => { const t = setTimeout(() => r(false), ms); t.unref?.(); p.once('exit', () => { clearTimeout(t); r(true); }); });
}

/** POSIX: kill the executor's process group (it was spawned detached = group leader), its members receipted first (rc as reapJob;
 * the group's own pids by `ps -o pgid`). Returns { killed: [{ pid, image }] } or { error } */
export function reapGroup(pgid, rc = {}, { list = groupProcs } = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) return { killed: [] };
  const rows = list(pgid);
  try { writeReceipts(rows, rc); } catch (e) { return { error: `no receipt, no kill: ${e.message}` }; }
  try { process.kill(-pgid, 'SIGKILL'); return { killed: rows.map(p => ({ pid: p.pid, image: p.name })) }; } catch (e) { return e.code === 'ESRCH' ? { killed: [] } : { error: e.message }; }
}
function groupProcs(pgid) {
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,pgid=,comm=,args='], { encoding: 'utf8', timeout: 15000, maxBuffer: 64 << 20, windowsHide: true });
  return String(r.stdout || '').split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)).filter(m => m && +m[3] === pgid)
    .map(m => ({ pid: +m[1], ppid: +m[2], name: path.basename(m[4]), cmd: m[5] }));
}
