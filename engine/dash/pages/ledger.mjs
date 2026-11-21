// The Records and Ledger pages (UI redesign 2026-11-20). Records: the directives and decisions in one table each, toggled by the
// filter-chip row (Directives / Decisions) and filtered by state, age and lane; each row shows how much the record matters now (its
// weight, lib/recordweight.mjs: cited where, edits, conflicts, how long it stood, recorded violations) and opens its drawer (the
// runs, lanes and records that cite it, its history, Revoke / Overrule). Ledger: the project's ledger lines, newest first, a chip
// per kind, with the Homes / Claims blocks of a synced project. Every text goes through the one prose renderer (prose.mjs).
import { renderProse } from '../prose.mjs';
import { parseLedger, recordMarkdown, LEDGER_KINDS } from '../ledger.mjs';
import { esc, int, plural, chip, homeChip, pendingChips, fmtTime, filterChips } from '../cells.mjs';
import { decMark } from '../ui.mjs';

// the views live in this module (one per page: the acts flip them, a stream repaint keeps them)
export const REC_KINDS = [['directive', 'Directives'], ['decision', 'Decisions']];
export const REC_STATES = [['force', 'In force'], ['ended', 'Ended']];
export const REC_AGES = [['', 'any age'], ['7', 'under 7 d'], ['30', '7-30 d'], ['old', 'over 30 d']];
export const recView = { kinds: new Set(['directive', 'decision']), states: new Set(['force', 'ended']), age: '', lane: '', sort: 'new' };
export const ledgerView = { kinds: new Set(LEDGER_KINDS) };

const IN_FORCE = ['active', 'in-force'];
const stateGroup = r => (IN_FORCE.includes(r.state) ? 'force' : 'ended');
const ageOk = (r, a) => { const d = r.weight?.age_days; return !a || d === null || d === undefined ? true : a === '7' ? d < 7 : a === '30' ? d >= 7 && d <= 30 : d > 30; };
const laneOf = r => r.data?.lane ?? null;
const proseCx = (d, ctx, key) => ({ ...(d.prose || {}), project: d.project ?? ctx.project, sanitize: ctx.sanitize, ...(key ? { clamp: true, key } : {}) });
const days = n => (n === null || n === undefined ? '-' : `${int(n)} d`);
/** a record's text as markdown: a directive's text; a decision's question, its choice (bold label) and its why */
export const recMarkdown = r => (r.kind === 'directive' ? recordMarkdown(r.data.text)
  : [recordMarkdown(r.data.question), r.data.choice ? `**choice** ${recordMarkdown(r.data.choice)}` : '', r.data.why ? `**why** ${recordMarkdown(r.data.why)}` : ''].filter(Boolean).join('\n\n'));
// the weight in one line: cited n, edits, conflicts, how long it stood, violations (recorded only)
function weightCell(w) {
  if (!w) return '<span class="mute">-</span>';
  const bits = [`cited <b>${int(w.cited.total)}</b>`, w.edits ? plural(w.edits, 'edit') : '', w.supersedes.length ? `supersedes ${int(w.supersedes.length)}` : '',
    w.conflicts.length ? chip('warn', plural(w.conflicts.length, 'conflict')) : '', `stood ${days(w.stood_days)}`,
    w.violations.length ? chip('bad', `${plural(w.violations.length, 'violation')} recorded`) : ''].filter(Boolean);
  return `<span class="rweight small">${bits.join(' · ')}</span>`;
}
const act = (r, project) => (r.state === 'active' && r.kind === 'directive' ? `<button class="ghost" data-act="revoke" data-project="${esc(project)}" data-id="${esc(r.id)}">Revoke</button>`
  : r.state === 'in-force' && r.kind === 'decision' ? `<button class="ghost" data-act="overrule" data-project="${esc(project)}" data-id="${esc(r.id)}">Overrule</button>` : '');
