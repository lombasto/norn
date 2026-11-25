// `norn code suspects` (RM-a-61, docs/code-signals.md "norn code suspects"): which recent landing to read first against a bug report - a
// trace file or symptom words - from git and the stored code signals alone, no model. Candidates = the landings of main's first-parent
// history in the window (the same "landing" as the signals contract); a batch landing (an integration branch that merged member branches,
// or an octopus) is expanded into one candidate per member branch, so a batch of finished branches installed as one merge is judged branch
// by branch. Rank, strongest first and compared in that order (no invented weights): trace files the candidate changed, then files that
// change together with those (the signals' partners), then symptom words found in its changed paths and subjects. Every row carries its
// score and its reasons in words; nothing matched = no suspect found, never a filler ranking. Every threshold is in SUSPECT_LIMITS.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readSignals } from './codesignals.mjs';

/** every window and threshold of the suspects (docs/code-signals.md lists each) */
export const SUSPECT_LIMITS = Object.freeze({
  since_days: 30,       // the default window: landings newer than this many days
  top: 5,               // rows shown by default
  min_word: 3,          // a symptom word shorter than this says nothing
  stem_min: 4,          // two words of at least this length match when one starts with the other (split / splits, save / saved)
  common_share: 0.5,    // a symptom word matching more than this share of the candidates says nothing about which one ...
  common_min: 4,        // ... judged only from this many candidates up
  types: Object.freeze(['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']),   // commit types: no symptom
});
// function words and the words of git's own merge subjects: never a symptom
const STOP = new Set(('the and for with from into onto after before when then than that this these those are was were not but has have had its our '
  + 'you all any can cannot does did out off over under only also more most still too very been being which who what where why how there here they '
  + 'them their his her one two now new get got set use used uses using should would could will shall just some such each every other same about '
  + 'again while merge merged merges branch branches pull request remote tracking origin main head').split(' '));
const DAY = 86400e3, day = t => new Date(t).toISOString().slice(0, 10);
const git = (dir, args) => execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 1 << 30, windowsHide: true, timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
const split = s => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const like = (w, t) => t === w || (Math.min(w.length, t.length) >= SUSPECT_LIMITS.stem_min && (t.startsWith(w) || w.startsWith(t)));

/** a symptom's words: { used, dropped: [{ word, why }] } (short words, numbers and stop words go silently; a commit type with its reason) */
function wordsOf(text) {
  const used = [], dropped = [];
  for (const w of split(text)) {
    if (used.includes(w) || dropped.some(d => d.word === w)) continue;
    if (SUSPECT_LIMITS.types.includes(w)) dropped.push({ word: w, why: 'a commit type: it names a kind of landing, not a place' });
    else if (w.length >= SUSPECT_LIMITS.min_word && !/^\d+$/.test(w) && !STOP.has(w)) used.push(w);
  }
  return { used, dropped };
}
export const symptomWords = text => wordsOf(text).used;

