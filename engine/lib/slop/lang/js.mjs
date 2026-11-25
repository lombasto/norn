// SloppaChoppa 2 S3 (SPEC 4.5, 7 S3): the JavaScript pack - its suppression comments (the kind `suppress`), and ESLint as a lint
// tool (its findings, its docs, which file is its config). The import edges are the code graph's (codegraph.mjs).
import { parseEslint } from '../tools.mjs';
import { classify, COMMENT, lineAt } from '../scan.mjs';
/** the pack's lexer and comment marks (lang/index.mjs masked / commentsIn): scan.mjs's JS lexer */
export { classify, JS_MARKS as MARKS } from '../scan.mjs';

/** the pack's id (an ast rule's `match` key) and the ast-grep language of a file it reads (slop-langs SPEC 3.4) */
export const ID = 'js', astLang = () => 'JavaScript';

// ESLint's inline switches; the reason is ESLint's own `-- description`
const SUPPRESS_RE = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b(?:(?!--|\*\/).)*(?:--(.*?))?(?:\*\/|$)/gm;
/** the suppressions of a text: [{ line, reason }] (inside a comment only) */
export function suppressions(text) {
  const cls = classify(text);
  return [...text.matchAll(SUPPRESS_RE)].filter(m => cls[m.index + 2] === COMMENT).map(m => ({ line: lineAt(text, m.index), reason: m[1] || '' }));
}

export const ESLINT = { parse: raw => parseEslint(raw), doc: s => `ESLint: https://eslint.org/docs/latest/rules/${s}`, configOf: (rule, f, read) => (f === rule.config ? read() : null) };
