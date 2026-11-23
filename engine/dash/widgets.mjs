// META-TEND (REPORT s.5.3): the shared chart widgets, built once - `meter` (one value against a max), `bars` (a ranked list, one horizontal bar each), `columns` (one
// value over time, a column per point), `stack` (one bar split into its parts + a legend), `capStrip` (the Claude worker pool per
// project), `poolLine` (the header's machine-wide worker pool), `timeChart` / `nornChart` (a zoomable time series; the <norn-chart>
// element at the end) and `outliers` (a ranked top N + a log dot strip). Pure: data -> HTML on the palette's CSS variables (css/base.css
// .wbars / .wcols / .wstack / .wcap / .tchart / .wout); every chart carries its numbers as text and an aria-label.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fin = v => typeof v === 'number' && Number.isFinite(v);
const w = (v, max) => (fin(v) && max > 0 ? Math.max(0, Math.min(100, 100 * v / max)).toFixed(1) : '0');

/** rows [{ label, value, note?, cls? }] -> a ranked list; fmt(value) the number shown; max (default the largest value) */
export function bars(rows, { fmt = String, max, id = '' } = {}) {
  const m = max ?? Math.max(0, ...rows.map(r => (fin(r.value) ? r.value : 0)));
  return `<ol class="wbars"${id ? ` id="${esc(id)}"` : ''}>${rows.map(r => `<li><div class="wbl"><span class="wbn">${esc(r.label)}</span><b class="mono">${esc(fmt(r.value))}</b></div>
    <div class="bar ${esc(r.cls ?? '')}"><i style="width:${w(r.value, m)}%"></i></div>${r.note ? `<div class="small mute wbnote">${r.note}</div>` : ''}</li>`).join('')}</ol>`;
}

/**
 * the live hand-off state (lanes.mjs handoffOf, the `handoff` field every payload carries): ONE chip on every page - a pulsing dot
 * (.pulse, index.html: still under prefers-reduced-motion) + the server's words; amber while pending, blue once the next session talks.
 * self = the run the chip sits on: a chain's other run (the tip) is named after the words. short = the server's short words (a map label).
 */
export function hoChip(h, self = null, { short = false } = {}) {
  if (!h?.text) return '';
  return `<span class="ho ${h.phase === 'resumed' ? 'resumed' : 'pending'}" role="status"${short ? ` title="${esc(h.text)}"` : ''}><span class="pulse" aria-hidden="true"></span><span>${esc(short ? h.short ?? h.text : h.text)}${h.run && self && h.run !== self ? ` <span class="id">${esc(h.run)}</span>` : ''}</span></span>`;
}

/**
 * fair-slots item 8c: the machine's Claude worker pool per project (runs.mjs capacityView: { cap, rows: [{ project, reserved, using,
 * queued, ceiling }] }) -> one line per project: a slot strip (one cell per slot of the cap: filled = in use, ringed = reserved and
 * free, faded = past the project's ceiling) and its numbers as text. Each line wraps under its name, so it fits a phone. mine = the
 * project the page shows (its name in bold).
 */
export function capStrip(v, { id = 'capstrip', mine = null } = {}) {
  if (!v?.rows?.length) return '';
  const cap = fin(v.cap) ? v.cap : null, used = v.rows.reduce((n, r) => n + (r.using || 0), 0);
  const words = r => `${r.using} using · ${r.queued} queued · reserve ${r.reserved} · max ${fin(r.ceiling) ? r.ceiling : 'any'}`;
  const cells = r => cap === null ? '' : `<span class="wslots" aria-hidden="true">${Array.from({ length: cap }, (_, i) => `<i class="${i < r.using ? 'use' : i < r.reserved ? 'res' : fin(r.ceiling) && i >= r.ceiling ? 'off' : ''}"></i>`).join('')}</span>`;
  const aria = `Claude worker pool: ${cap === null ? 'no machine cap' : `${used} of ${cap} in use`}; ${v.rows.map(r => `${r.project} ${words(r)}`).join('; ')}`;
  return `<div class="wcap"${id ? ` id="${esc(id)}"` : ''} role="group" aria-label="${esc(aria)}"><div class="small wtitle">Claude worker pool <b>${cap === null ? 'no machine cap' : `${used} of ${cap}`}</b>${cap === null ? '' : ' in use'} <span class="mute">· every project on this machine</span></div>
    <ol class="wcaprows">${v.rows.map(r => `<li data-project="${esc(r.project)}" title="${esc(`${r.project}: ${words(r)} (max = its ceiling; reserve = slots kept for it while it has queued work)`)}"><span class="wcapn">${r.project === mine ? `<b>${esc(r.project)}</b>` : esc(r.project)}</span>${cells(r)}<span class="small mute mono">${esc(words(r))}</span></li>`).join('')}</ol></div>`;
}

