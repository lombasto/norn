// NORN-WATCH S5 (DEC-683): `norn doctor` names processes a finished run left behind - headless browsers and node processes older
// than N hours (default 6) with no live run (its supervisor / executor pid, from the heartbeat files) among their ancestors. A
// node process counts only when its command line names the worktree of an ENDED run (the dash, MCP servers and editors are not
// runs' leftovers). Read-only: it lists, it never kills (the job / process group of S5 prevents new ones).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { boundedSync } from './bounded.mjs';
import { loadState } from './records.mjs';

export const STRAY_HOURS = 6;
const BROWSER = /^(msedge|chrome|chromium|chromium-browser|google-chrome|firefox|headless_shell)(\.exe)?$/i;
const NODE = /^node(\.exe)?$/i;
const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** a POSIX process's image name from ps's comm. Linux: comm is the main THREAD's name, and Node 24 names it 'MainThread' (CI 44672523595
 * kill-receipts) - the image is /proc/<pid>/exe where it is readable (our own processes), else comm (another user's; macOS: no /proc,
 * its comm is the image) */
export function imageOf(pid, comm) {
  try { return path.basename(fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')); } catch { return path.basename(comm); }
}

// the listing command and its parse, shared by the sync form (norn doctor, ci-suite) and the async one (the dash: never blocks a request)
const PS_LIST = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; n = $_.Name; c = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }; l = $_.CommandLine; t = $_.ThreadCount; u = [double]$_.UserModeTime + [double]$_.KernelModeTime } } | ConvertTo-Json -Compress";
const listCmd = platform => platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST]] : ['ps', ['-eo', 'pid=,ppid=,etimes=,comm=,args=']];
const parseProcs = (platform, out) => {
  if (platform === 'win32') return [].concat(JSON.parse(out || '[]')).map(x => ({ pid: x.p, ppid: x.q, name: x.n || '', created: x.c ? Date.parse(x.c) : null, cmd: x.l || '', threads: x.t ?? null, cpu: x.u ?? null }));
  const now = Date.now();
  return String(out).split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)).filter(Boolean)
    .map(m => ({ pid: +m[1], ppid: +m[2], name: imageOf(m[1], m[4]), created: now - +m[3] * 1000, cmd: m[5] }));
};
/** every process: [{ pid, ppid, name, created (ms), cmd }]; [] when the listing fails */
export function listProcs({ platform = process.platform } = {}) {
  try {
    // proc-hygiene: on Windows a tree-killing timeout (7 of these were found orphaned, suspended at birth: their caller was killed mid-spawn)
    const [cmd, args] = listCmd(platform), r = platform === 'win32' ? boundedSync(cmd, args, { timeout: 30000, maxBuffer: 64 << 20 })
      : spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 << 20 });
    return r.status !== 0 ? [] : parseProcs(platform, r.stdout);
  } catch { return []; }
}
/** listProcs without blocking the thread: resolves the same rows; [] when the listing fails */
export function listProcsAsync({ platform = process.platform } = {}) {
  const [cmd, args] = listCmd(platform);
  return new Promise(res => { try { execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 << 20 }, (e, out) => { try { res(e ? [] : parseProcs(platform, out)); } catch { res([]); } }); } catch { res([]); } });
}

/** live run pids + ended runs' worktrees of the given state dirs */
export function runFacts(stateDirs) {
  const live = new Set(), ended = [];
  for (const s of stateDirs) {
    try {
      for (const f of fs.readdirSync(path.join(s, 'hb'))) {
        try { const h = JSON.parse(fs.readFileSync(path.join(s, 'hb', f), 'utf8')); for (const p of [h.pid, h.supervisor_pid]) if (Number.isInteger(p)) live.add(p); } catch { /* torn */ }
      }
    } catch { /* no hb dir */ }
    try {
      const runs = Object.values(loadState(s).items).filter(i => i.kind === 'run');
      const busy = new Set(runs.filter(r => r.state === 'running').map(r => norm(r.data.worktree)));
      for (const r of runs) if (r.data.worktree && !['running', 'queued'].includes(r.state) && !busy.has(norm(r.data.worktree))) ended.push({ run: r.id, worktree: norm(r.data.worktree), ts: r.updated || r.created });
    } catch { /* unreadable state */ }
  }
  return { live, ended };
}

