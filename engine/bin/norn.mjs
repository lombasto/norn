#!/usr/bin/env node
// norn CLI (META-GENERAL-DESIGN 3.5). S1: `norn rec` - the only writer of records.jsonl.
// State dir: --state <dir> or env META_STATE. Role: --as <role> or env META_ROLE. Run id: env META_RUN_ID.
// Exit: 0 ok, 1 integrity / lock / refused view (`rec views`), 2 invalid input (with a usage line).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { record, loadState, kindOfId, kindNamed, KINDS, RecordError, launchedHere, holdOf, holdWho, hhmm, laneId, roleAddr, homeOf } from '../lib/records.mjs';
import { writeViews, writeQueueView } from '../lib/views.mjs';
import { readSources, runMigration, migrateMachine, MigrationError } from '../lib/migrate.mjs';
import { setup, doctor, projectAdd, projectNew, projectList, projectRemove, gen, SetupError, readLineSync } from '../lib/setup.mjs';
import { ConfigError, loadProject, loadMachine, metaRoot, expandLate, MOVED_SLOTS } from '../lib/config.mjs';
import { loadPlan, formatPlan } from '../lib/plan.mjs';
import { instructionsView, formatInstructions, formatSuggest, paragraphs, applySuggestion, discover } from '../lib/instructions.mjs';
import { auditScope, auditPrompt, auditStamp, writeStamp, auditsDir, auditsView, AUDIT_MODEL, AUDIT_EFFORT } from '../lib/audit.mjs';
import { FIX_LANE, fixBatch, fixPlan, fixerBrief, fixerPrompt, fixerDir, findingsFile, readRunBrief } from '../lib/fixer.mjs';
import { resultDir, writeResult, ResultError } from '../lib/result.mjs';
import { openCards } from '../lib/rules.mjs';
import os from 'node:os';
import { readyGate } from '../lib/dod.mjs';
import { critiqueHolds, critiqueSkip, critiqueFiles, critiquePrompt, classExecutor } from '../lib/critique.mjs';
import { startRun, stopRun, requeueRun, fillQueue, queueOf, readiness, FILL_DEFAULTS, RunRefused, RunError, laneWriter, normWt, duplicateOf } from '../lib/runs.mjs';
import { parseAfter, parseInputs, AfterError, makeEval, readyWords } from '../lib/after.mjs';
import { loadEpics, epicMembers, epicStatus, checkMembers, EpicError } from '../lib/epics.mjs';
import { loadRoadmap, buildTree, renderTree, renderItem, renderAudit, auditOf, itemsOf, findNode, checkLinks, planEvents, refTerm, writeRoadmapView, roadmapViewPath, RoadmapError, world, reach } from '../lib/roadmap.mjs';
import { stuckRefusal, readStuck, reviewBrief, replayLines } from '../lib/stuck.mjs';
import { proposalsOf, openStage, queueArgv, laterItem, pickDecision, renderProposals, PICKS } from '../lib/proposals.mjs';
import { lookItemsFor, lookBriefRefusal } from '../lib/look.mjs';
import { scan, importLegacy, renderImport, adoptStart, adoptDecide, adoptApply, adoptClose, proposalOf, renderProposal, AdoptError, interviewOf, laneNameOf, readExecutor, readStart, readWait, consentLine, ANSWER_KEYS } from '../lib/adopt.mjs';
import { loadFlow, startFlow, flowStatus, resumeFlow, FlowError, FLOWS_DIR } from '../lib/flows.mjs';
import { providersOf, typedExe, executorInfo } from '../lib/executors.mjs';
import { launchParts, refillOf, agentRefusal } from '../lib/launchpolicy.mjs';
import { launchArgsRefusal } from '../lib/launchargs.mjs';
import { loginCommand } from '../lib/authguard.mjs';
import { presetExe } from '../lib/presets.mjs';
import { capsMatrix, formatCapsMatrix } from '../lib/harness/index.mjs';
import { openLimits, limitKey } from '../lib/limitgate.mjs';
import { runProbe } from '../lib/probe.mjs';
import { writeStatus, weeklyEstimate, accountCacheR, crTotal } from '../lib/status.mjs';
import { weekStart, parseReset } from '../lib/cost.mjs';
import { digest, tryDigest } from '../lib/digest.mjs';
import { running } from '../lib/legacy.mjs';
import { projectOverlap, overlapOn, overlapText } from '../lib/overlap.mjs';
import { renderDigest } from '../lib/views.mjs';
import { tick, quietFlag } from '../lib/tick.mjs';
import { POLICY_DEFAULTS, withDefaults, applySettings, floorChanges, merged, split, writeBudget, capsMissing, slopOn, syncPolicy } from '../lib/policy.mjs';
import { CLASS_LABELS } from '../lib/workclass.mjs';
import { adapterFor, schedState, liveName, oldTasks, schedApply } from '../lib/sched/index.mjs';
import { serve, refusal } from '../lib/mcp.mjs';
import { installPlan, applyPlan, FAMILIES } from '../lib/harness.mjs';
import { writeDash, clearDash, dashRestart, DashError } from '../lib/dashlive.mjs';
import { remoteSetup, remoteOff } from '../lib/remote.mjs';
import { fwd } from '../lib/config.mjs';
import { newLane, lanePaths, LaneError } from '../lib/lanenew.mjs';
import { renderMergeBrief, shotsMode, briefMarker } from '../lib/mergebrief.mjs';
import { openProjectPrs, prLine, LAND_EXIT } from '../lib/mergeland.mjs';
import { isMergeStage } from '../lib/usageguard.mjs';
import { delegateStart, delegateWait, ASK_MAX_S } from '../lib/delegate.mjs';
import { askStart, askWait } from '../lib/ask.mjs';
import { loadDeliverables, deliverablesView, backfillPlan, applyBackfill, formatBackfill, formatDeliverable, askDeliverable, resolveDeliverable, createResolveWorktree, liveResolve } from '../lib/deliverables.mjs';
import { makeGit } from '../lib/dlvgit.mjs';
import { mergeQueue, formatMq, updatePass, mergeqRun, mqSummary, setBatching, mergeConfig } from '../lib/mergeq.mjs';
import { subdirOf, splitRepo, projectHome } from '../lib/monorepo.mjs';
import { evalCmd, EVAL_USAGE } from '../lib/eval/cli.mjs';
import { ledgerConfig, ledgerStatus, ledgerLog, ledgerRestore } from '../lib/ledger.mjs';
import { publishHome, fetchHomes, syncStatus, homeIdOf } from '../lib/sync.mjs';
import { cv, cvPart, renderWindow, renderCv, writeCvView, CV_BY } from '../lib/cv.mjs';
import { sendMail, checkMail, ackMail, listMail, formatMail, injectJson, mailRole } from '../lib/mail.mjs';
import { ctxOrder } from '../lib/ctxlimit.mjs';
import { isMain } from '../lib/paths.mjs';
import { shot, parseShotArgs, ShotError, SHOT_USAGE } from '../lib/shot.mjs';
import { parseLabels, servedLabels, FedError, fedOf, fetchForeign, hostName } from '../lib/fed.mjs';
import { ClaimsError } from '../lib/claimsref.mjs';
import { syncCut, cutLines, HOME_RE } from '../lib/synccut.mjs';
import { listClaims, allowPair, releaseWork, takeWork, observeClaims, readSync, updateSync, writeSync } from '../lib/claims.mjs';
import { nodeRun } from '../lib/fednode.mjs';
import { guardScan, guardWatch, openGuards, formatGuard, contextSources, GUARD_ACTIONS, SOURCES_METHOD, M as mTok } from '../lib/guard.mjs';
import { runTranscript, transcriptTrace } from '../lib/standing.mjs';
import { stageSizes, verdict, sizingThresholds } from '../lib/sizing.mjs';
import { usageWeek, formatUsageWeek } from '../lib/usageweek.mjs';
import { slopCmd } from '../lib/slop/cli.mjs';
import { testsCmd } from '../lib/testscli.mjs';
import { findingLine } from '../lib/slop/host.mjs';
import { doorCheck, doorWhy } from '../lib/slop/door.mjs';
import { scopeCheck, denyJson } from '../lib/scope.mjs';
import { dupOf, dupMessage } from '../lib/dupdirs.mjs';
import { sourceQuestion, SourceError } from '../lib/qsource.mjs';
import { BILLING_MODES, BILLING_NAMES, billingChanges, billingLine, isApi, usdCap } from '../lib/billing.mjs';
import { PauseError, setPause, pauseRuns, pickHalf, nearEndMin, resumeRun, resumeAll, pausedHandoffs } from '../lib/pause.mjs';
import { PAUSE_MODES, pauseFiles, readPause } from '../lib/pausemode.mjs';

const USAGE = {
  'add question': 'norn rec add question --lane L --title T [--body TEXT | --body-file F] [--from-source "<file>#<section>"] [--option "key|text|cost"]... [--recommend "key|why"] [--class i..v] [--blocks a,b] [--source S] [--owner-only]    (list every real alternative - 3-4 where they exist; never trim to two, never pad with a fake one. --from-source copies every alternative the section lists, verbatim, and records the file + section; an --option next to it is marked "added by <you>")',
  'add decision': 'norn rec add decision --lane L --question Q --choice C --why W [--cost C] [--source S] [--answers Q-n --owner-words "<owner words, verbatim>" | --not-an-answer] [--notify] [--on-runs RUN-1,RUN-2] [--approach-review RM-n]    (exit 3 = an owner pick on a lane with an open Q: name it with --answers, or --not-an-answer)',
  'add directive': 'norn rec add directive --text T --via dashboard|talk|chat [--scope a,b] [--expires UTC] [--new]    (owner contexts only; exit 3 = it restates an active DIR: supersede that one, or --new to create anyway)',
  'add waiver': 'norn rec add waiver --rule K2 --scope <fingerprint | path glob> --why W [--until ISO] [--q Q-n]    (owner / controller: a slop finding that may stay; a check-in only with --q, the answered Q whose ruling is the waiver)',
  'add lane': 'norn rec add lane --name N [--worktree W] [--notes F] [--branch B] [--brief-dir D] [--stage S] [--round-estimate R] [--executor-hint E] [--item RM-n (links lane:N to the roadmap item)]',
  answer: 'norn rec answer Q-n --text "<owner words>" --via dashboard|chat [--choice key]  |  norn rec answer Q-n --from DEC-m (the owner words the DEC recorded; + apply)  |  norn rec answer --each "Q-50=a,Q-51=b" --text "<owner words>" --via chat',
  say: 'norn rec say Q-n --text "<owner words>" --via dashboard|chat    (the owner message on an open Q: the Q stays open, the controller replies in its thread)',
  reply: 'norn rec reply Q-n --text T [--option "key|text|cost"]... [--recommend "key|why"] [--propose "key|ruling"]    (the controller in the thread of a Q: --option revises the whole option list, --propose = a ruling from the owner words the owner confirms with one tap; key may be empty)',
  apply: 'norn rec apply Q-n --refs DEC-n,RUN-n',
  'not-an-answer': 'norn rec not-an-answer DEC-m --q Q-n [--why W]    (the DEC is not the answer to Q-n: the digest / Inbox stop pointing at it)',
  supersede: 'norn rec supersede ID --by ID --why W',
  withdraw: 'norn rec withdraw Q-n [--why W]',
  reopen: 'norn rec reopen Q-n',
  overrule: 'norn rec overrule DEC-n --text T [--rework-lane L]',
  done: 'norn rec done DIR-n --refs X,Y | norn rec done L:name',
  revoke: 'norn rec revoke DIR-n',
  park: 'norn rec park L:name --why W [--q Q-n]',
  unpark: 'norn rec unpark L:name',
  archive: 'norn rec archive L:name',
  unarchive: 'norn rec unarchive L:name',
  list: 'norn rec list [--open] [--kind Q|DEC|DIR|L|RUN] [--lane x] [--json]',
  show: 'norn rec show ID [--json] [--full]    (a long id list prints as its first ids + a count; --full prints all)',
  views: 'norn rec views',
};
const COMMON = ['state', 'project', 'as'];
const FLAGS = {
  'add question': ['lane', 'title', 'body', 'body-file', 'from-source', 'option*', 'recommend', 'class', 'blocks', 'source', 'owner-only!'],
  'add decision': ['lane', 'question', 'choice', 'why', 'cost', 'source', 'answers', 'owner-words', 'not-an-answer!', 'notify!', 'on-runs', 'approach-review'],
  'add directive': ['text', 'via', 'scope', 'expires', 'new!'],
  'add waiver': ['rule', 'scope', 'why', 'until', 'q'],
  'add lane': ['name', 'worktree', 'notes', 'branch', 'brief-dir', 'stage', 'round-estimate', 'executor-hint', 'item'],
  answer: ['text', 'via', 'choice', 'each', 'from'], say: ['text', 'via'], reply: ['text', 'option*', 'recommend', 'propose'], apply: ['refs'], 'not-an-answer': ['q', 'why'], supersede: ['by', 'why'], withdraw: ['why'], reopen: [],
  overrule: ['text', 'rework-lane'], done: ['refs'], revoke: [], park: ['why', 'q'], unpark: [], archive: [], unarchive: [],
  list: ['open!', 'kind', 'lane', 'json!'], show: ['json!', 'full!'], views: [],
};
const ALL_USAGE = 'usage: norn rec <add question|add decision|add directive|add lane|add waiver|answer|say|reply|apply|not-an-answer|supersede|withdraw|reopen|overrule|done|revoke|park|unpark|archive|unarchive|list|show|views> ...';

class Usage extends Error { constructor(msg, cmd) { super(msg); this.cmd = cmd; } }

// META-UX-BUILD S7: `rec show` without --full - a long id list (a Fix all directive holds hundreds) = its first ids + a count, a long
// text = its head + a count; a check-in reads what the record is, never the whole list
const SHOW_IDS = 5, SHOW_CHARS = 400;
export function shortData(d) {
  const one = v => (Array.isArray(v) && v.length > SHOW_IDS * 2 ? [...v.slice(0, SHOW_IDS).map(one), `+${v.length - SHOW_IDS} more (--full prints all)`]
    : typeof v === 'string' && v.length > SHOW_CHARS ? `${v.slice(0, SHOW_CHARS)}... (+${v.length - SHOW_CHARS} chars, --full prints all)`
      : v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, one(x)])) : v);
  return one(d);
}
function parse(cmd, argv) {
  const spec = [...FLAGS[cmd], ...COMMON];
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const name = a.slice(2), s = spec.find(f => f.replace(/[*!]$/, '') === name);
    if (!s) throw new Usage(`unknown flag --${name}`, cmd);
    if (s.endsWith('!')) { flags[name] = true; continue; }
    if (i + 1 >= argv.length) throw new Usage(`--${name} needs a value`, cmd);
    const v = argv[++i];
    if (s.endsWith('*')) (flags[name] ||= []).push(v); else flags[name] = v;
  }
  return { flags, pos };
}

const csv = v => v === undefined ? undefined : v.split(',').map(s => s.trim()).filter(Boolean);
const drop = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const optionsOf = (f, cmd) => (f.option || []).map(o => {
  const [key, text, cost = ''] = o.split('|');
  if (!key || text === undefined) throw new Usage(`--option must be "key|text|cost" (got ${JSON.stringify(o)})`, cmd);
  return { key: key.trim(), text: text.trim(), cost: cost.trim() };
});
const recommendOf = (f, cmd, by) => {
  if (f.recommend === undefined) return undefined;
  const i = f.recommend.indexOf('|');
  if (i < 1) throw new Usage('--recommend must be "key|why"', cmd);
  return { key: f.recommend.slice(0, i).trim(), why: f.recommend.slice(i + 1).trim(), from: by };
};
function addData(what, f, cmd, by) {
  if (what === 'question') {
    let options = optionsOf(f, cmd), recommend = recommendOf(f, cmd, by), origin, source = f.source;
    if (f['from-source'] !== undefined) {   // INBOX-REPLIES (6a): every alternative the section names, verbatim; the writer's own marked
      let q;
      try { q = sourceQuestion(f['from-source']); } catch (e) { if (e instanceof SourceError) throw new Usage(e.message, cmd); throw e; }
      const taken = new Set(q.options.map(o => o.key));
      for (const o of options) if (taken.has(o.key)) throw new Usage(`--option ${o.key}: the source already has an option ${o.key} (${q.options.find(x => x.key === o.key).text}) - pick another key`, cmd);
      options = [...q.options, ...options.map(o => ({ ...o, added_by: by }))];
      recommend ??= q.recommend; origin = q.origin; source ??= `${q.origin.file}#${q.origin.section}`;
    }
    const body = f['body-file'] !== undefined ? fs.readFileSync(f['body-file'], 'utf8') : f.body;
    return drop({ title: f.title, lane: f.lane, body, options, recommend, class: f.class, blocks: csv(f.blocks) || [], source, origin, owner_only: f['owner-only'] ? true : undefined });
  }
  if (what === 'decision') return drop({ lane: f.lane, question: f.question, choice: f.choice, why: f.why, cost: f.cost, source: f.source, answers: f.answers, owner_words: f['owner-words'], not_an_answer: f['not-an-answer'] ? true : undefined, notify: f.notify ? true : undefined, on_runs: csv(f['on-runs']), approach_review: f['approach-review'] });
  if (what === 'directive') return drop({ text: f.text, via: f.via, scope: csv(f.scope), expires_utc: f.expires });
  if (what === 'waiver') return drop({ rule: f.rule, scope: f.scope, why: f.why, until: f.until });
  if (what === 'lane') return drop({ name: f.name, worktree: f.worktree, notes: f.notes, branch: f.branch, brief_dir: f['brief-dir'], stage: f.stage, round_estimate: f['round-estimate'], executor_hint: f['executor-hint'] });
  throw new Usage(`unknown kind ${what}`, cmd);
}

function eventData(ev, f, by) {
  switch (ev) {
    case 'answer': return drop({ choice: f.choice, text: f.text, via: f.via, from: f.from });
    case 'say': return drop({ text: f.text, via: f.via });
    case 'reply': {
      let propose;
      if (f.propose !== undefined) { const i = f.propose.indexOf('|'); if (i < 0) throw new Usage('--propose must be "key|ruling" (key may be empty)', 'reply'); propose = drop({ key: f.propose.slice(0, i).trim() || undefined, text: f.propose.slice(i + 1).trim() }); }
      return drop({ text: f.text, options: f.option ? optionsOf(f, 'reply') : undefined, recommend: recommendOf(f, 'reply', by), propose });
    }
    case 'not-an-answer': return drop({ q: f.q, why: f.why });
    case 'apply': case 'done': return drop({ refs: csv(f.refs) });
    case 'supersede': return drop({ by: f.by, why: f.why });
    case 'withdraw': return drop({ why: f.why });
    case 'overrule': return drop({ text: f.text, rework_lane: f['rework-lane'] });
    case 'park': return drop({ why: f.why, q: f.q });
    default: return {};
  }
}

const isOpen = i => (i.kind === 'question' && ['open', 'answered'].includes(i.state)) || (i.kind === 'directive' && i.state === 'active')
  || (i.kind === 'lane' && i.state === 'parked') || (i.kind === 'run' && (i.state === 'queued' || (['exited', 'lost', 'killed'].includes(i.state) && !i.review)));
const KIND_ORDER = ['question', 'decision', 'directive', 'lane', 'run'];
const order = (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.kind === 'lane' ? a.id.localeCompare(b.id) : Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
const title = i => i.data.title ?? i.data.question ?? i.data.text ?? i.data.lane ?? i.data.name ?? i.data.kind ?? '';

function warnViews(v, err) {
  for (const p of v.refused) err(`warning: hand-edited view ${p} was NOT regenerated - the dashboard Inbox offers "Let Norn take it back" (a .bak keeps your text) or "Keep my version"; or revert it`);
}

// NORN-WATCH S3: one chat reply -> named Q answers. One answer event per Q (all-or-nothing), mapped_from = the shared owner text,
// echoed back so the owner sees what was recorded (undo = norn rec reopen Q-n, then a fresh answer).
function answerEach(state, f, pos, by, vpaths, out, err) {
  if (pos.length) throw new Usage('--each replaces the Q-n argument', 'answer');
  if (f.choice !== undefined) throw new Usage('--each carries the choices (Q-n=key); drop --choice', 'answer');
  const pairs = f.each.split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const m = /^(Q-(?:[a-z][a-z0-9]{0,15}-)?\d+)=(\S+)$/.exec(x);
    if (!m) throw new Usage(`--each wants "Q-n=key,..." (got ${JSON.stringify(x)})`, 'answer');
    return [m[1], m[2]];
  });
  if (!pairs.length) throw new Usage('--each is empty', 'answer');
  if (new Set(pairs.map(p => p[0])).size !== pairs.length) throw new Usage('--each names a Q twice', 'answer');
  const items = loadState(state).items;
  for (const [id, key] of pairs) {   // name the Q in the error (the records core checks the same again inside the batch)
    const opts = items[id]?.data?.options || [];
    if (items[id] && opts.length && !opts.some(o => o.key === key)) throw new RecordError(`${id}: choice ${key} is not one of ${opts.map(o => o.key).join(' | ')}`, 2);
  }
  let views = { refused: [] };
  record(state, pairs.map(([id, choice]) => ({ kind: 'question', ev: 'answer', id, by, data: drop({ choice, text: f.text, via: f.via, mapped_from: f.text }) })),
    { views: vpaths, onViews: v => { views = v; } });
  const opt = (id, key) => items[id].data.options?.find(o => o.key === key)?.text;
  out('Recorded: ' + pairs.map(([id, key]) => `${id} ${items[id].data.title} = ${key}${opt(id, key) ? ` (${opt(id, key)})` : ''}`).join('; ') + ". Say 'no' to undo.");
  warnViews(views, err);
  return 0;
}

const MIGRATE_USAGE = 'usage: norn migrate [--machine F] [--dry-run]    (local/machine.json -> the current shape)\n       norn migrate --src <old meta controller dir> [--decisions DECISIONS-LOG.md] --state <empty dir> [--budget-out F] [--project-out F] [--project NAME] [--now UTC] [--dry-run]';
function migrateCmd(argv, env, out, err) {
  const f = {};
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i], name = a.replace(/^--/, '');
      if (name === 'dry-run') { f[name] = true; continue; }
      if (!a.startsWith('--') || !['src', 'decisions', 'state', 'budget-out', 'project-out', 'project', 'now', 'machine'].includes(name)) throw new MigrationError(`unknown argument ${a}`);
      if (i + 1 >= argv.length) throw new MigrationError(`${a} needs a value`);
      f[name] = argv[++i];
    }
    if (!f.src) {   // no --src: the machine file (default <META_ROOT>/local/machine.json)
      const other = Object.keys(f).filter(k => !['machine', 'dry-run'].includes(k));
      if (other.length) throw new MigrationError(`--${other[0]} needs --src`);
      const mf = fwd(f.machine || path.join(metaRoot(env), 'local', 'machine.json'));
      for (const l of migrateMachine(mf, { dryRun: !!f['dry-run'], moved: MOVED_SLOTS })) out(l);
      return 0;
    }
    if (f.machine) throw new MigrationError('--machine and --src are separate migrations');
    const state = f.state || env.META_STATE;
    if (!state && !f['dry-run']) throw new MigrationError('no state dir: pass --state <dir> or set META_STATE');
    const now = f.now ? new Date(f.now) : new Date();
    if (Number.isNaN(now.getTime())) throw new MigrationError(`--now ${f.now} is not a date`);
    const res = runMigration(readSources(f.src, { decisions: f.decisions }), { state, budgetOut: f['budget-out'], projectOut: f['project-out'], project: f.project || (state ? path.basename(state) : 'legacy'), now: () => now, dryRun: !!f['dry-run'] });
    out(res.table.trimEnd());
    return 0;
  } catch (e) {
    if (e instanceof MigrationError || (e instanceof RecordError && e.code === 2) || e.code === 'ENOENT') { err('error: ' + e.message); err(MIGRATE_USAGE); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

const SETUP_USAGE = {
  setup: 'norn setup [--non-interactive] [--project <project.json>]... [--no-scheduler] [--profile try-it|solo|heavy] [--cost cheap|balanced|quality] [--notify ntfy|toast|desktop|pushover|none [--ntfy-server URL] [--no-test-ping]] [--force (write the launchers even from a linked git worktree)]    (engine root: env META_ROOT, default this repo)',
  doctor: 'norn doctor | norn doctor --probe <executor> [--project <project.json>]',
  project: 'norn project add <project.json> | norn project list [--json] | norn project remove <name> [--purge-state] [--dry-run] | norn project new [--root <repo | a folder of it>] [--subdir <folder>] [--name n] [--title t] [--branch b] [--ci owner/repo|none] [--executors a,b] [--profile p] [--cost c] [--dir D] [--notify ntfy|toast|desktop|pushover|none [--ntfy-server URL] [--no-test-ping]] [--non-interactive] [--no-register] [--print]',
  gen: 'norn gen [--check] [--project <project.json>]    (regenerate / drift-check every harness target)',
};
// metaexec X1: one minimal request through <name>'s command line; the entry comes from --project or the first machine project naming it
function probeCmd(args, env, out) {
  const [name, ...more] = args;
  if (!name || name.startsWith('-')) throw new SetupError('--probe needs an executor name');
  let pf = null;
  if (more.length) { if (more[0] !== '--project' || more.length !== 2) throw new SetupError('unexpected ' + more[0]); pf = more[1]; }
  const meta = metaRoot(env), mf = path.join(meta, 'local', 'machine.json');
  const machine = fs.existsSync(mf) ? loadMachine(mf, { meta }) : null;
  const files = pf ? [pf] : (machine?.projects || []).map(p => p.config);
  const entry = files.map(f => loadProject(f, { meta }).executors?.[name]).find(Boolean) || {};
  return runProbe({ name, entry, machine, env, out });
}
function setupCmd(argv, env, out, err) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'setup') {
      const o = { nonInteractive: false, noScheduler: false, projects: [] };
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--non-interactive') o.nonInteractive = true;
        else if (a === '--no-scheduler') o.noScheduler = true;
        else if (a === '--project' && i + 1 < rest.length) o.projects.push(rest[++i]);
        else if ((a === '--profile' || a === '--cost' || a === '--notify') && i + 1 < rest.length) o[a.slice(2)] = rest[++i];
        else if (a === '--ntfy-server' && i + 1 < rest.length) o.ntfyServer = rest[++i];
        else if (a === '--no-test-ping') o.noTestPing = true;
        else if (a === '--force') o.force = true;
        else throw new SetupError('unexpected ' + a);
      }
      return setup({ ...o, env, out, err });
    }
    if (cmd === 'doctor' && rest[0] === '--probe') return probeCmd(rest.slice(1), env, out);
    if (cmd === 'gen') {
      const o = { check: false, project: null };
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--check') o.check = true;
        else if (rest[i] === '--project' && i + 1 < rest.length) o.project = rest[++i];
        else throw new SetupError('unexpected ' + rest[i]);
      }
      return gen({ ...o, env, out, err });
    }
    if (cmd === 'doctor') { if (rest.length) throw new SetupError('unexpected ' + rest[0]); return doctor({ env, out }); }
    if (rest[0] === 'new') {
      const NEW = ['root', 'subdir', 'name', 'title', 'branch', 'ci', 'executors', 'dir', 'profile', 'cost', 'notify', 'ntfy-server'], o = { nonInteractive: false, register: true, print: false };
      for (let i = 1; i < rest.length; i++) {
        const a = rest[i], k = a.replace(/^--/, '');
        if (a === '--non-interactive') o.nonInteractive = true;
        else if (a === '--no-register') o.register = false;
        else if (a === '--print') o.print = true;
        else if (a === '--no-test-ping') o.noTestPing = true;
        else if (a.startsWith('--') && NEW.includes(k) && i + 1 < rest.length) o[k] = rest[++i];
        else throw new SetupError('unexpected ' + a);
      }
      return projectNew({ ...o, env, out, err });
    }
    if (rest[0] === 'list') {
      if (rest.length > 2 || (rest[1] && rest[1] !== '--json')) throw new SetupError('unexpected ' + rest[1]);
      return projectList({ json: rest[1] === '--json', env, out });
    }
    if (rest[0] === 'remove') {
      const o = { name: null, purgeState: false, dryRun: false };
      for (const a of rest.slice(1)) {
        if (a === '--purge-state') o.purgeState = true; else if (a === '--dry-run') o.dryRun = true;
        else if (!a.startsWith('-') && !o.name) o.name = a; else throw new SetupError('unexpected ' + a);
      }
      if (!o.name) throw new SetupError('project remove needs a name');
      return projectRemove({ ...o, env, out, err });
    }
    if (rest[0] !== 'add' || rest.length !== 2) throw new SetupError('project needs: add <project.json> | new [flags] | list [--json] | remove <name> [--purge-state] [--dry-run]');
    return projectAdd(rest[1], { env, out, err });
  } catch (e) {
    if (!(e instanceof SetupError || e instanceof ConfigError)) throw e;
    err('error: ' + e.message);
    if ((e.code ?? 2) === 2) err('usage: ' + SETUP_USAGE[cmd]);
    return e.code ?? 2;
  }
}

