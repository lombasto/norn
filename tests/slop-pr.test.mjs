// RM-44 stage B (SloppaChoppa audit section 2 D2, section 4 rows merge-land / Hand PR / Admin merge; RM-38 S3): the PR-side check.
// A `slop` job on every pull request runs `norn slop check --ci --diff <merge base>..HEAD` (rules that read this machine's state are
// skipped by their data flag); merge-land refuses a held branch and writes the stored check's WARN list into the PR body; the daily
// lists every first-parent landing on main that has no stored check, with its findings ("landed unchecked"). Synthetic repos only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRules, slopCheck } from '../engine/lib/slop/check.mjs';
import { hostWrite, findingLine } from '../engine/lib/slop/host.mjs';
import { doorCheck } from '../engine/lib/slop/door.mjs';
import { dailyReport, digestRow } from '../engine/lib/slop/daily.mjs';
import { landedUnchecked } from '../engine/lib/slop/landed.mjs';
import { openPrs } from '../engine/lib/mergeland.mjs';
import { makeGit } from '../engine/lib/dlvgit.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const ROOT = path.join(import.meta.dirname, '..'), NORN = path.join(ROOT, 'engine', 'bin', 'norn.mjs');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
// a commit at a fixed date: the landing window is read from commit dates
const gitAt = (cwd, at, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const commit = (dir, files, msg, at = '2026-11-01T10:00:00Z') => { put(dir, files); git(dir, 'add', '-A'); gitAt(dir, at, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
function repoWith(base = { 'a.txt': 'a\n' }) {
  const dir = mkTmp('meta-slop-pr-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  commit(dir, base, 'base');
  return dir;
}
const noTool = rule => (rule.kind === 'command' ? null : '[]');
const K15 = loadRules().find(r => r.id === 'K15');
// a synthetic WARN rule: a "HACK" marker in a .txt file
const WARN = { id: 'W9', level: 'WARN', kind: 'pattern', title: 'a hack marker', files: ['**/*.txt'], patterns: ['\\bHACK\\b'], fixture: { hit: {}, miss: {} } };

test('the machine flag is rule data: K14 carries it, and a check with machine off skips every rule that has it, whatever its id', () => {
  assert.deepEqual(loadRules().filter(r => r.machine).map(r => r.id), ['K14'], 'K14 reads the machine (norn gen --check): the one machine rule');
  const repo = repoWith(); git(repo, 'checkout', '-q', '-b', 'feat/x'); commit(repo, { 'x.orig': 'junk\n' }, 'x');
  const machineRule = { id: 'X7', level: 'BLOCK', kind: 'command', machine: true, argv: ['gen', '--check'], line: '^PROBLEM (?<file>\\S+): (?<msg>.*) \\[source (?<source>.+)\\]$', fixture: { hit: {}, miss: {} } };
  const called = [], tool = (rule, side) => { called.push(rule.id); return noTool(rule, side); };
  const r = slopCheck({ repo, base: 'main', rules: [K15, machineRule], tool, machine: false });
  assert.deepEqual(r.ran, ['K15']);
  assert.equal(r.skipped.length, 1); assert.equal(r.skipped[0].rule, 'X7'); assert.match(r.skipped[0].why, /machine state/);
  assert.ok(!called.includes('X7'), 'a skipped machine rule never runs its program');
  assert.deepEqual(r.blocks.map(b => b.rule), ['K15']);
  assert.deepEqual(slopCheck({ repo, base: 'main', rules: [K15, machineRule], tool }).ran, ['K15', 'X7'], 'machine on (the default): it runs');
});

test('norn slop check --ci --diff base..HEAD: exit 1 on a BLOCK, the machine rule listed as skipped; exit 0 on a clean diff', () => {
  const repo = repoWith(), base = git(repo, 'rev-parse', 'HEAD'), root = mkTmp('meta-slop-pr-root-');
  git(repo, 'checkout', '-q', '--detach');   // a CI checkout: detached at the PR's head
  const env = { ...process.env, META_ROOT: root }, run = (...a) => spawnSync(process.execPath, [NORN, 'slop', 'check', ...a], { cwd: repo, env, encoding: 'utf8' });
  commit(repo, { 'ok.txt': 'fine\n' }, 'clean');
  let r = run('--ci', '--diff', `${base}..HEAD`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /skipped K14: .*machine state/);
  commit(repo, { 'x.orig': 'junk\n' }, 'junk');
  r = run('--ci', '--diff', `${base}..HEAD`);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^BLOCK K15 `x\.orig`/m);
  assert.match(r.stdout, /slop check: 1 BLOCK on HEAD /);
});

test('the slop workflow: every pull request (no path filter: a required status must always report), the merge base of the PR, a pinned tool cache; the doc says to make it required', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'slop.yml'), 'utf8');
  assert.match(y, /^on:\s*\n\s+pull_request:\s*$/m);
  assert.doesNotMatch(y, /paths-ignore|paths:/);
  assert.match(y, /^ {2}slop:$/m, 'the job (the status) is named slop');
  assert.match(y, /fetch-depth: 0/);
  assert.match(y, /git merge-base "origin\/\$\{\{ github\.base_ref \}\}" HEAD/);
  assert.match(y, /node engine\/bin\/norn\.mjs slop check --ci --diff "\$base\.\.HEAD"/);
  assert.match(y, /META_ROOT: \$\{\{ runner\.temp \}\}\/norn/, 'the tool cache lives under META_ROOT: one path per runner');
  assert.match(y, /actions\/cache@v4[\s\S]*path: \$\{\{ runner\.temp \}\}\/norn\/state\/tools\/npm/);
  // docs/ tracks only images (.gitignore): SloppaChoppa's doc is the rules README
  const docs = fs.readFileSync(path.join(ROOT, 'engine', 'lib', 'slop', 'rules', 'README.md'), 'utf8');
  assert.match(docs, /## On a pull request[\s\S]*required status/i);
  assert.match(docs, /`slop`/);
});

test('merge-land: refuses a held branch; the PR of a clean one carries the WARN list of its stored check in the body', () => {
  const root = mkTmp('meta-slop-pr-ml-'), origin = path.join(root, 'origin'), repo = path.join(root, 'repo'), wt = path.join(root, 'mwt'), state = path.join(root, 'st');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't'); git(repo, 'checkout', '-q', '-b', 'main');
  commit(repo, { 'base.txt': 'b\n' }, 'base'); git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feat/bad'); commit(repo, { 'x.orig': 'junk\n' }, 'bad'); git(repo, 'push', '-q', 'origin', 'feat/bad');
  git(repo, 'checkout', '-q', '-b', 'feat/warn', 'main'); commit(repo, { 'w.txt': 'a HACK here\n' }, 'warn'); git(repo, 'push', '-q', 'origin', 'feat/warn');
  git(repo, 'checkout', '-q', '-b', 'feat/ok', 'main'); commit(repo, { 'ok.txt': 'ok\n' }, 'ok'); git(repo, 'push', '-q', 'origin', 'feat/ok');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
  for (const b of ['feat/bad', 'feat/warn', 'feat/ok']) git(wt, 'merge', '-q', '--no-ff', '-m', 'merge ' + b, 'origin/' + b);
  const ghGit = makeGit((cwd, args) => (args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/o/r.git\n' : git(cwd, ...args) + '\n'));
  const bodies = {};
  const gh = args => {
    if (args[1] === 'list') return { code: 0, out: '[]', err: '' };
    bodies[args[args.indexOf('--head') + 1]] = fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8');
    return { code: 0, out: `https://github.com/o/r/pull/${Object.keys(bodies).length}\n`, err: '' };
  };
  const door = (branch, tip) => doorCheck({ state, repo, branch, head: tip, rules: [K15, WARN], tool: noTool });
  const rs = openPrs({ repo, wt, branches: ['feat/bad', 'feat/warn', 'feat/ok'], git: ghGit, gh, door });
  assert.deepEqual(rs.map(r => [r.branch, r.status]), [['feat/bad', 'refused'], ['feat/warn', 'opened'], ['feat/ok', 'opened']], JSON.stringify(rs));
  assert.match(rs[0].why, /1 open slop BLOCK finding\(s\) at [0-9a-f]{7}/);
  assert.deepEqual(Object.keys(bodies), ['feat/warn', 'feat/ok'], 'no PR for the held branch');
  const tip = git(repo, 'rev-parse', 'feat/warn');
  const warn = doorCheck({ state, repo, branch: 'feat/warn', head: tip, rules: [K15, WARN], tool: noTool }).check.findings.filter(f => f.level === 'WARN');
  assert.equal(warn.length, 1);
  assert.ok(bodies['feat/warn'].includes(`SloppaChoppa at ${tip.slice(0, 7)}: 1 WARN finding(s)`), bodies['feat/warn']);
  assert.ok(bodies['feat/warn'].includes(`- ${findingLine(warn[0])}`), bodies['feat/warn']);
  assert.match(bodies['feat/ok'], /SloppaChoppa at [0-9a-f]{7}: no WARN finding/);
});

test('landed unchecked: every first-parent landing on main since the first stored check with no stored check of its head is listed with its findings', () => {
  const repo = repoWith(), state = mkTmp('meta-slop-pr-st-');
  commit(repo, { 'old.orig': 'x\n' }, 'old direct push, before any stored check', '2026-11-01T11:00:00Z');
  // a lane branch checked at its head, then merged by its PR
  git(repo, 'checkout', '-q', '-b', 'feat/ok'); const ok = commit(repo, { 'ok.txt': 'ok\n' }, 'ok', '2026-11-02T09:00:00Z');
  hostWrite(state, { type: 'check', branch: 'feat/ok', base: git(repo, 'merge-base', 'main', ok), head: ok, hash: 'h', blocks: [], findings: [], at: '2026-11-02T09:30:00Z' });
  git(repo, 'checkout', '-q', 'main'); gitAt(repo, '2026-11-02T10:00:00Z', 'merge', '-q', '--no-ff', '-m', 'Merge pull request #1 from o/feat/ok', 'feat/ok');
  // a hand PR nobody checked, merged by an admin
  git(repo, 'checkout', '-q', '-b', 'hand/pr'); commit(repo, { 'h.orig': 'junk\n' }, 'hand', '2026-11-02T11:00:00Z');
  git(repo, 'checkout', '-q', 'main'); gitAt(repo, '2026-11-02T12:00:00Z', 'merge', '-q', '--no-ff', '-m', 'Merge pull request #2 from o/hand/pr', 'hand/pr');
  const hand = git(repo, 'rev-parse', 'HEAD');
  // a direct push to main
  const direct = commit(repo, { 'd.txt': 'd\n' }, 'direct push', '2026-11-02T13:00:00Z');
  const got = landedUnchecked({ repo, state, rules: [K15], tool: noTool });
  assert.deepEqual(got.map(l => l.sha), [hand, direct], 'newest last; the checked merge and the landing before the first stored check are not listed');
  assert.deepEqual(got[0].findings.filter(f => f.level === 'BLOCK').map(f => `${f.rule} ${f.file}`), ['K15 h.orig']);
  assert.deepEqual(got[1].findings, []);
  assert.match(got[0].subject, /Merge pull request #2/);

  // the daily lists them (report + its one digest line), then lists only the landings after the main it saw
  const now = Date.parse('2026-11-03T06:00:00Z'), daily = () => dailyReport({ repo, state, now, rules: [K15], tool: noTool });
  let r = daily();
  const md = fs.readFileSync(r.file, 'utf8');
  assert.match(md, /## Landed unchecked: 2/);
  assert.ok(md.includes(`- ${hand.slice(0, 7)} Merge pull request #2 from o/hand/pr: 1 BLOCK, 0 WARN`), md);
  assert.ok(md.includes('  - BLOCK K15 `h.orig`'), md);
  assert.ok(md.includes(`- ${direct.slice(0, 7)} direct push: clean`), md);
  assert.match(r.line, new RegExp(`; LANDED UNCHECKED 2: ${hand.slice(0, 7)} \\(1 BLOCK\\), ${direct.slice(0, 7)} \\(clean\\)$`));
  assert.ok(digestRow(state, now).line.includes('LANDED UNCHECKED 2'), 'a digest row, never silent');
  const later = commit(repo, { 'e.orig': 'e\n' }, 'another direct push', '2026-11-03T08:00:00Z');
  r = dailyReport({ repo, state, now: now + 86400e3, rules: [K15], tool: noTool });
  assert.match(r.line, new RegExp(`; LANDED UNCHECKED 1: ${later.slice(0, 7)} \\(1 BLOCK\\)$`), 'the next daily lists only what landed since the main the last one saw');
  r = dailyReport({ repo, state, now: now + 2 * 86400e3, rules: [K15], tool: noTool });
  assert.doesNotMatch(r.line, /LANDED UNCHECKED/);
});
