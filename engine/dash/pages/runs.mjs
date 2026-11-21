// The Runs page (stage RUNS; owner 2026-11-20 "all the runs in tabular format"): one table of every run - state, run, lane · stage,
// model, age, tools / words / commits, pace - under one filter-chip row (state with "need a look", kind, window, project, lane box).
// A row opens the run's document in the drawer (&run=RUN-n): its pace, result, checklist, facts and live feed (pages/runs-feed.mjs
// mounts into the document's slot). The view lives in the URL (index.html: S.runsView, runsViewOf / runsViewQs).
import { esc, fin, dash, int, mTok, fmtMin, fmtTime, runWho, chip, exChip, projTag, homeChip, ctxMeter, pauseAct, speedLine, laneCard, guardOn, guardChip, filterChips } from '../cells.mjs';
import { dodChips, critiqueChip, hoChip } from '../widgets.mjs';
import { LANE_SHOW, prioSelect } from './lanes.mjs';

// RM-34: a run's lane (a link to its row on Lanes, every filter on so it shows) and the stage beside it; a check-in reads "check-in",
// a run with no lane (a talk session) a dash
const LANES_ALL = LANE_SHOW.map(([k]) => k).join(',');
export const runLane = n => n.kind === 'checkin' ? 'check-in' : !n.lane ? dash
  : `<a class="lanelink" data-rid="L:${esc(n.lane)}" href="?project=${encodeURIComponent(n.project ?? '')}&tab=lanes&show=${LANES_ALL}">${esc(n.lane)}</a>${n.stage ? ` · ${esc(n.stage)}` : ''}`;
// the state chips: a live run that needs a look (stalled, slow or an alarm) is its own chip, out of "running"
export const RUNS_STATES = [['running', 'running'], ['look', 'need a look'], ['queued', 'queued'], ['finished', 'finished'], ['failed', 'failed']];
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
// attention among the live runs: a stalled run first, then a slow one, then the rest (the run's pace, progress.mjs)
const paceOf = n => n.progress?.pace?.state ?? null;
const URGENT = { stalled: 0, slow: 1 };
/** the state chip a root counts under: look = running and stalled, slow or alarmed; else its runStateOf */
export const runShowOf = n => runStateOf(n) === 'running' && (URGENT[paceOf(n)] != null || (n.progress?.alarms || []).length) ? 'look' : runStateOf(n);
/** the order: live (stalled, slow, the rest; newest start first in each), then queued (longest waiting first: the fill order), then ended (latest end first) */
export function runsOrder(roots) {
  const g = n => ({ running: 0, queued: 1 })[runStateOf(n)] ?? 2, t = x => isoMs(x) ?? 0, u = n => g(n) === 0 ? URGENT[paceOf(n)] ?? 2 : 0;
  const key = n => g(n) === 0 ? -t(n.started ?? n.first) : g(n) === 1 ? t(n.queued) : -t(n.ended ?? n.last ?? n.started);
  return [...roots].sort((a, b) => g(a) - g(b) || u(a) - u(b) || key(a) - key(b));
}
const RUN_ID = /^RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+$/;
const feedable = n => RUN_ID.test(n.id) && n.state !== 'queued' && !n.readonly;
const allOf = l => new Set(l.map(x => x[0]));
/** the page's view from the URL: &state= &kind= (a missing key = every chip on), &proj= (none = every project), &lane=, &window=;
 * ck = the folded check-ins shown (the page's own, never in the URL) */
