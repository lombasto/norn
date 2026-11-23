// `norn delegate ask / start / wait`: helper runs, so a worker can hand a side question to a cheaper executor; each a normal
// supervised RUN (role "helper", class, q) on an executor outside the Claude pool - a configured typed executor (a cli entry in
// any of its NAMED modes, `--mode`, default its first read-only mode; an API entry read-only only) or `fake` for tests.
// Under a parent run (META_RUN_ID / --parent): depth 1, per-parent cap, no worktree lock (the parent holds it; startRun verifies).
// Without one (a Claude subagent of an interactive session has no RUN id): pass --worktree; a read-only helper takes no lock, a
// write-mode helper takes that worktree's lock (exit 3 when another run holds it). Machine caps, no queue: a refusal is exit 4 =
// "do it yourself". Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readEvents, fold, recordsFile } from './records.mjs';
import { startRun, sweepLost, lockPath, RunRefused, RunError, STALE_MS } from './runs.mjs';
import { isApi, isCli, isProvider, keySet, providersOf, cliMode, typedExe } from './executors.mjs';
import { presetExe } from './presets.mjs';
import { sleepMs } from './views.mjs';
import { readJsonS } from './fsnap.mjs';
import { executorsFor, withDefaults } from './policy.mjs';

export const MAX_PER_PARENT_DEFAULT = 4;
export const ASK_MAX_S = 540;
export const HELPER_BUDGET_MIN = 10;
export const MAX_LINES = 60;
const Q_CHARS = 120;
// helper executors: the configured typed executors; fake only by name (tests / smoke). Claude-pool executors (claude, <project>-*,
// fable) never, so a helper never spends the plan it is meant to save; the built-in Codex executors are not wired.

// the run fold and a file's lines, shared with norn ask
export const runsOf = state => fold(readEvents(recordsFile(state, 'run'))).items;
export const fileLines = f => { try { return fs.readFileSync(f, 'utf8').replace(/\s+$/, '').split(/\r?\n/); } catch { return []; } };

/** Ranked helper executors for class `cls`: allowed by policy, enabled, key set (API types). */
export function pickExecutors({ policy, cls, providers = {}, env = process.env }) {
  const names = Object.keys(providers);
  return executorsFor(policy, cls, names).filter(n => {
    const p = providers[n];
    return !!p && p.enabled !== false && (!isApi(p) || keySet(p, env)) && (!p.preset || !!presetExe(p, env));   // a preset: inert until its exe is detected
  });
}

/** The helper's mode: [name | null, access]. A cli entry: a named mode or an access level (default read-only); others: read-only. */
export function helperMode(executor, entry, mode) {
  if (isCli(entry)) {
    try { const [n, m] = cliMode(entry, mode || 'read-only'); return [n, m.access]; } catch (e) { throw new RunError(`executor ${executor}: ${e.message}`); }
  }
  if (mode && mode !== 'read-only') throw new RunError(`executor ${executor} has no mode ${mode}: only a cli executor has named modes (others help read-only)`);
  return [null, 'read-only'];
}

/** The generated helper brief (with the answer contract). access: read-only (default) | no-tools | write (mode = its name). */
export function helperBrief({ q, read = [], out, worktree, parent, cls, rules, access = 'read-only', mode }) {
  const write = access === 'write';
  const who = parent ? `parent ${parent}` : 'no parent run';
  return [
    `# Helper ${write ? 'task' : 'question'} (norn delegate; ${who}; class ${cls}${mode ? `; mode ${mode}` : ''})`,
    '',
    ...(write ? [`You are a helper with the tools of mode ${mode}: change files only inside the worktree, never commit or push (your caller reviews every change), and name the exact commands you ran.`,
      `Worktree: ${worktree}`, ...(rules ? [`House rules (obey them): ${rules}`] : [])]
      : access === 'no-tools' ? ['You are a helper with NO tools: answer from the text below only.', ...(rules ? [`House rules (for context only): ${rules}`] : [])]
      : ['You are a READ-ONLY helper: you have no shell and no edit tools. Do not try to run commands or change files.',
        `Worktree (read with your read / grep / list tools): ${worktree}`, ...(rules ? [`House rules (for context only): ${rules}`] : [])]),
    '',
    `## ${write ? 'Task' : 'Question'}`,
    q,
    '',
    ...(read.length ? ['## Read first', ...read.map(r => `- ${r}`), ''] : []),
    ...answerContract(out),
    '',
  ].join('\n');
}
/** The answer contract of every helper brief (delegate's and ask's): the answer is the final message, saved to `out`. */
export const answerContract = out => ['## Answer contract', '- At most 40 lines. Every claim cites file:line (or log / NOTES / transcript line).',
  '- "UNKNOWN" is allowed and preferred to a guess.', `- Your final message IS the answer (saved to ${out}).`];

