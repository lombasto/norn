// META-CONTROLLER C1 (SPEC sec. 1 "The shape"): the owner's controller chat. The conversation is Norn's, the process is disposable.
// One thread per project, append-only: <state>/chat/thread.jsonl, one line per normalised event, each { ts, seg, kind, ... }:
//   segment { n, session_id, executor, model, effort, why: first | vendor | executor }   a vendor session begins (n counts them)
//   owner { text }                                   the owner's message
//   start { resume, pid, model, effort } / stop { why: idle | shutdown | exit | spawn | settings | handoff, code, err? }   the process came / went
//   handoff { phase: turn, n, ctx } | { phase: done, n, from_seg, ctx, forced, file, carried { threads, holds, cards } }   C5: the hand-off
//   session { session_id, model, permission_mode, mcp }   the vendor's init, once per process (it repeats it every turn: C0 finding 2)
//   text / tool / result / usage / turn              the adapter's chatEvents (harness/claude.mjs)
//   approval / verdict / done / show / undone        C3: the MCP chat profile's outbox (chatact.mjs), drained here; a tap; an undo
//   pick { model, effort }   META-CHAT-CONTROLS R1: the chat's own model / effort (null = the Settings row), from the picker or /model, /effort
//   norn { text, cmd }       R1: Norn's own answer to a slash command (no model turn); the owner line of a typed command carries cmd
// Lazy start: the process starts on a message. Idle stop: idleMs after the last turn its stdin is closed (exit 0; a hard kill exits
// 1 - C0 finding 3), a kill only if it has not gone after graceMs. The next message resumes the segment's session by id (C0 fact 1).
// Harness-agnostic: the executor's adapter supplies chatCommand + chatEvents (caps.chat); nothing here knows a CLI's flags.
import fs from 'node:fs';
import path from 'node:path';
import { readText, forget, addMarker, markOf } from './fsnap.mjs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adapterFor, capsOf, harnessOf } from './harness/index.mjs';
import { drain as drainOutbox, decide as decideApproval, approvalsDir, readVerdict, readRequest, chatDir, threadFile } from './chatact.mjs';
import { readEvents, recordsFile, fold, loadState, heldLanes, holdWho, hhmm, roleAddr } from './records.mjs';
import { POLICY_DEFAULTS } from './policy.mjs';
import { HANDOFF_PROMPT, ctxLevel, kTok } from './ctxlimit.mjs';
import { tryDigest } from './digest.mjs';
import { renderDigest } from './views.mjs';
import { checkMail } from './mail.mjs';
import { profileOf } from './launchpolicy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT_PROMPT = path.join(HERE, '..', 'prompts', 'CHAT.md');
const META_CLI = path.join(HERE, '..', 'bin', 'norn.mjs');
export const IDLE_MS = 15 * 60000;   // SPEC: stopped after 15 idle minutes (C5: the default of Settings chat_idle_min, read live)
const RESULT_MAX = 4000;             // a tool result is shown, not archived: the thread keeps its first 4000 characters

// META-DASH-ASYNC R1 (option a): a thread line is appended on fs.promises through one in-process queue per thread file (the order and
// the line numbers stay those of append()). The queue is the list of the appended lines in order (q.done = the last one on disk); a
// reader merges, by line number, every line after its mark: q.done at its own read, or - the text read into a request snapshot -
// q.done when that read began (the fsnap marker), so a line that lands after a GET read the thread is still in its readThread. The list
// behind the oldest mark still held is unreachable (garbage): no timing-based pruning.
const queued = new Map();   // resolved thread file -> { done: the last line node on disk, tail: the last node, chain: the last write }
function queueOf(f) {
  const k = path.resolve(f); let q = queued.get(k);
  if (!q) { const s0 = { i: -1, next: null }; queued.set(k, q = { done: s0, tail: s0, chain: Promise.resolve() }); }
  return q;
}
addMarker(k => (path.basename(k) === 'thread.jsonl' && path.basename(path.dirname(k)) === 'chat' ? queueOf(k).done : undefined));
/** resolves when every queued line of the thread is on disk (a POST that appended answers after it; close() waits for it) */
export const threadFlushed = state => queueOf(threadFile(state)).chain;
function enqueue(state, i, row) {
  const f = threadFile(state), q = queueOf(f), n = { i, row, next: null, failed: false };
  q.tail = q.tail.next = n;
  const w = q.chain.then(async () => { await fs.promises.mkdir(chatDir(state), { recursive: true }); await fs.promises.appendFile(f, row + '\n', 'utf8'); })
    .catch(e => { n.failed = true; throw e; })
    .finally(() => { forget(f); q.done = n; });
  q.chain = w.catch(() => {});   // a failed write is its caller's (append's promise); the queue goes on
  return w;
}

/** The thread lines from line `from` on: { count, items }. A torn last line (a write in flight) is skipped. */
export function readThread(state, from = 0) {
  const f = threadFile(state), mark = markOf(f) ?? queueOf(f).done;   // taken before the read (a snapshot's: before its read began)
  const raw = readText(f) ?? '';   // META-DASH-ASYNC R1: snapshot-aware (lib/fsnap.mjs)
  const rows = raw.split('\n').filter(Boolean), items = [];
  for (let n = mark.next; n; n = n.next) if (!n.failed && n.i >= rows.length) rows.push(n.row);   // landed after the read began, or queued
  for (const r of rows.slice(Math.max(0, from))) { try { items.push(JSON.parse(r)); } catch { /* torn */ } }
  return { count: rows.length, items };
}

