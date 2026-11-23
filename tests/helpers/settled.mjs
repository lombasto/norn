// META-GTP-CI-FLAKES: a run's `end` record is NOT the end of its supervisor. After the record the supervisor still runs onRunDone,
// the ledger step, frees the lock, stops orphans, re-queues, FILLS THE QUEUE (under state/queue.lock) and spawns the tick - then
// exits. A test that acts on the state right after `end` races that tail (CI-LINUX FINDING L1: fillQueue returned [] because the
// supervisor's own fill held queue.lock). `settled(item)` = the run has ended AND its supervisor process (end.supervisor_pid) is gone:
// every side effect of the run's end has happened. A killed run has no end record: its supervisor has nothing left to do.
import fs from 'node:fs';
import { procStart } from '../../engine/lib/procs.mjs';

// alive = the process still runs. POSIX: an exited child the test process has not reaped yet (a zombie: its event loop was blocked,
// e.g. an Atomics.wait poll) still answers kill(pid, 0), so /proc/<pid>/stat state Z counts as gone. Windows: kill(pid, 0) checks
// the exit code (libuv), so an exited process is gone there.
// A pid alone is not a process: Windows hands a freed pid to a new process (CI-HANG-6E54DAB R2 toy: reused after 33 s / ~800
// spawns, and kill(pid, 0) said alive), so a recorded `started` (the supervisor's own procStart) must equal the pid's OS start
// time (psutil create_time practice). The probe is a PowerShell call on Windows (~0.3 s): one per pid per PROBE_MS, so a reuse is
// seen at most PROBE_MS late. No start time recorded (the launcher's birth hb, before the supervisor's first beat) = the pid decides.
const PROBE_MS = 1000, probed = new Map();
const sameStart = (pid, started) => {
  const p = probed.get(pid), now = performance.now();
  if (p && p.started === started && now - p.at < PROBE_MS) return p.same;
  const same = procStart(pid) === started;
  probed.set(pid, { started, at: now, same });
  return same;
};
export const alive = (pid, started) => {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try { if (/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false; } catch { /* no /proc: kill(0) decides */ }
  return started == null || sameStart(pid, started);
};
// a run swept lost by a stall names its still-living supervisor in the lost record (CIRED-7b3d67d): it still frees + fills on its exit
export const settled = it => { const s = it?.end?.supervisor_pid ? it.end : it?.lost; return !!it && !['running', 'queued'].includes(it.state) && !(s?.supervisor_pid && alive(s.supervisor_pid, s.supervisor_started)); };
