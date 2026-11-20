// META-STANDING-CONTEXT R1 (DIR-21): the standing context - what one session loads before any work, re-read on EVERY turn.
// MEASURE: per run, from the transcripts Norn already reads (the cost / Runs page tails): turn-1 context (input + cache create +
// cache read of the first API call), its cache create, the run's total cache reads (each API message once: message id + request
// id; an ended run: its CLI final = that process's sum) and its turns; per role (worker, merge, check-in, chat; other harnesses
// apart) and per day: the median standing context + the day's cache-read total.
// EXPLAIN: the first request as the harness records it (Claude Code 2.1.3xx: api-request-shape + api-request-blob) split into its
// parts, each with ~tokens = the measured turn 1 shared out by characters; older transcripts: the attachments, the rest = base.
// PROFILES: lean launch profiles are DATA (policy.launch); the harness adapters own the flags (profileArgs). Never --bare.
// Reads only. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import { tail } from './agents.mjs';
import { findTranscript, usageCtx } from './harness/claude.mjs';
import { findRollout, parseCodexLog } from './harness/codex.mjs';
import { HEADLESS_CORE } from './harness/common.mjs';
import { harnessOf } from './harness/index.mjs';
import { loadState } from './records.mjs';
import { threadFile } from './chatact.mjs';
import { profileOf, PROFILE_ROLES } from './launchpolicy.mjs';
// the launch profiles / memory switch live in launchpolicy.mjs (no import cycle with runs.mjs: META-QUEUE-SPEC R1)

export const STANDING_METHOD = 'standing context = the first API call of a session (input + cache create + cache read, from its transcript); '
  + 'the parts share that measured total out by their characters in the first request the harness recorded (Claude Code: api-request-shape '
  + '+ blobs; older transcripts: the attachments at ~chars / 4, the rest = the harness base); cache reads = every API message once '
  + '(message id + request id; an ended run: its CLI final), counted on the day the run started; Codex: the first token_count of the rollout';

/** the parts, in the order the tab shows them; ours = Norn / the owner can trim it */
export const PARTS = [
  { key: 'base', label: 'harness base prompt + tool schemas', ours: false },
  { key: 'agent', label: 'agent (role) prompt', ours: true },
  { key: 'norn', label: "Norn's appended prompt", ours: true },
  { key: 'claude_md', label: 'CLAUDE.md / AGENTS.md chain', ours: true },
  { key: 'memory', label: 'memory index', ours: true },
  { key: 'hooks', label: 'hook-injected text', ours: true },
  { key: 'skills', label: 'skills list', ours: true },
  { key: 'plugins', label: 'plugins (their skills)', ours: true },
  { key: 'agents', label: 'agents list', ours: true },
  { key: 'mcp', label: 'MCP servers: instructions + tools', ours: true },
  { key: 'prompt', label: 'the prompt (brief path / tick)', ours: true },
];
const PART_KEYS = PARTS.map(p => p.key);
const DAY = 86400000;
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// ---------- the head of a transcript: everything up to the first API answer at / after `since` ----------
/** file -> { version, agent, ts, usage { input, cache_create, cache_read, context }, shape, messages, attachments } | null */
export function transcriptHead(file, { since = null, maxBytes = 64 * 1024 * 1024 } = {}) {
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return null; }
  const t0 = since ? Date.parse(since) : NaN, blobs = new Map();
  let out = { version: null, agent: null, shape: null, req: null, attachments: [] }, rest = '', pos = 0, done = null;
  const onLine = line => {
    let j; try { j = JSON.parse(line); } catch { return; }
    if (j.type === 'agent-setting') out.agent = j.agentSetting ?? out.agent;
    else if (j.type === 'api-request-shape') { out.shape = j.shape; out.version = j.version ?? out.version; }
    else if (j.type === 'api-request-blob') blobs.set(j.hash, j.message);
    else if (j.type === 'api-request') { out.req = j; out.version = j.version ?? out.version; }
    else if (j.type === 'attachment' && j.attachment) out.attachments.push(j.attachment);
    else if (j.type === 'assistant' && j.message?.usage) {
      if (Number.isFinite(t0) && Date.parse(j.timestamp) < t0) { out = { ...out, shape: null, req: null, attachments: [] }; return; }   // an earlier process (resume)
      const u = j.message.usage;
      done = { ts: j.timestamp ?? null, usage: { input: num(u.input_tokens), cache_create: num(u.cache_creation_input_tokens), cache_read: num(u.cache_read_input_tokens) } };
    }
  };
  try {
    const buf = Buffer.alloc(1024 * 1024);
    while (!done && pos < maxBytes) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const lines = (rest + buf.subarray(0, n).toString('utf8')).split('\n');
      rest = lines.pop();
      for (const l of lines) { if (l.trim()) onLine(l); if (done) break; }
    }
    if (!done && rest.trim()) onLine(rest);
  } finally { fs.closeSync(fd); }
  if (!done) return null;
  const u = done.usage;
  const messages = (out.req?.tail || []).map(h => blobs.get(h)).filter(Boolean);
  return { file, version: out.version, agent: out.agent, ts: done.ts, usage: { ...u, context: u.input + u.cache_create + u.cache_read },
    shape: out.shape, messages, attachments: out.attachments };
}

