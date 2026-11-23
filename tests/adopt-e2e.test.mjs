// META-ADOPT A5 (SPEC meta-adopt sec. 7, "the end-to-end test"): NEW and ADOPT walked end to end - `norn init` and the `norn adopt` verbs
// (CLI), the guided chain in a terminal, the dashboard POST routes (A3) and the MCP setup profile (A4). The guide.test pattern: temp
// HOME / USERPROFILE / CLAUDE_CONFIG_DIR / META_ROOT, a fake claude on PATH, the real git, the fake executor (its canned final = the
// recorded read of the tidewatch sample); nothing real starts. The CLI under test is this working copy's engine/bin/norn.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { hookReady } from './helpers/hook.mjs';
import { which } from '../engine/lib/paths.mjs';
import { loadMachine, loadProject } from '../engine/lib/config.mjs';
import { loadRoadmap } from '../engine/lib/roadmap.mjs';
import { createDashboard } from '../engine/dash/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const ADOPT_LIB = pathToFileURL(path.join(HERE, '..', 'engine', 'lib', 'adopt.mjs')).href;
const FIX = path.join(HERE, 'fixtures', 'adopt');
const WIN = process.platform === 'win32';
const GIT_DIR = path.dirname(which('git'));

/** a fresh machine: temp META_ROOT / HOME / config dir, a fake claude on PATH (+ git, node), no machine.json yet */
function sandbox(extra = {}) {
  hookReady();   // norn setup needs a built norn-hook; the sandbox PATH has no cargo
  const t = mkTmp('meta-adopt-e2e-');
  const d = { t, root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg'), code: path.join(t, 'code') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(path.join(d.bin, WIN ? 'claude.exe' : 'claude'), '');
  const canned = path.join(t, 'canned.txt');
  fs.writeFileSync(canned, fs.readFileSync(path.join(FIX, 'tidewatch-read.json'), 'utf8') + '\n## DONE\n');
  const env = { ...process.env, PATH: d.bin + path.delimiter + GIT_DIR + path.delimiter + path.dirname(process.execPath), HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming'), META_ROOT: d.root, META_NO_TICK: '1', FAKE_RESULT: canned, ...extra };
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH' && k !== 'PATH') delete env[k];
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID', 'FAKE_MS', 'META_INTERACTIVE']) delete env[k];
  const run = (args, o = {}) => {
    const r = spawnSync(process.execPath, [META, ...args], { env: { ...env, ...(o.env || {}) }, cwd: o.cwd, encoding: 'utf8', input: o.input ?? '', timeout: 180000 });
    return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: (r.stdout || '') + (r.stderr || '') };
  };
  const ok = (args, o) => { const r = run(args, o); assert.equal(r.code, 0, `meta ${args.join(' ')}\n${r.all}`); return r; };
  const projectFile = name => path.join(d.home, '.norn', 'projects', name, 'project.json');
  const project = name => loadProject(projectFile(name), { meta: d.root });
  return { ...d, env, run, ok, projectFile, project, machineFile: path.join(d.root, 'local', 'machine.json'), budgetFile: path.join(d.root, 'local', 'budget.json') };
}
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** NEW: a repo with one commit */
function young(sb, name = 'harbour') {
  const r = path.join(sb.code, name);
  fs.mkdirSync(r, { recursive: true });
  git(r, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(r, 'README.md'), `# ${name}\n`);
  git(r, 'add', '-A'); git(r, 'commit', '-q', '-m', 'init');
  return r;
}
/** ADOPT: the tidewatch-shaped fixture (12 commits, a merged fix branch, a live feature branch, a stale one; ROADMAP.md + TODO.md) */
function tidewatch(sb, name = 'tidewatch') {
  const r = path.join(sb.code, name);
  execFileSync(process.execPath, [path.join(FIX, 'make-tidewatch.mjs'), r], { stdio: ['ignore', 'ignore', 'pipe'] });
  return r;
}
const showOf = (sb, pf) => JSON.parse(sb.ok(['adopt', 'show', '--project', pf, '--json']).out);
const items = sb => name => Object.values(loadRoadmap(sb.project(name).state).items).filter(i => i.state === 'open');
const repoClean = (r, head) => { assert.equal(git(r, 'status', '--porcelain'), '', 'the repo is never written'); assert.equal(git(r, 'rev-parse', 'HEAD'), head, 'HEAD is unchanged'); };
const MAN = 'Write the man page';   // the one roadmap line the reviewer unticks (its theme keeps "Test on Windows in CI")
const DST = /^Fix DST rounding/;

/** the ADOPT asserts every front end shares: 6 themes + 13 items, the DST claim flagged against its derived status, the gate, the repo */
function assertAdopted(sb, name, { rules = false } = {}) {
  const all = items(sb)(name), its = all.filter(i => i.kind === 'item');
  assert.equal(all.filter(i => i.kind === 'theme').length, 6, all.filter(i => i.kind === 'theme').map(i => i.title).join(' | '));
  assert.equal(its.length, 13, its.map(i => i.title).join(' | '));
  assert.ok(!its.some(i => i.title === MAN), 'the unticked line is not written');
  const audit = JSON.parse(sb.run(['road', 'audit', '--project', sb.projectFile(name), '--json']).out);   // exit 1 = unplaced items (no horizon): a finding, not a failure
  const dst = audit.drift.filter(x => DST.test(x.title));
  assert.equal(dst.length, 1, JSON.stringify(audit.drift));
  assert.match(dst[0].drift, /IN PROGRESS.*shipped/);
  assert.equal(sb.project(name).merge.gate.cmd, 'npm test');
  assert.equal(fs.existsSync(path.join(path.dirname(sb.projectFile(name)), 'rules', 'RULES.md')), rules);
}

// ---------- the CLI: norn init (NEW), the adopt verbs (ADOPT) ----------
test('NEW via norn init: setup + project new + the facts-only draft from 2 answers; approve all, apply -> the roadmap, the first lane, the free rehearsal (a fake run, DONE)', { timeout: 240000 }, () => {
  const sb = sandbox(), repo = young(sb), head = git(repo, 'rev-parse', 'HEAD');
  const r = sb.ok(['init', repo, '--non-interactive', '--answer', 'goal=A tide clock for the harbour', '--answer', 'first=Parse one station file', '--profile', 'try-it', '--no-read']);
  assert.match(r.out, /wrote .*machine\.json/, 'no machine.json yet: init runs setup');
  assert.match(r.out, /project harbour: OK/);
  assert.match(r.out, /: new \(/, 'the scan picks the NEW path');
  assert.match(r.out, /norn adopt show --project /, 'init names the review step');
  const pf = sb.projectFile('harbour'), p = showOf(sb, pf);
  assert.equal(p.path, 'new'); assert.equal(p.state, 'open');
  for (const id of ['profile', 'roadmap', 'first']) assert.ok(p.parts.some(x => x.id === id), id);
  const prof = p.parts.find(x => x.id === 'profile');
  assert.equal(prof.status, 'approved', '--profile on the command line is the human\'s pick');
  assert.deepEqual(prof.lines.filter(l => !prof.decision.off.includes(l.id)).map(l => l.id), ['try-it']);
  assert.deepEqual(p.parts.find(x => x.id === 'roadmap').lines.map(l => l.text), ['Parse one station file']);
  // approve all
  for (const x of p.parts.filter(y => y.status === 'to review'))
    sb.ok(['adopt', 'approve', x.id, ...(x.pick ? ['--pick', x.lines[0].id] : []), '--project', pf, '--as', 'owner']);
  const a = sb.ok(['adopt', 'apply', '--project', pf, '--as', 'owner']);
  assert.match(a.out, /ADP-1 applied/);
  const road = sb.ok(['road', 'show', '--project', pf]).out;
  assert.match(road, /A tide clock for the harbour/); assert.match(road, /Parse one station file/);
  const pr = sb.project('harbour'), lane = 'parse-one-station-file';
  assert.ok(fs.existsSync(path.join(pr.state, 'wt', lane, '.git')), 'the first lane\'s worktree exists');
  const brief = path.join(pr.state, 'briefs', lane + '.md');
  assert.ok(fs.existsSync(brief));
  // the free rehearsal both init and apply print: its relative --brief resolves against the caller's folder, and the run does not
  // mark the first roadmap item shipped
  assert.match(r.out, /rehearse it for free: norn run --executor fake --lane parse-one-station-file --brief \S+ --project \S+ --wait/, 'init names the rehearsal (after apply)');
  assert.match(a.out, /rehearse it for free: norn run --executor fake .* --wait/, 'adopt apply prints the rehearsal');
  const cwd = path.dirname(pr.state), rel = path.relative(cwd, brief);
  assert.ok(!path.isAbsolute(rel));
  const run = sb.ok(['run', '--executor', 'fake', '--lane', lane, '--brief', rel, '--project', pf, '--wait'], { env: { FAKE_RESULT: '' }, cwd });
  assert.match(run.out, /^RUN-\d+ exited: DONE$/m);
  assert.doesNotMatch(sb.ok(['road', 'show', '--project', pf]).out, /shipped|stage DONE/);
  repoClean(repo, head);
});

test('ADOPT via the verbs: scan -> the fake read -> one line off, rules skipped -> apply; a kill between decide and apply loses nothing; a re-run writes 0 items', { timeout: 300000 }, () => {
  const sb = sandbox(), repo = tidewatch(sb), head = git(repo, 'rev-parse', 'HEAD');
  sb.ok(['setup', '--non-interactive', '--no-scheduler']);
  sb.ok(['project', 'new', '--root', repo, '--non-interactive']);
  const pf = sb.projectFile('tidewatch');
  const f = JSON.parse(sb.ok(['adopt', 'scan', '--root', repo, '--json']).out);
  assert.equal(f.path, 'adopt');
  const t = f.commands.find(c => c.id === 'test');
  assert.equal(t.cmd, 'npm test'); assert.match(t.ci, /^\.github\/workflows\/ci\.yml:\d+$/);
  assert.equal(f.plans.length, 2); assert.equal(f.plans.reduce((n, x) => n + x.items, 0), 17);
  assert.equal(f.branches.filter(b => !b.merged).length, 2);
  // the read: the fake executor's final is the canned draft; it ends DONE, is ingested and checked
  const d = sb.ok(['adopt', 'draft', '--project', pf, '--as', 'owner', '--read', '--executor', 'fake', '--wait']);
  assert.match(d.out, /ADP-1 drafted from RUN-\d+/);
  let p = showOf(sb, pf);
  assert.match(p.draft.source, /^RUN-\d+$/);
  const road = p.parts.find(x => x.id === 'roadmap');
  assert.equal(road.lines.length, 14);
  const man = road.lines.find(l => l.text === MAN).id;
  sb.ok(['adopt', 'approve', 'roadmap', '--off', man, '--project', pf, '--as', 'owner']);
  sb.ok(['adopt', 'skip', 'rules', '--project', pf, '--as', 'owner']);
  sb.ok(['adopt', 'approve', 'commands', '--project', pf, '--as', 'owner']);
  sb.ok(['adopt', 'approve', 'profile', '--pick', 'try-it', '--project', pf, '--as', 'owner']);
  sb.ok(['adopt', 'skip', 'first', '--project', pf, '--as', 'owner']);
  // a process killed between decide and apply: its decision is on record, the others still stand
  const kill = `import { adoptDecide } from ${JSON.stringify(ADOPT_LIB)};
adoptDecide(${JSON.stringify(sb.project('tidewatch').state)}, { part: 'instructions', verdict: 'approve', by: 'owner' });
process.kill(process.pid, 'SIGKILL');`;
  const k = spawnSync(process.execPath, ['--input-type=module', '-e', kill], { env: sb.env, encoding: 'utf8' });
  assert.notEqual(k.status, 0, 'the decider was killed');
  p = showOf(sb, pf);
  assert.deepEqual(p.parts.map(x => [x.id, x.status]), [['profile', 'approved'], ['commands', 'approved'], ['rules', 'skipped'], ['instructions', 'approved'], ['roadmap', 'approved'], ['first', 'skipped']]);
  assert.deepEqual(p.undecided, []);
  const a = sb.ok(['adopt', 'apply', '--project', pf, '--as', 'owner']);
  assert.match(a.out, /roadmap: 13 item\(s\) in 6 theme\(s\)/); assert.match(a.out, /ADP-1 applied/);
  assertAdopted(sb, 'tidewatch');
  repoClean(repo, head);
  // re-run: a second read + apply -> ADP-2, every applied line "already there", 0 new items
  sb.ok(['adopt', 'draft', '--project', pf, '--as', 'owner', '--read', '--executor', 'fake', '--wait']);
  p = showOf(sb, pf);
  assert.equal(p.id, 'ADP-2');
  const r2 = p.parts.find(x => x.id === 'roadmap');
  assert.equal(r2.lines.filter(l => l.already).length, 13);
  sb.ok(['adopt', 'approve', 'roadmap', '--off', r2.lines.find(l => l.text === MAN).id, '--project', pf, '--as', 'owner']);
  const b = sb.ok(['adopt', 'apply', '--project', pf, '--as', 'owner']);
  assert.doesNotMatch(b.out, /roadmap: \d+ item/);
  assert.equal(items(sb)('tidewatch').filter(i => i.kind === 'item').length, 13);
  repoClean(repo, head);
});

test('the guided chain in a terminal (norn adopt <repo>): the questions one at a time, each part reviewed, apply on a yes', { timeout: 240000 }, () => {
  const sb = sandbox(), repo = young(sb, 'quay'), head = git(repo, 'rev-parse', 'HEAD');
  sb.ok(['setup', '--non-interactive', '--no-scheduler']);
  sb.ok(['project', 'new', '--root', repo, '--non-interactive']);
  // the answers: goal, month (blank = skip), first; the read? no; then per part in order: profile, commands, rules, instructions,
  // roadmap, first; then apply? yes
  const input = ['A ferry timetable', '', 'Load one timetable', 'n', 'p try-it', 'a', 's', 'a', 'a', 'p f1', 'y', ''].join('\n');
  const r = sb.run(['adopt', repo], { env: { META_INTERACTIVE: '1' }, input });
  assert.equal(r.code, 0, r.all);
  for (const re of [/What is this project for\?/, /What should exist in a month\?/, /What is the first small thing to do\?/, /Read it and draft/,
    /Caps profile/, /Roadmap/, /Apply/]) assert.match(r.out, re);
  assert.match(r.out, /ADP-1 applied/);
  assert.match(r.out, /norn run --executor fake --lane load-one-timetable/, 'it ends naming the free rehearsal of the first lane');
  const pr = sb.project('quay');
  assert.ok(fs.existsSync(path.join(pr.state, 'wt', 'load-one-timetable', '.git')));
  assert.deepEqual(items(sb)('quay').filter(i => i.kind === 'item').map(i => i.title), ['Load one timetable']);
  assert.ok(!fs.existsSync(path.join(path.dirname(sb.projectFile('quay')), 'rules', 'RULES.md')), 'rules skipped');
  repoClean(repo, head);
  // an unregistered repo is not a project yet: one line naming norn init
  const other = young(sb, 'pier');
  const u = sb.run(['adopt', other], { env: { META_INTERACTIVE: '1' } });
  assert.equal(u.code, 2); assert.match(u.all, /norn init/);
});

test('norn init in a terminal on a fresh machine: setup, project new and the chain ask each question once; parts left blank stay to review', { timeout: 240000 }, () => {
  const sb = sandbox(), repo = young(sb, 'quay');
  // notify: 4 (not now); project new: name, title, ci, branch, executors (blank = the detected value); goal, month, first; the read: no;
  // then every part blank (later)
  const input = ['4', '', '', '', '', '', 'A ferry timetable', '', 'Load one timetable', 'n', '', '', '', '', '', ''].join('\n');
  const r = sb.run(['init', repo], { env: { META_INTERACTIVE: '1' }, input });
  assert.equal(r.code, 0, r.all);
  assert.equal(r.out.match(/Get a ping when Norn needs you\?/g).length, 1, 'the notify question is asked once');
  assert.match(r.out, /project quay: OK/);
  assert.match(r.out, /left to review: profile, commands, rules, instructions, roadmap, first/);
  assert.doesNotMatch(r.out, /Apply the approved parts now/);
  // run again: the repo is a project, the open draft is resumed (not re-drafted, no question asked again)
  const again = sb.run(['init', repo, '--non-interactive']);
  assert.equal(again.code, 0, again.all);
  assert.match(again.out, /setup: done before/); assert.match(again.out, /project quay: registered before/); assert.match(again.out, /ADP-1 is open: resuming/);
  assert.equal(showOf(sb, sb.projectFile('quay')).draft.n, 1);
});

// ---------- the dashboard POST routes (A3) ----------
async function dash(sb) {
  const machine = loadMachine(sb.machineFile, { meta: sb.root });
  const platform = { tick: async () => ({ pid: 1 }), setInterval: async () => ({ ok: true }), ask: async () => ({ result: '', usage: {} }) };
  const app = createDashboard({ projects: [], machine, metaRoot: sb.root, env: sb.env, budgetFile: sb.budgetFile, platform, projectsDir: path.join(sb.t, 'cp'),
    codexDir: path.join(sb.t, 'cx'), sessionsDir: path.join(sb.t, 'sessions'), artDir: path.join(sb.t, 'art') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const get = async r => { const x = await fetch(url + r); const data = await x.json(); assert.ok(x.ok, `${r}: ${x.status} ${data.error}`); return data; };
  const post = async (r, b) => {
    const x = await fetch(url + r, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dash-token': app.token }, body: JSON.stringify(b) });
    const data = await x.json(); assert.ok(x.ok, `${r}: ${x.status} ${data.error}`); return data;
  };
  const decide = async (project, part, verdict, extra = {}) => {
    const P = (await get(`/api/adopt?project=${project}`)).proposal;
    return post('/api/adopt/decide', { project, part, verdict, sha: P.parts.find(x => x.id === part).sha, ...extra });
  };
  return { get, post, decide, close: () => app.close() };
}

// ---------- the MCP setup profile (A4) ----------
function mcp(sb) {
  const p = spawn(process.execPath, [META, 'mcp', '--profile', 'setup', '--client', 'e2e'], { env: sb.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0, stderr = '';
  const waiting = new Map();
  p.stdout.on('data', x => {
    buf += x;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.method && m.id !== undefined) { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } }) + '\n'); continue; }
      waiting.get(m.id)?.(m); waiting.delete(m.id);
    }
  });
  p.stderr.on('data', x => { stderr += x; });
  const call = (method, params = {}) => new Promise(res => {
    const n = ++id, t = setTimeout(() => { waiting.delete(n); res({ error: { message: 'timeout ' + stderr } }); }, 60000);
    waiting.set(n, m => { clearTimeout(t); res(m); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const r = await call('tools/call', { name, arguments: args });
    assert.ok(!r.error && !r.result.isError, `${name}: ${JSON.stringify(r.error || r.result.content)}`);
    return r.result.structuredContent;
  };
  return {
    init: () => call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }).then(() => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')),
    tool, close: () => new Promise(res => { p.on('exit', res); p.stdin.end(); }),
  };
}
