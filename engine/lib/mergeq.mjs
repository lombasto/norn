// META-GTP-MERGEQ (GT-PARITY-PLAN sec. 2.4; Bors / the GitHub merge queue; Gas Town refinery - cited, not ported): the merge
// queue of DONE-not-merged deliverables. Code only, no LLM: the tick runs it after the fill.
//  1. MR score (Gas Town internal/refinery/score.go:43-51, 81-87): 1000 + epic_hours*10 + (4 - priority)*100
//     - min(retries*50, 300) + dlv_hours; our inputs: the DLV's epic (age, P0-P3; none = P2, the DAG default), retries = its
//     resolve / fix rounds, the DLV's age since DONE.
import fs from 'node:fs';
import path from 'node:path';
import { fold, readEvents, recordsFile } from './records.mjs';
import { deliverablesView, deliverableConfig, rehearsalWord } from './deliverables.mjs';
import { loadEpics, epicMembers } from './epics.mjs';
import { spawn } from 'node:child_process';
import { makeGit, globToRe } from './dlvgit.mjs';
import { pathKey } from './config.mjs';
import { acquireLock, laneWriter, killTree } from './runs.mjs';
import { renderBatchBrief, suiteMode, briefMarker } from './mergebrief.mjs';
import { spawnOutside } from './jobguard.mjs';
import { openBlocks } from './slop/host.mjs';
import { slopOn } from './policy.mjs';
import { subdirOf, inDir, gateText } from './monorepo.mjs';

const H = 3600e3;
const fwd = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const pad = (s, n) => String(s ?? '').padEnd(n);
export const MQ_DEFAULTS = { batch_max: 4 };
export const PRIO_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** project.json `merge` over the defaults: { gate {cmd, timeout_min, fast} | null, batch_max, scratch (the batch worktree), ui (path globs) } */
// a monorepo project (project.subdir): the gate runs from that folder (gate.dir, unless set) and the scratch is the project's own
export function mergeConfig(project = {}) {
  const m = project.merge || {}, d = deliverableConfig(project), sub = subdirOf(project);
  const gate = m.gate ? { ...m.gate, ...(m.gate.dir === undefined && sub ? { dir: sub } : {}) } : null;
  return { ...MQ_DEFAULTS, ...m, gate, ui: m.ui || [], scratch: fwd(m.scratch || (sub ? `${d.repo}-mq-${project.name}` : `${d.repo}-mq`)), repo: d.repo, main: d.main, remote: d.remote, native: d.native };
}
/** the gate kind of a queue row: door (native: the install path, the door flow), batch (a FAST gate is declared: batched + bisected),
 *  stage (one MERGE stage per branch) */
export const gateKind = (row, cfg) => (row.native ? 'door' : cfg.gate?.fast ? 'batch' : 'stage');

/** Gas Town's MR score with our inputs (score.go:43-51); higher merges first */
export function mrScore({ epicHours = 0, priority = 'P2', retries = 0, dlvHours = 0 } = {}) {
  const p = PRIO_RANK[priority] ?? PRIO_RANK.P2;
  return Math.round(1000 + epicHours * 10 + (4 - p) * 100 - Math.min(retries * 50, 300) + dlvHours);
}

// the open epic a deliverable belongs to: by its DLV id, else by its DONE run; the oldest open one wins (stable)
function epicOf(epics, row) {
  const open = Object.values(epics).filter(e => e.state === 'open').sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  return open.find(e => epicMembers(e).includes(row.id)) || (row.run ? open.find(e => epicMembers(e).includes(row.run)) : null) || null;
}
// resolve / fix rounds of a deliverable since it was recorded: its resolve runs (brief <state>/resolve/DLV-n-*) + fix-stage runs of its lane
function retriesOf(runs, stateDir, row, since) {
  const pre = fwd(path.join(stateDir, 'resolve', row.id + '-')).toLowerCase();
  return runs.filter(r => r.kind === 'run' && r.state !== 'queued' && r.state !== 'withdrawn' && (fwd(r.data?.brief).toLowerCase().startsWith(pre)
    || (row.lane && r.data?.lane === row.lane && /^fix/i.test(r.data?.stage || '') && Date.parse(r.created) >= since))).length;
}

/**
 * The queue: every DONE-not-merged deliverable that is open (not parked, not superseded) and whose branch exists, in score order.
 * RM-7 S2: a row whose PR is open waits for the owner to merge it on GitHub, not for another merge: it is in `awaiting`, not in rows.
 * Returns { rows: [{ ...view row, score, priority, epic, epic_hours, dlv_hours, retries, gate, word (rehearsal), into (target branch) }], awaiting: [view row], cfg }
 */
