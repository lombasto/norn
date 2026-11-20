// Runs (META-GENERAL-DESIGN D6-D9, 3.3 run row, 5): `norn run` launch half, worktree lock, heartbeats,
// usage parsers + executor command lines (re-exported from the harness adapters), lost sweep, stop / kill tree. The detached body is supervisor.mjs. Node built-ins only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSteps, runStepsAsync } from './steps.mjs';
import { record, recordAsync, readEvents, fold, recordsFile, RecordError, holdOf, holdMessage, HELD_EXIT, noteRefusal, laneId, homeOf } from './records.mjs';
import { busyRefusal, BUSY_EXIT } from './checkinguards.mjs';
import { BUILTIN, isApi, capDefault, capsOfRun, executorInfo, providerEnv } from './executors.mjs';
import { adapterFor, harnessOf } from './harness/index.mjs';
import { findTranscript } from './harness/claude.mjs';
import { makeEval, evalAll, checkRefs, AfterError, readyWords } from './after.mjs';
export { readyWords };
import { writeQueueView, sleepMs } from './views.mjs';
import { spawnOutside, procList, procListAsync } from './jobguard.mjs';
import { receiptTree } from './kills.mjs';
import { usageRefusal, onAccount, isMergeStage } from './usageguard.mjs';
import { authRefusal, probeAuth, matchExcerpt } from './authguard.mjs';
import { limitRefusal, openLimits } from './limitgate.mjs';
import { briefMarker } from './mergebrief.mjs';
import { slotKey, ensureMergeWorktree, sweepMergeWorktrees, mergeWorktrees } from './mergewt.mjs';
import { openEpic, joinEpic, EpicError } from './epics.mjs';
import { PRIORITIES } from './records.mjs';
import { hookCommand } from './mail.mjs';
import { scopeHookOf, guardSettings } from './scope.mjs';
import { specPolicy, ctxLimits, ctxRole } from './ctxlimit.mjs';
import { unserved, osLabel, fedOf, fetchClaims, claimKey, claimRun, releaseClaim, leaseExpired, writeOffers, importForeign, importNotes } from './fed.mjs';
import { workClass, isFable } from './workclass.mjs';
import { resolveAtFill } from './launchpolicy.mjs';
import { floorOf, raiseToFloor, floorBinds } from './floor.mjs';
import { pathKey, metaRoot } from './config.mjs';
import { resultDir, readResult, NO_RESULT } from './result.mjs';
import { readPause, holdsStarts, pauseTerm, heldPriority } from './pausemode.mjs';
import { claimWork, renewWork, workKey, readSync, updateSync, leaderWhy } from './claims.mjs';
import { ClaimsError } from './claimsref.mjs';
import { parseReady } from './ready.mjs';
import { syncPolicy, POLICY_DEFAULTS } from './policy.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SUPERVISOR = path.join(HERE, 'supervisor.mjs');
export { FAKE } from './harness/fake.mjs';
export const HB_MS = 30000;      // heartbeat period (D7)
export const STALE_MS = 120000;  // liveness threshold (D7)

export class RunRefused extends Error { constructor(msg, code) { super(msg); this.code = code; } }
export class RunError extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }

// built-in executor -> RUN kind + the machine budget caps that count it (exit 4); typed executors (o.provider = the entry) are data (executors.mjs)
export const EXECUTORS = BUILTIN;
const CAP_LABEL = { max_claude_workers: 'claude', max_codex: 'codex', max_sol: 'codex-sol', max_astra: 'codex-astra' };
const infoOf = o => executorInfo(o.executor, o.provider);
const unknownExecutor = ex => new RunError(`unknown executor ${JSON.stringify(ex)} (${Object.keys(EXECUTORS).join(' | ')} | a configured typed executor name)`);

// ---------- usage parsers + executor command lines: the harness adapters (engine/lib/harness/<family>.mjs, H2) ----------
export { parseClaudeFinal, CLAUDE_RO_NOPE } from './harness/claude.mjs';
export { parseCodexLog } from './harness/codex.mjs';
export { prompt } from './harness/common.mjs';
// a provider runs the claude CLI path minus --remote-control (that would bind the session to the owner's claude.ai account)
export const claudeCmd = (o, remote) => adapterFor('claude').command({ ...o, remote });
/** The command { exe, args, stdin, stdout, parse } of run spec `o`, built by its executor's harness adapter. */
// META-GTP-MAIL delivery (a): a run whose adapter runs the mail hook (caps.hooks settings + adapter.mailHook: claude) gets the
// PostToolUse hook `norn mail check --inject`; the others read mail by MCP norn_mail + their headless line (HEADLESS_MAIL)
export function mailHookOf(o) {
  const fam = harnessOf(o.executor, o.provider);
  const a = fam ? adapterFor(fam) : null;
  return a?.mailHook && a.caps.hooks === 'settings' && o.state ? hookCommand(o.state) : undefined;
}
// META-DOD 2: the same executors get the scope guard (scope.mjs): deny rules, the write block and the PreToolUse hook - write runs only
// ROUND 2: only for a project whose CURRENT policy.dod.scope is on (default off), read at each launch (a resume too); TEST-GOVERNANCE S1:
// with it off, the hook alone while policy.tests.budget.full_suite = deny (the full-suite deny reaches every run, a resume too)
export function scopeOfLaunch(o) {
  const h = mailHookOf(o) && scopeHookOf(o);
  return h ? guardSettings(specPolicy({ ctx_from: policySource(o) }), o, h) : undefined;
}
/** the project.json whose CURRENT policy binds a run (policy.context, policy.dod.scope) */
const policySource = o => o.ctx_from ?? o.refill?.project_file ?? o.env?.META_PROJECT;

export function buildCommand(o) {
  const family = harnessOf(o.executor, o.provider);
  if (!family) throw unknownExecutor(o.executor);
  return adapterFor(family).command({ ...o, remote: o.executor === 'claude' });
}

// ---------- worktree lock: state/locks/<sha1(worktree)>.json {run, pid, ts} ----------
export const normWt = pathKey;   // a worktree's identity in any spelling (8.3 short name, link, case): lock files key on it
export const lockPath = (locksDir, wt) => path.join(locksDir, crypto.createHash('sha1').update(normWt(wt)).digest('hex') + '.json');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// Windows: rename over a file another process has open fails EPERM / EACCES for a moment - retry (graceful-fs's rename practice)
export function renameRetry(t, f, tries = 40) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(t, f); } catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || i >= tries) { try { fs.unlinkSync(t); } catch { /* gone */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
// Windows sharing / delete-pending errors on a lock or flag file are transient (graceful-fs's EPERM practice, as renameRetry): retried
// on the monotonic clock up to STALE_MS, then thrown - a caller logs it; never a silent lost wakeup (META-OOTB-FIX FLOW-STALL)
const TRANSIENT = ['EPERM', 'EACCES', 'EBUSY'];
function retryTransient(fn, what) {
  const t0 = performance.now();
  for (;;) {
    try { return fn(); } catch (e) {
      if (!TRANSIENT.includes(e.code)) throw e;
      if (performance.now() - t0 > STALE_MS) throw new RunError(`${what}: ${e.code} for ${STALE_MS} ms`);
      sleepMs(25);
    }
  }
}
const writeAtomic = (f, obj) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(obj)); renameRetry(t, f); };

// refresh only while the lock still names this run (a stop / stale break must not be undone)
export function refreshLock(file, run, extra = {}) {
  if (!file) return false;
  const cur = readJson(file);
  if (!cur || cur.run !== run) return false;
  writeAtomic(file, { ...cur, run, ...extra, ts: new Date().toISOString() });
  return true;
}
export function releaseLock(file, run) {
  if (!file) return;
  const cur = readJson(file);
  if (cur && cur.run === run) { try { fs.unlinkSync(file); } catch { /* gone */ } }
}
/** releaseLock on fs.promises (the dash server's stop) */
export async function releaseLockAsync(file, run) {
  if (!file) return;
  let cur = null; try { cur = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { /* none */ }
  if (cur && cur.run === run) { try { await fs.promises.unlink(file); } catch { /* gone */ } }
}

export function acquireLock(locksDir, wt, { run, pid = process.pid, staleMs = STALE_MS } = {}) {
  fs.mkdirSync(locksDir, { recursive: true });
  const file = lockPath(locksDir, wt);
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ run, pid, ts: new Date().toISOString(), worktree: normWt(wt) }), { flag: 'wx' });
      const h = { run, file, release: () => releaseLock(file, h.run), refresh: extra => { const ok = refreshLock(file, h.run, extra); if (extra?.run) h.run = extra.run; return ok; } };
      return h;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      const cur = readJson(file);
      const ts = cur ? Date.parse(cur.ts) : NaN;
      if (!cur || !(Date.now() - ts > staleMs)) throw new RunRefused(`worktree ${wt} is held by ${cur?.run ?? '(being written)'} pid ${cur?.pid ?? '?'}`, 3);
      try { fs.unlinkSync(file); } catch { /* another breaker */ }
    }
  }
  throw new RunRefused(`worktree ${wt}: lock contended`, 3);
}

// META-MERGELOCK (DEC-103 / DEC-104): the ONE home of "which checkouts does run spec o write". Its own worktree; a MERGE stage
// works in its own merge worktree (GAP-6: mergeSpec made it the run's; never the owner's checkout) and a rebase brief also writes
// the lane worktree it rebases in. Every lock holder (startRun, the supervisor's beat + exit, norn stop, the fill's wait) takes
// the list from here.
export function writeTrees(o) {
  if (o.kind === 'audit' || o.critique) return [];   // META-TEND P5: a read-only audit writes no tree; nor does a plan review (META-DOD 3)
  const own = o.worktree ? [o.worktree] : [];
  if (!isMergeStage(o.stage)) return own;
  const m = markerOf(o);
  return m?.mode === 'rebase' && m.worktree && !own.some(w => normWt(w) === normWt(m.worktree)) ? [...own, m.worktree] : own;
}
const markerOf = o => { try { return briefMarker(fs.readFileSync(o.brief, 'utf8')); } catch { return null; } };   // no brief: the spec decides
// take the lock of every tree in order; one held = release the ones taken, refuse (exit 3). One handle over them all.
function acquireTrees(locksDir, trees, opts) {
  const hs = [];
  try { for (const wt of trees) hs.push(acquireLock(locksDir, wt, opts)); } catch (e) { for (const h of hs) h.release(); throw e; }
  return handleOf(hs);
}
const handleOf = hs => ({ file: hs[0]?.file ?? null, files: hs.map(h => h.file), refresh: extra => hs.every(h => h.refresh(extra)), release: () => { for (const h of hs) h.release(); }, hs });
/** the trees of spec o (writeTrees) whose lock is fresh and names another run: [{ tree, run, own }] */
export function heldTrees(o, staleMs = STALE_MS) {
  if (!o.locksDir) return [];
  return writeTrees(o).map((tree, i) => ({ tree, own: i === 0, cur: readJson(lockPath(o.locksDir, tree)) }))
    .filter(({ cur }) => cur && !(Date.now() - Date.parse(cur.ts) > staleMs)).map(({ tree, own, cur }) => ({ tree, own, run: cur.run ?? 'a writer' }));
}
const heldWords = h => (h.own ? `worktree held by ${h.run}` : `lane worktree ${fwd(h.tree)} held by ${h.run}`);

