// GAP-6 (merges no longer queue behind each other on the owner's checkout): a MERGE run gets its own temporary worktree of the
// main branch, <state>/mq/merge-<lane>-<key> (detached), merges the lane there, and opens the PR of the lane branch with
// `norn merge-land` (mergeland.mjs: main only takes the owner-approved PR, Norn never pushes it). Up to policy.merge.parallel merges run at once
// (default 2); the owner's checkout is never a merge's. This leaf module holds the paths, the
// slot keys and the worktree's make / remove / sweep: git and path only (runs.mjs and mergebrief.mjs import it).
import fs from 'node:fs';
import path from 'node:path';
import { makeGit } from './dlvgit.mjs';
import { pathKey } from './config.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
export const MERGE_PARALLEL_DEFAULT = 2;

/** policy.merge.parallel: how many MERGE runs of the project may work at once (each in its own merge worktree), 1-16 */
export function mergeParallel(p) {
  const n = p?.policy?.merge?.parallel ?? MERGE_PARALLEL_DEFAULT;
  if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error(`${p?.name ?? 'project'}: policy.merge.parallel must be a whole number 1-16 (got ${JSON.stringify(n)})`);
  return n;
}

const slug = s => String(s).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';
/** the merge worktree of one merge: <state>/mq/merge-<lane>[-<sha7>] (the staged merge of a commit names it; the rebase merge one per lane) */
export const mergeWtPath = (state, lane, sha) => fwd(path.join(path.resolve(state), 'mq', `merge-${slug(lane)}${sha ? '-' + String(sha).slice(0, 7) : ''}`));
const isMergeWtName = n => /^merge-[\w.-]+$/.test(n);

// lock keys (runs.lockPath), never files in the repo: the merge slots of a repo
export const slotKey = (repo, i) => fwd(path.join(repo, `.norn-merge-slot-${i}`));

// the commit of the first ref that exists
function firstRef(repo, names, git) {
  for (const n of names) { const s = git(repo, ['rev-parse', '--verify', '--quiet', n + '^{commit}'], { allowFail: true }); if (s?.trim()) return s.trim(); }
  return null;
}
/** the tip main lands on: the remote's main when the repo has that remote, else the local main */
export const mainTip = (repo, { main = 'main', remote = 'origin', git = makeGit() } = {}) => firstRef(repo, [`refs/remotes/${remote}/${main}`, `refs/heads/${main}`], git);

/**
 * The merge worktree wt of repo, detached at main's tip: made when missing, kept when it is already a worktree (a HANDOFF's resume
 * goes on in it). A leftover folder that is no worktree is removed first. Returns { wt, made, base }.
 */
export function ensureMergeWorktree({ repo, wt, main = 'main', remote = 'origin', git = makeGit() }) {
  if (fs.existsSync(path.join(wt, '.git')) && git(wt, ['rev-parse', '--is-inside-work-tree'], { allowFail: true })?.trim() === 'true') return { wt, made: false, base: null };
  fs.rmSync(wt, { recursive: true, force: true, maxRetries: 3 });
  git(repo, ['worktree', 'prune'], { allowFail: true });
  const base = mainTip(repo, { main, remote, git });
  if (!base) throw new Error(`merge worktree: ${fwd(repo)} has no ${remote}/${main} nor ${main}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(repo, ['worktree', 'add', '--detach', '--quiet', wt, base]);
  return { wt, made: true, base };
}

/** remove one merge worktree (any state: a merge in progress is aborted with it); never throws. Returns true when it is gone. */
// Windows frees a folder some time after the last process in it died (a reaped tree, a virus scan): the delete is retried up to waitMs
export function removeMergeWorktree({ repo, wt, git = makeGit(), waitMs = 15000 }) {
  git(repo, ['worktree', 'remove', '--force', '--force', wt], { allowFail: true });
  const end = Date.now() + waitMs;
  for (;;) {
    try { fs.rmSync(wt, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a locked file: retried */ }
    if (!fs.existsSync(wt) || Date.now() >= end) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  git(repo, ['worktree', 'prune'], { allowFail: true });
  return !fs.existsSync(wt);
}

/** the merge worktrees left in <state>/mq: [path] */
export function mergeWorktrees(state) {
  const dir = path.join(path.resolve(state), 'mq');
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && isMergeWtName(e.name)).map(e => e.name); } catch { return []; }
  return names.map(n => fwd(path.join(dir, n)));
}
/** remove every merge worktree of <state>/mq that `keep` (a Set of pathKey) does not name. Returns the removed paths. */
export function sweepMergeWorktrees({ state, repo, keep = new Set(), git = makeGit() }) {
  const out = [];
  for (const wt of mergeWorktrees(state)) if (!keep.has(pathKey(wt)) && removeMergeWorktree({ repo, wt, git, waitMs: 1000 })) out.push(wt);
  return out;
}
