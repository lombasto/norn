// SloppaChoppa stage C (RM-45): the text scanner, the finding-shape changes (value / base_value, key: match, shadow), the project
// rules and overrides.json, and the parts of the new kinds the rule fixtures do not reach. Pure functions and temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { effectiveRules, pairFindings, fingerprint, slopCheck, RULES_DIR } from '../engine/lib/slop/check.mjs';
import { checkBranch } from '../engine/lib/slop/runend.mjs';
import { classify, masked, CODE, COMMENT, STRING, QUOTE, helpers, exportsOf, usesOf, commentsIn, isReason } from '../engine/lib/slop/scan.mjs';
import { depsOf } from '../engine/lib/slop/kinds.mjs';
import { eslintConfig, astGrepOut } from '../engine/lib/slop/tools.mjs';
import { record } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const SYNTH = path.join(import.meta.dirname, 'fixtures', 'slop-project');
const at = (t, s, cls) => classify(t)[t.indexOf(s)] === cls;

test('classify: code, comment, string and a quote inside a comment; a regex literal and a template ${} stay code', () => {
  const t = "const a = 'x'; // the user said \"for now\"\nconst r = /'/g, s = `a ${b + 'c'} d`;\n/* block */";
  assert.ok(at(t, 'const a', CODE));
  assert.ok(at(t, "x'", STRING));
  assert.ok(at(t, '// the', COMMENT));
  assert.ok(at(t, 'for now', QUOTE));
  assert.ok(at(t, "/'/g", CODE), 'the quote in a regex literal opens no string');
  assert.ok(at(t, 'b + ', CODE) && at(t, "c'}", STRING) && at(t, ' d`', STRING));
  assert.ok(at(t, 'block', COMMENT));
  const m = masked(t, ['comment'], 'a.mjs');
  assert.equal(m.length, t.length);
  assert.equal(m.split('\n').length, t.split('\n').length, 'newlines kept');
  assert.ok(m.includes('// the user said') && !m.includes('for now') && !m.includes('const'));
  assert.equal(masked('# for now\n', ['comment'], 'README.md'), '# for now\n', 'a doc is all prose');
});

test('helpers, exports and the reason test: the pieces dup (K9), exports (K4) and ast reason (K19) stand on', () => {
  const t = "export const fwd = (p) => String(p).replace(/a/g, 'b');\nfunction iso(d) { return new Date(d).toISOString(); }\nconst x = 1;\nexport class Box {}\n";
  assert.deepEqual(helpers(t).map(h => [h.name, h.body, h.line]), [['fwd', "p => String(p).replace(/a/g, 'b')", 1], ['iso', 'd => new Date(d).toISOString()', 2]]);
  assert.deepEqual(exportsOf(t), [{ name: 'fwd', line: 1 }, { name: 'Box', line: 4 }]);
  assert.equal(usesOf('a$b + a$b + xa$b', 'a$b'), 2, 'a $ in the name is literal, words only');
  assert.equal(commentsIn('a; // one\nb; /* two */\nc;\n', 1, 2), 'one two');
  assert.equal(isReason('gone: the caller retries', ['ignore']).ok, true);
  assert.equal(isReason('ignore: it is fine', ['ignore']).ok, false);
});

test('depsOf: package.json and lock packages, TOML dependency sections and arrays, one per line otherwise; a broken manifest is one entry', () => {
  assert.deepEqual(depsOf('package.json', '{ "dependencies": { "a": "1.0" }, "devDependencies": { "b": "^2" } }'), ['a@1.0', 'b@^2']);
  assert.deepEqual(depsOf('x/package-lock.json', '{ "packages": { "": {}, "node_modules/c": { "version": "3.1" } } }'), ['c@3.1']);
  assert.deepEqual(depsOf('pyproject.toml', '[project]\nname = "g"\ndependencies = [\n  "numpy>=2",\n  "ruff",\n]\n[tool.ruff]\nline = 1\n'), ['numpy>=2', 'ruff']);
  assert.deepEqual(depsOf('Cargo.toml', '[package]\nname = "g"\nversion = "1"\n[dependencies]\nserde = "1.0"\n'), ['g@1', 'serde = "1.0"']);
  assert.deepEqual(depsOf('Cargo.lock', '[[package]]\nname = "a"\nversion = "0.1"\n[[package]]\nname = "b"\nversion = "2"\n'), ['a@0.1', 'b@2']);
  assert.deepEqual(depsOf('requirements.txt', 'numpy==2  # pinned\n\nruff\n'), ['numpy==2', 'ruff']);
  assert.deepEqual(depsOf('package.json', '{ nope'), ['(unparsable) package.json']);
});

