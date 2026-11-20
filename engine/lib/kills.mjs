// NORN-KILL-RECEIPTS (DEC-1088): every process Norn terminates leaves a receipt BEFORE the kill. Two game boots of another project died (exit 1, no
// trace) as unrelated Norn runs ended, and nothing could say who killed what: the reap persisted a count, stopOrphans / tick / sweep
// kills nothing at all. One JSON line per target in <state>/kills.jsonl:
//   { at, killer (run id / tick / supervisor pid), reason, action (kill | skipped), why?, pid, image, cmd (first 300 chars), ppid, job? }
// The reap writes its own lines from the native helper (jobguard.cs: read off the very handle it kills); every other kill (killTree:
// the whole tree taskkill /T or the POSIX group walk takes) is receipted here from one process listing - jobguard `procs` when the
// helper is compiled (~0.2 s), else strays.listProcs (PowerShell CIM / ps). A kill with no project state (ci-suite, exit-watch)
// is receipted in the calling run's state (META_RUN_STATE), else <tmp>/norn-kills.jsonl.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { listProcs } from './strays.mjs';
import { jobguardCached } from './jobguard.mjs';

export const killsFile = state => path.join(state, 'kills.jsonl');
const CMD_MAX = 300;
/** the receipts file of a kill context { file?, state? } */
export const receiptsOf = rc => rc?.file || (rc?.state || process.env.META_RUN_STATE ? killsFile(rc?.state || process.env.META_RUN_STATE) : path.join(os.tmpdir(), 'norn-kills.jsonl'));
const killerOf = rc => rc?.killer || `${process.env.META_RUN_ID || 'norn'} pid ${process.pid}`;

const parse = out => String(out || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
/** every process now: [{ pid, ppid, name, cmd }] */
export function procList() {
  const exe = process.platform === 'win32' ? jobguardCached() : null;
  if (exe) { const r = spawnSync(exe, ['procs'], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64 << 20 }); if (r.status === 0) return parse(r.stdout); }
  return listProcs();
}
/** procList off the event loop (killTreeAsync: the dash server) */
export function procListAsync() {
  const exe = process.platform === 'win32' ? jobguardCached() : null;
  if (!exe) return Promise.resolve(listProcs());
  return new Promise(ok => execFile(exe, ['procs'], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64 << 20 }, (e, out) => ok(e ? listProcs() : parse(out))));
}

/** pid and every descendant of it in procs (what taskkill /T and the POSIX group walk end); a pid not listed is still named */
export function treeOf(pid, procs) {
  const byPid = new Map(procs.map(p => [p.pid, p])), kids = new Map();
  for (const p of procs) if (p.pid !== p.ppid) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(p);
  const out = [byPid.get(pid) || { pid, ppid: null, name: '', cmd: '' }], todo = [pid], seen = new Set([pid]);
  while (todo.length) for (const c of kids.get(todo.pop()) || []) if (!seen.has(c.pid)) { seen.add(c.pid); out.push(c); todo.push(c.pid); }
  return out;
}

/** append one receipt per proc row (action kill unless given); throws when the file cannot be written */
export function writeReceipts(rows, rc = {}) {
  if (!rows.length) return rows;
  const at = new Date().toISOString(), file = receiptsOf(rc);
  const text = rows.map(p => JSON.stringify({ at, killer: killerOf(rc), reason: rc.reason || 'unstated', action: p.action || 'kill', ...(p.why ? { why: p.why } : {}),
    pid: p.pid, image: p.name || p.image || '', cmd: String(p.cmd || '').slice(0, CMD_MAX), ppid: Number.isInteger(p.ppid) ? p.ppid : null, ...(rc.job ? { job: rc.job } : {}) }) + '\n').join('');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text);
  return rows;
}

/** the receipts of a tree kill of pid, written before it: the rows named (best effort - a kill the caller depends on, a cap or a hang,
 * is never held back by a receipt that cannot be written) */
export function receiptTree(pid, rc, procs = procList()) {
  const rows = treeOf(pid, procs);
  try { writeReceipts(rows, rc); } catch { /* the kill goes on */ }
  return rows;
}

/** the receipts in a file, oldest first */
export const readKills = file => { try { return parse(fs.readFileSync(file, 'utf8')); } catch { return []; } };
/** "node.exe 1234, python.exe 99": a log line's names of killed processes */
export const killNames = rows => rows.map(r => `${r.image || r.name || '?'} ${r.pid}`).join(', ');
