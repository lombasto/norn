// RM-46 S1c (multi-home SPEC 3.5, 4.1, 4.2): this home's shared logs go to branch home/<id> of the ledger remote; every other home's branch
// comes back as verbatim copies under <state>/homes/<h>/. Publish: the exact bytes of each synced project's (home.json id = machine.json
// ledger.home_id, SPEC 3.1; read from home.json, its copy the cut writes) shared files, secret-scanned and stored through ledger.mjs's blob writer, committed on home/<id> under its own lock and
// pushed WITHOUT force (fast-forward only: a rejection means a second install uses this id - publishing stops). Fetch: home/* and claims in
// one fetch (claimsref's fetchRefs, under the claims lock, since it moves refs/sync/claims too); a copy is written only when its blob
// changed and is never edited. Copies sit outside the backup walk (it enters runs/ and views/ only), so a copy is never published again.
// S1d: the fetch ends with the relay (relayPass) of each synced project: SPEC 4.2's pass. S4: syncPass adds the claims seen; the loop (syncLoop) polls and hears the doorbell.
// S6b: syncJoin - a machine joins as a home by calling the stages above in order (access, private check, register, machine.json, cut, publish +
// fetch). NORN-UI-SYNC: the join pauses each project it cuts and resumes it at the end; dry = the plan only (the dashboard's check step);
// bare = the first home (the cut --bare of the given projects). Node built-ins + the git binary (+ gh for the private check).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLock, homeOf, KINDS, SHARED_KINDS, loadShared, primaryOf, record, RecordError, foldKey, keyBefore, HOME_RE, homeOfId } from './records.mjs';
import { writeBlob, secretsOf, ensureLedger, ledgerConfig } from './ledger.mjs';
import { rgit, fetchRefs, under, fedOf, SYNC_CLAIMS, CLAIMS } from './claimsref.mjs';
import { readJsonS } from './fsnap.mjs';
import { updateMachine } from './config.mjs';
import { localClaims, observeClaims, updateSync, listClaims, registerHome, homeKey, projectKey, setHomeName, homeNames } from './claims.mjs';
import { syncCut, cutLines } from './synccut.mjs';
import { ghSlug } from './mergeland.mjs';
import { ringDoorbell, doorbellStream } from './notify.mjs';
import { setPause, clearPause } from './pause.mjs';
import { boundedAsync } from './bounded.mjs';
import { arrivalNotices, listMail } from './mail.mjs';
import { withDefaults } from './policy.mjs';

// SPEC 3.3 as data: the shared kinds publish their log, the local kinds with a read-only copy publish it under copy/, the rest stay local
const COPIED = ['run', 'deliverable'];
const logsOf = ks => [...new Set(ks.map(k => KINDS[k].file + '.jsonl'))];
/** what a home branch carries per project: { from: file in the state dir, to: path under <project>/ on home/<id> (and under homes/<h>/) } */
export const HOME_FILES = [{ from: 'home.json', to: 'home.json' }, ...logsOf(SHARED_KINDS).map(f => ({ from: f, to: f })), { from: 'relay.jsonl', to: 'relay.jsonl' },
  ...logsOf(COPIED).map(f => ({ from: f, to: `copy/${f}` })), { from: 'seen.json', to: 'seen.json' }];
const HOME_SPEC = '+refs/heads/home/*:refs/sync/home/*';
const SEG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const ls = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const writeAtomic = (f, b) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, b); fs.renameSync(tmp, f); };
const logTo = (cfg, s) => { try { fs.appendFileSync(path.join(cfg.dir, 'sync.log'), `${new Date().toISOString()} ${s}\n`); } catch { /* no dir */ } };
// <ledger>/home-manifest.json { head, pushed, files: { rel: "size:mtime" } } (a no-op pass spawns no git); home-stopped.txt = why
// publishing stopped (remove it once the id is unique); sync-fetch.json { fetched_at, fetch_error, failed_at, gone } (the fetch's own file);
// home-names.json { id: name } (the claims ref's home names after each fetch and rename: a page read never spawns git)
const F = { manifest: 'home-manifest.json', stopped: 'home-stopped.txt', fetch: 'sync-fetch.json', names: 'home-names.json' };
const at = (cfg, k) => path.join(cfg.dir, F[k]);
const projects = (cfg, id) => ls(cfg.state_root).filter(e => e.isDirectory() && SEG.test(e.name) && (id === undefined ? homeOf(path.join(cfg.state_root, e.name)) : homeOf(path.join(cfg.state_root, e.name))?.id === id)).map(e => e.name).sort();

/** the home id: the one id in the home.json of this machine's synced projects (the cut's copy of machine.json ledger.home_id, SPEC 3.1;
 * record() and norn claim release read it there too). No synced project or no ledger remote = null (sync off); several ids throw. */
export function homeIdOf(cfg) {
  if (!cfg?.remote) return null;
  const ids = [...new Set(projects(cfg).map(p => homeOf(path.join(cfg.state_root, p)).id))];
  if (ids.length > 1) throw new Error(`the synced projects name several homes (${ids.join(', ')}): one machine is one home`);
  return ids[0] ?? null;
}
/** S5: this home's synced projects: [{ project, state }] (sync off: none) */
export const syncedDirs = cfg => { const id = homeIdOf(cfg); return id ? projects(cfg, id).map(p => ({ project: p, state: path.join(cfg.state_root, p) })) : []; };
// cfg + its home_id, or null (off); throws like homeIdOf
const synced = cfg => { const id = homeIdOf(cfg); return id ? { ...cfg, home_id: id } : null; };