export function mergeQueue({ stateDir, project = {}, now = Date.now(), git = makeGit(), view = null } = {}) {
  const cfg = mergeConfig(project), slop = slopOn(project.policy);
  const v = view || deliverablesView({ stateDir, project, now, git });
  const epics = (() => { try { return loadEpics(stateDir); } catch { return {}; } })();
  const runs = Object.values(fold(readEvents(recordsFile(stateDir, 'run'))).items);
  const dlvs = Object.values(fold(readEvents(recordsFile(stateDir, 'deliverable'))).items);
  const red = loadMq(stateDir).red || {};   // piece 3: a bisect culprit stays out (no update, no batch) until its tip changes
  const rows = [], awaiting = [], into1 = new Map(), ib1 = into => (into1.has(into) ? into1.get(into) : into1.set(into, intoSha(cfg, into, git)).get(into));
  for (const r of v.rows) {
    if (r.state !== 'done' || r.record_state !== 'open' || r.superseded || r.branch_exists === false) continue;
    if (r.pr?.state === 'open') { awaiting.push(r); continue; }
    const ep = epicOf(epics, r);
    const into = ep?.data.integration_branch || cfg.main;
    // piece 4: a row already on its epic's integration branch has reached its queue target (main follows when the branch lands)
    if (into !== cfg.main) { const ib = ib1(into); if (ib && r.tip && git(cfg.repo, ['merge-base', '--is-ancestor', r.tip, ib], { allowFail: true }) !== null) continue; }
    const since = Date.parse(dlvs.find(d => d.id === r.id)?.created || r.done_utc);
    const priority = ep?.data.priority || 'P2';
    const epic_hours = ep ? Math.max(0, (now - Date.parse(ep.created)) / H) : 0;
    const dlv_hours = Math.max(0, (now - Date.parse(r.done_utc)) / H);
    const retries = retriesOf(runs, stateDir, r, since);
    rows.push({ ...r, score: mrScore({ epicHours: epic_hours, priority, retries, dlvHours: dlv_hours }), priority, epic: ep?.id ?? null,
      epic_hours: +epic_hours.toFixed(1), dlv_hours: +dlv_hours.toFixed(1), retries, gate: gateKind(r, cfg), word: rehearsalWord(r) || '?',
      into, red: red[r.id] && (red[r.id] === r.tip || red[r.id] === r.done_tip) ? red[r.id] : null,
      slop: slop ? openBlocks(stateDir, r.branch).length : 0 });   // META-SLOP-A: open BLOCK findings hold the branch out of a batch (META-BETA-PREP: not while off)
  }
  rows.sort((a, b) => b.score - a.score || Number(a.id.slice(4)) - Number(b.id.slice(4)));
  return { rows, awaiting, cfg };
}

/** one `norn mergeq` line: id, score, priority / epic, gate kind, rehearsal, behind, target, branch, what it delivers */
export function formatMq(r) {
  return [r.id, pad(r.score, 5), pad(r.priority + (r.epic ? ' ' + r.epic : ''), 8), pad(r.gate, 5), pad(r.word, 18), pad(r.behind === null ? '' : `-${r.behind}`, 5),
    r.into === 'main' ? '' : `-> ${r.into}`, r.red ? 'RED' : '', r.slop ? `SLOP ${r.slop}` : '', pad(r.branch, 30), String(r.delivers || '').slice(0, 70)].filter(x => x !== '').join(' ').trimEnd();
}

// ---------- 2. auto-UPDATE (not rebase; GitHub merge queue "update branch" / Gas Town done_rebase.go:28-46 aborts on conflict) ----------
// the worktree that has a branch checked out: { path } | { inMain } | null (checked out nowhere)
export function branchWorktree(repo, branch, git = makeGit()) {
  const out = git(repo, ['worktree', 'list', '--porcelain'], { allowFail: true }) || '';
  let cur = null;
  for (const l of out.split(/\r?\n/)) {
    if (l.startsWith('worktree ')) cur = fwd(l.slice(9));
    else if (l === 'branch refs/heads/' + branch && cur) return pathKey(cur) === pathKey(repo) ? { inMain: true } : { path: cur };
  }
  return null;
}
// the commit of the first of these full ref names that exists: ONE for-each-ref for all of them (ENGINE-GIT, DEC-88; was a rev-parse
// each). for-each-ref patterns also match the refs below a name (refs/heads/a matches refs/heads/a/b): only exact names count.
const refsOf = (repo, names, git) => new Map((git(repo, ['for-each-ref', '--format=%(refname)%09%(objectname)', ...names], { allowFail: true }) || '')
  .split(/\r?\n/).filter(Boolean).map(l => l.split('\t')));
const first = (got, names) => { for (const n of names) if (got.get(n)) return got.get(n); return null; };
function firstRef(repo, names, git) { return first(refsOf(repo, names, git), names); }
// the main sha the view's rehearsal used (scanRepo: local main, else the remote's)
export function mainShaOf(repo, { main = 'main', remote = 'origin', git = makeGit() } = {}) {
  return firstRef(repo, [`refs/heads/${main}`, `refs/remotes/${remote}/${main}`], git);
}
// a target branch's tip: the remote's (fresh after the scratch fetch; shared by every worktree of the repo), else the local one
export function intoSha(cfg, into, git = makeGit()) {
  return firstRef(cfg.repo, [`refs/remotes/${cfg.remote}/${into}`, `refs/heads/${into}`], git);
}
// the batch / update scratch worktree (detached), made on first use
export function ensureScratch(cfg, git = makeGit()) {
  if (!fs.existsSync(cfg.scratch)) git(cfg.repo, ['worktree', 'add', '--detach', cfg.scratch, mainShaOf(cfg.repo, { ...cfg, git })]);
  return cfg.scratch;
}

/**
 * Merge main into one queue row's branch and push it - never a rebase, never a force-push (owner rule). Only when the branch is
 * behind, its rehearsal is clean, its worktree is clean, at the pushed tip, and has no live writer lock (the update takes that
 * lock while it works, so no run starts under it). A branch checked out nowhere is updated in the scratch worktree.
 * A conflict (main moved under the rehearsal) = `git merge --abort` + the existing resolve path (norn deliverables resolve).
 * Returns { id, action: updated | skip | conflict | failed, why, sha? }.
 */
