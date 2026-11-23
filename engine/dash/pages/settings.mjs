// The Settings page (META-UX-R1): categories -> sub-categories from the schema (policy.mjs SECTIONS, served in /api/settings), left
// nav + search, one-line help per row, the modified-from-default marker + reset, the danger zone. Controls keep data-key = the key.
// UI redesign 2026-11-20: the header's cog opens it over the page (index.html #setview), and Look and Theme (this browser's, once
// header buttons) head it.
import { esc, chip, fmtTime, guardOn, guardChip, homeName } from '../cells.mjs';
import { capStrip } from '../widgets.mjs';

const showVal = v => Array.isArray(v) ? v.join(', ') || '(none)' : typeof v === 'boolean' ? (v ? 'on' : 'off') : v === '' ? '(default)' : v;
const ctlVal = v => Array.isArray(v) ? v.join(', ') : v ?? '';
/** Search text of one setting row (label, key, help, value, recommended) - the browser filters on the same string. */
export const searchText = s => [s.label, s.key, s.help, showVal(s.value), s.recommended].join(' ').toLowerCase();
/** All words of q in the text; the token @modified also requires the modified flag. Empty q matches everything. */
export function matchText(text, q, modified) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(w => w === '@modified' ? !!modified : text.includes(w));
}
function input(s) {
  const id = esc(s.key), dis = s.readonly || s.scope === 'file' ? ' disabled' : '', orig = esc(JSON.stringify(s.value ?? null));
  const attrs = `id="in-${id}" data-key="${id}" data-type="${esc(s.type)}" data-orig="${orig}"${dis}`;
  if (s.type === 'bool') return `<select ${attrs}><option value="true"${s.value ? ' selected' : ''}>on</option><option value="false"${s.value ? '' : ' selected'}>off</option></select>`;
  // an unset enum (no value, no blank option) shows "(unset)": the browser must not read the first option as a change
  const unset = s.type === 'enum' && (s.value === undefined || s.value === null) && !(s.options || []).includes('');
  if (s.type === 'enum') return `<select ${attrs}>${unset ? '<option value="" selected>(unset)</option>' : ''}${(s.options || []).map(o => `<option value="${esc(o)}"${o === s.value ? ' selected' : ''}>${esc(o || '(default)')}</option>`).join('')}</select>`;
  if (s.type === 'classes') return `<input type="text" ${attrs} value="${esc(ctlVal(s.value))}" placeholder="none" title="${esc((s.options || []).join(', '))}" class="wide">`;
  if (s.type === 'int' || s.type === 'num') return `<input type="number" ${attrs} value="${esc(s.value)}" placeholder="unset" min="${esc(s.min)}" max="${esc(s.max)}" step="${s.type === 'int' ? 1 : 0.01}" class="num">`;
  if (s.scope === 'file') return `<span class="small mono">${esc(s.value)}</span>`;
  return `<input type="text" ${attrs} value="${esc(ctlVal(s.value))}" placeholder="unset" class="text">`;
}
const modChip = s => s.modified ? ` <span class="mod" title="default ${esc(showVal(s.default))}">modified</span>` : '';
const resetBtn = s => s.default !== undefined && !s.readonly && s.scope !== 'file'
  ? `<button class="ghost reset" data-act="set-reset" data-for="${esc(s.key)}" data-default="${esc(JSON.stringify(s.default))}" title="Reset to the default ${esc(showVal(s.default))}"${s.modified ? '' : ' hidden'}>&#8634;</button>` : '';
