// META-GTP-MAIL (GT-PARITY-PLAN sec. 2.7): agent mail for headless workers. The record kind lives in records.mjs (MAIL-n,
// mail.jsonl); this module reads it and does the delivery. Gas Town (cited, not ported): `gt mail check --inject` from a hook
// (internal/hooks/config.go:1085-1092; internal/cmd/mail_check.go:75-99). Headless `claude -p` has no prompt to hook, so the
// delivery is (a) a PostToolUse hook (the next tool round), (b) the MCP tool norn_mail + one headless line for executors without
// hooks, (c) the nudge (supervisor.mjs). Every path takes a mail through ONE deliver event (records.mjs: the compare-and-set).
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { record, readEvents, recordsFile, fold, loadShared, RecordError, mailboxOf, homeOf, roleAddr, idNum as num, MAIL_BODY_MAX, homeOfId } from './records.mjs';
import { hookEntry } from './rustbin.mjs';
import { readJsonS } from './fsnap.mjs';
const fwd = p => String(p).replace(/\\/g, '/');
const drop = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

// RM-46 S1d (SPEC 4.6): in a synced dir the merged mail - a home delivers what is addressed to it, whichever home sent it
export const loadMail = state => loadShared(state, 'mail').items;
const loadRuns = state => fold(readEvents(recordsFile(state, 'run'))).items;

// A home-less role / lane address (role:controller, lane:x) is qualified with a home: what a writer types means its OWN home (a
// mail home b's check-in sends to role:controller is for home b's controller), while a bare address already stored in a log keeps
// its legacy meaning, bare_home (records.mjs primaryOf). Run ids and addresses that name a home pass unchanged; no home = unchanged.
export function qualify(to, h) {
  const t = String(to ?? '');
  if (!h) return t;
  if (/^role:[a-z]+$/.test(t)) return `${t}@${h}`;
  if (/^lane:[^/]+$/.test(t)) return `lane:${h}/${t.slice(5)}`;
  return t;
}
const stored = (state, m) => qualify(m.data.to, homeOf(state)?.bare_home ?? null);
const byId = (a, b) => num(a.id) - num(b.id);

/**
 * the role a process speaks as: a supervised run (META_RUN_ID) = worker, or checkin when its RUN record is a check-in - from the
 * record, not META_ROLE, which a worker inherits from the check-in that dispatched it; no run = the controller's session (or `as`)
 */
export function mailRole(state, env, as) {
  if (env.META_RUN_ID) return loadRuns(state)[env.META_RUN_ID]?.data.kind === 'checkin' ? 'checkin' : 'worker';
  return as || (env.META_ROLE === 'checkin' ? 'checkin' : 'controller');
}

/** create MAIL-n from `by` (worker: from = its run; checkin / controller: from = role:<by>, role:<by>@<home> in a home); returns the envelope */
export function sendMail(state, { by, run = null, to: typed, subject, body: typedBody, body_file: typedFile, urgent }) {
  const home = homeOf(state), to = qualify(typed, home?.id);
  const { body, body_file } = inlineBody(typedBody, typedFile, home && addrHome(to, home.bare_home) !== home.id);
  const from = by === 'worker' ? run : roleAddr(by, state);
  const e = record(state, { kind: 'mail', ev: 'create', by, data: drop({ from, to, subject, body, body_file, urgent: urgent ? true : undefined }) }, { run });
  flagRecipients(state, e.data.to);
  return e;
}

