// The small cells every page shares - formatters, chips, the run / lane lines, the feed head and activity: moved down out of ui.mjs so
// that ui.mjs and pages/*.mjs both import them and no import goes back up (pages -> ui.mjs -> pages was a cycle).
import { meter, hoChip, fin } from './widgets.mjs';
import { esc } from './docs.mjs';
import { fmtDur } from './activity.mjs';
import { diffBlock } from './diffview.mjs';
// esc and fin have one home each (docs.mjs, widgets.mjs); a page takes them from here with the other cells
export { esc, fin };
// ---------- formatting ----------
export const dash = '<span class="mute">-</span>';
export const int = n => fin(n) ? Math.round(n).toLocaleString('en-US') : '-';
export const pct = (n, d = 1) => fin(n) ? `${n.toFixed(d)} %` : '-';
export const mTok = n => !fin(n) ? '-' : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`;
export function fmtMin(m) {
  if (!fin(m)) return '-';
  m = Math.max(0, Math.round(m));
  // past 48 h the hours stop reading at a glance: days + hours (stage NAV item 5)
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}
// ---------- the one filter-chip row every page uses (Lanes, Runs, Slop, Context, Ledger, Spend ...) ----------
// label = the group's aria-label; bs = [{ act, data: { show: 'x', ... }, text, n?, on, title? }]: a pressed chip filters, its <b> is the count.
// A page handles its own data-act; the look (.fchips, button.hf[aria-pressed]) lives once, in base.css.
export const filterChips = (label, bs, cls = '') => `<span class="fchips${cls ? ` ${cls}` : ''}" role="group" aria-label="${esc(label)}">${bs.map(b => `<button class="hf" data-act="${esc(b.act)}"${Object.entries(b.data || {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('')} aria-pressed="${!!b.on}"${b.title ? ` title="${esc(b.title)}"` : ''}>${esc(b.text)}${fin(b.n) ? ` <b>${int(b.n)}</b>` : ''}</button>`).join('')}</span>`;
// UTC times with a Z, ids and dates as the records carry them: today "02:14Z", older "10-30 22:20Z".
export function fmtTime(iso, now = Date.now()) {
  const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return '-';
  const d = new Date(t), hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
  return new Date(now).toISOString().slice(0, 10) === d.toISOString().slice(0, 10) ? hm : `${d.toISOString().slice(5, 10)} ${hm}`;
}
/** a run's dwarf (DWARVES 3.3): its display name, bold, with data-dwarf for the dossier link the Dwarves page adds (?tab=dwarves&dwarf=<id>) */
export const dwarfName = d => (d ? ` <b class="aname" data-dwarf="${esc(d.id)}">${esc(d.name)}</b>` : '');
/** who ran a run: its dwarf, else its kind word (a check-in, a merge, a run from before the crew) - never a blank */
export const runWho = (d, kw) => (d ? dwarfName(d) : kw ? ` <span class="mute">${esc(kw)}</span>` : '');
export const chip = (cls, txt) => `<span class="chip ${esc(cls)}">${esc(txt ?? cls)}</span>`;
// built-ins by name; every configured (typed) executor - API or cli - is an own-account executor ('prov')
export const exClass = ex => String(ex ?? '').startsWith('codex') ? 'codex' : !ex || ['claude', 'fake'].includes(ex) ? 'claude' : 'prov';
export function exChip(ex, model, effort) {
  const t = [ex, model && ex && String(model).startsWith(ex + '-') ? String(model).slice(ex.length + 1) : model].filter(Boolean).join(' ') + (effort && effort !== '-' ? ` · ${effort}` : '');
  return t ? chip(exClass(ex), t) : dash;
}
// Lane / run state text -> chip class + short word (lanes.mjs text grammar, design 5).
export function stateOf(text) {
  const t = String(text ?? '');
  if (t.startsWith('running') && t.includes(' - heartbeat late')) return ['warn', 'heartbeat late'];   // lanes.mjs: alive, its .hb behind
  if (t.startsWith('running')) return ['running', 'running'];
  if (t.startsWith('parked')) return ['parked', 'parked'];
  if (t === 'exited: DONE') return ['done', 'DONE'];
  if (t.startsWith('exited: STOPPED')) return ['stopped', 'STOPPED'];
  if (t.startsWith('exited: HANDOFF')) return ['handoff', 'HANDOFF'];
  if (t.startsWith('exited: no-result')) return ['no-result', 'no-result'];
  if (t.startsWith('exited: crash')) return ['bad', 'crash'];
  if (t === 'lost') return ['lost', 'lost'];
  if (t.startsWith('killed')) return ['bad', 'killed'];
  if (t.startsWith('waiting')) return ['warn', 'waiting'];
  if (t === 'no runs') return ['idle', 'no runs'];
  if (t.startsWith('shipped')) return ['done', 'shipped'];   // OVERVIEW-TRUTH (5): the lane's work is on main
  if (t.startsWith('withdrawn')) return ['idle', 'withdrawn'];
  return ['idle', t || '-'];
}
export const runChip = s => chip({ running: 'running', exited: 'done', finished: 'done', alive: 'running', stopped: 'idle', lost: 'lost', killed: 'bad' }[s] ?? 'idle', s ?? '-');
export const projTag = (ctx, p) => ctx.project === 'all' && p ? `<span class="id">${esc(p)}</span> ` : '';
export const homeChip = x => (x?.home ? `<span class="chip onhome" title="${esc(`written on home ${x.home}: home ${x.home} commits its changes`)}">on ${esc(x.home)}</span> ` : '');
export const pendingChips = x => (x?.pending || []).map(e => `<span class="chip pending" title="written here, applied once home ${esc(e.primary)} relays it">${esc(`${PAST[e.ev] ?? e.ev} on ${e.home}, pending ${e.primary}`)}</span>`).join(' ');
/** the worst of { page: 'ok'|'warn'|'bad'|null } states; null when none is known */
export const worstState = st => Object.values(st || {}).filter(v => v in RANK).reduce((w, v) => (w === null || RANK[v] > RANK[w] ? v : w), null);
// META-CTX-ENFORCE R1 (DIR-56): ONE context cell - the CURRENT context (last request) on a bar to the hard max, the tick = the hand-off
// line of the run's role (NORN-CTX-1M: "(1M tier)" when the run's model has the 1M window); red past the hand-off line, a chip naming which line it passed; the peak beside it when it was higher
export function ctxMeter(n, { codexNote = false } = {}) {
  if (!fin(n.ctx)) return `<span class="small mute">${codexNote && String(n.executor ?? '').startsWith('codex') ? 'n/a (codex: tokens at end)' : '-'}</span>`;
  const lim = fin(n.ctx_limit) ? n.ctx_limit : null, hard = fin(n.ctx_hard) ? n.ctx_hard : null;
  const over = hard && n.ctx >= hard ? 'over' : lim && n.ctx >= lim ? 'hot' : '';
  const flag = over === 'over' ? ` ${chip('bad', 'past hard max')}` : over === 'hot' ? ` ${chip('bad', 'past hand-off')}` : '';
  const peak = fin(n.ctx_peak) && n.ctx_peak > n.ctx ? ` · peak ${kTok(n.ctx_peak)}` : '';
  return `<span class="ctxm${over ? ' ' + over : ''}">${meter(n.ctx, Math.max(hard ?? 150000, n.ctx), lim, over)}<span class="small mute">${kTok(n.ctx)} ctx${lim ? ` / hand-off ${kTok(lim)}${/_1m$/.test(n.ctx_role ?? '') ? ' (1M tier)' : ''}` : ''}${hard ? ` · max ${kTok(hard)}` : ''}${peak}</span>${flag}</span>`;
}
// RM-37: a run row's pause action (Runs + Lanes, the menu's hand-offs) from its pauseState: Pause a running work run (the safe pause
// order), pausing once asked, Resume a paused hand-off (its resume queued first)
export const pauseAct = (pz, project, run) => { const at = `data-project="${esc(project)}" data-run="${esc(run)}"`;
  return pz === 'running' ? `<button class="ghost" data-act="run-pause" ${at} title="Ask ${esc(run)} to stop at a clean point and hand off">Pause</button>`
    : pz === 'asked' ? chip('warn', 'pausing') : pz === 'handoff' ? `<button data-act="run-resume" ${at} title="Queue the resume of ${esc(run)} first">Resume</button>` : ''; };
// worker-speed: "tok/s 42 · model 35 % · tests 40 %" (the server's words; a live run's are its last 10 min)
export const speedLine = s => !s ? '' : `<div class="speed small mute" title="output tokens per second of model time; shares of the run's wall time${s.rolling ? ', last 10 min' : ''} (norn speed)">${esc(s.line)}${s.rolling ? ' (10 min)' : ''}</div>`;
export const progLine = g => !g ? '' : `<div class="prog small" title="${esc(g.slow?.line ?? g.pace?.words ?? '')}">${chip(PACE_CLS[g.pace?.state] ?? 'idle', g.pace?.state ?? '-')} ${esc(g.line)}</div>`;
/**
 * RM-39 item 5: the lane overview card - one component on the Lanes name and the Runs page's Lane cell. Hover (desktop) or focus / tap
 * (keyboard, phone) opens it over the row under the name, never over the row's buttons; Esc closes it (index.html); on a phone it is
 * a bottom sheet (CSS). `label` = what opens it (the lane name, or the Lane cell's link).
 */
export function laneCard(c, label) {
  if (!c) return label;
  const g = c.progress, src = c.source ? `<span class="mute"> (${esc(c.source.id)})</span>` : '';
  return `<span class="lhov">${label}<div class="lcard" role="dialog" aria-label="${esc(`Lane ${c.lane}`)}">
    <div><b>${esc(c.lane)}</b> ${c.type ? chip('idle', c.type) : ''}</div>
    <div class="small">${c.objective ? `${esc(c.objective)}${src}` : chip('warn', c.finding ?? 'no recorded driver')}</div>${c.output ? `<div class="small mute">${esc(c.output)}</div>` : ''}
    ${g ? `<div class="small"><b>${esc(c.stage ?? '')}</b>: ${esc(g.line)}</div>${progDetail(g)}` : ''}
    <div class="small mute">${esc([c.last ? `last: ${c.last}` : 'no stage finished yet', c.next ? `next: ${c.next}` : null].filter(Boolean).join(' · '))}</div></div></span>`;
}
// MERGE-FIRST (4): "done, not merged: N (oldest Xh)" - the finished work not on its way to main yet (Lanes, Plan); over
// policy.merge.backlog_max it warns: the check-in lands work before it starts new lanes
export const backlogLine = b => (!b ? '' : `<p class="small backlog">${b.pending ? '<span class="mute">done, not merged: counting ...</span>'
  : `${chip(b.over ? 'warn' : b.n ? 'idle' : 'ok', b.text)}${b.over ? ` <span class="mute">over ${int(b.max)}: new lanes wait while finished work lands</span>` : ''}`}</p>`);
// fair-slots item 2: finished work on its way to main has its own state (lanes.mjs landState), never plain 'queued'; the PR one links it
// (the Lanes run state cell and the Plan's Up next / Landing next rows)
export const LAND_CHIP = { 'awaiting-merge': ['done', 'done - awaiting merge'], 'awaiting-pr': ['needs', 'awaiting PR approval'] };
export const landChip = l => { const [cls, word] = LAND_CHIP[l.land];
  return l.pr?.url && /^https:\/\//.test(l.pr.url) ? `<a class="chip ${cls}" href="${esc(l.pr.url)}" target="_blank" rel="noopener" title="${esc(`PR #${l.pr.number ?? '?'}: merge-land opened it; approve it on GitHub`)}">${esc(word)}</a>` : chip(cls, word); };
export const guardOn = (g, pick) => (g?.rows || []).filter(pick);
export function guardChip(rows, go = null) {
  if (!rows?.length) return '';
  const cls = rows.some(r => r.severity === 'high') ? 'bad' : rows.some(r => r.severity === 'medium') ? 'warn' : 'idle';
  const t = `${rows.length} Slop finding${rows.length === 1 ? '' : 's'}`, title = esc(`${t}: ${rows[0].why}`);
  return go ? ` <button class="lnk gchip" ${goAttrs(go)} title="${title}">${chip(cls, t)}</button>` : ` <span class="gchip" title="${title}">${chip(cls, t)}</span>`;
}
export const cut = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
export function renderFeedHead(h) {
  const st = h.state === 'exited' ? `exited: ${OUTCOME[h.outcome] ?? h.outcome ?? 'no-result'}` : h.state;
  const [cls, word] = stateOf(st);
  const over = fin(h.elapsed_min) && fin(h.budget_min) && h.elapsed_min > h.budget_min;
  const c = h.commit;
  return `<div class="fh-top">${dwarfName(h.dwarf)}<span class="id">${esc(h.run)}</span>${h.dwarf ? '' : runWho(null, h.kind_word)}${h.lane ? `<span class="tag">${esc(h.lane)}</span>` : ''}${chip(cls, word)}${h.marker ? chip(MARK[h.marker] ?? 'idle', h.marker) : ''}</div>${h.handoff ? `<div class="fh-ho">${hoChip(h.handoff, h.run)}</div>` : ''}
   <div class="fh-ex">${exChip(h.executor, h.model, h.effort)}${h.role === 'helper' ? ' <span class="tag">helper</span>' : ''}</div>
   <div class="kv small fh-kv"><span class="mute">elapsed</span><span>${fmtMin(h.elapsed_min)}${fin(h.budget_min) ? ` of ${fmtMin(h.budget_min)} budget` : ''}${fin(h.budget_min) ? meter(h.elapsed_min, Math.max(h.budget_min, h.elapsed_min ?? 0), h.budget_min, over ? 'over' : '') : ''}</span>
   <span class="mute">context</span><span>${fin(h.ctx) ? ctxMeter(h) : kTok(h.ctx)}${fin(h.ctx_window) ? ` <span class="small mute">(window ${kTok(h.ctx_window)})</span>` : ''}</span>
   <span class="mute">last commit</span><span>${c ? `<span class="mono">${esc(c.sha)}</span> ${esc(c.subject)} <span class="mute">${fmtMin(c.age_min)} ago</span>` : dash}</span></div>`;
}
export function renderFeedEvent(e) {
  const k = FEED_KINDS.includes(e.kind) ? e.kind : 'text', diff = k === 'tool' && (e.name === 'Edit' || e.name === 'Write') ? editDiff(e.input) : '';
  const tid = k === 'tool' && e.id ? ` data-tid="${esc(e.id)}"` : '', line = `<span class="ts">${hms(e.ts)}</span><span class="fk">${esc(k === 'tool' ? e.name ?? 'tool' : k)}</span><span class="fs">${esc(e.summary)}</span><span class="dur"></span>`;
  return diff ? `<details class="fl fl-x k-${k}"${tid}><summary>${line}</summary>${diff}</details>` : `<div class="fl k-${k}"${tid}>${line}</div>`;
}

export function renderActivity(v, o = {}) {
  const n = v.now, sec = (k, open, head, body) => `<details class="fa-sec" data-k="${k}"${open ? ' open' : ''}><summary>${head}</summary>${body}</details>`;
  const now = `<section class="fa-now" id="fa-now">${n ? `<div><b>Now</b> <span class="fa-sent">${esc(n.text)}</span>${n.since && !o.ended ? ` <span class="mute" id="fa-dur" data-since="${esc(n.since)}">${esc(fmtDur(n.secs))}</span>` : ''}${n.more > 0 ? ` <span class="small mute">+${int(n.more)} more running</span>` : ''}</div>` : '<div class="mute">nothing yet</div>'}
    ${v.words?.text ? `<div class="fa-words small" title="its latest own words, ${esc(hms(v.words.ts))} UTC">${esc(v.words.text)}</div>` : ''}</section>`;
  const p = v.plan, pdone = p.items.filter(i => i.state === 'done').length;
  const plan = p.items.length ? sec('plan', true, `<b>Plan</b> <span class="small mute">${int(pdone)} of ${int(p.items.length)} done · ${p.source === 'todos' ? 'its todo list' : "the brief's items (done = named in its NOTES or a commit)"}</span>`,
    `<ol class="fa-plan small">${p.items.map(i => `<li class="fa-p-${i.state}">${chip(i.state === 'done' ? 'ok' : i.state === 'current' ? 'run' : 'idle', i.state)} ${esc(i.text)}</li>`).join('')}</ol>`) : '';
  const f = v.files, nf = f.read.length + f.edited.length + f.created.length;
  const fileRow = r => `<li><button class="ghost fa-file" data-act="feed-doc" data-path="${esc(r.path)}" title="${esc(r.path)}">${esc(r.rel)}</button>
    <span class="small mute">${[r.reads ? plural(r.reads, 'read') : '', r.edits ? plural(r.edits, 'edit') : '', r.writes ? plural(r.writes, 'write') : ''].filter(Boolean).join(' · ')} · ${esc(hms(r.last))}</span>
    ${r.diffs.length ? `<details class="fa-diff" data-k="d:${esc(r.path)}"><summary class="small">${r.group === 'created' ? 'content' : plural(r.diffs.length, 'edit')}</summary>${r.diffs.map(d => `<div class="small mute">${esc(hms(d.ts))}${d.all ? ' · every match' : ''}${d.lines ? ` · ${int(d.lines)} lines` : ''}</div>${editDiff(d.write ? { content: d.new } : { old_string: d.old, new_string: d.new })}`).join('')}</details>` : ''}</li>`;
  const grp = (k, label, rows) => (rows.length ? `<h4 class="small" id="fa-g-${k}">${label} <span class="mute">${int(rows.length)}</span></h4><ul class="fa-files">${rows.slice(0, 60).map(fileRow).join('')}</ul>${rows.length > 60 ? `<p class="small mute">+${int(rows.length - 60)} more</p>` : ''}` : '');
  const files = sec('files', true, `<b>Files</b> <span class="small mute">${int(nf)} touched this run · tap one to open it in Docs</span>`,
    nf ? grp('edited', 'Edited', f.edited) + grp('created', 'Created', f.created) + grp('read', 'Read', f.read) : '<p class="small mute">none yet</p>');
  const tests = v.cmds.filter(c => c.tests), cmdRow = c => { const [cls, word] = CMD_CHIP[c.outcome] ?? ['idle', c.outcome];
    return `<li class="fa-cmd">${chip(cls, word)}${c.tests ? ` ${chip(c.tests.fail ? 'bad' : 'ok', testWords(c.tests))}` : ''} <code class="fa-c">${esc(c.cmd)}</code> <span class="small mute">${esc(hms(c.ts))}${fin(c.secs) ? ` · ${esc(fmtDur(c.secs))}` : ''}</span></li>`; };
  const cmds = sec('cmds', false, `<b>Commands and tests</b> <span class="small mute">${int(v.cmds.length)} commands · ${int(tests.length)} test runs${tests[0] ? ` · last: ${esc(testWords(tests[0].tests))}` : ''}</span>`,
    v.cmds.length ? `<ul class="fa-cmds">${v.cmds.slice(0, 40).map(cmdRow).join('')}</ul>${v.cmds.length > 40 ? `<p class="small mute">+${int(v.cmds.length - 40)} older</p>` : ''}` : '<p class="small mute">none yet</p>');
  const commits = sec('commits', true, `<b>Commits</b> <span class="small mute">${int(v.commits.length)} this run</span>`,
    v.commits.length ? `<ul class="fa-commits small">${v.commits.map(c => `<li>${c.sha ? `<span class="mono">${esc(c.sha)}</span> ` : ''}${esc(c.subject)} <span class="mute">${esc(hms(c.ts))}</span></li>`).join('')}</ul>` : '<p class="small mute">none yet</p>');
  return `<div class="fa" id="fa">${now}${plan}${files}${cmds}${commits}</div>`;
}

const kTok = n => fin(n) ? `${Math.round(n / 1000)}k` : '-';
// RM-46 S3 (SPEC 3.3, 4.7): a row another home wrote = an "on b" chip (that home commits its changes); an event written here on it and not
// yet committed by its home = "answered on a, pending b" (the server's foreign(): home, pending [{ ev, home, primary }])
const PAST = { answer: 'answered', say: 'said', archive: 'archived', unarchive: 'unarchived', revoke: 'revoked', overrule: 'overruled', edit: 'edited', move: 'moved', link: 'linked', unlink: 'unlinked', drop: 'dropped', reopen: 'reopened' };
const RANK = { ok: 0, warn: 1, bad: 2 };
// OVERVIEW-TRUTH (4): the scope words of a page's figures - what the page shows (one project or all) vs the machine / account
export const scopeWords = ctx => (ctx.project === 'all' ? 'all projects' : ctx.project ? `project ${ctx.project}` : 'this project');
// RM-39: a run's progress against its brief (progress.mjs runProgress) - ONE short line on a row: the pace as a chip ("on track" /
// "slow" / "stalled" / "testing": one long test running, not stalled) and "2 of 5 items done, testing item 3"; its title = why slow
const PACE_CLS = { 'on track': 'ok', testing: 'ok', slow: 'warn', stalled: 'bad' };
/** the detail: the checklist with its evidence, the pace, why slow, the alarms in words and the owner's moves */
export const progDetail = g => !g ? '' : `<ol class="prog-items small">${g.items.map(it => `<li class="prog-${esc(it.state)}"><span aria-hidden="true">${ITEM_MARK[it.state]}</span> ${esc(it.title)}<span class="mute"> - ${esc(it.state)}${it.evidence ? `: ${esc(it.evidence)}` : ''}</span></li>`).join('')}</ol>
  <div class="small"><b>Pace</b> ${esc(g.pace.words)}</div>${g.slow?.line ? `<div class="small"><b>Why</b> ${esc(g.slow.line)}</div>` : ''}
  ${(g.alarms || []).map(a => `<div class="small prog-alarm">${chip(a.cls === 'runaway' ? 'bad' : 'warn', a.cls)} ${esc(a.words)}<div class="mute">${esc(a.numbers)}</div><div>${a.ruled ? `${esc(a.ruled)}. ` : ''}You can: ${esc(a.act.join(' / '))}</div></div>`).join('')}`;
/** a link to where a finding is fixed: data-go (the tab) + the tab's own target (a file + line, a doc, an element id) */
export const goAttrs = go => [`data-go="${esc(go.tab)}"`, go.sub ? `data-gosub="${esc(go.sub)}"` : '', go.ins ? `data-goins="${esc(go.ins)}"` : '', go.line ? `data-goline="${esc(go.line)}"` : '',
  go.doc !== undefined ? `data-godoc="${esc(go.doc)}"` : '', go.jump ? `data-gojump="${esc(go.jump)}"` : ''].filter(Boolean).join(' ');
const OUTCOME = { done: 'DONE', stopped: 'STOPPED', handoff: 'HANDOFF' };
const MARK = { DONE: 'done', STOPPED: 'stopped', HANDOFF: 'handoff' };
const hms = ts => { const t = Date.parse(ts ?? ''); return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) : ''; };
const FEED_KINDS = ['tool', 'text', 'step', 'marker', 'error'];
// RM-36: an Edit / Write line opens to its diff (old -> new; a Write: its content as added lines), drawn by the shared diff component (RM-35)
const editDiff = i => (i && (typeof i.new_string === 'string' || typeof i.content === 'string')
  ? diffBlock({ before: i.old_string ?? '', after: i.new_string ?? i.content ?? '' }, { title: String(i.file_path ?? '').split(/[\\/]/).pop(), sub: typeof i.new_string === 'string' ? 'edit' : 'write', cls: 'fxdiff' }) : '');
// RM-36: the activity view (activity.mjs activityView) - Now (the open call as a sentence, how long, the worker's latest words),
// Plan, Files (Read / Edited / Created; a file opens in the Docs reader, an edited one shows its edits), Commands (duration,
// outcome, test counts), Commits. A component: the feed drawer paints it, a lane's page can embed it. <details data-k> keep their
// open state across repaints (the page restores them by key).
const CMD_CHIP = { ok: ['ok', 'ok'], error: ['bad', 'failed'], background: ['idle', 'background'] };
const testWords = t => `${int(t.pass ?? 0)} pass, ${int(t.fail)} fail${t.failed?.length ? ` - ${t.failed[0]}${t.failed.length > 1 ? ` (+${t.failed.length - 1})` : ''}` : ''}`;
// NAME-W2 item 5: '1 run' / '2 runs'; a share of the week that is not known says so (never '- of week')
export const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ITEM_MARK = { done: '✓', doing: '…', todo: '·' };
