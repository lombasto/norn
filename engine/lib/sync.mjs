// RM-46 S1c (multi-home SPEC 3.5, 4.1, 4.2): this home's shared logs go to branch home/<id> of the ledger remote; every other home's branch
// comes back as verbatim copies under <state>/homes/<h>/. Publish: the exact bytes of each synced project's (home.json id = machine.json
// ledger.home_id, SPEC 3.1; read from home.json, its copy the cut writes) shared files, secret-scanned and stored through ledger.mjs's blob writer, committed on home/<id> under its own lock and
// pushed WITHOUT force (fast-forward only: a rejection means a second install uses this id - publishing stops). Fetch: home/* and claims in
// one fetch (claimsref's fetchRefs, under the claims lock, since it moves refs/sync/claims too); a copy is written only when its blob
// changed and is never edited. Copies sit outside the backup walk (it enters runs/ and views/ only), so a copy is never published again.
// The fold of the copies and the relay are S1d's; the loop is S4's. Node built-ins + the git binary only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { withLock, homeOf, KINDS } from './records.mjs';
import { writeBlob, secretsOf, ensureLedger } from './ledger.mjs';
import { rgit, fetchRefs, claimsLock } from './claimsref.mjs';
import { fedOf } from './fed.mjs';

// SPEC 3.3 as data: the shared kinds publish their log, the local kinds with a read-only copy publish it under copy/, the rest stay local
const SHARED = ['question', 'decision', 'directive', 'lane', 'item', 'mail', 'waiver'], COPIED = ['run', 'deliverable'];
const logsOf = ks => [...new Set(ks.map(k => KINDS[k].file + '.jsonl'))];
/** what a home branch carries per project: { from: file in the state dir, to: path under <project>/ on home/<id> (and under homes/<h>/) } */
export const HOME_FILES = [{ from: 'home.json', to: 'home.json' }, ...logsOf(SHARED).map(f => ({ from: f, to: f })), { from: 'relay.jsonl', to: 'relay.jsonl' },
  ...logsOf(COPIED).map(f => ({ from: f, to: `copy/${f}` }))];
const HOME_SPEC = '+refs/heads/home/*:refs/sync/home/*';
const SEG = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/, HOME_ID = /^[a-z][a-z0-9]{0,7}$/;

const iso = ms => new Date(ms).toISOString();
const ls = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeAtomic = (f, b) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, b); fs.renameSync(tmp, f); };
const logTo = (cfg, s) => { try { fs.appendFileSync(path.join(cfg.dir, 'sync.log'), `${new Date().toISOString()} ${s}\n`); } catch { /* no dir */ } };
// <ledger>/home-manifest.json { head, pushed, files: { rel: "size:mtime" } } (a no-op pass spawns no git); home-stopped.txt = why
// publishing stopped (remove it once the id is unique); sync-fetch.json { fetched_at, fetch_error, failed_at, gone } (the fetch's own file)
const F = { manifest: 'home-manifest.json', stopped: 'home-stopped.txt', fetch: 'sync-fetch.json' };
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
    try { fs.unlinkSync(index); } catch { /* none */ }
    rgit(f, ['update-index', '--add', '-z', '--index-info'], { index, input: lines.join('\0') + '\0' });
    const tree = rgit(f, ['write-tree'], { index }).out.trim();
    if (head && rgit(f, ['rev-parse', `${head}^{tree}`]).out.trim() === tree) return { head };
    const sha = rgit(f, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `home/${cfg.home_id}: publish\n\n${files.size} files\n`]).out.trim();
    rgit(f, ['update-ref', ref, sha, ...(head ? [head] : [])]);
    return { sha };
  } finally { try { fs.unlinkSync(index); } catch { /* gone */ } }
}

/**
 * publishHome(cfg): this home's shared files onto home/<home_id> and a push without force. Never throws. -> { off } | { noop } |
 * { refused: [rel] } | { stopped: why } | { rejected: why } | { sha?, pushed: true } | { sha?, offline: why } | { error }
 */
