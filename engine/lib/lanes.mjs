// Truthful lanes (META-GENERAL-DESIGN 5, 12-S6): the lane list is LANE records only (no folder scan); a lane's state (laneState, RM-21 S1)
// comes from its runs, any executor, the fill walk's row of its queued run and its deliverables. Pure over a loadState() fold;
// heartbeat age, the walk rows and the deliverable rows come from the caller.
import { STALE_MS } from './runs.mjs';
import { runName } from './names.mjs';
import { loginCommand } from './authguard.mjs';
import { isMergeStage } from './usageguard.mjs';
import { firstReason } from './waitwords.mjs';
import { laneRules, IDLE_H, ARCHIVE_DAYS } from './lifecycle.mjs';
import { idNum as runNum, laneNameIn } from './records.mjs';

// ---------- RM-21 S1 (CAPACITY-UX 4.4): a lane has one of six states, each with one reason (`why`), and every page reads it ----------
//   running   a worker is alive now (fresh heartbeat)            why: executor model effort, minutes, budget
//   waiting   its next run is queued, or its finished work waits to merge   why: the first reason of the fill walk row (waitwords.mjs)
//   parked    the lane waits for the owner                       why: the question's id AND text
//   stopped   the last run ended without finishing and nothing is queued; includes a run with no heartbeat (not responding)
//   shipped   no run is running or queued, and the lane's newest work run (or a later run) carries a `landed` record, or the lane's
//             newest deliverable is merged
//   idle      nothing ran, or the last run is done and nothing follows
export const LANE_STATES = ['running', 'waiting', 'parked', 'stopped', 'shipped', 'idle'];
const minsAgo = (ms, now) => Math.max(0, Math.round((now - ms) / 60000));
const isLanded = r => (r.history || []).some(h => h.ev === 'landed');
const dlvNum = d => Number(String(d.id).slice(4)) || 0;

/**
 * laneState(lane: the LANE fold item, run: its latest run (or null), ctx) -> { state, why }.
 * ctx: { items (the fold's items), runs (the lane's runs, newest first; default: run alone), now, hbAge (runId, run) -> ms, staleMs,
 *   walk (Map run id -> its fill walk row, runs.readiness), deliverables (the lane's deliverable rows), talked / wrote (handoffOf's hooks),
 *   label (run id -> name, the reason's words) }
 */
