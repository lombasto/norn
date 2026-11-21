// The usage forecast card (/api/plan forecast = engine/lib/plan.mjs forecastOf), shown on Usage. The Plan page itself is gone (owner
// 2026-11-20): its Up next lives on Lanes (the Waiting lanes: priority control, estimate, start, hold-ups) and Runs (the queued rows).
import { esc, fin, pct, fmtTime } from '../cells.mjs';
import { meter } from '../widgets.mjs';

const plEmpty = t => `<p class="pl-empty mute">${esc(t)}</p>`;
/** the usage forecast (/api/plan forecast), shown on the Usage page; '' when the project has none */
export function forecastCard(f, now = Date.now()) {
  if (!f) return '';
  const fc = f.api ? `<div class="pl-fc" id="pl-fc-api"><p><b>${esc(f.line)}</b><br><span class="small mute">API billing: no weekly limit to run out of.</span></p></div>`
    : !fin(f.weekly) ? `${plEmpty('Usage not measured yet.')}` : `<div class="pl-fc"><div class="kv">
    <span class="small mute">rate now</span><span>${meter(f.rate, Math.max(f.cap ?? 0, f.rate ?? 0) || 1, f.cap, f.over ? 'hot' : '')} <span class="small">${pct(f.rate, 2)}/h of the ${pct(f.cap, 1)}/h cap</span></span>
    <span class="small mute">this week</span><span>${meter(f.weekly, 100, f.stop, fin(f.stop) && f.weekly >= f.stop ? 'hot' : '')} <span class="small">~${pct(f.weekly)}${fin(f.stop) ? ` of the ${pct(f.stop, 0)} stop` : ''}</span></span>
    <span class="small mute">reset</span><span class="small">${f.reset ? esc(fmtTime(f.reset, now)) : '-'}</span></div>
    <p><b>${esc(f.lineAt ? `${f.linePre}${fmtTime(f.lineAt, now)}${f.linePost}` : f.line)}</b>${f.costLine ? `<br><span class="small">${esc(f.costLine)}</span>` : ''}</p></div>`;
  return `<div class="tablecard pl-sec" id="pl-fc"><h3>Forecast <span class="mute small">usage</span></h3>${fc}</div>`;
}
