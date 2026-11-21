// `norn eval checkin` (META-GT3): replay sampled check-ins of a COPY of a state dir on a candidate executor; results.jsonl +
// per-tick files under --out. Reads the state copy and the recorded transcripts only; writes only under --out.
import fs from 'node:fs';
import path from 'node:path';
import { replayReport } from './report.mjs';
import { frozenContext, baselineActions, sampleTicks, evalPrompt, replayTick, scoreTick, tickContext, findBudget, summarize, guardHistory } from './checkin.mjs';

export const EVAL_USAGE = 'norn eval checkin --state <COPY of a state dir> --out <dir> [--executor claude|codex-sol|codex-astra|<provider>] [--model M] [--effort E] [--exe F] [--since-h 48] [--until ISO] [--acted 30] [--idle 12] [--ticks RUN-a,RUN-b] [--max-calls N] [--concurrency 3] [--dry]    (--dry = sample + frozen-context sizes, no calls)\n'
  + '       norn eval report --out <dir> [--state <COPY of the state: re-grade through the guards, before / after + the recorded moves through them>] [--write F] [--project P] [--json]    (META-TEND P4: the replay test report - agreement per class of ruling, every disagreement; --write F = the JSON the Spend page reads, <state>/eval/checkin-replay.json)';
const FLAGS = ['state', 'out', 'executor', 'model', 'effort', 'exe', 'since-h', 'until', 'acted', 'idle', 'ticks', 'max-calls', 'concurrency', 'dry!'];

