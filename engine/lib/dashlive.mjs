// META-DASH-LIVE R1: the install's live dashboard. `norn dash` on the configured port writes local/dash.json (pid, port, bind, root,
// started) under ITS install root; `norn dash restart` stops ONLY that recorded pid (never a dashboard of another root, worktree or
// scratch state), starts it detached (hidden on Windows, its own session elsewhere) on the configured port and checks it answers. A
// port held by anything else is an error naming the holder - never a silent move to another port. `norn doctor` reads the same file.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listProcs } from './strays.mjs';
import { writeReceipts } from './kills.mjs';

const META_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'norn.mjs');
const fwd = p => String(p).replace(/\\/g, '/');
export class DashError extends Error {}

export const dashFile = root => path.join(root, 'local', 'dash.json');
export function readDash(root) {
  try { const r = JSON.parse(fs.readFileSync(dashFile(root), 'utf8')); return Number.isInteger(r?.pid) ? r : null; } catch { return null; }
}
export function writeDash(root, rec) {
  fs.mkdirSync(path.dirname(dashFile(root)), { recursive: true });
  const tmp = dashFile(root) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  fs.renameSync(tmp, dashFile(root));
}
/** removes the record only while it still names pid (a newer dashboard's record stays) */
export function clearDash(root, pid) { if (readDash(root)?.pid === pid) try { fs.rmSync(dashFile(root), { force: true }); } catch { /* best effort */ } }

export const pidAlive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** a `norn dash` server command line (not `norn dash restart`, not another verb) */
export const isDashCmd = cmd => /(?:meta|norn)\.mjs["']?\s+dash(?!\s+restart\b)(\s|$)/i.test(String(cmd || ''));

/** the process listening on a TCP port: { pid, name, cmd } | null (unknown) */
export function portHolder(port, { platform = process.platform, procs = listProcs } = {}) {
  let pids = [];
  try {
    if (platform === 'win32') {
      const r = spawnSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'NETSTAT.EXE'), ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      for (const l of (r.stdout || '').split(/\r?\n/)) {
        const m = l.trim().split(/\s+/);
        if (m[0] === 'TCP' && /LISTEN/i.test(m[3] || '') && m[1]?.endsWith(':' + port)) pids.push(Number(m[4]));
      }
    } else {
      const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 15000 });
      pids = (r.stdout || '').split(/\s+/).filter(Boolean).map(Number);
    }
  } catch { /* no tool */ }
  const pid = pids.find(Number.isInteger);
  if (!pid) return null;
  const p = procs().find(x => x.pid === pid);
  return { pid, name: p?.name || '?', cmd: p?.cmd || '' };
}

export const portFree = (port, bind) => new Promise(res => {
  const s = net.createServer();
  s.once('error', () => res(false));
  s.listen(port, bind, () => s.close(() => res(true)));
});
const answers = url => fetch(url, { signal: AbortSignal.timeout(2000) }).then(r => r.status < 500, () => false);
const until = async (f, ms) => { const end = Date.now() + ms; for (;;) { if (await f()) return true; if (Date.now() > end) return false; await new Promise(r => setTimeout(r, 150)); } };

/**
 * o: { root, port, bind, env, procs (listProcs), holder (portHolder), timeoutMs, keep }. Resolves { pid, url, stopped (old pid | null),
 * running (keep: the recorded dashboard answered, nothing started) }; throws DashError (the port taken by another process, the new
 * dashboard not answering). keep = `norn dash --background` (proc-hygiene 7): a dashboard started from a shell opens no console window.
 */
export async function dashRestart({ root, port, bind = '127.0.0.1', env = process.env, procs = listProcs, holder = portHolder, timeoutMs = 30000, keep = false }) {
  const rec = readDash(root);
  if (keep && rec && pidAlive(rec.pid) && rec.port === port && await answers(`http://${bind}:${port}/`)) return { pid: rec.pid, url: `http://${bind}:${port}/`, stopped: null, running: true };
  let stopped = null;
  if (rec && pidAlive(rec.pid)) {
    const list = procs();
    const p = list.find(x => x.pid === rec.pid);
    // pid reuse guard: the recorded pid is stopped only while it still is a `norn dash` (a failed listing trusts the record)
    if (!list.length || (p && isDashCmd(p.cmd))) {
      try { writeReceipts([p || { pid: rec.pid }], { killer: `norn dash restart pid ${process.pid}`, reason: `restart: the recorded dashboard of ${root}` }); } catch { /* the restart goes on */ }   // DEC-1088
      try { process.kill(rec.pid); } catch { /* gone meanwhile */ }
      if (!await until(() => !pidAlive(rec.pid), 10000)) throw new DashError(`the recorded dashboard pid ${rec.pid} did not stop`);
      stopped = rec.pid;
    }
  }
  if (rec) clearDash(root, rec.pid);
  // the port frees a moment after the process is gone (Windows)
  if (!await until(() => portFree(port, bind), stopped ? 5000 : 0)) {
    const h = holder(port);
    throw new DashError(`port ${port} (${bind}) is taken by ${h ? `pid ${h.pid} ${h.name}${h.cmd ? ` (${h.cmd.trim()})` : ''}` : 'an unknown process'}`
      + ' - not this install\'s recorded dashboard; stop it or change dash.port in local/machine.json (never moved to another port)');
  }
  const log = path.join(root, 'local', 'dash.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  const c = spawn(process.execPath, [META_BIN, 'dash', '--no-open'], { env: { ...env, META_ROOT: fwd(root) }, cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  c.on('error', () => {});
  c.unref(); fs.closeSync(fd);
  const url = `http://${bind}:${port}/`;
  const up = await until(async () => readDash(root)?.pid === c.pid && await answers(url), timeoutMs);
  if (!up) throw new DashError(`the dashboard (pid ${c.pid}) does not answer on ${url} after ${Math.round(timeoutMs / 1000)} s - see ${fwd(log)}`);
  return { pid: c.pid, url, stopped };
}

/** doctor rows: the live dashboard (from the record) + every other `norn dash` process (a stray of another root / worktree / scratch) */
export function dashRows({ rec, port, procs = [], alive = pidAlive }) {
  const live = rec && alive(rec.pid) ? rec : null;
  const rows = [!live ? `note dashboard: not running (configured port ${port}) - start it: norn dash restart`
    : live.port === port ? `ok dashboard: running on the configured port ${port} (pid ${live.pid}${live.started ? ', since ' + live.started : ''})`
      : `warn dashboard: running on port ${live.port}, not the configured ${port} (pid ${live.pid}) - move it: norn dash restart`];
  for (const p of procs) {
    if (!isDashCmd(p.cmd) || p.pid === live?.pid || p.pid === process.pid) continue;
    rows.push(`warn stray norn dash pid ${p.pid}: ${String(p.cmd).trim()} - not this install's live dashboard (another root, worktree or scratch copy); stop it: taskkill /PID ${p.pid} /T /F | kill ${p.pid}`);
  }
  return rows;
}
