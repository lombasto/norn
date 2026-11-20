// The Runs page (stage RUNS, SPEC 4.3 "the list beside the run"): the list on the left (a 4-number summary, the Live / Queued / Ended
// bands by attention, the filters in one bar), the picked run's document on the right (&run=RUN-n; none = the most urgent run). Under
// ~1100 px the list and the run are two screens (ctx.narrow), Back returns to the list. The live feed mounts into the document's slot
// (pages/runs-feed.mjs). The view lives in the URL (index.html: S.runsView, runsViewOf / runsViewQs).
import { esc, fin, dash, int, mTok, fmtMin, aname, chip, exChip, projTag, homeChip, ctxMeter, pauseAct, speedLine, laneCard, guardOn, guardChip } from '../cells.mjs';
import { dodChips, critiqueChip, hoChip } from '../widgets.mjs';
import { LANE_SHOW } from './lanes.mjs';
import { dayClock } from './plan.mjs';

// RM-34: a run's lane (a link to its row on Lanes, every filter on so it shows) and the stage beside it; a check-in reads "check-in",
// a run with no lane (a talk session) a dash
const LANES_ALL = LANE_SHOW.map(([k]) => k).join(',');
export const runLane = n => n.kind === 'checkin' ? 'check-in' : !n.lane ? dash
  : `<a class="lanelink" data-rid="L:${esc(n.lane)}" href="?project=${encodeURIComponent(n.project ?? '')}&tab=lanes&lanes=${LANES_ALL}">${esc(n.lane)}</a>${n.stage ? ` · ${esc(n.stage)}` : ''}`;
export const RUNS_STATES = [['running', 'running'], ['queued', 'queued'], ['finished', 'finished'], ['failed', 'failed']];
export const RUNS_KINDS = [['worker', 'worker'], ['checkin', 'check-in'], ['helper', 'helper'], ['talk', 'talk']];
export const RUNS_WINDOWS = [['2h', '2 h'], ['12h', '12 h'], ['24h', '24 h'], ['today', 'all today']];   // the server's RUN_WINDOWS
const RUN_FAILED = ['crash', 'stopped', 'no-result', 'limit', 'auth'];   // an end outcome that did not finish the work
/** a tree root's (or a queue entry's) state: running / queued / failed (lost, killed or a failed outcome) / finished */
export const runStateOf = n => n.state === 'queued' ? 'queued' : n.state === 'running' || n.state === 'alive' ? 'running'
  : n.state === 'lost' || n.state === 'killed' || RUN_FAILED.includes(n.outcome) ? 'failed' : 'finished';
/** its kind: a helper (norn delegate), a check-in, a talk session (an interactive run too), else a worker (any executor) */
export const runKindOf = n => n.kind === 'helper' || n.role === 'helper' ? 'helper' : n.kind === 'checkin' ? 'checkin' : n.kind === 'talk' || n.kind === 'interactive' ? 'talk' : 'worker';
const isoMs = x => { const v = Date.parse(x ?? ''); return Number.isFinite(v) ? v : null; };
/**
 * A node's times in minutes: ran = start to end (start to now while running), ended = now minus its end (null while running),
 * queued = now minus its queue time (queue entries only). An ended node with no end time has no ran either.
 */
