// The Lanes page (stage LANES, SPEC 4.2: "the attention board"): one list grouped by what the owner must do. Each row: a state
// tile, name, the now line, progress and pace, the run strip (the retired Map's lane band as beads), the PR track and at most 3
// actions; the chevron opens the lane's flow and brief in place (S.laneOpen keeps it open through a stream repaint). No timer:
// the elapsed bar is a CSS animation, rows redraw on stream events only.
import { esc, chip, exClass, projTag, homeChip, pendingChips, pauseAct, progDetail, backlogLine } from '../cells.mjs';

// GAP-12: a running lane whose changed files overlap upstream work (a remote branch or an open PR; overlap.mjs) - one small chip each,
// a PR one links to the PR; the shared files are its tooltip
const overlapWords = o => `overlaps upstream: ${o.kind === 'pr' ? `PR #${o.number}` : o.ref} (${o.n} file${o.n === 1 ? '' : 's'})`;
const overlapChip = o => {
  const files = o.files || [], tip = esc([...(o.kind === 'pr' ? [`${o.ref}: ${o.title ?? ''}`] : []), ...files, ...(o.n > files.length ? [`+${o.n - files.length} more`] : [])].join('\n'));
  return o.kind === 'pr' && /^https:\/\//.test(o.url || '') ? `<a class="chip warn" href="${esc(o.url)}" target="_blank" rel="noopener" title="${tip}">${esc(overlapWords(o))}</a>`
    : `<span class="chip warn" title="${tip}">${esc(overlapWords(o))}</span>`; };
// owner 2026-11-18: two or more overlaps become ONE summary chip that opens (a native <details>) to the per-branch chips
const overlapChips = os => !(os || []).length ? '' : os.length === 1 ? `<div class="lane-overlap">${overlapChip(os[0])}</div>`
  : `<details class="lane-overlap"><summary class="chip warn" title="this lane's changed files overlap ${os.length} other branches / PRs">overlaps ${os.length} upstream: ${os.reduce((n, o) => n + (o.n || 0), 0)} files</summary><div class="lane-overlap-list">${os.map(overlapChip).join(' ')}</div></details>`;
// The board groups in page order (lib/lanes.mjs boardOf splits the rows; the server sets row.board). The group buttons are the filter,
// kept in S.laneShow and the URL as &show=; Parked and Done today start collapsed, Old and Archived are links with counts.
export const LANE_SHOW = [['needs', 'Needs you'], ['running', 'Running'], ['stopped', 'Stopped'], ['waiting', 'Waiting'], ['land', 'To land'],
  ['parked', 'Parked'], ['today', 'Done today'], ['old', 'Old'], ['archived', 'Archived']];
export const LANE_SHOW_DEFAULT = ['needs', 'running', 'stopped', 'waiting', 'land'];
const LINKS = ['old', 'archived'];
export const laneKey = (project, lane) => `${project}:${lane}`;
// RM-34: why the lane exists (purpose.mjs laneDriver): the objective, its sources as small links (RM / DIR / DEC / Q open the record,
// a brief or doc the Docs reader); no source = the finding as a chip. Shown in the open row.
const SRC_WORD = { brief: 'brief', doc: 'doc' };
export const laneSrcLink = s => s.doc ? `<button class="lnk lane-src" data-go="docs" data-goins="${esc(s.doc)}" title="${esc(`${s.id}: ${s.title}`)}">${esc(SRC_WORD[s.kind])}</button>`
  : `<a class="lane-src" data-rid="${esc(s.id)}" href="${esc(s.href)}" title="${esc(s.title)}">${esc(s.id)}</a>`;
export const laneWhy = d => !d ? '' : !d.sources.length ? `<div class="lane-why">${chip('warn', d.finding)}</div>`
  : `<details class="lane-why"><summary title="${esc(d.objective)}">${esc(d.objective)}</summary><ul class="small">${d.sources.map(s => `<li>${laneSrcLink(s)} ${esc(s.title)}</li>`).join('')}</ul></details>
    <div class="lane-srcs small">${d.sources.map(laneSrcLink).join(' ')}</div>`;
// MAIL-29: where the output goes in words (laneOutput: a PR and its state, or the notes) and a landing run in flight - in the open row
export const laneKind = l => { const t = l.lane_type, o = l.output; if (!t?.now && !o) return '';
  const out = !o ? '' : o.href ? `<a class="lane-out" href="${esc(o.href)}" target="_blank" rel="noopener">${esc(o.text)}</a>` : `<span class="lane-out">${esc(o.text)}</span>`;
  return `<div class="lane-kind small">${t?.now ? `${chip('running', t.now)} ` : ''}${out}</div>`; };
