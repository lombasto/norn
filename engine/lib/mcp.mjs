// H1 meta MCP server (HARNESS-DESIGN sec. 4): stdio JSON-RPC, newline-delimited, hand-rolled, Node built-ins only.
// One server per harness session and project. The profile (controller | checkin | worker) decides the tools; the writer role
// and `via` come from the launch args, never from the model. Writes go through records.mjs (its lock + role gates).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, loadState, kindOfId, kindNamed, RecordError, KINDS, holdOf, laneId, laneName } from './records.mjs';
import { ConfigError, metaRoot, fwd, loadMachine, loadProject, expandVars } from './config.mjs';
import { genAfterPolicy, projectNew, SetupError } from './setup.mjs';
import { scan, interviewOf, proposalOf, adoptDecide, adoptApply, renderProposal, AdoptError, PARTS } from './adopt.mjs';
import { settingsView, applySettings, onlyChanged, floorChanges, withDefaults, merged, split, generatedLines, rewriteMarked, getPath, executorsFor } from './policy.mjs';
import { providersOf, executorExtra } from './executors.mjs';
import { renderCheckin, CHECKIN_PROMPT } from './tick.mjs';
import { tryDigest, digestIds } from './digest.mjs';
import { renderDigest } from './views.mjs';
import { formatInstructions } from './instructions.mjs';
import { formatPlan } from './plan.mjs';
import { checkMail, sendMail, ackMail, formatMail, mailRole } from './mail.mjs';
import { tierOf, promptTier, cliPlan, ownerSaid, emit, requestApproval, showRoots, insideRoots, ActError, APPROVAL_MS, CLI_ALLOWED, HOLD_MIN } from './chatact.mjs';
import { readThread } from './chat.mjs';
import { splitRepo, projectHome } from './monorepo.mjs';
import { dupOf, dupMessage } from './dupdirs.mjs';
import { PauseError, setPause, pauseRuns, pickHalf, nearEndMin, resumeRun, resumeAll } from './pause.mjs';
import { PAUSE_MODES, MODE_NAMES, pauseFiles, readPause } from './pausemode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META_CLI = path.join(HERE, '..', 'bin', 'norn.mjs');
export const CONTROLLER_PROMPT = path.join(HERE, '..', 'prompts', 'CONTROLLER.md');
const RECORDS_DOC = path.join(HERE, '..', 'prompts', 'RECORDS.md');
const SETUP_PROMPT = path.join(HERE, '..', 'prompts', 'SETUP.md');
export const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// META-ADOPT A4: setup is machine-scoped (no project): 'set this repo up for Norn' from any MCP client
// META-CONTROLLER C3: chat = the controller tools + norn_show / norn_cli / norn_approve, tier-gated (chatact.mjs), for Norn's chat only
export const PROFILES = ['controller', 'checkin', 'worker', 'setup', 'chat'];
const HB_FRESH_MS = 10 * 60 * 1000;

export class ToolError extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }
const bad = msg => { throw new ToolError(msg, 2); };

// Who is asking, from the environment: a check-in run sets META_ROLE=checkin; every other supervised run has META_RUN_ID (worker),
// even when it inherited META_ROLE=controller from the session that started it.
export function envRole(env) {
  if (env.META_ROLE === 'checkin') return 'checkin';
  if (env.META_RUN_ID) return 'worker';
  return env.META_ROLE || null;
}
export function refusal(profile, env) {
  if (!PROFILES.includes(profile)) return `--profile must be ${PROFILES.join(' | ')} (got ${JSON.stringify(profile)})`;
  const r = envRole(env);
  if ((profile === 'controller' || profile === 'chat') && (r === 'worker' || r === 'checkin')) return `refused: profile ${profile} from a ${r} environment (META_ROLE=${env.META_ROLE || '-'}, META_RUN_ID=${env.META_RUN_ID || '-'})`;
  if (profile === 'setup' && (r === 'worker' || r === 'checkin')) return `refused: profile setup from a ${r} environment (META_ROLE=${env.META_ROLE || '-'}, META_RUN_ID=${env.META_RUN_ID || '-'})`;
  if (profile === 'checkin' && r === 'worker') return `refused: profile checkin from a worker environment (META_RUN_ID=${env.META_RUN_ID})`;
  return null;
}

// ---------- minimal JSON-schema check (the shapes the tools use) ----------
function checkArgs(schema, v, at = 'arguments') {
  const t = schema.type;
  if (t === 'object') {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) bad(`${at} must be an object`);
    for (const k of schema.required || []) if (v[k] === undefined) bad(`${at}.${k} is required`);
    for (const [k, x] of Object.entries(v)) {
      const s = schema.properties?.[k];
      if (!s) { if (schema.additionalProperties === false) bad(`${at}.${k} is not an input of this tool`); continue; }
      checkArgs(s, x, `${at}.${k}`);
    }
  } else if (t === 'array') {
    if (!Array.isArray(v)) bad(`${at} must be a list`);
    v.forEach((x, i) => schema.items && checkArgs(schema.items, x, `${at}[${i}]`));
  } else if (t === 'integer') {
    if (!Number.isInteger(v)) bad(`${at} must be an integer`);
    if (schema.minimum !== undefined && v < schema.minimum) bad(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) bad(`${at} must be <= ${schema.maximum}`);
  } else if (t === 'string') {
    if (typeof v !== 'string') bad(`${at} must be a string`);
    if (schema.enum && !schema.enum.includes(v)) bad(`${at} must be one of ${schema.enum.join(' | ')}`);
  } else if (t === 'boolean') { if (typeof v !== 'boolean') bad(`${at} must be true or false`); }
}
const S = { str: (description, extra = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra }), int: (min, max) => ({ type: 'integer', minimum: min, maximum: max }),
  bool: { type: 'boolean' }, strs: { type: 'array', items: { type: 'string' } } };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const tail = (file, n) => { if (!n || !file) return ''; try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n').filter((l, i, a) => i < a.length - 1 || l).slice(-n).join('\n'); } catch { return ''; } };
const title = i => i.data.title ?? i.data.question ?? i.data.text ?? i.data.lane ?? i.data.name ?? i.data.kind ?? '';
const lastSeq = i => i.history.at(-1)?.seq ?? 0;
const KIND_ORDER = ['question', 'decision', 'directive', 'lane', 'run'];
const order = (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.kind === 'lane' ? a.id.localeCompare(b.id) : Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));

// The needs-you set (HARNESS-DESIGN sec. 4 norn_inbox): open Q, answered-not-applied Q, parked lanes, unreviewed ended runs.
export function needsYou(i) {
  if (i.kind === 'question' && i.state === 'open') return 'open question';
  if (i.kind === 'question' && i.state === 'answered') return 'answered, not applied';
  if (i.kind === 'lane' && i.state === 'parked') return 'parked lane';
  if (i.kind === 'run' && ['exited', 'lost', 'killed'].includes(i.state) && !i.review && i.data.kind !== 'interactive') return 'unreviewed run';
  if (i.kind === 'run' && i.state === 'queued' && i.hold && !i.hold.cleared) return 'needs a ruling';   // META-AUTONOMY R1: the fill held it (norn requeue / stop / runs landed)
  return null;
}

