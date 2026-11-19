// META-SLOP-A (REVIEW-FABLE 3.4): the daily report - trends per area (raw counts, the absolute change beside every %), lines of
// code, the git sweep list - written once a day on the existing schedule (the tick starts `norn slop daily` detached) and ONE line
// for the check-in digest. No badge, no tab (slice B). A start that wrote no report by the next tick is a digest row (audit D4).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { locReport, CLASSES, APART } from './loc.mjs';
import { sweep, formatSweep } from './sweep.mjs';
import { hostWrite, slopReport, slopDir, slopHolds, openBlocks, activeWaivers } from './host.mjs';
import { spawnOutside } from '../jobguard.mjs';
import { slopOn } from '../policy.mjs';
import { inDir } from '../monorepo.mjs';
import { readText } from '../fsnap.mjs';
import { landedUnchecked, landedWords } from './landed.mjs';
import { mainTip } from './runend.mjs';
import { findingLine } from './host.mjs';

const num = n => n.toLocaleString('en-US');
/** "+1,204 (+6.0 %)": the absolute change always beside the percentage */
export const delta = (now, then) => `${now - then >= 0 ? '+' : ''}${num(now - then)}${then ? ` (${now - then >= 0 ? '+' : ''}${(100 * (now - then) / then).toFixed(1)} %)` : ''}`;
const today = now => new Date(now).toISOString().slice(0, 10);

/** the report from a LOC report + a sweep: { markdown, line } */
export function renderDaily(loc, sw, { day, holds = [], waivers = 0, landed = [] } = {}) {
  const then = loc.series.length > 7 ? loc.series[loc.series.length - 8] : loc.series[0];
  const L = [`# SloppaChoppa daily ${day}`, '', `Lines of code (non-blank, git) at ${loc.ref} ${loc.head.slice(0, 7)}; the change is against ${then?.day ?? '-'}.`, '',
    '| class | lines | 7 d |', '|---|---:|---:|', ...CLASSES.map(c => `| ${c} | ${num(loc.totals[c])} | ${delta(loc.totals[c], then?.totals[c] ?? 0)} |`),
    `| apart (not in the totals) | ${APART.map(c => `${c} ${num(loc.apart[c])}`).join(', ')} | |`, '', '## Areas', '',
    '| area | code | 7 d | tests | 7 d | docs | config |', '|---|---:|---:|---:|---:|---:|---:|'];
  for (const [a, v] of Object.entries(loc.areas).sort((x, y) => (y[1].code || 0) - (x[1].code || 0))) {
    const t = then?.areas[a] || {};
    L.push(`| ${a} | ${num(v.code || 0)} | ${delta(v.code || 0, t.code || 0)} | ${num(v.tests || 0)} | ${delta(v.tests || 0, t.tests || 0)} | ${num(v.docs || 0)} | ${num(v.config || 0)} |`);
  }
  const week = loc.landings.filter(l => then && l.day > then.day), big = week.filter(l => l.big);
  L.push('', `## Landings in 7 d: ${week.length}; big (> 1,500 changed code lines): ${big.length}`, '');
  for (const l of big) L.push(`- ${l.day} ${l.sha.slice(0, 7)} +${num(l.added.code || 0)} -${num(l.deleted.code || 0)} code: ${l.subject.slice(0, 100)}`);
  L.push('', '## Git sweep', '', '```', formatSweep(sw), '```', '', `## Held by slop: ${holds.length}; active waivers: ${waivers}`, '');
  for (const h of holds) L.push(`- ${h.branch}: ${h.open} open BLOCK (${h.rules})`);
  // RM-44 B: the landings on main since the last report that no stored check names (an admin merge, a direct push), with their findings
  if (landed.length) L.push('', `## Landed unchecked: ${landed.length}`, '');
  for (const l of landed) L.push(`- ${l.sha.slice(0, 7)} ${l.subject.slice(0, 100)}: ${landedWords(l, { full: true })}`, ...l.findings.map(f => `  - ${f.level} ${findingLine(f)}`));
  const c = then ? delta(loc.totals.code, then.totals.code) : '';
  const line = `slop ${day}: code ${num(loc.totals.code)}${c ? ` ${c} in 7 d` : ''}, tests ${num(loc.totals.tests)}; big landings ${big.length}; branches: `
    + `${sw.real.length} real (${sw.real.filter(r => r.conflicts).length} conflict), ${sw.empty.length} empty; worktrees: ${sw.dead.length} dead, ${sw.at_risk.length} AT RISK; `
    + `${sw.remote_merged.length} remote merged`
    + (landed.length ? `; LANDED UNCHECKED ${landed.length}: ${landed.map(l => `${l.sha.slice(0, 7)} (${landedWords(l)})`).join(', ')}` : '');
  return { markdown: L.join('\n') + '\n', line };
}