/** The current segment of a thread and whether its vendor session exists yet (it said init, or the vendor made it). */
export function threadState(lines) {
  let seg = null, begun = false;
  for (const l of lines) {
    if (l.kind === 'segment') { seg = { n: l.n, session_id: l.session_id, executor: l.executor, model: l.model, effort: l.effort, ...(l.handoff ? { handoff: l.handoff } : {}) }; begun = l.why === 'vendor'; }
    else if (l.kind === 'session' && seg) begun = true;
  }
  return { seg, begun };
}

/** R1: the chat's picked model / effort (the last pick line; a null field = the Settings row) - null when nothing is picked. */
export function chatPick(lines) {
  let p = null;
  for (const l of lines) if (l.kind === 'pick') p = l.model || l.effort ? { model: l.model ?? null, effort: l.effort ?? null } : null;
  return p;
}
/** R1: the commands the vendor session listed at its last init (claude: system/init slash_commands) - null before any. */
export function chatCommands(lines) {
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].kind === 'session' && Array.isArray(lines[i].commands)) return lines[i].commands;
  return null;
}
/**
 * R1 (owner DIR-58): Norn's own chat commands - answered by Norn, never sent to the model. Any other "/name" passes through to the
 * CLI only when the session lists it (stream-json input dispatches a listed command: code.claude.com/docs agent-sdk slash-commands,
 * read 2026-11-14; proven by a real call, see the R1 NOTES); an unlisted one is refused in plain words, never sent as text.
 */
export const NORN_COMMANDS = { model: 'the chat model from the next turn (/model alone shows it; /model default = the Settings row)',
  effort: 'the chat effort from the next turn (/effort default = the Settings row)', clear: 'a fresh session: a new segment (the records stay)',
  compact: 'a hand-off now: the controller writes its hand-off, a fresh session carries it over', cost: "the chat's usage today (Norn's count)",
  usage: 'the same as /cost', help: 'this list' };
const CMD = /^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/;

/** The chat role pack: CHAT.md (project filled in) + the project's own roles/controller.md when it has one. */
export function rolePack(p) {
  const base = fs.readFileSync(CHAT_PROMPT, 'utf8').replaceAll('{{project}}', p.name);
  const own = p.install?.roles ? path.join(p.install.roles, 'controller.md') : null;
  return own && fs.existsSync(own) ? `${base}\n## Project rules (roles/controller.md)\n${fs.readFileSync(own, 'utf8')}` : base;
}

// the variables of a supervised run / check-in / the CLI session that started the dashboard: the chat is a top-level owner session
// (the MCP controller profile refuses a worker or check-in environment - mcp.mjs refusal; C0 started it the same way)
const RUN_ENV = /^(META_(RUN_ID|ROLE|NOTES|JOB|SESSION_ID|RESUMES|RUN_STATE)|CLAUDECODE|CLAUDE_CODE_.*)$/;
export const chatEnv = env => Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && !RUN_ENV.test(k)));

/** The Norn MCP server of the chat: the chat profile of this project (controller tools + norn_show / norn_cli / norn_approve, by tier),
 * `via chat:chat` on every record it writes. */
export function chatMcp(p) {
  return { name: 'norn', command: process.execPath, args: [META_CLI, 'mcp', ...(p.file ? ['--project', p.file] : ['--state', p.state]), '--profile', 'chat', '--client', 'chat'] };
}

// ---------- META-CONTROLLER C4 (SPEC sec. 2 items 6 + 7): news for the model, mail to the chat, one chat per project ----------
const cursorFile = state => path.join(chatDir(state), 'news-cursor.json');
const NEWS_MAX = 25;
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) + ' ...' : String(s));
const RUN_VERB = { start: 'started', queue: 'queued', kill: 'killed', withdraw: 'withdrew', rewire: 'rewired', landed: 'marked landed', review: 'reviewed' };
function recordLine(e) {
  const d = e.data || {};
  const sum = e.kind === 'decision' && e.ev === 'create' ? `lane ${d.lane}: ${d.question} -> ${d.choice}`
    : e.kind === 'question' && e.ev === 'create' ? `lane ${d.lane}: ${d.title}`
    : [d.refs?.length ? `refs ${d.refs.join(',')}` : '', d.by ? `by ${d.by}` : '', d.why ?? ''].filter(Boolean).join('; ');
  return `- ${e.id} ${e.ev === 'create' ? e.kind : `${e.kind} ${e.ev}`} by check-in${e.run ? ' ' + e.run : ''}${sum ? ': ' + clip(sum, 240) : ''}`;
}
/**
 * What the check-ins did since the cursor { seq, runs_seq } (records they wrote; runs they started / stopped) -> { lines, cursor }.
 * No cursor yet = the chat's first turn: nothing is news (norn_boot carries the state), the cursor starts here.
 */
