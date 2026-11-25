// NORN-MAIL-WAIT: `norn mail wait`, the controller session's blocking read - its wiring. mail.mjs waitMail does the wait (its clock,
// sleep and fetch passed in); this module refuses a run and a check-in, checks --to / --timeout-min, reads the machine's ledger config
// and builds the real fetch: the tick's stale fetch (sync.mjs tickFetch under policy's fetch_min) with its urgent arrivals told as the
// tick tells them. A leaf: it imports sync.mjs, which imports mail.mjs, so mail.mjs never imports it (no import cycle).
import fs from 'node:fs';
import path from 'node:path';
import { RecordError, homeOf, roleAddr } from './records.mjs';
import { waitMail, formatMail, qualify } from './mail.mjs';
import { tickFetch as realTickFetch, alertLimits } from './sync.mjs';
import { notify as realNotify } from './notify.mjs';
import { ledgerConfig } from './ledger.mjs';
import { loadMachine, metaRoot } from './config.mjs';

/**
 * The wait's fetch on a synced home (cfg: ledgerConfig's; null = no sync -> null, no fetch at all): one tickFetch per call (a pass only
 * when this home's own fetch is older than fetchMin), a failure printed once per distinct message, each urgent-arrival notice sent as
 * class alert; a notice that fails to send is printed, never thrown (the wait goes on).
 */
export function waitFetch({ cfg, machine = null, fetchMin, env, err, tickFetch = realTickFetch, notify = realNotify }) {
  if (!cfg) return null;
  const said = new Set();
  return async () => {
    let r; try { r = tickFetch(cfg, { min: fetchMin }); } catch (e) { r = { error: e.message }; }
    if (r?.error && !said.has(r.error)) { said.add(r.error); err(`fetch failed, the last copies stay: ${r.error}`); }
    for (const n of r?.notices || []) await notify({ title: n.title, body: n.body, cls: 'alert', machine, state: path.join(cfg.state_root, n.project), env }).catch(e => err(`urgent mail ${n.id}: notice not sent (${e.message})`));
  };
}

/**
 * `norn mail wait` for mailCmd: a run (a run gets its mail from the hook) and a check-in (it must not block) are refused with one line,
 * exit 2; a bad --to / --timeout-min throws RecordError code 2 (the usage path). Else -> a promise of the exit code: the mail printed as
 * check prints it, or `no new mail in N min`. tickFetch, notify, now and sleep default to the real ones.
 */
export function mailWait(state, { by, run, to: toFlag, timeoutMin, project, env, out, err, tickFetch, notify, now, sleep = ms => new Promise(res => setTimeout(res, ms)) }) {
  if (run || by === 'checkin') { err(`error: norn mail wait is the controller session's: ${run ? `a run gets its mail from the hook (META_RUN_ID=${run})` : 'a check-in must not block'}; read with norn mail check`); return 2; }
  const to = qualify(toFlag ?? 'role:controller', homeOf(state)?.id), ctl = roleAddr('controller', state), min = timeoutMin === undefined ? null : Number(timeoutMin);
  if (to !== ctl) throw new RecordError(`--to: the controller's session reads ${ctl}`, 2);
  if (min !== null && !(timeoutMin.trim() && min >= 0)) throw new RecordError('--timeout-min wants minutes (a number >= 0)', 2);
  const root = metaRoot(env), mf = path.join(root, 'local', 'machine.json'), machine = fs.existsSync(mf) ? loadMachine(mf, { meta: root }) : null;
  const fetch = waitFetch({ cfg: ledgerConfig(machine, { metaRoot: root, machineFile: mf }), machine, fetchMin: alertLimits(project?.policy).fetch_min, env, err, tickFetch, notify });
  return waitMail(state, { by, to, timeoutMin: min, now, sleep, fetch })
    .then(got => { out(got.length ? got.map(formatMail).join('\n\n') : `no new mail in ${timeoutMin} min`); return 0; },
      e => { if (!(e instanceof RecordError)) throw e; err('error: ' + e.message); return e.code; });
}
