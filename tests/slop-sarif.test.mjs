// RM-a-63 (sarif-source): the lint kind's tool `sarif` - a project rule reads the SARIF 2.1.0 file a project tool wrote for the head
// and for the merge base ({git}/... path templates, never run), each failing result on a touched file a finding <id>/<ruleId> at its
// SARIF level through the rule's levels; new-only; no head file = <id>/no-evidence, no base file = every result new + <id>/no-base;
// a file that is not SARIF 2.1.0 = the fail-closed "could not run". Synthetic repos and synthetic SARIF only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { slopCheck, effectiveRules, explainOf } from '../engine/lib/slop/check.mjs';
import { LINTERS } from '../engine/lib/slop/lang/index.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
/** a repo: main = base files, feat/x = head files */
function repoOf(base, head) {
  const dir = mkTmp('meta-slop-sarif-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  put(dir, base); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x'); put(dir, head); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'head');
  return dir;
}
const recorded = rec => (rule, side) => (rec[side] === undefined ? null : typeof rec[side] === 'string' ? rec[side] : JSON.stringify(rec[side]));
const fromFiles = (rule, side, o) => LINTERS.sarif.run(rule, side, o);

/** a synthetic SARIF log: one run of tool "scan" with rules [{ id, level? }] and results [{ ruleId, uri, line, text, level?, kind?, ... }] */
const sarif = (results, rules = []) => ({ version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  runs: [{ tool: { driver: { name: 'scan', rules: rules.map(r => ({ id: r.id, ...(r.level ? { defaultConfiguration: { level: r.level } } : {}) })) } },
    results: results.map(({ uri, line, text, base, ...x }) => ({ message: { text }, locations: [{ physicalLocation: { artifactLocation: { uri, ...(base ? { uriBaseId: base } : {}) }, ...(line ? { region: { startLine: line } } : {}) } }], ...x })) }] });
const hit = (uri, line, ruleId = 'hardcoded-token', extra = {}) => ({ ruleId, uri, line, text: 'a token is written in the code', level: 'error', ...extra });

// the worked example of rules/README.md, read from it: P-scan reads {git}/norn/sarif/<sha>.sarif; errors hold, notes warn, a missing file warns
const README = fs.readFileSync(path.join(import.meta.dirname, '..', 'engine', 'lib', 'slop', 'rules', 'README.md'), 'utf8');
const RULE = JSON.parse(/```json\n([\s\S]*?)```/.exec(README.slice(README.indexOf('A worked example')))[1]);

test('the fixture: the hit is a new P-scan/<ruleId> at its level (error -> BLOCK); the near-miss (an old result on a moved line, a result on an untouched file) is none', () => {
  for (const [which, want] of [['hit', [['P-scan/hardcoded-token', 'src/a.py', 2, 'BLOCK', true]]], ['miss', []]]) {
    const fx = RULE.fixture[which], r = slopCheck({ repo: repoOf(fx.base, fx.head), base: 'main', rules: [RULE], tool: recorded(fx.recorded) });
    assert.deepEqual(r.ran, ['P-scan'], which);
    assert.deepEqual(r.findings.filter(f => f.new).map(f => [f.rule, f.file, f.line, f.level, f.new]), want, which);
  }
});

