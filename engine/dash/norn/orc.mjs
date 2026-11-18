// META-TEND P6: SloppaChoppa, the ONE voice (owner DIR-49 = option A; DEC-264 = Clippy-like). The pure part (node tests drive it):
// the header badge (NEW warn-level findings since the Slop page was last opened), his line (a template, the number in plain words),
// the one best action, and the pop-up gate (Settings mode off / on / quiet, the daily cap, once per finding, never while the owner
// types, Mute, one appearance at a time). The browser part (createStage) plays the ORC-1 round-6 strips frame by frame at their real
// times; still frames when the mode is quiet or nothing may move (motion.mjs: QUIET, reduced motion, a hidden page).
export const STRIPS = {   // ORC-1 R8 (norn-art-orc out-r8/anim/timings.json): frames left to right, ms per frame
  appear: [80, 90, 90, 100, 110, 300], idle: [700, 180, 260, 180, 100, 380], speak: [120, 110, 150, 110, 100, 150], 'fidget-axe': [300, 140, 240, 170, 150, 350],
  'fidget-look': [300, 120, 600, 180, 120, 600, 300], chop: [180, 170, 240, 60, 110, 160, 180, 350], warn: [150, 130, 350, 180, 170, 300], exit: [220, 150, 100, 100, 100, 500],
};
export const POPUP_MODES = ['off', 'on', 'quiet'];
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
/** a count in plain words (0-20), digits past twenty */
export const inWords = n => (Number.isInteger(n) && n >= 0 && n <= 20 ? WORDS[n] : String(n));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const warns = s => s === 'high' || s === 'medium';
const TAB_WORD = { context: 'Context', tests: 'Tests', usage: 'Usage', runs: 'Runs', docs: 'Docs', slop: 'Slop' };

/** the badge: warn-level findings first seen after the Guard page was last opened (never opened: the ones new in the last day) */
export function badgeCount(rows = [], seenAt = 0) {
  return rows.filter(r => warns(r.severity) && (seenAt ? Date.parse(r.first_seen ?? '') > seenAt : r.new)).length;
}
/** the one best action: the first ranked row (the server ranks new first, then severity) -> { label, go, row } */
export function bestAction(rows = []) {
  const r = rows[0];
  return r ? { label: `Fix it in ${TAB_WORD[r.go?.tab] ?? 'its tab'}`, go: r.go, row: r } : { label: 'Open Slop', go: { tab: 'slop' }, row: null };
}
/** his line: a template with the number in plain words */
export function orcLine({ rows = [], fresh = 0, pending = false, total = rows.length } = {}) {   // total: the open count when rows holds only the top row (the Guard summary)
  if (!rows.length || !total) return pending ? 'Still looking: the instruction-file scan is running.' : 'Nothing open. The tree is tended.';
  const top = rows[0], n = fresh || total, what = fresh ? 'new finding' : 'open finding';
  return `${cap(inWords(n))} ${what}${n === 1 ? '' : 's'}. The worst: ${top.why}`;
}
/** the badge's accessible name */
export const badgeLabel = n => `SloppaChoppa: ${inWords(n)} new finding${n === 1 ? '' : 's'}`;   // UX review 4: the same word as his line and the Slop count

/**
 * may he pop up by himself? -> { ok, why, row }. mode = Settings popups (off | on | quiet), cap = the daily cap, log = { day, n, shown [ids] }
 * (this browser's), rows = the ranked Guard rows. Only a NEW finding at warn level or above, once per finding.
 */
