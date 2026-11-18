// The run RESULT (gap #3): the ONLY source of a worker run's outcome. Each run has its own directory <state>/results/RUN-n/ (the
// supervisor passes it as META_RESULT_DIR and the file as META_RESULT, and makes it writable for a sandboxed executor); the worker
// writes it with `norn done`: result.json { run, outcome done | stopped | handoff, why (stopped), summary?, look? (done: the picture proof
// of a look item, META-CATCH S2: an absolute image path), at } and, for a hand-off,
// HANDOFF.md (the text the auto-resume hands the next run). A run that wrote no result ends `no-result`: nothing is inferred from its
// NOTES, which are the worker's free-form log, never a control channel. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';

export const RESULT_OUTCOMES = ['done', 'stopped', 'handoff'];
export const NO_RESULT = 'no-result';
export const resultDir = (state, run) => path.join(state, 'results', run);
export const resultPath = (state, run) => path.join(resultDir(state, run), 'result.json');
export const HANDOFF_FILE = 'HANDOFF.md';
export const handoffPath = (state, run) => path.join(resultDir(state, run), HANDOFF_FILE);
const RUN_ID = /^RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+$/;   // a node state dir's runs too (RUN-wsl-3: records.mjs kindOfId)
const HANDOFF_MAX = 64 * 1024;
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

export class ResultError extends Error { constructor(msg) { super(msg); this.code = 2; } }

/** validate { run, outcome, why?, summary?, handoff? (text), look? (image path) } -> { record, handoff }; throws ResultError */
export function makeResult({ run, outcome = 'done', why, summary, handoff, look, at = new Date().toISOString() }) {
  if (!RUN_ID.test(String(run ?? ''))) throw new ResultError(`--run must be RUN-n (got ${JSON.stringify(run ?? null)})`);
  if (!RESULT_OUTCOMES.includes(outcome)) throw new ResultError(`--outcome must be ${RESULT_OUTCOMES.join(' | ')} (got ${JSON.stringify(outcome)})`);
  const w = oneLine(why), s = oneLine(summary), h = String(handoff ?? '').trim();
  if (outcome === 'stopped' && !w) throw new ResultError('--outcome stopped needs --why "<why>"');
  if (outcome !== 'stopped' && w) throw new ResultError(`--why is for --outcome stopped only (use --summary for a ${outcome} run)`);
  if (outcome === 'handoff' && !h) throw new ResultError('--outcome handoff needs the hand-off text: --handoff-file F (or --handoff "<text>"): state, commits, the exact next step, open questions');
  if (outcome !== 'handoff' && h) throw new ResultError('--handoff / --handoff-file are for --outcome handoff only');
  if (look !== undefined && outcome !== 'done') throw new ResultError('--look is for --outcome done only (the image a DONE of a look item names)');
  if (h.length > HANDOFF_MAX) throw new ResultError(`the hand-off text is ${h.length} chars: keep it under ${HANDOFF_MAX}`);
  const record = { v: 1, run, outcome, ...(w ? { why: w } : {}), ...(s ? { summary: s.slice(0, 2000) } : {}), ...(h ? { handoff: HANDOFF_FILE } : {}), ...(look ? { look: path.resolve(String(look)).replace(/\\/g, '/') } : {}), at };
  return { record, handoff: h || null };
}

const writeAtomic = (f, text) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, text); fs.renameSync(t, f); };
/** write a run's result into its directory (dir = resultDir): HANDOFF.md first, then result.json (atomic). Returns the record. */
export function writeResult(dir, fields) {
  const { record, handoff } = makeResult(fields);
  fs.mkdirSync(dir, { recursive: true });
  if (handoff) writeAtomic(path.join(dir, HANDOFF_FILE), handoff.endsWith('\n') ? handoff : handoff + '\n');
  writeAtomic(path.join(dir, 'result.json'), JSON.stringify(record) + '\n');
  return record;
}

/**
 * a run's result directory -> { outcome, why?, summary?, handoff? (the HANDOFF.md path), look?, at } | { error } (present but unusable) |
 * null (no result.json). run = the run it must name; since (ms) = the run's start: a result written before it is not this run's.
 */
export function readResult(dir, { run, since } = {}) {
  let text;
  try { text = fs.readFileSync(path.join(dir, 'result.json'), 'utf8'); } catch { return null; }
  let j;
  try { j = JSON.parse(text); } catch { return { error: 'not JSON' }; }
  if (!j || typeof j !== 'object') return { error: 'not an object' };
  if (run && j.run !== run) return { error: `names ${JSON.stringify(j.run ?? null)}, not ${run}` };
  if (!RESULT_OUTCOMES.includes(j.outcome)) return { error: `outcome ${JSON.stringify(j.outcome ?? null)}` };
  if (j.outcome === 'stopped' && !oneLine(j.why)) return { error: 'stopped without a why' };
  const h = j.outcome === 'handoff' ? path.join(dir, HANDOFF_FILE) : null;
  if (h && !fs.existsSync(h)) return { error: `handoff without its ${HANDOFF_FILE}` };
  if (since && !(Date.parse(j.at) >= since - 2000)) return { error: `written ${j.at ?? '(no time)'}, before this run started` };
  return { outcome: j.outcome, ...(j.outcome === 'stopped' ? { why: oneLine(j.why) } : {}), ...(j.summary ? { summary: oneLine(j.summary) } : {}), ...(h ? { handoff: h } : {}), ...(j.outcome === 'done' && j.look ? { look: String(j.look) } : {}), at: j.at };
}
