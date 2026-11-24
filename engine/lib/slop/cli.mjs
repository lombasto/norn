// META-SLOP-A: `norn slop` - check | fix (SloppaChoppa 2 S1c) | loc | sweep | daily | fixtures | replay (S1b). Code only, no model; every write goes through hostWrite.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRules, slopCheck, gitRun, explainOf, replay } from './check.mjs';
import { loadState, laneId } from '../records.mjs';
import { checkBranch, projectSlop } from './runend.mjs';
import { hostWrite, activeWaivers, covers, findingLine, explainLines, meterSeries, fixOff } from './host.mjs';
import { planFixes, applyFixes, fixCounts } from './fix.mjs';
import { makeTool } from './tools.mjs';
import { locReport, formatLoc, mainRef } from './loc.mjs';
import { meterOf, meterInput, formatMeter, loadMeter } from './meter.mjs';
import { sweep, formatSweep } from './sweep.mjs';
import { dailyReport } from './daily.mjs';
import { subdirOf, inDir } from '../monorepo.mjs';

export const SLOP_USAGE = 'usage: norn slop check [--lane L | --diff base..head] [--ci] [--json] | fix [--lane L] | loc [--since YYYY-MM-DD] [--json] | sweep [--json] | meter [--json] | daily | fixtures'
  + ' | replay <rule> --as <ids,...> [--main REF] [--last N] [--config FILE] [--json]    [--project P | --state D] [--repo DIR]   (check: exit 1 = open BLOCK findings;'
  + ' --ci skips the rules that read the machine state; fix: applies the fix lists of the rules to the open findings in the worktree, commits nothing; meter: how slopified main is, 0-100 and a band; fixtures: the real tools on the rule fixtures, nightly; replay: a rule beside its new form over the last N merges of main, SPEC 3.2)';
