// Norn prose (RM-30 S1): ONE renderer for the text Norn and its agents write (question bodies, options and their costs, answers, card
// reasons), so a body reads as structure, not a jumble. Built on the Docs tab's markdown stack (docs.mjs: the vendored, pinned marked
// + its safe renderer; the browser adds DOMPurify through ctx.sanitize) - no second markdown stack. Pure, no DOM: the same module runs
// in the browser (/prose.mjs) and in node --test.
//
// API (small on purpose: RM-30 S2, RM-27 and RM-28 render through it):
//   renderProse(text, ctx?) -> safe HTML, one <div class="prose"> (one <span> with ctx.inline). text = plain text or markdown; \r\n is normalised and a single line
//     break is kept. ctx (every key optional):
//       project   the project the text belongs to (chips carry it: data-project)
//       lanes     [lane name]: bare known lane names become lane chips (a plain-word name only right after "lane")
//       repo      'owner/name' on GitHub: PR #n and commit shas link there
//       docs      { <path as written>: <Docs file key> } (the server resolves pathsIn): such a path opens in the Docs reader
//       sanitize  html -> html (the browser's DOMPurify), run last
//       clamp     true: long text shows a 3-line preview + "more" on the phone; key = a stable id so "more" survives a re-render
//       inline    true: one <span class="prose pinline"> for text inside a line (a reason after a chip, in a <p> or <li>): inline
//                 markdown only (no lists or paragraphs; a line break is a <br>), never clamped
//   pathsIn(text) -> [path as written]: the file paths renderProse shows as path chips (what the server resolves into ctx.docs)
// What it marks, never inside code, links or paths: RUN- Q- DEC- DIR- DLV- RM- WVR- MAIL- ids and L:lane as chips (data-rid /
// data-dlv: the page opens each where it lives); PR #n; a commit sha next to a git word or alone in backticks; file paths (absolute
// Windows / POSIX, relative with a separator and an extension, a bare name with a known extension): the tail shown, the full path in
// the title and a copy button; measurements (a number with a unit), "a -> b" pairs, ranges "0.6-1.9 s", and >= <= != ~ x as
// ≥ ≤ ≠ ≈ ×; $...$ formulas monospace (no TeX engine).
import { Marked } from './vendor/marked.esm.js';
import { safeRenderer, esc } from './docs.mjs';

const MAX_PROSE = 200000;      // text above this many characters is shown as plain escaped text
const CLAMP_CHARS = 280, CLAMP_LINES = 3;

// ---- placeholders: code-span paths / shas, paths and $math$ are cut out before marked (it would eat a backslash or an underscore)
// and put back after; a placeholder is private-use characters only (no digit, no word character), so no later pattern touches it
const P0 = '\uE000', P1 = '\uE001', PBASE = 0xE100, PMAX = 0x17FF;
const PH_RE = /\uE000([\uE100-\uF8FF])\uE001/g;
const STRIP_PH = /[\uE000-\uF8FF]/g;   // the whole private-use range: no text can forge a placeholder

// ---- file paths
const SEG = String.raw`(?:[^\s\\/:*?"<>|()\[\]{}'\x60,;\uE000\uE001]|(?<=-)>)+`;   // "->" may sit inside a POSIX / relative name
const BARE_EXT = 'md|mjs|cjs|js|ts|tsx|jsx|json|jsonl|py|ipynb|txt|html|css|yml|yaml|toml|sh|ps1|cs|log|csv|xml|pdf|png|svg|ini|cfg';
const PATH_SRC = [
  String.raw`(?<![\w.\\/-])[A-Za-z]:[\\/](?:${SEG}[\\/])*(?:${SEG}[\\/]?)?`,                        // C:\x\y.md, C:/x/y/
  String.raw`(?<![\w.:\\/~-])(?:~\/|\/(?=${SEG}\/))(?:${SEG}\/)*${SEG}\/?`,                          // /a/b, ~/x (a lone /x is not a path)
  String.raw`(?<![\w.:\\/@-])(?:\.{1,2}[\\/])?(?:${SEG}[\\/])+${SEG}\.[A-Za-z0-9]{1,8}(?![\w\\/])`,  // engine/dash/ui.mjs, .\x\y.ps1
  String.raw`(?<![\w.:\\/@-])[A-Za-z_][\w.-]*\.(?:${BARE_EXT})(?![\w\\/-])`,                         // CHECKIN.md
].join('|');
const pathRe = () => new RegExp(PATH_SRC, 'g');
const WHOLE_PATH = new RegExp(`^(?:${PATH_SRC})$`);
const SHA_ONLY = /^(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}$/;
const trimTail = p => { const m = p.match(/[.:]+$/); return m ? [p.slice(0, -m[0].length), m[0]] : [p, '']; };

