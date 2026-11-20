// Truthful lanes (META-GENERAL-DESIGN 5, 12-S6): the lane list is LANE records only (no folder scan); a lane's state text is its
// latest RUN on that lane, any executor. Pure over a loadState() fold; heartbeat age comes from the caller.
import { STALE_MS } from './runs.mjs';
import { runName } from './names.mjs';
import { loginCommand } from './authguard.mjs';
import { laneRules, IDLE_H, ARCHIVE_DAYS } from './lifecycle.mjs';
import { idNum as runNum, laneNameIn } from './records.mjs';
import { runWord } from './map.mjs';


// the evidence runs.hbLate found for a late beat: the CPU the sweep sampled, or how long ago the run's own output moved
const lateWhy = l => l.cpu != null ? `CPU ${l.cpu} %` : `output ${l.output_age < 60e3 ? `${Math.round(l.output_age / 1000)} s` : `${Math.round(l.output_age / 60000)} min`} ago`;
// queue bookkeeping, not a run of the lane: withdrawn before it started, or a queue entry filled into the real run
const BOOKKEEPING = ['withdrawn', 'filled'];
function runText(r, { now, hbAge, hbLate, staleMs, cpu = null, items = {} }) {
  const d = r.data || {}, end = r.end || {};
  // OOTB-R2 N-5: a queued run is queued (it has no end), and one re-queued after an auth exit says it waits for the login
  if (r.state === 'queued' || r.state === 'claimed') {
    const prev = items[d.requeue_of];
    if (prev?.end?.outcome === 'auth' && prev.end.auth_class === 'vendor') return `queued: held for a vendor outage (${prev.id} exited: auth) - resumes by itself, no login needed`;
    return prev?.end?.outcome === 'auth' ? `queued: held for login (${prev.id} exited: auth) - run ${loginCommand(d.executor)}` : r.state;
  }
  if (r.state === 'running') {
    // a stale .hb is 'lost' unless runs.hbLate finds the supervisor alive and its output advanced or the CPU busy: then 'heartbeat late', naming which
    const age = hbAge ? hbAge(r.id, r) : 0, late = age > staleMs ? hbLate?.(r.id, r, { age, cpu }) : null;
    if (age > staleMs && !late) return 'lost';
    const min = Math.max(0, Math.round((now - Date.parse(r.created)) / 60000));
    const who = [d.executor, d.model, d.effort].filter(Boolean).join(' ');
    return `running ${who} for ${min} min` + (d.budget_min ? ` / budget ${d.budget_min}` : '') + (late ? ` - heartbeat late (${Math.round(age / 1000)} s, ${lateWhy(late)})` : '');
  }
  if (r.state === 'lost') return 'lost';
  // OVERVIEW-TRUTH (5): a withdrawn run never started - it says so and why (it read 'exited: no-result': no end outcome)
  if (r.state === 'withdrawn') return `withdrawn: ${r.history.findLast(h => h.ev === 'withdraw')?.data?.why ?? 'no reason recorded'}`;
  if (r.state === 'filled') return `filled: started as ${r.history.findLast(h => h.ev === 'fill')?.data?.next ?? '?'}`;
  if (r.state === 'killed') return 'killed' + (r.kill?.why ? `: ${r.kill.why}` : '');
  if (r.resume?.refused) return `waiting: auto-resume refused (${r.resume.refused})`;
  const o = end.outcome;
  if (o === 'done') return 'exited: DONE';
  if (o === 'stopped') return `exited: STOPPED: ${end.why ?? ''}`.trimEnd();
  if (o === 'handoff') return 'exited: HANDOFF' + (r.resume?.next ? ` -> ${r.resume.next}` : '');
  if (o === 'crash') return `exited: crash (exit ${end.exit ?? '?'})`;
  if (o === 'auth') return end.auth_class === 'vendor' ? 'exited: auth - a vendor outage (no login needed)' : `exited: auth - run ${loginCommand(d.executor)}`;
  return `exited: ${o ?? 'no-result'}`;
}

