// The Runs page (moved verbatim from ui.mjs, stage NAV): the run tree, its filter chips and the view kept in the URL.
import { esc, fin, dash, int, mTok, fmtMin, aname, chip, exClass, exChip, runChip, projTag, homeChip, ctxMeter, pauseAct, speedLine, progLine, laneCard, guardOn, guardChip } from '../ui.mjs';
import { dodChips, critiqueChip, hoChip } from '../widgets.mjs';
import { LANE_SHOW } from './lanes.mjs';


// RM-34: the Runs page's Lane cell - the lane (a link to its row on Lanes, every filter on so it shows) and the stage beside it;
// a check-in reads "check-in", a run with no lane (a talk session) a dash
const LANES_ALL = LANE_SHOW.map(([k]) => k).join(',');
export const runLane = n => n.kind === 'checkin' ? 'check-in' : !n.lane ? dash
  : `<a class="lanelink" data-rid="L:${esc(n.lane)}" href="?project=${encodeURIComponent(n.project ?? '')}&tab=lanes&lanes=${LANES_ALL}">${esc(n.lane)}</a>${n.stage ? ` · ${esc(n.stage)}` : ''}`;
// ---------- the Runs page (owner 2026-11-19): running first, then queued, then ended; filter chips for state, kind and project, a lane
// box and the window, all kept in the URL (index.html: S.runsView, runsViewOf / runsViewQs); 'ran' and 'ended' time columns ----------
export const RUNS_STATES = [['running', 'running'], ['queued', 'queued'], ['finished', 'finished'], ['failed', 'failed']];
export const RUNS_KINDS = [['worker', 'worker'], ['checkin', 'check-in'], ['helper', 'helper'], ['talk', 'talk']];
export const RUNS_WINDOWS = [['2h', '2 h'], ['12h', '12 h'], ['24h', '24 h'], ['today', 'all today']];   // the server's RUN_WINDOWS
const RUN_FAILED = ['crash', 'stopped', 'no-result', 'limit', 'auth'];   // an end outcome that did not finish the work
/** a tree root's (or a queue entry's) state chip: running / queued / failed (lost, killed or a failed outcome) / finished */
export const runStateOf = n => n.state === 'queued' ? 'queued' : n.state === 'running' || n.state === 'alive' ? 'running'
  : n.state === 'lost' || n.state === 'killed' || RUN_FAILED.includes(n.outcome) ? 'failed' : 'finished';
/** its kind chip: a helper (norn delegate), a check-in, a talk session (an interactive run too), else a worker (any executor) */
export const runKindOf = n => n.kind === 'helper' || n.role === 'helper' ? 'helper' : n.kind === 'checkin' ? 'checkin' : n.kind === 'talk' || n.kind === 'interactive' ? 'talk' : 'worker';
const isoMs = x => { const v = Date.parse(x ?? ''); return Number.isFinite(v) ? v : null; };
/**
 * A node's times in minutes: ran = start to end (start to now while running), ended = now minus its end (null while running),
 * queued = now minus its queue time (queue entries only). A run's start / end are its own start and end events (agentsTree);
 * a subagent's are its first and last transcript lines. An ended node with no end time has no ran either.
 */
