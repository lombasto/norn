// Engine dashboard UI (META-GENERAL-DESIGN 7, 12-S7): pure renderers, data -> HTML strings, fed by the S6 /api endpoints.
// The same module runs in the browser (index.html imports /ui.mjs) and in node --test (server-side render check of the ids).
// Rules (section 7): status = text + colour (a chip always carries a word), numbers with units, ids everywhere, tabular
// numerals (CSS), one accent colour for "needs you", no animation and no timer (index.html re-renders from the /api/stream state stream).
import { renderMarkdown } from './docs.mjs';
import { renderProse } from './prose.mjs';
import { parseLedger, ledgerInline, LEDGER_KINDS, recordBlocks } from './ledger.mjs';
import { renderAdopt, adoptStep } from './adopt.mjs';
import { renderHome } from './home.mjs';
import { bars, columns, stack, board, lines, meter } from './widgets.mjs';
import { orcLine, badgeLabel } from './norn/orc.mjs';
import { INS_CAPS, LADDER_ORDER, LADDER_STATES, CONTEXT_SUBS, contextParts, contextNumbers, standingRows, perDay, worstFiles, fileAdvice } from './insparts.mjs';
import { SUB_CAP, pickSub, subviewPage, subMore } from './subviews.mjs';
import { TESTS_SUBS } from './testparts.mjs';
import { GUARD_SUBS } from './guardparts.mjs';
import { firstDoc, placeFindings, findingsByLine } from './docparts.mjs';
import { needsYou } from './terms.mjs';
import { esc, fin, dash, int, mTok, fmtMin, pct, plural, aname, chip, exClass, stateOf, projTag, homeChip, pendingChips, pauseAct, cut, fmtTime, goAttrs, guardOn, guardChip } from './cells.mjs';
import { diffBlock } from './diffview.mjs';
import { lanes, map } from './pages/lanes.mjs';
import { runs } from './pages/runs.mjs';
import { plan, forecastCard } from './pages/plan.mjs';
// NORN-UI-NAV: every page, the bar's four first (shell.mjs BAR), then the More sheet's (shell.mjs MORE). Label = id = URL (?tab=<id>)
export const TABS = [['lanes', 'Lanes'], ['runs', 'Runs'], ['inbox', 'Inbox'], ['talk', 'Talk'],
  ['usage', 'Usage'], ['slop', 'Slop'], ['tests', 'Tests'], ['context', 'Context'], ['records', 'Records'], ['ledger', 'Ledger'], ['docs', 'Docs'],
  ['roadmap', 'Roadmap'], ['plan', 'Plan'], ['map', 'Map'], ['settings', 'Settings']];
export const ONE_PROJECT = ['talk', 'map', 'roadmap', 'records', 'docs', 'context', 'slop', 'ledger', 'settings', 'tests'];