// ---------- GAP-6: merges in their own merge worktrees - the merge slots (policy.merge.parallel) ----------
// a MERGE run whose brief names a merge worktree (marker merge_wt) works there, whatever --worktree said: the spec's worktree is
// it (the lock, the cwd, the scope guard), merge_wt + merge_repo say Norn makes it at the start and removes it at the end.
// MAIL-10 (solve-shack RUN-134, a check-in's --stage MERGE2): only MERGE is a merge stage, so a merge brief under any other stage
// ran in the lane worktree with its merge worktree never made, nor kept by the next merge's sweep: refused. So is a merge brief
// that names no merge worktree. A brief without the marker (hand-written) is no merge brief: it runs as given.
export function mergeSpec(o) {
  const m = o.brief ? markerOf(o) : null;
  if (!m) return o;
  if (!isMergeStage(o.stage)) throw new RunError(`stage ${o.stage ?? '(none)'}: ${fwd(o.brief)} is a merge brief (meta-merge marker) - start it as --stage MERGE, so Norn makes and keeps its merge worktree`);
  if (!m.merge_wt || !m.repo) throw new RunError(`MERGE ${o.lane ?? ''}: ${fwd(o.brief)} names no merge worktree (marker merge_wt + repo) - write it with norn merge-brief`);
  return { ...o, worktree: m.merge_wt, merge_wt: m.merge_wt, merge_repo: m.repo, merge_slots: Number.isInteger(m.slots) && m.slots > 0 ? m.slots : 1,
    merge_main: m.main_branch || 'main', merge_remote: m.remote || 'origin' };
}
const isMergeWtSpec = o => !!o.merge_wt && !!o.merge_repo && normWt(o.worktree) === normWt(o.merge_wt);
const slotFresh = (o, i, staleMs) => { const cur = readJson(lockPath(o.locksDir, slotKey(o.merge_repo, i))); return cur && !(Date.now() - Date.parse(cur.ts) > staleMs) ? cur : null; };
/** a MERGE run with every slot of its repo taken: the words (a fill term / queue why), else null */
export function slotsFull(o, staleMs = STALE_MS) {
  if (!isMergeWtSpec(o) || !o.locksDir) return null;
  const held = [];
  for (let i = 0; i < o.merge_slots; i++) { const c = slotFresh(o, i, staleMs); if (!c) return null; held.push(c.run ?? 'a merge'); }
  return `merge slots full: ${held.length} merge(s) running in ${fwd(o.merge_repo)} (${held.join(', ')}; policy.merge.parallel ${o.merge_slots})`;
}
// take the first free slot lock of the repo (refused exit 3 when all are held)
function acquireSlot(o, opts) {
  for (let i = 0; i < o.merge_slots; i++) { try { return acquireLock(o.locksDir, slotKey(o.merge_repo, i), opts); } catch (e) { if (!(e instanceof RunRefused)) throw e; } }
  throw new RunRefused(slotsFull(o, opts.staleMs) || `merge slots full in ${fwd(o.merge_repo)}`, 3);
}
// the merge worktrees a run may still need: those of queued / running / claimed runs, and of a run that ended HANDOFF in the last
// day (its resume goes on there). Every other one in <state>/mq is a leftover.
// MAIL-10 (RUN-134 swept mid-suite): a lost run may only be stalled (a stale heartbeat), so it keeps its merge worktree too; and a
// run that may still work keeps the merge worktree its brief names, whatever worktree its record names.
export const MERGE_WT_KEEP_MS = 24 * 3600e3;
const MAY_WORK = ['queued', 'running', 'claimed', 'lost'];
export function mergeWtInUse(state, now = Date.now()) {
  const keep = new Set(), last = new Map();
  for (const r of runsOf(state)) {
    if (r.kind !== 'run') continue;
    if (MAY_WORK.includes(r.state) && r.data.brief) { const m = markerOf(r.data); if (m?.merge_wt) keep.add(normWt(m.merge_wt)); }
    if (!r.data.worktree || !isMergeStage(r.data.stage)) continue;
    const k = normWt(r.data.worktree);
    if (MAY_WORK.includes(r.state)) keep.add(k);
    if (!last.has(k) || Number(r.id.slice(4)) > Number(last.get(k).id.slice(4))) last.set(k, r);
  }
  for (const [k, r] of last) if (r.end?.outcome === 'handoff' && now - Date.parse(r.updated || r.created) < MERGE_WT_KEEP_MS) keep.add(k);
  return keep;
}
// at the start of a MERGE run: sweep the leftovers of the state dir, then make (or keep, on a resume) its own merge worktree
function prepareMergeWt(o) {
  try {
    // a worktree whose lock is fresh belongs to a start in flight (its lock is taken before its record): kept too
    const locked = mergeWorktrees(o.state).filter(wt => { const c = readJson(lockPath(o.locksDir, wt)); return c && !(Date.now() - Date.parse(c.ts) > (o.staleMs ?? STALE_MS)); }).map(normWt);
    sweepMergeWorktrees({ state: o.state, repo: o.merge_repo, keep: new Set([...mergeWtInUse(o.state), ...locked, normWt(o.merge_wt)]) });
  } catch { /* a sweep never blocks a start */ }
  try { return ensureMergeWorktree({ repo: o.merge_repo, wt: o.merge_wt, main: o.merge_main, remote: o.merge_remote }); }
  catch (e) { throw new RunError(`merge worktree ${fwd(o.merge_wt)}: ${String(e.stderr || e.message).trim().split(/\r?\n/)[0]}`, 1); }
}

// ---------- heartbeats + lost sweep ----------
export const hbPath = (state, run) => path.join(state, 'hb', run + '.hb');
// Owner report 2026-11-19 (RUN-257 read lost while alive): on Windows the rename onto the .hb failed for about 3 min while another
// process held it open without FILE_SHARE_DELETE (antivirus, an indexer, a PowerShell reader), and the beat swallowed the error. A beat
// retries the transient codes, then writes the .hb in place, then (a holder that refuses writes too) touches its mtime: the age every
// reader goes by. The first failure of a streak and the recovery are logged. No reader can be made harmless: MoveFileEx's replace fails
// on ANY open handle of the target, FILE_SHARE_DELETE included (Node's own readers open with it; tests/heartbeat.test.mjs), so the
// writer must get past a holder. Returns beat(obj) -> 'rename' | 'in place' | 'mtime' | null (not written).
export function hbWriter(file, { log = () => {}, rename = fs.renameSync, write = fs.writeFileSync, touch = (f, t) => fs.utimesSync(f, t, t), tries = 4, waitMs = 25 } = {}) {
  let streak = null;   // the current failure streak: { since, code, n }
  const tmp = `${file}.${process.pid}.tmp`;
  return obj => {
    const body = JSON.stringify(obj);
    let how = null, code = null;
    try {
      write(tmp, body);
      for (let i = 0; ; i++) { try { rename(tmp, file); how = 'rename'; break; } catch (e) { if (!TRANSIENT.includes(e.code) || i >= tries) throw e; sleepMs(waitMs); } }
    } catch (e) { code = e.code ?? e.message; try { fs.unlinkSync(tmp); } catch { /* not written */ } }
    if (!how) { try { write(file, body); how = 'in place'; } catch { try { touch(file, new Date()); how = 'mtime'; } catch { /* not written */ } } }
    if (how === 'rename') { if (streak) log(`heartbeat: rename works again after ${streak.n} failed beat${streak.n === 1 ? '' : 's'} (since ${streak.since})`); streak = null; }
    else if (streak) streak.n++;
    else { streak = { since: new Date().toISOString(), code, n: 1 }; log(`heartbeat: rename onto ${path.basename(file)} failed (${code}); ${how ? `wrote ${how === 'mtime' ? 'its mtime only' : 'it in place'}` : 'not written'}`); }
    return how;
  };
}
const runsOf = state => Object.values(fold(readEvents(recordsFile(state, 'run'))).items);
const hbAge = (state, it, now) => {
  const f = hbPath(state, it.id);
  const t = fs.existsSync(f) ? fs.statSync(f).mtimeMs : Date.parse(it.created);
  return { age: now - t, has: fs.existsSync(f) };
};
// META-CATCH S1 (a reboot left a run `running` for 3 h): the machine's boot time from the real clock (an injected `now` is a test's
// clock, never the OS's); a run started before it cannot have survived it, whatever pid the heartbeat names (pids restart at boot)
export const bootMs = () => Date.now() - os.uptime() * 1000;
const BOOT_SLACK_MS = 60e3;   // record ts are whole seconds and uptime drifts: a run within a minute of the boot is judged by its heartbeat
// a pid that names no process: certain death (ESRCH). A live pid may be a reused one: the heartbeat age still decides then
export const pidGone = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
// the causes whose death is certain (the auto-resume policy relaunches them: relaunchLost); `stale` may be a stall, never relaunched
export const DEAD_CAUSES = ['boot', 'gone', 'no-start'];
// MAIL-22 (norn RUN-80: lost at a 210 s beat while 11 workers held the CPU at 97-100 %, beating again 8 min later): a late beat under
// a busy CPU is a stall, not a death. While the CPU is at LATE_CPU_PCT or more, a stale beat whose supervisor pid lives waits up to
// LATE_FACTOR x the threshold before the sweep calls it lost. The sweep keeps its sample in hb/load.json: the pages name it.
export const LATE_CPU_PCT = 90, LATE_FACTOR = 3;
/** the sweep's last CPU sample (hb/load.json); the dash primes it */
export const loadPath = state => path.join(state, 'hb', 'load.json');
/** the CPU % the last sweep sampled, when it is at most maxMs old, else null (the pages' "heartbeat late (N s, CPU x %)"); read: the dash's snapshot reader */
export const sweptCpu = (state, { now = Date.now(), maxMs = 5 * 60e3, read = readJson } = {}) => { const l = read(loadPath(state)); return l && now - Date.parse(l.ts) <= maxMs ? l.cpu_pct : null; };
// the run's heartbeat was written after its lost record (whose ts is whole seconds: a beat in a later second)
const beatSinceLost = (state, it) => (fs.statSync(hbPath(state, it.id), { throwIfNoEntry: false })?.mtimeMs ?? 0) >= Date.parse(it.history.findLast(h => h.ev === 'lost')?.ts) + 1000;
// MAIL-28 (2): a supervisor deletes its heartbeat as it exits; when its end record did not land (refused: RUN-80, RUN-89) the run still
// read running, and the sweep saw no heartbeat and recorded it lost, cause no-start - a certain death, so relaunchLost relaunched a run
// that had finished. What a finished run leaves: its supervisor's end data (END_FILE, written before the record), its result.json, its
// log's exit line. -> { data, from } | null
export const END_FILE = 'end.json';
export const endFilePath = (state, run) => path.join(resultDir(state, run), END_FILE);
function endEvidence(state, it) {
  const e = readJson(endFilePath(state, it.id));
  if (e?.run === it.id && e.data && typeof e.data === 'object') return { data: e.data, from: `its supervisor's end data (${END_FILE})` };
  const log = readJson(path.join(state, 'runs', it.id + '.spec.json'))?.log;
  let text = ''; try { text = log ? fs.readFileSync(log, 'utf8') : ''; } catch { /* no log */ }
  const m = [...text.matchAll(/^\S+ exit=(\S+)/gm)].at(-1), code = m && /^-?\d+$/.test(m[1]) ? Number(m[1]) : null;
  const r = readResult(resultDir(state, it.id), { run: it.id });
  if (r && !r.error && (!m || code === 0)) return { data: { exit: code, outcome: r.outcome, outcome_source: 'result', result: fwd(resultDir(state, it.id)), ...drop({ why: r.why, summary: r.summary, handoff: r.handoff && fwd(r.handoff) }) }, from: 'its result.json' };
  return m ? { data: { exit: code, outcome: code === 0 ? NO_RESULT : 'crash', outcome_source: 'exit' }, from: `its log's exit line (exit=${m[1]})` } : null;
}
// the end a sweep records from a finished run's evidence (and its heartbeat goes) -> true when recorded
function endFromEvidence(state, it, ev) {
  try { record(state, { kind: 'run', ev: 'end', id: it.id, by: 'launcher', data: { ...ev.data, swept: `end not recorded by its supervisor: recorded by the sweep from ${ev.from}` } }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; return false; }
  try { fs.unlinkSync(hbPath(state, it.id)); } catch { /* none */ }
  return true;
}
/**
 * MAIL-28 (1): the supervisor's end record. An end refused while the run reads lost (a supervisor whose event table takes end from
 * running only: RUN-80 "end not recorded: RUN-80 is lost; end needs running") does not give up: alive, then its end. Any other refusal
 * (killed, already ended) throws as before. rec: a test's record.
 */
export function recordEnd(state, run, data, { rec = record } = {}) {
  const end = () => rec(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data });
  try { return end(); }
  catch (e) {
    if (!(e instanceof RecordError) || runsOf(state).find(r => r.id === run)?.state !== 'lost') throw e;
    rec(state, { kind: 'run', ev: 'alive', id: run, by: 'launcher', data: { why: `its supervisor ended it (end refused: ${e.message})` } });
    return end();
  }
}
// The second signal (owner report 2026-11-19): a stale .hb alone is never a death. The run's own output (its log, its transcript, the
// newest mtime) -> ms, or null when there is none. Spec fields fill in what the start record lacks (projectsDir is the spec's only).
export function runActivityMs(state, it) {
  const spec = readJson(path.join(state, 'runs', it.id + '.spec.json')) || {}, d = it.data || {};
  let t = null;
  for (const f of [d.log ?? spec.log, d.transcript ?? findTranscript(spec.projectsDir, d.session_id ?? spec.session_id)]) {
    if (!f) continue;
    try { const m = fs.statSync(f).mtimeMs; if (t === null || m > t) t = m; } catch { /* not written yet */ }
  }
  return t;
}
/** The one late rule (owner report 2026-11-19 + MAIL-22): a running run whose .hb is stale is late, not lost, while the supervisor pid
 * its .hb names lives and EITHER its own output advanced within staleMs OR the CPU is busy (>= LATE_CPU_PCT) and the beat is at most
 * LATE_FACTOR x staleMs old. The sweep records lost only past both; the pages name the evidence.
 * age: the beat's age (else the .hb mtime); cpu: the CPU % - a number, a sampler (called only when the output says nothing), or null
 * (unknown: the output alone decides) -> { supervisor_pid, output_age } | { supervisor_pid, cpu } | null */