/**
 * Start a helper on each ranked executor in turn: start(ex, exe) -> a result, or null to skip ex. A full machine cap (RunRefused 4)
 * tries the next one, never queues; a pinned executor (--executor) throws it. None started: RunRefused 4 "<why> - <yourself>".
 */
export function startRanked({ candidates, providers, env, machine, pinned, none, yourself }, start) {
  let last = null;
  for (const ex of candidates) {
    const prov = providers[ex], exe = prov?.preset ? presetExe(prov, env) : prov ? typedExe(prov, machine) : undefined;
    if (prov?.preset && !exe) throw new RunError(`executor ${ex}: preset ${prov.preset}: exe ${prov.exe} is not detected (not on PATH)`);
    try { const r = start(ex, exe); if (r) return r; } catch (e) {
      if (!(e instanceof RunRefused && e.code === 4) || pinned) throw e;
      last = e;
    }
  }
  throw new RunRefused(`${last ? last.message : none} - ${yourself}`, 4);
}

/**
 * Start one helper. o: { state, locksDir, env, parent?, worktree? (no parent), q, read [], cls, executor?, mode?, project (loaded)
 * | null, machine, budget, metaRoot?, budgetMin?, hbMs?, staleMs?, tick? }. Returns { run, executor, mode, dir, brief, out }.
 * Throws RunError(2) for bad input, RunRefused(3) for a lock not held / held by another run, RunRefused(4) for depth / cap.
 */
