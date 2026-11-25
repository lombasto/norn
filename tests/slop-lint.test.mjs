// SloppaChoppa 2 S1b (SPEC 3.1-3.4, 7 S1b): the kind `lint` - one rule (LJ) per language tool, sub-rule ids, levels and shadow in
// Choppa's data, the config read from the merge base, LJ/config-changed, the replay of a retirement, a cold tool cache fails closed.
// S3: LP (ruff, recorded JSON) and LR (clippy, its head log read for real). ESLint's output is recorded (each test hands the check its tool); only the cold-cache test starts npm, offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRules, effectiveRules, slopCheck, explainOf, replay, budget, budgetLines, PROVE, KIND_PARAMS } from '../engine/lib/slop/check.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { LINTERS } from '../engine/lib/slop/lang/index.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
/** a repo: main = base files, feat/x = head files */
function repoOf(base, head) {
  const dir = mkTmp('meta-slop-lint-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  put(dir, base); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x'); put(dir, head); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'head');
  return dir;
}
const LJ = loadRules().find(r => r.id === 'LJ');
const msg = (ruleId, line, message) => ({ ruleId, severity: 2, message, line, column: 1 });
/** a recorded ESLint: side -> [{ filePath, messages }]; every run it is handed is kept in o.runs */
const recorded = (out, o = {}) => (run, side) => { (o.runs ||= []).push({ run, side }); return JSON.stringify(out[side] || []); };

test('LJ: a finding is LJ/<the tool\'s rule>; the levels are Choppa\'s data (today\'s BLOCK set), every other rule the config turns on is shadow', () => {
  const repo = repoOf({ 'a.mjs': 'export const a = 1;\n' }, { 'a.mjs': "import fs from 'node:fs';\nexport const a = b;\nconsole.log(a);\n" });
  const r = slopCheck({ repo, base: 'main', rules: [LJ], tool: recorded({ head: [{ filePath: 'a.mjs', messages: [msg('no-unused-vars', 1, "'fs' is defined but never used."), msg('no-undef', 2, "'b' is not defined."), msg('no-console', 3, 'Unexpected console statement.')] }] }) });
  assert.deepEqual(r.findings.map(f => [f.rule, f.level, !!f.shadow]), [['LJ/no-unused-vars', 'BLOCK', false], ['LJ/no-undef', 'WARN', true], ['LJ/no-console', 'BLOCK', false]]);
  assert.deepEqual(r.blocks.map(b => b.rule), ['LJ/no-unused-vars', 'LJ/no-console'], 'the recommended set runs in shadow: recorded, never held');
  assert.deepEqual(r.ran, ['LJ']);
  for (const id of ['no-unused-vars', 'no-duplicate-imports', 'no-debugger', 'no-console', 'no-warning-comments', 'no-restricted-properties']) assert.equal(LJ.levels[id], 'BLOCK', id);
  assert.notEqual(r.findings[0].fp, slopCheck({ repo, base: 'main', rules: [{ ...LJ, id: 'LX' }], tool: recorded({ head: [{ filePath: 'a.mjs', messages: [msg('no-unused-vars', 1, "'fs' is defined but never used.")] }] }) }).findings[0].fp, 'the fingerprint keys on the sub-rule id');
});

test('LJ: both sides lint with the merge base\'s config; a branch that edits it is LJ/config-changed (BLOCK), and its own config never reaches the run', () => {
  const baseCfg = "export default [{ rules: { 'no-console': 'off' } }];\n", headCfg = 'export default [];\n';
  const repo = repoOf({ 'eslint.config.mjs': baseCfg, 'a.mjs': 'export const a = 1;\n' }, { 'eslint.config.mjs': headCfg, 'a.mjs': 'export const a = 2;\n' });
  const o = {}, r = slopCheck({ repo, base: 'main', rules: [LJ], tool: recorded({}, o) });
  assert.deepEqual(o.runs.map(x => [x.side, x.run.config]), [['head', baseCfg], ['base', baseCfg]], 'the base config, for both sides');
  assert.deepEqual(r.blocks.map(b => [b.rule, b.file, b.level]), [['LJ/config-changed', 'eslint.config.mjs', 'BLOCK']]);
  const plain = repoOf({ 'a.mjs': 'export const a = 1;\n' }, { 'a.mjs': 'export const a = 2;\n' }), o2 = {};
  assert.deepEqual(slopCheck({ repo: plain, base: 'main', rules: [LJ], tool: recorded({}, o2) }).blocks, []);
  assert.equal(o2.runs[0].run.config, null, 'no config at base: LJ\'s own rules alone');
  assert.deepEqual(o2.runs[0].run.rules, LJ.rules);
});

