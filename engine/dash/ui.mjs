// Engine dashboard UI (META-GENERAL-DESIGN 7, 12-S7): pure renderers, data -> HTML strings, fed by the S6 /api endpoints.
// The same module runs in the browser (index.html imports /ui.mjs) and in node --test (server-side render check of the ids).
// Rules (section 7): status = text + colour (a chip always carries a word), numbers with units, ids everywhere, tabular
// numerals (CSS), one accent colour for "needs you", no animation and no timer (index.html re-renders from the /api/stream state stream).
import { renderMarkdown } from './docs.mjs';
import { parseLedger, ledgerInline, LEDGER_KINDS, recordBlocks } from './ledger.mjs';
import { renderAdopt, adoptStep } from './adopt.mjs';
import { renderHome } from './home.mjs';
import { bars, columns, stack, board, lines, meter, dodChips, critiqueChip, critiqueWord, hoChip } from './widgets.mjs';
import { orcLine, badgeLabel } from './norn/orc.mjs';
import { INS_CAPS, LADDER_ORDER, LADDER_STATES, CONTEXT_SUBS, contextParts, contextNumbers, standingRows, perDay, worstFiles, fileAdvice } from './insparts.mjs';
import { SUB_CAP, pickSub, subviewPage, subMore } from './subviews.mjs';
import { GUARD_SUBS } from './guardparts.mjs';
import { firstDoc, placeFindings, findingsByLine } from './docparts.mjs';
import { needsYou } from './terms.mjs';
export const TABS = [['home', 'Home'], ['overview', 'Overview'], ['inbox', 'Inbox'],
  ['work', 'Work'], ['lanes', 'Lanes'], ['runs', 'Runs'], ['map', 'Map'], ['plan', 'Plan'], ['roadmap', 'Roadmap'],
  ['health', 'Health'], ['usage', 'Usage'], ['slop', 'Slop'], ['tests', 'Tests'], ['context', 'Context'],
  ['history', 'History'], ['records', 'Records'], ['ledger', 'Ledger'], ['docs', 'Docs'], ['settings', 'Settings']];
export const ONE_PROJECT = ['home', 'map', 'roadmap', 'history', 'records', 'docs', 'context', 'slop', 'ledger', 'settings', 'tests'];

// ---------- formatting ----------
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fin = v => typeof v === 'number' && Number.isFinite(v);
const dash = '<span class="mute">-</span>';
const int = n => fin(n) ? Math.round(n).toLocaleString('en-US') : '-';
const pct = (n, d = 1) => fin(n) ? `${n.toFixed(d)} %` : '-';
const kTok = n => fin(n) ? `${Math.round(n / 1000)}k` : '-';
const mTok = n => !fin(n) ? '-' : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`;
export function fmtMin(m) {
  if (!fin(m)) return '-';
  m = Math.max(0, Math.round(m));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}
const minsSince = (iso, now) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? (now - t) / 60000 : null; };
// UTC times with a Z, ids and dates as the records carry them: today "02:14Z", older "10-30 22:20Z".
export function fmtTime(iso, now = Date.now()) {
  const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return '-';
  const d = new Date(t), hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
  return new Date(now).toISOString().slice(0, 10) === d.toISOString().slice(0, 10) ? hm : `${d.toISOString().slice(5, 10)} ${hm}`;
}
const fmtLocal = iso => { const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return '-';
  const d = new Date(t); return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} local`; };

// run name (META-UX-R1 C): stable human name next to the RUN id everywhere a run shows
const aname = n => n ? ` <b class="aname">${esc(n)}</b>` : '';
export const chip = (cls, txt) => `<span class="chip ${esc(cls)}">${esc(txt ?? cls)}</span>`;
// built-ins by name; every configured (typed) executor - API or cli - is an own-account executor ('prov')
const exClass = ex => String(ex ?? '').startsWith('codex') ? 'codex' : !ex || ['claude', 'fake'].includes(ex) ? 'claude' : 'prov';
export function exChip(ex, model, effort) {
  const t = [ex, model && ex && String(model).startsWith(ex + '-') ? String(model).slice(ex.length + 1) : model].filter(Boolean).join(' ') + (effort && effort !== '-' ? ` · ${effort}` : '');
  return t ? chip(exClass(ex), t) : dash;
}
// Lane / run state text -> chip class + short word (lanes.mjs text grammar, design 5).
export function stateOf(text) {
  const t = String(text ?? '');
  if (t.startsWith('running')) return ['running', 'running'];
  if (t.startsWith('parked')) return ['parked', 'parked'];
  if (t === 'exited: DONE') return ['done', 'DONE'];
  if (t.startsWith('exited: STOPPED')) return ['stopped', 'STOPPED'];
  if (t.startsWith('exited: HANDOFF')) return ['handoff', 'HANDOFF'];
  if (t.startsWith('exited: no-result')) return ['no-result', 'no-result'];
  if (t.startsWith('exited: crash')) return ['bad', 'crash'];
  if (t === 'lost') return ['lost', 'lost'];
  if (t.startsWith('killed')) return ['bad', 'killed'];
  if (t.startsWith('waiting')) return ['warn', 'waiting'];
  if (t === 'no runs') return ['idle', 'no runs'];
  return ['idle', t || '-'];
}
const runChip = s => chip({ running: 'running', exited: 'done', finished: 'done', alive: 'running', stopped: 'idle', lost: 'lost', killed: 'bad' }[s] ?? 'idle', s ?? '-');
const projTag = (ctx, p) => ctx.project === 'all' && p ? `<span class="id">${esc(p)}</span> ` : '';
const panel = (tab, html) => `<div id="panel-${tab}">${html}</div>`;
const oneProject = tab => panel(tab, `<div class="card"><p class="mute">Choose one project in the header: the ${esc(tab)} tab belongs to one project (its own records / files).</p></div>`);

export const needsCount = ov => (ov && fin(ov.needs_you) ? ov.needs_you : 0);
export const pageTitle = (n, project, look = 'classic') => `${n > 0 ? `(${n}) ` : ''}${look === 'norn' ? 'Norn' : 'norn'} - ${project === 'all' ? 'all projects' : project}`;
// UX review 2: the bar is 7 destinations with plain names (both looks). Home, Overview, Inbox and Settings are one page each; Work,
// Health and History are pages of their own (a hub: one card per page under it, with what needs a look) and, while one of them or one of
// its pages is open, a second row lists its pages. Label, tab id and URL (?tab=<id>) are the same word for every page.
// [id (= the destination's own page), label, the pages under it in display order]
export const NAV = [
  ['home', 'Home', []],
  ['overview', 'Overview', []],
  ['inbox', 'Inbox', []],
  ['work', 'Work', ['lanes', 'runs', 'map', 'plan', 'roadmap']],
  ['health', 'Health', ['usage', 'slop', 'tests', 'context']],
  ['history', 'History', ['records', 'ledger', 'docs']],
  ['settings', 'Settings', []],
];
/** the destination a page sits in ([id, label, pages]): itself or the one whose pages hold it; null for the setup page */
export const destOf = tab => NAV.find(([g, , ids]) => g === tab || ids.includes(tab)) ?? null;
const countBadge = n => (n ? `<span class="count" aria-label="${n} need you">${n}</span>` : '');
// RM-18 S1: a Norn colour on the nav as a meaning. History = Urd (was), Work = Verdandi (is) but its Plan and Roadmap = Skuld (shall be),
// Inbox = Skuld; Health = its worst state; Home, Overview, Settings neutral. CSS: norn.css .tone-* (both looks).
export const DEST_NORN = { history: 'urd', work: 'verd', inbox: 'skuld' };
export const PAGE_NORN = { plan: 'skuld', roadmap: 'skuld' };
const RANK = { ok: 0, warn: 1, bad: 2 };
/** the worst of { page: 'ok'|'warn'|'bad'|null } states; null when none is known */
export const worstState = st => Object.values(st || {}).filter(v => v in RANK).reduce((w, v) => (w === null || RANK[v] > RANK[w] ? v : w), null);
/** the Health pages' states from what the header holds: usage = the overview's burn.usage (guard STOP or over the hourly cap = bad,
 *  guard ok = ok), slop / tests / context = the Guard rows of their types (a warn-level row = warn, else ok); null = not known */
export function healthStates({ usage = null, rows = null } = {}) {
  const u = !usage || usage.billing?.type === 'api' ? null : usage.guard === 'STOP' || usage.rateOK === false ? 'bad' : usage.guard === 'ok' ? 'ok' : null;
  const of = types => (rows ? (rows.some(r => types.includes(r.type) && (r.severity === 'high' || r.severity === 'medium')) ? 'warn' : 'ok') : null);
  return { usage: u, slop: of(['code']), tests: of(['tests']), context: of(['instructions', 'memory', 'rules', 'docs']) };
}
/** a page's tone: its Norn colour, a Health state, or '' (neutral) */
export function navTone(id, health = {}) {
  const d = destOf(id)?.[0];
  if (d === 'health') return (id === 'health' ? worstState(health) : health[id]) ?? '';   // a page whose state is not known yet: neutral
  return PAGE_NORN[id] ?? DEST_NORN[d] ?? '';
}
const toneCls = t => (t ? ` class="tone-${t}"` : '');
export function renderNav(tab, counts = {}, health = {}) {
  const label = Object.fromEntries(TABS), cur = destOf(tab);
  const top = NAV.map(([g, name, ids]) => `<button role="tab" id="tab-${g}" data-tab="${g}" aria-selected="${cur?.[0] === g}"${ids.length ? ` aria-controls="pages-${g}"` : ''}${toneCls(navTone(g, health))}>${esc(name)}${countBadge([g, ...ids].reduce((n, k) => n + (counts[k] || 0), 0))}</button>`).join('');
  const pt = cur ? navTone(cur[0], health) : '';
  const pages = cur && cur[2].length ? `<div class="pages${pt ? ' tone-' + pt : ''}" id="pages-${cur[0]}" role="tablist" aria-label="${esc(cur[1])}">${cur[2].map(k => `<button role="tab" id="tab-${k}" data-tab="${k}" aria-selected="${k === tab}"${toneCls(navTone(k, health))}>${esc(label[k])}${countBadge(counts[k])}</button>`).join('')}</div>` : '';
  return `<div class="dests" role="tablist" aria-label="Sections">${top}</div>${pages}`;
}
// a picked art image (the asset map) - Norn look only, and only where the page passes its asset function (none in node)
const art = (ctx, name, cls = '') => (ctx.look === 'norn' && ctx.art ? ctx.art(name, cls) : '');

// ---------- data: one loader per tab over the S6 endpoints; get(path) -> JSON (throws on non-200) ----------
// the deliverables card is extra: a missing / failing /api/deliverables never breaks the tab
const dlvGet = (get, q) => Promise.resolve().then(() => get(`/api/deliverables?${q}`)).catch(() => null);
// META-TEND P6: the Guard rows for the chips in place (one project; a missing / failing /api/guard never breaks the tab)
const guardGet = (get, q, all) => (all ? Promise.resolve(null) : Promise.resolve().then(() => get(`/api/guard?${q}`)).catch(() => null));
// META-UX-BUILD S1 + S2: the ONE part loader. Instructions: its 5 parts of one view (project + its scan time), fetched in parallel after
// the summary paints. A sub-view tab (subviews.mjs): the chosen sub-view's part of one view (project + sig + sub + limit).
// META-UX-BUILD S3: Docs - the open file is its one part (&file=<key>) of one list (project + sig).
// META-UX-BUILD S4: Context (the Instructions view's cost half) - the parts its sub-view needs (contextParts), of one view (project + scan
// time + sub); its route stays /api/instructions (the Norn vocabulary rule: routes stay, labels and the URL tab move).
const PART_NAMES = { context: d => contextParts(d.sub), slop: d => [d.sub], docs: d => (d.file ? ['file'] : []) };
const PART_API = { context: 'instructions', slop: 'guard' };   // META-UX-BUILD S5: Slop (was Guard) keeps its route /api/guard
export const partsKey = (tab, project, d) => (tab === 'context' ? `${project}|${d.at}|${d.sub}` : tab === 'docs' ? `${project}|${d.sig}|${d.file}` : `${project}|${d.sig}|${d.sub}|${d.limit}|${d.batch ?? ''}`);
export async function loadParts(tab, project, d, get) {
  const q = `project=${encodeURIComponent(project)}`, lim = tab === 'docs' ? `&file=${encodeURIComponent(d.file)}` : d.limit && tab !== 'context' ? `&limit=${d.limit}${d.batch ? `&batch=${encodeURIComponent(d.batch)}` : ''}` : '';
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
  if (tab === 'home') return get(`/api/home?${q}`);   // META-CONTROLLER C2
  if (tab === 'overview') {
    const [overview, agents, records, ledger, deliverables] = await Promise.all([get(`/api/overview?${q}`), get(`/api/agents?${q}`),
      all ? null : get(`/api/records?${q}`), all ? null : get(`/api/ledger?${q}`), dlvGet(get, q)]);
    return { overview, agents, records, ledger, deliverables };
  }
  if (tab === 'inbox') { const [ib, deliverables] = await Promise.all([get(`/api/inbox?${q}`), dlvGet(get, q)]); return { ...ib, deliverables }; }
  if (tab === 'lanes') return get(`/api/lanes?${q}`);
  if (tab === 'map') return get(`/api/map?${q}${ctx.mapMore?.size ? `&more=${encodeURIComponent([...ctx.mapMore].join(','))}` : ''}${ctx.mapAll ? '&all=1' : ''}`);
  // UX review 2: the three destination pages - what needs a look under each, from the endpoints the pages already use
  if (tab === 'work') { const [overview, a] = await Promise.all([get(`/api/overview?${q}`), get(`/api/agents?${q}`)]); return { overview, queue: a.queue || [] }; }
  if (tab === 'health') { const [overview, slop] = await Promise.all([get(`/api/overview?${q}`), all ? null : Promise.resolve().then(() => get(`/api/guard?${q}&part=summary`)).catch(() => null)]); return { overview, slop }; }
  if (tab === 'history') return { records: await get(`/api/records?${q}`) };
  if (tab === 'runs') { const [a, o, guard] = await Promise.all([get(`/api/agents?${q}`), get(`/api/overview?${q}`), guardGet(get, q, all)]); return { ...a, top: o.burn.top, guard }; }
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
  if (tab === 'usage') return get(`/api/usage?${q}`);
  if (tab === 'tests') return get(`/api/tests?${q}`);   // META-TEND TESTS
  if (tab === 'slop') {   // META-TEND P6. META-UX-BUILD S2: the summary first, then the chosen sub-view's part. S5: Slop (was Guard); one open batch
    const sub = pickSub(GUARD_SUBS, ctx.sub);
    const d = { ...(await get(`/api/guard?${q}&part=summary`)), sub, limit: ctx.limit || SUB_CAP, ...(sub === 'fix' && ctx.batch ? { batch: ctx.batch } : {}) };
    const have = partsHave(ctx, 'slop', project, d);
    // META-UX-BUILD S6: the Fix all sheet, open (ctx.fixall) = its own part of the same view, fetched when it opens
    const sheet = ctx.fixall ? (await get(`/api/guard?${q}&part=sheet`)).sheet : null;
    return { ...d, ...(have || {}), parts_loading: !have, ...(sheet ? { sheet, sheet_sent: ctx.fixall.sent ?? null, sheet_sel: ctx.fixall } : {}) };
  }
  if (tab === 'plan') return get(`/api/plan?${q}`);
  throw new Error('unknown tab ' + tab);
}

// ---------- tabs ----------
export function renderTab(tab, d, ctx = {}) {
  if (tab === 'adopt') return panel(tab, renderAdopt(adoptStep(d, ctx.adoptAsk), d, ctx));
  if (d?.one) return oneProject(tab);
  const now = ctx.now ?? Date.now();
  if (tab === 'usage') return panel(tab, usage(d, { ...ctx, now }));
  if (tab === 'plan') return panel(tab, plan(d, { ...ctx, now }));
  if (tab === 'home') return panel(tab, renderHome(d, { ...ctx, now }));
  return panel(tab, ({ overview, inbox, work: workHub, lanes, runs, map, roadmap, health: healthHub, history: historyHub, records, docs, context, ledger, settings, tests, slop: guard })[tab](d, { ...ctx, now }));
}

