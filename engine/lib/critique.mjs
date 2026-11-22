// META-DOD 3 (owner DIR-68; the "Critique" step: a plan reviewed in the session that wrote it confirms itself - review it in a fresh
// context). Per project policy.dod.critique (off | on): a planning-class run that ends DONE gets ONE review run, queued by Norn itself
// (the supervisor -> `norn critique`): the policy's review executor, a fresh session, read-only, given the plan (the run's NOTES) and the
// request it answers (its brief + the owner's directive ids in it), asked for real problems only (policy.dod.critique_filter). Its final
// message is the findings file beside the plan (<stem>-CRITIQUE.md). A build whose brief names the plan waits for it (after
// run:RUN-n:reviewed): a clean review ("No findings.") releases it, findings wait for the check-in's review of the review run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDefaults } from './policy.mjs';
import { loadState } from './records.mjs';
import { readText } from './fsnap.mjs';
import { makeEval } from './after.mjs';

export const CRITIQUE_MODES = ['off', 'on'];
export const critiqueOn = policy => policy?.dod?.critique === 'on';
const fwd = p => String(p).replace(/\\/g, '/');
const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'CRITIQUE.md');
const DEFAULT_FILTER = 'Report a finding ONLY with a concrete scenario on the project\'s real data / real path that gives wrong output, a crash, '
  + 'nondeterminism, a gate or test that passes while the thing it guards is broken, a contract that forces a breaking change later, a '
  + 'measurable performance bug, or more complexity than the job needs. Not: hypothetical inputs, defensive hardening, style or naming.';

/** the findings file (and the review brief) of plan file `plan`: beside it, <stem>-CRITIQUE.md */
export function critiqueFiles(plan) {
  const p = fwd(plan), stem = p.replace(/\.[^./]*$/, '');
  return { findings: `${stem}-CRITIQUE.md`, brief: `${stem}-CRITIQUE.brief.md` };
}
/** the findings of a review's text: one `- [P1] ...` line each (P1-P3); "No findings." = 0; no text = null */
export function findingsCount(text) {
  if (text === null || text === undefined) return null;
  return [...String(text).matchAll(/^\s*[-*]\s*\[P[123]\]/gm)].length;
}

const BUILTIN = ['claude', 'codex-sol', 'codex-astra', 'fake'];
/** the launch of work class `cls` per the project's policy table: a named executor runs as itself, an agent name on claude */
export function classExecutor(project, cls) {
  const e = withDefaults({ policy: project?.policy }).policy.executors[cls] || {};
  const named = BUILTIN.includes(e.executor) || Object.hasOwn(project?.executors || {}, e.executor);
  const agent = !named && e.executor && !['auto', 'wait', 'opus-xhigh', 'fable'].includes(e.executor) ? e.executor : undefined;
  return { executor: named ? e.executor : 'claude', ...(agent ? { agent } : {}), ...(e.model ? { model: e.model } : {}), ...(e.effort ? { effort: e.effort } : {}) };
}

/** the review run of plan run `id` (the newest one naming it), or null */
export const critiqueOf = (items, id) => Object.values(items).filter(i => i.kind === 'run' && i.data?.critique?.of === id).sort((a, b) => Number(b.id.replace(/^RUN-(?:[^-]+-)?/, '')) - Number(a.id.replace(/^RUN-(?:[^-]+-)?/, '')))[0] ?? null;

/** why plan run `it` gets no review now (null = it gets one) */
export function critiqueSkip(it, items, policy) {
  if (!it || it.kind !== 'run') return 'no such run';
  if (!critiqueOn(policy)) return 'policy.dod.critique is off';
  if (it.data.class !== 'planning') return `${it.id} is class ${it.data.class ?? '-'}, not planning`;
  if (it.state !== 'exited' || it.end?.outcome !== 'done') return `${it.id} has not ended DONE`;
  if (!it.data.notes) return `${it.id} has no NOTES (its plan file)`;
  const prior = critiqueOf(items, it.id);
  return prior ? `already reviewed by ${prior.id}` : null;
}

/** the review brief: the plan, the request it answers (brief + directive ids), the filter, the findings form */
export function critiquePrompt({ plan, brief, filter, findings }) {
  let req = '';
  try { req = fs.readFileSync(brief, 'utf8'); } catch { /* gone: the brief path is still named */ }
  const dirs = [...new Set(req.match(/\bDIR-\d+\b/g) || [])];
  let rule = DEFAULT_FILTER;
  if (filter) { try { rule = fs.readFileSync(filter, 'utf8').trim(); } catch { rule = `${DEFAULT_FILTER}\n(policy.dod.critique_filter ${fwd(filter)} is not readable)`; } }
  return fs.readFileSync(TEMPLATE, 'utf8').replaceAll('{{plan}}', fwd(plan)).replaceAll('{{brief}}', fwd(brief))
    .replaceAll('{{dirs}}', dirs.length ? dirs.join(', ') : 'none named').replaceAll('{{filter}}', rule).replaceAll('{{findings}}', fwd(findings));
}

/** the after conditions a new run with brief `brief` waits on: each plan review its brief names that is not settled now. A brief that is
 * gone names no plan; a records error throws (read as no runs, the build would start without the review the policy requires) */
export function critiqueHolds(stateDir, brief) {
  const t = readText(brief);
  if (t === null) return [];
  const text = fwd(t).toLowerCase(), items = loadState(stateDir).items;
  const named = Object.values(items).filter(i => i.kind === 'run' && i.data?.critique?.plan && text.includes(fwd(i.data.critique.plan).toLowerCase()));
  const newest = new Map();
  for (const r of named) if (critiqueOf(items, r.data.critique.of)?.id === r.id) newest.set(r.id, r);
  const ev = makeEval(stateDir);
  return [...newest.keys()].map(id => ({ kind: 'run', id, state: 'reviewed' })).filter(c => !ev(c).met);
}

/** the plan reviews ended and not yet reviewed with findings (or no clean end): the check-in reads them before the build goes */
export function critiqueRows(items) {
  const runs = Object.values(items).filter(i => i.kind === 'run');
  return runs.filter(r => r.data?.critique && ['exited', 'lost', 'killed'].includes(r.state) && !r.review && !(r.end?.outcome === 'done' && r.end?.critique?.findings === 0))
    .map(r => ({ id: r.id, of: r.data.critique.of, plan: r.data.critique.plan, file: r.end?.critique?.file ?? fwd(r.data.notes ?? ''), findings: r.end?.critique?.findings ?? null,
      outcome: r.end?.outcome ?? r.state, holds: runs.filter(q => q.state === 'queued' && (q.data.after || []).some(c => c.kind === 'run' && c.id === r.id && c.state === 'reviewed')).map(q => q.id) }));
}

/** the review of each planning run in `runs` (Agents): { run, state, outcome, findings, file } */
export function critiqueOfNode(runs, id) {
  const r = critiqueOf(Object.fromEntries([...runs].map(x => [x.id, x])), id);
  return r ? { run: r.id, state: r.state, outcome: r.end?.outcome ?? null, findings: r.end?.critique?.findings ?? null, file: r.end?.critique?.file ?? null } : null;
}
