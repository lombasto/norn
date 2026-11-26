// SloppaChoppa 2 S3 (SPEC 4.5, 7 S3): the language packs - K10 (the kind `imports`: layers and cycles) over Python and Rust
// through the code graph (codegraph.mjs), the suppression rule K25 over the three languages, and Rust's #[cfg(test)] counted as tests in loc.mjs. Synthetic
// trees only (the repo is public).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRules, effectiveRules, slopCheck } from '../engine/lib/slop/check.mjs';
import { testRegions } from '../engine/lib/slop/lang/rs.mjs';
import * as rs from '../engine/lib/slop/lang/rs.mjs';
import * as py from '../engine/lib/slop/lang/py.mjs';
import { ruffArgs } from '../engine/lib/slop/lang/py.mjs';
import { CODE, COMMENT, STRING, QUOTE } from '../engine/lib/slop/scan.mjs';
import { snapshot } from '../engine/lib/slop/loc.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
/** a repo: main = base files, feat/x = base + head files */
function repoOf(base, head) {
  const dir = mkTmp('meta-slop-lang-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  put(dir, base); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x'); put(dir, head); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'head');
  return dir;
}
const LAYER = { id: 'P-engine-games', level: 'BLOCK', kind: 'imports', title: 'engine imports games', roots: ['engine/'], files: ['**/*.py', '**/*.rs', '**/Cargo.toml'], forbid: [{ from: 'engine/**', to: ['games/**'] }],
  explain: { what: 'w', why: 'y', fix: 'f' }, fixture: { hit: {}, miss: {} } };
test('imports over Python and Rust: engine/** may not import games/** (a Python import, a Cargo path dependency); a new Python cycle; Rust use-cycles are no finding', () => {
  // the code graph finds Python import roots from each pyproject.toml (SPEC code-graph 4.1): each project has one
  const base = { 'engine/e/pyproject.toml': '[project]\nname = "e"\n', 'games/g/pyproject.toml': '[project]\nname = "g"\n', 'engine/e/src/eng/__init__.py': '', 'engine/e/src/eng/a.py': 'X = 1\n', 'engine/e/src/eng/b.py': 'from eng import a\n', 'games/g/src/game/__init__.py': '', 'games/g/src/game/w.py': 'Y = 1\n',
    'engine/r/Cargo.toml': '[package]\nname = "r"\n', 'engine/r/src/lib.rs': 'mod a;\nmod b;\n', 'engine/r/src/a.rs': 'pub fn f() {}\n', 'engine/r/src/b.rs': 'pub fn g() {}\n', 'games/g/Cargo.toml': '[package]\nname = "g"\n' };
  const head = { 'engine/e/src/eng/a.py': 'from game import w\nfrom eng import b\nX = 1\n', 'engine/r/Cargo.toml': '[package]\nname = "r"\n[dependencies]\ng = { path = "../../games/g" }\n',
    'engine/r/src/a.rs': 'use crate::b::g;\npub fn f() {}\n', 'engine/r/src/b.rs': 'use crate::a::f;\npub fn g() {}\n' };
  const r = slopCheck({ repo: repoOf(base, head), base: 'main', rules: [LAYER] });
  assert.deepEqual(r.blocks.map(b => [b.file, b.line, b.msg]).sort(), [
    ['engine/e/src/eng/a.py', 1, 'engine/e/src/eng/a.py must not import games/g/src/game/w.py (engine/** -> games/**)'],
    ['engine/e/src/eng/a.py', 1, 'import cycle: engine/e/src/eng/a.py -> engine/e/src/eng/b.py'],
    ['engine/r/Cargo.toml', 4, 'engine/r/Cargo.toml must not import games/g/Cargo.toml (engine/** -> games/**)'],
  ].sort());
  const clean = slopCheck({ repo: repoOf(base, { 'engine/e/src/eng/a.py': 'def f():\n    from game import w\n    return w\n' }), base: 'main', rules: [LAYER] });
  assert.deepEqual(clean.blocks, [], 'a function-level import is no edge');
});

const K25 = loadRules().find(r => r.id === 'K25');
test('K25: a new suppression needs a reason on its line, in Python, Rust and JS; an old one, or one inside a JS string, is no finding', () => {
  const base = { 'a.py': 'import sys  # noqa: F401\n', 'b.rs': 'fn x() {}\n', 'c.mjs': 'export const a = 1;\n' };
  const head = { 'a.py': 'import sys  # noqa: F401\nimport os  # noqa: F401\nimport re  # noqa: F401 # re-exported for the plugin API\nx = f()  # type: ignore[attr-defined]\n',
    'b.rs': '#[allow(dead_code)]\nfn x() {}\n#[allow(clippy::too_many_arguments)] // the FFI signature is fixed by C\nfn y() {}\n#[expect(unused, reason = "kept for the save format")]\nfn z() {}\n',
    'c.mjs': "// eslint-disable-next-line no-console\nexport const a = 1;\n/* eslint-disable no-undef -- the globals come from the page */\nexport const s = '// eslint-disable-line';\n" };
  const r = slopCheck({ repo: repoOf(base, head), base: 'main', rules: [K25] });
  assert.deepEqual(r.blocks.map(b => [b.rule, b.file, b.line]), [['K25', 'a.py', 2], ['K25', 'a.py', 4], ['K25', 'b.rs', 1], ['K25', 'c.mjs', 1]]);
  const deny = slopCheck({ repo: repoOf({}, { 'd.py': 'import os  # noqa: F401 ok\n' }), base: 'main', rules: [K25] });
  assert.equal(deny.blocks.length, 1, 'K2\'s deny list: "ok" says nothing');
});