test('LJ: a file that does not parse is LJ/parse (BLOCK); a tool that cannot run is one BLOCK of LJ', () => {
  const repo = repoOf({ 'a.mjs': 'export const a = 1;\n' }, { 'a.mjs': 'export const a = );\n' });
  const bad = { ruleId: null, fatal: true, severity: 2, message: 'Parsing error: Unexpected token )', line: 1, column: 18 };
  const rules = loadRules().filter(r => (r.kind === 'lint' || r.kind === 'ast') && !r.scan);   // LS runs its scanner, not this recorded ESLint output (slop-secrets.test.mjs)
  assert.deepEqual(slopCheck({ repo, base: 'main', rules, tool: recorded({ head: [{ filePath: 'a.mjs', messages: [bad] }] }) }).blocks.map(b => [b.rule, b.line]), [['LJ/parse', 1]]);
  const down = slopCheck({ repo, base: 'main', rules: [LJ], tool: () => { throw new Error('npm ci failed (lock 0123)'); } });
  assert.deepEqual(down.blocks.map(b => [b.rule, b.level, b.msg]), [['LJ', 'BLOCK', 'could not run: npm ci failed (lock 0123)']]);
});

test('explainOf answers a sub-rule: its own text from LJ\'s file, else LJ\'s, the fix naming the ESLint page', () => {
  assert.deepEqual(explainOf('LJ/no-console'), { ...LJ.explain.rules['no-console'], fix: `${LJ.explain.rules['no-console'].fix} (ESLint: https://eslint.org/docs/latest/rules/no-console)` });
  const { rules, ...own } = LJ.explain;
  assert.ok(rules['config-changed'] && rules.parse);
  assert.deepEqual(explainOf('LJ/no-undef'), { ...own, fix: `${own.fix} (ESLint: https://eslint.org/docs/latest/rules/no-undef)` });
  assert.deepEqual(explainOf('LJ/config-changed'), rules['config-changed'], 'no tool page for Choppa\'s own sub-rules');
  assert.equal(explainOf('LX/no-undef'), null);
});

test('overrides.json patches LJ\'s levels (merged by sub-rule) and shadow_rules; K16 (kind shim) has its params row', () => {
  const d = mkTmp('meta-slop-lint-proj-');
  put(d, { 'rules/slop/overrides.json': JSON.stringify({ LJ: { params: { levels: { 'config-changed': 'WARN', 'no-undef': 'BLOCK' }, shadow_rules: [] } }, K16: { params: { exclude: ['gen/**'] } } }) });
  const by = Object.fromEntries(effectiveRules({ projectDir: d }).map(r => [r.id, r]));
  assert.deepEqual(by.LJ.levels, { ...LJ.levels, 'config-changed': 'WARN', 'no-undef': 'BLOCK' });
  assert.deepEqual(by.LJ.shadow_rules, []);
  assert.deepEqual(by.K16.exclude, ['gen/**']);
  assert.deepEqual(KIND_PARAMS.lint, ['files', 'exclude', 'levels', 'shadow_rules']);
  assert.equal('eslint' in KIND_PARAMS || 'swallow' in KIND_PARAMS, false, 'the kinds eslint and swallow are gone');
  put(d, { 'rules/slop/overrides.json': JSON.stringify({ LJ: { params: { rules: {} } } }) });
  assert.throws(() => effectiveRules({ projectDir: d }), /lint takes the params files, exclude, levels, shadow_rules/, 'what ESLint looks for is not a param');
});