export function mayAppear({ mode = 'off', cap: max = 3, log = {}, rows = [], typing = false, mutedUntil = 0, onStage = false, now = Date.now() } = {}) {
  if (mode === 'off') return { ok: false, why: 'pop-ups are off (Settings)' };
  if (mutedUntil > now) return { ok: false, why: 'muted' };
  if (onStage) return { ok: false, why: 'one appearance at a time' };
  if (typing) return { ok: false, why: 'the owner is typing' };
  const day = new Date(now).toISOString().slice(0, 10), n = log.day === day ? log.n || 0 : 0;
  if (n >= max) return { ok: false, why: `daily cap reached (${max})` };
  const row = rows.find(r => r.new && warns(r.severity) && !(log.shown || []).includes(r.id));
  return row ? { ok: true, why: 'a new finding', row } : { ok: false, why: 'nothing new' };
}
/** the log after one appearance */
export function logAppearance(log = {}, id, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return { day, n: (log.day === day ? log.n || 0 : 0) + 1, shown: [...new Set([...(log.shown || []), id])].slice(-200) };
}
/** still frames only? (the quiet mode, or motion not allowed) */
export const stillOnly = (mode, motion) => mode === 'quiet' || !motion;
/** where the stage sits: bottom-right, above the Send button / the phone's bottom bar when they are on screen (rects in CSS px) */
export function stageBottom({ innerHeight, avoid = [] }) {
  return Math.max(16, ...avoid.filter(r => r && r.height > 0 && r.top < innerHeight).map(r => innerHeight - r.top + 12));
}
/**
 * the rects to keep clear: each element's real box, skipped when it is not rendered (display:none -> 0 x 0). Not offsetParent: it is
 * null for a position:fixed element (CSSOM View), so the phone's fixed bottom nav would never be measured.
 */
export const avoidRects = els => els.filter(Boolean).map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);

/* ---------- browser: the stage ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/**
 * createStage({ url(name) -> the strip's URL, still() -> bool, onAct(go), avoid() -> [rects] }) -> { show({ line, action }), hide(), on() }
 * One stage element, made on show and removed after exit. Fidgets play now and then while he waits (only while on stage and moving).
 */
export function createStage({ url, still, onAct, avoid = () => [] }) {
  let el = null, timer = null, fid = null;
  const fig = () => el?.querySelector('.orc-fig');
  const frame = (name, i) => { const f = fig(); if (!f) return; f.style.backgroundImage = `url(${url(name)})`; f.style.backgroundSize = `${STRIPS[name].length * 100}% 100%`; f.style.backgroundPosition = `${STRIPS[name].length > 1 ? (100 * i) / (STRIPS[name].length - 1) : 0}% 0`; };
  const play = (name, loops = 1) => new Promise(done => {
    clearTimeout(timer);
    if (still()) { frame('idle', 0); done(); return; }
    const ms = STRIPS[name]; let i = 0, k = 0;
    const step = () => { frame(name, i); timer = setTimeout(() => { i++; if (i >= ms.length) { i = 0; k++; } if (k >= loops) { frame('idle', 0); done(); } else step(); }, ms[i]); };
    step();
  });
  const fidget = () => { clearTimeout(fid); if (!el || still()) return; fid = setTimeout(async () => { if (!el) return; await play(Math.random() < 0.5 ? 'fidget-axe' : 'fidget-look'); fidget(); }, 5000 + Math.random() * 4000); };
  const place = () => { if (el) el.style.bottom = stageBottom({ innerHeight: window.innerHeight, avoid: avoid() }) + 'px'; };
  async function leave(chop) {
    if (!el) return;
    clearTimeout(fid); el.classList.add('busy');
    if (chop) await play('chop');
    await play('exit');
    el?.remove(); el = null; window.removeEventListener('resize', place);
  }
  async function show({ line, action }) {
    if (el) return false;
    el = document.createElement('div');
    el.id = 'orc-stage'; el.className = 'orc-stage'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'SloppaChoppa');
    el.innerHTML = `<div class="orc-bubble"><p>${esc(line)}</p><div class="orc-acts"><button class="primary" data-orc="act">${esc(action.label)}</button><button class="ghost" data-orc="later">Not now</button></div></div><div class="orc-fig" aria-hidden="true"></div>`;
    document.body.append(el); place(); window.addEventListener('resize', place);
    el.querySelector('[data-orc=act]').onclick = async () => { await leave(true); onAct(action.go); };
    el.querySelector('[data-orc=later]').onclick = () => leave(false);
    await play('appear'); await play('speak', 2); fidget();
    return true;
  }
  return { show, hide: () => leave(false), on: () => !!el, place };
}