// ---------- explain: the parts of the first request ----------
const HEADLESS_MARK = HEADLESS_CORE.slice(0, 40);
const BOUND = /^(?:<system-reminder>|[A-Za-z]+ hook additional context:|# Environment\b|# MCP Server Instructions|The following (?:skills|MCP servers|deferred tools|agents)\b)/gm;
/** a text block -> [{ part, name, text }] */
function segments(text, role) {
  const cuts = new Set([0]);
  for (const m of text.matchAll(BOUND)) cuts.add(m.index);
  for (const m of text.matchAll(/<\/system-reminder>\n?/g)) cuts.add(m.index + m[0].length);
  const at = [...cuts].sort((a, b) => a - b), out = [];
  for (let i = 0; i < at.length; i++) {
    const s = text.slice(at[i], at[i + 1] ?? text.length);
    if (s.trim()) out.push(...classify(s, role));
    else if (s && out.length) out[out.length - 1].text += s;
  }
  return out;
}
const first = s => s.trim().split('\n')[0].slice(0, 80);
function skillItems(s, part) {
  const out = [];
  for (const l of s.split('\n')) {
    const m = l.match(/^- ([^\s]+?):\s/);
    if (m) out.push({ part: m[1].includes(':') ? 'plugins' : 'skills', name: m[1], text: l + '\n' });
    else if (out.length) out[out.length - 1].text += l + '\n';
    else out.push({ part, name: 'header', text: l + '\n' });
  }
  return out;
}
function classify(s, role) {
  const t = s.trimStart();
  if (t.startsWith('<system-reminder>')) {
    if (/Codebase and user instructions are shown below/.test(t)) {
      const parts = t.split(/(?=^Contents of .+ \()/m);
      return parts.map((p, i) => {
        const m = p.match(/^Contents of (.+?) \(/);
        return !m ? { part: 'claude_md', name: i ? 'other' : 'header', text: p } : { part: /[\\/]memory[\\/]|MEMORY\.md/i.test(m[1]) ? 'memory' : 'claude_md', name: m[1], text: p };
      });
    }
    if (/The following skills are available/.test(t)) return skillItems(s, 'skills');
    if (/agent types/i.test(t)) return [{ part: 'agents', name: first(t.replace('<system-reminder>', '')), text: s }];
    return [{ part: 'base', name: 'reminder: ' + first(t.replace('<system-reminder>', '')), text: s }];
  }
  if (/^[A-Za-z]+ hook additional context:/.test(t)) return [{ part: 'hooks', name: t.split(':')[0], text: s }];
  if (/^# Environment/.test(t)) return [{ part: 'base', name: 'environment', text: s }];
  if (/^(# MCP Server Instructions|The following MCP servers)/.test(t)) return [{ part: 'mcp', name: first(t), text: s }];
  if (/^The following skills/.test(t)) return skillItems(s, 'skills');
  if (/^The following agents/.test(t)) return [{ part: 'agents', name: 'agents list', text: s }];
  if (/^The following deferred tools/.test(t)) { const n = (t.match(/mcp__/g) || []).length; return [{ part: n > t.split('\n').length / 2 ? 'mcp' : 'base', name: 'deferred tools', text: s }]; }
  return [{ part: role === 'user' ? 'prompt' : 'base', name: role === 'user' ? 'prompt' : first(t), text: s }];
}

/** largest-remainder shares of total by weights (the parts add up to the measured total exactly) */
function shareOut(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map(w => (total * w) / sum), out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k][1]]++;
  return out;
}

/** head -> { method: request | attachments, total, parts [{ key, label, ours, chars, tokens, items [{ name, chars, tokens }] }] } */
export function splitParts(head) {
  if (!head) return null;
  const total = head.usage.context, segs = [];
  let method = 'request';
  if (head.shape && head.messages.length) {
    (head.shape.system || []).forEach((b, i) => {
      const text = String(b.text ?? '');
      if (i === 0) { segs.push({ part: 'base', name: 'system: identity', text }); return; }
      const k = text.indexOf(HEADLESS_MARK);
      const own = head.agent ? 'agent' : 'base', name = head.agent ? `agent ${head.agent}` : 'system prompt';
      if (k < 0) segs.push({ part: own, name, text });
      else { if (k > 0) segs.push({ part: own, name, text: text.slice(0, k) }); segs.push({ part: 'norn', name: 'headless line (--append-system-prompt)', text: text.slice(k) }); }
    });
    for (const t of head.shape.tools || []) {
      const n = String(t.name ?? t.type ?? 'tool');
      segs.push({ part: n.startsWith('mcp__') ? 'mcp' : n === 'Agent' || n === 'Task' ? 'agents' : n === 'Skill' ? 'skills' : 'base', name: n.startsWith('mcp__') || n === 'Agent' || n === 'Task' || n === 'Skill' ? n : `tool ${n}`, text: JSON.stringify(t) });
    }
    for (const m of head.messages) for (const c of Array.isArray(m.content) ? m.content : [{ text: String(m.content ?? '') }]) {
      if (c?.type && c.type !== 'text') { segs.push({ part: 'base', name: c.type, text: JSON.stringify(c) }); continue; }
      segs.push(...segments(String(c.text ?? ''), m.role));
    }
    const tok = shareOut(total, segs.map(s => s.text.length));
    segs.forEach((s, i) => { s.tokens = tok[i]; });
  } else {
    method = 'attachments';
    const est = s => Math.ceil(s.length / 4);
    for (const a of head.attachments) {
      if (a.type === 'skill_listing') segs.push(...skillItems(String(a.content ?? ''), 'skills'));
      else if (a.type === 'hook_additional_context') segs.push({ part: 'hooks', name: 'hook additional context', text: [].concat(a.content ?? []).join('\n') });
      else if (a.type === 'mcp_instructions_delta') segs.push({ part: 'mcp', name: 'MCP instructions', text: [].concat(a.addedBlocks ?? []).join('\n') });
      else if (a.type === 'instructions') for (const f of a.files || []) segs.push({ part: /[\\/]memory[\\/]|MEMORY\.md/i.test(f.path) ? 'memory' : 'claude_md', name: f.path, text: String(f.content ?? '') });
    }
    for (const s of segs) s.tokens = est(s.text);
    const known = segs.reduce((n, s) => n + s.tokens, 0);
    segs.push({ part: 'base', name: 'the rest (harness base, tools, environment)', text: '', tokens: Math.max(0, total - known) });
  }
  const parts = PARTS.map(p => {
    const mine = segs.filter(s => s.part === p.key), items = new Map();
    for (const s of mine) { const it = items.get(s.name) || { name: s.name, chars: 0, tokens: 0 }; it.chars += s.text.length; it.tokens += s.tokens; items.set(s.name, it); }
    return { ...p, chars: mine.reduce((n, s) => n + s.text.length, 0), tokens: mine.reduce((n, s) => n + s.tokens, 0), items: [...items.values()].sort((a, b) => b.tokens - a.tokens) };
  });
  return { method, total, version: head.version ?? null, parts };
}

// ---------- measure: one run ----------
/** worker | merge | checkin (a chat segment is measured apart) */
export function roleOfRun(r) {
  const d = r.data || {};
  if (d.kind === 'checkin') return 'checkin';
  return /merge|door/i.test(String(d.lane || '')) ? 'merge' : 'worker';
}
const KEY = '\u0000standing:';
// META-GUARD R1: the one transcript reader also keeps the run's TRACE - per API message [ts, cache_read, input, cache_create, output]
// and each piece of text appended to the context ([after call #, source, chars]: tool:<key> = a tool result, model = the model's own
// text / thinking / tool inputs, injected = user / hook / mail text) - for the runaway watch and the context-growth split (guard.mjs).
const TEST_RUNNER = /\b(?:pytest|cargo\s+(?:test|nextest)|node\s+(?:[^|;&]*\s)?--test|npm\s+(?:run\s+)?test|npx\s+(?:jest|vitest)|vitest|jest|go\s+test|ctest|dotnet\s+test|meta(?:\.mjs)?\s+smoke)\b/;
/** a tool use -> its producer key: Bash / PowerShell running tests = 'test runner'; mcp__* = 'MCP'; else the tool name */
export function toolKey(name, input) {
  if ((name === 'Bash' || name === 'PowerShell') && TEST_RUNNER.test(String(input?.command ?? ''))) return 'test runner';
  return /^mcp__/.test(name || '') ? 'MCP' : name || 'tool';
}
const clen = c => (typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n, b) => n + (b?.type === 'text' ? String(b.text ?? '').length
  : b?.type === 'image' ? 6000 : JSON.stringify(b ?? '').length), 0) : c ? JSON.stringify(c).length : 0);
// WORK-SIZING S1: the MAIN chain's requests too - reqs = the context of each (usageCtx), uses = [request #, tool, path or command] of
// each tool use - so sizing.mjs finds the first edit and the commits from this one tailed pass (no second read of the transcript)
const traceInit = () => ({ seen: new Set(), e: [], items: [], tools: {}, max: null, reqs: [], uses: [] });
const useArg = (name, i = {}) => (name === 'Bash' || name === 'PowerShell' ? String(i.command ?? '').slice(0, 400) : i.file_path ?? i.notebook_path ?? i.path ?? null);
function onTrace(c, j) {
  const m = j.message, put = (src, n) => { if (n > 0) c.items.push([c.e.length, src, n]); };
  if (j.type === 'assistant' && m) {
    const u = m.usage, k = (m.id || '') + ':' + (j.requestId || '');
    if (u && !c.seen.has(k)) {   // the call first: what it wrote is read from the NEXT call on
      c.seen.add(k);
      c.e.push([Date.parse(j.timestamp), num(u.cache_read_input_tokens), num(u.input_tokens), num(u.cache_creation_input_tokens), num(u.output_tokens)]);
      if (!j.isSidechain) c.reqs.push(usageCtx(u));
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type === 'tool_use' && !j.isSidechain) c.uses.push([c.reqs.length - 1, String(b.name ?? ''), useArg(b.name, b.input ?? {})]);   // the lines of one message are contiguous: its request is the last
      if (b?.type === 'tool_use') { c.tools[b.id] = toolKey(b.name, b.input); put('model', JSON.stringify(b.input ?? {}).length); }
      else if (b?.type === 'text') put('model', String(b.text ?? '').length);
      else if (b?.type === 'thinking') put('model', String(b.thinking ?? '').length);
    }
  } else if (j.type === 'user' && m) {
    if (!Array.isArray(m.content)) { put('injected', clen(m.content)); return; }
    for (const b of m.content) {
      if (b?.type !== 'tool_result') { put('injected', clen([b])); continue; }
      const key = c.tools[b.tool_use_id] ?? 'tool', n = clen(b.content);
      put('tool:' + key, n);
      if (!c.max || n > c.max.chars) c.max = { tool: key, chars: n, at: c.e.length };
    }
  } else if (j.type === 'attachment' && j.attachment?.content) put('injected', clen(j.attachment.content));
}
/** the trace of one transcript (tailed: only appended lines are parsed again) -> { e, items, max } | null */
export function transcriptTrace(file, cache = new Map()) {
  const view = { get: () => cache.get(KEY + file), set: (_f, v) => cache.set(KEY + file, v) };
  const r = tail(file, view, traceInit, onTrace);
  return r ? r.c : null;
}
const entries = (file, cache) => transcriptTrace(file, cache)?.e ?? null;
/** the cache reads + output + turns of a transcript (and its subagents' reads / output) since t0 (ms; NaN = all) */
export function scan(file, t0, cache) {
  const e = entries(file, cache);
  if (!e) return null;
  const mine = e.filter(([t]) => !Number.isFinite(t0) || !Number.isFinite(t) || t >= t0);
  let cr = mine.reduce((n, x) => n + x[1], 0), out = mine.reduce((n, x) => n + x[4], 0);
  const dir = path.join(file.replace(/\.jsonl$/, ''), 'subagents');
  let names = []; try { names = fs.readdirSync(dir).filter(n => /^agent-.+\.jsonl$/.test(n)); } catch { /* none */ }
  for (const n of names) for (const [t, x, , , o] of entries(path.join(dir, n), cache) || []) if (!Number.isFinite(t0) || t >= t0) { cr += x; out += o; }
  return { cache_read: cr, output: out, turns: mine.length };
}
/** the Claude transcript of a run (its end / start record, else found by its session id) or null */
export function runTranscript(r, o = {}) {
  const d = r.data || {}, end = r.end || {};
  return end.transcript || d.transcript || findTranscript(o.projectsDir, d.session_id) || null;
}
function codexMeasure(file, cache) {
  const view = { get: () => cache.get(KEY + file), set: (_f, v) => cache.set(KEY + file, v) };
  const r = tail(file, view, () => ({ first: null, total: null, last: -1, turns: 0 }), (c, j) => {
    const info = j.type === 'event_msg' && j.payload?.type === 'token_count' ? j.payload.info : null;
    if (!info) return;
    const tt = num(info.total_token_usage?.total_tokens);
    if (c.first === null && info.last_token_usage) c.first = num(info.last_token_usage.input_tokens);
    if (tt > c.last) { c.turns++; c.last = tt; }
    c.total = info.total_token_usage ?? c.total;
  });
  return r ? { turn1: r.c.first, cache_read: r.c.total ? num(r.c.total.cached_input_tokens) : null, turns: r.c.turns } : null;
}

/** family of a run's executor: claude | codex | <provider name> | null (fake, grok, cli helpers: not measured) */
export function familyOf(d, p) {
  const ex = d.executor || 'claude', entry = p?.executors?.[ex];
  const h = harnessOf(ex, entry) ?? null;
  if (h === 'claude') return ex === 'claude' ? 'claude' : ex;
  if (h === 'codex') return 'codex';
  return null;
}

/**
 * One run (a records fold item) -> { id, role, family, executor, agent, day, created, live, turn1, create1, cache_read, turns, src, split }
 * o: { projectsDir, codexDir, cache (tail Map), memo (ended runs), project }
 */
export function measureRun(r, o = {}) {
  const live = r.state === 'running', mk = r.id + '@' + r.updated;
  if (!live && o.memo?.has(mk)) return o.memo.get(mk);
  const d = r.data || {}, end = r.end || {}, cache = o.cache || new Map(), family = familyOf(d, o.project) ?? 'claude';
  const base = { id: r.id, role: roleOfRun(r), family, executor: d.executor || 'claude', agent: d.agent ?? null, day: String(r.created).slice(0, 10), created: r.created, live,
    turn1: null, create1: null, cache_read: null, turns: null, src: null, split: null };
  let v = base;
  if (family === 'codex') {
    let sid = end.codex_session ?? d.session_id;
    if (!sid && d.log) { try { sid = parseCodexLog(fs.readFileSync(d.log, 'utf8')).session_id; } catch { /* no log */ } }
    const f = sid ? findRollout(o.codexDir, sid) : null, c = f ? codexMeasure(f, cache) : null;
    if (c) v = { ...base, turn1: c.turn1, cache_read: c.cache_read, turns: c.turns, src: 'rollout' };
  } else {
    const file = runTranscript(r, o);
    const t0 = Date.parse(r.created) - 5000, head = file ? transcriptHead(file, { since: Number.isFinite(t0) ? new Date(t0).toISOString() : null }) : null;
    const fin = !live && end.usage && 'cache_read_input_tokens' in end.usage;
    const s = fin ? null : file ? scan(file, t0, cache) : null;
    const turns = fin ? (readJson(d.final)?.num_turns ?? null) : s?.turns ?? null;
    v = { ...base, turn1: head?.usage.context ?? null, create1: head?.usage.cache_create ?? null, cache_read: fin ? num(end.usage.cache_read_input_tokens) : s?.cache_read ?? null,
      turns, src: fin ? 'end' : s ? 'transcript' : null, split: splitParts(head) };
  }
  if (!live && o.memo) o.memo.set(mk, v);
  return v;
}

/** every measured session of project p in the last `days` days: the runs (claude + codex + providers) and the chat's segments */
export function standingRuns(state, p, o = {}) {
  const now = o.now ?? Date.now(), since = now - (o.days ?? 7) * DAY, out = [];
  let items = {};
  try { items = loadState(state).items; } catch { items = {}; }
  for (const it of Object.values(items)) {
    if (it.kind !== 'run' || it.history?.[0]?.ev !== 'start') continue;
    const t = Date.parse(it.created);
    if (!(t >= since && t <= now) || !familyOf(it.data || {}, p)) continue;
    out.push(measureRun(it, { ...o, project: p }));
  }
  for (const l of fs.existsSync(threadFile(state)) ? fs.readFileSync(threadFile(state), 'utf8').split('\n') : []) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j?.kind !== 'segment' || !j.session_id) continue;
    const t = Date.parse(j.ts);
    if (!(t >= since && t <= now)) continue;
    const m = measureRun({ id: `chat#${j.n ?? '?'}`, state: 'running', created: j.ts, updated: j.ts, data: { kind: 'chat', executor: j.executor || 'claude', session_id: j.session_id } }, { ...o, project: p });
    out.push({ ...m, role: 'chat' });
  }
  return out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

