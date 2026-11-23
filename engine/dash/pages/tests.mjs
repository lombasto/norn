// The Tests page (SPEC dash-owner-1123 s.1; its renderers copied from ui.mjs, which the SHELL lane then drops and wires this module in):
// a summary of numbers, the open alerts the test machinery raised (linked to their Inbox question), four sub-views (testparts.mjs
// TESTS_SUBS), each its own part of /api/tests, and the test detail drawer (#tests-case, URL &case=<id>):
//   Suite            - every test case (`norn tests index` cases.json) with its lines, last and median time here (the machine's case log),
//                      sorted and filtered, capped with show more; the over-time charts from git folded at its head
//   Costs and health - gate time per merge and the last merge check (copy-paste in the changed test files)
//   Impact           - which test files cover a source file or a lane's changed files (`norn tests for`), each test file by what it reaches
//                      and is the sole guard of (per test FILE: imports are file-level), and the sources no test reaches
//   Run time         - per worker run its wall time vs test time and the cache's savings, then the slowest test cases and the outliers
//                      (past Tukey's fence; slow sometimes = max over 3x the median)
// A part whose source does not exist yet says so and what writes it - never a number. Click handlers are data-act names (SHELL wires them).
import { esc, fin, int, fmtMin, pct, chip, fmtTime, goAttrs, filterChips } from '../cells.mjs';
import { timeChart, outliers } from '../widgets.mjs';
import { pickSub, subviewPage } from '../subviews.mjs';
import { TESTS_SUBS, fileTable } from '../testparts.mjs';

