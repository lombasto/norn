// SloppaChoppa 2 S1c (SPEC 3.5): a fix by code instead of a resume round - `norn slop fix` (applies, commits nothing), the run end's
// autofix commit and re-check, the revert when the fix turns the Done check red, the demotion of a class after two reverts in ten,
// outcomes.jsonl. Synthetic temp git repos only; recorded ESLint output; the fake executor for the run end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRules } from '../engine/lib/slop/check.mjs';
import { checkBranch } from '../engine/lib/slop/runend.mjs';
import { planFixes, applyFixes, fixSubject } from '../engine/lib/slop/fix.mjs';
import { hostWrite, slopChecks, slopHolds, slopOutcomes, fixOff } from '../engine/lib/slop/host.mjs';
import { digestRow } from '../engine/lib/slop/daily.mjs';
import { startRun } from '../engine/lib/runs.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { waitFor } from './helpers/wait.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
const commit = (dir, files, msg) => { put(dir, files); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
const init = dir => { git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false'); };
/** a repo on main (a.txt) with a branch feat/x holding the head files; returns its folder */
function branchRepo(head) {
  const dir = mkTmp('meta-slopfix-');
  init(dir); commit(dir, { 'a.txt': 'a\n' }, 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x'); commit(dir, head, 'head');
  return dir;
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const open = c => c.result.blocks;
// the secrets scan (LS, every added line) finds nothing: an empty SARIF 2.1.0 log; the other tools an empty JSON list
const EMPTY_SARIF = JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'gitleaks' } }, results: [] }] });
const noTool = r => (r.kind === 'command' ? null : r.tool === 'sarif' ? EMPTY_SARIF : '[]');

test('K1: trailing whitespace and a blank line at the end of an added file are fixed in the worktree; nothing is committed', () => {
  const dir = branchRepo({ 'b.txt': 'one  \ntwo\t\nthree\n\n\n' }), head = git(dir, 'rev-parse', 'HEAD'), rules = loadRules();
  const c = checkBranch({ repo: dir, rules, tool: noTool });
  assert.deepEqual(open(c).map(f => [f.rule, f.line, f.msg]).sort(), [['K1', 1, 'trailing whitespace'], ['K1', 2, 'trailing whitespace'], ['K1', 4, 'new blank line at EOF']]);
  const plan = planFixes({ repo: dir, base: c.base, open: open(c), rules, tool: noTool });
  assert.equal(plan.fixed.length, 3); assert.deepEqual(plan.left, []);
  assert.deepEqual(applyFixes(dir, plan), ['b.txt']);
  assert.equal(read(dir, 'b.txt'), 'one\ntwo\nthree\n');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit');
  assert.equal(fixSubject(plan.fixed), 'style(slop): autofix 3 findings (K1 3)');
});

test('LJ: an unused import specifier is removed by ESLint\'s own suggestion; an unused parameter (same suggestion, not an import) is left', () => {
  const text = "import { a, b } from './x.mjs';\nimport { c } from './y.mjs';\nexport const q = b;\nexport function f(u) { return 2; }\n";
  const dir = branchRepo({ 'm.mjs': text }), rules = loadRules();
  const msg = (name, at, range) => ({ ruleId: 'no-unused-vars', line: at, column: 1, endLine: at, endColumn: 2, message: `'${name}' is defined but never used.`,
    suggestions: [{ messageId: 'removeVar', desc: `Remove unused variable '${name}'.`, fix: { range, text: '' } }] });
  const ia = text.indexOf('a,'), ic = text.indexOf("import { c }"), iu = text.indexOf('u)');
  const report = JSON.stringify([{ filePath: 'm.mjs', messages: [msg('a', 1, [ia, ia + 2]), msg('c', 2, [ic, ic + "import { c } from './y.mjs';".length]), msg('u', 4, [iu, iu + 1])] }]);
  const tool = (r, side) => (r.kind === 'command' ? null : r.tool === 'eslint' && side === 'head' ? report : noTool(r));   // recorded ESLint output
  const c = checkBranch({ repo: dir, rules, tool });
  assert.deepEqual(open(c).map(f => f.rule + ':' + f.line), ['LJ/no-unused-vars:1', 'LJ/no-unused-vars:2', 'LJ/no-unused-vars:4']);
  const plan = planFixes({ repo: dir, base: c.base, open: open(c), rules, tool });
  assert.deepEqual(plan.fixed.map(f => f.line), [1, 2]);
  assert.deepEqual(plan.left.map(x => [x.f.line, x.why]), [[4, 'no edit for it']]);
  applyFixes(dir, plan);
  assert.equal(read(dir, 'm.mjs'), "import {  b } from './x.mjs';\nexport const q = b;\nexport function f(u) { return 2; }\n", 'the specifier, and the whole line of the last one');
});

test('a file the worktree changed since HEAD is never edited', () => {
  const dir = branchRepo({ 'b.txt': 'one  \n' }), rules = loadRules();
  const c = checkBranch({ repo: dir, rules, tool: noTool });
  fs.writeFileSync(path.join(dir, 'b.txt'), 'one  \nmine\n');
  const plan = planFixes({ repo: dir, base: c.base, open: open(c), rules, tool: noTool });
  assert.deepEqual(plan.fixed, []); assert.match(plan.left[0].why, /differs from HEAD/);
});