// ---------- S4: norn run / norn stop / norn hook session ----------
const RUN_USAGE = {
  run: 'norn run --executor claude|codex-sol|codex-astra|fake|<configured typed executor name> --lane L --brief F [--parent RUN-n] [--worktree W] [--notes F] [--stage S] [--round N] [--budget-min N] [--agent A] [--model M] [--effort E] [--class C (the work class stamped on the run; else derived: workclass.mjs)] [--project <name | project.json> | --state D] [--locks D] [--machine F] [--budget F] [--no-tick] [--queue] [--wait (block until the run ends; exit 0 = DONE)] [--after "q:Q-n[:answered|applied],dlv:DLV-n[:merged],run:RUN-n[:done|ended|merged],dir:DIR-n[:done]"] [--inputs DLV-n,..] [--epic EP-n] [--priority P0|P1|P2|P3 (default: the epic priority)] [--item RM-n (links the run to its roadmap item)] [--labels a,b (always QUEUED; started by a machine serving every label: machine.json fed.labels, default its OS)]    exit 3 = worktree held, 4 = worker cap, 6 = the brief lacks its Ready lines Scope: / Tests: / Done: (policy.dod.ready refuse) (--queue: QUEUED instead, exit 0; --after: always QUEUED, started by the fill once every condition is met, held as "needs a ruling" when one can no longer be met; exit 3 also = a second queued / running run of the same lane + stage + round)',
  stop: 'norn stop RUN-n --as owner|dashboard|controller|checkin [--why W (required for checkin)] [--project project.json | --state D] [--locks D]    (a queued run is withdrawn; a check-in withdraws only a QUEUED run - a kill stays owner / controller)',
  requeue: 'norn requeue RUN-n [--after "<conditions as norn run --after> | none"] [--priority P0-P4] [--not-before ISO|none] --why W --as owner|dashboard|controller|checkin [--project project.json | --state D]    (a QUEUED run re-queued with new conditions or priority: same launch args, a flag left out keeps the old value (a MERGE / resolve stays at P1 or above); the old one withdrawn naming the new one; every queued run waiting on it rewired onto it; exit 3 = not queued)',
  hook: 'norn hook session --state D | --project project.json    (Claude Code SessionStart / SessionEnd hook; payload on stdin; always exits 0)',
};
// SHIP-READY minor: a misused `norn run` says the short form, never the full option list with its record-id syntax
const RUN_SHORT = 'norn run --executor E --lane L --brief F [options]    (every option: norn run --help)';
const RUN_FLAGS = ['executor', 'labels', 'after', 'inputs', 'epic', 'priority', 'parent', 'via', 'lane', 'brief', 'worktree', 'notes', 'stage', 'round', 'budget-min', 'agent', 'model', 'effort', 'class', 'project', 'state', 'locks', 'machine', 'budget', 'no-tick!', 'queue!', 'as', 'why', 'wait!', 'item', 'not-before'];
function runFlags(cmd, argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const s = RUN_FLAGS.find(f => f.replace(/!$/, '') === a.slice(2));
    if (!s) throw new RunError(`unknown flag ${a}`);
    if (s.endsWith('!')) { flags[a.slice(2)] = true; continue; }
    if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
    flags[a.slice(2)] = argv[++i];
  }
  return { flags, pos };
}
const readJsonFile = f => JSON.parse(fs.readFileSync(f, 'utf8'));
// OOTB F-7: --project takes a project.json path or a registered NAME; none given (no --state / META_PROJECT / META_STATE either)
// = the only registered project. -> the project.json path, or null
const registeredProjects = env => {
  const root = metaRoot(env), mf = path.join(root, 'local', 'machine.json');
  try { return fs.existsSync(mf) ? loadMachine(mf, { meta: root }).projects : []; } catch { return []; }   // a broken machine.json: paths only
};
function pickProject(flags, env) {
  // OOTB-R2 N-3: a file (a project.json) is a path; else a registered name wins over a same-named folder in the cwd
  const isFile = v => { try { return fs.statSync(v).isFile(); } catch { return false; } };
  const named = v => (isFile(v) ? v : registeredProjects(env).find(p => p.name === v)?.config ?? v);
  if (flags.project) return named(flags.project);
  if (flags.state) return null;
  if (env.META_PROJECT) return named(env.META_PROJECT);
  if (env.META_STATE) return null;
  const reg = registeredProjects(env);
  return reg.length === 1 ? reg[0].config : null;
}
const noProjectHint = env => { const n = registeredProjects(env).map(p => p.name); return n.length ? ` (registered: ${n.join(', ')})` : ' (none registered: norn project new --root <repo>)'; };
function where(flags, env) {
  const pf = pickProject(flags, env);
  const project = pf ? loadProject(pf) : null;
  // --project + --state: --state wins (the project still gives executors / policy), as `norn deliverables` - whose resolve
  // dispatches `norn run --project P --state S`; it was silently dropped before (META-GTP-CI-LINUX FINDING 2)
  const state = flags.state || (project ? project.state : env.META_STATE);
  if (!state) throw new RunError(`no state dir: pass --project <name | project.json>${noProjectHint(env)} or --state <dir>`);
  return { project, state, locks: flags.locks || path.join(path.dirname(path.resolve(state)), 'locks') };
}
// NORN-WATCH S4: --after / --inputs parse errors are usage errors (exit 2)
const labelsOf = s => { try { return parseLabels(s); } catch (e) { if (e instanceof FedError) throw new RunError(e.message); throw e; } };
const afterOf = (s, parse = parseAfter) => { try { return parse(s); } catch (e) { if (e instanceof AfterError) throw new RunError(e.message); throw e; } };
// OOTB-R2 N-2: a relative --brief / --notes is the caller's (cwd), not the lane worktree's the worker runs in ('-' = no brief file)
const callerPath = f => (f && f !== '-' ? path.resolve(f) : f);
// META-MERGE-MARKER (DEC-275 / DEC-285 / DEC-287): a MERGE run's notes = the NOTES file its brief names (its meta-merge marker, written
// by norn merge-brief --notes) - the worker writes its log there; a --notes naming another file is refused (one home)
function briefNotes(flags, brief) {
  if (!isMergeStage(flags.stage) || !brief || brief === '-') return null;
  let m = null;
  try { m = briefMarker(fs.readFileSync(brief, 'utf8')); } catch { return null; }
  if (!m?.notes) return null;
  const own = path.resolve(m.notes), given = callerPath(flags.notes);
  if (given && normWt(given) !== normWt(own)) throw new RunError(`--notes ${fwd(given)}: the MERGE brief ${fwd(brief)} names notes ${fwd(own)} (its worker writes its notes there) - drop --notes or pass that file`);
  return own;
}
// GAP-6: a MERGE brief names the run's merge worktree (runs.mergeSpec makes it the run's worktree whatever --worktree says):
// with no --worktree and no lane default it is the worktree
function briefMergeWt(flags, brief) {
  if (!isMergeStage(flags.stage) || !brief || brief === '-') return null;
  try { return briefMarker(fs.readFileSync(brief, 'utf8'))?.merge_wt || null; } catch { return null; }
}
// the launch spec of one run from the norn run flags (shared by norn run and norn flow; META-GTP-FLOW piece 2)
function runSpec(flags, env, { project, state, locks }) {
  const ex = flags.executor;
  if (!ex) throw new RunError('--executor is required');
  if (!flags.lane) throw new RunError('--lane is required');
  const root = metaRoot(env);
  const mf = flags.machine || path.join(root, 'local', 'machine.json');
  const machine = flags.machine || fs.existsSync(mf) ? loadMachine(mf, { meta: root }) : null;
  const bf = flags.budget || path.join(root, 'local', 'budget.json');
  const budget = flags.budget || fs.existsSync(bf) ? readJsonFile(bf) : {};
  const xc = project?.executors?.[ex] || {};
  if (flags.class !== undefined && !Object.hasOwn(CLASS_LABELS, flags.class)) throw new RunError(`--class ${JSON.stringify(flags.class)}: want ${Object.keys(CLASS_LABELS).join(' | ')}`);
  if (xc.enabled === false) throw new RunError(`executor ${ex} is disabled in ${project.name}'s project.json`);
  const late = s => (s ? expandLate(s, { lane: flags.lane }) : undefined);
  // META-QUEUE-SPEC R1: the policy-derived parts (memory, profile, model / effort / agent, class table) - the fill resolves them again
  const explicit = { model: flags.model, effort: flags.effort, agent: flags.agent, class: flags.class };
  const claudeDir = machine?.claude?.config_dir || path.join(os.homedir(), '.claude'), wt = flags.worktree || late(project?.lane_defaults?.worktree);
  const parts = launchParts({ project, budget, executor: ex, lane: flags.lane, explicit, claudeDir, worktree: wt }), prov = parts.provider;
  const harnessClaude = ex === 'claude' || (prov && executorInfo(ex, prov)?.harness === 'claude');
  const noAgent = harnessClaude ? agentRefusal(parts.agent, { claudeDir, worktree: wt, project }) : null;
  if (noAgent) throw new RunError(noAgent);
  if (prov?.preset && !presetExe(prov, env)) throw new RunError(`executor ${ex}: preset ${prov.preset}: exe ${prov.exe} is not detected (not on PATH) - install it or set executors.${ex}.exe`);
  const exe = prov?.preset ? presetExe(prov, env) : prov ? typedExe(prov, machine) : { claude: machine?.claude?.exe, 'codex-sol': machine?.codex?.exe, 'codex-astra': machine?.codex?.exe }[ex];
  const cadence = project?.policy?.cadence || {};
  const o = {
    state, locksDir: locks, executor: ex, lane: flags.lane, brief: callerPath(flags.brief), project: project?.name,
    ...(project && subdirOf(project) ? { subdir: subdirOf(project) } : {}),   // a monorepo project: the scope guard keeps a run without Scope: inside it
    worktree: flags.worktree || late(project?.lane_defaults?.worktree) || briefMergeWt(flags, callerPath(flags.brief)), notes: briefNotes(flags, callerPath(flags.brief)) || callerPath(flags.notes) || late(project?.lane_defaults?.notes),
    after: afterOf(flags.after), inputs: afterOf(flags.inputs, parseInputs), epic: flags.epic, priority: flags.priority,
    labels: labelsOf(flags.labels), node_labels: servedLabels(machine),   // META-GTP-FED piece 1
    caller: flags.as || env.META_ROLE,   // META-CONTROLLER C4: a check-in's run on a held lane is refused (runs.heldRefusal)
    parent: flags.parent, via: flags.via, stage: flags.stage, round: flags.round === undefined ? undefined : Number(flags.round), budgetMin: flags['budget-min'] === undefined ? undefined : Number(flags['budget-min']),
    profile: parts.profile, cls: parts.cls, workPolicy: parts.workPolicy, agent: parts.agent, model: parts.model, effort: parts.effort,
    exe, headless: xc.headless ? fs.readFileSync(xc.headless, 'utf8') : undefined, env: parts.env, memory: parts.memory,
    refill: refillOf({ projectFile: project?.file, budgetFile: bf, meta: root, explicit, claudeDir }),
    limit: prov ? undefined : xc.limit, writable_roots: (xc.writable_roots || []).map(late), provider: prov,
    policy: { auto_resume_handoff: cadence.auto_resume_handoff, auto_resume_max: cadence.auto_resume_max, trigger_on_exit: cadence.trigger_on_exit,
      fill: { ...FILL_DEFAULTS, ...(project?.policy?.fill || {}) },   // META-GTP-DAG piece 5: the resource gate of the fill
      mail: { nudge_after_min: project?.policy?.mail?.nudge_after_min ?? POLICY_DEFAULTS.mail.nudge_after_min },   // META-GTP-MAIL piece 3
      slop: { enabled: slopOn(project?.policy), project_dir: project?.project_dir } },   // META-BETA-PREP (DIR-52): the one switch; RM-45: the run end checks with the project's own rules
    // the nudge waits while these exist: the project's QUIET flag (common-rules.txt line 1) and its GPU lock file (gpu_lock.ps1)
    quiet: project ? quietFlag(project) : undefined, gpu_lock: project?.gpu_lock_file,
    budget, budget_file: path.resolve(bf),   // GAP-2: the fill reads the budget of NOW from here (runs.mjs liveBudget); budget = the copy for a resume
    paused: pauseFiles(state), statusFile: path.join(state, 'STATUS.md'),
    ledger: project?.ledger, projectsDir: machine?.claude?.projects_dir, ...(ledgerConfig(machine, { metaRoot: root, machineFile: mf }) ? { git_ledger: ledgerConfig(machine, { metaRoot: root, machineFile: mf }) } : {}),
    tick: flags['no-tick'] || env.META_NO_TICK ? null : [process.execPath, fileURLToPath(import.meta.url), 'tick', '--reason', 'exit', ...(project ? ['--project', project.file] : []), '--state', state],
    // GAP-12: a lane start refreshes the overlap check (detached, by the supervisor); no project / policy off / no tick (tests) = none
    overlap: !project || !overlapOn(project.policy) || flags['no-tick'] || env.META_NO_TICK ? null : [process.execPath, fileURLToPath(import.meta.url), 'overlap', '--project', project.file, '--state', state, '--force'],
    ...(env.META_HB_MS ? { hbMs: Number(env.META_HB_MS) } : {}),
  };
  // GAP-4: every value a caller can invent (executor, model, effort, stage, lane, round, budget-min, brief; a check-in's paths) checked
  // against what exists before the run starts or queues - the refusal names the valid choices (launchargs.mjs)
  const bad = launchArgsRefusal({ executor: ex, model: flags.model, effort: flags.effort, stage: flags.stage, lane: flags.lane, round: flags.round, budgetMin: flags['budget-min'],
    brief: o.brief, worktree: o.worktree, notes: o.notes, project, budget, state, caller: o.caller });
  if (bad) throw new RunError(bad);
  if (!o.worktree) throw new RunError('--worktree is required (no project lane_defaults.worktree)');
  if (!o.brief) throw new RunError('--brief is required');
  return o;
}
function runCmd(argv, env, out, err) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'hook') return hookCmd(rest, env, err);
    const { flags, pos } = runFlags(cmd, rest);
    if (flags['not-before'] !== undefined && cmd !== 'requeue') throw new RunError('--not-before is a norn requeue flag');
    const { project, state, locks } = where(flags, env);
    if (cmd === 'requeue') {   // META-AUTONOMY R1
      if (pos.length !== 1) throw new RunError('requeue needs one RUN id');
      const nb = flags['not-before'];
      if (flags.after === undefined && flags.priority === undefined && nb === undefined) throw new RunError('requeue needs --after, --priority or --not-before (what changes)');
      const r = requeueRun({ state, run: pos[0], after: flags.after === undefined ? undefined : flags.after === 'none' ? [] : afterOf(flags.after), by: flags.as || env.META_ROLE, why: flags.why,
        notBefore: nb === 'none' ? null : nb, priority: flags.priority });
      const what = [flags.after !== undefined ? `after ${flags.after}` : 'its after: kept', ...(nb ? [`not before: ${nb}`] : []), ...(flags.priority ? [`priority ${r.priority}`] : [])];
      out(`REQUEUED ${r.run} -> ${r.next} (${what.join('; ')})${r.rewired.length ? `; rewired ${r.rewired.join(', ')}` : ''}`);
      for (const q of fillQueue(state)) out(`queue: ${q.queued} -> STARTED ${q.next}`);   // met now = starts now (as norn run --after)
      return 0;
    }
    if (cmd === 'stop') {
      if (pos.length !== 1) throw new RunError('stop needs one RUN id');
      const by = flags.as || env.META_ROLE;
      if (!by) throw new RunError('no role: pass --as <role>');
      const ev = stopRun({ state, locksDir: locks, run: pos[0], by, why: flags.why });
      out(`${pos[0]} ${ev.ev === 'withdraw' ? 'withdrawn' : 'killed'}`);
      return 0;
    }
    if (pos.length) throw new RunError(`unexpected ${pos[0]}`);
    const o = runSpec(flags, env, { project, state, locks }), ex = o.executor;
    // META-OOTB F-1: a lane with no worktree = ONE line naming the command that creates it (exit 2); never a guess at who makes it
    if (!flags.queue && !fs.existsSync(o.worktree)) {
      const wt = String(o.worktree).replace(/\\/g, '/');
      err(flags.worktree ? `error: worktree not found: ${wt}` : `error: lane ${o.lane} has no worktree (${wt}): create it with: norn lane new ${o.lane} --project ${project ? project.file.replace(/\\/g, '/') : '<project.json>'}`);
      return 2;
    }
    // META-DOD 1 (DIR-68): the Definition of Ready - a brief without Scope: / Tests: / Done: is refused (exit 6) or warned per policy.dod.ready
    const rg = readyGate({ brief: o.brief, policy: project?.policy, stage: o.stage, gate: project ? mergeConfig(project).gate : null });
    if (rg.refused) throw new RunRefused(rg.refused, 6);
    if (rg.dod) o.dod = { ...rg.dod, ...(o.notes ? { notes: o.notes } : {}) };
    if (flags.item) openItem(state, flags.item);   // META-ROADMAP S3: refuse before any run is recorded
    // META-CATCH S2: a look item's round >= 2 / MERGE / INSTALL brief names its before / after sheet (Look:) or is refused (exit 6)
    const looks = lookItemsFor(loadRoadmap(state), { item: flags.item, lane: o.lane });
    if (looks.length) {
      let text = null;
      try { text = o.brief && o.brief !== '-' ? fs.readFileSync(o.brief, 'utf8') : null; } catch { /* unreadable: no Look: line */ }
      const lr = lookBriefRefusal({ items: looks, text, brief: o.brief, stage: o.stage, round: o.round, policy: project?.policy });
      if (lr) throw new RunRefused(lr, 6);
    }
    // META-CATCH S1: a stuck item (stuck.json, the tick's flags) takes no further round until its approach review (exit 7)
    const sr = stuckRefusal(state, { lane: o.lane, item: flags.item, stage: o.stage, executor: ex, model: o.model });
    if (sr) throw new RunRefused(sr, 7);
    // META-DOD 3: a brief naming a plan whose review is not settled waits for it (critique.mjs; met now = no condition)
    const holds = critiqueHolds(state, o.brief);
    if (holds.length) o.after = [...(o.after || []), ...holds];
    const r = startRun(flags.queue ? { ...o, queue: true } : o);
    if (flags.item) linkItem(state, flags.item, 'run:' + r.run, 'launcher', err);
    if (r.queued) {
      out(`QUEUED ${r.run} lane ${o.lane} ${ex} ${o.model} ${o.effort} position ${r.position} (${r.why})`);
      for (const c of holds) out(`WAITS ${r.run} for the plan review ${c.id} (after run:${c.id}:reviewed: a clean review releases it, findings wait for the check-in's review)`);
      if (o.after?.length || o.labels?.length) for (const q of fillQueue(state)) out(`queue: ${q.queued} -> STARTED ${q.next}`);   // S4: met now = starts now; FED: served here = starts now
      return 0;
    }
    out(`STARTED ${r.run} lane ${o.lane} ${ex}${o.model === ex ? '' : ' ' + o.model} ${o.effort} supervisor pid ${r.pid} log ${r.log}`);
    for (const w of r.warnings || []) out(`WARNING ${r.run}: ${w}`);   // NORN-WATCH S5 durable lane output
    if (flags.wait) {   // META-OOTB F-1: block until the run ends and say how (the first-task walk-through; exit 1 unless DONE)
      delegateWait({ state, runs: [r.run], maxS: 24 * 3600 });
      // CIRED-ba33455: the `end` record comes BEFORE the supervisor's exit work (auth gate + re-queue, queue fill): the run has
      // ended when its supervisor is gone (as fednode.mjs waits; 120 s = only a hung supervisor's net)
      const sup = loadState(state).items[r.run]?.end?.supervisor_pid;
      for (let t0 = Date.now(); sup && Date.now() - t0 < 120000;) {
        if (!running(sup)) break;   // a zombie supervisor (our own unreaped child: this loop blocks the loop) has exited
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      const it = loadState(state).items[r.run], e = it.end || {};
      const how = it.state === 'running' ? 'still running' : e.outcome === 'done' ? 'exited: DONE' : e.outcome === 'stopped' ? `exited: STOPPED: ${e.why ?? ''}`.trimEnd()
        : e.outcome === 'handoff' ? 'exited: HANDOFF' : e.outcome === 'auth' ? (e.auth_class === 'vendor' ? 'exited: auth - a vendor outage, not the login (held runs resume by themselves; no login needed)' : `exited: auth - the login is down: run ${loginCommand(ex, project?.executors?.[ex])} (held runs resume by themselves)`)   // OOTB-R2 N-5
        : `${it.state}: ${e.outcome ?? it.history.at(-1)?.data?.why ?? '?'}`;
      out(`${r.run} ${how}`);
      return e.outcome === 'done' ? 0 : 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof RunRefused) { out('REFUSED: ' + e.message); return e.code; }
    if (e instanceof RunError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err('usage: ' + (cmd === 'run' ? RUN_SHORT : RUN_USAGE[cmd] || RUN_USAGE.run)); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// META-ROADMAP S3 (SPEC sec. 3 "Launcher"): `norn run --item RM-n` / `norn rec add lane --item RM-n` link the work to its roadmap
// item. The item must be open; the link is written after the run / lane (a failed link warns: the work shows under Unplaced).
function openItem(state, id) {
  const it = loadRoadmap(state).items[id];
  if (!it) throw new RunError(`--item ${id} does not exist (norn road list)`);
  if (it.state !== 'open') throw new RunError(`--item ${id} is ${it.state}`);
}
function linkItem(state, id, term, by, err) {
  try { record(state, { kind: 'item', ev: 'link', id, by, data: { links: [term] } }, { views: false }); }
  catch (e) { if (!(e instanceof RecordError)) throw e; err(`warning: ${term} not linked to ${id}: ${e.message} (it shows under Unplaced)`); }
}

// Claude Code hook: SessionStart registers a RUN kind interactive, SessionEnd ends it. Never fails the session (exit 0).
function hookCmd(argv, env, err) {
  try {
    if (argv[0] !== 'session') throw new RunError('hook needs: session');
    const { flags } = runFlags('hook', argv.slice(1));
    const { state } = where(flags, env);
    const p = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (!p.session_id || !p.hook_event_name) throw new RunError('payload lacks session_id / hook_event_name');
    const live = Object.values(loadState(state).items).find(i => i.kind === 'run' && i.state === 'running' && i.data.kind === 'interactive' && i.data.session_id === p.session_id);
    if (p.hook_event_name === 'SessionStart' && !live) {
      record(state, { kind: 'run', ev: 'start', by: 'launcher', data: Object.fromEntries(Object.entries({ kind: 'interactive', session_id: p.session_id,
        transcript: p.transcript_path, worktree: p.cwd, source: p.source, model: p.model }).filter(([, v]) => v !== undefined && v !== null)) });
    } else if (p.hook_event_name === 'SessionEnd' && live) {
      record(state, { kind: 'run', ev: 'end', id: live.id, by: 'launcher', data: { exit: null, outcome: 'ended', ...(p.reason ? { reason: p.reason } : {}) } });
    }
  } catch (e) { err(`norn hook: ${e.message} (ignored)`); }
  return 0;
}

// ---------- S5: norn status / norn tick / norn runs / norn sched ----------
const S5_USAGE = {
  status: 'norn status [--project <name | project.json> | --state D] [--machine F] [--budget F] [--out F]',
  tick: 'norn tick [--project <name | project.json>] [--reason R] [--at ISO] [--dry] [--machine F] [--budget F]    (no --project = every project in machine.json; --dry = FAKE claude; --at = wait until then: the debounce tick)',
  runs: 'norn runs [--unreviewed] [--lane L] [--json] [--all-nodes (+ the runs of the federation nodes, read-only: fetched with machine.json ledger.remote, else the fill\'s fed-cache.json)] [--project <name | F> | --state D]  |  norn runs review RUN-n --refs X,Y --as checkin|controller  |  norn runs landed RUN-n --why W [--sha S] --as checkin|controller|owner    (a ruling: the work of the run counts as merged on main where git cannot see it - run:RUN-n:merged / :done conditions on its family are met)',
  overlap: 'norn overlap [--project <name | project.json>] [--state D] [--force]    (GAP-12: fetch origin (at most every 10 min; --force now) and list each running lane overlaps with the remote branches and open PRs (gh, GitHub); policy.overlap.enabled false = off)',
  digest: 'norn digest [--project F | --state D] [--json | --hook]    (NORN-WATCH S1: the level-triggered resume digest; --hook = a SessionStart hook payload; read-only)',
  sched: 'norn sched show|install|remove [--machine F]    (the machine scheduler, D13; install / remove touch the real OS scheduler)',
};
const S5_FLAGS = ['project', 'state', 'machine', 'budget', 'out', 'reason', 'dry!', 'force!', 'unreviewed!', 'lane', 'json!', 'refs', 'as', 'hook!', 'all-nodes!', 'why', 'sha', 'at'];
function s5Flags(argv) {
  const flags = {}, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const s = S5_FLAGS.find(f => f.replace(/!$/, '') === a.slice(2));
    if (!s) throw new RunError(`unknown flag ${a}`);
    if (s.endsWith('!')) { flags[a.slice(2)] = true; continue; }
    if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
    flags[a.slice(2)] = argv[++i];
  }
  return { flags, pos };
}
function machineOf(flags, env) {
  const root = metaRoot(env);
  const mf = flags.machine || path.join(root, 'local', 'machine.json');
  const bf = flags.budget || path.join(root, 'local', 'budget.json');
  return { root, mf, machine: fs.existsSync(mf) ? loadMachine(mf, { meta: root }) : null, budgetFile: bf,
    budget: fs.existsSync(bf) ? JSON.parse(fs.readFileSync(bf, 'utf8').replace(/^﻿/, '')) : {} };
}
const projectsDirOf = (machine, env) => machine?.claude?.projects_dir || path.join(env.CLAUDE_CONFIG_DIR || path.join(env.USERPROFILE || env.HOME || '', '.claude'), 'projects');
// META-GTP-FED piece 3: this state's runs + the runs of the same project on every other machine branch of the ledger remote (read-only:
// fetched into the machine's ledger repo, never written into runs.jsonl); no remote = the home fill's import (<state>/fed-cache.json)
function allNodes(state, m, flags, out) {
  const cfg = m.machine ? ledgerConfig(m.machine, { metaRoot: m.root, machineFile: m.mf }) : null, fe = fedOf(cfg);
  const own = fe?.host || (cfg ? cfg.branch.replace(/^machine\//, '') : hostName()), project = path.basename(path.resolve(state));
  let nodes;
  if (fe) nodes = fetchForeign(fe, project);
  else { let c = null; try { c = JSON.parse(fs.readFileSync(path.join(state, 'fed-cache.json'), 'utf8')); } catch { /* none */ } nodes = Object.entries(c?.nodes || {}).map(([node, runs]) => ({ node, runs })); }
  const keep = i => i.kind === 'run' && (!flags.lane || i.data?.lane === flags.lane);
  const rows = [...Object.values(loadState(state).items).filter(keep).map(it => ({ node: own, it })), ...nodes.flatMap(n => n.runs.filter(keep).map(it => ({ node: n.node, it })))];
  const outcome = it => it.history?.find(h => h.ev === 'end')?.data?.outcome ?? it.fill?.outcome ?? null;
  if (flags.json) { out(JSON.stringify(rows.map(({ node, it: { history, ...i } }) => ({ node, ...i, outcome: outcome({ history, ...i }) })), null, 1)); return 0; }
  for (const { node, it } of rows) {
    const via = it.fill?.node ? `-> ${it.fill.next} on ${it.fill.node}` : it.claim?.node && it.state === 'claimed' ? `claimed by ${it.claim.node}` : it.data?.claim_of ? `claim of ${it.data.claim_of.home}/${it.data.claim_of.run}` : '';
    out(`${node}  ${it.id}  ${it.state}  ${outcome(it) ?? '-'}  ${it.data?.lane ?? '-'}  ${it.data?.executor ?? it.data?.kind ?? '-'}  ${via}`.trimEnd());
  }
  return 0;
}
function s5Cmd(argv, env, out, err) {
  const [cmd, ...rest] = argv;
  try {
    const { flags, pos } = s5Flags(rest);
    const m = machineOf(flags, env);
    if (cmd === 'sched') {
      if (!m.machine) throw new RunError('no machine.json: run norn setup first');
      // META-NAME-W2: a recorded pre-rename name runs as this install's norn-tick name; install / remove record it (schedApply removes the old task)
      const sc = { ...m.machine.scheduler, name: liveName(m.machine.scheduler.name, m.root) }, a = adapterFor(sc.kind);
      const o = { name: sc.name, interval_min: sc.interval_min, node: m.machine.node, meta: m.root.replace(/\\/g, '/'), home: m.machine.home };
      if (pos[0] === 'show' || !pos.length) { const p = a.plan(o); for (const f of p.files) out(`=== ${f.path}\n${f.content}`); for (const c of p.install) out('$ ' + c.join(' ')); const s = schedState(a, o); out(`installed: ${s.installed && !s.foreign ? 'yes' : s.foreign ? `no (task '${sc.name}' belongs to the install at ${s.owner})` : 'no'}`); for (const n of oldTasks(a, o)) out(`old task '${n}' still installed: norn sched install moves it`); return 0; }
      // OOTB F-4: never install over / remove the task of ANOTHER install (schtasks /F would overwrite it)
      if (['install', 'remove'].includes(pos[0])) { const s = schedState(a, o); if (s.foreign) throw new RunError(`task '${sc.name}' belongs to the install at ${s.owner}, not this one (${o.meta}): rerun norn setup to derive this install's own task name`); }
      if (pos[0] === 'install' && !m.machine.projects.length) throw new RunError('no project registered: add a project first (norn project new --root <repo>)');
      // META-OOTB F-3: no unattended check-ins before the caps are set (unset = no limit); one line, no usage text
      const miss = pos[0] === 'install' ? capsMissing(m.budget) : [];
      if (miss.length) { err(`error: no caps set in ${m.budgetFile.replace(/\\/g, '/')} (missing ${miss.join(', ')}): run norn setup (writes the starter caps when the file is absent) or set them in the dashboard Settings (Workers & budget), then sched install again`); return 2; }
      if (['install', 'remove'].includes(pos[0])) {
        for (const l of schedApply(pos[0], a, o, sc.kind)) out(l);
        if (sc.name !== m.machine.scheduler.name) { const raw = JSON.parse(fs.readFileSync(m.mf, 'utf8')); raw.scheduler.name = sc.name; fs.writeFileSync(m.mf + '.tmp', JSON.stringify(raw, null, 1) + '\n'); fs.renameSync(m.mf + '.tmp', m.mf); }
        return 0;
      }
      throw new RunError(`sched needs show | install | remove (got ${pos[0]})`);
    }
    if (cmd === 'tick') {
      if (pos.length) throw new RunError(`unexpected ${pos[0]}`);
      const files = flags.project ? [pickProject(flags, env)] : (m.machine?.projects || []).map(p => p.config);
      if (!files.length) throw new RunError('no project: pass --project <project.json> or register one (norn project add)');
      if (flags.at) {   // META-CHECKIN-DIET R1: the debounce tick waits for its window (+2 s clock slack), at most an hour
        const ms = Date.parse(flags.at) + 2000 - Date.now();
        if (!Number.isFinite(ms)) throw new RunError(`--at needs an ISO time (got ${flags.at})`);
        if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 3600e3));
      }
      let code = 0;
      const flushes = [];
      for (const f of files) {
        const proj = { ...loadProject(f, { meta: m.root }), ...(flags.project && flags.state ? { state: flags.state } : {}) };   // --state wins, as where()
        // NORN-WATCH S5 notice policy: a due FYI batch (oldest >= notify.batch_h) leaves on the tick too; its failure never fails the tick
        flushes.push(import('../lib/notify.mjs').then(({ flushNotices, batchHours }) => flushNotices({ state: proj.state, batchH: batchHours(proj), machine: m.machine, env }))
          .then(x => { if (x.sent) out(`tick ${proj.name}: notify: FYI digest of ${x.count} sent`); }, e => err(`tick ${proj.name}: notify flush failed: ${e.message}`)));
        const r = tick({ project: proj, machine: { ...(m.machine || {}), claude: { ...(m.machine?.claude || {}), projects_dir: projectsDirOf(m.machine, env) } },
          budget: m.budget, budgetFile: m.budgetFile, reason: flags.reason || 'manual', dry: !!flags.dry, ledger: ledgerConfig(m.machine, { metaRoot: m.root, machineFile: m.mf }), ...(env.META_HB_MS ? { hbMs: Number(env.META_HB_MS) } : {}) });
        (r.code ? err : out)(r.msg);
        if (r.notice) flushes.push(import('../lib/notify.mjs').then(({ notify }) => notify({ title: r.notice.title, body: r.notice.body, cls: 'alert', machine: m.machine, state: proj.state, env }))   // META-AUTH: once per outage
          .then(x => out(`tick ${proj.name}: notify: ${r.notice.cls === 'vendor' ? 'vendor outage' : 'login'} notice ${x.sent ? 'sent' : 'recorded'}`), e => err(`tick ${proj.name}: notify (login) failed: ${e.message}`)));
        // GAP-1: ONE notice per hold of all queued work (holds.mjs: hold.json notified) - the owner must act, so class alert
        if (r.hold_notice) flushes.push(import('../lib/notify.mjs').then(({ notify }) => notify({ title: r.hold_notice.title, body: r.hold_notice.body, cls: 'alert', machine: m.machine, state: proj.state, env }))
          .then(x => out(`tick ${proj.name}: notify: hold notice ${x.sent ? 'sent' : 'recorded'}`), e => err(`tick ${proj.name}: notify (hold) failed: ${e.message}`)));
        // RM-37: ONE notice per run asked to pause that reached no clean point within policy.pause.clean_min (pause.mjs), class alert
        if (r.pause_notice) flushes.push(import('../lib/notify.mjs').then(({ notify }) => notify({ title: r.pause_notice.title, body: r.pause_notice.body, cls: 'alert', machine: m.machine, state: proj.state, env }))
          .then(x => out(`tick ${proj.name}: notify: pause notice ${x.sent ? 'sent' : 'recorded'}`), e => err(`tick ${proj.name}: notify (pause) failed: ${e.message}`)));
        // META-CATCH S1: ONE notice per sweep that handled dead runs ("machine rebooted at T: n runs lost, m relaunched"), class alert
        if (r.lost_notice) flushes.push(import('../lib/notify.mjs').then(({ notify }) => notify({ title: r.lost_notice.title, body: r.lost_notice.body, cls: 'alert', machine: m.machine, state: proj.state, env }))
          .then(x => out(`tick ${proj.name}: notify: lost-runs notice ${x.sent ? 'sent' : 'recorded'}`), e => err(`tick ${proj.name}: notify (lost runs) failed: ${e.message}`)));
        // META-CATCH S1: ONE notice per new stuck flag (stuck.mjs: stuck.json noticed), class alert
        for (const n of r.stuck_notices || []) flushes.push(import('../lib/notify.mjs').then(({ notify }) => notify({ title: n.title, body: n.body, cls: 'alert', machine: m.machine, state: proj.state, env }))
          .then(x => out(`tick ${proj.name}: notify: stuck notice ${x.sent ? 'sent' : 'recorded'}`), e => err(`tick ${proj.name}: notify (stuck) failed: ${e.message}`)));
        // META-GUARD R1: one "usage" notice per new GRD alarm - batched into the FYI digest unless policy guard.push
        for (const g of r.guard || []) flushes.push(import('../lib/notify.mjs').then(({ notify, batchHours }) => notify({ title: `${g.run} ${g.cls}`, body: `${g.id}${g.lane ? ' ' + g.lane : ''}: ${g.why}`,
          cls: 'usage', push: !!r.guard_push, batchH: batchHours(proj), machine: m.machine, state: proj.state, env }))
          .then(x => out(`tick ${proj.name}: notify: usage ${g.id} ${x.batched ? 'batched' : x.sent ? 'sent' : 'recorded'}`), e => err(`tick ${proj.name}: notify (usage) failed: ${e.message}`)));
        code = Math.max(code, r.code);
      }
      return Promise.all(flushes).then(() => code);
    }
    const { project, state } = where(flags, env);
    if (cmd === 'status') {
      if (pos.length) throw new RunError(`unexpected ${pos[0]}`);
      for (const q of fillQueue(state)) out(`queue: ${q.queued} -> STARTED ${q.next}`);   // a slot a kill / lost run freed (META-GT12)
      const s = writeStatus({ state, project: project?.name, providers: providersOf(project), budget: m.budget, projectsDir: projectsDirOf(m.machine, env), usageJson: m.machine?.usage || {}, ci: project?.ci,
        cacheFile: path.join(state, 'usage-cache.json'), digest: tryDigest(state, project || {}) }, flags.out || path.join(state, 'STATUS.md'));
      out(s.line);
      return 0;
    }
    if (cmd === 'overlap') {   // GAP-12: refresh the overlap cache (a lane start spawns this; the tick refreshes too) and print it
      if (pos.length) throw new RunError(`unexpected ${pos[0]}`);
      if (!project) throw new RunError('overlap needs --project (the repo whose origin is compared)');
      if (!overlapOn(project.policy)) { out(`overlap ${project.name}: the overlap check is off (policy.overlap.enabled false)`); return 0; }
      const c = projectOverlap({ ...project, state }, { force: !!flags.force });
      if (!c) { out(`overlap ${project.name}: no repo to compare`); return 0; }
      if (c.fetch_error) err(`overlap ${project.name}: ${c.fetch_error}`);
      const ls = Object.values(c.lanes || {});
      if (!ls.length) out(`overlap ${project.name}: no running lane`);
      for (const l of ls) {
        if (!l.overlaps.length) out(`${l.lane}: no overlap (${l.files} changed file${l.files === 1 ? '' : 's'})`);
        for (const o of l.overlaps) out(`${l.lane}: ${overlapText(o)}: ${o.files.join(', ')}${o.n > o.files.length ? ', ...' : ''}${o.url ? ` ${o.url}` : ''}`);
      }
      return 0;
    }
    if (cmd === 'digest') {
      if (pos.length) throw new RunError(`unexpected ${pos[0]}`);
      if (flags.hook && (env.META_RUN_ID || env.META_ROLE === 'checkin')) return 0;   // supervised runs in the main checkout: interactive sessions only
      const d = digest(state, project || {});
      if (flags.json) out(JSON.stringify(d, null, 1));
      else if (flags.hook) out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'NORN RESUME DIGEST (norn digest; act on every row - a row leaves only when its target state is reached):\n' + renderDigest(d) } }));
      else out(renderDigest(d).trimEnd());
      return 0;
    }
    // runs
    if (pos[0] === 'review') {
      if (pos.length !== 2) throw new RunError('runs review needs one RUN id');
      const by = flags.as || env.META_ROLE;
      if (!by) throw new RunError('no role: pass --as checkin|controller');
      record(state, { kind: 'run', ev: 'review', id: pos[1], by, data: { refs: csv(flags.refs) || [] } });
      out(`${pos[1]} reviewed`);
      return 0;
    }
    if (pos[0] === 'landed') {   // META-AUTONOMY R1: a check-in ruling "counted merged" as a recorded fact (after.mjs honours it)
      if (pos.length !== 2) throw new RunError('runs landed needs one RUN id');
      const by = flags.as || env.META_ROLE;
      if (!by) throw new RunError('no role: pass --as checkin|controller|owner');
      if (!flags.why) throw new RunError('runs landed needs --why (the ruling, e.g. DEC-n)');
      record(state, { kind: 'run', ev: 'landed', id: pos[1], by, data: { why: flags.why, ...(flags.sha ? { sha: flags.sha } : {}) } });
      out(`${pos[1]} landed (${flags.why})`);
      return 0;
    }
    if (pos.length) throw new RunError(`unexpected ${pos[0]}`);
    if (flags['all-nodes']) return allNodes(state, m, flags, out);
    const items = Object.values(loadState(state).items).filter(i => i.kind === 'run' && (!flags.lane || i.data.lane === flags.lane)
      && (!flags.unreviewed || (['exited', 'lost', 'killed'].includes(i.state) && !i.review && i.data.kind !== 'interactive')));
    if (flags.json) out(JSON.stringify(items.map(({ history, ...i }) => ({ ...i, outcome: history.find(h => h.ev === 'end')?.data.outcome ?? null })), null, 1));
    const pos1 = Object.fromEntries(queueOf(items).map(q => [q.id, q]));
    const col3 = i => pos1[i.id] ? `#${pos1[i.id].position} not_before ${pos1[i.id].not_before ?? '-'}` : i.history.find(h => h.ev === 'end')?.data.outcome ?? '-';
    if (!flags.json) for (const i of items) out(`${i.id}  ${i.state}  ${col3(i)}  ${i.data.lane ?? '-'}  ${i.data.executor ?? i.data.kind}  ${i.data.notes ?? i.data.final ?? ''}`);
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err('usage: ' + S5_USAGE[cmd]); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// ---------- S8: norn dash / norn smoke (long-running: they return undefined and set process.exitCode themselves) ----------
const DASH_USAGE = 'usage: norn dash [--port N (0 = random)] [--project <project.json>]... [--open | --no-open]    (default: machine.json dash.port + registered projects; a browser opens only on a terminal or with --open)  |  norn dash restart    (the live dashboard of this install: stops ONLY its recorded pid, starts it detached on the configured port; a taken port = an error naming the holder)';
// OOTB F-15: a browser tab only for a human at a terminal, or when asked; a script / agent gets the URL alone. --no-open always wins.
export const dashOpens = (open, tty) => (open === null ? !!tty : open);
function dashCmd(argv, env, out, err) {
  if (argv[0] === 'restart') return dashRestartCmd(argv.slice(1), env, out, err);
  const o = { projects: [], open: null, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') o.open = false;
    else if (a === '--open') o.open = o.open ?? true;
    else if (a === '--port' && /^\d+$/.test(argv[i + 1] || '')) o.port = Number(argv[++i]);
    else if (a === '--project' && i + 1 < argv.length) o.projects.push(argv[++i]);
    else { err('error: unexpected ' + a); err(DASH_USAGE); return 2; }
  }
  const root = metaRoot(env), mf = path.join(root, 'local', 'machine.json');
  if (!fs.existsSync(mf)) { err('error: no machine.json: run norn setup'); return 1; }
  let machine, projects;
  try {
    machine = loadMachine(mf, { meta: root });
    projects = (o.projects.length ? o.projects : machine.projects.map(p => p.config)).map(f => loadProject(f, { home: machine.home, meta: root }));
  } catch (e) { if (!(e instanceof ConfigError)) throw e; err('error: ' + e.message); return 2; }
  // META-ADOPT A3: zero projects is a start, not an error - the page opens on Add a project (and re-reads machine.json when it changes)
  // QUIET / GPU rules line shown read-only in Settings: <project rules>/common-rules.txt (design 10.12; no engine-root copy since META-ONBOARD S6)
  const quietFile = projects.length ? [path.join(path.dirname(projects[0].file), 'rules', 'common-rules.txt')].find(f => fs.existsSync(f)) : undefined;
  import('../dash/server.mjs').then(({ createDashboard }) => {
    const d = createDashboard({ projects, machine, budgetFile: path.join(root, 'local', 'budget.json'), quietFile, metaRoot: root, env, registered: !o.projects.length });
    const bind = machine.dash?.bind || '127.0.0.1';
    d.server.on('error', e => { err('error: ' + e.message); process.exit(1); });
    const cfgPort = machine.dash?.port ?? 8737;
    d.server.listen(o.port ?? cfgPort, bind, () => {
      const url = `http://${bind}:${d.server.address().port}/`;
      // META-DASH-LIVE: the install's live dashboard (configured port, registered projects) records itself for `norn dash restart`
      if (d.server.address().port === cfgPort && !o.projects.length) {
        try {
          writeDash(root, { pid: process.pid, port: cfgPort, bind, root, started: new Date().toISOString() });
          process.on('exit', () => clearDash(root, process.pid));
          for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(130));
        } catch (e) { err('warn: dashboard record not written: ' + e.message); }
      }
      out(`DASH ${url} - ${projects.length ? 'projects ' + projects.map(p => p.name).join(', ') : 'no project yet: add one on the page (or norn project new --root <repo>)'} (Ctrl+C stops)`);
      if (!dashOpens(o.open, process.stdout.isTTY)) { if (o.open === null) out('browser: not opened (not a terminal) - pass --open to open it'); return; }
      const [c, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
      try { spawn(c, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch { /* no browser: the URL is printed */ }
    });
  }, e => { err('error: ' + e.message); process.exitCode = 1; });
  return undefined;
}
// ---------- META-CONTROLLER C6: norn remote setup | off [--apply] (SPEC sec. 5; never installs anything, never Funnel) ----------
const REMOTE_USAGE = 'usage: norn remote setup [--apply] [--host <pc>.<tailnet>.ts.net] [--login <you>]    (checks for tailscale and prints each command + what it does; only --apply runs "tailscale serve --bg http://127.0.0.1:<dash.port>" and writes machine.json dash.remote)\n       norn remote off [--apply]    (prints, and with --apply runs, "tailscale serve --https=443 off" and sets dash.remote.enabled false)';
function remoteCmd(argv, env, out, err) {
  const [sub, ...rest] = argv;
  if (!['setup', 'off'].includes(sub)) { err(REMOTE_USAGE); return 2; }
  if (rest.some(a => /funnel/i.test(a))) { err('error: Tailscale Funnel puts the dashboard on the public internet - refused (a page that starts agents on this PC stays inside your own tailnet)'); return 2; }
  const o = { apply: false, host: null, login: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--apply') o.apply = true;
    else if (sub === 'setup' && (a === '--host' || a === '--login') && rest[i + 1]) o[a.slice(2)] = rest[++i];
    else { err('error: unexpected ' + a); err(REMOTE_USAGE); return 2; }
  }
  const root = metaRoot(env), mf = path.join(root, 'local', 'machine.json');
  if (!fs.existsSync(mf)) { err('error: no machine.json: run norn setup'); return 1; }
  let machine;
  try { machine = loadMachine(mf, { meta: root }); } catch (e) { if (!(e instanceof ConfigError)) throw e; err('error: ' + e.message); return 2; }
  return sub === 'setup' ? remoteSetup({ machineFile: mf, machine, ...o, env, out }) : remoteOff({ machineFile: mf, machine, apply: o.apply, env, out });
}
function dashRestartCmd(argv, env, out, err) {
  if (argv.length) { err('error: unexpected ' + argv[0]); err(DASH_USAGE); return 2; }
  const root = metaRoot(env), mf = path.join(root, 'local', 'machine.json');
  if (!fs.existsSync(mf)) { err('error: no machine.json: run norn setup'); return 1; }
  let machine;
  try { machine = loadMachine(mf, { meta: root }); } catch (e) { if (!(e instanceof ConfigError)) throw e; err('error: ' + e.message); return 2; }
  const port = machine.dash?.port ?? 8737, bind = machine.dash?.bind || '127.0.0.1';
  dashRestart({ root, port, bind, env }).then(r => {
    out(`dash restarted: pid ${r.pid} on ${r.url}${r.stopped ? ` (stopped pid ${r.stopped})` : ' (no recorded dashboard was running)'}`);
    process.exitCode = 0;
  }, e => { err('error: ' + (e instanceof DashError ? e.message : e.stack)); process.exitCode = 1; });
  return undefined;
}
function smokeCmd(argv, env, out, err) {
  const bad = argv.find(a => !['--keep', '--update-goldens'].includes(a));
  if (bad) { err('error: unexpected ' + bad); err('usage: norn smoke [--keep] [--update-goldens]'); return 2; }
  import('../lib/smoke.mjs').then(({ smoke }) => smoke({ out, err, keep: argv.includes('--keep'), update: argv.includes('--update-goldens') }))
    .then(c => { process.exitCode = c; }, e => { err(e.stack); process.exitCode = 1; });
  return undefined;
}

// ---------- billing modes: norn billing [<mode>] [--usd-per-day N|off] (how the Claude account is paid for -> the usage guard) ----------
const BILLING_USAGE = `usage: norn billing [${BILLING_NAMES.join(' | ')}] [--usd-per-day N | off] [--keep-caps] [--budget F] [--machine F]    (no mode = show the mode in force and the modes; a plan mode sets the weekly guard, the rate cap and the worker cap that fit the plan (--keep-caps: the billing key only); api = pay per token: no weekly guard, no calibration, an optional daily $ cap. Queued runs start under the new mode: the fill reads the budget in force.)`;
function billingCmd(argv, env, out, err) {
  try {
    const mode = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
    const f = h1Flags(mode === undefined ? argv : argv.slice(1), ['usd-per-day', 'keep-caps!', 'budget', 'machine']);
    const m = machineOf({ budget: f.budget, machine: f.machine }, env), stateRoot = path.join(metaRoot(env), 'state');
    if (mode === undefined && f['usd-per-day'] === undefined) {
      out(billingLine(m.budget, null, { stateRoot, projectsDir: projectsDirOf(m.machine, env) }));
      for (const b of BILLING_MODES) out(`  ${b.name === m.budget.billing ? '*' : ' '} ${b.name.padEnd(8)} ${b.label}: ${b.summary}`);
      return 0;
    }
    const name = mode ?? m.budget.billing;
    if (!name) throw new Usage('name a mode: no billing mode is set yet', null);
    let changes;
    try { changes = billingChanges(name, { usdPerDay: f['usd-per-day'] }); } catch (e) { throw new Usage(e.message, null); }
    if (f['keep-caps']) changes = { billing: changes.billing, ...(changes.api_usd_per_day !== undefined ? { api_usd_per_day: changes.api_usd_per_day } : {}) };
    let updated;
    try { updated = applySettings(merged(m.budget, {}), floorChanges(merged(m.budget, {}), changes).changes); } catch (e) { if (e.status === 400) throw new Usage(e.message, null); throw e; }   // validated as a Settings save
    writeBudget(m.budgetFile, m.budget, updated);
    const B = { ...m.budget, ...split(updated).budget };   // GAP-2: queued runs read the budget at fill (runs.mjs liveBudget): nothing to rewrite
    out(`billing ${m.budgetFile}: ${Object.entries(changes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    out(billingLine(B, null, { stateRoot, projectsDir: projectsDirOf(m.machine, env) }));
    if (isApi(B) && usdCap(B) === null) out('note: no daily $ cap - only the worker cap limits spend (norn billing api --usd-per-day N)');
    return 0;
  } catch (e) {
    if (e instanceof Usage || e instanceof ConfigError) { err('error: ' + e.message); err(BILLING_USAGE); return 2; }
    throw e;
  }
}

// ---------- META-USAGE-WEEK: norn calib --pct N [--at <ISO UTC>] [--budget F] (an owner's claude.ai weekly reading -> the budget) ----------
const CALIB_USAGE = 'usage: norn calib --pct N (0-100) [--at <YYYY-MM-DDTHH:MMZ>, default now] [--budget F] [--machine F]    (records an owner\'s claude.ai weekly reading: calib_time_utc + calib_pct; N >= 10 re-derives cacheR_per_pct from the week start; appends usage/CALIB.txt when it exists)';
function calibCmd(argv, env, out, err) {
  try {
    const f = h1Flags(argv, ['pct', 'at', 'budget', 'machine']);
    if (f.pct === undefined) throw new Usage('--pct is required', null);
    if (!/^\d+(\.\d+)?$/.test(f.pct) || Number(f.pct) > 100) throw new Usage(`--pct must be a number 0-100 (got ${f.pct})`, null);
    const pct = Number(f.pct), now = Date.now();
    const at = f.at ?? new Date(now).toISOString().slice(0, 16) + 'Z', atMs = Date.parse(at);
    if (!Number.isFinite(atMs) || atMs > now + 60000) throw new Usage(`--at must be a past UTC instant YYYY-MM-DDTHH:MMZ (got ${at})`, null);
    const m = machineOf({ budget: f.budget, machine: f.machine }, env);
    // + the node runs imported under the state root (META-GTP-FED-2 piece 2): the same sources the status sums
    const o = { budget: m.budget, projectsDir: projectsDirOf(m.machine, env), usageJson: m.machine?.usage || {}, stateRoot: path.join(metaRoot(env), 'state') };
    const changes = { calib_time_utc: at, calib_pct: pct }, old = m.budget.cacheR_per_pct;
    const resetIso = parseReset(m.budget.reset), ws = resetIso ? weekStart(Date.parse(resetIso), atMs) : null;
    let sinceWeek = null;
    if (pct >= 10) {   // the same cacheR the status sums (accountCacheR), over [week start, --at)
      if (ws === null) throw new Usage(`the budget has no valid reset (${m.budget.reset ?? 'none'}): cannot re-derive cacheR_per_pct`, null);
      sinceWeek = crTotal(accountCacheR(o, ws)) - crTotal(accountCacheR(o, atMs));
      changes.cacheR_per_pct = Math.round(sinceWeek / pct);
    }
    let updated;
    try { updated = applySettings(merged(m.budget, {}), floorChanges(merged(m.budget, {}), changes).changes); } catch (e) { if (e.status === 400) throw new Usage(e.message, null); throw e; }   // the policy rows, as the dash Settings save
    writeBudget(m.budgetFile, m.budget, updated);
    const B = { ...m.budget, ...split(updated).budget }, n0 = x => Number(x).toLocaleString('en-US');
    const est = weeklyEstimate({ ...o, budget: B }, new Date(now));
    const perLine = pct >= 10 ? `cacheR_per_pct ${n0(old)} -> ${n0(B.cacheR_per_pct)} (cacheR ${n0(Math.round(sinceWeek / 1e5) / 10)}M since the week start ${new Date(ws).toISOString().slice(0, 16)}Z / ${pct} %)`
      : `cacheR_per_pct ${n0(old)} kept (under 10 %: too little data to re-derive)`;
    const cf = path.join(m.root, 'usage', 'CALIB.txt');
    if (fs.existsSync(cf)) {
      const txt = fs.readFileSync(cf, 'utf8'), n = Math.max(0, ...[...txt.matchAll(/^CALIBRATION (\d+) /gm)].map(x => Number(x[1]))) + 1;
      fs.appendFileSync(cf, `${txt.endsWith('\n') || !txt ? '' : '\n'}\nCALIBRATION ${n} ${at}: owner reports ${pct}% weekly (norn calib; next reset ${est.next ? est.next.slice(0, 16) + 'Z' : '?'}). ${perLine}.\n`);
      out(`${cf}: CALIBRATION ${n} appended`);
    }
    out(`calib ${m.budgetFile}: calib_time_utc ${at}, calib_pct ${pct} %; ${perLine}`);
    out(`estimated weekly now ~${est.weekly.toFixed(1)} % (${est.inWeek ? `calib ${pct} %` : 'new week: base 0 %'})`);
    return 0;
  } catch (e) {
    if (e instanceof Usage || e instanceof ConfigError) { err('error: ' + e.message); err(CALIB_USAGE); return 2; }
    throw e;
  }
}
// ---------- H4: norn notify (owner alert; backend = machine.json notify, default none) ----------
const NOTIFY_USAGE = 'usage: norn notify --title T --body B [--priority low|default|high|urgent] [--class ask|merge|alert|fyi] [--file F.png] [--project project.json | --state D] [--machine F]\n       norn notify --flush [--project project.json | --state D] [--machine F]    (fyi = batched into one notice per policy notify.batch_h, default 3 h; --flush sends the batch now)';
function notifyCmd(argv, env, out, err) {
  let f;
  try {
    f = h1Flags(argv, ['title', 'body', 'priority', 'class', 'file', 'flush!', 'project', 'state', 'machine']);
    const pf = f.project || (!f.state && env.META_PROJECT) || null;
    const project = pf ? loadProject(pf, { meta: metaRoot(env) }) : null;
    const state = project ? project.state : (f.state || env.META_STATE);
    const { machine } = machineOf({ machine: f.machine }, env);
    if (f.flush && (f.title !== undefined || f.body !== undefined || f.class !== undefined || f.file !== undefined)) throw new Usage('--flush sends the pending batch only (no --title / --body / --class)', null);
    import('../lib/notify.mjs').then(({ notify, flushNotices, batchHours }) => {
      const o = { title: f.title, body: f.body, priority: f.priority, cls: f.class, ...(f.file !== undefined ? { file: f.file } : {}), machine, state, env, batchH: batchHours(project) };
      return f.flush ? flushNotices({ ...o, force: true }).then(r => r.sent ? { ...r.result, flushed: r.count } : { none: true }) : notify(o);
    }).then(r => {
        if (r.none) out('notify: no FYI waiting');
        else if (r.batched && !r.flushed) out('notify: batched (fyi) - leaves in the next FYI digest notice');
        else out((r.sent ? `notify: sent via ${r.backend}` : 'notify: backend none (machine.json has no notify opt-in) - recorded, nothing sent') + (r.flushed ? ` (digest of ${r.flushed} FYI)` : ''));
        process.exitCode = 0; },
        e => { err('error: ' + e.message); if ((e.code ?? 1) === 2) err(NOTIFY_USAGE); process.exitCode = e.code ?? 1; });
    return undefined;
  } catch (e) {
    if (e instanceof Usage || e instanceof ConfigError) { err('error: ' + e.message); err(NOTIFY_USAGE); return 2; }
    throw e;
  }
}

// ---------- NORN-WATCH S2: norn merge-brief (the MERGE stage brief; the shots mode from the project policy merge.shots) ----------
const MERGE_USAGE = 'usage: norn merge-brief --project project.json --lane L --branch B --worktree W --notes F --out F [--ui] [--sha <READY sha>] [--locks D]    (--ui = the branch changes the dash / UI: screenshots; --sha = the staged merge of THAT commit in its merge worktree, the lane worktree untouched - required while the lane worktree holds a live run, exit 3)';
function mergeBriefCmd(argv, env, out, err) {
  try {
    const f = h1Flags(argv, ['project', 'lane', 'branch', 'worktree', 'notes', 'out', 'sha', 'locks', 'ui!']);
    if (!f.project || !f.out) throw new Usage('--project and --out are required', null);
    const p = loadProject(f.project, { meta: metaRoot(env) });
    if (!f.sha) {   // META-GTP-MERGEQ piece 0 (DEC-5): the rebase brief is refused while the lane writes
      const w = laneWriter({ state: p.state, locksDir: f.locks || path.join(path.dirname(path.resolve(p.state)), 'locks'), lane: f.lane, worktree: f.worktree });
      if (w) { out(`REFUSED: merge-brief ${f.lane}: ${w} - the brief would rebase under it; pass --sha <READY sha> (a staged merge in its merge worktree)`); return 3; }
    }
    // RM-44 D1: the door - the stored slop check of the head it merges (the --sha, else the branch's tip), run now when none fits;
    // open BLOCK findings hold the merge until fixed or waived. META-BETA-PREP: no door while the project's SloppaChoppa switch is off
    if (slopOn(p.policy)) {
      const repo = f.worktree || p.root;
      let d;
      try { d = doorCheck({ state: p.state, repo, branch: f.branch, head: f.sha || `refs/heads/${f.branch}`, projectDir: p.project_dir }); }
      catch (e) { out(`REFUSED: merge-brief ${f.branch}: the slop check could not run (${e.message.split(/\r?\n/)[0]})`); return 3; }
      if (d.open.length) { out(`REFUSED: merge-brief ${f.branch}: ${doorWhy(d).split(': ')[0]}:`); for (const b of d.open) out('  ' + findingLine(b)); return 3; }
    }
    const txt = renderMergeBrief(p, { lane: f.lane, branch: f.branch, worktree: f.worktree, notes: f.notes, ui: !!f.ui, ...(f.sha ? { sha: f.sha } : {}) });
    fs.mkdirSync(path.dirname(path.resolve(f.out)), { recursive: true });
    fs.writeFileSync(f.out, txt);
    out(`merge-brief -> ${fwd(path.resolve(f.out))} (${f.sha ? `staged ${f.sha.slice(0, 7)}, lane worktree untouched; ` : ''}shots ${f.ui ? shotsMode(p) : 'none: no UI change'})`);
    return 0;
  } catch (e) {
    err('error: ' + e.message); err(MERGE_USAGE);
    return e instanceof Usage || e instanceof ConfigError ? 2 : 1;
  }
}

// ---------- RM-7: norn merge-land (a MERGE run's tested merge goes to main as a PR per lane branch; Norn never pushes main) ----------
const LAND_USAGE = 'usage: norn merge-land --project project.json --worktree <merge worktree> --branch B [--branch B2 ..]    (exit 0: every branch has its PR to main (PR OPENED / PR ALREADY OPEN <url>), 3 NOT OPENED: some branch has none)';
function mergeLandCmd(argv, env, out, err) {
  try {
    const branches = [], rest = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== '--branch') { rest.push(argv[i]); continue; }
      if (i + 1 >= argv.length) throw new Usage('--branch needs a value', null);
      branches.push(argv[++i]);
    }
    const f = h1Flags(rest, ['project', 'worktree']);
    if (!f.project || !f.worktree || !branches.length) throw new Usage('--project, --worktree and --branch are required', null);
    const p = loadProject(f.project, { meta: metaRoot(env) });
    const rs = openProjectPrs(p, { wt: path.resolve(f.worktree), branches, run: env.META_RUN_ID || null });
    for (const r of rs) out(prLine(r));
    return rs.every(r => r.status !== 'refused') ? LAND_EXIT.opened : LAND_EXIT.refused;
  } catch (e) {
    err('error: ' + e.message); err(LAND_USAGE);
    return e instanceof Usage || e instanceof ConfigError ? 2 : 1;
  }
}

// ---------- H1: norn mcp (stdio MCP server) / norn harness install ----------
const H1_USAGE = {
  mcp: 'norn mcp --project <project.json> | --state <dir>  --profile controller|checkin|worker|chat (chat: the Norn chat only - controller tools + norn_show / norn_cli / norn_approve, by tier) | (machine-scoped, no project) --profile setup [--client <name> (stamps via chat:<name>; default mcp)]',
  harness: 'norn harness install --family claude|codex|opencode|<configured cli name> --project <project.json> | --state <dir> [--profile controller|checkin|worker] | --profile setup (machine-scoped: no project; server norn-setup) [--scope local|user|project] [--codex-config F] [--opencode-config F] [--dry-run]',
};
function h1Flags(argv, names) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const s = names.find(f => '--' + f.replace(/!$/, '') === argv[i]);
    if (!s) throw new Usage(`unexpected ${argv[i]}`, null);
    if (s.endsWith('!')) { flags[s.slice(0, -1)] = true; continue; }
    if (i + 1 >= argv.length) throw new Usage(`${argv[i]} needs a value`, null);
    flags[s] = argv[++i];
  }
  return flags;
}
function mcpCmd(argv, env, out, err) {
  let f;
  try {
    f = h1Flags(argv, ['project', 'state', 'profile', 'client']);
    // META-ADOPT A4: the setup profile serves the machine (machine.json and every project), never one project
    if (f.profile === 'setup' && (f.project || f.state)) throw new Usage('profile setup is machine-scoped: no --project / --state', null);
    if (f.profile !== 'setup' && !f.project && !f.state) throw new Usage('--project or --state is required (never taken from the environment)', null);
    const client = f.client || 'mcp';
    if (!/^[a-z0-9][a-z0-9._-]{0,30}$/.test(client)) throw new Usage(`--client must match [a-z0-9._-] (got ${JSON.stringify(client)})`, null);
    const why = refusal(f.profile, env);
    if (why) throw new Usage(why, null);
    const project = f.project ? loadProject(f.project, { meta: metaRoot(env) }) : null;
    serve({ state: project ? project.state : f.state, project, profile: f.profile, client, env, cli: main }).then(c => { process.exitCode = c; });
    return undefined;
  } catch (e) {
    if (e instanceof Usage || e instanceof ConfigError) { err('error: ' + e.message); err('usage: ' + H1_USAGE.mcp); return 2; }
    throw e;
  }
}
function harnessCmd(argv, env, out, err) {
  try {
    if (argv[0] !== 'install') throw new Usage('harness needs: install', null);
    const f = h1Flags(argv.slice(1), ['family', 'project', 'state', 'profile', 'scope', 'codex-config', 'opencode-config', 'dry-run!']);
    const plan = installPlan({ family: f.family, node: fwd(process.execPath), meta: fwd(fileURLToPath(import.meta.url)), project: f.project && fwd(path.resolve(f.project)), state: f.state && fwd(path.resolve(f.state)),
      profile: f.profile || 'controller', scope: f.scope, codexConfig: f['codex-config'], opencodeConfig: f['opencode-config'], home: env.USERPROFILE || env.HOME || '',
      claudeJson: path.join(env.CLAUDE_CONFIG_DIR || env.USERPROFILE || env.HOME || '', '.claude.json'), cwd: fwd(process.cwd()),
      executors: f.project && !FAMILIES.includes(f.family) ? loadProject(f.project).executors : undefined });
    applyPlan(plan, { dry: !!f['dry-run'], out });
    out(`${f['dry-run'] ? 'would register' : 'registered'} MCP server "${plan.name}" (${f.profile || 'controller'}) for ${plan.family}`);
    return 0;
  } catch (e) {
    if (e instanceof Usage || !(e.status || e.code)) { err('error: ' + e.message); err('usage: ' + H1_USAGE.harness); return 2; }
    err('error: ' + e.message); return 1;
  }
}

// ---------- META-GTP-HARNESS: norn executors --caps [--json] [--project P] - the capability matrix (detected yes / no per preset) ----------
const EXECUTORS_USAGE = 'norn executors --caps [--json] [--project project.json]';
function executorsCmd(argv, env, out, err) {
  try {
    const f = h1Flags(argv, ['caps!', 'json!', 'project']);
    if (!f.caps) throw new Usage('executors needs --caps', null);
    const pf = f.project || env.META_PROJECT;
    const project = pf ? loadProject(pf) : null;
    const rows = capsMatrix({ project, env });
    // META-LIMIT-GATE: an executor out of quota (the project's run records) shows its reset; norn run refuses it until then
    const lim = project?.state && fs.existsSync(project.state) ? openLimits(project.state) : {};
    for (const r of rows) { const l = lim[limitKey(r.name)]; if (l) r.out_of_quota_until = l.reset; }
    if (f.json) out(JSON.stringify(rows, null, 1));
    else {
      for (const l of formatCapsMatrix(rows)) out(l);
      for (const r of rows) if (r.out_of_quota_until) out(`${r.name}: out of quota until ${r.out_of_quota_until} (${lim[limitKey(r.name)].run}) - norn run refuses it (exit 4) until then`);
    }
    return 0;
  } catch (e) {
    if (e instanceof Usage || e instanceof ConfigError) { err('error: ' + e.message); err('usage: ' + EXECUTORS_USAGE); return 2; }
    throw e;
  }
}

// ---------- metadelegate S1: norn delegate ask / start / wait (helpers under the caller's run, or top-level with --worktree) ----------
const DELEGATE_USAGE = 'norn delegate ask|start --q "<question; cite file:line>" | --q-file F [--class chores] [--read a,b] [--executor <typed executor>|fake] [--mode <named mode; default the read-only one>] [--parent RUN-n | --worktree W (no run of your own)] [--max-s 540] [--budget-min 10] [--project project.json | --state D] [--locks D] [--machine F] [--budget F]  |  norn delegate wait RUN-a [RUN-b ...] [--max-s 540]    exit 0 = ended, 5 = still running (call wait again), 4 = cap / depth (do it yourself), 3 = parent lock not held, 2 = usage';
const DELEGATE_FLAGS = ['q', 'q-file', 'class', 'read', 'executor', 'mode', 'parent', 'worktree', 'max-s', 'budget-min', 'project', 'state', 'locks', 'machine', 'budget'];
function delegateCmd(argv, env, out, err) {
  const [sub, ...rest] = argv;
  try {
    if (!['ask', 'start', 'wait'].includes(sub)) throw new RunError(sub ? `unknown delegate subcommand ${sub}` : 'delegate needs ask | start | wait');
    const flags = {}, pos = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      if (!DELEGATE_FLAGS.includes(a.slice(2))) throw new RunError(`unknown flag ${a}`);
      if (i + 1 >= rest.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = rest[++i];
    }
    const maxS = flags['max-s'] === undefined ? ASK_MAX_S : Number(flags['max-s']);
    if (!(maxS >= 0)) throw new RunError('--max-s must be a number of seconds');
    const { project, state, locks } = where(flags, env);
    if (sub === 'wait') {
      if (!pos.length) throw new RunError('wait needs one or more RUN ids');
      const w = delegateWait({ state, runs: pos, maxS });
      for (const l of w.lines) out(l);
      return w.code;
    }
    if (pos.length) throw new RunError(`unexpected ${pos[0]}`);
    const root = metaRoot(env);
    const mf = flags.machine || path.join(root, 'local', 'machine.json');
    const machine = flags.machine || fs.existsSync(mf) ? loadMachine(mf, { meta: root }) : null;
    const bf = flags.budget || path.join(root, 'local', 'budget.json');
    const budget = flags.budget || fs.existsSync(bf) ? readJsonFile(bf) : {};
    if (flags.q !== undefined && flags['q-file'] !== undefined) throw new RunError('--q and --q-file: give one');
    if (flags['q-file'] !== undefined && !fs.existsSync(flags['q-file'])) throw new RunError(`--q-file not found: ${flags['q-file']}`);
    const q = flags['q-file'] !== undefined ? fs.readFileSync(flags['q-file'], 'utf8') : flags.q;
    const r = delegateStart({ state, locksDir: locks, env, parent: flags.parent, worktree: flags.worktree && path.resolve(flags.worktree), q, cls: flags.class, executor: flags.executor, mode: flags.mode,
      read: flags.read ? flags.read.split(',').map(x => x.trim()).filter(Boolean) : [], project, machine, budget, metaRoot: root, gitLedger: ledgerConfig(machine, { metaRoot: root, machineFile: mf }),
      budgetMin: flags['budget-min'] === undefined ? undefined : Number(flags['budget-min']), ...(env.META_HB_MS ? { hbMs: Number(env.META_HB_MS) } : {}) });
    if (sub === 'start') { out(`${r.run} helper ${r.executor}${r.mode ? ` mode ${r.mode}` : ''} out ${fwd(r.out)}`); return 0; }
    const w = delegateWait({ state, runs: [r.run], maxS });
    for (const l of w.lines) out(l);
    return w.code;
  } catch (e) {
    if (e instanceof RunRefused) { out('REFUSED: ' + e.message); return e.code; }
    if (e instanceof RunError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err('usage: ' + DELEGATE_USAGE); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// ---------- norn ask (GT-PARITY-PLAN sec. 2.6, GT-6 seance): a question to an ENDED run - a read-only fork of its session, else a cold helper ----------
const ASK_USAGE = 'norn ask RUN-n --q "<question>" | --q-file F [--max-s 540] [--cold] [--executor <typed executor>|fake (cold helper)] [--budget-min 10] [--project F] [--state D] [--locks D] [--machine F] [--budget F]';
const ASK_FLAGS = ['q', 'q-file', 'executor', 'max-s', 'budget-min', 'project', 'state', 'locks', 'machine', 'budget', 'cold!'];
function askCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const s = ASK_FLAGS.find(f => f.replace(/!$/, '') === a.slice(2));
      if (!s) throw new RunError(`unknown flag ${a}`);
      if (s.endsWith('!')) { flags[a.slice(2)] = true; continue; }
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    if (pos.length !== 1) throw new RunError(pos.length ? `unexpected ${pos[1]}` : 'ask needs one RUN id');
    const maxS = flags['max-s'] === undefined ? ASK_MAX_S : Number(flags['max-s']);
    if (!(maxS >= 0)) throw new RunError('--max-s must be a number of seconds');
    const { project, state, locks } = where(flags, env);
    const root = metaRoot(env);
    const mf = flags.machine || path.join(root, 'local', 'machine.json');
    const machine = flags.machine || fs.existsSync(mf) ? loadMachine(mf, { meta: root }) : null;
    const bf = flags.budget || path.join(root, 'local', 'budget.json');
    const budget = flags.budget || fs.existsSync(bf) ? readJsonFile(bf) : {};
    if (flags.q !== undefined && flags['q-file'] !== undefined) throw new RunError('--q and --q-file: give one');
    if (flags['q-file'] !== undefined && !fs.existsSync(flags['q-file'])) throw new RunError(`--q-file not found: ${flags['q-file']}`);
    const q = flags['q-file'] !== undefined ? fs.readFileSync(flags['q-file'], 'utf8') : flags.q;
    const r = askStart({ state, locksDir: locks, env, run: pos[0], q, executor: flags.executor, cold: !!flags.cold, project, machine, budget,
      gitLedger: ledgerConfig(machine, { metaRoot: root, machineFile: mf }), budgetMin: flags['budget-min'] === undefined ? undefined : Number(flags['budget-min']),
      ...(env.META_HB_MS ? { hbMs: Number(env.META_HB_MS) } : {}) });
    out(`${r.run} asks ${r.asked}: ${r.mode} (${r.why}) ${r.executor}`);
    const w = askWait({ state, run: r.run, dir: r.dir, maxS });
    for (const l of w.lines.slice(0, 59)) out(l);
    return w.code;
  } catch (e) {
    if (e instanceof RunRefused) { out('REFUSED: ' + e.message); return e.code; }
    if (e instanceof RunError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err('usage: ' + ASK_USAGE); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// ---------- norn deliverables (DELIVERABLES-SPEC 6): done work followed to main / the install, any harness ----------
const DLV_USAGE = 'norn deliverables [--due | --resolve | --all] [--json] | backfill [--apply [--all | --only b1,b2]] [--json] | park DLV-n --why W | unpark DLV-n | supersede DLV-n --by <DLV-m | commit sha> --why W | ask DLV-n | resolve DLV-n [--executor E] [--dry]    [--project F] [--state D] [--as role]';
const DLV_FLAGS = ['project', 'state', 'as', 'why', 'by', 'only', 'executor', 'json!', 'all!', 'due!', 'apply!', 'resolve!', 'dry!'];
function deliverablesCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const s = DLV_FLAGS.find(f => f.replace(/!$/, '') === a.slice(2));
      if (!s) throw new RunError(`unknown flag ${a}`);
      if (s.endsWith('!')) { flags[a.slice(2)] = true; continue; }
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const pf = flags.project || env.META_PROJECT || null;
    if (!pf) throw new RunError('no project: pass --project <project.json> or set META_PROJECT (the deliverables repo is project config)');
    const project = loadProject(pf);
    const state = flags.state || project.state;
    const [sub, id, ...more] = pos;
    if (more.length) throw new RunError(`unexpected ${more[0]}`);
    const by = flags.as || env.META_ROLE;
    if (!sub) {
      const v = deliverablesView({ stateDir: state, project });
      // --resolve (META-DLV-R2): the rows a check-in may dispatch a resolve run for - flagged, not native, open, none live
      const rows = v.rows.filter(r => flags.all || (flags.resolve ? r.resolve && r.native !== true && r.record_state === 'open' && !liveResolve(state, r.id) : flags.due ? r.due : !r.at_target));
      if (flags.json) { out(JSON.stringify({ rows, install: v.install, git: v.git }, null, 1)); return 0; }
      for (const r of rows) out(formatDeliverable(r));
      if (!rows.length) out(flags.resolve ? 'no deliverable to resolve' : flags.due ? 'no deliverable due' : 'nothing done-not-installed');
      return 0;
    }
    if (sub === 'backfill') {
      if (id) throw new RunError(`unexpected ${id}`);
      const plan = backfillPlan({ stateDir: state, project });
      if (flags.json) out(JSON.stringify(plan, null, 1)); else out(formatBackfill(plan));
      if (!flags.apply) { if (!flags.json) out('DRY RUN - nothing written (--apply creates the "create" rows; --apply --all also the rows without DONE evidence)'); return 0; }
      if (!by) throw new RunError('no role: pass --as <role> or set META_ROLE');
      for (const m of applyBackfill(state, plan, { by, all: !!flags.all, only: flags.only ? flags.only.split(',').map(s => s.trim()).filter(Boolean) : null })) out(`${m.id} ${m.branch}`);
      return 0;
    }
    if (sub === 'park' || sub === 'unpark') {
      if (!id) throw new RunError(`${sub} needs a DLV-n`);
      if (!by) throw new RunError('no role: pass --as <role> or set META_ROLE');
      const e = record(state, { kind: 'deliverable', ev: sub, id, by, data: sub === 'park' ? { why: flags.why } : {} }, { views: false });
      out(`${e.id} ${sub === 'park' ? 'parked' : 'open'}`);
      return 0;
    }
    if (sub === 'supersede') {   // META-GTP-MERGEQ piece 0: terminal; a cited sha must exist in the deliverable's repo
      if (!id) throw new RunError('supersede needs a DLV-n');
      if (!by) throw new RunError('no role: pass --as <role> or set META_ROLE');
      const it = loadDeliverables(state)[id];
      if (flags.by && !/^DLV-/.test(flags.by) && it && /^[0-9a-f]{7,40}$/.test(flags.by)) {
        const full = (makeGit()(it.data.repo, ['rev-parse', '--verify', '--quiet', flags.by + '^{commit}'], { allowFail: true }) || '').trim();
        if (!full) throw new RunError(`--by ${flags.by}: no such commit in ${it.data.repo}`);
      }
      const e = record(state, { kind: 'deliverable', ev: 'supersede', id, by, data: { by: flags.by, why: flags.why } }, { views: false });
      out(`${e.id} superseded by ${e.data.by}`);
      return 0;
    }
    if (sub === 'ask') {
      if (!id) throw new RunError('ask needs a DLV-n');
      if (!by) throw new RunError('no role: pass --as <role> or set META_ROLE');
      const r = askDeliverable(state, id, { project, by });
      if (r.refused) { out('REFUSED: ' + r.refused); return 3; }
      out(r.id);
      return 0;
    }
    if (sub === 'resolve') {   // META-DLV-R2: a ready resolve brief, dispatched through the normal `norn run` path (--queue)
      if (!id) throw new RunError('resolve needs a DLV-n');
      const r = resolveDeliverable(state, id, { project, executor: flags.executor || 'claude' });
      if (r.refused) { out('REFUSED: ' + r.refused); return 3; }
      const argv = [...r.run, '--project', pf, '--state', state];
      out(`${id}: ${r.why}; brief ${r.brief}`);
      if (flags.dry) { out(`DRY RUN - nothing dispatched${r.create_worktree ? ` (the worktree ${r.worktree} is made at dispatch)` : ''}: norn ${argv.join(' ')}`); return 0; }
      if (r.create_worktree) createResolveWorktree(r.worktree, r.create_worktree);
      return main(argv, env, out, err);
    }
    throw new RunError(`unknown subcommand ${sub}`);
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err('usage: ' + DLV_USAGE); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// ---------- META-OOTB F-1: norn lane new <name> [--task "<text>"] (the lane + its worktree / branch; with a task the owner directive + brief) ----------
const LANE_USAGE = 'norn lane new <name> [--task "<what the lane should do>"] [--as owner|controller|checkin] --project <project.json>    (creates the LANE record, its worktree on branch norn/<name>; --task also records an owner directive and writes the lane\'s first brief)';
const LANE_HOLD_USAGE = 'norn lane claim <name> [--min 30] [--why W] | norn lane release <name> [--why W]    [--as controller|owner] (--project <project.json> | --state <dir>)    (META-CONTROLLER C4: a hold - check-ins skip the lane until it expires or is released; their writes on it exit 5)';
const LANE_FLAGS = { new: ['task', 'project', 'as'], claim: ['project', 'state', 'as', 'min', 'why', 'via'], release: ['project', 'state', 'as', 'why', 'via'] };
function laneCmd(argv, env, out, err) {
  const [sub, ...rest] = argv, f = {}, pos = [], allowed = LANE_FLAGS[sub] || LANE_FLAGS.new, usage = LANE_FLAGS[sub] && sub !== 'new' ? LANE_HOLD_USAGE : LANE_USAGE;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    if (!allowed.includes(a.slice(2)) || i + 1 >= rest.length) { err(`error: ${i + 1 >= rest.length && allowed.includes(a.slice(2)) ? `${a} needs a value` : `unknown flag ${a}`}`); err('usage: ' + usage); return 2; }
    f[a.slice(2)] = rest[++i];
  }
  if (sub === 'claim' || sub === 'release') return laneHold(sub, pos, f, env, out, err);
  if (sub !== 'new' || pos.length !== 1) { err(sub !== 'new' ? `error: ${sub ? `unknown lane subcommand ${sub}` : 'missing subcommand'}` : 'error: lane new needs one lane name'); err('usage: ' + LANE_USAGE); return 2; }
  const pf = f.project || env.META_PROJECT;
  if (!pf) { err('error: no project: pass --project <project.json>'); err('usage: ' + LANE_USAGE); return 2; }
  try {
    const p = loadProject(pf), name = pos[0];
    const r = newLane(p, { name, task: f.task, by: f.as || 'owner' });
    out(`lane ${name}: worktree ${r.worktree} on branch ${r.branch} (${r.worktree_created ? (r.base ? `created from ${r.base}` : 'created on the existing branch') : 'exists, kept'})`);
    out(`record ${r.lane}: ${r.created ? 'created' : 'exists'}`);
    if (r.directive) out(`directive ${r.directive}: ${f.task.trim()}`);
    if (f.task !== undefined) out(`brief ${r.brief} (${r.brief_created ? 'written' : 'exists, kept'})`);
    out(`next: norn run --executor claude --lane ${name} --brief ${r.brief} --project ${p.file.replace(/\\/g, '/')}`);
    return 0;
  } catch (e) {
    if (e instanceof LaneError || e instanceof ConfigError || e instanceof RecordError) { err('error: ' + e.message); return e.code || 2; }
    throw e;
  }
}

// META-CONTROLLER C4 (SPEC sec. 2): norn lane claim / release - the hold as a record (the controller or the owner; never a check-in)
function laneHold(sub, pos, f, env, out, err) {
  if (pos.length !== 1) { err(`error: lane ${sub} needs one lane name`); err('usage: ' + LANE_HOLD_USAGE); return 2; }
  const min = f.min === undefined ? 30 : Number(f.min);
  if (!(Number.isFinite(min) && min > 0 && min <= 24 * 60)) { err('error: --min must be minutes, 1..1440'); err('usage: ' + LANE_HOLD_USAGE); return 2; }
  try {
    const { state } = where(f, env), by = f.as || env.META_ROLE || 'owner', id = laneId(pos[0], state);
    const data = { ...(f.why ? { why: f.why } : {}), ...(f.via ? { via: f.via } : {}) };
    if (sub === 'claim') data.until = new Date(Date.now() + min * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    record(state, { kind: 'lane', ev: sub, id, by, data });
    const h = holdOf(loadState(state).items[id]);
    out(sub === 'claim' ? `${id} held by ${holdWho(h)} until ${hhmm(h.until)} (${min} min): check-ins skip it` : `${id} released: the check-ins may act on it again`);
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError) { err('error: ' + e.message); err('usage: ' + LANE_HOLD_USAGE); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// ---------- OOTB F-5: norn / norn help / norn --help = this screen (grouped by job, the newcomer commands first); norn <cmd> --help = its usage ----------
// META-RENAME R1 (DIR-22): the commands a person types; the plumbing and the in-run trio are listed by `norn help --all` (they all still work)
const HELP = `Norn - a local controller for headless coding agents. Command: norn.

Start here:
  norn init <repo>                 setup when needed + project new + a drafted roadmap, rules, commands and first task to review
  norn setup                       find node, git, claude (codex); write local/machine.json; put norn on PATH
  norn project new --root <repo>   register a repository as a project (its config lives outside this clone)
  norn doctor                      check the install and every registered project
  norn smoke                       end-to-end self-test in a temp clone (nothing real starts)
  norn dash                        the local dashboard (127.0.0.1)
  norn shot <url> --out <png>      a screenshot / dashboard walk in a private, signed-out headless browser

Every day:
  norn status                      write STATUS.md: runs, caps, usage
  norn runs                        list the runs of a project (review one: norn runs review RUN-n)
  norn tick                        one controller pass now (what the scheduler runs)
  norn run                         start a worker run in a lane worktree
  norn stop                        stop a run (a queued run is withdrawn)
  norn pause                       pause check-ins / hold the queue / pause everything; pause a run safely (it hands off)
  norn resume                      resume a paused hand-off (at the front), or --all: release the pause
  norn requeue                     re-queue a queued run with new conditions or priority (its dependants follow)
  norn rec                         questions, decisions, directives, lanes: the records
  norn digest                      what needs attention now (read-only)
  norn notify                      send the owner a notice

Plan and land work:
  norn lane                        a new lane: its worktree / branch (--task: an owner directive + its first brief)
  norn flow                        start / resume a multi-step flow
  norn epic                        group runs and deliverables under one goal
  norn road                        the roadmap: themes, items, derived status, audit
  norn stuck                       stuck roadmap items: the flags, the approach-review brief, --replay
  norn proposal                    finished planner runs: rule each proposed stage queue / later / drop (the Inbox cards)
  norn adopt                       look at a repo and draft its setup: roadmap, rules, commands, caps, a first task
  norn plan                        what happens next, and when (up next, chains, landing, forecast)
  norn instructions                every file that steers the agents: load, ~tokens, cost today, hints, the measured standing context
                                   (suggest: ranked tightening candidates; confirm <file>#<anchor>: "still true"; apply <S-id>: the owner's tap)
  norn usage                        where the week's tokens went: per lane + stage, top 5 spenders (--sources: what fills the contexts)
  norn guard                        the usage guard: live runs vs their peers, open alarms (watch / rule / sources)
  norn size                         the sessions of a lane stage: floor, first edit, peak against the marks they ran under, a verdict
  norn tests                        lean tests, measured: per-test time + coverage, mutant kill sets, the merge check, the wave gate
  norn deliverables                follow finished work to main and to an install
  norn mergeq                      the merge queue of finished branches
  norn cv                          per-executor / model track record

Machine:
  norn project                     add / list / remove / new projects
  norn sched                       show / install / remove the OS scheduler
  norn remote                      reach the dashboard from your phone (Tailscale Serve): setup prints, --apply runs
  norn executors                   which executors are detected (--caps)
  norn ledger                      the git-backed ledger of the state

norn <command> --help shows its usage. norn help --all adds the in-run and plumbing commands. SETUP.md walks the first setup.`;
// `norn help --all`: the commands agents, hooks and the scheduler call (one line each)
const HELP_ALL = `
Inside a run:
  norn delegate                    hand a side question to a helper run
  norn ask                         ask a run (or a cold helper) a question
  norn mail                        messages between runs, the check-in and the controller
  norn done                        end your run: write its result (done | stopped | handoff + its hand-off text)

Plumbing:
  norn ready                       what can start now
  norn merge-brief                 write the brief of one staged merge
  norn merge-land                  open the PR of a tested merge's lane branch(es) to main (never pushes main)
  norn gen                         regenerate (or --check) the generated agent files
  norn billing                     how the Claude account is paid for: a plan (weekly limit) or API billing
  norn calib                       record a weekly usage reading
  norn harness                     install the Norn tools into an agent CLI
  norn mcp                         the stdio MCP server
  norn node                        one federation pull-agent job
  norn claim                       the multi-home work claims (list, allow a pair, release, take over a stale one)
  norn sync                        the multi-home sync (status, publish home/<id>, fetch the other homes' copies)
  norn migrate                     bring local/machine.json (or an old meta dir) to the current shape
  norn hook                        the Claude Code session hook
  norn scope                       the PreToolUse hook: what a run may touch
  norn eval                        replay check-ins against a copy of a state dir`;
function usageOf(c) {
  const u = { rec: ALL_USAGE, migrate: MIGRATE_USAGE, ...SETUP_USAGE, ...RUN_USAGE, ...S5_USAGE, dash: DASH_USAGE, smoke: 'norn smoke [--keep] [--update-goldens]',
    calib: CALIB_USAGE, billing: BILLING_USAGE, notify: NOTIFY_USAGE, 'merge-brief': MERGE_USAGE, 'merge-land': LAND_USAGE, ...H1_USAGE, executors: EXECUTORS_USAGE, delegate: DELEGATE_USAGE, ask: ASK_USAGE,
    eval: EVAL_USAGE, deliverables: DLV_USAGE, ready: READY_USAGE, plan: PLAN_USAGE, instructions: INS_USAGE, audit: AUDIT_USAGE, mergeq: MQ_USAGE, flow: FLOW_USAGE, epic: EPIC_USAGE, road: ROAD_USAGE, stuck: STUCK_USAGE, proposal: PROPOSAL_USAGE, pause: PAUSE_USAGE, resume: RESUME_USAGE, adopt: ADOPT_USAGE, init: INIT_USAGE, cv: CV_USAGE, guard: GUARD_USAGE, size: SIZE_USAGE, usage: USAGE_USAGE, mail: MAIL_USAGE, scope: SCOPE_USAGE,
    node: NODE_USAGE, claim: CLAIM_USAGE, sync: SYNC_USAGE, done: DONE_USAGE, ledger: LEDGER_USAGE, remote: REMOTE_USAGE, lane: LANE_USAGE + '\n       ' + LANE_HOLD_USAGE, shot: SHOT_USAGE }[c];
  return u && 'usage: ' + u.replace(/^usage: /, '');
}
/**
 * OOTB-R2 N-16: a `norn` run inside a Norn-launched agent inherits META_RUN_ID / META_ROLE (and META_RUN_STATE / META_STATE: the state
 * that launched it). They speak for THAT state only: --project / --state naming another one drops them (the role must then be given
 * with --as; records.mjs leaves the run unstamped there).
 */
function scopedEnv(argv, env) {
  if (!env.META_RUN_ID && !env.META_ROLE) return env;
  if (!(env.META_RUN_STATE || env.META_STATE)) return env;
  const at = f => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined; };
  let target = at('--state');
  if (!target && at('--project')) { try { target = loadProject(pickProject({ project: at('--project') }, env)).state; } catch { return env; } }
  if (!target || launchedHere(target, env)) return env;
  const { META_RUN_ID: _r, META_ROLE: _o, ...rest } = env;
  return rest;
}
export function main(argv, env = process.env, out = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n')) {
  let cmd = null;
  env = scopedEnv(argv, env);
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    if (argv[1] === '--all') { out(HELP + '\n' + HELP_ALL); return 0; }
    if (argv[0] === 'help' && argv[1]) { const u = usageOf(argv[1]); if (u) { out(u); return 0; } err(`error: unknown command ${argv[1]} - see norn help`); return 2; }
    out(HELP); return 0;
  }
  if (usageOf(argv[0]) && (argv.includes('--help') || argv[1] === '-h')) { out(usageOf(argv[0])); return 0; }
  if (argv[0] === 'deliverables') return deliverablesCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'mcp') return mcpCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'lane') return laneCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'harness') return harnessCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'executors') return executorsCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'delegate') return delegateCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'ask') return askCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'eval') {   // META-GT3: async (replays); refuses the live state dirs under <meta root>/state
    const sd = path.join(metaRoot(env), 'state');
    const live = fs.existsSync(sd) ? fs.readdirSync(sd).map(x => path.join(sd, x)) : [];
    return evalCmd(argv.slice(1), { out, err, liveStates: [...live, ...(env.META_STATE ? [env.META_STATE] : [])] });
  }
  if (['run', 'stop', 'requeue', 'hook'].includes(argv[0])) return runCmd(argv, env, out, err);
  if (['status', 'tick', 'runs', 'sched', 'digest', 'overlap'].includes(argv[0])) return s5Cmd(argv, env, out, err);
  if (argv[0] === 'migrate') return migrateCmd(argv.slice(1), env, out, err);
  if (['setup', 'doctor', 'project', 'gen'].includes(argv[0])) return setupCmd(argv, env, out, err);
  if (argv[0] === 'dash') return dashCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'remote') return remoteCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'shot') return shotCmd(argv.slice(1), out, err);
  if (argv[0] === 'smoke') return smokeCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'calib') return calibCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'billing') return billingCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'notify') return notifyCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'merge-brief') return mergeBriefCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'merge-land') return mergeLandCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'ledger') return ledgerCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'node') return nodeCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'claim') return claimCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'sync') return syncCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'epic') return epicCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'road') return roadCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'stuck') return stuckCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'proposal') return proposalCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'pause') return pauseCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'resume') return pauseCmd(argv.slice(1), env, out, err, { resume: true });
  if (argv[0] === 'adopt') return adoptCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'init') return initCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'flow') return flowCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'ready') return readyCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'plan') return planCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'instructions') return instructionsCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'audit') return auditCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'fix') return fixCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'done') return doneCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'critique') return critiqueCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'mergeq') return mergeqCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'mail') return mailCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'scope') return scopeCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'cv') return cvCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'guard') return guardCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'size') return sizeCmd(argv.slice(1), env, out, err);
  if (argv[0] === 'slop') return slopCmd(argv.slice(1), { env, out, err, where: f => (f.project || f.state || env.META_STATE || env.META_PROJECT ? where(f, env) : null) });
  if (argv[0] === 'tests') return testsCmd(argv.slice(1), { out, err, where: f => where(f, env) });
  if (argv[0] === 'usage') return usageCmd(argv.slice(1), env, out, err);
  try {
    if (argv[0] !== 'rec') { err(`error: unknown command ${argv[0]} - see norn help`); return 2; }
    let rest = argv.slice(1);
    if (rest[0] === 'add') { cmd = 'add ' + (rest[1] || ''); rest = rest.slice(2); } else { cmd = rest[0]; rest = rest.slice(1); }
    if (!cmd || !FLAGS[cmd]) { const c = cmd; cmd = null; throw new Usage(c ? `unknown subcommand ${c}` : 'missing subcommand', null); }
    const { flags, pos } = parse(cmd, rest);
    // --project / META_PROJECT (unless --state) = the project's state + its project.json views: one copy (S9)
    const pf = pickProject(flags, env);   // a path or a registered name; none = the only registered project (OOTB F-7)
    const project = pf ? loadProject(pf) : null;
    // --project + --state: --state wins, as where() (run / stop / delegate / deliverables; META-GTP-CI-LINUX FINDING L3); the
    // project.json views belong to the project's own state, so another state writes its own <state>/views
    const state = flags.state || (project ? project.state : env.META_STATE);
    const vpaths = project && path.resolve(state) === path.resolve(project.state) ? project.views || {} : {};
    if (!state) throw new Usage(`no state dir: pass --state <dir> / --project <name | project.json>${noProjectHint(env)} or set META_STATE / META_PROJECT`, cmd);
    const st = () => loadState(state);

    if (cmd === 'list') {
      if (pos.length) throw new Usage(`unexpected ${pos[0]}`, cmd);
      const kind = flags.kind && kindNamed(flags.kind);
      if (kind && !KINDS[kind]) throw new Usage(`--kind must be Q|DEC|DIR|L|RUN`, cmd);
      const items = Object.values(st().items).filter(i => (!kind || i.kind === kind) && (!flags.lane || i.data.lane === flags.lane || i.id === laneId(flags.lane, state)) && (!flags.open || isOpen(i))).sort(order);
      if (flags.json) out(JSON.stringify(items.map(({ history, ...i }) => i), null, 1));
      else for (const i of items) out(`${i.id}\t${i.state}${i.review ? ' reviewed' : ''}\t${i.data.lane ?? ''}\t${title(i)}`.replace(/\t/g, '  '));
      return 0;
    }
    if (cmd === 'show') {
      if (pos.length !== 1) throw new Usage('show needs one ID', cmd);
      const it = st().items[pos[0]];
      if (!it) throw new Usage(`${pos[0]} does not exist`, cmd);
      if (flags.json) out(JSON.stringify(it, null, 1));
      else {
        out(`${it.id} ${it.kind} ${it.state}: ${flags.full ? title(it) : shortData(String(title(it)))}`);
        for (const h of it.history) out(`  #${h.seq} ${h.ts} ${h.ev} by ${h.by}${h.run ? ' (' + h.run + ')' : ''} ${JSON.stringify(flags.full ? h.data : shortData(h.data))}`);
      }
      return 0;
    }
    if (cmd === 'views') {
      const v = writeViews(state, loadState(state), vpaths, { role: 'norn rec views' }), qv = writeQueueView(state, vpaths, { ready: readiness(state), role: 'norn rec views' });
      for (const k of ['written', 'unchanged', 'refused']) v[k].push(...qv[k]);
      // META-GTP-CV piece 2: CV.md with the other views (the CV of this state; a hand edit refused like every view): views.cv, else beside
      // the project.json views (one copy, S9), else <state>/views
      const vp0 = Object.values(vpaths)[0], cvFile = vpaths.cv || (vp0 ? path.join(path.dirname(vp0), 'CV.md') : null);
      const cvv = writeCvView(state, renderCv(cvOf([{ project, state }], { m: machineOf({}, env), env })), cvFile);
      for (const k of ['written', 'unchanged', 'refused']) v[k].push(...cvv[k]);
      warnViews(v, err);
      return v.refused.length ? 1 : 0;
    }

    const by = flags.as || env.META_ROLE;
    if (!by) throw new Usage('no role: pass --as <role> or set META_ROLE', cmd);
    if (cmd === 'answer' && flags.each !== undefined) return answerEach(state, flags, pos, by, vpaths, out, err);
    let ev;
    if (cmd.startsWith('add ')) {
      if (pos.length) throw new Usage(`unexpected ${pos[0]}`, cmd);
      const kind = cmd.slice(4);
      ev = { kind, ev: 'create', by, data: addData(kind, flags, cmd, by) };
    } else {
      if (pos.length !== 1) throw new Usage(`${cmd} needs one ID`, cmd);
      const kind = kindOfId(pos[0]);
      if (!kind) throw new Usage(`${pos[0]} is not a record id (Q-n, DEC-n, DIR-n, L:name)`, cmd);
      ev = { kind, ev: cmd === 'not-an-answer' ? 'notanswer' : cmd, id: pos[0], by, data: eventData(cmd, flags, by) };
    }
    if (flags.item) {   // META-ROADMAP S3: --item RM-n (add lane only) - checked before the lane exists
      try { openItem(state, flags.item); } catch (x) { throw new Usage(x.message, cmd); }
      if (!KINDS.item.events.link.roles.includes(by)) throw new Usage(`role ${by} may not link roadmap items`, cmd);
    }
    if (cmd === 'add directive') {   // gap #5: a restatement of an active directive is refused (exit 3) unless --new; --new keeps the pair out of the digest
      const dup = dupOf(st().items, ev.data.text ?? '');
      if (dup && !flags.new) { err('error: ' + dupMessage(dup)); return 3; }
      if (dup) ev.data.distinct_from = [dup.id];
    }
    let views = { refused: [] };
    const e = record(state, ev, { views: vpaths, onViews: v => { views = v; } });
    if (flags.item) linkItem(state, flags.item, 'lane:' + ev.data.name, by, err);
    out(cmd.startsWith('add ') ? e.id : `${e.id} ${loadState(state).items[e.id].state}`);
    if (cmd === 'add decision' && ev.data.answers && ev.data.owner_words) out(`${ev.data.answers} ${loadState(state).items[ev.data.answers]?.state}`);   // META-Q-RECONCILE R1
    warnViews(views, err);
    return 0;
  } catch (e) {
    if (e instanceof Usage || (e instanceof RecordError && e.code === 2)) {
      err('error: ' + e.message);
      err(cmd && USAGE[cmd] ? 'usage: ' + USAGE[cmd] : ALL_USAGE);
      return 2;
    }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    if (e.code === 'ENOENT') { err('error: ' + e.message); err(cmd && USAGE[cmd] ? 'usage: ' + USAGE[cmd] : ALL_USAGE); return 2; }
    throw e;
  }
}

// ---------- META-GTP-DAG piece 3: norn ready - every queued run, ready | blocked + its unmet terms (the fill's own walk, dry; read-only) ----------
const READY_USAGE = 'norn ready [--json] [--epic EP-n] [--project F | --state D] [--locks D]';
// ---------- META-GTP-MERGEQ: norn mergeq - the merge queue (MR score order; code only, no LLM) ----------
const MQ_USAGE = 'norn mergeq [--json] [--update | --run | --batching on|off --why W] [--project F] [--state D] [--locks D]    (DONE-not-merged deliverables in Gas Town MR-score order: score, priority / epic, gate kind door | batch | stage, merge rehearsal, behind, target; --update merges main into every idle branch behind it and pushes - never a force-push; --run = --update + one batch where merge.gate.fast: build mq/batch-<n>, gate, retry once, bisect, the MERGE brief / fix ask; else the mechanical landing: merge the top clean pushed row in a merge worktree, run the quick check (syntax + its changed test files), open its PR - a conflict, red check or slop block queues its MERGE run; --batching = the kill switch)';
function mergeqCmd(argv, env, out, err) {
  try {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (['--json', '--update', '--run'].includes(a)) { flags[a.slice(2)] = true; continue; }
      if (!['--project', '--state', '--locks', '--batching', '--why'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const pf = flags.project || env.META_PROJECT || null;
    if (!pf) throw new RunError('no project: pass --project <project.json> or set META_PROJECT');
    const project = loadProject(pf);
    const state = flags.state || project.state;
    if (flags.batching) {   // the kill switch (piece 3): off with a why; on resets the unpinned count
      if (!['on', 'off'].includes(flags.batching)) throw new RunError('--batching takes on | off');
      if (flags.batching === 'off' && !flags.why) throw new RunError('--batching off needs --why');
      const m = setBatching(state, flags.batching === 'on', flags.why);
      out(`batching ${m.batching.off ? 'OFF: ' + m.batching.why : 'on'}`);
      return 0;
    }
    if (flags.run) {   // piece 3: one merge-queue pass (async: the gate runs)
      // MERGE-FIRST (3): a landing's fallback MERGE (norn run --queue) and its notice go through this CLI, in a child (as the tick's routine stage)
      const cli = args => { const c = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, ...env } }); return { code: c.status ?? 1, out: `${c.stdout || ''}${c.stderr || ''}`.trim() }; };
      return mergeqRun({ stateDir: state, project, locksDir: flags.locks, cli }).then(r => {
        if (flags.json) { out(JSON.stringify(r, null, 1)); return 0; }
        for (const u of r.updates) if (u.action !== 'skip') out(`${u.id} ${u.branch} update ${u.action}: ${u.why}`);
        for (const id of r.land?.landed || []) out(`LANDED ${id}`);
        for (const f of r.land?.fallback || []) out(`MERGE ${f.id} (${f.kind}): ${f.queued || 'not queued'}`);
        out(`mergeq: ${r.why}`);
        if (r.batch?.dispatch && r.batch.status === 'green') out(`MERGE: norn ${r.batch.dispatch.join(' ')}`);
        if (r.fix) out(`FIX ${r.fix.id}: norn ${r.fix.run.join(' ')}`);
        // a green batch / fix ask is a check-in fact (mqProbe): tick now, as a run exit does (META_NO_TICK: none)
        if (!env.META_NO_TICK && ((r.batch?.status === 'green' && r.batch.done_at) || r.fix)) {
          const c = spawn(process.execPath, [fileURLToPath(import.meta.url), 'tick', '--reason', 'mergeq', '--project', project.file, '--state', state], { detached: true, stdio: 'ignore', windowsHide: true });
          c.unref();
          out('tick: started (the check-in sees the batch / fix ask)');
        }
        return 0;
      });
    }
    if (flags.update) {   // piece 2: auto-update (code only)
      const res = updatePass({ stateDir: state, project, locksDir: flags.locks });
      if (flags.json) { out(JSON.stringify({ update: res }, null, 1)); return 0; }
      for (const r of res) out(`${r.id} ${r.branch} update ${r.action}: ${r.why}`);
      if (!res.length) out('merge queue empty');
      return 0;
    }
    const q = mergeQueue({ stateDir: state, project });
    const s = mqSummary(state);
    if (flags.json) { out(JSON.stringify({ rows: q.rows, held: q.held, gate: q.cfg.gate, batch_max: q.cfg.batch_max, mq: s.mq, batch: s.batch }, null, 1)); return 0; }
    if (q.cfg.gate?.fast) for (const l of s.lines) out(l);
    for (const r of q.rows) out(formatMq(r));
    if (!q.rows.length) out('merge queue empty');
    for (const h of q.held) out(`HELD ${h.id} ${h.branch}: ${h.why}`);   // META-CATCH S2: a look item's row waits for its picture proof
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError) { err('error: ' + e.message); err('usage: ' + MQ_USAGE); return 2; }
    throw e;
  }
}

function readyCmd(argv, env, out, err) {
  try {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json') { flags.json = true; continue; }
      if (!['--epic', '--project', '--state', '--locks'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const { state } = where(flags, env);
    let rows = readiness(state);
    if (flags.epic) {
      const ep = loadEpics(state)[flags.epic];
      if (!ep) throw new RunError(`${flags.epic} does not exist`);
      const members = new Set(epicMembers(ep));
      rows = rows.filter(r => r.epic === flags.epic || members.has(r.id));
    }
    if (flags.json) { out(JSON.stringify(rows, null, 1)); return 0; }
    for (const r of rows) out(`${r.id}  ${r.name ?? '-'}  lane ${r.lane ?? '-'}${r.stage ? ' ' + r.stage : ''}  ${r.priority ?? '-'}${r.epic ? ' ' + r.epic : ''}  ${readyWords(r)}`);
    if (!rows.length) out('no queued run');
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError) { err('error: ' + e.message); err('usage: ' + READY_USAGE); return 2; }
    throw e;
  }
}

// ---------- META-PLAN R1: norn plan - up next, chains, landing next, forecast (engine/lib/plan.mjs; read-only) ----------
const PLAN_USAGE = 'norn plan [--json] [--project F | --state D] [--budget F]';
function planCmd(argv, env, out, err) {
  try {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json') { flags.json = true; continue; }
      if (!['--project', '--state', '--budget'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const { project, state } = where(flags, env);
    const bf = flags.budget || path.join(metaRoot(env), 'local', 'budget.json');
    const budget = fs.existsSync(bf) ? readJsonFile(bf) : {};
    const p = loadPlan({ state, project, budget });
    out(flags.json ? JSON.stringify(p, null, 1) : formatPlan(p));
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError) { err('error: ' + e.message); err('usage: ' + PLAN_USAGE); return 2; }
    throw e;
  }
}

// ---------- META-INSTRUCTIONS R1: norn instructions - every file that steers the agents, its load, ~tokens, cost today, hints ----------
const INS_USAGE = 'norn instructions [--json] | suggest [--json] | confirm <file>#<anchor | L<line>> [--why "..."] [--as role] | apply <S-id> [--dry-run] [--as role]'
  + '    [--project F | --state D] [--machine F]    (the list and suggest are read-only; confirm writes a record, never the file; apply = the owner\'s tap)';
function instructionsCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json' || a === '--dry-run') { flags[a.slice(2)] = true; continue; }
      if (!a.startsWith('--')) { pos.push(a); continue; }
      if (!['--project', '--state', '--machine', '--why', '--as'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const [verb, arg, extra] = pos;
    if (verb && !['suggest', 'confirm', 'apply'].includes(verb)) throw new RunError(`unexpected ${verb}`);
    if (extra || (verb === 'suggest' && arg) || ((verb === 'confirm' || verb === 'apply') && !arg)) throw new RunError(verb === 'suggest' || extra ? `unexpected ${extra || arg}` : `norn instructions ${verb} needs ${verb === 'confirm' ? '<file>#<anchor>' : '<S-id>'}`);
    const { project, state } = where(flags, env);
    if (!project) throw new RunError('norn instructions needs --project (the files come from project.json)');
    const role = flags.as || env.META_ROLE || 'owner';
    if (verb === 'confirm') {
      const at = arg.lastIndexOf('#');
      if (at < 1) throw new RunError('confirm needs <file>#<anchor> (p<8 hex>, or L<line>)');
      const file = path.resolve(arg.slice(0, at)), anchor = arg.slice(at + 1), text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (text == null) throw new RunError(`${file} does not exist`);
      const ps = paragraphs(text, null), ln = anchor.match(/^L(\d+)$/)?.[1];
      const p = ln ? ps.find(x => x.line <= Number(ln) && Number(ln) <= x.end) : ps.find(x => x.anchor === anchor);
      if (!p) throw new RunError(`no paragraph ${anchor} in ${file}`);
      const ev = record(state, { kind: 'confirm', ev: 'create', by: role, data: { file: file.replace(/\\/g, '/'), anchor: p.anchor, line: p.line, head: p.head, ...(flags.why ? { why: flags.why } : {}) } });
      out(`${ev.id} confirmed ${file.replace(/\\/g, '/')}#${p.anchor} (line ${p.line}): "${p.head.slice(0, 60)}" - its age restarts today`);
      return 0;
    }
    const mf = flags.machine || path.join(metaRoot(env), 'local', 'machine.json');
    const machine = fs.existsSync(mf) ? loadMachine(mf, { meta: metaRoot(env) }) : null;
    const v = instructionsView({ ...project, state }, { machine, home: machine?.home || (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir() });
    if (verb === 'apply') {
      let r;
      try { r = applySuggestion(v, arg, { role, dryRun: !!flags['dry-run'] }); } catch (e) { throw new RunError(e.message); }
      out(`${r.applied ? 'applied' : 'dry run'}: ${r.id} - ${r.removed} line(s) removed from ${r.path}`);
      return 0;
    }
    if (verb === 'suggest') { out(flags.json ? JSON.stringify({ project: v.project, day: v.day, measured: v.measured, stale_days: v.stale_days, suggest: v.suggest }, null, 1) : formatSuggest(v)); return 0; }
    out(flags.json ? JSON.stringify(v, null, 1) : formatInstructions(v));
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError || e instanceof RecordError) { err('error: ' + e.message); err('usage: ' + INS_USAGE); return 2; }
    throw e;
  }
}

// ---------- META-DOD 3: norn critique --run RUN-n (the plan review; the supervisor calls it when a planning run ends DONE) ----------
const CRITIQUE_USAGE = 'norn critique --run RUN-n --project <name | project.json> [--state D] [--locks D] [--machine F] [--budget F] [--no-tick]    (queues ONE read-only review of the plan run\'s NOTES on the policy review executor, per policy.dod.critique)';
function critiqueCmd(argv, env, out, err) {
  try {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--no-tick') { flags['no-tick'] = true; continue; }
      if (!['--run', '--project', '--state', '--locks', '--machine', '--budget'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    if (!flags.run) throw new RunError('--run RUN-n is required (the plan run)');
    const w = where(flags, env), { project, state } = w;
    if (!project) throw new RunError('norn critique needs --project (the policy and the review executor come from project.json)');
    const items = loadState(state).items, it = items[flags.run], skip = critiqueSkip(it, items, project.policy);
    if (skip) { out(`SKIPPED ${flags.run}: ${skip}`); return 0; }
    const plan = String(it.data.notes).replace(/\\/g, '/'), files = critiqueFiles(plan), pick = classExecutor(project, 'review');
    fs.writeFileSync(files.brief, critiquePrompt({ plan, brief: it.data.brief, filter: project.policy?.dod?.critique_filter, findings: files.findings }));
    const o = runSpec({ executor: pick.executor, agent: pick.agent, model: pick.model, effort: pick.effort, class: 'review', lane: it.data.lane, stage: 'REVIEW',
      brief: files.brief, worktree: it.data.worktree, notes: files.findings, machine: flags.machine, budget: flags.budget, 'no-tick': flags['no-tick'], as: 'launcher' }, env, w);
    const r = startRun({ ...o, readonly: true, critique: { of: it.id, plan }, queue: true });
    out(`${r.queued ? 'QUEUED' : 'STARTED'} ${r.run} review of ${it.id} (${plan}): ${o.executor}${o.agent ? ' ' + o.agent : ''} ${o.model ?? '-'} ${o.effort ?? '-'}, read-only; findings -> ${files.findings}`);
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError || e instanceof RecordError || e instanceof RunRefused) { err('error: ' + e.message); err('usage: ' + CRITIQUE_USAGE); return 2; }
    throw e;
  }
}

// ---------- META-TEND P5: norn audit start | list (the vendor prompt audit as a read-only run of kind audit) ----------
const AUDIT_USAGE = 'norn audit start [--queue] | list [--json]    --project <name | project.json> [--state D] [--machine F] [--budget F]    (start = a read-only claude run of `/doctor prompt-audit <the project steering files>`; its report + diff become hunk cards; nothing is edited)';
function auditCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json' || a === '--queue') { flags[a.slice(2)] = true; continue; }
      if (!a.startsWith('--')) { pos.push(a); continue; }
      if (!['--project', '--state', '--machine', '--budget', '--as'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const [verb, extra] = pos;
    if (!['start', 'list'].includes(verb) || extra) throw new RunError(verb ? `unexpected ${extra || verb}` : 'start or list');
    const w = where(flags, env), { project, state } = w;
    if (!project) throw new RunError('norn audit needs --project (the steering files come from project.json)');
    const mf = flags.machine || path.join(metaRoot(env), 'local', 'machine.json');
    const machine = fs.existsSync(mf) ? loadMachine(mf, { meta: metaRoot(env) }) : null;
    const p = { ...project, state }, home = machine?.home || (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || os.homedir();
    const rows = discover(p, { home, machine });
    if (verb === 'list') {
      const items = loadState(state).items, v = auditsView(p, items, { rows, cards: openCards(state, items), machine });
      if (flags.json) { out(JSON.stringify(v, null, 1)); return 0; }
      out(`${v.rule.mode}: ${v.rule.why}`);
      for (const t of v.triggers) out(`trigger ${t.key}: ${t.why}`);
      for (const a of v.runs) out(`${a.id} ${a.created.slice(0, 16)} ${a.state}${a.outcome ? ' ' + a.outcome : ''}: ${a.accepted + a.declined + a.open} hunks (${a.accepted} accepted, ${a.declined} declined, ${a.open} open)`);
      if (!v.runs.length) out('no audit has run yet: ' + v.command);
      return 0;
    }
    const scope = auditScope(rows, p);
    if (!scope.length) throw new RunError(`${project.name}: no steering files in scope (the repo, the project folder, the memory)`);
    fs.mkdirSync(auditsDir(state), { recursive: true });
    const notes = path.join(auditsDir(state), `audit-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}.md`);
    const brief = notes.replace(/\.md$/, '.brief.md');   // the record of what ran (the model gets the prompt itself, never this file)
    fs.writeFileSync(brief, `# Audit of ${project.name} (read-only, the vendor prompt audit)\n\nprompt: ${auditPrompt(scope)}\n\nscope (${scope.length} files):\n${scope.map(f => `- ${f}`).join('\n')}\n`);
    const o = runSpec({ executor: 'claude', lane: 'audit', stage: 'audit', brief, worktree: project.root, notes, model: AUDIT_MODEL, effort: AUDIT_EFFORT, machine: flags.machine, budget: flags.budget, as: flags.as }, env, w);
    const r = startRun({ ...o, kind: 'audit', readonly: true, promptText: auditPrompt(scope), ...(flags.queue ? { queue: true } : {}) });
    writeStamp(state, { ...auditStamp(p, rows, { machine, run: r.run }), scope });
    out(`${r.queued ? 'QUEUED' : 'STARTED'} ${r.run} audit of ${project.name}: ${scope.length} steering files, read-only, ${AUDIT_MODEL} ${AUDIT_EFFORT}; report -> ${notes.replace(/\\/g, '/')}`);
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError || e instanceof RecordError || e instanceof RunRefused) { err('error: ' + e.message); err('usage: ' + AUDIT_USAGE); return 2; }
    throw e;
  }
}


// ---------- META-UX-BUILD S7: norn fix start DIR-n (the fixer run of a Fix all directive; the tick starts it by code) ----------
const FIX_USAGE = 'norn fix start DIR-n [--queue] [--json] [--project F | --state D] [--machine F] [--budget F] [--as role]   (the tick runs it for every active Fix all directive: a check-in never reads the ids)';
function fixCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json' || a === '--queue') { flags[a.slice(2)] = true; continue; }
      if (!a.startsWith('--')) { pos.push(a); continue; }
      if (!['--project', '--state', '--machine', '--budget', '--as'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const [verb, id, extra] = pos;
    if (verb !== 'start' || !id || extra) throw new RunError('start DIR-n');
    const w = where(flags, env), { project, state } = w;
    if (!project) throw new RunError('norn fix needs --project (the files the findings name are in its repo)');
    const items = loadState(state).items, d = items[id];
    if (!d || d.kind !== 'directive' || !d.data?.fixall) throw new RunError(`${id} is not a Fix all directive`);
    const batch = fixBatch(withDefaults({ policy: project.policy }).policy), pick = classExecutor(project, 'docs');   // the project policy (Settings): the docs route the dash names
    const plan = fixPlan(d, items, { batch, readBrief: readRunBrief });
    if (!plan.next) { out(`${id}: nothing to start (${plan.live ? `fixer run ${plan.live} is ${items[plan.live]?.state}` : d.state !== 'active' ? `the directive is ${d.state}` : plan.left.length ? `${plan.left.length} left: the tap approved ${plan.approved} run(s), all ran` : 'every finding taken'})`); return 0; }
    const ff = findingsFile(state, id);
    if (!fs.existsSync(ff)) throw new RunError(`${id}: no findings file yet (${ff.replace(/\\/g, '/')}): the dashboard writes it when it draws the guard view`);
    const kept = new Map(readJsonFile(ff).rows.map(r => [r.id, r])), rows = plan.next.map(x => kept.get(x)).filter(Boolean);
    if (!rows.length) throw new RunError(`${id}: none of the next batch's ids is in ${path.basename(ff)}`);
    const dec = items[d.data.fixall], stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const notes = path.join(fixerDir(state), `${id}-${stamp}.md`), brief = notes.replace(/\.md$/, '.brief.md');
    const text = fixerBrief({ project: project.name, dir: id, dec: dec?.id ?? d.data.fixall, rows, picks: dec?.data?.picks || [], root: project.root });
    // another directive's fixer holds the lane: refuse before the brief is written (a refused start left an orphan brief per tick)
    const hold = duplicateOf({ state, lane: FIX_LANE, stage: 'fixer', kind: 'audit' });
    if (hold) throw new RunRefused(`${id}: fixer ${hold.id} is ${hold.state} (one fixer run at a time): this one starts after it`, 3);
    fs.mkdirSync(fixerDir(state), { recursive: true });
    fs.writeFileSync(brief, text);
    const o = runSpec({ executor: pick.executor, agent: pick.agent, model: pick.model, effort: pick.effort, lane: FIX_LANE, stage: 'fixer', class: 'docs', brief, worktree: project.root, notes, machine: flags.machine, budget: flags.budget, as: flags.as }, env, w);
    const r = startRun({ ...o, kind: 'audit', readonly: true, promptText: fixerPrompt(brief), ...(flags.queue ? { queue: true } : {}) });
    const msg = { run: r.run, queued: !!r.queued, directive: id, batch: rows.length, left: plan.left.length - rows.length, brief: brief.replace(/\\/g, '/') };
    out(flags.json ? JSON.stringify(msg) : `${r.queued ? 'QUEUED' : 'STARTED'} ${r.run} fixer of ${id}: ${rows.length} finding(s), read-only, docs class (${[o.executor, o.agent, o.model, o.effort].filter(Boolean).join(' ')}); ${msg.left} left after it; answer -> ${notes.replace(/\\/g, '/')}`);
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError || e instanceof RecordError || e instanceof RunRefused) { err('error: ' + e.message); err('usage: ' + FIX_USAGE); return 2; }
    throw e;
  }
}
// ---------- gap #3: norn done (a run's own result: the ONLY source of its outcome; NOTES are its free-form log) ----------
const DONE_USAGE = 'norn done [--outcome done|stopped|handoff] [--why "<why>" (stopped: required)] [--handoff-file F | --handoff "<text>" (handoff: required)] [--summary "<one line>"] [--look <image> (done: the picture proof of a look item)] [--run RUN-n --state D (default: $META_RUN_ID, $META_RUN_STATE)]'
  + '   (inside a run, as its last step: writes $META_RESULT_DIR = <state>/results/RUN-n/ (result.json, HANDOFF.md); a run that never runs it ends no-result)';
const fwdSlash = p => String(p).replace(/\\/g, '/');
function doneCmd(argv, env, out, err) {
  try {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!['--outcome', '--why', '--summary', '--handoff', '--handoff-file', '--look', '--run', '--state'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    // a run speaks for itself: inside a run (META_RUN_ID) --run may only repeat its own id
    if (flags.run && env.META_RUN_ID && flags.run !== env.META_RUN_ID) throw new RunError(`--run ${flags.run}: a run ends itself only (META_RUN_ID=${env.META_RUN_ID})`);
    const run = flags.run || env.META_RUN_ID, state = flags.state || env.META_RUN_STATE;
    if (!run) throw new RunError('no run: give --run RUN-n (inside a run, $META_RUN_ID names it)');
    if (!state) throw new RunError('no state: give --state D (inside a run, $META_RUN_STATE names it)');
    if (!fs.existsSync(path.join(state, 'runs', `${run}.spec.json`))) throw new RunError(`${run} is not a run of ${fwdSlash(state)} (no runs/${run}.spec.json)`);
    if (flags.handoff !== undefined && flags['handoff-file'] !== undefined) throw new RunError('--handoff and --handoff-file: give one');
    let handoff = flags.handoff;
    if (flags['handoff-file'] !== undefined) { try { handoff = fs.readFileSync(flags['handoff-file'], 'utf8'); } catch (e) { throw new RunError(`--handoff-file ${flags['handoff-file']}: ${e.code || e.message}`); } }
    // the supervisor's directory when it is this run's (META_RESULT_DIR), else the state's
    const dir = (env.META_RESULT_DIR && env.META_RUN_ID === run ? env.META_RESULT_DIR : null) || resultDir(state, run);
    const r = writeResult(dir, { run, outcome: flags.outcome, why: flags.why, summary: flags.summary, handoff, look: flags.look });
    out(`${run} ${r.outcome.toUpperCase()}${r.why ? `: ${r.why}` : ''} -> ${fwdSlash(path.join(dir, 'result.json'))}${r.handoff ? ` + ${r.handoff}` : ''}`);
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ResultError) { err('error: ' + e.message); err('usage: ' + DONE_USAGE); return 2; }
    throw e;
  }
}
// ---------- META-GTP-FLOW piece 2: norn flow start | status | resume (engine/flows/<name>.json = an epic of chained queued runs) ----------
const FLOW_USAGE = 'norn flow start <name> [--var k=v]... [--priority P0-P4] [--executor X (every step; tests: fake)] [--dry-run] | status EP-n [--json] | resume EP-n [--var k=v]... [--executor X] [--dry-run]    [--flows-dir D] [--briefs-dir D (default project briefs_dir, else <state>/briefs)] [--project F | --state D] [--locks D] [--machine F] [--budget F] [--no-tick] [--as role]';
const FLOW_FLAGS = ['project', 'state', 'locks', 'machine', 'budget', 'as', 'var*', 'executor', 'priority', 'flows-dir', 'briefs-dir', 'dry-run!', 'json!', 'no-tick!'];
function flowCmd(argv, env, out, err) {
  try {
    const flags = { var: [] }, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const k = FLOW_FLAGS.find(x => x.replace(/[!*]$/, '') === a.slice(2));
      if (!k) throw new RunError(`unknown flag ${a}`);
      if (k.endsWith('!')) { flags[a.slice(2)] = true; continue; }
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      if (k.endsWith('*')) flags[a.slice(2)].push(argv[++i]); else flags[a.slice(2)] = argv[++i];
    }
    const [sub, name, ...more] = pos;
    if (!['start', 'status', 'resume'].includes(sub)) throw new RunError(sub ? `unknown subcommand ${sub}` : 'missing subcommand');
    if (!name) throw new RunError(`${sub} needs ${sub === 'start' ? 'a flow name' : 'an EP-n'}`);
    if (more.length) throw new RunError(`unexpected ${more[0]}`);
    const given = {};
    for (const kv of flags.var) { const m = kv.match(/^(\w+)=([\s\S]*)$/); if (!m) throw new RunError(`--var ${kv}: want k=v`); given[m[1]] = m[2]; }
    const { project, state, locks } = where(flags, env);
    const dir = flags['flows-dir'] || FLOWS_DIR, root = metaRoot(env);
    const ctx = { briefs_dir: flags['briefs-dir'] || project?.briefs_dir || path.join(state, 'briefs'), norn: `node "${fwd(root)}/engine/bin/norn.mjs"`, project };
    const ov = flags.executor;
    const launch = (s, { after, brief, epic, flow }) => {
      const rf = { executor: ov || s.executor, lane: s.lane, brief, worktree: s.worktree, notes: s.notes, stage: s.stage, 'budget-min': String(s.budget_min),
        agent: s.agent, model: ov ? undefined : s.model, effort: ov ? undefined : s.effort, machine: flags.machine, budget: flags.budget, 'no-tick': flags['no-tick'] };
      const o = { ...runSpec(rf, env, { project, state, locks }), after, epic, flow };
      return startRun(after.length ? o : { ...o, queue: true });   // no need = starts at once (a full cap / the usage guard queues it)
    };
    const row = s => `  ${s.id}  ${s.run ?? '-'}  ${s.run ? (s.queued ? `QUEUED (${s.why})` : 'STARTED') : 'dry'}${s.after.length ? `  after ${s.after.join(',')}` : ''}  ${fwd(s.brief)}`;
    const fills = () => { if (!flags['dry-run']) for (const q of fillQueue(state)) out(`queue: ${q.queued} -> STARTED ${q.next}`); };
    if (sub === 'start') {
      const by = flags.as || env.META_ROLE;
      if (!by && !flags['dry-run']) throw new RunError('no role: pass --as <role> or set META_ROLE');
      const r = startFlow(loadFlow(name, { dir }), given, { state, by, ctx, priority: flags.priority, dryRun: flags['dry-run'], launch });
      out(`${r.epic ?? '(dry run)'} flow ${name} ${r.priority}: ${r.title}`);
      for (const s of r.steps) out(row(s));
      fills();
      return 0;
    }
    if (sub === 'status') {
      const s = flowStatus(state, name, { dir });
      const { f: _f, ...rest } = s;
      if (flags.json) { out(JSON.stringify(rest, null, 1)); return 0; }
      out(`${s.epic} flow ${s.flow} ${s.state}: ${s.title}  ${s.steps.filter(x => ['done', 'passed'].includes(x.state)).length}/${s.steps.length}${s.done ? '  DONE' : ''}`);
      for (const x of s.steps) out(`  ${x.id}  ${x.run ?? '-'}  ${x.state}${x.why && x.state === 'gone' ? `: ${x.why}` : ''}${x.ask_q ? ` (${x.ask_q})` : ''}  ${x.title}`);
      return 0;
    }
    const r = resumeFlow(state, name, given, { dir, ctx, launch, dryRun: flags['dry-run'] });
    if (!r.target) { out(`${name}: nothing to resume (no STOPPED / withdrawn step)`); return 0; }
    out(`${name} resume from ${r.target}${r.dry ? ' (dry run)' : ''}`);
    for (const s of r.steps) out(r.dry ? `  ${s.id}` : row(s));
    fills();
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof FlowError || e instanceof EpicError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err('usage: ' + FLOW_USAGE); return 2; }
    if (e instanceof RunRefused) { out('REFUSED: ' + e.message); return e.code; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// ---------- META-GTP-DAG piece 2: norn epic add | member | close | show | list (records in epics.jsonl; done is derived) ----------
const EPIC_USAGE = 'norn epic add --title T --priority P0|P1|P2|P3 [--members RUN-n,DLV-n] [--integration-branch B] | member EP-n [--add ids] [--remove ids] | close EP-n [--why W] | show EP-n [--json] | list [--open] [--json]    [--project F | --state D] [--as role]';
const EPIC_FLAGS = ['project', 'state', 'as', 'title', 'priority', 'members', 'integration-branch', 'add', 'remove', 'why', 'json!', 'open!'];
function epicCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const k = EPIC_FLAGS.find(x => x.replace(/!$/, '') === a.slice(2));
      if (!k) throw new RunError(`unknown flag ${a}`);
      if (k.endsWith('!')) { flags[a.slice(2)] = true; continue; }
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const { state } = where(flags, env);
    const [sub, id, ...more] = pos;
    if (more.length) throw new RunError(`unexpected ${more[0]}`);
    const ids = v => (v ? v.split(',').map(x => x.trim()).filter(Boolean) : []);
    const fmt = s => `${s.id}  ${s.state}  ${s.priority}  ${s.members.filter(m => m.done).length}/${s.members.length}${s.done ? '  DONE' : ''}  ${s.title}`;
    if (sub === 'list') {
      if (id) throw new RunError(`unexpected ${id}`);
      const ev = makeEval(state);
      const rows = Object.values(loadEpics(state)).filter(e => !flags.open || e.state === 'open').map(e => epicStatus(state, e, { ev }));
      if (flags.json) out(JSON.stringify(rows, null, 1)); else for (const r of rows) out(fmt(r));
      return 0;
    }
    if (sub === 'show') {
      const it = id && loadEpics(state)[id];
      if (!it) throw new RunError(id ? `${id} does not exist` : 'show needs an EP-n');
      const s = epicStatus(state, it);
      if (flags.json) { out(JSON.stringify(s, null, 1)); return 0; }
      out(`${s.id} ${s.state} ${s.priority} ${s.title}${s.integration_branch ? ` (integration ${s.integration_branch})` : ''}: ${s.done ? 'DONE' : 'not done'}`);
      for (const m of s.members) out(`  ${m.id}  ${m.done ? 'done' : m.gone ? `gone: ${m.gone}` : 'open'}`);
      return 0;
    }
    const by = flags.as || env.META_ROLE;
    if (!['add', 'member', 'close'].includes(sub)) throw new RunError(sub ? `unknown subcommand ${sub}` : 'missing subcommand');
    if (!by) throw new RunError('no role: pass --as <role> or set META_ROLE');
    if (sub === 'add') {
      if (id) throw new RunError(`unexpected ${id}`);
      const members = ids(flags.members);
      checkMembers(state, members);
      const data = { title: flags.title, priority: flags.priority, members, ...(flags['integration-branch'] ? { integration_branch: flags['integration-branch'] } : {}) };
      out(record(state, { kind: 'epic', ev: 'create', by, data }, { views: false }).id);
      return 0;
    }
    if (!id) throw new RunError(`${sub} needs an EP-n`);
    if (sub === 'close') { record(state, { kind: 'epic', ev: 'close', id, by, data: flags.why ? { why: flags.why } : {} }, { views: false }); out(`${id} closed`); return 0; }
    const add = ids(flags.add), remove = ids(flags.remove);
    if (!add.length && !remove.length) throw new RunError('member needs --add and / or --remove');
    checkMembers(state, add);
    if (add.length) record(state, { kind: 'epic', ev: 'add', id, by, data: { members: add } }, { views: false });
    if (remove.length) record(state, { kind: 'epic', ev: 'remove', id, by, data: { members: remove } }, { views: false });
    out(`${id} members ${epicMembers(loadEpics(state)[id]).join(',') || '(none)'}`);
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof EpicError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err('usage: ' + EPIC_USAGE); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// ---------- META-ROADMAP S1: norn road (roadmap records in roadmap.jsonl; status is derived, never typed; engine/lib/roadmap.mjs) ----------
// ---------- META-CATCH S1: norn stuck (stuck.mjs) ----------
// RM-37 (pause.mjs): `norn pause` - the pause modes, the safe pause of running runs, pause half; `norn resume` - a paused hand-off, or all
const PAUSE_USAGE = `norn pause [--mode checkins|queue|all [--why W]] | RUN-n... [--why W] | --half [--n N]    [--as owner|controller] [--project F | --state D]
       (no argument: the pause in force, the runs asked to pause, the paused hand-offs; --half prints the pick and the command that confirms it)`;
const RESUME_USAGE = 'norn resume RUN-n [--priority P0..P4] | --all    [--as owner|controller] [--project F | --state D]    (RUN-n: a paused hand-off, queued at the front; --all: the pause released, every paused hand-off queued, merges first)';
function pauseCmd(argv, env, out, err, { resume = false } = {}) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const k = a.slice(2);
      if ((resume ? ['all'] : ['half']).includes(k)) { flags[k] = true; continue; }
      if (!['project', 'state', 'why', 'as', ...(resume ? ['priority'] : ['mode', 'n'])].includes(k)) throw new RunError(`unknown flag ${a}`);
      flags[k] = argv[++i];
    }
    const { project, state } = where(flags, env), by = flags.as || env.META_ROLE || 'owner';
    if (resume) {
      if (flags.all) {
        const r = resumeAll(state, { by });
        out(r.cleared ? `RELEASED ${r.cleared.label}` : 'no pause of this project to release');
        if (r.still) out(`still paused: ${r.still.label} (${r.still.file}) - the machine-level file; delete it to release every project`);
        for (const x of r.resumed) out(x.next ? `RESUME ${x.run} queued as ${x.next}` : `${x.run}: ${x.error}`);
        for (const q of r.started) out(`queue: ${q.queued} -> STARTED ${q.next}`);
        return 0;
      }
      if (pos.length !== 1) throw new RunError('resume needs one RUN id, or --all');
      const r = resumeRun(state, { run: pos[0], by, priority: flags.priority || 'P0' });
      out(`RESUME ${r.run} queued as ${r.next} (${flags.priority || 'P0'})`);
      for (const q of fillQueue(state)) out(`queue: ${q.queued} -> STARTED ${q.next}`);
      return 0;
    }
    if (flags.half) {
      if (pos.length || flags.mode) throw new RunError('--half takes no RUN id and no --mode');
      const n = flags.n === undefined ? undefined : Number(flags.n);
      if (n !== undefined && !(Number.isInteger(n) && n >= 0)) throw new RunError('--n must be a whole number');
      const pk = pickHalf(state, { n, nearEnd: nearEndMin(project?.policy) });
      out(pk.line);
      if (pk.pick.length) out(`confirm: norn pause ${pk.pick.map(r => r.id).join(' ')} --why "pause half"`);
      return 0;
    }
    if (pos.length) {
      if (flags.mode) throw new RunError('pause a run or set a mode, not both');
      let bad = 0;
      for (const x of pauseRuns(state, pos, { by, why: flags.why })) { if (x.error) { bad++; err(`error: ${x.error}`); } else out(`PAUSE ${x.run}: order ${x.mail} sent (urgent) - it commits, hands off and ends at its next clean point`); }
      return bad ? 2 : 0;
    }
    if (flags.mode) { const p = setPause(state, { mode: flags.mode, by, why: flags.why }); out(`PAUSED: ${p.label} - ${PAUSE_MODES[p.mode].says}`); return 0; }
    const p = readPause(pauseFiles(state)), items = Object.values(loadState(state).items).filter(i => i.kind === 'run');
    out(p ? `pause: ${p.label}${p.by ? ` by ${p.by}` : ''}${p.at ? ` since ${p.at}` : ''}${p.why ? ` (${p.why})` : ''} [${p.file}] - ${PAUSE_MODES[p.mode].says}` : 'pause: none');
    for (const r of items.filter(i => i.state === 'running' && i.pause)) out(`asked to pause: ${r.id} (${r.data.lane}) - ${r.pause.mail}`);
    for (const r of pausedHandoffs(state)) out(`paused hand-off: ${r.id} (${r.data.lane}) - resume it: norn resume ${r.id}`);
    return 0;
  } catch (e) {
    if (e instanceof PauseError || e instanceof RunError || e instanceof RunRefused || e instanceof RecordError) { err(`error: ${e.message}`); return Number.isInteger(e.code) ? e.code : 2; }
    throw e;
  }
}
const STUCK_USAGE = 'norn stuck [--json] (the open flags) | brief RM-n [--out F] (the generated approach-review brief) | --replay [RM-n] (when each threshold would have fired, from this state)    [--project F | --state D]';
function stuckCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const k = a.slice(2);
      if (['json', 'replay'].includes(k)) { flags[k] = true; continue; }
      if (!['project', 'state', 'out'].includes(k)) throw new RunError(`unknown flag ${a}`);
      flags[k] = argv[++i];
    }
    const { project, state } = where(flags, env);
    const P = project || {}, R = loadRoadmap(state);
    const nodes = id => { const xs = Object.values(R.items).filter(n => n.kind === 'item' && (!id || n.id === id)); if (id && !xs.length) throw new RunError(`${id} does not exist`); return xs; };
    if (flags.replay) {
      if (pos.length > 1) throw new RunError(`unexpected ${pos[1]}`);
      const W = world({ stateDir: state, project: P });
      out(replayLines(nodes(pos[0]), W, W.stuck, reach).join('\n'));
      return 0;
    }
    if (pos[0] === 'brief') {
      if (!pos[1]) throw new RunError('brief needs RM-n');
      const n = findNode(buildTree({ stateDir: state, project: P }), pos[1]);
      if (!n || n.kind !== 'item') throw new RunError(`${pos[1]} is not a roadmap item`);
      const text = reviewBrief(pos[1], n, reach(R.items[pos[1]], world({ stateDir: state, project: P })).runs);
      if (flags.out) { fs.writeFileSync(flags.out, text + '\n'); out(`wrote ${flags.out}`); } else out(text);
      return 0;
    }
    if (pos.length) throw new RunError(`unexpected ${pos[0]}`);
    const f = readStuck(state);
    out(flags.json ? JSON.stringify(f, null, 1) : Object.entries(f).map(([id, x]) => `${id} stuck since ${x.ts.slice(0, 16)}Z: ${x.why.join(', ')} (${x.words})`).join('\n') || 'no stuck item');
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError) { err('error: ' + e.message); err('usage: ' + STUCK_USAGE); return 2; }
    throw e;
  }
}