/**
 * UI redesign item 1 + owner list 2026-11-23 item 9: the header's machine line - `Claude u / cap · merge n / cap (reserved) · Codex n /
 * cap · other Claude n`. p = /api/strip's `pool` ({ claude: { using, cap } every project on this machine, sessions: agentprocs.mjs
 * agentSessions | null }), r = its `running` ({ merge: { n, cap, reserved }, codex: { cap }, share: { reserve, ceiling } } for the page's
 * project; absent = not passed, no merge part). p null = the strip has not answered: the one `…`. After that a null field reads "not
 * counted", never a bare `…` (SPEC dash-owner-1123 s.9 W3).
 */
export function poolLine(p, r) {
  const head = 'class="pool small" id="pool" role="group" aria-label="Agent sessions on this computer"';
  if (!p) return `<span ${head}><span class="mute">…</span></span>`;
  const c = p.claude || {}, s = p.sessions, nc = '<span class="mute">not counted</span>', b = v => (fin(v) ? `<b>${v}</b>` : nc), cap = v => (fin(v) ? v : 'no cap');
  const part = (title, html) => `<span title="${esc(title)}">${html}</span>`, m = r?.merge, res = m?.reserved === true ? ' (reserved)' : fin(m?.reserved) && m.reserved > 0 ? ` (${m.reserved} reserved)` : '';
  const sh = r?.share, parts = [part("Norn's Claude worker slots in use of the machine cap, every project on this machine", `Claude ${b(c.using)} / ${cap(c.cap)}`),
    r ? part('the merge slots: kept for merges, a lane worker never takes one', m ? `merge ${b(m.n)} / ${cap(m.cap)}${res}` : `merge ${nc}`) : '',
    part(s ? `Codex sessions on this computer: ${s.codex.norn} started by Norn, ${s.codex.other} others` : 'Codex sessions on this computer: not counted', `Codex ${b(s?.codex.norn)}${r?.codex ? ` / ${cap(r.codex.cap)}` : ''}`),
    part('Claude Code sessions on this computer that Norn did not start (a terminal, an IDE, the desktop app)', `other Claude ${b(s?.claude.other)}`),
    sh ? part("this project's share of the Claude pool (Settings > Capacity)", `this project: reserve ${fin(sh.reserve) ? sh.reserve : 0}, max ${fin(sh.ceiling) ? sh.ceiling : 'any'}`) : ''];
  return `<span ${head}>${parts.filter(Boolean).join('<span class="psep" aria-hidden="true">·</span>')}</span>`;
}

/** one value against a max -> a single bar, an optional tick at `mark` (a p90, a hand-off line); no data = a dash */
export function meter(v, max, mark, cls = '') {
  if (!fin(v) || !fin(max) || max <= 0) return '<span class="mute">-</span>';
  return `<div class="bar ${esc(cls)}" title="${esc(v)} of ${esc(max)}"><i style="width:${Math.min(100, 100 * v / max).toFixed(1)}%"></i>${fin(mark) ? `<u style="left:${Math.min(100, 100 * mark / max).toFixed(1)}%"></u>` : ''}</div>`;
}

// UX review 6: every time chart says what it plots and over what - the y axis starts at a labelled 0 (the baseline) and its top is the
// largest value with its unit; the x axis names the first and last point and the period (n points / n days); the title is visible text.
const yAxis = (top, unit) => `<div class="wyax small mute" aria-hidden="true"><span>${esc(top)}${unit ? ` ${esc(unit)}` : ''}</span><span>0</span></div>`;
const chartTitle = (title, unit) => (title ? `<div class="small wtitle">${esc(title)}${unit ? ` <span class="mute">(${esc(unit)})</span>` : ''}</div>` : '');

/** points [{ label, value, cls? }] in time order -> one column each from a 0 baseline; the y axis 0 .. max (unit), the x axis first / last
 * label and the period (`per`: what one column is, e.g. 'day' -> "14 days") */
