// slop-langs S1 (SPEC 3.4, 7 S1): the TypeScript pack. Its ast-grep language is TypeScript (Tsx for .tsx); its suppression comments
// and its lexer are JavaScript's (the same syntax), so it re-exports the JS pack's; its import edges are the code graph's (codegraph.mjs). TS has no lint tool and no
// parse gate (tree-sitter is error tolerant): the same as before the pack existed.
export { suppressions, classify, MARKS } from './js.mjs';

export const ID = 'ts', astLang = f => (f.endsWith('.tsx') ? 'Tsx' : 'TypeScript');
