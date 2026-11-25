// META-ONBOARD S5 (SPEC 3.5): SETUP.md is walked verbatim - every guide:run block in order through the real CLI of a fresh clone
// (fake claude on PATH, the real git, temp HOME / CLAUDE_CONFIG_DIR, META_ROOT = the clone), a temp git repo with a GitHub origin
// standing in for "your repo". Also: the walker itself fails on a wrong expect, an unmarked block and a skip without a reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { which } from '../engine/lib/paths.mjs';
import { parseGuide, walkGuide } from './helpers/guide.mjs';
import { rustReady, rustInto } from './helpers/rust.mjs';

test.before(rustReady);   // the guide's norn setup builds norn-hook and norn-code: a cold build runs here, never inside the walk's time limit

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = fs.readFileSync(path.join(REPO, 'SETUP.md'), 'utf8');
const WIN = process.platform === 'win32';

test('SETUP.md walks: every guide:run block of a fresh clone succeeds and matches its expect', { timeout: 240000 }, () => {
  const t = mkTmp('meta-guide-');
  const clone = path.join(t, 'norn'), home = path.join(t, 'home'), bin = path.join(t, 'bin'), cfg = path.join(t, 'claude'), repo = path.join(t, 'my-app');
  execFileSync('git', ['clone', '--no-hardlinks', '--quiet', REPO, clone], { stdio: ['ignore', 'ignore', 'pipe'] });
  rustInto(path.join(clone, 'engine'));   // the clone's own store is empty: the parts built before are put there, as smoke does
  // the guide as committed is what a user gets; the working copy's SETUP.md is the one under test (same file once committed)
  fs.writeFileSync(path.join(clone, 'SETUP.md'), GUIDE);
  for (const d of [home, bin, cfg, repo]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, WIN ? 'claude.exe' : 'claude'), '');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/someone/my-app.git'], { cwd: repo });
  // a fresh machine's PATH: the fake claude, the real git and node (+ the Windows system dir) - never the host's PATH, whose own
  // tools (CI 43207062452: the WSL runner saw the Windows npm codex shim through interop, --version exit 1) are not the guide's
  // Git for Windows: its mingw64\bin\git.exe needs usr\bin beside it; the install's cmd\ launcher (what its installer puts on PATH)
  // is self-contained - <root>\mingw64\libexec\git-core is `git --exec-path`
  const gitCmd = WIN && path.resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '..', '..', '..', 'cmd');
  const gitDir = gitCmd && fs.existsSync(path.join(gitCmd, 'git.exe')) ? gitCmd : path.dirname(which('git'));
  const R = process.env.SystemRoot || 'C:\\Windows';   // a fresh Windows' system PATH entries
  const sys = WIN ? ['System32', '', 'System32\\Wbem', 'System32\\WindowsPowerShell\\v1.0'].map(d => path.join(R, d)) : [];
  // Rust is a prerequisite (d7071303: setup builds norn-hook with cargo, no binary = a setup error): cargo on PATH, and rustup / cargo
  // keep their real homes (they default to <HOME>/.rustup and <HOME>/.cargo, which the temp HOME lacks; smoke.mjs sandboxEnv does the same)
  const cargo = which('cargo'), real = os.homedir();
  assert.ok(cargo, 'cargo on the host PATH (SETUP.md 1: Rust is a prerequisite)');
  const PATH = [bin, gitDir, path.dirname(process.execPath), path.dirname(cargo), ...sys].join(path.delimiter);
  const env = { ...process.env, PATH, HOME: home, USERPROFILE: home,
    RUSTUP_HOME: process.env.RUSTUP_HOME || path.join(real, '.rustup'), CARGO_HOME: process.env.CARGO_HOME || path.join(real, '.cargo'),
    CLAUDE_CONFIG_DIR: cfg, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'), META_ROOT: clone, META_NO_TICK: '1' };
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH' && k !== 'PATH') delete env[k];   // Windows: process.env has Path
  for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID', 'NPM_CONFIG_PREFIX', 'npm_config_prefix']) delete env[k];
  const run = argv => {
    const [cmd, ...args] = argv[0] === 'meta' ? ['node', 'engine/bin/norn.mjs', ...argv.slice(1)] : argv;
    assert.equal(cmd, 'node', `the guide runs node commands only (got ${argv.join(' ')})`);
    const r = spawnSync(process.execPath, args, { cwd: clone, env, encoding: 'utf8', timeout: 180000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const fwdp = p => p.split(path.sep).join('/');
  const fails = walkGuide(GUIDE, { run, vars: { repo: fwdp(repo), name: 'my-app', project: fwdp(path.join(home, '.norn', 'projects', 'my-app', 'project.json')),
    // META-ADOPT A5: the first lane is the one apply opened, named after the first-task answer
    lane: 'add-a-usage-section-to-the-readme', brief: fwdp(path.join(clone, 'state', 'my-app', 'briefs', 'add-a-usage-section-to-the-readme.md')) } });
  assert.deepEqual(fails, []);
  fs.rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
