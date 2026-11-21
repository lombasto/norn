// The Context page (moved from ui.mjs, ui-context-docs): what every session loads before any work and what it costs - the summary
// numbers once under the view switch, Per role / Per file / Is it growing? / Check-ins per day, and the checks page one link away
// (sub=checks: findings, the ladder, said again, audits, memory). Every file name opens the Docs reader. ui.mjs keeps the dispatch line.
// The shared steering-file cells (load words and chips, ~tokens, severity chips, the memory gauge) live here; pages/docs.mjs imports them.
import { esc, fin, dash, int, plural, chip, fmtTime, goAttrs, filterChips } from '../cells.mjs';
import { bars, stack, board, lines } from '../widgets.mjs';
import { SUB_CAP, subviewPage, subMore } from '../subviews.mjs';
import { INS_CAPS, LADDER_ORDER, LADDER_STATES, CONTEXT_SUBS, contextNumbers, standingRows, perDay, worstFiles, measuredRows } from '../insparts.mjs';
import { diffBlock } from '../diffview.mjs';
import { renderProse } from '../prose.mjs';

// META-INSTRUCTIONS R1: every file that steers the agents - load class, ~size, what it cost today, drift, read-only hints; a row
// opens the file rendered.
export const INS_LOAD = { session: 'every session', checkin: 'check-ins', chat: 'chat', role: 'role', 'on-demand': 'on demand', source: 'source' };
export const INS_CHIP = { session: 'warn', checkin: 'claude', chat: 'claude', role: 'prov', 'on-demand': 'idle', source: 'idle' };
const DRIFT_CHIP = { ok: 'ok', missing: 'bad', drift: 'bad', unmanaged: 'bad', stale: 'warn', adoptable: 'idle', same: 'idle' };
export const tk = n => (!fin(n) ? '-' : n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);
// META-UX-BUILD S1: a rebuild in the worker (or the first scan) shows a chip, never a blank page; a part not here yet says so
const INS_TITLE = { files: 'Files', rules: 'The ladder', findings: 'Findings', hints: 'Hints', suggest: 'Tighten' };
const insWait = k => `<div class="tablecard" id="ins-wait-${k}"><h3>${INS_TITLE[k]}</h3><p class="small mute inspart">loading ...</p></div>`;
function insRefreshing(d, now) {
  if (d.pending) return `<div class="card" id="ins-refreshing">${chip('run', 'refreshing')} <b>The first scan of ${esc(d.project ?? 'this project')} is running</b> in the background
    <div class="small mute">Every steering file is read once (a big project: under a minute); this page fills in when it lands. Other tabs answer meanwhile.</div></div>`;
  return `${d.refreshing ? `<div class="small" id="ins-refreshing" style="margin:0 0 6px">${chip('run', 'refreshing')} <span class="mute">the scan runs in the background; shown: the view of ${esc(fmtTime(d.at, now))}</span></div>` : ''}${d.error ? `<div class="small" style="margin:0 0 6px">${chip('bad', 'scan failed')} <span class="mute">${esc(d.error)}</span></div>` : ''}`;
}
const insMore = (shown, n, where) => (n > shown ? `<p class="small mute" style="padding:0 12px">showing ${int(shown)} of ${int(n)}${where ? ` · ${where}` : ''}</p>` : '');
// META-UX-BUILD S4 (REPORT s.2): Context = what a session loads before any work and what it costs. The sub-view pattern: the 4 numbers
// ONCE under the view switch (each marked low / medium / high), then Per role (what one session loads + the ONE standing table) / Per
// file (the files and their map in one view) / Is it growing? / Check-ins per day. Reading is in the Docs reader (every file name lands
// there); the checks page (`sub=checks`, no fifth sub-view) is reached from Slop › Rules.
export function context(d, ctx) {
  const now = ctx.now ?? Date.now();
  if (d.pending || (d.error && !d.at)) return `${insRefreshing(d, now)}`;
  if (d.sub === 'checks') return `${insRefreshing(d, now)}${ctxChecks(d)}`;
  const none = w => `<p class="small mute">${esc(w)}</p>`;
  const body = d.sub === 'file' ? ctxFile(d, now) : d.sub === 'growing' ? insTrend(d.measured) || none('no measured session in the last 30 days')
    : d.sub === 'checkins' ? insCheckins(d.checkins) || none('no check-in recorded yet') : `${insLoads(d)}${ctxRoles(d)}`;
  return subviewPage('context', { title: 'Context', lead: insRefreshing(d, now), numbers: contextNumbers(d), views: CONTEXT_SUBS.map(([k, label]) => [k, label, k === 'file' ? d.counts?.files : undefined]), active: d.sub, body: d.parts_loading ? '' : body, loading: d.parts_loading });
}
// Per file (UI redesign 2026-11-20: Files and the file map are ONE view): the files to look at first, then one card - the map's groups
// as filter chips, the chosen group's blocks (each named, sized by tokens x loads per day; a tap opens the file in Docs) and the same
// files in the table under them. The skills list and the MCP servers join "always loaded" as measured rows: no file, so no link.
// The chosen group lives here (one per page): pages/context-acts.mjs flips it, a stream repaint keeps it.
export const ctxView = { show: 'all' };
export const FILE_SHOWS = [['session', 'always loaded'], ['role', 'per role'], ['on-demand', 'on demand'], ['top', 'most tokens per day'], ['all', 'all']];
const SHOW_LOADS = { session: ['session'], role: ['checkin', 'chat', 'role'], 'on-demand': ['on-demand'] };
const MAP_STATE = { fresh: 'fresh', stale: 'stale paragraphs', conflict: 'conflict (two files say it)', 'generated-stale': 'generated, out of sync' };
const TOP_N = 10;
const stOf = r => (MAP_STATE[r.map_state] ? r.map_state : 'fresh');
/** the files of one group: a load class, the most tokens per day (the TOP_N that cost anything), or all; most tokens per day first */
export function filesOf(rows, show) {
  const xs = (rows || []).filter(r => r.load !== 'source').sort((a, b) => perDay(b) - perDay(a) || (b.tokens ?? 0) - (a.tokens ?? 0));
  return show === 'top' ? xs.filter(r => perDay(r) > 0).slice(0, TOP_N) : SHOW_LOADS[show] ? xs.filter(r => SHOW_LOADS[show].includes(r.load)) : xs;
}
// one group's blocks: sized by tokens per day; a group nothing loaded today (on demand) by size, and its line says how often a run opened one
function fmGroup(name, xs) {
  const live = xs.filter(r => r.exists);
  if (!live.length) return '';
  const sum = live.reduce((n, r) => n + perDay(r), 0), tsum = live.reduce((n, r) => n + (r.tokens ?? 0), 0) || 1, reads = live.reduce((n, r) => n + (r.reads || 0), 0);
  const blk = r => `<button class="fmblk st-${esc(stOf(r))}" data-ins="${esc(r.id)}" style="flex-basis:${(100 * (sum > 0 ? perDay(r) / sum : (r.tokens ?? 0) / tsum)).toFixed(2)}%" title="${esc(`${r.name} · ${tk(r.tokens)} tokens x ${r.loads_day || 0} loads/day = ${tk(perDay(r))} / day · ${MAP_STATE[stOf(r)]}${r.findings ? ` · ${r.findings} findings` : ''}`)}">${esc(r.name)}</button>`;
  return `<div class="fmgroup"><div class="small">${name ? `<b>${esc(name)}</b> ` : ''}<span class="mute">${plural(live.length, 'file')} · ${sum > 0 ? `${tk(sum)} tokens / day` : `opened ${int(reads)}x in 30 d`}</span></div><div class="fmblocks">${live.map(blk).join('')}</div></div>`;
}
const MEASURED_ROLES = { chat: 'chat', checkin: 'check-ins', worker: 'workers', merge: 'merge runs' };
function ctxFile(d, now) {
  const show = FILE_SHOWS.some(([k]) => k === ctxView.show) ? ctxView.show : 'all', all = filesOf(d.rows, 'all'), xs = filesOf(d.rows, show), shown = xs.slice(0, d.limit || SUB_CAP);
  const worst = worstFiles(all), hot = new Set(worst.map(x => x.r.id)), meas = show === 'session' || show === 'all' ? measuredRows(d.measured) : [];
  const chips = filterChips('Files', FILE_SHOWS.map(([k, text]) => ({ act: 'ctx-show', data: { show: k }, text, n: filesOf(d.rows, k).length + (k === 'session' || k === 'all' ? measuredRows(d.measured).length : 0), on: k === show })), 'ctxshow');
  const map = show === 'all' ? [['always loaded', 'session'], ['per role', 'role'], ['on demand', 'on-demand']].map(([n, k]) => fmGroup(n, filesOf(d.rows, k))).join('') : fmGroup('', xs);
  const mblk = meas.length ? `<div class="fmgroup"><div class="small"><b>measured</b> <span class="mute">skills and MCP servers, per session</span></div><div class="fmblocks">${meas.map(m => `<span class="fmblk st-measured" style="flex-basis:${(100 * m.tokens / meas.reduce((n, x) => n + x.tokens, 0)).toFixed(2)}%" title="${esc(`${m.name} · ${tk(m.tokens)} tokens per session · ${m.roles.map(r => MEASURED_ROLES[r] ?? r).join(', ')}`)}">${esc(m.name)}</span>`).join('')}</div></div>` : '';
  const n = k => (d.rows || []).filter(r => r.exists && r.load !== 'source' && stOf(r) === k).length;
  const legend = `<div class="stklegend small">${Object.entries(MAP_STATE).map(([k, w]) => `<span><i class="stkdot st-${k}"></i>${esc(w)} <b>${int(n(k))}</b></span>`).join('')}</div>`;
  const help = `<details class="lhelp"><summary aria-label="How these sizes are counted">?</summary><div class="small">${esc(d.method ?? '')}. Per day = size x loads per day (last 7 days); today = size x the sessions that loaded it today. An on-demand file loads only when a run opens it. Measured = the skills list and MCP servers in the newest first request of each role.</div></details>`;
  const load = r => r.load === 'role' ? `role ${r.role}` : r.load === 'session' && r.standing_tokens < r.tokens ? 'every session (description)' : INS_LOAD[r.load] ?? r.load;
  const rows = shown.map(r => `<tr id="ins-row-${esc(r.id)}"${hot.has(r.id) ? ' class="ins-hot"' : ''}>
    <td><button class="lnk" data-ins="${esc(r.id)}"${r.exists ? '' : ' disabled'}>${esc(r.name)}</button>${r.exists || r.generated ? '' : ` ${chip('bad', 'missing')}`}${r.generated ? ` ${chip(DRIFT_CHIP[r.drift] ?? 'idle', `generated · ${r.drift || '?'}`)}` : ''}${r.stale ? ` ${chip('warn', `${r.stale} stale`)}` : ''}${r.findings ? ` ${chip('warn', `${r.findings} finding${r.findings > 1 ? 's' : ''}`)}` : ''}${insRuleChips(r.rules)}<div class="inspath mute">${esc(r.path)}</div></td>
    <td>${chip(INS_CHIP[r.load] ?? 'idle', load(r))}</td><td class="num">${tk(r.tokens)}</td><td class="num">${perDay(r) ? tk(perDay(r)) : r.load === 'on-demand' && r.reads ? `<span class="small mute">opened ${int(r.reads)}x</span>` : dash}</td>
    <td class="num insopt">${r.cost_today ? `${tk(r.cost_today)}${r.via ? ' <span class="mute small">via</span>' : ''}<div class="small mute">${int(r.loads_today)} load(s)</div>` : dash}</td>
    <td class="insopt">${r.changed ? `${esc(fmtTime(r.changed, now))} <span class="small mute">${esc(r.changed_by)}</span>` : dash}</td></tr>`).join('');
  const mrows = meas.map(m => `<tr class="ctxmeas"><td>${esc(m.name)}<div class="inspath mute">${esc(m.roles.map(r => MEASURED_ROLES[r] ?? r).join(', '))}</div></td><td>${chip('idle', 'measured')}</td><td class="num">${tk(m.tokens)}</td><td class="num">${dash}</td><td class="num insopt">${dash}</td><td class="insopt">${dash}</td></tr>`).join('');
  return `${ctxWorst(worst)}
   <div class="tablecard" id="ins-files"><div class="ctxfhead">${chips}${help}</div>
   <div class="ctxmap" id="ins-filemap">${legend}${map}${mblk}</div>
   <div class="inswrap"><table class="instab" id="ins-table"><thead><tr><th>file</th><th>loaded</th><th>size</th><th>per day</th><th class="insopt">today</th><th class="insopt">changed</th></tr></thead><tbody>${rows + mrows || `<tr><td colspan="6" class="mute">no files in this group</td></tr>`}</tbody></table></div>${subMore(shown.length, xs.length)}</div>`;
}
// the worst offenders: the few files to look at first - what each costs a day and what to do about it, the worst problem first; "in Slop"
// opens Slop at that file's row (&finding=<id>, bug 5)
function ctxWorst(worst) {
  if (!worst.length) return `<div class="card" id="ins-worst">${chip('ok', 'all clear')} <b>No file needs attention.</b></div>`;
  const li = worst.map(({ r, adv, day }, i) => `<li class="insworst"><div class="insworsthead"><span class="insrank">${i + 1}</span> <button class="lnk" data-ins="${esc(r.id)}"${r.exists ? '' : ' disabled'}><b>${esc(r.name)}</b></button>
    <span class="small mute">${day ? `${tk(day)} tokens / day` : `${tk(r.tokens)} tokens`} · ${esc(INS_LOAD[r.load] ?? r.load)}</span></div>
    <ul class="insadv">${adv.map(a => `<li>${chip(a.sev, a.sev === 'bad' ? 'fix' : a.sev === 'warn' ? 'improve' : 'minor')} ${esc(a.text)}${a.go ? ` <button class="lnk" ${goAttrs({ tab: a.go, sub: 'fix', finding: a.finding })}>in Slop</button>` : ''}</li>`).join('')}</ul></li>`).join('');
  return `<div class="tablecard" id="ins-worst"><h3>Look at these first</h3><ol class="insworstlist">${li}</ol></div>`;
}
// Per role: ONE standing table (META-UX-BUILD S4: "Standing context (measured)" + "Standing context per role" were two views of it) -
// each measured role (median per session, last 7 days) with the steering files' estimate per launch profile of that role beneath it
function ctxRoles(d) {
  const m = d.measured, lab = k => esc(String(k).replace(/^(\w+)/, w => ROLE_LABEL[w] ?? w));
  const reads = n => (n >= 1e6 ? `~${(n / 1e6).toFixed(1)}M` : tk(n));
  // the estimates of a role: one profile inline; several = their range, each profile (label, sessions today, ~tokens) one tap away
  const est = ps => {
    if (!ps.length) return `<td class="num">${dash}</td><td class="num">${dash}</td>`;
    const ts = ps.map(p => p.tokens), lo = Math.min(...ts), hi = Math.max(...ts), n = ps.reduce((k, p) => k + p.sessions, 0);
    if (ps.length === 1) return `<td class="num">${int(n)}</td><td class="num">${tk(hi)}</td>`;
    return `<td class="num">${int(n)}</td><td class="num"><details class="ctxprofs"><summary>${lo === hi ? tk(hi) : `${tk(lo)}-${tk(hi).slice(1)}`} <span class="small mute">${int(ps.length)} profiles</span></summary>
      <ul class="small">${ps.map(p => `<li>${esc(p.label)} · ${int(p.sessions)} today · ${tk(p.tokens)}</li>`).join('')}</ul></details></td>`;
  };
  const rows = standingRows(m, d.standing).map(r => {
    const x = r.measured;
    return `<tr class="ctxrole"><td><b>${lab(r.key)}</b>${r.profiles.length === 1 ? `<div class="small mute">${esc(r.profiles[0].label)}</div>` : ''}</td>${x ? `<td class="num">${int(x.runs)}</td><td class="num"><b>${tk(x.median_turn1)}</b></td><td class="num insopt">${tk(x.median_create1)}</td><td class="num insopt">${x.median_turns ?? dash}</td><td class="num">${reads(x.cache_read)}</td>` : `<td class="num">${dash}</td><td class="num mute small">not measured</td><td class="insopt"></td><td class="insopt"></td><td class="num">${dash}</td>`}${est(r.profiles)}</tr>`;
  }).join('');
  return `<div class="tablecard" id="ctx-standing"><h3>Standing context per role <span class="mute small">measured: what one session loads before any work, re-read every turn, median per session, last ${int(m?.window_days ?? 7)} days · from files: the steering files' estimate per launch profile, today (tap a range for each profile)</span></h3>
   <div class="inswrap"><table class="instab" id="ctx-roles"><thead><tr><th>role</th><th>runs</th><th>turn 1</th><th class="insopt">cache create</th><th class="insopt">turns</th><th>cache reads</th><th>sessions today</th><th>~tokens from files</th></tr></thead><tbody>${rows || `<tr><td colspan="8">${dash}</td></tr>`}</tbody></table></div>
   ${m?.method ? `<div class="small mute" style="padding:6px 12px;overflow-wrap:anywhere">${esc(m.method)}</div>` : ''}</div>`;
}
// the checks page (one link from Context, not a sub-view): every check the Instructions tab showed, until the Slop slice moves them
function ctxChecks(d) {
  const wait = k => d.parts_loading && (k === 'rules' ? d.rules === undefined : k === 'files' ? d.rows === undefined : d[k] === undefined);
  return `<div class="small" id="ctx-checks-head"><button class="lnk" data-act="sub" data-sub="role">‹ Context</button> · <b>The checks</b> <span class="mute">of the files a session loads; tap a file to read it in Docs</span> · the lint's hints and the tightening candidates are rows in <button class="lnk" data-go="slop" data-gosub="fix">Slop › To fix</button></div>
   ${insManaged(d.managed)}
   ${wait('findings') ? insWait('findings') : insFindings(d)}
   ${wait('rules') ? insWait('rules') : `${insRepeats(d.rules)}${insLadder(d.rules)}`}
   ${insAudits(d.audits)}
   ${insMemory(d.memory_map)}
`;
}
// META-TEND P3 (REPORT 5.3 view 6): the ladder - every must / never rule as a card in its state's column (prose only -> repeated n
// times -> enforced -> retired): its home (a click opens the source line), its enforcement, when that last fired. Built on board().
const ENF_LABEL = { prose: 'prose only', hook: 'hook', deny: 'deny rule', test: 'test', lint: 'lint', gate: 'gate', 'git-hook': 'git hook' };
export const baseName = p => String(p ?? '').split('/').pop();
function insRuleChips(c) {
  if (!c?.total) return '';
  return ` ${chip('idle', `${c.total} rule${c.total > 1 ? 's' : ''}`)}${c.prose ? ` ${chip('warn', `${c.prose} prose only`)}` : ''}${c.repeated ? ` ${chip('bad', `${c.repeated} repeated`)}` : ''}${c.enforced ? ` ${chip('ok', `${c.enforced} enforced`)}` : ''}`;
}
function ruleCard(r) {
  const h = r.home || {}, where = `${h.path?.startsWith('records:') ? h.path.slice(8) : baseName(h.path)}${h.line ? `:${h.line}` : ''}`;
  const e = r.enforcement || { kind: 'prose' };
  const enf = e.kind === 'prose' ? chip(e.by_choice ? 'idle' : 'warn', e.by_choice ? 'prose only, by choice' : 'prose only') : `${chip('ok', ENF_LABEL[e.kind] ?? e.kind)} <span class="small mute" title="${esc(e.path ?? '')}">${esc(e.target ?? '')}</span>`;
  const fired = r.state === 'retired' ? `retired ${esc(String(r.retired_at ?? '').slice(0, 10))}` : e.kind === 'prose' ? 'nothing fires: no enforcement' : r.fired ? `fired ${esc(String(r.fired.at).slice(0, 10))} <span class="mute">(${esc(r.fired.what)})</span>` : 'last fired: unknown <span class="mute">(no log of it)</span>';
  return `<div class="wbtext">${esc(r.text.length > 160 ? r.text.slice(0, 157) + '...' : r.text)}</div>
    <div class="small">${h.row ? `<button class="lnk" data-ins="${esc(h.row)}" data-line="${esc(h.line ?? '')}" title="${esc(h.path)}">${esc(where)}</button>` : `<b>${esc(where)}</b>`}${r.homes?.length > 1 ? ` ${chip('warn', `${r.homes.length} homes`)}` : ''}${r.repeats ? ` ${chip('bad', `said ${r.repeats}x`)}` : ''} · ${enf}</div>
    <div class="small mute">${fired}</div>`;
}
function insLadder(L) {
  if (!L) return '';
  const NOTE = { prose: 'every rule is enforced or retired', repeated: 'no rule said again', enforced: 'nothing enforces a rule yet', retired: 'no rule retired since the first scan' };
  const cols = LADDER_STATES.map(st => { const xs = L.rules.filter(r => r.state === st).sort(LADDER_ORDER[st]).slice(0, INS_CAPS.ladder);   // the rules part: each column capped
    return { key: st, label: st === 'prose' ? 'prose only' : st, cards: xs.map(ruleCard), more: Math.max(0, (L.counts[st] ?? 0) - xs.length), note: NOTE[st] }; });
  const adv = L.advisories || [], by = new Map();
  for (const a of adv) { if (!by.has(a.key)) by.set(a.key, []); by.get(a.key).push(a); }
  const KEY = { 'rule-several-homes': 'one rule in several homes', 'rule-drift-claim': 'says enforced, nothing found', 'rule-drift-policy': 'line vs the policy', 'rule-drift-path': 'points at code that is gone', 'rule-path-unknown': 'path not found (a runtime file or a typo)', 'enforcement-unexplained': 'enforcement no rule explains' };
  const finds = [...by].map(([k, xs]) => `<li><details class="rulegroup insgroup"><summary>${chip(xs[0].severity === 'medium' ? 'warn' : 'idle', xs[0].severity)} <b>${int(L.adv_counts?.[k] ?? xs.length)}</b> × ${esc(KEY[k] ?? k)} <span class="small mute">${esc(xs[0].source)}</span><div class="small">fix: <i>${esc(xs[0].fix.action)}</i></div></summary>
    <ul>${xs.slice(0, INS_CAPS.advisories).map(a => `<li class="insfind small"><span class="mute">${esc(baseName(a.path) || a.surface)}${a.line ? `:${esc(a.line)}` : ''}</span> ${esc(a.why)}${a.fix.patch ? diffBlock({ patch: a.fix.patch }, { title: baseName(a.path) || a.surface, sub: 'proposed fix' }) : ''}</li>`).join('')}</ul></details></li>`).join('');
  return `<div class="tablecard" id="ins-ladder"><h3>The ladder <span class="mute small">${int(LADDER_STATES.reduce((n, st) => n + (L.counts[st] ?? 0), 0))} must / never rules by state · prose only ${int(L.counts.prose)} → repeated ${int(L.counts.repeated)} → enforced ${int(L.counts.enforced)} → retired ${int(L.counts.retired)} · tap a home to open its line</span></h3>
    ${board(cols, { id: 'ins-board', aria: 'rules by state' })}
    ${finds ? `<ul id="ins-rule-findings">${finds}</ul>` : ''}</div>`;
}
const AUD_OUT = { done: 'ok', crash: 'bad', stopped: 'warn', limit: 'warn', auth: 'warn' };
function insAudits(a) {
  if (!a) return '';
  const runs = a.runs.map(r => `<tr><td class="id">${esc(r.id)}</td><td class="small">${esc(String(r.created).slice(0, 16).replace('T', ' '))}</td><td>${chip(r.state === 'running' ? 'run' : AUD_OUT[r.outcome] ?? 'idle', r.state === 'running' ? 'running' : r.outcome ?? r.state)}</td>
    <td class="num">${int(r.accepted + r.declined + r.open)}</td><td class="num">${int(r.accepted)}</td><td class="num">${int(r.declined)}</td><td class="num">${int(r.open)}</td>
    <td class="small">${r.watch.length ? r.watch.map(w => (w.alarms.length ? chip('bad', `${w.alarms.length} alarm(s)`) : chip(w.done ? 'ok' : 'idle', `${w.seen} of ${w.of} runs ${w.done ? 'clean' : 'watched'}`))).join(' ') : dash}</td></tr>`).join('');
  const trig = a.triggers.map(t => `<li>${chip(t.key === 'never' ? 'idle' : 'warn', t.key)} ${esc(t.why)}</li>`).join('');
  return `<div class="tablecard" id="ins-audits"><h3>Audits <span class="mute small">the vendor prompt audit (/doctor prompt-audit), read-only · one card per proposed hunk · ${esc(a.rule.why)}</span></h3>
   <div style="padding:0 12px"><div class="small"><b>Triggers now</b> ${a.triggers.length ? `<span class="mute">(${a.rule.mode === 'auto' ? 'they may start an audit' : 'manual: start it with'} <span class="mono">${esc(a.command)}</span>)</span>` : '<span class="mute">none: no event calls for an audit</span>'}</div>${trig ? `<ul class="small" id="ins-audit-triggers">${trig}</ul>` : ''}</div>
   <div class="inswrap"><table class="instab" id="ins-audit-runs"><thead><tr><th>run</th><th>started</th><th>outcome</th><th>hunks</th><th>accepted</th><th>declined</th><th>open</th><th>watch after apply</th></tr></thead><tbody>${runs || '<tr><td colspan="8" class="mute">no audit has run yet</td></tr>'}</tbody></table></div>
   ${a.cards.length ? `<ul>${a.cards.map(c => auditCard(c, null)).join('')}</ul>` : ''}</div>`;
}
// META-TEND P5 (REPORT 5.3 view 1): is it growing forever? - the median standing context per session, one line per role, 30 days
function insTrend(m) {
  const rows = m?.trend?.rows || [];
  if (!rows.length) return '';
  const end = Date.parse(rows.map(r => r.day).sort().at(-1) + 'T00:00:00Z'), n = m.trend.days;
  const days = Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
  const keys = [...new Set(rows.map(r => r.key))], lab = k => k.replace(/^(\w+)/, w => ROLE_LABEL[w] ?? w);
  const series = keys.map(k => ({ key: k, label: lab(k), points: rows.filter(r => r.key === k && r.median_turn1 !== null).map(r => ({ x: r.day, y: r.median_turn1 })) }));
  return `<div class="tablecard" id="ins-trend"><h3>Is it growing forever? <span class="mute small">standing tokens per session (the median first request), per role and day, last ${int(n)} days</span></h3>
   <div style="padding:0 12px 8px">${lines(series, { days, fmt: tk, title: 'standing tokens per session', unit: 'tokens' })}</div></div>`;
}
function insRepeats(L) {
  if (!L) return '';
  const cs = L.cards || [];
  return `<div class="tablecard" id="ins-repeats"><h3>Said again <span class="mute small">${int(cs.length)} repeated correction(s), ranked · each card drafts the enforcement; Norn installs nothing (the Inbox holds the same cards)</span></h3>
    ${cs.length ? `<ul>${cs.map(c => enforceCard(c, null)).join('')}</ul>` : '<p class="mute" style="padding:0 12px">no correction said 3 times</p>'}</div>`;
}
// META-PRACTICE-P1: the static checks in place - one "managed" line, then the findings per file (severity chips, counts, the fix)
export const SEV_CHIP = { high: 'bad', medium: 'warn', low: 'idle', count: 'idle' }, SEVS = ['high', 'medium', 'low', 'count'];
function insManaged(m) {
  if (!m) return '';
  const sev = SEVS.filter(s => m.by_severity?.[s]).map(s => chip(SEV_CHIP[s], `${m.by_severity[s]} ${s}`)).join(' ');
  const on = Object.entries(m.memory || {}).filter(([, v]) => v === 'on').map(([r]) => ROLE_LABEL[r] ?? r), off = Object.entries(m.memory || {}).filter(([, v]) => v === 'off').map(([r]) => ROLE_LABEL[r] ?? r);
  return `<div class="card" id="ins-managed"><b>Managed:</b> ${int(m.files)} files scanned · <b>${int(m.open)}</b> findings open ${sev} · ${int(m.fixed)} fixed since the last scan${m.since ? ` <span class="small mute">(${esc(String(m.since).slice(0, 16).replace('T', ' '))}Z)</span>` : ''} · memory loaded by ${esc(on.join(', ') || 'no role')}${off.length ? ` <span class="mute">(off: ${esc(off.join(', '))})</span>` : ''}
    <div class="small mute">Static checks 1-19 + 21-23 (free, no model call; check 20 comes with the audits). Read-only: a finding names the fix, nothing is edited.</div></div>`;
}
function insFindings(d) {
  const fs2 = d.findings || [];
  if (!fs2.length) return '<div class="tablecard" id="ins-findings-card"><h3>Findings</h3><p class="mute" style="padding:0 12px">none</p></div>';
  const groups = new Map();
  for (const f of fs2) { if (!groups.has(f.path)) groups.set(f.path, []); groups.get(f.path).push(f); }
  const li = [...groups].map(([p, xs]) => {
    const cnt = SEVS.filter(s => xs.some(x => x.severity === s)).map(s => chip(SEV_CHIP[s], `${xs.filter(x => x.severity === s).length} ${s}`)).join(' ');
    const name = p.split('/').pop(), id = xs.find(x => x.row)?.row;
    // DEC-273: one row per file x check (count, the check's title, the fix once); its lines in an expandable list
    const byCheck = new Map();
    for (const x of xs) { if (!byCheck.has(x.check)) byCheck.set(x.check, []); byCheck.get(x.check).push(x); }
    const rows = [...byCheck].map(([c, ys]) => {
      const top = SEVS.find(s => ys.some(y => y.severity === s)), fixes = [...new Set(ys.map(y => y.fix.action))];
      return `<li><details class="insgroup"><summary>${chip(SEV_CHIP[top], top)} <b>${int(ys.length)}</b> × ${esc(ys[0].surface)} <span class="small mute">C${esc(c)} · L${esc(ys.map(y => y.line).slice(0, 8).join(', '))}${ys.length > 8 ? ' …' : ''}</span>${fixes.length === 1 ? `<div class="small">fix: <i>${esc(fixes[0])}</i></div>` : ''}</summary>
        <ul>${ys.map(y => `<li class="insfind">${chip(SEV_CHIP[y.severity], y.severity)} <span class="small mute">L${esc(y.line)}</span> ${esc(y.why)}${fixes.length > 1 ? `<div class="small">fix: <i>${esc(y.fix.action)}</i></div>` : ''}</li>`).join('')}</ul></details></li>`;
    }).join('');
    return `<li class="insfile"><div>${id ? `<button class="lnk" data-ins="${esc(id)}">${esc(name)}</button>` : `<b>${esc(name)}</b>`} ${cnt} <span class="inspath mute">${esc(p)}</span></div><ul>${rows}</ul></li>`;
  }).join('');
  return `<div class="tablecard" id="ins-findings-card"><h3>Findings <span class="mute small">${int(d.findings_n ?? fs2.length)} · static checks, read-only</span></h3><ul id="ins-findings">${li}</ul>${insMore(fs2.length, d.findings_n ?? 0, 'the Guard lists every one')}</div>`;
}
// META-STANDING-CONTEXT R1: the measured standing context (median per session, last 7 days) per role + where it goes (the parts)
const ROLE_LABEL = { worker: 'workers', merge: 'merge runs', checkin: 'check-ins', chat: 'chat' };
// META-CHECKIN-DIET R1: per day "check-ins: n (m mechanical, k minor, j full)" - mechanical = a routine end the tick handled by code
function insCheckins(days) {
  if (!days?.length) return '';
  const li = days.map(x => `<tr><td>${esc(x.day)}</td><td>check-ins: <b>${int(x.n)}</b> (${int(x.mechanical)} mechanical, ${int(x.minor)} minor, ${int(x.full)} full)</td></tr>`).join('');
  return `<div class="tablecard" id="ins-checkins"><h3>Check-ins per day <span class="mute small">mechanical = a routine end handled by code, no model · minor = the reduced tick · full = the full check-in</span></h3><div class="inswrap"><table class="instab"><tbody>${li}</tbody></table></div></div>`;
}
// META-TEND P1-VISUAL (REPORT 5.3 view 2): what one session loads - a stacked bar per role (the newest measured first request), the
// memory switch per role (policy.launch.memory). Parts in the REPORT's order; Norn's prompt, the agents list and the prompt follow.
const LOAD_ROLES = [['chat', 'controller / chat'], ['checkin', 'check-ins'], ['worker', 'workers'], ['merge', 'merge runs']];
const PART_ORDER = ['base', 'plugins', 'memory', 'skills', 'claude_md', 'hooks', 'agent', 'mcp', 'norn', 'agents', 'prompt'];
function insLoads(d) {
  const ps = d.measured?.parts || {}, mem = d.managed?.memory || {};
  const li = LOAD_ROLES.map(([role, name]) => {
    const s = ps[role], sw = mem[role] ? chip(mem[role] === 'on' ? 'warn' : 'ok', `memory ${mem[role]}`) : '';
    const segs = s ? [...(s.parts || [])].sort((a, b) => PART_ORDER.indexOf(a.key) - PART_ORDER.indexOf(b.key)).map(x => ({ key: x.key, label: x.ours === false ? `${x.label} (fixed)` : x.label, value: x.tokens })) : [];
    return `<li class="insload"><div><b>${esc(name)}</b> ${sw} ${s ? `<span class="mute small">${tk(s.total)} tokens · ${esc(s.run)}</span>` : ''}</div>
      ${s ? stack(segs, { fmt: tk }) : `<div class="small mute">no session measured in the last ${int(d.measured?.window_days ?? 7)} days</div>`}</li>`;
  }).join('');
  return `<div class="tablecard" id="ins-loads"><h3>What one session loads <span class="mute small">before any work, per role · the newest measured first request · memory on / off = the launch switch (policy.launch.memory)</span></h3><ul class="insloads">${li}</ul></div>`;
}
// META-TEND P1-VISUAL (REPORT 5.3 view 5): memory - the 200-line / 25 KB gauge, MEMORY.md -> topic files, entries in no index, broken links
// the MEMORY.md gauge (% of its load limit; over = full + red): Instructions' memory card and the head of the Docs Memory group
function memBars(m) {
  const g = (label, v, max, unit) => ({ label, value: 100 * v / max, cls: v > max ? 'over' : 'st-fresh', note: esc(`${v} of ${max} ${unit}`) });
  return bars([g('lines', m.lines, m.max_lines, 'lines'), g('size', m.kb, m.max_kb, 'KB')], { fmt: v => `${Math.round(v)} %`, max: 100 });
}
export function memGauge(m, id) {
  const over = m.lines > m.max_lines || m.kb > m.max_kb;
  return `<div class="docmem" id="${esc(id)}"><div class="small">${over ? `${chip('bad', 'over the limit')} past ${int(m.max_lines)} lines / ${int(m.max_kb)} KB the rest of MEMORY.md is not loaded` : `MEMORY.md loads whole: under ${int(m.max_lines)} lines and ${int(m.max_kb)} KB`}</div>${memBars(m)}
    <div class="small mute">${int(m.topics)} topic files${m.orphans ? ` · ${int(m.orphans)} in no index` : ''}${m.broken ? ` · ${int(m.broken)} broken links` : ''}</div></div>`;
}
function insMemory(m) {
  if (!m) return '<div class="tablecard" id="ins-memory"><h3>Memory</h3><p class="small mute" style="padding:0 12px">No MEMORY.md for this repo: its auto-memory folder is empty, so no session loads memory.</p></div>';
  const lk = m.topics.filter(t => t.linked).length, ago = iso => (iso ? esc(fmtTime(iso)) : '<span class="mute">not in 30 days</span>');
  const over = m.lines > m.max_lines || m.kb > m.max_kb, gauge = memBars(m);
  const shape = stack([{ key: 'linked', label: 'topic files in the index', value: lk }, { key: 'orphan', label: 'topic files in no index', value: m.orphans.length },
    { key: 'broken', label: 'broken links', value: m.broken.length }], { fmt: int });
  const broken = m.broken.map(e => `<li>${chip('bad', 'missing')} <span class="mute">L${esc(e.line)}</span> ${esc(e.title)} -&gt; ${esc(e.file)}</li>`).join('');
  const orphans = m.orphans.map(o => `<button class="lnk" data-ins="${esc(o.id)}">${esc(o.name)}</button>`).join(' · ');
  const tops = [...m.topics].sort((a, b) => String(b.opened ?? '').localeCompare(String(a.opened ?? '')) || a.name.localeCompare(b.name)).map(t => `<tr><td><button class="lnk" data-ins="${esc(t.id)}">${esc(t.name)}</button></td>
    <td>${t.linked ? chip('ok', `in index${t.linked > 1 ? ` x${t.linked}` : ''}`) : chip('warn', 'in no index')}</td><td>${ago(t.opened)}</td><td class="insopt">${t.changed ? esc(fmtTime(t.changed)) : dash}</td></tr>`).join('');
  return `<div class="tablecard" id="ins-memory"><h3>Memory <span class="mute small">MEMORY.md -&gt; ${int(m.topics.length)} topic files · the index last opened ${ago(m.index_opened)}</span></h3>
   <div style="padding:0 12px"><div class="small">${over ? `${chip('bad', 'over the limit')} past 200 lines / 25 KB the rest of MEMORY.md is silently not loaded` : 'MEMORY.md loads whole: under 200 lines and 25 KB'}</div>${gauge}${shape}
   ${broken ? `<div class="small" style="margin-top:6px"><b>Broken links</b></div><ul class="small">${broken}</ul>` : ''}
   ${orphans ? `<div class="small" style="margin-top:6px"><b>In no index</b> <span class="mute">(a session never finds them)</span></div><div class="small" style="overflow-wrap:anywhere">${orphans}</div>` : ''}
   <details style="margin:6px 0"><summary class="small">all ${int(m.topics.length)} topic files, last opened first</summary><div class="inswrap"><table class="instab"><thead><tr><th>file</th><th>index</th><th>last opened</th><th class="insopt">last changed</th></tr></thead><tbody>${tops}</tbody></table></div></details>
   <div class="small mute" style="padding-bottom:6px">${esc(m.opened_method)}</div></div></div>`;
}

