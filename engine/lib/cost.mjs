// Cost per lane (META-OPS-R1, META-OVERVIEW-2026-11-08 #7): tokens by type per RUN and their roll-up per day / lane / stage /
// executor, weighted to a %-of-week through the budget's calibration (cacheR_per_pct). Claude: an ended run counts its CLI final
// usage (claude -p json, = its transcript sum), a running / killed / lost one its transcript (+ subagents), tailed incrementally.
// Codex: totals only (rollout token_count live, end.tokens at the end) - its own plan, no Claude %. Providers bill their own
// account. Node built-ins only; the transcript tail is the Runs page's (agents.mjs), the file finders the harness adapters'.
import { tail, codexInfo, subFiles } from './agents.mjs';
import { runTranscript } from './standing.mjs';
import { findRollout } from './harness/codex.mjs';
import { parseCodexLog } from './runs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Price ratios to one cache read (Anthropic list pricing, every current Claude model: cache read 0.1x base input, 5-min cache
// write 1.25x, 1-h cache write 2x, output 5x input). A cache write without the 5m / 1h split counts as 1 h (the CLI's default).
export const WEIGHTS = { cache_read: 1, cache_create_5m: 12.5, cache_create_1h: 20, input: 10, output: 50 };
const TYPES = ['cache_read', 'cache_create', 'input', 'output'];
const zero = () => ({ cache_read: 0, cache_create: 0, input: 0, output: 0, weighted: 0 });
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const add = (a, b) => { for (const k of [...TYPES, 'weighted']) a[k] += b[k]; return a; };
const sum4 = t => t.cache_read + t.cache_create + t.input + t.output;

/** An API usage object (transcript message / CLI final json) -> { cache_read, cache_create, input, output, weighted }. */
export function fromUsage(u = {}) {
  const t = { cache_read: num(u.cache_read_input_tokens), cache_create: num(u.cache_creation_input_tokens), input: num(u.input_tokens), output: num(u.output_tokens) };
  const c5 = Math.min(t.cache_create, num(u.cache_creation?.ephemeral_5m_input_tokens));
  t.weighted = t.cache_read * WEIGHTS.cache_read + c5 * WEIGHTS.cache_create_5m + (t.cache_create - c5) * WEIGHTS.cache_create_1h
    + t.input * WEIGHTS.input + t.output * WEIGHTS.output;
  return t;
}

const COST_KEY = '\u0000cost:';   // own entries in a shared tail cache (the Runs page keys its by plain path)
function onAssistant(c, j) {
  const m = j.message, us = m?.usage;
  if (j.type !== 'assistant' || !us) return;
  const key = (m.id || '') + ':' + (j.requestId || '');
  if (c.seen.has(key)) return;
  c.seen.add(key);
  add(c.sum, fromUsage(us));
}
function tailUsage(file, cache) {
  const k = COST_KEY + file, view = { get: () => cache.get(k), set: (_f, v) => cache.set(k, v) };
  return tail(file, view, () => ({ seen: new Set(), sum: zero() }), onAssistant);
}

/** One Claude transcript + its subagents (<sid>/subagents/agent-*.jsonl): { tokens, bytesRead } or null when missing. */
export function transcriptUsage(file, cache = new Map()) {
  const r = tailUsage(file, cache);
  if (!r) return null;
  const tokens = add(zero(), r.c.sum);
  let bytesRead = r.bytesRead;
  for (const f of subFiles(file)) { const s = tailUsage(f, cache); if (s) { add(tokens, s.c.sum); bytesRead += s.bytesRead; } }
  return { tokens, bytesRead };
}

const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const NONE = family => ({ family, src: null, tokens: null, total: null });

/**
 * Usage of one run (a records fold item). o: { projectsDir, codexDir, cache (tail Map), memo (Map: ended runs, never re-read), stats }
 * -> { family: claude | codex | provider | grok, src: end | live | transcript | null, tokens (Claude / provider types) | null, total }
 */
