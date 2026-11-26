// git-perf S1: cheap git facts for the hot paths (the queue walk's claim pre-check, the tick's claim renewal, the overlap refresh, the
// collide intents). On a loaded Windows machine one git process costs 0.5-1 s, so the count of calls is the cost:
//   - a worktree's HEAD (branch + sha) and a ref's sha are read from the files (.git, HEAD, loose refs, packed-refs): no process;
//   - a fact about commit ids never changes (a merge-base of two shas, the files and the commit count between two shas): it is
//     memoized per process and in <git common dir>/norn-memo.json across processes (a sha means the same commit in every worktree);
//   - every git child runs through bounded.mjs boundedSync: its timeout kills the whole tree, and the child is born inside a job, so a
//     parent killed while it starts never leaves a suspended git.exe (the leak doctor found: raw spawnSync, no timeout).
// A repo whose refs cannot be read from files (reftable) falls through to git for the same answer.
import fs from 'node:fs';
import path from 'node:path';
import { boundedSync } from './bounded.mjs';
import { pathKey } from './config.mjs';
import { readText as read } from './harness/common.mjs';

export const GIT_MS = 60000;
const MEMO_MAX = 4000;   // entries per repo memo file; the oldest go first
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** a name as a lowercase slug (a-z 0-9 -): one rule, so `project new` and the adopt scan name a my_app repo alike */
export const slugOf = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** the facts the adopt scan and setup's `project new` both take: { name (of the project's folder), default_branch, origin (url | null) } */
export function repoFacts(root, sub = '') {
  return { name: slugOf(path.basename(sub || root)), origin: gitOut(root, ['remote', 'get-url', 'origin']),
    default_branch: gitOut(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '') || gitOut(root, ['symbolic-ref', '--short', 'HEAD']) || 'main' };
}
/** the non-empty trimmed lines of a git output */
export const lines = s => String(s ?? '').split('\n').map(x => x.trim()).filter(Boolean);

/** git in cwd, bounded: stdout (trimmed) | null (a non-zero exit, a timeout, no git) */
export function gitOut(cwd, args, { timeout = GIT_MS, input } = {}) {
  const r = boundedSync('git', ['-C', cwd, ...args], { timeout, input, maxBuffer: 64 << 20 });
  return r.status === 0 ? String(r.stdout ?? '').trim() : null;
}

// ---------- refs from files ----------
/** a worktree's (or a repo's) git dir and common dir, or null when it is no git checkout */
export function gitDirs(wt) {
  const dot = path.join(wt, '.git');
  let st;
  try { st = fs.statSync(dot); } catch { return null; }
  let dir = dot;
  if (!st.isDirectory()) { const m = /^gitdir:\s*(.+?)\s*$/m.exec(read(dot) || ''); if (!m) return null; dir = path.resolve(wt, m[1]); }
  const c = read(path.join(dir, 'commondir'));
  return { dir, common: c ? path.resolve(dir, c.trim()) : dir };
}
const packed = new Map();   // common dir -> { mtime, refs }
function packedRefs(common) {
  const f = path.join(common, 'packed-refs');
  let m;
  try { m = fs.statSync(f).mtimeMs; } catch { return new Map(); }
  const hit = packed.get(common);
  if (hit?.mtime === m) return hit.refs;
  const refs = new Map();
  for (const l of lines(read(f))) { const [sha, ref] = l.split(' '); if (SHA.test(sha) && ref) refs.set(ref, sha); }
  packed.set(common, { mtime: m, refs });
  return refs;
}
/** the sha of a full ref name (refs/heads/x, refs/remotes/origin/main) in a common dir: loose file, else packed-refs; null = none.
 * undefined = cannot tell from files (a reftable repo): the caller asks git */