// ---------- the tools ----------
const CTL = ['controller', 'chat'], CK = ['controller', 'checkin', 'chat'], ALL = ['controller', 'checkin', 'worker', 'chat'], SETUP = ['setup'], CHAT = ['chat'];
const CONTROLLERS = ['controller', 'chat'];
const EVENTS = ['apply', 'supersede', 'withdraw', 'park', 'unpark', 'overrule', 'revoke', 'done'];
export const TOOLS = [
  { name: 'norn_boot', profiles: CK, description: 'Role pack (your instructions) plus a state digest. Call first in every session.',
    schema: obj({ role: S.str('', { enum: ['controller', 'checkin'] }) }, ['role']), run: boot },
  // META-PLAN R1: the plan rides on norn_status (view plan) - the controller profile is capped at 16 tools (as META-GTP-ASK on norn_run_show)
  { name: 'norn_status', profiles: ALL, description: 'STATUS.md of the project (budget, caps, records), at most 60 lines; view plan = what happens next, and when.',
    schema: obj({ project: S.str('project name (optional; this server serves one project)'),
      view: S.str('status (default) | plan: up next, chains, landing next, usage forecast | instructions: the files that steer agents, ~tokens, cost today, hints (read-only)', { enum: ['status', 'plan', 'instructions'] }) }), run: status },
  { name: 'norn_inbox', profiles: CK, description: 'Needs-you items (open / answered-unapplied questions, parked lanes, unreviewed runs) plus a cursor.',
    schema: obj({ project: S.str(), since_seq: S.int(0), since_runs_seq: S.int(0) }), run: inbox },
  { name: 'norn_records', profiles: CK, description: 'Record rows: questions, decisions, directives, lanes, runs (filter by kind / state / id / lane).',
    schema: obj({ kind: S.str('', { enum: ['question', 'decision', 'directive', 'lane', 'run', 'Q', 'DEC', 'DIR', 'L', 'RUN'] }), state: S.str(), id: S.str(), lane: S.str(), limit: S.int(1, 50) }), run: records },
  { name: 'norn_answer', profiles: CTL, description: "Record the OWNER's answer to Q-n, in the owner's own words (verbatim).",
    schema: obj({ q: S.str('Q-n'), text: S.str('owner words verbatim'), choice: S.str('option key') }, ['q', 'text']), run: answer },
  { name: 'norn_directive', profiles: CTL, description: "Record an OWNER directive (owner's words verbatim), optionally scoped to lanes.",
    schema: obj({ text: S.str('owner words verbatim'), scope: S.strs, expires: S.str('UTC time'), new: S.bool }, ['text']), run: directive },
  { name: 'norn_question_add', profiles: CK, description: 'Ask the owner one question (options with cost, a recommendation); parks the lanes it blocks. owner_only = a taste / owner pick no check-in may rule.',
    schema: obj({ lane: S.str(), title: S.str(), body: S.str('short markdown: a lead sentence, then bullets; ids bare (the Inbox links them), backticks only for code (a command, a path)'), options: { type: 'array', description: 'every real alternative (3-4 if they exist, never padded)', items: obj({ key: S.str(), text: S.str(), cost: S.str() }, ['key', 'text']) },
      recommend: obj({ key: S.str(), why: S.str() }, ['key', 'why']), class: S.str('', { enum: ['i', 'ii', 'iii', 'iv', 'v'] }), blocks: S.strs, source: S.str(), owner_only: S.bool }, ['lane', 'title', 'options']), run: questionAdd },
  { name: 'norn_decision_add', profiles: CK, description: 'Record a controller decision (question, choice, why, cost, source).',
    schema: obj({ lane: S.str(), question: S.str(), choice: S.str(), why: S.str(), cost: S.str(), source: S.str(), answers: S.str('Q-n it answers (with owner_words: closes it in the same step)'), owner_words: S.str("the owner's words, verbatim (with answers)"), not_an_answer: S.bool, notify: S.bool }, ['lane', 'question', 'choice', 'why']), run: decisionAdd },
  { name: 'norn_record_event', profiles: CK, description: `One event on a record: ${EVENTS.join(' | ')} (role-gated by the records core).`,
    schema: obj({ id: S.str('Q-n | DEC-n | DIR-n | L:name'), event: S.str('', { enum: EVENTS }), fields: { type: 'object' } }, ['id', 'event']), run: recordEvent },
  { name: 'norn_run', profiles: CK, description: 'Start a supervised run (lane, brief, executor or work class). Error code 4 = cap full, do it later.',
    schema: obj({ lane: S.str(), brief: S.str('brief file'), class: S.str('work class'), executor: S.str(), model: S.str(), effort: S.str(), budget_min: S.int(1),
      parent: S.str('RUN-n'), worktree: S.str(), notes: S.str() }, ['lane', 'brief']), run: startRunTool },
  { name: 'norn_stop', profiles: CK, description: 'Kill a running run (whole process tree) with a reason.',
    schema: obj({ run: S.str('RUN-n'), why: S.str() }, ['run', 'why']), run: stop },
  { name: 'norn_run_show', profiles: ALL, description: 'One run: state, outcome, usage, log / NOTES tails. ask = a question to the ENDED run (norn ask; checkin + controller).',
    schema: obj({ run: S.str('RUN-n'), log_tail: S.int(0, 200), notes_tail: S.int(0, 100), ask: S.str('question to the ENDED run: norn ask (fork of its session, else a cold helper)'),
      executor: S.str('cold helper executor (ask)'), max_s: S.int(0, 540) }, ['run']), run: runShow },
  { name: 'norn_tick', profiles: CTL, description: 'Start one detached check-in tick now.',
    schema: obj({ reason: S.str() }, ['reason']), run: tickTool },
  { name: 'norn_pause', profiles: CTL, description: 'Pause (one of): a mode; runs to pause safely (they hand off, never auto-resumed); half (the pick, no act); resume RUN-n | all.',
    schema: obj({ mode: S.str('checkins: no check-ins | queue: nothing new starts, resumes wait queued | all: both', { enum: MODE_NAMES }), runs: { ...S.strs, description: 'RUN-n each sent an urgent order: commit, hand off, end' },
      half: S.bool, n: S.int(0), resume: S.str('RUN-n: its paused hand-off queued first | all: the pause released, paused hand-offs queued, merges first'), why: S.str() }), run: pause },
  { name: 'norn_settings', profiles: CK, description: 'Read Settings; the controller may also set one (validated, dry_run shows the diff).',
    schema: obj({ get: S.strs, set: obj({ key: S.str(), value: {} }, ['key', 'value']), dry_run: S.bool }), run: settings },
  // META-GTP-MAIL delivery (b): the mailbox of the run this server serves (META_RUN_ID) - for executors without the mail hook
  { name: 'norn_mail', profiles: ['worker'], description: 'Your mail: check (takes delivery of unread mail), send (to your parent, role:checkin, role:controller or your epic), ack MAIL-n.',
    schema: obj({ action: S.str('', { enum: ['check', 'send', 'ack'] }), to: S.str('RUN-n | role:checkin | role:controller'), subject: S.str(), body: S.str('<= 2 KB'), urgent: S.bool, id: S.str('MAIL-n (ack)') }, ['action']), run: mailTool },
  { name: 'norn_ledger', profiles: CK, description: 'Last lines of the project ledger.',
    schema: obj({ tail: S.int(1, 40) }), run: ledger },
  // META-CONTROLLER C3 (SPEC sec. 3): the three verbs the chat needs to do what the chat controller does today (profile chat only)
  { name: 'norn_show', profiles: CHAT, description: "Show a file or image inline in the owner's thread (the project root, its state, the briefs dir, run / lane worktrees and NOTES folders only).",
    schema: obj({ path: S.str('absolute path'), caption: S.str() }, ['path']), run: showTool },
  { name: 'norn_cli', profiles: CHAT, description: 'One allow-listed meta subcommand as an argument list (never a shell): ' + CLI_ALLOWED.filter(c => !c.startsWith('rec ')).join(', ') + ', rec <verb>. Norn sets the role, project and via.',
    schema: obj({ args: { type: 'array', items: S.str() } }, ['args']), run: cliTool },
  // the chat CLI's --permission-prompt-tool: the owner answers it (a card), never the model; extra fields of the CLI's call are kept
  { name: 'norn_approve', profiles: CHAT, description: 'The permission prompt of the chat CLI: waits for the OWNER to tap Approve once / Deny on a card (30 min, then deny). It is not yours to answer.',
    schema: { type: 'object', properties: { tool_name: S.str(), input: { type: 'object' }, tool_use_id: S.str() }, required: ['tool_name'] }, run: approveTool },
  // META-ADOPT A4 (SPEC meta-adopt sec. 5 MCP): thin front ends over the norn adopt verbs; decide / apply carry the human's words
  { name: 'norn_setup_status', profiles: SETUP, description: 'Is Norn set up here: machine.json, the projects, each one\'s setup draft (ADP-n) and its next step.',
    schema: obj({}), run: setupStatus },
  { name: 'norn_adopt_scan', profiles: SETUP, description: 'Look at a git repo (free, no model, writes nothing): commands with file:line, plans, branches, agent files, new / adopt.',
    schema: obj({ root: S.str('the repo path') }, ['root']), run: adoptScanTool },
  { name: 'norn_adopt_start', profiles: SETUP, description: 'Register the repo as a project when new (says what it writes), then draft: read true = one paid read-only run, false = facts only.',
    schema: obj({ root: S.str('the repo path'), read: S.bool, answers: { type: 'object', description: 'goal, month, first, tests, priority, never (all optional)' } }, ['root']), run: adoptStartTool },
  { name: 'norn_adopt_show', profiles: SETUP, description: 'The setup draft: the parts and their state; with part = its lines, each with its id and source.',
    schema: obj({ project: S.str('project name'), part: S.str('', { enum: PARTS }) }, ['project']), run: adoptShowTool },
  { name: 'norn_adopt_decide', profiles: SETUP, description: "Approve or skip one part as the HUMAN ruled it (owner_words verbatim; the profile is always the human's pick).",
    schema: obj({ project: S.str('project name'), part: S.str('', { enum: PARTS }), verdict: S.str('', { enum: ['approve', 'skip'] }), off: S.strs, on: S.strs,
      pick: S.str('the one line of a pick part (profile, first)'), owner_words: S.str("the human's sentence, verbatim") }, ['project', 'part', 'verdict']), run: adoptDecideTool },
  { name: 'norn_adopt_apply', profiles: SETUP, description: 'Write the approved parts (records + files beside project.json; never the repo, never the scheduler) on the human\'s words.',
    schema: obj({ project: S.str('project name'), owner_words: S.str("the human's sentence, verbatim") }, ['project']), run: adoptApplyTool },
];

