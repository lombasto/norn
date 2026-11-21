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
// as <tmp>/meta-jobguard-<source sha>.exe (bounded.mjs, with boundedSync). No csc / compile failure = null: the run goes on unguarded
// and says so in its log.
import { spawn, spawnSync, execFile } from 'node:child_process';
import { jobguardCached, jobguardExe, jobguardExeAsync, winQuote } from './bounded.mjs';
import { receiptsOf, writeReceipts, jsonLines } from './kills.mjs';
import { listProcs, imageOf } from './strays.mjs';

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

/** kill every process of the job but `keep`; KILL_ON_JOB_CLOSE off and breakaway allowed afterwards (the run is over). Each target is receipted first in rc's file
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

/** start exe + args OUTSIDE the caller's job (detached, no window). `job` (the run's job, META_JOB) allows breakaway for this one
 * start only (jobguard.cs). Returns { pid, breakaway } or null when it cannot (the caller then spawns as before). `strict` (an
 * independent run, RM-48 S1): never inside - a child still in `job` is ended unrun, the result { refused: why } */
export function spawnOutside(exePath, args, { cwd = process.cwd(), exe = jobguardExe(), job = process.env.META_JOB, strict = false } = {}) {
  if (!exe) return null;
  const r = spawnSync(exe, ['spawn', job || '-', cwd, [exePath, ...args].map(winQuote).join(' '), ...(strict ? ['away'] : [])], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const m = /^pid (\d+) (breakaway|inside)/m.exec(r.stdout || ''), no = /^refused (.*?)\r?$/m.exec(r.stdout || '');
  return m ? { pid: Number(m[1]), breakaway: m[2] === 'breakaway' } : no ? { refused: no[1] } : null;
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
    .map(m => ({ pid: +m[1], ppid: +m[2], name: imageOf(m[1], m[4]), cmd: m[5] }));
}
