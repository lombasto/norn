// RM-46 S2a (SPEC 3.6, 4.4, 5): multi-home work claims on the shared `claims` branch (CAS core: claimsref.mjs). One JSON file per entry:
// homes/<id>.json (a home's registration; ids are unique), projects/<p>.json (its bare home), work/<p>/<home>/<lane>.json (a lane that
// writes), allow/<p>/<h~lane>+<h~lane>.json (an owner's pass for one pair). claimWork is the core startRun calls (S2b: runs.mjs claimDoor);
// S2b adds renew (renewWork), the observer's stale clock (observeClaims / isStale) and the owner's take over (takeWork); the home's own
// bookkeeping (its claims, the n it saw per foreign claim, the runs a claim holds, the digest rows) lives in <state>/sync/*.json. Two claims of different homes overlap by item, branch or scope (ready.mjs globsIntersect): item and
// branch refuse, scope queues. Own claims never block own dispatch. Every CAS round re-reads and re-checks overlap: a rejected push is
// never retried blind (fed's rule F5), and a rejected-looking push that landed is found by nonce + n.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ClaimsError, fetchRefs, readClaims, casClaims } from './claimsref.mjs';
import { under } from './fed.mjs';
import { globsIntersect } from './ready.mjs';
import { syncPolicy } from './policy.mjs';

const ROUNDS = 3, TOUCHED_MAX = 500;
const HOME = /^[a-z][a-z0-9]{0,7}$/, NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/, LANE = /^([a-z][a-z0-9]{0,7})\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/;
const want = (re, v, what) => { if (!re.test(String(v ?? ''))) throw new ClaimsError(`${what} ${JSON.stringify(v)}: not a valid ${what}`); return v; };

export const workKey = (project, home, lane) => `work/${want(NAME, project, 'project')}/${want(HOME, home, 'home')}/${want(NAME, lane, 'lane')}.json`;
export const homeKey = id => `homes/${want(HOME, id, 'home')}.json`;
export const projectKey = project => `projects/${want(NAME, project, 'project')}.json`;
/** the allow file of a pair of `home/lane` refs, either order */
export const allowKey = (project, a, b) => `allow/${want(NAME, project, 'project')}/${[want(LANE, a, 'lane ref'), want(LANE, b, 'lane ref')].sort().map(x => x.replace('/', '~')).join('+')}.json`;

// no Scope: line = the whole repo (SPEC 5, DECIDED: the safe reading)
const scopeOf = c => [...(c.scope?.length ? c.scope : ['**']), ...(c.touched || [])];
const wholeRepo = c => !c.scope?.length || (c.scope.length === 1 && c.scope[0] === '**');
/** past TOUCHED_MAX paths, `touched` keeps one <top dir>/** entry per top folder (a root file stays itself) */
const capTouched = t => (t.length <= TOUCHED_MAX ? t : [...new Set(t.map(p => (p.includes('/') ? p.split('/')[0] + '/**' : p)))]);
/** the overlap of two work claims: null | { kind: item | branch | scope, what: [the other's items / branch / globs that meet mine] } */
export function overlapOf(a, b) {
  if (a.project !== b.project || a.home === b.home) return null;
  const items = (a.items || []).filter(i => (b.items || []).includes(i));
  if (items.length) return { kind: 'item', what: items };
  if (a.branch && a.branch === b.branch) return { kind: 'branch', what: [a.branch] };
  const sa = scopeOf(a), sb = scopeOf(b);
  return globsIntersect(sa, sb) ? { kind: 'scope', what: sb.filter(g => globsIntersect(sa, [g])) } : null;
}
/** the other homes' work claims of the project that overlap `me`, minus allowed pairs; item / branch hits first */
function hitsOf(me, claims) {
  const mine = `${me.home}/${me.lane}`, out = [];
  for (const [key, c] of Object.entries(claims)) {
    if (!key.startsWith(`work/${me.project}/`) || c?.kind !== 'work') continue;
    const o = overlapOf(me, c);
    if (!o || claims[allowKey(me.project, mine, `${c.home}/${c.lane}`)]) continue;
    out.push({ key, home: c.home, lane: c.lane, ...o, noScope: wholeRepo(c) });
  }
  return out.sort((x, y) => (x.kind === 'scope') - (y.kind === 'scope'));
}
const whyOf = h => `${h.kind} overlaps ${h.home}/${h.lane}: ${h.what.join(' ')}${h.kind === 'scope' && h.noScope ? ' (brief has no Scope: line)' : ''}`;
const verdict = h => ({ [h.kind === 'scope' ? 'queued' : 'refused']: true, hit: h, why: whyOf(h) });
const sameSet = (a = [], b = []) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const unchanged = (c, me) => c?.kind === 'work' && c.home === me.home && c.branch === me.branch && sameSet(c.items, me.items) && sameSet(c.scope, me.scope) && sameSet(c.touched, me.touched);
const netErr = e => e instanceof ClaimsError && /^git (fetch|push)\b/.test(e.message);
const UNREACHABLE = 'claim: ledger unreachable', BUSY = 'claims branch busy (3 rejected rounds); the next fill pass tries again';