/** git log as [{ sha, parents, t (ms), subject, files }] */
function logOf(dir, args) {
  return git(dir, ['log', '--format=%x01%H%x02%P%x02%ct%x02%s', ...args]).split('\x01').slice(1).map(c => {
    const [h, ...rest] = c.split('\n'), [sha, p, ct, subject] = h.split('\x02');
    return { sha, parents: p ? p.split(' ') : [], t: Number(ct) * 1000, subject, files: rest.map(x => x.trim()).filter(Boolean) };
  });
}
// the branch a merge subject names: GitHub's, git's own (one branch or several, in parent order) and Norn's `merge: <branch>`
function branchesOf(subject) {
  let m = /^Merge pull request (#\d+) from [^\s/]+\/(\S+)/.exec(subject);
  if (m) return { names: [m[2]], pr: m[1] };
  if (/^Merge (?:remote-tracking )?branch(?:es)? '/.test(subject)) return { names: [...subject.split(/ into /)[0].matchAll(/'([^']+)'/g)].map(x => x[1]), pr: null };
  m = /^merge: (\S+)/.exec(subject);
  return { names: m ? [m[1]] : [], pr: null };
}

/** the window's landings, each with the commits it brought in (each commit belongs to the oldest landing reaching it) */
function landingsOf(dir, head, since, now) {
  const m = /^(\d+)d$/.exec(since);
  let fp, win;
  if (m) {
    const cut = now - Number(m[1]) * DAY;
    fp = [];
    for (const l of logOf(dir, ['--first-parent', head])) { if (l.t < cut) break; fp.push(l); }
    win = { days: Number(m[1]), from: day(cut) };
  } else {
    let s;
    try { s = git(dir, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`]).trim(); } catch { throw new Error(`--since ${since}: not a commit and not N days (e.g. 14d)`); }
    fp = logOf(dir, ['--first-parent', `${s}..${head}`]);
    win = { sha: s.slice(0, 12), from: fp.length ? day(fp.at(-1).t) : null };
  }
  if (!fp.length) return { landings: [], commits: new Map(), win };
  const base = fp.at(-1).parents[0], range = base ? [`${base}..${head}`] : [head];
  const net = new Map(logOf(dir, ['--first-parent', '--diff-merges=first-parent', '--name-only', '--relative', ...range]).map(l => [l.sha, l.files]));
  const commits = new Map(logOf(dir, ['--diff-merges=off', '--name-only', '--relative', ...range]).map(c => [c.sha, c]));
  const landings = fp.map(l => ({ ...l, files: net.get(l.sha) ?? [], own: new Set() })), owner = new Set();
  for (const l of [...landings].reverse()) {
    const st = [l.sha];
    while (st.length) { const c = st.pop(); if (owner.has(c) || !commits.has(c)) continue; owner.add(c); l.own.add(c); st.push(...commits.get(c).parents); }
  }
  return { landings, commits, win };
}
/** a merge landing's member branches -> [{ tip, merge | null, own?, commits }] | null (not a batch: one branch or none) */
function membersOf(l, C) {
  if (l.parents.length < 2) return null;
  const S = l.own, taken = new Set(), out = [];
  const reach = tip => { const got = [], st = [tip]; while (st.length) { const c = st.pop(); if (taken.has(c) || !S.has(c)) continue; taken.add(c); got.push(c); st.push(...C.get(c).parents); } return got; };
  for (const tip of l.parents.slice(1)) {
    const chain = [];
    for (let c = tip; c && S.has(c) && !taken.has(c); c = C.get(c).parents[0]) chain.push(c);
    // a merge on the branch's own line whose other side is not main's (main's is owned by an earlier landing) brought in a member branch
    const subs = chain.slice().reverse().flatMap(c => C.get(c).parents.slice(1).filter(q => S.has(q)).map(q => ({ tip: q, merge: c })));
    if (!subs.length) { out.push({ tip, merge: null, commits: reach(tip) }); continue; }
    chain.forEach(c => taken.add(c));
    for (const s of subs) out.push({ ...s, commits: reach(s.tip) });
    const own = chain.filter(c => C.get(c).parents.length < 2);
    if (own.length) out.push({ tip, merge: null, own: true, commits: own });
  }
  return out.length > 1 ? out : null;
}
/** the candidates: one per plain landing, one per member branch of a batch landing */
function candidatesOf(landings, C) {
  const out = [];
  let batches = 0;
  const subjects = shas => shas.map(s => C.get(s)).filter(c => c && c.parents.length < 2).sort((a, b) => b.t - a.t).map(c => c.subject);
  for (const l of landings) {
    const base = { landing: l.sha.slice(0, 12), t: l.t, day: day(l.t) }, lb = branchesOf(l.subject), ms = membersOf(l, C);
    if (!ms) {
      const sub = l.parents.length > 1 ? subjects([...l.own]) : [];
      out.push({ ...base, member: null, branch: l.parents.length > 1 ? lb.names[0] ?? null : null, pr: lb.pr, subject: sub[0] ?? l.subject, subjects: [l.subject, ...sub], files: [...l.files].sort() });
      continue;
    }
    batches++;
    const net = new Set(l.files), octo = l.parents.length > 2;
    for (const m of ms) {
      const files = [...new Set(m.commits.flatMap(c => C.get(c).files))].filter(f => net.has(f)).sort(), sub = subjects(m.commits);
      const mb = m.merge ? branchesOf(C.get(m.merge).subject) : null;
      const branch = m.own ? lb.names[0] ?? null : mb ? mb.names[0] ?? null : octo ? lb.names[l.parents.indexOf(m.tip) - 1] ?? null : null;
      out.push({ ...base, member: m.own ? 'own commits' : m.tip.slice(0, 12), branch, pr: m.own ? lb.pr : mb?.pr ?? null, subject: sub[0] ?? (m.merge ? C.get(m.merge).subject : l.subject),
        subjects: [...(m.merge ? [C.get(m.merge).subject] : m.own ? [l.subject] : []), ...sub], files });
    }
  }
  return { list: out, batches };
}

/** the repo files a trace names: paths with an extension, `file://`, backslashes, a drive and a `:line:col` tail taken off -> { files, unmatched } */
function traceFiles(text, known) {
  const files = new Set(), unmatched = new Set(), base = new Map();
  for (const f of known) { const b = f.split('/').pop(); base.set(b, base.has(b) ? null : f); }
  for (let tok of String(text).split(/[\s()'"`[\]<>,;|]+/)) {
    if (/^https?:/i.test(tok)) continue;
    tok = tok.replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/(:\d+)+:?$/, '').replace(/[.:]+$/, '').replace(/^\/(?=[A-Za-z]:)/, '');
    if (!/[A-Za-z0-9_-]\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(tok)) continue;
    const e = tok.replace(/^[A-Za-z]:/, '').replace(/^\.\//, '');
    let hit = known.has(e) ? e : [...known].filter(f => e.endsWith('/' + f)).sort((a, b) => b.length - a.length)[0];
    if (!hit) { const t = e.includes('/') ? [...known].filter(f => f.endsWith('/' + e)) : [base.get(e)].filter(Boolean); if (t.length === 1) hit = t[0]; }
    if (hit) files.add(hit); else if (e.includes('/')) unmatched.add(tok);
  }
  return { files: [...files].sort(), unmatched: [...unmatched] };
}

/** o: { dir (the indexed folder), state, words?, trace? (a file), since? ('Nd' | a commit), top?, now?, head? } -> the ranking (docs/code-signals.md) */
export function suspects({ dir, state, words = '', trace = null, since = `${SUSPECT_LIMITS.since_days}d`, top = SUSPECT_LIMITS.top, now = Date.now(), head = 'HEAD' }) {
  const sha = git(dir, ['rev-parse', '--short=12', head]).trim(), { landings, commits, win } = landingsOf(dir, head, since, now), { list, batches } = candidatesOf(landings, commits);
  const wd = wordsOf(words), n = list.length;
  // trace files and their partners
  let tr = null, partners = { na: 'no trace: partners follow the files a trace names' };
  const pmap = new Map();
  if (trace) {
    let text;
    try { text = fs.readFileSync(trace, 'utf8'); } catch (e) { throw new Error(`--trace ${trace}: ${e.code || e.message}`); }
    const known = new Set([...git(dir, ['ls-files']).split('\n').filter(Boolean), ...list.flatMap(c => c.files)]);
    tr = { file: trace, ...traceFiles(text, known) };
    let s;
    try { s = readSignals(state); } catch (e) { s = undefined; partners = { na: `signals unreadable: ${e.message}` }; }
    if (s === null) partners = { na: 'no signals stored (`norn code history` writes them)' };
    if (s) {
      partners = { sha: s.sha };
      for (const t of tr.files) for (const p of s.files[t]?.partners ?? []) if (!tr.files.includes(p.file) && !(pmap.get(p.file)?.shared >= p.shared)) pmap.set(p.file, { of: t, shared: p.shared, share: p.share });
    }
  }
  // the words each candidate matches (where), then the words most candidates match dropped
  const where = c => { const tok = c.files.map(f => [f, split(f)]), st = c.subjects.map(s => [s, split(s)]);
    return Object.fromEntries(wd.used.map(w => [w, { paths: tok.filter(([, t]) => t.some(x => like(w, x))).map(([f]) => f), subjects: st.filter(([, t]) => t.some(x => like(w, x))).map(([s]) => s) }])); };
  const hits = list.map(where), used = [], dropped = [...wd.dropped];
  for (const w of wd.used) {
    const df = hits.filter(h => h[w].paths.length || h[w].subjects.length).length;
    if (n >= SUSPECT_LIMITS.common_min && df > SUSPECT_LIMITS.common_share * n) dropped.push({ word: w, why: `in ${df} of ${n} candidates: says nothing about which one` });
    else used.push(w);
  }
  const ranked = list.map((c, i) => {
    const tf = tr ? c.files.filter(f => tr.files.includes(f)) : [], pf = c.files.filter(f => pmap.has(f)), ws = used.filter(w => hits[i][w].paths.length || hits[i][w].subjects.length);
    const reasons = [...tf.map(f => `changed ${f}, named in the trace`),
      ...pf.map(f => { const p = pmap.get(f); return `changed ${f}, which changes together with ${p.of} (${p.shared} shared landings, ${Math.round(100 * p.share)} %)`; }),
      ...ws.map(w => { const h = hits[i][w], at = [...h.paths.slice(0, 3), ...h.subjects.slice(0, 1).map(s => `the subject "${s}"`)], more = h.paths.length - 3 + Math.max(0, h.subjects.length - 1);
        return `"${w}" in ${at.join(', ')}${more > 0 ? ` and ${more} more` : ''}`; })];
    const { t, subjects, ...row } = c;
    return { ...row, t, score: { trace: tf.length, partners: pf.length, words: ws.length }, reasons };
  }).filter(r => r.score.trace || r.score.partners || r.score.words)
    .sort((a, b) => b.score.trace - a.score.trace || b.score.partners - a.score.partners || b.score.words - a.score.words || b.t - a.t || (a.landing + a.member < b.landing + b.member ? -1 : 1))
    .slice(0, top).map(({ t, ...r }) => r);
  return { sha, at: new Date(now).toISOString(), basis: 'measured', since: win, landings: landings.length, batches, candidates: n, words: { used, dropped }, trace: tr, partners, top, found: ranked.length > 0, suspects: ranked };
}

/** the ranking in words: the header, one row per suspect with its reasons under it, the stamp */
export function suspectsLines(r) {
  const w = r.since.days ? `${r.landings} landings in ${r.since.days} days (since ${r.since.from})` : `${r.landings} landings after ${r.since.sha}`;
  const head = [`suspects: ${w}, ${r.batches} batch merges expanded: ${r.candidates} candidates`,
    `  symptom words: ${r.words.used.length ? r.words.used.join(' ') : 'none'}${r.words.dropped.map(d => `; "${d.word}" dropped (${d.why})`).join('')}`];
  if (r.trace) head.push(`  trace ${r.trace.file}: ${r.trace.files.length ? r.trace.files.join(', ') : 'names no file of this repo'}${r.trace.unmatched.length ? `; not in the repo: ${r.trace.unmatched.join(', ')}` : ''}`,
    `  partners: ${r.partners.sha ? `from the signals at ${r.partners.sha}` : `n/a (${r.partners.na})`}`);
  const rows = r.found ? ['score = trace files · partner files · symptom words, compared in that order (ties: the newer landing first)',
    ...r.suspects.flatMap((s, i) => [`${String(i + 1).padStart(2)}. score ${s.score.trace} · ${s.score.partners} · ${s.score.words}  ${s.landing.slice(0, 8)} ${s.day} ${s.branch ?? 'direct to main'}${s.pr ? ` (${s.pr})` : ''}${s.member === 'own commits' ? ' (its own commits)' : ''}  ${s.subject}`,
      ...s.reasons.map(x => `      ${x}`)])]
    : [`no suspect found: ${[...(r.trace ? [r.trace.files.length ? 'no landing in the window changed a file the trace names or one of its partners' : 'the trace names no file of this repo'] : []),
      r.words.used.length ? 'no symptom word matched a landing\'s paths or subjects' : 'no symptom word left'].join(', and ')}`];
  return [...head, ...rows, `${r.basis} from git at ${r.sha}, ${r.at.slice(0, 16)}`];
}