test('rs pack: #[cfg(test)] items - an inline module to its closing brace (braces in strings, chars and comments skipped), and the file of an out-of-line one', () => {
  const text = 'pub fn a() {}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { let s = "}"; let c = \'}\'; let r = r#"}"#; /* } */ assert!(f::<\'static>()); }\n}\npub fn b() {}\n#[cfg(test)]\nmod more;\n';
  const r = testRegions('c/src/lib.rs', text, { has: f => f === 'c/src/more.rs' });
  assert.deepEqual([...r.lines], [3, 4, 5, 6, 7, 9, 10]);
  assert.deepEqual(r.mods, ['c/src/more.rs']);
});

test('loc: a Rust file\'s #[cfg(test)] lines count as tests, its other lines as code; a #[cfg(test)] mod file is all tests', () => {
  const repo = repoOf({ 'c/src/lib.rs': 'pub fn a() -> u8 {\n    1\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() {}\n}\n#[cfg(test)]\nmod more;\n', 'c/src/more.rs': '#[test]\nfn m() {}\n', 'c/src/x.rs': 'pub fn x() {}\n' }, {});
  const s = snapshot(repo, 'HEAD');
  assert.deepEqual([s.totals.code, s.totals.tests], [4, 9]);
  assert.deepEqual(s.areas['c/src'], { code: 4, tests: 9 });
  assert.deepEqual(s.languages.Rust, { code: 4, tests: 9 });
});