export function publishHome(cfg0, o = {}) {
  let cfg; try { cfg = synced(cfg0); } catch (e) { return { error: e.message }; }
  if (!cfg) return { off: true };
  const f = fedOf(cfg), ref = `refs/heads/home/${cfg.home_id}`, now = o.now ?? Date.now();
  try {
    ensureLedger(cfg);
    return withLock(path.join(cfg.dir, 'home.lock'), () => {
      const stopped = fs.existsSync(at(cfg, 'stopped')) ? fs.readFileSync(at(cfg, 'stopped'), 'utf8').trim() : null;
      if (stopped) return { stopped };
      const m = readJson(at(cfg, 'manifest')), { files, stat } = homeWalk(cfg), unchanged = m && same(m.files || {}, stat);
      if ((unchanged && m.pushed === m.head) || (!files.size && !m)) return { noop: true };
      let head = m?.head ?? tipOf(f, ref), sha;
      if (!unchanged) {
        const c = commitHome(cfg, f, ref, head, files);
        if (c.refused) return c;
        sha = c.sha; head = c.sha || c.head;
        writeAtomic(at(cfg, 'manifest'), JSON.stringify({ head, pushed: m?.pushed ?? null, files: stat }));
        if (head === m?.pushed) return { noop: true };
      }
      const r = rgit(f, ['push', '-q', '--porcelain', cfg.remote, `${head}:${ref}`], { ok: [0, 1, 128] });
      if (r.status === 0) {
        rgit(f, ['update-ref', `refs/sync/home/${cfg.home_id}`, head]);
        writeAtomic(at(cfg, 'manifest'), JSON.stringify({ head, pushed: head, files: stat }));
        return { ...(sha ? { sha } : {}), pushed: true };
      }
      const bad = r.out.split('\n').find(l => l.startsWith('!'));
      if (bad && /rejected|non-fast-forward|fetch first/.test(bad)) {
        const why = `push rejected at ${iso(now)}: home/${cfg.home_id} moved on the remote - another install uses home id ${cfg.home_id}? Publishing stopped; remove ${F.stopped} once the id is unique`;
        logTo(cfg, why); fs.writeFileSync(at(cfg, 'stopped'), why + '\n');
        return { rejected: why };
      }
      const why = (r.err || r.out || 'push failed').trim().split('\n').pop();
      logTo(cfg, `push failed (kept local, the next pass retries): ${why}`);
      return { ...(sha ? { sha } : {}), offline: why };
    }, { staleMs: 120000, timeoutMs: o.lockTimeoutMs ?? 20000 });
  } catch (e) { logTo(cfg, `publish failed: ${e.message}`); return { error: e.message }; }
}

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
  const f = fedOf(cfg), now = o.now ?? Date.now(), st = readJson(at(cfg, 'fetch')) || {};
  try {
    ensureLedger(cfg);
    const lk = claimsLock(f);
    withLock(lk.file, () => fetchRefs(f, [HOME_SPEC]), lk.opts);
  } catch (e) {
    const why = e.message.split('\n').pop();
    logTo(cfg, `fetch failed (the last copies stay): ${why}`);
    writeAtomic(at(cfg, 'fetch'), JSON.stringify({ ...st, fetch_error: why, failed_at: iso(now) }));
    return { error: why };
  }
  try {
    const tips = Object.fromEntries(rgit(f, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/sync/home/']).out.split('\n').filter(Boolean)
      .map(l => l.split(' ')).map(([r, sha]) => [r.slice('refs/sync/home/'.length), sha]).filter(([h]) => HOME_ID.test(h) && h !== cfg.home_id));
    const homes = Object.keys(tips).sort(), mine = projects(cfg), written = [];
    for (const h of homes) {
      const ents = rgit(f, ['ls-tree', '-r', '-z', tips[h]]).out.split('\0').filter(Boolean).map(l => { const [meta, rel] = l.split('\t'); return { sha: meta.split(' ')[2], rel }; });
      for (const e of ents) {
        const [p, ...rest] = e.rel.split('/');
        if (!mine.includes(p) || !rest.length || !rest.every(s => SEG.test(s))) continue;
        const dest = path.join(cfg.state_root, p, 'homes', h, ...rest);
        let cur = null; try { cur = fs.readFileSync(dest); } catch { /* new copy */ }
        if (cur && blobSha(cur) === e.sha) continue;
        writeAtomic(dest, blobBytes(f, e.sha));
        written.push(`${p}/homes/${h}/${rest.join('/')}`);
      }
    }
    const gone = mine.flatMap(p => ls(path.join(cfg.state_root, p, 'homes')).filter(d => d.isDirectory() && !tips[d.name]).map(d => `${p}/${d.name}`)).sort();
    writeAtomic(at(cfg, 'fetch'), JSON.stringify({ fetched_at: iso(now), fetch_error: null, failed_at: null, gone }));
    return { homes, written, gone };
  } catch (e) { logTo(cfg, `copies failed: ${e.message}`); return { error: e.message }; }
}

/** what the sync files say (no git, no network): { off } | { error } | { home, remote, head, pushed, stopped, fetched_at, fetch_error, failed_at, gone } */
export function syncStatus(cfg0) {
  let cfg; try { cfg = synced(cfg0); } catch (e) { return { error: e.message }; }
  if (!cfg) return { off: true };
  const m = readJson(at(cfg, 'manifest')) || {}, ft = readJson(at(cfg, 'fetch')) || {};
  let stopped = null; try { stopped = fs.readFileSync(at(cfg, 'stopped'), 'utf8').trim(); } catch { /* publishing */ }
  return { home: cfg.home_id, remote: cfg.remote ? 'set' : null, head: m.head ?? null, pushed: m.pushed ?? null, stopped,
    fetched_at: ft.fetched_at ?? null, fetch_error: ft.fetch_error ?? null, failed_at: ft.failed_at ?? null, gone: ft.gone || [] };
}

/** the publish step of the tick's ledger step and of a run end: never throws; a one-line note or null (off / no-op) */
export function syncStep(cfg, reason, o = {}) {
  const r = publishHome(cfg, o);
  if (r.noop || r.off) return null;
  if (r.error) return `sync: publish failed (${reason}): ${r.error}`;
  if (r.refused) return `sync: publish refused (secret value in ${r.refused.join(', ')})`;
  if (r.stopped || r.rejected) return `sync: publish stopped: ${r.stopped || r.rejected}`;
  if (r.offline) return `sync: publish offline, the next pass pushes (${r.offline})`;
  return `sync: home ${r.sha ? r.sha.slice(0, 10) : 'pushed'} (${reason})`;
}