// META-TEND TESTS (owner DIR-19 + DIR-47): lean tests, measured - count + suite time over time, the slowest, never-failing and
// duplicate tests with their mutant evidence, the last lean-tests wave before / after, the merge check's advisories
const sec = ms => (fin(ms) ? (ms >= 10000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`) : '-');
const shortT = t => String(t ?? '').replace(/^(\S+\.test\.mjs) :: /, '<span class="mute">$1</span> ');
const none = '<p class="mute" style="padding:0 12px">none measured</p>';
function testsHead(d, ctx, last, gl) {
  const ratio = gl ? (gl.test_lines / (gl.code_lines || 1)).toFixed(2) : null;
  const wall = [...(d.history || [])].reverse().find(x => fin(x.suite_ms));   // a merge check folds files in: no wall time of its own
  const what = last ? `${int(last.tests)} tests in ${int(last.files)} files · ${sec(last.file_ms)} of file time${wall ? ` · suite ${sec(wall.suite_ms)} wall (full measure)` : ''}` : 'per-test time: not measured yet';
  const when = last ? `measured ${esc(fmtTime(last.at, ctx.now))} at ${esc(last.sha ?? '?')} (<span class="mono">${esc(d.commands.measure)}</span>)`
    : `<span class="mono">${esc(d.commands.measure)}</span> measures a node:test suite (tests/*.test.mjs, run by ci-suite)`;
  const hist = d.git ? `history ${esc(fmtTime(d.git.at, ctx.now))} (<span class="mono">${esc(d.commands.history)}</span>)` : `tests vs code over git: <span class="mono">${esc(d.commands.history)}</span>`;
  return `<div class="card" id="tests-head"><b>${what}</b>${last?.coverage ? ` · line coverage <b>${pct(last.coverage.pct)}</b>` : ''}${gl ? ` · ${int(gl.tests)} test cases, ${int(gl.test_lines)} test lines vs ${int(gl.code_lines)} code lines (<b>${ratio}:1</b>)` : ''}
    <div class="small mute">${when} · ${hist}. Measured, never judged by a model; every finding is advisory.</div></div>`;
}
function testsOver(h, g, last, gl) {
  const col = (title, cur, body) => `<div><div class="small"><b>${title}</b> <span class="mute">${cur}</span></div>${body}</div>`;
  return `<div class="tablecard" id="tests-time"><h3>Over time <span class="mute small">per day: test cases and lines (git, first parent) · per measure or merge check: the summed file time</span></h3><div class="tgrid">
    ${col('test cases', gl ? `${int(gl.tests)} now` : '-', g.length ? columns(g.map(x => ({ label: x.day.slice(5), value: x.tests })), { fmt: int, title: 'test cases per day', id: 'tests-count', unit: 'tests', per: 'day' }) : '<p class="small mute">no history yet</p>')}
    ${col('suite file time', last ? `${sec(last.file_ms)} now` : '-', h.length ? columns(h.map(x => ({ label: String(x.at).slice(5, 10), value: x.file_ms })), { fmt: sec, title: 'suite file time per measure', id: 'tests-suite', per: 'measure' }) : '<p class="small mute">no measure yet</p>')}
    ${col('test lines per code line', gl ? `${(gl.test_lines / (gl.code_lines || 1)).toFixed(2)}:1 now` : '-', g.length ? columns(g.map(x => ({ label: x.day.slice(5), value: Math.round(100 * x.test_lines / (x.code_lines || 1)) / 100 })), { fmt: v => `${v}:1`, title: 'test lines per code line', id: 'tests-ratio', per: 'day' })
      + stack([{ key: 'tests', label: 'test lines', value: gl.test_lines }, { key: 'code', label: 'code lines', value: gl.code_lines }], { fmt: int }) : '')}</div></div>`;
}
function testsLean(lean, mx) {
  const files = mx?.files || [], never = lean?.never || [], dup = lean?.duplicates || [];
  const slow = lean?.slowest?.length ? `<div class="tablecard" id="tests-slow"><h3>Slowest ${int(lean.slowest.length)} <span class="mute small">per-test time, last measure · cause = what the test body does</span></h3><div style="padding:4px 12px">
    ${bars(lean.slowest.map(t => ({ label: `${t.file.replace(/^tests\//, '')} · ${t.name}`, value: t.ms, note: t.cause.map(c => chip(c === 'in-process work' ? 'idle' : 'prov', c)).join(' ') })), { fmt: sec, id: 'tests-slow-bars' })}</div></div>` : '';
  const mut = mx ? `<div class="tablecard" id="tests-mut"><h3>Mutation trial <span class="mute small">StrykerJS, outside the repo · a mutant = one planted bug; a test that fails on it kills it</span></h3><div class="inswrap"><table class="instab"><thead><tr><th>file</th><th>mutants</th><th>score</th><th class="insopt">survived</th><th class="insopt">test-process time</th></tr></thead><tbody>
    ${files.map(f => `<tr><td class="mono">${esc(f.file.split('/').pop())}</td><td class="num">${int(f.mutants)}</td><td class="num"><b>${pct(f.score)}</b>${meter(f.score, 100)}</td><td class="num insopt">${int(f.survived)}</td><td class="num insopt">${sec(f.ms)}</td></tr>`).join('')}</tbody></table></div></div>` : '';
  if (!lean) return slow + mut;
  const nv = `<div class="tablecard" id="tests-never"><h3>Never fail <span class="mute small">${int(never.length)} · ran against every mutant of ${esc(files.map(f => f.file.split('/').pop()).join(', ') || 'no file')} and killed none</span></h3>
    ${never.length ? `<ul class="tlist">${never.map(t => `<li>${chip('warn', 'kills 0')} ${shortT(esc(t.test))}${fin(t.ms) ? ` <span class="small mute">${sec(t.ms)}</span>` : ''}</li>`).join('')}</ul>` : none}</div>`;
  const dp = `<div class="tablecard" id="tests-dup"><h3>Duplicates <span class="mute small">${int(dup.length)} · every mutant it kills, another test kills too (equal sets: the slower one is listed)</span></h3>
    ${dup.length ? `<ul class="tlist">${dup.map(t => `<li>${chip(t.same ? 'warn' : 'idle', t.same ? 'same set' : 'subset')} ${shortT(esc(t.test))} <span class="small mute">kills ${int(t.kills)}${fin(t.ms) ? ` · ${sec(t.ms)}` : ''}</span><div class="small mute">inside: ${shortT(esc(t.within))}</div></li>`).join('')}</ul>` : none}
    <p class="small mute" style="padding:0 12px">The evidence covers the trial's files only: a listed test may still guard other code - the wave gate re-measures coverage and mutants before a cut stands.</p></div>`;
  return slow + mut + nv + dp;
}
function testsWave(w, ctx) {
  if (!w) return '';
  return `<div class="tablecard" id="tests-wave"><h3>Last lean-tests wave ${chip(w.ok ? 'ok' : 'bad', w.ok ? 'gate passed' : 'gate failed')}${w.restored?.length ? ` ${chip('warn', 'restored')}` : ''} <span class="mute small">${esc(fmtTime(w.at, ctx.now))} · ${esc(w.head)} vs ${esc(w.base)}</span></h3><div style="padding:4px 12px">
    ${bars([{ label: 'tests before', value: w.before.tests }, { label: 'tests after', value: w.after.tests }], { fmt: int, id: 'tests-wave-bars' })}
    <div class="small">coverage ${pct(w.before.cov?.pct)} -> <b>${pct(w.after.cov?.pct)}</b>${w.score ? ` · mutation score ${pct(w.score.before)} -> <b>${pct(w.score.after)}</b>` : ''} · changed files ${sec(w.ms_before)} -> <b>${sec(w.ms_after)}</b>${w.lost_lines ? ` · lost ${int(w.lost_lines)} line(s)` : ''}</div>
    <div class="small mute" style="margin-top:4px;overflow-wrap:anywhere">cut: ${w.removed.map(t => shortT(esc(t))).join(' · ') || 'nothing'}</div></div></div>`;
}
function tests(d, ctx) {
  const h = d.history || [], last = h.at(-1), g = d.git?.points || [], gl = g.at(-1), adv = d.advisories;
  const advCard = adv ? `<div class="tablecard" id="tests-adv"><h3>Last merge check <span class="mute small">${esc(adv.head)} vs ${esc(adv.base)} · ${int(adv.files.length)} changed test file(s) · advisory, never a merge block</span></h3>
    ${adv.list.length ? `<ul class="tlist">${adv.list.map(a => `<li>${chip(a.severity === 'medium' ? 'warn' : 'idle', a.key)}${a.new ? ` ${chip('open', 'new')}` : ''} <b>${esc(a.path ?? a.surface)}</b> ${esc(a.why)}<div class="small mute">${esc(a.fix.action)} · ${esc(a.id)}</div></li>`).join('')}</ul>` : '<p class="mute" style="padding:0 12px">no finding</p>'}</div>` : '';
  // a pytest (or any non node:test) project: say which parts can fill, instead of a page of "not measured yet" and a command that refuses
  const why = d.suite === false ? `<div class="banner" id="tests-scope">This project's tests are not a node:test suite (tests/*.test.mjs), so only <b>Over time</b> fills here: test cases and lines per day from git, refreshed once a day by the tick. Per-test time, the slowest tests, the merge check and lean tests read node:test suites only.</div>`
    : !g.length && !h.length ? `<div class="banner" id="tests-scope">Nothing measured yet. The tick fills <b>Over time</b> from git once a day; per-test time comes from <span class="mono">${esc(d.commands.measure)}</span> (a full suite run).</div>` : '';
  return why + (d.suite === false ? testsOver(h, g, last, gl) : testsHead(d, ctx, last, gl) + advCard + testsOver(h, g, last, gl) + testsLean(d.lean, d.mutation) + testsWave((d.waves || []).at(-1), ctx));
}

// OOTB-R2 N-5: runs held for a login (the command to type, the held runs, the failing line)
const loginRow = (i, ctx) => `<div class="item">${chip('needs', i.id)}<div><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}${i.cls === 'vendor' ? 'nothing to do - a vendor outage, not your login' : `open a terminal and run <span class="mono">${esc(i.command)}</span>`}; held: ${esc((i.runs || []).join(', '))} - they resume by themselves${i.line ? ` · "${esc(i.line)}"` : ''}</div></div></div>`;
// GAP-1 (lib/holds.mjs): ALL queued work held on one machine-level hold - what, since when, why in plain words and the fix (Settings /
// the command / Resume); it leaves by itself when the hold clears
const holdRow = (i, ctx) => `<div class="item" id="hold-${esc(i.project)}">${chip('bad', 'all held')}<div style="flex:1;min-width:0"><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}held ${fmtMin(i.minutes)} · ${esc((i.runs || []).join(', '))}</div>
  <div class="small">Fix: ${esc(i.fix)}${i.command ? ` <span class="mono">${esc(i.command)}</span>` : ''}${i.clears ? ` <span class="mute">- or it clears ${esc(i.clears)}</span>` : ''}</div></div>
  <span class="spacer"></span><div style="display:flex;gap:6px;flex-wrap:wrap">${i.setting ? `<button class="primary" data-tab="settings" title="${esc(i.setting)}">Open Settings</button>` : ''}${i.resume ? `<button class="primary" data-act="hold-resume" data-project="${esc(i.project)}">Resume</button>` : ''}</div></div>`;
// GAP-8 (lib/handedits.mjs): a generated file edited by hand is no longer regenerated - take it back (a .bak keeps the hand text) or keep it
// the words say what Norn saw and what each button does; a file that still carries Norn's GENERATED header was not written by a person
const editRow = (i, ctx) => `<div class="item" id="${esc(i.id)}">${chip('warn', 'changed outside Norn')}<div style="flex:1;min-width:0"><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}<span class="mono">${esc(i.file)}</span>${i.created ? ` · changed ${fmtMin(minsSince(i.created, ctx.now))} ago` : ''}</div>
  <div class="small">Norn writes this file itself, and its text no longer matches what Norn last wrote, so Norn leaves it alone rather than overwrite someone's edit.${i.generated ? ' It still carries Norn\'s GENERATED header, so it was most likely not edited by a person: take it back.' : ''}</div>
  <div class="small mute"><b>Let Norn take it back</b>: the current text is saved beside it as .bak and Norn updates the file again. <b>Keep my version</b>: Norn never updates this file again, until you take it back.</div></div>
  <span class="spacer"></span><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="primary" data-act="handedit" data-choice="takeback" data-project="${esc(i.project)}" data-file="${esc(i.file)}">Let Norn take it back</button><button class="ghost" data-act="handedit" data-choice="keep" data-project="${esc(i.project)}" data-file="${esc(i.file)}">Keep my version</button></div></div>`;
// META-TEND P4: one model-advice card - what, why (the measured numbers), the vendor source and the day it was read (stale = past the
// re-read date), the proposed Settings change and one tap: apply it, or keep the setting. Both write a decision record; nothing is automatic.
export function adviceRow(i, ctx) {
  const s = i.source || {}, ch = Object.entries(i.change || {}).map(([k, v]) => `${k} = ${v}`).join(', ');
  return `<div class="item advice" id="adv-${esc(i.key ?? i.id)}">${chip(i.severity === 'low' ? 'idle' : 'warn', 'advice')}<div style="flex:1;min-width:0"><b>${esc(i.title)}</b>
    <div class="small">${esc(i.text)}</div>
    <div class="small mute">${projTag(ctx, i.project)}source <b>${esc(s.ref ?? '-')}</b> ${esc(s.title ?? '')} · read <span class="mono">${esc(s.read ?? '-')}</span>${s.stale ? ' ' + chip('warn', 'stale: re-read it') : ` (${s.age_d ?? '-'} d ago)`}</div>
    <div class="small">Change: <span class="mono">${esc(ch)}</span> <span class="mute">- ${esc(i.trial ?? '')}</span></div></div>
    <span class="spacer"></span><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="primary" data-act="advice-apply" data-project="${esc(i.project)}" data-key="${esc(i.key ?? i.id)}">Apply</button><button class="ghost" data-act="advice-keep" data-project="${esc(i.project)}" data-key="${esc(i.key ?? i.id)}">Keep as is</button></div></div>`;
}
function needItem(i, ctx) {
  const ago = fmtMin(minsSince(i.created, ctx.now));
  if (i.type === 'question') {
    const rec = i.recommend ? (i.options || []).find(o => (o.key ?? o.k) === (i.recommend.key ?? i.recommend.k)) : null;
    return `<div class="item">${chip('open', i.id)}<div><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}${esc(i.lane ?? '-')} · asked ${ago} ago${i.class ? ` · class ${esc(i.class)}` : ''}</div>
      ${rec ? `<div class="small">Recommended <b>(${esc(rec.key ?? rec.k)})</b> ${esc(rec.text ?? rec.t)}</div>` : ''}</div><span class="spacer"></span><button class="primary" data-tab="inbox">Answer</button></div>`;
  }
  if (i.type === 'setup') return setupRow(i, ctx);
  if (i.type === 'login') return loginRow(i, ctx);
  if (i.type === 'hold') return holdRow(i, ctx);
  if (i.type === 'handedit') return editRow(i, ctx);
  if (i.type === 'parked') return `<div class="item">${chip('parked', i.id)}<div><b>lane ${esc(i.id.slice(2))} parked</b><div class="small mute">${projTag(ctx, i.project)}${i.q ? `by ${esc(i.q)}` : esc(i.why ?? 'no reason recorded')}</div></div></div>`;
  const [cls] = stateOf(i.state === 'exited' ? `exited: ${String(i.outcome).toUpperCase()}` : i.state);
  return `<div class="item">${chip(cls === 'idle' ? 'stopped' : cls, i.id)}<div><b>${esc(i.lane ?? 'run')} ${esc(String(i.outcome ?? i.state).toUpperCase())}${i.why ? `: ${esc(i.why)}` : ''}</b><div class="small mute">${projTag(ctx, i.project)}${aname(i.name)} unreviewed - no review event yet</div></div></div>`;
}

// META-ADOPT A3: ONE needs-you row while a drafted setup waits (Review / Not now = a close with the reason)
const setupRow = (i, ctx) => `<div class="item">${chip('open', i.id)}<div><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}drafted ${fmtMin(minsSince(i.created, ctx.now))} ago · nothing is applied before you approve it</div></div><span class="spacer"></span><button class="primary" data-act="adopt-review" data-project="${esc(i.project)}">Review</button><button data-act="adopt-notnow" data-project="${esc(i.project)}">Not now</button></div>`;
// META-ADOPT A3 (SPEC sec. 5): the setup gaps of one project - each names what is missing in one line and offers the next action
function setupGaps(g) {
  if (!g) return '';
  const p = esc(g.project), rows = [];
  const row = (what, text, acts) => rows.push(`<div class="item">${chip('warn', what)}<div><b>${text}</b><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${acts}</div></div></div>`);
  if (!g.roadmap) row('roadmap', 'No roadmap yet.', `<button data-act="adopt-open" data-project="${p}">Draft it from the repository</button><button class="ghost" data-tab="roadmap">Open the roadmap</button>`);
  if (!g.rules) row('rules', `No project rules yet. Workers follow the repo's own ${esc((g.agent_files || []).join(', ') || 'instruction files')}.`,
    `<button data-act="adopt-open" data-project="${p}">Draft them</button><button class="ghost" data-act="adopt-rule" data-project="${p}">Write one rule</button>`);
  const c = g.caps || {}, cap = (k, u) => (c[k] === null || c[k] === undefined ? `${u} unset (no limit)` : `${c[k]} ${u}`);
  if (!g.caps_chosen && !g.caps_kept) row('caps', `No caps profile is on record. Nobody chose them: the caps in force are ${cap('max_claude_workers', 'Claude workers')}, ${cap('max_codex', 'Codex runs')}, weekly stop ${cap('weekly_stop_pct', '%')}.`,
    `<button data-tab="settings">Choose a profile</button><button class="ghost" data-act="adopt-caps-keep" data-project="${p}">Keep the starter caps</button>`);
  if (!g.gate) row('merge gate', `Merges are not gated. ${g.found_gate ? `The scan found <span class="mono">${esc(g.found_gate)}</span>.` : 'No test command is on record.'}`,
    `<button data-act="adopt-open" data-project="${p}">Set it</button>`);
  return rows.length ? `<section class="card" id="setup-gaps" style="margin-bottom:12px"><h2>Set up ${p}</h2>${rows.join('')}</section>` : '';
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
// META-CTX-ENFORCE R1 (DIR-56): ONE context cell - the CURRENT context (last request) on a bar to the hard max, the tick = the hand-off
// line of the run's role; red past the hand-off line, a chip naming which line it passed; the peak beside it when it was higher
export function ctxMeter(n, { codexNote = false } = {}) {
  if (!fin(n.ctx)) return `<span class="small mute">${codexNote && String(n.executor ?? '').startsWith('codex') ? 'n/a (codex: tokens at end)' : '-'}</span>`;
  const lim = fin(n.ctx_limit) ? n.ctx_limit : null, hard = fin(n.ctx_hard) ? n.ctx_hard : null;
  const over = hard && n.ctx >= hard ? 'over' : lim && n.ctx >= lim ? 'hot' : '';
  const flag = over === 'over' ? ` ${chip('bad', 'past hard max')}` : over === 'hot' ? ` ${chip('bad', 'past hand-off')}` : '';
  const peak = fin(n.ctx_peak) && n.ctx_peak > n.ctx ? ` · peak ${kTok(n.ctx_peak)}` : '';
  return `<span class="ctxm${over ? ' ' + over : ''}">${meter(n.ctx, Math.max(hard ?? 150000, n.ctx), lim, over)}<span class="small mute">${kTok(n.ctx)} ctx${lim ? ` / hand-off ${kTok(lim)}` : ''}${hard ? ` · max ${kTok(hard)}` : ''}${peak}</span>${flag}</span>`;
}
// API billing (lib/billing.mjs): no weekly limit - the Burn card shows the last 24 h of spend against the daily $ cap instead
function apiBurn(b) {
  const $ = v => `$${(Number(v) || 0).toFixed(2)}`, cap = fin(b.cap) && b.cap > 0 ? b.cap : null, over = cap !== null && b.usd >= cap;
  const c = over ? chip('bad', 'daily cap reached: no new Claude work') : cap === null ? chip('warn', 'no daily cap') : chip('ok', 'under the daily cap');
  return `<div class="kv" id="burn-api"><span class="mute small">last 24 h</span><div><span class="big">${$(b.usd)}</span> <span class="mute">${cap === null ? 'spent' : `of the ${$(cap)} daily cap`}</span> ${c}${cap === null ? '' : meter(b.usd, cap, null, over || b.usd > cap * 0.8 ? 'hot' : '')}</div>
     <span class="mute small">runs</span><div class="small" id="burn-api-parts">${$(b.ended_usd ?? b.usd)} from ${plural(b.runs, 'Claude run')} ended in the last 24 h · ${$(b.live_usd)} running${b.live_runs ? ` (${plural(b.live_runs, 'run')}, estimate)` : ''}${b.chat_turns ? ` · ${$(b.chat_usd)} dashboard chats` : ''}</div>
     <span class="mute small">guard</span><div class="small mute">none weekly: API billing has no weekly limit${cap === null ? '. Set a daily cap in Settings (API daily cap) to stop spend past it' : ''}</div></div>`;
}
// RM-18 S2: the Overview strip in place of the hero (both looks): three real links, one per Norn in its time colour (norn.css .ostrip),
// each opening its destination - Urd History, Verdandi Work, Skuld Inbox (DEST_NORN)
export function overviewStrip(s, ctx = {}) {
  if (!s) return '';
  const q = ctx.project ? `?project=${encodeURIComponent(ctx.project)}&tab=` : '?tab=';
  const part = (tone, tab, name, facts) => `<a class="np tone-${tone}" id="strip-${tone}" href="${esc(q + tab)}" data-tab="${tab}"><b>${name}</b><span>${facts.join(' · ')}</span></a>`;
  const ll = s.last_landed, ck = s.checkin || {};
  const next = ctx.paused ? 'check-ins paused' : ck.next ? `next check-in ${esc(fmtTime(ck.next, ctx.now))}` : fin(ck.every_min) ? `check-in every ${int(ck.every_min)} min` : 'next check-in -';
  return `<nav class="ostrip" id="strip" aria-label="Was, is, shall be">${part('urd', 'history', 'Urd', [`${int(s.landed_today)} landed today`, ll ? `last ${esc(ll.lane ?? ll.run)} ${esc(fmtTime(ll.ts, ctx.now))}` : 'none landed yet'])}`
    + `${part('verd', 'work', 'Verdandi', [`${int(s.running)} running`, `${int(s.parked)} parked`])}`
    + `${part('skuld', 'inbox', 'Skuld', [`${plural(s.questions, 'open question')}`, `${int(s.queued)} queued`, next])}</nav>`;
}
function overview(d, ctx) {
  const o = d.overview, tree = d.agents?.tree || [], byId = Object.fromEntries(tree.map(n => [n.id, n]));
  const top = Object.fromEntries((o.burn.top || []).map(t => [t.id, t]));
  const needs = o.needs.length ? o.needs.map(i => needItem(i, ctx)).join('') : `<div class="item">${art(ctx, 'empty-nothing-needs-you', 'empty')}${chip('ok', 'all clear')}<span>Nothing needs you</span></div>`;
  // gap #9: API billing - the burn column is each running run's $ so far (a live estimate from its tokens; the end record has the CLI's figure)
  const apiB = o.burn.usage?.billing?.type === 'api' ? o.burn.usage.billing : null, liveUsd = new Map((apiB?.live || []).map(x => [`${x.project}|${x.id}`, x.usd]));
  const burnCell = l => { if (!apiB) return fin(top[l.run]?.pct_per_h) ? top[l.run].pct_per_h.toFixed(2) + ' %/h' : '-';
    const v = liveUsd.get(`${l.project}|${l.run}`); return fin(v) ? `~$${v.toFixed(2)}` : '-'; };
  const rows = o.running.lanes.map(l => {
    const n = byId[l.run] || {}, age = n.age_min, b = n.budget_min;
    const ageCell = fin(b) ? `${meter(age, b * 2, b, age > b ? 'hot' : '')}<div class="small mute">${fmtMin(age)} / budget ${b} min</div>` : `<div class="small mute">${fmtMin(age)} (no time budget)</div>`;
    const ctxCell = ctxMeter(n, { codexNote: true });
    return `<tr id="run-${esc(l.run)}"><td><b>${projTag(ctx, l.project)}${esc(l.name)}</b><div class="small mute"><span class="id">${esc(l.run)}</span>${aname(l.run_name ?? n.name)}${n.stage ? ' ' + esc(n.stage) : ''}</div>${hoChip(n.handoff ?? l.handoff, l.run)}</td>
      <td>${exChip(n.executor ?? l.executor, n.model, n.effort)}</td><td style="width:24%">${ageCell}</td><td style="width:22%">${ctxCell}</td>
      <td class="mono run-burn">${burnCell(l)}</td></tr>`;
  }).join('') || `<tr><td colspan="5" class="mute">${art(ctx, 'empty-no-runs', 'empty')}No lane is running.</td></tr>`;
  const u = o.burn.usage, used = u.weeklyUsed, stop = u.weeklyStopPct;
  const guardChip = u.guard === 'STOP' ? chip('bad', 'guard tripped: no new Claude worker') : u.guard === 'ok' ? chip('ok', 'under guard') : chip('idle', 'guard unknown');
  const rateChip = u.rateOK === false ? chip('bad', 'over cap: Claude dispatch off') : u.rateOK === true ? chip('ok', 'under cap') : '';
  const trip = fin(used) && fin(stop) && fin(u.rate) && u.rate > 0 && used < stop
    ? (() => { const h = (stop - used) / u.rate; return `in ~${h.toFixed(1)} h · <b>${esc(fmtLocal(new Date(ctx.now + h * 3600000).toISOString()))}</b>`; })()
    : fin(used) && fin(stop) && used >= stop ? '<b>tripped</b>' : '<span class="mute">- (no trailing rate)</span>';
  const provLine = (o.burn.executors || []).length ? `<div class="small mute" id="exec-usage" style="margin-top:8px">Own-account executors (7 days, not in burn): ${o.burn.executors.map(x => `<b>${esc(x.name)}</b> ${plural(x.runs, 'run')} ${mTok(x.tokens)} tok${x.cost_usd ? ` $${x.cost_usd.toFixed(2)}` : ''}`).join(' · ')}</div>` : '';
  const burners = (o.burn.top || []).map(t => `<div class="item"><span class="mono" style="width:76px">${fin(t.pct_per_h) ? t.pct_per_h.toFixed(2) + ' %/h' : mTok(t.burn30)}</span><span class="small"><span class="id">${esc(t.id)}</span> ${projTag(ctx, t.project)}${esc(t.lane ?? '')}</span></div>`).join('')
    || '<div class="small mute">no cache reads in the last 30 min</div>';
  const recs = d.records ? [...d.records.decisions, ...d.records.directives].sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, 5)
    .map(r => `<tr><td class="id">${esc(r.id)}</td><td>${chip(r.state)}</td><td>${r.kind === 'decision' ? `<b>${esc(r.data.lane ?? '')}</b> ${esc(r.data.question ?? '')}<div class="small mute">${esc(r.data.choice ?? '')}${r.data.why ? ' - ' + esc(r.data.why) : ''}</div>` : esc(r.data.text)}</td><td class="small mute">${esc(r.by)} ${fmtTime(r.updated, ctx.now)}</td></tr>`).join('') : '';
  const led = d.ledger ? ledgerRows(parseLedger(d.ledger.ledger).slice(-4), d.ledger, ctx, true) : '';
  const prof = o.setup?.profile_now ? `<p class="small" id="profile-now" style="margin:0 0 10px">Profile: <b>${esc(profileWords(o.setup.profile_now, ctx.now))}</b> <button class="ghost" data-tab="settings">Settings</button></p>` : '';
  return `${overviewStrip(o.strip, { ...ctx, paused: o.paused })}${firstTask(o.first_run)}${setupGaps(o.setup)}${prof}<div class="glance">
   <section class="card${o.needs_you ? ' needs' : ''}" id="needs"><h2>Needs you <b>${o.needs_you}</b></h2>${needs}</section>
   <section class="card" id="running"><h2>Running <b>${o.running.claude.n}/${o.running.claude.cap ?? '-'}</b> Claude · <b>${o.running.codex.n}/${o.running.codex.cap ?? '-'}</b> Codex</h2>
     <table><thead><tr><th>lane</th><th>executor</th><th>age vs time budget (mark = budget, end = 2x)</th><th>context</th><th>${apiB ? '<span title="spent so far: an estimate from its tokens at list price until the run ends">$ so far</span>' : 'burn'}</th></tr></thead><tbody>${rows}</tbody></table></section>
   <section class="card" id="burn"><h2>Burn${u.billing ? ` <span class="mute small" id="burn-billing">${esc(u.billing.label)}</span>` : ''}</h2>
     ${u.billing?.type === 'api' ? apiBurn(u.billing) : `<div class="kv"><span class="mute small">weekly</span><div><span class="big">${pct(used)}</span> <span class="mute">of ${pct(stop, 0)} guard</span> ${guardChip}${meter(used, 100, stop, fin(used) && fin(stop) && used > stop - 10 ? 'hot' : '')}</div>
     <span class="mute small">trailing 2 h</span><div><b>${fin(u.rate) ? u.rate.toFixed(2) + ' %/h' : '-'}</b> <span class="mute">vs cap ${fin(u.cap) ? u.cap.toFixed(2) + ' %/h' : '-'}</span> ${rateChip}</div>
     <span class="mute small">guard trips</span><div>${trip}</div>
     <span class="mute small">reset</span><div>${esc(fmtLocal(u.resetAt))}</div>
     <span class="mute small">source</span><div class="small mute">${esc(u.source)}${u.source === 'live' && u.estimate && fin(u.estimate.weekly) ? ` (estimate ${pct(u.estimate.weekly)})` : ''}</div></div>`}
     <h2 style="margin-top:14px">Top burners (last 30 min)</h2>${burners}${provLine}</section></div>
   ${d.deliverables ? deliverablesCard(d.deliverables, ctx) : ''}
   ${d.records ? `<div class="grid2"><div class="tablecard"><h3>Latest records <span class="mute small">newest first</span></h3><table><tbody>${recs || '<tr><td class="mute">no records yet</td></tr>'}</tbody></table></div>
   <div class="tablecard"><h3>Ledger <span class="mute small">last 4 entries, newest first</span></h3><table class="ledtab compact"><tbody>${led || '<tr><td class="mute">no ledger file</td></tr>'}</tbody></table></div></div>` : ''}`;
}

function inbox(d, ctx) {
  const items = d.items || [];
  const qs = items.filter(i => i.type === 'question').map(q => {
    const rk = q.recommend ? q.recommend.key ?? q.recommend.k : null, opts = q.options || [];
    return `<article class="q openq" id="q-${esc(q.id)}"><div style="display:flex;gap:10px;align-items:center">${chip('open', q.id + ' open')}<b style="font-size:15px">${esc(q.title)}</b><span class="spacer"></span><span class="small mute">${projTag(ctx, q.project)}${esc(q.lane ?? '-')} · ${fmtMin(minsSince(q.created, ctx.now))} ago${q.class ? ` · class ${esc(q.class)}` : ''}</span></div>
    ${q.body ? `<p style="margin:8px 0">${esc(q.body)}</p>` : ''}
    ${opts.length ? `<div class="opts">${opts.map(o => { const k = o.key ?? o.k; return `<div class="opt ${k === rk ? 'rec' : ''}"><b>(${esc(k)})</b> ${esc(o.text ?? o.t)}${o.cost ?? o.c ? `<div class="small mute">cost: ${esc(o.cost ?? o.c)}</div>` : ''}</div>`; }).join('')}</div>` : ''}
    ${rk ? `<p class="small" style="margin:8px 0 10px"><b>Recommendation (${esc(rk)}):</b> ${esc(q.recommend.why ?? '')}</p>` : ''}
    ${q.answered_by ? `<div class="card needs" style="margin:8px 0;padding:8px 10px"><span class="small">Possibly answered in <b class="mono">${esc(q.answered_by.id)}</b>${q.answered_by.words ? `: <q>${esc(q.answered_by.words)}</q>` : ` (${esc(q.answered_by.why ?? '')})`}</span>
      ${q.answered_by.words ? `<button class="primary" style="margin-left:8px" data-act="answer-from" data-project="${esc(q.project)}" data-id="${esc(q.id)}" data-from="${esc(q.answered_by.id)}">Yes - already answered in ${esc(q.answered_by.id)}</button>` : ''}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${opts.map(o => { const k = o.key ?? o.k; return `<button class="${k === rk ? 'primary' : ''}" data-act="answer" data-project="${esc(q.project)}" data-id="${esc(q.id)}" data-choice="${esc(k)}" data-text="${esc(`(${k}) ${o.text ?? o.t ?? ''}`)}">Choose (${esc(k)})${k === rk ? ' - recommended' : ''}</button>`; }).join('')}
    <input type="search" id="ans-${esc(q.id)}" placeholder="or answer in your words ..." style="flex:1;min-width:220px"><button data-act="answer-text" data-project="${esc(q.project)}" data-id="${esc(q.id)}">Send</button></div>
    <div class="small mute" style="margin-top:6px">Writes <span class="mono">answer ${esc(q.id)}</span> (by dashboard). The next tick applies it${q.lane ? ` and unparks ${esc(q.lane)}` : ''}.</div></article>`;
  }).join('') || `<div class="card" style="margin-bottom:12px">${art(ctx, 'empty-no-questions', 'empty')}${chip('ok', 'all clear')} <span>No open question.</span></div>`;
  const aud = items.filter(i => i.type === 'audit');
  const audCard = aud.length ? `<section class="tablecard" id="inbox-audit" style="margin-bottom:12px"><h3>Audit hunks <span class="mute small">${int(aud.length)} open · the vendor prompt audit proposed them; accept = the check-in applies it, decline = keep the text; Norn edits nothing</span></h3><ul>${aud.map(i => auditCard(i.card, i.project)).join('')}</ul></section>` : '';
  const fxCard = fxSection(items.filter(i => i.type === 'fixresult').map(i => [i.card, i.project]), 'inbox-fixer', 'tablecard');
  const enf = items.filter(i => i.type === 'enforce');
  const enfCard = enf.length ? `<section class="tablecard" id="inbox-enforce" style="margin-bottom:12px"><h3>Make it enforced? <span class="mute small">${int(enf.length)} correction(s) said again · approve = a directive asks the check-in for a brief; Norn installs nothing</span></h3><ul>${enf.map(i => enforceCard({ ...i.card, approve: i.approve }, i.project)).join('')}</ul></section>` : '';
  const dlvCard = (items.some(i => ['setup', 'login', 'hold', 'handedit'].includes(i.type)) ? `<section class="card needs" style="margin-bottom:12px">${items.filter(i => i.type === 'hold').map(i => holdRow(i, ctx)).join('')}${items.filter(i => i.type === 'login').map(i => loginRow(i, ctx)).join('')}${items.filter(i => i.type === 'handedit').map(i => editRow(i, ctx)).join('')}${items.filter(i => i.type === 'setup').map(i => setupRow(i, ctx)).join('')}</section>` : '')
    + (d.deliverables ? `<div style="margin-bottom:12px">${deliverablesCard(d.deliverables, ctx)}</div>` : '');
  const row = (i, st, what) => `<tr id="in-${esc(i.id)}"><td class="id">${esc(i.id)}</td><td>${st}</td><td>${projTag(ctx, i.project)}${what}</td></tr>`;
  const other = [
    ...items.filter(i => i.type === 'parked').map(i => row(i, chip('parked'), `lane <b>${esc(i.id.slice(2))}</b> ${i.q ? `parked by ${esc(i.q)}` : esc(i.why ?? '')}`)),
    ...items.filter(i => i.type === 'unreviewed').map(i => row(i, chip(stateOf(i.state === 'exited' ? `exited: ${String(i.outcome).toUpperCase()}` : i.state)[0], String(i.outcome ?? i.state).toUpperCase()),
      `<b>${esc(i.lane ?? '-')}</b> ${esc(i.why ?? '')}<div class="small mute">${aname(i.name)} unreviewed: ended with no review event</div>`)),
    ...items.filter(i => i.type === 'answered').map(i => row(i, chip('answered'), `${esc(i.title)}<div class="small mute">${esc(i.answer?.text ?? '')} · ${fmtTime(i.updated, ctx.now)} · waits for the next tick to apply</div>`)),
  ].join('');
  const adv = items.filter(i => i.type === 'advice');
  const advCard = adv.length ? `<section class="card" id="inbox-advice" style="margin-bottom:12px"><h2>Model advice <span class="mute small">${plural(adv.length, 'card')} · vendor guidance over what each kind of work cost (Usage tab) · nothing changes until you tap</span></h2>${adv.map(i => adviceRow(i, ctx)).join('')}</section>` : '';
  const nNeeds = needsYou(items), nInfo = items.length - nNeeds;   // UX review 4: the one needs-you count (terms.mjs)
  return `<h2 class="pagehead" id="inbox-needs">Needs you <b>${int(nNeeds)}</b>${nInfo ? ` <span class="mute small">+ ${int(nInfo)} for information (answered, waiting for the next check-in; model advice)</span>` : ''}</h2><div class="legend small mute">States: ${['open', 'answered', 'applied', 'superseded', 'withdrawn'].map(s => chip(s)).join(' ')} - set by explicit events only; this page never guesses.</div>${qs}${fxCard}${enfCard}${audCard}${dlvCard}${advCard}
   <div class="tablecard"><h3>Also needs a look <span class="mute small">parked lanes · unreviewed runs · answered, not yet applied</span></h3><table><thead><tr><th>id</th><th>state</th><th>what</th></tr></thead><tbody>${other || '<tr><td colspan="3" class="mute">nothing</td></tr>'}</tbody></table></div>`;
}

// GAP-12: a running lane whose changed files overlap upstream work (a remote branch or an open PR; overlap.mjs) - one small chip each,
// a PR one links to the PR; the shared files are its tooltip
const overlapWords = o => `overlaps upstream: ${o.kind === 'pr' ? `PR #${o.number}` : o.ref} (${o.n} file${o.n === 1 ? '' : 's'})`;
const overlapChip = o => {
  const files = o.files || [], tip = esc([...(o.kind === 'pr' ? [`${o.ref}: ${o.title ?? ''}`] : []), ...files, ...(o.n > files.length ? [`+${o.n - files.length} more`] : [])].join('\n'));
  return o.kind === 'pr' && /^https:\/\//.test(o.url || '') ? `<a class="chip warn" href="${esc(o.url)}" target="_blank" rel="noopener" title="${tip}">${esc(overlapWords(o))}</a>`
    : `<span class="chip warn" title="${tip}">${esc(overlapWords(o))}</span>`; };
// owner 2026-11-18: one chip per overlap stacked 2-3 lines under busy lanes and broke the table's rhythm - two or more fold into ONE
// summary chip that opens (a native <details>: keyboard and phone work, no script) to the same per-branch chips
const overlapChips = os => !(os || []).length ? '' : os.length === 1 ? `<div class="lane-overlap">${overlapChip(os[0])}</div>`
  : `<details class="lane-overlap"><summary class="chip warn" title="this lane's changed files overlap ${os.length} other branches / PRs">overlaps ${os.length} upstream: ${os.reduce((n, o) => n + (o.n || 0), 0)} files</summary><div class="lane-overlap-list">${os.map(overlapChip).join(' ')}</div></details>`;
// RM-19 S1: the Lanes filter chips (index.html keeps the pick in S.laneShow and the URL as &lanes=active,done); a row's chip from its
// lanesView group: Active = running + needs you + queued, Done recently / Old = done younger / older than policy.done_lanes.old_days
export const LANE_SHOW = [['active', 'Active'], ['done', 'Done recently'], ['old', 'Old'], ['archived', 'Archived']];
export const LANE_SHOW_DEFAULT = ['active', 'done'];
export const laneShowOf = l => l.group === 'archived' ? 'archived' : l.group === 'done' ? (l.old ? 'old' : 'done') : 'active';
export const laneKey = (project, lane) => `${project}:${lane}`;
export const laneAge = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
function lanes(d, ctx) {
  const show = new Set(ctx.laneShow ?? LANE_SHOW_DEFAULT), hide = ctx.archiving ?? new Set(), refused = ctx.laneRefused ?? {}, undo = ctx.laneUndo;
  const all = (d.lanes || []).filter(l => !hide.has(laneKey(l.project, l.name))), n = k => all.filter(l => laneShowOf(l) === k).length;
  const usd = all.some(l => l.usd);   // gap #9: API billing - each lane's $ to date (its runs; a running one counted live, an estimate)
  const usdCell = l => !usd ? '' : `<td class="mono lane-usd">${l.usd?.runs ? `${l.usd.live ? '~' : ''}$${l.usd.total.toFixed(2)}` : dash}</td>`;
  // a done lane says how long ago it ended; an old one reads stopped (its row is faded)
  const nowText = l => l.group !== 'done' || !l.ended ? l.text : `${l.old ? 'stopped' : l.text} · done ${laneAge(ctx.now - Date.parse(l.ended))} ago`;
  const rows = all.filter(l => show.has(laneShowOf(l))).map(l => {
    // the lane's run opens in the live feed drawer (as a Runs row does), not the supervisor's plain-text tail in a new browser tab
    const [cls, word] = stateOf(l.text), log = l.run ? `<button data-act="lane-feed" data-project="${esc(l.project)}" data-run="${esc(l.run)}" title="Open ${esc(l.run)} in the live feed">Feed</button>` : '';
    const act = cls === 'running' ? `${log} <button data-act="stop" data-project="${esc(l.project)}" data-run="${esc(l.run)}">Stop</button>`
      : l.state === 'parked' ? `<button data-tab="inbox">Open Q</button>` : l.state !== 'archived' ? `${log} <button class="ghost" data-act="archive" data-project="${esc(l.project)}" data-lane="${esc(l.name)}">Archive</button>` : log;
    const why = refused[laneKey(l.project, l.name)];   // a refused Archive keeps its reason here: S, not err(), so a live re-render keeps it
    return `<tr id="lane-${esc(l.name)}"${l.old ? ' class="old"' : ''}><td><b>${projTag(ctx, l.project)}${esc(l.name)}</b><div class="id">${esc(l.id)}</div>${overlapChips(l.overlap)}${why ? `<div class="lane-refused small">${esc(why)}</div>` : ''}</td><td>${chip(l.state)}</td><td>${chip(cls, word)}${hoChip(l.handoff, l.run)}</td>
      <td>${l.executor ? chip(exClass(l.executor), l.executor) : dash}</td><td>${esc(nowText(l))}</td><td><span class="id">${esc(l.run ?? '-')}</span>${l.run_name ? `<div>${aname(l.run_name)}</div>` : ''}</td>${usdCell(l)}<td><div class="rowacts">${act}</div></td></tr>`;
  }).join('') || `<tr><td colspan="${usd ? 8 : 7}" class="mute">${all.length ? 'No lanes under these filters.' : 'No LANE records.'}</td></tr>`;
  const chips = LANE_SHOW.map(([k, t]) => `<button class="hf" data-act="lane-show" data-show="${k}" aria-pressed="${show.has(k)}">${esc(t)} <b>${n(k)}</b></button>`).join('');
  return `<div class="banner">Lanes come from LANE records only (no folder scan); state = the latest run on the lane, whatever executor owns the tree.</div>
   ${undo ? `<div class="banner lane-undo" id="lane-undo">Archived ${esc(undo.lane)}. <button data-act="lane-undo" data-project="${esc(undo.project)}" data-lane="${esc(undo.lane)}">Undo</button></div>` : ''}
   <div class="filters"><input type="search" data-filter="lanes" placeholder="filter lanes"><span class="lane-show" role="group" aria-label="Show lanes">${chips}</span></div>
   <div class="tablecard"><table data-rows="lanes"><thead><tr><th>lane</th><th>record</th><th>run state</th><th>executor</th><th>now</th><th>latest run</th>${usd ? '<th title="every run of the lane; ~ = one is still running (an estimate)">$ to date</th>' : ''}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- UX review 2: Work, Health and History - one card per page under the destination: what it shows + what needs a look now ----------
const HUB_WHAT = { lanes: 'one row per lane: its latest run, state and outcome', runs: 'every running and recent run as a tree: tokens, context, its findings',
  map: 'lanes as threads, runs as beads on them', plan: 'what starts next and what it waits for, what lands next, the usage forecast',
  roadmap: 'themes and items, their status from the linked lanes, runs and records', usage: 'usage against the weekly guard and the hourly cap; what each kind of work cost',
  slop: 'every open finding of every check, in batches by the kind of fix', tests: 'suite time, the slowest tests, tests that never fail or duplicate others',
  context: 'what one agent session loads and what it costs, per role and per file', records: 'directives and decisions with their history',
  ledger: 'the project ledger, newest first', docs: "the project's docs and every file the agents read" };
function hub(dest, now) {
  const label = Object.fromEntries(TABS), [, , ids] = NAV.find(([g]) => g === dest);
  return `<div class="hub" id="${dest}-hub">${ids.map(k => `<section class="card hubcard" id="hub-${k}"><h2><button class="lnk" data-tab="${k}">${esc(label[k])}</button></h2>
    <p class="small mute">${esc(HUB_WHAT[k])}</p>${now[k] ? `<div class="small hubnow">${now[k]}</div>` : ''}</section>`).join('')}</div>`;
}
function workHub(d) {
  const o = d.overview, needs = o.needs || [], n = t => needs.filter(i => i.type === t).length, run = o.running;
  return hub('work', {
    lanes: `${chip(run.lanes.length ? 'running' : 'idle', `${int(run.lanes.length)} running`)}${n('parked') ? ' ' + chip('parked', `${int(n('parked'))} parked`) : ''}`,
    runs: `${chip(run.claude.n + run.codex.n ? 'running' : 'idle', `${int(run.claude.n)} Claude · ${int(run.codex.n)} Codex running`)}${n('unreviewed') ? ' ' + chip('warn', `${int(n('unreviewed'))} unreviewed`) : ''}`,
    plan: chip(d.queue.length ? 'idle' : 'ok', `${int(d.queue.length)} queued`) });
}
function healthHub(d) {
  const u = d.overview.burn.usage, s = d.slop;
  const use = u.billing?.type === 'api' ? chip('idle', 'API billing: see the daily cap') : u.guard === 'STOP' ? chip('bad', 'guard tripped: no new Claude worker')
    : fin(u.weeklyUsed) ? chip(u.guard === 'ok' ? 'ok' : 'idle', `${pct(u.weeklyUsed)} of the ${pct(u.weeklyStopPct, 0)} weekly guard`) : chip('idle', 'usage unknown');
  return hub('health', { usage: `${use}${u.rateOK === false ? ' ' + chip('bad', 'over the hourly cap') : ''}`,
    slop: s ? `${chip(s.total ? 'warn' : 'ok', plural(s.total ?? 0, 'open finding'))}${s.new ? ' ' + chip('needs', `${int(s.new)} new`) : ''}` : '' });
}
function historyHub(d) {
  const r = d.records, act = (r.directives || []).filter(x => x.state === 'active').length;
  return hub('history', { records: `${chip(act ? 'active' : 'idle', plural(act, 'active directive'))} ${chip('idle', plural((r.decisions || []).length, 'decision'))}` });
}

function runs(d, ctx) {
  const top = Object.fromEntries((d.top || []).map(t => [t.id, t]));
  const name = n => n.kind === 'subagent' ? `${esc(n.agentType ?? 'subagent')}${n.description ? ` "${esc(n.description)}"` : ''}`
    : n.kind === 'helper' ? `<span class="id">${esc(n.id)}</span>${aname(n.name)} helper${n.class ? ' · ' + esc(n.class) : ''}${n.q ? ` "${esc(n.q)}"` : ''}${n.outcome ? ' · ' + esc(String(n.outcome).toUpperCase()) : ''}`
    : `<span class="id">${esc(n.id)}</span>${aname(n.name)} ${esc(n.lane ?? '')}${n.stage ? ' · ' + esc(n.stage) : ''}${n.outcome ? ' · ' + esc(String(n.outcome).toUpperCase()) : ''}${n.helpers ? ` · helpers ${n.helpers.n}${n.helpers.running ? ` (${n.helpers.running} running)` : ''}, ${int(n.helpers.tokens)} tok` : ''}`;
  const tok = n => n.tokens === '-' ? '-' : fin(n.tokens) ? `${int(n.tokens)}${n.tokens_src ? ` (${esc(n.tokens_src)})` : ''}` : fin(n.cacheR) ? `${mTok(n.cacheR)} cacheR` : String(n.executor ?? '').startsWith('codex') ? 'at end' : '-';
  const age = n => fin(n.age_min) ? fmtMin(n.age_min) : n.first ? fmtMin(minsSince(n.first, ctx.now)) : n.started ? fmtMin(minsSince(n.started, ctx.now)) : '-';
  const one = (n, lvl, kids, pid) => {
    const b = top[n.id];
    const feed = /^RUN-\d+$/.test(n.id) ? ` data-feed="${esc(n.id)}" data-project="${esc(n.project)}" title="Open the live feed"` : '';
    return `<div class="node lvl${lvl}" id="node-${esc(n.id)}"${lvl ? ` data-p="${esc(pid)}"` : ''}${feed}><div class="name">${kids ? `<span class="caret" data-t="${esc(pid)}">&#9662;</span>` : '<span class="caret"></span>'}${chip(n.kind === 'subagent' ? 'idle' : exClass(n.executor), n.kind ?? 'run')}<span class="t">${projTag(ctx, n.project)}${name(n)}</span>${n.dod_ready || n.dod ? dodChips(n.dod_ready, n.dod) : ""}${critiqueChip(n.critique)}${(n.guard || []).map(g => `<span class="guard-chip" title="${esc(`${g.id}: ${g.why}`)}">${chip(g.state === 'ruled' ? 'idle' : g.cls === 'runaway' ? 'bad' : 'warn', `${g.cls}${g.action ? ': ' + g.action : ''}`)}</span>`).join('')}${guardChip(guardOn(d.guard, r => r.run === n.id), { tab: 'slop' })}</div>
     <div>${exChip(n.kind === 'subagent' ? null : n.executor, n.model, n.effort)}</div><div>${runChip(n.state)}</div><div class="small">${age(n)}</div><div class="mono small">${tok(n)}</div>
     <div>${fin(n.ctx) ? ctxMeter(n) : dash}</div><div class="mono small">${fin(b?.pct_per_h) ? b.pct_per_h.toFixed(2) + ' %/h' : fin(n.burn30) && n.burn30 > 0 ? mTok(n.burn30) + ' /30 min' : '-'}</div>${n.handoff ? `<div class="horow">${hoChip(n.handoff, n.id)}</div>` : ''}</div>`;
  };
  // META-CHECKIN-GUARDS R1: a move a guard refused in code, as a plain row under the run that tried it
  const refusedRows = n => (n.refused || []).map(x => `<div class="node lvl1 refusedrow" data-p="p-${esc(n.id)}"><div class="small" style="grid-column:1/-1">${chip('refused', `refused: ${x.words}`)} ${esc([x.lane, x.stage ?? x.answers].filter(Boolean).join(' '))} <span class="mute">${esc(String(x.ts ?? '').slice(11, 16))} - ${esc(x.why)}</span></div></div>`).join('');
  const tree = d.tree || [], rows = tree.map(n => one(n, 0, (n.children || []).length || (n.refused || []).length, 'p-' + n.id) + refusedRows(n) + (n.children || []).map(k => one(k, 1, false, 'p-' + n.id)).join('')).join('')
    || '<div class="node"><div class="mute">No running or recent (2 h) sessions.</div></div>';
  const by = k => tree.filter(n => exClass(n.executor) === k).length;
  return `<div class="legend small mute"><span>Tree = every run of the last 2 h (workers, check-ins, Codex, own-account executors), talk sessions and their subagents. Click a run for its live feed.</span>
    <span>Sources: RUN records + transcript <span class="mono">&lt;session&gt;.jsonl</span>, <span class="mono">subagents/agent-*.meta.json</span>, Codex log banner / rollout.</span></div>
   <div class="tree"><div class="node head"><div>session</div><div>model · effort</div><div>state</div><div>age</div><div>tokens</div><div>context now (tick = hand-off, bar end = hard max)</div><div>burn</div></div>${rows}</div>
   <p class="small mute">Sessions: Claude ${by('claude')} · Codex ${by('codex')} · own-account ${by('prov')}. Runs waiting to start: the Plan tab.</p>`;
}
// ---------- META-TEND P6: the Guard (REPORT s.5.0-5.1) - every open advisory across types, a query that owns no data ----------
// Chips in place: guardOn(guard, pick) = the rows of one owning thing; guardChip = ONE chip shape on every tab (severity colour, the
// count, a title with the worst line). The Guard page: SloppaChoppa's section (his portrait, his line, call him up, Mute), counts per
// type (bars), the trend (lines), the rule ledger (stack), and every row with the tab that fixes it.
export const guardOn = (g, pick) => (g?.rows || []).filter(pick);
export function guardChip(rows, go = null) {
  if (!rows?.length) return '';
  const cls = rows.some(r => r.severity === 'high') ? 'bad' : rows.some(r => r.severity === 'medium') ? 'warn' : 'idle';
  const t = `${rows.length} Slop finding${rows.length === 1 ? '' : 's'}`, title = esc(`${t}: ${rows[0].why}`);
  return go ? ` <button class="lnk gchip" ${goAttrs(go)} title="${title}">${chip(cls, t)}</button>` : ` <span class="gchip" title="${title}">${chip(cls, t)}</span>`;
}
/** a link to where a finding is fixed: data-go (the tab) + the tab's own target (a file + line, a doc, an element id) */
export const goAttrs = go => [`data-go="${esc(go.tab)}"`, go.sub ? `data-gosub="${esc(go.sub)}"` : '', go.ins ? `data-goins="${esc(go.ins)}"` : '', go.line ? `data-goline="${esc(go.line)}"` : '',
  go.doc !== undefined ? `data-godoc="${esc(go.doc)}"` : '', go.jump ? `data-gojump="${esc(go.jump)}"` : ''].filter(Boolean).join(' ');
const G_TAB = { context: 'Context', tests: 'Tests', usage: 'Usage', runs: 'Runs', docs: 'Docs', slop: 'Slop' };
const G_SEV = { high: 'bad', medium: 'warn', low: 'idle', count: 'idle' };
const shortPath = p => String(p).replace(/\\/g, '/').split('/').slice(-2).join('/');
const guardRow = (r, labels) => `<li class="grow" id="slop-${esc(r.id)}"><div>${chip(G_SEV[r.severity] ?? 'idle', r.severity)} ${chip('idle', labels[r.type] ?? r.type)}${r.new ? ' ' + chip('needs', 'new') : ''}
    <span>${esc(r.why)}</span></div><div class="small mute">${r.sent ? chip('prov', `sent ${esc(r.sent)}`) + ' ' : ''}${esc(r.surface ?? '')}${r.path ? ` · ${esc(shortPath(r.path))}${r.line ? ':' + esc(r.line) : ''}` : ''} <button class="lnk" ${goAttrs(r.go)}>fix in ${esc(G_TAB[r.go?.tab] ?? r.go?.tab)}</button></div>${r.apply ? `<details><summary class="small">patch (norn instructions apply ${esc(r.apply)})</summary>${typeof r.patch === 'string' ? `<pre class="inspatch">${esc(r.patch)}</pre>` : ''}</details>` : ''}</li>`;
// META-UX-BUILD S5 (REPORT s.2-3): To fix = ONE list in batches (check + the kind of fix the check declares), the kinds apart:
// ready (the exact text is known), to draft (a worker writes the text), your call (two ways), and the rows that only count (folded).
// A batch shows its first rows; "all n" opens it (one batch at a time, every row, capped + show more). The two ways are named here;
// picking one is the Fix all sheet (slice 6).
const bat = n => `${int(n)} batch${n === 1 ? '' : 'es'}`;
const KIND_HEAD = { ready: ['Ready', 'the exact new text is known'], drafts: ['To draft', 'the fix is one sentence; a worker writes the text'],
  call: ['Your call', 'two ways: you pick one'] };
function slopBatch(b, labels, open) {
  const paths = b.rows.filter(r => r.path).map(r => `${shortPath(r.path)}${r.line ? ':' + r.line : ''}`);
  const all = b.n > b.rows.length ? ` <button class="lnk" data-act="slop-batch" data-batch="${esc(b.key)}">all ${int(b.n)}</button>` : '';
  return `<li class="sbatch" id="slop-b-${esc(b.key.replace(/[^\w-]/g, '_'))}"><div><b>${esc(b.title)}</b> <span class="mute">× ${int(b.n)}</span> ${chip(G_SEV[b.severity] ?? 'idle', b.severity)}${b.new ? ' ' + chip('needs', `${int(b.new)} new`) : ''}</div>
    ${open ? '' : `<div class="small mute sbpaths">${esc(paths.join(' · '))}${b.n > paths.length && paths.length ? ` +${int(b.n - paths.length)}` : ''}</div>`}
    ${b.action ? `<div class="small"><i>fix: ${esc(b.action)}</i></div>` : ''}${b.ways ? `<div class="small sbways">${b.ways.map(w => chip('prov', w)).join(' ')}</div>` : ''}
    ${open ? `<ol class="glist">${b.rows.map(r => guardRow(r, labels)).join('')}</ol>${subMore(b.rows.length, b.n)} <button class="lnk" data-act="slop-batch" data-batch="">close</button>`
      : `<details class="sbrows"><summary class="small">the first ${int(b.rows.length)}</summary><ol class="glist">${b.rows.map(r => guardRow(r, labels)).join('')}</ol></details>${all}`}</li>`;
}
function slopFix(P, d, labels) {
  const of = k => P.batches.filter(b => b.kind === k), rows = k => of(k).reduce((n, b) => n + b.n, 0);
  const sec = k => !of(k).length ? '' : `<section class="card slopkind" id="slop-${k}" data-kind="${k}"><h2>${KIND_HEAD[k][0]} <span class="mute small">${int(rows(k))} · ${bat(of(k).length)} · ${KIND_HEAD[k][1]}</span></h2>
    <ul class="sblist">${of(k).map(b => slopBatch(b, labels, P.open === b.key)).join('')}</ul></section>`;
  const counts = of('count'), nc = rows('count');
  const fold = counts.length ? `<details class="small" id="slop-count"${P.open && counts.some(b => b.key === P.open) ? ' open' : ''}><summary>${plural(nc, 'more row')} only count something (${esc(counts.map(b => b.title).join(', '))}): nothing to fix</summary>
    <ul class="sblist">${counts.map(b => slopBatch(b, labels, P.open === b.key)).join('')}</ul></details>` : '';
  const empty = P.n ? '' : `<p class="mute">${chip('ok', 'all clear')} nothing open</p>`;
  const more = P.nb > P.batches.length ? subMore(P.batches.length, P.nb) : '';
  return `<div class="small mute" id="slop-fixhead">${plural(P.n, 'open finding')} in ${bat(P.nb)} by check and kind of fix · ${int(d.warn ?? 0)} at warn level or above</div>
    ${sec('ready')}${sec('drafts')}${sec('call')}${fold}${empty}${more}`;
}
// META-UX-BUILD S6 (REPORT s.3 "End to end" 1-2, DIR-65 Q2 A): the Fix all sheet - ready + to draft ticked, your call as its two ways
// (a pick adds it), the owner's own files offered unticked; Send the fixer (n) = one decision + one directive (POST /api/fixall). Nothing
// is edited and no run starts on this tap; the fixer's one result card (slice 7) is where a change lands, on Apply.
const FX_HEAD = { ready: 'Ready now · the exact text is known', drafts: 'The fixer drafts these', call: 'Your call · not included until you pick' };
function fixItem(i, sel) {
  const head = `<b>${esc(i.title)}</b> <span class="mute">× ${int(i.n)}</span> ${chip(G_SEV[i.severity] ?? 'idle', i.severity)}${i.new ? ' ' + chip('needs', `${int(i.new)} new`) : ''}${i.own ? ' ' + chip('parked', 'your own file: not ticked for you') : ''}`;
  const more = `<div class="small mute">${esc(i.paths.join(' · '))}${i.n > i.paths.length && i.paths.length ? ` +${int(i.n - i.paths.length)}` : ''}</div>${i.action ? `<div class="small"><i>fix: ${esc(i.action)}</i></div>` : ''}`;
  if (i.kind === 'call') return `<li class="fxitem fxcall"><div class="fxbody"><span class="fxq" aria-hidden="true">?</span> ${head}${more}</div>
    <div class="fxways">${i.ways.map(w => `<button class="ghost" data-act="fx-way" data-key="${esc(i.key)}" data-way="${esc(w)}" data-n="${i.n}" aria-pressed="${sel?.picks?.[i.key] === w}">${esc(w)}</button>`).join('')}</div></li>`;
  return `<li class="fxitem"><label class="fxbody"><input type="checkbox" data-fx-key="${esc(i.key)}" data-n="${i.n}"${(sel?.keys ? sel.keys.has(i.key) : i.tick) ? ' checked' : ''}> ${head}${more}</label></li>`;
}
// META-UX-BUILD S7 (REPORT s.3 step 4): the fixer's ONE result card per run - every file (Skip this file), every hunk as a diff, Apply all n
// (minus skipped files) / Discard = POST /api/fixresult (one decision + one directive: the audit accept path); the rest = a new tap.
// A run with no parsable hunk is failed: Discard only.
const fxDiff = p => `<pre class="fxdiff inspatch">${String(p ?? '').split('\n').map(l => { const c = /^[+](?![+][+])/.test(l) ? 'fxadd' : /^-(?!--)/.test(l) ? 'fxdel' : ''; return c ? `<span class="${c}">${esc(l)}</span>` : esc(l); }).join('\n')}</pre>`;
export function fixResultCard(c, project) {
  const pj = ` data-project="${esc(project)}" data-run="${esc(c.run)}"`, failed = c.state === 'failed', st = c.status || [];
  const count = ['drafted', 'skipped', 'missing'].map(k => [k, st.filter(x => x.state === k).length]).filter(([, n]) => n).map(([k, n]) => `${int(n)} ${k}`).join(' · ');
  const why = st.filter(x => x.state !== 'drafted'), fn = f => f.n ?? f.hunks.filter(h => h.applies !== false).length;
  const files = (c.files || []).map(f => `<div class="fxfile" data-file="${esc(f.file)}" data-n="${int(fn(f))}"><div class="fxfilehead"><span class="mono">${esc(f.file)}</span> <span class="small mute">${plural(f.hunks.length, 'hunk')}</span><span class="spacer"></span>${fn(f) ? `<button class="ghost" data-act="fx-skip" data-file="${esc(f.file)}"${pj} aria-pressed="false">Skip this file</button>` : ''}</div>
    ${f.hunks.map(h => `<div class="small mute">${esc(f.file)}${h.line ? ':' + esc(h.line) : ''}</div>${h.applies === false ? `<p class="small fxmisfit">${chip('bad', 'does not apply')} ${esc(h.why ?? '')} · not in Apply all; its finding stays open</p>` : ''}${fxDiff(h.patch)}`).join('')}</div>`).join('');
  const rest = c.more ? `<p class="small"><button class="lnk" data-act="fixall-rest" data-dir="${esc(c.directive)}" data-project="${esc(project)}">${int(c.left)} left: send the fixer for the rest (${plural(c.more, 'run')})</button></p>` : '';
  return `<li class="fxcard" id="fxcard-${esc(c.run)}"><div class="fxtop">${chip(failed ? 'bad' : 'needs', failed ? `failed: ${c.fail || 'no parsable hunk'}` : 'to apply')} <b>Fixer result ${esc(c.run)}</b> <span class="small mute">${esc(c.directive)} · ${esc(c.dec ?? '')} · ${plural(c.n, 'hunk')} in ${plural((c.files || []).length, 'file')}</span></div>
    ${count || c.bad ? `<p class="small">${[count, c.bad ? `${plural(c.bad, 'hunk')} ${c.bad === 1 ? 'does' : 'do'} not apply` : ''].filter(Boolean).join(' · ')}</p>` : ''}${why.length ? `<details><summary class="small">not drafted (${int(why.length)})</summary><ul class="small">${why.map(x => `<li><span class="mono">${esc(x.id)}</span> ${esc(x.state)}${x.why ? ': ' + esc(x.why) : ''}</li>`).join('')}</ul></details>` : ''}
    ${failed ? `<p class="small">${c.fail === 'no hunk applies' ? 'No hunk applies to the files as they are: nothing to apply. Discard it; the findings stay open.' : 'The run ended without one hunk in the audit format: nothing to apply. Discard it; the findings stay open.'}</p>${c.fail === 'no hunk applies' ? files : ''}` : files}
    <div class="fxbtns">${failed ? '' : `<button class="primary" data-act="fixresult" data-choice="apply"${pj}>Apply all <span class="fx-kept">${int(c.n)}</span></button> `}<button data-act="fixresult" data-choice="discard"${pj}>Discard</button></div>${rest}</li>`;
}
const fxSection = (cards, id, wrap) => (cards.length ? `<section class="${wrap}" id="${id}" style="margin-bottom:12px"><h3>Fixer results <span class="mute small">${plural(cards.length, 'run')} to decide · Apply = the check-in applies the hunks; Norn edits nothing</span></h3><ul class="fxres">${cards.map(([c, p]) => fixResultCard(c, p)).join('')}</ul></section>` : '');
// where a sent Fix all is (server.mjs fixSent: fixer.at); a failed run never reads "with the fixer"
function fixerWords(x) {
  const f = x.fixer || {}, run = esc(f.run ?? '');
  const w = { queued: [chip('prov', 'with the fixer'), `fixer ${run} queued`], running: [chip('prov', 'with the fixer'), `fixer ${run} running`], card: [chip('needs', 'to apply'), `${run} drafted: apply on its card`],
    failed: [chip('bad', 'failed'), `${run} failed: no parsable hunk (Discard it on its card)`], starting: [chip('prov', 'with the fixer'), 'the engine starts the fixer'], rest: [chip('needs', 'to send'), `${int(f.left)} left: send the fixer for the rest`] }[f.at];
  return w ? `${w[0]} ${esc(x.id)} + ${esc(x.directive)}: ${int(x.open)} finding(s), ${w[1]}` : `${chip('ok', 'sent')} ${esc(x.id)} + ${esc(x.directive)}: ${int(x.open)} finding(s)`;
}
function fixAll(sh, sent, sel = null) {
  const of = k => sh.items.filter(i => i.kind === k), n = k => of(k).reduce((a, i) => a + i.n, 0);
  const on = sh.items.reduce((a, i) => a + ((i.kind === 'call' ? sel?.picks?.[i.key] : sel?.keys ? sel.keys.has(i.key) : i.tick) ? i.n : 0), 0);
  const sec = k => (of(k).length ? `<h3 class="fxhead" id="fixall-${k}">${FX_HEAD[k]} <span class="mute small">${int(n(k))}</span></h3><ul class="fxlist">${of(k).map(i => fixItem(i, sel)).join('')}</ul>` : '');
  const done = sent ? `<p class="small" id="fixall-sent">${chip('ok', 'sent')} ${esc(sent.id)} + ${esc(sent.directive)}: ${int(sent.n)} finding(s)${sent.again ? ' (sent already: no second record)' : ''}. Nothing is edited; the check-in starts the one fixer run, and its card is where you apply.</p>` : '';
  return `<section class="card fixall" id="fixall"><h2>Fix all <span class="mute small">${int(sh.ticked)} ticked of ${int(n('ready') + n('drafts') + n('call'))} · nothing is edited when you tap</span></h2>
    <p class="small">The fixer drafts every change. You get <b>one card</b> with the exact text, and you apply it there.</p>
    ${sec('ready')}${sec('drafts')}${sec('call')}${sh.items.length ? '' : `<p class="mute">${chip('ok', 'all clear')} nothing to fix or decide</p>`}
    ${done}<div class="fxfoot"><span class="small mute" id="fixall-usage">${sh.usage?.batch ? `<b id="fx-runs" data-batch="${int(sh.usage.batch)}">${plural(Math.ceil(on / sh.usage.batch), 'fixer run')}</b> of at most ${int(sh.usage.batch)} findings ${esc(sh.usage.run ?? '')}` : esc(sh.usage?.line ?? '')}</span><span class="fxbtns"><button class="ghost" data-act="fixall-close">${sent ? 'Close' : 'Cancel'}</button>
    <button class="strong" data-act="fixall-send" data-sig="${esc(sh.sig)}"${sent || !on ? ' disabled' : ''}>Send the fixer (<span id="fx-n">${int(on)}</span>)</button></span></div></section>`;
}
// META-UX-BUILD S2: the page = his section, then the sub-view pattern (subviews.mjs): 4 numbers, To fix / Per type / Rules / Is it
// growing?, the chosen part. d = the summary (guardparts.mjs) + d[d.sub] once its part is here (parts_loading until then).
// META-UX-BUILD S5 (DIR-64): the tab is Slop (the route /api/guard stays); the numbers are open + the three kinds of fix.
function guard(d, ctx) {
  const fresh = d.new || 0, total = d.total ?? 0, labels = d.labels || {}, K = d.kinds || {};
  const portrait = ctx.look === 'norn' && ctx.art ? '<span class="orc-portrait" aria-hidden="true"></span>' : '';
  const voice = d.voice || {}, pop = voice.popups ?? 'off', on = d.slop !== false;
  const offer = d.offer ?? (K.ready ?? 0) + (K.drafts ?? 0) + (K.call ?? 0), sentL = d.sent || [];
  const fixBtn = offer ? `<button class="primary" data-act="fixall-open" id="slop-fixall">Fix all (${int(d.fixable ?? 0)})</button> ` : '';
  // findings already sent (an active Fix all directive): said here, so a Send is not lost when the tab is left; Fix all leaves them out
  const sentLine = sentL.length ? `<div class="small" id="slop-sent">${sentL.map(fixerWords).join(' · ')}. The engine starts the fixer by code; its card is where you apply. ${offer ? 'Fix all offers only the rest.' : 'Nothing else to send.'}</div>` : '';
  const cards = fxSection((d.fixcards || []).map(c => [c, d.project]), 'slop-fixcards', 'card');
  // META-BETA-PREP (DIR-52): SloppaChoppa off for the project = a plain list with a plain count badge, no orc, no pop-up line
  const plain = `<section class="card" id="slop-plain"><h2>Slop ${chip(fresh ? 'warn' : 'ok', fresh ? `${int(fresh)} new` : 'nothing new')}</h2>
    <p class="small mute">Code checks at run end, their merge hold and pop-ups are off for this project · <button class="lnk" data-tab="settings">Settings</button> (Slop voice) turns them back on; code findings show again from the next check.</p>${fixBtn ? `<div>${fixBtn}</div>` : ''}${sentLine}</section>`;
  // UX review 5: ONE status line (the compact portrait, his line, the new-findings chip) + ONE primary action (Fix all); calling him up,
  // muting and the pop-up settings sit in a small "More" menu. A sent Fix all stays in view (a line under it) so a Send is never lost.
  const him = !on ? plain : `<section class="card orc-section" id="slop-orc">${portrait}<div class="orc-head"><p class="orc-line" id="slop-line"><b>SloppaChoppa</b> ${esc(orcLine({ rows: d.top || [], total, fresh, pending: d.pending }))}</p>
    <div class="small orc-acts">${chip(fresh ? 'warn' : 'ok', fresh ? badgeLabel(fresh).replace(/^SloppaChoppa: /, '') : 'nothing new')}
     ${fixBtn}<details class="kmenu" id="slop-menu"><summary class="ghost">More</summary><div class="kpop"><button data-act="orc-call">Call him up</button><button class="ghost" data-act="orc-mute" data-days="1">Mute 1 day</button><button class="ghost" data-act="orc-mute" data-days="7">Mute 7 days</button><button class="ghost" data-act="orc-mute" data-days="0" id="slop-unmute">Unmute</button>
     <div class="small mute" id="slop-popups">Pop-ups: <b>${esc(pop)}</b>${pop === 'off' ? ' (they ship off until the owner review on 2026-11-21, DIR-36)' : ''} · at most ${esc(voice.daily_cap ?? 3)} a day · only a new finding at warn level or above, once each · <button class="lnk" data-tab="settings">Settings</button>. Muted = silent, not blind: findings are still recorded.</div></div></details></div>
    ${sentLine}</div></section>`;
  const about = `<p class="small mute" id="slop-about">Slop: every open finding of every check (instruction files, memory, rules, docs, tests, models, the lint's hints and the tightening candidates${on ? ", and SloppaChoppa's code checks" : ''}) in one list, in batches by check and the kind of fix the check declares. It owns no data: each row is fixed on the tab that owns the thing, where it also shows as a chip. Only a NEW finding warns.${d.pending ? ' The instruction-file scan is running: its rows follow.' : ''}</p>`;
  const P = d[d.sub];
  const body = !P ? '' : d.sub === 'fix' ? `<div id="slop-rows">${slopFix(P, d, labels)}${about}</div>`
    : d.sub === 'types' ? `<section class="card" id="slop-count-types"><h2>Open per type <span class="mute small">${plural(total, 'open finding')} · ${fresh} new at warn level</span></h2>${bars(P.rows.map(t => ({ label: t.label, value: t.open, cls: t.warn ? 'hot' : '',
      note: `${t.warn ? chip('warn', `${t.warn} warn`) : chip('ok', 'no warning')}${t.new ? ' ' + chip('needs', `${t.new} new`) : ''} <button class="lnk" ${goAttrs({ tab: t.tab })}>fix in ${esc(G_TAB[t.tab] ?? t.tab)}</button>` })), { id: 'slop-types', fmt: n => `${n} open` })}</section>`
    : d.sub === 'rules' ? `<section class="card" id="slop-ledger-card"><h2>The rule ledger <span class="mute small">every must / never rule by how it is enforced</span></h2>${P.ledger ? `${stack([['prose', 'prose only'], ['repeated', 'repeated'], ['enforced', 'enforced'], ['retired', 'retired']].map(([key, label]) => ({ key: 'rl-' + key, label, value: P.ledger[key] ?? 0 })), { id: 'slop-ledger' })}
    <div class="small">${chip(P.ledger.prose ? 'warn' : 'ok', `${P.ledger.prose ?? 0} prose only`)} rules that no hook, test or gate enforces · <button class="lnk" ${goAttrs({ tab: 'context', sub: 'checks', jump: 'ins-ladder' })}>the ladder (Context › checks)</button></div>` : '<p class="small mute">The rule ledger is not scanned yet.</p>'}
    <h3>Open rule findings <span class="mute small">${int(P.n)}</span></h3><ol class="glist" id="slop-rule-rows">${P.rows.map(r => guardRow(r, labels)).join('') || `<li class="mute">${chip('ok', 'all clear')} no rule finding open</li>`}</ol>${subMore(P.rows.length, P.n)}</section>`
    : `<section class="card" id="slop-trend-card"><h2>Open findings by age <span class="mute small">the findings open now, per type, counted from the day each was first seen · last ${int(P.trend?.days?.length ?? 30)} days</span></h2>
    <p class="small mute" id="slop-trend-note">Each line climbs on the day a finding still open today was first seen. Fixed findings are not in it, so it is not the open count over time: a flat line means nothing still open is that old.</p>${P.trend?.series?.length ? lines(P.trend.series, { days: P.trend.days, id: 'slop-trend', title: 'findings open now, by the day first seen', unit: 'findings' }) : '<p class="small mute">No open finding.</p>'}</section>`;
  const numbers = [{ n: int(total), label: `open · ${int(fresh)} new${K.count ? ` · ${int(K.count)} only count` : ''}`, cls: fresh ? 'warn' : '' }, { n: int(K.ready ?? 0), label: 'ready: the text is known', cls: K.ready ? 'ok' : '' },
    { n: int(K.drafts ?? 0), label: 'to draft: a worker writes it' }, { n: int(K.call ?? 0), label: 'your call: two ways' }];
  if (d.sheet) return fixAll(d.sheet, d.sheet_sent, d.sheet_sel);
  return `${(d.errors || []).length ? `<div class="small mute" id="slop-errors">${d.errors.map(esc).join(' · ')}</div>` : ''}
   ${him}${cards}
   ${subviewPage('slop', { numbers, views: GUARD_SUBS.map(([k, label]) => [k, label, d.counts?.[k]]), active: d.sub, body, loading: d.parts_loading || !P })}`;
}

// ---------- the Plan tab (META-PLAN R1, norn DIR-13): what happens next, and when - /api/plan = engine/lib/plan.mjs per project ----------
// Up next (the queue in fill order, hold-ups in plain words; it moved here from Agents), Chains (one line per dependency chain), Landing
// next (heading to main), Forecast (usage now vs the cap and the weekly stop). Status shapes: check / play / ring / pause / stop / !
// (text + colour, as every chip).
const PL_SHAPE = { check: ['done', '✓'], play: ['running', '▶'], ring: ['idle', '○'], pause: ['parked', '‖'], stop: ['stopped', '■'], '!': ['needs', '!'] };
const PL_STATUS = { ready: ['ok', 'ready'], waiting: ['idle', 'waiting'], held: ['parked', 'held'], offered: ['idle', 'offered'], ruling: ['needs', 'needs a ruling'] };
// R2: one day-aware clock, the same as engine/lib/plan.mjs dayClock ("today 21:41", "Fri 02:13", farther "Fri 11-20 02:13"), drawn here in
// the VIEWER's zone from the model's ISO times (named once at the top of the tab)
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dayClock(ms, now = Date.now()) {
  const p = n => String(n).padStart(2, '0'), d = new Date(ms), n = new Date(now), hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const mid = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(), days = Math.round(Math.abs(mid(d) - mid(n)) / 86400000);
  return days === 0 ? `today ${hm}` : days < 7 ? `${DAY_NAMES[d.getDay()]} ${hm}` : `${DAY_NAMES[d.getDay()]} ${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}
const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local time'; } catch { return 'your local time'; } };
const plAt = (iso, now) => (Number.isFinite(Date.parse(iso ?? '')) ? dayClock(Date.parse(iso), now) : null);
// one shape per step: the glyph is the classic look's; the norn look draws its status token instead (norn.css hides .pl-g)
const plShape = (cls, g, word) => `<span class="chip ${esc(cls)}" aria-label="${esc(word)}"><span class="pl-g" aria-hidden="true">${esc(g)}</span></span>`;
const plSection = (id, title, note, body) => `<div class="tablecard pl-sec" id="${id}"><h3>${esc(title)} <span class="mute small">${esc(note)}</span></h3>${body}</div>`;
const plEmpty = t => `<p class="pl-empty mute">${esc(t)}</p>`;
const plBasis = e => (e.basis === 'history' ? `median of ${e.n} finished runs` : e.basis === 'budget' ? 'its time budget' : 'no basis');
function planPart(p, ctx) {
  const now = ctx.now ?? Date.now(), head = ctx.project === 'all' ? `<h2 class="pl-proj">${esc(p.project)}</h2>` : '';
  if (p.pending) return `${head}<div class="card pl-sec"><p class="mute">Working out the plan for ${esc(p.project)} ...</p></div>`;
  if (p.error) return `${head}<div class="card pl-sec"><p class="mute">The plan could not be worked out: ${esc(p.error)}</p></div>`;
  const up = (p.upnext || []).map(u => {
    const [c, w] = PL_STATUS[u.status] ?? ['idle', u.status];
    return `<div class="pl-row" id="pl-${esc(u.id)}"><span class="mono pl-pos">#${esc(u.position)}</span><span class="pl-what"><b>${esc(u.label)}</b> <span class="id">${esc(u.id)}</span>${aname(u.name)}</span>
      ${chip(c, w)}<span class="small pl-est" title="${esc(plBasis(u.estimate))}">${esc(u.estimate.word)}</span><span class="small pl-start"${u.start.why ? ` title="${esc(u.start.why)}"` : ''}>start ${esc(u.start.at && u.start.word !== 'now' ? `~${plAt(u.start.at, now)}` : u.start.word)}</span>
      <span class="pl-holds small">${u.holds.map((h, i) => esc(u.holdAt?.[i] ? `not before ${plAt(u.holdAt[i], now)}` : h)).join('<br>')}</span></div>`;
  }).join('');
  const step = st => {
    const [cls, g] = PL_SHAPE[st.shape] ?? PL_SHAPE.ring;
    return `<span class="pl-step s-${st.shape === '!' ? 'bang' : esc(st.shape)}" title="${esc(`${st.id}${st.now ? ` (now ${st.now})` : ''}: ${st.word}`)}">${plShape(cls, g, st.word)} ${esc(st.label)}</span>`;
  };
  const chains = (p.chains || []).map(c => `<div class="pl-chain">${c.steps.map(step).join('<span class="pl-sep mute">›</span>')}
    <div class="small pl-meta">${c.broken ? `${plShape('needs', '!', 'broken')} <b>${esc(c.broken)}</b>` : c.finished ? esc(`finished ${plAt(c.finish.at, now) ?? ''}`) : `finish ${esc(c.finish.at ? `~${plAt(c.finish.at, now)}${c.finish.note ? ` ${c.finish.note}` : ''}` : c.finish.word)}`}${c.rm ? ` · ${chip('idle', c.rm.id)} ${esc(c.rm.title)}` : ''}</div></div>`).join('');
  const landCls = w => (/^blocked/.test(w) ? 'bad' : w === 'merging now' ? 'running' : w === 'ready to merge' ? 'ok' : 'idle');
  const land = (p.landing || []).map((l, i) => `<div class="pl-row"><span class="mono pl-pos">${i + 1}.</span><span class="pl-what"><b>${esc(l.label)}</b> <span class="id">${esc(l.id)}</span>${l.what ? ` <span class="small mute">${esc(l.what)}</span>` : ''}</span>${chip(landCls(l.word), l.word)}</div>`).join('');
  const f = p.forecast || {};
  const fc = f.api ? `<div class="pl-fc" id="pl-fc-api"><p><b>${esc(f.line)}</b><br><span class="small mute">API billing: no weekly limit to run out of.</span></p></div>`
    : !fin(f.weekly) ? `${plEmpty('Usage not measured yet.')}` : `<div class="pl-fc"><div class="kv">
    <span class="small mute">rate now</span><span>${meter(f.rate, Math.max(f.cap ?? 0, f.rate ?? 0) || 1, f.cap, f.over ? 'hot' : '')} <span class="small">${pct(f.rate, 2)}/h of the ${pct(f.cap, 1)}/h cap</span></span>
    <span class="small mute">this week</span><span>${meter(f.weekly, 100, f.stop, fin(f.stop) && f.weekly >= f.stop ? 'hot' : '')} <span class="small">~${pct(f.weekly)}${fin(f.stop) ? ` of the ${pct(f.stop, 0)} stop` : ''}</span></span>
    <span class="small mute">reset</span><span class="small">${f.reset ? esc(plAt(f.reset, now)) : '-'}</span></div>
    <p><b>${esc(f.lineAt ? `${f.linePre}${plAt(f.lineAt, now)}${f.linePost}` : f.line)}</b>${f.costLine ? `<br><span class="small">${esc(f.costLine)}</span>` : ''}</p></div>`;
  return `${head}${plSection('pl-up', 'Up next', 'every queued run, in the order it will start', up || plEmpty('Nothing is waiting to start.'))}
    ${plSection('pl-chains', 'Chains', 'runs that wait for other runs', chains || plEmpty('No queued run waits for another run.'))}
    ${plSection('pl-land', 'Landing next', 'heading to main, in merge order', land || plEmpty(`Nothing is heading to main.${p.landing_error ? ` (${p.landing_error})` : ''}`))}
    ${plSection('pl-fc', 'Forecast', 'usage', fc)}<p class="small mute pl-method">${esc(p.method ?? '')}</p>`;
}
function plan(d, ctx) {
  const parts = d.parts || [];
  return `<div class="plan"><p class="small mute pl-zone">times in ${esc(viewerZone())}</p>${parts.map(p => planPart(p, ctx)).join('') || '<p class="mute">No project.</p>'}</div>`;
}

// ---------- Map (LANE-MAP-DESIGN 1): the server's graph + layout drawn as inline SVG; pan = scroll, zoom = 3 fixed steps ----------
export const ZOOMS = [0.75, 1, 1.25];
const cut = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const MAP_LEGEND = [['owns', 'lane -> run'], ['resumes', 'HANDOFF -> next run (dashed)'], ['delegates', 'run -> helper / subagent'],
  ['dispatched', 'check-in started it'], ['reviewed', 'check-in reviewed it'], ['asks', 'open question parks the lane']];
function edgePath(a, b, kind) {
  const ya = a.y + a.h / 2, yb = b.y + b.h / 2;
  if (a.x === b.x && kind === 'resumes') { const x = a.x, k = 18 + Math.min(30, Math.abs(yb - ya) / 8); return `M${x} ${ya} C${x - k} ${ya} ${x - k} ${yb} ${x} ${yb}`; }
  if (a.x === b.x) { const x = a.x + a.w, k = 14 + Math.min(44, Math.abs(yb - ya) / 12); return `M${x} ${ya} C${x + k} ${ya} ${x + k} ${yb} ${x} ${yb}`; }
  const x1 = a.x + a.w, x2 = b.x, m = (x1 + x2) / 2;
  return `M${x1} ${ya} C${m} ${ya} ${m} ${yb} ${x2} ${yb}`;
}
function mapNode(n, project) {
  if (n.critique) n = { ...n, sub: `${n.id} · ${critiqueWord(n.critique)[1]}` };   // META-DOD 3: a plan run shows its review
  // the live hand-off state (lanes.mjs handoffOf): its words take the sub line, a pulsing dot sits before them
  const ho = n.handoff?.text ? `<circle class="pulse ho-${n.handoff.phase === 'resumed' ? 'resumed' : 'pending'}" cx="18" cy="${n.h - (n.h < 46 ? 11 : 16)}" r="4"/>` : '';
  if (ho) n = { ...n, sub: n.handoff.short ?? n.handoff.text, hoX: 26, hoTip: n.handoff.text };
  const small = n.h < 46, feed = n.feed ? ` data-feed="${esc(n.feed)}" data-project="${esc(project)}" role="button" tabindex="0"` : '';
  const tip = [n.label, n.hoTip ?? n.sub, n.word, n.feed ? 'click: live feed' : ''].filter(Boolean).join(' · ');
  const more = n.type === 'lane' && (n.more > 0 || n.expanded)
    ? `<text class="more" x="12" y="${n.h + 14}" data-act="map-more" data-lane="${esc(n.lane)}">${n.expanded ? `${n.capped ? 'latest 30 · ' : ''}show last 3` : `+${n.more} more`}</text>` : '';
  const room = Math.max(6, Math.floor((n.w - 30 - String(n.word ?? '').length * 7) / 7.6)); // label chars beside the state word
  return `<g class="mn t-${n.type} c-${esc(n.cls)}${n.faded ? ' faded' : ''}${n.needs ? ' needs' : ''}" id="mn-${esc(n.id)}" transform="translate(${n.x} ${n.y})"${feed}><title>${esc(tip)}</title>
    <rect class="box" width="${n.w}" height="${n.h}" rx="8"/><rect class="st" width="5" height="${n.h}" rx="2"/>
    <text class="nl" x="14" y="${small ? 16 : 22}">${esc(cut(n.label, Math.min(room, small ? 22 : 24)))}</text><text class="nw" x="${n.w - 10}" y="${small ? 16 : 22}" text-anchor="end">${esc(n.word)}</text>
    ${ho}<text class="ns${ho ? ' ho-w' : ''}" x="${n.hoX ?? 14}" y="${n.h - (small ? 8 : 12)}">${esc(cut(n.sub, 40))}</text>${more}</g>`;
}
// ---------- Map in the Norn look (META-VISUAL-B S2): the Well (default) or the Tapestry (the dense view) - a three.js stage the
// page mounts into #map-host (norn/mapview.mjs), live from the state stream. This is only its frame: view switch, archived-lanes
// toggle, zoom, legend. The classic look keeps the SVG map below. ----------
export const MAP_VIEWS = [['well', 'The Well'], ['tapestry', 'The Tapestry']];
const MAP_STATES = [['running', 'running'], ['done', 'DONE'], ['handoff', 'HANDOFF'], ['stopped', 'STOPPED'], ['parked', 'parked'], ['needs', 'needs you'], ['idle', 'idle']];
function nornMap(d, ctx) {
  const view = MAP_VIEWS.some(v => v[0] === ctx.mapView) ? ctx.mapView : 'well', nz = ctx.nornZoom || 1;
  const views = MAP_VIEWS.map(([k, w]) => `<button data-act="map-view" data-view="${k}" aria-pressed="${k === view}"${k === view ? ' class="strong"' : ''}>${w}</button>`).join('');
  const zoom = [1, 1.5, 2].map(z => `<button data-act="map-nz" data-z="${z}" aria-pressed="${z === nz}"${z === nz ? ' class="strong"' : ''}>${z}x</button>`).join('');
  const lanes = (d.nodes || []).filter(n => n.type === 'lane' && n.lane !== 'checkin').length;
  const say = view === 'well' ? 'Every lane is a thread spun from the Well of Urd to its stake (running lanes face you); runs are beads, the newest by the well; the Norns hold the check-ins.'
    : 'Every lane is a weft row, its runs are knots along it (the newest at the right edge); the band of the Norns holds the check-ins.';
  return `<div class="filters"><span class="small mute">${say} Click a bead or its label for the live feed.</span>
    <span class="spacer"></span><span class="views" role="group" aria-label="Map view">${views}</span><label class="small"><input type="checkbox" data-act="map-all"${ctx.mapAll ? ' checked' : ''}> done / archived lanes</label><span class="zoom">${zoom}</span></div>
   <div class="norn-map" data-view="${view}" role="img" aria-label="${esc(MAP_VIEWS.find(v => v[0] === view)[1])}: ${lanes} lanes"><div class="map-host" id="map-host"></div><div class="map-hud small" id="map-hud"></div></div>
   <div class="legend small">${MAP_STATES.map(([c, w]) => chip(c, w)).join(' ')} <span class="mute">· pulse + motes = a record from the run · shuttle = dispatch / review / delegation · a bright thread = its run just acted</span></div>`;
}
function map(d, ctx) {
  if (ctx.look === 'norn') return nornMap(d, ctx);
  const z = ZOOMS.includes(ctx.mapZoom) ? ctx.mapZoom : 1, N = Object.fromEntries((d.nodes || []).map(n => [n.id, n]));
  const bands = (d.bands || []).map((b, i) => `<rect class="band${i % 2 ? ' alt' : ''}" x="0" y="${b.y}" width="${d.width}" height="${b.h}" rx="6"/>`).join('');
  const edges = (d.edges || []).filter(e => N[e.from] && N[e.to]).map(e => `<path class="me e-${e.kind}" d="${edgePath(N[e.from], N[e.to], e.kind)}" marker-end="url(#arr)"><title>${esc(`${e.word}: ${e.from} -> ${e.to}`)}</title></path>`).join('');
  const nodes = (d.nodes || []).map(n => mapNode(n, d.project)).join('');
  const pills = (d.bands || []).map(b => dlvPill(b, d.project)).join('');
  const zoom = ZOOMS.map(v => `<button data-act="map-zoom" data-z="${v}"${v === z ? ' class="strong" aria-pressed="true"' : ''}>${Math.round(v * 100)} %</button>`).join('');
  const legend = MAP_LEGEND.map(([k, w]) => `<span><svg width="34" height="10" aria-hidden="true"><path class="me e-${k}" d="M2 5 L32 5"/></svg> <b>${k}</b> ${esc(w)}</span>`).join('');
  const states = [['running', 'running'], ['done', 'DONE'], ['handoff', 'HANDOFF'], ['stopped', 'STOPPED'], ['parked', 'parked'], ['needs', 'needs you'], ['idle', 'idle']].map(([c, w]) => chip(c, w)).join(' ');
  return `<div class="filters"><span class="small mute">Lanes as bands (running > parked > idle), the controller's check-ins on top; last 3 runs per lane (latest large). Click a run, helper or check-in for its live feed.</span>
    <span class="spacer"></span><label class="small"><input type="checkbox" data-act="map-all"${ctx.mapAll ? ' checked' : ''}> done / archived lanes</label><span class="zoom">${zoom}</span></div>
   <div class="mapwrap"><svg class="map" xmlns="http://www.w3.org/2000/svg" width="${Math.round(d.width * z)}" height="${Math.round(d.height * z)}" viewBox="0 0 ${d.width} ${d.height}" role="img" aria-label="Lane to agent map">
    <defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>${bands}${edges}${nodes}${pills}</svg></div>
   <div class="legend small mute">${legend}</div><div class="legend small">${states}</div>`;
}

// ---------- deliverables (DELIVERABLES-SPEC 3): "Done, not installed" card (Overview + Inbox), the drawer, the Map band pill ----------
const DLV_WORD = { done: 'DONE', merged: 'merged', installed: 'installed' };
const dlvChip = r => r.record_state === 'parked'
  ? chip('parked', `parked ${Math.floor(r.park?.days ?? 0)} d${r.park?.expired ? ' (expired)' : ''}`)
  : chip(r.state === 'done' ? 'warn' : r.state === 'merged' ? 'running' : 'ok', DLV_WORD[r.state] ?? r.state);
const dlvNative = r => (r.native === true ? chip('bad', 'native') : r.native === false ? '<span class="small mute">no</span>' : '<span class="small mute">?</span>');
export function deliverablesCard(dl, ctx = {}) {
  const rows = (dl?.rows || []).filter(r => !r.at_target).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  const body = rows.map(r => `<tr id="dlv-${esc(r.id)}"><td><b>${projTag(ctx, r.project)}${esc(r.branch)}</b><div class="small mute"><span class="id">${esc(r.id)}</span> ${esc(r.lane ?? '')}</div></td>
    <td>${esc(cut(r.delivers, 90))}${r.park ? `<div class="small mute">${esc(r.park.why)}</div>` : ''}</td>
    <td class="mono">${fin(r.days) ? r.days.toFixed(1) + ' d' : '-'}</td>
    <td class="mono">${fin(r.behind) ? r.behind + ' behind' : r.state === 'done' ? '-' : 'on main'}</td>
    <td>${dlvNative(r)}</td>
    <td>${dlvChip(r)}${r.due ? ' ' + chip('open', 'question due') : r.asked ? ` <span class="small mute">asked ${esc(r.asked)}</span>` : ''}</td>
    <td><button data-dlv="${esc(r.id)}" data-project="${esc(r.project)}">Open</button></td></tr>`).join('');
  if (dl?.pending && !rows.length) return `<section class="card" id="deliverables"><h2>Done, not installed <b>-</b></h2><div class="small mute">reading git and the install receipts ... (the next refresh shows them)</div></section>`;
  return `<section class="card" id="deliverables"><h2>Done, not installed <b>${rows.length}</b> <span class="mute small">oldest first · state from git + the last install receipt</span></h2>
   ${dl?.error ? `<div class="small" style="color:var(--bad)">${esc(dl.error)}</div>` : ''}
   ${rows.length ? `<table><thead><tr><th>branch</th><th>delivers</th><th>done</th><th>vs main</th><th>native</th><th>state</th><th></th></tr></thead><tbody>${body}</tbody></table>`
    : `<div class="item">${art(ctx, 'empty-all-delivered', 'empty')}${chip('ok', 'all clear')}<span>Nothing done-not-installed</span></div>`}</section>`;
}
export function renderDeliverable(r, ctx = {}) {
  if (!r) return '<div class="small mute">deliverable not found (refresh the page)</div>';
  const reached = { done: 1, merged: 2, installed: 3 }[r.state] ?? 0;
  const steps = ['done', 'merged', 'installed'].map((s, i) => chip(i < reached ? 'ok' : 'idle', s.toUpperCase())).join(' <span class="mute">&rarr;</span> ');
  const kv = (k, v) => `<span class="mute small">${esc(k)}</span><div>${v}</div>`;
  const nat = r.native === null ? '<span class="mute">unknown (no native globs for this repo)</span>' : r.native
    ? `${chip('bad', 'native')}<div class="mono small">${(r.native_files || []).map(esc).join('<br>')}</div>` : 'no native code';
  return `<div class="dlvd"><h3 style="margin:10px 0 4px"><span class="id">${esc(r.id)}</span> ${esc(r.branch)}</h3><div class="small" style="margin-bottom:8px">${esc(r.delivers ?? '')}</div>
   <div style="margin:6px 0 12px">${steps} <span class="small mute">target ${esc(r.target)}${r.at_target ? ' · reached' : ''}</span></div>
   <div class="kv">${kv('repo', `<span class="mono small">${esc(r.repo)}</span>`)}${kv('tip', `<span class="mono">${esc(String(r.tip ?? '-').slice(0, 9))}</span>${r.branch_exists === false ? ' <span class="small mute">(branch gone: the tip recorded at DONE)</span>' : ''}`)}
   ${kv('lane / run', `${esc(r.lane ?? '-')} · ${esc(r.run ?? '-')}`)}${kv('done', `${esc(fmtTime(r.done_utc, ctx.now ?? Date.now()))} · ${fin(r.days) ? r.days.toFixed(1) + ' d ago' : '-'}`)}
   ${kv('vs main', fin(r.behind) ? `${r.behind} behind · ${r.ahead ?? '?'} ahead` : r.state === 'done' ? '-' : 'on main')}${kv('native', nat)}
   ${r.rehearsal ? kv('merge rehearsal', r.rehearsal.clean ? chip('ok', 'clean') : `${chip('bad', 'conflict')}<div class="mono small">${r.rehearsal.files.map(esc).join('<br>')}</div>`) : ''}
   ${kv('park', r.park ? `${chip('parked', `parked ${Math.floor(r.park.days)} d`)} ${esc(r.park.why)} <span class="small mute">by ${esc(r.park.by ?? '-')}${r.park.expired ? ' · expired: back on the list' : ''}</span>` : '<span class="mute">not parked</span>')}
   ${kv('question', r.asked ? `<a href="#" data-rid="${esc(r.asked)}">${esc(r.asked)}</a> (one per deliverable)` : r.due ? chip('open', 'question due: the next check-in asks') : '<span class="mute">none</span>')}</div>
   <h3 style="margin:14px 0 4px">Move it</h3><div class="mono small" style="white-space:pre-wrap">norn deliverables park ${esc(r.id)} --why "&lt;the owner's reason&gt;"
norn deliverables unpark ${esc(r.id)}
norn deliverables ask ${esc(r.id)}      (the check-in: one question per deliverable)${r.resolve ? `
norn deliverables resolve ${esc(r.id)}  (${esc(r.resolve.why)}; native = door work)` : ''}</div>
   <div class="small mute" style="margin-top:8px">DONE / MERGED / INSTALLED come from git and the last install receipt - nobody types them.</div></div>`;
}
function dlvPill(b, project) {
  const r = b.deliverables?.[0];
  if (!r) return '';
  const word = r.record_state === 'parked' ? 'parked' : r.state;
  const txt = `${r.id} ${word} ${fin(r.days) ? r.days.toFixed(1) + ' d' : ''}${fin(r.behind) ? ` · ${r.behind} behind` : ''}${r.native ? ' · native' : ''}${b.deliverables.length > 1 ? ` · +${b.deliverables.length - 1}` : ''}`;
  const tip = `${r.branch}: ${word}${r.park_why ? ` (${r.park_why})` : ''}${r.due ? ' · question due' : ''} · click: open the deliverable`;
  return `<g class="dlv ${esc(r.state)}${r.record_state === 'parked' ? ' parked' : ''}${r.due ? ' due' : ''}" data-dlv="${esc(r.id)}" data-project="${esc(r.project ?? project)}" role="button" tabindex="0" transform="translate(16 ${b.y + b.h - 32})"><title>${esc(tip)}</title>
    <rect width="${Math.min(260, 16 + txt.length * 6.6).toFixed(0)}" height="20" rx="10"/><text x="9" y="14">${esc(txt)}</text></g>`;
}

// ---------- live feed drawer (LANE-MAP-DESIGN 2): head + one line per normalised event; index.html streams /api/feed into it ----------
const OUTCOME = { done: 'DONE', stopped: 'STOPPED', handoff: 'HANDOFF' };
const MARK = { DONE: 'done', STOPPED: 'stopped', HANDOFF: 'handoff' };
export function renderFeedHead(h, now = Date.now()) {
  const st = h.state === 'exited' ? `exited: ${OUTCOME[h.outcome] ?? h.outcome ?? 'no-result'}` : h.state;
  const [cls, word] = stateOf(st);
  const over = fin(h.elapsed_min) && fin(h.budget_min) && h.elapsed_min > h.budget_min;
  const c = h.commit;
  return `<div class="fh-top"><b class="aname">${esc(h.name ?? h.run)}</b><span class="id">${esc(h.run)}</span>${h.lane ? `<span class="tag">${esc(h.lane)}</span>` : ''}${chip(cls, word)}${h.marker ? chip(MARK[h.marker] ?? 'idle', h.marker) : ''}</div>${h.handoff ? `<div class="fh-ho">${hoChip(h.handoff, h.run)}</div>` : ''}
   <div class="fh-ex">${exChip(h.executor, h.model, h.effort)}${h.role === 'helper' ? ' <span class="tag">helper</span>' : ''}</div>
   <div class="kv small fh-kv"><span class="mute">elapsed</span><span>${fmtMin(h.elapsed_min)}${fin(h.budget_min) ? ` of ${fmtMin(h.budget_min)} budget` : ''}${fin(h.budget_min) ? meter(h.elapsed_min, Math.max(h.budget_min, h.elapsed_min ?? 0), h.budget_min, over ? 'over' : '') : ''}</span>
   <span class="mute">context</span><span>${fin(h.ctx) ? ctxMeter(h) : kTok(h.ctx)}${fin(h.ctx_window) ? ` <span class="small mute">(window ${kTok(h.ctx_window)})</span>` : ''}</span>
   <span class="mute">last commit</span><span>${c ? `<span class="mono">${esc(c.sha)}</span> ${esc(c.subject)} <span class="mute">${fmtMin(c.age_min)} ago</span>` : dash}</span></div>`;
}
const hms = ts => { const t = Date.parse(ts ?? ''); return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 19) : ''; };
const FEED_KINDS = ['tool', 'text', 'step', 'marker', 'error'];
export function renderFeedEvent(e) {
  const k = FEED_KINDS.includes(e.kind) ? e.kind : 'text';
  return `<div class="fl k-${k}"${k === 'tool' && e.id ? ` data-tid="${esc(e.id)}"` : ''}><span class="ts">${hms(e.ts)}</span><span class="fk">${esc(k === 'tool' ? e.name ?? 'tool' : k)}</span><span class="fs">${esc(e.summary)}</span><span class="dur"></span></div>`;
}

function history(r, ctx) {
  return `<details><summary class="small mute">history (${(r.history || []).length})</summary><div class="small mono">${(r.history || []).map(h => `${esc(h.seq)} ${fmtTime(h.ts, ctx.now)} ${esc(h.ev)} by ${esc(h.by)}${h.data?.text && h.ev !== 'create' ? ': ' + esc(h.data.text) : ''}`).join('<br>')}</div></details>`;
}
// RECORDS-TEXT R1: a text cell = the ledger-style blocks (ledger.mjs recordBlocks); over ~3 lines it clamps behind a "more" button
// (index.html drops the button when the text fits); the full text stays in the DOM, so the search filter matches all of it
function recText(key, parts) {
  const lines = parts.reduce((n, p) => n + p.lines, 0), long = lines > 3;
  return `<div class="rtext${long ? ' rclamp' : ''}" data-key="${esc(key)}">${parts.map(p => p.html).join('')}</div>${long ? '<button type="button" class="ghost rmore" data-act="rec-more" aria-expanded="false">more</button>' : ''}`;
}
function records(d, ctx) {
  const o = { project: ctx.project }, blk = (t, cpl) => recordBlocks(t, { ...o, cpl });
  const why = r => { if (!r.data.why) return { html: '', lines: 0 }; const b = blk(r.data.why, 50); return { html: `<div class="rwhy small mute">${b.html}</div>`, lines: b.lines }; };
  // META-UX-BUILD S6: a Fix all record (decision + directive) carries the finding ids it was sent with - folded under the text
  const fids = r => (Array.isArray(r.data.findings) && r.data.findings.length ? `<details class="small recids"><summary>${int(r.data.findings.length)} finding ids${r.data.fixall ? ` · ${esc(r.data.fixall)}` : ''}</summary><span class="mono">${esc(r.data.findings.join(' '))}</span></details>` : '');
  const dir = d.directives.map(r => `<tr id="rec-${esc(r.id)}" data-state="${esc(r.state)}"><td class="id rnw">${esc(r.id)}</td><td>${chip(r.state)}</td><td class="rt">${recText(`${r.id}:text`, [blk(r.data.text, 110)])}${fids(r)}${r.superseded_by ? `<div class="small mute">superseded by ${esc(r.superseded_by)}</div>` : ''}${history(r, ctx)}</td>
    <td class="small mute rnw">${fmtTime(r.created, ctx.now)} · ${esc(r.data.via ?? r.by)}</td><td>${r.state === 'active' ? `<button class="ghost" data-act="revoke" data-project="${esc(d.project)}" data-id="${esc(r.id)}">Revoke</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="5" class="mute">no directives</td></tr>';
  const dec = d.decisions.map(r => `<tr id="rec-${esc(r.id)}" data-state="${esc(r.state)}"><td class="id rnw">${esc(r.id)}</td><td>${chip(r.state)}${r.data.fyi ? ' ' + chip('needs', 'FYI') : ''}</td><td>${esc(r.data.lane ?? '-')}</td><td class="rt" data-label="question">${recText(`${r.id}:q`, [blk(r.data.question, 50)])}</td>
    <td class="rt" data-label="choice + why">${recText(`${r.id}:c`, [blk(r.data.choice, 50), why(r)])}${history(r, ctx)}</td><td class="small mute rnw">${esc(r.by)} · ${fmtTime(r.created, ctx.now)}</td><td class="small mute">${esc(r.data.source ?? '-')}</td>
    <td>${r.state === 'in-force' ? `<button class="ghost" data-act="overrule" data-project="${esc(d.project)}" data-id="${esc(r.id)}">Overrule</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="8" class="mute">no decisions</td></tr>';
  const active = d.directives.filter(r => r.state === 'active').length;
  return `<div class="filters"><input type="search" data-filter="records" placeholder="search id, lane, text  (e.g. DEC-1, relief)"><select data-filter-state="records"><option value="">all states</option><option value="in-force active">in force / active</option><option value="superseded overruled revoked done">ended</option></select>
    <span class="small mute">${d.decisions.length} decisions · ${d.directives.length} directives (${active} active)</span></div>
   <div class="tablecard"><h3>Directives <span class="mute small">only active ones bind the check-in</span><span class="spacer"></span><button class="strong" data-act="directive" data-project="${esc(d.project)}">Add directive</button></h3><table class="rectab" data-rows="records"><thead><tr><th>id</th><th>state</th><th>text</th><th>when · via</th><th></th></tr></thead><tbody>${dir}</tbody></table></div>
   <div class="tablecard"><h3>Decisions</h3><table class="rectab" data-rows="records"><thead><tr><th>id</th><th>state</th><th>lane</th><th>question</th><th>choice + why</th><th>by</th><th>source</th><th></th></tr></thead><tbody>${dec}</tbody></table></div>`;
}

// META-UX-BUILD S3 (REPORT s.2): Docs = the one reader. A side list of every file the agents read + the project's own docs, grouped by
// who loads it (docparts.mjs; each group capped, "show more"); the Memory group is headed by its gauge. The open file is its own part:
// Rendered (each paragraph with its age badge and its findings beside it) or Source (each finding beside its line). A wide screen shows
// list + reader; a phone shows the list, a tap opens the reader with Back (index.html: the file is in the URL, &doc=).
function docs(d, ctx) {
  const now = ctx.now ?? Date.now(), sel = d.doc?.key ?? d.file;
  const wait = d.pending ? `<div class="small" id="docs-pending" style="margin:0 0 6px">${chip('run', 'refreshing')} <span class="mute">the first scan of the instruction files is running: they join this list when it lands</span></div>`
    : d.error ? `<div class="small" style="margin:0 0 6px">${chip('bad', 'scan failed')} <span class="mute">${esc(d.error)}</span></div>` : '';
  const row = r => `<li><button class="docfile${r.key === sel ? ' sel' : ''}" id="docf-${esc(r.key)}" data-docfile="${esc(r.key)}" aria-current="${r.key === sel}" title="${esc(r.path)}"${r.exists ? '' : ' disabled'}>
    <span class="dfname">${esc(r.name)}${r.note ? ` <span class="mute small">(${esc(r.note)})</span>` : ''}${r.linked === 0 ? ` ${chip('warn', 'in no index')}` : ''}${r.exists ? '' : ` ${chip('bad', 'missing')}`}</span>
    ${r.findings ? `<span class="gchip" title="${esc(`${r.findings} finding${r.findings === 1 ? '' : 's'} on this file`)}">${chip('warn', `${int(r.findings)} finding${r.findings === 1 ? '' : 's'}`)}</span>` : ''}<span class="mute small dftk">${r.tokens === null || r.tokens === undefined ? '' : tk(r.tokens)}</span></button></li>`;
  const grp = g => `<div class="docgrp" id="docs-g-${esc(g.id)}"><h4 class="small"><span>${esc(g.label)}</span><span class="mute">${int(g.n)}</span></h4>${g.id === 'memory' && d.memory ? memGauge(d.memory, 'docs-memory') : ''}
    <ul>${g.rows.map(row).join('')}</ul>${subMore(g.rows.length, g.n)}</div>`;
  const list = `<div class="card doclist" id="docs-list" role="navigation" aria-label="Files">${(d.groups || []).map(grp).join('') || '<p class="small mute">no files yet</p>'}</div>`;
  const reader = !d.file ? '<p class="small mute" id="docs-none">Pick a file on the left.</p>' : d.parts_loading ? `<p class="small mute" id="docs-loading">${chip('idle', 'loading')} the file ...</p>` : d.doc ? docReader(d.doc, { ...ctx, now }, d) : '';
  return `<div class="dochead"><b>Docs</b> <span class="small mute">every file the agents read, and the project's own docs · ${int(d.files ?? 0)} files · rendered · findings beside the text</span></div>${wait}
   <div class="docsplit${d.picked ? ' picked' : ''}" id="docs-split">${list}<section class="docread" id="docs-reader">${reader}</section></div>`;
}
// META-INSTRUCTIONS R1: every file that steers the agents - load class, ~size, what it cost today, drift, read-only hints; a row
// opens the file rendered. R2 (the chat's verbs) adds "ask the controller to tighten this": a disabled stub until then.
const INS_LOAD = { session: 'every session', checkin: 'check-ins', chat: 'chat', role: 'role', 'on-demand': 'on demand', source: 'source' };
const INS_CHIP = { session: 'warn', checkin: 'claude', chat: 'claude', role: 'prov', 'on-demand': 'idle', source: 'idle' };
const DRIFT_CHIP = { ok: 'ok', missing: 'bad', drift: 'bad', unmanaged: 'bad', stale: 'warn', adoptable: 'idle', same: 'idle' };
const tk = n => (!fin(n) ? '-' : n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);
// META-UX-BUILD S1: a rebuild in the worker (or the first scan) shows a chip, never a blank page; a part not here yet says so
const INS_TITLE = { files: 'Files', rules: 'The ladder', findings: 'Findings', hints: 'Hints', suggest: 'Tighten' };
const insWait = k => `<div class="tablecard" id="ins-wait-${k}"><h3>${INS_TITLE[k]}</h3><p class="small mute inspart">loading ...</p></div>`;
function insRefreshing(d, now) {
  if (d.pending) return `<div class="card" id="ins-refreshing">${chip('run', 'refreshing')} <b>The first scan of ${esc(d.project ?? 'this project')} is running</b> in the background
    <div class="small mute">Every steering file is read once (a big project: under a minute); this page fills in when it lands. Other tabs answer meanwhile.</div></div>`;
  return `${d.refreshing ? `<div class="small" id="ins-refreshing" style="margin:0 0 6px">${chip('run', 'refreshing')} <span class="mute">the scan runs in the background; shown: the view of ${esc(fmtTime(d.at, now))}</span></div>` : ''}${d.error ? `<div class="small" style="margin:0 0 6px">${chip('bad', 'scan failed')} <span class="mute">${esc(d.error)}</span></div>` : ''}`;
}
const insMore = (shown, n, where) => (n > shown ? `<p class="small mute" style="padding:0 12px">showing ${int(shown)} of ${int(n)}${where ? ` · ${where}` : ''}</p>` : '');
// META-UX-BUILD S4 (REPORT s.2): Context = what a session loads before any work and what it costs. The sub-view pattern: 4 numbers,
// Per role (what one session loads + the ONE standing table) / Per file (the count card, the file map, most tokens per day, the files)
// / Is it growing? / Check-ins per day. Reading is in the Docs reader (every file link lands there); the checks (Managed, Findings,
// Said again, the ladder, Audits, Memory, Hints, Tighten) are one link away (`sub=checks`, no fifth sub-view) until Slop takes them.
function context(d, ctx) {
  const now = ctx.now ?? Date.now();
  if (d.pending || (d.error && !d.at)) return `${insRefreshing(d, now)}`;
  if (d.sub === 'checks') return `${insRefreshing(d, now)}${ctxChecks(d)}`;
  const none = w => `<p class="small mute">${esc(w)}</p>`;
  const body = d.sub === 'file' ? ctxFile(d, now) : d.sub === 'growing' ? insTrend(d.measured) || none('no measured session in the last 30 days')
    : d.sub === 'checkins' ? insCheckins(d.checkins) || none('no check-in recorded yet') : `${insLoads(d)}${ctxRoles(d)}`;
  const n = d.counts || {}, checks = (n.findings ?? 0) + (n.advisories ?? 0) + (n.hints ?? 0) + (n.suggest ?? 0);
  return `${insRefreshing(d, now)}<div class="small mute" id="context-what">what every session loads before any work, and what that costs · last ${int(d.measured?.window_days ?? 7)} days</div>
   ${subviewPage('context', { numbers: contextNumbers(d), views: CONTEXT_SUBS.map(([k, label]) => [k, label, k === 'file' ? n.files : undefined]), active: d.sub, body: d.parts_loading ? '' : body, loading: d.parts_loading })}
   <div class="small mute" id="context-links">Read the files in <button class="lnk" data-tab="docs">Docs</button> · their checks (findings, rules, audits, memory): <button class="lnk" data-act="sub" data-sub="checks">open the checks</button> · every finding, hint and tightening candidate, in batches: <button class="lnk" data-go="slop" data-gosub="fix">Slop</button> (${int(checks)})</div>`;
}
// Per file: the count card, the file map + most tokens per day, the files (capped, show more); a name opens the Docs reader
function ctxFile(d, now) {
  const load = r => r.load === 'role' ? `role ${r.role}` : r.load === 'session' && r.standing_tokens < r.tokens ? 'every session (description)' : INS_LOAD[r.load] ?? r.load;
  // the files that cost the most per day first (then size); the worst offenders are marked in the table and named on top with advice
  const all = [...(d.rows || [])].sort((a, b) => perDay(b) - perDay(a) || (b.tokens ?? 0) - (a.tokens ?? 0)), shown = all.slice(0, d.limit || SUB_CAP);
  const worst = worstFiles(all), hot = new Set(worst.map(x => x.r.id));
  const rows = shown.map(r => `<tr id="ins-row-${esc(r.id)}"${hot.has(r.id) ? ' class="ins-hot"' : ''}>
    <td><button class="lnk" data-ins="${esc(r.id)}"${r.exists ? '' : ' disabled'}>${esc(r.name)}</button>${r.exists || r.generated ? '' : ` ${chip('bad', 'missing')}`}${r.generated ? ` ${chip(DRIFT_CHIP[r.drift] ?? 'idle', `generated · ${r.drift || '?'}`)}` : ''}${r.stale ? ` ${chip('warn', `${r.stale} stale`)}` : ''}${r.findings ? ` ${chip('warn', `${r.findings} finding${r.findings > 1 ? 's' : ''}`)}` : ''}${insRuleChips(r.rules)}<div class="inspath mute">${esc(r.path)}</div>${hot.has(r.id) ? `<div class="small ins-advice">${esc(fileAdvice(r)[0].text)}</div>` : ''}</td>
    <td>${chip(INS_CHIP[r.load] ?? 'idle', load(r))}</td><td class="insopt">${esc((r.harness || []).join(', ') || 'any')}</td>
    <td class="num">${tk(r.tokens)}</td><td class="num">${r.cost_today ? `${tk(r.cost_today)}${r.via ? ' <span class="mute small">via</span>' : ''}<div class="small mute">${int(r.loads_today)} load(s)</div>` : dash}</td>
    <td class="insopt">${r.changed ? `${esc(fmtTime(r.changed, now))} <span class="small mute">${esc(r.changed_by)}</span>` : dash}</td>
    <td class="num">${r.hints ? chip('warn', `${r.hints} hint${r.hints > 1 ? 's' : ''}`) : dash}</td></tr>`).join('');
  return `<div class="card" id="ins-count"><b>${int(d.counts?.files ?? all.length)} files steer the agents</b> · ${tk(d.total)} tokens loaded today by ${int(d.sessions)} session(s)
     <div class="small mute">${esc(d.method)}. Cost today = size x the sessions that loaded it (runs.jsonl + the chat's starts). Read-only: hints are never applied.</div></div>
   ${ctxWorst(worst)}
   ${insFileMap(d)}
   <div class="tablecard"><h3>Files <span class="mute small">most tokens per day first · highlighted = a worst offender · tap a name to read it in Docs</span></h3><div class="inswrap"><table class="instab" id="ins-table"><thead><tr><th>file</th><th>loaded</th><th class="insopt">harness</th><th>size</th><th>today</th><th class="insopt">changed</th><th>hints</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="mute">no instruction files found</td></tr>`}</tbody></table></div>${subMore(shown.length, all.length)}</div>`;
}
// the worst offenders: the few files to look at first - what each costs a day and what to do about it, the worst problem first
function ctxWorst(worst) {
  if (!worst.length) return `<div class="card" id="ins-worst">${chip('ok', 'all clear')} <b>No file needs attention.</b> <span class="small mute">Every loaded file is within budget and has no open finding.</span></div>`;
  const li = worst.map(({ r, adv, day }, i) => `<li class="insworst"><div class="insworsthead"><span class="insrank">${i + 1}</span> <button class="lnk" data-ins="${esc(r.id)}"${r.exists ? '' : ' disabled'}><b>${esc(r.name)}</b></button>
    <span class="small mute">${day ? `${tk(day)} tokens / day` : `${tk(r.tokens)} tokens`} · ${esc(INS_LOAD[r.load] ?? r.load)}</span></div>
    <ul class="insadv">${adv.map(a => `<li>${chip(a.sev, a.sev === 'bad' ? 'fix' : a.sev === 'warn' ? 'improve' : 'minor')} ${esc(a.text)}${a.go ? ` <button class="lnk" data-go="${esc(a.go)}" data-gosub="fix">in Slop</button>` : ''}</li>`).join('')}</ul></li>`).join('');
  return `<div class="tablecard" id="ins-worst"><h3>Look at these first <span class="mute small">the ${int(worst.length)} file${worst.length > 1 ? 's' : ''} where a fix saves the most: tokens loaded per day, and what the checks found</span></h3><ol class="insworstlist">${li}</ol></div>`;
}
// Per role: ONE standing table (META-UX-BUILD S4: "Standing context (measured)" + "Standing context per role" were two views of it) -
// each measured role (median per session, last 7 days) with the steering files' estimate per launch profile of that role beneath it
function ctxRoles(d) {
  const m = d.measured, lab = k => esc(String(k).replace(/^(\w+)/, w => ROLE_LABEL[w] ?? w));
  const reads = n => (n >= 1e6 ? `~${(n / 1e6).toFixed(1)}M` : tk(n));
  // the estimates of a role: one profile inline; several = their range, each profile (label, sessions today, ~tokens) one tap away
  const est = ps => {
    if (!ps.length) return `<td class="num">${dash}</td><td class="num">${dash}</td>`;
    const ts = ps.map(p => p.tokens), lo = Math.min(...ts), hi = Math.max(...ts), n = ps.reduce((k, p) => k + p.sessions, 0);
    if (ps.length === 1) return `<td class="num">${int(n)}</td><td class="num">${tk(hi)}</td>`;
    return `<td class="num">${int(n)}</td><td class="num"><details class="ctxprofs"><summary>${lo === hi ? tk(hi) : `${tk(lo)}-${tk(hi).slice(1)}`} <span class="small mute">${int(ps.length)} profiles</span></summary>
      <ul class="small">${ps.map(p => `<li>${esc(p.label)} · ${int(p.sessions)} today · ${tk(p.tokens)}</li>`).join('')}</ul></details></td>`;
  };
  const rows = standingRows(m, d.standing).map(r => {
    const x = r.measured;
    return `<tr class="ctxrole"><td><b>${lab(r.key)}</b>${r.profiles.length === 1 ? `<div class="small mute">${esc(r.profiles[0].label)}</div>` : ''}</td>${x ? `<td class="num">${int(x.runs)}</td><td class="num"><b>${tk(x.median_turn1)}</b></td><td class="num insopt">${tk(x.median_create1)}</td><td class="num insopt">${x.median_turns ?? dash}</td><td class="num">${reads(x.cache_read)}</td>` : `<td class="num">${dash}</td><td class="num mute small">not measured</td><td class="insopt"></td><td class="insopt"></td><td class="num">${dash}</td>`}${est(r.profiles)}</tr>`;
  }).join('');
  return `<div class="tablecard" id="ctx-standing"><h3>Standing context per role <span class="mute small">measured: what one session loads before any work, re-read every turn, median per session, last ${int(m?.window_days ?? 7)} days · from files: the steering files' estimate per launch profile, today (tap a range for each profile)</span></h3>
   <div class="inswrap"><table class="instab" id="ctx-roles"><thead><tr><th>role</th><th>runs</th><th>turn 1</th><th class="insopt">cache create</th><th class="insopt">turns</th><th>cache reads</th><th>sessions today</th><th>~tokens from files</th></tr></thead><tbody>${rows || `<tr><td colspan="8">${dash}</td></tr>`}</tbody></table></div>
   ${m?.method ? `<div class="small mute" style="padding:6px 12px;overflow-wrap:anywhere">${esc(m.method)}</div>` : ''}</div>`;
}
// the checks page (one link from Context, not a sub-view): every check the Instructions tab showed, until the Slop slice moves them
function ctxChecks(d) {
  const wait = k => d.parts_loading && (k === 'rules' ? d.rules === undefined : k === 'files' ? d.rows === undefined : d[k] === undefined);
  return `<div class="small" id="ctx-checks-head"><button class="lnk" data-act="sub" data-sub="role">‹ Context</button> · <b>The checks</b> <span class="mute">of the files a session loads; tap a file to read it in Docs</span> · the lint's hints and the tightening candidates are rows in <button class="lnk" data-go="slop" data-gosub="fix">Slop › To fix</button></div>
   ${insManaged(d.managed)}
   ${wait('findings') ? insWait('findings') : insFindings(d)}
   ${wait('rules') ? insWait('rules') : `${insRepeats(d.rules)}${insLadder(d.rules)}`}
   ${insAudits(d.audits)}
   ${insMemory(d.memory_map)}
`;
}
// META-TEND P3 (REPORT 5.3 view 6): the ladder - every must / never rule as a card in its state's column (prose only -> repeated n
// times -> enforced -> retired): its home (a click opens the source line), its enforcement, when that last fired. Built on board().
const ENF_LABEL = { prose: 'prose only', hook: 'hook', deny: 'deny rule', test: 'test', lint: 'lint', gate: 'gate', 'git-hook': 'git hook' };
const baseName = p => String(p ?? '').split('/').pop();
function insRuleChips(c) {
  if (!c?.total) return '';
  return ` ${chip('idle', `${c.total} rule${c.total > 1 ? 's' : ''}`)}${c.prose ? ` ${chip('warn', `${c.prose} prose only`)}` : ''}${c.repeated ? ` ${chip('bad', `${c.repeated} repeated`)}` : ''}${c.enforced ? ` ${chip('ok', `${c.enforced} enforced`)}` : ''}`;
}
function ruleCard(r) {
  const h = r.home || {}, where = `${h.path?.startsWith('records:') ? h.path.slice(8) : baseName(h.path)}${h.line ? `:${h.line}` : ''}`;
  const e = r.enforcement || { kind: 'prose' };
  const enf = e.kind === 'prose' ? chip(e.by_choice ? 'idle' : 'warn', e.by_choice ? 'prose only, by choice' : 'prose only') : `${chip('ok', ENF_LABEL[e.kind] ?? e.kind)} <span class="small mute" title="${esc(e.path ?? '')}">${esc(e.target ?? '')}</span>`;
  const fired = r.state === 'retired' ? `retired ${esc(String(r.retired_at ?? '').slice(0, 10))}` : e.kind === 'prose' ? 'nothing fires: no enforcement' : r.fired ? `fired ${esc(String(r.fired.at).slice(0, 10))} <span class="mute">(${esc(r.fired.what)})</span>` : 'last fired: unknown <span class="mute">(no log of it)</span>';
  return `<div class="wbtext">${esc(r.text.length > 160 ? r.text.slice(0, 157) + '...' : r.text)}</div>
    <div class="small">${h.row ? `<button class="lnk" data-ins="${esc(h.row)}" data-line="${esc(h.line ?? '')}" title="${esc(h.path)}">${esc(where)}</button>` : `<b>${esc(where)}</b>`}${r.homes?.length > 1 ? ` ${chip('warn', `${r.homes.length} homes`)}` : ''}${r.repeats ? ` ${chip('bad', `said ${r.repeats}x`)}` : ''} · ${enf}</div>
    <div class="small mute">${fired}</div>`;
}
function insLadder(L) {
  if (!L) return '';
  const NOTE = { prose: 'every rule is enforced or retired', repeated: 'no rule said again', enforced: 'nothing enforces a rule yet', retired: 'no rule retired since the first scan' };
  const cols = LADDER_STATES.map(st => { const xs = L.rules.filter(r => r.state === st).sort(LADDER_ORDER[st]).slice(0, INS_CAPS.ladder);   // the rules part: each column capped
    return { key: st, label: st === 'prose' ? 'prose only' : st, cards: xs.map(ruleCard), more: Math.max(0, (L.counts[st] ?? 0) - xs.length), note: NOTE[st] }; });
  const adv = L.advisories || [], by = new Map();
  for (const a of adv) { if (!by.has(a.key)) by.set(a.key, []); by.get(a.key).push(a); }
  const KEY = { 'rule-several-homes': 'one rule in several homes', 'rule-drift-claim': 'says enforced, nothing found', 'rule-drift-policy': 'line vs the policy', 'rule-drift-path': 'points at code that is gone', 'rule-path-unknown': 'path not found (a runtime file or a typo)', 'enforcement-unexplained': 'enforcement no rule explains' };
  const finds = [...by].map(([k, xs]) => `<li><details class="rulegroup insgroup"><summary>${chip(xs[0].severity === 'medium' ? 'warn' : 'idle', xs[0].severity)} <b>${int(L.adv_counts?.[k] ?? xs.length)}</b> × ${esc(KEY[k] ?? k)} <span class="small mute">${esc(xs[0].source)}</span><div class="small">fix: <i>${esc(xs[0].fix.action)}</i></div></summary>
    <ul>${xs.slice(0, INS_CAPS.advisories).map(a => `<li class="insfind small"><span class="mute">${esc(baseName(a.path) || a.surface)}${a.line ? `:${esc(a.line)}` : ''}</span> ${esc(a.why)}${a.fix.patch ? `<pre class="inspatch">${esc(a.fix.patch)}</pre>` : ''}</li>`).join('')}</ul></details></li>`).join('');
  return `<div class="tablecard" id="ins-ladder"><h3>The ladder <span class="mute small">${int(LADDER_STATES.reduce((n, st) => n + (L.counts[st] ?? 0), 0))} must / never rules by state · prose only ${int(L.counts.prose)} → repeated ${int(L.counts.repeated)} → enforced ${int(L.counts.enforced)} → retired ${int(L.counts.retired)} · tap a home to open its line</span></h3>
    ${board(cols, { id: 'ins-board', aria: 'rules by state' })}
    ${finds ? `<ul id="ins-rule-findings">${finds}</ul>` : ''}</div>`;
}
// META-TEND P5 (REPORT 3.3): one vendor-audit hunk = one card; accept = a decision + a directive (the check-in applies it), decline = a decision
function auditCard(c, project) {
  const pj = project ? ` data-project="${esc(project)}"` : '';
  return `<li class="insfind" id="aud-${esc(c.id)}">${chip(SEV_CHIP[c.severity] ?? 'idle', c.severity)} <b>${esc(baseName(c.path))}:${esc(c.line)}</b> ${esc(c.why)} <span class="small mute">${esc(c.run)} · ${esc(c.id)}</span>
    <pre class="inspatch">${esc(c.fix.patch ?? '')}</pre>
    <button class="primary" data-act="audit-accept"${pj} data-id="${esc(c.id)}">Accept: apply it</button> <button data-act="audit-decline"${pj} data-id="${esc(c.id)}">Decline: keep the text</button></li>`;
}
const AUD_OUT = { done: 'ok', crash: 'bad', stopped: 'warn', limit: 'warn', auth: 'warn' };
function insAudits(a) {
  if (!a) return '';
  const runs = a.runs.map(r => `<tr><td class="id">${esc(r.id)}</td><td class="small">${esc(String(r.created).slice(0, 16).replace('T', ' '))}</td><td>${chip(r.state === 'running' ? 'run' : AUD_OUT[r.outcome] ?? 'idle', r.state === 'running' ? 'running' : r.outcome ?? r.state)}</td>
    <td class="num">${int(r.accepted + r.declined + r.open)}</td><td class="num">${int(r.accepted)}</td><td class="num">${int(r.declined)}</td><td class="num">${int(r.open)}</td>
    <td class="small">${r.watch.length ? r.watch.map(w => (w.alarms.length ? chip('bad', `${w.alarms.length} alarm(s)`) : chip(w.done ? 'ok' : 'idle', `${w.seen} of ${w.of} runs ${w.done ? 'clean' : 'watched'}`))).join(' ') : dash}</td></tr>`).join('');
  const trig = a.triggers.map(t => `<li>${chip(t.key === 'never' ? 'idle' : 'warn', t.key)} ${esc(t.why)}</li>`).join('');
  return `<div class="tablecard" id="ins-audits"><h3>Audits <span class="mute small">the vendor prompt audit (/doctor prompt-audit), read-only · one card per proposed hunk · ${esc(a.rule.why)}</span></h3>
   <div style="padding:0 12px"><div class="small"><b>Triggers now</b> ${a.triggers.length ? `<span class="mute">(${a.rule.mode === 'auto' ? 'they may start an audit' : 'manual: start it with'} <span class="mono">${esc(a.command)}</span>)</span>` : '<span class="mute">none: no event calls for an audit</span>'}</div>${trig ? `<ul class="small" id="ins-audit-triggers">${trig}</ul>` : ''}</div>
   <div class="inswrap"><table class="instab" id="ins-audit-runs"><thead><tr><th>run</th><th>started</th><th>outcome</th><th>hunks</th><th>accepted</th><th>declined</th><th>open</th><th>watch after apply</th></tr></thead><tbody>${runs || '<tr><td colspan="8" class="mute">no audit has run yet</td></tr>'}</tbody></table></div>
   ${a.cards.length ? `<ul>${a.cards.map(c => auditCard(c, null)).join('')}</ul>` : ''}</div>`;
}
// META-TEND P5 (REPORT 5.3 view 1): is it growing forever? - the median standing context per session, one line per role, 30 days
function insTrend(m) {
  const rows = m?.trend?.rows || [];
  if (!rows.length) return '';
  const end = Date.parse(rows.map(r => r.day).sort().at(-1) + 'T00:00:00Z'), n = m.trend.days;
  const days = Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 86400000).toISOString().slice(0, 10));
  const keys = [...new Set(rows.map(r => r.key))], lab = k => k.replace(/^(\w+)/, w => ROLE_LABEL[w] ?? w);
  const series = keys.map(k => ({ key: k, label: lab(k), points: rows.filter(r => r.key === k && r.median_turn1 !== null).map(r => ({ x: r.day, y: r.median_turn1 })) }));
  return `<div class="tablecard" id="ins-trend"><h3>Is it growing forever? <span class="mute small">standing tokens per session (the median first request), per role and day, last ${int(n)} days</span></h3>
   <div style="padding:0 12px 8px">${lines(series, { days, fmt: tk, title: 'standing tokens per session', unit: 'tokens' })}</div></div>`;
}
// META-TEND P5 (REPORT 5.3 view 4): per file - a strip of its paragraphs (width = tokens) coloured by age, with read and cite marks
const AGE_BANDS = [[7, 'age-new', 'under 7 d'], [30, 'age-mid', '7-30 d'], [Infinity, 'age-old', 'over 30 d']];
function insStrip(f) {
  if (!f.paras?.length) return '';
  const tot = f.paras.reduce((n, p) => n + Math.max(1, p.tokens), 0), ev = f.evidence;
  const segs = f.paras.map(p => {
    const cls = p.age_days === null || p.age_days === undefined ? 'age-unk' : AGE_BANDS.find(([d]) => p.age_days < d)[1], cited = p.cited || [];
    return `<a class="psg ${cls}${p.stale ? ' stale' : ''}" href="#ins-${esc(p.anchor)}" style="flex-basis:${(100 * Math.max(1, p.tokens) / tot).toFixed(2)}%" title="${esc(`L${p.line}-${p.end} · ${p.age_days ?? '?'} d · ~${p.tokens} tokens · read ${p.read ?? 0}x${cited.length ? ` · cited by ${cited.join(', ')}` : ''}${p.stale ? ' · STALE' : ''}`)}">${p.read ? '<i class="pread"></i>' : ''}${cited.length ? '<i class="pcite"></i>' : ''}</a>`;
  }).join('');
  const cites = [...new Set((ev?.cites || []).map(c => c.id))];
  const said = ev ? `read ${int(ev.reads)}x in ${int(f.read_days ?? 30)} days${ev.last ? ` (last ${fmtTime(ev.last)})` : ''} · ${cites.length ? `cited by ${cites.join(', ')}` : 'cited by no decision'}` : 'no read evidence';
  return `<div id="ins-strip" class="small" style="margin:0 0 8px"><div class="pstrip" role="img" aria-label="${esc(`${f.paras.length} paragraphs by age; ${said}`)}">${segs}</div>
    <div class="stklegend">${AGE_BANDS.map(([, c, w]) => `<span><i class="stkdot ${c}"></i>${esc(w)}</span>`).join('')}<span><i class="pread inl"></i>read</span><span><i class="pcite inl"></i>cited (its line)</span><b>${esc(said)}</b></div></div>`;
}
// META-TEND P3 (REPORT 3.6): the repeat detector's cards - one per cluster, ranked; approve = a directive (the one approvals path)
function enforceCard(c, project) {
  return `<li class="insfind" id="enf-${esc(c.id)}">${chip(c.severity === 'medium' ? 'warn' : 'idle', c.severity)} <b>${esc(c.why)}</b>
    <details><summary class="small">${int((c.items || []).length)} corrections · the draft</summary><ul class="small">${(c.items || []).map(x => `<li>${esc(x.text)}</li>`).join('')}</ul><pre class="inspatch">${esc(c.fix.patch ?? '')}</pre></details>
    <div class="small mute">${esc(c.fix.action)}</div>
    <button class="primary" data-act="adv-approve"${project ? ` data-project="${esc(project)}"` : ''} data-id="${esc(c.id)}" data-text="${esc(c.approve)}">Approve: ask for a brief</button></li>`;
}
function insRepeats(L) {
  if (!L) return '';
  const cs = L.cards || [];
  return `<div class="tablecard" id="ins-repeats"><h3>Said again <span class="mute small">${int(cs.length)} repeated correction(s), ranked · each card drafts the enforcement; Norn installs nothing (the Inbox holds the same cards)</span></h3>
    ${cs.length ? `<ul>${cs.map(c => enforceCard(c, null)).join('')}</ul>` : '<p class="mute" style="padding:0 12px">no correction said 3 times</p>'}</div>`;
}
// META-PRACTICE-P1: the static checks in place - one "managed" line, then the findings per file (severity chips, counts, the fix)
const SEV_CHIP = { high: 'bad', medium: 'warn', low: 'idle', count: 'idle' }, SEVS = ['high', 'medium', 'low', 'count'];
function insManaged(m) {
  if (!m) return '';
  const sev = SEVS.filter(s => m.by_severity?.[s]).map(s => chip(SEV_CHIP[s], `${m.by_severity[s]} ${s}`)).join(' ');
  const on = Object.entries(m.memory || {}).filter(([, v]) => v === 'on').map(([r]) => ROLE_LABEL[r] ?? r), off = Object.entries(m.memory || {}).filter(([, v]) => v === 'off').map(([r]) => ROLE_LABEL[r] ?? r);
  return `<div class="card" id="ins-managed"><b>Managed:</b> ${int(m.files)} files scanned · <b>${int(m.open)}</b> findings open ${sev} · ${int(m.fixed)} fixed since the last scan${m.since ? ` <span class="small mute">(${esc(String(m.since).slice(0, 16).replace('T', ' '))}Z)</span>` : ''} · memory loaded by ${esc(on.join(', ') || 'no role')}${off.length ? ` <span class="mute">(off: ${esc(off.join(', '))})</span>` : ''}
    <div class="small mute">Static checks 1-19 + 21-23 (free, no model call; check 20 comes with the audits). Read-only: a finding names the fix, nothing is edited.</div></div>`;
}
function insFindings(d) {
  const fs2 = d.findings || [];
  if (!fs2.length) return '<div class="tablecard" id="ins-findings-card"><h3>Findings</h3><p class="mute" style="padding:0 12px">none</p></div>';
  const groups = new Map();
  for (const f of fs2) { if (!groups.has(f.path)) groups.set(f.path, []); groups.get(f.path).push(f); }
  const li = [...groups].map(([p, xs]) => {
    const cnt = SEVS.filter(s => xs.some(x => x.severity === s)).map(s => chip(SEV_CHIP[s], `${xs.filter(x => x.severity === s).length} ${s}`)).join(' ');
    const name = p.split('/').pop(), id = xs.find(x => x.row)?.row;
    // DEC-273: one row per file x check (count, the check's title, the fix once); its lines in an expandable list
    const byCheck = new Map();
    for (const x of xs) { if (!byCheck.has(x.check)) byCheck.set(x.check, []); byCheck.get(x.check).push(x); }
    const rows = [...byCheck].map(([c, ys]) => {
      const top = SEVS.find(s => ys.some(y => y.severity === s)), fixes = [...new Set(ys.map(y => y.fix.action))];
      return `<li><details class="insgroup"><summary>${chip(SEV_CHIP[top], top)} <b>${int(ys.length)}</b> × ${esc(ys[0].surface)} <span class="small mute">C${esc(c)} · L${esc(ys.map(y => y.line).slice(0, 8).join(', '))}${ys.length > 8 ? ' …' : ''}</span>${fixes.length === 1 ? `<div class="small">fix: <i>${esc(fixes[0])}</i></div>` : ''}</summary>
        <ul>${ys.map(y => `<li class="insfind">${chip(SEV_CHIP[y.severity], y.severity)} <span class="small mute">L${esc(y.line)}</span> ${esc(y.why)}${fixes.length > 1 ? `<div class="small">fix: <i>${esc(y.fix.action)}</i></div>` : ''}</li>`).join('')}</ul></details></li>`;
    }).join('');
    return `<li class="insfile"><div>${id ? `<button class="lnk" data-ins="${esc(id)}">${esc(name)}</button>` : `<b>${esc(name)}</b>`} ${cnt} <span class="inspath mute">${esc(p)}</span></div><ul>${rows}</ul></li>`;
  }).join('');
  return `<div class="tablecard" id="ins-findings-card"><h3>Findings <span class="mute small">${int(d.findings_n ?? fs2.length)} · static checks, read-only</span></h3><ul id="ins-findings">${li}</ul>${insMore(fs2.length, d.findings_n ?? 0, 'the Guard lists every one')}</div>`;
}
// META-STANDING-CONTEXT R1: the measured standing context (median per session, last 7 days) per role + where it goes (the parts)
const ROLE_LABEL = { worker: 'workers', merge: 'merge runs', checkin: 'check-ins', chat: 'chat' };
// META-CHECKIN-DIET R1: per day "check-ins: n (m mechanical, k minor, j full)" - mechanical = a routine end the tick handled by code
function insCheckins(days) {
  if (!days?.length) return '';
  const li = days.map(x => `<tr><td>${esc(x.day)}</td><td>check-ins: <b>${int(x.n)}</b> (${int(x.mechanical)} mechanical, ${int(x.minor)} minor, ${int(x.full)} full)</td></tr>`).join('');
  return `<div class="tablecard" id="ins-checkins"><h3>Check-ins per day <span class="mute small">mechanical = a routine end handled by code, no model · minor = the reduced tick · full = the full check-in</span></h3><div class="inswrap"><table class="instab"><tbody>${li}</tbody></table></div></div>`;
}
// META-TEND P1-VISUAL (REPORT 5.3 view 2): what one session loads - a stacked bar per role (the newest measured first request), the
// memory switch per role (policy.launch.memory). Parts in the REPORT's order; Norn's prompt, the agents list and the prompt follow.
const LOAD_ROLES = [['chat', 'controller / chat'], ['checkin', 'check-ins'], ['worker', 'workers'], ['merge', 'merge runs']];
const PART_ORDER = ['base', 'plugins', 'memory', 'skills', 'claude_md', 'hooks', 'agent', 'mcp', 'norn', 'agents', 'prompt'];
function insLoads(d) {
  const ps = d.measured?.parts || {}, mem = d.managed?.memory || {};
  const li = LOAD_ROLES.map(([role, name]) => {
    const s = ps[role], sw = mem[role] ? chip(mem[role] === 'on' ? 'warn' : 'ok', `memory ${mem[role]}`) : '';
    const segs = s ? [...(s.parts || [])].sort((a, b) => PART_ORDER.indexOf(a.key) - PART_ORDER.indexOf(b.key)).map(x => ({ key: x.key, label: x.ours === false ? `${x.label} (fixed)` : x.label, value: x.tokens })) : [];
    return `<li class="insload"><div><b>${esc(name)}</b> ${sw} ${s ? `<span class="mute small">${tk(s.total)} tokens · ${esc(s.run)}</span>` : ''}</div>
      ${s ? stack(segs, { fmt: tk }) : `<div class="small mute">no session measured in the last ${int(d.measured?.window_days ?? 7)} days</div>`}</li>`;
  }).join('');
  return `<div class="tablecard" id="ins-loads"><h3>What one session loads <span class="mute small">before any work, per role · the newest measured first request · memory on / off = the launch switch (policy.launch.memory)</span></h3><ul class="insloads">${li}</ul></div>`;
}
// META-TEND P1-VISUAL (REPORT 5.3 view 3): the file map - each steering file a block sized by ~tokens x loads per day (7-day mean),
// coloured by its state, grouped by load class; a click opens the file with its findings. Generator sources are not loaded: left out.
const MAP_GROUPS = [['always loaded', ['session']], ['per role', ['checkin', 'chat', 'role']], ['on demand', ['on-demand']]];
const MAP_STATE = { fresh: 'fresh', stale: 'stale paragraphs', conflict: 'conflict (two files say it)', 'generated-stale': 'generated, out of sync' };
function insFileMap(d) {
  const rows = (d.rows || []).filter(r => r.exists && r.load !== 'source'), cost = r => Math.round((r.standing_tokens ?? r.tokens) * (r.loads_day || 0));
  if (!rows.length) return '';
  const groups = MAP_GROUPS.map(([name, loads]) => {
    const xs = rows.filter(r => loads.includes(r.load)).sort((a, b) => cost(b) - cost(a) || b.tokens - a.tokens);
    if (!xs.length) return '';
    const sum = xs.reduce((n, r) => n + cost(r), 0), tsum = xs.reduce((n, r) => n + r.tokens, 0) || 1;
    const blk = r => {
      const share = sum > 0 ? cost(r) / sum : r.tokens / tsum, st = MAP_STATE[r.map_state] ? r.map_state : 'fresh';
      return `<button class="fmblk st-${esc(st)}" data-ins="${esc(r.id)}" style="flex-basis:${(100 * share).toFixed(2)}%" title="${esc(`${r.name} · ${tk(r.tokens)} tokens x ${r.loads_day || 0} loads/day = ${tk(cost(r))} / day · ${MAP_STATE[st]}${r.findings ? ` · ${r.findings} findings` : ''}`)}">${share >= 0.06 ? esc(r.name) : ''}</button>`;
    };
    return `<div class="fmgroup"><div class="small"><b>${esc(name)}</b> <span class="mute">${int(xs.length)} files · ${tk(sum)} tokens / day</span></div><div class="fmblocks">${xs.map(blk).join('')}</div></div>`;
  }).join('');
  const n = k => rows.filter(r => (MAP_STATE[r.map_state] ? r.map_state : 'fresh') === k).length;
  const legend = Object.entries(MAP_STATE).map(([k, w]) => `<span><i class="stkdot st-${k}"></i>${esc(w)} <b>${int(n(k))}</b></span>`).join('');
  const top = rows.filter(r => cost(r) > 0).sort((a, b) => cost(b) - cost(a)).slice(0, 6);
  return `<div class="tablecard" id="ins-filemap"><h3>The file map <span class="mute small">a block per file, sized by ~tokens x loads per day (last 7 days) · tap a block to open the file and its findings</span></h3>
   <div class="stklegend small" style="padding:0 12px">${legend}</div><div style="padding:4px 12px">${groups}</div>
   ${top.length ? `<div style="padding:0 12px 8px"><div class="small"><b>Most tokens per day</b></div>${bars(top.map(r => ({ label: r.name, value: cost(r), cls: `st-${MAP_STATE[r.map_state] ? r.map_state : 'fresh'}` })), { fmt: v => `${tk(v)} / day` })}</div>` : ''}</div>`;
}
// META-TEND P1-VISUAL (REPORT 5.3 view 5): memory - the 200-line / 25 KB gauge, MEMORY.md -> topic files, entries in no index, broken links
// the MEMORY.md gauge (% of its load limit; over = full + red): Instructions' memory card and the head of the Docs Memory group
function memBars(m) {
  const g = (label, v, max, unit) => ({ label, value: 100 * v / max, cls: v > max ? 'over' : 'st-fresh', note: esc(`${v} of ${max} ${unit}`) });
  return bars([g('lines', m.lines, m.max_lines, 'lines'), g('size', m.kb, m.max_kb, 'KB')], { fmt: v => `${Math.round(v)} %`, max: 100 });
}
function memGauge(m, id) {
  const over = m.lines > m.max_lines || m.kb > m.max_kb;
  return `<div class="docmem" id="${esc(id)}"><div class="small">${over ? `${chip('bad', 'over the limit')} past ${int(m.max_lines)} lines / ${int(m.max_kb)} KB the rest of MEMORY.md is not loaded` : `MEMORY.md loads whole: under ${int(m.max_lines)} lines and ${int(m.max_kb)} KB`}</div>${memBars(m)}
    <div class="small mute">${int(m.topics)} topic files${m.orphans ? ` · ${int(m.orphans)} in no index` : ''}${m.broken ? ` · ${int(m.broken)} broken links` : ''}</div></div>`;
}
function insMemory(m) {
  if (!m) return '<div class="tablecard" id="ins-memory"><h3>Memory</h3><p class="small mute" style="padding:0 12px">No MEMORY.md for this repo: its auto-memory folder is empty, so no session loads memory.</p></div>';
  const lk = m.topics.filter(t => t.linked).length, ago = iso => (iso ? esc(fmtTime(iso)) : '<span class="mute">not in 30 days</span>');
  const over = m.lines > m.max_lines || m.kb > m.max_kb, gauge = memBars(m);
  const shape = stack([{ key: 'linked', label: 'topic files in the index', value: lk }, { key: 'orphan', label: 'topic files in no index', value: m.orphans.length },
    { key: 'broken', label: 'broken links', value: m.broken.length }], { fmt: int });
  const broken = m.broken.map(e => `<li>${chip('bad', 'missing')} <span class="mute">L${esc(e.line)}</span> ${esc(e.title)} -&gt; ${esc(e.file)}</li>`).join('');
  const orphans = m.orphans.map(o => `<button class="lnk" data-ins="${esc(o.id)}">${esc(o.name)}</button>`).join(' · ');
  const tops = [...m.topics].sort((a, b) => String(b.opened ?? '').localeCompare(String(a.opened ?? '')) || a.name.localeCompare(b.name)).map(t => `<tr><td><button class="lnk" data-ins="${esc(t.id)}">${esc(t.name)}</button></td>
    <td>${t.linked ? chip('ok', `in index${t.linked > 1 ? ` x${t.linked}` : ''}`) : chip('warn', 'in no index')}</td><td>${ago(t.opened)}</td><td class="insopt">${t.changed ? esc(fmtTime(t.changed)) : dash}</td></tr>`).join('');
  return `<div class="tablecard" id="ins-memory"><h3>Memory <span class="mute small">MEMORY.md -&gt; ${int(m.topics.length)} topic files · the index last opened ${ago(m.index_opened)}</span></h3>
   <div style="padding:0 12px"><div class="small">${over ? `${chip('bad', 'over the limit')} past 200 lines / 25 KB the rest of MEMORY.md is silently not loaded` : 'MEMORY.md loads whole: under 200 lines and 25 KB'}</div>${gauge}${shape}
   ${broken ? `<div class="small" style="margin-top:6px"><b>Broken links</b></div><ul class="small">${broken}</ul>` : ''}
   ${orphans ? `<div class="small" style="margin-top:6px"><b>In no index</b> <span class="mute">(a session never finds them)</span></div><div class="small" style="overflow-wrap:anywhere">${orphans}</div>` : ''}
   <details style="margin:6px 0"><summary class="small">all ${int(m.topics.length)} topic files, last opened first</summary><div class="inswrap"><table class="instab"><thead><tr><th>file</th><th>index</th><th>last opened</th><th class="insopt">last changed</th></tr></thead><tbody>${tops}</tbody></table></div></details>
   <div class="small mute" style="padding-bottom:6px">${esc(m.opened_method)}</div></div></div>`;
}

// the Docs reader (META-UX-BUILD S3): head (name, load, size, path) + Rendered / Source; the paragraph strip (META-TEND P5); findings
// about the whole file on top; each other finding beside its paragraph (Rendered) or its line (Source). ctx.sanitize = DOMPurify.
const docFind = x => `<div class="insfind">${chip(SEV_CHIP[x.severity] ?? 'idle', x.severity ?? 'note')} <span class="mute">${x.check ? `C${esc(x.check)} ` : ''}${x.line ? `L${esc(x.line)}` : 'whole file'}${x.surface ? ` · ${esc(x.surface)}` : ''}</span> ${esc(x.why)}${x.fix?.action ? `<div class="small mute">fix: ${esc(x.fix.action)}</div>` : ''}</div>`;
const docAside = xs => (xs?.length ? `<aside class="docfind">${xs.map(docFind).join('')}</aside>` : '');
const ageBadge = p => ((p.age_days !== null && p.age_days !== undefined) || p.changed || p.stated ?`<span class="agebadge chip ${p.stale ? 'warn' : p.confirmed ? 'ok' : 'idle'}" title="${esc([p.stated ? `stated ${p.stated}` : '', p.changed ? `changed ${p.changed.slice(0, 10)}` : '', p.confirmed ? 'confirmed' : '', p.why].filter(Boolean).join(' · '))}">${p.age_days ?? '?'} d${p.stale ? ' · STALE' : p.confirmed ? ' · confirmed' : ''}</span> ` : '');
function docReader(f, ctx, d = {}) {
  const json = /\.json$/i.test(f.path), text = f.text ?? '', src = json ? '```json\n' + text + '\n```' : text, lines = text.split(/\r?\n/);
  const findings = f.findings || [], L = d.line, foc = (a, b) => (L && a <= L && L <= b ? ' focus" data-focus="1' : '');
  let body, whole, toc = [];
  if (d.src) {   // Source: every line numbered, its findings beside it
    const by = findingsByLine(findings, lines.length); whole = by.whole;
    body = `<div class="card docsrc" id="doc-src"><table><tbody>${lines.map((t, i) => `<tr id="docl-${i + 1}" class="${foc(i + 1, i + 1)}"><td class="ln mute">${i + 1}</td><td class="lt"><code>${esc(t)}</code></td><td>${docAside(by.at.get(i + 1))}</td></tr>`).join('')}</tbody></table></div>`;
  } else {
    const r = renderMarkdown(src, { sanitize: ctx.sanitize }); toc = r.toc;
    if (f.paras?.length && !json) {   // each paragraph rendered on its own, its age badge + its findings beside it
      const at = placeFindings(f.paras, findings); whole = at.whole;
      body = f.paras.map(p => `<div class="inspara docpara${p.stale ? ' stale' : ''}${at.at.has(p.anchor) ? ' hasfind' : ''}${foc(p.line, p.end)}" id="ins-${esc(p.anchor)}"><div class="docptext">${ageBadge(p)}<span class="small mute">L${esc(p.line)}</span>${renderMarkdown(lines.slice(p.line - 1, p.end).join('\n'), { sanitize: ctx.sanitize }).html}</div>${docAside(at.at.get(p.anchor))}</div>`).join('');
    } else { whole = findings; body = r.html; }
    body = `<article class="card md" id="doc-body">${body}</article>`;
  }
  const links = toc.map(t => `<a class="toc${t.depth}" href="#${esc(t.id)}">${esc(t.text)}</a>`).join('');
  const load = f.load ? ` ${chip(INS_CHIP[f.load] ?? 'idle', f.load === 'role' ? `role ${f.role}` : INS_LOAD[f.load] ?? f.load)}` : '';
  const on = v => (v === 'src') === !!d.src;
  const btn = (v, label) => `<button data-act="doc-view" data-view="${v}" aria-pressed="${on(v)}" class="${on(v) ? 'strong' : ''}">${label}</button>`;
  return `<div class="dochd" id="docs-head"><button class="docback" data-act="doc-back">&larr; Back</button> <b class="dfname">${esc(f.name ?? f.tab)}</b>${load}
    <span class="small mute">${f.tokens ? `${tk(f.tokens)} tokens · ` : ''}${int(f.lines ?? lines.length)} lines${f.changed ? ` · changed ${esc(fmtTime(f.changed, ctx.now))}` : ''} · <span class="inspath">${esc(f.path)}</span></span></div>
   <div class="filters" id="docs-mode">${btn('md', 'Rendered')}${btn('src', 'Source')}<span class="small mute">${findings.length ? `${int(findings.length)} finding${findings.length === 1 ? '' : 's'} beside the text` : 'no findings on this file'}</span></div>
   ${insStrip(f)}${whole.length ? `<div class="card small" id="doc-file-findings"><b>About the whole file</b>${whole.map(docFind).join('')}</div>` : ''}
   ${d.src ? body : `<div class="docwrap"><nav class="doctoc" id="doc-toc" aria-label="Contents"><b class="small">Contents</b>${links || '<span class="small mute">no headings</span>'}</nav>${body}</div>`}`;
}

// Ledger (LEDGER-UX R1): one row per entry in the Records look, newest first - time, kind chip, headline + labelled sub-lines;
// record ids link where they live (ledger.mjs), headings / prose render as markdown; search + kind filter like Records
const LED_CHIP = { 'check-in': 'ok', minor: 'idle', auto: 'warn', controller: 'claude', other: 'idle' };
// compact (the Overview card): the sub-lines go on one muted line, clamped by CSS, so 4 entries stay a glance
export function ledgerRows(entries, d, ctx, compact = false) {
  const o = { runs: d.runs || [], project: ctx.project };
  const subOf = x => `${x.label ? `<b>${esc(x.label)}</b> ` : ''}${ledgerInline(x.text, o)}`;
  return [...entries].reverse().map((e, i) => {
    const subs = !e.subs.length ? '' : compact ? `<div class="ledsub clamp">${e.subs.map(subOf).join(' · ')}</div>` : e.subs.map(x => `<div class="ledsub">${subOf(x)}</div>`).join('');
    const body = e.kind === 'other' ? `<div class="md ledmd">${renderMarkdown(e.raw, { sanitize: ctx.sanitize }).html}</div>`
      : `<div class="ledhead">${ledgerInline(e.headline, o)}</div>${subs}`;
    const who = e.kind === 'controller' ? `<div class="id">${esc(e.label)}</div>` : '';
    return `<tr${compact ? '' : ` id="led-${entries.length - 1 - i}" data-state="${esc(e.kind)}"`}><td class="small mute ledt">${e.ts ? fmtTime(e.ts, ctx.now) : ''}</td><td class="ledk">${chip(LED_CHIP[e.kind], e.kind === 'other' ? 'note' : e.kind)}${who}</td><td class="ledb">${body}</td></tr>`;
  }).join('');
}
function ledger(d, ctx) {
  const entries = parseLedger(d.ledger), more = d.more ? `<button class="ghost" data-act="ledger-more">Show older (${esc(d.count ?? 100)} more lines)</button>` : '';
  return `<div class="filters"><input type="search" data-filter="ledger" placeholder="search text, ids  (e.g. RUN-12, merged)"><select data-filter-state="ledger"><option value="">all kinds</option>${LEDGER_KINDS.map(k => `<option value="${k}">${k === 'other' ? 'notes / headings' : k}</option>`).join('')}</select>
    <span class="small mute">${entries.length} entries · ${esc(d.ledger.length)} of ${esc(d.total ?? d.ledger.length)} lines</span></div>
   <div class="tablecard"><h3>Ledger <span class="mute small">${esc(d.file ?? 'no ledger file in project.json')} · newest first</span></h3>
   <table class="ledtab" id="ledger-lines" data-rows="ledger"><thead><tr><th>when</th><th>kind</th><th>entry</th></tr></thead><tbody>${ledgerRows(entries, d, ctx) || '<tr><td colspan="3" class="mute">empty</td></tr>'}</tbody></table>
   ${more ? `<div style="padding:10px 14px">${more}</div>` : ''}</div>`;
}

// ---------- Settings (META-UX-R1): categories -> sub-categories from the schema (policy.mjs SECTIONS, served in /api/settings),
// left nav + search, one-line help per row, modified-from-default marker + reset, danger zone. Controls keep data-key = the key.
const showVal = v => Array.isArray(v) ? v.join(', ') || '(none)' : typeof v === 'boolean' ? (v ? 'on' : 'off') : v === '' ? '(default)' : v;
const ctlVal = v => Array.isArray(v) ? v.join(', ') : v ?? '';
/** Search text of one setting row (label, key, help, value, recommended) - the browser filters on the same string. */
export const searchText = s => [s.label, s.key, s.help, showVal(s.value), s.recommended].join(' ').toLowerCase();
/** All words of q in the text; the token @modified also requires the modified flag. Empty q matches everything. */
export function matchText(text, q, modified) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.every(w => w === '@modified' ? !!modified : text.includes(w));
}
export const settingsMatch = (s, q) => matchText(searchText(s), q, s.modified);
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
  const wrap = (body, sc = '') => `<div class="ssub" id="sub-notify-remote">${head}<div class="srow" id="set-remote" data-basic="1" data-search="remote phone tailscale pair device" data-mod="0"><div class="sl">${body}</div><div class="sc">${sc}</div></div></div>`;
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
function settings(d, ctx) {
  const sections = d.sections || [], at = s => (s.section || []).join('/'), sel = sections.some(c => c.id === ctx.setCat) ? ctx.setCat : sections[0]?.id;
  const nav = sections.map(c => {
    const rows = d.settings.filter(s => s.section?.[0] === c.id), mods = rows.filter(s => s.modified).length, basicIn = x => !!c.basic || rows.some(s => s.basic && s.section[1] === x);
    return `<button class="navcat${c.id === sel ? ' on' : ''}" id="nav-${esc(c.id)}" data-setcat="${esc(c.id)}" data-basic="${c.basic || rows.some(s => s.basic) ? 1 : 0}" aria-pressed="${c.id === sel}">${esc(c.label)}${mods ? `<span class="mcount" title="${mods} modified from default">${mods}</span>` : ''}</button>`
      + `<div class="navsubs">${c.subs.map(x => `<button class="navsub" data-setcat="${esc(c.id)}" data-basic="${basicIn(x.id) ? 1 : 0}" data-setsub="sub-${esc(c.id)}-${esc(x.id)}">${esc(x.label)}</button>`).join('')}</div>`;
  }).join('');
  const panes = sections.map(c => {
    const subs = c.info ? (c.id === 'notify' ? notifyPane(d) + remotePane(d.remote) : filesPane(d)) : c.subs.map(x => {
      const items = d.settings.filter(s => at(s) === `${c.id}/${x.id}` || at(s).startsWith(`${c.id}/${x.id}/`));
      const body = x.subs ? x.subs.map(y => { const g = items.filter(s => s.section[2] === y.id); return g.length ? (x.inline ? inlineGroup(c, x, y, g, x.id === 'routing' ? guardChip(guardOn(d.guard, r => r.type === 'models' && r.cls === y.id), { tab: 'usage', jump: 'usage-advice' }) : '') : g.map(row).join('')) : ''; }).join('') : items.map(row).join('');
      return `<div class="ssub${x.danger ? ' danger' : ''}" id="sub-${esc(c.id)}-${esc(x.id)}"><h3>${esc(x.label)}${x.help ? ` <span class="help">${esc(x.help)}</span>` : ''}</h3>${body}</div>`;
    }).join('');
    return `<section class="scat" id="cat-${esc(c.id)}" data-cat="${esc(c.id)}"${c.id === sel ? '' : ' hidden'}><h2>${esc(c.label)}</h2><p class="small mute">${esc(c.help)}</p>${subs}</section>`;
  }).join('');
  return `${profileBar(d, ctx.setLevel ?? 'basic')}<div class="settings"><aside class="snav"><input type="search" id="set-search" data-set-search placeholder="Search settings  ·  @modified" aria-label="Search settings">${nav}</aside>
   <div class="spane"><p class="small mute" id="set-nohit" hidden>No setting matches.</p>${panes}</div></div>
   <div class="savebar"><span class="small" id="dirty-count">No unsaved changes</span><button class="strong" data-act="settings-review" data-project="${esc(d.project)}" data-version="${esc(d.version)}">Review changes</button><button class="ghost" data-act="settings-discard">Discard</button>
   <span class="small mute">Review shows a diff; Save writes atomically and refuses a stale version (409).</span><div id="settings-diff"></div></div>`;
}

// ---------- usage (META-OPS-R1 #7): cost per lane / stage / executor / day from /api/usage (engine/lib/cost.mjs) ----------
/** Group roll-up rows by keys: Claude token types + % summed, Codex / provider tokens apart; sorted by % then Codex tokens. */
export function usageGroup(rows, keys) {
  const m = new Map();
  for (const r of rows) {
    const k = keys.map(x => r[x]).join('|');
    let g = m.get(k);
    if (!g) m.set(k, g = { ...Object.fromEntries(keys.map(x => [x, r[x]])), runs: 0, running: 0, cache_read: 0, cache_create: 0, input: 0, output: 0,
      pct: null, codex: 0, provider: 0, executors: [] });
    g.runs += r.runs; g.running += r.running;
    if (!g.executors.includes(r.executor)) g.executors.push(r.executor);
    if (r.family === 'claude') { for (const t of ['cache_read', 'cache_create', 'input', 'output']) g[t] += r[t] || 0; if (fin(r.pct)) g.pct = (g.pct ?? 0) + r.pct; }
    else if (r.family === 'codex') g.codex += r.tokens || 0;
    else if (r.family === 'provider') g.provider += r.tokens || 0;
  }
  return [...m.values()].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.codex - a.codex || String(keys.map(x => a[x])).localeCompare(String(keys.map(x => b[x]))));
}
const pct2 = n => (fin(n) ? `${n < 0.1 && n > 0 ? n.toFixed(3) : n.toFixed(2)} %` : '-');
// NAME-W2 item 5: '1 run' / '2 runs'; a share of the week that is not known says so (never '- of week')
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ofWeek = n => (fin(n) ? `${pct2(n)} of week` : '% of week not known');
const fmtS = s => (fin(s) ? (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`) : '-');
function usageTable(id, title, note, rows, keys, maxPct) {
  const head = keys.map(k => `<th>${esc(k === 'executor' ? 'agent CLI' : k)}</th>`).join('');
  const body = rows.map(g => `<tr>${keys.map((k, i) => `<td>${i ? esc(g[k]) : `<b>${esc(g[k])}</b>`}</td>`).join('')}
    <td class="mono">${g.runs}${g.running ? ' ' + chip('running', g.running + ' live') : ''}</td>
    <td class="small">${g.executors.map(e => chip(exClass(e), e)).join(' ')}</td>
    <td class="mono">${mTok(g.cache_read)}</td><td class="mono">${mTok(g.cache_create)}</td><td class="mono">${mTok(g.input)}</td><td class="mono">${mTok(g.output)}</td>
    <td style="width:16%">${fin(g.pct) ? `<span class="mono">${pct2(g.pct)}</span>${meter(g.pct, maxPct)}` : dash}</td>
    <td class="mono">${g.codex ? mTok(g.codex) : dash}</td><td class="mono">${g.provider ? mTok(g.provider) : dash}</td></tr>`).join('')
    || `<tr><td colspan="${keys.length + 9}" class="mute">No runs in the window.</td></tr>`;
  return `<div class="tablecard" id="${esc(id)}"><h3>${esc(title)} <span class="mute small">${esc(note)}</span></h3><table><thead><tr>${head}<th>runs</th><th>agent CLIs</th>
    <th>cache read</th><th>cache write</th><th>input</th><th>output</th><th>% of weekly Claude limit</th><th>Codex tokens</th><th>other-provider tokens</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
const fmtUtc = iso => { const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return '-';
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(t).getUTCDay()]} ${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z`; };
// gap #9: API billing - the project's $ per lane today / last 7 days, the dashboard chats on their own line (ended runs = the CLI's
// figure, running = a live estimate from tokens at list price, marked ~)
function apiSpend(s) {
  if (!s) return '';
  if (s.error) return `<section class="card" id="usage-spend"><h2>API spend</h2><div class="small mute">${esc(s.error)}</div></section>`;
  const $ = v => `$${(Number(v) || 0).toFixed(2)}`, lanes = (s.lanes || []).filter(g => g.week > 0 || g.live);
  const tot = k => lanes.reduce((a, g) => a + g[k], 0) + (s.chats?.[k] || 0);
  const rows = lanes.map(g => `<tr><td><b>${esc(g.lane)}</b>${g.live ? ' ' + chip('running', 'live') : ''}</td><td class="mono">${g.live ? '~' : ''}${$(g.today)}</td><td class="mono">${g.live ? '~' : ''}${$(g.week)}</td></tr>`).join('');
  const chat = s.chats && (s.chats.week > 0) ? `<tr id="usage-spend-chats"><td><b>dashboard chats</b></td><td class="mono">${$(s.chats.today)}</td><td class="mono">${$(s.chats.week)}</td></tr>` : '';
  return `<section class="card" id="usage-spend"><h2>API spend <b>${$(tot('today'))}</b> today <span class="mute small">${$(tot('week'))} in 7 days · per lane · ~ = a run still running (estimate from its tokens at list price)</span></h2>
   <table><thead><tr><th>lane</th><th>today</th><th>7 days</th></tr></thead><tbody>${rows + chat || '<tr><td colspan="3" class="mute">No spend in 7 days.</td></tr>'}</tbody></table></section>`;
}
function usagePart(p, ctx) {
  const t = p.totals, c = p.checkins, k = p.calib, rows = p.rows || [], sec = p.secondary;
  const head = p.window === 'week' ? `since the weekly reset ${fmtUtc(p.since)}` : `runs started in the last ${p.days} days (your weekly reset time is not set in Settings, so the window rolls)`;
  const secRows = sec ? `<span class="mute small">rolling ${sec.rolling.days} days</span><div class="mono" id="usage-rolling">${ofWeek(sec.rolling.pct)} · ${plural(sec.rolling.runs, 'run')} · ${mTok(sec.rolling.cache_read)} cache read</div>
     <span class="mute small">last 24 h</span><div class="mono" id="usage-24h">${ofWeek(sec.last24h.pct)} · ${plural(sec.last24h.runs, 'run')} · ${mTok(sec.last24h.cache_read)} cache read</div>` : '';
  const maxPct = Math.max(0.01, ...usageGroup(rows, ['lane']).map(g => g.pct ?? 0));
  // META-OPS-R3: the headline is the account's number (every Claude session since the reset) when the cache has it; lanes stay runs
  const A = p.account, hp = p.headline ? p.headline.pct : t.claude.pct, rf = ctx.refresh || {}, out = A ? A.outside : null;
  const acctRows = A ? `<span class="mute small">account, since the weekly reset</span><div class="mono"><b>${ofWeek(A.pct)}</b> <span class="small mute">every Claude session on your account</span> · ${int(A.messages)} messages · ${mTok(A.cache_read)} cache read · <span class="mute">cache age ${fmtS(A.age_s)}: counted ${esc(fmtUtc(A.at))}${rf.running ? ', refreshing' : ''}</span></div>
     <span class="mute small">runs Norn started</span><div class="mono">${ofWeek(t.claude.pct)} · ${plural(t.claude.runs, 'run')} <span class="small mute">(the lane rows below)</span></div>
     <span class="mute small">outside runs (interactive)</span><div class="mono"><b>${ofWeek(out.pct)}</b> · ${mTok(out.cache_read)} cache read${out.clamped ? ` <span class="small">(Norn's runs count more than the account shows, so this reads 0; the difference is ${out.raw_pct.toFixed(2)} %)</span>` : ''} <span class="small mute">your own Claude sessions, not started by Norn</span></div>`
    : `<span class="mute small">account: n/a</span><div class="small mute">${rf.running ? 'counting your whole account (the first count reads every Claude session file: minutes)' : 'this provider has no account-wide count'} - until then the number above counts only the runs Norn started</div>`;
  const pt = c.per_tick, l24 = c.last24h;
  const ck = c.ticks ? `<div class="kv">
     <span class="mute small">last 24 h</span><div><span class="big">${l24.ticks}</span> check-ins · ${mTok(l24.cache_read)} cache read · ${mTok(l24.cache_create)} cache write · <b>${ofWeek(l24.pct)}</b></div>
     <span class="mute small">check-ins per day</span><div><b>${c.ticks_per_day.toFixed(1)}</b> <span class="mute">(${c.ticks} in ${(c.days ?? p.days).toFixed(1)} days)</span> · ${fmtS(c.mean_s)} each on average</div>
     <span class="mute small">per check-in, on average</span><div class="mono">${mTok(pt.cache_read)} cache read · ${mTok(pt.cache_create)} cache write · ${int(pt.input)} input · ${mTok(pt.output)} output · ${ofWeek(pt.pct)}</div>
     <span class="mute small">% of week per day</span><div><b>${pct2(c.pct_per_day)}</b> <span class="small mute">what the check-ins cost you each day</span></div></div>`
    : '<div class="small mute">No check-in with measured usage in this window.</div>';
  return `<div id="usage-${esc(p.project)}">${ctx.project === 'all' ? `<h2>${esc(p.project)}</h2>` : ''}${apiSpend(p.spend)}
   <div class="grid2"><section class="card" id="usage-summary"><h2>${fin(hp) ? `Usage <b style="white-space:nowrap">${pct2(hp)}</b> of your weekly Claude limit` : 'Usage: not known yet - set your weekly limit in Settings > Usage calibration'} <span class="mute small">${A ? 'your whole Claude account' : 'the runs Norn started'}, ${esc(head)}${p.next_reset ? ` · next reset ${esc(fmtUtc(p.next_reset))}` : ''}</span></h2>
     <div class="kv" id="usage-account">${acctRows}</div><div class="kv">${secRows}<span class="mute small">Claude tokens</span><div class="mono">${plural(t.claude.runs, 'run')} · ${mTok(t.claude.cache_read)} cache read · ${mTok(t.claude.cache_create)} cache write · ${mTok(t.claude.input)} input · ${mTok(t.claude.output)} output</div>
     <span class="mute small">Codex tokens</span><div class="mono">${plural(t.codex.runs, 'run')} · ${mTok(t.codex.tokens)} tokens <span class="small mute">(Codex has its own plan: totals only, not in the Claude %)</span></div>
     <span class="mute small">other providers</span><div class="mono">${plural(t.provider.runs, 'run')} · ${mTok(t.provider.tokens)} tokens <span class="small mute">(agents on your own API keys; not in the Claude %)</span></div>
     <span class="mute small">not measured</span><div class="small">${plural(t.unmeasured, 'run')} <span class="mute">(the agent reported no usage and left no session file to count)</span></div>
     <span class="mute small">scale</span><div class="small">${fin(k.cacheR_per_pct) ? `${mTok(k.cacheR_per_pct)} cache-read tokens = 1 % of your week` : 'not set, so no % is shown: enter the % from your claude.ai usage page in Settings > Usage calibration (or norn calib --pct N)'}
       <div class="mute">other token types count by price, in cache reads: 1 input = ${k.weights.input}, 1 output = ${k.weights.output}, 1 cache write = ${k.weights.cache_create_1h} (kept 1 h) / ${k.weights.cache_create_5m} (kept 5 min)${fin(k.mix) ? ` · this window: 1 token = ${k.mix.toFixed(3)} cache reads on average` : ''}</div></div>
     <span class="mute small">counted</span><div class="small mute">${plural(p.cost.runs, 'run')} in ${p.cost.ms.toFixed(1)} ms · ${mTok(p.cost.bytesRead)} bytes of session files read</div></div></section>
   <section class="card" id="usage-checkins"><h2>Check-ins <span class="mute small">the short agent turns that review finished runs and start the next (norn tick, or the scheduler every 15 min)</span></h2>${ck}</section></div>
   ${adviceStrip(p.advice, ctx)}
   ${classCard(p.classes, p.advice)}
   ${replayCard(p.replay)}
   ${weekCard(p.week)}
   ${usageTable('usage-lane', 'By lane', 'each line of work (its own branch), in this window', usageGroup(rows, ['lane']), ['lane'], maxPct)}
   ${usageTable('usage-stage', 'By lane and stage', 'each step of a lane', usageGroup(rows, ['lane', 'stage']), ['lane', 'stage'], maxPct)}
   ${usageTable('usage-executor', 'By agent CLI', 'claude, codex, or fake (the free rehearsal)', usageGroup(rows, ['executor']), ['executor'], maxPct)}
   ${usageTable('usage-day', 'By day', 'the day the run started (UTC)', usageGroup(rows, ['day']).sort((a, b) => String(b.day).localeCompare(String(a.day))), ['day'], maxPct)}</div>`;
}
// META-GUARD R1 item 2: where the week's tokens went - per lane + stage, outcomes, merged, per merged branch; the top 5 spenders with why
const pcA = x => (fin(x) ? '~' + pct2(x) : dash);
function weekCard(w) {
  if (!w || w.error) return w?.error ? `<div class="tablecard" id="usage-week"><h3>Where the tokens went</h3><div class="small mute">${esc(w.error)}</div></div>` : '';
  const body = (w.rows || []).map(r => `<tr><td><b>${esc(r.lane)}</b></td><td>${esc(r.stage)}</td><td class="mono">${r.runs}${r.running ? ' ' + chip('running', r.running + ' live') : ''}</td>
    <td class="mono">${mTok(r.tokens.input)}</td><td class="mono">${mTok(r.tokens.cache_create)}</td><td class="mono">${mTok(r.tokens.cache_read)}</td><td class="mono">${mTok(r.tokens.output)}</td>
    <td class="mono">${pcA(r.pct)}</td><td class="small">${r.outcomes.done} done · ${r.outcomes.stopped} stopped · ${r.outcomes.handoff} handoff</td><td class="mono">${r.merged}</td>
    <td class="mono small">${r.per_merged ? `${mTok(r.per_merged.cache_read)} cache read · ${mTok(r.per_merged.output)} out${fin(r.per_merged.pct) ? ' · ' + pcA(r.per_merged.pct) : ''}` : dash}</td></tr>`).join('')
    || '<tr><td colspan="11" class="mute">No runs in the window.</td></tr>';
  const top = (w.top || []).map(t => `<li><span class="id">${esc(t.id)}</span> <b>${esc(t.lane)}</b> ${esc(t.stage)} ${chip(t.outcome === 'done' ? 'done' : t.state === 'running' ? 'running' : 'idle', t.outcome ?? t.state)} <span class="mono">${pcA(t.pct)}</span> · ${mTok(t.cache_read)} cache read <span class="small mute">- ${esc(t.why)}</span></li>`).join('');
  return `<div class="tablecard" id="usage-week"><h3>Where the tokens went <span class="mute small">${w.window === 'week' ? 'since the weekly reset' : 'last 7 days'} · ${plural(w.totals.runs, 'run')} · ${fin(w.totals.pct) ? pcA(w.totals.pct) + ' of your weekly Claude limit' : '% of your weekly Claude limit not known'} · ${w.totals.merged} merged into main · the four token types are counted apart, never added up</span></h3>
   <table><thead><tr><th>lane</th><th>stage</th><th>runs</th><th>input</th><th>cache write</th><th>cache read</th><th>output</th><th>~% of week</th><th>how the runs ended</th><th>merged</th><th>tokens per merged branch</th></tr></thead><tbody>${body}</tbody></table>
   <h3 style="margin-top:10px">Top 5 spenders <span class="mute small">the runs that used the most; why = turns x average context size (every turn re-reads the whole context)</span></h3><ol id="usage-top" class="small">${top || '<li class="mute">none</li>'}</ol></div>`;
}
// META-TEND P2 (REPORT 4.3): what each kind of work costs - per FINISHED task (a stage that reached DONE; its resumes, hand-offs and
// fix rounds counted in), by kind of work, by model, and the full class x executor x model x effort grid; the week's Fable runs (Q4).
// On the shared widgets (META-TEND P6, REPORT 5.3): per kind and per model = `bars`, the grid's cells = `meter`. cost = weighted tokens in cache-read units.
const rate = x => (fin(x) ? Math.round(100 * x) + ' %' : '-');
const srcChip = r => (r.src === 'inferred' ? ' ' + chip('idle', 'inferred') : '');
function classCard(c, adv = null) {
  const advOn = cls => guardChip((adv?.cards || []).filter(x => x.id === cls && !x.decided).map(x => ({ severity: x.severity, why: x.title })), { tab: 'usage', jump: 'usage-advice' });   // META-TEND P6: the chip in place
  if (!c) return '';
  if (c.error) return `<div class="tablecard" id="usage-class"><h3>What each kind of work costs</h3><div class="small mute">${esc(c.error)}</div></div>`;
  const maxCost = Math.max(1, ...c.byClass.map(r => r.cost_per_done ?? 0), ...c.byClassModel.map(r => r.cost_per_done ?? 0));
  const ended = r => `${r.done} of ${r.stages} done · ${rate(r.stop_rate)} stopped · ${rate(r.merged_rate)} merged`;
  const none = n => `<tr><td colspan="${n}" class="mute">No finished stage in the window.</td></tr>`;
  const noneP = '<p class="small mute" style="padding:0 12px">No finished stage in the window.</p>';
  const kind = c.byClass.length ? bars(c.byClass.map(r => ({ label: r.label, value: r.cost_per_done ?? 0,
    note: `${ended(r)} · ${fin(r.runs_per_done) ? r.runs_per_done.toFixed(1) : '-'} runs per finished task${srcChip(r)}${advOn(r.class)}` })), { id: 'usage-class-kind', max: maxCost, fmt: v => v ? mTok(v) : '-' }) : noneP;
  const model = c.byClassModel.length ? bars(c.byClassModel.map(r => ({ label: `${r.label} · ${r.model}`, value: r.cost_per_done ?? 0, note: `${ended(r)}${srcChip(r)}` })),
    { id: 'usage-class-model', max: maxCost, fmt: v => v ? mTok(v) : '-' }) : noneP;
  const maxCr = Math.max(1, ...c.rows.map(r => r.cache_read.p90 ?? 0));
  const grid = c.rows.map(r => `<tr><td><b>${esc(r.label)}</b>${srcChip(r)}</td><td>${esc(r.executor)}</td><td>${esc(r.model)}</td><td>${esc(r.effort)}</td>
    <td class="mono">${r.stages}</td><td class="mono">${r.runs}</td><td class="mono">${rate(r.done_rate)}</td><td class="mono">${rate(r.stop_rate)}</td><td class="mono">${rate(r.merged_rate)}</td>
    <td style="width:14%">${fin(r.cache_read.median) ? `<span class="mono">${mTok(r.cache_read.median)} / ${mTok(r.cache_read.p90)}</span>${meter(r.cache_read.median, maxCr, r.cache_read.p90)}` : dash}</td>
    <td class="mono">${fin(r.output.median) ? mTok(r.output.median) : dash}</td><td class="mono">${fin(r.cost_per_done) ? mTok(r.cost_per_done) : dash}</td>
    <td class="small mute">${esc(r.basis.join(', '))}</td></tr>`).join('') || none(13);
  const f = c.fable || { count: 0, runs: [] };
  const fable = `<div class="small" id="usage-fable" style="padding:6px 12px">${chip(f.count ? 'warn' : 'idle', plural(f.count, 'Fable run'))} this window <span class="mute">- Fable is the cost class: the hardest long work only${f.count ? ': ' + f.runs.map(esc).join(', ') : ''}</span></div>`;
  return `<div class="tablecard" id="usage-class"><h3>What each kind of work costs <span class="mute small">per finished task</span></h3>
   <div class="small mute" style="padding:0 12px">A finished task = a stage that reached DONE, its resumes, hand-offs and fix rounds counted in. Cost = weighted tokens in cache-read units (all its stages, finished or not, / finished ones). ${plural(c.open, 'stage')} still open left out.${c.inferred_runs ? ` ${plural(c.inferred_runs, 'run')} from before the class stamp: class inferred, kept in their own rows.` : ''}</div>
   ${fable}
   <h3 style="margin-top:6px">Per kind of work <span class="mute small">cost per finished task</span></h3>${kind}
   <h3 style="margin-top:10px">By model <span class="mute small">cost per finished task</span></h3>${model}
   <h3 style="margin-top:10px">Class x agent x model x effort <span class="mute small">cache reads per finished task: median / p90 (the bar's tick)</span></h3>
   <table id="usage-class-grid"><thead><tr><th>kind of work</th><th>agent</th><th>model</th><th>effort</th><th>stages</th><th>runs</th><th>done</th><th>stopped</th><th>merged</th><th>cache read</th><th>output</th><th>cost</th><th>class from</th></tr></thead><tbody>${grid}</tbody></table></div>`;
}
// META-TEND P4: the Advice strip - the open cards (the Inbox shows the same), the vendor sources with the day each was read
function adviceStrip(a, ctx) {
  if (!a) return '';
  if (a.error) return `<section class="card" id="usage-advice"><h2>Advice</h2><div class="small mute">${esc(a.error)}</div></section>`;
  const srcs = [...new Map((a.sources || []).map(s => [s.ref + s.read, s])).values()];
  const dated = srcs.map(s => `${esc(s.ref)} ${esc(s.read)}${s.stale ? ' ' + chip('warn', 'stale') : ''}`).join(' · ');
  const cards = (a.cards || []).map(c => adviceRow({ ...c, project: a.project }, { ...ctx, project: a.project })).join('');
  return `<section class="card" id="usage-advice"><h2>Advice <span class="mute small">${plural((a.cards || []).length, 'open card')}${a.decided ? ` · ${a.decided} decided` : ''} · what the vendors say vs what the work cost here</span></h2>
   ${cards || `<div class="small">${chip('ok', 'all clear')} <span class="mute">No advice: no class sits above the vendor's starting effort or on a pricier model than its work needs.</span></div>`}
   <div class="small mute" id="usage-advice-sources" style="margin-top:6px">Vendor guidance (engine/presets/advice/models.json), read: ${dated || '-'}${a.stale?.length ? ` - ${plural(a.stale.length, 'source')} past the re-read date` : ''}</div></section>`;
}
// META-TEND P4 (owner Q2): the replay test - recorded check-in rulings vs cheaper models on the same frozen inputs (norn eval report)
const VERDICT = { agree: 'ok', harmless: 'idle', refused: 'refused', recoverable: 'warn', harmful: 'bad', error: 'bad' };
// META-CHECKIN-GUARDS R1: a tick's verdicts as one split bar (the shared stack widget; refused = a guard refused the move in code)
const VERDICT_PARTS = [['agree', 'agree'], ['harmless', 'harmless'], ['refused', 'refused by a guard'], ['recoverable', 'recoverable'], ['harmful', 'harmful'], ['errors', 'error']];
const verdictStack = (t, id) => stack(VERDICT_PARTS.map(([k, label]) => ({ key: 'v-' + k, label, value: t[k] ?? 0 })), { id });
function guardsBlock(r, short) {
  if (!r.before) return '';
  const g = r.guard_history, rows = r.arms.map((a, i) => { const b = r.before.arms_total.find(t => t.arm === a), t = r.arms_total.find(x => x.arm === a);
    return `<tr><td><b>${esc(short(a))}</b></td><td data-label="before">${b ? verdictStack(b, `usage-replay-before-${i}`) : dash}</td><td data-label="after">${t ? verdictStack(t, `usage-replay-after-${i}`) : dash}</td></tr>`; }).join('');
  return `<h3 style="margin-top:8px">Before / after the check-in guards <span class="mute small">the same stored moves graded again: a move a guard refuses in code never happens (exit 6 lane busy, exit 2 owner-only ask)</span></h3>
   <table id="usage-replay-guards"><thead><tr><th>model</th><th>before</th><th>after</th></tr></thead><tbody>${rows}</tbody></table>
   ${g ? `<div class="small mute" id="usage-replay-history">Guard check on the recorded history: ${g.dispatches} check-in dispatches, ${g.busy.length} refused by "lane busy"${g.dup.length ? ` (${g.dup.length} more meet the older duplicate check first)` : ''}; ${g.rulings} check-in rulings of a question, ${g.owner_only.length} refused by "owner-only ask".</div>` : ''}`;
}
function replayCard(r) {
  if (!r || !r.arms?.length) return '';
  const short = a => a.replace(/^claude:claude-/, '').replace(/:/g, ' ');
  const tot = bars(r.arms_total.map(t => ({ label: `${short(t.arm)} (${t.ticks} ticks)`, value: t.agree, note: `${t.harmless} harmless · ${t.refused ?? 0} refused · ${t.recoverable} recoverable · ${t.harmful} harmful · ${t.errors} errors · ${mTok(t.tokens)} tokens` })),
    { id: 'usage-replay-arms', max: Math.max(1, ...r.arms_total.map(t => t.ticks)), fmt: v => `${v} agree` });
  const clsNames = [...new Set(r.classes.map(c => c.cls))];
  const per = clsNames.map(k => `<tr><td><b>${esc(k)}</b></td>${r.arms.map(a => { const c = r.classes.find(x => x.arm === a && x.cls === k);
    const off = c ? ['refused', 'harmful'].filter(x => c[x]).map(x => `${c[x]} ${x}`).join(' · ') : '';
    return `<td style="width:30%">${c ? `<span class="mono">${c.agree} of ${c.recorded}</span>${meter(c.agree, Math.max(1, c.recorded))}${off ? `<div class="small mute">${esc(off)}</div>` : ''}` : dash}</td>`; }).join('')}</tr>`).join('');
  const cell = x => (x ? `${chip(VERDICT[x.verdict] || 'idle', x.verdict)}<div class="small">${x.cand.map(esc).join('<br>')}</div>${x.verdict !== 'agree' && x.why?.length ? `<div class="small mute">${x.why.slice(0, 4).map(esc).join('<br>')}${x.why.length > 4 ? `<br>+${x.why.length - 4} more` : ''}</div>` : ''}` : dash);
  const side = r.ticks.map(t => `<tr><td class="id">${esc(t.tick)}</td><td class="small">${esc(t.stratum)}</td><td data-label="recorded" class="small">${t.recorded.length ? t.recorded.map(esc).join('<br>') : '<span class="mute">nothing</span>'}</td>${r.arms.map(a => `<td data-label="${esc(short(a))}">${cell(t.arms[a])}</td>`).join('')}</tr>`).join('');
  return `<div class="tablecard" id="usage-replay"><h3>Cheaper check-ins: the replay test <span class="mute small">recorded check-ins re-run offline on the same inputs · ${esc(r.project ?? '')} · ${esc(String(r.at ?? '').slice(0, 16))}</span></h3>
   <h3 style="margin-top:4px">Ticks that agree, per model</h3>${tot}
   ${guardsBlock(r, short)}
   <h3 style="margin-top:8px">Agreement per class of ruling</h3><table id="usage-replay-class"><thead><tr><th>ruling</th>${r.arms.map(a => `<th>${esc(short(a))}</th>`).join('')}</tr></thead><tbody>${per}</tbody></table>
   <h3 style="margin-top:8px">Side by side <span class="mute small">the recorded ruling vs each cheaper model; ${plural(r.choices?.length ?? 0, 'same-lane ruling')} with a different choice</span></h3>
   <table id="usage-replay-side"><thead><tr><th>tick</th><th>class</th><th>recorded</th>${r.arms.map(a => `<th>${esc(short(a))}</th>`).join('')}</tr></thead><tbody>${side}</tbody></table></div>`;
}
function usage(d, ctx) {
  const parts = d.parts || [];
  return `<div class="banner">How much of your Claude plan the work used. "% of week" = the share of your weekly Claude usage limit, estimated from token counts (the scale below). Token types: input (new text sent to the model), output (text it wrote), cache write (context stored for reuse), cache read (stored context re-read on every turn, usually the biggest). k = thousand, M = million tokens. Codex has its own plan: only its token totals are shown.
   ${d.cached ? 'Updated every 15 s.' : `Counted in ${fin(d.ms) ? d.ms.toFixed(0) : '-'} ms.`}</div>
   ${parts.map(p => usagePart(p, { ...ctx, refresh: d.account_refresh })).join('') || '<p class="mute">No project.</p>'}`;
}

// ---------- the Roadmap tab (META-ROADMAP S2, SPEC sec. 4 option A; owner Q-17): the tree with a NOW line ----------
// One tree per project from /api/roadmap (derived status, never typed). Per theme: the past folded above a NOW rule, the present
// rows in full, the future folded below. The scope strip is a tap-to-filter switch (Urd was / Verdandi is / Skuld shall be; classic:
// Past / Now / Next; tap the active one again = all; the scope lives in the URL hash). Every row carries a time line: first activity
// -> now with one stretch per run (colour = run state) and a NOW tick, one shared window per theme; planned rows a dashed stub.
// The views list: a switch is drawn only when there is more than one. S2b (owner Q-17): the board (Urd was / Verdandi is / Skuld
// shall be columns, the themes as rows aligned across them) is the second view; the tree stays the default.
export const RM_VIEWS = [['tree', 'Tree'], ['board', 'Board']];
const rmView = f => (RM_VIEWS.some(v => v[0] === f?.view) ? f.view : RM_VIEWS[0][0]);
export const RM_SCOPES = ['past', 'present', 'future'];
const RM_ST = { shipped: ['shipped', 'ok'], dropped: ['dropped', 'idle'], building: ['building', 'running'], waiting: ['needs you', 'needs'], built: ['built, not merged', 'warn'],
  merged: ['merged, not installed', 'warn'], queued: ['queued', 'idle'], planned: ['planned', 'idle'], idea: ['idea', 'idle'] };
const RM_SG = { done: 'ok', live: 'running', queued: 'idle', planned: 'plan', stopped: 'bad', handoff: 'warn', ended: 'warn', killed: 'bad', lost: 'bad' };
const RM_WORDS = { norn: [['Urd', 'was'], ['Verdandi', 'is'], ['Skuld', 'shall be']], classic: [['Past', 'done'], ['Now', 'in flight'], ['Next', 'planned']] };
const RM_NOW = 88;   // % of a time line: the theme window 0 .. 88, NOW at 88, the future side (stubs, no dates) 88 .. 100
/** the scope after a tap: the tapped one, or all (null) when it was already active */
export const rmScopeNext = (cur, tapped) => (cur === tapped ? null : tapped);
// the hash: the tree keeps the S2 words (#past, #rm-RM-3); another view is a prefix (#board, #board-past, #board-rm-RM-3)
const rmPre = view => (view && view !== RM_VIEWS[0][0] && RM_VIEWS.some(v => v[0] === view) ? view : '');
export const rmHash = (scope, view) => { const p = rmPre(view), s = RM_SCOPES.includes(scope) ? scope : ''; return p || s ? '#' + [p, s].filter(Boolean).join('-') : ''; };
/** the whole Roadmap hash from its state: a deep link wins over the scope; the view rides along */
export const rmUrlHash = (rm = {}) => (rm.item ? `#${rmPre(rm.view) ? rmPre(rm.view) + '-' : ''}rm-${rm.item}` : rmHash(rm.scope, rm.view));
/** '#past' -> { scope }, '#rm-RM-3' -> { item } (a deep link), '#board-past' -> { view, scope }, anything else -> {} */
export function parseRmHash(h) {
  let s = String(h || '').replace(/^#/, '');
  const v = RM_VIEWS.find(([k]) => s === k || s.startsWith(k + '-'))?.[0], o = v ? { view: v } : {};
  if (v) s = s.slice(v.length + 1);
  if (!s) return o;
  if (RM_SCOPES.includes(s)) return { ...o, scope: s };
  const m = s.match(/^rm-(RM-\d+)$/);
  return m ? { ...o, item: m[1] } : {};
}
/** one item against the filters (scope, theme, status, live only, drift only, text over title / id / links / branches); pure */
export function rmMatch(i, f = {}, theme = null) {
  if (f.scope && i.phase !== f.scope) return false;
  if (f.theme && theme && f.theme !== theme) return false;
  if (f.status && i.status !== f.status) return false;
  if (f.live && !(i.live || []).length) return false;
  if (f.drift && !(i.flags?.drift || []).length) return false;
  const q = String(f.q || '').trim().toLowerCase();
  if (q && !q.split(/\s+/).every(w => [i.title, i.id, ...(i.links || []), ...(i.branches || []).map(b => b.name)].join(' ').toLowerCase().includes(w))) return false;
  return true;
}
const rmFiltered = f => !!(f.scope || f.theme || f.status || f.live || f.drift || String(f.q || '').trim());
const rmAgo = (iso, now) => { if (!iso) return ''; const d = (now - Date.parse(iso)) / 864e5; return d < 1 ? `${Math.max(1, Math.round(d * 24))} h ago` : `${Math.round(d)} d ago`; };
const rmDay = iso => (iso ? new Date(iso).toISOString().slice(5, 10) : '');
const rmFlat = (ns, depth = 0) => ns.flatMap(n => [...(n.kind === 'item' ? [{ ...n, depth }] : []), ...rmFlat(n.children || [], n.kind === 'item' ? depth + 1 : depth)]);
// an id as the dashboard's id chip: DIR / DEC / Q / RUN / L: jump to their tab, DLV opens the drawer
function rmRid(id, ctx) {
  if (/^DLV-/.test(id)) return `<a class="rid r-dlv" href="#" data-dlv="${esc(id)}" data-project="${esc(ctx.project)}">${esc(id)}</a>`;
  const k = id.split(/[-:]/)[0].toLowerCase();
  return `<a class="rid r-${k === 'l' ? 'l' : esc(k)}" href="#" data-rid="${esc(id)}">${esc(id)}</a>`;
}
const rmChip = i => `<span class="chip ${(RM_ST[i.status] || ['', 'idle'])[1]}">${esc((RM_ST[i.status] || [i.status])[0])}</span>${i.flags?.claimed ? `<span class="chip idle claimed" title="${esc(i.flags.claimed)}">claimed</span>` : ''}`;
const rmLive = (i, ctx) => (i.live || []).map(id => `<span class="rmlive" role="button" tabindex="0" data-feed="${esc(id)}" data-project="${esc(ctx.project)}" title="open the live feed"><i></i>${esc(id)}</span>`).join('');
const rmProg = i => (i.progress?.total ? `<span class="rmprog" title="stages DONE + branches at the target, of all"><span class="bar"><i style="width:${Math.round(100 * i.progress.done / i.progress.total)}%"></i></span>${i.progress.done}/${i.progress.total}</span>` : '');
function rmStages(i, max = 7) {
  const real = (i.stages || []).filter(s => s.state !== 'planned'), plan = (i.stages || []).filter(s => s.state === 'planned');
  const cut = Math.max(0, real.length - max), shown = real.slice(cut).concat(plan);
  if (!shown.length) return '';
  return `<div class="rmstages">${cut ? `<span class="mute small">+${cut} earlier</span>` : ''}${shown.map(s => `<span class="rmst sg-${RM_SG[s.state] || 'idle'}" title="${esc(s.lane ? `lane ${s.lane}, ` : '')}${s.runs || 0} run(s)${s.run ? `, latest ${s.run}` : ''}"><i></i>${esc(s.key)}<small>${esc(s.state)}</small></span>`).join('')}</div>`;
}
function rmLinks(i, ctx) {
  const by = k => (i.links || []).filter(t => t.startsWith(k + ':')).map(t => t.slice(k.length + 1));
  const ids = [...by('dir'), ...by('dec'), ...by('q'), ...by('ep'), ...by('run'), ...by('dlv'), ...by('lane').map(l => 'L:' + l)];
  const shown = ids.slice(0, 8).map(id => rmRid(id, ctx)).join(' ') + (ids.length > 8 ? ` <span class="mute small">+${ids.length - 8}</span>` : '');
  const known = new Set((i.branches || []).map(b => b.name));
  const br = [...(i.branches || []), ...by('branch').filter(b => !known.has(b)).map(name => ({ name, state: null }))].slice(0, 3)
    .map(b => `<span class="rmbr b-${esc(b.state || 'linked')}">${esc(b.name)}${b.dlv ? ' ' + rmRid(b.dlv, ctx) : ''}${b.state ? ` <small>${esc(b.state === 'done' ? 'not on main' : b.state)}</small>` : ''}</span>`).join(' ');
  return [shown, br].filter(Boolean).join(' ');
}
/** the theme's shared time window: the oldest first activity (or evidence) of any of its items .. now; null when none has a date */
function rmWindow(items, now) {
  const ts = items.flatMap(i => [i.first, i.last_evidence]).filter(Boolean).map(Date.parse).filter(Number.isFinite);
  if (!ts.length) return null;
  const t0 = Math.min(now, ...ts);
  return { t0, span: Math.max(now - t0, 36e5), now };
}
const rmPct = x => Math.round(x * 10) / 10;
/** one row's time line: a track to NOW, the item's thread, one stretch per run, a knot for dated evidence without runs, a stub for the future */
function rmTime(i, win) {
  const x = t => rmPct(RM_NOW * Math.min(1, Math.max(0, (t - win.t0) / win.span)));
  const spans = win ? (i.spans || []) : [];
  const parts = [];
  if (spans.length) {
    const a = x(Date.parse(spans[0].from)), end = i.phase === 'past' ? Math.max(...spans.map(s => (s.to ? Date.parse(s.to) : win.now))) : win.now;
    parts.push(`<i class="rmthr" style="left:${a}%;width:${rmPct(x(end) - a)}%"></i>`);
    for (const s of spans) {
      const l = x(Date.parse(s.from)), r = s.to ? x(Date.parse(s.to)) : RM_NOW;
      parts.push(`<i class="rmsp sg-${RM_SG[s.state] || 'idle'}" style="left:${l}%;width:${rmPct(r - l)}%" title="${esc(`${s.run} ${s.state} ${rmDay(s.from)}${s.to ? ' to ' + rmDay(s.to) : ', live'}`)}"></i>`);
    }
  } else if (win && i.last_evidence) parts.push(`<i class="rmknot" style="left:${x(Date.parse(i.last_evidence))}%" title="${esc('evidence ' + rmDay(i.last_evidence))}"></i>`);
  if (i.phase === 'future' || (i.stages || []).some(s => s.state === 'planned') || (i.queued || []).length) parts.push('<i class="rmstub"></i>');
  const label = spans.length ? `${spans.length} run${spans.length === 1 ? '' : 's'} since ${rmDay(spans[0].from)}` : i.phase === 'future' ? `${i.status}, no dates yet` : 'no runs';
  return `<div class="rmtl${spans.length ? '' : ' empty'}" role="img" aria-label="${esc('time line: ' + label)}" title="${esc(label)}"><i class="rmtrack"></i>${parts.join('')}<i class="rmnow"></i></div>`;
}
const rmHead = (i, ctx, par, compact) => `<div class="rmh">${rmChip(i)}${par}<b class="rmt">${esc(i.title)}</b><span class="id">${esc(i.id)}</span>${i.horizon ? `<span class="tg tg-hz">${esc(i.horizon)}</span>` : ''}${rmLive(i, ctx)}${(i.flags?.drift || []).length ? '<span class="chip bad">drift</span>' : ''}${i.stuck?.flag ? `<span class="chip bad" title="${esc('stuck since ' + i.stuck.flag.ts.slice(0, 16) + 'Z: ' + i.stuck.flag.why.join(', ') + ' - further rounds wait for an approach review')}">stuck</span>` : ''}${compact ? '' : rmProg(i)}${rmEditBtn(i)}</div>`;
function rmRow(i, ctx, win, compact) {
  const f = ctx.rm || {}, hit = f.item === i.id ? ' hit' : '';
  const par = i.depth ? `<span class="rmpar mute small" title="nested item">${'&#8250; '.repeat(i.depth)}</span>` : '';
  const head = rmHead(i, ctx, par, compact);
  const why = `<span class="mute">${esc(i.why)}${compact && i.last ? ' · ' + rmAgo(i.last, ctx.now) : ''}${i.flags?.idle != null ? ` · idle ${i.flags.idle} d` : ''}${i.stuck?.runs ? ` · ${i.stuck.runs} runs, ${i.stuck.days} days, ${i.stuck.stopped_row} stopped in a row` : ''}</span>`;   // META-CATCH S1 (stuck.mjs)
  const body = compact ? `<div class="rmw small">${why} ${rmLinks(i, ctx)}</div>`
    : `<div class="rmw small">${why} ${rmLinks(i, ctx)}</div>${rmStages(i)}${(i.flags?.drift || []).length || (i.flags?.gone || []).length ? `<div class="rmdrift">${i.flags.drift.map(d => `<div>Drift: ${esc(d)}</div>`).join('')}${(i.flags.gone || []).map(g => `<div>Link gone: ${esc(g)}</div>`).join('')}</div>` : ''}`;
  return `<div class="rmi${compact ? ' c' : ''} ph-${esc(i.phase)}${hit}" id="rm-${esc(i.id)}" data-rm-row>${head}${rmTime(i, win)}${body}</div>`;   // desktop: the time line in its own column; phone: under the title
}
const rmPlural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const rmFoldText = (items, phase) => (phase === 'past' ? [['shipped', 'shipped'], ['dropped', 'dropped']] : [['queued', 'queued'], ['planned', 'planned'], ['idea', 'idea']])
  .map(([k, w]) => [items.filter(i => i.status === k).length, w]).filter(([n]) => n).map(([n, w]) => (w === 'idea' ? rmPlural(n, 'idea') : `${n} ${w}`)).join(' · ');
const rmFutOrder = i => ['queued', 'planned', 'idea'].indexOf(i.status) * 10 + ({ now: 0, next: 1, later: 3 }[i.horizon] ?? 2);
const RM_SORT = { past: (a, b) => String(b.last || '').localeCompare(String(a.last || '')), present: (a, b) => ((b.live || []).length - (a.live || []).length) || String(b.last || '').localeCompare(String(a.last || '')),
  future: (a, b) => rmFutOrder(a) - rmFutOrder(b) };
const rmPhase = (xs, k) => xs.filter(i => i.phase === k).sort(RM_SORT[k]);
function rmTheme(t, d, ctx, nThemes) {
  const f = ctx.rm || {}, now = ctx.now, filtered = rmFiltered(f);
  const all = rmFlat(t.children || []), win = rmWindow(all, Date.parse(d.generated) || now);
  const vis = all.filter(i => rmMatch(i, f, t.id));
  if (filtered && !vis.length && !all.some(i => i.id === f.item)) return '';
  const [past, pres, fut] = RM_SCOPES.map(k => rmPhase(vis, k));
  const deep = id => [past, pres, fut].findIndex(g => g.some(i => i.id === id));
  const live = all.filter(i => (i.live || []).length).length, c = t.counts || {}, tot = Math.max(1, all.length);
  const open = filtered || deep(f.item) >= 0 || live > 0 || (nThemes <= 5 && (c.present || 0) > 0);
  const rows = (xs, compact) => xs.map(i => rmRow(i, ctx, win, compact)).join('');
  const fold = (xs, ph, isOpen) => (xs.length ? `<details class="rmfold f-${ph}"${isOpen ? ' open' : ''}><summary>${rmFoldText(xs, ph) || rmPlural(xs.length, 'item')}${ph === 'past' ? `<span class="mute small"> · latest ${rmAgo(xs[0].last, now) || 'n/a'}</span>` : ''}</summary>${rows(xs, true)}</details>` : '');
  const winText = win ? `time line ${rmDay(new Date(win.t0).toISOString())} to now` : 'no run yet';
  return `<details class="rmth" id="rmt-${esc(t.id)}"${open ? ' open' : ''}><summary><span class="tw"></span><b>${esc(t.title)}</b><span class="id">${esc(t.id)}</span>${t.state === 'dropped' ? '<span class="chip idle">dropped</span>' : ''}${rmEditBtn(t)}
    <span class="rmthread mini" aria-hidden="true"><i class="th-past" style="flex:${(c.past || 0) / tot}"></i><i class="th-present" style="flex:${(c.present || 0) / tot}"></i><i class="th-future" style="flex:${(c.future || 0) / tot}"></i></span>
    <span class="small mute">${c.past || 0} was · <b class="c-now">${c.present || 0} is</b> · ${c.future || 0} shall be · ${winText}</span>${live ? `<span class="chip running">${live} live</span>` : ''}</summary>
    <div class="rmbody">${fold(past, 'past', filtered || deep(f.item) === 0)}<div class="nowline"><span>NOW</span></div>${f.scope === 'past' || f.scope === 'future' ? '' : rows(pres, false) || '<div class="rmi c mute small">nothing in flight</div>'}${fold(fut, 'future', filtered || deep(f.item) === 2 || fut.length <= 3)}</div></details>`;
}
function rmTop(d, ctx) {
  const f = ctx.rm || {}, c = d.counts || {}, tot = Math.max(1, c.items || 0), words = RM_WORDS[ctx.look === 'norn' ? 'norn' : 'classic'];
  const scope = RM_SCOPES.map((k, n) => `<button type="button" class="sc sc-${k}" data-rm-scope="${k}" aria-pressed="${f.scope === k}" title="${f.scope === k ? 'show all again' : `show only ${['what was', 'what is', 'what shall be'][n]}`}"><span class="nn">${words[n][0]}</span><small>${words[n][1]}</small><b>${c[k] || 0}</b></button>`).join('');
  const sel = (k, label, opts) => `<select data-rmf="${k}" aria-label="${label}"><option value="">${label}</option>${opts.map(([v, t]) => `<option value="${esc(v)}"${String(f[k] || '') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  const statuses = Object.keys(RM_ST).filter(s => rmFlat(d.themes).some(i => i.status === s));
  const views = RM_VIEWS.length > 1 ? `<span class="rmviews" role="group" aria-label="Roadmap view">${RM_VIEWS.map(([k, w]) => `<button type="button" data-rm-view="${k}" aria-pressed="${rmView(f) === k}">${esc(w)}</button>`).join('')}</span>` : '';
  const items = rmFlat(d.themes), shown = items.filter(i => rmMatch(i, f, rmThemeOf(d, i.id))).length;
  return `<div class="rmtop"><div class="rmscope" role="group" aria-label="Show what was, what is or what shall be (tap again for all)">${scope}</div>
    ${c.live ? `<button type="button" class="chip running" data-rmf-set="live" title="show only live items">${c.live} live</button>` : ''}${c.drift ? `<button type="button" class="chip bad" data-rm-jump="rm-drift">${c.drift} drift</button>` : ''}${c.unplaced ? `<button type="button" class="chip warn" data-rm-jump="rm-unplaced">${c.unplaced} unplaced</button>` : ''}${c.claimed ? `<span class="chip idle claimed">${c.claimed} claimed</span>` : ''}${views}<button type="button" class="rmadd" data-rm-edit="new" title="add an item or a theme">+ Add</button></div>
  <div class="rmthread" aria-hidden="true">${RM_SCOPES.map(k => `<i class="th-${k}" style="flex:${(c[k] || 0) / tot}"></i>`).join('')}</div>
  <div class="filters rmfilters"><input type="search" data-rmf="q" value="${esc(f.q || '')}" placeholder="filter titles, ids, branches" aria-label="Filter the roadmap">${sel('theme', 'all themes', (d.themes || []).map(t => [t.id, t.title]))}${sel('status', 'all states', statuses.map(s => [s, RM_ST[s][0]]))}
    <label class="small"><input type="checkbox" data-rmf="live"${f.live ? ' checked' : ''}> live only</label><label class="small"><input type="checkbox" data-rmf="drift"${f.drift ? ' checked' : ''}> drift only</label>
    ${rmFiltered(f) ? `<span class="small mute">showing ${shown} of ${items.length}</span><button type="button" data-rm-clear>show all</button>` : ''}</div>
  <div class="small mute rmsrc">${esc(d.title || d.project)} · ${c.items || 0} items in ${(d.themes || []).length} themes · derived ${esc(fmtTime(d.generated, ctx.now))}${d.error ? ` · <span class="chip bad">error</span> ${esc(d.error)}` : ''}</div>`;
}
const rmThemeOf = (d, id) => (d.themes || []).find(t => rmFlat(t.children || []).some(i => i.id === id))?.id ?? null;
function rmAudit(d, ctx) {
  const dr = rmFlat(d.themes).filter(i => (i.flags?.drift || []).length);
  return `${dr.length ? `<details class="tablecard rmaudit" id="rm-drift"><summary><h3>Drift <span class="chip bad">${dr.length}</span> <span class="mute small">typed text that disagrees with the records - shown, not trusted</span></h3></summary>
    ${dr.map(i => `<div class="rmau"><span class="id">${esc(i.id)}</span> <b>${esc(i.title)}</b><div class="small">${i.flags.drift.map(esc).join('<br>')}</div></div>`).join('')}</details>` : ''}
  ${(d.unplaced || []).length ? `<details class="tablecard rmaudit" id="rm-unplaced"><summary><h3>Unplaced work <span class="chip warn">${d.unplaced.length}</span> <span class="mute small">live lanes, finished branches and directives no roadmap item links</span></h3></summary>
    ${d.unplaced.map(u => `<div class="rmau">${/^(DIR|DEC|Q|RUN|DLV|L:)/.test(u.id) ? rmRid(u.id, ctx) : `<span class="id">${esc(u.id)}</span>`} <span class="small">${esc(u.why || u.text || '')}</span></div>`).join('')}</details>` : ''}`;
}
// ---------- view B (META-ROADMAP S2b, SPEC sec. 4 option B, owner Q-17): the three Norns board ----------
// Columns Urd was / Verdandi is / Skuld shall be (classic: Past / Now / Next); every theme is one grid row, so its heading stands in
// each column at the same height (sticky under the sticky column heads on a desktop). Cards are compact: the head and the time
// line (the reason text is the card's tooltip); the past and the future show four per theme, the rest folded. A scope leaves its column.
function rmCard(i, ctx, win) {
  const hit = (ctx.rm || {}).item === i.id ? ' hit' : '';
  return `<div class="rmi rmcard ph-${esc(i.phase)}${hit}" id="rm-${esc(i.id)}" data-rm-row title="${esc(i.why || '')}">${rmHead(i, ctx, '', true)}${rmTime(i, win)}</div>`;
}
function rmBoard(d, ctx) {
  const f = ctx.rm || {}, filtered = rmFiltered(f), c = d.counts || {}, words = RM_WORDS[ctx.look === 'norn' ? 'norn' : 'classic'];
  const ks = f.scope ? [f.scope] : RM_SCOPES, word = k => words[RM_SCOPES.indexOf(k)];
  const heads = ks.map(k => `<div class="rmcolh col-${k}"><span class="nn">${word(k)[0]}</span><small>${word(k)[1]}</small><b>${c[k] || 0}</b></div>`).join('');
  const rows = d.themes.map(t => {
    const all = rmFlat(t.children || []), win = rmWindow(all, Date.parse(d.generated) || ctx.now), vis = all.filter(i => rmMatch(i, f, t.id));
    if (filtered && !vis.length && !all.some(i => i.id === f.item)) return '';
    return ks.map(k => {
      const its = rmPhase(vis, k), cap = k === 'present' ? its.length : 4, more = its.slice(cap);
      const open = filtered || more.some(i => i.id === f.item);
      const fold = more.length ? `<details class="rmfold f-${k}"${open ? ' open' : ''}><summary>${more.length} more</summary>${more.map(i => rmCard(i, ctx, win)).join('')}</details>` : '';
      return `<div class="rmcell col-${k}" data-theme="${esc(t.id)}"><h4 class="rmgh"><span class="rmgk">${word(k)[0]} · </span>${esc(t.title)} <span class="mute">${its.length}</span></h4>${its.slice(0, cap).map(i => rmCard(i, ctx, win)).join('') || '<div class="rmnone mute small">nothing</div>'}${fold}</div>`;
    }).join('');
  }).join('');
  return rows ? `<section class="rmboard${ks.length === 1 ? ' n1' : ''}">${heads}${rows}</section>` : '';
}
// ---------- META-ROADMAP S3 (SPEC sec. 3): the edit drawer - structure only (title, place, horizon, note, links, drop / reopen) ----------
// Status is never an input: it stays derived. Each action is ONE POST /api/roadmap/<op> = one record by dashboard; a body carries the
// rev the page saw (and a move the order it saw under the target parent), so a stale page gets a 409 instead of a lost edit.
const rmEditBtn = n => `<button type="button" class="rmedit" data-rm-edit="${esc(n.id)}" title="edit ${esc(n.id)}" aria-label="edit ${esc(n.id)}">&#8943;</button>`;
/** id -> { node, parent (node | null), sibs (the ids under the same parent, in record order) } | null */
export function rmFind(d, id) {
  let hit = null;
  const walk = (xs, parent) => { for (const n of xs) { if (n.id === id) hit = { node: n, parent, sibs: xs.map(x => x.id) }; walk(n.children || [], n); } };
  walk(d?.themes || [], null);
  return hit;
}
const RM_HZ = ['now', 'next', 'later'];
const rmList = v => String(v || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean);
/** a drawer action -> { op, body } (the POST /api/roadmap/<op> body without the project) | { error } */
export function rmEditBody(act, d, id, v = {}) {
  const txt = k => String(v[k] ?? '').trim();
  if (act === 'add') {
    if (!txt('title')) return { error: 'A title is needed.' };
    if (v.parent === 'theme') return { op: 'add', body: { title: txt('title'), kind: 'theme' } };
    if (!v.parent) return { error: 'Pick a theme.' };
    const links = rmList(v.links);
    return { op: 'add', body: { title: txt('title'), parent: v.parent, ...(v.horizon ? { horizon: v.horizon } : {}), ...(txt('note') ? { note: txt('note') } : {}), ...(links.length ? { links } : {}) } };
  }
  const hit = rmFind(d, id);
  if (!hit) return { error: `${id} is not in this roadmap any more. Reload.` };
  const n = hit.node, base = { id, rev: n.rev };
  if (act === 'edit') {
    const ch = {};
    if (v.title !== undefined && txt('title') && txt('title') !== n.title) ch.title = txt('title');
    if (v.note !== undefined && txt('note') !== (n.note || '')) ch.note = txt('note');
    if (v.horizon !== undefined && (v.horizon || null) !== (n.horizon || null)) ch.horizon = v.horizon || '';
    return Object.keys(ch).length ? { op: 'edit', body: { ...base, ...ch } } : { error: 'Nothing changed.' };
  }
  if (act === 'up' || act === 'down') {
    const s = hit.sibs, i = s.indexOf(id);
    if (act === 'up' ? i === 0 : i === s.length - 1) return { error: `Already ${act === 'up' ? 'first' : 'last'}.` };
    return { op: 'move', body: { ...base, after: act === 'up' ? (i >= 2 ? s[i - 2] : null) : s[i + 1], order: s } };
  }
  if (act === 'theme') {
    const t = v.theme && rmFind(d, v.theme);
    if (!t || v.theme === hit.parent?.id) return { error: 'Pick another theme.' };
    return { op: 'move', body: { ...base, parent: v.theme, order: (t.node.children || []).map(x => x.id) } };
  }
  if (act === 'link') { const links = rmList(v.link); return links.length ? { op: 'link', body: { ...base, links } } : { error: 'Name a link: kind:id (dir:DIR-n, lane:name, branch:feat/x ...).' }; }
  if (act === 'unlink') return { op: 'unlink', body: { ...base, links: [v.link] } };
  if (act === 'drop') {
    if (!txt('why')) return { error: 'Say why it is dropped.' };
    if (!/^(DEC|DIR)-[\w-]+$/.test(txt('ref'))) return { error: 'Cite the ruling: a DEC-n or DIR-n.' };
    return { op: 'drop', body: { ...base, why: txt('why'), ref: txt('ref') } };
  }
  if (act === 'reopen') return txt('why') ? { op: 'reopen', body: { ...base, why: txt('why') } } : { error: 'Say why it comes back.' };
  return { error: `unknown action ${act}` };
}
const rmOpt = (v, t, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(t)}</option>`;
/** the drawer body: id = an RM id, or 'new' (add an item or a theme) */
export function renderRmEditor(d, id, ctx = {}) {
  const themes = d?.themes || [], btn = (act, label, cls = '') => `<button type="button" data-rme-act="${act}"${cls ? ` class="${cls}"` : ''}>${label}</button>`;
  const field = (label, html) => `<label class="rmef"><span class="small mute">${label}</span>${html}</label>`;
  const hz = cur => `<select data-rme="horizon">${rmOpt('', 'none', !cur)}${RM_HZ.map(h => rmOpt(h, h, cur === h)).join('')}</select>`;
  const foot = '<p class="small mute">Status is derived from the links, never typed. Each change is one record (by dashboard); every open tab shows it within about 2 s.</p>';
  if (id === 'new') {
    const first = ctx.theme || themes[0]?.id;
    return `<div class="rmed" data-rmed="new"><h3>Add to the roadmap</h3>
      ${field('Under', `<select data-rme="parent">${themes.map(t => rmOpt(t.id, `${t.title} (${t.id})`, t.id === first)).join('')}${rmOpt('theme', '(a new theme)', !themes.length)}</select>`)}
      ${field('Title', '<input data-rme="title" maxlength="200" placeholder="what it is, in a few words">')}
      ${field('Horizon', hz(null))}${field('Note', '<textarea data-rme="note" rows="3" maxlength="4000"></textarea>')}
      ${field('Links', '<input data-rme="links" placeholder="dir:DIR-n, lane:name, branch:feat/x (optional)">')}
      <div class="rmea">${btn('add', 'Add', 'strong')}</div>${foot}</div>`;
  }
  const hit = rmFind(d, id);
  if (!hit) return `<div class="rmed"><p class="mute">${esc(id)} is not in this roadmap any more. ${btn('reload', 'Reload')}</p></div>`;
  const n = hit.node, item = n.kind === 'item', dropped = n.state === 'dropped';
  const sibs = hit.sibs.map(s => rmFind(d, s)?.node).filter(Boolean);
  const place = `<ol class="rmesibs small">${sibs.map(s => `<li${s.id === id ? ' class="me"' : ''}>${esc(s.title)} <span class="id">${esc(s.id)}</span>${s.state === 'dropped' ? ' <span class="mute">dropped</span>' : ''}</li>`).join('')}</ol>`;
  const otherThemes = themes.filter(t => t.id !== hit.parent?.id);
  const ref = (n.links || []).map(l => /^(?:dir|dec):(.+)$/.exec(l)?.[1]).find(Boolean) || '';
  const links = (n.links || []).map(l => `<li><span class="mono small">${esc(l)}</span> <button type="button" class="ghost" data-rme-act="unlink" data-link="${esc(l)}" aria-label="unlink ${esc(l)}" title="unlink">&#215;</button></li>`).join('');
  return `<div class="rmed" data-rmed="${esc(id)}"><h3><span class="id">${esc(id)}</span> ${item ? rmChip(n) : '<span class="chip idle">theme</span>'}${dropped ? ' <span class="chip idle">dropped</span>' : ''}</h3>
    ${item ? `<p class="small mute">${esc(n.why || '')}</p>` : ''}
    ${field('Title', `<input data-rme="title" maxlength="200" value="${esc(n.title)}">`)}${item ? field('Horizon', hz(n.horizon)) : ''}
    ${field('Note', `<textarea data-rme="note" rows="3" maxlength="4000">${esc(n.note || '')}</textarea>`)}
    <div class="rmea">${btn('edit', 'Save', 'strong')}</div>
    <h4>Place</h4>${place}<div class="rmea">${btn('up', '&#8593; Up')}${btn('down', '&#8595; Down')}</div>
    ${item && hit.parent?.kind === 'theme' && otherThemes.length ? `<div class="rmea"><select data-rme="theme" aria-label="move to theme">${otherThemes.map(t => rmOpt(t.id, `${t.title} (${t.id})`, false)).join('')}</select>${btn('theme', 'Move to theme')}</div>` : ''}
    <h4>Links</h4>${links ? `<ul class="rmelinks">${links}</ul>` : '<p class="small mute">no links yet: an item gets its status from what it links</p>'}
    <div class="rmea"><input data-rme="link" placeholder="dir:DIR-n, lane:name, run:RUN-n, branch:feat/x" aria-label="link">${btn('link', 'Link')}</div>
    ${dropped ? `<h4>Dropped</h4><p class="small">${esc(n.dropped?.why || '')}${n.dropped?.ref ? ` (${esc(n.dropped.ref)})` : ''}</p><div class="rmea"><input data-rme="why" placeholder="why it comes back" aria-label="why">${btn('reopen', 'Reopen')}</div>`
      : `<h4>Drop</h4><div class="rmea"><input data-rme="why" placeholder="why" aria-label="why"><input data-rme="ref" value="${esc(ref)}" placeholder="DEC-n or DIR-n" aria-label="the ruling" size="9">${btn('drop', 'Drop', 'bad')}</div>`}
    ${foot}</div>`;
}
function roadmap(d, ctx) {
  if (!d || !(d.themes || []).length) {   // META-ADOPT A3: what the repository holds + the draft, the questions, or one item by hand
    const a = d?.adopt;
    return `<div class="card" id="rm-empty"><p><b>No roadmap yet</b> for ${esc(ctx.project)}.${a ? ` The repository has ${a.items} planned line(s) in ${a.plans} file(s), ${a.branches} branch(es) in flight.` : ''}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="primary" type="button" data-act="adopt-open" data-project="${esc(ctx.project)}">Draft it from the repository</button><button type="button" data-act="adopt-open" data-ask="scan" data-project="${esc(ctx.project)}">Answer 3 questions instead</button><button type="button" class="rmadd" data-rm-edit="new">+ Add one item</button></div>
      <p class="small mute" style="margin:10px 0 0">Or <code>norn road add</code> / <code>norn road apply plan.json</code>; status is derived from the records, never typed.</p>${d?.error ? `<p class="small">${esc(d.error)}</p>` : ''}</div>`;
  }
  const f = ctx.rm || {}, n = d.themes.length;
  const view = rmView(f), body = view === 'board' ? rmBoard(d, ctx) : d.themes.map(t => rmTheme(t, d, ctx, n)).join('');
  return `<div class="rm rm-${view}">${rmTop(d, ctx)}${body || '<div class="card"><p class="mute">No item matches these filters. <button type="button" data-rm-clear>show all</button></p></div>'}${rmAudit(d, ctx)}</div>`;
}
