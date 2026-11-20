// A project that is one folder of a monorepo (project.json subdir): project new detects it, two projects share one repo, the adopt
// scan sees only that folder, lanes branch per project, the merge gate runs from the folder and the scope guard holds a run there.
// Temp meta root, temp HOME, a fake claude first on PATH, the real git after it; nothing touches the live machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { which } from '../engine/lib/paths.mjs';
import { loadProject } from '../engine/lib/config.mjs';
import { normSubdir, splitRepo, projectHome, inDir, gateText, SubdirError } from '../engine/lib/monorepo.mjs';
import { scan, draftFacts } from '../engine/lib/adopt.mjs';
import { laneBranch, lanePaths } from '../engine/lib/lanenew.mjs';
import { runGate } from '../engine/lib/mergeq.mjs';
import { mergeConfig } from '../engine/lib/mergecfg.mjs';
import { scopeOf, scopeOnFor } from '../engine/lib/scope.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const fwd = p => p.split(path.sep).join('/');
const GIT_DIR = path.dirname(which('git'));
const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));

function sandbox() {
  const t = mkTmp('meta-mono-');
  const d = { root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg'), t };
  for (const x of [d.root, d.home, d.bin, d.cfg]) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(path.join(d.bin, WIN ? 'claude.exe' : 'claude'), '');
  const env = { ...process.env, PATH: d.bin + path.delimiter + GIT_DIR, HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming'), META_ROOT: d.root };
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT']) delete env[k];
  const run = args => { const r = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8', input: '' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const r = run(['setup', '--non-interactive', '--no-scheduler']);
  assert.equal(r.code, 0, r.err + r.out);
  return { ...d, run, fileOf: name => path.join(d.home, '.norn', 'projects', name, 'project.json'), machine: () => json(path.join(d.root, 'local', 'machine.json')) };
}

/** a monorepo: a top-level README, app/ (README, CLAUDE.md, package.json with a test script, a TODO) and lib/ (its own README) */
function mono(dir) {
  fs.mkdirSync(path.join(dir, 'app', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README.md'), '# The monorepo\n');
  fs.writeFileSync(path.join(dir, 'lib', 'README.md'), '# lib\n');
  g('add', '.'); g('commit', '-q', '-m', 'top and lib');
  fs.writeFileSync(path.join(dir, 'app', 'README.md'), '# app\n');
  fs.writeFileSync(path.join(dir, 'app', 'CLAUDE.md'), 'app rules\n');
  fs.writeFileSync(path.join(dir, 'app', 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'node --test' } }, null, 1) + '\n');
  fs.writeFileSync(path.join(dir, 'app', 'src', 'a.js'), '// TODO one\n');
  g('add', '.'); g('commit', '-q', '-m', 'app');
  return { dir, g };
}

test('normSubdir: repo-relative forward-slash folders; .. and absolute paths refused', () => {
  assert.equal(normSubdir(undefined), '');
  assert.equal(normSubdir('.'), '');
  assert.equal(normSubdir('./app/'), 'app');
  assert.equal(normSubdir('apps\\web'), 'apps/web');
  for (const bad of ['../x', 'a/../b', '/abs', 'C:/x', 'a//b']) assert.throws(() => normSubdir(bad), SubdirError, bad);
  assert.equal(projectHome({ root: '/r', subdir: 'app' }).endsWith('/r/app'), true);
  assert.equal(gateText({ cmd: 'npm test', dir: 'app' }), 'cd app && npm test');
  assert.equal(gateText({ cmd: 'npm test' }), 'npm test');
  assert.equal(fwd(inDir('/t', 'app')).endsWith('/t/app'), true);
});

test('splitRepo: a folder below the top level -> { root: the top level as given, subdir }', () => {
  const t = mkTmp('meta-mono-'), m = mono(path.join(t, 'repo'));
  assert.deepEqual(splitRepo(m.dir), { root: fwd(path.resolve(m.dir)), subdir: '' });
  assert.deepEqual(splitRepo(path.join(m.dir, 'app', 'src')), { root: fwd(path.resolve(m.dir)), subdir: 'app/src' });
  assert.equal(splitRepo(t), null);
});

test('scan with subdir: only that folder\'s files, commits and TODOs; its README / CLAUDE.md / package.json found; paths repo-relative', () => {
  const t = mkTmp('meta-mono-'), m = mono(path.join(t, 'repo'));
  const whole = scan(m.dir), app = scan(m.dir, { subdir: 'app' });
  assert.equal(whole.history.commits, 2);
  assert.equal(whole.agent_files.length, 0, 'app/CLAUDE.md is no top-level agent file');
  assert.equal(app.subdir, 'app');
  assert.equal(app.name, 'app');
  assert.equal(app.history.commits, 1, 'only the commit that touched app/');
  assert.equal(app.size.files, 4);
  assert.equal(app.docs.readme, 'app/README.md');
  assert.deepEqual(app.agent_files.map(a => a.file), ['app/CLAUDE.md']);
  assert.deepEqual(app.manifests, ['app/package.json']);
  const tc = app.commands.find(c => c.id === 'test');
  assert.equal(tc.cmd, 'npm test');
  assert.match(tc.source, /^app\/package\.json/);
  assert.equal(app.size.todo_markers, 1);
  assert.throws(() => scan(m.dir, { subdir: 'nope' }), /no tracked file under it/);
});

test('the adopt draft of a subdir project: its folder rule first, the test rule runs from the folder', () => {
  const t = mkTmp('meta-mono-'), m = mono(path.join(t, 'repo'));
  const parts = draftFacts(scan(m.dir, { subdir: 'app' })).parts;
  const rules = parts.find(p => p.id === 'rules').lines.map(l => l.text);
  assert.match(rules[0], /^This project is the app\/ folder of the repository/);
  assert.ok(rules.some(r => r.includes('`cd app && npm test`')), rules.join('\n'));
});

test('project new on a folder of a repo: root = the top level, subdir = the folder, named after it; a second folder = a second project', () => {
  const sb = sandbox(), m = mono(path.join(sb.t, 'repo'));
  const a = sb.run(['project', 'new', '--root', path.join(m.dir, 'app'), '--non-interactive']);
  assert.equal(a.code, 0, a.err + a.out);
  assert.match(a.out, /the folder app of /);
  const pa = json(sb.fileOf('app'));
  assert.equal(pa.root, fwd(path.resolve(m.dir)));
  assert.equal(pa.subdir, 'app');
  loadProject(sb.fileOf('app'), { home: sb.home, meta: sb.root });   // validates
  const b = sb.run(['project', 'new', '--root', m.dir, '--subdir', 'lib', '--non-interactive']);
  assert.equal(b.code, 0, b.err + b.out);
  assert.equal(json(sb.fileOf('lib')).subdir, 'lib');
  assert.deepEqual(sb.machine().projects.map(p => p.name).sort(), ['app', 'lib']);
  const whole = sb.run(['project', 'new', '--root', m.dir, '--non-interactive', '--name', 'all']);
  assert.equal(whole.code, 0, whole.err + whole.out);
  assert.equal(json(sb.fileOf('all')).subdir, undefined, 'the top level = the whole repo, no subdir');
  for (const [args, re] of [[['--subdir', '../x'], /no \.\./], [['--subdir', 'missing'], /no such folder/]]) {
    const r = sb.run(['project', 'new', '--root', m.dir, '--non-interactive', '--name', 'bad', ...args]);
    assert.equal(r.code, 2, r.out); assert.match(r.err, re);
  }
});

test('lanes of a subdir project branch as norn/<project>/<lane>; a whole-repo project keeps norn/<lane>', () => {
  assert.equal(laneBranch('fix'), 'norn/fix');
  assert.equal(laneBranch('fix', { name: 'all' }), 'norn/fix');
  assert.equal(laneBranch('fix', { name: 'app', subdir: 'app' }), 'norn/app/fix');
  const p = { name: 'app', subdir: 'app', root: '/r', state: '/s/app', lane_defaults: { worktree: '/s/app/wt/${lane}' } };
  assert.equal(lanePaths(p, 'fix').branch, 'norn/app/fix');
});

test('mergeConfig of a subdir project: the gate runs from the folder (an explicit gate.dir wins); the scratch is the project\'s own', () => {
  const p = { name: 'app', root: '/r', subdir: 'app', merge: { gate: { cmd: 'npm test' } } };
  assert.deepEqual(mergeConfig(p).gate, { cmd: 'npm test', dir: 'app' });
  assert.equal(mergeConfig(p).scratch, '/r-mq-app');
  assert.equal(mergeConfig({ ...p, merge: { gate: { cmd: 'make', dir: '' } } }).gate.dir, '');
  assert.equal(mergeConfig({ name: 'all', root: '/r', merge: { gate: { cmd: 'npm test' } } }).scratch, '/r-mq');
  assert.equal(mergeConfig({ name: 'all', root: '/r', merge: { gate: { cmd: 'npm test' } } }).gate.dir, undefined);
});

test('runGate with a dir runs in <cwd>/<dir>', async () => {
  const t = mkTmp('meta-mono-');
  fs.mkdirSync(path.join(t, 'app'));
  fs.writeFileSync(path.join(t, 'app', 'marker.txt'), 'x');
  const log = path.join(t, 'logs', 'gate.log');
  const cmd = `"${process.execPath}" -e "process.exit(require('fs').existsSync('marker.txt') ? 0 : 3)"`;
  assert.equal((await runGate({ cmd, dir: 'app', timeout_min: 1 }, { cwd: t, log })).code, 0);
  assert.equal((await runGate({ cmd, timeout_min: 1 }, { cwd: t, log })).code, 3);
});

test('the scope guard of a subdir project: a brief without Scope: = the folder; on unless policy.dod.scope is off', () => {
  const t = mkTmp('meta-mono-'), brief = path.join(t, 'b.md');
  fs.writeFileSync(brief, 'do it\n');
  assert.deepEqual(scopeOf({ brief, worktree: t, subdir: 'app' }).scope, ['app']);
  assert.deepEqual(scopeOf({ brief, worktree: t }).scope, []);
  fs.writeFileSync(brief, 'Scope: docs/\nTests: none\nDone: ## DONE\n');
  assert.deepEqual(scopeOf({ brief, worktree: t, subdir: 'app' }).scope, ['docs/'], 'a brief Scope: wins');
  assert.equal(scopeOnFor({}, { subdir: 'app' }), true);
  assert.equal(scopeOnFor({ dod: { scope: 'off' } }, { subdir: 'app' }), false);
  assert.equal(scopeOnFor({}, {}), false);
  assert.equal(scopeOnFor({ dod: { scope: 'on' } }, {}), true);
});
