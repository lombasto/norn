// META-CONTROLLER C3 (SPEC sec. 3 + 8): the chat ACTS - through Norn verbs, by tier. Shared by the MCP `chat` profile (mcp.mjs,
// the process the chat CLI starts) and the dashboard (chat.mjs + server.mjs, the one writer of the thread file):
// - tiers: 0 read / 1 act, recorded (what a check-in may do unattended) / 2 your tap (approval card, 30 min, then deny + ping) /
//   3 off (raw shell, file edits - the Settings switch chat_raw_shell, C5: off / ask = a card / on). tierOf (Norn tools), promptTier (the CLI's own tools).
// - norn_cli: an allow-listed `meta` subcommand as an argument list, never a shell; role, project and via are injected, never given.
// - the verbatim guard: a directive / an owner answer is recorded only in words the owner wrote in this thread.
// - the outbox: the MCP server drops thread events (approval, verdict, done, show) as files; the dashboard's chat drains them into
//   the thread, so the thread keeps ONE writer. Approvals: <state>/chat/approvals/<AP-id>.json + .verdict.json (first writer wins).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadState } from './records.mjs';
import { realPath } from './config.mjs';

export const APPROVAL_MS = 30 * 60000;   // SPEC sec. 3 tier 2: waits 30 min, then denies and pings you
export const chatDir = state => path.join(state, 'chat');
export const threadFile = state => path.join(chatDir(state), 'thread.jsonl');
export const outboxDir = state => path.join(chatDir(state), 'outbox');
export const approvalsDir = state => path.join(chatDir(state), 'approvals');
export class ActError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

