// SloppaChoppa 2 S7 (SPEC 4.5): the rule register - its loader, the rule sentences of a rule file, the drift numbers in the daily report,
// K26 (a new rule sentence with no row, on a diff) and the deferrals that came due (4.7). Synthetic temp repos and project folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRules, effectiveRules, slopCheck } from '../engine/lib/slop/check.mjs';
import { loadRegister, sentences, uncovered, drift, dueDeferrals } from '../engine/lib/slop/register.mjs';
import { renderDaily } from '../engine/lib/slop/daily.mjs';
import { CLASSES, APART } from '../engine/lib/slop/loc.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const writeTree = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
/** a repo: main = base files, feat/x = head files */
function repoOf(base, head) {
  const dir = mkTmp('meta-reg-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  writeTree(dir, base); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x'); writeTree(dir, head); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'head');
  return dir;
}
/** a project folder whose rules/slop/register.json is reg */
function projectWith(reg) {
  const dir = mkTmp('meta-reg-proj-');
  writeTree(dir, { 'rules/slop/register.json': JSON.stringify(reg) });
  return dir;
}

const RULES_MD = [
  '# Working on Kestrel', '', 'Kestrel is a synthetic project used here.', '',
  '## Git', '', '- Never use `git stash`. Its list is shared by every worktree.', '- Commit in small conventional commits (`fix(x): ...`).', '',
  '```', 'Never run this example. It is code.', '```', '<!-- policy:x -->', '| a | table row that is not prose |', '',
  'Follow the code around you: dense one-line\nJavaScript, comments that say why.', ''].join('\n');
const REG = {
  sources: { repo: ['CLAUDE.md'], project: ['rules/team.txt'] },
  prose: { 'CLAUDE.md': ['Kestrel is a synthetic project used here.'] },
  rows: [
    { id: 'D-stash', source: 'CLAUDE.md', text: 'Never use `git stash`.', class: 'mechanical', home: 'hook' },
    { id: 'D-commits', source: 'CLAUDE.md', text: 'Commit in small conventional commits ...', class: 'unchecked', home: 'slop' },
    { id: 'D-style', source: 'CLAUDE.md', text: 'Follow the code around you: dense one-line JavaScript, comments that say why.', class: 'voice', home: 'slop', checks: ['K22', 'K11'] },
    { id: 'D-gone', source: 'rules/team.txt', text: 'A rule that was deleted.', class: 'proxy' },
  ],
};

test('loadRegister: no file is null; a row needs a unique id, a listed source, a quote and a class; its home is one of the homes or absent', () => {
  assert.equal(loadRegister(mkTmp('meta-reg-none-')), null);
  const reg = loadRegister(projectWith(REG));
  assert.deepEqual(reg.rows.map(r => r.id), ['D-stash', 'D-commits', 'D-style', 'D-gone']);
  for (const [bad, want] of [[{ class: 'sometimes' }, /D-x: a row needs a class/], [{ home: 'review' }, /D-x: a row needs a home of slop \| hook \| tests \| ci or none/],
    [{ source: 'README.md' }, /D-x: a row needs a source listed in sources/], [{ text: ' ' }, /D-x: a row needs a quoted text/]]) {
    const row = { id: 'D-x', source: 'CLAUDE.md', text: 'Never use `git stash`.', class: 'mechanical', home: 'hook', ...bad };
    assert.throws(() => loadRegister(projectWith({ ...REG, rows: [row] })), want);
  }
  assert.throws(() => loadRegister(projectWith({ ...REG, rows: [REG.rows[0], REG.rows[0]] })), /D-stash: a row needs a unique id/);
});

test('sentences: prose and list items split into sentences with their line; headings, code fences, comments and tables are no rule text', () => {
  assert.deepEqual(sentences(RULES_MD).map(s => [s.line, s.text]), [
    [3, 'Kestrel is a synthetic project used here.'], [7, 'Never use `git stash`.'], [7, 'Its list is shared by every worktree.'],
    [8, 'Commit in small conventional commits (`fix(x): ...`).'], [16, 'Follow the code around you: dense one-line JavaScript, comments that say why.']]);
  const reg = loadRegister(projectWith(REG));
  // a quote ending in "..." covers the sentences it starts; prose sentences are said once and need no row
  assert.deepEqual(uncovered(reg, 'CLAUDE.md', RULES_MD).map(s => s.text), ['Its list is shared by every worktree.']);
  assert.equal(uncovered(null, 'CLAUDE.md', RULES_MD).length, 5, 'no register: every sentence has no row');
});

