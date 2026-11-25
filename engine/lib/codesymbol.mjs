// `norn code symbol <file>::<name>..` (RM-a-64): one symbol's source with its exact line range, read through the code graph's reader
// (codegraph.mjs symbols(), docs/code-graph.md "Symbols"), with the indexed commit and its age. Before any line is printed the file is
// checked against the worktree (its blob hash against the indexed commit's): unchanged = the indexed bounds (status current); changed =
// the symbol re-located from the worktree file (symbols({ worktree: true }), status relocated), else "moved since the index" with the
// file's current symbols. Never stale lines presented as current. An unknown name lists the file's symbols. No model.
// A name matches a definition's name, its qual, or the tail of its qual after '#', '.' or '::' (Shape.area, cli::Args).
// Thresholds (the one place): SYMBOL_LIMITS.lines, the most source lines one definition prints (the rest counted as +N more lines).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { symbols } from './codegraph.mjs';
import { ageOf } from './codecard.mjs';

export const SYMBOL_LIMITS = { lines: 400 };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const norm = f => f.replace(/\\/g, '/').replace(/^\.\//, '');

/** 'file::name' -> { file, name } (the first '::' splits: a Rust name keeps its own) */
export function parseSpec(s) {
  const i = String(s).indexOf('::'), file = i > 0 ? norm(s.slice(0, i)) : '', name = i > 0 ? s.slice(i + 2) : '';
  if (!file || !name) throw new Error(`${s}: name a symbol as file::name`);
  return { file, name };
}
const matches = (d, n) => d.name === n || d.qual === n || ['#', '.', '::'].some(sep => d.qual.endsWith(sep + n));
const brief = d => ({ name: d.name, qual: d.qual, kind: d.kind, line: d.line, end_line: d.end_line });
// the worktree file's state against the indexed commit: 'same' | 'changed' | 'deleted'
function fileState(root, file, commit) {
  if (!fs.existsSync(path.join(root, file))) return 'deleted';
  let was = null;
  try { was = git(root, 'rev-parse', `${commit}:${file}`); } catch { /* not in the commit: changed */ }
  return was && git(root, 'hash-object', '--', file) === was ? 'same' : 'changed';
}

/** { state, repo, specs: ['file::name'] } -> { ok: true, results: [{ file, name, status, why?, stamp, defs: [Def + source], indexed?, symbols? }] }
 *  status: current | relocated (the file changed; bounds from the worktree file) | moved (in the index, not in the file now) | unknown | n/a */
export function readSymbols({ state = null, repo, specs }) {
  const asked = specs.map(parseSpec), byFile = new Map();
  let root = null;
  try { root = git(repo, 'rev-parse', '--show-toplevel'); } catch { /* the reader's n/a says why */ }
  const results = asked.map(({ file, name }) => {
    if (!byFile.has(file)) byFile.set(file, fileOf(state, repo, root, file));
    const f = byFile.get(file), base = { file, name, stamp: f.stamp ?? null };
    if (f.why && !f.now) return { ...base, status: 'n/a', why: f.why, defs: [] };
    const indexed = f.indexed.filter(d => matches(d, name)), hit = (f.now ?? []).filter(d => matches(d, name));
    if (hit.length) return { ...base, status: f.state === 'same' ? 'current' : 'relocated', defs: hit.map(d => ({ ...d, ...sourceOf(f.lines, d) })), ...(f.state === 'same' ? {} : { indexed: indexed.map(brief) }) };
    const symbolsNow = (f.now ?? []).map(brief);
    if (indexed.length) return { ...base, status: 'moved', why: f.why ?? 'not in the worktree file', defs: [], indexed: indexed.map(brief), symbols: symbolsNow };
    return { ...base, status: 'unknown', why: `no symbol ${name} in ${file}`, defs: [], symbols: symbolsNow };
  });
  return { ok: true, results };
}
// one file: its indexed defs, its state in the worktree, and its current defs + lines (null when they cannot be had: `why`)
function fileOf(state, repo, root, file) {
  const ix = symbols({ state, repo, file });
  if (ix.ok === false) return { why: ix.why };
  const st = fileState(root, file, ix.stamp.commit), out = { stamp: ix.stamp, indexed: ix.defs, state: st };
  if (st === 'deleted') return { ...out, now: [], lines: [], why: 'the file was deleted in the worktree since the index' };
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  if (st === 'same') return { ...out, now: ix.defs, lines };
  const w = symbols({ state, repo, file, worktree: true });
  return w.ok === false ? { ...out, now: null, why: `changed since the index, and the worktree file cannot be read: ${w.why}` } : { ...out, now: w.defs, lines };
}
function sourceOf(lines, d) {
  const all = lines.slice(d.line - 1, d.end_line), more = Math.max(0, all.length - SYMBOL_LIMITS.lines);
  return { source: all.slice(0, SYMBOL_LIMITS.lines).join('\n'), more_lines: more };
}

const at = s => `at ${s.commit.slice(0, 12)} (${ageOf(s.age_s)})`;
const bounds = ds => ds.map(d => `${d.line}..${d.end_line}`).join(', ');
const list = ds => (ds.length ? ds.map(d => `${d.name} (${d.kind} ${d.line}..${d.end_line})`).join(', ') : 'none');
/** the text of readSymbols' results -> lines */
export function symbolLines(r) {
  const o = [];
  for (const x of r.results) {
    const id = `${x.file}::${x.name}`;
    if (x.status === 'n/a') { o.push(`${id}: n/a: ${x.why}`); continue; }
    if (x.status === 'moved') { o.push(`${id}: moved since the index (indexed at ${bounds(x.indexed)} ${at(x.stamp)}; ${x.why}); its symbols now: ${list(x.symbols)}`); continue; }
    if (x.status === 'unknown') { o.push(`${x.why}; its symbols now: ${list(x.symbols)} (indexed ${at(x.stamp)})`); continue; }
    for (const d of x.defs) {
      const how = x.status === 'current' ? 'current' : `changed since the index: re-located in the worktree file (indexed at ${x.indexed.length ? bounds(x.indexed) : 'not indexed'})`;
      o.push(`${id}  ${d.kind} ${d.qual}  lines ${d.line}..${d.end_line}  ${at(x.stamp)}, ${how}`, ...d.source.split('\n'));
      if (d.more_lines) o.push(`+${d.more_lines} more lines`);
    }
  }
  return o;
}
/** exit code of a result: 3 any n/a, else 1 any moved / unknown, else 0 */
export const symbolExit = r => (r.results.some(x => x.status === 'n/a') ? 3 : r.results.some(x => x.status === 'moved' || x.status === 'unknown') ? 1 : 0);
