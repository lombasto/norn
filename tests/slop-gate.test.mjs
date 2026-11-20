// RM-44 stage A (SloppaChoppa audit section 2, D1-D7): the gate fails closed. Every check is stored (checks.jsonl, keyed on branch,
// head and the rule-set hash); merge-brief, the merge queue and merge-land run the check when no stored one fits; every run end that
// leaves commits is checked; K14 counts only generated files whose source the diff touches; the sweep survives unrelated histories;
// a batch's merged result is checked against main. Synthetic temp git repos only; the fake executor for the run end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadRules, slopCheck, rulesHash } from '../engine/lib/slop/check.mjs';
import { hostWrite, slopHolds, slopChecks, slopDir } from '../engine/lib/slop/host.mjs';
import { doorCheck, doorWhy, storedCheck } from '../engine/lib/slop/door.mjs';
import { sweep } from '../engine/lib/slop/sweep.mjs';
import { tickSlop, digestRow } from '../engine/lib/slop/daily.mjs';
import { pickBatch, batchSlop } from '../engine/lib/mergeq.mjs';
import { openPrs } from '../engine/lib/mergeland.mjs';
import { makeGit } from '../engine/lib/dlvgit.mjs';
import { startRun } from '../engine/lib/runs.mjs';
import { loadState, record } from '../engine/lib/records.mjs';
import { guardRows } from '../engine/lib/guard.mjs';
import { waitFor } from './helpers/wait.mjs';
import { settled } from './helpers/settled.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const fwd = p => p.split(path.sep).join('/');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const put = (dir, files) => { for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); } };
const commit = (dir, files, msg) => { put(dir, files); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
/** a repo on main with base files; returns its folder */
function repoWith(base = { 'a.txt': 'a\n' }) {
  const dir = mkTmp('meta-slopgate-');
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'config', 'core.autocrlf', 'false');
  commit(dir, base, 'base');
  return dir;
}
const noTool = rule => (rule.kind === 'command' ? null : '[]');   // K14 has nothing to say in these repos; ESLint finds nothing (an empty JSON list)
const stateDir = () => mkTmp('meta-slopgate-st-');

