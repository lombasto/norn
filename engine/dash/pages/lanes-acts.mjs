// The Lanes page's handlers (stage NAV moved them from index.html): data-act -> fn(el, c); index.html dispatches every click on a
// [data-act] through one registry (pages/*-acts.mjs `acts`), c = { S, render, post, $, go, act, tabUrl, lanesRepaint, openFeed, feedGo }.
import { laneKey } from './lanes.mjs';
const P = f => (b, c) => f(b.dataset, b.dataset.project, c, b);
// stage LANES: a row opens in place (S.laneOpen keeps it open through a stream repaint); the chevron and Esc close it
const setOpen = (b, on) => { const r = b.closest('.lrow'); b.setAttribute('aria-expanded', on); b.setAttribute('aria-label', `${on ? 'Close' : 'Open'} ${b.dataset.lane}`); r.querySelector('.lexp').hidden = !on; };
export const acts = {
  'lane-feed': P((d, p, { feedGo }) => { feedGo(d.project || p, d.run); }),   // a Lanes row's Feed: the run URL (?tab=runs&run=), so Back returns to Lanes
  'lane-open': P((d, p, { S }, b) => { const k = laneKey(p, d.lane), on = !S.laneOpen.has(k); if (on) S.laneOpen.add(k); else S.laneOpen.delete(k); setOpen(b, on); }),
  // RM-19 S1: Archive acts on the tap - the row leaves at once (S.archiving), then an Undo bar (S.laneUndo, the chat's Undo without a
  // confirm); a refusal (409: an unmerged deliverable) puts the row back with the reason kept in S.laneRefused, which a re-render keeps
  archive: P((d, p, { S, render, post, lanesRepaint }) => { const k = laneKey(p, d.lane); S.archiving.add(k); delete S.laneRefused[k]; S.laneUndo = null; lanesRepaint();
    post('/api/lane/archive', { project: p, lane: d.lane }).then(() => { S.archiving.delete(k); S.laneUndo = { project: p, lane: d.lane }; render(); },
      e => { S.archiving.delete(k); S.laneRefused[k] = e.message; lanesRepaint(); }); }),
  'lane-undo': P((d, p, { S, post, act }) => { S.laneUndo = null; act(() => post('/api/lane/archive', { project: p, lane: d.lane, unarchive: true })); }),
  'lane-type': P((d, p, { S, tabUrl, lanesRepaint }) => { S.laneType = S.laneType === d.type ? null : d.type; history.replaceState(null, '', tabUrl()); lanesRepaint(); }),
  'lane-show': P((d, p, { S, tabUrl, lanesRepaint }) => { if (S.laneShow.has(d.show)) S.laneShow.delete(d.show); else S.laneShow.add(d.show); history.replaceState(null, '', tabUrl()); lanesRepaint(); }),
};
/** Esc inside an open lane row closes it and gives the focus back to its chevron; true when it did */
export function laneEsc(e, { S }) {
  const r = e.target.closest?.('.lrow'), b = r?.querySelector('.lopen');
  if (!b || b.getAttribute('aria-expanded') !== 'true') return false;
  S.laneOpen.delete(laneKey(b.dataset.project, b.dataset.lane)); setOpen(b, false); b.focus(); return true;
}