export function autoUpdate(row, { cfg, locksDir, git = makeGit(), acquire = acquireLock, staleMs } = {}) {
  const R = cfg.remote, B = row.branch, res = (action, why, x = {}) => ({ id: row.id, branch: B, action, why, ...x });
  if (row.red) return res('skip', `red in the merge queue at ${row.red.slice(0, 7)}: its fix stage merges main itself`);
  if (!row.behind) return res('skip', 'current with main');
  if (row.rehearsal && !row.rehearsal.clean) return res('skip', `${rehearsalWord(row)}: the resolve path (norn deliverables resolve ${row.id})`);
  if (!row.rehearsal) return res('skip', 'no merge rehearsal');
  // native code is door work (the door flow; resolveDeliverable's rule): no update of a native branch, nor one that would pull main's native
  // changes into a lane worktree (its built extension would no longer match its source)
  if (row.native) return res('skip', `native-touching (${row.native_files.join(', ')}): its update is door work (the door flow)`);
  if (cfg.native?.length) {
    const nre = cfg.native.map(globToRe), mainSha = mainShaOf(row.repo, { ...cfg, git });
    const nat = (git(row.repo, ['diff', '--name-only', `${row.tip}...${mainSha}`], { allowFail: true }) || '').split(/\r?\n/).filter(f => f && nre.some(re => re.test(f)));
    if (nat.length) return res('skip', `main brings native changes (${nat.slice(0, 3).join(', ')}${nat.length > 3 ? ', ...' : ''}): the update is door work (the door flow)`);
  }
  const where = branchWorktree(row.repo, B, git);
  if (where?.inMain) return res('skip', `checked out in the main checkout ${row.repo}`);
  const wt = where ? where.path : ensureScratch(cfg, git);
  let lock;
  try { lock = acquire(locksDir, wt, { run: 'mergeq', ...(staleMs ? { staleMs } : {}) }); } catch (e) { return res('skip', e.message); }
  try {
    const gw = (args, o) => git(wt, args, o);
    gw(['fetch', '--quiet', R]);
    // ENGINE-GIT (DEC-88): the pushed tip and main (mainShaOf's names) in one for-each-ref. wt shares row.repo's refs when it is the
    // branch's worktree or the scratch of the same repo; a scratch of another repo asks row.repo for main as before.
    const mainNames = [`refs/heads/${cfg.main}`, `refs/remotes/${R}/${cfg.main}`];
    const shared = !!where || pathKey(cfg.repo) === pathKey(row.repo);
    const at = refsOf(wt, [`refs/remotes/${R}/${B}`, ...(shared ? mainNames : [])], git);
    const remoteTip = at.get(`refs/remotes/${R}/${B}`) || '';
    if (!remoteTip) return res('skip', `${R}/${B} does not exist (not pushed)`);
    if (where) {
      // one status for the changes (porcelain v2 entry lines, untracked off) and HEAD (its `# branch.oid` header)
      const st = (gw(['status', '--porcelain=v2', '--branch', '--untracked-files=no']) || '').split(/\r?\n/).filter(Boolean);
      if (st.some(l => !l.startsWith('# '))) return res('skip', `worktree ${wt} has uncommitted changes`);
      const head = (st.find(l => l.startsWith('# branch.oid ')) || '').slice(13).trim();
      if (head !== remoteTip) {
        if (gw(['merge-base', '--is-ancestor', head, remoteTip], { allowFail: true }) === null) return res('skip', `worktree ${wt} has commits not on ${R}/${B}`);
        gw(['merge', '--ff-only', '--quiet', remoteTip]);
      }
    } else gw(['checkout', '--quiet', '--detach', remoteTip]);
    const mainSha = shared ? first(at, mainNames) : mainShaOf(row.repo, { ...cfg, git });
    const m = gw(['merge', '--no-ff', '--no-edit', '-m', `merge: ${cfg.main} into ${B} (mergeq update ${row.id})`, mainSha], { status: true });
    if (m.code !== 0) {
      gw(['merge', '--abort'], { allowFail: true });
      return res('conflict', `merging ${cfg.main} ${mainSha.slice(0, 7)} conflicts: aborted; the resolve path: norn deliverables resolve ${row.id}`);
    }
    const sha = gw(['rev-parse', 'HEAD']).trim();
    const p = gw(['push', '--quiet', R, `HEAD:refs/heads/${B}`], { status: true });   // a fast-forward push: never --force
    if (p.code !== 0) {
      if (where) gw(['reset', '--quiet', '--keep', remoteTip], { allowFail: true });   // our own unpushed merge commit only
      return res('failed', `push ${R} ${B} refused (exit ${p.code}): left at ${remoteTip.slice(0, 7)}`);
    }
    return res('updated', `merged ${cfg.main} ${mainSha.slice(0, 7)}, pushed ${sha.slice(0, 7)}`, { sha, main: mainSha, worktree: wt });
  } catch (e) {
    return res('failed', String(e.stderr || e.message).trim().split(/\r?\n/)[0]);
  } finally { lock.release(); }
}

/** one update pass over the queue (score order): autoUpdate per row; the rows of a fresh view. Returns [{ id, branch, action, why }] */
export function updatePass({ stateDir, project = {}, locksDir, git = makeGit(), now = Date.now(), acquire } = {}) {
  const { rows, cfg } = mergeQueue({ stateDir, project, now, git });
  return rows.map(r => autoUpdate(r, { cfg, locksDir: locksDir || path.join(path.dirname(path.resolve(stateDir)), 'locks'), git, ...(acquire ? { acquire } : {}) }));
}

