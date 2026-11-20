// META-TEND (REPORT s.5.3): the shared chart widgets, built once - `meter` (one value against a max), `bars` (a ranked list, one horizontal bar each), `columns` (one
// value over time, a column per point) and `stack` (one bar split into its parts + a legend). Pure: data -> HTML on the palette's
// CSS variables (index.html .wbars / .wcols / .wstack); every chart carries its numbers as text and an aria-label.
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
 * RM-21 S1: a lane's or run's state (lanes.mjs laneState: { state, why }) -> its chip; with why, the reason under it. The six states are
 * the server's; this is only their colour (index.html .chip classes).
 */
export const STATE_CHIP = { running: 'running', waiting: 'warn', parked: 'parked', stopped: 'stopped', shipped: 'done', idle: 'idle' };
export function stateChip(s, { why = false } = {}) {
  if (!s?.state) return '';
  return `<span class="chip ${STATE_CHIP[s.state] ?? 'idle'}">${esc(s.state)}</span>${why && s.why ? ` <span class="state-why">${esc(s.why)}</span>` : ''}`;
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
export const dodTest = x => `${x.name} exit ${x.code}${x.counts ? `, ${x.counts.pass} pass ${x.counts.fail} fail` : ''}`;
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
