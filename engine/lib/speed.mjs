// worker-speed (owner 2026-11-19, DIR-28): how fast a worker run works, and how that changes with the number of workers running beside
// it and the machine's CPU - the data the owner picks the worker cap (2 vs 3) from. Read-only and derived:
//   the fold   onSpeed folds a Claude transcript (read by agents.mjs tail/tailA under its own cache key: the byte-offset cache, no second
//              reader) into its model requests (start = the CLI's `api-request` line the assistant lines name by requestRef, else the last
//              user line before it; end = the request's last assistant line; output tokens = its usage, counted once) and, through
//              progress.mjs onWork, its tool calls (tool_use -> tool_result, test commands told apart by testcmd.mjs isTest, the one classifier).
//   speedOf    one window of a fold: output tok/s of model time, the wall split model / tools / tests / idle, tokens per wall hour.
//   load       workersDuring = the worker runs running at once (this one included) over a window, from the run records; cpuDuring = the
//              CPU samples runs.mjs keeps (<norn>/local/cpu.jsonl: the fill gate's and the dash's, no sampler of its own).
//   report     speedReport: one row per worker run that ended in the last N hours, then the hours grouped by workers running.
import { tail, tailA, endedAt } from './agents.mjs';
import { findTranscriptA } from './harness/claude.mjs';
import { runTranscript } from './standing.mjs';
import { workInit, onWork } from './progress.mjs';
import { isTest } from './testcmd.mjs';
import { median } from './plan.mjs';
import { fromUsage } from './cost.mjs';

const HOUR = 3600000, ROLL_MS = 10 * 60000;
const ms = iso => Date.parse(iso ?? '');

// ---------- the fold ----------
export const speedInit = () => ({ work: workInit(), req: new Map(), prev: null, msgs: new Map() });
/** fold one transcript record into the speed state: model requests by message id + request id, tool calls by onWork */
export function onSpeed(c, j) {
  onWork(c.work, j);
  const ts = ms(j.timestamp);
  if (j.type === 'api-request' && j.id && Number.isFinite(ts)) { c.req.set(j.id, ts); return; }
  if (j.type === 'user' && Number.isFinite(ts)) { c.prev = ts; return; }
  const m = j.message, u = m?.usage;
  if (j.type !== 'assistant' || !u || m.model === '<synthetic>' || !Number.isFinite(ts)) return;
  // one request's lines repeat its usage on every content block: the request is one entry, its end its last line
  const key = (m.id || '') + ':' + (j.requestId || '');
  let x = c.msgs.get(key);
  if (!x) c.msgs.set(key, x = { start: c.req.get(j.requestRef) ?? c.prev, end: ts, out: 0, ctx: 0 });
  const t = fromUsage(u);
  x.end = Math.max(x.end, ts); x.out = Math.max(x.out, t.output); x.ctx = Math.max(x.ctx, t.input + t.cache_read + t.cache_create);
}

// the length of the union of intervals [a, b] clipped to [from, to]
function unionMs(ivs, from, to) {
  const v = ivs.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let sum = 0, cur = null;
  for (const [a, b] of v) { if (!cur || a > cur[1]) { if (cur) sum += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b); }
  return cur ? sum + cur[1] - cur[0] : 0;
}
const pct = (x, w) => (w > 0 ? Math.round((100 * x) / w) : null);

/**
 * One window [from, to] (ms) of a fold -> { wall_ms, model_ms, tool_ms, test_ms, idle_ms, requests, out, ctx, tok_s, pct { model, tools,
 * tests, idle }, out_per_h, ctx_per_h }. A request counts when it ended in the window (its whole generation time); a tool call by its
 * part in the window (a live run's open calls run to `to`, an open test command already counts as a test). tools = tool time that is no test and no model time; the four % sum to ~100.
 */
export function speedOf(c, { from, to }) {
  const reqs = [...c.msgs.values()].filter(x => x.end >= from && x.end <= to && Number.isFinite(x.start) && x.start <= x.end);
  const gen = reqs.reduce((s, x) => s + (x.end - x.start), 0), out = reqs.reduce((s, x) => s + x.out, 0), ctx = reqs.reduce((s, x) => s + x.ctx, 0);
  const M = reqs.map(x => [x.start, x.end]);
  const calls = [...c.work.calls.map(x => ({ kind: x.kind, a: ms(x.ts), b: ms(x.end) })), ...Object.values(c.work.open).map(x => ({ kind: /^(Bash|PowerShell)$/.test(x.name) && isTest(String(x.cmd ?? '')) ? 'test' : 'open', a: ms(x.ts), b: to }))]
    .filter(x => Number.isFinite(x.a) && Number.isFinite(x.b));
  const T = calls.map(x => [x.a, x.b]), Tt = calls.filter(x => x.kind === 'test').map(x => [x.a, x.b]);
  const wall = Math.max(0, to - from), model = unionMs(M, from, to), busy = unionMs([...M, ...T], from, to);
  const test = unionMs([...M, ...Tt], from, to) - model, tool = busy - model - test, idle = Math.max(0, wall - busy);
  return { wall_ms: wall, model_ms: model, tool_ms: tool, test_ms: test, idle_ms: idle, requests: reqs.length, out, ctx,
    tok_s: gen > 0 ? out / (gen / 1000) : null, pct: { model: pct(model, wall), tools: pct(tool, wall), tests: pct(test, wall), idle: pct(idle, wall) },
    out_per_h: wall > 0 ? out / (wall / HOUR) : null, ctx_per_h: wall > 0 ? ctx / (wall / HOUR) : null };
}

