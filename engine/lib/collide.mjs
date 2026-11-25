// lane-collide S1a (SPEC sec. 2, 3, 4A.2): THE collision model - one pure judge for two pieces of open work (intents), whether they are
// two lanes of one home or two homes (claims.mjs imports the claim overlap below: one model from the first commit). No git, no files,
// no clock but the `now` a caller passes. intents.mjs gathers the intents; `norn collide plan` prints what this returns.
//   intent = { lane, run, stage, state: new | queued | running | unlanded, since (ms), role: work | landing | review | helper | none,
//              items: [RM-n], part_of, scope: [globs] | [] (Scope: none) | null (not readable), exclusive: [globs], touched: [paths],
//              commits, branch, tip, dlv, stacked_on: [{ lane, n }], names: { runs, dlvs, lanes }, tests, done, brief }
// Kinds built here: item, territory (grades exclusive > conflict > same-files > covers > scopes, the commons dropped; conflict from the tick's merge-tree), order (stacked, planned, named), stale
// (a caveat that names a dead run as running; dead = the proof of death of SPEC 4A.1, of a run and of a lane). First come: a hold only
// from an intent ahead. S1c: the land-first wait (a hold that ends by itself), the caveat suffix. S2a: the remedy menu and who may apply
// it (APPLY_BY, policy.collide.apply_by), the judge reads a recorded wait and part, narrowScope for norn collide narrow.
// S2b: fold - foldRefusal, the FOLDED-<lane>.md text (foldedText; foldedSources reads its exact bytes back) and the kept lane's prompt line.
// S3: the outcome (closeCause, realOf), the demotion of an automatic class, the replay's pairs and the report (tick.mjs and norn.mjs gather their facts).
import { globsIntersect, inScope } from './ready.mjs';
import { follow, successorOf } from './after.mjs';
import { POLICY_DEFAULTS } from './policy.mjs';
import { NID } from './records.mjs';

// records.mjs validates a collision action's why at max 600 (`str(d.why, 'why', { max: 600 })`, no exported constant): a longer why
// threw a RecordError and aborted the whole tick, so every why built here stays at or under this
export const WHY_MAX = 600;
/** a list as a reader needs it: the first items (at most n, at least one, within `room` chars), then "+N more" - two lists and the words
 *  of a why fit under WHY_MAX */
const few = (xs, n = 8, room = 200) => {
  let k = 0, len = 0;
  while (k < Math.min(n, xs.length) && (k === 0 || len + 1 + String(xs[k]).length <= room)) len += (k ? 1 : 0) + String(xs[k++]).length;
  return k < xs.length ? `${xs.slice(0, k).join(' ')} +${xs.length - k} more` : xs.join(' ');
};
/** the last guard: a why longer than the record limit is cut (long single items) */
const bound = s => (s.length > WHY_MAX ? `${s.slice(0, WHY_MAX - 3)}...` : s);

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
export const whyOf = h => bound(`${h.kind} overlaps ${h.home}/${h.lane}: ${few(h.what)}${h.kind === 'scope' && h.noScope ? ' (brief has no Scope: line)' : ''}`);
export const verdict = h => ({ [h.kind === 'scope' ? 'queued' : 'refused']: true, hit: h, why: whyOf(h) });

// ---------- policy (S1b: policy.collide, POLICY_DEFAULTS in policy.mjs) ----------
const D = POLICY_DEFAULTS.collide;
const pol = p => ({ ...D, ...(p || {}), kinds: { ...D.kinds, ...(p?.kinds || {}) }, auto: { ...D.auto, ...(p?.auto || {}) }, demote: { ...D.demote, ...(p?.demote || {}) } });
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

/** the territory grade of me against o (strongest first) | null. conflicts: { 'tipA tipB' (sorted): { conflict, files } } - the tick's
 *  merge-tree answers for pairs that share changed files (overlap.mjs laneConflicts) */