export function newsSince(state, cursor) {
  const recs = readEvents(recordsFile(state, 'question')), runs = readEvents(recordsFile(state, 'run'));
  const now = { seq: recs.reduce((m, e) => Math.max(m, e.seq), 0), runs_seq: runs.reduce((m, e) => Math.max(m, e.seq), 0) };
  if (!cursor) return { lines: [], cursor: now };
  const ck = new Set(Object.values(fold(runs).items).filter(r => r.data.kind === 'checkin').map(r => r.id));
  const lines = [];
  for (const e of recs) if (e.seq > cursor.seq && (e.by === 'checkin' || (ck.has(e.run) && !['owner', 'dashboard'].includes(e.by)))) lines.push(recordLine(e));
  for (const e of runs) {
    if (e.seq <= cursor.runs_seq || !ck.has(e.run) || !RUN_VERB[e.ev] || ((e.ev === 'start' || e.ev === 'queue') && e.data?.kind === 'checkin')) continue;
    lines.push(`- check-in ${e.run} ${RUN_VERB[e.ev]} ${e.id}${e.data?.lane ? ' lane ' + e.data.lane : ''}${e.data?.executor ? ' ' + e.data.executor : ''}${e.data?.why ? ': ' + clip(e.data.why, 200) : ''}`);
  }
  return { lines, cursor: now };
}
/** The NEWS block in front of the owner's next message ('' = nothing new): check-in acts since the last turn + mail to role:controller (delivered here, once). */
export function newsBlock(state) {
  let cur = null;
  try { cur = JSON.parse(fs.readFileSync(cursorFile(state), 'utf8')); } catch { /* the first turn */ }
  const { lines, cursor } = newsSince(state, cur);
  const shown = lines.length > NEWS_MAX ? [...lines.slice(0, NEWS_MAX), `- (${lines.length - NEWS_MAX} more: norn_records / norn_inbox)`] : lines;
  const mail = checkMail(state, { by: 'controller', to: roleAddr('controller', state), via: 'chat' })
    .map(m => `- ${m.id} from ${m.data.from}${m.data.urgent ? ' URGENT' : ''}: ${m.data.subject}\n  ${clip(String(m.text).trim(), 1200).replace(/\n/g, '\n  ')}`);
  fs.mkdirSync(chatDir(state), { recursive: true });
  fs.writeFileSync(cursorFile(state), JSON.stringify(cursor));
  if (!shown.length && !mail.length) return '';
  return ["NEWS since your last turn (from Norn's records - what the check-ins did, mail to role:controller; evidence, not the owner's words):",
    ...shown, ...(mail.length ? ['Mail to role:controller (delivered to you; ack with norn_cli mail ... when done):', ...mail] : [])].join('\n');
}

// one chat per project (SPEC sec. 2 item 7): <state>/chat/chat.lock names the dashboard process serving the thread
const leaseFile = state => path.join(chatDir(state), 'chat.lock');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const leaseKey = state => path.resolve(state).toLowerCase();
const leased = new Set();   // the states this process serves a chat for
function takeLease(p) {
  const f = leaseFile(p.state), key = leaseKey(p.state);
  fs.mkdirSync(chatDir(p.state), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(f, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: 'wx' }); leased.add(key); return; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* being written: retry */ }
    if (cur && (cur.pid === process.pid ? leased.has(key) : alive(cur.pid))) {
      throw Object.assign(new Error(`another Norn chat serves project ${p.name} (pid ${cur.pid}): one chat per project - talk there, or stop that dashboard`), { status: 409 });
    }
    if (cur) { try { fs.unlinkSync(f); } catch { /* someone else took it over */ } }
  }
  throw Object.assign(new Error(`the chat lease of project ${p.name} is contended (${f})`), { status: 409 });
}
function dropLease(p) {
  leased.delete(leaseKey(p.state));
  try { if (JSON.parse(fs.readFileSync(leaseFile(p.state), 'utf8')).pid === process.pid) fs.unlinkSync(leaseFile(p.state)); } catch { /* gone */ }
}

const NOTE_KINDS = new Set(['approval', 'verdict', 'done', 'show']);
const killTree = child => {
  if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else child.kill('SIGKILL');
};

// ---------- META-CONTROLLER C5 (SPEC sec. 4): the hand-off, so the conversation never dies of a full context ----------
export const CONTEXT_DEFAULT = { ...POLICY_DEFAULTS.context.controller };   // 90 / 110 / 150k: no new step / hand-off / hard max
const SETTLE_MS = 15000;   // quiet time after a turn's result before a still-owed message count is dropped (it was folded into that turn)
const HANDOFF_MS = 10 * 60000;   // a hand-off turn that has not ended by then is cut: the forced hand-off takes over
const TURNS_CARRIED = 10, TURN_CLIP = 2000;
// the fixed hand-off turn ({ctx} / {limit} filled in): ONE copy with the run orders (ctxlimit.mjs, META-CTX-ENFORCE R1)
export { HANDOFF_PROMPT };
/** the "- x" lines under "## Open threads" ("- none" is none) */
export function openThreads(md) {
  const out = [];
  let on = false;
  for (const l of String(md ?? '').split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(l)) { on = /^#{1,6}\s+open threads\s*$/i.test(l); continue; }
    if (on && /^\s*[-*]\s+\S/.test(l) && !/^\s*[-*]\s+none\.?\s*$/i.test(l)) out.push(l.replace(/^\s*[-*]\s+/, '').trim());
  }
  return out;
}
/** the context of segment n: its last usage line (null = none yet) */
function lastCtx(items, n) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'usage' && items[i].seg === n && Number.isFinite(items[i].ctx)) return items[i].ctx;
  return null;
}
/** the last ~10 turns of the thread verbatim: the owner's lines and the controller's text from the 10th-last owner line on */
function lastTurns(items) {
  const owners = items.map((l, i) => (l.kind === 'owner' ? i : -1)).filter(i => i >= 0), from = owners.length > TURNS_CARRIED ? owners.at(-TURNS_CARRIED) : 0;
  const cl = t => (String(t).length > TURN_CLIP ? String(t).slice(0, TURN_CLIP) + ' ...' : String(t));
  return items.slice(from).filter(l => l.kind === 'owner' || l.kind === 'text').map(l => (l.kind === 'owner' ? `**owner** (${l.ts}): ${cl(l.text)}` : `**controller**: ${cl(l.text)}`));
}
/** the approval cards still waiting for the owner's tap: [{ id, title }] */
function waitingCards(state) {
  let names = [];
  try { names = fs.readdirSync(approvalsDir(state)).filter(n => /^AP-[0-9a-f]{8}\.json$/.test(n)).sort(); } catch { return []; }
  return names.map(n => n.slice(0, -5)).filter(id => !readVerdict(state, id)).map(id => ({ id, title: readRequest(state, id)?.title ?? '' }));
}
/**
 * The chat's cost (SPEC sec. 4 "a cost line in the pane"): the turns of one day (`day` = a UTC YYYY-MM-DD, or `since` = ms) ->
 * { turns, tokens, usd, weekly_pct, estimate }. Tokens = each turn's own usage (the result line sums its model calls; the assistant
 * lines repeat a call's usage per content block, so usage lines are never summed). usd = the CLI's per-PROCESS running total taken as
 * deltas (reset at each start; C2 finding: summing it would count a process's turns again and again) - API-equivalent, not money on a
 * plan. weekly_pct = cache-read tokens / the calibration's cacheR_per_pct: an ESTIMATE (null without a calibration).
 */
