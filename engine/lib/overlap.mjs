// GAP-12 (overlap): nobody coordinated development across machines. The owner built a feature on a lane while upstream (another
// Norn instance or person) built the same feature the same night; the overlap was found only at the merge. This check lists, for
// each RUNNING lane of a project, the remote branches and open pull requests whose changed files overlap the lane's changed files.
//   lane files   = `git diff --name-only <merge-base(HEAD, origin/<main>)>` in the lane worktree (commits + uncommitted tracked edits)
//   remote files = `git diff --name-only origin/<main>...origin/<b>` per remote branch (cached per branch tip and base tip)
//   PR files     = `gh pr list --json number,title,headRefName,files,url` when gh answers and origin is on GitHub (else no PRs)
// Our own work is not "upstream": a remote branch (or PR head) with a local branch of the same name is skipped.
// Cost: `git fetch origin` and the gh call at most once per OVERLAP_TTL_MS each (rate-limited in <state>/overlap.json); offline =
// the last fetched refs, with fetch_error set; gh absent / logged out / not GitHub = no PR rows, never an error.
// Who calls: `norn overlap` (spawned detached by a lane's supervisor at its start) and the tick before the check-in. The digest
// (row "overlap") and the dashboard Lanes chip only READ the cache file. Policy policy.overlap.enabled false = none of this.
// RM-46 S6b (multi-home SPEC 4.9): in a synced project (home.json) the own lanes - running, or with an open deliverable - are also
// checked against the other homes' open branches (origin/norn/<h>/...): only a pair that already shares files gets a
// `git merge-tree --write-tree <own tip> <their tip>`; exit 1 = a predicted conflict = a digest row "norn/a/x conflicts with norn/b/y
// (on b): 2 files". The result is cached per (own tip, their tip): two commit ids merge the same way forever. A solo project runs no merge-tree.
// git-perf S1: the tick's refresh runs at most once per OVERLAP_TTL_MS for the same lanes (a lane start forces one); one for-each-ref lists
// every ref with its ahead count, and a branch whose tip and ahead count did not change keeps its files when main moves (none of its
// commits landed, so its merge-base did not move); a lane's HEAD is read from its files (gitfacts.mjs); every child is bounded (jobguard).
import fs from 'node:fs';
import path from 'node:path';
import { loadState, homeOf, fold, readEvents, recordsFile } from './records.mjs';
import { deliverableConfig } from './deliverables.mjs';
import { boundedSync } from './bounded.mjs';
import { headOf, worktreeFacts } from './gitfacts.mjs';

export const OVERLAP_TTL_MS = 10 * 60000;
const MAX_FILES = 8;   // files named per overlap row (the count is always whole)
export const overlapOn = pol => pol?.overlap?.enabled !== false;
export const overlapFile = state => path.join(state, 'overlap.json');

const cli = (exe, timeout) => (args, cwd) => { const r = boundedSync(exe, args, { cwd, timeout, maxBuffer: 64 << 20 }); return r.status === 0 ? String(r.stdout ?? '') : null; };
const gitCli = cli('git', 30000), ghCli = cli('gh', 20000);
const lines = s => String(s ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
const fresh = (now, ts, ttl) => now - ts >= 0 && now - ts < ttl;
// (own tip, their tip, cwd) -> { conflict, files } | null (git failed: no answer, no row)
const mergeTreeCli = (a, b, cwd) => {
  const r = boundedSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { cwd, timeout: 60000, maxBuffer: 64 << 20 });
  return r.status === 0 ? { conflict: false, files: [] } : r.status === 1 ? { conflict: true, files: [...new Set(lines(r.stdout).slice(1))] } : null;
};
const HOME_REF = /^norn\/([a-z][a-z0-9]{0,7})\/./;   // a home's lane branch (SPEC 3.2): norn/<home>/<lane>

