// Engine dashboard server (META-GENERAL-DESIGN 6, 7, 12-S6). Port of meta/dash/server.mjs onto the engine: every tab is served
// from records / runs / transcripts of the selected project (project switcher; "all" sums the overview), every button goes
// through the records lib (D2), Settings are split machine budget vs project policy (D11). No folder discovery, no Markdown
// question parser, no process probe. Node built-ins only; 127.0.0.1 only. UI = index.html + ui.mjs (S7).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { resultPath } from '../lib/result.mjs';
import { spawn, execFile } from 'node:child_process';
import { createSessions } from './sessions.mjs';
import { createFeeds, decodeCursor } from './feed.mjs';
import { briefItems, namedDone } from './activity.mjs';
import { createStreams } from './stream.mjs';
import { createChat, readThread, threadFlushed, threadState, chatCost, chatPick, chatCommands, NORN_COMMANDS, CONTEXT_DEFAULT } from '../lib/chat.mjs';
import { ActError, showRoots, insideRoots, outboxDir, threadFile } from '../lib/chatact.mjs';
import { genWhyNot } from '../lib/setup.mjs';
import { profileChoices, profileChanges, profileBudget, getProfile, loadProfiles, COSTS } from '../lib/profiles.mjs';
import { billingOf, spendDay, spendBreakdown, usdCap, billingChoices } from '../lib/billing.mjs';
import { floorOf } from '../lib/floor.mjs';
import { settingsView, applySettings, generatedLines, rewriteMarked, withDefaults, merged, split, SECTIONS, writeBudgetAsync, atomicWriteAsync as atomicA, onlyChanged, floorChanges, checkinBelowFloor, retiredExecutors, capOfExecutor, getPath, syncPolicy, REQUIRED_CAPS } from '../lib/policy.mjs';
import { recordAsync, loadState, loadStateAsync, recordsFile, readEvents, RecordError, KINDS, writeOrigin, homeOf as homeIdOf, laneId, laneName, laneNameIn, laneIdIn, homeOfId, copyItemsAsync } from '../lib/records.mjs';
import { remoteOf, classify, cookieOf, setCookie, createPairing, devicesFile, POSTS_PER_MIN } from '../lib/remote.mjs';
import { possibleAnswers } from '../lib/qreconcile.mjs';
import { threadOf, rulingOf, unanswered, pickOf } from '../lib/qthread.mjs';
import { ADAPTERS, harnessOf } from '../lib/harness/index.mjs';
import { writeViewsAsync, renderQuestions, renderDirectives } from '../lib/views.mjs';
import { hbPath, stopRunAsync, requeueRun, queueOf, STALE_MS, noteCpu, cpuLogFile } from '../lib/runs.mjs';
import { runSpeedA, isWorker, speedWords } from '../lib/speed.mjs';
import { mergeBacklog, backlogMax } from '../lib/deliverables.mjs';
import { lanesView, sortLanes, handoffOf } from '../lib/lanes.mjs';
import { laneDriver, laneBriefFiles, laneType, laneOutput } from '../lib/purpose.mjs';
import { lanePolicy, laneHooks, laneRulesFile, lanePathsFile } from '../lib/lifecycle.mjs';
import { overlapFile, overlapOn, githubRepo } from '../lib/overlap.mjs';
import { agentsTree, primeAgents, shownRunIds, runTalked, tailA, RUN_WINDOWS, windowMs } from '../lib/agents.mjs';
import { runProgress, workInit, onWork, mergeWork, sessionsOf, laneSteps } from '../lib/progress.mjs';
import { loadMail } from '../lib/mail.mjs';
import { findTranscriptA } from '../lib/harness/claude.mjs';
import os from 'node:os';
import { ctxView } from '../lib/ctxlimit.mjs';
import { mapGraph } from '../lib/map.mjs';
import { LOCK_STALE_MIN, quietFlag } from '../lib/tick.mjs';
import { homeDir, realPath } from '../lib/config.mjs';
import { executorExtra } from '../lib/executors.mjs';
import { loginHolds, authFile } from '../lib/authguard.mjs';
import { cacheFile as vendorCacheFile } from '../lib/vendorstatus.mjs';
import { limitLines } from '../lib/limitgate.mjs';
import { newLaneAsync, LaneError } from '../lib/lanenew.mjs';
import { proposalsOf, primeProposals } from '../lib/proposals.mjs';
import { loadRoadmap, checkLinks, refTerm, writeRoadmapViewAsync, roadmapViewPath, RoadmapError, dlvCopyRow } from '../lib/roadmap.mjs';
import { proposalOf, addRuleAsync, adoptDecideAsync, adoptApplyAsync, adoptCloseAsync, AdoptError, interviewOf, readExecutor, consentLine, ANSWER_KEYS, RULES_FILE, AGENT_FILES, laneNameOf } from '../lib/adopt.mjs';
import { lanePaths } from '../lib/lanenew.mjs';
import { loadMachine, loadProject, ConfigError } from '../lib/config.mjs';
const FIRST_LANE = 'first';   // META-OOTB F-1: the lane the first-task box opens
import { runName } from '../lib/names.mjs';
import { readHoldAsync, holdItem, noticeMin } from '../lib/holds.mjs';
import { handEdits, takeBack, keepEdit, handEditDiff } from '../lib/handedits.mjs';
import { notify as sendNotice, batchHours, ntfyServer, defaultTransport as notifyTransport } from '../lib/notify.mjs';
import { costRollup, accountUsage, weekStart, nextReset, parseReset } from '../lib/cost.mjs';
import { Worker } from 'node:worker_threads';
import { snap, newSnap, readText, readTextA, existsA, existsS, statS, statA, readdirS, readdirA, prime, forget, readJsonS } from '../lib/fsnap.mjs';
import { ART_FILES } from './norn/assets.mjs';
import { homeEvents } from './home.mjs';
import { parseLedgerLine } from './ledger.mjs';
import { ledgerConfig } from '../lib/ledger.mjs';
import { loopOf } from '../lib/sync.mjs';
import { isStale, leaderKey } from '../lib/claims.mjs';
import { insViewFile } from '../lib/guard-scan.mjs';
import { insSummary, insPart } from './insparts.mjs';
import { guardSummary, guardPart, chipView, fixSheet, fixPick } from './guardparts.mjs';
import { SUB_CAP } from './subviews.mjs';
import { isNeed, needsYou } from './terms.mjs';
import { docsList as docsListOf, docKey } from './docparts.mjs';
import { pathsIn } from './prose.mjs';
import { paragraphs } from '../lib/instructions.mjs';
import { enforceCardsAsync } from '../lib/rules.mjs';
import { auditsView, acceptText, auditFiles } from '../lib/audit.mjs';
import { dupOf, dupMessage } from '../lib/dupdirs.mjs';
import { keepFindings, fixPlan, fixBatch, runsFor, fixCards, verdictText, verdictIds, readRunBrief, FIX_LANE, markDeclines, DECLINE_LANE } from '../lib/fixer.mjs';
import { paraMarks } from '../lib/readev.mjs';
import { testsView, testsFiles, suiteOf, testsPart } from '../lib/testscli.mjs';
import { repoFile } from '../lib/testtimes.mjs';
import { projectHome, subdirOf, inDir } from '../lib/monorepo.mjs';
import { guardChips } from '../lib/guard.mjs';
import { usageWeek } from '../lib/usageweek.mjs';
import { classCost } from '../lib/classcost.mjs';
import { advise, decidedKeys, writeAdviceCache, loadAdviceDataAsync } from '../lib/advice.mjs';
import { replayReportFile } from '../lib/eval/report.mjs';
import { GUARD_WORDS } from '../lib/checkinguards.mjs';
import { guardRows, guardView } from '../lib/guardview.mjs';
import { crossingsAsync } from '../lib/advisory.mjs';
import { slopHolds, openBlocks, slopFiles, waiverCmd } from '../lib/slop/host.mjs';
import { explainOf } from '../lib/slop/check.mjs';
import { refusals, withRefusals, REFUSAL_DAYS, refusalsFile } from '../lib/scope.mjs';
import { pickHalf, nearEndMin, pauseState } from '../lib/pause.mjs';
import { PAUSE_MODES, parsePause, stopsCheckins, holdsStarts } from '../lib/pausemode.mjs';

const DASH = path.dirname(fileURLToPath(import.meta.url));
const META_CLI = path.join(DASH, '..', 'bin', 'norn.mjs');
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];
const VENDOR = ['marked.esm.js', 'purify.es.mjs', 'highlight.min.js', 'three.module.js', 'three.core.js', 'silkscreen-latin-400-normal.woff2', 'silkscreen-latin-700-normal.woff2'];
// the Norn look (META-VISUAL-B): its modules + stylesheet, served from norn/ by allowlist; art files only by the asset map
const NORN = ['palette.mjs', 'pixel.mjs', 'assets.mjs', 'motion.mjs', 'look.mjs', 'norn.css',
  'live.mjs', 'stage.mjs', 'weave.mjs', 'mapview.mjs', 'well.mjs', 'tapestry.mjs', 'orc.mjs'];   // META-TEND P6: SloppaChoppa's stage   // S2: the Map (the Well / the Tapestry)
const TYPES = { js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', png: 'image/png' };
const typeOf = f => TYPES[f.split('.').pop()];
export const TABS = ['home', 'overview', 'inbox', 'work', 'lanes', 'runs', 'map', 'plan', 'roadmap', 'health', 'usage', 'slop', 'tests', 'context', 'history', 'records', 'ledger', 'docs', 'settings'];
const hash = s => createHash('sha256').update(s).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const plain = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const iso = () => new Date().toISOString();
const line = s => String(s).replace(/[\r\n\u0000-\u001f]+/g, ' ').trim();
// META-DASH-ASYNC R1 (DEC-338): a request runs inside its snapshot (snap, lib/fsnap.mjs): the files and records folds it needs are read up front
// on fs.promises (primeFor), so the handler's own reads are memory lookups and a stalled syscall delays only its own request, never
// the event loop. read() outside a snapshot (CLI-shaped callers: a POST after its write, a timer) is the sync form.
const read = (p, fallback = '') => { const t = readText(p); return t === null ? fallback : t; };
/** the async read: missing -> fallback; the text lands in the request's snapshot (a second read() of it is a lookup) */
const readA = async (p, fallback = '') => { const t = await readTextA(p); return t === null ? fallback : t; };
const NO_STATE = /^\/api\/(sessions(\/|$)|remote$|adopt\/repos$|timing$)/;   // GET routes that read no project state: no snapshot to prime
async function tail(p, count) {
  const text = await readA(p, null);
  if (text === null) return [];
  return text.replace(/\r/g, '').replace(/\n$/, '').split('\n').slice(-count);
}
const str = (v, name, max) => { if (typeof v !== 'string' || !line(v) || v.length > max) throw fail(400, `${name} must contain 1-${max} characters`); return line(v); };

// STATUS.md (norn status) numbers: trailing rate vs cap, weekly estimate, RATE_OK (port of the live parseStatus usage part)
export function parseStatus(text) {
  const number = s => (s === undefined ? null : Number(s.replaceAll(',', '')));
  const rate = text.match(/=\s*([\d.,]+)\s*%\/h vs cap\s*([\d.,]+)/);
  const weekly = text.match(/estimated weekly now ~([\d.,]+)\s*%/);
  const gate = text.match(/^RATE_OK=([01])/m);
  return { rate: number(rate?.[1]), cap: number(rate?.[2]), weekly: number(weekly?.[1]), rateOK: gate ? gate[1] === '1' : null };
}

function run(exe, args, { input, timeout = 25000, ...o } = {}) {
  return new Promise((resolve, reject) => {
    let child, stdout = '', stderr = '', settled = false;
    const finish = (e, v) => { if (settled) return; settled = true; clearTimeout(timer); e ? reject(e) : resolve(v); };
    const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* gone */ } finish(fail(504, 'Child process timed out')); }, timeout);
    try { child = spawn(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...o }); } catch (e) { finish(e); return; }
    child.stdout.on('data', b => { stdout += b.toString('utf8'); });
    child.stderr.on('data', b => { stderr = (stderr + b.toString('utf8')).slice(-16000); });
    child.on('error', finish); child.stdin.on('error', () => {});
    child.on('close', code => (code === 0 ? finish(null, stdout) : finish(fail(502, `Process exited ${code}: ${stderr.slice(-1000) || stdout.slice(-1000)}`))));
    child.stdin.end(input ?? '');
  });
}
// The real side effects; tests inject their own. tick = detached `norn tick --project <file>` (the scheduler's own entry).
function nativePlatform(machine) {
  return {
    tick: async p => { const c = spawn(process.execPath, [META_CLI, 'tick', '--reason', 'dashboard', '--project', p.file], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); return { pid: c.pid }; },
    setInterval: async m => ({ ok: false, error: `scheduler not changed: run "norn sched install" for ${m} min` }),
    // META-ADOPT A3: Rehearse first (free) = the lane's brief on the fake executor, detached (its run shows on Agents / Lanes)
    rehearse: async (p, lane, brief) => { const c = spawn(process.execPath, [META_CLI, 'run', '--executor', 'fake', '--lane', lane, '--brief', brief, '--project', p.file, '--state', p.state], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); return { pid: c.pid }; },
    ask: async (prompt, b, cwd) => {
      const out = await run(machine?.claude?.exe || 'claude', ['-p', '--model', b.checkin_model, '--effort', b.checkin_effort, '--no-session-persistence',
        '--permission-mode', 'bypassPermissions', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
        '--settings', '{"disableAllHooks":true}'], { cwd, input: prompt, timeout: 240000 });
      const result = JSON.parse(out); if (result.is_error || typeof result.result !== 'string') throw fail(502, 'Claude returned an error or no reply');
      return result;
    },
  };
}

/**
 * o: { projects [loadProject objects], machine (loadMachine object), budgetFile (machine local/budget.json), platform?, quietFile?,
 *      projectsDir?, codexDir?, liveUsage?, sessionsDir?, spawnFn?, claudeExe?, metaRoot?, env?, registered? }
 * META-ADOPT A3: with metaRoot the dashboard may start with ZERO projects (Add a project is the first screen) and, unless registered
 * is false (explicit --project files), re-reads the registered list from machine.json when it changes.
 */
