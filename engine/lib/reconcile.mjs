// RM-46 S5 (multi-home SPEC sec. 8 S5; Q3 = project-wide, DEC-421): norn sync reconcile. Two homes that planned apart hold likely
// duplicates: roadmap items, active directives, in-force decisions. A pair ACROSS homes is likely when the title words overlap
// (Jaccard >= 0.5 after stop words: dupdirs.mjs's words), the items share a branch / doc link, or their lanes' work claims overlap
// (claims.mjs overlapOf). Each pair becomes ONE owner card - a Q with keep both | merge <x> into <y> | drop <x> and the pair key in
// its data (reconcile.key), so no home asks it twice (the merged view holds every home's cards). Once answered, the apply step writes
// the ruling as a DEC, then roadmap verbs only (link, drop with the DEC as ref; never a typed status) or the supersede of a directive /
// decision (the roadmap links follow it), then the Q's apply. Pure reads + record(); the claims come from the caller (the local copy).
import { loadShared, homeOf, homeOfId, record, authorOf, OWNER } from './records.mjs';
import { loadRoadmap } from './roadmap.mjs';
import { wordsOf, jaccard } from './dupdirs.mjs';
import { overlapOf } from './claims.mjs';

// the rules as data: per kind the active records and their text; the link kinds that make a pair; the card's lane
export const RECONCILE = {
  jaccard: 0.5, links: ['branch', 'doc'], lane: 'reconcile',
  kinds: {
    item: { active: n => n.kind === 'item' && n.state === 'open', text: n => n.title },
    directive: { active: i => i.kind === 'directive' && i.state === 'active', text: i => i.data.text },
    // a ruling this step wrote (reconcile_q) is never a candidate: two homes' rulings would pair up with each other
    decision: { active: i => i.kind === 'decision' && i.state === 'in-force' && !i.data.reconcile_q, text: i => `${i.data.question} ${i.data.choice}` },
  },
};
const LINK_OF = { directive: 'dir', decision: 'dec' };

const recordsOf = stateDir => {
  const R = loadRoadmap(stateDir), st = loadShared(stateDir, 'question');
  const pick = (k, list) => list.filter(RECONCILE.kinds[k].active).map(x => ({ id: x.id, kind: k, text: RECONCILE.kinds[k].text(x) ?? '', links: x.links || [], rec: x }));
  return { R, st, all: [...pick('item', Object.values(R.items)), ...pick('directive', Object.values(st.items)), ...pick('decision', Object.values(st.items))] };
};
// a lane link names the item's own home's lane unless it is qualified (lane:b/x)
const laneOf = (link, home) => { const n = link.slice(5); return n.includes('/') ? { home: n.split('/')[0], lane: n.split('/')[1] } : { home, lane: n }; };
const claimOf = (claims, l) => Object.values(claims).find(c => c?.kind === 'work' && c.home === l.home && c.lane === l.lane);

/** the likely duplicate pairs across homes not carded yet: [{ key, kind, a, b, why, ta, tb }] (a < b, the key = kind:a+b); carded = the keys asked */
export function pairsOf(stateDir, { claims = {} } = {}) {
  const home = homeOf(stateDir);
  if (!home) return [];
  const { all, st } = recordsOf(stateDir), bare = home.bare_home, asked = cardedKeys(st.items), out = [];
  const words = new Map(all.map(x => [x.id, wordsOf(x.text)]));
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const [x, y] = [all[i], all[j]].sort((p, q) => (p.id < q.id ? -1 : 1));
    const hx = homeOfId(x.id, bare), hy = homeOfId(y.id, bare);
    if (x.kind !== y.kind || hx === hy) continue;
    const key = `${x.kind}:${x.id}+${y.id}`;
    if (asked.has(key)) continue;
    const why = [], J = jaccard(words.get(x.id), words.get(y.id));
    if (J >= RECONCILE.jaccard) why.push(`words ${J.toFixed(2)}`);
    const shared = x.links.filter(l => RECONCILE.links.includes(l.split(':')[0]) && y.links.includes(l));
    if (shared.length) why.push(`shared ${shared.join(' ')}`);
    const lx = x.links.filter(l => l.startsWith('lane:')).map(l => laneOf(l, hx)), ly = y.links.filter(l => l.startsWith('lane:')).map(l => laneOf(l, hy));
    for (const p of lx) for (const q of ly) {
      const cp = claimOf(claims, p), cq = claimOf(claims, q);
      if (cp && cq && overlapOf(cp, cq)) why.push(`claims overlap: ${p.home}/${p.lane} ${q.home}/${q.lane}`);
    }
    if (why.length) out.push({ key, kind: x.kind, a: x.id, b: y.id, why: why.join('; '), ta: x.text, tb: y.text });
  }
  return out;
}
const cardedKeys = items => new Set(Object.values(items).filter(i => i.kind === 'question' && i.data.reconcile?.key).map(i => i.data.reconcile.key));

