// META-OOTB-POLISH (norn-ootb REPORT sec. 2c / 3 F-6): settings profiles as data (engine/presets/profiles/*.json), the orthogonal
// --cost switch, `setup --profile`, `project new --profile`, the Settings profile drop-down + basic / all split.
// Temp meta root, temp HOME / USERPROFILE / CLAUDE_CONFIG_DIR, PATH = the sandbox bin + git only - never the live install.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { jargonIn } from './helpers/jargon.mjs';
import { which } from '../engine/lib/paths.mjs';
import { loadProject } from '../engine/lib/config.mjs';
import { createDashboard } from '../engine/dash/server.mjs';
import { renderTab, loadTab } from '../engine/dash/ui.mjs';
import { REQUIRED_CAPS, ROLE_AGENTS, WORK_CLASSES, SECTIONS, STARTER_CAPS, BASIC_KEYS, settingsView } from '../engine/lib/policy.mjs';
import { loadProfiles, getProfile, profileBudget, profilePolicy, profileChanges, COSTS } from '../engine/lib/profiles.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const GIT_DIR = path.dirname(which('git'));
const CODEX = ['codex-sol', 'codex-astra'];

function sandbox() {
  const t = mkTmp('meta-polish-');
  const dirs = { t, root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.bin, WIN ? 'claude.exe' : 'claude'), '');
  const env = { ...process.env, PATH: dirs.bin + path.delimiter + GIT_DIR, HOME: dirs.home, USERPROFILE: dirs.home, CLAUDE_CONFIG_DIR: dirs.cfg,
    LOCALAPPDATA: path.join(dirs.home, 'AppData', 'Local'), APPDATA: path.join(dirs.home, 'AppData', 'Roaming'), META_ROOT: dirs.root, META_NO_TICK: '1' };
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID']) delete env[k];
  const run = (...args) => { const r = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const budgetFile = path.join(dirs.root, 'local', 'budget.json');
  return { ...dirs, env, run, budgetFile };
}
function gitRepo(sb, name = 'my-app') {
  const r = path.join(sb.t, name);
  fs.mkdirSync(r, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: r, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'README.md'), '# app\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
  return r;
}
const names = pol => [...Object.values(pol.executors).map(e => e.executor), ...Object.values(pol.fallbacks)];
const OK = found => ['auto', 'wait', 'opus-xhigh', ...ROLE_AGENTS, ...found];

// ---------- data ----------
test('profiles are data: try-it (the default), solo, heavy; each sets every required cap, the check-in model / effort and the scheduler', () => {
  const { profiles, cost } = loadProfiles();
  assert.deepEqual(profiles.map(p => p.name), ['try-it', 'solo', 'heavy']);
  assert.deepEqual(profiles.filter(p => p.default).map(p => p.name), ['try-it']);
  for (const p of profiles) {
    for (const k of [...REQUIRED_CAPS, 'checkin_model', 'checkin_effort']) assert.ok({ ...p.budget, ...p.codex }[k] !== undefined, `${p.name} sets ${k}`);
    assert.equal(typeof p.scheduler.on, 'boolean'); assert.ok(Number.isInteger(p.scheduler.interval_min));
    assert.ok(p.label && p.summary, `${p.name} has a label + summary`);
    for (const c of Object.keys(p.routing)) assert.ok(Object.hasOwn(WORK_CLASSES, c), `${p.name} routes a known class ${c}`);
  }
  assert.deepEqual(COSTS, ['cheap', 'balanced', 'quality']);
  assert.deepEqual(Object.keys(cost).sort(), [...COSTS].sort());
  assert.throws(() => getProfile('nope'), /unknown profile nope \(known: try-it, solo, heavy\)/);
});

