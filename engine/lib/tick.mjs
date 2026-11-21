// `norn tick` (META-GENERAL-DESIGN 9 checkin.ps1 row, 10.2, 12-S5): the pause (RM-37 pausemode.mjs: Pause everything exits here) -> tick lock -> one check-in at a time ->
// norn status -> CHECKIN rendering -> the check-in launched as RUN kind checkin through the S4 supervisor (`norn run` path).
// Port of meta/checkin.ps1; the old synchronous claude -p becomes a supervised detached run (heartbeat, usage, transcript).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startRun, liveRuns, stopOrphans, fillAll, fillWords, readiness, sweepLost, relaunchLost, endLost, lostNotice, STALE_MS, killTree, hbPath, touchedOf, readCollideHolds } from './runs.mjs';
import { trackHold, holdNoticeDue, noticeMin } from './holds.mjs';
import { writeStatus } from './status.mjs';
import { tryDigest } from './digest.mjs';
import { providersOf, executorInfo } from './executors.mjs';
import { authRefusal, authNoticeDue, loginHolds } from './authguard.mjs';
import { limitRefusal } from './limitgate.mjs';
import { readEvents, recordsFile, fold, loadState, record, RecordError, homeOf, laneId } from './records.mjs';
import { checkinGate, noteCheckin, noteSkip, notePaused, noteDebounce, readGate, rateBand, idleProbe, STALL_IDLE_MIN } from './gate.mjs';
import { handleRoutineEnds, checkinPolicy, laneLevel, debounceOf, metaCli, isMergeRun } from './checkins.mjs';
import { watchProbe } from './watch.mjs';
import { MACHINE_DEFAULTS, HARNESS_EXECUTORS, capText, syncPolicy } from './policy.mjs';
import { profileOf, memoryOf, memoryEnv, knownAgents } from './launchpolicy.mjs';
import { knownExecutors, knownModels, knownEfforts } from './launchargs.mjs';
import { BUILTIN } from './executors.mjs';
import { ledgerStep } from './ledger.mjs';
import { syncStep } from './sync.mjs';
import { tickMergeq, mqProbe, spawnDetached, mergeqOn } from './mergeq.mjs';
import { followerPrs, makeGh } from './mergeland.mjs';
import { tickFix } from './fixer.mjs';
import { closeLandedQuestions, latchMerged } from './deliverables.mjs';
import { sweepAsks, applyRulings } from './runasks.mjs';
import { tickSlop } from './slop/daily.mjs';
import { tickTests } from './testscli.mjs';
import { tickBranches } from './branches.mjs';
import { checkinCv } from './cv.mjs';
import { ciProbe } from './ciwatch.mjs';
import { projectOverlap } from './overlap.mjs';
import { guardWatch, guardProbe, guardPolicy } from './guard.mjs';
import { floorOf, floorText } from './floor.mjs';
import { isApi, usdCap } from './billing.mjs';
import { loadRoadmap, buildTree, itemsOf } from './roadmap.mjs';
import { stuckSweep, stuckProbe, stuckWake } from './stuck.mjs';
import { tickDerelicts } from './derelict.mjs';
import { tickLanes, lanesProbe } from './lifecycle.mjs';
import { tickPaths } from './lanepaths.mjs';
import { tickProposals } from './proposals.mjs';
import { lateNotice, cleanMin } from './pause.mjs';
import { pauseFiles, readPause, stopsTick, stopsCheckins } from './pausemode.mjs';
import { fedOf } from './fed.mjs';
import { listClaims, localClaims, renewWork, releaseWork, observeClaims, isStale, readSync, writeSync, updateSync, claimLeader, leaderKey } from './claims.mjs';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHECKIN_PROMPT = path.join(ENGINE, 'prompts', 'CHECKIN.md');
export const CHECKIN_MINOR_PROMPT = path.join(ENGINE, 'prompts', 'CHECKIN-MINOR.md');   // CHECKIN-V2 piece 2: the reduced tick
// the project's QUIET flag file (common-rules.txt line 1): held only for timed runs; the dash stream shows it too
export const quietFlag = p => p.quiet_file || path.join(p.root || '', '.superpowers', 'QUIET');
export const LOCK_STALE_MIN = 50;   // checkin.ps1: a lock older than 50 min is taken over
const META_CMD = path.join(ENGINE, 'bin', 'norn.mjs');
const fwd = p => String(p).replace(/\\/g, '/');
const tickLog = (state, msg) => { try { fs.appendFileSync(path.join(state, 'tick.log'), `${new Date().toISOString()} ${msg}\n`); } catch { /* log only */ } };

export function policyLine(B = {}) {
  const astra = B.max_astra ?? B.max_codex, sol = B.max_sol ?? B.max_codex;
  return `POLICY (from the machine budget): caps ${capText(B.max_claude_workers)} Claude / ${capText(B.max_codex)} Codex (${capText(astra)} codex-astra, ${capText(sol)} codex-sol), `
    + `1 writer per worktree; usage rate cap ${capText(B.usage_rate_cap_pct_per_h)} %/h${isApi(B) ? `; API billing: no weekly limit${usdCap(B) === null ? '' : `, daily cap $${usdCap(B)}`}` : B.weekly_stop_pct !== undefined ? `; weekly guard ${B.weekly_stop_pct} %` : ''}.`
    + (floorOf(B) ? ` WORKER MINIMUM: every worker run (merges and helpers too) uses ${floorText(floorOf(B))}; never pass a lower --model / --effort (the launcher raises it anyway).` : '');
}

