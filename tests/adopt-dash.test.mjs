// META-ADOPT A3 (SPEC meta-adopt sec. 4-7): the dashboard front end of `norn adopt` - a zero-project start, Add a project, the routes
// (thin calls into engine/lib/adopt.mjs: the page token, role dashboard, 409 on a stale part sha), the five screens, the needs-you row
// and the empty states. A temp META_ROOT / HOME sandbox (norn setup), real git, a fake claude on PATH; nothing real starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { rustReady } from './helpers/rust.mjs';
import { runEnded, waitFor, stateBusy } from './helpers/wait.mjs';
import { which } from '../engine/lib/paths.mjs';
import { loadMachine, loadProject } from '../engine/lib/config.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';
import { createDashboard } from '../engine/dash/server.mjs';
import { renderTab, loadTab, stripCards } from '../engine/dash/ui.mjs';
import { renderAdopt, adoptStep, ADOPT_STEPS } from '../engine/dash/adopt.mjs';
import { proposalOf } from '../engine/lib/adopt.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const GIT_DIR = path.dirname(which('git'));
const CI = 'name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n';
const FILES = { 'package.json': JSON.stringify({ name: 'tide', scripts: { test: 'node --test' } }, null, 1), '.github/workflows/ci.yml': CI,
  'README.md': '# tide\n', 'AGENTS.md': '# agents\nkeep it small\n',
  'ROADMAP.md': '# Roadmap\n\n## Sync\n- [IN PROGRESS] Offline sync (branch feat/sync)\n- [ ] Retry queue\n\n## Now\n- [ ] Export to CSV\n' };

