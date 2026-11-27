// META-CHECKIN-GATE (CHECKIN-V2 slice 1, META-OVERVIEW-2026-11-08 sec. 3 row 1): `norn tick` wakes the LLM check-in only when the
// MATERIAL state changed since the last real check-in. The fingerprint is a sorted set of facts:
//   records (folded): live runs, unreviewed ends (exited / lost / killed), stalls (past budget_min x wall_time_multiplier),
//   open / answered questions, active directives, overruled decisions, lane states, the count of owner / dashboard events;
//   mail (the whole mailbox, own log + other homes' copies: mailFacts): open mail to this home's check-in, and open mail to its
//   controller once checkin_take_min old - compared with the mail list the last check-in was launched with (a copied event
//   carries the sender's ts, not its arrival here, so "events up to its start" cannot tell what it saw);
//   live (stored at launch, not in the records): weekly-burn guard band (5 % buckets), RATE_OK, the rate leaving the near-cap
//   quarter, a cap raise, QUIET, a PAUSED flip; probes (GT-5 seam: mtime stalls) add their own facts.
// R2 replay (48 h, 271 check-ins): a "lane with a queued next stage AND a free slot" fact never gated an action alone (a slot that
// frees by an end is an end fact; the rest were 36..57 stale finished lanes flipping on every cap / busy change), so the only
// uncovered cause - a cap raise - is its own fact; rate quarters woke 26 idle check-ins, only leaving the top quarter acted.
// What the last check-in SAW = the records as of its start + its own actions (events with run = its id), so its own dispatches,
// reviews and decisions never wake the next tick; everything by others after its start does. Equal -> skip; older than
// checkin_max_quiet_min -> forced. Later slices add event types here (deliverable aged, executor-agnostic check-ins).
import fs from 'node:fs';
import path from 'node:path';
import { readEvents, recordsFile, fold } from './records.mjs';
import { loadMail, boxOf, stored, controllerMail, CHECKIN_TAKE_MIN } from './mail.mjs';
import { MACHINE_DEFAULTS } from './policy.mjs';
import { findTranscript } from './harness/claude.mjs';
import { unanswered } from './qthread.mjs';

export const GATE_DEFAULTS = { checkin_gate: MACHINE_DEFAULTS.checkin_gate, checkin_max_quiet_min: MACHINE_DEFAULTS.checkin_max_quiet_min, checkin_quiet_max_min: MACHINE_DEFAULTS.checkin_quiet_max_min };
export const gateFile = state => path.join(state, 'checkin-gate.json');
const OWNER = ['owner', 'dashboard'];
const ENDED = ['exited', 'lost', 'killed'];
export const isWork = d => d.kind !== 'checkin' && d.kind !== 'interactive' && d.role !== 'helper';
const capsOf = B => Object.fromEntries(Object.entries(B || {}).filter(([k, v]) => k.startsWith('max_') && Number.isFinite(v)));

export function readGate(state) {
  try { return JSON.parse(fs.readFileSync(gateFile(state), 'utf8')); } catch { return null; }
}
function writeGate(state, g) {
  fs.mkdirSync(state, { recursive: true });
  const f = gateFile(state), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(g, null, 1));
  fs.renameSync(tmp, f);
}
const keep = g => ({ skips: g?.skips || 0, skips_by_day: g?.skips_by_day || {}, ...(g?.paused_at ? { paused_at: g.paused_at } : {}) });
/** the check-in `run` (started at `start`) is the new baseline; live = { band, rate_ok, quiet } it was launched under; forced / quiet_n = the
 * gate verdict it ran on (piece 3 backoff: a woken check-in stores quiet_n 0); mail = the verdict's mailFacts (open mail only: small) */
export function noteCheckin(state, { run, start, live = {}, budget = {}, forced = false, quiet_n = 0, mail = [] }) {
  const g = readGate(state);
  writeGate(state, { ...keep(g), run, start, live, caps: capsOf(budget), forced: !!forced, quiet_n: forced ? quiet_n : 0, mail, last: { ts: start, verdict: 'checkin' } });
}
export function noteSkip(state, why, now = new Date()) {
  const g = readGate(state) || {}, day = now.toISOString().slice(0, 10);
  writeGate(state, { ...g, skips: (g.skips || 0) + 1, skips_by_day: { ...(g.skips_by_day || {}), [day]: ((g.skips_by_day || {})[day] || 0) + 1 },
    last: { ts: now.toISOString(), verdict: 'skip', why } });
}
/** META-CHECKIN-DIET R1: a debounce tick is spawned for `until` (one per window; the next check-in clears it) */
export function noteDebounce(state, until) {
  writeGate(state, { ...(readGate(state) || {}), debounce_at: until });
}
export function notePaused(state, now = new Date()) {
  writeGate(state, { ...(readGate(state) || {}), paused_at: now.toISOString() });
}