// GAP-4: the launch line's valid values -> { executors, models, efforts } (the words CHECKIN.md shows; the test executor fake left out)
export function launchValues(p, budget = {}) {
  const exs = knownExecutors(p, { fake: false });
  const models = exs.map(x => { const m = knownModels(x, { project: p, budget }); return `${x}: ${m ? m.join(', ') : 'the model of its entry (leave --model out)'}`; }).join('; ');
  const efforts = [...new Set(exs.flatMap(x => knownEfforts(x) || []))];
  return { executors: exs.join(' | '), models, efforts: efforts.join(' | ') || 'none' };
}

/** Fill engine/prompts/CHECKIN.md (or o.template: CHECKIN-MINOR.md) + the project's checkin_extra -> state/<NAME>.rendered.md; returns that path. */
export function renderCheckin(p, { budgetFile, budget = {}, statusFile = path.join(p.state, 'STATUS.md'), metaRoot = path.join(ENGINE, '..'), template = CHECKIN_PROMPT, wake = '(not given)', cv = '' } = {}) {
  const v = {
    project: p.name, norn: `node "${fwd(META_CMD)}"`,
    meta_root: fwd(metaRoot), status: fwd(statusFile), budget: fwd(budgetFile || '(none)'),
    ledger: fwd(p.ledger || '(none)'), briefs_dir: fwd(p.briefs_dir || p.root), policy: policyLine(budget),
    agents: knownAgents({ claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), project: p }).join(', ') || 'none: leave --agent out',
    ...launchValues(p, budget),   // GAP-4: the values `norn run` takes, on the launch line (launchargs.mjs refuses any other)
    rules: (p.rules_read_whole || []).map(fwd).join(', ') || '(none)', wake,
    paths: [['ROOT', p.root], ['STATE', p.state], ['BRIEFS', p.briefs_dir], ['LEDGER', p.ledger]].filter(([, x]) => x).map(([k, x]) => `${k}=${fwd(x)}`).join('  '),
  };
  const fill = (txt, src) => txt.replace(/\{\{(\w+)\}\}/g, (_, k) => { if (!(k in v)) throw new Error(`${src}: unknown placeholder {{${k}}}`); return v[k]; });
  const name = path.basename(template, '.md');
  let txt = fill(fs.readFileSync(template, 'utf8'), path.basename(template));
  if (p.checkin_extra) txt += '\n' + fill(fs.readFileSync(p.checkin_extra, 'utf8'), p.checkin_extra);
  if (cv) txt += '\n' + cv;   // META-GTP-CV piece 3: the 5-line CV table (cv.mjs checkinCv) so routing cites evidence
  const out = path.join(p.state, `${name}.rendered.md`);
  fs.mkdirSync(p.state, { recursive: true });
  fs.writeFileSync(out, txt);
  return out;
}

// CHECKIN-V2 piece 4 (H7 trial): the executor of one check-in. claude (today) unless checkin_executor names another MCP-capable
// built-in AND checkin_executor_trial is on: then that executor runs it with the meta MCP server (checkin profile) attached and
// write access to the state root / ledger / briefs, and `fallback` = the claude check-in the supervisor re-runs on a non-DONE tick.
// minor = the reduced tick (piece 2). Returns { error } | { executor, exe, model, effort[, trial, mcp, writable_roots, fallback] }.
const TRIAL_MODELS = { 'codex-astra': 'gpt-6-astra', 'codex-sol': 'gpt-6.1-sol' };
export function checkinExecutor({ B = {}, machine = {}, p = {}, minor = false, dry = false } = {}) {
  const want = B.checkin_executor || 'claude';
  const claude = { executor: dry ? 'fake' : 'claude', exe: machine.claude?.exe,
    model: minor ? B.checkin_minor_model ?? MACHINE_DEFAULTS.checkin_minor_model : B.checkin_model || 'claude-opus-5-5',
    effort: minor ? B.checkin_minor_effort || MACHINE_DEFAULTS.checkin_minor_effort : B.checkin_effort || 'medium' };
  if (!dry && !claude.exe) return { error: 'no claude executable (machine.json; run norn setup)' };
  if (want === 'claude') return claude;
  if (!HARNESS_EXECUTORS.includes(want)) return { error: `checkin_executor ${want} is not a check-in executor (${HARNESS_EXECUTORS.join(' | ')})` };
  if (!B.checkin_executor_trial) return dry ? claude : { error: `checkin_executor ${want} runs only under the trial (turn checkin_executor_trial on: auto-fallback to claude) - or set it back to claude` };
  const family = BUILTIN[want].harness, exe = machine[family]?.exe;
  if (!dry && !exe) return { error: `no ${family} executable for checkin_executor ${want} (machine.json)` };
  const roots = [path.dirname(path.resolve(p.state || '.')), p.ledger && path.dirname(p.ledger), p.briefs_dir].filter(Boolean).map(fwd);
  return { executor: dry ? 'fake' : want, trial: want, exe: dry ? undefined : exe, model: TRIAL_MODELS[want] || claude.model, effort: claude.effort,
    ...(dry || !p.file ? {} : { mcp: { name: 'norn', command: process.execPath, args: [fwd(META_CMD), 'mcp', '--project', fwd(p.file), '--profile', 'checkin'] } }),
    writable_roots: roots, fallback: claude };
}

