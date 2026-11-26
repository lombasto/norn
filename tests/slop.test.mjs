// META-SLOP-A (SloppaChoppa slice A): the BLOCK rules at run end, line counts, the git sweep list. Temp git repos, recorded tool output.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRules, effectiveRules, slopCheck, explainOf, EXPLAIN, RULES_DIR } from '../engine/lib/slop/check.mjs';
import { slopPrompt } from '../engine/lib/slop/runend.mjs';
import { hostWrite, openBlocks, slopHolds, slopChecks, slopSeries } from '../engine/lib/slop/host.mjs';
import { record } from '../engine/lib/records.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { startRun } from '../engine/lib/runs.mjs';
import { pickBatch } from '../engine/lib/mergeq.mjs';
import { locReport } from '../engine/lib/slop/loc.mjs';
import { sweep } from '../engine/lib/slop/sweep.mjs';
import { tickSlop, dailyReport } from '../engine/lib/slop/daily.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { settled } from './helpers/settled.mjs';
import { waitFor } from './helpers/wait.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { resolveShim } from '../engine/lib/paths.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const fwd = p => p.split(path.sep).join('/');
/** project.json for norn under META_ROOT = root: its state is <root>/state/kestrel */
function projectFile(root, repo) {
  const f = path.join(root, 'project.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'kestrel', title: 'k', root: fwd(repo), ledger: '${root}/L.md', briefs_dir: '${root}', policy: {} }));
  return f;
}

const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
function writeTree(dir, files) {
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
}
/** a repo: main = base files, feat/x = head files (files absent from head are deleted) */
function fixtureRepo({ base, head }) {
  const dir = mkTmp('meta-slop-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  writeTree(dir, base); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  for (const f of Object.keys(base)) if (!(f in head)) fs.rmSync(path.join(dir, f));
  writeTree(dir, head); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'head');
  return dir;
}
/** a state folder whose stored code signals (<state>/code/signals.json, docs/code-signals.md) hold a fixture's files (K27) */
const signalsState = files => { const s = mkTmp('meta-slop-state-'); fs.mkdirSync(path.join(s, 'code')); fs.writeFileSync(path.join(s, 'code', 'signals.json'), JSON.stringify({ sha: 'abcdef012345', at: '2026-01-02T00:00:00.000Z', basis: 'measured', files })); return s; };
const recordedTool = rec => (rule, side) => (rec?.[side] === undefined ? null : typeof rec[side] === 'string' ? rec[side] : JSON.stringify(rec[side]));

// every built-in rule and the synthetic project rules (tests/fixtures/slop-project): the hit has new findings at the rule's level, the near-miss none
const PROJECT_RULES = path.join(import.meta.dirname, 'fixtures', 'slop-project', 'rules', 'slop');
const projectRules = fs.readdirSync(PROJECT_RULES).filter(f => /^P-.*\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(PROJECT_RULES, f), 'utf8')));
for (const rule of [...loadRules(), ...projectRules]) {
  test(`${rule.id} (${rule.title}): the fixture's hit fires at ${rule.level}, its near-miss does not`, () => {
    for (const [which, want] of [['hit', true], ['miss', false]]) {
      const fx = rule.fixture[which];
      const repo = fixtureRepo(fx);
      const r = slopCheck({ repo, base: 'main', head: 'HEAD', rules: [rule], tool: recordedTool(fx.recorded), state: fx.signals ? signalsState(fx.signals) : null });
      // a lint rule's findings carry their sub-rule's level and id (LJ/no-console); the held ones (not shadow) are what the hit must show
      const level = rule.levels ? 'BLOCK' : rule.level, at = r.findings.filter(f => f.new && f.level === level && !(rule.levels && f.shadow));
      assert.deepEqual(r.ran, [rule.id], `${rule.id} ${which} ran`);
      assert.equal(at.length > 0, want, `${rule.id} ${which}: ${JSON.stringify(r.findings, null, 1)}`);
      assert.equal(r.blocks.length > 0, want && level === 'BLOCK', `${rule.id} ${which}: blocks only at BLOCK`);
      for (const b of at) { assert.equal(b.rule.split('/')[0], rule.id); assert.match(b.fp, /^[0-9a-f]{16}$/); assert.ok(b.file); }
    }
  });
}