// the publish walk: { files: Map<rel on home/<id>, abs>, stat: { rel: "size:mtime" } }
function homeWalk(cfg) {
  const files = new Map(), stat = {};
  for (const p of projects(cfg, cfg.home_id)) for (const x of HOME_FILES) {
    const abs = path.join(cfg.state_root, p, x.from);
    let st; try { st = fs.statSync(abs); } catch { continue; }
    if (st.isFile()) { files.set(`${p}/${x.to}`, abs); stat[`${p}/${x.to}`] = `${st.size}:${st.mtimeMs}`; }
  }
  return { files, stat };
}
const same = (a, b) => { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k]); };
// nothing to publish: the walk matches the manifest and its head is pushed, or there is nothing at all
const idle = (m, files, stat) => (!!m && same(m.files || {}, stat) && m.pushed === m.head) || (!files.size && !m);
// HOME-MAIL S1 (REPORT 3.1): <project>/seen.json = this home's receipt { polled_at (rounded down to 5 min), held: { h: { log: highest seq } } }
// of the other homes' shared logs, written by the fetch only when its bytes change. A publish whose only change is a seen.json whose held part
// is the one last committed (polled_at moved) is a heartbeat: pushed, but it rings no doorbell (the manifest keeps the held part per file).
const SEEN_LOGS = logsOf(SHARED_KINDS), POLL_ROUND_MS = 5 * 60000;
const isoS = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const heldOf = abs => { try { return JSON.stringify(JSON.parse(fs.readFileSync(abs, 'utf8')).held ?? null); } catch { return null; } };
// the last seq of a log copy: a home appends its own log in seq order, so the last line that parses holds the highest
function lastSeq(f) {
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch { return null; }
  const lines = t.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try { const s = JSON.parse(lines[i]).seq; if (Number.isInteger(s)) return s; } catch { /* a line that does not parse: the one before */ }
  }
  return null;
}
function writeSeen(cfg, p, homes, nowMs) {
  const held = {};
  for (const h of homes) {
    const logs = Object.fromEntries(SEEN_LOGS.map(l => [l, lastSeq(path.join(cfg.state_root, p, 'homes', h, l))]).filter(([, s]) => s !== null));
    if (Object.keys(logs).length) held[h] = logs;
  }
  const polled_at = new Date(Math.floor(nowMs / POLL_ROUND_MS) * POLL_ROUND_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const f = path.join(cfg.state_root, p, 'seen.json'), b = JSON.stringify({ polled_at, held }) + '\n';
  let cur = null; try { cur = fs.readFileSync(f, 'utf8'); } catch { /* no receipt yet */ }
  if (cur !== b) writeAtomic(f, b);
}
const tipOf = (f, ref) => rgit(f, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], { ok: [0, 1] }).out.trim() || null;

// commit the walk's bytes on home/<id>: -> { sha } | { head } (tree unchanged) | { refused }
function commitHome(cfg, f, ref, head, files) {
  const secrets = secretsOf(cfg.machine_file).map(s => Buffer.from(s)), lines = [], refused = [];
  for (const [rel, abs] of files) {
    const b = fs.readFileSync(abs);
    if (secrets.some(s => b.includes(s))) refused.push(rel); else lines.push(`100644 ${writeBlob(cfg, b)}\t${rel}`);
  }
  if (refused.length) { logTo(cfg, `publish refused - a machine.json secret value in: ${refused.join(', ')}`); return { refused }; }
  const index = path.join(cfg.dir, `home-index-${process.pid}`);
  try {
    try { fs.unlinkSync(index); } catch { /* no index left: update-index starts an empty one */ }
    rgit(f, ['update-index', '--add', '-z', '--index-info'], { index, input: lines.join('\0') + '\0' });
    const tree = rgit(f, ['write-tree'], { index }).out.trim();
    if (head && rgit(f, ['rev-parse', `${head}^{tree}`]).out.trim() === tree) return { head };
    const sha = rgit(f, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `home/${cfg.home_id}: publish\n\n${files.size} files\n`]).out.trim();
    rgit(f, ['update-ref', ref, sha, ...(head ? [head] : [])]);
    return { sha };
  } finally { try { fs.unlinkSync(index); } catch { /* already removed: nothing to clean up */ } }
}

// home/<id>'s remote tip after a refused push: true only for a tip outside our history (not our head, our last push or an ancestor)
function foreignTip(cfg, f, ref, head, pushed) {
  let r; try { r = rgit(f, ['ls-remote', cfg.remote, ref], { ok: [0, 2, 128] }); } catch { return false; }   // timed out: passing
  const tip = r.status === 0 ? (r.out.split('\n').find(l => l.trim().endsWith(`\t${ref}`)) || '').split('\t')[0] : '';
  if (!tip || tip === head || tip === pushed) return false;
  return rgit(f, ['merge-base', '--is-ancestor', tip, head], { ok: [0, 1, 128] }).status !== 0;
}

/**
 * publishHome(cfg): this home's shared files onto home/<home_id> and a push without force. Never throws. -> { off } | { noop } |
 * { refused: [rel] } | { stopped: why } | { rejected: why } | { sha?, pushed: true, heartbeat? } | { sha?, offline: why } | { error }
 */
export function publishHome(cfg0, o = {}) {
  let cfg; try { cfg = synced(cfg0); } catch (e) { return { error: e.message }; }
  if (!cfg) return { off: true };
  const f = fedOf(cfg), ref = `refs/heads/home/${cfg.home_id}`, now = new Date(o.now ?? Date.now()).toISOString();
  try {
    ensureLedger(cfg);
    return withLock(path.join(cfg.dir, 'home.lock'), () => {
      const stopped = fs.existsSync(at(cfg, 'stopped')) ? fs.readFileSync(at(cfg, 'stopped'), 'utf8').trim() : null;
      if (stopped) return { stopped };
      const m = readJsonS(at(cfg, 'manifest')), { files, stat } = homeWalk(cfg), unchanged = m && same(m.files || {}, stat);
      if (idle(m, files, stat)) return { noop: true };
      const held = Object.fromEntries([...files].filter(([rel]) => rel.endsWith('/seen.json')).map(([rel, abs]) => [rel, heldOf(abs)]));
      const changed = Object.keys({ ...stat, ...(m?.files || {}) }).filter(k => m?.files?.[k] !== stat[k]);
      const beat = !!m && changed.length > 0 && changed.every(k => k.endsWith('/seen.json') && held[k] !== undefined && held[k] === m.held?.[k]);
      let head = m?.head ?? tipOf(f, ref), sha;
      if (!unchanged) {
        const c = commitHome(cfg, f, ref, head, files);
        if (c.refused) return c;
        sha = c.sha; head = c.sha || c.head;
        writeAtomic(at(cfg, 'manifest'), JSON.stringify({ head, pushed: m?.pushed ?? null, files: stat, held }));
        if (head === m?.pushed) return { noop: true };
      }
      const r = rgit(f, ['push', '-q', '--porcelain', cfg.remote, `${head}:${ref}`], { ok: [0, 1, 128] });
      if (r.status === 0) {
        rgit(f, ['update-ref', `refs/sync/home/${cfg.home_id}`, head]);
        writeAtomic(at(cfg, 'manifest'), JSON.stringify({ head, pushed: head, files: stat, held, pushed_at: now }));
        return { ...(sha ? { sha } : {}), pushed: true, ...(beat ? { heartbeat: true } : {}) };
      }
      // a refused push is a clash only when home/<id> really moved: its remote tip is not ours. A server-side refusal ([remote rejected],
      // a ref lock held by another push to the repo) or a failed ls-remote is passing: kept local, the next pass retries
      if (foreignTip(cfg, f, ref, head, m?.pushed)) {
        const why = `push rejected at ${now}: home/${cfg.home_id} moved on the remote - another install uses home id ${cfg.home_id}? Publishing stopped; remove ${F.stopped} once the id is unique`;
        logTo(cfg, why); fs.writeFileSync(at(cfg, 'stopped'), why + '\n');
        return { rejected: why };
      }
      const why = (r.err || r.out || 'push failed').trim().split('\n').pop();
      logTo(cfg, `push failed (kept local, the next pass retries): ${why}`);
      return { ...(sha ? { sha } : {}), offline: why };
    }, { staleMs: 120000, timeoutMs: o.lockTimeoutMs ?? 20000 });
  } catch (e) { logTo(cfg, `publish failed: ${e.message}`); return { error: e.message }; }
}

