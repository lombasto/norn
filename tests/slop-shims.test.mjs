// RM-9 (DIR-2): K16, the compatibility-shim rule (CLAUDE.md "No compatibility shims"). Lines that must fire and near-misses that
// must not (a "fallback" in its ordinary sense, a label that is the id in other words); the fixture run through slopCheck is in slop.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRules, shimFindings, matchAny } from '../engine/lib/slop/check.mjs';

const K16 = loadRules().find(r => r.id === 'K16');
const hits = (text, file = 'engine/lib/x.mjs') => shimFindings(K16, text, file);

test('K16 is a BLOCK rule of kind shim whose every finding names the fix', () => {
  assert.equal(K16.level, 'BLOCK'); assert.equal(K16.kind, 'shim');
  const f = hits("const OLD_NAMES = ['${meta}'];\n");
  assert.equal(f.length, 1);
  assert.match(f[0].msg, /change every caller to the new form and delete the old one/);
  assert.equal(f[0].line, 1); assert.equal(f[0].file, 'engine/lib/x.mjs');
});

test('K16 must fire: alias / redirect / old-name maps, old forms that still work, deprecated options, a label that is not its id', () => {
  const must = [
    "const OLD_NAMES = ['${meta}', '{{meta}}'];",
    "export const OLD_SERVER = { norn: 'meta' };",
    "const OLD_NAME = 'meta-controller-tick';",
    "const LEGACY_TABS = { agents: 'runs' };",
    "const KIND_ALIAS = { Q: 'question' };",
    "const TAB_REDIRECTS = { agents: 'runs' };",
    "const oldToNew = new Map([['agents', 'runs']]);",
    "const legacyIds = ['agents'];",
    '// keeps backward compatibility with 1.x configs',
    "out('back-compat: reading the old file');",
    '// no X in the spec: fall back to the stored copy',
    '// falls back to the legacy marker when there is no result file',
    '// kept for old links',
    "if (tab === 'agents') tab = 'runs';   // for old bookmarks",
    '// ${meta} = the old name (META-NAME-W3)',
    "out(`launcher (old name: meta)`);",
    '// META-NAME-W2: a pre-rename task of this install goes too',
    '// the old names of the engine-root variable; they keep resolving',
    "// --tab is still accepted (renamed to --page)",
    '// pending compatibility paths are a note while old runs may live',
    "if (flags.verbose) warn('--verbose is deprecated, use --log');",
    "export const PAGE_VIEWS = [['agents', 'Runs'], ['map', 'Map']];",
    "{ id: 'gpu', label: 'House rule line (read-only)' },",
  ];
  for (const line of must) assert.ok(hits(line + '\n').length >= 1, `must fire: ${line}`);
});

test('K16 must not fire: fallback in its ordinary sense, old as an adjective, legacy as a domain word, a label that names its id', () => {
  const mustNot = [
    "const fallback = x => x || 'none';",
    '// no model named: fall back to the default model',
    "// fallbacks: who takes the work when an executor is unavailable",
    "{ id: 'fallbacks', label: 'Fallbacks' },",
    "const oldest = runs.at(0);",
    "const old = entries.filter(e => e.status !== 'A').map(e => e.old);",
    '// the old path of a renamed file (git rename detection)',
    "import { running } from '../lib/legacy.mjs';",
    "const legacyWordsSeen = 1;",
    "export const LEGACY_WORDS = { REQUESTED: 'idea', BUILT: 'built' };   // the status words of the old roadmap format the importer reads",
    "const files = list.filter(f => f.endsWith('.json'));",
    "const renamed = new Map(entries.map(e => [e.old, e.path]));",
    "export const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus'];",
    "{ id: 'notify', label: 'Notifications' },",
    "// the claude-compatible provider bills its own account",
    "fetch(u, { redirect: 'follow' });",
    "export const TABS = [['home', 'Home'], ['runs', 'Runs'], ['settings', 'Settings']];",
    "export const CONTEXT_SUBS = [['role', 'Per role'], ['file', 'Per file'], ['checkins', 'Check-ins per day']];",
    "export const MAP_VIEWS = [['well', 'The Well'], ['tapestry', 'The Tapestry']];",
    "{ id: 'defaults', label: 'Default model & effort' },",
    "const OUT = { done: ['ok', 'DONE'], stopped: ['bad', 'STOPPED'] };",
    "const s = 'a string with [\"x\", \"Y\"] in it';",
  ];
  for (const line of mustNot) assert.deepEqual(hits(line + '\n'), [], `must not fire: ${line}`);
});

test('K16: one finding per line even when several patterns match it; a page list spanning lines is checked pair by pair', () => {
  assert.equal(hits('// backward compat: fall back to the old file, kept for old links\n').length, 1);
  const f = hits("const x = 1;\nexport const GUARD_SUBS = [['fix', 'To fix'],\n  ['types', 'Per type'],\n  ['growing', 'By age']];\nconst y = [['a', 'Zed']];\n");
  assert.deepEqual(f.map(x => x.line), [4]);
  assert.match(f[0].msg, /'By age'.*'growing'/);
});

test('K16 skips tests, vendored and minified code (fixture text there is not a shim)', () => {
  for (const f of ['tests/a.test.mjs', 'engine/dash/vendor/three.module.js', 'src/x.spec.js', 'web/app.min.js']) assert.ok(matchAny(K16.exclude, f), f);
  assert.ok(!matchAny(K16.exclude, 'engine/lib/config.mjs'));
});