export const TESTS_CAP = 40, TESTS_SORTS = [['slowest', 'slowest'], ['longest', 'longest'], ['file', 'file'], ['newest', 'newest']];
const sec = ms => (fin(ms) ? (ms >= 10000 ? `${Math.round(ms / 1000)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`) : '-');
const notYet = (what, src) => `<p class="small mute tnotyet" style="padding:0 12px"><span class="chip idle">not measured yet</span> ${what}${src ? ` <span class="mute">(${src})</span>` : ''}</p>`;
const nodeOnly = d => (d.suite === 'pytest' ? `<p class="small mute tscope" style="padding:0 12px">${chip('idle', 'node:test only')} reads node:test suites only: this project's suite is pytest, so nothing fills here.</p>` : '');
// a test's file opens the code viewer
const srcBtn = (file, line, label) => `<button class="lnk mono small" data-act="test-src" data-file="${esc(file)}" data-line="${esc(line ?? '')}" title="open ${esc(file)}${line ? ` at line ${esc(line)}` : ''} (read-only)">${esc(label ?? `${file}${line ? `:${line}` : ''}`)}</button>`;
const ratio = g => `${(g.test_lines / (g.code_lines || 1)).toFixed(2)}:1`;
const runLink = id => `<button class="lnk mono" ${goAttrs({ tab: 'runs', jump: `node-${id}` })} title="open it on the Runs page">${esc(id)}</button>`;
function testsNumbers(d) {
  const gl = (d.git?.points || []).at(-1), al = (d.alerts || []).length, adv = d.advisories, l = d.list;
  return [{ n: l ? int(l.total) : gl ? int(gl.tests) : '-', label: l ? 'tests' : 'test cases (git)' }, { n: l ? int(l.files) : gl ? int(gl.test_files) : '-', label: 'test files' }, { n: gl ? ratio(gl) : '-', label: 'test lines per code line' },
    al ? { n: int(al), label: 'alerts: they need you', cls: 'warn' } : { n: adv ? int(adv.list.length) : '-', label: 'last merge check findings' }];
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

// ---- Suite: the over-time charts (folded), then every test case ----
function testsTime(d) {
  const g = d.git?.points || [], gl = g.at(-1), days = g.map(x => x.day);
  const body = g.length ? `<div class="tgrid">${timeChart([{ key: 'tests', label: 'test cases', points: g.map(x => ({ x: x.day, y: x.tests })) }], { days, fmt: int, unit: 'tests', id: 'tests-count', title: 'test cases per day' })}
    ${timeChart([{ key: 'test', label: 'test lines', points: g.map(x => ({ x: x.day, y: x.test_lines })) }, { key: 'code', label: 'code lines', points: g.map(x => ({ x: x.day, y: x.code_lines })) }], { days, fmt: int, unit: 'lines', id: 'tests-lines', title: 'test lines and code lines per day' })}</div>`
    : '<p class="small mute">no history yet</p>';
  return `<details class="tablecard tfold" id="tests-time"><summary><b>Over time</b> <span class="mute small">test cases and lines per day (git, first parent)${gl ? ` · ${int(gl.tests)} cases, ${ratio(gl)} now` : ''}</span></summary>${body}</details>`;
}
const caseName = r => `<b class="tname">${esc(r.name)}</b>${r.desc && !r.name.endsWith(r.desc) ? `<div class="small mute">${esc(r.desc)}</div>` : ''}`;
const LIST_COLS = [{ key: 'name', label: 'test', html: caseName }, { key: 'file', label: 'file', html: r => `<span class="mono small">${esc(r.file)}:${esc(r.line)}</span>` },
  { key: 'lines', label: 'lines', num: true }, { key: 'last', label: 'last', num: true, html: r => esc(sec(r.last)) }, { key: 'median', label: 'median', num: true, html: r => esc(sec(r.median)) },
  { key: 'runs', label: 'runs', num: true, html: r => (r.runs ? int(r.runs) : '0 <span class="mute small">not run here yet</span>') }];
function testsList(d) {
  const l = d.list;
  if (!l) return `<div class="card" id="tests-list">${d.suite === 'node:test' || !d.suite ? notYet('the test list', '`norn tests index` writes cases.json; the tick starts it') : nodeOnly(d)}</div>`;
  const sorts = filterChips('sort', TESTS_SORTS.map(([k, text]) => ({ act: 'tests-sort', data: { sort: k }, on: l.sort === k, text })));
  const more = l.matched > l.shown ? ` · <button class="lnk" data-act="tests-more" data-limit="${l.shown + TESTS_CAP}">show more</button>` : '';
  return `<div class="tablecard" id="tests-list"><h3>Every test <span class="mute small">${int(l.total)} in ${int(l.files)} files · index at ${esc(l.sha ?? '?')}, ${esc(String(l.at).slice(0, 16))} · times from this machine's runs</span></h3>
    <div class="tbar"><input type="search" id="tests-q" aria-label="filter by name or file" placeholder="filter: name / file" value="${esc(l.q)}" data-act="tests-filter">${sorts}</div>
    ${l.rows.length ? fileTable(l.rows, LIST_COLS, { act: 'tests-case', id: 'tests-rows' }) : '<p class="small mute" style="padding:0 12px">no test matches</p>'}
    <p class="small mute" style="padding:0 12px" id="tests-shown">showing ${int(l.shown)} of ${int(l.matched)}${more}</p></div>`;
}
const testsSuite = d => testsTime(d) + testsList(d);

// ---- the test detail drawer ----
const SPARK = '▁▂▃▄▅▆▇█';
const spark = ms => { const xs = ms.filter(fin), m = Math.max(...xs, 0); return xs.map(v => SPARK[m > 0 ? Math.min(7, Math.floor(8 * v / m)) : 0]).join(''); };
function testsCase(d) {
  if (!d.case_id) return '';
  const c = d.case, x = `<button class="ghost tclose" data-act="tests-case-close" aria-label="Close" title="Close (Esc)">&times;</button>`;
  if (!c) return `<aside id="tests-case" class="drawer tcase" aria-label="Test detail"><div class="dh"><b class="mono">${esc(d.case_id)}</b><span class="spacer"></span>${x}</div><p class="small mute">no such test in the index (renamed, or the index is older than it)</p></aside>`;
  const runs = c.runs || [], soleSet = new Set(c.sole || []), others = (c.reaches || []).filter(s => !soleSet.has(s));
  const runsBody = runs.length ? `<div class="small"><span class="mono tspark" aria-hidden="true">${spark([...runs].reverse().map(r => r.ms))}</span> median <b>${esc(sec(c.median))}</b> · max ${esc(sec(c.max))} · ${int(c.fails)} fail${c.fails === 1 ? '' : 's'}</div>
    <ul class="tlist" id="tests-case-runs">${runs.map(r => `<li><span class="small mute">${esc(String(r.at).slice(0, 16).replace('T', ' '))}</span> ${r.run ? runLink(r.run) : '<span class="mute">a hand run</span>'} <b class="mono">${esc(sec(r.ms))}</b> ${chip(r.ok ? 'ok' : 'bad', r.ok ? 'pass' : 'fail')}</li>`).join('')}</ul>`
    : '<p class="small mute">not run here yet</p>';
  const prot = `<div class="small">reaches <b>${int((c.reaches || []).length)}</b> source files · sole test of <b>${int(soleSet.size)}</b> <span class="mute">(its file's impact)</span></div>
    <p class="small tsrcs">${[...soleSet].map(s => `${srcBtn(s, null, s)} <span class="chip warn">sole</span>`).concat(others.slice(0, 20).map(s => srcBtn(s, null, s))).join(' ')}${others.length > 20 ? ` <span class="mute">+${int(others.length - 20)} more</span>` : ''}</p>`;
  const al = (c.alerts || []).length ? (c.alerts || []).map(a => `<div>${chip('needs', a.id)} <button class="lnk" data-tab="inbox">${esc(a.title)}</button></div>`).join('') : '<span class="mute">none</span>';
  return `<aside id="tests-case" class="drawer tcase" aria-label="Test detail"><div class="dh"><b class="tname">${esc(c.name)}</b><span class="spacer"></span>${x}</div>
    <div class="small mono">${esc(c.file)}:${esc(c.line)}-${esc(c.line + c.lines - 1)} · ${int(c.lines)} line${c.lines === 1 ? '' : 's'} · node:test</div>
    <p class="small">checks: ${esc(c.desc)}</p>
    <h4>Runs here <span class="mute small">(last 20)</span></h4>${runsBody}
    <h4>Protects</h4>${prot}
    <h4>Alerts on it</h4><div class="small" id="tests-case-alerts">${al}</div>
    <p><button data-act="test-src" data-file="${esc(c.file)}" data-line="${esc(c.line)}" title="open ${esc(c.file)} at line ${esc(c.line)} (read-only)">Source</button></p></aside>`;
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
  const adv = d.advisories, head = `<h3>Last merge check <span class="mute small">${adv ? `${esc(adv.head)} vs ${esc(adv.base)} · ${int(adv.files.length)} changed test file(s) · ` : ''}copy-paste, advisory, never a merge block</span></h3>`;
  if (d.suite === 'pytest') return `<div class="tablecard" id="tests-adv">${head}${nodeOnly(d)}</div>`;
  if (!adv) return `<div class="tablecard" id="tests-adv">${head}<p class="small mute" style="padding:0 12px">no merge check yet</p></div>`;
  return `<div class="tablecard" id="tests-adv">${head}${adv.list.length ? `<ul class="tlist">${adv.list.map(a => `<li>${chip(a.severity === 'medium' ? 'warn' : 'idle', a.key)}${a.new ? ` ${chip('open', 'new')}` : ''} <b>${esc(a.path ?? a.surface)}</b> ${esc(a.why)}<div class="small mute">${esc(a.fix.action)} · ${esc(a.id)}</div></li>`).join('')}</ul>` : '<p class="mute" style="padding:0 12px">no finding</p>'}</div>`;
}
const testsCosts = (d, ctx) => testsMerges(d, ctx) + testsAdv(d);

// ---- Impact ----
const forCmd = d => d.commands?.for ?? 'norn tests for';
function testsPick(d) {
  const im = d.impact, p = d.picked;
  const form = `<div class="card" id="tests-impact-pick"><div class="small"><b>Which tests cover a file?</b> <span class="mute">the answer of <span class="mono">${esc(forCmd(d))} &lt;files&gt;</span>, from impact.json${im ? ` (${esc(String(im.at).slice(0, 16))}, ${esc(im.sha ?? '?')})` : ''}</span></div>
    <div class="tpick"><input type="search" id="tests-impact-files" list="tests-srcs" placeholder="source files, comma-separated" value="${esc(p && !p.lane ? p.files.join(', ') : '')}"><button data-act="tests-impact">Which tests?</button></div>
    <datalist id="tests-srcs">${(im?.sources || []).map(s => `<option value="${esc(s)}">`).join('')}</datalist>
    ${d.lanes?.length ? `<div class="tpick"><select id="tests-impact-lane" aria-label="a lane">${d.lanes.map(l => `<option${p?.lane === l ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><button data-act="tests-impact-lane">A lane's changed files</button></div>` : ''}</div>`;
  if (!im) return form + `<div class="card" id="tests-impact-out">${notYet('test impact', 'no impact.json in the project state: `norn tests index` writes it')}</div>`;
  if (!p) return form + `<p class="small mute" id="tests-impact-out">${int(im.sources.length)} source files are covered by the suite: pick one, or a lane.</p>`;
  if (p.error) return form + `<div class="card" id="tests-impact-out">${chip('bad', 'refused')} ${esc(p.error)}</div>`;
  return form + `<div class="tablecard" id="tests-impact-out"><h3>${p.lane ? `Lane ${esc(p.lane)}: ${int(p.files.length)} changed file(s)` : `${int(p.files.length)} file(s)`} → <b>${int(p.tests.length)} test file(s)</b></h3>
    ${p.tests.length ? `<p class="small" style="padding:0 12px">${p.tests.map(t => srcBtn(t, null, t)).join(' ')}</p>` : ''}
    <ul class="tlist">${p.rows.map(r => `<li><span class="mono">${esc(r.file)}</span> <span class="small mute">${r.tests.length ? `${int(r.tests.length)} test file(s)` : r.known ? 'covered by no test' : 'not in the impact map (a test file, or not run by any test)'}</span></li>`).join('')}</ul>
    <p class="small mute" style="padding:0 12px">The same answer in a terminal: <span class="mono" style="overflow-wrap:anywhere">${esc(forCmd(d))} ${esc(p.files.join(' '))}</span></p></div>`;
}
const IMPACT_COLS = [{ key: 'file', label: 'test file', html: r => srcBtn(r.file, null, r.file) }, { key: 'reaches', label: 'reaches', num: true },
  { key: 'sole', label: 'sole guard of', num: true, html: r => (r.sole.length ? `<details class="tsole"><summary>${int(r.sole.length)}</summary>${r.sole.map(s => `<div>${srcBtn(s, null, s)}</div>`).join('')}</details>` : '0') },
  { key: 'areas', label: 'areas', html: r => esc(r.areas.map(([a, n]) => `${a} (${n})`).join(', ')) }];
function testsGuards(d) {
  if (!d.impact) return '';
  const xs = d.files || [], un = d.uncovered || [];
  return `<div class="tablecard" id="tests-guards"><h3>Test files by what they protect <span class="mute small">impact map at ${esc(d.impact.sha ?? '?')}, ${esc(String(d.impact.at).slice(11, 16))} · per test file: imports are file-level · sole guard = no other test file reaches it</span></h3>
    ${xs.length ? fileTable(xs, IMPACT_COLS, { id: 'tests-guard-rows' }) : '<p class="small mute" style="padding:0 12px">no test file reaches a source file</p>'}
    <details class="tuncov" id="tests-uncovered"${un.length ? '' : ' hidden'}><summary>Not covered by any test: <b>${int(un.length)}</b> source file${un.length === 1 ? '' : 's'}</summary><p class="small">${un.map(s => srcBtn(s, null, s)).join(' ')}</p></details>
    ${un.length ? '' : '<p class="small mute" style="padding:0 12px">every source file is reached by a test</p>'}</div>`;
}
const testsImpact = d => testsPick(d) + testsGuards(d);

// ---- Run time (test-diet S1) + per test ----
const RT_WIN = [['24h', '24 h', 86400e3], ['3d', '3 days', 3 * 86400e3]];
function testsRuns(d, ctx) {
  const f = { window: '24h', over: false, saved: false, ...(ctx.testsRt || {}) }, now = ctx.now ?? Date.now(), win = RT_WIN.find(w => w[0] === f.window) ?? RT_WIN[0];
  const all = (d.rows || []).filter(r => r.state === 'running' || now - Date.parse(r.ended ?? r.started) <= win[2]), rows = all.filter(r => (!f.over || r.over) && (!f.saved || r.dup > 0));
  const sum = k => rows.reduce((n, r) => n + (r[k] || 0), 0), wall = sum('wall_ms'), test = sum('test_ms');
  const chips = filterChips('window', RT_WIN.map(([k, text]) => ({ act: 'tests-rt', data: { rt: 'window', v: k }, on: f.window === k, text })))
    + filterChips('show only', [{ act: 'tests-rt', data: { rt: 'over' }, on: f.over, text: 'over budget', n: all.filter(r => r.over).length, title: 'runs whose test time went past policy.tests.run_budget_min' },
      { act: 'tests-rt', data: { rt: 'saved' }, on: f.saved, text: 'saved', n: all.filter(r => r.dup > 0).length, title: 'runs the test cache spared a duplicate test run' }]);
  const pol = `<p class="small" id="tests-policy" style="padding:0 12px">In force: <b>${esc(d.words ?? '-')}</b> · ${(d.settings || []).map(k => `<button class="lnk" data-act="open-setting" data-setting="${esc(k)}" title="open ${esc(k)} in Settings">${esc(k.split('.').pop())}</button>`).join(' · ')}</p>`;
  const li = r => `<li data-run="${esc(r.id)}">${runLink(r.id)} <span class="mute">${esc(r.lane ?? '')}</span>${r.state === 'running' ? ` ${chip('running', 'running')}` : ''}${r.over ? ` ${chip('bad', 'over budget')}` : ''}
    <div class="small">${fin(r.wall_ms) ? `<b>${fmtMin(r.test_ms / 60000)}</b> of ${fmtMin(r.wall_ms / 60000)} in tests${fin(r.test_pct) ? ` (<b>${pct(r.test_pct, 0)}</b>)` : ''}` : '<span class="mute">no transcript: no split</span>'}${r.dup ? ` · cache: ${int(r.dup)} duplicate${r.dup === 1 ? '' : 's'} spared, ${sec(r.saved_ms)} saved` : ''} <span class="mute">${esc(fmtTime(r.started, now))}</span></div></li>`;
  return `<div class="tablecard" id="tests-runtime"><h3>Run time vs test time <span class="mute small">worker runs · ${rows.length ? `${int(rows.length)} run${rows.length === 1 ? '' : 's'}: ${fmtMin(test / 60000)} of ${fmtMin(wall / 60000)} in tests (${pct(wall > 0 ? 100 * test / wall : 0, 0)}), ${sec(sum('saved_ms'))} saved by the cache` : 'none in this window'}</span></h3>
    <div class="filters" style="padding:0 12px">${chips}</div>${pol}${rows.length ? `<ul class="tlist" id="tests-rt-rows">${rows.map(li).join('')}</ul>` : '<p class="small mute" style="padding:0 12px">no worker run in this window</p>'}</div>`;
}
function testsSlowest(d) {
  const ms = d.medians || [], head = `<h3>Slowest tests <span class="mute small">median, last ${int(d.case_days ?? 7)} days, this machine's runs · past the fence = an outlier (Q3 + 1.5 IQR)</span></h3>`;
  return `<div class="tablecard" id="tests-slowest">${head}${ms.length ? outliers(ms.map(c => ({ id: c.id, label: c.label ?? c.id, value: c.value, max: c.max })), { fmt: sec, unit: 'ms', top: 15, id: 'tests-outliers', act: 'tests-case' })
    : '<p class="small mute" style="padding:0 12px">no test case timed here yet: `norn tests run` records each case it runs</p>'}</div>`;
}
const testsRuntime = (d, ctx) => testsRuns(d, ctx) + testsSlowest(d);

const TESTS_PART = { suite: testsSuite, costs: testsCosts, impact: testsImpact, runtime: testsRuntime };
/** the Tests page: d = testsLoad's answer (the summary + the open view's part + the open case), ctx: { now, testsRt } */
export function tests(d, ctx = {}) {
  // a project whose suite Norn cannot read: say which suite it is and what still fills, instead of a page of "not measured yet"
  const why = d.suite === false ? `<div class="banner" id="tests-scope">Norn reads node:test suites (tests/*.test.mjs) and pytest suites (tests/test_*.py); this project's tests/ holds neither, so only the charts under <b>Suite</b> and <b>Run time</b> fill: test cases and lines per day from git (refreshed once a day by the tick) and the runs' test time.</div>`
    : !(d.git?.points || []).length && !d.list ? '<div class="banner" id="tests-scope">Nothing yet. The tick fills the charts under <b>Suite</b> from git once a day and indexes the test cases.</div>' : '';
  return subviewPage('tests', { title: 'Tests', lead: why + testsAlerts(d), numbers: testsNumbers(d), views: TESTS_SUBS, active: d.sub, loading: d.parts_loading, body: d.parts_loading ? '' : TESTS_PART[d.sub](d, ctx) + testsCase(d) });
}
/** the page's data: the summary, the open view's part (Suite: its cap, sort and filter; Impact: a pick in ctx.batch, `lane:<name>` or
 *  `files:a,b`) and the open case (ctx.case, the URL's &case=) */
export async function testsLoad(project, get, ctx = {}) {
  const q = `project=${encodeURIComponent(project)}`, sub = pickSub(TESTS_SUBS, ctx.sub), limit = ctx.limit || TESTS_CAP, b = ctx.batch ?? '';
  const pick = sub === 'impact' && b ? (b.startsWith('lane:') ? `&lane=${encodeURIComponent(b.slice(5))}` : `&files=${encodeURIComponent(b.slice(6))}`) : '';
  const list = sub === 'suite' ? `&limit=${limit}&sort=${encodeURIComponent(ctx.sort || 'slowest')}${ctx.q ? `&q=${encodeURIComponent(ctx.q)}` : ''}` : '';
  const [d, part, c] = await Promise.all([get(`/api/tests?${q}`), get(`/api/tests?${q}&part=${sub}${list}${pick}`), ctx.case ? get(`/api/tests?${q}&part=case&case=${encodeURIComponent(ctx.case)}`) : null]);
  return { ...d, ...part, sub, limit, ...(ctx.case ? { case_id: ctx.case, case: c?.case ?? null } : {}) };
}