function sandbox() {
  rustReady();   // norn setup needs a built norn-hook and norn-code; the sandbox PATH has no cargo
  const t = mkTmp('meta-adopt-dash-');
  const d = { t, root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg'), code: path.join(t, 'code') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(path.join(d.bin, WIN ? 'claude.exe' : 'claude'), '');
  const env = { ...process.env, PATH: d.bin + path.delimiter + GIT_DIR + path.delimiter + path.dirname(process.execPath), HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming'), META_ROOT: d.root, META_NO_TICK: '1' };
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID', 'FAKE_RESULT', 'FAKE_MS']) delete env[k];
  const run = (...args) => { const r = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const s = run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(s.code, 0, s.err + s.out);
  return { ...d, env, run, budgetFile: path.join(d.root, 'local', 'budget.json'), machineFile: path.join(d.root, 'local', 'machine.json') };
}
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** a repo under <sandbox>/code: the files on main, a merged branch feat/sync and a live branch feat/live */
function repo(sb, name = 'tide', files = FILES) {
  const r = path.join(sb.code, name);
  fs.mkdirSync(r, { recursive: true });
  git(r, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), t); }
  git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'init');
  if (files === FILES) {
    git(r, 'checkout', '-q', '-b', 'feat/sync'); fs.writeFileSync(path.join(r, 'sync.js'), 'x\n'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'sync');
    git(r, 'checkout', '-q', 'main'); git(r, 'merge', '-q', '--no-ff', '-m', 'merge sync', 'feat/sync');
    git(r, 'checkout', '-q', '-b', 'feat/live'); fs.writeFileSync(path.join(r, 'live.js'), 'x\n'); git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'live');
    git(r, 'checkout', '-q', 'main');
  }
  return r;
}
async function dash(sb, projects = []) {
  const machine = loadMachine(sb.machineFile, { meta: sb.root });
  const platform = { tick: async () => ({ pid: 1 }), setInterval: async () => ({ ok: true }) };
  const app = createDashboard({ projects, machine, metaRoot: sb.root, env: sb.env, budgetFile: sb.budgetFile, platform, projectsDir: path.join(sb.t, 'cp'),
    codexDir: path.join(sb.t, 'cx'), artDir: path.join(sb.t, 'art') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const get = async r => { const x = await fetch(url + r); const data = await x.json(); if (!x.ok) throw new Error(`${x.status} ${data.error}`); return data; };
  const raw = async r => { const x = await fetch(url + r); return { status: x.status, data: x.headers.get('content-type')?.includes('json') ? await x.json() : await x.text() }; };
  const post = async (r, b, h = {}) => { const x = await fetch(url + r, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dash-token': app.token, ...h }, body: JSON.stringify(b) }); return { status: x.status, data: await x.json() }; };
  return { app, url, get, raw, post, close: () => app.close() };
}
const projectFile = (sb, name = 'tide') => path.join(sb.home, '.norn', 'projects', name, 'project.json');
const stateOf = (sb, name = 'tide') => path.join(sb.root, 'state', name);

// ---------- the routes ----------
test('zero projects: the dashboard starts, serves the page and lists none; scan writes nothing; Add a project registers and the list re-reads', async () => {
  const sb = sandbox(), tide = repo(sb), other = repo(sb, 'other', { 'README.md': '# other\n' });
  fs.mkdirSync(path.join(sb.code, 'plain'));   // not a git repo: never suggested
  const head = git(tide, 'rev-parse', 'HEAD');
  const d = await dash(sb);
  try {
    assert.deepEqual((await d.get('/api/projects')).projects, []);
    const page = await d.raw('/'); assert.equal(page.status, 200); assert.match(page.data, /<title>/);
    const sp = await d.raw('/api/strip'); assert.equal(sp.status, 409, 'no project yet'); assert.match(sp.data.error, /Add a project/);
    // the git repos found: with no project registered, the usual code folders of the home; none of them registered
    const repos = (await d.get('/api/adopt/repos')).repos;
    assert.ok(Array.isArray(repos));
    // scan: token required, facts back, nothing written
    assert.equal((await d.post('/api/adopt/scan', { root: tide }, { 'x-dash-token': 'wrong' })).status, 403);
    const sc = await d.post('/api/adopt/scan', { root: tide });
    assert.equal(sc.status, 200, JSON.stringify(sc.data));
    assert.equal(sc.data.facts.name, 'tide'); assert.equal(sc.data.facts.path, 'adopt');
    assert.ok(sc.data.facts.commands.some(c => c.id === 'test' && c.cmd === 'npm test' && c.ci));
    assert.ok(Array.isArray(sc.data.interview)); assert.equal(sc.data.registered, null);
    assert.equal(fs.existsSync(stateOf(sb)), false, 'a scan writes nothing');
    assert.equal(git(tide, 'status', '--porcelain'), ''); assert.equal(git(tide, 'rev-parse', 'HEAD'), head);
    assert.equal((await d.post('/api/adopt/scan', { root: path.join(sb.code, 'plain') })).status, 400);
    assert.equal((await d.post('/api/adopt/scan', {})).status, 400);
    // Add a project: project new (non-interactive), registered, the list re-read
    const nw = await d.post('/api/project/new', { root: tide });
    assert.equal(nw.status, 200, JSON.stringify(nw.data)); assert.equal(nw.data.project, 'tide');
    assert.ok(fs.existsSync(projectFile(sb)));
    assert.deepEqual((await d.get('/api/projects')).projects.map(p => p.name), ['tide']);
    assert.equal((await d.post('/api/project/new', { root: tide })).status, 409, 'already registered');
    assert.equal((await d.post('/api/adopt/scan', { root: tide })).data.registered, 'tide');
    // beside a registered project: its sibling repos are found, the registered one is marked
    const r2 = (await d.get('/api/adopt/repos')).repos;
    const by = Object.fromEntries(r2.map(r => [path.basename(r.path), r]));
    assert.ok(by.other, JSON.stringify(r2)); assert.equal(by.other.registered, null);
    assert.equal(by.tide.registered, 'tide'); assert.equal(by.plain, undefined);
    assert.equal(path.resolve(by.other.path), path.resolve(other));
    // the strip works now; the first-task box (Lanes) carries the adopt line
    const o2 = await d.get('/api/strip?project=tide');
    assert.equal(o2.first_run.project, 'tide');
  } finally { await d.close(); }
});

test('draft, review and apply through the routes: role dashboard, a stale part sha is 409, the needs-you row, a pick is never decided for you, a second adoption adds 0', async () => {
  const sb = sandbox(), tide = repo(sb);
  assert.equal(sb.run('project', 'new', '--root', tide, '--non-interactive').code, 0);
  const head = git(tide, 'rev-parse', 'HEAD');
  const d = await dash(sb, [loadProject(projectFile(sb), { home: sb.home, meta: sb.root })]);
  try {
    let a = await d.get('/api/adopt?project=tide');
    assert.equal(a.proposal, null); assert.equal(a.facts.name, 'tide', 'GET scans once when there is no proposal');
    assert.match(a.consent.line, /read-only/); assert.match(a.consent.line, /15 min/); assert.match(a.consent.line, /file text goes to/);
    assert.equal(a.setup.rules, true, 'the repo own AGENTS.md counts as rules'); assert.deepEqual(a.setup.rules_from, ['AGENTS.md']);
    assert.equal(a.setup.caps_chosen, false, 'the starter caps norn setup wrote: nobody chose them'); assert.equal(a.setup.gate, null); assert.equal(a.setup.found_gate, 'npm test');
    assert.equal((await d.post('/api/adopt/draft', { project: 'tide', read: 'yes' })).status, 400, 'read is a boolean choice');
    assert.equal((await d.post('/api/adopt/draft', { project: 'tide', read: false, answers: { bogus: 'x' } })).status, 400);
    const dr = await d.post('/api/adopt/draft', { project: 'tide', read: false, answers: { never: 'force-push to main' } });
    assert.equal(dr.status, 200, JSON.stringify(dr.data)); assert.equal(dr.data.id, 'ADP-1');
    a = await d.get('/api/adopt?project=tide');
    assert.equal(a.proposal.state, 'open'); assert.deepEqual(a.proposal.parts.map(p => p.id), ['profile', 'commands', 'rules', 'instructions', 'roadmap', 'first']);
    assert.equal(adoptStep(a), 'review');
    const ev = fs.readFileSync(path.join(stateOf(sb), 'adopt.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(ev.every(e => e.by === 'dashboard'), 'every proposal event by dashboard');
    // ONE needs-you row while parts are undecided
    const needs = (await d.get('/api/inbox?project=tide')).items.filter(n => n.type === 'setup');
    assert.equal(needs.length, 1); assert.equal(needs[0].id, 'ADP-1'); assert.match(needs[0].title, /^Review the draft setup \(6 parts\)$/);
    assert.equal((await d.get('/api/inbox?project=tide')).items.filter(n => n.type === 'setup').length, 1);
    const P = id => a.proposal.parts.find(p => p.id === id);
    // decide: the sha the page saw; stale = 409; missing = 400; a pick part needs its pick
    assert.equal((await d.post('/api/adopt/decide', { project: 'tide', part: 'roadmap', verdict: 'approve', sha: 'f'.repeat(64) })).status, 409);
    assert.equal((await d.post('/api/adopt/decide', { project: 'tide', part: 'roadmap', verdict: 'approve' })).status, 400);
    assert.equal((await d.post('/api/adopt/decide', { project: 'tide', part: 'roadmap', verdict: 'maybe', sha: P('roadmap').sha })).status, 400);
    assert.equal((await d.post('/api/adopt/decide', { project: 'tide', part: 'nope', verdict: 'approve', sha: 'x' })).status, 400);
    const np = await d.post('/api/adopt/decide', { project: 'tide', part: 'profile', verdict: 'approve', sha: P('profile').sha });
    assert.equal(np.status, 400); assert.match(np.data.error, /pick one line/);
    const ok = async (part, b) => { const r = await d.post('/api/adopt/decide', { project: 'tide', part, sha: P(part).sha, ...b }); assert.equal(r.status, 200, `${part}: ${JSON.stringify(r.data)}`); return r.data; };
    await ok('profile', { verdict: 'approve', pick: 'try-it' });
    await ok('commands', { verdict: 'approve' });
    await ok('rules', { verdict: 'skip' });
    await ok('instructions', { verdict: 'approve' });
    const off = P('roadmap').lines.find(l => l.text === 'Retry queue').id;
    const csv = P('roadmap').lines.find(l => l.text === 'Export to CSV').id;
    assert.equal((await d.post('/api/adopt/decide', { project: 'tide', part: 'roadmap', verdict: 'approve', sha: P('roadmap').sha, edits: { [csv]: 'a\nb' } })).status, 400, 'an edit is one line');
    assert.equal((await d.post('/api/adopt/decide', { project: 'tide', part: 'roadmap', verdict: 'approve', sha: P('roadmap').sha, edits: { zz: 'x' } })).status, 400);
    await ok('roadmap', { verdict: 'approve', off: [off], edits: { [csv]: 'Export to CSV and JSON' } });
    const firstLine = P('first').lines[0];
    const after = await ok('first', { verdict: 'approve', pick: firstLine.id });
    assert.equal(after.proposal.undecided.length, 0, 'the reply carries the proposal');
    assert.equal((await d.get('/api/inbox?project=tide')).items.filter(n => n.type === 'setup').length, 0, 'decided: no row (Apply is on the review page)');
    // apply
    const ap = await d.post('/api/adopt/apply', { project: 'tide' });
    assert.equal(ap.status, 200, JSON.stringify(ap.data)); assert.equal(ap.data.complete, true);
    a = await d.get('/api/adopt?project=tide');
    assert.equal(a.proposal.state, 'applied'); assert.equal(adoptStep(a), 'done');
    assert.ok(a.lane && a.lane.branch === 'norn/' + a.lane.name, JSON.stringify(a.lane));
    const items = Object.values(loadRoadmap(stateOf(sb)).items).filter(i => i.kind === 'item');
    assert.deepEqual(items.map(i => i.title).sort(), ['Export to CSV and JSON', 'Offline sync'], 'the edit is applied; the draft keeps the original');
    const made = fs.readFileSync(path.join(stateOf(sb), 'roadmap.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.ev === 'create');
    assert.ok(made.length && made.every(e => e.by === 'migration'), 'written by role migration');
    assert.ok(made.filter(e => e.data.legacy).length === 2 && made.filter(e => e.data.legacy).every(e => e.data.legacy_by === 'dashboard'), 'each imported claim names its approver');
    assert.equal(fs.existsSync(path.join(path.dirname(projectFile(sb)), 'rules', 'RULES.md')), false, 'rules skipped');
    assert.equal(JSON.parse(fs.readFileSync(projectFile(sb), 'utf8')).merge.gate.cmd, 'npm test');
    assert.equal(git(tide, 'status', '--porcelain'), ''); assert.equal(git(tide, 'rev-parse', 'HEAD'), head);
    assert.equal(a.setup.caps_chosen, true); assert.equal(a.setup.caps_from, 'decision'); assert.equal(a.setup.gate, 'npm test'); assert.deepEqual(a.setup.rules_from, ['AGENTS.md']);
    // rules empty -> Write one rule: RULES.md beside project.json + rules_read_whole; the repo untouched
    assert.equal((await d.post('/api/adopt/rule', { project: 'tide', text: '' })).status, 400);
    const ru = await d.post('/api/adopt/rule', { project: 'tide', text: 'Never commit generated files.' });
    assert.equal(ru.status, 200, JSON.stringify(ru.data)); assert.equal(ru.data.added, true);
    assert.match(fs.readFileSync(path.join(path.dirname(projectFile(sb)), 'rules', 'RULES.md'), 'utf8'), /^- Never commit generated files\.$/m);
    assert.deepEqual(JSON.parse(fs.readFileSync(projectFile(sb), 'utf8')).rules_read_whole, ['${project_dir}/rules/RULES.md']);
    assert.deepEqual((await d.get('/api/adopt?project=tide')).setup.rules_from, ['rules/RULES.md', 'AGENTS.md']);
    assert.equal(git(tide, 'status', '--porcelain'), '');
    // apply again: nothing open = 409; a second adoption writes 0 new items
    assert.equal((await d.post('/api/adopt/apply', { project: 'tide' })).status, 409);
    assert.equal((await d.post('/api/adopt/draft', { project: 'tide', read: false })).data.id, 'ADP-2');
    a = await d.get('/api/adopt?project=tide');
    const rm = a.proposal.parts.find(p => p.id === 'roadmap');
    assert.ok(rm.lines.filter(l => l.text !== 'Retry queue').every(l => l.already));
    assert.equal((await d.post('/api/adopt/decide', { project: 'tide', part: 'roadmap', verdict: 'approve', sha: rm.sha })).status, 200);
    assert.equal((await d.post('/api/adopt/apply', { project: 'tide' })).status, 200);
    assert.equal(Object.values(loadRoadmap(stateOf(sb)).items).filter(i => i.kind === 'item').length, 3, 'only the line unticked last time is new');
    // Not now = a close with the reason
    const cl = await d.post('/api/adopt/close', { project: 'tide', why: 'not now' });
    assert.equal(cl.status, 200, JSON.stringify(cl.data));
    a = await d.get('/api/adopt?project=tide');
    assert.equal(a.proposal.id, 'ADP-2'); assert.equal(a.proposal.state, 'closed'); assert.equal(adoptStep(a), 'scan', 'Not now: the next visit starts over');
    assert.equal((await d.post('/api/adopt/close', { project: 'tide', why: 'again' })).status, 409);
  } finally { await d.close(); }
});

test('the read from the dashboard: the explicit choice starts ONE read-only run on lane adopt; GET /api/adopt follows it; the draft lands at its end', async () => {
  const sb = sandbox(), tide = repo(sb);
  assert.equal(sb.run('project', 'new', '--root', tide, '--non-interactive').code, 0);
  const d = await dash(sb, [loadProject(projectFile(sb), { home: sb.home, meta: sb.root })]);
  try {
    const r = await d.post('/api/adopt/draft', { project: 'tide', read: true, executor: 'fake' });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.run, /^RUN-\d+$/); assert.equal(r.data.id, 'ADP-1');
    let a = await d.get('/api/adopt?project=tide');
    assert.equal(a.read.id, r.data.run); assert.equal(a.read.executor, 'fake');
    // CI-RED-FDECF30: the fake answer is no JSON, so the read's end starts its ONE retry ('ADP-1 read 2') and the draft lands at the
    // RETRY's end. Wait while a run of the state still lives (progress-based, never a fixed 30 s: the Windows NEW RED), then settle
    // the run GET /api/adopt follows (the retry: its supervisor tail was the Linux LEAK RED, the first run had long settled).
    await waitFor(() => proposalOf(stateOf(sb))?.draft, { producer: stateBusy(stateOf(sb)), what: 'the draft' });
    a = await d.get('/api/adopt?project=tide');
    assert.ok(a.proposal.draft, 'the read was ingested (a fake answer that is no JSON: the facts-only fallback)');
    assert.equal(adoptStep(a), 'review');
    const run = loadState(stateOf(sb)).items[r.data.run];
    assert.equal(run.data.lane, 'adopt'); assert.equal(run.data.role, 'helper');
    assert.ok(a.read.ingested, 'GET /api/adopt follows the read to the run whose end wrote the draft');
    await runEnded(stateOf(sb), a.read.id);   // CI-RED-A0994AB: the draft lands before the supervisor's tail ends
  } finally { await d.close(); }
});

// ---------- the screens (pure renders over GET /api/adopt) ----------
const FACTS = { name: 'tide', root: 'C:/code/tide', path: 'adopt', path_why: '9 commits, 3 planning item(s) in 1 file(s), 1 branch(es) in flight', scan_ms: 1800,
  history: { commits: 9, first: '2026-10-01T00:00:00Z', last: '2026-11-01T00:00:00Z', authors: 2 }, size: { files: 12, tests: 3 },
  commands: [{ id: 'test', cmd: 'npm test', source: 'package.json:3', ci: '.github/workflows/ci.yml:9' }], ci: [{ file: '.github/workflows/ci.yml' }], manifests: ['package.json'],
  plans: [{ file: 'ROADMAP.md', items: 3 }], branches: [{ name: 'feat/live', merged: false, ahead: 1, days: 2 }, { name: 'feat/sync', merged: true, ahead: 0, days: 5 }],
  agent_files: [{ file: 'AGENTS.md', lines: 2 }], docs: {}, default_branch: 'main' };
const part = (id, lines, o = {}) => ({ id, type: id, title: id, lines, sha: id + '-sha', status: 'to review', decision: null, applied: null, ...o });
const PROP = { id: 'ADP-1', state: 'open', path: 'adopt', why: FACTS.path_why, answers: {}, draft: { source: 'facts', n: 1 }, undecided: [],
  parts: [part('profile', [{ id: 'try-it', text: 'Try it: one worker', source: 'profile data try-it.json', default: true }, { id: 'solo', text: 'Solo', source: 'profile data solo.json' }], { pick: true }),
    part('commands', [{ id: 'test', text: 'npm test', source: 'package.json:3; CI .github/workflows/ci.yml:9' }], { status: 'approved', decision: { off: [] } }),
    part('rules', [{ id: 'u1', text: 'Read AGENTS.md before you change anything.', source: 'AGENTS.md (2 lines)' }, { id: 'u2', text: 'Ghost rule.', source: 'README.md:9', unverified: true }]),
    part('instructions', [{ id: 'i1', text: 'keep AGENTS.md as it is', source: 'AGENTS.md' }], { status: 'skipped', decision: { off: [] } }),
    part('roadmap', [{ id: 'r1', text: 'Offline sync', source: 'ROADMAP.md:4', theme: 'Sync', horizon: 'now', links: ['branch:feat/sync'], legacy: { file: 'ROADMAP.md', line: 4, word: 'IN PROGRESS' } },
      { id: 'r2', text: 'Export to CSV', source: 'ROADMAP.md:8', theme: 'Now', links: [], already: true }]),
    part('first', [{ id: 'f1', text: 'Export to CSV', source: 'ROADMAP.md:8', item: 'r2' }, { id: 'f2', text: 'Write an AGENTS.md', source: 'scan: no agent file' }], { pick: true })] };
PROP.undecided = PROP.parts.filter(p => p.status === 'to review').map(p => p.id);
const BASE = { project: 'tide', root: FACTS.root, facts: FACTS, interview: [{ id: 'priority', text: 'What matters most right now?', why: 'x' }, { id: 'never', text: 'Anything an agent must never do here?', why: 'y' }],
  consent: { executor: 'claude', model: 'claude-sonnet-5-5', provider: 'Anthropic', cap_min: 15, line: 'the read is one read-only run of claude, capped at 15 min; file text goes to Anthropic' },
  setup: { rules: false, caps_chosen: false, gate: null, roadmap: 0 }, proposal: null, read: null, lane: null };

test('the step is derived from the data, never stored: add -> scan -> reading -> review -> set up', () => {
  assert.deepEqual(ADOPT_STEPS.map(s => s[0]), ['add', 'scan', 'progress', 'review', 'done']);
  assert.equal(adoptStep(null), 'add'); assert.equal(adoptStep({ project: null }), 'add');
  assert.equal(adoptStep(BASE), 'scan');
  assert.equal(adoptStep({ ...BASE, proposal: { ...PROP, draft: null, parts: [] }, read: { id: 'RUN-3', state: 'running' } }), 'progress');
  assert.equal(adoptStep({ ...BASE, proposal: PROP }), 'review');
  assert.equal(adoptStep({ ...BASE, proposal: { ...PROP, state: 'applied' } }), 'done');
  assert.equal(adoptStep({ ...BASE, proposal: { ...PROP, state: 'closed' } }), 'scan', 'a closed draft (Not now) starts over');
  assert.equal(adoptStep({ ...BASE, proposal: PROP }, 'scan'), 'scan', 'asked for: Draft again');
});

test('screen 1 Add a project: a path box + the repos found (registered ones marked); with zero projects it says so', () => {
  const h = renderAdopt('add', { project: null, repos: [{ name: 'tide', path: 'C:/code/tide', registered: null, note: 'beside your projects' }, { name: 'other', path: 'C:/code/other', registered: 'other' }], projects: [] });
  assert.match(h, /id="adopt-add"/); assert.match(h, /Add a project/);
  assert.match(h, /No project yet/, 'zero projects: one line naming what is missing');
  assert.match(h, /<input[^>]+data-adopt="root"/); assert.match(h, /data-act="adopt-scan"[^>]*>Look at it</);
  assert.match(h, /data-act="adopt-use" data-root="C:\/code\/tide"/);
  assert.doesNotMatch(h, /data-act="adopt-use" data-root="C:\/code\/other"/, 'a registered repo is not offered again');
  assert.match(h, /already a project/);
  assert.match(h, /writes nothing into your repository/);
});

test('screen 4 Review: a rail of parts, one card per part with Approve / Skip, a row per line (tick, text, source), the claimed chip, a sticky Apply bar', () => {
  const h = renderAdopt('review', { ...BASE, proposal: PROP });
  assert.match(h, /id="adopt-review"/);
  assert.equal((h.match(/class="card adp-part"/g) || []).length, 6);
  assert.match(h, /data-part="roadmap" data-sha="roadmap-sha"/);
  assert.match(h, /data-act="adopt-decide" data-verdict="approve" data-part="rules"/); assert.match(h, /data-act="adopt-decide" data-verdict="skip" data-part="rules"/);
  assert.match(h, /<input type="checkbox" data-line="u1" checked/); assert.match(h, /<input type="checkbox" data-line="u2"(?! checked)/, 'unverified starts off');
  assert.match(h, /unverified/); assert.match(h, /AGENTS\.md \(2 lines\)/);
  assert.match(h, /<input type="radio" name="pick-profile" data-line="try-it" checked/, 'the default is shown, never decided');
  assert.match(h, /claimed: IN PROGRESS/); assert.match(h, /already there/);
  assert.match(h, /branch:feat\/sync/);
  assert.match(h, /1 of 6 parts approved/); assert.match(h, /data-act="adopt-apply"/);
  assert.match(h, /Save and finish later/);
  assert.match(h, /approved/); assert.match(h, /skipped/);
});

// ---------- the empty states (SPEC sec. 5): each names what is missing in one line and offers the next action ----------
test('empty states: the first-task box offers the look; an empty Roadmap offers the draft; the Lanes setup card names rules, caps and the merge gate', () => {
  const ov = { now: new Date().toISOString(), projects: ['tide'], needs_you: 0, needs: [], running: { claude: { n: 0, cap: 1 }, codex: { n: 0, cap: 0 }, lanes: [] },
    burn: { usage: {}, top: [], executors: [] }, paused: false, checkin_locked: false,
    first_run: { project: 'tide', lane: 'first', caps: {} }, setup: { project: 'tide', rules: false, rules_from: [], caps_chosen: false, gate: null, found_gate: 'npm test', roadmap: 0, agent_files: [], version: 'v1', caps: { max_claude_workers: 1 } } };
  const h = stripCards('lanes', ov);
  assert.match(h, /Or let Norn look at the repo and draft a roadmap, rules and a first task/); assert.match(h, /data-tab="adopt"/);
  assert.match(h, /id="setup-gaps"/);
  assert.match(h, /No project rules yet: no rules\/RULES\.md and no agent rules file/);
  assert.match(h, /No caps profile is on record\. Nobody chose them/); assert.doesNotMatch(h, /scheduler stays off/); assert.match(h, /Keep the starter caps/);
  assert.match(h, /Merges are not gated/); assert.match(h, /data-act="setup-gate" data-project="tide" data-cmd="npm test" data-version="v1"/, 'the found command is one click');
  // rules from the repo's CLAUDE.md and caps from budget.json: the card names them in its In place line
  const have = stripCards('lanes', { ...ov, first_run: null, setup: { ...ov.setup, rules: true, rules_from: ['CLAUDE.md'], caps_chosen: true, caps_from: 'budget', caps: { max_claude_workers: 5, max_codex: 0, weekly_stop_pct: null } } });
  assert.doesNotMatch(have, /No project rules yet|Nobody chose them/);
  assert.match(have, /In place: rules: CLAUDE\.md · caps \(budget\.json\): 5 Claude workers, 0 Codex runs, weekly stop % unset \(no limit\)/);
  const done = stripCards('lanes', { ...ov, first_run: null, setup: { ...ov.setup, rules: true, caps_chosen: true, gate: 'npm test', roadmap: 3 } });
  assert.doesNotMatch(done, /id="setup-gaps"/, 'nothing missing: no card');
  const kept = stripCards('lanes', { ...ov, first_run: null, setup: { ...ov.setup, caps_kept: true } });
  assert.doesNotMatch(kept, /Nobody chose them/, 'Keep the starter caps is a choice');
  // the needs-you row of an open draft (Inbox)
  const nr = renderTab('inbox', { items: [{ type: 'setup', id: 'ADP-1', project: 'tide', title: 'Review the draft setup (4 parts)', created: new Date().toISOString() }] }, { now: Date.now(), project: 'tide' });
  assert.match(nr, /Review the draft setup \(4 parts\)/); assert.match(nr, /data-act="adopt-review"/); assert.match(nr, /data-act="adopt-notnow"/);
  // the Roadmap tab, empty
  const rm = renderTab('roadmap', { themes: [], adopt: { plans: 2, items: 17, branches: 2 } }, { project: 'tide' });
  assert.match(rm, /No roadmap yet/); assert.match(rm, /17 planned line\(s\) in 2 file\(s\), 2 branch\(es\) in flight/);
  assert.match(rm, /Draft it from the repository/); assert.match(rm, /Answer 3 questions instead/); assert.match(rm, /data-rm-edit="new"/);
});

test('the client: loadTab("adopt") reads GET /api/adopt (+ the repos on the add step); renderTab("adopt") draws the derived step', async () => {
  const calls = [], get = async u => { calls.push(u); return u.startsWith('/api/adopt/repos') ? { repos: [] } : BASE; };
  const d = await loadTab('adopt', 'tide', get);
  assert.ok(calls.some(u => u === '/api/adopt?project=tide'));
  assert.match(renderTab('adopt', d, { project: 'tide' }), /id="adopt-scan"/);
  const z = await loadTab('adopt', null, get);
  assert.ok(calls.some(u => u === '/api/adopt/repos'));
  assert.match(renderTab('adopt', z, { project: null }), /id="adopt-add"/);
});