test('the replay: per merged branch, the old rule\'s new findings beside its new form\'s, paired by file and line', () => {
  const repo = repoOf({ 'a.mjs': 'export const a = 1;\n' }, { 'a.mjs': 'export const a = 1;\n' });
  git(repo, 'checkout', '-q', '-b', 'feat/y', 'main'); put(repo, { 'b.mjs': '// TODO: wire it\nexport const b = 2; // todo list\n' }); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'y');
  git(repo, 'checkout', '-q', 'main'); git(repo, 'merge', '-q', '--no-ff', '-m', 'merge y', 'feat/y');
  const old = { id: 'KX', level: 'BLOCK', kind: 'pattern', in: ['comment'], patterns: ['\\bTODO\\b'], files: ['**/*.mjs'], explain: LJ.explain, fixture: LJ.fixture, title: 'x' };
  const tool = recorded({ head: [{ filePath: 'b.mjs', messages: [msg('no-warning-comments', 1, "Unexpected 'todo' comment."), msg('no-warning-comments', 2, "Unexpected 'todo' comment.")] }] });
  const rows = replay({ repo, old: 'KX', as: ['LJ/no-warning-comments'], main: 'main', rules: [old, LJ], tool });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'merge y');
  assert.deepEqual([rows[0].old, rows[0].missed], [['b.mjs:1'], []]);
  assert.deepEqual(rows[0].added.map(a => a.split(' ')[0]), ['b.mjs:2'], 'the case-blind core rule adds one: labelled by hand in the table');
});

test('the budget (SPEC 5, PROVE): 1 hit in 50 merges passes BLOCK once rated real, 3 fail it and pass WARN; unrated is n/a, never a pass', () => {
  assert.deepEqual(PROVE, { BLOCK: { merges: 0.02, real: 0.9 }, WARN: { merges: 0.1 } });
  const repo = repoOf({ 'a.py': 'x = 1\n' }, {});
  git(repo, 'checkout', '-q', 'main');
  // 52 merges, oldest first: hit hit, 47 clean, hit, clean clean. HEAD's last 50 hold 1 hit; main~2's last 50 hold 3
  [true, true, ...Array(47).fill(false), true, false, false].forEach((hit, i) => {
    git(repo, 'checkout', '-q', '-b', `f${i}`, 'main'); put(repo, { [`m${i}.py`]: hit ? '# TODO: later\n' : `y${i} = ${i}\n` });
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', `c${i}`); git(repo, 'checkout', '-q', 'main'); git(repo, 'merge', '-q', '--no-ff', '-m', `merge ${i}`, `f${i}`);
  });
  const KX = { id: 'KX', level: 'BLOCK', kind: 'pattern', in: ['comment'], patterns: { py: ['\\bTODO\\b'], rs: ['\\bTODO\\b'] }, shadow_langs: ['py', 'rs'], files: ['**/*.py', '**/*.rs'], explain: LJ.explain, fixture: LJ.fixture, title: 'x' };
  const one = replay({ repo, old: 'KX', as: ['KX'], main: 'main', rules: [KX] }), three = replay({ repo, old: 'KX', as: ['KX'], main: 'main~2', rules: [KX] });
  assert.equal(one.length, 50);
  assert.deepEqual(one.flatMap(r => r.found.map(f => [f.rule, f.file, f.lang])), [['KX', 'm49.py', 'py']]);
  const real = rows => Object.fromEntries(rows.flatMap(r => r.found.map(f => [f.fp, 'real'])));
  const row = (b, lang) => b.find(x => x.rule === 'KX' && x.lang === lang);
  const b1 = row(budget(one, { rules: [KX], ratings: real(one) }), 'py');
  assert.deepEqual([b1.merges, b1.of, b1.findings, b1.real, b1.block, b1.warn], [1, 50, 1, 1, 'pass', 'pass']);
  assert.deepEqual(row(budget(one, { rules: [KX], ratings: real(one) }), 'rs'), { rule: 'KX', lang: 'rs', merges: 0, of: 50, findings: 0, real: 0, rated: 0, unrun: 0, block: 'pass', warn: 'pass', unrated: [] }, 'a language of the rule with no finding meets both');
  const b3 = row(budget(three, { rules: [KX], ratings: real(three) }), 'py');
  assert.deepEqual([b3.merges, b3.findings, b3.block, b3.warn], [3, 3, 'fail', 'pass'], '3 of 50 = 6 %: over BLOCK\'s 2 %, inside WARN\'s 10 %');
  const wrong = budget(one, { rules: [KX], ratings: Object.fromEntries(Object.keys(real(one)).map(k => [k, 'wrong'])) });
  assert.equal(row(wrong, 'py').block, 'fail', 'rated wrong: under 90 % real');
  const none = row(budget(one, { rules: [KX] }), 'py');
  assert.match(none.block, /^n\/a: 1 of 1 findings not rated/);
  assert.equal(none.unrated[0].fp, one.flatMap(r => r.found)[0].fp, 'the unrated findings are listed by fingerprint, the key of the ratings file');
  assert.match(budgetLines(budget(one, { rules: [KX], ratings: real(one) })).join('\n'), /^KX py: merges 1 of 50 \(2 %\), real 1 of 1 \(100 %\): BLOCK pass, WARN pass$/m);
});

