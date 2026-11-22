// Engine dashboard UI (META-GENERAL-DESIGN 7, 12-S7): pure renderers, data -> HTML strings, fed by the S6 /api endpoints.
// The same module runs in the browser (index.html imports /ui.mjs) and in node --test (server-side render check of the ids).
// Rules (section 7): status = text + colour (a chip always carries a word), numbers with units, ids everywhere, tabular
// numerals (CSS), one accent colour for "needs you", no animation and no timer (index.html re-renders from the /api/stream state stream).
import { renderProse } from './prose.mjs';
import { renderAdopt, adoptStep } from './adopt.mjs';
import { renderHome } from './home.mjs';
import { bars, columns, stack, meter } from './widgets.mjs';
import { CONTEXT_SUBS, contextParts } from './insparts.mjs';
import { SUB_CAP, pickSub, subviewPage, subMore } from './subviews.mjs';
import { TESTS_SUBS } from './testparts.mjs';
import { GUARD_SUBS } from './guardparts.mjs';
import { firstDoc } from './docparts.mjs';
import { esc, fin, int, fmtMin, pct, plural, chip, pauseAct, fmtTime, goAttrs, filterChips } from './cells.mjs';
import { lanesPage, LANES_SUBS } from './pages/lanes.mjs';
import { runs } from './pages/runs.mjs';
import { context } from './pages/context.mjs';
import { docs } from './pages/docs.mjs';
import { roadmap } from './pages/roadmap.mjs';
import { spend } from './pages/spend.mjs';
import { slopPage } from './pages/slop.mjs';
import { settings } from './pages/settings.mjs';
import { inbox } from './pages/inbox.mjs';
import { records, ledger } from './pages/ledger.mjs';
// NORN-UI-NAV: every page, the bar's four first (shell.mjs BAR), then the More sheet's (shell.mjs MORE), then Settings (the header's
// cog, shell.mjs COG). Label = id = URL (?tab=<id>)
export const TABS = [['talk', 'Talk'], ['lanes', 'Lanes'], ['runs', 'Runs'], ['inbox', 'Inbox'],
  ['spend', 'Spend'], ['slop', 'Slop'], ['tests', 'Tests'], ['context', 'Context'], ['records', 'Records'], ['ledger', 'Ledger'], ['docs', 'Docs'],
  ['roadmap', 'Roadmap'], ['settings', 'Settings']];