const median = xs => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const keyOf = r => r.role + (r.family !== 'claude' ? ` (${r.family})` : '');
const ROLE_ORDER = ['worker', 'merge', 'checkin', 'chat'];
/** measured runs -> { method, roles [{ key, role, family, runs, measured, median_turn1, median_create1, median_turns, max_turn1, cache_read }], days [{ day, key, role, runs, median_turn1, cache_read }], parts { key: split + run } } */
export function standingSummary(runs) {
  const groups = new Map(), days = new Map(), parts = {};
  for (const r of runs) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
    const dk = `${r.day}\u0000${k}`;
    if (!days.has(dk)) days.set(dk, { day: r.day, key: k, role: r.role, family: r.family, rs: [] });
    days.get(dk).rs.push(r);
    if (r.split && (!parts[k] || (r.split.method === 'request') >= (parts[k].method === 'request'))) parts[k] = { run: r.id, created: r.created, ...r.split };
  }
  const sum = rs => rs.reduce((n, r) => n + (r.cache_read || 0), 0);
  const rank = k => { const i = ROLE_ORDER.indexOf(k.split(' ')[0]); return (i < 0 ? 9 : i) * 10 + (k.includes('(') ? 1 : 0); };
  const roles = [...groups].map(([key, rs]) => ({ key, role: rs[0].role, family: rs[0].family, runs: rs.length, measured: rs.filter(r => r.turn1 !== null).length,
    median_turn1: median(rs.map(r => r.turn1 ?? NaN)), median_create1: median(rs.map(r => r.create1 ?? NaN)), median_turns: median(rs.map(r => r.turns ?? NaN)),
    max_turn1: Math.max(0, ...rs.map(r => r.turn1 || 0)), cache_read: sum(rs) })).sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
  const dayRows = [...days.values()].map(({ rs, ...d }) => ({ ...d, runs: rs.length, median_turn1: median(rs.map(r => r.turn1 ?? NaN)), cache_read: sum(rs) }))
    .sort((a, b) => b.day.localeCompare(a.day) || rank(a.key) - rank(b.key));
  return { method: STANDING_METHOD, roles, days: dayRows, parts };
}


