// META-OOTB-FIX (DIR-9, the out-of-box review F-4 .. F-15): a newcomer's first commands. Temp META_ROOT / HOME / USERPROFILE /
// CLAUDE_CONFIG_DIR and a PATH of fakes only - nothing here touches the live install, its scheduled task or ~/.local/bin.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { ledgerConfig } from '../engine/lib/ledger.mjs';
import { writeStatus } from '../engine/lib/status.mjs';
import { dashOpens } from '../engine/bin/norn.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { adapterFor, schedName, schedState, liveName, oldTasks, schedApply } from '../engine/lib/sched/index.mjs';
import { schedChoice, oldSchedProblems } from '../engine/lib/setup.mjs';
import { settled } from './helpers/settled.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const META = path.join(REPO, 'engine', 'bin', 'norn.mjs');
after(cleanTmp);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) { const t0 = Date.now(); for (;;) { if (fn()) return; if (Date.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); } }

function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === 'vendor' || e.name === 'node_modules') continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, acc); else if (/\.(mjs|js|html|css|json|md|cs|txt)$/.test(e.name)) acc.push(f);
  }
  return acc;
}

test('F-13: no owner folder names in engine defaults or comments; the ledger reviews default is derived from the install', () => {
  const hits = walk(path.join(REPO, 'engine')).flatMap(f => fs.readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l]))
    .filter(([, , l]) => /sdd-codex|norn-projects/.test(l)).map(([f, n]) => `${path.relative(REPO, f)}:${n}`);
  assert.deepEqual(hits, []);
  assert.equal(ledgerConfig({ ledger: {} }, { metaRoot: 'C:/x/norn' }).reviews, path.resolve('C:/x/norn-reviews'));
  assert.equal(ledgerConfig({ ledger: {} }, { metaRoot: 'C:/x/sdd-codex' }).reviews, path.resolve('C:/x/sdd-codex-reviews'), 'an existing install keeps its reviews dir');
});

test('F-10: STATUS.md of a fresh project (no budget): no NaN, no blank cap; unset caps read "unset (no limit)", the usage says it is not calibrated', () => {
  const state = mkTmp('meta-ootb-');
  const pd = path.join(path.dirname(path.dirname(state)), 'claude-projects'); fs.mkdirSync(pd);
  const s = writeStatus({ state, project: 'demo', budget: {}, projectsDir: pd, usageJson: {} });
  const text = fs.readFileSync(s.out, 'utf8');
  assert.doesNotMatch(text, /NaN/);
  for (const l of text.split(/\r?\n/).filter(x => /cap/.test(x))) assert.doesNotMatch(l, /(max_\w+|_per_h)=(;|$)|cap( ;|$|  )/, 'a blank cap: ' + l);
  assert.match(text, /max_claude_workers=unset \(no limit\);/);
  assert.match(text, /claude workers alive: 0 \/ cap unset \(no limit\)/);
  assert.match(text, /usage not estimated: no usage calibration yet/);
  assert.match(text, /^RATE_OK=1/m);
  assert.doesNotMatch(s.line, /NaN/); assert.match(s.line, /rate n\/a/);
});