// S1a (SPEC 1.3 F5 / F6, 3.4): the check fails closed - a rule that could not run and a file the linter cannot parse are BLOCK findings
const LINT = loadRules().filter(r => (r.kind === 'lint' && r.tool === 'eslint') || r.kind === 'ast');   // the tool rules that read a.mjs (LP / LR: slop-lint.test.mjs)
test('F5: a rule whose detector throws is one BLOCK finding of that rule ("could not run: <why>", fingerprint rule + could-not-run); the result has no skipped list', () => {
  const repo = fixtureRepo({ base: { 'a.mjs': 'export const a = 1;\n' }, head: { 'a.mjs': 'export const a = 2;\n' } });
  const down = () => { throw new Error('npm not found on PATH'); };
  const r = slopCheck({ repo, base: 'main', rules: LINT, tool: down });
  assert.equal('skipped' in r, false, 'skipped leaves the result shape');
  assert.deepEqual(r.ran, []);
  const held = LINT.filter(x => !x.shadow), unrun = r.findings.filter(f => f.unrun);
  assert.deepEqual(r.blocks.map(b => [b.rule, b.level, b.msg]), held.map(x => [x.id, 'BLOCK', 'could not run: npm not found on PATH']), 'every lint rule, the WARN one too');
  assert.deepEqual(unrun.filter(f => f.shadow).map(f => f.rule), LINT.filter(x => x.shadow).map(x => x.id), 'a shadow rule (T4, T5) that could not run is recorded, never held');
  assert.equal(new Set(unrun.map(b => b.fp)).size, LINT.length, 'one fingerprint per rule');
  assert.deepEqual(slopCheck({ repo, base: 'main', rules: LINT, tool: down }).blocks.map(b => b.fp), r.blocks.map(b => b.fp), 'stable: a waiver can name it');
});
test('F6: a file ESLint cannot parse is ONE BLOCK finding with the parser\'s message (not one per lint rule); the same error at base is not new', () => {
  const bad = { filePath: 'a.mjs', messages: [{ ruleId: null, fatal: true, severity: 2, message: 'Parsing error: Unexpected token )', line: 2, column: 11 }] };
  const repo = fixtureRepo({ base: { 'a.mjs': 'export const a = 0;\nconst b = );\n' }, head: { 'a.mjs': 'export const a = 1;\nconst b = );\n' } });
  const r = slopCheck({ repo, base: 'main', rules: LINT, tool: recordedTool({ base: [], head: [bad] }) });
  assert.deepEqual(r.blocks.map(b => [b.file, b.line, b.level]), [['a.mjs', 2, 'BLOCK']], JSON.stringify(r.findings));
  assert.match(r.blocks[0].msg, /does not parse: Parsing error: Unexpected token \)/);
  assert.deepEqual(slopCheck({ repo, base: 'main', rules: LINT, tool: recordedTool({ base: [bad], head: [bad] }) }).blocks, [], 'already broken at base');
});

// RM-27: every finding explains itself -the rule's what / why / fix sits beside the rule, and a rule without it does not load
test('every rule explains itself in plain words: what was found, why the rule exists, what to do; a rule without it does not load', () => {
  const projectDir = path.dirname(path.dirname(PROJECT_RULES)), rules = effectiveRules({ projectDir });
  assert.ok(rules.length >= 21 && rules.some(r => r.id.startsWith('P-')), 'the built-ins and the project rules');
  for (const r of rules) for (const k of EXPLAIN) {
    assert.equal(typeof r.explain?.[k], 'string', `${r.id}: explain.${k}`);
    assert.ok(r.explain[k].length >= 20 && r.explain[k].length <= 300, `${r.id}: explain.${k} is a short sentence or three`);
    assert.deepEqual(explainOf(r.id, projectDir), r.explain);
  }
  assert.equal(explainOf('K99'), null);
  assert.equal(explainOf('P-hide'), null, 'a project rule is read from its project folder');
  const own = mkTmp('meta-slop-prule-'), p = JSON.parse(fs.readFileSync(path.join(PROJECT_RULES, 'P-hide.json'), 'utf8'));
  delete p.explain; fs.mkdirSync(path.join(own, 'rules', 'slop'), { recursive: true }); fs.writeFileSync(path.join(own, 'rules', 'slop', 'P-hide.json'), JSON.stringify(p));
  assert.throws(() => effectiveRules({ projectDir: own }), /P-hide.json: a rule explains itself/, 'a project rule without explain does not load either');
  for (const k of EXPLAIN) {
    const dir = mkTmp('meta-slop-rules-'), r = JSON.parse(fs.readFileSync(path.join(RULES_DIR, 'K2.json'), 'utf8'));
    delete r.explain[k];
    fs.writeFileSync(path.join(dir, 'K2.json'), JSON.stringify(r));
    assert.throws(() => loadRules(dir), new RegExp(`K2.json: a rule explains itself`), `no explain.${k}: the rule does not load`);
  }
});