export const laneAge = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };

// ---------- the state shapes (DESIGN.md: play / check / arrows / stop / pause / ! / ring), drawn in currentColor ----------
const SHAPE = {
  running: '<path d="M5 3l8 5-8 5z"/>', done: '<path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  handoff: '<path d="M2 5.5h10M9 2.5l3 3-3 3M14 10.5H4M7 7.5l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  stopped: '<rect x="3.5" y="3.5" width="9" height="9"/>', parked: '<rect x="3.5" y="3" width="3" height="10"/><rect x="9.5" y="3" width="3" height="10"/>',
  needs: '<rect x="6.75" y="2" width="2.5" height="8"/><rect x="6.75" y="11.5" width="2.5" height="2.5"/>',
  idle: '<circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" stroke-width="2"/>',
};
const shape = t => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">${SHAPE[t] ?? SHAPE.idle}</svg>`;
// run class (lib/map.mjs runWord) -> token; the tile's token comes from the board group (pace is never a shape)
const RUN_TOKEN = { running: 'running', done: 'done', handoff: 'handoff', stopped: 'stopped', lost: 'stopped', bad: 'stopped', 'no-result': 'stopped', idle: 'idle' };
const BOARD_TOKEN = { needs: 'needs', running: 'running', stopped: 'stopped', waiting: 'idle', land: 'done', parked: 'parked', today: 'done', archived: 'idle' };
const tileToken = l => l.board === 'old' ? (l.outcome === 'done' ? 'done' : 'stopped') : BOARD_TOKEN[l.board] ?? 'idle';
const groupWord = id => LANE_SHOW.find(g => g[0] === id)?.[1] ?? id;