const states = r => `${chip(r.state)}${r.data.fyi ? ' ' + chip('needs', 'FYI') : ''}${r.kind === 'decision' ? decMark(r) : ''} ${homeChip(r)}${pendingChips(r)}`;
function row(r, d, ctx) {
  const by = r.kind === 'directive' ? r.data.via ?? r.by : r.by;
  return `<tr id="rec-${esc(r.id)}" data-state="${esc(r.state)}"><td class="id rnw"><button class="lnk" data-act="rec-open" data-id="${esc(r.id)}" title="Open ${esc(r.id)}: who cites it, its history">${esc(r.id)}</button></td>
    <td>${states(r)}</td><td class="rt">${renderProse(recMarkdown(r), proseCx(d, ctx, `rec:${r.id}`))}${laneOf(r) ? `<div class="small mute">lane ${esc(laneOf(r))}</div>` : ''}</td>
    <td>${weightCell(r.weight)}</td><td class="small mute rnw">${fmtTime(r.created, ctx.now)} · ${esc(by ?? '-')}</td><td>${act(r, d.project)}</td></tr>`;
}
function table(kind, rs, d, ctx) {
  const label = REC_KINDS.find(k => k[0] === kind)[1];
  return `<div class="tablecard" id="rec-${kind}s"><h3>${label} <b>${int(rs.length)}</b></h3><table class="rectab" data-rows="records"><thead><tr><th>id</th><th>state</th><th>text</th><th>weight</th><th>when · by</th><th></th></tr></thead>
    <tbody>${rs.map(r => row(r, d, ctx)).join('') || `<tr><td colspan="6" class="mute">no ${label.toLowerCase()} under these filters</td></tr>`}</tbody></table></div>`;
}
const HELP = `<details class="lhelp"><summary aria-label="About the records">?</summary><div class="small">Only <b>active</b> directives and <b>in-force</b> decisions bind the check-in.
  <b>Weight</b>: <b>cited</b> counts the other records, runs, run notes and ledger lines that name the record; <b>conflicts</b> are possible duplicate directives and owner overrules;
  <b>stood</b> is how long it was in force; a <b>violation</b> shows only where a guard or Norn's scope hook recorded one citing it. Tap an id for who cites it.</div></details>`;

export function records(d, ctx) {
  const v = ctx.recView ?? recView, all = [...d.directives, ...d.decisions];
  const pass = (r, skip) => (skip === 'kind' || v.kinds.has(r.kind)) && (skip === 'state' || v.states.has(stateGroup(r))) && (skip === 'age' || ageOk(r, v.age)) && (skip === 'lane' || !v.lane || laneOf(r) === v.lane);
  const n = (skip, f) => all.filter(r => pass(r, skip) && f(r)).length;
  const kinds = filterChips('Show', REC_KINDS.map(([k, t]) => ({ act: 'rec-kind', data: { show: k }, text: t, n: n('kind', r => r.kind === k), on: v.kinds.has(k) })));
  const st = filterChips('State', REC_STATES.map(([k, t]) => ({ act: 'rec-state', data: { show: k }, text: t, n: n('state', r => stateGroup(r) === k), on: v.states.has(k) })));
  const age = filterChips('Age', REC_AGES.map(([k, t]) => ({ act: 'rec-age', data: { show: k }, text: t, on: v.age === k })));
  const lanes = [...new Set(all.map(laneOf).filter(Boolean))].sort();
  const lane = lanes.length ? `<details class="rlane"><summary class="small">lane: <b>${esc(v.lane || 'all')}</b></summary>${filterChips('Lane', [{ act: 'rec-lane', data: { show: '' }, text: 'all', on: !v.lane },
    ...lanes.map(l => ({ act: 'rec-lane', data: { show: l }, text: l, n: n('lane', r => laneOf(r) === l), on: v.lane === l }))])}</details>` : '';
  const sort = filterChips('Order', [{ act: 'rec-sort', data: { show: 'new' }, text: 'newest', on: v.sort !== 'cited' }, { act: 'rec-sort', data: { show: 'cited' }, text: 'most cited', on: v.sort === 'cited' }]);
  const order = rs => (v.sort === 'cited' ? [...rs].sort((a, b) => (b.weight?.cited.total ?? 0) - (a.weight?.cited.total ?? 0)) : rs);
  const shown = k => order((k === 'directive' ? d.directives : d.decisions).filter(r => pass(r)));
  return `<div class="phead pagehead" id="records-head"><h2 class="ptitle">Records</h2>${kinds}<span class="spacer"></span><button class="strong" data-act="directive" data-project="${esc(d.project)}">Add directive</button>${HELP}</div>
   <div class="filters rfilters"><input type="search" data-filter="records" placeholder="search id, lane, text" aria-label="Search the records">${st}${age}${lane}${sort}</div>
   ${REC_KINDS.filter(([k]) => v.kinds.has(k)).map(([k]) => table(k, shown(k), d, ctx)).join('') || '<p class="mute">Pick Directives or Decisions above.</p>'}`;
}