test('every profile x cost routes only to the generic roles + the executors setup found', () => {
  for (const p of loadProfiles().profiles) for (const cost of COSTS) for (const found of [['claude'], ['claude', ...CODEX]]) {
    const pol = profilePolicy(p, { found, cost });
    assert.deepEqual(Object.keys(pol.executors).sort(), Object.keys(WORK_CLASSES).sort(), `${p.name}: every class routed`);
    for (const n of names(pol)) assert.ok(OK(found).includes(n), `${p.name}/${cost}/${found}: ${n}`);
  }
  assert.equal(profilePolicy(getProfile('solo'), { found: ['claude', ...CODEX] }).executors.review.executor, 'codex-sol', 'solo: review on Codex when found');
  assert.equal(profilePolicy(getProfile('solo'), { found: ['claude'] }).executors.review.executor, 'planner', 'solo: a Claude stand-in without Codex');
  assert.equal(profilePolicy(getProfile('heavy'), { found: ['claude'] }).fallbacks.claude_over_guard, 'wait');
  // a project with its own role agents: the generic role maps to the project's agent of that role
  const own = profilePolicy(getProfile('heavy'), { found: ['claude'], agents: ['app-implementer', 'app-planner', 'app-runner'] });
  assert.equal(own.executors.planning.executor, 'app-planner'); assert.equal(own.fallbacks.codex_down, 'app-implementer');
});

test('--cost changes model / effort only: cheap never Opus and never more effort than balanced, quality never less', () => {
  const rank = e => ['', 'low', 'medium', 'high', 'xhigh'].indexOf(e);
  for (const p of loadProfiles().profiles) {
    const at = cost => ({ pol: profilePolicy(p, { found: ['claude', ...CODEX], cost }), b: profileBudget(p, { found: ['claude', ...CODEX], cost }) });
    const bal = at('balanced'), cheap = at('cheap'), q = at('quality');
    for (const c of Object.keys(WORK_CLASSES)) {
      for (const x of [cheap, q]) assert.equal(x.pol.executors[c].executor, bal.pol.executors[c].executor, `${p.name} ${c}: same executor`);
      assert.doesNotMatch(cheap.pol.executors[c].model, /opus/, `${p.name} ${c} cheap`);
      assert.ok(rank(cheap.pol.executors[c].effort) <= rank(bal.pol.executors[c].effort)); assert.ok(rank(q.pol.executors[c].effort) >= rank(bal.pol.executors[c].effort));
    }
    for (const k of REQUIRED_CAPS) { assert.equal(cheap.b[k], bal.b[k], `${p.name} ${k}`); assert.equal(q.b[k], bal.b[k], `${p.name} ${k}`); }
    assert.equal(cheap.b.checkin_model, 'claude-sonnet-5-5');
    assert.deepEqual(cheap.pol.fallbacks, bal.pol.fallbacks);
  }
  assert.throws(() => profilePolicy(getProfile('solo'), { cost: 'lavish' }), /unknown cost lavish \(known: cheap, balanced, quality\)/);
});

test('profileChanges = Settings keys only (every key a real Settings row) and valid values for them', () => {
  const rows = Object.fromEntries(settingsView({}).map(s => [s.key, s]));
  for (const p of loadProfiles().profiles) {
    const ch = profileChanges(p, { found: ['claude'] });
    for (const [k, v] of Object.entries(ch)) {
      assert.ok(rows[k], `${p.name}: ${k} is a Settings row`);
      if (rows[k].type === 'enum') assert.ok(rows[k].options.includes(v), `${p.name}: ${k}=${v} in ${rows[k].options}`);
    }
    assert.equal(ch['policy.cadence.checkin_interval_min'], p.scheduler.interval_min);
  }
  for (const k of BASIC_KEYS) assert.ok(rows[k], `basic ${k} is a Settings row`);
  for (const k of [...REQUIRED_CAPS, 'checkin_model', 'checkin_effort', 'policy.cadence.checkin_interval_min']) assert.ok(BASIC_KEYS.includes(k), `basic has ${k}`);
});