// A body_file is a path on the sender's machine: another home cannot read it. A file that fits the body limit goes in as the body
// (every home reads it); a longer one stays a path for this home's own readers and is refused for another home's address.
const addrHome = (to, bare) => (/^role:/.test(to) ? to.match(/@([a-z][a-z0-9]{0,15})$/)?.[1] ?? bare : /^lane:/.test(to) ? to.slice(5).match(/^([a-z][a-z0-9]{0,15})\//)?.[1] ?? bare : homeOfId(to, bare));
function inlineBody(body, body_file, remote) {
  if (body_file === undefined || body_file === null) return { body, body_file };
  const text = fs.readFileSync(body_file, 'utf8');
  if (Buffer.byteLength(text, 'utf8') <= MAIL_BODY_MAX) return { body: text, body_file: undefined };
  if (remote) throw new RecordError(`body_file is ${Buffer.byteLength(text, 'utf8')} bytes: mail to another home carries its body inline (at most 2 KB) - shorten it`, 2);
  return { body, body_file };
}

// ---------- hook-fast S1 (Q-b-46 ruling "flag"): <state>/mail/flag/<RUN-n> = the mail hook has something for the run (a queued mail, a
// context order). norn-hook (rustbin.mjs) starts Node only while it exists. Raised AFTER the record is written: a crash between the
// two leaves a record with no flag, and the run's supervisor raises it at its next beat (mailWaiting). The hook clears it BEFORE it
// reads (norn mail check --inject), so a mail that lands during the read raises it again and is not left waiting. ----------
export const flagFile = (state, run) => path.join(state, 'mail', 'flag', run);
export function raiseFlag(state, run) { fs.mkdirSync(path.dirname(flagFile(state, run)), { recursive: true }); fs.writeFileSync(flagFile(state, run), ''); }
export const clearFlag = (state, run) => fs.rmSync(flagFile(state, run), { force: true });
/** raise the flag of every running run whose mailbox takes `to` (a run id, lane:L, role:checkin: records.mailboxOf) */
export function flagRecipients(state, to) {
  const runs = loadRuns(state), home = homeOf(state)?.id;
  for (const r of Object.values(runs)) if (r.state === 'running' && mailboxOf(runs, r.id, home).has(qualify(to, home))) raiseFlag(state, r.id);
}
/** a queued mail waits in run's mailbox: the supervisor's beat raises the flag for mail no sender flagged (another home's, synced in) */
export function mailWaiting(state, run) {
  const box = boxOf(state, { run });
  return Object.values(loadMail(state)).some(m => m.state === 'queued' && box.has(stored(state, m)));
}

/** the addresses a reader takes mail for: a run's mailbox (records.mailboxOf), or one address (the controller's role:controller) */
export function boxOf(state, { run, to }) {
  if (run) return mailboxOf(loadRuns(state), run, homeOf(state)?.id);
  return new Set(to ? [qualify(to, homeOf(state)?.id)] : []);
}

const bodyOf = m => {
  if (m.data.body !== undefined) return m.data.body;
  try { return fs.readFileSync(m.data.body_file, 'utf8'); } catch { return `(body_file ${fwd(m.data.body_file)} is missing)`; }
};

/**
 * Deliver every queued mail of the reader's box, oldest first: one deliver event per mail. A mail another reader took between
 * the read and the write is refused by the state machine (queued -> delivered happens once) and is not this reader's: it was
 * delivered there. Returns the mails this call delivered, with their text. before (ms, HOME-MAIL S2): only mail created before it (a
 * check-in's take of controller mail); got.left = the queued mail of the box it left, { id, age_min } at now.
 */
export function checkMail(state, { by, run = null, to, via, before = Infinity, now = Date.now() }) {
  const box = boxOf(state, { run, to });
  const got = [], queued = Object.values(loadMail(state)).filter(x => x.state === 'queued' && box.has(stored(state, x))).sort(byId);
  got.left = queued.filter(m => !(Date.parse(m.created) < before)).map(m => ({ id: m.id, age_min: ageMin(m, now) }));
  for (const m of queued.filter(x => Date.parse(x.created) < before)) {
    try { record(state, { kind: 'mail', ev: 'deliver', id: m.id, by, data: drop({ run, via }) }, { run }); }
    catch (e) {
      if (e instanceof RecordError && e.code === 2 && loadMail(state)[m.id]?.state !== 'queued') continue;   // taken by another reader
      throw e;
    }
    got.push({ ...m, text: bodyOf(m) });
  }
  return got;
}

// ---------- NORN-MAIL-WAIT: `norn mail wait`, the controller session's blocking read (a run is woken by its hook, a check-in never blocks) ----------
export const MAIL_WAIT_POLL_S = 10;   // one look at the box (and the stale fetch) per this many seconds while nothing came
/**
 * Deliver the reader's queued mail through checkMail; none queued = wait for it: each round sleeps one poll, runs `fetch` (the CLI: the
 * tick's stale fetch, sync.mjs tickFetch; null = a home with no sync) and looks again. Ends with the round's mail, or [] once timeoutMin
 * (null = never) has passed on `now`. now / sleep (ms -> promise) / fetch are passed in: the CLI's real ones, a test's fakes.
 */
export async function waitMail(state, { by, to, timeoutMin = null, now = Date.now, sleep, fetch = null, pollS = MAIL_WAIT_POLL_S }) {
  const end = timeoutMin === null ? Infinity : now() + timeoutMin * 60000, take = () => checkMail(state, { by, to, via: 'cli', now: now() });
  let got = take();
  while (!got.length && now() < end) {
    await sleep(Math.min(pollS * 1000, end - now()));
    if (fetch) await fetch();
    got = take();
  }
  return [...got];   // the mail only: checkMail's got.left is a check-in's take, not the controller's
}

export function ackMail(state, { by, run = null, id }) {
  return record(state, { kind: 'mail', ev: 'ack', id, by, data: {} }, { run });
}

// HOME-MAIL S1 (REPORT 3.1): where a queued mail this home sent to another home is, from that home's receipt (its seen.json, copied to
// homes/<h>/seen.json): "sent" (not held there yet) or "at <h>", each with when <h> last polled; no receipt (a home on an older version) =
// "unknown". Any other mail - local, received, or taken by its reader (delivered / acked) - is where its state says.
function whereOf(state, home, m, seenOf) {
  const dest = home ? addrHome(stored(state, m), home.bare_home) : null;
  if (m.state !== 'queued' || !dest || dest === home.id || homeOfId(m.id, home.bare_home) !== home.id) return m.state;
  const seen = seenOf(dest);
  if (!seen) return `sent, ${dest} unknown`;
  const held = seen.held?.[home.id]?.['mail.jsonl'], seq = m.history?.[0]?.seq, polled = `${dest} last polled ${seen.polled_at ?? 'unknown'}`;
  return Number.isInteger(held) && Number.isInteger(seq) && held >= seq ? `at ${dest}, ${polled}` : `sent, ${polled}`;
}

/** rows for `norn mail list`: { id, state, from, to, subject, urgent, created, delivered_to, nudged, body, where, age_min (at now, ms) } */
export function listMail(state, { to, open, now = Date.now() } = {}) {
  const home = homeOf(state), want = to ? qualify(to, home?.id) : null, seen = new Map();
  const seenOf = h => { if (!seen.has(h)) seen.set(h, readJsonS(path.join(state, 'homes', h, 'seen.json'))); return seen.get(h); };
  return Object.values(loadMail(state)).filter(m => (!want || stored(state, m) === want) && (!open || m.state !== 'acked')).sort(byId)
    .map(m => ({ id: m.id, state: m.state, from: m.data.from, to: m.data.to, subject: m.data.subject, urgent: !!m.data.urgent, created: m.created,
      ...(m.deliver?.run ? { delivered_to: m.deliver.run } : {}), ...(m.nudge ? { nudged: m.nudge.run } : {}),
      body: bodyOf(m), where: whereOf(state, home, m, seenOf), age_min: ageMin(m, now) }));
}
const ageMin = (m, now) => Math.max(0, Math.floor((now - Date.parse(m.created)) / 60000));

// ---------- HOME-MAIL S2 (REPORT 3.2): pickup - mail for this home's controller is put in front of a reader ----------
export const CHECKIN_TAKE_MIN = 15;   // policy mail.checkin_take_min (DEC-a-581): a check-in takes controller mail older than this
/** the digest's rows: each mail for this home's controller not acked yet, oldest first: { id, state, from, subject, urgent, age_min } */
export function controllerMail(state, { now = Date.now() } = {}) {
  const box = boxOf(state, { to: 'role:controller' });
  return Object.values(loadMail(state)).filter(m => m.state !== 'acked' && box.has(stored(state, m))).sort(byId)
    .map(m => ({ id: m.id, state: m.state, from: m.data.from, subject: m.data.subject, urgent: !!m.data.urgent, age_min: ageMin(m, now) }));
}
// <state>/mail/noticed.json = the ids of the urgent arrivals already told to the owner; holds only mail still queued (a taken one never
// returns to queued), so the file stays small. Written only when it changes.
const noticedFile = state => path.join(state, 'mail', 'noticed.json');
/**
 * The fetch's arrival step: each urgent mail another home sent this home's controller, still queued and not told yet, is one notice
 * { title, body } (the caller sends it: notify, class alert); a later call never returns it again. A solo dir has no arrivals: [].
 */
export function arrivalNotices(state) {
  const home = homeOf(state);
  if (!home) return [];
  const box = boxOf(state, { to: 'role:controller' }), had = readJsonS(noticedFile(state)) || [];
  const urgent = Object.values(loadMail(state)).filter(m => m.state === 'queued' && m.data.urgent === true && box.has(stored(state, m)) && homeOfId(m.id, home.bare_home) !== home.id).sort(byId);
  const fresh = urgent.filter(m => !had.includes(m.id)), keep = urgent.map(m => m.id);
  if (JSON.stringify(keep) !== JSON.stringify(had)) { fs.mkdirSync(path.dirname(noticedFile(state)), { recursive: true }); fs.writeFileSync(noticedFile(state), JSON.stringify(keep)); }
  return fresh.map(m => ({ id: m.id, title: `URGENT mail ${m.id} for ${roleAddr('controller', state)} from ${m.data.from}`,
    body: `${m.data.subject}\n${String(bodyOf(m)).slice(0, 400)}\n(read it: norn mail check, then norn mail ack ${m.id})` }));
}

export const formatMail = m => `${m.id} from ${m.data.from}${m.data.urgent ? ' URGENT' : ''}: ${m.data.subject}\n${String(m.text ?? bodyOf(m)).replace(/\s+$/, '')}\n(ack it: norn mail ack ${m.id}, or norn_mail ack)`;

/** the PostToolUse hook's stdout: the delivered mail as additionalContext (Claude Code hook JSON); '' = nothing to say */
export function injectJson(mails, order = '') {
  if (!mails.length && !order) return '';
  const mail = mails.length ? `MAIL for you (${mails.length}; delivered by meta between your tool calls):\n\n${mails.map(formatMail).join('\n\n')}` : '';
  const additionalContext = [order, mail].filter(Boolean).join('\n\n');   // META-CTX-ENFORCE R1: a context order (ctxlimit.mjs) goes first
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } });
}