const tip = s => esc(`${s.key} (${s.scope === 'machine' ? 'machine, all projects' : s.scope === 'project' ? 'project policy' : 'rules file'})\nRecommended: ${s.recommended}\nCost: ${s.cost}\nRead by: ${(s.readers || []).join('; ')}`);
const scopeTag = s => `<span class="tag" title="${esc(s.home ?? '')}">${s.scope === 'machine' ? 'machine' : s.scope === 'project' ? 'project' : 'rules file'}</span>`;
function row(s) {
  return `<div class="srow${s.modified ? ' modrow' : ''}" id="set-${esc(s.key)}"${s.basic ? ' data-basic="1"' : ''} data-search="${esc(searchText(s))}" data-mod="${s.modified ? 1 : 0}"><div class="sl"><label for="in-${esc(s.key)}" title="${tip(s)}"><b>${esc(s.label)}</b></label>${modChip(s)} ${scopeTag(s)}<span class="key">${esc(s.key)}</span><span class="help">${esc(s.help)}${s.recommended ? ` <span class="rec">Recommended: ${esc(s.recommended)}.</span>` : ''}</span></div><div class="sc">${input(s)}${resetBtn(s)}</div></div>`;
}
function inlineGroup(cat, sub, x, items, extra = '') {
  const short = s => String(s.label).replace(/^[^:]+:\s*/, ''), mod = items.some(s => s.modified);
  const cells = items.map(s => `<span class="mini" id="set-${esc(s.key)}" title="${tip(s)}"><span><label for="in-${esc(s.key)}">${esc(short(s))}</label>${modChip(s)}</span><span>${input(s)}${resetBtn(s)}</span></span>`).join('');
  return `<div class="srow inline${mod ? ' modrow' : ''}" id="grp-${esc([cat.id, sub.id, x.id].join('-'))}" data-search="${esc([x.label, ...items.map(searchText)].join(' ').toLowerCase())}" data-mod="${mod ? 1 : 0}"><div class="sl"><b>${esc(x.label)}</b>${extra} ${scopeTag(items[0])}<span class="help">${esc(items[0].help)}</span></div><div class="sc">${cells}</div></div>`;
}
function filesPane(d) {
  const tg = d.targets.map(t => `<div class="item">${t.exists ? chip('ok', `${t.markers.length} markers`) : chip('bad', 'missing')}<span class="mono small">${esc(t.file)}</span>${t.markers.length ? `<span class="small mute">${esc(t.markers.join(', '))}</span>` : ''}</div>`).join('');
  return `<div class="ssub" id="sub-files-sources"><h3>Source files <span class="help">every key keeps one home; the tag on each row says which file</span></h3>
    <div class="kv"><span class="tag">machine</span><span class="mono small" id="settings-machine">${esc(d.files.machine)} <span class="mute">(all projects)</span></span>
    <span class="tag">project</span><span class="mono small" id="settings-project">${esc(d.files.project)} <span class="mute">policy</span></span>
    <span class="tag">rules file</span><span class="small mute">read-only rows, edited by hand</span></div></div>
   <div class="ssub" id="sub-files-targets"><h3>Policy targets <span class="help">generated lines (&lt;!-- policy:key --&gt;) rewritten on Save</span></h3>${tg || '<span class="mute">none</span>'}</div>`;
}
// META-NOTIFY-SETUP R1: the Notifications row (machine.json notify; changed with norn setup --notify) + "send a test"
const PING_EVENTS = [['Questions to you', 'at once'], ['Work finished (merged / ready)', 'at once'], ['CI red on main, a killed or crashed run', 'at once, high']];
function notifyPane(d) {
  const n = d.notify || { backend: 'none' }, on = n.backend && n.backend !== 'none';
  const what = { ntfy: 'ntfy (phone app)', toast: 'desktop toast (Windows)', desktop: 'desktop notification', pushover: 'Pushover' }[n.backend] || 'off';
  const where = n.backend === 'ntfy' ? ` <span class="small mute">${esc(n.server)} · topic ${n.topic_set ? 'set (private)' : 'MISSING'}</span>` : '';
  const ev = PING_EVENTS.map(([e, w]) => `<li>${esc(e)} <span class="mute">- ${esc(w)}</span></li>`).join('')
    + `<li>FYI notes (rulings, other news) <span class="mute">- batched: one digest every ${esc(n.batch_h ?? 3)} h</span></li>`;
  return `<div class="ssub" id="sub-notify-ping"><h3>Phone / desktop ping <span class="help">machine.json notify, all projects - change it with norn setup --notify ntfy|toast|desktop|pushover|none</span></h3>
    <div class="srow" id="set-notify" data-basic="1" data-search="notifications notify ping phone desktop ntfy toast pushover ${esc(n.backend)}" data-mod="0"><div class="sl"><b>Notifications</b> <span class="tag">machine</span> ${on ? chip('ok', what) : chip('warn', 'off')}${where}
      <span class="help">${on ? 'Norn pings you when it needs you:' : 'Off: questions can sit unseen. Turn on with <span class="mono">norn setup --notify ntfy</span> (the free ntfy phone app) or <span class="mono">--notify toast</span> (this computer).'}</span>
      ${on ? `<ul class="small ping-events">${ev}</ul>` : ''}</div>
     <div class="sc">${on ? '<button class="ghost" data-act="notify-test">Send a test</button>' : ''}<span class="small mute" id="notify-test-out" role="status"></span></div></div></div>`;
}
// META-CONTROLLER C6 (SPEC sec. 5): reach Norn from your phone. r = /api/remote, or null when off. Off: how to start. On: the address,
// the paired devices (Revoke) and, on the desktop only, Pair a device (a single-use code).
function remotePane(r) {
  const head = '<h3>Reach Norn from your phone <span class="help">machine.json dash.remote, all projects - your own private network (Tailscale Serve); the dashboard stays on 127.0.0.1</span></h3>';
  const wrap = (body, sc = '') => `<div class="ssub" id="sub-notify-phone">${head}<div class="srow" id="set-remote" data-basic="1" data-search="remote phone tailscale pair device" data-mod="0"><div class="sl">${body}</div><div class="sc">${sc}</div></div></div>`;
  if (!r) return wrap(`<b>Phone access</b> <span class="tag">machine</span> ${chip('warn', 'off')}
    <span class="help">Off: this dashboard answers on this computer only. To reach it from your phone through Tailscale (free, about 10 minutes), run <span class="mono">norn remote setup</span>: it checks, prints each command and changes nothing until you add <span class="mono">--apply</span>. SETUP.md "Reach Norn from your phone" has the steps and the Cloudflare Access option.</span>`);
  const dev = d => `<li><b>${esc(d.name)}</b>${d.id === r.viewer ? ' <span class="tag">this device</span>' : ''} <span class="mute">${esc(d.login)} · paired ${esc(fmtTime(d.created))} · seen ${esc(fmtTime(d.last_seen))}</span>
    <button class="ghost" data-act="remote-revoke" data-id="${esc(d.id)}" data-name="${esc(d.name)}">Revoke</button></li>`;
  const pair = r.viewer ? '<span class="small mute">You are on a paired device: a new device is paired from the desktop.</span>'
    : '<button class="strong" data-act="remote-pair">Pair a device</button><div id="remote-code" class="remote-code" role="status"></div>';
  return wrap(`<b>Phone access</b> <span class="tag">machine</span> ${chip('ok', r.trust === 'tailscale' ? 'on · Tailscale Serve' : 'on · Cloudflare Access')}
    <span class="small mute"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a> · ${r.logins.length ? esc(r.logins.join(', ')) : 'any login of your private network'}</span>
    <span class="help">Open the address on a phone signed in to the same private network and pair it once with a code from here. Approvals and every other write from a phone count only on a paired device, and each is stamped with it.</span>
    <ul class="small devices">${r.devices.length ? r.devices.map(dev).join('') : '<li class="mute">No paired device yet.</li>'}</ul>`, pair);
}
// NORN-UI-SYNC: Settings > Sync's pane subs (policy.mjs SECTIONS sync, pane:true) from the server's sync block (server.mjs syncInfo).
// machine = the state + the ledger form (the topic is write-only: the page only knows on / off); setup = the guided cut --bare / join
// (Check = the dry run, Apply = pause, cut, publish + fetch, resume); duplicates = Find duplicates (dry) / Write the cards. The buttons
// post /api/sync/* (index.html); the answers land in the role=status <pre> below each.
const ago = s => (s == null ? 'never' : s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
// NORN-DASH-1123 item 6: the Computers block (a home's sync pane): one row per home - id, a name input (cells.mjs homeName: the strip's
// names), joined, last fetch / publish; this computer marked. Save posts /api/sync/name per changed name (acts below; SHELL wires them)
function computers(s, ctx) {
  const rows = [{ home: s.home, me: true, joined_at: s.joined_at }, ...(s.homes || []).filter(h => h.home !== s.home)];
  const when = h => (h.me ? `${s.head ? `published ${esc(String(s.head).slice(0, 8))}` : 'nothing published yet'} · ${s.fetched_at ? `fetched ${esc(fmtTime(s.fetched_at, ctx.now))}` : 'not fetched yet'}`
    : `last record ${esc(ago(h.lag_s))} ago`);
  const row = h => { const n = homeName(h.home), v = n === h.home ? '' : n;
    return `<div class="home-row" data-home-row="${esc(h.home)}"><b class="mono">${esc(h.home)}</b>${h.me ? ' <span class="tag">this computer</span>' : ''}
      <input type="text" data-home-name="${esc(h.home)}" data-orig="${esc(v)}" value="${esc(v)}" placeholder="no name: shows ${esc(h.home)}" maxlength="24" pattern="[A-Za-z0-9 _\-]{1,24}" autocomplete="off" spellcheck="false" aria-label="name of home ${esc(h.home)}">
      <span class="small mute">${h.joined_at ? `joined ${esc(fmtTime(h.joined_at, ctx.now))} · ` : ''}${when(h)}</span></div>`; };
  return `<div class="home-names" id="sync-homes"><b>Computers</b> <span class="help">the names travel with the ledger; the id stays the key (branch, records, run ids)</span>
    ${rows.map(row).join('')}<span><button class="ghost" data-act="home-names-save">Save names</button></span><pre class="small sync-out" id="sync-names-out" role="status">${esc(ctx.syncOut?.names ?? '')}</pre></div>`;
}
/** Save names: each changed name -> POST /api/sync/name { project, home, name } (the route is SHELL's: a 404 until then shows its error line) */
export const acts = {
  'home-names-save': async (b, { S, post, render }) => {
    const o = document.getElementById('sync-names-out'), ch = [...document.querySelectorAll('[data-home-name]')].filter(i => i.value.trim() !== i.dataset.orig);
    if (!ch.length) { o.textContent = 'No change.'; return; }
    o.textContent = 'Saving ...';
    try {
      for (const i of ch) await post('/api/sync/name', { project: S.project, home: i.dataset.homeName, name: i.value.trim() });
      o.textContent = S.syncOut.names = 'Saved; the other home sees it at its next fetch (doorbell: at once).'; render();
    } catch (e) { o.textContent = e.message; }
  },
};
function syncPane(x, d, ctx = {}) {
  const said = ctx.syncOut || {};
  const s = d.sync || {}, id = `sub-sync-${x.id}`, out = k => `<pre class="small sync-out" id="sync-${k}-out" role="status">${esc(said[k] ?? '')}</pre>`;
  const head = `<h3>${esc(x.label)}${x.help ? ` <span class="help">${esc(x.help)}</span>` : ''}</h3>`, wrap = (body, search) => `<div class="ssub" id="${id}">${head}<div class="srow" data-basic="1" data-search="${esc(search)}" data-mod="0">${body}</div></div>`;
  if (x.id === 'machine') {
    const st = s.home ? chip('ok', `home ${s.home}`) : chip('idle', 'solo');
    const pub = s.stopped ? chip('bad', `stopped: ${s.stopped}`) : s.head ? `published ${esc(String(s.head).slice(0, 8))}${s.pushed ? ' · pushed' : ' · not pushed yet'}` : 'nothing published yet';
    const fetched = s.fetch_error ? chip('bad', `fetch failed: ${s.fetch_error}`) : s.fetched_at ? `fetched ${esc(fmtTime(s.fetched_at))}` : 'not fetched yet';
    const lag = (s.homes || []).map(h => `<li>home <b>${esc(h.home)}</b> <span class="mute">last record ${esc(ago(h.lag_s))} ago${h.ahead_s ? ` · ${esc(ago(h.ahead_s))} not merged here yet` : ''}</span></li>`).join('');
    return wrap(`<div class="sl"><b>This machine</b> <span class="tag">machine</span> ${st} ${s.doorbell ? chip('ok', 'doorbell on') : chip('idle', 'doorbell off')}
      <span class="help">${s.home ? `${pub} · ${fetched}` : 'Solo: this project is built on this machine only. Set up / join below makes it a home.'}</span>
      ${lag ? `<ul class="small">${lag}</ul>` : ''}${s.home ? computers(s, ctx) : ''}</div>
     <div class="sc sync-form"><label>Ledger remote <input type="text" id="sync-remote" value="${esc(s.remote ?? '')}" placeholder="URL of your private ledger repo" autocomplete="off" spellcheck="false"${s.home_id ? ' disabled title="one ledger repo: move it by hand (docs/MULTI-HOME.md)"' : ''}></label>
      <label>Doorbell topic <input type="password" id="sync-topic" placeholder="${s.doorbell ? 'set (hidden)' : 'not set'}" autocomplete="off"></label>
      <button class="ghost" data-act="sync-ledger" data-version="${esc(s.version ?? '')}">Save</button>${out('ledger')}</div>`, 'sync home ledger remote doorbell topic publish fetch lag solo');
  }
  if (x.id === 'setup') {
    if (s.home) return wrap(`<div class="sl"><b>Set up</b> ${chip('ok', `home ${s.home}`)}<span class="help">This project is home ${esc(s.home)} of its ledger. Another machine joins with its own home id (docs/MULTI-HOME.md).</span></div>`, 'sync set up join home');
    return wrap(`<div class="sl"><b>Set up or join</b> <span class="tag">machine</span> ${chip('idle', 'solo')}
      <span class="help">Check runs the dry run: access, that the ledger repo is PRIVATE, the home id, the renames. Apply pauses the project, cuts, publishes + fetches, then resumes it.</span></div>
     <div class="sc sync-form"><label>Home id <input type="text" id="sync-home" placeholder="a, b, laptop" maxlength="8" autocomplete="off" spellcheck="false"></label>
      <label>Ledger remote <input type="text" id="sync-setup-remote" value="${esc(s.remote ?? '')}" placeholder="URL of your private ledger repo" autocomplete="off" spellcheck="false"></label>
      <label>Doorbell topic <input type="password" id="sync-setup-topic" placeholder="optional" autocomplete="off"></label>
      <label><input type="checkbox" id="sync-bare"> The first home (this project starts the ledger)</label>
      <label><input type="checkbox" id="sync-checked"> I checked the ledger repo is private</label>
      <span><button class="ghost" data-act="sync-plan">Check</button> <button class="strong" data-act="sync-apply">Apply</button></span>${out('setup')}</div>`, 'sync set up join first home cut bare private');
  }
  return wrap(`<div class="sl"><b>Duplicates across homes</b> <span class="help">${s.home ? 'Find shows the likely pairs; Write puts one owner card per pair in the Inbox.' : 'Solo: nothing to reconcile.'}</span></div>
   <div class="sc">${s.home ? '<button class="ghost" data-act="sync-reconcile" data-dry="1">Find duplicates</button> <button class="ghost" data-act="sync-reconcile" data-dry="0">Write the cards</button>' : ''}${out('reconcile')}</div>`, 'sync reconcile duplicates pairs cards');
}
/** the answer of a /api/sync/* post as lines (index.html shows them in the pane's <pre>) */
export function syncLines(r) {
  if (r.pairs) return [`${r.pairs.length} likely duplicate pair(s)${r.carded ? `, ${r.carded} carded before` : ''}${r.written?.length ? `: ${r.written.length} card(s) written to the Inbox` : ''}`, ...r.pairs.map(p => `${p.kind} ${p.a} ~ ${p.b}: ${p.why}`)];
  if (r.off) return ['Solo: nothing to reconcile.'];
  if (r.changed !== undefined) return [r.changed ? `Saved. Doorbell ${r.doorbell ? 'on' : 'off'}.` : 'No change.'];
  return [...(r.lines || []), ...(r.refused || []).map(x => `REFUSED: ${x}`), r.noop ? 'Nothing to do: already a home.' : r.refused?.length ? '' : r.dry ? 'Dry run: nothing written. Apply to do it.' : 'Done.'].filter(Boolean);
}
// META-OOTB-POLISH F-6: start from a profile (fills the form only: Review + Save stay the human step) and a basic / all split
// (basic = the rows flagged by policy.mjs BASIC_KEYS; the browser hides the rest, setFilter)
// META-PROFILE-BUG R1: the profile in force in words (Overview line + the top of Settings), from the latest caps profile decision
export function profileWords(n, now = Date.now()) {
  if (!n || n.kind === 'none') return 'your own settings (no profile)';
  if (n.kind === 'kept') return `${n.label}, ${fmtTime(n.at, now)}`;
  const name = `${n.label}${n.cost && n.cost !== 'balanced' ? ` · ${n.cost}` : ''}`;
  return n.own ? `${name} + ${n.own} of your own changes` : `${name}, saved ${fmtTime(n.at, now)}`;
}
// billing modes (lib/billing.mjs): how the Claude account is paid for - a plan's weekly limit or API billing. The pick fills the
// billing key and the caps that fit it, like a profile; Review changes + Save stay the human step
function billingBar(d) {
  const bs = d.billing || [];
  if (!bs.length) return '';
  const cur = bs.find(b => b.name === d.billing_now), pick = cur ?? bs.find(b => b.default) ?? bs[0];
  const opt = b => `<option value="${esc(b.name)}" title="${esc(b.summary)}"${b === pick ? ' selected' : ''}>${esc(b.label)}</option>`;
  return `<div class="sbilling" id="set-billing" style="flex-basis:100%;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <label>Billing <select data-set-billing data-billing="${esc(JSON.stringify(Object.fromEntries(bs.map(b => [b.name, b.changes]))))}">${bs.map(opt).join('')}</select></label>
    <button class="ghost" data-act="set-billing">Fill in</button>
    <span class="small mute" id="set-billing-note">${cur ? `In force: <b>${esc(cur.label)}</b>. ` : 'Not set: Norn treats the account as a plan with a weekly limit. '}${esc(pick.summary)}</span></div>`;
}
function profileBar(d, level) {
  const now = `<p class="small" id="set-profile-now" style="margin:0 0 6px;flex-basis:100%">In force: <b>${esc(profileWords(d.profile_now))}</b></p>`;
  const ps = d.profiles || [], opt = p => `<option value="${esc(p.name)}" title="${esc(p.summary)}">${esc(p.label)}${p.default ? ' (default)' : ''}</option>`;
  const lv = (v, t) => `<button class="${v === level ? 'strong' : 'ghost'}" data-set-level="${v}" aria-pressed="${v === level}">${t}</button>`;
  return `<div class="sprofile card" id="set-profile">${now}${ps.length ? `<label>Start from a profile <select data-set-profile data-profiles="${esc(JSON.stringify(Object.fromEntries(ps.map(p => [p.name, p.changes]))))}">${ps.map(opt).join('')}</select></label>
    <label>cost <select data-set-cost><option value="cheap">cheap</option><option value="balanced" selected>balanced</option><option value="quality">quality</option></select></label>
    <button class="ghost" data-act="set-profile">Fill in</button>` : ''}<span class="small mute" id="set-profile-note">${ps.length ? esc(ps[0].summary) : ''}</span>
    ${billingBar(d)}
    <span class="lvl">Show ${lv('basic', 'Basic')}${lv('all', 'All')}</span></div>`;
}
// fair-slots item 8: Settings > Capacity - the pool as it is now (every project, widgets.mjs capStrip) above the reserve + ceiling rows
// of every project, and the Undo of the last capacity change while its values are still in force (server.mjs capUndoOf)
const capPane = d => `${d.capacity?.rows?.length ? `<div class="srow" id="set-capstrip-row" data-search="capacity pool reserve ceiling ${esc(d.capacity.rows.map(r => r.project).join(' '))}" data-mod="0" data-basic="1"><div class="sl">${capStrip(d.capacity, { id: 'set-capstrip', mine: d.project })}</div></div>` : ''}${d.capacity_undo ? `<div class="banner" id="cap-undo">Last capacity change <span class="id">${esc(d.capacity_undo.id)}</span>: ${esc(d.capacity_undo.choice)}. <button data-act="cap-undo" data-project="${esc(d.project)}" data-id="${esc(d.capacity_undo.id)}">Undo</button></div>` : ''}`;
// RM-26 the mark "below floor" as the notice shows it (the Records rows carry it per decision: pages/ledger.mjs decMark)
const BELOW_FLOOR = '<span class="chip warn below-floor">below floor</span>';
// RM-26: while the check-in model / effort in force is below the check-in floor (policy checkinBelowFloor) a notice heads Settings;
// a warning, nothing is refused. The decisions such a check-in records carry the mark (pages/ledger.mjs decMark).
function checkinNotice(rows) {
  if (!rows?.length) return '';
  return `<div class="banner" id="checkin-floor-notice"><b>Check-in below the floor.</b> ${rows.map(r => `${r.kind === 'model' ? 'Model' : 'Effort'} ${esc(r.value)} (floor ${esc(r.to)})`).join(' · ')}: ${esc(rows[0].text)}. Its decisions are marked ${BELOW_FLOOR}.</div>`;
}
/** Look (norn / classic) and Theme (system / light / dark): this browser's, kept in localStorage, applied at once (index.html) */
const lookBar = ctx => `<div class="slook" id="set-look" role="group" aria-label="This browser"><span class="small mute">This browser</span>
  <button class="ghost" data-act="look" title="Norn look / classic look">Look: ${esc(ctx.look ?? 'norn')}</button><button class="ghost" data-act="theme" title="System / light / dark">Theme: ${esc(ctx.theme ?? 'system')}</button></div>`;
export function settings(d, ctx) {
  const sections = d.sections || [], at = s => (s.section || []).join('/'), sel = sections.some(c => c.id === ctx.setCat) ? ctx.setCat : sections[0]?.id;
  const nav = sections.map(c => {
    const rows = d.settings.filter(s => s.section?.[0] === c.id), mods = rows.filter(s => s.modified).length, basicIn = x => !!c.basic || rows.some(s => s.basic && s.section[1] === x);
    return `<button class="navcat${c.id === sel ? ' on' : ''}" id="nav-${esc(c.id)}" data-setcat="${esc(c.id)}" data-basic="${c.basic || rows.some(s => s.basic) ? 1 : 0}" aria-pressed="${c.id === sel}">${esc(c.label)}${mods ? `<span class="mcount" title="${mods} modified from default">${mods}</span>` : ''}</button>`
      + `<div class="navsubs">${c.subs.map(x => `<button class="navsub" data-setcat="${esc(c.id)}" data-basic="${basicIn(x.id) ? 1 : 0}" data-setsub="sub-${esc(c.id)}-${esc(x.id)}">${esc(x.label)}</button>`).join('')}</div>`;
  }).join('');
  const panes = sections.map(c => {
    const subs = c.info ? (c.id === 'notify' ? notifyPane(d) + remotePane(d.remote) : filesPane(d)) : c.subs.map(x => {
      if (x.pane) return syncPane(x, d, ctx);
      const items = d.settings.filter(s => at(s) === `${c.id}/${x.id}` || at(s).startsWith(`${c.id}/${x.id}/`));
      const body = x.subs ? x.subs.map(y => { const g = items.filter(s => s.section[2] === y.id); return g.length ? (x.inline ? inlineGroup(c, x, y, g, x.id === 'routing' ? guardChip(guardOn(d.guard, r => r.type === 'models' && r.cls === y.id), { tab: 'spend', sub: 'advice' }) : '') : g.map(row).join('')) : ''; }).join('') : items.map(row).join('');
      return `<div class="ssub${x.danger ? ' danger' : ''}" id="sub-${esc(c.id)}-${esc(x.id)}"><h3>${esc(x.label)}${x.help ? ` <span class="help">${esc(x.help)}</span>` : ''}</h3>${x.id === 'capacity' ? capPane(d) : ''}${body}</div>`;
    }).join('');
    return `<section class="scat" id="cat-${esc(c.id)}" data-cat="${esc(c.id)}"${c.id === sel ? '' : ' hidden'}><h2>${esc(c.label)}</h2><p class="small mute">${esc(c.help)}</p>${subs}</section>`;
  }).join('');
  return `${lookBar(ctx)}${checkinNotice(d.checkin_below)}${profileBar(d, ctx.setLevel ?? 'basic')}<div class="settings"><aside class="snav"><input type="search" id="set-search" data-set-search placeholder="Search settings  ·  @modified" aria-label="Search settings">${nav}</aside>
   <div class="spane"><p class="small mute" id="set-nohit" hidden>No setting matches.</p>${panes}</div></div>
   <div class="savebar"><span class="small" id="dirty-count">No unsaved changes</span><button class="strong" data-act="settings-review" data-project="${esc(d.project)}" data-version="${esc(d.version)}">Review changes</button><button class="ghost" data-act="settings-discard">Discard</button>
   <span class="small mute">Review shows a diff; Save writes atomically and refuses a stale version (409).</span><div id="settings-diff"></div></div>`;
}