test('norn slop fix: prints what it fixed, commits nothing, exit 0', () => {
  const dir = branchRepo({ 'b.txt': 'one  \n' }), head = git(dir, 'rev-parse', 'HEAD');
  const r = spawnSync(process.execPath, [NORN, 'slop', 'fix', '--repo', dir], { encoding: 'utf8', windowsHide: true, env: { ...process.env, META_ROOT: mkTmp('meta-slopfix-root-') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^fixed K1 `b\.txt:1` trailing whitespace/m);
  assert.match(r.stdout, /slop fix: 1 finding fixed in 1 file \(K1 1\); nothing committed/);
  assert.equal(read(dir, 'b.txt'), 'one\n');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

test('demotion: two reverts in the last ten fixes of a class switch it off, said once on the digest\'s slop line', () => {
  const state = mkTmp('meta-slopfix-st-'), f = { rule: 'K1', fp: 'f1', file: 'b.txt', line: 1 }, w = (fix, action) => hostWrite(state, { type: 'outcome', branch: 'feat/x', head: 'h0', fix, action, findings: [f] }).off;
  assert.deepEqual(w('c1', 'autofix'), []); assert.deepEqual(w('c1', 'reverted'), []);
  for (const c of ['c2', 'c3', 'c4']) w(c, 'autofix');
  assert.deepEqual([...fixOff(state)], [], 'one revert in ten');
  w('c5', 'autofix');
  assert.deepEqual(w('c5', 'reverted'), ['K1'], 'the second revert');
  assert.deepEqual([...fixOff(state)], ['K1']);
  assert.deepEqual(w('c6', 'reverted'), [], 'already off: not said again');
  assert.equal((digestRow(state).line.match(/autofix OFF for K1/g) || []).length, 1);
  assert.equal(slopOutcomes(state).length, 8);
  const dir = branchRepo({ 'b.txt': 'one  \n' }), rules = loadRules(), c = checkBranch({ repo: dir, rules, tool: noTool });
  const plan = planFixes({ repo: dir, base: c.base, open: open(c), rules, tool: noTool, off: fixOff(state) });
  assert.deepEqual(plan.left.map(x => x.why), ['autofix off for this class']);
});

// the run end: a lane worktree on feat/x whose branch adds b.txt with trailing whitespace (K1, fixable) and the Done check's script
async function runEnd(chk) {
  const state = mkTmp('meta-slopfix-run-'), root = path.dirname(path.dirname(state));
  const repo = path.join(root, 'repo'), wt = path.join(root, 'wt'), notes = path.join(root, 'NOTES.md'), brief = path.join(root, 'brief.md');
  fs.mkdirSync(repo); init(repo); commit(repo, { 'a.txt': 'a\n' }, 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  const head = commit(wt, { 'b.txt': 'keep  \n', 'chk.txt': chk }, 'b');
  fs.writeFileSync(brief, 'mode: done\n');
  const id = startRun({ state, locksDir: path.join(root, 'locks'), executor: 'fake', lane: 'x', worktree: wt, notes, brief, hbMs: 150, staleMs: 3000,
    dod: { ready: { scope: ['**'], tests: '`node chk.txt`' } }, policy: { auto_resume_max: 0, trigger_on_exit: false }, budget: {} }).run;
  return { state, wt, notes, head, id };
}

test('run end: a branch whose only BLOCK findings are fixable ends with no resume and a stored check of the fixed head', async () => {
  const { state, wt, head, id } = await runEnd('process.exit(0)\n');
  await waitFor(() => settled(loadState(state).items[id]), { what: 'the run ends' });
  const it = loadState(state).items[id], top = git(wt, 'rev-parse', 'HEAD');
  assert.equal(it.end.outcome, 'done', JSON.stringify(it.end.why));
  assert.equal(it.end.autofix.subject, 'style(slop): autofix 1 finding (K1 1)');
  assert.equal(it.resume, undefined, 'no resume');
  assert.notEqual(top, head);
  assert.equal(git(wt, 'rev-parse', 'HEAD^'), head);
  assert.equal(git(wt, 'log', '-1', '--format=%s'), 'style(slop): autofix 1 finding (K1 1)');
  assert.equal(read(wt, 'b.txt'), 'keep\n');
  const c = slopChecks(state).find(x => x.head === top);
  assert.ok(c, 'the fixed head is checked and stored');
  assert.deepEqual(c.findings.filter(f => f.level === 'BLOCK' && !f.shadow), []);
  assert.equal(slopHolds(state)['feat/x'], undefined, 'nothing holds the branch');
  assert.deepEqual(slopOutcomes(state).map(o => [o.rule, o.action, o.head, o.fix]), [['K1', 'autofix', head, top]]);
});

test('run end: a fix that turns the Done check red is undone and its findings go to the resume', async () => {
  const { state, wt, notes, head, id } = await runEnd("process.exit(require('fs').readFileSync('b.txt', 'utf8') === 'keep  \\n' ? 0 : 1)\n");
  const next = await waitFor(() => loadState(state).items[id]?.resume?.next, { what: 'the one resume' });
  await waitFor(() => settled(loadState(state).items[next]), { what: 'the resumed run ends' });
  assert.equal(loadState(state).items[id].resume.slop, 1);
  assert.equal(git(wt, 'rev-parse', 'feat/x'), head, 'the branch ref is back at the unfixed head');
  assert.equal(read(wt, 'b.txt'), 'keep  \n');
  assert.deepEqual(slopOutcomes(state).map(o => [o.rule, o.action]), [['K1', 'autofix'], ['K1', 'reverted'], ['K1', 'resume']], 'the resume\'s end does not fix the same head again');
  assert.match(fs.readFileSync(notes, 'utf8'), /Norn's slop check found 1 BLOCK finding\(s\)[^]*- K1 `b\.txt:1`/);
});