// ---------- tiers ----------
const READ = new Set(['norn_boot', 'norn_status', 'norn_inbox', 'norn_records', 'norn_ledger', 'norn_show', 'norn_approve']);
const ACT = new Set(['norn_answer', 'norn_directive', 'norn_question_add', 'norn_decision_add', 'norn_record_event', 'norn_run', 'norn_stop', 'norn_tick']);
/** The tier of a Norn tool call (norn_cli by its subcommand; a refused subcommand throws). Unknown = 3 (off). */
export function tierOf(tool, a = {}) {
  if (READ.has(tool)) return 0;   // norn_approve is the tap itself: it decides nothing, the owner does
  if (tool === 'norn_run_show') return a.ask !== undefined ? 1 : 0;   // an ask is a paid run, as a check-in may start
  if (tool === 'norn_settings') return a.set && !a.dry_run ? 2 : 0;
  if (tool === 'norn_pause') return a.half ? 0 : 2;   // RM-37: pause half's pick only reads
  if (tool === 'norn_cli') return cliPlan(a.args).tier;
  return ACT.has(tool) ? 1 : 3;
}
// the CLI's own tools, as its permission prompt (--permission-prompt-tool -> norn_approve) names them
const FILE_RO = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const RAW = new Set(['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'BashOutput', 'KillShell', 'KillBash']);
/** -> { tier, decide: allow | deny | ask }. Norn's own tools are allowed here: the Norn server gates their tier itself. */
export function promptTier(name, rawShell = 'off') {
  const n = String(name ?? '');
  if (/^mcp__norn__/.test(n)) return { tier: 1, decide: 'allow' };
  if (FILE_RO.has(n)) return { tier: 0, decide: 'allow' };
  // C5 (SPEC sec. 3 tier 3): the Settings switch - off (default) / ask each time (a card) / on
  if (RAW.has(n)) return rawShell === 'on' ? { tier: 1, decide: 'allow' } : rawShell === 'ask' ? { tier: 2, decide: 'ask' } : { tier: 3, decide: 'deny' };
  return { tier: 2, decide: 'ask' };   // anything else (web, another tool): your tap
}

// ---------- norn_cli: the allow-list ----------
// never given by the model: who acts (role), where (project / state / locks / machine / budget), how it is stamped, or a blocking wait
const INJECTED = ['--as', '--state', '--project', '--locks', '--machine', '--budget', '--via', '--wait', '--root', '--meta'];
const flagOf = (args, f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const has = (args, f) => args.includes(f);
const REC_READ = ['list', 'show', 'views'];
const REC_ACT = ['add question', 'add decision', 'add lane', 'apply', 'supersede', 'withdraw', 'overrule', 'done', 'revoke', 'park', 'unpark', 'archive', 'unarchive'];
const DLV_ACT = ['park', 'unpark', 'supersede', 'ask', 'resolve'];
// META-CONTROLLER C4 (SPEC sec. 2): a controller's act on a lane holds it this long (a Settings row in C5)
export const HOLD_MIN = 30;   // the default; Settings chat_hold_min (C5) is read by the MCP server on every act
export const CLI_ALLOWED = ['instructions suggest', 'instructions confirm', 'instructions apply', 'lane new', 'lane claim', 'lane release', 'mergeq', 'deliverables', 'mail send', 'notify', 'run --queue', 'requeue', ...[...REC_READ, ...REC_ACT].map(s => `rec ${s}`)];
/**
 * args: the `meta` argument list (no shell) -> { sub, tier, argv (as run: + the injected role where the verb takes no env role),
 * verbatim? (owner words this call records) }; a subcommand not on the list, or an injected flag, throws ActError.
 */
export function cliPlan(args) {
  if (!Array.isArray(args) || !args.length || args.some(a => typeof a !== 'string')) throw new ActError('norn_cli needs args: the norn subcommand as an argument list of strings');
  for (const a of args) if (INJECTED.some(f => a === f || a.startsWith(f + '='))) throw new ActError(`norn_cli: ${a.split('=')[0]} is set by Norn (role controller, this project, via chat), never by the caller`);
  const [c, s, ...rest] = args, refuse = sub => new ActError(`norn_cli: \`norn ${sub}\` is not on the chat's list (${CLI_ALLOWED.join(', ')})`);
  if (c === 'lane') {
    if (s === 'claim' || s === 'release') return { sub: `lane ${s}`, tier: 1, argv: [...args, '--as', 'controller'] };   // C4: the chat's own hold
    if (s !== 'new') throw refuse(`lane ${s ?? ''}`.trim());
    const task = flagOf(args, '--task');
    return { sub: 'lane new', tier: 1, argv: [...args, '--as', 'controller'], ...(task !== undefined ? { verbatim: task } : {}) };   // lane takes no env role
  }
  // META-STANDING-CONTEXT R1: suggest reads, confirm records ("still true"), apply edits an instruction file - the owner's tap
  if (c === 'instructions') {
    const t = { suggest: 0, confirm: 1, apply: 2 }[s];
    if (t === undefined) throw refuse(`instructions ${s ?? ''}`.trim());
    return { sub: `instructions ${s}`, tier: t, argv: args };
  }
  if (c === 'mergeq') return { sub: 'mergeq', tier: has(args, '--run') || has(args, '--batching') ? 2 : has(args, '--update') ? 1 : 0, argv: args };
  if (c === 'deliverables') {
    const sub = s && !s.startsWith('-') ? s : null;
    if (sub && sub !== 'backfill' && !DLV_ACT.includes(sub)) throw refuse(`deliverables ${sub}`);
    return { sub: 'deliverables', tier: !sub || (sub === 'backfill' && !has(args, '--apply')) ? 0 : 1, argv: args };
  }
  if (c === 'mail') { if (s !== 'send') throw refuse(`mail ${s ?? ''}`.trim()); return { sub: 'mail send', tier: 1, argv: args }; }
  if (c === 'notify') return { sub: 'notify', tier: 1, argv: args };
  if (c === 'run') { if (!has(args, '--queue')) throw refuse('run (without --queue: use norn_run)'); return { sub: 'run --queue', tier: 1, argv: args }; }
  if (c === 'requeue') return { sub: 'requeue', tier: 1, argv: args };
  if (c === 'rec') {
    const sub = s === 'add' ? `add ${rest[0] ?? ''}`.trim() : s;
    if (sub === 'answer' || sub === 'add directive') throw new ActError(`norn_cli: \`norn rec ${sub}\` records owner words - use ${sub === 'answer' ? 'norn_answer' : 'norn_directive'} (the verbatim guard)`);
    if (REC_READ.includes(sub)) return { sub: `rec ${sub}`, tier: 0, argv: args };
    if (REC_ACT.includes(sub)) return { sub: `rec ${sub}`, tier: 1, argv: args };
    throw refuse(`rec ${sub ?? ''}`.trim());
  }
  throw refuse(c);
}

// ---------- the verbatim guard ----------
const norm = s => String(s ?? '').normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Did the owner write these words in the thread (case and spacing aside, at word boundaries; outer quotes / a final stop ignored)? */
export function ownerSaid(lines, text) {
  const t = norm(text).replace(/^["'`]+|["'`]+$/g, '').replace(/[.!?;:,]+$/, '').trim();
  if (!t) return false;
  const re = new RegExp(`(?:^|[^\\p{L}\\p{N}])${reEsc(t)}(?=$|[^\\p{L}\\p{N}])`, 'u');
  return lines.some(l => l.kind === 'owner' && re.test(norm(l.text)));
}

// ---------- what may be shown (norn_show, GET /api/file): the project root, its state, the briefs dir, run + lane worktrees and NOTES folders
const realOf = f => { try { return fs.realpathSync.native(path.resolve(f)); } catch { return null; } };
export function showRoots(state, project) {
  const items = Object.values(loadState(state).items), runs = items.filter(i => i.kind === 'run'), lanes = items.filter(i => i.kind === 'lane');
  const notesDir = i => i.data.notes && path.dirname(String(i.data.notes));
  return [...new Set([project?.root, state, project?.briefs_dir, ...[...runs, ...lanes].flatMap(i => [i.data.worktree, notesDir(i)]), ...lanes.map(l => l.data.brief_dir)]
    .filter(Boolean).map(realOf).filter(Boolean))];
}
/** the real path of f when it lies inside one of the roots (no .. / link escapes), else null */
export function insideRoots(roots, f) {
  const real = realPath(f);   // a missing file too: its real folder + name, so it is judged (404) beside its roots, not refused by spelling
  return roots.some(r => { const rel = path.relative(r, real); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); }) ? real : null;
}

// ---------- the outbox (MCP server -> the dashboard's thread) ----------
let seq = 0;
export function emit(state, ev) {
  const d = outboxDir(state);
  fs.mkdirSync(d, { recursive: true });
  const name = `${String(Date.now()).padStart(14, '0')}-${process.pid}-${String(++seq).padStart(6, '0')}.json`, tmp = path.join(d, name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(ev));
  fs.renameSync(tmp, path.join(d, name));
}
/** Take every outbox event, oldest first (each file removed once read). */
export function drain(state) {
  let names;
  try { names = fs.readdirSync(outboxDir(state)).filter(n => n.endsWith('.json')).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const n of names) {
    const f = path.join(outboxDir(state), n);
    try { out.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* torn: dropped below */ }
    try { fs.unlinkSync(f); } catch { /* gone */ }
  }
  return out;
}

// ---------- approvals (tier 2) ----------
const AP = /^AP-[0-9a-f]{8}$/;
const reqFile = (state, id) => path.join(approvalsDir(state), `${id}.json`);
const verdictFile = (state, id) => path.join(approvalsDir(state), `${id}.verdict.json`);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export const readVerdict = (state, id) => readJson(verdictFile(state, id));
export const readRequest = (state, id) => (AP.test(String(id)) ? readJson(reqFile(state, id)) : null);
/** first writer wins (the owner's tap vs the timeout): the verdict, or null when one was there already */
export function writeVerdict(state, id, v) {
  const rec = { id, ts: new Date().toISOString(), ...v };
  try { fs.writeFileSync(verdictFile(state, id), JSON.stringify(rec), { flag: 'wx' }); return rec; } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
}
/** The owner's tap: approve | deny an open approval. 404 unknown, 409 decided already (by a tap or the timeout). */
export function decide(state, id, verdict, by = 'owner') {
  if (!['approve', 'deny'].includes(verdict)) throw new ActError('verdict must be approve | deny');
  if (!readRequest(state, id)) throw new ActError(`no approval ${id}`, 404);
  const v = writeVerdict(state, id, { verdict, by });
  if (!v) { const was = readVerdict(state, id); throw new ActError(`${id} was decided already: ${was?.verdict ?? '?'}${was?.why ? ` (${was.why})` : ''}`, 409); }
  return v;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
/**
 * Show an approval card and wait for the owner's tap. o: { title, text, command?, tool?, ms (default 30 min), pollMs, notifyFn(n) }
 * -> { id, verdict: approve | deny, why?, by }. No tap in time = deny, a verdict line in the thread, and a ping (notifyFn).
 */
export async function requestApproval(state, o) {
  const ms = o.ms ?? APPROVAL_MS, pollMs = o.pollMs ?? 500, id = 'AP-' + randomUUID().slice(0, 8), t0 = Date.now();
  const req = { id, ts: new Date(t0).toISOString(), title: o.title, text: o.text ?? '', command: o.command ?? null, tool: o.tool ?? null,
    timeout_min: Math.max(1, Math.round(ms / 60000)), expires: new Date(t0 + ms).toISOString() };
  fs.mkdirSync(approvalsDir(state), { recursive: true });
  fs.writeFileSync(reqFile(state, id), JSON.stringify(req));
  emit(state, { kind: 'approval', ...req });
  for (;;) {
    const v = readVerdict(state, id);
    if (v) return v;
    const left = t0 + ms - Date.now();
    if (left <= 0) {
      const mine = writeVerdict(state, id, { verdict: 'deny', why: 'timeout', by: 'norn' });
      if (!mine) continue;   // the tap came first
      emit(state, { kind: 'verdict', id, verdict: 'deny', why: 'timeout', by: 'norn' });
      try { await o.notifyFn?.({ id, title: `Norn chat: no tap in ${req.timeout_min} min - denied`, body: `${o.title} (${id}) was denied after ${req.timeout_min} min without your tap. Ask again in the chat if you still want it.` }); } catch { /* the ping is best effort; the deny stands */ }
      return mine;
    }
    await sleep(Math.min(pollMs, left));
  }
}
