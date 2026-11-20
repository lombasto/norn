// The live feed drawer (moved verbatim from index.html, stage NAV; stage RUNS replaces it with the run document at ?tab=runs&run=RUN-n).
// It builds its own markup (outside #main, so a stream re-render never wipes it). createFeed(c): c = { $, onClose } (onClose: the Map's
// selection goes with the drawer); returns { F, narrow, openFeed, closeFeed, markFeed }.
import { esc, renderFeedHead, renderFeedEvent, renderActivity } from '../ui.mjs';
import { activityInit, activityAdd, activityView, fmtDur } from '../activity.mjs';
import { hoChip } from '../widgets.mjs';
export const FEED_HTML = `<aside id="feed" class="drawer" hidden aria-label="Live feed">
  <div class="dh"><b class="small">Live feed</b><span class="small mute">times UTC · tool (duration)</span><span class="spacer"></span>
    <label class="small"><input type="checkbox" id="feed-follow" checked> follow</label><button class="ghost" id="feed-close" title="Close (Esc)">Close</button></div>
  <div id="feed-head"></div>
  <div id="feed-now" class="small"></div>
  <div id="feed-status" class="small mute"></div>
  <div id="feed-act" aria-label="What the worker is doing"></div>
  <div id="feed-raw-bar" class="small"><button class="ghost" id="feed-raw-tog" aria-expanded="true" aria-controls="feed-list">All events</button><span class="mute" id="feed-raw-n"></span></div>
  <div id="feed-list" class="flist mono" aria-live="polite"></div>
</aside>`;
export function createFeed({ $, onClose = () => {} }) {
  $('#main').insertAdjacentHTML('afterend', FEED_HTML);
// ---- live feed drawer: one EventSource per open drawer (the server keeps one tailer per run, at most 4 feeds) ----
// RM-36: F.act = the activity fold of every event of the run (a fresh drawer asks full=1: the whole run, not the last 256 KB),
// painted at most every 300 ms; the Now duration ticks each second; <details data-k> keep their open state across paints
const F = { es: null, run: null, project: null, tools: new Map(), act: null, actT: null, tick: null, keep: new Map(), n: 0, scroll: false };
const narrow = () => matchMedia('(max-width:700px)').matches;
function paintAct() {
  F.actT = null; if (!F.act || !F.run) return;
  const h = F.head || {}, box = $('#feed-act'), ended = !!F.ended || (h.state && h.state !== 'running');
  box.querySelectorAll('details[data-k]').forEach(d => F.keep.set(d.dataset.k, d.open));
  const v = activityView(F.act, { now: Date.now(), root: h.worktree ?? null, brief: h.brief_items, notesDone: h.notes_done, ended });
  box.innerHTML = renderActivity(v, { ended });
  box.querySelectorAll('details[data-k]').forEach(d => { if (F.keep.has(d.dataset.k)) d.open = F.keep.get(d.dataset.k); });
  $('#feed-raw-n').textContent = `${F.n} events`;
}
const actSoon = () => { if (!F.actT) F.actT = setTimeout(paintAct, 300); };
// the Now clock: one text node a second while the drawer is open - it reads nothing (no refetch; the feed itself is pushed)
function tickDur() { const d = $('#fa-dur'); if (d) d.textContent = fmtDur((Date.now() - Date.parse(d.dataset.since)) / 1000); F.tick = setTimeout(tickDur, 1000); }
function rawShow(on) { $('#feed-list').hidden = !on; $('#feed-raw-tog').setAttribute('aria-expanded', String(on)); $('#feed-raw-tog').textContent = on ? 'Hide all events' : 'All events'; }
$('#feed-raw-tog').onclick = () => rawShow($('#feed-list').hidden);
function markFeed() { document.querySelectorAll('[data-feed].sel').forEach(x => x.classList.remove('sel'));
  if (F.run) document.querySelectorAll(`[data-feed="${CSS.escape(F.run)}"]`).forEach(x => x.classList.add('sel')); }
function closeFeed() { if (F.es) F.es.close(); F.es = null; F.run = null; F.tools.clear(); F.act = null; clearTimeout(F.actT); F.actT = null; clearTimeout(F.tick); F.tick = null;
  $('#feed').hidden = true; markFeed(); onClose(); }
function addEv(e) {
  const list = $('#feed-list');
  if (F.act) { activityAdd(F.act, e); F.n++; actSoon(); }
  if (e.done) {
    const t = F.tools.get(e.id);
    if (t) { const s = (Date.parse(e.ts) - Date.parse(t.ts)) / 1000; t.el.querySelector('.dur').textContent = Number.isFinite(s) ? `(${s < 10 ? s.toFixed(1) : Math.round(s)} s)` : '';
      if (e.kind === 'error') { t.el.classList.replace('k-tool', 'k-error'); t.el.title = e.summary; } F.tools.delete(e.id); }
    else if (e.kind === 'error') list.insertAdjacentHTML('beforeend', renderFeedEvent(e));
  } else {
    list.insertAdjacentHTML('beforeend', renderFeedEvent(e));
    if (e.kind === 'tool' && e.id) F.tools.set(e.id, { ts: e.ts, el: list.lastElementChild });
  }
  while (list.childElementCount > 600) list.firstElementChild.remove();
  if (F.tools.size > 400) F.tools.delete(F.tools.keys().next().value);
  // a whole-run replay sends thousands of events at once: one scroll per 50 ms, not one layout per event
  if ($('#feed-follow').checked && !F.scroll) { F.scroll = true; setTimeout(() => { F.scroll = false; list.scrollTop = list.scrollHeight; }, 50); }
}
// the live hand-off state (head.handoff, lanes.mjs handoffOf): while the next session is on its way, or once the chain went on in
// another run, the "now" line is the hand-off, not this session's last words ("I stopped this run with a hand-off ..." read as stopped)
function feedHead(h) {
  F.head = h; $('#feed-head').innerHTML = renderFeedHead(h); actSoon();
  const ho = h.handoff, now = ho && (ho.phase === 'pending' || ho.run !== h.run) ? hoChip(ho, h.run) : '';
  if (now !== (F.hoNow || '')) { F.hoNow = now; if (now) $('#feed-now').innerHTML = `<b>now</b> ${now}`; }
}
// a run that ended in a hand-off: ask for its head again until the supervisor names the next run, then follow that run's feed
function feedEnded(project, run, tries = 0) {
  if (F.run !== run) return;
  const ho = F.head?.handoff;
  if (ho && ho.run !== run && ho.phase) { openFeed(project, ho.run); $('#feed-status').textContent = `followed the hand-off from ${run} to ${ho.run} · live`; return; }
  if (!ho || ho.phase !== 'pending' || tries >= 20) { $('#feed-status').textContent = 'run ended · feed closed'; return; }
  $('#feed-status').textContent = 'run ended in a hand-off · waiting for the next session ...';
  setTimeout(() => { if (F.run !== run) return;
    const es = new EventSource(`/api/feed?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}`);   // head only: its backlog is on screen
    es.addEventListener('head', m => { if (F.run === run) feedHead(JSON.parse(m.data)); });
    es.addEventListener('end', () => { es.close(); feedEnded(project, run, tries + 1); });
    es.onerror = () => { es.close(); feedEnded(project, run, tries + 1); }; }, 3000);
}
function openFeed(project, run) {
  closeFeed(); F.head = null; F.hoNow = ''; F.run = run; F.project = project; F.act = activityInit(); F.ended = false; F.n = 0; F.keep.clear(); markFeed();
  $('#feed').hidden = false; $('#feed-head').innerHTML = `<span class="id">${esc(run)}</span>`; $('#feed-list').innerHTML = ''; $('#feed-now').textContent = ''; $('#feed-act').innerHTML = '';
  $('#feed-status').textContent = 'connecting ...'; rawShow(!narrow()); F.tick = setTimeout(tickDur, 1000);   // a phone: the activity view is the first screen
  const es = F.es = new EventSource(`/api/feed?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&full=1`);
  es.onopen = () => { $('#feed-status').textContent = 'live · the server polls the run files every 2 s'; };
  es.addEventListener('head', m => feedHead(JSON.parse(m.data)));
  es.addEventListener('ev', m => addEv(JSON.parse(m.data)));
  es.addEventListener('end', () => { es.close(); F.ended = true; actSoon(); feedEnded(project, run); });
  es.onerror = () => { if (F.es !== es) return; $('#feed-status').textContent = es.readyState === EventSource.CLOSED ? 'feed refused or gone (at most 4 live feeds: close one)' : 'reconnecting ...'; };
}
$('#feed-close').onclick = closeFeed;
  return { F, narrow, openFeed, closeFeed, markFeed };
}