/**
 * What a profile drops that a role's files name: [{ what: skill | mcp | tool, name, file, why }] (the doctor's rows).
 * o: { role, files [paths: agent files, briefs], skills [names available], userSkills? [user-setup skills it drops: none known - the
 * calibration shows ~/.claude/skills load without the user settings; plugin skills (name:skill) go with them] }
 */
export function profileDrops(profile, { role, files = [], skills = [], userSkills = [] } = {}) {
  const out = [], texts = files.map(f => [f, (() => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } })()]);
  const names = s => new RegExp(`(?<![\\w:-])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  const lost = new Set([...(profile.skills === false ? skills : []), ...(profile.user_setup === false ? [...skills.filter(s => s.includes(':')), ...userSkills] : [])]);
  for (const t of [...(profile.disallowed_tools || [])]) for (const [f, x] of texts) if (names(t).test(x)) out.push({ what: 'tool', name: t, file: f, why: `${profile.name} drops the ${t} tool; ${path.basename(f)} names it - role ${role}` });
  for (const s of lost) for (const [f, t] of texts) if (names(s).test(t)) out.push({ what: 'skill', name: s, file: f, why: `${profile.name} drops the skill ${s} (${profile.skills === false ? 'skills: false' : 'user_setup: false'}); ${path.basename(f)} names it - role ${role}` });
  if (profile.mcp === 'norn' || profile.mcp === 'none')
    for (const [f, t] of texts) for (const m of new Set([...t.matchAll(/mcp__([\w.-]+)/g)].map(x => x[1].split('__')[0]))) if (!(profile.mcp === 'norn' && m === 'norn'))
      out.push({ what: 'mcp', name: m, file: f, why: `${profile.name} keeps ${profile.mcp === 'norn' ? "only Norn's" : 'no'} MCP server; ${path.basename(f)} names mcp__${m} - role ${role}` });
  return out;
}

const mdIn = d => { try { return fs.readdirSync(d).filter(n => /\.md$/i.test(n)).map(n => path.join(d, n)); } catch { return []; } };
const skillsIn = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(d, e.name, 'SKILL.md'))).map(e => e.name); } catch { return []; } };
/**
 * norn doctor: one line per thing a non-full launch profile of project p drops that a role's files name (its agent files, the rules
 * read whole, the newest briefs). o: { home, claudeDir } -> [text]
 */
export function profileDoctorLines(p, { home = '', claudeDir = null } = {}) {
  const out = [], cfg = claudeDir || path.join(home, '.claude');
  const userSkills = skillsIn(path.join(cfg, 'skills'));
  const skills = [...new Set([...skillsIn(p.install?.skills || ''), ...(p.root ? skillsIn(path.join(p.root, '.claude', 'skills')) : []), ...userSkills])];
  const briefs = p.briefs_dir ? mdIn(p.briefs_dir).map(f => [f, fs.statSync(f).mtimeMs]).sort((a, b) => b[1] - a[1]).slice(0, 30).map(x => x[0]) : [];
  const agents = [...mdIn(p.install?.agents || ''), ...(p.root ? mdIn(path.join(p.root, '.claude', 'agents')) : [])];
  for (const role of PROFILE_ROLES) {
    const pr = profileOf(p.policy, role);
    if (pr.name === 'full') continue;
    const files = [...(role === 'checkin' ? [p.checkin_extra, ...(p.rules_read_whole || [])].filter(Boolean) : role === 'chat' ? [] : [...agents, ...briefs])];
    const seen = new Set();
    for (const d of profileDrops(pr, { role, files, skills })) { const k = `${d.what}:${d.name}`; if (seen.has(k)) continue; seen.add(k); out.push(`${p.name}: ${d.why}`); }
  }
  return out;
}
