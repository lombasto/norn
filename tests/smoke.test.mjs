// S8: `norn dash` (server on a chosen / random 127.0.0.1 port) and `norn smoke` (design section 8: clone, setup, example project,
// records vs goldens, fake run handoff -> auto-resume -> done, second writer refused, dry scheduler files, dashboard API).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const META = path.join(REPO, 'engine', 'bin', 'norn.mjs');

function firstLine(child, re, ms = 15000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('no line ' + re + ' in ' + buf)), ms);
    child.stdout.on('data', d => { buf += d; const m = buf.match(re); if (m) { clearTimeout(t); resolve(m); } });
    child.on('exit', c => { clearTimeout(t); reject(new Error(`exited ${c}: ${buf}`)); });
  });
}

test('norn dash serves the registered projects on a random 127.0.0.1 port (--port 0) and prints the URL', async () => {
  const root = mkTmp('meta-dashcli-');
  fs.cpSync(path.join(REPO, 'projects', 'example'), path.join(root, 'projects', 'example'), { recursive: true });
  fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  const fwd = p => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(root, 'local', 'machine.json'), JSON.stringify({ schema: 1, home: fwd(root), node: fwd(process.execPath),
    claude: { exe: fwd(process.execPath), config_dir: fwd(path.join(root, 'cfg')), projects_dir: fwd(path.join(root, 'cfg', 'projects')) }, codex: null, git: { exe: fwd(process.execPath) },
    scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, dash: { port: 8737, bind: '127.0.0.1' },
    projects: [{ name: 'example', config: '${norn}/projects/example/project.json' }] }));
  const c = spawn(process.execPath, [META, 'dash', '--port', '0', '--no-open'], { env: { ...process.env, META_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const m = await firstLine(c, /DASH (http:\/\/127\.0\.0\.1:(\d+)\/)/);
    assert.notEqual(m[2], '8737');
    const r = await fetch(m[1] + 'api/overview?project=example');
    assert.equal(r.status, 200);
    assert.ok(JSON.stringify(await r.json()).includes('example'));
  } finally { c.kill(); }
});

test('norn smoke passes end to end in a temp clone (exit 0, < 60 s)', () => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [META, 'smoke'], { encoding: 'utf8', timeout: 170000 });
  const s = (Date.now() - t0) / 1000;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^SMOKE OK .* s$/m);
  for (const step of ['clone', 'setup', 'records', 'views', 'run', 'auto-resume', 'writer', 'scheduler', 'dashboard']) assert.match(r.stdout, new RegExp(`^ok ${step}\\b`, 'm'));
  assert.ok(s < 60, `smoke took ${s} s`);
});

// META-SMOKE-CLONE R1: the clone takes only what smoke needs - a shallow pack transfer over file:// (only HEAD's objects, never
// hardlinks, so B-1 still holds) instead of --no-hardlinks copying the whole, ever-growing object store.
test('smoke cloneCommitted: shallow file:// clone (--depth 1, no --local / hardlinks) holding exactly one commit', async () => {
  const { cloneCommitted, cloneArgs } = await import('../engine/lib/smoke.mjs');
  const src = path.join(mkTmp('meta-shallow-src-'), 'repo'), dst = path.join(mkTmp('meta-shallow-dst-'), 'meta');
  const a = cloneArgs(src, dst);
  assert.equal(a[0], 'clone');
  assert.deepEqual(a.slice(a.indexOf('--depth'), a.indexOf('--depth') + 2), ['--depth', '1']);
  assert.ok(!a.includes('--local') && !a.includes('-l'), 'no --local');
  assert.match(a.at(-2), /^file:\/\//, 'source given as a file:// URL (a pack transfer, not a local copy)');
  assert.equal(a.at(-1), dst);
  const git = (cwd, ...x) => spawnSync('git', x, { cwd, encoding: 'utf8' });
  fs.mkdirSync(src, { recursive: true });
  git(src, 'init', '-q');
  for (const n of ['1', '2', '3']) {
    fs.writeFileSync(path.join(src, 'a.txt'), n + '\n'); git(src, 'add', 'a.txt');
    assert.equal(git(src, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'c' + n).status, 0);
  }
  cloneCommitted(src, dst);
  assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), '3\n');
  assert.equal(git(dst, 'rev-list', '--count', 'HEAD').stdout.trim(), '1', 'one commit');
  assert.equal(git(dst, 'rev-parse', '--is-shallow-repository').stdout.trim(), 'true');
});

// OOTB-R2 B-1: the smoke's clone must work when the clone and the temp dir are on different filesystems (git clone --local
// dies with "failed to create link" / "Invalid cross-device link"). Made real: a repo in the temp dir cloned onto another
// device (a second Windows drive, or /dev/shm when it is its own filesystem); skipped only where no second device exists.
function otherDevice(from) {
  const dev = p => { try { return fs.statSync(p).dev; } catch { return null; } };
  const d0 = dev(from);
  const cands = process.platform === 'win32' ? 'DEFGHIJKLMNOPQRSTUVWXYZC'.split('').map(l => l + ':' + path.sep) : ['/dev/shm', '/run/user/' + (process.getuid?.() ?? 0)];
  for (const c of cands) {
    if (path.parse(path.resolve(from)).root.toUpperCase() === c.toUpperCase()) continue;
    const d = dev(c);
    if (d == null || d === d0) continue;
    try { const t = fs.mkdtempSync(path.join(c, 'meta-xdev-')); return t; } catch {}
  }
  return null;
}

test('smoke cloneCommitted copies across filesystems (no hardlinks; OOTB-R2 B-1)', async t => {
  const { cloneCommitted } = await import('../engine/lib/smoke.mjs');
  const src = path.join(mkTmp('meta-xdev-src-'), 'repo');
  const git = (...a) => spawnSync('git', a, { cwd: src, encoding: 'utf8' });
  fs.mkdirSync(src, { recursive: true });
  git('init', '-q'); fs.writeFileSync(path.join(src, 'a.txt'), 'a\n'); git('add', 'a.txt');
  assert.equal(git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '-m', 'x').status, 0);
  const far = otherDevice(src);
  if (!far) { t.skip('no second filesystem on this machine'); return; }
  try {
    const dst = path.join(far, 'meta');
    cloneCommitted(src, dst);
    assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'a\n');
  } finally { fs.rmSync(far, { recursive: true, force: true }); }
});