// a sandbox env: temp META_ROOT / HOME / USERPROFILE / CLAUDE_CONFIG_DIR, PATH = one dir of fakes (never the live ~/.local/bin)
function sandbox() {
  const state = mkTmp('meta-ootb-'), t = path.dirname(path.dirname(state));
  const d = { t, root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg') };
  for (const x of [d.root, d.home, d.bin, d.cfg]) fs.mkdirSync(x, { recursive: true });
  const env = { ...process.env, PATH: d.bin, HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg, META_ROOT: d.root,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming') };
  for (const k of ['META_PROJECT', 'META_STATE', 'META_RUN_ID', 'META_ROLE', 'NPM_CONFIG_PREFIX', 'npm_config_prefix']) delete env[k];
  const run = (...args) => { const r = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8', timeout: 60000 }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  return { ...d, env, run };
}

test('F-11: every error path of norn run exits non-zero (the exit code itself, no pipeline)', () => {
  const sb = sandbox(), st = path.join(sb.t, 'state', 'demo'), brief = path.join(sb.t, 'brief.md');
  fs.mkdirSync(st, { recursive: true }); fs.writeFileSync(brief, '# brief\n');
  const cases = {
    'no state dir': ['run', '--executor', 'fake', '--lane', 'first', '--brief', brief],
    'unknown flag': ['run', '--bogus', 'x', '--state', st],
    'no executor': ['run', '--lane', 'first', '--brief', brief, '--state', st, '--worktree', sb.t],
    'no lane': ['run', '--executor', 'fake', '--brief', brief, '--state', st, '--worktree', sb.t],
    'no worktree': ['run', '--executor', 'fake', '--lane', 'first', '--brief', brief, '--state', st],
    'worktree not found': ['run', '--executor', 'fake', '--lane', 'first', '--brief', brief, '--state', st, '--worktree', path.join(st, 'wt', 'first'), '--no-tick'],
    'project not found': ['run', '--executor', 'fake', '--lane', 'first', '--brief', brief, '--project', path.join(sb.t, 'nope.json')],
  };
  for (const [why, args] of Object.entries(cases)) {
    const r = sb.run(...args);
    assert.notEqual(r.code, 0, `${why}: exit ${r.code}\n${r.out}${r.err}`);
    assert.ok(r.code !== null, `${why}: killed`);
    assert.match(r.err, /error/, why);
    if (r.code === 2 && /usage:/.test(r.err)) assert.doesNotMatch(r.err, /[A-Z]{2,4}-n/, `${why}: the short usage, no record-id syntax`);
  }
  assert.match(sb.run('run', '--lane', 'x').err, /usage: norn run --executor E --lane L --brief F \[options\] .*norn run --help/);
  assert.match(sb.run('run', '--help').out, /--after/, 'the full usage stays behind --help');
});

test('F-15: norn dash opens a browser only on a terminal or with --open; --no-open always wins', () => {
  assert.equal(dashOpens(null, true), true);
  assert.equal(dashOpens(null, false), false);
  assert.equal(dashOpens(null, undefined), false);
  assert.equal(dashOpens(true, false), true);
  assert.equal(dashOpens(false, true), false);
});

test('F-15: norn dash from a script (no TTY) serves, prints the URL and says it opened no browser', async () => {
  const root = mkTmp('meta-ootb-dash-'), fwd = p => p.replace(/\\/g, '/');
  fs.cpSync(path.join(REPO, 'projects', 'example'), path.join(root, 'projects', 'example'), { recursive: true });
  fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'local', 'machine.json'), JSON.stringify({ schema: 1, home: fwd(root), node: fwd(process.execPath),
    claude: { exe: fwd(process.execPath), config_dir: fwd(path.join(root, 'cfg')), projects_dir: fwd(path.join(root, 'cfg', 'projects')) }, codex: null, git: { exe: fwd(process.execPath) },
    scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, dash: { port: 8737, bind: '127.0.0.1' },
    projects: [{ name: 'example', config: '${meta}/projects/example/project.json' }] }));
  const c = spawn(process.execPath, [META, 'dash', '--port', '0'], { env: { ...process.env, META_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const text = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('timeout: ' + buf)), 30000);
      c.stdout.on('data', b => { buf += b; if (/browser: /.test(buf)) { clearTimeout(t); resolve(buf); } });
      c.on('exit', x => { clearTimeout(t); reject(new Error(`exited ${x}: ${buf}`)); });
    });
    assert.match(text, /^DASH http:\/\/127\.0\.0\.1:\d+\//m);
    assert.match(text, /^browser: not opened \(not a terminal\) - pass --open to open it$/m);
  } finally { c.kill(); }
});

// every command main() dispatches (engine/bin/norn.mjs): the help screen names each one
const COMMANDS = ['setup', 'project', 'doctor', 'smoke', 'dash', 'status', 'runs', 'tick', 'run', 'stop', 'rec', 'digest', 'deliverables', 'mergeq', 'merge-brief', 'merge-land',
  'ready', 'flow', 'epic', 'cv', 'delegate', 'ask', 'mail', 'notify', 'gen', 'sched', 'migrate', 'calib', 'executors', 'harness', 'mcp', 'ledger', 'node', 'hook', 'eval', 'lane', 'init', 'done'];

// META-RENAME R1 (DIR-22): `norn help` = the commands a person types; the plumbing and the in-run trio move under `norn help --all`
const ALL_ONLY = ['hook', 'mcp', 'node', 'merge-brief', 'merge-land', 'eval', 'migrate', 'gen', 'harness', 'ready', 'calib', 'delegate', 'ask', 'mail', 'done'];

