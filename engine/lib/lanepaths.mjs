// Path to main (lane norn-lifecycle item 9, MAIL-20): the tick's step that takes a lane's finished work to a PR - its own module, as it
// stages a MERGE through checkins.mjs, and lifecycle.mjs (read by lanes.mjs) must not import checkins (a K10 cycle through standing / agents).
// The rule and its words: lifecycle.mjs ("path to main": pathWords, lane-paths.json).
import fs from 'node:fs';
import { loadState, readEvents, recordsFile, fold, idNum as runNum, laneName } from './records.mjs';
import { makeGit, workOnMain } from './dlvgit.mjs';
import { readJsonS } from './fsnap.mjs';
import { stageArgs, isMergeRun, checkinPolicy } from './checkins.mjs';
import { isWork } from './gate.mjs';
import { LIVE, endTs, lanePathsFile } from './lifecycle.mjs';

/**
 * The tick's step. o: { project (file, root, briefs_dir, policy, deliverables.main, merge.gate.fast), now (ms), git, cli (args) -> { code, out }
 * (the meta CLI; none = nothing can be queued), dry }. Writes lane-paths.json; -> [{ id, act: pushed | staged | at_risk | stuck, note }]
 * (at_risk / stuck only when new: a lane that stays so with the same why says nothing again).
 */
export function tickPaths(state, { project: p = {}, now = Date.now(), git = makeGit(), cli = null, dry = false } = {}) {
  const st = loadState(state), main = p.deliverables?.main || 'main', cp = checkinPolicy(p.policy);
  const before = readJsonS(lanePathsFile(state))?.paths || {};
  const dlvs = Object.values(fold(readEvents(recordsFile(state, 'deliverable'))).items).filter(d => d.kind === 'deliverable');
  const byLane = {};
  for (const r of Object.values(st.items)) if (r.kind === 'run' && r.data?.lane && isWork(r.data)) (byLane[r.data.lane] ??= []).push(r);
  const paths = {}, out = [];
  for (const l of Object.values(st.items)) {
    if (l.kind !== 'lane' || !['active', 'done'].includes(l.state)) continue;
    const name = laneName(l.id, state), runs = (byLane[name] || []).sort((a, b) => runNum(a.id) - runNum(b.id));
    const work = runs.filter(x => !isMergeRun(x.data)), r = work.at(-1);
    if (!r || work.some(x => LIVE.includes(x.state)) || r.state !== 'exited' || r.end?.outcome !== 'done') continue;
    const branch = r.end?.branch || r.data.branch, wt = r.data.worktree && fs.existsSync(r.data.worktree) ? r.data.worktree : null, dir = wt || p.root;
    if (!branch || branch === main || !dir) continue;
    const tip = git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })?.trim() || r.end?.head;
    if (!tip) continue;
    if (before[name]?.state === 'merged' && before[name].tip === tip) { paths[name] = before[name]; continue; }   // merged stays merged: no git per tick
    const merges = runs.filter(x => isMergeRun(x.data) && runNum(x.id) > runNum(r.id));
    const set = v => (paths[name] = { lane: name, run: r.id, branch, tip, since: endTs(r), ...v });
    const found = a => { const was = before[name], now_ = paths[name]; if (was?.state !== now_.state || was?.why !== now_.why) out.push({ id: l.id, act: a, note: now_.why }); };
    const ahead = Number(git(dir, ['rev-list', '--count', `${main}..${tip}`], { allowFail: true })?.trim() || 0);
    if (!ahead || workOnMain(dir, tip, main, { git })) { if (ahead || merges.some(m => m.end?.outcome === 'done')) set({ state: 'merged', sha: tip.slice(0, 7) }); continue; }
    const live = merges.find(m => LIVE.includes(m.state));
    if (live) { set({ state: 'staged', merge: live.id }); continue; }
    const dirty = wt ? String(git(wt, ['status', '--porcelain'], { allowFail: true }) ?? '').split('\n').filter(s => s.trim()).length : 0;
    const risk = dirty ? `${dirty} uncommitted file(s) in ${wt}` : null;
    // land-push: the push comes before the deliverable check - the run end records a deliverable for every DONE branch, so an open one
    // ended this step unpushed, and nothing else pushes a lane branch (ui-shell, dwarf-names, ui-runs-lanes sat on home b, no PR)
    if (git(dir, ['merge-base', '--is-ancestor', tip, `refs/remotes/origin/${branch}`], { allowFail: true }) === null) {
      // unpushed commits beside uncommitted files: the worker's end left work behind - the owner's call, never a push or a merge
      const ok = !dry && !dirty && git(dir, ['push', 'origin', `${tip}:refs/heads/${branch}`], { allowFail: true }) !== null;
      if (!ok) { set({ state: 'at_risk', why: `${ahead} commit(s) on ${branch} not pushed${dirty || dry ? '' : ' (the push was refused)'}${risk ? ': ' + risk : ''}` }); found('at_risk'); continue; }
      git(dir, ['fetch', '-q', 'origin', branch], { allowFail: true });
      out.push({ id: l.id, act: 'pushed', note: `pushed ${branch} ${tip.slice(0, 7)} (${ahead} commit(s) of ${r.id})` });
    }
    const open = dlvs.find(d => d.state === 'open' && d.data.lane === name && (!d.data.branch || d.data.branch === branch));
    if (open) { set({ state: 'pr', dlv: open.id, pr: open.data.pr ?? null, risk }); continue; }
    const tried = merges.at(-1);
    const stuck = why => { set({ state: 'stuck', why, risk }); found('stuck'); };
    if (tried) { stuck(`merge step ${tried.id} ended ${tried.end?.outcome ?? tried.state} without landing it`); continue; }
    if (p.merge?.gate?.fast) { stuck('the fast merge-queue gate stages it from its deliverable - none is open'); continue; }
    if (dry || !cli || !p.file || !wt) { stuck(!wt ? `its worktree ${r.data.worktree ?? '(none)'} is gone` : 'nothing could queue one here (no meta CLI / project file)'); continue; }
    const a = stageArgs(p, r, { branch, sha: tip }, cp), b = cli(a.brief);
    if (b.code !== 0) { stuck(`merge-brief exit ${b.code}: ${b.out.split('\n')[0].slice(0, 160)}`); continue; }
    const q = cli([...a.run, '--priority', 'P1']), m = q.out.match(/\bRUN-(?:[a-z][a-z0-9]{0,7}-)?\d+\b/);   // a home's id too (RUN-b-12)
    if (q.code !== 0 || !m) { stuck(`norn run --queue exit ${q.code}: ${q.out.split('\n')[0].slice(0, 160)}`); continue; }
    set({ state: 'staged', merge: m[0], risk });
    out.push({ id: l.id, act: 'staged', note: `${ahead} commit(s) of ${r.id} on ${branch} not on main -> MERGE ${m[0]} (P1)` });
  }
  if (!dry) try { fs.writeFileSync(lanePathsFile(state), JSON.stringify({ at: new Date(now).toISOString(), paths }) + '\n'); } catch { /* the next tick writes it */ }
  return out;
}
