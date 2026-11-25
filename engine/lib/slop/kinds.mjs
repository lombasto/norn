// SloppaChoppa stage C (RM-45; audit REPORT sec. 3 rows 1, 3, 4, 7 and sec. 6): the engine-only detectors - dup (K9), exports
// (K4), refs (R2), the dependency lock of `imports` (K20), companion (K27) - and the ONE ESLint run behind the kinds lint and ast. Each is
// (rule, ctx) -> { head: [finding], base: [finding] | null } as check.mjs's DETECT table; ctx carries git, the texts, the trees
// and the file filter, so this module imports nothing of check.mjs.
import path from 'node:path';
import { PARSE } from './tools.mjs';
import { LINTERS } from './lang/index.mjs';
import { readSignals } from '../codesignals.mjs';
import { CODE, classify, commentsIn, exportsOf, helpers, isJs, isReason, lineAt, lineText, masked, norm, usesOf } from './scan.mjs';

const SIDE_KEY = { head: 'path', base: 'old' };
/** the diff's entries a rule reads on one side: [{ e, file (that side's path), text }] */
function sideFiles(rule, ctx, side, keep = () => true) {
  const key = SIDE_KEY[side], es = ctx.entries.filter(e => e.status !== 'D' && e[key] && ctx.inFiles(rule, e.path) && keep(e));
  const texts = ctx.texts(side, es.map(e => e[key]));
  return es.map((e, k) => ({ e, file: e[key], text: texts[k] })).filter(x => x.text !== null && x.text !== undefined);
}
const both = fn => ({ head: fn('head'), base: fn('base') });

// ---------- lint + ast: one run per tool and side over the touched files of every such rule of the check ----------
function lintSide(ctx, side, tool) {
  const memo = ((ctx.lint ||= {})[tool] ||= {});
  if (side in memo) { if (memo[side] instanceof Error) throw memo[side]; return memo[side]; }
  try {
    const rules = ctx.lintRules.filter(r => r.tool === tool), texts = new Map(), held = rules.filter(r => r.kind === 'lint'), cfg = held.find(r => r.config)?.config, t = LINTERS[tool];
    for (const r of rules) for (const x of sideFiles(r, ctx, side)) texts.set(x.e.path, x.text);
    if (!texts.size) return (memo[side] = new Map());
    // SPEC 3.1: both sides lint under the repo config of the MERGE BASE (a branch cannot weaken the gate nor run code in it)
    const id = rules.map(r => r.id).join('+'), run = tool === 'eslint' ? { id, kind: 'lint', tool, rules: Object.assign({}, ...held.map(r => r.rules)), config: ctx.config ?? (cfg ? ctx.text('base', cfg) : null),
      selectors: rules.filter(r => r.kind === 'ast').flatMap(r => r.selectors.map(s => ({ selector: s.selector, message: `${r.id}: ${s.message}` }))) }
      : { id, kind: 'lint', tool, git: ctx.gitDir(), head: ctx.head, log: held.find(r => r.log)?.log, configs: t.configs?.([...texts.keys()], ctx.tree('base'), f => ctx.text('base', f)) };
    const raw = ctx.tool(run, side, { texts, dir: ctx.repo }), by = new Map();
    if (raw === null) return (memo[side] = null);
    for (const x of t.parse(raw, [...texts.keys()])) if (texts.has(x.file)) (by.get(x.file) || by.set(x.file, []).get(x.file)).push(x);
    return (memo[side] = by);
  } catch (e) { memo[side] = e; throw e; }
}
/** the source text of a reported node (ESLint: 1-based lines and columns, the end column exclusive) */
function nodeText(text, x) {
  const lines = text.split('\n'), at = (l, c) => lines.slice(0, l - 1).reduce((a, s) => a + s.length + 1, 0) + c - 1;
  return text.slice(at(x.line, x.column), at(x.endLine, x.endColumn));
}
function astHit(rule, x, text) {
  const sel = x.rule === 'no-restricted-syntax' && rule.selectors.find(s => x.msg === `${rule.id}: ${s.message}`);
  if (!sel) return null;
  const src = nodeText(text, x);
  if (sel.text && !new RegExp(sel.text).test(src)) return null;
  if (rule.reason && isReason(commentsIn(text, x.line, x.endLine), rule.reason).ok) return null;   // K2's test: the comment says what happens next
  if (rule.key !== 'match') return { msg: sel.message };
  const m = new RegExp(rule.token || '[\\s\\S]+').exec(src);
  return m && { msg: sel.message, token: m[1] ?? m[0] };
}
/** a lint rule's sub-rule -> { sub, level, shadow }: levels by name, `*` for the rest; shadow_rules by name, `*` = every one levels does not name */
const subLevel = (rule, sub) => ({ sub, level: rule.levels?.[sub] ?? rule.levels?.['*'] ?? rule.level,
  shadow: (rule.shadow_rules || []).includes(sub) || (!(sub in (rule.levels || {})) && (rule.shadow_rules || []).includes('*')) });
