// S3 `norn setup` / `norn doctor` / `norn project add` (META-GENERAL-DESIGN 4.2 / 8): temp meta root, temp home, fake PATH,
// temp CLAUDE_CONFIG_DIR - nothing touches the live ~/.claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const fwd = p => p.replace(/\\/g, '/');

function sandbox({ claude = true, git = true } = {}) {
  const t = mkTmp('meta-setup-');
  const dirs = { root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const exe = n => path.join(dirs.bin, WIN ? n + '.exe' : n);
  if (git) fs.writeFileSync(exe('git'), ''); if (claude) fs.writeFileSync(exe('claude'), '');
  const env = { ...process.env, PATH: dirs.bin, HOME: dirs.home, USERPROFILE: dirs.home, CLAUDE_CONFIG_DIR: dirs.cfg,
    LOCALAPPDATA: path.join(dirs.home, 'AppData', 'Local'), APPDATA: path.join(dirs.home, 'AppData', 'Roaming'), META_ROOT: dirs.root };
  delete env.NPM_CONFIG_PREFIX; delete env.npm_config_prefix;
  const run = (...args) => { const r = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { ...dirs, run, machine: () => JSON.parse(fs.readFileSync(path.join(dirs.root, 'local', 'machine.json'), 'utf8')) };
}

function project(sb, name = 'demo') {
  const pd = path.join(sb.root, 'projects', name);
  fs.mkdirSync(path.join(pd, 'agents'), { recursive: true }); fs.mkdirSync(path.join(pd, 'skills', `${name}-s`), { recursive: true });
  fs.writeFileSync(path.join(pd, 'agents', `${name}-impl.md`), '# impl\n');
  fs.writeFileSync(path.join(pd, 'skills', `${name}-s`, 'SKILL.md'), '# skill\n');
  fs.mkdirSync(path.join(sb.home, 'dev', name), { recursive: true });
  const f = path.join(pd, 'project.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name, title: name, root: '${home}/dev/' + name,
    install: { agents: `\${norn}/projects/${name}/agents`, skills: `\${norn}/projects/${name}/skills` } }));
  return f;
}

test('setup --non-interactive writes local/machine.json from discovered values', () => {
  const sb = sandbox();
  const r = sb.run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(r.code, 0, r.err + r.out);
  const m = sb.machine();
  assert.equal(m.schema, 1); assert.equal(m.home, fwd(sb.home));
  assert.equal(m.claude.exe, fwd(path.join(sb.bin, WIN ? 'claude.exe' : 'claude')));
  assert.equal(m.claude.config_dir, fwd(sb.cfg)); assert.equal(m.claude.projects_dir, fwd(sb.cfg) + '/projects');
  assert.equal(m.git.exe, fwd(path.join(sb.bin, WIN ? 'git.exe' : 'git')));
  assert.equal(m.node, fwd(process.execPath));
  assert.equal(m.codex, null); assert.ok(!Object.hasOwn(m, 'grok'), 'no grok slot in machine.json');
  assert.match(m.scheduler.name, /^norn-tick-[0-9a-f]{8}$/, 'derived per install (OOTB F-4)'); assert.equal(m.scheduler.interval_min, 15);
  assert.deepEqual(m.dash, { port: 8737, bind: '127.0.0.1' }); assert.deepEqual(m.projects, []);
  assert.match(r.out, /codex: not found \(optional, disabled\)/);
});

