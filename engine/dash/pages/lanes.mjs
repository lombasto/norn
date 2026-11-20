// The Lanes page (stage LANES, SPEC 4.2: "the attention board"): one list grouped by what the owner must do. Each row: a state
// tile, name, the now line, progress and pace, the run strip (the retired Map's lane band as beads), the PR track and at most 3
// actions; the chevron opens the lane's flow and brief in place (S.laneOpen keeps it open through a stream repaint). No timer:
// the elapsed bar is a CSS animation, rows redraw on stream events only. Its Branches / Worktrees sub-views list every branch and worktree.
import { esc, fin, dash, chip, exClass, projTag, homeChip, pendingChips, pauseAct, progDetail, backlogLine, runWho, landChip, int, plural, fmtTime } from '../cells.mjs';
import { capStrip } from '../widgets.mjs';
import { renderMarkdown } from '../docs.mjs';
import { SUB_CAP, subviewPage, subMore } from '../subviews.mjs';

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
// NORN-UI-SYNC (S6b follow-up #2): a lane whose branch is predicted to conflict with another home's open branch (overlap.mjs: git
// merge-tree on the two tips) carries one "conflicts with <home>" chip per home in its row; the branches and files are its tooltip
export const conflictChips = cs => [...new Set((cs || []).map(c => c.home))].map(h => {
  const mine = cs.filter(c => c.home === h), tip = mine.flatMap(c => [`${c.ref}: ${c.n} file${c.n === 1 ? '' : 's'}`, ...(c.files || []).map(x => '  ' + x)]).join('\n');
  return ` <span class="chip bad lane-conflict" title="${esc(tip)}">conflicts with ${esc(h)}</span>`; }).join('');
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
const hm = iso => (iso ? fmtTime(iso) : '');
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
const beadTip = r => `${r.id}${r.dwarf || r.kind_word ? ` ${r.dwarf?.name ?? r.kind_word}` : ''}: ${r.word}, ${r.min} min${r.cont ? ', resumes the run before' : ''}${r.helpers ? `, ${r.helpers} helper${r.helpers === 1 ? '' : 's'}` : ''}`;
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
  const steps = rs.map((r, i) => `${i ? `<span class="fl-j${r.cont ? ' cont' : ''}" title="${r.cont ? 'hand-off: resumes the run before' : 'a fresh start'}">${r.cont ? '⇢ hand-off' : '· fresh start'}</span>` : ''}<span class="fl-run t-${RUN_TOKEN[r.cls] ?? 'idle'}">${shape(RUN_TOKEN[r.cls] ?? 'idle')}<b>${esc(r.id)}</b>${runWho(r.dwarf, r.kind_word)} <span class="mute">${esc(r.word)} · ${r.min} min</span>${r.helpers ? ` <span class="fl-h">+${r.helpers} helper${r.helpers === 1 ? '' : 's'}</span>` : ''}</span>`).join('');
  const by = last?.by ? `<span class="small mute">${esc(last.id)} started by <b>${esc(last.by)}</b></span>` : '';
  const ask = l.ask ? `<span class="fl-j">→</span><span class="fl-run t-needs">${shape('needs')}<b>${esc(l.ask)}</b> <span class="mute">open question</span></span>` : '';
  const to = l.dlv ? `<span class="fl-j">→</span><span class="fl-run">${l.dlv.branch ? `<span class="mono">${esc(l.dlv.branch)}</span> ` : ''}${track(l.dlv)}</span>` : '';
  return `<div class="lflow" aria-label="Lane flow">${steps || '<span class="mute small">no runs yet</span>'}${ask}${to}</div>${by}`;
}
// lane-outputs: Details in the open row loads the lane's findings, outputs, rulings and PRs above the board (S.laneDetail; GET /api/lane)
const detailBtn = (l, ctx) => `<button data-act="lane-detail" data-project="${esc(l.project)}" data-lane="${esc(l.name)}" aria-pressed="${ctx.laneDetail === laneKey(l.project, l.name)}" title="Findings, outputs, rulings and PRs of ${esc(l.name)}">Details</button> `;
function expand(l, ctx, open) {
  // fair-slots item 2: the figure sums every run of the lane, and says so
  const g = l.progress, usd = l.usd?.runs ? `<span class="mono lane-usd" title="every run of the lane; ~ = one is still running (an estimate)">${l.usd.live ? '~' : ''}$${l.usd.total.toFixed(2)} to date, all runs</span>` : '';
  const ex = l.executor && exClass(l.executor) !== 'claude' ? '' : l.executor ? `<span>${esc(l.executor)}</span>` : '';
  const facts = [`<span class="mono">${esc(l.id)}</span>`, l.run ? `<span class="mono">${esc(l.run)}</span>${runWho(l.dwarf, l.kind_word)}` : '', ex, usd, `<span class="mute">${esc(l.text ?? '')}</span>`].filter(Boolean).join(' · ');
  const path = l.path ? `<div class="small">${l.path.red ? chip('bad', l.path.text) : esc(l.path.text)}</div>` : '';
  return `<div class="lexp" id="lx-${esc(l.name)}"${open ? '' : ' hidden'}>${flow(l)}
    <div class="lexp-cols"><div>${g ? `<div class="small"><b>${esc(g.stage ?? 'Brief')}</b>: ${esc(g.line)}</div>${progDetail(g)}${g.slow?.line ? `<p class="small lslow"><b>Why slow:</b> ${esc(g.slow.line)}</p>` : ''}` : '<p class="small mute">No brief checklist for this run.</p>'}</div>
    <div>${laneWhy(l.driver)}${laneKind(l)}${overlapChips(l.overlap)}${path}<div class="small lfacts">${facts}</div><div class="rowacts">${detailBtn(l, ctx)}${l.board !== 'archived' ? btn('archive', l, 'Archive', 'ghost') : ''}</div></div></div></div>`;
}
function row(l, ctx) {
  const k = laneKey(l.project, l.name), open = ctx.laneOpen?.has(k), why = ctx.laneRefused?.[k], tok = tileToken(l), late = /heartbeat late/.test(l.text ?? '');
  const tag = l.executor && exClass(l.executor) !== 'claude' ? ` ${chip(exClass(l.executor), l.executor)}` : '';   // the executor only when not the default
  const word = `${groupWord(l.board)}${late ? ', heartbeat late' : ''}`;
  return `<article class="lrow b-${esc(l.board)}" id="lane-${esc(l.name)}" data-type="${esc(l.lane_type?.type ?? '')}">
    <span class="ltile t-${tok}" role="img" aria-label="${esc(word)}" title="${esc(word)}">${shape(tok)}</span>
    <div class="lmain"><div class="lhead"><b class="lname">${projTag(ctx, l.project)}${esc(l.name)}</b>${l.lane_type?.type ? ` <span class="ltype small mute" title="${esc(`type from ${l.lane_type.signal ?? '-'}`)}">${esc(l.lane_type.type)}</span>` : ''}${tag} ${homeChip(l)}${pendingChips(l)}${conflictChips(l.conflicts)}${l.land ? ` ${landChip(l)}` : ''}${l.priority ? ` ${prioChip(l)}` : ''}${(l.waits || []).map(w => ` <span class="waits small">waits for ${esc(w)}</span>`).join('')}</div>
      <div class="lnow small" title="${esc(nowLine(l, ctx.now))}">${esc(nowLine(l, ctx.now))}</div>${nextLine(l)}${why ? `<div class="lane-refused small">${esc(why)}</div>` : ''}</div>
    ${progress(l, ctx.now) || '<span class="lprog"></span>'}${strip(l)}${track(l.dlv)}
    <div class="rowacts">${actions(l).join(' ')}</div>
    <button class="lopen" data-act="lane-open" data-project="${esc(l.project)}" data-lane="${esc(l.name)}" aria-expanded="${!!open}" aria-controls="lx-${esc(l.name)}" aria-label="${esc(`${open ? 'Close' : 'Open'} ${l.name}`)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
    ${expand(l, ctx, open)}</article>`;
}
const LEGEND = `<div class="llegend small" aria-label="Strip legend"><span class="lg-i"><span class="bd t-done">${shape('done')}</span><span class="bd t-done cont">${shape('handoff')}</span> joined = a hand-off chain, a gap = a fresh start</span>
  <span class="lg-i"><span class="bd t-running">${shape('running')}<b class="hc">2</b></span> helpers working for the run</span><span class="lg-i"><span class="bd t-needs">${shape('needs')}</span> an open question</span>
  <span class="lg-i">${['running', 'done', 'handoff', 'stopped', 'idle'].map(t => `<span class="bd t-${t}">${shape(t)}</span>`).join('')} running · done · hand-off · stopped / lost · queued</span>
  <span class="lg-i"><span class="ltrack" aria-hidden="true"><i class="on"></i><i class="on at"></i><i></i><i></i></span> done → PR → merged → installed</span></div>`;