// ---------- setup --profile ----------
test('setup --profile solo --cost cheap writes that budget when none exists; setup with no profile writes try-it', () => {
  const a = sandbox();
  const r = a.run('setup', '--non-interactive', '--no-scheduler', '--profile', 'solo', '--cost', 'cheap');
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(a.budgetFile, 'utf8')), profileBudget(getProfile('solo'), { found: ['claude'], cost: 'cheap' }));
  assert.match(r.out, /profile solo, cost cheap/);
  const b = sandbox();
  const s = b.run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(s.code, 0, s.err + s.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(b.budgetFile, 'utf8')), profileBudget(getProfile('try-it'), { found: ['claude'] }));
  assert.match(s.out, /profile try-it/);
});

test('setup: an unknown profile / cost is refused before anything is written', () => {
  const sb = sandbox();
  const r = sb.run('setup', '--non-interactive', '--no-scheduler', '--profile', 'nope');
  assert.equal(r.code, 2); assert.match(r.err, /unknown profile nope \(known: try-it, solo, heavy\)/);
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler', '--cost', 'lavish').code, 2);
  assert.ok(!fs.existsSync(path.join(sb.root, 'local')), 'nothing written');
});

test('setup with an existing budget: no --profile = byte-identical; an explicit --profile merges only the profile keys and keeps a backup', () => {
  const sb = sandbox();
  fs.mkdirSync(path.dirname(sb.budgetFile), { recursive: true });
  const mine = '{\n "max_claude_workers": 7,\n "reset": "2026-11-16T09:00 local",\n "cacheR_per_pct": 41000000\n}\n';
  fs.writeFileSync(sb.budgetFile, mine);
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  assert.equal(fs.readFileSync(sb.budgetFile, 'utf8'), mine, 'untouched without a chosen profile');
  const r = sb.run('setup', '--non-interactive', '--no-scheduler', '--profile', 'solo');
  assert.equal(r.code, 0, r.err + r.out);
  const b = JSON.parse(fs.readFileSync(sb.budgetFile, 'utf8'));
  assert.equal(b.max_claude_workers, 2); assert.equal(b.reset, '2026-11-16T09:00 local'); assert.equal(b.cacheR_per_pct, 41000000);
  assert.equal(fs.readFileSync(sb.budgetFile + '.pre-profile', 'utf8'), mine);
  assert.match(r.out, /max_claude_workers 7 -> 2/);
});

test('setup: the profile says whether to schedule check-ins (try-it: tick by hand; solo: install the scheduler)', () => {
  const a = sandbox();   // --no-scheduler: the OS scheduler is never queried in a test
  assert.match(a.run('setup', '--non-interactive', '--no-scheduler').out, /profile try-it: no scheduled check-ins - run `norn tick` by hand/);
  const b = sandbox();
  assert.match(b.run('setup', '--non-interactive', '--no-scheduler', '--profile', 'solo').out, /profile solo: check-ins every 15 min - install the scheduler with: norn sched install/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(b.root, 'local', 'machine.json'), 'utf8')).scheduler.interval_min, 15);
  const c = sandbox();   // a named profile sets a new machine's interval; no profile keeps the discovered one (= the project default 15)
  assert.equal(c.run('setup', '--non-interactive', '--no-scheduler', '--profile', 'try-it').code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.root, 'local', 'machine.json'), 'utf8')).scheduler.interval_min, 30);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.root, 'local', 'machine.json'), 'utf8')).scheduler.interval_min, 15);
});

// ---------- project new --profile ----------
test('project new --profile heavy --cost quality: the profile routing + interval; no --profile keeps the starter policy', () => {
  const sb = sandbox();
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  const repo = gitRepo(sb);
  const r = sb.run('project', 'new', '--root', repo, '--non-interactive', '--print', '--profile', 'heavy', '--cost', 'quality');
  assert.equal(r.code, 0, r.err + r.out);
  const pol = JSON.parse(r.out).policy, want = profilePolicy(getProfile('heavy'), { found: ['claude'], cost: 'quality' });
  assert.deepEqual(pol.executors, want.executors); assert.deepEqual(pol.fallbacks, want.fallbacks);
  assert.equal(pol.cadence.checkin_interval_min, 15); assert.equal(pol.cadence.auto_resume_max, 2);
  assert.equal(sb.run('project', 'new', '--root', repo, '--non-interactive', '--print', '--profile', 'nope').code, 2);
  const plain = JSON.parse(sb.run('project', 'new', '--root', repo, '--non-interactive', '--print').out).policy;
  assert.equal(plain.cadence.checkin_interval_min, undefined, 'no profile: the policy as before');
});

