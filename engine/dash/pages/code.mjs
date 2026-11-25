// The Code page (SPEC dash-owner-1123 s.7; unwired: the SHELL lane adds the tab, /api/code and /api/source): every tracked text file of
// the project from `norn code history` (lib/codeindex.mjs), a summary of at most 4 numbers and four sub-views, each its own part of /api/code:
//   Files    - testparts fileTable: lines, the 26-week growth sparkline + delta, churn 90 d, fan-in, importance, fixes 365 d, fix first (the code
//              signals, lib/codesignals.mjs); sorts and a folder filter. A row opens the file drawer (#code-file, &file=): its growth chart, the
//              files that change with it, its last fixes, its last commits and the code viewer (/api/source).
//   Growth   - lines per top-level area over 26 weeks (widgets timeChart) and the 10 fastest-growing files
//   Outliers - widgets outliers() over size, growth and churn (Tukey fences)
//   Map      - the Floorplan map (`norn code map`, lib/codemap.mjs) in an iframe sandboxed to scripts only on GET /code-map/ (its own CSP);
//              none drawn: the not-built text, no iframe. A skipped refresh (over the meter) says so above it.
// No index yet: the parts say what writes it, never a number. Click handlers are data-act names (SHELL wires them).
import { esc, fin, int, chip, filterChips } from '../cells.mjs';
import { timeChart, outliers } from '../widgets.mjs';
import { pickSub, subviewPage } from '../subviews.mjs';
import { fileTable, codeView, codeHead } from '../testparts.mjs';

export const CODE_SUBS = [['files', 'Files'], ['growth', 'Growth'], ['outliers', 'Outliers'], ['map', 'Map']];
export const CODE_CAP = 40;
const SORTS = [['importance', 'importance'], ['fix_first', 'fix first'], ['lines', 'lines'], ['growth', 'growth'], ['churn', 'churn'], ['fan_in', 'fan-in'], ['file', 'file']];
const notYet = what => `<p class="small mute" style="padding:0 12px"><span class="chip idle">not built yet</span> ${esc(what)} <span class="mute">(\`norn code history\` writes it; the tick starts it when the sha moves)</span></p>`;
const SPARK = '▁▂▃▄▅▆▇█';
const spark = xs => { const lo = Math.min(...xs), hi = Math.max(...xs); return xs.map(v => SPARK[hi > lo ? Math.min(7, Math.floor(8 * (v - lo) / (hi - lo))) : 0]).join(''); };
const signed = n => (n > 0 ? `+${int(n)}` : int(n));
const deltaText = r => (fin(r.pct) ? `${r.pct > 0 ? '+' : ''}${r.pct} %` : `${signed(r.delta)} lines`);
const fileBtn = f => `<span class="mono small">${esc(f)}</span>`;
const base = f => String(f).split('/').at(-1);
const NA = '<span class="mute">n/a</span>';

function codeNumbers(d) {
  const t = d.total;
  if (!t) return [];
  return [{ n: int(t.files), label: 'files' }, { n: int(t.lines), label: 'lines' }, { n: signed(t.added_30d), label: 'lines added in 30 days' }, { n: t.hotspot ? base(t.hotspot) : '-', label: 'top hotspot' }];
}

// ---- Files ----
const COLS = [{ key: 'file', label: 'file', html: r => fileBtn(r.file) }, { key: 'lines', label: 'lines', num: true, html: r => int(r.lines) },
  { key: 'growth', label: '26 w', num: true, html: r => `<span class="mono cspark" aria-hidden="true">${spark(r.growth)}</span> ${esc(deltaText(r))}` },
  { key: 'churn', label: 'churn 90 d', num: true, html: r => int(r.churn_90d) }, { key: 'fan_in', label: 'fan-in', num: true, html: r => (fin(r.fan_in) ? int(r.fan_in) : '<span class="mute">n/a</span>') },
  { key: 'importance', label: 'importance', num: true, html: r => int(r.importance) },
  { key: 'fixes', label: 'fixes 365 d', num: true, html: r => (fin(r.fixes_365d) ? int(r.fixes_365d) : NA) }, { key: 'fix_first', label: 'fix first', num: true, html: r => (fin(r.fix_first) ? int(r.fix_first) : NA) }];
