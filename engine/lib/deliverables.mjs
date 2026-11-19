// Deliverables (the Norn project's design/DELIVERABLES-SPEC.md): follow every lane's finished work to main and to an install.
// Records: kind `deliverable` (DLV-n) in deliverables.jsonl (records.mjs). State DONE -> MERGED -> INSTALLED is derived here (dlvMerged:
// the latched `merged` event, git, the content check) and from the newest install receipt (project.json `deliverables.receipts`).
// DLV-MERGED-TRUTH: the tick (latchMerged) asks GitHub about each recorded PR and latches every MERGED answer as a `merged` event, so
// a rebased landing or a deleted branch never turns merged work back into DONE; what cannot be decided asks the owner for one ruling.
import fs from 'node:fs';
import path from 'node:path';
import { fold, readEvents, recordsFile, loadState, record } from './records.mjs';
import { scanRepo, makeGit, pruneCache, workOnMain, contentOnMain } from './dlvgit.mjs';
import { pathKey } from './config.mjs';
import { POLICY_DEFAULTS } from './policy.mjs';

export const DEFAULTS = { main: 'main', remote: 'origin', branches: ['feat/*', 'fix/*'], native: null, receipts: [],
  receipt_keys: ['main_merge', 'main_pins_changelog', 'source_head'], receipt_re: '\\bmain\\s+([0-9a-f]{7,40})\\b',
  target: 'install', ask_after_h: 24, park_days: 7, resolve_behind: 100 };
const DAY = 864e5;
export const fwd = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
export const sameRepo = (a, b) => pathKey(a) === pathKey(b);   // the same repo in any spelling (8.3 short name, link, case)

// project.json `deliverables` over the defaults; repo defaults to the project root
export function deliverableConfig(project = {}) {
  const d = project.deliverables || {};
  return { ...DEFAULTS, ...d, repo: fwd(d.repo || project.root || '') };
}

export const loadDeliverables = stateDir => {
  const items = fold(readEvents(recordsFile(stateDir, 'deliverable'))).items;
  return Object.fromEntries(Object.entries(items).filter(([, i]) => i.kind === 'deliverable'));
};

