// slop-meter S1 (design: state/norn/briefs/slop-meter-design.md): the slop meter - how slopified the WHOLE tree at main's head is, as
// one number and a band. Cheap deterministic signals over the code texts (regex + scan.mjs classify, no AST) and the git facts the
// caller passes; each signal is a density (per 10 k code tokens) or a share, scored 0-100 on a log scale between the anchors of
// meter.json, then averaged per group and weighted into the total. meterOf is pure: the same texts, facts and meter.json give the same
// score. The one random part, MinHash for near-duplicate functions, draws its hash salts from meter.json's fixed seed, so a commit
// that changes no function body keeps its S9 value. meterInput is the git side (the texts and landings at a ref); the daily report and
// `norn slop meter` call both.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CODE, COMMENT, classify, exportsOf, isJs, isReason, usesOf } from './scan.mjs';
import { loadRules, gitRun, blobs, matchAny, patterns, shimFindings } from './check.mjs';
import { classOf, landings, mainRef, num } from './loc.mjs';

const METER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'meter.json');
export const loadMeter = (file = METER_FILE) => JSON.parse(fs.readFileSync(file, 'utf8'));
const meterHash = cfg => crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 12);
const extOf = f => (/\.([^./]+)$/.exec(f)?.[1] || '').toLowerCase();
const per10k = (n, tokens) => (tokens ? 1e4 * n / tokens : 0);
const r3 = x => Number(x.toPrecision(3));   // 3 significant digits: a share of 0.0035 stays visible

// ---------- the anchor math and the bands ----------
/** a value -> 0-100 on a log scale: good scores 0, bad 100 (either way round); null = not measured */
export function anchorScore(x, { good, bad }) {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  if (x <= 0) return good < bad ? 0 : 100;
  return Math.max(0, Math.min(100, 100 * (Math.log(x) - Math.log(good)) / (Math.log(bad) - Math.log(good))));
}
/** the band of a score; prev (the last band) holds until the score passes one of its edges by cfg.hysteresis points */
export function bandOf(score, cfg, prev = null) {
  const bands = cfg.bands, at = i => bands[i][0], raw = [...bands].reverse().find(([lo]) => score >= lo)?.[1] ?? bands[0][1];
  const i = bands.findIndex(([, name]) => name === prev);
  if (i < 0 || raw === prev) return raw;
  const lo = at(i), hi = i + 1 < bands.length ? at(i + 1) : Infinity, h = cfg.hysteresis ?? 0;
  return score >= hi + h || score <= lo - h ? raw : prev;
}

// ---------- one file: code and comment apart, tokens, functions ----------
const TOKEN = /[\w$]+|[^\s\w$]+/g;
const count = (s, re) => (s.match(re) || []).length;
/** { file, ext, js, text, code (non-code blanked, newlines kept), comment (the same for comments), lines (non-blank), tokens } */
export function prep(file, text) {
  const ext = extOf(file), js = isJs(file);
  let code = text, comment = '';
  if (js) {
    const cls = classify(text), c = text.split(''), m = c.slice();
    for (let i = 0; i < c.length; i++) if (c[i] !== '\n') { if (cls[i] !== CODE) c[i] = ' '; if (cls[i] !== COMMENT) m[i] = ' '; }
    code = c.join(''); comment = m.join('');
  } else {
    // a line comment by its marker (# or //); both texts keep every offset of the original (blanks, not cuts)
    const re = ext === 'py' ? /(^|\s)(#.*)$/ : /(^|\s)(\/\/.*)$/, ls = text.split('\n'), hit = ls.map(l => re.exec(l)), cut = (l, k) => (hit[k] ? hit[k].index + hit[k][1].length : l.length);
    code = ls.map((l, k) => l.slice(0, cut(l, k)).padEnd(l.length)).join('\n');
    comment = ls.map((l, k) => ' '.repeat(cut(l, k)) + l.slice(cut(l, k))).join('\n');
  }
  const nl = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) nl.push(i);
  // at(i): the 1-based line of an offset (a binary search over the newlines); words: every identifier of the code and its count
  const at = i => { let lo = 0, hi = nl.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (nl[mid] < i) lo = mid + 1; else hi = mid; } return lo + 1; };
  const words = new Map();
  for (const w of code.match(/[\w$]+/g) || []) words.set(w, (words.get(w) || 0) + 1);
  return { file, ext, js, text, code, comment, at, words, lines: count(text, /^.*\S.*$/gm), tokens: count(code, TOKEN) };
}

