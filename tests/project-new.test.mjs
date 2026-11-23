// `norn project new` and the first task after it: a project.json for the user's repo from detected values, validated before it is
// written, written under machine.json projects_home (never inside the engine's tracked tree), registered; the generic role agents and
// a policy routing only to them + what the caps allow; then the first lane, run and dashboard box. One file per feature, so a case
// lives in one place. Temp meta root, temp HOME, a fake claude (and codex) first on PATH, the real git after it; nothing touches the live machine.
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
import { createDashboard } from '../engine/dash/server.mjs';
import { renderTab, loadTab } from '../engine/dash/ui.mjs';
import { POLICY_DEFAULTS, ROLE_AGENTS, STARTER_CAPS, BASIC_KEYS, SECTIONS, settingsView, starterPolicy } from '../engine/lib/policy.mjs';
import { getProfile, profilePolicy, profileChanges, COSTS } from '../engine/lib/profiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const ENGINE_AGENTS = path.join(HERE, '..', 'engine', 'agents');
const WIN = process.platform === 'win32';
const fwd = p => p.split(path.sep).join('/');
const GIT_DIR = path.dirname(which('git'));

function sandbox({ codex = false } = {}) {
  hookReady();   // norn setup needs a built norn-hook; the sandbox PATH has no cargo
  const t = mkTmp('meta-pnew-');
  const d = { root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg'), t };
  for (const x of [d.root, d.home, d.bin, d.cfg]) fs.mkdirSync(x, { recursive: true });
  for (const n of ['claude', ...(codex ? ['codex'] : [])]) fs.writeFileSync(path.join(d.bin, WIN ? n + '.exe' : n), '');
  const env = { ...process.env, PATH: d.bin + path.delimiter + GIT_DIR, HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming'), META_ROOT: d.root, META_NO_TICK: '1' };
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID']) delete env[k];
  const run = (args, { input, extra } = {}) => {
    const r = spawnSync(process.execPath, [META, ...args], { env: { ...env, ...extra }, encoding: 'utf8', input: input ?? '' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const r = run(['setup', '--non-interactive', '--no-scheduler']);
  assert.equal(r.code, 0, r.err + r.out);
  return { ...d, run, budgetFile: path.join(d.root, 'local', 'budget.json'), machine: () => JSON.parse(fs.readFileSync(path.join(d.root, 'local', 'machine.json'), 'utf8')) };
}

function repo(sb, name = 'My Widget', { origin, branch = 'main', originHead, commit } = {}) {
  const r = path.join(sb.t, name);
  fs.mkdirSync(r, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: r, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  g('init', '-q', '-b', branch);
  if (origin) g('remote', 'add', 'origin', origin);
  if (originHead) g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/' + originHead);
  if (commit) g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');   // a worktree needs a commit
  return { dir: r, g };
}
const newP = (sb, root, ...more) => sb.run(['project', 'new', '--root', root, '--non-interactive', ...more]);
const fileOf = (sb, name) => path.join(sb.home, '.norn', 'projects', name, 'project.json');
const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));

test('setup writes projects_home = ${home}/.norn/projects (kept on a re-setup)', () => {
  const sb = sandbox();
  assert.equal(sb.machine().projects_home, '${home}/.norn/projects');
});

test('new: https github origin -> ci.repo; name slugified from the root; written under projects_home, validated, registered', () => {
  const sb = sandbox(), r = repo(sb, 'My Widget', { origin: 'https://github.com/acme/widget.git' });
  const x = newP(sb, r.dir);
  assert.equal(x.code, 0, x.err + x.out);
  const f = fileOf(sb, 'my-widget');
  assert.match(x.out.trimEnd(), new RegExp(`project my-widget: OK \\(${fwd(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)$`));
  const p = json(f);
  assert.equal(p.name, 'my-widget'); assert.equal(p.title, 'my-widget'); assert.equal(p.root, fwd(r.dir));
  assert.deepEqual(p.ci, { repo: 'acme/widget', branch: 'main' });
  assert.ok(fs.statSync(path.join(path.dirname(f), 'rules')).isDirectory(), 'an empty rules/ dir');
  assert.equal(p.ledger, '${state}/progress.md'); assert.equal(p.lane_defaults.worktree, '${state}/wt/${lane}');
  loadProject(f, { home: sb.home, meta: sb.root });   // validates
  assert.ok(sb.machine().projects.some(q => q.name === 'my-widget'), 'registered');
});

test('new: ssh origin -> ci.repo; no origin -> no ci; --ci none omits it; --name / --title / --ci override', () => {
  const sb = sandbox();
  const a = repo(sb, 'a', { origin: 'git@github.com:acme/alpha.git' });
  assert.equal(newP(sb, a.dir).code, 0);
  assert.deepEqual(json(fileOf(sb, 'a')).ci, { repo: 'acme/alpha', branch: 'main' });
  const b = repo(sb, 'b');
  assert.equal(newP(sb, b.dir).code, 0);
  assert.equal(json(fileOf(sb, 'b')).ci, undefined);
  const c = repo(sb, 'c', { origin: 'https://github.com/acme/gamma' });
  assert.equal(newP(sb, c.dir, '--ci', 'none').code, 0);
  assert.equal(json(fileOf(sb, 'c')).ci, undefined);
  const d = repo(sb, 'd', { origin: 'https://gitlab.com/acme/delta.git' });
  const x = newP(sb, d.dir, '--name', 'dee', '--title', 'The D', '--ci', 'other/repo');
  assert.equal(x.code, 0, x.err);
  const p = json(fileOf(sb, 'dee'));
  assert.equal(p.title, 'The D'); assert.deepEqual(p.ci, { repo: 'other/repo', branch: 'main' });
});

test('new: branch = --branch, else origin/HEAD, else the current branch, else main', () => {
  const sb = sandbox();
  const o = 'https://github.com/acme/w.git';
  const a = repo(sb, 'a', { origin: o, branch: 'dev', originHead: 'trunk' });
  assert.equal(newP(sb, a.dir).code, 0); assert.equal(json(fileOf(sb, 'a')).ci.branch, 'trunk');
  const b = repo(sb, 'b', { origin: o, branch: 'dev' });
  assert.equal(newP(sb, b.dir).code, 0); assert.equal(json(fileOf(sb, 'b')).ci.branch, 'dev');
  const c = repo(sb, 'c', { origin: o, branch: 'dev' });
  c.g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'); c.g('checkout', '-q', '--detach');
  assert.equal(newP(sb, c.dir).code, 0); assert.equal(json(fileOf(sb, 'c')).ci.branch, 'main');
  const d = repo(sb, 'd', { origin: o, originHead: 'trunk' });
  assert.equal(newP(sb, d.dir, '--branch', 'rel').code, 0); assert.equal(json(fileOf(sb, 'd')).ci.branch, 'rel');
});

test('new: executors = what the machine has (codex only with machine.codex); --executors narrows; unknown / undetected = exit 2', () => {
  const plain = sandbox(), r1 = repo(plain, 'p');
  assert.equal(newP(plain, r1.dir).code, 0);
  assert.deepEqual(json(fileOf(plain, 'p')).executors, { 'codex-sol': { enabled: false }, 'codex-astra': { enabled: false } });
  const x = newP(plain, repo(plain, 'q').dir, '--executors', 'claude,codex-sol');
  assert.equal(x.code, 2); assert.match(x.err, /codex-sol.*not (found|detected)/);
  const y = newP(plain, repo(plain, 'r').dir, '--executors', 'claude,nope');
  assert.equal(y.code, 2); assert.match(y.err, /unknown executor nope/);
  const cx = sandbox({ codex: true }), r2 = repo(cx, 'p');
  assert.equal(newP(cx, r2.dir).code, 0);
  assert.deepEqual(json(fileOf(cx, 'p')).executors, { 'codex-sol': { enabled: true }, 'codex-astra': { enabled: true } });
  assert.equal(newP(cx, repo(cx, 'q').dir, '--executors', 'claude,codex-astra').code, 0);
  assert.deepEqual(json(fileOf(cx, 'q')).executors, { 'codex-sol': { enabled: false }, 'codex-astra': { enabled: true } });
});

test('new refuses: a non-git root, a registered name, an existing file, a target inside the engine tree (local/ allowed), an unknown profile', () => {
  const sb = sandbox();
  const plain = path.join(sb.t, 'plain'); fs.mkdirSync(plain);
  let x = newP(sb, plain);
  assert.equal(x.code, 2); assert.match(x.err, /not a git repo/);
  const a = repo(sb, 'a');
  assert.equal(newP(sb, a.dir).code, 0);
  x = newP(sb, repo(sb, 'a2').dir, '--name', 'a', '--dir', path.join(sb.t, 'elsewhere'));
  assert.equal(x.code, 2); assert.match(x.err, /already registered/);
  const pre = path.join(sb.t, 'pre'); fs.mkdirSync(pre); fs.writeFileSync(path.join(pre, 'project.json'), 'mine');
  x = newP(sb, repo(sb, 'b').dir, '--dir', pre);
  assert.equal(x.code, 2); assert.match(x.err, /exists/); assert.equal(fs.readFileSync(path.join(pre, 'project.json'), 'utf8'), 'mine');
  x = newP(sb, repo(sb, 'c').dir, '--dir', path.join(sb.root, 'projects', 'c'));
  assert.equal(x.code, 2); assert.match(x.err, /inside the engine/); assert.equal(fs.existsSync(path.join(sb.root, 'projects', 'c')), false);
  x = newP(sb, repo(sb, 'd').dir, '--dir', path.join(sb.root, 'local', 'projects', 'd'));
  assert.equal(x.code, 0, x.err);
  x = newP(sb, repo(sb, 'e').dir, '--print', '--profile', 'nope');
  assert.equal(x.code, 2); assert.match(x.err, /unknown profile nope/);
});

test('new --print prints the JSON and writes / registers nothing; --no-register writes but does not register', () => {
  const sb = sandbox(), r = repo(sb, 'pp', { origin: 'https://github.com/acme/pp.git' });
  const x = newP(sb, r.dir, '--print');
  assert.equal(x.code, 0, x.err);
  assert.equal(JSON.parse(x.out).name, 'pp');
  assert.equal(fs.existsSync(path.dirname(fileOf(sb, 'pp'))), false); assert.equal(sb.machine().projects.length, 0);
  assert.equal(newP(sb, r.dir, '--no-register').code, 0);
  assert.ok(fs.existsSync(fileOf(sb, 'pp'))); assert.equal(sb.machine().projects.length, 0);
});

test('new: an invalid draft writes nothing (exit 2, the schema error listed)', () => {
  const sb = sandbox(), r = repo(sb, 'v', { origin: 'https://github.com/acme/v.git' });
  const x = newP(sb, r.dir, '--name', 'Bad Name!');
  assert.equal(x.code, 2); assert.match(x.err, /\$\.name must match/);
  assert.equal(fs.existsSync(path.join(sb.home, '.norn')), false);
});

test('new interactive (piped stdin): each value asked with the detected default; blank = default', () => {
  const sb = sandbox(), r = repo(sb, 'iv', { origin: 'https://github.com/acme/iv.git' });
  const x = sb.run(['project', 'new', '--root', r.dir], { input: '\nInteractive Title\n\n\n\n', extra: { META_INTERACTIVE: '1' } });
  assert.equal(x.code, 0, x.err + x.out);
  assert.match(x.out, /name \[iv\]/); assert.match(x.out, /ci \[acme\/iv\]/);
  const p = json(fileOf(sb, 'iv'));
  assert.equal(p.title, 'Interactive Title'); assert.deepEqual(p.ci, { repo: 'acme/iv', branch: 'main' });
});

test('${project_dir} renders in installed agents (a project dir anywhere)', () => {
  const sb = sandbox(), r = repo(sb, 'pd');
  const dir = path.join(sb.t, 'somewhere', 'pd');
  assert.equal(newP(sb, r.dir, '--dir', dir, '--no-register').code, 0);
  const f = path.join(dir, 'project.json'), p = json(f);
  // project new made agents/ (the generic role agents); a project agent beside them renders its own project dir
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true }); fs.writeFileSync(path.join(dir, 'agents', 'pd-impl.md'), 'rules: ${project_dir}/rules/R.md\n');
  p.install = { agents: '${project_dir}/agents' }; fs.writeFileSync(f, JSON.stringify(p));
  const x = sb.run(['project', 'add', f]);
  assert.equal(x.code, 0, x.err + x.out);
  assert.equal(fs.readFileSync(path.join(sb.cfg, 'agents', 'pd-impl.md'), 'utf8'), `rules: ${fwd(dir)}/rules/R.md\n`);
});

// ---------- routing: the generic role agents + only the executors the caps allow ----------
const routed = p => [...Object.values(p.executors).map(e => e.executor), ...Object.values(p.fallbacks)];
const OK = found => ['auto', 'wait', 'opus-xhigh', ...ROLE_AGENTS, ...found];
const CODEX = ['claude', 'codex-sol', 'codex-astra'];

test('starterPolicy routes only to the generic roles + the found executors the caps allow; unset caps = no limit; the Codex total wins', () => {
  const claudeOnly = starterPolicy(['claude']);
  assert.deepEqual(Object.keys(claudeOnly.executors).sort(), Object.keys(POLICY_DEFAULTS.executors).sort());
  for (const n of routed(claudeOnly)) assert.ok(OK(['claude']).includes(n), n);
  for (const caps of [undefined, {}]) assert.deepEqual(starterPolicy(CODEX, caps).executors, POLICY_DEFAULTS.executors, 'no caps: the engine defaults');
  for (const n of routed(starterPolicy(CODEX))) assert.ok(OK(CODEX).includes(n), n);
  assert.deepEqual(starterPolicy(CODEX, STARTER_CAPS), claudeOnly, 'Codex found but the starter caps give 0 Codex: as if none were found');
  assert.deepEqual(starterPolicy(['claude'], STARTER_CAPS), claudeOnly);
  const solOnly = starterPolicy(CODEX, { max_codex: 2, max_sol: 2, max_astra: 0 });
  assert.ok(routed(solOnly).includes('codex-sol'));
  assert.ok(!routed(solOnly).includes('codex-astra'), 'astra capped at 0: never routed');
  for (const n of routed(starterPolicy(CODEX, { max_codex: 2, max_sol: 0 }))) assert.ok(OK(['codex-astra']).includes(n), `sol capped at 0: never routed (${n})`);
  assert.ok(!routed(starterPolicy(CODEX, { max_codex: 0, max_sol: 5, max_astra: 5 })).some(n => /codex/.test(n)), 'the Codex total wins over a per-kind cap');
});

// one end-to-end run per machine shape: each writes the policy the unit test above pins, never a codex route the caps forbid
for (const c of [{ name: 'no Codex' }, { name: 'Codex found, starter caps', codex: true }, { name: '--profile heavy --cost quality', profile: ['--profile', 'heavy', '--cost', 'quality'] }]) {
  test(`project new (${c.name}): the generic role agents installed, the policy routes only to them`, () => {
    const sb = sandbox({ codex: c.codex });
    if (c.codex) assert.equal(json(sb.budgetFile).max_codex, 0, 'the starter caps are in force');
    const r = newP(sb, repo(sb, 'my-app').dir, ...(c.profile || []));
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /my-app: 3 generated file\(s\) managed/);
    const dir = path.dirname(fileOf(sb, 'my-app')), pj = json(fileOf(sb, 'my-app'));
    assert.equal(pj.install.agents, '${project_dir}/agents');
    for (const n of ROLE_AGENTS) {
      assert.equal(fs.readFileSync(path.join(dir, 'agents', n + '.md'), 'utf8'), fs.readFileSync(path.join(ENGINE_AGENTS, n + '.md'), 'utf8'));
      assert.ok(fs.existsSync(path.join(sb.cfg, 'agents', n + '.md')), `${n} installed in the Claude config dir`);
    }
    const want = c.profile ? profilePolicy(getProfile('heavy'), { found: ['claude'], cost: 'quality' }) : starterPolicy(['claude']);
    assert.deepEqual(pj.policy.executors, want.executors); assert.deepEqual(pj.policy.fallbacks, want.fallbacks);
    assert.equal(pj.policy.cadence.auto_resume_max, 2, 'the cadence defaults stay');
    assert.equal(pj.policy.cadence.checkin_interval_min, c.profile ? 15 : undefined, 'a profile sets the check-in interval; none keeps the starter policy');
    if (!c.codex) assert.equal(sb.run(['doctor']).code, 0, 'doctor ok (the fake codex exe cannot answer --version, so not with Codex)');
  });
}

// ---------- the first task ----------
function firstProject() {
  const sb = sandbox(), r = repo(sb, 'my-app', { commit: true });
  assert.equal(newP(sb, r.dir).code, 0);
  const pf = fileOf(sb, 'my-app'), state = path.join(sb.root, 'state', 'my-app');
  const recs = () => fs.readFileSync(path.join(state, 'records.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { ...sb, repo: r.dir, pf, state, recs };
}
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

test('first task: run on a lane with no worktree = one line naming lane new; lane new --task = lane record, worktree, directive, brief; a fake run on it ends DONE', () => {
  const s = firstProject(), run = (...a) => s.run([...a, '--project', s.pf]);
  const b = path.join(s.t, 'b.md'); fs.writeFileSync(b, 'mode: done\n');
  const no = run('run', '--executor', 'fake', '--lane', 'nowt', '--brief', b);
  assert.equal(no.code, 2, no.err + no.out);
  const lines = (no.err + no.out).trim().split(/\r?\n/);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^error: lane nowt has no worktree \(.*wt\/nowt\): create it with: norn lane new nowt --project /);
  const r = run('lane', 'new', 'first', '--task', 'Add a usage line to the README');
  assert.equal(r.code, 0, r.err + r.out);
  const wt = path.join(s.state, 'wt', 'first');
  assert.equal(gitOut(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'norn/first');
  assert.ok(gitOut(s.repo, 'worktree', 'list').includes('norn/first'), 'a worktree of the project root repo');
  const recs = s.recs(), lane = recs.find(e => e.kind === 'lane'), dir = recs.find(e => e.kind === 'directive');
  assert.equal(lane.id, 'L:first'); assert.equal(lane.ev, 'create'); assert.equal(lane.data.branch, 'norn/first');
  assert.equal(path.resolve(lane.data.worktree), path.resolve(wt));
  assert.equal(dir.by, 'owner'); assert.equal(dir.data.text, 'Add a usage line to the README'); assert.deepEqual(dir.data.scope, ['first']);
  const brief = path.join(s.state, 'briefs', 'first.md');
  assert.match(fs.readFileSync(brief, 'utf8'), /Add a usage line to the README/);
  assert.match(r.out, /^lane first: worktree .*wt\/first on branch norn\/first/m);
  assert.match(r.out, /^next: norn run --executor claude --lane first --brief .*first\.md --project /m);
  const again = run('lane', 'new', 'first');   // again: nothing duplicated, nothing broken
  assert.equal(again.code, 0, again.err + again.out); assert.match(again.out, /exists/);
  assert.equal(s.recs().filter(e => e.kind === 'lane').length, 1);
  const go = run('run', '--executor', 'fake', '--lane', 'first', '--brief', brief, '--wait');
  assert.equal(go.code, 0, go.err + go.out);
  assert.match(go.out, /^STARTED RUN-1 lane first fake/m); assert.doesNotMatch(go.out, /fake fake/, 'executor and model said once');
  assert.match(go.out, /^RUN-1 exited: DONE$/m);
});

test('dashboard on a fresh project: Settings offers the profiles (fill-in only); Overview offers the first task with the caps in force, and the box records it', async () => {
  const s = firstProject();
  const p = loadProject(s.pf, { home: s.home, meta: s.root });
  const platform = { tick: async () => ({ pid: 1 }), setInterval: async () => ({ ok: true }), ask: async () => ({ result: '', usage: {} }) };
  const app = createDashboard({ projects: [p], machine: { home: s.home }, budgetFile: s.budgetFile, platform, projectsDir: path.join(s.t, 'cp'),
    codexDir: path.join(s.t, 'cx'), sessionsDir: path.join(s.t, 'sessions'), artDir: path.join(s.t, 'art') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const get = async r => (await fetch(url + r)).json();
  const post = async (r, b) => { const x = await fetch(url + r, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dash-token': app.token }, body: JSON.stringify(b) }); return { status: x.status, data: await x.json() }; };
  try {
    // Settings: a profile drop-down that only fills the form (Save stays the human step) and the basic / all split
    const before = fs.readFileSync(s.budgetFile, 'utf8'), pjBefore = fs.readFileSync(s.pf, 'utf8');
    const d = await get('/api/settings?project=my-app');
    assert.deepEqual(d.profiles.map(x => x.name), ['try-it', 'solo', 'heavy']);
    assert.deepEqual(d.profiles[1].changes.balanced, profileChanges(getProfile('solo'), { found: ['claude'], cost: 'balanced', agents: [...ROLE_AGENTS] }));
    assert.deepEqual(Object.keys(d.profiles[1].changes).sort(), [...COSTS].sort());
    assert.equal(fs.readFileSync(s.budgetFile, 'utf8'), before, 'loading the profiles writes nothing');
    assert.equal(fs.readFileSync(s.pf, 'utf8'), pjBefore);
    const set = renderTab('settings', await loadTab('settings', 'my-app', get), { now: Date.now() });
    assert.match(set, /<select[^>]+data-set-profile/); assert.match(set, /<option value="try-it"/); assert.match(set, /<select[^>]+data-set-cost/);
    assert.match(set, /data-act="set-profile"/);
    assert.match(set, /data-set-level="basic"/); assert.match(set, /data-set-level="all"/);
    for (const k of BASIC_KEYS) assert.match(set, new RegExp(`id="set-${k.replace(/\./g, '\\.')}"[^>]*data-basic="1"`), `basic row ${k}`);
    assert.doesNotMatch(set, /id="set-cacheR_per_pct"[^>]*data-basic="1"/);
    // Overview: no records yet, so the first-task box with the caps in force
    const ov = await get('/api/strip?project=my-app');
    assert.deepEqual(ov.first_run, { project: 'my-app', lane: 'first', caps: { max_claude_workers: 1, max_codex: 0, weekly_stop_pct: 50, usage_rate_cap_pct_per_h: 0.3 } });
    const html = renderTab('lanes', await loadTab('lanes', 'my-app', get), { now: Date.now(), strip: ov });
    assert.match(html, /id="first-task"/); assert.match(html, /Give Norn its first task/);
    assert.match(html, /<input[^>]+id="first-task-text"/); assert.match(html, /data-act="first-task"/);
    assert.match(html, /Caps in force: <b>1<\/b> Claude worker.*<b>0<\/b> Codex.*weekly stop <b>50 %<\/b>.*rate cap <b>0\.3 %\/h<\/b>/);
    assert.equal((await post('/api/first-task', { project: 'my-app', text: '  ' })).status, 400);
    const r = await post('/api/first-task', { project: 'my-app', text: 'Add a usage line to the README' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.lane, 'L:first'); assert.equal(r.data.branch, 'norn/first'); assert.match(r.data.directive, /^DIR-1$/);
    assert.equal(gitOut(path.join(s.state, 'wt', 'first'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'norn/first');
    const dir = s.recs().find(e => e.kind === 'directive');
    assert.equal(dir.by, 'dashboard'); assert.equal(dir.data.via, 'dashboard'); assert.equal(dir.data.text, 'Add a usage line to the README');
    const ov2 = await get('/api/strip?project=my-app');
    assert.equal(ov2.first_run, null, 'the box goes once the project has records');
    assert.doesNotMatch(renderTab('lanes', await loadTab('lanes', 'my-app', get), { now: Date.now(), strip: ov2 }), /id="first-task"/);
  } finally { await app.close(); }
});

test('Settings on a fresh budget: an unset enum shows "(unset)" selected, so an untouched form has nothing to save', () => {
  const html = renderTab('settings', { project: 'p', version: 'v', settings: settingsView({}), sections: SECTIONS, files: {}, targets: [], profiles: [] }, { now: Date.now() });
  assert.match(html, /<select id="in-codex_astra_effort"[^>]*data-orig="null"[^>]*><option value="" selected>\(unset\)<\/option>/);
  assert.match(html, /<select id="in-checkin_effort"[^>]*data-orig="null"[^>]*><option value="" selected>\(unset\)<\/option>/);
});
