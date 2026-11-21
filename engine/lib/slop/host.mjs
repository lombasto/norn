// META-SLOP-A (REVIEW-FABLE 2.5 "he returns data, Norn writes"): the ONE writer of SloppaChoppa. The checks, the line counts and
// the sweep return result objects; hostWrite turns them into Norn's files under <state>/slop/:
//   holds.json   { [branch]: { lane, run, base, head, at, blocks, resumed? } } - a branch with BLOCK findings; the merge waits on it
//   series.json  { days: { YYYY-MM-DD: { loc, sweep } } } - the daily points (trends)
//   checks.jsonl one line per check { branch, base, head, hash (the rule set), findings (the new ones, every level) } - the door reads it
//   REPORT.md + report.json - the daily report, its one digest line and the main it read to; daily.started / daily.missed - a daily start, the ones that wrote nothing
//   ratings.jsonl one line per thumb on a model finding { fp, rule, up, by, at } (RM-43: the second voice's precision; the last one counts)
// Waivers are records (WVR-n, waivers.jsonl); a block is open while no active waiver covers it.
import fs from 'node:fs';
import path from 'node:path';
import { readText } from '../fsnap.mjs';
import { loadShared } from '../records.mjs';
import { globToRe } from '../dlvgit.mjs';
import { explainOf } from './check.mjs';

export const slopDir = state => path.join(state, 'slop');
const readJ = (f, dflt) => { const t = readText(f); return t === null ? dflt : JSON.parse(t); };   // META-DASH-ASYNC R1: snapshot-aware (lib/fsnap.mjs)
export const slopFiles = state => [holdsFile(state), path.join(slopDir(state), 'report.json'), path.join(slopDir(state), 'series.json'), checksFile(state), ratingsFile(state)];
function writeJ(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); }
const holdsFile = state => path.join(slopDir(state), 'holds.json');
const checksFile = state => path.join(slopDir(state), 'checks.jsonl');
const ratingsFile = state => path.join(slopDir(state), 'ratings.jsonl');

export const slopHolds = state => readJ(holdsFile(state), {});
export const slopReport = state => readJ(path.join(slopDir(state), 'report.json'), null);
export const slopSeries = state => readJ(path.join(slopDir(state), 'series.json'), { days: {} });
/** slop-meter S1: the days that carry a meter, oldest first: [{ day, ...point.meter }] (the band's hysteresis, the strip, the gauge) */
export const meterSeries = state => Object.entries(slopSeries(state).days).filter(([, p]) => p?.meter).sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, p]) => ({ day, ...p.meter }));

// waiver is a shared kind: in a synced dir a waiver written on another home covers the block here too
export function activeWaivers(state, now = Date.now()) {
  return Object.values(loadShared(state, 'waiver').items)
    .filter(w => w.kind === 'waiver' && w.state === 'active' && !(w.data.until && Date.parse(w.data.until) <= now));
}
export const covers = (w, f) => w.data.rule === f.rule && (w.data.scope === f.fp || globToRe(w.data.scope).test(f.file));
/** the blocks no active waiver covers */
export const unwaived = (state, blocks, { now = Date.now() } = {}) => { const ws = activeWaivers(state, now); return blocks.filter(b => !ws.some(w => covers(w, b))); };
/** the BLOCK view (holds.json: the dashboard, the digest, the daily): a held branch's last check's blocks no active waiver covers.
 * Never a merge gate - the door (door.mjs) reads the stored check of the head it merges */
export function openBlocks(state, branch, { now = Date.now() } = {}) {
  const h = slopHolds(state)[branch];
  return h ? unwaived(state, h.blocks, { now }) : [];
}
/** every stored check, oldest first: { branch, base, head, hash, lane, run, at, findings (the new ones, every level; a rule that could not run is one of them) } */
export const slopChecks = state => (readText(checksFile(state)) || '').split('\n').filter(Boolean).map(l => JSON.parse(l));