const notesOf = (cfg, p) => path.join(cfg.state_root, p, 'sync', 'copy-integrity.json');   // records.mjs homeStreams reads it
const blobSha = b => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest('hex');
function blobBytes(f, sha) {
  const r = spawnSync('git', ['cat-file', 'blob', sha], { env: { ...process.env, GIT_DIR: f.dir }, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git cat-file ${sha} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

/**
 * fetchHomes(cfg): fetch home/* + claims, then write each changed blob of another home's branch, for this machine's synced projects, to
 * <state>/<project>/homes/<h>/<path> (atomic, verbatim). A failed fetch keeps the last copies. Never throws.
 * -> { off } | { error } | { homes: [h], written: [rel to the state root], gone: ['<project>/<h>'] (copies kept, the branch is gone) }
 */
export function fetchHomes(cfg0, o = {}) {
  let cfg; try { cfg = synced(cfg0); } catch (e) { return { error: e.message }; }
  if (!cfg) return { off: true };
  const f = fedOf(cfg), now = new Date(o.now ?? Date.now()).toISOString(), st = readJsonS(at(cfg, 'fetch')) || {};
  try {
    ensureLedger(cfg);
    under(f, () => fetchRefs(f, [HOME_SPEC]));
  } catch (e) {
    const why = e.message.split('\n').pop();
    logTo(cfg, `fetch failed (the last copies stay): ${why}`);
    writeAtomic(at(cfg, 'fetch'), JSON.stringify({ ...st, fetch_error: why, failed_at: now }));
    return { error: why };
  }
  try {
    // HOME-MAIL S3: the commit time of each tip is that home's last push (sync status reads it from sync-fetch.json, no git)
    const refs = rgit(f, ['for-each-ref', '--format=%(refname) %(objectname) %(committerdate:iso-strict)', 'refs/sync/home/']).out.split('\n').filter(Boolean)
      .map(l => l.split(' ')).map(([r, sha, d]) => [r.slice('refs/sync/home/'.length), sha, d]).filter(([h]) => HOME_RE.test(h) && h !== cfg.home_id);
    const tips = Object.fromEntries(refs.map(([h, sha]) => [h, sha])), pushed_at = Object.fromEntries(refs.map(([h, , d]) => [h, d ? isoS(Date.parse(d)) : null]));
    const homes = Object.keys(tips).sort(), mine = projects(cfg), written = [];
    const noted = Object.fromEntries(mine.map(p => [p, readJsonS(notesOf(cfg, p)) || []])), noted0 = JSON.stringify(noted);
    for (const h of homes) {
      const ents = rgit(f, ['ls-tree', '-r', '-z', tips[h]]).out.split('\0').filter(Boolean).map(l => { const [meta, rel] = l.split('\t'); return { sha: meta.split(' ')[2], rel }; });
      // SPEC 3.7: a log copy that is not an append of the last copy is an integrity row, unless the home's cut_at changed (a re-cut)
      const recut = {};
      for (const e of ents) {
        const [p, x, ...more] = e.rel.split('/');
        if (x !== 'home.json' || more.length || !mine.includes(p)) continue;
        let cut = null; try { cut = JSON.parse(blobBytes(f, e.sha)).cut_at ?? null; } catch { /* no cut_at: compared as null */ }
        recut[p] = cut !== (readJsonS(path.join(cfg.state_root, p, 'homes', h, 'home.json'))?.cut_at ?? null);
        if (recut[p]) noted[p] = noted[p].filter(r => r.home !== h);
      }
      for (const e of ents) {
        const [p, ...rest] = e.rel.split('/');
        if (!mine.includes(p) || !rest.length || !rest.every(s => SEG.test(s))) continue;
        const dest = path.join(cfg.state_root, p, 'homes', h, ...rest), file = rest.join('/');
        let cur = null; try { cur = fs.readFileSync(dest); } catch { /* new copy */ }
        if (cur && blobSha(cur) === e.sha) continue;
        const b = blobBytes(f, e.sha);
        if (cur && file.endsWith('.jsonl') && !recut[p] && !b.subarray(0, cur.length).equals(cur) && !noted[p].some(r => r.home === h && r.file === file))
          noted[p].push({ home: h, file, at: now, why: `the copy of ${file} from home ${h} is not an append of the last copy (fetched ${now})` });
        writeAtomic(dest, b);
        written.push(`${p}/homes/${h}/${file}`);
      }
    }
    if (JSON.stringify(noted) !== noted0) for (const p of mine) writeAtomic(notesOf(cfg, p), JSON.stringify(noted[p]));
    // SPEC 4.2: the pass relays what the other homes wrote on this home's records (each project under its own record() locks)
    const relayed = [], refused = [];
    for (const p of mine) {
      try { const r = relayPass(path.join(cfg.state_root, p), { now: () => new Date(o.now ?? Date.now()) }); relayed.push(...r.relayed); refused.push(...r.refused); }
      catch (e) { logTo(cfg, `relay failed for ${p} (the next pass retries): ${e.message}`); }
    }
    for (const p of mine) writeSeen(cfg, p, homes, o.now ?? Date.now());
    // HOME-MAIL S2 (REPORT 3.2): the arrival step - each urgent mail for this home's controller is one notice (the caller sends it)
    const notices = mine.flatMap(p => { try { return arrivalNotices(path.join(cfg.state_root, p)).map(n => ({ ...n, project: p })); }
      catch (e) { logTo(cfg, `arrival step failed for ${p} (the next pass retries): ${e.message}`); return []; } });
    const gone = mine.flatMap(p => ls(path.join(cfg.state_root, p, 'homes')).filter(d => d.isDirectory() && !tips[d.name]).map(d => `${p}/${d.name}`)).sort();
    writeAtomic(at(cfg, 'fetch'), JSON.stringify({ fetched_at: now, fetch_error: null, failed_at: null, gone, pushed_at }));
    writeAtomic(at(cfg, 'names'), JSON.stringify(homeNames(f)));
    return { homes, written, gone, relayed, refused, notices };
  } catch (e) { logTo(cfg, `copies failed: ${e.message}`); return { error: e.message }; }
}

/** NORN-DASH-1123 item 6: name a home (POST /api/sync/name): setHomeName on the claims ref, then the names cache ->
 *  { ok, names } | { refused: [why] } | { off } | { error }. Never throws. */
export function renameHome(cfg0, { home, name, by = 'dashboard', now = Date.now() }) {
  let cfg; try { cfg = synced(cfg0); } catch (e) { return { error: e.message }; }
  if (!cfg) return { off: true };
  const f = fedOf(cfg);
  try {
    ensureLedger(cfg);
    const r = setHomeName(f, { id: home, name, by, now });
    if (r.unknown || r.busy) return { refused: [r.why] };
    const names = homeNames(f);
    writeAtomic(at(cfg, 'names'), JSON.stringify(names));
    return { ok: true, names };
  } catch (e) { return /^home name |: not a valid home$/.test(e.message) ? { refused: [e.message] } : { error: e.message.split('\n').pop() }; }   // the name rule refuses; git fails
}

// a relayed / refused pending event: "<home>:<seq> <file> <id> <ev>"
const evName = x => `${x.e.home}:${x.e.seq} ${x.file} ${x.e.id} ${x.e.ev}`;
/**
 * relayPass(stateDir, { now, max }): SPEC 3.7 relay at the primary. Each event another home wrote on a record this home is primary of
 * (pending in the merged view), oldest first (the fold order), at most `max` (200): record() it with its original by / run / data +
 * from_home { home, seq, ts } - this home's lock, role check and from-state check decide. A refusal appends { home, seq, file, id, ev,
 * why, ts } to <state>/relay.jsonl (published; the writer home folds it into a conflict). A busy lock or an unreadable log (RecordError
 * code 1) is no refusal: the event stays pending for the next pass. Idempotent: a relayed or refused event is no longer pending.
 * -> { relayed: [name], refused: [name] }; a solo dir relays nothing.
 */
export function relayPass(stateDir, o = {}) {
  const home = homeOf(stateDir), out = { relayed: [], refused: [] };
  if (!home) return out;
  const now = o.now || (() => new Date()), todo = [];
  for (const kind of SHARED_KINDS.filter((k, i, a) => a.findIndex(x => KINDS[x].file === KINDS[k].file) === i)) {
    const v = loadShared(stateDir, kind);
    for (const [id, evs] of Object.entries(v.pending)) if (primaryOf(v.items[id], home.bare_home) === home.id) for (const e of evs) todo.push({ file: KINDS[kind].file, e });
  }
  todo.sort((a, b) => keyBefore(foldKey(a.e, a.e.home), foldKey(b.e, b.e.home)));
  for (const x of todo.slice(0, o.max ?? 200)) {
    const { e } = x;
    try {
      record(stateDir, { kind: e.kind, ev: e.ev, id: e.id, by: e.by, data: e.data ?? {} }, { now, run: e.run ?? null, from_home: { home: e.home, seq: e.seq, ts: e.ts }, views: o.views });
      out.relayed.push(evName(x));
    } catch (err) {
      if (!(err instanceof RecordError) || err.code === 1) throw err;
      const row = { home: e.home, seq: e.seq, file: x.file, id: e.id, ev: e.ev, why: err.message, ts: now().toISOString().replace(/\.\d{3}Z$/, 'Z') };
      withLock(path.join(stateDir, 'relay.lock'), () => fs.appendFileSync(path.join(stateDir, 'relay.jsonl'), JSON.stringify(row) + '\n'));
      out.refused.push(evName(x));
    }
  }
  return out;
}

/** what the sync files say (no git, no network): { off } | { error } | { home, remote, head, pushed, stopped, fetched_at, fetch_error, failed_at, gone,
 * projects: [{ project, homes, broken }] (homesStatus, o.policyOf(project) = its limits), broken: [every project's] } */
export function syncStatus(cfg0, o = {}) {
  let cfg; try { cfg = synced(cfg0); } catch (e) { return { error: e.message }; }
  if (!cfg) return { off: true };
  const m = readJsonS(at(cfg, 'manifest')) || {}, ft = readJsonS(at(cfg, 'fetch')) || {};
  let stopped = null; try { stopped = fs.readFileSync(at(cfg, 'stopped'), 'utf8').trim(); } catch { /* no stop file: publishing runs, stopped stays null */ }
  return { home: cfg.home_id, remote: cfg.remote ? 'set' : null, head: m.head ?? null, pushed: m.pushed ?? null, stopped,
    fetched_at: ft.fetched_at ?? null, fetch_error: ft.fetch_error ?? null, failed_at: ft.failed_at ?? null, gone: ft.gone || [], ...homesOfCfg(cfg, m, ft, o) };
}
function homesOfCfg(cfg, m, ft, o) {
  // an unreadable log (an integrity error) costs that project its rows, never the status
  const projects = syncedDirs(cfg).map(({ project, state }) => { try { return { project, ...homesStatus(state, { now: o.now, polledAt: ft.fetched_at ?? null, pushedAt: ft.pushed_at || {},
    ownPushedAt: m.pushed_at ?? null, gone: (ft.gone || []).filter(g => g.startsWith(project + '/')).map(g => g.slice(project.length + 1)), limits: alertLimits(o.policyOf?.(project)) }) }; }
    catch (e) { return { project, homes: [], broken: [], error: e.message.split('\n')[0] }; } });
  return { projects, broken: projects.flatMap(p => p.broken.map(b => ({ project: p.project, ...b }))) };
}

// ---------- HOME-MAIL S3 (REPORT 3.3): one status row per home, the alerts, the tick's own fetch ----------
// A home's heartbeat is the polled_at of its receipt (seen.json, rounded down to 5 min) as this home last fetched it; this home's own is
// its last fetch. A home on an older version publishes no receipt: its poll reads "unknown" and breaks no rule. Limits from policy.
/** { unacked_min, urgent_min, heartbeat_min, fetch_min } from a project policy (defaults: 30, 10, 15, 2) */
export const alertLimits = pol => { const P = withDefaults({ policy: pol || {} }).policy;
  return { unacked_min: P.mail.unacked_alert_min, urgent_min: P.mail.urgent_alert_min, heartbeat_min: P.sync.heartbeat_min, fetch_min: P.sync.tick_fetch_min }; };
const minsSince = (iso, now) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60000)) : null; };
const oldest = rows => rows.length ? { count: rows.length, oldest_min: Math.max(...rows.map(r => r.age_min)) } : { count: 0, oldest_min: null };
// why a mail is not acked yet, from the sender's side (listMail's where: S1 receipts)
function mailWhy(r, dest) {
  if (r.state === 'delivered') return `delivered at ${dest}${r.delivered_to ? ` (${r.delivered_to})` : ''}, not acked`;
  if (/^at /.test(r.where)) return `${dest} holds it; nobody there has read it (${r.where}): its controller runs norn mail check`;
  if (/ unknown$/.test(r.where)) return `${dest} sends no receipts (an older Norn there): not known whether it arrived`;
  return `${dest} has not fetched it yet (${r.where})`;
}
/**
 * homesStatus(state, { now, polledAt?, pushedAt?: { h: iso }, ownPushedAt?, gone?: [h], limits? }): per home of this synced dir (own first)
 * { home, own, last_push, last_poll, heartbeat_min, holds (of our shared logs, by log), ours (our last seq, by log), unread_there, waiting_here, gone }
 * and broken: [{ rule: heartbeat | mail, home, id?, age_min, what (one line), why }]. polledAt = this home's last fetch (else its own seen.json). Solo: none.
 */
