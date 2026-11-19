// DLV-MERGED-TRUTH: THE merge state of a deliverable (judge) and the per-repo git scanner it reads. Kept apart from deliverables.mjs
// so after.mjs (`--after dlv:`) and records.mjs (the lane archive guard) use the same rule without an import cycle: this module
// imports git helpers and path spelling only, never the records.
import { scanRepo, makeGit, pruneCache, workOnMain, contentOnMain } from './dlvgit.mjs';
import { pathKey } from './config.mjs';

const fwd = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
export const sameRepo = (a, b) => pathKey(a) === pathKey(b);   // the same repo in any spelling (8.3 short name, link, case)
export const lastEv = (it, evs) => [...it.history].reverse().find(h => evs.includes(h.ev)) || null;

// the scanner for one repo, cached in cache[repo]; returns the scan + a finish() that prunes
export function repoScanner({ cfg, cache, git, install }) {
  const scans = new Map();
  const get = repo => {
    const key = fwd(repo).toLowerCase();
    if (!scans.has(key)) {
      const own = sameRepo(repo, cfg.repo);
      const c = cache[key] ||= {};
      let s = null;
      try { s = scanRepo(repo, { main: own ? cfg.main : 'main', remote: cfg.remote, cache: c, git, native: own ? cfg.native : null, installed: own && install ? install.commits : [], history: own ? cfg.history || [] : [] }); } catch { s = null; }
      scans.set(key, { s, c, tips: [], want: [] });
    }
    return scans.get(key);
  };
  const finish = () => { for (const { s, c, tips } of scans.values()) if (s) pruneCache(c, { mainSha: s.mainSha, keepBases: [...s.installed, ...s.history], tips: [...tips, ...[...s.refs.values()].map(r => r.sha)] }); };
  return { get, finish, scans: () => scans.values() };
}

// META-DLV-LANDED: is the WORK of a tip that is no ancestor of main on main (rebase / squash / merged, then main merged into the branch)?
// The one rule of dlvgit.mjs workOnMain, cached per (tip, main, origin main) in the repo's cache
function landedOn(sc, repo, tip, main, remote, git) {
  const o = sc.s.refs.get(`refs/remotes/${remote}/${main}`)?.sha || '', k = `${tip}:${sc.s.mainSha}:${o}`, w = (sc.c.work ||= {});
  if (!(k in w)) w[k] = workOnMain(repo, tip, main, { git });
  return w[k];
}

// the same rule against the EARLIER main lines (deliverables.history, resolved in the scan): a line never moves, so each (tip, line)
// answer is cached until the tip is gone (dlvgit pruneCache), not per main sha
function landedOnHistory(sc, repo, tip, git) {
  const h = (sc.c.hist ||= {});
  return (sc.s.history || []).some(line => { const k = `${tip}:${line}`; if (!(k in h)) h[k] = workOnMain(repo, tip, line, { git }); return h[k]; });
}


// DLV-MERGED-TRUTH: the latch - the newest of create / done / merged / still_open decides: a `merged` after the last DONE = merged
// whatever git says now; a `still_open` ruling = DONE, never 'cannot tell'. -> { merged: event } | { held: event } | null
export function mergeLatch(it) {
  for (const h of [...it.history].reverse()) {
    if (h.ev === 'merged') return { merged: h };
    if (h.ev === 'still_open') return { held: h };
    if (h.ev === 'done' || h.ev === 'create') return null;
  }
  return null;
}

const noScan = tip => ({ tip, exists: null, merged: false, installed: false, behind: null, ahead: null, native: null, native_files: [], ref_date: null, subject: null });