export function laneState(lane, run, { items = {}, runs = run ? [run] : [], now = Date.now(), hbAge = null, staleMs = STALE_MS, walk = new Map(), deliverables = [], talked, wrote,
  label = id => (items[id] ? runName(items[id]) ?? id : id) } = {}) {
  const S = (state, why) => ({ state, why });
  if (lane?.state === 'parked') {
    const park = [...lane.history].reverse().find(h => h.ev === 'park')?.data || {}, q = park.q ? items[park.q] : null;
    // item 8 (MAIL-9): parked on a question the owner answered = the owner's part is done; it waits for a check-in to apply the ruling
    if (q?.state === 'answered') return S('waiting', `your ruling is being applied (you ruled: ${q.answer?.choice ?? q.answer?.text ?? '?'}, ${q.updated}; the next check-in applies ${q.id})`);
    return S('parked', park.q ? `${park.q} needs your answer${q?.data?.title ? `: ${q.data.title}` : ''}` : park.why || 'parked by the controller');
  }
  const live = runs.find(r => r.state === 'running');
  if (live) {
    const age = hbAge ? hbAge(live.id, live) : 0;
    if (age > staleMs) return S('stopped', Number.isFinite(age) ? `not responding, no heartbeat for ${minsAgo(now - age, now)} min` : 'not responding, no heartbeat');
    const d = live.data || {}, who = [d.executor, d.model, d.effort].filter(Boolean).join(' ');
    return S('running', `${who} for ${minsAgo(Date.parse(live.created), now)} min` + (d.budget_min ? ` / budget ${d.budget_min}` : ''));
  }
  const queued = [...runs].reverse().find(r => r.state === 'queued' || r.state === 'claimed');
  if (queued) {
    const why = firstReason(walk.get(queued.id), { label, now });
    if (why) return S('waiting', why.text + (why.more ? ` (+ ${why.more} more)` : ''));
    // no walk row yet (the walk runs in a child process): the one reason the records hold - a re-queue after a login exit
    const prev = items[queued.data?.requeue_of];
    if (prev?.end?.outcome === 'auth') return S('waiting', prev.end.auth_class === 'vendor' ? `held for a vendor outage (${prev.id} exited: auth); resumes by itself, no login needed`
      : `held for login (${prev.id} exited: auth); run ${loginCommand(queued.data.executor)}`);
    return S('waiting', `${queued.state === 'claimed' ? 'claimed by another machine' : 'in the queue'}; the fill has not checked it yet`);
  }
  // ... and once a check-in applied it (the lane unparked by that apply), the lane says who applied it and what it did until its next run
  const unpark = lane?.state === 'active' ? lane.history?.findLast(h => h.ev === 'unpark' && h.data?.q) : null, aq = unpark ? items[unpark.data.q] : null;
  const ap = aq?.state === 'applied' && (!run || run.created < unpark.ts) ? aq.history.findLast(h => h.ev === 'apply') : null;
  if (ap) return S('idle', `Applied by ${ap.run ?? ap.by}: your ruling on ${aq.id} (${aq.answer?.choice ?? aq.answer?.text ?? '?'}) -> ${(ap.data?.refs || []).join(', ') || 'no refs'}`);
  if (!run) return S('idle', 'no run yet');
  const ho = handoffOf(run, items, { talked, wrote, now });
  if (ho?.phase === 'pending') return S('waiting', ho.text);
  // shipped: the newest work run (not a MERGE) or a later run carries `landed`, or the newest deliverable is merged
  const work = runs.findIndex(r => !isMergeStage(r.data?.stage)), landed = runs.slice(0, work < 0 ? runs.length : work + 1).find(isLanded);
  const dlv = deliverables.filter(x => !x.superseded).sort((a, b) => dlvNum(b) - dlvNum(a))[0] ?? null;
  if (landed) return S('shipped', `${landed.id} landed on main${landed.history.findLast(h => h.ev === 'landed')?.data?.why ? ` (${landed.history.findLast(h => h.ev === 'landed').data.why})` : ''}`);
  if (dlv && dlv.state !== 'done') return S('shipped', `${dlv.id} is on main${dlv.pr?.number ? ` (PR #${dlv.pr.number})` : ''}`);
  const d = run.data || {}, end = run.end || {};
  if (run.state === 'lost') return S('stopped', `not responding${run.lost?.why ? `: ${run.lost.why}` : ''}`);
  if (run.state === 'killed') return S('stopped', `killed${run.kill?.why ? `: ${run.kill.why}` : ''}`);
  if (run.state === 'withdrawn') return S('stopped', `withdrawn${run.withdraw?.why ? `: ${run.withdraw.why}` : ''}`);
  if (run.resume?.refused) return S('stopped', `handed off; the auto-resume was refused (${run.resume.refused})`);
  const o = end.outcome;
  if (o === 'done') return dlv?.state === 'done' ? S('waiting', `finished; ${dlv.id} waits to merge`) : S('idle', `${run.id} done; nothing follows`);
  if (o === 'stopped') return S('stopped', end.why || `${run.id} stopped without a why`);
  if (o === 'handoff') return run.resume?.next ? S('idle', `handed off to ${run.resume.next}`) : S('stopped', 'handed off; no resume follows');
  if (o === 'nudged') return S('stopped', 'stopped by a nudge');
  if (o === 'crash') return S('stopped', `crashed (exit ${end.exit ?? '?'})`);
  if (o === 'limit') return S('stopped', `out of quota${end.reset ? ` until ${end.reset}` : ''}`);
  if (o === 'auth') return S('stopped', end.auth_class === 'vendor' ? 'a vendor outage (no login needed)' : `login down - run ${loginCommand(d.executor)}`);
  return S('stopped', `${run.id} ended with no result${end.why ? `: ${end.why}` : ''}`);
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
  : `${short ? 'hand-off:' : 'hand-off in progress -'} session ${h.session} ${h.step === 'closing' ? (short ? 'next' : 'next (the last session is closing)') : h.step === 'queued' ? 'waiting' : 'starting'}`);   // RM-21 S1: a queued run reads waiting
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

// RM-19 S1: the Lanes page shows what is live first - running, then needs you (parked, stopped), then queued (waiting), then done
// (shipped, idle after a DONE run, finished work waiting to merge), then archived; newest first in each group (row.at). The group
// follows the lane's state (laneState); an old done lane (ended over oldDays ago) is faded.
export const LANE_GROUPS = ['running', 'needs', 'queued', 'done', 'archived'];
function laneGroup(l, status, r) {
  if (l.state === 'archived') return 'archived';
  const doneRun = r?.state === 'exited' && r.end?.outcome === 'done';
  return { running: 'running', parked: 'needs', stopped: 'needs', shipped: 'done',   // a parked lane waiting = its ruling is being applied (queued)
    waiting: doneRun && l.state !== 'parked' ? 'done' : 'queued', idle: l.state === 'done' || doneRun ? 'done' : r ? 'needs' : 'queued' }[status.state];
}
export const sortLanes = rows => rows.sort((a, b) => LANE_GROUPS.indexOf(a.group) - LANE_GROUPS.indexOf(b.group) || String(b.at ?? '').localeCompare(String(a.at ?? '')));

/**
 * Lanes view: LANE records active | parked (all states with all), in sortLanes order. Each row: { name, id, state, data, run,
 * executor, status (laneState: { state, why }), handoff, group, created, ended, at, old, rule, path }.
 * o: { all, now, hbAge (runId, run) -> ms since the last heartbeat, staleMs, oldDays (policy.done_lanes.old_days),
 *   talked / wrote (handoffOf's hooks: the row's `handoff`), walk (Map run id -> fill walk row), deliverables (deliverable rows, any lane),
 *   idleH / archiveDays / landed / merged (lifecycle.mjs laneRules: the row's `rule` { rule, act, at, text } = which rule acts on it and
 *   when; landed / merged default to the rulings: the tick's git answer comes in from lane-rules.json), path (lane, now) -> the row's
 *   `path` { state, text, red, ... } = its path to main (lane-paths.json), home (the state dir's home id: lane ids L:<home>/<name>) }.
 * A lane idle by its rule sits under needs you, not queued; with no run its why is the rule's ("idle: no run").
 */
export function lanesView(st, { all = false, now = Date.now(), hbAge = null, staleMs = STALE_MS, oldDays = 2, talked, wrote, walk = new Map(), deliverables = [],
  idleH = IDLE_H, archiveDays = ARCHIVE_DAYS, landed = (_, r) => !!r.landed, merged = (_, r) => !!r.landed, path = () => null, home = null } = {}) {
  const rules = new Map(laneRules(st, { now, idleH, archiveDays, landed, merged, home }).map(x => [x.lane, { rule: x.rule, act: x.act, at: x.at, text: x.text }]));
  const items = Object.values(st.items);
  const runsOf = {};
  for (const r of items) if (r.kind === 'run' && r.data?.lane) (runsOf[r.data.lane] ??= []).push(r);
  for (const rs of Object.values(runsOf)) rs.sort((a, b) => runNum(b.id) - runNum(a.id));
  return sortLanes(items.filter(l => l.kind === 'lane' && (all || l.state === 'active' || l.state === 'parked')).map(l => {
    const name = laneNameIn(l.id, home), runs = runsOf[name] || [], r = runs[0], rule = rules.get(name) ?? null, idleRule = rule?.rule === 'idle';
    const park = l.state === 'parked';
    const st0 = laneState(l, r ?? null, { items: st.items, runs, now, hbAge, staleMs, walk, deliverables: deliverables.filter(d => d.lane === name), talked, wrote });
    const status = idleRule && !r && st0.state === 'idle' ? { state: 'idle', why: rule.text } : st0;
    const group = idleRule && status.state !== 'waiting' ? 'needs' : laneGroup(l, status, r), ended = r?.history.findLast(h => h.ev === 'end')?.ts ?? l.history.findLast(h => h.ev === 'done')?.ts ?? null;
    const at = group === 'running' || group === 'queued' ? r?.created ?? l.created : group === 'done' ? ended ?? l.updated : l.updated;
    const old = group === 'done' && !!ended && now - Date.parse(ended) > oldDays * 864e5;
    return { name, id: l.id, state: l.state, data: l.data, run: r?.id ?? null, run_name: r ? runName(r) : null, executor: r?.data.executor ?? null, run_state: r?.state ?? null, status,
      handoff: park || !r ? null : handoffOf(r, st.items, { talked, wrote, now }),       group, created: l.created, ended, at, old, rule, path: path(name, now) };
  }));
}
