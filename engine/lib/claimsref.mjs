// RM-46 S2a (SPEC 3.5, 3.6): the claims branch core, shared by fed's run claims (keys under runs/) and the multi-home work claims
// (claims.mjs: work/, homes/, projects/, allow/, leader/). Branch `claims` of the ledger remote holds one JSON file per entry. A writer
// commits its edits on the claims tip it fetched and pushes WITHOUT force: git's receive-pack updates the ref only from the old value the
// push was built on (non-fast-forward = rejected; a concurrent update = a failed ref lock) - a compare-and-swap on the branch.
// Locally the fetched tip is refs/sync/claims of this machine's ledger repo (bare). Endpoint f = { dir: that repo, remote, host }.
// Node built-ins + the git binary only; every git child is bounded (bounded.mjs boundedSync: a timeout kills its tree, no orphan at birth).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { boundedSync } from './bounded.mjs';
import { refSha } from './gitfacts.mjs';

export class ClaimsError extends Error {}

export const CLAIMS = 'refs/heads/claims';
export const SYNC_CLAIMS = 'refs/sync/claims';
// `claims*`, not `claims`: a fixed refspec fails the whole fetch while the remote has no claims branch yet; the pattern also prunes
// refs/sync/claims when the branch goes
const CLAIMS_SPEC = '+refs/heads/claims*:refs/sync/claims*';