/** 'owner/name' of a GitHub remote URL (https, ssh or scp form), else null */
export function githubRepo(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** S6b: the open deliverables of a state dir whose lane does not run (running: Set of lanes): [{ lane, run, branch }] (cross-home conflicts only) */
export function deliverableLanes(state, running) {
  const out = new Map();
  for (const r of Object.values(fold(readEvents(recordsFile(state, 'deliverable'))).items)) if (r.kind === 'deliverable' && r.state === 'open' && r.data?.lane && r.data?.branch && !running.has(r.data.lane)) out.set(r.data.lane, { lane: r.data.lane, run: r.data.run ?? null, branch: r.data.branch });
  return [...out.values()];
}

/** the running work lanes of a state dir: [{ lane, run, worktree }] (one per lane: its newest running run) */
export function runningLanes(st) {
  const out = new Map();
  for (const r of Object.values(st.items)) {
    const d = r.data || {};
    if (r.kind !== 'run' || r.state !== 'running' || !d.lane || !d.worktree || d.role === 'helper' || d.parent || ['checkin', 'audit', 'talk'].includes(d.kind)) continue;
    out.set(d.lane, { lane: d.lane, run: r.id, worktree: d.worktree });
  }
  return [...out.values()];
}

/**
 * Refresh the overlap cache. o: { root (a checkout of the project repo), main ('main'), lanes [{ lane, run, worktree } | { lane, run, branch }
 * (an open deliverable: no worktree)], cacheFile, now (ms), git ((args, cwd) -> stdout | null), gh ((args, cwd) -> stdout | null), ttlMs,
 * force (fetch + gh now), home (this home's id in a synced project, else null: no cross-home check), mergeTree ((a, b, cwd) -> { conflict, files } | null),
 * sig (projectOverlap's words for the lane set: the next tick skips a refresh of the same lanes inside the TTL) }
 * -> the cache: { refresh_ts, sig, fetch_ts, fetch_error, pr_ts, prs, remote: { branch: { sha, base, ahead, files } }, tips: { sha: { sha, base, ahead, files } }
 * (the open deliverables' tips), merges: { 'tipA tipB': { ts, conflict, files } } (the pairs of this refresh), lanes: { lane: { lane, run,
 * branch, at, files, overlaps, conflicts: [{ ref, home, n, files }], open? } } }
 */
export function refreshOverlap({ root, main = 'main', lanes = [], cacheFile, now = Date.now(), git = gitCli, gh = ghCli, ttlMs = OVERLAP_TTL_MS, force = false, home = null, mergeTree = mergeTreeCli, sig = null }) {
  let c = null;
  try { c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { c = null; }
  if (!c || typeof c !== 'object') c = {};
  c = { fetch_ts: -Infinity, fetch_error: null, pr_ts: -Infinity, prs: null, remote: {}, tips: {}, lanes: {}, ...c, refresh_ts: now, sig };
  const merges = c.merges || {}, used = {};
  const url = git(['remote', 'get-url', 'origin'], root);
  if (!url) {   // no origin: nothing upstream to compare with
    c.lanes = {};
    save(cacheFile, c);
    return c;
  }
  if (force || !fresh(now, c.fetch_ts, ttlMs)) {
    const r = git(['fetch', '--prune', '--quiet', 'origin'], root);
    c.fetch_ts = now; c.fetch_error = r === null ? 'git fetch origin failed (offline?): the last fetched refs are used' : null;
  }
  // every local and origin ref in one listing, with its ahead count against main (origin's, else the local one; neither: no counts)
  const list = full => git(['for-each-ref', `--format=%(refname) %(objectname) ${full ? `%(ahead-behind:${full})` : '-'}`, 'refs/heads', 'refs/remotes/origin'], root);
  let baseFull = `refs/remotes/origin/${main}`, raw = list(baseFull);
  if (raw === null) { baseFull = `refs/heads/${main}`; raw = list(baseFull); }
  if (raw === null) { baseFull = null; raw = list(null); }
  const refs = new Map();
  for (const l of lines(raw)) { const [ref, sha, ahead] = l.split(' '); refs.set(ref, { sha, ahead: !ahead || ahead === '-' ? null : Number(ahead) }); }
  const local = new Set([...refs.keys()].filter(r => r.startsWith('refs/heads/')).map(r => r.slice(11)));
  const base = baseFull?.startsWith('refs/remotes/') ? `origin/${main}` : main, baseSha = (baseFull && refs.get(baseFull)?.sha) || '';
  // the files of base...<tip>: kept while the tip and its ahead count stand (none of it landed: the merge-base is the same), else one diff
  const filesOf = (old, sha, ahead, rev) => (old && old.sha === sha && (old.base === baseSha || (ahead !== null && old.ahead === ahead)) ? { ...old, base: baseSha }
    : { sha, base: baseSha, ahead, files: lines(git(['diff', '--name-only', `${base}...${rev}`], root)) });
  const remote = {}, tips = {};
  for (const [full, r] of refs) {
    const b = full.startsWith('refs/remotes/origin/') ? full.slice(20) : null;
    if (!b || b === 'HEAD' || b === main || local.has(b)) continue;
    remote[b] = filesOf(c.remote[b], r.sha, r.ahead, `origin/${b}`);
  }
  c.remote = remote;
  const repo = githubRepo(url);
  if (!repo) c.prs = null;
  else if (force || !fresh(now, c.pr_ts, ttlMs)) {
    let prs = null;
    try { prs = JSON.parse(gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,files,url'], root)); } catch { prs = null; }
    c.pr_ts = now;
    c.prs = Array.isArray(prs) ? prs.map(p => ({ number: p.number, title: p.title ?? '', head: p.headRefName ?? '', url: p.url ?? null, files: (p.files || []).map(f => f.path).filter(Boolean) })) : null;
  }
  const lanesOut = {};
  for (const l of lanes) {
    let branch, tip, files;
    if (l.worktree) {
      const h = headOf(l.worktree);
      branch = h?.branch || null;
      tip = home ? h?.sha || null : null;
      files = baseFull ? worktreeFacts(l.worktree, { main: baseFull, commits: false })?.touched ?? [] : [];
    } else {   // an open deliverable: its branch tip (local, else the pushed one), its commits only
      branch = l.branch;
      const r = refs.get(`refs/heads/${branch}`) || refs.get(`refs/remotes/origin/${branch}`);
      tip = r?.sha || null;
      if (tip) tips[tip] = filesOf(c.tips[tip], tip, r.ahead, tip);
      files = tip ? tips[tip].files : [];
    }
    const mine = new Set(files), hit = fs2 => fs2.filter(f => mine.has(f));
    const overlaps = [], viaPr = new Set();
    for (const p of c.prs || []) {
      if (p.head === branch || local.has(p.head)) continue;
      viaPr.add(p.head);
      const k = hit(p.files);
      if (k.length) overlaps.push({ kind: 'pr', ref: p.head, number: p.number, title: p.title, url: p.url, n: k.length, files: k.slice(0, MAX_FILES) });
    }
    for (const [b, r] of Object.entries(remote)) {
      if (b === branch || viaPr.has(b)) continue;
      const k = hit(r.files);
      if (k.length) overlaps.push({ kind: 'branch', ref: b, n: k.length, files: k.slice(0, MAX_FILES) });
    }
    overlaps.sort((a, b) => b.n - a.n || String(a.ref).localeCompare(String(b.ref)));
    // S6b: a pair with another home's open branch that shares files -> merge-tree (cached per tip pair); exit 1 = a predicted conflict
    const conflicts = [];
    for (const o of home && tip ? overlaps : []) {
      const h = HOME_REF.exec(o.ref)?.[1], theirs = remote[o.ref]?.sha;
      if (!h || h === home || !theirs) continue;
      const k = `${tip} ${theirs}`;
      if (!merges[k]) { const m = mergeTree(tip, theirs, root); if (!m) continue; merges[k] = { ts: now, conflict: m.conflict, files: m.files }; }
      used[k] = merges[k];
      if (merges[k].conflict) conflicts.push({ ref: o.ref, home: h, n: merges[k].files.length, files: merges[k].files.slice(0, MAX_FILES) });
    }
    lanesOut[l.lane] = { lane: l.lane, run: l.run, branch, at: new Date(now).toISOString(), files: files.length, overlaps, conflicts, ...(l.worktree ? {} : { open: 'deliverable' }) };
  }
  c.lanes = lanesOut; c.merges = used; c.tips = tips;
  save(cacheFile, c);
  return c;
}
function save(f, c) { try { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(c)); fs.renameSync(t, f); } catch { /* still answers */ } }

/** refresh for a loaded project (its repo + main as the deliverables see them, p.state, p.policy); null when off or no repo. Never throws. */
export function projectOverlap(p, { now = Date.now(), force = false, git, gh } = {}) {
  if (!p?.state || !overlapOn(p.policy)) return null;
  try {
    const { repo, main } = deliverableConfig(p);
    if (!repo) return null;
    const home = homeOf(p.state)?.id ?? null, lanes = runningLanes(loadState(p.state));
    if (home) lanes.push(...deliverableLanes(p.state, new Set(lanes.map(l => l.lane))));   // S6b: a synced project also checks its open deliverables for cross-home conflicts
    if (!lanes.length) { const c = readOverlap(p.state); if (Object.keys(c.lanes || {}).length) save(overlapFile(p.state), { ...c, lanes: {} }); return { ...c, lanes: {} }; }   // nothing runs: no fetch
    // git-perf S1: the same lanes refreshed within the TTL are not asked again (a lane start passes force)
    const sig = lanes.map(l => `${l.lane} ${l.run} ${l.worktree || l.branch}`).sort().join('\n'), old = readOverlap(p.state);
    if (!force && old.sig === sig && fresh(now, old.refresh_ts ?? -Infinity, OVERLAP_TTL_MS)) return old;
    return refreshOverlap({ root: repo, main, lanes, cacheFile: overlapFile(p.state), now, force, home, sig, ...(git ? { git } : {}), ...(gh ? { gh } : {}) });
  } catch { return null; }
}

/** lane-collide S1c (SPEC 2, territory / conflict): merge-tree of two lanes of ONE home, for the tip pairs the tick found sharing changed
 *  files -> { 'tipA tipB' (sorted): { conflict, files } }. Cached in overlap.json `lane_merges` per tip pair (a pair not asked this pass
 *  leaves it); never throws. */
export function laneConflicts(state, root, pairs, { now = Date.now(), mergeTree = mergeTreeCli } = {}) {
  const c = readOverlap(state), old = c.lane_merges || {}, out = {};
  for (const [a, b] of pairs) {
    const k = [a, b].sort().join(' ');
    if (out[k]) continue;
    if (old[k]) { out[k] = old[k]; continue; }
    try { const m = mergeTree(a, b, root); if (m) out[k] = { ts: now, conflict: m.conflict, files: m.files }; } catch { /* git gone: no grade this pass */ }
  }
  if (Object.keys(out).length || Object.keys(old).length) save(overlapFile(state), { ...readOverlap(state), lane_merges: out });
  return out;
}

/** the cache, read only (the dashboard, the digest); {} when none */
export function readOverlap(state, read = f => fs.readFileSync(f, 'utf8')) {
  try { const t = read(overlapFile(state)); return t ? JSON.parse(t) : {}; } catch { return {}; }
}

/** the chip words of one overlap: "overlaps upstream: PR #12 (3 files)" / "overlaps upstream: feat/x (1 file)" */
export const overlapText = o => `overlaps upstream: ${o.kind === 'pr' ? `PR #${o.number}` : o.ref} (${o.n} file${o.n === 1 ? '' : 's'})`;

/** S6b: the words of a predicted cross-home conflict: "norn/a/x conflicts with norn/b/y (on b): 2 files" */
export const conflictText = (branch, x) => `${branch} conflicts with ${x.ref} (on ${x.home}): ${x.n} file${x.n === 1 ? '' : 's'}`;

/** digest rows: one per overlap of a lane that runs NOW, and one per predicted cross-home conflict of a lane that runs or has an open
 * deliverable NOW (level-triggered: a row leaves when the lane stops or the overlap / conflict goes) */
export function overlapRows(state, items) {
  const c = readOverlap(state), live = new Set(runningLanes({ items }).map(l => l.lane)), open = new Set(homeOf(state) ? deliverableLanes(state, live).map(l => l.lane) : []);
  return Object.values(c.lanes || {}).filter(l => live.has(l.lane) || open.has(l.lane)).flatMap(l => [...(live.has(l.lane) ? l.overlaps || [] : []).map(o => ({
    id: `OVL-${l.lane}-${o.kind === 'pr' ? `pr${o.number}` : o.ref}`, lane: l.lane, run: l.run, branch: l.branch, kind: o.kind, ref: o.ref,
    ...(o.kind === 'pr' ? { number: o.number, title: o.title, url: o.url } : {}), n: o.n, files: o.files, why: overlapText(o) })),
  ...(l.conflicts || []).map(x => ({ id: `CFL-${l.lane}-${x.ref}`, lane: l.lane, run: l.run, branch: l.branch, kind: 'conflict', ref: x.ref, home: x.home, n: x.n, files: x.files, why: conflictText(l.branch, x) }))]);
}