// up to ROUNDS CAS rounds under the caller's lock. step(claims) -> a result (done, no push) | { edits, msg, ok, landed(claims) }.
// A push that fails on the wire is an unclear end like a rejection: fetch, and landed() decides.
function rounds(f, step, o) {
  let fetched = false;
  for (let i = 0; i < ROUNDS; i++) {
    if (!fetched) fetchRefs(f);
    fetched = false;
    const { tip, claims } = readClaims(f), s = step(claims);
    if (!s.edits) return s;
    let r;
    try { r = casClaims(f, tip, s.edits, s.msg, o); } catch (e) { if (!netErr(e)) throw e; r = { rejected: e.message }; }
    if (r.ok) return s.ok;
    fetchRefs(f);
    fetched = true;
    if (s.landed(readClaims(f).claims)) return s.ok;
  }
  return { queued: true, busy: true, why: BUSY };
}

/**
 * claimWork(f, me = { project, home, lane, branch, items, scope, touched, run }, o = { lease_s, now, precheck, beforePush })
 * -> { won, key, n, claim, again? } | { refused, hit, why } (item / branch) | { queued, why, hit? } (scope, busy, unreachable).
 * The pre-check reads the last fetched claims with no network: an overlap holds, an unchanged own claim is won again.
 */
export function claimWork(f, me0, o = {}) {
  const me = { ...me0, items: me0.items || [], scope: me0.scope?.length ? me0.scope : ['**'], touched: capTouched(me0.touched || []) };
  const key = workKey(me.project, me.home, me.lane), now = o.now ?? Date.now();
  return under(f, () => {
    const decide = claims => {
      const mine = claims[key];
      if (unchanged(mine, me)) return { won: true, again: true, key, n: mine.n, claim: mine };
      const [h] = hitsOf(me, claims);
      return h ? verdict(h) : { mine };
    };
    if (o.precheck !== false) {
      let local = null;
      try { local = readClaims(f).claims; } catch { /* no fetched claims yet */ }
      const d = local && decide(local);
      if (d?.won) return d;
      if (d?.hit) return { queued: true, hit: d.hit, why: d.why };   // hold, no network: keeps the fill quiet
    }
    try {
      return rounds(f, claims => {
        const d = decide(claims);
        if (!('mine' in d)) return d;
        const at = new Date(now).toISOString(), mine = d.mine?.kind === 'work' ? d.mine : null;
        const claim = { v: 1, kind: 'work', project: me.project, home: me.home, lane: me.lane, branch: me.branch ?? null, items: me.items, scope: me.scope,
          touched: me.touched, run: me.run ?? null, nonce: mine?.nonce || crypto.randomUUID(), n: (mine?.n || 0) + 1, claimed_at: mine?.claimed_at || at,
          renewed_at: at, lease_s: o.lease_s ?? mine?.lease_s ?? syncPolicy().lease_s };
        return { edits: { [key]: claim }, msg: `claim ${me.home}/${me.lane} (${me.project}) n=${claim.n}`, ok: { won: true, key, n: claim.n, claim },
          landed: c => c[key]?.nonce === claim.nonce && c[key]?.n === claim.n };
      }, o);
    } catch (e) { if (netErr(e)) return { queued: true, why: UNREACHABLE }; throw e; }
  });
}

