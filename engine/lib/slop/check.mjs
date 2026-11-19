// META-SLOP-A (REVIEW-FABLE 3 + 4.1 / 4.2; SPEC 3.4): the run's diff checked against the BLOCK rules. Rules are data files
// (rules/*.json: id, level, kind, the kind's parameters, a fixture with a hit and a near-miss). Only NEW findings count: each
// finding is fingerprinted (rule + file + normalised snippet, SARIF partialFingerprints style) at head and at base, the base path
// carried through git's rename detection, and a head finding is new only when the base had fewer of that fingerprint.
// The check is pure on git: it returns ONE result object; host.mjs is the one writer (holds, reports, waivers applied).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { globToRe } from '../dlvgit.mjs';
import { runTool, parseEslint } from './tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RULES_DIR = path.join(HERE, 'rules');
export const LEVELS = ['BLOCK', 'WARN', 'TREND', 'LIST'];

export function loadRules(dir = RULES_DIR) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!r.id || !LEVELS.includes(r.level) || !DETECT[r.kind]) throw new Error(`${f}: a rule needs an id, a level (${LEVELS.join(' | ')}) and a known kind`);
    if (!r.fixture?.hit || !r.fixture?.miss) throw new Error(`${f}: a rule ships with a fixture hit and a near-miss (SPEC 3.4.5)`);
    return r;
  });
}

/** the rule-set hash every stored check carries (audit 6): an edited rule (its text or its `rev`) makes "checked clean at head X" stale */
export const rulesHash = (rules = loadRules()) => crypto.createHash('sha256').update(JSON.stringify([...rules].sort((a, b) => (a.id < b.id ? -1 : 1)))).digest('hex').slice(0, 16);

// ---------- git ----------
export function gitRun(cwd, args, { input, ok = [0], buffer = false } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: buffer ? null : 'utf8', maxBuffer: 1 << 29, windowsHide: true });
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
const norm = s => String(s).replace(/\s+/g, ' ').trim();
export const fingerprint = (rule, file, snippet) => crypto.createHash('sha256').update(`${rule}\0${file}\0${norm(snippet)}`).digest('hex').slice(0, 16);
const lineAt = (text, i) => text.slice(0, i).split('\n').length;
const lineText = (text, n) => (text.split('\n')[n - 1] ?? '');

// ---------- detectors: (rule, ctx) -> { head: [finding], base: [finding] | null } (base null = the tool's output is new by itself) ----------
// finding = { file, line, msg, snippet }
const content = (rule, ctx, fn) => {
  const files = ctx.entries.filter(e => e.status !== 'D' && matchAny(rule.files, e.path));
  const scan = (side, key) => files.flatMap(e => { const t = ctx.text(side, e[key]); return t === null ? [] : fn(t, e.path); });
  return { head: scan('head', 'path'), base: scan('base', 'old') };
};

function swallows(rule, text, file) {
  const out = [], deny = rule.deny.map(d => d.toLowerCase());
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
    const why = norm(comments.join(' ')).toLowerCase().replace(/^[\s*:.-]+|[\s.!]+$/g, '');
    const denied = deny.some(d => why === d || why.startsWith(d + ' ') || why.startsWith(d + ',') || why.startsWith(d + ':'));
    if (why.split(/\s+/).filter(Boolean).length >= 2 && !denied) continue;
    out.push({ file, line: lineAt(text, m.index), msg: why ? `catch with no reason (${JSON.stringify(why)} does not say what happens next)` : 'empty catch: say what happens next, or let it throw',
      snippet: text.slice(m.index, i + 1) });
  }
  return out;
}

