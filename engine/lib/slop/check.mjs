// META-SLOP-A (REVIEW-FABLE 3 + 4.1 / 4.2; SPEC 3.4): the run's diff checked against the BLOCK rules. Rules are data files
// (rules/*.json: id, level, kind, the kind's parameters, a fixture with a hit and a near-miss). Only NEW findings count: each
// finding is fingerprinted (rule + file + normalised snippet, SARIF partialFingerprints style) at head and at base, the base path
// carried through git's rename detection, and a head finding is new only when the base had fewer of that fingerprint.
// The check is pure on git: it returns ONE result object; host.mjs is the one writer (holds, reports, waivers applied).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { globToRe } from '../dlvgit.mjs';
import { runTool, LINT_RULES } from './tools.mjs';
import { norm, lineAt, lineText, isReason, masked } from './scan.mjs';
import { lint, dup, exportsKind, refs, depLock } from './kinds.mjs';
import { model } from './voice.mjs';
import { readText, readdirS, existsS, prime } from '../fsnap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RULES_DIR = path.join(HERE, 'rules');
export const LEVELS = ['BLOCK', 'WARN', 'TREND', 'LIST'];
// RM-45 (audit REPORT sec. 6): the parameters a project may patch per kind (overrides.json), and the kinds a project rule
// (P-*.json) may use; a rule's text (patterns, selectors, its lint rules, the cited ids) is never a param. The engine-only kinds (diff-check, swallow, command, dup, exports, refs) are code over the whole tree, and
// `command` runs a program: a project file can switch and relevel them, never write one.
export const KIND_PARAMS = {
  'diff-check': [], swallow: ['files', 'exclude', 'deny'], pattern: ['files', 'exclude', 'in', 'unless'], eslint: ['files', 'exclude'],
  ast: ['files', 'exclude', 'reason'], imports: ['roots', 'files', 'exclude', 'forbid', 'bare', 'manifests', 'vendor'], command: [], junk: ['patterns', 'max_bytes', 'allow'],
  dup: ['roots', 'files', 'exclude', 'groups', 'min_chars'], exports: ['roots', 'files', 'exclude', 'search', 'tests', 'tests_level', 'entry'], refs: ['files', 'exclude'],
  model: ['files', 'exclude'],
};
const PROJECT_KINDS = ['pattern', 'junk', 'imports', 'ast', 'eslint'];

// RM-27: every rule, built-in or a project's own, carries its explanation beside its parameters - what was found, why the rule
// exists, what to do - so the CLI, the resume prompt and the Slop page say the same thing; a rule without all three does not load.
export const EXPLAIN = ['what', 'why', 'fix'];
function checkRule(r, f) {
  if (!r.id || !LEVELS.includes(r.level) || !DETECT[r.kind]) throw new Error(`${f}: a rule needs an id, a level (${LEVELS.join(' | ')}) and a known kind`);
  if (!r.fixture?.hit || !r.fixture?.miss) throw new Error(`${f}: a rule ships with a fixture hit and a near-miss (SPEC 3.4.5)`);
  if (r.kind === 'eslint' && (r.tool !== 'eslint' || !r.rules || Object.keys(r.rules).some(k => !LINT_RULES.includes(k)))) throw new Error(`${f}: an eslint rule names core rules from ${LINT_RULES.join(', ')} only`);
  if (r.kind === 'ast' && (r.tool !== 'eslint' || !r.selectors?.length || r.selectors.some(s => typeof s.selector !== 'string' || typeof s.message !== 'string'))) throw new Error(`${f}: an ast rule is a list of { selector, message } (tool eslint)`);
  if (r.kind === 'model' && (typeof r.question !== 'string' || !r.question.trim() || (r.on || []).some(o => !['code', 'tests'].includes(o)))) throw new Error(`${f}: a model rule asks a question in plain words; on lists code and / or tests`);
  if (!EXPLAIN.every(k => typeof r.explain?.[k] === 'string' && r.explain[k].trim())) throw new Error(`${f}: a rule explains itself (RM-27): explain.${EXPLAIN.join(' / explain.')} in plain words`);
  if (r.key && r.key !== 'match') throw new Error(`${f}: key is "match" or absent (the line)`);
  return r;
}
// rule reads go through fsnap (META-DASH-ASYNC R1): a snapshot lookup inside a dash GET that awaited primeRules, the sync form elsewhere
const readRule = file => checkRule(JSON.parse(readText(file)), path.basename(file));
const jsonNames = (dir, re = /\.json$/) => readdirS(dir).map(d => d.name).filter(f => re.test(f)).sort();
export function loadRules(dir = RULES_DIR) {
  return jsonNames(dir).map(f => readRule(path.join(dir, f)));
}
/** read every rule file effectiveRules / explainOf will read into the request snapshot, on fs.promises (the dash Guard) */
export async function primeRules(projectDir = null, dir = RULES_DIR) {
  const own = projectDir ? path.join(projectDir, 'rules', 'slop') : null;
  await prime({ dirs: [dir, ...(own ? [own] : [])], stats: own ? [own] : [] });
  await prime({ files: [...jsonNames(dir).map(f => path.join(dir, f)), ...(own ? jsonNames(own).map(f => path.join(own, f)) : [])] });
}