test('F-5: norn / norn help / norn --help = one help screen grouped by job, the newcomer commands first (META-ADOPT A5: init, then the 5 it chains or follows), exit 0', () => {
  const sb = sandbox();
  const screens = [[], ['help'], ['--help'], ['-h']].map(a => sb.run(...a));
  for (const r of screens) { assert.equal(r.code, 0, r.err); assert.equal(r.out, screens[0].out); assert.equal(r.err, ''); }
  const h = screens[0].out, lines = h.split(/\r?\n/);
  const first = lines.filter(l => /^ {2}norn [a-z]/.test(l)).slice(0, 6).map(l => l.trim().split(/ {2,}/)[0]);
  assert.deepEqual(first, ['norn init <repo>', 'norn setup', 'norn project new --root <repo>', 'norn doctor', 'norn smoke', 'norn dash']);
  assert.ok(lines.filter(l => /^\S.*:$/.test(l)).length >= 4, 'grouped by job (>= 4 headed groups)');
  for (const c of COMMANDS.filter(c => !ALL_ONLY.includes(c))) assert.match(h, new RegExp(`^ {2}norn ${c}(\\s|$)`, 'm'), `help names ${c}`);
  for (const c of ALL_ONLY) assert.doesNotMatch(h, new RegExp(`^ {2}norn ${c}(\\s|$)`, 'm'), `${c} is under --all only`);
  assert.doesNotMatch(h, /^ {2}meta /m, 'no command line says meta');
  assert.doesNotMatch(h, /old name|\bmeta\b/, 'the old name is never said');
  assert.match(h, /norn <command> --help/); assert.match(h, /norn help --all/);
});

test('norn help --all lists every command (the --all ones one line each); norn help is a subset of it', () => {
  const sb = sandbox(), r = sb.run('help', '--all'), h = sb.run('help').out;
  assert.equal(r.code, 0, r.err);
  // one entry line per command; a subcommand example line (`norn project new --root <repo>` under Start here) is not the entry
  for (const c of COMMANDS) assert.equal(r.out.match(new RegExp(`^ {2}norn ${c}(?! [a-z])(\\s|$)`, 'mg'))?.length, 1, `--all names ${c} once`);
  for (const l of h.split(/\r?\n/).filter(l => /^ {2}norn /.test(l))) assert.ok(r.out.includes(l), `--all keeps: ${l}`);
  assert.doesNotMatch(r.out, /^ {2}meta /m);
});

