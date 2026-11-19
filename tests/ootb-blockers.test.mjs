// META-OOTB blockers (norn-ootb REPORT sec. 3 F-1..F-3): what a new user hits between "installed" and "first task".
// Temp meta root, temp HOME / CLAUDE_CONFIG_DIR, PATH = the sandbox bin only - nothing touches the live install, ~/.claude or the
// OS scheduler (the sched test sets scheduler.kind cron with a test name and no crontab on PATH, so even a missing refusal installs nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { which } from '../engine/lib/paths.mjs';
import { loadProject } from '../engine/lib/config.mjs';
import { createDashboard } from '../engine/dash/server.mjs';
import { renderTab, loadTab } from '../engine/dash/ui.mjs';
import { execFileSync } from 'node:child_process';
import { buildStatus } from '../engine/lib/status.mjs';
import { policyLine } from '../engine/lib/tick.mjs';
import { generatedLines, POLICY_DEFAULTS, ROLE_AGENTS, settingsView, starterPolicy } from '../engine/lib/policy.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const GIT_DIR = path.dirname(which('git'));   // the real git (worktrees); claude is a fake exe in the sandbox bin

function sandbox() {
  const t = mkTmp('meta-ootb-');
  const dirs = { t, root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.bin, WIN ? 'claude.exe' : 'claude'), '');
  const env = { ...process.env, PATH: dirs.bin + path.delimiter + GIT_DIR, HOME: dirs.home, USERPROFILE: dirs.home, CLAUDE_CONFIG_DIR: dirs.cfg,
    LOCALAPPDATA: path.join(dirs.home, 'AppData', 'Local'), APPDATA: path.join(dirs.home, 'AppData', 'Roaming'), META_ROOT: dirs.root, META_NO_TICK: '1' };
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID']) delete env[k];
  const run = (...args) => { const r = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const budgetFile = path.join(dirs.root, 'local', 'budget.json'), machineFile = path.join(dirs.root, 'local', 'machine.json');
  return { ...dirs, env, run, budgetFile, machineFile };
}

// ---------- F-3: caps before the scheduler ----------
test('F-3 setup writes the starter caps to local/budget.json when it is absent', () => {
  const sb = sandbox();
  const r = sb.run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(r.code, 0, r.err + r.out);
  const b = JSON.parse(fs.readFileSync(sb.budgetFile, 'utf8'));
  assert.equal(b.max_claude_workers, 1); assert.equal(b.max_codex, 0); assert.equal(b.max_astra, 0); assert.equal(b.max_sol, 0);
  assert.equal(b.weekly_stop_pct, 50); assert.equal(b.usage_rate_cap_pct_per_h, 0.3);
  assert.match(r.out, /wrote .*budget\.json \(starter caps: 1 Claude worker, 0 Codex, weekly stop 50 %, rate cap 0\.3 %\/h/);
});

test('F-3 setup never touches an existing budget.json', () => {
  const sb = sandbox();
  fs.mkdirSync(path.dirname(sb.budgetFile), { recursive: true });
  const mine = '{ "max_claude_workers": 7,\n  "weekly_stop_pct": 95 }\n';
  fs.writeFileSync(sb.budgetFile, mine);
  const r = sb.run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(fs.readFileSync(sb.budgetFile, 'utf8'), mine);
  assert.match(r.out, /budget\.json: kept/);
});

test('F-3 sched install refuses without caps: one line saying how to set them, non-zero exit, nothing installed', () => {
  const sb = sandbox();
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  const m = JSON.parse(fs.readFileSync(sb.machineFile, 'utf8'));
  m.scheduler = { kind: 'cron', name: 'meta-ootb-test-never-installed', interval_min: 15 };
  m.projects = [{ name: 'x', config: '${norn}/local/x.json' }];
  fs.writeFileSync(sb.machineFile, JSON.stringify(m));
  for (const budget of [null, '{"weekly_stop_pct": 50}']) {
    if (budget === null) fs.rmSync(sb.budgetFile, { force: true }); else fs.writeFileSync(sb.budgetFile, budget);
    const r = sb.run('sched', 'install');
    assert.equal(r.code, 2, r.err + r.out);
    const lines = (r.err + r.out).trim().split(/\r?\n/);
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.match(lines[0], /^error: no caps set .*budget\.json.*(max_claude_workers|missing).*norn setup.*Settings/);
  }
});

test('F-3 STATUS, the check-in policy line and the generated check-in line never print an empty cap', () => {
  const t = mkTmp('meta-ootb-status-'), state = path.join(t, 'state');
  fs.mkdirSync(state, { recursive: true });
  const s = buildStatus({ state, budget: {}, projectsDir: path.join(t, 'none'), now: new Date('2026-11-12T10:00:00Z') });
  for (const l of s.text.split(/\r?\n/).filter(l => /cap/.test(l))) {
    assert.doesNotMatch(l, /=\s*(;|$)|\bcap\s*(;|->)|\/ cap\s*$/, `empty cap in: ${l}`);
  }
  assert.match(s.text, /max_claude_workers=unset \(no limit\)/);
  assert.doesNotMatch(policyLine({}), / - Claude| - Codex|\(- /);
  assert.match(policyLine({}), /caps unset \(no limit\) Claude/);
  assert.doesNotMatch(generatedLines({}).checkin, /undefined/);
});

// ---------- F-2: generic role agents ----------
const ENGINE_AGENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'agents');
function gitRepo(sb, name = 'my-app') {
  const r = path.join(sb.t, name);
  fs.mkdirSync(r, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: r, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'README.md'), '# app\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
  return r;
}
const OK_NAMES = found => ['auto', 'wait', 'opus-xhigh', ...ROLE_AGENTS, ...found];

test('F-2 starterPolicy routes only to the generic roles + the executors setup found', () => {
  for (const found of [['claude'], ['claude', 'codex-sol', 'codex-astra']]) {
    const p = starterPolicy(found);
    const names = [...Object.values(p.executors).map(e => e.executor), ...Object.values(p.fallbacks)];
    for (const n of names) assert.ok(OK_NAMES(found).includes(n), `${found}: ${n}`);
    assert.deepEqual(Object.keys(p.executors).sort(), Object.keys(POLICY_DEFAULTS.executors).sort());
    if (found.length === 1) assert.ok(!names.some(n => /codex/.test(n)), 'no codex when setup found none');
    else assert.deepEqual(p.executors, POLICY_DEFAULTS.executors, 'with codex: the engine defaults');
  }
});

test('F-2 project new installs the generic role agents and writes a policy naming only them + the found executors', () => {
  const sb = sandbox();
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  const r = sb.run('project', 'new', '--root', gitRepo(sb), '--non-interactive');
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /my-app: 3 generated file\(s\) managed/);
  const dir = path.join(sb.home, '.norn', 'projects', 'my-app'), pj = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
  assert.equal(pj.install.agents, '${project_dir}/agents');
  for (const n of ROLE_AGENTS) {
    assert.equal(fs.readFileSync(path.join(dir, 'agents', n + '.md'), 'utf8'), fs.readFileSync(path.join(ENGINE_AGENTS, n + '.md'), 'utf8'));
    assert.ok(fs.existsSync(path.join(sb.cfg, 'agents', n + '.md')), `${n} installed in the Claude config dir`);
  }
  const names = [...Object.values(pj.policy.executors).map(e => e.executor), ...Object.values(pj.policy.fallbacks)];
  for (const n of names) assert.ok(OK_NAMES(['claude']).includes(n), n);
  assert.equal(pj.policy.cadence.auto_resume_max, 2, 'the cadence defaults stay');
  assert.equal(sb.run('doctor').code, 0);
});