/**
 * the fingerprint facts of (record events, run events) at time `at` (ms); mult = wall_time_multiplier. probes: [(ctx) => facts]
 * with ctx { at, running, runs, items } - the GT-5 seam (a live run whose log / transcript mtime has not moved for N min is a
 * stall the budget clock cannot see); their facts are major wakes unless MINOR_FACTS lists their prefix. Mail is not here: mailFacts.
 */
export function facts(recEvs, runEvs, { at, mult = 2, probes = [], dlvEvs = [], levelOf = () => 'full' }) {
  const F = new Set();
  // META-CHECKIN-DIET R1 lane levels (checkins.mjs laneLevel): none = no fact of its runs; on-end = its ends and stalls only
  const runs = Object.values(fold(runEvs).items).filter(r => isWork(r.data) && levelOf(r.data.lane) !== 'none');
  const running = runs.filter(r => r.state === 'running');
  for (const r of running) {
    if (levelOf(r.data.lane) === 'full') F.add(`run:${r.id}`);
    const bm = Number(r.data.budget_min);
    if (bm > 0 && at - Date.parse(r.created) > bm * mult * 60000) F.add(`stall:${r.id}`);
  }
  for (const r of runs) if (ENDED.includes(r.state) && !r.review) F.add(`end:${r.id}:${r.state}`);
  const items = Object.values(fold(recEvs).items);
  for (const i of items) {
    if (i.kind === 'question' && ['open', 'answered'].includes(i.state)) F.add(`q:${i.id}:${i.state}`);
    // INBOX-REPLIES: the owner wrote in a Q's thread and the controller has not replied - a MAJOR wake (the reply needs a full turn)
    if (i.kind === 'question') { const w = unanswered(i); if (w.length) F.add(`thread:${i.id}:${w.at(-1).seq}`); }
    if (i.kind === 'directive' && i.state === 'active') F.add(`dir:${i.id}`);
    if (i.kind === 'decision' && i.state === 'overruled') F.add(`dec:${i.id}:overruled`);
    if (i.kind === 'lane' && i.state !== 'archived') F.add(`lane:${i.id}:${i.state}`);
  }
  // NORN-WATCH S1: a deliverable newly done (created / done again, not parked) wakes once; one that stays the same does not
  for (const d of Object.values(fold(dlvEvs).items)) if (d.kind === 'deliverable' && d.state === 'open') F.add(`dlv:${d.id}:done`);
  F.add(`owner:${[...recEvs, ...runEvs].filter(e => OWNER.includes(e.by)).length}`);
  const full = running.filter(r => levelOf(r.data.lane) === 'full');
  for (const p of probes) for (const x of p({ at, running: full, runs, items }) || []) F.add(x);
  return F;
}
/**
 * CHECKIN-V2 piece 1 - progress stall (Gas Town GUPP: hooked work with no progress for 30 min, internal/constants/constants.go:
 * 94-101): a live run whose log, transcript and NOTES mtimes ALL stayed unchanged for `minutes` (project checkin.stall_idle_min)
 * is `idle:RUN-n`, a MAJOR wake once (the budget clock `stall:` cannot see a hung run inside its budget; it stays). Last progress
 * = the newest of the run's start and those mtimes (a missing file adds nothing); the files are stat'ed once per probe.
 */
export const STALL_IDLE_MIN = 30;
export function idleProbe({ minutes = STALL_IDLE_MIN, projectsDir } = {}) {
  const last = new Map();
  const mtime = f => { try { return f ? fs.statSync(f).mtimeMs : 0; } catch { return 0; } };
  const lastOf = r => {
    if (!last.has(r.id)) {
      const d = r.data || {};
      last.set(r.id, Math.max(Date.parse(r.created) || 0, mtime(d.log), mtime(d.notes), mtime(d.transcript || findTranscript(projectsDir, d.session_id))));
    }
    return last.get(r.id);
  };
  return ({ at, running }) => running.filter(r => at - lastOf(r) >= minutes * 60000).map(r => `idle:${r.id}`);
}
/** trailing rate vs the rate cap in quarters (4 = at / over the cap); null without a cap. Replay 11-08: check-ins hold a dispatch
 * "near the cap" (RUN-1497 at 1.31 of 1.5) and send it once the rate falls (RUN-1499 at 0.99) - RATE_OK alone does not flip. */
