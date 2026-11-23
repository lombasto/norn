// Gap #7: a monorepo project (project.json subdir) sees only its own subtree - plus the shared root-to-subdir chain where that is
// intended - in every place that walks files, runs git, diffs or decides scope. One fixture (tests/helpers/monorepo.mjs): a repo with
// two sibling projects, apps/alpha (the project) and apps/beta (its bigger neighbour), each with CLAUDE.md, code, tests and docs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanTmp, mkTmp } from './helpers/tmp.mjs';
import { monorepo, SUB, OTHER } from './helpers/monorepo.mjs';
import { discover, projectFiles } from '../engine/lib/instructions.mjs';
import { enforcers } from '../engine/lib/rules.mjs';
import { docsList } from '../engine/dash/docparts.mjs';
import { scan } from '../engine/lib/adopt.mjs';
import { locReport } from '../engine/lib/slop/loc.mjs';
import { sweep } from '../engine/lib/slop/sweep.mjs';
import { slopCmd } from '../engine/lib/slop/cli.mjs';
import { testsCmd } from '../engine/lib/testscli.mjs';
import { mergeConfig } from '../engine/lib/mergecfg.mjs';
import { laneBranch } from '../engine/lib/lanenew.mjs';
import { scopeOf } from '../engine/lib/scope.mjs';
import { doneCheck } from '../engine/lib/dod.mjs';
import { projectHome, inDir } from '../engine/lib/monorepo.mjs';

after(cleanTmp);
const rel = (m, p) => path.relative(m.root, p).replace(/\\/g, '/');
const leaks = (list, m) => list.map(String).filter(x => x.replace(/\\/g, '/').includes(OTHER));

test('fixture: one repo, two sibling projects with their own CLAUDE.md, code, tests and docs; the project is apps/alpha', () => {
  const m = monorepo();
  const files = m.git('ls-files').split('\n');
  for (const f of ['CLAUDE.md', 'apps/CLAUDE.md', `${SUB}/CLAUDE.md`, `${SUB}/tests/alpha.test.mjs`, `${OTHER}/CLAUDE.md`, `${OTHER}/tests/beta.test.mjs`]) assert.ok(files.includes(f), f);
  assert.equal(projectHome(m.project()), m.home);
});

test('instructions scan (git ls-files path): the root -> apps -> apps/alpha chain every session, alpha nested on demand, beta never', () => {
  const m = monorepo(), home = mkTmp('mono-home-');
  m.commit({ [`${SUB}/src/CLAUDE.md`]: '# alpha src\n', [`${OTHER}/src/CLAUDE.md`]: '# beta src\n' }, 'nested');
  const rows = discover(m.project(), { home, git: true }).filter(r => r.kind === 'repo');
  assert.deepEqual(Object.fromEntries(rows.map(r => [rel(m, r.path), r.load])),
    { 'CLAUDE.md': 'session', 'apps/CLAUDE.md': 'session', [`${SUB}/CLAUDE.md`]: 'session', [`${SUB}/src/CLAUDE.md`]: 'on-demand' });
  // the Docs tab lists the scan's files (+ the project's own docs): nothing of beta
  const list = docsList({ v: { rows }, docs: [{ i: 0, tab: 'Guide', path: path.join(m.home, 'docs', 'GUIDE.md'), exists: true }] });
  const paths = list.groups.flatMap(g => g.rows.map(r => r.path));
  assert.ok(paths.some(p => /docs[\\/]GUIDE\.md$/.test(p)));
  assert.deepEqual(leaks(paths, m), []);
});