// ---------- reading a run (the tail cache is shared with the Runs page: own key, as cost.mjs) ----------
const KEY = '\u0000speed:';
const view = (cache, f) => ({ get: () => cache.get(KEY + f), set: (_f, v) => cache.set(KEY + f, v) });
const windowOf = (r, now) => ({ from: ms(r.created), to: r.state === 'running' ? now : ms(endedAt(r)) || now });
// a run's speed from its tailed fold: the whole run, and for a live one the last ROLL_MS too
function measure(r, c, now) {
  const w = windowOf(r, now), all = speedOf(c, w);
  return r.state === 'running' ? { ...all, last10: speedOf(c, { from: Math.max(w.from, now - ROLL_MS), to: now }) } : all;
}
/** run r's speed: o { projectsDir, cache (Map), now } -> speedOf + (live) last10 | null (no Claude transcript) */
export function runSpeed(r, { projectsDir, cache = new Map(), now = Date.now() } = {}) {
  const f = runTranscript(r, { projectsDir }), t = f ? tail(f, view(cache, f), speedInit, onSpeed) : null;
  return t ? measure(r, t.c, now) : null;
}
/** runSpeed on fs.promises (the dash) */
export async function runSpeedA(r, { projectsDir, cache = new Map(), now = Date.now() } = {}) {
  const f = r.end?.transcript || r.data?.transcript || await findTranscriptA(projectsDir, r.data?.session_id), t = f ? await tailA(f, view(cache, f), speedInit, onSpeed) : null;
  return t ? measure(r, t.c, now) : null;
}

// ---------- the machine's load ----------
const QUEUED = ['queued', 'claimed', 'filled', 'withdrawn'];
/** a worker run: a lane's worker session (no helper, no check-in, no queue entry) */
export const isWorker = r => r?.kind === 'run' && r.data?.kind === 'worker' && r.data?.role !== 'helper' && !QUEUED.includes(r.state);
/** the running intervals [from, to] of worker runs (to = now while running) */
export const workerSpans = (runs, now = Date.now()) => runs.filter(isWorker).map(r => windowOf(r, now)).filter(w => Number.isFinite(w.from) && w.to >= w.from);
/** the workers running over [from, to]: { min, avg (time-weighted), max } of the count, a run counting itself when its span is in the list */
export function workersDuring(spans, from, to) {
  if (!(to > from)) return { min: null, avg: null, max: null };
  const cuts = [...new Set([from, to, ...spans.flatMap(s => [s.from, s.to]).filter(t => t > from && t < to)])].sort((a, b) => a - b);
  let min = Infinity, max = 0, area = 0;
  for (let i = 0; i + 1 < cuts.length; i++) {
    const mid = (cuts[i] + cuts[i + 1]) / 2, k = spans.filter(s => s.from <= mid && s.to >= mid).length;
    min = Math.min(min, k); max = Math.max(max, k); area += k * (cuts[i + 1] - cuts[i]);
  }
  return { min, avg: area / (to - from), max };
}
/** the CPU samples in [from, to] -> { avg, n } (avg null without a sample) */
export function cpuDuring(samples, from, to) {
  const v = samples.filter(s => s.t >= from && s.t <= to).map(s => s.cpu);
  return { avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null, n: v.length };
}

// ---------- the report ----------
/**
 * parts: [{ project, items (fold items) }] (every project of the machine: workers of all of them load it); o { now, hours (24),
 * projectsDir, cpu: [{ t, cpu }] (readCpu), cache } -> { now, since, hours, rows, groups, method }.
 * rows: one per worker run that ENDED in the window (newest end first); groups: per workers-running count k (1, 2, 3 ...) the runs whose
 * time-weighted average rounds to k (median tok/s) and the clock hours of the window whose average rounds to k (median runs done per hour).
 */
