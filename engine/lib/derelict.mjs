// fair-slots 5c / 6 (2026-11-19): test processes that outlive their test. A run's supervisor is detached (a real run outlives its
// launcher), so when ci-suite kills a test file at its cap or a worker dies mid-test the teardown never runs, and Windows does not kill
// orphans: supervisor + fake-executor pairs from Temp\ci-suite-*\parallel-*\meta-tp-* and Temp\meta-agn-*, a guard-dash test with its
// headless Edge, a meta-leak `node -e` keeper - alive 1-2 days, two supervisors polling for ever (6,000 s CPU each).
//   the test owner: tests/helpers/tmp.mjs puts META_TEST_OWNER=<pid>:<start ms> in its env, so every process a test starts inherits
//                   it; a supervisor that has one exits once that process is gone (supervisor.mjs: the pid each beat, its start time
//                   every OWNER_PROBE_MS, so a reused pid cannot keep it alive).
//   the sweep:      the tick kills a process whose command line names a test temp dir (<tmp>/ci-suite-* or <tmp>/meta-*) only on the
//                   evidence of derelictVerdict - its parent dead or its dir deleted, no live run owns it, older than 2 h - and records
//                   each kill with that evidence (<state>/derelicts.jsonl + tick.log). The listing and the kill are injectable.
// derelictVerdict is pure (a process row + its facts -> { kill, why }): the proc-hygiene lane's sweep uses the same rule.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProcs, runFacts } from './strays.mjs';
import { killTree, projectStates } from './runs.mjs';

export const TEST_OWNER = 'META_TEST_OWNER';
export const DERELICT_HOURS = 2;
export const SAME_START_MS = 120e3;            // legacy.sameProcess's tolerance: a start time within it is the same process
export const OWNER_PROBE_MS = 30e3;            // a supervisor re-reads its test owner's start time at most this often (a PowerShell spawn on Windows)
export const SWEEP_MS = 15 * 60e3;             // one machine-wide sweep per window, whichever tick comes first (the stamp's mtime)
export const DERELICTS_FILE = 'derelicts.jsonl';

/** the env value naming this process as the test owner: <pid>:<start ms> (performance.timeOrigin = the process start, no probe) */
export const testOwnerValue = (pid = process.pid, started = Math.round(performance.timeOrigin)) => `${pid}:${started}`;
/** the test owner an env names -> { pid, started } | null (not inside a test) */
export function testOwner(env = process.env) {
  const m = /^(\d+):(\d+)$/.exec(String(env[TEST_OWNER] ?? ''));
  return m ? { pid: Number(m[1]), started: Number(m[2]) } : null;
}
/** why the test owner is gone, or null while it lives. alive = its pid answers; start = its OS start time (undefined = not probed
 * yet, null = no such process) */
export function ownerGoneWhy(owner, { alive, start }) {
  if (!alive || start === null) return `its test process ${owner.pid} is gone`;
  if (Number.isFinite(start) && Math.abs(start - owner.started) > SAME_START_MS) return `its test process ${owner.pid} is gone (the pid now names a process started ${new Date(start).toISOString()})`;
  return null;
}

const fwd = s => String(s ?? '').split('\\').join('/');
const SEG = '[^/\\s"\'=;,]+';
const TEST_DIR = new RegExp(`^(?:ci-suite-${SEG}(?:/${SEG}(?:/meta-${SEG})?)?|meta-${SEG})`, 'i');
const NOT_TEST = /^meta-jobguard-/i;           // the cached job helper exe (jobguard.mjs), not a test's dir
/** the test temp dir a command line names (the deepest of <tmp>/ci-suite-X[/parallel-n[/meta-Y]] or <tmp>/meta-Y), or null */
export function testDirOf(cmd, tmpRoots = [os.tmpdir()], { win = process.platform === 'win32' } = {}) {
  const c = fwd(cmd), lc = win ? c.toLowerCase() : c;
  let best = null;
  for (const r of tmpRoots) {
    const root = fwd(r).replace(/\/+$/, '') + '/', lr = win ? root.toLowerCase() : root;
    for (let i = lc.indexOf(lr); i >= 0; i = lc.indexOf(lr, i + 1)) {
      const m = TEST_DIR.exec(c.slice(i + root.length));
      if (m && !NOT_TEST.test(m[0]) && (!best || m[0].length + root.length > best.length)) best = c.slice(i, i + root.length) + m[0];
    }
  }
  return best;
}

/**
 * THE evidence rule (pure). p: { pid, ppid, name, created (ms), cmd }; f: { now, dir (the test dir its command line names, or null),
 * dirGone, parentDead, owner (what live run owns it, or null), hours (default DERELICT_HOURS) } -> { kill, why }. Kill only when ALL
 * hold: it names a test dir, no live run owns it, it is older than `hours`, and its parent is dead or its dir deleted.
 */