// create-once entries (registration, allow): exists = { exists, claim } | the CAS create
const createOnce = (f, key, body, msg, o) => under(f, () => rounds(f, claims => (claims[key] ? { exists: true, key, claim: claims[key] }
  : { edits: { [key]: body }, msg, ok: { ok: true, key, claim: body }, landed: c => JSON.stringify(c[key]) === JSON.stringify(body) }), o));
/** a home registers its id: homes/<id>.json, CAS-created once (a taken id = { exists }) */
export const registerHome = (f, { id, branch, projects = [], now = Date.now() }, o = {}) =>
  createOnce(f, homeKey(id), { v: 1, kind: 'home', id, branch: branch || `home/${id}`, projects, joined_at: new Date(now).toISOString() }, `register home ${id}`, o);
/** a synced project names its repo and bare home: projects/<p>.json, CAS-created once */
export const registerProject = (f, { project, repo, bare_home }, o = {}) =>
  createOnce(f, projectKey(project), { v: 1, kind: 'project', project, repo, bare_home: want(HOME, bare_home, 'home') }, `register project ${project}`, o);
/** the owner lets two claims overlap: allow/<p>/<pair>.json (an existing pass = { exists }) */
export function allowPair(f, { project, a, b, by = 'owner', why = '', now = Date.now() }, o = {}) {
  const key = allowKey(project, a, b), pair = [a, b].sort();
  if (pair[0].split('/')[0] === pair[1].split('/')[0]) throw new ClaimsError(`allow ${a} ${b}: one home's claims never block each other`);
  return createOnce(f, key, { v: 1, kind: 'allow', pair, by, at: new Date(now).toISOString(), why }, `allow ${pair.join(' ')} by ${by}`, o);
}
// a work claim's removal = its file + the allow files that name it (one commit: release, take over)
function dropEdits(claims, project, home, lane) {
  const ref = `${home}~${lane}`, pre = `allow/${project}/`, edits = { [workKey(project, home, lane)]: null };
  for (const k of Object.keys(claims)) if (k.startsWith(pre) && k.slice(pre.length, -'.json'.length).split('+').includes(ref)) edits[k] = null;
  return edits;
}
/** CAS-delete a home's own work claim and the allow files that name it: { ok } | { gone } (no such claim) */
export function releaseWork(f, { project, home, lane }, o = {}) {
  const key = workKey(project, home, lane);
  return under(f, () => rounds(f, claims => {
    if (!claims[key]) return { gone: true, key };
    const edits = dropEdits(claims, project, home, lane);
    return { edits, msg: `release ${home}/${lane} (${project})`, ok: { ok: true, key, removed: Object.keys(edits) }, landed: c => !c[key] };
  }, o));
}

// ---------- S2b (SPEC 4.5): renew, the observer's stale clock, take over ----------
/**
 * renewWork(f, own = { key: { nonce, run?, touched? } }, o = { now }) -> { ok, renewed: { key: n }, gone: [keys], drift: [{ key, hit, why }] }
 * | { offline, why } | { queued, busy, why }. ONE CAS commit bumps n (+ renewed_at, run, touched) of every own claim still ours; a file that
 * is gone or carries another nonce was taken over (gone). New overlap found through touched is drift: a digest row, never a refusal.
 */
