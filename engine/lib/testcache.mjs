// test-diet S1 item 2 (owner 2026-11-21): no duplicate runs of the same test on one machine. On 2026-11-20 five concurrent UI lanes ran
// overlapping test files at once on one CPU, each paying its own process starts and browser launches. `norn tests run` runs every node
// test file of a run through this cache:
//   key      (test file, sha256 of the file + every module it reaches - relative imports, transitively; a script it names (`'norn.mjs'`,
//            a unique engine/ or tests/helpers basename: a test that spawns the CLI depends on all of it); a tests/fixtures/<dir> it names;
//            every repo file its `// reads:` header matches (DEC-a-648: the non-JS files it reads - a workflow, a doc - path + content,
//            a gone one as missing; a glob matches the files git lists as listed, vendored ones too, never the top-level state/: readsFiles) -
//            the node version, `extra`: the browser mode and extra node flags). keyOf. It holds no data file engine code reads for the
//            test (a preset, a schema, a prompt): the result's `reads` does (DEC-a-658).
//   result   <dir>/<key>.json { ok, ms, at, run, file, counts, cases, reads }: a PASS younger than a day is reused - the file does not run
//            again - while every entry of its `reads` still has its hash: { files, dirs } (repo path -> hash), the repo files read and
//            folders listed by the test process and its node children (readrec.mjs, loaded through the child env's NODE_OPTIONS), less
//            what the key holds, a file git does not list and .git/, node_modules/, the top-level state/. A pass without `reads` (the
//            recorder did not load) is not reused. A fail is never reused (a load red gets its one rerun, docs/TESTING.md).
//   running  <dir>/<key>.lock { pid, started, run, file, at } while a run has it going: a second run on the same key waits for its
//            result instead of starting a second copy (a dead or reused pid = stale, gatelock.mjs holderGone; waiting is bounded).
//   log      <dir>/log.jsonl, one row per file a run asked for { at, run, file, key, how: ran | reused | waited, ok, ms (this run's
//            wall time on it), saved_ms (what a reuse or wait spared it), by (the run whose result it took) }: the Tests tab's Run time.
//   cases    <dir>/cases.jsonl, one row per test case of a file that ran here { at, run, state (the run's state folder name | null), file,
//            id (<file>::<title path>), ms, ok }: the Tests tab's per-test times (SPEC dash-owner-1123 s.1.1). The child's second
//            reporter (casereport.mjs) writes them; its arguments live in runNode, outside the key. A reused or waited file adds none.
// <dir> is machine-wide: <the state root>/testcache, beside the gate lock (every project and run of the machine shares it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { importsOf, suiteEnv, readsOf, readsMatch } from './cisuite.mjs';
import { boundedSync } from './bounded.mjs';
import { holderGone } from './gatelock.mjs';
import { metaRoot, fwd } from './config.mjs';
import { testCounts } from './progress.mjs';
import { readText, readJsonS as readJson } from './fsnap.mjs';

export const RESULT_TTL_MS = 24 * 3600e3, LOG_DAYS = 7, WAIT_POLL_MS = 1000, FILE_CAP_MS = 600e3;
/** the cache folder of a project state dir (<state root>/testcache), and of the calling process (its run's state, else META_ROOT's) */
export const cacheDirOf = state => path.join(path.dirname(path.resolve(state)), 'testcache');
export const cacheDir = (env = process.env) => (env.META_RUN_STATE ? cacheDirOf(env.META_RUN_STATE) : path.join(metaRoot(env), 'state', 'testcache'));
export const logFile = dir => path.join(dir, 'log.jsonl'), casesFile = dir => path.join(dir, 'cases.jsonl');
const CASE_REPORTER = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'casereport.mjs')).href;
const READREC = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'readrec.mjs')).href;   // percent-encoded: a space holds in NODE_OPTIONS

// ---------- the key ----------
// a walk never enters these; nor the repo's top state/ (every lane's worktree: whole copies of the repo), which a reads glob must not see
const SKIP = new Set(['node_modules', 'vendor', 'target', '.git']);
const skipped = rel => { const p = rel.split('/'); return p[0] === 'state' || p.some(s => SKIP.has(s)); };
function walk(root, rel, out) {
  let es; try { es = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of es) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) { if (!skipped(r)) walk(root, r, out); } else out.push(r); }
  return out;
}
/** every file of the repo a reads glob may match: the files git lists (tracked, plus untracked and not ignored) as listed - a tracked
 *  vendor/ file too (engine/dash/vendor/: lint and layout read every tracked file) - but the top-level state/; in a folder that is no
 *  git repo (the tests' temp repos) a walk, which skips state/, node_modules, vendor, target and .git */
