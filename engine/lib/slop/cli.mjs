// META-SLOP-A: `norn slop` - check | loc | sweep | daily | fixtures. Code only, no model; every write goes through hostWrite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRules, slopCheck, gitRun } from './check.mjs';
import { loadState } from '../records.mjs';
import { checkBranch } from './runend.mjs';
import { hostWrite, activeWaivers, covers, findingLine } from './host.mjs';
import { makeTool } from './tools.mjs';
import { locReport, formatLoc } from './loc.mjs';
import { sweep, formatSweep } from './sweep.mjs';
import { dailyReport } from './daily.mjs';
import { subdirOf, inDir } from '../monorepo.mjs';

export const SLOP_USAGE = 'usage: norn slop check [--lane L | --diff base..head] [--json] | loc [--since YYYY-MM-DD] [--json] | sweep [--json] | daily | fixtures    '
  + '[--project P | --state D] [--repo DIR]   (check: exit 1 = open BLOCK findings; fixtures: the real tools on the rule fixtures, nightly)';
const FLAGS = { check: ['lane', 'diff', 'json!'], loc: ['since', 'json!'], sweep: ['json!'], daily: [], fixtures: [] };

function parse(verb, argv) {
  const spec = [...(FLAGS[verb] || []), 'project', 'state', 'repo'], f = {};
  for (let i = 0; i < argv.length; i++) {
    const s = spec.find(x => '--' + x.replace(/!$/, '') === argv[i]);
    if (!s) throw new Error(`unexpected ${argv[i]}`);
    if (s.endsWith('!')) f[s.slice(0, -1)] = true;
    else { if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`); f[s] = argv[++i]; }
  }
  return f;
}
const toplevel = dir => gitRun(dir, ['rev-parse', '--show-toplevel']).trim();

/** o: { env, out, err, where(flags) -> { project, state } | null (no project / state named) } */
export function slopCmd(argv, { env = process.env, out = console.log, err = console.error, where = () => null } = {}) {
  const verb = argv[0];
  let f;
  try { if (!FLAGS[verb]) throw new Error(verb ? `unknown verb ${verb}` : 'missing verb'); f = parse(verb, argv.slice(1)); }
  catch (e) { err('error: ' + e.message); err(SLOP_USAGE); return 2; }
  const w = where(f), state = w?.state || null, project = w?.project || null;
  const repoOf = () => toplevel(f.repo || project?.deliverables?.repo || project?.root || process.cwd());
  // gap #7: a monorepo project (project.subdir; not with an explicit --repo) counts and sweeps only its own folder / branches
  const own = !f.repo && project && subdirOf(project) ? { name: project.name, subdir: subdirOf(project) } : null;
  if (verb === 'check') {
    let repo = f.repo ? toplevel(f.repo) : process.cwd();
    if (f.lane) {
      const lane = state && loadState(state).items['L:' + f.lane];
      if (!lane?.data?.worktree) { err(`error: lane ${f.lane} names no worktree${state ? '' : ' (no state: pass --project / --state)'}`); return 2; }
      repo = lane.data.worktree;
    }
    repo = toplevel(repo);
    const [base, head] = f.diff ? f.diff.split('..') : [null, 'HEAD'];
    if (f.diff && !(base && head)) { err('error: --diff wants base..head'); return 2; }
    const c = checkBranch({ repo, state, base, head });
    if (!c) { out('slop check: no lane branch here (detached, on main, or no main to diff against): nothing to check'); return 0; }
    const ws = state ? activeWaivers(state) : [];
    const blocks = c.result.blocks.map(b => ({ ...b, waived: ws.find(x => covers(x, b))?.id }));
    if (state && !f.diff) hostWrite(state, { type: 'check', branch: c.branch, lane: f.lane, base: c.base, head: c.result.head, blocks: c.result.blocks, findings: c.result.findings });
    const open = blocks.filter(b => !b.waived);
    if (f.json) out(JSON.stringify({ branch: c.branch, ...c.result, blocks }, null, 1));
    else {
      for (const b of blocks) out((b.waived ? `waived (${b.waived}) ` : 'BLOCK ') + findingLine(b));
      for (const s of c.result.skipped) out(`skipped ${s.rule}: ${s.why}`);
      out(`slop check: ${open.length} BLOCK${blocks.length > open.length ? ` (+${blocks.length - open.length} waived)` : ''} on ${c.branch} ${c.base.slice(0, 7)}..${c.result.head.slice(0, 7)} (${c.result.ran.join(' ')})`);
    }
    return open.length ? 1 : 0;
  }
  if (verb === 'loc') {
    const r = locReport(own ? inDir(repoOf(), own.subdir) : repoOf(), { since: f.since });
    out(f.json ? JSON.stringify(r, null, 1) : formatLoc(r));
    return 0;
  }
  if (verb === 'sweep') {
    const r = sweep(repoOf(), { state, own });
    out(f.json ? JSON.stringify(r, null, 1) : formatSweep(r));
    return 0;
  }
  if (verb === 'daily') {
    if (!state) { err('error: daily needs --project / --state (it writes the report there)'); return 2; }
    const r = dailyReport({ repo: repoOf(), state, env, own });
    out(`slop daily: ${r.line} -> ${r.file}`);
    return 0;
  }
  // fixtures: each tool rule's real tool on its fixture, compared with the recorded output (nightly; needs the network once)
  let bad = 0;
  for (const rule of loadRules().filter(r => r.tool)) {
    for (const which of ['hit', 'miss']) {
      const fx = rule.fixture[which], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-fx-'));
      try {
        const g = (...a) => gitRun(dir, a);
        g('init', '-q', '-b', 'main'); g('config', 'user.email', 'slop@norn'); g('config', 'user.name', 'slop'); g('config', 'core.autocrlf', 'false');
        const put = files => { for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); } };
        put(fx.base); g('add', '-A'); g('commit', '-q', '--allow-empty', '-m', 'base'); g('checkout', '-q', '-b', 'fx');
        for (const p of Object.keys(fx.base)) if (!(p in fx.head)) fs.rmSync(path.join(dir, p));
        put(fx.head); g('add', '-A'); g('commit', '-q', '--allow-empty', '-m', 'head');
        const key = r => r.blocks.map(b => `${b.file}:${b.line}`).sort().join(' ');
        const real = slopCheck({ repo: dir, base: 'main', only: [rule.id], tool: makeTool({ env }) });
        const rec = slopCheck({ repo: dir, base: 'main', only: [rule.id], tool: (r, side) => (fx.recorded[side] === undefined ? null : JSON.stringify(fx.recorded[side])) });
        const same = key(real) === key(rec) && real.skipped.length === 0;
        if (!same) bad++;
        out(`${same ? 'ok  ' : 'DIFF'} ${rule.id} ${which}: real [${key(real)}]${real.skipped.map(s => ' skipped: ' + s.why).join('')} recorded [${key(rec)}]`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }
  return bad ? 1 : 0;
}