// RM-28 S1 (proposals.mjs): a planner run's DONE = a proposal; each stage is ruled queue (launch its brief now, --item = the planner's
// roadmap item) / later (a child roadmap item, horizon next) / drop - every pick ONE decision. The dashboard Inbox card calls rule.
const PROPOSAL_USAGE = 'norn proposal [list] [--json] [--all (also the decided ones)] | rule RUN-n S<k> queue|later|drop [--as owner|dashboard|checkin]    [--project F | --state D]';
function proposalCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const k = a.slice(2);
      if (['json', 'all'].includes(k)) { flags[k] = true; continue; }
      if (!['project', 'state', 'as'].includes(k)) throw new RunError(`unknown flag ${a}`);
      flags[k] = argv[++i];
    }
    const { state } = where(flags, env);
    const props = o => proposalsOf(loadState(state).items, loadRoadmap(state), o);
    if (!pos.length || pos[0] === 'list') {
      if (pos.length > 1) throw new RunError(`unexpected ${pos[1]}`);
      const xs = props({ all: !!flags.all });
      out(flags.json ? JSON.stringify(xs, null, 1) : renderProposals(xs));
      return 0;
    }
    if (pos[0] !== 'rule') throw new RunError(`unknown subcommand ${pos[0]}`);
    const [, run, key, pick] = pos;
    if (!run || !key || !PICKS.includes(pick) || pos.length > 4) throw new RunError('rule needs RUN-n S<k> queue|later|drop');
    const by = flags.as || env.META_ROLE;
    if (!by) throw new RunError('no role: pass --as <role>');
    const { p, s, why } = openStage(props({ all: true }), run, key);
    if (why) throw new RunError(why);
    let ref = null;
    if (pick === 'queue') {   // the normal launcher: Ready lines, --item, the queue's caps and slots; its refusal is the answer
      const lines = [], loc = [...(flags.project ? ['--project', flags.project] : []), ...(flags.state ? ['--state', flags.state] : [])];
      const code = runCmd([...queueArgv(p, s), ...loc], env, l => lines.push(l), l => lines.push(l));
      const m = lines.join('\n').match(/\b(?:QUEUED|STARTED) (RUN-\d+)/);
      if (code !== 0 || !m) { for (const l of lines) err(l); throw new RunError(`${run} ${s.key}: the launch was refused (exit ${code}); nothing recorded`); }
      ref = m[1];
      for (const l of lines) out(l);
    }
    if (pick === 'later') {
      if (!p.item) throw new RunError(`${run} belongs to no open roadmap item (none links run:${run} or lane:${p.lane}): link one (norn road link RM-n run:${run}), or queue / drop`);
      ref = record(state, laterItem(p, s, by), { views: false }).id;
      out(`${ref} ${p.lane} ${s.key} under ${p.item}, horizon next`);
    }
    const d = record(state, pickDecision(p, s, pick, by, ref));
    out(`${d.id} ${run} ${s.key}: ${pick}${ref ? ` -> ${ref}` : ''}`);
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError) { err('error: ' + e.message); err('usage: ' + PROPOSAL_USAGE); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

const ROAD_USAGE = 'norn road show [RM-n] [--json] | list [--json] | audit [--json] (exit 1 while Unplaced is not empty) | add --title T (--theme RM-n | --kind theme) [--from DIR-n] [--after RM-n | --first] '
  + '[--horizon now|next|later] [--note N] [--links kind:id,..] [--stages "S1 a;S2 b"] | edit RM-n [--title T] [--note N] [--horizon now|next|later|none] [--stages "a;b"] [--caveat C|none] [--proof look|none] [--views "a,b"] '
  + '| verdict RM-n pass|fail --image <sheet> (a look item: the picture verdict the merge queue waits for) | move RM-n [--theme RM-n] [--after RM-n | --first] [--ref DEC-n|DIR-n] | link RM-n kind:id.. | unlink RM-n kind:id.. | drop RM-n --why W --ref DEC-n|DIR-n | reopen RM-n --why W '
  + '| apply plan.json | import --legacy FILE [--sections 1,2,..|title,..] [--out plan.json] [--json] (a dry run: the plan of a hand-kept catalogue for review; exit 1 = no row placed)    [--project F | --state D] [--as role]    (links: dir: dec: q: lane: run: dlv: ep: branch: sha: doc:)';
const ROAD_FLAGS = ['project', 'state', 'as', 'title', 'kind', 'theme', 'parent', 'from', 'after', 'first!', 'horizon', 'note', 'links', 'stages', 'caveat', 'ref', 'why', 'json!', 'legacy', 'sections', 'out', 'proof', 'views', 'image'];

function roadCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const k = ROAD_FLAGS.find(x => x.replace(/!$/, '') === a.slice(2));
      if (!k) throw new RunError(`unknown flag ${a}`);
      if (k.endsWith('!')) { flags[a.slice(2)] = true; continue; }
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const { project, state } = where(flags, env);
    const P = project || {};
    const [sub, id, ...more] = pos;
    const tree = () => buildTree({ stateDir: state, project: P });
    const view = tr => {
      const p = roadmapViewPath(state, P);
      if (writeRoadmapView(state, tr || tree(), p) === 'refused') err(`warning: ${p} was edited by hand - not rewritten (the roadmap view refuses hand edits; edit with norn road)`);
    };
    // META-ROADMAP S4 (SPEC sec. 5): a hand-kept catalogue -> a plan for review; nothing is recorded (apply it with norn road apply)
    if (sub === 'import') {
      if (!flags.legacy) throw new RunError('import needs --legacy <file> (a hand-kept catalogue: the rows of its Status-column tables)');
      if (id) throw new RunError(`unexpected ${id}`);
      const plan = importLegacy(state, { project: P, file: flags.legacy, sections: (flags.sections || '').split(',').map(x => x.trim()).filter(Boolean) });
      if (flags.out) fs.writeFileSync(flags.out, JSON.stringify(plan, null, 1) + '\n');
      out(flags.json ? JSON.stringify(plan, null, 1) : renderImport(plan) + (flags.out ? `\n\nplan: ${flags.out} - review it, then: norn road apply ${flags.out} --as migration` : ''));
      return plan.count ? 0 : 1;
    }
    if (['show', 'list', 'audit'].includes(sub)) {
      if (sub !== 'show' && id) throw new RunError(`unexpected ${id}`);
      const tr = tree();
      if (sub === 'show' && id) {
        const n = findNode(tr, id);
        if (!n) throw new RunError(`${id} does not exist`);
        out(flags.json ? JSON.stringify(n, null, 1) : renderItem(n).join('\n'));
        return 0;
      }
      if (sub === 'show') { out(flags.json ? JSON.stringify(tr, null, 1) : renderTree(tr)); return 0; }
      if (sub === 'list') {
        const xs = itemsOf(tr);
        if (flags.json) out(JSON.stringify(xs.map(({ children, ...n }) => n), null, 1));
        else for (const n of xs) out(`${n.id}  ${n.status}  ${n.phase}  ${n.progress.done}/${n.progress.total}  ${n.title}`);
        return 0;
      }
      view(tr);   // audit: each major tick refreshes the generated view with the derived status
      out(flags.json ? JSON.stringify(auditOf(tr), null, 1) : renderAudit(tr));
      return tr.unplaced.length ? 1 : 0;
    }
    const W = ['add', 'edit', 'move', 'link', 'unlink', 'drop', 'reopen', 'apply', 'verdict'];
    if (!W.includes(sub)) throw new RunError(sub ? `unknown subcommand ${sub}` : 'missing subcommand');
    const by = flags.as || env.META_ROLE;
    if (!by) throw new RunError('no role: pass --as <role> or set META_ROLE');
    const list = v => (v ? v.split(',').map(x => x.trim()).filter(Boolean) : []);
    const stages = v => v.split(';').map(x => x.trim()).filter(Boolean);
    const none = v => (v === 'none' ? null : v);
    const put = (ev, rid, data) => record(state, { kind: 'item', ev, id: rid, by, data }, { views: false });
    if (sub === 'apply') {
      if (!id) throw new RunError('apply needs a plan.json');
      if (more.length) throw new RunError(`unexpected ${more[0]}`);
      let plan;
      try { plan = JSON.parse(fs.readFileSync(id, 'utf8')); } catch (e) { throw new RunError(`${id}: ${e.message}`); }
      const { events, links, counts } = planEvents(plan, by);
      checkLinks(state, links, { project: P });
      record(state, events, { views: false });
      out(`applied ${counts.theme + counts.item} nodes (${counts.theme} theme${counts.theme === 1 ? '' : 's'}, ${counts.item} item${counts.item === 1 ? '' : 's'})`);
      view();
      return 0;
    }
    if (sub === 'add') {
      if (id) throw new RunError(`unexpected ${id}`);
      const links = list(flags.links);
      let title = flags.title;
      if (flags.from) {
        const d = loadState(state).items[flags.from];
        if (!d || d.kind !== 'directive') throw new RunError(`--from ${flags.from}: no such directive`);
        title ||= String(d.data.text).replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!links.includes('dir:' + flags.from)) links.unshift('dir:' + flags.from);
      }
      const parent = flags.theme || flags.parent;
      const data = { title, kind: flags.kind || 'item', ...(parent ? { parent } : {}), ...(flags.first ? { after: null } : flags.after ? { after: flags.after } : {}),
        ...(flags.horizon ? { horizon: none(flags.horizon) } : {}), ...(flags.note ? { note: flags.note } : {}), links, ...(flags.stages ? { stages: stages(flags.stages) } : {}) };
      checkLinks(state, links, { project: P });
      out(put('create', undefined, data).id);
      view();
      return 0;
    }
    if (!id) throw new RunError(`${sub} needs an RM-n`);
    if (sub === 'verdict') {   // META-CATCH S2: the look verdict (pass | fail + the image looked at); Norn checks the image exists, never what it shows
      if (more.length !== 1 || !['pass', 'fail'].includes(more[0])) throw new RunError('verdict needs pass or fail: norn road verdict RM-n pass|fail --image <sheet>');
      if (!flags.image) throw new RunError('verdict needs --image <the sheet looked at>');
      if (!fs.existsSync(flags.image)) throw new RunError(`--image ${flags.image}: no such file`);
      put('verdict', id, { verdict: more[0], image: path.resolve(flags.image).replace(/\\/g, '/') });
      out(`${id} verdict ${more[0]}`);
      return 0;
    }
    if (sub === 'link' || sub === 'unlink') {
      const terms = [...more, ...list(flags.links)];
      if (sub === 'link') checkLinks(state, terms, { project: P });
      put(sub, id, { links: terms });
    } else {
      if (more.length) throw new RunError(`unexpected ${more[0]}`);
      if (sub === 'edit') {
        const data = {};
        for (const k of ['title', 'note']) if (flags[k] !== undefined) data[k] = flags[k];
        if (flags.horizon !== undefined) data.horizon = none(flags.horizon);
        if (flags.caveat !== undefined) data.caveat = none(flags.caveat);
        if (flags.stages !== undefined) data.stages = stages(flags.stages);
        if (flags.proof !== undefined) data.proof = none(flags.proof);   // META-CATCH S2: none clears the views with it
        if (flags.views !== undefined) data.views = list(flags.views);
        put('edit', id, data);
      }
      if (sub === 'move') {
        const parent = flags.theme || flags.parent;
        put('move', id, { ...(parent ? { parent } : {}), ...(flags.first ? { after: null } : flags.after ? { after: flags.after } : {}), ...(flags.ref ? { ref: flags.ref } : {}) });
      }
      if (sub === 'drop') { if (flags.ref) checkLinks(state, refTerm(flags.ref), { project: P }); put('drop', id, { why: flags.why, ...(flags.ref ? { ref: flags.ref } : {}) }); }
      if (sub === 'reopen') put('reopen', id, { why: flags.why });
    }
    out(`${id} ${sub}`);
    view();
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof RoadmapError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err('usage: ' + ROAD_USAGE); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// ---------- META-ADOPT A1: norn adopt (scan, the facts-only draft, review, apply; engine/lib/adopt.mjs, records kind proposal) ----------
const ADOPT_USAGE = 'norn adopt scan [--root <repo> | --project P] [--json] (writes nothing) | draft --project P (--read [--executor X] [--model M] [--wait] | --no-read) [--answer k=v ..] '
  + '| show --project P [--part <id>] [--json] | approve <part> [--off <line,..>] [--on <line,..>] [--pick <line>] [--edit <file.json: { line: text }>] --project P | skip <part> --project P | apply --project P [--dry-run] '
  + '| close --project P --why "..."    [--as role]  (parts: profile, commands, rules, instructions, roadmap, first; answers: ' + ANSWER_KEYS.join(', ')
  + '; --read = one read-only agent run, capped, ingested at its end; --no-read = the free facts-only draft)';
