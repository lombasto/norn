// Engine dashboard UI (META-GENERAL-DESIGN 7, 12-S7): pure renderers, data -> HTML strings, fed by the S6 /api endpoints.
// The same module runs in the browser (index.html imports /ui.mjs) and in node --test (server-side render check of the ids).
// Rules (section 7): status = text + colour (a chip always carries a word), numbers with units, ids everywhere, tabular
// numerals (CSS), one accent colour for "needs you", no animation and no timer (index.html re-renders from the /api/stream state stream).
import { renderProse } from './prose.mjs';
import { renderAdopt, adoptStep } from './adopt.mjs';
import { renderHome } from './home.mjs';
import { CONTEXT_SUBS, contextParts } from './insparts.mjs';
import { SUB_CAP, pickSub } from './subviews.mjs';
import { GUARD_SUBS } from './guardparts.mjs';
import { firstDoc } from './docparts.mjs';
import { esc, fin, plural, chip, pauseAct, fmtTime } from './cells.mjs';
import { lanesPage, LANES_SUBS } from './pages/lanes.mjs';
import { runs } from './pages/runs.mjs';
import { context } from './pages/context.mjs';
import { docs } from './pages/docs.mjs';
import { roadmap } from './pages/roadmap.mjs';
import { spend } from './pages/spend.mjs';
import { slopPage } from './pages/slop.mjs';
import { settings } from './pages/settings.mjs';
import { tests, testsLoad } from './pages/tests.mjs';
import { code, codeLoad } from './pages/code.mjs';
import { inbox } from './pages/inbox.mjs';
import { records, ledger } from './pages/ledger.mjs';
// NORN-UI-NAV: every page, the bar's four first (shell.mjs BAR), then the More sheet's (shell.mjs MORE), then Settings (the header's
// cog, shell.mjs COG). Label = id = URL (?tab=<id>)
export const TABS = [['controller', 'Controller'], ['lanes', 'Lanes'], ['runs', 'Runs'], ['inbox', 'Inbox'],
  ['spend', 'Spend'], ['slop', 'Slop'], ['tests', 'Tests'], ['code', 'Code'], ['context', 'Context'], ['records', 'Records'], ['ledger', 'Ledger'], ['docs', 'Docs'],
  ['roadmap', 'Roadmap'], ['settings', 'Settings']];
export const ONE_PROJECT = ['controller', 'roadmap', 'records', 'docs', 'context', 'slop', 'ledger', 'settings', 'tests', 'code'];


const panel = (tab, html) => `<div id="panel-${tab}">${html}</div>`;
const oneProject = tab => panel(tab, `<div class="card"><p class="mute">Choose one project in the header: the ${esc(tab)} tab belongs to one project (its own records / files).</p></div>`);

export const needsCount = ov => (ov && fin(ov.needs_you) ? ov.needs_you : 0);
export const pageTitle = (n, project, look = 'classic') => `${n > 0 ? `(${n}) ` : ''}${look === 'norn' ? 'Norn' : 'norn'} - ${project === 'all' ? 'all projects' : project}`;
/** the Health pages' states from what the header holds: spend = the overview's burn.usage (guard STOP or over the hourly cap = bad,
 *  guard ok = ok), slop / tests / context = the Guard rows of their types (a warn-level row = warn, else ok); null = not known */
export function healthStates({ usage = null, rows = null } = {}) {
  const u = !usage || usage.billing?.type === 'api' ? null : usage.guard === 'STOP' || usage.rateOK === false ? 'bad' : usage.guard === 'ok' ? 'ok' : null;
  const of = types => (rows ? (rows.some(r => types.includes(r.type) && (r.severity === 'high' || r.severity === 'medium')) ? 'warn' : 'ok') : null);
  return { spend: u, slop: of(['code']), tests: of(['tests']), context: of(['instructions', 'memory', 'rules', 'docs']) };
}

