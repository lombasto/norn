// META-GTP-CI TMPDIR-1 (DEC-60): every temp dir a test makes is <its own mkdtemp>/state/<project>. liveRuns lists the runs of every
// SIBLING state dir (account-wide, D11): a dir straight in os.tmpdir() used as a state dir makes every liveRuns / capFull / status /
// tick call walk the runner's whole temp dir, which self-hosted runners never clean (CI 16.5 min vs 4, locks past STALE_MS).
// tests/tmpdir-guard.test.mjs fails on any other os.tmpdir() call under tests/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { procsNaming } from '../../engine/lib/testprocs.mjs';
import { listProcs } from '../../engine/lib/strays.mjs';
import { killTree } from '../../engine/lib/runs.mjs';
import { CALLER_ENV } from '../../engine/lib/cisuite.mjs';
import { TEST_OWNER, testOwnerValue } from '../../engine/lib/derelict.mjs';

// MAIL-33: the suite is hermetic however it is started. `node --test` run straight from a Norn worker inherits the worker's
// META_RUN_ID / META_RUN_STATE / META_JOB / ...: 4 tests in cli / digest / delegate went red and mail.test hung. Every spawning test
// file imports this helper, so importing it drops the calling run identity (CALLER_ENV, the list ci-suite's suiteEnv drops) from
// process.env before any test body runs; test knobs (META_WALL_STEP_MS, ...) pass through.
for (const k of Object.keys(process.env)) if (CALLER_ENV.includes(k.toUpperCase())) delete process.env[k];
// fair-slots 6a: this process is the test owner of everything it starts (META_TEST_OWNER=<pid>:<start>, engine/lib/derelict.mjs): a
// supervisor started under it exits once it is gone - a test file killed at ci-suite's cap runs no teardown, and its detached
// supervisors used to poll for days. Set on every import: a nested test process owns its own children.
process.env[TEST_OWNER] = testOwnerValue();

// META-TEST-PROCS (DEC-219, SPEC 9.6 PR-14): the teardown of every test that spawns. Every temp dir a test makes comes from mkTmp, and
// a Norn process a test starts (supervisor, fake executor, MCP server, dash, browser, ...) names its temp dir on its command line.
// When the test process exits - however its tests ended, thrown or not, after every after() hook - each process whose command line
// names one of its mkTmp dirs is killed with its tree. 11-13: 22 supervisor + fake-executor pairs a run of delegate / agnostic left
// behind lived 23-28 h. ci-suite fails a file that still leaves one (the hard check behind this teardown).
const made = [], ever = [];
// A jobguard hold names no test dir, only its exe and its supervisor's pid: a supervisor killed while its hold was starting leaves the
// hold alive, and one whose held pid is gone or reused (a process born after the hold) is reaped; a live run's hold never is.
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
/** kill every process (and its tree) whose command line names a dir mkTmp made in this process, and every jobguard hold whose
 *  supervisor is gone (a supervisor killed while its hold started: the hold names no mkTmp dir); -> the killed [{ pid, name, cmd }] */
export function reapTmp() {
  const procs = listProcs(), left = [...procsNaming(ever, procs), ...orphanHolds(procs)];
  for (const p of left) killTree(p.pid);
  return left;
}
process.on('exit', () => { if (ever.length) reapTmp(); });
/** a fresh private dir <mkdtemp(prefix)>/state/<project>, safe to use as a state dir (its only sibling-to-be is the test's own) */
export function mkTmp(prefix = 'meta-t-', project = 'kestrel') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(base); ever.push(base);
  const d = path.join(base, 'state', project);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
/** remove every dir mkTmp made in this process (for a test.after) */
export function cleanTmp() { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); }
/** the system temp dir as a PATH only (e.g. a path_map prefix); never make a dir in it - use mkTmp */
export const SYSTEM_TMP = os.tmpdir();
