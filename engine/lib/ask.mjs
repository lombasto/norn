// `norn ask RUN-n --q "..."`: ask a FINISHED run a question, so its work can be checked without re-reading it all.
// An executor whose caps.fork is true and whose family can fork here (claude: --resume <sid> --fork-session) answers from a FORK
// of the asked session, read-only; any other executor - or one whose fork once changed the asked transcript (the kill criterion,
// state/ask/nofork.json) - gets a COLD read-only helper whose brief carries the run's NOTES + its transcript tail, started the
// norn delegate way (its ranking, start loop and answer contract). The original session is never written to. Each ask is a
// recorded helper RUN (role helper, via ask, parent = the asked run). Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startRun, sweepLost, RunRefused, RunError, STALE_MS } from './runs.mjs';
import { providersOf, isProvider, typedExe } from './executors.mjs';
import { harnessOf, capsOf } from './harness/index.mjs';
import { transcriptEvents } from './harness/claude.mjs';
import { runTranscript } from './standing.mjs';
import { pickExecutors, helperMode, delegateWait, startRanked, answerContract, runsOf, fileLines, ASK_MAX_S, HELPER_BUDGET_MIN, MAX_LINES } from './delegate.mjs';
import { withDefaults } from './policy.mjs';
import { readJsonS } from './fsnap.mjs';

export const ENDED = ['exited', 'lost', 'killed'];
export const MAX_PER_DAY_DEFAULT = 10;
export const TAIL_LINES = 200;
export const NOTES_LINES = 150;
// the families whose adapter builds a fork command line (claude: --resume <sid> --fork-session); caps.fork elsewhere = cold
export const FORK_FAMILIES = ['claude'];
const Q_CHARS = 120;

export const noforkFile = state => path.join(state, 'ask', 'nofork.json');
export const hashFile = f => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };

/**
 * How to ask run item `it`: { mode: 'fork' | 'cold', why, sid }. Throws RunError (2) when the run is still running / queued or
 * has no session_id. nofork: { <executor>: {...} } (the kill criterion's record).
 */
export function askPlan({ it, project = null, nofork = {} }) {
  if (!it || it.kind !== 'run') throw new RunError('norn ask needs an existing RUN-n');
  if (!ENDED.includes(it.state)) throw new RunError(`${it.id} is ${it.state}: only an ended run (${ENDED.join(' | ')}) can be asked`);
  const sid = it.data.session_id || it.end?.session_id;
  if (!sid) throw new RunError(`${it.id} has no session_id: nothing to ask`);
  const ex = it.data.executor, entry = providersOf(project)[ex];
  const fam = harnessOf(ex, entry), caps = capsOf(ex, entry);
  const cold = why => ({ mode: 'cold', why, sid });
  if (!caps?.fork) return cold(`executor ${ex} cannot fork a session (caps.fork false)`);
  if (!FORK_FAMILIES.includes(fam)) return cold(`executor ${ex}: family ${fam} has no fork command here (${FORK_FAMILIES.join(', ')} only)`);
  if (nofork[ex]) return cold(`executor ${ex}: a fork changed ${nofork[ex].run}'s transcript (${nofork[ex].ts}) - cold helper from then on`);
  if (!it.data.worktree || !fs.existsSync(it.data.worktree)) return cold(`${it.id}'s worktree is gone: a fork resumes from it`);
  return { mode: 'fork', why: `fork of ${sid} (${ex}, caps.fork)`, sid };
}

/** The prompt a FORK of the asked session gets: it already remembers the run, so only the question and the rules. */
export function forkPrompt({ q, asked, out }) {
  return [`# Question about your finished run ${asked} (norn ask)`, '',
    'Your run has ENDED. You are a READ-ONLY fork of its session: change no file, run no command, commit nothing; answer from what',
    'you did in this session (you may read files to check).', '', '## Question', q, '', ...answerContract(out), ''].join('\n');
}

/** Transcript tail as text lines: a claude transcript as one line per event, else the raw lines (each cut to 300 chars). */
export function transcriptTail(file, n = TAIL_LINES) {
  const raw = fileLines(file);
  if (!raw.length) return [];
  if (!file.endsWith('.jsonl')) return raw.slice(-n).map(l => l.slice(0, 300));
  const out = [];
  for (const l of raw) {
    let evs = [];
    try { evs = transcriptEvents(l); } catch { continue; }
    for (const e of evs) if (e.kind !== 'usage' && (e.summary || e.name)) out.push(`${e.ts ?? '-'} ${e.kind}${e.name ? ' ' + e.name : ''}: ${e.summary ?? ''}`.slice(0, 300));
  }
  return out.slice(-n);
}