export function usageOfRun(r, o = {}) {
  const live = r.state === 'running', memo = o.memo, mk = r.id + '@' + r.updated;
  if (!live && memo?.has(mk)) return memo.get(mk);
  const v = measure(r, o, live);
  if (!live && memo) memo.set(mk, v);
  return v;
}
function measure(r, o, live) {
  const d = r.data || {}, end = r.end || {}, exe = d.executor || '', cache = o.cache || new Map(), st = o.stats || {};
  if (exe.startsWith('codex')) {
    const fin = end.tokens ?? end.usage?.tokens;
    if (!live && Number.isFinite(fin)) return { family: 'codex', src: 'end', tokens: null, total: fin };
    const b = d.log ? parseCodexLog(readText(d.log)) : {};
    const ro = findRollout(o.codexDir, end.codex_session ?? b.session_id), ci = ro ? codexInfo(ro, cache) : null;
    if (ci && ci.total !== null) return { family: 'codex', src: live ? 'live' : 'transcript', tokens: null, total: ci.total };
    return Number.isFinite(b.tokens) ? { family: 'codex', src: 'end', tokens: null, total: b.tokens } : NONE('codex');
  }
  if (exe === 'grok') return NONE('grok');
  const family = d.kind === 'provider' ? 'provider' : 'claude';
  if (!live && end.usage && 'cache_read_input_tokens' in end.usage) { const t = fromUsage(end.usage); return { family, src: 'end', tokens: t, total: sum4(t) }; }
  const file = runTranscript(r, o);
  const tu = file ? transcriptUsage(file, cache) : null;
  if (!tu) return NONE(family);
  st.bytesRead = (st.bytesRead || 0) + tu.bytesRead;
  return { family, src: live ? 'live' : 'transcript', tokens: tu.tokens, total: sum4(tu.tokens) };
}

