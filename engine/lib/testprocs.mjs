// META-TEST-PROCS (DEC-219, SPEC 9.6 PR-14): the processes whose command line names a (test's temp) dir.
import { listProcs } from './strays.mjs';

const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// a dir is named only where its last path segment ENDS (the next char cannot continue a file name), so ci-suite's parallel-2
// never names a process of parallel-25 or of a sibling parallel-2.old - includes() did (CI-RED R1 note).
const CONT = /[\w.~-]/;
const names = (cmd, d) => {
  for (let i = cmd.indexOf(d); i >= 0; i = cmd.indexOf(d, i + 1)) if (!CONT.test(cmd.charAt(i + d.length))) return true;
  return false;
};

/** procs (default: every process now) whose command line names one of dirs; never this process. -> [{ pid, ppid, name, created, cmd }] */
export function procsNaming(dirs, procs = listProcs()) {
  const ds = dirs.map(norm).filter(Boolean);
  if (!ds.length) return [];
  return procs.filter(p => p.pid !== process.pid && ds.some(d => names(norm(p.cmd), d))).map(({ pid, ppid, name, created, cmd }) => ({ pid, ppid, name, created, cmd }));
}

// CI 44658557500 (delegate LEAK RED): a jobguard hold names no test dir - only its exe (in os.tmpdir()) and its supervisor's pid.
// A supervisor killed while its hold was still starting (a loaded runner) leaves the hold alive past the file. A hold whose held pid
// is gone (or now names a process born after the hold: a reused pid) ends itself and its job anyway: reaping it is that same end, and
// a live run's hold (its supervisor alive) is never one.
const HOLD = /meta-jobguard-[0-9a-f]+\.exe"?\s+hold\s+(\d+)\s/i;
/** the jobguard hold processes of procs whose held process is gone -> [{ pid, ppid, name, created, cmd }] */
export function orphanHolds(procs = listProcs()) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  return procs.filter(p => {
    const m = HOLD.exec(p.cmd || ''); if (!m || p.pid === process.pid) return false;
    const h = byPid.get(Number(m[1]));
    return !h || (Number.isFinite(h.created) && Number.isFinite(p.created) && h.created > p.created);
  }).map(({ pid, ppid, name, created, cmd }) => ({ pid, ppid, name, created, cmd }));
}

// CI-RED-7D65D2D (DEC-383): a LEAK RED names the cause, not a bare pid - each leftover's parent pid, whether that parent is alive in
// the same listing (a pid reused by a process born after the child does not count) and the leftover's creation time.
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : '?');
/** the LEAK line's body for `left` (from procsNaming), judged against the listing `procs` it came from */
export function leakText(left, procs = listProcs()) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  return left.map(p => {
    const par = Number.isInteger(p.ppid) ? byPid.get(p.ppid) : null;
    const alive = !!par && !(Number.isFinite(par.created) && Number.isFinite(p.created) && par.created > p.created);
    return `pid ${p.pid} (${p.cmd}) [parent ${p.ppid ?? '?'} ${alive ? 'alive' : 'gone'}, created ${iso(p.created)}]`;
  }).join('; ');
}