export function columns(points, { fmt = String, title = '', id = '', unit = '', per = 'point', showTitle = false } = {}) {
  const m = Math.max(0, ...points.map(p => (fin(p.value) ? p.value : 0)));
  const aria = `${title}${unit ? ` (${unit})` : ''}: ${points.map(p => `${p.label} ${fmt(p.value)}`).join(', ')}`;
  return `<div class="wcols"${id ? ` id="${esc(id)}"` : ''} role="img" aria-label="${esc(aria)}">${showTitle ? chartTitle(title, unit) : ''}<div class="wplot">${yAxis(fmt(m), unit)}<div class="wcolrow">${points.map(p => `<span class="wcol ${esc(p.cls ?? '')}" style="height:${w(p.value, m)}%" title="${esc(`${p.label}: ${fmt(p.value)}${unit ? ' ' + unit : ''}`)}"></span>`).join('')}</div></div>
    <div class="wcolax small mute"><span>${esc(points[0]?.label ?? '')}</span><span>${esc(`${points.length} ${per}${points.length === 1 ? '' : 's'}`)}</span><span>${esc(points.at(-1)?.label ?? '')}</span></div></div>`;
}

/** parts [{ key, label, value }] -> one bar split by value + a legend; colour class seg-<key> */
export function stack(parts, { fmt = String, id = '' } = {}) {
  const ps = parts.filter(p => fin(p.value) && p.value > 0), tot = ps.reduce((n, p) => n + p.value, 0) || 1;
  return `<div class="wstack"${id ? ` id="${esc(id)}"` : ''}><div class="insbar" role="img" aria-label="${esc(ps.map(p => `${p.label} ${fmt(p.value)}`).join(', '))}">${ps.map(p => `<span class="insseg seg-${esc(p.key)}" style="width:${(100 * p.value / tot).toFixed(2)}%" title="${esc(`${p.label} ${fmt(p.value)}`)}"></span>`).join('')}</div>
    <div class="small inslegend">${ps.map(p => `<span><i class="insdot seg-${esc(p.key)}"></i>${esc(p.label)} ${esc(fmt(p.value))}</span>`).join(' ')}</div></div>`;
}

/** cols [{ key, label, cards: [html], note?, more? }] -> a board: one column per state, its count in the header, the cards stacked (META-TEND P3: the ladder) */
export function board(cols, { id = '', aria = '' } = {}) {
  return `<div class="wboard"${id ? ` id="${esc(id)}"` : ''} role="list" aria-label="${esc(aria || cols.map(c => `${c.label} ${c.cards.length + (c.more || 0)}`).join(', '))}">${cols.map(c => `<section class="wbcol wb-${esc(c.key)}" role="listitem">
    <h4>${esc(c.label)} <b>${c.cards.length + (c.more || 0)}</b></h4>${c.cards.length ? c.cards.map(x => `<div class="wbcard">${x}</div>`).join('') : `<p class="small mute">${esc(c.note ?? 'none')}</p>`}${c.more ? `<p class="small mute">+${c.more} more</p>` : ''}</section>`).join('')}</div>`;
}

/** series [{ key, label, points: [{ x (a day, YYYY-MM-DD), y }] }] over `days` (the x axis, in order) -> one SVG line per series + a
 * legend with each series' last value (META-TEND P5: "is it growing forever?"); colour class ln-<n> (the --k series) */
