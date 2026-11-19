// The detached run SUPERVISOR (META-GENERAL-DESIGN D7): `node supervisor.mjs <spec.json>`, started by runs.startRun.
// Spawns the executor, refreshes heartbeat + worktree lock every hbMs, records exit + outcome + usage, does the HANDOFF
// auto-resume (policy cadence auto_resume_handoff / auto_resume_max, weekly guard; a pause holds it queued, a paused hand-off waits for the owner), classifies usage-limit exits (outcome
// limit, re-queued after the reset; META-GT12), fills the run queue, triggers the tick on exit.
// Port of meta/worker-run.ps1 + the launch half of codex-impl.sh. Never prompts; every failure ends as a recorded event.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slopOn } from './policy.mjs';
import { record, RecordError, loadState } from './records.mjs';
import { providerEnv, limitPatterns, authPatterns, executorInfo } from './executors.mjs';
import { classifyAuth, markAuthDown, AUTH_REQUEUE_MAX, AUTH_RESUME_PROMPT } from './authguard.mjs';
import { ADAPTERS, capsOf } from './harness/index.mjs';
import { nudgeDue, nudgePrompt, NUDGE_AFTER_MIN } from './mail.mjs';
import { buildCommand, hbPath, refreshLock, releaseLock, startRun, stopOrphans, RunRefused, classifyLimit, queueRun, fillQueue, killTree, autoResumeRefusal, sweepLost } from './runs.mjs';
import { resolveShim } from './paths.mjs';
import { onRunDone } from './deliverables.mjs';
import { ingestRead } from './adopt.mjs';
import { holdJob, reapJob, reapGroup, spawnOutside, holdGone } from './jobguard.mjs';
import { killNames } from './kills.mjs';
import { usageRefusal, onAccount } from './usageguard.mjs';
import { nodeUsage } from './fed.mjs';
import { readGate, noteCheckin } from './gate.mjs';
import { ledgerStep } from './ledger.mjs';
import { syncStep } from './sync.mjs';
import { checkBranch, slopPrompt } from './slop/runend.mjs';
import { procStartAsync } from './legacy.mjs';
import { doneCheck, dodPrompt, testLine } from './dod.mjs';
import { critiqueOn, findingsCount } from './critique.mjs';
import { hostWrite } from './slop/host.mjs';
import { removeMergeWorktree } from './mergewt.mjs';
import { pauseOf } from './pause.mjs';
import { readPause, holdsStarts } from './pausemode.mjs';
import { ctxRole, ctxLimits, ctxLevel, transcriptCtx, specPolicy } from './ctxlimit.mjs';
import { findTranscript } from './harness/claude.mjs';
import { sizeOfRun } from './sizing.mjs';
import { resultDir, resultPath, readResult, writeResult, NO_RESULT } from './result.mjs';
import { cutoffOf } from './laneout.mjs';
import { postRunAsks } from './runasks.mjs';

const NORN_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'norn.mjs');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { run, state } = spec;
// gap #3: this run's own result directory (`norn done` writes result.json [+ HANDOFF.md] there; META_RESULT_DIR / META_RESULT)
const RESULT_DIR = resultDir(path.resolve(state), run), RESULT = resultPath(path.resolve(state), run);
const fwdPath = p => String(p).split(path.sep).join('/');
try { fs.mkdirSync(RESULT_DIR, { recursive: true }); } catch { /* norn done makes it */ }
// GAP-6: a merge worktree is removed at the run end - nothing but the executor may sit in it (Windows keeps a folder that is a live
// process's cwd: this process, and the job hold process it starts, would inherit it from the launcher)
if (spec.merge_wt) { try { process.chdir(path.resolve(state)); } catch { /* the launcher's cwd stays */ } }
const iso = () => new Date().toISOString();
const logLine = s => { try { fs.appendFileSync(spec.log, `${iso()} ${s}\n`); } catch { /* log dir gone */ } };
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const TAIL = 8192;
const tail = f => { const t = read(f); return t === null ? '' : t.slice(-TAIL); };
// META-MERGELOCK: every lock the run holds (runs.writeTrees + GAP-6: a MERGE holds a merge slot beside its own worktree's)
const lockFiles = spec.lockFiles ?? (spec.lockFile ? [spec.lockFile] : []);
let childPid = null;
let finished = false;
// META-ADOPT A2: a hard time cap (spec.capMs, the adopt read): the executor's tree is killed when it passes; the end says capped
let capTimer = null, capped = false;
let nudging = null, nudgeTimer = null, nudgeWaitLast = null;   // META-GTP-MAIL piece 3 (nudgeCheck)
let ctxForced = null, ctxTimer = null, ctxFile = null, ctxWaitLast = null;   // META-CTX-ENFORCE R1 (ctxCheck)

