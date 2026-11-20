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
// (on b): 2 files". The result is cached per (own tip, their tip) under the same TTL. A solo project runs no merge-tree.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { loadState, homeOf, fold, readEvents, recordsFile } from './records.mjs';
import { deliverableConfig } from './deliverables.mjs';

export const OVERLAP_TTL_MS = 10 * 60000;
const MAX_FILES = 8;   // files named per overlap row (the count is always whole)
export const overlapOn = pol => pol?.overlap?.enabled !== false;
export const overlapFile = state => path.join(state, 'overlap.json');

const cli = (exe, timeout) => (args, cwd) => {
  try { return execFileSync(exe, args, { cwd, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 64 * 2 ** 20 }); }
  catch { return null; }
};
const gitCli = cli('git', 30000), ghCli = cli('gh', 20000);
const lines = s => String(s ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
const fresh = (now, ts, ttl) => now - ts >= 0 && now - ts < ttl;
// (own tip, their tip, cwd) -> { conflict, files } | null (git failed: no answer, no row)
const mergeTreeCli = (a, b, cwd) => {
  const r = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b], { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 64 * 2 ** 20 });
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
 * force (fetch + gh now), home (this home's id in a synced project, else null: no cross-home check), mergeTree ((a, b, cwd) -> { conflict, files } | null) }
 * -> the cache: { fetch_ts, fetch_error, pr_ts, prs, remote: { branch: { sha, base, files } }, merges: { 'tipA tipB': { ts, conflict, files } },
 * lanes: { lane: { lane, run, branch, at, files, overlaps, conflicts: [{ ref, home, n, files }], open? } } }
 */
export function refreshOverlap({ root, main = 'main', lanes = [], cacheFile, now = Date.now(), git = gitCli, gh = ghCli, ttlMs = OVERLAP_TTL_MS, force = false, home = null, mergeTree = mergeTreeCli }) {
  let c = null;
  try { c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { c = null; }
  if (!c || typeof c !== 'object') c = {};
  c = { fetch_ts: -Infinity, fetch_error: null, pr_ts: -Infinity, prs: null, remote: {}, lanes: {}, ...c };
  const merges = Object.fromEntries(Object.entries(c.merges || {}).filter(([, m]) => fresh(now, m.ts, ttlMs)));
  if (!git(['remote', 'get-url', 'origin'], root)) {   // no origin: nothing upstream to compare with
    c.lanes = {};
    save(cacheFile, c);
    return c;
  }
  if (force || !fresh(now, c.fetch_ts, ttlMs)) {
    const r = git(['fetch', '--prune', '--quiet', 'origin'], root);
    c.fetch_ts = now; c.fetch_error = r === null ? 'git fetch origin failed (offline?): the last fetched refs are used' : null;
  }
  const local = new Set(lines(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], root)));
  const base = git(['rev-parse', '--verify', '--quiet', `origin/${main}`], root) ? `origin/${main}` : main;
  const baseSha = (git(['rev-parse', '--verify', '--quiet', base], root) || '').trim();
  const remote = {};
  for (const l of lines(git(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes/origin'], root))) {
    const [ref, sha] = l.split(' '), b = ref.replace(/^origin\//, '');
    if (!ref.startsWith('origin/') || b === 'HEAD' || b === main || local.has(b)) continue;
    const old = c.remote[b];
    remote[b] = old && old.sha === sha && old.base === baseSha ? old : { sha, base: baseSha, files: lines(git(['diff', '--name-only', `${base}...${ref}`], root)) };
  }
  c.remote = remote;
  const repo = githubRepo(git(['remote', 'get-url', 'origin'], root));
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
      branch = (git(['rev-parse', '--abbrev-ref', 'HEAD'], l.worktree) || '').trim() || null;
      tip = home ? (git(['rev-parse', '--verify', '--quiet', 'HEAD'], l.worktree) || '').trim() || null : null;
      const mb = (git(['merge-base', 'HEAD', base], l.worktree) || '').trim();
      files = mb ? lines(git(['diff', '--name-only', mb], l.worktree)) : [];
    } else {   // an open deliverable: its branch tip (local, else the pushed one), its commits only
      branch = l.branch;
      tip = (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], root) || git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], root) || '').trim() || null;
      files = tip ? lines(git(['diff', '--name-only', `${base}...${tip}`], root)) : [];
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
      if (merges[k].conflict) conflicts.push({ ref: o.ref, home: h, n: merges[k].files.length, files: merges[k].files.slice(0, MAX_FILES) });
    }
    lanesOut[l.lane] = { lane: l.lane, run: l.run, branch, at: new Date(now).toISOString(), files: files.length, overlaps, conflicts, ...(l.worktree ? {} : { open: 'deliverable' }) };
  }
  c.lanes = lanesOut; c.merges = merges;
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
    return refreshOverlap({ root: repo, main, lanes, cacheFile: overlapFile(p.state), now, force, home, ...(git ? { git } : {}), ...(gh ? { gh } : {}) });
  } catch { return null; }
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
