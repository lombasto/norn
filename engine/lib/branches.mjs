// Branches (owner ask 2026-11-19): every git worktree, local branch and origin branch of a project's repo, one row per branch, with the
// lane it belongs to and its state in plain words. A VIEW, never an auto-cleaner: nothing here deletes or prunes by itself; the owner's
// row actions (delete a merged branch, remove a clean worktree, open a PR, adopt into a lane) run only on a click, each with an Undo.
// Two halves, so a page poll never runs git:
//   scanBranches  the slow git half (for-each-ref with ahead-behind, then `cherry` / the squash check for tips that are not ancestors of
//                 main, worktree status, gh pr list): written to <state>/branches.json by `norn branches --refresh`, which the tick
//                 spawns detached at most every BRANCHES_TTL_MS. Incremental: a merged tip stays merged (main only grows), an unmerged
//                 answer is kept per (tip, main sha), so a warm refresh asks cherry only for tips that moved.
//   branchesView  the fast half: the cached git facts + the records as they are NOW (lanes, runs, live heartbeats, deliverables) ->
//                 rows with their state from branchState, the one state function. The page and `norn branches` both call it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeGit, workOnMain } from './dlvgit.mjs';
import { loadState, record } from './records.mjs';
import { liveRuns } from './runs.mjs';
import { deliverableConfig, loadDeliverables, deliverablesView } from './deliverables.mjs';
import { githubRepo } from './overlap.mjs';
import { pathKey } from './config.mjs';
import { fwd } from './dlvmerge.mjs';

export const BRANCHES_TTL_MS = 10 * 60000;
export const STALE_DAYS = 14;
const DAY = 864e5;
const lines = s => String(s ?? '').split(/\r?\n/).filter(Boolean);
const runNum = id => Number(String(id).replace(/^\D+-/, '')) || 0;
export const branchesFile = state => path.join(state, 'branches.json');
const NORN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'norn.mjs');

// ---------- the one state function ----------
/** display order (the page sorts by it): what needs the owner first, what can go last */
export const BRANCH_STATES = ['in progress', 'awaiting merge', 'unknown', 'lost', 'stale', 'merged'];
/**
 * branchState(f, { now, staleDays }) -> { state, why } (plain words). f: { merged, live (a run running / queued on it: true or its words), lane (null |
 * { name, state active|parked|archived }), lost (why the lane is lost: its record or worktree is gone, or its last run is lost; null),
 * done (its lane's last run exited DONE), dlv (a deliverable tracks it, not superseded), last (ms of its last commit), detached }
 *   in progress     a run is running or queued on it; or its active lane has unfinished work younger than staleDays
 *   merged          its work is on main (tip on main, or every commit's patch / the squash on main) and its lane is still open
 *   stale           merged with no open lane (prunable), or no commit in staleDays with no live run
 *   lost            unmerged, and its lane record or worktree is gone, or the lane's last run is lost
 *   awaiting merge  unmerged, DONE (its lane's last run, or a deliverable) - a PR open or none
 *   unknown         unmerged, no lane and no deliverable: someone's hand branch, a CI fixer branch, a backup
 */
export function branchState(f, { now = Date.now(), staleDays = STALE_DAYS } = {}) {
  const days = Number.isFinite(f.last) ? (now - f.last) / DAY : Infinity, old = days >= staleDays, open = f.lane && f.lane.state !== 'archived';
  const ago = Number.isFinite(days) ? `${Math.floor(days)} d` : 'long';
  if (f.live) return { state: 'in progress', why: typeof f.live === 'string' ? f.live : 'a run is running or queued on it' };
  if (f.merged) return open && !old ? { state: 'merged', why: `its work is on main; lane ${f.lane.name} is still ${f.lane.state}` }
    : { state: 'stale', why: `its work is on main${open ? `, last commit ${ago} ago` : f.lane ? `, lane ${f.lane.name} archived` : ', no lane'}: prunable` };
  if (f.lost) return { state: 'lost', why: f.lost };
  if (f.done || f.dlv) return { state: 'awaiting merge', why: f.done ? 'its lane finished DONE; the work is not on main yet' : 'a deliverable tracks it; the work is not on main yet' };
  if (f.detached) return { state: 'unknown', why: 'a detached worktree no run names' };
  if (!f.lane) return { state: 'unknown', why: 'not part of a lane' };
  if (f.lane.state === 'archived') return { state: 'stale', why: `lane ${f.lane.name} is archived and its work is not on main` };
  if (old) return { state: 'stale', why: `no commit in ${ago} and nothing running` };
  return { state: 'in progress', why: `lane ${f.lane.name} is ${f.lane.state}; nothing running now` };
}
const ORDER = Object.fromEntries(BRANCH_STATES.map((s, i) => [s, i]));
/** in progress first, then awaiting merge, unknown, lost, stale, merged; newest commit first inside a state */
export const sortBranches = rows => rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.last ?? 0) - (a.last ?? 0) || String(a.name).localeCompare(String(b.name)));