// ---------- 3. batch + bisect (Bors; Gas Town batch.go:11-33 batch max, 202-210 + 485-490 retry once then bisect; engineer.go:74-86,
// 136-143 named gate cmd + timeout). Only where the project declares a FAST gate (merge.gate.fast): a native project's cargo / GPU / capture
// gates stay door work. State: <state>/mq/state.json { n, unpinned, red {DLV-n: sha}, batching {off, why, at} } + batch-<n>.json.
export const mqDir = stateDir => path.join(stateDir, 'mq');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 1)); fs.renameSync(t, f); };
export const mqStateFile = stateDir => path.join(mqDir(stateDir), 'state.json');
export const loadMq = stateDir => ({ n: 0, unpinned: 0, red: {}, batching: { off: false }, ...readJ(mqStateFile(stateDir), {}) });
export const batchFile = (stateDir, n) => path.join(mqDir(stateDir), `batch-${n}.json`);
export const loadBatch = (stateDir, n) => readJ(batchFile(stateDir, n), null);
export const UNPIN_LIMIT = 2;   // the kill criterion: a red batch bisect cannot pin, twice in a row = the gate is not deterministic

/** run the gate cmd in cwd (shell; in cwd/<gate.dir> when the gate has a dir), its output to log; the env drops VIRTUAL_ENV and every META_* (a suite must not see live state) */
export function runGate(gate, { cwd, log }) {
  cwd = inDir(cwd, gate.dir);
  return new Promise(resolve => {
    const t0 = Date.now();
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const fd = fs.openSync(log, 'w');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'VIRTUAL_ENV' && !k.startsWith('META_')));
    let child, timedOut = false, done = false;
    const end = (code, extra = {}) => { if (done) return; done = true; clearTimeout(timer); try { fs.closeSync(fd); } catch { /* closed */ } resolve({ ok: code === 0 && !timedOut, code, ms: Date.now() - t0, timedOut, log: fwd(log), ...extra }); };
    const timer = setTimeout(() => { timedOut = true; killTree(child?.pid); }, (gate.timeout_min ?? 30) * 60e3);
    try { child = spawn(gate.cmd, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd], env }); }
    catch (e) { end(-1, { error: e.message }); return; }
    child.on('error', e => end(-1, { error: e.message }));
    child.on('exit', code => end(code ?? -1));
  });
}

// the candidates of the next batch: batch-gated, clean rehearsal, not red at this sha, one target (the top row's), up to batch_max.
// The sha merged = the pushed tip, or the tip recorded at DONE while the lane has a live writer (the staged rule of piece 0).
export function pickBatch(rows, { cfg, mq, stateDir, locksDir, writer = laneWriter }) {
  const pick = [];
  for (const r of rows) {
    if (r.gate !== 'batch' || r.word !== 'clean' || r.slop) continue;
    const live = writer({ state: stateDir, locksDir, lane: r.lane, worktree: null });
    const sha = live ? r.done_tip : r.tip;
    if (!sha || mq.red[r.id] === sha) continue;
    if (pick.length && r.into !== pick[0].into) continue;
    pick.push({ id: r.id, branch: r.branch, lane: r.lane, sha, into: r.into, staged: !!live });
    if (pick.length >= cfg.batch_max) break;
  }
  return pick;
}

// MQ-STARVE (DEC-72 b): when main is red under the gate, the rows that fix it go first. The signal (the cheapest honest one): the base
// gate log's failing test files - ci-suite's `NEW RED: <file> :: <name>` lines - and a row fixes main when its diff from the base
// (`git diff --name-only <base>...<sha>`) touches one of those files.
const RED_LINE = /^NEW RED: (.+?) :: (.*)$/;
/** the failing tests a gate log names: [{ file, name }] ([] for no log / no ci-suite lines) */
export function gateReds(log) {
  let text = '';
  try { text = fs.readFileSync(log, 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split(/\r?\n/)) { const m = RED_LINE.exec(l.trim()); if (m && !out.some(o => o.file === m[1] && o.name === m[2])) out.push({ file: fwd(m[1]), name: m[2] }); }
  return out;
}
/** main's reds of a main-red batch record: its main_reds, else read from its base gate log (records written before the field) */
export const mainRedsOf = rec => rec.main_reds || gateReds(rec.runs?.find(r => r.label === 'base')?.log);
/** the ids of the rows into `into` whose diff from `base` touches one of the files */
export function fixesMain(rows, { files, base, into, cfg, git = makeGit() }) {
  const want = new Set(files.map(fwd));
  if (!want.size) return [];
  return rows.filter(r => r.into === into && (r.tip || r.done_tip)).filter(r => {
    const d = git(cfg.repo, ['diff', '--name-only', `${base}...${r.tip || r.done_tip}`], { allowFail: true });
    return (d || '').split(/\r?\n/).some(f => want.has(fwd(f.trim())));
  }).map(r => r.id);
}

/**
 * Build mq/batch-<n> in the scratch worktree: the target's pushed tip + one `--no-ff` merge commit per member (a member that conflicts
 * with the ones before it is dropped from this batch). Returns { base, tip, members [{..., merge}], dropped [{id, why}] }.
 */
export function buildBatch(n, pick, { cfg, git = makeGit() }) {
  const wt = ensureScratch(cfg, git), gw = (a, o) => git(wt, a, o), into = pick[0].into;
  gw(['fetch', '--quiet', cfg.remote], { allowFail: true });
  gw(['merge', '--abort'], { allowFail: true });
  // piece 4: a new integration branch starts at main (Gas Town `gt mq integration`); its first push creates it
  const base = intoSha(cfg, into, git) || intoSha(cfg, cfg.main, git);
  gw(['checkout', '--quiet', '--force', '-B', `mq/batch-${n}`, base]);
  const members = [], dropped = [];
  for (const m of pick) {
    const r = gw(['merge', '--no-ff', '--no-edit', '-m', `merge: ${m.branch} (${m.lane ?? '-'}) [mq batch-${n}, ${m.id}]`, m.sha], { status: true });
    if (r.code !== 0) { gw(['merge', '--abort'], { allowFail: true }); dropped.push({ id: m.id, why: `conflicts with the batch members before it` }); continue; }
    members.push({ ...m, merge: gw(['rev-parse', 'HEAD']).trim() });
  }
  return { base, tip: members.length ? members[members.length - 1].merge : base, members, dropped, into };
}

/**
 * The gate on a red batch: Gas Town retries a red gate ONCE (never more); still red = bisect the batch's first-parent merge chain by
 * halves - prefix k = base + the first k members; prefix K is red, the base is taken green: ceil(log2 K) gate runs pin the first
 * member whose merge turns the gate red. When that is member 1 the base itself is probed once (a red main is nobody's branch).
 * gateAt(commit, label) -> Promise<{ ok, ... }>. Returns { status: green | flaky | pinned | main-red, runs, culprit?, green_prefix }.
 */
export async function gateBatch(b, gateAt) {
  const runs = [], at = async (k, label) => { const r = await gateAt(k === 0 ? b.base : b.members[k - 1].merge, label); runs.push({ prefix: k, label, ...r }); return r.ok; };
  const K = b.members.length;
  if (await at(K, 'batch')) return { status: 'green', runs, green_prefix: K };
  if (await at(K, 'retry')) return { status: 'flaky', runs, green_prefix: K };   // red then green on one tree: not deterministic
  let lo = 0, hi = K;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await at(mid, 'bisect')) lo = mid; else hi = mid;
  }
  if (lo === 0 && !(await at(0, 'base'))) return { status: 'main-red', runs, green_prefix: 0 };
  return { status: 'pinned', runs, culprit: b.members[hi - 1], green_prefix: lo };
}