export function createDashboard(o) {
  let projects = o.projects || [];
  if (!projects.length && !o.metaRoot) throw new Error('createDashboard: no projects (and no metaRoot to add one)');
  const metaRootDir = o.metaRoot ?? (o.budgetFile ? path.resolve(path.dirname(o.budgetFile), '..') : null);
  const cliEnv = { ...(o.env ?? process.env), ...(o.metaRoot ? { META_ROOT: o.metaRoot } : {}) };
  const machine = o.machine || {}, home = machine.home || homeDir();
  const projectsDir = o.projectsDir ?? machine.claude?.projects_dir ?? path.join(home, '.claude', 'projects');
  const codexDir = o.codexDir ?? path.join(home, '.codex', 'sessions');
  const ART = o.artDir ?? path.join(DASH, 'norn', 'art');   // the Norn art drop-in folder (tests point it at a temp dir)
  const platform = o.platform ?? nativePlatform(machine), token = randomBytes(24).toString('hex');
  // META-CONTROLLER C6 (SPEC sec. 5): dash.remote on = a host allow-list + the proxy's identity header + paired devices; off (null) = as before
  const remote = metaRootDir ? remoteOf(machine) : null, pairing = remote ? createPairing({ file: devicesFile(metaRootDir) }) : null;
  const postsPerMin = o.remotePostsPerMin ?? POSTS_PER_MIN, writes = new Map();
  const cache = new Map();
  let mutation = Promise.resolve(), askBusy = false, checkinStarting = false;
  const serial = fn => { const next = mutation.then(fn); mutation = next.catch(() => {}); return next; };
  const firstP = () => projects[0] ?? null;
  const noProject = () => fail(409, 'No project yet: Add a project first (the dashboard opens on it; or norn project new --root <repo>)');
  const sessionsDir = o.sessionsDir ?? (firstP() ? path.join(path.dirname(path.resolve(firstP().state)), '..', 'sessions') : path.join(metaRootDir, 'sessions'));
  // META-ADOPT A3: the project list re-read from machine.json when it changed (Add a project, norn project new / remove elsewhere);
  // explicit --project files are re-loaded one by one (an adopt apply writes merge.gate / rules_read_whole into project.json)
  const machineFile = metaRootDir ? path.join(metaRootDir, 'local', 'machine.json') : null;
  let machineSig = null;
  function reloadProjects(force = false) {
    try {
      if (o.metaRoot && o.registered !== false && machineFile) {
        const ms = statS(machineFile); if (!ms) throw Object.assign(new Error('no machine.json'), { code: 'ENOENT' });
        const sig = ms.mtimeMs + ':' + ms.size;
        if (!force && sig === machineSig) return;
        const m = loadMachine(machineFile, { meta: o.metaRoot });
        const next = m.projects.map(x => { try { return loadProject(x.config, { home: m.home, meta: o.metaRoot }); } catch { return null; } }).filter(Boolean);
        machineSig = sig; projects = next; return;
      }
      if (force) projects = projects.map(p => { try { return loadProject(p.file, { home, meta: metaRootDir ?? undefined }); } catch { return p; } });
    } catch (e) { if (!(e instanceof ConfigError) && e.code !== 'ENOENT') throw e; }
  }
  /** META-DASH-ASYNC R1: reloadProjects for a GET (/api/projects): the stat and, when machine.json changed, its text and the projects' files on fs.promises */
  async function reloadProjectsA() {
    if (!(o.metaRoot && o.registered !== false && machineFile)) return;
    const x = await statA(machineFile); if (!x || x.mtimeMs + ':' + x.size === machineSig) return;
    await readTextA(machineFile);
    try { await prime({ files: loadMachine(machineFile, { meta: o.metaRoot }).projects.map(q => q.config) }); } catch (e) { if (!(e instanceof ConfigError)) throw e; }
    reloadProjects();
  }
  const directive = async (p, text, via) => { const ev = await recordAsync(p.state, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text, via } }); await viewsA(p); return ev; };
  const sessions = createSessions({ dir: sessionsDir, exe: o.claudeExe ?? machine.claude?.exe ?? 'claude', spawnFn: o.spawnFn,
    onText: (rec, text) => {
      if (rec.kind !== 'controller') return;
      const p = projects.find(x => x.name === rec.project) || firstP();
      if (!p) return;
      const ds = text.split(/\r?\n/).filter(r => r.startsWith('DIRECTIVE:')).map(r => line(r.slice(10))).filter(Boolean);
      if (ds.length) serial(async () => { for (const d of ds) await directive(p, d, 'talk'); }).catch(() => {});
    } });

  const pick = (url, { all = false } = {}) => {
    if (!projects.length) throw noProject();
    const n = url.searchParams.get('project') ?? firstP().name;
    if (n === 'all') { if (!all) throw fail(400, 'Choose one project for this tab'); return projects; }
    const p = projects.find(x => x.name === n);
    if (!p) throw fail(404, `Unknown project ${n}`);
    return [p];
  };
  const one = url => pick(url)[0];
  // st(p): the request snapshot's fold (primed on fs.promises by primeFor) - the sync loadState only outside a snapshot
  const st = p => snap.getStore()?.folds.get(p.state) ?? loadState(p.state);
  const viewsA = async p => writeViewsAsync(p.state, await stAsync(p), p.views || {}, { role: 'dashboard' });
  const hbAge = p => id => { const x = statS(hbPath(p.state, id)); return x ? Date.now() - x.mtimeMs : Infinity; };
  // the live hand-off state (lanes.mjs handoffOf, one home): wrote = the run's own result.json says HANDOFF, written since its start
  // (result.mjs readResult's rule); talked = its session's first model event (agents.mjs runTalked, the tree's tail cache)
  const wroteHandoff = p => id => { const j = readJsonS(resultPath(p.state, id)), r = st(p).items[id];
    return !!r && j?.run === id && j.outcome === 'handoff' && Date.parse(j.at) >= Date.parse(r.created) - 2000; };
  const hoHooks = p => ({ wrote: wroteHandoff(p), talked: id => runTalked(st(p).items[id], { projectsDir, codexDir, cache }) });
  const hoOf = (p, r) => handoffOf(r, st(p).items, hoHooks(p));
  // the same outside a request (the feed head polls on a timer): the fold, then the chain's result files and session tails on fs.promises
  async function hoOfA(p, r) {
    const s = await stAsync(p), chain = [r];
    for (let x = r; x?.resume?.next && s.items[x.resume.next] && !chain.includes(s.items[x.resume.next]);) chain.push(x = s.items[x.resume.next]);
    await Promise.all([prime({ files: chain.map(x => resultPath(p.state, x.id)) }), primeAgents(chain, { projectsDir, codexDir, cache })]);
    return hoOf(p, r);
  }
  const runsOf = s => Object.values(s.items).filter(i => i.kind === 'run');
  // RM-46 S3 (SPEC 3.3, 4.7): a synced project's row of another home = { home } (its "on b" chip) + the pending events on it, each with
  // the primary that has not committed it yet ("answered on a, pending b"); an own row or a solo project adds nothing
  function foreign(p, s, id) {
    const h = homeIdOf(p.state);
    if (!h) return {};
    const w = homeOfId(id, h.bare_home), pd = s.pending?.[id] || [];
    return { ...(w && w !== h.id ? { home: w } : {}), ...(pd.length ? { pending: pd.map(e => ({ ev: e.ev, home: e.home, ts: e.ts, primary: w })) } : {}) };
  }
  // a lane name another home wrote (its own x) as this home types it (b/x)
  const laneFrom = (p, id, lane) => { const h = homeIdOf(p.state); return !h || typeof lane !== 'string' ? lane : laneNameIn(laneIdIn(lane, homeOfId(id, h.bare_home)), h.id); };
  // the records fold, re-read only when a records file changed (the feed head asks every poll)
  const folds = new Map();
  function stCached(p) {
    const primed = snap.getStore()?.folds.get(p.state); if (primed) return primed;
    const key = ['question', 'run'].map(k => { try { const s = fs.statSync(recordsFile(p.state, k)); return s.mtimeMs + ':' + s.size; } catch { return '-'; } }).join('|');
    const c = folds.get(p.state);
    if (c && c.key === key) return c.st;
    const s = loadState(p.state); folds.set(p.state, { key, st: s }); return s;
  }
  /** the fold on fs.promises: two async stats, the cached fold when they match, else loadStateAsync; lands in the request snapshot */
  const statSig = f => fs.promises.stat(f).then(x => x.mtimeMs + ':' + x.size, () => '-');
  async function stAsync(p) {
    const sn = snap.getStore(), hit = sn?.folds.get(p.state); if (hit) return hit;
    // RM-46 S3: a synced dir folds the other homes' copies too (the fetch rewrites them): their records + relay files are in the key
    const hs = (await fs.promises.readdir(path.join(p.state, 'homes'), { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory()).flatMap(d => ['records.jsonl', 'relay.jsonl'].map(x => path.join(p.state, 'homes', d.name, x)));
    const key = (await Promise.all([...['question', 'run'].map(k => recordsFile(p.state, k)), path.join(p.state, 'relay.jsonl'), ...hs].map(statSig))).join('|');
    let c = folds.get(p.state);
    if (!c || c.key !== key) { c = { key, st: await loadStateAsync(p.state) }; folds.set(p.state, c); }
    sn?.folds.set(p.state, c.st);
    return c.st;
  }
  /** a GET's snapshot: every project's records fold + its settings / status files, read concurrently on fs.promises */
  // + the small records files (the fold's two come from stAsync), their stats, the running runs' heartbeats, the PAUSED records (pausemode.mjs), the tick.lock flag
  const primeFor = ps => Promise.all(ps.flatMap(p => [
    stAsync(p).then(x => { const live = runsOf(x).filter(r => r.state === 'running');
      // handoffOf's reads (hoHooks): each running run's result.json, a running hand-off resume's transcript / rollout tail
      return Promise.all([prime({ files: [...auditFiles(p, x.items), ...live.map(r => resultPath(p.state, r.id))], stats: live.map(r => hbPath(p.state, r.id)) }),
        primeAgents(live.filter(r => r.data.resume_of), { projectsDir, codexDir, cache })]); }),
    readA(p.file), readA(path.join(p.state, 'STATUS.md')),
    prime({ files: [authFile(p.state), vendorCacheFile(p.state), overlapFile(p.state), laneRulesFile(p.state), lanePathsFile(p.state), ...pausedFiles(p), path.join(p.state, 'home.json'), ...(p.policy_targets || []), ...RECORD_FILES.filter(f => f !== 'records' && f !== 'runs').map(f => path.join(p.state, f + '.jsonl'))],
      stats: [...RECORD_FILES.map(f => path.join(p.state, f + '.jsonl')), path.join(p.state, 'tick.lock'), p.state, (p.project_dir || p.file) && rulesFile(p), ...(p.docs || []).map(d => d.path)] })])
    .concat(o.budgetFile ? [readA(o.budgetFile, '{}')] : [], o.quietFile ? [readA(o.quietFile)] : [], o.liveUsage ? [readA(o.liveUsage)] : []));
  const pausedFiles = p => [path.join(path.dirname(path.resolve(p.state)), 'PAUSED'), path.join(p.state, 'PAUSED')];
  // RM-37: the pause in force (pausemode.mjs, read through the snapshot) + what waits because of it: the queued runs it holds, the runs asked to
  // pause, the paused hand-offs; the modes and their one-line effects (the header's pause menu)
  const pauseOfP = p => { for (const f of pausedFiles(p)) { const raw = readText(f); if (raw !== null) return parsePause(raw, f); } return null; };
  const pauseView = ps => {
    const p = ps.find(x => pauseOfP(x)) ?? null, pz = p ? pauseOfP(p) : null, runs = ps.flatMap(x => runsOf(st(x)).map(r => ({ ...r, project: x.name })));
    const row = r => ({ run: r.id, lane: r.data.lane ?? null, project: r.project, stage: r.data.stage ?? null });
    return { pause: pz ? { ...pz, project: p.name, says: PAUSE_MODES[pz.mode].says, checkins: stopsCheckins(pz) } : null,
      modes: Object.entries(PAUSE_MODES).map(([mode, m]) => ({ mode, ...m })),
      waiting: { held: holdsStarts(pz) ? runs.filter(r => r.state === 'queued').length : 0, asked: runs.filter(r => pauseState(r) === 'asked').map(row),
        handoffs: runs.filter(r => pauseState(r) === 'handoff').map(row) } };
  };

  // ---------- budget (machine) + policy (project) ----------
  function budgetRaw() { return read(o.budgetFile, '{}'); }
  function projectRaw(p) { return read(p.file); }
  function settingsState(p) {
    const braw = budgetRaw(), praw = projectRaw(p);
    const budget = JSON.parse(braw || '{}'), proj = JSON.parse(praw);
    return { budget, proj, view: merged(budget, proj.policy), version: hash(braw + '\n\u0000\n' + praw) };
  }
  const exExtra = p => executorExtra(p);  // configured typed executors: names, cap defaults, enabled (META-EXEC-S1, META-AGNOSTIC-EXEC)
  async function regenerate(p, m) {
    const lines = generatedLines(m, exExtra(p)), done = [];
    for (const f of p.policy_targets || []) {
      const t = await readA(f, null); if (t === null) continue;
      const r = rewriteMarked(t, lines); if (r.changed.length) { await atomicA(f, r.text); done.push(f); }
    }
    return done;
  }
  function settingsInfo(p) {
    const s = settingsState(p);
    const quietRule = o.quietFile ? read(o.quietFile).split(/\r?\n/)[0] || '(rules file empty)' : '(no rules file)';
    const targets = (p.policy_targets || []).map(f => { const t = read(f, null); return { file: f, exists: t !== null, markers: t === null ? [] : [...t.matchAll(/<!-- policy:([a-z_.]+) -->/g)].map(m => m[1]) }; });
    return { project: p.name, version: s.version, files: { machine: o.budgetFile, project: p.file },
      settings: settingsView(s.view, { quietRule, quietFile: o.quietFile, ...exExtra(p) }), sections: SECTIONS, generated: generatedLines(s.view, exExtra(p)), targets,
      // F-6: each profile as Settings changes for this project's executors + role agents - the form is filled, Save stays the human step
      profiles: profileChoices(profileFor(p, s)), profile_now: profileNow(p, s), billing: billingChoices(), billing_now: s.budget?.billing ?? null,
      notify: notifyInfo(p), checkin_below: checkinBelowFloor(s.view) };   // RM-26: the Settings notice while a check-in setting is below the floor
  }
  // META-PROFILE-BUG R1: a profile routes to the Codex executors this machine has (setup found codex) and the project did not switch
  // off, never to a retired one (retiredExecutors: its own cap 0 while Codex is open); the role names are the project's own agents
  const CODEX_EX = ['codex-sol', 'codex-astra'];
  const profileFor = (p, s = settingsState(p)) => { const gone = retiredExecutors(s.budget);
    return { found: ['claude', ...CODEX_EX.filter(x => machine.codex?.exe && p.executors?.[x]?.enabled !== false && !gone.includes(x))], agents: exExtra(p).agents, floor: floorOf(s.budget) }; };   // the worker floor: a profile is raised to it (profiles.mjs)
  const capsRec = i => i.kind === 'decision' && i.state !== 'overruled' && /caps profile$/.test(i.data?.question ?? '');
  /** the profile in force: the latest caps profile decision + how many of its keys (or the owner's own keys of that save) now differ */
  function profileNow(p, s = settingsState(p)) {
    const d = Object.values(st(p).items).filter(capsRec).sort((a, b) => Number(b.id.split('-').pop()) - Number(a.id.split('-').pop()))[0];
    const name = d?.data?.profile ?? d?.data?.choice, prof = loadProfiles().profiles.find(x => x.name === name);
    if (!d || !prof) return { kind: d ? 'kept' : 'none', label: d?.data?.choice ?? null, at: d?.created ?? null, own: 0 };
    const view = withDefaults(s.view), differs = (k, v) => JSON.stringify(getPath(view, k)) !== JSON.stringify(v);
    const own = new Set([...Object.entries(d.data.values ?? {}).filter(([k, v]) => differs(k, v)).map(([k]) => k), ...(d.data.own ?? [])]);
    return { kind: 'profile', name: prof.name, label: prof.label, cost: d.data.cost ?? 'balanced', at: d.created, own: own.size };
  }
  /** Review changes: each change in plain words (the setting's label, from -> to) + flags: a recorded ruling names the key, a retired
   *  executor, a check-in model / effort below the check-in floor (policy CHECKIN_FLOOR: a warning, the save is not refused) */
  function reviewSettings(p, changes, version) {
    const s = settingsState(p);
    if (version !== s.version) throw fail(409, 'Settings changed elsewhere. Reload and review the diff again.');
    const fc = floorChanges(s.view, changes, exExtra(p)), asked = changes; changes = fc.changes;   // the worker floor raises the settings it leaves below it
    const updated = applySettings(s.view, changes, exExtra(p)), rows = settingsView(s.view, exExtra(p)), retired = retiredExecutors(s.budget), lowCheckin = checkinBelowFloor(updated);
    const rulings = Object.values(st(p).items).filter(i => (i.kind === 'directive' && i.state === 'active') || (i.kind === 'decision' && i.state !== 'overruled' && !capsRec(i)));
    const words = v => (v === null || v === undefined ? 'unset' : Array.isArray(v) ? v.join(', ') || '(none)' : String(v));
    const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lines = Object.keys(changes).map(k => {
      const row = rows.find(r => r.key === k), from = row ? row.value : getPath(withDefaults(s.view), k), to = getPath(updated, k), flags = [];
      const named = new RegExp(`(^|[^a-z0-9_.])(policy\\.)?${esc(k.replace(/^policy\./, ''))}($|[^a-z0-9_])`, 'i');
      for (const r of rulings) {
        const t = String((r.kind === 'directive' ? r.data.text : [r.data.question, r.data.choice, r.data.why].join(' ')) ?? '').replace(/\s+/g, ' '), m = named.exec(t);
        if (m) { const a = Math.max(0, m.index - 60), b = Math.min(t.length, m.index + 100);   // the words around the key
          flags.push(`${r.id} names this setting: "${a ? '...' : ''}${t.slice(a, b).trim()}${b < t.length ? '...' : ''}"`); }
      }
      if (typeof to === 'string' && retired.includes(to) && /^policy\.(executors\.[a-z_]+\.executor|fallbacks\.)/.test(k)) flags.push(`${to} is retired (${capOfExecutor(to)} is 0)`);
      const capX = retired.find(x => capOfExecutor(x) === k);
      if (capX && to > 0) flags.push(`re-enables retired ${capX} (${k} is 0)`);
      if (!Object.hasOwn(asked, k)) flags.push('raised to the worker minimum');
      for (const r of lowCheckin) if (r.key === k) flags.push(`${r.value} is ${r.text}`);
      const label = row?.label ?? k;
      return { key: k, label, from, to, text: `${label}: ${words(from)} -> ${words(to)}`, flags };
    });
    return { ok: true, lines };
  }
  // META-NOTIFY-SETUP R1: the Settings Notifications row - backend (+ the ntfy server; never the topic), the fyi batch hours
  function notifyInfo(p) {
    const n = machine.notify ?? { backend: 'none' };
    let server = null, batch_h = null;
    if (n.backend === 'ntfy') { try { server = ntfyServer(n.server).replace(/\/$/, ''); } catch { server = '(invalid server)'; } }
    try { batch_h = batchHours(p); } catch { batch_h = null; }
    return { backend: n.backend, server, topic_set: n.backend === 'ntfy' ? !!n.topic : null, batch_h };
  }

  // ---------- tab data ----------
  // META-HOME-POLISH R1: what needs you in one project (the Home opens on the first that has some); a broken project counts 0
  // META-TEND P4: what NEEDS you = every Inbox row but answered Qs and model advice (advisory: it blocks nothing, it waits for a tap).
  // UX review 4: the one count is terms.mjs needsYou - Overview, Inbox, Home and the project picker all use it.
  const RESOLVED_MAX = 20;   // INBOX-REPLIES: the Resolved view's newest answered / applied Qs per project
  const needsOf = async p => { try { return needsYou(await inbox(p)); } catch { return 0; } };
  async function inbox(p) {
    const s = await stAsync(p), items = Object.values(s.items), out = [];
    // META-ADOPT A3: ONE needs-you row while a drafted setup has parts to review (not one per missing thing)
    if (await existsA(recordsFile(p.state, 'proposal'))) {   // its own file (adopt.jsonl): not in the loadState fold
      const P = proposalOf(p.state);
      if (P?.state === 'open' && P.draft && P.undecided.length)
        out.push({ type: 'setup', id: P.id, project: p.name, title: `Review the draft setup (${P.undecided.length} part${P.undecided.length === 1 ? '' : 's'})`, created: P.created });
    }
    // GAP-1 (holds.mjs): ONE needs-you row while ALL queued work has waited on one machine-level hold past policy.holds.notice_min
    // (the tick keeps hold.json; it is gone - and the row with it - once the hold clears)
    { const h = holdItem(await readHoldAsync(p.state), { min: noticeMin(withDefaults(settingsState(p).view).policy), status: await readA(path.join(p.state, 'STATUS.md')), project: p.name });
      if (h) out.push(h); }
    // GAP-8 (handedits.mjs): a generated file edited by hand is no longer regenerated - one row each (take it back / keep mine)
    for (const e of await handEdits(p.state)) if (!e.kept) out.push({ type: 'handedit', id: 'edit-' + path.basename(e.file), project: p.name, file: e.file.replace(/\\/g, '/'), created: e.edited, generated: e.generated,
      verdict: e.verdict, recommend: e.recommend, why: e.why, lines: e.lines, diff: e.diff,   // RM-35: what changed and who probably did it
      title: `${path.basename(e.file)} changed outside Norn: Norn has stopped updating it` });
    // OOTB-R2 N-5: runs held for a login that is down = ONE needs-you row per harness, carrying the command the human runs
    for (const h of loginHolds(p.state, items, { entryOf: x => p.executors?.[x] }))
      out.push({ type: 'login', id: 'login-' + h.harness, project: p.name, harness: h.harness, cls: h.cls, command: h.command, runs: h.runs, line: h.line, created: h.since,
        title: h.title });   // META-AUTH-VENDOR: a vendor hold names the incident and says no login is needed
    const pa = new Map(possibleAnswers(items).map(x => [x.q, x]));   // META-Q-RECONCILE R1: the hint "already answered in DEC-m"
    // INBOX-REPLIES: + the source the options came from, the thread (owner messages, controller replies, revisions), the ruling to confirm
    for (const q of items.filter(i => i.kind === 'question' && i.state === 'open')) out.push({ type: 'question', id: q.id, project: p.name, lane: laneFrom(p, q.id, q.data.lane), ...foreign(p, s, q.id), title: q.data.title, body: q.data.body ?? null, options: q.data.options ?? [], recommend: q.data.recommend ?? null, class: q.data.class ?? null, created: q.created,
      origin: q.data.origin ?? null, thread: threadOf(q), waiting: unanswered(q).length, proposal: rulingOf(q),
      ...(pa.has(q.id) ? { answered_by: { id: pa.get(q.id).dec, words: pa.get(q.id).words, why: pa.get(q.id).why } } : {}) });
    // RM-28 S1: a finished planner run = ONE decision card (its summary, plan, a Queue now / Later / Drop per open stage)
    await primeProposals(s.items);
    for (const x of proposalsOf(s.items, loadRoadmap(p.state))) out.push({ type: 'proposal', id: x.run, project: p.name, lane: x.lane, item: x.item, title: `Decide: ${x.lane} plan`,
      summary: x.summary, plans: x.plans, stages: x.stages, open: x.open, created: x.ended });
    // META-TEND P3: the repeat detector's approval cards (one per cluster, ranked): approve = a directive the check-in turns into a brief
    for (const c of await enforceCardsAsync(p.state, s.items)) out.push({ type: 'enforce', id: c.id, project: p.name, title: c.why, card: c, approve: c.approve, asked: c.asked, created: null });
    // META-TEND P5: the vendor audit's hunks - one card each (accept = a decision + a directive: the check-in applies it; decline = a decision)
    for (const c of auditsView(p, s.items).cards) out.push({ type: 'audit', id: c.id, project: p.name, title: c.why, card: c, created: null });
    // META-UX-BUILD S7: the fixer's result - ONE card per run (every file, every hunk; Apply all / Skip this file / Discard)
    for (const c of fixCards(s.items, { batch: fixBatch(withDefaults(settingsState(p).view).policy), root: p.root })) out.push({ type: 'fixresult', id: c.run, project: p.name, title: `Fixer result ${c.run}: ${c.n} hunk(s) in ${c.files.length} file(s)`, card: c, created: c.created });
    for (const q of items.filter(i => i.kind === 'question' && i.state === 'answered')) out.push({ type: 'answered', id: q.id, project: p.name, lane: q.data.lane, title: q.data.title, answer: q.answer, updated: q.updated });
    // INBOX-REPLIES: the Resolved view - answered / applied Qs, newest first, each with its thread kept (for information: never a need)
    for (const q of items.filter(i => i.kind === 'question' && ['answered', 'applied'].includes(i.state)).sort((a, b) => String(b.updated).localeCompare(String(a.updated))).slice(0, RESOLVED_MAX))
      out.push({ type: 'resolved', id: q.id, project: p.name, lane: q.data.lane, title: q.data.title, state: q.state, options: q.data.options ?? [], origin: q.data.origin ?? null, answer: q.answer, thread: threadOf(q), updated: q.updated });
    // item 8 (MAIL-9): a lane parked on a question the owner answered carries the ruling (ruled) - not a need: it waits for the check-in
    for (const l of items.filter(i => i.kind === 'lane' && i.state === 'parked')) { const q = l.park?.q ? s.items[l.park.q] : null;
      out.push({ type: 'parked', id: l.id, lane: laneName(l.id, p.state), project: p.name, why: l.park?.why ?? null, q: l.park?.q ?? null,
        ...(q?.state === 'answered' ? { ruled: { q: q.id, choice: q.answer?.choice ?? null, text: q.answer?.text ?? null, at: q.updated } } : {}) }); }
    // META-TEND P4: model advice = one card each, one tap applies the Settings change or keeps it (both a decision record)
    let adv = [];
    try { adv = (await adviceOf(p)).cards; } catch { adv = []; }
    for (const c of adv) out.push({ type: 'advice', id: c.key, project: p.name, check: c.check, cls: c.id, title: c.title, severity: c.severity, text: c.text, fix: c.fix, change: c.change, source: c.source, trial: c.trial, created: null });
    for (const r of runsOf(s).filter(r => ['exited', 'lost', 'killed'].includes(r.state) && !r.review && r.data.role !== 'helper' && (r.state !== 'exited' || r.end?.outcome === 'stopped')))
      out.push({ type: 'unreviewed', id: r.id, name: runName(r), project: p.name, lane: r.data.lane ?? null, state: r.state, outcome: r.end?.outcome ?? r.state, why: r.end?.why ?? r.lost?.why ?? r.kill?.why ?? null });
    return out;
  }
  // RM-30 S1: what the prose renderer (prose.mjs) needs per project: its lane names, its GitHub repo (PR / commit links; the origin is
  // read once per root) and the Docs key of each path the Inbox texts name that the Docs reader can show (a scan row or a project doc)
  const repoOf = new Map();
  const repoSlug = p => { if (!repoOf.has(p.root)) repoOf.set(p.root, new Promise(r => execFile('git', ['-C', p.root || '.', 'remote', 'get-url', 'origin'], { timeout: 5000, windowsHide: true }, (e, out) => r(e ? null : githubRepo(String(out).trim()))))); return repoOf.get(p.root); };
  async function proseOf(p, items) {
    const home = homeIdOf(p.state)?.id, lanes = Object.values((await stAsync(p)).items).filter(i => i.kind === 'lane').map(i => laneNameIn(i.id, home));
    const texts = items.flatMap(i => [i.body, i.title, i.why, i.answer?.text, i.recommend?.why, i.file && `\`${i.file}\``, i.card?.why, ...(i.options || []).flatMap(o => [o.text ?? o.t, o.cost ?? o.c])]).filter(x => typeof x === 'string');
    const want = [...new Set(texts.flatMap(pathsIn))], docs = {};
    if (want.length) {
      const rows = [...(insCache(p).v?.rows || []).filter(r => r.exists).map(r => ({ key: r.id, path: r.path })), ...docsList(p).filter(d => d.exists).map(d => ({ key: docKey(d.i), path: d.path }))];
      const byPath = new Map(rows.map(r => [fwdLow(r.path), r.key])), byName = new Map();
      for (const r of rows) { const b = path.posix.basename(fwdLow(r.path)); byName.set(b, byName.has(b) ? null : r.key); }   // a name two files share opens neither
      for (const w of want) { const k = /[\\/]/.test(w) ? byPath.get(fwdLow(path.resolve(p.root || '.', w))) : byName.get(w.toLowerCase()); if (k) docs[w] = k; }
    }
    return { lanes, repo: await repoSlug(p), docs };
  }
  // GAP-12: the overlap cache (overlap.mjs; the tick / a lane start refresh it) on its running lanes - read only, never a fetch here
  function lanes(p, all) {
    const ov = overlapOn(p.policy) ? readJsonS(overlapFile(p.state))?.lanes || {} : {};
    const pol = withDefaults(settingsState(p).view).policy;   // lifecycle.mjs: the row's rule (idle / stopped / archives in n days) from the tick's git answers
    const s = st(p), pz = l => pauseState(s.items[l.run]);   // RM-37: the lane's latest run: Pause / pausing / Resume
    return lanesView(s, { all, hbAge: hbAge(p), ...hoHooks(p), oldDays: pol.done_lanes.old_days, ...lanePolicy(pol), ...laneHooks(p.state) }).map(l => ({ ...l, project: p.name, ...foreign(p, s, l.id), ...(l.run_state === 'running' && ov[l.name]?.overlaps?.length ? { overlap: ov[l.name].overlaps } : {}), ...(pz(l) ? { pause: pz(l) } : {}) }));
  }
  // gap #9: API billing only - one project's $ per lane: today / 7 days / to date (ended runs = the CLI's figure, running = a live estimate)
  const apiOn = ps => billingOf(withDefaults(settingsState(ps[0]).view))?.type === 'api';
  const spendOf = p => spendBreakdown(path.dirname(p.state), { projectsDir, projects: [path.basename(p.state)] })[0] ?? { project: p.name, chats: { today: 0, week: 0 }, lanes: [] };
  // RM-34: each Lanes row's driver (purpose.mjs: the objective + where it is written); the briefs it reads are primed by primeBriefs
  const briefsDirOf = p => path.resolve(p.briefs_dir || path.join(p.state, 'briefs'));
  const briefHead = f => (readText(f) ?? '').split(/\r?\n/).find(l => /^#/.test(l)) ?? null;
  const primeBriefs = ps => Promise.all(ps.map(p => { const items = st(p).items, home = homeIdOf(p.state)?.id;
    return prime({ files: Object.values(items).filter(l => l.kind === 'lane').flatMap(l => laneBriefFiles(laneNameIn(l.id, home), items, briefsDirOf(p))) }); }));
  // MAIL-29: its type (purpose.mjs laneType) and where its output goes (laneOutput): PR state from the deliverables cache (the child
  // process keeps it; never git here), the branch tips' subjects as the commit-type signal, documents to the run's notes folder
  const notesOf = (p, lane, items) => {
    const n = Object.values(items).filter(r => r.kind === 'run' && r.data?.lane === lane && r.data.notes).sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }))[0]?.data.notes;
    const dir = n ? (/\.md$/i.test(n) ? path.dirname(n) : n) : path.join(p.state, 'notes', lane), rel = path.relative(path.resolve(p.root || path.dirname(p.state)), path.resolve(dir));
    return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : dir).replace(/\\/g, '/') + '/';
  };
  function withDriver(p, rows) {
    const o = { items: st(p).items, roadmap: loadRoadmap(p.state), briefTitle: briefHead, briefsDir: briefsDirOf(p), project: p.name }, dl = deliverablesOf(p).rows || [];
    return rows.map(l => { const dv = dl.filter(r => r.lane === l.name), lane_type = laneType(l.name, { ...o, commits: dv.map(r => r.subject).filter(Boolean) });
      return { ...l, driver: laneDriver(l.name, o), lane_type, output: laneOutput(lane_type.type, { deliverables: dv, notes: notesOf(p, l.name, o.items), repo: p.root ? path.basename(p.root) : null }) }; });
  }
  // RM-39: each run's progress against its brief, pace, why slow and alarms in words (progress.mjs). The files are read on
  // fs.promises first (the brief, NOTES, every session's transcript - tailed into the shared cache under its own key), then the
  // derivation runs on what was read. CPU = the os.cpus() deltas between two reads of the dash (no timer, no wait; null at first),
  // sampled at most every 15 s: os.cpus() costs real time on a loaded Windows box (a browser test saw 2 s of it in 23 s, unthrottled)
  let cpuPrev = null, cpuPct = null;
  const cpuNow = () => {
    if (cpuPrev && Date.now() - cpuPrev.at < 15000) return cpuPct;
    const t = os.cpus().reduce((s, c) => { const x = c.times; s.idle += x.idle; s.all += x.user + x.nice + x.sys + x.idle + x.irq; return s; }, { idle: 0, all: 0, at: Date.now() });
    if (cpuPrev && t.all > cpuPrev.all) { cpuPct = 100 * (1 - (t.idle - cpuPrev.idle) / (t.all - cpuPrev.all)); if (metaRootDir) noteCpu(cpuPct, 'dash', { file: cpuLogFile(metaRootDir) }); }
    cpuPrev = t;
    return cpuPct;
  };
  const PKEY = '\u0000progress:', pview = f => ({ get: () => cache.get(PKEY + f), set: (_f, v) => cache.set(PKEY + f, v) });
  const transcriptOf = r => r.end?.transcript || r.data?.transcript || (r.data?.session_id ? findTranscriptA(projectsDir, r.data.session_id) : null);
  /** run id -> its progress, for the worker runs among ids (a run with a brief and a lane); ctxOf(id) = its context now | null */
  async function progressOf(p, ids, ctxOf = () => null) {
    const items = st(p).items, rs = [...new Set(ids)].map(id => items[id]).filter(r => r?.kind === 'run' && r.data?.brief && r.data.lane && r.data.role !== 'helper');
    if (!rs.length) return new Map();
    const sess = new Map(rs.map(r => [r.id, sessionsOf(r, items)])), files = new Map();
    await Promise.all([prime({ files: rs.flatMap(r => [r.data.brief, r.data.notes].filter(Boolean)) }),
      ...[...new Set([...sess.values()].flat())].map(async r => { const f = await transcriptOf(r); if (f) { files.set(r.id, f); await tailA(f, pview(f), workInit, onWork); } })]);
    let mails = [];
    try { mails = Object.values(loadMail(p.state)); } catch { mails = []; }
    const gc = guardChips(p.state), cpu = cpuNow(), out = new Map();
    for (const r of rs) {
      const work = mergeWork(sess.get(r.id).map(x => files.has(x.id) ? cache.get(PKEY + files.get(x.id)) : null));
      out.set(r.id, runProgress(r, { runs: items, brief: readText(r.data.brief), notes: r.data.notes ? readText(r.data.notes) : null, work, cpu, ctx: ctxOf(r.id),
        mails: mails.filter(m => m.data?.to === `lane:${r.data.lane}`), guard: gc.get(r.id) || [] }));
    }
    return out;
  }
  // RM-39 item 5: the lane overview card's data (one shape on Lanes and on the Runs page's Lane cell): why it exists, its type and
  // output (RM-34), the current stage and its run's progress, pace, why slow and alarms, the last finished stage and what comes next
  const cardOf = (l, pg) => ({ lane: l.name, objective: l.driver?.objective ?? null, source: l.driver?.sources?.[0] ?? null, finding: l.driver?.finding ?? null,
    type: l.lane_type?.type ?? null, output: l.output?.text ?? null, stage: pg ? [l.stage ?? null, pg.run].filter(Boolean).join(' · ') : null, progress: pg ?? null, ...l.steps });
  async function withCards(p, rows) {
    const items = st(p).items, pg = await progressOf(p, rows.map(l => l.run).filter(Boolean));
    return rows.map(l => { const g = pg.get(l.run), steps = laneSteps(l.name, items);
      return { ...l, ...(g ? { progress: g } : {}), card: cardOf({ ...l, stage: items[l.run]?.data?.stage, steps }, g) }; });
  }
  function lanesWithSpend(ps) {
    const rows = sortLanes(ps.flatMap(p => withDriver(p, lanes(p, true))));   // RM-19 S1: every row, one order across projects; the page filters
    if (!apiOn(ps)) return rows;
    const by = new Map(ps.flatMap(p => spendOf(p).lanes.map(g => [`${p.name}|${g.lane}`, g])));
    return rows.map(l => { const g = by.get(`${l.project}|${l.name}`); return { ...l, usd: g ? { total: g.total, live: g.live, runs: g.runs } : { total: 0, live: 0, runs: 0 } }; });
  }
  async function agents(p, win, { homes = false } = {}) {   // homes: + the other homes' runs (the Runs page; the map keeps its own)
    const s = settingsState(p), m = withDefaults(s.view);
    const talk = (await sessions.list()).filter(r => !r.project || r.project === p.name);
    const gc = guardChips(p.state);   // META-GUARD R1: the open / ruled usage alarms of a run = chips on its node
    const runs = runsOf(st(p)), byId = new Map(runs.map(r => [r.id, r]));
    // META-CHECKIN-GUARDS R1: the moves a guard refused this run (its run `refuse` events) - a plain row each on the tab
    const refused = id => (byId.get(id)?.history || []).filter(h => h.ev === 'refuse').map(h => ({ ts: h.ts, guard: h.data.guard, words: GUARD_WORDS[h.data.guard] ?? h.data.guard, why: h.data.why, lane: h.data.lane ?? null, stage: h.data.stage ?? null, answers: h.data.answers ?? null }));
    await primeAgents(runs, { projectsDir, codexDir, cache, window: win });   // META-DASH-ASYNC R1: the tree's files on fs.promises first
    const tree = agentsTree(runs, { projectsDir, codexDir, cache, window: win, policy: m.policy, sessions: talk, wrote: wroteHandoff(p) });
    // RM-39: a worker run's progress line + the lane overview card on its Lane cell (the lane's row data, this run's progress)
    const pg = await progressOf(p, tree.map(n => n.id), id => tree.find(n => n.id === id)?.ctx ?? null), names = new Set(tree.map(n => n.lane).filter(Boolean));
    if (names.size) await primeBriefs([p]);   // the lane card's driver reads the lanes' briefs: on fs.promises first
    const items = st(p).items, rows = new Map(names.size ? withDriver(p, lanes(p, true).filter(l => names.has(l.name))).map(l => [l.name, l]) : []);
    // RM-46 S3: the other homes' runs from their read-only copies - running, queued, or ended inside the window; no feed, no actions
    const now = Date.now(), away = (homes ? await copyItemsAsync(p.state, 'run') : []).filter(r => r.state === 'running' || r.state === 'queued' || !win || now - Date.parse(r.updated) <= win)
      .map(r => ({ id: r.id, name: r.data.name ?? null, kind: r.data.kind ?? 'worker', role: r.data.role ?? null, executor: r.data.executor ?? null, model: r.data.model ?? null, effort: r.data.effort ?? null,
        lane: r.data.lane ?? null, stage: r.data.stage ?? null, state: r.state, outcome: r.state === 'exited' ? r.history.findLast(h => h.ev === 'end')?.data?.outcome ?? null : null,
        started: r.created, ended: r.state === 'running' || r.state === 'queued' ? null : r.updated, project: p.name, home: r.home, readonly: true, children: [] }));
    // worker-speed: a worker run's tok/s and wall split (a live one: its last 10 min) - the same transcript tail, its own cache key
    const sp = new Map(await Promise.all(tree.filter(n => isWorker(byId.get(n.id))).map(async n => [n.id, await runSpeedA(byId.get(n.id), { projectsDir, cache, now })])));
    const speedOf = id => { const s = sp.get(id), w = s?.last10 ?? s; return s?.requests ? { line: speedWords(w), rolling: !!s.last10, tok_s: w.tok_s, pct: w.pct } : null; };
    return [...tree.map(n => { const rf = refused(n.id), g = pg.get(n.id), pz = pauseState(byId.get(n.id)), l = n.lane && n.kind !== 'checkin' ? rows.get(n.lane) : null, v = speedOf(n.id);
      return { ...n, project: p.name, ...(gc.has(n.id) ? { guard: gc.get(n.id) } : {}), ...(rf.length ? { refused: rf } : {}), ...(g ? { progress: g } : {}), ...(pz ? { pause: pz } : {}), ...(v ? { speed: v } : {}),
        ...(l ? { lane_card: cardOf({ ...l, stage: n.stage, steps: laneSteps(l.name, items) }, g) } : {}) }; }), ...away];
  }
  // the Ledger tab (LEDGER-UX R1): `count` lines (default 100, max 2000) ending `offset` lines before the end ("show older" pages);
  // runs = the run ids the Runs page lists, so the tab links only those
  async function ledgerPage(p, url) {
    const n = url.searchParams.get('count'), o = url.searchParams.get('offset');
    const count = Math.min(2000, Math.max(1, Number.parseInt(n ?? '', 10) || 100)), offset = Math.max(0, Number.parseInt(o ?? '', 10) || 0);
    const all = p.ledger ? await tail(p.ledger, Infinity) : [], end = Math.max(0, all.length - offset), start = Math.max(0, end - count);
    const [s, sync] = await Promise.all([stAsync(p), syncBlocks(p)]);
    return { file: p.ledger ?? null, ledger: all.slice(start, end), total: all.length, count, offset, more: start > 0, runs: [...shownRunIds(runsOf(s))], ...sync };
  }
  // RM-46 S3 (SPEC sec. 8 S3): a synced project's Ledger page carries the Homes block (each other home's fetched head, the last fetch, lag,
  // clock offset) and the Claims block (work claims with the stale flag on this home's clock, the merge leader). Async git on the local
  // ledger repo only: the fetch is the sync loop's (S4), never the page's. {} when the project is not synced.
  const gitA = (dir, args, input) => new Promise(res => { const c = execFile('git', args, { env: { ...process.env, GIT_DIR: dir }, encoding: 'buffer', windowsHide: true, maxBuffer: 32 << 20 }, (e, out) => res(e ? null : out)); if (input !== undefined) c.stdin.end(input); });
  // cat-file --batch output -> [body string | null] in the order asked ("<sha> <type> <size>\n<body>\n" or "<name> missing\n")
  function batchBodies(buf) {
    const out = []; let i = 0;
    while (i < buf.length) { const nl = buf.indexOf(10, i), head = buf.subarray(i, nl).toString('utf8').split(' ');
      if (head[1] === 'missing' || head.length < 3) { out.push(null); i = nl + 1; continue; }
      const n = Number(head[2]); out.push(buf.subarray(nl + 1, nl + 1 + n).toString('utf8')); i = nl + 2 + n; }
    return out;
  }
  async function syncBlocks(p) {
    let home; try { home = JSON.parse(await readA(path.join(p.state, 'home.json'), 'null'))?.id; } catch { home = null; }
    const cfg = home ? ledgerConfig(machine, { metaRoot: metaRootDir ?? path.resolve(p.state, '..', '..') }) : null;
    if (!cfg) return {};
    const L = cfg.dir, now = Date.now(), s = await stAsync(p), newest = s.newest || {};
    let ft = {}; try { ft = JSON.parse(await readA(path.join(L, 'sync-fetch.json'), '{}')) || {}; } catch { /* a torn file: no fetch shown */ }
    const refs = String(await gitA(L, ['for-each-ref', '--format=%(refname:lstrip=3) %(objectname)', 'refs/sync/home/']) || '').split('\n').filter(Boolean).map(l => l.split(' '));
    const rows = await Promise.all(refs.filter(([h]) => h !== home).map(async ([h, head]) => {
      const m = (await fs.promises.stat(path.join(p.state, 'homes', h, 'records.jsonl')).catch(() => null))?.mtimeMs, ts = newest[h];
      return { home: h, head, lag_s: ts ? Math.max(0, Math.round((now - ts) / 1000)) : null, ahead_s: ts && m ? Math.max(0, Math.round((ts - m) / 1000)) : null };
    }));
    // the claims at the fetched tip: one ls-tree, one cat-file --batch; seen = this home's observer clock (S2b)
    const ls = String(await gitA(L, ['ls-tree', '-r', '-z', 'refs/sync/claims^{commit}']) || '').split('\0').filter(Boolean).map(l => { const [m, key] = l.split('\t'); return { sha: m.split(' ')[2], key }; })
      .filter(e => e.key.startsWith(`work/${p.name}/`) || e.key === leaderKey(p.name));
    const bodies = ls.length ? batchBodies(await gitA(L, ['cat-file', '--batch'], ls.map(e => e.sha).join('\n') + '\n') || Buffer.alloc(0)) : [];
    let seen = {}; try { seen = JSON.parse(await readA(path.join(p.state, 'sync', 'claims-seen.json'), '{}')) || {}; } catch { /* a torn file: nothing seen yet */ }
    const pol = syncPolicy(p.policy), work = [];
    let leader = null;
    ls.forEach((e, i) => { let c; try { c = JSON.parse(bodies[i]); } catch { return; }
      if (e.key === leaderKey(p.name)) { leader = c; return; }
      if (c?.kind === 'work') work.push({ key: e.key, home: c.home, lane: c.lane, n: c.n, run: c.run ?? null, items: c.items || [], renewed_at: c.renewed_at, stale: c.home !== home && isStale(seen[e.key], c, now, pol) }); });
    return { homes: { home, fetched_at: ft.fetched_at ?? null, fetch_error: ft.fetch_error ?? null, rows }, claims: { work, leader } };
  }
  // the lane -> agent map (LANE-MAP-DESIGN 1): built from the fold + the agents tree the Runs page already reads
  async function map(p, url) {
    const more = new Set((url.searchParams.get('more') || '').split(',').map(x => x.trim()).filter(Boolean));
    return { project: p.name, ...mapGraph(st(p), { all: url.searchParams.get('all') === '1', more, tree: await agents(p), deliverables: deliverablesOf(p).rows, home: homeIdOf(p.state)?.id }) };
  }
  // DELIVERABLES-SPEC 3: `norn deliverables --json --all` in a child process (git never blocks a poll), per project, served from a
  // cache for o.deliverablesTtlMs (60 s; then stale while it refreshes). The child keeps its own git cache in the state dir.
  // Never waits on git: before the first answer it returns { rows: [], pending: true } (the stream's derived event re-renders).
  const dlv = new Map();
  function deliverablesOf(p) {
    let c = dlv.get(p.name);
    if (!c) { c = { at: 0, val: null, busy: null }; dlv.set(p.name, c); }
    if (!c.busy && Date.now() - c.at > (o.deliverablesTtlMs ?? 60000)) {
      c.busy = (p.file ? run(process.execPath, [META_CLI, 'deliverables', '--json', '--all', '--project', p.file, '--state', p.state], { timeout: 120000 }).then(s => JSON.parse(s)) : Promise.resolve({ rows: [] }))
        .catch(e => ({ rows: [], error: 'deliverables: ' + String(e.message).slice(0, 300) }))
        .then(v => { c.val = { ...v, rows: (v.rows || []).map(r => ({ ...r, project: p.name })) }; c.sig = hash(JSON.stringify([c.val.rows, c.val.error ?? null])); c.at = Date.now(); c.busy = null; return c.val; });
    }
    return c.val ? { ...c.val, pending: false } : { rows: [], pending: true };
  }
  // MERGE-FIRST (4): the merge backlog of the projects shown, from the cached deliverables (pending until the first answer); over = any
  // project past its own policy.merge.backlog_max
  function backlogOf(ps) {
    const parts = ps.map(p => ({ p, d: deliverablesOf(p) }));
    const all = mergeBacklog(parts.flatMap(x => x.d.rows), { max: Math.min(...ps.map(p => backlogMax(p.policy))) });
    return { ...all, over: parts.some(x => mergeBacklog(x.d.rows, { max: backlogMax(x.p.policy) }).over), pending: parts.some(x => x.d.pending) };
  }
  // META-PLAN R1: the plan = `norn plan --json` in a child process (the fill walk samples the CPU for 1 s and asks git: never on a
  // poll), per project, cached o.planTtlMs (30 s; then stale while it refreshes); before the first answer { pending: true }. R2: with
  // the dashboard's own budget file, so the Plan's weekly stop is the one every other tab shows (one source)
  const plans = new Map();
  function planOf(p) {
    let c = plans.get(p.name);
    if (!c) { c = { at: 0, val: null, busy: null }; plans.set(p.name, c); }
    if (!c.busy && Date.now() - c.at > (o.planTtlMs ?? 30000)) {
      c.busy = run(process.execPath, [META_CLI, 'plan', '--json', ...(p.file ? ['--project', p.file] : []), '--state', p.state, ...(o.budgetFile ? ['--budget', o.budgetFile] : [])], { timeout: 120000 }).then(s => JSON.parse(s))
        .catch(e => ({ error: String(e.message).slice(0, 300) }))
        .then(v => { c.val = { ...v, project: p.name }; c.at = Date.now(); c.busy = null; c.hash = hash(JSON.stringify({ ...v, now: null })); return c.val; });
    }
    return c.val ? { ...c.val, pending: false } : { project: p.name, pending: true };
  }
  // META-ROADMAP S2 (SPEC sec. 3 "Live"): the roadmap tree = `norn road show --json` in a child process (its derive asks git; git
  // never blocks a poll), cached on the records files' mtime + size. A changed roadmap file (an item append) = a new build that the
  // request AWAITS, so the fetch a `rec` event triggers already shows the append. A change to the other record files only (runs,
  // records: they churn while workers run) serves the last tree at once and rebuilds behind it (dash-latency: the child takes 3 s
  // idle, 4-13 s with workers running, and every Roadmap render waited on it). Git-derived facts refresh after o.roadmapTtlMs (60 s,
  // served stale while the child runs); a changed tree reaches the page as the stream's `derived` event (its hash is in the stream sig).
  const rm = new Map();
  const rmSig = p => RECORD_FILES.map(f => { const s = statS(path.join(p.state, f + '.jsonl')); return s ? s.mtimeMs + ':' + s.size : '-'; }).join('|');
  const rmOwn = sig => sig.split('|')[RECORD_FILES.indexOf('roadmap')];   // the item records' own file in a sig
  function roadmapOf(p, { kick = false } = {}) {
    let c = rm.get(p.name);
    if (!c) { if (kick) return null; c = { sig: null, at: 0, val: null, busy: null, want: null }; rm.set(p.name, c); }
    const sig = rmSig(p);
    const build = () => {
      const s = sig;
      c.want = s;
      c.busy = (c.busy || Promise.resolve()).then(() => run(process.execPath, [META_CLI, 'road', 'show', '--json', ...(p.file ? ['--project', p.file] : []), '--state', p.state], { timeout: 120000 }))
        .then(out => JSON.parse(out), e => ({ project: p.name, themes: [], unplaced: [], counts: { items: 0, past: 0, present: 0, future: 0, live: 0, drift: 0, claimed: 0, idle: 0, gone: 0, unplaced: 0 }, error: 'roadmap: ' + String(e.message).slice(0, 300) }))
        .then(v => { c.val = { ...v, project: p.name }; c.sig = s; c.at = Date.now(); c.hash = hash(JSON.stringify({ ...v, generated: null })); if (c.want === s) c.busy = null; return c.val; });
      return c.busy;
    };
    if (c.val && c.sig === sig) { if (!c.busy && Date.now() - c.at > (o.roadmapTtlMs ?? o.deliverablesTtlMs ?? 60000)) build(); return c.val; }
    if (c.val && rmOwn(c.sig) === rmOwn(sig)) { if (!c.busy) build(); return c.val; }   // no item append: the last tree now, one rebuild behind it
    if (c.busy && c.want === sig) return c.busy;
    return kick ? (build(), null) : build();
  }
  function usage(p, m) {
    const parsed = parseStatus(read(path.join(p.state, 'STATUS.md')));
    let live = null; try { live = o.liveUsage ? JSON.parse(read(o.liveUsage, 'null')) : null; } catch { live = null; }
    const at = Date.parse(live?.at_utc ?? ''), ageMinutes = Number.isFinite(at) ? Math.max(0, (Date.now() - at) / 60000) : null;
    const fresh = !!live && typeof live.seven_day_pct === 'number' && ageMinutes !== null && ageMinutes < 30;
    const stop = m.weekly_stop_pct ?? null, used = fresh ? live.seven_day_pct : parsed.weekly;
    // billing modes (lib/billing.mjs): the mode in words; API billing = the last 24 h of spend vs the daily $ cap, no weekly guard
    const bm = billingOf(m), b = bm ? { name: bm.name, label: bm.label, type: bm.type } : null;
    if (bm?.type === 'api') {
      // gap #9: ended runs + running runs (live estimate) + the dashboard chats; live = the running runs' $ by run id (Running table)
      const s = spendDay(path.dirname(p.state), Date.now(), { projectsDir }), cap = usdCap(m);
      return { ...parsed, source: 'api', billing: { ...b, usd: s.usd, runs: s.runs, ended_usd: s.ended_usd, live_usd: s.live_usd, live_runs: s.live_runs, chat_usd: s.chat_usd, chat_turns: s.chat_turns, live: s.live, cap }, weeklyStopPct: null, weeklyUsed: null, resetAt: null, guard: cap !== null && s.usd >= cap ? 'STOP' : 'ok' };
    }
    return { ...parsed, source: fresh ? 'live' : 'estimate', billing: b, estimate: { weekly: parsed.weekly, rate: parsed.rate, cap: parsed.cap },
      weeklyStopPct: stop, weeklyUsed: used ?? null, resetAt: nextReset(parseReset(m.reset)),
      guard: stop === null || used === null || used === undefined ? 'unknown' : used >= stop ? 'STOP' : 'ok' };
  }
  // per-executor usage of claude-compatible providers (own accounts, never in BURN): runs ended in the last 7 days
  function providerUsage(ps) {
    const cut = Date.now() - 7 * 86400000, by = {};
    for (const p of ps) for (const r of runsOf(st(p)).filter(r => r.data.kind === 'provider' && Date.parse(r.updated) >= cut)) {
      const u = r.end?.usage || {}, x = by[r.data.executor] ??= { name: r.data.executor, runs: 0, tokens: 0, cost_usd: 0 };
      x.runs++; x.tokens += ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((a, k) => a + (Number(u[k]) || 0), 0);
      x.cost_usd += Number(r.end?.cost_usd) || 0;
    }
    return Object.values(by);
  }
  // RM-18 S2: the Overview strip, one count set per Norn. Urd = what landed (a MERGE run that ended done, or a run ruled landed: norn
  // runs landed), Verdandi = what runs and what is parked, Skuld = open questions, queued runs, the next check-in (the last check-in's
  // start + the cadence; null = not known)
  function stripOf(ps, running, m) {
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const evTs = (i, ev) => [...i.history].reverse().find(h => h.ev === ev)?.ts ?? null;
    const landed = [], n = { parked: 0, questions: 0, queued: 0 };
    let ck = null;
    for (const p of ps) for (const i of Object.values(st(p).items)) {
      if (i.kind === 'question' && i.state === 'open') n.questions++;
      else if (i.kind === 'lane' && i.state === 'parked') n.parked++;
      else if (i.kind === 'run') {
        if (i.data.kind === 'checkin') { const t = evTs(i, 'start'); if (t && (!ck || t > ck)) ck = t; continue; }
        if (i.state === 'queued' && i.data.role !== 'helper') n.queued++;
        const ts = i.landed ? evTs(i, 'landed') : String(i.data.stage ?? '').toUpperCase() === 'MERGE' && i.end?.outcome === 'done' ? evTs(i, 'end') : null;
        if (ts) landed.push({ run: i.id, lane: i.data.lane ?? null, project: p.name, ts });
      }
    }
    landed.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const every = m.policy?.cadence?.checkin_interval_min ?? null;
    return { landed_today: landed.filter(l => Date.parse(l.ts) >= day.getTime()).length, last_landed: landed[0] ?? null, running: running.length, ...n,
      checkin: { every_min: every, next: Number.isFinite(every) && ck ? new Date(Date.parse(ck) + every * 60000).toISOString() : null } };
  }
  async function overview(ps) {
    const m = withDefaults(settingsState(ps[0]).view);
    let needs = [], running = [], tree = [];
    for (const p of ps) { needs.push(...(await inbox(p)).filter(isNeed)); running.push(...lanes(p, false).filter(l => l.run_state === 'running' && l.text.startsWith('running'))); tree.push(...await agents(p)); }
    const live = tree.filter(n => n.state === 'running');
    const isCodex = n => String(n.executor).startsWith('codex'), isClaude = n => n.kind === 'worker' || n.kind === 'fake';
    const codex = live.filter(isCodex).length, claude = live.filter(isClaude).length;
    // the Running table lists exactly the runs its header counts (VISUAL-B S1 bug 1): a counted run whose lane has no LANE record
    // (or whose lane row is not "running") gets a row from its agents-tree node; a LANE row keeps its fields
    const laneRow = new Map(running.map(l => [`${l.project}|${l.run}`, l]));
    running = live.filter(n => isCodex(n) || isClaude(n)).map(n => laneRow.get(`${n.project}|${n.id}`)
      ?? { name: n.lane ?? n.id, id: null, state: null, data: {}, run: n.id, run_name: n.name ?? null, executor: n.executor ?? null, run_state: 'running', text: 'running', project: n.project });
    const perPct = m.cacheR_per_pct || null;
    const burners = tree.flatMap(n => [n, ...(n.children || [])]).filter(n => n.burn30 > 0)
      .map(n => ({ id: n.id, project: n.project, lane: n.lane ?? null, burn30: n.burn30, pct_per_h: perPct ? Math.round((n.burn30 * 2 / perPct) * 100) / 100 : null }))
      .sort((a, b) => b.burn30 - a.burn30).slice(0, 5);
    return { now: iso(), projects: ps.map(p => p.name), needs_you: needsYou(needs), needs,
      running: { claude: { n: claude, cap: m.max_claude_workers ?? null }, codex: { n: codex, cap: m.max_codex ?? null }, lanes: running },
      burn: { usage: usage(ps[0], m), top: burners, executors: providerUsage(ps) },
      strip: stripOf(ps, running, m), ...pauseView(ps), checkin_locked: ps.some(p => lockFresh(p)),
      // META-OOTB F-1: a project with no records yet gets the first-task box (+ the caps in force; null = unset = no limit)
      first_run: ps.length === 1 && !Object.keys(st(ps[0]).items).length ? { project: ps[0].name, lane: FIRST_LANE,
        caps: Object.fromEntries(['max_claude_workers', 'max_codex', 'weekly_stop_pct', 'usage_rate_cap_pct_per_h'].map(k => [k, m[k] ?? null])) } : null,
      backlog: backlogOf(ps),   // MERGE-FIRST (4)
      setup: ps.length === 1 ? setupOf(ps[0]) : null };   // META-ADOPT A3: the setup gaps (rules, caps nobody chose, no merge gate)
  }
  function records(p, url) {
    const kinds = ['decision', 'directive'], k = url.searchParams.get('kind'), s = url.searchParams.get('state');
    const S = st(p), items = Object.values(S.items).filter(i => kinds.includes(i.kind) && (!k || i.kind === k) && (!s || i.state === s))
      .map(i => ({ id: i.id, kind: i.kind, state: i.state, by: i.by, created: i.created, updated: i.updated, data: i.data, history: i.history, ...foreign(p, S, i.id) }));
    return { project: p.name, decisions: items.filter(i => i.kind === 'decision'), directives: items.filter(i => i.kind === 'directive') };
  }
  // cost per lane (META-OPS-R1 #7): the roll-up of engine/lib/cost.mjs, cached one UI tick; ended runs memoized (never re-read),
  // running transcripts / rollouts tailed from their last byte offset; the fold is the cached one (re-read on a records change)
  const costTail = new Map(), costMemo = new Map(), costViews = new Map(), weekMemo = new Map(), USAGE_TICK_MS = 15000;
  // account usage (META-OPS-R3): the Claude transcripts root scanned by a background worker (account-refresh.mjs) into a
  // state-dir cache file and hands back its window entries; a view only sums those (never scans or parses the cache inline) and
  // starts a refresh when they are older than ACCOUNT_REFRESH_MS. The first scan reads the whole root (minutes); later ones
  // only the changed files' appended bytes. Until the first refresh of this dash process lands: account n/a (refreshing).
  const accountCacheFile = o.accountCacheFile ?? (firstP() ? path.join(firstP().state, 'account-usage.json') : path.join(metaRootDir, 'local', 'account-usage.json')), ACCOUNT_REFRESH_MS = o.accountRefreshMs ?? 60000;
  const acct = { running: null, last: null, started: null, data: null, worker: null };
  function accountRefresh() {
    if (acct.running) return acct.running;
    acct.started = new Date().toISOString();
    acct.running = new Promise(resolve => {
      let w;
      const fin = v => { const { entries, ...rest } = v; if (v.ok && entries) { acct.data = { entries, at: v.at }; acct.sig = hash(JSON.stringify(entries)); }
        acct.last = { ...rest, started: acct.started, ended: new Date().toISOString() }; acct.running = null; resolve(acct.last); };
      try { w = new Worker(new URL('../lib/account-refresh.mjs', import.meta.url), { workerData: { projectsDir, cacheFile: accountCacheFile, entries: true } }); }
      catch (e) { return fin({ ok: false, error: String(e?.message || e) }); }
      w.unref(); acct.worker = w;
      w.once('message', fin); w.once('error', e => fin({ ok: false, error: String(e?.message || e) }));
      w.once('exit', c => { if (acct.worker === w) acct.worker = null; if (acct.running) fin({ ok: false, error: 'worker exit ' + c }); });
    });
    return acct.running;
  }
  function accountKick() {
    const age = acct.data ? Date.now() - Date.parse(acct.data.at) : Infinity;
    if (!acct.running && age > ACCOUNT_REFRESH_MS && o.accountRefresh !== false) accountRefresh();
  }
  const dlvFacts = p => (deliverablesOf(p).rows || []).map(r => ({ id: r.id, runs: [r.run, ...(r.runs || [])].filter(Boolean), merged_at: ['merged', 'installed'].includes(r.state) ? 'merged' : null }));
  function classesFor(p, now, since) {
    const pol = withDefaults(merged({}, p.policy)).policy;
    return classCost([{ project: p.name, items: runsOf(stCached(p)), dlvs: dlvFacts(p), policy: { executors: pol.executors, critical_lanes: pol.critical_lanes } }],
      { now, since: since ?? now - 7 * 86400000, projectsDir, codexDir, cache: costTail, memo: costMemo });
  }
  // META-TEND P4: the open advice of a project = advise() over its class table and its effective settings; a decided card (a decision
  // with data.advice = its key) is hidden. Cached per project for the Inbox (ADVICE_TTL_MS); the last count goes to <state>/advice.json
  // for the digest line. Never writes a policy: POST /api/advice does, on a tap.
  const adviceMemo = new Map(), ADVICE_TTL_MS = o.adviceTtlMs ?? 300000;
  function adviceFor(p, classes, now = Date.now()) {
    const a = advise(classes, withDefaults(settingsState(p).view), { project: p.name, now, data: adviceData ?? undefined, decided: decidedKeys(Object.values(st(p).items)) });
    writeAdviceCache(p.state, a);
    adviceMemo.set(p.name, { at: Date.now(), a });
    return a;
  }
  async function adviceOf(p, fresh = false) {
    const hit = adviceMemo.get(p.name);
    if (!fresh && hit && Date.now() - hit.at < ADVICE_TTL_MS) return hit.a;
    await Promise.all([stAsync(p), readA(p.file), o.budgetFile ? readA(o.budgetFile, '{}') : null]);
    adviceData ??= await loadAdviceDataAsync();
    const now = Date.now(), resetMs = Date.parse(parseReset(withDefaults(settingsState(p).view).reset) ?? '');
    return adviceFor(p, classesFor(p, now, Number.isFinite(resetMs) ? weekStart(resetMs, now) : null), now);
  }
  let adviceData = null;   // the shipped advice table (presets/advice/models.json): read once, on fs.promises
  function usageView(ps, url) {
    const days = Math.min(30, Math.max(1, Math.round(Number(url.searchParams.get('days')) || 7)));
    const key = ps.map(p => p.name).join(',') + '|' + days, hit = costViews.get(key);
    if (hit && Date.now() - hit.at < USAGE_TICK_MS) return { ...hit.v, cached: true };
    // the headline window is the current weekly window: the budget's one reset key (local/budget.json reset) -> now (META-OPS-R2)
    const t0 = process.hrtime.bigint(), B = withDefaults(settingsState(ps[0]).view), perPct = B.cacheR_per_pct ?? null, resetAt = parseReset(B.reset);
    const now = Date.now(), resetMs = Date.parse(resetAt ?? ''), since = Number.isFinite(resetMs) ? weekStart(resetMs, now) : null;
    const account = since === null || !acct.data ? null : accountUsage('claude', { ...acct.data, since, now });   // provider of the runs headline: Claude
    accountKick();
    const parts = ps.map(p => costRollup(runsOf(stCached(p)), { project: p.name, now, days, resetAt, cacheRPerPct: perPct, projectsDir, codexDir, cache: costTail, memo: costMemo, account }));
    // META-GUARD R1 item 2: where the week's tokens went (outcomes, merged = the cached deliverables rows, top 5 spenders)
    ps.forEach((p, i) => { try {
      const dl = dlvFacts(p);
      parts[i].week = usageWeek([{ project: p.name, items: runsOf(stCached(p)), dlvs: dl }], { now, week: !!resetAt, resetAt, cacheRPerPct: perPct, projectsDir, codexDir, cache: costTail, memo: costMemo, smemo: weekMemo });
    } catch (e) { parts[i].week = { error: String(e.message).slice(0, 200) }; } });
    // META-TEND P2: what each kind of work costs - per completed stage by class x executor x model x effort, same window; the Fable count
    ps.forEach((p, i) => { try { parts[i].classes = classesFor(p, now, since); } catch (e) { parts[i].classes = { error: String(e.message).slice(0, 200) }; } });
    // META-TEND P4: the advice cards over that table (the Inbox shows the same cards) + the replay test report, when one was written
    ps.forEach((p, i) => {
      try { parts[i].advice = parts[i].classes.error ? { error: parts[i].classes.error } : adviceFor(p, parts[i].classes, now); } catch (e) { parts[i].advice = { error: String(e.message).slice(0, 200) }; }
      try { parts[i].replay = JSON.parse(fs.readFileSync(replayReportFile(p.state), 'utf8')); } catch { parts[i].replay = null; }
    });
    if (apiOn(ps)) ps.forEach((p, i) => { try { parts[i].spend = spendOf(p); } catch (e) { parts[i].spend = { error: String(e.message).slice(0, 200) }; } });   // gap #9
    const v = { parts, ms: Number(process.hrtime.bigint() - t0) / 1e6, account_refresh: { running: !!acct.running, started: acct.started, last: acct.last, cache: accountCacheFile } };
    costViews.set(key, { at: Date.now(), v });
    return { ...v, cached: false };
  }
  const docsList = p => (p.docs || []).map((d, i) => ({ i, tab: d.tab, path: d.path, exists: existsS(d.path) }));
  // META-UX-BUILD S1: Context and Slop read ONE instruction scan per project, never run in a request: the last view
  // is served at once (from memory, else <state>/instructions-view.json, so a restart is not cold) and, once older than o.insTtlMs
  // (60 s), rebuilt by a worker thread (lib/guard-scan.mjs, this server's own home + machine) - one rebuild at a time per project.
  // A new view, or the end of a rebuild a page was shown as "refreshing", reaches the page as the stream's derived event (in the sig).
  const ins = new Map(), insWorkers = new Set();   // the running rebuilds: close() ends them
  function insCache(p) {
    let c = ins.get(p.name);
    if (!c) {
      c = { at: 0, iso: null, v: null, paras: new Map(), hash: '-', busy: false, error: null, shown: false, ends: 0 }; ins.set(p.name, c);
      try { const b = JSON.parse(fs.readFileSync(insViewFile(p.state), 'utf8')); Object.assign(c, { v: b.v, paras: new Map(b.paras), iso: b.at, at: Date.parse(b.at), hash: b.hash }); } catch { /* no view kept yet: the first scan is cold */ }
    }
    if (!c.busy && Date.now() - c.at > (o.insTtlMs ?? 60000)) {
      c.busy = true;
      const fin = r => { if (!c.busy) return; c.busy = false; if (c.shown) { c.shown = false; c.ends++; }
        if (r.ok) Object.assign(c, { v: r.v, paras: new Map(r.paras), iso: r.at, at: Date.parse(r.at), hash: r.hash, error: null });
        else Object.assign(c, { at: Date.now(), error: 'instructions: ' + String(r.error).slice(0, 300) }); };
      let w;
      try { w = new Worker(new URL('../lib/guard-scan.mjs', import.meta.url), { workerData: { project: JSON.parse(JSON.stringify(p)), machine: machine.claude ? JSON.parse(JSON.stringify(machine)) : null, home } }); }
      catch (e) { fin({ ok: false, error: e?.message || e }); }
      if (w) { w.unref(); insWorkers.add(w); w.once('exit', () => insWorkers.delete(w)); w.once('message', fin); w.once('error', e => fin({ ok: false, error: e?.message || e })); w.once('exit', code => fin({ ok: false, error: 'worker exit ' + code })); }
    }
    return c;
  }
  const insSig = name => { const c = ins.get(name); return c ? `${c.hash}:${c.ends}${c.error ? '!' : ''}` : '-'; };
  // the first answer: the summary (no list, the lists' counts) + at / refreshing / pending; ?part= one capped list (insparts.mjs)
  function insOf(p, url) {
    const c = insCache(p), name = url.searchParams.get('part');
    if (name !== null) { if (!c.v) throw fail(503, 'The first instruction scan of this project is still running'); return insPart(c.v, name); }
    if (c.busy) c.shown = true;   // a page shows the chip: the rebuild's end is an event even when the view did not change
    if (!c.v) return { project: p.name, pending: !c.error, refreshing: c.busy, error: c.error };
    return { ...insSummary(c.v), at: c.iso, refreshing: c.busy, pending: false, error: c.error };
  }
  function insFile(p, id) {
    const c = insCache(p);
    if (!c.v) throw fail(503, 'The first instruction scan of this project is still running');
    const v = c.v, r = v.rows.find(x => x.id === id && x.exists);
    if (!r) throw fail(404, 'No such instruction file');
    const ev = v.evidence?.files?.[r.id] ?? null;   // META-TEND P5: read / cite marks per paragraph; the file's own findings (the list part is capped)
    return { ...r, text: read(r.path, null), paras: c.paras.get(r.id)?.map(x => ({ ...x, ...paraMarks(x, ev) })) || null, evidence: ev, read_days: v.evidence?.window_days ?? null,
      findings: (v.findings || []).filter(x => x.path === r.path || x.other === r.path) };
  }
  // META-UX-BUILD S3: Docs = the one reader. The list = the project's docs + every file of the ONE instruction scan (insCache: served at
  // once, never scanned in the request; pending before the first scan lands), grouped and capped (docparts.mjs). ?part=file&file=<key>:
  // one file - a scan row (its paragraphs with ages + its findings and rule advisories) or a project doc (its paragraphs, findings by
  // path). A project doc the scan also lists opens as that scan file.
  const fwdLow = s => String(s ?? '').replace(/\\/g, '/').toLowerCase();
  // RM-34: two more Docs keys (purpose.mjs writes them): brief:<file> = a file of the project's briefs_dir, doc:<path> = a file under the
  // project root (a roadmap item's doc: link). Anything that leaves those folders is no key (null: the plain lookup then 404s).
  function docKeyPath(p, key) {
    const b = String(key).match(/^brief:([^\\/]+)$/), d = String(key).match(/^doc:(.+)$/);
    const inside = (dir, f) => { const r = path.relative(dir, f); return !!r && !r.startsWith('..') && !path.isAbsolute(r) ? f : null; };
    return b ? inside(briefsDirOf(p), path.join(briefsDirOf(p), b[1])) : d && p.root ? inside(path.resolve(p.root), path.resolve(p.root, d[1])) : null;
  }
  function docsAt(p, url) {
    const c = insCache(p), name = url.searchParams.get('part'), lim = Number(url.searchParams.get('limit'));
    if (name === null) return { project: p.name, ...docsListOf({ v: c.v, docs: docsList(p), limit: Number.isInteger(lim) && lim > 0 ? lim : SUB_CAP }),
      pending: !c.v && !c.error, refreshing: c.busy, error: c.v ? null : c.error, sig: insSig(p.name) };
    if (name !== 'file') throw fail(400, `unknown part ${name} (file, or none for the list)`);
    return { doc: docFile(p, c, String(url.searchParams.get('file') ?? '')) };   // the page merges it as d.doc (d.file = its key)
  }
  // RM-36: a file a run touched (the feed's activity view) opens in the reader by its path - inside the roots GET /api/file allows
  // (the project root, its state, its runs' worktrees and NOTES folders); a source file is shown as one code block
  function pathDoc(p, key) {
    const raw = key.slice(5);
    if (!path.isAbsolute(raw) || /^[\\/]{2}/.test(raw)) throw fail(400, 'path must be an absolute local path');
    const real = insideRoots(showRoots(p.state, p), raw);
    if (!real) throw fail(403, 'Outside the allowed roots (the project root, its state, its runs\' worktrees and NOTES folders)');
    const text = read(real, null);
    if (text === null) throw fail(404, 'File not found');
    const md = /\.(?:md|markdown|txt)$/i.test(real);
    return { key, name: path.basename(real), path: real.split('\\').join('/'), text, lines: text.split(/\r?\n/).length, paras: null, findings: [], ...(md ? {} : { code: path.extname(real).slice(1).toLowerCase() || 'text' }) };
  }
  function docFile(p, c, key) {
    if (key.startsWith('path:')) return pathDoc(p, key);
    const kp = docKeyPath(p, key);   // RM-34: a lane's brief / its item's doc (the Lanes page's source links)
    if (kp) { const text = readText(kp), at = fwdLow(kp); if (text === null) throw fail(404, 'No such file');
      return { key, name: path.basename(kp), path: kp, text, lines: text.split(/\r?\n/).length, paras: paragraphs(text, null), findings: (c.v?.findings || []).filter(x => fwdLow(x.path) === at) }; }
    const m = key.match(/^doc-(\d+)$/), d = m ? docsList(p)[Number(m[1])] : null;
    if (m && !d?.exists) throw fail(404, 'No such doc');
    const row = (c.v?.rows || []).find(r => r.exists && (d ? fwdLow(r.path) === fwdLow(d.path) : r.id === key));
    if (row) {
      const f = insFile(p, row.id), seen = new Set(f.findings.map(x => x.id));
      const adv = (c.v.rules?.advisories || []).filter(a => fwdLow(a.path) === fwdLow(row.path) && !seen.has(a.id));
      return { ...f, key: row.id, findings: [...f.findings, ...adv] };
    }
    if (!d) { if (!c.v) throw fail(503, 'The first instruction scan of this project is still running'); throw fail(404, 'No such file'); }
    const text = read(d.path, null) ?? '', at = fwdLow(d.path);
    return { key, name: d.tab, path: d.path, text, lines: text.split(/\r?\n/).length, paras: paragraphs(text, null),
      findings: (c.v?.findings || []).filter(x => fwdLow(x.path) === at || fwdLow(x.other) === at) };
  }
  // META-TEND P6: the Guard overview = a query over the advisory records of every phase + SloppaChoppa's open BLOCK findings (it owns
  // no data; first_seen / new come from the one seen store, advisory.mjs crossings). A part that fails names itself and the rest shows.
  // The instructions part is the shared scan above (pending before its first answer).
  function insForGuard(p) {
    const c = insCache(p);
    return { v: c.v ?? (c.error ? { error: c.error } : null), pending: !c.v && !c.error };
  }
  async function guardOf(p) {
    await prime({ files: [...testsFiles(p.state), ...slopFiles(p.state), refusalsFile(p.state)] });   // META-DASH-ASYNC R1: the parts' files on fs.promises
    const errors = [], part = (name, f, dflt) => { try { return f(); } catch (e) { errors.push(`${name}: ${String(e.message).slice(0, 200)}`); return dflt; } };
    const ig = insForGuard(p), ins = ig.v?.error ? (errors.push(ig.v.error), null) : ig.v, tests = part('tests', () => testsView(p.state), null), advice = await adviceOf(p).catch(e => { errors.push(`models: ${String(e.message).slice(0, 200)}`); return null; });
    // META-BETA-PREP (DIR-52): the project's one SloppaChoppa switch (Settings) - off = no slop rows; his recorded holds stay on disk
    const pol = withDefaults(settingsState(p).view).policy, slop = pol.slop.enabled;
    const holds = !slop ? [] : part('code', () => Object.entries(slopHolds(p.state)).map(([branch, h]) => ({ branch, run: h.run, lane: h.lane, blocks: openBlocks(p.state, branch) })), []);
    // the first Guard scan of a project is its baseline (<state>/advisory/guard-baseline.json, one timestamp): what was open then is
    // not NEW to anyone, on that scan or later - only a crossing after it warns. It is written once the instruction scan has landed.
    const bf = path.join(p.state, 'advisory', 'guard-baseline.json');
    let at = null; try { at = Date.parse(JSON.parse(await readA(bf, 'null')).at); } catch { at = null; }
    const refused = !slop ? [] : part('scope', () => refusals(p.state, { since: Date.now() - REFUSAL_DAYS * 86400000 }), []);   // META-DOD 2
    // RM-27: a SloppaChoppa row carries its rule's what / why / fix and the waiver path (the same text norn slop check prints)
    const told = new Map(holds.flatMap(h => h.blocks.map(b => ['S-' + b.fp, { ...explainOf(b.rule, p.project_dir), waiver: waiverCmd(b) }])));
    const crossed = (await crossingsAsync(p.state, guardRows({ ins, tests, advice, holds, refusals: refused, docs: docsList(p) }))).map(r => (told.has(r.id) && told.get(r.id).what ? { ...r, explain: told.get(r.id) } : r));
    if (!Number.isFinite(at) && !ig.pending) { at = Date.now(); try { await fs.promises.mkdir(path.dirname(bf), { recursive: true }); await fs.promises.writeFile(bf, JSON.stringify({ at: new Date(at).toISOString() })); forget(bf); } catch { /* read-only state: no baseline */ } }
    const rows0 = crossed.map(r => (r.new && !(Number.isFinite(at) && Date.parse(r.first_seen) > at) ? { ...r, new: false } : r));   // no baseline yet (the scan is pending): nothing is new
    const rows = part('declines', () => markDeclines(rows0, st(p).items), rows0);   // a fixer's reasoned decline stands on its finding until the finding or its file changes
    const v = guardView(rows, { rules: ins?.rules?.counts ?? null, slop }), sent = fixSent(p, v.rows || []);
    return { project: p.name, ...v, rows: sent.rows, sent: sent.sent, fixcards: sent.cards ?? [], pending: ig.pending, slop, voice: pol.voice, errors };
  }
  // Fix all sent and not done yet: every ACTIVE directive a Send wrote (data.fixall) holds its findings. Those rows are marked sent
  // (sent: DEC-n) - Fix all no longer offers them, the page says they are with the fixer - until the directive is closed or the findings
  // are fixed. Without this a sent sheet came back whole once the tab was left (the sent state lived only in the page).
  function fixSent(p, rows) {
    const live = Object.values(st(p).items).filter(i => i.kind === 'directive' && i.state === 'active' && i.data?.fixall && Array.isArray(i.data.findings));
    if (!live.length) return { rows, sent: [], cards: [] };
    try { keepFindings(p.state, st(p).items, rows); } catch { /* read-only state: the fixer waits for the next draw */ }   // S7: the rows `norn fix start` briefs
    const items = st(p).items, batch = fixBatch(withDefaults(settingsState(p).view).policy), cards = fixCards(items, { batch, root: p.root });
    const by = new Map();
    for (const d of live) for (const id of d.data.findings) if (!by.has(id)) by.set(id, d.data.fixall);
    const out = rows.map(r => (by.has(r.id) ? { ...r, sent: by.get(r.id) } : r));
    // S7: where each directive's fixer is - queued / running (its run), a card to decide (ready / failed), the rest left, or starting
    const sent = live.map(d => {
      const pl = fixPlan(d, items, { batch, readBrief: readRunBrief }), c = cards.filter(x => x.directive === d.id), run = pl.live ? items[pl.live] : null;
      const at = run ? (run.state === 'queued' ? 'queued' : 'running') : c.some(x => x.state === 'ready') ? 'card' : c.some(x => x.state === 'failed') ? 'failed' : c.length ? 'declined' : pl.next ? 'starting' : pl.left.length ? 'rest' : 'done';
      return { id: d.data.fixall, directive: d.id, n: d.data.findings.length, open: out.filter(r => r.sent === d.data.fixall).length, at: d.created ?? null,
        fixer: { at, run: pl.live ?? c[0]?.run ?? null, left: pl.left.length, more: pl.more, approved: pl.approved, ran: pl.runs.length } };
    }).filter(x => x.open > 0 || ['card', 'failed', 'declined'].includes(x.fixer.at));
    return { rows: out, sent, cards };
  }
  // META-UX-BUILD S2: ?part=summary (no list) or one sub-view's part (&limit= rows, SUB_CAP by default); no part = the full view (chips)
  async function guardAt(p, url) {
    const g = await guardOf(p), name = url.searchParams.get('part'), lim = Number(url.searchParams.get('limit'));
    if (name === null) return chipView(g);   // S5: the header + chips: no hint / tighten rows, no patch text
    if (name === 'sheet') return { sheet: { ...fixSheet(g), usage: fixUsage(p) } };   // S6: the Fix all sheet
    return name === 'summary' ? guardSummary(g) : guardPart(g, name, Number.isInteger(lim) && lim > 0 ? lim : SUB_CAP, url.searchParams.get('batch'));
  }
  // TESTS-RUNTIME: the Tests tab = a summary (testsView + the open Inbox questions the test machinery raised: data.area 'tests') and the
  // chosen sub-view's part (?part=suite|costs|impact|trends&limit=). Impact takes &files=a,b or &lane=<name> (that lane's changed files:
  // its worktree against the merge base with the main branch, uncommitted work included); Costs adds the merge queue's batches.
  const gitCwd = (cwd, args) => new Promise((ok, no) => execFile('git', ['-C', cwd, ...args], { timeout: 10000, windowsHide: true, maxBuffer: 16 << 20 }, (e, out) => (e ? no(e) : ok(String(out).trim()))));
  async function laneFiles(p, lane) {
    const at = lanePaths(p, lane), wt = inDir(at.worktree, subdirOf(p)), main = p.ci?.branch || 'main';
    if (!(await existsA(at.worktree))) return { error: `lane ${lane} has no worktree (${fwdP(at.worktree)})` };
    try { const mb = await gitCwd(wt, ['merge-base', main, 'HEAD']); return { files: (await gitCwd(wt, ['diff', '--name-only', '--relative', mb])).split('\n').filter(Boolean).map(fwdP) }; }
    catch (e) { return { error: `git diff of lane ${lane} failed: ${String(e.message).split('\n')[0].slice(0, 200)}` }; }
  }
  async function mergeBatches(p) {
    const dir = path.join(p.state, 'mq'), names = (await fs.promises.readdir(dir).catch(() => [])).filter(f => /^batch-\d+\.json$/.test(f)).sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0])).slice(0, 12);
    const recs = await Promise.all(names.map(f => fs.promises.readFile(path.join(dir, f), 'utf8').then(JSON.parse, () => null)));
    return recs.filter(Boolean).map(b => ({ n: b.n, status: b.status, result: b.result ?? null, gate: b.gate ?? null, skipped: b.gate_skipped ?? null, built: b.built, done: b.done_at ?? null,
      members: (b.members || []).map(m => m.id ?? m.branch), runs: (b.runs || []).map(r => ({ label: r.label, ok: r.ok, ms: r.ms, timedOut: !!r.timedOut })), gate_ms: (b.runs || []).reduce((n, r) => n + (r.ms || 0), 0) }));
  }
  async function testsAt(p, url) {
    const name = url.searchParams.get('part'), lim = Number(url.searchParams.get('limit')), limit = Number.isInteger(lim) && lim > 0 ? lim : SUB_CAP;
    await prime({ files: testsFiles(p.state, name) });
    if (name === null) {
      const items = Object.values((await stAsync(p)).items);
      const alerts = items.filter(i => i.kind === 'question' && i.state === 'open' && i.data?.area === 'tests').map(q => ({ id: q.id, title: q.data.title, options: q.data.options ?? [], recommend: q.data.recommend ?? null, created: q.created }));
      return { project: p.name, ...testsView(p.state, await suiteOf(p)), alerts };
    }
    if (name === 'impact') {
      const lanes = Object.values((await stAsync(p)).items).filter(i => i.kind === 'lane' && i.state !== 'archived').map(i => i.id.slice(2)).sort();
      const lane = url.searchParams.get('lane'), files = (url.searchParams.get('files') || '').split(',').map(s => s.trim()).filter(Boolean);
      const lf = lane ? (lanes.includes(lane) ? await laneFiles(p, lane) : { error: `no lane ${lane} in ${p.name}` }) : null;
      return testsPart(p.state, 'impact', { picked: { lanes, lane, files: lf ? lf.files ?? [] : files, error: lf?.error ?? null } });
    }
    return testsPart(p.state, name, { limit, merges: name === 'costs' ? await mergeBatches(p) : [] });
  }
  // TESTS-RUNTIME: a test's file for the code viewer - read-only, only inside the project repo (testtimes.repoFile: no absolute path,
  // no .. or link out, nothing under .git), text only, at most 2 MB
  async function testSource(p, url) {
    if (!p.root) throw fail(404, 'This project has no repository folder');
    const rel = String(url.searchParams.get('file') ?? ''), real = repoFile(projectHome(p), rel);
    if (!real) throw fail(403, 'Only a file inside the project repository opens here');
    const st8 = await fs.promises.stat(real);
    if (st8.size > 2 * 1024 * 1024) throw fail(413, 'File larger than 2 MB');
    const text = await fs.promises.readFile(real, 'utf8');
    if (text.includes('\0')) throw fail(415, 'Not a text file');
    return { file: rel.split('\\').join('/'), text, lines: text.split(/\r?\n/).length };
  }
  // META-UX-BUILD S6 (REPORT s.3 step 2): the usage a Send approves - one run of the docs class as Settings routes it today, with the
  // measured median cache reads of that class's runs (classCost, the Usage tab's table; 7 days)
  function fixUsage(p) {
    const e = withDefaults(settingsState(p).view).policy.executors?.docs ?? {}, who = [e.executor, [e.model, e.effort].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const c = classesFor(p, Date.now()).byClass.filter(x => x.project === p.name && x.class === 'docs').sort((a, b) => b.measured - a.measured)[0];
    const med = c?.measured ? c.cache_read.median : null;
    const run = `(docs work: ${who || 'the docs class'})${med !== null ? ` · the median docs run is ~${(med / 1e6).toFixed(1)} M cache reads (${c.measured} runs, 7 days)` : ' · no measured docs run in 7 days'}`;
    const batch = fixBatch(withDefaults(settingsState(p).view).policy);   // S7: one run takes at most batch findings; the sheet counts the runs
    return { executor: e.executor ?? null, model: e.model ?? null, effort: e.effort ?? null, median_cache_read: med, runs: c?.measured ?? 0, run, batch, line: `One fixer run ${run}` };
  }
  const lockFreshA = p => fs.promises.stat(path.join(p.state, 'tick.lock')).then(s => Date.now() - s.mtimeMs < LOCK_STALE_MIN * 60000, () => false);
  function lockFresh(p) { const x = statS(path.join(p.state, 'tick.lock')); return !!x && Date.now() - x.mtimeMs < LOCK_STALE_MIN * 60000; }

  // ---------- live feed (LANE-MAP-DESIGN 2-3): SSE per run through the run's harness adapter feed() ----------
  const feeds = createFeeds({ pollMs: o.feedPollMs ?? 2000, lingerMs: o.feedLingerMs ?? 10000, max: o.feedMax ?? 4 });
  const commits = new Map();   // worktree -> git log -1 (read-only, cached 30 s, async: never blocks a poll)
  function lastCommit(wt) {
    if (!wt) return null;
    let c = commits.get(wt);
    if (!c) { c = { at: 0, val: null, busy: false }; commits.set(wt, c); }
    if (!c.busy && Date.now() - c.at > 30000) {
      c.busy = true;
      execFile('git', ['-C', wt, 'log', '-1', '--format=%h%x1f%s%x1f%cI'], { timeout: 5000, windowsHide: true }, (e, out) => {
        c.busy = false; c.at = Date.now();
        const [sha, subject, at] = e ? [] : String(out).trim().split('\x1f');
        c.val = sha ? { sha, subject: subject ?? '', at: at ?? null } : null;
      });
    }
    return c.val ? { ...c.val, age_min: Math.max(0, Math.round((Date.now() - Date.parse(c.val.at)) / 60000)) } : null;
  }
  // the run's own result (gap #3: `norn done`, <state>/results/RUN-n/result.json) - its outcome chip (DONE / STOPPED / HANDOFF) once
  // the worker wrote it; never a NOTES line (a lane's notes outlive its runs and are a log, not a control channel)
  async function resultMarker(state, run) {   // META-DASH-ASYNC R1: fs.promises (the head is built every feed poll)
    try {
      const j = JSON.parse(await fs.promises.readFile(resultPath(state, run), 'utf8'));
      return j?.run === run && ['done', 'stopped', 'handoff'].includes(j.outcome) ? j.outcome.toUpperCase() : null;
    } catch { return null; }
  }
  // META-DASH-ASYNC R1 (DEC-338): a feed poll runs on a timer, outside any request - each source call reads on fs.promises in a
  // snapshot of its own (the fold via stAsync; the settings files for the head's policy lines)
  function feedSource(p, id, adapter) {
    const env = { projectsDir, codexDir, memo: new Map() }, now = async () => (await stAsync(p)).items[id];
    const inSnap = fn => snap.run(newSnap(), fn);
    const policy = () => withDefaults(settingsState(p).view).policy;   // META-CTX-ENFORCE R1: the run role's lines, read live
    return {
      // META-DOD 2: + the run's scope refusals; RM-36: full = a drawer's first poll reads the whole run (the activity view: every file it touched)
      poll: (cur, full) => inSnap(async () => withRefusals(adapter.feed(await now(), cur, full ? { ...env, backlog: Infinity } : env), p.state, id, cur)),
      ended: () => inSnap(async () => (await now())?.state !== 'running'),
      head: ({ ctx, peak, window }) => inSnap(async () => {
        const [r] = await Promise.all([now(), readA(p.file), o.budgetFile ? readA(o.budgetFile, '{}') : null]);
        const d = r.data || {}, end = r.end || {}, t1 = r.state === 'running' ? Date.now() : Date.parse(r.updated), marker = await resultMarker(p.state, r.id);
        return { run: r.id, name: runName(r), project: p.name, lane: d.lane ?? null, kind: d.kind ?? null, role: d.role ?? null, executor: d.executor ?? null,
          model: end.model ?? d.model ?? null, effort: end.effort ?? d.effort ?? null, state: r.state, outcome: end.outcome ?? null, started: r.created,
          elapsed_min: Math.max(0, Math.round((t1 - Date.parse(r.created)) / 60000)), budget_min: d.budget_min ?? null, ctx, ctx_peak: peak ?? null,
          ...(d.kind === 'interactive' ? { ctx_limit: null, ctx_hard: null } : (({ ctx_limit, ctx_hard, ctx_role }) => ({ ctx_limit, ctx_hard, ctx_role }))(ctxView(d, policy()))), ctx_window: window ?? null, commit: lastCommit(d.worktree), marker, handoff: await hoOfA(p, r), worktree: d.worktree ?? null, ...(await briefPlanOf(d)) };
      }),
    };
  }
  // RM-36: the activity view's plan without a todo list - the brief's numbered items, and the ones the run's NOTES name as done
  async function briefPlanOf(d) {
    const [brief, notes] = await Promise.all([d.brief ? readA(d.brief) : '', d.notes ? readA(d.notes) : '']), items = briefItems(brief);
    return { brief_items: items, notes_done: items.length ? namedDone(items, notes, { doneWord: true }) : [] };
  }
  async function openFeed(req, res, url) {
    const p = one(url), id = url.searchParams.get('run') ?? '', r = stCached(p).items[id];
    if (!r || r.kind !== 'run') throw fail(404, 'No such run');
    const fam = harnessOf(r.data.executor, (p.executors || {})[r.data.executor]), adapter = fam ? ADAPTERS[fam] : null;
    if (!adapter?.feed) throw fail(404, `No live feed for executor ${r.data.executor}`);
    const from = decodeCursor(req.headers['last-event-id'] ?? url.searchParams.get('from') ?? '');
    if (!(await feeds.join(`${p.name}/${id}`, () => feedSource(p, id, adapter), res, from, { full: url.searchParams.get('full') === '1' }))) throw fail(429, `Too many live feeds: close one first (max ${o.feedMax ?? 4})`);
  }

  // ---------- state stream (META-VISUAL-B S1, the #4 push channel): record appends + flags, replaces the 15 s refetch ----------
  const streams = createStreams({ pollMs: o.streamPollMs ?? 1000, pulseMs: o.streamPulseMs ?? 15000, deriveMs: o.deliverablesTtlMs ?? 60000, lingerMs: o.streamLingerMs ?? 10000, max: o.streamMax ?? 16 });
  const RECORD_FILES = [...new Set(Object.values(KINDS).map(k => k.file || 'records'))];
  // META-DASH-ASYNC R1: the hub polls on its own timers, which inherit the opening request's snapshot (AsyncLocalStorage) - each call
  // runs in a fresh one (a stale snapshot would hide every flip); the kick primes its project first (its derivations then read memory)
  const fresh = fn => snap.run(newSnap(), fn);
  const streamSource = p => ({ project: p.name, hbDir: path.join(p.state, 'hb'),
    files: Object.fromEntries(RECORD_FILES.map(f => [f, path.join(p.state, f + '.jsonl')])),
    flags: () => fresh(async () => { const [a, b, quiet, tick_locked] = await Promise.all([...pausedFiles(p).map(existsA), existsA(quietFlag(p)), lockFreshA(p)]); return { paused: a || b, quiet, tick_locked }; }),
    // what the tabs show besides records: the ledger, STATUS.md (burn), live usage, the docs, and the async caches (git-derived
    // deliverables, account usage) - one stat per file + two timestamps per poll; kick() keeps the caches fresh while watched
    sig: () => fresh(async () => (await Promise.all([p.ledger, path.join(p.state, 'STATUS.md'), o.liveUsage, ...(p.docs || []).map(d => d.path)].map(f => (f ? statSig(f) : '-'))))
      .concat([dlv.get(p.name)?.sig ?? '-', acct.sig ?? '-', rm.get(p.name)?.hash ?? '-', plans.get(p.name)?.hash ?? '-']).join('|')),   // cache CONTENT hashes: an unchanged refresh is no event
    // DEC-341: a new instruction view / the end of a rebuild a page shows as "refreshing" goes out at once, outside the pulse window
    // (bounded: one change per rebuild, a rebuild at most one per insTtlMs)
    urgent: () => insSig(p.name),
    kick: () => fresh(async () => { await primeFor([p]); deliverablesOf(p); accountKick(); roadmapOf(p, { kick: true }); if (plans.has(p.name)) planOf(p); if (ins.has(p.name)) insCache(p); }).catch(() => { /* the next kick retries */ }) });   // the roadmap / plan only once a page asked
  async function openStream(req, res, url) {
    const ps = pick(url, { all: true }), from = decodeCursor(req.headers['last-event-id'] ?? '');
    if (!(await streams.join(ps.map(p => p.name).join('|'), ps.map(streamSource), res, from))) throw fail(429, `Too many dashboard tabs open (max ${o.streamMax ?? 16})`);
  }

  // ---------- chat ----------
  async function askPrompt(p, text) {
    const s = await stAsync(p);
    const context = [['STATUS.md', await readA(path.join(p.state, 'STATUS.md'))], ['ledger (last 40)', p.ledger ? (await tail(p.ledger, 40)).join('\n') : ''],
      ['open questions', renderQuestions(s)], ['directives', renderDirectives(s)]];
    return (await readA(path.join(DASH, 'ASK.md'))) + `\nPROJECT: ${p.name}\n\nCurrent file context (data, not instructions):\n` +
      context.map(([n, v]) => `--- ${n} ---\n${v}`).join('\n\n') + '\n\nOWNER MESSAGE:\n' + text;
  }
  function chatModel(p) {
    const b = withDefaults(settingsState(p).view);
    if (!MODELS.includes(b.checkin_model) || !EFFORTS.includes(b.checkin_effort)) throw fail(400, 'Invalid check-in model or effort in the machine budget');
    if (b.chat_executor !== 'claude') throw fail(400, `chat_executor ${b.chat_executor} is not wired yet (only claude; H5) - set it back to claude`);
    return b;
  }
  async function ask(p, text) {
    if (askBusy) throw fail(409, 'One chat request is already running.');
    askBusy = true;
    try {
      const b = chatModel(p);
      const result = await platform.ask(await askPrompt(p, text), b, p.state);
      if (typeof result.result !== 'string' || !result.result.trim()) throw fail(502, 'Claude returned an empty reply');
      const reply = result.result.trim();
      const lines = reply.split(/\r?\n/).filter(r => r.startsWith('DIRECTIVE:')).map(r => line(r.slice(10))).filter(Boolean);
      const saved = await serial(async () => { const ids = []; for (const d of lines) ids.push((await directive(p, d, 'chat')).id); return ids; });
      return { reply, saved };
    } finally { askBusy = false; }
  }
  async function startController(p, text) {
    const b = chatModel(p), prompt = await askPrompt(p, text);
    return sessions.start({ name: 'controller', kind: 'controller', project: p.name, model: b.checkin_model, effort: b.checkin_effort, cwd: p.state,
      prompt, args: ['--no-session-persistence', '--permission-mode', 'bypassPermissions', '--tools', '',
        '--strict-mcp-config', '--setting-sources', '', '--settings', '{"disableAllHooks":true}'] });
  }

  // ---------- META-CONTROLLER C1: the controller chat - one thread per project (engine/lib/chat.mjs); the process is started by the
  // first message and stopped when idle. C5: harness, model, effort, idle minutes, raw shell and the hand-off thresholds
  // (policy.context.controller) are the Settings rows, read LIVE by the chat (chatConfig) - a Settings save needs no dashboard restart.
  const chats = new Map(), chatStreams = new Set();
  function chatConfig(p) {
    const b = chatModel(p), model = b.chat_model || b.checkin_model, effort = b.chat_effort || b.checkin_effort;
    if (!MODELS.includes(model) || !EFFORTS.includes(effort)) throw fail(400, 'Invalid chat model or effort in the machine budget');
    return { executor: b.chat_executor, exe: o.claudeExe ?? machine.claude?.exe ?? 'claude', model, effort,
      idleMs: o.chatIdleMs ?? (Number.isInteger(b.chat_idle_min) && b.chat_idle_min > 0 ? b.chat_idle_min * 60000 : undefined),
      rawShell: ['off', 'ask', 'on'].includes(b.chat_raw_shell) ? b.chat_raw_shell : 'off', context: { ...CONTEXT_DEFAULT, ...(b.policy?.context?.controller || {}) },
      // META-CHAT-CONTROLS R1: what the picker / /model / /effort may choose (the Settings rows' own lists), the usage estimate for /cost
      choices: { models: MODELS, efforts: EFFORTS, alias: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' } }, perPct: b.cacheR_per_pct || null };
  }
  function chatOf(p) {
    let c = chats.get(p.name);
    if (!c) {
      chatConfig(p);   // a bad Settings value is a 400 before any chat exists
      c = createChat({ project: p, config: () => chatConfig(p), spawnFn: o.chatSpawnFn, env: cliEnv });
      chats.set(p.name, c);
    }
    return c;
  }
  // C3: the chat profile's outbox (cards, timeouts, shown files) reaches the thread on every read too - also while no process runs
  function drainChat(p, any = true) { try { const c = chatOf(p); if (any) c.drain(); } catch (e) { if (!e.status) throw e; /* no chat-capable executor: nothing to drain into */ } }
  // META-DASH-ASYNC R1: a GET's drain - the outbox is listed on fs.promises; only events waiting there run the (sync, writing) drain;
  // then the thread is read into the request snapshot (readThread is a lookup after this)
  async function drainChatA(p) {
    const any = (await readdirA(outboxDir(p.state))).some(e => e.name.endsWith('.json'));
    drainChat(p, any); if (any) forget(threadFile(p.state));
    await readTextA(threadFile(p.state));
  }
  const actFail = e => (e instanceof ActError ? fail(e.status, e.message) : e);
  // POST /api/chat/undo: the Undo of a done card - the verb the card names, written by the dashboard for the owner (no model)
  async function chatUndo(p, line) {
    if (!Number.isInteger(line) || line < 0) throw fail(400, 'line must be the thread line of a done card');
    const items = readThread(p.state).items, l = items[line], u = l?.undo;
    if (l?.kind !== 'done' || !u) throw fail(400, `thread line ${line} is not a done card with an Undo`);
    if (items.some(x => x.kind === 'undone' && x.line === line)) throw fail(409, 'Undone already');
    const why = `undo from the chat (thread line ${line})`, runOf = id => runsOf(st(p)).find(r => r.id === id);
    if (u.verb === 'revoke' && /^DIR-(?:[a-z][a-z0-9]{0,15}-)?\d+$/.test(u.id)) await rec(p, { kind: 'directive', ev: 'revoke', id: u.id, by: 'dashboard', data: {} });
    else if (u.verb === 'stop' && /^RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+$/.test(u.run)) {
      const r = runOf(u.run);
      if (r?.state !== 'queued') throw fail(409, `${u.run} is ${r?.state ?? 'gone'}: Undo withdraws only a queued run`);
      await stopRunAsync({ state: p.state, locksDir: o.locksDir ?? path.join(path.dirname(path.resolve(p.state)), 'locks'), run: u.run, by: 'dashboard', why });
    } else if (u.verb === 'requeue' && /^RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+$/.test(u.run) && /^RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+$/.test(u.from)) {
      try { requeueRun({ state: p.state, run: u.run, after: runOf(u.from)?.data.after ?? [], by: 'dashboard', why }); } catch (e) { throw fail(e.code === 3 ? 409 : 400, e.message); }
    } else throw fail(400, `no undo verb ${u.verb}`);
    await viewsA(p);
    chatOf(p).note('undone', { line, verb: u.verb, by: 'owner' });
    return { ok: true, line, verb: u.verb };
  }
  function chatStatus(p) {
    const c = chats.get(p.name);
    if (c) return c.status();
    const t = threadState(readThread(p.state).items);
    return { running: false, busy: false, segment: t.seg?.n ?? null, session_id: t.seg?.session_id ?? null };
  }
  // ---------- META-CONTROLLER C2: the Home tab (Look 3) = the thread + its side columns; reading it starts no chat process ----------
  async function homeOf(p) {
    await drainChatA(p);
    const s = st(p), runs = runsOf(s), lines = readThread(p.state).items, seg = threadState(lines).seg;
    // an unreviewed run / a parked lane sits in the thread at its record's last event (the inbox row has no created time)
    const needs = (await inbox(p)).filter(isNeed).map(n => (n.created ? n : { ...n, created: s.items[n.id]?.updated ?? null }));
    const events = homeEvents({ thread: lines, runs, items: Object.values(s.items), ledger: p.ledger ? (await tail(p.ledger, 400)).map(parseLedgerLine) : [], needs });
    const m = withDefaults(settingsState(p).view), usageLine = [...lines].reverse().find(l => l.kind === 'usage' && (!seg || l.seg === seg.n));
    // C5: model / effort / raw shell as the NEXT start will use them (Settings, live); the context meter amber past no_new_step_k; the cost line
    const live = (() => { try { return chatConfig(p); } catch { return null; } })(), cc = m.policy?.context?.controller ?? {}, day = new Date(); day.setHours(0, 0, 0, 0);
    // META-CHAT-CONTROLS R1: the chat's pick (picker, /model, /effort) over the Settings rows; both shown; the session's own commands for the "/" menu
    const pick = chatPick(lines), dm = live?.model ?? seg?.model ?? m.checkin_model ?? null, de = live?.effort ?? seg?.effort ?? m.checkin_effort ?? null;
    const status = { ...chatStatus(p), executor: live?.executor ?? seg?.executor ?? m.chat_executor ?? 'claude', model: pick?.model ?? dm,
      effort: pick?.effort ?? de, pick, defaults: { model: dm, effort: de }, choices: live?.choices ?? null, commands: chatCommands(lines), norn_commands: NORN_COMMANDS, raw_shell: live?.rawShell ?? 'off',
      ctx: usageLine?.ctx ?? null, handoff_k: cc.handoff_k ?? null, no_new_step_k: cc.no_new_step_k ?? null,
      cost: chatCost(lines, { since: day.getTime(), perPct: m.cacheR_per_pct || null }) };
    const nodes = new Map((await agents(p)).map(n => [n.id, n])), today = new Date().toDateString(), byNew = (a, b) => String(b.created).localeCompare(String(a.created));
    // + a run that just ended HANDOFF and waits for its resume verdict (handoffOf step 'ending'): the lane is not idle, it hands off
    const now = runs.filter(r => (['running', 'queued', 'claimed'].includes(r.state) || (r.end?.outcome === 'handoff' && !r.resume && hoOf(p, r)?.step === 'ending')) && r.data.kind !== 'checkin' && r.data.role !== 'helper')
      .map(r => { const n = nodes.get(r.id) ?? {}; return { run: r.id, lane: r.data.lane ?? null, name: runName(r), state: r.state, ran_min: n.ran_min ?? null, ctx: n.ctx ?? null, handoff: n.handoff ?? hoOf(p, r) }; })
      .sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1));
    const u = usage(p, m), items = Object.values(s.items);
    const side = { now, usage: { used: u.weeklyUsed ?? null, stop: u.weeklyStopPct ?? null }, interval_min: m.policy?.cadence?.checkin_interval_min ?? null,
      checkins_paused: stopsCheckins(pauseOfP(p)), limits: limitLines(p.state),   // RM-37: Pause check-ins / Pause everything   // META-LIMIT-GATE: executors out of quota
      waiting: needs.map(n => ({ id: n.id, type: n.type, title: n.title ?? (n.type === 'unreviewed' ? `${n.lane ?? 'run'} ${String(n.outcome ?? n.state).toUpperCase()}` : n.type === 'parked' ? `lane ${n.lane} parked` : n.id), created: n.created ?? null })),
      ruled: items.filter(i => i.kind === 'decision' && new Date(i.created).toDateString() === today).sort(byNew).slice(0, 6)
        .map(d => ({ id: d.id, text: d.data.question ? `${d.data.question}: ${d.data.choice ?? ''}` : d.data.choice ?? d.data.text ?? '', created: d.created, state: d.state })),
      orders: items.filter(i => i.kind === 'directive' && i.state === 'active').sort(byNew).slice(0, 8).map(d => ({ id: d.id, text: d.data.text ?? '', created: d.created })) };
    return { project: p.name, now: iso(), events, needs_you: needsYou(needs), approvals: events.filter(e => e.kind === 'approval' && e.state === 'pending').length, status, side };
  }
  // GET /api/file?project=&path=: an image the thread shows inline, served only from the allow-listed roots - the project root, its
  // state dir, and the worktree + NOTES folder of each of its runs (shots live beside the work that made them). Real paths are compared
  // (no .. or link escapes); anything else is refused.
  const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
  const realOf = f => fs.promises.realpath(path.resolve(f)).catch(() => null);   // META-DASH-ASYNC R1: libuv realpath (= realpathSync.native) on the threadpool
  // C3: the same roots norn_show may show (chatact.showRoots: + the briefs dir and lane worktrees / NOTES folders)
  const fileRoots = p => showRoots(p.state, p);
  async function fileOf(p, url) {
    const raw = url.searchParams.get('path');
    if (!raw) throw fail(400, 'path is required');
    if (!path.isAbsolute(raw) || /^[\\/]{2}/.test(raw)) throw fail(400, 'path must be an absolute local path');
    const real = await realOf(raw), f = real ?? realPath(raw);   // a missing file: its real folder + name (an 8.3 short spelling is judged, 404, not refused)
    const inside = r => { const rel = path.relative(r, f); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
    if (!fileRoots(p).some(inside)) throw fail(403, 'Outside the allowed roots (the project root, its state, its runs\' worktrees and NOTES folders)');
    const type = IMAGE[path.extname(f).slice(1).toLowerCase()];
    if (!type) throw fail(415, 'Only images (png, jpg, webp, gif)');
    const stat = real ? await fs.promises.stat(real).catch(() => null) : null;
    if (!stat?.isFile()) throw fail(404, 'File not found');
    if (stat.size > 32 * 1024 * 1024) throw fail(413, 'Image larger than 32 MB');
    return { type, data: await fs.promises.readFile(real) };
  }

  // GET /api/chat?live=1: Server-Sent Events, one `line` event per thread line (id = its line number) from `from` / Last-Event-ID + 1,
  // then each line as it is appended
  // META-DASH-ASYNC R1: the thread is read on fs.promises, so the replay and the subscription are no longer one tick - it subscribes
  // first (lines appended meanwhile wait), reads, replays, then sends the waiting lines past the replay (by line number: no repeat, no gap)
  async function openChat(p, res, from) {
    if (chatStreams.size >= (o.streamMax ?? 16)) throw fail(429, `Too many chat streams open (max ${o.streamMax ?? 16})`);
    const c = chatOf(p), early = [];
    let send = (l, i) => early.push([l, i]);
    const off = c.subscribe((l, i) => send(l, i));
    chatStreams.add(res);
    res.on('close', () => { off(); chatStreams.delete(res); });
    let t;
    try { forget(threadFile(p.state)); await readTextA(threadFile(p.state)); t = readThread(p.state, from); } catch (e) { off(); chatStreams.delete(res); throw e; }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const write = (l, i) => { try { res.write(`id: ${i}
event: line
data: ${JSON.stringify(l)}

`); } catch { /* gone */ } };
    t.items.forEach((l, k) => write(l, from + k));
    for (const [l, i] of early) if (i >= t.count && i >= from) write(l, i);
    send = write;
  }

  async function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw fail(415, 'Use application/json');
    const chunks = []; let size = 0;
    for await (const b of req) { size += b.length; if (size > 32768) throw fail(413, 'Request body too large'); chunks.push(b); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'Invalid JSON'); }
    if (!plain(data)) throw fail(400, 'Request body must be an object'); return data;
  }
  const projectOf = data => { if (!projects.length) throw noProject(); const p = projects.find(x => x.name === (data.project ?? firstP().name)); if (!p) throw fail(404, `Unknown project ${data.project}`); return p; };
  // META-DASH-ASYNC R1 (option a): a POST's record write + its views on fs.promises (recordAsync / writeViewsAsync)
  const rec = async (p, ev) => { try { const r = await recordAsync(p.state, ev); await viewsA(p); return { ok: true, id: r.id, seq: r.seq }; } catch (e) { if (e instanceof RecordError) throw fail(409, e.message); throw e; } };

  // META-ROADMAP S3 (SPEC sec. 3): the owner's roadmap edits - ONE item event per POST, by dashboard (the page token, as every
  // dashboard write). An edit of an existing item sends the rev it saw (its last event seq) and a move the order it saw under the
  // target parent: either moved on = 409, nothing written. The reply carries the rebuilt tree; the ROADMAP view follows the edit.
  const RM_OPS = ['add', 'edit', 'move', 'link', 'unlink', 'drop', 'reopen'];
  async function roadEdit(p, op, data) {
    if (!RM_OPS.includes(op)) throw fail(404, 'Not found');
    for (const k of ['status', 'phase', 'progress']) if (k in data) throw fail(400, `${k} is derived from the item's links, never typed`);
    const R = loadRoadmap(p.state), opt = (o, k, v = data[k]) => (v === undefined ? o : { ...o, [k]: v });
    const strs = (v, name) => { if (v === undefined) return []; if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw fail(400, `${name} must be a list of strings`); return v; };
    let id, ev, links = [];
    if (op === 'add') {
      links = strs(data.links, 'links');
      const theme = data.kind === 'theme';
      ev = { ev: 'create', data: opt(opt(opt({ title: data.title, kind: theme ? 'theme' : 'item', links }, 'parent', theme ? undefined : data.parent), 'after'), 'horizon', data.horizon || undefined) };
      if (data.note) ev.data.note = data.note;
    } else {
      id = String(data.id ?? '');
      const it = R.items[id];
      if (!it) throw fail(404, `${id} does not exist`);
      if (!Number.isInteger(data.rev)) throw fail(400, 'rev is required: the last event seq of the item the page saw');
      const cur = it.history.at(-1).seq;
      if (data.rev !== cur) throw fail(409, `${id} changed elsewhere (seq ${cur}; the page saw ${data.rev}). Reload and edit again.`);
      if (op === 'edit') ev = { data: ['title', 'note', 'horizon', 'caveat'].reduce((o, k) => opt(o, k, (k === 'horizon' || k === 'caveat') && data[k] === '' ? null : data[k]), {}) };
      if (op === 'move') {
        if (!Array.isArray(data.order)) throw fail(400, 'a move names the order it saw: order = the ids under the target parent');
        const dest = 'parent' in data ? data.parent : it.parent, now = R.kids[dest || ''] || [];
        if (JSON.stringify(now) !== JSON.stringify(data.order)) throw fail(409, `The order changed elsewhere (under ${dest || 'the root'}). Reload and move again.`);
        ev = { data: opt(opt(opt({}, 'parent'), 'after'), 'ref', data.ref || undefined) };
      }
      if (op === 'link' || op === 'unlink') { ev = { data: { links: strs(data.links, 'links') } }; if (op === 'link') links = ev.data.links; }
      if (op === 'drop') { ev = { data: opt({ why: data.why }, 'ref', data.ref || undefined) }; if (typeof data.ref === 'string' && data.ref) links = refTerm(data.ref); }
      if (op === 'reopen') ev = { data: { why: data.why } };
      ev.ev = op;
    }
    try { checkLinks(p.state, links, { project: p }); } catch (e) { if (e instanceof RoadmapError) throw fail(400, e.message); throw e; }
    let r;
    try { r = await recordAsync(p.state, { kind: 'item', id, by: 'dashboard', ...ev }, { views: false }); }
    catch (e) { if (e instanceof RecordError) throw fail(e.code === 2 ? 400 : 409, e.message); throw e; }
    const tree = await roadmapOf(p);
    if (tree && !tree.error) await writeRoadmapViewAsync(p.state, tree, roadmapViewPath(p.state, p));   // a hand-edited view stays refused (norn road warns)
    return { ok: true, id: r.id, seq: r.seq, tree };
  }

  // ---------- META-ADOPT A3 (SPEC meta-adopt sec. 5): the dashboard front end of `norn adopt` ----------
  // Every route is a thin call into what the CLI uses: the slow or git-heavy verbs (scan, project new, draft) run the CLI itself as a
  // child (the server never blocks on a 3 s scan), decide / apply / close call engine/lib/adopt.mjs in-process. Writes carry the page
  // token and are recorded by role dashboard; a decide names the part sha the page saw (stale = 409, nothing written).
  const keyOf = r => path.resolve(String(r)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const fwdP = r => String(r).replace(/\\/g, '/');
  const projectAt = root => projects.find(p => p.root && keyOf(p.root) === keyOf(root))?.name ?? null;
  function metaCli(args, { timeout = 120000, env = null } = {}) {
    return new Promise(resolve => {
      execFile(process.execPath, [META_CLI, ...args], { env: env ? { ...cliEnv, ...env } : cliEnv, timeout, windowsHide: true, maxBuffer: 32 << 20 }, (e, out, errText) =>
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: String(out || ''), err: String(errText || '') }));
    });
  }
  // a CLI refusal -> its one error line; "exists / already / is open|applied|closed / no proposal / REFUSED" are conflicts (409)
  const cliFail = r => {
    const msg = (/^REFUSED: (.*)$/m.exec(r.out)?.[1]) || (/^error: (.*)$/m.exec(r.err)?.[1]) || (r.err || r.out).trim().split(/\r?\n/)[0] || `exit ${r.code}`;
    return fail(r.code === 4 || /already registered|exists: never|is open|is applied|is closed|no proposal|one open proposal/.test(msg) ? 409 : r.code === 2 ? 400 : 500, msg);
  };
  const scans = new Map();   // repo root -> { at, facts } (+ busy while a scan runs): one scan per root at a time, kept 10 min
  async function scanRoot(root, { fresh = false } = {}) {
    const k = keyOf(root), c = scans.get(k);
    if (c?.busy) return c.busy;
    if (c?.facts && !fresh && Date.now() - c.at < 600000) return c.facts;
    const busy = metaCli(['adopt', 'scan', '--root', root, '--json']).then(r => {
      if (r.code) { scans.delete(k); throw cliFail(r); }
      const facts = JSON.parse(r.out); scans.set(k, { at: Date.now(), facts }); return facts;
    });
    scans.set(k, { ...(c || {}), busy });
    return busy;
  }
  const rulesFile = p => path.join(p.project_dir || path.dirname(p.file), RULES_FILE);
  /** what the latest proposal saw, else a scan already cached; never a new scan (the Overview asks every poll) */
  function factsKnown(p) {
    const P = existsS(p.state) ? proposalOf(p.state) : null;
    if (P?.facts_file) { try { return JSON.parse(read(path.join(p.state, P.facts_file))); } catch { /* moved: the cache */ } }
    return (p.root && scans.get(keyOf(p.root))?.facts) || null;
  }
  /** the repo's own agent rules files (CLAUDE.md, AGENTS.md ...) at its root and its subdir: every worker's own tool reads them, so they ARE rules */
  const agentFilesIn = p => !p.root ? [] : [...new Set(['', subdirOf(p)])].flatMap(d => AGENT_FILES.filter(f => existsS(path.join(p.root, d, f))).map(f => (d ? d + '/' : '') + f));
  /** where the caps were chosen: a caps profile decision, else a cap in budget.json (Settings writes it) that is not the starter cap
   *  `norn setup` wrote unasked (the default profile's), else null - nobody chose them */
  function capsChosen(p, s, items) {
    if (items.some(capsRec)) return 'decision';
    const prof = loadProfiles().profiles.find(x => x.default), starter = prof ? profileBudget(prof, { found: profileFor(p, s).found }) : {};
    return REQUIRED_CAPS.some(k => Number.isFinite(s.budget[k]) && s.budget[k] !== starter[k]) ? 'budget' : null;
  }
  /** the setup gaps of one project (SPEC sec. 5 empty states): rules, caps chosen, the merge gate, the roadmap */
  function setupOf(p) {
    const items = Object.values(st(p).items), facts = factsKnown(p), s = settingsState(p), view = withDefaults(s.view);
    let roadmap = 0; try { roadmap = Object.values(loadRoadmap(p.state).items).filter(i => i.state === 'open').length; } catch { /* no roadmap */ }
    const agentFiles = agentFilesIn(p), rulesFrom = [...((p.rules_read_whole || []).length || existsS(rulesFile(p)) ? [RULES_FILE] : []), ...agentFiles];
    const caps = capsChosen(p, s, items);
    return { project: p.name, rules: rulesFrom.length > 0, rules_from: rulesFrom, caps_chosen: !!caps, caps_from: caps, gate: p.merge?.gate?.cmd ?? null,
      found_gate: facts?.commands?.find(c => c.id === 'test')?.cmd ?? null,
      roadmap, agent_files: agentFiles, version: s.version, caps: Object.fromEntries(['max_claude_workers', 'max_codex', 'weekly_stop_pct'].map(k => [k, view[k] ?? null])), profile_now: profileNow(p, s) };
  }
  /** "Set it": merge.gate.cmd into project.json on the Settings write path (the version the page saw, one atomic write) */
  async function saveGate(p, cmd, version) {
    const s = settingsState(p);
    if (version !== s.version) throw fail(409, 'Settings changed elsewhere. Reload and set the gate again.');
    const merge = s.proj.merge || {};
    await atomicA(p.file, JSON.stringify({ ...s.proj, merge: { ...merge, gate: { ...(merge.gate || {}), cmd } } }, null, 2) + '\n');
    reloadProjects(true);
    return { ok: true, gate: cmd, written: [p.file] };
  }
  async function adoptView(p) {
    const P = existsS(p.state) ? proposalOf(p.state) : null;
    let facts = factsKnown(p), scanError = null;
    if (!facts && p.root) { try { facts = await scanRoot(p.root); } catch (e) { scanError = e.message; } }
    const pick = readExecutor(p), consent = { ...pick, cap_min: 15 };
    consent.line = consentLine({ executor: pick.executor, model: pick.model, provider: p.executors?.[pick.executor]?.base_url ? p.executors[pick.executor] : undefined }).replace(/\. Choose --read.*$/, '');
    let rd = null;
    if (P) {
      const s = st(p), runs = runsOf(s).filter(r => r.data.lane === 'adopt' && String(r.data.q ?? '').startsWith(P.id + ' read '))
        .sort((a, b) => Number(a.id.split('-').pop()) - Number(b.id.split('-').pop()));
      const r = runs.at(-1), hist = readEvents(recordsFile(p.state, 'proposal')).filter(e => e.id === P.id);
      if (r) rd = { id: r.id, name: runName(r), state: r.state, executor: r.data.executor ?? null, model: r.data.model ?? null, started: r.created,
        attempt: runs.length, ingested: hist.some(h => h.ev === 'draft' && h.data?.run === r.id) };
    }
    let lane = null;
    const fp = P?.parts.find(x => x.id === 'first'), fl = fp?.applied && fp.lines.find(l => !l.already && !(fp.decision?.off || []).includes(l.id));
    if (fl) { try { const name = laneNameOf(fl.text), at = lanePaths(p, name); lane = { name, task: fl.text, worktree: fwdP(at.worktree), branch: at.branch, brief: fwdP(at.brief), exists: !!st(p).items[laneId(name, p.state)] }; } catch { /* no lane paths */ } }
    return { project: p.name, title: p.title ?? p.name, root: p.root ?? null, facts, scan_error: scanError, interview: facts ? interviewOf(facts) : [], consent,
      setup: setupOf(p), proposal: P, read: rd, lane, answer_keys: ANSWER_KEYS };
  }
  /** the git repos beside the registered projects (a browser cannot hand a folder path to a local server); none yet: the home's code folders */
  async function reposNear() {   // META-DASH-ASYNC R1: listed on fs.promises
    const roots = projects.map(p => p.root).filter(Boolean);
    const dirs = roots.length ? [...new Set(roots.map(r => path.dirname(path.resolve(r))))]
      : [home, ...['dev', 'code', 'src', 'projects', 'repos', 'git', 'source/repos'].map(d => path.join(home, d))];
    const out = [];
    for (const d of dirs) {
      const ents = (await readdirA(d)).filter(e => e.isDirectory() && !e.name.startsWith('.'));
      const git = await Promise.all(ents.map(e => existsA(path.join(d, e.name, '.git'))));
      for (const [i, e] of ents.entries()) {
        const r = path.join(d, e.name);
        if (git[i]) out.push({ name: e.name, path: fwdP(r), registered: projectAt(r), note: `in ${fwdP(d)}` });
      }
    }
    return out.sort((a, b) => (a.registered ? 1 : 0) - (b.registered ? 1 : 0) || a.name.localeCompare(b.name)).slice(0, 40);
  }
  const answersOf = v => {
    if (v === undefined) return {};
    if (!plain(v)) throw fail(400, 'answers must be an object');
    const a = {};
    for (const [k, x] of Object.entries(v)) {
      if (!ANSWER_KEYS.includes(k)) throw fail(400, `unknown answer ${k} (answers: ${ANSWER_KEYS.join(', ')})`);
      if (typeof x !== 'string') throw fail(400, `answer ${k} must be text`);
      if (line(x)) a[k] = line(x).slice(0, 1000);
    }
    return a;
  };
  const strList = (v, name) => { if (v === undefined) return []; if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw fail(400, `${name} must be a list of line ids`); return v; };
  const adoptCall = fn => {
    const map = e => {
      if (e instanceof AdoptError) return fail(/is (applied|closed)|no proposal yet/.test(e.message) ? 409 : 400, e.message);
      if (e instanceof RecordError) return fail(e.code === 2 ? 400 : 409, e.message);
      if (e instanceof LaneError) return fail(e.code === 1 ? 500 : 400, e.message);
      return e;
    };
    try { const r = fn(); return r && typeof r.then === 'function' ? r.catch(e => { throw map(e); }) : r; } catch (e) { throw map(e); }
  };
  async function adoptPost(route, data) {
    if (route === '/api/project/new') {
      if (!o.metaRoot) throw fail(409, 'this dashboard was started with explicit --project files: add a project with norn project new --root <repo>');
      const root = str(data.root, 'root', 1000);
      const r = await metaCli(['project', 'new', '--root', root, '--non-interactive', ...(data.name ? ['--name', str(data.name, 'name', 80)] : [])]);
      if (r.code) throw cliFail(r);
      reloadProjects(true);
      const name = projectAt(root);
      if (!name) throw fail(500, `project new wrote no registered project for ${fwdP(root)}: ${r.out.trim().split(/\r?\n/).at(-1)}`);
      return { ok: true, project: name, out: r.out.trim().split(/\r?\n/) };
    }
    const p = projectOf(data);
    if (route === '/api/adopt/draft') {
      if (typeof data.read !== 'boolean') throw fail(400, 'read must be true (one read-only agent run, its cost stated) or false (the free facts-only draft)');
      const answers = answersOf(data.answers), args = ['adopt', 'draft', '--project', p.file, '--state', p.state, '--as', 'dashboard',
        ...Object.entries(answers).flatMap(([k, v]) => ['--answer', `${k}=${v}`])];
      if (data.read) {
        if (data.executor !== undefined && !/^[a-z0-9][a-z0-9_.-]*$/i.test(String(data.executor))) throw fail(400, 'executor: a configured executor name');
        const r = await metaCli([...args, '--read', ...(data.executor ? ['--executor', String(data.executor)] : [])]);
        if (r.code) throw cliFail(r);
        const m = /^(ADP-[\w-]+) read (RUN-[\w-]+) started/m.exec(r.out);
        if (!m) throw fail(500, 'the read did not report its run: ' + r.out.trim());
        return { ok: true, id: m[1], run: m[2] };
      }
      const r = await metaCli([...args, '--no-read']);
      if (r.code) throw cliFail(r);
      const m = /^(ADP-[\w-]+) (opened|re-drafted)/m.exec(r.out);
      return { ok: true, id: m?.[1] ?? proposalOf(p.state)?.id ?? null, created: m?.[2] === 'opened' };
    }
    if (route === '/api/adopt/decide') {
      if (!['approve', 'skip'].includes(data.verdict)) throw fail(400, 'verdict must be approve or skip');
      if (typeof data.sha !== 'string' || !data.sha) throw fail(400, 'sha is required: the part sha the page saw');
      const P = proposalOf(p.state);
      if (!P || P.state !== 'open') throw fail(409, P ? `${P.id} is ${P.state}: start a new draft` : 'no proposal yet: draft one first');
      const x = P.parts.find(y => y.id === data.part);
      if (!x) throw fail(400, `${P.id} has no part ${data.part} (${P.parts.map(y => y.id).join(' | ')})`);
      if (x.sha !== data.sha) throw fail(409, `${P.id} ${x.id} changed since the page drew it (a new draft). Reload and review it again.`);
      const pick = data.pick === undefined ? undefined : String(data.pick);
      const r = await adoptCall(() => adoptDecideAsync(p.state, { part: x.id, verdict: data.verdict, off: strList(data.off, 'off'), on: strList(data.on, 'on'), ...(pick !== undefined ? { pick } : {}), ...(data.edits !== undefined ? { edits: data.edits } : {}), by: 'dashboard' }));
      return { ok: true, ...r, proposal: proposalOf(p.state) };
    }
    if (route === '/api/adopt/apply') {
      const r = await adoptCall(() => adoptApplyAsync(p.state, { project: p, by: 'dashboard', metaRoot: metaRootDir }));
      reloadProjects(true); await viewsA(p);
      return { ok: true, ...r, proposal: proposalOf(p.state) };
    }
    if (route === '/api/adopt/close') {
      const r = await adoptCall(() => adoptCloseAsync(p.state, { why: str(data.why ?? 'not now', 'why', 400), by: 'dashboard' }));
      return { ok: true, ...r };
    }
    if (route === '/api/adopt/rule') {   // "Write one rule": RULES.md beside project.json + rules_read_whole (never the repo)
      const r = await adoptCall(() => addRuleAsync(p, str(data.text, 'Rule', 400)));
      reloadProjects(true);
      return { ok: true, ...r };
    }
    if (route === '/api/adopt/caps') {   // "Keep the starter caps": a choice, recorded like a profile pick (the scheduler stays off)
      return rec(p, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'adopt', question: 'caps profile', choice: 'the starter caps (kept)', why: 'kept from the dashboard' } });
    }
    if (route === '/api/adopt/gate') {   // the Overview merge gate step's one click: the proposed command -> merge.gate.cmd
      if (typeof data.version !== 'string' || !data.version) throw fail(400, 'version is required: the settings version the page saw');
      return saveGate(p, str(data.cmd, 'cmd', 1000), data.version);
    }
    if (route === '/api/adopt/rehearse') {   // the first lane on the fake executor: spends nothing, shows the whole path
      const name = String(data.lane ?? ''), at = adoptCall(() => lanePaths(p, name));
      if (!st(p).items[laneId(name, p.state)]) throw fail(404, `lane ${name} does not exist`);
      return { ok: true, ...(await platform.rehearse(p, name, at.brief)) };
    }
    throw fail(404, 'Not found');
  }

  // INBOX-REPLIES: start the check-in that replies in a Q's thread now; a running one (or a pause) leaves it to the next tick
  async function replyNow(p) {
    if (pausedFiles(p).some(existsS)) return 'paused';
    if (lockFresh(p) || checkinStarting) return 'next';
    checkinStarting = true;
    try { await platform.tick(p); return 'started'; } catch { return 'next'; } finally { const t = setTimeout(() => { checkinStarting = false; }, 5000); t.unref(); }
  }

  async function post(route, data) {
    if (route === '/api/project/new' || route.startsWith('/api/adopt/')) return adoptPost(route, data);
    const p = projectOf(data);
    const rmo = route.match(/^\/api\/roadmap\/([a-z]+)$/);
    if (rmo) return roadEdit(p, rmo[1], data);
    if (route === '/api/claim/take') {   // RM-46 S3: the owner's take over of another home's STALE work claim (the CLI checks stale on this home's clock)
      if (typeof data.lane !== 'string' || !/^[a-z][a-z0-9]{0,7}\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(data.lane)) throw fail(400, 'lane must be <home>/<lane>');
      const r = await metaCli(['claim', 'take', data.lane, '--project', p.name, ...(machineFile ? ['--machine', machineFile] : [])]);
      if (r.code) throw cliFail(r);
      return { ok: true, line: r.out.trim() };
    }
    if (route === '/api/answer') {
      if (data.from !== undefined) {   // META-Q-RECONCILE R1: "already answered in DEC-m" - the owner words the DEC recorded
        if (typeof data.from !== 'string' || !/^DEC-(?:[a-z][a-z0-9]{0,15}-)?\d+$/.test(data.from)) throw fail(400, 'from must be a DEC-n');
        return rec(p, { kind: 'question', ev: 'answer', id: String(data.id), by: 'dashboard', data: { from: data.from } });
      }
      const id = String(data.id), q = st(p).items[id];
      if (data.ruling !== undefined) {   // INBOX-REPLIES: the owner's one tap on the ruling the controller proposed from their words
        const P = rulingOf(q);
        if (!P || P.seq !== data.ruling) throw fail(409, `${id} has no such proposed ruling any more (a newer message or reply). Reload.`);
        return rec(p, { kind: 'question', ev: 'answer', id, by: 'dashboard', data: { text: `Rule: ${P.key ? `(${P.key}) ` : ''}${P.text} - yes`, via: 'dashboard', ruling: P.seq, ...(P.key ? { choice: P.key } : {}) } });
      }
      const text = str(data.text, 'Answer', 4000);
      if (data.choice !== undefined && typeof data.choice !== 'string') throw fail(400, 'choice must be a string');
      // INBOX-REPLIES: typed words are a message to the controller, not a ruling - unless they are a bare option key ("b", "(b)").
      // The message goes in the Q's thread (it stays open) and a check-in starts at once to reply, so the owner does not wait a tick.
      const choice = data.choice || (q?.kind === 'question' ? pickOf(text, q.data.options) : null);
      if (choice) {
        const r = await rec(p, { kind: 'question', ev: 'answer', id, by: 'dashboard', data: { text, via: 'dashboard', choice } });
        try { await platform.tick(p); } catch { /* the scheduled tick applies it then */ }   // item 8 (MAIL-9 d): an answer starts a tick at once
        return r;
      }
      const r = await rec(p, { kind: 'question', ev: 'say', id, by: 'dashboard', data: { text, via: 'dashboard' } });
      return { ...r, said: true, reply: await replyNow(p) };
    }
    if (route === '/api/first-task') {   // META-OOTB F-1: the owner's first task = a directive + lane `first` + its worktree / branch / brief
      const text = str(data.text, 'Task', 4000);
      try { const r = await newLaneAsync(p, { name: data.lane === undefined ? FIRST_LANE : String(data.lane), task: text, by: 'dashboard' }); await viewsA(p); return { ok: true, ...r }; }
      catch (e) { if (e instanceof LaneError) throw fail(e.code === 1 ? 500 : 400, e.message); if (e instanceof RecordError) throw fail(409, e.message); throw e; }
    }
    // gap #5: a restatement of an active directive = 409 carrying the match (dup: the page says it in plain words and offers Open DIR-n /
    // Replace it with this wording); new: true creates it anyway, replace: DIR-n creates it and supersedes DIR-n by it (both recorded).
    // card: the repeat detector's card this approves (rules.mjs askedBy closes the card on it)
    if (route === '/api/directive') {
      const text = str(data.text, 'Directive', 4000), dup = dupOf(st(p).items, text), card = /^A-[0-9a-f]{10}$/.test(data.card ?? '') ? data.card : null;
      const replace = data.replace == null ? null : String(data.replace), old = replace ? st(p).items[replace] : null;
      if (replace && !(old?.kind === 'directive' && old.state === 'active')) throw fail(400, `${replace} is not an active directive`);
      if (dup && data.new !== true && !replace) throw Object.assign(fail(409, dupMessage(dup, 'new: true')), { body: { dup: { id: dup.id, line: dup.line, why: dup.why } } });
      const r = await rec(p, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text, via: 'dashboard', ...(card ? { card } : {}), ...(dup && dup.id !== replace ? { distinct_from: [dup.id] } : {}) } });
      if (replace) await rec(p, { kind: 'directive', ev: 'supersede', id: replace, by: 'dashboard', data: { by: r.id, why: 'restated: replaced by this wording from the dashboard' } });
      return { ...r, ...(replace ? { superseded: replace } : {}) };
    }
    if (route === '/api/directive/revoke') return rec(p, { kind: 'directive', ev: 'revoke', id: String(data.id), by: 'dashboard', data: {} });
    if (route === '/api/decision/overrule') return rec(p, { kind: 'decision', ev: 'overrule', id: String(data.id), by: 'dashboard', data: { text: str(data.text, 'Overrule text', 4000), ...(data.rework_lane ? { rework_lane: String(data.rework_lane) } : {}) } });
    if (route === '/api/lane/archive') return rec(p, { kind: 'lane', ev: data.unarchive === true ? 'unarchive' : 'archive', id: laneId(String(data.lane), p.state), by: 'dashboard', data: data.override ? { override: String(data.override) } : {} });   // item 9: work not on main needs the owner's override (records.mjs)
    if (route === '/api/handedit') {   // GAP-8: "Let Norn take it back" (a .bak of the hand text, then the views rewritten) or "Keep my version"
      if (!['takeback', 'keep'].includes(data.choice)) throw fail(400, 'choice must be takeback or keep');
      if (typeof data.file !== 'string' || !data.file) throw fail(400, 'file is required');
      try {
        if (data.choice === 'keep') return { ok: true, ...(await keepEdit(p.state, data.file)) };
        const r = await takeBack(p.state, data.file), v = await viewsA(p);
        return { ok: true, ...r, regenerated: v.written.some(f => path.resolve(f) === path.resolve(r.file)) };
      } catch (e) { if (e.code === 409) throw fail(409, e.message); throw e; }
    }
    if (route === '/api/pause') {
      // RM-37: every pause is the CLI's (`norn pause` / `norn resume`, pause.mjs) run as a child: no sync write here. Exactly one of
      // { mode, why? } | { runs: [RUN-n], why? } (a safe pause of each) | { resume: RUN-n | 'all' }
      const runs = Array.isArray(data.runs) ? data.runs.map(String) : null, asks = ['mode', 'runs', 'resume'].filter(k => data[k] !== undefined);
      if (asks.length !== 1) throw fail(400, 'give exactly one of mode | runs | resume');
      if (runs && (!runs.length || !runs.every(r => /^RUN-\d+$/.test(r)))) throw fail(400, 'runs must be RUN-n ids');
      if (data.resume !== undefined && !(data.resume === 'all' || /^RUN-\d+$/.test(String(data.resume)))) throw fail(400, 'resume must be RUN-n or all');
      const args = data.mode !== undefined ? ['pause', '--mode', String(data.mode)] : runs ? ['pause', ...runs] : data.resume === 'all' ? ['resume', '--all'] : ['resume', String(data.resume)];
      const r = await metaCli([...args, ...(data.why && data.resume === undefined ? ['--why', line(data.why)] : []), '--state', p.state, '--as', 'dashboard']);
      if (r.code) throw cliFail(r);
      return { ok: true, out: r.out.trim() };
    }
    // RM-37: pause half's pick (reads only): its confirm line lists the runs; the confirm posts them to /api/pause { runs }
    if (route === '/api/pause/half') return pickHalf(p.state, { nearEnd: nearEndMin(p.policy) });
    if (route === '/api/requeue') {   // MERGE-FIRST: Plan > Up next's priority control - the queued run re-queued at that priority, its after: kept
      const r = st(p).items[String(data.run)];
      if (!r || r.kind !== 'run' || r.state !== 'queued') throw fail(409, 'Run is not queued any more. Refresh.');
      let out;
      try { out = requeueRun({ state: p.state, run: r.id, by: 'dashboard', why: `priority ${data.priority} set on the Plan page`, priority: data.priority }); } catch (e) { throw fail(e.code === 3 ? 409 : 400, e.message); }
      await viewsA(p);
      if (plans.has(p.name)) plans.get(p.name).at = 0;   // the next Plan read asks again
      return { ok: true, ...out };
    }
    if (route === '/api/stop') {
      if (data.confirm !== true) throw fail(400, 'confirm must be true');
      const r = st(p).items[String(data.run)];
      if (!r || r.kind !== 'run' || r.state !== 'running') throw fail(409, 'Run is not running. Refresh.');
      try { const ev = await stopRunAsync({ state: p.state, locksDir: o.locksDir ?? path.join(path.dirname(path.resolve(p.state)), 'locks'), run: r.id, by: 'dashboard', why: data.why ? line(data.why) : 'stopped from the dashboard' }); return { ok: true, seq: ev.seq }; }
      catch (e) { if (e instanceof RecordError) throw fail(409, e.message); throw e; }
    }
    if (route === '/api/settings') return saveSettings(p, data.changes, data.version, data.profile);
    if (route === '/api/settings/review') return reviewSettings(p, data.changes, data.version);
    if (route === '/api/audit') {   // META-TEND P5: an audit hunk card's tap - accept (a decision + the directive the check-in applies) or decline (a decision)
      if (!['accept', 'decline'].includes(data.verdict)) throw fail(400, 'verdict must be accept or decline');
      const c = auditsView(p, loadState(p.state).items).cards.find(x => x.id === data.id);
      if (!c) throw fail(409, 'That hunk is no longer open (decided already). Reload.');
      const r = await rec(p, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'audit', advisory: c.id, question: `audit hunk ${c.id} (${c.run}): ${c.path}:${c.line}`,
        choice: data.verdict === 'accept' ? 'accepted: apply the hunk' : 'declined: keep the text', why: c.why } });
      const d = data.verdict === 'accept' ? await rec(p, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text: acceptText(c).slice(0, 4000), via: 'dashboard' } }) : null;
      return { ...r, directive: d?.id ?? null };
    }
    if (route === '/api/fixall' && data.rest) {   // S7: "n left: send the fixer for the rest (m runs)" = ONE decision (lane fixall, rest_of) approving m more runs
      const items = st(p).items, d = items[String(data.rest)];
      if (!d || d.kind !== 'directive' || !d.data?.fixall || d.state !== 'active') throw fail(409, 'That Fix all is closed. Reload.');
      const u = fixUsage(p), pl = fixPlan(d, items, { batch: u.batch, readBrief: readRunBrief });
      if (pl.live || pl.next || !pl.left.length) throw fail(409, pl.live ? `The fixer run ${pl.live} is still on it.` : pl.next ? 'The approved runs are not all done yet.' : 'Nothing is left.');
      const r = await rec(p, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: FIX_LANE, rest_of: d.id, runs: pl.more, question: `Fix all ${d.id}: ${pl.left.length} finding(s) left`,
        choice: `send the fixer for the rest (${pl.more} run${pl.more === 1 ? '' : 's'})`, why: `The owner's tap approves ${pl.more} more fixer run(s): ${u.line}. Each drafts at most ${u.batch} findings; nothing lands before Apply.` } });
      return { ok: true, id: r.id, directive: d.id, runs: pl.more, left: pl.left.length };
    }
    if (route === '/api/fixresult') {   // S7 (REPORT s.3 step 4): the result card's tap - Apply all (minus skipped files) or Discard = ONE decision (+ ONE directive: the audit accept path)
      if (!['apply', 'discard'].includes(data.choice)) throw fail(400, 'choice must be apply or discard');
      const items = st(p).items, batch = fixBatch(withDefaults(settingsState(p).view).policy), c = fixCards(items, { batch, root: p.root }).find(x => x.run === String(data.run));
      if (!c) throw fail(409, 'That result is decided already. Reload.');
      if (data.choice === 'apply' && c.state !== 'ready') throw fail(409, c.state === 'declined' ? 'The fixer declined every finding: there is nothing to apply.' : 'This run drafted no hunk: there is nothing to apply.');
      const skip = (Array.isArray(data.skip) ? data.skip.map(String) : []).filter(x => c.files.some(f => f.file === x));
      const kept = c.files.filter(f => !skip.includes(f.file)).reduce((n, f) => n + f.n, 0), choice = data.choice === 'apply' && kept ? 'apply' : 'discard';
      const d = items[c.directive], pl = fixPlan(d, items, { batch, readBrief: readRunBrief }), { ids: took, open } = verdictIds(c), done = new Set([...pl.resolved, ...took]);
      const closes = d.state === 'active' && (d.data.findings || []).every(x => done.has(x));
      const r = await rec(p, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'fixall-result', directive: c.directive, run: c.run, ids: took, ...(open.length ? { open } : {}), choice, skipped_files: skip,
        question: `Fixer result ${c.run} (${c.directive}): ${c.n} hunk(s) in ${c.files.length} file(s)`, why: choice === 'apply' ? `The owner applies ${kept} hunk(s)${skip.length ? `; skipped: ${skip.join(', ')}` : ''}.` : c.state === 'declined' ? 'The fixer declined every finding with a reason: nothing to apply. Each decline stands on its finding (Slop page: accept it or re-scope).' : 'The owner discards the drafts: nothing changes.' } });
      const text = verdictText(c, { choice, skip, close: closes ? r.id : null });
      const x = text ? await rec(p, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text: text.slice(0, 4000), via: 'dashboard' } }) : null;
      return { ...r, directive: x?.id ?? null, closes };
    }
    if (route === '/api/fixdecline') {   // a declined finding's owner tap: accept the decline (the finding closes) or re-scope it (a new fix sentence: offered again)
      if (!['accept', 'rescope'].includes(data.verdict)) throw fail(400, 'verdict must be accept or rescope');
      const scope = data.verdict === 'rescope' ? line(data.scope ?? '').slice(0, 300) : null;
      if (data.verdict === 'rescope' && !scope) throw fail(400, 're-scope needs the new fix sentence (scope)');
      const r0 = (await guardOf(p)).rows.find(x => x.id === String(data.id) && x.declined);
      if (!r0) throw fail(409, 'That finding is not declined now (decided already, or it changed). Reload.');
      const r = await rec(p, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: DECLINE_LANE, finding: r0.id, run: r0.declined.run, verdict: data.verdict, ...(scope ? { scope } : {}),
        question: `${r0.id} declined by ${r0.declined.run}: ${r0.declined.why}`.slice(0, 600), choice: scope ? `re-scope: ${scope}` : 'accept the decline: close the finding',
        why: scope ? `The owner re-scopes the fix of ${r0.id} (was: ${r0.action ?? '-'}); Fix all offers it again with the new fix.` : `The owner accepts ${r0.declined.run}'s reason; the finding is closed.` } });
      return { ...r, finding: r0.id };
    }
    if (route === '/api/fixall') {   // META-UX-BUILD S6 (REPORT s.3 step 2, DIR-65 Q2 A): Send the fixer = ONE decision + ONE directive (the audit card's path) with the ids
      const g = await guardOf(p);
      if (g.pending) throw fail(409, 'The instruction-file scan is still running: reload the sheet when it lands.');
      if (data.sig !== fixSheet(g).sig) throw fail(409, 'The findings changed since the sheet was drawn. Reload it and look again.');
      let x; try { x = fixPick(g, { keys: data.keys, picks: data.picks }); } catch (e) { throw fail(e.status ?? 400, e.message); }
      const items = Object.values(st(p).items);   // the same open set sent again (a second tap): the pair it wrote, no second pair
      const was = items.find(i => i.kind === 'decision' && i.state === 'in-force' && i.data.lane === 'fixall' && i.data.set === x.set);
      const wasDir = was && items.find(i => i.kind === 'directive' && i.state === 'active' && i.data.fixall === was.id);
      if (wasDir) return { ok: true, id: was.id, directive: wasDir.id, n: x.ids.length, again: true };
      const u = fixUsage(p), ways = x.picks.map(q => `${q.key}: ${q.way} (${q.ids.length})`).join('; ');
      const r = await rec(p, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'fixall', question: `Fix all on ${p.name}: ${x.ids.length} finding(s) in ${x.batches} batch(es)`,
        choice: `send the fixer${ways ? ` - your call: ${ways}` : ''}`, why: `The owner's tap on the Fix all sheet approves ${runsFor(x.ids.length, u.batch)} fixer run(s) of at most ${u.batch} findings: ${u.line}. It drafts every change and edits nothing; a change lands only on Apply on its one result card (DIR-65 Q2 A).`,
        findings: x.ids, picks: x.picks.map(q => ({ key: q.key, way: q.way, n: q.ids.length })), usage: u.line, set: x.set, runs: runsFor(x.ids.length, u.batch), batch: u.batch } });
      const m = runsFor(x.ids.length, u.batch), head = `Fix all (${r.id}): the engine starts the fixer by code (${m} run${m === 1 ? '' : 's'} of at most ${u.batch} findings ${u.run}) on ${x.ids.length} finding(s)${ways ? `; your call: ${ways}` : ''}. A check-in never reads these ids. It drafts every change as hunks in the audit format and edits nothing; the owner applies them on one result card. Findings:`;
      const ids = []; let len = head.length;
      for (const id of x.ids) { if (len + id.length + 1 > 3900) break; ids.push(id); len += id.length + 1; }
      const text = `${head} ${ids.join(' ')}${ids.length < x.ids.length ? ` +${x.ids.length - ids.length} more (every id in ${r.id} and in this directive's findings)` : ''}`;
      const d = await rec(p, { kind: 'directive', ev: 'create', by: 'dashboard', data: { text, via: 'dashboard', findings: x.ids, fixall: r.id } });
      return { ok: true, id: r.id, directive: d.id, n: x.ids.length, again: false };
    }
    if (route === '/api/proposal') {   // RM-28 S1: a stage's pick on the proposal card = `norn proposal rule` (the decision + the act: one path)
      if (!['queue', 'later', 'drop'].includes(data.pick)) throw fail(400, 'pick must be queue, later or drop');
      if (!/^RUN-\d+$/.test(String(data.run)) || !/^S\d+$/i.test(String(data.stage))) throw fail(400, 'run must be a RUN-n and stage an S<n>');
      const r = await metaCli(['proposal', 'rule', String(data.run), String(data.stage), data.pick, '--as', 'dashboard', ...(p.file ? ['--project', p.file] : []), '--state', p.state]);
      if (r.code !== 0) { const e = cliFail(r); throw fail(/decided already/.test(e.message) ? 409 : e.status, e.message); }
      return { ok: true, lines: r.out.trim().split(/\r?\n/) };
    }
    if (route === '/api/advice') {   // META-TEND P4: the advice card's one tap - apply its Settings change, or keep the setting; both recorded
      if (!['apply', 'keep'].includes(data.verdict)) throw fail(400, 'verdict must be apply or keep');
      const c = (await adviceOf(p, true)).cards.find(x => x.key === data.key);
      if (!c) throw fail(409, 'That advice is no longer open (decided, or the numbers changed). Reload.');
      const saved = data.verdict === 'apply' ? await saveSettings(p, c.change, settingsState(p).version) : null;
      const r = await rec(p, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'advice', question: `${c.title} (${c.check})`, advice: c.key,
        choice: data.verdict === 'apply' ? `applied: ${Object.entries(c.change).map(([k, v]) => `${k} = ${v}`).join(', ')}` : 'kept the setting as it is',
        why: `${c.text} Source: ${c.source?.ref ?? '-'} read ${c.source?.read ?? '-'}. ${c.trial}.` } });
      adviceMemo.delete(p.name); costViews.clear();
      return { ...r, settings: saved };
    }
    throw fail(404, 'Not found');
  }
  // the Settings save path (the Settings tab, and the advice card's one tap with the version it read just now)
  // META-PROFILE-BUG R1: only the changed keys are written (onlyChanged); a save filled from a profile ({ name, cost }) records the
  // "caps profile" decision with the profile's values and the owner's own keys of that save (profileNow counts them)
  // META-DASH-ASYNC R1: genAfterPolicy for the server - the precondition in-process, the regeneration (installProject: a run of sync
  // writes) as the CLI child `norn gen --project` (as scanRoot runs its scan): its stdout = lines, its "error: " lines = problems
  async function genA(p) {
    const g = genWhyNot(p); if (g.not) return g.not;
    const r = await metaCli(['gen', '--project', p.file], { env: { META_ROOT: p.meta } });
    const ls = t => t.split(/\r?\n/).filter(Boolean);
    return { ran: true, problems: ls(r.err).map(l => l.replace(/^error: /, '')), lines: ls(r.out) };
  }
  async function saveSettings(p, changes, version, profile) {
    const s = settingsState(p);
    if (version !== s.version) throw fail(409, 'Settings changed elsewhere. Reload and review the diff again.');
    let values = null, prof = null;
    if (profile !== undefined) {
      if (!profile || typeof profile !== 'object' || !COSTS.includes(profile.cost)) throw fail(400, `profile must be { name, cost: ${COSTS.join(' | ')} }`);
      try { prof = getProfile(String(profile.name)); } catch (e) { throw fail(400, e.message); }
      values = profileChanges(prof, { ...profileFor(p, s), cost: profile.cost });
    }
    const asked = changes; changes = floorChanges(s.view, changes, exExtra(p)).changes;   // the worker floor: raises ride in the same save
    const updated = applySettings(s.view, changes, exExtra(p)), next = onlyChanged(s.view, changes, updated), parts = split(next), written = [];
    const was = withDefaults(s.view).policy.cadence.checkin_interval_min, now = updated.policy.cadence.checkin_interval_min;
    if (await writeBudgetAsync(o.budgetFile, s.budget, next)) written.push(o.budgetFile);
    // GAP-2: a budget change reaches the runs already queued by itself - the queue fill reads the budget in force (runs.mjs liveBudget)
    if (JSON.stringify(parts.policy) !== JSON.stringify(s.proj.policy ?? {})) { await atomicA(p.file, JSON.stringify({ ...s.proj, policy: parts.policy }, null, 2) + '\n'); written.push(p.file); }
    let decision = null;
    if (prof) {
      const own = Object.keys(asked).filter(k => !(k in values) || JSON.stringify(values[k]) !== JSON.stringify(changes[k])), from = Object.keys(asked).length - own.length;
      decision = (await rec(p, { kind: 'decision', ev: 'create', by: 'dashboard', data: { lane: 'settings', question: 'caps profile', choice: `${prof.label} (${profile.cost})`,
        why: `saved from Settings: ${from} setting(s) from the profile${own.length ? `, ${own.length} of the owner's own` : ''}`, profile: prof.name, cost: profile.cost, values, own } })).id;
    }
    return { ok: true, written, decision, regenerated: await regenerate(p, updated), gen: await genA(p), interval: now !== was ? now : null };   // DEC-362: sources, then norn gen
  }

  // a remote device's request runs inside writeOrigin (records stamp via remote:<device>); cleared when it ends (no stamp leaks into
  // later work it started). Remote off: no context at all.
  const snapped = (req, res, store) => snap.run(newSnap(), () => serve(req, res, store));
  const handler = remote ? (req, res) => { const store = { via: null }; return writeOrigin.run(store, () => snapped(req, res, store)).finally(() => { store.via = null; }); } : (req, res) => snapped(req, res, null);
  const remoteView = who => ({ on: true, trust: remote.trust, url: remote.url, hosts: remote.hosts, logins: remote.logins, devices: pairing.list(), pending: who.remote ? null : pairing.pending(), viewer: who.device?.id ?? null });
  async function unpaired(req, res, send, route, who) {   // a remote device that is not paired: the pairing page and the claim, nothing else
    if (req.method === 'GET' && route === '/') return send(200, await readA(path.join(DASH, 'pair.html')), 'text/html; charset=utf-8');
    if (req.method === 'POST' && route === '/api/remote/claim') {
      if (req.headers.origin !== who.origin) throw fail(403, 'Cross-origin request refused');
      const data = await body(req), r = pairing.claim(data.code, { name: data.name, login: who.login });
      res.setHeader('Set-Cookie', setCookie(r.cookie));
      return send(200, { ok: true, device: r.device });
    }
    throw fail(403, 'Pair this device first: on the desktop dashboard open Settings > Notifications > Reach Norn from your phone > Pair a device');
  }
  // dash-latency: the server's own timings, always on and cheap. Every answer carries Server-Timing (app = ms in this process, prime =
  // the snapshot read of a GET); a request over o.slowMs (1 s; the SSE streams excepted) and an event-loop stall over o.stallMs
  // (250 ms: every request waited that long) go to a ring of the last 100 (GET /api/timing) and <norn>/local/dash-timing.jsonl. A
  // stall names the requests that ran in its window: one of them blocked the loop (a sync build), or the box starved this process.
  const timing = { slow: [], stalls: [], recent: [], writes: Promise.resolve(), lost: 0, error: null }, STALL_TICK = 100;
  const timingFile = metaRootDir ? path.join(metaRootDir, 'local', 'dash-timing.jsonl') : null;
  const noteTiming = (k, e) => { const a = timing[k]; a.push(e); if (a.length > 100) a.shift();
    if (timingFile) timing.writes = timing.writes.then(() => fs.promises.appendFile(timingFile, JSON.stringify({ kind: k, ...e }) + '\n'))
      .catch(x => { timing.lost++; timing.error = String(x.message).slice(0, 200); }); };   // the ring keeps the entry; /api/timing says the file missed it
  let tickAt = performance.now();
  const stallTimer = setInterval(() => {
    const now = performance.now(), gap = now - tickAt - STALL_TICK; tickAt = now;
    if (gap <= (o.stallMs ?? 250)) return;
    const from = now - gap - STALL_TICK, during = timing.recent.filter(r => r.t0 <= now && (r.t1 ?? now) >= from).map(r => r.url);
    noteTiming('stalls', { at: new Date().toISOString(), ms: Math.round(gap), requests: [...new Set(during)].slice(0, 10) });
  }, STALL_TICK);
  stallTimer.unref();
  function timed(req, res) {
    const r = { url: `${req.method} ${String(req.url).slice(0, 160)}`, t0: performance.now(), t1: null, prime: null };
    timing.recent.push(r); if (timing.recent.length > 50) timing.recent.shift();
    res.on('finish', () => { r.t1 = performance.now(); const ms = r.t1 - r.t0;
      if (ms > (o.slowMs ?? 1000) && !String(res.getHeader('content-type') ?? '').startsWith('text/event-stream'))
        noteTiming('slow', { at: new Date().toISOString(), url: r.url, ms: Math.round(ms), prime: r.prime === null ? null : Math.round(r.prime), status: res.statusCode }); });
    return r;
  }
  const serve = async (req, res, store) => {
    const tr = timed(req, res);
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      res.setHeader('Server-Timing', `app;dur=${(performance.now() - tr.t0).toFixed(1)}${tr.prime === null ? '' : `, prime;dur=${tr.prime.toFixed(1)}`}`);
      res.writeHead(status, { 'content-type': type }); res.end(type.startsWith('application/json') ? JSON.stringify(data) : data); };
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const local = String(req.socket.localAddress ?? '').replace(/^::ffff:/, '');
      if (local !== '127.0.0.1') throw fail(403, 'Interface not served'); // 127.0.0.1 only: a phone comes in through the tunnel agent's local connection (C6, DEC-140 supersedes the game project's dashboard rule for this dashboard)
      const host = `127.0.0.1:${req.socket.localPort}`;
      let who = { remote: false };
      if (remote) who = classify(req.headers, remote, host);   // C6: the Host / Origin allow-list + the identity header (403s)
      else if (req.headers.host !== host) throw fail(403, 'Use the 127.0.0.1 dashboard address');
      if (!who.remote && req.headers.origin && req.headers.origin !== `http://${host}`) throw fail(403, 'Cross-origin request refused');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Cross-site request refused');
      const url = new URL(req.url, `http://${host}`), route = url.pathname;
      if (who.remote) {
        const dev = pairing.verify(cookieOf(req.headers), who.login);
        if (!dev) return await unpaired(req, res, send, route, who);
        who.device = dev; pairing.touch(dev.id); store.via = `remote:${dev.id}`;
      }
      if (req.method === 'GET') {
        if ((route.startsWith('/api/') || route === '/log') && !NO_STATE.test(route)) {   // the snapshot of the projects this GET reads (fs.promises, concurrently)
          const want = url.searchParams.get('project') ?? firstP()?.name, t = performance.now();
          await primeFor(route === '/api/projects' || want === 'all' ? projects : projects.filter(x => x.name === want));
          tr.prime = performance.now() - t;
        }
        if (route === '/api/timing') return send(200, { slow: timing.slow, stalls: timing.stalls, slow_ms: o.slowMs ?? 1000, stall_ms: o.stallMs ?? 250, file: timingFile, file_lost: timing.lost, file_error: timing.error });
        if (route === '/') return send(200, (await readA(path.join(DASH, 'index.html'))).replace('__TOKEN__', JSON.stringify(token)).replace('__REMOTE__', JSON.stringify(who.device ? { device: who.device.id, name: who.device.name } : null)), 'text/html; charset=utf-8');
        if (route === '/api/remote' && remote) return send(200, remoteView(who));
        if (route === '/ui.mjs' || route === '/docs.mjs' || route === '/prose.mjs' || route === '/ledger.mjs' || route === '/adopt.mjs' || route === '/home.mjs' || route === '/widgets.mjs' || route === '/insparts.mjs' || route === '/subviews.mjs' || route === '/terms.mjs' || route === '/guardparts.mjs' || route === '/docparts.mjs' || route === '/activity.mjs' || route === '/testparts.mjs' || route === '/diffview.mjs') return send(200, await readA(path.join(DASH, route.slice(1))), 'text/javascript; charset=utf-8');
        const vm = route.match(/^\/vendor\/([a-z0-9.-]+)$/);   // pinned browser libraries + font (vendor/VENDOR.md), allowlist only
        if (vm && VENDOR.includes(vm[1])) return send(200, await fs.promises.readFile(path.join(DASH, 'vendor', vm[1])), typeOf(vm[1]));
        const nm = route.match(/^\/norn\/([a-z.]+)$/);   // the Norn look's modules + stylesheet, allowlist only
        if (nm && NORN.includes(nm[1])) return send(200, await readA(path.join(DASH, 'norn', nm[1])), typeOf(nm[1]));
        if (route === '/norn/assets.json') { const has = await Promise.all(ART_FILES.map(f => existsA(path.join(ART, f)))); return send(200, { present: ART_FILES.filter((f, i) => has[i]).map(f => f.replace(/\.png$/, '')) }); }
        const am = route.match(/^\/norn\/art\/([a-z0-9-]+\.png)$/);   // the owner's art pick, by the asset map's file names only
        if (am && ART_FILES.includes(am[1]) && await existsA(path.join(ART, am[1]))) return send(200, await fs.promises.readFile(path.join(ART, am[1])), 'image/png');
        if (route === '/api/projects') { await reloadProjectsA(); const needs = await Promise.all(projects.map(needsOf)); return send(200, { projects: projects.map((p, i) => ({ name: p.name, title: p.title ?? p.name, needs: needs[i] })) }); }   // needs: the Home's pick order
        if (route === '/api/adopt/repos') return send(200, { repos: await reposNear() });
        if (route === '/api/adopt') return send(200, await adoptView(one(url)));
        if (route === '/api/overview') return send(200, await overview(pick(url, { all: true })));
        if (route === '/api/inbox') { const ps = pick(url, { all: true }), per = await Promise.all(ps.map(inbox)), items = per.flat();
          const prose = Object.fromEntries(await Promise.all(ps.map(async (p, i) => [p.name, await proseOf(p, per[i])])));
          return send(200, { items, needs_you: needsYou(items), prose }); }
        if (route === '/api/lanes') { const ps = pick(url, { all: true }); await primeBriefs(ps); const rows = lanesWithSpend(ps);
          const by = new Map((await Promise.all(ps.map(p => withCards(p, rows.filter(l => l.project === p.name))))).flat().map(l => [`${l.project}|${l.name}`, l]));
          return send(200, { lanes: rows.map(l => by.get(`${l.project}|${l.name}`)), backlog: backlogOf(ps) }); }
        if (route === '/api/agents') {   // ?window= 2h (default) | 12h | 24h | today: how long ended runs stay in the tree
          const w = url.searchParams.get('window') ?? '2h'; if (!RUN_WINDOWS.includes(w)) throw fail(400, `window must be one of ${RUN_WINDOWS.join(', ')}`);
          const ps = pick(url, { all: true }), win = windowMs(w);
          return send(200, { window: w, tree: (await Promise.all(ps.map(p => agents(p, win, { homes: true })))).flat(), queue: ps.flatMap(p => queueOf(runsOf(st(p))).map(q => ({ ...q, project: p.name }))) });
        }
        if (route === '/api/map') return send(200, await map(one(url), url));
        if (route === '/api/deliverables') {
          const ps = pick(url, { all: true }), vs = ps.map(deliverablesOf);   // RM-46 S3: + the other homes' DLVs (read-only copies)
          const away = (await Promise.all(ps.map(async p => (await copyItemsAsync(p.state, 'deliverable')).map(it => ({ ...dlvCopyRow(it), project: p.name }))))).flat();
          return send(200, { rows: [...vs.flatMap(v => v.rows), ...away], pending: vs.some(v => v.pending), error: vs.map(v => v.error).filter(Boolean).join('; ') || null, install: vs[0]?.install ?? null, git: vs.map(v => v.git ?? null) });
        }
        if (route === '/api/records') return send(200, records(one(url), url));
        if (route === '/api/roadmap') return send(200, await roadmapOf(one(url)));
        if (route === '/api/handedit/diff') {   // RM-35: last written by Norn vs now, for the diff viewer
          try { return send(200, await handEditDiff(one(url).state, url.searchParams.get('file') || '')); } catch (e) { if (e.code === 409) throw fail(409, e.message); throw e; }
        }
        if (route === '/api/usage') return send(200, usageView(pick(url, { all: true }), url));
        if (route === '/api/plan') return send(200, { parts: pick(url, { all: true }).map(planOf) });
        if (route === '/api/docs') { const p = one(url), kp = docKeyPath(p, url.searchParams.get('file') ?? ''); if (kp) await prime({ files: [kp] }); return send(200, docsAt(p, url)); }   // META-UX-BUILD S3
        if (route === '/api/instructions') return send(200, insOf(one(url), url));
        if (route === '/api/guard') return send(200, await guardAt(one(url), url));   // META-TEND P6
        if (route === '/api/tests') return send(200, await testsAt(one(url), url));   // META-TEND TESTS; TESTS-RUNTIME: the summary or one sub-view's part
        if (route === '/api/tests/source') return send(200, await testSource(one(url), url));   // TESTS-RUNTIME: the code viewer
        const im = route.match(/^\/api\/instructions\/([\w-]+)$/);
        if (im) return send(200, insFile(one(url), im[1]));
        if (route === '/api/ledger') return send(200, await ledgerPage(one(url), url));
        if (route === '/api/settings') return send(200, settingsInfo(one(url)));
        if (route === '/api/feed') return await openFeed(req, res, url);
        if (route === '/api/stream') return await openStream(req, res, url);
        if (route === '/api/sessions') return send(200, { sessions: await sessions.list() });
        if (route === '/api/home') return send(200, await homeOf(one(url)));
        if (route === '/api/file') { const r = await fileOf(one(url), url); return send(200, r.data, r.type); }
        if (route === '/api/chat') {
          const p = one(url), last = req.headers['last-event-id'];
          await drainChatA(p);
          const from = Math.max(0, (last ? Number(last) + 1 : Number(url.searchParams.get('from'))) || 0);
          if (url.searchParams.get('live') === '1') return await openChat(p, res, from);
          return send(200, { project: p.name, ...readThread(p.state, from), status: chatStatus(p) });
        }
        if (route.startsWith('/api/sessions/')) return send(200, await sessions.transcript(decodeURIComponent(route.slice(14)), Math.max(0, Number(url.searchParams.get('from')) || 0)));
        if (route === '/log') {
          const p = one(url), r = st(p).items[url.searchParams.get('run') ?? ''];
          const f = r?.kind === 'run' ? r.data.log : null, logs = path.resolve(p.state, 'logs');
          if (!f || path.dirname(path.resolve(f)).toLowerCase() !== logs.toLowerCase() || !(await existsA(f))) throw fail(404, 'Log not found');
          // the live hand-off state first (lanes.mjs handoffOf): the log's last line is the old session's, not where the run is now
          const h = hoOf(p, r), top = h ? `[norn] ${h.text}${h.run !== r.id ? ` (${h.run})` : ''}\n` : '';
          return send(200, top + (await tail(f, 200)).join('\n') + '\n', 'text/plain; charset=utf-8');
        }
        throw fail(404, 'Not found');
      }
      if (req.method !== 'POST') throw fail(405, 'Method not allowed');
      if (req.headers['x-dash-token'] !== token) throw fail(403, 'Missing dashboard token. Reload the page.');
      if (who.device) {   // C6: a paired phone's write names its Origin (CSRF) and is rate-limited per device
        if (req.headers.origin !== who.origin) throw fail(403, 'Cross-origin request refused');
        const now = Date.now(), w = writes.get(who.device.id);
        if (!w || now - w.t >= 60000) writes.set(who.device.id, { t: now, n: 1 });
        else if (++w.n > postsPerMin) throw fail(429, 'Too many writes from this device: wait a minute');
      }
      const data = await body(req);
      if (remote && route === '/api/remote/pair') { if (who.remote) throw fail(403, 'A pairing code is made on the desktop only'); return send(200, pairing.open()); }
      if (remote && route === '/api/remote/revoke') { if (typeof data.id !== 'string' || !pairing.revoke(data.id)) throw fail(404, 'No such device'); return send(200, { ok: true }); }
      if (route === '/api/ask') {
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 8000) throw fail(400, 'text is required (maximum 8000 characters)');
        return send(200, await ask(projectOf(data), data.text.trim()));
      }
      // META-DASH-ASYNC R1: a chat POST answers once its thread lines are on disk (the thread's write queue, lib/chat.mjs)
      const sendT = async v => { await threadFlushed(projectOf(data).state); send(200, v); };
      if (route === '/api/chat/approve') {   // C3: an approval card's button (Approve once / Deny), as the owner - no model in between
        if (typeof data.id !== 'string' || !['approve', 'deny'].includes(data.verdict)) throw fail(400, 'id and verdict (approve | deny) are required');
        try { return sendT({ ok: true, ...chatOf(projectOf(data)).decide(data.id, data.verdict, { via: store?.via }) }); } catch (e) { throw actFail(e); }
      }
      if (route === '/api/chat/undo') return sendT(await chatUndo(projectOf(data), data.line));
      // META-CHAT-CONTROLS R1: the picker - this chat's model / effort from the next turn (null = back to the Settings row) ...
      if (route === '/api/chat/pick') {
        const v = {}; for (const k of ['model', 'effort']) if (data[k] !== undefined) { if (data[k] !== null && typeof data[k] !== 'string') throw fail(400, `${k} must be a string or null`); v[k] = data[k]; }
        try { return sendT({ ok: true, status: chatOf(projectOf(data)).pick(v) }); } catch (e) { if (e.status) throw fail(e.status, e.message); throw e; }
      }
      // ... and "make this the default": the pick becomes the Settings rows chat_model / chat_effort (one source of truth), the pick is cleared
      if (route === '/api/chat/default') {
        const p = projectOf(data), c = chatOf(p), st0 = c.status();
        const r = await saveSettings(p, { chat_model: st0.model, chat_effort: st0.effort }, settingsState(p).version);
        return sendT({ ...r, status: c.pick({ model: null, effort: null }) });
      }
      if (route === '/api/chat/send') {
        if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 8000) throw fail(400, 'text is required (maximum 8000 characters)');
        return sendT(chatOf(projectOf(data)).send(data.text, { via: store?.via }));
      }
      if (route === '/api/sessions') {
        if (data.kind !== 'controller' || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 8000) throw fail(400, 'kind "controller" and text (1-8000 characters) are required');
        return send(200, await startController(projectOf(data), data.text.trim()));
      }
      const sm = route.match(/^\/api\/sessions\/([a-z0-9-]+)\/(send|stop)$/);
      if (sm) {
        if (sm[2] === 'send') { if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 8000) throw fail(400, 'text is required (maximum 8000 characters)'); return send(200, await sessions.send(sm[1], data.text.trim())); }
        if (data.confirm !== true) throw fail(400, 'confirm must be true'); return send(200, sessions.stop(sm[1]));
      }
      if (route === '/api/adopt/scan') {   // META-ADOPT A3: the free look (writes nothing): facts + the interview + the project it already is
        const root = str(data.root, 'root', 1000);
        const facts = await scanRoot(root, { fresh: true });
        const pick = readExecutor(null);
        return send(200, { facts, interview: interviewOf(facts), registered: projectAt(facts.root ?? root),
          consent: { ...pick, cap_min: 15, line: consentLine(pick).replace(/. Choose --read.*$/, '') } });
      }
      if (route === '/api/notify-test') {
        const p = projectOf(data), n = machine.notify;
        if (!n || n.backend === 'none') throw fail(409, 'Notifications are off on this machine: turn them on with norn setup --notify ntfy');
        try { return send(200, await sendNotice({ title: 'Norn test ping', body: `A test from the dashboard (${p.name}).`, machine, state: p.state, transport: o.notifyTransport ?? notifyTransport })); }
        catch (e) { throw fail(e.code === 2 ? 409 : 502, e.message); }
      }
      if (route === '/api/checkin') {
        const p = projectOf(data);
        if (stopsCheckins(pauseOfP(p))) throw fail(409, 'Check-ins are paused. Resume them first.');
        if (lockFresh(p) || checkinStarting) throw fail(409, 'A check-in is already running or starting.');
        checkinStarting = true;
        try { return send(200, await platform.tick(p)); } finally { const t = setTimeout(() => { checkinStarting = false; }, 5000); t.unref(); }
      }
      const result = await serial(async () => {
        const r = await post(route, data);
        if (route === '/api/settings' && r.interval !== null) { try { r.schedule = await platform.setInterval(r.interval); } catch (e) { r.schedule = { ok: false, error: e.message }; } }
        else if (route === '/api/settings') r.schedule = null;
        return r;
      });
      send(200, result);
    } catch (e) { if (!res.headersSent) send(e.status ?? 500, { error: e.message, ...(e.body || {}) }); else res.end(); }
  };
  const server = http.createServer(handler);
  server.requestTimeout = 300000; server.headersTimeout = 15000;
  // close also stops a running account refresh and instructions rebuilds: their workers write the state-dir cache, so a caller
  // that removes the state after close (the test fixtures' temp dirs) never races them (ENOTEMPTY under load)
  // RM-46 S4 (multi-home SPEC 4.3): the sync loop - ls-remote every 30 s + the optional doorbell; its publish and pass run as norn CLI
  // children (metaCli), so this event loop never blocks. Off without machine.json ledger.remote; the loop itself idles until a project is synced
  const syncCfg = machineFile ? ledgerConfig(machine, { metaRoot: metaRootDir, machineFile }) : null;
  const syncL = syncCfg?.remote ? loopOf(syncCfg, { cli: args => metaCli(args) }) : null;
  syncL?.start();
  const close = async () => { syncL?.stop(); sessions.stopAll(); feeds.close(); streams.close(); clearInterval(stallTimer); await timing.writes;
    for (const r of chatStreams) r.end();
    await Promise.all([...chats.values()].map(c => c.close())); if (acct.worker) await acct.worker.terminate().catch(() => {});
    await Promise.all([...insWorkers].map(w => w.terminate()));
    return new Promise(r => { if (!server.listening) return r(); server.close(r); server.closeIdleConnections(); }); };
  return { server, token, sessions, feeds, streams, close, staleMs: STALE_MS, accountRefresh: () => acct.running || accountRefresh() };
}