const minsSince = (iso, now) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? (now - t) / 60000 : null; };
const fmtLocal = iso => { const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return '-';
  const d = new Date(t); return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} local`; };

const panel = (tab, html) => `<div id="panel-${tab}">${html}</div>`;
const oneProject = tab => panel(tab, `<div class="card"><p class="mute">Choose one project in the header: the ${esc(tab)} tab belongs to one project (its own records / files).</p></div>`);

export const needsCount = ov => (ov && fin(ov.needs_you) ? ov.needs_you : 0);
export const pageTitle = (n, project, look = 'classic') => `${n > 0 ? `(${n}) ` : ''}${look === 'norn' ? 'Norn' : 'norn'} - ${project === 'all' ? 'all projects' : project}`;
/** the Health pages' states from what the header holds: usage = the overview's burn.usage (guard STOP or over the hourly cap = bad,
 *  guard ok = ok), slop / tests / context = the Guard rows of their types (a warn-level row = warn, else ok); null = not known */
export function healthStates({ usage = null, rows = null } = {}) {
  const u = !usage || usage.billing?.type === 'api' ? null : usage.guard === 'STOP' || usage.rateOK === false ? 'bad' : usage.guard === 'ok' ? 'ok' : null;
  const of = types => (rows ? (rows.some(r => types.includes(r.type) && (r.severity === 'high' || r.severity === 'medium')) ? 'warn' : 'ok') : null);
  return { usage: u, slop: of(['code']), tests: of(['tests']), context: of(['instructions', 'memory', 'rules', 'docs']) };
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
// TESTS-RUNTIME: Tests - the chosen sub-view's part; Impact's pick rides in batch ('files:a,b' | 'lane:<name>')
const PART_NAMES = { context: d => contextParts(d.sub), slop: d => [d.sub], docs: d => (d.file ? ['file'] : []), tests: d => [d.sub] };
const PART_API = { context: 'instructions', slop: 'guard' };   // META-UX-BUILD S5: Slop (was Guard) keeps its route /api/guard
export const partsKey = (tab, project, d) => (tab === 'context' ? `${project}|${d.at}|${d.sub}` : tab === 'docs' ? `${project}|${d.sig}|${d.file}` : tab === 'tests' ? `${project}|${d.times?.at}|${(d.history || []).length}|${d.sub}|${d.limit}|${d.batch ?? ''}` : `${project}|${d.sig}|${d.sub}|${d.limit}|${d.batch ?? ''}`);
export async function loadParts(tab, project, d, get) {
  const pick = b => (b.startsWith('lane:') ? `&lane=${encodeURIComponent(b.slice(5))}` : `&files=${encodeURIComponent(b.slice(6))}`);
  const q = `project=${encodeURIComponent(project)}`, lim = tab === 'docs' ? `&file=${encodeURIComponent(d.file)}` : d.limit && tab !== 'context' ? `&limit=${d.limit}${d.batch ? (tab === 'tests' ? pick(d.batch) : `&batch=${encodeURIComponent(d.batch)}`) : ''}` : '';
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
  if (tab === 'talk') return get(`/api/home?${q}`);   // META-CONTROLLER C2 (the route keeps its name: routes stay, labels and the URL tab move)
  if (tab === 'inbox') { const [ib, deliverables] = await Promise.all([get(`/api/inbox?${q}`), dlvGet(get, q)]); return { ...ib, deliverables }; }
  if (tab === 'lanes') return get(`/api/lanes?${q}`);
  if (tab === 'map') return get(`/api/map?${q}${ctx.mapMore?.size ? `&more=${encodeURIComponent([...ctx.mapMore].join(','))}` : ''}${ctx.mapAll ? '&all=1' : ''}`);
  if (tab === 'runs') { const [a, o, guard] = await Promise.all([get(`/api/agents?${q}${ctx.runsWindow && ctx.runsWindow !== '2h' ? '&window=' + ctx.runsWindow : ''}`), get(`/api/overview?${q}`), guardGet(get, q, all)]); return { ...a, top: o.burn.top, guard }; }
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
  // Usage carries the forecast (moved from Plan, stage NAV): /api/plan's forecast per project, beside the usage parts
  if (tab === 'usage') { const [u, pl] = await Promise.all([get(`/api/usage?${q}`), get(`/api/plan?${q}`).catch(() => null)]); return { ...u, forecasts: Object.fromEntries((pl?.parts || []).map(p => [p.project, p.forecast])) }; }
  if (tab === 'tests') {   // META-TEND TESTS. TESTS-RUNTIME: the summary first, then the chosen sub-view's part (Impact: its pick in batch)
    const sub = pickSub(TESTS_SUBS, ctx.sub), d = { ...(await get(`/api/tests?${q}`)), sub, limit: ctx.limit || SUB_CAP, ...(sub === 'impact' && ctx.batch ? { batch: ctx.batch } : {}) };
    const have = partsHave(ctx, 'tests', project, d);
    return { ...d, ...(have || {}), parts_loading: !have };
  }
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
/** the cards that read the status strip (/api/strip, ctx.strip), not the page's endpoint - the retired Overview's onboarding on Lanes (the first
 *  task, the setup gaps) and the API spend on Usage. index.html repaints #strip-cards when a newer strip lands. */
export const stripCards = (tab, s) => `<div id="strip-cards">${!s ? '' : tab === 'lanes' ? firstTask(s.first_run) + setupGaps(s.setup)
  : tab === 'usage' && s.usage?.billing?.type === 'api' ? `<section class="card" id="usage-burn" style="margin-bottom:12px"><h2>Last 24 h <span class="mute small">API billing, against the daily cap</span></h2>${apiBurn(s.usage.billing)}</section>` : ''}</div>`;
export function renderTab(tab, d, ctx = {}) {
  if (tab === 'adopt') return panel(tab, renderAdopt(adoptStep(d, ctx.adoptAsk), d, ctx));
  if (d?.one) return oneProject(tab);
  const now = ctx.now ?? Date.now();
  if (tab === 'usage' || tab === 'lanes') return panel(tab, stripCards(tab, ctx.strip) + (tab === 'usage' ? usage(d, { ...ctx, now }) : lanes(d, { ...ctx, now })));
  if (tab === 'plan') return panel(tab, plan(d, { ...ctx, now }));
  if (tab === 'talk') return panel(tab, renderHome(d, { ...ctx, now }));
  return panel(tab, ({ inbox, lanes, runs, map, roadmap, records, docs, context, ledger, settings, tests, slop: guard })[tab](d, { ...ctx, now }));
}

// META-TEND TESTS (owner DIR-19 + DIR-47) + TESTS-RUNTIME (owner ask 2026-11-19): the Tests tab = a summary of 4 numbers, the open alerts
// the test machinery raised (linked to their Inbox question), and four sub-views (testparts.mjs TESTS_SUBS), each its own part:
//   Suite            - the runtime of every test from the last `norn tests measure` (node:test or pytest): when and by which run, where the
//                      time goes per file and group (share of the suite total), every test slowest first with its one-line description;
//                      a test's file opens in the code viewer drawer (index.html #srcview) at its line
//   Costs and health - cost, health and tier per test, test share per run and lane, gate time per merge, the merge check, lean tests
//   Impact           - which test files cover a source file, or a lane's changed files (`norn tests for`)
//   Trends           - test cases / lines and suite time over time, suite CPU-minutes, worker test minutes per lane
// A part whose source does not exist yet says "not measured yet" and what writes it - never a number.
const sec = ms => (fin(ms) ? (ms >= 10000 ? `${Math.round(ms / 1000)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`) : '-');
const shortT = t => String(t ?? '').replace(/^(\S+\.test\.mjs) :: /, '<span class="mute">$1</span> ');
const none = '<p class="mute" style="padding:0 12px">none measured</p>';
const notYet = (what, src) => `<p class="small mute tnotyet" style="padding:0 12px"><span class="chip idle">not measured yet</span> ${what}${src ? ` <span class="mute">(${src})</span>` : ''}</p>`;
const SUITE_NAME = { 'node:test': 'node:test', pytest: 'pytest' };
const nodeOnly = d => (d.suite === 'pytest' ? `<p class="small mute tscope" style="padding:0 12px">${chip('idle', 'node:test only')} reads node:test suites only: this project's suite is pytest, so nothing fills here.</p>` : '');
// a test's file:line opens the code viewer; the test's row names it
const srcBtn = (file, line, label) => `<button class="lnk mono small" data-act="test-src" data-file="${esc(file)}" data-line="${esc(line ?? '')}" title="open ${esc(file)}${line ? ` at line ${esc(line)}` : ''} (read-only)">${esc(label ?? `${file}${line ? `:${line}` : ''}`)}</button>`;
function testsWhen(t, ctx) {
  if (!t) return '';
  return `<p class="small mute" id="tests-when">Timings taken <b>${esc(fmtTime(t.at, ctx.now))}</b> at <span class="mono">${esc(t.sha ?? '?')}</span> by ${t.run ? `<button class="lnk" data-go="runs" title="the run that measured">${esc(t.run)}</button>` : 'a hand run'}
    (<span class="mono">${t.via === 'merge check' ? 'norn tests check' : 'norn tests measure'}</span>${fin(t.exit) ? `, suite exit ${int(t.exit)}` : ''}${t.via === 'merge check' ? ': the changed files re-measured, the rest from the last full measure' : ''}) · ${esc(SUITE_NAME[t.suite] ?? t.suite)} · ${int(t.tests)} tests in ${int(t.files)} files${t.failed ? ` · ${chip('bad', `${t.failed} failed`)}` : ''}</p>`;
}
export function testsNumbers(d) {
  const t = d.times, last = (d.history || []).at(-1), al = (d.alerts || []).length;
  return [{ n: t ? int(t.tests) : '-', label: t ? `${SUITE_NAME[t.suite] ?? t.suite} tests timed` : 'tests timed: not measured yet' },
    { n: t ? sec(t.total_ms) : '-', label: t?.suite === 'pytest' ? 'suite wall (one process)' : 'suite time (file times summed)' },
    { n: t?.slowest ? sec(t.slowest.ms) : '-', label: t?.slowest ? `slowest: ${t.slowest.name.slice(0, 48)}` : 'slowest test' },
    al ? { n: int(al), label: 'alerts: they need you', cls: 'warn' } : { n: last?.coverage ? pct(last.coverage.pct) : '-', label: 'line coverage (last measure)' }];
}
function testsAlerts(d) {
  const xs = d.alerts || [];
  if (!xs.length) return '';
  return `<div class="card" id="tests-alerts"><b>The test machinery needs you</b> <span class="small mute">each is an Inbox question: answer it here or there</span>${xs.map(q => {
    const rk = q.recommend?.key;
    return `<div class="item" id="tests-alert-${esc(q.id)}">${chip('needs', q.id)}<div style="flex:1;min-width:0"><b>${esc(q.title)}</b>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">${(q.options || []).map(o => { const k = o.key ?? o.k; return `<button class="${k === rk ? 'primary' : ''}" data-act="answer" data-project="${esc(d.project)}" data-id="${esc(q.id)}" data-choice="${esc(k)}" data-text="${esc(`(${k}) ${o.text ?? o.t ?? ''}`)}">${esc(o.text ?? o.t ?? k)}${k === rk ? ' - recommended' : ''}</button>`; }).join('')}
      <button class="lnk" data-tab="inbox">Open in Inbox</button></div></div></div>`; }).join('')}</div>`;
}
// ---- Suite ----
function testsBreakdown(b) {
  const row = f => `<details class="tbd"><summary><span class="tbdn mono">${esc(f.file)}</span> <b class="mono">${sec(f.ms)}</b> <span class="small mute">${f.share === null ? '' : pct(f.share)} · ${int(f.tests)} tests</span>${meter(f.share ?? 0, 100)}</summary>
    <ul class="tlist">${f.groups.map(g => `<li><span>${g.group ? esc(g.group) : '<span class="mute">top level</span>'}</span> <b class="mono">${sec(g.ms)}</b> <span class="small mute">${g.share === null ? '' : pct(g.share)} · ${int(g.tests)} tests</span></li>`).join('')}</ul></details>`;
  const top = b.files.slice(0, 12), rest = b.files.slice(12);
  return `<div class="tablecard" id="tests-breakdown"><h3>Where the time goes <span class="mute small">per file, then per group (describe / suite / parent test, or pytest class), slowest first · share of ${sec(b.total_ms)}</span></h3>
    <div style="padding:4px 12px">${top.map(row).join('')}${rest.length ? `<details class="tbd"><summary class="small mute">${int(rest.length)} more files</summary>${rest.map(row).join('')}</details>` : ''}</div></div>`;
}
const descLine = t => (t.desc ? `<div class="small">${esc(t.desc)} <span class="mute">(${esc(t.from)})</span></div>` : '<div class="small mute">no description: no docstring, no comment above it, and its name says little</div>');
function testsList(p) {
  const rows = p.tests.rows;
  return `<div class="tablecard" id="tests-list"><h3>Every test, slowest first <span class="mute small">${int(p.tests.n)} · share = of the suite total · tap a file to read the test</span></h3>
    <ul class="tlist" id="tests-rows">${rows.map(t => `<li data-test="${esc(t.id)}"><div><b>${esc(t.name)}</b> <b class="mono">${sec(t.ms)}</b> <span class="small mute">${t.share === null ? '' : pct(t.share, 2)}</span>${t.ok ? '' : ` ${chip('bad', 'failed')}`}${(t.cause || []).map(c => ` ${chip(c === 'in-process work' ? 'idle' : 'prov', c)}`).join('')}</div>
      ${descLine(t)}<div class="small mute">${srcBtn(t.file, t.line)}${t.group?.length ? ` · ${esc(t.group.join(' › '))}` : ''}</div></li>`).join('')}</ul>${subMore(rows.length, p.tests.n)}</div>`;
}
function testsSuite(d) {
  if (!d.breakdown) return `<div class="card" id="tests-suite-empty">${notYet('per-test runtimes', `<span class="mono">${esc(d.commands.measure)}</span> times every test of a node:test or pytest suite: a full suite run, once, on a quiet machine`)}</div>`;
  return testsBreakdown(d.breakdown) + testsList(d);
}
// ---- Costs and health ----
const kids = c => Object.entries(c?.children || {}).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') || 'none';
function testsPerTest(d) {
  const s = d.sources || {}, have = ['costs', 'health', 'tiers'].filter(k => s[k]);
  const head = `<h3>Per test: cost, health, tier <span class="mute small">${have.length ? `measured: ${have.join(', ')}` : ''}</span></h3>`;
  if (!have.length) return `<div class="tablecard" id="tests-pertest">${head}${notYet('cost (CPU s, peak MB, child processes, alone vs under load), health (failures and reruns in 7 days, passes alone but fails under load, hangs, quarantine) and tier (worker / PR check / post-batch / nightly, with the hygiene verdict)', 'costs.json, health.json, tiers.json: the test-governance machinery writes them')}</div>`;
  const li = r => {
    const c = r.cost, h = r.health, q = r.quarantine, tr = r.tier;
    return `<li data-test="${esc(r.id)}"><div><b>${esc(r.name)}</b> <span class="small mute">${sec(r.ms)}</span>${q ? ` ${chip('warn', 'quarantined')}` : ''}${tr?.tier ? ` ${chip('idle', tr.tier)}` : ''}${tr?.verdict ? ` ${chip(tr.verdict === 'keep' ? 'ok' : 'warn', tr.verdict)}` : ''}</div>
      <div class="small">${s.costs ? (c ? `CPU ${fin(c.cpu_s) ? `${c.cpu_s.toFixed(1)} s` : '-'} · peak ${fin(c.peak_mb) ? `${int(c.peak_mb)} MB` : '-'} · children: ${esc(kids(c))} · alone ${sec(c.alone_ms)} / under load ${sec(c.load_ms)}` : '<span class="mute">cost: not in the last cost measure</span>') : ''}</div>
      <div class="small">${s.health ? (h ? `${int(h.fails)} failures, ${int(h.reruns)} reruns in ${int(s.health.days)} days · ${int(h.load_only)} passed alone but failed under load · ${int(h.hangs)} hangs` : `<span class="mute">no failure in ${int(s.health.days)} days</span>`) : ''}${q ? ` · quarantined by ${esc(q.by)}${q.until ? ` until ${esc(String(q.until).slice(0, 10))}` : ''}${q.why ? `: ${esc(q.why)}` : ''}` : ''}</div>
      ${tr?.evidence ? `<div class="small mute">${esc(tr.evidence)}</div>` : ''}<div class="small mute">${srcBtn(r.file, r.line)}${tr?.q || q?.q ? ` · <button class="lnk" data-tab="inbox">open the ruling ${esc(tr?.q || q.q)} in Inbox</button>` : ''}</div></li>`;
  };
  const miss = ['costs', 'health', 'tiers'].filter(k => !s[k]);
  return `<div class="tablecard" id="tests-pertest">${head}${s.costs?.cpu_pct !== undefined && s.costs?.cpu_pct !== null ? `<p class="small mute" style="padding:0 12px">cost measured ${esc(String(s.costs.at ?? '').slice(0, 16))} with the machine at ${pct(s.costs.cpu_pct, 0)} CPU</p>` : ''}
    ${miss.length ? notYet(miss.join(', '), `${miss.map(k => `${k}.json`).join(', ')}: the test-governance machinery writes them`) : ''}<ul class="tlist">${d.rows.rows.map(li).join('')}</ul>${subMore(d.rows.rows.length, d.rows.n)}</div>`;
}
const BUDGET = { ok: 'ok', warn: 'warn', over: 'bad' };
function testsRuns(d) {
  const head = '<h3>Per run and lane <span class="mute small">share of the run\'s wall time in test commands · full-suite commands seen (should be 0) · the budget</span></h3>';
  if (!d.sources?.budgets) return `<div class="tablecard" id="tests-runs">${head}${notYet('test time per run', 'budgets.jsonl: the supervisor\'s per-run test budget writes it')}</div>`;
  return `<div class="tablecard" id="tests-runs">${head}<ul class="tlist">${d.runs.map(r => `<li>${chip(BUDGET[r.state] ?? 'idle', r.state ?? '-')} <button class="lnk" data-go="runs">${esc(r.run)}</button> <span class="mute">${esc(r.lane ?? '')}</span>
    <div class="small">${fin(r.wall_s) && r.wall_s > 0 ? `<b>${pct(100 * (r.test_s ?? 0) / r.wall_s, 0)}</b> of ${fmtMin(r.wall_s / 60)} in tests` : `${fmtMin((r.test_s ?? 0) / 60)} in tests`} · ${r.full_suite ? chip('bad', `${int(r.full_suite)} full-suite command${r.full_suite === 1 ? '' : 's'}`) : 'no full-suite command'} <span class="mute">${esc(fmtTime(r.at))}</span></div></li>`).join('')}</ul></div>`;
}
const MQ = { merged: 'ok', green: 'ok', landed: 'ok', red: 'bad', 'main-red': 'bad', pinned: 'bad', flaky: 'warn', slop: 'warn', gating: 'running' };
function testsMerges(d, ctx) {
  const head = '<h3>Per merge <span class="mute small">the merge queue\'s batches: gate time and what the gate ran</span></h3>', xs = d.merges || [];
  if (!xs.length) return `<div class="tablecard" id="tests-merges">${head}<p class="small mute" style="padding:0 12px">no merge-queue batch yet</p></div>`;
  return `<div class="tablecard" id="tests-merges">${head}<ul class="tlist">${xs.map(b => `<li>${chip(MQ[b.status] ?? MQ[b.result] ?? 'idle', b.status)} <b>batch-${esc(b.n)}</b> <b class="mono">${b.skipped ? 'gate skipped' : sec(b.gate_ms)}</b> <span class="small mute">${esc(fmtTime(b.done ?? b.built, ctx.now))} · ${int(b.runs.length)} gate run${b.runs.length === 1 ? '' : 's'}${b.runs.some(r => r.timedOut) ? ' · timed out' : ''}</span>
    <div class="small mono" style="overflow-wrap:anywhere">${esc(b.skipped || b.gate || '-')}</div><div class="small mute" style="overflow-wrap:anywhere">${esc(b.members.join(', '))}</div></li>`).join('')}</ul></div>`;
}
function testsAdv(d) {
  const adv = d.advisories, head = `<h3>Last merge check <span class="mute small">${adv ? `${esc(adv.head)} vs ${esc(adv.base)} · ${int(adv.files.length)} changed test file(s) · ` : ''}advisory, never a merge block</span></h3>`;
  if (d.suite === 'pytest') return `<div class="tablecard" id="tests-adv">${head}${nodeOnly(d)}</div>`;
  if (!adv) return `<div class="tablecard" id="tests-adv">${head}<p class="small mute" style="padding:0 12px">no merge check yet</p></div>`;
  return `<div class="tablecard" id="tests-adv">${head}${adv.list.length ? `<ul class="tlist">${adv.list.map(a => `<li>${chip(a.severity === 'medium' ? 'warn' : 'idle', a.key)}${a.new ? ` ${chip('open', 'new')}` : ''} <b>${esc(a.path ?? a.surface)}</b> ${esc(a.why)}<div class="small mute">${esc(a.fix.action)} · ${esc(a.id)}</div></li>`).join('')}</ul>` : '<p class="mute" style="padding:0 12px">no finding</p>'}</div>`;
}
function testsLean(d) {
  const lean = d.lean, mx = d.mutation, files = mx?.files || [], never = lean?.never || [], dup = lean?.duplicates || [];
  const head = '<h3>Lean tests <span class="mute small">the hygiene evidence: mutation trials (StrykerJS, outside the repo), tests that never fail, duplicates</span></h3>';
  if (d.suite === 'pytest') return `<div class="tablecard" id="tests-lean">${head}${nodeOnly(d)}</div>`;
  if (!lean && !mx) return `<div class="tablecard" id="tests-lean">${head}${notYet('lean tests', `<span class="mono">${esc(d.commands.lean)}</span> after a measure and a mutation trial`)}</div>`;
  const mut = mx ? `<div class="inswrap" id="tests-mut"><table class="instab"><thead><tr><th>file</th><th>mutants</th><th>score</th><th class="insopt">survived</th><th class="insopt">test-process time</th></tr></thead><tbody>
    ${files.map(f => `<tr><td class="mono">${esc(f.file.split('/').pop())}</td><td class="num">${int(f.mutants)}</td><td class="num"><b>${pct(f.score)}</b>${meter(f.score, 100)}</td><td class="num insopt">${int(f.survived)}</td><td class="num insopt">${sec(f.ms)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const nv = `<div id="tests-never"><div class="small" style="padding:4px 12px"><b>Never fail</b> <span class="mute">${int(never.length)} · ran against every mutant of ${esc(files.map(f => f.file.split('/').pop()).join(', ') || 'no file')} and killed none</span></div>
    ${never.length ? `<ul class="tlist">${never.map(t => `<li>${chip('warn', 'kills 0')} ${shortT(esc(t.test))}${fin(t.ms) ? ` <span class="small mute">${sec(t.ms)}</span>` : ''}</li>`).join('')}</ul>` : none}</div>`;
  const dp = `<div id="tests-dup"><div class="small" style="padding:4px 12px"><b>Duplicates</b> <span class="mute">${int(dup.length)} · every mutant it kills, another test kills too (equal sets: the slower one is listed)</span></div>
    ${dup.length ? `<ul class="tlist">${dup.map(t => `<li>${chip(t.same ? 'warn' : 'idle', t.same ? 'same set' : 'subset')} ${shortT(esc(t.test))} <span class="small mute">kills ${int(t.kills)}${fin(t.ms) ? ` · ${sec(t.ms)}` : ''}</span><div class="small mute">inside: ${shortT(esc(t.within))}</div></li>`).join('')}</ul>` : none}
    <p class="small mute" style="padding:0 12px">The evidence covers the trial's files only: a listed test may still guard other code - the wave gate re-measures coverage and mutants before a cut stands.</p></div>`;
  return `<div class="tablecard" id="tests-lean">${head}${mut}${lean ? nv + dp : ''}</div>`;
}
const testsCosts = (d, ctx) => testsPerTest(d) + testsRuns(d) + testsMerges(d, ctx) + testsAdv(d) + testsLean(d);
// ---- Impact ----
function testsImpact(d) {
  const im = d.impact, p = d.picked;
  const form = `<div class="card" id="tests-impact-pick"><div class="small"><b>Which tests cover a file?</b> <span class="mute">the answer of <span class="mono">${esc(d.commands.for)} &lt;files&gt;</span>, from the coverage of the last measure${im ? ` (${esc(String(im.at).slice(0, 16))}, ${esc(im.sha ?? '?')})` : ''}</span></div>
    <div class="tpick"><input type="search" id="tests-impact-files" list="tests-srcs" placeholder="source files, comma-separated" value="${esc(p && !p.lane ? p.files.join(', ') : '')}"><button data-act="tests-impact">Which tests?</button></div>
    <datalist id="tests-srcs">${(im?.sources || []).map(s => `<option value="${esc(s)}">`).join('')}</datalist>
    ${d.lanes?.length ? `<div class="tpick"><select id="tests-impact-lane" aria-label="a lane">${d.lanes.map(l => `<option${p?.lane === l ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><button data-act="tests-impact-lane">A lane's changed files</button></div>` : ''}</div>`;
  if (!im) return form + `<div class="card" id="tests-impact-out">${notYet('test impact', `${d.suite === 'pytest' ? 'a pytest measure with pytest-cov installed' : `<span class="mono">${esc(d.commands.measure)}</span> with coverage`} writes it`)}</div>`;
  if (!p) return form + `<p class="small mute" id="tests-impact-out">${int(im.sources.length)} source files are covered by the suite: pick one, or a lane.</p>`;
  if (p.error) return form + `<div class="card" id="tests-impact-out">${chip('bad', 'refused')} ${esc(p.error)}</div>`;
  return form + `<div class="tablecard" id="tests-impact-out"><h3>${p.lane ? `Lane ${esc(p.lane)}: ${int(p.files.length)} changed file(s)` : `${int(p.files.length)} file(s)`} → <b>${int(p.tests.length)} test file(s)</b></h3>
    ${p.tests.length ? `<p class="small" style="padding:0 12px">${p.tests.map(t => srcBtn(t, null, t)).join(' ')}</p>` : ''}
    <ul class="tlist">${p.rows.map(r => `<li><span class="mono">${esc(r.file)}</span> <span class="small mute">${r.tests.length ? `${int(r.tests.length)} test file(s)` : r.known ? 'covered by no test' : 'not in the measure\'s coverage (a test file, or not run by any test)'}</span></li>`).join('')}</ul>
    <p class="small mute" style="padding:0 12px">The same answer in a terminal: <span class="mono" style="overflow-wrap:anywhere">${esc(d.commands.for)} ${esc(p.files.join(' '))}</span></p></div>`;
}
// ---- Trends ----
function testsOver(h, g, last, gl) {
  const col = (title, cur, body) => `<div><div class="small"><b>${title}</b> <span class="mute">${cur}</span></div>${body}</div>`;
  return `<div class="tablecard" id="tests-time"><h3>Over time <span class="mute small">per day: test cases and lines (git, first parent) · per measure or merge check: the summed file time</span></h3><div class="tgrid">
    ${col('test cases', gl ? `${int(gl.tests)} now` : '-', g.length ? columns(g.map(x => ({ label: x.day.slice(5), value: x.tests })), { fmt: int, title: 'test cases per day', id: 'tests-count', unit: 'tests', per: 'day' }) : '<p class="small mute">no history yet</p>')}
    ${col('suite file time', last ? `${sec(last.file_ms)} now` : '-', h.length ? columns(h.map(x => ({ label: String(x.at).slice(5, 10), value: x.file_ms })), { fmt: sec, title: 'suite file time per measure', id: 'tests-suite', per: 'measure' }) : '<p class="small mute">no measure yet</p>')}
    ${col('test lines per code line', gl ? `${(gl.test_lines / (gl.code_lines || 1)).toFixed(2)}:1 now` : '-', g.length ? columns(g.map(x => ({ label: x.day.slice(5), value: Math.round(100 * x.test_lines / (x.code_lines || 1)) / 100 })), { fmt: v => `${v}:1`, title: 'test lines per code line', id: 'tests-ratio', per: 'day' })
      + stack([{ key: 'tests', label: 'test lines', value: gl.test_lines }, { key: 'code', label: 'code lines', value: gl.code_lines }], { fmt: int }) : '')}</div></div>`;
}
function testsWave(w, ctx) {
  if (!w) return '';
  return `<div class="tablecard" id="tests-wave"><h3>Last lean-tests wave ${chip(w.ok ? 'ok' : 'bad', w.ok ? 'gate passed' : 'gate failed')}${w.restored?.length ? ` ${chip('warn', 'restored')}` : ''} <span class="mute small">${esc(fmtTime(w.at, ctx.now))} · ${esc(w.head)} vs ${esc(w.base)}</span></h3><div style="padding:4px 12px">
    ${bars([{ label: 'tests before', value: w.before.tests }, { label: 'tests after', value: w.after.tests }], { fmt: int, id: 'tests-wave-bars' })}
    <div class="small">coverage ${pct(w.before.cov?.pct)} -> <b>${pct(w.after.cov?.pct)}</b>${w.score ? ` · mutation score ${pct(w.score.before)} -> <b>${pct(w.score.after)}</b>` : ''} · changed files ${sec(w.ms_before)} -> <b>${sec(w.ms_after)}</b>${w.lost_lines ? ` · lost ${int(w.lost_lines)} line(s)` : ''}</div>
    <div class="small mute" style="margin-top:4px;overflow-wrap:anywhere">cut: ${w.removed.map(t => shortT(esc(t))).join(' · ') || 'nothing'}</div></div></div>`;
}
function testsTrends(d, ctx) {
  const h = d.history || [], last = h.at(-1), g = d.git?.points || [], gl = g.at(-1);
  const cpu = `<div class="tablecard" id="tests-cpu"><h3>Suite CPU-minutes per full run <span class="mute small">a hygiene pass pays off here</span></h3>${d.cpu?.length ? `<div style="padding:4px 12px">${columns(d.cpu.map(x => ({ label: String(x.at).slice(5, 10), value: x.cpu_min })), { fmt: v => `${v} min`, title: 'suite CPU-minutes per full run', id: 'tests-cpu-cols', unit: 'CPU-min', per: 'run' })}</div>` : notYet('suite CPU time', 'a measure that records its CPU-minutes (cpu_min in history.jsonl)')}</div>`;
  const days = d.lanes ? [...new Set(d.lanes.map(x => x.day))] : [];
  const lane = `<div class="tablecard" id="tests-lanemin"><h3>Worker test minutes per lane <span class="mute small">per day, from the per-run test budget</span></h3>${d.lanes ? `<div style="padding:4px 12px">${columns(days.map(day => ({ label: day.slice(5), value: Math.round(10 * d.lanes.filter(x => x.day === day).reduce((n, x) => n + x.min, 0)) / 10 })), { fmt: v => `${v} min`, title: 'worker test minutes per day', id: 'tests-lane-cols', unit: 'min', per: 'day' })}
    ${bars(Object.entries(d.lanes.reduce((m, x) => ({ ...m, [x.lane]: (m[x.lane] ?? 0) + x.min }), {})).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ label: k, value: Math.round(v * 10) / 10 })), { fmt: v => `${v} min`, id: 'tests-lane-bars' })}</div>` : notYet('worker test minutes', 'budgets.jsonl: the supervisor\'s per-run test budget writes it')}</div>`;
  return testsOver(h, g, last, gl) + cpu + lane + testsWave(d.wave, ctx);
}
const TESTS_PART = { suite: testsSuite, costs: testsCosts, impact: testsImpact, trends: testsTrends };
function tests(d, ctx) {
  // a project whose suite Norn cannot read: say which suite it is and what still fills, instead of a page of "not measured yet"
  const why = d.suite === false ? `<div class="banner" id="tests-scope">Norn reads node:test suites (tests/*.test.mjs) and pytest suites (tests/test_*.py); this project's tests/ holds neither, so only <b>Trends</b> fills: test cases and lines per day from git, refreshed once a day by the tick.</div>`
    : !d.times && !(d.history || []).length && !(d.git?.points || []).length ? `<div class="banner" id="tests-scope">Nothing measured yet. The tick fills <b>Trends</b> from git once a day; per-test runtimes come from <span class="mono">${esc(d.commands.measure)}</span> (a full suite run).</div>` : '';
  const views = TESTS_SUBS.map(([k, label]) => [k, label, k === 'suite' && d.times ? int(d.times.tests) : null]);
  return subviewPage('tests', { title: 'Tests', lead: why + testsAlerts(d), numbers: testsNumbers(d), views, active: d.sub, loading: d.parts_loading, body: d.parts_loading ? '' : testsWhen(d.sub === 'suite' ? d.times : null, ctx) + TESTS_PART[d.sub](d, ctx) });
}

// OOTB-R2 N-5: runs held for a login (the command to type, the held runs, the failing line)
const loginRow = (i, ctx) => `<div class="item">${chip('needs', i.id)}<div><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}${i.cls === 'vendor' ? 'nothing to do - a vendor outage, not your login' : `open a terminal and run <span class="mono">${esc(i.command)}</span>`}; held: ${esc((i.runs || []).join(', '))} - they resume by themselves${i.line ? ` · "${esc(i.line)}"` : ''}</div></div></div>`;
// GAP-1 (lib/holds.mjs): ALL queued work held on one machine-level hold - what, since when, why in plain words and the fix (Settings /
// the command / Resume); it leaves by itself when the hold clears
const holdRow = (i, ctx) => `<div class="item" id="hold-${esc(i.project)}">${chip('bad', 'all held')}<div style="flex:1;min-width:0"><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}held ${fmtMin(i.minutes)} · ${esc((i.runs || []).join(', '))}</div>
  <div class="small">Fix: ${esc(i.fix)}${i.command ? ` <span class="mono">${esc(i.command)}</span>` : ''}${i.clears ? ` <span class="mute">- or it clears ${esc(i.clears)}</span>` : ''}</div></div>
  <span class="spacer"></span><div style="display:flex;gap:6px;flex-wrap:wrap">${i.setting ? `<button class="primary" data-tab="settings" title="${esc(i.setting)}">Open Settings</button>` : ''}${i.resume ? `<button class="primary" data-act="hold-resume" data-project="${esc(i.project)}">Resume</button>` : ''}</div></div>`;
// GAP-8 (lib/handedits.mjs): a generated file edited by hand is no longer regenerated - take it back (a .bak keeps the hand text) or keep it
// the words say what Norn saw and what each button does. RM-35: then what changed and who probably did it (handedits.mjs explain: the
// write record's lines, plain text), "View diff" (last written by Norn vs now in the diff viewer) and, when the text is clearly Norn's
// own (an older copy, or its last text with a lost hash), the recommendation to take it back with the reason
const editRow = (i, ctx, px = { project: i.project, sanitize: ctx.sanitize }) => `<div class="item" id="${esc(i.id)}">${chip('warn', 'changed outside Norn')}<div style="flex:1;min-width:0"><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}${renderProse('`' + i.file + '`', px)}${i.created ? ` · changed ${fmtMin(minsSince(i.created, ctx.now))} ago` : ''}</div>
  <div class="small">Norn writes this file itself, and its text no longer matches what Norn last wrote, so Norn leaves it alone rather than overwrite someone's edit.</div>
  ${i.lines?.length ? `<ul class="small hedwho">${i.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : i.generated ? '<div class="small">It still carries Norn\'s GENERATED header, so it was most likely not edited by a person.</div>' : ''}
  ${i.recommend === 'takeback' ? `<div class="small"><b>Recommended: Let Norn take it back</b> - ${esc(i.why)}.</div>` : ''}
  <div class="small mute"><b>Let Norn take it back</b>: the current text is saved beside it as .bak and Norn updates the file again. <b>Keep my version</b>: Norn never updates this file again, until you take it back.</div></div>
  <span class="spacer"></span><div style="display:flex;gap:6px;flex-wrap:wrap">${i.diff ? `<button class="ghost" data-act="diff-open" data-dv-url="/api/handedit/diff?project=${encodeURIComponent(i.project ?? '')}&amp;file=${encodeURIComponent(i.file)}" data-dv-title="${esc(i.file.split('/').pop())}" data-dv-sub="last written by Norn vs now">View diff</button>` : ''}<button class="primary" data-act="handedit" data-choice="takeback" data-project="${esc(i.project)}" data-file="${esc(i.file)}">Let Norn take it back</button><button class="ghost" data-act="handedit" data-choice="keep" data-project="${esc(i.project)}" data-file="${esc(i.file)}">Keep my version</button></div></div>`;
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
// META-ADOPT A3: ONE needs-you row while a drafted setup waits (Review / Not now = a close with the reason)
const setupRow = (i, ctx) => `<div class="item">${chip('open', i.id)}<div><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}drafted ${fmtMin(minsSince(i.created, ctx.now))} ago · nothing is applied before you approve it</div></div><span class="spacer"></span><button class="primary" data-act="adopt-review" data-project="${esc(i.project)}">Review</button><button data-act="adopt-notnow" data-project="${esc(i.project)}">Not now</button></div>`;
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
// API billing (lib/billing.mjs): no weekly limit - the Spend card (Usage) shows the last 24 h of spend against the daily $ cap instead
function apiBurn(b) {
  const $ = v => `$${(Number(v) || 0).toFixed(2)}`, cap = fin(b.cap) && b.cap > 0 ? b.cap : null, over = cap !== null && b.usd >= cap;
  const c = over ? chip('bad', 'daily cap reached: no new Claude work') : cap === null ? chip('warn', 'no daily cap') : chip('ok', 'under the daily cap');
  return `<div class="kv" id="burn-api"><span class="mute small">last 24 h</span><div><span class="big">${$(b.usd)}</span> <span class="mute">${cap === null ? 'spent' : `of the ${$(cap)} daily cap`}</span> ${c}${cap === null ? '' : meter(b.usd, cap, null, over || b.usd > cap * 0.8 ? 'hot' : '')}</div>
     <span class="mute small">runs</span><div class="small" id="burn-api-parts">${$(b.ended_usd ?? b.usd)} from ${plural(b.runs, 'Claude run')} ended in the last 24 h · ${$(b.live_usd)} running${b.live_runs ? ` (${plural(b.live_runs, 'run')}, estimate)` : ''}${b.chat_turns ? ` · ${$(b.chat_usd)} dashboard chats` : ''}</div>
     <span class="mute small">guard</span><div class="small mute">none weekly: API billing has no weekly limit${cap === null ? '. Set a daily cap in Settings (API daily cap) to stop spend past it' : ''}</div></div>`;
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
// RM-30 S1: the Inbox's text goes through the one prose renderer (prose.mjs) with its project's lanes / repo / Docs keys (/api/inbox prose)
const proseCx = (d, ctx, project, key) => ({ ...(d.prose?.[project] || {}), project, sanitize: ctx.sanitize, ...(key ? { clamp: true, key } : {}) });
// an option = a small card: its key, its text, its cost; the recommended one is marked and carries its why
function optCard(o, rk, q, px) {
  const k = o.key ?? o.k, rec = k === rk, cost = o.cost ?? o.c;
  return `<div class="opt${rec ? ' rec' : ''}" data-key="${esc(k)}"><div class="ohead"><b class="okey">${esc(k)}</b>${rec ? ` ${chip('needs', `recommended${recFrom(q.recommend) ? ` · ${recFrom(q.recommend)}` : ''}`)}` : ''}${o.added_by ? ` <span class="small mute qadded">added by ${esc(o.added_by)}</span>` : ''}</div>${renderProse(o.text ?? o.t, px)}
    ${cost ? `<div class="ocost"><span class="olab">cost</span>${renderProse(cost, px)}</div>` : ''}${rec && q.recommend.why ? `<div class="owhy"><span class="olab">why</span>${renderProse(q.recommend.why, px)}</div>` : ''}</div>`;
}

// RM-28 S1: a finished planner run's proposal - its 10-line summary, the plan file, and per stage Queue now / Later / Drop (each
// tap = `norn proposal rule`: a decision by dashboard, then the act). A decided stage shows what it became; the card goes when none is open.
const PICK_DONE = { queue: 'queued', later: 'later', drop: 'dropped', launched: 'launched' };
export function proposalCard(i, ctx) {
  const btn = (s, pick, words, cls = '') => `<button class="${cls}" data-act="proposal" data-project="${esc(i.project)}" data-run="${esc(i.id)}" data-stage="${esc(s.key)}" data-pick="${pick}"${pick === 'later' && !i.item ? ' disabled title="No roadmap item links this lane or run"' : ''}>${words}</button>`;
  const stage = s => `<li class="pstage" id="prop-${esc(i.id)}-${esc(s.key)}"><div><b>${esc(s.key)}</b> ${esc(s.title || s.brief.split('/').pop())}</div>${s.state === 'open'
    ? `<div class="pacts">${btn(s, 'queue', 'Queue now', 'primary')}${btn(s, 'later', 'Later')}${btn(s, 'drop', 'Drop', 'ghost')}</div>`
    : `<div class="small">${chip(s.state === 'drop' ? 'withdrawn' : 'applied', PICK_DONE[s.state] ?? s.state)}${s.ref ? ` <span class="mono">${esc(s.ref)}</span>` : ''}${s.dec ? ` <span class="mute">(${esc(s.dec)})</span>` : ''}</div>`}</li>`;
  return `<article class="q openq proposal" id="prop-${esc(i.id)}"><div class="phead">${chip('open', `${i.open} open`)}<b style="font-size:15px">${esc(i.title)}</b><span class="spacer"></span><span class="small mute">${projTag(ctx, i.project)}${esc(i.id)}${i.item ? ` · ${esc(i.item)}` : ''} · ${fmtMin(minsSince(i.created, ctx.now))} ago</span></div>
    ${i.summary.length ? `<ol class="psum">${i.summary.map(l => `<li>${esc(l.replace(/^\d+[.)]\s*/, ''))}</li>`).join('')}</ol>` : '<p class="small mute">The NOTES file has no summary section.</p>'}
    ${i.plans.length ? `<div class="small">Plan: ${i.plans.map(f => `<span class="mono ppath">${esc(f)}</span>`).join(', ')}</div>` : ''}
    <ul class="pstages">${i.stages.map(stage).join('')}</ul>
    <div class="small mute">Each pick writes a decision (by dashboard). Queue now queues the brief on lane ${esc(i.lane)}${i.item ? ` linked to ${esc(i.item)}` : ''}; Later adds it to the roadmap${i.item ? ` under ${esc(i.item)}` : ''}, horizon next; Drop records only.</div></article>`;
}

// RM-28 S2: Decisions - every open proposal in one section of the Inbox so the owner rules several in one sitting: a count, an index
// (one link per proposal: lane, run, open stages) and the S1 cards themselves (same buttons, same /api/proposal path). Empty = nothing.
export function decisionsSection(items, ctx) {
  const ps = items.filter(i => i.type === 'proposal');
  if (!ps.length) return '';
  const stages = ps.reduce((n, i) => n + i.open, 0);
  const idx = ps.length > 1 ? `<div class="pindex small">${ps.map(i => `<a href="#prop-${esc(i.id)}">${projTag(ctx, i.project)}<b>${esc(i.lane)}</b> ${esc(i.id)} · ${plural(i.open, 'open stage')}</a>`).join('')}</div>` : '';
  return `<section id="inbox-decisions" class="decisions"><h2>Decisions <span class="mute small">${plural(ps.length, 'proposal')} · ${plural(stages, 'open stage')} · each stage is ruled on its own: Queue now, Later or Drop</span></h2>${idx}${ps.map(i => proposalCard(i, ctx)).join('')}</section>`;
}

// INBOX-REPLIES: a question's thread - the owner's messages, the controller's replies (each options revision shown), the ruling it
// proposed from the owner's words (one tap confirms it). (6b) where the options came from and whose recommendation it is.
const recFrom = r => (!r?.from ? '' : r.from === 'source' ? 'plan default' : r.from === 'checkin' || r.from === 'controller' ? "the controller's own" : `${r.from}'s own`);
const optsHead = q => `<div class="small mute qsrc" id="qsrc-${esc(q.id)}">${plural((q.options || []).length, 'option')}${q.origin ? ` · from <button class="lnk" data-ins="${esc(`path:${q.origin.file}`)}"${q.origin.line ? ` data-line="${esc(q.origin.line)}"` : ''} title="${esc(q.origin.file)}">${esc(`${String(q.origin.file).split(/[\\/]/).pop()}#${q.origin.section}`)}</button>` : ''}</div>`;
const tmsg = (x, q, now) => {
  const who = x.ev === 'reply' ? esc(x.who === 'checkin' ? 'controller (check-in)' : x.who) : 'you';
  const body = x.ev === 'answer' ? `answered${x.choice ? ` <b>(${esc(x.choice)})</b>` : ''}${x.ruling ? ' - confirmed the ruling' : ''}: ${esc(x.text)}` : x.ev === 'reopen' ? 'reopened' : esc(x.text);
  const rev = x.options ? `<div class="small qrev">revised the options: ${x.options.map(o => `<b>(${esc(o.key)})</b> ${esc(o.text)}`).join(' · ')}</div>` : '';
  const prop = x.propose ? `<div class="small qprop">Rule: ${x.propose.key ? `<b>(${esc(x.propose.key)})</b> ` : ''}${esc(x.propose.text)}?</div>` : '';
  return `<li class="qmsg ${x.ev === 'reply' ? 'ctl' : 'own'}" id="qm-${esc(q.id)}-${esc(x.seq)}"><span class="small mute">${who} · ${esc(fmtTime(x.ts, now))}</span><div>${body}</div>${rev}${prop}</li>`;
};
function qThread(q, now) {
  const t = q.thread || [], P = q.proposal;
  if (!t.length) return '';
  const wait = q.waiting ? `<li class="small mute qwait">${chip('run', 'replying')} the controller answers here (a check-in started when you sent it, or the next one)</li>` : '';
  const conf = P ? `<div class="card needs qconfirm" id="qconfirm-${esc(q.id)}"><span>Rule: ${P.key ? `<b>(${esc(P.key)})</b> ` : ''}${esc(P.text)}?</span> <button class="primary" data-act="rule" data-project="${esc(q.project)}" data-id="${esc(q.id)}" data-ruling="${esc(P.seq)}">Yes, rule it</button></div>` : '';
  return `<ol class="qthread" id="qt-${esc(q.id)}">${t.map(x => tmsg(x, q, now)).join('')}${wait}</ol>${conf}`;
}
// the Resolved view: answered / applied questions, newest first, each with its thread
function resolvedView(rs, ctx) {
  if (!rs.length) return '';
  const one = r => `<article class="q" id="qr-${esc(r.id)}"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${chip(r.state, `${r.id} ${r.state}`)}<b>${esc(r.title)}</b><span class="spacer"></span><span class="small mute">${projTag(ctx, r.project)}${esc(r.lane ?? '-')} · ${fmtTime(r.updated, ctx.now)}</span></div>
    ${r.origin || r.options.length ? optsHead(r) : ''}${r.answer ? `<p class="small" style="margin:6px 0">${r.answer.choice ? `<b>(${esc(r.answer.choice)})</b> ` : ''}${esc(r.answer.text ?? '')}</p>` : ''}${(r.thread || []).some(x => x.ev !== 'answer') ? qThread({ ...r, waiting: 0, proposal: null }, ctx.now) : ''}</article>`;
  return `<details class="tablecard" id="inbox-resolved" style="margin-bottom:12px"><summary><b>Resolved</b> <span class="mute small">${int(rs.length)} answered or applied, newest first · the thread is kept</span></summary>${rs.map(one).join('')}</details>`;
}

function inbox(d, ctx) {
  const items = d.items || [];
  const qs = items.filter(i => i.type === 'question').map(q => {
    const rk = q.recommend ? q.recommend.key ?? q.recommend.k : null, opts = q.options || [], px = proseCx(d, ctx, q.project);
    const answered = (q.pending || []).some(e => e.ev === 'answer');   // RM-46 S3: answered here, its home relays it - no second answer (SPEC 3.8)
    return `<article class="q openq" id="q-${esc(q.id)}"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">${chip('open', q.id + ' open')}${homeChip(q)}${pendingChips(q)}<b style="font-size:15px;min-width:0;overflow-wrap:anywhere">${esc(q.title)}</b><span class="spacer"></span><span class="small mute">${projTag(ctx, q.project)}${esc(q.lane ?? '-')} · ${fmtMin(minsSince(q.created, ctx.now))} ago${q.class ? ` · class ${esc(q.class)}` : ''}</span></div>
    ${q.body ? `<div class="qbody">${renderProse(q.body, proseCx(d, ctx, q.project, `${q.project}:${q.id}`))}</div>` : ''}
    ${opts.length ? `${optsHead(q)}<div class="opts">${opts.map(o => optCard(o, rk, q, px)).join('')}</div>` : ''}
    ${rk && !opts.some(o => (o.key ?? o.k) === rk) ? `<div class="small owhy"><b>Recommendation (${esc(rk)}${recFrom(q.recommend) ? `, ${esc(recFrom(q.recommend))}` : ''}):</b> ${renderProse(q.recommend.why ?? '', px)}</div>` : ''}
    ${qThread(q, ctx.now)}
    ${q.answered_by ? `<div class="card needs" style="margin:8px 0;padding:8px 10px"><span class="small">Possibly answered in <b class="mono">${esc(q.answered_by.id)}</b>${q.answered_by.words ? `: <q>${esc(q.answered_by.words)}</q>` : ` (${esc(q.answered_by.why ?? '')})`}</span>
      ${q.answered_by.words ? `<button class="primary" style="margin-left:8px" data-act="answer-from" data-project="${esc(q.project)}" data-id="${esc(q.id)}" data-from="${esc(q.answered_by.id)}">Yes - already answered in ${esc(q.answered_by.id)}</button>` : ''}</div>` : ''}
    ${answered ? `<div class="small mute qpending">Your answer is written on this home; home ${esc(q.home)} applies it at its next sync pass (a refusal comes back as a conflict card).</div>` : `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${opts.map(o => { const k = o.key ?? o.k; return `<button class="${k === rk ? 'primary' : ''}" data-act="answer" data-project="${esc(q.project)}" data-id="${esc(q.id)}" data-choice="${esc(k)}" data-text="${esc(`(${k}) ${o.text ?? o.t ?? ''}`)}">Choose (${esc(k)})${k === rk ? ' - recommended' : ''}</button>`; }).join('')}
    <textarea id="ans-${esc(q.id)}" rows="2" placeholder="or write to the controller (a doubt, a question) ..." aria-label="Answer ${esc(q.id)} in your words" style="flex:1;min-width:0"></textarea><button data-act="answer-text" data-project="${esc(q.project)}" data-id="${esc(q.id)}">Send</button></div>`}
    <div class="small mute" style="margin-top:6px">A Choose button answers <span class="mono">${esc(q.id)}</span>; the next tick applies it${q.lane ? ` and unparks ${esc(q.lane)}` : ''}. Words you type go to the controller, who replies here: ${esc(q.id)} stays open until you pick an option or confirm a ruling (a bare key such as <span class="mono">b</span> picks it).</div></article>`;
  }).join('') || `<div class="card" style="margin-bottom:12px">${art(ctx, 'empty-no-questions', 'empty')}${chip('ok', 'all clear')} <span>No open question.</span></div>`;
  const props = decisionsSection(items, ctx);
  const aud = items.filter(i => i.type === 'audit');
  const audCard = aud.length ? `<section class="tablecard" id="inbox-audit" style="margin-bottom:12px"><h3>Audit hunks <span class="mute small">${int(aud.length)} open · the vendor prompt audit proposed them; accept = the check-in applies it, decline = keep the text; Norn edits nothing</span></h3><ul>${aud.map(i => auditCard(i.card, i.project)).join('')}</ul></section>` : '';
  const fxCard = fxSection(items.filter(i => i.type === 'fixresult').map(i => [i.card, i.project, proseCx(d, ctx, i.project)]), 'inbox-fixer', 'tablecard');
  const enf = items.filter(i => i.type === 'enforce');
  const enfCard = enf.length ? `<section class="tablecard" id="inbox-enforce" style="margin-bottom:12px"><h3>Make it enforced? <span class="mute small">${int(enf.length)} correction(s) said again · approve = a directive asks the check-in for a brief; Norn installs nothing</span></h3><ul>${enf.map(i => enforceCard({ ...i.card, approve: i.approve, asked: i.asked }, i.project, proseCx(d, ctx, i.project))).join('')}</ul></section>` : '';
  const dlvCard = (items.some(i => ['setup', 'login', 'hold', 'handedit'].includes(i.type)) ? `<section class="card needs" style="margin-bottom:12px">${items.filter(i => i.type === 'hold').map(i => holdRow(i, ctx)).join('')}${items.filter(i => i.type === 'login').map(i => loginRow(i, ctx)).join('')}${items.filter(i => i.type === 'handedit').map(i => editRow(i, ctx, proseCx(d, ctx, i.project))).join('')}${items.filter(i => i.type === 'setup').map(i => setupRow(i, ctx)).join('')}</section>` : '')
    + (d.deliverables ? `<div style="margin-bottom:12px">${deliverablesCard(d.deliverables, ctx)}</div>` : '');
  const row = (i, st, what) => `<tr id="in-${esc(i.id)}"><td class="id">${esc(i.id)}</td><td>${st}</td><td>${projTag(ctx, i.project)}${what}</td></tr>`;
  const other = [
    ...items.filter(i => i.type === 'parked').map(i => i.ruled ? row(i, chip('answered'), `lane <b>${esc(i.lane)}</b> waiting: your ruling is being applied<div class="small mute">${esc(rulingWords(i.ruled, ctx))}</div>`)
      : row(i, chip('parked'), `lane <b>${esc(i.lane)}</b> ${i.q ? `parked by ${renderProse(i.q, { ...proseCx(d, ctx, i.project), inline: true })}` : renderProse(i.why ?? '', proseCx(d, ctx, i.project, `${i.project}:${i.id}`))}`)),
    ...items.filter(i => i.type === 'unreviewed').map(i => row(i, chip(stateOf(i.state === 'exited' ? `exited: ${String(i.outcome).toUpperCase()}` : i.state)[0], String(i.outcome ?? i.state).toUpperCase()),
      `<b>${esc(i.lane ?? '-')}</b> ${renderProse(i.why ?? '', proseCx(d, ctx, i.project, `${i.project}:${i.id}`))}<div class="small mute">${aname(i.name)} unreviewed: ended with no review event</div>`)),
    ...items.filter(i => i.type === 'answered').map(i => row(i, chip('answered'), `${renderProse(i.title, proseCx(d, ctx, i.project))}<div class="small mute">${esc(rulingWords({ q: i.id, choice: i.answer?.choice, text: i.answer?.text, at: i.updated }, ctx))}</div>`)),
  ].join('');
  const adv = items.filter(i => i.type === 'advice');
  const advCard = adv.length ? `<section class="card" id="inbox-advice" style="margin-bottom:12px"><h2>Model advice <span class="mute small">${plural(adv.length, 'card')} · vendor guidance over what each kind of work cost (Usage tab) · nothing changes until you tap</span></h2>${adv.map(i => adviceRow(i, ctx)).join('')}</section>` : '';
  const rsv = items.filter(i => i.type === 'resolved'), nNeeds = needsYou(items), nInfo = items.length - nNeeds - rsv.length;   // UX review 4: the one needs-you count (terms.mjs)
  return `<h2 class="pagehead" id="inbox-needs">Needs you <b>${int(nNeeds)}</b>${nInfo ? ` <span class="mute small">+ ${int(nInfo)} for information (answered, waiting for the next check-in; model advice; cards already asked for)</span>` : ''}</h2><div class="legend small mute">States: ${['open', 'answered', 'applied', 'superseded', 'withdrawn'].map(s => chip(s)).join(' ')} - set by explicit events only; this page never guesses.</div>${qs}${props}${fxCard}${enfCard}${audCard}${dlvCard}${advCard}
   <div class="tablecard"><h3>Also needs a look <span class="mute small">parked lanes · unreviewed runs · answered, not yet applied</span></h3><table><thead><tr><th>id</th><th>state</th><th>what</th></tr></thead><tbody>${other || '<tr><td colspan="3" class="mute">nothing</td></tr>'}</tbody></table></div>
    ${resolvedView(rsv, ctx)}`;
}

// item 8 (MAIL-9 a): an answered question in plain words wherever it shows - the owner's part is done, a check-in applies it
const rulingWords = (r, ctx) => `You ruled: ${r.choice ?? r.text ?? '?'} (${fmtTime(r.at, ctx.now)}) on ${r.q} - waiting for the next check-in to apply it (an answer starts one at once)`;
const G_TAB = { context: 'Context', tests: 'Tests', usage: 'Usage', runs: 'Runs', docs: 'Docs', slop: 'Slop' };
const G_SEV = { high: 'bad', medium: 'warn', low: 'idle', count: 'idle' };
const shortPath = p => String(p).replace(/\\/g, '/').split('/').slice(-2).join('/');
// RM-27: a SloppaChoppa finding explains itself - its rule's what / why / what to do and the waiver path, folded under the row
const slopExplain = x => `<details class="sexplain"><summary class="small">what this is, why it matters, what to do</summary><dl class="small">
    <dt>What</dt><dd>${esc(x.what)}</dd><dt>Why</dt><dd>${esc(x.why)}</dd><dt>What to do</dt><dd>${esc(x.fix)}</dd>${x.waiver ? `<dt>If it must stay</dt><dd>only the owner or the controller waives it: <code>${esc(x.waiver)}</code></dd>` : ''}</dl></details>`;
const guardRow = (r, labels) => `<li class="grow" id="slop-${esc(r.id)}"><div>${chip(G_SEV[r.severity] ?? 'idle', r.severity)} ${chip('idle', labels[r.type] ?? r.type)}${r.new ? ' ' + chip('needs', 'new') : ''}
    <span>${esc(r.why)}</span></div><div class="small mute">${r.sent ? chip('prov', `sent ${esc(r.sent)}`) + ' ' : ''}${esc(r.surface ?? '')}${r.path ? ` · ${esc(shortPath(r.path))}${r.line ? ':' + esc(r.line) : ''}` : ''} <button class="lnk" ${goAttrs(r.go)}>fix in ${esc(G_TAB[r.go?.tab] ?? r.go?.tab)}</button></div>${r.explain ? slopExplain(r.explain) : ''}${r.apply ? `<details><summary class="small">patch (norn instructions apply ${esc(r.apply)})</summary>${typeof r.patch === 'string' ? `<pre class="inspatch">${esc(r.patch)}</pre>` : ''}</details>` : ''}</li>`;
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
// A run with no parsable hunk is failed: Discard only. Each hunk is the shared diff component (diffview.mjs; RM-35), Open = the diff viewer.
export function fixResultCard(c, project, px = { project }) {
  const pj = ` data-project="${esc(project)}" data-run="${esc(c.run)}"`, failed = c.state === 'failed', st = c.status || [];
  const count = ['drafted', 'skipped', 'missing'].map(k => [k, st.filter(x => x.state === k).length]).filter(([, n]) => n).map(([k, n]) => `${int(n)} ${k}`).join(' · ');
  const why = st.filter(x => x.state !== 'drafted'), fn = f => f.n ?? f.hunks.filter(h => h.applies !== false).length;
  const files = (c.files || []).map(f => `<div class="fxfile" data-file="${esc(f.file)}" data-n="${int(fn(f))}"><div class="fxfilehead"><span class="mono">${esc(f.file)}</span> <span class="small mute">${plural(f.hunks.length, 'hunk')}</span><span class="spacer"></span>${fn(f) ? `<button class="ghost" data-act="fx-skip" data-file="${esc(f.file)}"${pj} aria-pressed="false">Skip this file</button>` : ''}</div>
    ${f.hunks.map(h => `${h.applies === false ? `<p class="small fxmisfit">${chip('bad', 'does not apply')} ${renderProse(h.why ?? '', { ...px, inline: true })} · not in Apply all; its finding stays open</p>` : ''}${diffBlock({ patch: h.patch }, { title: f.file + (h.line ? ':' + h.line : ''), sub: 'fixer hunk', cls: 'fxdiff' })}`).join('')}</div>`).join('');
  const rest = c.more ? `<p class="small"><button class="lnk" data-act="fixall-rest" data-dir="${esc(c.directive)}" data-project="${esc(project)}">${int(c.left)} left: send the fixer for the rest (${plural(c.more, 'run')})</button></p>` : '';
  return `<li class="fxcard" id="fxcard-${esc(c.run)}"><div class="fxtop">${chip(failed ? 'bad' : 'needs', failed ? `failed: ${c.fail || 'no parsable hunk'}` : 'to apply')} <b>Fixer result ${esc(c.run)}</b> <span class="small mute">${esc(c.directive)} · ${esc(c.dec ?? '')} · ${plural(c.n, 'hunk')} in ${plural((c.files || []).length, 'file')}</span></div>
    ${count || c.bad ? `<p class="small">${[count, c.bad ? `${plural(c.bad, 'hunk')} ${c.bad === 1 ? 'does' : 'do'} not apply` : ''].filter(Boolean).join(' · ')}</p>` : ''}${why.length ? `<details><summary class="small">not drafted (${int(why.length)})</summary><ul class="small">${why.map(x => `<li><span class="mono">${esc(x.id)}</span> ${esc(x.state)}${x.why ? ': ' + renderProse(x.why, { ...px, inline: true }) : ''}</li>`).join('')}</ul></details>` : ''}
    ${failed ? `<p class="small">${c.fail === 'no hunk applies' ? 'No hunk applies to the files as they are: nothing to apply. Discard it; the findings stay open.' : 'The run ended without one hunk in the audit format: nothing to apply. Discard it; the findings stay open.'}</p>${c.fail === 'no hunk applies' ? files : ''}` : files}
    <div class="fxbtns">${failed ? '' : `<button class="primary" data-act="fixresult" data-choice="apply"${pj}>Apply all <span class="fx-kept">${int(c.n)}</span></button> `}<button data-act="fixresult" data-choice="discard"${pj}>Discard</button></div>${rest}</li>`;
}
const fxSection = (cards, id, wrap) => (cards.length ? `<section class="${wrap}" id="${id}" style="margin-bottom:12px"><h3>Fixer results <span class="mute small">${plural(cards.length, 'run')} to decide · Apply = the check-in applies the hunks; Norn edits nothing</span></h3><ul class="fxres">${cards.map(([c, p, px]) => fixResultCard(c, p, px)).join('')}</ul></section>` : '');
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
// META-UX-BUILD S2: the page = his section, then the sub-view pattern (subviews.mjs): 4 numbers, To fix / Per type / Rules / By
// age, the chosen part. d = the summary (guardparts.mjs) + d[d.sub] once its part is here (parts_loading until then).
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
  return subviewPage('slop', { title: 'Slop', lead: `${(d.errors || []).length ? `<div class="small mute" id="slop-errors">${d.errors.map(esc).join(' · ')}</div>` : ''}${him}${cards}`, numbers, views: GUARD_SUBS.map(([k, label]) => [k, label, d.counts?.[k]]), active: d.sub, body, loading: d.parts_loading || !P });
}