test('setup without a required prerequisite reports it and writes nothing', () => {
  const sb = sandbox({ claude: false });
  const r = sb.run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(r.code, 1); assert.match(r.err, /claude not found \(required/);
  assert.equal(fs.existsSync(path.join(sb.root, 'local', 'machine.json')), false);
});

test('setup --project registers the project as ${norn}-relative and installs agents / skills with a sha manifest', () => {
  const sb = sandbox(); const f = project(sb);
  const r = sb.run('setup', '--non-interactive', '--no-scheduler', '--project', f);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(sb.machine().projects, [{ name: 'demo', config: '${norn}/projects/demo/project.json' }]);
  assert.equal(fs.readFileSync(path.join(sb.cfg, 'agents', 'demo-impl.md'), 'utf8'), '# impl\n');
  assert.equal(fs.readFileSync(path.join(sb.cfg, 'skills', 'demo-s', 'SKILL.md'), 'utf8'), '# skill\n');
  const man = JSON.parse(fs.readFileSync(path.join(sb.root, 'local', 'install-manifest.json'), 'utf8'));
  assert.deepEqual(man.entries.map(e => [e.project, e.target]).sort(), [['demo', fwd(path.join(sb.cfg, 'agents', 'demo-impl.md'))], ['demo', fwd(path.join(sb.cfg, 'skills', 'demo-s', 'SKILL.md'))]]);
  assert.ok(man.entries.every(e => /^[0-9a-f]{64}$/.test(e.sha256) && e.source.startsWith('${norn}/projects/demo/')));
  // re-run keeps the project list (and the owner's H4 notify opt-in) and is idempotent
  const mf = path.join(sb.root, 'local', 'machine.json');
  fs.writeFileSync(mf, JSON.stringify({ ...sb.machine(), notify: { backend: 'ntfy', topic: 't' } }));
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  assert.equal(sb.machine().projects.length, 1);
  assert.deepEqual(sb.machine().notify, { backend: 'ntfy', topic: 't' });
});

test('install never overwrites an unmanaged file that differs', () => {
  const sb = sandbox(); const f = project(sb);
  fs.mkdirSync(path.join(sb.cfg, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(sb.cfg, 'agents', 'demo-impl.md'), 'mine\n');
  const r = sb.run('setup', '--non-interactive', '--no-scheduler', '--project', f);
  assert.equal(r.code, 1); assert.match(r.err, /demo-impl\.md exists and is not managed by meta: not overwritten/);
  assert.equal(fs.readFileSync(path.join(sb.cfg, 'agents', 'demo-impl.md'), 'utf8'), 'mine\n');
});

test('project add appends to machine.json; needs setup first; a second project with the same name is refused', () => {
  const sb = sandbox(); const f = project(sb);
  let r = sb.run('project', 'add', f);
  assert.equal(r.code, 2); assert.match(r.err, /no machine\.json: run norn setup first/);
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  r = sb.run('project', 'add', f); assert.equal(r.code, 0, r.err);
  assert.match(r.out, /demo added/);
  const g = project(sb, 'other'); assert.equal(sb.run('project', 'add', g).code, 0);
  assert.deepEqual(sb.machine().projects.map(p => p.name), ['demo', 'other']);
  const elsewhere = path.join(sb.home, 'demo2.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ schema: 1, name: 'demo', title: 'x', root: '${home}' }));
  r = sb.run('project', 'add', elsewhere); assert.equal(r.code, 2); assert.match(r.err, /a project named demo is already registered/);
  fs.writeFileSync(elsewhere, '{"schema":1,"name":"bad"}');
  r = sb.run('project', 'add', elsewhere); assert.equal(r.code, 2); assert.match(r.err, /\$\.title is required/);
});

test('doctor: ok after setup; reports drift, a stale source, a missing target and a missing project root', () => {
  const sb = sandbox(); const f = project(sb);
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler', '--project', f).code, 0);
  let r = sb.run('doctor'); assert.equal(r.code, 0, r.out + r.err); assert.match(r.out, /^doctor: ok/m);
  fs.writeFileSync(path.join(sb.cfg, 'agents', 'demo-impl.md'), '# impl edited by hand\n');
  fs.writeFileSync(path.join(sb.root, 'projects', 'demo', 'skills', 'demo-s', 'SKILL.md'), '# skill v2\n');
  r = sb.run('doctor'); assert.equal(r.code, 1);
  assert.match(r.out, /PROBLEM .*demo-impl\.md: drift \(edited after install\)/);
  assert.match(r.out, /PROBLEM .*SKILL\.md: stale \(source changed since install/);
  fs.rmSync(path.join(sb.cfg, 'agents', 'demo-impl.md'));
  fs.rmSync(path.join(sb.home, 'dev', 'demo'), { recursive: true });
  r = sb.run('doctor');
  assert.match(r.out, /PROBLEM .*demo-impl\.md: missing/); assert.match(r.out, /PROBLEM demo: root .* does not exist/);
  // project add re-installs the changed source (managed target, same sha as the manifest) -> skill fixed
  fs.mkdirSync(path.join(sb.home, 'dev', 'demo'));
  assert.equal(sb.run('project', 'add', f).code, 0);
  assert.equal(fs.readFileSync(path.join(sb.cfg, 'skills', 'demo-s', 'SKILL.md'), 'utf8'), '# skill v2\n');
  r = sb.run('doctor'); assert.equal(r.code, 0, r.out);
});

test('doctor (win32): reports the resolved codex command (npm .cmd shim -> node + entry, --version runs); an unresolvable shim is a PROBLEM', { skip: !WIN }, () => {
  const sb = sandbox(); const f = project(sb);
  const shim = path.join(sb.bin, 'codex.cmd');
  fs.writeFileSync(shim, '@echo hi\r\n');
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler', '--project', f).code, 0);
  let r = sb.run('doctor'); assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PROBLEM codex: cannot resolve .*codex\.cmd/);
  fs.mkdirSync(path.join(sb.bin, 'node_modules', 'c'), { recursive: true });
  fs.writeFileSync(path.join(sb.bin, 'node_modules', 'c', 'codex.js'), "console.log('codex-cli 9.9.9')");
  fs.writeFileSync(shim, '@ECHO off\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\node_modules\\c\\codex.js" %*\r\n');
  r = sb.run('doctor'); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ok codex command .*node(\.exe)? .*node_modules\/c\/codex\.js \(codex-cli 9\.9\.9\)$/m);
});

test('doctor without machine.json says to run setup', () => {
  const sb = sandbox(); const r = sb.run('doctor');
  assert.equal(r.code, 1); assert.match(r.out + r.err, /no machine\.json: run norn setup/);
});

// S8: project sources carry ${...} forms only (lint); install renders the project's builtin vars so the installed agent works
test('install renders ${norn} / ${home} / ${root} / ${name} in agent and skill text; other ${...} kept; doctor ok, stale after a source edit', () => {
  const sb = sandbox(); const f = project(sb);
  const src = path.join(sb.root, 'projects', 'demo', 'agents', 'demo-impl.md');
  fs.writeFileSync(src, '# impl\nrules ${norn}/house-rules.txt, repo ${root}, home ${home}, project ${name}, shell ${HOME} ${lane}\n');
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler', '--project', f).code, 0);
  assert.equal(fs.readFileSync(path.join(sb.cfg, 'agents', 'demo-impl.md'), 'utf8'),
    `# impl\nrules ${fwd(sb.root)}/house-rules.txt, repo ${fwd(sb.home)}/dev/demo, home ${fwd(sb.home)}, project demo, shell \${HOME} \${lane}\n`);
  const d = sb.run('doctor'); assert.equal(d.code, 0, d.out); assert.match(d.out, /doctor: ok/);
  fs.appendFileSync(src, 'more\n');
  const d2 = sb.run('doctor'); assert.equal(d2.code, 1); assert.match(d2.out, /demo-impl\.md: stale/);
});

test('setup puts a `norn` shim in ~/.local/bin (design 3.5 "on PATH after setup"); a foreign file is kept (S9)', () => {
  const sb = sandbox();
  const r = sb.run('setup', '--non-interactive', '--no-scheduler', '--force');
  assert.equal(r.code, 0, r.err + r.out);
  const bin = path.join(sb.home, '.local', 'bin');
  const sh = fs.readFileSync(path.join(bin, 'norn'), 'utf8');
  assert.match(sh, /^#!\/bin\/sh\n/); assert.ok(sh.includes(fwd(META)), sh);
  if (WIN) assert.ok(fs.readFileSync(path.join(bin, 'norn.cmd'), 'utf8').includes(META), 'norn.cmd');
  assert.match(r.out, /not on PATH/);  // the sandbox PATH is only the fake bin dir
  const own = spawnSync(WIN ? path.join(bin, 'norn.cmd') : path.join(bin, 'norn'), ['rec', 'list', '--state', path.join(sb.root, 'st')],
    { env: { ...process.env, META_ROLE: 'owner' }, encoding: 'utf8', shell: WIN });
  assert.equal(own.status, 0, own.stderr);
  fs.writeFileSync(path.join(bin, 'norn'), 'mine\n');
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler', '--force').code, 0);
  assert.equal(fs.readFileSync(path.join(bin, 'norn'), 'utf8'), 'mine\n');
});

test('setup writes only the `norn` launcher (norn.cmd beside it on Windows) and it runs engine/bin/norn.mjs (META-RENAME R1)', () => {
  const sb = sandbox();
  const bin = path.join(sb.home, '.local', 'bin');
  const f = sb.run('setup', '--non-interactive', '--no-scheduler', '--force');
  assert.equal(f.code, 0, f.out + f.err);
  assert.match(fs.readFileSync(path.join(bin, 'norn'), 'utf8'), /engine\/bin\/norn\.mjs/, 'norn runs norn.mjs');
  assert.deepEqual(fs.readdirSync(bin).sort(), WIN ? ['norn', 'norn.cmd'] : ['norn']);
  const own = spawnSync(WIN ? path.join(bin, 'norn.cmd') : path.join(bin, 'norn'), ['rec', 'list', '--state', path.join(sb.root, 'st')],
    { env: { ...process.env, META_ROLE: 'owner' }, encoding: 'utf8', shell: WIN });
  assert.equal(own.status, 0, own.stderr);
});

// META-RENAME R1 bug (11-13 01:46Z): a merge worker ran `META_ROOT=<tmp> norn setup` in its worktree; HOME was the owner's, so setup
// pointed the owner's ~/.local/bin/norn(.cmd) at that worktree. A launcher never points at a linked git worktree unless --force.
const fakeInstall = (t, worktreeOf) => {
  const root = path.join(t, worktreeOf ? 'wt' : 'main');
  fs.mkdirSync(path.join(root, 'engine', 'bin'), { recursive: true }); fs.writeFileSync(path.join(root, 'engine', 'bin', 'norn.mjs'), '');
  if (worktreeOf) fs.writeFileSync(path.join(root, '.git'), `gitdir: ${fwd(worktreeOf)}/.git/worktrees/wt\n`);
  else fs.mkdirSync(path.join(root, '.git'));
  return root;
};
test('a launcher is never pointed at a linked git worktree: setup names the main checkout and needs --force; a main checkout / plain copy is written', async () => {
  const { installShim } = await import('../engine/lib/setup.mjs');
  const t = mkTmp('meta-shimwt-'), home = path.join(t, 'home'), main = fakeInstall(t), wt = fakeInstall(t, main), bin = path.join(home, '.local', 'bin');
  let lines = [];
  installShim({ home, root: wt, env: {}, out: s => lines.push(s) });
  assert.equal(fs.existsSync(path.join(bin, 'norn')), false, 'nothing written from a worktree');
  const said = lines.join('\n');
  assert.match(said, /linked git worktree/); assert.match(said, /--force/);
  assert.ok(said.includes(`main checkout is ${fwd(main)} `), said);
  lines = [];
  installShim({ home, root: wt, force: true, env: {}, out: s => lines.push(s) });
  assert.ok(fs.readFileSync(path.join(bin, 'norn'), 'utf8').includes(`${fwd(wt)}/engine/bin/norn.mjs`), 'with --force: written');
  installShim({ home, root: main, env: {}, out: () => {} });
  assert.match(fs.readFileSync(path.join(bin, 'norn'), 'utf8'), /\/main\/engine\/bin\/norn\.mjs/, 'the main checkout takes over a launcher whose worktree is gone or ours');
});

// SHIP-READY R1 (a stranger's Windows install): the "not on PATH" hint was sh syntax (alias norn='...') on Windows too, where
// PowerShell's alias cannot carry arguments. Each OS gets a line its own shell runs.
test('the launcher\'s "not on PATH" hint is in the shell of the OS: PowerShell on Windows, sh elsewhere', async () => {
  const { installShim } = await import('../engine/lib/setup.mjs');
  const said = platform => { const t = mkTmp('meta-shimhint-'), lines = []; installShim({ home: path.join(t, 'home'), root: fakeInstall(t), platform, env: {}, out: s => lines.push(s) }); return { t, s: lines.join('\n') }; };
  const w = said('win32');
  assert.match(w.s, /not on PATH/);
  assert.doesNotMatch(w.s, /alias norn=/, w.s);
  assert.ok(w.s.includes(`function norn { node "${fwd(w.t)}/main/engine/bin/norn.mjs" @args }`), w.s);
  const l = said('linux');
  assert.ok(l.s.includes(`alias norn='node ${fwd(l.t)}/main/engine/bin/norn.mjs'`), l.s);
});

// META-ONBOARD S1 (3-OS smoke, macOS red): the CLI started through a symlinked / junction path (macOS /var -> /private/var) must
// still run - the "am I the main module" check compared the given argv path with the real module path and silently did nothing.
test('the CLI runs when started through a symlinked (junction) engine root: setup writes machine.json', () => {
  const sb = sandbox();
  const repo = path.resolve(path.dirname(META), '..', '..'), link = path.join(path.dirname(sb.root), 'engine-link');
  fs.symlinkSync(repo, link, WIN ? 'junction' : 'dir');
  const r = spawnSync(process.execPath, [path.join(link, 'engine', 'bin', 'norn.mjs'), 'setup', '--non-interactive', '--no-scheduler'],
    { env: { ...process.env, PATH: sb.bin, HOME: sb.home, USERPROFILE: sb.home, CLAUDE_CONFIG_DIR: sb.cfg, META_ROOT: sb.root }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /wrote .*machine\.json/);
  assert.ok(fs.existsSync(path.join(sb.root, 'local', 'machine.json')), 'machine.json written under META_ROOT');
});

test('setup verifies its own write: machine.json that cannot be written is a loud error (exit 1), not a crash or a silent 0', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.root, 'local', 'machine.json'), { recursive: true });   // a directory where the file must go
  const r = sb.run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(r.code, 1, r.err + r.out);
  assert.match(r.err, /^error: .*machine\.json/m);
  assert.doesNotMatch(r.err, /\n\s+at /, 'no stack trace');
});

// META-ONBOARD S2 (SPEC 3.1): a missing prerequisite is named with this OS's official install line (printed, never run)
const installLine = tool => (WIN ? { git: 'winget install --id Git.Git -e --source winget', claude: 'irm https://claude.ai/install.ps1 | iex', codex: 'npm install -g @openai/codex', gh: 'winget install --id GitHub.cli' }
  : process.platform === 'darwin' ? { git: 'brew install git', claude: 'curl -fsSL https://claude.ai/install.sh | bash', codex: 'npm install -g @openai/codex', gh: 'brew install gh' } : null)?.[tool];

test('setup with a missing git prints error + the install line for this OS and writes nothing', () => {
  const sb = sandbox({ git: false });
  const r = sb.run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(r.code, 1, r.err + r.out);
  assert.match(r.err, /^error: git not found \(required: PATH\)\r?\n {2}install: .+/m);
  if (installLine('git')) assert.ok(r.err.includes('  install: ' + installLine('git')), r.err);
  assert.equal(fs.existsSync(path.join(sb.root, 'local', 'machine.json')), false);
});

test('doctor: a missing required tool is a PROBLEM with its install line (exit 1); missing optional codex / gh are notes (exit 0)', () => {
  const sb = sandbox();
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  let r = sb.run('doctor');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^note codex not found \(optional\) - install: /m); assert.match(r.out, /^note gh not found \(optional\) - install: /m);
  if (installLine('gh')) assert.ok(r.out.includes(installLine('gh')), r.out);
  assert.match(r.out, /doctor: ok/);
  fs.rmSync(path.join(sb.bin, WIN ? 'claude.exe' : 'claude'));
  r = sb.run('doctor');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^PROBLEM claude: .* does not exist \(rerun norn setup\)\r?\n {2}install: /m);
  if (installLine('claude')) assert.ok(r.out.includes('  install: ' + installLine('claude')), r.out);
});