/** The cold helper's brief: the question, the run's NOTES (tail) and its transcript (or log) tail, the answer contract. */
export function coldBrief({ q, it, notes = [], tail = [], tailOf = 'transcript', out, access = 'read-only' }) {
  const d = it.data;
  return [`# Question about the finished run ${it.id} (norn ask, cold helper)`, '',
    access === 'no-tools' ? 'You are a helper with NO tools: answer from the text below only.'
      : `You are a READ-ONLY helper: no shell, no edit tools. You may read files of the run's worktree: ${d.worktree ?? '-'}`,
    `The run: ${it.id} ${it.state}${it.end?.outcome ? ' ' + it.end.outcome : ''}, lane ${d.lane ?? '-'}, executor ${d.executor ?? '-'} ${d.model ?? ''}, brief ${d.brief ?? '-'}.`,
    '', '## Question', q, '',
    `## The run's NOTES (${d.notes ?? 'none'}; last ${notes.length} lines)`, ...(notes.length ? notes : ['(none)']), '',
    `## The run's ${tailOf} tail (last ${tail.length} lines)`, ...(tail.length ? tail : ['(none)']), '',
    ...answerContract(out), ''].join('\n');
}

/** Asks started today (UTC) in `state` (runs with via ask). */
export function asksToday(state, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return Object.values(runsOf(state)).filter(r => r.data.via === 'ask' && String(r.created ?? '').slice(0, 10) === day).length;
}

/**
 * Start one ask. o: { state, locksDir, env, run (RUN-n), q, project (loaded) | null, machine, budget, executor? (cold: a typed
 * executor | fake), cold? (force the cold helper), budgetMin?, hbMs?, staleMs?, now? }. Returns { run, asked, mode, why, executor,
 * dir, brief, out }. Throws RunError (2) for bad input, RunRefused (4) when ask.max_per_day is spent or no cold executor is free.
 */
