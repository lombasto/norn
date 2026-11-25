// META-ONBOARD S4 (SPEC 3.4): `norn project list` / `norn project remove` and the scheduler adapters' installed(). Temp meta root,
// temp HOME / CLAUDE_CONFIG_DIR, fake claude first on PATH; the scheduler is a fake io - nothing touches the live machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { rustReady } from './helpers/rust.mjs';
import { which } from '../engine/lib/paths.mjs';
import { projectRemove } from '../engine/lib/setup.mjs';
import { ROLE_AGENTS } from '../engine/lib/policy.mjs';
import { ADAPTERS } from '../engine/lib/sched/index.mjs';

test.before(rustReady);   // norn setup builds norn-hook and norn-code: a cold build runs here, never inside a step's time limit

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const GIT_DIR = path.dirname(which('git'));
const fwd = p => p.split(path.sep).join('/');

function sandbox() {
  const t = mkTmp('meta-prm-');
  const d = { t, root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg') };
  for (const x of [d.root, d.home, d.bin, d.cfg]) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(path.join(d.bin, WIN ? 'claude.exe' : 'claude'), '');
  const env = { ...process.env, PATH: d.bin + path.delimiter + GIT_DIR, HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming'), META_ROOT: d.root, META_NO_TICK: '1' };
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT', 'META_RUN_ID', 'META_ROLE']) delete env[k];
  const run = (...args) => { const r = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  assert.equal(run('setup', '--non-interactive', '--no-scheduler').code, 0);
  const machine = () => JSON.parse(fs.readFileSync(path.join(d.root, 'local', 'machine.json'), 'utf8'));
  // a project outside the engine with two agents and a skill dir (meta-made) -> 3 managed files
  const project = name => {
    const pd = path.join(t, 'projects', name);
    fs.mkdirSync(path.join(pd, 'agents'), { recursive: true }); fs.mkdirSync(path.join(pd, 'skills', `${name}-s`, 'ref'), { recursive: true });
    fs.writeFileSync(path.join(pd, 'agents', `${name}-a.md`), '# a\n'); fs.writeFileSync(path.join(pd, 'agents', `${name}-b.md`), '# b\n');
    fs.writeFileSync(path.join(pd, 'skills', `${name}-s`, 'ref', 'R.md'), '# r\n');
    fs.mkdirSync(path.join(t, 'repos', name), { recursive: true });
    const f = path.join(pd, 'project.json');
    fs.writeFileSync(f, JSON.stringify({ schema: 1, name, title: name, root: fwd(path.join(t, 'repos', name)),
      lane_defaults: { worktree: '${state}/wt/${lane}', notes: '${state}/notes/${lane}/NOTES.md' },
      install: { agents: '${project_dir}/agents', skills: '${project_dir}/skills' } }));
    const r = run('project', 'add', f);
    assert.equal(r.code, 0, r.err + r.out);
    return f;
  };
  const opts = (extra = {}) => { const lines = [], errs = []; return { env, out: s => lines.push(s), err: s => errs.push(s), lines, errs, ...extra }; };
  return { ...d, env, run, machine, project, opts, stateOf: n => path.join(d.root, 'state', n) };
}

const fakeSched = installed => {
  const calls = [];
  return { calls, io: { run: (c, a) => { calls.push([c, ...a].join(' ')); return { status: installed ? 0 : 1, stdout: installed ? '*/15 * * * * x # norn:norn-tick\n' : '' }; },
    exists: () => installed, write: () => {}, rm: f => calls.push('rm ' + f) } };
};
const snapshot = dir => {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { out[p + '/'] = ''; walk(p); } else out[p] = fs.readFileSync(p, 'base64'); } };
  walk(dir); return out;
};

test('list: one line per project (config, root ok / MISSING, managed files, state, running) and --json', () => {
  const sb = sandbox();
  assert.match(sb.run('project', 'list').out, /no projects registered/);
  sb.project('alpha'); sb.project('beta');
  fs.rmSync(path.join(sb.t, 'repos', 'beta'), { recursive: true });
  const r = sb.run('project', 'list');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^alpha .*project\.json root ok .* managed 3 .*state .*state\/alpha .*running 0$/m);
  assert.match(r.out, /^beta .*root MISSING /m);
  const j = JSON.parse(sb.run('project', 'list', '--json').out);
  assert.deepEqual(j.map(p => [p.name, p.root_exists, p.managed, p.running.length]), [['alpha', true, 3, 0], ['beta', false, 3, 0]]);
});