test('D5: every check appends one line to checks.jsonl (branch, base, head, rule-set hash, the new findings of every level); holds.json stays the BLOCK view', () => {
  const state = stateDir();
  const block = { rule: 'K2', level: 'BLOCK', file: 'a.mjs', line: 3, fp: 'a1b2c3d4e5f60718', new: true, msg: 'empty catch' };
  const warn = { rule: 'W1', level: 'WARN', file: 'a.mjs', line: 9, fp: '0000aaaa1111bbbb', new: true, msg: 'a warning' };
  const old = { ...warn, fp: '2222cccc3333dddd', new: false };
  hostWrite(state, { type: 'check', branch: 'feat/x', lane: 'x', run: 'RUN-1', base: 'b1', head: 'h1', hash: 'r1', blocks: [block], findings: [block, warn, old] });
  hostWrite(state, { type: 'check', branch: 'feat/x', base: 'b1', head: 'h2', hash: 'r1', blocks: [], findings: [warn] });
  const lines = fs.readFileSync(path.join(slopDir(state), 'checks.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[0].branch, lines[0].base, lines[0].head, lines[0].hash, lines[0].lane, lines[0].run], ['feat/x', 'b1', 'h1', 'r1', 'x', 'RUN-1']);
  assert.deepEqual(lines[0].findings.map(f => f.fp), [block.fp, warn.fp], 'new findings of every level; an old one is not stored');
  assert.ok(lines[0].at);
  assert.deepEqual(slopChecks(state).map(c => c.head), ['h1', 'h2']);
  assert.equal(slopHolds(state)['feat/x'], undefined, 'the clean second check drops the BLOCK view');
  assert.throws(() => hostWrite(state, { type: 'check', branch: 'feat/x', base: 'b', head: 'h', blocks: [], findings: [] }), /rule-set hash/);
});

test('D1 door: an unchecked head is checked (no stored check is no pass); a checked-clean head passes from its line; a changed rule set makes it stale', () => {
  const repo = repoWith(), state = stateDir();
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  const bad = commit(repo, { 'a.txt.orig': 'left by a merge\n' }, 'oops');
  let d = doorCheck({ state, repo, branch: 'feat/x', head: bad, tool: noTool });
  assert.equal(d.ran, true, 'nothing stored: the door ran the check');
  assert.deepEqual(d.open.map(b => b.rule), ['K15']);
  assert.equal(slopChecks(state).length, 1);
  git(repo, 'rm', '-q', 'a.txt.orig'); git(repo, 'commit', '-q', '-m', 'fix');
  const good = git(repo, 'rev-parse', 'HEAD');
  d = doorCheck({ state, repo, branch: 'feat/x', head: good, tool: noTool });
  assert.equal(d.ran, true); assert.deepEqual(d.open, []);
  d = doorCheck({ state, repo, branch: 'feat/x', head: good, tool: noTool });
  assert.equal(d.ran, false, 'checked clean at this head with this rule set: read, not re-run');
  assert.equal(slopChecks(state).length, 2);
  const rules = loadRules().map(r => (r.id === 'K15' ? { ...r, rev: (r.rev || 1) + 1 } : r));
  assert.notEqual(rulesHash(rules), rulesHash(loadRules()), 'an edited rule changes the hash');
  d = doorCheck({ state, repo, branch: 'feat/x', head: good, rules, tool: noTool });
  assert.equal(d.ran, true, 'a changed rule set makes the stored check stale');
  assert.equal(slopChecks(state).at(-1).hash, rulesHash(rules));
  // the hold view alone never passes a head: a branch with no hold entry and no stored check is checked
  const state2 = stateDir();
  assert.equal(doorCheck({ state: state2, repo, branch: 'feat/x', head: bad, tool: noTool }).open.length, 1);
});

/** project.json under META_ROOT = root (state <root>/state/kestrel) */
function projectFile(root, repo) {
  const f = path.join(root, 'project.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'kestrel', title: 'k', root: fwd(repo), ledger: '${root}/L.md', briefs_dir: '${root}', policy: {} }));
  return f;
}

test('D1 merge-brief: refuses an unchecked head that has a BLOCK finding (it runs the check); accepts the checked-clean head', () => {
  const root = mkTmp('meta-slopgate-mb-'), repo = path.join(root, 'repo'), wt = path.join(root, 'wt'), state = path.join(root, 'state', 'kestrel');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  commit(repo, { 'a.txt': 'a\n' }, 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  const bad = commit(wt, { 'a.txt.orig': 'left by a merge\n' }, 'oops');
  const pf = projectFile(root, repo);
  const mb = sha => spawnSync(process.execPath, [NORN, 'merge-brief', '--project', pf, '--lane', 'x', '--branch', 'feat/x', '--worktree', wt, '--notes', path.join(root, 'N.md'),
    '--out', path.join(root, 'MB.md'), '--sha', sha], { encoding: 'utf8', env: { ...process.env, META_ROOT: root } });
  assert.ok(!fs.existsSync(path.join(state, 'slop', 'holds.json')), 'no hold entry: the old path read this as clean');
  let r = mb(bad);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /REFUSED: merge-brief feat\/x: 1 open slop BLOCK finding\(s\) at [0-9a-f]{7}/);
  assert.equal(slopChecks(state).at(-1).head, bad, 'the door stored its check');
  git(wt, 'rm', '-q', 'a.txt.orig'); git(wt, 'commit', '-q', '-m', 'fix');
  r = mb(git(wt, 'rev-parse', 'HEAD'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('D1 merge queue: pickBatch checks an unchecked row at its sha and leaves a held one out; a checked-clean row is picked', () => {
  const repo = repoWith(), state = stateDir();
  git(repo, 'checkout', '-q', '-b', 'feat/bad'); const bad = commit(repo, { 'x.orig': 'junk\n' }, 'bad');
  git(repo, 'checkout', '-q', '-b', 'feat/ok', 'main'); const ok = commit(repo, { 'ok.txt': 'ok\n' }, 'ok');
  git(repo, 'checkout', '-q', 'main');
  const row = (id, branch, tip) => ({ id, gate: 'batch', word: 'clean', tip, lane: branch.slice(5), branch, repo, into: 'main' });
  const rows = [row('DLV-1', 'feat/bad', bad), row('DLV-2', 'feat/ok', ok)];
  const door = (r, sha) => doorCheck({ state, repo: r.repo, branch: r.branch, head: sha, tool: noTool }).open.length;
  const pick = pickBatch(rows, { cfg: { batch_max: 4 }, mq: { red: {} }, stateDir: state, writer: () => null, door });
  assert.deepEqual(pick.map(p => p.id), ['DLV-2']);
  assert.deepEqual(slopChecks(state).map(c => c.branch).sort(), ['feat/bad', 'feat/ok'], 'both were checked at the door');
  const failing = () => { throw new Error('no main'); };
  assert.deepEqual(pickBatch(rows, { cfg: { batch_max: 4 }, mq: { red: {} }, stateDir: state, writer: () => null, door: failing }), [], 'a check that cannot run picks nothing');
});

test('D1 merge-land: refuses a lane branch whose pushed head has an open BLOCK; opens the PR for a checked-clean one', () => {
  const root = mkTmp('meta-slopgate-ml-'), origin = path.join(root, 'origin'), repo = path.join(root, 'repo'), wt = path.join(root, 'mwt'), state = path.join(root, 'st');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, repo); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't'); git(repo, 'checkout', '-q', '-b', 'main');
  commit(repo, { 'base.txt': 'b\n' }, 'base'); git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'feat/bad'); commit(repo, { 'x.orig': 'junk\n' }, 'bad'); git(repo, 'push', '-q', 'origin', 'feat/bad');
  git(repo, 'checkout', '-q', '-b', 'feat/ok', 'main'); commit(repo, { 'ok.txt': 'ok\n' }, 'ok'); git(repo, 'push', '-q', 'origin', 'feat/ok');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'main');
  for (const b of ['feat/bad', 'feat/ok']) git(wt, 'merge', '-q', '--no-ff', '-m', 'merge ' + b, 'origin/' + b);
  const ghGit = makeGit((cwd, args) => (args[0] === 'remote' && args[1] === 'get-url' ? 'https://github.com/o/r.git\n' : git(cwd, ...args) + '\n'));
  const created = [];
  const gh = args => { if (args[1] === 'list') return { code: 0, out: '[]', err: '' }; created.push(args[args.indexOf('--head') + 1]); return { code: 0, out: `https://github.com/o/r/pull/${created.length}\n`, err: '' }; };
  const door = (branch, tip) => doorCheck({ state, repo, branch, head: tip, tool: noTool });
  const rs = openPrs({ repo, wt, branches: ['feat/bad', 'feat/ok'], git: ghGit, gh, door });
  assert.deepEqual(rs.map(r => [r.branch, r.status]), [['feat/bad', 'refused'], ['feat/ok', 'opened']], JSON.stringify(rs));
  assert.match(rs[0].why, /1 open slop BLOCK finding\(s\) at [0-9a-f]{7}/);
  assert.deepEqual(created, ['feat/ok']);
});

test('D1 run end: a lane run that ends STOPPED with commits is checked and its check stored (no resume for a stopped end)', async () => {
  const state = mkTmp('meta-slopgate-run-'), root = path.dirname(path.dirname(state));
  const repo = path.join(root, 'repo'), wt = path.join(root, 'wt'), notes = path.join(root, 'NOTES.md'), brief = path.join(root, 'brief.md');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  commit(repo, { 'a.txt': 'a\n' }, 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  const head = commit(wt, { 'a.txt.orig': 'left by a merge\n' }, 'oops');
  fs.writeFileSync(brief, 'mode: stopped\n');
  const id = startRun({ state, locksDir: path.join(root, 'locks'), executor: 'fake', lane: 'x', worktree: wt, notes, brief, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0, trigger_on_exit: false }, budget: {} }).run;
  await waitFor(() => settled(loadState(state).items[id]), { what: 'the stopped run ends' });
  const c = slopChecks(state).find(x => x.run === id);
  assert.ok(c, 'the stopped end was checked');
  assert.equal(c.head, head);
  assert.deepEqual(c.findings.map(f => f.rule), ['K15']);
  assert.equal(slopHolds(state)['feat/x']?.run, id, 'its BLOCK holds the branch');
  assert.equal(loadState(state).items[id].resume, undefined, 'a stopped end is not resumed for slop');
});

test('D1 run end: a red Done check and a BLOCK go back as ONE resume carrying both lists', async () => {
  const state = mkTmp('meta-slopgate-dod-'), root = path.dirname(path.dirname(state));
  const repo = path.join(root, 'repo'), wt = path.join(root, 'wt'), notes = path.join(root, 'NOTES.md'), brief = path.join(root, 'brief.md');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  commit(repo, { 'a.txt': 'a\n' }, 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  commit(wt, { 'a.txt.orig': 'left by a merge\n' }, 'oops');
  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'uncommitted\n');   // the Done check's red: an untracked file
  fs.writeFileSync(brief, 'mode: done\n');
  const id = startRun({ state, locksDir: path.join(root, 'locks'), executor: 'fake', lane: 'x', worktree: wt, notes, brief, hbMs: 150, staleMs: 3000,
    dod: { ready: { scope: ['**'], tests: '`node -e 0`' } }, policy: { auto_resume_max: 0, trigger_on_exit: false }, budget: {} }).run;
  const next = await waitFor(() => loadState(state).items[id]?.resume?.next, { what: 'the one resume' });
  await waitFor(() => settled(loadState(state).items[next]), { what: 'the resumed run ends' });
  const res = loadState(state).items[id].resume;
  assert.equal(res.slop, 1); assert.ok(res.dod, 'the resume names both');
  const txt = fs.readFileSync(notes, 'utf8');
  assert.match(txt, /Norn's slop check found 1 BLOCK finding\(s\)[^]*- K15 `a\.txt\.orig` [^]*Norn's Done check failed/, 'slop first, then the Done check, in one prompt');
  assert.equal((txt.match(/^resumed session /gm) || []).length, 1, 'one resume');
});

test('D3 K14: drift in a generated file whose source the diff does not touch never holds; a touched source does', () => {
  const repo = repoWith({ 'agents/impl.md': 'v1\n', 'other.txt': 'o\n' });
  git(repo, 'checkout', '-q', '-b', 'feat/x');
  commit(repo, { 'other.txt': 'o2\n' }, 'unrelated');
  const home = 'D:/agent-home/.claude/agents';
  const out = src => `PROBLEM ${home}/impl.md: drift (edited after generation; never overwritten) [source ${src}]\ngen --check: 1 problem(s)\n`;
  const tool = text => rule => (rule.kind === 'command' ? text : null);
  const k14 = r => r.blocks.filter(b => b.rule === 'K14');
  assert.deepEqual(k14(slopCheck({ repo, base: 'main', only: ['K14'], tool: tool(out(fwd(path.join(repo, 'agents/impl.md')))) })), [], 'the diff does not touch its source');
  assert.deepEqual(k14(slopCheck({ repo, base: 'main', only: ['K14'], tool: tool(out('C:/elsewhere/agents/impl.md')) })), [], 'a source outside the repo (a home-folder agent file)');
  commit(repo, { 'agents/impl.md': 'v2\n' }, 'the source');
  const hit = k14(slopCheck({ repo, base: 'main', only: ['K14'], tool: tool(out(fwd(path.join(repo, 'agents/impl.md')))) }));
  assert.equal(hit.length, 1, 'the diff touches its source');
  assert.equal(hit[0].file, `${home}/impl.md`);
});

test('D4 sweep: a branch with no common history with main is listed as unrelated history, no throw', () => {
  const repo = repoWith();
  git(repo, 'checkout', '-q', '--orphan', 'old/root'); git(repo, 'rm', '-rq', '--cached', '.');
  commit(repo, { 'z.txt': 'another root\n' }, 'old root');
  git(repo, 'checkout', '-q', '-f', 'main');
  const s = sweep(repo, { now: Date.now() });
  assert.deepEqual(s.unrelated.map(x => x.branch), ['old/root']);
  assert.ok(!s.real.some(x => x.branch === 'old/root') && !s.empty.some(x => x.branch === 'old/root'));
});

test('D4 daily: a start that wrote no report by the next tick becomes a digest row', () => {
  const state = stateDir(), root = path.dirname(path.dirname(state));
  const p = { name: 'kestrel', file: path.join(root, 'project.json'), root, policy: {} };
  const t0 = Date.parse('2026-11-18T06:00:00Z'), spawnFn = () => ({ pid: 7 });
  assert.equal(digestRow(state, t0), null);
  tickSlop(p, state, { metaCmd: NORN, spawnFn, now: t0 });
  tickSlop(p, state, { metaCmd: NORN, spawnFn, now: t0 + 31 * 60e3 });   // the next tick: no report since the start
  const row = digestRow(state, t0 + 32 * 60e3);
  assert.match(row.line, /slop daily: 1 start\(s\) since 2026-11-18T06:00:00\.000Z wrote no report/);
});

test('D6: the Guard names the real waiver command', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'engine', 'lib', 'guardview.mjs'), 'utf8');
  assert.ok(!src.includes('norn slop waive'), 'no command that does not exist');
  assert.match(src, /norn rec add waiver/);
  assert.equal(typeof guardRows, 'function');
});

