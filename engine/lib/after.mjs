// NORN-WATCH S4: triggers as records. A queued run's `after: [{kind, id, state}]` conditions and `inputs: [DLV ids]`, parsed at
// queue time and evaluated by fillPass (runs.mjs) on every fill, by the digest (sec. 2) and the META-QUEUE view. Conditions name
// records of the SAME state dir (ids are per state). Level-triggered: a condition is evaluated from the records every time.
import { loadState, fold, readEvents, recordsFile } from './records.mjs';
import fs from 'node:fs';
import { makeGit, isAncestor, refTip } from './dlvgit.mjs';

// kind -> { prefix, default state, allowed states }
export const AFTER_KINDS = {
  q: { prefix: 'Q-', def: 'answered', states: ['answered', 'applied'] },
  dlv: { prefix: 'DLV-', def: 'merged', states: ['merged'] },
  run: { prefix: 'RUN-', def: 'done', states: ['done', 'ended', 'merged', 'reviewed'] },   // merged: META-GTP-DAG piece 1; reviewed: META-DOD 3
  dir: { prefix: 'DIR-', def: 'done', states: ['done'] },
};
export class AfterError extends Error {}

/** "q:Q-50:answered,dlv:DLV-19" -> [{kind, id, state}] (the state defaults per kind); throws AfterError on a bad term. */
export function parseAfter(s) {
  if (s === undefined || s === null || s === '') return [];
  return String(s).split(',').map(t => t.trim()).filter(Boolean).map(t => {
    const [kind, id, state, ...more] = t.split(':');
    const k = AFTER_KINDS[kind];
    if (!k || more.length) throw new AfterError(`--after ${JSON.stringify(t)}: want kind:id[:state], kind ${Object.keys(AFTER_KINDS).join(' | ')}`);
    if (!new RegExp('^' + k.prefix + '\\d+$').test(id || '')) throw new AfterError(`--after ${JSON.stringify(t)}: ${kind} needs a ${k.prefix}n id`);
    const st = state || k.def;
    if (!k.states.includes(st)) throw new AfterError(`--after ${JSON.stringify(t)}: ${kind} state is ${k.states.join(' | ')}`);
    return { kind, id, state: st };
  });
}
/** "DLV-19,DLV-20" -> ['DLV-19', 'DLV-20'] */
export function parseInputs(s) {
  if (s === undefined || s === null || s === '') return [];
  const ids = String(s).split(',').map(t => t.trim()).filter(Boolean);
  for (const id of ids) if (!/^DLV-\d+$/.test(id)) throw new AfterError(`--inputs ${JSON.stringify(id)}: want DLV-n ids`);
  return ids;
}
export const condText = c => `${c.kind}:${c.id}:${c.state}`;
/** META-GTP-DAG piece 3: the words `norn ready`, META-QUEUE.md and digest sec. 2 print for a row of the fill walk (runs.mjs readiness) */
export const readyWords = r => (r.ready ? 'ready' : `blocked: ${r.terms.join('; ')}`);

/** Every named record must exist in the state dir now (a typo would otherwise wait forever); throws AfterError. */
export function checkRefs(stateDir, after = [], inputs = []) {
  const items = loadState(stateDir).items;
  const dlv = fold(readEvents(recordsFile(stateDir, 'deliverable'))).items;
  for (const c of after) if (!(c.kind === 'dlv' ? dlv : items)[c.id]) throw new AfterError(`--after ${condText(c)}: ${c.id} does not exist in ${stateDir}`);
  for (const id of inputs) if (!dlv[id]) throw new AfterError(`--inputs ${id}: does not exist in ${stateDir}`);
}

// a run's successor through a HANDOFF auto-resume (resume.next) or a limit re-queue (requeue_of) / its fill (fill.next) / a check-in's
// re-queue (withdraw.next, norn requeue - META-AUTONOMY R1)
export function follow(runs, r, seen = new Set()) {
  if (!r || seen.has(r.id)) return r;
  seen.add(r.id);
  if (r.state === 'filled' && r.fill?.next) {
    const n = runs[r.fill.next];   // META-GTP-FED: filled by a node's done claim = its run ended there with the claim's outcome + head
    if (!n && r.fill.node) return { ...r, id: r.fill.next, state: 'exited', end: { outcome: r.fill.outcome ?? 'crash', head: r.fill.head }, node: r.fill.node };
    return follow(runs, n, seen);
  }
  if (r.state === 'withdrawn' && r.withdraw?.next && runs[r.withdraw.next]) return follow(runs, runs[r.withdraw.next], seen);
  if (r.state !== 'exited') return r;
  const outcome = r.end?.outcome;
  if (outcome === 'handoff' && r.resume?.next) return follow(runs, runs[r.resume.next], seen);
  if (outcome === 'limit' || outcome === 'auth') { const q = Object.values(runs).find(x => x.data?.requeue_of === r.id); if (q) return follow(runs, q, seen); }
  return r;
}