const DAY = 86400000, WEEK = 7 * DAY;
/** The start of the current weekly window: the budget's reset instant stepped by whole weeks to the last one <= now. */
export function weekStart(resetMs, now = Date.now()) { return resetMs + Math.floor((now - resetMs) / WEEK) * WEEK; }
// the NEXT weekly reset after now (VISUAL-B S1 bug 2): the budget's reset key is one past reset; roll it forward by weeks
export function nextReset(iso, now = Date.now()) {
  const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? new Date(weekStart(t, now) + 7 * 86400000).toISOString() : null;
}
// the budget reset string ("YYYY-MM-DDTHH:MM local") -> ISO instant, else null
export function parseReset(value) {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s+local$/i, '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return null;
  const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
const endTs = r => { const h = (r.history || []).findLast?.(x => x.ev === 'end' || x.ev === 'kill' || x.ev === 'lost'); return h ? Date.parse(h.ts) : NaN; };

/** lane-collide S3 (SPEC 4A.6 resolve_tokens, duplicate_tokens): the totals of a set of runs (records fold items) -> { runs, tokens (usageOfRun
 *  totals: a Claude transcript with its subagents), min (start to end; a running run to o.now), unmeasured (no measure: counted, never guessed) } */
export function runsTotal(runs, o = {}) {
  const t = { runs: 0, tokens: 0, min: 0, unmeasured: 0 }, now = o.now ?? Date.now();
  for (const r of runs) {
    const u = usageOfRun(r, o), s = Date.parse(r.history?.find(h => h.ev === 'start')?.ts ?? r.created), e = r.state === 'running' ? now : endTs(r);
    t.runs++; if (u.total === null) t.unmeasured++; else t.tokens += u.total;
    if (Number.isFinite(s) && Number.isFinite(e)) t.min += Math.max(0, e - s) / 60000;
  }
  t.min = Math.round(t.min);
  return t;
}

/**
 * The roll-up: o { now, days (rolling window), resetAt (budget weekly reset: the headline window is last reset -> now), cacheRPerPct (budget calibration), project, projectsDir, codexDir, cache, memo }.
 * rows: one per (day of start, lane, stage, executor) with runs / running / tokens by type / weighted / pct (Claude only).
 * %-of-week: the window's Claude cacheR / cacheR_per_pct (the calibration's own measure), shared out by price-weighted tokens.
 */
export function costRollup(items, o = {}) {
  const t0 = process.hrtime.bigint(), now = o.now ?? Date.now(), days = o.days ?? 7, rollSince = now - days * DAY, perPct = o.cacheRPerPct || null;
  const resetMs = typeof o.resetAt === 'number' ? o.resetAt : Date.parse(o.resetAt ?? ''), week = Number.isFinite(resetMs);
  const since = week ? weekStart(resetMs, now) : rollSince, winDays = week ? Math.max((now - since) / DAY, 1 / 24) : days;
  const stats = { bytesRead: 0 }, rows = new Map(), runs = items.filter(i => i.kind === 'run');
  const ck = { ticks: 0, sum: zero(), dur: [], last24h: { ticks: 0, ...zero() } };
  const sec = { rolling: { days, since: new Date(rollSince).toISOString(), runs: 0, cache_read: 0 }, last24h: { runs: 0, cache_read: 0 } };
  for (const r of runs) {
    const c = Date.parse(r.created);
    if (!(c >= Math.min(since, rollSince))) continue;
    const d = r.data || {}, u = usageOfRun(r, { ...o, stats });
    if (u.family === 'claude' && u.tokens) {                                    // secondary rows: Claude cacheR, rolling N days + 24 h
      if (c >= rollSince) { sec.rolling.runs++; sec.rolling.cache_read += u.tokens.cache_read; }
      if (c >= now - DAY) { sec.last24h.runs++; sec.last24h.cache_read += u.tokens.cache_read; }
    }
    if (!(c >= since)) continue;
    const key = [r.created.slice(0, 10), d.lane ?? '-', d.stage ?? '-', d.executor || d.kind || '-'].join('|');
    let x = rows.get(key);
    if (!x) rows.set(key, x = { project: o.project ?? null, day: r.created.slice(0, 10), lane: d.lane ?? '-', stage: d.stage ?? '-',
      executor: d.executor || d.kind || '-', family: u.family, runs: 0, running: 0, unmeasured: 0, tokens: 0, ...zero(), pct: null });
    x.runs++; if (r.state === 'running') x.running++;
    if (u.total === null) { x.unmeasured++; continue; }
    x.tokens += u.total;
    if (u.tokens) add(x, u.tokens);
    if (d.kind === 'checkin' && u.tokens) {
      ck.ticks++; add(ck.sum, u.tokens);
      const e = endTs(r); if (Number.isFinite(e)) ck.dur.push((e - c) / 1000);
      if (c >= now - DAY) { ck.last24h.ticks++; add(ck.last24h, u.tokens); }
    }
  }
  const out = [...rows.values()];
  for (const x of out) if (x.family !== 'claude' && x.family !== 'provider') for (const k of [...TYPES, 'weighted']) x[k] = null;
  const claude = out.filter(x => x.family === 'claude'), tot = add(zero(), claude.reduce((a, x) => add(a, x), zero()));
  const mix = tot.weighted > 0 ? tot.cache_read / tot.weighted : null;          // cacheR per weighted token over the window
  const pctOf = w => (perPct && mix !== null ? (w * mix) / perPct : null);
  for (const x of claude) x.pct = pctOf(x.weighted);
  const fam = f => out.filter(x => x.family === f).reduce((a, x) => ({ runs: a.runs + x.runs, tokens: a.tokens + x.tokens }), { runs: 0, tokens: 0 });
  const per = (s, n) => (n ? { ...Object.fromEntries([...TYPES, 'weighted'].map(k => [k, s[k] / n])), pct: pctOf(s.weighted / n) } : null);
  // account headline (META-OPS-R3): o.account = the provider's account usage since the same reset (readAccountUsage), or none
  const runsPct = perPct ? tot.cache_read / perPct : null, A = o.account;
  let account = null;
  if (A && perPct) {
    const raw = A.cache_read - tot.cache_read;
    account = { provider: A.provider, cache_read: A.cache_read, messages: A.messages, files: A.files, at: A.at, age_s: A.age_s, pct: A.cache_read / perPct,
      outside: { cache_read: Math.max(0, raw), pct: Math.max(0, raw) / perPct, raw_cache_read: raw, raw_pct: raw / perPct, clamped: raw < 0 } };
  }
  const headline = account ? { source: 'account', provider: account.provider, pct: account.pct } : { source: 'runs', provider: null, pct: runsPct };
  const meanS = ck.dur.length ? ck.dur.reduce((a, b) => a + b, 0) / ck.dur.length : null;
  return {
    project: o.project ?? null, now: new Date(now).toISOString(), since: new Date(since).toISOString(), days,
    window: week ? 'week' : 'rolling', next_reset: week ? new Date(since + WEEK).toISOString() : null,
    secondary: { rolling: { ...sec.rolling, pct: perPct ? sec.rolling.cache_read / perPct : null },
      last24h: { ...sec.last24h, pct: perPct ? sec.last24h.cache_read / perPct : null } },
    headline, account,
    calib: { cacheR_per_pct: perPct, mix, weights: WEIGHTS },
    rows: out.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.tokens - a.tokens),
    totals: { claude: { runs: claude.reduce((a, x) => a + x.runs, 0), ...tot, tokens: sum4(tot), pct: runsPct },
      codex: fam('codex'), provider: fam('provider'), unmeasured: out.reduce((a, x) => a + x.unmeasured, 0) },
    checkins: { ticks: ck.ticks, ticks_per_day: ck.ticks / winDays, days: winDays, mean_s: meanS, per_tick: per(ck.sum, ck.ticks),
      pct_per_day: perPct && ck.ticks ? pctOf(ck.sum.weighted) / winDays : null,
      last24h: { ...ck.last24h, pct: pctOf(ck.last24h.weighted) } },
    cost: { runs: runs.length, bytesRead: stats.bytesRead, ms: Number(process.hrtime.bigint() - t0) / 1e6 },
  };
}

