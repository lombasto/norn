// META-UX-BUILD S2 (REPORT s.2, "the one pattern for a dense tab"): a summary row of at most 4 numbers, a row of 3-4 sub-views, and
// the chosen sub-view's own part (a capped list + its count), loaded on demand. The chosen sub-view lives in the URL (`&sub=`): a tap
// pushes it (Back returns), a reload or a shared link lands on it (index.html). The parts come from the tab's endpoint as
// `?part=<sub>&limit=<n>` through ui.mjs loadParts, the one part loader (slice 1's Instructions parts use it too).
// Every dense tab calls only this API. Pure, no I/O: the server and the browser both load it.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** the rows a part sends at first; "show more" adds this many again */
export const SUB_CAP = 40;
/** at most this many summary numbers and sub-views (the REPORT stop rule: never a fifth) */
export const SUB_MAX = 4;

/** a capped list + its full count */
export const capList = (list = [], limit = SUB_CAP) => ({ rows: list.slice(0, limit), n: list.length });

/** views [[id, label, count?]]: the chosen id when it is one of them, else the first */
export const pickSub = (views, id) => (views.some(([k]) => k === id) ? id : views[0][0]);

/** "showing N of M" + the button that asks the part for more (index.html: data-act="sub-more") */
export const subMore = (shown, n) => (n > shown ? `<p class="small mute subshown">showing ${esc(shown)} of ${esc(n)} · <button class="lnk" data-act="sub-more">show more</button></p>` : '');

/**
 * subviewPage(tab, { title, lead (HTML under the header), numbers: [{ n, label, cls? }] (<= 4), views: [[id, label, count?]] (3-4), active,
 * body (the part's HTML), loading (the part is not here yet) }) -> HTML: #<tab>-head (the page title line: the title + #<tab>-subs, the
 * view switch), the lead, #<tab>-sum, #<tab>-sub[data-sub] (the part). The switch is never a row under the nav (SPEC stage NAV item 4):
 * buttons with aria-pressed (A-10), not a tablist - each press is a URL step (&sub=), so Tab + Enter is the keyboard model.
 * body and lead are HTML the caller built (escaped there); the title, labels and numbers are escaped here.
 */
export function subviewPage(tab, { title = tab, lead = '', numbers = [], views, active, body = '', loading = false }) {
  if (numbers.length > SUB_MAX) throw new Error(`a dense tab shows at most 4 numbers (${tab}: ${numbers.length})`);
  if (views.length < 3 || views.length > SUB_MAX) throw new Error(`a dense tab has 3-4 sub-views (${tab}: ${views.length})`);
  const sum = numbers.length ? `<div class="subsum" id="${esc(tab)}-sum">${numbers.map(x => `<div class="subnum ${esc(x.cls ?? '')}"><b class="mono">${esc(x.n)}</b><span class="small mute">${esc(x.label)}</span></div>`).join('')}</div>` : '';
  const nav = `<div class="subnav" id="${esc(tab)}-subs" role="group" aria-label="${esc(title)} views">${views.map(([k, label, count]) => `<button type="button" id="${esc(tab)}-sub-${esc(k)}" data-act="sub" data-sub="${esc(k)}" aria-pressed="${k === active}" class="${k === active ? 'strong' : ''}">${esc(label)}${count === null || count === undefined ? '' : ` <span class="mute">${esc(count)}</span>`}</button>`).join('')}</div>`;
  const part = loading ? `<p class="small mute" id="${esc(tab)}-sub-loading"><span class="chip idle">loading</span> ${esc(views.find(([k]) => k === active)?.[1] ?? active)} ...</p>` : body;
  return `<div class="phead pagehead" id="${esc(tab)}-head"><h2 class="ptitle">${esc(title)}</h2>${nav}</div>${lead}${sum}<div class="subpart" id="${esc(tab)}-sub" data-sub="${esc(active)}">${part}</div>`;
}
