// Engine dashboard UI (META-GENERAL-DESIGN 7, 12-S7): pure renderers, data -> HTML strings, fed by the S6 /api endpoints.
// The same module runs in the browser (index.html imports /ui.mjs) and in node --test (server-side render check of the ids).
// Rules (section 7): status = text + colour (a chip always carries a word), numbers with units, ids everywhere, tabular
// numerals (CSS), one accent colour for "needs you", no animation and no timer (index.html re-renders from the /api/stream state stream).
import { renderMarkdown } from './docs.mjs';
import { renderProse } from './prose.mjs';
import { parseLedger, ledgerInline, LEDGER_KINDS, recordBlocks } from './ledger.mjs';
import { renderAdopt, adoptStep } from './adopt.mjs';
import { renderHome } from './home.mjs';
import { bars, columns, stack, meter, capStrip } from './widgets.mjs';
import { CONTEXT_SUBS, contextParts } from './insparts.mjs';
import { SUB_CAP, pickSub, subviewPage, subMore } from './subviews.mjs';
import { TESTS_SUBS } from './testparts.mjs';
import { GUARD_SUBS } from './guardparts.mjs';
import { firstDoc } from './docparts.mjs';
import { needsYou } from './terms.mjs';
import { esc, fin, int, fmtMin, pct, plural, runWho, chip, stateOf, projTag, homeChip, pendingChips, pauseAct, cut, fmtTime, guardOn, guardChip } from './cells.mjs';
import { lanesPage, LANES_SUBS } from './pages/lanes.mjs';
import { runs } from './pages/runs.mjs';
import { context, auditCard, enforceCard } from './pages/context.mjs';
import { docs } from './pages/docs.mjs';
import { roadmap } from './pages/roadmap.mjs';
import { spend, adviceRow } from './pages/spend.mjs';
import { slopPage, fxSection } from './pages/slop.mjs';
// NORN-UI-NAV: every page, the bar's four first (shell.mjs BAR), then the More sheet's (shell.mjs MORE). Label = id = URL (?tab=<id>)
export const TABS = [['lanes', 'Lanes'], ['runs', 'Runs'], ['inbox', 'Inbox'], ['talk', 'Talk'],
  ['spend', 'Spend'], ['slop', 'Slop'], ['tests', 'Tests'], ['context', 'Context'], ['records', 'Records'], ['ledger', 'Ledger'], ['docs', 'Docs'],
  ['roadmap', 'Roadmap'], ['settings', 'Settings']];
export const ONE_PROJECT = ['talk', 'roadmap', 'records', 'docs', 'context', 'slop', 'ledger', 'settings', 'tests'];