test('a check on a cold tool cache with no network holds the merge: LJ could not run (BLOCK), exit 1', () => {
  const repo = repoOf({ 'a.mjs': 'export const a = 1;\n' }, { 'a.mjs': 'export const a = 2;\n' });
  const r = spawnSync(process.execPath, [NORN, 'slop', 'check', '--ci', '--diff', 'main..HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120000,
    env: { ...process.env, META_ROOT: mkTmp('meta-slop-lint-cold-'), npm_config_offline: 'true' } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^BLOCK LJ `\*` could not run: npm ci failed \(lock [0-9a-f]{12}\)/m);
  assert.match(r.stdout, /; could not run: .*\bLJ\b/);
  for (const id of ['K11A', 'K19', 'K2', 'K21', 'T3']) {
    assert.match(r.stdout, new RegExp(`^BLOCK ${id} \`\\*\` could not run: npm ci failed \\(lock [0-9a-f]{12}\\)`, 'm'), `the ast rule ${id}: one BLOCK, ast-grep's tools/ast set is cold too`);
    assert.match(r.stdout, new RegExp(`; could not run: .*\\b${id}\\b`));
  }
});

// ---------- S3: LP (ruff, recorded JSON) and LR (clippy, read from the head's log) ----------
const LP = loadRules().find(r => r.id === 'LP'), LR = loadRules().find(r => r.id === 'LR');
const ruffHit = (filename, row, code, message) => ({ code, filename, location: { row, column: 1 }, end_location: { row, column: 2 }, message });
const PYPROJECT = '[project]\nname = "pkg"\n\n[tool.ruff.lint]\nselect = ["F"]\n';

test('LP: only a new ruff finding counts, as LP/<code> (BLOCK); both sides run under the merge base\'s config; a file under no ruff config gets no run', () => {
  const repo = repoOf({ 'pkg/pyproject.toml': PYPROJECT, 'pkg/src/pkg/a.py': 'import os\nX = 1\n', 'loose/b.py': 'Y = 1\n' },
    { 'pkg/pyproject.toml': PYPROJECT.replace('"pkg"', '"pkg2"'), 'pkg/src/pkg/a.py': 'import os\nimport sys\nX = 1\n', 'loose/b.py': 'import re\nY = 1\n' });
  const os1 = ruffHit('pkg/src/pkg/a.py', 1, 'F401', '`os` imported but unused'), o = {};
  const r = slopCheck({ repo, base: 'main', rules: [LP], tool: recorded({ base: [os1], head: [os1, ruffHit('pkg/src/pkg/a.py', 2, 'F401', '`sys` imported but unused')] }, o) });
  assert.deepEqual(r.blocks.map(b => [b.rule, b.file, b.line, b.level]), [['LP/F401', 'pkg/src/pkg/a.py', 2, 'BLOCK']], 'the old `os` finding is not new; a [project] edit is no config change');
  assert.deepEqual(o.runs.map(x => [x.side, Object.keys(x.run.configs), x.run.configs.pkg.text, x.run.configs.pkg.files]), [['head', ['pkg'], PYPROJECT, ['pkg/src/pkg/a.py']], ['base', ['pkg'], PYPROJECT, ['pkg/src/pkg/a.py']]]);
});

test('LP: a [tool.ruff] edit is LP/config-changed; a file ruff cannot parse is LP/parse (BLOCK)', () => {
  const repo = repoOf({ 'pkg/pyproject.toml': PYPROJECT, 'pkg/src/pkg/a.py': 'X = 1\n' }, { 'pkg/pyproject.toml': PYPROJECT.replace('["F"]', '[]'), 'pkg/src/pkg/a.py': 'X = (\n' });
  const bad = { ...ruffHit('pkg/src/pkg/a.py', 1, null, 'SyntaxError: Expected \')\', found newline'), code: null };
  const r = slopCheck({ repo, base: 'main', rules: [LP], tool: recorded({ base: [], head: [bad] }) });
  assert.deepEqual(r.blocks.map(b => [b.rule, b.file, b.level]).sort(), [['LP/config-changed', 'pkg/pyproject.toml', 'BLOCK'], ['LP/parse', 'pkg/src/pkg/a.py', 'BLOCK']]);
  assert.equal(explainOf('LP/F401').fix, `${LP.explain.fix} (ruff: https://docs.astral.sh/ruff/rules/ (F401))`);
});

test('LR: the head\'s clippy log at {git}/norn/clippy/<head>.log names a touched file: LR/<lint> (BLOCK); a diagnostic on an untouched file is not the branch\'s; no log is LR/no-evidence (WARN)', () => {
  const repo = repoOf({ 'crate/src/lib.rs': 'pub fn f() -> u8 {\n    1\n}\n', 'crate/src/other.rs': 'pub fn g() -> u8 {\n    return 2;\n}\n' }, { 'crate/src/lib.rs': 'pub fn f() -> u8 {\n    return 1;\n}\n' });
  const clippy = (rule, side, o) => LINTERS.clippy.run(rule, side, o);
  const none = slopCheck({ repo, base: 'main', rules: [LR], tool: clippy });
  assert.deepEqual([none.blocks, none.findings.map(f => [f.rule, f.level])], [[], [['LR/no-evidence', 'WARN']]]);
  const ret = file => `warning: unneeded \`return\` statement\n --> ${file}:2:5\n  |\n  = help: for further information visit https://rust-lang.github.io/rust-clippy/master/index.html#needless_return\n  = note: \`-D clippy::needless-return\` implied by \`-D warnings\`\n`;
  const dir = path.join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'norn', 'clippy');
  put(dir, { [`${git(repo, 'rev-parse', 'HEAD')}.log`]: `${ret('src\\lib.rs')}\n${ret('src/other.rs')}\nwarning: \`crate\` (lib) generated 2 warnings\n` });
  const r = slopCheck({ repo, base: 'main', rules: [LR], tool: clippy });
  assert.deepEqual(r.blocks.map(b => [b.rule, b.file, b.line, b.level]), [['LR/clippy::needless_return', 'crate/src/lib.rs', 2, 'BLOCK']]);
  assert.match(explainOf('LR/clippy::needless_return').fix, /\(clippy: https:\/\/rust-lang\.github\.io\/rust-clippy\/master\/index\.html#needless_return\)$/);
});