export function homesStatus(state, o = {}) {
  const home = homeOf(state), out = { homes: [], broken: [] };
  if (!home) return out;
  const now = o.now ?? Date.now(), L = o.limits || alertLimits(), gone = o.gone || [], bare = home.bare_home;
  const others = ls(path.join(state, 'homes')).filter(d => d.isDirectory() && HOME_RE.test(d.name) && d.name !== home.id).map(d => d.name).sort();
  const mails = listMail(state, { open: true, now }), ours = Object.fromEntries(SEEN_LOGS.map(l => [l, lastSeq(path.join(state, l))]).filter(([, s]) => s !== null));
  const destOf = r => primaryOf({ kind: 'mail', data: { to: r.to } }, bare), mine = r => homeOfId(r.id, bare) === home.id;
  const ownPoll = o.polledAt ?? readJsonS(path.join(state, 'seen.json'))?.polled_at ?? null;
  out.homes.push({ home: home.id, own: true, last_push: o.ownPushedAt ?? null, last_poll: ownPoll, heartbeat_min: minsSince(ownPoll, now) });
  const late = (age, lim) => age !== null && age > lim;
  if (late(minsSince(ownPoll, now), L.heartbeat_min)) out.broken.push({ rule: 'heartbeat', home: home.id, age_min: minsSince(ownPoll, now), what: `home ${home.id}: heartbeat ${minsSince(ownPoll, now)} min old`, why: `home ${home.id}: heartbeat ${minsSince(ownPoll, now)} min old (this home last fetched ${ownPoll}; limit ${L.heartbeat_min}): is its dashboard or norn sync watch running?` });
  for (const h of others) {
    const seen = readJsonS(path.join(state, 'homes', h, 'seen.json')), poll = seen?.polled_at ?? null, age = minsSince(poll, now), isGone = gone.includes(h);
    const there = mails.filter(r => mine(r) && destOf(r) === h), here = mails.filter(r => !mine(r) && homeOfId(r.id, bare) === h && destOf(r) === home.id);
    out.homes.push({ home: h, own: false, last_push: o.pushedAt?.[h] ?? null, last_poll: poll, heartbeat_min: age, holds: seen?.held?.[home.id] ?? null, ours,
      unread_there: oldest(there), waiting_here: oldest(here), gone: isGone });
    if (isGone) continue;
    if (late(age, L.heartbeat_min)) out.broken.push({ rule: 'heartbeat', home: h, age_min: age, what: `home ${h}: heartbeat ${age} min old`, why: `home ${h}: heartbeat ${age} min old (last polled ${poll}; limit ${L.heartbeat_min}): it fetches nothing, so it reads no mail` });
    for (const r of there) {
      const lim = r.urgent ? L.urgent_min : L.unacked_min;
      if (r.age_min > lim) out.broken.push({ rule: 'mail', home: h, id: r.id, age_min: r.age_min, what: `${r.id} to ${qualifyTo(r.to, bare)} unacked ${r.age_min} min`, why: `${r.id} to ${qualifyTo(r.to, bare)}${r.urgent ? ' URGENT' : ''} unacked ${r.age_min} min (limit ${lim}): ${mailWhy(r, h)}` });
    }
  }
  return out;
}
const qualifyTo = (to, bare) => /^role:[a-z]+$/.test(to) ? `${to}@${bare}` : to;
// <state>/sync/alerted.json { mail: [ids told, still unacked], homes: [homes told, still stale] }: a mail is told once, a stale home once per episode
const alertedFile = state => path.join(state, 'sync', 'alerted.json');
/** the tick's alerts: each new broken rule of homesStatus is one notice { title, body } (the caller sends it, class alert); told once */
export function syncAlerts(state, o = {}) {
  const { broken } = homesStatus(state, o);
  if (!homeOf(state)) return [];
  const had = readJsonS(alertedFile(state)) || {}, key = b => b.rule === 'mail' ? b.id : b.home;
  const cur = { mail: broken.filter(b => b.rule === 'mail').map(key), homes: broken.filter(b => b.rule === 'heartbeat').map(key) };
  const fresh = broken.filter(b => !(b.rule === 'mail' ? had.mail || [] : had.homes || []).includes(key(b)));
  // an id stays while its rule is broken: an acked mail never breaks it again; a home fresh again ends its episode
  const keep = { mail: cur.mail.sort(), homes: cur.homes.sort() };
  if (JSON.stringify(keep) !== JSON.stringify({ mail: had.mail || [], homes: had.homes || [] })) writeAtomic(alertedFile(state), JSON.stringify(keep));
  return fresh.map(b => ({ title: b.what, body: `${b.why}\n(norn sync status shows every home)` }));
}
/** this home's last good fetch (sync-fetch.json fetched_at) or null (sync off, never fetched) */
export const lastFetch = cfg0 => { try { const cfg = synced(cfg0); return cfg ? readJsonS(at(cfg, 'fetch'))?.fetched_at ?? null : null; } catch { return null; } };
/** the tick's fetch: when this home's own poll (sync-fetch.json fetched_at) is older than min (2) or missing, one pass (o.pass: tests);
 * sync off or fresh -> null. A dead dashboard no longer makes a home deaf (REPORT F3). */