// ---------- data: one loader per tab over the S6 endpoints; get(path) -> JSON (throws on non-200) ----------
// META-TEND P6: the Guard rows for the chips in place (one project; a missing / failing /api/guard never breaks the tab)
const guardGet = (get, q, all) => (all ? Promise.resolve(null) : Promise.resolve().then(() => get(`/api/guard?${q}`)).catch(() => null));
// META-UX-BUILD S1 + S2: the ONE part loader. Instructions: its 5 parts of one view (project + its scan time), fetched in parallel after
// the summary paints. A sub-view tab (subviews.mjs): the chosen sub-view's part of one view (project + sig + sub + limit).
// META-UX-BUILD S3: Docs - the open file is its one part (&file=<key>) of one list (project + sig).
// META-UX-BUILD S4: Context (the Instructions view's cost half) - the parts its sub-view needs (contextParts), of one view (project + scan
// time + sub); its route stays /api/instructions (the Norn vocabulary rule: routes stay, labels and the URL tab move).
// Stage RUNS: Runs paints the live part (running + queue) first; its one part is the history (the ended runs in the window), keyed by
// the live answer's time so a stream repaint fetches it afresh
const PART_NAMES = { context: d => contextParts(d.sub), slop: d => [d.sub], docs: d => (d.file ? ['file'] : []), runs: () => ['history'] };
const PART_API = { context: 'instructions', slop: 'guard', runs: 'agents' };   // META-UX-BUILD S5: Slop (was Guard) keeps its route /api/guard
const runsWin = w => (w && w !== '2h' ? `&window=${w}` : '');
export const partsKey = (tab, project, d) => (tab === 'runs' ? `${project}|${d.window}|${d.at}` : tab === 'context' ? `${project}|${d.at}|${d.sub}` : tab === 'docs' ? `${project}|${d.sig}|${d.file}` : `${project}|${d.sig}|${d.sub}|${d.limit}|${d.batch ?? ''}|${d.finding ?? ''}`);
export async function loadParts(tab, project, d, get) {
  const q = `project=${encodeURIComponent(project)}`, lim = tab === 'docs' ? `&file=${encodeURIComponent(d.file)}` : d.limit && tab !== 'context' ? `&limit=${d.limit}${d.batch ? `&batch=${encodeURIComponent(d.batch)}` : ''}${d.finding ? `&finding=${encodeURIComponent(d.finding)}` : ''}` : '';
  if (tab === 'runs') return { ended: (await get(`/api/agents?${q}&part=history${runsWin(d.window)}`)).tree };   // the Ended band (its own key: `tree` is the live part's)
  const xs = await Promise.all(PART_NAMES[tab](d).map(k => get(`/api/${PART_API[tab] ?? tab}?${q}&part=${k}${lim}`)));
  return Object.assign({}, ...xs);
}
/** the parts of this view already fetched (ctx.parts[tab] = { key, data }) or null */
const partsHave = (ctx, tab, project, d) => (ctx.parts?.[tab]?.key === partsKey(tab, project, d) ? ctx.parts[tab].data : null);
export async function loadTab(tab, project, get, ctx = {}) {
  // META-ADOPT A3: the setup page (not a nav tab) - Add a project with no project (or "+ Add a project"), else GET /api/adopt
  if (tab === 'adopt') {
    if (ctx.adoptScan) return ctx.adoptScan;
    if (!project || project === 'all' || ctx.adoptAdd) return { project: null, repos: (await get('/api/adopt/repos')).repos, projects: ctx.projects ?? [] };
    return get(`/api/adopt?project=${encodeURIComponent(project)}`);
  }
  const q = `project=${encodeURIComponent(project)}`, all = project === 'all';
  if (all && ONE_PROJECT.includes(tab)) return { one: true };
  if (tab === 'controller') return get(`/api/home?${q}`);   // META-CONTROLLER C2 (the route keeps its name: routes stay, labels and the URL tab move)
  if (tab === 'inbox') return get(`/api/inbox?${q}`);
  if (tab === 'lanes') {   // the Lanes page's sub-views: the lane table (+ the queue's plan: Up next on the Waiting lanes), or every branch / worktree of the repo (branches.mjs, the cached scan)
    const sub = pickSub(LANES_SUBS, ctx.sub), limit = ctx.limit || SUB_CAP;
    if (sub !== 'lanes') return { ...(await get(`/api/branches?${q}`)), sub, limit };
    const [l, plan] = await Promise.all([get(`/api/lanes?${q}`), Promise.resolve().then(() => get(`/api/plan?${q}`)).catch(() => null)]);
    return { ...l, plan, sub, limit };
  }
  if (tab === 'runs') {   // stage RUNS: the live part + the queue's plan (up next: holds, estimate, priority); the last history part stands in, marked, until the new one lands
    const [a, plan, guard] = await Promise.all([get(`/api/agents?${q}&part=live${runsWin(ctx.runsWindow)}`), Promise.resolve().then(() => get(`/api/plan?${q}`)).catch(() => null), guardGet(get, q, all)]);
    const old = ctx.parts?.runs, ended = old && old.key.startsWith(`${project}|${a.window}|`) ? old.data.ended : undefined;
    return { ...a, plan, guard, ended, parts_loading: true }; }
  if (tab === 'records') return get(`/api/records?${q}`);
  if (tab === 'roadmap') {
    const d = await get(`/api/roadmap?${q}`);
    if (d && !d.error && !(d.themes || []).length) {   // META-ADOPT A3: an empty roadmap names what the repository holds and offers the draft
      const a = await Promise.resolve().then(() => get(`/api/adopt?${q}`)).catch(() => null);
      const f = a?.facts;
      if (f) d.adopt = { plans: (f.plans || []).length, items: (f.plans || []).reduce((n, p) => n + p.items, 0), branches: (f.branches || []).filter(b => !b.merged).length };
    }
    return d;
  }
  if (tab === 'docs') {   // META-UX-BUILD S3: the grouped list first; the open file is its own part (a URL pick, else the first file on a wide screen)
    const limit = ctx.limit || SUB_CAP, d = { ...(await get(`/api/docs?${q}&limit=${limit}`)), limit, picked: !!ctx.doc, line: ctx.docLine ?? null, src: !!ctx.docSrc };
    d.file = ctx.doc || (ctx.wide ? firstDoc(d) : null);
    const have = d.file ? partsHave(ctx, 'docs', project, d) : null;
    return { ...d, doc: have?.doc ?? null, parts_loading: !!d.file && !have };
  }
  if (tab === 'context') {   // META-INSTRUCTIONS R1. META-UX-BUILD S1: the summary first. S4: the sub-view (or the checks page) and its parts
    const sub = ctx.sub === 'checks' ? 'checks' : pickSub(CONTEXT_SUBS, ctx.sub), v = { ...(await get(`/api/instructions?${q}`)), sub, limit: ctx.limit || SUB_CAP };
    const need = !v.pending && !(v.error && !v.at) && contextParts(sub).length > 0, have = need ? partsHave(ctx, 'context', project, v) : null;
    return { ...v, ...(have || {}), parts_loading: need && !have };
  }
  if (tab === 'ledger') return get(`/api/ledger?${q}${ctx.ledgerN ? `&count=${ctx.ledgerN}` : ''}`);
  if (tab === 'settings') {   // C6: /api/remote exists only while dash.remote is on (404 = off)
    const [d, remote, guard] = await Promise.all([get(`/api/settings?${q}`), get('/api/remote').catch(() => null), guardGet(get, q, all)]);
    return { ...d, remote: remote?.on === true ? remote : null, guard };
  }
  // Spend carries the forecast: /api/plan's forecast per project, beside the usage parts; sub = the open drawer view
  if (tab === 'spend') { const [u, pl] = await Promise.all([get(`/api/usage?${q}`), get(`/api/plan?${q}`).catch(() => null)]); return { ...u, forecasts: Object.fromEntries((pl?.parts || []).map(p => [p.project, p.forecast])), sub: ctx.sub ?? null }; }
  // dash-owner-1123: Tests (the summary, the open view's part and the open case) and Code (the summary, the open view's part and the open file)
  if (tab === 'tests') return testsLoad(project, get, ctx);
  if (tab === 'code') return codeLoad(project, get, ctx);
  if (tab === 'slop') {   // META-TEND P6. META-UX-BUILD S2: the summary first, then the chosen sub-view's part. S5: Slop (was Guard); one open batch
    const sub = ctx.finding ? 'fix' : pickSub(GUARD_SUBS, ctx.sub), finding = ctx.finding || null;   // &finding=<id>: To fix, unfiltered, its batch open
    const d = { ...(await get(`/api/guard?${q}&part=summary`)), sub, kind: finding ? null : ctx.kind ?? null, ...(finding ? { finding } : {}), limit: ctx.limit || SUB_CAP, ...(sub === 'fix' && ctx.batch ? { batch: ctx.batch } : {}) };
    const have = partsHave(ctx, 'slop', project, d);
    // META-UX-BUILD S6: the Fix all sheet, open (ctx.fixall) = its own part of the same view, fetched when it opens
    const sheet = ctx.fixall ? (await get(`/api/guard?${q}&part=sheet`)).sheet : null;
    return { ...d, ...(have || {}), parts_loading: !have, ...(sheet ? { sheet, sheet_sent: ctx.fixall.sent ?? null, sheet_sel: ctx.fixall } : {}) };
  }
  throw new Error('unknown tab ' + tab);
}

