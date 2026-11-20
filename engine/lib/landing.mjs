// MERGE-FIRST (3): mechanical landing - a DONE deliverable lands with no LLM. The merge queue pass (mergeq.mjs, where no fast gate
// batches) takes the top stage-gated row whose branch is pushed and idle, merges its tip into main in its own merge worktree
// (mergewt.mjs, under a merge slot like a MERGE run), runs the quick check there (quick-check.mjs: syntax + the changed
// test files; never the full suite) and opens the lane branch's PR with merge-land's openProjectPrs (it records the PR and runs the
// slop door). Only a conflict, a red check or a refused PR (a slop block) queues an LLM MERGE run - the staged merge brief with the
// failure attached. One check per pass; <state>/mq/land/<DLV>.json remembers the tip tried, so a failed tip is never retried, a new tip is.
import fs from 'node:fs';
import path from 'node:path';
import { fold, readEvents, recordsFile, record } from './records.mjs';
import { makeGit } from './dlvgit.mjs';
import { acquireLock, laneWriter, isLandingStage } from './runs.mjs';
import { mergeWtPath, slotKey, mergeParallel, ensureMergeWorktree, removeMergeWorktree } from './mergewt.mjs';
import { renderMergeBrief, suiteMode } from './mergebrief.mjs';
import { openProjectPrs, fwd, s7 } from './mergeland.mjs';
import { checkinPolicy } from './checkins.mjs';
import { gateText, subdirOf } from './monorepo.mjs';
import { fileURLToPath } from 'node:url';

export const landDir = stateDir => path.join(stateDir, 'mq', 'land');
const landFile = (stateDir, id) => path.join(landDir(stateDir), `${id}.json`);
export const loadLand = (stateDir, id) => { try { return JSON.parse(fs.readFileSync(landFile(stateDir, id), 'utf8')); } catch { return null; } };
const saveLand = (stateDir, id, o) => { fs.mkdirSync(landDir(stateDir), { recursive: true }); fs.writeFileSync(landFile(stateDir, id), JSON.stringify(o, null, 1)); };
export const QUICK_CHECK = fwd(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'quick-check.mjs'));
const QUICK_MIN = 30;

/**
 * The gate a mechanical landing runs in the merge worktree: { cmd, timeout_min } | { skip: why }. Owner ruling 2026-11-19 (MAIL-50):
 * a quick check, never the full suite - quick-check.mjs: the syntax of the files changed since base and their own test files, one at
 * a time. A pytest merge gate (solve-shack) lends its python: the changed .py compile and their test_*.py run in the project's
 * folder. The full suite runs in CI and on main after the backlog lands. policy.merge.suite = skip -> no check at all.
 */
