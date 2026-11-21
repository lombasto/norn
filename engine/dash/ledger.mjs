// Ledger tab (LEDGER-UX R1): one ledger line -> one entry, and a record's text -> its structure. Parsers only: the pages render every
// text through the one prose renderer (prose.mjs). Pure; the same module runs in the browser (/ledger.mjs) and in node --test.
// Shapes: "- meta <ISO>Z[ minor]: body" (check-in / minor), "- auto <ISO>Z: body", "- <label> <ISO>Z: body" (controller session);
// any other line (headings, prose) is kind "other" and renders as markdown. The body splits at top-level "; " into clauses:
// the first is the headline, later ones are sub-lines, labelled when they start "<words>: " or with a known label word.
const ENTRY = /^- ([A-Za-z][\w.-]*) (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)( minor)?:\s?(.*)$/;
export const LEDGER_KINDS = ['check-in', 'minor', 'auto', 'controller', 'other'];
// later clauses the check-ins write as "<word> <rest>" with no colon (rate 1.2 %/h, records none new, digest 1 empty, ...)
const LABEL_WORDS = new Set(['rate', 'records', 'digest', 'band', 'dispatched', 'live', 'next', 'usage', 'ci']);

/** Split at "; " outside (), [], {} and `code`. */
export function splitClauses(body) {
  const out = []; let depth = 0, code = false, cur = '';
  const s = String(body ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`') code = !code;
    else if (!code && '([{'.includes(c)) depth++;
    else if (!code && ')]}'.includes(c)) depth = Math.max(0, depth - 1);
    if (c === ';' && s[i + 1] === ' ' && !depth && !code) { out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

function sub(clause) {
  const m = clause.match(/^([a-z][\w-]*(?: [a-z][\w-]*){0,2}):\s+(.+)$/);
  if (m) return { label: m[1], text: m[2] };
  const w = clause.match(/^([a-z]+) (.+)$/);
  if (w && LABEL_WORDS.has(w[1])) return { label: w[1], text: w[2] };
  return { label: null, text: clause };
}

/** line -> { kind, label, ts, headline, subs: [{ label, text }], raw } */
export function parseLedgerLine(line) {
  const raw = String(line ?? ''), m = raw.match(ENTRY);
  if (!m) return { kind: 'other', label: null, ts: null, headline: raw, subs: [], raw };
  const [, label, ts, minor, body] = m;
  const kind = label === 'meta' ? (minor ? 'minor' : 'check-in') : label === 'auto' ? 'auto' : 'controller';
  const [headline = '', ...rest] = splitClauses(body);
  return { kind, label, ts, headline, subs: rest.map(sub), raw };
}

/** lines (file order) -> entries (file order), blank lines dropped */
export const parseLedger = lines => (lines || []).filter(l => String(l ?? '').trim()).map(parseLedgerLine);

// ---------- Records text (RECORDS-TEXT R1): directive text / decision question, choice, why in the Ledger look ----------
// "OWNER a14 2026-10-30 ~20:15Z:" / "Owner 11-11 ~23:30Z (chat):" / "Owner 11-10 (amends DIR-93):" / "..., on the x note (..):"
const META = /^((?:OWNER|Owner)(?: [a-z]\d+)? (?:\d{4}-)?\d{2}-\d{2}(?: ~?\d{1,2}:\d{2}(?:Z| [A-Z]{2,4})?)?(?: \([^()]*\))?(?:, [^:'"]*)?):\s+/;
// a quote closes at its mark when no word character follows ("it's" stays inside)
function takeQuote(s) {
  const q = s[0];
  for (let i = 1; i < s.length; i++) if (s[i] === q && !/\w/.test(s[i + 1] ?? '')) return [s.slice(1, i), s.slice(i + 1)];
  return null;
}
// top-level "(1) .. (2) .." markers in sequence (outside parens / `code`); fewer than two = no list
function splitItems(s) {
  const marks = []; let depth = 0, code = false, want = 1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`') { code = !code; continue; }
    if (code) continue;
    if (c === '(') {
      const m = !depth && (i === 0 || /[\s:;,.]/.test(s[i - 1])) ? s.slice(i).match(/^\((\d{1,2})\)\s/) : null;
      if (m && Number(m[1]) === want) { marks.push([i, m[0].length]); want++; i += m[0].length - 1; continue; }
      depth++;
    } else if ('[{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
  }
  if (marks.length < 2) return { pre: s, items: [] };
  const trim = t => t.trim().replace(/[\s;,+]+$/, '');
  return { pre: trim(s.slice(0, marks[0][0])), items: marks.map(([at, n], k) => trim(s.slice(at + n, marks[k + 1]?.[0] ?? s.length))) };
}
/** text -> { meta, quotes: [], head, subs: [{ label, text }], items: [] } */
export function parseRecordText(text) {
  let s = String(text ?? '').trim(), meta = null; const quotes = [];
  const m = s.match(META);
  if (m) {
    meta = m[1]; s = s.slice(m[0].length);
    for (let q; /^['"]/.test(s) && (q = takeQuote(s));) {
      quotes.push(q[0]); s = q[1];
      const more = s.match(/^\s*\+\s*(?=['"])/); if (!more) break; s = s.slice(more[0].length);
    }
    s = s.replace(/^[\s.]+/, '');
  }
  const { pre, items } = splitItems(s);
  const [head = '', ...rest] = splitClauses(pre.replace(/[\s;,]+$/, ''));
  return { meta, quotes, head, subs: rest.map(sub), items };
}
/** text -> markdown for the one prose renderer (prose.mjs): the meta line in italics, each quote a block quote, the headline and its
 *  clause lines (a label in bold) as lines of one paragraph, the (1) (2) items as a numbered list */
export function recordMarkdown(text) {
  const p = parseRecordText(text), lines = [p.head, ...p.subs.map(x => (x.label ? `**${x.label}** ${x.text}` : x.text))].filter(Boolean);
  return [p.meta ? `*${p.meta}*` : '', ...p.quotes.map(q => `> ${q}`), lines.join('\n'), p.items.map((t, k) => `${k + 1}. ${t}`).join('\n')].filter(Boolean).join('\n\n');
}