export function rgit(f, args, { input, ok = [0], index } = {}) {
  const env = { ...process.env, GIT_DIR: f.dir, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'norn-fed', GIT_AUTHOR_EMAIL: `fed@${f.host}`,
    GIT_COMMITTER_NAME: 'norn-fed', GIT_COMMITTER_EMAIL: `fed@${f.host}` };
  for (const k of ['GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete env[k];
  if (index) env.GIT_INDEX_FILE = index;
  const r = boundedSync('git', args, { env, input, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new ClaimsError(`git ${args[0]}: ${r.error.message}`);
  if (!ok.includes(r.status)) throw new ClaimsError(`git ${args[0]} failed (${r.status}): ${(r.stderr || '').trim().split('\n').pop()}`);
  return { out: r.stdout, status: r.status, err: r.stderr };
}
/** the machine's own repo exists (a bare repo; the ledger's when the ledger is on) */
export function initRepo(f) {
  if (fs.existsSync(path.join(f.dir, 'HEAD'))) return;
  fs.mkdirSync(f.dir, { recursive: true });
  const r = boundedSync('git', ['init', '-q', '--bare', f.dir], { timeout: 120000 });
  if (r.status !== 0) throw new ClaimsError(`git init failed: ${(r.stderr || '').trim()}`);
}
/** the remote's claims branch into refs/sync/claims, plus `extra` refspecs in the same fetch (fed: the machine branches) */
export function fetchRefs(f, extra = []) {
  initRepo(f);
  rgit(f, ['fetch', '-q', '--prune', '--no-tags', f.remote, CLAIMS_SPEC, ...extra]);
}
const tipOf = f => rgit(f, ['rev-parse', '-q', '--verify', `${SYNC_CLAIMS}^{commit}`], { ok: [0, 1] }).out.trim() || null;
// "<sha> <type> <size>\n<content>\n" records of one `git cat-file --batch` (sizes are bytes: parse the Buffer). heads: { sha, body }
// per object (an input line may name a revision; the header carries the sha it resolved to)
export function catBatch(f, shas, { heads = false } = {}) {
  if (!shas.length) return [];
  const env = { ...process.env, GIT_DIR: f.dir };
  const r = boundedSync('git', ['cat-file', '--batch'], { env, input: shas.join('\n') + '\n', encoding: null, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new ClaimsError(`git cat-file failed: ${String(r.stderr).trim()}`);
  const buf = r.stdout, out = [];
  let i = 0;
  for (let n = 0; n < shas.length; n++) {
    const nl = buf.indexOf(10, i), head = buf.subarray(i, nl).toString('utf8').split(' ');
    if (head[1] === 'missing') { out.push(null); i = nl + 1; continue; }
    const size = Number(head[2]);
    const body = buf.subarray(nl + 1, nl + 1 + size).toString('utf8');
    out.push(heads ? { sha: head[0], body } : body);
    i = nl + 1 + size + 1;
  }
  return out;
}
// ENGINE-GIT (DEC-88): the listing names the ref and the one cat-file --batch resolves the tip with the bodies (2 spawns, was 3:
// rev-parse + ls-tree + cat-file). refs/sync/claims moves only under the claims lock (fetchRefs, casClaims), so both see one tip.
// A failed ls-tree is a missing ref (no claims yet) only when rev-parse agrees; anything else throws as before.
// git-perf S1: the claims at one tip never change, and the queue walk reads them on every fill: the answer is kept per tip (read from the
// ref files, no git) in this process and in <dir>/norn-claims.json; a moved tip (a fetch, a CAS) is read from git again
const claimsMemo = new Map();
const memoFile = f => path.join(f.dir, 'norn-claims.json');
/** { tip, claims: { key: claim } } at the fetched claims tip (no fetch) */
export function readClaims(f) {
  const at = refSha(f.dir, SYNC_CLAIMS), key = `${f.dir}|${at}`;
  if (at && !claimsMemo.has(key)) { try { const m = JSON.parse(fs.readFileSync(memoFile(f), 'utf8')); if (m.tip === at) claimsMemo.set(key, m); } catch { /* none yet */ } }
  if (at && claimsMemo.has(key)) return structuredClone(claimsMemo.get(key));
  const r = readClaimsGit(f);
  if (r.tip && r.tip === at) {
    claimsMemo.set(key, r);
    const t = `${memoFile(f)}.${process.pid}.tmp`;
    try { fs.writeFileSync(t, JSON.stringify(r)); fs.renameSync(t, memoFile(f)); } catch { try { fs.unlinkSync(t); } catch { /* gone */ } }   // the memo is a shortcut only
  }
  return structuredClone(r);
}
function readClaimsGit(f) {
  const ls = rgit(f, ['ls-tree', '-r', '-z', `${SYNC_CLAIMS}^{commit}`], { ok: [0, 128] });
  if (ls.status !== 0) {
    if (!tipOf(f)) return { tip: null, claims: {} };
    throw new ClaimsError(`git ls-tree failed (${ls.status}): ${(ls.err || '').trim().split('\n').pop()}`);
  }
  const ents = ls.out.split('\0').filter(Boolean).map(l => { const [meta, key] = l.split('\t'); return { sha: meta.split(' ')[2], key }; });
  const [head, ...bodies] = catBatch(f, [`${SYNC_CLAIMS}^{commit}`, ...ents.map(e => e.sha)], { heads: true }), claims = {};
  if (!head) throw new ClaimsError(`${SYNC_CLAIMS} vanished between ls-tree and cat-file`);
  const tip = head.sha;
  ents.forEach((e, i) => { try { claims[e.key] = JSON.parse(bodies[i] ? bodies[i].body : null); } catch { claims[e.key] = { corrupt: true }; } });
  return { tip, claims };
}
/** commit `edits` ({ key: claim | null (remove) }) on `tip` and push it to claims without force: { ok, sha } | { rejected: why }.
 * beforePush(sha) runs between the commit and the push (tests force a race there). */
export function casClaims(f, tip, edits, msg, { beforePush } = {}) {
  const index = path.join(os.tmpdir(), `claims-${process.pid}-${crypto.randomBytes(4).toString('hex')}.index`);
  try {
    rgit(f, tip ? ['read-tree', tip] : ['read-tree', '--empty'], { index });
    const lines = Object.entries(edits).map(([key, c]) => (c === null ? `0 ${'0'.repeat(40)}\t${key}`   // mode 0 = remove (no work tree needed)
      : `100644 ${rgit(f, ['hash-object', '-w', '--stdin'], { input: JSON.stringify(c, null, 1) + '\n' }).out.trim()}\t${key}`));
    rgit(f, ['update-index', '--add', '--remove', '-z', '--index-info'], { index, input: lines.join('\0') + '\0' });
    const tree = rgit(f, ['write-tree'], { index }).out.trim();
    const sha = rgit(f, ['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-m', msg]).out.trim();
    beforePush?.(sha);
    const r = rgit(f, ['push', '-q', '--porcelain', f.remote, `${sha}:${CLAIMS}`], { ok: [0, 1] });
    if (r.status !== 0) return { rejected: (r.out.split('\n').find(l => l.startsWith('!')) || r.err || 'rejected').trim() };
    rgit(f, ['update-ref', SYNC_CLAIMS, sha]);
    return { ok: true, sha };
  } finally { try { fs.unlinkSync(index); } catch { /* never written: nothing to remove */ } }
}
// one claims operation at a time per machine repo (two projects' fills share the ledger repo; refs/sync/claims would race). The caller
// takes it with records.mjs withLock: importing records here would close an import cycle (records -> fed -> claimsref)
/** the claims lock of f's repo (created first): withLock(file, fn, opts) */
export const claimsLock = f => { initRepo(f); return { file: path.join(f.dir, 'fed.lock'), opts: { staleMs: 120000, timeoutMs: 60000 } }; };