test('rule ledger enforcement (projectFiles -> enforcers): only alpha\'s tests and the shared CI enforce alpha\'s rules; beta\'s tests never', () => {
  const m = monorepo();
  const files = projectFiles(m.project());
  assert.deepEqual(leaks(files, m), [], 'git ls-files of the folder + .github only');
  assert.ok(files.includes(`${SUB}/tests/alpha.test.mjs`) && files.includes('.github/workflows/ci.yml'));
  const e = enforcers(m.project(), { files });
  assert.deepEqual(e.tests.map(t => t.name), [`${SUB}/tests/alpha.test.mjs`]);
  assert.match(e.ci, /eslint/, 'the shared CI workflow still counts');
  // a whole-repo project (no subdir) keeps every file, as before
  assert.ok(projectFiles(m.project({ subdir: undefined })).includes(`${OTHER}/tests/beta.test.mjs`));
});

test('adopt scan: only alpha\'s files, paths relative to the folder', () => {
  const m = monorepo();
  const f = scan(m.root, { subdir: SUB });
  assert.equal(f.subdir, SUB);
  assert.deepEqual(leaks([JSON.stringify(f)], m), []);
  assert.doesNotMatch(JSON.stringify(f), /beta\.(?:mjs|test\.mjs)|BETA\.md/);
});