/** the daily run: build, write through the host, return { line, file }. own = { name, subdir } of a monorepo project: the lines of
 * code are its folder's, the sweep its own branches and worktrees (repo stays the top level). main / remote / projectDir / rules /
 * tool: the landed-unchecked list (landed.mjs), from the main the last report saw to main now */
export function dailyReport({ repo, state, now = Date.now(), own = null, main = 'main', remote = 'origin', projectDir = null, rules = null, tool }) {
  const home = own ? inDir(repo, own.subdir) : repo;
  const day = today(now), loc = locReport(home, { until: day }), sw = sweep(repo, { state, now, own });
  const holds = Object.entries(slopHolds(state)).map(([branch]) => ({ branch, blocks: openBlocks(state, branch, { now }) })).filter(h => h.blocks.length)
    .map(h => ({ branch: h.branch, open: h.blocks.length, rules: [...new Set(h.blocks.map(b => b.rule))].join(' ') }));
  const tip = mainTip(repo, { main, remote });
  const landed = landedUnchecked({ repo, state, to: tip, since: slopReport(state)?.main ?? null, own, projectDir, rules, ...(tool ? { tool } : {}) });
  const { markdown, line } = renderDaily(loc, sw, { day, holds, waivers: activeWaivers(state, now).length, landed });
  const point = { loc: { totals: loc.totals, apart: loc.apart, areas: loc.areas }, sweep: { real: sw.real.length, conflicts: sw.real.filter(r => r.conflicts).length,
    empty: sw.empty.length, unrelated: sw.unrelated.length, dead: sw.dead.length, at_risk: sw.at_risk.length, remote_merged: sw.remote_merged.length } };
  return { line, ...hostWrite(state, { type: 'daily', day, report: markdown, line, point, main: tip }) };
}

// daily.missed { since, n }: the starts since `since` that wrote no report (a report written after `since` ends the run of misses)
const missedFile = state => path.join(slopDir(state), 'daily.missed');
const missedOf = state => { const t = readText(missedFile(state)); return t ? JSON.parse(t) : null; };
const writeMissed = (state, m) => fs.writeFileSync(missedFile(state), JSON.stringify(m));

/** the tick's hook: start `norn slop daily` detached once a day (not while one started in the last 30 min). -> the tick-log words | null */
export function tickSlop(p, state, { metaCmd, spawnFn, now = Date.now() } = {}) {
  if (!p?.file || !slopOn(p.policy) || p.policy?.slop?.daily === false) return null;   // META-BETA-PREP: the one switch off = no report
  if (slopReport(state)?.day === today(now)) return null;
  const mark = path.join(slopDir(state), 'daily.started');
  const last = Number(readText(mark));
  if (last && now - last < 30 * 60e3) return null;
  fs.mkdirSync(slopDir(state), { recursive: true });
  // the last start wrote no report since: it died (stdio is ignored) - counted for the digest row, never silent (audit D4)
  if (last && !(Date.parse(slopReport(state)?.at) >= last)) { const m0 = missedOf(state), m = m0 && !(Date.parse(slopReport(state)?.at) > Date.parse(m0.since)) ? m0 : null; writeMissed(state, { since: m?.since ?? new Date(last).toISOString(), n: (m?.n ?? 0) + 1 }); }
  fs.writeFileSync(mark, String(now));
  const args = [metaCmd, 'slop', 'daily', '--project', p.file, '--state', state];
  let r = spawnFn ? spawnFn(process.execPath, args) : (env => (env.META_JOB ? spawnOutside(process.execPath, args, { cwd: p.root }) : null))(process.env);
  if (!r) { const c = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); r = { pid: c.pid }; }
  return `slop daily: started pid ${r?.pid ?? '?'}`;
}

/** the ONE digest row: the last daily line + the branches slop holds now */
export function digestRow(state, now = Date.now()) {
  const rep = slopReport(state);
  const held = Object.keys(slopHolds(state)).filter(b => openBlocks(state, b, { now }).length);
  const m = missedOf(state), dead = m && !(Date.parse(rep?.at) > Date.parse(m.since)) ? `; slop daily: ${m.n} start(s) since ${m.since} wrote no report (norn slop daily by hand shows why)` : '';
  if (!rep && !held.length && !dead) return null;
  return { id: 'slop', line: `${rep ? rep.line : 'slop: no daily report yet'}${dead}${held.length ? `; HELD by slop: ${held.join(', ')} (norn slop check / a waiver)` : ''}` };
}
