// META-GTP-FED-2 piece 1 (FED-NOTES D8, DEC-47): the node workspace manager. A node with no shared filesystem (no fed.path_map entry covers
// the run's worktree) runs a claimed run from its OWN checkout, as a GitHub Actions runner checks the job's ref out into its own workspace
// (actions/checkout: _work/<repo>/<repo>, reused across jobs; `clean: true` = git clean -ffdx + a forced checkout before each job). The job
// spec carries everything: the home's offer inlines the brief text and the checkout { repo (the worktree's origin), branch }.
// Layout under the node's state dir <state_root>/<project> (outside the ledger whitelist): ws/<lane> = the clone, reused by every run of the
// lane; ws/briefs/<home>/<project>/<RUN-n>.md = the brief. The NOTES are the node's own durable file <reviews>/fed/<home>/<project>/<RUN-n>.NOTES.md:
// in the ledger whitelist (they travel on machine/<host> with the run events), never under the workspace (NORN-WATCH S5: notes under a
// worktree die with it). Cleanup is the node's own, after its claim is done: a DONE run whose work is committed and pushed releases the
// workspace (detached, its branch deleted, git clean); any other end keeps it as it is (ws/<lane>.keep.json) and the lane's next checkout
// moves it aside (ws/<lane>.kept-<node run>) - evidence is never reset. The home never touches a node workspace.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withLock } from './records.mjs';
import { lockPath, STALE_MS } from './runs.mjs';
import { FedError } from './fed.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export const wsSlug = s => String(s || 'lane').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'lane';
function git(cwd, args, { ok = [0] } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new FedError(`git ${args[0]}: ${r.error.message}`);
  if (!ok.includes(r.status)) throw new FedError(`git ${args[0]} failed (${r.status}): ${(r.stderr || '').trim().split('\n').pop()}`);
  return { out: (r.stdout || '').trim(), status: r.status };
}

/** an offer a node without the home filesystem can run: it carries the brief text and a checkout */
export const canCheckout = offer => !!(offer?.checkout?.repo && offer.checkout.branch && typeof offer.brief_text === 'string');

/** the workspace of `lane` under the node state dir (no git) */
export const wsDir = (state, lane) => path.join(state, 'ws', wsSlug(lane));

/**
 * check the claimed run out into the node's workspace and write its brief; o: { state, locksDir, lane, home, project, run, offer, reviews,
 * root (the node ledger's work tree root), staleMs? } -> { worktree, brief, notes, notes_key, branch }. Throws FedError (the caller releases
 * the claim). Call it under wsLock() together with the start, so a second job of the same lane on this node sees the worktree lock.
 */
export function prepareWorkspace(o) {
  if (!canCheckout(o.offer)) throw new FedError('the offer carries no checkout / brief text: only a node sharing the home filesystem (fed.path_map) can run it');
  const { repo, branch } = o.offer.checkout;
  const ws = wsDir(o.state, o.lane), keep = `${ws}.keep.json`;
  const held = o.locksDir ? readJson(lockPath(o.locksDir, ws)) : null;
  if (held && !(Date.now() - Date.parse(held.ts) > (o.staleMs ?? STALE_MS))) throw new FedError(`workspace ${fwd(ws)} is held by live run ${held.run ?? '(a writer)'}`);
  if (fs.existsSync(keep)) {   // the lane's last run left it unsafe: set it aside, never reset it
    const k = readJson(keep) || {};
    if (fs.existsSync(ws)) fs.renameSync(ws, `${ws}.kept-${wsSlug(k.node_run || Date.now())}`);
    fs.unlinkSync(keep);
  }
  fs.mkdirSync(path.dirname(ws), { recursive: true });
  if (!fs.existsSync(path.join(ws, '.git'))) {
    fs.rmSync(ws, { recursive: true, force: true });
    git(path.dirname(ws), ['clone', '-q', '--no-checkout', repo, ws]);
  } else git(ws, ['remote', 'set-url', 'origin', repo]);
  git(ws, ['fetch', '-q', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  git(ws, ['checkout', '-q', '-f', '-B', branch, `refs/remotes/origin/${branch}`]);
  git(ws, ['clean', '-q', '-ffdx']);
  const brief = path.join(o.state, 'ws', 'briefs', o.home, o.project, `${o.run}.md`);
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, o.offer.brief_text);
  const notes = path.join(o.reviews, 'fed', o.home, o.project, `${o.run}.NOTES.md`);
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  return { worktree: ws, brief, notes, notes_key: fwd(path.relative(o.root, notes)), branch };
}

/** the prepare + start of one lane's workspace, one at a time on this node */
export const wsLock = (state, lane, fn) => {
  fs.mkdirSync(path.join(state, 'ws'), { recursive: true });
  return withLock(`${wsDir(state, lane)}.prep.lock`, fn, { staleMs: 300000, timeoutMs: 300000 });
};

/** the node's own cleanup after its claim is done -> the words for the job output */
export function cleanWorkspace(w, { outcome, node_run }) {
  const ws = w.worktree, keep = why => { fs.writeFileSync(`${ws}.keep.json`, JSON.stringify({ node_run, outcome, why, at: new Date().toISOString() }) + '\n'); return `workspace ${fwd(ws)} kept: ${why}`; };
  if (outcome !== 'done') return keep(`the run ended ${outcome}`);
  let dirty, unpushed;
  try { dirty = git(ws, ['status', '--porcelain']).out; unpushed = git(ws, ['rev-list', '-n', '1', 'HEAD', '--not', '--remotes']).out; } catch (e) { return keep(e.message); }
  if (dirty) return keep('uncommitted changes');
  if (unpushed) return keep(`commit ${unpushed.slice(0, 9)} is on no remote branch`);
  git(ws, ['checkout', '-q', '--detach']);
  git(ws, ['branch', '-q', '-D', w.branch], { ok: [0, 1] });
  git(ws, ['clean', '-q', '-ffdx']);
  return `workspace ${fwd(ws)} released (its work is on the remote)`;
}