test('finding shape: value and base_value; key: match fingerprints the token tree-wide; a shadow rule is recorded, never held', () => {
  const rule = { id: 'X1', level: 'BLOCK' }, f = (line, snippet, more = {}) => ({ file: 'a.mjs', line, msg: 'm', snippet, ...more });
  const got = pairFindings(rule, { head: [f(3, 'grow', { value: 7 }), f(9, 'born', { value: 2 })], base: [f(1, 'grow', { value: 5 })] });
  assert.deepEqual(got.map(x => [x.line, x.new, x.value, x.base_value]), [[3, false, 7, 5], [9, true, 2, undefined]]);
  const key = { id: 'X2', level: 'BLOCK', key: 'match' };
  const k = pairFindings(key, { head: [f(1, 'line one', { token: 'OLD_A' }), f(2, 'line two', { token: 'OLD_A' }), f(4, 'x', { token: 'NEW_B' })], base: [] }, { inBase: t => t === 'OLD_A' });
  assert.deepEqual(k.map(x => [x.token, x.new]), [['OLD_A', false], ['NEW_B', true]], 'one finding per token; new only when the base tree lacks it');
  assert.equal(k[1].fp, fingerprint('X2', '*', 'NEW_B'), 'the fingerprint is the token, not the file or line');
  const s = pairFindings({ ...rule, shadow: true }, { head: [f(1, 'q')], base: [] });
  assert.equal(s[0].shadow, true);
  assert.equal(pairFindings(rule, { head: [f(1, 'q', { level: 'WARN' })], base: [] })[0].level, 'WARN', 'a finding may carry its own level (K4 tests-only)');
});

test('project rules and overrides.json: P-* rules load (id = file name, project kinds only); a patch switches, relevels, shadows and retunes listed params, never replaces text', () => {
  const builtin = effectiveRules().map(r => r.id);
  const eff = effectiveRules({ projectDir: SYNTH }), by = Object.fromEntries(eff.map(r => [r.id, r]));
  assert.ok(by['P-hide'] && by['P-retired'], 'the project rules join the built-ins');
  assert.equal(eff.length, builtin.length + 2 - 1, 'K11 switched off');
  assert.equal(by.K11, undefined);
  assert.equal(by.K16.level, 'WARN');
  assert.equal(by.K22.shadow, true);
  assert.deepEqual(by.K12.exclude, ['**/vendor/**', 'gen/**']);
  const k12 = JSON.parse(fs.readFileSync(path.join(RULES_DIR, 'K12.json'), 'utf8'));
  assert.deepEqual(by.K12.patterns, k12.patterns, 'the text stays the built-in one');
  const proj = (files) => { const d = mkTmp('slop-proj-'); fs.mkdirSync(path.join(d, 'rules', 'slop'), { recursive: true });
    for (const [f, v] of Object.entries(files)) fs.writeFileSync(path.join(d, 'rules', 'slop', f), JSON.stringify(v)); return d; };
  const p = JSON.parse(fs.readFileSync(path.join(SYNTH, 'rules', 'slop', 'P-retired.json'), 'utf8'));
  for (const [files, re] of [
    [{ 'overrides.json': { K12: { patterns: ['x'] } } }, /only enabled, level, shadow and params/],
    [{ 'overrides.json': { K12: { title: 'mine' } } }, /only enabled, level, shadow and params/],
    [{ 'overrides.json': { K12: { params: { patterns: ['.'] } } } }, /takes the params/],
    [{ 'overrides.json': { K12: { params: { fixture: {} } } } }, /takes the params/],
    [{ 'overrides.json': { K14: { params: { argv: ['x'] } } } }, /command takes the params \(none\)/],
    [{ 'overrides.json': { K99: { enabled: false } } }, /no rule K99/],
    [{ 'overrides.json': { K12: { level: 'LOUD' } } }, /level is one of/],
    [{ 'P-other.json': p }, /id is its file name/],
    [{ 'P-run.json': { ...p, id: 'P-run', kind: 'command', argv: ['gen'] } }, /kind one of pattern, junk, imports, ast, lint/],
    [{ 'P-lint.json': { ...p, id: 'P-lint', kind: 'lint', tool: 'eslint', rules: { 'some-plugin/rule': 'error' } } }, /core rules only/],
    [{ 'P-ast.json': { ...p, id: 'P-ast', kind: 'ast', tool: 'eslint', selectors: [{ selector: 'Identifier', message: 'x' }] } }, /P-ast\.json: an ast rule is ast-grep match data \(tool ast-grep\): see rules\/README\.md/],
    [{ 'P-ast.json': { ...p, id: 'P-ast', kind: 'ast', tool: 'ast-grep', match: { js: [{ rule: { kind: 'identifier' }, message: 'x' }] }, selectors: [] } }, /an ast rule is ast-grep match data/],
    [{ 'P-ast.json': { ...p, id: 'P-ast', kind: 'ast', tool: 'ast-grep', match: { go: [{ rule: { kind: 'identifier' }, message: 'x' }] } } }, /an ast rule is ast-grep match data/],
    [{ 'P-ast.json': { ...p, id: 'P-ast', kind: 'ast', tool: 'ast-grep', match: { js: [{ rule: { kind: 'identifier' }, message: 'x', text: '^a' }] } } }, /an ast rule is ast-grep match data/],
    [{ 'P-ast.json': { ...p, id: 'P-ast', kind: 'ast', tool: 'ast-grep', match: { js: [{ rule: { kind: 'identifier' }, message: 'x' }] }, shadow_langs: ['py'] } }, /an ast rule is ast-grep match data/],
  ]) assert.throws(() => effectiveRules({ projectDir: proj(files) }), re, JSON.stringify(files).slice(0, 80));
});

