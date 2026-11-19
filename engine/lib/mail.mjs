// META-GTP-MAIL (GT-PARITY-PLAN sec. 2.7): agent mail for headless workers. The record kind lives in records.mjs (MAIL-n,
// mail.jsonl); this module reads it and does the delivery. Gas Town (cited, not ported): `gt mail check --inject` from a hook
// (internal/hooks/config.go:1085-1092; internal/cmd/mail_check.go:75-99). Headless `claude -p` has no prompt to hook, so the
// delivery is (a) a PostToolUse hook (the next tool round), (b) the MCP tool norn_mail + one headless line for executors without
// hooks, (c) the nudge (supervisor.mjs). Every path takes a mail through ONE deliver event (records.mjs: the compare-and-set).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { record, readEvents, recordsFile, fold, RecordError, mailboxOf, homeOf, roleAddr, idNum as num } from './records.mjs';

export const META_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'norn.mjs');
const fwd = p => String(p).replace(/\\/g, '/');
const drop = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const loadMail = state => fold(readEvents(recordsFile(state, 'mail'))).items;
const loadRuns = state => fold(readEvents(recordsFile(state, 'run'))).items;
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
export function sendMail(state, { by, run = null, to, subject, body, body_file, urgent }) {
  const from = by === 'worker' ? run : roleAddr(by, state);
  return record(state, { kind: 'mail', ev: 'create', by, data: drop({ from, to, subject, body, body_file, urgent: urgent ? true : undefined }) }, { run });
}

/** the addresses a reader takes mail for: a run's mailbox (records.mailboxOf), or one address (the controller's role:controller) */
export function boxOf(state, { run, to }) {
  if (run) return mailboxOf(loadRuns(state), run, homeOf(state)?.id);
  return new Set(to ? [to] : []);
}

const bodyOf = m => {
  if (m.data.body !== undefined) return m.data.body;
  try { return fs.readFileSync(m.data.body_file, 'utf8'); } catch { return `(body_file ${fwd(m.data.body_file)} is missing)`; }
};

/**
 * Deliver every queued mail of the reader's box, oldest first: one deliver event per mail. A mail another reader took between
 * the read and the write is refused by the state machine (queued -> delivered happens once) and is not this reader's: it was
 * delivered there. Returns the mails this call delivered, with their text.
 */
export function checkMail(state, { by, run = null, to, via }) {
  const box = boxOf(state, { run, to });
  const got = [];
  for (const m of Object.values(loadMail(state)).filter(x => x.state === 'queued' && box.has(x.data.to)).sort(byId)) {
    try { record(state, { kind: 'mail', ev: 'deliver', id: m.id, by, data: drop({ run, via }) }, { run }); }
    catch (e) {
      if (e instanceof RecordError && e.code === 2 && loadMail(state)[m.id]?.state !== 'queued') continue;   // taken by another reader
      throw e;
    }
    got.push({ ...m, text: bodyOf(m) });
  }
  return got;
}

export function ackMail(state, { by, run = null, id }) {
  return record(state, { kind: 'mail', ev: 'ack', id, by, data: {} }, { run });
}

/** rows for `norn mail list`: { id, state, from, to, subject, urgent, created, delivered_to, nudged } */
export function listMail(state, { to, open } = {}) {
  return Object.values(loadMail(state)).filter(m => (!to || m.data.to === to) && (!open || m.state !== 'acked')).sort(byId)
    .map(m => ({ id: m.id, state: m.state, from: m.data.from, to: m.data.to, subject: m.data.subject, urgent: !!m.data.urgent, created: m.created,
      ...(m.deliver?.run ? { delivered_to: m.deliver.run } : {}), ...(m.nudge ? { nudged: m.nudge.run } : {}) }));
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

/** the hook command line the launcher adds (claude runs hook commands in Git Bash / sh: $META_RUN_ID expands there; the CLI falls back to the env) */
export const hookCommand = state => `"${fwd(process.execPath)}" "${fwd(META_BIN)}" mail check --inject --run $META_RUN_ID --state "${fwd(path.resolve(state))}"`;
