// SloppaChoppa 2 S7 (SPEC 4.5, 4.7): the rule register - one row per rule sentence of a project's rule files (CLAUDE.md, AGENTS.md,
// its rules/ files, standing owner rulings), each with a class (how it is checked) and a home (where), as data in
// <project folder>/rules/slop/register.json. This module loads it, splits a rule file into sentences, counts the drift on the tree
// clock (the daily report), finds a new rule sentence with no row on a diff (K26, a WARN: say how it is checked) and lists the
// deferrals whose cited record is done (K22's resolver over the tree: daily.mjs), each with its fixer brief. check.mjs imports this
// module (K26's detector, the register in the rule set), so it imports nothing of check.mjs.
import path from 'node:path';
import { readText } from '../fsnap.mjs';
import { globToRe } from '../dlvgit.mjs';

export const REG_CLASSES = ['mechanical', 'proxy', 'voice', 'unchecked'], HOMES = ['slop', 'hook', 'tests', 'ci'];
export const registerFile = projectDir => path.join(projectDir, 'rules', 'slop', 'register.json');

/** the project's register, checked: { sources: { repo, project }, prose: { source: [quote] }, rows } | null (none yet). sources.repo
 * are paths from the repo's top, sources.project from the project folder; prose quotes sentences that state no rule (no row needed) */
export function loadRegister(projectDir) {
  const t = projectDir ? readText(registerFile(projectDir)) : null;
  if (t === null) return null;
  const r = JSON.parse(t), sources = { repo: r.sources?.repo || [], project: r.sources?.project || [] }, all = [...sources.repo, ...sources.project], ids = new Set();
  for (const w of r.rows || []) {
    const bad = !w.id || ids.has(w.id) ? 'a unique id' : !all.includes(w.source) ? 'a source listed in sources' : typeof w.text !== 'string' || !w.text.trim() ? 'a quoted text'
      : !REG_CLASSES.includes(w.class) ? `a class (${REG_CLASSES.join(' | ')})` : w.home !== undefined && !HOMES.includes(w.home) ? `a home of ${HOMES.join(' | ')} or none` : null;
    if (bad) throw new Error(`register.json ${w.id || '?'}: a row needs ${bad}`);
    ids.add(w.id);
  }
  const stray = Object.keys(r.prose || {}).filter(s => !all.includes(s));
  if (stray.length) throw new Error(`register.json: prose of a source not listed in sources (${stray.join(', ')})`);
  return { sources, prose: r.prose || {}, rows: r.rows || [] };
}

const matchAny = (globs, f) => globs.some(g => globToRe(g).test(f)), norm = s => s.replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
const ITEM = /^\s*(?:[-*+]|\d+\.|[a-z]\.|[ivx]+\.)\s+/, SPLIT = /(?<=[.!?])\s+(?=[A-Z`"'(*[])/g;
/** the sentences of a rule file: [{ line, text }]. A list item or a blank line starts a block; headings, code fences, HTML comments
 * and table rows are no rule text; a sentence needs three words */
export function sentences(text) {
  const out = [], lines = text.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, '')).split(/\r?\n/);
  let block = [], fence = false;
  const flush = () => {
    let s = '';
    const at = block.map(b => { const off = s ? s.length + 1 : 0; s += (s ? ' ' : '') + b.t; return [off, b.line]; });
    let i = 0;
    for (const m of [...s.matchAll(SPLIT), { index: s.length, 0: '' }]) {
      const t = norm(s.slice(i, m.index));
      if (/[A-Za-z]{2,}\W+\S+\W+\S+/.test(t)) out.push({ line: at.filter(([o]) => o <= i).at(-1)[1], text: t });
      i = m.index + m[0].length;
    }
    block = [];
  };
  lines.forEach((l, k) => {
    if (/^\s*(```|~~~)/.test(l)) { flush(); fence = !fence; return; }
    if (fence || !l.trim() || /^\s*(#|\|)/.test(l)) return flush();
    if (ITEM.test(l)) flush();
    block.push({ line: k + 1, t: l.replace(ITEM, '').trim() });
  });
  if (block.length) flush();
  return out;
}