export function lines(series, { days = [], fmt = String, id = '', title = '', unit = '' } = {}) {
  const W = 600, H = 150, P = 4, max = Math.max(1, ...series.flatMap(s => s.points.map(p => p.y)).filter(fin));
  const X = d => (days.length > 1 ? P + (W - 2 * P) * days.indexOf(d) / (days.length - 1) : W / 2), Y = v => H - P - (H - 2 * P) * v / max;
  const pts = s => s.points.filter(p => fin(p.y) && days.includes(p.x)).sort((a, b) => days.indexOf(a.x) - days.indexOf(b.x));
  const last = s => pts(s).at(-1);
  const aria = `${title}${unit ? ` (${unit})` : ''}, ${days[0] ?? ''} to ${days.at(-1) ?? ''}: ${series.map(s => `${s.label} ${last(s) ? fmt(last(s).y) : 'none'}`).join(', ')}`;
  const svg = series.map((s, i) => { const ps = pts(s); return `<g class="ln ln-${(i % 9) + 1}">${ps.length > 1 ? `<polyline points="${ps.map(p => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')}"/>` : ''}${ps.map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="3"><title>${esc(`${s.label} ${p.x}: ${fmt(p.y)}`)}</title></circle>`).join('')}</g>`; }).join('');
  return `<div class="wlines"${id ? ` id="${esc(id)}"` : ''}><div class="wplot">${yAxis(fmt(max), unit)}<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(aria)}"><line class="lnax" x1="0" y1="${H - P}" x2="${W}" y2="${H - P}"/>${svg}</svg></div>
    <div class="wcolax small mute"><span>${esc(days[0] ?? '')}</span><span>${esc(`${days.length} day${days.length === 1 ? '' : 's'}`)}</span><span>${esc(days.at(-1) ?? '')}</span></div>
    <div class="small inslegend">${series.map((s, i) => `<span><i class="insdot ln-${(i % 9) + 1}"></i>${esc(s.label)} ${last(s) ? `<b>${esc(fmt(last(s).y))}</b>` : '-'}</span>`).join(' ')}</div></div>`;
}

// META-DOD 1 (DIR-68): a run's Definition of Ready (its brief's Scope / Tests / Done lines at norn run) and Definition of Done (Norn's
// own run-end check) as two chips with the evidence; ready = the start record's dod_ready, done = the end record's dod (null = not checked)
// a gate job also names its suite mode, files and time (lib/dod.mjs testLine: "gate: changed, 6 files, 41 s"; a cut run "209/227 files")
const dodSuite = (s, ms) => `gate: ${s.mode}${s.files == null ? '' : `, ${s.done < s.files ? `${s.done}/` : ''}${s.files} file${s.files === 1 ? '' : 's'}`}${ms != null ? `, ${Math.round(ms / 1000)} s` : ''}`;
export const dodTest = x => `${x.name} exit ${x.code}${x.counts ? `, ${x.counts.pass} pass ${x.counts.fail} fail` : ''}${x.suite ? ` (${dodSuite(x.suite, x.ms)})` : ''}`;
export function dodEvidence(ready, done) {
  const r = ready ? (ready.ok ? 'Ready: Scope / Tests / Done lines present' : `Ready: the brief lacks ${(ready.missing || []).join(', ')} (policy ${ready.mode})`) : null;
  const d = done ? `Done: ${done.ok ? 'green' : done.why}${(done.tests || []).length ? ` · ${done.tests.map(dodTest).join(' · ')}` : ''}` : null;
  return [r, d].filter(Boolean);
}
export function dodChips(ready, done, { evidence = false } = {}) {
  if (!ready && !done) return '';
  const [er, ed] = [ready ? dodEvidence(ready, null)[0] : '', done ? dodEvidence(null, done)[0] : ''];
  const one = (v, word, ev) => `<span class="chip ${v.ok ? 'ok' : 'bad'}" title="${esc(ev)}">${word} ${v.ok ? '✓' : '✗'}</span>`;
  const chips = [ready ? one(ready, 'Ready', er) : '', done ? one(done, 'Done', ed) : ''].filter(Boolean).join(' ');
  return `<span class="dod">${chips}</span>${evidence ? `<div class="small mute dodev">${dodEvidence(ready, done).map(esc).join('<br>')}</div>` : ''}`;
}
// META-DOD 3: a plan run's fresh-eyes review (agents.mjs node.critique): queued / running / reviewed ✓ (n findings) / review ✗ (its end)
export function critiqueWord(c) {
  const n = c.findings, done = c.state === 'exited' && c.outcome === 'done';
  return ['queued', 'running'].includes(c.state) ? ['warn', `review ${c.state}`] : done ? ['ok', `reviewed ✓ (${n ?? '?'} finding${n === 1 ? '' : 's'})`] : ['bad', `review ✗ (${c.outcome ?? c.state})`];
}
export function critiqueChip(c) {
  if (!c) return '';
  const [cls, word] = critiqueWord(c);
  return ` <span class="dod"><span class="chip ${cls}" title="${esc(`${c.run}${c.file ? ': ' + c.file : ''}`)}">${word}</span></span>`;
}

// ---- owner list 2026-11-23 item 2 (SPEC dash-owner-1123 s.2): a real time-series chart, own SVG (no vendored library: string-testable,
// palette-locked). Axis ticks are Heckbert's "nice numbers" (Graphics Gems 1990, as d3-scale `ticks`); the window is focus + context
// (an overview strip, the d3-brush / ECharts dataZoom pattern). The viewBox keeps its aspect (meet), so a dot stays round; the plot clips
// at the window's edges plus a dot's radius, so an edge dot stays whole.
const niceNum = (x, round) => { const e = Math.floor(Math.log10(x)), f = x / 10 ** e;
  return (round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10)) * 10 ** e; };
/** lo..hi -> about n nice ticks covering it (the first <= lo, the last >= hi) */
export function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) hi = lo + 1;
  const step = niceNum(niceNum(hi - lo, false) / (n - 1), true), out = [];
  for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 2; v += step) out.push(+v.toPrecision(12));
  return out;
}
const tickFmt = v => (Math.abs(v) >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${+(v / 1e3).toFixed(2)}k` : `${+v.toFixed(2)}`);
const TC = { W: 600, H: 200, l: 44, r: 10, t: 10, b: 22, OH: 36 }, TPW = TC.W - TC.l - TC.r, TPH = TC.H - TC.t - TC.b;
const f1 = v => v.toFixed(1);
/** the window [x0, x1] (day indexes) clamped to 0..n-1, at least one day wide; null = everything */
export function clampView(v, n) {
  const hi = Math.max(0, n - 1);
  if (!v || !fin(v[0]) || !fin(v[1])) return [0, hi];
  const span = Math.min(hi, Math.max(Math.min(1, hi), v[1] - v[0])), x0 = Math.max(0, Math.min(hi - span, v[0]));
  return [x0, x0 + span];
}