export function hbLate(state, it, { now = Date.now(), staleMs = STALE_MS, gone = pidGone, age = null, cpu = null } = {}) {
  const pid = readJson(hbPath(state, it.id))?.supervisor_pid;
  if (!Number.isInteger(pid) || pid <= 0 || gone(pid)) return null;
  const at = runActivityMs(state, it);
  if (at !== null && now - at <= staleMs) return { supervisor_pid: pid, output_age: Math.max(0, now - at) };
  if (cpu === null || (age ?? now - (fs.statSync(hbPath(state, it.id), { throwIfNoEntry: false })?.mtimeMs ?? 0)) > staleMs * LATE_FACTOR) return null;
  const c = typeof cpu === 'function' ? cpu() : cpu;
  return Number.isFinite(c) && c >= LATE_CPU_PCT ? { supervisor_pid: pid, cpu: c } : null;
}
export function sweepLost(state, { staleMs = STALE_MS, by = 'status', now = () => new Date(), boot = bootMs, gone = pidGone, load = () => sampleResources({ ms: 250, src: 'sweep' }).cpu_pct } = {}) {
  const lost = [];
  const t = now().getTime(), bt = boot();
  let cpu;   // sampled once per sweep, only when a live supervisor's beat is stale and its output says nothing (hbLate)
  const sample = () => {
    if (cpu === undefined) { cpu = Math.round(load()); try { fs.mkdirSync(path.dirname(loadPath(state)), { recursive: true }); fs.writeFileSync(loadPath(state), JSON.stringify({ cpu_pct: cpu, ts: new Date(t).toISOString() })); } catch { /* the pages go without it */ } }
    return cpu;
  };
  for (const it of runsOf(state)) {
    // a stall swept as lost (cause stale) whose heartbeat is fresh again and whose supervisor lives: alive, so its own end is accepted
    // (2026-11-18: a machine busy starting processes let heartbeats fall 210-297 s behind; five live runs read lost and would have
    // lost their end records). Certain deaths (DEAD_CAUSES) are never revived here.
    if (it.state === 'lost' && it.lost?.cause === 'stale' && it.data.kind !== 'interactive') {
      const { age, has } = hbAge(state, it, t), hb = has ? readJson(hbPath(state, it.id)) : null;
      const lostAt = Date.parse(it.history.findLast(h => h.ev === 'lost')?.ts);
      if (has && age <= staleMs && t - age > lostAt && hb && !gone(hb.supervisor_pid)) {
        try { record(state, { kind: 'run', ev: 'alive', id: it.id, by, data: { why: `heartbeat ${Math.round(age / 1000)} s old again (lost for a stale heartbeat at ${new Date(lostAt).toISOString().slice(11, 19)}Z); supervisor pid ${hb.supervisor_pid} alive` } }); }
        catch (e) { if (!(e instanceof RecordError)) throw e; }
      }
      continue;
    }
    if (it.state !== 'running' || it.data.kind === 'interactive') continue;
    const { age, has } = hbAge(state, it, t);
    const hb = has ? readJson(hbPath(state, it.id)) : null;
    let cause, why;
    if (Date.parse(it.created) < bt - BOOT_SLACK_MS) { cause = 'boot'; why = `machine rebooted at ${new Date(bt).toISOString().slice(0, 19)}Z after the run started`; }
    else if (hb && gone(hb.supervisor_pid)) { cause = 'gone'; why = `supervisor pid ${hb.supervisor_pid} gone without an end record`; }
    else if (age <= staleMs || (has && hbLate(state, it, { now: t, staleMs, gone, age, cpu: sample }))) continue;   // late, not lost (hbLate: output advanced, or a busy CPU)
    // CIRED-7b3d67d: a stall (not a death) also goes stale - the supervisor may live on; the record names it (tests/helpers/settled)
    else if (has) { cause = 'stale'; why = `heartbeat ${Math.round(age / 1000)} s old`; }
    else { cause = 'no-start'; why = `no heartbeat for ${Math.round(age / 1000)} s: the run never started`; }
    const ev = DEAD_CAUSES.includes(cause) ? endEvidence(state, it) : null;   // MAIL-28 (2): a finished run is ended, never lost
    if (ev && endFromEvidence(state, it, ev)) continue;
    try { record(state, { kind: 'run', ev: 'lost', id: it.id, by, data: drop({ why, cause, ...(cause === 'boot' ? { boot: new Date(bt).toISOString() } : {}), supervisor_pid: hb?.supervisor_pid, supervisor_started: hb?.supervisor_started }) }); lost.push(it.id); } catch (e) { if (!(e instanceof RecordError)) throw e; }
  }
  return lost;
}
/** the HANDOFF auto-resume policy (cadence auto_resume_handoff / auto_resume_max, the weekly guard) for a run's spec -> { refused | null, count, max }.
 * RM-37: a pause never refuses it - startRun queues the resume while a pause holds starts (pausemode.mjs), and the fill starts it on release */
export function autoResumeRefusal(spec, state) {
  const pol = spec.policy || {}, count = spec.resumes || 0, max = Number.isInteger(pol.auto_resume_max) ? pol.auto_resume_max : 2;
  const refused = pol.auto_resume_handoff === false ? 'auto-resume off' : count >= max ? `cap ${count}/${max}`
    : usageRefusal(spec, state, { rate: false });   // the weekly guard (one home with the queue fill: usageguard.mjs)
  return { refused: refused || null, count, max };
}
export const LOST_RESUME_MAX_AGE_MS = 24 * 3600e3;   // an older dead run is the check-in's (its worktree has moved on)
/**
 * META-CATCH S1: a work run the sweep recorded lost for a CERTAIN death (DEAD_CAUSES) goes through the auto-resume policy as a HANDOFF does:
 * relaunched from its spec (a fresh agent, same brief; the resume prompt re-checks HEAD + git status) and reviewed by the launcher as
 * routine, or its `resume` record says why not (the check-in rules it). Level-triggered from the records: whoever swept it. Once per run.
 * Returns [{ id, cause, boot?, next?, refused? }].
 */
// a lost run relaunchLost still has to judge (a check-in is the tick's own; a helper belongs to its parent)
const relaunchable = (it, now) => it.state === 'lost' && !it.review && DEAD_CAUSES.includes(it.lost?.cause) && !it.history.some(h => h.ev === 'resume')
  && it.data.kind !== 'checkin' && it.data.role !== 'helper' && now - Date.parse(it.history.findLast(h => h.ev === 'lost')?.ts) <= LOST_RESUME_MAX_AGE_MS;
export function relaunchLost(state, { now = Date.now(), start = startRun } = {}) {
  const out = [];
  for (const it of runsOf(state)) {
    if (!relaunchable(it, now)) continue;
    const spec = readJson(path.join(state, 'runs', it.id + '.spec.json'));
    let { refused, count, max } = spec ? autoResumeRefusal(spec, state) : { refused: 'no spec file', count: 0, max: 0 };
    let next = null;
    if (!refused) {
      for (const f of spec.lockFiles ?? (spec.lockFile ? [spec.lockFile] : [])) releaseLock(f, it.id);   // the dead supervisor's locks
      try {
        const { run: _r, log: _l, final: _f, session_id: _s, lockFile: _k, lockFiles: _ks, resumeSid: _rs, nudge: _n, ...rest } = spec;
        if (spec.nudge) delete rest.promptText;
        ({ run: next } = start({ ...rest, resumes: count + 1, resumeOf: it.id }));
      } catch (e) { refused = e instanceof RunRefused ? `${e.code === 3 ? 'writer' : 'worker cap'}: ${e.message}` : `error: ${e.message}`; }
    }
    const why = `${it.lost.cause}: ${it.lost.why}`;
    try {
      record(state, { kind: 'run', ev: 'resume', id: it.id, by: 'launcher', data: next ? { next, count: count + 1, max, why } : { refused, count, max, why } });
      if (next) record(state, { kind: 'run', ev: 'review', id: it.id, by: 'launcher', data: { refs: [next], routine: 'lost_resume', why: `lost (${why}) -> auto-resumed ${next}` } });
    } catch (e) { if (!(e instanceof RecordError)) throw e; }
    out.push(drop({ id: it.id, cause: it.lost.cause, boot: it.lost.boot, next, refused }));
  }
  return out;
}
/**
 * A lost run is not an ended one: `lost` only says the beat stopped (a stale one may be a stall whose supervisor still ends it), so
 * nothing wrote its `end` and it looked live for hours (norn RUN-33: stale-lost, reviewed, never relaunched). Once its supervisor and
 * executor pids are both gone - and the auto-resume policy has had its say (relaunchable) - the sweep writes the one `end` (outcome
 * crash, the lost why) and drops its heartbeat file. A pid alive again (a stall, or a reused pid) leaves it alone. -> [ids ended]
 */
export function endLost(state, { now = Date.now(), gone = pidGone } = {}) {
  const out = [];
  for (const it of runsOf(state)) {
    if (it.state !== 'lost' || it.data.kind === 'interactive' || relaunchable(it, now)) continue;
    if (beatSinceLost(state, it)) continue;   // MAIL-22: it beat after the lost record - never ended (a live stall is revived above)
    const hb = readJson(hbPath(state, it.id)), pids = [hb?.supervisor_pid, hb?.pid, it.lost?.supervisor_pid].filter(p => Number.isInteger(p) && p > 0);
    if (!pids.every(gone)) continue;
    const ev = endEvidence(state, it);   // MAIL-28: the end its supervisor could not record, else a crash
    if (ev) { if (endFromEvidence(state, it, ev)) out.push(it.id); continue; }
    const why = `lost: ${it.lost?.why ?? 'no heartbeat'}; supervisor and executor gone, no end record`;
    try { record(state, { kind: 'run', ev: 'end', id: it.id, by: 'launcher', data: { exit: null, ...drop({ outcome: 'crash', outcome_source: 'sweep', why, cause: it.lost?.cause }) } }); }
    catch (e) { if (!(e instanceof RecordError)) throw e; continue; }
    try { fs.unlinkSync(hbPath(state, it.id)); } catch { /* none */ }
    out.push(it.id);
  }
  return out;
}
/** one owner notice per sweep pass that handled dead runs (relaunchLost rows) -> { title, body } | null */
export function lostNotice(rows, project = '') {
  if (!rows.length) return null;
  const boot = rows.find(r => r.boot)?.boot, m = rows.filter(r => r.next).length;
  const list = rows.map(r => r.next ? `${r.id} -> ${r.next}` : `${r.id} (not relaunched: ${r.refused})`).join(', ');
  const head = boot ? `machine rebooted at ${boot.slice(0, 16).replace('T', ' ')}Z` : 'run supervisor gone';
  return { title: `${project ? project + ': ' : ''}${head}`, body: `${head}: ${rows.length} run${rows.length === 1 ? '' : 's'} lost, ${m} relaunched (${list})` };
}

// running, non-interactive runs with a fresh (or late: hbLate) heartbeat in every sibling state dir with runs.jsonl (account-wide, D11)
export function liveRuns(state, { staleMs = STALE_MS, now = Date.now() } = {}) {
  const parent = path.dirname(path.resolve(state));
  const states = new Set([path.resolve(state)]);
  for (const d of fs.existsSync(parent) ? fs.readdirSync(parent) : []) if (fs.existsSync(path.join(parent, d, 'runs.jsonl'))) states.add(path.join(parent, d));
  const live = [];
  for (const s of states) for (const it of runsOf(s)) if (it.state === 'running' && it.data.kind !== 'interactive' && (hbAge(s, it, now).age <= staleMs || hbLate(s, it, { now, staleMs, cpu: sweptCpu(s, { now }) }))) live.push({ ...it, state_dir: s });
  return live;
}
// META-GTP-MERGEQ piece 0 (norn DEC-5; live 11-09: VISUAL-B S2 READY while S3 wrote in its worktree): a MERGE stage whose brief
// rebases + pushes in the lane worktree waits / is refused (exit 3) while that worktree holds a live writer lock or the lane has a
// live run; a staged brief (norn merge-brief --sha) merges one tested commit in its merge worktree and never touches it: no check.
// A brief without the meta-merge marker (hand-written) is checked by its lane only. Returns the reason or null.
export function mergeStageRefusal(o, staleMs = STALE_MS) {
  if (!isMergeStage(o.stage) || !o.brief) return null;
  let text;
  try { text = fs.readFileSync(o.brief, 'utf8'); } catch { return null; }
  const m = briefMarker(text);
  if (m?.mode === 'staged') return null;
  const own = m?.worktree && o.worktree && normWt(m.worktree) === normWt(o.worktree);   // run in the lane worktree itself: its own lock decides
  const w = laneWriter({ state: o.state, locksDir: o.locksDir, lane: m?.lane || o.lane, worktree: own ? null : m?.worktree, staleMs });
  return w ? `MERGE ${o.lane}: ${w} - the brief would rebase under it; write a staged brief: norn merge-brief --sha <READY sha> (DEC-5)` : null;
}
/** a live writer of a lane: its worktree's fresh lock, else a live non-MERGE run of the lane in this state dir -> the words, or null */
export function laneWriter({ state, locksDir, lane, worktree, staleMs = STALE_MS }) {
  if (worktree && locksDir) {
    const held = readJson(lockPath(locksDir, worktree));
    if (held && !(Date.now() - Date.parse(held.ts) > staleMs)) return `the lane worktree ${fwd(worktree)} holds live run ${held.run ?? '(a writer)'}`;
  }
  if (!lane || !state) return null;
  const here = path.resolve(state);
  const live = liveRuns(state, { staleMs }).find(r => r.state_dir === here && r.data.lane === lane && r.data.kind !== 'checkin' && !isMergeStage(r.data.stage));
  return live ? `lane ${lane} has live run ${live.id} in ${live.data.worktree ?? '?'}` : null;
}

// a check-in is not a worker: it never counts against (or is refused by) the worker caps
// the first full cap of run spec o as a refusal message, or null (room in every cap)
// reserve (MERGE-FIRST, policy.fill.merge_reserve): the slots of each cap a non-landing run must leave free while a landing run waits
function capFull(o, staleMs, extra = [], reserve = 0) {   // extra: run data that would start first (the dry walk, META-GTP-DAG)
  if (o.kind === 'checkin') return null;
  const typed = !EXECUTORS[o.executor];
  const capOf = k => (Number.isInteger(o.budget?.[k]) ? o.budget[k] : typed ? capDefault(o.provider) : null);  // a typed executor always has a cap
  const caps = (infoOf(o).caps || []).filter(k => capOf(k) !== null);
  if (!caps.length) return null;
  const live = [...liveRuns(o.state, { staleMs }), ...extra.map(data => ({ data }))].filter(it => it.data.kind !== 'checkin');
  for (const k of caps) {
    const n = live.filter(it => capsOfRun(it.data).includes(k)).length;
    if (n >= capOf(k)) return `${n} ${CAP_LABEL[k] ?? k.slice(4)} workers running, budget ${k}=${capOf(k)}`;
    if (reserve > 0 && n + reserve >= capOf(k)) return `${n} ${CAP_LABEL[k] ?? k.slice(4)} workers running, budget ${k}=${capOf(k)}: ${reserve} slot(s) kept for the queued merges (fill.merge_reserve)`;
  }
  return null;
}
function capCheck(o, staleMs) { const full = capFull(o, staleMs); if (full) throw new RunRefused(full, 4); }

const drop = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

