// The run document's live feed (stage RUNS: it replaces the feed drawer). The module owns one detached <section id="run-feed">: a
// paint of #main drops the document, and mountFeed() puts the same section back into the new document's #run-feed-slot, so the
// stream, the activity view and the event list outlive every re-render. createFeed(c): c = { onFollow(project, run) } (a live run
// that hands off: open the next run); returns { F, mountFeed, stopFeed }.
import { esc, renderFeedHead, renderFeedEvent, renderActivity } from '../cells.mjs';
import { activityInit, activityAdd, activityView, fmtDur } from '../activity.mjs';
import { hoChip } from '../widgets.mjs';
// the kind filters of the event list (in place of "All events"): each button shows its kinds; none pressed = the list folds away
export const FEED_KINDS = [['tools', 'tools', ['tool', 'error']], ['words', 'words', ['text', 'step']], ['commits', 'commits', ['marker']]];
const FEED_HTML = `<h3>Live feed<span class="spacer"></span>
    <label class="small"><input type="checkbox" id="feed-follow" checked> follow</label></h3>
  <div id="feed-head"></div>
  <div id="feed-now" class="small"></div>
  <div id="feed-status" class="small mute"></div>
  <div id="feed-act" aria-label="What the worker is doing"></div>
  <div id="feed-raw-bar" class="small" role="group" aria-label="Show events">${FEED_KINDS.map(([k, t]) => `<button class="hf" data-feed-kind="${k}" aria-pressed="true" aria-controls="feed-list">${t}</button>`).join('')}<span class="mute" id="feed-raw-n"></span></div>
  <div id="feed-list" class="flist mono" aria-live="polite"></div>`;
