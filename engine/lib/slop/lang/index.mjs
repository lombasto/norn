// SloppaChoppa 2 S3 (SPEC 7 S3): the language packs by file - so no detector is written per language - and the lint tools by name.
// slop-langs S1 (SPEC 3.4, 6): a pack also gives its id (the key of an ast rule's `match` data), the ast-grep language of a file,
// and the lexer of its comments and strings (JS's for JS and TS). slop-langs S3 (SPEC 4): Python's and Rust's lexers are their packs';
// masked / commentsIn ask the file's pack, and a file with no lexing pack (a doc, a data file, Cargo.toml) is all prose.
import * as js from './js.mjs';
import * as ts from './ts.mjs';
import * as py from './py.mjs';
import * as rs from './rs.mjs';
import { SARIF } from './sarif.mjs';
import { maskClasses, commentText } from '../scan.mjs';

const CARGO = /(?:^|\/)Cargo\.toml$/;
const BY_EXT = { mjs: js, cjs: js, js, ts, cts: ts, mts: ts, tsx: ts, py, pyi: py, rs };
/** the pack that reads a file (Cargo.toml is Rust's), or null */
export const packOf = f => (CARGO.test(f) ? rs : BY_EXT[/\.(\w+)$/.exec(f)?.[1]] || null);
/** the packs by id: the keys an ast rule's `match` may use */
export const PACKS = { js, ts, py, rs };
/** a lint tool's { parse, doc?, configOf, configs?, run?, fromFile? } (run: a project tool; ESLint runs from Norn's pinned tool set; fromFile: SARIF, a rule's own file per side) */
export const LINTERS = { eslint: js.ESLINT, ruff: py.RUFF, clippy: rs.CLIPPY, sarif: SARIF };

/** the pack whose lexer reads a file's source (Cargo.toml is the Rust pack's, but TOML), or null */
const lexerOf = f => (CARGO.test(f) ? null : packOf(f));
/** the text with every character outside the wanted classes blanked by the file's pack lexer; a file with no lexer is all prose */
export function masked(text, want, file) { const p = lexerOf(file); return p ? maskClasses(text, want, p.classify(text)) : text; }
/** the comment text of a line range (1-based, inclusive) of a source file, by its pack's lexer and comment marks (K2's reason test) */
export function commentsIn(text, from, to, file) { const p = lexerOf(file); return p ? commentText(text, from, to, p.classify(text), p.MARKS) : ''; }