export function refSha(common, ref, depth = 0) {
  if (fs.existsSync(path.join(common, 'reftable'))) return undefined;
  const loose = read(path.join(common, ...ref.split('/')))?.trim();
  if (loose && SHA.test(loose)) return loose;
  if (loose?.startsWith('ref: ') && depth < 5) return refSha(common, loose.slice(5).trim(), depth + 1);
  return packedRefs(common).get(ref) ?? null;
}
/** a worktree's HEAD: { branch ('HEAD' when detached, as `rev-parse --abbrev-ref HEAD`), sha (null: unborn), common } | null (no checkout) */
export function headOf(wt) {
  const d = wt && gitDirs(wt);
  const h = d && read(path.join(d.dir, 'HEAD'))?.trim();
  if (!h) return null;
  if (SHA.test(h)) return { branch: 'HEAD', sha: h, common: d.common };
  const ref = /^ref: (\S+)$/.exec(h)?.[1];
  if (!ref) return null;
  let sha = refSha(d.common, ref);
  if (sha === undefined) sha = gitOut(wt, ['rev-parse', '--verify', '--quiet', 'HEAD']) || null;
  return { branch: ref.replace(/^refs\/heads\//, ''), sha, common: d.common };
}
/** a ref's sha in a checkout (any worktree of the repo): from files, else git; null = no such ref */
export function shaOf(wt, ref) {
  const d = gitDirs(wt);
  if (!d) return null;
  const s = refSha(d.common, ref);
  return s === undefined ? gitOut(wt, ['rev-parse', '--verify', '--quiet', ref]) || null : s;
}

// ---------- the sha-keyed memo ----------
const memos = new Map();   // common dir key -> { file, data, dirty }
function memoOf(common) {
  const k = pathKey(common);
  if (!memos.has(k)) {
    let data = {};
    const file = path.join(common, 'norn-memo.json');
    try { data = JSON.parse(read(file) || '{}') || {}; } catch { data = {}; }
    memos.set(k, { file, data, dirty: new Set() });
    if (memos.size === 1) process.once('exit', saveMemos);
  }
  return memos.get(k);
}
// at exit: the entries this process learned, merged into the file as it is now (another process may have written meanwhile)
export function saveMemos() {
  for (const m of memos.values()) {
    if (!m.dirty.size) continue;
    let cur = {};
    try { cur = JSON.parse(read(m.file) || '{}') || {}; } catch { cur = {}; }
    for (const k of m.dirty) cur[k] = m.data[k];
    const keys = Object.keys(cur);
    if (keys.length > MEMO_MAX) for (const k of keys.sort((a, b) => (cur[a].at ?? 0) - (cur[b].at ?? 0)).slice(0, keys.length - MEMO_MAX)) delete cur[k];
    const t = `${m.file}.${process.pid}.tmp`;
    try { fs.writeFileSync(t, JSON.stringify(cur)); fs.renameSync(t, m.file); } catch { try { fs.unlinkSync(t); } catch { /* no temp file left: the memo file stays as it was, the next exit writes again */ } }
    m.dirty.clear();
  }
}
/** the memoized answer of key in the repo of wt, computed by fn once (fn -> a JSON value; undefined = not memoized: git failed) */
export function memo(common, key, fn) {
  const m = memoOf(common), e = m.data[key];
  if (e && 'v' in e) return e.v;
  const v = fn();
  if (v !== undefined) { m.data[key] = { v, at: Date.now() }; m.dirty.add(key); }
  return v;
}
const isSha = s => SHA.test(String(s || ''));
/** merge-base of two commit ids (memoized: immutable) -> sha | null */
export function mergeBase(wt, common, a, b) {
  if (!isSha(a) || !isSha(b)) return gitOut(wt, ['merge-base', a, b]) || null;
  const [x, y] = [a, b].sort();
  return memo(common, `mb ${x} ${y}`, () => { const o = gitOut(wt, ['merge-base', x, y]); return o === null ? undefined : o; }) || null;
}
/** the files that differ between two commit ids (memoized) -> [path] | null */
export function diffNames(wt, common, a, b) {
  return memo(common, `diff ${a} ${b}`, () => { const o = gitOut(wt, ['diff', '--name-only', a, b]); return o === null ? undefined : lines(o); }) ?? null;
}
/** the commits of `tip` not in `base` (two commit ids, memoized) -> n */
export function countOf(wt, common, base, tip) {
  return memo(common, `count ${base} ${tip}`, () => { const o = gitOut(wt, ['rev-list', '--count', `${base}..${tip}`]); return o === null ? undefined : Number(o) || 0; }) ?? 0;
}
/** is commit a an ancestor of commit b (memoized) */
export function isAncestorOf(wt, common, a, b) {
  return memo(common, `anc ${a} ${b}`, () => boundedSync('git', ['-C', wt, 'merge-base', '--is-ancestor', a, b], { timeout: GIT_MS }).status === 0);
}

/**
 * worktreeFacts(wt, { main ('refs/remotes/origin/main'), ttlMs, commits, ahead }) -> { branch | null, tip, base, touched, commits } | null (no
 * checkout). touched = the files the worktree changes against its merge-base with main: its commits + its uncommitted tracked edits (`git
 * diff --name-only <base>`, the one call that reads the working tree). ttlMs > 0: a touched list read for the same (tip, base) within
 * ttlMs is reused (the queue walk's pre-check: the start itself reads it fresh). commits false: not counted (0). ahead: the commit count
 * (memoized sha facts) comes first and a worktree 0 commits ahead of main is not diffed (touched []): a caller that drops such a lane
 * never reads its touched list, and the diff is the costly call. No main ref = no base: touched [] and commits 0.
 */
export function worktreeFacts(wt, { main = 'refs/remotes/origin/main', ttlMs = 0, now = Date.now(), commits = true, ahead = false } = {}) {
  if (!wt || !fs.existsSync(wt)) return null;
  const h = headOf(wt);
  if (!h) return null;
  const branch = h.branch === 'HEAD' ? null : h.branch, ms = h.sha && shaOf(wt, main), base = ms ? mergeBase(wt, h.common, h.sha, ms) : null;
  if (!base) return { branch, tip: h.sha, base: null, touched: [], commits: 0 };
  const n = ahead || commits ? countOf(wt, h.common, ms, h.sha) : 0;
  if (ahead && !n) return { branch, tip: h.sha, base, touched: [], commits: 0 };
  const m = memoOf(h.common), k = `wt ${pathKey(wt)}`, e = m.data[k];
  let touched;
  if (ttlMs > 0 && e?.tip === h.sha && e.base === base && now - e.at < ttlMs) touched = e.files;
  else {
    const o = gitOut(wt, ['diff', '--name-only', base]);
    touched = o === null ? [] : lines(o);
    if (o !== null) { m.data[k] = { tip: h.sha, base, files: touched, at: now }; m.dirty.add(k); }
  }
  return { branch, tip: h.sha, base, touched, commits: n };
}