export function runTimes(n, now) {
  if (n.state === 'queued') { const q = isoMs(n.queued); return { ran_min: null, ended_min: null, queued_min: q === null ? null : Math.max(0, (now - q) / 60000) }; }
  const live = runStateOf(n) === 'running', s = isoMs(n.started ?? n.first), e = live ? null : isoMs(n.ended ?? n.last);
  return { ran_min: s === null || (!live && e === null) ? null : Math.max(0, ((e ?? now) - s) / 60000), ended_min: e === null ? null : Math.max(0, (now - e) / 60000), queued_min: null };
}
// attention inside the Live band: a stalled run first, then a slow one, then the rest (the run's pace, progress.mjs)
const paceOf = n => n.progress?.pace?.state ?? null;
const URGENT = { stalled: 0, slow: 1 };
/** the order: live (stalled, slow, the rest; newest start first in each), then queued (longest waiting first: the fill order), then ended (latest end first) */
export function runsOrder(roots) {
  const g = n => ({ running: 0, queued: 1 })[runStateOf(n)] ?? 2, t = x => isoMs(x) ?? 0, u = n => g(n) === 0 ? URGENT[paceOf(n)] ?? 2 : 0;
  const key = n => g(n) === 0 ? -t(n.started ?? n.first) : g(n) === 1 ? t(n.queued) : -t(n.ended ?? n.last ?? n.started);
  return [...roots].sort((a, b) => g(a) - g(b) || u(a) - u(b) || key(a) - key(b));
}
const RUN_ID = /^RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+$/;
const feedable = n => RUN_ID.test(n.id) && n.state !== 'queued' && !n.readonly;
/** the run the page opens with no &run=: the most urgent live run, else the latest ended one (RUN- ids only), else null */
export function runsPick(roots) {
  const o = runsOrder(roots.filter(feedable));
  return (o.find(n => runStateOf(n) === 'running') ?? o.find(n => runStateOf(n) !== 'queued'))?.id ?? null;
}
const allOf = l => new Set(l.map(x => x[0]));
/** the page's view from the URL: &state= &kind= (a missing key = every chip on), &proj= (none = every project), &lane=, &window=;
 * open / help / ck = the Filters disclosure, the "?" legend and the folded check-ins (the page's own, never in the URL) */
export function runsViewOf(qs) {
  const set = (k, l) => { const v = qs.get(k); return v == null ? allOf(l) : new Set(v.split(',').filter(x => l.some(c => c[0] === x))); };
  return { state: set('state', RUNS_STATES), kind: set('kind', RUNS_KINDS), proj: new Set((qs.get('proj') ?? '').split(',').filter(Boolean)), lane: qs.get('lane') ?? '',
    window: RUNS_WINDOWS.some(w => w[0] === qs.get('window')) ? qs.get('window') : '2h', open: false, help: false, ck: false };
}
const full = (x, l) => x.size === l.length && l.every(c => x.has(c[0]));
/** the view as URL params ('&state=running,queued...'): only what differs from the default, so a plain Runs link stays plain */
export function runsViewQs(v) {
  const p = [];
  if (!full(v.state, RUNS_STATES)) p.push(['state', [...v.state].join(',')]);
  if (!full(v.kind, RUNS_KINDS)) p.push(['kind', [...v.kind].join(',')]);
  if (v.proj.size) p.push(['proj', [...v.proj].join(',')]);
  if (v.lane) p.push(['lane', v.lane]);
  if (v.window !== '2h') p.push(['window', v.window]);
  return p.map(([k, x]) => `&${k}=${encodeURIComponent(x)}`).join('');
}
/** the roots the view shows (children travel with their root) */
export const runsFilter = (roots, v) => roots.filter(n => v.state.has(runStateOf(n)) && v.kind.has(runKindOf(n)) && (!v.proj.size || v.proj.has(n.project))
  && (!v.lane || String(n.lane ?? '').toLowerCase().includes(v.lane.toLowerCase())));
const queueNode = q => ({ id: q.id, name: q.name, kind: q.kind, role: q.role, state: 'queued', lane: q.lane, stage: q.stage, executor: q.executor, model: q.model, effort: q.effort, queued: q.queued, project: q.project, children: [] });