/** a row's quote covers a sentence: the quote holds it, or a quote ending in "..." starts it */
export const covers = (quote, s) => { const q = norm(quote), pre = q.endsWith('...'), n = norm(s), p = pre ? norm(q.slice(0, -3)) : q; return p.includes(n) || (pre && n.startsWith(p)); };
/** the sentences of one source no row and no prose quote covers (reg null: every sentence) */
export const uncovered = (reg, source, text) => sentences(text).filter(s => ![...(reg?.rows || []).filter(w => w.source === source).map(w => w.text), ...(reg?.prose?.[source] || [])].some(q => covers(q, s.text)));

/**
 * The three drift numbers (SPEC 4.5) of a register over its sources' texts ({ source: text | null (gone) }) and the stored checks of
 * the week: noCheck (unchecked rows + sentences with no row), the breaches per row (its checks' new findings, one per fingerprint,
 * shadow left out), the rotten rows (their quote covers no sentence of their source); noHome lists the rows with no home.
 */
export function drift(reg, texts, checks = []) {
  const noRow = Object.entries(texts).flatMap(([source, t]) => (t === null ? [] : uncovered(reg, source, t).map(s => ({ source, ...s }))));
  const rotten = reg.rows.filter(w => texts[w.source] == null || !sentences(texts[w.source]).some(s => covers(w.text, s.text)));
  const seen = new Map(checks.flatMap(c => (c.findings || []).filter(f => f.new !== false && !f.shadow).map(f => [f.fp, f.rule.split('/')[0]])));
  const breaches = reg.rows.filter(w => w.checks?.length).map(w => {
    const by = {};
    for (const r of seen.values()) if (w.checks.includes(r)) by[r] = (by[r] || 0) + 1;
    return { id: w.id, n: Object.values(by).reduce((a, b) => a + b, 0), by };
  }).filter(b => b.n);
  const unchecked = reg.rows.filter(w => w.class === 'unchecked');
  return { noCheck: unchecked.length + noRow.length, unchecked, noRow, rotten, noHome: reg.rows.filter(w => !w.home), breaches };
}

/** the register's section of the daily report: drift's result + due (dueDeferrals), or { error } */
export function renderDrift(d) {
  if (d.error) return [`## Rule register: ${d.error}`, ''];
  const L = [`## Rule register: rules with no check: ${d.noCheck}`, '', `${d.unchecked.length} row(s) of class unchecked, ${d.noRow.length} rule sentence(s) with no row; ${d.rotten.length} rotten row(s); ${d.noHome.length} row(s) with no home.`, ''];
  L.push(...d.noRow.map(s => `- no row: \`${s.source}:${s.line}\` ${s.text.slice(0, 160)}`), ...d.unchecked.map(w => `- unchecked: ${w.id} (${w.source}) ${w.text.slice(0, 120)}`),
    ...d.rotten.map(w => `- rotten: ${w.id} (${w.source}): its quote is no longer in its source`), ...d.noHome.map(w => `- no home: ${w.id}`));
  if (d.breaches.length) L.push('', 'Breaches in 7 d:', '', ...d.breaches.map(b => `- ${b.id}: ${b.n} new (${Object.entries(b.by).map(([r, n]) => `${r} ${n}`).join(', ')})`));
  if (d.due?.length) L.push('', `Deferrals that came due: ${d.due.length}`, '', ...d.due.map(f => `- \`${f.file}:${f.line}\` ${f.ids.join(', ')}: do the deferred removal (${f.snippet.trim().slice(0, 120)})`));
  return [...L, ''];
}

/** K26's detector: the new sentences of a rule file (the rule's files + the register's repo sources) that no row covers */
export function registerKind(rule, ctx) {
  const reg = rule.register || null, files = [...(rule.files || []), ...(reg?.sources.repo || [])], pick = ctx.entries.filter(e => e.status !== 'D' && matchAny(files, e.path));
  const side = (s, key) => pick.flatMap(e => { const t = ctx.text(s, e[key]); return t === null ? [] : uncovered(reg, e.path, t).map(x => ({ file: e.path, line: x.line, msg: rule.title, snippet: x.text })); });
  return { head: side('head', 'path'), base: side('base', 'old') };
}
