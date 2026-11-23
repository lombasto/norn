// NORN-UI-SYNC: Settings > Sync's heavy steps off the dashboard's event loop. The set up / join (check = its dry run, apply = pause, cut,
// publish + fetch, resume) and the reconcile pass are the library's own synchronous functions (sync.mjs syncJoin, reconcile.mjs) - no
// second path and no CLI child: a worker thread runs one and posts { ok: result } | { error }. syncOp is exported for the server tests,
// which call it in-process with a fake gh.
import path from 'node:path';
import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { syncJoin } from '../lib/sync.mjs';
import { reconcile } from '../lib/reconcile.mjs';
import { localClaims } from '../lib/claims.mjs';
import { ledgerConfig } from '../lib/ledger.mjs';
import { fedOf } from '../lib/claimsref.mjs';
import { homeOf } from '../lib/records.mjs';

/** op 'join': o = syncJoin's o. op 'reconcile': o = { state, machine, metaRoot, machineFile, by, dry } -> reconcile's result + { off } */
export function syncOp(op, o) {
  if (op === 'join') return syncJoin(o);
  if (op !== 'reconcile') throw new Error(`unknown sync op ${op}`);
  if (!homeOf(o.state)) return { off: true, pairs: [], carded: 0, written: [], applied: [] };
  const cfg = ledgerConfig(o.machine, { metaRoot: o.metaRoot, machineFile: o.machineFile });
  const claims = localClaims(fedOf(cfg));   // the last fetched claims, as norn sync reconcile
  return reconcile(path.resolve(o.state), { by: o.by, claims, dry: !!o.dry });
}

if (!isMainThread && workerData?.op) {
  try { parentPort.postMessage({ ok: syncOp(workerData.op, workerData.o) }); } catch (e) { parentPort.postMessage({ error: e.message }); }
}