const ADOPT_FLAGS = ['project', 'state', 'as', 'root', 'json!', 'no-read!', 'read!', 'wait!', 'part', 'off', 'on', 'pick', 'edit', 'why', 'dry-run!', 'answer*', 'executor', 'model'];

async function adoptCmd(argv, env, out, err) {
  try {
    const flags = { answer: [] }, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const k = ADOPT_FLAGS.find(x => x.replace(/[!*]$/, '') === a.slice(2));
      if (!k) throw new RunError(`unknown flag ${a}`);
      if (k.endsWith('!')) { flags[a.slice(2)] = true; continue; }
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      if (k.endsWith('*')) flags[a.slice(2)].push(argv[++i]); else flags[a.slice(2)] = argv[++i];
    }
    const [sub, part, ...more] = pos;
    if (more.length) throw new RunError(`unexpected ${more[0]}`);
    if (sub === 'scan') {
      if (part) throw new RunError(`unexpected ${part}`);
      const sp = flags.root ? splitRepo(flags.root) : null, pr = !flags.root && (flags.project || env.META_PROJECT) ? where(flags, env).project : null;
      const root = sp?.root || flags.root || pr?.root;
      if (!root) throw new RunError('scan needs --root <repo> or --project P');
      const f = scan(root, { subdir: sp ? sp.subdir : subdirOf(pr) });
      if (flags.json) { out(JSON.stringify(f, null, 1)); return 0; }
      printFacts(f, out);
      for (const q of interviewOf(f)) out(`question ${q.id}: ${q.text} (--answer ${q.id}=...; ${q.why})`);
      out(`scan took ${f.scan_ms} ms; nothing was written`);
      return 0;
    }
    const W = ['draft', 'show', 'approve', 'skip', 'apply', 'close'];
    // META-ADOPT A5: `norn adopt <repo>` / `norn adopt --project P` with no verb = the guided chain of the verbs (SPEC sec. 5)
    if (!W.includes(sub) && (sub ? !part && fs.existsSync(sub) && fs.statSync(sub).isDirectory() : !!flags.project)) {
      let pf = flags.project;
      if (sub) { pf = projectAtRoot(sub, env)?.config; if (!pf) throw new RunError(`${fwd(path.resolve(sub))} is not a project yet: norn init ${sub} (setup when needed, project new, then this chain)`); }
      return await adoptGuided(pickProject({ project: pf }, env), flags, env, out, err);
    }
    if (!W.includes(sub)) throw new RunError(sub ? `unknown subcommand ${sub}` : 'missing subcommand');
    const { project, state, locks } = where(flags, env);
    if (sub === 'show') {
      const p = proposalOf(state);
      if (flags.json) out(JSON.stringify(p, null, 1)); else out(renderProposal(p, { part: flags.part || part }).join('\n'));
      return 0;
    }
    const by = flags.as || env.META_ROLE;
    if (!by) throw new RunError('no role: pass --as <role> or set META_ROLE');
    if (!project) throw new RunError(`adopt ${sub} needs --project (its project.json is where approved parts go)`);
    if (sub === 'draft') {
      if (part) throw new RunError(`unexpected ${part}`);
      if (flags['no-read'] && flags.read) throw new RunError('--read or --no-read, not both');
      const answers = {};
      for (const a of flags.answer) { const i = a.indexOf('='); if (i < 1) throw new RunError(`--answer ${a}: want key=value`); answers[a.slice(0, i)] = a.slice(i + 1); }
      if (!flags['no-read']) {
        // META-ADOPT A2: the read starts only on an explicit choice that states the executor, the cap, the cost and who sees the files
        const pick = flags.executor ? { executor: flags.executor } : readExecutor(project);
        const launch = runSpec({ executor: pick.executor, lane: 'adopt', model: flags.model || pick.model, effort: pick.effort, worktree: project.root, brief: '-', 'no-tick': true }, env, { project, state, locks });
        delete launch.brief; delete launch.notes;
        if (!flags.read) { err('error: choose: ' + consentLine(launch)); return 2; }
        const r = readStart(state, { project, by, answers, launch });
        out(`${r.id} read ${r.run} started: ${launch.executor} ${launch.model ?? ''}, read-only, lane adopt; its answer is checked and drafted when it ends (norn adopt show)`);
        if (!flags.wait) return 0;
        const w = readWait(state, { id: r.id, run: r.run });
        if (!w.source) { out(`${r.id}: ${w.run} not ingested yet${w.why ? ` (${w.why})` : ''}`); return 1; }
        out(/^RUN-/.test(w.source) ? `${r.id} drafted from ${w.source}` : `${r.id}: the read gave no valid draft (${w.run}): drafted facts-only - ${proposalOf(state).draft.note}`);
        out(renderProposal(proposalOf(state)).slice(-1)[0]);
        return 0;
      }
      const r = adoptStart(state, { project, by, answers });
      out(`${r.id} ${r.created ? 'opened' : 're-drafted'} from the facts: ${r.parts.map(x => `${x.id} ${x.lines.length}`).join(', ')}`);
      out(renderProposal(proposalOf(state)).slice(-1)[0]);
      return 0;
    }
    if (sub === 'approve' || sub === 'skip') {
      if (!part) throw new RunError(`${sub} needs a part`);
      let edits;
      if (flags.edit) { try { edits = JSON.parse(fs.readFileSync(flags.edit, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { throw new RunError(`--edit ${flags.edit}: ${e.message}`); } }
      const r = adoptDecide(state, { part, verdict: sub, by, ...(edits ? { edits } : {}), ...(flags.off ? { off: flags.off.split(',').map(x => x.trim()).filter(Boolean) } : {}), ...(flags.on ? { on: flags.on.split(',').map(x => x.trim()).filter(Boolean) } : {}), ...(flags.pick ? { pick: flags.pick } : {}) });
      out(`${r.id} ${part}: ${sub === 'approve' ? 'approved' : 'skipped'}`);
      return 0;
    }
    if (part) throw new RunError(`unexpected ${part}`);
    if (sub === 'close') { if (!flags.why) throw new RunError('close needs --why'); out(`${adoptClose(state, { why: flags.why, by }).id} closed`); return 0; }
    const r = await adoptApply(state, { project, by, dryRun: !!flags['dry-run'], metaRoot: metaRoot(env) });
    for (const l of r.lines) out((r.dryRun ? 'would write ' : '') + l);
    if (!r.dryRun) out(`${r.id} ${r.complete ? 'applied' : 'partly applied (parts left to review: norn adopt show)'}`);
    if (!r.dryRun) for (const l of rehearsalLines(project, project.file, proposalOf(state), { applied: true })) out(l);
    return 0;
  } catch (e) {
    if (e instanceof RunRefused) { out('REFUSED: ' + e.message); return e.code; }   // META-ADOPT A2: the read's start met a full cap / a held lock
    if (e instanceof RunError || e instanceof AdoptError || e instanceof RoadmapError || e instanceof ConfigError || e instanceof LaneError || (e instanceof RecordError && e.code === 2)) {
      err('error: ' + e.message); err('usage: ' + ADOPT_USAGE); return 2;
    }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

/** OOTB-R2 N-2: the free rehearsal + the real run of the first lane (the 'first' part's first new line that is not unticked) -> lines */
function rehearsalLines(project, pf, P, { applied }) {
  const fp = P?.parts?.find(x => x.id === 'first');
  if (!fp || (applied ? !fp.applied : fp.status === 'skipped')) return [];
  const fl = fp.lines.find(l => !l.already && !(fp.decision?.off || []).includes(l.id));
  if (!fl) return [];
  const lane = laneNameOf(fl.text), at = lanePaths(project, lane), when = applied ? '' : ' (after norn adopt apply)';
  return [`first lane ${lane}${when}: rehearse it for free: norn run --executor fake --lane ${lane} --brief ${fwd(at.brief)} --project ${fwd(pf)} --wait`,
    `then the real run: norn run --executor claude --lane ${lane} --brief ${fwd(at.brief)} --project ${fwd(pf)} (or Start the run in norn dash)`];
}

// ---------- META-ADOPT A5: the guided chain (norn adopt <repo>) and norn init (setup + project new + the chain; SPEC meta-adopt sec. 5) ----------
function printFacts(f, out) {
  out(`${f.root}: ${f.path} (${f.path_why})`);
  out(`commands: ${f.commands.map(c => `${c.id} ${c.cmd} [${c.source}${c.ci ? '; CI ' + c.ci : ''}]`).join('; ') || 'none found'}`);
  out(`plans: ${f.plans.map(x => `${x.file} (${x.items} items)`).join(', ') || 'none'}; agent files: ${f.agent_files.map(x => x.file).join(', ') || 'none'}; branches in flight: ${f.branches.filter(b => !b.merged).length}`);
}
/** the registered project whose root is this repo -> { name, config } | null */
// the project of a folder: its root (+ subdir for a monorepo project) is that folder
function projectAtRoot(root, env) {
  const want = fwd(path.resolve(root)).replace(/\/+$/, ''), same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  for (const p of registeredProjects(env)) { try { if (same(projectHome(loadProject(p.config)).replace(/\/+$/, ''), want)) return p; } catch { /* a broken project: not this one */ } }
  return null;
}
const guidedInteractive = (flags, env) => !flags['non-interactive'] && (!!process.stdin.isTTY || env.META_INTERACTIVE === '1');
/**
 * The guided chain over the verbs (scan -> answers -> the read or the facts -> each part -> apply), one question at a time. An open
 * proposal is resumed, never re-drafted. Not interactive: it drafts and names the review commands; nothing is approved for the human,
 * except the profile the human named with --profile. Every step is the verb a terminal, the dashboard or MCP calls.
 */
async function adoptGuided(pf, flags, env, out, err, { ask = readLineSync } = {}) {
  const interactive = guidedInteractive(flags, env), by = flags.as || env.META_ROLE || 'owner';
  const verb = args => adoptCmd([...args, '--project', pf, '--as', by], env, out, err);
  const project = loadProject(pf), state = project.state;
  const facts = scan(project.root, { subdir: subdirOf(project) });
  printFacts(facts, out);
  let P = fs.existsSync(state) ? proposalOf(state) : null;
  if (P?.state === 'open' && P.draft) out(`${P.id} is open: resuming its review (norn adopt close --project ${fwd(pf)} --why "..." drops it)`);
  else {
    const answers = {};
    for (const a of flags.answer || []) { const i = a.indexOf('='); if (i < 1) throw new RunError(`--answer ${a}: want key=value`); answers[a.slice(0, i)] = a.slice(i + 1); }
    if (interactive) for (const q of interviewOf(facts)) {
      if (answers[q.id] !== undefined) continue;
      out(`${q.text} (${q.why}; blank = skip)`);
      const l = ask();
      if (l && l.trim()) answers[q.id] = l.trim();
    }
    let read = !!flags.read;
    if (!flags.read && !flags['no-read'] && interactive) {
      const pick = flags.executor ? { executor: flags.executor } : readExecutor(project);
      out(`Read it and draft? ${consentLine(pick).replace(/\. Choose --read.*$/, '')}. [y = read it / N = draft from the facts only, free]`);
      read = /^y/i.test((ask() || '').trim());
    }
    const rc = await verb(['draft', ...Object.entries(answers).flatMap(([k, v]) => ['--answer', `${k}=${v}`]),
      ...(read ? ['--read', '--wait', ...(flags.executor ? ['--executor', flags.executor] : []), ...(flags.model ? ['--model', flags.model] : [])] : ['--no-read'])]);
    if (rc) return rc;
  }
  P = proposalOf(state);
  // --profile on the command line IS the human's pick of the money part (it is never drafted as decided)
  if (flags.profile && P.parts.find(x => x.id === 'profile')?.status === 'to review') { const rc = await verb(['approve', 'profile', '--pick', flags.profile]); if (rc) return rc; P = proposalOf(state); }
  if (!interactive) {
    out(`review: norn adopt show --project ${fwd(pf)}; then norn adopt approve | skip <part> --project ${fwd(pf)} for each part (${P.undecided.join(', ') || 'none left'}); then norn adopt apply --project ${fwd(pf)}`);
    out('or review it in a terminal (norn adopt <repo>) or in the dashboard (norn dash)');
    for (const l of rehearsalLines(project, pf, P, { applied: false })) out(l);
    return 0;
  }
  for (const x of P.parts.filter(y => y.status === 'to review')) {
    out(`--- ${x.title} (${x.id}) ---`);
    for (const l of renderProposal(P, { part: x.id }).filter(t => /^ {2}\S| {4}\S/.test(t) && !/^ {2}(note|summary|goal|checked|question|unsure):?\s/.test(t))) out(l);
    const ids = x.lines.map(l => l.id).join(' | ');
    for (;;) {
      out(x.pick ? `pick one: p <${ids}> | s = skip | blank = later` : `a = approve | a -<id,id> = approve with those lines off (${ids || 'no lines'}) | s = skip | blank = later`);
      const l = ask(), t = (l ?? '').trim();
      if (!t) break;
      let args = null;
      if (/^s$/i.test(t)) args = ['skip', x.id];
      else if (x.pick && /^p\s+\S+$/i.test(t)) args = ['approve', x.id, '--pick', t.split(/\s+/)[1]];
      else if (!x.pick && /^a(\s+-\S+)?$/i.test(t)) { const off = t.split(/\s+-/)[1]; args = ['approve', x.id, ...(off ? ['--off', off] : [])]; }
      if (args && !(await verb(args))) break;
    }
  }
  P = proposalOf(state);
  if (P.undecided.length) out(`left to review: ${P.undecided.join(', ')} (norn adopt <repo> again, or the dashboard)`);
  if (!P.parts.some(x => x.status === 'approved' && !x.applied)) return 0;
  out('Apply the approved parts now? (norn adopt apply --dry-run lists every write) [y/N]');
  if (!/^y/i.test((ask() || '').trim())) { out(`not applied: norn adopt apply --project ${fwd(pf)} when ready`); return 0; }
  return await verb(['apply']);   // apply prints the first lane's rehearsal (OOTB-R2 N-2)
}

const INIT_USAGE = 'norn init [<repo> (default: the current folder)] [--non-interactive] [--profile try-it|solo|heavy] [--cost cheap|balanced|quality] [--name N] '
  + '[--answer k=v ..] [--read [--executor X] [--model M] | --no-read] [--as role]    (setup when this machine has none, project new when the repo is not a project, '
  + 'then the guided norn adopt: scan, answers, the draft, each part, apply; --non-interactive stops after the draft and names the review commands)';
async function initCmd(argv, env, out, err) {
  const F = ['non-interactive!', 'profile', 'cost', 'name', 'answer*', 'read!', 'no-read!', 'executor', 'model', 'as'];
  try {
    const flags = { answer: [] }, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const k = F.find(x => x.replace(/[!*]$/, '') === a.slice(2));
      if (!k) throw new RunError(`unknown flag ${a}`);
      if (k.endsWith('!')) { flags[a.slice(2)] = true; continue; }
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      if (k.endsWith('*')) flags[a.slice(2)].push(argv[++i]); else flags[a.slice(2)] = argv[++i];
    }
    if (pos.length > 1) throw new RunError(`unexpected ${pos[1]}`);
    if (flags.read && flags['no-read']) throw new RunError('--read or --no-read, not both');
    const repo = path.resolve(pos[0] || '.'), ni = flags['non-interactive'] ? ['--non-interactive'] : [];
    const pc = [...(flags.profile ? ['--profile', flags.profile] : []), ...(flags.cost ? ['--cost', flags.cost] : [])];
    if (!fs.existsSync(repo)) throw new RunError(`${fwd(repo)} does not exist`);
    const mf = path.join(metaRoot(env), 'local', 'machine.json'), fresh = !fs.existsSync(mf);
    if (fresh) {
      const rc = setup({ nonInteractive: !!flags['non-interactive'], askProjects: false, profile: flags.profile, cost: flags.cost, env, out, err });
      if (rc) return rc;
    }
    else out(`setup: done before (${fwd(mf)})`);
    let p = projectAtRoot(repo, env);
    if (p) out(`project ${p.name}: registered before (${fwd(p.config)})`);
    else {
      // the notify question was setup's when it ran just now: asked once
      const rc = projectNew({ root: repo, nonInteractive: !!flags['non-interactive'], name: flags.name, profile: flags.profile, cost: flags.cost, askNotify: !fresh, env, out, err });
      if (rc) return rc;
      p = projectAtRoot(repo, env);
      if (!p) throw new RunError(`project new registered no project for ${fwd(repo)}`);
    }
    return await adoptGuided(p.config, flags, env, out, err);
  } catch (e) {
    if (e instanceof RunRefused) { out('REFUSED: ' + e.message); return e.code; }
    if (e instanceof RunError || e instanceof AdoptError || e instanceof ConfigError || e instanceof LaneError || e instanceof SetupError || (e instanceof RecordError && e.code === 2)) {
      err('error: ' + e.message); err('usage: ' + INIT_USAGE); return 2;
    }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// ---------- META-GTP-MAIL: norn mail send | check [--inject] | ack | list (agent mail; engine/lib/mail.mjs) ----------
// ---------- META-GTP-CV piece 2: norn cv (the worker track record per routing key; read-only but for views/CV.md via `norn rec views`) ----------
// ---------- META-GUARD R1 item 2: norn usage - where the week's tokens went (per lane + stage, top 5 spenders, the context producers) ----------
const USAGE_USAGE = 'usage: norn usage [--week] [--json] [--sources] [--project project.json | --state D] [--machine F] [--budget F] [--now UTC]    (read-only; default the last 7 days to now, --week = the plan week since the budget reset; --sources reads every run\'s transcript for its context producers)';
function usageCmd(argv, env, out, err) {
  try {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (['--week', '--json', '--sources'].includes(a)) { flags[a.slice(2)] = true; continue; }
      if (!['--project', '--state', '--machine', '--budget', '--now'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const m = machineOf(flags, env);
    let targets;
    if (flags.project || flags.state) { const { project, state } = where(flags, env); targets = [{ project, state }]; }
    else if (m.machine?.projects?.length) targets = m.machine.projects.map(p => { const project = loadProject(p.config, { meta: m.root }); return { project, state: project.state }; });
    else { const { project, state } = where(flags, env); targets = [{ project, state }]; }
    const now = flags.now ? Date.parse(flags.now) : Date.now();   // the caller's clock (tests pin it)
    if (!Number.isFinite(now)) throw new RunError(`--now ${flags.now} is not a date`);
    const B = withDefaults(m.budget || {});
    const u = usageWeek(targets.map(t => cvPart(t.project || {}, { state: t.state })), { now, week: !!flags.week, resetAt: B.reset, cacheRPerPct: B.cacheR_per_pct ?? null,
      projectsDir: projectsDirOf(m.machine, env), codexDir: path.join(env.USERPROFILE || env.HOME || '', '.codex', 'sessions'), sources: !!flags.sources, lean: true });
    out(flags.json ? JSON.stringify(u, null, 1) : formatUsageWeek(u));
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError) { err('error: ' + e.message); err(USAGE_USAGE); return 2; }
    throw e;
  }
}

// ---------- META-GUARD R1: norn guard - the live usage guard (runaway / over the hand-off line / tool spam), alarms as GRD records ----------
const GUARD_USAGE = 'usage: norn guard [--json]    (read-only: every live run vs its peers + the open GRD alarms)\n'
  + '       norn guard watch [--json]    (the tick runs it: raise a GRD record per new alarm, close those of ended runs)\n'
  + '       norn guard rule GRD-n --action let-run|mail|stop --why W [--as role]    (the check-in ruling; Norn never kills a run by itself)\n'
  + '       norn guard sources RUN-n [--json]    (a run\'s context growth by source: tool output by tool, its own text, injected text)\n'
  + '       [--project project.json | --state D] [--machine F]';
function guardCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json') { flags.json = true; continue; }
      if (!a.startsWith('--')) { pos.push(a); continue; }
      if (!['--project', '--state', '--machine', '--action', '--why', '--as'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    const [verb, arg, extra] = pos;
    if (verb && !['watch', 'rule', 'sources'].includes(verb)) throw new RunError(`unexpected ${verb}`);
    if (extra || (!verb || verb === 'watch') && arg) throw new RunError(`unexpected ${extra || arg}`);
    const { project, state } = where(flags, env), p = project || {}, m = machineOf(flags, env), o = { projectsDir: projectsDirOf(m.machine, env) };
    if (verb === 'rule') {
      if (!/^GRD-(?:[a-z][a-z0-9]{0,15}-)?\d+$/.test(arg || '')) throw new RunError('rule needs GRD-n');
      if (!GUARD_ACTIONS.includes(flags.action)) throw new RunError(`--action must be ${GUARD_ACTIONS.join(' | ')}`);
      if (!flags.why) throw new RunError('rule needs --why');
      record(state, { kind: 'guard', ev: 'rule', id: arg, by: flags.as || env.META_ROLE || 'controller', data: { action: flags.action, why: flags.why } });
      out(`${arg} ruled: ${flags.action}${flags.action === 'let-run' ? '' : flags.action === 'mail' ? ' (send it: NORN mail send --to RUN-n)' : ' (stop it: NORN stop RUN-n)'}`);
      return 0;
    }
    if (verb === 'sources') {
      const r = loadState(state).items[arg];
      if (!r || r.kind !== 'run') throw new RunError(`no run ${arg}`);
      const file = runTranscript(r, o), s = file ? contextSources(transcriptTrace(file)) : null;
      if (!s) throw new RunError(`${arg}: no transcript found`);
      const { ctx, ...v } = s;
      if (flags.json) { out(JSON.stringify({ run: arg, ...v, method: SOURCES_METHOD }, null, 1)); return 0; }
      const pc = x => (x === null ? '-' : Math.round(x * 100) + ' %');
      out(`${arg}: ${s.turns} calls, cache reads ${mTok(s.cache_read)}; standing context ${mTok(s.standing.tokens)} = ${pc(s.standing.share)} of them`);
      for (const x of s.sources) out(`- ${x.key.replace(/^tool:/, 'tool ')}: ~${mTok(x.tokens)} tokens -> ${mTok(x.reread)} cache reads (${pc(x.share)})`);
      if (s.max) out(`largest tool result: ${s.max.tool} ~${mTok(s.max.tokens)} tokens (call ${s.max.at})`);
      out(SOURCES_METHOD);
      return 0;
    }
    if (verb === 'watch') {
      const r = guardWatch(state, p, { ...o, by: flags.as || env.META_ROLE || 'launcher' });
      if (flags.json) { out(JSON.stringify({ raised: r.raised, closed: r.closed, scan: r.scan }, null, 1)); return 0; }
      out(`guard: ${r.scan.runs.length} live run(s); raised ${r.raised.map(x => `${x.id} ${x.run} ${x.cls}`).join(', ') || 'none'}; closed ${r.closed.join(', ') || 'none'}`);
      return 0;
    }
    const sc = guardScan(state, p, o), open = openGuards(state);
    if (flags.json) out(JSON.stringify({ ...sc, open }, null, 1)); else out(formatGuard(sc, open));
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err(GUARD_USAGE); return 2; }
    throw e;
  }
}

// ---------- WORK-SIZING S1 (RM-25): norn size - the sessions of a lane stage, their size against the marks they ran under, a verdict ----------
const SIZE_USAGE = 'usage: norn size [RUN-n | --lane L [--stage S]] [--json] [--project project.json | --state D] [--machine F]    (read-only: RUN-n = the stage of that run; '
  + 'no --stage = the lane\'s last stage)';
function sizeCmd(argv, env, out, err) {
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--json') { flags.json = true; continue; }
      if (!a.startsWith('--')) { pos.push(a); continue; }
      if (!['--lane', '--stage', '--project', '--state', '--machine'].includes(a)) throw new RunError(`unexpected ${a}`);
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = argv[++i];
    }
    if (pos.length > 1 || (pos.length && flags.lane) || (!pos.length && !flags.lane)) throw new RunError('name one run (RUN-n) or one --lane');
    if (pos.length && !/^RUN-\d+$/.test(pos[0])) throw new RunError(`unexpected ${pos[0]}`);
    const { project, state } = where(flags, env), m = machineOf(flags, env);
    let at = { lane: flags.lane, stage: flags.stage };
    if (pos.length) {
      const r = loadState(state).items[pos[0]];
      if (!r || r.kind !== 'run') throw new RunError(`no run ${pos[0]}`);
      at = { lane: r.data.lane, stage: r.data.stage ?? null };
    }
    const s = stageSizes(state, at, { projectsDir: projectsDirOf(m.machine, env) }), v = verdict(s.sessions, sizingThresholds(project?.policy));
    if (flags.json) { out(JSON.stringify({ ...s, verdict: v }, null, 1)); return 0; }
    const k = n => (Number.isFinite(n) ? `${Math.round(n / 1000)}k` : '-');
    out(`${s.lane}${s.stage ? ' / ' + s.stage : ''}: ${s.sessions.length} session(s)`);
    for (const x of s.sessions) {
      const z = x.size || {}, mk = x.marks ? `${x.marks.no_new_step_k}/${x.marks.handoff_k}/${x.marks.hard_max_k}k` : 'not recorded';
      out(`- ${x.run} ${x.outcome || '-'}: floor ${k(z.floor)}, first edit ${k(z.first_edit)}, peak ${k(z.peak)}; marks ${mk}; orders ${x.orders.join(', ') || 'none'}; commits ${z.commits ?? '-'}`);
    }
    out(`verdict: ${v.words}`);
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err(SIZE_USAGE); return 2; }
    throw e;
  }
}

const CV_USAGE = 'usage: norn cv [--by executor|model|agent|lane] [--since Nd] [--json] [--project project.json | --state D] [--machine F] [--budget F]    (no --project / --state = every project in machine.json; default windows 7 d + 30 d)';
const CV_FLAGS = ['by', 'since', 'json!', 'project', 'state', 'machine', 'budget'];
/** The CV of the given state(s): o { projects: [{ project, state }] } + the machine's budget calibration and transcript roots. */
function cvOf(targets, { m, env, by, days }) {
  const parts = targets.map(t => cvPart(t.project || {}, { state: t.state }));
  return cv(parts, { by, days, cacheRPerPct: m.budget.cacheR_per_pct ?? null, projectsDir: projectsDirOf(m.machine, env),
    codexDir: path.join(env.USERPROFILE || env.HOME || '', '.codex', 'sessions') });
}
function cvCmd(argv, env, out, err) {
  try {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i], s = a.startsWith('--') && CV_FLAGS.find(f => f.replace(/!$/, '') === a.slice(2));
      if (!s) throw new RunError(`unexpected ${a}`);
      if (s.endsWith('!')) { flags[s.slice(0, -1)] = true; continue; }
      if (i + 1 >= argv.length) throw new RunError(`${a} needs a value`);
      flags[s] = argv[++i];
    }
    const by = flags.by ?? 'key';
    if (!CV_BY.includes(by) || by === 'key' && flags.by) throw new RunError(`--by must be executor | model | agent | lane (got ${flags.by})`);
    let days;
    if (flags.since !== undefined) { const x = /^(\d+)d$/.exec(flags.since); if (!x || !Number(x[1])) throw new RunError(`--since must be Nd, e.g. 7d (got ${flags.since})`); days = Number(x[1]); }
    const m = machineOf(flags, env);
    let targets;
    if (flags.project || flags.state) { const { project, state } = where(flags, env); targets = [{ project, state }]; }
    else if (m.machine?.projects?.length) targets = m.machine.projects.map(p => { const project = loadProject(p.config, { meta: m.root }); return { project, state: project.state }; });
    else { const { project, state } = where(flags, env); targets = [{ project, state }]; }
    const c = cvOf(targets, { m, env, by, days });
    if (flags.json) out(JSON.stringify(c, null, 1));
    else out(c.windows.map(w => renderWindow(w)).join('\n').trimEnd());
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError) { err('error: ' + e.message); err(CV_USAGE); return 2; }
    throw e;
  }
}

