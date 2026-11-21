// git-perf S1: the git-call profile behind NORN_GIT_PROFILE=<file>. Every git child of this process - whichever helper starts it
// (dlvgit makeGit, bounded.mjs boundedSync, a module's own spawnSync) - is counted with its verb, its wall time and its call site (the
// first frame outside the spawn helpers), and at exit one JSON line per process is appended to <file>: child node processes (a
// tick's fill, a supervisor) inherit the variable, so one file holds a whole tick. Off (the default): nothing is
// patched. The patch rebinds node:child_process's exports (syncBuiltinESMExports), so `import { spawnSync }` sees it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HELPERS = /[\\/](gitprof|bounded|dlvgit|gitfacts)\.mjs|node:child_process|node:internal/;
const isGit = f => /(^|[\\/])git(\.exe)?$/i.test(String(f || ''));
// the git verb (args after -C <dir> / -c k=v), and for boundedSync's `jobguard run <ms> <cwd> "<git> args..."` the inner command line
function verbOf(file, args) {
  let a = [...(args || [])];
  if (!isGit(file)) { if (a[0] !== 'run' || !/git(\.exe)?"?\s/i.test(String(a[3] || ''))) return null; a = String(a[3]).replace(/^"[^"]*"|^\S+/, '').trim().split(/\s+/); }
  while (a[0] === '-C' || a[0] === '-c') a = a.slice(2);
  const v = a.filter(x => !/^"?[0-9a-f]{40}/.test(x)).slice(0, 2).join(' ');
  return v.length > 60 ? v.slice(0, 60) : v;
}
function siteOf() {
  const f = String(new Error().stack).split('\n').slice(1).find(l => !HELPERS.test(l));
  const m = f && /([^\\/( ]+\.m?js):(\d+)/.exec(f);
  return m ? `${m[1]}:${m[2]}` : '?';
}

/** start counting when NORN_GIT_PROFILE names a file (idempotent); returns the live tally { calls: [{ verb, site, ms }] } or null */
export function gitProfile(env = process.env) {
  const file = env.NORN_GIT_PROFILE;
  if (!file || globalThis.__nornGitProf) return globalThis.__nornGitProf ?? null;
  const cp = require('node:child_process'), { syncBuiltinESMExports } = require('node:module'), t0 = Date.now();
  const tally = globalThis.__nornGitProf = { calls: [] };
  const note = (file, args, ms) => { const verb = verbOf(file, args); if (verb !== null) tally.calls.push({ verb, site: siteOf(), ms }); };
  for (const k of ['spawnSync', 'execFileSync']) {
    const orig = cp[k];
    cp[k] = function (file, args, ...rest) { const s = Date.now(); try { return orig.call(this, file, args, ...rest); } finally { note(file, Array.isArray(args) ? args : [], Date.now() - s); } };
  }
  for (const k of ['execFile', 'spawn']) {
    const orig = cp[k];
    cp[k] = function (file, args, ...rest) {
      const s = Date.now(), v = Array.isArray(args) ? args : [], site = verbOf(file, v) === null ? null : siteOf(), c = orig.call(this, file, args, ...rest);
      if (site) c.once('exit', () => tally.calls.push({ verb: verbOf(file, v), site, ms: Date.now() - s }));
      return c;
    };
  }
  syncBuiltinESMExports();
  process.once('exit', () => {
    try { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.appendFileSync(file, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2, 5).join(' '), ms: Date.now() - t0, calls: tally.calls }) + '\n'); } catch { /* a profile never fails the command */ }
  });
  return tally;
}
gitProfile();
