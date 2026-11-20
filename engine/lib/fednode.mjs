// META-GTP-FED piece 3: `norn node run --home <ledger remote> [--labels a,b]` - one pull-agent job (Buildkite `--disconnect-after-job`):
// fetch the ledger remote, take the first OFFERED run (the home walk's FED-OFFERS.json on machine/<home>) whose labels this node serves and
// that no claim holds, claim it (fed.mjs CAS), run it in the node's OWN state dir (<state_root>/<project>, node.json { id } -> RUN-<id>-n),
// heartbeat the claim while it runs, mark the claim done (next = the node run, its outcome + head), commit + push the node's ledger branch
// machine/<host>. Branches go to origin as the run's own brief says (the agent pushes, as at home). The run's dwarf comes from the node's
// own crew (<state_root>/crew, crew.mjs: the crew sits beside the state dir), never the home's: DWARVES.md 1.3, "Balin @ node".
// Lease: heartbeat every fed.heartbeat_s (default 300 s), lease_s default 3 heartbeats. A node FENCES itself (records its run lost, kills its
// tree) when its claim is gone (the home expired it) or no heartbeat was confirmed for 2 periods - before the home can expire it - so a
// returned run never runs twice (Kleppmann, "How to do distributed locking", 2016: a lease holder must stop before its lease ends).
// Paths: the queued spec's paths are the home's; fed.path_map [{ from, to }] maps them on a shared filesystem (WSL: C:/ -> /mnt/c/). A node
// whose path_map does not cover the run's worktree (none at all: a real second machine) runs it from its own workspace (META-GTP-FED-2 D8,
// fedws.mjs: the offer carries the brief text + checkout). Node built-ins + git.
import fs from 'node:fs';
import path from 'node:path';
import { ledgerConfig, commitLedger } from './ledger.mjs';
import { loadState, record, RecordError } from './records.mjs';
import { startRun, hbPath, killTree, stopOrphans } from './runs.mjs';
import { prepareWorkspace, cleanWorkspace, canCheckout, wsLock } from './fedws.mjs';
import { FedError, fedOf, fetchClaims, claimKey, claimRun, updateClaim, releaseClaim, servedLabels, unserved, machineRefs, refFiles, foldText, pushLedger } from './fed.mjs';

