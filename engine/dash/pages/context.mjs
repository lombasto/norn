// The Context page (moved from ui.mjs, ui-context-docs): what every session loads before any work and what it costs - the summary
// numbers once under the view switch, Per role / Per file / Is it growing? / Check-ins per day, and the checks page one link away
// (sub=checks: findings, the ladder, said again, audits, memory). Every file name opens the Docs reader. ui.mjs keeps the dispatch line.
// The shared steering-file cells (load words and chips, ~tokens, severity chips, the memory gauge) live here; pages/docs.mjs imports them.
import { esc, fin, dash, int, chip, fmtTime } from '../cells.mjs';
import { bars, stack, board, lines } from '../widgets.mjs';
import { SUB_CAP, subviewPage, subMore } from '../subviews.mjs';
import { INS_CAPS, LADDER_ORDER, LADDER_STATES, CONTEXT_SUBS, contextNumbers, standingRows, perDay, worstFiles, fileAdvice } from '../insparts.mjs';
import { diffBlock } from '../diffview.mjs';
import { auditCard, enforceCard } from '../ui.mjs';

// META-INSTRUCTIONS R1: every file that steers the agents - load class, ~size, what it cost today, drift, read-only hints; a row
// opens the file rendered. R2 (the chat's verbs) adds "ask the controller to tighten this": a disabled stub until then.
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
// META-UX-BUILD S4 (REPORT s.2): Context = what a session loads before any work and what it costs. The sub-view pattern: 4 numbers,
// Per role (what one session loads + the ONE standing table) / Per file (the count card, the file map, most tokens per day, the files)
// / Is it growing? / Check-ins per day. Reading is in the Docs reader (every file link lands there); the checks (Managed, Findings,
// Said again, the ladder, Audits, Memory, Hints, Tighten) are one link away (`sub=checks`, no fifth sub-view) until Slop takes them.
export function context(d, ctx) {
  const now = ctx.now ?? Date.now();
  if (d.pending || (d.error && !d.at)) return `${insRefreshing(d, now)}`;
  if (d.sub === 'checks') return `${insRefreshing(d, now)}${ctxChecks(d)}`;
  const none = w => `<p class="small mute">${esc(w)}</p>`;
  const body = d.sub === 'file' ? ctxFile(d, now) : d.sub === 'growing' ? insTrend(d.measured) || none('no measured session in the last 30 days')
    : d.sub === 'checkins' ? insCheckins(d.checkins) || none('no check-in recorded yet') : `${insLoads(d)}${ctxRoles(d)}`;
  const n = d.counts || {}, checks = (n.findings ?? 0) + (n.advisories ?? 0) + (n.hints ?? 0) + (n.suggest ?? 0);
  return `${subviewPage('context', { title: 'Context', lead: `${insRefreshing(d, now)}<div class="small mute" id="context-what">what every session loads before any work, and what that costs · last ${int(d.measured?.window_days ?? 7)} days</div>`, numbers: contextNumbers(d), views: CONTEXT_SUBS.map(([k, label]) => [k, label, k === 'file' ? n.files : undefined]), active: d.sub, body: d.parts_loading ? '' : body, loading: d.parts_loading })}
   <div class="small mute" id="context-links">Read the files in <button class="lnk" data-tab="docs">Docs</button> · their checks (findings, rules, audits, memory): <button class="lnk" data-act="sub" data-sub="checks">open the checks</button> · every finding, hint and tightening candidate, in batches: <button class="lnk" data-go="slop" data-gosub="fix">Slop</button> (${int(checks)})</div>`;
}
// Per file: the count card, the file map + most tokens per day, the files (capped, show more); a name opens the Docs reader
function ctxFile(d, now) {
  const load = r => r.load === 'role' ? `role ${r.role}` : r.load === 'session' && r.standing_tokens < r.tokens ? 'every session (description)' : INS_LOAD[r.load] ?? r.load;
  // the files that cost the most per day first (then size); the worst offenders are marked in the table and named on top with advice
  const all = [...(d.rows || [])].sort((a, b) => perDay(b) - perDay(a) || (b.tokens ?? 0) - (a.tokens ?? 0)), shown = all.slice(0, d.limit || SUB_CAP);
  const worst = worstFiles(all), hot = new Set(worst.map(x => x.r.id));
  const rows = shown.map(r => `<tr id="ins-row-${esc(r.id)}"${hot.has(r.id) ? ' class="ins-hot"' : ''}>
    <td><button class="lnk" data-ins="${esc(r.id)}"${r.exists ? '' : ' disabled'}>${esc(r.name)}</button>${r.exists || r.generated ? '' : ` ${chip('bad', 'missing')}`}${r.generated ? ` ${chip(DRIFT_CHIP[r.drift] ?? 'idle', `generated · ${r.drift || '?'}`)}` : ''}${r.stale ? ` ${chip('warn', `${r.stale} stale`)}` : ''}${r.findings ? ` ${chip('warn', `${r.findings} finding${r.findings > 1 ? 's' : ''}`)}` : ''}${insRuleChips(r.rules)}<div class="inspath mute">${esc(r.path)}</div>${hot.has(r.id) ? `<div class="small ins-advice">${esc(fileAdvice(r)[0].text)}</div>` : ''}</td>
    <td>${chip(INS_CHIP[r.load] ?? 'idle', load(r))}</td><td class="insopt">${esc((r.harness || []).join(', ') || 'any')}</td>
    <td class="num">${tk(r.tokens)}</td><td class="num">${r.cost_today ? `${tk(r.cost_today)}${r.via ? ' <span class="mute small">via</span>' : ''}<div class="small mute">${int(r.loads_today)} load(s)</div>` : dash}</td>
    <td class="insopt">${r.changed ? `${esc(fmtTime(r.changed, now))} <span class="small mute">${esc(r.changed_by)}</span>` : dash}</td>
    <td class="num">${r.hints ? chip('warn', `${r.hints} hint${r.hints > 1 ? 's' : ''}`) : dash}</td></tr>`).join('');
  return `<div class="card" id="ins-count"><b>${int(d.counts?.files ?? all.length)} files steer the agents</b> · ${tk(d.total)} tokens loaded today by ${int(d.sessions)} session(s)
     <div class="small mute">${esc(d.method)}. Cost today = size x the sessions that loaded it (runs.jsonl + the chat's starts). Read-only: hints are never applied.</div></div>
   ${ctxWorst(worst)}
   ${insFileMap(d)}
   <div class="tablecard"><h3>Files <span class="mute small">most tokens per day first · highlighted = a worst offender · tap a name to read it in Docs</span></h3><div class="inswrap"><table class="instab" id="ins-table"><thead><tr><th>file</th><th>loaded</th><th class="insopt">harness</th><th>size</th><th>today</th><th class="insopt">changed</th><th>hints</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="mute">no instruction files found</td></tr>`}</tbody></table></div>${subMore(shown.length, all.length)}</div>`;
}
// the worst offenders: the few files to look at first - what each costs a day and what to do about it, the worst problem first
function ctxWorst(worst) {
  if (!worst.length) return `<div class="card" id="ins-worst">${chip('ok', 'all clear')} <b>No file needs attention.</b> <span class="small mute">Every loaded file is within budget and has no open finding.</span></div>`;
  const li = worst.map(({ r, adv, day }, i) => `<li class="insworst"><div class="insworsthead"><span class="insrank">${i + 1}</span> <button class="lnk" data-ins="${esc(r.id)}"${r.exists ? '' : ' disabled'}><b>${esc(r.name)}</b></button>
    <span class="small mute">${day ? `${tk(day)} tokens / day` : `${tk(r.tokens)} tokens`} · ${esc(INS_LOAD[r.load] ?? r.load)}</span></div>
    <ul class="insadv">${adv.map(a => `<li>${chip(a.sev, a.sev === 'bad' ? 'fix' : a.sev === 'warn' ? 'improve' : 'minor')} ${esc(a.text)}${a.go ? ` <button class="lnk" data-go="${esc(a.go)}" data-gosub="fix">in Slop</button>` : ''}</li>`).join('')}</ul></li>`).join('');
  return `<div class="tablecard" id="ins-worst"><h3>Look at these first <span class="mute small">the ${int(worst.length)} file${worst.length > 1 ? 's' : ''} where a fix saves the most: tokens loaded per day, and what the checks found</span></h3><ol class="insworstlist">${li}</ol></div>`;
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
// META-TEND P1-VISUAL (REPORT 5.3 view 3): the file map - each steering file a block sized by ~tokens x loads per day (7-day mean),
// coloured by its state, grouped by load class; a click opens the file with its findings. Generator sources are not loaded: left out.
const MAP_GROUPS = [['always loaded', ['session']], ['per role', ['checkin', 'chat', 'role']], ['on demand', ['on-demand']]];
const MAP_STATE = { fresh: 'fresh', stale: 'stale paragraphs', conflict: 'conflict (two files say it)', 'generated-stale': 'generated, out of sync' };
function insFileMap(d) {
  const rows = (d.rows || []).filter(r => r.exists && r.load !== 'source'), cost = r => Math.round((r.standing_tokens ?? r.tokens) * (r.loads_day || 0));
  if (!rows.length) return '';
  const groups = MAP_GROUPS.map(([name, loads]) => {
    const xs = rows.filter(r => loads.includes(r.load)).sort((a, b) => cost(b) - cost(a) || b.tokens - a.tokens);
    if (!xs.length) return '';
    const sum = xs.reduce((n, r) => n + cost(r), 0), tsum = xs.reduce((n, r) => n + r.tokens, 0) || 1;
    const blk = r => {
      const share = sum > 0 ? cost(r) / sum : r.tokens / tsum, st = MAP_STATE[r.map_state] ? r.map_state : 'fresh';
      return `<button class="fmblk st-${esc(st)}" data-ins="${esc(r.id)}" style="flex-basis:${(100 * share).toFixed(2)}%" title="${esc(`${r.name} · ${tk(r.tokens)} tokens x ${r.loads_day || 0} loads/day = ${tk(cost(r))} / day · ${MAP_STATE[st]}${r.findings ? ` · ${r.findings} findings` : ''}`)}">${share >= 0.06 ? esc(r.name) : ''}</button>`;
    };
    return `<div class="fmgroup"><div class="small"><b>${esc(name)}</b> <span class="mute">${int(xs.length)} files · ${tk(sum)} tokens / day</span></div><div class="fmblocks">${xs.map(blk).join('')}</div></div>`;
  }).join('');
  const n = k => rows.filter(r => (MAP_STATE[r.map_state] ? r.map_state : 'fresh') === k).length;
  const legend = Object.entries(MAP_STATE).map(([k, w]) => `<span><i class="stkdot st-${k}"></i>${esc(w)} <b>${int(n(k))}</b></span>`).join('');
  const top = rows.filter(r => cost(r) > 0).sort((a, b) => cost(b) - cost(a)).slice(0, 6);
  return `<div class="tablecard" id="ins-filemap"><h3>The file map <span class="mute small">a block per file, sized by ~tokens x loads per day (last 7 days) · tap a block to open the file and its findings</span></h3>
   <div class="stklegend small" style="padding:0 12px">${legend}</div><div style="padding:4px 12px">${groups}</div>
   ${top.length ? `<div style="padding:0 12px 8px"><div class="small"><b>Most tokens per day</b></div>${bars(top.map(r => ({ label: r.name, value: cost(r), cls: `st-${MAP_STATE[r.map_state] ? r.map_state : 'fresh'}` })), { fmt: v => `${tk(v)} / day` })}</div>` : ''}</div>`;
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