export const rateBand = (rate, cap) => (Number(cap) > 0 && Number.isFinite(Number(rate)) ? Math.max(0, Math.min(4, Math.floor(Number(rate) / Number(cap) * 4))) : null);
// a live key compares only when both sides know it (an unknown value - no cap, a replay gap - is "unchanged")
const LIVE_KEYS = ['band', 'rate_ok', 'quiet'];
const known = v => v !== undefined && v !== null;
// near the cap = the top quarter (rate >= 3/4 of the cap): check-ins hold dispatches there (RUN-1138 at 0.74, RUN-1413 at 0.87)
const NEAR_BAND = 3;
const liveFacts = (live, other, pausedFlip) => {
  const F = new Set();
  for (const k of LIVE_KEYS) if (known(live?.[k]) && known(other?.[k])) F.add(`${k}:${live[k]}`);
  if (known(live?.rate_band) && known(other?.rate_band)) F.add(`rate_near:${live.rate_band >= NEAR_BAND ? 1 : 0}`);
  if (pausedFlip) F.add('pause:flipped');
  return F;
};
// one-way facts: only the OPENING direction is news - the rate leaving the near-cap quarter, a cap raise (a cut, or the rate
// climbing towards the cap, only means "start nothing new", which needs no check-in)
const capRaises = (baseCaps, caps) => Object.entries(caps || {}).filter(([k, v]) => Number.isFinite(baseCaps?.[k]) && v > baseCaps[k]).map(([k, v]) => `+cap:${k}:${v}`);
// a red CI run leaving is no news (main went green: META-CIWATCH wakes on the red only)
const opening = ch => ch.filter(x => x !== '+rate_near:1' && x !== '-rate_near:0' && !x.startsWith('-ci:'));
const diff = (a, b) => [...[...b].filter(x => !a.has(x)).map(x => '+' + x), ...[...a].filter(x => !b.has(x)).map(x => '-' + x)];
const loadEvents = state => ({ rec: readEvents(recordsFile(state, 'question')), run: readEvents(recordsFile(state, 'run')), dlv: readEvents(recordsFile(state, 'deliverable')) });
// what check-in `run` saw: everything up to its start + its own actions while it was alive (a worker it dispatched inherits
// META_RUN_ID, so that worker's later end / resume events carry the check-in's id too: those are news, not its own action)
export const endOf = (runEvs, run) => { const it = fold(runEvs).items[run]; const h = it?.history.find(x => ['end', 'lost', 'kill'].includes(x.ev)); return h ? Date.parse(h.ts) : Infinity; };
const seenBy = (evs, run, startMs, endMs) => evs.filter(e => { const t = Date.parse(e.ts); return t <= startMs || (e.run === run && t <= endMs); });
const SUPERVISOR_EVS = ['end', 'resume', 'lost'];
/**
 * the kind.ev of every action check-in `run` took while alive: supervisor events of runs it dispatched excluded, and so is a
 * review of a CHECK-IN or a HELPER run (`checkins` = their ids: bookkeepingIds) - that is the check-in loop's own bookkeeping (STATUS lists the previous
 * check-in as unreviewed), never a reaction to a material change (replay finding, 11-08).
 */
export const actionsOf = (evs, run, endMs, checkins = new Set()) => [...new Set(evs.filter(e => e.run === run && Date.parse(e.ts) <= endMs
  && !(e.kind === 'run' && SUPERVISOR_EVS.includes(e.ev)) && !(e.kind === 'run' && e.ev === 'review' && checkins.has(e.id)))
  .map(e => `${e.kind}.${e.ev}`))].sort();

/** compare what check-in `base` (start startMs) saw with the state at nowMs; returns the changes (none = skip) */
function compare(E, base, startMs, nowMs, { caps, baseCaps, mult, live, baseLive, pausedFlip, probes = [], levelOf }) {
  const endMs = endOf(E.run, base);
  const b = facts(seenBy(E.rec, base, startMs, endMs), seenBy(E.run, base, startMs, endMs), { at: startMs, mult, probes, levelOf, dlvEvs: seenBy(E.dlv || [], base, startMs, endMs) });
  const c = facts(E.rec, E.run, { at: nowMs, mult, probes, levelOf, dlvEvs: E.dlv || [] });
  for (const x of liveFacts(baseLive, live)) b.add(x);
  for (const x of liveFacts(live, baseLive, pausedFlip)) c.add(x);
  // META-CHECKIN-DIET R1: a run the tick's code closed as routine (a launcher review) is no news: its run leaving, its deliverable
  const rt = routineIds(E.run, startMs), dlvRun = fold(E.dlv || []).items;
  // DEC-a-680: so is a lane the tick archived by rule (lifecycle.mjs tickLanes) unless the archive names work at risk (kept worktree)
  const ta = tickArchived(E.rec, startMs);
  const news = x => !(x.startsWith('-run:') && rt.has(x.slice(5))) && !(x.startsWith('+dlv:') && rt.has(dlvRun[x.split(':')[1]]?.data?.run))
    && !(x.startsWith('-lane:') && ta.has(x.slice(6, x.lastIndexOf(':'))));
  return [...opening(diff(b, c)).filter(news), ...capRaises(baseCaps ?? caps, caps)];
}
/** ids of runs a launcher ROUTINE review (checkins.mjs handleRoutineEnds) closed at or after sinceMs (ts has second resolution: a review in the start second of the check-in is still after it, never seen by it) */
export const routineIds = (runEvs, sinceMs = -Infinity) => new Set(runEvs.filter(e => e.kind === 'run' && e.ev === 'review' && e.by === 'launcher' && e.data?.routine
  && Date.parse(e.ts) >= sinceMs).map(e => e.id));