export function landGate(project, { base, cfg }) {
  if (suiteMode(project) === 'skip') return { skip: 'policy merge.suite = skip: a clean merge runs no check' };
  const py = (String(cfg.gate?.cmd || '').match(/^\s*("[^"]+"|\S+)\s+-m\s+pytest\b/) || [])[1]?.replace(/^"|"$/g, '');
  const dir = cfg.gate?.dir ?? subdirOf(project) ?? '';
  return { cmd: `node "${QUICK_CHECK}" --base ${base}${py ? ` --python "${fwd(py)}"` : ''}${py && dir ? ` --dir "${dir}"` : ''}`, timeout_min: QUICK_MIN };
}

// the MERGE brief of a failed landing: the staged merge of the tip, with what failed put before the meta-merge marker
export function fallbackBrief(project, { row, run, failure }) {
  const notesDir = run?.data?.notes ? path.dirname(run.data.notes) : path.join(project.briefs_dir || project.root || '.', row.lane);
  const text = renderMergeBrief(project, { lane: row.lane, branch: row.branch, worktree: run?.data?.worktree || undefined, notes: fwd(path.join(notesDir, 'MERGE-NOTES.md')), sha: row.tip });
  const block = `\n## Mechanical landing failed (norn mergeq, ${row.id} at ${s7(row.tip)})\n${failure.what}: ${failure.why}${failure.log ? `\nGate log: ${fwd(failure.log)}` : ''}\n`
    + 'Fix that first: it is why this merge needs you. The rest of the steps are unchanged.\n';
  const i = text.lastIndexOf('\n<!-- meta-merge ');
  return text.slice(0, i) + block + text.slice(i);
}

/**
 * One landing step of the mergeq pass. o: { stateDir, project, locksDir, rows (mergeQueue rows), cfg, git, gateRunner (runGate),
 * cli (args -> { code, out }: the norn CLI, for the fallback MERGE and the notice), gh (merge-land's; tests fake it), now, hbMs }.
 * Returns { landed: [DLV], fallback: [{ id, kind, queued }], why }.
 */
export async function landPass(o) {
  const { stateDir, project, locksDir, rows, cfg, git = makeGit(), gateRunner, cli, gh, now = Date.now() } = o;
  const out = { landed: [], fallback: [], why: '' }, said = [];
  const runs = Object.values(fold(readEvents(recordsFile(stateDir, 'run'))).items).filter(r => r.kind === 'run');
  const landing = lane => runs.filter(r => r.data?.lane === lane && isLandingStage(r.data?.stage) && ['queued', 'running', 'claimed'].includes(r.state));
  git(cfg.repo, ['fetch', '--quiet', cfg.remote], { allowFail: true });
  for (const r of rows) {
    if (r.gate !== 'stage' || r.red || r.pr || r.branch_exists === false || r.into !== cfg.main || !r.lane || !r.tip) continue;
    const last = loadLand(stateDir, r.id);
    if (last?.tip === r.tip) continue;   // tried at this tip: its fallback MERGE (or a no-gate note) is the answer until the tip moves
    if (git(cfg.repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${cfg.remote}/${r.branch}`], { allowFail: true })?.trim() !== r.tip) { said.push(`${r.id} not pushed at ${s7(r.tip)}`); continue; }
    const live = laneWriter({ state: stateDir, locksDir, lane: r.lane, worktree: null });
    if (live) { said.push(`${r.id}: ${live}`); continue; }
    const lr = landing(r.lane);
    if (lr.some(x => x.state !== 'queued')) { said.push(`${r.id}: landing run ${lr.find(x => x.state !== 'queued').id} is live`); continue; }
    const base = git(cfg.repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${cfg.remote}/${cfg.main}^{commit}`], { allowFail: true })?.trim()
      || git(cfg.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${cfg.main}^{commit}`], { allowFail: true })?.trim();
    if (!base) { said.push(`${r.id}: no ${cfg.remote}/${cfg.main} nor ${cfg.main} to land on`); continue; }
    const gate = landGate(project, { base, cfg });
    if (r.word !== 'clean' && lr.length) { said.push(`${r.id} ${r.word}: its queued ${lr[0].id} lands it`); continue; }
    const res = await landOne({ ...o, row: r, gate, base, queuedMerges: lr, runs, git, gateRunner, cli, gh, now });
    if (res.landed) out.landed.push(r.id);
    if (res.fallback) out.fallback.push(res.fallback);
    said.push(res.why);
    if (res.gated) break;   // one gate per pass
  }
  out.why = said.length ? said.join('; ') : 'nothing to land';
  return out;
}

async function landOne({ stateDir, project, locksDir, cfg, row: r, gate, base, queuedMerges, runs, git, gateRunner, cli, gh, now, hbMs = 30000 }) {
  const ts = new Date(now).toISOString(), tag = `mergeq land ${r.id}`;
  let slot = null;
  for (let i = 0; i < mergeParallel(project) && !slot; i++) { try { slot = acquireLock(locksDir, slotKey(cfg.repo, i), { run: tag }); } catch { /* slot busy */ } }
  if (!slot) return { why: `${r.id}: the ${mergeParallel(project)} merge slot(s) are busy` };
  const wt = mergeWtPath(stateDir, r.lane, r.tip);
  let wlock = null;
  const hb = setInterval(() => { slot.refresh(); wlock?.refresh(); }, hbMs);   // a gate may run an hour: both locks stay fresh
  try {
    try { wlock = acquireLock(locksDir, wt, { run: tag }); } catch (e) { return { why: `${r.id}: merge worktree ${fwd(wt)}: ${e.message}` }; }
    // the queued MERGE of the lane would merge the same work: withdrawn (a failure below queues the MERGE again, with the failure)
    for (const q of queuedMerges.filter(x => x.state === 'queued')) { try { record(stateDir, { kind: 'run', ev: 'withdraw', id: q.id, by: 'launcher', data: { why: `mergeq lands ${r.id} mechanically` } }); } catch { /* started or gone meanwhile */ } }
    removeMergeWorktree({ repo: cfg.repo, wt, git, waitMs: 1000 });
    ensureMergeWorktree({ repo: cfg.repo, wt, main: cfg.main, remote: cfg.remote, git });
    const msg = `merge: ${r.branch} (${r.lane}) [mergeq land ${r.id}]`;
    const m = git(wt, ['merge', '--no-ff', '--no-edit', '-m', msg, r.tip], { status: true });
    if (m.code !== 0) {
      const files = (git(wt, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }) || '').split(/\r?\n/).filter(Boolean);
      git(wt, ['merge', '--abort'], { allowFail: true });
      return fail({ kind: 'conflict', what: 'Merge conflict', why: `merging ${r.branch} ${s7(r.tip)} into ${cfg.main} conflicts in ${files.join(', ') || '(git named no file)'}` });
    }
    let g = null;
    if (!gate.skip) {
      const log = path.join(stateDir, 'mq', 'land', `${r.id}-gate.log`);
      const root = path.join(landDir(stateDir), 'emptyroot');   // the suite's META_ROOT: an empty folder, never this machine's live state
      fs.mkdirSync(root, { recursive: true });
      g = await gateRunner({ ...gate, env: { META_ROOT: fwd(root) } }, { cwd: wt, log });
      if (!g.ok) return fail({ kind: 'red', what: 'Quick check red', why: `\`${gateText(gate)}\` ${g.timedOut ? `timed out after ${gate.timeout_min} min` : `exit ${g.code}`} on the merge of ${s7(r.tip)} into ${cfg.main} ${s7(base)}`, log: g.log }, true);
    }
    const pr = openProjectPrs(project, { wt, branches: [r.branch], git, ...(gh ? { gh } : {}) })[0];
    if (!pr || pr.status === 'refused') return fail({ kind: /slop/i.test(pr?.why || '') ? 'slop' : 'pr', what: /slop/i.test(pr?.why || '') ? 'Slop block' : 'PR refused', why: pr?.why || 'merge-land returned nothing' }, !gate.skip);
    saveLand(stateDir, r.id, { tip: r.tip, at: ts, status: 'landed', pr: pr.url, gate: gate.skip ? gate.skip : gateText(gate), log: g?.log ?? null });
    cli?.(['notify', '--class', 'merge', '--title', `landed ${r.branch}`, '--body', `${r.id} (${r.lane}) merged clean on ${cfg.main} ${s7(base)}, gate ${gate.skip ? 'skipped' : 'green'}: PR ${pr.url}`, '--project', fwd(project.file)]);
    return { landed: true, gated: !gate.skip, why: `${r.id} LANDED by code: PR ${pr.url} (gate ${gate.skip ? 'skipped' : 'green'})` };
  } finally {
    clearInterval(hb);
    removeMergeWorktree({ repo: cfg.repo, wt, git, waitMs: 5000 });
    wlock?.release();
    slot.release();
  }
  // a failed landing -> the LLM MERGE run with the failure attached (queued via the CLI, as the routine stage does)
  function fail(f, gated = false) {
    const st = { tip: r.tip, at: ts, status: f.kind, why: f.why, log: f.log ?? null };
    const done = runs.find(x => x.id === r.run) || null;
    if (!cli || !project.file) { saveLand(stateDir, r.id, { ...st, queued: null }); return { gated, why: `${r.id} ${f.kind}: ${f.why}; no norn CLI / project file to queue its MERGE` }; }
    const brief = fwd(path.join(project.briefs_dir || project.root || '.', `task-${String(r.lane).toUpperCase()}-MERGE-brief.md`));
    let text;
    try { text = fallbackBrief(project, { row: r, run: done, failure: f }); } catch (e) { saveLand(stateDir, r.id, { ...st, queued: null }); return { gated, why: `${r.id} ${f.kind}; the MERGE brief failed: ${e.message}` }; }
    fs.mkdirSync(path.dirname(brief), { recursive: true });
    fs.writeFileSync(brief, text);
    const cp = checkinPolicy(project.policy);
    const q = cli(['run', '--queue', '--project', fwd(project.file), '--lane', r.lane, '--stage', 'MERGE', '--brief', brief, '--executor', 'claude',
      ...(cp.merge_agent ? ['--agent', cp.merge_agent] : []), '--model', cp.merge_model, '--effort', cp.merge_effort, '--as', 'launcher']);
    const queued = q?.code === 0 ? (q.out.match(/RUN-\d+/) || [])[0] ?? null : null;
    saveLand(stateDir, r.id, { ...st, brief, queued });
    return { gated, fallback: { id: r.id, kind: f.kind, queued }, why: `${r.id} ${f.kind}: ${f.why}; ${queued ? `MERGE ${queued} queued` : `norn run --queue failed: ${String(q?.out || '').slice(0, 160)}`}` };
  }
}