/**
 * The effective rule set of a project (audit REPORT sec. 6): the built-ins, the project's own rules (<project folder>/rules/slop/
 * P-*.json, ids P-*, project kinds only) and overrides.json, a sparse patch keyed by id: { enabled, level, shadow, params: { listed
 * params of that kind } }. A patch can switch, relevel or retune a rule, never replace its text. Disabled rules are left out.
 */
export function effectiveRules({ projectDir = null, dir = RULES_DIR } = {}) {
  const own = projectDir ? path.join(projectDir, 'rules', 'slop') : null, has = own && existsS(own);
  const rules = [...loadRules(dir), ...(has ? jsonNames(own, /^P-.*\.json$/).map(f => {
    const r = readRule(path.join(own, f));
    if (r.id !== f.slice(0, -5) || !PROJECT_KINDS.includes(r.kind)) throw new Error(`${f}: a project rule's id is its file name (P-...) and its kind one of ${PROJECT_KINDS.join(', ')}`);
    return r;
  }) : [])];
  const of = new Map(rules.map(r => [r.id, r]));
  const over = has ? readText(path.join(own, 'overrides.json')) : null;
  if (over !== null) {
    for (const [id, p] of Object.entries(JSON.parse(over))) {
      const r = of.get(id), bad = Object.keys(p).filter(k => !['enabled', 'level', 'shadow', 'params'].includes(k));
      if (!r) throw new Error(`overrides.json: no rule ${id}`);
      if (bad.length) throw new Error(`overrides.json ${id}: only enabled, level, shadow and params may change (not ${bad.join(', ')})`);
      const badP = Object.keys(p.params || {}).filter(k => !KIND_PARAMS[r.kind].includes(k));
      if (badP.length) throw new Error(`overrides.json ${id}: ${r.kind} takes the params ${KIND_PARAMS[r.kind].join(', ') || '(none)'} (not ${badP.join(', ')})`);
      if (p.level !== undefined && !LEVELS.includes(p.level)) throw new Error(`overrides.json ${id}: level is one of ${LEVELS.join(' | ')}`);
      of.set(id, { ...r, ...p.params, ...(p.level ? { level: p.level } : {}), ...('shadow' in p ? { shadow: !!p.shadow } : {}), ...('enabled' in p ? { enabled: !!p.enabled } : {}) });
    }
  }
  return [...of.values()].filter(r => r.enabled !== false);
}

/** the rule-set hash every stored check carries (audit 6): an edited rule (its text or its `rev`) makes "checked clean at head X" stale */
export const rulesHash = (rules = loadRules()) => crypto.createHash('sha256').update(JSON.stringify([...rules].sort((a, b) => (a.id < b.id ? -1 : 1)))).digest('hex').slice(0, 16);

let shipped = null;
/** a rule's { what, why, fix }: a built-in, or a project's own P-* rule read from its file (projectDir); null = no such rule */
export function explainOf(id, projectDir = null) {
  if (!String(id).startsWith('P-')) return (shipped ||= new Map(loadRules().map(r => [r.id, r.explain]))).get(id) ?? null;
  const f = projectDir && path.join(projectDir, 'rules', 'slop', `${id}.json`);
  return f && existsS(f) ? readRule(f).explain : null;
}