test('remove: unedited installed files deleted, an edited one KEPT + reported, a missing one dropped, meta-made empty skill dirs removed', () => {
  const sb = sandbox(); sb.project('alpha');
  const A = path.join(sb.cfg, 'agents'), S = path.join(sb.cfg, 'skills');
  fs.appendFileSync(path.join(A, 'alpha-b.md'), 'mine\n');   // edited since install
  fs.rmSync(path.join(A, 'alpha-a.md'));                      // gone already
  fs.writeFileSync(path.join(A, 'foreign.md'), 'not meta\n');
  const o = sb.opts({ name: 'alpha', io: fakeSched(false).io });
  assert.equal(projectRemove(o), 0, o.errs.join('\n'));
  const text = o.lines.join('\n');
  assert.match(text, new RegExp(`kept ${fwd(path.join(A, 'alpha-b.md')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: edited since install \\(now yours, not managed\\)`));
  assert.ok(fs.existsSync(path.join(A, 'alpha-b.md')) && fs.existsSync(path.join(A, 'foreign.md')));
  assert.equal(fs.existsSync(path.join(S, 'alpha-s')), false, 'the meta-made skill dir (and its empty ref/) is gone');
  assert.ok(fs.existsSync(S), 'the skills dir itself stays');
  const man = JSON.parse(fs.readFileSync(path.join(sb.root, 'local', 'install-manifest.json'), 'utf8'));
  assert.equal(man.entries.filter(e => e.project === 'alpha').length, 0);
  assert.equal(sb.machine().projects.length, 0);
  assert.ok(fs.existsSync(path.join(sb.t, 'projects', 'alpha', 'project.json')), 'the project.json is the user\'s: never deleted');
  assert.match(text, /state kept: .*state\/alpha \(--purge-state deletes it\)/);
});

test('remove: unknown name = exit 2; a running run of the project = exit 3 naming it (nothing changed)', async () => {
  const sb = sandbox(); const f = sb.project('alpha');
  assert.throws(() => projectRemove(sb.opts({ name: 'nope', io: fakeSched(false).io })), e => e.code === 2 && /no project named nope/.test(e.message));
  const st = sb.stateOf('alpha');
  for (const d of ['wt/hold', 'notes/hold']) fs.mkdirSync(path.join(st, d), { recursive: true });
  const brief = path.join(sb.t, 'sleep.md'); fs.writeFileSync(brief, 'mode: sleep\nms: 30000\n');
  const r = sb.run('run', '--executor', 'fake', '--lane', 'hold', '--brief', brief, '--project', f, '--no-tick');
  const id = (r.out.match(/STARTED (RUN-\d+)/) || [])[1];
  assert.ok(id, r.out + r.err);
  try {
    const before = JSON.stringify(sb.machine());
    assert.throws(() => projectRemove(sb.opts({ name: 'alpha', io: fakeSched(true).io })), e => e.code === 3 && e.message.includes(id));
    assert.equal(JSON.stringify(sb.machine()), before);
  } finally { sb.run('stop', id, '--as', 'owner', '--project', f); }
});

test('remove: the scheduler goes only with the last project AND only when installed', () => {
  const sb = sandbox(); sb.project('alpha'); sb.project('beta');
  let s = fakeSched(true);
  assert.equal(projectRemove(sb.opts({ name: 'alpha', io: s.io })), 0);
  assert.equal(s.calls.filter(c => /schtasks \/Delete|disable|crontab -$|unload|^rm /.test(c)).length, 0, 'projects left: untouched');
  s = fakeSched(false);
  const o = sb.opts({ name: 'beta', io: s.io });
  assert.equal(projectRemove(o), 0);
  assert.equal(s.calls.filter(c => /schtasks \/Delete|disable|unload|^rm /.test(c)).length, 0, 'not installed: not removed');
  const sb2 = sandbox(); sb2.project('gamma');
  s = fakeSched(true);
  const o2 = sb2.opts({ name: 'gamma', io: s.io });
  assert.equal(projectRemove(o2), 0);
  assert.match(o2.lines.join('\n'), /scheduler .* removed \(no project left\)/);
  assert.ok(s.calls.length > 1);
});

test('remove --purge-state deletes state/<name>; --dry-run changes nothing (byte compare) and prints the plan', () => {
  const sb = sandbox(); sb.project('alpha');
  fs.mkdirSync(path.join(sb.stateOf('alpha'), 'views'), { recursive: true });
  const before = { ...snapshot(sb.root), ...snapshot(sb.cfg) };
  const d = sb.opts({ name: 'alpha', dryRun: true, purgeState: true, io: fakeSched(true).io });
  assert.equal(projectRemove(d), 0);
  assert.deepEqual({ ...snapshot(sb.root), ...snapshot(sb.cfg) }, before);
  assert.match(d.lines.join('\n'), /dry run/i); assert.match(d.lines.join('\n'), /would delete .*alpha-a\.md/);
  assert.equal(projectRemove(sb.opts({ name: 'alpha', purgeState: true, io: fakeSched(false).io })), 0);
  assert.equal(fs.existsSync(sb.stateOf('alpha')), false);
});

