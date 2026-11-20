// Truthful lanes (META-GENERAL-DESIGN 5, 12-S6): the lane list is LANE records only (no folder scan); a lane's state text is its
// latest RUN on that lane, any executor. Pure over a loadState() fold; heartbeat age comes from the caller.
import { STALE_MS, queueOf, DEFAULT_PRIORITY } from './runs.mjs';
import { runName } from './names.mjs';
import { loginCommand } from './authguard.mjs';
import { isMergeStage } from './usageguard.mjs';
import { laneRules, IDLE_H, ARCHIVE_DAYS } from './lifecycle.mjs';
import { idNum as runNum, laneNameIn } from './records.mjs';


// fair-slots item 2: where a lane's finished work is on its way to main (the Lanes table and the Plan say the same words). awaiting-merge
// = its last build run exited DONE and its MERGE run waits in the queue; awaiting-pr = merge-land opened the PR (the deliverable's `pr`
// event, while the branch is not on main yet) and no run of the lane is live: the owner approves it.
export const LAND_WORDS = { 'awaiting-merge': 'done - awaiting merge', 'awaiting-pr': 'awaiting PR approval' };
const doneRun = r => r?.state === 'exited' && r.end?.outcome === 'done';
/** r = the lane's latest run, build = its latest non-MERGE run, pr = its open PR or null -> 'awaiting-merge' | 'awaiting-pr' | null */
export function landState(r, build, pr) {
  if (!r) return null;
  if (isMergeStage(r.data?.stage) && ['queued', 'claimed'].includes(r.state)) return doneRun(build) ? 'awaiting-merge' : null;
  return pr && doneRun(r) ? 'awaiting-pr' : null;
}
// fair-slots item 3: the priority of a queued or running run (data.priority; none = the fill's default P2, said so)
export const priorityOf = r => ['queued', 'claimed', 'running'].includes(r?.state) ? (r.data?.priority ? { p: r.data.priority, dflt: false } : { p: DEFAULT_PRIORITY, dflt: true }) : null;