// ---------- RM-43: the second voice's ratings (audit REPORT sec. 5 "Level") ----------
// a model rule may be set to BLOCK at 90 % precision over 20 rated findings and drops to TREND under 50 % (over as many): the
// precision view says so; the change itself is a record the owner or the controller makes (overrides.json), never automatic
export const RATING = { rated: 20, block: 0.9, trend: 0.5 };
/** fp -> its last rating { fp, rule, up, by, at } */
export const slopRatings = state => new Map((readText(ratingsFile(state)) || '').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => [r.fp, r]));
const modelFinding = (state, fp) => slopChecks(state).flatMap(c => c.findings).find(f => f.fp === fp && f.voice) || null;
/** the unrated model findings of each branch's last check: [{ branch, run, findings }] */
export function voiceFindings(state) {
  const rated = slopRatings(state), last = new Map();
  for (const c of slopChecks(state)) if (c.branch) last.set(c.branch, c);
  return [...last.values()].map(c => ({ branch: c.branch, run: c.run, findings: c.findings.filter(f => f.voice && !rated.has(f.fp)) })).filter(b => b.findings.length);
}
/** per model rule: { rule, title, level, shadow, rated, up, precision (null: none rated), suggest: 'BLOCK' | 'TREND' | null } */
export function voicePrecision(state, rules) {
  const all = [...slopRatings(state).values()];
  return rules.map(r => {
    const mine = all.filter(x => x.rule === r.id), up = mine.filter(x => x.up).length, precision = mine.length ? up / mine.length : null;
    const suggest = mine.length < RATING.rated ? null : precision >= RATING.block ? 'BLOCK' : precision < RATING.trend ? 'TREND' : null;
    return { rule: r.id, title: r.title, level: r.level, shadow: !!r.shadow, rated: mine.length, up, precision, suggest };
  });
}

/**
 * The one host write. payload.type:
 *  check  { branch, lane?, run?, base, head, hash (the rule set's), blocks, findings } -> one line in checks.jsonl
 *         (the new findings of every level) + the branch's hold set (blocks) or dropped (none); -> { open, check }
 *  daily  { day, report (markdown), line (the digest line), point ({ loc, sweep }), main (the sha the landed-unchecked list ran to) } -> the report files
 *  rating { fp, up (true: the finding is right), by } -> one line in ratings.jsonl; only a stored model finding is rated -> { rating }
 */
export function hostWrite(state, payload) {
  if (payload.type === 'check') {
    if (!payload.hash) throw new Error('hostWrite check: no rule-set hash (a stored check is keyed on branch, head and rule set)');
    const holds = slopHolds(state), { branch } = payload, at = payload.at || new Date().toISOString();
    const check = { branch: branch ?? null, base: payload.base, head: payload.head, hash: payload.hash, lane: payload.lane ?? null, run: payload.run ?? null, at,
      findings: payload.findings.filter(f => f.new !== false) };
    fs.mkdirSync(slopDir(state), { recursive: true });
    fs.appendFileSync(checksFile(state), JSON.stringify(check) + '\n');
    if (!branch) return { open: unwaived(state, payload.blocks), check };
    if (payload.blocks.length) holds[branch] = { lane: payload.lane ?? null, run: payload.run ?? null, base: payload.base, head: payload.head,
      at, blocks: payload.blocks };
    else delete holds[branch];
    writeJ(holdsFile(state), holds);
    return { open: unwaived(state, payload.blocks), check };
  }
  if (payload.type === 'daily') {
    const dir = slopDir(state);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'REPORT.md'), payload.report);
    writeJ(path.join(dir, 'report.json'), { day: payload.day, at: new Date().toISOString(), line: payload.line, main: payload.main ?? null });
    const s = slopSeries(state);
    s.days[payload.day] = payload.point;
    writeJ(path.join(dir, 'series.json'), s);
    return { file: path.join(dir, 'REPORT.md') };
  }
  if (payload.type === 'rating') {
    if (typeof payload.up !== 'boolean') throw new Error('hostWrite rating: up is true or false');
    const f = modelFinding(state, payload.fp);
    if (!f) throw new Error(`hostWrite rating: no model finding ${payload.fp} in the stored checks`);
    const rating = { fp: f.fp, rule: f.rule, up: payload.up, by: payload.by || null, at: new Date().toISOString() };
    fs.mkdirSync(slopDir(state), { recursive: true });
    fs.appendFileSync(ratingsFile(state), JSON.stringify(rating) + '\n');
    return { rating };
  }
  throw new Error(`hostWrite: unknown payload type ${payload.type}`);
}

/** one line per finding for a worker / a resume prompt; the path in backticks (it is code: the dashboard's prose shows it as a path) */
export const findingLine = f => `${f.rule} \`${f.file}${f.line ? ':' + f.line : ''}\` ${f.msg} [${f.fp}]`;
/** RM-27: the waiver path for one finding - the one way a finding may stay (owner / controller only) */
export const waiverCmd = f => `norn rec add waiver --rule ${f.rule} --scope ${f.fp} --why "<why it may stay>"`;
/** RM-27: a finding's rule explanation as lines (what / why / fix / keep it), for the CLI and the resume prompt; [] = no such rule */
export function explainLines(f, { pad = '    ', projectDir = null } = {}) {
  const x = explainOf(f.rule, projectDir);
  return x ? [`${pad}what: ${x.what}`, `${pad}why:  ${x.why}`, `${pad}fix:  ${x.fix}`, `${pad}keep it: only the owner or the controller waives a finding: ${waiverCmd(f)}`] : [];
}