// lock: false (no worktree lock) is for a check-in, a helper whose parent holds the lock of the same worktree (metadelegate sec. 3) -
// read-only, or in a NAMED write mode of a cli executor (norn delegate --mode: the parent owns the tree and reviews every change) -
// or a READ-ONLY helper with no parent run (META-AGNOSTIC-EXEC: a Claude subagent with no RUN id of its own)
function helperLockCheck(o) {
  if (o.role === 'helper' && !o.parent && o.readonly === true) return;
  if (o.role === 'helper' && o.via === 'ask' && o.readonly === true) return;   // norn ask: its parent has ENDED (holds no lock)
  if (o.role !== 'helper' || !o.parent || (o.readonly !== true && !o.mode)) throw new RunRefused('lock: false is only for a check-in, a read-only helper, or a named-mode helper under its parent run', 3);
  const cur = readJson(lockPath(o.locksDir, o.worktree));
  if (cur?.run !== o.parent) throw new RunRefused(`worktree ${o.worktree}: its lock names ${cur?.run ?? 'no run'}, not the parent ${o.parent}`, 3);
}

/**
 * Launch one supervised run: sweep stale runs, take the worktree lock (exit 3), check the machine caps (exit 4), record
 * RUN start, spawn the detached supervisor. Returns { run, pid (supervisor), log, final, session_id }.
 * o: { state, locksDir, executor, brief, worktree, lane, notes?, stage?, round?, agent?, model?, effort?, budgetMin?, project?,
 *      exe?, headless?, env?, writable_roots?, resumes?, resumeOf?, policy {auto_resume_handoff, auto_resume_max, trigger_on_exit},
 *      budget {caps, weekly_stop_pct}, paused [files], statusFile?, ledger?, projectsDir?, tick [cmd] | null, hbMs?, staleMs? }
 */
// the launch preconditions of run spec o (shared by startRun and queueRun); returns its executor info
function launchable(o) {
  const info = infoOf(o);
  if (!info) throw unknownExecutor(o.executor);
  for (const [k, v] of [['state', o.state], ['locksDir', o.locksDir], ['brief', o.brief], ['worktree', o.worktree], ['lane', o.lane]]) if (!v) throw new RunError(`${k} is required`);
  if (!fs.existsSync(o.brief)) throw new RunError(`brief not found: ${o.brief}`);
  if (isMergeWtSpec(o)) { if (!fs.existsSync(o.merge_repo)) throw new RunError(`merge repo not found: ${o.merge_repo}`); }   // GAP-6: the start makes its merge worktree
  else if (!fs.existsSync(o.worktree)) throw new RunError(`worktree not found: ${o.worktree}`);
  if (o.executor !== 'fake' && o.provider?.runner !== 'fake' && !o.exe) throw new RunError(`no ${o.executor} executable (machine.json)`);
  if (isApi(o.provider)) { const miss = providerEnv(o.provider, process.env).missing; if (miss) throw new RunError(`executor ${o.executor}: its key env var ${miss} is not set`); }
  return info;
}
// NORN-WATCH S5 (11-09: `git worktree remove` deleted two lanes' gitignored ux/ reports): NOTES under an ignored path of the run's own
// worktree are recorded as a start warning (the run still starts: additive). One `git check-ignore` (5 s); any git failure = none.
export function notesWarnings(o) {
  if (!o.notes || !o.worktree) return [];
  const rel = path.relative(path.resolve(o.worktree), path.resolve(o.notes));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return [];
  const r = spawnSync(o.git || 'git', ['check-ignore', '-q', '--', rel], { cwd: o.worktree, timeout: 5000, windowsHide: true, stdio: 'ignore' });
  return r.status === 0 ? [`notes ${rel.replace(/\\/g, '/')} sit under a gitignored path of the worktree: git worktree remove deletes them - write lane output to a durable folder`] : [];
}

// the RUN start fields of spec o (a queue record keeps the same fields)
const startFields = (o, info) => ({
  kind: o.kind || info.kind, executor: o.executor, project: o.project, lane: o.lane, stage: o.stage, round: o.round,
  agent: o.agent, model: o.model, effort: o.effort, worktree: o.worktree, brief: o.brief, notes: o.notes });
const runTail = o => ({ budget_min: o.budgetMin, resumes: o.resumes || 0, resume_of: o.resumeOf, parent: o.parent, via: o.via, role: o.role, ...classStamp(o), q: o.q, tick_class: o.tickClass, trial: o.trial, fallback_of: o.fallbackOf,
  from_queue: o.fromQueue, requeue_of: o.requeueOf, after: o.after?.length ? o.after : undefined, inputs: o.inputs?.length ? o.inputs : undefined,
  epic: o.epic, priority: o.priority, nudge: o.nudge, flow: o.flow, slop_of: o.slopOf, dod_of: o.dodOf, dod_ready: o.dod ? { mode: o.dod.mode, ok: o.dod.ok, missing: o.dod.missing } : undefined,   // META-DOD 1: the Ready verdict + the Done-check resume
  critique: o.critique, floor: o.floor,   // floor: the worker floor raised this run (floor.mjs); META-DOD 3: a plan review ({ of: the plan run, plan: its file }; critique.mjs)
    // flow: META-GTP-FLOW piece 2 ({ name, step, vars }); slop_of: META-SLOP-A (the run-end slop resume)
  labels: o.labels?.length ? o.labels : undefined, claim_of: o.claim_of, replaces: o.replaces,
  launch_profile: o.profile?.name || 'full', memory: o.memory === 'off' ? 'off' : undefined, at_fill: o.atFill });   // memory: META-PRACTICE-P1 (auto memory off for this launch)   // launch_profile: the profile EVERY run launched with (launchpolicy.mjs profileOf; no profile = full) - overhead-audit S1: a floor is judged against it   // replaces: META-AUTONOMY R1 (norn requeue)   // claim_of: META-GTP-FED piece 3 ({ home, project, run, node } on a node)   // META-GTP-FED piece 1: the machines that may run it (none = home)
// META-TEND P2: the work class on EVERY run (workclass.mjs: class + how it was decided; o.workPolicy = the project's policy table)
const classStamp = o => { const w = workClass(o, o.workPolicy); return { class: w.class, class_basis: w.basis }; };
// owner Q4: Fable is the cost class - a run on it carries a notice (printed at launch, shown on the Usage tab with the week's count)
// the worker floor (floor.mjs, local/budget.json worker_min_model / worker_min_effort): a worker run below it is raised to it; the
// start / queue record carries floor: { model?: [from, to], effort?: [from, to] } and a notice. A check-in keeps its own model.
function withFloor(o) {
  if (!floorBinds(o) || (!o.model && o.executor !== 'claude')) return o;
  const r = raiseToFloor({ model: o.model, effort: o.effort }, floorOf(o.budget));
  return r.raised ? { ...o, model: r.model, effort: r.effort, floor: { ...(o.floor || {}), ...r.raised } } : o;
}
const floorNotice = o => (o.floor ? [`raised to the worker floor: ${Object.entries(o.floor).map(([k, [a, b]]) => `${k} ${a || '(default)'} -> ${b}`).join(', ')}`] : []);
const fableNotice = o => (isFable(o) ? [`Fable (${o.model || o.executor}) is the cost class: use it for the hardest long work only (the Usage tab counts the week's Fable runs)`] : []);
// META-GTP-DAG piece 2: a NEW run (not a fill / resume / re-queue of one) named --epic joins that open epic; no --priority = the epic's
const isNew = o => !o.fromQueue && !o.resumeOf && !o.requeueOf && !o.replaces;
function withEpic(o) {
  if (o.priority !== undefined && o.priority !== null && !PRIORITIES.includes(o.priority)) throw new RunError(`--priority ${JSON.stringify(o.priority)}: want ${PRIORITIES.join(' | ')}`);
  if (!o.epic || !isNew(o)) return o;
  try { return { ...o, priority: o.priority ?? openEpic(o.state, o.epic).data.priority }; } catch (e) { if (e instanceof EpicError) throw new RunError(e.message); throw e; }
}
// MERGE-FIRST (owner 11-19: "prioritize merging so we don't end up with some huge backlog of finished but unmerged work"; 11 merges
// waited at the default P2 while P0 / P1 build work passed them): a LANDING run - a MERGE, or the resolve run that brings a branch up
// to main - runs at the priority of the work it lands (the newest other run of its lane; none = the default P2), never below P1.
// A priority given (--priority, a re-queue's) is raised to P1 the same way: no landing run waits behind the default.
export const LANDING_FLOOR = 'P1';
export const isLandingStage = stage => isMergeStage(stage) || String(stage ?? '').toLowerCase() === 'resolve';
const higher = (a, b) => PRIORITIES[Math.min(PRIORITIES.indexOf(a), PRIORITIES.indexOf(b))];
/** the priority of the work a landing run of lane lands: its newest non-landing run's (no priority = the default) */
export function workPriority(runs, lane) {
  const w = runs.filter(r => r.kind === 'run' && r.data.lane === lane && r.data.kind !== 'checkin' && !isLandingStage(r.data.stage))
    .sort((a, b) => Number(b.id.slice(4)) - Number(a.id.slice(4)))[0];
  return PRIORITIES.includes(w?.data.priority) ? w.data.priority : DEFAULT_PRIORITY;
}
export function landingPriority(o) {
  if (!isLandingStage(o.stage) || o.kind === 'checkin') return o;
  return { ...o, priority: higher(o.priority ?? (o.state ? workPriority(runsOf(o.state), o.lane) : DEFAULT_PRIORITY), LANDING_FLOOR) };
}

// META-ONBOARD cut-over: <state root>/SWAP.lock (written by onboard-cutover.mjs --apply for its swap steps, < 2 min) holds NEW starts:
// a start waits while it is fresh (swapWaitMs, default 5 min), then refuses with code 4 (a --queue start queues). A lock older than
// SWAP_STALE_MS (a crashed cut-over) is ignored. Live runs are never touched.
export const SWAP_STALE_MS = 15 * 60000;
export function swapLockFile(state) { return path.join(path.dirname(path.resolve(state)), 'SWAP.lock'); }
function swapWait(o) {
  const f = swapLockFile(o.state), end = Date.now() + (o.swapWaitMs ?? 5 * 60000);
  for (;;) {
    let ts;
    try { ts = Date.parse(JSON.parse(fs.readFileSync(f, 'utf8')).ts); } catch { return; }   // no lock (or unreadable = being removed)
    if (!(Date.now() - ts < SWAP_STALE_MS)) return;
    if (Date.now() >= end) throw new RunRefused(`swap lock held (${fwd(f)}: a cut-over is swapping the install) - retry in a minute`, 4);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
}

// META-CONTROLLER C4 (SPEC sec. 2): a check-in's new run on a lane the controller holds is refused (exit 5); a fill of a run queued
// before the hold is the launcher's, not the check-in's, and goes on
export function heldRefusal(state, lane, caller, now = Date.now()) {
  if (caller !== 'checkin' || !lane) return;
  const h = holdOf(fold(readEvents(recordsFile(state, 'lane'))).items[laneId(lane, state)], now);
  if (h) throw new RunRefused(holdMessage(h), HELD_EXIT);
}
// META-CHECKIN-GUARDS R1 guard A (checkinguards.busyRefusal, the replay grader's too): a check-in's new run (start or --queue) on a
// worktree with a live writer is refused (exit 6) unless chained behind that worktree's runs (--after run:RUN-n:...); noted on the
// check-in's run. A fill of a queued run is the launcher's, not the check-in's.
export function busyDoor(o) {
  if (o.caller !== 'checkin' || o.fromQueue) return;
  const here = path.resolve(o.state);
  const runs = [...liveRuns(o.state, { staleMs: o.staleMs ?? STALE_MS }).filter(r => r.state_dir === here), ...runsOf(o.state).filter(r => r.state === 'queued')];
  const why = busyRefusal({ lane: o.lane, worktree: o.worktree, stage: o.stage, after: o.after }, runs);
  if (!why) return;
  noteRefusal(o.state, why, { guard: 'busy', lane: o.lane ?? null, stage: o.stage ?? null });
  throw new RunRefused(why, BUSY_EXIT);
}
// the caller's role is checked once, at the door: it never rides into a queue / run spec (a supervisor resume or re-queue is the launcher's)
const noCaller = ({ caller: _c, ...o }) => o;

// ---------- RM-46 S2b (multi-home SPEC 4.4): the work claim at dispatch ----------
// Every dispatch path (norn run, the fill, check-in stage runs, relaunchLost, resumes) passes startRun, so claimDoor is the one hook:
// after the cheap local refusals, before the worktree lock. Only a synced project (home.json) with a ledger remote claims, and only a
// lane run that writes. Exempt: check-ins, helpers (the parent's claim covers them), audits, talks, plan reviews, read-only runs, and
// MERGE stages (leaderDoor: the merge leader's, S6a). Item / branch overlap refuses (exit 3, the holder named); scope overlap, a busy claims branch
// and an unreachable ledger hold the run queued (ClaimHeld) - the fill tries again on its next pass.
export class ClaimHeld extends RunRefused { constructor(msg, home) { super(msg, 3); this.home = home; } }
const claimExempt = o => !o.lane || ['checkin', 'audit', 'talk', 'interactive'].includes(o.kind) || o.role === 'helper' || !!o.critique || o.stage === 'MERGE' || !writeTrees(o).length;
const gitOut = (cwd, args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return r.status === 0 ? r.stdout.trim() : null; };
/** the files a worktree changes against its merge-base with origin/main (SPEC 3.6 touched; [] without a worktree or origin/main) */
export function touchedOf(worktree) {
  const wt = worktree && fs.existsSync(worktree) ? worktree : null, base = wt && gitOut(wt, ['merge-base', 'HEAD', 'origin/main']);
  return base ? (gitOut(wt, ['diff', '--name-only', base]) || '').split('\n').filter(Boolean) : [];
}
// the open roadmap items linking one of `links`, from the item events (roadmap.mjs imports runs.mjs: its fold here would close a cycle)
function laneItems(events, links) {
  const L = {}, open = {};
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.kind !== 'item') continue;
    const d = e.data || {};
    if (e.ev === 'create') { L[e.id] = new Set(d.links || []); open[e.id] = true; }
    if (!L[e.id]) continue;
    if (e.ev === 'link') for (const x of d.links || []) L[e.id].add(x);
    if (e.ev === 'unlink') for (const x of d.links || []) L[e.id].delete(x);
    if (e.ev === 'drop' || e.ev === 'reopen') open[e.id] = e.ev === 'reopen';
  }
  return Object.keys(L).filter(id => open[id] && links.some(l => L[id].has(l)));
}
/** the work claim of a launch: branch + touched from its worktree (merge-base with origin/main), scope from its brief's Scope: line
 *  (none = the whole repo), items = the open roadmap items linking its lane (this home's roadmap until S1d merges the others) */