// ---------- the cells of a row and of the document ----------
// A-05c: one shape, one meaning - "on track" is a word on a neutral chip, never the done check; testing reads as work in progress
const PACE = { stalled: 'bad', slow: 'warn', testing: 'running', 'on track': 'idle' };
const paceChip = n => paceOf(n) ? chip(PACE[paceOf(n)] ?? 'idle', paceOf(n)) : '';
/** an ended run's outcome chip: lost / killed by its state, else its end outcome */
const OUTCOME = { done: ['done', 'done'], handoff: ['handoff', 'hand-off'], stopped: ['stopped', 'stopped'], 'no-result': ['no-result', 'no result'], crash: ['bad', 'crash'], limit: ['bad', 'limit'], auth: ['bad', 'auth'] };
const outcomeOf = n => n.state === 'lost' ? ['lost', 'lost'] : n.state === 'killed' ? ['bad', 'killed'] : OUTCOME[n.outcome] ?? ['idle', n.outcome ?? n.state ?? 'ended'];
const stateChip = n => { const s = runStateOf(n); return s === 'running' ? chip('running', 'running') : s === 'queued' ? chip('idle', 'queued') : chip(...outcomeOf(n)); };
// the minutes a run ran (the pace's own count while live, else start to end) and its budget, in words: "1 h 40 / 1 h 30"
const ranMin = (n, now) => fin(n.progress?.pace?.elapsed_min) && runStateOf(n) === 'running' ? n.progress.pace.elapsed_min : runTimes(n, now).ran_min;
const rtime = (n, now) => { const b = n.progress?.pace?.budget_min; return `<span class="rtime">${fmtMin(ranMin(n, now))}${fin(b) ? ` / ${fmtMin(b)}` : ''}</span>`; };
/** time against the budget: the fill, the budget line and the median tick (the estimate of like runs), on one scale */
function timeBar(n, now, cls = '') {
  const p = n.progress?.pace, ran = ranMin(n, now), b = p?.budget_min, med = p?.estimate?.min;
  if (!fin(ran) || !fin(b)) return '';
  const top = Math.max(ran, b, fin(med) ? med : 0) || 1, at = x => (100 * x / top).toFixed(1), over = ran > b;
  return `<span class="tbar${over ? ' over' : ''} ${cls}" role="img" aria-label="${esc(`ran ${fmtMin(ran)} of a ${fmtMin(b)} budget${fin(med) ? `, like runs take ${fmtMin(med)}` : ''}`)}"><i style="width:${at(ran)}%"></i><u class="tb-budget" style="left:${at(b)}%"></u>${fin(med) ? `<u class="tb-med" style="left:${at(med)}%"></u>` : ''}</span>`;
}
/** the checklist as at most 5 segments + "n of m"; a worker whose brief has no checklist says so */
function items(n) {
  const g = n.progress;
  if (!fin(g?.total) || !g.total) return runKindOf(n) === 'worker' && runStateOf(n) !== 'queued' ? '<span class="ritems small mute">no checklist</span>' : '';
  const k = Math.min(5, g.total), done = Math.round(k * g.done / g.total);
  return `<span class="ritems small"><span class="segs" aria-hidden="true">${Array.from({ length: k }, (_, i) => `<i${i < done ? ' class="on"' : ''}></i>`).join('')}</span>${esc(`${g.done} of ${g.total}`)}</span>`;
}
// why it ended, in words: a lost heartbeat, who stopped it and why (the launcher is the default: not named), a hand-off and what came next
const stopWords = s => !s ? '' : s.ev === 'lost' ? `lost: ${s.why ?? 'no heartbeat'}` : [s.why, s.by && s.by !== 'launcher' ? `by ${s.by}` : null].filter(Boolean).join(' · ');
// RM-21 S1: a stopped or shipped run says why, from its run status (the server's laneState over the run)
const statusWhy = n => (n.status?.state === 'stopped' || n.status?.state === 'shipped' ? `${n.status.state}: ${n.status.why}` : '');
const whyEnded = n => [statusWhy(n) && `<span class="run-why">${esc(statusWhy(n))}</span>`, stopWords(n.stop) && `<span>${esc(stopWords(n.stop))}</span>`, n.handoff ? hoChip(n.handoff, n.id) : ''].filter(Boolean).join(' ');
// a live run's one line: why slow or stalled, else what it does now
const nowLine = n => { const g = n.progress, s = paceOf(n), why = (s === 'slow' || s === 'stalled') && (g?.slow?.line ?? g?.pace?.words);
  return why ? `<div class="rline small ${PACE[s]}">${esc(why)}</div>` : g?.line ? `<div class="rline small">${esc(g.line)}</div>` : ''; };