// ---------- account usage (META-OPS-R3): the account's weekly number, not only the norn runs ----------
// Every assistant message in the Claude transcripts root (machine.json claude.projects_dir) with a claude-* model, deduped on
// message id + request id across all files, kept per file as [ts, cache_read, cache_create, input, output, weighted] entries
// (exact window edges) and offset-cached in one state-dir JSON file ({files: {path: {size, offset, head, keys, e}}}). A shrunk
// file or one whose head changed is rescanned (its entries and keys dropped first); a deleted one leaves. Entries / keys older
// than RETAIN_DAYS are pruned at save. The first scan reads the whole root (minutes): run it OFF the request path
// (account-refresh.mjs: the dash's background worker or the CLI); readers only read the cache file.
const RETAIN_DAYS = 10, HEAD = 256, CHUNK = 8 << 20;
const keyOf = (m, j) => createHash('sha1').update((m.id || '') + ':' + (j.requestId || '')).digest('base64url').slice(0, 16);
function jsonlFiles(dir, out = []) {
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, out); else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
// replaced: the bytes both heads cover differ (a grown file keeps its old head as a prefix)
const replaced = (a, b) => { const x = Buffer.from(a || '', 'base64'), y = Buffer.from(b, 'base64'), n = Math.min(x.length, y.length); return !x.subarray(0, n).equals(y.subarray(0, n)); };
function readHead(fd, size) { const b = Buffer.alloc(Math.min(HEAD, size)); fs.readSync(fd, b, 0, b.length, 0); return b.toString('base64'); }
/** Scan the appended bytes of one file into its cache entry x; seen = the global key set. Returns bytes consumed. */
function scanFile(file, x, size, seen, floor) {
  const fd = fs.openSync(file, 'r');
  let used = 0;
  try {
    let pos = x.offset, carry = Buffer.alloc(0);
    while (pos < size) {
      const b = Buffer.alloc(Math.min(CHUNK, size - pos)), n = fs.readSync(fd, b, 0, b.length, pos);
      if (n <= 0) break;
      pos += n;
      const buf = carry.length ? Buffer.concat([carry, b.subarray(0, n)]) : b.subarray(0, n), nl = buf.lastIndexOf(10);
      if (nl < 0) { carry = buf; continue; }
      for (const ln of buf.subarray(0, nl).toString('utf8').split('\n')) {
        if (!ln.includes('"assistant"') || !ln.includes('"usage"')) continue;
        let j; try { j = JSON.parse(ln); } catch { continue; }
        const m = j.message, us = m?.usage;
        if (j.type !== 'assistant' || !us || !/^claude-/.test(m.model || '')) continue;
        const ts = Date.parse(j.timestamp);
        if (!(ts >= floor)) continue;
        const k = keyOf(m, j);
        if (seen.has(k)) continue;
        seen.add(k); x.keys.push(k);
        const t = fromUsage(us);
        x.e.push([ts, t.cache_read, t.cache_create, t.input, t.output, t.weighted]);
      }
      used += nl + 1; carry = buf.subarray(nl + 1);
    }
  } finally { fs.closeSync(fd); }
  x.offset += used;
  return used;
}
const loadCache = f => { try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); return c && c.files ? c : null; } catch { return null; } };

