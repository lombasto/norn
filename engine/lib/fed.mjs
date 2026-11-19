// META-GTP-FED (norn DIR-1; GT-PARITY-PLAN 2.10). Federation as PULL agents (GitHub Actions self-hosted runners, Buildkite agents): a node
// pulls work, nobody pushes to it. Gas Town's Wasteland (docs/WASTELAND.md:3-6,16-20,31,148-159,434-450: a shared Dolt DB with claims;
// trust stored, not enforced) is cited, not ported: our shared store is the ledger repo (ledger.mjs).
// Piece 1 - labels: a queued run may carry labels; a machine serves machine.json fed.labels (default: its OS - the GitHub Actions
// runner default label). A run is served where every one of its labels is served (GitHub `runs-on`: all labels must match).
// Node built-ins + the git binary only.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { withLock, fold } from './records.mjs';
import { rgit as fgit, catBatch, fetchRefs, readClaims, casClaims, claimsLock } from './claimsref.mjs';

export class FedError extends Error {}

const LABEL = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const osLabel = (platform = process.platform) => ({ win32: 'windows', darwin: 'macos' }[platform] || platform);

/** "Linux, gpu" -> ['linux', 'gpu']; throws FedError on a bad label */
export function parseLabels(s) {
  if (s === undefined || s === null || s === '') return [];
  const out = String(s).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  for (const l of out) if (!LABEL.test(l)) throw new FedError(`--labels ${JSON.stringify(l)}: want [a-z0-9._-] words (comma-separated)`);
  return [...new Set(out)];
}
export const validLabels = v => Array.isArray(v) && v.every(l => typeof l === 'string' && LABEL.test(l));

/** the labels this machine serves: machine.json fed.labels, else [its OS] */
export function servedLabels(machine) {
  const l = machine?.fed?.labels;
  return Array.isArray(l) && l.length ? [...new Set(l.map(x => String(x).toLowerCase()))] : [osLabel()];
}
/** the labels of `labels` a machine serving `served` lacks ([] = it serves the run) */
export const unserved = (labels = [], served = [osLabel()]) => labels.filter(l => !served.includes(l));
export const hostName = () => (os.hostname() || 'machine').toLowerCase().replace(/[^a-z0-9._-]/g, '-');

// ---------- piece 2: the claim protocol over the ledger repo ----------
// Branch `claims` of the ledger remote holds one file per claimed run: runs/<home host>/<project>/<RUN-n>.json (RM-46 C6: the branch is
// shared with the work claims, claims.mjs). A machine claims by a CAS commit of that file (claimsref.mjs). A rejected push
// is a LOST RACE: never retried in the pass (the kill criterion: a retry would hide a non-CAS). After a rejected push the machine fetches
// and reads the claim once - its own nonce there = the push did land (an ambiguous network end), anything else = lost.
// A node claim carries a lease: heartbeat_at + lease_s (heartbeat = a CAS update of its own file); the home removes an expired claim by
// the same CAS and records it (run `release`). States: claimed | running (a node) | home (the home's own claim: no lease) | done.
// fed endpoint f = { dir: this machine's ledger repo (bare), remote: the ledger remote, host: this machine's name }.
export const claimKey = (home, project, run) => `runs/${home}/${project}/${run}.json`;
// the claims branch next to the machine branches, one fetch (refs/fed/machine/*: the import below)
const fetchFed = f => fetchRefs(f, ['+refs/heads/machine/*:refs/fed/machine/*']);
/** fn under the claims lock of f's repo (claims.mjs takes it too: one lock for fed's and the work claims) */
export const under = (f, fn) => { const l = claimsLock(f); return withLock(l.file, fn, l.opts); };


/**
 * claimRun(f, { home, project, run, labels, lease_s, state, now }) -> { won, key, claim } | { lost, by (null = the tip moved: next pass), why }.
 * One fetch, one CAS push. A claim already there = lost to its holder (its own = won again: a crashed claimer resumes).
 */
