// task-NORN-TEST-RECORD (DEC-a-658): the read recorder `norn tests run` loads into a test process and its node children (NODE_OPTIONS
// --import, testcache.mjs runCached). A test's cache key holds its file and the modules it reaches, not the data files engine code reads
// for it (a preset, a schema, a prompt); this records them, so a pass is reused only while none of them changed.
//   env      NORN_READREC_DIR (the folder the records go to; without it this does nothing), NORN_READREC_ROOT (the repo root)
//   wraps    fs's calls that read a file or list a folder (and fs.promises'), then syncBuiltinESMExports so named imports see them; a
//            wrapper keeps its name and passes arguments, `this` and the result through. An open counts only with read flags.
//   record   <DIR>/<pid>-<random>.txt, one line per NEW path: `F\t<abs>` a file read (or tried: a missing one counts), `D\t<abs>` a
//            folder listed. One descriptor, written with writeSync: a child that is killed keeps what it read until then (no exit
//            handler). The file is made at load, empty while nothing is read: no file at all = the recorder did not load.
//   skips    anything outside ROOT (win32: without case) or ROOT itself, .git/, node_modules/ at any depth, the top-level state/, a path
//            it cannot name (a file descriptor, a bad URL). It never throws into its host.
// Only node: builtins: every node child of a test loads it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const DIR = process.env.NORN_READREC_DIR, ROOT = process.env.NORN_READREC_ROOT;
if (DIR && ROOT) { try { start(path.resolve(ROOT)); } catch { /* never into the host: an unrecorded process is a pass without reads */ } }

function start(root) {
  const { openSync, writeSync, readdirSync, statSync } = fs, win = process.platform === 'win32';
  const fd = openSync(path.join(DIR, `${process.pid}-${Math.random().toString(36).slice(2, 10)}.txt`), 'a'), seen = new Set();
  const lc = s => (win ? s.toLowerCase() : s);
  /** the absolute path under root of a path argument, else null (a descriptor, a FileHandle, a bad URL, outside, skipped) */
  const inRepo = p => {
    const s = typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? fileURLToPath(p) : null;
    if (!s) return null;
    const abs = path.resolve(s), rel = path.relative(root, abs);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    const segs = rel.split(path.sep).map(lc);
    return segs[0] === 'state' || segs.some(x => x === '.git' || x === 'node_modules') ? null : abs;
  };
  const note = (kind, p) => {
    try {
      const abs = inRepo(p), k = abs && `${kind}\t${abs}`;
      if (!k || seen.has(lc(k))) return;
      seen.add(lc(k)); writeSync(fd, `${k}\n`);
    } catch { /* unnamed path: skipped */ }
  };
  const W = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
  const reads = flags => flags == null || typeof flags === 'function' || (typeof flags === 'string' ? flags.startsWith('r') : typeof flags === 'number' && !(flags & W));
  const noteOpen = (p, flags) => { if (reads(flags)) note('F', p); };
  /** a copy's source: a file, or a folder tree (every folder listed, every file read) */
  const noteTree = p => {
    try {
      const abs = inRepo(p);
      if (!abs) return;
      if (!statSync(abs).isDirectory()) return note('F', abs);
      const go = d => { note('D', d); for (const e of readdirSync(d, { withFileTypes: true })) { const x = path.join(d, e.name); if (!inRepo(x)) continue; if (e.isDirectory()) go(x); else note('F', x); } };
      go(abs);
    } catch { note('F', p); /* gone: a missing file */ }
  };
  const wrap = (obj, name, take) => {
    const orig = obj?.[name];
    if (typeof orig !== 'function') return;
    const w = function (...a) { take(a); return orig.apply(this, a); };
    Object.defineProperty(w, 'name', { value: orig.name }); Object.defineProperty(w, 'length', { value: orig.length });
    try { obj[name] = w; } catch { /* read-only: left as it was */ }
  };
  const file = a => note('F', a[0]), dir = a => note('D', a[0]), open = a => noteOpen(a[0], a[1]), src = a => noteTree(a[0]);
  const stream = a => { const o = a[1]; if (o && typeof o === 'object' && o.fd != null) return; noteOpen(a[0], o && typeof o === 'object' ? o.flags : undefined); };
  for (const [n, t] of [['readFileSync', file], ['readFile', file], ['openSync', open], ['open', open], ['createReadStream', stream], ['readdirSync', dir], ['readdir', dir],
    ['opendirSync', dir], ['opendir', dir], ['copyFileSync', src], ['copyFile', src], ['cpSync', src], ['cp', src]]) wrap(fs, n, t);
  for (const [n, t] of [['readFile', file], ['open', open], ['readdir', dir], ['opendir', dir], ['copyFile', src], ['cp', src]]) wrap(fs.promises, n, t);
  syncBuiltinESMExports();
}