// ---------- tabs ----------
/** the cards that read the status strip (/api/strip, ctx.strip), not the page's endpoint - the retired Overview's onboarding on Lanes (the first
 *  task, the setup gaps). index.html repaints #strip-cards when a newer strip lands. */
export const stripCards = (tab, s) => `<div id="strip-cards">${!s ? '' : tab === 'lanes' ? firstTask(s.first_run) + setupGaps(s.setup) : ''}</div>`;
export function renderTab(tab, d, ctx = {}) {
  if (tab === 'adopt') return panel(tab, renderAdopt(adoptStep(d, ctx.adoptAsk), d, ctx));
  if (d?.one) return oneProject(tab);
  const now = ctx.now ?? Date.now();
  if (tab === 'lanes') return panel(tab, stripCards(tab, ctx.strip) + lanesPage(d, { ...ctx, now }));
  if (tab === 'controller') return panel(tab, renderHome(d, { ...ctx, now }));
  return panel(tab, ({ inbox, lanes: lanesPage, runs, roadmap, records, docs, context, ledger, settings, tests, code, slop: slopPage, spend })[tab](d, { ...ctx, now }));
}

// META-ADOPT A3 (SPEC sec. 5): the setup gaps of one project - each names what is missing in one line and offers the next action
function setupGaps(g) {
  if (!g) return '';
  const p = esc(g.project), rows = [];
  const row = (what, text, acts) => rows.push(`<div class="item">${chip('warn', what)}<div><b>${text}</b><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${acts}</div></div></div>`);
  if (!g.roadmap) row('roadmap', 'No roadmap yet.', `<button data-act="adopt-open" data-project="${p}">Draft it from the repository</button><button class="ghost" data-tab="roadmap">Open the roadmap</button>`);
  if (!g.rules) row('rules', 'No project rules yet: no rules/RULES.md and no agent rules file (CLAUDE.md, AGENTS.md) in the repo.',
    `<button data-act="adopt-open" data-project="${p}">Draft them</button><button class="ghost" data-act="adopt-rule" data-project="${p}">Write one rule</button>`);
  const c = g.caps || {}, cap = (k, u) => (c[k] === null || c[k] === undefined ? `${u} unset (no limit)` : `${c[k]} ${u}`);
  if (!g.caps_chosen && !g.caps_kept) row('caps', `No caps profile is on record. Nobody chose them: the caps in force are ${cap('max_claude_workers', 'Claude workers')}, ${cap('max_codex', 'Codex runs')}, weekly stop ${cap('weekly_stop_pct', '%')}.`,
    `<button data-tab="settings">Choose a profile</button><button class="ghost" data-act="adopt-caps-keep" data-project="${p}">Keep the starter caps</button>`);
  if (!g.gate) row('merge gate', `Merges are not gated. ${g.found_gate ? `Proposed: <span class="mono">${esc(g.found_gate)}</span>.` : 'No test command is on record.'}`,
    g.found_gate ? `<button class="primary" data-act="setup-gate" data-project="${p}" data-cmd="${esc(g.found_gate)}" data-version="${esc(g.version ?? '')}">Set it</button><button class="ghost" data-act="adopt-open" data-project="${p}">Another command</button>`
      : `<button data-act="adopt-open" data-project="${p}">Set it</button>`);
  // what is already in place, named (which rules file, the caps and where they were chosen), so a short card says why a row is gone
  const have = [g.rules && (g.rules_from || []).length ? `rules: ${esc(g.rules_from.join(', '))}` : '', g.caps_chosen ? `caps (${g.caps_from === 'budget' ? 'budget.json' : 'a recorded profile'}): ${cap('max_claude_workers', 'Claude workers')}, ${cap('max_codex', 'Codex runs')}, weekly stop ${cap('weekly_stop_pct', '%')}` : '',
    g.gate ? `merge gate: <span class="mono">${esc(g.gate)}</span>` : ''].filter(Boolean);
  return rows.length ? `<section class="card" id="setup-gaps" style="margin-bottom:12px"><h2>Set up ${p}</h2>${rows.join('')}${have.length ? `<p class="small mute" id="setup-have" style="margin:8px 0 0">In place: ${have.join(' · ')}</p>` : ''}</section>` : '';
}
// META-OOTB F-1: a project with no records yet - one text box = an owner directive + lane `first` with its own worktree and branch
const capShown = v => (v === null || v === undefined ? 'unset (no limit)' : String(v));
function firstTask(f) {
  if (!f) return '';
  const c = f.caps || {}, unit = (v, u) => (v === null || v === undefined ? capShown(v) : `${v} ${u}`);
  return `<section class="card" id="first-task" style="margin-bottom:12px"><h2>Give Norn its first task</h2>
   <p class="small mute">Say in one sentence what Norn should do in <b>${esc(f.project)}</b>. It is recorded as your directive, lane <b>${esc(f.lane)}</b> gets its own git worktree on branch <span class="mono">norn/${esc(f.lane)}</span> and a first brief, and the next check-in picks it up.</p>
   <div style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" id="first-task-text" placeholder="e.g. Add a usage section to the README" style="flex:1;min-width:260px"><button class="primary" data-act="first-task" data-project="${esc(f.project)}">Start</button></div>
   <p class="small" style="margin:10px 0 0">Or let Norn look at the repo and draft a roadmap, rules and a first task <button data-tab="adopt">Look at the repo</button></p>
   <div class="small mute" style="margin-top:8px">Caps in force: <b>${esc(capShown(c.max_claude_workers))}</b> Claude worker(s) · <b>${esc(capShown(c.max_codex))}</b> Codex · weekly stop <b>${esc(unit(c.weekly_stop_pct, '%'))}</b> · rate cap <b>${esc(unit(c.usage_rate_cap_pct_per_h, '%/h'))}</b> (Settings, Workers &amp; budget)</div></section>`;
}
// RM-37: the header's pause menu (index.html #pause-pop) from the overview: the mode in force (who, when, why), one button per mode with
// its one-line effect, what waits on the pause (queued runs held, runs asked to pause, paused hand-offs with a Resume each), Pause half
// (ctx.half = its pick: the confirm line + Confirm) and Resume all
export function pauseMenu(o, ctx = {}) {
  const pz = o.pause, w = o.waiting || { held: 0, asked: [], handoffs: [] }, half = ctx.half, run = r => `${esc(r.run)}${r.lane ? ` (${esc(r.lane)})` : ''}`;
  const now = pz ? `<div><b>Now: ${esc(pz.label)}</b><div class="small mute">${[pz.by && `by ${esc(pz.by)}`, pz.at && esc(fmtTime(pz.at, ctx.now)), pz.why && esc(pz.why)].filter(Boolean).join(' · ')}</div></div>` : '<div><b>Now: nothing paused</b></div>';
  const modes = (o.modes || []).map(m => `<div class="pm-mode"><button data-act="pause-mode" data-mode="${esc(m.mode)}"${pz?.mode === m.mode ? ' aria-pressed="true" disabled' : ''}>${esc(m.label)}</button><span class="small">${esc(m.says)}</span></div>`).join('');
  const wait = [w.held ? `<div class="small">${plural(w.held, 'queued run')} held until release</div>` : '', w.asked.length ? `<div class="small">Asked to pause: ${w.asked.map(run).join(', ')}</div>` : '',
    ...w.handoffs.map(r => `<div class="small">Paused hand-off ${run(r)} ${pauseAct('handoff', r.project, r.run)}</div>`)].join('');
  const pick = half ? `<div class="small" id="pause-half">${esc(half.line)}${half.pick.length ? ` <button data-act="pause-half-go" data-runs="${esc(half.pick.map(r => r.id).join(','))}">Confirm</button>` : ''}</div>` : '';
  return `${now}${modes}${wait ? `<div><b class="small">Waiting on the pause</b>${wait}</div>` : ''}
    <div class="acts"><button class="ghost" data-act="pause-half" title="Ask the newer half of the running runs to stop at a clean point and hand off">Pause half</button><button data-act="pause-resume-all"${pz || w.handoffs.length ? '' : ' disabled'}>Resume all</button></div>${pick}`;
}