export function createFeed({ onFollow = () => {} } = {}) {
  const box = document.createElement('section'); box.className = 'rd-sec rd-feed'; box.id = 'run-feed'; box.innerHTML = FEED_HTML;
  const $ = s => box.querySelector(s);
// one EventSource for the shown run (the server keeps one tailer per run, at most 4 feeds). F.act = the activity fold of every event
// of the run (full=1: the whole run, not the last 256 KB), painted at most every 300 ms; the Now duration ticks each second while the
// feed is on screen; <details data-k> keep their open state across paints
const F = { es: null, run: null, project: null, tools: new Map(), act: null, actT: null, tick: null, keep: new Map(), n: 0, scroll: false };
const narrow = () => matchMedia('(max-width:700px)').matches;
function paintAct() {
  F.actT = null; if (!F.act || !F.run) return;
  const h = F.head || {}, act = $('#feed-act'), ended = !!F.ended || (h.state && h.state !== 'running');
  act.querySelectorAll('details[data-k]').forEach(d => F.keep.set(d.dataset.k, d.open));
  const v = activityView(F.act, { now: Date.now(), root: h.worktree ?? null, brief: h.brief_items, notesDone: h.notes_done, ended });
  act.innerHTML = renderActivity(v, { ended });
  act.querySelectorAll('details[data-k]').forEach(d => { if (F.keep.has(d.dataset.k)) d.open = F.keep.get(d.dataset.k); });
  $('#feed-raw-n').textContent = `${F.n} events`;
}
const actSoon = () => { if (!F.actT) F.actT = setTimeout(paintAct, 300); };
// the Now clock: one text node a second while the section is in the page - it reads nothing (the feed itself is pushed)
function tickDur() { const d = $('#fa-dur'); if (d && box.isConnected) d.textContent = fmtDur((Date.now() - Date.parse(d.dataset.since)) / 1000); F.tick = setTimeout(tickDur, 1000); }
// the kind filters: the list shows the pressed kinds (data-show on the list, CSS hides the rest); none pressed hides it
function kinds(on) {
  box.querySelectorAll('[data-feed-kind]').forEach(b => b.setAttribute('aria-pressed', String(on.includes(b.dataset.feedKind))));
  $('#feed-list').dataset.show = on.join(' '); $('#feed-list').hidden = !on.length;
}
box.addEventListener('click', e => { const b = e.target.closest('[data-feed-kind]'); if (!b) return;
  kinds([...box.querySelectorAll('[data-feed-kind]')].filter(x => (x === b) !== (x.getAttribute('aria-pressed') === 'true')).map(x => x.dataset.feedKind)); });
function stopFeed() { if (F.es) F.es.close(); F.es = null; F.run = null; F.project = null; F.tools.clear(); F.act = null; clearTimeout(F.actT); F.actT = null; clearTimeout(F.tick); F.tick = null; box.remove(); }
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
  if (F.live0 === undefined) F.live0 = h.state === 'running';
  F.head = h; $('#feed-head').innerHTML = renderFeedHead(h); actSoon();
  const ho = h.handoff, now = ho && (ho.phase === 'pending' || ho.run !== h.run) ? hoChip(ho, h.run) : '';
  if (now !== (F.hoNow || '')) { F.hoNow = now; if (now) $('#feed-now').innerHTML = `<b>now</b> ${now}`; }
}
// a run that ended in a hand-off while it was on screen: ask for its head again until the supervisor names the next run, then open
// that run (onFollow). A run opened after it ended stays put: the document offers Follow instead of moving under the owner
function feedEnded(project, run, tries = 0) {
  if (F.run !== run) return;
  const ho = F.head?.handoff;
  if (ho && ho.run !== run && ho.phase) { if (F.live0) { onFollow(project, ho.run); return; } $('#feed-status').innerHTML = `run ended · handed off to <span class="id">${esc(ho.run)}</span> <button data-act="run-open" data-run="${esc(ho.run)}">Follow ${esc(ho.run)}</button>`; return; }
  if (!ho || ho.phase !== 'pending' || tries >= 20) { $('#feed-status').textContent = 'run ended · feed closed'; return; }
  $('#feed-status').textContent = 'run ended in a hand-off · waiting for the next session ...';
  setTimeout(() => { if (F.run !== run) return;
    const es = new EventSource(`/api/feed?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}`);   // head only: its backlog is on screen
    es.addEventListener('head', m => { if (F.run === run) feedHead(JSON.parse(m.data)); });
    es.addEventListener('end', () => { es.close(); feedEnded(project, run, tries + 1); });
    es.onerror = () => { es.close(); feedEnded(project, run, tries + 1); }; }, 3000);
}
function openFeed(project, run) {
  stopFeed(); F.head = null; F.hoNow = ''; F.live0 = undefined; F.run = run; F.project = project; F.act = activityInit(); F.ended = false; F.n = 0; F.keep.clear();
  $('#feed-head').innerHTML = `<span class="id">${esc(run)}</span>`; $('#feed-list').innerHTML = ''; $('#feed-now').textContent = ''; $('#feed-act').innerHTML = '';
  $('#feed-status').textContent = 'connecting ...'; kinds(narrow() ? [] : FEED_KINDS.map(k => k[0])); F.tick = setTimeout(tickDur, 1000);   // a phone: the activity view first
  const es = F.es = new EventSource(`/api/feed?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}&full=1`);
  es.onopen = () => { $('#feed-status').textContent = 'live · the server polls the run files every 2 s'; };
  es.addEventListener('head', m => feedHead(JSON.parse(m.data)));
  es.addEventListener('ev', m => addEv(JSON.parse(m.data)));
  es.addEventListener('end', () => { es.close(); F.ended = true; actSoon(); feedEnded(project, run); });
  es.onerror = () => { if (F.es !== es) return; $('#feed-status').textContent = es.readyState === EventSource.CLOSED ? 'feed refused or gone (at most 4 live feeds)' : 'reconnecting ...'; };
}
/** after a paint: the document's slot takes the feed (a new run / project opens its stream); no slot = the feed stops */
function mountFeed() {
  const slot = document.getElementById('run-feed-slot');
  if (!slot) { if (F.run) stopFeed(); return; }
  const { run, project } = slot.dataset;
  if (F.run !== run || F.project !== project) openFeed(project, run);
  slot.replaceWith(box);
}
  return { F, mountFeed, stopFeed };
}