test('the ESLint config is written from data: Choppa\'s core rules, the merge base\'s repo config, then inline config comments off', () => {
  const t = eslintConfig({ rules: { 'no-unused-vars': 'error' } });
  const [head, tail] = t.replace(/^export default \[/, '').replace(/\];\n$/, '').split(', ...[], ').map(s => JSON.parse(s));
  assert.deepEqual(head.rules, { 'no-unused-vars': 'error' });
  assert.equal('rules' in tail, false, 'the tail sets no rule: the ast rules run on ast-grep');
  assert.equal(tail.linterOptions.noInlineConfig, true, 'a file under check cannot switch a rule off: last, so no repo block can');
  assert.ok(!/import|plugins/.test(t), 'no code is loaded');
  const r = eslintConfig({ rules: {}, repo: true });
  assert.match(r, /^import repo from '\.\/repo\.eslint\.config\.mjs';\nexport default \[\{.*\}, \.\.\.repo, \{.*\}\];\n$/s, 'the repo config sits between Choppa\'s rules and the tail');
});

// slop-langs S1 (SPEC 3.4): the kind ast on ast-grep - match data per pack, shadow_langs, fail-closed
const fxRepo = ({ base, head }) => {
  const repo = mkTmp('slop-ast-'), git = (...a) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }); if (r.status) throw new Error(r.stderr); };
  const put = fs2 => { for (const [f, t] of Object.entries(fs2)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); } };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
  put(base); git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-qb', 'feat/x'); put(head); git('add', '-A'); git('commit', '-qm', 'head');
  return repo;
};
const AST = effectiveRules().filter(r => r.kind === 'ast');
test('ast-grep: K2 and K19 find their lines in Python, Rust and TypeScript (shadow); the JS hits stay held; one scan per side, ids <rule>.<pack>.<n>.<language>', () => {
  const want = { K2: { 'src/io.mjs': [1, 2, 4, 6], 'src/io.py': [4, 11, 18], 'src/io.rs': [2, 7, 11], 'src/io.ts': [1, 2, 4] },
    K19: { 'src/a.mjs': [1, 2, 4], 'src/a.py': [4, 12, 19], 'src/a.rs': [4, 11, 18], 'src/a.ts': [1, 2, 4] } };
  for (const rule of AST.filter(r => want[r.id])) {
    const fx = rule.fixture.hit, runs = [], tool = (run, side) => { runs.push([side, run]); return fx.recorded[side] === undefined ? null : JSON.stringify(fx.recorded[side]); };
    const r = slopCheck({ repo: fxRepo(fx), base: 'main', rules: [rule], tool }), got = {};
    for (const f of r.findings.filter(x => x.new)) { (got[f.file] ||= []).push(f.line); assert.equal(!!f.shadow, !f.file.endsWith('.mjs'), `${rule.id} ${f.file}: shadow by language`); }
    assert.deepEqual(got, want[rule.id]);
    assert.deepEqual(runs.map(([s, run]) => [s, run.tool]), [['head', 'ast-grep'], ['base', 'ast-grep']], 'one scan per side');
    assert.ok(runs[0][1].rules.some(x => x.id === `${rule.id}.py.0.Python` && x.language === 'Python') && runs[0][1].rules.some(x => x.id === `${rule.id}.ts.0.TypeScript`));
    assert.ok(r.blocks.every(b => b.file.endsWith('.mjs')), 'a shadow language holds nothing');
  }
});
test('ast-grep fails closed: exit 8 (a rule that does not parse), an ERROR: line at exit 0, output that is not JSON; each is ONE BLOCK could not run per ast rule', () => {
  assert.throws(() => astGrepOut({ status: 8, stdout: '', stderr: 'Error: Cannot parse rule rules.yml\nHelp: x\n╰▻ Kind `no_such_kind` is invalid.\n' }, 'd', 'd/t'), /^Error: ast-grep exited 8: Error: Cannot parse rule rules\.yml \.\.\. ╰▻ Kind `no_such_kind` is invalid\.$/);
  assert.throws(() => astGrepOut({ status: 0, stdout: '', stderr: 'ERROR: nope: The system cannot find the file specified. (os error 2)\n' }, 'd', 'd/t'), /ast-grep exited 0: ERROR: nope/);
  assert.throws(() => astGrepOut({ status: 0, stdout: 'not json\n', stderr: '' }, 'd', 'd/t'), /ast-grep output is not JSON/);
  const m = (file, line, col, id) => JSON.stringify({ text: 'x', file, ruleId: id, range: { start: { line, column: col }, end: { line, column: col + 1 } } });
  assert.deepEqual(JSON.parse(astGrepOut({ status: 0, stdout: [m('t/b.py', 3, 0, 'K2.py.0.Python'), m('t/a.mjs', 0, 4, 'K2.js.0.JavaScript')].join('\n') + '\n', stderr: '' }, 'd', 'd/t')),
    [{ file: 'a.mjs', ruleId: 'K2.js.0.JavaScript', line: 1, column: 5, endLine: 1, text: 'x' }, { file: 'b.py', ruleId: 'K2.py.0.Python', line: 4, column: 1, endLine: 4, text: 'x' }], 'sorted, 1-based, relative');
  const repo = fxRepo({ base: { 'a.mjs': 'export const a = 1;\n' }, head: { 'a.mjs': 'export const a = 2;\n', 'tests/a.test.mjs': 'export const b = 1;\n' } });
  const exit8 = () => astGrepOut({ status: 8, stdout: '', stderr: 'Error: Cannot parse rule rules.yml\n' }, 'd', 'd/t');
  const r = slopCheck({ repo, base: 'main', rules: AST, tool: exit8 });
  assert.deepEqual(r.blocks.map(b => [b.rule, b.file, b.msg]), AST.map(x => [x.id, '*', 'could not run: ast-grep exited 8: Error: Cannot parse rule rules.yml']));
  assert.deepEqual(r.ran, []);
});