export function chatCost(lines, { day = null, since = null, perPct = null } = {}) {
  const today = day ?? (since === null ? new Date().toISOString().slice(0, 10) : null);
  let prev = 0, turns = 0, tokens = 0, usd = 0, read = 0;
  for (const l of lines) {
    if (l.kind === 'start') { prev = 0; continue; }
    if (l.kind !== 'turn') continue;
    const c = Number.isFinite(l.cost_usd) ? l.cost_usd : null, d = c === null ? 0 : c >= prev ? c - prev : c;
    if (c !== null) prev = c;
    if (today !== null ? String(l.ts ?? '').slice(0, 10) !== today : !(Date.parse(l.ts ?? '') >= since)) continue;
    turns++; usd += d;
    const u = l.usage;
    if (u) { tokens += (u.input || 0) + (u.cache_read || 0) + (u.cache_write || 0) + (u.output || 0); read += u.cache_read || 0; }
  }
  return { turns, tokens, usd: Math.round(usd * 1e6) / 1e6, weekly_pct: perPct ? read / perPct : null, estimate: true };
}

/**
 * o: { project (loadProject object: name, state, root, file?, install?), config? () -> { executor, exe?, model, effort, idleMs?, rawShell?,
 * context? { no_new_step_k, handoff_k, hard_max_k } } (C5: read LIVE - at each message, start and turn end; else the fixed fields below),
 * executor, exe?, model, effort, idleMs?, rawShell?, context?, graceMs?, spawnFn?, env?, outboxMs?, handoffMs? }
 * -> { send(text), status(), subscribe(fn) -> off, stop(why), close(), drain(), decide(id, verdict), note(kind, data) }. subscribe(fn): fn(line, index) for every line appended.
 */