test('drift: rules with no check = unchecked rows + sentences with no row; rotten rows; rows with no home; breaches per row from the week of stored checks', () => {
  const reg = loadRegister(projectWith(REG));
  const f = (rule, fp, extra = {}) => ({ rule, fp, new: true, level: 'BLOCK', ...extra });
  const checks = [{ findings: [f('K22', 'a'), f('K11/shim', 'b'), f('K1', 'c')] }, { findings: [f('K22', 'a'), f('K22', 'd'), f('K11', 'e', { shadow: true })] }];
  const d = drift(reg, { 'CLAUDE.md': RULES_MD, 'rules/team.txt': 'Only this rule is left here now.\n' }, checks);
  assert.equal(d.noCheck, 3, 'one unchecked row (D-commits) + two sentences with no row');
  assert.deepEqual(d.noRow.map(s => `${s.source}:${s.line}`), ['CLAUDE.md:7', 'rules/team.txt:1']);
  assert.deepEqual(d.rotten.map(r => r.id), ['D-gone']);
  assert.deepEqual(d.noHome.map(r => r.id), ['D-gone']);
  assert.deepEqual(d.breaches, [{ id: 'D-style', n: 3, by: { K22: 2, K11: 1 } }], 'one per fingerprint; a shadow finding is no breach');
  assert.deepEqual(drift(reg, { 'CLAUDE.md': RULES_MD, 'rules/team.txt': null }).rotten.map(r => r.id), ['D-gone'], 'a source that is gone: its rows are rotten');
});

const loc = { series: [], ref: 'main', head: 'abc1234def', totals: Object.fromEntries(CLASSES.map(c => [c, 1])), apart: Object.fromEntries(APART.map(c => [c, 0])), areas: {}, landings: [] };
const sw = { main: 'main', real: [], empty: [], unrelated: [], dead: [], at_risk: [], remote_merged: [] };
test('the daily report: "rules with no check: n" in the report and its line, the rows behind it and the deferrals that came due', () => {
  const reg = loadRegister(projectWith(REG)), d = drift(reg, { 'CLAUDE.md': RULES_MD, 'rules/team.txt': null }, []);
  const due = [{ file: 'src/a.mjs', line: 3, snippet: '// remove once RM-12 lands', ids: ['RM-12 is done'] }];
  const { markdown, line } = renderDaily(loc, sw, { day: '2026-01-02', register: { ...d, due } });
  assert.match(markdown, /^## Rule register: rules with no check: 2$/m);
  assert.match(markdown, /^- no row: `CLAUDE\.md:7` Its list is shared by every worktree\.$/m);
  assert.match(markdown, /^- unchecked: D-commits /m);
  assert.match(markdown, /^- rotten: D-gone \(rules\/team\.txt\)/m);
  assert.match(markdown, /^- no home: D-gone$/m);
  assert.match(markdown, /^- `src\/a\.mjs:3` RM-12 is done: do the deferred removal \(\/\/ remove once RM-12 lands\)$/m);
  assert.match(line, /; rules with no check: 2$/);
  assert.match(renderDaily(loc, sw, { day: '2026-01-02', register: { error: 'no register (rules/slop/register.json)' } }).markdown, /^## Rule register: no register \(rules\/slop\/register\.json\)$/m);
});

test('K26 on a diff: a new sentence in CLAUDE.md with no row is a WARN; a sentence with a row, an old one and a README sentence are none', () => {
  const k26 = proj => effectiveRules({ projectDir: proj }).filter(r => r.id === 'K26');
  const base = { 'CLAUDE.md': RULES_MD, 'README.md': 'Read me.\n' };
  const head = { 'CLAUDE.md': RULES_MD + '- Never push main yourself.\n- Always say why.\n', 'README.md': 'Read me. A new readme sentence is here.\n' };
  const repo = repoOf(base, head), proj = projectWith({ ...REG, rows: [...REG.rows, { id: 'D-push', source: 'CLAUDE.md', text: 'Never push main yourself.', class: 'mechanical', home: 'hook' }] });
  const r = slopCheck({ repo, base: 'main', head: 'HEAD', rules: k26(proj) });
  assert.deepEqual(r.ran, ['K26']);
  assert.deepEqual(r.findings.filter(f => f.new).map(f => [f.level, f.file, f.line, f.snippet]), [['WARN', 'CLAUDE.md', 19, 'Always say why.']]);
  assert.match(r.findings.find(f => f.new).msg, /say how it is checked .*or mark it unchecked/);
  assert.equal(r.blocks.length, 0);
  assert.ok(loadRules().some(x => x.id === 'K26' && x.level === 'WARN'), 'K26 is a built-in WARN rule');
});

test('dueDeferrals: a deferral whose cited record is done or dropped is due; one citing an open or an unknown record is not', () => {
  const repo = repoOf({ 'src/a.mjs': '// remove once RM-12 lands\nexport const a = 1; // a stop-gap until RM-13 lands\n// for now off (DEC-9)\nexport const t = 2;\n' }, {});
  const states = { 'RM-12': 'done', 'RM-13': 'open', 'DEC-9': null };
  const due = dueDeferrals(repo, 'main', loadRules().find(r => r.id === 'K22'), id => states[id] ?? null);
  assert.deepEqual(due.map(d => [d.file, d.line, d.ids]), [['src/a.mjs', 1, ['RM-12 is done']]]);
});
