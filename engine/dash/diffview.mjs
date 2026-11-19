// RM-35: THE diff viewer of the dashboard - one renderer for every before / after text and every patch: the "changed outside Norn"
// notice (last written by Norn vs now), SloppaChoppa's fixer hunks, the audit and enforce drafts; later brief / settings / PR views.
// Pure (node + browser): diffLines (line ops, numbered both sides), diffWords (the changed words inside a changed line pair),
// collapse (unchanged runs folded to n lines of context), parsePatch (a unified-diff hunk -> the same ops), renderDiff (unified or
// side-by-side HTML; tokens only, styled in index.html / norn.css) and diffBlock (the compact inline form on a card, whose Open
// button shows the same diff in the picture-in-picture panel - index.html #dvpip, see dvPanel there).
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const DIFF_CAP = 4e6;   // cells of the LCS table; a larger middle is shown as all removed + all added (honest, never slow)
const splitLines = t => { const s = String(t ?? ''); if (!s) return []; const l = s.split('\n'); if (l.at(-1) === '') l.pop(); return l.map(x => x.replace(/\r$/, '')); };

// the longest common subsequence of a and b (arrays, compared with ===) as index pairs; the common head and tail are matched first
function lcs(a, b) {
  let h = 0, t = 0;
  while (h < a.length && h < b.length && a[h] === b[h]) h++;
  while (t < a.length - h && t < b.length - h && a[a.length - 1 - t] === b[b.length - 1 - t]) t++;
  const A = a.slice(h, a.length - t), B = b.slice(h, b.length - t), pairs = [];
  for (let i = 0; i < h; i++) pairs.push([i, i]);
  if (A.length && B.length && A.length * B.length <= DIFF_CAP) {
    const n = A.length, m = B.length, W = m + 1, L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    for (let i = 0, j = 0; i < n && j < m;) { if (A[i] === B[j]) { pairs.push([h + i, h + j]); i++; j++; } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++; else j++; }
  }
  for (let i = 0; i < t; i++) pairs.push([a.length - t + i, b.length - t + i]);
  return pairs;
}

/** before / after text -> ops [{ t: 'eq' | 'del' | 'add', a (line no. before, 1-based), b (after), text }]; in a change, dels come first */
export function diffLines(before, after) {
  const a = splitLines(before), b = splitLines(after), ops = [];
  let i = 0, j = 0;
  for (const [x, y] of [...lcs(a, b), [a.length, b.length]]) {
    while (i < x) { ops.push({ t: 'del', a: i + 1, b: null, text: a[i] }); i++; }
    while (j < y) { ops.push({ t: 'add', a: null, b: j + 1, text: b[j] }); j++; }
    if (x < a.length) { ops.push({ t: 'eq', a: x + 1, b: y + 1, text: a[x] }); i++; j++; }
  }
  return ops;
}

/** one changed line pair -> [{ t: 'eq' | 'del' | 'add', s }] word by word (spaces and punctuation are their own tokens) */
export function diffWords(before, after) {
  const tok = s => String(s ?? '').match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
  const a = tok(before), b = tok(after), out = [], push = (t, s) => { const l = out.at(-1); if (l?.t === t) l.s += s; else out.push({ t, s }); };
  let i = 0, j = 0;
  for (const [x, y] of [...lcs(a, b), [a.length, b.length]]) {
    while (i < x) push('del', a[i++]);
    while (j < y) push('add', b[j++]);
    if (x < a.length) { push('eq', a[x]); i++; j++; }
  }
  return out;
}

/** fold every unchanged run longer than 2 x ctx (+1) into { t: 'skip', n, a, b } - ctx lines kept on each side of a change; a run at the
 * start or end keeps ctx lines only on its changed side */
export function collapse(ops, ctx = 3) {
  const out = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i].t !== 'eq') { out.push(ops[i++]); continue; }
    let k = i; while (k < ops.length && ops[k].t === 'eq') k++;
    const run = ops.slice(i, k), head = i === 0 ? 0 : ctx, tail = k === ops.length ? 0 : ctx;
    if (run.length > head + tail + 1) out.push(...run.slice(0, head), { t: 'skip', n: run.length - head - tail, a: run[head].a, b: run[head].b }, ...run.slice(run.length - tail));
    else out.push(...run);
    i = k;
  }
  return out;
}

/** a unified-diff patch (---/+++ heads, @@ hunks, +/-/space lines) -> { files: [names], ops } with line numbers from the @@ heads;
 * a text with no @@ head is read the same way, numbered from 1 (the audit and enforce drafts) */