// ---------- dashboard ----------
test('Settings: a profile drop-down (fill-in only, Save stays the human step) and the basic / all split', async () => {
  const sb = sandbox();
  assert.equal(sb.run('setup', '--non-interactive', '--no-scheduler').code, 0);
  assert.equal(sb.run('project', 'new', '--root', gitRepo(sb), '--non-interactive').code, 0);
  const pf = path.join(sb.home, '.norn', 'projects', 'my-app', 'project.json');
  const p = loadProject(pf, { home: sb.home, meta: sb.root });
  const platform = { tick: async () => ({ pid: 1 }), setInterval: async () => ({ ok: true }), ask: async () => ({ result: '', usage: {} }) };
  const app = createDashboard({ projects: [p], machine: { home: sb.home }, budgetFile: sb.budgetFile, platform, projectsDir: path.join(sb.t, 'cp'),
    codexDir: path.join(sb.t, 'cx'), sessionsDir: path.join(sb.t, 'sessions'), artDir: path.join(sb.t, 'art') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const get = async r => (await fetch(url + r)).json();
  try {
    const before = fs.readFileSync(sb.budgetFile, 'utf8'), pjBefore = fs.readFileSync(pf, 'utf8');
    const d = await get('/api/settings?project=my-app');
    assert.deepEqual(d.profiles.map(x => x.name), ['try-it', 'solo', 'heavy']);
    assert.deepEqual(d.profiles[1].changes.balanced, profileChanges(getProfile('solo'), { found: ['claude'], cost: 'balanced', agents: [...ROLE_AGENTS] }));
    assert.deepEqual(Object.keys(d.profiles[1].changes).sort(), [...COSTS].sort());
    assert.equal(fs.readFileSync(sb.budgetFile, 'utf8'), before, 'loading the profiles writes nothing');
    assert.equal(fs.readFileSync(pf, 'utf8'), pjBefore);
    const html = renderTab('settings', await loadTab('settings', 'my-app', get), { now: Date.now() });
    assert.match(html, /<select[^>]+data-set-profile/); assert.match(html, /<option value="try-it"/); assert.match(html, /<select[^>]+data-set-cost/);
    assert.match(html, /data-act="set-profile"/);
    assert.match(html, /data-set-level="basic"/); assert.match(html, /data-set-level="all"/);
    for (const k of BASIC_KEYS) assert.match(html, new RegExp(`id="set-${k.replace(/\./g, '\\.')}"[^>]*data-basic="1"`), `basic row ${k}`);
    assert.doesNotMatch(html, /id="set-cacheR_per_pct"[^>]*data-basic="1"/);
  } finally { await new Promise(r => app.server.close(r)); }
});

test('Settings on a fresh budget: an unset enum shows "(unset)" selected, so an untouched form has nothing to save (a profile fill-in saves)', () => {
  const html = renderTab('settings', { project: 'p', version: 'v', settings: settingsView({}), sections: SECTIONS, files: {}, targets: [], profiles: [] }, { now: Date.now() });
  assert.match(html, /<select id="in-codex_astra_effort"[^>]*data-orig="null"[^>]*><option value="" selected>\(unset\)<\/option>/);
  assert.match(html, /<select id="in-checkin_effort"[^>]*data-orig="null"[^>]*><option value="" selected>\(unset\)<\/option>/);
  const page = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'dash', 'index.html'), 'utf8');
  assert.match(page, /const changed = el => \{ const v = valueOf\(el\), o = JSON\.parse\(el\.dataset\.orig\); return v !== null && !\(o === null && v === ''\) &&/);
});