/**
 * makeEval(stateDir, { git }) -> cond => { met: bool, gone: why | null }. gone = the condition can no longer be met (Q withdrawn /
 * superseded, run killed / lost / withdrawn / ended not DONE, DIR revoked / superseded). Records are read once per evaluator.
 */
export function makeEval(stateDir, { git = makeGit() } = {}) {
  let items = null, dlv = null;
  const recs = () => (items ??= loadState(stateDir).items);
  const dlvs = () => (dlv ??= fold(readEvents(recordsFile(stateDir, 'deliverable'))).items);
  // META-GTP-DAG piece 1 + META-AUTONOMY R1: a DONE run is merged once its WORK is on the project's main (workOnMain: ancestry, else
  // patch-id equivalence - robust to a rebase / squash / merge-queue rebase), or its deliverable was superseded (the work landed another
  // way). The repo = the run's DLV (its common dir: the worktree may be removed after the merge), else the worktree
  const merged = r => {
    const d = Object.values(dlvs()).find(x => x.data.run === r.id || x.history.some(h => h.ev === 'done' && h.data?.run === r.id));
    if (d?.state === 'superseded') return { met: true, gone: null };
    const head = r.end?.head;
    if (!head) return { met: false, gone: `${r.id} ended done with no head sha evidence` };
    const repo = [d?.data.repo, r.data.worktree].find(p => p && fs.existsSync(p));
    if (!repo) return { met: false, gone: `${r.id}: no repo to check (DLV / worktree gone)` };
    return { met: workOnMain(repo, head, d?.data.main || 'main', { git }), gone: null };
  };
  return c => {
    if (c.kind === 'dlv') {
      const d = dlvs()[c.id];
      if (!d) return { met: false, gone: `${c.id} does not exist` };
      const tip = refTip(d.data.repo, d.data.branch, { git }) || [...d.history].reverse().find(h => h.ev === 'done')?.data?.tip || d.data.tip;
      return { met: !!tip && workOnMain(d.data.repo, tip, d.data.main || 'main', { git }), gone: null };   // META-DLV-LANDED: the one rule
    }
    const all = recs(), it = all[c.id];
    if (!it) return { met: false, gone: `${c.id} does not exist` };
    if (c.kind === 'q') {
      if (['withdrawn', 'superseded'].includes(it.state)) return { met: false, gone: `${c.id} ${it.state}` };
      return { met: c.state === 'applied' ? it.state === 'applied' : ['answered', 'applied'].includes(it.state), gone: null };
    }
    if (c.kind === 'dir') {
      if (['revoked', 'superseded'].includes(it.state)) return { met: false, gone: `${c.id} ${it.state}` };
      return { met: it.state === 'done', gone: null };
    }
    // run (META-AUTONOMY R1: the run FAMILY - fills, resumes, re-queues, then the newest later run of the same lane + stage)
    const seen = new Set();
    let r = follow(all, it, seen);
    const live = x => ['queued', 'running', 'claimed'].includes(x.state);   // claimed: a node runs it (META-GTP-FED)
    const landed = () => [...seen].some(id => all[id]?.landed);   // a check-in's ruling "counted merged" (norn runs landed)
    if (landed()) return { met: true, gone: null };
    if (live(r)) return { met: false, gone: null };
    if (c.state === 'ended') return { met: true, gone: null };
    // META-DOD 3: a plan review is settled once it ended and the check-in reviewed it, or it ended DONE with no findings (critique.mjs)
    if (c.state === 'reviewed') return { met: !!r.review || (r.end?.outcome === 'done' && r.end?.critique?.findings === 0), gone: null };
    const first = r;
    for (let succ; !(r.state === 'exited' && r.end?.outcome === 'done') && !live(r) && (succ = successorOf(all, r, seen));) {
      r = follow(all, succ, seen);
      if (landed()) return { met: true, gone: null };
    }
    if (live(r)) return { met: false, gone: null };
    if (r.state === 'exited' && r.end?.outcome === 'done') return c.state === 'merged' ? merged(r) : { met: true, gone: null };
    r = first;
    const how = r.state === 'exited' ? `ended ${r.end?.outcome}` : r.state;
    return { met: false, gone: `${c.id} ${r.id === c.id ? '' : `(via ${r.id}) `}${how}` };
  };
}