test('norn slop check: each finding names what / why / fix once per rule and the waiver path with its fingerprint; --json blocks carry explain', () => {
  const fx = { base: { 'a.mjs': 'export const a = 1;\n' }, head: { 'a.mjs': 'export const a = 1;\n', 'a.mjs.orig': 'x\n', 'b.mjs.rej': 'y\n' } };
  const repo = fixtureRepo(fx);
  const c = spawnSync(process.execPath, [NORN, 'slop', 'check', '--diff', 'main..HEAD'], { cwd: repo, encoding: 'utf8', env: { ...process.env, META_ROOT: mkTmp('meta-slop-root-') } });
  assert.equal(c.status, 1, c.stdout + c.stderr);
  const x = explainOf('K15'), out = c.stdout;
  assert.match(out, /^BLOCK K15 `a\.mjs\.orig` /m);
  for (const s of [`what: ${x.what}`, `why:  ${x.why}`, `fix:  ${x.fix}`]) assert.equal(out.split(s).length - 1, 1, `once per rule: ${s}`);
  const fp = /^BLOCK K15 `a\.mjs\.orig` .*\[([0-9a-f]{16})\]$/m.exec(out)[1];
  assert.ok(out.includes(`norn rec add waiver --rule K15 --scope ${fp} --why`), 'the waiver path names the finding');
  const j = spawnSync(process.execPath, [NORN, 'slop', 'check', '--diff', 'main..HEAD', '--json'], { cwd: repo, encoding: 'utf8', env: { ...process.env, META_ROOT: mkTmp('meta-slop-root-') } });
  const blocks = JSON.parse(j.stdout).blocks;
  assert.equal(blocks.length, 2);
  for (const b of blocks) assert.deepEqual(b.explain, x);
  const p = slopPrompt(blocks);
  assert.match(p, /\n- K15 `a\.mjs\.orig`: 1\n  - K15 `a\.mjs\.orig` [^\n]*\n    what: /, 'the resume prompt explains the rule under its first finding');
  assert.equal(p.split(`why:  ${x.why}`).length - 1, 1);
});

test('only new: a finding the base already had never blocks, even in a renamed file; the fingerprint follows the rename', () => {
  const body = 'export function old(f) {\n  try { f(); } catch (e) {}\n}\n';
  const rest = Array.from({ length: 12 }, (_, i) => `export const k${i} = ${i};\n`).join('');   // enough unchanged lines to stay a rename
  const repo = fixtureRepo({ base: { 'src/a.mjs': body + rest }, head: { 'src/a.mjs': body + rest } });
  git(repo, 'mv', 'src/a.mjs', 'src/b.mjs'); git(repo, 'commit', '-q', '-m', 'rename');
  // K2 is an ast rule: ast-grep's recorded answer, one empty catch per copy of body (line 2, and 17 for the twin); both sides scan under the head's path
  const k2 = (file, lines) => lines.map(line => ({ file, ruleId: 'K2.js.0.JavaScript', line, column: 16, endLine: line, text: 'catch (e) {}' }));
  const r = slopCheck({ repo, base: 'main', head: 'HEAD', only: ['K2'], tool: recordedTool({ base: k2('src/b.mjs', [2]), head: k2('src/b.mjs', [2]) }) });
  assert.equal(r.findings.length, 1, 'the old swallow is seen in the renamed file');
  assert.equal(r.findings[0].file, 'src/b.mjs');
  assert.equal(r.findings[0].new, false);
  assert.deepEqual(r.blocks, []);
  fs.appendFileSync(path.join(repo, 'src/b.mjs'), body.replace('old', 'twin'));   // the same swallow written a second time IS new
  git(repo, 'commit', '-qam', 'twin');
  const r2 = slopCheck({ repo, base: 'main', head: 'HEAD', only: ['K2'], tool: recordedTool({ base: k2('src/b.mjs', [2]), head: k2('src/b.mjs', [2, 17]) }) });
  assert.equal(r2.blocks.length, 1);
  assert.equal(r2.blocks[0].line, 17);
});