// a pid alone names whatever process holds it NOW (Windows reuses a freed pid; CI-HANG-6E54DAB R2): hb + end name the supervisor
// as (pid, OS start time) - the value procStart gives a reader, so the two compare equal while this process lives.
// CI-RED-18A9C0A R2: the probe (a PowerShell spawn on Windows) is async and the first beat comes before it - a slow runner's probe
// blocked the first beat past staleMs and the sweep marked the healthy run lost. Until it is known, hb has no supervisor_started
// (readers: the pid decides, tests/helpers/settled); it is added to the hb as soon as known, and the end record waits for it.
const probeDelay = Number(process.env.META_TEST_PROBE_DELAY_MS) || 0;   // test knob: a slow probe (the CI runner's slow spawns)
let supStarted = null;
const supStartedP = new Promise(r => setTimeout(r, probeDelay)).then(() => procStartAsync(process.pid)).then(t => { supStarted = t; beat(); return t; });
// META-CATCH S1: between ticks (15 min apart) a live supervisor sweeps its state for dead siblings once per SIBLING_SWEEP_MS - one
// sweeper per window (the stamp's mtime), the first beat only plants the stamp - so a dead run is recorded lost within minutes
const SIBLING_SWEEP_MS = 3 * 60e3, sweepStamp = path.join(path.resolve(state), 'hb', '.sweep');
function siblingSweep() {
  try {
    let age; try { age = Date.now() - fs.statSync(sweepStamp).mtimeMs; } catch { fs.writeFileSync(sweepStamp, iso()); return; }
    if (age < SIBLING_SWEEP_MS) return;
    fs.writeFileSync(sweepStamp, iso());
    const lost = sweepLost(state, { staleMs: spec.staleMs, by: 'launcher' }).filter(id => id !== run);
    if (lost.length) logLine(`sibling sweep: ${lost.join(', ')} lost`);
  } catch { /* next window */ }
}
const beat = () => {
  try {
    const f = hbPath(state, run), t = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(t, JSON.stringify({ run, pid: childPid, supervisor_pid: process.pid, ...(supStarted !== null ? { supervisor_started: supStarted } : {}), ts: iso() }));
    fs.renameSync(t, f);
  } catch { /* next beat */ }
  for (const lf of lockFiles) { try { refreshLock(lf, run, { pid: process.pid }); } catch { /* next beat */ } }
  siblingSweep();
};
beat();
const timer = setInterval(beat, spec.hbMs);

const env = { ...process.env };
// executor env from the project: null deletes; "${env:NAME}" expands from this process (e.g. PATH prepends); Windows keys
// are case-insensitive, so a set replaces any same-name key ("Path") instead of adding a duplicate
for (const [k, v] of Object.entries(spec.env || {})) {
  for (const old of Object.keys(env)) if (old.toUpperCase() === k.toUpperCase()) delete env[old];
  if (v !== null) env[k] = String(v).replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => process.env[n] ?? '');
}
// a typed executor: claude-compatible gets ANTHROPIC_* from its entry (openai-compatible / cli: none); the key comes from this process's env only (never the spec / a record)
if (spec.provider) for (const [k, v] of Object.entries(providerEnv(spec.provider, process.env).vars)) { if (v === null) delete env[k]; else env[k] = String(v); }
// OOTB-R2 N-16: META_RUN_STATE = the state dir of this run: META_RUN_ID / META_ROLE speak only for records of THAT state
Object.assign(env, { META_RUN_ID: run, META_RUN_STATE: path.resolve(state), META_RESUMES: String(spec.resumes || 0), META_RESULT_DIR: RESULT_DIR, META_RESULT: RESULT, ...(spec.notes ? { META_NOTES: spec.notes } : {}), ...(spec.session_id ? { META_SESSION_ID: spec.session_id } : {}) });

let cmd;
try { cmd = buildCommand({ ...spec, result: RESULT, resultDir: RESULT_DIR }); } catch (e) { finish(null, null, String(e.message)); }
// NORN-WATCH S5 (DEC-683): the whole tree ends with the run - Windows: this supervisor enters a job before the executor is born
// (jobguard.mjs); POSIX: the executor leads its own process group. Check-ins are not guarded (they dispatch the workers: a worker
// must never hang on its dispatcher's job), nor is policy reap "off".
const guard = !!cmd && spec.kind !== 'checkin' && (spec.policy?.reap ?? 'job') !== 'off';
let job = null;
delete env.META_JOB;
if (guard && process.platform === 'win32') {
  const j = await holdJob(process.pid);
  // K3 round 2: process.env too - the runs THIS process starts (auto-resume, nudge, queue fill, fallback) break away from its job
  if (j.error) logLine(`reap: unguarded (${j.error})`); else { job = j; env.META_JOB = j.name; process.env.META_JOB = j.name; }
}
logLine(`start ${run} executor=${spec.executor} model=${spec.model ?? '-'} effort=${spec.effort ?? '-'} resumes=${spec.resumes || 0} brief=${spec.brief}`);
const fds = [];
const open = (f, m) => { const fd = fs.openSync(f, m); fds.push(fd); return fd; };
let child;
if (cmd) {
  try {
    const logFd = open(spec.log, 'a');
    const outFd = cmd.stdout === 'final' ? open(spec.final, 'w') : logFd;
    const inFd = cmd.stdin ? open(cmd.stdin, 'r') : 'ignore';
    const sp = resolveShim(cmd.exe, cmd.args);  // npm .cmd shim -> node + JS entry, no shell (S10)
    child = spawn(sp.exe, sp.args, { cwd: spec.worktree, env, stdio: [inFd, outFd, logFd], windowsHide: true, ...(guard && process.platform !== 'win32' ? { detached: true } : {}) });
    childPid = child.pid ?? null;
    beat();
    // GAP-12: a lane start refreshes the overlap check (fetch origin + gh, overlap.mjs) in its own detached process - never on this
    // process's loop (the heartbeat); outside this run's job like the tick. A work run on a lane only; a failure is a log line
    if (spec.overlap && spec.lane && !['checkin', 'audit', 'talk'].includes(spec.kind) && spec.role !== 'helper' && !spec.parent) {
      try { const away = job ? spawnOutside(spec.overlap[0], spec.overlap.slice(1)) : null; if (!away) spawn(spec.overlap[0], spec.overlap.slice(1), { detached: true, stdio: 'ignore', windowsHide: true }).unref(); }
      catch (e) { logLine(`overlap check not started: ${e.message}`); }
    }
    child.on('error', e => finish(null, null, String(e.message)));
    child.on('exit', (code, signal) => finish(code, signal, null));
    if (nudgeable()) nudgeTimer = setInterval(nudgeCheck, spec.hbMs);
    if (ctxWatched()) ctxTimer = setInterval(ctxCheck, spec.hbMs);
    if (spec.capMs) capTimer = setTimeout(() => { capped = true; logLine(`time cap ${spec.capMs} ms: stopping the executor`); killTree(childPid, { state, killer: `${run} supervisor ${process.pid}`, reason: `time cap ${spec.capMs} ms` }); }, spec.capMs);
  } catch (e) { finish(null, null, String(e.message)); }
}