// ---------- META-DOD 2: norn scope check --run RUN-n --state D (the PreToolUse hook; payload on stdin) ----------
const SCOPE_USAGE = 'norn scope check --run RUN-n --state D    (the PreToolUse hook of a guarded run: the payload on stdin; a refusal prints the deny JSON with its reason; exit 0)';
function scopeCmd(argv, env, out, err) {
  const f = {};
  for (let i = 1; i < argv.length; i += 2) { const k = { '--run': 'run', '--state': 'state' }[argv[i]]; if (!k || argv[i + 1] === undefined) { err('error: unexpected ' + argv[i]); err('usage: ' + SCOPE_USAGE); return 2; } f[k] = argv[i + 1]; }
  if (argv[0] !== 'check' || !f.state) { err('error: ' + (argv[0] !== 'check' ? 'scope needs: check' : 'check needs --state')); err('usage: ' + SCOPE_USAGE); return 2; }
  // the hook's --run $META_RUN_ID: a shell that did not expand it leaves the literal - the env names the run then
  const run = f.run && /^RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+$/.test(f.run) ? f.run : env.META_RUN_ID;
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) { payload = { tool_name: '?', tool_input: {}, unreadable: e.message }; }
  const r = scopeCheck({ state: path.resolve(f.state), run: run || '-', payload, env });
  if (r.deny) out(denyJson(r.deny));
  return 0;
}