test('waiver WVR-n: owner or controller (a check-in only applying an answered Q, tests/ruled.test.mjs), why required, scope = a fingerprint or a glob; it clears an open block until it ends', () => {
  const state = mkTmp('meta-slop-w-');
  const block = { rule: 'K2', level: 'BLOCK', file: 'engine/lib/a.mjs', line: 3, fp: 'a1b2c3d4e5f60718', new: true, msg: 'empty catch' };
  hostWrite(state, { type: 'check', branch: 'feat/x', lane: 'x', run: 'RUN-1', base: 'b', head: 'h', hash: 'r1', blocks: [block], findings: [block] });
  assert.equal(openBlocks(state, 'feat/x').length, 1);
  assert.throws(() => record(state, { kind: 'waiver', ev: 'create', by: 'checkin', data: { rule: 'K2', scope: block.fp, why: 'x y' } }), /owner answer: pass --q Q-n/);
  assert.throws(() => record(state, { kind: 'waiver', ev: 'create', by: 'owner', data: { rule: 'K2', scope: block.fp } }), /why/);
  const cli = spawnSync(process.execPath, [NORN, 'rec', 'add', 'waiver', '--state', state, '--as', 'controller', '--rule', 'K2', '--scope', 'engine/lib/*.mjs',
    '--why', 'the owner asked for this fallback (DIR-9)', '--until', '2999-01-01T00:00:00Z'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), 'WVR-1');
  assert.deepEqual(openBlocks(state, 'feat/x'), [], 'the glob waiver clears it');
  assert.equal(openBlocks(state, 'feat/x', { now: Date.parse('3000-01-01') }).length, 1, 'past its until the waiver no longer counts');
  record(state, { kind: 'waiver', ev: 'revoke', id: 'WVR-1', by: 'owner', data: {} });
  assert.equal(openBlocks(state, 'feat/x').length, 1, 'a revoked waiver no longer counts');
  record(state, { kind: 'waiver', ev: 'create', by: 'owner', data: { rule: 'K2', scope: block.fp, why: 'reviewed: the caller retries' } });
  assert.deepEqual(openBlocks(state, 'feat/x'), [], 'a fingerprint waiver clears it');
  hostWrite(state, { type: 'check', branch: 'feat/x', base: 'b', head: 'h2', hash: 'r1', blocks: [], findings: [] });
  assert.equal(slopHolds(state)['feat/x'], undefined, 'a clean check drops the hold');
});