export function tickFetch(cfg0, o = {}) {
  let cfg; try { cfg = synced(cfg0); } catch { return null; }
  if (!cfg) return null;
  const age = minsSince(lastFetch(cfg), o.now ?? Date.now()), min = o.min ?? alertLimits().fetch_min;
  if (age !== null && age < min) return null;
  return (o.pass ?? syncPass)(cfg0, { now: o.now });
}

/** the publish step of the tick's ledger step and of a run end: never throws; a one-line note or null (off / no-op). A push rings the
 * doorbell (SPEC 4.3) from a detached child: the run end exits right after this step, and a ring must not hold it (o.publish / o.ring: tests) */
export function syncStep(cfg, reason, o = {}) {
  const r = (o.publish ?? publishHome)(cfg, o);
  if (r.pushed && !r.heartbeat && doorbellOf(cfg)) { try { (o.ring ?? ringDetached)(cfg); } catch (e) { logTo(cfg, `doorbell ring not started: ${e.message}`); } }
  if (r.noop || r.off) return null;
  if (r.error) return `sync: publish failed (${reason}): ${r.error}`;
  if (r.refused) return `sync: publish refused (secret value in ${r.refused.join(', ')})`;
  if (r.stopped || r.rejected) return `sync: publish stopped: ${r.stopped || r.rejected}`;
  if (r.offline) return `sync: publish offline, the next pass pushes (${r.offline})`;
  return `sync: home ${r.sha ? r.sha.slice(0, 10) : 'pushed'} (${reason})`;
}