const minsSince = (iso, now) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? (now - t) / 60000 : null; };

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
// Stage RUNS: Runs paints the live part (running + queue) first; its one part is the history (the ended runs in the window), keyed by
// the live answer's time so a stream repaint fetches it afresh
const PART_NAMES = { context: d => contextParts(d.sub), slop: d => [d.sub], docs: d => (d.file ? ['file'] : []), tests: d => [d.sub], runs: () => ['history'] };
const PART_API = { context: 'instructions', slop: 'guard', runs: 'agents' };   // META-UX-BUILD S5: Slop (was Guard) keeps its route /api/guard
const runsWin = w => (w && w !== '2h' ? `&window=${w}` : '');
export const partsKey = (tab, project, d) => (tab === 'runs' ? `${project}|${d.window}|${d.at}` : tab === 'context' ? `${project}|${d.at}|${d.sub}` : tab === 'docs' ? `${project}|${d.sig}|${d.file}` : tab === 'tests' ? `${project}|${d.times?.at}|${(d.history || []).length}|${d.sub}|${d.limit}|${d.batch ?? ''}` : `${project}|${d.sig}|${d.sub}|${d.limit}|${d.batch ?? ''}|${d.finding ?? ''}`);
export async function loadParts(tab, project, d, get) {
  const pick = b => (b.startsWith('lane:') ? `&lane=${encodeURIComponent(b.slice(5))}` : `&files=${encodeURIComponent(b.slice(6))}`);
  const q = `project=${encodeURIComponent(project)}`, lim = tab === 'docs' ? `&file=${encodeURIComponent(d.file)}` : d.limit && tab !== 'context' ? `&limit=${d.limit}${d.batch ? (tab === 'tests' ? pick(d.batch) : `&batch=${encodeURIComponent(d.batch)}`) : ''}${d.finding ? `&finding=${encodeURIComponent(d.finding)}` : ''}` : '';
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
  if (tab === 'talk') return get(`/api/home?${q}`);   // META-CONTROLLER C2 (the route keeps its name: routes stay, labels and the URL tab move)
  if (tab === 'inbox') { const [ib, deliverables] = await Promise.all([get(`/api/inbox?${q}`), dlvGet(get, q)]); return { ...ib, deliverables }; }
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
  if (tab === 'tests') {   // META-TEND TESTS. TESTS-RUNTIME: the summary first, then the chosen sub-view's part (Impact: its pick in batch)
    const sub = pickSub(TESTS_SUBS, ctx.sub), d = { ...(await get(`/api/tests?${q}`)), sub, limit: ctx.limit || SUB_CAP, ...(sub === 'impact' && ctx.batch ? { batch: ctx.batch } : {}) };
    const have = partsHave(ctx, 'tests', project, d);
    return { ...d, ...(have || {}), parts_loading: !have };
  }
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
  if (tab === 'talk') return panel(tab, renderHome(d, { ...ctx, now }));
  return panel(tab, ({ inbox, lanes: lanesPage, runs, roadmap, records, docs, context, ledger, settings, tests, slop: slopPage, spend })[tab](d, { ...ctx, now }));
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
      `<b>${esc(i.lane ?? '-')}</b> ${renderProse(i.why ?? '', proseCx(d, ctx, i.project, `${i.project}:${i.id}`))}<div class="small mute">${runWho(i.dwarf, i.kind_word)} unreviewed: ended with no review event</div>`)),
    ...items.filter(i => i.type === 'answered').map(i => row(i, chip('answered'), `${renderProse(i.title, proseCx(d, ctx, i.project))}<div class="small mute">${esc(rulingWords({ q: i.id, choice: i.answer?.choice, text: i.answer?.text, at: i.updated }, ctx))}</div>`)),
  ].join('');
  const adv = items.filter(i => i.type === 'advice');
  const advCard = adv.length ? `<section class="card" id="inbox-advice" style="margin-bottom:12px"><h2>Model advice <span class="mute small">${plural(adv.length, 'card')} · vendor guidance over what each kind of work cost (Spend) · nothing changes until you tap</span></h2>${adv.map(i => adviceRow(i, ctx)).join('')}</section>` : '';
  const rsv = items.filter(i => i.type === 'resolved'), nNeeds = needsYou(items), nInfo = items.length - nNeeds - rsv.length;   // UX review 4: the one needs-you count (terms.mjs)
  return `<h2 class="pagehead" id="inbox-needs">Needs you <b>${int(nNeeds)}</b>${nInfo ? ` <span class="mute small">+ ${int(nInfo)} for information (answered, waiting for the next check-in; model advice; cards already asked for)</span>` : ''}</h2><div class="legend small mute">States: ${['open', 'answered', 'applied', 'superseded', 'withdrawn'].map(s => chip(s)).join(' ')} - set by explicit events only; this page never guesses.</div>${qs}${props}${fxCard}${enfCard}${audCard}${dlvCard}${advCard}
   <div class="tablecard"><h3>Also needs a look <span class="mute small">parked lanes · unreviewed runs · answered, not yet applied</span></h3><table><thead><tr><th>id</th><th>state</th><th>what</th></tr></thead><tbody>${other || '<tr><td colspan="3" class="mute">nothing</td></tr>'}</tbody></table></div>
    ${resolvedView(rsv, ctx)}`;
}

// item 8 (MAIL-9 a): an answered question in plain words wherever it shows - the owner's part is done, a check-in applies it
const rulingWords = (r, ctx) => `You ruled: ${r.choice ?? r.text ?? '?'} (${fmtTime(r.at, ctx.now)}) on ${r.q} - waiting for the next check-in to apply it (an answer starts one at once)`;



const DLV_WORD = { done: 'DONE', merged: 'merged', installed: 'installed', unknown: 'cannot tell if merged' };
const dlvChip = r => r.record_state === 'parked'
  ? chip('parked', `parked ${Math.floor(r.park?.days ?? 0)} d${r.park?.expired ? ' (expired)' : ''}`)
  : chip(r.state === 'done' ? 'warn' : r.state === 'unknown' ? 'needs' : r.state === 'merged' ? 'running' : 'ok', `${DLV_WORD[r.state] ?? r.state}${r.merged_how === 'equivalent' ? ' (equivalent)' : ''}`);