/** the strays: [{ pid, name, hours, kind: browser|node, run (the ended run it names, or null) }] */
export function strays(procs, { live = new Set(), ended = [], now = Date.now(), hours = STRAY_HOURS, self = process.pid } = {}) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const underLive = p => {
    for (let x = p, n = 0; x && n < 64; x = byPid.get(x.ppid), n++) { if (live.has(x.pid) || x.pid === self) return true; if (x.ppid === x.pid) break; }
    return false;
  };
  const out = [];
  for (const p of procs) {
    if (!p.created || now - p.created < hours * 3600e3) continue;
    const browser = BROWSER.test(p.name) && /--headless/.test(p.cmd);
    const cmd = norm(p.cmd);
    const inWt = w => { const i = cmd.indexOf(w); return i >= 0 && !/[a-z0-9_.-]/.test(cmd[i + w.length] || ''); };   // a path boundary, not a prefix
    const named = ended.filter(e => e.worktree && inWt(e.worktree)).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0] || null;
    if (!browser && !(NODE.test(p.name) && named)) continue;
    if (underLive(p)) continue;
    out.push({ pid: p.pid, name: p.name, hours: +((now - p.created) / 3600e3).toFixed(1), kind: browser ? 'browser' : 'node', run: named?.run ?? null });
  }
  return out;
}

export const strayLine = s => `stray ${s.kind} pid ${s.pid} ${s.name} ${s.hours} h old, no live run${s.run ? ` (worktree of ended ${s.run})` : ''}: stop it (taskkill /PID ${s.pid} /T /F | kill ${s.pid})`;

// proc-hygiene (5, census 2026-11-19): the families workers and Norn left behind, under the evidence rules of the tick's sweep
// (fair-slots 5c): the parent is gone (a pid reused by a younger process counts as gone), no live run is above it, and it is older
// than DERELICT_HOURS. Each hit carries its evidence, for the sweep's kill record and doctor's line. Read-only: it lists.
export const DERELICT_HOURS = 2;
const FAMILIES = [
  ['watcher', p => /^tail(\.exe)?$/i.test(p.name) && /\s(-f|-F|--follow)\b/.test(p.cmd)],   // a worker's `tail -f <log> | grep` (Monitor, until loops)
  ['watcher', p => /^grep(\.exe)?$/i.test(p.name) && /--line-buffered/.test(p.cmd)],
  ['kill-helper', p => /^getprocaddr(32|64)(\.exe)?$/i.test(p.name)],   // Git for Windows' kill helper, left suspended by a killed bash
  ['shell', p => /^bash(\.exe)?$/i.test(p.name) && /shell-snapshots/.test(p.cmd)],   // a Claude Code Bash tool shell
  ['git', p => /^git(\.exe)?$/i.test(p.name)],
  ['process-scan', p => /^powershell(\.exe)?$/i.test(p.name) && /Get-CimInstance Win32_Process/i.test(p.cmd)],   // Norn's own listProcs
  ['mail-hook', p => NODE.test(p.name) && /(?:meta|norn)\.mjs"?\s+mail check --inject/.test(p.cmd)],
];
/** derelicts of FAMILIES: [{ pid, name, kind, hours, evidence }] */
export function derelicts(procs, { live = new Set(), now = Date.now(), hours = DERELICT_HOURS, self = process.pid } = {}) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const parentOf = p => { const q = byPid.get(p.ppid); return q && q.pid !== p.pid && !(q.created && p.created && q.created > p.created) ? q : null; };
  const underLive = p => { for (let x = p, n = 0; x && n < 64; x = parentOf(x), n++) if (live.has(x.pid) || x.pid === self) return true; return false; };
  const out = [];
  for (const p of procs) {
    const kind = FAMILIES.find(([, f]) => f(p))?.[0];
    if (!kind || !p.created || now - p.created < hours * 3600e3 || parentOf(p) || underLive(p)) continue;
    const unborn = p.threads === 1 && p.cpu === 0;   // never ran: created suspended, its parent killed before the resume
    out.push({ pid: p.pid, name: p.name, kind, hours: +((now - p.created) / 3600e3).toFixed(1),
      evidence: `parent ${p.ppid} gone, no live run above it, ${((now - p.created) / 3600e3).toFixed(1)} h old${unborn ? ', suspended at birth (1 thread, no CPU)' : ''}` });
  }
  return out;
}
export const derelictLine = d => `derelict ${d.kind} pid ${d.pid} ${d.name}: ${d.evidence}: stop it (taskkill /PID ${d.pid} /T /F | kill ${d.pid})`;
