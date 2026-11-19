// NORN-WATCH S5 (DEC-683): `norn doctor` names processes a finished run left behind - headless browsers and node processes older
// than N hours (default 6) with no live run (its supervisor / executor pid, from the heartbeat files) among their ancestors. A
// node process counts only when its command line names the worktree of an ENDED run (the dash, MCP servers and editors are not
// runs' leftovers). Read-only: it lists, it never kills (the job / process group of S5 prevents new ones).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { boundedSync } from './jobguard.mjs';
import { loadState } from './records.mjs';

export const STRAY_HOURS = 6;
const BROWSER = /^(msedge|chrome|chromium|chromium-browser|google-chrome|firefox|headless_shell)(\.exe)?$/i;
const NODE = /^node(\.exe)?$/i;
const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** every process: [{ pid, ppid, name, created (ms), cmd }]; [] when the listing fails */
export function listProcs({ platform = process.platform } = {}) {
  try {
    if (platform === 'win32') {
      const ps = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; n = $_.Name; c = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }; l = $_.CommandLine } } | ConvertTo-Json -Compress";
      // proc-hygiene: a tree-killing timeout (7 of these were found orphaned, suspended at birth: their caller was killed mid-spawn)
      const r = boundedSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30000, maxBuffer: 64 << 20 });
      if (r.status !== 0) return [];
      return [].concat(JSON.parse(r.stdout || '[]')).map(x => ({ pid: x.p, ppid: x.q, name: x.n || '', created: x.c ? Date.parse(x.c) : null, cmd: x.l || '' }));
    }
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,etimes=,comm=,args='], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 << 20 });
    if (r.status !== 0) return [];
    const now = Date.now();
    return r.stdout.split('\n').map(l => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/)).filter(Boolean)
      .map(m => ({ pid: +m[1], ppid: +m[2], name: path.basename(m[4]), created: now - +m[3] * 1000, cmd: m[5] }));
  } catch { return []; }
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
