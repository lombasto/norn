// SloppaChoppa 2 S3 (SPEC 3.3, 4.5, 7 S3): the Python pack - its suppressions
// (`# noqa`, `# type: ignore`, `# pyright: ignore`), and ruff as the lint tool LP. ruff is the PROJECT's: its locked dev extra,
// run as `uv run --no-sync --project <the config's folder in the main checkout> ruff` with VIRTUAL_ENV unset (never `uv sync`),
// under the config of the MERGE BASE (the nearest pyproject.toml with [tool.ruff], or ruff.toml), on the touched files only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { which } from '../../paths.mjs';
import { lineAt, tomlTables } from '../scan.mjs';

const P = path.posix;
/** the pack's id (an ast rule's `match` key) and the ast-grep language of a file it reads (slop-langs SPEC 3.4) */
export const ID = 'py', astLang = () => 'Python';
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
    const g = (out[d] ||= { name: P.basename(c.f), text: read(c.f), files: [], mods: [] });
    g.files.push(f);
  }
  // every module under each config's folder: ruff's isort tells a first-party import by its module's FILE under `src` (ruff 0.15:
  // `from pkg.a import x` is first-party only if src/pkg/a.py exists), so the temp folder holds an empty stand-in of each
  for (const [d, g] of Object.entries(out)) g.mods = tree.filter(f => /\.pyi?$/.test(f) && (d === '.' || f.startsWith(d + '/')));
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
      for (const f of g.mods) { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), texts.get(f) ?? ''); }
      for (const f of here) { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), texts.get(f)); }   // a new module too
      fs.writeFileSync(path.join(cwd, g.name), g.text);
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