// ---------- the live hand-off state (one home: every page reads the `handoff` field this builds, never its own guess) ----------
// A worker at its context limit writes its result HANDOFF (`norn done`) and stops; its executor may still be finishing (a background
// command it started keeps the process alive), then the supervisor records the end and auto-resumes: a NEW run on the same lane and
// brief (data.resume_of = the run that handed off, data.resumes + 1 = its session number), which starts, then talks. Through all of
// that the old run's last message ("I stopped this run with a hand-off ...") is the newest thing on screen. Walk from any run of the
// chain to its tip (the newest run along resume.next, as after.mjs follows a HANDOFF), then:
//   pending, step 'closing'  the tip is running and its own result (written since its start) says HANDOFF: the session handed off and
//                            its executor is exiting; session n+1 comes next
//   pending, step 'ending'   the tip exited HANDOFF and the supervisor has no resume verdict yet (at most waitMs after the end: a
//                            supervisor that died there never decides, and the lane then reads plain "exited: HANDOFF")
//   pending, step 'queued'   the tip is the hand-off resume and waits in the queue (queued / claimed)
//   pending, step 'starting' the tip is the hand-off resume, running, and its session has said nothing yet (talked(id) false)
//   resumed                  the tip is the hand-off resume, running, and its session has talked: the run goes on
//   null                     anything else: no hand-off, the resume was refused (the lane says "waiting: auto-resume refused"),
//                            or the chain ended (its tip's own state says how)
// talked(id) = the run's session produced its first model event (agents.mjs runTalked); wrote(id) = its result.json says handoff,
// written since its start. A 'closing' run whose resume is later refused (cap, pause, weekly guard) drops to null at its end.
const HANDOFF_WAIT_MS = 2 * 60000;
const sessionOf = r => (Number(r?.data?.resumes) || 0) + 1;
const handoffResume = (r, items) => { const p = items[r?.data?.resume_of], d = r?.data || {};
  return !!p && p.end?.outcome === 'handoff' && (p.resume?.next ?? r.id) === r.id && !d.slop_of && !d.dod_of && !d.nudge; };
// text = the full words; short = the same for a map node / label (no room for the full line)
export const handoffWords = (h, short = false) => (!h ? null : h.phase === 'resumed' ? (short ? `resumed (session ${h.session})` : `resumed after hand-off (session ${h.session})`)
  : `${short ? 'hand-off:' : 'hand-off in progress -'} session ${h.session} ${h.step === 'closing' ? (short ? 'next' : 'next (the last session is closing)') : h.step === 'queued' ? 'queued' : 'starting'}`);
/** r (a fold run) -> { phase: pending | resumed, step, session, run (the tip), from (the run that handed off), text, short } | null; see above */
export function handoffOf(r, items, { talked = () => true, wrote = () => false, now = Date.now(), waitMs = HANDOFF_WAIT_MS } = {}) {
  if (!r || r.kind !== 'run') return null;
  let tip = r;
  for (const seen = new Set([r.id]); tip.end?.outcome === 'handoff' && items[tip.resume?.next] && !seen.has(tip.resume.next);) { tip = items[tip.resume.next]; seen.add(tip.id); }
  const out = (phase, step, session, from) => { const h = { phase, step, session, run: tip.id, from }; return { ...h, text: handoffWords(h), short: handoffWords(h, true) }; };
  if (tip.state === 'running' && wrote(tip.id)) return out('pending', 'closing', sessionOf(tip) + 1, tip.id);
  if (tip.state === 'exited' && tip.end?.outcome === 'handoff' && !tip.resume && now - Date.parse(tip.updated) <= waitMs) return out('pending', 'ending', sessionOf(tip) + 1, tip.id);
  if (!handoffResume(tip, items)) return null;
  const from = tip.data.resume_of;
  if (['queued', 'claimed'].includes(tip.state)) return out('pending', 'queued', sessionOf(tip), from);
  if (tip.state !== 'running') return null;
  return talked(tip.id) ? out('resumed', null, sessionOf(tip), from) : out('pending', 'starting', sessionOf(tip), from);
}

