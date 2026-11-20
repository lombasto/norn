// The Plan page (moved verbatim from ui.mjs, stage NAV): up next, chains, landing next (/api/plan); its usage forecast renders on Usage (forecastCard).
import { esc, fin, pct, dwarfName, chip, backlogLine } from '../cells.mjs';
import { meter } from '../widgets.mjs';

// ---------- the Plan tab (META-PLAN R1, norn DIR-13): what happens next, and when - /api/plan = engine/lib/plan.mjs per project ----------
// Up next (the queue in fill order, hold-ups in plain words; it moved here from Agents), Chains (one line per dependency chain), Landing
// next (heading to main), Forecast (usage now vs the cap and the weekly stop). Status shapes: check / play / ring / pause / stop / !
// (text + colour, as every chip).
const PL_SHAPE = { check: ['done', '✓'], play: ['running', '▶'], ring: ['idle', '○'], pause: ['parked', '‖'], stop: ['stopped', '■'], '!': ['needs', '!'] };
const PL_STATUS = { ready: ['ok', 'ready'], waiting: ['idle', 'waiting'], held: ['parked', 'held'], offered: ['idle', 'offered'], ruling: ['needs', 'needs a ruling'] };
// R2: one day-aware clock, the same as engine/lib/plan.mjs dayClock ("today 21:41", "Fri 02:13", farther "Fri 11-20 02:13"), drawn here in
// the VIEWER's zone from the model's ISO times (named once at the top of the tab)
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dayClock(ms, now = Date.now()) {
  const p = n => String(n).padStart(2, '0'), d = new Date(ms), n = new Date(now), hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const mid = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(), days = Math.round(Math.abs(mid(d) - mid(n)) / 86400000);
  return days === 0 ? `today ${hm}` : days < 7 ? `${DAY_NAMES[d.getDay()]} ${hm}` : `${DAY_NAMES[d.getDay()]} ${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}
const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local time'; } catch { return 'your local time'; } };
const plAt = (iso, now) => (Number.isFinite(Date.parse(iso ?? '')) ? dayClock(Date.parse(iso), now) : null);
// one shape per step: the glyph is the classic look's; the norn look draws its status token instead (norn.css hides .pl-g)
const plShape = (cls, g, word) => `<span class="chip ${esc(cls)}" aria-label="${esc(word)}"><span class="pl-g" aria-hidden="true">${esc(g)}</span></span>`;
const plSection = (id, title, note, body) => `<div class="tablecard pl-sec" id="${id}"><h3>${esc(title)} <span class="mute small">${esc(note)}</span></h3>${body}</div>`;
const plEmpty = t => `<p class="pl-empty mute">${esc(t)}</p>`;
const plBasis = e => (e.basis === 'history' ? `median of ${e.n} finished runs` : e.basis === 'budget' ? 'its time budget' : 'no basis');
function planPart(p, ctx) {
  const now = ctx.now ?? Date.now(), head = ctx.project === 'all' ? `<h2 class="pl-proj">${esc(p.project)}</h2>` : '';
  if (p.pending) return `${head}<div class="card pl-sec"><p class="mute">Working out the plan for ${esc(p.project)} ...</p></div>`;
  if (p.error) return `${head}<div class="card pl-sec"><p class="mute">The plan could not be worked out: ${esc(p.error)}</p></div>`;
  const up = (p.upnext || []).map(u => {
    const [c, w] = PL_STATUS[u.status] ?? ['idle', u.status];
    const prio = (p.priorities || []).length ? ` <select class="pl-prio" data-act="prio" data-project="${esc(p.project)}" data-run="${esc(u.id)}" aria-label="priority of ${esc(u.id)}" title="re-queue at this priority (its conditions are kept)">${p.priorities.map(x => `<option${x === (u.priority ?? 'P2') ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>` : '';
    return `<div class="pl-row" id="pl-${esc(u.id)}"><span class="mono pl-pos">#${esc(u.position)}</span><span class="pl-what"><b>${esc(u.label)}</b> <span class="id">${esc(u.id)}</span>${u.dwarf ? `${dwarfName(u.dwarf)} takes it` : ''}${prio}</span>
      ${chip(c, w)}<span class="small pl-est" title="${esc(plBasis(u.estimate))}">${esc(u.estimate.word)}</span><span class="small pl-start"${u.start.why ? ` title="${esc(u.start.why)}"` : ''}>start ${esc(u.start.at && u.start.word !== 'now' ? `~${plAt(u.start.at, now)}` : u.start.word)}</span>
      <span class="pl-holds small">${u.holds.map((h, i) => esc(u.holdAt?.[i] ? `not before ${plAt(u.holdAt[i], now)}` : h)).join('<br>')}</span></div>`;
  }).join('');
  const step = st => {
    const [cls, g] = PL_SHAPE[st.shape] ?? PL_SHAPE.ring;
    return `<span class="pl-step s-${st.shape === '!' ? 'bang' : esc(st.shape)}" title="${esc(`${st.id}${st.now ? ` (now ${st.now})` : ''}: ${st.word}`)}">${plShape(cls, g, st.word)} ${esc(st.label)}</span>`;
  };
  const chains = (p.chains || []).map(c => `<div class="pl-chain">${c.steps.map(step).join('<span class="pl-sep mute">›</span>')}
    <div class="small pl-meta">${c.broken ? `${plShape('needs', '!', 'broken')} <b>${esc(c.broken)}</b>` : c.finished ? esc(`finished ${plAt(c.finish.at, now) ?? ''}`) : `finish ${esc(c.finish.at ? `~${plAt(c.finish.at, now)}${c.finish.note ? ` ${c.finish.note}` : ''}` : c.finish.word)}`}${c.rm ? ` · ${chip('idle', c.rm.id)} ${esc(c.rm.title)}` : ''}</div></div>`).join('');
  const landCls = w => (/^blocked/.test(w) ? 'bad' : w === 'merging now' ? 'running' : w === 'ready to merge' ? 'ok' : 'idle');
  const land = (p.landing || []).map((l, i) => `<div class="pl-row"><span class="mono pl-pos">${i + 1}.</span><span class="pl-what"><b>${esc(l.label)}</b> <span class="id">${esc(l.id)}</span>${l.what ? ` <span class="small mute">${esc(l.what)}</span>` : ''}</span>${chip(landCls(l.word), l.word)}</div>`).join('');
  return `${head}${plSection('pl-up', 'Up next', 'every queued run, in the order it will start', up || plEmpty('Nothing is waiting to start.'))}
    ${plSection('pl-chains', 'Chains', 'runs that wait for other runs', chains || plEmpty('No queued run waits for another run.'))}
    ${plSection('pl-land', 'Landing next', 'heading to main, in merge order', backlogLine(p.backlog) + (land || plEmpty(`Nothing is heading to main.${p.landing_error ? ` (${p.landing_error})` : ''}`)))}<p class="small mute pl-method">${esc(p.method ?? '')}</p>`;
}
/** the usage forecast (/api/plan forecast), shown on the Usage page; '' when the project has none */
export function forecastCard(f, now = Date.now()) {
  if (!f) return '';
  const fc = f.api ? `<div class="pl-fc" id="pl-fc-api"><p><b>${esc(f.line)}</b><br><span class="small mute">API billing: no weekly limit to run out of.</span></p></div>`
    : !fin(f.weekly) ? `${plEmpty('Usage not measured yet.')}` : `<div class="pl-fc"><div class="kv">
    <span class="small mute">rate now</span><span>${meter(f.rate, Math.max(f.cap ?? 0, f.rate ?? 0) || 1, f.cap, f.over ? 'hot' : '')} <span class="small">${pct(f.rate, 2)}/h of the ${pct(f.cap, 1)}/h cap</span></span>
    <span class="small mute">this week</span><span>${meter(f.weekly, 100, f.stop, fin(f.stop) && f.weekly >= f.stop ? 'hot' : '')} <span class="small">~${pct(f.weekly)}${fin(f.stop) ? ` of the ${pct(f.stop, 0)} stop` : ''}</span></span>
    <span class="small mute">reset</span><span class="small">${f.reset ? esc(plAt(f.reset, now)) : '-'}</span></div>
    <p><b>${esc(f.lineAt ? `${f.linePre}${plAt(f.lineAt, now)}${f.linePost}` : f.line)}</b>${f.costLine ? `<br><span class="small">${esc(f.costLine)}</span>` : ''}</p></div>`;
  return plSection('pl-fc', 'Forecast', 'usage', fc);
}
export function plan(d, ctx) {
  const parts = d.parts || [];
  return `<div class="plan"><p class="small mute pl-zone">times in ${esc(viewerZone())}</p>${parts.map(p => planPart(p, ctx)).join('') || '<p class="mute">No project.</p>'}</div>`;
}