export function speedReport(parts, o = {}) {
  const now = o.now ?? Date.now(), hours = o.hours ?? 24, since = now - hours * HOUR, cache = o.cache || new Map(), cpu = o.cpu || [];
  const all = parts.flatMap(p => (p.items || []).map(r => ({ r, project: p.project }))), spans = workerSpans(all.map(x => x.r), now);
  const rows = [];
  for (const { r, project } of all) {
    if (!isWorker(r) || r.state === 'running') continue;
    const w = windowOf(r, now);
    if (!(w.to >= since && w.to <= now)) continue;
    const s = runSpeed(r, { projectsDir: o.projectsDir, cache, now }), d = r.data || {};
    rows.push({ project, run: r.id, lane: d.lane ?? null, stage: d.stage ?? null, model: r.end?.model ?? d.model ?? null, effort: r.end?.effort ?? d.effort ?? null,
      outcome: r.end?.outcome ?? null, started: r.created, ended: endedAt(r), workers: workersDuring(spans, w.from, w.to), cpu: cpuDuring(cpu, w.from, w.to), speed: s });
  }
  rows.sort((a, b) => ms(b.ended) - ms(a.ended));
  // the clock hours: workers running (time-weighted) and worker runs that ended done in that hour
  const done = all.filter(x => isWorker(x.r) && x.r.end?.outcome === 'done').map(x => ms(endedAt(x.r))), hrs = [];
  for (let t = Math.floor(since / HOUR) * HOUR; t < now; t += HOUR) {
    const a = Math.max(t, since), b = Math.min(t + HOUR, now);
    if (b - a < HOUR / 2) continue;   // a part-hour at either edge would skew a per-hour count
    hrs.push({ from: new Date(a).toISOString(), workers: workersDuring(spans, a, b).avg, done: done.filter(e => e >= a && e < b).length * HOUR / (b - a), cpu: cpuDuring(cpu, a, b).avg });
  }
  const keys = [...new Set([...rows.map(x => x.workers.avg), ...hrs.map(h => h.workers)].filter(Number.isFinite).map(Math.round))].filter(k => k > 0).sort((a, b) => a - b);
  const groups = keys.map(k => {
    const rs = rows.filter(x => Math.round(x.workers.avg) === k), hs = hrs.filter(h => Math.round(h.workers) === k);
    return { workers: k, runs: rs.length, tok_s: median(rs.map(x => x.speed?.tok_s).filter(Number.isFinite)), hours: hs.length,
      done_per_h: median(hs.map(h => h.done)), cpu: median(rs.map(x => x.cpu.avg).filter(Number.isFinite)), tests_pct: median(rs.map(x => x.speed?.pct.tests).filter(Number.isFinite)) };
  });
  return { now: new Date(now).toISOString(), since: new Date(since).toISOString(), hours, projects: parts.map(p => p.project), rows, hourly: hrs, groups, method: METHOD };
}
export const METHOD = 'tok/s = output tokens / generation time (each request: its api-request line to its last assistant line, so it includes the time to first token); '
  + 'model / tools / tests / idle = shares of the run\'s wall time (tool_use to tool_result; tests = node --test, ci-suite, pytest ...; idle = the rest); '
  + 'workers = worker runs running at once, this one included (min/avg/max over the run); cpu = the mean of the CPU samples Norn took meanwhile (fill gate + dash); main transcript only (subagents are tool time)';

const f0 = v => (Number.isFinite(v) ? String(Math.round(v)) : '-');
const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '-');
const pc = v => (Number.isFinite(v) ? `${v}` : '-');
/** the one line the Runs page shows: "tok/s 42 · model 35 % · tests 40 %" */
export const speedWords = s => (!s ? '' : `tok/s ${f0(s.tok_s)} · model ${pc(s.pct.model)} % · tests ${pc(s.pct.tests)} %`);
/** the `norn speed` table */
export function formatSpeed(rep) {
  const L = [`worker runs that ended since ${rep.since.slice(0, 16)}Z (${rep.hours} h): ${rep.rows.length}`, ''];
  const head = ['run', 'lane', 'model', 'eff', 'workers', 'cpu', 'tok/s', 'model%', 'tools%', 'tests%', 'idle%', 'min', 'out', 'outcome'];
  const t = rep.rows.map(x => { const s = x.speed, w = x.workers;
    return [rep.projects.length > 1 ? `${x.project}:${x.run}` : x.run, String(x.lane ?? '-').slice(0, 22), String(x.model ?? '-').replace(/^claude-/, ''), x.effort ?? '-', `${f0(w.min)}/${f1(w.avg)}/${f0(w.max)}`, f0(x.cpu.avg),
      s ? f0(s.tok_s) : 'no transcript', s ? pc(s.pct.model) : '-', s ? pc(s.pct.tools) : '-', s ? pc(s.pct.tests) : '-', s ? pc(s.pct.idle) : '-',
      f0((ms(x.ended) - ms(x.started)) / 60000), s ? `${f0(s.out / 1000)}k` : '-', x.outcome ?? '-']; });
  L.push(...table([head, ...t]), '', 'by workers running (rounded average):');
  L.push(...table([['workers', 'runs', 'median tok/s', 'median tests%', 'median cpu', 'hours', 'median done/h'], ...rep.groups.map(g => [String(g.workers), String(g.runs), f0(g.tok_s), f0(g.tests_pct), f0(g.cpu), String(g.hours), f1(g.done_per_h)])]));
  L.push('', rep.method);
  return L.join('\n');
}
function table(rows) {
  const w = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)));
  return rows.map(r => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd());
}