// RM-19 S1: the Lanes page shows what is live first - running, then needs you (parked, stopped, lost, a hand-off with no resume ...),
// then queued, then done, then archived; newest first in each group (row.at). Done = the lane record is done or the latest run
// exited DONE; an old done lane (ended over oldDays ago) is faded and reads stopped.
export const LANE_GROUPS = ['running', 'needs', 'queued', 'done', 'archived'];
function laneGroup(l, r, shipped) {
  if (l.state === 'archived') return 'archived';
  if (shipped && r?.state !== 'running' && r?.state !== 'queued' && r?.state !== 'claimed') return 'done';   // its work is on main: off the active list
  if (l.state === 'parked') return 'needs';   // parked = waiting on the owner, whatever its last run said
  if (r?.state === 'running') return 'running';
  if (r?.state === 'queued' || r?.state === 'claimed' || (!r && l.state === 'active')) return 'queued';
  if (l.state === 'done' || (r?.state === 'exited' && r.end?.outcome === 'done')) return 'done';
  return 'needs';
}
export const sortLanes = rows => rows.sort((a, b) => LANE_GROUPS.indexOf(a.group) - LANE_GROUPS.indexOf(b.group) || String(b.at ?? '').localeCompare(String(a.at ?? '')));

/**
 * Lanes view: LANE records active | parked (all states with all), in sortLanes order. Each row: { name, id, state, data, run,
 * executor, text, handoff, group, created, ended, at, old, rule, path }.
 * o: { all, now, hbAge (runId, run) -> ms since the last heartbeat, hbLate (runId, run, { age, cpu }) -> runs.hbLate's evidence when a stale one is only late,
 *   staleMs, cpu (the last sweep's CPU %: runs.mjs sweptCpu, or null), oldDays (policy.done_lanes.old_days),
 *   talked / wrote (handoffOf's hooks: the row's `handoff`), idleH / archiveDays / landed / merged (lifecycle.mjs laneRules: the row's
 *   `rule` { rule, act, at, text } = which rule acts on it and when; landed / merged default to the rulings: the tick's git answer
 *   comes in from lane-rules.json), path (lane, now) -> the row's `path` { state, text, red, ... } = its path to main (lane-paths.json) }.
 * A lane idle by its rule reads "idle: no run" and sits under needs you, not queued.
 * OVERVIEW-TRUTH (5): the row's run is the lane's newest MEANINGFUL run - queue bookkeeping (a run withdrawn before it started, a queue
 * entry filled into a run) never stands for the lane, so an old 'lost' or a withdrawn MERGE does not colour it; a newer withdrawn run is
 * named after it ("withdrawn: <why>"). shipped (lane) -> why | null (laneHooks: its deliverables merged, its path merged, a landed
 * ruling on its run or its newest one): the lane reads "shipped: <why>" and leaves the active list (group done), whatever its last run says - a live run still shows.
 */
