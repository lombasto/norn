// INBOX-REPLIES (6a): a question built from a plan, notes or brief section carries that source (file + section + line) and EVERY
// alternative the section names, verbatim - never the default plus one. The alternatives = the first top-level list of the section
// (after an "Alternatives" / "Options" lead-in when the section has one). A key the source writes - "(a)", "Option B:", "**c**" - is
// kept; otherwise a, b, c ... in order. The one item the source marks default / recommended is the recommendation, from 'source'.
// Pure but for the file read (injectable). Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

export class SourceError extends Error { constructor(m) { super(m); this.code = 2; } }

const HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const LEAD = /\b(alternatives?|options?)\b/i;
const KEYED = [/^\(([A-Za-z0-9]{1,3})\)\s*/, /^option\s+([A-Za-z0-9]{1,3})\s*[:.)-]\s*/i, /^\*\*([A-Za-z0-9]{1,3})\*\*\s*[:.)-]?\s*/, /^([A-Za-z0-9]{1,2})\)\s+/];
const DEFAULT = /\((?:plan\s+)?default\)|\bthe default\b|\(recommended\)|\brecommended\b/i;
const plain = s => s.replace(/[*_`]/g, '').trim();
const slug = s => plain(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** "file#section" -> { file, section }; a Windows drive letter's colon is no separator */
export function parseRef(ref) {
  const i = String(ref ?? '').lastIndexOf('#');
  if (i < 1 || i === ref.length - 1) throw new SourceError(`--from-source wants "<file>#<section>" (got ${JSON.stringify(ref)})`);
  return { file: ref.slice(0, i), section: ref.slice(i + 1).trim() };
}

/** the section's lines [start, end) and its heading line (1-based); exact heading text first, then its slug, then a prefix ("3.2") */
function sectionOf(lines, section) {
  const heads = lines.map((l, i) => { const m = HEAD.exec(l); return m ? { i, level: m[1].length, text: plain(m[2]) } : null; }).filter(Boolean);
  const want = plain(section).toLowerCase();
  const h = heads.find(x => x.text.toLowerCase() === want) ?? heads.find(x => slug(x.text) === slug(section)) ?? heads.find(x => x.text.toLowerCase().startsWith(want));
  if (!h) return null;
  const next = heads.find(x => x.i > h.i && x.level <= h.level);
  return { start: h.i + 1, end: next ? next.i : lines.length, line: h.i + 1, title: h.text };
}

/** the first top-level list in lines[start, end) - after a lead-in line naming alternatives / options when there is one */
function listOf(lines, start, end) {
  const lead = lines.slice(start, end).findIndex(l => !ITEM.test(l) && LEAD.test(l));
  const from = lead >= 0 ? start + lead + 1 : start, items = [];
  let indent = null, cur = null;
  for (let i = from; i < end; i++) {
    const l = lines[i], m = ITEM.exec(l);
    if (m && (indent === null || m[1].length <= indent)) { indent = m[1].length; cur = { text: m[2].trim(), line: i + 1 }; items.push(cur); continue; }
    if (!l.trim()) continue;
    if (cur && (m || /^\s/.test(l))) { cur.text += ' ' + l.trim(); continue; }   // a nested item or a continuation line: part of the item
    if (items.length) break;   // prose after the list ends it
    if (HEAD.test(l)) break;
  }
  return items;
}

/**
 * ref "file#section" -> { origin: { file, section, line }, options [{ key, text, cost }], recommend? { key, why, from: 'source' } }.
 * Throws SourceError when the file, the section or a list in it is missing.
 */
export function sourceQuestion(ref, { read = f => fs.readFileSync(f, 'utf8'), cwd = process.cwd() } = {}) {
  const { file, section } = parseRef(ref), abs = path.resolve(cwd, file);
  let text;
  try { text = read(abs); } catch { throw new SourceError(`--from-source: cannot read ${abs}`); }
  const lines = text.split(/\r?\n/), s = sectionOf(lines, section);
  if (!s) throw new SourceError(`--from-source: no heading "${section}" in ${abs}`);
  const items = listOf(lines, s.start, s.end);
  if (!items.length) throw new SourceError(`--from-source: section "${s.title}" of ${abs} names no alternatives (no list)`);
  const used = new Set();
  const options = items.map((it, n) => {
    let key = null, rest = it.text;
    for (const re of KEYED) { const m = re.exec(rest); if (m) { key = m[1].toLowerCase(); rest = rest.slice(m[0].length); break; } }
    if (!key || used.has(key)) { key = String.fromCharCode(97 + n); while (used.has(key)) key += "'"; }
    used.add(key);
    return { key, text: rest.trim(), cost: '' };
  });
  const defs = options.filter(o => DEFAULT.test(o.text));
  const origin = { file: abs.replace(/\\/g, '/'), section: s.title, line: s.line };
  return { origin, options, ...(defs.length === 1 ? { recommend: { key: defs[0].key, why: `the plan default (${path.basename(abs)}#${s.title})`, from: 'source' } } : {}) };
}