export function workOf(o, home, project) {
  const wt = o.worktree && fs.existsSync(o.worktree) ? o.worktree : null, br = wt && gitOut(wt, ['rev-parse', '--abbrev-ref', 'HEAD']), touched = touchedOf(wt);
  let scope = [], items = [];
  try { scope = parseReady(fs.readFileSync(o.brief, 'utf8')).scope; } catch { /* no brief file: the whole repo */ }
  const links = [`lane:${home}/${o.lane}`, `lane:${o.lane}`];
  try { items = laneItems(readEvents(recordsFile(o.state, 'item')), links); } catch { /* no roadmap yet: no items to claim */ }
  return { project, home, lane: o.lane, branch: br && br !== 'HEAD' ? br : null, items, scope, touched, run: o.resumeOf ?? null };
}
/** a queued run a claim holds: <state>/sync/claim-holds.json (the digest's "held by <home>"); why null = it no longer waits on a claim */
export const noteClaimHold = (state, run, e) => updateSync(state, 'holds', h => { const { [run]: _x, ...rest } = h; return e ? { ...rest, [run]: { why: e.message, home: e.home ?? null } } : rest; });
/** RM-46 S6a (SPEC 4.8): a MERGE stage of a synced project starts only on its merge leader (local: no network) - else RunRefused 3 */
function leaderDoor(o) {
  const f = homeOf(o.state) ? fedOf(o.git_ledger) : null;
  if (!f) return;
  const why = leaderWhy(o.state, f, { project: path.basename(path.resolve(o.state)), now: o.now ?? Date.now(), pol: syncPolicy(specPolicy({ ctx_from: policySource(o) })) });
  if (why) throw new RunRefused(`MERGE: ${why} - this home only opens PRs`, 3);
}
/** the claim of launch o: null (exempt / not synced) | { key, n } (won) - throws RunRefused 3 (item / branch) or ClaimHeld (wait queued) */
export function claimDoor(o) {
  if (o.stage === 'MERGE') leaderDoor(o);
  if (claimExempt(o)) return null;
  const home = homeOf(o.state)?.id, f = home ? fedOf(o.git_ledger) : null;
  if (!f) return null;
  const now = o.now ?? Date.now(), project = path.basename(path.resolve(o.state)), pol = syncPolicy(specPolicy({ ctx_from: policySource(o) }));
  const me = workOf(o, home, project), key = workKey(project, home, me.lane), opts = { lease_s: pol.lease_s, now };
  let r;
  try {
    r = claimWork(f, me, opts);
    // an unchanged own claim starts without network only while it is not fenced (a renew landed within fence_s on this clock); else
    // one renew confirms it - or finds it taken over, and this dispatch claims afresh
    const mine = readSync(o.state, 'own')[key];
    if (r.won && r.again && !(mine?.nonce === r.claim.nonce && now - mine.confirmed_ms <= pol.fence_s * 1000)) {
      const rn = renewWork(f, { [key]: { nonce: r.claim.nonce } }, { now });
      r = !rn.ok ? { queued: true, why: rn.why } : rn.renewed[key] ? { won: true, key, n: rn.renewed[key], claim: { ...r.claim, n: rn.renewed[key] } } : claimWork(f, me, { ...opts, precheck: false });
    }
  } catch (e) { if (e instanceof ClaimsError) throw new RunRefused(`claim: ${e.message}`, 3); throw e; }
  if (r.refused) throw new RunRefused(`claim: ${r.why}`, 3);
  if (!r.won) throw new ClaimHeld(`claim: ${r.why}`, r.hit?.home ?? null);
  updateSync(o.state, 'own', m => ({ ...m, [key]: { project, home, lane: me.lane, nonce: r.claim.nonce, n: r.n, confirmed_ms: r.again ? m[key]?.confirmed_ms ?? now : now } }));
  if (o.fromQueue) noteClaimHold(o.state, o.fromQueue, null);
  return { key, n: r.n };
}
export function startRun(o) {
  if (!o.fromQueue) heldRefusal(o.state, o.lane, o.caller);
  const caller = o.caller;
  o = mergeSpec(withFloor(landingPriority(withEpic(noCaller(o)))));
  duplicateCheck(o);
  busyDoor({ ...o, caller });
  if (o.after?.length && !o.fromQueue) {   // NORN-WATCH S4: a run with `after:` conditions always queues; fillPass starts it once all are met
    const { queue: _q, ...rest } = o;
    return { ...queueRun(rest), queued: true, why: 'waits for its after: conditions' };
  }
  if (o.labels?.length && !o.fromQueue && !o.claim_of) {   // META-GTP-FED piece 1: a labelled run always queues; the fill here or a node serving its labels starts it (a node's claimed run starts in place)
    const { queue: _q, ...rest } = o;
    return { ...queueRun(rest), queued: true, why: `labels ${o.labels.join(',')}: started by a machine that serves them` };
  }
  // RM-37: while a pause holds starts (Hold the queue / Pause everything) new work and hand-off resumes wait queued, never refused;
  // a resume (a continuation) goes ahead of new work, merges first (pausemode.mjs heldPriority). A check-in and a helper are not held here.
  if (!o.fromQueue && o.kind !== 'checkin' && o.role !== 'helper') {
    const ph = readPause(o.paused);
    if (holdsStarts(ph)) { const { queue: _q, ...rest } = o; return { ...queueRun(o.resumeOf ? { ...rest, priority: heldPriority(rest) } : rest), queued: true, why: `held: ${ph.label} (${ph.file})` }; }
  }
  if (o.queue) {   // META-GT12: a full cap queues the run instead of refusing it (a held worktree still refuses: exit 3)
    const { queue: _q, ...rest } = o;
    // a rebase MERGE whose lane worktree is held waits queued; the fill starts it when the lock frees
    const mh = heldTrees(rest, rest.staleMs ?? STALE_MS).find(h => !h.own);
    if (mh) return { ...queueRun(rest), queued: true, why: heldWords(mh) };
    const sf = slotsFull(rest, rest.staleMs ?? STALE_MS);   // GAP-6: every merge slot of the repo taken: it waits queued
    if (sf) return { ...queueRun(rest), queued: true, why: sf };
    // META-GTP-DAG piece 0 (norn RUN-36 started at RATE_OK=0): the immediate start obeys the fill's usage guard; refused = queued
    const refused = limitRefusal(rest.state, rest, { now: rest.now }) || (onAccount(infoOf(rest)) ? usageRefusal(rest, rest.state) : null) || authGate(rest) || resourceGate(rest, rest.resources || sampleResources);   // + piece 5, META-AUTH
    if (refused) return { ...queueRun(rest), queued: true, why: refused };
    try { return startRun(rest); } catch (e) { if (!(e instanceof RunRefused) || e.code !== 4) throw e; return { ...queueRun(rest), queued: true, why: e.message }; }
  }
  // META-LIMIT-GATE: an executor out of quota dies in seconds (RUN-562) - refused like a full cap (exit 4), naming its reset and an open
  // executor; a queued run was gated by the fill's walk (its clock), so a fill start is not checked twice
  if (!o.fromQueue) { const lr = limitRefusal(o.state, o, { now: o.now }); if (lr) throw new RunRefused(lr, 4); }
  if (!o.fromQueue && o.kind !== 'checkin' && o.role !== 'helper') {   // META-AUTH: while the login is down a launch dies in 0.1 s - it waits queued
    const a = authGate(o);
    if (a) return { ...queueRun(o), queued: true, why: a };
  }
  swapWait(o);
  const info = launchable(o);
  const staleMs = o.staleMs ?? STALE_MS, hbMs = o.hbMs ?? HB_MS;
  sweepLost(o.state, { staleMs, by: 'launcher' });
  const mr = mergeStageRefusal(o, staleMs);
  if (mr) throw new RunRefused(mr, 3);
  let claim;   // RM-46 S2b: the work claim, last before the worktree lock; a direct dispatch it holds waits queued, a fill's stays queued
  try { claim = claimDoor(o); } catch (e) {
    if (!(e instanceof ClaimHeld) || o.fromQueue) throw e;
    const q = queueRun(o);
    noteClaimHold(o.state, q.run, e);
    return { ...q, queued: true, why: e.message };
  }
  if (o.lock === false && o.kind !== 'checkin') helperLockCheck(o);
  let lock = o.lock === false ? { file: null, files: [], refresh() {}, release() {} } : acquireTrees(o.locksDir, writeTrees(o), { run: 'pending', staleMs });
  try {
    if (isMergeWtSpec(o) && o.lock !== false) lock = handleOf([...lock.hs, acquireSlot(o, { run: 'pending', staleMs })]);   // GAP-6: one merge slot of the repo
    capCheck(o, staleMs);
    if (isMergeWtSpec(o)) prepareMergeWt(o);   // GAP-6: its own merge worktree (kept on a resume), the leftovers swept
    const base = path.join(o.state, 'logs', `${o.lane}-${stamp()}-${crypto.randomBytes(3).toString('hex')}`);
    const log = base + '.log', final = base + (info.harness === 'codex' ? '.md' : '.json');
    // META-GTP-MAIL piece 3: a nudge resumes the SAME session (claude --resume <sid> keeps its id unless --fork-session)
    const session_id = o.resumeSid || (info.harness === 'claude' || info.harness === 'fake' ? crypto.randomUUID() : null);
    const resumes = o.resumes || 0;
    const warnings = [...notesWarnings(o), ...floorNotice(o), ...fableNotice(o), ...(o.dod?.mode === 'warn' && !o.dod.ok && !o.resumeOf ? [o.dod.why] : [])];   // META-DOD 1: policy.dod.ready warn
    // WORK-SIZING S1: the context marks the run starts under, on its record (enforcement still reads the live policy: ctxlimit.mjs)
    const ctx_marks = info.harness === 'claude' || info.harness === 'fake' ? { ...ctxLimits(specPolicy({ ctx_from: policySource(o) }), ctxRole(o)), src: 'role' } : undefined;
    const ev = record(o.state, { kind: 'run', ev: 'start', by: 'launcher', data: drop({ ...startFields(o, info), log, final, session_id, ...runTail(o), ctx_marks, warnings: warnings.length ? warnings : undefined, claim: claim ?? undefined }) });
    const run = ev.id;
    if (o.epic && isNew(o)) joinEpic(o.state, o.epic, run);
    lock.refresh({ run });
    fs.mkdirSync(path.join(o.state, 'hb'), { recursive: true });
    fs.mkdirSync(path.join(o.state, 'logs'), { recursive: true });
    writeAtomic(hbPath(o.state, run), { run, pid: null, supervisor_pid: null, ts: new Date().toISOString() });
    const { atFill: _af, ...ro } = o;   // META-QUEUE-SPEC R1: at_fill belongs to this start record only (a resume of the spec is no fill)
    const spec = { ...ro, run, log, final, session_id, resumes, hbMs, staleMs, lockFile: lock.file, lockFiles: lock.files, mail_hook: o.mail_hook ?? mailHookOf(o), scope: scopeOfLaunch(o),
      ctx_from: policySource(o) };   // META-CTX-ENFORCE R1: the project.json whose CURRENT policy.context binds the run (ctxlimit.mjs)
    const specFile = path.join(o.state, 'runs', run + '.spec.json');
    fs.mkdirSync(path.dirname(specFile), { recursive: true });
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 1));
    // NORN-WATCH S5: started from inside a reaped run's job (META_JOB) = break away, unless it is that run's own helper (dies with it)
    const away = process.env.META_JOB && !(o.role === 'helper' && o.parent && o.parent === process.env.META_RUN_ID)
      ? spawnOutside(process.execPath, [SUPERVISOR, specFile], { cwd: o.worktree }) : null;
    let pid = away?.pid;
    if (!away) { const sup = spawn(process.execPath, [SUPERVISOR, specFile], { detached: true, stdio: 'ignore', windowsHide: true, cwd: o.worktree }); sup.unref(); pid = sup.pid; }
    // the hb names the supervisor from its birth: a stop before its first beat (node start-up takes seconds on a loaded box) must
    // still kill it - a nameless hb left it and its executor alive for ever (CIRED-60fa8b6 R2). Its own beat (with the executor
    // pid) wins: the launcher writes only while the hb still names no supervisor.
    if (pid && !readJson(hbPath(o.state, run))?.supervisor_pid) writeAtomic(hbPath(o.state, run), { run, pid: null, supervisor_pid: pid, ts: new Date().toISOString() });
    lock.refresh({ pid });
    return { run, pid, log, final, session_id, ...(warnings.length ? { warnings } : {}), spawned: away ? (away.breakaway ? 'breakaway' : 'inside') : 'plain', ...(away && !away.breakaway ? { in_job: process.env.META_JOB } : {}) };
  } catch (e) { lock.release(); throw e; }
}