// fair-slots item 3: the queued / running run's priority + its place in the fill order, one short chip in the row head; a run
// with no priority shows the default P2, faded and said so in its title
export const prioChip = l => !l.priority ? '' : `<span class="chip idle prio${l.priority.dflt ? ' dflt' : ''}" title="${esc(`priority ${l.priority.p}${l.priority.dflt ? ' (default: the run has no priority)' : ''}${l.position ? ` · #${l.position} in this project's fill order` : ''}`)}">${esc(l.priority.p)}${l.position ? ` #${l.position}` : ''}</span>`;
// lane-outputs item 8: what happens next on a lane whose last run ended (laneout.mjs laneNext) - never a bare DONE - with the run's own
// last summary line under it, the open rulings as an 'Open decisions' chip (to the Inbox) and the background work its CLI cut off
const nextLine = l => !l.next ? '' : `<div class="lane-next small">${chip(l.next.cls, l.next.words)}${l.asks_open ? ` <button class="chip needs lnk" data-tab="inbox" title="rulings on this lane with no answer yet">Open decisions: ${int(l.asks_open)}</button>` : ''}${l.cutoff ? ` ${chip('warn', `background work cut off: ${l.cutoff.join(', ')}`)}` : ''}</div>${l.status_line ? `<div class="lane-status small mute" title="the run's own last summary line">${esc(l.status_line)}</div>` : ''}`;
const kb = n => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
/**
 * lane-outputs item 2: one file shown in place, read-only - an image as itself, Markdown rendered (headings, tables, code), any other
 * text with its line numbers. f = a Docs reader file (GET /api/docs?part=file&file=path:<abs>: the one path guard, pathDoc); the Tests
 * tab's code viewer can show its files through the same function.
 */