export function delegateStart(o) {
  const env = o.env || {};
  if (env.META_PARENT_RUN) throw new RunRefused(`depth 1: this is a helper of ${env.META_PARENT_RUN}; helpers do not delegate - do it yourself`, 4);
  const parentId = o.parent || env.META_RUN_ID;
  if (!parentId && !o.worktree) throw new RunError('delegate needs a parent run (META_RUN_ID, set by the supervisor, or --parent RUN-n) or, with no run of your own, --worktree W');
  if (typeof o.q !== 'string' || !o.q.trim()) throw new RunError('--q "<question>" (or --q-file F) is required');
  const cls = o.cls || 'chores';
  const staleMs = o.staleMs ?? STALE_MS;
  sweepLost(o.state, { staleMs, by: 'launcher' });
  const runs = runsOf(o.state), parent = parentId ? runs[parentId] : null;
  let worktree = o.worktree;
  if (parentId) {
    if (!parent) throw new RunError(`parent ${parentId} does not exist in ${o.state}`);
    if (parent.data.parent || parent.data.role === 'helper') throw new RunRefused(`depth 1: ${parentId} is itself a helper - do it yourself`, 4);
    if (parent.state !== 'running') throw new RunRefused(`parent ${parentId} is not running (${parent.state}) - do it yourself`, 4);
    worktree = parent.data.worktree;
    if (!worktree) throw new RunRefused(`parent ${parentId} has no worktree`, 3);
    const lock = readJsonS(lockPath(o.locksDir, worktree));
    if (lock?.run !== parentId) throw new RunRefused(`parent ${parentId} does not hold the worktree lock of ${worktree} (lock: ${lock?.run ?? 'none'})`, 3);
  } else if (!fs.existsSync(worktree)) throw new RunError(`worktree not found: ${worktree}`);

  const policy = withDefaults({ policy: o.project?.policy }).policy;
  if (parentId) {
    const cap = Number.isInteger(policy.delegate?.max_per_parent) ? policy.delegate.max_per_parent : MAX_PER_PARENT_DEFAULT;
    const live = Object.values(runs).filter(r => r.state === 'running' && r.data.parent === parentId && r.data.role === 'helper').length;
    if (live >= cap) throw new RunRefused(`${live} helpers of ${parentId} running, policy.delegate.max_per_parent=${cap} - do it yourself`, 4);
  }

  const providers = providersOf(o.project);
  let candidates;
  if (o.executor) {
    const ok = o.executor === 'fake' || Object.hasOwn(providers, o.executor);
    if (!ok) throw new RunError(`executor ${o.executor} is not a helper executor (fake | a configured typed executor name; Claude-pool executors are never helpers)`);
    if (o.executor !== 'fake' && !executorsFor(policy, cls, Object.keys(providers)).includes(o.executor)) throw new RunError(`executor ${o.executor} is not allowed to do ${cls} work (policy.allowed_classes)`);
    if (providers[o.executor]?.enabled === false) throw new RunError(`executor ${o.executor} is disabled in project.json`);
    candidates = [o.executor];
  } else {
    candidates = pickExecutors({ policy, cls, providers, env });
    if (!candidates.length) throw new RunRefused(`no helper executor for class ${cls} (allowed, enabled, key set) - do it yourself`, 4);
  }
  // the mode decides the brief: with --executor it is that entry's; ranked candidates must agree on the access (default read-only)
  const modes = Object.fromEntries(candidates.map(ex => [ex, helperMode(ex, providers[ex], o.mode)]));
  const access = modes[candidates[0]][1];

  const dir = path.join(o.state, 'delegate', `${parentId || 'top'}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const brief = path.join(dir, 'brief.md'), out = path.join(dir, 'out.md');
  // house rules = the project's own rules/common-rules.txt (META-ONBOARD S6: the engine root holds no owner rules)
  const rulesFile = o.project?.project_dir ? path.join(o.project.project_dir, 'rules', 'common-rules.txt') : null;
  const rules = rulesFile && fs.existsSync(rulesFile) ? rulesFile.replace(/\\/g, '/') : null;
  const text = helperBrief({ q: o.q, read: o.read || [], out, worktree, parent: parentId, cls, rules, access, mode: modes[candidates[0]][0] });
  fs.writeFileSync(brief, text);
  const budget = o.budget || {};
  const pick = { candidates, providers, env: o.env || process.env, machine: o.machine, pinned: !!o.executor, none: `no ranked executor with ${access} access`, yourself: 'do it yourself' };
  return startRanked(pick, (ex, exe) => {
    const prov = providers[ex], [mode, acc] = modes[ex];
    if (acc !== access) return null;   // a ranked fallback with another access would not match the written brief
    const [model, effort] = prov ? [prov.model, prov.effort || 'medium'] : ['fake', '-'];
    const r = startRun({
      state: o.state, locksDir: o.locksDir, executor: ex, provider: prov, lane: 'helper', project: o.project?.name ?? parent?.data.project,
      brief, notes: out, worktree, parent: parentId, role: 'helper', cls, q: o.q.slice(0, Q_CHARS), readonly: acc !== 'write',
      ...(mode ? { mode } : {}), lock: parentId || acc !== 'write' ? false : undefined,
      budgetMin: o.budgetMin ?? HELPER_BUDGET_MIN, model, effort, exe, promptText: isProvider(prov) ? text : undefined,
      env: { ...(prov?.env || {}), META_PARENT_RUN: parentId || 'none', META_ROLE: null }, budget, via: 'delegate',
      policy: { auto_resume_handoff: false, trigger_on_exit: false }, tick: null, projectsDir: o.machine?.claude?.projects_dir, ctx_from: o.project?.file, ...(o.gitLedger ? { git_ledger: o.gitLedger } : {}),
      ...(o.hbMs ? { hbMs: o.hbMs } : {}), staleMs,
    });
    return { run: r.run, executor: ex, mode, dir, brief, out };
  });
}

/**
 * Block until every run in `runs` has ended or maxS passes. Returns { code: 0 all ended | 5 some running, lines (<= 60) }:
 * per run an outcome line, its answer (out.md, trimmed to share the 60 lines) and the out-file path.
 */
export function delegateWait({ state, runs, maxS = ASK_MAX_S, pollMs = 250, staleMs = STALE_MS }) {
  if (!runs?.length) throw new RunError('wait needs one or more RUN ids');
  const items = () => runsOf(state);
  for (const id of runs) if (!items()[id]) throw new RunError(`${id} does not exist in ${state}`);
  const end = performance.now() + maxS * 1000;   // monotonic: a wall-clock step must not move the deadline (CLOCK-1)
  let all, n = 0;
  for (;;) {
    all = items();
    if (runs.every(id => all[id].state !== 'running')) break;
    if (performance.now() >= end) break;
    if (++n % 20 === 0) { sweepLost(state, { staleMs, by: 'launcher' }); continue; }
    sleepMs(Math.min(pollMs, Math.max(1, end - performance.now())));
  }
  const running = runs.filter(id => all[id].state === 'running');
  const per = Math.max(3, Math.floor((MAX_LINES - 1 - 2 * runs.length) / runs.length));
  const lines = [];
  for (const id of runs) {
    const it = all[id], d = it.data, outcome = it.end?.outcome ?? '';
    const why = it.state === 'lost' || it.state === 'killed' ? ` (${it.history.at(-1)?.data?.why ?? ''})` : '';
    lines.push(`${id} ${it.state}${outcome ? ' ' + outcome : ''}${why} ${d.executor ?? '-'} class ${d.class ?? '-'}: ${(d.q ?? '').replace(/\s+/g, ' ')}`.slice(0, 200));
    if (it.state !== 'running') {
      const a = fileLines(d.notes);
      lines.push(...a.slice(0, per));
      if (a.length > per) lines.push(`[... ${a.length - per} more lines in the out file]`);
    }
    lines.push(`out: ${d.notes ? d.notes.replace(/\\/g, '/') : '-'}`);
  }
  if (running.length) lines.push(`still running: ${running.join(' ')} - call \`norn delegate wait ${running.join(' ')}\` again`);
  return { code: running.length ? 5 : 0, lines: lines.slice(0, MAX_LINES) };
}