/**
 * DLV-MERGED-TRUTH: THE merge state of one deliverable. Every reader goes through here: the listing and the Inbox / Overview cards
 * (deliverablesView), the digest, `--after dlv:` (after.mjs), the lane archive guard (records.mjs). In order:
 *  1. a latched `merged` event after its last DONE (a merged PR, an earlier git / content answer, the owner's ruling);
 *  2. git: the tip (the branch's, else the one recorded at DONE) on main, or its patches (dlvgit workOnMain), or on an earlier main line;
 *  3. the content check (dlvgit contentOnMain): its own change is on main - 'merged (equivalent)'.
 * Not merged and the branch is gone, the tip is gone or the repo cannot be read: 'cannot tell' with the reason, unless the owner ruled
 * it still open. sc: a repoScanner entry. -> { g (branch info), merge: { how, tip, merge_commit, merged_at, pr, latched } | null,
 * installed, unknown: why | null }
 */
export function judge(it, sc, { cfg, git }) {
  const d = it.data, s = sc.s, main = d.main || (sameRepo(d.repo, cfg.repo) ? cfg.main : 'main');
  const tipAtDone = lastEv(it, ['done'])?.data?.tip || d.tip || null;
  const g = s ? s.info(d.branch, tipAtDone) : noScan(tipAtDone);
  const latch = mergeLatch(it);
  if (latch?.merged) {
    const m = latch.merged.data, installed = g.installed || !!(s && m.merge_commit && s.installed.some(b => s.onBase(m.merge_commit, b)));
    Object.assign(g, { ahead: 0, behind: null });
    return { g, unknown: null, installed, merge: { how: m.how, tip: m.tip ?? g.tip, merge_commit: m.merge_commit ?? null, merged_at: m.merged_at ?? latch.merged.ts, pr: m.pr ?? null, latched: true } };
  }
  const found = (how, installed = g.installed) => ({ g, unknown: null, installed, merge: { how, tip: g.tip, merge_commit: how === 'git' ? g.tip : null, merged_at: null, pr: null, latched: false } });
  if (g.merged) return found('git');
  if (g.tip && s?.mainSha && (landedOn(sc, d.repo, g.tip, main, cfg.remote || 'origin', git) || landedOnHistory(sc, d.repo, g.tip, git))) { Object.assign(g, { merged: true, ahead: 0 }); return found('git'); }
  let why = !s ? `the repo ${fwd(d.repo)} cannot be read` : !g.tip ? `no tip was recorded at DONE and the branch ${d.branch} is gone` : null;
  if (!why && s.mainSha) {
    const c = equivOn(sc, d.repo, g.tip, s.mainSha, main, git);
    if (c.on) { Object.assign(g, { ahead: 0, behind: null }); return found('equivalent', s.installed.some(b => equivOn(sc, d.repo, g.tip, b, b, git).on)); }
    if (c.on === null) why = c.why;
  }
  if (!why && g.exists === false) why = `the branch ${d.branch} is deleted and its change is not on main as it was (rebased with edits, or dropped)`;
  return { g, merge: null, installed: false, unknown: latch?.held ? null : why };
}
// the content check of a tip against one base commit (main's sha, or an install's), cached per (tip, base) in the repo's cache
function equivOn(sc, repo, tip, base, ref, git) {
  const q = (sc.c.equiv ||= {}), k = `${tip}:${base}`;
  if (!(k in q)) q[k] = contentOnMain(repo, tip, ref, { git });
  return q[k];
}

/** DLV-MERGED-TRUTH: judge() for one deliverable item outside a listing (after.mjs `--after dlv:`, the lane archive guard): its own scan */
export function dlvMerged(it, { git = makeGit(), cfg = { repo: '', main: 'main', remote: 'origin', native: null, history: [] } } = {}) {
  const j = judge(it, repoScanner({ cfg, cache: {}, git, install: null }).get(it.data.repo), { cfg, git });
  return { merged: !!j.merge, how: j.merge?.how ?? null, unknown: j.unknown };
}

/** DLV-MERGED-TRUTH: a row's state in words: installed | merged | merged (PR #n) | merged (equivalent) | cannot tell if merged: why | done */
export const stateWord = r => r.state === 'unknown' ? `cannot tell if merged: ${r.unknown_why}` : r.state === 'done' ? 'done'
  : r.merged_how === 'equivalent' ? `${r.state} (equivalent)` : r.merged_how === 'pr' && r.merge_pr ? `${r.state} (PR #${r.merge_pr})` : r.state;