/** the file paths renderProse shows as path chips, as written (outside fenced code; a code span counts when it is one whole path) */
export function pathsIn(text) {
  const out = new Set();
  walk(clean(text), {
    code: inner => { const t = inner.trim(); if (WHOLE_PATH.test(t)) out.add(t); },
    text: s => { for (const m of s.matchAll(pathRe())) { const [p] = trimTail(m[0]); if (p) out.add(p); } },
  });
  return [...out];
}
const clean = t => String(t ?? '').replace(/\r\n?/g, '\n').replace(STRIP_PH, '');

// the text outside fenced code blocks, split into code spans (cb.code(inner, raw)) and the rest (cb.text(s)); returns the joined results
function walk(src, cb) {
  const out = []; let fence = null, plain = [];
  const flush = () => { if (plain.length) { out.push(spans(plain.join('\n'), cb)); plain = []; } };
  for (const line of src.split('\n')) {
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) { out.push(line); if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null; continue; }
    if (f) { flush(); fence = f[1]; out.push(line); continue; }
    if (!line.trim()) { flush(); out.push(line); continue; }   // a blank line ends a code span's reach (markdown: one paragraph)
    plain.push(line);
  }
  flush();
  return out.join('\n');
}
function spans(s, cb) {
  let out = '', i = 0;
  while (i < s.length) {
    const bt = s.indexOf('`', i);
    out += cb.text(bt < 0 ? s.slice(i) : s.slice(i, bt)) ?? '';
    if (bt < 0) break;
    let n = 1; while (s[bt + n] === '`') n++;
    const run = '`'.repeat(n);
    let close = bt + n;
    for (;;) { close = s.indexOf(run, close); if (close < 0 || s[close + n] !== '`') break; while (s[close] === '`') close++; }
    if (close < 0) { out += run; i = bt + n; continue; }
    const raw = s.slice(bt, close + n);
    out += cb.code(s.slice(bt + n, close), raw) ?? raw;
    i = close + n;
  }
  return out;
}