function runText(r, { now, hbAge, staleMs, items = {} }) {
  const d = r.data || {}, end = r.end || {};
  // OOTB-R2 N-5: a queued run is queued (it has no end), and one re-queued after an auth exit says it waits for the login
  if (r.state === 'queued' || r.state === 'claimed') {
    const prev = items[d.requeue_of];
    if (prev?.end?.outcome === 'auth' && prev.end.auth_class === 'vendor') return `queued: held for a vendor outage (${prev.id} exited: auth) - resumes by itself, no login needed`;
    return prev?.end?.outcome === 'auth' ? `queued: held for login (${prev.id} exited: auth) - run ${loginCommand(d.executor)}` : r.state;
  }
  if (r.state === 'running') {
    if (hbAge && hbAge(r.id, r) > staleMs) return 'lost';
    const min = Math.max(0, Math.round((now - Date.parse(r.created)) / 60000));
    const who = [d.executor, d.model, d.effort].filter(Boolean).join(' ');
    return `running ${who} for ${min} min` + (d.budget_min ? ` / budget ${d.budget_min}` : '');
  }
  if (r.state === 'lost') return 'lost';
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
function laneGroup(l, r, land) {
  if (l.state === 'archived') return 'archived';
  if (l.state === 'parked' || land === 'awaiting-pr') return 'needs';   // parked / a PR to approve = waiting on the owner, whatever its last run said
  if (r?.state === 'running') return 'running';
  if (r?.state === 'queued' || r?.state === 'claimed' || (!r && l.state === 'active')) return 'queued';
  if (l.state === 'done' || (r?.state === 'exited' && r.end?.outcome === 'done')) return 'done';
  return 'needs';
}
export const sortLanes = rows => rows.sort((a, b) => LANE_GROUPS.indexOf(a.group) - LANE_GROUPS.indexOf(b.group) || String(b.at ?? '').localeCompare(String(a.at ?? '')));

/**
 * Lanes view: LANE records active | parked (all states with all), in sortLanes order. Each row: { name, id, state, data, run,
 * executor, text, handoff, group, created, ended, at, old, rule, path, land, pr, priority, position }: land = landState ('awaiting-merge' |
 * 'awaiting-pr' | null), pr = the lane's open PR ({ url, number }), priority = priorityOf the latest run, position = its place in
 * the fill order (queueOf) while it is queued.
 * o: { all, now, hbAge (runId, run) -> ms since the last heartbeat, staleMs, oldDays (policy.done_lanes.old_days),
 *   talked / wrote (handoffOf's hooks: the row's `handoff`), prs ({ lane: { url, number } }: the PRs merge-land opened, not merged yet),
 *   idleH / archiveDays / landed / merged (lifecycle.mjs laneRules: the row's
 *   `rule` { rule, act, at, text } = which rule acts on it and when; landed / merged default to the rulings: the tick's git answer
 *   comes in from lane-rules.json), path (lane, now) -> the row's `path` { state, text, red, ... } = its path to main (lane-paths.json) }.
 * A lane idle by its rule reads "idle: no run" and sits under needs you, not queued.
 */
export function lanesView(st, { all = false, now = Date.now(), hbAge = null, staleMs = STALE_MS, oldDays = 2, talked, wrote, prs = {},
  idleH = IDLE_H, archiveDays = ARCHIVE_DAYS, landed = (_, r) => !!r.landed, merged = (_, r) => !!r.landed, path = () => null, home = null } = {}) {
  const rules = new Map(laneRules(st, { now, idleH, archiveDays, landed, merged, home }).map(x => [x.lane, { rule: x.rule, act: x.act, at: x.at, text: x.text }]));
  const items = Object.values(st.items);
  const latest = {}, build = {}, newer = (m, k, r) => { if (!m[k] || runNum(r.id) > runNum(m[k].id)) m[k] = r; };
  for (const r of items) if (r.kind === 'run' && r.data?.lane) { newer(latest, r.data.lane, r); if (!isMergeStage(r.data.stage)) newer(build, r.data.lane, r); }
  const pos = Object.fromEntries(queueOf(items).map(q => [q.id, q.position]));
  return sortLanes(items.filter(l => l.kind === 'lane' && (all || l.state === 'active' || l.state === 'parked')).map(l => {
    const name = laneNameIn(l.id, home), r = latest[name], pr = prs[name] ?? null, land = l.state === 'parked' ? null : landState(r, build[name], pr);
    const park = l.state === 'parked' ? [...l.history].reverse().find(h => h.ev === 'park')?.data || {} : null;
    // item 8 (MAIL-9): parked on a question the owner answered = the owner's part is done; it waits for a check-in to apply the ruling
    const ruled = park?.q && st.items[park.q]?.state === 'answered' ? st.items[park.q] : null;
    // ... and once a check-in applied it (the lane unparked by that apply), the lane says who applied it and what it did until its next run
    const unpark = !park && l.state === 'active' ? l.history.findLast(h => h.ev === 'unpark' && h.data?.q) : null, aq = unpark ? st.items[unpark.data.q] : null;
    const ap = aq?.state === 'applied' && (!r || r.created < unpark.ts) ? aq.history.findLast(h => h.ev === 'apply') : null;
    const rt = r ? runText(r, { now, hbAge, staleMs, items: st.items }) : rules.get(name)?.rule === 'idle' ? rules.get(name).text : 'no runs';
    const text = ap ? `Applied by ${ap.run ?? ap.by}: your ruling on ${aq.id} (${aq.answer?.choice ?? aq.answer?.text ?? '?'}) -> ${(ap.data?.refs || []).join(', ') || 'no refs'}`
      : ruled ? `waiting: your ruling is being applied (you ruled: ${ruled.answer?.choice ?? ruled.answer?.text ?? '?'}, ${ruled.updated}; the next check-in applies ${ruled.id})`
      : park ? (park.q ? `parked by ${park.q}` : `parked: ${park.why ?? ''}`.trimEnd())
      : land === 'awaiting-merge' ? `${LAND_WORDS[land]}${rt.startsWith('queued: ') ? ` - ${rt.slice(8)}` : ''}`
      : land === 'awaiting-pr' ? `${LAND_WORDS[land]}: PR #${pr.number ?? '?'}` : rt;
    const group = ruled ? 'queued' : rules.get(name)?.rule === 'idle' ? 'needs' : laneGroup(l, r, land), ended = r?.history.findLast(h => h.ev === 'end')?.ts ?? l.history.findLast(h => h.ev === 'done')?.ts ?? null;
    const at = group === 'running' || group === 'queued' ? r?.created ?? l.created : group === 'done' ? ended ?? l.updated : l.updated;
    const old = group === 'done' && !!ended && now - Date.parse(ended) > oldDays * 864e5;
    return { name, id: l.id, state: l.state, data: l.data, run: r?.id ?? null, run_name: r ? runName(r) : null, executor: r?.data.executor ?? null, run_state: r?.state ?? null, text,
      handoff: park || !r ? null : handoffOf(r, st.items, { talked, wrote, now }),       group, created: l.created, ended, at, old, rule: rules.get(name) ?? null, path: path(name, now),
      land, pr: land === 'awaiting-pr' ? pr : null, priority: priorityOf(r), position: pos[r?.id] ?? null };
  }));
}
