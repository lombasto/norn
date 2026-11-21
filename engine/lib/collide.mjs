// lane-collide S1a (SPEC sec. 2, 3, 4A.2): THE collision model - one pure judge for two pieces of open work (intents), whether they are
// two lanes of one home or two homes (claims.mjs imports the claim overlap below: one model from the first commit). No git, no files,
// no clock but the `now` a caller passes. intents.mjs gathers the intents; `norn collide plan` prints what this returns.
//   intent = { lane, run, stage, state: new | queued | running | unlanded, since (ms), role: work | landing | review | helper | none,
//              items: [RM-n], part_of, scope: [globs] | [] (Scope: none) | null (not readable), exclusive: [globs], touched: [paths],
//              commits, branch, tip, dlv, stacked_on: [{ lane, n }], names: { runs, dlvs, lanes }, tests, done, brief }
// Kinds built here: item, territory (grades exclusive > covers > scopes, the commons dropped), order (stacked, planned, named), stale
// (a caveat that names a dead run as running; dead = the proof of death of SPEC 4A.1). First come: a hold only from an intent ahead.
import { globsIntersect, inScope } from './ready.mjs';
import { follow, successorOf } from './after.mjs';
import { POLICY_DEFAULTS } from './policy.mjs';

// ---------- the claim overlap of two homes (moved from claims.mjs; its results are unchanged) ----------
// no Scope: line = the whole repo (multi-home SPEC 5, DECIDED: the safe reading)
export const scopeOf = c => [...(c.scope?.length ? c.scope : ['**']), ...(c.touched || [])];
export const wholeRepo = c => !c.scope?.length || (c.scope.length === 1 && c.scope[0] === '**');
/** the overlap of two work claims: null | { kind: item | branch | scope, what: [the other's items / branch / globs that meet mine] } */
export function overlapOf(a, b) {
  if (a.project !== b.project || a.home === b.home) return null;
  const items = (a.items || []).filter(i => (b.items || []).includes(i));
  if (items.length) return { kind: 'item', what: items };
  if (a.branch && a.branch === b.branch) return { kind: 'branch', what: [a.branch] };
  const sa = scopeOf(a), sb = scopeOf(b);
  return globsIntersect(sa, sb) ? { kind: 'scope', what: sb.filter(g => globsIntersect(sa, [g])) } : null;
}
export const whyOf = h => `${h.kind} overlaps ${h.home}/${h.lane}: ${h.what.join(' ')}${h.kind === 'scope' && h.noScope ? ' (brief has no Scope: line)' : ''}`;
export const verdict = h => ({ [h.kind === 'scope' ? 'queued' : 'refused']: true, hit: h, why: whyOf(h) });

// ---------- policy (S1b: policy.collide, POLICY_DEFAULTS in policy.mjs) ----------
const D = POLICY_DEFAULTS.collide;
const pol = p => ({ ...D, ...(p || {}), kinds: { ...D.kinds, ...(p?.kinds || {}) }, auto: { ...D.auto, ...(p?.auto || {}) } });
/** a project's policy (the whole policy object) -> its policy.collide with the defaults filled in */
export const collidePolicy = policy => pol(policy?.collide);