function patterns(rule, text, file) {
  return rule.patterns.flatMap(p => [...text.matchAll(new RegExp(p, 'g'))].map(m => {
    const line = lineAt(text, m.index);
    return { file, line, msg: rule.title, snippet: lineText(text, line) };
  }));
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
  pattern: (rule, ctx) => content(rule, ctx, (t, f) => patterns(rule, t, f)),
  eslint: (rule, ctx) => {
    const files = ctx.entries.filter(e => e.status !== 'D' && matchAny(rule.files, e.path));
    if (!files.length) return { head: [], base: [] };
    const side = (s, key) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `slop-${rule.id}-`)), map = new Map(), names = [];
      try {
        files.forEach(e => {
          const t = e[key] && ctx.text(s, e[key]);
          if (t === null || t === undefined) return;
          fs.mkdirSync(path.dirname(path.join(dir, e.path)), { recursive: true });
          fs.writeFileSync(path.join(dir, e.path), t); map.set(e.path, e); names.push(e.path);
        });
        if (!names.length) return [];
        const raw = ctx.tool(rule, s, { dir, files: names });
        return raw === null ? null : parseEslint(raw, dir).flatMap(x => {
          const e = map.get(x.file);
          return e ? [{ file: e.path, line: x.line, msg: x.msg, snippet: lineText(ctx.text(s, e[key]), x.line) + ' ' + x.msg }] : [];
        });
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    return { head: side('head', 'path'), base: side('base', 'old') };
  },
  imports: (rule, ctx) => {
    if (!ctx.entries.some(e => rule.roots.some(r => (e.path || '').startsWith(r) || (e.old || '').startsWith(r)))) return { head: [], base: [] };
    return { head: layering(rule, ctx, 'head'), base: layering(rule, ctx, 'base') };
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
 * slopCheck({ repo, base, head = 'HEAD', rules, only: [rule ids], tool }) -> the ONE result:
 * { base, head, at, findings: [{ rule, level, file, line, msg, snippet, fp, new }], blocks: [the new BLOCK findings], ran: [ids], skipped: [{ rule, why }] }
 * base / head are any revisions (base = the merge base the caller chose). tool(rule, side, { dir, files }) -> raw output | null.
 */
export function slopCheck({ repo, base, head = 'HEAD', rules = loadRules(), only = null, tool = runTool, now = Date.now() }) {
  const sha = r => gitRun(repo, ['rev-parse', '--verify', r + '^{commit}']).trim();
  const B = sha(base), H = sha(head);
  const entries = diffEntries(repo, B, H);
  const rev = s => (s === 'head' ? H : B), cache = new Map(), trees = {};
  const ctx = { repo, base: B, head: H, entries, tool,
    texts: (s, files) => {
      const want = files.filter(f => !cache.has(`${s}:${f}`));
      blobs(repo, want.map(f => `${rev(s)}:${f}`)).forEach((t, k) => cache.set(`${s}:${want[k]}`, t));
      return files.map(f => cache.get(`${s}:${f}`));
    },
    text: (s, f) => (f ? ctx.texts(s, [f])[0] : null),
    tree: s => (trees[s] ||= treeFiles(repo, rev(s))),
  };
  const renamed = new Map(entries.filter(e => e.old && e.old !== e.path).map(e => [e.old, e.path]));
  const findings = [], ran = [], skipped = [];
  for (const rule of rules.filter(r => !only || only.includes(r.id))) {
    let got;
    try { got = DETECT[rule.kind](rule, ctx); } catch (e) { skipped.push({ rule: rule.id, why: e.message.split('\n')[0] }); continue; }
    ran.push(rule.id);
    const seen = new Map();
    for (const f of got.base || []) { const fp = fingerprint(rule.id, renamed.get(f.file) || f.file, f.snippet); seen.set(fp, (seen.get(fp) || 0) + 1); }
    for (const f of got.head) {
      const fp = fingerprint(rule.id, f.file, f.snippet), left = seen.get(fp) || 0;
      if (left) seen.set(fp, left - 1);
      findings.push({ rule: rule.id, level: rule.level, file: f.file, line: f.line, msg: f.msg, snippet: norm(f.snippet).slice(0, 200), fp, new: !left });
    }
  }
  return { base: B, head: H, hash: rulesHash(rules), at: new Date(now).toISOString(), findings, blocks: findings.filter(f => f.new && f.level === 'BLOCK'), ran, skipped };
}