// the fix-stage ask of a pinned culprit: a ready brief + the `norn run` argv (the check-in dispatches it; DLV-R2's resolve pattern)
function fixAsk(stateDir, rec, res, { cfg, git }) {
  const c = res.culprit, sha7 = String(c.sha).slice(0, 7);
  const brief = fwd(path.join(mqDir(stateDir), `fix-${c.id}-${sha7}.md`)), notes = brief.replace(/\.md$/, '-NOTES.md');
  const wtPath = branchWorktree(cfg.repo, c.branch, git)?.path || null;
  const k = rec.members.findIndex(m => m.id === c.id) + 1;
  const logs = res.runs.filter(r => r.prefix === k || r.prefix === k - 1).map(r => `prefix ${r.prefix} ${r.ok ? 'green' : 'red'}: ${fwd(r.log)}`);
  fs.writeFileSync(brief, [
    `# task FIX ${c.id} - ${c.branch} turns the merge-queue gate red (mq batch-${rec.n} bisect)`, '',
    `The merge gate \`${gateText(cfg.gate)}\` is RED on ${rec.into} ${rec.base.slice(0, 7)} + ${rec.members.slice(0, k).map(m => m.branch).join(' + ')} and GREEN without ${c.branch}`,
    `(bisect over the batch's merge commits; logs: ${logs.join('; ')}).`,
    `Branch ${c.branch} at ${sha7}, lane ${c.lane ?? '-'}. YOUR worktree: ${wtPath || `a worktree with ${c.branch} checked out (none exists: \`git -C ${cfg.repo} worktree add <path> ${c.branch}\`)`} (one writer).`, '',
    'Do:',
    `1. \`git fetch ${cfg.remote}\`; bring the worktree to the pushed tip (\`git merge --ff-only ${cfg.remote}/${c.branch}\`), then \`git merge ${cfg.remote}/${rec.into}\` - a merge, never a rebase.`,
    `2. Run the gate \`${gateText(cfg.gate)}\` and reproduce the red; fix its CAUSE in the branch, red-first (never loosen a test, never a skip by name).`,
    `   ${k > 1 ? `The red may be an interaction with ${rec.members.slice(0, k - 1).map(m => m.branch).join(', ')} (merged before it in the batch): merge those too to reproduce.` : 'It is red on the target with this branch alone.'}`,
    `3. Commit, push \`${cfg.remote} ${c.branch}\` - no force-push. Do not merge to ${rec.into}; the merge queue re-batches the new tip.`,
    `NOTES ${notes}: the red, its cause, the fix, the gate result. End with \`norn done\` (or \`--outcome stopped --why "<why>"\` / \`--outcome handoff --handoff-file F\`).`, ''].join('\n'));
  return { id: c.id, branch: c.branch, sha: c.sha, brief, notes, worktree: wtPath,
    run: ['run', '--executor', 'claude', '--lane', c.lane || c.branch.split('/').pop(), '--stage', 'fix-mq', '--brief', brief, '--notes', notes, '--worktree', wtPath || '<the lane worktree>', '--queue'] };
}