test('run end: a fake lane run that ends DONE with a BLOCK finding is resumed ONCE with the list; its merge is refused until waived or fixed', async () => {
  const state = mkTmp('meta-slop-run-'), root = path.dirname(path.dirname(state));
  const repo = path.join(root, 'repo'), wt = path.join(root, 'wt'), notes = path.join(root, 'NOTES.md'), brief = path.join(root, 'brief.md');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  fs.writeFileSync(path.join(wt, 'a.txt.orig'), 'left by a merge\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'oops');
  fs.writeFileSync(brief, 'mode: done\n');
  const id = startRun({ state, locksDir: path.join(root, 'locks'), executor: 'fake', lane: 'x', worktree: wt, notes, brief, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0, trigger_on_exit: false }, budget: {} }).run;
  const next = await waitFor(() => loadState(state).items[id]?.resume?.next, { what: 'the slop resume' });
  await waitFor(() => settled(loadState(state).items[next]), { what: 'the resumed run ends' });
  assert.equal(slopChecks(state).length, 1, 'the resumed run end reads the check stored at the same head and rule set (S2): no second check');
  assert.equal(loadState(state).items[id].resume.slop, 1);
  assert.match(fs.readFileSync(notes, 'utf8'), /prompt: Norn's slop check found 1 BLOCK finding\(s\)[^\n]*\n- K15 `a\.txt\.orig`: 1\n  - K15 `a\.txt\.orig` /, 'the resume carries the list (the path in backticks)');
  assert.match(fs.readFileSync(path.join(state, 'results', id, 'slop-blocks.md'), 'utf8'), /^- K15 `a\.txt\.orig` junk name/, 'the full list is in the named file');
  assert.equal(loadState(state).items[next].resume, undefined, 'a second BLOCK is not resumed again: the check-in decides');
  assert.deepEqual(openBlocks(state, 'feat/x').map(b => b.rule), ['K15']);
  const brief2 = ['merge-brief', '--project', projectFile(root, repo), '--lane', 'x', '--branch', 'feat/x', '--worktree', wt, '--notes', notes, '--out', path.join(root, 'MB.md'), '--sha'];
  const mb = () => spawnSync(process.execPath, [NORN, ...brief2, git(wt, 'rev-parse', 'HEAD')], { encoding: 'utf8', env: { ...process.env, META_ROOT: root } });
  let r = mb();
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.match(r.stdout, /REFUSED: merge-brief feat\/x: 1 open slop BLOCK/);
  assert.deepEqual(pickBatch([{ id: 'DLV-1', gate: 'batch', word: 'clean', tip: 'abc', lane: 'x', branch: 'feat/x', slop: 1 }], { cfg: { batch_max: 4 }, mq: { red: {} }, writer: () => null, door: () => 1 }), []);
  record(state, { kind: 'waiver', ev: 'create', by: 'owner', data: { rule: 'K15', scope: '*.orig', why: 'kept on purpose: the merge test reads it' } });
  r = mb(); assert.equal(r.status, 0, r.stdout + r.stderr);
  record(state, { kind: 'waiver', ev: 'revoke', id: 'WVR-1', by: 'owner', data: {} });
  git(wt, 'rm', '-q', 'a.txt.orig'); git(wt, 'commit', '-q', '-m', 'fix');
  const c = spawnSync(process.execPath, [NORN, 'slop', 'check', '--state', state], { cwd: wt, encoding: 'utf8' });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /slop check: nothing to check: /, 'the fix leaves the branch with no net change (SPEC 1.3 F3); the clean check is stored');
  assert.equal(mb().status, 0, 'fixed: the merge may be staged');
});