test('D7: the batch result is checked against main - an import cycle that exists only in the combination of two clean branches holds it', () => {
  const repo = repoWith({ 'engine/lib/a.mjs': 'export const a = 1;\n', 'engine/lib/b.mjs': 'export const b = 2;\n' }), state = stateDir();
  git(repo, 'checkout', '-q', '-b', 'feat/ab'); commit(repo, { 'engine/lib/a.mjs': "import { b } from './b.mjs';\nexport const a = () => b;\n" }, 'a uses b');
  git(repo, 'checkout', '-q', '-b', 'feat/ba', 'main'); commit(repo, { 'engine/lib/b.mjs': "import { a } from './a.mjs';\nexport const b = () => a;\n" }, 'b uses a');
  for (const b of ['feat/ab', 'feat/ba']) assert.deepEqual(doorCheck({ state, repo, branch: b, head: b, tool: noTool }).open, [], `${b} alone is clean`);
  git(repo, 'checkout', '-q', '-b', 'mq/batch-3', 'main');
  for (const b of ['feat/ab', 'feat/ba']) git(repo, 'merge', '-q', '--no-ff', '-m', 'merge ' + b, b);
  const base = git(repo, 'rev-parse', 'main'), tip = git(repo, 'rev-parse', 'HEAD');
  const open = batchSlop(state, { n: 3, base, merge_tip: tip }, { repo, tool: noTool });
  assert.deepEqual(open.map(b => b.rule), ['K10']);
  assert.match(open[0].msg, /import cycle: engine\/lib\/a\.mjs -> engine\/lib\/b\.mjs/);
  assert.equal(slopChecks(state).at(-1).branch, 'mq/batch-3');
  record(state, { kind: 'waiver', ev: 'create', by: 'owner', data: { rule: 'K10', scope: open[0].fp, why: 'reviewed: the cycle is broken next' } });
  assert.deepEqual(batchSlop(state, { n: 3, base, merge_tip: tip }, { repo, tool: noTool }), [], 'a waiver clears it');
});