test('checkBranch: the rules of the project folder join the check; K22 passes a cited open id and holds a closed one', () => {
  const repo = mkTmp('slop-branch-'), git = (...a) => { const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }); if (r.status) throw new Error(r.stderr); };
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(repo, 'docs')); fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), '# Guide\n'); git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat/x');
  fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), '# Guide\n\nThen `oldtool stop`.\n');
  fs.writeFileSync(path.join(repo, 'a.mjs'), '// for now the retry is off (RM-1)\n// a stop-gap until RM-2 lands\nexport const a = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'head');
  const c = checkBranch({ repo, projectDir: SYNTH, tool: () => null });
  assert.ok(c.result.ran.includes('P-retired') && !c.result.ran.includes('K11'), c.result.ran.join(' '));
  assert.deepEqual(c.result.findings.filter(f => f.rule === 'P-retired').map(f => [f.token, f.new]), [['oldtool stop', true]]);
  assert.equal(c.result.findings.filter(f => f.rule === 'K22').every(f => f.shadow), true, 'the synthetic overrides put K22 in shadow');
  const states = { 'RM-1': 'open', 'RM-2': 'dropped' };
  const r = slopCheck({ repo, base: 'main', rules: effectiveRules().filter(x => x.id === 'K22'), resolve: id => states[id] ?? null });
  assert.deepEqual(r.blocks.map(b => b.line), [2], 'line 1 cites an open item');
  assert.match(r.blocks[0].msg, /RM-2 is dropped$/);
  // the project's own state resolves RM ids from the roadmap's item events (they are not in the records fold): open passes, dropped holds
  const state = mkTmp('slop-state-'), item = (ev, id, data) => record(state, { kind: 'item', ev, id, by: 'controller', data }, { views: false });
  const theme = item('create', undefined, { title: 'T', kind: 'theme' }).id;
  const one = item('create', undefined, { title: 'one', kind: 'item', parent: theme }).id, two = item('create', undefined, { title: 'two', kind: 'item', parent: theme }).id;
  item('drop', two, { why: 'w', ref: 'DEC-1' });
  fs.writeFileSync(path.join(repo, 'a.mjs'), `// for now the retry is off (${one})\n// a stop-gap until ${two} lands\nexport const a = 1;\n`);
  git('add', '-A'); git('commit', '-qm', 'cite the state ids');
  const s = checkBranch({ repo, state, rules: effectiveRules().filter(x => x.id === 'K22'), tool: () => null });
  assert.deepEqual(s.result.blocks.map(b => [b.line, b.msg.split(': ').pop()]), [[2, `${two} is dropped`]], `${one} resolves open from the state`);
});