export function fileViewer(f, ctx = {}) {
  if (!f) return '';
  if (f.error) return `<div class="fileview card small">${chip('bad', 'not shown')} ${esc(f.error)}</div>`;
  const head = `<div class="fileview-head"><b>${esc(f.name)}</b> <span class="small mute inspath">${esc(f.path)}</span> <button class="ghost" data-act="lane-file-close">Close</button></div>`;
  if (f.image) return `<div class="fileview card">${head}<img class="fileview-img" alt="${esc(f.name)}" src="${esc(`/api/file?project=${encodeURIComponent(ctx.project ?? '')}&path=${encodeURIComponent(f.path)}`)}"></div>`;
  if (!f.code && /\.(?:md|markdown)$/i.test(f.path ?? '')) return `<div class="fileview card">${head}<article class="md">${renderMarkdown(f.text ?? '', { sanitize: ctx.sanitize }).html}</article></div>`;
  const lines = String(f.text ?? '').split(/\r?\n/);
  return `<div class="fileview card">${head}<div class="docsrc fileview-src"><table><tbody>${lines.map((t, i) => `<tr><td class="ln mute">${i + 1}</td><td class="lt"><code>${esc(t)}</code></td></tr>`).join('')}</tbody></table></div></div>`;
}
const PR_CLS = { open: 'needs', approved: 'running', merged: 'ok', closed: 'idle' };
/**
 * lane-outputs: a lane's details (GET /api/lane) - Findings (the run's 'Summary for the owner', verbatim) on top, what happens next,
 * the follow-up (the plan's decision, who picked each stage and when, where each stage is now; every ruling asked on the lane with its
 * answer), every PR the lane produced, and the Outputs: each file its runs wrote to the notes folder, grouped, with size, time and
 * the run that wrote it; a tap opens it in place (fileViewer). `file` = the open file.
 */
