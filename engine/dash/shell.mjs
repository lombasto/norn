// NORN-UI-NAV (SPEC 4.1 item 2): the dashboard shell - one flat bar of 5 (Controller, Lanes, Runs, Inbox, More) the same on desktop and
// phone, as link nav (`<nav>` + aria-current, not a tablist: the APG keeps tabs for panels on one page); the More sheet (the low-use
// pages under plain group headings, a popover on desktop and a bottom sheet on a phone); the status strip under the header (from
// GET /api/strip, which never builds the run tree); the router (a page id opens itself, anything else opens Lanes - the router's
// default rule, no alias table); and the keyed refetch contract: each page declares the state-stream keys it reads, so a pulse
// repaints the strip only and a record append refetches the open page only when the page reads that file. The header (UI redesign
// 2026-11-20): the worker pool (widgets.mjs poolLine), the check-ins group box (checkinStatus + Pause + Run tick now) and the cog
// (renderCog), which opens Settings over the page - Settings is on neither the bar nor the More sheet.
// LANES and RUNS build on: BAR / MORE ids, renderBar / renderMore / renderStatus markup ids (#tabs, #tab-<id>, #more-sheet,
// #status-strip), PAGE_KEYS (add or narrow a page's keys here), routeTab.
import { TABS } from './ui.mjs';
import { esc, fin, int, pct, fmtTime, worstState, scopeWords } from './cells.mjs';

