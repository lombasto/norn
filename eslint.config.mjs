// Norn's ESLint config, plain data (SloppaChoppa 2 SPEC 3.1, 3.3): what the kind `lint` (rule LJ) looks for; LJ's rule file says
// what a new finding costs. No plugin and no import (Q2: core rules only). The check reads this file from the MERGE BASE, never
// the branch's: an edit here is LJ/config-changed, held until the owner approves the rule change (Q12). The rules LJ holds on
// (no-unused-vars, no-duplicate-imports, no-console, no-debugger, no-warning-comments, no-restricted-properties) come from LJ's
// data first; this file adds ESLint's recommended set (shadow until a rule is promoted by its replay numbers) and per-folder blocks.
const node = ['process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
  'fetch', 'Response', 'Request', 'Headers', 'globalThis', 'performance', 'crypto', 'atob', 'btoa', 'Blob', 'FormData', 'EventTarget',
  'Event', 'WebSocket', 'require', 'module', 'exports', '__dirname', '__filename'];
const browser = ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'history', 'HTMLElement', 'Element',
  'Node', 'customElements', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia', 'MutationObserver',
  'ResizeObserver', 'IntersectionObserver', 'EventSource', 'Notification', 'alert', 'confirm', 'prompt', 'DOMParser', 'CSS',
  'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'Image', 'innerWidth', 'innerHeight', 'scrollTo', 'addEventListener', 'removeEventListener'];
const globals = names => Object.fromEntries(names.map(n => [n, 'readonly']));
// ESLint 10.15.0's recommended set (meta.docs.recommended), less the two LJ holds with its own options (no-unused-vars, no-debugger)
const recommended = ['constructor-super', 'for-direction', 'getter-return', 'no-async-promise-executor', 'no-case-declarations',
  'no-class-assign', 'no-compare-neg-zero', 'no-cond-assign', 'no-const-assign', 'no-constant-binary-expression', 'no-constant-condition',
  'no-control-regex', 'no-delete-var', 'no-dupe-args', 'no-dupe-class-members', 'no-dupe-else-if', 'no-dupe-keys', 'no-duplicate-case',
  'no-empty', 'no-empty-character-class', 'no-empty-pattern', 'no-empty-static-block', 'no-ex-assign', 'no-extra-boolean-cast',
  'no-fallthrough', 'no-func-assign', 'no-global-assign', 'no-import-assign', 'no-invalid-regexp', 'no-irregular-whitespace',
  'no-loss-of-precision', 'no-misleading-character-class', 'no-new-native-nonconstructor', 'no-nonoctal-decimal-escape', 'no-obj-calls',
  'no-octal', 'no-prototype-builtins', 'no-redeclare', 'no-regex-spaces', 'no-self-assign', 'no-setter-return', 'no-shadow-restricted-names',
  'no-sparse-arrays', 'no-this-before-super', 'no-unassigned-vars', 'no-undef', 'no-unexpected-multiline', 'no-unreachable',
  'no-unsafe-finally', 'no-unsafe-negation', 'no-unsafe-optional-chaining', 'no-unused-labels', 'no-unused-private-class-members',
  'no-useless-assignment', 'no-useless-backreference', 'no-useless-catch', 'no-useless-escape', 'no-with', 'preserve-caught-error',
  'require-yield', 'use-isnan', 'valid-typeof'];

export default [
  { files: ['**/*.mjs', '**/*.js', '**/*.cjs'], languageOptions: { globals: globals(node) },
    rules: Object.fromEntries(recommended.map(r => [r, 'error'])) },
  { files: ['engine/dash/**'], languageOptions: { globals: globals([...node, ...browser]) } },
  // the CLI printers and the tests print on purpose (K24's old exclude list)
  { files: ['tests/**', 'engine/bin/**', 'engine/lib/testscli.mjs', '**/make-palette.mjs'], rules: { 'no-console': 'off' } },
];