const fixRank = x => (!x ? ' (not built yet: `norn code history`)' : x.status === 'measured' ? '' : ` (n/a: ${esc(x.reason)})`);
function codeFiles(d) {
  const l = d.list;
  if (!l) return `<div class="card" id="code-files">${notYet('the file index')}</div>`;
  const sorts = filterChips('sort', SORTS.map(([k, text]) => ({ act: 'code-sort', data: { sort: k }, on: l.sort === k, text })));
  const folder = `<select id="code-folder" data-act="code-folder" aria-label="folder"><option value=""${l.folder ? '' : ' selected'}>all</option>${l.folders.map(([f, n]) => `<option value="${esc(f)}"${l.folder === f ? ' selected' : ''}>${esc(f)} (${int(n)})</option>`).join('')}</select>`;
  const more = l.matched > l.shown ? ` · <button class="lnk" data-act="code-more" data-limit="${l.shown + CODE_CAP}">show more</button>` : '';
  return `<div class="tablecard" id="code-files"><h3>Every file <span class="mute small">${int(l.matched)}${l.folder ? ` in ${esc(l.folder)}/` : ''} · index at ${esc(d.index?.sha ?? '?')}, ${esc(String(d.index?.at ?? '').slice(0, 16))} · importance = the Borda rank of fan-in and churn; fix first = of churn, fan-in and fixes${fixRank(l.fixes)}</span></h3>
    <div class="tbar">${folder}${sorts}</div>
    ${l.rows.length ? fileTable(l.rows, COLS, { sort: { key: l.sort }, act: 'code-file', id: 'code-rows' }) : '<p class="small mute" style="padding:0 12px">no file in this folder</p>'}
    <p class="small mute" style="padding:0 12px" id="code-shown">showing ${int(l.shown)} of ${int(l.matched)}${more}</p></div>`;
}

// ---- the file drawer ----
function codeFile(d) {
  if (!d.file_id) return '';
  const f = d.file, s = d.source, x = '<button class="ghost cclose" data-act="code-file-close" aria-label="Close" title="Close (Esc)">&times;</button>';
  const shell = (head, body) => `<aside id="code-file" class="drawer cfile" aria-label="File detail"><div class="dh"><div class="cfhead">${head}</div><span class="spacer"></span>${x}</div>${body}</aside>`;
  if (!f) return shell(`<b class="small mono">${esc(d.file_id)}</b>`, '<p class="small mute">not in the index (new, removed, or the index is older than it)</p>');
  const facts = `<div class="small">${esc(f.lang)} · born ${esc(f.born ?? '-')} · ${int(f.commits_90d)} commits and ${int(f.churn_90d)} lines churned in 90 days${fin(f.rel_churn) ? ` (${f.rel_churn} per line)` : ''} · fan-in ${fin(f.fan_in) ? int(f.fan_in) : 'n/a'} · importance ${int(f.importance)} · fix first ${fin(f.fix_first) ? int(f.fix_first) : 'n/a'}</div>`;
  const chart = timeChart([{ key: 'lines', label: 'lines', points: f.growth.map((y, i) => ({ x: f.days[i], y })) }], { days: f.days, fmt: int, unit: 'lines', id: 'code-file-growth', title: 'lines per week' });
  const together = !f.signals ? '<p class="small mute" id="code-file-partners">not built yet (`norn code history` writes the signals)</p>'
    : f.partners.length ? `<ul class="tlist" id="code-file-partners">${f.partners.map(p => `<li><span class="mono small">${esc(p.file)}</span> <span class="small mute">${int(p.shared)} shared landings · ${Math.round(100 * p.share)} % of this file's · it has ${int(p.landings)}</span></li>`).join('')}</ul>`
    : '<p class="small mute" id="code-file-partners">no file over the thresholds</p>';
  const fixes = !f.signals ? '<p class="small mute" id="code-file-fixes">not built yet</p>' : f.fixes_na ? `<p class="small mute" id="code-file-fixes">n/a: ${esc(f.fixes_na)}</p>`
    : f.fixes.last.length ? `<p class="small">${int(f.fixes.n_90d)} in 90 days, ${int(f.fixes.n_365d)} in 365 days</p><ul class="tlist" id="code-file-fixes">${f.fixes.last.map(c => `<li><span class="mono small">${esc(c.sha.slice(0, 8))}</span> <span class="small mute">${esc(c.day)}</span> ${esc(c.subject)}</li>`).join('')}</ul>`
    : '<p class="small mute" id="code-file-fixes">no fix landing in 365 days</p>';
  const commits = (f.last || []).length ? `<ul class="tlist" id="code-file-commits">${f.last.map(c => `<li><span class="mono small">${esc(c.sha.slice(0, 8))}</span> <span class="small mute">${esc(c.day)}</span> ${esc(c.subject)} <span class="mono small">+${int(c.added)} -${int(c.deleted)}</span></li>`).join('')}</ul>`
    : '<p class="small mute" id="code-file-commits">no commit in the first-parent history</p>';
  const src = !s ? '<p class="small mute">loading ...</p>' : s.error ? `<p class="small">${chip('bad', 'cannot show')} ${esc(s.error)}</p>` : codeView({ file: f.file, text: s.text });
  return shell(codeHead({ file: f.file, lines: int(f.lines) }), `${facts}${chart}<h4>Changes together with</h4>${together}<h4>Last fixes</h4>${fixes}<h4>Last commits</h4>${commits}<h4>Source</h4>${src}`);
}