// ---------- F-1: the first task ----------
function firstProject() {
  const sb = sandbox();
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  const repo = gitRepo(sb);
  assert.equal(sb.run('project', 'new', '--root', repo, '--non-interactive').code, 0);
  const pf = path.join(sb.home, '.norn', 'projects', 'my-app', 'project.json');
  const state = path.join(sb.root, 'state', 'my-app');
  const recs = () => fs.readFileSync(path.join(state, 'records.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { ...sb, repo, pf, state, recs };
}
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

test('F-1 lane new creates the lane record, its worktree on branch norn/<lane>, and with --task the owner directive + the first brief', () => {
  const s = firstProject();
  const r = s.run('lane', 'new', 'first', '--task', 'Add a usage line to the README', '--project', s.pf);
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
  // again: nothing duplicated, nothing broken
  const again = s.run('lane', 'new', 'first', '--project', s.pf);
  assert.equal(again.code, 0, again.err + again.out); assert.match(again.out, /exists/);
  assert.equal(s.recs().filter(e => e.kind === 'lane').length, 1);
});

test('F-1 norn run on a lane with no worktree fails with ONE line naming the command to run, and a non-zero exit (F-11)', () => {
  const s = firstProject();
  const b = path.join(s.t, 'b.md'); fs.writeFileSync(b, 'mode: done\n');
  const r = s.run('run', '--executor', 'fake', '--lane', 'nowt', '--brief', b, '--project', s.pf);
  assert.equal(r.code, 2, r.err + r.out);
  const lines = (r.err + r.out).trim().split(/\r?\n/);
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /^error: lane nowt has no worktree \(.*wt\/nowt\): create it with: norn lane new nowt --project /);
});

test('F-1 first task end to end: lane new --task, then a fake run with --wait ends DONE', () => {
  const s = firstProject();
  assert.equal(s.run('lane', 'new', 'first', '--task', 'mode: done', '--project', s.pf).code, 0);
  const r = s.run('run', '--executor', 'fake', '--lane', 'first', '--brief', path.join(s.state, 'briefs', 'first.md'), '--project', s.pf, '--wait');
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /^STARTED RUN-1 lane first fake/m); assert.doesNotMatch(r.out, /fake fake/, "executor and model said once (SHIP-READY minor)");
  assert.match(r.out, /^RUN-1 exited: DONE$/m);
});

test('F-1 dashboard first run: Overview offers "Give Norn its first task" with the caps in force; the box records the directive and opens the lane + worktree', async () => {
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
    const ov = await get('/api/overview?project=my-app');
    assert.deepEqual(ov.first_run, { project: 'my-app', lane: 'first', caps: { max_claude_workers: 1, max_codex: 0, weekly_stop_pct: 50, usage_rate_cap_pct_per_h: 0.3 } });
    const html = renderTab('overview', await loadTab('overview', 'my-app', get), { now: Date.now() });
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
    assert.equal((await get('/api/overview?project=my-app')).first_run, null, 'the box goes once the project has records');
    assert.doesNotMatch(renderTab('overview', await loadTab('overview', 'my-app', get), { now: Date.now() }), /id="first-task"/);
  } finally { await app.close(); }
});