const fwd = p => String(p).replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// the first path_map entry whose `from` prefixes p (a drive letter / Windows path compares case-blind), or null
function mapHit(p, map) {
  const s = fwd(p);
  for (const e of map || []) {
    const f = fwd(e.from);
    if (/^[a-z]:\//i.test(f) ? s.toLowerCase().startsWith(f.toLowerCase()) : s.startsWith(f)) return { s, f, to: fwd(e.to) };
  }
  return null;
}
/** a home path on this node: through the first path_map entry whose `from` prefixes it */
export function mapPath(p, map = []) {
  if (p === undefined || p === null) return p;
  const h = mapHit(p, map);
  return h ? h.to + h.s.slice(h.f.length) : fwd(p);
}
/** META-GTP-FED-2 D8: the node shares the home filesystem for this run = a path_map entry covers its worktree (none = its own workspace) */
export const sharedFs = (spec, map) => !!(spec?.worktree && mapHit(spec.worktree, map));

const OFFERS = '/views/FED-OFFERS.json';
/** the runs offered to this node, in the home's fill order: [{ home, project, run, labels, spec }] (fetched refs, no fetch) */
export function listOffers(f, claims, served) {
  const out = [];
  for (const m of machineRefs(f)) {
    const files = refFiles(f, m.ref, k => k.endsWith(OFFERS) || k.endsWith('/runs.jsonl') || /\/runs\/RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+\.queue\.json$/.test(k));
    for (const key of Object.keys(files).filter(k => k.endsWith(OFFERS))) {
      const dir = key.slice(0, -OFFERS.length), project = path.posix.basename(dir);
      const items = foldText(files[`${dir}/runs.jsonl`]);
      let offers = [];
      try { offers = JSON.parse(files[key]).rows || []; } catch { /* torn */ }
      for (const o of offers) {
        const it = items[o.id], labels = it?.data?.labels || [];
        if (it?.state !== 'queued' || !labels.length || unserved(labels, served).length || claims[claimKey(m.host, project, o.id)]) continue;
        let spec = null;
        try { spec = JSON.parse(files[`${dir}/runs/${o.id}.queue.json`]); } catch { continue; }
        out.push({ home: m.host, project, run: o.id, labels, spec, offer: o });
      }
    }
  }
  return out;
}

// the queued spec as a run of THIS node: its own state / locks / exe / caps; the home's paths mapped; the home-side fields dropped
// (after / inputs / epic were evaluated by the home walk; git_ledger is the node's, pushed by nodeRun; no tick on a node)
// ws (a workspace run): its own worktree / brief / NOTES; the home worktree among writable_roots is the workspace
function nodeSpec(spec, { m, metaRoot, cfg, state, served, claim_of, ws }) {
  const P = p => mapPath(p, m.fed?.path_map);
  const W = ws ? { brief: ws.brief, worktree: ws.worktree, notes: ws.notes,
    writable_roots: spec.writable_roots?.map(p => (fwd(p).toLowerCase() === fwd(spec.worktree).toLowerCase() ? ws.worktree : P(p))) } : {};
  const { after: _a, inputs: _i, epic: _e, fromQueue: _q, requeueOf: _r, resumeOf: _o, git_ledger: _g, ...rest } = spec;
  const fake = spec.executor === 'fake' || spec.provider?.runner === 'fake';
  const exe = fake ? spec.exe : spec.provider ? P(spec.exe) : { claude: m.claude?.exe, 'codex-sol': m.codex?.exe, 'codex-astra': m.codex?.exe }[spec.executor];
  const bf = path.join(metaRoot, 'local', 'budget.json');
  return { ...rest, state, locksDir: path.join(cfg.state_root, 'locks'), brief: P(spec.brief), worktree: P(spec.worktree), notes: P(spec.notes),
    quiet: P(spec.quiet), gpu_lock: P(spec.gpu_lock), writable_roots: spec.writable_roots?.map(P), exe, node_labels: served, claim_of,
    budget: readJson(bf) || spec.budget, budget_file: bf, paused: [path.join(cfg.state_root, 'PAUSED'), path.join(state, 'PAUSED')], statusFile: path.join(state, 'STATUS.md'),
    ledger: undefined, projectsDir: m.claude?.projects_dir, tick: null, ...W };
}

/**
 * One node job. o: { machine, machineFile, metaRoot, home (remote), labels?, pollMs?, out(line) }.
 * -> { idle } | { lost } | { done, run, outcome } | { fenced, run } | { error }
 */
export async function nodeRun({ machine: m, machineFile, metaRoot, home, labels, pollMs = 500, out = () => {} }) {
  if (!m?.ledger) throw new FedError('a node needs machine.json ledger { dir, state_root, reviews }: its own repo and state root');
  const cfg = ledgerConfig({ ...m, ledger: { ...m.ledger, ...(home ? { remote: home } : {}) } }, { metaRoot, machineFile });
  if (!cfg.remote) throw new FedError('no ledger remote: pass --home <ledger remote> (or machine.json ledger.remote)');
  const f = fedOf(cfg), served = labels?.length ? labels : servedLabels(m);
  const hbS = m.fed?.heartbeat_s ?? 300, lease_s = m.fed?.lease_s ?? 3 * hbS, hbMs = hbS * 1000;
  const nid = m.fed?.id || (f.host.replace(/[^a-z0-9]/g, '').replace(/^[^a-z]+/, '') || 'node').slice(0, 16);

  const map = m.fed?.path_map, offers = listOffers(f, fetchClaims(f), served);
  const [c] = offers.filter(o => sharedFs(o.spec, map) || canCheckout(o.offer));   // never claim what this node cannot check out
  if (!c) {
    const n = offers.length;
    out(`no offered run for labels ${served.join(',')} (node ${f.host})${n ? `; ${n} offered need the home filesystem (no checkout in the offer, no fed.path_map for their worktree)` : ''}`);
    return { idle: true };
  }
  const cl = claimRun(f, { home: c.home, project: c.project, run: c.run, labels: c.labels, lease_s });
  if (!cl.won) { out(`${c.home}/${c.project}/${c.run}: ${cl.lost ? 'lost' : 'not claimed'} - ${cl.why}`); return { lost: true }; }
  const key = cl.key, nonce = cl.claim.nonce;

  const state = path.join(cfg.state_root, c.project);
  fs.mkdirSync(state, { recursive: true });
  if (!readJson(path.join(state, 'node.json'))) fs.writeFileSync(path.join(state, 'node.json'), JSON.stringify({ id: nid, host: f.host }) + '\n');
  let started, ws = null;
  const claim_of = { home: c.home, project: c.project, run: c.run, node: f.host };
  const go = () => startRun(nodeSpec(c.spec, { m, metaRoot, cfg, state, served, claim_of, ws }));
  try {
    if (sharedFs(c.spec, map)) started = go();
    else started = wsLock(state, c.spec.lane, () => {
      ws = prepareWorkspace({ state, locksDir: path.join(cfg.state_root, 'locks'), lane: c.spec.lane, home: c.home, project: c.project, run: c.run, offer: c.offer, reviews: cfg.reviews, root: cfg.root });
      return go();
    });
  }
  catch (e) {   // could not start here: give the claim back (the home's next fill returns the run to its queue)
    try { releaseClaim(f, key, nonce, `node ${f.host} could not start it: ${e.message}`); } catch { /* the lease ends it */ }
    out(`${c.home}/${c.project}/${c.run}: claimed, not started - ${e.message}`);
    return { error: e.message };
  }
  out(`CLAIMED ${c.home}/${c.project}/${c.run} -> ${started.run} (node ${f.host}, lease ${lease_s} s)`);

  let cur = started.run, lastOk = 0, lastHb = 0;
  const beat = (patch = {}) => { try { return updateClaim(f, key, nonce, { state: 'running', node_run: cur, heartbeat_at: new Date().toISOString(), ...patch }); } catch (e) { return { error: e.message }; } };
  const publish = why => { const r = commitLedger(cfg, why, { push: false, gc: false }); if (r.error) out(`ledger: ${r.error}`); const p = pushLedger(cfg); if (p.error) out(`ledger push: ${p.error}`); };
  const fence = why => {
    const hb = readJson(hbPath(state, cur)) || {};
    try { record(state, { kind: 'run', ev: 'lost', id: cur, by: 'launcher', data: { why } }); } catch (e) { if (!(e instanceof RecordError)) throw e; }
    killTree(hb.supervisor_pid); killTree(hb.pid);
    try { stopOrphans(state); } catch { /* best effort */ }
    out(`${cur} fenced: ${why}`);
    publish(`node ${f.host}: ${cur} fenced`);
    if (ws) { try { out(cleanWorkspace(ws, { outcome: 'lost', node_run: cur })); } catch (e) { out(`workspace: ${e.message}`); } }
    return { fenced: true, run: cur };
  };
  for (;;) {
    const it = loadState(state).items[cur];
    if (it?.resume?.next) { cur = it.resume.next; continue; }   // a HANDOFF / nudge auto-resume: the chain's last run is the job
    const waiting = !it || it.state === 'running' || (['handoff', 'nudged'].includes(it.end?.outcome) && !it.resume);
    if (!waiting) break;
    const now = Date.now();
    if (now - lastHb >= hbMs || !lastHb) {
      lastHb = now;
      const u = beat();
      if (u.ok) lastOk = now;
      else if (u.gone) return fence(`lease lost: the claim is ${u.by ? `held by ${u.by}` : 'gone'} (the home expired it)`);
    }
    if (lastOk && now - lastOk > 2 * hbMs) return fence(`lease lost: no confirmed heartbeat for ${Math.round((now - lastOk) / 1000)} s (lease ${lease_s} s)`);
    if (!lastOk && now - lastHb > 2 * hbMs) return fence('lease lost: no heartbeat confirmed since the claim');
    await sleep(pollMs);
  }
  const it = loadState(state).items[cur];
  for (let t0 = Date.now(); it.end?.supervisor_pid && Date.now() - t0 < 30000; await sleep(pollMs)) { try { process.kill(it.end.supervisor_pid, 0); } catch { break; } }
  const outcome = it.end?.outcome ?? it.state;
  // the run's events (+ a workspace run's NOTES) go out BEFORE the done mark: a home that sees the claim done finds them on machine/<host>
  publish(`node ${f.host}: ${cur} ${outcome}`);
  // the done mark is an update of OUR file re-built on each new tip until it lands or the claim is not ours (never the claim CAS itself)
  let d = null;
  for (let i = 0; i < 10; i++) {
    d = beat({ state: 'done', outcome, head: it.end?.head ?? null, ended_at: it.end ? it.updated : new Date().toISOString(), ...(ws ? { notes_key: ws.notes_key } : {}) });
    if (d.ok || d.gone) break;
    await sleep(pollMs);
  }
  if (!d?.ok) out(`claim ${key}: done not recorded (${d?.gone ? 'the claim is gone' : d?.why || d?.error}) - the home's lease decides`);
  if (ws) { try { out(cleanWorkspace(ws, { outcome, node_run: cur })); } catch (e) { out(`workspace: ${e.message}`); } }   // the node's own cleanup, after the done mark
  out(`${cur} ${outcome} (claim ${c.home}/${c.project}/${c.run})`);
  return { done: true, run: cur, outcome };
}