export const ONE_PROJECT = ['talk', 'roadmap', 'records', 'docs', 'context', 'slop', 'ledger', 'settings', 'tests'];


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
//   Costs and health - gate time per merge, the merge check, lean tests
//   Impact           - which test files cover a source file, or a lane's changed files (`norn tests for`)
//                      then over time: test cases / lines and suite time, suite CPU-minutes per full run, the last lean-tests wave
//   Run time         - test-diet S1: per worker run of the last 24 h / 3 days its wall time, test time and share (norn speed), the
//                      duplicate test files the machine's test cache spared it, and the policy.tests in force with its Settings rows
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
function testsSuite(d, ctx) {
  const now = d.breakdown ? testsBreakdown(d.breakdown) + testsList(d) : `<div class="card" id="tests-suite-empty">${notYet('per-test runtimes', `<span class="mono">${esc(d.commands.measure)}</span> times every test of a node:test or pytest suite: a full suite run, once, on a quiet machine`)}</div>`;
  const h = d.history || [], g = d.git?.points || [];
  const cpu = `<div class="tablecard" id="tests-cpu"><h3>Suite CPU-minutes per full run <span class="mute small">a hygiene pass pays off here</span></h3>${d.cpu?.length ? `<div style="padding:4px 12px">${columns(d.cpu.map(x => ({ label: String(x.at).slice(5, 10), value: x.cpu_min })), { fmt: v => `${v} min`, title: 'suite CPU-minutes per full run', id: 'tests-cpu-cols', unit: 'CPU-min', per: 'run' })}</div>` : notYet('suite CPU time', 'a measure that records its CPU-minutes (cpu_min in history.jsonl)')}</div>`;
  return now + testsOver(h, g, h.at(-1), g.at(-1)) + cpu + testsWave(d.wave, ctx);
}
// ---- Costs and health ----
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
const testsCosts = (d, ctx) => testsMerges(d, ctx) + testsAdv(d) + testsLean(d);
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
// ---- Suite: over time ----
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
// ---- Run time (test-diet S1) ----
const RT_WIN = [['24h', '24 h', 86400e3], ['3d', '3 days', 3 * 86400e3]];
function testsRuntime(d, ctx) {
  const f = { window: '24h', over: false, saved: false, ...(ctx.testsRt || {}) }, now = ctx.now ?? Date.now(), win = RT_WIN.find(w => w[0] === f.window) ?? RT_WIN[0];
  const all = (d.rows || []).filter(r => r.state === 'running' || now - Date.parse(r.ended ?? r.started) <= win[2]), rows = all.filter(r => (!f.over || r.over) && (!f.saved || r.dup > 0));
  const sum = k => rows.reduce((n, r) => n + (r[k] || 0), 0), wall = sum('wall_ms'), test = sum('test_ms');
  const chips = filterChips('window', RT_WIN.map(([k, text]) => ({ act: 'tests-rt', data: { rt: 'window', v: k }, on: f.window === k, text })))
    + filterChips('show only', [{ act: 'tests-rt', data: { rt: 'over' }, on: f.over, text: 'over budget', n: all.filter(r => r.over).length, title: 'runs whose test time went past policy.tests.run_budget_min' },
      { act: 'tests-rt', data: { rt: 'saved' }, on: f.saved, text: 'saved', n: all.filter(r => r.dup > 0).length, title: 'runs the test cache spared a duplicate test run' }]);
  const pol = `<p class="small" id="tests-policy" style="padding:0 12px">In force: <b>${esc(d.words ?? '-')}</b> · ${(d.settings || []).map(k => `<button class="lnk" data-act="open-setting" data-setting="${esc(k)}" title="open ${esc(k)} in Settings">${esc(k.split('.').pop())}</button>`).join(' · ')}</p>`;
  const li = r => `<li data-run="${esc(r.id)}"><button class="lnk" ${goAttrs({ tab: 'runs', jump: `node-${r.id}` })} title="open it on the Runs page">${esc(r.id)}</button> <span class="mute">${esc(r.lane ?? '')}</span>${r.state === 'running' ? ` ${chip('running', 'running')}` : ''}${r.over ? ` ${chip('bad', 'over budget')}` : ''}
    <div class="small">${fin(r.wall_ms) ? `<b>${fmtMin(r.test_ms / 60000)}</b> of ${fmtMin(r.wall_ms / 60000)} in tests${fin(r.test_pct) ? ` (<b>${pct(r.test_pct, 0)}</b>)` : ''}` : '<span class="mute">no transcript: no split</span>'}${r.dup ? ` · cache: ${int(r.dup)} duplicate${r.dup === 1 ? '' : 's'} spared, ${sec(r.saved_ms)} saved` : ''} <span class="mute">${esc(fmtTime(r.started, now))}</span></div></li>`;
  return `<div class="tablecard" id="tests-runtime"><h3>Run time vs test time <span class="mute small">worker runs · ${rows.length ? `${int(rows.length)} run${rows.length === 1 ? '' : 's'}: ${fmtMin(test / 60000)} of ${fmtMin(wall / 60000)} in tests (${pct(wall > 0 ? 100 * test / wall : 0, 0)}), ${sec(sum('saved_ms'))} saved by the cache` : 'none in this window'}</span></h3>
    <div class="filters" style="padding:0 12px">${chips}</div>${pol}${rows.length ? `<ul class="tlist" id="tests-rt-rows">${rows.map(li).join('')}</ul>` : '<p class="small mute" style="padding:0 12px">no worker run in this window</p>'}</div>`;
}
const TESTS_PART = { suite: testsSuite, costs: testsCosts, impact: testsImpact, runtime: testsRuntime };
function tests(d, ctx) {
  // a project whose suite Norn cannot read: say which suite it is and what still fills, instead of a page of "not measured yet"
  const why = d.suite === false ? `<div class="banner" id="tests-scope">Norn reads node:test suites (tests/*.test.mjs) and pytest suites (tests/test_*.py); this project's tests/ holds neither, so only the charts under <b>Suite</b> and <b>Run time</b> fill: test cases and lines per day from git (refreshed once a day by the tick) and the runs' test time.</div>`
    : !d.times && !(d.history || []).length && !(d.git?.points || []).length ? `<div class="banner" id="tests-scope">Nothing measured yet. The tick fills the charts under <b>Suite</b> from git once a day; per-test runtimes come from <span class="mono">${esc(d.commands.measure)}</span> (a full suite run).</div>` : '';
  const views = TESTS_SUBS.map(([k, label]) => [k, label, k === 'suite' && d.times ? int(d.times.tests) : null]);
  return subviewPage('tests', { title: 'Tests', lead: why + testsAlerts(d), numbers: testsNumbers(d), views, active: d.sub, loading: d.parts_loading, body: d.parts_loading ? '' : testsWhen(d.sub === 'suite' ? d.times : null, ctx) + TESTS_PART[d.sub](d, ctx) });
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