const FLAGS = { check: ['lane', 'diff', 'ci!', 'json!'], fix: ['lane'], loc: ['since', 'json!'], sweep: ['json!'], meter: ['json!'], daily: [], fixtures: [], replay: ['as', 'main', 'last', 'config', 'json!'] };

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
  try {
    if (!FLAGS[verb]) throw new Error(verb ? `unknown verb ${verb}` : 'missing verb');
    const pos = verb === 'replay' && argv[1] && !argv[1].startsWith('--') ? argv[1] : null;   // replay's rule id comes first
    f = { ...parse(verb, argv.slice(pos ? 2 : 1)), rule: pos };
    if (verb === 'replay' && !(f.rule && f.as)) throw new Error('replay wants <rule> --as <ids,...> (the new form: rule or sub-rule ids, LJ/no-console)');
  }
  catch (e) { err('error: ' + e.message); err(SLOP_USAGE); return 2; }
  const w = where(f), state = w?.state || null, project = w?.project || null;
  const repoOf = () => toplevel(f.repo || project?.deliverables?.repo || project?.root || process.cwd());
  // gap #7: a monorepo project (project.subdir; not with an explicit --repo) counts and sweeps only its own folder / branches
  const own = !f.repo && project && subdirOf(project) ? { name: project.name, subdir: subdirOf(project) } : null;
  // check / fix: the checkout of --repo, of --lane's worktree, or here
  let repo = f.repo ? toplevel(f.repo) : process.cwd();
  if ((verb === 'check' || verb === 'fix') && f.lane) {
    const lane = state && loadState(state).items[laneId(f.lane, state)];
    if (!lane?.data?.worktree) { err(`error: lane ${f.lane} names no worktree${state ? '' : ' (no state: pass --project / --state)'}`); return 2; }
    repo = lane.data.worktree;
  }
  if (verb === 'fix') {
    repo = toplevel(repo);
    const c = checkBranch({ repo, state, projectDir: project?.project_dir });
    if (!c) { out('slop fix: no lane branch here (detached, on main, or no main to diff against): nothing to fix'); return 0; }
    const ws = state ? activeWaivers(state) : [], open = c.result.blocks.filter(b => !ws.some(w => covers(w, b)));
    const plan = planFixes({ repo, base: c.base, open, rules: projectSlop({ projectDir: project?.project_dir }).rules, off: state ? fixOff(state) : new Set() }), files = applyFixes(repo, plan);
    for (const x of plan.fixed) out('fixed ' + findingLine(x));
    for (const x of plan.left) out(`not fixed (${x.why}) ${findingLine(x.f)}`);
    const n = plan.fixed.length, s = k => (k === 1 ? '' : 's');
    out(`slop fix: ${n} finding${s(n)} fixed in ${files.length} file${s(files.length)}${n ? ` (${fixCounts(plan.fixed)})` : ''}; nothing committed: review the diff, commit, then run norn slop check`);
    return 0;
  }
  if (verb === 'check') {
    repo = toplevel(repo);
    const [typed, head] = f.diff ? f.diff.split('..') : [null, 'HEAD'];
    if (f.diff && (f.diff.includes('...') || !(typed && head))) { err('error: --diff wants base..head (two dots: the check starts at their merge base)'); return 2; }
    // SPEC 1.3 F2: the diff starts at the merge base, as at every door - never the typed tip (main's later changes would read as the branch's)
    const base = typed && gitRun(repo, ['merge-base', typed, head], { ok: [0, 1, 128] }).trim();
    if (f.diff && !base) { err(`error: --diff ${f.diff}: no merge base (a revision that does not resolve, or no common history)`); return 2; }
    const c = checkBranch({ repo, state, base, head, projectDir: project?.project_dir, machine: !f.ci });
    if (!c) { out('slop check: no lane branch here (detached, on main, or no main to diff against): nothing to check'); return 0; }
    const at = `${c.result.base.slice(0, 7)}..${c.result.head.slice(0, 7)}`;
    const ws = state ? activeWaivers(state) : [];
    const blocks = c.result.blocks.map(b => ({ ...b, waived: ws.find(x => covers(x, b))?.id, explain: explainOf(b.rule, project?.project_dir) }));
    if (state && !f.diff) hostWrite(state, { type: 'check', branch: c.branch, lane: f.lane, base: c.base, head: c.result.head, hash: c.result.hash, blocks: c.result.blocks, findings: c.result.findings });
    if (!c.result.files.length) { out(`slop check: nothing to check: ${at} changes no file`); return 0; }
    const open = blocks.filter(b => !b.waived);
    if (f.json) out(JSON.stringify({ branch: c.branch, ...c.result, blocks }, null, 1));
    else {
      // RM-27: each open finding says what / why / what to do - once per rule (the first of its findings), so ten K2s are not ten copies
      const told = new Set();
      for (const b of blocks) { out((b.waived ? `waived (${b.waived}) ` : 'BLOCK ') + findingLine(b)); if (!b.waived && !b.unrun && !told.has(b.rule)) { told.add(b.rule); for (const l of explainLines(b, { projectDir: project?.project_dir })) out(l); } }
      const unrun = c.result.findings.filter(x => x.unrun).map(x => x.rule);
      out(`slop check: ${open.length} BLOCK${blocks.length > open.length ? ` (+${blocks.length - open.length} waived)` : ''} on ${c.branch ?? head} ${at}, ${c.result.files.length} file(s); ran: ${c.result.ran.join(' ')}${unrun.length ? `; could not run: ${unrun.join(' ')}` : ''}`);
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
  if (verb === 'meter') {
    const home = own ? inDir(repoOf(), own.subdir) : repoOf(), ref = mainRef(home), { texts, git } = meterInput(home, { ref });
    const m = meterOf(texts, git, loadMeter(), { prev: state ? meterSeries(state).at(-1)?.band ?? null : null });
    out(f.json ? JSON.stringify(m, null, 1) : formatMeter(m, { ref }));
    return 0;
  }
  if (verb === 'daily') {
    if (!state) { err('error: daily needs --project / --state (it writes the report there)'); return 2; }
    const r = dailyReport({ repo: repoOf(), state, own, main: project?.deliverables?.main, remote: project?.deliverables?.remote, projectDir: project?.project_dir });
    out(`slop daily: ${r.line} -> ${r.file}`);
    return 0;
  }
  if (verb === 'replay') {
    const rows = replay({ repo: repoOf(), old: f.rule, as: f.as.split(','), main: f.main || 'HEAD', last: f.last ? Number(f.last) : 50, config: f.config ? fs.readFileSync(f.config, 'utf8') : null, tool: makeTool({ env }) });
    const sum = k => rows.reduce((a, r) => a + r[k].length, 0);
    if (f.json) out(JSON.stringify(rows, null, 1));
    else for (const r of rows) out([`${r.merge} ${r.subject}`, `  old [${r.old.join(' ')}]  new [${r.new.join(' ')}]`, ...r.missed.map(m => `  MISSED ${m}`), ...r.added.map(a => `  added ${a}`), ...r.unrun.map(u => `  could not run: ${u}`)].join('\n'));
    out(`slop replay ${f.rule} as ${f.as}: ${rows.length} merges; old ${sum('old')}, new ${sum('new')}, missed ${sum('missed')}, added ${sum('added')} (label each by hand), could not run ${sum('unrun')}`);
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
        const same = key(real) === key(rec);   // a rule that could not run is a BLOCK at `*`: never the recorded key
        if (!same) bad++;
        out(`${same ? 'ok  ' : 'DIFF'} ${rule.id} ${which}: real [${key(real)}]${real.findings.filter(x => x.unrun).map(x => ' ' + x.msg).join('')} recorded [${key(rec)}]`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  }
  return bad ? 1 : 0;
}