/** ids of lanes whose last archive at or after sinceMs is by the tick with no data.at_risk (a clean rule archive: no one has to act) */
const tickArchived = (recEvs, sinceMs) => {
  const last = new Map();
  for (const e of recEvs) if (e.kind === 'lane' && e.ev === 'archive' && Date.parse(e.ts) >= sinceMs) last.set(e.id, e.by === 'tick' && !e.data?.at_risk);
  return new Set([...last].filter(([, clean]) => clean).map(([id]) => id));
};
// GT-5 seam: a MINOR wake carries only facts a reduced-effort tick could handle (time, a start by another, a vanished run, the
// guard band, the owner-event count); any other fact - or one a probe adds - is MAJOR. CHECKIN-V2 piece 2: a minor wake runs the
// reduced tick (CHECKIN-MINOR.md on checkin_minor_model); its "MAJOR NEEDED" escalates the next tick to a full one.
export const MINOR_FACTS = ['run', 'band', 'owner'];
export function wakeClass({ forced, followUp, escalated, changes = [] } = {}) {
  if (followUp || escalated) return 'major';
  if (forced && !changes.length) return 'minor';
  return changes.every(x => MINOR_FACTS.includes(x.slice(1).split(':')[0])) ? 'minor' : 'major';
}
// FOLLOW-UP request (replay 11-08: RUN-1418 "needs a new brief = next tick", RUN-1487 "will dispatch ... at the next tick"): a
// check-in that defers work to the next tick / check-in in its final output is woken once (the next check-in is the new baseline)
const FOLLOW_UP = /[^.;\n]{0,80}\b(next|following) (tick|check-?in)\b[^.;\n]{0,40}/i;
const finalText = item => {
  const f = item?.data?.final;
  if (!f) return null;
  let t;
  try { t = fs.readFileSync(f, 'utf8'); } catch { return null; }
  try { t = String(JSON.parse(t).result ?? ''); } catch { /* plain text (codex final .md) */ }
  return t;
};
export function followUpOf(item) {
  return finalText(item)?.match(FOLLOW_UP)?.[0].trim().replace(/\s+/g, ' ') ?? null;
}
// CHECKIN-V2 piece 2: a minor tick that met something beyond its minor facts ends with MAJOR NEEDED (CHECKIN-MINOR.md)
const MAJOR_NEEDED = /\bMAJOR NEEDED\b[^.;\n]{0,100}/;
export function majorNeededOf(item) {
  return finalText(item)?.match(MAJOR_NEEDED)?.[0].trim().replace(/\s+/g, ' ') ?? null;
}
/**
 * CHECKIN-V2 piece 3 - quiet backoff (Gas Town await-signal: min(base * mult^idle, max), internal/cmd/molecule_await_signal.go:46-69):
 * a FORCED quiet check-in whose actionsOf() is empty doubles the next quiet window; base = today's window (checkin_max_quiet_min, 60 on
 * the machine, or the project's checkin.max_quiet_min), cap = checkin_quiet_max_min (240; never below the base, so a window is never
 * shorter than before: NORN-WATCH S2's 360 stays 360);
 * a woken check-in (any fact change) or a forced one that acted resets it. quiet_n = the exponent, kept in the gate file.
 */
