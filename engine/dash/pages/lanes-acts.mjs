// The Lanes page's handlers (moved verbatim from index.html, stage NAV): data-act -> fn(el, c); index.html dispatches every click on a
// [data-act] through one registry (pages/*-acts.mjs `acts`), c = { S, render, post, $, go, act, tabUrl, lanesRepaint, openFeed, map }.
import { laneKey } from './lanes.mjs';
const P = f => (b, c) => f(b.dataset, b.dataset.project, c, b);
export const acts = {
  'map-more': P((d, p, { S, render }) => { const l = d.lane; if (S.mapMore.has(l)) S.mapMore.delete(l); else S.mapMore.add(l); render(); }),
  'lane-feed': P((d, p, { openFeed }) => { openFeed(d.project || p, d.run); }),   // a Lanes row's Feed: the same drawer a Runs row opens
  'map-zoom': P((d, p, { S, render }) => { S.mapZoom = Number(d.z); render(); }),
  'map-view': P((d, p, { S, render }) => { S.mapView = d.view; try { localStorage.setItem('meta-mapview', d.view); } catch { /* private mode */ } render(); }),
  'map-nz': P((d, p, { S, map }, b) => { S.nornZoom = Number(d.z); map()?.map.zoom(S.nornZoom); document.querySelectorAll('[data-act="map-nz"]').forEach(x => { const on = x === b; x.classList.toggle('strong', on); x.setAttribute('aria-pressed', on); }); }),
  // RM-19 S1: Archive acts on the tap - the row leaves at once (S.archiving), then an Undo bar (S.laneUndo, the chat's Undo without a
  // confirm); a refusal (409: an unmerged deliverable) puts the row back with the reason kept in S.laneRefused, which a re-render keeps
  archive: P((d, p, { S, render, post, lanesRepaint }) => { const k = laneKey(p, d.lane); S.archiving.add(k); delete S.laneRefused[k]; S.laneUndo = null; lanesRepaint();
    post('/api/lane/archive', { project: p, lane: d.lane }).then(() => { S.archiving.delete(k); S.laneUndo = { project: p, lane: d.lane }; render(); },
      e => { S.archiving.delete(k); S.laneRefused[k] = e.message; lanesRepaint(); }); }),
  'lane-undo': P((d, p, { S, post, act }) => { S.laneUndo = null; act(() => post('/api/lane/archive', { project: p, lane: d.lane, unarchive: true })); }),
  'lane-type': P((d, p, { S, tabUrl, lanesRepaint }) => { S.laneType = S.laneType === d.type ? null : d.type; history.replaceState(null, '', tabUrl()); lanesRepaint(); }),
  'lane-show': P((d, p, { S, tabUrl, lanesRepaint }) => { if (S.laneShow.has(d.show)) S.laneShow.delete(d.show); else S.laneShow.add(d.show); history.replaceState(null, '', tabUrl()); lanesRepaint(); }),
};
/** the Norn Map's node click: a run opens its feed, a question its Inbox row, anything else is selected */
export function pickMap(id, { S, render, $, openFeed, map }) {
  const NM = map(), n = (NM?.d.nodes || []).find(x => x.id === id); if (!n) return;
  if (n.feed) { openFeed(S.project, n.feed); NM.map.select(id, $('#feed').offsetWidth || 0); return; }
  if (n.type === 'question') { S.tab = 'inbox'; S.jump = 'q-' + id; history.replaceState(null, '', `?project=${encodeURIComponent(S.project)}&tab=inbox`); render(); return; }
  NM.map.select(id);
}
