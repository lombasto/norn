// SloppaChoppa 2 S3 (SPEC 3.3, 4.5, 7 S3): the Rust pack - `#[allow]` / `#[expect]`
// suppressions, the `#[cfg(test)]` regions loc.mjs counts as tests, and clippy as the lint tool LR. Choppa never runs clippy
// (a build takes minutes; a project's quiet and time-budget rules): LR reads the log the head's own gate wrote, `{git}/norn/clippy/<head>*.log`.
import path from 'node:path';
import { CODE, COMMENT, STRING, lineAt, markQuotes, tomlTables } from '../scan.mjs';
import { logFiles } from './logs.mjs';

/** the pack's id (an ast rule's `match` key) and the ast-grep language of a file it reads: Cargo.toml is the pack's, but no Rust source */
export const ID = 'rs', astLang = f => (f.endsWith('.rs') ? 'Rust' : null);

const P = path.posix;
/** the folder a module's children live in: lib.rs / main.rs / mod.rs own their folder, a.rs owns a/ */
const modDir = f => (/^(?:lib|main|mod)\.rs$/.test(P.basename(f)) ? P.dirname(f) : f.slice(0, -3));
const modFile = (dir, segs, at) => { for (let k = segs.length; k > 0; k--) { const b = `${dir}/${segs.slice(0, k).join('/')}`; const hit = [`${b}.rs`, `${b}/mod.rs`].find(x => at.has(x)); if (hit) return hit; } return null; };
// `#[allow(x)] // reason` or Rust's own `#[allow(x, reason = "...")]`
const SUPPRESS_RE = /#!?\[(?:allow|expect)\((?:[^\]\n]*?\breason\s*=\s*"([^"\n]*)")?[^\]\n]*\)\][ \t]*(?:\/\/+)?(.*)$/gm;
export const suppressions = text => [...text.matchAll(SUPPRESS_RE)].map(m => ({ line: lineAt(text, m.index), reason: m[1] || m[2] }));

// ---------- the lexer (slop-langs SPEC 4): // /// //! comments, nested /* */, "..." with escapes, r#"..."# / b"..." / c"...", 'c' vs a lifetime ----------
/** Rust's comment marks (scan.mjs commentText) */
export const MARKS = /\/\/[/!]?|\/\*[*!]?|\*\//g;
const CHAR = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/u;
/** one class per character (scan.mjs's CODE, COMMENT, STRING, QUOTE); a literal's prefix and quote marks are code, a lifetime is code */
export function classify(t) {
  const cls = new Uint8Array(t.length);
  for (let i = 0; i < t.length;) {
    const c = t[i], n = t[i + 1];
    if (c === '/' && n === '/') { let e = t.indexOf('\n', i); if (e < 0) e = t.length; cls.fill(COMMENT, i, e); markQuotes(t, cls, i, e); i = e; continue; }
    if (c === '/' && n === '*') {
      let j = i + 2;
      for (let d = 1; j < t.length && d;) { if (t[j] === '/' && t[j + 1] === '*') { d++; j += 2; } else if (t[j] === '*' && t[j + 1] === '/') { d--; j += 2; } else j++; }
      cls.fill(COMMENT, i, j); markQuotes(t, cls, i, j); i = j; continue;
    }
    const raw = 'brc'.includes(c) && !/\w/.test(t[i - 1] || '') && /^[bc]?r(#*)"/.exec(t.slice(i, i + 40));
    if (raw) { const s = i + raw[0].length, e = t.indexOf('"' + raw[1], s); cls.fill(STRING, s, e < 0 ? t.length : e); i = e < 0 ? t.length : e + 1 + raw[1].length; continue; }
    if (c === '"') { let j = i + 1; for (; j < t.length && t[j] !== '"'; j++) if (t[j] === '\\') j++; cls.fill(STRING, i + 1, Math.min(j, t.length)); i = j + 1; continue; }
    const ch = c === "'" && CHAR.exec(t.slice(i, i + 12));   // else a lifetime
    if (ch) { cls.fill(STRING, i + 1, i + ch[0].length - 1); i += ch[0].length; continue; }
    i++;
  }
  return cls;
}

/** the index past the item that starts at i: its `;`, or its `{ ... }` (the code only: the lexer's classes skip comments and literals) */
function itemEnd(t, i, cls) {
  for (let depth = 0; i < t.length; i++) {
    if (cls[i] !== CODE) continue;
    const c = t[i];
    if (c === ';' && depth === 0) return i + 1;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return t.length;
}
const CFG_TEST = /#\[cfg\(test\)\]/g;
/** the `#[cfg(test)]` items of a Rust text: { lines: Set(1-based line numbers inside them), mods: [files of `#[cfg(test)] mod x;`] } */
export function testRegions(file, text, at) {
  const lines = new Set(), mods = [], cls = classify(text);
  for (const m of text.matchAll(CFG_TEST)) {
    const end = itemEnd(text, m.index + m[0].length, cls), item = text.slice(m.index, end), a = lineAt(text, m.index), b = lineAt(text, end);
    for (let l = a; l <= b; l++) lines.add(l);
    const out = /^#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;$/.exec(item.trim()), to = out && modFile(modDir(file), [out[1]], at);
    if (to) mods.push(to);
  }
  return { lines, mods };
}

// ---------- clippy (LR): read from the head's gate log, never run ----------
/** the head's clippy logs (rule.log: path templates, lang/logs.mjs) -> text | null */
function run(rule, side) {
  if (side !== 'head') return null;   // main is clean by construction (-D warnings in CI): a diagnostic on a touched file is new
  const logs = logFiles(rule.log, rule.git, rule.head);
  return logs.length ? logs.map(l => l.text).join('\n') : null;
}
/** clippy's human output -> [{ file (a touched file the path names: equal, or its tail), rule (clippy::x, or the rustc lint), line, msg }] */
function parse(raw, touched = []) {
  const out = [], blocks = raw.replace(/\r/g, '').split(/\n(?=(?:warning|error)(?:\[\w+\])?: )/);
  for (const b of blocks) {
    const head = /^(?:warning|error)(?:\[(\w+)\])?: (.+)/.exec(b), at = /^\s*--> ([^\n]+?):(\d+):\d+\s*$/m.exec(b);
    if (!head || !at) continue;   // the summary lines ("generated 3 warnings", "could not compile") name no file
    const name = /#\[(?:warn|deny|forbid)\(([\w:]+)\)\]/.exec(b)?.[1] || /-[DW] ([\w:-]+)` implied/.exec(b)?.[1]?.replace(/-/g, '_') || (/index\.html#(\w+)/.exec(b) && `clippy::${/index\.html#(\w+)/.exec(b)[1]}`) || head[1] || 'rustc';
    const named = at[1].replace(/\\/g, '/');
    for (const f of touched.filter(x => x === named || x.endsWith('/' + named) || named.endsWith('/' + x))) out.push({ file: f, rule: name, line: Number(at[2]), msg: head[2] });
  }
  return out;
}
const clippyOf = (f, read) => (/^\.?clippy\.toml$/.test(P.basename(f)) ? read() : P.basename(f) === 'Cargo.toml' ? tomlTables(read() ?? '', t => /^(?:workspace\.)?lints(\.|$)/.test(t)) : null);
export const CLIPPY = { run, parse, doc: s => `clippy: https://rust-lang.github.io/rust-clippy/master/index.html#${s.replace(/^clippy::/, '')}`, configOf: (rule, f, read) => clippyOf(f, read) };