// ---------- git ----------
export function gitRun(cwd, args, { input, ok = [0], buffer = false } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: buffer ? null : 'utf8', maxBuffer: 1 << 29, windowsHide: true, timeout: 120000 });
  if (r.error) throw r.error;
  if (!ok.includes(r.status)) throw new Error(`git ${args.join(' ')}: ${String(r.stderr).trim()}`);
  return r.stdout;
}
/** the texts of many `rev:path` blobs in ONE git cat-file --batch (null = missing) */
export function blobs(repo, specs) {
  if (!specs.length) return [];
  const buf = gitRun(repo, ['cat-file', '--batch'], { input: specs.join('\n') + '\n', buffer: true });
  const out = [];
  for (let i = 0; i < buf.length;) {
    const nl = buf.indexOf(10, i), head = buf.subarray(i, nl).toString();
    if (head.endsWith(' missing')) { out.push(null); i = nl + 1; continue; }
    const size = Number(head.split(' ')[2]);
    out.push(buf.subarray(nl + 1, nl + 1 + size).toString('utf8'));
    i = nl + 1 + size + 1;
  }
  return out;
}
/** the diff's entries: { status A|M|D|R|C|T, path (head), old (base) } with rename detection */
export function diffEntries(repo, base, head) {
  const parts = gitRun(repo, ['diff', '--name-status', '-M', '-z', base, head]).split('\0');
  const out = [];
  for (let i = 0; i < parts.length - 1;) {
    const st = parts[i++][0];
    if (st === 'R' || st === 'C') { const old = parts[i++], p = parts[i++]; out.push({ status: st, path: p, old }); }
    else { const p = parts[i++]; out.push({ status: st, path: p, old: st === 'A' ? null : p }); }
  }
  return out;
}
// an absolute path -> its path in the repo (relative to any worktree of it: the main checkout or a lane's), or null (outside the repo)
function repoPath(repo) {
  const norm = p => { let r; try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); } return r.replace(/\\/g, '/').replace(/\/+$/, ''); };   // a short (8.3) or linked spelling
  const ci = s => (process.platform === 'win32' ? s.toLowerCase() : s);
  const roots = gitRun(repo, ['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).map(l => ci(norm(l.slice(9))) + '/');
  return src => { if (!path.isAbsolute(src)) return src; const k = norm(src), r = roots.find(x => ci(k).startsWith(x)); return r ? k.slice(r.length) : null; };   // a relative source is a repo path
}
const treeFiles = (repo, rev) => gitRun(repo, ['ls-tree', '-r', '-z', '--name-only', rev]).split('\0').filter(Boolean);
export const matchAny = (globs = [], f) => globs.some(g => globToRe(g).test(f));

// ---------- fingerprints ----------
export const fingerprint = (rule, file, snippet) => crypto.createHash('sha256').update(`${rule}\0${file}\0${norm(snippet)}`).digest('hex').slice(0, 16);

// ---------- detectors: (rule, ctx) -> { head: [finding], base: [finding] | null } (base null = the tool's output is new by itself) ----------
// finding = { file, line, msg, snippet, level? (this finding's own level), value?, token? (key: match) }
const content = (rule, ctx, fn) => {
  const files = ctx.entries.filter(e => e.status !== 'D' && ctx.inFiles(rule, e.path));
  const scan = (side, key) => files.flatMap(e => { const t = ctx.text(side, e[key]); return t === null ? [] : fn(t, e.path); });
  return { head: scan('head', 'path'), base: scan('base', 'old') };
};

function swallows(rule, text, file) {
  const out = [];
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{|\.catch\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*\{/g;
  for (let m; (m = re.exec(text));) {
    // a catch inside a one-line string (a test's fixture text) is no code: an odd count of one quote kind before it on its line
    const before = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index).replace(/\\./g, '');
    if (["'", '"', '`'].some(q => before.split(q).length % 2 === 0)) continue;
    let i = m.index + m[0].length;
    const comments = [];
    for (;;) {   // skip whitespace and comments: the body is "empty" when the next real character closes it
      while (/\s/.test(text[i] || '')) i++;
      if (text.startsWith('//', i)) { const e = text.indexOf('\n', i); comments.push(text.slice(i + 2, e < 0 ? undefined : e)); i = e < 0 ? text.length : e; }
      else if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); comments.push(text.slice(i + 2, e)); i = e < 0 ? text.length : e + 2; }
      else break;
    }
    if (text[i] !== '}') continue;
    const { why, ok } = isReason(comments.join(' '), rule.deny);
    if (ok) continue;
    out.push({ file, line: lineAt(text, m.index), msg: why ? `catch with no reason (${JSON.stringify(why)} does not say what happens next)` : 'empty catch: say what happens next, or let it throw',
      snippet: text.slice(m.index, i + 1) });
  }
  return out;
}

