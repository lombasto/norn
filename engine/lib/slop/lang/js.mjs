// SloppaChoppa 2 S3 (SPEC 4.5, 7 S3): the JavaScript pack - a module's static import edges (the kind `imports`: layers, cycles),
// its suppression comments (the kind `suppress`), and ESLint as a lint tool (its findings, its docs, which file is its config).
import path from 'node:path';
import { parseEslint } from '../tools.mjs';
import { classify, COMMENT, lineAt, norm } from '../scan.mjs';

// static `import ... from 'x'` / `export ... from 'x'` / `import 'x'` (a dynamic import() is no load-order edge)
const IMPORT_RE = /^\s*(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
/** the relative imports of a module that name a file of the tree: [{ to, line, text }] */
export function imports(file, text, at) {
  return [...text.matchAll(IMPORT_RE)].flatMap(m => {
    const to = m[1].startsWith('.') && path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    return to && at.has(to) ? [{ to, line: lineAt(text, m.index + m[0].indexOf(m[1])), text: norm(m[0]) }] : [];
  });
}

// ESLint's inline switches; the reason is ESLint's own `-- description`
const SUPPRESS_RE = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b(?:(?!--|\*\/).)*(?:--(.*?))?(?:\*\/|$)/gm;
/** the suppressions of a text: [{ line, reason }] (inside a comment only) */
export function suppressions(text) {
  const cls = classify(text);
  return [...text.matchAll(SUPPRESS_RE)].filter(m => cls[m.index + 2] === COMMENT).map(m => ({ line: lineAt(text, m.index), reason: m[1] || '' }));
}

export const ESLINT = { parse: raw => parseEslint(raw), doc: s => `ESLint: https://eslint.org/docs/latest/rules/${s}`, configOf: (rule, f, read) => (f === rule.config ? read() : null) };