const guardChips = (n, d) => `${(n.guard || []).map(g => `<span class="guard-chip" title="${esc(`${g.id}: ${g.why}`)}">${chip(g.state === 'ruled' ? 'idle' : g.cls === 'runaway' ? 'bad' : 'warn', `${g.cls}${g.action ? ': ' + g.action : ''}`)}</span>`).join('')}${guardChip(guardOn(d.guard, r => r.run === n.id), { tab: 'slop' })}`;
const who = n => n.kind === 'talk' ? `<span class="id">${esc(n.id)}</span>` : `<span class="id">${esc(n.id)}</span>${aname(n.name)}${runKindOf(n) === 'helper' ? ' <span class="small mute">helper</span>' : ''}`;
const kids = n => (n.children || []).length ? `<span class="small mute">${(n.children || []).length} subagent${n.children.length === 1 ? '' : 's'}</span>` : '';

// ---------- the list ----------
function row(n, d, ctx, sel) {
  const now = ctx.now, s = runStateOf(n), band = s === 'running' ? 'live' : s === 'queued' ? 'queued' : 'ended';
  const at = feedable(n) ? ` data-feed="${esc(n.id)}" data-project="${esc(n.project)}" tabindex="0" title="Open ${esc(n.id)}"` : '';
  const head = `<div class="rhead">${stateChip(n)}<span class="rwho">${projTag(ctx, n.project)}${who(n)}</span>${band === 'live' ? paceChip(n) : ''}${homeChip(n)}${guardChips(n, d)}</div>`;
  const sub = `<div class="rmeta small"><span class="rlane">${laneCard(n.lane_card, runLane(n))}</span>${exChip(n.executor, n.model, n.effort)}${kids(n)}</div>`;
  let body = '';
  if (band === 'live') body = `<div class="rtimes small">${timeBar(n, now)}${rtime(n, now)}${items(n)}</div>${n.handoff ? `<div class="rline small rho">${hoChip(n.handoff, n.id)}</div>` : ''}${nowLine(n)}${speedLine(n.speed)}`;
  else if (band === 'ended') { const e = runTimes(n, now).ended_min;
    body = `<div class="rtimes small">${rtime(n, now)}${fin(e) ? `<span>ended ${fmtMin(e)} ago</span>` : ''}${items(n)}</div>${whyEnded(n) ? `<div class="rline small">${whyEnded(n)}</div>` : ''}`; }
  else body = queuedBody(n, d, ctx);
  return `<div class="rrow ${band}${sel ? ' sel' : ''}" id="node-${esc(n.id)}"${at}${sel ? ' aria-current="true"' : ''}>${head}${sub}${body}</div><!--/row-->`;
}
// a queued row: what it waits for (Plan's holds, in words), how long it has waited, its estimate and start, and Plan's priority control
function queuedBody(n, d, ctx) {
  const part = (d.plan?.parts || []).find(p => p.project === n.project) ?? (d.plan?.parts || [])[0], u = (part?.upnext || []).find(x => x.id === n.id), now = ctx.now;
  const at = x => (isoMs(x) === null ? null : dayClock(isoMs(x), now));
  const holds = (u?.holds || []).map((h, i) => (u.holdAt?.[i] ? `not before ${at(u.holdAt[i])}` : h));
  const start = u?.start ? (u.start.at && u.start.word !== 'now' ? `start ~${at(u.start.at)}` : `start ${u.start.word}`) : '';
  const prio = (part?.priorities || []).length && u ? `<select class="pl-prio" data-act="prio" data-project="${esc(n.project ?? part.project)}" data-run="${esc(n.id)}" aria-label="priority of ${esc(n.id)}" title="re-queue at this priority (its conditions are kept)">${part.priorities.map(x => `<option${x === (u.priority ?? 'P2') ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>` : '';
  const w = runTimes(n, now).queued_min;
  return `<div class="rtimes small">${fin(w) ? `<span>waited ${fmtMin(w)}</span>` : ''}${u?.estimate?.word ? `<span>${esc(u.estimate.word)}</span>` : ''}${start && !holds.includes(u.start.word) ? `<span>${esc(start)}</span>` : ''}${prio}</div>
    ${holds.length ? `<div class="rline small">${holds.map(esc).join(' · ')}</div>` : ''}`;
}
// check-ins (ended, more than one) collapse to one row: how many, the last one, how they went; "show them" opens them in place
function checkinFold(cks, ctx) {
  const e = runTimes(cks[0], ctx.now).ended_min, bad = cks.filter(n => runStateOf(n) === 'failed').length;
  return `<button class="rfold small" data-act="runs-checkins" aria-expanded="false">${cks.length} check-ins · last ${fmtMin(e)} ago · ${bad ? `${bad} failed` : 'all done'} · show them</button>`;
}
const bandHtml = (id, title, n, body) => `<section class="rband" id="runs-${id}" aria-label="${esc(title)}"><h3 class="small">${esc(title)} <span class="mute">${n}</span></h3>${body}</section>`;

// ---------- the run document ----------
function runDoc(n, d, ctx) {
  const now = ctx.now, s = runStateOf(n), live = s === 'running', g = n.progress, p = g?.pace, at = `data-project="${esc(n.project)}" data-run="${esc(n.id)}"`;
  const back = ctx.narrow ? `<button class="ghost" data-act="runs-back" data-run="${esc(n.id)}">‹ Runs</button>` : '';
  const follow = n.handoff?.run && n.handoff.run !== n.id ? `<button data-act="run-open" data-run="${esc(n.handoff.run)}">Follow ${esc(n.handoff.run)}</button>` : '';
  const acts = [live ? (n.pause ? pauseAct(n.pause, n.project, n.id) : `<button class="ghost" data-act="run-pause" ${at} title="Ask ${esc(n.id)} to stop at a clean point and hand off">Pause</button>`) : '',
    live && RUN_ID.test(n.id) ? `<button class="danger" data-act="stop" ${at} title="Stop ${esc(n.id)} now (asks first)">Stop</button>` : '',
    !live && n.pause ? pauseAct(n.pause, n.project, n.id) : '', follow,
    `<button class="ghost" data-act="run-link" data-run="${esc(n.id)}">Copy link</button>`].filter(Boolean).join('');
  const head = `<header class="rd-head">${back}<div class="rd-title"><h2>${projTag(ctx, n.project)}${who(n)}</h2>${stateChip(n)}${live ? paceChip(n) : ''}${homeChip(n)}${n.dod_ready || n.dod ? dodChips(n.dod_ready, n.dod) : ''}${critiqueChip(n.critique)}${guardChips(n, d)}</div>
    <div class="small rd-sub">${laneCard(n.lane_card, runLane(n))} · ${exChip(n.executor, n.model, n.effort)}</div><div class="rd-acts">${acts}</div></header>`;
  const alarms = (g?.alarms || []).map(a => `<div class="rd-alarm" role="alert">${chip(a.cls === 'runaway' ? 'bad' : 'warn', a.cls)} <b>${esc(a.words)}</b><div class="small mute">${esc(a.numbers ?? '')}</div><div class="small">${a.ruled ? `${esc(a.ruled)}. ` : ''}You can: ${esc((a.act || []).join(' / '))}</div></div>`).join('');
  // C's session beads: one per session of the stage, the hand-offs between them; the last one is this session
  const beads = fin(p?.sessions) && p.sessions > 0 ? `<span class="beads" role="img" aria-label="${esc(`session ${p.sessions}${p.handoffs ? `, ${p.handoffs} hand-off${p.handoffs === 1 ? '' : 's'}` : ''}`)}">${Array.from({ length: Math.min(8, p.sessions) }, (_, i) => `<i${i === Math.min(8, p.sessions) - 1 ? ' class="now"' : ''}></i>`).join('')}</span><span class="small mute">session ${p.sessions}</span>` : '';
  const paceBand = live && p ? `<section class="rd-sec rd-pace"><div class="rd-tline">${timeBar(n, now, 'wide')}${rtime(n, now)}</div>
    ${p.words ? `<p class="small">${esc(p.words)}</p>` : ''}${g.slow?.line ? `<p class="small ${PACE[paceOf(n)] ?? ''}">${esc(g.slow.line)}</p>` : ''}${beads ? `<div class="rd-beads">${beads}</div>` : ''}</section>` : '';
  const result = !live ? `<section class="rd-sec" id="run-result"><h3>Result</h3><div class="kv small">
    <span class="mute">outcome</span><span>${stateChip(n)}${n.outcome ? ` <span class="mono">${esc(n.outcome)}</span>` : ''}</span>
    ${statusWhy(n) || n.stop ? `<span class="mute">why</span><span>${[statusWhy(n) && `<span class="run-why">${esc(statusWhy(n))}</span>`, n.stop && esc(stopWords(n.stop))].filter(Boolean).join(' · ')}</span>` : ''}
    <span class="mute">ran</span><span>${rtime(n, now)}${fin(runTimes(n, now).ended_min) ? ` · ended ${fmtMin(runTimes(n, now).ended_min)} ago` : ''}</span>
    ${g?.total ? `<span class="mute">items</span><span>${items(n)}</span>` : ''}${n.dod_ready || n.dod ? `<span class="mute">tests</span><span>${dodChips(n.dod_ready, n.dod)}</span>` : ''}
    ${n.handoff ? `<span class="mute">next</span><span>${hoChip(n.handoff, n.id)}</span>` : ''}</div></section>` : '';
  const list = (g?.items || []).length ? `<section class="rd-sec"><h3>Checklist <span class="small mute">${esc(`${g.done ?? 0} of ${g.total ?? g.items.length}`)}</span></h3>
    ${live && g.line ? `<p class="small rd-now"><b>Now</b> ${esc(g.line)}</p>` : ''}<ol class="rd-items">${g.items.map(i => `<li class="it-${esc(i.state)}"><span class="small mute">${esc(i.state === 'done' ? 'done' : i.state === 'doing' ? 'now' : '')}</span> ${esc(i.title)}</li>`).join('')}</ol>
    ${n.commit ? `<p class="small mute">last commit <span class="mono">${esc(typeof n.commit === 'string' ? n.commit : `${n.commit.sha ?? ''} ${n.commit.subject ?? ''}`)}</span></p>` : ''}</section>` : '';
  const tok = n.tokens === '-' ? '-' : fin(n.tokens) ? `${int(n.tokens)}${n.tokens_src ? ` (${esc(n.tokens_src)})` : ''}` : String(n.executor ?? '').startsWith('codex') ? 'at end' : '-';
  const facts = [['context', fin(n.ctx) ? ctxMeter(n) : null], ['tokens', tok], ['cache read', fin(n.cacheR) ? mTok(n.cacheR) : null],
    ['burn', fin(n.burn30) && n.burn30 > 0 ? `${mTok(n.burn30)} / 30 min` : null], ['speed', n.speed ? speedLine(n.speed) : null],
    ['helpers', n.helpers ? esc(`${n.helpers.n}${n.helpers.running ? ` (${n.helpers.running} running)` : ''}, ${int(n.helpers.tokens)} tok`) : null],
    ['subagents', (n.children || []).length ? `<ul class="rd-kids">${n.children.map(k => `<li><b>${esc(k.agentType ?? 'subagent')}</b> <span class="mute">${esc(k.description ?? '')}</span></li>`).join('')}</ul>` : null],
    ['refused', (n.refused || []).length ? n.refused.map(x => `<div>${chip('refused', `refused: ${x.words}`)} <span class="mute">${esc(String(x.ts ?? '').slice(11, 16))} - ${esc(x.why)}</span></div>`).join('') : null]]
    .filter(([, v]) => v != null).map(([k, v]) => `<span class="mute">${k}</span><span>${v}</span>`).join('');
  const feed = feedable(n) ? `<section id="run-feed-slot" ${at}></section>` : '';
  return `<article class="rdoc card" id="run-doc" data-run="${esc(n.id)}" data-project="${esc(n.project ?? '')}" aria-label="${esc(n.id)}">${head}${alarms ? `<section class="rd-sec rd-alarms">${alarms}</section>` : ''}${paceBand}${result}${list}
    <section class="rd-sec"><h3>Facts</h3><div class="kv small rd-facts">${facts}</div></section>${feed}</article>`;
}
// a run the URL names that the tree does not hold: it ended outside the window, or the Ended band is still loading
const missingDoc = (id, d, ctx, win) => `<article class="rdoc card" id="run-doc" data-run="${esc(id)}" data-project="${esc(ctx.project ?? '')}">${ctx.narrow ? `<button class="ghost" data-act="runs-back" data-run="${esc(id)}">‹ Runs</button>` : ''}
  <p class="mute">${d.parts_loading ? `Loading the ended runs to find ${esc(id)} ...` : `${esc(id)} is not in this window (${esc(win)}). A wider window may hold it.`}</p>
  ${RUN_ID.test(id) && ctx.project && ctx.project !== 'all' ? `<section id="run-feed-slot" data-project="${esc(ctx.project)}" data-run="${esc(id)}"></section>` : ''}</article>`;

export function runs(d, ctx) {
  const v = ctx.runsView ?? runsViewOf(new URLSearchParams());
  // the live part (running + queue) and the history part (the ended runs in the window) may both name a run: history wins
  const seen = new Map(); for (const n of [...(d.tree || []), ...(d.ended || [])]) seen.set(`${n.project}|${n.id}`, n);
  const all = [...seen.values(), ...(d.queue || []).map(queueNode)], win = (RUNS_WINDOWS.find(w => w[0] === (d.window ?? v.window)) ?? RUNS_WINDOWS[0])[1];
  const shown = runsOrder(runsFilter(all, v)), loading = !!d.parts_loading;
  const pick = ctx.run ?? runsPick(shown) ?? runsPick(all), picked = pick ? all.find(n => n.id === pick) : null;
  const live = shown.filter(n => runStateOf(n) === 'running'), queued = shown.filter(n => runStateOf(n) === 'queued'), ended = shown.filter(n => !['running', 'queued'].includes(runStateOf(n)));
  const r = n => row(n, d, ctx, n.id === pick);
  const cks = ended.filter(n => runKindOf(n) === 'checkin'), fold = cks.length > 1 && !v.ck;
  const endedRows = ended.map(n => (fold && runKindOf(n) === 'checkin' ? (n === cks[0] ? checkinFold(cks, ctx) : '') : r(n))).join('');
  const none = t => `<p class="rnone small mute">${esc(t)}</p>`;
  const look = live.filter(n => URGENT[paceOf(n)] != null || (n.progress?.alarms || []).length).length;
  const nEnded = all.filter(n => !['running', 'queued'].includes(runStateOf(n))).length;
  const sum = `<div class="subsum" id="runs-sum">${[[all.filter(n => runStateOf(n) === 'running').length, 'running'], [look, 'need a look', look ? 'warn' : ''],
    [all.filter(n => runStateOf(n) === 'queued').length, 'queued'], [loading && !d.ended ? '…' : nEnded, `ended in the last ${win}`]]
    .map(([x, l, c]) => `<div class="subnum ${c ?? ''}"><b class="mono">${esc(x)}</b><span class="small mute">${esc(l)}</span></div>`).join('')}</div>`;
  // the filters: the window and the lane box always; the state / kind / project chips behind "Filters" (open while one is set)
  const chips = (group, l, has, of) => `<span class="lane-show" role="group" aria-label="${esc(group)}">${l.map(([k, t]) => `<button class="hf" data-act="runs-show" data-group="${group}" data-show="${esc(k)}" aria-pressed="${has(k)}">${esc(t)} <b>${all.filter(n => of(n) === k).length}</b></button>`).join('')}</span>`;
  const projs = [...new Set(all.map(n => n.project).filter(Boolean))].sort(), set = !full(v.state, RUNS_STATES) || !full(v.kind, RUNS_KINDS) || v.proj.size > 0, open = v.open || set;
  const bar = `<div class="runs-bar"><span class="lane-show" role="group" aria-label="window">${RUNS_WINDOWS.map(([k, t]) => `<button class="hf" data-act="runs-window" data-window="${k}" aria-pressed="${k === v.window}" title="ended runs from the last ${esc(t)}">${esc(t)}</button>`).join('')}</span>
    <input type="search" data-runs-lane aria-label="Filter by lane" placeholder="lane" value="${esc(v.lane)}">
    <button class="ghost" data-act="runs-filters" aria-expanded="${open}" aria-controls="runs-chips">Filters${set ? ' (on)' : ''}</button><button class="ghost rhelp" data-act="runs-help" aria-expanded="${!!v.help}" aria-controls="runs-legend" aria-label="What the list shows">?</button></div>
    ${open ? `<div class="filters runs-filters" id="runs-chips">${chips('state', RUNS_STATES, k => v.state.has(k), runStateOf)}${chips('kind', RUNS_KINDS, k => v.kind.has(k), runKindOf)}${projs.length > 1 ? chips('proj', projs.map(p => [p, p]), k => v.proj.has(k), n => n.project) : ''}</div>` : ''}
    ${v.help ? `<div class="runs-legend small" id="runs-legend" role="note"><p>Live runs first: stalled, then slow, then on track (newest start first in each); then the queue in fill order; then the runs that ended in the last ${esc(win)}, latest first. The bar is the time against the budget; its line is the budget, its tick what like runs took.</p>${d.counts ? `<p id="runs-counts">${esc(d.counts.scope)}: ${esc(d.counts.text)}</p>` : ''}</div>` : ''}`;
  const empty = !shown.length ? `<div class="rnone mute">${all.length ? 'No runs under these filters.' : `No running, queued or recent (${esc(win)}) sessions.`}</div>` : '';
  const list = `<div class="runs-list"><div class="tree">${empty}${bandHtml('live', 'Live', live.length, live.map(r).join('') || none('Nothing is running.'))}
    ${bandHtml('queued', 'Queued', queued.length, queued.map(r).join('') || none('Nothing is waiting to start.'))}
    ${bandHtml('ended', `Ended in the last ${win}`, loading && !d.ended ? '' : ended.length, (loading ? `<p class="rnone small mute">${d.ended ? 'refreshing ...' : 'loading the ended runs ...'}</p>` : '') + (endedRows || (loading ? '' : none('No run ended in this window.'))))}</div></div>`;
  const doc = picked ? runDoc(picked, d, ctx) : pick ? missingDoc(pick, d, ctx, win) : `<article class="rdoc card" id="run-doc" data-run=""><p class="mute">No run to show: none is running, queued or ended in the last ${esc(win)}.</p></article>`;
  const head = `<div class="phead pagehead" id="runs-head"><h2 class="ptitle">Runs</h2></div>`;
  if (ctx.narrow && ctx.run) return `<div class="runs one">${doc}</div>`;
  return `${head}${sum}${bar}<div class="runs-split${ctx.narrow ? ' one' : ''}">${list}${ctx.narrow ? '' : doc}</div>`;
}