export const readJsonl = f => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function parse(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], k = a.replace(/^--/, '');
    if (!a.startsWith('--')) throw new Error(`unexpected ${a}`);
    if (FLAGS.includes(k + '!')) { f[k] = true; continue; }
    if (!FLAGS.includes(k)) throw new Error(`unknown flag ${a}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    f[k] = argv[++i];
  }
  return f;
}

/** -> exit code. o.spawn / o.now for tests. */
export async function evalCmd(argv, { out = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n'), spawn, now = Date.now(), liveStates = [] } = {}) {
  if (argv[0] === 'report') return reportCmd(argv.slice(1), { out, err });
  let f;
  try {
    if (argv[0] !== 'checkin') throw new Error(argv[0] ? `unknown eval subcommand ${argv[0]}` : 'eval needs checkin | report');
    f = parse(argv.slice(1));
    if (!f.state || !f.out) throw new Error('--state and --out are required');
    const st = path.resolve(f.state), o = path.resolve(f.out);
    if (liveStates.some(s => path.resolve(s).toLowerCase() === st.toLowerCase())) throw new Error(`--state ${st} is a LIVE state dir: copy it first`);
    if ((o + path.sep).toLowerCase().startsWith(st.toLowerCase() + path.sep)) throw new Error('--out must not be inside --state');
  } catch (e) { err('error: ' + e.message); err('usage: ' + EVAL_USAGE); return 2; }
  const st = path.resolve(f.state), outDir = path.resolve(f.out);
  const runEvs = readJsonl(path.join(st, 'runs.jsonl')), recEvs = readJsonl(path.join(st, 'records.jsonl'));
  if (fs.existsSync(path.join(st, 'roadmap.jsonl'))) recEvs.push(...readJsonl(path.join(st, 'roadmap.jsonl')));   // META-ROADMAP S3: the same-tick duty
  const untilMs = f.until ? Date.parse(f.until) : now, sinceMs = untilMs - Number(f['since-h'] ?? 48) * 3600e3;
  let ticks = sampleTicks(runEvs, recEvs, { sinceMs, untilMs, maxActed: Number(f.acted ?? 30), idle: Number(f.idle ?? 12) });
  if (f.ticks) {
    const want = new Set(f.ticks.split(',').map(s => s.trim()));
    ticks = sampleTicks(runEvs, recEvs, { sinceMs: 0, untilMs: Infinity, maxActed: 1e9, idle: 1e9 }).filter(t => want.has(t.id));
  }
  const executor = f.executor || 'claude', model = f.model || 'claude-sonnet-5-5', effort = f.effort || 'medium', arm = `${executor}:${model}:${effort}`;
  fs.mkdirSync(outDir, { recursive: true });
  const resFile = path.join(outDir, 'results.jsonl');
  const done = new Set(fs.existsSync(resFile) ? readJsonl(resFile).filter(r => r.arm === arm && !r.error).map(r => r.tick) : []);
  const todo = ticks.filter(t => !done.has(t.id) && fs.existsSync(t.transcript)).slice(0, Number(f['max-calls'] ?? Infinity));
  out(`eval checkin ${arm}: ${ticks.length} sampled (${ticks.filter(t => t.acted).length} acted), ${done.size} done, ${todo.length} to run`);
  const jobs = todo.map(t => async () => {
    const fr = frozenContext(fs.readFileSync(t.transcript, 'utf8'));
    const ctx = tickContext(runEvs, { at: t.ts, until: t.end, budget: findBudget(fr) || {}, text: fr.text, recEvs });
    const line = `${t.id} ${t.ts} ${t.stratum} steps ${fr.steps.length} dropped ${fr.dropped.length}${fr.truncated ? ' TRUNCATED' : ''} chars ${fr.text.length} base [${t.actions.map(a => a.type).join(',')}]`;
    if (f.dry) { out(line); return; }
    const r = await replayTick({ executor, model, effort, prompt: evalPrompt(fr), dir: path.join(outDir, 'ticks'), tag: t.id, exe: f.exe, spawn });
    const score = r.error ? null : scoreTick(t.actions, r.actions, ctx);
    const row = { tick: t.id, ts: t.ts, arm, stratum: t.stratum, base: t.actions.map(({ question, ...a }) => a), cand: r.actions, nothing: r.nothing, error: r.error,
      score, ctx, usage: r.usage, cost_usd: r.cost_usd, base_cacheR: t.cacheR, chars: fr.text.length, steps: fr.steps.length, dropped: fr.dropped.length };
    fs.appendFileSync(resFile, JSON.stringify(row) + '\n');
    out(`${line} -> ${r.error ? 'ERROR ' + r.error : score.agree ? 'AGREE' : 'DIFF ' + score.worst}`);
  });
  const n = Math.max(1, Number(f.concurrency ?? 3));
  await Promise.all(Array.from({ length: n }, async () => { while (jobs.length) await jobs.shift()(); }));
  if (!f.dry && fs.existsSync(resFile)) for (const r of summarize(readJsonl(resFile))) out(JSON.stringify(r));
  return 0;
}

const pct = x => (x === null ? '-' : Math.round(100 * x) + ' %');
/** norn eval report (META-TEND P4): read <out>/results.jsonl, print the report; --write F = the JSON the Spend page reads. -> exit code */
function reportCmd(argv, { out, err }) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { f.json = true; continue; }
    if (!['--out', '--write', '--project', '--state'].includes(a) || i + 1 >= argv.length) { err(`error: unexpected ${a}`); err('usage: ' + EVAL_USAGE); return 2; }
    f[a.slice(2)] = argv[++i];
  }
  const file = f.out && path.join(path.resolve(f.out), 'results.jsonl');
  if (!file || !fs.existsSync(file)) { err(`error: ${file ? 'no ' + file : '--out is required'}`); err('usage: ' + EVAL_USAGE); return 2; }
  const rows = readJsonl(file), latest = new Map();
  for (const r of rows) latest.set(r.arm + '|' + r.tick, r);   // a re-run tick: its last row counts
  const at = new Date().toISOString(), stored = [...latest.values()];
  let rep = replayReport(stored, { project: f.project ?? null, at });
  if (f.state) {   // META-CHECKIN-GUARDS R1: the stored moves re-graded through today's grader (its guards) on the COPY of the state
    const st = path.resolve(f.state), runEvs = readJsonl(path.join(st, 'runs.jsonl')), recEvs = readJsonl(path.join(st, 'records.jsonl'));
    if (fs.existsSync(path.join(st, 'roadmap.jsonl'))) recEvs.push(...readJsonl(path.join(st, 'roadmap.jsonl')));
    const ends = new Map(runEvs.filter(e => e.ev === 'end').map(e => [e.id, e.ts]));
    const regraded = stored.map(r => {   // the stored caps / paused / RATE_OK came from the frozen text: kept; the rest from the copy
      const base = baselineActions(recEvs, runEvs, r.tick).actions.map(({ question, ...a }) => a);
      const ctx = { ...tickContext(runEvs, { at: r.ts, until: ends.get(r.tick) ?? r.ts, recEvs }), alive: r.ctx?.alive, caps: r.ctx?.caps, paused: r.ctx?.paused, rateOk: r.ctx?.rateOk };
      return { ...r, base, ctx, score: r.error ? null : scoreTick(base, r.cand, ctx) };
    });
    rep = { ...replayReport(regraded, { project: f.project ?? null, at }), before: { arms_total: rep.arms_total, classes: rep.classes }, guard_history: guardHistory(runEvs, recEvs) };
  }
  if (f.write) { fs.mkdirSync(path.dirname(path.resolve(f.write)), { recursive: true }); fs.writeFileSync(path.resolve(f.write), JSON.stringify(rep, null, 1) + '\n'); }
  if (f.json) { out(JSON.stringify(rep, null, 1)); return 0; }
  const tline = (t, w = '') => out(`${w}${t.arm}: ${t.agree} of ${t.ticks} ticks agree (${t.harmless} harmless, ${t.refused ?? 0} refused, ${t.recoverable} recoverable, ${t.harmful} harmful, ${t.errors} errors); ${(t.tokens / 1e6).toFixed(2)}M tokens, $${t.cost_usd.toFixed(2)}`);
  const cline = (c, w = '') => out(`  ${w}${c.arm} ${c.cls}: ${c.agree} of ${c.recorded} recorded rulings (${pct(c.rate)}); disagreements ${c.harmless ?? 0} harmless, ${c.refused ?? 0} refused, ${c.recoverable ?? 0} recoverable, ${c.harmful ?? 0} harmful`);
  if (rep.before) { for (const t of rep.before.arms_total) tline(t, 'BEFORE '); for (const c of rep.before.classes) cline(c, 'BEFORE '); }
  for (const t of rep.arms_total) tline(t, rep.before ? 'AFTER ' : '');
  for (const c of rep.classes) cline(c, rep.before ? 'AFTER ' : '');
  const g = rep.guard_history;
  if (g) {
    out(`GUARDS history: ${g.dispatches} recorded check-in dispatches, ${g.busy.length} refused by guard A (lane busy), ${g.dup.length} refused first by the duplicate check (exit 3); ${g.rulings} recorded check-in rulings of a Q, ${g.owner_only.length} refused by guard B (owner-only ask)`);
    for (const x of g.busy) out(`  GUARD-A ${x.id} (by ${x.by}) ${x.lane} ${x.stage}: ${x.why}`);
    for (const x of g.dup) out(`  DUP ${x.id} (by ${x.by}) ${x.lane} ${x.stage}: already ${x.of}${x.busy ? ' (guard A too)' : ''}`);
    for (const x of g.owner_only) out(`  GUARD-B ${x.id} (${x.run}) answers ${x.answers}: ${x.why}`);
  }
  for (const d of rep.disagreements) out(`DIFF ${d.arm} ${d.tick} ${d.cls} ${d.worst}: recorded [${d.recorded.join('; ') || 'nothing'}] vs [${d.cand.join('; ')}] - ${d.why.join(' | ')}`);
  for (const c of rep.choices) out(`CHOICE ${c.arm} ${c.tick} ${c.key}: recorded "${String(c.recorded).slice(0, 120)}" vs "${String(c.cand).slice(0, 120)}"`);
  if (f.write) out('wrote ' + path.resolve(f.write));
  return 0;
}