const fmtLocal = iso => { const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return '-';
  const d = new Date(t); return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} local`; };
// META-TEND P5 (REPORT 3.3): one vendor-audit hunk = one card; accept = a decision + a directive (the check-in applies it), decline = a decision
export function auditCard(c, project) {
  const pj = project ? ` data-project="${esc(project)}"` : '';
  return `<li class="insfind" id="aud-${esc(c.id)}">${chip(SEV_CHIP[c.severity] ?? 'idle', c.severity)} <b>${esc(baseName(c.path))}:${esc(c.line)}</b> ${esc(c.why)} <span class="small mute">${esc(c.run)} · ${esc(c.id)}</span>
    ${diffBlock({ patch: c.fix.patch ?? '' }, { title: `${baseName(c.path)}:${c.line}`, sub: 'vendor audit hunk' })}
    <button class="primary" data-act="audit-accept"${pj} data-id="${esc(c.id)}">Accept: apply it</button> <button data-act="audit-decline"${pj} data-id="${esc(c.id)}">Decline: keep the text</button></li>`;
}
// META-TEND P3 (REPORT 3.6): the repeat detector's cards - one per cluster, ranked; approve = a directive (the one approvals path)
// RM-30 S1: a card its directive already asks for (rules.mjs askedBy) reads "Asked as DIR-n (state) - date" with a link and has no
// Approve; Approve is one tap (the directive is the record and can be revoked) and sends the card id, which the directive keeps
export function enforceCard(c, project, px = { project }) {
  const a = c.asked;
  return `<li class="insfind${a ? ' asked' : ''}" id="enf-${esc(c.id)}">${chip(a ? 'ok' : c.severity === 'medium' ? 'warn' : 'idle', a ? 'asked' : c.severity)} <div class="enf-why">${renderProse(c.why, px)}</div>
    <details><summary class="small">${int((c.items || []).length)} corrections · the draft</summary><ul class="small">${(c.items || []).map(x => `<li>${renderProse(x.text, px)}</li>`).join('')}</ul>${diffBlock({ patch: c.fix.patch ?? '' }, { title: 'the draft', sub: 'repeat detector draft' })}</details>
    ${a ? `<div class="small enf-asked">Asked as <a class="rid r-dir" href="#" data-rid="${esc(a.id)}"${project ? ` data-project="${esc(project)}"` : ''}>${esc(a.id)}</a> (${esc(a.state)}) - ${esc(fmtLocal(a.at))}</div>`
    : `<div class="small mute">${esc(c.fix.action)}</div>
    <button class="primary" data-act="adv-approve"${project ? ` data-project="${esc(project)}"` : ''} data-id="${esc(c.id)}" data-text="${esc(c.approve)}">Approve: ask for a brief</button>`}</li>`;
}