/**
 * series [{ key, label, points: [{ x (YYYY-MM-DD), y, t? (y formatted) }] }] over `days` (the x axis, in order) -> one SVG chart: nice y
 * ticks + gridlines, day ticks, a line + round dots per series (colour class ln-<n>, n = its place), a per-day read-out (hover a day), an
 * overview strip with the window, a legend whose buttons toggle series, a Reset button. view [x0, x1] = the window in day indexes
 * (fractions allowed; null = all); hidden = the series keys not drawn. The aria label is the text summary.
 */
export function timeChart(series, { days = [], view = null, hidden = [], fmt = String, unit = '', id = '', title = '' } = {}) {
  const n = days.length, [x0, x1] = clampView(view, n), span = x1 - x0 || 1, all = x0 === 0 && x1 === Math.max(0, n - 1);
  const ix = new Map(days.map((d, i) => [d, i])), hid = new Set(hidden), inW = i => i >= x0 - 1e-9 && i <= x1 + 1e-9;
  const S = series.map((s, k) => ({ ...s, k: (k % 9) + 1, hidden: hid.has(s.key), pts: s.points.filter(p => fin(p.y) && ix.has(p.x)).map(p => ({ ...p, i: ix.get(p.x), t: p.t ?? fmt(p.y) })).sort((a, b) => a.i - b.i) }));
  const shown = S.filter(s => !s.hidden), win = s => s.pts.filter(p => inW(p.i));
  const ticks = niceTicks(0, Math.max(0, ...shown.flatMap(s => win(s).map(p => p.y))) || 1), top = ticks.at(-1);
  const X = i => (n > 1 ? TC.l + TPW * (i - x0) / span : TC.l + TPW / 2), Y = v => TC.t + TPH * (1 - v / top), base = TC.t + TPH;
  const lastOf = s => win(s).at(-1), cid = `tcclip-${id || 'chart'}`, from = days[Math.ceil(x0 - 1e-9)] ?? '', to = days[Math.floor(x1 + 1e-9)] ?? '';
  const aria = `${title}${unit ? ` (${unit})` : ''}, ${from} to ${to}: ${S.map(s => (s.hidden ? `${s.label} hidden` : `${s.label} ${lastOf(s)?.t ?? 'none'}`)).join(', ')}`;
  const grid = ticks.map(v => `<line class="tcgrid" x1="${TC.l}" y1="${f1(Y(v))}" x2="${TC.W - TC.r}" y2="${f1(Y(v))}"/><text class="tcy" x="${TC.l - 6}" y="${f1(Y(v) + 4)}" text-anchor="end">${esc(tickFmt(v))}</text>`).join('');
  const step = [1, 2, 7, 14, 28, 56].find(s => span / s <= 7) ?? Math.ceil(span / 7), xi = [];
  for (let i = Math.ceil(x0 - 1e-9); i <= Math.floor(x1 + 1e-9); i++) if ((n - 1 - i) % step === 0) xi.push(i);
  const xax = xi.map(i => `<text class="tcx" x="${f1(X(i))}" y="${TC.H - 6}" text-anchor="${X(i) > TC.W - 40 ? 'end' : X(i) < TC.l + 20 ? 'start' : 'middle'}">${esc(days[i].slice(5))}</text>`).join('');
  const bw = n > 1 ? TPW / (span + 1) : TPW, hov = [];
  for (let i = Math.ceil(x0 - 1e-9); i <= Math.floor(x1 + 1e-9); i++) {
    const on = shown.map(s => [s, s.pts.find(p => p.i === i)]).filter(([, p]) => p), hx = Math.max(TC.l, X(i) - bw / 2);
    if (on.length) hov.push(`<rect class="tchov" x="${f1(hx)}" y="${TC.t}" width="${f1(Math.min(bw, TC.W - TC.r - hx))}" height="${TPH}"><title>${esc(`${days[i]}: ${on.map(([s, p]) => `${s.label} ${p.t}`).join(' · ')}`)}</title></rect>`);
  }
  const lines = shown.map(s => `<g class="ln ln-${s.k}" clip-path="url(#${cid})">${s.pts.length > 1 ? `<polyline points="${s.pts.map(p => `${f1(X(p.i))},${f1(Y(p.y))}`).join(' ')}"/>` : ''}${win(s).map(p => `<circle cx="${f1(X(p.i))}" cy="${f1(Y(p.y))}" r="3"><title>${esc(`${s.label} ${p.x}: ${p.t}`)}</title></circle>`).join('')}</g>`).join('');
  // the overview: every shown series over every day on its own scale, the window drawn on it (dragged by the element)
  const om = Math.max(1, ...shown.flatMap(s => s.pts.map(p => p.y))), OX = i => (n > 1 ? TC.l + TPW * i / (n - 1) : TC.l + TPW / 2), OY = v => TC.OH - 3 - (TC.OH - 6) * v / om;
  const wx = n > 1 ? OX(x0) : TC.l, ww = n > 1 ? TPW * (x1 - x0) / (n - 1) : TPW;
  const ov = `<svg class="tcov" viewBox="0 0 ${TC.W} ${TC.OH}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><rect class="tcovbg" x="${TC.l}" y="1" width="${TPW}" height="${TC.OH - 2}"/>${shown.map(s => (s.pts.length > 1 ? `<g class="ln ln-${s.k}"><polyline points="${s.pts.map(p => `${f1(OX(p.i))},${f1(OY(p.y))}`).join(' ')}"/></g>` : '')).join('')}<rect class="tcwin" x="${f1(wx)}" y="1" width="${f1(Math.max(4, ww))}" height="${TC.OH - 2}"/></svg>`;
  const legend = S.map(s => `<button type="button" class="tcleg ln-${s.k}" data-series="${esc(s.key)}" aria-pressed="${!s.hidden}"><i class="insdot ln-${s.k}"></i>${esc(s.label)} ${s.hidden ? '<span class="mute">hidden</span>' : lastOf(s) ? `<b>${esc(lastOf(s).t)}</b>` : '-'}</button>`).join('');
  return `<div class="tchart"${id ? ` data-chart="${esc(id)}"` : ''}><div class="tchead"><span class="small wtitle">${esc(title)}${unit ? ` <span class="mute">(${esc(unit)})</span>` : ''}</span><span class="small mute">${esc(from)} to ${esc(to)}</span><button type="button" class="tcreset"${all ? ' disabled' : ''} title="show every day (or double-click, or the 0 key)">Reset</button></div>
    <svg class="tcplot" viewBox="0 0 ${TC.W} ${TC.H}" preserveAspectRatio="xMidYMid meet" role="img" tabindex="0" aria-label="${esc(aria)}"><defs><clipPath id="${esc(cid)}"><rect x="${TC.l - 4}" y="0" width="${TPW + 8}" height="${TC.H}"/></clipPath></defs>${grid}<line class="lnax" x1="${TC.l}" y1="${base}" x2="${TC.W - TC.r}" y2="${base}"/>${xax}${hov.join('')}${lines}</svg>
    ${ov}<div class="small mute tchint">wheel or pinch = zoom · drag = pan · drag the strip = move the window · +, -, arrows, 0</div><div class="small inslegend tclegend">${legend}</div></div>`;
}

