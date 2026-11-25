// SloppaChoppa 2 S3 (SPEC 7 S3): the language packs by file - so no detector is written per language - and the lint tools by name.
// slop-langs S1 (SPEC 3.4, 6): a pack also gives its id (the key of an ast rule's `match` data), the ast-grep language of a file,
// and the lexer of its comments and strings (JS's for JS and TS; Python's and Rust's own come in S3).
import * as js from './js.mjs';
import * as ts from './ts.mjs';
import * as py from './py.mjs';
import * as rs from './rs.mjs';

const BY_EXT = { mjs: js, cjs: js, js, ts, cts: ts, mts: ts, tsx: ts, py, pyi: py, rs };
/** the pack that reads a file (Cargo.toml is Rust's), or null */
export const packOf = f => (/(?:^|\/)Cargo\.toml$/.test(f) ? rs : BY_EXT[/\.(\w+)$/.exec(f)?.[1]] || null);
/** the packs by id: the keys an ast rule's `match` may use */
export const PACKS = { js, ts, py, rs };
/** a lint tool's { parse, doc, configOf, configs?, run? } (run: a project tool; ESLint runs from Norn's pinned tool set) */
export const LINTERS = { eslint: js.ESLINT, ruff: py.RUFF, clippy: rs.CLIPPY };
