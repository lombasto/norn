// The Lanes page's handlers (moved verbatim from index.html, stage NAV): data-act -> fn(el, c); index.html dispatches every click on a
// [data-act] through one registry (pages/*-acts.mjs `acts`), c = { S, render, post, $, go, act, err, tabUrl, lanesRepaint, openFeed, feedGo, map }.
import { laneKey } from './lanes.mjs';
const P = f => (b, c) => f(b.dataset, b.dataset.project, c, b);
export const acts = {
  'map-more': P((d, p, { S, render }) => { const l = d.lane; if (S.mapMore.has(l)) S.mapMore.delete(l); else S.mapMore.add(l); render(); }),
  'lane-feed': P((d, p, { feedGo }) => { feedGo(d.project || p, d.run); }),   // a Lanes row's Feed: the run URL (?tab=runs&run=), so Back returns to Lanes
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
  // the Lanes page's Branches / Worktrees sub-views: filters repaint in place; a row action answers with its Undo (S.brUndo, the
  // Archive bar's pattern); Scan now starts the detached refresh the tick would start
  'br-state': P((d, p, { S, lanesRepaint }) => { const s = S.br.states, all = S.last?.states || []; if (!s.size) for (const k of all) s.add(k); if (s.has(d.state)) s.delete(d.state); else s.add(d.state); if (s.size === all.length) s.clear(); lanesRepaint(); }),
  'br-where': P((d, p, { S, lanesRepaint }) => { S.br.where = d.where; lanesRepaint(); }),
  'br-scan': P((d, p, { S, post, act, err }) => { act(async () => { await post('/api/branches/refresh', { project: p }); S.brUndo = null; err(''); }); }),
  'br-delete': P((d, p, c) => brAct('delete', d, p, c)), 'br-rmwt': P((d, p, c) => brAct('rmwt', d, p, c)), 'br-adopt': P((d, p, c) => brAct('adopt', d, p, c)),
  'br-undo': P((d, p, { S, post, act }) => { const u = S.brUndo; S.brUndo = null; if (u) act(() => (u.verb === 'adopt' ? post('/api/lane/archive', { project: u.project, lane: u.undo.lane, override: 'Undo of Adopt into a lane: the branch stays as it was' }) : post('/api/branches/act', { project: u.project, act: 'undo', undo: u.undo }))); }),
};
/** a Branches row action (delete / rmwt / adopt): `norn branches <verb>` through the server, then its Undo bar */
function brAct(verb, d, p, { S, post, act }) {
  const what = verb === 'rmwt' ? d.path : d.branch;
  act(async () => { const r = await post('/api/branches/act', { project: p, act: verb, ...(verb === 'rmwt' ? { path: d.path } : { branch: d.branch }) });
    S.brUndo = { project: p, verb, undo: r.undo, text: verb === 'delete' ? `Deleted ${what}.` : verb === 'rmwt' ? `Removed the worktree ${what}.` : `Adopted ${what} into lane ${r.lane}.` }; });
}
/** the Norn Map's node click: a run opens its feed, a question its Inbox row, anything else is selected */
export function pickMap(id, { S, render, $, openFeed, map }) {
  const NM = map(), n = (NM?.d.nodes || []).find(x => x.id === id); if (!n) return;
  if (n.feed) { openFeed(S.project, n.feed); NM.map.select(id, $('#feed').offsetWidth || 0); return; }
  if (n.type === 'question') { S.tab = 'inbox'; S.jump = 'q-' + id; history.replaceState(null, '', `?project=${encodeURIComponent(S.project)}&tab=inbox`); render(); return; }
  NM.map.select(id);
}
