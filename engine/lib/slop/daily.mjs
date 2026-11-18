// META-SLOP-A (REVIEW-FABLE 3.4): the daily report - trends per area (raw counts, the absolute change beside every %), lines of
// code, the git sweep list - written once a day on the existing schedule (the tick starts `norn slop daily` detached) and ONE line
// for the check-in digest. No badge, no tab (slice B). Also records the K14 base side: `norn gen --check` as it stands on main.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { locReport, CLASSES, APART } from './loc.mjs';
import { sweep, formatSweep } from './sweep.mjs';
import { hostWrite, slopReport, slopDir, slopHolds, openBlocks, activeWaivers } from './host.mjs';
import { loadRules } from './check.mjs';
import { makeTool } from './tools.mjs';
import { spawnOutside } from '../jobguard.mjs';
import { slopOn } from '../policy.mjs';
import { inDir } from '../monorepo.mjs';

const num = n => n.toLocaleString('en-US');
/** "+1,204 (+6.0 %)": the absolute change always beside the percentage */
export const delta = (now, then) => `${now - then >= 0 ? '+' : ''}${num(now - then)}${then ? ` (${now - then >= 0 ? '+' : ''}${(100 * (now - then) / then).toFixed(1)} %)` : ''}`;
const today = now => new Date(now).toISOString().slice(0, 10);

/** the report from a LOC report + a sweep: { markdown, line } */
export function renderDaily(loc, sw, { day, holds = [], waivers = 0 } = {}) {
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
  const c = then ? delta(loc.totals.code, then.totals.code) : '';
  const line = `slop ${day}: code ${num(loc.totals.code)}${c ? ` ${c} in 7 d` : ''}, tests ${num(loc.totals.tests)}; big landings ${big.length}; branches: `
    + `${sw.real.length} real (${sw.real.filter(r => r.conflicts).length} conflict), ${sw.empty.length} empty; worktrees: ${sw.dead.length} dead, ${sw.at_risk.length} AT RISK; `
    + `${sw.remote_merged.length} remote merged`;
  return { markdown: L.join('\n') + '\n', line };
}

/** the daily run: build, write through the host, return { line, file }. own = { name, subdir } of a monorepo project: the lines of
 * code and the K14 base are its folder's, the sweep its own branches and worktrees (repo stays the top level) */
export function dailyReport({ repo, state, env = process.env, now = Date.now(), own = null }) {
  const home = own ? inDir(repo, own.subdir) : repo;
  const day = today(now), loc = locReport(home, { until: day }), sw = sweep(repo, { state, now, own });
  const holds = Object.entries(slopHolds(state)).map(([branch]) => ({ branch, blocks: openBlocks(state, branch, { now }) })).filter(h => h.blocks.length)
    .map(h => ({ branch: h.branch, open: h.blocks.length, rules: [...new Set(h.blocks.map(b => b.rule))].join(' ') }));
  const { markdown, line } = renderDaily(loc, sw, { day, holds, waivers: activeWaivers(state, now).length });
  const k14 = loadRules().find(r => r.id === 'K14');
  const baselines = {};
  try { baselines.K14 = makeTool({ env })(k14, 'head', { dir: home }); } catch (e) { baselines.K14 = null; fs.appendFileSync(path.join(slopDir(state), 'daily.log'), `${new Date(now).toISOString()} K14 base not recorded: ${e.message}\n`); }
  if (baselines.K14 === null) delete baselines.K14;
  const point = { loc: { totals: loc.totals, apart: loc.apart, areas: loc.areas }, sweep: { real: sw.real.length, conflicts: sw.real.filter(r => r.conflicts).length,
    empty: sw.empty.length, dead: sw.dead.length, at_risk: sw.at_risk.length, remote_merged: sw.remote_merged.length } };
  return { line, ...hostWrite(state, { type: 'daily', day, report: markdown, line, point, baselines }) };
}

/** the tick's hook: start `norn slop daily` detached once a day (not while one started in the last 30 min). -> the tick-log words | null */
export function tickSlop(p, state, { metaCmd, spawnFn, now = Date.now() } = {}) {
  if (!p?.file || !slopOn(p.policy) || p.policy?.slop?.daily === false) return null;   // META-BETA-PREP: the one switch off = no report
  if (slopReport(state)?.day === today(now)) return null;
  const mark = path.join(slopDir(state), 'daily.started');
  try { if (now - fs.statSync(mark).mtimeMs < 30 * 60e3) return null; } catch { /* never started: start it now */ }
  fs.mkdirSync(slopDir(state), { recursive: true });
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
  if (!rep && !held.length) return null;
  return { id: 'slop', line: `${rep ? rep.line : 'slop: no daily report yet'}${held.length ? `; HELD by slop: ${held.join(', ')} (norn slop check / a waiver)` : ''}` };
}