// S1a (SPEC 1.3 F1-F4, F7, F8): `norn slop check --diff` reads the range it names; a check that cannot run holds every door
const slopCli = (cwd, env, ...a) => spawnSync(process.execPath, [NORN, 'slop', 'check', ...a], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
/** a META_ROOT whose tool cache cannot be made (state/tools is a file): the real ESLint run fails, as with no npx or no network */
function brokenRoot() {
  const root = mkTmp('meta-slopgate-down-');
  fs.mkdirSync(path.join(root, 'state')); fs.writeFileSync(path.join(root, 'state', 'tools'), 'not a folder\n');
  return root;
}
const s7 = s => s.slice(0, 7);

test('F1: --diff prints the resolved commits (merge base..head), the files checked and the rules that ran - never the typed text or a null branch', () => {
  const repo = repoWith(); git(repo, 'checkout', '-q', '-b', 'feat/x'); const head = commit(repo, { 'ok.txt': 'fine\n' }, 'ok');
  const base = git(repo, 'merge-base', 'main', head); git(repo, 'checkout', '-q', '--detach');
  const r = slopCli(repo, { META_ROOT: mkTmp('meta-slopgate-root-') }, '--ci', '--diff', 'main..HEAD');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^slop check: 0 BLOCK on HEAD ${s7(base)}\\.\\.${s7(head)}, 1 file\\(s\\); ran: K1 `, 'm'));
  assert.doesNotMatch(r.stdout, /null|main\.\./);
});

test('F2: --diff starts at the merge base - a change main made after the fork is not the branch\'s finding', () => {
  const repo = repoWith({ 'a.txt': 'a\n', 'old.orig': 'left at the fork\n' });
  git(repo, 'checkout', '-q', '-b', 'feat/x'); commit(repo, { 'ok.txt': 'fine\n' }, 'ok');
  git(repo, 'checkout', '-q', 'main'); git(repo, 'rm', '-q', 'old.orig'); git(repo, 'commit', '-q', '-m', 'main drops the junk');
  git(repo, 'checkout', '-q', 'feat/x');
  const r = slopCli(repo, { META_ROOT: mkTmp('meta-slopgate-root-') }, '--ci', '--diff', 'main..HEAD');
  assert.equal(r.status, 0, 'the tip of main would show old.orig as added by the branch: ' + r.stdout + r.stderr);
  assert.match(r.stdout, /, 1 file\(s\); ran: /);
});

test('F3: an empty range says "nothing to check" (exit 0), with --diff and on a branch with no commits past main', () => {
  const repo = repoWith(), env = { META_ROOT: mkTmp('meta-slopgate-root-') }, tip = s7(git(repo, 'rev-parse', 'HEAD'));
  let r = slopCli(repo, env, '--ci', '--diff', 'main..HEAD');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^slop check: nothing to check: ${tip}\\.\\.${tip} changes no file$`, 'm'));
  assert.doesNotMatch(r.stdout, /BLOCK/);
  git(repo, 'checkout', '-q', '-b', 'feat/new');
  r = slopCli(repo, env, '--ci');
  assert.match(r.stdout, /^slop check: nothing to check: /m, r.stdout + r.stderr);
});