function repoFiles(root) {
  const r = boundedSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { timeout: 60000 });   // windowsHide: boundedSync sets it
  const listed = !r.error && r.status === 0 ? String(r.stdout).split('\0').filter(Boolean).map(fwd).filter(f => !f.startsWith('state/')) : walk(root, '', []).filter(f => !skipped(f));
  return [...new Set(listed)].sort();
}
/** the files a test can reach in a repo: o.read(rel) -> text | null (cached per call of keyOf's caller), the module index by basename,
 *  o.files() -> the repo's files (repoFiles, listed once per index: only a reads header asks for it) */
export function repoIndex(root) {
  const mods = new Map();
  for (const f of [...walk(root, 'engine', []), ...walk(root, 'tests/helpers', [])].filter(f => /\.[cm]?js$/.test(f))) { const b = f.split('/').pop(); mods.set(b, mods.has(b) ? null : f); }
  const text = new Map();
  let files = null;
  return { root, mods, files: () => (files ??= repoFiles(root)),
    read: rel => { if (!text.has(rel)) { let t = null; try { t = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { /* gone: hashed as missing */ } text.set(rel, t); } return text.get(rel); } };
}
/** the repo files test file `file` declares in its `// reads:` header (cisuite readsOf), sorted: a glob without a wildcard is its path
 *  (hashed as missing when gone), a glob is matched against ix.files() */
export function readsFiles(file, ix) {
  const globs = readsOf(ix.read(fwd(file)));
  if (!globs.length) return [];
  const lit = globs.filter(g => !/[*?]/.test(g)), wild = globs.filter(g => /[*?]/.test(g));
  return [...new Set([...lit, ...(wild.length ? ix.files().filter(f => readsMatch(wild, f)) : [])])].sort();
}
const SCRIPT = /['"`]([\w.-]+\.mjs)['"`]/g, FIXTURE = /fixtures\/([\w.-]+)/g;
/** the files `file` (repo-relative) depends on, itself included, sorted: imports, named scripts and fixtures, transitively */
export function depsOf(file, ix) {
  const seen = new Set(), todo = [fwd(file)];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const t = /\.[cm]?js$/.test(f) ? ix.read(f) : null;
    if (t === null) continue;
    todo.push(...importsOf(f, t));
    for (const m of t.matchAll(SCRIPT)) { const g = ix.mods.get(m[1]); if (g) todo.push(g); }
    if (f.startsWith('tests/')) for (const m of t.matchAll(FIXTURE)) for (const x of walk(ix.root, `tests/fixtures/${m[1]}`, [])) seen.add(x);
  }
  return [...seen].sort();
}
/** the cache key of test file `file` in repo index ix: { key, deps (count), reads (count: the files its reads header matches) } */
export function keyOf(file, ix, extra = '') {
  const deps = depsOf(file, ix), reads = readsFiles(file, ix), h = crypto.createHash('sha256');
  for (const f of deps) h.update(`${f}\0${ix.read(f) ?? '<missing>'}\0`);
  for (const f of reads) h.update(`reads\0${f}\0${ix.read(f) ?? '<missing>'}\0`);
  h.update(`${process.version}\0${extra}`);
  return { key: h.digest('hex').slice(0, 40), deps: deps.length, reads: reads.length };
}

// ---------- the recorded reads (readrec.mjs) ----------
const lcase = process.platform === 'win32' ? s => s.toLowerCase() : s => s, short = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const views = new WeakMap(), hashes = new WeakMap();
/** ix.files() seen as git does: lcase(path) -> git's spelling of each listed file and of each folder above one, a folder's direct children */
function viewOf(ix) {
  let v = views.get(ix);
  if (v) return v;
  v = { files: new Map(), dirs: new Map(), kids: new Map() };
  for (const f of ix.files()) {
    v.files.set(lcase(f), f);
    const p = f.split('/');
    for (let i = 1; i < p.length; i++) { const d = p.slice(0, i).join('/'), k = lcase(d); v.dirs.set(k, v.dirs.get(k) ?? d); if (!v.kids.has(k)) v.kids.set(k, new Set()); v.kids.get(k).add(p[i]); }
  }
  views.set(ix, v);
  return v;
}
/** the hash of a recorded path now, cached per index (one reuse check reads each file once): a file git lists -> sha256 of its bytes,
 *  a folder -> the hash of the sorted names of its direct children git lists; else <missing> (an unlisted file counts as not there) */
function readHash(ix, kind, rel) {
  let m = hashes.get(ix);
  if (!m) hashes.set(ix, m = new Map());
  const k = `${kind}\0${lcase(rel)}`;
  if (!m.has(k)) {
    const v = viewOf(ix), f = kind === 'F' && v.files.get(lcase(rel)), kids = kind === 'D' && v.kids.get(lcase(rel));
    let h = '<missing>';
    if (f) { try { h = short(fs.readFileSync(path.join(ix.root, f))); } catch { /* listed by git, gone from disk */ } }
    if (kids?.size) h = short([...kids].sort().join('\n'));
    m.set(k, h);
  }
  return m.get(k);
}
const sortKeys = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
/** the record files of one run of test file f -> { files, dirs } (repo path -> hash), or null when there is none (the recorder did not
 *  load). Left out: a path the key holds (depsOf, readsFiles), an existing file git does not list (ignored, machine-local) */
function foldReads(recDir, f, ix) {
  let names = [];
  try { names = fs.readdirSync(recDir).filter(n => n.endsWith('.txt')); } catch { /* no folder: no record */ }
  if (!names.length) return null;
  const known = new Set([...depsOf(f, ix), ...readsFiles(f, ix)].map(lcase)), v = viewOf(ix), files = {}, dirs = {};
  for (const n of names) for (const l of String(readText(path.join(recDir, n)) ?? '').split('\n')) {
    const m = /^([FD])\t(.+)$/.exec(l.trimEnd());
    const rel = m && fwd(path.relative(ix.root, m[2]));
    if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) continue;
    if (m[1] === 'D') { const d = v.dirs.get(lcase(rel)) ?? rel; dirs[d] = readHash(ix, 'D', d); continue; }
    if (known.has(lcase(rel))) continue;
    const g = v.files.get(lcase(rel));
    if (g) files[g] = readHash(ix, 'F', g);
    else if (!fs.existsSync(path.join(ix.root, rel))) files[rel] = '<missing>';
  }
  return { files: sortKeys(files), dirs: sortKeys(dirs) };
}
/** the recorded paths of a pass that changed since, in order; null when it has no record (the old shape: not reusable) */
function changedReads(hit, ix) {
  if (!hit.reads) return null;
  return [...Object.entries(hit.reads.files ?? {}).filter(([p, h]) => readHash(ix, 'F', p) !== h), ...Object.entries(hit.reads.dirs ?? {}).filter(([p, h]) => readHash(ix, 'D', p) !== h)].map(([p]) => p);
}
/** NODE_OPTIONS with the recorder's --import appended once */
const withRecorder = opts => (String(opts ?? '').includes(READREC) ? opts : `${opts ? `${opts} ` : ''}--import ${READREC}`);