export function derelictVerdict(p, f) {
  const hours = f.hours ?? DERELICT_HOURS;
  if (!f.dir) return { kill: false, why: 'names no test temp dir' };
  if (f.owner) return { kill: false, why: `owned by ${f.owner}` };
  if (!Number.isFinite(p.created)) return { kill: false, why: 'start time unknown' };
  const h = (f.now - p.created) / 3600e3;
  if (h < hours) return { kill: false, why: `${h.toFixed(1)} h old (< ${hours} h)` };
  if (!f.parentDead && !f.dirGone) return { kill: false, why: `its parent ${p.ppid} lives and ${f.dir} exists` };
  return { kill: true, why: [f.parentDead ? `parent ${p.ppid} gone` : null, f.dirGone ? `${f.dir} deleted` : null, 'no live run owns it', `${h.toFixed(1)} h old`].filter(Boolean).join('; ') };
}

/** the facts of every process row: [{ p, f }]. live: the pids of live runs (supervisor + executor, strays.runFacts); self: this process
 * (it and its ancestors are never derelict) */
export function derelictFacts(procs, { live = new Set(), now = Date.now(), tmpRoots = [os.tmpdir()], exists = fs.existsSync, self = process.pid, win } = {}) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const mine = new Set();
  for (let x = byPid.get(self), n = 0; x && n < 64 && !mine.has(x.pid); x = byPid.get(x.ppid), n++) mine.add(x.pid);
  const ownerOf = p => {
    if (mine.has(p.pid)) return 'this process (or its ancestor)';
    for (let x = p, n = 0; x && n < 64; x = byPid.get(x.ppid), n++) { if (live.has(x.pid)) return `live run pid ${x.pid}`; if (x.ppid === x.pid) break; }
    return null;
  };
  return procs.map(p => {
    const dir = testDirOf(p.cmd, tmpRoots, win === undefined ? {} : { win }), par = byPid.get(p.ppid);
    // a parent younger than the child holds a reused pid: the real parent is gone
    const parentDead = !(p.ppid > 1) || !par || (Number.isFinite(par.created) && Number.isFinite(p.created) && par.created > p.created);
    return { p, f: { now, dir, dirGone: !!dir && !exists(dir), parentDead, owner: ownerOf(p) } };
  });
}

/** the derelicts of a process list, killed: [{ pid, ppid, name, created, cmd, dir, why, killed, error? }] (kill(pid) throws = not killed) */
export function sweepDerelicts(procs, { kill, ...o } = {}) {
  const out = [];
  for (const { p, f } of derelictFacts(procs, o)) {
    const v = derelictVerdict(p, f);
    if (!v.kill) continue;
    const row = { pid: p.pid, ppid: p.ppid, name: p.name, created: new Date(p.created).toISOString(), cmd: p.cmd, dir: f.dir, why: v.why, killed: true };
    try { kill(p.pid); } catch (e) { row.killed = false; row.error = e.message; }
    out.push(row);
  }
  return out;
}

/**
 * The tick's sweep: at most once per SWEEP_MS machine-wide (a stamp in <state root>/locks), list the processes, kill the derelicts and
 * record each (<state>/derelicts.jsonl). Returns its log lines. o: { list, kill, live (pids), now, tmpRoots, everyMs, env }. With no
 * list given, a tick inside a test (META_TEST_OWNER) or on a state in the temp dir (a test fixture whose spawn dropped the env) lists
 * nothing: a test never sweeps the machine's real processes. live (default): the live runs of this state and every state beside it.
 */
export function tickDerelicts(state, { list, kill = killTree, live, now = Date.now(), tmpRoots, everyMs = SWEEP_MS, env = process.env } = {}) {
  const rel = path.relative(os.tmpdir(), path.resolve(state)), inTmp = !rel.startsWith('..') && !path.isAbsolute(rel);
  if (!list && (testOwner(env) || inTmp)) return [];
  list ||= listProcs;
  const stamp = path.join(path.dirname(path.resolve(state)), 'locks', 'derelict-sweep.stamp');
  try { if (now - fs.statSync(stamp).mtimeMs < everyMs) return []; } catch { /* first sweep */ }
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, new Date(now).toISOString());
  const rows = sweepDerelicts(list(), { kill, live: live ?? runFacts(projectStates(state)).live, now, ...(tmpRoots ? { tmpRoots } : {}) });
  const at = new Date(now).toISOString();
  if (rows.length) fs.appendFileSync(path.join(state, DERELICTS_FILE), rows.map(r => JSON.stringify({ at, by: 'tick', ...r }) + '\n').join(''));
  return rows.map(r => `derelict ${r.killed ? 'killed' : 'NOT killed'}: pid ${r.pid} ${r.name} (${r.why})${r.error ? `: ${r.error}` : ''} - ${r.cmd.slice(0, 160)}`);
}
