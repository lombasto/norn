// META-DASH-LIVE R1: the live dashboard stays on its configured port across merges. `norn dash` records the install's own
// dashboard (local/dash.json: pid, port, root, start); `norn dash restart` stops ONLY that pid, starts it detached on the configured
// port and checks it answers; a taken port is a named error, never a move. MERGE prompts call it; doctor reports it + stray dashes.
// Sandbox only: every dashboard here runs on a sandbox root and a free port - never the live one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { which } from '../engine/lib/paths.mjs';
import { dashFile, readDash, dashRows, isDashCmd } from '../engine/lib/dashlive.mjs';
import { renderMergeBrief, renderBatchBrief } from '../engine/lib/mergebrief.mjs';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';

test.after(cleanTmp);
const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const GIT_DIR = path.dirname(which('git'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const kill = pid => { try { process.kill(pid); } catch { /* gone */ } };

function sandbox(tag) {
  const t = mkTmp('meta-dlive-' + tag + '-');
  const d = { t, root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg') };
  for (const x of [d.root, d.home, d.bin, d.cfg]) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(path.join(d.bin, WIN ? 'claude.exe' : 'claude'), '');
  const env = { ...process.env, PATH: d.bin + path.delimiter + GIT_DIR + path.delimiter + path.dirname(process.execPath), HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming'), META_ROOT: d.root };
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT', 'META_INTERACTIVE']) delete env[k];
  const run = args => new Promise(res => {
    const c = spawn(process.execPath, [META, ...args], { env, windowsHide: true });
    let out = '', err = '';
    c.stdout.on('data', b => { out += b; }); c.stderr.on('data', b => { err += b; });
    c.on('close', code => res({ code, out, err }));
    c.stdin.end();
  });
  const mf = path.join(d.root, 'local', 'machine.json');
  return { ...d, env, run, mf };
}
const freePort = () => new Promise(res => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
async function ready(tag) {
  const sb = sandbox(tag);
  const r = await sb.run(['setup', '--non-interactive', '--no-scheduler']);
  assert.equal(r.code, 0, r.err + r.out);
  const m = JSON.parse(fs.readFileSync(sb.mf, 'utf8')); sb.port = await freePort(); m.dash = { ...m.dash, port: sb.port, bind: '127.0.0.1' };
  fs.writeFileSync(sb.mf, JSON.stringify(m, null, 2));
  return sb;
}
/** a foreground `norn dash` of the sandbox (its line printed = listening) */
function startDash(sb, extra = []) {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, [META, 'dash', '--no-open', ...extra], { env: sb.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => rej(new Error('dash did not start: ' + out)), 20000);
    c.stdout.on('data', b => { out += b; if (/DASH http/.test(out)) { clearTimeout(t); res(c); } });
    c.stderr.on('data', b => { out += b; });
  });
}
const get = url => fetch(url).then(r => r.status, () => 0);
const waitFor = async (f, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

test('norn dash records the install\'s live dashboard in local/dash.json (pid, port, root, start); a --port override is not the live one', async () => {
  const sb = await ready('rec');
  const c = await startDash(sb);
  try {
    const rec = readDash(sb.root);
    assert.equal(path.resolve(dashFile(sb.root)), path.resolve(sb.root, 'local', 'dash.json'));
    assert.equal(rec.pid, c.pid); assert.equal(rec.port, sb.port); assert.equal(path.resolve(rec.root), path.resolve(sb.root));
    assert.ok(!Number.isNaN(Date.parse(rec.started)), rec.started);
  } finally { kill(c.pid); }
  assert.ok(await waitFor(() => !alive(c.pid)));
  const other = await startDash(sb, ['--port', '0']);
  try { assert.notEqual(readDash(sb.root)?.pid, other.pid, 'a dash on another port records nothing'); } finally { kill(other.pid); }
});

test('norn dash restart stops ONLY the recorded pid (a second dash of another root survives), starts it detached on the configured port, it answers', async () => {
  const a = await ready('ra'), b = await ready('rb');
  const old = await startDash(a), stranger = await startDash(b);
  let fresh = null;
  try {
    const r = await a.run(['dash', 'restart']);
    assert.equal(r.code, 0, r.err + r.out);
    assert.ok(await waitFor(() => !alive(old.pid)), 'the recorded dash is stopped');
    assert.ok(alive(stranger.pid), 'the other root\'s dash survives');
    fresh = readDash(a.root);
    assert.ok(fresh && fresh.pid !== old.pid && alive(fresh.pid), JSON.stringify(fresh));
    assert.equal(fresh.port, a.port);
    assert.match(r.out, new RegExp(`pid ${fresh.pid}.*127\\.0\\.0\\.1:${a.port}`));
    assert.equal(await get(`http://127.0.0.1:${a.port}/`), 200);
    assert.equal(await get(`http://127.0.0.1:${b.port}/`), 200);
  } finally { kill(old.pid); kill(stranger.pid); if (fresh) kill(fresh.pid); }
});

// proc-hygiene (7): a dash started by hand from a shell left a blank node.exe console window; --background starts it the way restart
// does (detached, hidden) and leaves a dashboard that already answers alone
test('norn dash --background starts the live dashboard detached; run again it reports the running one and starts nothing', async () => {
  const sb = await ready('bg');
  let pid = null;
  try {
    const r = await sb.run(['dash', '--background']);
    assert.equal(r.code, 0, r.err + r.out);
    pid = readDash(sb.root)?.pid;
    assert.ok(pid && alive(pid), r.out);
    assert.match(r.out, new RegExp(`dash started in the background: pid ${pid} on http://127\\.0\\.0\\.1:${sb.port}/`));
    const again = await sb.run(['dash', '--background']);
    assert.equal(again.code, 0, again.err + again.out);
    assert.match(again.out, new RegExp(`dash running: pid ${pid} .*already up`));
    assert.equal(readDash(sb.root).pid, pid, 'the same dashboard');
  } finally { if (pid) kill(pid); }
});

test('norn dash restart on a port taken by something else = an error naming the holder, never another port', async () => {
  const sb = await ready('busy');
  const s = net.createServer(); await new Promise(r => s.listen(sb.port, '127.0.0.1', r));
  try {
    const r = await sb.run(['dash', 'restart']);
    assert.notEqual(r.code, 0);
    assert.match(r.err, new RegExp(`port ${sb.port}.*taken by pid ${process.pid}\\b`));
    assert.equal(readDash(sb.root), null, 'nothing started elsewhere');
  } finally { s.close(); }
});

test('doctor dashboard rows: running on the configured port / not running / running on another port; stray dashes named with the stop command', () => {
  const procs = [
    { pid: 10, name: 'node.exe', cmd: 'node C:/x/engine/bin/norn.mjs dash --no-open' },
    { pid: 11, name: 'node.exe', cmd: 'node engine/bin/norn.mjs dash --no-open --port 8791' },
    { pid: 12, name: 'node.exe', cmd: '"C:/n/node.exe" "C:/wt/engine/bin/norn.mjs" dash restart' },
    { pid: 13, name: 'node.exe', cmd: 'node C:/x/engine/bin/norn.mjs doctor' },
  ];
  assert.ok(isDashCmd(procs[0].cmd) && isDashCmd(procs[1].cmd) && !isDashCmd(procs[2].cmd) && !isDashCmd(procs[3].cmd));
  const live = new Set([10, 11]);
  let rows = dashRows({ rec: { pid: 10, port: 8737, started: '2026-11-13T10:30:00Z' }, port: 8737, procs, alive: p => live.has(p) });
  assert.match(rows[0], /^ok dashboard: running on the configured port 8737 \(pid 10/);
  assert.equal(rows.length, 2);
  assert.match(rows[1], /^warn stray norn dash pid 11\b.*--port 8791.*taskkill \/PID 11 \/T \/F \| kill 11/);
  rows = dashRows({ rec: { pid: 10, port: 8791 }, port: 8737, procs: procs.slice(0, 1), alive: p => live.has(p) });
  assert.deepEqual(rows.length, 1); assert.match(rows[0], /^warn dashboard: running on port 8791, not the configured 8737 \(pid 10\).*norn dash restart/);
  rows = dashRows({ rec: { pid: 99, port: 8737 }, port: 8737, procs: [], alive: () => false });
  assert.match(rows[0], /^note dashboard: not running \(configured port 8737\).*norn dash restart/);
  assert.match(dashRows({ rec: null, port: 8737, procs: [], alive: () => false })[0], /^note dashboard: not running/);
});

test('norn doctor prints the dashboard row', async () => {
  const sb = await ready('doc');
  const r = await sb.run(['doctor']);
  assert.match(r.out, new RegExp(`^note dashboard: not running \\(configured port ${sb.port}\\)`, 'm'), r.out);
});
