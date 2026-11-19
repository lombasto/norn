// fair-slots 5a (2026-11-19 ~15:50Z, CPU 94 % on 20 threads: two merge runs ran the full ci-suite at once - parallel node --test plus
// 14 headless Edge - beside two pytest suites): at most ONE heavy gate step runs per machine - a full `node engine/bin/ci-suite.mjs`, or
// a project gate run by runGate (the merge queue's batch gate, the Done check's gate). The lock is one file <state root>/locks/gate.lock
// { pid, started (process start ms), what, cwd, at }, stale when its pid is gone or names another process (start time: Windows reuses
// pids). A second gate WAITS - a line at once and every 5 min, up to its bound - then runs beside the holder and says so: a gate never
// fails on the lock. Re-entrant down a tree: the holder's children get META_GATE_HELD=<lock file> (a project gate that IS ci-suite runs
// under its runGate's lock); a process inside a test (META_TEST_OWNER, tests/helpers/tmp.mjs) takes no machine lock (a fixture suite).
import fs from 'node:fs';
import path from 'node:path';
import { metaRoot } from './config.mjs';
import { running, procStart } from './legacy.mjs';
import { testOwner, SAME_START_MS } from './derelict.mjs';

export const GATE_FILE = 'gate.lock', HELD_ENV = 'META_GATE_HELD';
export const GATE_WAIT_MIN = 90, GATE_POLL_MS = 5000, GATE_SAY_MS = 5 * 60e3;
const TORN_MS = 10000;   // a lock file with no readable JSON for this long is a crashed write, not a holder
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** the machine's locks dir: the state root of the calling run (META_RUN_STATE's parent), else <META_ROOT or the engine root>/state */
export const gateLocksDir = (env = process.env) => env.META_RUN_STATE ? path.join(path.dirname(path.resolve(env.META_RUN_STATE)), 'locks') : path.join(metaRoot(env), 'state', 'locks');

/** the holder is gone: no pid, a dead pid, or a pid whose start time is not the recorded one (the probe runs once per holder) */
export function holderGone(cur, { alive = running, start = procStart, seen = new Map() } = {}) {
  if (!cur || !Number.isInteger(cur.pid) || !alive(cur.pid)) return true;
  if (!Number.isFinite(cur.started)) return false;
  const k = `${cur.pid}:${cur.started}`;
  if (!seen.has(k)) { const t = start(cur.pid); seen.set(k, t === null || Math.abs(t - cur.started) > SAME_START_MS); }
  return seen.get(k);
}

/**
 * Take the machine gate lock, waiting for a live holder up to waitMs. Never rejects. Resolves { held, file, why, waited_ms, env, release }:
 * held = this process holds it (release() frees it; exit frees it too); env = what the gate's children need to run under it ({} when
 * not held). o: { what, locksDir, env, waitMs, pollMs, say (a progress line), alive, start, pid, started } (the last four: tests).
 */
export async function acquireGate({ what = 'gate', locksDir, env = process.env, waitMs = GATE_WAIT_MIN * 60e3, pollMs = GATE_POLL_MS, say = () => {},
  alive = running, start = procStart, pid = process.pid, started = Math.round(performance.timeOrigin) } = {}) {
  const free = (why, file = null, waited = 0, childEnv = {}) => ({ held: false, file, why, waited_ms: waited, env: childEnv, release: () => {} });
  if (testOwner(env)) return free('inside a test: no machine gate lock');
  const outer = env[HELD_ENV] ? readJson(env[HELD_ENV]) : null;
  if (outer && !holderGone(outer, { alive, start })) return free(`inside the gate of pid ${outer.pid} (${outer.what})`, env[HELD_ENV], 0, { [HELD_ENV]: env[HELD_ENV] });
  const dir = locksDir || gateLocksDir(env), file = path.join(dir, GATE_FILE), t0 = performance.now(), seen = new Map();
  let said = -Infinity;
  for (;;) {
    const waited = Math.round(performance.now() - t0);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pid, started, what, cwd: process.cwd().split(path.sep).join('/'), at: new Date().toISOString() }), { flag: 'wx' });
      const release = () => { const c = readJson(file); if (c?.pid === pid && c.started === started) { try { fs.unlinkSync(file); } catch { /* gone */ } } process.off('exit', release); };
      process.on('exit', release);
      if (said > -Infinity) say(`gate lock: taken after ${(waited / 60e3).toFixed(1)} min`);
      return { held: true, file, why: 'held', waited_ms: waited, env: { [HELD_ENV]: file }, release };
    } catch (e) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) return free(`gate lock not taken (${e.code || e.message}): running without it`, file, waited);
    }
    const cur = readJson(file);
    let age = 0; try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }   // freed meanwhile: take it
    if (cur ? holderGone(cur, { alive, start, seen }) : age > TORN_MS) {
      say(`gate lock: ${cur ? `pid ${cur.pid} (${cur.what}) is gone` : 'a torn lock file'} - taken over`);
      try { fs.unlinkSync(file); } catch { /* another taker */ }
      continue;
    }
    const holder = cur ? `pid ${cur.pid} (${cur.what}, since ${cur.at})` : 'a gate starting now';
    if (waited >= waitMs) { say(`gate lock: waited ${(waited / 60e3).toFixed(1)} min for ${holder}: running beside it`); return free(`waited out (${holder})`, file, waited); }
    if (waited - said >= GATE_SAY_MS) { said = waited; say(`gate lock: one heavy gate per machine - waiting for ${holder}, up to ${Math.round(waitMs / 60e3)} min`); }
    await sleep(pollMs);
  }
}