// META-AUTONOMY R1 cause 3 (DEC-92 / 94: meta-adopt A1 queued twice from two worktrees; the per-worktree writer gate cannot see it): a
// second QUEUED / RUNNING run of the same project (state dir) + lane + stage + round refuses (exit 3) - unless it continues that run: it
// names it as --parent (a resume), or is its fill / resume / re-queue / fallback / norn requeue. A run with no stage is never a duplicate.
const CONTINUES = ['parent', 'fromQueue', 'resumeOf', 'requeueOf', 'fallbackOf', 'replaces'];
export function duplicateOf(o) { return o.state ? duplicateIn(runsOf(o.state), o) : null; }
/** the same check on a list of run items (pure: the replay's history check walks recorded moves through it) */
export function duplicateIn(runs, o) {
  if (!o.lane || !o.stage || o.kind === 'checkin' || o.role === 'helper' || o.claim_of) return null;
  const mine = new Set(CONTINUES.map(k => o[k]).filter(Boolean));
  return runs.find(r => ['queued', 'running', 'claimed'].includes(r.state) && !mine.has(r.id) && r.data.kind !== 'checkin' && r.data.role !== 'helper'
    && r.data.lane === o.lane && r.data.stage === o.stage && (r.data.round ?? null) === (o.round ?? null)) ?? null;
}
function duplicateCheck(o) {
  const dup = duplicateOf(o);
  if (!dup) return;
  const what = `${o.lane} ${o.stage}${o.round !== undefined && o.round !== null ? ' round ' + o.round : ''}`;
  throw new RunRefused(`${what} is already ${dup.state} as ${dup.id}${dup.data.worktree ? ` (${fwd(dup.data.worktree)})` : ''} - one run per lane + stage + round;`
    + ` resume it with --parent ${dup.id}, or re-queue it: norn requeue ${dup.id} --after ... --why DEC-n`, 3);
}

// ---------- queue (META-GT12): a run waiting for a cap slot; filled FIFO per cap on every run exit and by norn status ----------
export const queueSpecPath = (state, run) => path.join(state, 'runs', run + '.queue.json');
// GAP-2 (queued runs kept stale settings): a queue spec is the launch spec of its queue time, but only what is genuinely the run's own
// may stay frozen in it. Two kinds of key:
//  - MACHINE-LEVEL, read LIVE at every fill walk and fill start: the whole machine budget (spec.budget_file = the local/budget.json
//    `norn run` read: worker caps max_*, billing + the usage guard keys, the worker floor worker_min_*, the default models / efforts
//    claude_model / *_effort, the typed executors' caps), and the project policy parts (launchpolicy.mjs resolveAtFill: memory, launch
//    profile, model / effort / agent / class when not given on the command line, a typed executor's entry). The pause files and
//    STATUS are paths derived from the state dir; their existence / content is read at each fill, so they never go stale.
//  - PER-RUN, kept as queued: executor, lane, brief, worktree, notes, stage, round, after / inputs, epic, priority, labels, parent / via,
//    the flags the dispatcher gave (refill.explicit: --model / --effort / --agent / --class), budget_min, the state / locks dirs.
// Not refreshed (machine.json, rarely changed): exe, node_labels, git_ledger. The queue spec keeps NO copy of the budget: queueRun names
// the file (the caller's budget_file, else this install's local/budget.json) and drops the object, so every fill reads the file. A file
// that is gone = {} (as `norn run` reads it); one that does not parse holds the run this pass (a term), never a launch on a guess.
export const machineBudgetFile = (env = process.env) => path.join(metaRoot(env), 'local', 'budget.json');
/** the machine budget in force NOW for a queued spec (spec.budget_file); throws a RunError when the file does not parse */
export function liveBudget(spec) {
  const f = spec.budget_file;
  try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new RunError(`budget ${fwd(f)} unreadable (${e.message}): held until it parses`);
  }
}
/**
 * Record a queued run (RUN event `queue`: the start fields + not_before, requeue_of) and keep its launch spec beside the run specs.
 * o: a startRun spec + notBefore? (ISO; the fill waits until then) + requeueOf? (the limit-exit run it repeats). Returns { run, position }.
 */
export function queueRun(o) {
  if (!o.fromQueue) heldRefusal(o.state, o.lane, o.caller);
  const caller = o.caller;
  o = { ...o, budget_file: path.resolve(o.budget_file ?? machineBudgetFile()) };   // GAP-2: the fill reads this file, never a copy
  o = mergeSpec(withFloor(landingPriority(withEpic(noCaller({ ...o, budget: o.budget ?? liveBudget(o) })))));   // a re-queue of a spec (no budget kept): the file's; GAP-6: a MERGE's own merge worktree
  duplicateCheck(o);
  busyDoor({ ...o, caller });
  const info = launchable(o);
  if (o.after?.length || o.inputs?.length) {
    try { checkRefs(o.state, o.after, o.inputs); } catch (e) { if (e instanceof AfterError) throw new RunError(e.message); throw e; }
  }
  const { queue: _q, notBefore, run: _r, log: _l, final: _f, session_id: _s, lockFile: _k, lockFiles: _ks, fromQueue: _fq, now: _n, budget: _b, ...spec } = o;
  const ev = record(o.state, { kind: 'run', ev: 'queue', by: 'launcher', data: drop({ ...startFields(o, info), ...runTail(spec), not_before: notBefore, warnings: [...floorNotice(o), ...fableNotice(o)].length ? [...floorNotice(o), ...fableNotice(o)] : undefined }) });
  if (o.epic && isNew(o)) joinEpic(o.state, o.epic, ev.id);
  const file = queueSpecPath(o.state, ev.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(spec, null, 1));
  return { run: ev.id, position: queueOf(runsOf(o.state)).find(x => x.id === ev.id)?.position ?? null };
}
// META-GTP-DAG piece 4: the fill order is priority (P0 first), then FIFO. A run with no priority ranks as P2 - the beads default
// (Gas Town `bd create`, priorities 0-4, default 2) - so a queue with no priorities keeps exactly the old FIFO order.
// MERGE-FIRST: land before start - a landing run outranks the other runs of its own priority and of one level above (a P1 MERGE
// goes before a P0 build, a P0 MERGE before everything), so finished work reaches main before new work takes the slot.
export const DEFAULT_PRIORITY = 'P2';
const rank = r => PRIORITIES.indexOf(PRIORITIES.includes(r.data.priority) ? r.data.priority : DEFAULT_PRIORITY);
const fillKey = r => 2 * rank(r) - (isLandingStage(r.data.stage) ? 3 : 0);
/** The queued runs of a fold's run items in fill order (priority, landing first, then oldest first), with their 1-based position in it (pure). */
export function queueOf(runs) {
  return runs.filter(r => r.kind === 'run' && r.state === 'queued').sort((a, b) => fillKey(a) - fillKey(b) || Number(a.id.slice(4)) - Number(b.id.slice(4)))
    .map((r, i) => ({ id: r.id, name: r.data.name ?? null, state: r.state, position: i + 1, lane: r.data.lane ?? null, stage: r.data.stage ?? null, kind: r.data.kind ?? null, role: r.data.role ?? null,
      executor: r.data.executor ?? null, model: r.data.model ?? null, not_before: r.data.not_before ?? null, requeue_of: r.data.requeue_of ?? null, queued: r.created,
      after: r.data.after ?? [], inputs: r.data.inputs ?? [], epic: r.data.epic ?? null, priority: r.data.priority ?? null, labels: r.data.labels ?? [] }));
}
/**
 * Start every queued run that may start now, in fill order (priority, then oldest first - META-GTP-DAG piece 4): not before its not_before, not while PAUSED, never on a worktree with a
 * live writer (it waits; later runs on other worktrees may pass it), fill order per cap (once a queued run finds a cap full, no later run
 * on any of its caps starts in this pass). One filler at a time per state dir (state/queue.lock). Returns [{ queued, next }].
 * Called by the supervisor on every run exit and by `norn status` (the tick should call it at its start too - CHECKIN-GATE lane).
 * META-GTP-CI-FILLWAKE F2 - no lost wakeup: a filler that finds the lock held sets state/queue.refill and tries the lock once more;
 * the holder clears the flag before each pass, passes again while it is set (re-checked before it releases), and re-checks it after
 * the release (re-acquiring if set). The standard pending-work flag + re-check-after-release of a lock-protected worker (the
 * Linux irq_work / Go runtime "wakeup pending" pattern): every fillQueue call is followed by a pass that began after the call did.
 * onPass: a test seam, called after each pass under the lock.
 */