test('F4 + F5 at the CLI: a broken tool is a BLOCK "could not run" (exit 1); a --diff check is never stored, the branch form is', () => {
  const repo = repoWith(), state = stateDir(), env = { META_ROOT: brokenRoot() };
  git(repo, 'checkout', '-q', '-b', 'feat/x'); commit(repo, { 'b.mjs': 'export const b = 1;\n' }, 'js');
  let r = slopCli(repo, env, '--ci', '--diff', 'main..HEAD', '--state', state);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^BLOCK K3 `\*` could not run: /m);
  assert.match(r.stdout, /; could not run: K11A K19 K21 K23 K3/);
  assert.deepEqual(slopChecks(state), [], 'a --diff check is not stored: it opens no door');
  r = slopCli(repo, env, '--ci', '--state', state);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(slopChecks(state).at(-1).findings.some(f => f.rule === 'K3' && /could not run/.test(f.msg)));
});

test('F5: a check with a broken tool holds the merge at all three doors (merge-brief, the merge queue, merge-land)', () => {
  const root = brokenRoot(), repo = path.join(root, 'repo'), wt = path.join(root, 'wt'), state = path.join(root, 'state', 'kestrel');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  commit(repo, { 'a.txt': 'a\n' }, 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  const head = commit(wt, { 'b.mjs': 'export const b = 1;\n' }, 'js');
  const r = spawnSync(process.execPath, [NORN, 'merge-brief', '--project', projectFile(root, repo), '--lane', 'x', '--branch', 'feat/x', '--worktree', wt, '--notes', path.join(root, 'N.md'),
    '--out', path.join(root, 'MB.md'), '--sha', head], { encoding: 'utf8', env: { ...process.env, META_ROOT: root } });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /REFUSED: merge-brief feat\/x: \d+ open slop BLOCK finding\(s\) at [0-9a-f]{7}.*K3 `\*` could not run/);
  const down = () => { throw new Error('npx not found on PATH'); }, st2 = stateDir();
  const door = (branch, tip) => doorCheck({ state: st2, repo, branch, head: tip, tool: down });
  const row = { id: 'DLV-1', gate: 'batch', word: 'clean', tip: head, lane: 'x', branch: 'feat/x', repo, into: 'main' };
  assert.deepEqual(pickBatch([row], { cfg: { batch_max: 4 }, mq: { red: {} }, stateDir: st2, writer: () => null, door: (x, sha) => door(x.branch, sha).open.length }), []);
  const d = door('feat/x', head);
  assert.ok(d.open.length > 0 && d.open.every(f => /could not run/.test(f.msg)), 'the door merge-land asks holds it too');
  assert.match(doorWhy(d), /K3 `\*` could not run: npx not found on PATH/);
});