const gitAt = (cwd, iso, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const lines = n => Array.from({ length: n }, (_, i) => `l${i}`).join('\n') + '\n';

test('loc: non-blank lines by git per class (generated, vendored, fixtures apart), area and language; one point per day; churn per landing + the big flag', () => {
  const repo = mkTmp('meta-slop-loc-');
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeTree(repo, { 'engine/lib/a.mjs': 'const a = 1;\n\n  \nexport { a };\nlet b;\n', 'tests/a.test.mjs': lines(2), 'README.md': '# r\n\n', 'cfg.json': '{}\n',
    'engine/dash/vendor/v.js': lines(5), 'tests/fixtures/f.txt': lines(4), 'package-lock.json': lines(3) });
  git(repo, 'add', '-A'); gitAt(repo, '2026-10-30T10:00:00Z', 'commit', '-q', '-m', 'first');
  git(repo, 'checkout', '-q', '-b', 'feat/big');
  writeTree(repo, { 'engine/lib/b.mjs': lines(2000) }); git(repo, 'add', '-A'); gitAt(repo, '2026-11-01T09:00:00Z', 'commit', '-q', '-m', 'big');
  git(repo, 'checkout', '-q', 'main'); gitAt(repo, '2026-11-01T10:00:00Z', 'merge', '-q', '--no-ff', '-m', 'merge: feat/big', 'feat/big');
  const r = locReport(repo, { since: '2026-10-30', until: '2026-11-01' });
  assert.deepEqual(r.totals, { code: 2003, tests: 2, docs: 1, config: 1 });
  assert.deepEqual(r.apart, { generated: 3, vendored: 5, fixtures: 4 });
  assert.deepEqual(r.areas['engine/lib'], { code: 2003 });
  assert.equal(r.languages.JavaScript.code, 2003); assert.equal(r.languages.JavaScript.tests, 2);
  assert.deepEqual(r.series.map(p => [p.day, p.totals.code]), [['2026-10-30', 3], ['2026-10-31', 3], ['2026-11-01', 2003]]);
  const m = r.landings.find(l => l.subject === 'merge: feat/big');
  assert.deepEqual([m.added.code, m.deleted.code, m.big], [2000, 0, true]);
  assert.equal(r.landings.find(l => l.subject === 'first').big, false);
});

test('sweep: merge-tree sorts branches real / empty / conflicting / merged; dead worktrees, work at risk (dirty, half-merged), merged remote branches', () => {
  const state = mkTmp('meta-slop-sw-'), root = path.dirname(path.dirname(state)), repo = path.join(root, 'repo'), remote = path.join(root, 'origin.git');
  fs.mkdirSync(repo);
  const old = '2026-10-01T10:00:00Z', at = (...a) => gitAt(repo, old, ...a);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeTree(repo, { 'a.txt': 'a\n' }); git(repo, 'add', '-A'); at('commit', '-q', '-m', 'a');
  git(repo, 'branch', 'feat/merged');
  git(repo, 'checkout', '-q', '-b', 'feat/real'); writeTree(repo, { 'r.txt': 'r\n' }); git(repo, 'add', '-A'); at('commit', '-q', '-m', 'r');
  git(repo, 'checkout', '-q', '-b', 'feat/clash', 'main'); writeTree(repo, { 'a.txt': 'clash\n' }); at('commit', '-qam', 'clash');
  git(repo, 'checkout', '-q', '-b', 'feat/empty', 'main'); writeTree(repo, { 'a.txt': 'a2\n' }); at('commit', '-qam', 'same as main');
  git(repo, 'checkout', '-q', 'main'); writeTree(repo, { 'a.txt': 'a2\n' }); at('commit', '-qam', 'main moves');
  git(repo, 'branch', 'feat/live', 'feat/merged');
  git(root, 'init', '-q', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-q', 'origin', 'main', 'feat/merged', 'feat/real');
  const wt = n => path.join(root, n);
  git(repo, 'worktree', 'add', '-q', wt('dead'), 'feat/merged');
  git(repo, 'worktree', 'add', '-q', wt('risk'), 'feat/real'); fs.writeFileSync(path.join(wt('risk'), 'wip.txt'), 'unsaved\n');
  git(repo, 'worktree', 'add', '-q', wt('half'), 'feat/clash'); spawnSync('git', ['merge', 'main'], { cwd: wt('half') });
  git(repo, 'worktree', 'add', '-q', wt('live'), 'feat/live');
  record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'live', worktree: fwd(wt('live')) } });
  const s = sweep(repo, { state, now: Date.parse('2027-01-01') });
  const by = list => Object.fromEntries(list.map(x => [x.branch, x]));
  assert.deepEqual(Object.keys(by(s.real)).sort(), ['feat/clash', 'feat/real']);
  assert.equal(by(s.real)['feat/clash'].conflicts, true); assert.equal(by(s.real)['feat/real'].conflicts, false);
  assert.deepEqual(s.empty.map(x => [x.branch, x.why]).sort(), [['feat/empty', 'adds nothing'], ['feat/live', 'merged'], ['feat/merged', 'merged']]);
  assert.deepEqual(s.dead.map(x => path.basename(x.path)), ['dead'], 'clean, adds nothing, idle, no live run (live is skipped)');
  const risk = Object.fromEntries(s.at_risk.map(x => [path.basename(x.path), x]));
  assert.deepEqual(Object.keys(risk).sort(), ['half', 'risk']);
  assert.equal(risk.half.merging, true); assert.equal(risk.half.unmerged, 1); assert.equal(risk.risk.paths, 1);
  assert.deepEqual(s.remote_merged, ['origin/feat/merged']);
});