// RM-45: `in` (code | comment | string: the other classes blanked), `unless` (a line that also matches is no finding), `cite`
// (K22: the line must name a record id that resolves to an open item), `key: match` (the matched token, capture 1 or all)
function patterns(rule, text, file, ctx) {
  const seen = rule.in ? masked(text, rule.in, file) : text, unless = rule.unless && new RegExp(rule.unless);
  return rule.patterns.flatMap(p => [...seen.matchAll(new RegExp(p, 'g'))].flatMap(m => {
    const line = lineAt(seen, m.index), lt = lineText(text, line);
    if (unless?.test(lt)) return [];
    if (rule.cite) {
      const ids = lt.match(new RegExp(rule.cite.id, 'g')) || [], state = id => ctx.resolve?.(id);
      if (ids.length && ids.every(id => !ctx.resolve || rule.cite.open.includes(state(id)))) return [];
      return [{ file, line, msg: `${rule.title}${ids.length ? `: ${ids.map(id => `${id} is ${state(id) || 'unknown'}`).join(', ')}` : ''}`, snippet: lt }];
    }
    return [{ file, line, msg: rule.title, snippet: lt, ...(rule.key === 'match' ? { token: m[1] ?? m[0] } : {}) }];
  }));
}

// RM-9 (DIR-2, the CLAUDE.md rule on old names kept alive): K16. The rule's patterns line by line, plus every page whose label does not
// name its id (a page has ONE name: label, id and URL). One finding a line, the first pattern's; each message ends with the rule's fix.
const stem = t => (t.length > 3 ? t.replace(/s$/, '') : t);
const prefix = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
/** the label names the id: a part of the id (split on - and _, a plural s dropped) is in the label's letters, or starts like a label
 *  word (4 letters, or the whole part: notify ~ Notifications) */
