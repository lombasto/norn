// SloppaChoppa 2 S3 (SPEC 3.3, 4.5, 7 S3): the Python pack - a module's import edges (the kind `imports`), its suppressions
// (`# noqa`, `# type: ignore`, `# pyright: ignore`), and ruff as the lint tool LP. ruff is the PROJECT's: its locked dev extra,
// run as `uv run --no-sync --project <the config's folder in the main checkout> ruff` with VIRTUAL_ENV unset (never `uv sync`),
// under the config of the MERGE BASE (the nearest pyproject.toml with [tool.ruff], or ruff.toml), on the touched files only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { which } from '../../paths.mjs';
import { lineAt, norm, tomlTables } from '../scan.mjs';

const P = path.posix;
/** dotted module name -> [files]: every module inside a package (a folder with __init__.py), named from its top package; a loose
 *  script is no import target (a stdlib name like `types` must not resolve to some scripts/types.py) */
function index(tree) {
  const has = new Set(tree), out = new Map();
  for (const f of tree) {
    if (!f.endsWith('.py')) continue;
    const segs = f.slice(0, -3).split('/');
    if (segs[segs.length - 1] === '__init__') segs.pop();
    let top = segs.length - 1;
    while (top > 0 && has.has(segs.slice(0, top).join('/') + '/__init__.py')) top--;
    const name = segs.slice(top).join('.');   // segs[0..top) is the import root: the first folder up that is no package
    if (segs.length - top >= 2 || f.endsWith('__init__.py')) (out.get(name) || out.set(name, []).get(name)).push(f);
  }
  return out;
}
const common = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
// module level only (column 0): an import inside a function or `if TYPE_CHECKING:` is no load-order edge
const IMPORT_RE = /^(?:from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#;]+)|import[ \t]+([^\n#;]+))/gm;
const names = s => s.replace(/[()\\]/g, ' ').split(',').map(x => x.trim().split(/\s+/)[0]).filter(x => /^[\w.]+$/.test(x));
/** the import edges of a module to files of the tree: [{ to, line, text }]; at.memo.py caches the module index of the side */
export function imports(file, text, at) {
  const idx = (at.memo.py ||= index(at.tree)), out = [];
  const abs = dotted => (idx.get(dotted) || []).reduce((best, f) => (!best || common(f, file) > common(best, file) ? f : best), null);
  const rel = (dir, dotted) => { const b = dotted ? `${dir}/${dotted.replace(/\./g, '/')}` : dir; return [`${b}.py`, `${b}/__init__.py`].map(x => P.normalize(x)).find(x => at.has(x)) || null; };
  for (const m of text.matchAll(IMPORT_RE)) {
    const line = lineAt(text, m.index), src = norm(m[0]), hits = [];
    if (m[4] !== undefined) hits.push(...names(m[4]).map(abs));
    else if (m[1]) {   // from .a import b: b a submodule of .a, else a name in it
      let dir = P.dirname(file); for (let i = 1; i < m[1].length; i++) dir = P.dirname(dir);
      const base = m[2] ? `${dir}/${m[2].replace(/\./g, '/')}` : dir, subs = names(m[3]).map(n => rel(base, n)).filter(Boolean);
      hits.push(...(subs.length ? subs : [rel(dir, m[2])]));
    } else { const subs = names(m[3]).map(n => abs(`${m[2]}.${n}`)).filter(Boolean); hits.push(...(subs.length ? subs : [abs(m[2])])); }
    for (const to of new Set(hits.filter(Boolean))) if (to !== file) out.push({ to, line, text: src });
  }
  return out;
}

// the reason is what follows the suppression on its line (`# noqa: F401  # re-exported for the plugin API`)
const SUPPRESS_RE = /#\s*(?:noqa\b(?::?[ \t]*[A-Z]+\d+(?:[ \t]*,[ \t]*[A-Z]+\d+)*)?|type:\s*ignore(?:\[[^\]\n]*\])?|pyright:\s*ignore(?:\[[^\]\n]*\])?)[ \t]*#?(.*)$/gm;
export const suppressions = text => [...text.matchAll(SUPPRESS_RE)].map(m => ({ line: lineAt(text, m.index), reason: m[1] }));

// ---------- ruff (LP) ----------
const RUFF_FILES = ['.ruff.toml', 'ruff.toml', 'pyproject.toml'];   // ruff's own order inside one folder
const ruffOf = (f, text) => (text == null ? null : P.basename(f) === 'pyproject.toml' ? tomlTables(text, t => /^tool\.ruff(\.|$)/.test(t)) : text);
/** the ruff config of each touched file at the merge base -> { <config folder>: { name, text, files, dirs } }; a file under no config is not ruff's */
function configs(files, tree, read) {
  const has = new Set(tree), memo = new Map(), out = {};
  const at = d => {
    if (!memo.has(d)) memo.set(d, RUFF_FILES.map(n => (d === '.' ? n : `${d}/${n}`)).filter(f => has.has(f)).map(f => ({ f, text: ruffOf(f, read(f)) })).find(x => x.text !== null) || null);
    return memo.get(d);
  };
  for (const f of files) {
    let d = P.dirname(f), c = at(d);
    while (!c && d !== '.') { d = P.dirname(d); c = at(d); }
    if (!c) continue;
    const g = (out[d] ||= { name: P.basename(c.f), text: read(c.f), files: [], dirs: [] });
    g.files.push(f);
  }
  // the folders two deep under each config's folder: ruff's isort tells first-party imports by the folders under `src`
  for (const [d, g] of Object.entries(out)) g.dirs = [...new Set(tree.filter(f => d === '.' || f.startsWith(d + '/')).map(f => (d === '.' ? f : f.slice(d.length + 1)).split('/').slice(0, -1).slice(0, 2).join('/')).filter(Boolean))];
  return out;
}
/** ruff on a side's texts: per config folder, the merge base's config and the texts in a temp folder, the project's ruff run there */
function run(rule, side, { texts, env = process.env }) {
  const uv = which('uv', { env }), main = P.basename(rule.git) === '.git' ? P.dirname(rule.git) : rule.git, all = [];
  if (!uv) throw new Error('uv not found on PATH: the project\'s ruff cannot run');
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'norn-ruff-'))), { VIRTUAL_ENV: _venv, ...clean } = env;
  try {
    for (const [d, g] of Object.entries(rule.configs)) {
      const cwd = path.join(tmp, d), here = g.files.filter(f => texts.has(f));
      if (!here.length) continue;
      for (const sub of g.dirs) fs.mkdirSync(path.join(cwd, sub), { recursive: true });
      fs.writeFileSync(path.join(cwd, g.name), g.text);
      for (const f of here) { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), texts.get(f)); }
      const r = spawnSync(uv, ['run', '--no-sync', '--project', path.join(main, d), 'ruff', 'check', '--output-format', 'json', '--no-cache', '--force-exclude', ...here.map(f => path.relative(cwd, path.join(tmp, f)))],
        { cwd, env: clean, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26, timeout: 300000 });
      if (r.error) throw r.error;
      if ((r.status !== 0 && r.status !== 1) || !r.stdout.trim()) throw new Error(`ruff exited ${r.status} in ${d}: ${String(r.stderr).trim().split('\n').slice(-2).join(' ')}`);
      all.push(...JSON.parse(r.stdout).map(x => ({ ...x, filename: path.relative(tmp, path.resolve(cwd, x.filename)).replace(/\\/g, '/') })));
    }
    return JSON.stringify(all);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
/** ruff's JSON -> [{ file, rule (parse: a syntax error), line, msg }] */
const parse = raw => JSON.parse(raw).map(x => ({ file: x.filename.replace(/\\/g, '/'), rule: x.code || 'parse', line: x.location?.row ?? 0, msg: x.message }));
export const RUFF = { run, parse, configs, doc: s => `ruff: https://docs.astral.sh/ruff/rules/ (${s})`, configOf: (rule, f, read) => (RUFF_FILES.includes(P.basename(f)) ? ruffOf(f, read()) : null) };