// ---------- the now line (one plain sentence with numbers and times) ----------
const hm = iso => (iso ? `${String(iso).slice(11, 16)}Z` : '');
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
export function nowLine(l, now) {
  const t = String(l.text ?? ''), at = l.ended ? ` at ${hm(l.ended)}` : '', ago = l.ended ? `, ${laneAge(now - Date.parse(l.ended))} ago` : '';
  const rule = !l.rule || l.rule.text === t ? '' : ` ${cap(l.rule.text)}.`;   // lifecycle.mjs: which rule acts on it and when
  let m;
  if (l.board === 'needs' && l.ask) return `Waits for your answer to ${l.ask}.${rule}`;
  if (l.handoff?.text) return `${cap(l.handoff.text)}.`;
  if ((m = t.match(/^running (.*?) for (\d+) min(?: \/ budget (\d+))?(.*)$/))) return `Running ${m[1]} for ${m[2]} min${m[3] ? ` of ${m[3]}` : ''}${m[4] ? ` ${m[4].replace(/^ - /, '- ')}` : ''}.`.replace(/\s+\./, '.');
  if ((m = t.match(/^exited: STOPPED:?\s*(.*)$/))) return `Stopped${at}${m[1] ? `: ${m[1]}` : ''}${ago}.${rule}`;
  if (t === 'exited: DONE') return `Done${at}${ago}.${rule}`;
  if (t === 'lost') return `Run lost${at}: no heartbeat${ago}.${rule}`;
  if (t.startsWith('exited: ')) return `${cap(t.slice(8))}${at}${ago}.${rule}`;
  if (l.waits?.length) return `Queued: waits for ${l.waits.join(', ')}.`;
  return `${cap(t)}.${rule}`.replace(/\.\.$/, '.');
}
// progress and pace: the brief's line, pace as a word on a tint (never a shape), the elapsed-vs-budget bar drawn by CSS from the
// run's start (its width grows from elapsed / budget to 100 % over the remaining minutes; static under QUIET / reduced motion)
const PACE = { 'on track': 'ok', testing: 'ok', slow: 'warn', stalled: 'bad' };
function progress(l, now) {
  const g = l.progress, pace = g?.pace?.state ? `<span class="pace p-${PACE[g.pace.state] ?? 'idle'}" title="${esc(g.slow?.line ?? g.pace.words ?? '')}">${esc(g.pace.state)}</span>` : '';
  const el = l.run_state === 'running' && l.started ? Math.max(0, (now - Date.parse(l.started)) / 60000) : null, b = Number(l.budget_min) || 0;
  const bar = el != null && b ? `<span class="ebar" role="img" aria-label="${Math.round(el)} of ${b} min"><i style="--from:${Math.min(100, el / b * 100).toFixed(1)}%;--dur:${Math.max(0, Math.round((b - el) * 60))}s"></i></span>` : '';
  return !g && !bar ? '' : `<div class="lprog small">${pace}${g ? `<span class="pline">${esc(g.line)}</span>` : ''}${bar}</div>`;
}
// ---------- the run strip: up to 6 beads oldest left, joined on a hand-off chain, "!" for an open question, helpers on the bead ----------
const beadTip = r => `${r.id}${r.name ? ` ${r.name}` : ''}: ${r.word}, ${r.min} min${r.cont ? ', resumes the run before' : ''}${r.helpers ? `, ${r.helpers} helper${r.helpers === 1 ? '' : 's'}` : ''}`;
export function strip(l) {
  const rs = l.runs || [];
  if (!rs.length && !l.ask) return '<span class="lstrip none small mute">no runs</span>';
  const more = (l.runs_total ?? rs.length) - rs.length;
  return `<ol class="lstrip" aria-label="${esc(`Runs of ${l.name}, oldest first`)}">${more > 0 ? `<li class="bmore small mute" title="${more} older run${more === 1 ? '' : 's'}">+${more}</li>` : ''}${rs.map(r =>
    `<li class="bd t-${RUN_TOKEN[r.cls] ?? 'idle'}${r.cont ? ' cont' : ''}" title="${esc(beadTip(r))}"><span class="sr">${esc(beadTip(r))}</span>${shape(RUN_TOKEN[r.cls] ?? 'idle')}${r.helpers ? `<b class="hc">${r.helpers}</b>` : ''}</li>`).join('')}${
    l.ask ? `<li class="bd t-needs ask" title="${esc(`${l.ask}: an open question parks the lane`)}"><span class="sr">${esc(`${l.ask}: open question`)}</span>${shape('needs')}</li>` : ''}</ol>`;
}
// ---------- the PR track: done -> PR -> merged -> installed (lib/lanes.mjs prStep), with the PR number ----------
const STEPS = [['done', 'done'], ['pr', 'PR'], ['merged', 'merged'], ['installed', 'installed']];
export function track(d) {
  if (!d) return '<span class="ltrack none"></span>';
  const k = STEPS.findIndex(s => s[0] === d.step), num = d.pr != null ? `#${d.pr}` : '';
  const label = `PR track: ${STEPS[k][1]}${num ? ` (PR ${num})` : ''}`;
  return `<span class="ltrack" role="img" aria-label="${esc(label)}" title="${esc(`done → PR → merged → installed: ${STEPS[k][1]}`)}">${STEPS.map((s, i) => `<i class="${i <= k ? 'on' : ''}${i === k ? ' at' : ''}"></i>`).join('')}<span class="small">${
    d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(num)}</a>` : esc(num || STEPS[k][1])}</span></span>`;
}
// ---------- the row's actions: at most 3, the first the way out of its group (in the accent where it answers the owner) ----------
const btn = (act, l, word, cls = '', extra = '') => `<button${cls ? ` class="${cls}"` : ''} data-act="${act}" data-project="${esc(l.project)}" ${act === 'archive' || act === 'lane-undo' ? `data-lane="${esc(l.name)}"` : `data-run="${esc(l.run)}"`}${extra}>${word}</button>`;
function actions(l) {
  const feed = l.run ? `<button data-act="lane-feed" data-project="${esc(l.project)}" data-run="${esc(l.run)}" title="Open ${esc(l.run)} in the live feed">Feed</button>` : '';
  const pa = pauseAct(l.pause, l.project, l.run).replace('data-act="run-resume"', 'class="primary" data-act="run-resume"');   // RM-37: Pause / pausing / Resume
  const arch = btn('archive', l, 'Archive', 'ghost'), inbox = word => `<button class="primary" data-tab="inbox">${word}</button>`;
  const pr = l.dlv?.url ? `<a class="btn primary" href="${esc(l.dlv.url)}" target="_blank" rel="noopener">Open PR</a>` : '';
  const a = { needs: [inbox(l.ask ? 'Answer' : 'Open Inbox'), feed], running: [pa, feed, l.run ? btn('stop', l, 'Stop') : ''], stopped: [pa, feed, arch],
    waiting: [feed, arch], land: [pr, feed, arch], parked: [inbox('Open Inbox'), feed], archived: [feed, btn('lane-undo', l, 'Unarchive', 'ghost')] }[l.board] ?? [feed, arch];
  return a.filter(Boolean).slice(0, 3);
}
// ---------- the open row: the lane's flow (runs left to right, hand-offs, helpers, the check-in that started the run, branch + PR),
// the brief checklist with evidence, why slow, the goal with its links, and the facts the closed row leaves out ----------
function flow(l) {
  const rs = l.runs || [], last = rs.at(-1);
  const steps = rs.map((r, i) => `${i ? `<span class="fl-j${r.cont ? ' cont' : ''}" title="${r.cont ? 'hand-off: resumes the run before' : 'a fresh start'}">${r.cont ? '⇢ hand-off' : '· fresh start'}</span>` : ''}<span class="fl-run t-${RUN_TOKEN[r.cls] ?? 'idle'}">${shape(RUN_TOKEN[r.cls] ?? 'idle')}<b>${esc(r.id)}</b> ${esc(r.name ?? '')} <span class="mute">${esc(r.word)} · ${r.min} min</span>${r.helpers ? ` <span class="fl-h">+${r.helpers} helper${r.helpers === 1 ? '' : 's'}</span>` : ''}</span>`).join('');
  const by = last?.by ? `<span class="small mute">${esc(last.id)} started by <b>${esc(last.by)}</b></span>` : '';
  const ask = l.ask ? `<span class="fl-j">→</span><span class="fl-run t-needs">${shape('needs')}<b>${esc(l.ask)}</b> <span class="mute">open question</span></span>` : '';
  const to = l.dlv ? `<span class="fl-j">→</span><span class="fl-run">${l.dlv.branch ? `<span class="mono">${esc(l.dlv.branch)}</span> ` : ''}${track(l.dlv)}</span>` : '';
  return `<div class="lflow" aria-label="Lane flow">${steps || '<span class="mute small">no runs yet</span>'}${ask}${to}</div>${by}`;
}
function expand(l, ctx, open) {
  const g = l.progress, usd = l.usd?.runs ? `<span>${l.usd.live ? '~' : ''}$${l.usd.total.toFixed(2)} to date</span>` : '';
  const ex = l.executor && exClass(l.executor) !== 'claude' ? '' : l.executor ? `<span>${esc(l.executor)}</span>` : '';
  const facts = [`<span class="mono">${esc(l.id)}</span>`, l.run ? `<span class="mono">${esc(l.run)}</span>${l.run_name ? ` ${esc(l.run_name)}` : ''}` : '', ex, usd, `<span class="mute">${esc(l.text ?? '')}</span>`].filter(Boolean).join(' · ');
  const path = l.path ? `<div class="small">${l.path.red ? chip('bad', l.path.text) : esc(l.path.text)}</div>` : '';
  return `<div class="lexp" id="lx-${esc(l.name)}"${open ? '' : ' hidden'}>${flow(l)}
    <div class="lexp-cols"><div>${g ? `<div class="small"><b>${esc(g.stage ?? 'Brief')}</b>: ${esc(g.line)}</div>${progDetail(g)}${g.slow?.line ? `<p class="small lslow"><b>Why slow:</b> ${esc(g.slow.line)}</p>` : ''}` : '<p class="small mute">No brief checklist for this run.</p>'}</div>
    <div>${laneWhy(l.driver)}${laneKind(l)}${overlapChips(l.overlap)}${path}<div class="small lfacts">${facts}</div><div class="rowacts">${l.board !== 'archived' ? btn('archive', l, 'Archive', 'ghost') : ''}</div></div></div></div>`;
}
function row(l, ctx) {
  const k = laneKey(l.project, l.name), open = ctx.laneOpen?.has(k), why = ctx.laneRefused?.[k], tok = tileToken(l), late = /heartbeat late/.test(l.text ?? '');
  const tag = l.executor && exClass(l.executor) !== 'claude' ? ` ${chip(exClass(l.executor), l.executor)}` : '';   // the executor only when not the default
  const word = `${groupWord(l.board)}${late ? ', heartbeat late' : ''}`;
  return `<article class="lrow b-${esc(l.board)}" id="lane-${esc(l.name)}" data-type="${esc(l.lane_type?.type ?? '')}">
    <span class="ltile t-${tok}" role="img" aria-label="${esc(word)}" title="${esc(word)}">${shape(tok)}</span>
    <div class="lmain"><div class="lhead"><b class="lname">${projTag(ctx, l.project)}${esc(l.name)}</b>${l.lane_type?.type ? ` <span class="ltype small mute" title="${esc(`type from ${l.lane_type.signal ?? '-'}`)}">${esc(l.lane_type.type)}</span>` : ''}${tag} ${homeChip(l)}${pendingChips(l)}${(l.waits || []).map(w => ` <span class="waits small">waits for ${esc(w)}</span>`).join('')}</div>
      <div class="lnow small" title="${esc(nowLine(l, ctx.now))}">${esc(nowLine(l, ctx.now))}</div>${why ? `<div class="lane-refused small">${esc(why)}</div>` : ''}</div>
    ${progress(l, ctx.now) || '<span class="lprog"></span>'}${strip(l)}${track(l.dlv)}
    <div class="rowacts">${actions(l).join(' ')}</div>
    <button class="lopen" data-act="lane-open" data-project="${esc(l.project)}" data-lane="${esc(l.name)}" aria-expanded="${!!open}" aria-controls="lx-${esc(l.name)}" aria-label="${esc(`${open ? 'Close' : 'Open'} ${l.name}`)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
    ${expand(l, ctx, open)}</article>`;
}
const LEGEND = `<div class="llegend small" aria-label="Strip legend"><span class="lg-i"><span class="bd t-done">${shape('done')}</span><span class="bd t-done cont">${shape('handoff')}</span> joined = a hand-off chain, a gap = a fresh start</span>
  <span class="lg-i"><span class="bd t-running">${shape('running')}<b class="hc">2</b></span> helpers working for the run</span><span class="lg-i"><span class="bd t-needs">${shape('needs')}</span> an open question</span>
  <span class="lg-i">${['running', 'done', 'handoff', 'stopped', 'idle'].map(t => `<span class="bd t-${t}">${shape(t)}</span>`).join('')} running · done · hand-off · stopped / lost · queued</span>
  <span class="lg-i"><span class="ltrack" aria-hidden="true"><i class="on"></i><i class="on at"></i><i></i><i></i></span> done → PR → merged → installed</span></div>`;

export function lanes(d, ctx) {
  const show = new Set(ctx.laneShow ?? LANE_SHOW_DEFAULT), hide = ctx.archiving ?? new Set(), undo = ctx.laneUndo, now = ctx.now ?? Date.now();
  const all = (d.lanes || []).filter(l => !hide.has(laneKey(l.project, l.name))), n = k => all.filter(l => l.board === k).length;
  // MAIL-29: the type filter - one type at a time (none = all); its chips count the types of the rows the groups show ("no type" once, here)
  const kind = ctx.laneType ?? null, typeOf = l => l.lane_type?.type ?? 'no type', shown = all.filter(l => show.has(l.board));
  const kinds = [...new Set([...shown.map(typeOf), ...(kind ? [kind] : [])])].sort();
  const rows = shown.filter(l => !kind || typeOf(l) === kind);
  const groups = LANE_SHOW.filter(([k]) => show.has(k)).map(([k, w]) => { const rs = rows.filter(l => l.board === k);
    return !rs.length ? '' : `<section class="lgroup g-${k}" aria-labelledby="lg-${k}"><h2 class="lgh" id="lg-${k}">${esc(w)} <b>${rs.length}</b></h2>${rs.map(l => row(l, ctx)).join('')}</section>`; }).join('');
  const gbtn = ([k, w]) => `<button class="${LINKS.includes(k) ? 'lnk' : 'hf'}" data-act="lane-show" data-show="${k}" aria-pressed="${show.has(k)}">${esc(w)} <b>${n(k)}</b></button>`;
  const help = `<details class="lhelp"><summary aria-label="About this list">?</summary><div class="small">Lanes come from LANE records only (no folder scan). A lane's state is its latest run, whatever executor owns it. <b>Needs you</b> holds only the lanes an Inbox row names; <b>Old</b> = ended more than 7 days ago without DONE, or done before today.</div></details>`;
  return `${backlogLine(d.backlog)}
   ${undo ? `<div class="banner lane-undo" id="lane-undo">Archived ${esc(undo.lane)}. <button data-act="lane-undo" data-project="${esc(undo.project)}" data-lane="${esc(undo.lane)}">Undo</button></div>` : ''}
   <div class="filters lfilters"><span class="lane-show" role="group" aria-label="Show lane groups">${LANE_SHOW.filter(g => !LINKS.includes(g[0])).map(gbtn).join('')}</span>
    <input type="search" data-filter="lanes" placeholder="filter lanes" aria-label="Filter lanes"><span class="lane-show lane-links">${LANE_SHOW.filter(g => LINKS.includes(g[0])).map(gbtn).join(' · ')}</span>${help}
    ${kinds.length > 1 || kind ? `<span class="lane-show lane-types" role="group" aria-label="Lane type">${kinds.map(k => `<button class="hf" data-act="lane-type" data-type="${esc(k)}" aria-pressed="${k === kind}">${esc(k)} <b>${shown.filter(l => typeOf(l) === k).length}</b></button>`).join('')}</span>` : ''}</div>
   <div class="lboard" data-rows="lanes">${groups || `<p class="mute">${all.length ? 'No lanes under these filters.' : 'No LANE records.'}</p>`}</div>${all.length ? LEGEND : ''}`;
}