// the gate's probes: NORN-WATCH watched lanes in other states + CHECKIN-V2 piece 1 progress stall (project checkin.stall_idle_min)
// + META-CIWATCH: a red CI run on the project's main (project.json `ci`; ci:red:<run>, a MAJOR wake once per red run)
export function gateProbes(p, machine = {}) {
  const m = p?.checkin?.stall_idle_min;
  return [watchProbe(p, machine), idleProbe({ minutes: Number.isInteger(m) ? m : STALL_IDLE_MIN, projectsDir: machine?.claude?.projects_dir }),
    p?.merge?.gate?.fast && p.state ? mqProbe(p.state) : null, p?.ci?.repo && p.state ? ciProbe(p) : null,
    p?.state ? guardProbe(p.state) : null, p?.state ? stuckProbe(p.state) : null, lanesProbe(p?.policy, p?.state ? homeOf(p.state)?.id ?? null : null)].filter(Boolean);   // lifecycle.mjs: an idle / stopped lane = lanes:<rule>:L:x, MAJOR   // META-CATCH S1: an open stuck flag = stuck:RM-n, MAJOR   // META-GUARD R1: an open usage alarm wakes the check-in   // META-GTP-MERGEQ: a green batch / fix ask wakes the check-in
}

// NORN-WATCH S2: a project's checkin.max_quiet_min overrides the machine's checkin_max_quiet_min for that project (additive)
export function projectBudget(p, B = {}) {
  const q = p?.checkin?.max_quiet_min;
  return Number.isInteger(q) ? { ...B, checkin_max_quiet_min: q } : B;
}