export function runsViewOf(qs) {
  const set = (k, l) => { const v = qs.get(k); return v == null ? allOf(l) : new Set(v.split(',').filter(x => l.some(c => c[0] === x))); };
  return { state: set('state', RUNS_STATES), kind: set('kind', RUNS_KINDS), proj: new Set((qs.get('proj') ?? '').split(',').filter(Boolean)), lane: qs.get('lane') ?? '',
    window: RUNS_WINDOWS.some(w => w[0] === qs.get('window')) ? qs.get('window') : '2h', ck: false };
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
export const runsFilter = (roots, v) => roots.filter(n => v.state.has(runShowOf(n)) && v.kind.has(runKindOf(n)) && (!v.proj.size || v.proj.has(n.project))
  && (!v.lane || String(n.lane ?? '').toLowerCase().includes(v.lane.toLowerCase())));
const queueNode = q => ({ id: q.id, dwarf: q.dwarf ?? null, kind: q.kind, role: q.role, state: 'queued', lane: q.lane, stage: q.stage, executor: q.executor, model: q.model, effort: q.effort, queued: q.queued, project: q.project, children: [] });

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
const whyEnded = n => [stopWords(n.stop) && `<span>${esc(stopWords(n.stop))}</span>`, n.handoff ? hoChip(n.handoff, n.id) : ''].filter(Boolean).join(' ');
// a live run's one line: why slow or stalled, else what it does now
const nowLine = n => { const g = n.progress, s = paceOf(n), why = (s === 'slow' || s === 'stalled') && (g?.slow?.line ?? g?.pace?.words);
  return why ? `<div class="rline small ${PACE[s]}">${esc(why)}</div>` : g?.line ? `<div class="rline small">${esc(g.line)}</div>` : ''; };
const guardChips = (n, d) => `${(n.guard || []).map(g => `<span class="guard-chip" title="${esc(`${g.id}: ${g.why}`)}">${chip(g.state === 'ruled' ? 'idle' : g.cls === 'runaway' ? 'bad' : 'warn', `${g.cls}${g.action ? ': ' + g.action : ''}`)}</span>`).join('')}${guardChip(guardOn(d.guard, r => r.run === n.id), { tab: 'slop' })}`;
const who = n => n.kind === 'talk' ? `<span class="id">${esc(n.id)}</span>` : `<span class="id">${esc(n.id)}</span>${runKindOf(n) === 'helper' ? ' <span class="small mute">helper</span>' : runWho(n.dwarf, n.kind_word)}`;
const kids = n => (n.children || []).length ? `<span class="small mute">${(n.children || []).length} subagent${n.children.length === 1 ? '' : 's'}</span>` : '';

// ---------- the table ----------
// the counts of what the run did (lib/agents.mjs acts: a Claude transcript's tool calls, words written, git commits); none read = a dash
const actCell = (n, k) => `<td class="rnum mono" data-label="${k}">${fin(n.acts?.[k]) ? int(n.acts[k]) : dash}</td>`;
// age: a live run's time against its budget, an ended run's run time and how long ago it ended, a queued run's wait
function ageCell(n, ctx) {
  const now = ctx.now, s = runStateOf(n), t = runTimes(n, now);
  const v = s === 'queued' ? (fin(t.queued_min) ? `waited ${fmtMin(t.queued_min)}` : dash) : `${rtime(n, now)}${s !== 'running' && fin(t.ended_min) ? `<div class="small mute">ended ${fmtMin(t.ended_min)} ago</div>` : ''}`;
  return `<td class="rage" data-label="age">${v}</td>`;
}
// pace: a live run's pace chip, time bar, checklist and why slow (or what it does now); an ended run's checklist and why it ended;
// a queued run's estimate, start, hold-ups and the priority control (Plan's Up next, now here and on Lanes)
function paceCell(n, d, ctx) {
  const s = runStateOf(n), now = ctx.now;
  if (s === 'queued') return `<td class="rpace" data-label="pace">${queuedCell(n, d)}</td>`;
  if (s === 'running') return `<td class="rpace" data-label="pace"><div class="rtimes small">${paceChip(n)}${timeBar(n, now)}${items(n)}</div>${n.handoff ? `<div class="rline small rho">${hoChip(n.handoff, n.id)}</div>` : ''}${nowLine(n)}${speedLine(n.speed)}</td>`;
  return `<td class="rpace" data-label="pace"><div class="rtimes small">${items(n)}</div>${whyEnded(n) ? `<div class="rline small">${whyEnded(n)}</div>` : ''}</td>`;
}
function row(n, d, ctx, sel) {
  const s = runStateOf(n), band = s === 'running' ? 'live' : s === 'queued' ? 'queued' : 'ended';
  const at = feedable(n) ? ` data-feed="${esc(n.id)}" data-project="${esc(n.project)}" tabindex="0" title="Open ${esc(n.id)}"` : '';
  return `<tr class="rrow ${band}${sel ? ' sel' : ''}" id="node-${esc(n.id)}"${at}${sel ? ' aria-current="true"' : ''}>
    <td class="rstate" data-label="state">${stateChip(n)}</td>
    <td class="rwho" data-label="run">${projTag(ctx, n.project)}${who(n)} ${homeChip(n)}${guardChips(n, d)}${kids(n) ? `<div>${kids(n)}</div>` : ''}</td>
    <td class="rlane" data-label="lane">${laneCard(n.lane_card, runLane(n))}</td>
    <td class="rmodel small" data-label="model">${exChip(n.executor, n.model, n.effort)}</td>
    ${ageCell(n, ctx)}${actCell(n, 'tools')}${actCell(n, 'words')}${actCell(n, 'commits')}${paceCell(n, d, ctx)}</tr><!--/row-->`;
}
// a queued row's pace cell: what it waits for (Plan's holds, in words), its estimate and start, and the priority control
function queuedCell(n, d) {
  const part = (d.plan?.parts || []).find(p => p.project === n.project) ?? (d.plan?.parts || [])[0], u = (part?.upnext || []).find(x => x.id === n.id);
  const holds = (u?.holds || []).map((h, i) => (u.holdAt?.[i] ? `not before ${fmtTime(u.holdAt[i])}` : h));
  const start = u?.start ? (u.start.at && u.start.word !== 'now' ? `start ~${fmtTime(u.start.at)}` : `start ${u.start.word}`) : '';
  return `<div class="rtimes small">${u ? prioSelect(n.project ?? part.project, n.id, u.priority, part.priorities) : ''}${u?.estimate?.word ? `<span>${esc(u.estimate.word)}</span>` : ''}${start && !holds.includes(u.start.word) ? `<span>${esc(start)}</span>` : ''}</div>
    ${holds.length ? `<div class="rline small">${holds.map(esc).join(' · ')}</div>` : ''}`;
}
const COLS = ['state', 'run', 'lane · stage', 'model', 'age', 'tools', 'words', 'commits', 'pace'];
// check-ins (ended, more than one) collapse to one row: how many, the last one, how they went; "show them" opens them in place
function checkinFold(cks, ctx) {
  const e = runTimes(cks[0], ctx.now).ended_min, bad = cks.filter(n => runStateOf(n) === 'failed').length;
  return `<tr class="rfoldrow"><td colspan="${COLS.length}"><button class="rfold small" data-act="runs-checkins" aria-expanded="false">${cks.length} check-ins · last ${fmtMin(e)} ago · ${bad ? `${bad} failed` : 'all done'} · show them</button></td></tr>`;
}

// ---------- the run document: the drawer a row opens (&run=); Close or Esc drops the &run= ----------
const CLOSE = '<button class="ghost" data-act="runs-close" title="Close (Esc)">Close</button>';
function runDoc(n, d, ctx) {
  const now = ctx.now, s = runStateOf(n), live = s === 'running', g = n.progress, p = g?.pace, at = `data-project="${esc(n.project)}" data-run="${esc(n.id)}"`;
  const follow = n.handoff?.run && n.handoff.run !== n.id ? `<button data-act="run-open" data-run="${esc(n.handoff.run)}">Follow ${esc(n.handoff.run)}</button>` : '';
  const acts = [live ? (n.pause ? pauseAct(n.pause, n.project, n.id) : `<button class="ghost" data-act="run-pause" ${at} title="Ask ${esc(n.id)} to stop at a clean point and hand off">Pause</button>`) : '',
    live && RUN_ID.test(n.id) ? `<button class="danger" data-act="stop" ${at} title="Stop ${esc(n.id)} now (asks first)">Stop</button>` : '',
    !live && n.pause ? pauseAct(n.pause, n.project, n.id) : '', follow,
    `<button class="ghost" data-act="run-link" data-run="${esc(n.id)}">Copy link</button>`].filter(Boolean).join('');
  const head = `<header class="rd-head"><div class="rd-title"><h2>${projTag(ctx, n.project)}${who(n)}</h2>${stateChip(n)}${live ? paceChip(n) : ''}${homeChip(n)}${n.dod_ready || n.dod ? dodChips(n.dod_ready, n.dod) : ''}${critiqueChip(n.critique)}${guardChips(n, d)}<span class="spacer"></span>${CLOSE}</div>
    <div class="small rd-sub">${laneCard(n.lane_card, runLane(n))} · ${exChip(n.executor, n.model, n.effort)}</div><div class="rd-acts">${acts}</div></header>`;
  const alarms = (g?.alarms || []).map(a => `<div class="rd-alarm" role="alert">${chip(a.cls === 'runaway' ? 'bad' : 'warn', a.cls)} <b>${esc(a.words)}</b><div class="small mute">${esc(a.numbers ?? '')}</div><div class="small">${a.ruled ? `${esc(a.ruled)}. ` : ''}You can: ${esc((a.act || []).join(' / '))}</div></div>`).join('');
  // C's session beads: one per session of the stage, the hand-offs between them; the last one is this session
  const beads = fin(p?.sessions) && p.sessions > 0 ? `<span class="beads" role="img" aria-label="${esc(`session ${p.sessions}${p.handoffs ? `, ${p.handoffs} hand-off${p.handoffs === 1 ? '' : 's'}` : ''}`)}">${Array.from({ length: Math.min(8, p.sessions) }, (_, i) => `<i${i === Math.min(8, p.sessions) - 1 ? ' class="now"' : ''}></i>`).join('')}</span><span class="small mute">session ${p.sessions}</span>` : '';
  const paceBand = live && p ? `<section class="rd-sec rd-pace"><div class="rd-tline">${timeBar(n, now, 'wide')}${rtime(n, now)}</div>
    ${p.words ? `<p class="small">${esc(p.words)}</p>` : ''}${g.slow?.line ? `<p class="small ${PACE[paceOf(n)] ?? ''}">${esc(g.slow.line)}</p>` : ''}${beads ? `<div class="rd-beads">${beads}</div>` : ''}</section>` : '';
  const result = !live ? `<section class="rd-sec" id="run-result"><h3>Result</h3><div class="kv small">
    <span class="mute">outcome</span><span>${stateChip(n)}${n.outcome ? ` <span class="mono">${esc(n.outcome)}</span>` : ''}</span>
    ${n.stop ? `<span class="mute">why</span><span>${esc(stopWords(n.stop))}</span>` : ''}
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
  return `<article class="rdoc drawer" id="run-doc" data-run="${esc(n.id)}" data-project="${esc(n.project ?? '')}" aria-label="${esc(n.id)}">${head}${alarms ? `<section class="rd-sec rd-alarms">${alarms}</section>` : ''}${paceBand}${result}${list}
    <section class="rd-sec"><h3>Facts</h3><div class="kv small rd-facts">${facts}</div></section>${feed}</article>`;
}
// a run the URL names that the tree does not hold: it ended outside the window, or the ended runs are still loading
const missingDoc = (id, d, ctx, win) => `<article class="rdoc drawer" id="run-doc" data-run="${esc(id)}" data-project="${esc(ctx.project ?? '')}" aria-label="${esc(id)}"><header class="rd-head"><div class="rd-title"><h2><span class="id">${esc(id)}</span></h2><span class="spacer"></span>${CLOSE}</div></header>
  <p class="mute">${d.parts_loading ? `Loading the ended runs to find ${esc(id)} ...` : `${esc(id)} is not in this window (${esc(win)}). A wider window may hold it.`}</p>
  ${RUN_ID.test(id) && ctx.project && ctx.project !== 'all' ? `<section id="run-feed-slot" data-project="${esc(ctx.project)}" data-run="${esc(id)}"></section>` : ''}</article>`;

export function runs(d, ctx) {
  const v = ctx.runsView ?? runsViewOf(new URLSearchParams());
  // the live part (running + queue) and the history part (the ended runs in the window) may both name a run: history wins
  const seen = new Map(); for (const n of [...(d.tree || []), ...(d.ended || [])]) seen.set(`${n.project}|${n.id}`, n);
  const all = [...seen.values(), ...(d.queue || []).map(queueNode)], win = (RUNS_WINDOWS.find(w => w[0] === (d.window ?? v.window)) ?? RUNS_WINDOWS[0])[1];
  const shown = runsOrder(runsFilter(all, v)), loading = !!d.parts_loading, pick = ctx.run ?? null, picked = pick ? all.find(n => n.id === pick) : null;
  const cks = shown.filter(n => runKindOf(n) === 'checkin' && !['running', 'queued'].includes(runStateOf(n))), fold = cks.length > 1 && !v.ck;
  const rows = shown.map(n => (fold && cks.includes(n) ? (n === cks[0] ? checkinFold(cks, ctx) : '') : row(n, d, ctx, n.id === pick))).join('');
  // the one filter row: the state chips (with their counts), the kinds, the window, the projects (when the tree spans more than one), the lane box
  const chips = (group, l, of) => filterChips(group, l.map(([k, t]) => ({ act: 'runs-show', data: { group, show: k }, text: t, n: all.filter(n => of(n) === k).length, on: v[group].has(k) })));
  const projs = [...new Set(all.map(n => n.project).filter(Boolean))].sort();
  const help = `<details class="lhelp"><summary aria-label="About this table">?</summary><div class="small">Live runs first (stalled, then slow, then on track), then the queue in fill order, then the runs that ended in the last ${esc(win)}. A row opens the run: its checklist, result, facts and live feed. Tools / words / commits count the run's tool calls, the words it wrote and its git commits (Claude runs).${d.counts ? `<p id="runs-counts">${esc(d.counts.scope)}: ${esc(d.counts.text)}</p>` : ''}</div></details>`;
  const bar = `<div class="filters runs-filters">${chips('state', RUNS_STATES, runShowOf)}${chips('kind', RUNS_KINDS, runKindOf)}
    ${filterChips('window', RUNS_WINDOWS.map(([k, t]) => ({ act: 'runs-window', data: { window: k }, text: t, on: k === v.window, title: `ended runs from the last ${t}` })))}
    ${projs.length > 1 ? chips('proj', projs.map(p => [p, p]), n => n.project) : ''}<input type="search" data-runs-lane aria-label="Filter by lane" placeholder="lane" value="${esc(v.lane)}">${help}</div>`;
  const msg = t => `<tr class="rnone"><td colspan="${COLS.length}" class="small mute">${esc(t)}</td></tr>`;
  const empty = shown.length ? '' : msg(all.length ? 'No runs under these filters.' : `No running, queued or recent (${win}) sessions.`);
  const wait = loading ? msg(d.ended ? 'refreshing the ended runs ...' : 'loading the ended runs ...') : '';
  const table = `<div class="tablecard runs-table"><table class="runtab" data-rows="runs"><thead><tr>${COLS.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows}${empty}${wait}</tbody></table></div>`;
  const doc = picked ? runDoc(picked, d, ctx) : pick ? missingDoc(pick, d, ctx, win) : '';
  return `<div class="phead pagehead" id="runs-head"><h2 class="ptitle">Runs</h2></div>${bar}${table}${doc}`;
}