export function parsePatch(patch) {
  const ops = [], files = [];
  let a = 1, b = 1;
  for (const l of String(patch ?? '').replace(/\n$/, '').split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if (h) { if (ops.length) ops.push({ t: 'skip', n: null, a: +h[1], b: +h[2], text: h[3].trim() }); a = +h[1]; b = +h[2]; continue; }
    if (/^(---|\+\+\+) /.test(l)) { const f = l.slice(4).replace(/^[ab]\//, ''); if (l[0] === '+' && f !== '/dev/null') files.push(f); continue; }
    if (/^\\ No newline/.test(l)) continue;
    if (l[0] === '+') ops.push({ t: 'add', a: null, b: b++, text: l.slice(1) });
    else if (l[0] === '-') ops.push({ t: 'del', a: a++, b: null, text: l.slice(1) });
    else ops.push({ t: 'eq', a: a++, b: b++, text: l[0] === ' ' ? l.slice(1) : l });
  }
  return { files, ops };
}

export const diffStats = ops => ({ add: ops.filter(o => o.t === 'add').length, del: ops.filter(o => o.t === 'del').length });
// the changes of ops as blocks: each run of dels + adds, its lines paired for the word highlight (the i-th del with the i-th add)
const blocks = ops => {
  const out = [];
  for (let i = 0; i < ops.length;) {
    if (ops[i].t === 'eq' || ops[i].t === 'skip') { out.push(ops[i++]); continue; }
    const dels = [], adds = [];
    while (i < ops.length && ops[i].t === 'del') dels.push(ops[i++]);
    while (i < ops.length && ops[i].t === 'add') adds.push(ops[i++]);
    out.push({ t: 'chg', dels, adds });
  }
  return out;
};
// the text of one side of a changed line, its changed words marked (only when the pair shares something: else the whole line is the change)
const marked = (d, side) => d.map(w => w.t === 'eq' ? esc(w.s) : w.t === side ? `<mark class="dv-w">${esc(w.s)}</mark>` : '').join('');
const pairWords = (x, y) => { if (x == null || y == null) return null; const d = diffWords(x, y); return d.some(w => w.t === 'eq' && w.s.trim()) ? d : null; };
const num = n => `<span class="dv-n">${n ?? ''}</span>`;
const skipRow = (o, cols) => `<div class="dv-row dv-skip" data-dv-skip><span class="dv-sk" style="grid-column:1/span ${cols}">${o.n == null ? esc(o.text ? '@@ ' + o.text : '...') : `${o.n} unchanged line${o.n === 1 ? '' : 's'}`}</span></div>`;

/** ops -> HTML. mode 'unified' (one column, both numbers) | 'split' (before | after side by side); ctx = lines kept around a change
 * (null = no folding). Each change carries data-dv-chg (the panel's next / previous change). Never wider than its box: lines wrap. */
export function renderDiff(ops, { mode = 'unified', ctx = 3, empty = 'no difference' } = {}) {
  const view = ctx == null ? ops : collapse(ops, ctx);
  if (!ops.some(o => o.t === 'add' || o.t === 'del')) return `<div class="dv dv-${mode}"><p class="small mute dv-none">${esc(empty)}</p></div>`;
  const rows = [];
  let c = 0;
  for (const bl of blocks(view)) {
    if (bl.t === 'skip') { rows.push(skipRow(bl, mode === 'split' ? 4 : 3)); continue; }
    if (bl.t === 'eq') { rows.push(mode === 'split' ? `<div class="dv-row dv-eq">${num(bl.a)}<span class="dv-t">${esc(bl.text)}</span>${num(bl.b)}<span class="dv-t">${esc(bl.text)}</span></div>`
      : `<div class="dv-row dv-eq">${num(bl.a)}${num(bl.b)}<span class="dv-t"> ${esc(bl.text)}</span></div>`); continue; }
    const id = c++, words = bl.dels.map((d, k) => pairWords(d.text, bl.adds[k]?.text));
    if (mode === 'split') {
      for (let k = 0; k < Math.max(bl.dels.length, bl.adds.length); k++) {
        const d = bl.dels[k], a = bl.adds[k], w = words[k] ?? null;
        rows.push(`<div class="dv-row dv-pair"${k === 0 ? ` data-dv-chg="${id}"` : ''}>${num(d?.a)}<span class="dv-t ${d ? 'dv-del' : 'dv-gap'}">${d ? (w ? marked(w, 'del') : esc(d.text)) : ''}</span>${num(a?.b)}<span class="dv-t ${a ? 'dv-add' : 'dv-gap'}">${a ? (w ? marked(w, 'add') : esc(a.text)) : ''}</span></div>`);
      }
    } else {
      bl.dels.forEach((d, k) => rows.push(`<div class="dv-row dv-del"${k === 0 ? ` data-dv-chg="${id}"` : ''}>${num(d.a)}${num('')}<span class="dv-t">-${words[k] ? marked(words[k], 'del') : esc(d.text)}</span></div>`));
      bl.adds.forEach((a, k) => rows.push(`<div class="dv-row dv-add"${!bl.dels.length && k === 0 ? ` data-dv-chg="${id}"` : ''}>${num('')}${num(a.b)}<span class="dv-t">+${words[k] ? marked(words[k], 'add') : esc(a.text)}</span></div>`));
    }
  }
  return `<div class="dv dv-${mode}" data-dv-changes="${c}">${rows.join('')}</div>`;
}

/** the compact inline form on a card: a head (what, +n -m, Open) over the unified diff; src = { patch } | { before, after }.
 * Open (data-act="diff-open") shows it in the picture-in-picture panel: the source rides along in data attributes (a patch is small;
 * a large before / after names a url instead: { url } - the panel fetches { before, after, title, sub } from it). */
export function diffBlock(src, { title = '', sub = '', ctx = 3, open = true, cls = '' } = {}) {
  const ops = src.patch != null ? parsePatch(src.patch).ops : src.before != null || src.after != null ? diffLines(src.before, src.after) : null;
  const st = ops ? diffStats(ops) : null, data = src.patch != null ? ` data-dv-patch="${esc(src.patch)}"` : src.url ? ` data-dv-url="${esc(src.url)}"` : ` data-dv-before="${esc(src.before ?? '')}" data-dv-after="${esc(src.after ?? '')}"`;
  const btn = open ? `<button type="button" class="ghost dv-open" data-act="diff-open"${data} data-dv-title="${esc(title)}" data-dv-sub="${esc(sub)}" title="Open in the diff viewer">Open</button>` : '';
  return `<div class="dvbox${cls ? ' ' + cls : ''}"><div class="dv-head small">${title ? `<span class="mono dv-title">${esc(title)}</span>` : ''}${st ? `<span class="dv-st"><span class="dv-plus">+${st.add}</span> <span class="dv-minus">-${st.del}</span></span>` : ''}<span class="spacer"></span>${btn}</div>${ops ? renderDiff(ops, { ctx }) : ''}</div>`;
}
