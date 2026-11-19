// RM-46 S2a (SPEC 3.6, 4.4, 5): multi-home work claims on the shared `claims` branch (CAS core: claimsref.mjs). One JSON file per entry:
// homes/<id>.json (a home's registration; ids are unique), projects/<p>.json (its bare home), work/<p>/<home>/<lane>.json (a lane that
// writes), allow/<p>/<h~lane>+<h~lane>.json (an owner's pass for one pair). claimWork is the core S2b wires into startRun; renew, fence,
// stale and take over are S2b's. Two claims of different homes overlap by item, branch or scope (ready.mjs globsIntersect): item and
// branch refuse, scope queues. Own claims never block own dispatch. Every CAS round re-reads and re-checks overlap: a rejected push is
// never retried blind (fed's rule F5), and a rejected-looking push that landed is found by nonce + n.
import crypto from 'node:crypto';
import { ClaimsError, fetchRefs, readClaims, casClaims } from './claimsref.mjs';
import { under } from './fed.mjs';
import { globsIntersect } from './ready.mjs';

export const LEASE_S = 3600;
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
          renewed_at: at, lease_s: o.lease_s ?? mine?.lease_s ?? LEASE_S };
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
/** CAS-delete a home's own work claim and the allow files that name it: { ok } | { gone } (no such claim) */
export function releaseWork(f, { project, home, lane }, o = {}) {
  const key = workKey(project, home, lane), ref = `${home}~${lane}`, pre = `allow/${project}/`;
  return under(f, () => rounds(f, claims => {
    if (!claims[key]) return { gone: true, key };
    const edits = { [key]: null };
    for (const k of Object.keys(claims)) if (k.startsWith(pre) && k.slice(pre.length, -'.json'.length).split('+').includes(ref)) edits[k] = null;
    return { edits, msg: `release ${home}/${lane} (${project})`, ok: { ok: true, key, removed: Object.keys(edits) }, landed: c => !c[key] };
  }, o));
}
/** fetch + read every entry of the claims branch: { key: entry } */
export const listClaims = f => under(f, () => { fetchRefs(f); return readClaims(f).claims; });
