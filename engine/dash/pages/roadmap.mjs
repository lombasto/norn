// The Roadmap page (moved from ui.mjs, ui-context-docs): the tree with a NOW line, the three Norns board, the edit drawer and the
// hash helpers index.html routes with. ui.mjs keeps the dispatch line.
import { esc, plural, fmtTime, homeChip, pendingChips } from '../cells.mjs';

// ---------- the Roadmap tab (META-ROADMAP S2, SPEC sec. 4 option A; owner Q-17): the tree with a NOW line ----------
// One tree per project from /api/roadmap (derived status, never typed). Per theme: the past folded above a NOW rule, the present
// rows in full, the future folded below. The scope strip is a tap-to-filter switch (Urd was / Verdandi is / Skuld shall be; classic:
// Past / Now / Next; tap the active one again = all; the scope lives in the URL hash). Every row carries a time line: first activity
// -> now with one stretch per run (colour = run state) and a NOW tick, one shared window per theme; planned rows a dashed stub.
// The views list: a switch is drawn only when there is more than one. S2b (owner Q-17): the board (Urd was / Verdandi is / Skuld
// shall be columns, the themes as rows aligned across them) is the second view; the tree stays the default.
export const RM_VIEWS = [['tree', 'Tree'], ['board', 'Board']];
const rmView = f => (RM_VIEWS.some(v => v[0] === f?.view) ? f.view : RM_VIEWS[0][0]);
export const RM_SCOPES = ['past', 'present', 'future'];
const RM_ST = { shipped: ['shipped', 'ok'], dropped: ['dropped', 'idle'], building: ['building', 'running'], waiting: ['needs you', 'needs'], built: ['built, not merged', 'warn'],
  merged: ['merged, not installed', 'warn'], queued: ['queued', 'idle'], planned: ['planned', 'idle'], idea: ['idea', 'idle'] };