/** the card of one pair: the Q create data */
export function cardOf(p, bare) {
  const at = id => `${id} (home ${homeOfId(id, bare)})`;
  return {
    title: `likely duplicate ${p.kind}s across homes: ${p.a} / ${p.b}`.slice(0, 120), lane: RECONCILE.lane, blocks: [],
    body: [`${at(p.a)}: ${p.ta}`, `${at(p.b)}: ${p.tb}`, `why: ${p.why}`, 'merge moves the links to the kept one and drops the merged one; drop drops it; keep both changes nothing.'].join('\n'),
    options: [{ key: 'keep', text: 'keep both' }, { key: `merge:${p.b}:${p.a}`, text: `merge ${p.b} into ${p.a}` }, { key: `merge:${p.a}:${p.b}`, text: `merge ${p.a} into ${p.b}` },
      { key: `drop:${p.a}`, text: `drop ${p.a}` }, { key: `drop:${p.b}`, text: `drop ${p.b}` }],
    source: 'norn sync reconcile', reconcile: { key: p.key, kind: p.kind, a: p.a, b: p.b, why: p.why },
  };
}

// the apply of one answered card: the ruling DEC (reused when a crashed pass wrote it), the moves, the Q's apply
function applyCard(stateDir, q, by, o) {
  const w = e => record(stateDir, { by, ...e }, o.rec);
  const { kind, a, b } = q.data.reconcile, choice = q.answer?.choice ?? '', [verb, x, keep] = choice.split(':');
  const opt = (q.data.options || []).find(z => z.key === choice);
  const st0 = loadShared(stateDir, 'question').items;
  const dec = Object.values(st0).find(i => i.kind === 'decision' && i.data.reconcile_q === q.id)?.id
    ?? w({ kind: 'decision', ev: 'create', data: { lane: RECONCILE.lane, question: q.data.title, choice: opt?.text ?? 'keep both', answers: q.id, reconcile_q: q.id, on_runs: [],
      why: `the owner's answer to ${q.id} (${a} / ${b}): ${q.answer?.text ?? ''}`.slice(0, 600) } }).id;
  if (verb === 'merge' || verb === 'drop') {
    const why = verb === 'merge' ? `merged into ${keep} (${q.id})` : `a likely duplicate of ${x === a ? b : a}, dropped (${q.id})`;
    if (kind === 'item') {
      const R = loadRoadmap(stateDir), X = R.items[x], K = R.items[keep], bare = homeOf(stateDir)?.bare_home;
      if (verb === 'merge' && K && X) {
        const hx = homeOfId(x, bare), hk = homeOfId(keep, bare);
        const moved = X.links.map(l => (l.startsWith('lane:') && !l.includes('/') && hx !== hk ? `lane:${hx}/${l.slice(5)}` : l)).filter(l => !K.links.includes(l));
        if (moved.length) w({ kind: 'item', ev: 'link', id: keep, data: { links: moved } });
      }
      if (X?.state === 'open') w({ kind: 'item', ev: 'drop', id: x, data: { why, ref: dec } });
    } else {
      const X = st0[x];
      if (verb === 'merge') for (const n of Object.values(loadRoadmap(stateDir).items)) {
        const from = `${LINK_OF[kind]}:${x}`, to = `${LINK_OF[kind]}:${keep}`;
        if (n.state !== 'open' || !n.links.includes(from)) continue;
        if (!n.links.includes(to)) w({ kind: 'item', ev: 'link', id: n.id, data: { links: [to] } });
        w({ kind: 'item', ev: 'unlink', id: n.id, data: { links: [from] } });
      }
      // a directive: the answered Q (an owner record) supersedes it; a decision: the Q when the owner wrote it (rule iv), else the newer ruling DEC
      const sup = kind === 'directive' || OWNER.includes(authorOf(X)) ? q.id : dec;
      if (X && RECONCILE.kinds[kind].active(X)) w({ kind, ev: 'supersede', id: x, data: { by: sup, why } });
    }
  }
  w({ kind: 'question', ev: 'apply', id: q.id, data: { refs: [dec] } });
  return { q: q.id, choice: choice || 'keep', dec };
}

/**
 * reconcile(stateDir, { by, claims, dry, views }) -> { pairs (new), carded (keys asked before this pass), written [Q-n], applied [{ q, choice, dec }] }.
 * First the answered cards apply, then each new pair gets its card. dry: the pairs only, nothing written. A solo dir (no home.json): nothing.
 */
export function reconcile(stateDir, { by, claims = {}, dry = false, views } = {}) {
  const o = { rec: views === undefined ? {} : { views } };
  const answered = () => Object.values(loadShared(stateDir, 'question').items).filter(i => i.kind === 'question' && i.data.reconcile && i.state === 'answered');
  const applied = dry ? [] : answered().map(q => applyCard(stateDir, q, by, o));
  const carded = cardedKeys(loadShared(stateDir, 'question').items).size, pairs = pairsOf(stateDir, { claims }), bare = homeOf(stateDir)?.bare_home;
  const written = dry ? [] : pairs.map(p => record(stateDir, { kind: 'question', ev: 'create', by, data: cardOf(p, bare) }, o.rec).id);
  return { pairs, carded, written, applied };
}