async function finish(code, signal, error) {
  if (finished) return;
  finished = true;
  await supStartedP;   // the end names the start time: the beat timer runs on until it is known
  clearInterval(timer);
  if (nudgeTimer) clearInterval(nudgeTimer);
  if (ctxTimer) clearInterval(ctxTimer);
  if (capTimer) clearTimeout(capTimer);
  for (const fd of fds) { try { fs.closeSync(fd); } catch { /* closed */ } }
  logLine(`exit=${code}${signal ? ' signal=' + signal : ''}${error ? ' error=' + error : ''}`);
  // a read-only helper cannot write: its final message (claude json result / a cli executor's plain stdout) becomes the answer file
  if ((spec.role === 'helper' || spec.kind === 'audit' || spec.critique) && spec.notes && !(read(spec.notes) || '').trim()) {   // META-TEND P5: an audit's report = its final message; META-DOD 3: so are a plan review's findings
    const raw = read(spec.final) || '';
    let text = raw;
    if (cmd?.parse === 'claude') { try { text = String(JSON.parse(raw).result ?? ''); } catch { text = ''; } }
    try { if (text.trim()) fs.writeFileSync(spec.notes, text.endsWith('\n') ? text : text + '\n'); } catch (e) { logLine(`answer not written: ${e.message}`); }
  }
  // gap #3: a worker run's outcome is its own result (`norn done`, <state>/results/RUN-n/) and nothing else: none = no-result
  const res = readResult(RESULT_DIR, { run, since: supStarted });
  if (res?.error) logLine(`result in ${RESULT_DIR} ignored: ${res.error}`);
  const byResult = res && !res.error ? res : null;
  // by exit, as before: a check-in (S5), an audit (its notes = the report) and a run whose answer is its final message (a helper, a
  // plan review): exit 0 = done; any run that exits non-zero = crash
  const byExit = code !== 0 || spec.kind === 'checkin' || spec.kind === 'audit' || spec.role === 'helper' || !!spec.critique;
  let outcome = code !== 0 ? 'crash' : byExit ? 'done' : byResult ? byResult.outcome : NO_RESULT;
  // META-AUTH: a crash whose log tail / final carries the executor's auth-failure signature is `auth` (its login is down), not a crash
  let auth = null;
  try {
    if (outcome === 'crash' && cmd) auth = classifyAuth(`${tail(spec.log)}
${tail(spec.final)}`, authPatterns(spec.executor, spec.provider || (spec.auth ? { auth: spec.auth } : undefined)));
  } catch (e) { logLine(`auth patterns failed: ${e.message}`); }
  if (auth) outcome = 'auth';
  // a crash / no-result exit whose log tail carries the executor's usage-limit signature is a `limit` (META-GT12)
  let limit = null;
  try {
    if (!auth && ['crash', NO_RESULT].includes(outcome) && cmd) limit = classifyLimit(`${tail(spec.log)}\n${tail(spec.final)}`, limitPatterns(spec.executor, spec.provider || (spec.limit ? { limit: spec.limit } : undefined)));
  } catch (e) { logLine(`limit patterns failed: ${e.message}`); }   // a broken project pattern never costs the end record
  if (limit) outcome = 'limit';
  if (nudging) { outcome = 'nudged'; limit = null; auth = null; }   // stopped by the nudge: whatever the killed tree exited with
  if (ctxForced) { outcome = 'handoff'; limit = null; auth = null; }   // ended at the hard max: a HANDOFF whatever the killed tree exited with
  // the result counts unless the outcome is the exit's (a forced hand-off's result is Norn's own: its HANDOFF.md feeds the resume)
  const fromResult = !!byResult && (!byExit || !!ctxForced);
  const outcomeSource = fromResult ? 'result' : byExit ? 'exit' : 'none';
  const data = { exit: Number.isInteger(code) ? code : null, outcome, outcome_source: outcomeSource, ...(fromResult ? { result: fwdPath(RESULT_DIR), ...(byResult.summary ? { summary: byResult.summary } : {}), ...(byResult.handoff ? { handoff: fwdPath(byResult.handoff) } : {}), ...(byResult.look ? { look: byResult.look } : {}) } : {}), pid: childPid, supervisor_pid: process.pid, supervisor_started: supStarted, ...(capped ? { capped: true } : {}) };
  if (limit) { data.reset = limit.reset; data.limit_line = limit.line; }
  if (auth) { data.auth_line = auth.line; data.auth_class = auth.cls; }   // META-AUTH-VENDOR: login | vendor
  if (outcome === 'stopped') data.why = byResult?.why;
  if (nudging) data.nudge = nudging.mail.id;
  if (ctxForced) data.ctx_forced = ctxForced;
  // RM-37: a HANDOFF after the owner's pause order (to this run, or to the session its nudge resumed) is a paused hand-off: never auto-resumed
  if (outcome === 'handoff') { try { const pz = pauseOf(state, run, spec); if (pz) data.paused = { mail: pz.mail, ...(pz.why ? { why: pz.why } : {}) }; } catch (e) { logLine(`pause order not read: ${e.message}`); } }
  if (signal) data.signal = signal;
  if (error) data.error = error;
  // lane-outputs item 10b: the CLI stopped the run's background work after its last turn ("Background tasks still running ... stopping
  // them"): the task names on the end, so the run and its lane say what was cut off
  const cutoff = cutoffOf(tail(spec.log));
  if (cutoff) data.cutoff = cutoff;
  // NORN-WATCH S5 evidence: an exit no `norn stop` explains, the worktree's uncommitted state, the branch + head it ended on
  if ((code === 143 || signal === 'SIGTERM') && !killedByMeta()) data.external_term = true;
  if (spec.worktree && spec.role !== 'helper') Object.assign(data, gitEvidence(spec.worktree));
  // DEC-1088: the end keeps WHAT was reaped (pid + image; kills.jsonl has the command lines), and a skipped non-member pid
  const reapRc = { state, killer: `${run} supervisor ${process.pid}`, reason: `reap: ${run} ended` };
  const reap = job ? reapJob(job, process.pid, reapRc) : guard && process.platform !== 'win32' && childPid ? reapGroup(childPid, reapRc) : null;
  if (reap?.error) data.reap_error = reap.error;
  else if (reap) { if (reap.killed.length) data.reaped = reap.killed; if (reap.skipped?.length) data.reap_skipped = reap.skipped; }
  if (data.reaped) logLine(`reaped ${data.reaped.length} process(es) left in the run's tree: ${killNames(data.reaped)}`);
  if (data.reap_skipped) logLine(`reap skipped ${killNames(data.reap_skipped)}: no longer in the run's job (a reused pid)`);
  // usage fields of the end record, by the adapter that parses this output (claude json final / codex log; cli plain: none)
  if (cmd && ADAPTERS[cmd.parse]) Object.assign(data, ADAPTERS[cmd.parse].endData({ final: spec.final, log: spec.log }));
  // META-GTP-FED-2 piece 2: a node run (claim_of) carries its usage for the home guard (fed.mjs nodeUsage; 0 for non-Claude)
  if (spec.claim_of) { try { data.node_usage = nodeUsage(data, onAccount(executorInfo(spec.executor, spec.provider))); } catch (e) { logLine(`node usage: ${e.message}`); data.node_usage = { tokens: 0, cache_read: 0 }; } }
  if (spec.session_id && spec.projectsDir) {
    try {
      for (const d of fs.readdirSync(spec.projectsDir)) {
        const t = path.join(spec.projectsDir, d, spec.session_id + '.jsonl');
        if (fs.existsSync(t)) { data.transcript = t.replace(/\\/g, '/'); break; }
      }
    } catch { /* no projects dir */ }
  }
  // RM-44 D1: every lane run end that leaves commits is checked (stopped and hand-off too) - slop before the Done check
  const slopOpen = slopEnd();
  // WORK-SIZING S1: the session's size on its end record, so the run stays judged after its transcript is gone (sizing.mjs)
  if (data.transcript && cmd?.parse === 'claude') {
    try { const s = sizeOfRun(data.transcript, { notesDir: spec.notes ? path.dirname(spec.notes) : null }); if (s) data.ctx = s; } catch (e) { logLine(`session size: ${e.message}`); }
  }
  // META-DOD 1 (DIR-68): a DONE counts only on Norn's own green Done check (dod.mjs) - the agent's words are never the evidence.
  // The heartbeat beats on while the brief's tests and the gate run; a red check ends the run STOPPED with the evidence (dodEnd resumes it once)
  if (outcome === 'done' && dodOn()) {
    const hb = setInterval(beat, spec.hbMs);
    try { data.dod = await doneCheck({ worktree: spec.worktree, dod: spec.dod, logDir: path.dirname(spec.log), run }); }
    catch (e) { data.dod = { ok: false, why: `Done check could not run: ${e.message.split(/\r?\n/)[0]}`, at: iso(), dirty: [], changed: [], out_of_scope: [], tests: [], problems: [] }; }
    finally { clearInterval(hb); }
    logLine(`dod: Done ${data.dod.ok ? 'green' : 'RED: ' + data.dod.why}${data.dod.tests.length ? ' (' + data.dod.tests.map(testLine).join('; ') + ')' : ''}`);
    if (!data.dod.ok) { outcome = 'stopped'; data.outcome = 'stopped'; data.why = `Done check failed: ${data.dod.why}`; }
  }
  // META-DOD 3: a plan review's end names its findings file and count (critique.mjs: 0 = clean, the build it holds goes)
  if (spec.critique) data.critique = { ...spec.critique, file: String(spec.notes).replace(/\\/g, '/'), findings: findingsCount(read(spec.notes)) };
  try { record(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data }); }
  catch (e) {   // killed meanwhile: `norn stop` owns the cleanup
    logLine(`end not recorded: ${e.message}`);
    // CIRED-7b3d67d: swept lost meanwhile (a stall, not a death): nobody else frees its locks or fills the queue - this exit does
    if (!killedByMeta()) {
      try { fs.unlinkSync(hbPath(state, run)); } catch { /* gone */ }
      for (const lf of lockFiles) releaseLock(lf, run);
      dropMergeWt(outcome);
      try { for (const f of fillQueue(state)) logLine(`queue: ${f.queued} -> ${f.next}`); } catch (e2) { logLine(`queue fill failed: ${e2.message}`); }
    }
    await holdGone(job); process.exit(0);
  }
  // DELIVERABLES-SPEC 1: a DONE run's branch becomes (or refreshes) its deliverable; never fails the exit
  if (outcome === 'done') { try { const d = onRunDone(state, run); if (d) logLine(`deliverable ${d.id} ${d.ev}`); } catch (e) { logLine(`deliverable not recorded: ${e.message}`); } }
  // lane-outputs items 7, 9, 10a: every ruling the run's notes ask of the owner becomes an Inbox question, whatever the outcome
  if (spec.notes && spec.role !== 'helper' && spec.kind !== 'checkin') { try { for (const q of postRunAsks(state, run)) logLine(q.id ? `asked the owner: ${q.id} ${q.title}` : `ask not posted: ${q.title} (${q.refused})`); } catch (e) { logLine(`owner asks not posted: ${e.message}`); } }
  // META-ADOPT A2: the adopt read's final becomes its proposal's draft (or one retry, or the facts-only draft); a norn stop ingests nothing
  if (spec.adopt && !killedByMeta()) {
    try { const a = ingestRead(state, spec, { capped }); logLine(`adopt ${a.id}: ${a.ev}${a.ev === 'retry' ? ' ' + a.run : ''}${a.why ? ` (${a.why})` : ''}`); }
    catch (e) { logLine(`adopt draft not ingested: ${e.message}`); }
  }
  // GTP-LEDGER: the run end (after its `end` record) is a ledger commit; a failure is logged, never the run's
  if (spec.git_ledger) { try { const n = ledgerStep(spec.git_ledger, `run end ${run} (${outcome})`); if (n) logLine(n); } catch (e) { logLine(`ledger: failed: ${e.message}`); } }
  // RM-46 S1c (SPEC 4.1): the run end publishes home/<id> too (sync off = null; syncStep never throws)
  if (spec.git_ledger) { const n = syncStep(spec.git_ledger, `run end ${run}`); if (n) logLine(n); }
  try { fs.unlinkSync(hbPath(state, run)); } catch { /* gone */ }
  for (const lf of lockFiles) releaseLock(lf, run);
  try { const gone = stopOrphans(state); if (gone.length) logLine(`helpers stopped with the parent: ${gone.join(', ')}`); } catch (e) { logLine(`helper stop failed: ${e.message}`); }

  if (limit && spec.kind !== 'checkin' && spec.role !== 'helper') requeue(limit);
  if (auth) authExit(auth, data);
  if (spec.kind === 'checkin' && spec.fallback && (outcome !== 'done' || !(read(spec.final) || '').trim())) fallback(outcome === 'done' ? 'no final' : outcome);
  let resumed = false;
  if (outcome === 'handoff') resumed = data.paused ? pausedEnd() : autoResume(data.handoff);
  else if (outcome === 'nudged') resumed = nudgeResume();
  else if (outcome === 'done' || data.dod?.ok === false) resumed = fixEnd(slopOpen, data.dod);
  if (outcome === 'done' && !resumed) critiqueEnd();   // a slop resume reviews its own DONE later
  if (!resumed) dropMergeWt(outcome);
  try { for (const f of fillQueue(state)) logLine(`queue: ${f.queued} -> ${f.next}`); } catch (e) { logLine(`queue fill failed: ${e.message}`); }
  if (!resumed && spec.tick && spec.policy?.trigger_on_exit !== false) {
    // CI-RED-319CAF8: born inside this run's job, the tick died with this exit whenever the supervisor had spawned a console child
    // before holdJob (the jobguard compile in a fresh TEMP - every ci-suite file's first run): it breaks away like a queue-filled run
    try {
      const away = job ? spawnOutside(spec.tick[0], spec.tick.slice(1)) : null;
      if (!away) spawn(spec.tick[0], spec.tick.slice(1), { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      logLine(`tick triggered${away ? (away.breakaway ? ' (breakaway)' : ' (inside)') : ''}`);
    }
    catch (e) { logLine(`tick failed: ${e.message}`); }
  }
  await holdGone(job);   // its hold ends before it: a settled run leaves no process (LEAK RED)
  process.exit(0);
}

// GAP-6: a MERGE run's merge worktree goes with the run (DONE, STOPPED, a crash, a limit re-queue: the next start makes a
// fresh one); a HANDOFF keeps it for its resume (the start-time sweep collects it after a day). A norn stop leaves it to that sweep.
function dropMergeWt(outcome) {
  if (!spec.merge_wt || !spec.merge_repo || outcome === 'handoff') return;
  try { logLine(`merge worktree ${spec.merge_wt}: ${removeMergeWorktree({ repo: spec.merge_repo, wt: spec.merge_wt }) ? 'removed' : 'NOT removed (the next merge start sweeps it)'}`); }
  catch (e) { logLine(`merge worktree not removed: ${e.message}`); }
}

function killedByMeta() {
  try { return !!loadState(state).items[run]?.history.some(h => h.ev === 'kill'); } catch { return false; }
}

// one `git status --porcelain=v2 --branch` (5 s): { dirty: {files, untracked}, branch, head }; any failure = no fields
function gitEvidence(wt) {
  try {
    const r = spawnSync(spec.git || 'git', ['status', '--porcelain=v2', '--branch'], { cwd: wt, encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.status !== 0 || r.error) return {};
    const lines = r.stdout.split(/\r?\n/).filter(Boolean), hdr = k => lines.find(l => l.startsWith(`# branch.${k} `))?.slice(`# branch.${k} `.length);
    const out = { dirty: { files: lines.filter(l => /^[12u] /.test(l)).length, untracked: lines.filter(l => l.startsWith('? ')).length } };
    const b = hdr('head'), h = hdr('oid');
    if (b && b !== '(detached)') out.branch = b;
    if (h && /^[0-9a-f]{7,}$/.test(h)) out.head = h;
    return out;
  } catch { return {}; }
}

// a usage-limit exit runs again, same spec: a read reset is held by the limit gate (limitgate.mjs: open at the reset + 2 min, or at
// once on a limit-<family> decision - DEC-337: a not_before clock could not follow the owner's early reset); an unread reset closes
// nothing, so it waits 60 min
function requeue(limit) {
  const notBefore = limit.reset ? undefined : new Date(Date.now() + 3600000).toISOString();
  try {
    const { run: _r, log: _l, final: _f, session_id: _s, lockFile: _k, fromQueue: _q, ...rest } = spec;
    const held = notBefore ? `not before ${notBefore}` : `held by the limit gate until ${limit.reset} (+2 min)`;
    logLine(`usage limit (${limit.line}) -> re-queued ${queueRun({ ...rest, notBefore, requeueOf: run }).run} ${held}`);
  } catch (e) { logLine(`re-queue failed: ${e.message}`); }
}

// META-AUTH: the login is down - mark the harness gate (authguard.mjs: every new launch on it holds until a probe passes) and re-queue
// the work run: its own session resumed when the executor resumes by flag and the session exists (a launch that died at its first
// call has none: the same spec again). The queued run is held by the gate, not by a clock. A check-in / helper is not re-queued (the
// next tick / the parent asks again); at most AUTH_REQUEUE_MAX re-queues in a row.
function authExit(auth, data) {
  try { markAuthDown(state, { harness: executorInfo(spec.executor, spec.provider)?.harness ?? spec.executor, line: auth.line, cls: auth.cls, run }); }
  catch (e) { logLine(`auth gate not marked: ${e.message}`); }
  const n = spec.auth_requeues || 0;
  if (spec.kind === 'checkin' || spec.role === 'helper') { logLine(`auth failure (${auth.line}): not re-queued (${spec.kind === 'checkin' ? 'check-in' : 'helper'})`); return; }
  if (n >= AUTH_REQUEUE_MAX) { logLine(`auth failure (${auth.line}): not re-queued (${n}/${AUTH_REQUEUE_MAX} in a row)`); return; }
  try {
    const { run: _r, log: _l, final: _f, session_id: sid, lockFile: _k, fromQueue: _q, resumeSid: _rs, nudge: _n, ...rest } = spec;
    let c = null;
    try { c = capsOf(spec.executor, spec.provider); } catch { /* none */ }
    const resume = !!sid && !!c?.resume && c.resume_style === 'flag' && (!!data.transcript || !spec.projectsDir);
    const q = queueRun({ ...rest, ...(resume ? { resumeSid: sid, promptText: AUTH_RESUME_PROMPT } : spec.nudge ? { promptText: undefined } : {}), auth_requeues: n + 1, requeueOf: run });
    logLine(`auth failure (${auth.line}) -> re-queued ${q.run} (${resume ? 'session ' + sid + ' resumed' : 'same spec, new session'}), held until the login probe passes`);
  } catch (e) { logLine(`auth re-queue failed: ${e.message}`); }
}

// CHECKIN-V2 piece 4 (H7 trial): a trial check-in that ended non-DONE is re-run at once on its fallback executor (claude); the new
// run records fallback_of and becomes the gate baseline in its place (its own actions are then not news to the next tick)
function fallback(why) {
  const { run: _r, log: _l, final: _f, session_id: _s, lockFile: _k, fromQueue: _q, trial: _t, mcp: _m, writable_roots: _w, fallback: fb, ...rest } = spec;
  let next;
  try { next = startRun({ ...rest, ...fb, fallbackOf: run }).run; }
  catch (e) { logLine(`trial check-in ${spec.trial} ${why}: fallback failed: ${e.message}`); return; }
  logLine(`trial check-in ${spec.trial} ${why} -> fallback ${fb.executor} ${next}`);
  try {
    const g = readGate(state);
    if (g?.run === run) noteCheckin(state, { run: next, start: loadState(state).items[next]?.created, live: g.live, budget: g.caps, forced: g.forced, quiet_n: g.quiet_n });
  } catch (e) { logLine(`gate baseline not moved: ${e.message}`); }
}

// RM-37: the owner paused this run - its hand-off waits for `norn resume RUN-n`: no verdict here (a run takes ONE resume verdict, and the
// owner's resume records it: pause.mjs resumeRun); the end record's `paused` says why it waits
function pausedEnd() {
  logLine(`paused hand-off: not auto-resumed (norn resume ${run})`);
  return false;
}

function autoResume(handoff) {
  let { refused, count, max } = autoResumeRefusal(spec, state);   // one home with the lost relaunch (runs.mjs)
  let next = null, spawned = null, held = null;
  if (!refused) {
    try {
      // a HANDOFF is a fresh agent on the same brief: never the nudged session or its mail prompt (META-GTP-MAIL)
      const { run: _r, log: _l, final: _f, session_id: _s, lockFile: _k, resumeSid: _rs, nudge: _n, ...rest } = spec;
      if (spec.nudge) delete rest.promptText;
      ({ run: next, spawned, why: held } = startRun({ ...rest, resumes: count + 1, resumeOf: run, handoffFile: handoff }));   // a pause holds it queued (held = why)
    } catch (e) { refused = e instanceof RunRefused ? `${e.code === 3 ? 'writer' : 'worker cap'}: ${e.message}` : `error: ${e.message}`; }
  }
  try { record(state, { kind: 'run', ev: 'resume', id: run, by: 'launcher', data: next ? { next, count: count + 1, max, ...(held ? { held } : {}) } : { refused, count, max } }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; logLine(`resume not recorded: ${e.message}`); }
  logLine(next ? `auto-resume -> ${next} (${count + 1}/${max}) ${held ? `queued, ${held}` : spawned}` : `auto-resume refused: ${refused}`);
  if (next && spec.ledger) {
    const utc = new Date().toISOString().replace(/:\d\d\.\d+Z$/, 'Z');
    try { fs.appendFileSync(spec.ledger, `- auto ${utc}: lane ${spec.lane} HANDOFF -> auto-resumed (${count + 1}/${max}, same brief, ${spec.executor} ${spec.model ?? '-'} ${spec.effort ?? '-'}) ${next}${held ? ` (queued, ${held})` : ''}\n`); }
    catch (e) { logLine(`ledger append failed: ${e.message}`); }
  }
  return !!next;
}

// META-SLOP-A (REVIEW-FABLE 3) + RM-44 D1: the run-end check. Every lane run end whose branch has commits past main is checked on its
// diff, whatever the outcome (an unchecked end read as clean and let PR #11's cycle through); the check is stored (checks.jsonl) and
// its open BLOCK findings (no waiver) hold the branch's merge. -> the open findings ([] = none, or not checked)
function slopEnd() {
  if (spec.kind === 'checkin' || spec.role === 'helper' || spec.readonly || !spec.worktree || !slopOn(spec.policy) || killedByMeta()) return [];
  let c;
  try { c = checkBranch({ repo: spec.worktree, state, projectDir: spec.policy?.slop?.project_dir }); } catch (e) { logLine(`slop: check failed: ${e.message.split('\n')[0]}`); return []; }
  if (!c || c.base === c.result.head) return [];   // no lane branch (on main, detached, no main to diff against), or no commits past main
  const open = hostWrite(state, { type: 'check', branch: c.branch, lane: spec.lane, run, base: c.base, head: c.result.head, hash: c.result.hash, blocks: c.result.blocks, findings: c.result.findings, skipped: c.result.skipped }).open;
  logLine(`slop: ${open.length} open BLOCK finding(s) on ${c.branch} (${c.result.ran.join(' ')}${c.result.skipped.length ? '; skipped ' + c.result.skipped.map(s => s.rule).join(' ') : ''})`);
  return open;
}

// a DONE with open slop findings and / or a red Done check goes back to the SAME lane ONCE, as one resume carrying both lists (slop
// first, the order they ran; the same session where the executor resumes by flag). A list its own resume already carried is not
// sent again: a second BLOCK / a second red is the check-in's to decide.
function fixEnd(open, d) {
  const slop = open.length && !spec.slopOf ? open : [], dod = d?.ok === false && !spec.dodOf ? d : null;
  if (open.length && spec.slopOf) logLine(`slop: BLOCK again after the slop resume of ${spec.slopOf}: no second resume, the check-in decides`);
  if (d?.ok === false && spec.dodOf) logLine(`dod: red again after the Done resume of ${spec.dodOf}: no second resume, the check-in decides`);
  if (!slop.length && !dod) return false;
  let next = null, refused = null;
  try {
    const { run: _r, log: _l, final: _f, session_id: sid, lockFile: _k, nudge: _n, resumeSid: _rs, ...rest } = spec;
    const promptText = [...(slop.length ? [slopPrompt(slop, null)] : []), ...(dod ? [dodPrompt(dod, null)] : []), ...(spec.brief ? [`Your brief: ${spec.brief}`] : [])].join('\n');
    next = startRun({ ...rest, resumeOf: run, ...(slop.length ? { slopOf: run } : {}), ...(dod ? { dodOf: run } : {}), ...(nudgeable() ? { resumeSid: sid } : {}), promptText }).run;
  } catch (e) { refused = e instanceof RunRefused ? `${e.code === 3 ? 'writer' : 'worker cap'}: ${e.message}` : `error: ${e.message}`; }
  const what = { ...(slop.length ? { slop: slop.length } : {}), ...(dod ? { dod: dod.why } : {}) };
  try { record(state, { kind: 'run', ev: 'resume', id: run, by: 'launcher', data: next ? { next, ...what } : { refused, ...what } }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; logLine(`resume not recorded: ${e.message}`); }
  logLine(next ? `resumed ${next} with ${slop.length ? `${slop.length} slop BLOCK finding(s)` : ''}${slop.length && dod ? ' and ' : ''}${dod ? "the Done check's evidence" : ''}` : `resume refused: ${refused}`);
  return !!next;
}

// META-DOD 3: a planning run ended DONE -> `norn critique` queues its ONE review (the CLI resolves the review executor as norn run does;
// it says SKIPPED when policy.dod.critique is off or the run is no plan run). Before the queue fill below, so the review starts at once.
function critiqueEnd() {
  if (spec.kind === 'checkin' || spec.role === 'helper' || spec.critique || !spec.notes || !spec.ctx_from || killedByMeta()) return;
  try { if (loadState(state).items[run]?.data.class !== 'planning' || !critiqueOn(specPolicy(spec))) return; } catch (e) { logLine(`critique: policy not read: ${e.message}`); return; }
  const r = spawnSync(process.execPath, [NORN_BIN, 'critique', '--run', run, '--project', spec.ctx_from, '--state', state, ...(spec.locksDir ? ['--locks', spec.locksDir] : []),
    ...(spec.tick ? [] : ['--no-tick'])], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  logLine(`critique: ${`${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/)[0] || `exit ${r.status ?? r.error?.message}`}`);
}

// META-DOD 1: the Done check applies to a lane work run whose brief passed the Ready gate (spec.dod.ready, norn run)
function dodOn() {
  return !!spec.dod?.ready && !!spec.worktree && spec.kind !== 'checkin' && spec.role !== 'helper' && !spec.readonly && !killedByMeta();
}

// ---------- META-GTP-MAIL piece 3: NUDGE (GT-PARITY-PLAN 2.7; Gas Town internal/cmd/nudge.go:49-68,267-291, internal/nudge/queue.go:68-92
// cited: they type into an idle tmux pane or queue with DeliverAfter - a headless run has no pane). An urgent mail not acked within
// policy mail.nudge_after_min on THIS running run: claim it (mail nudge, once), stop the executor's tree, end as outcome nudged and
// resume the SAME session (--resume <sid>) with the mail as the prompt - the HANDOFF auto-resume path. Never during QUIET or while
// the GPU lock is held, never when the resume would be refused (paused, the weekly guard): then it waits and checks again.
// Only a work run whose executor resumes a session by flag (caps.resume + resume_style, a session id: claude, the fake).
function nudgeable() {
  if (spec.kind === 'checkin' || spec.role === 'helper' || !spec.session_id) return false;
  try { const c = capsOf(spec.executor, spec.provider); return !!c?.resume && c.resume_style === 'flag'; } catch { return false; }
}
const afterMin = () => spec.policy?.mail?.nudge_after_min ?? NUDGE_AFTER_MIN;
function nudgeWait(why) { if (why !== nudgeWaitLast) logLine(`nudge waits: ${why}`); nudgeWaitLast = why; }
function nudgeCheck() {
  if (finished || nudging || !childPid) return;
  let due;
  try { due = nudgeDue(state, { run, afterMin: afterMin(), quiet: spec.quiet, gpuLock: spec.gpu_lock }); }
  catch (e) { nudgeWait(`mail not readable: ${e.message}`); return; }
  if (!due) return;
  const why = due.wait || (holdsStarts(readPause(spec.paused)) ? 'paused' : null) || usageRefusal(spec, state, { rate: false });
  if (why) { nudgeWait(`${why} (${due.mail.id})`); return; }
  try { record(state, { kind: 'mail', ev: 'nudge', id: due.mail.id, by: 'launcher', data: { run } }, { run }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; logLine(`nudge ${due.mail.id} not claimed: ${e.message}`); return; }   // acked meanwhile
  nudging = { mail: due.mail, afterMin: afterMin() };
  logLine(`nudge: ${due.mail.id} (urgent, not acked in ${afterMin()} min) -> stopping the run's tree, resuming session ${spec.session_id}`);
  killTree(childPid, { state, killer: `${run} supervisor ${process.pid}`, reason: `nudge ${due.mail.id}: resume session ${spec.session_id}` });
}
function nudgeResume() {
  const id = nudging.mail.id;
  let next = null, refused = null;
  try {
    const { run: _r, log: _l, final: _f, session_id: sid, lockFile: _k, ...rest } = spec;
    next = startRun({ ...rest, resumeOf: run, resumeSid: sid, nudge: id, promptText: nudgePrompt(nudging.mail, nudging.afterMin) }).run;
  } catch (e) { refused = e instanceof RunRefused ? `${e.code === 3 ? 'writer' : 'worker cap'}: ${e.message}` : `error: ${e.message}`; }
  try { record(state, { kind: 'run', ev: 'resume', id: run, by: 'launcher', data: next ? { next, nudge: id } : { refused, nudge: id } }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; logLine(`resume not recorded: ${e.message}`); }
  logLine(next ? `nudge ${id} -> resumed ${next} (session ${spec.session_id})` : `nudge ${id}: resume refused: ${refused}`);
  return !!next;
}

// ---------- META-CTX-ENFORCE R1 (owner DIR-56): the hard max in code. Every hbMs the run's CURRENT context (its transcript's last
// request) is held against its role's hard_max_k from the CURRENT project policy (ctxlimit.mjs); past it the tree is stopped and
// the run ends as HANDOFF (Norn writes its result + HANDOFF.md; committed work is kept; auto-resume as for any HANDOFF). The no-new-step
// and hand-off orders before it are the PostToolUse hook's (norn mail check --inject). A claude-shaped run with a transcript only.
function ctxWatched() { return cmd?.parse === 'claude' && !!spec.session_id && !!spec.projectsDir; }
function ctxWait(why) { if (why !== ctxWaitLast) logLine(`context check waits: ${why}`); ctxWaitLast = why; }
function ctxCheck() {
  if (finished || ctxForced || nudging || !childPid) return;
  ctxFile ??= findTranscript(spec.projectsDir, spec.session_id);
  if (!ctxFile) return;
  let c;
  try { c = ctxLimits(specPolicy(spec), ctxRole(spec)); } catch (e) { ctxWait(`policy not readable: ${e.message}`); return; }
  const ctx = transcriptCtx(ctxFile);
  if (ctxLevel(ctx, c) !== 'hard_max') return;
  ctxForced = { ctx, hard_max_k: c.hard_max_k, role: c.role };
  logLine(`context ${Math.round(ctx / 1000)}k past the hard max (${c.hard_max_k}k, role ${c.role}): stopping the executor, the run ends as HANDOFF`);
  // the run's result is the hand-off Norn writes for it - unless the worker handed off itself first (its own HANDOFF.md is better)
  if (spec.role !== 'helper' && spec.kind !== 'checkin' && spec.kind !== 'audit' && readResult(RESULT_DIR, { run, since: supStarted })?.outcome !== 'handoff') {
    try {
      writeResult(RESULT_DIR, { run, outcome: 'handoff', summary: `forced at ${Math.round(ctx / 1000)}k context (hard max ${c.hard_max_k}k, role ${c.role})`,
        handoff: `# Forced hand-off (Norn, ${iso()})\n\nThe context reached ${Math.round(ctx / 1000)}k, past the hard max (${c.hard_max_k}k) of role ${c.role}: Norn ended this run. `
          + 'Committed work is kept; anything uncommitted is still in the worktree. Re-check the worktree HEAD + git status and the brief, then continue'
          + `${spec.notes ? ` (this run's own log: ${fwdPath(spec.notes)})` : ''}.` });
    } catch (e) { logLine(`forced hand-off not written: ${e.message}`); }
  }
  killTree(childPid, { state, killer: `${run} supervisor ${process.pid}`, reason: `context ${Math.round(ctx / 1000)}k past the hard max ${c.hard_max_k}k` });
}