// ---------- tool bodies: (args, ctx) -> { text, data } ----------
function write(ctx, ev, by = ctx.writer) {
  return record(ctx.state, { ...ev, by, data: { ...ev.data, via: ctx.via } }, { views: ctx.project?.views || {} });
}
const needProject = ctx => ctx.project || bad('this server has no project (start it with --project <project.json>)');
const st = ctx => loadState(ctx.state);

function pack(ctx, role) {
  if (role === 'adopt') return fs.readFileSync(SETUP_PROMPT, 'utf8');
  if (role === 'checkin') {
    if (!ctx.project) return fs.readFileSync(CHECKIN_PROMPT, 'utf8');
    const budgetFile = path.join(metaRoot(ctx.env), 'local', 'budget.json');
    const budget = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8').replace(/^﻿/, '')) : {};
    return fs.readFileSync(renderCheckin(ctx.project, { budgetFile, budget }), 'utf8');
  }
  const v = { project: ctx.project?.name || '(no project)', state: fwd(path.resolve(ctx.state)), norn: `node "${fwd(META_CLI)}"`, meta: `node "${fwd(META_CLI)}"`, records: fwd(RECORDS_DOC) };
  return fs.readFileSync(CONTROLLER_PROMPT, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? `{{${k}}}`);
}
function heartbeat(ctx) {
  const dir = path.join(ctx.state, 'mcp');
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, profile: ctx.profile, via: ctx.via, ts: new Date().toISOString() })); } catch { /* advisory */ }
}
function otherControllers(ctx) {
  const dir = path.join(ctx.state, 'mcp'), out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const f of names) {
    try { const h = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (h.pid !== process.pid && CONTROLLERS.includes(h.profile) && Date.now() - Date.parse(h.ts) < HB_FRESH_MS) out.push(h); } catch { /* skip */ }
  }
  return out;
}
function boot({ role }, ctx) {
  if (ctx.profile === 'checkin' && role !== 'checkin') bad('profile checkin boots only the checkin role');
  heartbeat(ctx);
  const items = Object.values(st(ctx).items);
  const runs = items.filter(i => i.kind === 'run');
  const lastCk = runs.filter(i => i.data.kind === 'checkin').at(-1);
  const resume = tryDigest(ctx.state, ctx.project || {});   // NORN-WATCH S1: the level-triggered resume digest
  const digest = { project: ctx.project?.name ?? null, needs_you: items.filter(needsYou).length, digest: digestIds(resume),
    running: runs.filter(i => i.state === 'running').map(i => ({ run: i.id, lane: i.data.lane ?? null, executor: i.data.executor ?? i.data.kind })),
    last_checkin: lastCk ? { run: lastCk.id, state: lastCk.state, ts: lastCk.history[0].ts } : null,
    other_controllers: otherControllers(ctx).map(h => ({ pid: h.pid, via: h.via, ts: h.ts })), pause: readPause(pauseFiles(ctx.state)) };   // RM-37: the mode in force (null = none)
  return { text: pack(ctx, role) + '\n\n## State digest\n' + JSON.stringify(digest, null, 1) + (resume ? '\n\n' + renderDigest(resume, { level: 2 }) : ''), data: { role, digest } };
}
function status(a, ctx) {
  if (a.project && a.project !== ctx.project?.name) bad(`this server serves ${ctx.project?.name ?? 'no named project'}, not ${a.project}`);
  if (a.view === 'plan') {
    const p = ctx.cliRun(['plan', '--json']);
    if (p.code) throw new ToolError(p.err || p.out, p.code);
    const plan = JSON.parse(p.out);
    return { text: formatPlan(plan), data: { plan } };
  }
  if (a.view === 'instructions') {   // META-INSTRUCTIONS R1: rides on norn_status (the controller profile is capped at 16 tools)
    if (!ctx.project) bad('view instructions needs a project (start the server with --project <project.json>)');
    const r = ctx.cliRun(['instructions', '--json']);
    if (r.code) throw new ToolError(r.err || r.out, r.code);
    const instructions = JSON.parse(r.out);
    return { text: formatInstructions(instructions), data: { instructions } };
  }
  const r = ctx.cliRun(['status']);
  if (r.code) throw new ToolError(r.err || r.out, r.code);
  const text = tail(path.join(ctx.state, 'STATUS.md'), 10000).split('\n').slice(0, 60).join('\n');
  return { text, data: { line: r.out } };
}
function inbox(a, ctx) {
  if (a.project && a.project !== ctx.project?.name) bad(`this server serves ${ctx.project?.name ?? 'no named project'}, not ${a.project}`);
  const s = st(ctx);
  const items = Object.values(s.items).filter(i => needsYou(i) && lastSeq(i) > (i.kind === 'run' ? a.since_runs_seq ?? -1 : a.since_seq ?? -1)).sort(order)
    .map(i => ({ id: i.id, kind: i.kind, state: i.state, why: needsYou(i), lane: i.data.lane ?? null, title: title(i) }));
  const cursor = { seq: s.seq, runs_seq: s.runs_seq };
  return { text: items.map(i => `${i.id}  ${i.why}  ${i.lane ?? '-'}  ${i.title}`).join('\n') + `\ncursor: since_seq=${cursor.seq} since_runs_seq=${cursor.runs_seq}`, data: { items, cursor } };
}
function records(a, ctx) {
  const kind = a.kind && kindNamed(a.kind);
  let rows = Object.values(st(ctx).items).filter(i => (!kind || i.kind === kind) && (!a.state || i.state === a.state) && (!a.id || i.id === a.id)
    && (!a.lane || i.data.lane === a.lane || i.id === laneId(a.lane, ctx.state))).sort(order);
  rows = rows.slice(-(a.limit ?? 50)).map(({ history, ...i }) => (a.id ? { ...i, history } : i));
  return { text: rows.map(i => `${i.id}  ${i.state}  ${i.data.lane ?? ''}  ${title(i)}`).join('\n') || '(none)', data: { rows } };
}
function answer(a, ctx) {
  guard(ctx, a.text, 'norn_answer');
  const e = write(ctx, { kind: 'question', ev: 'answer', id: a.q, data: { text: a.text, ...(a.choice !== undefined ? { choice: a.choice } : {}) } }, 'owner');
  return { text: `${e.id} answered`, data: { id: e.id, state: 'answered' } };
}
function directive(a, ctx) {
  guard(ctx, a.text, 'norn_directive');
  // gap #5: a restatement of an active directive is refused unless new: true (then it is kept out of the digest's duplicate rows)
  const dup = dupOf(st(ctx).items, a.text);
  if (dup && a.new !== true) throw new ToolError(dupMessage(dup, 'new: true'), 3);
  const e = write(ctx, { kind: 'directive', ev: 'create', data: { text: a.text, ...(a.scope ? { scope: a.scope } : {}), ...(a.expires ? { expires_utc: a.expires } : {}), ...(dup ? { distinct_from: [dup.id] } : {}) } }, 'owner');
  return { text: e.id, data: { id: e.id } };
}
function questionAdd(a, ctx) {
  const options = a.options.map(o => ({ key: o.key, text: o.text, cost: o.cost ?? '' }));
  const e = write(ctx, { kind: 'question', ev: 'create', data: { title: a.title, lane: a.lane, ...(a.body !== undefined ? { body: a.body } : {}), options,
    ...(a.recommend ? { recommend: { ...a.recommend, from: ctx.writer } } : {}), ...(a.class ? { class: a.class } : {}), blocks: a.blocks || [], ...(a.source ? { source: a.source } : {}), ...(a.owner_only !== undefined ? { owner_only: a.owner_only } : {}) } });
  return { text: e.id, data: { id: e.id } };
}
function decisionAdd(a, ctx) {
  const { notify, not_an_answer: na, ...rest } = a;
  const e = write(ctx, { kind: 'decision', ev: 'create', data: { ...rest, ...(notify ? { notify: true } : {}), ...(na ? { not_an_answer: true } : {}) } });
  return { text: e.id, data: { id: e.id } };
}
function recordEvent(a, ctx) {
  const kind = kindOfId(a.id) || bad(`${a.id} is not a record id (Q-n, DEC-n, DIR-n, L:name)`);
  if (kind === 'run') bad('run events are written by the launcher / norn_stop');
  const e = write(ctx, { kind, ev: a.event, id: a.id, data: a.fields || {} });
  return { text: `${e.id} ${st(ctx).items[e.id].state}`, data: { id: e.id, state: st(ctx).items[e.id].state } };
}
function startRunTool(a, ctx) {
  let ex = a.executor;
  if (!ex && a.class) {
    const p = needProject(ctx), budget = readBudget(ctx);
    ex = executorsFor(withDefaults(merged(budget, p.policy)).policy, a.class, Object.keys(providersOf(p)))[0] || bad(`no executor is allowed to do ${a.class} work`);
  }
  if (!ex) bad('executor or class is required');
  const args = ['run', '--executor', ex, '--lane', a.lane, '--brief', a.brief, '--via', ctx.via];
  if (a.class) args.push('--class', a.class);   // META-TEND P2: the class the run was routed by is stamped on it (basis given)
  for (const [k, f] of [['model', 'model'], ['effort', 'effort'], ['budget_min', 'budget-min'], ['parent', 'parent'], ['worktree', 'worktree'], ['notes', 'notes']]) if (a[k] !== undefined) args.push('--' + f, String(a[k]));
  const r = ctx.cliRun(args);
  if (r.code) throw new ToolError(r.code === 4 ? `cap: do it later (${r.out || r.err})` : (r.err || r.out), r.code);
  const m = r.out.match(/^STARTED (RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+) lane \S+ (\S+) (\S+) (\S+)/m) || [];
  return { text: r.out, data: { run: m[1], executor: m[2], model: m[3], effort: m[4] } };
}
function stop(a, ctx) {
  const r = ctx.cliRun(['stop', a.run, '--as', ctx.writer, '--why', a.why]);
  if (r.code) throw new ToolError(r.err || r.out, r.code);
  return { text: r.out, data: { run: a.run, state: 'killed' } };
}
// META-GTP-ASK (GT-PARITY-PLAN 2.6): the ask rides on norn_run_show - the controller profile is capped at 16 tools (tests/mcp.test.mjs)
function askTool(a, ctx) {
  if (!['checkin', ...CONTROLLERS].includes(ctx.profile)) bad(`ask is for the checkin / controller profiles, not ${ctx.profile}`);
  const args = ['ask', a.run, '--q', a.ask, ...(a.executor ? ['--executor', a.executor] : []), ...(a.max_s !== undefined ? ['--max-s', String(a.max_s)] : [])];
  const r = ctx.cliRun(args);
  if (![0, 5].includes(r.code)) throw new ToolError(r.code === 4 ? `cap: ${r.out || r.err}` : (r.err || r.out), r.code);
  const m = r.out.match(/^(RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+) asks \S+: (fork|cold)/m) || [];
  return { text: r.out, data: { run: a.run, ask_run: m[1] ?? null, mode: m[2] ?? null, code: r.code } };
}
function runShow(a, ctx) {
  if (a.ask !== undefined) return askTool(a, ctx);
  const it = st(ctx).items[a.run];
  if (!it || it.kind !== 'run') bad(`${a.run} does not exist`);
  const end = it.history.find(h => h.ev === 'end')?.data || {};
  const data = { run: it.id, state: it.state, outcome: end.outcome ?? null, reviewed: !!it.review, lane: it.data.lane ?? null, executor: it.data.executor ?? it.data.kind,
    model: it.data.model ?? null, usage: end.usage ?? null, notes: it.data.notes ?? null, log: it.data.log ?? null,
    log_tail: tail(it.data.log, a.log_tail ?? 20), notes_tail: tail(it.data.notes, a.notes_tail ?? 20) };
  const { log_tail, notes_tail, ...head } = data;
  return { text: JSON.stringify(head, null, 1) + (log_tail ? `\n--- log tail\n${log_tail}` : '') + (notes_tail ? `\n--- notes tail\n${notes_tail}` : ''), data };
}
function tickTool(a, ctx) {
  const p = needProject(ctx);
  const c = spawn(process.execPath, [META_CLI, 'tick', '--reason', a.reason, '--project', p.file], { detached: true, stdio: 'ignore', windowsHide: true, env: ctx.env });
  c.unref();
  return { text: `tick started (pid ${c.pid})`, data: { pid: c.pid } };
}
// RM-37: one tool for every pause (the controller profile is capped at 16 tools): the modes, a run's safe pause, pause half, resume
function pause(a, ctx) {
  const by = ctx.writer, asks = ['mode', 'runs', 'half', 'resume'].filter(k => a[k] !== undefined);
  if (asks.length !== 1) bad(`give exactly one of mode | runs | half | resume (got ${asks.join(', ') || 'none'})`);
  try {
    if (a.mode) { const p = setPause(ctx.state, { mode: a.mode, by, why: a.why }); return { text: `PAUSED: ${p.label} - ${PAUSE_MODES[p.mode].says}`, data: { pause: p } }; }
    if (a.half) { const pk = pickHalf(ctx.state, { n: a.n, nearEnd: nearEndMin(ctx.project?.policy) }); return { text: pk.line, data: pk }; }
    if (a.runs) { const r = pauseRuns(ctx.state, a.runs, { by, why: a.why }); return { text: r.map(x => (x.error ? `${x.run}: ${x.error}` : `PAUSE ${x.run}: order ${x.mail} sent`)).join('\n'), data: { runs: r } }; }
    if (a.resume === 'all') {
      const r = resumeAll(ctx.state, { by });
      return { text: `${r.cleared ? 'RELEASED ' + r.cleared.label : 'no pause to release'}${r.still ? `; still paused: ${r.still.label} (${r.still.file})` : ''}; ${r.resumed.length} paused hand-off(s) queued`, data: r };
    }
    const r = resumeRun(ctx.state, { run: a.resume, by });
    return { text: `RESUME ${r.run} queued as ${r.next}`, data: { ...r, pause: readPause(pauseFiles(ctx.state)) } };
  } catch (e) { if (e instanceof PauseError || e instanceof RecordError) bad(e.message); throw e; }
}
const budgetFile = ctx => path.join(metaRoot(ctx.env), 'local', 'budget.json');
function readBudget(ctx) { try { return JSON.parse(fs.readFileSync(budgetFile(ctx), 'utf8').replace(/^﻿/, '')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
// META-CONTROLLER C5: the chat Settings rows this server obeys, read on every call (a Settings save needs no restart of anything)
function chatSettings(ctx) {
  let b = {};
  try { b = withDefaults(readBudget(ctx)); } catch { /* an unreadable budget: the defaults */ }
  return { holdMin: Number.isInteger(b.chat_hold_min) && b.chat_hold_min > 0 ? b.chat_hold_min : HOLD_MIN, rawShell: ['off', 'ask', 'on'].includes(b.chat_raw_shell) ? b.chat_raw_shell : 'off' };
}
function settings(a, ctx) {
  const p = needProject(ctx), proj = JSON.parse(fs.readFileSync(p.file, 'utf8').replace(/^﻿/, '')), budget = readBudget(ctx);
  const extra = executorExtra(p), view = merged(budget, proj.policy);
  if (!a.set) {
    const rows = settingsView(view, extra);
    for (const k of a.get || []) if (!rows.some(r => r.key === k)) bad(`unknown setting ${k}`);
    const values = Object.fromEntries(rows.filter(r => !a.get || a.get.includes(r.key)).map(r => [r.key, r.value]));
    return { text: Object.entries(values).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n'), data: { values } };
  }
  if (!CONTROLLERS.includes(ctx.profile)) bad(`profile ${ctx.profile} may only read Settings`);
  let updated;
  const fc = floorChanges(view, { [a.set.key]: a.set.value }, extra), changes = fc.changes;   // the worker floor raises the settings it leaves below it
  try { updated = applySettings(view, changes, extra); } catch (e) { throw new ToolError(e.message, 2); }   // every applySettings throw is a 400
  const diff = Object.keys(changes).map(k => ({ key: k, from: getPath(withDefaults(view), k) ?? null, to: getPath(updated, k) }));
  const more = fc.raised.length ? `; raised to the worker minimum: ${fc.raised.map(r => `${r.key} ${r.from} -> ${r.to}`).join(', ')}` : '';
  if (a.dry_run) return { text: `dry run: ${a.set.key} ${JSON.stringify(diff[0].from)} -> ${JSON.stringify(diff[0].to)}${more}`, data: { diff, written: [] } };
  // the same writes as the dashboard's /api/settings: machine budget vs project policy, then the marked lines in policy targets
  const parts = split(onlyChanged(view, changes, updated)), written = [];   // META-PROFILE-BUG R1: the changed key only
  const atomic = (f, s) => { const t = f + '.tmp-' + process.pid; fs.writeFileSync(t, s); fs.renameSync(t, f); written.push(f); };
  if (JSON.stringify(parts.budget) !== JSON.stringify(budget)) { fs.mkdirSync(path.dirname(budgetFile(ctx)), { recursive: true }); atomic(budgetFile(ctx), JSON.stringify({ ...budget, ...parts.budget }, null, 2) + '\n'); }
  if (JSON.stringify(parts.policy) !== JSON.stringify(proj.policy ?? {})) atomic(p.file, JSON.stringify({ ...proj, policy: parts.policy }, null, 2) + '\n');
  const lines = generatedLines(updated, extra);
  for (const f of p.policy_targets || []) {
    let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const r = rewriteMarked(t, lines); if (r.changed.length) atomic(f, r.text);
  }
  const g = genAfterPolicy(p);   // DEC-362: the targets are regenerated from the sources, never written directly
  const gl = g.ran ? `; norn gen: ${g.lines.join('; ')}${g.problems.length ? `; PROBLEM ${g.problems.join('; PROBLEM ')}` : ''}` : `; ${g.why}`;
  return { text: `${a.set.key} ${JSON.stringify(diff[0].from)} -> ${JSON.stringify(diff[0].to)}${more}; wrote ${written.map(fwd).join(', ') || 'nothing'}${gl}`, data: { diff, written: written.map(fwd), gen: g } };
}
function ledger(a, ctx) {
  const p = needProject(ctx);
  if (!p.ledger) bad(`${p.name} has no ledger`);
  const lines = tail(p.ledger, a.tail ?? 40).split('\n').filter((l, i, arr) => arr.length > 1 || l);
  return { text: lines.join('\n'), data: { file: fwd(p.ledger), lines } };
}

function mailTool(a, ctx) {
  const run = ctx.env?.META_RUN_ID;
  if (!run) bad('norn_mail serves a supervised run: META_RUN_ID is not set');
  if (a.action === 'check') {
    const got = checkMail(ctx.state, { by: mailRole(ctx.state, ctx.env), run, via: 'mcp' });
    return { text: got.length ? got.map(formatMail).join('\n\n') : 'no new mail', data: { mail: got.map(m => ({ id: m.id, from: m.data.from, subject: m.data.subject, urgent: !!m.data.urgent, body: m.text })) } };
  }
  if (a.action === 'send') {
    for (const k of ['to', 'subject', 'body']) if (a[k] === undefined) bad(`send needs ${k}`);
    const e = sendMail(ctx.state, { by: mailRole(ctx.state, ctx.env), run, to: a.to, subject: a.subject, body: a.body, urgent: a.urgent });
    return { text: `${e.id} queued -> ${a.to}`, data: { id: e.id } };
  }
  if (a.id === undefined) bad('ack needs id');
  ackMail(ctx.state, { by: mailRole(ctx.state, ctx.env), run, id: a.id });
  return { text: `${a.id} acked`, data: { id: a.id } };
}

// ---------- META-ADOPT A4: the setup profile (machine-scoped; SPEC meta-adopt sec. 5 MCP) ----------
const machinePath = ctx => path.join(metaRoot(ctx.env), 'local', 'machine.json');
const dirKey = p => { const k = fwd(path.resolve(p)).replace(/\/+$/, ''); return process.platform === 'win32' ? k.toLowerCase() : k; };
/** machine.json and its projects loaded ({ name, config, p | null, error }) | null when Norn is not set up here */
function machineOf(ctx) {
  const file = machinePath(ctx), meta = metaRoot(ctx.env);
  if (!fs.existsSync(file)) return null;
  const m = loadMachine(file, { meta, home: ctx.env.USERPROFILE || ctx.env.HOME || undefined });
  return { file, projects: m.projects.map(pr => {
    const config = expandVars(pr.config, { norn: meta, home: m.home });
    try { return { name: pr.name, config, p: loadProject(config, { home: m.home, meta }), error: null }; } catch (e) { return { name: pr.name, config, p: null, error: e.message }; }
  }) };
}
const needMachine = ctx => machineOf(ctx) || bad(`no machine.json at ${fwd(machinePath(ctx))}: run \`norn setup\` in a terminal first (the install step; it asks before it installs anything)`);
function projectNamed(ctx, name) {
  const mm = needMachine(ctx), x = mm.projects.find(y => y.name === name);
  if (!x) bad(`no project ${name} (registered: ${mm.projects.map(y => y.name).join(', ') || 'none'}; norn_adopt_start {root} registers one)`);
  if (!x.p) bad(`${name}: ${x.error}`);
  return x.p;
}
function nextOf(p, prop) {
  if (!prop) return `norn_adopt_start {root: "${p.root}"}: draft its setup`;
  if (prop.state === 'open') return prop.undecided.length ? `review with the human: norn_adopt_show, then norn_adopt_decide for ${prop.undecided.join(', ')}` : 'every part is decided: norn_adopt_apply on the human\'s word';
  if (prop.state === 'applied') return 'set up: give it work (norn lane new, or the dashboard)';
  return 'closed: norn_adopt_start drafts it again';
}
function setupStatus(a, ctx) {
  const mm = machineOf(ctx);
  if (!mm) return { text: `Norn is not set up on this machine (no ${fwd(machinePath(ctx))}): run \`norn setup\` in a terminal first, then norn_adopt_scan {root}.`, data: { machine: false, projects: [], next: 'norn setup' } };
  const projects = mm.projects.map(x => {
    const prop = x.p ? proposalOf(x.p.state) : null;
    return { name: x.name, root: x.p?.root ?? null, ...(x.error ? { error: x.error } : {}), adopt: prop ? { id: prop.id, state: prop.state, undecided: prop.undecided } : null,
      next: x.p ? nextOf(x.p, prop) : `fix ${fwd(x.config)}: ${x.error}` };
  });
  const lines = [`machine ${fwd(mm.file)}: ${projects.length} project(s)`, ...projects.map(r => `${r.name}  ${r.root ?? '-'}  setup ${r.adopt ? `${r.adopt.id} ${r.adopt.state}` : 'not drafted'}  next: ${r.next}`)];
  if (!projects.length) lines.push('No project yet: norn_adopt_scan {root: "<repo path>"} looks at a repo (free, writes nothing); norn_adopt_start registers it and drafts its setup.');
  return { text: lines.join('\n'), data: { machine: true, file: fwd(mm.file), projects } };
}
function adoptScanTool({ root }, ctx) {
  let f;
  const sp = splitRepo(root);   // a folder of a monorepo: its own scan (project new makes it a project of that folder)
  try { f = scan(sp?.root || root, { subdir: sp?.subdir }); } catch (e) { if (e instanceof AdoptError) bad(e.message); throw e; }
  const qs = interviewOf(f), x = machineOf(ctx)?.projects.find(y => y.p && dirKey(projectHome(y.p)) === dirKey(root));
  const lines = [`${f.root}: ${f.path} (${f.path_why})`,
    `commands: ${f.commands.map(c => `${c.id} ${c.cmd} [${c.source}${c.ci ? '; CI ' + c.ci : ''}]`).join('; ') || 'none found'}`,
    `plans: ${f.plans.map(p => `${p.file} (${p.items} items)`).join(', ') || 'none'}; agent files: ${f.agent_files.map(a => a.file).join(', ') || 'none'}; branches in flight: ${f.branches.filter(b => !b.merged).length}`,
    ...qs.map(q => `question ${q.id}: ${q.text} (${q.why})`),
    `scan took ${f.scan_ms} ms; nothing was written. ${x ? `It is project ${x.name}.` : 'Not a project yet.'} Next: ask the human read or facts only, then norn_adopt_start.`];
  return { text: lines.join('\n'), data: { facts: f, questions: qs, project: x?.name ?? null } };
}
async function adoptStartTool(a, ctx) {
  let x = needMachine(ctx).projects.find(y => y.p && dirKey(projectHome(y.p)) === dirKey(a.root));
  const wrote = [];
  if (!x) {
    const err = [];
    try { if (projectNew({ root: a.root, nonInteractive: true, env: ctx.env, out: s => wrote.push(s), err: s => err.push(s) })) bad(err.join('\n') || wrote.join('\n')); } catch (e) { if (e instanceof SetupError) bad(e.message); throw e; }
    x = needMachine(ctx).projects.find(y => y.p && dirKey(projectHome(y.p)) === dirKey(a.root)) || bad(`registered, but no project has the root ${fwd(a.root)}`);
  }
  const p = x.p, args = ['adopt', 'draft', '--project', p.file, '--as', ctx.writer];
  for (const [k, v] of Object.entries(a.answers || {})) args.push('--answer', `${k}=${v}`);
  if (a.read !== undefined) args.push(a.read ? '--read' : '--no-read');
  const r = await ctx.cliRunAsync(args), head = wrote.length ? wrote.join('\n') + '\n' : '';
  const choose = r.code === 2 && /choose: (.*)/.exec(r.err);
  if (choose) return { text: `${head}Ask the human first. ${choose[1]}\nThen norn_adopt_start again with read: true (that read) or read: false (the free facts-only draft).`, data: { project: p.name, choose: true, consent: choose[1], wrote } };
  if (r.code) throw new ToolError(r.err || r.out, r.code);
  const id = /^(ADP-[\w-]+)/m.exec(r.out)?.[1] ?? null;
  return { text: `${head}${r.out}\nnext: norn_adopt_show {project: "${p.name}"}${a.read ? ' when the read has ended (minutes; it is capped)' : ''}`, data: { project: p.name, id, read: !!a.read, wrote } };
}
function adoptShowTool(a, ctx) {
  const p = projectNamed(ctx, a.project), prop = proposalOf(p.state);
  if (!prop) return { text: `${p.name} has no setup draft yet: norn_adopt_start {root: "${p.root}"}`, data: { project: p.name, id: null } };
  let lines = renderProposal(prop, { part: a.part });
  if (!a.part) lines = [...lines.filter(l => !/^ {4}\S/.test(l)), 'norn_adopt_show {project, part} lists the lines of one part.'];
  const parts = prop.parts.filter(x => !a.part || x.id === a.part).map(x => ({ id: x.id, title: x.title, status: x.applied ? 'applied' : x.status, ...(x.pick ? { pick: true } : {}),
    ...(x.empty ? { empty: x.empty } : {}), lines: a.part ? x.lines.map(l => ({ id: l.id, text: l.text, source: l.source, ...(l.already ? { already: true } : {}), ...(l.unverified ? { unverified: true } : {}) })) : x.lines.length }));
  return { text: lines.join('\n'), data: { project: p.name, id: prop.id, state: prop.state, path: prop.path, undecided: prop.undecided, parts } };
}
// elicitation (MCP 2025-06-18): when the client declared it, the server asks the HUMAN; null = not offered (or it failed): the verbatim rule stands
const canElicit = ctx => !!(ctx.clientCaps?.elicitation && ctx.request);
async function elicit(ctx, message, requestedSchema) {
  if (!canElicit(ctx)) return null;
  const m = await ctx.request('elicitation/create', { message, requestedSchema });
  return m.error || !m.result?.action ? null : m.result;
}
const SAID = { decline: 'declined', cancel: 'cancelled' };
const NO_WORDS = "owner_words is required: the human's own sentence, verbatim (never decide for them)";
async function adoptDecideTool(a, ctx) {
  const p = projectNamed(ctx, a.project);
  let pick = a.pick, words = a.owner_words;
  const prof = a.part === 'profile' && a.verdict === 'approve' && proposalOf(p.state)?.parts.find(x => x.id === 'profile');
  if (prof && canElicit(ctx)) {
    const r = await elicit(ctx, `Choose the caps profile for ${p.name}: it sets what Norn may spend. Apply never installs the scheduler.`,
      { type: 'object', properties: { profile: { type: 'string', title: 'Caps profile', enum: prof.lines.map(l => l.id), enumNames: prof.lines.map(l => l.text),
        ...(prof.lines.find(l => l.default) ? { default: prof.lines.find(l => l.default).id } : {}) } }, required: ['profile'] });
    // a client that cannot show the dialog (a headless run) cancels it: the pick stays the human's - offer the other two doors, never decide
    if (r && r.action !== 'accept') return { text: `the human was asked in a dialog and ${SAID[r.action] || r.action} the profile pick: nothing was decided. Ask them to pick in the dialog when you call again; `
      + `where no dialog can show, they pick it themselves: \`norn adopt approve profile --pick <id> --project ${p.file} --as owner\` in a terminal, or the dashboard.`, data: { decided: false, action: r.action } };
    if (r) { pick = r.content?.profile; words = `asked the human (elicitation): profile ${pick}`; }
  }
  if (!words) bad(NO_WORDS);
  let r;
  try { r = adoptDecide(p.state, { part: a.part, verdict: a.verdict, off: a.off, on: a.on, pick, by: 'owner', extra: { owner_words: words, via: ctx.via } }); } catch (e) { if (e instanceof AdoptError) bad(e.message); throw e; }
  const left = proposalOf(p.state).undecided;
  return { text: `${r.id} ${a.part}: ${a.verdict === 'approve' ? 'approved' : 'skipped'}${pick && a.verdict === 'approve' ? ` (${pick})` : ''}; ${left.length ? `to review: ${left.join(', ')}` : 'every part is decided: norn_adopt_apply on the human\'s word'}`,
    data: { id: r.id, part: a.part, verdict: a.verdict, ...(pick ? { pick } : {}), undecided: left } };
}
async function adoptApplyTool(a, ctx) {
  const p = projectNamed(ctx, a.project), root = metaRoot(ctx.env);
  let words = a.owner_words;
  try {
    if (canElicit(ctx)) {
      const dry = await adoptApply(p.state, { project: p, by: 'owner', dryRun: true, metaRoot: root });
      const r = await elicit(ctx, `Apply ${dry.id} to ${p.name}? It writes:\n${dry.lines.map(l => '- ' + l).join('\n')}`,
        { type: 'object', properties: { apply: { type: 'boolean', title: 'Apply now', default: false } }, required: ['apply'] });
      if (r && (r.action !== 'accept' || r.content?.apply !== true)) return { text: `the human ${SAID[r.action] || 'declined'} Apply: nothing was written${r.action === 'cancel' ? `. Where no dialog can show, they apply it themselves: \`norn adopt apply --project ${p.file} --as owner\` in a terminal, or the dashboard` : ''}`, data: { applied: false, action: r.action } };
      if (r) words = 'asked the human (elicitation): apply';
    }
    if (!words) bad(NO_WORDS);
    const r = await adoptApply(p.state, { project: p, by: 'owner', metaRoot: root, extra: { owner_words: words, via: ctx.via } });
    return { text: [...r.lines, `${r.id} ${r.complete ? 'applied' : 'partly applied (parts left to review: norn_adopt_show)'}`].join('\n'), data: { id: r.id, complete: r.complete, lines: r.lines } };
  } catch (e) { if (e instanceof AdoptError) bad(e.message); throw e; }
}

// ---------- prompts ----------
const PROMPTS = [
  { name: 'adopt', profiles: SETUP, description: 'Set a repository up for Norn: scan it, draft, review each part with the human, apply (the setup role pack).' },
  { name: 'controller', profiles: CTL, description: 'Steer the project as its controller (the controller role pack).' },
  { name: 'checkin', profiles: CK, description: 'One check-in pass (the check-in role pack).' },
];

// ---------- META-CONTROLLER C3: the chat profile - verbatim guard, norn_show / norn_cli / norn_approve, the tier gate ----------
// the verbatim guard (SPEC sec. 3): owner words are recorded only when the owner wrote them in this thread (profile chat; the other
// profiles keep the rule as prose in their role packs)
function guard(ctx, text, what) {
  if (ctx.profile !== 'chat') return;
  if (!ownerSaid(readThread(ctx.state).items, text)) bad(`${what} refused (verbatim guard): those are not the owner's own words in this thread - quote the owner's sentence exactly, or ask them to write it`);
}
const clip = (t, n) => (String(t).length > n ? String(t).slice(0, n) + ' ...' : String(t));
function showTool(a, ctx) {
  if (!path.isAbsolute(a.path) || /^[\\/]{2}/.test(a.path)) bad('path must be an absolute local path');
  const real = insideRoots(showRoots(ctx.state, ctx.project), a.path);
  if (!real) bad('outside the roots the chat may show (the project root, its state, the briefs dir, run / lane worktrees and NOTES folders)');
  let st; try { st = fs.statSync(real); } catch { bad(`${fwd(a.path)} does not exist`); }
  if (!st.isFile()) bad(`${fwd(a.path)} is not a file`);
  const image = /\.(png|jpe?g|webp|gif)$/i.test(real);
  let excerpt;
  if (!image) {
    const b = Buffer.alloc(Math.min(st.size, 65536)), fd = fs.openSync(real, 'r');
    try { fs.readSync(fd, b, 0, b.length, 0); } finally { fs.closeSync(fd); }
    if (b.includes(0)) bad('a binary file: the thread shows images and text only');
    excerpt = clip(b.toString('utf8'), 4000);
  }
  emit(ctx.state, { kind: 'show', path: fwd(real), caption: a.caption ?? null, image, ...(excerpt !== undefined ? { excerpt } : {}) });
  return { text: `shown in the thread: ${fwd(real)}`, data: { path: fwd(real), image } };
}
function cliTool(a, ctx) {
  const plan = cliPlan(a.args);
  if (plan.verbatim !== undefined) guard(ctx, plan.verbatim, 'norn lane new --task (an owner directive)');
  const argv = ['run --queue', 'lane claim', 'lane release'].includes(plan.sub) ? [...plan.argv, '--via', ctx.via] : plan.argv;
  const r = ctx.cliRun(argv, { META_ROLE: 'controller' });
  if (r.code) throw new ToolError(r.err || r.out || `norn ${plan.sub} exited ${r.code}`, r.code);
  return { text: r.out || `norn ${plan.sub}: done (no output)`, data: { sub: plan.sub, out: r.out } };
}
const tap = (ctx, o) => requestApproval(ctx.state, { ...o, ms: ctx.approvalMs ?? APPROVAL_MS, pollMs: ctx.pollMs, notifyFn: ctx.notifyFn });
const deniedWhy = v => (v.why === 'timeout' ? 'no tap from the owner in time: denied (the owner was pinged)' : 'denied by the owner');
async function approveTool(a, ctx) {
  // the CLI takes ONE text block holding the decision JSON (live 2.1.314: structuredContent beside it = "an invalid result")
  const t = promptTier(a.tool_name, chatSettings(ctx).rawShell), input = a.input ?? {}, answer = d => ({ text: JSON.stringify(d) });
  if (t.decide === 'allow') return answer({ behavior: 'allow', updatedInput: input });
  if (t.decide === 'deny') return answer({ behavior: 'deny', message: `${a.tool_name} is off in Norn's chat (tier 3: raw shell and file edits) - act through the Norn tools` });
  const v = await tap(ctx, { title: `${a.tool_name} needs your OK`, text: clip(JSON.stringify(input), 600), tool: a.tool_name });
  return answer(v.verdict === 'approve' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: deniedWhy(v) });
}
// what a tier-2 card says (a Settings change shows its diff first: a dry run)
function cardOf(t, a, ctx) {
  const who = ctx.project?.name ?? 'the project';
  if (t.name === 'norn_pause') return a.mode ? { title: `${PAUSE_MODES[a.mode].label}: ${who}`, text: PAUSE_MODES[a.mode].says } : a.runs ? { title: `Pause ${a.runs.join(', ')} safely`, text: 'Each gets an urgent order: finish the step, commit, hand off and end. Its hand-off waits for your resume.' }
    : a.resume === 'all' ? { title: `Resume all: ${who}`, text: 'The pause is released and every paused hand-off is queued, merges first.' } : { title: `Resume ${a.resume}`, text: 'Its hand-off is queued at the front.' };
  if (t.name === 'norn_settings') return { title: `Change setting ${a.set.key}`, text: settings({ ...a, dry_run: true }, ctx).text };
  if (t.name === 'norn_cli') return { title: `norn ${cliPlan(a.args).sub}`, command: 'norn ' + a.args.join(' '),
    text: a.args.includes('--batching') ? 'The merge-queue kill switch.' : 'Builds and gates a merge batch; its MERGE run moves main.' };
  return { title: t.name, text: clip(JSON.stringify(a), 600) };
}
// the done card of an act, with an Undo where the verb has one (SPEC sec. 8 C3: requeue / stop of a queued run / revoke)
function doneCard(t, a, r, ctx) {
  if (t.name === 'norn_directive') return emit(ctx.state, { kind: 'done', title: `${r.data.id} saved in your words`, lines: [a.text], undo: { verb: 'revoke', id: r.data.id } });
  if (t.name === 'norn_answer') return emit(ctx.state, { kind: 'done', title: `${a.q} answered in your words`, lines: [a.text] });
  if (t.name !== 'norn_cli') return undefined;
  const out = r.data.out ?? '', q = out.match(/^QUEUED (RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+)/m), rq = out.match(/^REQUEUED (RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+) -> (RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+)/m), d = out.match(/^directive (DIR-(?:[a-z][a-z0-9]{0,15}-)?\d+).*$/m);
  if (q) emit(ctx.state, { kind: 'done', title: `${q[1]} queued`, lines: [q.input.split('\n').find(l => l.startsWith('QUEUED'))], undo: { verb: 'stop', run: q[1] } });
  if (rq) emit(ctx.state, { kind: 'done', title: `${rq[1]} re-queued as ${rq[2]}`, lines: [rq[0]], undo: { verb: 'requeue', run: rq[2], from: rq[1] } });
  if (d) emit(ctx.state, { kind: 'done', title: `${d[1]} saved in your words`, lines: [d[0]], undo: { verb: 'revoke', id: d[1] } });
  return undefined;
}
/** profile chat: tier 0 / 1 run (an act leaves its done card), tier 2 waits for the owner's tap, tier 3 is refused */
function gated(t, a, ctx) {
  const tier = tierOf(t.name, a);
  if (tier >= 3) bad(`${t.name} is off in the chat (tier 3)`);
  if (tier < 2) {
    const r = t.run(a, ctx);
    if (typeof r?.then === 'function') return r;
    doneCard(t, a, r, ctx);
    return r;
  }
  return (async () => {
    const card = cardOf(t, a, ctx), v = await tap(ctx, { ...card, tool: t.name });
    if (v.verdict !== 'approve') throw new ToolError(`${card.title}: ${deniedWhy(v)} - nothing was done`, 2);
    const r = await t.run(a, ctx);
    emit(ctx.state, { kind: 'done', title: `Done after your OK: ${card.title}`, lines: String(r.text).split('\n').slice(0, 3) });
    return r;
  })();
}

// ---------- META-CONTROLLER C4 (SPEC sec. 2 item 1): a controller's act on a lane sets or extends its hold ----------
// the lane an act writes on (null = none / not a lane act); norn_cli lane claim / release are the hold itself
function actLane(name, a, ctx) {
  const ofId = id => (!id ? null : String(id).startsWith('L:') ? laneName(id, ctx.state) : st(ctx).items[id]?.data?.lane ?? null);
  if (['norn_run', 'norn_decision_add', 'norn_question_add'].includes(name)) return a.lane ?? null;
  if (name === 'norn_stop') return ofId(a.run);
  if (name === 'norn_answer') return ofId(a.q);
  if (name === 'norn_record_event') return ofId(a.id);
  if (name !== 'norn_cli') return null;
  const [c, s, x] = a.args, flag = f => { const i = a.args.indexOf(f); return i >= 0 ? a.args[i + 1] ?? null : null; };
  if (c === 'lane') return s === 'new' ? x ?? null : null;
  if (c === 'run') return flag('--lane');
  if (c === 'requeue') return ofId(s);
  if (c === 'rec') return s === 'add' ? flag('--lane') ?? (x === 'lane' ? flag('--name') : null) : ofId(x);
  return null;
}
const isoMin = min => new Date(Date.now() + min * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
function autoHold(t, a, ctx) {
  let lane = null;
  try { if (tierOf(t.name, a) < 1) return; lane = actLane(t.name, a, ctx); } catch { return; }
  const l = lane && st(ctx).items[laneId(lane, ctx.state)];
  if (!l || !KINDS.lane.events.claim.from.includes(l.state)) return;   // no LANE record (nothing to hold) or done / archived
  const h = holdOf(l), holder = ctx.profile === 'chat' ? 'chat' : 'controller';
  if (h?.holder === 'owner') return;   // your hold stays yours
  const min = chatSettings(ctx).holdMin;   // C5: Settings chat_hold_min (default 30)
  if (h && h.holder === holder && h.via === ctx.via && Date.parse(h.until) - Date.now() > Math.max(1, min - 5) * 60000) return;   // fresh: not re-recorded on every act
  try { write(ctx, { kind: 'lane', ev: 'claim', id: l.id, data: { until: isoMin(min), holder, why: `${t.name} on lane ${lane}` } }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; }   // the act stands; a hold that cannot be written is no reason to fail it
}

// ---------- JSON-RPC ----------
const errorResult = (msg, code) => ({ content: [{ type: 'text', text: `error (code ${code}): ${msg}` }], structuredContent: { code, error: msg }, isError: true });

export function handle(msg, ctx) {
  const { id, method, params = {} } = msg;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null;   // notifications (initialized, cancelled, ...) need no answer
  if (method === 'initialize') {
    ctx.clientCaps = params.capabilities || {};   // META-ADOPT A4: elicitation is used only when the client declares it
    const v = PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
    return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
      serverInfo: { name: 'norn', version: '1.0.0' }, instructions: ctx.profile === 'setup' ? 'norn setup server (machine-scoped). Start with norn_setup_status; the adopt prompt walks "set this repo up for Norn".'
        : `norn ${ctx.profile} server for ${ctx.project?.name ?? fwd(ctx.state)}. Start with norn_boot (or norn_status for workers).` });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS.filter(t => t.profiles.includes(ctx.profile)).map(t => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
  if (method === 'prompts/list') return ok({ prompts: PROMPTS.filter(p => p.profiles.includes(ctx.profile)).map(({ name, description }) => ({ name, description })) });
  if (method === 'prompts/get') {
    const p = PROMPTS.find(x => x.name === params.name && x.profiles.includes(ctx.profile));
    if (!p) return err(-32602, `unknown prompt ${params.name}`);
    return ok({ description: p.description, messages: [{ role: 'user', content: { type: 'text', text: pack(ctx, p.name) } }] });
  }
  if (method === 'tools/call') {
    const t = TOOLS.find(x => x.name === params.name);
    if (!t) return err(-32602, `unknown tool ${params.name}`);
    if (!t.profiles.includes(ctx.profile)) return ok(errorResult(`${t.name} is not in profile ${ctx.profile}`, 2));
    const failed = e => {
      if (e instanceof ToolError || e instanceof RecordError) return ok(errorResult(e.message, e.code));
      if (e instanceof ConfigError || e instanceof ActError) return ok(errorResult(e.message, 2));
      return ok(errorResult(`internal: ${e.message}`, 1));
    };
    const done = r => { if (CONTROLLERS.includes(ctx.profile)) heartbeat(ctx); return ok({ content: [{ type: 'text', text: r.text }], ...(r.data !== undefined ? { structuredContent: r.data } : {}) }); };
    try {
      const a = params.arguments ?? {};
      checkArgs(t.schema, a);
      const r = ctx.profile === 'chat' ? gated(t, a, ctx) : t.run(a, ctx);
      const held = x => { if (CONTROLLERS.includes(ctx.profile)) autoHold(t, a, ctx); return x; };
      return typeof r?.then === 'function' ? r.then(held).then(done, failed) : done(held(r));   // META-ADOPT A4: a setup tool may wait (a CLI verb, elicitation)
    } catch (e) { return failed(e); }
  }
  return err(-32601, `method not found: ${method}`);
}

/**
 * The tool context of one server. o: { state, project, profile, client, env, cli(argv, env, out, err) -> exit code } + for profile chat
 * { approvalMs (default 30 min), pollMs, notifyFn({ id, title, body }) (default: norn notify --class ask) }.
 */
export function context(o) {
  // setup (machine-scoped) writes as the controller acting in the human's chat; its decide / apply carry the human's words (norn_answer pattern)
  const writer = CONTROLLERS.includes(o.profile) || o.profile === 'setup' ? 'controller' : o.profile === 'checkin' ? 'checkin' : null;
  const where = o.project ? ['--project', o.project.file] : o.state ? ['--state', o.state] : [];
  const run = async (argv, extra = {}) => { const out = [], err = []; const code = (await o.cli([...argv, ...where], { ...o.env, ...extra }, s => out.push(s), s => err.push(s))) ?? 0; return { code, out: out.join('\n'), err: err.join('\n') }; };
  const ctx = { ...o, writer, via: `chat:${o.client}`,
    cliRun: (argv, extra = {}) => { const out = [], err = []; const code = o.cli([...argv, ...where], { ...o.env, ...extra }, s => out.push(s), s => err.push(s)) ?? 0; return { code, out: out.join('\n'), err: err.join('\n') }; },
    cliRunAsync: run };
  // timeout = deny + ping: an immediate notice (class ask), recorded by norn notify; its failure never changes the deny
  if (o.profile === 'chat' && !o.notifyFn) ctx.notifyFn = n => { try { o.cli(['notify', '--title', n.title, '--body', n.body, '--class', 'ask', ...where], o.env, () => {}, () => {}); } catch { /* best effort */ } };
  return ctx;
}

// Serve on stdin / stdout until stdin ends. o: see context().
export function serve(o, { input = process.stdin, output = s => process.stdout.write(s) } = {}) {
  const pending = new Map();
  let seq = 0;
  const ctx = context(o);
  // a request FROM the server (elicitation/create); its answer arrives on stdin as a response with this id
  ctx.request = (method, params) => new Promise(res => { const id = `meta-${++seq}`; pending.set(id, res); output(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  let buf = '';
  input.setEncoding('utf8');
  return new Promise(resolve => {
    input.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg, reply;
        try { msg = JSON.parse(line); } catch { output(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); continue; }
        if (msg && msg.method === undefined && pending.has(msg.id)) { const res = pending.get(msg.id); pending.delete(msg.id); res(msg); continue; }
        const internal = e => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message } });
        try { reply = handle(msg, ctx); } catch (e) { reply = internal(e); }
        Promise.resolve(reply).catch(internal).then(r => { if (r) output(JSON.stringify(r) + '\n'); });
      }
    });
    input.on('end', () => { try { if (ctx.state) fs.unlinkSync(path.join(ctx.state, 'mcp', `${process.pid}.json`)); } catch { /* none */ } resolve(0); });
  });
}