test('F7: a run-end check that throws stores a "could not check" hold for the branch and one digest row', async () => {
  const state = mkTmp('meta-slopgate-run-'), root = path.dirname(path.dirname(state));
  const repo = path.join(root, 'repo'), wt = path.join(root, 'wt'), notes = path.join(root, 'NOTES.md'), brief = path.join(root, 'brief.md'), pdir = path.join(root, 'proj');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(pdir, 'rules', 'slop'), { recursive: true });
  fs.writeFileSync(path.join(pdir, 'rules', 'slop', 'overrides.json'), '{ not json');   // the rule set cannot load: the check throws
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  commit(repo, { 'a.txt': 'a\n' }, 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  const head = commit(wt, { 'ok.txt': 'fine\n' }, 'ok');
  fs.writeFileSync(brief, 'mode: stopped\n');
  const id = startRun({ state, locksDir: path.join(root, 'locks'), executor: 'fake', lane: 'x', worktree: wt, notes, brief, hbMs: 150, staleMs: 3000,
    policy: { auto_resume_max: 0, trigger_on_exit: false, slop: { project_dir: pdir } }, budget: {} }).run;
  await waitFor(() => settled(loadState(state).items[id]), { what: 'the stopped run ends' });
  const h = slopHolds(state)['feat/x'];
  assert.ok(h, 'the branch is held');
  assert.equal(h.head, head);
  assert.deepEqual(h.blocks.map(b => [b.rule, b.level]), [['check', 'BLOCK']]);
  assert.match(h.blocks[0].msg, /^could not check: overrides\.json/);
  assert.match(digestRow(state).line, /HELD by slop: feat\/x/);
  assert.equal(storedCheck(state, { branch: 'feat/x', head, hash: rulesHash(loadRules()) }), null, 'no door reads it as a check: the door runs its own');
});

