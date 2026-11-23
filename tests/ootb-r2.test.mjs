// What a fresh machine hits right after project new: --project resolving a name, an auth exit reaching the dashboard, and the run
// stamp never crossing into another project. Each case was a ship-gate defect of the out-of-the-box review (its rehearsal case lives in adopt-e2e).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { hookReady } from './helpers/hook.mjs';
import { which } from '../engine/lib/paths.mjs';
import { loadProject } from '../engine/lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const GIT_DIR = path.dirname(which('git'));

/** a fresh machine: temp META_ROOT / HOME / config dir, a placeholder claude on PATH (+ git, node), no META_* inherited */
function sandbox(extra = {}) {
  hookReady();   // norn setup needs a built norn-hook; the sandbox PATH has no cargo
  const t = mkTmp('meta-ootb-r2-');
  const d = { t, root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg'), code: path.join(t, 'code') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(path.join(d.bin, WIN ? 'claude.exe' : 'claude'), '');
  const env = { ...process.env, PATH: d.bin + path.delimiter + GIT_DIR + path.delimiter + path.dirname(process.execPath), HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming'), META_ROOT: d.root, META_NO_TICK: '1', ...extra };
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH' && k !== 'PATH') delete env[k];
  for (const k of Object.keys(env)) if (/^META_/.test(k) && !['META_ROOT', 'META_NO_TICK'].includes(k) && !(k in extra)) delete env[k];
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'FAKE_MS', 'FAKE_RESULT']) delete env[k];
  const run = (args, o = {}) => {
    const r = spawnSync(process.execPath, [META, ...args], { env: { ...env, ...(o.env || {}) }, cwd: o.cwd, encoding: 'utf8', input: o.input ?? '', timeout: 180000 });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
  };
  const ok = (args, o) => { const r = run(args, o); assert.equal(r.code, 0, `meta ${args.join(' ')}\n${r.all}`); return r; };
  const projectFile = name => path.join(d.home, '.norn', 'projects', name, 'project.json');
  const project = name => loadProject(projectFile(name), { meta: d.root });
  return { ...d, env, run, ok, projectFile, project };
}
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function young(sb, name = 'harbour') {
  const r = path.join(sb.code, name);
  fs.mkdirSync(r, { recursive: true });
  git(r, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'README.md'), `# ${name}\n`);
  git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'init');
  return r;
}

test('N-3--project <name>: a registered name wins over a same-named folder in the cwd; a project.json path still wins', { timeout: 120000 }, () => {
  const sb = sandbox(), repo = young(sb);
  sb.ok(['setup', '--non-interactive', '--no-scheduler']);
  sb.ok(['project', 'new', '--root', repo, '--non-interactive']);
  // standing in the parent of the repo: ./harbour is a folder of the same name
  const r = sb.run(['road', 'show', '--project', 'harbour'], { cwd: sb.code });
  assert.equal(r.code, 0, r.all);
  assert.doesNotMatch(r.all, /EISDIR/);
  // a file path is a path, also when a project of that name exists
  const pf = sb.projectFile('harbour'), rel = path.relative(sb.code, pf);
  assert.equal(sb.run(['road', 'show', '--project', rel], { cwd: sb.code }).code, 0);
});

test('N-5 an auth exit: the CLI line names the login command; Overview counts a needs-you login row carrying it; the lane says auth', { timeout: 180000 }, async () => {
  const { createDashboard } = await import('../engine/dash/server.mjs');
  const { loadMachine } = await import('../engine/lib/config.mjs');
  const sb = sandbox(), repo = young(sb);
  sb.ok(['setup', '--non-interactive', '--no-scheduler']);
  sb.ok(['project', 'new', '--root', repo, '--non-interactive']);
  const pf = sb.projectFile('harbour');
  sb.ok(['lane', 'new', 'tide', '--project', pf]);
  const brief = path.join(sb.t, 'auth-brief.md');
  fs.writeFileSync(brief, 'mode: crash\nsay: Failed to authenticate: OAuth session expired · Please run /login\n');
  const r = sb.run(['run', '--executor', 'fake', '--lane', 'tide', '--brief', brief, '--project', pf, '--wait']);
  assert.match(r.out, /^RUN-1 exited: auth\b.*claude auth login/m, r.all);
  const machine = loadMachine(path.join(sb.root, 'local', 'machine.json'), { meta: sb.root });
  const app = createDashboard({ projects: [], machine, metaRoot: sb.root, env: sb.env, budgetFile: path.join(sb.root, 'local', 'budget.json'),
    platform: { tick: async () => ({ pid: 1 }), setInterval: async () => ({ ok: true }), ask: async () => ({ result: '', usage: {} }) },
    projectsDir: path.join(sb.t, 'cp'), codexDir: path.join(sb.t, 'cx'), sessionsDir: path.join(sb.t, 'sessions'), artDir: path.join(sb.t, 'art') });
  await new Promise(res => app.server.listen(0, '127.0.0.1', res));
  try {
    const url = `http://127.0.0.1:${app.server.address().port}`, get = async x => (await fetch(url + x)).json();
    assert.deepEqual((await get('/api/projects')).projects.map(p => p.name), ['harbour']);   // re-reads machine.json
    const ov = await get('/api/overview');
    const row = ov.needs.find(i => i.type === 'login');
    assert.ok(row, 'a needs-you login row\n' + JSON.stringify(ov.needs));
    assert.ok(ov.needs_you >= 1);
    assert.equal(row.command, 'claude auth login');
    assert.match(row.title, /claude auth login/);
    assert.deepEqual(row.runs, ['RUN-2'], 'the re-queued run is the one held');
    assert.ok((await get('/api/inbox')).items.some(i => i.type === 'login'), 'the inbox carries it too');
    const lane = (await get('/api/lanes')).lanes.find(l => l.name === 'tide');
    assert.match(lane.text, /auth/);
    assert.doesNotMatch(lane.text, /no-result/);
    assert.match(lane.text, /claude auth login/);
  } finally { await app.close(); }
});