// ---------- results, locks, the log ----------
const resFile = (dir, key) => path.join(dir, `${key}.json`), lockFile = (dir, key) => path.join(dir, `${key}.lock`);
/** the reusable result of a key: a pass younger than RESULT_TTL_MS, else null */
export function freshPass(dir, key, now = Date.now()) { const r = readJson(resFile(dir, key)); return r?.ok === true && now - Date.parse(r.at) < RESULT_TTL_MS ? r : null; }
function writeResult(dir, key, r) { const f = resFile(dir, key), t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(r)); fs.renameSync(t, f); }
/** take the key's run lock -> { held, release } | { held: false, holder } (a stale lock is taken over) */
function takeLock(dir, key, me, { alive, start } = {}) {
  const f = lockFile(dir, key);
  for (let i = 0; i < 5; i++) {
    try {
      fs.writeFileSync(f, JSON.stringify(me), { flag: 'wx' });
      return { held: true, release: () => { const c = readJson(f); if (c?.pid === me.pid && c.started === me.started) { try { fs.unlinkSync(f); } catch { /* taken over: nothing to free */ } } } };
    } catch (e) { if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') return { held: false, holder: null, error: e.code }; }
    const cur = readJson(f);
    if (cur && !holderGone(cur, { ...(alive ? { alive } : {}), ...(start ? { start } : {}) })) return { held: false, holder: cur };
    try { fs.unlinkSync(f); } catch { /* another taker */ }
  }
  return { held: false, holder: readJson(f) };
}
function logRow(dir, row) { fs.appendFileSync(logFile(dir), JSON.stringify(row) + '\n'); }
const jsonLines = t => String(t ?? '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
/** the log rows (oldest first); since = ms */
export const cacheLog = (dir, { since = 0 } = {}) => jsonLines(readText(logFile(dir))).filter(r => Date.parse(r.at) >= since);
/** the per-case rows (oldest first); since = ms */
export const caseLog = (dir, { since = 0 } = {}) => jsonLines(readText(casesFile(dir))).filter(r => Date.parse(r.at) >= since);
/** the reporter's lines of one file (a subtest ends before its parent) -> [{ id: <file>::<title path>, name (the path), line, ms, ok }] */
export function caseIds(file, rows) {
  const out = [], open = [];   // open: ended rows whose parent has not ended yet: { nesting, all (the row and its descendants) }
  for (const r of rows) {
    const me = { ...r, path: [r.name] }, kids = [];
    while (open.length && open.at(-1).nesting > r.nesting) kids.unshift(open.pop());
    for (const x of kids.flatMap(k => k.all)) x.path.unshift(r.name);
    out.push(me); open.push({ nesting: r.nesting, all: [me, ...kids.flatMap(k => k.all)] });
  }
  return out.map(x => ({ id: `${file}::${x.path.join('::')}`, name: x.path.join('::'), line: x.line ?? null, ms: x.ms ?? null, ok: x.ok === true }));
}
/** drop results past RESULT_TTL_MS, log rows past LOG_DAYS (once the log passes 256 KB) and case rows past LOG_DAYS (once they pass 4 MB) */
export function prune(dir, now = Date.now()) {
  let names = []; try { names = fs.readdirSync(dir); } catch { return; /* no cache folder yet: nothing to prune, the first run makes it */ }
  for (const n of names.filter(n => /^[0-9a-f]{40}\.json$/.test(n))) { const r = readJson(path.join(dir, n)); if (!r || now - Date.parse(r.at) > RESULT_TTL_MS) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* another run removed it first: the next file goes on */ } } }
  try { if (fs.statSync(logFile(dir)).size > 256 * 1024) fs.writeFileSync(logFile(dir), cacheLog(dir, { since: now - LOG_DAYS * 86400e3 }).map(r => JSON.stringify(r) + '\n').join('')); } catch { /* no log yet */ }
  try { if (fs.statSync(casesFile(dir)).size > 4 * 1024 * 1024) fs.writeFileSync(casesFile(dir), caseLog(dir, { since: now - LOG_DAYS * 86400e3 }).map(r => JSON.stringify(r) + '\n').join('')); } catch { /* no case rows yet */ }
}