const onMain = r => r.state === 'merged' || r.state === 'installed';
// DLV-MERGED-TRUTH: why Norn cannot tell, and the one Inbox ruling that settles it
const dlvWhy = r => r.state === 'unknown' ? `<div class="small mute">${esc(r.unknown_why ?? '')}${r.ruling ? ` · ruling <a href="#" data-rid="${esc(r.ruling)}">${esc(r.ruling)}</a> in the Inbox` : ' · the next check-in asks you'}</div>` : '';
// OVERVIEW-TRUTH (2): why a DONE row is not merged (deliverablesView why_not, dlvwhy.mjs), in words with its link: the run opens in the
// live feed drawer, the PR on GitHub; 'no merge queued' and a stopped merge are warn chips
const whyLink = (w, r) => w.url ? ` <a href="${esc(w.url)}" target="_blank" rel="noopener">open</a>`
  : w.run ? ` <span class="link" role="button" tabindex="0" data-feed="${esc(w.run)}" data-project="${esc(r.project)}" title="Open ${esc(w.run)} in the live feed">${esc(w.run)}</span>` : '';
export const dlvWhyNot = r => (!r.why_not ? '' : `<div class="small dlvwhy" data-why="${esc(r.why_not.kind)}">${r.why_not.warn ? chip('warn', r.why_not.text) : `<span class="mute">${esc(r.why_not.text)}</span>`}${whyLink(r.why_not, r)}</div>`);
const dlvNative = r => (r.native === true ? chip('bad', 'native') : r.native === false ? '<span class="small mute">no</span>' : '<span class="small mute">?</span>');
export function deliverablesCard(dl, ctx = {}) {
  const rows = (dl?.rows || []).filter(r => !r.at_target).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  const body = rows.map(r => `<tr id="dlv-${esc(r.id)}"><td><b>${projTag(ctx, r.project)}${esc(r.branch)}</b> ${homeChip(r)}<div class="small mute"><span class="id">${esc(r.id)}</span> ${esc(r.lane ?? '')}</div></td>
    <td>${esc(cut(r.delivers, 90))}${r.park ? `<div class="small mute">${esc(r.park.why)}</div>` : ''}${dlvWhy(r)}${dlvWhyNot(r)}</td>
    <td class="mono">${fin(r.days) ? r.days.toFixed(1) + ' d' : '-'}</td>
    <td class="mono">${fin(r.behind) ? r.behind + ' behind' : onMain(r) ? 'on main' : '-'}</td>
    <td>${dlvNative(r)}</td>
    <td>${dlvChip(r)}${r.due ? ' ' + chip('open', 'question due') : r.asked ? ` <span class="small mute">asked ${esc(r.asked)}</span>` : ''}</td>
    <td>${r.readonly ? '' : `<button data-dlv="${esc(r.id)}" data-project="${esc(r.project)}">Open</button>`}</td></tr>`).join('');
  // OVERVIEW-TRUTH (3): the heading's count is mergeBacklog's (deliverables.mjs, server backlogOf) - the one count Lanes and Plan show too
  const b = dl?.backlog, k = n => rows.filter(n).length, pr = k(r => r.state === 'done' && r.pr), mi = k(r => r.state === 'merged');
  const head = b && !b.pending ? `${chip(b.over ? 'warn' : b.n ? 'idle' : 'ok', b.text)}${b.over ? ` <span class="mute small">over ${int(b.max)}: new lanes wait while finished work lands</span>` : ''}` : '';
  if (dl?.pending && !rows.length) return `<section class="card" id="deliverables"><h2>Done, not installed <b>-</b></h2><div class="small mute">reading git and the install receipts ... (the next refresh shows them)</div></section>`;
  return `<section class="card" id="deliverables"><h2>Done, not installed <b>${rows.length}</b> <span class="mute small">this project's deliverables not at their target, oldest first · state from git, the PR and the last install receipt</span></h2>
   ${head || pr || mi ? `<p class="small" id="dlv-counts">${head}${pr ? ` <span class="mute">· ${int(pr)} with a PR open</span>` : ''}${mi ? ` <span class="mute">· ${int(mi)} merged, not installed</span>` : ''}</p>` : ''}
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
   ${r.why_not ? kv('not merged', dlvWhyNot(r)) : ''}${kv('question', r.asked ? `<a href="#" data-rid="${esc(r.asked)}">${esc(r.asked)}</a> (one per deliverable)` : r.due ? chip('open', 'question due: the next check-in asks') : '<span class="mute">none</span>')}</div>
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
// NORN-UI-SYNC: Settings > Sync's pane subs (policy.mjs SECTIONS sync, pane:true) from the server's sync block (server.mjs syncInfo).
// machine = the state + the ledger form (the topic is write-only: the page only knows on / off); setup = the guided cut --bare / join
// (Check = the dry run, Apply = pause, cut, publish + fetch, resume); duplicates = Find duplicates (dry) / Write the cards. The buttons
// post /api/sync/* (index.html); the answers land in the role=status <pre> below each.
const ago = s => (s == null ? 'never' : s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
function syncPane(x, d, said = {}) {
  const s = d.sync || {}, id = `sub-sync-${x.id}`, out = k => `<pre class="small sync-out" id="sync-${k}-out" role="status">${esc(said[k] ?? '')}</pre>`;
  const head = `<h3>${esc(x.label)}${x.help ? ` <span class="help">${esc(x.help)}</span>` : ''}</h3>`, wrap = (body, search) => `<div class="ssub" id="${id}">${head}<div class="srow" data-basic="1" data-search="${esc(search)}" data-mod="0">${body}</div></div>`;
  if (x.id === 'machine') {
    const st = s.home ? chip('ok', `home ${s.home}`) : chip('idle', 'solo');
    const pub = s.stopped ? chip('bad', `stopped: ${s.stopped}`) : s.head ? `published ${esc(String(s.head).slice(0, 8))}${s.pushed ? ' · pushed' : ' · not pushed yet'}` : 'nothing published yet';
    const fetched = s.fetch_error ? chip('bad', `fetch failed: ${s.fetch_error}`) : s.fetched_at ? `fetched ${esc(fmtTime(s.fetched_at))}` : 'not fetched yet';
    const lag = (s.homes || []).map(h => `<li>home <b>${esc(h.home)}</b> <span class="mute">last record ${esc(ago(h.lag_s))} ago${h.ahead_s ? ` · ${esc(ago(h.ahead_s))} not merged here yet` : ''}</span></li>`).join('');
    return wrap(`<div class="sl"><b>This machine</b> <span class="tag">machine</span> ${st} ${s.doorbell ? chip('ok', 'doorbell on') : chip('idle', 'doorbell off')}
      <span class="help">${s.home ? `${pub} · ${fetched}` : 'Solo: this project is built on this machine only. Set up / join below makes it a home.'}</span>
      ${lag ? `<ul class="small">${lag}</ul>` : ''}</div>
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
      if (x.pane) return syncPane(x, d, ctx.syncOut);
      const items = d.settings.filter(s => at(s) === `${c.id}/${x.id}` || at(s).startsWith(`${c.id}/${x.id}/`));
      const body = x.subs ? x.subs.map(y => { const g = items.filter(s => s.section[2] === y.id); return g.length ? (x.inline ? inlineGroup(c, x, y, g, x.id === 'routing' ? guardChip(guardOn(d.guard, r => r.type === 'models' && r.cls === y.id), { tab: 'spend', sub: 'advice' }) : '') : g.map(row).join('')) : ''; }).join('') : items.map(row).join('');
      return `<div class="ssub${x.danger ? ' danger' : ''}" id="sub-${esc(c.id)}-${esc(x.id)}"><h3>${esc(x.label)}${x.help ? ` <span class="help">${esc(x.help)}</span>` : ''}</h3>${x.id === 'capacity' ? capPane(d) : ''}${body}</div>`;
    }).join('');
    return `<section class="scat" id="cat-${esc(c.id)}" data-cat="${esc(c.id)}"${c.id === sel ? '' : ' hidden'}><h2>${esc(c.label)}</h2><p class="small mute">${esc(c.help)}</p>${subs}</section>`;
  }).join('');
  return `${checkinNotice(d.checkin_below)}${profileBar(d, ctx.setLevel ?? 'basic')}<div class="settings"><aside class="snav"><input type="search" id="set-search" data-set-search placeholder="Search settings  ·  @modified" aria-label="Search settings">${nav}</aside>
   <div class="spane"><p class="small mute" id="set-nohit" hidden>No setting matches.</p>${panes}</div></div>
   <div class="savebar"><span class="small" id="dirty-count">No unsaved changes</span><button class="strong" data-act="settings-review" data-project="${esc(d.project)}" data-version="${esc(d.version)}">Review changes</button><button class="ghost" data-act="settings-discard">Discard</button>
   <span class="small mute">Review shows a diff; Save writes atomically and refuses a stale version (409).</span><div id="settings-diff"></div></div>`;
}