// ---- Growth ----
const FAST_COLS = [{ key: 'file', label: 'file', html: r => fileBtn(r.file) }, { key: 'delta', label: '26 w', num: true, html: r => `${esc(signed(r.delta))} <span class="mute">${esc(deltaText(r))}</span>` },
  { key: 'lines', label: 'lines', num: true, html: r => int(r.lines) }];
function codeGrowth(d) {
  if (!d.index) return `<div class="card" id="code-growth">${notYet('the growth over time')}</div>`;
  const fast = d.fastest || [];
  return `<div class="card" id="code-growth">${timeChart(d.areas || [], { days: d.days || [], fmt: int, unit: 'lines', id: 'code-growth', title: 'lines per top-level area, per week' })}</div>
    <div class="tablecard" id="code-fastest"><h3>Fastest growing <span class="mute small">the most lines added over 26 weeks</span></h3>${fast.length ? fileTable(fast, FAST_COLS, { act: 'code-file', id: 'code-fast-rows' }) : '<p class="small mute" style="padding:0 12px">no file grew</p>'}</div>`;
}

// ---- Outliers ----
const OUT = [['size', 'Biggest', 'lines now'], ['growth', 'Fastest growing', 'lines added over 26 weeks'], ['churn', 'Most churned', 'lines added + deleted in 90 days']];
function codeOutliers(d) {
  if (!d.index) return `<div class="card" id="code-outliers">${notYet('the outliers')}</div>`;
  return OUT.map(([k, title, what]) => `<div class="tablecard" id="code-out-${k}"><h3>${esc(title)} <span class="mute small">${esc(what)} · past the fence = an outlier (Q3 + 1.5 IQR)</span></h3>
    ${outliers(d[k] || [], { fmt: int, unit: 'lines', top: 10, id: `code-outliers-${k}`, act: 'code-file' }) || '<p class="small mute" style="padding:0 12px">no file</p>'}</div>`).join('');
}

// ---- Map: the drawn Floorplan file on its own route (own CSP), framed with scripts only: an opaque origin, no dashboard cookie or API ----
function codeMap(d) {
  const m = d.map;
  if (!m) return '<div class="card" id="code-map"><p class="small mute" style="padding:0 12px"><span class="chip idle">not built yet</span> the architecture map <span class="mute">(`norn code map` draws it with the pinned Floorplan; the tick refreshes it after a merge)</span></p></div>';
  const skip = m.skipped ? ` · ${chip('warn', `refresh skipped at ${m.skipped.sha}`)} ${esc(m.skipped.why)}; <span class="mono">norn code map</span> draws it` : '';
  return `<div class="card" id="code-map"><p class="small mute" style="padding:0 12px">map at <span class="mono">${esc(m.sha)}</span>, ${esc(String(m.at).slice(0, 16))} · Floorplan ${esc(m.tool)} · Ask is off (no map server)${skip}</p>
    <iframe id="code-map-frame" class="cmap" sandbox="allow-scripts" src="/code-map/?project=${esc(encodeURIComponent(d.project))}" title="Architecture map (Floorplan)" loading="lazy" referrerpolicy="no-referrer"></iframe></div>`;
}

const CODE_PART = { files: codeFiles, growth: codeGrowth, outliers: codeOutliers, map: codeMap };
/** the Code page: d = codeLoad's answer (the summary + the open view's part + the open file) */
export function code(d) {
  const lead = d.index ? '' : '<div class="banner" id="code-scope">No code index yet. <span class="mono">norn code history</span> builds it from git; the tick starts it when the sha moves.</div>';
  return subviewPage('code', { title: 'Code', lead, numbers: codeNumbers(d), views: CODE_SUBS, active: d.sub, loading: d.parts_loading, body: d.parts_loading ? '' : CODE_PART[d.sub](d) + codeFile(d) });
}
/** the page's data: the summary, the open view's part (Files: its cap, sort and folder) and the open file (ctx.file, the URL's &file=):
 *  its part and its text (/api/source; a refusal becomes source.error) */
export async function codeLoad(project, get, ctx = {}) {
  const q = `project=${encodeURIComponent(project)}`, sub = pickSub(CODE_SUBS, ctx.sub), limit = ctx.limit || CODE_CAP, f = ctx.file ? encodeURIComponent(ctx.file) : null;
  const list = sub === 'files' ? `&limit=${limit}&sort=${encodeURIComponent(ctx.sort || 'importance')}${ctx.folder ? `&folder=${encodeURIComponent(ctx.folder)}` : ''}` : '';
  const [d, part, one, source] = await Promise.all([get(`/api/code?${q}`), get(`/api/code?${q}&part=${sub}${list}`), f ? get(`/api/code?${q}&part=file&file=${f}`) : null,
    f ? Promise.resolve(get(`/api/source?${q}&file=${f}`)).catch(e => ({ error: String(e?.message ?? e) })) : null]);
  return { ...d, ...part, sub, limit, ...(f ? { file_id: ctx.file, file: one?.file ?? null, source } : {}) };
}