export const quietWindow = (n, base, cap) => Math.min(base * 2 ** n, Math.max(base, cap));
export const nextQuietN = (n, forced, acted, base, cap) => (!forced || acted ? 0 : base > 0 && base * 2 ** n < cap ? n + 1 : n);
// review targets that are bookkeeping, not news: check-in runs and HELPER runs (a helper's end belongs to its parent; CHECKIN-V2 replay RUN-1658)
export const bookkeepingIds = runEvs => new Set(Object.values(fold(runEvs).items).filter(i => i.data.kind === 'checkin' || i.data.role === 'helper').map(i => i.id));
/**
 * archive-wake S2 (DEC-a-682 item 1): the mail facts over the WHOLE mailbox (own log + other homes' copies): mail:<id> = open mail
 * in this home's check-in box (a run's reply, another home's mail); cmail:<id> = open mail for this home's controller at least
 * takeMin old (CHECKIN.md sec. 1: a MAJOR check-in takes it - with no controller session it would wait for an unrelated wake)
 */
export function mailFacts(state, { now = Date.now(), takeMin = CHECKIN_TAKE_MIN } = {}) {
  const box = boxOf(state, { to: 'role:checkin' });
  const F = Object.values(loadMail(state)).filter(m => m.state !== 'acked' && box.has(stored(state, m))).map(m => `mail:${m.id}`);
  for (const m of controllerMail(state, { now })) if (m.age_min >= takeMin) F.push(`cmail:${m.id}`);
  return F.sort();
}
// the mail facts at this tick and those the baseline check-in was not launched with (as +changes): a check-in stores `mail`, fresh is MAJOR
const mailNews = (o, g, now) => {
  const mail = mailFacts(o.state, { now, takeMin: Number(o.policy?.mail?.checkin_take_min ?? CHECKIN_TAKE_MIN) }), had = new Set(g?.mail || []);
  return { mail, fresh: mail.filter(x => !had.has(x)).map(x => '+' + x) };
};
const changed = ch => `changed: ${ch.slice(0, 6).join(', ')}${ch.length > 6 ? ` (+${ch.length - 6} more)` : ''}`;

/**
 * The gate verdict for one tick. o: { state, budget (machine: checkin_gate, checkin_max_quiet_min, max_*), policy (project:
 * iteration.wall_time_multiplier, mail.checkin_take_min), live { band, rate_ok, rate_band, quiet }, now }. Returns { run: bool, why, forced?,
 * mail (when it runs: the mail facts the check-in is launched with, for noteCheckin) }.
 */
export function checkinGate(o) {
  const B = o.budget || {}, now = (o.now || new Date()).getTime();
  const g = readGate(o.state), { mail, fresh } = mailNews(o, g, now);
  if ((B.checkin_gate ?? GATE_DEFAULTS.checkin_gate) === false) return { run: true, why: 'gate off', mail };
  if (!g?.run || !g.start) return { run: true, why: 'no earlier check-in seen by the gate', mail };
  const E = loadEvents(o.state);
  const baseItem = fold(E.run).items[g.run];
  if (!baseItem) return { run: true, why: `baseline ${g.run} not in runs.jsonl`, mail };
  const startMs = Date.parse(g.start), age = (now - startMs) / 60000, maxQ = Number(B.checkin_max_quiet_min ?? GATE_DEFAULTS.checkin_max_quiet_min);
  const capQ = Number(B.checkin_quiet_max_min ?? GATE_DEFAULTS.checkin_quiet_max_min);
  const esc = majorNeededOf(baseItem);
  if (esc) return { run: true, cls: wakeClass({ escalated: true }), why: `escalated by ${g.run}: ${esc.slice(0, 120)}`, mail };
  const qn = nextQuietN(g.quiet_n || 0, !!g.forced, g.forced ? actionsOf([...E.rec, ...E.run], g.run, endOf(E.run, g.run), bookkeepingIds(E.run)).length > 0 : false, maxQ, capQ);
  const win = quietWindow(qn, maxQ, capQ);
  if (age > win) return { run: true, forced: true, quiet_n: qn, cls: wakeClass({ forced: true, changes: fresh }), mail,
    why: `forced: last check-in ${g.run} ${Math.floor(age)} min ago (max quiet ${win})${fresh.length ? `; ${changed(fresh)}` : ''}` };
  const fu = followUpOf(baseItem);
  if (fu) return { run: true, cls: wakeClass({ followUp: true }), why: `follow-up asked by ${g.run}: ${fu.slice(0, 120)}`, mail };
  const changes = [...compare(E, g.run, startMs, now, { caps: capsOf(B), baseCaps: g.caps, mult: Number(o.policy?.iteration?.wall_time_multiplier ?? 2),
    live: o.live, baseLive: g.live, pausedFlip: g.paused_at && Date.parse(g.paused_at) > startMs, probes: o.probes, levelOf: o.levelOf }), ...fresh];
  return changes.length ? { run: true, cls: wakeClass({ changes }), changes, why: changed(changes), mail } : { run: false, why: `no change since ${g.run}` };
}