export function createChat(o) {
  const p = o.project, spawnFn = o.spawnFn ?? spawn, graceMs = o.graceMs ?? 30000;
  let picked;   // R1: the chat's pick (chatPick of the thread), read once, then kept by pick()
  function cfgOf() {
    const c = o.config ? o.config() : {};
    const b = { executor: c.executor ?? o.executor, exe: c.exe ?? o.exe, model: c.model ?? o.model, effort: c.effort ?? o.effort, idleMs: c.idleMs ?? o.idleMs ?? IDLE_MS,
      rawShell: c.rawShell ?? o.rawShell ?? 'off', context: { ...CONTEXT_DEFAULT, ...(o.context || {}), ...(c.context || {}) },
      choices: c.choices ?? o.choices ?? null, perPct: c.perPct ?? o.perPct ?? null };
    if (picked === undefined) picked = chatPick(readThread(p.state).items);
    return { ...b, model: picked?.model ?? b.model, effort: picked?.effort ?? b.effort, defaults: { model: b.model, effort: b.effort } };
  }
  const chatCapable = cfg => {
    const fam = harnessOf(cfg.executor);
    if (!fam || capsOf(cfg.executor).chat === 'none') throw new Error(`executor ${cfg.executor} has no chat (caps.chat none)`);
    return adapterFor(fam);
  };
  chatCapable(cfgOf());
  takeLease(p);
  const subs = new Set();
  let proc = null, seg = null, count = null, outbox = null, segCtx = null, rolling = null, closing = false, rollAfter = false;
  const outq = [];   // owner messages that wait in Norn while the process rolls over (a hand-off, a Settings restart)
  const live = me => { try { return cfgOf(); } catch { return me?.cfg ?? null; } };   // a Settings file being written: the last good one

  function append(kind, data = {}) {
    if (count === null) count = readThread(p.state).count;
    const line = { ts: new Date().toISOString(), seg: seg?.n ?? null, kind, ...data };
    const i = count++;
    enqueue(p.state, i, JSON.stringify(line)).catch(e => process.emitWarning(`chat thread write failed: ${e.message}`));
    for (const fn of subs) { try { fn(line, i); } catch { /* a subscriber's fault is its own */ } }
    return line;
  }
  function newSegment(session_id, why, cfg, extra = {}) {
    seg = { n: (seg?.n ?? 0) + 1, session_id, executor: cfg.executor, model: cfg.model, effort: cfg.effort, ...extra };
    segCtx = null;
    append('segment', { ...seg, why });
  }

  // the segment the next process serves: the thread's current one (resumed once its session began), else a new one
  function prepare(cfg) {
    const items = readThread(p.state).items, t = threadState(items);
    seg = t.seg;
    if (seg && seg.executor === cfg.executor) { segCtx = lastCtx(items, seg.n); return t.begun; }
    newSegment(randomUUID(), seg ? 'executor' : 'first', cfg);
    return false;
  }
  function start(resume, cfg) {   // spawns; the caller appends the start line (after the owner line it serves)
    const adapter = chatCapable(cfg);
    const cmd = adapter.chatCommand({ exe: cfg.exe, model: cfg.model, effort: cfg.effort, session_id: seg.session_id, resume, mcp: chatMcp(p),
      system: rolePack(p), cwd: chatDir(p.state), addDirs: p.root ? [p.root] : [], rawShell: cfg.rawShell, profile: profileOf(p.policy, 'chat') });
    fs.mkdirSync(cmd.cwd, { recursive: true });
    const child = spawnFn(cmd.exe, cmd.args, { cwd: cmd.cwd, env: { ...chatEnv(o.env ?? process.env), ...(cmd.env || {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const me = { child, adapter, cfg, pending: 0, inited: false, why: null, idle: null, kill: null, settle: null, since: null, doing: null, buf: '', err: '', done: false, handoff: null };
    proc = me;
    clearInterval(outbox); outbox = setInterval(drain, o.outboxMs ?? 500); outbox.unref?.();
    child.stdout.on('data', b => {
      clearTimeout(me.settle);   // any output (thinking and progress lines too): the CLI is still working on a message
      me.buf += b.toString('utf8');
      let i;
      while ((i = me.buf.indexOf('\n')) >= 0) { const row = me.buf.slice(0, i); me.buf = me.buf.slice(i + 1); if (row.trim()) line(me, row); }
    });
    child.stderr.on('data', b => { me.err = (me.err + b.toString('utf8')).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', e => finish(me, 'spawn', null, e.message));
    child.on('close', code => finish(me, me.why ?? 'exit', code, code ? me.err.trim().slice(-500) : ''));
    return me;
  }
  function line(me, row) {
    for (const ev of me.adapter.chatEvents(row)) {
      if (ev.kind === 'session') {
        if (ev.session_id && ev.session_id !== seg.session_id) { newSegment(ev.session_id, 'vendor', me.cfg); me.inited = true; continue; }
        if (me.inited) continue;   // the init every turn repeats: same process, same session
        me.inited = true;
        append('session', { session_id: ev.session_id, model: ev.model, permission_mode: ev.permission_mode, mcp: ev.mcp, ...(ev.commands ? { commands: ev.commands } : {}) });
        continue;
      }
      const { kind, ...data } = ev;
      if (kind === 'usage' && Number.isFinite(data.ctx)) segCtx = data.ctx;
      if (kind === 'text' && me.handoff) { me.handoff.text.push(data.text); continue; }   // the hand-off goes to its file, not the thread
      if (kind === 'result' && data.text.length > RESULT_MAX) data.text = data.text.slice(0, RESULT_MAX) + ` ... [${data.text.length - RESULT_MAX} more characters]`;
      append(kind, data);
      if (kind === 'tool') me.doing = `running ${String(data.name).replace(/^mcp__norn__/, '')}`;
      else if (kind === 'text') me.doing = 'writing';
      if (kind === 'turn') {
        me.pending = Math.max(0, me.pending - 1);
        if (!me.pending) me.since = null;
        if (me.handoff && !me.handoff.file) handoffTurnDone(me, data);
        // a message written while a turn ran is often folded INTO that turn (one result for two sends): a count still owed after the
        // CLI has gone quiet for SETTLE_MS is no turn at all - without this the next Settings roll (rollAfter) waited for it forever
        else if (me.pending) { clearTimeout(me.settle); me.settle = setTimeout(() => { if (proc === me && !me.done && me.pending) { me.pending = 0; me.since = null; turnEnded(me); } }, o.settleMs ?? SETTLE_MS); me.settle.unref?.(); }
        else turnEnded(me);
      }
    }
  }
  function turnEnded(me) {   // no turn running, none owed: a pick / Settings change waiting applies now, else the context check, else the idle clock
    me.doing = null;
    if (rollAfter && !me.handoff) { rollAfter = false; rolling = 'settings'; stop('settings'); }   // R1: a pick made mid-turn applies from the next turn
    else if (!me.handoff && !checkContext(me)) arm(me);
  }
  // between turns: at handoff_k the hand-off turn, at hard_max_k the forced hand-off (SPEC sec. 4)
  function checkContext(me) {
    const c = (live(me) ?? me.cfg).context;
    if (closing || !['handoff', 'hard_max'].includes(ctxLevel(segCtx, c))) return false;
    beginHandoff(me, segCtx, c);
    return true;
  }
  function beginHandoff(me, ctx, c) {
    const n = readThread(p.state).items.filter(l => l.kind === 'handoff' && l.phase === 'done').length + 1;
    me.handoff = { n, ctx, from_seg: seg.n, forced: false, text: [], file: null };
    rolling = 'handoff';
    clearTimeout(me.idle);
    if (ctxLevel(ctx, c) === 'hard_max') { writeHandoff(me, null, `the context (${kTok(ctx)}) is past the hard max (${c.hard_max_k}k)`); stop('handoff'); return; }
    append('handoff', { phase: 'turn', n, ctx });
    me.pending++;
    me.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text',
      text: HANDOFF_PROMPT.replace('{ctx}', kTok(ctx)).replace('{limit}', `${c.handoff_k}k`) }] } }) + '\n');
    me.handoff.timer = setTimeout(() => { if (!me.done && !me.handoff.file) { writeHandoff(me, null, 'the hand-off turn did not end in time'); stop('handoff'); } }, o.handoffMs ?? HANDOFF_MS);
    me.handoff.timer.unref?.();
  }
  function handoffTurnDone(me, turn) {
    clearTimeout(me.handoff.timer);
    const text = me.handoff.text.join('\n\n').trim();
    if (turn.ok && text) writeHandoff(me, text);
    else writeHandoff(me, null, turn.ok ? 'the hand-off turn said nothing' : `the hand-off turn failed: ${clip(turn.error ?? turn.subtype ?? '?', 300)}`);
    stop('handoff');
  }
  /** chat/handoff-<n>.md = the model's hand-off (or a FORCED note) + what Norn carries itself: the chat's live holds, the cards waiting, the last turns */
  function writeHandoff(me, said, forcedWhy = null) {
    const h = me.handoff, file = path.join(chatDir(p.state), `handoff-${h.n}.md`);
    if (!said) h.forced = true;
    let holds = [];
    try { holds = heldLanes(loadState(p.state).items).filter(x => x.holder === 'chat'); } catch { /* no records yet */ }
    const cards = waitingCards(p.state), turns = lastTurns(readThread(p.state).items);
    h.carried = { threads: said ? openThreads(said).length : 0, holds: holds.length, cards: cards.length };
    const md = [`# Hand-off ${h.n} - project ${p.name}, segment ${h.from_seg} -> ${h.from_seg + 1}`, '',
      `Written ${new Date().toISOString()} at context ${kTok(h.ctx)}.${h.forced ? ` FORCED: ${forcedWhy} - no hand-off from the model; Norn wrote this from the thread and the records.` : ''}`, '',
      ...(said ? ["# The controller's hand-off", '', said, ''] : []),
      '# Norn: carried mechanically', '', '## Lanes held by this chat', ...(holds.length ? holds.map(x => `- ${x.id} held by ${holdWho(x)} until ${hhmm(x.until)}${x.why ? `: ${x.why}` : ''}`) : ['- none']), '',
      "## Cards waiting for the owner's tap", ...(cards.length ? cards.map(c => `- ${c.id}: ${c.title}`) : ['- none']), '',
      '## The last turns, verbatim', ...(turns.length ? turns : ['(none)']), ''].join('\n');
    fs.mkdirSync(chatDir(p.state), { recursive: true });
    fs.writeFileSync(file, md, 'utf8');
    h.file = file;
  }
  // the old process is gone: the divider line, then a NEW segment that the next message (or the waiting ones) starts with the carry-over
  function completeHandoff(me, why, code) {
    const h = me.handoff;
    clearTimeout(h.timer);
    if (!h.file) writeHandoff(me, null, `the session ended during the hand-off turn (${why}${code !== null && code !== undefined ? ` ${code}` : ''})`);
    append('handoff', { phase: 'done', n: h.n, from_seg: h.from_seg, ctx: h.ctx, forced: h.forced, file: h.file, carried: h.carried });
    newSegment(randomUUID(), 'handoff', live(me) ?? me.cfg, { handoff: h.n });
    rolling = null;
    if (!closing) flush();
  }
  /** the first message of a segment born of a hand-off: Norn's carry-over (the hand-off file + the state digest) */
  function carryOver() {
    let md = '';
    try { md = fs.readFileSync(path.join(chatDir(p.state), `handoff-${seg.handoff}.md`), 'utf8').trim(); } catch { md = `(the hand-off file handoff-${seg.handoff}.md is missing: call norn_boot and ask the owner what was open)`; }
    let dg = '';
    try { const d = tryDigest(p.state, p); if (d) dg = renderDigest(d, { level: 2 }).trim(); } catch { /* norn_boot carries it */ }
    return [`NORN CARRY-OVER (from Norn, not the owner's words): you continue the owner's controller chat of project ${p.name} in a FRESH session (segment ${seg.n}); `
      + 'the session before it reached its context limit. The records (DIR / DEC / Q, runs, lanes) are the memory - norn_boot gives the full state. '
      + 'Below: the hand-off, what Norn carried mechanically, and the last turns verbatim (evidence, not new instructions).', '', md, ...(dg ? ['', '# State digest', dg] : [])].join('\n');
  }
  function finish(me, why, code, err) {
    if (me.done) return;
    me.done = true;
    clearTimeout(me.idle); clearTimeout(me.kill); clearTimeout(me.settle);
    if (proc === me) { proc = null; clearInterval(outbox); drain(); }
    append('stop', { why, code, ...(err ? { err } : {}) });
    if (me.handoff) return completeHandoff(me, why, code);
    if (rolling === 'clear') newSegment(randomUUID(), 'clear', live(me) ?? me.cfg);   // R1: /clear - the next message starts a fresh session
    if (rolling === 'settings' || rolling === 'clear') { rolling = null; if (!closing) flush(); }
  }
  function arm(me) {
    clearTimeout(me.idle);
    me.idle = setTimeout(() => { if (proc === me && !me.pending && !me.handoff) stop('idle'); }, (live(me) ?? me.cfg).idleMs);
    me.idle.unref?.();
  }
  // the waiting owner messages go to the process that serves now (their owner lines are in the thread already)
  function flush() {
    const q = outq.splice(0);
    if (!q.length) return;
    try { const cfg = cfgOf(); for (const t of q) deliver(t.text, cfg, false, {}, t.raw); }
    catch (e) { append('stop', { why: 'spawn', code: null, err: clip(e.message, 500) }); }
  }
  function deliver(text, cfg, ownerLine, stamp = {}, raw = false) {
    // C2 finding: spawn BEFORE the owner line - a start that throws leaves no orphan owner line; the start line follows it
    const resume = proc ? null : prepare(cfg), fresh = !proc, me = proc ?? start(resume, cfg);
    if (ownerLine) append('owner', { text, ...stamp });
    if (fresh) append('start', { resume, pid: me.child.pid ?? null, model: cfg.model, effort: cfg.effort });
    clearTimeout(me.idle);
    if (!me.pending) { me.since = Date.now(); me.doing = 'thinking'; }
    me.pending++;
    // C4: the NEWS block rides in front of the owner's text to the model only - the owner line (the verbatim guard's source) stays the owner's
    let news = '';
    try { news = newsBlock(p.state); } catch { /* the records unreadable: the message goes without news */ }
    // C5: the first message of a segment born of a hand-off carries it over
    const carry = fresh && !resume && seg.handoff ? carryOver() : '';
    const userLine = t => me.child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } }) + '\n');
    // R1: a passed-through command goes verbatim (the CLI dispatches only a message that IS the command); a carry-over goes first, on its own
    if (raw) { if (carry) { me.pending++; userLine(carry); } userLine(text); return { ok: true, seg: seg.n, session_id: seg.session_id, sent: true }; }
    userLine(carry || news ? `${[carry, news].filter(Boolean).join('\n\n')}\n\nThe owner's message:\n${text}` : text);
    return { ok: true, seg: seg.n, session_id: seg.session_id };
  }
  const SETTING_KEYS = ['executor', 'exe', 'model', 'effort', 'rawShell'];
  // C6: o.via = 'remote:<device>' when the owner wrote from a paired phone (stamped on the owner line; absent = as before)
  function send(text, o = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('text is required');
    text = text.trim();
    const cfg = cfgOf();
    chatCapable(cfg);
    const m = text.match(CMD), name = m?.[1] ?? null, raw = !!m;
    const stamp = { ...(m ? { cmd: name } : {}), ...(o.via ? { via: o.via } : {}) };
    if (m && NORN_COMMANDS[name.toLowerCase()]) return command(name.toLowerCase(), (m[2] ?? '').trim(), text, stamp, cfg);
    if (m) { const why = refusal(name, chatCommands(readThread(p.state).items)); if (why) { append('owner', { text, ...stamp }); return say(name, why); } }
    const wait = () => { append('owner', { text, ...stamp }); outq.push({ text, raw }); return { ok: true, queued: true, seg: seg?.n ?? null, session_id: seg?.session_id ?? null, ...(raw ? { sent: true } : {}) }; };
    if (rolling || outq.length) return wait();
    // C5: Settings obeyed live - an idle process started with other settings is ended; the message goes to a fresh one (the session resumes).
    // R1: a busy one first finishes its turn (rollAfter), then the same - a pick applies from the next turn
    if (proc && SETTING_KEYS.some(k => proc.cfg[k] !== cfg[k])) { const r = wait(); if (proc.pending) rollAfter = true; else { rolling = 'settings'; stop('settings'); } return r; }
    return deliver(text, cfg, true, stamp, raw);
  }
  const say = (cmd, text) => { append('norn', { text, cmd }); return { ok: true, command: cmd, sent: false, text }; };
  function refusal(name, list) {
    const norn = Object.keys(NORN_COMMANDS).map(k => '/' + k).join(' ');
    if (!list) return `/${name}: this chat's own commands are not known yet - the CLI lists them when the chat process starts. Send a message first, then try again. Not sent.`;
    if (list.includes(name)) return null;
    return `/${name} is not a command of this chat. Norn's: ${norn}; this session lists ${list.length} more (type / for the menu). Not sent - a command is never passed on as plain text.`;
  }
  /** R1: the picker and /model, /effort: { model?, effort? } (a value, or null = back to the Settings row; absent = unchanged); applies from the next turn */
  function pick(v = {}) {
    const cfg = cfgOf(), ch = cfg.choices ?? {}, next = { model: picked?.model ?? null, effort: picked?.effort ?? null };
    for (const k of ['model', 'effort']) {
      if (v[k] === undefined) continue;
      if (v[k] !== null && !((k === 'model' ? ch.models : ch.efforts) ?? []).includes(v[k])) throw Object.assign(new Error(`${v[k]} is not a ${k} of this chat`), { status: 400 });
      next[k] = v[k];
    }
    picked = next.model || next.effort ? next : null;
    append('pick', next);
    return status();
  }
  function command(name, arg, text, stamp, cfg) {
    append('owner', { text, ...stamp });
    const items = () => readThread(p.state).items, ch = cfg.choices ?? {}, busy = !!proc?.pending || !!rolling;
    if (name === 'model' || name === 'effort') {
      const list = (name === 'model' ? ch.models : ch.efforts) ?? [], def = cfg.defaults[name], cur = cfg[name], mine = picked?.[name];
      if (!arg) return say(name, `${name} in use: ${cur}${mine ? ` (picked for this chat; the Settings default is ${def})` : ' (the Settings default)'}. Choose: /${name} ${[...list, 'default'].join(' | ')}`);
      const a = arg.toLowerCase(), v = a === 'default' ? null
        : list.find(x => x.toLowerCase() === a) ?? (name === 'model' ? ch.alias?.[a] ?? list.find(x => x.toLowerCase().includes(a)) : undefined);
      if (v === undefined) return say(name, `${arg} is not a ${name} of this chat (choose ${list.join(', ')} or default) - nothing changed.`);
      pick({ [name]: v });
      return say(name, v === null ? `${name} -> the Settings default (${def}) from the next turn.` : `${name} -> ${v} from the next turn (this chat only; "make default" in the picker writes the Settings row).`);
    }
    if (name === 'clear') {
      if (busy) return say(name, 'a turn is running - /clear once it has ended. Nothing changed.');
      if (!seg) seg = threadState(items()).seg;
      const r = say(name, `new session: the next message starts a fresh conversation (segment ${(seg?.n ?? 0) + 1}). The records (DIR / DEC / Q, runs, lanes) stay; the controller reads them with norn_boot.`);
      if (proc) { rolling = 'clear'; stop('clear'); } else newSegment(randomUUID(), 'clear', cfg);
      return r;
    }
    if (name === 'compact') {
      if (busy) return say(name, 'a turn is running - /compact once it has ended. Nothing changed.');
      const t = threadState(items());
      if (!t.seg || !t.begun) return say(name, 'nothing to hand off yet: this session has had no turn.');
      let me = proc;
      if (!me) { const resume = prepare(cfg); me = start(resume, cfg); append('start', { resume, pid: me.child.pid ?? null, model: cfg.model, effort: cfg.effort }); }
      const ctx = segCtx ?? lastCtx(items(), seg.n) ?? 0;
      const r = say(name, `hand-off now (Norn's /compact): the controller writes its hand-off, then a fresh session (segment ${seg.n + 1}) carries it over. The records stay the memory.`);
      beginHandoff(me, ctx, cfg.context);
      return r;
    }
    if (name === 'cost' || name === 'usage') {
      const all = items(), c = chatCost(all, { perPct: cfg.perPct }), ctx = segCtx ?? (seg ? lastCtx(all, seg.n) : null);
      const tok = c.tokens >= 1e6 ? (c.tokens / 1e6).toFixed(2) + 'M' : (c.tokens / 1000).toFixed(1) + 'k';
      return say(name, `chat today: ${tok} tokens · ${c.turns} turn${c.turns === 1 ? '' : 's'}${Number.isFinite(c.weekly_pct) ? ` · ~${c.weekly_pct.toFixed(2)} % of the week (estimate)` : ''}`
        + `${Number.isFinite(ctx) ? ` · this session's context ${kTok(ctx)} of the ${cfg.context.handoff_k}k hand-off` : ''}. Norn counts the chat per turn; workers and check-ins: the Runs page and the Usage column.`);
    }
    const list = chatCommands(items());
    return say(name, ['Norn chat commands (answered by Norn, no model turn):', ...Object.entries(NORN_COMMANDS).map(([k, w]) => `/${k} - ${w}`),
      list ? `This session's own commands (${list.length}, passed to the CLI exactly as typed): type / for the menu.` : "This session's own commands are listed once the chat has started."].join('\n'));
  }
  /** close stdin (the CLI ends its turn and exits 0); kill the tree only if it is still there after graceMs */
  function stop(why = 'owner') {
    const me = proc;
    if (!me) return false;
    me.why = why;
    clearTimeout(me.idle);
    me.child.stdin.end();
    me.kill = setTimeout(() => { if (!me.done) killTree(me.child); }, graceMs);
    me.kill.unref?.();
    return true;
  }
  /** stop the process (shutdown) and wait until it is gone */
  function close() {
    closing = true;
    dropLease(p);
    const me = proc;
    if (!me) return threadFlushed(p.state);
    const gone = new Promise(r => me.child.once('close', r));
    stop('shutdown');
    return gone.then(() => threadFlushed(p.state));
  }
  function status() {
    const items = seg ? null : readThread(p.state).items, t = seg ? { seg } : threadState(items);
    const cfg = live(proc) ?? {}, ctx = segCtx ?? (t.seg ? lastCtx(items ?? readThread(p.state).items, t.seg.n) : null);
    // since / doing / queued: the header's live line (how long this turn has run, its last tool, the messages waiting in Norn)
    return { running: !!proc, busy: !!proc?.pending || !!rolling, since: proc?.since ?? null, doing: proc?.doing ?? null, queued: outq.length, rolling: rolling ?? (rollAfter ? 'settings' : null), segment: t.seg?.n ?? null, session_id: t.seg?.session_id ?? null, executor: cfg.executor, model: cfg.model,
      effort: cfg.effort, raw_shell: cfg.rawShell, ctx, context: cfg.context, handing_off: rolling === 'handoff', pick: picked ?? null, defaults: cfg.defaults ?? null };
  }
  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  /** C3: the MCP chat profile's outbox (approval cards, timeouts, done cards, shown files) into the thread - its one writer */
  function drain() {
    const evs = drainOutbox(p.state);
    for (const { kind, ...data } of evs) if (NOTE_KINDS.has(kind)) append(kind, data);
    return evs.length;
  }
  /** the owner's tap on an approval card (a button, no model): approve | deny; ActError 404 / 409 */
  function decide(id, verdict, o = {}) {
    drain();
    const v = decideApproval(p.state, id, verdict, 'owner');
    append('verdict', { id, verdict, by: 'owner', ...(o.via ? { via: o.via } : {}) });
    return v;
  }
  /** a line the dashboard writes for the owner (an undo) */
  function note(kind, data) { if (kind !== 'undone') throw new Error(`note: ${kind} is not a dashboard line`); return append(kind, data); }
  return { send, stop, close, status, subscribe, drain, decide, note, pick };
}