export function laneDetail(d, ctx = {}, file = null) {
  if (!d) return `<section class="card lane-det" id="lane-det"><p class="small mute">loading ...</p></section>`;
  if (d.error) return `<section class="card lane-det" id="lane-det">${chip('bad', 'not loaded')} <span class="small">${esc(d.error)}</span> <button class="ghost" data-act="lane-detail-close">Close</button></section>`;
  const t = iso => (iso ? esc(fmtTime(iso, ctx.now)) : '?');
  const find = d.findings ? `<div class="md lane-find">${renderMarkdown(d.findings.text, { sanitize: ctx.sanitize }).html}</div>` : `<p class="small mute">No 'Summary for the owner' in the lane's NOTES.md.</p>`;
  const plan = !d.plan ? '' : `<h4>${esc(d.plan.title)} <span class="small mute">(${esc(d.plan.run)}${d.plan.open ? `, ${plural(d.plan.open, 'stage')} to pick` : ''})</span></h4><ul class="small lane-stages">${d.plan.stages.map(s => `<li><b>${esc(s.key)}</b> ${esc(s.title || '')} - ${esc(s.where)}${s.by ? ` <span class="mute">(picked by ${esc(s.by)}, ${t(s.at)})</span>` : ''}</li>`).join('')}</ul>`;
  const asks = !d.asks?.length ? '' : `<h4>Rulings asked on this lane</h4><ul class="small lane-asks">${d.asks.map(a => `<li>${chip(a.open ? 'needs' : 'ok', a.open ? 'open' : a.state)} <a data-rid="${esc(a.id)}" href="#">${esc(a.id)}</a> ${esc(a.title)}${a.answer ? `<div class="mute">answer: ${esc([a.answer.choice && `(${a.answer.choice})`, a.answer.text].filter(Boolean).join(' '))} - ${esc(a.answer.by)}, ${t(a.answer.at)}</div>` : ''}</li>`).join('')}</ul>`;
  const prs = !d.prs?.length ? '' : `<h4>Pull requests</h4><ul class="small lane-prs">${d.prs.map(p => `<li>${/^https:\/\//.test(p.url || '') ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">PR #${esc(p.number ?? '?')}</a>` : `PR #${esc(p.number ?? '?')}`} ${chip(PR_CLS[p.state] ?? 'idle', p.state)}${p.merged_at ? ` merged ${t(p.merged_at)}` : ''}<span class="mute"> ${esc(p.branch ?? '')} · ${esc(p.dlv ?? '')}</span></li>`).join('')}</ul>`;
  const open = file?.path;
  const outs = !d.outputs?.length ? `<p class="small mute">Nothing in ${esc(d.dir)}.</p>` : d.outputs.map(g => `<h4>${esc(g.label)} <span class="small mute">${int(g.files.length)}</span></h4><ul class="small lane-files">${g.files.map(f => `<li${f.path === open ? ' class="on"' : ''}><button class="lnk" data-act="lane-file" data-path="${esc(f.path)}">${esc(f.rel)}</button> <span class="mute">${kb(f.size)} · ${t(f.mtime)} · ${esc(f.run ?? 'no run')}</span></li>`).join('')}</ul>`).join('');
  const nr = d.written?.length ? `<div class="small">${chip('warn', 'written by the run that ended without a result')} ${esc(d.written.join(', '))}</div>` : '';
  return `<section class="card lane-det" id="lane-det"><div class="lane-det-head"><h3>${projTag(ctx, d.project)}${esc(d.lane)}</h3><button class="ghost" data-act="lane-detail-close">Close</button></div>
    ${nextLine(d)}<div class="lane-det-sec" id="lane-findings"><h4>Findings</h4>${find}</div>
    ${plan || asks ? `<div class="lane-det-sec" id="lane-follow"><h4>Follow-up</h4>${plan}${asks}</div>` : ''}${prs ? `<div class="lane-det-sec" id="lane-prs">${prs}</div>` : ''}
    <div class="lane-det-sec" id="lane-outputs"><h4>Outputs <span class="small mute inspath">${esc(d.dir)}</span></h4>${nr}${outs}</div>${fileViewer(file, ctx)}</section>`;
}
export function lanes(d, ctx) {
  const show = new Set(ctx.laneShow ?? LANE_SHOW_DEFAULT), hide = ctx.archiving ?? new Set(), undo = ctx.laneUndo;
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
   ${d.capacity?.rows?.length ? `<div class="card" id="lanes-cap" style="margin-bottom:12px">${capStrip(d.capacity, { id: 'lanes-capstrip', mine: ctx.project })}</div>` : ''}
   <div class="filters lfilters"><span class="fchips" role="group" aria-label="Show lane groups">${LANE_SHOW.filter(g => !LINKS.includes(g[0])).map(gbtn).join('')}</span>
    <input type="search" data-filter="lanes" placeholder="filter lanes" aria-label="Filter lanes"><span class="fchips lane-links">${LANE_SHOW.filter(g => LINKS.includes(g[0])).map(gbtn).join(' · ')}</span>${help}
    ${kinds.length > 1 || kind ? `<span class="fchips lane-types" role="group" aria-label="Lane type">${kinds.map(k => `<button class="hf" data-act="lane-type" data-type="${esc(k)}" aria-pressed="${k === kind}">${esc(k)} <b>${shown.filter(l => typeOf(l) === k).length}</b></button>`).join('')}</span>` : ''}</div>
   ${ctx.laneDetail ? laneDetail(ctx.laneDet, ctx, ctx.laneFile) : ''}
   <div class="lboard" data-rows="lanes">${groups || `<p class="mute">${all.length ? 'No lanes under these filters.' : 'No LANE records.'}</p>`}</div>${all.length ? LEGEND : ''}`;
}

// owner ask 2026-11-19 ("see what lane they belong to, if it's stale or in progress, merged, lost, unknown, not part of a lane"): the
// Lanes page has 3 sub-views (subviews.mjs): Lanes (the lane table above), Branches (every local / origin branch of the repo, one row each)
// and Worktrees (every worktree, detached merge worktrees too). The rows and their state come from branches.mjs (the tick's cached scan +
// the records now); filters (state chips, local / origin, lane) are the page's own (index.html S.br). Row actions only on a click, with Undo.
export const LANES_SUBS = [['lanes', 'Lanes'], ['branches', 'Branches'], ['worktrees', 'Worktrees']];
export const BRANCH_CHIP = { 'in progress': 'running', 'awaiting merge': 'needs', unknown: 'warn', lost: 'lost', stale: 'idle', merged: 'done' };
export const BR_WHERE = [['all', 'All'], ['local', 'Local only'], ['remote', 'Origin only'], ['both', 'Both']];
const brOf = (d, sub) => (d.rows || []).filter(r => (sub === 'worktrees' ? !!r.worktree : r.kind === 'branch'));
export function lanesPage(d, ctx) {
  const sub = d.sub ?? 'lanes', n = k => (sub === 'lanes' ? (k === 'lanes' ? (d.lanes || []).length : undefined) : k === 'lanes' ? undefined : brOf(d, k).length);
  const c = d.counts || {}, nums = sub === 'lanes' ? [] : [{ n: c['in progress'] ?? 0, label: 'in progress' }, { n: c['awaiting merge'] ?? 0, label: 'awaiting merge', cls: c['awaiting merge'] ? 'warn' : '' },
    { n: (c.unknown ?? 0) + (c.lost ?? 0), label: 'unknown / lost', cls: c.lost ? 'bad' : '' }, { n: (c.stale ?? 0) + (c.merged ?? 0), label: 'merged / stale' }];
  return subviewPage('lanes', { title: 'Lanes', numbers: nums, views: LANES_SUBS.map(([k, l]) => [k, l, n(k)]), active: sub, body: sub === 'lanes' ? lanes(d, ctx) : branchesPart(d, ctx, sub) });
}
const brAge = (ms, now) => (fin(ms) ? laneAge(now - ms) : '-');
function branchesPart(d, ctx, sub) {
  const now = ctx.now ?? Date.now(), f = ctx.br ?? {}, states = f.states?.size ? f.states : null, where = f.where ?? 'all', lane = f.lane ?? '', limit = d.limit || SUB_CAP, undo = ctx.brUndo;
  const scans = (d.scans || []).map(x => `${projTag(ctx, x.project)}${x.at ? `scanned ${esc(brAge(Date.parse(x.at), now))} ago` : 'not scanned yet'}${x.error ? ' ' + chip('bad', x.error) : ''}`).join(' · ');
  const one = ctx.project && ctx.project !== 'all';
  const base = brOf(d, sub), lanesIn = [...new Set(base.map(r => r.lane?.name).filter(Boolean))].sort();
  const pass = r => (!states || states.has(r.state)) && (where === 'all' || r.where === where) && (!lane || (lane === '-' ? !r.lane : r.lane?.name === lane));
  const shown = base.filter(pass), rows = shown.slice(0, limit);
  const stChips = (d.states || []).map(k => `<button class="hf" data-act="br-state" data-state="${esc(k)}" aria-pressed="${!states || states.has(k)}">${esc(k)} <b>${base.filter(r => r.state === k).length}</b></button>`).join('');
  const whChips = sub === 'worktrees' ? '' : `<span class="fchips" role="group" aria-label="Local or origin">${BR_WHERE.map(([k, t]) => `<button class="hf" data-act="br-where" data-where="${k}" aria-pressed="${where === k}">${esc(t)}</button>`).join('')}</span>`;
  const laneSel = `<select data-br="lane" aria-label="Lane"><option value="">every lane</option><option value="-"${lane === '-' ? ' selected' : ''}>not part of a lane</option>${lanesIn.map(l => `<option value="${esc(l)}"${lane === l ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const P = r => `data-project="${esc(r.project)}"`;
  const acts = r => [r.acts?.includes('delete') ? `<button class="ghost" data-act="br-delete" ${P(r)} data-branch="${esc(r.name)}" title="delete ${r.where === 'both' ? 'the local and origin copies' : r.where === 'remote' ? 'the origin copy' : 'the local branch'} (its work is on main; Undo puts it back)">Delete branch</button>` : '',
    r.acts?.includes('rmwt') ? `<button class="ghost" data-act="br-rmwt" ${P(r)} data-path="${esc(r.worktree.path)}" title="git worktree remove (clean: nothing uncommitted; the branch stays; Undo adds it back)">Remove worktree</button>` : '',
    r.pr_new ? `<a class="btn ghost" href="${esc(r.pr_new)}" target="_blank" rel="noopener" title="GitHub's new pull request page for this branch">Open PR</a>` : '',
    r.acts?.includes('adopt') ? `<button class="ghost" data-act="br-adopt" ${P(r)} data-branch="${esc(r.name)}" title="a LANE record for this branch (Undo archives it)">Adopt into a lane</button>` : ''].filter(Boolean).join(' ');
  const wt = r => !r.worktree ? dash : `<span class="mono small brpath" title="${esc(r.worktree.path)}">${esc(r.worktree.path.split('/').slice(-2).join('/'))}</span> ${r.worktree.missing ? chip('bad', 'missing') : r.worktree.dirty ? chip('warn', `${r.worktree.dirty} uncommitted`) : r.worktree.dirty === 0 ? chip('ok', 'clean') : ''}${r.worktree.primary ? ' ' + chip('idle', 'main checkout') : ''}`;
  const pr = r => !r.pr ? dash : r.pr.url ? `<a href="${esc(r.pr.url)}" target="_blank" rel="noopener">#${esc(r.pr.number ?? '?')}</a> ${chip(r.pr.state === 'open' ? 'needs' : r.pr.state === 'merged' ? 'done' : 'idle', r.pr.state)}` : chip('idle', r.pr.state);
  const dlv = r => (r.dlv ? `<div class="small"><span class="id">${esc(r.dlv.id)}</span>${r.dlv.via !== 'branch' ? ` <span class="mute">tracked as ${esc(r.dlv.branch)}</span>` : ''}</div>` : '');
  const run = r => (r.run ? `<div class="small"><span class="id">${esc(r.run.id)}</span> <span class="mute">${esc(r.run.outcome ? String(r.run.outcome).toUpperCase() : r.run.state)}</span></div>` : '');
  const tr = r => `<tr id="br-${esc(r.project)}-${esc(r.name.replace(/[^\w.-]/g, '_'))}" data-state="${esc(r.state)}"><td data-label="branch" class="brname"><b>${projTag(ctx, r.project)}${esc(r.name)}</b>${r.subject ? `<div class="small mute brsubj">${esc(r.subject)}</div>` : ''}${dlv(r)}</td>
    <td data-label="state">${chip(BRANCH_CHIP[r.state] ?? 'idle', r.state)}<div class="small mute brwhy">${esc(r.why)}</div></td>
    <td data-label="where">${r.kind === 'worktree' ? chip('idle', 'detached') : esc(r.where === 'remote' ? 'origin' : r.where)}${r.diverged ? ' ' + chip('warn', 'local and origin differ') : ''}</td>
    <td data-label="lane">${r.lane ? `${esc(r.lane.name)} ${chip(r.lane.state === 'gone' ? 'lost' : r.lane.state, r.lane.state)}` : '<span class="mute">not part of a lane</span>'}${run(r)}</td>
    <td data-label="worktree">${wt(r)}</td>
    <td data-label="ahead / behind" class="mono">${r.ahead === null || r.ahead === undefined ? dash : `+${int(r.ahead)} / -${int(r.behind)}`}${r.how === 'patches on main' ? '<div class="small mute">patches on main</div>' : ''}</td>
    <td data-label="last commit" class="small">${esc(brAge(r.last, now))}${r.author ? ` · ${esc(r.author)}` : ''}</td>
    <td data-label="PR">${pr(r)}</td><td><div class="rowacts">${acts(r)}</div></td></tr>`;
  const scanned = (d.scans || []).some(x => x.at);
  const empty = !scanned ? 'Not scanned yet: the tick scans every 10 minutes, or press Scan now.' : base.length ? 'Nothing under these filters.' : sub === 'worktrees' ? 'No worktree.' : 'No branch besides main.';
  return `<div class="banner">Every ${sub === 'worktrees' ? 'git worktree' : 'local and origin branch'} of the repo, from the last scan (git, refreshed by the tick): its lane, its state, ahead / behind main, its PR and deliverable. Nothing here is cleaned up by itself.</div>
   ${undo ? `<div class="banner" id="br-undo">${esc(undo.text)} <button data-act="br-undo" data-project="${esc(undo.project)}">Undo</button></div>` : ''}
   <div class="filters brfilters"><span class="small mute">${scans || 'not scanned yet'}</span>${one ? ` <button class="ghost" data-act="br-scan" data-project="${esc(ctx.project)}">Scan now</button>` : ''}</div>
   <div class="filters brfilters"><span class="fchips" role="group" aria-label="States">${stChips}</span>${whChips}${laneSel}</div>
   <div class="tablecard"><table class="brtab" data-rows="branches"><thead><tr><th>${sub === 'worktrees' ? 'worktree / branch' : 'branch'}</th><th>state</th><th>where</th><th>lane</th><th>worktree</th><th>ahead / behind</th><th>last commit</th><th>PR</th><th></th></tr></thead>
   <tbody>${rows.map(tr).join('') || `<tr><td colspan="9" class="mute">${esc(empty)}</td></tr>`}</tbody></table>${subMore(rows.length, shown.length)}</div>`;
}