test('sched adapters installed() ask the OS through the injected io', () => {
  const O = { name: 'norn-tick', interval_min: 15, node: '/n', meta: '/m', home: '/h' };
  const io = (status, stdout = '', exists = true) => { const calls = []; return { calls, run: (c, a) => { calls.push([c, ...a].join(' ')); return { status, stdout }; }, exists: () => exists }; };
  let x = io(0); assert.equal(ADAPTERS['windows-task'].installed(O, x), true); assert.deepEqual(x.calls, ['schtasks /Query /TN norn-tick']);
  assert.equal(ADAPTERS['windows-task'].installed(O, io(1)), false);
  x = io(0); assert.equal(ADAPTERS.systemd.installed(O, x), true); assert.deepEqual(x.calls, ['systemctl --user is-enabled norn-tick.timer']);
  assert.equal(ADAPTERS.systemd.installed(O, io(1)), false);
  assert.equal(ADAPTERS.cron.installed(O, io(0, '0 1 * * * b\n*/15 * * * * cd /m && x # norn:norn-tick\n')), true);
  assert.equal(ADAPTERS.cron.installed(O, io(0, '0 1 * * * b\n')), false); assert.equal(ADAPTERS.cron.installed(O, io(1)), false);
  x = io(0); assert.equal(ADAPTERS.launchd.installed(O, x), true); assert.deepEqual(x.calls, ['launchctl list norn-tick']);
  assert.equal(ADAPTERS.launchd.installed(O, io(0, '', false)), false); assert.equal(ADAPTERS.launchd.installed(O, io(1)), false);
});

// caps come before the scheduler: a tick with no caps would start workers without limit. The no-caps case names a cron task with no
// crontab on PATH, so even a missing refusal installs nothing.
test('sched install refuses (exit 2): no registered project ("add a project first"); no caps (one line: budget.json, norn setup, Settings); sched show prints installed: yes|no', () => {
  const sb = sandbox();
  const r = sb.run('sched', 'install');
  assert.equal(r.code, 2); assert.match(r.err, /add a project first/);
  assert.match(sb.run('sched', 'show').out, /^installed: (yes|no)$/m);
  const mf = path.join(sb.root, 'local', 'machine.json'), bf = path.join(sb.root, 'local', 'budget.json');
  fs.writeFileSync(mf, JSON.stringify({ ...sb.machine(), scheduler: { kind: 'cron', name: 'meta-ootb-test-never-installed', interval_min: 15 }, projects: [{ name: 'x', config: '${norn}/local/x.json' }] }));
  for (const budget of [null, '{"weekly_stop_pct": 50}']) {
    if (budget === null) fs.rmSync(bf, { force: true }); else fs.writeFileSync(bf, budget);
    const x = sb.run('sched', 'install');
    assert.equal(x.code, 2, x.err + x.out);
    const lines = (x.err + x.out).trim().split(/\r?\n/);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^error: no caps set .*budget\.json.*(max_claude_workers|missing).*norn setup.*Settings/);
  }
});

// the generic role agents are installed under shared names: they go with the last project that uses them, and a same-named file the
// user owns is theirs (never overwritten by project new, never deleted by project remove)
test('remove: the shared role agents stay while another project uses them and go with the last; the user\'s own planner.md is never touched', () => {
  const sb = sandbox(), agents = path.join(sb.cfg, 'agents'), own = path.join(agents, 'planner.md'), ours = ROLE_AGENTS.filter(n => n !== 'planner');
  fs.mkdirSync(agents, { recursive: true }); fs.writeFileSync(own, 'the user\'s own planner\n');
  for (const n of ['app-a', 'app-b']) {
    const r = path.join(sb.t, 'repos', n); fs.mkdirSync(r, { recursive: true }); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: r, stdio: 'ignore' });
    sb.run('project', 'new', '--root', r, '--non-interactive');
    assert.ok(sb.machine().projects.some(p => p.name === n), `${n} registered`);
  }
  for (const n of ours) assert.ok(fs.existsSync(path.join(agents, n + '.md')), n);
  const ra = sb.run('project', 'remove', 'app-a');
  assert.equal(ra.code, 0, ra.err + ra.out);
  for (const n of ours) assert.ok(fs.existsSync(path.join(agents, n + '.md')), `${n} kept: app-b still uses it`);
  assert.match(ra.out, /kept .*implementer\.md.*app-b/);
  const chk = sb.run('gen', '--check');
  assert.doesNotMatch(chk.out + chk.err, /missing|orphan/, 'app-b\'s generated files still line up with the manifest');
  const rb = sb.run('project', 'remove', 'app-b');
  assert.equal(rb.code, 0, rb.err + rb.out);
  for (const n of ours) assert.ok(!fs.existsSync(path.join(agents, n + '.md')), `${n} deleted with the last project`);
  assert.equal(fs.readFileSync(own, 'utf8'), 'the user\'s own planner\n');
});