export const labelNamesId = (id, label) => {
  const low = label.toLowerCase(), l = low.replace(/[^a-z0-9]/g, ''), words = low.split(/[^a-z0-9]+/).filter(Boolean);
  return id.toLowerCase().split(/[-_]/).filter(Boolean).some(t => l.includes(stem(t)) || words.some(w => prefix(w, t) >= Math.min(4, t.length)));
};
const PAIR_RE = /\[\s*(['"])([\w-]+)\1\s*,\s*(['"])([^'"\n]*)\3/y, OBJ_RE = /\{\s*id\s*:\s*(['"])([\w-]+)\1\s*,\s*label\s*:\s*(['"])([^'"\n]*)\3/g;
/** [index, id, label] of each page: { id, label } objects, and the direct [id, label, ...] elements of a list the rule's `pages` names */
function pagesOf(rule, text) {
  const out = [...text.matchAll(OBJ_RE)].map(m => [m.index, m[2], m[4]]);
  for (const m of text.matchAll(new RegExp(rule.pages, 'g'))) {
    let depth = 0, q = null;
    for (let i = m.index + m[0].length - 1; i < text.length; i++) {   // from the list's [ to its matching ]; quotes skipped
      const c = text[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') q = c;
      else if (c === '[') { if (++depth === 2) { PAIR_RE.lastIndex = i; const p = PAIR_RE.exec(text); if (p) out.push([i, p[2], p[4]]); } }
      else if (c === ']' && --depth === 0) break;
    }
  }
  return out;
}
export function shimFindings(rule, text, file) {
  const byLine = new Map(), fix = rule.fix;
  const add = (i, msg) => { const line = lineAt(text, i); if (!byLine.has(line)) byLine.set(line, { file, line, msg: `${msg}: ${fix}`, snippet: lineText(text, line) }); };
  for (const p of rule.patterns) for (const m of text.matchAll(new RegExp(p.re, 'g' + (p.flags || '')))) add(m.index, p.msg);
  for (const [i, id, label] of pagesOf(rule, text)) if (!labelNamesId(id, label)) add(i, `page label '${label}' does not name its id '${id}' (a page has one name: label, id and URL)`);
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

// static `import ... from 'x'` / `export ... from 'x'` / `import 'x'` (a dynamic import() is no load-order edge)
const IMPORT_RE = /^\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
function importGraph(rule, ctx, side) {
  const files = ctx.tree(side).filter(f => rule.roots.some(r => f.startsWith(r)) && matchAny(rule.files, f));
  const texts = ctx.texts(side, files), set = new Set(files), edges = new Map();
  files.forEach((f, k) => {
    const out = [];
    for (const m of (texts[k] || '').matchAll(IMPORT_RE)) {
      if (!m[1].startsWith('.')) continue;
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (set.has(to)) out.push({ to, line: lineAt(texts[k], m.index + m[0].indexOf(m[1])), text: norm(m[0]) });
    }
    edges.set(f, out);
  });
  return edges;
}
// Tarjan's strongly connected components; a component of 2+ files (or a self-import) is a cycle
function cycles(edges) {
  let n = 0; const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = [];
  const visit = v => {
    idx.set(v, n); low.set(v, n); n++; stack.push(v); on.add(v);
    for (const { to } of edges.get(v) || []) {
      if (!idx.has(to)) { visit(to); low.set(v, Math.min(low.get(v), low.get(to))); }
      else if (on.has(to)) low.set(v, Math.min(low.get(v), idx.get(to)));
    }
    if (low.get(v) === idx.get(v)) {
      const c = []; let w;
      do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1 || (edges.get(v) || []).some(e => e.to === v)) out.push(c.sort());
    }
  };
  for (const v of edges.keys()) if (!idx.has(v)) visit(v);
  return out;
}
function layering(rule, ctx, side) {
  const edges = importGraph(rule, ctx, side), out = [];
  for (const [f, es] of edges) for (const e of es) for (const fb of rule.forbid) {
    if (matchAny([fb.from], f) && matchAny(fb.to, e.to)) out.push({ file: f, line: e.line, msg: `${f} must not import ${e.to} (${fb.from} -> ${fb.to.join(' | ')})`, snippet: e.text });
  }
  for (const c of cycles(edges)) out.push({ file: c[0], line: 1, msg: `import cycle: ${c.join(' -> ')}`, snippet: 'cycle ' + c.join(' ') });
  return out;
}

const DETECT = {
  'diff-check': (rule, ctx) => {
    const out = gitRun(ctx.repo, ['diff', '--check', ctx.base, ctx.head], { ok: [0, 2] }).split('\n'), head = [];
    for (let i = 0; i < out.length; i++) {
      const m = /^(.+?):(\d+): (.+?)\.?$/.exec(out[i]);
      if (m) head.push({ file: m[1], line: Number(m[2]), msg: m[3], snippet: (out[i + 1] || '').replace(/^\+/, '') + ' ' + m[3] });
    }
    return { head, base: null };
  },
  swallow: (rule, ctx) => content(rule, ctx, (t, f) => swallows(rule, t, f)),
  pattern: (rule, ctx) => content(rule, ctx, (t, f) => patterns(rule, t, f, ctx)),
  shim: (rule, ctx) => content(rule, ctx, (t, f) => shimFindings(rule, t, f)),
  eslint: lint,
  ast: lint,
  dup,
  exports: exportsKind,
  refs,
  model,
  // K10 (roots + forbid: layers and cycles) and K20 (bare / manifests / vendor: the dependency lock), each part when its params are set
  imports: (rule, ctx) => {
    const touched = rule.roots && ctx.entries.some(e => rule.roots.some(r => (e.path || '').startsWith(r) || (e.old || '').startsWith(r)));
    const lay = touched ? { head: layering(rule, ctx, 'head'), base: layering(rule, ctx, 'base') } : { head: [], base: [] };
    const dep = rule.bare || rule.manifests || rule.vendor ? depLock(rule, ctx) : { head: [], base: [] };
    return { head: [...lay.head, ...dep.head], base: [...lay.base, ...dep.base] };
  },
  // the program's output says nothing about the diff by itself (K14: the machine's generated files): a line counts only when the
  // source it names (the `source` group) is a file the diff touches - drift no branch made never holds one (audit D3)
  command: (rule, ctx) => {
    const raw = ctx.tool(rule, 'head', { dir: ctx.repo });
    if (raw === null) return { head: [], base: null };
    const touched = new Set(ctx.entries.flatMap(e => [e.path, e.old]).filter(Boolean)), rel = repoPath(ctx.repo);
    return { head: raw.split(/\r?\n/).flatMap(l => {
      const m = new RegExp(rule.line).exec(l);
      return m && touched.has(rel(m.groups.source)) ? [{ file: m.groups.file, line: 0, msg: m.groups.msg, snippet: l }] : [];
    }), base: null };
  },
  junk: (rule, ctx) => {
    const added = ctx.entries.filter(e => ['A', 'R', 'C'].includes(e.status) && !matchAny(rule.allow, e.path));
    const binary = new Set(gitRun(ctx.repo, ['diff', '--numstat', '-z', '-M', ctx.base, ctx.head]).split('\0').filter(l => /^-\t-\t/.test(l)).map(l => l.slice(4)).filter(Boolean));
    const head = [];
    for (const e of added) {
      const pat = rule.patterns.find(p => new RegExp(p).test(e.path));
      if (pat) { head.push({ file: e.path, line: 0, msg: `junk name (${pat})`, snippet: e.path }); continue; }
      if (binary.has(e.path)) {
        const size = Number(gitRun(ctx.repo, ['cat-file', '-s', `${ctx.head}:${e.path}`]).trim());
        if (size > rule.max_bytes) head.push({ file: e.path, line: 0, msg: `binary of ${(size / 1048576).toFixed(1)} MB (over ${rule.max_bytes / 1048576} MB)`, snippet: e.path });
      }
    }
    return { head, base: null };
  },
};

/**
 * The new-only step of one rule: its head findings against its base findings -> [result finding]. A head finding is new when the
 * base had fewer of its fingerprint (rule + file, the base path carried through renames, + normalised snippet). key: match
 * (RM-45) fingerprints the matched token tree-wide instead: one finding per token, new only when inBase(token) is false (the token
 * was absent from the whole base tree). A head finding paired with a base one carries the base's value as base_value; a
 * shadow rule's findings are marked shadow (recorded, never held); a model rule's are marked voice (the Guard's thumbs rate them).
 */
export function pairFindings(rule, got, { renamed = new Map(), inBase = () => false } = {}) {
  // got.head null: the tool had no output for head (nothing to report)
  const out = [], one = (f, fp, isNew, base) => out.push({ rule: rule.id, level: f.level || rule.level, file: f.file, line: f.line, msg: f.msg,
    snippet: norm(f.snippet).slice(0, 200), fp, new: isNew, ...(f.value !== undefined ? { value: f.value } : {}),
    ...(base?.value !== undefined ? { base_value: base.value } : {}), ...(f.token !== undefined ? { token: f.token } : {}), ...(rule.shadow ? { shadow: true } : {}), ...(rule.kind === 'model' ? { voice: true } : {}) });
  if (rule.key === 'match') {
    const seen = new Set();
    for (const f of got.head || []) if (!seen.has(f.token)) { seen.add(f.token); one(f, fingerprint(rule.id, '*', f.token), !inBase(f.token)); }
    return out;
  }
  const left = new Map();
  for (const f of got.base || []) { const fp = fingerprint(rule.id, renamed.get(f.file) || f.file, f.snippet); (left.get(fp) || left.set(fp, []).get(fp)).push(f); }
  for (const f of got.head || []) { const fp = fingerprint(rule.id, f.file, f.snippet), b = left.get(fp)?.shift(); one(f, fp, !b, b); }
  return out;
}

/** the pathspecs of a rule's file globs (git's glob magic), its excludes as exclude magic */
const pathspecs = rule => [...(rule.files || ['**']).map(g => `:(glob)${g}`), ...(rule.exclude || []).map(g => `:(glob,exclude)${g}`)];

/**
 * slopCheck({ repo, base, head = 'HEAD', rules, only: [rule ids], tool, resolve, brief, machine }) -> the ONE result:
 * { base, head, at, findings: [{ rule, level, file, line, msg, snippet, fp, new, value?, base_value?, token?, shadow?, voice? }],
 *   blocks: [the new BLOCK findings of rules not in shadow], ran: [ids], files: [the paths the diff changes] }
 * base / head are any revisions (base = the merge base the caller chose). tool(rule, side, { dir, files }) -> raw output | null.
 * resolve(record id) -> its state | null: K22's cited ids (no resolver: an id only has to be named). brief: the run's brief text (the
 * model rules read its Scope and numbered items). The model rules run last: they read the other rules' new findings (their hits).
 * machine false: a rule flagged `machine` in its data (it reads this machine's state, K14) is not run - CI and a landing's after-check
 * have no such state to read. A rule whose detector throws is a finding of its own (couldNotRun): no check passes by not checking.
 */
export function slopCheck({ repo, base, head = 'HEAD', rules = loadRules(), only = null, tool = runTool, resolve = null, brief = null, machine = true, now = Date.now() }) {
  const sha = r => gitRun(repo, ['rev-parse', '--verify', r + '^{commit}']).trim();
  const B = sha(base), H = sha(head);
  const entries = diffEntries(repo, B, H), picked = rules.filter(r => !only || only.includes(r.id)), run = [...picked.filter(r => r.kind !== 'model'), ...picked.filter(r => r.kind === 'model')];
  const rev = s => (s === 'head' ? H : B), cache = new Map(), trees = {};
  const grep = (s, args, spec) => gitRun(repo, ['grep', '-I', ...args, rev(s), '--', ...spec], { ok: [0, 1] }).split('\n').filter(Boolean);
  const findings = [], ran = [];
  const ctx = { repo, base: B, head: H, entries, tool, resolve, brief, found: findings, lintRules: run.filter(r => r.kind === 'eslint' || r.kind === 'ast'), modelRules: run.filter(r => r.kind === 'model'),
    diff: (files, exclude) => gitRun(repo, ['-c', 'core.quotepath=off', 'diff', '-U3', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '-M', B, H, '--', ...pathspecs({ files, exclude })]),
    texts: (s, files) => {
      const want = files.filter(f => !cache.has(`${s}:${f}`));
      blobs(repo, want.map(f => `${rev(s)}:${f}`)).forEach((t, k) => cache.set(`${s}:${want[k]}`, t));
      return files.map(f => cache.get(`${s}:${f}`));
    },
    text: (s, f) => (f ? ctx.texts(s, [f])[0] : null),
    tree: s => (trees[s] ||= treeFiles(repo, rev(s))),
    match: matchAny,
    inFiles: (rule, f) => matchAny(rule.files || ['**'], f) && !matchAny(rule.exclude, f),
    // name -> [files] of whole-word uses of the names under the pathspecs (one git grep)
    grepWords: (s, names, spec) => {
      const by = new Map();
      for (const l of grep(s, ['-o', '-w', '-F', ...names.flatMap(n => ['-e', n])], spec)) {
        const rest = l.slice(rev(s).length + 1), i = rest.lastIndexOf(':'), f = rest.slice(0, i), n = rest.slice(i + 1);
        if (!(by.get(n) || by.set(n, []).get(n)).includes(f)) by.get(n).push(f);
      }
      return by;
    },
    grepLines: (s, re, spec) => grep(s, ['-h', '-o', '-E', '-e', re], spec),
  };
  const renamed = new Map(entries.filter(e => e.old && e.old !== e.path).map(e => [e.old, e.path]));
  for (const rule of run) {
    if (rule.machine && !machine) continue;
    let got;
    try { got = DETECT[rule.kind](rule, ctx); } catch (e) { findings.push(couldNotRun(rule, e.message.split('\n')[0])); continue; }
    ran.push(rule.id);
    const inBase = token => grep('base', ['-l', '-F', '-w', '-e', token], pathspecs(rule)).length > 0;
    findings.push(...pairFindings(rule, got, { renamed, inBase }).filter(f => !(rule.key === 'match' && f.new && allowedToken(rule, f.token, ctx))));
  }
  return { base: B, head: H, hash: rulesHash(rules), at: new Date(now).toISOString(), findings, blocks: findings.filter(f => f.new && f.level === 'BLOCK' && !f.shadow), ran, files: entries.map(e => e.path) };
}
// SPEC 3.4: a rule that could not run is a finding of that rule, so holds, resumes, the doors and waivers treat it as any other: BLOCK,
// except the model voice, which is advisory (WARN: "not read", never a hold)
export const couldNotRun = (rule, why) => ({ rule: rule.id, level: rule.kind === 'model' ? 'WARN' : 'BLOCK', file: '*', line: 0, msg: `could not run: ${why}`,
  snippet: 'could-not-run', fp: fingerprint(rule.id, '*', 'could-not-run'), new: true, unrun: true, ...(rule.shadow ? { shadow: true } : {}) });
// key: match + allow { token (regex), listed_in (a file at head) }: a new token that follows the naming rule and is listed there passes (K21)
const allowedToken = (rule, token, ctx) => !!rule.allow && new RegExp(rule.allow.token).test(token) && (ctx.text('head', rule.allow.listed_in) || '').includes(token);