// ---- chips
const RID_PAGE = new Set(['RUN', 'Q', 'DEC', 'DIR', 'RM', 'L']);   // the page opens these where they live (index.html data-rid)
const pj = ctx => ctx.project ? ` data-project="${esc(ctx.project)}"` : '';
function idChip(id, ctx, label = id) {
  const k = id.split(/[-:]/)[0], cls = `rid r-${k.toLowerCase()}`;
  if (RID_PAGE.has(k)) return `<a class="${cls}" href="#" data-rid="${esc(id)}"${pj(ctx)}>${esc(label)}</a>`;
  if (k === 'DLV') return `<a class="${cls}" href="#" data-dlv="${esc(id)}"${pj(ctx)}>${esc(label)}</a>`;
  return `<span class="${cls}" title="${esc(`norn rec show ${id}`)}">${esc(label)}</span>`;   // WVR / MAIL: no page lists them yet
}
const gh = (ctx, tail) => /^[\w.-]+\/[\w.-]+$/.test(ctx.repo || '') ? `https://github.com/${ctx.repo}/${tail}` : null;
const ext = (href, cls, label, title) => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</a>`;
function prChip(n, label, ctx) { const u = gh(ctx, `pull/${n}`); return u ? ext(u, 'rid r-pr', label, null) : `<span class="rid r-pr">${esc(label)}</span>`; }
function shaChip(sha, ctx) { const u = gh(ctx, `commit/${sha}`); return u ? ext(u, 'rid r-sha', sha.slice(0, 7), sha) : `<span class="rid r-sha" title="${esc(sha)}">${esc(sha.slice(0, 7))}</span>`; }
/** the meaningful tail of a path: its last two parts (a short path whole) */
export function shortPath(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? String(p) : `…/${parts.slice(-2).join('/')}`;
}
function pathChip(p, ctx) {
  const key = ctx.docs?.[p], short = shortPath(p);
  const label = key ? `<button type="button" class="pp lnk" data-act="open-doc" data-doc="${esc(key)}"${pj(ctx)} title="${esc(`${p} - open in Docs`)}">${esc(short)}</button>`
    : `<code class="pp" title="${esc(p)}">${esc(short)}</code>`;
  return `<span class="ppath">${label}<button type="button" class="pcopy" data-act="copy-path" data-copy="${esc(p)}" title="Copy the full path" aria-label="Copy the full path ${esc(p)}">⧉</button></span>`;
}

// ---- measurements and math symbols (on plain text; the result is HTML)
const UNIT = String.raw`(?:%\/h|%|ms|secs?|seconds?|s|mins?|minutes?|hrs?|hours?|h|days?|d|[kKMG]?B|k tokens|M tokens|tokens|tok|k|M)`;
const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const PRE = String.raw`(?:>=|<=|!=|[<>≤≥≠~≈])\s?`;
const VAL = String.raw`(?:${PRE})?\$?${NUM}(?:\s?${UNIT}(?![\w%])|[x×](?!\w))?`;   // 3x = three times (attached; "2 x 3" is the operator)
const SYM = { '>=': '≥', '<=': '≤', '!=': '≠', '~': '≈' };
const sym = s => s.replace(/>=|<=|!=|~/g, m => SYM[m]).replace(/(\d)\s?x$/, '$1×');
const val = (s, cls = 'pv') => `<span class="${cls}">${esc(sym(s.trim()).replace(/(\d)\s(?=[A-Za-z%$])/, '$1\u00a0'))}</span>`;
const GIT_WORD = String.raw`commits?|sha|merged?|merge commit|cherry-picked|reverted|reverts?|landed|pushed|rebased|HEAD|git`;
const IDS = String.raw`(?:RUN|Q|DEC|DIR|DLV|RM|WVR|MAIL)-\d+`;
const laneRes = (lanes = []) => {
  const q = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), named = [...new Set(lanes.filter(l => /^[A-Za-z0-9][\w.-]*$/.test(String(l))))].sort((a, b) => b.length - a.length);
  const odd = named.filter(l => /[-_.\d]/.test(l)), plain = named.filter(l => !/[-_.\d]/.test(l));
  return { odd: odd.length ? `(?<![\\w.:/\\\\-])(?:${odd.map(q).join('|')})(?![\\w-]|\\.\\w)` : null, plain: plain.length ? `(?<=\\blanes? )(?:${plain.map(q).join('|')})\\b` : null };
};
// one pass, leftmost match wins: ids, L:lane, PR #n, git word + sha, before -> after, range, value, a bare known lane, x between numbers,
// comparison operators, a word arrow
function inlineRe(ctx) {
  const L = laneRes(ctx.lanes);
  const alts = [
    String.raw`(?<id>\b${IDS}\b)`,
    String.raw`(?<lane>\bL:[A-Za-z0-9][\w.-]*\w)`,
    String.raw`(?<pr>\bPR ?#(?<prn>\d+)\b)`,
    String.raw`(?<gw>\b(?:${GIT_WORD})\b:?\s(?:(?:at|as|is|to|on|=)\s)?)(?<sha>(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40})\b`,
    String.raw`(?<![\w.])(?<a>${VAL})(?<arr>\s*(?:->|→)\s*)(?<b>${VAL})`,
    String.raw`(?<![\w.$-])(?<range>${NUM}\s?[-–]\s?${NUM}\s?${UNIT})(?![\w%-])`,
    String.raw`(?<![\w.])(?<v>(?:${PRE})?\$?${NUM}(?:\s?${UNIT}(?![\w%])|[x×](?!\w))|\$${NUM}(?![\w.]))`,
    L.odd ? `(?<bl>${L.odd})` : null, L.plain ? `(?<pl>${L.plain})` : null,
    String.raw`(?<=\d\s?)(?<times>x)(?=\s?\d)`,
    String.raw`(?<op>>=|<=|!=)`,
    String.raw`(?<=\S\s)(?<warr>->)(?=\s\S)`,
  ].filter(Boolean);
  return new RegExp(alts.join('|'), 'g');
}
function inline(text, ctx, re) {
  let out = '', i = 0;
  for (const m of text.matchAll(re)) {
    const g = m.groups;
    out += esc(text.slice(i, m.index)); i = m.index + m[0].length;
    out += g.id ? idChip(g.id, ctx) : g.lane ? idChip(g.lane, ctx) : g.pr ? prChip(g.prn, g.pr, ctx) : g.sha ? esc(g.gw) + shaChip(g.sha, ctx)
      : g.a ? `<span class="pba" title="before → after">${val(g.a)}<span class="parr">→</span>${val(g.b)}</span>`
      : g.range ? val(g.range.replace(/\s?[-–]\s?/, '–'), 'pv prange') : g.v ? val(g.v)
      : g.bl || g.pl ? idChip(`L:${g.bl || g.pl}`, ctx, g.bl || g.pl)
      : g.times ? '<span class="pop">×</span>' : g.op ? `<span class="pop">${SYM[g.op]}</span>` : g.warr ? '<span class="parr">→</span>' : esc(m[0]);
  }
  return out + esc(text.slice(i));
}
const unesc = s => s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" }[e]));