/** the zoom window and the hidden series of every <norn-chart>, by chart id: a stream repaint renders a new element, which takes these up */
export const CHART_VIEWS = new Map();
/** timeChart wrapped in <norn-chart>: the data rides in a JSON script child (each point with its formatted value `t`); the kept window applies */
export function nornChart(series, opts = {}) {
  const fmt = opts.fmt ?? String, st = CHART_VIEWS.get(opts.id), data = series.map(s => ({ key: s.key, label: s.label, points: s.points.map(p => ({ x: p.x, y: p.y, t: p.t ?? fmt(p.y) })) }));
  const json = JSON.stringify({ series: data, days: opts.days ?? [], unit: opts.unit ?? '', title: opts.title ?? '', id: opts.id ?? '' }).replace(/</g, '\\u003c');
  return `<norn-chart id="${esc(opts.id ?? '')}"><script type="application/json">${json}</script>${timeChart(data, { ...opts, view: st?.view ?? null, hidden: st?.hidden ?? [] })}</norn-chart>`;
}

// ---- SPEC dash-owner-1123 s.1.4: the outlier chart - the slowest N as ranked bars, then every point on a log axis; past Tukey's upper
// fence (Q3 + 1.5 IQR, the box-plot standard; Tukey 1977) is marked `out`, a point whose max is over 3x its median is marked `spread`.
/** values -> { q1, q3, fence }: quartiles by linear interpolation (type 7, as d3.quantile / numpy); no value = null */
export function tukey(values) {
  const s = values.filter(fin).sort((a, b) => a - b);
  if (!s.length) return null;
  const q = p => { const h = (s.length - 1) * p, lo = Math.floor(h); return s[lo] + (h - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]); }, q1 = q(0.25), q3 = q(0.75);
  return { q1, q3, fence: q3 + 1.5 * (q3 - q1) };
}
/** points [{ id, label, value (a median), max? }] -> the ranked top N + the log strip; every bar and dot a button with data-act = act, data-id */
export function outliers(points, { fmt = String, unit = '', top = 15, id = '', act = '' } = {}) {
  const ps = points.filter(p => fin(p.value));
  if (!ps.length) return '';
  const t = tukey(ps.map(p => p.value)), out = p => p.value > t.fence, spread = p => fin(p.max) && p.value > 0 && p.max / p.value > 3;
  const cls = p => `${out(p) ? ' out' : ''}${spread(p) ? ' spread' : ''}`, attrs = p => `${act ? ` data-act="${esc(act)}"` : ''} data-id="${esc(p.id)}"`;
  const why = p => `${p.label}: ${fmt(p.value)}${fin(p.max) ? `, max ${fmt(p.max)}` : ''}${out(p) ? ' · past the fence' : ''}${spread(p) ? ' · slow sometimes (max over 3x the median)' : ''}`;
  const ranked = [...ps].sort((a, b) => b.value - a.value).slice(0, top), m = ranked[0].value;
  // the log axis: whole decades from the smallest positive value to the largest (a zero sits on the left edge)
  const pos = ps.filter(p => p.value > 0).map(p => p.value), a = pos.length ? Math.floor(Math.log10(Math.min(...pos))) : 0, b0 = pos.length ? Math.ceil(Math.log10(Math.max(...pos))) : 1;
  const b = b0 > a ? b0 : a + 1, L = v => (100 * (Math.log10(Math.min(10 ** b, Math.max(v, 10 ** a))) - a) / (b - a)).toFixed(1), nOut = ps.filter(out).length, nSp = ps.filter(spread).length;
  const aria = `${ps.length} measured, Q1 ${fmt(t.q1)}, Q3 ${fmt(t.q3)}, fence ${fmt(t.fence)}, ${nOut} past the fence, ${nSp} slow sometimes`;
  return `<div class="wout"${id ? ` id="${esc(id)}"` : ''} role="group" aria-label="${esc(aria)}"><ol class="wobars">${ranked.map(p => `<li><button type="button" class="wobar${cls(p)}"${attrs(p)} title="${esc(why(p))}"><span class="wbn">${esc(p.label)}</span><span class="bar"><i style="width:${w(p.value, m)}%"></i></span><b class="mono">${esc(fmt(p.value))}</b></button></li>`).join('')}</ol>
    <div class="small wtitle">All ${ps.length} measured (log${unit ? ` ${esc(unit)}` : ''}) <span class="mute">fence ${esc(fmt(t.fence))}</span> · outliers (${nOut})${nSp ? ` · <span class="mute">slow sometimes (${nSp})</span>` : ''}</div>
    <div class="wostrip"><span class="woq" style="left:${L(t.q1)}%" title="${esc(`Q1 ${fmt(t.q1)}`)}"></span><span class="woq" style="left:${L(t.q3)}%" title="${esc(`Q3 ${fmt(t.q3)}`)}"></span><span class="wofence" style="left:${L(t.fence)}%" title="${esc(`fence ${fmt(t.fence)} (Q3 + 1.5 IQR)`)}"></span>${ps.map(p => `<button type="button" class="wodot${cls(p)}"${attrs(p)} style="left:${L(p.value)}%" title="${esc(why(p))}" aria-label="${esc(why(p))}"></button>`).join('')}</div>
    <div class="woax small mute"><span>${esc(fmt(10 ** a))}</span><span>${esc(fmt(10 ** b))}</span></div></div>`;
}