const MAIL_USAGE = 'norn mail send --to RUN-n|lane:L|role:checkin|role:controller --subject S (--body B (<= 2 KB) | --body-file F) [--urgent] [--as checkin|controller]'
  + '  |  norn mail check [--inject] (--run RUN-n (your own run) | --to role:controller)  |  norn mail ack MAIL-n  |  norn mail list [--to X] [--open] [--json]'
  + '    [--project project.json | --state D]    (a run speaks as itself: META_RUN_ID; --inject = the PostToolUse hook output, always exit 0)';
const MAIL_FLAGS = ['project', 'state', 'to', 'subject', 'body', 'body-file', 'as', 'run', 'urgent!', 'inject!', 'open!', 'json!'];
function mailCmd(argv, env, out, err) {
  const [sub, ...rest] = argv;
  const inject = sub === 'check' && rest.includes('--inject');
  try {
    const flags = {}, pos = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const s = MAIL_FLAGS.find(f => f.replace(/!$/, '') === a.slice(2));
      if (!s) throw new RunError(`unknown flag ${a}`);
      if (s.endsWith('!')) { flags[a.slice(2)] = true; continue; }
      if (i + 1 >= rest.length) throw new RunError(`${a} needs a value`);
      flags[a.slice(2)] = rest[++i];
    }
    if (!['send', 'check', 'ack', 'list'].includes(sub)) throw new RunError(sub ? `unknown mail subcommand ${sub}` : 'missing subcommand');
    if (pos.length > (sub === 'ack' ? 1 : 0) || (sub === 'ack' && !pos.length)) throw new RunError(sub === 'ack' ? 'ack needs one MAIL-n' : `unexpected ${pos[0]}`);
    if (flags.as !== undefined && !['checkin', 'controller'].includes(flags.as)) throw new RunError('--as must be checkin | controller');
    const { state } = where(flags, env);
    const by = mailRole(state, env, flags.as);
    if (flags.as && env.META_RUN_ID) throw new RunError(`--as: a run (META_RUN_ID=${env.META_RUN_ID}) speaks as itself`);
    const run = env.META_RUN_ID || null;
    if (sub === 'send') {
      if (flags.body !== undefined && flags['body-file'] !== undefined) throw new RunError('--body and --body-file: give one');
      const bodyFile = flags['body-file'] !== undefined ? path.resolve(flags['body-file']) : undefined;
      if (bodyFile && !fs.existsSync(bodyFile)) throw new RunError(`--body-file not found: ${flags['body-file']}`);
      const e = sendMail(state, { by, run, to: flags.to, subject: flags.subject, body: flags.body, body_file: bodyFile, urgent: !!flags.urgent });
      out(`${e.id} queued -> ${e.data.to}${e.data.urgent ? ' URGENT' : ''}`);
      return 0;
    }
    if (sub === 'check') {
      // the hook's --run $META_RUN_ID: a shell that did not expand it leaves the literal - the env names the run then
      const reader = flags.run !== undefined && !/^RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+$/.test(flags.run) && run ? run : flags.run;
      if (!reader === !flags.to) throw new RunError('check needs one of --run RUN-n | --to role:controller');
      if (reader && reader !== run) throw new RunError(`--run ${reader}: a run takes delivery of its own mail only (META_RUN_ID=${run || '-'}); read others with norn mail list --to ${reader}`);
      if (flags.to && flags.to !== roleAddr('controller', state) && !(flags.to === roleAddr('checkin', state) && by === 'checkin')) throw new RunError(`--to: the controller's session reads ${roleAddr('controller', state)} (a run reads with --run)`);
      const got = checkMail(state, { by, run: reader || null, to: flags.to, via: inject ? 'hook' : 'cli' });
      // META-CTX-ENFORCE R1: the same hook delivers the run's context order (ctxlimit.mjs; once per level)
      if (inject) { const o = reader ? ctxOrder(state, reader) : null; const j = injectJson(got, o?.text); if (j) out(j); return 0; }
      out(got.length ? got.map(formatMail).join('\n\n') : 'no new mail');
      return 0;
    }
    if (sub === 'ack') { ackMail(state, { by, run, id: pos[0] }); out(`${pos[0]} acked`); return 0; }
    const rows = listMail(state, { to: flags.to, open: !!flags.open });
    if (flags.json) out(JSON.stringify(rows, null, 1));
    else for (const m of rows) out(`${m.id} ${m.state} ${m.from} -> ${m.to}${m.urgent ? ' URGENT' : ''} ${m.subject}`);
    return 0;
  } catch (e) {
    // the hook never fails the tool call it follows: its errors go to stderr, exit 0
    if (inject) { err(`norn mail check --inject: ${e.message}`); return 0; }
    if (e instanceof RunError || e instanceof ConfigError || (e instanceof RecordError && e.code === 2)) { err('error: ' + e.message); err('usage: ' + MAIL_USAGE); return 2; }
    if (e instanceof RecordError) { err('error: ' + e.message); return e.code; }
    throw e;
  }
}