/** text (plain or markdown) -> safe HTML: <div class="prose"> (see the header for ctx) */
export function renderProse(text, ctx = {}) {
  const src = clean(text);
  if (!src.trim()) return '';
  if (src.length > MAX_PROSE) return ctx.inline ? `<span class="prose pinline">${esc(src)}</span>` : `<div class="prose"><pre class="code">${esc(src)}</pre></div>`;
  const store = [];
  const put = (raw, html) => { if (store.length > PMAX) return null; store.push({ raw, html }); return P0 + String.fromCharCode(PBASE + store.length - 1) + P1; };
  const MATH = /(?<![\w$\\])\$(?=[^\s$\d])([^$\n]{1,120}?[^\s$\\])\$(?![\w$])/g;
  const cut = walk(src, {
    code: (inner, raw) => { const t = inner.trim(); return WHOLE_PATH.test(t) ? put(raw, pathChip(t, ctx)) : SHA_ONLY.test(t) ? put(raw, shaChip(t, ctx)) : raw; },
    text: s => s.replace(MATH, (all, f) => /[A-Za-z=^_\\+*/]/.test(f) ? put(all, `<code class="pmath">${esc(f)}</code>`) ?? all : all)
      .replace(pathRe(), all => { const [p, tail] = trimTail(all); return (p ? put(p, pathChip(p, ctx)) ?? p : '') + tail; }),
  });
  const md = new Marked({ gfm: true, breaks: true });
  md.use({ renderer: { ...safeRenderer, heading({ tokens }) { return `<p class="ph"><b>${this.parser.parseInline(tokens)}</b></p>\n`; } } });
  const back = (s, html) => s.replace(PH_RE, (_, c) => { const x = store[c.charCodeAt(0) - PBASE]; return x ? (html ? x.html : esc(x.raw)) : ''; });
  const re = inlineRe(ctx);
  let skip = 0;
  let html = (ctx.inline ? md.parseInline(cut) : md.parse(cut)).split(/(<[^>]+>)/).map(part => {
    if (part.startsWith('<')) { const m = part.match(/^<(\/?)(a|code|pre)\b/i); if (m) skip += m[1] ? -1 : 1; return back(part, false); }
    if (!part) return part;
    return skip > 0 ? back(part, false) : back(inline(unesc(part), ctx, re), true);
  }).join('');
  if (ctx.inline) { html = `<span class="prose pinline">${html}</span>`; return ctx.sanitize ? ctx.sanitize(html) : html; }
  const long = ctx.clamp && (src.length > CLAMP_CHARS || src.split('\n').filter(l => l.trim()).length > CLAMP_LINES);
  html = `<div class="prose${long ? ' pclamp' : ''}"${long && ctx.key ? ` data-key="${esc(ctx.key)}"` : ''}>${html}</div>${long ? '<button type="button" class="ghost pmore" data-act="prose-more" aria-expanded="false">more</button>' : ''}`;
  return ctx.sanitize ? ctx.sanitize(html) : html;
}
