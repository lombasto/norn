// SloppaChoppa 2 S3 (SPEC 7 S3): the language packs by file - so no detector is written per language - and the lint tools by name.
import * as js from './js.mjs';
import * as py from './py.mjs';
import * as rs from './rs.mjs';

const BY_EXT = { mjs: js, cjs: js, js, py, pyi: py, rs };
/** the pack that reads a file (Cargo.toml is Rust's), or null */
export const packOf = f => (/(?:^|\/)Cargo\.toml$/.test(f) ? rs : BY_EXT[/\.(\w+)$/.exec(f)?.[1]] || null);
/** a lint tool's { parse, doc, configOf, configs?, run? } (run: a project tool; ESLint runs from Norn's pinned tool set) */
export const LINTERS = { eslint: js.ESLINT, ruff: py.RUFF, clippy: rs.CLIPPY };
