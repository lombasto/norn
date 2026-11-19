// META-SLOP-A (REVIEW-FABLE 2.5 "he returns data, Norn writes"): the ONE writer of SloppaChoppa. The checks, the line counts and
// the sweep return result objects; hostWrite turns them into Norn's files under <state>/slop/:
//   holds.json   { [branch]: { lane, run, base, head, at, blocks, resumed? } } - a branch with BLOCK findings; the merge waits on it
//   series.json  { days: { YYYY-MM-DD: { loc, sweep } } } - the daily points (trends)
//   checks.jsonl one line per check { branch, base, head, hash (the rule set), findings (the new ones, every level) } - the door reads it
//   REPORT.md + report.json - the daily report, its one digest line and the main it read to; daily.started / daily.missed - a daily start, the ones that wrote nothing
// Waivers are records (WVR-n, waivers.jsonl); a block is open while no active waiver covers it.
import fs from 'node:fs';
import path from 'node:path';
import { readText } from '../fsnap.mjs';
import { fold, readEvents, recordsFile } from '../records.mjs';
import { globToRe } from '../dlvgit.mjs';

export const slopDir = state => path.join(state, 'slop');
const readJ = (f, dflt) => { const t = readText(f); return t === null ? dflt : JSON.parse(t); };   // META-DASH-ASYNC R1: snapshot-aware (lib/fsnap.mjs)
export const slopFiles = state => [holdsFile(state), path.join(slopDir(state), 'report.json'), path.join(slopDir(state), 'series.json')];
function writeJ(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(f + '.tmp', f); }
const holdsFile = state => path.join(slopDir(state), 'holds.json');
const checksFile = state => path.join(slopDir(state), 'checks.jsonl');

export const slopHolds = state => readJ(holdsFile(state), {});
export const slopReport = state => readJ(path.join(slopDir(state), 'report.json'), null);
export const slopSeries = state => readJ(path.join(slopDir(state), 'series.json'), { days: {} });

export function activeWaivers(state, now = Date.now()) {
  return Object.values(fold(readEvents(recordsFile(state, 'waiver'))).items)
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
/** every stored check, oldest first: { branch, base, head, hash, lane, run, at, findings (the new ones, every level), skipped } */
export const slopChecks = state => (readText(checksFile(state)) || '').split('\n').filter(Boolean).map(l => JSON.parse(l));

/**
 * The one host write. payload.type:
 *  check  { branch, lane?, run?, base, head, hash (the rule set's), blocks, findings, skipped? } -> one line in checks.jsonl
 *         (the new findings of every level) + the branch's hold set (blocks) or dropped (none); -> { open, check }
 *  daily  { day, report (markdown), line (the digest line), point ({ loc, sweep }), main (the sha the landed-unchecked list ran to) } -> the report files
 */
export function hostWrite(state, payload) {
  if (payload.type === 'check') {
    if (!payload.hash) throw new Error('hostWrite check: no rule-set hash (a stored check is keyed on branch, head and rule set)');
    const holds = slopHolds(state), { branch } = payload, at = payload.at || new Date().toISOString();
    const check = { branch: branch ?? null, base: payload.base, head: payload.head, hash: payload.hash, lane: payload.lane ?? null, run: payload.run ?? null, at,
      findings: payload.findings.filter(f => f.new !== false), skipped: payload.skipped || [] };
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
  throw new Error(`hostWrite: unknown payload type ${payload.type}`);
}

/** one line per finding for a worker / a resume prompt */
export const findingLine = f => `${f.rule} ${f.file}${f.line ? ':' + f.line : ''} ${f.msg} [${f.fp}]`;