export function lint(rule, ctx) {
  const got = both(side => {
    const by = lintSide(ctx, side, rule.tool);
    // a tool read from the head's log (clippy): no log is no evidence - a WARN, not a pass and not a hold (CI still gates it)
    if (by === null) return side === 'head' && rule.source === 'log' ? [{ file: '*', line: 0, snippet: 'no-evidence', msg: `no ${rule.tool} evidence for this head (no log at ${rule.log.join(', ')})`, ...subLevel(rule, 'no-evidence') }] : null;
    return sideFiles(rule, ctx, side).flatMap(({ e, text }) => (by.get(e.path) || []).flatMap(x => {
      // a file that does not parse has no lint findings: it is ONE BLOCK, of the first held lint rule that reads it (SPEC 1.3 F6, 3.4: LJ/parse)
      const f = x.rule === PARSE ? (ctx.lintRules.find(r => !r.shadow && ctx.inFiles(r, e.path)) === rule ? { msg: `does not parse: ${x.msg}`, level: 'BLOCK', ...(rule.kind === 'lint' ? { sub: PARSE } : {}) } : null)
        : rule.kind === 'lint' ? (x.rule === 'no-restricted-syntax' ? null : { msg: x.msg, ...subLevel(rule, x.rule) }) : astHit(rule, x, text);
      return f ? [{ file: e.path, line: x.line, snippet: lineText(text, x.line) + ' ' + x.msg, ...f }] : [];
    }));
  });
  // SPEC 3.1 / Q12: an edit to the lint config is a finding of its own; the waiver is the owner approving the rule change
  // (ESLint: the rule's config file; ruff: a [tool.ruff] table or ruff.toml; clippy: clippy.toml or a [lints] table - not the rest of the file)
  const cfgOf = (side, f) => (f ? LINTERS[rule.tool].configOf(rule, f, () => ctx.text(side, f)) ?? null : null);
  if (rule.kind === 'lint' && got.head) for (const e of ctx.entries) if (cfgOf('base', e.old) !== cfgOf('head', e.status === 'D' ? null : e.path))
    got.head.push({ file: e.path, line: 0, snippet: 'config-changed', msg: `${e.path} changed: the check lints with the merge base's config; the owner approves a rule change (a waiver)`, ...subLevel(rule, 'config-changed') });
  return got;
}