function territory(me, o, P, tracked, conflicts) {
  if (exempt.territory(me) || exempt.territory(o)) return null;
  for (const [x, y] of [[me, o], [o, me]]) {
    const ex = uncommon(x.exclusive, P);
    if (!ex.length) continue;
    const met = files(y.touched, P).filter(f => inScope(f, ex)), scope = uncommon(y.scope, P).filter(g => globsIntersect(ex, [g]));
    if (met.length || scope.length) return { grade: 'exclusive', files: met, by: x === me ? 'me' : 'other', why: `Exclusive: ${few(ex, 4)} of ${x === me ? 'this run' : `lane ${x.lane}`} meets ${x === me ? `lane ${y.lane}'s` : "this run's"} ${met.length ? `changed files ${few(met)}` : `Scope ${few(scope, 4)}`}` };
  }
  const m = me.tip && o.tip ? conflicts?.[[me.tip, o.tip].sort().join(' ')] : null;
  if (m?.conflict) return { grade: 'conflict', files: m.files, why: `merging lane ${o.lane}'s branch${o.branch ? ` ${o.branch}` : ''} with this one conflicts (git merge-tree): ${few(m.files)}` };
  const mineT = new Set(files(me.touched, P)), same = files(o.touched, P).filter(f => mineT.has(f));
  if (same.length) return { grade: 'same-files', files: same, why: `both change ${says(same.length, 'file')} (lane ${o.lane}: ${held(o)}): ${few(same)}` };
  const cov = (x, y) => (x.scope?.length ? files(y.touched, P).filter(f => inScope(f, x.scope)) : []);
  const mine = cov(me, o), theirs = cov(o, me);
  if (mine.length) return { grade: 'covers', files: mine, why: `Scope ${few(me.scope, 4)} covers ${says(mine.length, 'file')} lane ${o.lane} changes (${held(o)}): ${few(mine)}` };
  if (theirs.length) return { grade: 'covers', files: theirs, why: `lane ${o.lane}'s Scope ${few(o.scope, 4)} covers ${says(theirs.length, 'file')} this lane changes: ${few(theirs)}` };
  if (!me.scope?.length || !o.scope?.length || !tracked) return null;
  const A = files(tracked, P).filter(f => inScope(f, me.scope)), B = new Set(files(tracked, P).filter(f => inScope(f, o.scope))), shared = A.filter(f => B.has(f));
  if (!shared.length || !(shared.length <= P.narrow_files || shared.length === A.length || shared.length === B.size)) return null;
  return { grade: 'scopes', files: shared, why: `Scope ${few(me.scope, 4)} and lane ${o.lane}'s Scope ${few(o.scope, 4)} share ${says(shared.length, 'tracked file')}${shared.length === A.length || shared.length === B.size ? ' (one lies inside the other)' : ''}` };
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
/** S2a: a recorded wait holds lane me behind lane o for kind k -> the case's COL id | null. Only a start or a queued run waits: a running
 *  run is never held (SPEC 4A.4 standing rules); the hold ends when o's work merges (o is no intent then: no hit, no hold) */
export const waitedBy = (rulings, me, o, k) => { const r = rulings?.[pairKey(me.lane, o)];
  return r?.verdict === 'hold' && r.waiter === me.lane && ['new', 'queued'].includes(me.state) && (!r.kinds?.length || r.kinds.includes(k)) ? r.col : null; };
/** S2a: one lane of the pair is a declared part of the other's item (norn collide part: the part_of field of lane B) */
export const partBy = (rulings, a, b) => { const p = rulings?.[pairKey(a, b)]?.part; return !!p && ((p.lane === a && p.of === b) || (p.lane === b && p.of === a)); };

/** SPEC 4A.1 the land-first wait: a starting or queued run whose territory warn (covers, same-files) meets a DONE deliverable not merged
 *  waits up to auto.land_wait_min from its queue time while the merge queue lands it -> { until (ms), dlv } | null */
const landWait = (h, me, o, P, now) => {
  const min = Number(P.auto.land_wait_min) || 0;
  return min > 0 && h.verdict === 'warn' && ['covers', 'same-files'].includes(h.grade) && o.state === 'unlanded' && o.dlv && ['new', 'queued'].includes(me.state)
    && now - me.since < min * 6e4 ? { until: me.since + min * 6e4, min, dlv: o.dlv } : null;
};
/**
 * collisions(me, others, ctx = { policy, tracked: [paths] | null, items: { RM-n: { stages } }, rulings, conflicts, now }) -> [{ kind, grade, other,
 * verdict, why, files, after, land, pick: recommend() }] - the hits for intent `me`; a pair of one lane never collides (one writer per lane is runs.mjs's).
 */
export function collisions(me, others, ctx = {}) {
  const P = pol(ctx.policy), out = [];
  if (P.enabled === false) return out;
  const loud = (key, o) => { const v = P.kinds[key] ?? 'warn'; return (v === 'hold' || v === 'refuse') && !ahead(o, me) ? 'warn' : v; };
  for (const o of others) {
    if (!o || o.lane === me.lane) continue;
    const add = h => { if (h.verdict === 'off' || allowedBy(ctx.rulings, me.lane, o.lane, h.kind)) return; const w = waitedBy(ctx.rulings, me, o.lane, h.kind);
      out.push({ ...h, ...(w ? { verdict: 'hold', ruled: w } : {}), why: bound(h.why), other: o.lane, pick: recommend(h, me, o, ctx.policy) }); };
    const items = exempt.item(me) || exempt.item(o) || me.part_of === o.lane || o.part_of === me.lane || partBy(ctx.rulings, me.lane, o.lane) ? [] : (me.items || []).filter(i => (o.items || []).includes(i));
    if (items.length) add({ kind: 'item', grade: null, verdict: loud('item', o), items, why: `${few(items)}: lane ${o.lane} holds it (${held(o)}); this run is not a declared part` });
    const t = territory(me, o, P, ctx.tracked, ctx.conflicts);
    if (t) { const h = { kind: 'territory', ...t, verdict: loud(t.grade === 'exclusive' ? 'exclusive' : 'territory', o) }, land = landWait(h, me, o, P, ctx.now ?? Date.now());
      add(land ? { ...h, verdict: 'hold', land } : h); }
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
    for (const id of new Set(t.match(new RegExp(`\\b${NID('RUN')}\\b`, 'g')) || [])) {
      if (noted(t, id)) continue;
      const d = dead(id, facts);
      if (d && P.kinds.stale !== 'off') out.push({ kind: 'stale', grade: 'caveat', item: n.id, run: id, verdict: P.kinds.stale, text: t,
        why: `${n.id}'s caveat names ${id} as running; ${id} ended${d.at ? ` ${String(d.at).slice(0, 16).replace('T', ' ')}Z` : ''} (${d.outcome ?? d.state})`, dead: d,
        pick: { remedy: 'correct', args: { item: n.id, run: id }, why: 'Norn adds the fact to the caveat by itself (S1c); the words stay' } });
    }
  }
  return out;
}

const stamp = t => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toISOString().slice(5, 16).replace('T', ' ') + 'Z' : '?'; };
const noted = (text, id) => text.includes(`: ${id} ended `);
/** SPEC 4A.1: the fact a stale caveat gains (its words stay): " [norn 11-20 21:04Z: RUN-2984 ended 11-19 22:10Z, stopped]" */
export const caveatSuffix = (d, now) => ` [norn ${stamp(now)}: ${d.run} ended ${stamp(d.at)}, ${d.outcome ?? d.state}]`;
/** SPEC 4A.1 the proof of death of a lane: no live or queued run, no open deliverable (neither is an open intent), a clean worktree and a
 *  branch tip unchanged for recent_days -> null (dead) | why it is alive. f = { open: bool, live: bool, dirty: bool | null (no worktree),
 *  tipAt: ms | null } */
export function laneAlive(f, now, policy) {
  const P = pol(policy);
  if (f.live) return 'a run is live or queued';
  if (f.open) return 'open work (a deliverable, or a branch with a recent run)';
  if (f.dirty) return 'uncommitted changes in its worktree (work at risk)';
  if (f.tipAt != null && now - f.tipAt < P.recent_days * 864e5) return `its branch tip moved within ${P.recent_days} days`;
  return null;
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
  return hits.filter(h => h.verdict === 'hold' && (h.land || h.ruled ? true : h.kind === 'territory' ? A.hold_exclusive : h.kind === 'order' ? A.order_after : true));
}
/** the term the fill walk shows for one hold: the derived condition for order (SPEC 4A.1: after (auto)), the holder for the rest */
export const holdTerm = h => (h.kind === 'order' && h.after ? `after (auto): ${h.after} - ${h.why}`
  : h.land ? `collide: territory (${h.grade}) land-first: waits up to ${h.land.min} min for ${h.land.dlv} of lane ${h.other}${h.col ? ` (${h.col})` : ''}` : `collide: ${h.kind}${h.grade ? ` (${h.grade})` : ''}${h.col ? ` (${h.col})` : ''} - waits for lane ${h.other}${h.ruled ? ` (a wait, ${h.ruled})` : ''}`);
/** SPEC 5.4: the worker's prompt line for the territory warns of a run that starts (null = none) */
export function workerLine(hits) {
  const t = hits.filter(h => h.kind === 'territory' && h.verdict === 'warn' && h.files?.length);
  if (!t.length) return null;
  const what = t.map(h => `lane ${h.other} changes ${h.files.slice(0, 6).join(', ')}${h.files.length > 6 ? ` (+${h.files.length - 6})` : ''}`).join('; ');
  return `Other open work in your Scope: ${what} (not merged). Do not move or rewrite those files wholesale. If you must change them, say which and why in NOTES.`;
}
// ---------- S2a: the remedy menu and who may apply it (SPEC 4A.2, 4A.3: policy.collide.apply_by) ----------
// per kind (exclusive = territory / exclusive) the lowest role that may apply each remedy; a remedy missing from a row is not on the
// menu for that kind. The 'automatic' cells of 4A.3 (a wait on exclusive, resource, order) are Norn's: a check-in may still record one.
// any = a ruling on a pair with no case (norn collide allow <a> <b>): the caller judges its kinds one by one.
export const APPLY_BY = {
  item: { wait: 'checkin', part: 'checkin', fold: 'controller', allow: 'controller' },
  lead: { wait: 'checkin', part: 'owner', fold: 'controller', allow: 'owner' },
  goal: { wait: 'checkin', part: 'controller', fold: 'controller', allow: 'controller' },
  exclusive: { wait: 'checkin', narrow: 'controller', allow: 'controller' },
  territory: { wait: 'checkin', narrow: 'checkin', allow: 'checkin' },
  resource: { wait: 'checkin', allow: 'checkin' },
  order: { wait: 'checkin', allow: 'checkin' },
  stale: {},
  any: { allow: 'checkin' },
};
export const REMEDIES = ['part', 'narrow', 'fold', 'wait', 'allow'];
const ROLES = ['checkin', 'controller', 'owner'];
const RANK_OF = { checkin: 0, controller: 1, owner: 2, dashboard: 2 };
const menuKey = (k, g) => (k === 'territory' && g === 'exclusive' ? 'exclusive' : k);
/** the role a remedy of kind k (grade g) needs -> checkin | controller | owner | null (not on the menu). policy.collide.apply_by may move a
 *  cell (a project whose check-ins rule like the controller lowers its cells to checkin); an owner's cell stays the owner's */
export function applyNeed(remedy, k, g, policy) {
  const key = menuKey(k, g), base = APPLY_BY[key]?.[remedy] ?? null, set = pol(policy).apply_by?.[key]?.[remedy];
  return base && base !== 'owner' && ROLES.includes(set) ? set : base;
}
/** the menu of kind k (grade g): the remedies with a cell, in the order of SPEC 4A.2 */
export const menuOf = (k, g, policy) => REMEDIES.filter(r => applyNeed(r, k, g, policy));
/** may role apply remedy to kind k (grade g)? -> null (yes) | why not */
export function applyRefusal(role, remedy, k, g, policy) {
  if (!(role in RANK_OF)) return `${role} may not apply a remedy (checkin, controller or owner)`;
  const need = applyNeed(remedy, k, g, policy), what = `${k}${g ? ` (${g})` : ''}`;
  if (!need) return `${remedy} is not on the menu for ${what} (${menuOf(k, g, policy).join(', ') || 'nothing: Norn corrects it by itself'})`;
  return RANK_OF[role] < RANK_OF[need] ? `${remedy === 'allow' ? 'an allow past' : `${remedy} on`} ${what} is the ${need}'s (SPEC 4A.3); a ${role} may ask for it (norn collide ask COL-n --want ${remedy})` : null;
}
/** a remedy in the controller's or the owner's column is a recorded decision (DEC-n) */
export const needsDecision = (remedy, k, g, policy) => ['controller', 'owner'].includes(applyNeed(remedy, k, g, policy));
/** may lane B (me) become a declared part of lane A's (o) item? Its Scope is readable and meets none of A's changed files or Exclusive:
 *  globs outside the commons -> null | why not (the text names narrow or wait) */
export function partRefusal(me, o, policy) {
  if (!me.scope?.length) return `lane ${me.lane}'s Scope is not readable${me.scope_why ? ` (${me.scope_why})` : ''}: a part needs a Scope apart from lane ${o.lane}'s files - wait, or narrow it first`;
  return meets(me, o, pol(policy)) ? `lane ${me.lane}'s Scope ${few(me.scope, 4)} meets lane ${o.lane}'s changed files or Exclusive: globs - narrow it first, or wait` : null;
}

// ---------- S2a: narrowScope (SPEC 4A.4 narrow) ----------
const slash = p => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
/** the folder a glob stands for -> 'X' (X/** or a bare X) | '' (**, the whole repo) | null (another wildcard) */
const folderOf = g => (g === '**' ? '' : /^[^*?]*\/\*\*$/.test(g) ? g.slice(0, -3) : /[*?]/.test(g) ? null : g);
/** the free entries of folder dir: the folder whole when none of its files is taken, else its children one level down */
function freeIn(dir, fs, taken) {
  if (!fs.some(f => taken.has(f))) return [`${dir ? dir + '/' : ''}**`];
  const kids = new Map(), pre = dir ? dir + '/' : '';
  for (const f of fs) { const k = f.slice(pre.length).split('/')[0]; kids.set(k, [...(kids.get(k) || []), f]); }
  return [...kids.keys()].sort().flatMap(k => { const xs = kids.get(k), p = pre + k; return xs.length === 1 && xs[0] === p ? (taken.has(p) ? [] : [p]) : freeIn(p, xs, taken); });
}
/** narrowScope(scope, taken (A's files), tracked (git ls-files)) -> { scope, dropped }: a glob that matches none of the taken files stays;
 *  one that does is split a folder level at a time into the folders and files that are free (a wildcard that is no folder: into its free
 *  tracked files). dropped = the taken files the old Scope covered */
export function narrowScope(scope, taken, tracked) {
  const T = new Set(taken.map(slash)), tr = (tracked || []).map(slash), out = [], dropped = new Set();
  for (const g0 of scope) {
    const g = slash(g0), hit = [...T].filter(f => inScope(f, [g]));
    if (!hit.length) { out.push(g0); continue; }
    hit.forEach(f => dropped.add(f));
    const dir = folderOf(g), all = [...new Set([...tr.filter(f => inScope(f, [g])), ...hit])].sort();
    if (dir === null) out.push(...all.filter(f => !T.has(f)));
    else if (!(all.length === 1 && all[0] === dir)) out.push(...freeIn(dir, all, T));
  }
  return { scope: [...new Set(out)], dropped: [...dropped].sort() };
}
/** the files of lane o a narrow leaves out of a Scope: its changed files and the tracked files of its Exclusive: globs, outside the commons */
export function takenBy(o, tracked, policy) {
  const P = pol(policy), ex = uncommon(o.exclusive, P);
  return [...new Set([...files(o.touched, P), ...(ex.length ? files(tracked, P).filter(f => inScope(f, ex)) : [])])];
}
/** the dropped files a Ready line (Tests: or Done:) of me names */
export const namesDropped = (me, dropped) => dropped.filter(f => `${me.tests ?? ''} ${me.done ?? ''}`.includes(f));

// ---------- S2b: fold (SPEC 4A.4 fold: keep A, fold B's brief and notes into it, end B) ----------
/** may role fold lane B (lane) into lane `into`? -> null | why not. Never across homes, into an archived lane or for a lane that leads
 *  parts of its own; an empty fold (no commits of its own, no live run) needs only the check-in for every kind on the menu (4A.3) */
export function foldRefusal({ role, kind, grade = null, lane, into, homes = [], leads = [], commits = 0, live = null, keepArchived = false, col = 'COL-n', policy } = {}) {
  if (new Set(homes.filter(Boolean)).size > 1) return `lanes of two homes (${homes.join(', ')}): a home cannot fold another home's lane - wait, narrow or allow`;
  if (keepArchived) return `lane ${into} is archived: unarchive it first (controller or owner), or fold it into a live lane`;
  if (leads.length) return `lane ${lane} leads parts of its own (${leads.join(', ')}): fold or re-link them first`;
  if (!applyNeed('fold', kind, grade, policy)) return applyRefusal(role, 'fold', kind, grade, policy);
  if (role === 'checkin' && (commits || live)) return `a check-in folds only an empty lane: lane ${lane} has ${live ? `a live run ${live}` : `${commits} commit${commits === 1 ? '' : 's'} of its own`} - ask the controller (norn collide ask ${col} --want fold)`;
  return role === 'checkin' ? null : applyRefusal(role, 'fold', kind, grade, policy);
}
const fenceFor = t => '~'.repeat(Math.max(4, ...[...String(t).matchAll(/~+/g)].map(m => m[0].length + 1)));
/** FOLDED-<B>.md: the folded lane's objective, branch and commits not on main, open questions, decisions and roadmap links, then each source
 *  text verbatim (its path and sha256; a tilde fence longer than any run inside, so foldedSources reads back the exact bytes) */
export function foldedText({ lane, into, col, at, by, why, objective, branch, tip, commits = [], questions = [], decisions = [], links = [], sources = [] }) {
  const list = (xs, none) => (xs.length ? xs.map(x => `- ${x}`) : [none]);
  return [`# FOLDED-${lane}: lane ${lane} folded into lane ${into} (${col})`, '', `${at} by ${by}: ${why}`,
    'The texts below are copies of the sources named; the sources are never moved, edited or deleted.', '',
    '## Objective', objective || '(no brief heading)', '',
    '## Branch', branch ? `${branch} at ${tip ?? '?'}: ${commits.length} commit${commits.length === 1 ? '' : 's'} not on main` : 'no worktree on record', ...list(commits, '').filter(Boolean), '',
    '## Open questions', ...list(questions, '(none)'), '', '## Decisions', ...list(decisions, '(none)'), '', '## Roadmap links', ...list(links, '(none)'), '',
    '## Sources', ...sources.flatMap(s => { const f = fenceFor(s.text); return [`### ${s.kind}: ${s.path}`, `sha256 ${s.sha256}, ${Buffer.byteLength(s.text)} bytes`, f, s.text, f]; }), ''].join('\n');
}
/** the sources of a FOLDED-<B>.md text -> [{ kind, path, sha256, text }] (text: the exact copy) */
export function foldedSources(md) {
  const out = [], at = md.indexOf('\n## Sources\n');
  if (at < 0) return out;
  const re = /### (\w+): (.+)\nsha256 ([0-9a-f]{64}), \d+ bytes\n(~{4,})\n/g;
  re.lastIndex = at;
  for (let m; (m = re.exec(md));) {
    const start = re.lastIndex, end = md.indexOf(`\n${m[4]}\n`, start);
    if (end < 0) break;
    out.push({ kind: m[1], path: m[2], sha256: m[3], text: md.slice(start, end) });
    re.lastIndex = end + m[4].length + 2;
  }
  return out;
}
/** the prompt line of every start on the kept lane until a run there ended DONE (SPEC 4A.4 fold step 4) */
export const foldLine = ({ lane, col, branch, commits = 0 }) => `Lane ${lane} was folded into this lane (${col}). Read FOLDED-${lane}.md first.`
  + (commits ? ` Branch ${branch} has ${commits} commit${commits === 1 ? ' that is' : 's that are'} not on main: merge it into your branch first (\`git merge\`, a merge commit).` : '');

// ---------- S3 (SPEC 4A.6): the outcome, the demotion, the replay and the report ----------
const DAY_MS = 864e5;
const undoneIx = c => new Set((c.history || []).filter(h => h.ev === 'undo').map(h => h.data?.action));
/** the actions of a case (history entries) that were not undone */
const liveActs = c => { const u = undoneIx(c); return (c.history || []).flatMap((h, i) => (h.ev === 'action' && !u.has(i) ? [h] : [])); };
/**
 * closeCause(c, sides, now) -> null while the case stays open, else why it closes: folded | allowed | merged | archived | ended | stale.
 * sides: { a, b: { settled (no live run, no unmerged work), how: merged | archived | ended } }. A stale case has no two sides: it closes a
 * day after its last correction or undo (the handled lines' day, the time to undo it); with none it stays open, its card the reaction.
 */
export function closeCause(c, sides, now) {
  if (c.data?.kind === 'stale') {
    const ts = (c.history || []).filter(h => h.ev === 'action' || h.ev === 'undo').map(h => Date.parse(h.ts));
    return ts.length && now - Math.max(...ts) >= DAY_MS ? 'stale' : null;
  }
  if (!sides.a?.settled || !sides.b?.settled) return null;
  const acts = liveActs(c).map(h => h.data.action), how = [sides.a.how, sides.b.how];
  if (acts.includes('fold')) return 'folded';
  if (acts.includes('allow')) return 'allowed';
  return how.every(x => x === 'merged') ? 'merged' : how.includes('archived') ? 'archived' : 'ended';
}
/** realOf(c, f) -> yes | no | unruled (SPEC 4A.6 real): a remedy other than allow = yes; an allow = no; an automatic action: yes when the two
 *  sides shared a changed file at the merge (f.shared_files_at_merge) or the base merged first (f.base_first); no reaction = unruled */
export function realOf(c, f = {}) {
  const acts = liveActs(c).map(h => h.data).filter(a => a.action !== 'ask');
  if (acts.some(a => !a.auto && REMEDIES.includes(a.action) && a.action !== 'allow')) return 'yes';
  if (acts.some(a => a.action === 'allow')) return 'no';
  if (acts.some(a => a.auto)) return f.shared_files_at_merge?.length || f.base_first ? 'yes' : 'no';
  return 'unruled';
}
/** demotedClasses(acts, policy) -> [{ cls: 'kind:action', undone, of }] - the automatic classes with policy.collide.demote.undone (2) undone
 *  among their last demote.of (10) automatic actions (SPEC 4A.6 demotion): back to a card. acts: [{ kind, action, auto, undone, at }] */
export function demotedClasses(acts, policy) {
  const { undone: n, of } = pol(policy?.collide).demote, by = new Map();
  for (const a of acts.filter(x => x.auto).sort((x, y) => String(x.at).localeCompare(String(y.at)))) { const k = `${a.kind}:${a.action}`; by.set(k, [...(by.get(k) || []), a]); }
  return [...by].map(([cls, xs]) => ({ cls, undone: xs.slice(-of).filter(a => a.undone).length, of })).filter(x => x.undone >= n);
}
/** the digest's one line for a demoted class */
export const demotedWhy = d => { const [k, a] = d.cls.split(':');
  return `${k} (${a}): ${d.undone} of the last ${d.of} automatic actions were undone - Norn no longer does it by itself, each case is a card; a person switches it on again in Settings`; };

/**
 * replayPairs(sides, { cases, policy }) -> the pairs of merged work that collided (SPEC 4A.6 baseline): A merged first, B's own work began
 * before that, both changed a file outside the commons, and B then needed a port (a "merge: main into" commit on a shared file after A
 * merged) or its landing met a conflict. reaction: the first live action of a case on the pair, else none (the baseline's rows).
 * sides: [{ lane, dlv, pr, merged_at (ms), from (ms: B's first own commit), files: [own changed files], ports: [{ at, files }], conflict }]
 */
export function replayPairs(sides, { cases = {}, policy } = {}) {
  const P = pol(policy?.collide), react = new Map();
  for (const c of Object.values(cases)) { const a = liveActs(c)[0]; if (a) react.set(c.data.pair ?? pairKey(c.data.a?.lane, c.data.b?.lane), a.data.action); }
  const out = [], who = x => ({ lane: x.lane, dlv: x.dlv ?? null, pr: x.pr ?? null, merged_at: new Date(x.merged_at).toISOString() });
  for (const a of sides) for (const b of sides) {
    if (a.lane === b.lane || !(a.merged_at < b.merged_at) || !(b.from < a.merged_at)) continue;
    const shared = files(a.files, P).filter(f => b.files.includes(f));
    const ports = shared.length ? b.ports.filter(x => x.at >= a.merged_at && x.files.some(f => shared.includes(f))).length : 0;
    if (!ports && !(shared.length && b.conflict)) continue;
    out.push({ day: new Date(a.merged_at).toISOString().slice(0, 10), kind: 'territory', a: who(a), b: who(b), shared, ports, conflict: !!b.conflict, reaction: react.get(pairKey(a.lane, b.lane)) ?? 'none' });
  }
  return out.sort((x, y) => x.b.merged_at.localeCompare(y.b.merged_at) || x.a.lane.localeCompare(y.a.lane));
}
/** a replay pair in one line */
export const replayLine = x => `${x.day} ${x.kind} ${x.a.lane}${x.a.pr ? ` (#${x.a.pr})` : ''} > ${x.b.lane}${x.b.pr ? ` (#${x.b.pr})` : ''}: ${says(x.shared.length, 'shared file')} (${few(x.shared, 4)}), `
  + `${says(x.ports, 'port commit')}${x.conflict ? ', a landing conflict' : ''}${x.resolve_tokens ? `, ${x.resolve_tokens} resolve tokens` : ''} - ${x.reaction === 'none' ? 'collided, no reaction' : `reaction ${x.reaction}`}`;

const median = v => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const weekOf = t => { const d = new Date(t), day = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10); };
const HOLDS = ['hold', 'after', 'wait'];
/**
 * collideReport(cases, { since, now, baseline }) -> { since, rows, weeks, baseline } (SPEC 4A.6 `norn collide report`). rows: per kind and
 * reaction (the case's first action, or none) - cases; automatic; confirmed as recommended, changed (the first remedy a person applied is
 * or is not SloppaChoppa's pick); undone; held minutes (median); merges clean and in conflict; resolve tokens; duplicate run minutes and
 * tokens. weeks (sec. 7 targets): port commits on a pair Norn held or made wait (target 0), owner cards outside `lead` (at most 1), the
 * check-in's cards. baseline: the replay's pairs with no reaction.
 */
export function collideReport(cases, { since = 0, now = Date.now(), baseline = [] } = {}) {
  const xs = Object.values(cases).filter(c => { const t = Date.parse(c.history?.[0]?.ts ?? c.created ?? ''); return t >= since && t <= now; }), rows = new Map(), weeks = new Map();
  for (const c of xs) {
    const acts = (c.history || []).filter(h => h.ev === 'action').map(h => h.data), first = acts.find(a => a.action !== 'ask'), o = c.outcome || {}, d = c.data || {};
    const k = `${d.kind}|${first?.action ?? 'none'}`, man = acts.find(a => !a.auto && REMEDIES.includes(a.action));
    const r = rows.get(k) ?? { kind: d.kind, reaction: first?.action ?? 'none', cases: 0, automatic: 0, confirmed: 0, changed: 0, undone: 0, held: [], clean: 0, conflict: 0, resolve_tokens: 0, duplicate_min: 0, duplicate_tokens: 0 };
    r.cases++; if (first?.auto) r.automatic++;
    if (man) r[man.action === d.recommended?.remedy ? 'confirmed' : 'changed']++;
    if ((c.history || []).some(h => h.ev === 'undo')) r.undone++;
    if (Number.isFinite(o.held_min)) r.held.push(o.held_min);
    if (o.merge === 'clean' || o.merge === 'conflict') r[o.merge]++;
    r.resolve_tokens += o.resolve_tokens || 0; r.duplicate_min += o.duplicate_min || 0; r.duplicate_tokens += o.duplicate_tokens || 0;
    rows.set(k, r);
    const w = weekOf(Date.parse(c.history[0].ts)), x = weeks.get(w) ?? { week: w, cases: 0, held_port_commits: 0, owner_cards: 0, checkin_cards: 0 };
    x.cases++;
    if (acts.some(a => HOLDS.includes(a.action))) x.held_port_commits += o.port_commits || 0;
    if (d.kind !== 'lead' && acts.some(a => a.action === 'ask' && a.args?.role === 'owner')) x.owner_cards++;
    if (!first?.auto && d.verdict !== 'shadow') x.checkin_cards++;
    weeks.set(w, x);
  }
  const none = baseline.filter(p => p.reaction === 'none');
  return { since: new Date(since).toISOString(), rows: [...rows.values()].map(({ held, ...r }) => ({ ...r, held_med: median(held) })).sort((a, b) => a.kind.localeCompare(b.kind) || b.cases - a.cases),
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
    baseline: { pairs: none.length, port_commits: none.reduce((s, p) => s + p.ports, 0), conflicts: none.filter(p => p.conflict).length, resolve_tokens: none.reduce((s, p) => s + (p.resolve_tokens || 0), 0), rows: none } };
}
/** the report in lines */
export function reportLines(rep) {
  const out = [`collide report since ${rep.since.slice(0, 10)}: ${says(rep.rows.reduce((s, r) => s + r.cases, 0), 'case')}`];
  if (rep.rows.length) out.push('kind / reaction: cases, automatic, as recommended, changed, undone; held min (median); merges clean / conflict; resolve tokens; duplicate min');
  for (const r of rep.rows) out.push(`  ${r.kind} / ${r.reaction}: ${r.cases}, ${r.automatic} auto, ${r.confirmed} as recommended, ${r.changed} changed, ${r.undone} undone; held ${r.held_med ?? '-'}; ${r.clean} clean / ${r.conflict} conflict; ${r.resolve_tokens} resolve tokens; ${r.duplicate_min} duplicate min`);
  for (const w of rep.weeks) out.push(`week of ${w.week}: ${says(w.cases, 'case')}; port commits on held pairs ${w.held_port_commits} (target 0); owner cards outside lead ${w.owner_cards} (target at most 1); check-in cards ${w.checkin_cards}`);
  const b = rep.baseline;
  out.push(`baseline (replay since ${rep.since.slice(0, 10)}): ${says(b.pairs, 'pair')} collided with no reaction, ${says(b.port_commits, 'port commit')}, ${says(b.conflicts, 'landing conflict')}, ${b.resolve_tokens} resolve tokens`);
  for (const p of b.rows) out.push(`  ${replayLine(p)}`);
  return out;
}