export function runTimes(n, now) {
  if (n.state === 'queued') { const q = isoMs(n.queued); return { ran_min: null, ended_min: null, queued_min: q === null ? null : Math.max(0, (now - q) / 60000) }; }
  const live = runStateOf(n) === 'running', s = isoMs(n.started ?? n.first), e = live ? null : isoMs(n.ended ?? n.last);
  return { ran_min: s === null || (!live && e === null) ? null : Math.max(0, ((e ?? now) - s) / 60000), ended_min: e === null ? null : Math.max(0, (now - e) / 60000), queued_min: null };
}
/** the default order: running (newest start first), then queued (longest waiting first: the fill order), then ended (latest end first) */
export function runsOrder(roots) {
  const g = n => ({ running: 0, queued: 1 })[runStateOf(n)] ?? 2, t = x => isoMs(x) ?? 0;
  const key = n => g(n) === 0 ? -t(n.started ?? n.first) : g(n) === 1 ? t(n.queued) : -t(n.ended ?? n.last ?? n.started);
  return [...roots].sort((a, b) => g(a) - g(b) || key(a) - key(b));
}
const allOf = l => new Set(l.map(x => x[0]));
/** the page's view from the URL: &state= &kind= (a missing key = every chip on), &proj= (none = every project), &lane=, &window= */
export function runsViewOf(qs) {
  const set = (k, l) => { const v = qs.get(k); return v == null ? allOf(l) : new Set(v.split(',').filter(x => l.some(c => c[0] === x))); };
  return { state: set('state', RUNS_STATES), kind: set('kind', RUNS_KINDS), proj: new Set((qs.get('proj') ?? '').split(',').filter(Boolean)), lane: qs.get('lane') ?? '',
    window: RUNS_WINDOWS.some(w => w[0] === qs.get('window')) ? qs.get('window') : '2h' };
}
/** the view as URL params ('&state=running,queued...'): only what differs from the default, so a plain Runs link stays plain */
export function runsViewQs(v) {
  const full = (x, l) => x.size === l.length && l.every(c => x.has(c[0])), p = [];
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
const queueNode = q => ({ id: q.id, name: q.name, kind: q.kind, role: q.role, state: 'queued', lane: q.lane, stage: q.stage, executor: q.executor, model: q.model, queued: q.queued, project: q.project, children: [] });
const RUNS_HEAD = [['session', ''], ['lane', '', 'lanecol'], ['model · effort', ''], ['state', ''],
  ['ran', 'How long the run ran: its start to its end, or to now while it runs. A queued run shows how long it has waited in the queue.'],
  ['ended', 'How long ago the run ended. Empty while it runs.'], ['tokens', ''], ['context now (tick = hand-off, bar end = hard max)', ''], ['burn', '']];
export function runs(d, ctx) {
  const top = Object.fromEntries((d.top || []).map(t => [t.id, t]));
  const v = ctx.runsView ?? runsViewOf(new URLSearchParams());
  // RM-34: Session = what identifies the session (its id + name); the rest of the old line (class, question, outcome, helpers) is its
  // title, and the lane it works for has its own column
  const name = n => n.kind === 'subagent' ? esc(n.agentType ?? 'subagent') : n.kind === 'talk' ? esc(n.id) : `<span class="id">${esc(n.id)}</span>${aname(n.name)}${n.kind === 'helper' ? ' helper' : ''}`;
  const more = n => (n.kind === 'subagent' ? [n.description] : [n.kind === 'helper' && 'helper', n.class, n.q && `"${n.q}"`, n.lane && [n.lane, n.stage].filter(Boolean).join(' · '),
    n.outcome && String(n.outcome).toUpperCase(), n.helpers && `helpers ${n.helpers.n}${n.helpers.running ? ` (${n.helpers.running} running)` : ''}, ${int(n.helpers.tokens)} tok`]).filter(Boolean).join(' · ');
  const tok = n => n.tokens === '-' ? '-' : fin(n.tokens) ? `${int(n.tokens)}${n.tokens_src ? ` (${esc(n.tokens_src)})` : ''}` : fin(n.cacheR) ? `${mTok(n.cacheR)} cacheR` : String(n.executor ?? '').startsWith('codex') ? 'at end' : '-';
  const times = n => { const t = runTimes(n, ctx.now);
    return `<div class="small run-ran">${fin(t.queued_min) ? `queued for ${fmtMin(t.queued_min)}` : fmtMin(t.ran_min)}</div><div class="small run-ended">${fin(t.ended_min) ? `${fmtMin(t.ended_min)} ago` : ''}</div>`; };
  const one = (n, lvl, kids, pid) => {
    const b = top[n.id];
    const feed = /^RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+$/.test(n.id) && n.state !== 'queued' && !n.readonly ? ` data-feed="${esc(n.id)}" data-project="${esc(n.project)}" title="Open the live feed"` : '';
    return `<div class="node lvl${lvl}" id="node-${esc(n.id)}"${lvl ? ` data-p="${esc(pid)}"` : ''}${feed}><div class="name">${kids ? `<span class="caret" data-t="${esc(pid)}">&#9662;</span>` : '<span class="caret"></span>'}${chip(n.kind === 'subagent' ? 'idle' : exClass(n.executor), n.kind ?? 'run')}<span class="t" title="${esc(more(n))}">${projTag(ctx, n.project)}${name(n)}</span>${homeChip(n)}${n.dod_ready || n.dod ? dodChips(n.dod_ready, n.dod) : ""}${critiqueChip(n.critique)}${n.pause ? ` ${pauseAct(n.pause, n.project, n.id)}` : ''}${(n.guard || []).map(g => `<span class="guard-chip" title="${esc(`${g.id}: ${g.why}`)}">${chip(g.state === 'ruled' ? 'idle' : g.cls === 'runaway' ? 'bad' : 'warn', `${g.cls}${g.action ? ': ' + g.action : ''}`)}</span>`).join('')}${guardChip(guardOn(d.guard, r => r.run === n.id), { tab: 'slop' })}</div>
     <div class="lanecol small">${lvl ? '' : laneCard(n.lane_card, runLane(n))}${progLine(n.progress)}${speedLine(n.speed)}</div><div>${exChip(n.kind === 'subagent' ? null : n.executor, n.model, n.effort)}</div><div>${runChip(n.state)}</div>${times(n)}<div class="mono small">${tok(n)}</div>
     <div>${fin(n.ctx) ? ctxMeter(n) : dash}</div><div class="mono small">${fin(b?.pct_per_h) ? b.pct_per_h.toFixed(2) + ' %/h' : fin(n.burn30) && n.burn30 > 0 ? mTok(n.burn30) + ' /30 min' : '-'}</div>${n.handoff ? `<div class="horow">${hoChip(n.handoff, n.id)}</div>` : ''}</div>`;
  };
  // META-CHECKIN-GUARDS R1: a move a guard refused in code, as a plain row under the run that tried it
  const refusedRows = n => (n.refused || []).map(x => `<div class="node lvl1 refusedrow" data-p="p-${esc(n.id)}"><div class="small" style="grid-column:1/-1">${chip('refused', `refused: ${x.words}`)} ${esc([x.lane, x.stage ?? x.answers].filter(Boolean).join(' '))} <span class="mute">${esc(String(x.ts ?? '').slice(11, 16))} - ${esc(x.why)}</span></div></div>`).join('');
  const tree = d.tree || [], all = [...tree, ...(d.queue || []).map(queueNode)], win = (RUNS_WINDOWS.find(w => w[0] === (d.window ?? v.window)) ?? RUNS_WINDOWS[0])[1];
  const rows = runsOrder(runsFilter(all, v)).map(n => one(n, 0, (n.children || []).length || (n.refused || []).length, 'p-' + n.id) + refusedRows(n) + (n.children || []).map(k => one(k, 1, false, 'p-' + n.id)).join('')).join('')
    || `<div class="node"><div class="mute">${all.length ? 'No runs under these filters.' : `No running, queued or recent (${esc(win)}) sessions.`}</div></div>`;
  const by = k => tree.filter(n => exClass(n.executor) === k).length, projs = [...new Set(all.map(n => n.project).filter(Boolean))].sort();
  const chips = (group, l, has, of) => `<span class="lane-show" role="group" aria-label="${esc(group)}">${l.map(([k, t]) => `<button class="hf" data-act="runs-show" data-group="${group}" data-show="${esc(k)}" aria-pressed="${has(k)}">${esc(t)} <b>${all.filter(n => of(n) === k).length}</b></button>`).join('')}</span>`;
  const filters = `<div class="filters runs-filters">${chips('state', RUNS_STATES, k => v.state.has(k), runStateOf)}${chips('kind', RUNS_KINDS, k => v.kind.has(k), runKindOf)}${projs.length > 1 ? chips('proj', projs.map(p => [p, p]), k => v.proj.has(k), n => n.project) : ''}
    <span class="lane-show" role="group" aria-label="window">${RUNS_WINDOWS.map(([k, t]) => `<button class="hf" data-act="runs-window" data-window="${k}" aria-pressed="${k === v.window}" title="ended runs from the last ${esc(t)}">${esc(t)}</button>`).join('')}</span>
    <input type="search" data-runs-lane placeholder="filter by lane" value="${esc(v.lane)}"></div>`;
  return `<div class="legend small mute"><span>Running first (newest start first), then queued, then ended (latest end first). Tree = every run running, queued or ended in the last ${esc(win)} (workers, check-ins, Codex, own-account executors), talk sessions and their subagents. Click a run for its live feed.</span>
    <span>Sources: RUN records + transcript <span class="mono">&lt;session&gt;.jsonl</span>, <span class="mono">subagents/agent-*.meta.json</span>, Codex log banner / rollout.</span></div>
   ${filters}
   <div class="tree"><div class="node head">${RUNS_HEAD.map(([h, t, c]) => `<div${c ? ` class="${c}"` : ''}${t ? ` title="${esc(t)}"` : ''}>${esc(h)}</div>`).join('')}</div>${rows}</div>
   <p class="small mute">Sessions: Claude ${by('claude')} · Codex ${by('codex')} · own-account ${by('prov')}. What a queued run waits for: the Plan tab.</p>`;
}
// ---------- META-TEND P6: the Guard (REPORT s.5.0-5.1) - every open advisory across types, a query that owns no data ----------
// Chips in place: guardOn(guard, pick) = the rows of one owning thing; guardChip = ONE chip shape on every tab (severity colour, the
// count, a title with the worst line). The Guard page: SloppaChoppa's section (his portrait, his line, call him up, Mute), counts per
// type (bars), the trend (lines), the rule ledger (stack), and every row with the tab that fixes it.