// ---------- one file ----------
/** node --test on one file: its output kept (the last 2 MB) for its counts and a red's tail; past capMs its tree is killed. The spec reporter
 *  stays on stdout (testCounts reads it), casereport.mjs writes the per-case lines to caseOut: both live here, outside nodeArgs and the key */
function runNode(file, { cwd, env, nodeArgs, capMs, caseOut }) {
  return new Promise(resolve => {
    const rep = ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${CASE_REPORTER}`, `--test-reporter-destination=${caseOut}`];
    const t0 = Date.now(), child = spawn(process.execPath, ['--test', ...rep, ...nodeArgs, file], { cwd, env, windowsHide: true });
    let text = '', timedOut = false;
    const take = d => { text = (text + String(d)).slice(-2e6); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const cap = setTimeout(async () => { timedOut = true; const { killTree } = await import('./runs.mjs'); killTree(child.pid, { killer: `norn tests run pid ${process.pid}`, reason: `${file}: no exit within ${capMs / 1000} s` }); }, capMs);
    child.on('error', e => { clearTimeout(cap); resolve({ code: null, ms: Date.now() - t0, text: String(e.message), timedOut }); });
    child.on('close', code => { clearTimeout(cap); resolve({ code, ms: Date.now() - t0, text, timedOut }); });
  });
}
/**
 * One test file through the cache -> { file, key, how: 'ran' | 'reused' | 'waited', ok, ms, saved_ms, by, counts, at, tail (a red: the last 8 KB of
 * its output; report failures only, TESTING.md T8) }. o: { ix (repoIndex), dir, run (the asking run id | null), env (the caller's env: the
 * child gets suiteEnv of it + an empty META_ROOT + childEnv), childEnv, extra (key part: browser mode), nodeArgs, say (a line), pollMs,
 * capMs, alive, start (tests) }
 */
export async function runCached(file, o) {
  const { ix, dir, run = null, env = process.env, childEnv = {}, extra = '', nodeArgs = [], say = () => {}, pollMs = WAIT_POLL_MS, capMs = FILE_CAP_MS } = o;
  fs.mkdirSync(dir, { recursive: true });
  const f = fwd(file), { key } = keyOf(f, ix, `${extra}\0${nodeArgs.join(' ')}`), t0 = Date.now(), me = { pid: process.pid, started: Math.round(performance.timeOrigin), run, file: f, at: new Date().toISOString() };
  const done = r => { logRow(dir, { at: new Date().toISOString(), run, file: f, key, how: r.how, ok: r.ok, ms: r.ms, saved_ms: r.saved_ms, by: r.by }); return { file: f, key, ...r }; };
  let waited = false, told = null;
  for (;;) {
    const hit = freshPass(dir, key), changed = hit && changedReads(hit, ix);
    if (changed?.length && told !== hit.at) { told = hit.at; say(`${f}: its pass of ${hit.at} read ${changed[0]}${changed.length > 1 ? ` +${changed.length - 1} more` : ''}, changed since - running it again`); }
    if (changed && !changed.length) { const ms = Date.now() - t0; return done({ how: waited ? 'waited' : 'reused', ok: true, ms, saved_ms: Math.max(0, hit.ms - ms), by: hit.run ?? null, counts: hit.counts ?? null, at: hit.at }); }
    const l = waited && Date.now() - t0 > capMs ? { held: true, release: () => {} } : takeLock(dir, key, me, o);   // waited past the cap: run it here
    if (!l.held && !l.holder) l.release = () => {};   // no lock to take (an fs error): run it unguarded rather than never
    if (l.held || !l.holder) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'norn-tests-root-'));
      try {
        const caseOut = path.join(root, 'cases.jsonl'), recDir = path.join(root, 'readrec'), cenv = { ...suiteEnv(env), META_ROOT: root, ...childEnv };
        fs.mkdirSync(recDir);
        // the recorder rides the child env, not nodeArgs (they are part of the key): the test process and every node child it starts load it
        Object.assign(cenv, { NODE_OPTIONS: withRecorder(cenv.NODE_OPTIONS), NORN_READREC_DIR: recDir, NORN_READREC_ROOT: path.resolve(ix.root) });
        const r = await runNode(f, { cwd: ix.root, env: cenv, nodeArgs, capMs, caseOut });
        const cases = caseIds(f, jsonLines(readText(caseOut))), ok = r.code === 0 && !r.timedOut, reads = ok ? foldReads(recDir, f, ix) : null;
        const res = { ok, ms: r.ms, at: new Date().toISOString(), run, file: f, counts: testCounts(r.text), cases, ...(reads ? { reads } : {}), ...(r.timedOut ? { timed_out: true } : {}) };
        writeResult(dir, key, res);
        const state = env.META_RUN_STATE ? path.basename(path.resolve(env.META_RUN_STATE)) : null;
        if (cases.length) fs.appendFileSync(casesFile(dir), cases.map(c => JSON.stringify({ at: res.at, run, state, file: f, id: c.id, ms: c.ms, ok: c.ok }) + '\n').join(''));
        return done({ how: 'ran', ok: res.ok, ms: r.ms, saved_ms: 0, by: run, counts: res.counts, at: res.at, ...(r.timedOut ? { timed_out: true } : {}), ...(res.ok ? {} : { tail: r.text.slice(-8000) }) });
      } finally { l.release(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
    }
    if (!waited && l.holder) say(`${f}: already running in ${l.holder.run ?? `pid ${l.holder.pid}`} on the same content since ${l.holder.at} - waiting for its result instead of a second copy`);
    waited = true;
    await sleep(pollMs);
  }
}