export function claimRun(f, { home, project, run, labels = [], lease_s = 900, state = 'claimed', now = Date.now() }, o = {}) {
  return under(f, () => {
    fetchFed(f);
    const key = claimKey(home, project, run);
    const { tip, claims } = readClaims(f);
    const cur = claims[key];
    if (cur) return cur.node === f.host ? { won: true, key, claim: cur, again: true } : { lost: true, by: cur.node ?? null, why: `claimed by ${cur.node ?? '?'}` };
    const at = new Date(now).toISOString();
    const claim = { v: 1, run, home, project, node: f.host, labels, state, nonce: crypto.randomUUID(), claimed_at: at, heartbeat_at: at, ...(state === 'home' ? {} : { lease_s }) };
    const r = casClaims(f, tip, { [key]: claim }, `claim ${home}/${project}/${run} by ${f.host}`, o);
    if (r.ok) return { won: true, key, claim };
    fetchFed(f);   // read the truth once: our own nonce there = the rejected-looking push landed
    const now2 = readClaims(f).claims[key];
    if (now2?.nonce === claim.nonce) return { won: true, key, claim };
    return { lost: true, by: now2?.node ?? null, why: now2 ? `lost the race to ${now2.node}` : `contended (the claims tip moved: ${r.rejected}); the next pass looks again` };
  });
}
/** a CAS update of OUR claim (heartbeat, running, done): { ok, claim } | { gone, by } (not ours any more) | { contended } (tip moved) */
export function updateClaim(f, key, nonce, patch, o = {}) {
  return under(f, () => {
    fetchFed(f);
    const { tip, claims } = readClaims(f), cur = claims[key];
    if (!cur || cur.nonce !== nonce) return { gone: true, by: cur?.node ?? null };
    const claim = { ...cur, ...patch };
    const r = casClaims(f, tip, { [key]: claim }, o.msg || `${patch.state || 'heartbeat'} ${key} by ${f.host}`, o);
    return r.ok ? { ok: true, claim } : { contended: true, why: r.rejected };
  });
}
/** the home removes a claim (expired lease) by CAS, only while it is still the claim with `nonce`: { ok } | { gone } | { contended } */
export function releaseClaim(f, key, nonce, why, o = {}) {
  return under(f, () => {
    if (!o.fetched) fetchFed(f);
    const { tip, claims } = readClaims(f), cur = claims[key];
    if (!cur || cur.nonce !== nonce) return { gone: true };
    const r = casClaims(f, tip, { [key]: null }, `release ${key}: ${why}`, o);
    return r.ok ? { ok: true } : { contended: true, why: r.rejected };
  });
}
/** fetch + read: { key: claim } at the remote's claims tip */
export const fetchClaims = f => under(f, () => { fetchFed(f); return readClaims(f).claims; });
/** a node claim whose lease ran out at `now` (a home claim and a done claim never expire) */
export const leaseExpired = (c, now = Date.now()) => ['claimed', 'running'].includes(c?.state) && Number.isFinite(c.lease_s)
  && Date.parse(c.heartbeat_at) + c.lease_s * 1000 < now;