// META-AUTONOMY R1 cause 2/3: a run that ended without its work (stopped / killed / withdrawn ...) is continued by the NEWEST later run of
// the same lane + stage (a re-dispatch, another round) in this state dir; a run with no stage has no such successor. -> run item | null
export function successorOf(runs, r, seen = new Set()) {
  const { lane, stage } = r.data ?? {};
  if (!lane || !stage) return null;
  const n = id => Number(String(id).replace(/^RUN-(?:[^-]+-)?/, ''));
  return Object.values(runs).filter(x => x.kind === 'run' && !seen.has(x.id) && n(x.id) > n(r.id) && x.data.lane === lane && x.data.stage === stage
    && x.data.kind !== 'checkin' && x.data.role !== 'helper' && !(x.state === 'withdrawn' && !x.withdraw?.next)).sort((a, b) => n(b.id) - n(a.id))[0] ?? null;
}

/**
 * META-AUTONOMY R1 cause 1: is the WORK of `head` on main (local main, else origin's)? The one home of "merged" for run conditions.
 * Industry standard, as git itself decides it (git rebase / `git cherry` / `git log --cherry-pick` skip a commit whose patch is already
 * upstream; squash detection as git-trim / git-delete-merged-branches do it):
 *  1. head is an ancestor of main (a fast-forward or a merge commit);
 *  2. else every commit of merge-base..head has a patch-id equal to a commit on main (`git cherry`: all '-') - a rebase, a merge-queue
 *     rebase, a cherry-pick, a rebase + --no-ff merge;
 *  3. else the branch's WHOLE diff (one synthetic commit: head's tree on the merge-base, `git commit-tree`) has the patch-id of a commit
 *     on main - a squash merge;
 *  4. (META-DLV-LANDED) else head's tree IS its merge-base's tree: the branch adds nothing to main - merged, then the merge queue's update
 *     step merged main into it (a merge commit that no patch-id matches; DLV-45 11-13);
 *  5. else every commit of main..head is a merge and each one is CLEAN (its tree = git's own merge of its parents: no edits of its
 *     own) - the branch landed, then the merge queue merged main into it, and main has moved on since (so 4's trees differ).
 * A rebase that resolved a conflict changes that commit's patch: git cannot see it, so the condition is held for a ruling (norn runs
 * landed). Not used: "a merge commit naming the branch" (a branch name is reused across rounds - R1 / R2 of meta-plan - so it would
 * count an older round's merge).
 */
// rule 5: main..head holds merge commits only, each with exactly the tree git's merge of its two parents gives (no conflict, no edit)
function onlyCleanMerges(repo, head, base, git) {
  const own = git(repo, ['rev-list', '--no-merges', '--count', `${base}..${head}`], { allowFail: true });
  if (own === null || Number(own.trim()) !== 0) return false;
  const merges = String(git(repo, ['rev-list', '--merges', '--parents', `${base}..${head}`], { allowFail: true }) ?? '').split('\n').filter(Boolean);
  if (!merges.length) return false;
  return merges.every(l => {
    const [m, ...ps] = l.trim().split(/\s+/);
    if (ps.length !== 2) return false;   // an octopus: not judged
    const r = git(repo, ['merge-tree', '--write-tree', ps[0], ps[1]], { status: true });
    return r.code === 0 && r.out.split('\n')[0].trim() === git(repo, ['rev-parse', `${m}^{tree}`], { allowFail: true })?.trim();
  });
}

export function workOnMain(repo, head, main = 'main', { git = makeGit() } = {}) {
  const lines = out => String(out ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const base of [main, `refs/remotes/origin/${main}`]) {
    if (isAncestor(repo, head, base, git)) return true;
    if (onlyCleanMerges(repo, head, base, git)) return true;
    const mb = git(repo, ['merge-base', base, head], { allowFail: true })?.trim();
    if (!mb) continue;
    const tree = git(repo, ['rev-parse', `${head}^{tree}`], { allowFail: true })?.trim();
    if (tree && tree === git(repo, ['rev-parse', `${mb}^{tree}`], { allowFail: true })?.trim()) return true;
    const own = lines(git(repo, ['cherry', base, head, mb], { allowFail: true }));
    if (own.length && own.every(l => l.startsWith('-'))) return true;
    const synth = tree && git(repo, ['commit-tree', tree, '-p', mb, '-m', 'norn: the branch as one patch (squash check)'], { allowFail: true,
      env: { GIT_AUTHOR_NAME: 'norn', GIT_AUTHOR_EMAIL: 'norn@localhost', GIT_COMMITTER_NAME: 'norn', GIT_COMMITTER_EMAIL: 'norn@localhost' } })?.trim();
    const sq = synth ? lines(git(repo, ['cherry', base, synth, mb], { allowFail: true })) : [];
    if (sq.length === 1 && sq[0].startsWith('-')) return true;
  }
  return false;
}

/** { met: all met, gone: [why] , conds: [{cond, met, gone}] } for one queued run's after list */
export function evalAll(after = [], ev) {
  const conds = after.map(c => ({ cond: condText(c), ...ev(c) }));
  return { met: conds.every(c => c.met), gone: conds.filter(c => c.gone).map(c => `${c.cond}: ${c.gone}`), conds };
}