// ---------- slop-langs S3 (SPEC 4, 7 S3): the Python and Rust lexers, the plain-pattern rules over them, LP's select, K10's new files ----------
const RULES = loadRules(), rule = id => RULES.find(r => r.id === id);
const clsAt = (classify, t) => s => classify(t)[t.indexOf(s)];
test('py lexer: # comments, prefixed and triple-quoted strings (a docstring is a string), an f-string field is code and {{ text; a quote in a comment', () => {
  const t = 'def f(x):\n    """the # here is text\n    over two lines"""\n    a = rb\'\\\'# no\'  # a "cited" note\n    return f"{x["k"]!r:>4} {{y}} #"\n';
  const at = clsAt(py.classify, t);
  assert.equal(at('def f'), CODE);
  assert.equal(at('the # here'), STRING); assert.equal(at('over two'), STRING);
  assert.equal(at('rb'), CODE); assert.equal(at('# no'), STRING, 'an escaped quote does not end the string');
  assert.equal(at('# a '), COMMENT); assert.equal(at('"cited"'), QUOTE);
  assert.equal(at('x["k"]'), CODE, 'an f-string field is code'); assert.equal(at('k"]'), STRING, 'a string inside the field');
  assert.equal(at('{{y}}'), STRING); assert.equal(at(' #"'), STRING, 'a # inside a string is no comment');
});
test('rs lexer: // /// //! and nested /* */ comments, escapes, raw / byte strings, a char vs a lifetime', () => {
  const t = 'fn f<\'a>(s: &\'a str) -> char { // one\n    /* outer /* inner */ still */ let r = r#"a "// x" b"#; let b = b"\\"//"; \'"\' }\n//! crate doc\n';
  const at = clsAt(rs.classify, t);
  assert.equal(at('fn f'), CODE); assert.equal(at("'a str"), CODE, 'a lifetime is code');
  assert.equal(at('// one'), COMMENT); assert.equal(at('still */'), COMMENT, 'a nested block comment ends at its own */');
  assert.equal(at('let r'), CODE); assert.equal(at('// x'), STRING, 'a raw string holds its quotes');
  assert.equal(at('//"; '), STRING, 'an escaped quote in a byte string');
  assert.equal(at('\'"\''.slice(1)), STRING, 'a char literal'); assert.equal(at(' }\n//!'), CODE);
  assert.equal(at('//! crate'), COMMENT);
});
test('K22 over Python: `# for now` in a comment is one (shadow) finding; the same text in a string is not a comment', () => {
  const head = { 'src/a.py': 'X = "# for now"\n# for now the retry is off\nA = 1\n' };
  const r = slopCheck({ repo: repoOf({ 'src/a.py': 'A = 1\n' }, head), base: 'main', rules: [rule('K22')] });
  assert.deepEqual(r.findings.filter(f => f.new).map(f => [f.rule, f.line, f.shadow]), [['K22', 1, true], ['K22', 2, true]], 'K22 reads strings (SPEC 4: comment + string text); py is shadow');
  const comments = slopCheck({ repo: repoOf({ 'src/a.py': 'A = 1\n' }, head), base: 'main', rules: [{ ...rule('K22'), in: ['comment'] }] });
  assert.deepEqual(comments.findings.filter(f => f.new).map(f => f.line), [2], 'the string holding `# for now` is no comment: only line 2');
  assert.deepEqual(comments.blocks, [], 'shadow: recorded, never held');
});
test('K12 over Rust: a raw string holding `// let x = 1;` is no finding, the same line as a comment is one; a pattern rule keyed by an unknown pack does not load', () => {
  const r = slopCheck({ repo: repoOf({ 'src/a.rs': 'pub const A: u8 = 1;\n' }, { 'src/a.rs': 'pub const A: u8 = 1;\npub const R: &str = r#"\n// let x = 1;\n"#;\n// let x = 1;\n' }), base: 'main', rules: [rule('K12')] });
  assert.deepEqual(r.findings.filter(f => f.new).map(f => [f.rule, f.line, f.shadow]), [['K12', 5, true]]);
  const py = slopCheck({ repo: repoOf({ 'src/a.py': 'A = 1\n' }, { 'src/a.py': 'A = 1\n# B = A + 1\n' }), base: 'main', rules: [{ ...rule('K12'), files: ['**/*.py'] }] });
  assert.deepEqual(py.findings, [], 'no py patterns: Python is ruff ERA001 through LP');
  const dir = mkTmp('meta-slop-lang-rules-'), bad = { ...rule('K12'), id: 'P-bad', patterns: { go: ['x'] } };
  fs.mkdirSync(path.join(dir, 'rules', 'slop'), { recursive: true }); fs.writeFileSync(path.join(dir, 'rules', 'slop', 'P-bad.json'), JSON.stringify(bad));
  assert.throws(() => effectiveRules({ projectDir: dir }), /patterns are a list of regexes, or lists by pack id/);
});
test('LP selects ERA001 beside the project\'s own ruff config (which does not select it): the run carries it, ruff gets --extend-select, its finding is LP/ERA001 in shadow', () => {
  const cfg = '[project]\nname = "pkg"\n\n[tool.ruff.lint]\nselect = ["F"]\n', runs = [];
  const head = [{ code: 'ERA001', filename: 'pkg/src/pkg/a.py', location: { row: 2, column: 1 }, end_location: { row: 2, column: 12 }, message: 'Found commented-out code' }];
  const tool = (run, side) => { runs.push(run); return JSON.stringify(side === 'head' ? head : []); };
  const r = slopCheck({ repo: repoOf({ 'pkg/pyproject.toml': cfg, 'pkg/src/pkg/a.py': 'X = 1\n' }, { 'pkg/src/pkg/a.py': 'X = 1\n# Y = X + 1\n' }), base: 'main', rules: [rule('LP')], tool });
  assert.ok(runs.length && runs.every(x => x.select.join() === 'ERA001'), 'every ruff run carries LP\'s select');
  assert.deepEqual(r.findings.filter(f => f.new).map(f => [f.rule, f.line, f.level, f.shadow]), [['LP/ERA001', 2, 'BLOCK', true]]);
  assert.deepEqual(r.blocks, []);
  assert.deepEqual(ruffArgs(['a.py'], ['ERA001']), ['ruff', 'check', '--output-format', 'json', '--no-cache', '--force-exclude', '--extend-select', 'ERA001', 'a.py']);
  assert.ok(!ruffArgs(['a.py']).includes('--extend-select'), 'no select: the project\'s config alone');
});
test('K10 over Python and TypeScript: a two-module Python import cycle and a TS cycle through ./x.js specifiers are findings', () => {
  const base = { 'engine/e/pyproject.toml': '[project]\nname = "e"\n', 'engine/e/src/eng/__init__.py': '', 'engine/e/src/eng/a.py': 'X = 1\n', 'engine/e/src/eng/b.py': 'from eng import a\nY = a.X\n',
    'engine/t/a.ts': 'export const a = 1;\n', 'engine/t/b.ts': "import { a } from './a.js';\nexport const b = a;\n" };
  const head = { 'engine/e/src/eng/a.py': 'from eng import b\nX = 1\n', 'engine/t/a.ts': "import { b } from './b.js';\nexport const a = 1;\nexport const c = () => b;\n" };
  const r = slopCheck({ repo: repoOf(base, head), base: 'main', rules: [rule('K10')] });
  assert.deepEqual(r.blocks.map(b => [b.file, b.msg]).sort(), [
    ['engine/e/src/eng/a.py', 'import cycle: engine/e/src/eng/a.py -> engine/e/src/eng/b.py'],
    ['engine/t/a.ts', 'import cycle: engine/t/a.ts -> engine/t/b.ts'],
  ]);
});
// scratch: NORN-CI-TESTS-PARTS proof run, dropped before merge