export function lanesView(st, { all = false, now = Date.now(), hbAge = null, hbLate = null, staleMs = STALE_MS, cpu = null, oldDays = 2, talked, wrote,
  idleH = IDLE_H, archiveDays = ARCHIVE_DAYS, landed = (_, r) => !!r.landed, merged = (_, r) => !!r.landed, path = () => null, shipped = () => null, home = null } = {}) {
  const rules = new Map(laneRules(st, { now, idleH, archiveDays, landed, merged, home }).map(x => [x.lane, { rule: x.rule, act: x.act, at: x.at, text: x.text }]));
  const items = Object.values(st.items);
  const strips = stripsOf(items, now), asks = asksOf(items);
  const latest = {}, newest = {}, newer = (m, r) => !m[r.data.lane] || runNum(r.id) > runNum(m[r.data.lane].id);
  for (const r of items) if (r.kind === 'run' && r.data?.lane) {
    if (newer(newest, r)) newest[r.data.lane] = r;
    if (!BOOKKEEPING.includes(r.state) && newer(latest, r)) latest[r.data.lane] = r;
  }
  return sortLanes(items.filter(l => l.kind === 'lane' && (all || l.state === 'active' || l.state === 'parked')).map(l => {
    const name = laneNameIn(l.id, home), w = newest[name], r = latest[name] ?? (w?.state === 'withdrawn' ? w : null), ship = l.state !== 'archived' ? shipped(name, r, w) : null;
    const tail = w && w !== r && w.state === 'withdrawn' ? ` · then ${w.id} ${runText(w, { now })}` : '';
    const park = l.state === 'parked' ? [...l.history].reverse().find(h => h.ev === 'park')?.data || {} : null;
    // item 8 (MAIL-9): parked on a question the owner answered = the owner's part is done; it waits for a check-in to apply the ruling
    const ruled = park?.q && st.items[park.q]?.state === 'answered' ? st.items[park.q] : null;
    // ... and once a check-in applied it (the lane unparked by that apply), the lane says who applied it and what it did until its next run
    const unpark = !park && l.state === 'active' ? l.history.findLast(h => h.ev === 'unpark' && h.data?.q) : null, aq = unpark ? st.items[unpark.data.q] : null;
    const ap = aq?.state === 'applied' && (!r || r.created < unpark.ts) ? aq.history.findLast(h => h.ev === 'apply') : null;
    const text = ap ? `Applied by ${ap.run ?? ap.by}: your ruling on ${aq.id} (${aq.answer?.choice ?? aq.answer?.text ?? '?'}) -> ${(ap.data?.refs || []).join(', ') || 'no refs'}`
      : ruled ? `waiting: your ruling is being applied (you ruled: ${ruled.answer?.choice ?? ruled.answer?.text ?? '?'}, ${ruled.updated}; the next check-in applies ${ruled.id})`
      : park ? (park.q ? `parked by ${park.q}` : `parked: ${park.why ?? ''}`.trimEnd())
      : ship && !['running', 'queued', 'claimed'].includes(r?.state) ? `shipped: ${ship}`
      : r ? runText(r, { now, hbAge, hbLate, staleMs, cpu, items: st.items }) + tail : rules.get(name)?.rule === 'idle' ? rules.get(name).text : 'no runs';
    const group = ruled ? 'queued' : ship ? laneGroup(l, r, ship) : rules.get(name)?.rule === 'idle' ? 'needs' : laneGroup(l, r), ended = r?.history.findLast(h => h.ev === 'end')?.ts ?? l.history.findLast(h => h.ev === 'done')?.ts ?? null;
    const at = group === 'running' || group === 'queued' ? r?.created ?? l.created : group === 'done' ? ended ?? l.updated : l.updated;
    const old = group === 'done' && !!ended && now - Date.parse(ended) > oldDays * 864e5;
    return { name, id: l.id, state: l.state, data: l.data, run: r?.id ?? null, run_name: r ? runName(r) : null, executor: r?.data.executor ?? null, run_state: r?.state ?? null, text,
      handoff: park || !r ? null : handoffOf(r, st.items, { talked, wrote, now }),       group, created: l.created, ended, at, old, rule: rules.get(name) ?? null, path: path(name, now),
      outcome: r?.end?.outcome ?? null, ruled: !!ruled, started: r?.created ?? null, budget_min: r?.data.budget_min ?? null, runs: (strips[name] ?? []).slice(-STRIP),
      runs_total: strips[name]?.length ?? 0, ask: park?.q && st.items[park.q]?.state === 'open' ? park.q : asks[name] ?? null,
      waits: ['queued', 'claimed'].includes(r?.state) ? (r.data.after || []).filter(c => c.kind === 'run').map(c => c.id) : [] };
  }));
}

