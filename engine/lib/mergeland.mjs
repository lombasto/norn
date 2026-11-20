// RM-7: `norn merge-land` - a MERGE run's tested merge goes to main as a pull request, never by a push to main (DIR-3: main only
// takes an approved PR). For each lane branch of the merge it checks the branch is pushed (origin/<branch>) and that the merge
// worktree's tested merge holds the branch's commits, then reuses the open PR of that branch to main or opens one (`gh pr create`),
// and records the PR on the branch's deliverable (a `pr` event). The owner approves and merges the PR; Norn never touches main.
// Repo = the owner/name of the remote's URL, base = project deliverables.main, title = the deliverable's `delivers` line (the lane
// brief's heading), else the branch: project data, nothing chosen here. RM-44 D1: a branch whose pushed head has open slop BLOCK
// findings (its stored check, or the check run now) gets no PR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeGit } from './dlvgit.mjs';
import { mergeConfig } from './mergecfg.mjs';
import { loadDeliverables, sameRepo } from './deliverables.mjs';
import { record, loadState, laneName, idNum as runNum } from './records.mjs';
import { readSync, writeSync } from './claims.mjs';
import { isWork } from './gate.mjs';
import { isMergeRun } from './checkins.mjs';
import { LIVE } from './lifecycle.mjs';
import { slopOn } from './policy.mjs';
import { doorCheck, doorWhy } from './slop/door.mjs';

export const fwd = p => String(p || '').replace(/\\/g, '/');
export const s7 = s => String(s || '').slice(0, 7);
/** exit codes of norn merge-land: every PR opened (or already open), some branch has no PR */
export const LAND_EXIT = { opened: 0, refused: 3 };

/** gh run synchronously: (args) -> { code, out, err } (tests inject a fake: no network) */
export const makeGh = () => args => {
  const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true });
  return { code: r.error ? -1 : r.status, out: r.stdout || '', err: r.error ? r.error.message : r.stderr || '' };
};
/** owner/name of a GitHub remote URL (https or ssh), else null */
export const ghSlug = url => (String(url || '').trim().match(/github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/) || [])[1] || null;

/**
 * Open (or reuse) the PR of each lane branch of the tested merge in wt. o: { repo, wt, branches, main, remote, stateDir, run, git, gh,
 * door ((branch, tip) -> null | why refused: the slop door; null = SloppaChoppa is off) }.
 * Returns [{ branch, status: opened | open | refused, url?, number?, ahead?, why, dlv? }].
 */
export function openPrs(o) {
  const { repo, wt, branches, main = 'main', remote = 'origin', stateDir = null, run = null, git = makeGit(), gh = makeGh(), door = null } = o;
  const all = why => branches.map(branch => ({ branch, status: 'refused', why }));
  if (!branches?.length) return [{ branch: '', status: 'refused', why: 'no lane branch named (--branch)' }];
  if ((git(wt, ['status', '--porcelain', '--untracked-files=no'], { allowFail: true }) ?? 'x').trim()) return all(`the merge worktree ${fwd(wt)} has uncommitted changes (or is no git worktree): commit the merge first`);
  if (git(wt, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true })) return all(`a merge is in progress in ${fwd(wt)}: commit or abort it first`);
  const slug = ghSlug(git(repo, ['remote', 'get-url', remote], { allowFail: true }));
  if (!slug) return all(`the ${remote} remote of ${fwd(repo)} is no GitHub repo: no PR can be opened`);
  const head = git(wt, ['rev-parse', 'HEAD']).trim();
  const dlvs = stateDir ? Object.values(loadDeliverables(stateDir)) : [];
  return branches.map(branch => {
    const res = (status, why, x = {}) => ({ branch, status, why, ...x });
    git(wt, ['fetch', '--quiet', remote, `+refs/heads/${main}:refs/remotes/${remote}/${main}`, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], { allowFail: true });
    const tip = git(wt, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`], { allowFail: true })?.trim();
    if (!tip) return res('refused', `${branch} is not on ${remote}: push the lane branch first`);
    const tested = git(wt, ['merge-base', head, tip], { allowFail: true })?.trim();
    const onMain = tested && git(wt, ['merge-base', '--is-ancestor', tested, `refs/remotes/${remote}/${main}`], { allowFail: true }) !== null;
    if (!tested || onMain) return res('refused', `the tested merge ${s7(head)} holds none of ${branch}'s commits past ${main}`);
    if (door) { let why; try { why = door(branch, tip); } catch (e) { why = `slop check could not run: ${e.message.split(/\r?\n/)[0]}`; } if (why) return res('refused', why); }
    const ahead = Number(git(wt, ['rev-list', '--count', `${head}..${tip}`], { allowFail: true }) || 0);
    const dlv = dlvs.find(d => sameRepo(d.data.repo, repo) && d.data.branch === branch) || null;
    const list = gh(['pr', 'list', '--repo', slug, '--head', branch, '--base', main, '--state', 'open', '--json', 'url,number']);
    if (list.code !== 0) return res('refused', `gh pr list failed: ${list.err.trim() || 'exit ' + list.code}`);
    let pr = (() => { try { return JSON.parse(list.out || '[]')[0] || null; } catch { return null; } })(), status = 'open';
    if (!pr) {
      const title = dlv?.data.delivers || branch;
      const body = [`Lane branch \`${branch}\`${dlv ? ` (${dlv.id}${dlv.data.lane ? `, lane ${dlv.data.lane}` : ''})` : ''}.`,
        `Norn tested it merged on ${main}: merge ${s7(head)}${run ? `, run ${run}` : ''}.`, ahead ? `The branch has ${ahead} commit(s) past that merge.` : ''].filter(Boolean).join('\n\n');
      const bf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'norn-pr-')), 'body.md');
      fs.writeFileSync(bf, body + '\n');
      const c = gh(['pr', 'create', '--repo', slug, '--base', main, '--head', branch, '--title', title, '--body-file', bf]);
      fs.rmSync(path.dirname(bf), { recursive: true, force: true });
      if (c.code !== 0) return res('refused', `gh pr create failed: ${c.err.trim() || 'exit ' + c.code}`);
      const url = (c.out.match(/https:\/\/\S+\/pull\/\d+/) || [])[0];
      if (!url) return res('refused', `gh pr create printed no PR URL: ${c.out.trim()}`);
      pr = { url, number: Number(url.split('/').pop()) };
      status = 'opened';
    }
    if (dlv && stateDir && dlv.state !== 'superseded' && dlv.history.findLast?.(h => h.ev === 'pr')?.data?.url !== pr.url)
      record(stateDir, { kind: 'deliverable', ev: 'pr', id: dlv.id, by: 'launcher', data: { url: pr.url, number: pr.number, repo: slug, head: branch, base: main, merge: head, ...(run ? { run } : {}) } }, { views: false });
    return res(status, `${branch} -> ${slug} ${main}${ahead ? `; the branch is ${ahead} commit(s) past the tested merge` : ''}`, { url: pr.url, number: pr.number, ahead, dlv: dlv?.id ?? null });
  });
}

