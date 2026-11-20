// Docs tab markdown (META-UX-R1 addendum A): vendored, pinned marked + highlight.js (vendor/VENDOR.md), same module in the
// browser (/docs.mjs) and in node --test. Safe by construction: raw HTML is escaped, links only http(s) / mailto / #anchor,
// no images are loaded; the browser also runs the result through DOMPurify (ctx.sanitize). Record conventions get colour cues:
// DEC- / DIR- / RUN- / Q- / RM- / L: ids become clickable chips (data-rid), DONE / STOPPED / HANDOFF markers, PROPOSED ... GUESS tags.
import { Marked } from './vendor/marked.esm.js';
import hljs from './vendor/highlight.min.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SAFE_URL = /^(https?:\/\/|mailto:|#)/i;
const MAX_HL = 100000;          // code blocks above this many characters are shown unhighlighted
const MAX_DOC = 3000000;        // documents above this many characters are shown as plain text
const plainText = s => String(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const slug = s => plainText(s).toLowerCase().replace(/[^a-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') || 'section';
const MARK = { DONE: 'done', STOPPED: 'stopped', HANDOFF: 'handoff' };

// ids / markers / tags in text outside <a>, <code>, <pre> (the rendered HTML is well-formed: marked output, raw HTML escaped)
const CUE = /\b(?:((?:DEC|DIR|RUN|Q|RM)-\d+)|(L:[A-Za-z0-9][\w.-]*[\w])|(PROPOSED|DECIDED|MEASURED|GUESS|VERIFIED)|(DONE|STOPPED|HANDOFF))\b/g;
export function decorate(html) {
  let skip = 0;
  return html.split(/(<[^>]+>)/).map(part => {
    if (part.startsWith('<')) { const m = part.match(/^<(\/?)(a|code|pre)\b/i); if (m) skip += m[1] ? -1 : 1; return part; }
    if (skip > 0 || !part) return part;
    return part.replace(CUE, (all, id, lane, tag, mark) => id || lane ? `<a class="rid r-${(id || 'L').split(/[-:]/)[0].toLowerCase()}" href="#" data-rid="${esc(id || lane)}">${esc(id || lane)}</a>`
      : tag ? `<span class="tg tg-${tag.toLowerCase()}">${tag}</span>` : `<span class="chip ${MARK[mark]}">${mark}</span>`);
  }).join('');
}

/** the safe renderer parts every Norn markdown view shares (Docs here, prose.mjs for Norn's prose): code highlighted, raw HTML escaped,
 * links only http(s) / mailto / #anchor (other schemes: the text), images never loaded. Methods use marked's this.parser. */
export const safeRenderer = {
  code({ text: code, lang }) {
    const l = String(lang ?? '').trim().split(/\s+/)[0].toLowerCase(), known = l && hljs.getLanguage(l);
    const body = known && code.length <= MAX_HL ? hljs.highlight(code, { language: l, ignoreIllegals: true }).value : esc(code);
    return `<pre class="code"><code class="hljs${known ? ` language-${esc(l)}` : ''}">${body}</code></pre>\n`;
  },
  html({ text: raw }) { return esc(raw); },
  link({ href, title, tokens }) {
    const inner = this.parser.parseInline(tokens);
    return SAFE_URL.test(href ?? '') ? `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${href.startsWith('#') ? '' : ' rel="noopener noreferrer" target="_blank"'}>${inner}</a>`
      : `<span class="relink"${/^[a-z][a-z0-9+.-]*:/i.test(href ?? '') ? '' : ` title="${esc(href)}"`}>${inner}</span>`;   // other schemes: text only
  },
  image({ text: alt }) { return `<span class="relink">[image: ${esc(alt)}]</span>`; },   // never loaded (img-src self)
};

/** markdown -> { html, toc: [{ depth, id, text }] }; o.sanitize (browser: DOMPurify) runs last. */
export function renderMarkdown(text, o = {}) {
  const src = String(text ?? '');
  if (src.length > MAX_DOC) return { html: `<pre class="code">${esc(src)}</pre>`, toc: [] };
  const toc = [], seen = new Map();
  const md = new Marked({ gfm: true });
  md.use({ renderer: {
    ...safeRenderer,
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens), base = slug(inner), n = seen.get(base) ?? 0; seen.set(base, n + 1);
      const id = n ? `${base}-${n}` : base, label = plainText(inner), mk = label.match(/^(DONE|STOPPED|HANDOFF)\b/);
      if (depth <= 3) toc.push({ depth, id, text: label });
      return `<h${depth} id="${esc(id)}"${mk ? ` class="mk mk-${MARK[mk[1]]}"` : ''}>${inner}</h${depth}>\n`;
    },
  } });
  let html = decorate(md.parse(src));
  if (o.sanitize) html = o.sanitize(html);
  return { html, toc };
}