// ---------- install receipts: the newest file matching the configured globs ----------
function expandGlob(pattern) {
  const parts = fwd(pattern).split('/');
  let bases = [parts[0] === '' ? '/' : parts[0] + (parts[0].endsWith(':') ? '/' : '')];
  for (const seg of parts.slice(1)) {
    const next = [];
    if (!/[*?]/.test(seg)) { for (const b of bases) next.push(path.join(b, seg)); }
    else {
      const re = new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      for (const b of bases) { try { for (const n of fs.readdirSync(b)) if (re.test(n)) next.push(path.join(b, n)); } catch { /* missing dir */ } }
    }
    bases = next;
  }
  return bases.filter(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
}
export function lastInstall(cfg) {
  const files = [...new Set((cfg.receipts || []).flatMap(expandGlob))].map(f => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
  if (!files.length) return null;
  const { f, t } = files[0];
  const text = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
  let commits = [];
  if (/\.json$/i.test(f)) {
    try {
      const j = JSON.parse(text);
      commits = cfg.receipt_keys.map(k => j[k]).filter(v => typeof v === 'string').map(v => v.match(/\b[0-9a-f]{7,40}\b/)?.[0]).filter(Boolean);
    } catch { commits = []; }
  } else {
    const m = text.match(new RegExp(cfg.receipt_re));
    if (m) commits = [m[1]];
  }
  return { file: fwd(f), mtime: new Date(t).toISOString(), commits };
}

// ---------- git cache (one file per state dir; rewritten only when it changed) ----------
const cacheFile = stateDir => path.join(stateDir, 'deliverables-cache.json');
function readCache(stateDir) {
  try { return JSON.parse(fs.readFileSync(cacheFile(stateDir), 'utf8')); } catch { return {}; }
}
function writeCache(stateDir, cache, before) {
  const s = JSON.stringify(cache);
  if (s === before) return;
  const tmp = cacheFile(stateDir) + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, s); fs.renameSync(tmp, cacheFile(stateDir)); } catch { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
}

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

const lastEv = (it, evs) => [...it.history].reverse().find(h => evs.includes(h.ev)) || null;

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
function judge(it, sc, { cfg, git }) {
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
export function dlvMerged(it, { git = makeGit(), project = {} } = {}) {
  const cfg = deliverableConfig(project), j = judge(it, repoScanner({ cfg, cache: {}, git, install: null }).get(it.data.repo), { cfg, git });
  return { merged: !!j.merge, how: j.merge?.how ?? null, unknown: j.unknown };
}

/** DLV-MERGED-TRUTH: a row's state in words: installed | merged | merged (PR #n) | merged (equivalent) | cannot tell if merged: why | done */
export const stateWord = r => r.state === 'unknown' ? `cannot tell if merged: ${r.unknown_why}` : r.state === 'done' ? 'done'
  : r.merged_how === 'equivalent' ? `${r.state} (equivalent)` : r.merged_how === 'pr' && r.merge_pr ? `${r.state} (PR #${r.merge_pr})` : r.state;


/**
 * One row per deliverable. opts: { stateDir, project, now (ms), git (makeGit()), questions (records items, default loaded) }
 * Row: id, record_state open|parked, state done|merged|installed|unknown (cannot tell), state_word, merged_how pr|git|equivalent|ruling,
 * merge_commit, merged_at, merge_pr, merge_latched, unknown_why, ruling (the open Q-n asking the owner), target, at_target, repo, branch, lane, run, delivers, subject (the tip's), tip,
 * done_utc, days, behind, ahead, native, native_files, park {why, days, expired} | null, asked (Q-n since the last park) | null, due.
 */
export function deliverablesView({ stateDir, project = {}, now = Date.now(), git = makeGit(), questions = null } = {}) {
  const t0 = Date.now();
  const cfg = deliverableConfig(project);
  const items = Object.values(loadDeliverables(stateDir));
  const cache = readCache(stateDir), before = JSON.stringify(cache);
  const install = lastInstall(cfg);
  const scanner = repoScanner({ cfg, cache, git, install });
  const qs = questions || (() => { try { return Object.values(fold(readEvents(recordsFile(stateDir, 'question'))).items).filter(i => i.kind === 'question'); } catch { return []; } })();
  const rulingOf = id => qs.find(q => q.data?.deliverable === id && q.data?.ruling && q.state === 'open')?.id ?? null;   // the open 'cannot tell' ruling
  const later = items.map(it => {
    const d = it.data, lastDone = lastEv(it, ['done']);
    const doneUtc = lastDone?.data?.done_utc || lastDone?.ts || d.done_utc || it.created;
    const tipAtDone = lastDone?.data?.tip || d.tip || null;
    const target = d.target || (sameRepo(d.repo, cfg.repo) ? cfg.target : 'main');
    const sc = scanner.get(d.repo);
    const j = judge(it, sc, { cfg, git }), g = j.g, m = j.merge;   // DLV-MERGED-TRUTH: the one rule
    if (g.tip) sc.tips.push(g.tip);
    const state = m ? (j.installed && target === 'install' ? 'installed' : 'merged') : j.unknown ? 'unknown' : 'done';
    const at_target = target === 'main' ? state === 'merged' || state === 'installed' : state === 'installed';
    const parkEv = it.state === 'parked' ? lastEv(it, ['park']) : null;
    // META-GTP-MERGEQ piece 0: superseded = terminal (the work landed another way): at its target, never due / resolved / rehearsed
    const supEv = it.state === 'superseded' ? lastEv(it, ['supersede']) : null;
    const prEv = lastEv(it, ['pr']), pr = prEv?.data?.url ? { url: prEv.data.url, number: prEv.data.number ?? null } : null;   // the PR norn merge-land opened
    const superseded = supEv ? { by: supEv.data.by, why: supEv.data.why, at: supEv.ts } : null;
    const park = parkEv ? { why: parkEv.data.why, by: parkEv.by, at: parkEv.ts, days: +((now - Date.parse(parkEv.ts)) / DAY).toFixed(1),
      expired: now - Date.parse(parkEv.ts) > cfg.park_days * DAY } : null;
    const since = Date.parse((lastEv(it, ['park', 'unpark']) || it.history[0]).ts);
    const asked = qs.filter(q => q.data?.deliverable === it.id && !q.data?.ruling && Date.parse(q.created) >= since).sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0]?.id ?? null;
    const days = +((now - Date.parse(doneUtc)) / DAY).toFixed(1);
    const due = !superseded && state === 'done' && now - Date.parse(doneUtc) > cfg.ask_after_h * 3600e3 && (!park || park.expired) && !asked;
    // META-DLV-R2: the merge rehearsal of a DONE tip onto main, and the resolve flag (conflict, or more than resolve_behind behind)
    const rehearses = !superseded && state === 'done' && sc.s && g.tip;
    if (rehearses) sc.want.push(g.tip);
    return () => {   // the rehearsals of every row first, batched per repo (ENGINE-GIT, DEC-88: one merge-tree per repo)
    const rehearsal = rehearses ? sc.s.rehearse(g.tip) : null;
    const resolve = state !== 'done' || superseded ? null : rehearsal && !rehearsal.clean ? { why: `conflict: ${rehearsal.files.join(', ')}` }
      : Number.isFinite(g.behind) && g.behind > cfg.resolve_behind ? { why: `${g.behind} behind main (> ${cfg.resolve_behind})` } : null;
    return { id: it.id, record_state: it.state, state, target, at_target: at_target || !!superseded, repo: fwd(d.repo), branch: d.branch, lane: d.lane ?? null, run: lastDone?.data?.run || d.run || null,
      delivers: d.delivers ?? g.subject ?? '', subject: g.subject ?? null, tip: g.tip, done_tip: tipAtDone, branch_exists: g.exists ?? null, done_utc: doneUtc, days, behind: g.behind, ahead: g.ahead,
      native: g.native, native_files: g.native_files, pr, park, asked, due, rehearsal, resolve, ...(superseded ? { superseded } : {}),
      merged_how: m?.how ?? null, merge_commit: m?.merge_commit ?? null, merged_at: m?.merged_at ?? null, merge_pr: m?.pr ?? null, merge_latched: !!m?.latched,
      unknown_why: j.unknown, ruling: rulingOf(it.id) };
    };
  });
  for (const sc of scanner.scans()) if (sc.s && sc.want.length) sc.s.rehearseMany(sc.want);
  const rows = later.map(f => f()).map(r => ({ ...r, state_word: stateWord(r) }));
  scanner.finish();
  writeCache(stateDir, cache, before);
  rows.sort((a, b) => b.days - a.days);
  return { rows, install, git: { calls: git.calls, ms: Date.now() - t0 } };
}

// ---------- backfill (DELIVERABLES-SPEC 2) + the launcher's record at a DONE exit ----------
const NOT_DELIVERING = ['checkin', 'talk', 'interactive', 'fake', 'audit'];
// a resume (--parent RUN-n: the lane's first run handed off) delivers like any worker - its DONE is often the lane's only one; a
// helper (role helper, under a parent) never does. A parent alone used to exclude the run, so a lane finished by a resume never
// reached the merge queue.
const isDeliveringRun = r => r?.kind === 'run' && r.end?.outcome === 'done' && !NOT_DELIVERING.includes(r.data?.kind) && r.data?.role !== 'helper';
const isMainBranch = b => !b || b === 'HEAD' || b === 'main' || b === 'master';
const endTs = r => r.history.find(h => h.ev === 'end')?.ts || r.updated;
const runNum = id => Number(String(id).replace(/\D/g, ''));
function heading(file) {
  if (!file) return null;
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^#\s+(.+)$/m);
    return m ? m[1].trim().slice(0, 160) : null;
  } catch { return null; }
}
// `git worktree list` of the project repo (one call) + per-path fallback for worktrees of other repos
function worktrees(repo, git) {
  const map = new Map();
  const out = git(repo, ['worktree', 'list', '--porcelain'], { allowFail: true }) || '';
  let cur = null;
  for (const l of out.split('\n')) {
    if (l.startsWith('worktree ')) cur = pathKey(l.slice(9));
    else if (l.startsWith('branch ') && cur) map.set(cur, { repo: fwd(repo), branch: l.slice(7).replace(/^refs\/heads\//, '') });
  }
  const seen = new Map();
  return wt => {
    if (!wt) return null;
    const k = pathKey(wt);
    if (map.has(k)) return map.get(k);
    if (seen.has(k)) return seen.get(k);
    let r = null;
    if (fs.existsSync(wt)) {
      const o = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD', '--git-common-dir'], { allowFail: true });
      if (o) {
        const [branch, common] = o.trim().split(/\r?\n/);
        const abs = path.resolve(wt, common);
        r = { repo: fwd(path.basename(abs) === '.git' ? path.dirname(abs) : abs), branch };
      }
    }
    seen.set(k, r);
    return r;
  };
}
const findDlv = (items, repo, branch) => Object.values(items).find(i => sameRepo(i.data.repo, repo) && i.data.branch === branch) || null;

/** Dry run: { rows [{ repo, branch, tip, evidence RUN-n | null (a DONE run; a lane's NOTES are never evidence: gap #3), run, lane, delivers, done_utc, days, behind, ahead, native, action }], scanned, merged, install, git } */
export function backfillPlan({ stateDir, project = {}, now = Date.now(), git = makeGit() } = {}) {
  const t0 = Date.now();
  const cfg = deliverableConfig(project);
  const cache = readCache(stateDir), before = JSON.stringify(cache);
  const install = lastInstall(cfg);
  const scanner = repoScanner({ cfg, cache, git, install });
  const st = loadState(stateDir);
  const existing = loadDeliverables(stateDir);
  const cand = new Map();
  const key = (repo, b) => pathKey(repo) + '|' + b;
  const own = scanner.get(cfg.repo);
  if (own.s) for (const b of own.s.branches(cfg.branches)) cand.set(key(cfg.repo, b), { repo: cfg.repo, branch: b });
  const wtOf = worktrees(cfg.repo, git);
  for (const r of Object.values(st.items).filter(isDeliveringRun).sort((a, b) => runNum(a.id) - runNum(b.id))) {
    const w = wtOf(r.data.worktree);
    if (!w || isMainBranch(w.branch) || w.branch === cfg.main) continue;
    const k = key(w.repo, w.branch);
    cand.set(k, { ...(cand.get(k) || { repo: w.repo, branch: w.branch }), run: r.id, lane: r.data.lane ?? null, done_utc: endTs(r), brief: r.data.brief, notes: r.data.notes });
  }
  let merged = 0;
  const rows = [];
  for (const c of cand.values()) {
    const sc = scanner.get(c.repo);
    if (!sc.s) continue;
    const i = sc.s.info(c.branch);
    if (!i.tip) continue;
    sc.tips.push(i.tip);
    if (i.merged) { merged++; continue; }
    const evidence = c.run || null, notes = c.notes || null, lane = c.lane ?? null;
    let done = c.done_utc || null;
    done ||= i.ref_date ? new Date(i.ref_date).toISOString() : null;
    const ex = findDlv(existing, c.repo, c.branch);
    rows.push({ repo: fwd(c.repo), branch: c.branch, tip: i.tip, evidence, run: c.run || null, lane, notes, delivers: heading(c.brief) || heading(notes) || i.subject || '',
      done_utc: done, days: done ? +((now - Date.parse(done)) / DAY).toFixed(1) : null, behind: i.behind, ahead: i.ahead, native: i.native, native_files: i.native_files,
      action: ex ? `exists ${ex.id}` : evidence ? 'create' : 'skip: no DONE evidence' });
  }
  scanner.finish();
  writeCache(stateDir, cache, before);
  rows.sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  return { rows, scanned: cand.size, merged, install, git: { calls: git.calls, ms: Date.now() - t0 } };
}

/** --apply: create the `create` rows (all: the no-evidence rows too; only: exactly these branches). Returns [{ id, branch }]. */
export function applyBackfill(stateDir, plan, { by = 'controller', all = false, only = null, now } = {}) {
  const made = [];
  for (const r of plan.rows) {
    if (r.action.startsWith('exists')) continue;
    if (only ? !only.includes(r.branch) : !(r.action === 'create' || (all && r.action.startsWith('skip: no DONE')))) continue;
    const data = Object.fromEntries(Object.entries({ repo: r.repo, branch: r.branch, tip: r.tip, lane: r.lane, run: r.run, delivers: r.delivers || r.branch, done_utc: r.done_utc, source: 'backfill' })
      .filter(([, v]) => v !== null && v !== undefined && v !== ''));
    const e = record(stateDir, { kind: 'deliverable', ev: 'create', by, data }, { views: false, ...(now ? { now } : {}) });
    made.push({ id: e.id, branch: r.branch });
  }
  return made;
}

const pad = (s, n) => { s = String(s ?? '-'); return s.length > n ? s.slice(0, n - 1) + '~' : s.padEnd(n); };
export function formatBackfill(plan) {
  const head = `${pad('branch', 34)} ${pad('evidence', 9)} ${pad('days', 6)} ${pad('behind', 6)} ${pad('ahead', 5)} ${pad('native', 6)} ${pad('action', 24)} delivers`;
  const lines = plan.rows.map(r => `${pad(r.branch, 34)} ${pad(r.evidence, 9)} ${pad(r.days, 6)} ${pad(r.behind, 6)} ${pad(r.ahead, 5)} ${pad(r.native === null ? '?' : r.native ? 'yes' : 'no', 6)} ${pad(r.action, 24)} ${pad(r.delivers, 70).trimEnd()}`);
  return [head, ...lines, `${plan.rows.length} not on main (${plan.rows.filter(r => r.action === 'create').length} to create, ${plan.rows.filter(r => r.action.startsWith('skip')).length} without DONE evidence, ${plan.rows.filter(r => r.action.startsWith('exists')).length} already tracked); ${plan.merged} already on main; ${plan.scanned} scanned; git ${plan.git.calls} calls ${plan.git.ms} ms`].join('\n');
}

/** The launcher, after a run's `end` with outcome done: create the branch's deliverable, or append `done` to the existing one. */
export function onRunDone(stateDir, runId, { now, git = makeGit() } = {}) {
  const r = loadState(stateDir).items[runId];
  if (!isDeliveringRun(r)) return null;
  let info = null;
  if (r.data.worktree && fs.existsSync(r.data.worktree)) {
    // two calls: --abbrev-ref is sticky in one rev-parse, so a trailing HEAD there prints the branch name, not the sha
    const o = git(r.data.worktree, ['rev-parse', '--abbrev-ref', 'HEAD', '--git-common-dir'], { allowFail: true });
    const tip = o && git(r.data.worktree, ['rev-parse', 'HEAD'], { allowFail: true })?.trim();
    if (o && tip) {
      const [branch, common] = o.trim().split(/\r?\n/);
      const abs = path.resolve(r.data.worktree, common);
      info = { branch, tip, repo: fwd(path.basename(abs) === '.git' ? path.dirname(abs) : abs) };
    }
  }
  if (!info || isMainBranch(info.branch)) return null;
  const opts = { views: false, ...(now ? { now } : {}) };
  const done_utc = endTs(r);
  const ex = findDlv(loadDeliverables(stateDir), info.repo, info.branch);
  if (ex) return record(stateDir, { kind: 'deliverable', ev: 'done', id: ex.id, by: 'launcher', data: { run: r.id, tip: info.tip, done_utc } }, opts);
  const delivers = heading(r.data.brief) || heading(r.data.notes) || info.branch;
  const data = Object.fromEntries(Object.entries({ repo: info.repo, branch: info.branch, tip: info.tip, lane: r.data.lane, run: r.id, delivers, done_utc, source: 'run' }).filter(([, v]) => v));
  return record(stateDir, { kind: 'deliverable', ev: 'create', by: 'launcher', data }, opts);
}

// the merge rehearsal in a few words (META-DLV-R2): clean | conflict: a, b, c +n | '' (none: merged, or git failed)
// MERGE-FIRST (4): the merge backlog = the finished work not on its way to main yet - DONE, not merged, open (not parked, not
// superseded) and no PR opened. The Lanes, Plan and Overview pages show it; over policy.merge.backlog_max the digest tells the check-in
// to land work before it starts new lanes (digest row 0c).
/** -> { n, oldest_h, ids, max, over (n > max), text ("merge backlog: 4, oldest 13h": the one line every page shows) }; max = backlogMax(policy) */
export function mergeBacklog(rows = [], { now = Date.now(), max = POLICY_DEFAULTS.merge.backlog_max } = {}) {
  const b = rows.filter(r => r.state === 'done' && r.record_state === 'open' && !r.superseded && !r.pr);
  const oldest = Math.min(...b.map(r => Date.parse(r.done_utc)).filter(Number.isFinite));
  const oldest_h = Number.isFinite(oldest) ? +Math.max(0, (now - oldest) / 3600e3).toFixed(1) : null;
  return { n: b.length, oldest_h, ids: b.map(r => r.id), max, over: b.length > max,
    text: `merge backlog: ${b.length}${b.length && oldest_h !== null ? `, oldest ${oldest_h < 1 ? '<1' : Math.round(oldest_h)}h` : ''}` };
}
export const backlogMax = policy => policy?.merge?.backlog_max ?? POLICY_DEFAULTS.merge.backlog_max;
export const rehearsalWord = r => !r.rehearsal ? '' : r.rehearsal.clean ? 'clean'
  : `conflict: ${r.rehearsal.files.slice(0, 3).join(', ')}${r.rehearsal.files.length > 3 ? ` +${r.rehearsal.files.length - 3}` : ''}`;
// one listing line: id, state, age, behind main, native, branch, its PR, how it merged / why Norn cannot tell, park / question, merge
// rehearsal, what it delivers
export function formatDeliverable(r) {
  const how = r.state === 'unknown' ? `${r.state_word}${r.ruling ? ` (ruling ${r.ruling})` : ''}` : r.merged_how === 'equivalent' || r.merged_how === 'ruling' ? `merged (${r.merged_how})` : '';
  const flag = [how, r.superseded ? `superseded by ${r.superseded.by}: ${r.superseded.why}` : r.park ? `parked ${Math.floor(r.park.days)}d${r.park.expired ? ' (expired)' : ''}: ${r.park.why}` : r.asked ? `asked ${r.asked}` : r.due ? 'DUE' : ''].filter(Boolean).join(' | ');
  const mt = rehearsalWord(r);
  return [r.id, pad(r.state, 9), pad(`${r.days}d`, 7), pad(r.behind === null ? '' : `-${r.behind}`, 6), pad(r.native === null ? '?' : r.native ? 'native' : '', 6),
    pad(r.branch, 34), r.pr ? `PR #${r.pr.number ?? '?'} |` : '', flag ? flag + ' |' : '', mt ? mt + ' |' : '', pad(r.delivers, 80).trimEnd()].join(' ').replace(/ +\| ?$/, '');
}

/**
 * The check-in's question for a due deliverable (DELIVERABLES-SPEC 4): ONE per deliverable per park cycle, never one per tick.
 * Refuses (returns { refused }) when the deliverable is merged, already asked since its last park / unpark, or parked and quiet.
 * opts: { project, by (checkin | controller), now (() => Date, the record clock), nowMs (view clock), git }
 */
export function askDeliverable(stateDir, id, { project = {}, by = 'checkin', now, nowMs, git } = {}) {
  const cfg = deliverableConfig(project);
  const row = deliverablesView({ stateDir, project, now: nowMs ?? (now ? now().getTime() : Date.now()), ...(git ? { git } : {}) }).rows.find(r => r.id === id);
  if (!row) return { refused: `${id} does not exist` };
  if (row.state !== 'done') return { refused: `${id} is ${row.state}: nothing to ask` };
  if (row.superseded) return { refused: `${id} is superseded by ${row.superseded.by}: nothing to ask` };
  if (row.asked) return { refused: `${id} already asked ${row.asked} (one question per deliverable; a park resurfaces after ${cfg.park_days} d)` };
  if (row.park && !row.park.expired) return { refused: `${id} is parked (${row.park.why}); it comes back after ${cfg.park_days} d` };
  const days = Math.floor(row.days);
  let title = `${id} ${row.branch}: done ${days} d, not on main - merge, batch or park?`;
  if (title.length > 120) title = title.slice(0, 119) + '~';
  const nat = row.native === null ? 'native: unknown' : row.native ? `NATIVE (${row.native_files.join(', ')}${row.native_files.length >= 5 ? ', ...' : ''})` : 'no native code';
  const body = [`${id}: ${row.delivers}`, `repo ${row.repo}, branch ${row.branch} at ${String(row.tip).slice(0, 9)}, lane ${row.lane ?? '-'}, DONE run ${row.run ?? '-'} (${row.done_utc})`,
    `${row.behind ?? '?'} commits behind main, ${row.ahead ?? '?'} ahead; ${nat}; target ${row.target}.`,
    ...(row.park ? [`Was parked ${Math.floor(row.park.days)} d ago (${row.park.why}); the park expired after ${cfg.park_days} d.`] : [])].join('\n');
  const options = [
    { key: 'merge', text: row.native ? 'merge it: native-touching, so through a door (the install path); the controller runs it' : 'merge it to main (the controller merges; no native rebuild)', cost: row.native ? 'a door' : 'a merge' },
    { key: 'batch', text: `batch it into the next fast install: \`norn deliverables park ${id} --why "batched: <install>"\``, cost: 'waits for that install' },
    { key: 'park', text: `park it with the owner's reason: \`norn deliverables park ${id} --why "<reason>"\`; it comes back after ${cfg.park_days} d`, cost: 'stays unmerged' },
  ];
  const data = { title, lane: row.lane ?? row.branch.split('/').pop(), body, options,
    recommend: { key: 'merge', why: `finished work belongs on main (rule 9: the proper option first); it is ${row.behind ?? '?'} commits behind and drifting`, from: by },
    class: 'iii', blocks: [], source: `deliverable ${id}`, deliverable: id };
  const e = record(stateDir, { kind: 'question', ev: 'create', by, data }, { views: project.views || {}, ...(now ? { now } : {}) });
  return { id: e.id };
}

/**
 * A "merge, batch or park?" question goes stale once its deliverable reaches its target (merged / installed / superseded): the
 * tick withdraws it, so the owner's Inbox never asks about work that already landed. Returns [{ q, dlv, why }] (written unless dry).
 */
export function closeLandedQuestions(stateDir, { project = {}, now, nowMs, git, dry = false } = {}) {
  const open = Object.values(fold(readEvents(recordsFile(stateDir, 'question'))).items)
    .filter(q => q.kind === 'question' && q.state === 'open' && q.data?.deliverable);
  if (!open.length) return [];
  const rows = new Map(deliverablesView({ stateDir, project, now: nowMs ?? (now ? now().getTime() : Date.now()), ...(git ? { git } : {}), questions: open }).rows.map(r => [r.id, r]));
  const out = [];
  for (const q of open) {
    const r = rows.get(q.data.deliverable);
    if (!r?.at_target) continue;
    const why = `${r.id} ${r.branch} is ${r.superseded ? `superseded by ${r.superseded.by}` : r.state}: nothing left to ask (closed by the tick)`;
    if (!dry) record(stateDir, { kind: 'question', ev: 'withdraw', id: q.id, by: 'checkin', data: { why } }, { views: project.views || {}, ...(now ? { now } : {}) });
    out.push({ q: q.id, dlv: r.id, why });
  }
  return out;
}

// ---------- DLV-MERGED-TRUTH: the tick latches merges, and asks / applies the 'cannot tell' rulings ----------
const prFile = stateDir => path.join(stateDir, 'deliverables-pr.json');
const PR_TTL = 10 * 60e3;   // an open PR is asked again at most every 10 min (the tick runs every 15); a merged / closed answer is final
export const RULING = { merged: 'merged', open: 'open' };   // the option keys of a ruling question

/**
 * latchMerged(stateDir, { project, git, gh ((args) -> { code, out, err }) | null = no PR step, now (() => Date), nowMs, dry }) ->
 * [{ dlv, ev, why }] (written unless dry). The page polls never call this; they read what it wrote (deliverablesView).
 *  1. an open / parked deliverable with a recorded PR and no merge latched since its last DONE: `gh pr view <url> --json
 *     state,mergedAt,mergeCommit` (cached in deliverables-pr.json) - merged at or after its last DONE = a `merged` event
 *     { how: pr, pr, url, merge_commit, merged_at };
 *  2. an answered ruling question: merged -> `merged` { how: ruling, q }, open -> `still_open` { q }; the question is applied;
 *  3. a row git or the content check finds merged, nothing latched yet = a `merged` event { how: git | equivalent, tip };
 *  4. a row that cannot tell, open, never asked since its last DONE: ONE ruling question (mark merged / still open); an open ruling
 *     whose row can tell again is withdrawn.
 */
export function latchMerged(stateDir, { project = {}, git = makeGit(), gh = null, now, nowMs, dry = false } = {}) {
  const out = [], t = nowMs ?? (now ? now().getTime() : Date.now()), at = now ? { now } : {};
  const dlv = (ev, id, data, why) => { if (!dry) record(stateDir, { kind: 'deliverable', ev, id, by: 'checkin', data }, { views: false, ...at }); out.push({ dlv: id, ev, why }); };
  const q = (e, why) => { if (!dry) record(stateDir, { kind: 'question', by: 'checkin', ...e }, { views: project.views || {}, ...at }); out.push({ dlv: e.data.deliverable ?? e.dlv, ev: `question ${e.ev}`, why }); };
  const lastDoneAt = it => { const e = lastEv(it, ['done', 'create']); return Date.parse(e?.data?.done_utc || e?.ts); };
  const open = () => Object.values(loadDeliverables(stateDir)).filter(i => ['open', 'parked'].includes(i.state) && !mergeLatch(i)?.merged);
  if (gh) {
    let cache = {}; try { cache = JSON.parse(fs.readFileSync(prFile(stateDir), 'utf8')); } catch { cache = {}; }
    const before = JSON.stringify(cache);
    for (const it of open()) {
      const p = lastEv(it, ['pr'])?.data;
      if (!p?.url) continue;
      let c = cache[p.url];
      if (!c || (c.state === 'OPEN' && t - Date.parse(c.at) > PR_TTL)) {
        const r = gh(['pr', 'view', p.url, '--json', 'state,mergedAt,mergeCommit']);
        let j = null; try { j = r.code === 0 ? JSON.parse(r.out) : null; } catch { j = null; }
        if (!j?.state) continue;   // gh absent / offline / not logged in: asked again next tick
        c = cache[p.url] = { at: new Date(t).toISOString(), state: j.state, merged_at: j.mergedAt || null, merge_commit: j.mergeCommit?.oid || null };
      }
      if (c.state === 'MERGED' && c.merged_at && Date.parse(c.merged_at) >= lastDoneAt(it))
        dlv('merged', it.id, { how: 'pr', pr: p.number ?? null, url: p.url, merged_at: c.merged_at, ...(c.merge_commit ? { merge_commit: c.merge_commit } : {}) }, `PR #${p.number ?? '?'} merged ${c.merged_at}`);
    }
    if (!dry && JSON.stringify(cache) !== before) { const tmp = prFile(stateDir) + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, prFile(stateDir)); }
  }
  const qs = () => Object.values(fold(readEvents(recordsFile(stateDir, 'question'))).items).filter(x => x.kind === 'question' && x.data?.ruling && x.data?.deliverable);
  const byId = loadDeliverables(stateDir);
  for (const x of qs().filter(x => x.state === 'answered')) {
    const it = byId[x.data.deliverable], choice = x.answer?.choice;
    if (!Object.values(RULING).includes(choice)) continue;   // free words, no option: the check-in reads them
    if (it && ['open', 'parked'].includes(it.state) && !mergeLatch(it)?.merged) {
      if (choice === RULING.merged) dlv('merged', it.id, { how: 'ruling', q: x.id, why: String(x.answer.text || 'the owner ruled it merged').slice(0, 600) }, `${x.id}: the owner ruled it merged`);
      else dlv('still_open', it.id, { q: x.id, ...(x.answer.text ? { why: String(x.answer.text).slice(0, 600) } : {}) }, `${x.id}: the owner ruled it still open`);
    }
    q({ ev: 'apply', id: x.id, data: { refs: [x.data.deliverable] }, dlv: x.data.deliverable }, `${x.id} applied`);
  }
  const rows = deliverablesView({ stateDir, project, now: t, git }).rows, items = loadDeliverables(stateDir), asked = qs();
  for (const r of rows) {
    const it = items[r.id];
    if (!it || !['open', 'parked'].includes(it.state)) continue;
    if (r.merged_how && !r.merge_latched)
      dlv('merged', r.id, { how: r.merged_how, ...(r.tip ? { tip: r.tip } : {}), ...(r.merge_commit ? { merge_commit: r.merge_commit } : {}) }, r.state_word);
    const openQ = asked.find(x => x.data.deliverable === r.id && x.state === 'open');
    if (r.state !== 'unknown') { if (openQ) q({ ev: 'withdraw', id: openQ.id, data: { why: `${r.id} is ${r.state_word}: no ruling needed (closed by the tick)` }, dlv: r.id }, `${openQ.id} withdrawn`); continue; }
    if (it.state !== 'open' || openQ || asked.some(x => x.data.deliverable === r.id && Date.parse(x.created) >= lastDoneAt(it))) continue;
    let title = `${r.id} ${r.branch}: cannot tell if merged - mark merged or still open?`;
    if (title.length > 120) title = title.slice(0, 119) + '~';
    const body = [`${r.id}: ${r.delivers}`, `Cannot tell if merged: ${r.unknown_why}.`,
      `repo ${r.repo}, branch ${r.branch}, tip at DONE ${String(r.done_tip ?? '-').slice(0, 9)}, lane ${r.lane ?? '-'}, DONE run ${r.run ?? '-'} (${r.done_utc})${r.pr ? `, PR ${r.pr.url}` : ''}.`].join('\n');
    q({ ev: 'create', data: { title, lane: r.lane ?? r.branch.split('/').pop(), body, class: 'iii', blocks: [], source: `deliverable ${r.id}`, deliverable: r.id, ruling: 'merged',
      options: [{ key: RULING.merged, text: 'Mark it merged: its work is on main (it leaves the Inbox and the merge backlog)', cost: 'none' },
        { key: RULING.open, text: 'Still open: its work is not on main yet (it reads DONE again and waits for a merge)', cost: 'stays in the backlog' }] } }, `asked: ${r.unknown_why}`);
  }
  return out;
}

// ---------- META-DLV-R2: the rebase / resolve lane (Gas Town done_rebase.go, GT-4) ----------
const resolveDir = stateDir => path.join(stateDir, 'resolve');
// the live (running / queued) resolve run of a deliverable: its brief sits at <state>/resolve/DLV-n-*.md
export function liveResolve(stateDir, id) {
  const pre = fwd(path.join(resolveDir(stateDir), id + '-')).toLowerCase();
  return Object.values(loadState(stateDir).items).find(i => i.kind === 'run' && ['running', 'queued'].includes(i.state) && fwd(i.data?.brief).toLowerCase().startsWith(pre)) || null;
}
// the branch's worktree: a linked worktree that has it checked out, else a new sibling of the repo (made at dispatch)
function resolveWorktree(repo, branch, lane, git) {
  const out = git(repo, ['worktree', 'list', '--porcelain'], { allowFail: true }) || '';
  let cur = null;
  for (const l of out.split(/\r?\n/)) {
    if (l.startsWith('worktree ')) cur = fwd(l.slice(9));
    else if (l === 'branch refs/heads/' + branch && cur) return sameRepo(cur, repo) ? { inMain: true } : { path: cur, exists: true };
  }
  const p = fwd(path.join(path.dirname(repo), `${path.basename(repo)}-resolve-${String(lane).replace(/[^\w.-]+/g, '-')}`));
  return { path: p, exists: fs.existsSync(p) };
}

/**
 * A DONE deliverable that conflicts with main, or is more than resolve_behind commits behind, gets a ready resolve brief and the
 * `norn run` argv that dispatches it (its own worktree, one writer, --queue). Native-touching branches are refused: controller /
 * door work. Returns { refused } | { id, why, brief, notes, worktree, create_worktree, run (argv after `meta`) }.
 * opts: { project, nowMs, git, executor (default claude) }
 */
export function resolveDeliverable(stateDir, id, { project = {}, nowMs = Date.now(), git = makeGit(), executor = 'claude' } = {}) {
  const cfg = deliverableConfig(project);
  const row = deliverablesView({ stateDir, project, now: nowMs, git }).rows.find(r => r.id === id);
  if (!row) return { refused: `${id} does not exist` };
  if (row.state !== 'done') return { refused: `${id} is ${row.state}: nothing to resolve` };
  if (row.superseded) return { refused: `${id} is superseded by ${row.superseded.by}: nothing to resolve` };
  if (row.native) return { refused: `${id} ${row.branch} is native-touching (${row.native_files.join(', ')}): its rebase / resolve is controller / door work (the door flow), not a resolve run` };
  if (!row.resolve) return { refused: `${id} ${row.branch}: nothing to resolve (merge rehearsal ${rehearsalWord(row) || 'unknown'}, ${row.behind ?? '?'} behind, limit ${cfg.resolve_behind})` };
  if (row.branch_exists === false) return { refused: `${id} ${row.branch}: the branch is gone (only its recorded tip is left)` };
  const live = liveResolve(stateDir, id);
  if (live) return { refused: `${id} already has a live resolve run ${live.id} (${live.state}); one writer per deliverable` };
  const lane = row.lane || row.branch.split('/').pop();
  const wt = resolveWorktree(row.repo, row.branch, lane, git);
  if (wt.inMain) return { refused: `${id} ${row.branch} is checked out in the main checkout ${row.repo}: a resolve run needs its own worktree` };
  const mainSha = (git(row.repo, ['rev-parse', '--verify', '--quiet', cfg.main], { allowFail: true }) || '').trim();
  const tag = `${String(row.tip).slice(0, 7)}-${mainSha.slice(0, 7)}`;
  fs.mkdirSync(resolveDir(stateDir), { recursive: true });
  const brief = fwd(path.join(resolveDir(stateDir), `${id}-${tag}.md`)), notes = fwd(path.join(resolveDir(stateDir), `${id}-${tag}-NOTES.md`));
  const files = row.rehearsal && !row.rehearsal.clean ? row.rehearsal.files : [];
  const R = cfg.remote, M = cfg.main, B = row.branch;
  const text = [
    `# task RESOLVE ${id} - bring ${B} up to ${M} (${row.resolve.why})`, '',
    `Deliverable ${id}: ${row.delivers}`,
    `Repo ${row.repo}, branch ${B} at ${String(row.tip).slice(0, 9)}; ${row.behind ?? '?'} behind / ${row.ahead ?? '?'} ahead of ${M} ${mainSha.slice(0, 9)}. Lane ${lane}, DONE run ${row.run ?? '-'}.`,
    `Merge rehearsal (git merge-tree --write-tree ${M} <tip>): ${files.length ? 'conflicts in ' + files.join(', ') : 'clean'}.`,
    `YOUR worktree ${wt.path} (yours alone: one writer), on branch ${B}.`, '',
    'Do:',
    `1. \`git fetch ${R}\`, then bring the worktree to the pushed tip: \`git merge --ff-only ${R}/${B}\`.`,
    `2. \`git merge ${R}/${M}\` into the branch - a merge, not a rebase: the branch is pushed and may be consumed, so no force-push.`,
    "3. Resolve every conflicting path keeping BOTH intents (main's newer code + the branch's own change); never drop a side to make it apply.",
    "   A conflict that needs a design choice outside the branch's own change: stop (`norn done --outcome stopped --why \"<why>\"`) with the paths and both sides.",
    "4. Run the covering tests of the touched files under the repo's CLAUDE.md / AGENTS.md rules; a new red is a stop, never a loosened test.",
    `5. Commit the merge (\`merge: ${M} into ${B} (resolve ${id})\`), push \`${R} ${B}\` - no force-push. Do not merge to ${M}; touch no other branch.`,
    `NOTES ${notes}: what conflicted, how each path was resolved, the tests run. End with \`norn done\` (or \`--outcome stopped --why "<why>"\` / \`--outcome handoff --handoff-file F\`).`, ''].join('\n');
  fs.writeFileSync(brief, text);
  const run = ['run', '--executor', executor, '--lane', lane, '--brief', brief, '--worktree', wt.path, '--notes', notes, '--stage', 'resolve', '--queue'];
  return { id, why: row.resolve.why, brief, notes, worktree: wt.path, create_worktree: wt.exists ? null : { repo: row.repo, branch: B, remote: R }, run };
}

// the resolve run's worktree when it does not exist yet: the local branch if there is one, else a tracking branch off the remote
export function createResolveWorktree(wtPath, { repo, branch, remote }, git = makeGit()) {
  const local = git(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], { allowFail: true });
  git(repo, local ? ['worktree', 'add', wtPath, branch] : ['worktree', 'add', '--track', '-b', branch, wtPath, `${remote}/${branch}`]);
}