/** the words of one branch's result (the CLI's line; the brief tells the worker what each first word means) */
export const prLine = r => r.status === 'refused' ? `NOT OPENED ${r.branch}: ${r.why}` : `PR ${r.status === 'opened' ? 'OPENED' : 'ALREADY OPEN'} ${r.url}: ${r.why}${r.dlv ? ` (recorded on ${r.dlv})` : ''}`;

/** openPrs with a project's settings (project.json deliverables) and its slop door (on unless the project's switch is off; tests pass `door`) */
export function openProjectPrs(p, { wt, branches, run, git, gh, door: d } = {}) {
  const cfg = mergeConfig(p);
  const door = d !== undefined ? d : slopOn(p.policy) ? (branch, tip) => doorWhy(doorCheck({ state: p.state, repo: cfg.repo, branch, head: tip, projectDir: p.project_dir, main: cfg.main, remote: cfg.remote })) : null;
  return openPrs({ repo: cfg.repo, wt, branches, main: cfg.main, remote: cfg.remote, stateDir: p.state || null, run, door, ...(git ? { git } : {}), ...(gh ? { gh } : {}) });
}

// RM-46 S6a (multi-home SPEC 4.8): a home that is not the merge leader runs no merge queue and no MERGE stage - its tick hands each lane
// whose last work run ended DONE on a pushed branch to openPrs, with the lane's own worktree as the "tested merge" (SPEC F21: its HEAD
// holds the branch's commits). The PR's GitHub CI is the test; the slop door still applies. An opened (or open) PR is noted per branch
// tip in <state>/sync/leader-prs.json, so it costs no gh call again until the lane moves; a refusal is retried and said again only when its why changes.
/** followerPrs(p, state, { git, gh, door }) -> [{ branch, status, why, url?, lane, run }] of the branches it tried this pass (new words only) */
export function followerPrs(p, state, { git = makeGit(), gh, door } = {}) {
  const items = loadState(state).items, main = mergeConfig(p).main, memo = readSync(state, 'prs'), out = [];
  const runs = Object.values(items).filter(r => r.kind === 'run' && r.data?.lane && isWork(r.data) && !isMergeRun(r.data)).sort((a, b) => runNum(a.id) - runNum(b.id));
  for (const l of Object.values(items)) {
    if (l.kind !== 'lane' || !['active', 'done'].includes(l.state)) continue;
    const name = laneName(l.id, state), mine = runs.filter(r => r.data.lane === name), r = mine.at(-1);
    if (!r || mine.some(x => LIVE.includes(x.state)) || r.state !== 'exited' || r.end?.outcome !== 'done') continue;
    const branch = r.end?.branch || r.data.branch, wt = r.data.worktree && fs.existsSync(r.data.worktree) ? r.data.worktree : null;
    if (!branch || branch === main || !wt) continue;
    const tip = git(wt, ['rev-parse', 'HEAD'], { allowFail: true })?.trim(), was = memo[branch];
    if (!tip || (was?.tip === tip && was.status !== 'refused')) continue;
    const [x] = openProjectPrs(p, { wt, branches: [branch], run: r.id, git, ...(gh ? { gh } : {}), ...(door !== undefined ? { door } : {}) });
    if (!(was?.tip === tip && was.why === x.why)) out.push({ ...x, lane: name, run: r.id });
    memo[branch] = { tip, status: x.status, why: x.why, ...(x.url ? { url: x.url } : {}) };
  }
  writeSync(state, 'prs', memo);
  return out;
}