// the index just past the bracket that closes the one at i (code text: strings and comments are blank), or -1
function closeAt(s, i) {
  const open = s[i], shut = { '(': ')', '{': '}', '[': ']' }[open];
  for (let d = 0, j = i; j < s.length; j++) { if (s[j] === open) d++; else if (s[j] === shut && --d === 0) return j + 1; }
  return -1;
}
// an arrow's expression body: from i to the first , ; or newline at depth 0, or the bracket that closes around it
function exprEnd(s, i) {
  for (let d = 0, j = i; j < s.length; j++) {
    const c = s[j];
    if ('([{'.includes(c)) d++;
    else if (')]}'.includes(c)) { if (--d < 0) return j; }
    else if (d === 0 && (c === ',' || c === ';' || c === '\n')) return j;
  }
  return s.length;
}
// the statements of a block body: its content split on ; and newlines at depth 0
function statements(inner) {
  const out = []; let d = 0, cur = '';
  for (const c of inner) {
    if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--;
    if (d === 0 && (c === ';' || c === '\n')) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const NOT_METHOD = /^(?:if|for|while|switch|catch|function|return|with|else|do|try|typeof|await|new|super|import)$/;
/**
 * the functions of a prepped file: [{ file, name, line, kind (function | arrow | method), top (declared at column 0), exported,
 * params (the simple names, or null when one is destructured or defaulted), body (code text), one (the single statement or expression,
 * or null), stmts }]
 */
export function functionsOf(f) {
  const out = [], s = f.code;
  const add = (name, at, kind, exported, pOpen, bodyAt, one = null) => {
    const pEnd = pOpen < 0 ? -1 : closeAt(s, pOpen), raw = pOpen < 0 ? one : s.slice(pOpen + 1, pEnd - 1);
    let b = bodyAt ?? pEnd;
    if (b < 0) return;
    if (bodyAt === undefined) { const m = /^[^{;]{0,200}?\{/.exec(s.slice(b)); if (!m) return; b += m[0].length - 1; }
    while (/\s/.test(s[b] ?? '')) b++;
    const block = s[b] === '{', end = block ? closeAt(s, b) : exprEnd(s, b);
    if (end < 0) return;
    const body = s.slice(b, end), sts = block ? statements(body.slice(1, -1)) : [body.trim()];
    const ps = raw === null ? null : raw.split(',').map(x => x.trim()).filter(Boolean);
    const lineStart = s.lastIndexOf('\n', at) + 1;
    out.push({ file: f.file, name, line: f.at(at), kind, top: !/\S/.test(s.slice(lineStart, at).replace(/^(?:export\s+)?/, '')) && s[lineStart] !== ' ' && s[lineStart] !== '\t', exported,
      params: ps && ps.every(p => /^(?:\.\.\.)?[\w$]+$/.test(p)) ? ps : null, body, one: sts.length === 1 ? sts[0].replace(/;$/, '') : null, stmts: sts.length });
  };
  if (f.js) {
    for (const m of s.matchAll(/(?<![\w$.])(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\(/g)) add(m[2], m.index + (m[1]?.length ?? 0), 'function', !!m[1], m.index + m[0].length - 1);
    for (const m of s.matchAll(/(?<![\w$.])(export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(\(|[\w$]+\s*=>)/g)) {
      const at = m.index + m[0].length - m[3].length;
      if (m[3] === '(') { const e = closeAt(s, at), arrow = e > 0 && /^\s*=>/.exec(s.slice(e)); if (arrow) add(m[2], m.index + (m[1]?.length ?? 0), 'arrow', !!m[1], at, e + arrow[0].length); }
      else add(m[2], m.index + (m[1]?.length ?? 0), 'arrow', !!m[1], -1, at + m[3].length, m[3].replace(/\s*=>$/, ''));
    }
    for (const m of s.matchAll(/^[ \t]+(?:static\s+)?(?:async\s+)?([\w$]+)\s*\(/gm)) {
      const at = m.index + m[0].length - 1, e = closeAt(s, at);
      if (NOT_METHOD.test(m[1]) || e < 0 || !/^\s*\{/.test(s.slice(e))) continue;
      add(m[1], m.index + m[0].search(/\S/), 'method', false, at);
    }
  } else if (f.ext === 'py') {
    const lines = s.split('\n');
    for (const m of s.matchAll(/^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
      const line = f.at(m.index), ind = m[1].length, pEnd = closeAt(s, m.index + m[0].length - 1), raw = s.slice(m.index + m[0].length, pEnd - 1);
      const body = [];
      for (let k = line; k < lines.length; k++) { if (lines[k].trim() && (lines[k].search(/\S/) <= ind)) break; body.push(lines[k]); }
      const sts = body.map(l => l.trim()).filter(Boolean), ps = raw.split(',').map(x => x.trim()).filter(Boolean);
      out.push({ file: f.file, name: m[2], line, kind: ind ? 'method' : 'function', top: !ind, exported: !m[2].startsWith('_'), params: ps.every(p => /^\*{0,2}\w+$/.test(p)) ? ps.filter(p => p !== 'self') : null,
        body: body.join('\n'), one: sts.length === 1 ? sts[0] : null, stmts: sts.length });
    }
  } else if (f.ext === 'rs') {
    for (const m of s.matchAll(/(?<![\w])(pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+(\w+)\s*(?:<[^>{]*>)?\s*\(/g)) add(m[2], m.index, 'function', !!m[1], m.index + m[0].length - 1);
  }
  return out;
}

// ---------- MinHash (S9) ----------
// mulberry32: the seeded PRNG behind the hash salts (same seed, same salts, on every machine)
const prng = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0); };
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return h >>> 0; };
const fmix = h => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
const KEYWORDS = new Set('if else for while do return const let var function async await new class this of in typeof instanceof throw try catch finally switch case break continue default yield import export from null undefined true false def elif lambda pass self None True False fn let mut match impl pub use'.split(' '));
/** a body's tokens with identifiers as I and literals as L (keywords and punctuation kept) */
const shapeOf = body => (body.replace(/(['"])\s*\1/g, ' L ').match(TOKEN) || []).map(t => (KEYWORDS.has(t) ? t : /^\d/.test(t) ? 'L' : /^[\w$]+$/.test(t) ? (t === 'L' ? 'L' : 'I') : t));
const shingles = (toks, k) => { const out = new Set(); for (let i = 0; i + k <= toks.length; i++) out.add(fnv(toks.slice(i, i + k).join(' '))); return out; };
const jaccard = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n / (a.size + b.size - n); };
/** the near-duplicate clusters among functions: [[index]] (2+ members), by MinHash + LSH bands, each pair checked exactly */
export function nearDups(fns, mh, seed) {
  const next = prng(seed), salts = Array.from({ length: mh.perms }, next), rows = mh.perms / mh.bands;
  const sets = fns.map(f => { const t = shapeOf(f.body); return t.length >= mh.min_tokens ? shingles(t, mh.shingle) : null; });
  const buckets = new Map();
  sets.forEach((set, i) => {
    if (!set) return;
    const sig = salts.map(salt => { let m = 0xffffffff; for (const x of set) { const h = fmix(x ^ salt); if (h < m) m = h; } return m; });
    for (let b = 0; b < mh.bands; b++) { const key = `${b}:${sig.slice(b * rows, (b + 1) * rows).join(',')}`; (buckets.get(key) || buckets.set(key, []).get(key)).push(i); }
  });
  const up = fns.map((_, i) => i), find = i => (up[i] === i ? i : (up[i] = find(up[i]))), seen = new Set();
  for (const ids of buckets.values()) for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    const key = ids[a] * 1e6 + ids[b];
    if (seen.has(key)) continue;
    seen.add(key);
    if (jaccard(sets[ids[a]], sets[ids[b]]) >= mh.jaccard) up[find(ids[a])] = find(ids[b]);
  }
  const by = new Map();
  sets.forEach((set, i) => { if (set) { const r = find(i); (by.get(r) || by.set(r, []).get(r)).push(i); } });
  return [...by.values()].filter(c => c.length > 1);
}

// ---------- the signals: each -> { parts: { key: value }, offenders: [{ file, line, what, n }], mass (the sum of every item's n) } ----------
const off = (file, line, what, n = 1) => ({ file, line, what, n });
const words = s => (s.toLowerCase().match(/[a-z]{3,}/g) || []);
const identWords = s => (s.match(/[A-Za-z_$][\w$]*/g) || []).flatMap(id => id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_$]+/)).map(w => w.toLowerCase()).filter(w => w.length >= 3);
const IMPORT_SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;

function signals(files, fns, git, cfg, rules) {
  const T = files.reduce((n, f) => n + f.tokens, 0), S = {};
  // S1 net growth: deleted / added code lines over 30 days of first-parent landings, and big landings per week
  const ls = git.landings || [], add = ls.reduce((n, l) => n + (l.added?.code || 0), 0), del = ls.reduce((n, l) => n + (l.deleted?.code || 0), 0), big = ls.filter(l => l.big);
  S.S1 = { parts: { kept: add ? del / add : null, big: git.landings ? big.length / (30 / 7) : null }, offenders: [], mass: 0 };
  S.S2 = { parts: { tokens: T }, offenders: [], mass: 0 };
  // S3 god files: the token share of files past the line or token limit, and the Gini of the file sizes
  const god = files.filter(f => f.lines > cfg.god.lines || f.tokens > cfg.god.tokens), sizes = files.map(f => f.tokens).sort((a, b) => a - b);
  const gini = sizes.length > 1 && T ? (2 * sizes.reduce((n, x, i) => n + (i + 1) * x, 0)) / (sizes.length * T) - (sizes.length + 1) / sizes.length : 0;
  S.S3 = { parts: { god: T ? god.reduce((n, f) => n + f.tokens, 0) / T : 0, gini }, offenders: god.map(f => off(f.file, 1, `god file: ${f.lines} lines, ${f.tokens} tokens`, f.tokens)), mass: god.reduce((n, f) => n + f.tokens, 0) };
  // S4 fragmentation: tiny files, one-export modules, the mean relative import fan-out
  const js = files.filter(f => f.js), tiny = files.filter(f => f.lines < cfg.tiny_lines);
  const exportsN = f => exportsOf(f.code).length + [...f.code.matchAll(/^export\s*\{([^}]*)\}/gm)].reduce((n, m) => n + m[1].split(',').filter(x => x.trim()).length, 0);
  const fan = f => [...f.text.matchAll(IMPORT_SPEC)].filter(m => m[1].startsWith('.')).length;
  S.S4 = { parts: { tiny: files.length ? tiny.length / files.length : null, single: js.length ? js.filter(f => exportsN(f) === 1).length / js.length : null, fanout: js.length ? js.reduce((n, f) => n + fan(f), 0) / js.length : null },
    offenders: tiny.map(f => off(f.file, 1, `tiny file: ${f.lines} lines`)), mass: tiny.length };
  // S5 functions: density and the median body size (shown, weight 0)
  const bodyT = fns.map(f => count(f.body, TOKEN)).sort((a, b) => a - b);
  S.S5 = { parts: { density: per10k(fns.length, T), median: bodyT.length ? bodyT[bodyT.length >> 1] : null }, offenders: [], mass: 0 };
  // S6 pass-through wrappers: one statement that calls one function (or `new X`) with the function's own parameters, in order
  const pass = fns.filter(f => {
    if (!f.one || !f.params?.length) return false;
    const m = /^(?:return\s+)?(?:await\s+)?(?:new\s+)?([\w$.]+)\s*\(([^()]*)\)$/.exec(f.one.trim());
    return !!m && m[1].split('.').pop() !== f.name && m[2].split(',').map(x => x.trim()).filter(Boolean).join(',') === f.params.join(',');
  });
  S.S6 = { parts: { rate: per10k(pass.length, T) }, offenders: pass.map(f => off(f.file, f.line, `pass-through: ${f.name}(${f.params.join(', ')}) only calls ${f.one.trim().replace(/^return\s+/, '').slice(0, 60)}`)), mass: pass.length };
  // S7 abstraction names: declared functions and classes named Factory, Adapter, Wrapper, Manager ...
  const absRe = new RegExp(cfg.abstraction), classes = files.flatMap(f => [...f.code.matchAll(/\bclass\s+([\w$]+)/g)].map(m => ({ file: f.file, name: m[1], line: f.at(m.index) })));
  const abs = [...fns.filter(f => f.kind !== 'method'), ...classes].filter(x => absRe.test(x.name));
  S.S7 = { parts: { rate: per10k(abs.length, T) }, offenders: abs.map(x => off(x.file, x.line, `abstraction name: ${x.name}`)), mass: abs.length };
  // S8 single-use helpers: a module-private function of 1-3 statements that its file names twice (the declaration and one call)
  const byFile = new Map(files.map(f => [f.file, f]));
  const once = fns.filter(f => f.kind !== 'method' && !f.exported && f.stmts <= 3 && byFile.get(f.file).words.get(f.name) === 2);
  S.S8 = { parts: { share: fns.length ? once.length / fns.length : null }, offenders: once.map(f => off(f.file, f.line, `single-use helper: ${f.name}`)), mass: once.length };
  // S9 near-duplicate functions (MinHash): the share of functions in a cluster
  const clusters = nearDups(fns, cfg.minhash, cfg.seed), inC = clusters.reduce((n, c) => n + c.length, 0);
  S.S9 = { parts: { share: fns.length ? inC / fns.length : null }, mass: inC,
    offenders: clusters.map(c => { const [a, ...rest] = c.map(i => fns[i]); return off(a.file, a.line, `${c.length} near-duplicates: ${[a, ...rest].slice(0, 3).map(f => `${f.name} (${f.file.split('/').pop()}:${f.line})`).join(', ')}${c.length > 3 ? ' ...' : ''}`, c.length); }) };
  // S10 one name, many modules: a top-level function name declared in 2+ modules of the same import group (K9's groups)
  const groups = rules.find(r => r.id === 'K9')?.groups || [], gOf = new Map(files.map(f => [f.file, `${f.js ? 'js' : f.ext}:${groups.findIndex(g => matchAny(g, f.file))}`])), groupOf = file => gOf.get(file);
  const names = new Map();
  for (const f of fns.filter(x => x.top && x.kind !== 'method')) { const k = `${groupOf(f.file)}|${f.name}`, s = names.get(k) || names.set(k, new Map()).get(k); if (!s.has(f.file)) s.set(f.file, f); }
  const many = [...names.entries()].filter(([, s]) => s.size > 1);
  S.S10 = { parts: { share: names.size ? many.length / names.size : null }, mass: many.reduce((n, [, s]) => n + s.size - 1, 0),
    offenders: many.map(([k, s]) => { const [first] = s.values(); return off(first.file, first.line, `${k.split('|')[1]} is declared in ${s.size} modules: ${[...s.keys()].slice(0, 3).map(x => x.split('/').pop()).join(', ')}${s.size > 3 ? ' ...' : ''}`, s.size - 1); }) };
  // S11 several ways to do one thing (weight 0 in slice 1): the concerns that use 2+ idioms
  const multi = Object.entries(cfg.idioms).map(([concern, res]) => [concern, res.filter(re => files.some(f => new RegExp(re).test(f.code)))]).filter(([, used]) => used.length > 1);
  S.S11 = { parts: { concerns: multi.length }, offenders: multi.map(([c, used]) => off('', 0, `${c}: ${used.length} idioms`)), mass: multi.length };
  // S12 swallowed errors: an empty catch with no reason (K2's test), a catch that returns a default without reading the error, .catch(() => null), except: pass
  const k2 = rules.find(r => r.id === 'K2')?.reason || [], swallowed = [];
  for (const f of files) {
    if (f.js) {
      for (const m of f.code.matchAll(/(?<![.\w$])catch\s*(?:\(\s*([\w$]+)?[^)]*\))?\s*\{/g)) {
        const b = m.index + m[0].length - 1, e = closeAt(f.code, b), inner = e < 0 ? '' : f.code.slice(b + 1, e - 1).trim();
        const empty = !inner && !isReason(f.comment.slice(b, e).replace(/\/\/|\/\*|\*\//g, ' '), k2).ok;
        const ret = /^return\b([^;]*);?$/.exec(inner), dflt = ret && !(m[1] && usesOf(ret[1], m[1]));
        if (empty || dflt) swallowed.push(off(f.file, f.at(m.index), empty ? 'empty catch' : `catch returns ${ret[1].trim() || 'nothing'} without the error`));
      }
      for (const m of f.code.matchAll(/\.catch\(\s*(?:async\s*)?\(\s*\)\s*=>\s*(?:\{\s*\}|null|undefined|false|\[\s*\]|\{\s*\}|''|""|0)\s*\)/g)) swallowed.push(off(f.file, f.at(m.index), '.catch drops the error'));
    } else if (f.ext === 'py') for (const m of f.code.matchAll(/^\s*except\b[^:\n]*:\s*(?:\n\s*)?(?:pass|return None|return)\s*$/gm)) swallowed.push(off(f.file, f.at(m.index + m[0].search(/\S/)), 'except: pass'));
  }
  S.S12 = { parts: { rate: per10k(swallowed.length, T) }, offenders: swallowed, mass: swallowed.length };
  // S13 symptom fixes: lint and type-check silencers
  const sym = [];
  for (const f of files) for (const [where, res] of [['comment', cfg.symptoms.comment], ['code', cfg.symptoms.code]]) for (const re of res) for (const m of f[where].matchAll(new RegExp(re, 'g'))) sym.push(off(f.file, f.at(m.index), `silencer: ${m[0]}`));
  S.S13 = { parts: { rate: per10k(sym.length, T) }, offenders: sym, mass: sym.length };
  // S14 narrating comments: a comment line that repeats the next code line's identifiers, or tells the edit history; S14T: stage tags
  const hist = cfg.history.map(re => new RegExp(re, 'i')), tag = new RegExp(cfg.stage_tag), stop = new Set(cfg.narrate.stop || []), narr = [], tags = [];
  let comments = 0;
  for (const f of files) {
    const cl = f.comment.split('\n'), kl = f.code.split('\n');
    cl.forEach((c, k) => {
      if (!/\w{3}/.test(c)) return;
      comments++;
      if (tag.test(c)) tags.push(off(f.file, k + 1, 'stage tag'));
      if (hist.some(re => re.test(c))) { narr.push(off(f.file, k + 1, `edit history: ${c.trim().slice(0, 60)}`)); return; }
      let j = k; while (j < kl.length && !/\S/.test(kl[j])) j++;
      const cw = new Set(words(c).filter(w => !stop.has(w))), kw = new Set(identWords(kl[j] || ''));
      if (cw.size >= cfg.narrate.min_words && jaccard(cw, kw) >= cfg.narrate.jaccard) narr.push(off(f.file, k + 1, `narrates the code: ${c.trim().slice(0, 60)}`));
    });
  }
  S.S14 = { parts: { share: comments ? narr.length / comments : null }, offenders: narr, mass: narr.length };
  S.S14T = { parts: { share: comments ? tags.length / comments : null }, offenders: [], mass: tags.length };
  // S15 dead and stray: modules no other file names (entry points apart), versioned names, summary files
  // a module is named when another file mentions its file name (an import, a page list, a script tag), imports it without the
  // extension, or (Python, Rust) names its stem in an import / mod line
  const entry = new RegExp(cfg.entry), named = new Map(), name = (n, file) => (named.get(n) || named.set(n, new Set()).get(n)).add(file);
  for (const f of [...files, ...(git.refs || [])]) {
    for (const m of f.text.matchAll(/[\w.-]+\.(?:m?js|cjs|tsx?|jsx|mts|cts)\b/g)) name(m[0], f.file);
    for (const m of f.text.matchAll(IMPORT_SPEC)) name(m[1].split('/').pop().replace(/\.[^.]+$/, ''), f.file);
    for (const m of f.text.matchAll(/^\s*(?:from|import|(?:pub\s+)?mod|use)\s+([\w.:]+)/gm)) for (const n of m[1].split(/[.:]+/)) name(n, f.file);
  }
  const isNamed = f => { const base = f.file.split('/').pop(), stem = base.replace(/\.[^.]+$/, ''); return [base, stem].some(n => [...(named.get(n) || [])].some(x => x !== f.file)); };
  const orphans = files.filter(f => !entry.test(f.file) && !f.text.startsWith('#!') && !isNamed(f));
  const strayRe = new RegExp(cfg.stray.names), strayF = new RegExp(cfg.stray.files);
  const stray = [...fns.filter(f => strayRe.test(f.name)).map(f => off(f.file, f.line, `versioned name: ${f.name}`)), ...(git.tree || []).filter(p => strayF.test(p)).map(p => off(p, 0, 'summary file'))];
  S.S15 = { parts: { orphans: files.length ? orphans.length / files.length : null, stray: per10k(stray.length, T) }, offenders: [...orphans.map(f => off(f.file, 1, 'nothing names this module')), ...stray], mass: orphans.length + stray.length };
  // S16 shims and deferrals: K11, K16 and K22 over the whole tree (their own patterns, never copied)
  const shim = [];
  for (const r of rules.filter(x => ['K11', 'K16', 'K22'].includes(x.id))) for (const f of files.filter(x => matchAny(r.files, x.file) && !matchAny(r.exclude, x.file))) {
    for (const h of r.kind === 'shim' ? shimFindings(r, f.text, f.file) : patterns(r, f.text, f.file, {})) shim.push(off(f.file, h.line, `${r.id}: ${h.snippet.trim().slice(0, 60)}`));
  }
  S.S16 = { parts: { rate: per10k(shim.length, T) }, offenders: shim, mass: shim.length };
  return { S, T };
}

/**
 * meterOf(texts { path -> text }, git { sha, landings (30 days, loc.mjs), tree (every path), refs ({ path -> text } of the other files
 * that may name a module: html) }, cfg (meter.json), { rules (default loadRules()), prev (the last band) }) ->
 * { score, band, groups: { name: score }, signals: [{ id, group, name, w, score, parts: { key: { value, score, unit } }, offenders }],
 *   top: [{ signal, file, line, what, pts }] (the 10 worst by their share of the total), files, tokens, functions, sha, hash }
 */
export function meterOf(texts, git = {}, cfg = loadMeter(), { rules = loadRules(), prev = null } = {}) {
  const langs = new Set(cfg.langs), files = Object.entries(texts).filter(([f]) => langs.has(extOf(f))).sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, t]) => prep(f, t));
  const fns = files.flatMap(functionsOf), refs = Object.entries(git.refs || {}).map(([file, text]) => ({ file, text }));
  const { S, T } = signals(files, fns, { ...git, refs }, cfg, rules);
  const sigs = cfg.signals.map(d => {
    const parts = Object.fromEntries(Object.entries(d.parts).map(([k, a]) => { const v = S[d.id].parts[k]; return [k, { value: v === null ? null : r3(v), score: anchorScore(v, a), unit: a.unit }]; }));
    const scored = Object.values(parts).map(p => p.score).filter(s => s !== null);
    return { id: d.id, group: d.group, name: d.name, w: d.w, score: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null, parts, mass: S[d.id].mass,
      offenders: S[d.id].offenders };
  });
  const groups = {}, gw = {};
  for (const [g, wt] of Object.entries(cfg.groups)) {
    const mine = sigs.filter(s => s.group === g && s.w > 0 && s.score !== null), w = mine.reduce((n, s) => n + s.w, 0);
    if (w) { groups[g] = mine.reduce((n, s) => n + s.w * s.score, 0) / w; gw[g] = wt; }
  }
  const W = Object.values(gw).reduce((a, b) => a + b, 0), score = W ? Object.entries(groups).reduce((n, [g, s]) => n + gw[g] * s, 0) / W : 0;
  // an offender's points: its share of its signal's mass times the points that signal adds to the total
  const top = sigs.flatMap(s => {
    if (!(s.w > 0) || !s.score || !s.mass || !gw[s.group]) return [];
    const gwSum = sigs.filter(x => x.group === s.group && x.w > 0 && x.score !== null).reduce((n, x) => n + x.w, 0), pts = s.score * (gw[s.group] / W) * (s.w / gwSum);
    return s.offenders.filter(o => o.file).map(o => ({ signal: s.id, file: o.file, line: o.line, what: o.what, pts: r3(pts * o.n / s.mass) }));
  }).sort((a, b) => b.pts - a.pts || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line)).slice(0, 10);
  const rounded = Math.round(score * 10) / 10;
  return { score: rounded, band: bandOf(rounded, cfg, prev), groups: Object.fromEntries(Object.entries(groups).map(([g, s]) => [g, Math.round(s * 10) / 10])),
    signals: sigs.map(({ mass, offenders, ...s }) => ({ ...s, score: s.score === null ? null : Math.round(s.score * 10) / 10, n: mass, offenders: offenders.slice(0, 5) })),
    top, files: files.length, tokens: T, functions: fns.length, sha: git.sha ?? null, hash: meterHash(cfg) };
}

/** the daily series point's part: { score, band, groups, top, hash } */
export const meterPoint = m => ({ score: m.score, band: m.band, groups: m.groups, top: m.top, hash: m.hash });
/** the score's change in 7 days: against the newest earlier point at least 7 days old, else the oldest earlier one (the first week);
 * series = [{ day, score }] oldest first; null = no earlier point */
export function meterDelta(series, day, score) {
  const before = series.filter(p => p.day < day), week = new Date(Date.parse(day + 'T00:00:00Z') - 7 * 864e5).toISOString().slice(0, 10);
  const base = before.filter(p => p.day <= week).at(-1) ?? before[0];
  return base ? Math.round((score - base.score) * 10) / 10 : null;
}

/** the meter's inputs at a ref of a repo (or of a monorepo project's folder: paths relative to it): { texts, git } */
export function meterInput(repo, { ref = null, now = Date.now(), cfg = loadMeter() } = {}) {
  ref ||= mainRef(repo);
  // few git calls (a spawn is the cost on Windows): the prefix and the sha in one rev-parse, every blob in one cat-file
  const [prefix, sha] = gitRun(repo, ['rev-parse', '--show-prefix', ref]).split('\n').map(s => s.trim());
  const tree = gitRun(repo, ['ls-tree', '-r', '-z', '--name-only', sha]).split('\0').filter(Boolean), langs = new Set(cfg.langs);
  const code = tree.filter(f => classOf(f) === 'code' && langs.has(extOf(f))), other = tree.filter(f => classOf(f) === 'code' && /^html?$/.test(extOf(f))), all = [...code, ...other];
  const t = blobs(repo, all.map(f => `${sha}:${prefix ? './' : ''}${f}`)), got = k => typeof t[k] === 'string';
  const since = new Date(now - 30 * 864e5).toISOString().slice(0, 10);
  return { texts: Object.fromEntries(code.map((f, k) => [f, t[k]]).filter((_, k) => got(k))),
    git: { sha, tree, landings: landings(repo, sha, since), refs: Object.fromEntries(other.map((f, k) => [f, t[code.length + k]]).filter((_, k) => got(code.length + k))) } };
}

const fmtV = p => (p.value === null ? '-' : num(p.value));
/** the table `norn slop meter` prints */
export function formatMeter(m, { ref = '' } = {}) {
  const L = [`slop meter ${m.score} ${m.band}${ref ? ` at ${ref}` : ''}${m.sha ? ` ${m.sha.slice(0, 7)}` : ''} (meter.json ${m.hash}): ${num(m.files)} code files, ${num(m.tokens)} code tokens, ${num(m.functions)} functions`, ''];
  const sc = s => (s === null || s === undefined ? '  -' : String(Math.round(s)).padStart(3));
  for (const g of [...new Set(m.signals.map(x => x.group))].sort((a, b) => (m.groups[b] ?? -1) - (m.groups[a] ?? -1))) {
    L.push(`${g.padEnd(12)} ${sc(m.groups[g])}`);
    for (const x of m.signals.filter(y => y.group === g)) L.push(`  ${x.id.padEnd(5)}${x.name.padEnd(30)}${sc(x.score)}${x.w ? '' : ' (weight 0)'}   ${Object.values(x.parts).map(p => `${fmtV(p)} ${p.unit}`).join('; ')}`);
  }
  L.push('', 'the 10 worst offenders (points of the total):');
  m.top.forEach((o, i) => L.push(`${String(i + 1).padStart(3)}. ${o.pts.toFixed(2).padStart(5)}  ${o.signal.padEnd(4)} ${o.file}${o.line ? ':' + o.line : ''}  ${o.what}`));
  return L.join('\n');
}
