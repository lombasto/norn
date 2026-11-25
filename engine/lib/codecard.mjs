// RM-a-57 triage card (docs/code-graph.md "A consumer: norn code card"): one short answer about a file before a worker reads it - what it is,
// who depends on it, what changes with it, its fixes, its tests and the commits each part is indexed at - from the two contract readers
// (codegraph.mjs graphAt / dependents / fans, codesignals.mjs readSignals) and the tests index (testtimes.mjs testsFor over impact.json).
// A part whose index does not exist reads "not indexed"; nothing is guessed, and no part triggers an index run (graphAt noIndex).
// The measurement: policy.code.card 'ab' offers the MCP tool to every second worker run (cardGroup by run number); the worker's MCP server
// marks each run's group (markCard, <state>/code/card/<RUN>.json) and cardReport compares the finished runs of both groups. No model.
import fs from 'node:fs';
import path from 'node:path';
import { graphAt, dependents, fans } from './codegraph.mjs';
import { readSignals } from './codesignals.mjs';
import { testsFor, IMPACT_FILE } from './testtimes.mjs';
import { POLICY_DEFAULTS } from './policy.mjs';
import { idNum } from './records.mjs';
import { usageOfRun } from './cost.mjs';
import { runTranscript } from './standing.mjs';
import { transcriptReads } from './readev.mjs';
import { defaultProjectsDir } from './billing.mjs';
import { readJsonS } from './fsnap.mjs';