// a green prefix of k members -> the ONE MERGE stage brief for main (piece 4: an integration branch is pushed instead)
function finish(stateDir, rec, k, { cfg, project, git }) {
  rec.merge_members = rec.members.slice(0, k);
  rec.merge_tip = rec.merge_members[k - 1].merge;
  git(cfg.scratch, ['checkout', '--quiet', '--force', '-B', `mq/batch-${rec.n}`, rec.merge_tip]);   // the scratch stays on the merged tip
  const changed = (git(cfg.repo, ['diff', '--name-only', rec.base, rec.merge_tip], { allowFail: true }) || '').split(/\r?\n/).filter(Boolean);
  const uiRe = cfg.ui.map(globToRe);
  rec.ui = changed.some(f => uiRe.some(re => re.test(f)));
  if (rec.into !== cfg.main) {   // piece 4: an integration branch takes the gated tip as a fast-forward push - no MERGE stage, never a force
    const p = git(cfg.scratch, ['push', '--quiet', cfg.remote, `${rec.merge_tip}:refs/heads/${rec.into}`], { status: true });
    rec.status = p.code === 0 ? 'merged' : 'stale';
    rec.pushed = p.code === 0 ? `${cfg.remote}/${rec.into} = ${rec.merge_tip}` : null;
    if (p.code !== 0) rec.why = `push ${cfg.remote} ${rec.into} refused (it moved since the batch was built): rebuilt next pass`;
    return;
  }
  rec.notes = fwd(path.join(mqDir(stateDir), `batch-${rec.n}-MERGE-NOTES.md`));
  rec.brief = fwd(path.join(mqDir(stateDir), `batch-${rec.n}-MERGE-brief.md`));
  const gl = [...rec.runs].reverse().find(r => r.ok && (r.prefix === rec.members.length || r.prefix === k));
  const text = renderBatchBrief(project, { n: rec.n, tip: rec.merge_tip, base: rec.base, gate: cfg.gate.cmd, gate_log: gl?.log, retried: rec.result === 'flaky',
    scratch: cfg.scratch, notes: rec.notes, ui: rec.ui, members: rec.merge_members });
  fs.writeFileSync(rec.brief, text);
  rec.status = 'green';
  // GAP-6: the batch MERGE works in its own merge worktree (the brief's marker names it) and opens the PRs with norn merge-land
  rec.dispatch = ['run', '--lane', 'mq', '--stage', 'MERGE', '--brief', rec.brief, '--worktree', briefMarker(text).merge_wt, '--notes', rec.notes, '--executor', 'claude', '--queue'];
}

// META-SLOP-A (Fable: Norn's own mess is fixed in Norn): a batch that landed or was abandoned leaves no mq/batch-<n> behind
// (31 were left on 11-14). The scratch worktree is detached first: git refuses to delete a branch a worktree has checked out.
const BATCH_OVER = new Set(['merged', 'stale', 'red', 'main-red', 'empty']);
function dropBatchBranch(stateDir, rec, { cfg, git }) {
  if (!BATCH_OVER.has(rec?.status) || rec.branch_deleted) return;
  git(cfg.scratch, ['checkout', '--quiet', '--force', '--detach'], { allowFail: true });
  if (git(cfg.repo, ['branch', '-D', `mq/batch-${rec.n}`], { allowFail: true }) === null) return;   // already gone or never built: retried next pass
  rec.branch_deleted = true;
  writeJ(batchFile(stateDir, rec.n), rec);
}

const WHY = {
  green: (rec) => `batch-${rec.n} GREEN (${rec.members.length} branches, ${rec.gate_runs} gate run): ${rec.brief ? `MERGE brief ${rec.brief}` : rec.pushed ? `pushed ${rec.pushed}` : rec.why}`,
  flaky: (rec, m) => `batch-${rec.n} red, then GREEN on its one retry: merged as green, counted unpinned (${m.unpinned} in a row); MERGE brief ${rec.brief}`,
  pinned: (rec) => `batch-${rec.n} RED: bisect pinned ${rec.culprit.id} in ${rec.bisect_runs} bisect run(s) (fix ask ${rec.culprit.fix}); ${rec.merge_members?.length ?? 0} branch(es) before it go on${rec.brief ? `: MERGE brief ${rec.brief}` : ''}`,
  'main-red': (rec) => `batch-${rec.n} RED and ${rec.into} ${rec.base.slice(0, 7)} itself is red under the gate: nothing pinned, nothing merged`,
};

/**
 * One merge-queue pass (the tick runs it after the fill; code only): auto-update every idle branch, then - where a FAST gate is
 * declared and batching is on - one batch at a time machine-wide (the scratch worktree's lock): build, gate, retry once,
 * bisect, write the batch MERGE brief / the culprit's fix ask, apply the kill criterion. Returns { updates, batch, fix, why }.
 * o: { stateDir, project, locksDir, git, now, acquire (runs.acquireLock), gateRunner (runGate), hbMs }
 */