// ---------- dup (K9): a new one-statement helper whose body another module of the same group already has ----------
export function dup(rule, ctx) {
  const min = rule.min_chars ?? 20, inRoots = f => rule.roots.some(r => f.startsWith(r));
  const group = f => (rule.groups || []).findIndex(g => ctx.match(g, f));
  return both(side => {
    const mine = sideFiles(rule, ctx, side, e => inRoots(e.path));
    if (!mine.length) return [];
    const pool = ctx.tree(side).filter(f => inRoots(f) && ctx.inFiles(rule, f)), texts = ctx.texts(side, pool), bodies = new Map();
    pool.forEach((f, k) => { for (const h of helpers(texts[k] || '')) if (h.body.length >= min) (bodies.get(h.body) || bodies.set(h.body, []).get(h.body)).push({ file: f, name: h.name }); });
    return mine.flatMap(({ e, file, text }) => helpers(text).filter(h => h.body.length >= min).flatMap(h => {
      const others = (bodies.get(h.body) || []).filter(o => o.file !== file && group(o.file) === group(file));
      return others.length ? [{ file: e.path, line: h.line, value: others.length, snippet: `${h.name} = ${h.body}`,
        msg: `${h.name} is a copy of ${others[0].name} in ${others[0].file}${others.length > 1 ? ` (+${others.length - 1} more)` : ''}: import that one` }] : [];
    }));
  });
}

// ---------- exports (K4): a new export nobody references (BLOCK) or only tests reference (tests_level) ----------
export function exportsKind(rule, ctx) {
  return both(side => {
    const mine = sideFiles(rule, ctx, side, e => rule.roots.some(r => e.path.startsWith(r)));
    const cands = mine.flatMap(({ e, file, text }) => exportsOf(text).filter(x => usesOf(text, x.name) < 2   // used in its own file: no finding
      && !(rule.entry || []).some(n => n === x.name || n === `${e.path}:${x.name}`)).map(x => ({ ...x, e, file })));
    if (!cands.length) return [];
    const users = ctx.grepWords(side, [...new Set(cands.map(c => c.name))], rule.search);
    return cands.flatMap(({ name, line, e, file }) => {
      const others = (users.get(name) || []).filter(f => f !== file);
      if (!others.length) return [{ file: e.path, line, snippet: `export ${name}`, msg: `export ${name} is referenced nowhere: delete it (an entry loaded by path goes in the rule's entry list)` }];
      if (others.every(f => ctx.match(rule.tests, f))) return [{ file: e.path, line, snippet: `export ${name}`, level: rule.tests_level, msg: `export ${name} is used by tests only` }];
      return [];
    });
  });
}

