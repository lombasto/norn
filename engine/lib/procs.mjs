// Process identity: is a pid running, and when did it start (Windows reuses pids, so a pid plus its start time names one process).
// The supervisor, the gate lock and `norn run --wait` use it to tell their own process from a later one that took the same pid.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** Process start time (ms since epoch) of a live pid, or null when it does not run. */
const startProbe = (pid, platform) => platform === 'win32'
  ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: 30000 }]
  : ['ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }];
const probeable = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  return true;
};
/** the pid runs: kill(pid, 0) answers AND (Linux) it is no zombie. An exited child whose parent has not reaped it yet - the parent
 * blocked in Atomics.wait, so libuv never handled SIGCHLD - still answers kill(pid, 0): `norn run --wait` waited its whole 120 s net
 * for every run on Linux (CI ubuntu: four OOTB tests at 121 s each, 2.5 s on Windows). /proc/<pid>/stat state Z = gone. */
export function running(pid, { proc = '/proc' } = {}) {
  if (!probeable(pid)) return false;
  const st = read(path.join(proc, String(pid), 'stat'));
  return !(st && /^Z/.test(st.slice(st.lastIndexOf(')') + 2)));
}
const startOf = (status, stdout, platform) => { const t = Date.parse((stdout || '').trim() + (platform === 'win32' ? '' : ' UTC')); return status === 0 && Number.isFinite(t) ? t : null; };
// Linux (CI-RED-C1159BD R1): `ps -o lstart=` has whole seconds, so a process and the one it spawned 0.2 s later had the same start
// time (a reused pid read as ours). /proc/<pid>/stat field 22 = starttime in clock ticks since boot (USER_HZ), + /proc/stat btime.
let clkTck = null;
const userHz = () => clkTck ??= (n => Number.isInteger(n) && n > 0 ? n : 100)(Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout));
function linuxStart(pid, { proc = '/proc', hz } = {}) {
  const stat = read(path.join(proc, String(pid), 'stat')), bt = /^btime (\d+)$/m.exec(read(path.join(proc, 'stat')) || '');
  if (!stat || !bt) return null;
  const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);   // fields after "(comm)" start at field 3 (state)
  return Number.isFinite(ticks) ? Number(bt[1]) * 1000 + Math.round(ticks * 1000 / (hz ?? userHz())) : null;
}
export function procStart(pid, platform = process.platform, linux = {}) {
  if (!probeable(pid)) return null;
  if (platform === 'linux') return linuxStart(pid, linux);
  const r = spawnSync(...startProbe(pid, platform));
  return startOf(r.status, r.stdout, platform);
}
/** procStart without blocking the event loop (a run's supervisor: its heartbeat beats through the probe; CI-RED-18A9C0A R2) */
export function procStartAsync(pid, platform = process.platform) {
  if (!probeable(pid)) return Promise.resolve(null);
  if (platform === 'linux') return Promise.resolve(linuxStart(pid));
  return new Promise(resolve => execFile(...startProbe(pid, platform), (err, stdout) => resolve(startOf(err ? 1 : 0, stdout, platform))));
}
// the same process: alive and created within 120 s of the recorded start (a pid reused later starts after that)
export const sameProcess = (pid, startedMs, probe = procStart) => { const t = probe(pid); return t !== null && Math.abs(t - startedMs) < 120e3; };