export function askStart(o) {
  const env = o.env || {};
  if (typeof o.q !== 'string' || !o.q.trim()) throw new RunError('--q "<question>" (or --q-file F) is required');
  const staleMs = o.staleMs ?? STALE_MS;
  sweepLost(o.state, { staleMs, by: 'launcher' });
  const it = runsOf(o.state)[o.run];
  if (!it) throw new RunError(`${o.run} does not exist in ${o.state}`);
  const policy = withDefaults({ policy: o.project?.policy }).policy;
  const cap = Number.isInteger(policy.ask?.max_per_day) ? policy.ask.max_per_day : MAX_PER_DAY_DEFAULT;
  const used = asksToday(o.state, o.now);
  if (used >= cap) throw new RunRefused(`${used} asks today, policy.ask.max_per_day=${cap} - read its NOTES yourself`, 4);
  const plan0 = askPlan({ it, project: o.project, nofork: readJsonS(noforkFile(o.state)) || {} });
  const plan = o.cold && plan0.mode === 'fork' ? { ...plan0, mode: 'cold', why: 'cold helper asked for (--cold)' } : plan0;

  const dir = path.join(o.state, 'ask', `${it.id}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  const brief = path.join(dir, 'brief.md'), out = path.join(dir, 'out.md');
  const t0 = runTranscript(it, { projectsDir: o.machine?.claude?.projects_dir }), transcript = t0 && fs.existsSync(t0) ? t0 : null;
  const d = it.data, budget = o.budget || {};
  const common = { state: o.state, locksDir: o.locksDir, lane: 'helper', project: o.project?.name ?? d.project, notes: out, parent: it.id, role: 'helper',
    cls: 'chores', q: o.q.slice(0, Q_CHARS), via: 'ask', readonly: true, lock: false, budgetMin: o.budgetMin ?? HELPER_BUDGET_MIN, budget,
    policy: { auto_resume_handoff: false, trigger_on_exit: false }, tick: null, projectsDir: o.machine?.claude?.projects_dir,
    ...(o.gitLedger ? { git_ledger: o.gitLedger } : {}), ...(o.hbMs ? { hbMs: o.hbMs } : {}), staleMs };
  const meta = { asked: it.id, sid: plan.sid, mode: plan.mode, why: plan.why, transcript, hash_before: transcript ? hashFile(transcript) : null };

  if (plan.mode === 'fork') {
    const ex = d.executor, prov = providersOf(o.project)[ex];
    const exe = prov ? typedExe(prov, o.machine) : o.machine?.claude?.exe;
    const text = forkPrompt({ q: o.q, asked: it.id, out });
    fs.writeFileSync(brief, text);
    const r = startRun({ ...common, executor: ex, provider: isProvider(prov) ? prov : undefined, brief, worktree: d.worktree, model: d.model, effort: 'medium',
      exe, promptText: text, fork_of: plan.sid, env: { ...(prov?.env || {}), META_PARENT_RUN: it.id, META_ROLE: null } });
    fs.writeFileSync(path.join(dir, 'ask.json'), JSON.stringify({ ...meta, run: r.run, executor: ex }, null, 1));
    return { run: r.run, asked: it.id, mode: 'fork', why: plan.why, executor: ex, dir, brief, out };
  }

  // cold: a read-only helper on a helper executor (norn delegate's ranking; fake by name)
  const providers = providersOf(o.project);
  const candidates = o.executor ? [o.executor] : pickExecutors({ policy, cls: 'chores', providers, env });
  if (o.executor && o.executor !== 'fake' && !Object.hasOwn(providers, o.executor)) throw new RunError(`executor ${o.executor} is not a helper executor (fake | a configured typed executor name)`);
  if (!candidates.length) throw new RunRefused(`no helper executor for a cold ask (${plan.why}) - read its NOTES yourself`, 4);
  const tailFile = transcript || d.log;
  const notesTail = fileLines(d.notes).slice(-NOTES_LINES);
  const tail = tailFile ? transcriptTail(tailFile) : [];
  const worktree = d.worktree && fs.existsSync(d.worktree) ? d.worktree : dir;
  return startRanked({ candidates, providers, env, machine: o.machine, pinned: !!o.executor, yourself: 'read its NOTES yourself' }, (ex, exe) => {
    const prov = providers[ex], [mode, access] = helperMode(ex, prov, null);
    const text = coldBrief({ q: o.q, it, notes: notesTail, tail, tailOf: transcript ? 'transcript' : 'log', out, access });
    fs.writeFileSync(brief, text);
    const r = startRun({ ...common, executor: ex, provider: prov, brief, worktree, model: prov ? prov.model : 'fake', effort: prov ? prov.effort || 'medium' : '-',
      exe, ...(mode ? { mode } : {}), promptText: isProvider(prov) ? text : undefined, env: { ...(prov?.env || {}), META_PARENT_RUN: it.id, META_ROLE: null } });
    fs.writeFileSync(path.join(dir, 'ask.json'), JSON.stringify({ ...meta, run: r.run, executor: ex }, null, 1));
    return { run: r.run, asked: it.id, mode: 'cold', why: plan.why, executor: ex, dir, brief, out };
  });
}

/**
 * The kill criterion (plan sec. 2.6): a fork that changed the asked run's transcript is not isolated - record the executor in
 * state/ask/nofork.json (later asks of it go cold). Returns null (isolated / not a fork) or the recorded entry.
 */
export function checkIsolation(state, dir, now = new Date()) {
  const a = readJsonS(path.join(dir, 'ask.json'));
  if (!a || a.mode !== 'fork' || !a.transcript || !a.hash_before) return null;
  const after = hashFile(a.transcript);
  if (after === a.hash_before) return null;
  const f = noforkFile(state), cur = readJsonS(f) || {};
  const entry = { run: a.asked, ask: a.run, ts: now.toISOString(), hash_before: a.hash_before, hash_after: after };
  cur[a.executor] = entry;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cur, null, 1));
  return { executor: a.executor, ...entry };
}

/** Wait for the ask run (delegate's wait: exit 0 ended / 5 running, <= 60 lines), then apply the kill criterion once it ended. */
export function askWait({ state, run, dir, maxS = ASK_MAX_S, staleMs = STALE_MS }) {
  const w = delegateWait({ state, runs: [run], maxS, staleMs });
  if (w.code === 0 && dir) {
    const k = checkIsolation(state, dir);
    if (k) w.lines = [...w.lines.slice(0, MAX_LINES - 1), `KILL: the fork changed ${k.run}'s transcript - executor ${k.executor} asks go cold from now on (${fwd(noforkFile(state))})`];
  }
  return w;
}
const fwd = p => p.replace(/\\/g, '/');