// ---- <norn-chart>: the browser half of nornChart (defined only where custom elements exist, so node imports this module as-is). Its own
// listeners (the web-platform way, as GitHub's <relative-time>): wheel / pinch zoom around the pointer, drag pan, the overview window
// drag, double-click / Reset / 0 = everything, + / - / arrows. Every change repaints through timeChart and lands in CHART_VIEWS.
if (globalThis.customElements && !globalThis.customElements.get('norn-chart')) {
  globalThis.customElements.define('norn-chart', class extends HTMLElement {
    connectedCallback() {
      try { this.data = JSON.parse(this.querySelector('script[type="application/json"]')?.textContent || 'null'); } catch { this.data = null; }
      if (!this.data) return;
      if (CHART_VIEWS.has(this.id)) this.paint();
      if (this.wired) return;
      this.wired = true; this.ptrs = new Map();
      this.addEventListener('wheel', e => { const c = this.at(e, '.tcplot'); if (c === null) return; e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.25 : 0.8, c); }, { passive: false });
      this.addEventListener('pointerdown', e => this.down(e)); this.addEventListener('pointermove', e => this.move(e));
      for (const k of ['pointerup', 'pointercancel']) this.addEventListener(k, e => { this.ptrs.delete(e.pointerId); if (!this.ptrs.size) this.drag = null; });
      this.addEventListener('dblclick', e => { if (e.target.closest('.tcplot, .tcov')) this.set(null); });
      this.addEventListener('click', e => { const g = e.target.closest('.tcleg'); if (e.target.closest('.tcreset')) this.set(null);
        else if (g) { const h = new Set(this.st.hidden); if (!h.delete(g.dataset.series)) h.add(g.dataset.series); this.st.hidden = [...h]; this.paint(); } });
      this.addEventListener('keydown', e => { if (e.target.closest('button')) return; const [x0, x1] = this.view(), s = x1 - x0, c = (x0 + x1) / 2;
        const go = { '+': () => this.zoom(0.8, c), '=': () => this.zoom(0.8, c), '-': () => this.zoom(1.25, c), '_': () => this.zoom(1.25, c),
          ArrowLeft: () => this.set([x0 - s / 10, x1 - s / 10]), ArrowRight: () => this.set([x0 + s / 10, x1 + s / 10]), 0: () => this.set(null) }[e.key];
        if (go) { e.preventDefault(); e.stopPropagation(); go(); } });
    }
    get st() { let s = CHART_VIEWS.get(this.id); if (!s) CHART_VIEWS.set(this.id, s = { view: null, hidden: [] }); return s; }
    get n() { return this.data.days.length; }
    view() { return clampView(this.st.view, this.n); }
    set(v) { const c = v && clampView(v, this.n); this.st.view = c && (c[0] > 0 || c[1] < this.n - 1) ? c : null; this.paint(); }
    zoom(f, c) { const [x0, x1] = this.view(), s = x1 - x0 || 1, ns = Math.min(this.n - 1, Math.max(Math.min(1, this.n - 1), s * f)), a = c - (c - x0) * ns / s; this.set([a, a + ns]); }
    // a pointer in the viewBox units of the svg matching sel; at() = that place as a day index on the main plot (null = not over it)
    vb(e, sel) { const m = this.querySelector(sel)?.getScreenCTM(); return m ? new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()) : null; }
    at(e, sel) { if (!e.target.closest?.(sel)) return null; const p = this.vb(e, sel), [x0, x1] = this.view(); return p ? x0 + (p.x - TC.l) / TPW * (x1 - x0) : null; }
    down(e) {
      const ov = e.target.closest('.tcov'); if (!ov && !e.target.closest('.tcplot')) return;
      this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); try { this.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer has no capture: the drag still works while over the chart */ }
      if (ov) { const p = this.vb(e, '.tcov'), v = this.view(), i = p ? (p.x - TC.l) / TPW * (this.n - 1) : v[0]; if (i < v[0] || i > v[1]) { const h = (v[1] - v[0]) / 2; this.set([i - h, i + h]); } }
      const ps = [...this.ptrs.values()], two = ps.length > 1, sc = this.querySelector(ov ? '.tcov' : '.tcplot')?.getScreenCTM()?.a || 1;
      this.drag = { ov: !!ov, x: e.clientX, v: this.view(), sc, dist: two ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0,
        mid: two ? this.at({ target: e.target, clientX: (ps[0].x + ps[1].x) / 2, clientY: (ps[0].y + ps[1].y) / 2 }, '.tcplot') : null };
    }
    move(e) {
      const d = this.drag; if (!d || !this.ptrs.has(e.pointerId)) return;
      this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [x0, x1] = d.v, s = x1 - x0, ps = [...this.ptrs.values()];
      if (ps.length > 1 && d.dist && d.mid !== null) { const ns = s * d.dist / (Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) || 1), a = d.mid - (d.mid - x0) * ns / (s || 1); this.set([a, a + ns]); return; }
      const dx = (e.clientX - d.x) / d.sc / TPW, di = d.ov ? dx * (this.n - 1) : -dx * s;
      this.set([x0 + di, x1 + di]);
    }
    paint() {
      const old = this.querySelector('.tchart'); if (!old) return;
      const had = this.contains(document.activeElement), t = document.createElement('div');
      t.innerHTML = timeChart(this.data.series, { ...this.data, view: this.st.view, hidden: this.st.hidden });
      old.replaceWith(t.firstElementChild); if (had) this.querySelector('.tcplot')?.focus();
    }
  });
}