const DLV_WORD = { done: 'DONE', merged: 'merged', installed: 'installed', unknown: 'cannot tell if merged' };
const dlvChip = r => r.record_state === 'parked'
  ? chip('parked', `parked ${Math.floor(r.park?.days ?? 0)} d${r.park?.expired ? ' (expired)' : ''}`)
  : chip(r.state === 'done' ? 'warn' : r.state === 'unknown' ? 'needs' : r.state === 'merged' ? 'running' : 'ok', `${DLV_WORD[r.state] ?? r.state}${r.merged_how === 'equivalent' ? ' (equivalent)' : ''}`);
const onMain = r => r.state === 'merged' || r.state === 'installed';
// DLV-MERGED-TRUTH: why Norn cannot tell, and the one Inbox ruling that settles it
const dlvWhy = r => r.state === 'unknown' ? `<div class="small mute">${esc(r.unknown_why ?? '')}${r.ruling ? ` · ruling <a href="#" data-rid="${esc(r.ruling)}">${esc(r.ruling)}</a> in the Inbox` : ' · the next check-in asks you'}</div>` : '';
const dlvNative = r => (r.native === true ? chip('bad', 'native') : r.native === false ? '<span class="small mute">no</span>' : '<span class="small mute">?</span>');
export function deliverablesCard(dl, ctx = {}) {
  const rows = (dl?.rows || []).filter(r => !r.at_target).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  const body = rows.map(r => `<tr id="dlv-${esc(r.id)}"><td><b>${projTag(ctx, r.project)}${esc(r.branch)}</b> ${homeChip(r)}<div class="small mute"><span class="id">${esc(r.id)}</span> ${esc(r.lane ?? '')}</div></td>
    <td>${esc(cut(r.delivers, 90))}${r.park ? `<div class="small mute">${esc(r.park.why)}</div>` : ''}${dlvWhy(r)}</td>
    <td class="mono">${fin(r.days) ? r.days.toFixed(1) + ' d' : '-'}</td>
    <td class="mono">${fin(r.behind) ? r.behind + ' behind' : onMain(r) ? 'on main' : '-'}</td>
    <td>${dlvNative(r)}</td>
    <td>${dlvChip(r)}${r.due ? ' ' + chip('open', 'question due') : r.asked ? ` <span class="small mute">asked ${esc(r.asked)}</span>` : ''}</td>
    <td>${r.readonly ? '' : `<button data-dlv="${esc(r.id)}" data-project="${esc(r.project)}">Open</button>`}</td></tr>`).join('');
  if (dl?.pending && !rows.length) return `<section class="card" id="deliverables"><h2>Done, not installed <b>-</b></h2><div class="small mute">reading git and the install receipts ... (the next refresh shows them)</div></section>`;
  return `<section class="card" id="deliverables"><h2>Done, not installed <b>${rows.length}</b> <span class="mute small">oldest first · state from git + the last install receipt</span></h2>
   ${dl?.error ? `<div class="small" style="color:var(--bad)">${esc(dl.error)}</div>` : ''}
   ${rows.length ? `<table><thead><tr><th>branch</th><th>delivers</th><th>done</th><th>vs main</th><th>native</th><th>state</th><th></th></tr></thead><tbody>${body}</tbody></table>`
    : `<div class="item">${art(ctx, 'empty-all-delivered', 'empty')}${chip('ok', 'all clear')}<span>Nothing done-not-installed</span></div>`}</section>`;
}
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
   ${kv('question', r.asked ? `<a href="#" data-rid="${esc(r.asked)}">${esc(r.asked)}</a> (one per deliverable)` : r.due ? chip('open', 'question due: the next check-in asks') : '<span class="mute">none</span>')}</div>
   <h3 style="margin:14px 0 4px">Move it</h3><div class="mono small" style="white-space:pre-wrap">norn deliverables park ${esc(r.id)} --why "&lt;the owner's reason&gt;"