export function fillQueue(state, { now, resources = sampleResources, onPass, authProbe = probeAuth, io = fs } = {}) {
  const lockFile = path.join(state, 'queue.lock'), flagFile = path.join(state, 'queue.refill');
  const token = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;   // this call's lock: the release frees only its own
  const transient = (fn, what) => retryTransient(fn, `${what} ${fwd(lockFile)}`);
  // the lock's holder as read now: live (fresh JSON, or created by 'wx' with its JSON not yet written - FLOW-STALL suspect (i): that
  // was broken as stale), stale (ts, else mtime, older than STALE_MS), free (gone), pending (Windows delete-pending / a sharing handle:
  // a holder released it - FLOW-STALL suspect (ii): the loser returned on it after its flag and nobody filled)
  const holder = () => {
    let raw, cur = null;
    try { raw = io.readFileSync(lockFile, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return 'free'; if (TRANSIENT.includes(e.code)) return 'pending'; throw e; }
    try { cur = JSON.parse(raw); } catch { /* being written */ }
    let ts = Date.parse(cur?.ts);
    if (Number.isNaN(ts)) { try { ts = io.statSync(lockFile).mtimeMs; } catch (e) { if (e.code === 'ENOENT') return 'free'; if (TRANSIENT.includes(e.code)) return 'pending'; throw e; } }
    return Date.now() - ts > STALE_MS ? 'stale' : 'live';
  };
  // true = ours; false only with a live holder seen after the call began (its after-release re-check sees our flag): never on a
  // released lock - free / stale / pending retry the create (pending waits like retryTransient, then fails loudly)
  const acquire = () => {
    fs.mkdirSync(state, { recursive: true });
    const t0 = performance.now();
    for (;;) {
      try { io.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token, ts: new Date().toISOString() }), { flag: 'wx' }); return true; }
      catch (e) { if (!['EEXIST', ...TRANSIENT].includes(e.code)) throw e; }
      const h = holder();
      if (h === 'live') return false;   // another filler is at it
      if (h === 'stale') { try { io.unlinkSync(lockFile); } catch { /* another breaker / pending: the next read says */ } }
      if (performance.now() - t0 > STALE_MS) throw new RunError(`queue fill: ${fwd(lockFile)} not acquired in ${STALE_MS} ms (${h})`);
      if (h === 'pending') sleepMs(25);
    }
  };
  // FLOW-STALL window (iii): a swallowed unlink failure left a holder-less fresh lock - every filler lost for STALE_MS
  const release = () => {
    let cur = null;
    try { cur = JSON.parse(transient(() => io.readFileSync(lockFile, 'utf8'), 'read')); } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return; throw e; }
    if (cur?.token !== token) return;   // broken as stale meanwhile: the lock is a successor's
    try { transient(() => io.unlinkSync(lockFile), 'release'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  };
  const unflag = () => { try { transient(() => io.unlinkSync(flagFile), 'clear flag'); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  const flagged = () => fs.existsSync(flagFile);
  const started = [];
  for (;;) {
    if (!acquire()) {
      // the loser: leave the flag, then try once more - a holder that released before the flag landed is gone, so the lock is free
      // (we fill) or a holder took it after the flag landed (its after-release re-check sees the flag). Never lost, no second lock.
      transient(() => io.writeFileSync(flagFile, ''), 'flag');
      if (!acquire()) return started;
    }
    try {
      let at, res;
      do {
        unflag();
        at = now ?? Date.now();
        let R;
        res = () => (R ??= resources());   // one sample per pass: the pass and the view after it read the same numbers
        started.push(...fillPass(state, at, res, authProbe));
        onPass?.();
      } while (flagged());
      try { const ready = readiness(state, { now: at, resources: res }); writeQueueView(state, {}, { ready, role: 'fill' }); writeOffers(state, ready); } catch { /* a view never fails a fill (NORN-WATCH S4) */ }
    } finally { release(); }
    if (!flagged()) return started;
  }
}
// META-QUEUE-SPEC R1: a queued run launches with the policy of NOW (launchpolicy.mjs); the start record names what was resolved (at_fill).
// A project.json that no longer loads keeps the run queued (refused, exit 3), never a launch on the old spec.
function atFill(spec) {
  let r;
  try { r = resolveAtFill(spec); } catch (e) { throw new RunRefused(`policy at fill: ${e.message}`, 3); }
  return r.at_fill ? { ...r.spec, atFill: r.at_fill } : r.spec;
}
function fillPass(state, now, resources, authProbe) {
  const started = [];
  const withdraw = (id, why) => { try { record(state, { kind: 'run', ev: 'withdraw', id, by: 'launcher', data: { why } }); } catch (e) { if (!(e instanceof RecordError)) throw e; } };
  fedPass(state, now);
  // META-AUTONOMY R1: a hold is recorded once per why (and cleared once) - the walk runs on every fill, the log grows only on a change
  const holds = new Map(runsOf(state).filter(r => r.state === 'queued' && r.hold).map(r => [r.id, r.hold]));
  const hold = (id, why) => {
    const cur = holds.get(id), held = cur && !cur.cleared;
    if (why ? held && cur.why === why : !held) return;
    try { record(state, { kind: 'run', ev: 'hold', id, by: 'launcher', data: why ? { why } : { cleared: true } }); } catch (e) { if (!(e instanceof RecordError)) throw e; }
  };
  walkQueue(state, { now, resources, authProbe, act: {
    withdraw,
    hold,
    start: (q, spec) => {
      homeClaim(state, q, spec);
      try { return startRun({ ...atFill(spec), fromQueue: q.id }).run; } catch (e) { if (e instanceof ClaimHeld) noteClaimHold(state, q.id, e); throw e; }   // RM-46 S2b: stays queued, the digest names the holder
    },
    started(q, next) {
      record(state, { kind: 'run', ev: 'fill', id: q.id, by: 'launcher', data: { next } });
      started.push({ queued: q.id, next });
    },
  } });
  return started;
}

// ---------- META-GTP-FED piece 2: the home side of the claim protocol (fed.mjs) ----------
// Runs only while a queued labelled run or a claimed run exists (else no git at all) and their spec names a ledger remote (machine.json
// ledger.remote, stamped into every spec as git_ledger). One fetch per pass. A node's claim of a queued run = record claim (it leaves the
// queue); a done claim = record fill (next = the node run); an expired lease = the claim removed by CAS, then record release (back in the
// queue) - only when that CAS won (a heartbeat that landed first keeps the run). A fetch failure is logged; the pass goes on without it.
const fedLog = (state, s) => { try { fs.appendFileSync(path.join(state, 'fed.log'), `${new Date().toISOString()} ${s}\n`); } catch { /* no dir */ } };
// the node runs of this project, read-only (digest sec. 1, norn runs --all-nodes); -cache.json = never in the ledger
export function writeForeign(state, nodes) {
  const f = path.join(state, 'fed-cache.json');
  writeAtomic(f, { at: new Date().toISOString(), nodes: Object.fromEntries(nodes.map(n => [n.node, n.runs])) });
}
function fedPass(state, now) {
  const watch = runsOf(state).filter(r => (r.state === 'queued' && r.data.labels?.length) || r.state === 'claimed');
  if (!watch.length) return;
  let f = null;
  for (const r of watch) if ((f = fedOf(readJson(queueSpecPath(state, r.id))?.git_ledger))) break;
  if (!f) return;
  const project = path.basename(path.resolve(state));
  let claims;
  try { claims = fetchClaims(f); } catch (e) { fedLog(state, `claims not read: ${e.message}`); return; }
  try { writeForeign(state, importForeign(f, project)); } catch (e) { fedLog(state, `node runs not imported: ${e.message}`); }
  const rec = (id, ev, data) => { try { record(state, { kind: 'run', ev, id, by: 'launcher', data: drop(data) }); return true; } catch (e) { if (!(e instanceof RecordError)) throw e; return false; } };
  for (const r of watch) {
    const key = claimKey(f.host, project, r.id), c = claims[key];
    let st = r.state;
    if (st === 'queued' && c && c.node !== f.host && rec(r.id, 'claim', { node: c.node, claimed_at: c.claimed_at, lease_s: c.lease_s })) st = 'claimed';
    if (st !== 'claimed') continue;
    if (!c) { rec(r.id, 'release', { why: 'its claim is gone from the claims branch' }); continue; }
    // META-GTP-FED-2 piece 1: a node with its own workspace pushed the run's NOTES on machine/<node> before its done mark (notes_key): the
    // fill names the home's read-only copy
    if (c.state === 'done') { rec(r.id, 'fill', { next: c.node_run || `${c.node}:not-started`, node: c.node, outcome: c.outcome, head: c.head, notes: importNotes(f, state, c.node, c.notes_key, r.id) }); continue; }
    if (!leaseExpired(c, now)) continue;
    const why = `lease expired: ${c.node} last heartbeat ${c.heartbeat_at} (lease ${c.lease_s} s)`;
    try { if (releaseClaim(f, key, c.nonce, why, { fetched: true }).ok) rec(r.id, 'release', { why, node: c.node }); } catch (e) { fedLog(state, `release ${r.id} failed: ${e.message}`); }
  }
}
// a labelled run this machine serves: with a ledger remote the home claims it (state home, no lease) before it starts - a node serving the
// same labels may be claiming it now; the CAS decides (lost = refused, exit 3: the next pass sees the node's claim)
function homeClaim(state, q, spec) {
  const f = q.labels?.length ? fedOf(spec.git_ledger) : null;
  if (!f) return;
  let r;
  try { r = claimRun(f, { home: f.host, project: path.basename(path.resolve(state)), run: q.id, labels: q.labels, state: 'home' }); } catch (e) { throw new RunRefused(`claim: ${e.message}`, 3); }
  if (!r.won) throw new RunRefused(`claim: ${r.why}`, 3);
}

// ---------- META-GTP-DAG piece 3: ONE walk for the fill and `norn ready` (kill criterion: two evaluators = a disagreement) ----------
// bd ready semantics (Gas Town docs/reference.md:681, cited not ported): a queued run is READY when no term blocks it; BLOCKED rows name
// every unmet term. The fill IS this walk with act (start / withdraw); `norn ready`, META-QUEUE.md and digest sec. 2 are the same walk
// dry (act null: nothing written; a row that would start counts against its caps for the rows after it, as the start would).
// META-GTP-DAG piece 5 (Gas Town internal/daemon/pressure.go:31-91 - a no-op on Windows there, pressure_windows.go:3-9; ours works on
// Windows): a run whose spec carries policy.fill (the CLI resolves project policy.fill over FILL_DEFAULTS into every run) waits while free
// RAM < min_free_gb or CPU busy > max_cpu_pct. CPU busy = 1 - idle / total of the os.cpus() time deltas over 1 s (sync).
// merge_reserve (MERGE-FIRST): while a landing run is queued and could start (no unmet after:, no future not_before), the other
// runs leave this many slots of each cap free for it
export const FILL_DEFAULTS = { min_free_gb: 4, max_cpu_pct: 90, merge_reserve: POLICY_DEFAULTS.fill.merge_reserve };
/** { free_gb, cpu_pct } now: os.freemem() and the os.cpus() deltas over ms; env META_FILL_SAMPLE (that JSON) pins it (tests, a drill) */
export function sampleResources({ ms = 1000, src = 'fill' } = {}) {   // src: who sampled, for cpu.jsonl
  const pin = process.env.META_FILL_SAMPLE;
  if (pin) {
    let v = null;
    try { v = JSON.parse(pin); } catch { /* below */ }
    if (!(typeof v?.free_gb === 'number' && typeof v?.cpu_pct === 'number')) throw new RunError(`META_FILL_SAMPLE ${JSON.stringify(pin)}: want {"free_gb": n, "cpu_pct": n}`);
    return { free_gb: v.free_gb, cpu_pct: v.cpu_pct };
  }
  const tot = () => os.cpus().reduce((s, c) => { const t = c.times; s.idle += t.idle; s.all += t.user + t.nice + t.sys + t.idle + t.irq; return s; }, { idle: 0, all: 0 });
  const a = tot();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const b = tot(), all = b.all - a.all, cpu = all > 0 ? 100 * (1 - (b.idle - a.idle) / all) : 0;
  noteCpu(cpu, src);
  return { free_gb: os.freemem() / 2 ** 30, cpu_pct: cpu };
}
// worker-speed: every real CPU sample Norn takes (this gate's, the lost sweep's, the dash's 15 s one) is kept in <norn>/local/cpu.jsonl, so `norn speed`
// can say how busy the machine was while a run ran - no sampler of its own. One machine, one file; past CPU_LOG_MAX bytes it keeps its
// newer half. A failed write never fails the caller.
const CPU_LOG_MAX = 1 << 20;
export const cpuLogFile = (meta = metaRoot()) => path.join(meta, 'local', 'cpu.jsonl');
export function noteCpu(pct, src, { file = cpuLogFile(), now = Date.now() } = {}) {
  if (!Number.isFinite(pct)) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date(now).toISOString(), cpu: Math.round(pct * 10) / 10, src }) + '\n');
    if (fs.statSync(file).size > CPU_LOG_MAX) { const t = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, t.slice(t.indexOf('\n', t.length >> 1) + 1)); }
  } catch { /* a sample log never fails a fill or a page */ }
}
/** the samples in [from, to] (ms): [{ t, cpu, src }] */
export function readCpu({ file = cpuLogFile(), from = -Infinity, to = Infinity } = {}) {
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(l => { try { const j = JSON.parse(l), t = Date.parse(j.ts); return t >= from && t <= to && Number.isFinite(j.cpu) ? [{ t, cpu: j.cpu, src: j.src }] : []; } catch { return []; } });
}
/** null = room; else the reason (the words norn ready prints after "resources: ") */
export function resourceRefusal(res, fill = {}) {
  const f = { ...FILL_DEFAULTS, ...(fill || {}) };
  if (res.free_gb < f.min_free_gb) return `free RAM ${res.free_gb.toFixed(1)} GB < fill.min_free_gb ${f.min_free_gb}`;
  if (res.cpu_pct > f.max_cpu_pct) return `CPU busy ${Math.round(res.cpu_pct)} % > fill.max_cpu_pct ${f.max_cpu_pct}`;
  return null;
}
// META-AUTH: the login gate of the run's harness (authguard.mjs); a spec without a state dir is never held
const authGate = (spec, o = {}) => (spec.state ? authRefusal(spec.state, infoOf(spec)?.harness, { spec, ...o }) : null);
const resourceGate = (spec, sample) => { if (!spec.policy?.fill) return null; const r = resourceRefusal(sample(), spec.policy.fill); return r ? `resources: ${r}` : null; };
/** readiness(state, { now }) -> the dry walk's rows in fill order: { id, name, lane, stage, executor, epic, priority, position, ready, terms, withdraw? } */
export const readiness = (state, o = {}) => walkQueue(state, { ...o, act: null });

function walkQueue(state, { now = Date.now(), act = null, resources = sampleResources, authProbe = probeAuth } = {}) {
  const rows = [], blocked = new Map(), pending = [];   // blocked: cap -> the older row that found it full; pending: dry-run starts
  let E = null, R, L;
  const res = () => (R ??= resources());   // lazy: sampled only when a gated run would otherwise start, once per walk
  const queue = queueOf(runsOf(state));
  // MERGE-FIRST: the landing runs that hold the merge reserve - queued, and not waiting on a condition or a clock (those may wait for hours)
  const landing = new Set(queue.filter(q => isLandingStage(q.stage) && !(q.not_before && Date.parse(q.not_before) > now)
    && !(q.after.length && !evalAll(q.after, (E ??= makeEval(state))).conds.every(c => c.met))).map(q => q.id));
  for (const q of queue) {
    const row = { id: q.id, name: q.name, lane: q.lane, stage: q.stage, executor: q.executor, epic: q.epic, priority: q.priority, position: q.position, ready: false, terms: [] };
    rows.push(row);
    const gone = why => { row.withdraw = why; row.terms.push(`withdraw: ${why}`); act?.withdraw(q.id, why); };
    if (q.after.length) {   // NORN-WATCH S4: an unmet trigger waits without blocking FIFO (like not_before)
      const a = evalAll(q.after, (E ??= makeEval(state)));
      // META-AUTONOMY R1 cause 4: never a silent withdraw - a condition that can no longer be met (after the run family's fills /
      // resumes / re-queues / same lane + stage successors, after.mjs) HOLDS the run as "needs a ruling" for the check-in to repair
      if (a.gone.length) { const why = `after: ${a.gone.join('; ')}`; row.hold = why; row.terms.push(`needs a ruling: ${why}`); act?.hold?.(q.id, why); continue; }
      act?.hold?.(q.id, null);
      for (const c of a.conds) if (!c.met) row.terms.push(`after ${c.cond} unmet`);
    }
    if (q.not_before && Date.parse(q.not_before) > now) row.terms.push(`not_before ${q.not_before}`);
    let spec = readJson(queueSpecPath(state, q.id));
    if (!spec) { gone('queue spec missing'); continue; }
    try { spec = { ...spec, budget: liveBudget(spec) }; } catch (e) { row.terms.push(e.message); continue; }   // GAP-2: caps, usage guard, floor of NOW
    const paused = readPause(spec.paused);   // RM-37: Hold the queue / Pause everything hold every queued run; Pause check-ins none
    if (holdsStarts(paused)) row.terms.push(pauseTerm(paused));
    const info = infoOf(spec), caps = info?.caps || [], staleMs = spec.staleMs ?? STALE_MS;
    row.account = onAccount(info);   // GAP-1 (holds.mjs): "every queued Claude run held" counts the rows the usage guard applies to
    const usage = row.account ? usageRefusal(spec, state) : null;   // CHECKIN-V2 piece 0: the weekly guard + RATE_OK, like a dispatch (waits)
    if (usage) row.terms.push(`usage: ${usage}`);
    const lim = limitRefusal(state, spec, { limits: (L ??= openLimits(state, { now })) });   // META-LIMIT-GATE: waits for the reset, holds no cap
    if (lim) row.terms.push(lim);
    const bc = caps.filter(k => blocked.has(k));
    if (bc.length) row.terms.push(`cap ${bc.join(', ')}: kept for ${[...new Set(bc.map(k => blocked.get(k)))].join(', ')} (fill order per cap)`);
    for (const h of heldTrees(spec, staleMs)) row.terms.push(heldWords(h));   // META-MERGELOCK: a rebase MERGE waits for its lane worktree too
    { const sf = slotsFull(spec, staleMs); if (sf) row.terms.push(sf); }   // GAP-6: a MERGE waits for a merge slot
    const mr = mergeStageRefusal(spec, staleMs);   // META-GTP-MERGEQ piece 0: a rebase MERGE waits for its lane worktree
    if (mr) row.terms.push(mr);
    // META-GTP-FED piece 1: labels this machine does not serve wait (no cap held); with no other term the row is OFFERED to the nodes -
    // this walk stays the one readiness evaluator (META-GTP-DAG piece 3): a node claims only an offered row
    // META-GTP-FED-2 piece 3: Claude rows are offered too (DEC-47 interim "node 2 non-Claude only" lifted): the usage term above is the same
    // weekly guard + RATE_OK, and its estimate now counts the node runs' cache_read (status.mjs fedCacheR) - one ledger push of lag
    const served = spec.node_labels ?? [osLabel()], miss = unserved(q.labels, served);
    if (miss.length) { if (!row.terms.length) row.offer = true; row.terms.push(`labels ${miss.join(',')}: not served here (serves ${served.join(',')}) - a node serving them claims it`); continue; }
    if (row.terms.length) continue;   // the terms above wait without holding a cap for younger runs
    const reserve = !isLandingStage(q.stage) && landing.size ? Math.max(0, Number({ ...FILL_DEFAULTS, ...(spec.policy?.fill || {}) }.merge_reserve) || 0) : 0;
    const full = capFull(spec, staleMs, pending, reserve);
    if (full) { row.terms.push(`cap: ${full}`); if (!full.includes('fill.merge_reserve')) for (const k of caps) blocked.set(k, q.id); continue; }   // a reserve refusal holds no cap
    const rr = resourceGate(spec, res);   // piece 5: machine pressure is global, so it holds no cap for later rows
    if (rr) { row.terms.push(rr); continue; }
    // META-AUTH: last - only a launch that would go now probes / takes the canary (a held row must not spend the one launch)
    { const a = authGate(spec, { now, probe: authProbe, dry: !act }); if (a) { row.terms.push(a); continue; } }
    row.ready = true;
    if (!act) { pending.push(startFields(spec, info)); landing.delete(q.id); continue; }
    let next;
    try { next = act.start(q, spec); }
    catch (e) {
      row.ready = false;
      if (e instanceof RunRefused) { row.terms.push(`refused: ${e.message}`); if (e.code === 4) for (const k of caps) blocked.set(k, q.id); continue; }
      gone(`error: ${e.message}`); continue;
    }
    act.started(q, next);
    landing.delete(q.id);
  }
  return rows;
}