// a branch name without its kind prefix, slashes as dashes: feat/solve-shack-unattended-reconnect and norn/solve-shack/unattended-reconnect
// are one work item (a deliverable tracked on one, the work landed from the other)
export const branchSlug = b => String(b || '').replace(/^(norn|feat|feature|fix|bugfix|hotfix)\//, '').replace(/\//g, '-');

// ---------- the slow half: git ----------
// async children, POOL at a time: on a busy Windows machine one `git cherry` takes ~1.3 s and `git status` in a worktree as long; the
// owner's hand cleanup of 190 refs took over 10 min one call after another
const POOL = 4;
const run = (exe, timeout) => (args, cwd) => new Promise(ok => execFile(exe, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 << 20 }, (e, out) => ok(e ? null : String(out))));
export const gitA = run('git', 120000);
const ghA = run('gh', 30000);
async function pool(xs, fn, n = POOL) { let i = 0; await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const x = xs[i++]; await fn(x); } })); }

function worktreeList(raw) {
  const out = [];
  let cur = null;
  for (const l of lines(raw)) {
    if (l.startsWith('worktree ')) { cur = { path: fwd(l.slice(9)), head: null, branch: null, bare: false, prunable: false }; out.push(cur); }
    else if (!cur) continue;
    else if (l.startsWith('HEAD ')) cur.head = l.slice(5);
    else if (l.startsWith('branch ')) cur.branch = l.slice(7).replace(/^refs\/heads\//, '');
    else if (l === 'bare') cur.bare = true;
    else if (l.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

/**
 * scanBranches(repo, { main, remote, git, gh, memo, now, prTtlMs, progress }) -> facts { at, repo, main, main_sha, refs [{ name, local, remote,
 * ahead, behind, merged, how }], worktrees [{ path, branch, head, dirty, missing, primary }], prs [{ number, state, head, sha, url }] | null, github, ms, calls }.
 * local / remote: { sha, last (ms), author, subject } | null. git / gh: (args, cwd) -> Promise<stdout | null>.
 * Merged, per distinct tip: an ancestor of main (ahead 0, from the one for-each-ref); else a merged PR whose head is this very tip; else
 * every commit's patch on main (`git cherry`: a rebased or cherry-picked branch). memo (mutated, persisted by the caller): { merged:
 * { sha: how } (main only grows: kept while the tip exists), not: { sha: main sha } (asked again when main moves), prs, pr_ts }.
 * progress(): called after each cherry answer, so a long first scan keeps what it learned when it is stopped.
 */
export async function scanBranches(repo, { main = 'main', remote = 'origin', git = gitA, gh = ghA, memo = {}, now = Date.now(), prTtlMs = BRANCHES_TTL_MS, progress = () => {} } = {}) {
  const t0 = Date.now();
  let calls = 0;
  const G = (args, cwd = repo) => { calls++; return git(args, cwd); };
  memo.merged ||= {}; memo.not ||= {};
  const sha = async r => (await G(['rev-parse', '--verify', '--quiet', r]))?.trim() || null;
  const [lm, rm] = await Promise.all([sha(`refs/heads/${main}`), sha(`refs/remotes/${remote}/${main}`)]);
  // main = the further of the local branch and origin's (a checkout whose main is not pulled is 100s of commits behind the PRs merged on GitHub)
  const useRemote = rm && (!lm || (lm !== rm && (await G(['merge-base', '--is-ancestor', lm, rm])) !== null));
  const mainRef = useRemote ? `refs/remotes/${remote}/${main}` : lm ? `refs/heads/${main}` : null, mainSha = useRemote ? rm : lm;
  const fmt = `%(objectname)%09%(refname)%09%(committerdate:unix)%09%(authorname)%09${mainRef ? `%(ahead-behind:${mainRef})` : '-'}%09%(subject)`;
  const [raw, wraw, top, url] = await Promise.all([G(['for-each-ref', `--format=${fmt}`, 'refs/heads', `refs/remotes/${remote}`]), G(['worktree', 'list', '--porcelain']),
    G(['rev-parse', '--show-toplevel']), G(['remote', 'get-url', remote])]);
  const github = githubRepo(url?.trim());
  if (github && gh && !(now - (memo.pr_ts ?? -Infinity) < prTtlMs && now >= (memo.pr_ts ?? 0))) {
    let prs = null;
    try { prs = JSON.parse(await gh(['pr', 'list', '--repo', github, '--state', 'all', '--limit', '300', '--json', 'number,state,headRefName,headRefOid,url'], repo)); } catch { prs = null; }
    memo.pr_ts = now;
    memo.prs = Array.isArray(prs) ? prs.map(p => ({ number: p.number, state: String(p.state || '').toLowerCase(), head: p.headRefName ?? '', sha: p.headRefOid ?? null, url: p.url ?? null })) : memo.prs ?? null;
  }
  const prMerged = new Set((github ? memo.prs || [] : []).filter(p => p.state === 'merged' && p.sha).map(p => p.sha));
  const by = new Map();
  for (const l of lines(raw)) {
    const [s, ref, ts, author, ab, ...subj] = l.split('\t');
    const loc = ref.startsWith('refs/heads/'), name = loc ? ref.slice(11) : ref.slice(`refs/remotes/${remote}/`.length);
    if (name === main || name === 'HEAD' || !name) continue;
    const [ahead, behind] = String(ab).split(' ').map(Number);
    const row = by.get(name) || { name, local: null, remote: null, ab: {} };
    row[loc ? 'local' : 'remote'] = { sha: s, last: Number(ts) * 1000, author, subject: subj.join('\t') };
    row.ab[s] = { ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null };
    by.set(name, row);
  }
  const rows = [...by.values()], how = new Map();
  for (const r of rows) for (const x of [r.local, r.remote].filter(Boolean)) {
    if (!mainSha) how.set(x.sha, null);
    else if (r.ab[x.sha]?.ahead === 0) how.set(x.sha, 'on main');
    else if (memo.merged[x.sha]) how.set(x.sha, memo.merged[x.sha]);
    else if (prMerged.has(x.sha)) how.set(x.sha, memo.merged[x.sha] = 'PR merged');
    else if (memo.not[x.sha] === mainSha) how.set(x.sha, null);
  }
  const ask = [...new Set(rows.flatMap(r => [r.local, r.remote]).filter(x => x && !how.has(x.sha)).map(x => x.sha))];
  await pool(ask, async s => {
    const out = await G(['cherry', mainRef, s]), own = lines(out);
    const yes = out !== null && own.length > 0 && own.every(l => l.startsWith('-'));
    if (yes) memo.merged[s] = 'patches on main'; else if (out !== null) memo.not[s] = mainSha;
    how.set(s, yes ? 'patches on main' : null);
    progress();
  });
  const refs = rows.map(r => {
    const tip = r.local || r.remote, ab = r.ab[tip.sha] || {}, hs = [r.local, r.remote].filter(Boolean).map(x => how.get(x.sha) ?? null);
    return { name: r.name, local: r.local, remote: r.remote, ahead: ab.ahead ?? null, behind: ab.behind ?? null, merged: hs.every(Boolean), how: hs.find(Boolean) ?? null };
  });
  const tips = new Set(refs.flatMap(r => [r.local?.sha, r.remote?.sha]).filter(Boolean));   // a long-lived memo stays small
  for (const k of ['merged', 'not']) for (const s of Object.keys(memo[k])) if (!tips.has(s)) delete memo[k][s];
  const primary = fwd(top?.trim() || repo), worktrees = worktreeList(wraw).filter(w => !w.bare);
  await pool(worktrees, async w => {
    w.missing = w.prunable || !(await fs.promises.access(w.path).then(() => true, () => false));
    const st = w.missing ? null : await G(['status', '--porcelain'], w.path);
    w.dirty = st === null ? null : lines(st).length;
  });
  return { at: new Date(now).toISOString(), repo: fwd(repo), main, remote, main_sha: mainSha, refs,
    worktrees: worktrees.map(w => ({ path: w.path, branch: w.branch, head: w.head, dirty: w.dirty, missing: w.missing, primary: pathKey(w.path) === pathKey(primary) })),
    prs: github ? memo.prs ?? null : null, github, ms: Date.now() - t0, calls };
}

/** `norn branches --refresh` (and the tick's detached spawn): scan the project's repo, write <state>/branches.json. Never throws. */
export async function refreshBranches(p, { git = gitA, gh = ghA, now = Date.now() } = {}) {
  const f = branchesFile(p.state), old = readBranches(p.state);
  try {
    const { repo, main, remote } = deliverableConfig(p);
    if (!repo) return save(f, { at: new Date(now).toISOString(), error: 'the project has no repo', refs: [], worktrees: [], memo: {} });
    const memo = old?.memo || {};
    let n = 0;   // what a first scan learned survives a stop: the memo is written every 10 answers (the old facts stay until the scan ends)
    const progress = () => { if (++n % 10 === 0) save(f, { ...(old || { refs: [], worktrees: [] }), memo }); };
    const out = save(f, { ...(await scanBranches(repo, { main, remote: remote || 'origin', git, gh, memo, now, progress })), memo });
    // git-perf S1: the slow landing rules of the deliverables (squash / rebase / content) run here, off the tick and the fill: every
    // reader keeps a tip's "not on main" answer across main moves (dlvmerge landedOn), this detached refresh asks them again
    try { deliverablesView({ stateDir: p.state, project: p, now, refresh: true }); } catch { /* the readers keep the last answers */ }
    return out;
  } catch (e) { return save(f, { ...(old || { refs: [], worktrees: [] }), error: `scan failed: ${String(e.message).split('\n')[0]}` }); }
}
function save(f, c) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(c)); fs.renameSync(t, f); } catch { /* the view still answers */ } return c; }
export function readBranches(state) { try { return JSON.parse(fs.readFileSync(branchesFile(state), 'utf8')); } catch { return null; } }

/** the tick: a detached `norn branches --refresh` when the cache is older than ttlMs and none started in the last ttlMs. A message or null. */
export function tickBranches(p, state, { spawnFn, now = Date.now(), ttlMs = BRANCHES_TTL_MS } = {}) {
  if (!p?.file) return null;
  const at = Date.parse(readBranches(state)?.at ?? '');
  if (Number.isFinite(at) && now - at < ttlMs) return null;
  const mark = path.join(state, 'branches.started');
  try { if (now - fs.statSync(mark).mtimeMs < ttlMs) return null; } catch { /* never started */ }
  return spawnRefresh(p, state, { spawnFn, mark, now });
}
/** start `norn branches --refresh` detached (the tick, and the page after an owner action) */
export function spawnRefresh(p, state, { spawnFn, mark = path.join(state, 'branches.started'), now = Date.now() } = {}) {
  try { fs.mkdirSync(state, { recursive: true }); fs.writeFileSync(mark, String(now)); } catch { /* still try */ }
  const args = [NORN, 'branches', '--refresh', '--project', p.file, '--state', state];
  let r = spawnFn ? spawnFn(process.execPath, args) : null;
  if (!r) { const c = spawn(process.execPath, args, { cwd: p.root || state, detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); r = { pid: c.pid }; }
  return `branches refresh: started pid ${r?.pid ?? '?'}`;
}

// ---------- the fast half: rows from the cached facts + the records now ----------
/**
 * branchesView({ facts, items (loadState().items), live (Set of live run ids), dlvs (loadDeliverables() values), project (name), now,
 * staleDays, exists (path -> bool) }) -> { at, error, rows, counts { state: n } }. A row: name, kind branch|worktree, where local|remote|both,
 * diverged, tip, ahead, behind, last, author, subject, merged, how, worktree { path, dirty, missing, primary } | null, lane { name, state } | null,
 * run (the lane's / worktree's newest run) | null, dlv { id, via branch|lane|name } | null, pr { number, state, url } | null, state, why, acts.
 */
export function branchesView({ facts, items = {}, live = new Set(), dlvs = [], project = null, now = Date.now(), staleDays = STALE_DAYS, exists = p => fs.existsSync(p) } = {}) {
  if (!facts) return { at: null, error: null, rows: [], counts: {} };
  const all = Object.values(items), laneRecs = all.filter(i => i.kind === 'lane'), runs = all.filter(i => i.kind === 'run');
  const laneByName = new Map(laneRecs.map(l => [l.id.slice(2), l]));
  const newest = xs => xs.sort((a, b) => runNum(b.id) - runNum(a.id))[0] || null;
  const runsOfLane = new Map(), runsOfWt = new Map();
  for (const r of runs) {
    if (r.data?.lane) (runsOfLane.get(r.data.lane) || runsOfLane.set(r.data.lane, []).get(r.data.lane)).push(r);
    if (r.data?.worktree) { const k = pathKey(r.data.worktree); (runsOfWt.get(k) || runsOfWt.set(k, []).get(k)).push(r); }
  }
  const isLive = r => !!r && (live.has(r.id) || r.state === 'queued' || r.state === 'claimed');
  // the words of the live run among rs (a running one first): "RUN-7 is running" / "RUN-9 is queued"; null when none is live
  const liveWords = rs => { const xs = rs.filter(isLive), r = xs.find(x => live.has(x.id)) || xs[0]; return r ? `${r.id} is ${live.has(r.id) ? 'running' : 'queued'}` : null; };
  const wtOf = new Map(facts.worktrees.filter(w => w.branch).map(w => [w.branch, w]));
  const prOf = new Map();
  for (const p of facts.prs || []) { const o = prOf.get(p.head); if (!o || (p.state === 'open' && o.state !== 'open') || (o.state !== 'open' && p.number > o.number)) prOf.set(p.head, p); }
  const openDlvs = dlvs.filter(d => d.kind === 'deliverable' && d.state !== 'superseded');
  const dlvOf = (name, lane) => {
    const pick = (xs, via) => { const d = xs.sort((a, b) => runNum(b.id) - runNum(a.id))[0]; return d ? { d, via } : null; };
    return pick(openDlvs.filter(d => d.data?.branch === name), 'branch') || (lane ? pick(openDlvs.filter(d => d.data?.lane === lane), 'lane') : null)
      || pick(openDlvs.filter(d => branchSlug(d.data?.branch) === branchSlug(name)), 'name');
  };
  // the lane of a branch: a LANE record naming it, the lane of the runs in its worktree, then norn/<lane> or norn/<project>/<lane>
  const laneOf = (name, wt) => {
    const rec = laneRecs.find(l => l.data?.branch === name) || (wt && laneRecs.find(l => l.data?.worktree && pathKey(l.data.worktree) === pathKey(wt.path)));
    if (rec) return { name: rec.id.slice(2), rec };
    const r = wt ? newest([...(runsOfWt.get(pathKey(wt.path)) || [])].filter(x => x.data?.lane)) : null;
    const m = /^norn\/(?:([^/]+)\/)?([^/]+)$/.exec(name), guess = m && (!m[1] || !project || m[1] === project) ? m[2] : null;
    const n = r?.data.lane ?? guess;
    if (!n) return null;
    return laneByName.has(n) ? { name: n, rec: laneByName.get(n) } : runsOfLane.has(n) ? { name: n, rec: null } : null;
  };
  const runBrief = r => (r ? { id: r.id, state: r.state, outcome: r.end?.outcome ?? null } : null);
  const rows = facts.refs.map(r => {
    const tip = r.local || r.remote, wt = r.local ? wtOf.get(r.name) || null : null, l = laneOf(r.name, wt);
    const lr = l ? newest([...(runsOfLane.get(l.name) || [])]) : null, wr = wt ? newest([...(runsOfWt.get(pathKey(wt.path)) || [])]) : null;
    const live1 = liveWords([lr, wr, ...(l ? runsOfLane.get(l.name) || [] : [])]);
    const lane = l ? { name: l.name, state: l.rec?.state ?? 'gone' } : null;
    const wtGone = l?.rec && l.rec.state !== 'archived' && l.rec.data?.worktree && r.local && !exists(l.rec.data.worktree);
    const lost = !l ? null : !l.rec ? `lane ${l.name} has runs but no LANE record` : lr && (lr.state === 'lost' || (lr.state === 'running' && !live.has(lr.id))) ? `lane ${l.name}'s last run ${lr.id} is lost`
      : wtGone ? `lane ${l.name}'s worktree ${fwd(l.rec.data.worktree)} is gone` : null;
    const dv = dlvOf(r.name, l?.name), pr = prOf.get(r.name) || (dv && [...dv.d.history].reverse().find(h => h.ev === 'pr' && h.data?.url)?.data) || null;
    const f = { merged: r.merged, live: live1, lane: lane && lane.state !== 'gone' ? lane : null, lost, done: lr?.end?.outcome === 'done', dlv: !!dv, last: tip.last };
    const s = branchState(f, { now, staleDays });
    return { name: r.name, kind: 'branch', where: r.local && r.remote ? 'both' : r.local ? 'local' : 'remote', diverged: !!(r.local && r.remote && r.local.sha !== r.remote.sha),
      tip: tip.sha, ahead: r.ahead, behind: r.behind, last: tip.last, author: tip.author, subject: tip.subject, merged: r.merged, how: r.how,
      worktree: wt ? { path: wt.path, dirty: wt.dirty, missing: wt.missing, primary: wt.primary, head: wt.head } : null, lane, run: runBrief(lr || wr),
      dlv: dv ? { id: dv.d.id, via: dv.via, branch: dv.d.data?.branch ?? null } : null, pr: pr ? { number: pr.number ?? null, state: pr.state ?? 'open', url: pr.url ?? null } : null, ...s };
  });
  // detached worktrees (merge worktrees under state/<p>/mq, a hand checkout): one row each, with the run that used it
  for (const w of facts.worktrees.filter(x => !x.branch)) {
    const r = newest([...(runsOfWt.get(pathKey(w.path)) || [])]);
    const lost = r && (r.state === 'lost' || (r.state === 'running' && !live.has(r.id))) ? `its run ${r.id} is lost` : null;
    const s = branchState({ merged: false, live: liveWords([r]), lane: null, lost, detached: true, last: null }, { now, staleDays });
    const leftover = !s.state.match(/in progress|lost/) && (r || /\/mq\//.test(w.path)) ? { state: 'stale', why: r ? `left by ${r.id} (${r.end?.outcome ?? r.state})` : 'a merge worktree no run names' } : null;
    rows.push({ name: `(detached) ${path.basename(w.path)}`, kind: 'worktree', where: 'local', diverged: false, tip: w.head, ahead: null, behind: null, last: null, author: null, subject: null,
      merged: false, how: null, worktree: { path: w.path, dirty: w.dirty, missing: w.missing, primary: w.primary, head: w.head }, lane: r?.data?.lane ? { name: r.data.lane, state: laneByName.get(r.data.lane)?.state ?? 'gone' } : null,
      run: runBrief(r), dlv: null, pr: null, ...(leftover || s) });
  }
  for (const x of rows) x.acts = actsOf(x, facts);
  sortBranches(rows);
  const counts = Object.fromEntries(BRANCH_STATES.map(s => [s, rows.filter(x => x.state === s).length]));
  return { at: facts.at, error: facts.error ?? null, main: facts.main, github: facts.github ?? null, rows, counts };
}

// the owner's row actions: only what cannot lose unmerged work (a merged branch, a clean worktree); none while a run uses the row
function actsOf(x, facts) {
  const busy = x.state === 'in progress', acts = [];
  if (x.kind === 'branch' && x.merged && !x.worktree && !busy && x.pr?.state !== 'open') acts.push('delete');
  if (x.worktree && !x.worktree.primary && !x.worktree.missing && x.worktree.dirty === 0 && !busy) acts.push('rmwt');
  if (x.kind === 'branch' && !x.merged && x.where !== 'local' && !x.pr && facts.github) acts.push('pr');
  if (x.kind === 'branch' && !x.merged && !x.lane && !x.dlv) acts.push('adopt');
  return acts;
}
/** the GitHub page that opens a PR for a branch (the owner creates it there; Norn sends nothing) */
export const prUrl = (github, main, branch) => `https://github.com/${github}/compare/${encodeURIComponent(main)}...${branch.split('/').map(encodeURIComponent).join('/')}?expand=1`;

/** the view of one loaded project: its cache + its records now */
export function projectBranches(p, { now = Date.now(), items = null, live = null } = {}) {
  const st = items ? { items } : loadState(p.state);
  return branchesView({ facts: readBranches(p.state), items: st.items, live: live ?? new Set(liveRuns(p.state).map(r => r.id)), dlvs: Object.values(loadDeliverables(p.state)), project: p.name, now });
}

// ---------- the owner's actions (a click on the page; each returns what its Undo needs) ----------
export class BranchActError extends Error { constructor(msg, code = 409) { super(msg); this.code = code; } }
const okName = b => typeof b === 'string' && /^[\w.\-/]+$/.test(b) && !b.startsWith('-') && !b.includes('..');
/** the row as the cache sees it, re-checked against git now (a stale cache never deletes) */
function rowNow(p, kind, key) {
  const v = projectBranches(p), x = v.rows.find(r => (kind === 'branch' ? r.kind === 'branch' && r.name === key : r.worktree && pathKey(r.worktree.path) === pathKey(key)));
  if (!x) throw new BranchActError(`${key} is not in the branch list (refresh, then try again)`, 404);
  return x;
}
function patch(p, fn) { const c = readBranches(p.state); if (c) { fn(c); save(branchesFile(p.state), c); } }

/** delete a merged branch, local and origin copies; refused unless git agrees it is merged now. -> { branch, local, remote } (the shas) */
export function deleteBranch(p, branch, { git = makeGit() } = {}) {
  if (!okName(branch)) throw new BranchActError('bad branch name', 400);
  const x = rowNow(p, 'branch', branch);
  if (!x.acts.includes('delete')) throw new BranchActError(`${branch} cannot be deleted here: ${x.state} (only a merged branch with no worktree, no open PR and no run)`);
  const { repo, main, remote = 'origin' } = deliverableConfig(p), r = remote || 'origin';
  const sha = ref => git(repo, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true })?.trim() || null;
  const local = sha(`refs/heads/${branch}`), rem = sha(`refs/remotes/${r}/${branch}`);
  for (const t of [local, rem].filter(Boolean)) if (!workOnMain(repo, t, main, { git })) throw new BranchActError(`${branch} at ${t.slice(0, 9)} is not on ${main} now: kept`);
  if (rem) { const o = git(repo, ['push', r, '--delete', branch], { allowFail: true }); if (o === null) throw new BranchActError(`git push ${r} --delete ${branch} failed (offline?): nothing deleted`, 502); }
  if (local) git(repo, ['branch', '-D', branch]);
  patch(p, c => { c.refs = (c.refs || []).filter(f => f.name !== branch); });
  return { branch, local, remote: rem };
}
/** Undo of deleteBranch: the branch back at the same commits */
export function restoreBranch(p, { branch, local, remote }, { git = makeGit() } = {}) {
  if (!okName(branch)) throw new BranchActError('bad branch name', 400);
  const { repo, remote: rn = 'origin' } = deliverableConfig(p), sha = s => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
  if (local && sha(local)) git(repo, ['branch', branch, local]);
  if (remote && sha(remote) && git(repo, ['push', rn || 'origin', `${remote}:refs/heads/${branch}`], { allowFail: true }) === null) throw new BranchActError(`restoring ${rn}/${branch} failed (offline?); the local branch is back`, 502);
  return { branch };
}
/** remove a clean worktree (git refuses a dirty one: never --force). -> { path, branch, head } */
export function removeWorktree(p, wtPath, { git = makeGit() } = {}) {
  const x = rowNow(p, 'worktree', String(wtPath));
  if (!x.acts.includes('rmwt')) throw new BranchActError(`${wtPath} cannot be removed here: only a clean worktree no run uses`);
  const { repo } = deliverableConfig(p);
  if (git(repo, ['worktree', 'remove', x.worktree.path], { allowFail: true }) === null) throw new BranchActError(`git worktree remove ${x.worktree.path} refused (uncommitted files?): kept`);
  patch(p, c => { c.worktrees = (c.worktrees || []).filter(w => pathKey(w.path) !== pathKey(x.worktree.path)); });
  return { path: x.worktree.path, branch: x.kind === 'branch' ? x.name : null, head: x.worktree.head };
}
/** Undo of removeWorktree: the worktree back on its branch (or detached at its commit) */
export function restoreWorktree(p, { path: wt, branch, head }, { git = makeGit() } = {}) {
  const { repo } = deliverableConfig(p);
  if (typeof wt !== 'string' || !wt) throw new BranchActError('path is required', 400);
  if (branch && !okName(branch)) throw new BranchActError('bad branch name', 400);
  if (!branch && !/^[0-9a-f]{40}$/.test(String(head))) throw new BranchActError('head is required for a detached worktree', 400);
  if (git(repo, branch ? ['worktree', 'add', wt, branch] : ['worktree', 'add', '--detach', wt, head], { allowFail: true }) === null) throw new BranchActError(`git worktree add ${wt} failed`, 500);
  return { path: wt };
}
/** adopt a branch no lane owns: a LANE record naming it (its worktree when it has one). Undo = archive the lane. -> { lane } */
export function adoptBranch(p, branch, { lane = null, by = 'dashboard' } = {}) {
  if (!okName(branch)) throw new BranchActError('bad branch name', 400);
  const x = rowNow(p, 'branch', branch);
  if (!x.acts.includes('adopt')) throw new BranchActError(`${branch} cannot be adopted: ${x.lane ? `it is lane ${x.lane.name}'s` : x.state}`);
  const name = lane || branch.split('/').pop().replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new BranchActError(`no lane name from ${branch}: pass one`, 400);
  if (loadState(p.state).items['L:' + name]) throw new BranchActError(`lane ${name} exists already: pick another name`);
  const e = record(p.state, { kind: 'lane', ev: 'create', by, data: { name, branch, ...(x.worktree ? { worktree: x.worktree.path } : {}) } });
  return { lane: name, id: e.id };
}

// ---------- the CLI's text ----------
const age = (ms, now) => (Number.isFinite(ms) ? `${Math.max(0, Math.floor((now - ms) / DAY))} d` : '-');
/** one line per row: state, branch, where, lane, ahead/behind, age, author, worktree, PR, deliverable */
export function branchLines(v, { now = Date.now() } = {}) {
  const pad = (s, n) => String(s ?? '-').padEnd(n).slice(0, Math.max(n, String(s ?? '-').length));
  return v.rows.map(x => [pad(x.state, 14), pad(x.name, 44), pad(x.where, 6), pad(x.lane ? `${x.lane.name} (${x.lane.state})` : 'no lane', 28),
    pad(x.ahead === null ? '-' : `+${x.ahead}/-${x.behind}`, 10), pad(age(x.last, now), 5), pad(x.author, 14),
    x.worktree ? `wt ${x.worktree.missing ? 'missing' : `${x.worktree.dirty ?? '?'} dirty`}` : '', x.pr ? `PR #${x.pr.number} ${x.pr.state}` : '', x.dlv ? `${x.dlv.id}${x.dlv.via !== 'branch' ? ` (tracked as ${x.dlv.branch})` : ''}` : '', `- ${x.why}`]
    .filter(Boolean).join(' ').trimEnd());
}