test('F8: three dots is a usage error, exit 2, no stack trace', () => {
  const repo = repoWith(), r = slopCli(repo, { META_ROOT: mkTmp('meta-slopgate-root-') }, '--diff', 'main...HEAD');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /^error: --diff wants base\.\.head \(two dots\)/m);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test('K10 on Norn itself: the engine has no import cycle (the chat -> checkins -> digest -> guard -> look -> roadmap -> standing -> stuck one is broken)', () => {
  const engine = path.join(import.meta.dirname, '..', 'engine'), repo = repoWith({ 'README.md': 'empty base\n' });
  const files = {};
  for (const f of fs.readdirSync(engine, { recursive: true })) if (/\.(mjs|js|cjs)$/.test(f) && !f.includes('node_modules')) files['engine/' + fwd(f)] = fs.readFileSync(path.join(engine, f), 'utf8');
  commit(repo, files, 'the engine as it stands');
  const k10 = slopCheck({ repo, base: 'HEAD~1', only: ['K10'], tool: noTool }).blocks;
  // every cycle is new against an empty base; the older after -> fed -> records -> views one predates PR 11 and is not this break's
  const named = /engine\/lib\/(chat|checkins|digest|guard|look|roadmap|standing|stuck)\.mjs/;
  assert.deepEqual(k10.map(b => b.msg).filter(m => named.test(m)), [], 'no cycle through the chat / roadmap modules');
});