// ---------- piece 3: NUDGE (Gas Town internal/cmd/nudge.go:49-68,267-291 + internal/nudge/queue.go:68-92, cited: they type into an
// idle tmux pane or queue with DeliverAfter; a headless run has no pane, so the supervisor stops its tree and resumes its session) ----------
export const NUDGE_AFTER_MIN = 10;   // policy mail.nudge_after_min; 0 = off
const firstLine = f => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; } };
/**
 * The urgent mail of `run`'s mailbox that is due a nudge at `now` (ms): not acked, never nudged, older than afterMin minutes; oldest
 * first. { mail } = nudge now; { mail, wait } = QUIET exists or the GPU lock file is held (the run waits); null = nothing due.
 * The GPU lock (gpu_lock.ps1 GPU.lock, first line "<holder> <time>") names a free-text holder, not a run: any held lock waits.
 */
export function nudgeDue(state, { run, now = Date.now(), afterMin = NUDGE_AFTER_MIN, quiet, gpuLock }) {
  if (!(Number(afterMin) > 0)) return null;
  const box = boxOf(state, { run });
  const due = Object.values(loadMail(state)).filter(m => m.data.urgent === true && m.state !== 'acked' && !m.nudge && box.has(m.data.to)
    && now - Date.parse(m.created) >= Number(afterMin) * 60000).sort(byId);
  if (!due.length) return null;
  if (quiet && fs.existsSync(quiet)) return { mail: due[0], wait: 'QUIET' };
  if (gpuLock && fs.existsSync(gpuLock)) return { mail: due[0], wait: `GPU lock held (${firstLine(gpuLock) || fwd(gpuLock)})` };
  return { mail: due[0] };
}
/** the resumed session's prompt: the mail itself, and how to go on */
export const nudgePrompt = (m, afterMin = NUDGE_AFTER_MIN) => `NUDGE: an urgent mail was not acked within ${afterMin} min, so meta stopped your run and resumed `
  + `this same session for you to read it now.\n\n${formatMail({ ...m, text: bodyOf(m) })}\n\nAct on it and ack it (norn mail ack ${m.id}), then continue `
  + 'your brief from where you were stopped: re-check the worktree HEAD + git status first (a tool call may have been cut off). End with `norn done` as before.';

// proc-hygiene (D: two `mail check --inject` hooks hung for a day): the hook ends in bounded time whatever blocks it. A timer cannot
// - a lock wait (records.withLock) blocks the event loop - so a worker thread kills the whole process at HOOK_MAX_MS (well inside
// the hook's 30 s in mailSettings: Claude Code's own timeout kills the shell, not this node). NORN_HOOK_MAX_MS overrides (tests).
export const HOOK_MAX_MS = 20000;
export function hookWatchdog(ms = Number(process.env.NORN_HOOK_MAX_MS) || HOOK_MAX_MS) {
  const w = new Worker(`const { workerData: d } = require('node:worker_threads'); setTimeout(() => {
    try { require('node:fs').writeSync(2, 'norn mail check --inject: no answer in ' + d.ms + ' ms, ended\\n'); } catch { /* stderr gone: the kill below still ends the hook */ }
    process.kill(d.pid, 'SIGKILL'); }, d.ms);`, { eval: true, workerData: { ms, pid: process.pid } });
  w.unref();
  return w;
}

/** the PostToolUse hook the launcher adds: norn-hook, which runs `norn mail check --inject` only while the run's flag is up */
export const mailHook = state => hookEntry('mail', state);