// ---------- reading a Scope line (SPEC 3.2) ----------
/** a Scope word that names files: holds a '/', a wildcard, or ends in a file extension */
export const pathToken = w => /[/*?]/.test(w) || /\.[A-Za-z0-9]{1,8}$/.test(w);
/** the Scope words of parseReady -> { scope: [globs] | [] (`none` first: writes nothing) | null (no words, or prose words beside the
 *  paths: "the files SPEC.md gives NAV (engine/dash/** at most)" bounds a list kept elsewhere - it is no list itself) } */
export function readScope(words = []) {
  if (!words.length) return { scope: null, why: 'no Scope: line' };
  if (/^none$/i.test(words[0])) return { scope: [] };
  return words.every(pathToken) ? { scope: words } : { scope: null, why: `prose in the Scope line (${words.filter(w => !pathToken(w)).slice(0, 4).join(' ')})` };
}
export const UNREADABLE = 'no machine-readable Scope: territory is judged from changed files only';

// ---------- first come (SPEC 3.3) ----------
const RANK = { running: 0, unlanded: 0, remote: 0, upstream: 0, queued: 1, new: 2 };
/** a is ahead of b: running and unlanded work is ahead of every queued or starting run; between two queued runs the queue order (a tie
 *  in the same millisecond: the older run id, as the fill orders them) */
const runNo = x => Number(String(x.run ?? '').match(/(\d+)$/)?.[1] ?? Infinity);
export const ahead = (a, b) => RANK[a.state] < RANK[b.state] || (a.state === 'queued' && b.state === 'queued' && (a.since < b.since || (a.since === b.since && runNo(a) < runNo(b))));

// ---------- the judge ----------
const literal = g => String(g).split(/[*?]/)[0];
const commonFile = (f, P) => inScope(f, P.commons);
const commonGlob = (g, P) => literal(g).includes('/') && inScope(literal(g) + '\u0000', P.commons);
const uncommon = (globs, P) => (globs || []).filter(g => !commonGlob(g, P));
const files = (fs, P) => (fs || []).filter(f => !commonFile(f, P));
const says = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const held = o => (o.state === 'unlanded' ? `${o.branch ? `branch ${o.branch} ` : ''}not merged${o.dlv ? ` (${o.dlv})` : ''}` : `${o.run ? `${o.run} ` : ''}${o.state}`);
const condOf = o => (o.dlv ? `dlv:${o.dlv}:merged` : o.run ? `run:${o.run}:merged` : null);
const exempt = { item: x => x.role !== 'work', territory: x => ['helper', 'none'].includes(x.role) || (x.scope?.length === 0 && !x.touched?.length), order: x => x.role !== 'work' && x.role !== 'landing' };

/** the territory grade of me against o (strongest first) | null */
function territory(me, o, P, tracked) {
  if (exempt.territory(me) || exempt.territory(o)) return null;
  for (const [x, y] of [[me, o], [o, me]]) {
    const ex = uncommon(x.exclusive, P);
    if (!ex.length) continue;
    const met = files(y.touched, P).filter(f => inScope(f, ex)), scope = uncommon(y.scope, P).filter(g => globsIntersect(ex, [g]));
    if (met.length || scope.length) return { grade: 'exclusive', files: met, by: x === me ? 'me' : 'other', why: `Exclusive: ${ex.join(' ')} of ${x === me ? 'this run' : `lane ${x.lane}`} meets ${x === me ? `lane ${y.lane}'s` : "this run's"} ${met.length ? `changed files ${met.slice(0, 8).join(' ')}` : `Scope ${scope.join(' ')}`}` };
  }
  const cov = (x, y) => (x.scope?.length ? files(y.touched, P).filter(f => inScope(f, x.scope)) : []);
  const mine = cov(me, o), theirs = cov(o, me);
  if (mine.length) return { grade: 'covers', files: mine, why: `Scope ${me.scope.join(' ')} covers ${says(mine.length, 'file')} lane ${o.lane} changes (${held(o)}): ${mine.slice(0, 8).join(' ')}` };
  if (theirs.length) return { grade: 'covers', files: theirs, why: `lane ${o.lane}'s Scope ${o.scope.join(' ')} covers ${says(theirs.length, 'file')} this lane changes: ${theirs.slice(0, 8).join(' ')}` };
  if (!me.scope?.length || !o.scope?.length || !tracked) return null;
  const A = files(tracked, P).filter(f => inScope(f, me.scope)), B = new Set(files(tracked, P).filter(f => inScope(f, o.scope))), shared = A.filter(f => B.has(f));
  if (!shared.length || !(shared.length <= P.narrow_files || shared.length === A.length || shared.length === B.size)) return null;
  return { grade: 'scopes', files: shared, why: `Scope ${me.scope.join(' ')} and lane ${o.lane}'s Scope ${o.scope.join(' ')} share ${says(shared.length, 'tracked file')}${shared.length === A.length || shared.length === B.size ? ' (one lies inside the other)' : ''}` };
}

/** the order grades of me against o: [{ grade, why, after }] */
function order(me, o, items) {
  if (exempt.order(me)) return [];
  const out = [], st = (me.stacked_on || []).find(s => s.lane === o.lane);
  if (st && o.state !== 'new') out.push({ grade: 'stacked', after: condOf(o), why: `branch ${me.branch ?? '(this lane)'} contains ${says(st.n, 'commit')} of lane ${o.lane}'s unmerged branch ${o.branch ?? ''}`.trim() });
  for (const id of (me.items || []).filter(i => (o.items || []).includes(i))) {
    const s = items?.[id]?.stages || [], i = s.indexOf(me.stage), j = s.indexOf(o.stage);
    if (i > 0 && j >= 0 && j < i) out.push({ grade: 'planned', after: condOf(o), why: `${id} plans stage ${me.stage} after ${o.stage}; lane ${o.lane}'s ${o.stage} has not merged (${held(o)})` });
  }
  const n = me.names || {}, named = [o.run && n.runs?.includes(o.run) && o.run, o.dlv && n.dlvs?.includes(o.dlv) && o.dlv, n.lanes?.includes(o.lane) && `lane ${o.lane}`].filter(Boolean);
  if (named.length && !out.length) out.push({ grade: 'named', after: condOf(o), why: `the brief names ${named.join(', ')} (${held(o)})` });
  return out;
}

// ---------- the pair rulings (SPEC 4A.2): wait and allow, the only records the judge reads ----------
/** the key of an unordered lane pair */
export const pairKey = (a, b) => [a, b].sort().join('+');
/** a recorded allow covers this pair for kind k: rulings = { pairKey: { verdict: allow | hold, kinds: [] (all) | [kind] } } */
export const allowedBy = (rulings, a, b, k) => { const r = rulings?.[pairKey(a, b)]; return r?.verdict === 'allow' && (!r.kinds?.length || r.kinds.includes(k)); };

/**
 * collisions(me, others, ctx = { policy, tracked: [paths] | null, items: { RM-n: { stages } }, rulings }) -> [{ kind, grade, other, verdict, why,
 * files, after, pick: recommend() }] - the hits for intent `me`; a pair of one lane never collides (one writer per lane is runs.mjs's).
 */
export function collisions(me, others, ctx = {}) {
  const P = pol(ctx.policy), out = [];
  if (P.enabled === false) return out;
  const loud = (key, o) => { const v = P.kinds[key] ?? 'warn'; return (v === 'hold' || v === 'refuse') && !ahead(o, me) ? 'warn' : v; };
  for (const o of others) {
    if (!o || o.lane === me.lane) continue;
    const add = h => { if (h.verdict !== 'off' && !allowedBy(ctx.rulings, me.lane, o.lane, h.kind)) out.push({ ...h, other: o.lane, pick: recommend(h, me, o) }); };
    const items = exempt.item(me) || exempt.item(o) || me.part_of === o.lane || o.part_of === me.lane ? [] : (me.items || []).filter(i => (o.items || []).includes(i));
    if (items.length) add({ kind: 'item', grade: null, verdict: loud('item', o), items, why: `${items.join(' ')}: lane ${o.lane} holds it (${held(o)}); this run is not a declared part` });
    const t = territory(me, o, P, ctx.tracked);
    if (t) add({ kind: 'territory', ...t, verdict: loud(t.grade === 'exclusive' ? 'exclusive' : 'territory', o) });
    for (const r of order(me, o, ctx.items)) add({ kind: 'order', ...r, verdict: loud(r.grade === 'named' ? 'order_named' : 'order', o) });
  }
  return out;
}

// ---------- SloppaChoppa's pick (SPEC 4A.2: the first row that fits) ----------
const meets = (me, o, P) => !me.scope?.length || uncommon(me.scope, P).some(g => files(o.touched, P).some(f => inScope(f, [g])) || globsIntersect(uncommon(o.exclusive, P), [g]));
const namesAny = (text, fs) => fs.some(f => String(text ?? '').includes(f));
/** recommend(hit, me (B, the later), o (A)) -> { remedy: part | narrow | fold | wait | allow, args, why } */
export function recommend(h, me, o, policy) {
  const P = pol(policy), wait = why => ({ remedy: 'wait', args: { after: condOf(o), lane: o.lane }, why });
  if (h.kind === 'item') {
    if (!meets(me, o, P)) return { remedy: 'part', args: { of: o.lane }, why: 'work on one item in separate files runs in parallel safely' };
    return !me.commits ? { remedy: 'fold', args: { into: o.lane }, why: 'one branch, nothing to port' } : wait(`${me.lane}'s next round builds on lane ${o.lane}'s merged work`);
  }
  if (h.kind === 'territory') {
    if (o.state === 'unlanded') return wait(`landing lane ${o.lane}'s work removes the collision`);
    if (h.grade === 'exclusive') return wait(`a move or rename of lane ${o.lane} cannot be merged by hand cheaply`);
    const theirs = [...new Set([...(o.touched || []), ...(o.exclusive || [])])];
    if (me.state !== 'running' && !namesAny(`${me.tests ?? ''} ${me.done ?? ''}`, theirs))
      return { remedy: 'narrow', args: { drop: theirs.length ? theirs : uncommon(o.scope, P) }, why: 'both run now' };
    return wait(me.state === 'running' ? 'a running run is never stopped for a file overlap' : 'a narrowed Scope would make the task impossible');
  }
  return wait(h.grade === 'named' ? `the brief builds on lane ${o.lane}'s open work` : `this branch builds on lane ${o.lane}'s unmerged work`);
}

// ---------- stale: the proof of death (SPEC 4A.1) and the caveat check ----------
const LIVE = ['running', 'queued', 'claimed'];
const ENDED = ['exited', 'lost', 'killed', 'withdrawn', 'filled'];
/**
 * dead(id, { runs: loadState items, hbAge: id -> ms | null, openDlvRuns: Set of run ids, staleMs }) -> null (alive, or unknown) |
 * { run, state, outcome, at } - ended, no live or queued successor, no fresh heartbeat, no open deliverable
 */
export function dead(id, { runs = {}, hbAge = () => null, openDlvRuns = new Set(), staleMs = 120000 } = {}) {
  const r = runs[id];
  if (!r || !ENDED.includes(r.state)) return null;
  const f = follow(runs, r), s = successorOf(runs, r), alive = x => x && x.id !== r.id && (LIVE.includes(x.state) || (x.id && hbAge(x.id) != null && hbAge(x.id) < staleMs));
  if (alive(f) || alive(s)) return null;
  const age = hbAge(id);
  if ((age != null && age < staleMs) || openDlvRuns.has(id)) return null;
  return { run: id, state: r.state, outcome: r.end?.outcome ?? null, at: r.history?.at(-1)?.ts ?? r.updated ?? null };
}
const LIVE_WORDS = /\b(running|live|in progress|underway|in flight)\b/i;
/** staleCaveats(roadmap items { RM-n: node }, death facts) -> [{ kind: 'stale', grade: 'caveat', item, run, verdict, why, pick }] */
export function staleCaveats(items = {}, facts = {}, policy) {
  const P = pol(policy), out = [];
  for (const n of Object.values(items)) {
    const t = n.caveat?.text;
    if (!t || n.state === 'dropped' || !LIVE_WORDS.test(t)) continue;
    for (const id of new Set(t.match(/\bRUN-(?:[a-z][a-z0-9]{0,7}-)?\d+\b/g) || [])) {
      const d = dead(id, facts);
      if (d && P.kinds.stale !== 'off') out.push({ kind: 'stale', grade: 'caveat', item: n.id, run: id, verdict: P.kinds.stale, text: t,
        why: `${n.id}'s caveat names ${id} as running; ${id} ended${d.at ? ` ${String(d.at).slice(0, 16).replace('T', ' ')}Z` : ''} (${d.outcome ?? d.state})`,
        pick: { remedy: 'correct', args: { item: n.id, run: id }, why: 'Norn adds the fact to the caveat by itself (S1c); the words stay' } });
    }
  }
  return out;
}

// ---------- the words ----------
const REMEDY = {
  part: (a, me) => `part   declare lane ${me.lane} a part of lane ${a.of}'s item; its Scope stays apart from lane ${a.of}'s files`,
  fold: (a, me) => `fold   continue on lane ${a.into}${me.brief ? `: norn run --lane ${a.into}${me.stage ? ` --stage ${me.stage}` : ''} --brief ${me.brief}` : ''}`,
  wait: a => `wait   start when lane ${a.lane}'s work has landed${a.after ? `: norn run ... --queue --after ${a.after}` : ''}`,
  narrow: (a, me, h) => `narrow leave out of this Scope the files lane ${h.other} holds: ${a.drop.slice(0, 8).join(' ')}${a.drop.length > 8 ? ' ...' : ''}`,
  correct: a => `correct  automatic: Norn adds the run's end to ${a.item}'s caveat`,
};
const head = h => `collide: ${h.kind}${h.grade ? ` (${h.grade})` : ''}, ${h.verdict}${h.col ? ` (${h.col})` : ''}`;
/** one hit -> its lines: the head with the evidence, then SloppaChoppa's pick */
export function hitLines(h, me = {}) {
  const pick = h.pick, line = pick && REMEDY[pick.remedy] ? REMEDY[pick.remedy](pick.args || {}, me, h) : null;
  return [`${head(h)}${h.other ? ` - lane ${h.other}` : ''}. ${h.why}`, ...(h.after && h.kind === 'order' && h.verdict === 'hold' ? [`  waits for ${h.after}`] : []),
    ...(line ? [`  SloppaChoppa: ${line} (${pick.why})`] : [])];
}

// ---------- the door (S1b, SPEC 3.4 and 4A.1): the case key, the hold, the worker's line ----------
/** one case per kind + grade + pair while the cause lasts (SPEC 4A.6 key); a = the side ahead (the other lane), b = the run's lane */
export const caseKey = (h, me) => `${h.kind}${h.grade ? '/' + h.grade : ''}:${h.other}>${me.lane}`;
/** the hits that hold a run: verdict hold, from an automatic reaction policy.collide.auto has on (exclusive: hold_exclusive, order: order_after) */
export function holdsOf(hits, policy) {
  const A = pol(policy).auto;
  return hits.filter(h => h.verdict === 'hold' && (h.kind === 'territory' ? A.hold_exclusive : h.kind === 'order' ? A.order_after : true));
}
/** the term the fill walk shows for one hold: the derived condition for order (SPEC 4A.1: after (auto)), the holder for the rest */
export const holdTerm = h => (h.kind === 'order' && h.after ? `after (auto): ${h.after} - ${h.why}` : `collide: ${h.kind}${h.grade ? ` (${h.grade})` : ''}${h.col ? ` (${h.col})` : ''} - waits for lane ${h.other}`);
/** SPEC 5.4: the worker's prompt line for the territory warns of a run that starts (null = none) */
export function workerLine(hits) {
  const t = hits.filter(h => h.kind === 'territory' && h.verdict === 'warn' && h.files?.length);
  if (!t.length) return null;
  const what = t.map(h => `lane ${h.other} changes ${h.files.slice(0, 6).join(', ')}${h.files.length > 6 ? ` (+${h.files.length - 6})` : ''}`).join('; ');
  return `Other open work in your Scope: ${what} (not merged). Do not move or rewrite those files wholesale. If you must change them, say which and why in NOTES.`;
}
// SPEC 4A.3, the allow column (S2a checks the whole menu against policy.collide.apply_by): the lowest role that may allow a kind
const ALLOW_BY = { item: 'controller', goal: 'controller', lead: 'owner', exclusive: 'controller' };
const RANK_OF = { checkin: 0, controller: 1, owner: 2, dashboard: 2 };
/** may role allow a pair past kind k (grade g)? -> null (yes) | why not */
export function allowRefusal(role, k, g) {
  const need = ALLOW_BY[g === 'exclusive' ? 'exclusive' : k] ?? 'checkin';
  if (!(role in RANK_OF)) return `${role} may not allow a collision (checkin, controller or owner)`;
  return RANK_OF[role] < RANK_OF[need] ? `an allow past ${k}${g ? ` (${g})` : ''} is the ${need}'s (SPEC 4A.3); a ${role} may ask for it` : null;
}