/** SPEC 4.2's pass: the fetch (copies + S1d's relay, in fetchHomes), then the claims seen recorded on this home's clock (4.5) */
export function syncPass(cfg0, o = {}) {
  const r = fetchHomes(cfg0, o);
  if (r.error || r.off) return r;
  const cfg = synced(cfg0), claims = localClaims(fedOf(cfg)), now = o.now ?? Date.now();
  for (const p of projects(cfg, cfg.home_id)) updateSync(path.join(cfg.state_root, p), 'seen', cur => observeClaims(claims, cur, { home: cfg.home_id, now }));
  return r;
}

// ---------- RM-46 S4 (SPEC 4.3): the sync loop - an ls-remote poll every poll_s + the optional doorbell ----------
// A moved head of another home (or of claims) is one pass; a ring from another home is one pass; this home's own branch and ring are
// ignored. Passes never overlap (a request during one is one more pass). The doorbell carries no data: down or unset = poll only.
// The dashboard server and `norn sync watch` run the same loop (loopOf): ls-remote / for-each-ref are async children, and publish and
// the pass run as `norn sync publish | fetch` children, so the server's event loop never blocks. Everything is injectable for tests.
/** rules as data: the poll period and the doorbell's reconnect backoff [first, cap] (doubling) */
export const LOOP = { poll_s: 30, backoff_s: [5, 300] };
const HEADS = ['refs/heads/home/*', CLAIMS], SHA40 = /^[0-9a-f]{40}$/;
const TIMERS = { setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimeout: t => clearTimeout(t) };
/** `<sha> <ref>` lines (ls-remote, or for-each-ref with that format) -> { ref: sha } */
export const parseHeads = text => Object.fromEntries(String(text).split('\n').map(l => l.trim().split(/\s+/)).filter(([sha, r]) => SHA40.test(sha || '') && r).map(([sha, r]) => [r, sha]));
/** the heads that differ between the fetched and the remote ones (a deleted branch too), this home's own branch left out (its own pushes) */
export function movedHeads(had, now, home) {
  const own = `refs/heads/home/${home}`;
  return [...new Set([...Object.keys(had), ...Object.keys(now)])].filter(r => r !== own && had[r] !== now[r]).sort();
}
// the fetched tips under their remote names: refs/sync/home/<h> -> refs/heads/home/<h>, refs/sync/claims -> refs/heads/claims
const asRemote = heads => Object.fromEntries(Object.entries(heads).map(([r, sha]) => [r === SYNC_CLAIMS ? CLAIMS : r.startsWith('refs/sync/home/') ? 'refs/heads/home/' + r.slice('refs/sync/home/'.length) : null, sha]).filter(([r]) => r));
/** one ntfy JSON-stream line -> { h, sha } when it is a ring (an event "message" whose message is { h, sha }), else null */
export function ringOf(line) {
  let e, m;
  try { e = JSON.parse(line); } catch { return null; }
  if (e?.event !== 'message') return null;
  try { m = JSON.parse(e.message); } catch { return null; }
  return HOME_RE.test(m?.h || '') && SHA40.test(m?.sha || '') ? { h: m.h, sha: m.sha } : null;
}

/** watchDoorbell({ open(signal) -> async iterable of lines, home(), onRing({h, sha}), timers, backoff_s, log }): hold the stream; a drop or a
 * refusal reconnects after the backoff (first, doubling to the cap); an "open" event resets it. -> { stop() } */
export function watchDoorbell({ open, home, onRing, timers = TIMERS, backoff_s = LOOP.backoff_s, log = () => {} }) {
  let wait = backoff_s[0], timer = null, ac = null, stopped = false;
  async function connect() {
    timer = null;
    if (stopped) return;
    ac = new AbortController();
    let why = 'stream ended';
    try {
      for await (const l of open(ac.signal)) {
        if (stopped) return;
        let ev = null; try { ev = JSON.parse(l)?.event; } catch { /* not JSON: ringOf drops it too */ }
        if (ev === 'open') wait = backoff_s[0];
        const r = ringOf(l);
        if (r && r.h !== home()) onRing(r);
      }
    } catch (e) { why = e.message; }
    if (stopped) return;
    log(`doorbell: ${why}; reconnect in ${wait} s (the poll goes on)`);
    timer = timers.setTimeout(connect, wait * 1000);
    wait = Math.min(wait * 2, backoff_s[1]);
  }
  connect();
  return { stop() { stopped = true; if (timer) timers.clearTimeout(timer); timer = null; ac?.abort(); } };
}

/**
 * syncLoop({ home() -> id | null (null = sync off: nothing polled), lsRemote() -> { ref: sha }, known() -> the fetched heads (remote names),
 * pass(why) -> ok, publish?(), doorbell?: { open(signal) }, timers, poll_s, log }) -> { start(), stop(), request(why) }.
 * Each poll: publish (when due), then ls-remote vs the fetched heads; a move is one pass. No state is kept between polls: a failed pass
 * leaves the fetched heads behind, so the next poll retries it.
 */
export function syncLoop({ home, lsRemote, known, pass, publish = null, doorbell = null, timers = TIMERS, poll_s = LOOP.poll_s, log = () => {} }) {
  let timer = null, stopped = false, busy = null, again = null, bell = null;
  function request(why) {
    if (busy) { again = why; return busy; }
    busy = (async () => {
      let ok = false;
      for (let w = why; w && !stopped; w = again) {
        again = null;
        try { ok = !!(await pass(w)); } catch (e) { ok = false; log(`sync loop: pass failed (${w}): ${e.message}`); }
      }
      return ok;
    })().finally(() => { busy = null; });
    return busy;
  }
  async function poll() {
    timer = null;
    if (stopped) return;
    try {
      const id = home();
      if (!id) return;
      if (publish) await publish();
      const [now, had] = await Promise.all([lsRemote(), known()]);
      const moved = movedHeads(had, now, id);
      if (moved.length && !stopped) await request(`moved: ${moved.join(' ')}`);
    } catch (e) { log(`sync loop: poll failed (the next poll retries): ${e.message}`); }
    finally { if (!stopped) timer = timers.setTimeout(poll, poll_s * 1000); }
  }
  return {
    request,
    start() {
      if (doorbell) bell = watchDoorbell({ ...doorbell, home, onRing: r => { request(`ring ${r.h} ${r.sha.slice(0, 10)}`); }, timers, log });
      return poll();
    },
    stop() { stopped = true; if (timer) timers.clearTimeout(timer); timer = null; bell?.stop(); },
  };
}

