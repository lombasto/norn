// META-SHOT R1: `norn shot` - the one safe headless-browser helper. The command line per OS row (golden), the flow against a fake
// browser (tests/fixtures/fake-browser.mjs), the temp profile removed, no process left, cross-origin navigation refused, and the
// role packs pointing workers at it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BROWSERS, findBrowser, browserArgs, browserEnv, allowedUrl, checkSteps, shot, parseShotArgs, ShotError, killProfileProcs, removeProfile, closeBrowser, launchBrowser, waitDevToolsPort } from '../engine/lib/shot.mjs';
import { renderMergeBrief } from '../engine/lib/mergebrief.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

after(cleanTmp);
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(HERE, '..');
const META = path.join(ROOT, 'engine', 'bin', 'norn.mjs'), FAKE = path.join(HERE, 'fixtures', 'fake-browser.mjs');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const readLog = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));

// the first row of each OS, found by a fake file system: the exe and the exact command line
const GOLDEN = {
  win32: { env: { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\LA' }, exe: 'C:\\PF86/Microsoft/Edge/Application/msedge.exe', kind: 'edge' },
  darwin: { env: {}, exe: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', kind: 'edge' },
  linux: { env: { PATH: '/usr/bin' }, exe: path.join('/usr/bin', 'microsoft-edge'), kind: 'edge' },
};
const COMMON = ['--headless=new', '--user-data-dir=/tmp/p', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'];
const TAIL = ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--metrics-recording-only', '--no-pings'];
const EDGE_OFF = '--disable-features=msImplicitSignin,msSeamlessWebToBrowserSignIn,msEnableWebToBrowserSignIn,msEnableAADWebToBrowserSignIn,msQuickAuthToBrowserSignIn';

test('shot: every OS row is found by its own path, and the edge / chrome command lines are golden', () => {
  for (const [os, g] of Object.entries(GOLDEN)) {
    const b = findBrowser({ platform: os, env: g.env, exists: f => f === g.exe });
    assert.deepEqual(b, { kind: g.kind, exe: g.exe }, os);
  }
  for (const r of BROWSERS) {   // each row alone on its machine is found
    const env = { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\LA', PATH: '/usr/bin' };
    const want = r.os === 'win32' ? r.path.replace(/%([^%]+)%/g, (_, k) => env[k]) : r.os === 'linux' ? path.join('/usr/bin', r.path) : r.path;
    assert.deepEqual(findBrowser({ platform: r.os, env, exists: f => f === want }), { kind: r.kind, exe: want }, r.path);
  }
  assert.equal(findBrowser({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false }), null);
  assert.deepEqual(browserArgs({ kind: 'edge', profile: '/tmp/p', size: [1440, 900], hosts: ['127.0.0.1'] }),
    [...COMMON, '--inprivate', ...TAIL, EDGE_OFF, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--window-size=1440,900', 'about:blank']);
  assert.deepEqual(browserArgs({ kind: 'chrome', profile: '/tmp/p', size: [390, 844], hosts: ['dash.lan'] }),
    [...COMMON, '--incognito', ...TAIL, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE dash.lan', '--window-size=390,844', 'about:blank']);
});

test('shot: on Windows the browser gets its own USERPROFILE with AppData/Local + Roaming under the temp profile (a sandbox USERPROFILE without them: Edge "Unable to get local app data path", no DevTools port)', () => {
  const profile = mkTmp('meta-shot-'), env = { USERPROFILE: path.join(profile, 'no-such-home'), LOCALAPPDATA: 'C:\\LA', KEEP: '1' };
  const w = browserEnv({ profile, env, platform: 'win32' });
  assert.equal(w.USERPROFILE, path.join(profile, 'home'));
  for (const d of ['Local', 'Roaming']) assert.ok(fs.statSync(path.join(profile, 'home', 'AppData', d)).isDirectory(), d);
  assert.equal(w.KEEP, '1'); assert.equal(env.USERPROFILE, path.join(profile, 'no-such-home'), 'the caller env is not mutated');
  assert.deepEqual(browserEnv({ profile, env, platform: 'linux' }), env, 'other OSes: the env as given');
});

test('shot: only 127.0.0.1, file: and the given origin; a cross-origin go is refused before any browser starts', () => {
  const o = 'http://127.0.0.1:4000';
  for (const u of ['http://127.0.0.1:9/x', 'file:///c:/a.html', 'about:blank', 'data:text/html,x', 'ws://127.0.0.1:4000/ws']) assert.ok(allowedUrl(u, o), u);
  for (const u of ['https://login.microsoftonline.com/', 'http://localhost:4000/', 'https://edge.microsoft.com/sync', 'chrome://settings', 'not a url']) assert.ok(!allowedUrl(u, o), u);
  assert.ok(allowedUrl('https://dash.lan:8443/a', 'https://dash.lan:8443'));
  assert.ok(!allowedUrl('https://dash.lan:9999/a', 'https://dash.lan:8443'));
  assert.throws(() => checkSteps([{ go: 'https://login.live.com/' }], o), e => e instanceof ShotError && /refused navigation to https:\/\/login\.live\.com/.test(e.message));
  assert.throws(() => checkSteps([{ nope: 1 }], o), /needs one of go/);
  const tmp = mkTmp('meta-shot-'), logf = path.join(tmp, 'fake.log');
  const r = spawnSync(process.execPath, [META, 'shot', 'http://127.0.0.1:1/', '--out', path.join(tmp, 'a.png'), '--browser', FAKE, '--steps', '[{"go":"https://evil.example/"}]'],
    { encoding: 'utf8', env: { ...process.env, FAKE_BROWSER_LOG: logf } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refused navigation to https:\/\/evil\.example\//);
  assert.ok(!fs.existsSync(logf), 'the browser never started');
});

test('shot: usage errors exit 2 with the usage line', () => {
  assert.throws(() => parseShotArgs(['http://127.0.0.1:1/']), /--out <png> is required/);
  assert.throws(() => parseShotArgs(['http://127.0.0.1:1/', '--out', 'a.png', '--phone', '--size', '10x10']), /exclude each other/);
  assert.throws(() => parseShotArgs(['http://127.0.0.1:1/', '--out', 'a.png', '--theme', 'blue']), /dark or light/);
  const r = spawnSync(process.execPath, [META, 'shot'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: norn shot <url> --out <png>/);
});

test('shot: the flow against a fake browser - shots written, foreign requests failed, profile removed, no process left', async () => {
  const tmp = mkTmp('meta-shot-'), logf = path.join(tmp, 'fake.log'), out = path.join(tmp, 'shots', 'dash.png');
  process.env.FAKE_BROWSER_LOG = logf;
  let seen = null;
  const lines = [];
  try {
    const r = await shot({ url: 'http://127.0.0.1:4000/', out, phone: true, theme: 'dark', tmp, log: l => lines.push(l),
      browser: { kind: 'edge', exe: process.execPath, prefix: [FAKE] },
      steps: [{ click: 'Inbox' }, { type: ['#q', 'hi'] }, { text: 'main' }, { shot: path.join(tmp, 'shots', 'step.png') }, { go: 'http://127.0.0.1:4000/#/runs', wait: 10 }],
      onProfile: d => { seen = { dir: d, local: fs.existsSync(path.join(d, 'Local State')) }; } });
    assert.deepEqual(r.shots, [path.join(tmp, 'shots', 'step.png'), out]);
    assert.deepEqual(r.blocked, ['https://login.example.com/x']);
  } finally { delete process.env.FAKE_BROWSER_LOG; }
  assert.ok(fs.statSync(out).size > 0 && fs.readFileSync(out).subarray(1, 4).toString() === 'PNG');
  const log = readLog(logf), start = log[0], calls = log.filter(x => x.method);
  assert.ok(start.argv.includes('--inprivate') && start.argv.includes('--disable-sync') && start.argv.includes(EDGE_OFF), start.argv.join(' '));
  assert.equal(seen?.local, true, 'the profile was the browser\'s --user-data-dir');
  assert.equal(start.profile, seen.dir);
  assert.ok(!fs.existsSync(seen.dir), 'temp profile removed');
  assert.ok(!alive(start.pid) && !alive(start.child), 'the browser and its child are gone');
  const fetchAnswers = calls.filter(c => /^Fetch\.(continue|fail)Request$/.test(c.method)).map(c => [c.method, c.params.requestId]);
  assert.deepEqual(fetchAnswers.sort(), [['Fetch.continueRequest', 'R-local'], ['Fetch.failRequest', 'R-foreign']]);
  assert.deepEqual(calls.find(c => c.method === 'Emulation.setDeviceMetricsOverride').params, { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  assert.deepEqual(calls.find(c => c.method === 'Emulation.setEmulatedMedia').params, { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  assert.deepEqual(calls.filter(c => c.method === 'Page.navigate').map(c => c.params.url), ['http://127.0.0.1:4000/', 'http://127.0.0.1:4000/#/runs']);
  assert.ok(lines.includes('blocked https://login.example.com/x'), lines.join('\n'));
  assert.ok(lines.some(l => /^text> eval@/.test(l)) && lines.some(l => /^click Inbox eval@/.test(l)), lines.join('\n'));
});

test('shot: norn shot on the command line drives the fake browser and leaves no profile behind', () => {
  const tmp = mkTmp('meta-shot-'), logf = path.join(tmp, 'fake.log'), out = path.join(tmp, 'd.png'), prof = path.join(tmp, 'prof');
  fs.mkdirSync(prof);
  const r = spawnSync(process.execPath, [META, 'shot', 'http://127.0.0.1:4000/', '--out', out, '--size', '800x600', '--theme', 'light', '--browser', FAKE],
    { encoding: 'utf8', env: { ...process.env, FAKE_BROWSER_LOG: logf, TMP: prof, TEMP: prof, TMPDIR: prof } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^shot .*d\.png$/m);
  assert.ok(fs.existsSync(out));
  // the jobguard helper is a cache of the temp dir by design (jobguard.mjs: <tmp>/meta-jobguard-<sha>.exe, compiled by the cleanup's
  // process listing, strays.listProcs -> boundedSync); everything else is the browser's
  assert.deepEqual(fs.readdirSync(prof).filter(f => !/^meta-jobguard-[0-9a-f]{12}\.exe$/.test(f)), [], 'temp profile removed');
  const start = readLog(logf)[0];
  assert.ok(start.argv.includes('--window-size=800,600'));
  assert.ok(!alive(start.pid) && !alive(start.child));
});

test('shot: a launcher that hands the browser to a detached child and exits 0 (Edge on Windows) - the browser is still found and killed', async () => {
  const tmp = mkTmp('meta-shot-'), logf = path.join(tmp, 'fake.log');
  process.env.FAKE_BROWSER_LOG = logf; process.env.FAKE_BROWSER_HANDOFF = '1';
  try {
    const r = await shot({ url: 'http://127.0.0.1:4000/', out: path.join(tmp, 'h.png'), tmp, browser: { kind: 'edge', exe: process.execPath, prefix: [FAKE] } });
    assert.equal(r.shots.length, 1);
  } finally { delete process.env.FAKE_BROWSER_LOG; delete process.env.FAKE_BROWSER_HANDOFF; }
  const start = readLog(logf)[0];
  assert.ok(!alive(start.pid) && !alive(start.child), 'the handed-off browser and its child are gone');
  assert.deepEqual(fs.readdirSync(tmp).filter(x => x.startsWith('meta-shot-')), [], 'temp profile removed');
});

test('shot: killProfileProcs takes the profile processes AND their descendants (a browser child need not name the profile; Linux has no kill-on-close job)', async () => {
  const procs = [{ pid: 10, ppid: 1, cmd: 'edge --user-data-dir=C:\\T\\meta-shot-x' }, { pid: 11, ppid: 10, cmd: 'node -e x' }, { pid: 12, ppid: 11, cmd: 'gpu' },
    { pid: 20, ppid: 1, cmd: 'other' }, { pid: 21, ppid: 20, cmd: 'other kid' }];
  const killed = [];
  // a killed child is out of the list (orphaned: no profile, no parent link) before it is gone (CI 43766573125 Linux): it counts until then
  const esrch = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
  let probes = 0;
  const left = await killProfileProcs('C:/T/meta-shot-x', { list: () => procs.filter(p => !killed.includes(p.pid)), kill: pid => killed.push(pid),
    probe: pid => { if (!killed.includes(pid) || (pid === 11 && ++probes < 3)) return true; esrch(); } });
  assert.equal(left, 0);
  assert.equal(probes, 3, 'waited for the killed child until it was gone');
  assert.deepEqual([...new Set(killed)].sort(), [10, 11, 12]);
});

test('shot: killProfileProcs waits while an exited process is still listed on the profile (Windows rundown: kill says ESRCH, Win32_Process still shows it holding the files; CI 43766573125 home C2)', async () => {
  let lists = 0, kills = 0;
  const listed = () => ++lists <= 8 ? [{ pid: 30, ppid: 1, cmd: 'msedge --type=utility --user-data-dir=C:\\T\\meta-shot-y' }] : [];
  const left = await killProfileProcs('C:/T/meta-shot-y', { list: listed, kill: () => { kills++; }, probe: () => { throw Object.assign(new Error('exited'), { code: 'ESRCH' }); } });
  assert.equal(left, 0, 'it left the list: no survivor');
  assert.ok(lists > 8, `waited until it left the list (${lists} lists)`);
  assert.equal(kills, 0, 'an exited process is not killed again');
});

// META-OOTB-FIX HOME-TEARDOWN (RUN-575 FINDING): a browser process still holding the profile made a bare rmSync throw EPERM in a
// test's finally - the throw replaced the body's result and skipped the fixture's done(), so the test process hung. A holder = a
// process naming the profile on its command line with its cwd inside it (Windows: the dir cannot go while it lives).
// The holder says "ready" from its own code: Node's 'spawn' event fires once CreateProcess returns, BEFORE the Windows child has
// opened its cwd handle (process init), so a bare rmSync right after 'spawn' often won the race and the dir was not held at all
// (CI 43556561887 Windows; a toy: 27/30 bare rmSyncs succeed after 'spawn', 0/30 after the child's first stdout byte).
const holder = dir => { const c = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1e6)', dir], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); c.ready = new Promise((r, j) => { c.stdout.once('data', r); c.once('error', j); }); c.stdout.resume(); return c; };
const exited = c => c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise(r => c.once('exit', r));
test('shot: removeProfile waits for the process holding the profile to exit, then removes it (no EPERM out of the teardown)', async () => {
  const profile = path.join(mkTmp('meta-shot-'), 'prof'); fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'Local State'), '{}');
  const h = holder(profile);
  await h.ready;
  // the test owns its holder: on Linux / macOS a cwd does not block rm, so removeProfile removes the dir at once and never kills
  // the holder - a bare `await exited(h)` then waited on a process that never ends (CI 43518267986: the Linux job hung 1 h here).
  // On Windows the dir cannot go while the holder lives, so "profile removed" below is the proof removeProfile ended it.
  try {
    if (process.platform === 'win32') assert.throws(() => fs.rmSync(profile, { recursive: true, force: true }), e => ['EPERM', 'EBUSY'].includes(e.code), 'the bare rmSync throws while held');
    const r = await removeProfile(profile);
    assert.deepEqual(r, { ok: true, why: null });
    assert.ok(!fs.existsSync(profile), 'profile removed');
  } finally { h.kill('SIGKILL'); await exited(h); }
});
test('shot: closeBrowser never throws - a holder that will not die comes back as { ok: false, why } naming it, for the caller to report after its body', async () => {
  const profile = path.join(mkTmp('meta-shot-'), 'prof'); fs.mkdirSync(profile);
  const h = holder(profile);
  await h.ready;
  try {
    const r = await closeBrowser(null, profile, { list: () => [{ pid: h.pid, ppid: 1, cmd: `node ${profile}` }], kill: () => {} });
    assert.equal(r.ok, process.platform !== 'win32', JSON.stringify(r));
    if (process.platform === 'win32') assert.match(r.why, new RegExp(`1 process\\(es\\) .*${h.pid}`));
  } finally { h.kill('SIGKILL'); await exited(h); }
});


test('waitDevToolsPort: a browser that dies before DevTools comes up - the error names the binary, its exit and the tail of its stderr (kept in the profile)', async () => {
  const profile = mkTmp('meta-shot-');
  const die = `const n = String.fromCharCode(10); process.stderr.write("early noise" + n + "x".repeat(4000) + n + "FATAL: No usable sandbox!" + n); process.exit(3)`;
  const browser = { kind: 'chrome', exe: process.execPath, prefix: ['-e', die, '--'] };
  const child = launchBrowser({ browser, profile, size: [800, 600], platform: process.platform });
  await assert.rejects(waitDevToolsPort({ browser, profile, child }), e => {
    assert.match(e.message, /^no DevTools port/);
    assert.ok(e.message.includes(process.execPath), 'the binary tried');
    assert.match(e.message, /exit 3/);
    assert.match(e.message, /FATAL: No usable sandbox!/);
    assert.ok(!e.message.includes('early noise'), 'only the tail');
    return true;
  });
  assert.match(fs.readFileSync(path.join(profile, 'browser-stderr.log'), 'utf8'), /early noise[\s\S]*No usable sandbox/);
});

test('waitDevToolsPort: a Linux SUID sandbox helper not root/4755 (CI-RED-7D65D2D) - the error names the case and the helper path', async () => {
  const profile = mkTmp('meta-shot-');
  const fixture = path.join(HERE, 'fixtures', 'edge-suid-sandbox-stderr.txt');
  const die = `process.stderr.write(require("fs").readFileSync(${JSON.stringify(fixture)}, "utf8")); process.exit(1)`;
  const browser = { kind: 'edge', exe: process.execPath, prefix: ['-e', die, '--'] };
  const child = launchBrowser({ browser, profile, size: [800, 600], platform: process.platform });
  await assert.rejects(waitDevToolsPort({ browser, profile, child }), e => {
    assert.match(e.message, /^no DevTools port/);
    assert.match(e.message, /SUID sandbox misconfigured: \/opt\/microsoft\/msedge\/msedge-sandbox \(must be owned by root, mode 4755\)/);
    assert.match(e.message, /setuid_sandbox_host\.cc/, 'the stderr tail still follows');
    return true;
  });
});

// CI 43999056272 (ubuntu): the SUID abort above came from a browser that did NOT exit (the crashpad handler / the wrapper script
// lived on), so every browser test waited the whole 30 s for a port that could never come, then (its tree never killed) held its
// file open to the 600 s cap: 14 reds at 30 s and 5 HANG reds. A FATAL line on stderr is the browser's own verdict: fail on it.
test('waitDevToolsPort: a FATAL line on stderr fails at once though the process lives on (no 30 s wait)', async () => {
  const profile = mkTmp('meta-shot-');
  const fixture = path.join(HERE, 'fixtures', 'edge-suid-sandbox-stderr.txt');
  const hang = `process.stderr.write(require("fs").readFileSync(${JSON.stringify(fixture)}, "utf8")); setInterval(() => {}, 1e6)`;
  const browser = { kind: 'edge', exe: process.execPath, prefix: ['-e', hang, '--'] };
  const child = launchBrowser({ browser, profile, size: [800, 600], platform: process.platform });
  try {
    await assert.rejects(waitDevToolsPort({ browser, profile, child }), e => {
      assert.match(e.message, /^no DevTools port/);
      assert.match(e.message, /FATAL on stderr, still running/, 'failed on the FATAL line, not on the 30 s port wait');
      assert.match(e.message, /SUID sandbox misconfigured: \/opt\/microsoft\/msedge\/msedge-sandbox/);
      return true;
    });
    assert.equal(child.exitCode, null, 'the process was still alive when it failed');
  } finally { const gone = new Promise(r => child.once('exit', r)); child.kill('SIGKILL'); await gone; }
});

test('waitDevToolsPort: ERROR lines (crashpad noise every Linux runner prints) are not a failure', async () => {
  const profile = mkTmp('meta-shot-');
  const noise = `const n = String.fromCharCode(10); process.stderr.write("[1117/014440.518755:ERROR:third_party/crashpad/crashpad/util/file/file_io_posix.cc:145] open x" + n);
    setTimeout(() => require("fs").writeFileSync(require("path").join(${JSON.stringify(profile)}, "DevToolsActivePort"), "4321" + n + "/devtools/browser/x"), 300); setTimeout(() => process.exit(0), 600)`;
  const browser = { kind: 'chrome', exe: process.execPath, prefix: ['-e', noise, '--'] };
  const child = launchBrowser({ browser, profile, size: [800, 600], platform: process.platform });
  const gone = new Promise(r => child.once('exit', r));
  assert.equal(await waitDevToolsPort({ browser, profile, child }), 4321);
  await gone;
});