export async function mergeqRun(o = {}) {
  const run = takeRunLock(o.stateDir);   // one pass per state dir (the tick may fire again while a gate runs)
  if (!run) { const l = mqRunning(o.stateDir); return { updates: [], batch: null, fix: null, why: `a mergeq pass is running (pid ${l?.pid ?? '?'})` }; }
  const hb = setInterval(run.refresh, o.hbMs ?? 30000);
  try {
    const r = await mergeqPass(o);
    try { fs.appendFileSync(path.join(mqDir(o.stateDir), 'run.log'), `${new Date().toISOString()} ${r.updates.filter(u => u.action !== 'skip').map(u => `${u.id} ${u.action}; `).join('')}${r.why}
`); } catch { /* log only */ }
    return r;
  } finally { clearInterval(hb); run.release(); }
}
async function mergeqPass({ stateDir, project = {}, locksDir, git = makeGit(), now = Date.now(), acquire = acquireLock, gateRunner = runGate, hbMs = 30000 } = {}) {
  const skip = suiteMode(project) === 'skip';   // DIR-24: policy.merge.suite = skip -> no gate run (a bad value is refused here)
  locksDir ||= path.join(path.dirname(path.resolve(stateDir)), 'locks');
  const out = { updates: updatePass({ stateDir, project, locksDir, git, now, acquire }), batch: null, fix: null, why: '' };
  const cfg = mergeConfig(project);
  if (!cfg.gate?.fast) return { ...out, why: 'no fast merge gate declared (merge.gate.fast): no batch - one MERGE stage per branch, door work stays door work' };
  const mq = loadMq(stateDir);
  if (mq.batching.off) return { ...out, why: `batching OFF since ${mq.batching.at}: ${mq.batching.why}` };
  const open = mq.n ? loadBatch(stateDir, mq.n) : null;
  if (open?.status === 'green') {   // one batch at a time: the last green batch waits for its MERGE stage
    const head = intoSha(cfg, open.into, git);
    if (head && git(cfg.repo, ['merge-base', '--is-ancestor', open.merge_tip, head], { allowFail: true }) !== null) open.status = 'merged';
    else if (head !== open.base) open.status = 'stale';
    else return { ...out, batch: open, why: `batch-${open.n} green: waiting for its MERGE stage (${open.brief})` };
    open[open.status + '_at'] = new Date(now).toISOString();
    writeJ(batchFile(stateDir, open.n), open);
  }
  let slock;
  try { slock = acquire(locksDir, cfg.scratch, { run: 'mergeq' }); } catch (e) { return { ...out, why: `no batch now: the scratch worktree: ${e.message}` }; }
  try {
    const hb = setInterval(() => { slock.refresh(); }, hbMs);
    try {
      let { rows } = mergeQueue({ stateDir, project, now, git });
      // MQ-STARVE: the last batch found its target red at a base that is still the target's tip -> the rows that fix it go first
      const last = mq.n ? loadBatch(stateDir, mq.n) : null;
      dropBatchBranch(stateDir, last, { cfg, git });   // a green batch the MERGE stage landed (or main moved past it): its branch goes
      const redBase = last?.status === 'main-red' && intoSha(cfg, last.into, git) === last.base ? last : null;
      let fixers = [];
      if (redBase) {
        fixers = fixesMain(rows, { files: mainRedsOf(redBase).map(t => t.file), base: redBase.base, into: redBase.into, cfg, git });
        rows = [...rows.filter(r => fixers.includes(r.id)), ...rows.filter(r => !fixers.includes(r.id))];
      }
      const pick = pickBatch(rows, { cfg, mq, stateDir, locksDir });
      if (!pick.length) return { ...out, why: 'no batchable row (clean, fast-gated, not red at its sha)' };
      const key = ms => ms.map(m => `${m.id}@${m.sha}`).sort().join(' ');
      if (redBase && !pick.some(p => fixers.includes(p.id)) && key(pick) === key(redBase.members)) {
        const files = [...new Set(mainRedsOf(redBase).map(t => t.file))];
        return { ...out, why: `${redBase.into} ${redBase.base.slice(0, 7)} is red under the gate (batch-${redBase.n}: ${files.join(', ') || 'the base gate log names no failing test file'}) and no queued row's diff touches those files: batch-${redBase.n}'s members are not rebuilt at the same base - fix ${redBase.into} or queue the branch that does` };
      }
      const n = mq.n + 1;
      writeJ(mqStateFile(stateDir), { ...mq, n });
      const b = buildBatch(n, pick, { cfg, git });
      const rec = { n, branch: `mq/batch-${n}`, into: b.into, base: b.base, tip: b.tip, members: b.members, dropped: b.dropped, gate: gateText(cfg.gate),
        built: new Date(now).toISOString(), status: 'gating' };
      const fx = b.members.filter(m => fixers.includes(m.id)).map(m => m.id);
      if (fx.length) rec.fixes_main = fx;   // MQ-STARVE: put first because their diff touches main's failing test files
      writeJ(batchFile(stateDir, n), rec);
      if (!b.members.length) { rec.status = 'empty'; writeJ(batchFile(stateDir, n), rec); dropBatchBranch(stateDir, rec, { cfg, git }); return { ...out, batch: rec, why: `batch-${n}: every pick conflicts` }; }
      let k = 0;
      const gateAt = async (commit, label) => {
        git(cfg.scratch, ['checkout', '--quiet', '--force', '--detach', commit]);
        return gateRunner(cfg.gate, { cwd: cfg.scratch, log: path.join(mqDir(stateDir), `batch-${n}-gate-${++k}-${label}.log`) });
      };
      // skip: the members merged clean (buildBatch drops a conflicting pick), so nothing runs; the MERGE stage keeps its smoke
      const res = skip ? { status: 'green', runs: [], green_prefix: b.members.length } : await gateBatch(b, gateAt);
      if (skip) rec.gate_skipped = 'policy merge.suite = skip';
      git(cfg.scratch, ['checkout', '--quiet', '--force', `mq/batch-${n}`]);
      rec.runs = res.runs.map(({ prefix, label, ok, code, ms, timedOut, log }) => ({ prefix, label, ok, code, ms, timedOut, log }));
      rec.result = res.status;
      rec.gate_runs = res.runs.length;
      rec.bisect_runs = res.runs.filter(r => r.label === 'bisect').length;
      if (res.status === 'main-red') rec.main_reds = mainRedsOf(rec);   // MQ-STARVE: the next pick puts the rows that fix these first
      const m2 = loadMq(stateDir);
      if (res.status === 'flaky') m2.unpinned = (m2.unpinned || 0) + 1;
      else if (res.status !== 'main-red') m2.unpinned = 0;
      if (m2.unpinned >= UNPIN_LIMIT) {
        m2.batching = { off: true, at: new Date(now).toISOString(), why: `the gate is not deterministic: ${m2.unpinned} red batches in a row that bisect could not pin (red, then green on the one retry; last batch-${n}) - back on: norn mergeq --batching on` };
      }
      if (res.status === 'pinned') {
        m2.red = { ...m2.red, [res.culprit.id]: res.culprit.sha };
        out.fix = fixAsk(stateDir, rec, res, { cfg, git });
        rec.culprit = { id: res.culprit.id, branch: res.culprit.branch, sha: res.culprit.sha, fix: out.fix.brief };
      }
      writeJ(mqStateFile(stateDir), m2);
      if (res.green_prefix > 0) finish(stateDir, rec, res.green_prefix, { cfg, project, git });
      else rec.status = res.status === 'main-red' ? 'main-red' : 'red';
      rec.done_at = new Date().toISOString();   // the gate probe dates its facts by this
      writeJ(batchFile(stateDir, n), rec);
      dropBatchBranch(stateDir, rec, { cfg, git });   // red / main-red with no green prefix, or an integration push: over now
      return { ...out, batch: rec, why: WHY[res.status](rec, m2) + (m2.batching.off ? `; batching now OFF: ${m2.batching.why}` : '') };
    } finally { clearInterval(hb); }
  } finally { slock.release(); }
}