test("F-5: norn <cmd> --help prints that command's usage, exit 0; norn help <cmd> the same; an unknown command points at norn help", () => {
  const sb = sandbox();
  for (const c of COMMANDS) {
    const r = sb.run(c, '--help');
    assert.equal(r.code, 0, `${c}: ${r.err}`);
    assert.match(r.out, new RegExp(`^usage: norn ${c}(\\s|$)`), c);
    assert.doesNotMatch(r.out, /(^|[\s|(`'"])meta (?!controller)[a-z]/, `${c}: the usage says norn`);
    assert.equal(sb.run('help', c).out, r.out, `norn help ${c}`);
  }
  const u = sb.run('frobnicate');
  assert.equal(u.code, 2); assert.match(u.err, /unknown command frobnicate/); assert.match(u.err, /see norn help/);
});

// a META_ROOT with machine.json + the given projects registered (temp; no setup run, no shim)
function registered(names) {
  const sb = sandbox(), fwd = p => p.replace(/\\/g, '/');
  fs.mkdirSync(path.join(sb.root, 'local'), { recursive: true });
  const projects = names.map(n => {
    const root = path.join(sb.t, 'repos', n), f = path.join(sb.t, 'projects', n, 'project.json');
    fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ schema: 1, name: n, title: n, root: fwd(root), ledger: '${root}/progress.md', briefs_dir: '${root}', checkin: { cwd: '${root}' } }));
    return { name: n, config: fwd(f) };
  });
  fs.writeFileSync(path.join(sb.root, 'local', 'machine.json'), JSON.stringify({ schema: 1, home: fwd(sb.home), node: fwd(process.execPath),
    claude: { exe: fwd(process.execPath), config_dir: fwd(sb.cfg), projects_dir: fwd(path.join(sb.cfg, 'projects')) }, codex: null, git: { exe: fwd(process.execPath) },
    scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, dash: { port: 8737, bind: '127.0.0.1' }, projects }));
  return { ...sb, state: n => path.join(sb.root, 'state', n) };
}

test('F-7: one registered project = the default of status / runs / rec / run / tick; --project takes its NAME as well as a path', async () => {
  const sb = registered(['demo']);
  let r = sb.run('status');
  assert.equal(r.code, 0, r.err); assert.ok(fs.existsSync(path.join(sb.state('demo'), 'STATUS.md')), 'status of the only project');
  r = sb.run('status', '--project', 'demo');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /STATUS\.md/);
  r = sb.run('runs', '--project', 'demo'); assert.equal(r.code, 0, r.err);
  r = sb.run('runs'); assert.equal(r.code, 0, r.err);
  r = sb.run('rec', 'add', 'directive', '--text', 'first', '--via', 'chat', '--as', 'owner', '--project', 'demo');
  assert.equal(r.code, 0, r.err); assert.equal(r.out.trim(), 'DIR-1');
  r = sb.run('rec', 'list');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^DIR-1\s+active/m);
  const brief = path.join(sb.t, 'brief.md'); fs.writeFileSync(brief, '# b\n');
  r = sb.run('run', '--project', 'demo', '--executor', 'fake', '--lane', 'first', '--brief', brief, '--worktree', path.join(sb.t, 'no-wt'), '--no-tick');
  assert.equal(r.code, 2); assert.match(r.err, /worktree not found/, 'the name resolved to the project (the error is the worktree, not the project)');
  r = sb.run('tick', '--project', 'demo', '--dry', '--reason', 'cli');
  assert.equal(r.code, 0, r.err); assert.match(r.out, /check-in RUN-1/);
  await waitFor(() => loadState(sb.state('demo')).items['RUN-1']?.state === 'exited' && settled(loadState(sb.state('demo')).items['RUN-1']));
});

test('F-7: two registered projects and no --project = an error naming both; an unknown name is an error', () => {
  const sb = registered(['alpha', 'beta']);
  let r = sb.run('status');
  assert.equal(r.code, 2); assert.match(r.err, /registered: alpha, beta/);
  r = sb.run('status', '--project', 'beta');
  assert.equal(r.code, 0, r.err); assert.ok(fs.existsSync(path.join(sb.state('beta'), 'STATUS.md')));
  r = sb.run('status', '--project', 'gamma');
  assert.equal(r.code, 2); assert.match(r.err, /gamma/);
});

// a fake `claude` on the sandbox PATH: `claude auth status --json` answers per FAKE_AUTH (in | out | broken); anything else = a version
function fakeClaude(sb) {
  const js = path.join(sb.bin, 'claude-cli.js');
  fs.writeFileSync(js, `const a = process.argv.slice(2).join(' '), m = process.env.FAKE_AUTH;
if (a !== 'auth status --json') { console.log('2.1.0 (Claude Code)'); process.exit(0); }
if (m === 'in') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'secret@example.com', orgId: 'org-secret' })); process.exit(0); }
if (m === 'out') { console.log(JSON.stringify({ loggedIn: false })); process.exit(1); }
console.log('not json'); process.exit(1);
`);
  if (process.platform === 'win32') fs.writeFileSync(path.join(sb.bin, 'claude.cmd'), '@"%dp0%\\claude-cli.js" %*\r\n'.replace('@', '@"node" '));
  else { fs.writeFileSync(path.join(sb.bin, 'claude'), `#!${process.execPath}\nimport(${JSON.stringify(js)});\n`, { mode: 0o755 }); }
  fs.writeFileSync(path.join(sb.bin, process.platform === 'win32' ? 'git.exe' : 'git'), '');
}

test('F-14: doctor runs one cheap auth probe of the found claude - logged in = ok (no account detail printed), logged out = PROBLEM, unanswerable = a note', () => {
  const sb = sandbox(); fakeClaude(sb);
  const r0 = sb.run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(r0.code, 0, r0.out + r0.err);
  const doc = mode => { const r = spawnSync(process.execPath, [META, 'doctor'], { env: { ...sb.env, FAKE_AUTH: mode }, encoding: 'utf8', timeout: 60000 }); return { code: r.status, out: r.stdout + r.stderr }; };
  let r = doc('in');
  assert.match(r.out, /^ok claude auth: logged in \(claude\.ai\)$/m, r.out);
  assert.doesNotMatch(r.out, /secret|org-/);
  assert.equal(r.code, 0, r.out);
  r = doc('out');
  assert.match(r.out, /^PROBLEM claude: not logged in - run: claude auth login$/m, r.out);
  assert.equal(r.code, 1);
  r = doc('broken');
  assert.match(r.out, /^note claude auth: not checked \(/m, r.out);
  assert.equal(r.code, 0, r.out);
});

// ---- F-4: two installs on one machine (an injected scheduler io: no test ever queries the real OS scheduler) ----
const winTask = dir => `<?xml version="1.0" encoding="UTF-16"?>\n<Task><Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-Command "&amp; 'C:/n/node.exe' '${dir}/engine/bin/norn.mjs' 'tick'"</Arguments><WorkingDirectory>${dir}</WorkingDirectory></Exec></Actions></Task>\n`;
// a fake OS scheduler: tasks = { name: owner install dir }; answers the queries of every adapter
function fakeSched(tasks, files = {}) {
  const calls = [];
  const io = {
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'schtasks' && args[0] === '/Query') { const n = args[args.indexOf('/TN') + 1]; return n in tasks ? { status: 0, stdout: args.includes('/XML') ? winTask(tasks[n]) : n } : { status: 1, stdout: '' }; }
      if (cmd === 'crontab' && args[0] === '-l') return { status: 0, stdout: Object.entries(tasks).map(([n, d]) => `*/15 * * * * cd ${d.includes(' ') ? `'${d}'` : d} && /n/node ${d}/engine/bin/norn.mjs tick --reason schedule >/dev/null 2>&1 # meta:${n}`).join('\n') + '\n' };
      if (cmd === 'systemctl') { const n = args.at(-1).replace(/\.timer$/, ''); return { status: n in tasks ? 0 : 1, stdout: '' }; }
      if (cmd === 'launchctl') return { status: args[1] in tasks ? 0 : 1, stdout: '' };
      return { status: 0, stdout: '' };
    },
    exists: f => f in files, read: f => files[f] ?? null, write: () => { throw new Error('a test never installs'); }, rm: () => { throw new Error('a test never removes'); },
  };
  return { io, calls };
}

test('F-4: the task name is derived per install (stable, distinct per path; same dir in any spelling on Windows)', () => {
  const a = schedName('C:/dev/norn', 'win32'), b = schedName('C:/dev/norn-2', 'win32');
  assert.match(a, /^norn-tick-[0-9a-f]{8}$/); assert.notEqual(a, b);
  assert.equal(schedName('c:\\dev\\norn\\', 'win32'), a, 'case / slashes / a trailing slash name the same install on Windows');
  assert.notEqual(schedName('/srv/Norn', 'linux'), schedName('/srv/norn', 'linux'));
});

test('F-4: every adapter names the install its installed task runs; schedState is "installed" for THIS install only', () => {
  const me = 'C:/dev/norn', other = 'D:/inst/sdd-codex';
  const o = { name: 'norn-tick', interval_min: 15, node: '/n/node', meta: me, home: '/h' };
  for (const kind of ['windows-task', 'cron']) {
    const a = adapterFor(kind);
    assert.deepEqual(schedState(a, o, fakeSched({ 'norn-tick': other }).io), { installed: true, owner: other, foreign: true }, kind);
    assert.deepEqual(schedState(a, o, fakeSched({ 'norn-tick': 'c:/DEV/norn/' }).io).foreign, false, `${kind}: the same Windows dir in another spelling`);
    assert.deepEqual(schedState(a, o, fakeSched({}).io), { installed: false, owner: null, foreign: false }, kind);
  }
  const sd = adapterFor('systemd'), svc = '/h/.config/systemd/user/norn-tick.service';
  assert.equal(schedState(sd, o, fakeSched({ 'norn-tick': other }, { [svc]: `[Service]\nWorkingDirectory=${other}\nExecStart=x\n` }).io).owner, other);
  const ld = adapterFor('launchd'), pl = '/h/Library/LaunchAgents/norn-tick.plist';
  const lio = fakeSched({ 'norn-tick': me }, { [pl]: `<dict>\n  <key>WorkingDirectory</key><string>${me}</string>\n</dict>` }).io;
  assert.deepEqual(schedState(ld, o, lio), { installed: true, owner: me, foreign: false });
  // an owner the engine cannot read is never called foreign (never re-derived, never refused)
  assert.deepEqual(schedState(sd, o, fakeSched({ 'norn-tick': other }).io), { installed: true, owner: null, foreign: false });
});

test('F-4 HARD GATE: the existing install keeps its recorded task name; a fresh install derives its own; a recorded name another install owns is re-derived', () => {
  const live = 'D:/inst/sdd-codex', clone = 'D:/inst/norn', win = adapterFor('windows-task');
  const base = { kind: 'windows-task', interval_min: 15 };
  // the install re-runs setup: its recorded name stays, no note
  let p = schedChoice({ old: { ...base, name: schedName(live) }, meta: live, adapter: win, io: fakeSched({ [schedName(live)]: live }).io, node: '/n', home: '/h' });
  assert.equal(p.name, schedName(live)); assert.deepEqual(p.notes, []);
  // its task is not installed at all (or unreadable): the recorded name still stays
  p = schedChoice({ old: { ...base, name: 'norn-tick' }, meta: live, adapter: win, io: fakeSched({}).io, node: '/n', home: '/h' });
  assert.equal(p.name, 'norn-tick');
  // a recorded name the task of another install has: re-derived, said so
  p = schedChoice({ old: { ...base, name: 'norn-tick' }, meta: clone, adapter: win, io: fakeSched({ 'norn-tick': live }).io, node: '/n', home: '/h' });
  assert.equal(p.name, schedName(clone));
  assert.deepEqual(p.notes, [`scheduled task 'norn-tick' belongs to the install at ${live} - not this one (this install's task: '${schedName(clone)}')`]);
  // a fresh clone beside an install still on the pre-rename task: its own name, the other install's task is not its business
  p = schedChoice({ old: null, meta: clone, adapter: win, io: fakeSched({ 'meta-controller-tick': live }).io, node: '/n', home: '/h' });
  assert.equal(p.name, schedName(clone)); assert.deepEqual(p.notes, []);
});

// META-NAME-W2: a stateful fake Task Scheduler / crontab (never the real one) for the old-name migration
function liveSched(tasks, tab = '') {
  const io = {
    run: (cmd, args, input) => {
      const n = args[args.indexOf('/TN') + 1];
      if (cmd === 'schtasks' && args[0] === '/Query') return n in tasks ? { status: 0, stdout: args.includes('/XML') ? winTask(tasks[n]) : n } : { status: 1, stdout: '' };
      if (cmd === 'schtasks' && args[0] === '/Create') { tasks[n] = 'D:/inst/norn'; return { status: 0 }; }
      if (cmd === 'schtasks' && args[0] === '/Delete') { if (!(n in tasks)) return { status: 1, stderr: 'not found' }; delete tasks[n]; return { status: 0 }; }
      if (cmd === 'crontab' && args[0] === '-l') return { status: 0, stdout: tab };
      if (cmd === 'crontab' && args[0] === '-') { tab = input; return { status: 0 }; }
      throw new Error('unexpected ' + cmd);
    },
    write: () => {}, rm: () => {}, exists: () => false, read: () => null,
  };
  return { io, tasks, tab: () => tab };
}

test('NAME-W2: sched install / remove move the pre-rename task of THIS install in one step; another install\'s task is kept', () => {
  const me = 'D:/inst/norn', other = 'D:/inst/sdd-codex', win = adapterFor('windows-task'), hashed = schedName(me).replace(/^norn-tick-/, 'meta-controller-tick-');
  assert.match(schedName(me), /^norn-tick-[0-9a-f]{8}$/);
  const o = { name: liveName('meta-controller-tick', me), interval_min: 15, node: '/n/node', meta: me, home: '/h' };
  assert.equal(o.name, schedName(me), 'a recorded pre-rename name runs as this install\'s norn-tick name');
  assert.equal(liveName('norn-tick-custom', me), 'norn-tick-custom');
  // the owner's case: the bare old name runs this install -> install = the new task in, the old one out, one command
  let s = liveSched({ 'meta-controller-tick': me });
  assert.deepEqual(oldTasks(win, o, s.io), ['meta-controller-tick']);
  assert.deepEqual(schedApply('install', win, o, 'windows-task', s.io), [`scheduler windows-task '${o.name}' installed (every 15 min)`, `scheduler windows-task 'meta-controller-tick' removed (the old name)`]);
  assert.deepEqual(Object.keys(s.tasks), [o.name], 'never two ticks');
  // the per-install old name goes too; the bare old name of ANOTHER install stays
  s = liveSched({ [hashed]: me, 'meta-controller-tick': other });
  schedApply('install', win, o, 'windows-task', s.io);
  assert.deepEqual(Object.keys(s.tasks).sort(), ['meta-controller-tick', o.name].sort());
  // remove with only the old task left: it goes, the new one was never there
  s = liveSched({ 'meta-controller-tick': me });
  assert.deepEqual(schedApply('remove', win, o, 'windows-task', s.io), [`scheduler windows-task '${o.name}': not installed`, `scheduler windows-task 'meta-controller-tick' removed (the old name)`]);
  assert.deepEqual(s.tasks, {});
  // cron: the old "# meta:" line goes, a foreign line stays, the new line is tagged "# norn:"
  s = liveSched({}, `0 1 * * * /usr/bin/backup\n*/15 * * * * cd ${me} && /n/node ${me}/engine/bin/norn.mjs tick --reason schedule >/dev/null 2>&1 # meta:${hashed}\n`);
  schedApply('install', adapterFor('cron'), o, 'cron', s.io);
  assert.match(s.tab(), new RegExp(`^0 1 \\* \\* \\* /usr/bin/backup\\n\\*/15 .* # norn:${o.name}\\n$`));
});

test('NAME-W2: doctor names a left-over pre-rename task of this install as a PROBLEM with the command that moves it', () => {
  const me = 'D:/inst/norn', machine = { scheduler: { kind: 'windows-task', name: 'meta-controller-tick', interval_min: 15 }, node: '/n/node', home: '/h' };
  assert.deepEqual(oldSchedProblems({ machine, meta: me, io: liveSched({ 'meta-controller-tick': me }).io }),
    [`scheduler: old task 'meta-controller-tick' of this install is still installed - run: norn sched install (moves it to '${schedName(me)}')`]);
  assert.deepEqual(oldSchedProblems({ machine, meta: me, io: liveSched({ 'meta-controller-tick': 'D:/inst/other' }).io }), [], 'another install\'s task is not this install\'s problem');
  assert.deepEqual(oldSchedProblems({ machine: { ...machine, scheduler: { ...machine.scheduler, name: schedName(me) } }, meta: me, io: liveSched({ [schedName(me)]: me }).io }), []);
  // setup says it too, and moves the recorded name
  const p = schedChoice({ old: machine.scheduler, meta: me, adapter: adapterFor('windows-task'), io: liveSched({ 'meta-controller-tick': me }).io, node: '/n', home: '/h' });
  assert.equal(p.name, schedName(me));
  assert.deepEqual(p.notes, [`old scheduled task 'meta-controller-tick' of this install is still installed - norn sched install moves it to '${schedName(me)}'`]);
});

test('F-4: setup keeps a meta / norn shim of ANOTHER install and names it; a shim whose install is gone is replaced', () => {
  const sb = sandbox(); fakeClaude(sb);
  const other = path.join(sb.t, 'other-install'), otherCli = path.join(other, 'engine', 'bin', 'norn.mjs');
  fs.mkdirSync(path.dirname(otherCli), { recursive: true }); fs.writeFileSync(otherCli, '');
  const bin = path.join(sb.home, '.local', 'bin'); fs.mkdirSync(bin, { recursive: true });
  const shim = `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, '/')}" "${otherCli.replace(/\\/g, '/')}" "$@"\n`;
  for (const n of ['meta', 'norn']) fs.writeFileSync(path.join(bin, n), shim);
  let r = sb.run('setup', '--non-interactive', '--no-scheduler', '--force');
  assert.equal(r.code, 0, r.out + r.err);
  for (const n of ['meta', 'norn']) assert.equal(fs.readFileSync(path.join(bin, n), 'utf8'), shim, `${n}: the other install's shim is untouched`);
  assert.match(r.out, /\/meta runs the install at .*\/other-install - kept/);
  assert.match(r.out, /\/norn runs the install at .*\/other-install - kept/);
  fs.rmSync(other, { recursive: true });
  r = sb.run('setup', '--non-interactive', '--no-scheduler', '--force');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(fs.readFileSync(path.join(bin, 'meta'), 'utf8'), new RegExp(path.join(REPO, 'engine', 'bin', 'norn.mjs').replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(sb.run('setup', '--non-interactive', '--no-scheduler').out, /scheduler: skipped/);
  assert.match(JSON.parse(fs.readFileSync(path.join(sb.root, 'local', 'machine.json'), 'utf8')).scheduler.name, /^norn-tick-[0-9a-f]{8}$/, 'recorded in machine.json');
});