// the bar's 4 pages, in order: [id, label, glyph]. Glyphs pass the blind-label test (a speech bubble, a list of rows, play, a tray,
// ⋯ for More; a cog for Settings in the header), always beside the word; drawn as SVG in currentColor so both looks and grounds colour them
const svg = d => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${d}</svg>`;
const G = {
  lanes: svg('<circle cx="2.5" cy="4" r="1.2" fill="currentColor"/><circle cx="2.5" cy="8" r="1.2" fill="currentColor"/><circle cx="2.5" cy="12" r="1.2" fill="currentColor"/><path d="M6 4h8M6 8h8M6 12h8" stroke="currentColor" stroke-width="1.6" fill="none"/>'),
  runs: svg('<path d="M4.5 2.5l9 5.5-9 5.5z" fill="currentColor"/>'),
  inbox: svg('<path d="M1.5 9.5h4l1 2h3l1-2h4v4h-13zM1.5 9.5l2-7h9l2 7" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/>'),
  controller: svg('<path d="M1.5 2.5h13v8.5h-7l-3.5 3v-3h-2.5z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/>'),
  settings: svg('<circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="8" r="4.3" stroke="currentColor" stroke-width="1.4" fill="none"/>'),
  more: svg('<circle cx="3" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/>'),
};
export const BAR = [['controller', 'Controller'], ['lanes', 'Lanes'], ['runs', 'Runs'], ['inbox', 'Inbox']];
// the More sheet: [group heading, page ids]
export const MORE = [['Health', ['spend', 'slop', 'tests', 'code', 'context']], ['History', ['records', 'ledger', 'docs']], ['Plan', ['roadmap']]];
/** the page the header's cog opens (over the page: index.html #setview) - the one page on neither the bar nor the More sheet */
export const COG = 'settings';
const HEALTH = MORE[0][1];
const LABEL = Object.fromEntries(TABS);

/** the page a ?tab= value opens: a page id itself (or the setup page), anything else Lanes */
export const routeTab = id => (id === 'adopt' || TABS.some(t => t[0] === id) ? id : 'lanes');

const href = (project, id) => esc(`?project=${encodeURIComponent(project ?? '')}&tab=${id}`);
const badge = n => (n ? `<span class="count" aria-label="${n} need you">${n}</span>` : '');
const dot = (st, words) => (st === 'warn' || st === 'bad' ? `<span class="dot tone-${st}" role="img" aria-label="${esc(words)}"></span>` : '');
/** the bar: 4 links + the More button. o: { project, needs, health: { spend|slop|tests|context: 'ok'|'warn'|'bad'|null } } */
export function renderBar(tab, o = {}) {
  const inMore = MORE.some(([, ids]) => ids.includes(tab)), sick = worstState(o.health);
  const links = BAR.map(([k, l]) => `<a href="${href(o.project, k)}" id="tab-${k}" data-tab="${k}"${k === tab ? ' aria-current="page"' : ''}>${G[k]}<span class="bl">${l}</span>${k === 'inbox' ? badge(o.needs) : ''}</a>`).join('');
  return `<nav class="pagebar" id="tabs" aria-label="Pages">${links}<button type="button" id="tab-more" data-act="more" aria-haspopup="dialog" aria-expanded="${!!o.open}" aria-controls="more-sheet"${inMore ? ' aria-current="page"' : ''}>${G.more}<span class="bl">More</span>${dot(sick, 'a Health page needs a look')}</button></nav>`;
}
/** the header's cog: a link to Settings (a plain click opens the overlay, index.html), current while Settings is open */
export const renderCog = (tab, o = {}) => `<a href="${href(o.project, COG)}" id="tab-${COG}" class="cog" data-tab="${COG}" title="Settings" aria-label="Settings"${tab === COG ? ' aria-current="page"' : ''}>${G.settings}</a>`;
/** the check-ins group box's status line (ov = the /api/strip answer): the status time (local), check-ins on / the pause mode, a
 *  tick running, the stream live; o: { live, remote (a remote viewer's name) } */
export const checkinStatus = (ov, o = {}) => `status ${esc(fmtTime(ov.now))} · ${ov.pause ? `<b>${esc(ov.pause.label)}</b>` : 'check-ins <b>on</b>'}${ov.checkin_locked ? ' · tick running' : ''} · ${o.live ? 'live' : 'reconnecting ...'}${o.remote ? ` · remote: ${esc(o.remote)}` : ''}`;
/** the More sheet (hidden until More opens it): every page not on the bar, under its group heading; the open page marked */
export function renderMore(tab, o = {}) {
  const h = o.health || {};
  const group = ([name, ids]) => `<section>${name ? `<h3>${esc(name)}</h3>` : ''}<ul>${ids.map(k => `<li><a href="${href(o.project, k)}" data-tab="${k}"${k === tab ? ' aria-current="page"' : ''}>${esc(LABEL[k])}${HEALTH.includes(k) ? dot(h[k], `${LABEL[k]} needs a look`) : ''}</a></li>`).join('')}</ul></section>`;
  return `<div id="more-sheet" class="sheet" role="dialog" aria-label="More pages"${o.open ? '' : ' hidden'}>${MORE.map(group).join('')}</div>`;
}

// ---- the status strip: the page project's n running · cap · reserve (its share of the Claude pool, never the machine caps' sum: the
// machine line is the header's poolLine) and the merge slot as reserved, usage vs the weekly guard and the hourly cap, the next check-in, the needs-you count, the slop meter. Each
// field shows "…" until /api/strip answers (index.html keeps the last answer while a newer one loads). Norn look: the three Norns -
// Urd what was (landed today, usage spent), Verdandi what is (running, parked), Skuld what shall be (needs you, queued, next check-in).
// OVERVIEW-TRUTH (4): the strip names its scope - the counts are the page's project(s), the usage is the account's (every project)
const WAIT = '<span class="mute">…</span>';
function fields(s, ctx) {
  if (!s) return { running: WAIT, usage: WAIT, checkin: WAIT, needs: WAIT };
  const r = s.running || {}, n = (r.claude?.n ?? 0) + (r.codex?.n ?? 0), mg = r.merge?.cap ? ` · merge <b>${int(r.merge.n)}</b> / ${int(r.merge.cap)}${r.merge.reserved ? ' reserved' : ''}` : '', sh = r.share, u = s.usage || {}, ck = s.checkin || {};
  const who = sh && ctx.project && ctx.project !== 'all' ? `${esc(ctx.project)}: ` : '', share = sh ? ` · cap ${fin(sh.ceiling) ? int(sh.ceiling) : 'any'} · reserve ${int(sh.reserve ?? 0)}` : '';
  const usage = u.billing?.type === 'api' ? esc(u.billing.label ?? 'API billing')
    : `usage <b>${pct(u.weeklyUsed)}</b> of ${pct(u.weeklyStopPct, 0)}${fin(u.rate) ? ` · ${u.rate.toFixed(2)} %/h of ${fin(u.cap) ? u.cap.toFixed(2) : '-'}` : ''}`;
  const checkin = s.pause?.checkins ? 'check-ins paused' : ck.next ? `next check-in <b>${esc(fmtTime(ck.next, ctx.now))}</b>` : fin(ck.every_min) ? `check-in every ${int(ck.every_min)} min` : 'next check-in -';
  // slop-meter S1: the meter from the last daily report (one project, SloppaChoppa on): score, band, the 7-day change (up = sloppier)
  const m = s.slop, turn = fin(m?.delta) && Math.round(m.delta) ? ` ${m.delta > 0 ? '↑' : '↓'}${int(Math.abs(Math.round(m.delta)))}` : '';
  return { running: `${who}<b>${int(n)} running</b>${share}${mg}`, usage, checkin, needs: `<b>${int(s.needs_you ?? 0)}</b> need you`,
    slop: m ? `slop <b>${int(Math.round(m.score))}</b> ${esc(m.band)}${turn}` : '' };
}
/** s: the /api/strip answer (null = not come yet); ctx: { look, project, now } */
export function renderStatus(s, ctx = {}) {
  const f = fields(s, { now: ctx.now ?? Date.now(), project: ctx.project }), st = s?.strip, slop = f.slop ? `<a href="${href(ctx.project, 'slop')}" data-tab="slop" id="strip-slop" title="the slop meter: 0-100, higher is sloppier; the arrow is the change in 7 days">${f.slop}</a>` : '', scope = ` title="counts for ${esc(scopeWords(ctx))}; usage: your Claude account (every project)"`, link = (id, html) => `<a href="${href(ctx.project, id)}" data-tab="${id}">${html}</a>`;
  if (ctx.look === 'norn') {
    const part = (tone, name, html) => `<span class="np tone-${tone}"><b>${name}</b><span>${html}</span></span>`;
    return `<div class="sstrip norns" id="status-strip" aria-label="Status"${scope}>${part('urd', 'Urd', `${st ? `${int(st.landed_today)} landed today · ` : ''}${f.usage}`)}`
      + `${part('verd', 'Verdandi', `${link('runs', f.running)}${st ? ` · ${int(st.parked)} parked` : ''}${slop ? ` · ${slop}` : ''}`)}`
      + `${part('skuld', 'Skuld', `${link('inbox', f.needs)}${st ? ` · ${int(st.queued)} queued` : ''} · ${f.checkin}`)}</div>`;
  }
  return `<div class="sstrip" id="status-strip" aria-label="Status"${scope}>${link('runs', f.running)}<span>${f.usage}</span><span>${f.checkin}</span>${link('inbox', f.needs)}${slop}</div>`;
}

// ---- keyed refetch (SPEC 4.1 item 2, concepts/AUDIT.md A-02): the state stream's events as keys - 'strip' (the status strip), a
// records file name (records, runs, deliverables ...), 'derived' (a watched non-record file or server cache), 'state' (the
// pause / quiet / tick flags), 'all' (a reset or a reconnect: anything may have changed). A page refetches only for its own keys.
export const PAGE_KEYS = {
  lanes: ['records', 'runs', 'deliverables', 'derived'], runs: ['runs', 'records', 'derived'], inbox: ['records', 'runs', 'deliverables', 'derived', 'state'],
  controller: ['records', 'runs', 'state'], spend: ['records', 'runs', 'derived'], slop: ['derived'], tests: ['runs', 'derived'], code: ['derived'], context: ['derived'],
  records: ['records'], ledger: ['derived'], docs: ['derived'], roadmap: ['records', 'runs', 'deliverables'],
  settings: ['derived', 'state'], adopt: ['records', 'derived'],
};
/** a stream event -> its keys */
export function keysOf(ev, data = {}) {
  if (ev === 'pulse') return ['strip'];
  if (ev === 'rec') return ['strip', String(data.file ?? '').replace(/\.jsonl$/, '')];
  if (ev === 'derived' || ev === 'state') return ['strip', ev];
  return ['all'];   // reset, hello (a reconnect may have missed events)
}
/** what a render with these reasons refetches on page tab. Reasons outside the keys (the scheduler's 'again' / 'visible', a chat
 *  line - the Controller's thread repaints itself) add nothing; an empty list is a direct render (both) */
export function refetchFor(tab, why = []) {
  if (!why.length || why.includes('all')) return { strip: true, page: true };
  const keys = new Set(why);
  return { strip: keys.has('strip'), page: (PAGE_KEYS[tab] || []).some(k => keys.has(k)) };
}