// ---------- Stage LANES (SPEC 4.2): the attention board - the Map's lane band folded into each row, and the board groups ----------
// The run strip: a lane's runs oldest first (the way mapGraph folds lanesOf + resume_of + helpersOf), bookkeeping runs left out; a bead
// joins its predecessor (cont) when it is that run's hand-off resume - a gap is a fresh start. The row keeps the last STRIP.
export const STRIP = 6;
function stripsOf(items, now) {
  const helpers = {}, by = {};
  for (const r of items) if (r.kind === 'run') { if (r.data?.role === 'helper') helpers[r.data.parent] = (helpers[r.data.parent] ?? 0) + 1;
    else if (r.data?.lane && !BOOKKEEPING.includes(r.state)) (by[r.data.lane] ??= []).push(r); }
  return Object.fromEntries(Object.entries(by).map(([lane, rs]) => [lane, rs.sort((a, b) => runNum(a.id) - runNum(b.id)).map((r, i) => {
    const [cls, word] = ['queued', 'claimed'].includes(r.state) ? ['idle', 'queued'] : runWord(r), e = r.history.findLast(h => h.ev === 'end')?.ts;
    return { id: r.id, name: runName(r), cls, word, min: Math.max(0, Math.round(((e ? Date.parse(e) : now) - Date.parse(r.created)) / 60000)),
      cont: !!r.data.resume_of && r.data.resume_of === rs[i - 1]?.id, helpers: helpers[r.id] ?? 0 }; })]));
}
// a lane's open question (the strip's "!" bead): the newest open question that names the lane
const asksOf = items => { const o = {}; for (const q of items) if (q.kind === 'question' && q.state === 'open' && q.data?.lane && (!o[q.data.lane] || runNum(q.id) > runNum(o[q.data.lane]))) o[q.data.lane] = q.id; return o; };
/** the PR track of a lane: its newest deliverable (deliverablesView rows) -> { step: done | pr | merged | installed, pr, url } | null */
export function prStep(rows) {
  const r = [...(rows || [])].sort((a, b) => runNum(b.id) - runNum(a.id))[0]; if (!r) return null;
  const step = ['merged', 'installed'].includes(r.state) ? r.state : r.pr ? 'pr' : 'done';
  return { step, pr: r.merge_pr ?? r.pr?.number ?? null, url: /^https:\/\//.test(r.pr?.url ?? '') ? r.pr.url : null };
}
// The board groups, in page order (id, label). Needs you = an Inbox row names the lane (the server's `needs`, terms.mjs isNeed: never
// counted here); Stopped = the last run ended without DONE in the last OLD_DAYS and nothing asks the owner; Old = that, longer ago
// (SPEC Q6), or done before today; To land = done with its deliverable not on main yet.
export const BOARD = [['needs', 'Needs you'], ['running', 'Running'], ['stopped', 'Stopped'], ['waiting', 'Waiting'], ['land', 'To land'],
  ['parked', 'Parked'], ['today', 'Done today'], ['old', 'Old'], ['archived', 'Archived']];
export const OLD_DAYS = 7;
/** a lanesView row + its needs count -> its board group id */
export function boardOf(l, now = Date.now()) {
  if (l.state === 'archived') return 'archived';
  if (l.needs > 0) return 'needs';
  if (l.run_state === 'running') return 'running';
  if (['queued', 'claimed'].includes(l.run_state) || (l.group === 'queued' && !l.ruled)) return 'waiting';
  if (l.state === 'parked' || l.ruled) return 'parked';
  const age = l.ended ? now - Date.parse(l.ended) : Infinity;
  if (l.group === 'done' || l.outcome === 'done') return ['done', 'pr'].includes(l.dlv?.step) ? 'land' : age < 864e5 ? 'today' : 'old';
  return age <= OLD_DAYS * 864e5 ? 'stopped' : 'old';
}