test('daily: the tick starts `norn slop daily` once a day; the report has absolute numbers beside every %, and the digest carries ONE slop line', () => {
  const state = mkTmp('meta-slop-day-'), root = path.dirname(path.dirname(state)), repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  writeTree(repo, { 'engine/lib/a.mjs': lines(100) }); git(repo, 'add', '-A'); gitAt(repo, '2026-10-30T10:00:00Z', 'commit', '-q', '-m', 'a');
  writeTree(repo, { 'engine/lib/a.mjs': lines(150), 'tests/a.test.mjs': lines(10) }); git(repo, 'add', '-A'); gitAt(repo, '2026-11-08T10:00:00Z', 'commit', '-q', '-m', 'more');
  const now = Date.parse('2026-11-09T06:00:00Z'), p = { name: 'kestrel', file: path.join(root, 'project.json'), root: repo, policy: {} };
  const spawned = [], spawnFn = (exe, args) => { spawned.push(args); return { pid: 42 }; };
  assert.equal(tickSlop(p, state, { metaCmd: NORN, spawnFn, now }), 'slop daily: started pid 42');
  assert.deepEqual(spawned[0].slice(1), ['slop', 'daily', '--project', p.file, '--state', state]);
  assert.equal(tickSlop(p, state, { metaCmd: NORN, spawnFn, now: now + 60e3 }), null, 'started 1 min ago: not again');
  const env = { ...process.env, HOME: root, USERPROFILE: root, META_ROOT: root };
  const { line, file } = dailyReport({ repo, state, env, now });
  const md = fs.readFileSync(file, 'utf8');
  assert.match(md, /\| code \| 150 \| \+50 \(\+50\.0 %\) \|/);
  assert.match(md, /\| engine\/lib \| 150 \| \+50 \(\+50\.0 %\) \|/);
  assert.match(line, /^slop 2026-11-09: meter \d+ (?:Tended|Weedy|Sloppy|Slopified|Full slop); code 150 \+50 \(\+50\.0 %\) in 7 d, tests 10; big landings 0; branches: 0 real/);
  // slop-meter S1: the day's series point carries the meter, the report its section
  const pt = slopSeries(state).days['2026-11-09'].meter;
  assert.ok(Number.isFinite(pt.score) && typeof pt.band === 'string' && Array.isArray(pt.top), JSON.stringify(pt));
  assert.match(md, /^## Meter: [\d.]+ \w/m);
  assert.equal(tickSlop(p, state, { metaCmd: NORN, spawnFn, now: now + 3600e3 }), null, "today's report exists");
  const d = digest(state, p, { now, dlv: [] });
  assert.deepEqual(d.sections.slop, [{ id: 'slop', line }]);
  assert.ok(renderDigest(d).includes(`## 9 SloppaChoppa (1)\n- ${line}\n`),'one row in the digest view');
});

test("the lint tool set's installer: npm >= 10's npm.cmd (the entry in a SET variable) resolves to node + npm-cli.js, no shell", () => {
  const shim = String.raw`C:\nodejs\npm.cmd`, entry = String.raw`C:\nodejs\node_modules\npm\bin\npm-cli.js`, node = String.raw`C:\other\node.exe`;
  const text = ['@ECHO OFF', 'SETLOCAL', String.raw`SET "NODE_EXE=%~dp0\node.exe"`, 'IF NOT EXIST "%NODE_EXE%" (', '  SET "NODE_EXE=node"', ')',
    String.raw`SET "NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js"`, '"%NODE_EXE%" "%NPM_CLI_JS%" %*', ''].join('\r\n');
  const vfs = { readText: () => text, isFile: p => p === entry };
  assert.deepEqual(resolveShim(shim, ['ci', '--ignore-scripts'], { platform: 'win32', execPath: node, fs: vfs }),
    { exe: node, args: [entry, 'ci', '--ignore-scripts'] });
});