export function renewWork(f, own, o = {}) {
  const keys = Object.keys(own), at = new Date(o.now ?? Date.now()).toISOString();
  if (!keys.length) return { ok: true, renewed: {}, gone: [], drift: [] };
  try {
    return under(f, () => rounds(f, claims => {
      const gone = keys.filter(k => claims[k]?.kind !== 'work' || claims[k].nonce !== own[k].nonce), edits = {}, drift = [];
      for (const k of keys.filter(x => !gone.includes(x))) {
        const c = claims[k], next = { ...c, n: c.n + 1, renewed_at: at, run: own[k].run ?? c.run, touched: own[k].touched ? capTouched(own[k].touched) : c.touched };
        const before = new Set(hitsOf(c, claims).map(h => h.key));
        for (const h of hitsOf(next, claims)) if (!before.has(h.key)) drift.push({ key: k, hit: h, why: `scope drift: ${c.home}/${c.lane} now changes files ${h.home}/${h.lane} claims (${h.what.join(' ')})` });
        edits[k] = next;
      }
      const renewed = Object.fromEntries(Object.entries(edits).map(([k, c]) => [k, c.n])), res = { ok: true, renewed, gone, drift };
      if (!Object.keys(edits).length) return res;
      return { edits, msg: `renew ${Object.values(edits).map(c => `${c.home}/${c.lane} n=${c.n}`).join(' ')}`, ok: res,
        landed: c => Object.entries(renewed).every(([k, n]) => c[k]?.nonce === own[k].nonce && c[k]?.n === n) };
    }, o));
  } catch (e) { if (netErr(e)) return { offline: true, why: UNREACHABLE }; throw e; }
}
/** the observer's clock (SPEC 4.5): { key: { n, first_seen_ms } } of every other home's work claim - a new n restarts its timer, a gone file leaves */
export function observeClaims(claims, seen = {}, { home, now = Date.now() }) {
  const out = {};
  for (const [k, c] of Object.entries(claims)) if (c?.kind === 'work' && c.home !== home) out[k] = seen[k]?.n === c.n ? seen[k] : { n: c.n, first_seen_ms: now };
  return out;
}
const staleAfterS = (c, pol) => (c.lease_s ?? pol.lease_s) + pol.stale_grace_s;
/** stale = its n unchanged for lease_s + stale_grace_s on THIS home's clock since it first saw that n (clock offset cancels out) */
export const isStale = (seen, c, now, pol = syncPolicy()) => !!seen && !!c && seen.n === c.n && now - seen.first_seen_ms >= staleAfterS(c, pol) * 1000;
/** the owner takes over another home's STALE work claim: { ok, key, claim } | { gone } | { notStale, why } (CAS delete + its allow files) */
export function takeWork(f, { project, home, lane, seen = {}, now = Date.now(), pol = syncPolicy(), by = 'owner' }, o = {}) {
  const key = workKey(project, home, lane);
  return under(f, () => rounds(f, claims => {
    const c = claims[key];
    if (!c) return { gone: true, key };
    if (!isStale(seen[key], c, now, pol)) {
      const forS = seen[key]?.n === c.n ? Math.floor((now - seen[key].first_seen_ms) / 1000) : 0;
      return { notStale: true, key, why: `${home}/${lane} is not stale: n=${c.n} unchanged for ${forS} s on this home's clock (stale after ${staleAfterS(c, pol)} s)` };
    }
    return { edits: dropEdits(claims, project, home, lane), msg: `take over ${home}/${lane} (${project}) by ${by}: stale at n=${c.n}`, ok: { ok: true, key, claim: c }, landed: x => !x[key] };
  }, o));
}
/** the claims as last fetched (no network; {} before the first fetch) */
export const localClaims = f => { try { return readClaims(f).claims; } catch { return {}; } };

// ---------- the home's own bookkeeping: <state>/sync/<file> (local, never published) ----------
// own: { key: { project, home, lane, nonce, n, confirmed_ms } } (confirmed_ms = this clock when a claim / renew push landed: the fence);
// seen: the observer's clock; holds: { RUN-n: { why, home, lane, kind } } (queued runs a claim holds); rows: { rows: [digest rows] }
export const SYNC_FILES = { own: 'claims-own.json', seen: 'claims-seen.json', holds: 'claim-holds.json', rows: 'claims-digest.json' };
const syncPath = (state, name) => path.join(state, 'sync', SYNC_FILES[name]);
export const readSync = (state, name) => { try { return JSON.parse(fs.readFileSync(syncPath(state, name), 'utf8')) || {}; } catch { return {}; } };
export function writeSync(state, name, v) {
  const p = syncPath(state, name), tmp = `${p}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, p);
}
/** read-modify-write of one sync file -> the new value */
export const updateSync = (state, name, fn) => { const v = fn(readSync(state, name)); writeSync(state, name, v); return v; };
/** fetch + read every entry of the claims branch: { key: entry } */
export const listClaims = f => under(f, () => { fetchRefs(f); return readClaims(f).claims; });
