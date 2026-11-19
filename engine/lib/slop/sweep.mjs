// META-SLOP-A (REVIEW-FABLE 4.4): the git sweep LIST - nothing is deleted here (a sweep approval card is slice B).
//  G3 unrelated history: a branch with no common commit with main (merge-tree refuses it; listed, never a throw - audit D4);
//  G1 real: a branch whose merge into main would change main's tree (git merge-tree --write-tree), its age, behind / ahead,
//     and whether it conflicts with main right now;  G2 empty: merged, or unmerged but adding nothing;
//  G4 dead worktrees: on a branch (or a detached commit) that adds nothing, clean, no live or queued run, idle IDLE_DAYS;
//  G5 work at risk: a worktree with no live run holding uncommitted changes or a half-finished merge;
//  G6 remote branches merged into the remote's main and never deleted.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitRun } from './check.mjs';
import { mainRef } from './loc.mjs';
import { loadState } from '../records.mjs';
import { pathKey } from '../config.mjs';

export const IDLE_DAYS = 7;
const D = 86400e3;
const fwd = pathKey;   // a worktree's identity in any spelling (8.3 short name, link, case): run records vs git's list (CI-RED-7E52345)

/** one branch against main: { kind: merged | empty | real, conflicts } */
export function classify(repo, main, mainTree, tip) {
  if (isAncestor(repo, tip, main)) return { kind: 'merged', conflicts: false };
  const r = spawnSync('git', ['merge-tree', '--write-tree', '--no-messages', main, tip], { cwd: repo, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git merge-tree ${main} ${tip}: ${String(r.stderr).trim()}`);
  if (r.status === 1) return { kind: 'real', conflicts: true };
  return { kind: r.stdout.trim() === mainTree ? 'empty' : 'real', conflicts: false };
}
const related = (repo, a, b) => spawnSync('git', ['merge-base', a, b], { cwd: repo, windowsHide: true }).status === 0;
const isAncestor = (repo, a, b) => { try { gitRun(repo, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };

function worktrees(repo) {
  const out = [];
  let cur = null;
  for (const l of gitRun(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (l.startsWith('worktree ')) out.push(cur = { path: l.slice(9) });
    else if (cur && l.startsWith('HEAD ')) cur.head = l.slice(5);
    else if (cur && l.startsWith('branch refs/heads/')) cur.branch = l.slice(18);
    else if (cur && l.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}
function liveWorktrees(state) {
  if (!state) return new Set();
  return new Set(Object.values(loadState(state).items).filter(i => i.kind === 'run' && ['running', 'queued'].includes(i.state) && i.data.worktree).map(i => fwd(i.data.worktree)));
}

// Gap #7: a monorepo project (own = { name, subdir }) sweeps only its own part of the shared repo: its lane branches
// (norn/<name>/...) and any other branch whose unmerged work changes its folder; another project's lane branch (norn/<other>/...),
// a branch that changes only other folders, a merged / empty branch nobody can attribute, and a worktree with no work of its own
// in the folder are the other projects' (their own sweep lists them). own = null: the whole repo, as before.
const otherLane = (own, b) => !!own && !!b && b.startsWith('norn/') && !b.startsWith(`norn/${own.name}/`);
const touches = (repo, ref, tip, own) => !!gitRun(repo, ['diff', '--name-only', `${ref}...${tip}`, '--', `:(top)${own.subdir}`]).trim();

/** sweep(repo, { state (live / queued runs), now, main, remote, own ({ name, subdir }: a monorepo project) }) -> { main, real, empty, unrelated, dead, at_risk, remote_merged } */
export function sweep(repo, { state = null, now = Date.now(), main = 'main', remote = 'origin', own = null } = {}) {
  const ref = mainRef(repo, { main, remote }), mainTree = gitRun(repo, ['rev-parse', ref + '^{tree}']).trim();
  const real = [], empty = [], unrelated = [], kinds = new Map();
  for (const l of gitRun(repo, ['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)', 'refs/heads']).split('\n').filter(Boolean)) {
    const [branch, tip, t] = l.split('\t');
    if (branch === main || otherLane(own, branch)) continue;
    if (!related(repo, ref, tip)) { if (!own || branch.startsWith(`norn/${own.name}/`)) unrelated.push({ branch, tip, age_days: Math.floor((now - Number(t) * 1000) / D) }); continue; }
    const c = classify(repo, ref, mainTree, tip);
    if (own && !branch.startsWith(`norn/${own.name}/`) && (c.kind !== 'real' || !touches(repo, ref, tip, own))) continue;
    kinds.set(branch, c.kind);
    const age_days = Math.floor((now - Number(t) * 1000) / D);
    if (c.kind === 'real') {
      const [behind, ahead] = gitRun(repo, ['rev-list', '--left-right', '--count', `${ref}...${tip}`]).trim().split(/\s+/).map(Number);
      real.push({ branch, tip, age_days, behind, ahead, conflicts: c.conflicts });
    } else empty.push({ branch, tip, age_days, why: c.kind === 'merged' ? 'merged' : 'adds nothing' });
  }
  const live = liveWorktrees(state), dead = [], at_risk = [];
  for (const w of worktrees(repo).slice(1)) {   // the first is the main checkout
    if (w.prunable || !fs.existsSync(w.path) || live.has(fwd(w.path)) || otherLane(own, w.branch)) continue;
    // a monorepo project: only the changes in its own folder put the worktree at risk; a clean one is its own only on its branch
    const st = gitRun(w.path, ['status', '--porcelain', ...(own ? ['--', `:(top)${own.subdir}`] : [])]).split('\n').filter(Boolean);
    if (own && !st.length && !kinds.has(w.branch)) continue;
    const gitDir = gitRun(w.path, ['rev-parse', '--git-dir']).trim(), abs = path.resolve(w.path, gitDir);
    const merging = fs.existsSync(path.join(abs, 'MERGE_HEAD'));
    const unmerged = st.filter(x => /^(UU|AA|DD|AU|UA|DU|UD) /.test(x)).length;
    if (st.length || merging) { at_risk.push({ path: w.path, branch: w.branch ?? null, paths: st.length, unmerged, merging, head_in_main: isAncestor(repo, w.head, ref) }); continue; }
    const adds = w.branch ? kinds.get(w.branch) === 'real' : !isAncestor(repo, w.head, ref);
    let touched = Number(gitRun(repo, ['log', '-1', '--format=%ct', w.head]).trim()) * 1000;
    try { touched = Math.max(touched, fs.statSync(path.join(abs, 'index')).mtimeMs); } catch { /* no index yet: the commit time stands */ }
    if (!adds && now - touched >= IDLE_DAYS * D) dead.push({ path: w.path, branch: w.branch ?? null, idle_days: Math.floor((now - touched) / D) });
  }
  const remote_merged = gitRun(repo, ['branch', '-r', '--merged', `${remote}/${main}`, '--format=%(refname:short)'], { ok: [0, 1, 128] })
    .split('\n').map(s => s.trim()).filter(b => b && b.startsWith(remote + '/') && b !== `${remote}/${main}` && b !== `${remote}/HEAD` && b !== remote)
    .filter(b => !own || b.startsWith(`${remote}/norn/${own.name}/`));   // merged: only a project's own lane branch is attributable
  return { main: ref, real, empty, unrelated, dead, at_risk, remote_merged };
}

export function formatSweep(s) {
  const L = [`git sweep against ${s.main} (a list only: nothing is deleted)`,
    `G1 real unmerged work: ${s.real.length} (${s.real.filter(r => r.conflicts).length} conflict with main now)`];
  for (const r of s.real) L.push(`  ${r.branch} ${r.age_days} d old, ${r.behind} behind / ${r.ahead} ahead${r.conflicts ? ', CONFLICTS with main' : ''}`);
  L.push(`G2 empty branches: ${s.empty.length} (${s.empty.filter(e => e.why === 'merged').length} merged, ${s.empty.filter(e => e.why !== 'merged').length} add nothing)`);
  for (const e of s.empty) L.push(`  ${e.branch} (${e.why}, ${e.age_days} d)`);
  L.push(`G3 unrelated history: ${s.unrelated.length}`);
  for (const u of s.unrelated) L.push(`  ${u.branch} (no common history with main, ${u.age_days} d)`);
  L.push(`G4 dead worktrees: ${s.dead.length}`);
  for (const w of s.dead) L.push(`  ${w.path} ${w.branch ?? '(detached)'} idle ${w.idle_days} d`);
  L.push(`G5 WORK AT RISK: ${s.at_risk.length}`);
  for (const w of s.at_risk) L.push(`  ${w.path} ${w.branch ?? '(detached)'}: ${w.paths} changed path(s)${w.unmerged ? `, ${w.unmerged} unresolved` : ''}${w.merging ? ', a merge in progress' : ''}${w.head_in_main ? ', its HEAD is in main' : ''}`);
  L.push(`G6 remote branches merged, never deleted: ${s.remote_merged.length}`);
  for (const b of s.remote_merged) L.push(`  ${b}`);
  return L.join('\n');
}