/** a ledger config (ledger.mjs ledgerConfig / spec.git_ledger) -> the fed endpoint, or null (no remote = no federation) */
export const fedOf = led => (led?.remote && led?.dir ? { dir: led.dir, remote: led.remote, host: String(led.branch || '').replace(/^machine\//, '') || hostName() } : null);

// ---------- piece 3: offers, the machine branches, the import ----------
// The home walk's offered rows (piece 1) as <state>/views/FED-OFFERS.json - in the ledger whitelist (views/**), so the next ledger commit +
// push carries it on machine/<home>; a node claims only these. Rewritten only when its content changes (no ledger churn).
// META-GTP-FED-2 piece 1 (D8, actions/checkout: the job carries everything a runner needs): each offer inlines the brief text and the
// checkout of the run's worktree (its origin + branch), so a node with no shared filesystem runs it from its own workspace (fedws.mjs).
export function writeOffers(state, rows) {
  const file = path.join(state, 'views', 'FED-OFFERS.json');
  const offers = (rows || []).filter(r => r.offer).map(r => {
    let spec = null, brief_text = null;
    try { spec = JSON.parse(fs.readFileSync(path.join(state, 'runs', `${r.id}.queue.json`), 'utf8')); } catch { /* torn: no extras */ }
    try { if (spec?.brief) brief_text = fs.readFileSync(spec.brief, 'utf8'); } catch { /* gone */ }
    return { id: r.id, lane: r.lane ?? null, executor: r.executor ?? null, brief_text, checkout: checkoutOf(spec?.worktree) };
  });
  if (!offers.length && !fs.existsSync(file)) return;
  const body = JSON.stringify({ v: 1, rows: offers }, null, 1) + '\n';
  let cur = null;
  try { cur = fs.readFileSync(file, 'utf8'); } catch { /* none */ }
  if (cur === body) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}
/** what a node without the home filesystem checks out for a run in `worktree`: { repo (its origin URL), branch } | null (no git worktree,
 * no origin, or a detached HEAD: only a node sharing the filesystem through fed.path_map can run it) */
export function checkoutOf(worktree) {
  if (!worktree || !fs.existsSync(worktree)) return null;
  const g = (...a) => { const r = spawnSync('git', ['-C', worktree, ...a], { encoding: 'utf8', windowsHide: true, timeout: 10000 }); return r.status === 0 ? r.stdout.trim() : null; };
  const branch = g('symbolic-ref', '-q', '--short', 'HEAD'), repo = branch ? g('remote', 'get-url', 'origin') : null;
  return branch && repo ? { repo: repo.split('\\').join('/'), branch } : null;
}
/** META-GTP-FED-2 piece 1: a node run's NOTES (`key` on machine/<node>, fetched refs) copied read-only to <state>/fed-notes/<node>/<run>.NOTES.md
 * (outside the ledger whitelist: a node's file never enters the home branch) -> that path | null */
export function importNotes(f, state, node, key, run) {
  if (!key) return null;
  let text;
  try { text = refFiles(f, `refs/fed/machine/${node}`, k => k === key)[key]; } catch { return null; }
  if (typeof text !== 'string') return null;
  const out = path.join(state, 'fed-notes', node, `${run}.NOTES.md`), tmp = `${out}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, out);
  return out;
}
/** the fetched machine branches other than this machine's own: [{ host, ref }] */
export function machineRefs(f) {
  return fgit(f, ['for-each-ref', '--format=%(refname)', 'refs/fed/machine/']).out.split('\n').filter(Boolean)
    .map(ref => ({ ref, host: ref.slice('refs/fed/machine/'.length) })).filter(m => m.host !== f.host);
}
/** the files of `ref` whose key passes `keep`, read: { key: text } (one ls-tree + one cat-file) */
export function refFiles(f, ref, keep) {
  const ents = fgit(f, ['ls-tree', '-r', '-z', ref]).out.split('\0').filter(Boolean).map(l => { const [meta, key] = l.split('\t'); return { sha: meta.split(' ')[2], key }; }).filter(e => keep(e.key));
  const bodies = catBatch(f, ents.map(e => e.sha));
  return Object.fromEntries(ents.map((e, i) => [e.key, bodies[i]]));
}
/** a runs.jsonl text -> its folded items (a torn or foreign line is skipped: the import is read-only and never fails a fill) */
export function foldText(text) {
  const evs = [];
  for (const l of String(text || '').split('\n')) { if (!l.trim()) continue; try { evs.push(JSON.parse(l)); } catch { /* torn */ } }
  return fold(evs).items;
}
/** the runs of `project` on every other machine's branch (fetched refs; no fetch): [{ node, runs: [item] }] - read-only */
export function importForeign(f, project) {
  const out = [];
  for (const m of machineRefs(f)) {
    const files = refFiles(f, m.ref, k => k === `${project}/runs.jsonl` || k.endsWith(`/${project}/runs.jsonl`));
    const runs = Object.values(files).flatMap(t => Object.values(foldText(t))).filter(i => i.kind === 'run');
    if (runs.length) out.push({ node: m.host, runs });
  }
  return out;
}
/** push this machine's ledger branch now (the node's end of run; the tick's push stays async): { ok } | { error } */
export function pushLedger(cfg) {
  const f = { dir: cfg.dir, remote: cfg.remote, host: String(cfg.branch).replace(/^machine\//, '') };
  const r = fgit(f, ['push', '-q', cfg.remote, `refs/heads/${cfg.branch}:refs/heads/${cfg.branch}`], { ok: [0, 1, 128] });
  return r.status === 0 ? { ok: true } : { error: (r.err || '').trim().split('\n').pop() };
}
// ---------- META-GTP-FED-2 piece 2: a node run's usage, counted by the home guard ----------
// Claude on a node shares the account limit (FED-NOTES "Claude on node 2"). Every node run's end record carries node_usage { tokens,
// cache_read }: from the claude final (the fake's is claude-shaped), cache_read only for a run on the Claude account (usageguard onAccount),
// 0 for codex / cli / an own-account executor. The home fill imports node runs into <state>/fed-cache.json (a full rewrite per import); status.mjs
// adds the cache_read of node runs that ended since its anchor (fedCacheR) - one ledger push of lag.
const n0 = v => (Number.isFinite(v) ? v : 0);
/** the end record's adapter fields (claude: raw usage; codex: tokens) -> { tokens, cache_read } */
export function nodeUsage(end, onAccount) {
  const u = end?.usage || {};
  const claude = 'cache_read_input_tokens' in u || 'input_tokens' in u;
  const tokens = claude ? n0(u.input_tokens) + n0(u.cache_read_input_tokens) + n0(u.cache_creation_input_tokens) + n0(u.output_tokens) : n0(end?.tokens ?? u.tokens);
  return { tokens, cache_read: claude && onAccount ? n0(u.cache_read_input_tokens) : 0 };
}
/** the cache_read of the node runs in the fed-cache.json of every project under stateRoot whose end is at or after sinceMs. One key per
 * project / node / run: each cache file is rewritten whole by its fill, so a re-import never counts a run twice. */
export function fedCacheR(stateRoot, sinceMs) {
  if (!stateRoot) return 0;
  let dirs = [];
  try { dirs = fs.readdirSync(stateRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return 0; }
  const seen = new Map();
  for (const p of dirs) {
    let c;
    try { c = JSON.parse(fs.readFileSync(path.join(stateRoot, p, 'fed-cache.json'), 'utf8')); } catch { continue; }
    for (const [node, runs] of Object.entries(c?.nodes || {})) for (const r of runs || []) {
      const e = (r?.history || []).find(h => h.ev === 'end'), ms = Date.parse(e?.ts ?? '');
      if (!(ms >= sinceMs)) continue;
      seen.set(`${p}/${node}/${r.id}`, n0(e.data?.node_usage?.cache_read));
    }
  }
  let sum = 0;
  for (const v of seen.values()) sum += v;
  return sum;
}
/** fetch, then the import (norn runs --all-nodes) */
export const fetchForeign = (f, project) => under(f, () => { fetchFed(f); return importForeign(f, project); });