const RM_SG = { done: 'ok', live: 'running', queued: 'idle', planned: 'plan', stopped: 'bad', handoff: 'warn', ended: 'warn', killed: 'bad', lost: 'bad' };
const RM_WORDS = { norn: [['Urd', 'was'], ['Verdandi', 'is'], ['Skuld', 'shall be']], classic: [['Past', 'done'], ['Now', 'in flight'], ['Next', 'planned']] };
const RM_NOW = 88;   // % of a time line: the theme window 0 .. 88, NOW at 88, the future side (stubs, no dates) 88 .. 100
/** the scope after a tap: the tapped one, or all (null) when it was already active */
export const rmScopeNext = (cur, tapped) => (cur === tapped ? null : tapped);
// the hash: the tree keeps the S2 words (#past, #rm-RM-3); another view is a prefix (#board, #board-past, #board-rm-RM-3)
const rmPre = view => (view && view !== RM_VIEWS[0][0] && RM_VIEWS.some(v => v[0] === view) ? view : '');
export const rmHash = (scope, view) => { const p = rmPre(view), s = RM_SCOPES.includes(scope) ? scope : ''; return p || s ? '#' + [p, s].filter(Boolean).join('-') : ''; };
/** the whole Roadmap hash from its state: a deep link wins over the scope; the view rides along */
export const rmUrlHash = (rm = {}) => (rm.item ? `#${rmPre(rm.view) ? rmPre(rm.view) + '-' : ''}rm-${rm.item}` : rmHash(rm.scope, rm.view));
/** '#past' -> { scope }, '#rm-RM-3' -> { item } (a deep link), '#board-past' -> { view, scope }, anything else -> {} */
export function parseRmHash(h) {
  let s = String(h || '').replace(/^#/, '');
  const v = RM_VIEWS.find(([k]) => s === k || s.startsWith(k + '-'))?.[0], o = v ? { view: v } : {};
  if (v) s = s.slice(v.length + 1);
  if (!s) return o;
  if (RM_SCOPES.includes(s)) return { ...o, scope: s };
  const m = s.match(/^rm-(RM-(?:[a-z][a-z0-9]{0,15}-)?\d+)$/);
  return m ? { ...o, item: m[1] } : {};
}
/** one item against the filters (scope, theme, status, live only, drift only, text over title / id / links / branches); pure */
export function rmMatch(i, f = {}, theme = null) {
  if (f.scope && i.phase !== f.scope) return false;
  if (f.theme && theme && f.theme !== theme) return false;
  if (f.status && i.status !== f.status) return false;
  if (f.live && !(i.live || []).length) return false;
  if (f.drift && !(i.flags?.drift || []).length) return false;
  const q = String(f.q || '').trim().toLowerCase();
  if (q && !q.split(/\s+/).every(w => [i.title, i.id, ...(i.links || []), ...(i.branches || []).map(b => b.name)].join(' ').toLowerCase().includes(w))) return false;
  return true;
}
const rmFiltered = f => !!(f.scope || f.theme || f.status || f.live || f.drift || String(f.q || '').trim());
const rmAgo = (iso, now) => { if (!iso) return ''; const d = (now - Date.parse(iso)) / 864e5; return d < 1 ? `${Math.max(1, Math.round(d * 24))} h ago` : `${Math.round(d)} d ago`; };
const rmDay = iso => (iso ? new Date(iso).toISOString().slice(5, 10) : '');
const rmFlat = (ns, depth = 0) => ns.flatMap(n => [...(n.kind === 'item' ? [{ ...n, depth }] : []), ...rmFlat(n.children || [], n.kind === 'item' ? depth + 1 : depth)]);
// an id as the dashboard's id chip: DIR / DEC / Q / RUN / L: jump to their tab, DLV opens the drawer
function rmRid(id, ctx) {
  if (/^DLV-/.test(id)) return `<a class="rid r-dlv" href="#" data-dlv="${esc(id)}" data-project="${esc(ctx.project)}">${esc(id)}</a>`;
  const k = id.split(/[-:]/)[0].toLowerCase();
  return `<a class="rid r-${k === 'l' ? 'l' : esc(k)}" href="#" data-rid="${esc(id)}">${esc(id)}</a>`;
}
const rmChip = i => `<span class="chip ${(RM_ST[i.status] || ['', 'idle'])[1]}">${esc((RM_ST[i.status] || [i.status])[0])}</span>${i.flags?.claimed ? `<span class="chip idle claimed" title="${esc(i.flags.claimed)}">claimed</span>` : ''}`;
const rmLive = (i, ctx) => (i.live || []).map(id => `<span class="rmlive" role="button" tabindex="0" data-feed="${esc(id)}" data-project="${esc(ctx.project)}" title="open the live feed"><i></i>${esc(id)}</span>`).join('');
const rmProg = i => (i.progress?.total ? `<span class="rmprog" title="stages DONE + branches at the target, of all"><span class="bar"><i style="width:${Math.round(100 * i.progress.done / i.progress.total)}%"></i></span>${i.progress.done}/${i.progress.total}</span>` : '');
function rmStages(i, max = 7) {
  const real = (i.stages || []).filter(s => s.state !== 'planned'), plan = (i.stages || []).filter(s => s.state === 'planned');
  const cut = Math.max(0, real.length - max), shown = real.slice(cut).concat(plan);
  if (!shown.length) return '';
  return `<div class="rmstages">${cut ? `<span class="mute small">+${cut} earlier</span>` : ''}${shown.map(s => `<span class="rmst sg-${RM_SG[s.state] || 'idle'}" title="${esc(s.lane ? `lane ${s.lane}, ` : '')}${s.runs || 0} run(s)${s.run ? `, latest ${s.run}` : ''}"><i></i>${esc(s.key)}<small>${esc(s.state)}</small></span>`).join('')}</div>`;
}
function rmLinks(i, ctx) {
  const by = k => (i.links || []).filter(t => t.startsWith(k + ':')).map(t => t.slice(k.length + 1));
  const ids = [...by('dir'), ...by('dec'), ...by('q'), ...by('ep'), ...by('run'), ...by('dlv'), ...by('lane').map(l => 'L:' + l)];
  const shown = ids.slice(0, 8).map(id => rmRid(id, ctx)).join(' ') + (ids.length > 8 ? ` <span class="mute small">+${ids.length - 8}</span>` : '');
  const known = new Set((i.branches || []).map(b => b.name));
  const br = [...(i.branches || []), ...by('branch').filter(b => !known.has(b)).map(name => ({ name, state: null }))].slice(0, 3)
    .map(b => `<span class="rmbr b-${esc(b.state || 'linked')}">${esc(b.name)}${b.dlv ? ' ' + rmRid(b.dlv, ctx) : ''}${b.state ? ` <small>${esc(b.state === 'done' ? 'not on main' : b.state)}</small>` : ''}</span>`).join(' ');
  return [shown, br].filter(Boolean).join(' ');
}
/** the theme's shared time window: the oldest first activity (or evidence) of any of its items .. now; null when none has a date */
function rmWindow(items, now) {
  const ts = items.flatMap(i => [i.first, i.last_evidence]).filter(Boolean).map(Date.parse).filter(Number.isFinite);
  if (!ts.length) return null;
  const t0 = Math.min(now, ...ts);
  return { t0, span: Math.max(now - t0, 36e5), now };
}
const rmPct = x => Math.round(x * 10) / 10;
/** one row's time line: a track to NOW, the item's thread, one stretch per run, a knot for dated evidence without runs, a stub for the future */
function rmTime(i, win) {
  const x = t => rmPct(RM_NOW * Math.min(1, Math.max(0, (t - win.t0) / win.span)));
  const spans = win ? (i.spans || []) : [];
  const parts = [];
  if (spans.length) {
    const a = x(Date.parse(spans[0].from)), end = i.phase === 'past' ? Math.max(...spans.map(s => (s.to ? Date.parse(s.to) : win.now))) : win.now;
    parts.push(`<i class="rmthr" style="left:${a}%;width:${rmPct(x(end) - a)}%"></i>`);
    for (const s of spans) {
      const l = x(Date.parse(s.from)), r = s.to ? x(Date.parse(s.to)) : RM_NOW;
      parts.push(`<i class="rmsp sg-${RM_SG[s.state] || 'idle'}" style="left:${l}%;width:${rmPct(r - l)}%" title="${esc(`${s.run} ${s.state} ${rmDay(s.from)}${s.to ? ' to ' + rmDay(s.to) : ', live'}`)}"></i>`);
    }
  } else if (win && i.last_evidence) parts.push(`<i class="rmknot" style="left:${x(Date.parse(i.last_evidence))}%" title="${esc('evidence ' + rmDay(i.last_evidence))}"></i>`);
  if (i.phase === 'future' || (i.stages || []).some(s => s.state === 'planned') || (i.queued || []).length) parts.push('<i class="rmstub"></i>');
  const label = spans.length ? `${spans.length} run${spans.length === 1 ? '' : 's'} since ${rmDay(spans[0].from)}` : i.phase === 'future' ? `${i.status}, no dates yet` : 'no runs';
  return `<div class="rmtl${spans.length ? '' : ' empty'}" role="img" aria-label="${esc('time line: ' + label)}" title="${esc(label)}"><i class="rmtrack"></i>${parts.join('')}<i class="rmnow"></i></div>`;
}
const rmHead = (i, ctx, par, compact) => `<div class="rmh">${rmChip(i)}${par}<b class="rmt">${esc(i.title)}</b><span class="id">${esc(i.id)}</span>${homeChip(i)}${pendingChips(i)}${i.horizon ? `<span class="tg tg-hz">${esc(i.horizon)}</span>` : ''}${rmLive(i, ctx)}${(i.flags?.drift || []).length ? '<span class="chip bad">drift</span>' : ''}${i.stuck?.flag ? `<span class="chip bad" title="${esc('stuck since ' + i.stuck.flag.ts.slice(0, 16) + 'Z: ' + i.stuck.flag.why.join(', ') + ' - further rounds wait for an approach review')}">stuck</span>` : ''}${compact ? '' : rmProg(i)}${rmEditBtn(i)}</div>`;
function rmRow(i, ctx, win, compact) {
  const f = ctx.rm || {}, hit = f.item === i.id ? ' hit' : '';
  const par = i.depth ? `<span class="rmpar mute small" title="nested item">${'&#8250; '.repeat(i.depth)}</span>` : '';
  const head = rmHead(i, ctx, par, compact);
  const why = `<span class="mute">${esc(i.why)}${compact && i.last ? ' · ' + rmAgo(i.last, ctx.now) : ''}${i.flags?.idle != null ? ` · idle ${i.flags.idle} d` : ''}${i.stuck?.runs ? ` · ${i.stuck.runs} runs, ${i.stuck.days} days, ${i.stuck.stopped_row} stopped in a row` : ''}</span>`;   // META-CATCH S1 (stuck.mjs)
  const body = compact ? `<div class="rmw small">${why} ${rmLinks(i, ctx)}</div>`
    : `<div class="rmw small">${why} ${rmLinks(i, ctx)}</div>${rmStages(i)}${(i.flags?.drift || []).length || (i.flags?.gone || []).length ? `<div class="rmdrift">${i.flags.drift.map(d => `<div>Drift: ${esc(d)}</div>`).join('')}${(i.flags.gone || []).map(g => `<div>Link gone: ${esc(g)}</div>`).join('')}</div>` : ''}`;
  return `<div class="rmi${compact ? ' c' : ''} ph-${esc(i.phase)}${hit}" id="rm-${esc(i.id)}" data-rm-row>${head}${rmTime(i, win)}${body}</div>`;   // desktop: the time line in its own column; phone: under the title
}
const rmFoldText = (items, phase) => (phase === 'past' ? [['shipped', 'shipped'], ['dropped', 'dropped']] : [['queued', 'queued'], ['planned', 'planned'], ['idea', 'idea']])
  .map(([k, w]) => [items.filter(i => i.status === k).length, w]).filter(([n]) => n).map(([n, w]) => (w === 'idea' ? plural(n, 'idea') : `${n} ${w}`)).join(' · ');
const rmFutOrder = i => ['queued', 'planned', 'idea'].indexOf(i.status) * 10 + ({ now: 0, next: 1, later: 3 }[i.horizon] ?? 2);
const RM_SORT = { past: (a, b) => String(b.last || '').localeCompare(String(a.last || '')), present: (a, b) => ((b.live || []).length - (a.live || []).length) || String(b.last || '').localeCompare(String(a.last || '')),
  future: (a, b) => rmFutOrder(a) - rmFutOrder(b) };
const rmPhase = (xs, k) => xs.filter(i => i.phase === k).sort(RM_SORT[k]);
function rmTheme(t, d, ctx, nThemes) {
  const f = ctx.rm || {}, now = ctx.now, filtered = rmFiltered(f);
  const all = rmFlat(t.children || []), win = rmWindow(all, Date.parse(d.generated) || now);
  const vis = all.filter(i => rmMatch(i, f, t.id));
  if (filtered && !vis.length && !all.some(i => i.id === f.item)) return '';
  const [past, pres, fut] = RM_SCOPES.map(k => rmPhase(vis, k));
  const deep = id => [past, pres, fut].findIndex(g => g.some(i => i.id === id));
  const live = all.filter(i => (i.live || []).length).length, c = t.counts || {}, tot = Math.max(1, all.length);
  const open = filtered || deep(f.item) >= 0 || live > 0 || (nThemes <= 5 && (c.present || 0) > 0);
  const rows = (xs, compact) => xs.map(i => rmRow(i, ctx, win, compact)).join('');
  const fold = (xs, ph, isOpen) => (xs.length ? `<details class="rmfold f-${ph}"${isOpen ? ' open' : ''}><summary>${rmFoldText(xs, ph) || plural(xs.length, 'item')}${ph === 'past' ? `<span class="mute small"> · latest ${rmAgo(xs[0].last, now) || 'n/a'}</span>` : ''}</summary>${rows(xs, true)}</details>` : '');
  const winText = win ? `time line ${rmDay(new Date(win.t0).toISOString())} to now` : 'no run yet';
  return `<details class="rmth" id="rmt-${esc(t.id)}"${open ? ' open' : ''}><summary><span class="tw"></span><b>${esc(t.title)}</b><span class="id">${esc(t.id)}</span>${t.state === 'dropped' ? '<span class="chip idle">dropped</span>' : ''}${rmEditBtn(t)}
    <span class="rmthread mini" aria-hidden="true"><i class="th-past" style="flex:${(c.past || 0) / tot}"></i><i class="th-present" style="flex:${(c.present || 0) / tot}"></i><i class="th-future" style="flex:${(c.future || 0) / tot}"></i></span>
    <span class="small mute">${c.past || 0} was · <b class="c-now">${c.present || 0} is</b> · ${c.future || 0} shall be · ${winText}</span>${live ? `<span class="chip running">${live} live</span>` : ''}</summary>
    <div class="rmbody">${fold(past, 'past', filtered || deep(f.item) === 0)}<div class="nowline"><span>NOW</span></div>${f.scope === 'past' || f.scope === 'future' ? '' : rows(pres, false) || '<div class="rmi c mute small">nothing in flight</div>'}${fold(fut, 'future', filtered || deep(f.item) === 2 || fut.length <= 3)}</div></details>`;
}
function rmTop(d, ctx) {
  const f = ctx.rm || {}, c = d.counts || {}, tot = Math.max(1, c.items || 0), words = RM_WORDS[ctx.look === 'norn' ? 'norn' : 'classic'];
  const scope = RM_SCOPES.map((k, n) => `<button type="button" class="sc sc-${k}" data-rm-scope="${k}" aria-pressed="${f.scope === k}" title="${f.scope === k ? 'show all again' : `show only ${['what was', 'what is', 'what shall be'][n]}`}"><span class="nn">${words[n][0]}</span><small>${words[n][1]}</small><b>${c[k] || 0}</b></button>`).join('');
  const sel = (k, label, opts) => `<select data-rmf="${k}" aria-label="${label}"><option value="">${label}</option>${opts.map(([v, t]) => `<option value="${esc(v)}"${String(f[k] || '') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  const statuses = Object.keys(RM_ST).filter(s => rmFlat(d.themes).some(i => i.status === s));
  const views = RM_VIEWS.length > 1 ? `<span class="rmviews" role="group" aria-label="Roadmap view">${RM_VIEWS.map(([k, w]) => `<button type="button" data-rm-view="${k}" aria-pressed="${rmView(f) === k}">${esc(w)}</button>`).join('')}</span>` : '';
  const items = rmFlat(d.themes), shown = items.filter(i => rmMatch(i, f, rmThemeOf(d, i.id))).length;
  return `<div class="rmtop"><div class="rmscope" role="group" aria-label="Show what was, what is or what shall be (tap again for all)">${scope}</div>
    ${c.live ? `<button type="button" class="chip running" data-rmf-set="live" title="show only live items">${c.live} live</button>` : ''}${c.drift ? `<button type="button" class="chip bad" data-rm-jump="rm-drift">${c.drift} drift</button>` : ''}${c.unplaced ? `<button type="button" class="chip warn" data-rm-jump="rm-unplaced">${c.unplaced} unplaced</button>` : ''}${c.claimed ? `<span class="chip idle claimed">${c.claimed} claimed</span>` : ''}${views}<button type="button" class="rmadd" data-rm-edit="new" title="add an item or a theme">+ Add</button></div>
  <div class="rmthread" aria-hidden="true">${RM_SCOPES.map(k => `<i class="th-${k}" style="flex:${(c[k] || 0) / tot}"></i>`).join('')}</div>
  <div class="filters rmfilters"><input type="search" data-rmf="q" value="${esc(f.q || '')}" placeholder="filter titles, ids, branches" aria-label="Filter the roadmap">${sel('theme', 'all themes', (d.themes || []).map(t => [t.id, t.title]))}${sel('status', 'all states', statuses.map(s => [s, RM_ST[s][0]]))}
    <label class="small"><input type="checkbox" data-rmf="live"${f.live ? ' checked' : ''}> live only</label><label class="small"><input type="checkbox" data-rmf="drift"${f.drift ? ' checked' : ''}> drift only</label>
    ${rmFiltered(f) ? `<span class="small mute">showing ${shown} of ${items.length}</span><button type="button" data-rm-clear>show all</button>` : ''}</div>
  <div class="small mute rmsrc">${esc(d.title || d.project)} · ${c.items || 0} items in ${(d.themes || []).length} themes · derived ${esc(fmtTime(d.generated, ctx.now))}${d.error ? ` · <span class="chip bad">error</span> ${esc(d.error)}` : ''}</div>`;
}
const rmThemeOf = (d, id) => (d.themes || []).find(t => rmFlat(t.children || []).some(i => i.id === id))?.id ?? null;
function rmAudit(d, ctx) {
  const dr = rmFlat(d.themes).filter(i => (i.flags?.drift || []).length);
  return `${dr.length ? `<details class="tablecard rmaudit" id="rm-drift"><summary><h3>Drift <span class="chip bad">${dr.length}</span> <span class="mute small">typed text that disagrees with the records - shown, not trusted</span></h3></summary>
    ${dr.map(i => `<div class="rmau"><span class="id">${esc(i.id)}</span> <b>${esc(i.title)}</b><div class="small">${i.flags.drift.map(esc).join('<br>')}</div></div>`).join('')}</details>` : ''}
  ${(d.unplaced || []).length ? `<details class="tablecard rmaudit" id="rm-unplaced"><summary><h3>Unplaced work <span class="chip warn">${d.unplaced.length}</span> <span class="mute small">live lanes, finished branches and directives no roadmap item links</span></h3></summary>
    ${d.unplaced.map(u => `<div class="rmau">${/^(DIR|DEC|Q|RUN|DLV|L:)/.test(u.id) ? rmRid(u.id, ctx) : `<span class="id">${esc(u.id)}</span>`} <span class="small">${esc(u.why || u.text || '')}</span></div>`).join('')}</details>` : ''}`;
}
// ---------- view B (META-ROADMAP S2b, SPEC sec. 4 option B, owner Q-17): the three Norns board ----------
// Columns Urd was / Verdandi is / Skuld shall be (classic: Past / Now / Next); every theme is one grid row, so its heading stands in
// each column at the same height (sticky under the sticky column heads on a desktop). Cards are compact: the head and the time
// line (the reason text is the card's tooltip); the past and the future show four per theme, the rest folded. A scope leaves its column.
function rmCard(i, ctx, win) {
  const hit = (ctx.rm || {}).item === i.id ? ' hit' : '';
  return `<div class="rmi rmcard ph-${esc(i.phase)}${hit}" id="rm-${esc(i.id)}" data-rm-row title="${esc(i.why || '')}">${rmHead(i, ctx, '', true)}${rmTime(i, win)}</div>`;
}
function rmBoard(d, ctx) {
  const f = ctx.rm || {}, filtered = rmFiltered(f), c = d.counts || {}, words = RM_WORDS[ctx.look === 'norn' ? 'norn' : 'classic'];
  const ks = f.scope ? [f.scope] : RM_SCOPES, word = k => words[RM_SCOPES.indexOf(k)];
  const heads = ks.map(k => `<div class="rmcolh col-${k}"><span class="nn">${word(k)[0]}</span><small>${word(k)[1]}</small><b>${c[k] || 0}</b></div>`).join('');
  const rows = d.themes.map(t => {
    const all = rmFlat(t.children || []), win = rmWindow(all, Date.parse(d.generated) || ctx.now), vis = all.filter(i => rmMatch(i, f, t.id));
    if (filtered && !vis.length && !all.some(i => i.id === f.item)) return '';
    return ks.map(k => {
      const its = rmPhase(vis, k), cap = k === 'present' ? its.length : 4, more = its.slice(cap);
      const open = filtered || more.some(i => i.id === f.item);
      const fold = more.length ? `<details class="rmfold f-${k}"${open ? ' open' : ''}><summary>${more.length} more</summary>${more.map(i => rmCard(i, ctx, win)).join('')}</details>` : '';
      return `<div class="rmcell col-${k}" data-theme="${esc(t.id)}"><h4 class="rmgh"><span class="rmgk">${word(k)[0]} · </span>${esc(t.title)} <span class="mute">${its.length}</span></h4>${its.slice(0, cap).map(i => rmCard(i, ctx, win)).join('') || '<div class="rmnone mute small">nothing</div>'}${fold}</div>`;
    }).join('');
  }).join('');
  return rows ? `<section class="rmboard${ks.length === 1 ? ' n1' : ''}">${heads}${rows}</section>` : '';
}
// ---------- META-ROADMAP S3 (SPEC sec. 3): the edit drawer - structure only (title, place, horizon, note, links, drop / reopen) ----------
// Status is never an input: it stays derived. Each action is ONE POST /api/roadmap/<op> = one record by dashboard; a body carries the
// rev the page saw (and a move the order it saw under the target parent), so a stale page gets a 409 instead of a lost edit.
const rmEditBtn = n => `<button type="button" class="rmedit" data-rm-edit="${esc(n.id)}" title="edit ${esc(n.id)}" aria-label="edit ${esc(n.id)}">&#8943;</button>`;
/** id -> { node, parent (node | null), sibs (the ids under the same parent, in record order) } | null */
export function rmFind(d, id) {
  let hit = null;
  const walk = (xs, parent) => { for (const n of xs) { if (n.id === id) hit = { node: n, parent, sibs: xs.map(x => x.id) }; walk(n.children || [], n); } };
  walk(d?.themes || [], null);
  return hit;
}
const RM_HZ = ['now', 'next', 'later'];
const rmList = v => String(v || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
/** a drawer action -> { op, body } (the POST /api/roadmap/<op> body without the project) | { error } */
export function rmEditBody(act, d, id, v = {}) {
  const txt = k => String(v[k] ?? '').trim();
  if (act === 'add') {
    if (!txt('title')) return { error: 'A title is needed.' };
    if (v.parent === 'theme') return { op: 'add', body: { title: txt('title'), kind: 'theme' } };
    if (!v.parent) return { error: 'Pick a theme.' };
    const links = rmList(v.links);
    return { op: 'add', body: { title: txt('title'), parent: v.parent, ...(v.horizon ? { horizon: v.horizon } : {}), ...(txt('note') ? { note: txt('note') } : {}), ...(links.length ? { links } : {}) } };
  }
  const hit = rmFind(d, id);
  if (!hit) return { error: `${id} is not in this roadmap any more. Reload.` };
  const n = hit.node, base = { id, rev: n.rev };
  if (act === 'edit') {
    const ch = {};
    if (v.title !== undefined && txt('title') && txt('title') !== n.title) ch.title = txt('title');
    if (v.note !== undefined && txt('note') !== (n.note || '')) ch.note = txt('note');
    if (v.horizon !== undefined && (v.horizon || null) !== (n.horizon || null)) ch.horizon = v.horizon || '';
    return Object.keys(ch).length ? { op: 'edit', body: { ...base, ...ch } } : { error: 'Nothing changed.' };
  }
  if (act === 'up' || act === 'down') {
    const s = hit.sibs, i = s.indexOf(id);
    if (act === 'up' ? i === 0 : i === s.length - 1) return { error: `Already ${act === 'up' ? 'first' : 'last'}.` };
    return { op: 'move', body: { ...base, after: act === 'up' ? (i >= 2 ? s[i - 2] : null) : s[i + 1], order: s } };
  }
  if (act === 'theme') {
    const t = v.theme && rmFind(d, v.theme);
    if (!t || v.theme === hit.parent?.id) return { error: 'Pick another theme.' };
    return { op: 'move', body: { ...base, parent: v.theme, order: (t.node.children || []).map(x => x.id) } };
  }
  if (act === 'link') { const links = rmList(v.link); return links.length ? { op: 'link', body: { ...base, links } } : { error: 'Name a link: kind:id (dir:DIR-n, lane:name, branch:feat/x ...).' }; }
  if (act === 'unlink') return { op: 'unlink', body: { ...base, links: [v.link] } };
  if (act === 'drop') {
    if (!txt('why')) return { error: 'Say why it is dropped.' };
    if (!/^(DEC|DIR)-[\w-]+$/.test(txt('ref'))) return { error: 'Cite the ruling: a DEC-n or DIR-n.' };
    return { op: 'drop', body: { ...base, why: txt('why'), ref: txt('ref') } };
  }
  if (act === 'reopen') return txt('why') ? { op: 'reopen', body: { ...base, why: txt('why') } } : { error: 'Say why it comes back.' };
  return { error: `unknown action ${act}` };
}
const rmOpt = (v, t, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
/** the drawer body: id = an RM id, or 'new' (add an item or a theme) */
export function renderRmEditor(d, id, ctx = {}) {
  const themes = d?.themes || [], btn = (act, label, cls = '') => `<button type="button" data-rme-act="${act}"${cls ? ` class="${cls}"` : ''}>${label}</button>`;
  const field = (label, html) => `<label class="rmef"><span class="small mute">${label}</span>${html}</label>`;
  const hz = cur => `<select data-rme="horizon">${rmOpt('', 'none', !cur)}${RM_HZ.map(h => rmOpt(h, h, cur === h)).join('')}</select>`;
  const foot = '<p class="small mute">Status is derived from the links, never typed. Each change is one record (by dashboard); every open tab shows it within about 2 s.</p>';
  if (id === 'new') {
    const first = ctx.theme || themes[0]?.id;
    return `<div class="rmed" data-rmed="new"><h3>Add to the roadmap</h3>
      ${field('Under', `<select data-rme="parent">${themes.map(t => rmOpt(t.id, `${t.title} (${t.id})`, t.id === first)).join('')}${rmOpt('theme', '(a new theme)', !themes.length)}</select>`)}
      ${field('Title', '<input data-rme="title" maxlength="200" placeholder="what it is, in a few words">')}
      ${field('Horizon', hz(null))}${field('Note', '<textarea data-rme="note" rows="3" maxlength="4000"></textarea>')}
      ${field('Links', '<input data-rme="links" placeholder="dir:DIR-n, lane:name, branch:feat/x (optional)">')}
      <div class="rmea">${btn('add', 'Add', 'strong')}</div>${foot}</div>`;
  }
  const hit = rmFind(d, id);
  if (!hit) return `<div class="rmed"><p class="mute">${esc(id)} is not in this roadmap any more. ${btn('reload', 'Reload')}</p></div>`;
  const n = hit.node, item = n.kind === 'item', dropped = n.state === 'dropped';
  const sibs = hit.sibs.map(s => rmFind(d, s)?.node).filter(Boolean);
  const place = `<ol class="rmesibs small">${sibs.map(s => `<li${s.id === id ? ' class="me"' : ''}>${esc(s.title)} <span class="id">${esc(s.id)}</span>${s.state === 'dropped' ? ' <span class="mute">dropped</span>' : ''}</li>`).join('')}</ol>`;
  const otherThemes = themes.filter(t => t.id !== hit.parent?.id);
  const ref = (n.links || []).map(l => /^(?:dir|dec):(.+)$/.exec(l)?.[1]).find(Boolean) || '';
  const links = (n.links || []).map(l => `<li><span class="mono small">${esc(l)}</span> <button type="button" class="ghost" data-rme-act="unlink" data-link="${esc(l)}" aria-label="unlink ${esc(l)}" title="unlink">&#215;</button></li>`).join('');
  return `<div class="rmed" data-rmed="${esc(id)}"><h3><span class="id">${esc(id)}</span> ${item ? rmChip(n) : '<span class="chip idle">theme</span>'}${dropped ? ' <span class="chip idle">dropped</span>' : ''}</h3>
    ${item ? `<p class="small mute">${esc(n.why || '')}</p>` : ''}
    ${field('Title', `<input data-rme="title" maxlength="200" value="${esc(n.title)}">`)}${item ? field('Horizon', hz(n.horizon)) : ''}
    ${field('Note', `<textarea data-rme="note" rows="3" maxlength="4000">${esc(n.note || '')}</textarea>`)}
    <div class="rmea">${btn('edit', 'Save', 'strong')}</div>
    <h4>Place</h4>${place}<div class="rmea">${btn('up', '&#8593; Up')}${btn('down', '&#8595; Down')}</div>
    ${item && hit.parent?.kind === 'theme' && otherThemes.length ? `<div class="rmea"><select data-rme="theme" aria-label="move to theme">${otherThemes.map(t => rmOpt(t.id, `${t.title} (${t.id})`, false)).join('')}</select>${btn('theme', 'Move to theme')}</div>` : ''}
    <h4>Links</h4>${links ? `<ul class="rmelinks">${links}</ul>` : '<p class="small mute">no links yet: an item gets its status from what it links</p>'}
    <div class="rmea"><input data-rme="link" placeholder="dir:DIR-n, lane:name, run:RUN-n, branch:feat/x" aria-label="link">${btn('link', 'Link')}</div>
    ${dropped ? `<h4>Dropped</h4><p class="small">${esc(n.dropped?.why || '')}${n.dropped?.ref ? ` (${esc(n.dropped.ref)})` : ''}</p><div class="rmea"><input data-rme="why" placeholder="why it comes back" aria-label="why">${btn('reopen', 'Reopen')}</div>`
      : `<h4>Drop</h4><div class="rmea"><input data-rme="why" placeholder="why" aria-label="why"><input data-rme="ref" value="${esc(ref)}" placeholder="DEC-n or DIR-n" aria-label="the ruling" size="9">${btn('drop', 'Drop', 'bad')}</div>`}
    ${foot}</div>`;
}
export function roadmap(d, ctx) {
  if (!d || !(d.themes || []).length) {   // META-ADOPT A3: what the repository holds + the draft, the questions, or one item by hand
    const a = d?.adopt;
    return `<div class="card" id="rm-empty"><p><b>No roadmap yet</b> for ${esc(ctx.project)}.${a ? ` The repository has ${a.items} planned line(s) in ${a.plans} file(s), ${a.branches} branch(es) in flight.` : ''}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="primary" type="button" data-act="adopt-open" data-project="${esc(ctx.project)}">Draft it from the repository</button><button type="button" data-act="adopt-open" data-ask="scan" data-project="${esc(ctx.project)}">Answer 3 questions instead</button><button type="button" class="rmadd" data-rm-edit="new">+ Add one item</button></div>
      <p class="small mute" style="margin:10px 0 0">Or <code>norn road add</code> / <code>norn road apply plan.json</code>; status is derived from the records, never typed.</p>${d?.error ? `<p class="small">${esc(d.error)}</p>` : ''}</div>`;
  }
  const f = ctx.rm || {}, n = d.themes.length;
  const view = rmView(f), body = view === 'board' ? rmBoard(d, ctx) : d.themes.map(t => rmTheme(t, d, ctx, n)).join('');
  return `<div class="rm rm-${view}">${rmTop(d, ctx)}${body || '<div class="card"><p class="mute">No item matches these filters. <button type="button" data-rm-clear>show all</button></p></div>'}${rmAudit(d, ctx)}</div>`;
}