/** machine.json ledger.doorbell { server?, topic } (read at run time, never stored in the ledger), or null = poll only */
export function doorbellOf(cfg) {
  const d = cfg?.machine_file ? readJsonS(cfg.machine_file)?.ledger?.doorbell : null;
  return d && typeof d.topic === 'string' && d.topic ? { ...(typeof d.server === 'string' ? { server: d.server } : {}), topic: d.topic } : null;
}
/** ring the doorbell with this home's pushed head: never throws -> { off } | { nothing } (never pushed) | { rung: sha } | { error } */
export async function ringHome(cfg0, o = {}) {
  let cfg; try { cfg = synced(cfg0); } catch (e) { return { error: e.message }; }
  const d = cfg && doorbellOf(cfg);
  if (!d) return { off: true };
  const sha = readJsonS(at(cfg, 'manifest'))?.pushed;
  if (!sha) return { nothing: true };
  try { await ringDoorbell(d, { h: cfg.home_id, sha }, o); return { rung: sha }; }
  catch (e) { logTo(cfg, `doorbell ring failed (the other homes poll): ${e.message}`); return { error: e.message }; }
}
/** the publish would do something (cheap: a stat walk, no git) - the loop spawns `norn sync publish` only then */
export function publishDue(cfg0) {
  let cfg; try { cfg = synced(cfg0); } catch { return false; }
  if (!cfg || fs.existsSync(at(cfg, 'stopped'))) return false;
  const { files, stat } = homeWalk(cfg);
  return !idle(readJsonS(at(cfg, 'manifest')), files, stat);
}