// the one place for the card's thresholds (listed in docs/code-graph.md); tokens are estimated as characters / chars_per_token
export const CARD_LIMITS = Object.freeze({ tokens: 400, chars_per_token: 4, dependents: 5, partners: 5, tests: 5, subject: 72, min_group: 15 });
const NA = 'not indexed', ENDED = ['exited', 'lost', 'killed'];
const norm = f => String(f).replace(/\\/g, '/').replace(/^\.\//, '');
export const ageOf = s => (s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`);
const ageAt = (iso, now) => Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
const tokensOf = t => Math.ceil(t.length / CARD_LIMITS.chars_per_token);
const linesOf = file => { try { const t = fs.readFileSync(file, 'utf8'); return t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; } catch { return null; } };

/** the cards of `files` (paths relative to the project folder `repo`) -> { cap, not_indexed: { graph, signals, tests }, cards: [Card] }.
 *  graph / signals / impact: the readers' answers when the caller has them (tests), else read here. */
export function cards({ state, repo, files, graph, signals, impact, now = Date.now() }) {
  const g = graph ?? graphAt({ state, repo, noIndex: true });
  let s = signals, sWhy = null;
  if (s === undefined) try { s = readSignals(state); } catch (e) { s = null; sWhy = `unreadable: ${e.message}`; }
  const im = impact ?? readJsonS(path.join(state, 'tests', IMPACT_FILE));
  const fan = g.ok ? fans(g) : null;
  const stamps = { graph: g.ok ? { commit: g.stamp.commit.slice(0, 12), age_s: g.stamp.age_s, exact: g.stamp.exact } : null,
    signals: s ? { sha: s.sha, age_s: ageAt(s.at, now) } : null, tests: im ? { sha: im.sha ?? null, age_s: ageAt(im.at, now) } : null };
  const not_indexed = { graph: g.ok ? null : g.why, signals: s ? null : sWhy ?? 'none stored (`norn code history` writes them)', tests: im ? null : `no ${IMPACT_FILE} (\`norn tests index\` writes it)` };
  return { cap: CARD_LIMITS.tokens, not_indexed, cards: files.map(norm).map(f => cardOf(f, { g, s, im, fan, stamps, repo })) };
}

function cardOf(file, { g, s, im, fan, stamps, repo }) {
  const gf = g.ok ? g.prefix + file : null, row = g.ok ? g.files.get(gf) : null, rel = x => path.posix.relative(g.prefix || '.', x) || x;
  let deps = { na: NA };
  if (row) {
    const d = dependents(g, gf, { depth: 1 }), by = x => fan.get(x)?.in ?? 0;
    deps = { n: d.rows.length + d.truncated, top: d.rows.map(x => x.file).sort((a, b) => by(b) - by(a) || (a < b ? -1 : 1)).slice(0, CARD_LIMITS.dependents).map(rel) };
  }
  const x = s?.files[file];
  const partners = x ? x.partners.map(p => ({ file: p.file, shared: p.shared, landings: x.landings })) : { na: NA };
  const fixes = !x ? { na: NA } : s.fixes.status !== 'measured' ? { na: `n/a (${s.fixes.reason})` } : { n_90d: x.fixes.n_90d, n_365d: x.fixes.n_365d, last: x.fixes.last[0] ?? null };
  const t = im ? testsFor(im, [file]).rows[0] : null, tests = t?.known ? t.tests : { na: NA };
  const c = { file, lang: row?.lang ?? null, lines: linesOf(path.join(repo, file)), ...(row?.excluded ? { excluded: row.why } : {}), dependents: deps, partners, fixes, tests, stamps, basis: 'measured' };
  return { ...c, ...fit(c) };
}

// the card's text, cut to the token cap: the longest list loses its last entry first (counted in "+N more"), then the fix subject shortens
function fit(c) {
  const keep = { dependents: c.dependents.top?.length ?? 0, partners: Array.isArray(c.partners) ? Math.min(c.partners.length, CARD_LIMITS.partners) : 0, tests: Array.isArray(c.tests) ? Math.min(c.tests.length, CARD_LIMITS.tests) : 0 };
  let subject = CARD_LIMITS.subject, text = render(c, keep, subject);
  while (tokensOf(text) > CARD_LIMITS.tokens) {
    const k = Object.keys(keep).sort((a, b) => keep[b] - keep[a])[0];
    if (keep[k] > 1) keep[k]--; else if (subject > 20) subject -= 10; else break;
    text = render(c, keep, subject);
  }
  return { text, tokens: tokensOf(text) };
}
const more = (shown, n) => (n > shown ? `, +${n - shown} more` : '');
function render(c, keep, subject) {
  const d = c.dependents, p = c.partners, fx = c.fixes, t = c.tests, st = c.stamps;
  const what = `${c.file} · ${c.lang ?? 'not a graph language'}, ${c.lines === null ? 'no such file' : `${c.lines} lines`}${c.excluded ? ` · excluded: ${c.excluded}` : ''}`;
  const used = d.na ? `  used by: ${d.na}` : d.n ? `  used by ${d.n} files: ${d.top.slice(0, keep.dependents).join(', ')}${more(keep.dependents, d.n)}` : '  used by: no file';
  const chg = p.na ? `  changes with: ${p.na}` : p.length ? `  changes with: ${p.slice(0, keep.partners).map(x => `${x.file} ${x.shared}/${x.landings}`).join(', ')}${more(keep.partners, p.length)}` : '  changes with: none over the thresholds';
  const sub = x => (x.length > subject ? x.slice(0, subject - 1) + '…' : x);
  const fix = fx.na ? `  fixes: ${fx.na}` : `  fixes: ${fx.n_90d} in 90 d, ${fx.n_365d} in 365 d${fx.last ? `; last ${fx.last.day} ${sub(fx.last.subject)}` : ''}`;
  const tst = t.na ? `  tests: ${t.na}` : t.length ? `  tests: ${t.slice(0, keep.tests).join(', ')}${more(keep.tests, t.length)}` : '  tests: none cover it';
  const at = [st.graph && `graph ${st.graph.commit} (${ageOf(st.graph.age_s)}${st.graph.exact ? '' : ', newest stored'})`, st.signals && `signals ${st.signals.sha} (${ageOf(st.signals.age_s)})`,
    st.tests && `tests ${st.tests.sha ?? '?'} (${ageOf(st.tests.age_s)})`].filter(Boolean);
  return [what, used, chg, fix, tst, `  indexed: ${at.length ? at.join(', ') : 'nothing'}; measured`].join('\n');
}

// ---- the A/B measurement ----
/** the run's group under policy.code.card: 'ab' -> 'card' for an even run number, 'control' for an odd one; off (or no run) -> null */
export function cardGroup(policy, run) {
  const mode = policy?.code?.card ?? POLICY_DEFAULTS.code.card, n = run ? idNum(run) : NaN;
  return mode === 'ab' && Number.isInteger(n) ? (n % 2 ? 'control' : 'card') : null;
}
const markDir = state => path.join(state, 'code', 'card');
/** record the run's group once (the first server of the run decides; a later one never changes it) */
export function markCard(state, run, group, now = Date.now()) {
  const f = path.join(markDir(state), `${run}.json`);
  fs.mkdirSync(markDir(state), { recursive: true });
  try { fs.writeFileSync(f, JSON.stringify({ run, group, at: new Date(now).toISOString() }), { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
/** the finished marked runs per group: tokens per run, distinct files read per run, the done rate -> { ok, why?, min, groups: { card, control } }.
 *  usageOf(item) -> { total } (cost.mjs), readsOf(item) -> number | null (the run's transcript Read calls); a run they cannot measure is counted apart */
export function cardReport({ state, items, projectsDir = defaultProjectsDir(), usageOf = it => usageOfRun(it, { projectsDir }), readsOf = it => readsOfRun(it, projectsDir) }) {
  const marks = fs.existsSync(markDir(state)) ? fs.readdirSync(markDir(state)).filter(f => f.endsWith('.json')).map(f => readJsonS(path.join(markDir(state), f))).filter(Boolean) : [];
  const groups = { card: [], control: [] };
  for (const m of marks) { const it = items[m.run]; if (it && ENDED.includes(it.state) && groups[m.group]) groups[m.group].push(it); }
  const sizes = { card: { runs: groups.card.length }, control: { runs: groups.control.length } }, min = CARD_LIMITS.min_group;
  if (groups.card.length < min || groups.control.length < min) return { ok: false, why: `too few runs: card ${groups.card.length}, control ${groups.control.length} (${min} each needed)`, min, groups: sizes };
  const sum = runs => {
    const tok = runs.map(it => usageOf(it)?.total).filter(Number.isFinite), rd = runs.map(readsOf).filter(Number.isFinite);
    return { runs: runs.length, tokens_per_run: mean(tok), tokens_unmeasured: runs.length - tok.length, files_per_run: mean(rd), files_unmeasured: runs.length - rd.length,
      done_rate: runs.filter(it => it.end?.outcome === 'done').length / runs.length };
  };
  return { ok: true, min, groups: { card: sum(groups.card), control: sum(groups.control) } };
}
function readsOfRun(it, projectsDir) {
  const t = runTranscript(it, { projectsDir });
  return t ? new Set(transcriptReads(t).filter(e => e[1] === 'read').map(e => e[2])).size : null;
}
/** the report in words */
export function reportLines(r) {
  if (!r.ok) return [r.why];
  const n = x => (x === null ? 'n/a' : Math.round(x).toLocaleString('en-US')), row = (k, x) => `${k.padEnd(8)} ${String(x.runs).padStart(5)}  ${n(x.tokens_per_run).padStart(14)}  ${(x.files_per_run === null ? 'n/a' : x.files_per_run.toFixed(1)).padStart(10)}  ${(100 * x.done_rate).toFixed(0).padStart(5)} %`
    + (x.tokens_unmeasured || x.files_unmeasured ? `  (unmeasured: tokens ${x.tokens_unmeasured}, files ${x.files_unmeasured})` : '');
  return ['group     runs  tokens per run  files read   done', row('card', r.groups.card), row('control', r.groups.control), 'measured from the finished runs\' records and transcripts; the owner decides whether the card stays'];
}
