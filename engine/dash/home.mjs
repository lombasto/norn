// META-CONTROLLER C2 (SPEC sec. 8 + 10, owner Q-25 = Look 3 "Thread home"): the Talk page (was Home) is the thread - your messages, the
// controller's, check-in events, runs, merges, needs-you cards and shots in ONE time-ordered list with filters; the side columns
// (now / held / usage / next check-in | waiting / ruled today / standing orders) on a desktop.
// Pure: the same module runs in the browser (/home.mjs) and in node --test. homeEvents assembles (the server feeds it the thread
// file, the run records, the ledger entries and the inbox rows); renderThread is the reusable component (Look 2's dock later
// mounts the same list); renderHome is the Look 3 page around it. C3: approval cards (Approve once / Deny -> POST /api/chat/approve)
// and done cards (Undo -> POST /api/chat/undo) come from the chat profile's outbox lines; a card without a verb keeps its button disabled.
import { dodChips, hoChip } from './widgets.mjs';   // META-DOD 1: a run's Ready / Done chips; the live hand-off chip
import { dwarfName, runWho } from './cells.mjs';   // DWARVES 3.3: who ran a run
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = v => typeof v === 'number' && Number.isFinite(v);
const hhmm = iso => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 16) : ''; };
const ago = (iso, now) => { const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return ''; const m = Math.max(0, (now - t) / 60000);
  return m < 60 ? `${Math.round(m)} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
const kTok = n => (fin(n) ? `${Math.round(n / 1000)}k` : '-');
const base = p => String(p).split('/').pop();

// [filter id, label]; a filter shows one category (everything = all). Categories: chat (you + controller), needs, checkin, run, merge
export const HOME_FILTERS = [['all', 'everything'], ['talk', 'you + controller'], ['needs', 'needs you'], ['checkin', 'check-ins'], ['run', 'runs'], ['merge', 'merges']];
const FILTER_CAT = { talk: 'chat', needs: 'needs', checkin: 'checkin', run: 'run', merge: 'merge' };

/** Absolute image paths named in a text (Windows drive or POSIX root; png / jpg / jpeg / webp / gif), forward slashes, in order, once. */
export function imagePaths(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/(?:^|[\s"'`(\[<=])((?:[A-Za-z]:[\\/]|\/)[^\s"'`<>|*?()\[\]]+?\.(?:png|jpe?g|webp|gif))(?=$|[\s"'`)\]>,.;:!])/gi)) {
    const p = m[1].replace(/\\/g, '/');
    if (!/^\/\//.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}
/** The dashboard URL of a file inside the allow-listed roots (server: GET /api/file). */
export const fileUrl = (project, p) => `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(p)}`;

const tool = n => String(n ?? 'tool').replace(/^mcp__norn__/, '');
const endOf = r => [...(r.history || [])].reverse().find(h => h.ev === 'end')?.data ?? r.end ?? null;
const startTs = r => (r.history || []).find(h => h.ev === 'start')?.ts ?? r.created;
const endTs = r => [...(r.history || [])].reverse().find(h => h.ev === 'end')?.ts ?? null;

// ---------- META-HOME-POLISH R1: a check-in event is ONE line from the records it wrote, never its ledger prose ----------
const FACT_KEYS = ['reviewed', 'ruled', 'dispatched', 'asked', 'landed'];
/**
 * The facts one check-in run left in the records fold: every history event stamped run = that check-in. items: the fold's items
 * (records + runs). -> { reviewed, ruled, dispatched, asked, landed } (ids, in record order, once). A check-in reviewing an earlier
 * check-in is bookkeeping, not counted.
 */
export function checkinFacts(run, items = []) {
  const f = Object.fromEntries(FACT_KEYS.map(k => [k, []])), evs = [];
  for (const it of items) for (const h of it.history || []) if (run && h.run === run) evs.push([h, it]);
  evs.sort((a, b) => (a[0].seq ?? 0) - (b[0].seq ?? 0) || String(a[0].ts).localeCompare(String(b[0].ts)));
  const add = (k, id) => { if (!f[k].includes(id)) f[k].push(id); };
  for (const [h, it] of evs) {
    if (it.kind === 'run') {
      if (it.data?.kind === 'checkin') continue;
      if (h.ev === 'review') add('reviewed', it.id);
      else if (h.ev === 'start' || h.ev === 'queue') add('dispatched', it.id);
      else if (h.ev === 'landed') add('landed', it.id);
    } else if (h.ev === 'create' && it.kind === 'decision') add('ruled', it.id);
    else if (h.ev === 'create' && it.kind === 'question') add('asked', it.id);
  }
  return f;
}
const ids3 = ids => ids.slice(0, 3).join(', ') + (ids.length > 3 ? ` +${ids.length - 3}` : '');
/** facts -> the one line ("reviewed RUN-31 · ruled DEC-9 · dispatched RUN-41"), "nothing to rule" when it wrote nothing; null without facts. */
export function checkinLine(f) {
  if (!f) return null;
  const parts = FACT_KEYS.filter(k => (f[k] || []).length).map(k => `${k} ${ids3(f[k])}`);
  return parts.length ? parts.join(' · ') : 'nothing to rule';
}
// the check-in run that wrote a ledger line: the latest one started by the line's minute (+1, the ledger is minute-precise) that
// had not ended a minute before it (one with no end counts for 30 min: a lost check-in claims no later line)
function checkinRunAt(ts, checkins) {
  const t = Date.parse(ts ?? ''); if (!Number.isFinite(t)) return null;
  let best = null;
  for (const c of checkins) if (c.start <= t + 60000 && (c.end === null ? c.start >= t - 30 * 60000 : c.end >= t - 60000) && (!best || c.start > best.start)) best = c;
  return best?.id ?? null;
}

/** The project the dashboard opens on: the URL's, else the viewer's last pick (still registered), else the first that needs you, else the first. */
export function pickProject(projects = [], { url = null, saved = null } = {}) {
  const has = n => projects.some(p => p.name === n);
  if (url && (url === 'all' || has(url))) return url;
  if (saved && has(saved)) return saved;
  return (projects.find(p => (p.needs ?? 0) > 0) ?? projects[0])?.name ?? null;
}
// pokes that only carry earlier ones along (a queued repeat, a catch-up after a hidden tab)
const CARRY = new Set(['again', 'visible']);
/** A re-render poked by chat lines alone (on Talk) repaints only the thread: no strip, no page. */
export const threadOnly = (why = [], tab) => tab === 'talk' && why.some(r => r === 'chat') && why.every(r => r === 'chat' || CARRY.has(r));

/**
 * One time-ordered thread. o: { thread (chat lines), runs (run items of the records fold), items (all items of the fold, for the
 * check-in facts; default runs), ledger (parseLedger entries), needs (inbox rows), count (the newest N, default 300) } ->
 * [{ key, ts, cat, kind, ... }]. Check-in runs are not items (their ledger line is, with the facts line of the run that wrote it);
 * helpers neither; a MERGE stage is a merge; only what needs you now (no answered-not-applied rows).
 */
// dwarf: run -> { id, name } | null (the server's crew.mjs dwarfOf: the display names live there)
export function homeEvents({ thread = [], runs = [], items = null, ledger = [], needs = [], count = 300, dwarf = () => null } = {}) {
  const out = [], cards = new Map(), dones = new Map(), dividers = new Map();
  const VERDICT = v => (v.verdict === 'approve' ? 'approved' : v.why === 'timeout' ? 'timeout' : 'denied');
  thread.forEach((l, i) => {
    const key = `c${i}`, last = out.at(-1);
    if (l.kind === 'approval') { const e = { key, ts: l.ts, cat: 'needs', kind: 'approval', id: l.id, title: l.title ?? '', text: l.text ?? '', command: l.command ?? null,
      timeout_min: l.timeout_min ?? null, expires: l.expires ?? null, state: 'pending', line: i }; cards.set(l.id, e); out.push(e); }
    else if (l.kind === 'verdict') { const e = cards.get(l.id); if (e) { e.state = VERDICT(l); e.cat = 'chat'; } }
    else if (l.kind === 'done') { const e = { key, ts: l.ts, cat: 'chat', kind: 'done', title: l.title ?? '', lines: l.lines || [], undo: l.undo ?? null, undone: false, line: i }; dones.set(i, e); out.push(e); }
    else if (l.kind === 'undone') { const e = dones.get(l.line); if (e) e.undone = true; }
    else if (l.kind === 'show') out.push({ key, ts: l.ts, cat: 'chat', kind: 'show', path: l.path ?? '', caption: l.caption ?? null, images: l.image ? [l.path] : [], excerpt: l.excerpt ?? null });
    else if (l.kind === 'owner') out.push({ key, ts: l.ts, cat: 'chat', kind: 'you', text: l.text ?? '' });
    else if (l.kind === 'norn') out.push({ key, ts: l.ts, cat: 'chat', kind: 'norn', text: l.text ?? '', cmd: l.cmd ?? null });   // META-CHAT-CONTROLS R1: Norn's answer to a command
    else if (l.kind === 'text') out.push({ key, ts: l.ts, cat: 'chat', kind: 'controller', text: l.text ?? '', images: imagePaths(l.text) });
    else if (l.kind === 'tool') { if (last?.kind === 'tools' && last.open) last.names.push(tool(l.name)); else out.push({ key, ts: l.ts, cat: 'chat', kind: 'tools', names: [tool(l.name)], open: true }); }
    else if (l.kind === 'handoff' && l.phase === 'done') { const c = l.carried || {}, e = { key, ts: l.ts, cat: 'chat', kind: 'handoff', n: l.n ?? null, threads: c.threads ?? 0, holds: c.holds ?? 0,
      cards: c.cards ?? 0, ctx_from: l.ctx ?? null, ctx_to: null, forced: !!l.forced, file: l.file ?? null }; dividers.set(l.seg + 1, e); out.push(e); }
    else if (l.kind === 'usage' && dividers.get(l.seg)?.ctx_to === null) dividers.get(l.seg).ctx_to = l.ctx ?? null;   // the new session's first context
    else if (l.kind === 'segment' && l.why !== 'handoff') out.push({ key, ts: l.ts, cat: 'chat', kind: 'segment', n: l.n ?? null, why: l.why ?? null });
    else if (l.kind === 'stop' && l.why !== 'handoff') out.push({ key, ts: l.ts, cat: 'chat', kind: 'stop', why: l.why ?? null, code: l.code ?? null });
    if (!['tool', 'result', 'usage', 'session', 'start', 'handoff', 'segment', 'stop'].includes(l.kind) && last?.open) delete last.open;   // a tool run ends at the next said thing
  });
  for (const e of out) delete e.open;
  for (const r of runs) {
    const d = r.data || {};
    if (d.kind === 'checkin' || d.role === 'helper') continue;
    const cat = String(d.stage ?? '').toUpperCase() === 'MERGE' ? 'merge' : 'run';
    const head = { run: r.id, lane: d.lane ?? null, stage: d.stage ?? null, dwarf: dwarf(r) };
    if (r.state !== 'queued') out.push({ key: `r${r.id}`, ts: startTs(r), cat, kind: 'run-start', ...head, executor: d.executor ?? null, model: d.model ?? null, effort: d.effort ?? null });
    const end = endOf(r), ets = endTs(r);
    if (end && ets) out.push({ key: `e${r.id}`, ts: ets, cat, kind: 'run-end', ...head, outcome: end.outcome ?? r.state, why: end.why ?? null, dod_ready: d.dod_ready ?? null, dod: end.dod ?? null,
      images: imagePaths(`${end.why ?? ''} ${end.summary ?? ''}`) });
  }
  const checkins = runs.filter(r => r.data?.kind === 'checkin').map(r => ({ id: r.id, start: Date.parse(startTs(r) ?? ''), end: endTs(r) ? Date.parse(endTs(r)) : null }))
    .filter(c => Number.isFinite(c.start)), all = items ?? runs;
  ledger.forEach((e, i) => { if (e.kind !== 'check-in' || !e.ts) return; const run = checkinRunAt(e.ts, checkins);
    out.push({ key: `l${i}`, ts: e.ts, cat: 'checkin', kind: 'checkin', ckrun: run, line: run ? checkinLine(checkinFacts(run, all)) : null, headline: e.headline, subs: e.subs || [], images: imagePaths(e.raw ?? e.headline) }); });
  for (const n of needs) {
    if (n.type === 'answered') continue;
    out.push({ ...n, key: `n${n.id}`, ts: n.created ?? null, cat: 'needs', kind: n.type });
  }
  const t = e => { const v = Date.parse(e.ts ?? ''); return Number.isFinite(v) ? v : 0; };
  return out.map((e, i) => [e, i]).sort((a, b) => t(a[0]) - t(b[0]) || a[1] - b[1]).map(x => x[0]).slice(-count);
}

// ---------- the thread component ----------
const shots = (imgs, project) => (imgs || []).length ? `<div class="shots">${imgs.map(p => { const u = fileUrl(project, p);
  return `<figure class="shot"><a href="${esc(u)}" target="_blank" rel="noopener" title="Open full size"><img src="${esc(u)}" alt="${esc(base(p))}" loading="lazy"></a><figcaption class="mono">${esc(base(p))}</figcaption></figure>`; }).join('')}</div>` : '';
const rid = id => `<a href="#" class="id" data-rid="${esc(id)}">${esc(id)}</a>`;
// ids in a text become record links (RUN-n, Q-n, DEC-n, DIR-n); `code` spans stay code. Input is escaped first.
const inline = t => esc(t).split(/(`[^`\n]+`)/).map(s => s.startsWith('`') && s.endsWith('`') && s.length > 2 ? `<code>${s.slice(1, -1)}</code>`
  : s.replace(/\b((?:RUN|Q|DEC|DIR)-\d+)\b/g, (m, id) => rid(id))).join('');
const tag = (cls, word) => `<span class="tag tag-${cls}">${esc(word)}</span>`;
const SHORT = m => String(m ?? '').replace(/^claude-/, '').replace(/-\d.*$/, '');
const OUT = { done: ['ok', 'DONE'], stopped: ['bad', 'STOPPED'], handoff: ['run', 'HANDOFF'], killed: ['bad', 'KILLED'], lost: ['bad', 'LOST'] };

const APPROVAL_SAID = { approved: 'approved once', denied: 'denied', timeout: 'no tap in time - denied' };
const UNDO_SAID = { revoke: 'revoke the directive', stop: 'withdraw the queued run', requeue: 'put the run back on its old conditions' };
function card(e, ctx) {
  const at = hhmm(e.ts);
  if (e.kind === 'you') return `<div class="who">you · ${at}</div><div class="bubble txt">${inline(e.text)}</div>`;
  if (e.kind === 'controller') return `<div class="who">controller · ${at}</div><div class="msg txt">${inline(e.text)}</div>${shots(e.images, ctx.project)}`;
  if (e.kind === 'norn') return `<div class="who">norn · ${at}</div><div class="msg txt pre">${inline(e.text)}</div>`;
  if (e.kind === 'tools') return e.names.map(n => `<code>${esc(n)}</code>`).join(' ');
  if (e.kind === 'segment') return `<span class="line">${e.n > 1 ? `new session · segment ${esc(e.n)}${e.why ? ` (${esc(e.why)})` : ''}` : 'the conversation starts'} · ${at}</span>`;
  if (e.kind === 'handoff') { const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const carried = [pl(e.threads, 'open thread', 'open threads'), ...(e.holds ? [pl(e.holds, 'hold', 'holds')] : []), ...(e.cards ? [`${pl(e.cards, 'card', 'cards')} waiting`] : [])].join(', ');
    return `<span class="line">new session${e.forced ? ` (forced at ${kTok(e.ctx_from)})` : ''} · carried over ${carried} · context ${kTok(e.ctx_from)} → ${fin(e.ctx_to) ? kTok(e.ctx_to) : '…'}${e.file ? ` · <a href="${esc(fileUrl(ctx.project, e.file))}" target="_blank" rel="noopener" title="the hand-off file">hand-off ${esc(e.n)}</a>` : ''} · ${at}</span>`; }
  if (e.kind === 'stop') return `<span class="line">chat ${e.why === 'idle' ? 'idle - stopped; the next message resumes it' : `stopped (${esc(e.why ?? '?')}${fin(e.code) ? ` ${e.code}` : ''})`} · ${at}</span>`;
  if (e.kind === 'checkin') return `<details class="ck"${ctx.open?.has?.(e.key) ? ' open' : ''}><summary class="line">check-in${e.ckrun ? ` ${rid(e.ckrun)}` : ''} · ${at} · ${e.line ? inline(e.line) : 'no run record'}</summary>`
    + `<div class="ck-full">${[inline(e.headline), ...(e.subs || []).map(s => `${s.label ? `<b>${esc(s.label)}</b> ` : ''}${inline(s.text)}`)].map(t => `<div class="txt">${t}</div>`).join('')}${shots(e.images, ctx.project)}</div></details>`;
  const who = `${e.stage === 'MERGE' || e.cat === 'merge' ? tag('merge', 'MERGE') : ''}${rid(e.run)}${dwarfName(e.dwarf)}${e.lane ? ` <b>${esc(e.lane)}</b>` : ''}${e.stage && e.stage !== 'MERGE' ? ` · ${esc(e.stage)}` : ''}`;
  if (e.kind === 'run-start') return `<div class="head">${tag('run', 'STARTED')}${who}<span class="spacer"></span><span class="mute small">${at}</span></div>
    <div class="txt small mute">${[e.executor, SHORT(e.model), e.effort].filter(Boolean).map(esc).join(' · ') || '-'}</div>`;
  if (e.kind === 'run-end') { const [c, w] = OUT[e.outcome] ?? ['idle', String(e.outcome ?? 'ended').toUpperCase()];
    return `<div class="head">${tag(c, w)}${who}<span class="spacer"></span><span class="mute small">${at}</span></div>${e.why ? `<div class="txt">${inline(e.why)}</div>` : ''}${e.dod_ready || e.dod ? `<div class="txt">${dodChips(e.dod_ready, e.dod, { evidence: true })}</div>` : ''}${shots(e.images, ctx.project)}`; }
  if (e.kind === 'question') { const rk = e.recommend?.key ?? e.recommend?.k ?? null;
    return `<div class="head">${tag('needs', 'NEEDS YOU')}${rid(e.id)} <b class="ttl">${esc(e.title)}</b><span class="spacer"></span><span class="mute small">${esc(e.lane ?? '')} · ${at}</span></div>
    ${e.body ? `<div class="txt">${inline(e.body)}</div>` : ''}<div class="acts">${(e.options || []).map(o => { const k = o.key ?? o.k, t = o.text ?? o.t ?? '';
      return `<button class="${k === rk ? 'primary rec' : ''}" data-act="answer" data-project="${esc(e.project ?? ctx.project)}" data-id="${esc(e.id)}" data-choice="${esc(k)}" data-text="${esc(`(${k}) ${t}`)}"><b>${esc(k)}</b> ${esc(t)}${k === rk ? ' <small>recommended</small>' : ''}</button>`; }).join('')}
      <button class="ghost" data-tab="inbox">answer in your words</button></div>`; }
  if (e.kind === 'approval') { const live = e.state === 'pending' && e.id, pj = esc(e.project ?? ctx.project);
    const acts = e.state && e.state !== 'pending' ? `<span class="tag tag-${e.state === 'approved' ? 'ok' : 'bad'}">${esc(APPROVAL_SAID[e.state] ?? e.state)}</span>`
      : live ? `<button class="approve" data-act="approve" data-id="${esc(e.id)}" data-verdict="approve" data-project="${pj}">Approve once</button><button class="deny" data-act="approve" data-id="${esc(e.id)}" data-verdict="deny" data-project="${pj}">Deny</button>`
      : '<button class="approve" disabled title="no approval id: nothing to decide">Approve once</button><button class="deny" disabled title="no approval id: nothing to decide">Deny</button>';
    return `<div class="head">${tag('ok', 'YOUR OK')}<b class="ttl">${esc(e.title)}</b>${e.id ? `<span class="spacer"></span><span class="mute small">${esc(e.id)} · ${at}</span>` : ''}</div><div class="txt">${inline(e.text)}${e.command ? ` <code>${esc(e.command)}</code>` : ''}</div>
    <div class="acts">${acts}${live && fin(e.timeout_min) ? `<span class="mute">waits ${e.timeout_min} min, then denies + pings you</span>` : ''}</div>`; }
  if (e.kind === 'done') { const undo = e.undone ? '<span class="mute">undone</span>'
      : e.undo && Number.isInteger(e.line) ? `<button data-act="undo" data-line="${e.line}" data-project="${esc(e.project ?? ctx.project)}" title="${esc(UNDO_SAID[e.undo.verb] ?? 'undo')}">Undo</button>`
      : '<button disabled title="this act has no undo verb">Undo</button>';
    return `<div class="head">${tag('ok', 'DONE')}<b class="ttl">${inline(e.title)}</b></div>${(e.lines || []).map(l => `<div class="txt">${inline(l)}</div>`).join('')}
    <div class="acts">${e.hold ? `<span class="hold">lane ${esc(e.hold)} held by this chat${e.until ? ` until ${hhmm(e.until)}` : ''}</span>` : ''}${undo}</div>`; }
  if (e.kind === 'show') return `<div class="who">shown · ${at}</div><div class="txt">${e.caption ? `${inline(e.caption)} ` : ''}<code>${esc(e.path)}</code></div>${shots(e.images, ctx.project)}${e.excerpt ? `<pre class="excerpt">${esc(e.excerpt)}</pre>` : ''}`;
  // the other needs-you rows of the inbox: a login to redo, a drafted setup, a parked lane, an unreviewed run
  const what = e.kind === 'unreviewed' ? `${rid(e.id)} <b>${esc(e.lane ?? 'run')}</b> ended ${esc(String(e.outcome ?? e.state).toUpperCase())}${e.why ? `: ${esc(e.why)}` : ''} - not reviewed yet`
    : e.kind === 'parked' ? `lane <b>${esc(e.lane)}</b> parked${e.q ? ` by ${rid(e.q)}` : e.why ? `: ${esc(e.why)}` : ''}`
    : e.kind === 'login' ? `${esc(e.title)}` : `${esc(e.title ?? e.id)}`;
  const go = e.kind === 'unreviewed' ? 'runs' : 'inbox';
  return `<div class="head">${tag('needs', 'NEEDS YOU')}<span class="txt">${what}</span><span class="spacer"></span><button class="ghost" data-tab="${go}">open</button></div>`;
}
const LINE = new Set(['segment', 'stop', 'checkin', 'handoff']), PLAIN = new Set(['you', 'controller', 'tools', 'show', 'norn']);
// META-CHAT-CONTROLS R1 (owner DIR-58): a filter with nothing in it says what it shows and why it is empty - never a blank screen
const TALK_EMPTY = p => `This is Norn's own controller chat${p ? ` for ${esc(p)}` : ''}: a conversation of its own, separate from any Claude Code session in VS Code or a terminal (those are not shown here). It has no messages yet - type below to start; / shows the commands.`;
const EMPTY = { needs: 'Nothing needs you right now.', checkin: 'No check-ins in the thread yet.', run: 'No runs in the thread yet.', merge: 'No merges in the thread yet.' };
/** The thread list: one <li> per item (data-cat for the filters; hidden when the filter is another category). ctx: { project, filter, open (Set of expanded check-in keys) } */
export function renderThread(events, ctx = {}) {
  const show = FILTER_CAT[ctx.filter] ?? null;
  if (!events.length && !show) return '<ol class="thread"><li class="thread-empty mute">Nothing in the thread yet: say something to the controller below. Check-ins, runs and questions appear here as they happen.</li></ol>';
  const empty = show && !events.some(e => e.cat === show) ? `<li class="thread-empty mute">${show === 'chat' ? TALK_EMPTY(ctx.project) : EMPTY[show]}</li>` : '';
  return `<ol class="thread">${empty}${events.map(e => `<li class="ev ev-${esc(e.kind)}${LINE.has(e.kind) ? ' ev-line' : PLAIN.has(e.kind) ? '' : ' ev-card'}" data-cat="${esc(e.cat)}"${show && e.cat !== show ? ' hidden' : ''} data-key="${esc(e.key)}">${card(e, ctx)}</li>`).join('')}</ol>`;
}

// ---------- the Look 3 page ----------
const HARNESS = { claude: 'Claude Code', codex: 'Codex', fake: 'fake' };
const sh = (h, body) => `<section class="hs"><h4>${esc(h)}</h4>${body}</section>`;
const NOW_GLYPH = { running: ['run', '▶'], queued: ['idle', '‖'], claimed: ['idle', '‖'] };
function left(s, ctx) {
  const now = (s.now || []).map(n => { const [c, g] = NOW_GLYPH[n.state] ?? ['idle', '○'];
    return `<div class="hrow"><span class="gl gl-${c}" aria-label="${esc(n.state)}">${g}</span>${rid(n.run)}${runWho(n.dwarf, n.kind_word)} <span class="ell">${esc(n.lane ?? '')}</span><span class="spacer"></span><span class="mute small">${n.state === 'running' ? `${fin(n.ran_min) ? `${Math.round(n.ran_min)} min` : ''}${fin(n.ctx) ? ` · ${kTok(n.ctx)}` : ''}` : esc(n.state)}</span></div>${n.handoff ? `<div class="hrow ho-row">${hoChip(n.handoff, n.run)}</div>` : ''}`; }).join('')
    || '<div class="mute small">no run is running or queued</div>';
  const u = s.usage || {}, pct = fin(u.used) ? u.used : null;
  const usage = `<div class="hbar"><i style="width:${pct === null ? 0 : Math.min(100, pct)}%"></i>${fin(u.stop) ? `<b style="left:${Math.min(100, u.stop)}%"></b>` : ''}</div>
    <div class="small mute">${pct === null ? 'usage not estimated' : `${Math.round(pct)} % of the weekly guard${fin(u.stop) ? ` (stops at ${u.stop} %)` : ''}`}</div>`;
  const next = s.checkins_paused ? 'check-ins are paused' : `on the next event, or every ${fin(s.interval_min) ? s.interval_min : '?'} min`;
  // META-LIMIT-GATE: an executor family out of quota (norn run refuses it, the fill holds it until the reset)
  const quota = (s.limits || []).length ? sh('Out of quota', s.limits.map(l => `<div class="small">${esc(l)}</div>`).join('')) : '';
  return `<aside class="home-l">${sh('Now', now)}${sh('Held by this chat', '<div class="mute small">no lane held</div>')}${sh('Usage this week', usage)}${quota}${sh('Next check-in', `<div class="small">${esc(next)}</div>`)}</aside>`;
}
function right(s, ctx) {
  const row = (id, text, note) => `<div class="hrow">${rid(id)} <span class="ell">${esc(text)}</span><span class="spacer"></span><span class="mute small">${esc(note ?? '')}</span></div>`;
  const wait = (s.waiting || []).map(w => row(w.id, w.title ?? w.lane ?? w.type, ago(w.created, ctx.now))).join('') || '<div class="mute small">nothing waits for you</div>';
  const ruled = (s.ruled || []).map(r => row(r.id, r.text, hhmm(r.created))).join('') || '<div class="mute small">no ruling today</div>';
  const orders = (s.orders || []).map(o => row(o.id, o.text, o.created ? String(o.created).slice(5, 10) : '')).join('') || '<div class="mute small">no standing order</div>';
  return `<aside class="home-r">${sh('Waiting for you', wait)}${sh('Ruled for you today', ruled)}${sh('Your standing orders', orders)}</aside>`;
}
// META-CHAT-CONTROLS R1 (owner DIR-58: "is that necessary"): the raw-shell row (Settings chat_raw_shell, policy.mjs) in plain words -
// what the chat can and cannot do and why; the default (off) stays
const SHELL_WHY = 'Why: a paired phone reaches this chat too, so a typed message never becomes a command on this PC without you.';
export function shellLine(v) {
  if (v === 'on') return { short: 'shell + file edits ON, no tap', long: `This chat can run shell commands and edit files with no tap, besides Norn's own tools. ${SHELL_WHY.replace(' without you', '')} Settings › Chat raw shell sets it (off / ask / on).` };
  if (v === 'ask') return { short: 'shell / file edits: your tap each time', long: `This chat acts through Norn's own tools (records, runs, lanes, approval cards) and reads files; it runs a shell command or edits a file only after you approve each one on a card. ${SHELL_WHY} Settings › Chat raw shell sets it (off / ask / on).` };
  return { short: 'Norn tools only · no shell, no file edits', long: `This chat acts through Norn's own tools (records, runs, lanes, approval cards) and reads files; it cannot run shell commands or edit files. ${SHELL_WHY} Settings › Chat raw shell sets it (off / ask / on).` };
}
/** R1: the "/" menu under the chat box for what is typed so far ("/" + letters, no space): Norn's commands first, then the session's own. */
export function slashMenu(text, st = {}) {
  const m = String(text ?? '').match(/^\/([\w:.-]*)$/);
  if (!m) return '';
  const q = m[1].toLowerCase(), mine = st.norn_commands || {};
  const item = (n, w) => `<li><button type="button" data-act="slash" data-slash="/${esc(n)}"><b>/${esc(n)}</b>${w ? ` <span class="mute">${esc(w)}</span>` : ''}</button></li>`;
  const a = Object.entries(mine).filter(([k]) => k.startsWith(q)).map(([k, w]) => item(k, w));
  const own = (st.commands || []).filter(c => !mine[c] && c.toLowerCase().includes(q)), b = own.slice(0, 40).map(c => item(c, 'this session · passed to the CLI'));
  const more = own.length > 40 ? [`<li class="mute small">+${own.length - 40} more - type to narrow</li>`] : [];
  const tail = st.commands ? [] : ['<li class="mute small">This session\'s own commands are listed once the chat has started.</li>'];
  const none = !a.length && !b.length && st.commands ? [`<li class="mute small">no command matches /${esc(q)} - it would not be sent</li>`] : [];
  return `<ul class="slash" role="listbox" aria-label="Commands">${[...a, ...b, ...more, ...none, ...tail].join('')}</ul>`;
}
/** The chat's state line in the thread header: while a turn runs, what it is doing (its last tool), for how long, and the messages
 * waiting in Norn; the page ticks the clock each second (the thread-only repaint refreshes the rest). */
export function chatState(st = {}, now = Date.now()) {
  const q = st.queued ? ` · ${st.queued} message${st.queued === 1 ? '' : 's'} waiting` : '';
  if (st.handing_off) return `handing off ...${q}`;
  if (st.rolling === 'settings' && !st.since) return `restarting with the new settings ...${q}`;
  if (!st.busy) return st.running ? 'session open' : 'idle';
  const s = Number.isFinite(st.since) ? Math.max(0, Math.floor((now - st.since) / 1000)) : null;
  return `${st.doing ?? 'thinking'}${s === null ? ' ...' : ` · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}${q}`;
}
/** the state line's class: the pulsing dot while the chat works */
export const chatStateClass = (st = {}) => (st.busy || st.handing_off ? 'small chat-live' : 'mute small');
/** The Talk page body. d: GET /api/home; ctx: { project, homeFilter, now } */
export function renderHome(d, ctx = {}) {
  const st = d.status || {}, filter = ctx.homeFilter ?? 'all', needs = d.needs_you, approvals = d.approvals;   // UX review 4: the Inbox's count; approvals by name beside it
  const harness = `${HARNESS[st.executor] ?? esc(st.executor ?? 'claude')}${st.model ? ` · ${esc(SHORT(st.model))}` : ''}${st.effort ? `<span class="heff"> · ${esc(st.effort)}</span>` : ''}`;
  const lim = fin(st.handoff_k) ? st.handoff_k * 1000 : null;
  const amber = fin(st.ctx) && fin(st.no_new_step_k) && st.ctx >= st.no_new_step_k * 1000;
  const ctxBar = fin(st.ctx) ? `<span class="hctx${amber ? ' amber' : ''}" title="context of this session vs the hand-off point${amber ? ' - past the no-new-step mark: a hand-off comes soon' : ''}"><span class="hbar"><i style="width:${lim ? Math.min(100, st.ctx / lim * 100) : 0}%"></i></span>${kTok(st.ctx)}${lim ? `<span class="hlim"> / ${kTok(lim)}</span>` : ''}</span>` : '';
  const state = chatState(st);
  const sl = shellLine(st.raw_shell);
  // R1: the picker - the chip opens model + effort (from the next turn; a pick is this chat's, "make default" writes the Settings rows)
  const ch = st.choices, pk = st.pick, df = st.defaults || {};
  const opt = (list, cur, fmt) => list.map(v => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(fmt(v))}</option>`).join('');
  const inUse = pk ? `picked for this chat · Settings default: ${esc(SHORT(df.model))} · ${esc(df.effort ?? '')}` : 'the Settings default';
  const picker = `<details class="hpick"${ctx.pickOpen ? ' open' : ''}><summary class="hchip" title="model and effort of this chat - tap to change"><i></i>${harness}</summary><div class="hpop">
    <div class="small"><b>In use:</b> ${esc(SHORT(st.model))} · ${esc(st.effort ?? '')} <span class="mute">(${inUse})</span></div>
    ${ch ? `<div class="hpick-row"><label class="small">model <select id="pick-model">${opt(ch.models || [], st.model, SHORT)}</select></label><label class="small">effort <select id="pick-effort">${opt(ch.efforts || [], st.effort, x => x)}</select></label></div>
    <div class="acts"><button type="button" class="primary" data-act="chat-pick">Use from the next turn</button><button type="button" data-act="chat-default"${pk ? '' : ' disabled title="this is the Settings default already"'}>Make this the default</button></div>`
    : '<div class="small mute">no chat harness is set up: see Settings › Chat harness</div>'}
    <div class="small mute">The conversation goes on under the new model. In the box: /model, /effort - and / for every command.</div>
    <div class="small hshell">${esc(sl.long)} <button type="button" class="ghost" data-act="open-setting" data-setting="chat_raw_shell">open that setting</button></div></div></details>`;
  // C5 cost line: tokens are counted (per turn), the weekly % is an estimate (~); API-equivalent $ only in the hover (not money on a plan)
  const c = st.cost, costLine = c ? `<div class="hcost small mute"${fin(c.usd) && c.turns ? ` title="~${c.usd.toFixed(2)} API-equivalent (the CLI's figure; on a subscription it is plan share, not money)"` : ''}>${c.turns
    ? `chat today ${c.tokens >= 1e6 ? (c.tokens / 1e6).toFixed(2) + 'M' : (c.tokens / 1000).toFixed(1) + 'k'} tokens${fin(c.weekly_pct) ? ` · ~${c.weekly_pct.toFixed(2)} % of the week` : ''} · ${c.turns} turn${c.turns === 1 ? '' : 's'}` : 'chat today: no turns'}</div>` : '';
  const filters = HOME_FILTERS.map(([k, l]) => `<button class="hf" data-act="home-filter" data-filter="${k}" aria-pressed="${k === filter}">${esc(l)}${k === 'needs' ? ` <b id="home-needs">${needs}</b>${approvals ? ` <span class="small">+ ${approvals} to approve</span>` : ''}` : ''}</button>`).join('');
  return `<div class="home">${left(d.side || {}, ctx)}<section class="home-c">
    <div class="htop"><div class="hhead"><span class="hn">Norn</span>${picker}${ctxBar}<button type="button" class="hnote" data-act="open-setting" data-setting="chat_raw_shell" title="${esc(sl.long)}">${esc(sl.short)}</button><span class="spacer"></span><span class="${chatStateClass(st)}" id="chat-state" role="status" aria-live="polite">${esc(state)}</span></div>
    <div class="hfilters" role="toolbar" aria-label="Show">${filters}</div></div>
    <div class="hscroll" id="thread">${renderThread(d.events || [], { project: d.project ?? ctx.project, filter, open: ctx.homeOpen })}</div>
    <form class="composer" onsubmit="return false"><textarea id="chat-text" rows="1" maxlength="8000" placeholder="Message, or / for commands" aria-label="Message to the controller"></textarea><div id="slash-menu" class="slashmenu" hidden></div>
      <button type="button" class="ghost" disabled title="attachments come in a later stage">Attach</button><button type="button" class="primary send" data-act="chat-send">Send</button></form>
    ${costLine}<div class="hfoot small mute">An instruction becomes a DIRECTIVE in your words. Buttons write records directly - no model in between.</div>
  </section>${right(d.side || {}, ctx)}</div>`;
}