// ---------- refs (R2): a `norn <verb> [<sub-verb>]` or a repo path that does not exist at that side ----------
function cliAt(rule, ctx, side) {
  const verbs = new Set([...(ctx.text(side, rule.cli) || '').matchAll(/'([a-z][a-z-]*)'/g)].map(m => m[1]));
  const subs = new Map();   // verb -> the words of its usage line, when that usage starts with a sub-verb (not a <placeholder>)
  for (const l of ctx.grepLines(side, 'usage: norn [a-z][a-z-]* [^\'"`]*', rule.usage_in)) {
    const m = /usage: norn ([a-z][a-z-]*) ([^'"`]*)/.exec(l);
    if (m && /^[a-z]/.test(m[2])) subs.set(m[1], new Set([...(subs.get(m[1]) || []), ...m[2].replace(/\[[^\]]*\]/g, ' ').match(/[a-z][a-z-]*/g)]));
  }
  return { verbs, subs };
}
const PATH_TOKEN = /^(?:\.{1,2}\/)*[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,8}$/;
export function refs(rule, ctx) {
  return both(side => {
    const mine = sideFiles(rule, ctx, side);
    if (!mine.length) return [];
    const { verbs, subs } = cliAt(rule, ctx, side), tree = new Set(ctx.tree(side)), tops = new Set([...tree].map(f => f.split('/')[0]));
    return mine.flatMap(({ e, file, text }) => {
      const out = [], md = !isJs(file), hit = (i, msg, snippet) => out.push({ file: e.path, line: lineAt(text, i), msg, snippet });
      // commands: a doc's `code spans`; a JS file's strings (UI text, prompts). After an article it is prose ("not a norn command"), not a call
      const spans = md ? [...text.matchAll(/`([^`\n]+)`/g)].map(m => [m.index + 1, m[1]]) : [[0, masked(text, ['string'], file)]];
      for (const [at, s] of spans) for (const m of s.matchAll(/(?<![\w/-])(?<!\b(?:a|an|the|no|every|one) )norn ([a-z][a-z-]*)(?: ([a-z][a-z-]*)(?![\w-]))?/g)) {
        if (!verbs.has(m[1])) hit(at + m.index, `\`norn ${m[1]}\` is not a norn command`, `norn ${m[1]}`);
        else if (m[2] && subs.has(m[1]) && !subs.get(m[1]).has(m[2])) hit(at + m.index, `\`norn ${m[1]} ${m[2]}\` is not a norn command (usage: norn ${m[1]} ${[...subs.get(m[1])].slice(0, 8).join(' | ')} ...)`, `norn ${m[1]} ${m[2]}`);
      }
      // paths: a doc's code spans and relative links, under a top-level folder of the tree (or relative to the doc)
      if (md) for (const m of text.matchAll(/`([^`\s]+)`|\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const t = (m[1] || m[2]).replace(/:\d+(?::\d+)?$/, '');
        if (!PATH_TOKEN.test(t) || /^[a-z]+:/i.test(t)) continue;
        const near = path.posix.normalize(path.posix.join(path.posix.dirname(file), t));
        if (!tops.has(t.split('/')[0]) && !tops.has(near.split('/')[0])) continue;
        if (!tree.has(t) && !tree.has(near)) hit(m.index, `${t} does not exist`, `path ${t}`);
      }
      return out;
    });
  });
}

// ---------- imports, the dependency lock (K20): a bare import outside the allow list, a manifest or dependency line, an unlisted vendored file ----------
const SPEC_RE = /^[ \t]*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
/** the dependency entries of a manifest or lock file: package.json deps, TOML dependency sections and lock packages, one per line otherwise */
export function depsOf(file, text) {
  const base = file.split('/').pop();
  if (base === 'package.json' || base === 'package-lock.json') {
    let j; try { j = JSON.parse(text); } catch { return ['(unparsable) ' + base]; }   // a broken manifest is itself one entry: still new, still held
    const deps = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(k => Object.entries(j[k] || {}).map(([n, v]) => `${n}@${typeof v === 'string' ? v : v?.version}`));
    return [...deps, ...Object.entries(j.packages || {}).filter(([k]) => k).map(([k, v]) => `${k.replace(/^.*node_modules\//, '')}@${v.version}`)];
  }
  const lines = text.split(/\r?\n/), out = [];
  if (/\.toml$|\.lock$/.test(base) && !/^yarn\.lock$/.test(base)) {
    let sec = '', pkg = null, list = false;   // list: inside a `dependencies = [ ... ]` array (pyproject)
    for (const l of lines) {
      const h = !list && /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(l);
      if (h) { sec = h[1].trim(); pkg = sec === 'package' ? {} : null; continue; }
      if (pkg) { const kv = /^\s*(name|version)\s*=\s*"([^"]*)"/.exec(l); if (kv) { pkg[kv[1]] = kv[2]; if (pkg.name && pkg.version) { out.push(`${pkg.name}@${pkg.version}`); pkg = {}; } } continue; }
      const open = /^\s*(?:dependencies|[\w-]*-dependencies|requires)\s*=\s*\[/.test(l);
      if (open || list) { out.push(...[...l.matchAll(/"([^"]+)"/g)].map(m => m[1])); list = (open || list) && !/\]\s*(?:#.*)?$/.test(l); }
      else if (/dependencies/.test(sec) && /^\s*[\w.-]+\s*=/.test(l)) out.push(norm(l));
    }
    return out;
  }
  return lines.map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
}
export function depLock(rule, ctx) {
  const allowed = s => s.startsWith('.') || s.startsWith('/') || (rule.bare || []).some(a => new RegExp(a).test(s));
  return both(side => {
    const out = [];
    if (rule.bare) for (const { e, text } of sideFiles(rule, ctx, side, e => isJs(e.path) && !ctx.match(rule.vendor?.dirs, e.path))) {   // a vendored file's own imports are the vendor row's business
      const cls = classify(text);
      for (const m of text.matchAll(SPEC_RE)) {
        const spec = m[1] ?? m[2], at = m.index + m[0].search(/\S/), quote = m.index + m[0].lastIndexOf(spec) - 1;
        if (cls[at] !== CODE || cls[quote] !== CODE || allowed(spec)) continue;   // a real import's quote mark is code; one written inside a template is not
        out.push({ file: e.path, line: lineAt(text, at), msg: `bare import '${spec}': Norn runs on Node built-ins only; a package needs the owner's approval (a waiver)`, snippet: `import '${spec}'` });
      }
    }
    const key = SIDE_KEY[side];
    if (rule.manifests) for (const { e, file, text } of sideFiles({ files: rule.manifests, exclude: rule.exclude }, ctx, side)) {
      out.push({ file: e.path, line: 0, msg: `dependency manifest ${file}: needs the owner's approval (a waiver)`, snippet: `manifest ${e.path}` });
      for (const d of depsOf(file, text)) out.push({ file: e.path, line: 0, msg: `dependency ${d} in ${file}: needs the owner's approval (a waiver)`, snippet: `dep ${d}` });
    }
    if (rule.vendor) {
      const tree = new Set(ctx.tree(side));
      for (const e of ctx.entries.filter(x => x.status !== 'D' && x[key] && ctx.match(rule.vendor.dirs, x.path) && !ctx.match(rule.exclude, x.path) && path.posix.basename(x.path) !== rule.vendor.table)) {
        let d = path.posix.dirname(e[key]), table = null;
        for (; d !== '.' && !table; d = path.posix.dirname(d)) if (tree.has(`${d}/${rule.vendor.table}`)) table = `${d}/${rule.vendor.table}`;
        const name = path.posix.basename(e[key]);
        if (!table || !(ctx.text(side, table) || '').includes(name)) out.push({ file: e.path, line: 0, msg: `vendored file ${name} has no row in ${table || rule.vendor.table}: pin it (version, source, sha256)`, snippet: `vendor ${e.path}` });
      }
    }
    return out;
  });
}

// ---------- companion (K27, RM-a-62): a changed file whose usual partner (the code signals, docs/code-signals.md) is not in the branch ----------
// Read through the contract's one reader only. The thresholds are the rule's data (min_shared, min_share: at or over the signals' own,
// which already dropped the weaker pairs); partners_exclude drops the lock and generated files a partner list carries. The base side
// has no finding: the merge base's own branch is not this one, so every finding is the branch's.
export function companion(rule, ctx) {
  if (!ctx.state) throw new Error('no project state: the code signals are read from <state>/code/signals.json');
  const s = readSignals(ctx.state);
  if (!s) throw new Error('no code signals stored yet (`norn code history` writes them)');
  const inDiff = new Set(ctx.entries.flatMap(e => [e.path, e.old]).filter(Boolean)), atHead = new Set(ctx.tree('head'));
  const head = ctx.entries.filter(e => e.status !== 'D' && ctx.inFiles(rule, e.path)).flatMap(e => {
    const x = s.files[e.path] ?? (e.old && s.files[e.old]);   // a renamed file: its history is under the old name
    return (x?.partners || []).filter(p => p.shared >= rule.min_shared && p.share >= rule.min_share && !inDiff.has(p.file) && atHead.has(p.file) && !ctx.match(rule.partners_exclude, p.file))
      .map(p => ({ file: e.path, line: 0, value: p.share, snippet: `companion ${p.file}`,
        msg: `${e.path} usually changes with ${p.file} (${p.shared} of ${x.landings} landings); ${p.file} is not in this branch (${s.basis} from git at ${s.sha})` }));
  });
  return { head, base: [] };
}