/** o: { projectsDir, cacheFile, now?, entries? } -> { files, bytesRead, rescanned, opened, ms, at, entries? (o.entries) }; writes the cache file atomically. */
export function refreshAccountUsage(o) {
  const t0 = process.hrtime.bigint(), now = o.now ?? Date.now(), floor = now - RETAIN_DAYS * DAY;
  const prev = loadCache(o.cacheFile), old = prev && prev.projectsDir === path.resolve(o.projectsDir) ? prev.files : {};
  const files = {}, seen = new Set();
  const list = jsonlFiles(o.projectsDir).sort();
  for (const f of list) if (old[f]) for (const k of old[f].keys) seen.add(k);
  let bytesRead = 0, rescanned = 0, opened = 0;
  for (const f of list) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    let x = old[f];
    const prune = y => { const keep = y.e.map((e, i) => e[0] >= floor ? i : -1).filter(i => i >= 0);
      if (keep.length !== y.e.length) { y.e = keep.map(i => y.e[i]); y.keys = keep.map(i => y.keys[i]); } return y; };
    // cheap paths (an open costs ~20 ms here: the AV hook): unchanged size + mtime -> not opened; a file last written before the
    // retention floor holds no entry we keep -> not read, marked skipped (any later change rescans it from 0)
    if (x && st.size === x.size && st.mtimeMs === x.mtimeMs) { files[f] = prune(x); continue; }
    if (x?.skipped) x = null;
    if (!x && st.mtimeMs < floor) { files[f] = { size: st.size, offset: st.size, mtimeMs: st.mtimeMs, head: '', skipped: true, keys: [], e: [] }; continue; }
    let fd; try { fd = fs.openSync(f, 'r'); } catch { continue; }
    opened++;
    let head; try { head = readHead(fd, st.size); } finally { fs.closeSync(fd); }
    if (x && (st.size < x.offset || replaced(x.head, head))) {
      for (const k of x.keys) seen.delete(k);
      x = null; rescanned++;
    }
    x ??= { size: 0, offset: 0, head: '', keys: [], e: [] };
    x.head = head;
    try { bytesRead += scanFile(f, x, st.size, seen, floor); } catch { /* unreadable now: keep what we had */ }
    x.size = st.size; x.mtimeMs = st.mtimeMs;
    files[f] = prune(x);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6, at = new Date(now).toISOString();
  fs.mkdirSync(path.dirname(o.cacheFile), { recursive: true });
  const tmpF = o.cacheFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmpF, JSON.stringify({ version: 1, provider: 'claude', projectsDir: path.resolve(o.projectsDir), at, scan_ms: ms, bytes_read: bytesRead, files }));
  fs.renameSync(tmpF, o.cacheFile);
  const res = { files: list.length, bytesRead, rescanned, opened, ms, at };
  if (o.entries) res.entries = Object.values(files).flatMap(x => x.e);   // for the dash worker: read without parsing the cache
  return res;
}

const readMemo = new Map();   // cacheFile -> { mtimeMs, size, c }: the dash re-parses the cache only when it changed
/** o: { cacheFile, since, until?, now? } -> { provider, cache_read, cache_create, input, output, weighted, messages, files, at, age_s, scan_ms } | null */
export function readAccountUsage(o) {
  let st; try { st = fs.statSync(o.cacheFile); } catch { return null; }
  let h = readMemo.get(o.cacheFile);
  if (!h || h.mtimeMs !== st.mtimeMs || h.size !== st.size) { const c = loadCache(o.cacheFile); if (!c) return null; readMemo.set(o.cacheFile, h = { mtimeMs: st.mtimeMs, size: st.size, c }); }
  const c = h.c;
  return { ...sumEntries(Object.values(c.files).flatMap(x => x.e), c.at, o), provider: c.provider || 'claude', files: Object.keys(c.files).length, scan_ms: c.scan_ms ?? null };
}
/** Entries [ts, cacheR, cacheC, input, output, weighted] in [since, until) -> sums + messages + the cache age. */
function sumEntries(entries, at, o) {
  const since = o.since ?? -Infinity, until = o.until ?? Infinity, now = o.now ?? Date.now(), s = { ...zero(), messages: 0 };
  for (const e of entries) {
    if (!(e[0] >= since && e[0] < until)) continue;
    s.cache_read += e[1]; s.cache_create += e[2]; s.input += e[3]; s.output += e[4]; s.weighted += e[5]; s.messages++;
  }
  return { provider: 'claude', ...s, files: null, at, age_s: Math.round((now - Date.parse(at)) / 1000) };
}
/** Claude account usage from the entries a refresh handed over (o.entries + o.at) or else from the cache file (o.cacheFile). */
const readClaude = o => (o.entries ? sumEntries(o.entries, o.at, o) : readAccountUsage(o));
/** Account-usage sources per provider (harness-agnostic): a provider without one has no account number ("account: n/a"). */
export const ACCOUNT_SOURCES = { claude: { refresh: refreshAccountUsage, read: readClaude } };
export function accountUsage(provider, o) { const s = ACCOUNT_SOURCES[provider]; return s ? s.read(o) : null; }