// ---------- META-GTP-FED piece 3: norn node run --home <ledger remote> [--labels a,b] [--machine F] ----------
const NODE_USAGE = 'norn node run --home <ledger remote> [--labels a,b] [--machine F]    (one pull-agent job: claim the first offered run this node serves, run it in its own state dir (home paths through fed.path_map; no map covering its worktree = its own checkout under <state>/ws/<lane>, the brief from the offer, NOTES in its reviews dir), push machine/<host>, mark the claim done; machine.json fed { host, id, labels, heartbeat_s, lease_s, path_map } + ledger { dir, state_root, reviews })';
function nodeCmd(argv, env, out, err) {
  const [sub, ...rest] = argv, f = {};
  const usage = msg => { err('error: ' + msg); err('usage: ' + NODE_USAGE); return 2; };
  if (sub !== 'run') return usage(sub ? `unknown node subcommand ${sub}` : 'missing subcommand');
  for (let i = 0; i < rest.length; i++) {
    const k = { '--home': 'home', '--labels': 'labels', '--machine': 'machine' }[rest[i]];
    if (!k || rest[i + 1] === undefined) return usage(`unexpected ${rest[i]}`);
    f[k] = rest[++i];
  }
  let labels, machine;
  const root = metaRoot(env), mf = f.machine || path.join(root, 'local', 'machine.json');
  try { labels = parseLabels(f.labels); machine = loadMachine(mf, { meta: root }); } catch (e) { return usage(e.message); }
  return nodeRun({ machine, machineFile: mf, metaRoot: root, home: f.home, labels, out })
    .then(r => (r.error ? 1 : 0), e => { err('error: ' + e.message); return e instanceof FedError || e instanceof ClaimsError ? 2 : 1; });
}