function takeLock(file, note) {
  try { fs.writeFileSync(file, note, { flag: 'wx' }); return null; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const age = (Date.now() - fs.statSync(file).mtimeMs) / 60000;
  if (age < LOCK_STALE_MIN) return `lock held (${Math.floor(age)} min) - exit`;
  fs.writeFileSync(file, note);   // stale: take it (checkin.ps1)
  return null;
}

// lane-collide S1b (SPEC 4A.1, landing the holder early): the MERGE stage tickPaths queues at P1 goes at P0 while a collision holds a
// queued run on that lane (<state>/collide-holds.json, derived each tick, so it ends with the wait). lanepaths.mjs names the priority
// itself; this wraps the cli it calls (follow-up: a priority input to tickPaths).
export function waitedMergeCli(state, cli) {
  if (!cli) return cli;
  return args => {
    const i = args.indexOf('--priority'), lane = args[args.indexOf('--lane') + 1];
    if (i < 0 || args[i + 1] !== 'P1' || !args.includes('--lane')) return cli(args);
    const runs = fold(readEvents(recordsFile(state, 'run'))).items, waits = Object.entries(readCollideHolds(state)).some(([id, h]) => runs[id]?.state === 'queued' &&(h.holders || []).includes(lane));
    return cli(waits ? [...args.slice(0, i + 1), 'P0', ...args.slice(i + 2)] : args);
  };
}
/**
 * One tick for one project. o: { project (loaded project.json), machine, budget, budgetFile, reason, dry (FAKE claude),
 * hbMs?, staleMs?, fakeMs?, derelicts (false = no derelict sweep), listProcs / killProc (the sweep's listing + kill, for tests) }. Returns { code, msg }; every "nothing to do" path is code 0 (scheduler IgnoreNew semantics).
 */
export function tick(o) {
  let r;
  try {
    const g = {};
    r = tickPass(o, g);
    if (g.raised?.length) r = { ...r, guard: g.raised, guard_push: g.push };
    if (g.lost) r = { ...r, lost_notice: g.lost };
    if (g.stuck) r = { ...r, stuck_notices: g.stuck };   // META-CATCH S1: one notice per new stuck flag (the caller sends them, class alert)   // META-CATCH S1: one notice per sweep that handled dead runs (the caller sends it, class alert)   // META-GUARD R1: the caller sends them (class usage)
    // META-AUTH: the one owner notice of a login outage (authguard.mjs; the caller sends it: meta tick -> meta notify, class alert)
    try {   // META-AUTH-VENDOR: a vendor-class notice counts the runs it holds
      const held = h => loginHolds(o.project.state, Object.values(fold(readEvents(recordsFile(o.project.state, 'run'))).items),
        { entryOf: x => o.project.executors?.[x], incident: () => null }).find(x => x.harness === h)?.runs.length ?? 0;
      const n = authNoticeDue(o.project.state, { held });
      if (n) r = { ...r, notice: n };
    } catch { /* a notice never fails the tick */ }
    // GAP-1 (holds.mjs): the one owner notice of a hold of ALL queued work past policy.holds.notice_min (the caller sends it, class alert)
    try {
      let status = ''; try { status = fs.readFileSync(path.join(o.project.state, 'STATUS.md'), 'utf8'); } catch { /* no words for the reset */ }
      const h = holdNoticeDue(o.project.state, { min: noticeMin(o.project.policy), status, project: o.project.name });
      if (h) r = { ...r, hold_notice: h };
    } catch { /* a notice never fails the tick */ }
    // RM-37: the one owner notice of a run asked to pause that has not reached a clean point within policy.pause.clean_min (never killed)
    try { const n = lateNotice(o.project.state, { min: cleanMin(o.project.policy), project: o.project.name, ...(o.now ? { now: o.now().getTime() } : {}) }); if (n) r = { ...r, pause_notice: n }; }
    catch { /* a notice never fails the tick */ }
    return r;
  }
  finally {
    // GTP-LEDGER: every pass ends with a ledger commit (o.ledger = ledgerConfig(machine); none = off); its failure is logged, never the tick's
    if (o.ledger) {
      let note;
      try { note = ledgerStep(o.ledger, `tick ${o.project.name}${o.reason ? ' (' + o.reason + ')' : ''}`); } catch (e) { note = `ledger: failed: ${e.message}`; }
      if (note && /failed|refused/.test(note)) tickLog(o.project.state, note);
      // RM-46 S1c (SPEC 4.1): then this home's shared logs onto home/<id> (sync off = null); only a trouble note reaches the tick log
      const sn = syncStep(o.ledger, `tick ${o.project.name}`);
      if (sn && /failed|refused|stopped|offline/.test(sn)) tickLog(o.project.state, sn);
    }
  }
}
// ---------- RM-46 S2b (multi-home SPEC 4.5): the tick's claims step, before the fill ----------
// Only a synced project (home.json) with a ledger remote. One fetch (offline = the last fetched claims), then: release the own claims
// of lanes done / archived; renew once the oldest confirmation is past renew_s; fence SECOND (a machine waking with network renews and
// is not fenced): a live run whose claim is unconfirmed past fence_s is stopped and recorded lost. A renew that finds an own claim gone
// or under another nonce = taken over: its run stops, the claim leaves the own list. Last the observer's clock (stale foreign claims).
// Rows for the digest go to <state>/sync/claims-digest.json: events (drift, fenced, taken) for 72 h, stale claims as they are now.
// S6a (SPEC 4.8): the merge leader rides the same pass - renewed in the same commit, fenced the same way (its live MERGE runs stop),
// lost when the renew finds it taken over; a home whose project runs the merge queue claims it when free or stale (taken over at once).
const EVENT_MS = 72 * 3600e3;
function stopForClaim(state, run, why, kill) {
  const hb = (() => { try { return JSON.parse(fs.readFileSync(hbPath(state, run.id), 'utf8')); } catch { return {}; } })();
  try { record(state, { kind: 'run', ev: 'lost', id: run.id, by: 'launcher', data: { why } }); } catch (e) { if (!(e instanceof RecordError)) throw e; return false; }
  const rc = { state, killer: `tick pid ${process.pid}`, reason: `claim: ${run.id} ${why}` };   // DEC-1088: receipted (killTree)
  kill(hb.supervisor_pid, rc); kill(hb.pid, rc);
  try { fs.unlinkSync(hbPath(state, run.id)); } catch { /* gone */ }
  return true;
}
/** claimsPass(state, { ledger, policy, now, kill, mergeq }) -> null (not synced) | { renewed, fenced, taken, released, stale, offline?,
 *  leader: { leader, holder, why, took?, fenced } } (mergeq: the project runs the merge queue, so it may claim the leader) */
export function claimsPass(state, { ledger, policy, now = Date.now(), kill = killTree, mergeq = false } = {}) {
  const home = homeOf(state)?.id, f = home ? fedOf(ledger) : null;
  if (!f) return null;
  const pol = syncPolicy(policy), items = loadState(state).items, out = { renewed: 0, fenced: [], taken: [], released: [], stale: [] };
  const own = readSync(state, 'own'), events = (readSync(state, 'rows').events || []).filter(r => now - r.ms < EVENT_MS);
  const event = (kind, id, why) => events.push({ kind, id, why, ms: now, at: new Date(now).toISOString() });
  const runOf = lane => Object.values(items).find(i => i.kind === 'run' && i.state === 'running' && i.data.lane === lane && i.data.kind !== 'checkin' && i.data.role !== 'helper');
  const project = path.basename(path.resolve(state)), lk = leaderKey(project), lead = { leader: false, holder: null, why: '', fenced: [] };
  let led = readSync(state, 'leader').key === lk ? readSync(state, 'leader') : null;
  const stopMerges = why => { for (const r of Object.values(items)) if (r.kind === 'run' && r.state === 'running' && isMergeRun(r.data) && stopForClaim(state, r, why, kill)) lead.fenced.push(r.id); };
  let claims;
  try { claims = listClaims(f); } catch { claims = localClaims(f); out.offline = true; }
  for (const [k, c] of Object.entries(own)) {
    if (!['done', 'archived'].includes(items[laneId(c.lane, state)]?.state) || runOf(c.lane)) continue;
    let r = null;
    try { r = releaseWork(f, c); } catch { /* offline: the next pass */ }
    if (r?.ok || r?.gone) { delete own[k]; out.released.push(k); }
  }
  if ([...Object.values(own), ...(led ? [led] : [])].some(c => !(now - c.confirmed_ms < pol.renew_s * 1000))) {
    const rn = renewWork(f, { ...Object.fromEntries(Object.entries(own).map(([k, c]) => { const r = runOf(c.lane); return [k, { nonce: c.nonce, run: r?.id, touched: r ? touchedOf(r.data.worktree) : undefined }]; })), ...(led ? { [lk]: { nonce: led.nonce } } : {}) }, { now });
    if (rn.ok) {
      if (led && rn.renewed[lk]) led = { ...led, n: rn.renewed[lk], confirmed_ms: now };
      if (led && rn.gone.includes(lk)) {   // an old leader that comes back: its claim is gone, so its MERGE runs stop
        const why = `merge leader taken over on ${new Date(now).toISOString()}`;
        stopMerges(why);
        event('taken', lk, `${led.home}/merge leader: ${why}${lead.fenced.length ? ` - ${lead.fenced.join(' ')} stopped` : ''}`);
        led = null;
      }
      for (const [k, n] of Object.entries(rn.renewed)) if (k !== lk) { own[k] = { ...own[k], n, confirmed_ms: now }; out.renewed++; }
      for (const d of rn.drift) event('drift', d.key, d.why);
      for (const k of rn.gone.filter(x => x !== lk)) {
        const c = own[k], r = runOf(c.lane), why = `claim taken over on ${new Date(now).toISOString()}`;
        if (r) stopForClaim(state, r, why, kill);
        event('taken', k, `${c.home}/${c.lane}: ${why}${r ? ` - ${r.id} stopped` : ''}; it claims again only through a normal dispatch`);
        delete own[k]; out.taken.push(k);
      }
      try { claims = localClaims(f); } catch { /* keep the fetched */ }
    }
  }
  for (const [k, c] of Object.entries(own)) {
    const forS = Math.floor((now - c.confirmed_ms) / 1000), r = runOf(c.lane);
    if (forS <= pol.fence_s || !r) continue;
    const why = `fenced: claim not confirmed for ${forS} s`;
    if (stopForClaim(state, r, why, kill)) { event('fenced', k, `${c.home}/${c.lane}: ${r.id} ${why}`); out.fenced.push(r.id); }
  }
  if (led && now - led.confirmed_ms > pol.fence_s * 1000) {
    const forS = Math.floor((now - led.confirmed_ms) / 1000);
    stopMerges(`fenced: merge leader claim not confirmed for ${forS} s`);
    if (lead.fenced.length) event('fenced', lk, `${led.home}/merge leader: ${lead.fenced.join(' ')} fenced: claim not confirmed for ${forS} s`);
    lead.why = `merge leader claim not confirmed for ${forS} s (fenced)`;
  }
  const seen = observeClaims(claims, readSync(state, 'seen'), { home, now });
  if (!led && mergeq && !out.offline) {
    const c = claimLeader(f, { project, home, seen, now, pol });
    if (c.won) {
      led = { key: lk, project, home, nonce: c.claim.nonce, n: c.n, confirmed_ms: now };
      if (c.took) { lead.took = c.took; event('taken', lk, `${c.took}/merge leader was stale: taken over by ${home}`); }
    } else lead.why = c.why;
  }
  if (led) writeSync(state, 'leader', led); else writeSync(state, 'leader', {});
  if (led && !lead.why) Object.assign(lead, { leader: true, holder: home });
  else if (!led) { const c = (() => { try { return localClaims(f)[lk]; } catch { return null; } })(); lead.holder = c?.home ?? null; lead.why ||= c ? `merge leader is ${c.home}` : 'no merge leader'; }
  out.leader = lead;
  const stale = Object.entries(seen).filter(([k]) => claims[k]?.kind === 'work' && isStale(seen[k], claims[k], now, pol)).map(([k]) => {
    const c = claims[k];
    return { kind: 'stale', id: k, why: `${c.home}/${c.lane} stale: n=${c.n} unchanged ${Math.floor((now - seen[k].first_seen_ms) / 60000)} min on this home's clock - the owner may take it over: norn claim take ${c.home}/${c.lane} --project ${c.project}` };
  });
  out.stale = stale.map(s => s.id);
  // merged into the file as it is now: a dispatch may have claimed meanwhile (its entry stays; a later confirmation wins)
  const left = [...out.released, ...out.taken];
  updateSync(state, 'own', cur => Object.fromEntries(Object.entries({ ...cur, ...own }).filter(([k]) => !left.includes(k))
    .map(([k]) => [k, cur[k] && own[k] && cur[k].nonce === own[k].nonce && cur[k].confirmed_ms > own[k].confirmed_ms ? cur[k] : (own[k] ?? cur[k])])));
  writeSync(state, 'seen', seen); writeSync(state, 'rows', { events, stale });
  return out;
}

// GAP-1 (holds.mjs): the hold episode of ALL queued work, from the dry fill walk after the fill (the PAUSED exit too); never fails the tick
function holdStep(state, tag) { try { trackHold(state, readiness(state)); } catch (e) { tickLog(state, `${tag}: hold: ${e.message}`); } }
function tickPass(o, g = {}) {
  const p = o.project, state = p.state, staleMs = o.staleMs ?? STALE_MS;
  const paused = pauseFiles(state);
  const tag = `tick ${p.name}${o.reason ? ' (' + o.reason + ')' : ''}`;
  // RM-37: Pause everything exits before the sweep, the status and the check-in; Pause check-ins runs all of it but the check-in (below)
  { const pz = readPause(paused); if (stopsTick(pz)) { notePaused(state); holdStep(state, tag); return { code: 0, msg: `${tag}: PAUSED (${pz.label}) - exit before status or check-in` }; } }
  fs.mkdirSync(state, { recursive: true });
  const lockF = path.join(state, 'tick.lock');
  const held = takeLock(lockF, `pid ${process.pid} start ${new Date().toISOString()} reason ${o.reason || '-'}`);
  if (held) return { code: 0, msg: `${tag}: ${held}` };
  try {
    // META-CATCH S1: dead runs by code, no model - recorded lost at once (machine boot after the start / supervisor gone / never
    // started), then the HANDOFF auto-resume policy relaunches them (runs.mjs relaunchLost); before the orphan stop, so their helpers go too
    try {
      sweepLost(state, { staleMs, by: 'status' });
      const rl = relaunchLost(state, o.now ? { now: o.now().getTime() } : {});
      for (const x of rl) tickLog(state, `${tag}: lost ${x.id} (${x.cause}) -> ${x.next ? 'relaunched ' + x.next : 'not relaunched: ' + x.refused}`);
      g.lost = lostNotice(rl, p.name);
      for (const id of endLost(state, o.now ? { now: o.now().getTime() } : {})) tickLog(state, `${tag}: lost ${id}: supervisor and executor gone -> ended (crash)`);   // after the relaunch: it judges first
    } catch (e) { tickLog(state, `${tag}: dead runs: ${e.message}`); }
    stopOrphans(state);   // helpers of a lost / ended parent (metadelegate sec. 2)
    // fair-slots 5c: derelict test processes (derelict.mjs; once per window machine-wide) - a dry tick only with o.listProcs
    if (o.derelicts !== false && (!o.dry || o.listProcs)) { try { for (const l of tickDerelicts(state, { list: o.listProcs, ...(o.killProc ? { kill: o.killProc } : {}), ...(o.now ? { now: o.now().getTime() } : {}) })) tickLog(state, `${tag}: ${l}`); } catch (e) { tickLog(state, `${tag}: derelict sweep: ${e.message}`); } }
    // META-GUARD R1: the usage watch before the status - a new GRD alarm is in this tick's digest and wakes the check-in (gate probe); never fails the tick
    try { const w = guardWatch(state, p, { projectsDir: o.machine?.claude?.projects_dir }); g.raised = w.raised; g.push = guardPolicy(p.policy).push; } catch (e) { tickLog(state, `${tag}: guard: ${e.message}`); }
    // RM-46 S2b: renew, fence, release, observe the work claims before the fill (which claims with the claims just fetched)
    let leader = null;   // S6a: a synced home's merge leader state (null = not synced: the merge queue runs as on one home)
    try {
      const c = claimsPass(state, { ledger: o.ledger, policy: p.policy, mergeq: mergeqOn(p), ...(o.now ? { now: o.now().getTime() } : {}) });
      if (c && (c.fenced.length || c.taken.length || c.released.length)) tickLog(state, `${tag}: claims: fenced ${c.fenced.join(' ') || '-'}; taken over ${c.taken.join(' ') || '-'}; released ${c.released.join(' ') || '-'}`);
      if (c?.leader) { leader = c.leader; if (c.leader.took || c.leader.fenced.length) tickLog(state, `${tag}: merge leader: ${c.leader.took ? `took over from stale ${c.leader.took}` : ''}${c.leader.fenced.length ? ` MERGE ${c.leader.fenced.join(' ')} stopped` : ''}`); }
    } catch (e) { tickLog(state, `${tag}: claims: ${e.message}`); leader = homeOf(state) ? { leader: false, why: `claims: ${e.message}` } : null; }
    for (const f of fillAll(state)) tickLog(state, `${tag}: ${fillWords(f, path.basename(state))}`);   // a due not_before or a freed slot (META-GT12)
    holdStep(state, tag);   // GAP-1: before the status, so this tick's digest carries the hold row
    // META-GTP-MERGEQ piece 5: the merge queue right after the fill - a detached `norn mergeq --run` (code only; a dry tick only with o.spawnMergeq)
    if (o.mergeq !== false && (!o.dry || o.spawnMergeq)) { const m = tickMergeq(p, state, { metaCmd: META_CMD, spawnFn: o.spawnMergeq, leader }); if (m) tickLog(state, `${tag}: ${m}`); }
    // RM-46 S6a: a home that is not the merge leader only opens PRs - its DONE pushed lane branches through openPrs (the slop door applies)
    if (leader && !leader.leader && !o.dry && mergeqOn(p)) try { for (const x of followerPrs(p, state, { gh: o.gh })) tickLog(state, `${tag}: ${x.lane}: ${x.status === 'refused' ? `NOT OPENED ${x.branch}: ${x.why}` : `PR ${x.url} (${x.status})`}`); } catch (e) { tickLog(state, `${tag}: PRs: ${e.message}`); }
    // META-UX-BUILD S7: the fixer of an active Fix all directive starts by code - a detached `norn fix start DIR-n --queue` (a dry tick only with o.spawnFix)
    if (o.fix !== false && (!o.dry || o.spawnFix)) { try { for (const m of tickFix(p, state, { metaCmd: META_CMD, items: loadState(state).items, spawnFn: o.spawnFix ?? ((exe, args) => spawnDetached(exe, args, p.root)) })) tickLog(state, `${tag}: ${m}`); } catch (e) { tickLog(state, `${tag}: fix: ${e.message}`); } }
    // META-SLOP-A: the daily slop report on the same schedule - a detached `norn slop daily` once a day (a dry tick only with o.spawnSlop)
    if (o.slop !== false && (!o.dry || o.spawnSlop)) { try { const s = tickSlop(p, state, { metaCmd: META_CMD, spawnFn: o.spawnSlop }); if (s) tickLog(state, `${tag}: ${s}`); } catch (e) { tickLog(state, `${tag}: slop daily: ${e.message}`); } }
    // the Tests tab's charts: a detached `norn tests history` (git only) once a day (a dry tick only with o.spawnTests)
    if (o.tests !== false && (!o.dry || o.spawnTests)) { try { const t = tickTests(p, state, { metaCmd: META_CMD, spawnFn: o.spawnTests }); if (t) tickLog(state, `${tag}: ${t}`); } catch (e) { tickLog(state, `${tag}: tests history: ${e.message}`); } }
    // the Branches view: a detached `norn branches --refresh` (git for-each-ref + cherry, cached) at most every 10 min (a dry tick only with o.spawnBranches)
    if (o.branches !== false && (!o.dry || o.spawnBranches)) { try { const b = tickBranches(p, state, { spawnFn: o.spawnBranches }); if (b) tickLog(state, `${tag}: ${b}`); } catch (e) { tickLog(state, `${tag}: branches: ${e.message}`); } }
    const running = liveRuns(state, { staleMs }).find(r => r.state_dir === path.resolve(state) && r.data.kind === 'checkin');
    if (running) return { code: 0, msg: `${tag}: check-in ${running.id} running - exit` };
    const B = projectBudget(p, o.budget || {}), machine = o.machine || {}, cp = checkinPolicy(p.policy), nowMs = o.now ? o.now().getTime() : Date.now();
    // META-CHECKIN-DIET R1: routine ends (policy.checkin.routine) are handled here by code, each a launcher review record - no model
    try { for (const x of handleRoutineEnds(state, p, { pushed: o.pushed })) tickLog(state, `${tag}: routine ${x.kind} ${x.id}: ${x.ok ? x.note : 'left for the check-in - ' + x.note}`); }
    catch (e) { tickLog(state, `${tag}: routine ends failed: ${e.message}`); }
    // GAP-12: the overlap check of the running lanes (fetch origin / gh at most every 10 min; overlap.mjs) before the digest reads it
    if (o.overlap !== false && !o.dry) projectOverlap(p);
    // DLV-MERGED-TRUTH: each recorded PR asked on GitHub, every merge latched, the 'cannot tell' rulings asked / applied - before the
    // stale questions and the digest read the deliverables (never fails the tick; the first tick after a deploy re-judges them all)
    if (!o.dry) try { for (const c of latchMerged(state, { project: p, gh: o.gh || makeGh() })) tickLog(state, `${tag}: ${c.dlv} ${c.ev} - ${c.why}`); } catch (e) { tickLog(state, `${tag}: merge latch: ${e.message}`); }
    // a merge / batch / park question whose deliverable landed meanwhile is stale: withdrawn before the digest (never fails the tick)
    if (!o.dry) try { for (const c of closeLandedQuestions(state, { project: p })) tickLog(state, `${tag}: question ${c.q} withdrawn - ${c.why}`); } catch (e) { tickLog(state, `${tag}: stale questions: ${e.message}`); }
    // lane-outputs items 7, 9, 10a: the asks of a run no supervisor ended (lost, killed) reach the Inbox; an answered ruling is written
    // into the stage brief that needs it (runasks.mjs; never fails the tick)
    if (!o.dry) try { for (const x of sweepAsks(state, { views: p.views || {}, ...(o.now ? { now: o.now().getTime() } : {}) })) tickLog(state, `${tag}: ${x.run} asks the owner: ${x.posted.map(q => q.id ?? `(refused) ${q.title}`).join(', ')}`); for (const x of applyRulings(state)) tickLog(state, `${tag}: ruling ${x.q} written into ${x.brief}`); } catch (e) { tickLog(state, `${tag}: owner asks: ${e.message}`); }
    // item 9 (MAIL-20, lanepaths.mjs tickPaths): finished work reaches a PR by code - unpushed commits pushed, the MERGE stage queued (P1;
    // P0 while a collision holds a queued run on the lane: lane-collide S1b, waitedMergeCli)
    if (!o.dry || o.lanes) try { for (const x of tickPaths(state, { project: p, dry: !!o.dry, cli: waitedMergeCli(state, o.cli || metaCli(META_CMD)), ...(o.now ? { now: o.now().getTime() } : {}) })) tickLog(state, `${tag}: path to main ${x.id}: ${x.act} - ${x.note}`); } catch (e) { tickLog(state, `${tag}: path to main: ${e.message}`); }
    // UI redesign 2026-11-20 (proposals.mjs tickProposals): a finished plan goes ahead inside its lane - the next open stage of an active,
    // idle lane queued by code, no owner card (a parked lane waits); never fails the tick
    if (!o.dry) try { const st = loadState(state); for (const x of tickProposals(state, st.items, loadRoadmap(state), { cli: o.cli || metaCli(META_CMD), loc: [...(p.file ? ['--project', p.file] : []), '--state', state, '--as', 'launcher'] })) tickLog(state, `${tag}: plan of ${x.run} ${x.stage} on ${x.lane}: ${x.act} - ${x.note}`); } catch (e) { tickLog(state, `${tag}: plan stages: ${e.message}`); }
    // lane norn-lifecycle item 5 (lifecycle.mjs): no lane sits - the orphan / stopped-and-landed / done-merged-and-old lanes archived by code
    // before the digest (which then lists the idle and stopped ones for the check-in); never fails the tick
    if (!o.dry || o.lanes) try { for (const x of tickLanes(state, { project: p, ...(o.now ? { now: o.now().getTime() } : {}) })) tickLog(state, x.refused ? `${tag}: ${x.id} (${x.rule}) not archived: ${x.refused}` : `${tag}: archived ${x.id} (${x.rule}; worktree ${x.worktree}${x.at_risk ? ', at risk: ' + x.at_risk : ''}) - ${x.why}`); } catch (e) { tickLog(state, `${tag}: lanes: ${e.message}`); }
    // META-CATCH S1: the stuck sweep (stuck.mjs) - the flags into stuck.json (the gate fact, the run refusal); one notice per new flag
    try { const tr = Object.keys(loadRoadmap(state).items).length ? buildTree({ stateDir: state, project: p }) : null; const sw = stuckSweep(state, tr ? itemsOf(tr) : [], { project: p.name }); if (sw.notices.length) g.stuck = sw.notices; }
    catch (e) { tickLog(state, `${tag}: stuck sweep failed: ${e.message}`); }
    const start = new Date().toISOString();
    const s = writeStatus({ state, project: p.name, providers: providersOf(p), budget: B, projectsDir: machine.claude?.projects_dir, usageJson: machine.usage || {},
      cacheFile: path.join(state, 'usage-cache.json'), paused, staleMs, ci: p.ci, digest: tryDigest(state, p) });
    { const pz = readPause(paused); if (stopsCheckins(pz)) { notePaused(state); tickLog(state, `${tag}: ${pz.label} - no check-in`); return { code: 0, msg: `${tag}: ${s.line}; PAUSED (${pz.label}) - no check-in` }; } }
    // META-CHECKIN-GATE: wake the LLM only on a material change since the last real check-in (or past checkin_max_quiet_min)
    const live = { band: Number.isFinite(s.weekly) ? Math.floor(s.weekly / 5) : null, rate_ok: s.rateOk, rate_band: rateBand(s.rate, B.usage_rate_cap_pct_per_h),
      quiet: fs.existsSync(quietFlag(p)) };
    const gate = checkinGate({ state, budget: B, policy: p.policy, live, probes: gateProbes(p, machine), levelOf: lane => laneLevel(cp, lane), ...(o.now ? { now: o.now() } : {}) });
    if (!gate.run) {
      noteSkip(state, gate.why);
      tickLog(state, `${tag}: skip: ${gate.why}`);
      return { code: 0, msg: `${tag}: ${s.line}; skip: ${gate.why}` };
    }
    // META-CHECKIN-DIET R1 debounce: ends within policy.checkin.debounce_min wake ONE tick, at the oldest new end + the window
    const db = debounceOf(gate, { runEvs: readEvents(recordsFile(state, 'run')), minutes: Number(cp.debounce_min), now: nowMs });
    if (db) {
      const why = `debounce: ${db.ends} end(s), one check-in at ${db.until}`, g = readGate(state);
      if (!(g?.debounce_at && Date.parse(g.debounce_at) >= Date.parse(db.until) && Date.parse(g.debounce_at) > nowMs)) {
        noteDebounce(state, db.until);
        const args = [META_CMD, 'tick', '--reason', 'debounce', '--at', db.until, ...(p.file ? ['--project', p.file] : []), '--state', state];
        try { (o.spawnTick || (a => spawn(process.execPath, a, { detached: true, stdio: 'ignore', windowsHide: true }).unref()))(args); } catch (e) { tickLog(state, `${tag}: debounce tick failed: ${e.message}`); }
      }
      noteSkip(state, why); tickLog(state, `${tag}: skip: ${why}`);
      return { code: 0, msg: `${tag}: ${s.line}; skip: ${why}` };
    }
    // CHECKIN-V2 piece 2 (GT-3 ruling): a MINOR wake runs the reduced prompt on checkin_minor_model / _effort ('' = the full tick)
    const minorModel = B.checkin_minor_model ?? MACHINE_DEFAULTS.checkin_minor_model, minor = gate.cls === 'minor' && !!minorModel;
    const ck = renderCheckin(p, { budgetFile: o.budgetFile, budget: B, statusFile: s.out, template: minor ? CHECKIN_MINOR_PROMPT : CHECKIN_PROMPT, wake: gate.why + stuckWake(state, gate.why),
      cv: checkinCv(p, { budget: B, projectsDir: machine.claude?.projects_dir }) });
    if (stopsCheckins(readPause(paused))) { notePaused(state); return { code: 0, msg: `${tag}: PAUSED - exit` }; }
    const cx = checkinExecutor({ B, machine, p, minor, dry: o.dry });   // H2 Setting + the H7 trial (piece 4)
    if (cx.error) return { code: 2, msg: `${tag}: ${cx.error}` };
    const { executor, model, effort } = cx;
    // META-AUTH: while the login is down a check-in dies in 0.1 s - it holds like a dispatch (a passing probe makes it the canary)
    const ah = authRefusal(state, executorInfo(executor)?.harness ?? executor, { spec: { executor, exe: cx.exe } });
    if (ah) { noteSkip(state, ah); tickLog(state, `${tag}: skip: ${ah}`); return { code: 0, msg: `${tag}: ${s.line}; skip: ${ah}` }; }
    // META-LIMIT-GATE: a check-in executor out of quota holds like a login outage (until its reset)
    const lh = limitRefusal(state, { executor });
    if (lh) { noteSkip(state, lh); tickLog(state, `${tag}: skip: ${lh}`); return { code: 0, msg: `${tag}: ${s.line}; skip: ${lh}` }; }
    const r = startRun({
      state, locksDir: path.join(path.dirname(path.resolve(state)), 'locks'), executor, kind: 'checkin', lock: false, lane: 'checkin', project: p.name, tickClass: minor ? 'minor' : 'major',
      brief: ck, worktree: p.checkin?.cwd || p.root, addDirs: p.checkin?.add_dirs || [], model, effort, exe: cx.exe,
      ...(cx.trial ? { trial: cx.trial, writable_roots: cx.writable_roots, fallback: cx.fallback, ...(cx.mcp ? { mcp: cx.mcp } : {}) } : {}),
      promptText: `Read ${fwd(ck)} and do exactly that. BUDGET file for this check-in: ${fwd(o.budgetFile || '(none)')}`,
      env: memoryEnv({ ...(p.executors?.claude?.env || {}), VIRTUAL_ENV: null, META_STATE: state, META_ROLE: 'checkin', ...(p.file ? { META_PROJECT: p.file } : {}),
        ...(o.dry && o.fakeMs ? { FAKE_MS: String(o.fakeMs) } : {}) }, memoryOf(p.policy, 'checkin')),   // META-PRACTICE-P1
      ...(memoryOf(p.policy, 'checkin') === 'off' ? { memory: 'off' } : {}),
      profile: profileOf(p.policy, 'checkin'),   // META-STANDING-CONTEXT R1: policy.launch.roles.checkin (full = today's launch)
      policy: { auto_resume_handoff: false, trigger_on_exit: false }, tick: null, budget: B, paused, ...(o.ledger ? { git_ledger: o.ledger } : {}), projectsDir: machine.claude?.projects_dir,
      ...(o.hbMs ? { hbMs: o.hbMs } : {}), staleMs,
    });
    fs.writeFileSync(path.join(state, 'last-tick.txt'), start);
    noteCheckin(state, { run: r.run, start: fold(readEvents(recordsFile(state, 'run'))).items[r.run]?.created || start, live, budget: B, forced: !!gate.forced, quiet_n: gate.quiet_n ?? 0 });
    const msg = `check-in ${r.run} ${executor} ${model} ${effort} supervisor pid ${r.pid} (gate: ${gate.cls ? gate.cls + ' ' : ''}${gate.why})`;
    tickLog(state, `${tag}: ${msg}`);
    return { code: 0, msg: `${tag}: ${s.line}; ${msg}` };
  } finally { try { fs.unlinkSync(lockF); } catch { /* already removed: nothing left to unlock, the next tick takes it */ } }
}