/** the kill switch: off (with why) / on (resets the unpinned count). Returns the mq state. */
export function setBatching(stateDir, on, why = '') {
  const m = loadMq(stateDir);
  m.batching = on ? { off: false } : { off: true, at: new Date().toISOString(), why: `by hand: ${why}` };
  if (on) m.unpinned = 0;
  writeJ(mqStateFile(stateDir), m);
  return m;
}
/** the merge queue's own state in words (for `norn mergeq` and the check-in): batching, the last batch, open fix asks */
export function mqSummary(stateDir) {
  const mq = loadMq(stateDir), batch = mq.n ? loadBatch(stateDir, mq.n) : null, lines = [];
  lines.push(mq.batching.off ? `batching OFF since ${mq.batching.at}: ${mq.batching.why}` : `batching on (unpinned in a row: ${mq.unpinned})`);
  if (batch) {
    const what = batch.status === 'green' ? `GREEN, waiting for its MERGE stage: norn ${batch.dispatch.join(' ')}` : batch.status;
    lines.push(`batch-${batch.n} -> ${batch.into}: ${what}${batch.culprit ? `; culprit ${batch.culprit.id} fix ask ${batch.culprit.fix}` : ''}`);
  }
  for (const [id, sha] of Object.entries(mq.red || {})) lines.push(`red: ${id} at ${String(sha).slice(0, 7)} (kept out of batches until its tip changes)`);
  return { mq, batch, lines };
}

// ---------- 5. the tick: `norn mergeq --run` right after the fill, detached (code only, no LLM); one pass per state dir at a time ----------
export const runLockFile = stateDir => path.join(mqDir(stateDir), 'run.lock');
export const RUN_STALE_MS = 10 * 60e3;   // the pass refreshes its lock every hbMs; a lock this old (or of a dead pid) is taken over
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
/** the live pass of this state dir: { pid, ts } | null */
export function mqRunning(stateDir, now = Date.now()) {
  const l = readJ(runLockFile(stateDir), null);
  return l && Number.isInteger(l.pid) && alive(l.pid) && now - Date.parse(l.ts) < RUN_STALE_MS ? l : null;
}
/** take the pass lock (wx; a stale / dead one is taken over) -> { refresh, release } | null (a live pass holds it) */
export function takeRunLock(stateDir) {
  const f = runLockFile(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const body = () => JSON.stringify({ pid: process.pid, ts: new Date().toISOString() });
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(f, body(), { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (mqRunning(stateDir)) return null;
      try { fs.unlinkSync(f); } catch { /* another breaker */ }
      if (i === 1) return null;
    }
  }
  const mine = () => readJ(f, null)?.pid === process.pid;
  return { refresh: () => { if (mine()) fs.writeFileSync(f, body()); }, release: () => { if (mine()) { try { fs.unlinkSync(f); } catch { /* gone */ } } } };
}

/**
 * The tick's step (tick.mjs, right after the fill): start `norn mergeq --run` detached for a project that follows deliverables, unless a
 * pass of this state dir is live. o: { metaCmd (engine/bin/norn.mjs), spawnFn (tests) }. Returns the tick-log words or null.
 */
export function tickMergeq(p, state, { metaCmd, spawnFn } = {}) {
  if (!p?.file || !(p.deliverables || p.merge)) return null;
  const live = mqRunning(state);
  if (live) return `mergeq: pass pid ${live.pid} running`;
  const args = [metaCmd, 'mergeq', '--run', '--project', p.file, '--state', state];
  const r = spawnFn ? spawnFn(process.execPath, args) : spawnDetached(process.execPath, args, p.root);
  return `mergeq: started pid ${r?.pid ?? '?'}`;
}
export function spawnDetached(exe, args, cwd) {
  const away = process.env.META_JOB ? spawnOutside(exe, args, { cwd }) : null;   // from inside a reaped run's job: break away (runs.mjs)
  if (away) return away;
  const c = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: fs.existsSync(cwd || '') ? cwd : undefined });
  c.unref();
  return { pid: c.pid };
}

/** the check-in gate probe (tick.mjs gateProbes): a green batch waiting for its MERGE stage, a culprit's fix ask and batching
 *  turned OFF are MAJOR facts once the pass wrote them (dated by done_at / batching.at, so the gate's baseline lacks them) */
export function mqProbe(stateDir) {
  return ({ at }) => {
    const mq = loadMq(stateDir), b = mq.n ? loadBatch(stateDir, mq.n) : null, F = [];
    const by = t => t && Date.parse(t) <= at;
    if (b?.status === 'green' && by(b.done_at)) F.push(`mq:batch-${b.n}:green`);
    if (b?.culprit && by(b.done_at)) F.push(`mq:fix:${b.culprit.id}:${String(b.culprit.sha).slice(0, 7)}`);
    if (mq.batching.off && by(mq.batching.at)) F.push('mq:batching-off');
    return F;
  };
}