test('slop loc: lines of code, areas and landings of alpha\'s folder only (beta has 20x the code and its own landings)', () => {
  const m = monorepo();
  m.commit({ [`${OTHER}/src/more.mjs`]: 'export const x = 1;\n'.repeat(500) }, 'beta grows');
  m.commit({ [`${SUB}/src/alpha.mjs`]: 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n' }, 'alpha grows');
  const r = locReport(inDir(m.root, SUB));
  assert.equal(r.totals.code, 3, 'src/alpha.mjs only');
  assert.equal(r.totals.tests, 2, 'tests/alpha.test.mjs (classed by its path inside the folder)');
  assert.deepEqual(Object.keys(r.areas).sort(), ['.', 'docs', 'src', 'tests']);
  assert.deepEqual(r.landings.map(l => l.subject).sort(), ['alpha grows', 'two projects'], 'beta\'s landing is beta\'s');
  assert.deepEqual(r.landings.find(l => l.subject === 'alpha grows').added, { code: 1 });
  // the CLI: --project of a subdir project counts its folder
  const out = [];
  assert.equal(slopCmd(['loc', '--json'], { out: s => out.push(s), err: () => {}, where: () => ({ project: m.project(), state: m.state }) }), 0);
  assert.equal(JSON.parse(out.join('\n')).totals.code, 3);
  // the whole repo, for contrast
  assert.equal(locReport(m.root).totals.code, 3 + 40 + 500);
});

test('slop sweep: alpha\'s lane branches and worktrees only; beta\'s lane, a beta-only branch and beta\'s dirty worktree are beta\'s', () => {
  const m = monorepo(), wt = n => path.join(path.dirname(m.root), n);
  const branch = (name, files) => { m.git('checkout', '-q', '-b', name, 'main'); m.commit(files, name); m.git('checkout', '-q', 'main'); };
  branch('norn/alpha/ui', { [`${SUB}/src/ui.mjs`]: 'export const ui = 1;\n' });
  branch('norn/beta/api', { [`${OTHER}/src/api.mjs`]: 'export const api = 1;\n' });
  branch('feat/beta-only', { [`${OTHER}/src/x.mjs`]: 'x\n' });
  branch('feat/both', { [`${SUB}/src/y.mjs`]: 'y\n', [`${OTHER}/src/y.mjs`]: 'y\n' });
  m.git('worktree', 'add', '-q', wt('alpha-wt'), 'norn/alpha/ui'); fs.writeFileSync(path.join(wt('alpha-wt'), SUB, 'wip.txt'), 'unsaved\n');
  m.git('worktree', 'add', '-q', wt('beta-wt'), 'norn/beta/api'); fs.writeFileSync(path.join(wt('beta-wt'), OTHER, 'wip.txt'), 'unsaved\n');
  const own = { name: 'alpha', subdir: SUB }, s = sweep(m.root, { own });
  assert.deepEqual(s.real.map(r => r.branch).sort(), ['feat/both', 'norn/alpha/ui']);
  assert.deepEqual(s.at_risk.map(w => w.branch), ['norn/alpha/ui']);
  assert.equal(s.at_risk[0].paths, 1);
  // without own (a whole-repo project) every branch and worktree is listed, as before
  const all = sweep(m.root, {});
  assert.deepEqual(all.real.map(r => r.branch).sort(), ['feat/beta-only', 'feat/both', 'norn/alpha/ui', 'norn/beta/api']);
  assert.equal(all.at_risk.length, 2);
  // the CLI passes the project: --project of a subdir project = its own sweep
  const out = [];
  slopCmd(['sweep', '--json'], { out: s2 => out.push(s2), err: () => {}, where: () => ({ project: m.project(), state: m.state }) });
  assert.deepEqual(JSON.parse(out.join('\n')).real.map(r => r.branch).sort(), ['feat/both', 'norn/alpha/ui']);
});

test('tests tab history (norn tests history): alpha\'s test cases and lines, not beta\'s', () => {
  const m = monorepo(), out = [];
  assert.equal(testsCmd(['history', '--json'], { out: s => out.push(s), err: () => {}, where: () => ({ project: m.project(), state: m.state }) }), 0);
  const last = JSON.parse(out.join('\n')).at(-1);
  assert.deepEqual([last.tests, last.test_files, last.code_lines], [1, 1, 2], 'alpha: 1 test case, 1 test file, 2 code lines (beta: 3 cases, 40 lines)');
});

test('merge gate cwd and lanes: the gate runs from apps/alpha, the scratch and the lane branches are alpha\'s own', () => {
  const m = monorepo(), p = m.project({ merge: { gate: { cmd: 'node --test tests/' } } });
  const c = mergeConfig(p);
  assert.equal(c.gate.dir, SUB);
  assert.match(c.scratch, /-mq-alpha$/);
  assert.equal(laneBranch('ui', p), 'norn/alpha/ui');
  assert.notEqual(mergeConfig(m.neighbour({ merge: { gate: { cmd: 'x' } } })).scratch, c.scratch, 'two projects never share a merge scratch');
});

test('scope guard + DoD: a brief without Scope: stays in apps/alpha; a change to beta is out of scope at Done', async () => {
  const m = monorepo(), brief = path.join(m.state, 'brief.md');
  fs.writeFileSync(brief, '# task\nDo the thing.\n');
  assert.deepEqual(scopeOf({ brief, worktree: m.root, subdir: SUB }).scope, [SUB]);
  m.git('checkout', '-q', '-b', 'norn/alpha/ui');
  m.commit({ [`${SUB}/src/ui.mjs`]: 'export const ui = 1;\n', [`${OTHER}/src/leak.mjs`]: 'oops\n' }, 'ui');
  const logDir = mkTmp('mono-dod-');
  const d = await doneCheck({ worktree: m.root, dod: { ready: { scope: [SUB], tests: null } }, logDir, run: 'RUN-1' });
  assert.deepEqual(d.changed.sort(), [`${SUB}/src/ui.mjs`, `${OTHER}/src/leak.mjs`]);
  assert.deepEqual(d.out_of_scope, [`${OTHER}/src/leak.mjs`]);
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: m.root });
});

test('tests index (norn tests index): alpha\'s test cases and impact map, not beta\'s', () => {
  const m = monorepo(), out = [];
  assert.equal(testsCmd(['index', '--json'], { out: s => out.push(s), err: () => {}, where: () => ({ project: m.project(), state: m.state }) }), 0);
  assert.equal(JSON.parse(out.join('\n')).files, 1, 'tests/alpha.test.mjs only');
  const cs = JSON.parse(fs.readFileSync(path.join(m.state, 'tests', 'cases.json'), 'utf8'));
  assert.ok(cs.cases.length && cs.cases.every(c => c.file === 'tests/alpha.test.mjs'), JSON.stringify(cs.cases.map(c => c.id)));
});
