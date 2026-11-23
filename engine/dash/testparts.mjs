// TESTS-RUNTIME (owner ask 2026-11-19): the Tests tab's sub-views and its code viewer - pure, the same module in the browser
// (/testparts.mjs) and in node --test. The viewer highlights a test file with the vendored, pinned highlight.js (vendor/VENDOR.md),
// numbers every line and marks the test's own line; it only shows text the server let through its repo guard (lib/testtimes.repoFile).
import hljs from './vendor/highlight.min.js';
import { esc } from './docs.mjs';

/** the Tests tab's sub-views [id, label] (subviews.mjs: 3-4; the governance views are part of Costs and health, the charts over time of
 *  Suite; test-diet S1: Run time = a run's wall time vs its test time, the cache's savings, policy.tests) */
export const TESTS_SUBS = [['suite', 'Suite'], ['costs', 'Costs and health'], ['impact', 'Impact'], ['runtime', 'Run time']];
const MAX_HL = 400000;   // a file above this many characters is shown unhighlighted
const LANG = { mjs: 'javascript', cjs: 'javascript', js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', json: 'json',
  rs: 'rust', go: 'go', cs: 'csharp', java: 'java', rb: 'ruby', sh: 'bash', ps1: 'powershell', md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini', c: 'c', h: 'c', cpp: 'cpp' };
/** a file's highlight.js language (null = plain text) */
export const langOf = file => { const l = LANG[String(file ?? '').split('.').pop().toLowerCase()]; return l && hljs.getLanguage(l) ? l : null; };
/** highlighted HTML split into lines: a token spanning lines (a block comment, a docstring) is closed at each line end and reopened on
 *  the next, so every line is balanced HTML on its own -> [html of line 1, ...] */
export function hlLines(text, lang) {
  const src = String(text ?? '');
  if (!lang || src.length > MAX_HL) return src.split(/\r?\n/).map(esc);
  const html = hljs.highlight(src.replace(/\r\n/g, '\n'), { language: lang, ignoreIllegals: true }).value, open = [];
  return html.split('\n').map(l => {
    const head = open.join('');
    for (const m of l.matchAll(/<span[^>]*>|<\/span>/g)) { if (m[0] === '</span>') open.pop(); else open.push(m[0]); }
    return head + l + '</span>'.repeat(open.length);
  });
}
/** the viewer's body: every line numbered (#srcl-N), the test's line marked (.focus, data-focus) -> HTML */
export function codeView({ file, text, line = null }) {
  const lines = hlLines(text, langOf(file)), L = Number(line) || null;
  return `<div class="codeview" id="srcview-code"><table><tbody>${lines.map((h, i) => `<tr id="srcl-${i + 1}"${L === i + 1 ? ' class="focus" data-focus="1"' : ''}><td class="ln mute">${i + 1}</td><td class="lt"><code class="hljs">${h || ' '}</code></td></tr>`).join('')}</tbody></table></div>`;
}
/** the viewer's head: the file, the line, read-only */
export const codeHead = ({ file, lines, line = null }) => `<b class="small mono" style="overflow-wrap:anywhere">${esc(file)}</b><span class="small mute">${line ? `line ${esc(line)} · ` : ''}${esc(lines)} lines · read-only</span>`;
/**
 * SPEC dash-owner-1123 s.1.2: a file / case table that is a list of cards at 390 px (css/tests.css .ftable: each cell says its label).
 * rows: objects; cols: [{ key, label, num (right-aligned), html (row -> HTML; else the escaped row[key]) }]; o.sort = { key (the sorted
 * column), act (each header a button: data-act + data-sort) } | null; o.act = a row's action (data-act, data-id = row.id ?? row.file) -> HTML
 */
export function fileTable(rows, cols, { sort = null, act = '', id = '' } = {}) {
  const th = c => `<th${c.num ? ' class="num"' : ''}${sort?.key === c.key ? ' aria-sort="descending"' : ''}>${sort?.act ? `<button class="lnk" data-act="${esc(sort.act)}" data-sort="${esc(c.key)}">${esc(c.label)}</button>` : esc(c.label)}</th>`;
  const tr = r => `<tr${act ? ` data-act="${esc(act)}" data-id="${esc(r.id ?? r.file)}" tabindex="0"` : ''}>${cols.map(c => `<td data-label="${esc(c.label)}"${c.num ? ' class="num"' : ''}>${c.html ? c.html(r) : esc(r[c.key] ?? '')}</td>`).join('')}</tr>`;
  return `<table class="ftable"${id ? ` id="${esc(id)}"` : ''}><thead><tr>${cols.map(th).join('')}</tr></thead><tbody>${rows.map(tr).join('')}</tbody></table>`;
}