// ---------- RM-46 S2a / S2b: norn claim list | allow | release | take (the claims branch of the ledger remote) ----------
const CLAIM_USAGE = "norn claim list [--project P] | allow <home>/<lane> <home>/<lane> --project P [--why W] | release <lane> --project P | take <home>/<lane> --project P  [--machine F]    (work claims on the ledger remote's claims branch: list every entry, let two homes' claims overlap (owner), CAS-delete this home's own claim with its allow files, take over another home's STALE claim (owner; stale = its n unchanged for lease_s + policy.sync.stale_grace_s on this home's clock); the home id is the project's home.json)";
function claimCmd(argv, env, out, err) {
  const [sub, ...rest] = argv, f = {}, pos = [];
  const usage = msg => { err('error: ' + msg); err('usage: ' + CLAIM_USAGE); return 2; };
  if (!['list', 'allow', 'release', 'take'].includes(sub)) return usage(sub ? `unknown claim subcommand ${sub}` : 'missing subcommand');
  for (let i = 0; i < rest.length; i++) {
    const k = { '--project': 'project', '--why': 'why', '--machine': 'machine' }[rest[i]];
    if (!k) { if (rest[i].startsWith('--')) return usage(`unexpected ${rest[i]}`); pos.push(rest[i]); continue; }
    if (rest[i + 1] === undefined) return usage(`${rest[i]} needs a value`);
    f[k] = rest[++i];
  }
  if (pos.length !== { list: 0, allow: 2, release: 1, take: 1 }[sub]) return usage(`claim ${sub}: wrong number of arguments`);
  if (sub !== 'list' && !f.project) return usage(`claim ${sub} needs --project`);
  try {
    const root = metaRoot(env), mf = f.machine || path.join(root, 'local', 'machine.json');
    const cfg = ledgerConfig(fs.existsSync(mf) ? loadMachine(mf, { meta: root }) : null, { metaRoot: root, machineFile: mf }), fe = fedOf(cfg);
    if (!fe) { err('error: claims need the ledger with a remote (machine.json ledger.remote)'); return 1; }
    if (sub === 'list') {
      const rows = Object.entries(listClaims(fe)).filter(([k]) => !f.project || k.split('/').includes(f.project)).sort(([a], [b]) => a.localeCompare(b));
      for (const [k, c] of rows) out(c?.kind === 'work' ? `${k}  n=${c.n} run=${c.run ?? '-'} renewed ${c.renewed_at}  items ${(c.items || []).join(',') || '-'}  scope ${(c.scope || []).join(' ')}` : k);
      if (!rows.length) out('no claims');
      return 0;
    }
    if (sub === 'allow') {
      const r = allowPair(fe, { project: f.project, a: pos[0], b: pos[1], why: f.why || '' });
      out(r.exists ? `already allowed: ${r.key}` : `allowed: ${r.key}`);
      return 0;
    }
    const state = path.join(cfg.state_root, f.project), home = homeOf(state)?.id;
    if (!home) { err(`error: project ${f.project} is not synced (no home.json in its state dir)`); return 1; }
    if (sub === 'take') {   // S2b (SPEC 4.5): only a stale claim; the observer's clock (claims-seen.json) is this home's, brought up to the fetched tip first
      const m = /^([a-z][a-z0-9]{0,7})\/(.+)$/.exec(pos[0]);
      if (!m) return usage(`claim take ${pos[0]}: want <home>/<lane>`);
      if (m[1] === home) { err(`error: ${pos[0]} is this home's own claim - norn claim release ${m[2]} --project ${f.project}`); return 1; }
      const now = Date.now(), seen = updateSync(state, 'seen', cur => observeClaims(listClaims(fe), cur, { home, now }));
      const r = takeWork(fe, { project: f.project, home: m[1], lane: m[2], seen, now, pol: syncPolicy(), by: 'owner' });
      if (r.gone) { out(`no claim ${r.key}`); return 0; }
      if (r.notStale) { err('error: ' + r.why); return 3; }
      if (r.busy) { err('error: ' + r.why); return 1; }
      const rows = readSync(state, 'rows');
      writeSync(state, 'rows', { ...rows, events: [...(rows.events || []), { kind: 'taken', id: r.key, why: `${pos[0]} taken over by the owner on ${home} (stale at n=${r.claim.n})`, ms: now, at: new Date(now).toISOString() }] });
      out(`taken over: ${r.key} (stale at n=${r.claim.n}); ${m[1]} stops its run at its next renew`);
      return 0;
    }
    const r = releaseWork(fe, { project: f.project, home, lane: pos[0] });
    if (r.gone) { out(`no claim ${r.key}`); return 0; }
    if (r.busy) { err('error: ' + r.why); return 1; }
    out(`released: ${r.removed.join(' ')}`);
    return 0;
  } catch (e) { if (e instanceof ClaimsError) { err('error: ' + e.message); return 2; } throw e; }
}

// ---------- RM-46 S1b: norn sync cut (multi-home SPEC sec. 6; the cut tool: engine/lib/synccut.mjs) ----------
const SYNC_CUT_USAGE = 'norn sync cut --project P --home <id> [--bare] [--apply] [--machine F]    (the one cut that makes this project a home of a synced project: a dry run by default that prints every rename; --apply registers the home on the claims branch, renames the lane branches (local + origin; an open PR keeps its), rewrites the logs, renames the files keyed by id and writes home.json + ID-MAP.md. --bare: the first home, which keeps its bare ids. Pre-conditions: the project paused, no run running or queued, the lane worktrees clean)';
function syncCutCmd(argv, env, out, err) {
  const [sub, ...rest] = argv, f = {};
  const usage = msg => { err('error: ' + msg); err('usage: ' + SYNC_CUT_USAGE); return 2; };
  if (sub !== 'cut') return usage(sub ? `unknown sync subcommand ${sub}` : 'missing subcommand');
  for (let i = 0; i < rest.length; i++) {
    if (['--bare', '--apply'].includes(rest[i])) { f[rest[i].slice(2)] = true; continue; }
    const k = { '--project': 'project', '--state': 'state', '--home': 'home', '--machine': 'machine' }[rest[i]];
    if (!k) return usage(`unexpected ${rest[i]}`);
    if (rest[i + 1] === undefined) return usage(`${rest[i]} needs a value`);
    f[k] = rest[++i];
  }
  if (!f.home) return usage('sync cut needs --home <id>');
  if (!HOME_RE.test(f.home)) return usage(`--home ${f.home}: want [a-z][a-z0-9]{0,7}`);
  try {
    const { project, state } = where(f, env);
    if (!project) return usage('sync cut needs --project (its repo holds the lane branches)');
    const root = metaRoot(env), mf = f.machine || path.join(root, 'local', 'machine.json');
    const cfg = ledgerConfig(fs.existsSync(mf) ? loadMachine(mf, { meta: root }) : null, { metaRoot: root, machineFile: mf });
    const r = syncCut({ state, project, home: f.home, bare: !!f.bare, apply: !!f.apply, ledger: cfg, machineFile: mf });
    for (const l of cutLines(r, { project: project.name, home: f.home, apply: !!f.apply })) out(l);
    return r.refused.length ? 1 : 0;
  } catch (e) { if (e instanceof RunError || e instanceof ConfigError || e instanceof ClaimsError) { err('error: ' + e.message); return 2; } throw e; }
}

// ---------- RM-46 S1c: norn sync status | publish | fetch | cut (home/<id> on the ledger remote; the loop is S4's) ----------
const SYNC_USAGE = 'norn sync status | publish | fetch  [--machine F]    (multi-home sync: publish this home\'s shared logs to home/<id> of the ledger remote, fetch every other home\'s into <state>/<project>/homes/<h>/; on with machine.json ledger.remote and a synced project: home.json { id } names the home)' + '\n       ' + SYNC_CUT_USAGE;
function syncCmd(argv, env, out, err) {
  if (argv[0] === 'cut') return syncCutCmd(argv, env, out, err);
  const [sub, ...rest] = argv, f = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--machine' || rest[i + 1] === undefined) { err(`error: unexpected ${rest[i]}`); err('usage: ' + SYNC_USAGE); return 2; }
    f.machine = rest[++i];
  }
  if (!['status', 'publish', 'fetch'].includes(sub)) { err(sub ? `error: unknown sync subcommand ${sub}` : 'error: missing subcommand'); err('usage: ' + SYNC_USAGE); return 2; }
  try {
    const root = metaRoot(env), mf = f.machine || path.join(root, 'local', 'machine.json');
    const cfg = ledgerConfig(fs.existsSync(mf) ? loadMachine(mf, { meta: root }) : null, { metaRoot: root, machineFile: mf });
    const id = cfg && homeIdOf(cfg);
    if (!id) { err('error: sync is off (it needs machine.json ledger.remote and a synced project: a state dir with home.json)'); return 1; }
    if (sub === 'status') {
      const s = syncStatus(cfg);
      out(`home ${s.home} remote set  published ${s.head ? s.head.slice(0, 10) : 'never'}${s.head && s.head !== s.pushed ? ' (not pushed yet)' : ''}`);
      if (s.stopped) out(`publish stopped: ${s.stopped}`);
      out(s.fetched_at ? `fetched ${s.fetched_at}` : 'never fetched');
      if (s.fetch_error) out(`stale since ${s.fetched_at || 'never'}: the fetch at ${s.failed_at} failed (${s.fetch_error})`);
      if (s.gone.length) out(`gone (copies kept): ${s.gone.join(' ')}`);
      return 0;
    }
    if (sub === 'publish') {
      const r = publishHome(cfg);
      if (r.error || r.refused || r.stopped || r.rejected) { err('error: ' + (r.error || r.stopped || r.rejected || `refused: a machine.json secret value in ${r.refused.join(', ')}`)); return 1; }
      out(r.noop ? 'nothing to publish' : `published home/${id}${r.sha ? ' ' + r.sha.slice(0, 10) : ''}, ${r.pushed ? 'pushed' : `not pushed (${r.offline}): the next pass retries`}`);
      return 0;
    }
    const r = fetchHomes(cfg);
    if (r.error) { err(`error: fetch failed, the last copies stay: ${r.error}`); return 1; }
    out(`fetched ${r.homes.length} home${r.homes.length === 1 ? '' : 's'} (${r.homes.join(' ') || '-'}), ${r.written.length} copies written`);
    if (r.gone.length) out(`gone (copies kept): ${r.gone.join(' ')}`);
    return 0;
  } catch (e) {
    err('error: ' + e.message);
    return e instanceof ConfigError ? 2 : 1;
  }
}

// ---------- GTP-LEDGER: norn ledger status | log [-n N] | restore --at <sha> --to <scratch dir> (read-only on live state) ----------
const LEDGER_USAGE = 'norn ledger status | log [-n N] | restore --at <sha> --to <scratch dir>  [--machine F]    (the git-backed Norn ledger; machine.json ledger slot)';
function ledgerCmd(argv, env, out, err) {
  const [sub, ...rest] = argv, f = {};
  for (let i = 0; i < rest.length; i++) {
    const k = { '-n': 'n', '--at': 'at', '--to': 'to', '--machine': 'machine' }[rest[i]];
    if (!k || rest[i + 1] === undefined) { err(`error: unexpected ${rest[i]}`); err('usage: ' + LEDGER_USAGE); return 2; }
    f[k] = rest[++i];
  }
  if (!['status', 'log', 'restore'].includes(sub)) { err(sub ? `error: unknown ledger subcommand ${sub}` : 'error: missing subcommand'); err('usage: ' + LEDGER_USAGE); return 2; }
  try {
    const root = metaRoot(env), mf = f.machine || path.join(root, 'local', 'machine.json');
    const cfg = ledgerConfig(fs.existsSync(mf) ? loadMachine(mf, { meta: root }) : null, { metaRoot: root, machineFile: mf });
    if (!cfg) { err('error: the ledger is off (no ledger slot in machine.json; add "ledger": {} to turn it on)'); return 1; }
    if (sub === 'status') {
      const s = ledgerStatus(cfg);
      out(`ledger ${s.dir} (work tree ${s.root}) branch ${s.branch} remote ${s.remote ? 'set' : 'none'}`);
      if (!s.exists) { out('no repo yet: the first tick pass creates it'); return 0; }
      out(s.head ? `head ${s.head.slice(0, 10)} ${s.date} ${s.subject}` : 'head none (no commit yet)');
      out(`tracked ${s.tracked} pending ${s.pending}${s.big.length ? ` skipped > 5 MB: ${s.big.join(', ')}` : ''}`);
      return 0;
    }
    if (sub === 'log') { for (const l of ledgerLog(cfg, f.n === undefined ? 20 : Number(f.n))) out(l); return 0; }
    const r = ledgerRestore(cfg, { at: f.at, to: f.to });
    out(`restored ${r.sha.slice(0, 10)} into ${r.to}`);
    return 0;
  } catch (e) {
    err('error: ' + e.message);
    return e instanceof ConfigError ? 2 : 1;
  }
}

// META-SHOT R1: the one safe headless-browser helper (engine/lib/shot.mjs)
async function shotCmd(argv, out, err) {
  try {
    await shot({ ...parseShotArgs(argv), log: out });
    return 0;
  } catch (e) {
    if (!(e instanceof ShotError)) throw e;
    err('error: ' + e.message);
    if (e.code === 2) err(SHOT_USAGE);
    return e.code;
  }
}

if (isMain(import.meta.url)) {
  const code = main(process.argv.slice(2));
  if (code instanceof Promise) code.then(c => { process.exitCode = c; }); else process.exitCode = code;
}