norn deliverables unpark ${esc(r.id)}
norn deliverables ask ${esc(r.id)}      (the check-in: one question per deliverable)${r.resolve ? `
norn deliverables resolve ${esc(r.id)}  (${esc(r.resolve.why)}; native = door work)` : ''}</div>
   <div class="small mute" style="margin-top:8px">MERGED comes from the PR on GitHub, else git, else the change itself found on main (equivalent); INSTALLED from the last install receipt. Only a 'cannot tell' asks you.</div></div>`;
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
  const dir = d.directives.map(r => `<tr id="rec-${esc(r.id)}" data-state="${esc(r.state)}"><td class="id rnw">${esc(r.id)}</td><td>${chip(r.state)} ${homeChip(r)}${pendingChips(r)}</td><td class="rt">${recText(`${r.id}:text`, [blk(r.data.text, 110)])}${fids(r)}${r.superseded_by ? `<div class="small mute">superseded by ${esc(r.superseded_by)}</div>` : ''}${history(r, ctx)}</td>
    <td class="small mute rnw">${fmtTime(r.created, ctx.now)} · ${esc(r.data.via ?? r.by)}</td><td>${r.state === 'active' ? `<button class="ghost" data-act="revoke" data-project="${esc(d.project)}" data-id="${esc(r.id)}">Revoke</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="5" class="mute">no directives</td></tr>';
  const dec = d.decisions.map(r => `<tr id="rec-${esc(r.id)}" data-state="${esc(r.state)}"><td class="id rnw">${esc(r.id)}</td><td>${chip(r.state)}${r.data.fyi ? ' ' + chip('needs', 'FYI') : ''}${decMark(r)} ${homeChip(r)}${pendingChips(r)}</td><td>${esc(r.data.lane ?? '-')}</td><td class="rt" data-label="question">${recText(`${r.id}:q`, [blk(r.data.question, 50)])}</td>
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
  return `${subviewPage('context', { title: 'Context', lead: `${insRefreshing(d, now)}<div class="small mute" id="context-what">what every session loads before any work, and what that costs · last ${int(d.measured?.window_days ?? 7)} days</div>`, numbers: contextNumbers(d), views: CONTEXT_SUBS.map(([k, label]) => [k, label, k === 'file' ? n.files : undefined]), active: d.sub, body: d.parts_loading ? '' : body, loading: d.parts_loading })}
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
    <ul>${xs.slice(0, INS_CAPS.advisories).map(a => `<li class="insfind small"><span class="mute">${esc(baseName(a.path) || a.surface)}${a.line ? `:${esc(a.line)}` : ''}</span> ${esc(a.why)}${a.fix.patch ? diffBlock({ patch: a.fix.patch }, { title: baseName(a.path) || a.surface, sub: 'proposed fix' }) : ''}</li>`).join('')}</ul></details></li>`).join('');
  return `<div class="tablecard" id="ins-ladder"><h3>The ladder <span class="mute small">${int(LADDER_STATES.reduce((n, st) => n + (L.counts[st] ?? 0), 0))} must / never rules by state · prose only ${int(L.counts.prose)} → repeated ${int(L.counts.repeated)} → enforced ${int(L.counts.enforced)} → retired ${int(L.counts.retired)} · tap a home to open its line</span></h3>
    ${board(cols, { id: 'ins-board', aria: 'rules by state' })}
    ${finds ? `<ul id="ins-rule-findings">${finds}</ul>` : ''}</div>`;
}
// META-TEND P5 (REPORT 3.3): one vendor-audit hunk = one card; accept = a decision + a directive (the check-in applies it), decline = a decision
function auditCard(c, project) {
  const pj = project ? ` data-project="${esc(project)}"` : '';
  return `<li class="insfind" id="aud-${esc(c.id)}">${chip(SEV_CHIP[c.severity] ?? 'idle', c.severity)} <b>${esc(baseName(c.path))}:${esc(c.line)}</b> ${esc(c.why)} <span class="small mute">${esc(c.run)} · ${esc(c.id)}</span>
    ${diffBlock({ patch: c.fix.patch ?? '' }, { title: `${baseName(c.path)}:${c.line}`, sub: 'vendor audit hunk' })}
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
// RM-30 S1: a card its directive already asks for (rules.mjs askedBy) reads "Asked as DIR-n (state) - date" with a link and has no
// Approve; Approve is one tap (the directive is the record and can be revoked) and sends the card id, which the directive keeps
function enforceCard(c, project, px = { project }) {
  const a = c.asked;
  return `<li class="insfind${a ? ' asked' : ''}" id="enf-${esc(c.id)}">${chip(a ? 'ok' : c.severity === 'medium' ? 'warn' : 'idle', a ? 'asked' : c.severity)} <div class="enf-why">${renderProse(c.why, px)}</div>
    <details><summary class="small">${int((c.items || []).length)} corrections · the draft</summary><ul class="small">${(c.items || []).map(x => `<li>${renderProse(x.text, px)}</li>`).join('')}</ul>${diffBlock({ patch: c.fix.patch ?? '' }, { title: 'the draft', sub: 'repeat detector draft' })}</details>
    ${a ? `<div class="small enf-asked">Asked as <a class="rid r-dir" href="#" data-rid="${esc(a.id)}"${project ? ` data-project="${esc(project)}"` : ''}>${esc(a.id)}</a> (${esc(a.state)}) - ${esc(fmtLocal(a.at))}</div>`
    : `<div class="small mute">${esc(c.fix.action)}</div>
    <button class="primary" data-act="adv-approve"${project ? ` data-project="${esc(project)}"` : ''} data-id="${esc(c.id)}" data-text="${esc(c.approve)}">Approve: ask for a brief</button>`}</li>`;
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
// a JSON file, or a source file a run touched (f.code: its language, RM-36), is one code block; the fence outruns any ``` inside it
function docReader(f, ctx, d = {}) {
  const lang = /\.json$/i.test(f.path) ? 'json' : f.code ?? null, text = f.text ?? '', lines = text.split(/\r?\n/);
  const fence = lang ? '`'.repeat([...text.matchAll(/`{3,}/g)].reduce((n, m) => Math.max(n, m[0].length + 1), 3)) : '', src = lang ? `${fence}${lang}\n${text}\n${fence}` : text, json = !!lang;
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
// RM-46 S3: a synced project's Homes + Claims blocks, above the ledger lines on the same page (no new tab); secs = a duration in words
const secs = v => v == null ? '-' : v < 120 ? `${v} s` : v < 7200 ? `${Math.round(v / 60)} min` : `${Math.round(v / 3600)} h`;
function syncBlocks(d, ctx) {
  if (!d.homes) return '';
  const h = d.homes, c = d.claims || { work: [] };
  const homes = `<div class="tablecard" id="ledger-homes"><h3>Homes <span class="mute small">this home: ${esc(h.home)} · last fetch ${h.fetched_at ? fmtTime(h.fetched_at, ctx.now) : 'never'}${h.fetch_error ? ` · ${esc(h.fetch_error)}` : ''}</span></h3>
   <table><thead><tr><th>home</th><th>head</th><th>lag</th><th>clock ahead</th></tr></thead><tbody>${h.rows.map(r => `<tr><td>${homeChip(r)}</td><td class="id">${esc(String(r.head).slice(0, 10))}</td><td>${secs(r.lag_s)}</td><td>${secs(r.ahead_s)}</td></tr>`).join('') || '<tr><td colspan="4" class="mute">no other home fetched yet</td></tr>'}</tbody></table></div>`;
  const work = c.work.map(w => `<tr><td>${homeChip(w)}<b>${esc(w.lane)}</b></td><td class="id">${esc(w.run ?? '-')} n=${esc(w.n)}</td><td class="small">${w.renewed_at ? fmtTime(w.renewed_at, ctx.now) : '-'}</td>
    <td>${w.stale ? `${chip('bad', 'stale')} <button class="ghost" data-act="claim-take" data-project="${esc(ctx.project ?? '')}" data-lane="${esc(`${w.home}/${w.lane}`)}">Take over</button>` : chip('ok', 'active')}</td></tr>`).join('');
  const claims = `<div class="tablecard" id="ledger-claims"><h3>Claims <span class="mute small">merge leader: ${c.leader ? `${esc(c.leader.home)} · renewed ${fmtTime(c.leader.renewed_at, ctx.now)}` : 'none'}</span></h3>
   <table><thead><tr><th>lane</th><th>run</th><th>renewed</th><th>state</th></tr></thead><tbody>${work || '<tr><td colspan="4" class="mute">no work claims</td></tr>'}</tbody></table></div>`;
  return homes + claims;
}
function ledger(d, ctx) {
  const entries = parseLedger(d.ledger), more = d.more ? `<button class="ghost" data-act="ledger-more">Show older (${esc(d.count ?? 100)} more lines)</button>` : '';
  return `${syncBlocks(d, ctx)}<div class="filters"><input type="search" data-filter="ledger" placeholder="search text, ids  (e.g. RUN-12, merged)"><select data-filter-state="ledger"><option value="">all kinds</option>${LEDGER_KINDS.map(k => `<option value="${k}">${k === 'other' ? 'notes / headings' : k}</option>`).join('')}</select>
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
// RM-26 the mark "below floor": a decision a check-in recorded while its run's model / effort was below the check-in floor
// (records.mjs made_under.below_floor). A record without made_under is unmarked.
const BELOW_FLOOR = '<span class="chip warn below-floor">below floor</span>';
export const decMark = r => (r.data?.made_under?.below_floor ? ` <span class="chip warn below-floor" title="${esc(`made under ${r.data.made_under.model}, effort ${r.data.made_under.effort ?? 'default'}`)}">below floor</span>` : '');
// RM-26: while the check-in model / effort in force is below the check-in floor (policy checkinBelowFloor) a notice heads Settings;
// a warning, nothing is refused. The decisions such a check-in records carry the mark (decMark).
function checkinNotice(rows) {
  if (!rows?.length) return '';
  return `<div class="banner" id="checkin-floor-notice"><b>Check-in below the floor.</b> ${rows.map(r => `${r.kind === 'model' ? 'Model' : 'Effort'} ${esc(r.value)} (floor ${esc(r.to)})`).join(' · ')}: ${esc(rows[0].text)}. Its decisions are marked ${BELOW_FLOOR}.</div>`;
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
  return `${checkinNotice(d.checkin_below)}${profileBar(d, ctx.setLevel ?? 'basic')}<div class="settings"><aside class="snav"><input type="search" id="set-search" data-set-search placeholder="Search settings  ·  @modified" aria-label="Search settings">${nav}</aside>
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
   ${parts.map(p => usagePart(p, { ...ctx, refresh: d.account_refresh }) + forecastCard((d.forecasts || {})[p.project], ctx.now)).join('') || '<p class="mute">No project.</p>'}`;
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
  const m = s.match(/^rm-(RM-(?:[a-z][a-z0-9]{0,15}-)?\d+)$/);
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
const rmHead = (i, ctx, par, compact) => `<div class="rmh">${rmChip(i)}${par}<b class="rmt">${esc(i.title)}</b><span class="id">${esc(i.id)}</span>${homeChip(i)}${pendingChips(i)}${i.horizon ? `<span class="tg tg-hz">${esc(i.horizon)}</span>` : ''}${rmLive(i, ctx)}${(i.flags?.drift || []).length ? '<span class="chip bad">drift</span>' : ''}${i.stuck?.flag ? `<span class="chip bad" title="${esc('stuck since ' + i.stuck.flag.ts.slice(0, 16) + 'Z: ' + i.stuck.flag.why.join(', ') + ' - further rounds wait for an approach review')}">stuck</span>` : ''}${compact ? '' : rmProg(i)}${rmEditBtn(i)}</div>`;
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