test('the files a project tool wrote: the head\'s and the merge base\'s by sha; new-only; levels by ruleId, then by SARIF level; a rename keeps its old result old', () => {
  const repo = repoOf({ 'src/a.py': 'A = 1\nOLD = "k"\n', 'src/old.mjs': 'export const k = "k";\n', 'src/c.py': 'C = 1\n' },
    { 'src/a.py': 'A = 2\nOLD = "k"\nNEW = "k2"\nN = 3\n', 'src/c.py': 'C = 2\n' });
  git(repo, 'mv', 'src/old.mjs', 'src/new.mjs'); git(repo, 'commit', '-q', '-m', 'rename');
  const dir = path.join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'norn', 'sarif');
  const head = git(repo, 'rev-parse', 'HEAD'), base = git(repo, 'merge-base', 'main', 'HEAD');
  put(dir, {
    [`${base}.sarif`]: JSON.stringify(sarif([hit('src/a.py', 2), hit('src/old.mjs', 1)])),
    [`${head}.sarif`]: JSON.stringify({ version: '2.1.0', runs: [{
      tool: { driver: { name: 'scan', rules: [{ id: 'hardcoded-token' }, { id: 'style', defaultConfiguration: { level: 'note' } }, { id: 'loud' }] } },
      originalUriBaseIds: { REPO: { uri: `file:///${repo.replace(/\\/g, '/').replace(/^\//, '')}/` } },
      results: [
        { ruleId: 'hardcoded-token', level: 'error', message: { text: 'a token is written in the code' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.py' }, region: { startLine: 2 } } }] },   // old: base had it on the same line text
        { ruleIndex: 0, level: 'error', message: { text: 'a token is written in the code' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src%2Fa.py', uriBaseId: 'REPO' }, region: { startLine: 3 } } }] },
        { ruleId: 'style', message: { id: 'm', arguments: ['N'] }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/a.py' }, region: { startLine: 4 } } }] },
        { ruleId: 'loud', level: 'note', message: { text: 'loud on purpose' }, locations: [{ physicalLocation: { artifactLocation: { uri: './src/c.py' }, region: { startLine: 1 } } }] },
        { ruleId: 'hardcoded-token', kind: 'pass', message: { text: 'checked' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/c.py' } } }] },
        { ruleId: 'hardcoded-token', level: 'error', message: { text: 'a token is written in the code' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/new.mjs' }, region: { startLine: 1 } } }] },
        { ruleId: 'hardcoded-token', level: 'error', message: { text: 'not ours' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'src/untouched.py' }, region: { startLine: 1 } } }] },
        { ruleId: 'hardcoded-token', level: 'error', message: { text: 'no file at all' } },
      ] }] }).replace('"id":"style","defaultConfiguration"', '"id":"style","messageStrings":{"m":{"text":"name {0} is too short"}},"defaultConfiguration"'),
  });
  const rule = { ...RULE, levels: { ...RULE.levels, loud: 'BLOCK' } };
  const r = slopCheck({ repo, base: 'main', rules: [rule], tool: fromFiles });
  assert.deepEqual(r.findings.map(f => [f.rule, f.file, f.line, f.level, f.new, f.msg]).sort((a, b) => a[1].localeCompare(b[1]) || a[2] - b[2]), [
    ['P-scan/hardcoded-token', 'src/a.py', 2, 'BLOCK', false, 'a token is written in the code'],
    ['P-scan/hardcoded-token', 'src/a.py', 3, 'BLOCK', true, 'a token is written in the code'],
    ['P-scan/style', 'src/a.py', 4, 'WARN', true, 'name N is too short'],
    ['P-scan/loud', 'src/c.py', 1, 'BLOCK', true, 'loud on purpose'],
    ['P-scan/hardcoded-token', 'src/new.mjs', 1, 'BLOCK', false, 'a token is written in the code'],
  ], 'the rule default level of style (note) maps to WARN; loud is BLOCK by its ruleId; a pass, an untouched file and a result with no file are none');
  assert.deepEqual(r.blocks.map(b => b.rule), ['P-scan/hardcoded-token', 'P-scan/loud']);
});

test('no SARIF file for the head is P-scan/no-evidence (WARN); none for the merge base counts every result new and says so once (P-scan/no-base)', () => {
  const repo = repoOf({ 'src/a.py': 'TOKEN = "t0k"\n' }, { 'src/a.py': 'TOKEN = "t0k"\nB = 1\n' });
  const none = slopCheck({ repo, base: 'main', rules: [RULE], tool: fromFiles });
  assert.deepEqual([none.blocks, none.findings.map(f => [f.rule, f.level, f.file])], [[], [['P-scan/no-evidence', 'WARN', '*']]]);
  const dir = path.join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'norn', 'sarif');
  put(dir, { [`${git(repo, 'rev-parse', 'HEAD')}-scan.sarif`]: JSON.stringify(sarif([hit('src/a.py', 1)])) });
  const r = slopCheck({ repo, base: 'main', rules: [RULE], tool: fromFiles });
  assert.deepEqual(r.findings.map(f => [f.rule, f.level, f.file, f.new]), [['P-scan/hardcoded-token', 'BLOCK', 'src/a.py', true], ['P-scan/no-base', 'WARN', '*', true]]);
  assert.match(r.findings[1].msg, /^no sarif file for the merge base [0-9a-f]{12} \(none at \{git\}\/norn\/sarif\/\{head\}\*\.sarif\): every result on a touched file counts as new$/);
  assert.equal(explainOf('P-scan/no-base'), null, 'a project rule explains itself from its file (no project dir here)');
});

test('a file that is not SARIF 2.1.0 is the fail-closed BLOCK "could not run" of the rule', () => {
  const repo = repoOf({ 'src/a.py': 'A = 1\n' }, { 'src/a.py': 'A = 2\n' });
  const dir = path.join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'norn', 'sarif'), head = git(repo, 'rev-parse', 'HEAD');
  const cases = [
    ['{ not json', /^could not run: not SARIF 2\.1\.0: .*\.sarif: /],
    [JSON.stringify({ ...sarif([]), version: '2.0.0' }), /^could not run: not SARIF 2\.1\.0: version is "2\.0\.0"$/],
    [JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'scan' } } }] }), /^could not run: not SARIF 2\.1\.0: runs\[0\]\.results is null: the tool's results are unknown$/],
    [JSON.stringify(sarif([{ ...hit('src/a.py', 1), level: 'fatal' }])), /^could not run: not SARIF 2\.1\.0: runs\[0\]\.results\[0\]\.level is "fatal"$/],
    [JSON.stringify(sarif([{ ...hit('src/a.py', 1), ruleId: undefined }])), /^could not run: not SARIF 2\.1\.0: runs\[0\]\.results\[0\] names no rule/],
    [JSON.stringify(sarif([hit('src/a.py', 1)])).replace('"startLine":1', '"startLine":0'), /startLine 0 \(an integer from 1\)$/],
  ];
  for (const [text, re] of cases) {
    put(dir, { [`${head}.sarif`]: text });
    const r = slopCheck({ repo, base: 'main', rules: [RULE], tool: fromFiles });
    assert.deepEqual(r.findings.map(f => [f.rule, f.level, f.file]), [['P-scan', 'BLOCK', '*']], text);
    assert.match(r.findings[0].msg, re);
    assert.deepEqual(r.ran, [], 'a rule that could not run is not in ran');
  }
  // a recorded log goes through the same check (the fixtures replay what the file held)
  assert.throws(() => LINTERS.sarif.parse('{"version":"2.1.0","runs":null}', []), /^Error: not SARIF 2\.1\.0: runs is not an array/);
});

test('a project rule of tool sarif loads from rules/slop/P-*.json; without source log and its templates it does not', () => {
  const proj = mkTmp('meta-slop-sarif-proj-'), own = path.join(proj, 'rules', 'slop');
  put(own, { 'P-scan.json': JSON.stringify(RULE) });
  assert.equal(effectiveRules({ projectDir: proj }).find(r => r.id === 'P-scan').tool, 'sarif');
  assert.equal(explainOf('P-scan/hardcoded-token', proj).what, RULE.explain.what);
  put(own, { 'P-scan.json': JSON.stringify({ ...RULE, log: [] }) });
  assert.throws(() => effectiveRules({ projectDir: proj }), /a sarif rule reads the file a project tool wrote: source "log" and log/);
});