// the drawer (index.html #srcview, pages/ledger-acts.mjs rec-open): the record whole, its weight in numbers and who cites it - each run,
// lane and record a link where it lives (data-rid), each note its path
const rid = (id, project) => `<a class="rid" href="#" data-rid="${esc(id)}"${project ? ` data-project="${esc(project)}"` : ''}>${esc(id)}</a>`;
function history(r, ctx) {
  return `<ol class="small mono rhist">${(r.history || []).map(h => `<li>${esc(h.seq)} ${fmtTime(h.ts, ctx.now)} ${esc(h.ev)} by ${esc(h.by)}${h.data?.text && h.ev !== 'create' ? ': ' + esc(h.data.text) : ''}</li>`).join('')}</ol>`;
}
export function recordHead(r) { return `<b>${esc(r.id)}</b> <span class="small">${chip(r.state)} ${r.kind}</span>`; }
export function renderRecord(r, d, ctx = {}) {
  if (!r) return '<p class="small mute">record not found (refresh the page)</p>';
  const w = r.weight, p = d.project, kv = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`, list = (xs, f) => (xs.length ? xs.map(f).join(' ') : '<span class="mute">none</span>');
  const fids = Array.isArray(r.data.findings) && r.data.findings.length ? kv('findings', `<details class="small"><summary>${int(r.data.findings.length)} finding ids${r.data.fixall ? ` · ${esc(r.data.fixall)}` : ''}</summary><span class="mono">${esc(r.data.findings.join(' '))}</span></details>`) : '';
  const nums = w ? `${kv('cited', `${int(w.cited.total)} <span class="mute">(records ${int(w.cited.records)} · runs ${int(w.cited.runs)} · notes ${int(w.cited.notes)} · ledger lines ${int(w.cited.ledger)})</span>`)}
    ${kv('edits', int(w.edits))}${kv('supersedes', list(w.supersedes, x => rid(x, p)))}${w.superseded_by ? kv('superseded by', rid(w.superseded_by, p)) : ''}
    ${kv('conflicts', w.conflicts.length ? `<ul class="rlist">${w.conflicts.map(c => `<li>${/^(DIR|DEC)-/.test(c.id) ? rid(c.id, p) : esc(c.id)}: ${esc(c.why)}</li>`).join('')}</ul>` : '<span class="mute">none</span>')}
    ${kv('age', `${days(w.age_days)} · stood ${days(w.stood_days)}${IN_FORCE.includes(r.state) ? ' (still in force)' : ''}`)}
    ${kv('violations', w.violations.length ? `<ul class="rlist">${w.violations.map(x => `<li>${esc(x.source)}${x.run ? ` ${rid(x.run, p)}` : ''}${x.at ? ` · ${fmtTime(x.at, ctx.now)}` : ''}: ${esc(x.why)}</li>`).join('')}</ul>` : '<span class="mute">none recorded</span>')}
    ${kv('cited by runs', list(w.by.runs, x => rid(x, p)))}${kv('lanes', list(w.by.lanes, x => rid(`L:${x}`, p)))}${kv('records', list(w.by.records, x => rid(x, p)))}
    ${kv('notes', w.by.notes.length ? `<ul class="rlist mono small">${w.by.notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span class="mute">none</span>')}` : '';
  return `<div class="recd">${renderProse(recMarkdown(r), proseCx(d, ctx))}
    <dl class="reckv">${kv('state', states(r))}${laneOf(r) ? kv('lane', rid(`L:${laneOf(r)}`, p)) : ''}${kv('when', `${fmtTime(r.created, ctx.now)} · by ${esc(r.kind === 'directive' ? r.data.via ?? r.by : r.by)}${r.data.source ? ` · source ${esc(r.data.source)}` : ''}`)}${fids}${nums}</dl>
    <h4>History</h4>${history(r, ctx)}<div class="recacts">${act(r, p)}</div></div>`;
}

// ---------- Ledger: one row per entry, newest first - time, kind chip, headline + labelled sub-lines, all through the prose renderer ----------
const LED_CHIP = { 'check-in': 'ok', minor: 'idle', auto: 'warn', controller: 'claude', other: 'idle' };
const LED_WORD = k => (k === 'other' ? 'notes' : k);
export function ledgerRows(entries, d, ctx) {
  const px = { ...(d.prose || {}), project: ctx.project, sanitize: ctx.sanitize }, inl = t => renderProse(t, { ...px, inline: true });
  const subOf = x => `${x.label ? `<b>${esc(x.label)}</b> ` : ''}${inl(x.text)}`;
  return [...entries].map((e, i) => [e, i]).reverse().map(([e, i]) => {
    const body = e.kind === 'other' ? renderProse(e.raw, px) : `<div class="ledhead">${inl(e.headline)}</div>${e.subs.map(x => `<div class="ledsub">${subOf(x)}</div>`).join('')}`;
    const who = e.kind === 'controller' ? `<div class="id">${esc(e.label)}</div>` : '';
    return `<tr id="led-${i}" data-state="${esc(e.kind)}"><td class="small mute ledt">${e.ts ? fmtTime(e.ts, ctx.now) : ''}</td><td class="ledk">${chip(LED_CHIP[e.kind], LED_WORD(e.kind))}${who}</td><td class="ledb">${body}</td></tr>`;
  }).join('');
}
// RM-46 S3: a synced project's Homes + Claims blocks, above the ledger lines on the same page (no new tab); secs = a duration in words
const secs = v => v == null ? '-' : v < 120 ? `${v} s` : v < 7200 ? `${Math.round(v / 60)} min` : `${Math.round(v / 3600)} h`;
function syncBlocks(d, ctx) {
  if (!d.homes) return '';
  const h = d.homes, c = d.claims || { work: [] };
  const homes = `<div class="tablecard" id="ledger-homes"><h3>Homes <span class="mute small">this home: ${esc(h.home)} · last fetch ${h.fetched_at ? fmtTime(h.fetched_at, ctx.now) : 'never'}${h.fetch_error ? ` · ${esc(h.fetch_error)}` : ''}</span></h3>
   <table><thead><tr><th>home</th><th>head</th><th>lag</th><th>clock ahead</th></tr></thead><tbody>${h.rows.map(r => `<tr><td>${homeChip(r)}</td><td class="id">${esc(String(r.head).slice(0, 10))}</td><td>${secs(r.lag_s)}</td><td>${secs(r.ahead_s)}</td></tr>`).join('') || '<tr><td colspan="4" class="mute">no other home fetched yet</td></tr>'}</tbody></table></div>`;
  const work = c.work.map(w => `<tr><td>${homeChip(w)}<b>${esc(w.lane)}</b></td><td class="id">${esc(w.run ?? '-')} n=${esc(w.n)}</td><td class="small">${w.renewed_at ? fmtTime(w.renewed_at, ctx.now) : '-'}</td>
    <td>${w.stale ? `${chip('bad', 'stale')} <button class="ghost" data-act="claim-take" data-project="${esc(ctx.project ?? '')}" data-lane="${esc(`${w.home}/${w.lane}`)}">Take over</button>` : chip('ok', 'active')}</td></tr>`).join('');
  const claims = `<div class="tablecard" id="ledger-claims"><h3>Claims <span class="mute small">merge leader: ${c.leader ? `${esc(c.leader.home)} · renewed ${fmtTime(c.leader.renewed_at, ctx.now)}` : 'none'}</span></h3>
   <table><thead><tr><th>lane</th><th>run</th><th>renewed</th><th>state</th></tr></thead><tbody>${work || '<tr><td colspan="4" class="mute">no work claims</td></tr>'}</tbody></table></div>`;
  return homes + claims;
}
export function ledger(d, ctx) {
  const v = ctx.ledgerView ?? ledgerView, all = parseLedger(d.ledger), entries = all.filter(e => v.kinds.has(e.kind));
  const more = d.more ? `<button class="ghost" data-act="ledger-more">Show older (${esc(d.count ?? 100)} more lines)</button>` : '';
  const kinds = filterChips('Kinds', LEDGER_KINDS.map(k => ({ act: 'ledger-kind', data: { show: k }, text: LED_WORD(k), n: all.filter(e => e.kind === k).length, on: v.kinds.has(k) })));
  return `<div class="phead pagehead" id="ledger-head"><h2 class="ptitle">Ledger</h2>${kinds}</div>${syncBlocks(d, ctx)}
   <div class="filters"><input type="search" data-filter="ledger" placeholder="search text, ids  (e.g. RUN-12, merged)" aria-label="Search the ledger"><span class="small mute">${esc(d.file ?? 'no ledger file in project.json')} · ${esc(d.ledger.length)} of ${esc(d.total ?? d.ledger.length)} lines</span></div>
   <div class="tablecard"><table class="ledtab" id="ledger-lines" data-rows="ledger"><thead><tr><th>when</th><th>kind</th><th>entry</th></tr></thead><tbody>${ledgerRows(entries, d, ctx) || '<tr><td colspan="3" class="mute">empty</td></tr>'}</tbody></table>
   ${more ? `<div style="padding:10px 14px">${more}</div>` : ''}</div>`;
}