const NORN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'norn.mjs');
const ringDetached = cfg => spawn(process.execPath, [NORN, 'sync', 'ring', '--machine', cfg.machine_file], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
const lastLine = r => (r.err || r.out || '').trim().split('\n').pop();
/** a norn CLI child, async: -> { code, out, err } */
export const norn = (args, { env = process.env } = {}) => new Promise(ok => execFile(process.execPath, [NORN, ...args], { env, windowsHide: true, timeout: 600000, maxBuffer: 32 << 20 },
  (e, out, err) => ok({ code: e ? (Number.isInteger(e.code) ? e.code : 1) : 0, out: String(out || ''), err: String(err || '') })));
// bounded (jobguard): the sync loop's ls-remote never leaves a git.exe behind (git-perf S1)
const gitA = async (cfg, args) => {
  const r = await boundedAsync('git', args, { env: { ...process.env, ...(fs.existsSync(cfg.dir) ? { GIT_DIR: cfg.dir } : {}) }, timeout: 60000, maxBuffer: 16 << 20 });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${String(r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n').pop()}`);
  return String(r.stdout);
};

/** the real loop of a ledger config: the dashboard passes its CLI runner (cli), `norn sync watch` the default one and ref-ed timers (they keep
 * its process alive); log defaults to sync.log */
export function loopOf(cfg, { cli = norn, log = s => logTo(cfg, s), transport, timers } = {}) {
  const mf = ['--machine', cfg.machine_file], d = doorbellOf(cfg);
  return syncLoop({
    home: () => { try { return homeIdOf(cfg); } catch (e) { log(`sync loop: ${e.message}`); return null; } },
    lsRemote: async () => parseHeads(await gitA(cfg, ['ls-remote', cfg.remote, ...HEADS])),
    known: async () => { try { return asRemote(parseHeads(await gitA(cfg, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/sync/home/', SYNC_CLAIMS]))); } catch { return {}; } },
    publish: async () => { if (!publishDue(cfg)) return; const r = await cli(['sync', 'publish', ...mf]); log(`sync loop: publish: ${lastLine(r)}`); },
    pass: async why => { const r = await cli(['sync', 'fetch', ...mf]); log(`sync loop: pass (${why}): ${lastLine(r)}`); return r.code === 0; },
    doorbell: d ? { open: signal => doorbellStream(d, { signal, ...(transport ? { transport } : {}) }) } : null, log, ...(timers ? { timers } : {}) });
}

// ---------- S6b: norn sync join (SPEC 8 S6b, sec. 6, sec. 7) ----------
const ghCli = args => { const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 20000 }); return r.status === 0 ? r.stdout : null; };
/**
 * syncJoin(o): this machine joins the synced projects of a ledger remote as home o.home, in S6b's order: (1) access (ls-remote); (2) the
 * ledger repo is PRIVATE (gh; a public one is refused, no answer needs iCheckedPrivate); (3) register homes/<id>.json (S2a); (4) machine.json
 * ledger { remote, home_id, doorbell.topic }; (5) the cut (S1b) of each local project the claims branch names (projects/<p>.json): the dry
 * run shown, then applied; (6) the first publish + fetch (S1c); (7) the collaborator step for the ledger owner. A step already done is
 * skipped, so a re-join is a no-op. A project it cuts that is not paused is paused (by o.by) for the cut and resumed at the end, also after
 * a refusal; the owner's own pause stays. o.dry: steps 1, 2, the id check and each cut's dry run - nothing written. o.bare: this machine is
 * the first home: the given projects are cut --bare (no ledger naming them yet), no collaborator step. o: { home, remote, topic, machineFile,
 * metaRoot, projects [loaded project: name, root, state], bare, dry, by (a pauser: owner | dashboard), iCheckedPrivate, gh ((args) -> stdout
 * | null), openPr, ledgerOpts, now } -> { refused: [why], lines: [text], noop, dry }
 */
export function syncJoin(o) {
  const { home, remote, topic = null, machineFile, metaRoot, projects: mine = [], gh = ghCli, now = Date.now(), bare = false, dry = false, by = 'owner' } = o;
  const lines = [], done = r => ({ refused: [], lines, noop: false, dry, ...r });
  if (!HOME_RE.test(home || '')) return done({ refused: [`home id ${JSON.stringify(home)}: want [a-z][a-z0-9]{0,7}`] });
  // 1. access
  const ls = spawnSync('git', ['ls-remote', remote], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (ls.status !== 0) return done({ refused: [`no access to the ledger remote ${remote}: ${(ls.stderr || '').trim().split('\n').pop()}`] });
  lines.push(`1. access: ${remote} answers`);
  // 2. private (SPEC 7: the ledger holds private state though the code repo is public)
  const slug = ghSlug(remote), priv = slug ? String(gh(['api', `repos/${slug}`, '--jq', '.private']) ?? '').trim() : '';
  if (priv === 'false') return done({ refused: [`the ledger repo ${slug} is PUBLIC: it holds private state (records, mail, runs, NOTES) - make it private, then join`] });
  if (priv === 'true') lines.push(`2. private: ${slug} is private`);
  else if (!o.iCheckedPrivate) return done({ refused: [`gh cannot say whether ${slug || remote} is private: check it by hand, then pass --i-checked-private`] });
  else lines.push(`2. private: WARNING gh cannot say whether ${slug || remote} is private (--i-checked-private): it must stay private`);
  // 3. register (S2a), checked on the fetched claims tip
  const machine = readJsonS(machineFile) || {}, L = machine.ledger || {};
  if (L.remote && L.remote !== remote) return done({ refused: [`machine.json ledger.remote is ${L.remote}, not ${remote}: one ledger repo`] });
  if (L.home_id && L.home_id !== home) return done({ refused: [`this machine is home ${L.home_id} (machine.json ledger.home_id), not ${home}`] });
  const ledger = { ...L, remote, home_id: home, ...(topic ? { doorbell: { ...L.doorbell, topic } } : {}) };
  const cfg = ledgerConfig({ ...machine, ledger }, { metaRoot, machineFile }), fe = fedOf(cfg);
  let claims; try { claims = listClaims(fe); } catch (e) { return done({ refused: [`claims branch: ${e.message}`] }); }
  const joined = bare ? mine : mine.filter(p => claims[projectKey(p.name)]);
  if (!joined.length) return done(bare ? { refused: ['no project to cut as the first home'] } : { refused: [`the ledger names none of this machine's projects (${mine.map(p => p.name).join(', ') || 'none registered'}): the bare home cuts first (norn sync cut --bare)`] });
  if (claims[homeKey(home)] && L.home_id !== home) return done({ refused: [`home id ${home} is taken (claims homes/${home}.json): pick another id`] });
  const cutOf = p => ({ state: p.state, project: p, home, bare, ledger: cfg, machineFile, ledgerOpts: o.ledgerOpts, now, pausing: true, ...(o.openPr ? { openPr: o.openPr } : {}) });
  if (dry) {   // the plan: each cut's dry run (the apply pauses the project itself, so an unpaused one is not refused here)
    const refused = [];
    for (const p of joined) {
      if (homeOf(p.state)?.id === home) { lines.push(`5. ${p.name}: cut before as home ${home}`); continue; }
      const r = syncCut(cutOf(p));
      lines.push(...cutLines(r, { project: p.name, home, apply: false }));
      refused.push(...r.refused);
    }
    return done({ refused });
  }
  const pausedHere = [];
  try { return joinApply(); } finally {
    for (const p of pausedHere) { clearPause(p.state); lines.push(`8. ${p.name}: resumed`); }
  }
  function joinApply() {
    let changed = false;
    if (claims[homeKey(home)]) lines.push(`3. homes/${home}.json: registered before`);
    else {
      const r = registerHome(fe, { id: home, projects: joined.map(p => p.name), now });
      if (r.exists) return done({ refused: [`home id ${home} was taken meanwhile: pick another id`] });
      changed = true; lines.push(`3. registered homes/${home}.json (projects ${joined.map(p => p.name).join(', ')})`);
    }
    // 4. machine.json (the doorbell topic is a machine.json secret, never in the ledger: SPEC 7)
    if (JSON.stringify(ledger) === JSON.stringify(L)) lines.push('4. machine.json ledger: unchanged');
    else { updateMachine(machineFile, () => ({ ledger })); changed = true; lines.push(`4. machine.json ledger: remote, home_id ${home}${topic ? ', doorbell topic' : ''}`); }
    // 5. the cut (S1b), one per joined project: paused here unless the owner paused it, the dry run, then applied (resumed at the end)
    for (const p of joined) {
      if (homeOf(p.state)?.id === home) { lines.push(`5. ${p.name}: cut before as home ${home}`); continue; }
      if (!fs.existsSync(path.join(p.state, 'PAUSED'))) { setPause(p.state, { mode: 'all', by, why: `sync join: the cut as home ${home}` }); pausedHere.push(p); lines.push(`5. ${p.name}: paused for the cut`); }
      const base = cutOf(p);
      const plan = syncCut(base);
      lines.push(...cutLines(plan, { project: p.name, home, apply: false }));
      if (plan.refused.length) return done({ refused: plan.refused });
      const cut = syncCut({ ...base, apply: true });
      lines.push(...cutLines(cut, { project: p.name, home, apply: true, next: false }));
      if (cut.refused.length) return done({ refused: cut.refused });
      changed = true;
    }
    // 6. the first publish + fetch (S1c); a re-join with home/<id> already on the remote ends here
    const published = ls.stdout.split('\n').some(l => l.trim().endsWith(`\trefs/heads/home/${home}`) || l.trim().endsWith(` refs/heads/home/${home}`));
    if (!changed && published) return done({ noop: true, lines: [...lines, `joined before as home ${home}: nothing to do`] });
    const pub = publishHome(cfg);
    if (pub.error || pub.refused || pub.stopped || pub.rejected) return done({ refused: [`publish: ${pub.error || pub.stopped || pub.rejected || `a machine.json secret value in ${pub.refused.join(', ')}`}`] });
    lines.push(`6. publish: home/${home} ${pub.pushed ? 'pushed' : pub.noop ? 'up to date' : `not pushed (${pub.offline}): the next sync pass retries`}`);
    const fx = fetchHomes(cfg);
    if (fx.error) return done({ refused: [`fetch: ${fx.error}`] });
    lines.push(`6. fetch: homes ${fx.homes.join(', ') || 'none'}, ${fx.written.length} cop${fx.written.length === 1 ? 'y' : 'ies'} written`);
    // 7. the collaborator step: the ledger owner gives this home's GitHub account push access (not needed when it is the owner's own account;
    // the first home is the ledger owner's)
    if (bare) return done({});
    const user = slug ? String(gh(['api', 'user', '--jq', '.login']) ?? '').trim() : '';
    lines.push(`7. the ledger owner runs (unless this home uses the owner's own account): gh api -X PUT repos/${slug || '<owner>/<repo>'}/collaborators/${user || '<this home\'s login>'} -f permission=push`);
    return done({});
  }
}