const onMain = r => r.state === 'merged' || r.state === 'installed';
// DLV-MERGED-TRUTH: why Norn cannot tell, and the one Inbox ruling that settles it
const dlvWhy = r => r.state === 'unknown' ? `<div class="small mute">${esc(r.unknown_why ?? '')}${r.ruling ? ` · ruling <a href="#" data-rid="${esc(r.ruling)}">${esc(r.ruling)}</a> in the Inbox` : ' · the next check-in asks you'}</div>` : '';
// OVERVIEW-TRUTH (2): why a DONE row is not merged (deliverablesView why_not, dlvwhy.mjs), in words with its link: the run opens in the
// live feed drawer, the PR on GitHub; 'no merge queued' and a stopped merge are warn chips
const whyLink = (w, r) => w.url ? ` <a href="${esc(w.url)}" target="_blank" rel="noopener">open</a>`
  : w.run ? ` <span class="link" role="button" tabindex="0" data-feed="${esc(w.run)}" data-project="${esc(r.project)}" title="Open ${esc(w.run)} in the live feed">${esc(w.run)}</span>` : '';
export const dlvWhyNot = r => (!r.why_not ? '' : `<div class="small dlvwhy" data-why="${esc(r.why_not.kind)}">${r.why_not.warn ? chip('warn', r.why_not.text) : `<span class="mute">${esc(r.why_not.text)}</span>`}${whyLink(r.why_not, r)}</div>`);
export function renderDeliverable(r, ctx = {}) {
  if (!r) return '<div class="small mute">deliverable not found (refresh the page)</div>';
  const reached = { done: 1, unknown: 1, merged: 2, installed: 3 }[r.state] ?? 0;
  const steps = ['done', 'merged', 'installed'].map((s, i) => chip(i < reached ? 'ok' : 'idle', s.toUpperCase())).join(' <span class="mute">&rarr;</span> ');
  const kv = (k, v) => `<span class="mute small">${esc(k)}</span><div>${v}</div>`;
  const nat = r.native === null ? '<span class="mute">unknown (no native globs for this repo)</span>' : r.native
    ? `${chip('bad', 'native')}<div class="mono small">${(r.native_files || []).map(esc).join('<br>')}</div>` : 'no native code';
  return `<div class="dlvd"><h3 style="margin:10px 0 4px"><span class="id">${esc(r.id)}</span> ${esc(r.branch)}</h3><div class="small" style="margin-bottom:8px">${esc(r.delivers ?? '')}</div>
   <div style="margin:6px 0 12px">${steps} <span class="small mute">target ${esc(r.target)}${r.at_target ? ' · reached' : ''}</span></div>
   <div class="kv">${kv('repo', `<span class="mono small">${esc(r.repo)}</span>`)}${kv('tip', `<span class="mono">${esc(String(r.tip ?? '-').slice(0, 9))}</span>${r.branch_exists === false ? ' <span class="small mute">(branch gone: the tip recorded at DONE)</span>' : ''}`)}
   ${kv('lane / run', `${esc(r.lane ?? '-')} · ${esc(r.run ?? '-')}`)}${kv('done', `${esc(fmtTime(r.done_utc, ctx.now ?? Date.now()))} · ${fin(r.days) ? r.days.toFixed(1) + ' d ago' : '-'}`)}
   ${kv('vs main', fin(r.behind) ? `${r.behind} behind · ${r.ahead ?? '?'} ahead` : onMain(r) ? 'on main' : '-')}${kv('native', nat)}
   ${onMain(r) ? kv('merged', `${esc(r.state_word ?? r.state)}${r.merge_commit ? ` · <span class="mono">${esc(String(r.merge_commit).slice(0, 9))}</span>` : ''}${r.merged_at ? ` · ${esc(fmtTime(r.merged_at, ctx.now ?? Date.now()))}` : ''}`) : ''}
   ${r.state === 'unknown' ? kv('merged?', `${chip('needs', 'cannot tell')} ${dlvWhy(r)}`) : ''}
   ${r.rehearsal ? kv('merge rehearsal', r.rehearsal.clean ? chip('ok', 'clean') : `${chip('bad', 'conflict')}<div class="mono small">${r.rehearsal.files.map(esc).join('<br>')}</div>`) : ''}
   ${kv('park', r.park ? `${chip('parked', `parked ${Math.floor(r.park.days)} d`)} ${esc(r.park.why)} <span class="small mute">by ${esc(r.park.by ?? '-')}${r.park.expired ? ' · expired: back on the list' : ''}</span>` : '<span class="mute">not parked</span>')}
   ${r.why_not ? kv('not merged', dlvWhyNot(r)) : ''}${kv('question', r.asked ? `<a href="#" data-rid="${esc(r.asked)}">${esc(r.asked)}</a> (one per deliverable)` : r.due ? chip('open', 'question due: the next check-in asks') : '<span class="mute">none</span>')}</div>
   <h3 style="margin:14px 0 4px">Move it</h3><div class="mono small" style="white-space:pre-wrap">norn deliverables park ${esc(r.id)} --why "&lt;the owner's reason&gt;"
norn deliverables unpark ${esc(r.id)}
norn deliverables ask ${esc(r.id)}      (the check-in: one question per deliverable)${r.resolve ? `
norn deliverables resolve ${esc(r.id)}  (${esc(r.resolve.why)}; native = door work)` : ''}</div>
   <div class="small mute" style="margin-top:8px">MERGED comes from the PR on GitHub, else git, else the change itself found on main (equivalent); INSTALLED from the last install receipt. Only a 'cannot tell' asks you.</div></div>`;
}

/**
 * RM-30 S1: a directive the page sent was refused as a restatement of an active one (/api/directive 409 { dup }). x = { text, dup:
 * { id, line, why } } -> the plain-words notice: which directive it matches, Open it, Replace it with this wording (supersede, recorded),
 * Keep both (new: true), Cancel. '' when there is nothing to say.
 */
export function dupRefusal(x) {
  if (!x?.dup?.id) return '';
  const id = esc(x.dup.id);
  return `<div class="dupask" role="alert"><b>Not written: this says the same as ${id}, an active directive.</b>
    <div class="dupcmp small"><div><span class="olab">${id} says</span>${renderProse(x.dup.line ?? '')}</div><div><span class="olab">you wrote</span>${renderProse(String(x.text ?? '').slice(0, 400))}</div></div>
    <div class="small mute">Matched by ${esc(x.dup.why ?? 'its words')}. Two active directives that say the same thing get read twice at every check-in.</div>
    <div class="dupbtns"><button data-act="dup-open" data-id="${id}">Open ${id}</button><button class="primary" data-act="dup-replace" data-id="${id}">Replace it with this wording</button><button class="ghost" data-act="dup-new">Keep both</button><button class="ghost" data-act="dup-close">Cancel</button></div></div>`;
}