// ---------- usage-limit exits (META-GT12): the patterns are executor data (executors.LIMIT_PATTERNS / project.json limit) ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** { reset: ISO | null, line } when `text` (a log tail) carries a usage-limit signature of `pats`, else null. */
export function classifyLimit(text, pats, now = new Date()) {
  if (!text || !pats?.match?.length) return null;
  text = String(text);
  const hit = pats.match.map(p => text.match(new RegExp(p, 'i'))).find(Boolean);
  if (!hit) return null;
  let reset = null;
  for (const p of pats.reset || []) {
    const g = text.match(new RegExp(p, 'i'))?.groups;
    if (g?.epoch) { reset = new Date(Number(g.epoch) * 1000).toISOString(); break; }
    const c = g?.clock?.match(/(\d{1,2})(?::(\d\d))?\s*([ap])m/i);
    if (c) {   // a clock time is the machine's local time: the next one from now
      const t = new Date(now);
      const mon = g.mon && MONTHS.indexOf(g.mon.slice(0, 3).toLowerCase());
      // META-LIMIT-GATE: a date when given (RUN-562 "Nov 15th, 2026 5:01 PM" is not tonight); no year = the next such date
      if (mon >= 0 && g.day) t.setFullYear(g.year ? Number(g.year) : t.getFullYear(), mon, Number(g.day));
      t.setHours((Number(c[1]) % 12) + (c[3].toLowerCase() === 'p' ? 12 : 0), Number(c[2] || 0), 0, 0);
      if (t <= now && !(mon >= 0 && g.day)) t.setDate(t.getDate() + 1);
      else if (t <= now && !g.year && now - t > 86400000) t.setFullYear(t.getFullYear() + 1);
      reset = t.toISOString(); break;
    }
  }
  return { reset, line: matchExcerpt(text, hit) };   // META-AUTH-VENDOR: the matched text, not the line start
}

// ---------- stop / kill tree ----------
// POSIX = taskkill /T: the group of pid is frozen first (it spawns nothing more), then every descendant's group and the descendant
// itself die, then pid's group. A detached child leads its own group (the supervisor's executor), so a group kill alone missed it
// when the caller did not know its pid yet - a stop that read the hb just before the first beat (CIRED-b2caf4d).
const signal = (pid, sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* gone */ } } };
const PS = ['-A', '-o', 'pid=', '-o', 'ppid='];
function descendants(pid, psOut = spawnSync('ps', PS, { encoding: 'utf8' }).stdout) {
  const kids = {};
  for (const l of (psOut || '').split('\n')) { const [c, p] = l.trim().split(/\s+/).map(Number); if (c && p) (kids[p] ||= []).push(c); }
  const out = [], todo = [pid];
  while (todo.length) for (const c of kids[todo.pop()] || []) if (!out.includes(c)) { out.push(c); todo.push(c); }
  return out;
}
// DEC-1088: every tree kill is receipted first (kills.mjs: one line per process of the tree in rc's kills.jsonl). rc = { state | file,
// killer, reason }; returns the receipted rows ({ pid, name, cmd, ppid }) - [] for no pid.
export function killTree(pid, rc) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const rows = receiptTree(pid, rc, procList());
  if (process.platform === 'win32') { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30000 }); return rows; }
  signal(pid, 'SIGSTOP');
  for (const c of descendants(pid)) signal(c, 'SIGKILL');
  signal(pid, 'SIGKILL');
  return rows;
}
const execA = (cmd, args) => new Promise(ok => execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 }, (e, out) => ok(String(out || ''))));
/** killTree off the event loop (the dash server's stop): listing, taskkill / ps as async children */
export async function killTreeAsync(pid, rc) {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  const rows = receiptTree(pid, rc, await procListAsync());
  if (process.platform === 'win32') { await execA('taskkill', ['/PID', String(pid), '/T', '/F']); return rows; }
  signal(pid, 'SIGSTOP');
  for (const c of descendants(pid, await execA('ps', PS))) signal(c, 'SIGKILL');
  signal(pid, 'SIGKILL');
  return rows;
}
const SYNC_IO = { record: (s, ev) => record(s, ev), kill: killTree, unlink: f => { try { fs.unlinkSync(f); } catch { /* already gone: the stop goes on to the lock */ } }, release: releaseLock };
const ASYNC_IO = { record: (s, ev) => recordAsync(s, ev), kill: killTreeAsync, unlink: async f => { try { await fs.promises.unlink(f); } catch { /* already gone: the stop goes on to the lock */ } }, release: releaseLockAsync };

// Record the kill first (a supervisor still alive then fails its `end` and stops), then kill the tree, then free lock + heartbeat.
export const stopRun = a => runSteps(stopSteps(a), SYNC_IO);
/** stopRun for the dash server: the same steps, each write / kill awaited (META-DASH-ASYNC R1) */
export const stopRunAsync = a => runStepsAsync(stopSteps(a), ASYNC_IO);
function* stopSteps({ state, locksDir, run, by, why }) {
  const cur = runsOf(state).find(x => x.id === run);
  // META-AUTONOMY R1: the check-in withdraws a QUEUED run (with its ruling as --why); a kill stays owner / controller
  if (by === 'checkin' && cur && cur.state !== 'queued') throw new RunRefused(`${run} is ${cur.state}: a check-in withdraws only a QUEUED run - a kill stays owner / controller`, 3);
  if (by === 'checkin' && !why) throw new RunError('a check-in withdraw needs --why (its ruling, e.g. DEC-n)');
  if (cur?.state === 'queued') return yield ['record', state, { kind: 'run', ev: 'withdraw', id: run, by, data: drop({ why }) }];
  const hb = readJson(hbPath(state, run)) || {};
  const ev = yield ['record', state, { kind: 'run', ev: 'kill', id: run, by, data: drop({ why, pid: hb.pid, supervisor_pid: hb.supervisor_pid }) }];
  const rc = { state, killer: `norn stop by ${by} (pid ${process.pid})`, reason: `stop ${run}${why ? `: ${why}` : ''}` };
  yield ['kill', hb.supervisor_pid, rc];
  yield ['kill', hb.pid, rc];
  yield ['unlink', hbPath(state, run)];
  const it = runsOf(state).find(x => x.id === run);
  // META-MERGELOCK: every lock the run took (its spec's lockFiles: a MERGE holds a merge slot too), else its worktree's
  const files = readJson(path.join(state, 'runs', run + '.spec.json'))?.lockFiles;
  if (files?.length) for (const lf of files) yield ['release', lf, run];
  else if (it?.data.worktree && locksDir) yield ['release', lockPath(locksDir, it.data.worktree), run];
  yield* orphanSteps(state);
  return ev;
}

// META-AUTONOMY R1 (DEC-106 / 107 / 111: stop + hand re-queue of a whole chain): `norn requeue RUN-n --after ... --why W` - a QUEUED run
// re-queued with new conditions, one verb. The new run keeps the old one's launch spec (lane, stage, round, brief, executor, model,
// priority, not_before ...) and names it (replaces); the old one is withdrawn naming the new one (withdraw.next: conditions on it follow
// there, after.mjs follow); every queued run whose after: names the old one is rewired onto the new one (a rewire event + its spec).
// Roles: owner / dashboard / controller / checkin; --why required; never a RUNNING run (exit 3). -> { run, next, rewired: [ids] }
export const REQUEUE_ROLES = ['owner', 'dashboard', 'controller', 'checkin'];
// notBefore: undefined keeps the old run's not_before, null clears it (DEC-337: a limit clock the early reopen left behind), an ISO sets it.
// MERGE-FIRST: priority undefined keeps the old run's, after undefined keeps its after: conditions (`norn requeue RUN-n --priority P0`).
export function requeueRun({ state, run, after, by, why, notBefore, priority }) {
  if (!REQUEUE_ROLES.includes(by)) throw new RunError(`role ${by ?? '(none)'} may not re-queue a run (allowed: ${REQUEUE_ROLES.join(', ')})`);
  if (!why || !String(why).trim()) throw new RunError('norn requeue needs --why (the ruling, e.g. DEC-n)');
  if (notBefore && Number.isNaN(Date.parse(notBefore))) throw new RunError(`--not-before ${notBefore}: an ISO time or none`);
  if (priority !== undefined && !PRIORITIES.includes(priority)) throw new RunError(`--priority ${JSON.stringify(priority)}: want ${PRIORITIES.join(' | ')}`);
  const cur = runsOf(state).find(r => r.id === run);
  if (!cur) throw new RunError(`${run} does not exist in ${state}`);
  if (cur.state !== 'queued') throw new RunRefused(`${run} is ${cur.state}: only a QUEUED run is re-queued (a kill stays owner / controller: norn stop)`, 3);
  heldRefusal(state, cur.data.lane, by);
  const spec = readJson(queueSpecPath(state, run));
  if (!spec) throw new RunError(`${run}: its queue spec is missing (${fwd(queueSpecPath(state, run))})`);
  after ??= cur.data.after ?? [];
  if (after.some(c => c.kind === 'run' && c.id === run)) throw new RunError(`--after names ${run} itself`);
  const { replaces: _r, ...keep } = spec;
  const nb = notBefore === undefined ? cur.data.not_before : notBefore === null ? undefined : new Date(Date.parse(notBefore)).toISOString();
  const next = queueRun({ ...keep, state, after, replaces: run, notBefore: nb, priority: priority ?? cur.data.priority ?? keep.priority }).run;
  try { record(state, { kind: 'run', ev: 'withdraw', id: run, by, data: { why: String(why), next } }); } catch (e) {
    if (!(e instanceof RecordError)) throw e;   // the fill started it meanwhile: undo the re-queue
    record(state, { kind: 'run', ev: 'withdraw', id: next, by: 'launcher', data: { why: `re-queue of ${run} lost a race: ${e.message}` } });
    throw new RunRefused(`${run}: ${e.message}`, 3);
  }
  const rewired = [];
  for (const q of runsOf(state).filter(r => r.state === 'queued' && r.id !== next && (r.data.after || []).some(c => c.kind === 'run' && c.id === run))) {
    const swapped = q.data.after.map(c => (c.kind === 'run' && c.id === run ? { ...c, id: next } : c));
    record(state, { kind: 'run', ev: 'rewire', id: q.id, by, data: { after: swapped, why: String(why), from: run, to: next } });
    const f = queueSpecPath(state, q.id), s = readJson(f);
    if (s) fs.writeFileSync(f, JSON.stringify({ ...s, after: swapped }, null, 1));
    rewired.push(q.id);
  }
  return { run, next, rewired, priority: runsOf(state).find(r => r.id === next)?.data.priority ?? null };
}

// Children are stopped with the parent (metadelegate sec. 2): a running helper whose parent run is no longer running is
// recorded lost (role launcher; the helper's supervisor then fails its `end` and exits) and its process tree is killed.
// DEC-1088: only the pids the helper's own heartbeat registered (never a match by name / command line), each receipted first.
export const stopOrphans = (state, o) => runSteps(orphanSteps(state, o), SYNC_IO);
function* orphanSteps(state, { by = 'launcher' } = {}) {
  const runs = runsOf(state), byId = Object.fromEntries(runs.map(r => [r.id, r])), stopped = [];
  for (const it of runs) {
    if (it.state !== 'running' || it.data.role !== 'helper' || !it.data.parent) continue;
    if (it.data.via === 'ask') continue;   // norn ask: a helper of an ENDED run by design
    const p = byId[it.data.parent];
    if (p?.state === 'running') continue;
    const hb = readJson(hbPath(state, it.id)) || {}, why = `parent ${it.data.parent} ${p?.state ?? 'missing'}`;
    try { yield ['record', state, { kind: 'run', ev: 'lost', id: it.id, by, data: { why } }]; }
    catch (e) { if (!(e instanceof RecordError)) throw e; continue; }
    const rc = { state, killer: `stopOrphans by ${by} (pid ${process.pid}${process.env.META_RUN_ID ? `, ${process.env.META_RUN_ID}` : ''})`, reason: `orphaned helper ${it.id}: ${why}` };
    yield ['kill', hb.supervisor_pid, rc];
    yield ['kill', hb.pid, rc];
    yield ['unlink', hbPath(state, it.id)];
    stopped.push(it.id);
  }
  return stopped;
}