test('N-16 inside a Norn-launched agent: META_RUN_ID / META_ROLE stamp only the launching project\'s records, never another one\'s', { timeout: 180000 }, async () => {
  const { loadState } = await import('../engine/lib/records.mjs');
  const sb = sandbox(), a = young(sb, 'alpha'), b = young(sb, 'beta');
  sb.ok(['setup', '--non-interactive', '--no-scheduler']);
  for (const r of [a, b]) sb.ok(['project', 'new', '--root', r, '--non-interactive']);
  const A = sb.project('alpha'), B = sb.project('beta');
  const qs = st => Object.values(loadState(st).items).filter(i => i.kind === 'question');
  // a check-in of alpha (tick.mjs env + the supervisor's META_RUN_ID) running meta
  const inherited = { META_STATE: A.state, META_PROJECT: A.file, META_ROLE: 'checkin', META_RUN_ID: 'RUN-454' };
  const own = sb.run(['rec', 'add', 'question', '--lane', 'x', '--title', 'own project'], { env: inherited });
  assert.equal(own.code, 0, own.all);
  assert.deepEqual(qs(A.state).map(d => [d.by, d.run]), [['checkin', 'RUN-454']], 'the launching project: stamped as today');
  // --project names another project: the inherited role is not the caller's there, and the run is not stamped
  const noRole = sb.run(['rec', 'add', 'question', '--lane', 'x', '--title', 'other', '--project', 'beta'], { env: inherited });
  assert.equal(noRole.code, 2, noRole.all);
  assert.match(noRole.all, /no role/);
  sb.ok(['rec', 'add', 'question', '--lane', 'x', '--title', 'other', '--project', 'beta', '--as', 'controller'], { env: inherited });
  sb.ok(['rec', 'add', 'question', '--lane', 'x', '--title', 'by state', '--state', B.state, '--as', 'controller'], { env: inherited });
  assert.deepEqual(qs(B.state).map(d => [d.by, d.run]), [['controller', null], ['controller', null]], 'another project: no inherited run id');
  // the run's own state is what the supervisor names (META_RUN_STATE) - also for a worker with no META_STATE
  const worker = { META_RUN_ID: 'RUN-7', META_RUN_STATE: A.state, META_ROLE: 'controller' };
  sb.ok(['rec', 'add', 'question', '--lane', 'x', '--title', 'w own', '--project', 'alpha'], { env: worker });
  sb.ok(['rec', 'add', 'question', '--lane', 'x', '--title', 'w other', '--project', 'beta', '--as', 'controller'], { env: worker });
  assert.deepEqual(qs(A.state).at(-1).run, 'RUN-7');
  assert.deepEqual(qs(B.state).at(-1).run, null);
});

test('N-16 the supervisor names the run state dir for the agent (META_RUN_STATE)', { timeout: 120000 }, () => {
  const sb = sandbox(), repo = young(sb);
  sb.ok(['setup', '--non-interactive', '--no-scheduler']);
  sb.ok(['project', 'new', '--root', repo, '--non-interactive']);
  const pf = sb.projectFile('harbour');
  sb.ok(['lane', 'new', 'tide', '--project', pf]);
  const brief = path.join(sb.t, 'env-brief.md');
  fs.writeFileSync(brief, 'mode: done\nenv: META_RUN_STATE\n');
  const r = sb.ok(['run', '--executor', 'fake', '--lane', 'tide', '--brief', brief, '--project', pf, '--wait']);
  const log = r.out.match(/ log (\S+\.log)/)[1];
  const st = sb.project('harbour').state;
  const seen = fs.readFileSync(log, 'utf8').match(/^fake env META_RUN_STATE=(.*)$/m)?.[1]?.trim();
  assert.equal(seen && path.resolve(seen).toLowerCase(), path.resolve(st).toLowerCase());
});
