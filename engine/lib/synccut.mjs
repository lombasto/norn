// RM-46 S1b (multi-home SPEC sec. 6): `norn sync cut` - the one cut that turns a project's state dir into a home's (no compatibility
// layer: after it the dir reads only in the new form). A dry run by default: it plans and prints every rename and writes nothing. With
// apply: the backup ledger commit, the registration on the claims branch (claims.mjs: homes/<id>.json, projects/<p>.json), the lane
// branch renames (local + origin; a branch with an open PR keeps its name), the rewrite of every KINDS log (one combined token pass, so
// a lane or branch name is never re-read as an id), the files keyed by id renamed, then home.json, machine.json ledger.home_id, ID-MAP.md
// (for people; no code reads it), the views and a closing ledger commit. A second apply is a no-op (home.json says the cut is done).
// The bare home (--bare) keeps its numeric ids; a joiner's bare ids become <P><home>-<n> - before the cut every bare id in a home's
// state is its own, so the token rewrite is exact. Node built-ins + the git binary (+ gh for open PRs on a GitHub origin).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KINDS, readEvents, recordsFile, fold, loadState, homeOf } from './records.mjs';
import { writeViews } from './views.mjs';
import { buildTree, writeRoadmapView, roadmapViewPath } from './roadmap.mjs';
import { commitLedger } from './ledger.mjs';
import { fedOf } from './fed.mjs';
import { listClaims, registerHome, registerProject, homeKey, projectKey } from './claims.mjs';
import { ghSlug } from './mergeland.mjs';
import { subdirOf } from './monorepo.mjs';
import { fwd } from './config.mjs';
import { readJsonS as readJson } from './fsnap.mjs';
import { renameRetry } from './runs.mjs';

export const HOME_RE = /^[a-z][a-z0-9]{0,7}$/;
const PREFIXES = ['Q', 'DEC', 'DIR', 'RUN', 'DLV', 'EP', 'MAIL', 'RM', 'ADP', 'ICF', 'GRD', 'WVR'];
/** SPEC 6 step 4: a bare numeric id token of the 12 numeric kinds */
export const ID_RE = new RegExp(`\\b(${PREFIXES.join('|')})-(\\d+)\\b`);
const FILE_ID = new RegExp(`^(${PREFIXES.join('|')})-(\\d+)(?!\\w)`);   // a file / dir keyed by id: RUN-12.spec.json, RUN-12-dod-gate.log, RUN-12/
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const LIVE = ['running', 'queued', 'claimed'];   // a run that may still write (claimed = a fed node took the queued run)
// state subdirs whose entries are never renamed: other homes' copies (S1c), the claims bookkeeping, generated views
const NO_RENAME = new Set(['homes', 'sync', 'views', '.git', 'node_modules']);
const LOG_FILES = [...new Set(Object.values(KINDS).map(k => k.file))].map(f => f + '.jsonl');
const esc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
function writeAtomic(f, text) { const t = `${f}.${process.pid}.cut.tmp`; fs.writeFileSync(t, text); renameRetry(t, f); }
function g(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}
const sha = (cwd, ref) => { const r = g(cwd, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]); return r.ok ? r.out : null; };

/** gh pr list on a GitHub origin -> true | false | null (unknown); any other origin cannot hold a PR */
export function ghOpenPr(root) {
  const slug = ghSlug(g(root, ['remote', 'get-url', 'origin']).out);
  return branch => {
    if (!slug) return false;
    const r = spawnSync('gh', ['pr', 'list', '--repo', slug, '--head', branch, '--state', 'open', '--json', 'number', '--jq', 'length'], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? Number(r.stdout.trim()) > 0 : null;
  };
}

/** a token pass over one string: branches, lane refs, role addresses, bare ids (joiner only); ids seen land in `seen` */
function rewriter({ home, bare, lanes, branchMap }) {
  const parts = [];
  const bs = Object.keys(branchMap).sort((a, b) => b.length - a.length).map(esc);
  if (bs.length) parts.push(`(?<![\\w./-])(${bs.join('|')})(?![\\w-]|[./]\\w)`);
  const ls = [...lanes].sort((a, b) => b.length - a.length).map(esc);
  if (ls.length) parts.push(`(?<!\\w)(L:|lane:)(${ls.join('|')})(?![\\w-]|[./]\\w)`);
  parts.push('(?<!\\w)role:(checkin|controller)(?![\\w@-])');
  if (!bare) parts.push(ID_RE.source);
  const re = new RegExp(parts.join('|'), 'g'), seen = new Map();
  const fn = s => s.replace(re, m => {
    if (branchMap[m]) return branchMap[m];
    if (m.startsWith('L:') || m.startsWith('lane:')) { const i = m.indexOf(':') + 1; return m.slice(0, i) + home + '/' + m.slice(i); }
    if (m.startsWith('role:')) return m + '@' + home;
    const k = m.match(ID_RE), n = `${k[1]}-${home}-${k[2]}`;
    seen.set(m, n);
    return n;
  });
  const deep = v => (typeof v === 'string' ? fn(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [fn(k), deep(x)])) : v);
  return { str: fn, deep, seen };
}

// ---------- the plan (read-only) ----------
function lanesOf(state, prefix) {
  const names = new Set(), add = n => { if (typeof n === 'string' && NAME.test(n)) names.add(n); };
  const brRe = new RegExp('^' + esc(prefix) + '([A-Za-z0-9][A-Za-z0-9_.-]*)$');
  for (const e of readEvents(recordsFile(state, 'lane'))) if (e.kind === 'lane' && !String(e.id).slice(2).includes('/')) add(String(e.id).slice(2));
  for (const k of ['run', 'deliverable']) for (const e of readEvents(recordsFile(state, k))) { add(e.data?.lane); const m = brRe.exec(e.data?.branch || ''); if (m) add(m[1]); }
  return names;
}
/** each lane's branch: rename | done (renamed by an earlier, interrupted cut) | keep-pr | keep-unknown | refused; absent = not listed */
function planBranches({ root, prefix, newPrefix, names, openPr, remote, failed = {} }) {
  const out = [];
  for (const name of names) {
    const old = prefix + name, neu = newPrefix + name, local = sha(root, `refs/heads/${old}`), rOld = remote.get(old) || null, rNew = remote.get(neu) || null;
    if (!local && !rOld) { if (sha(root, `refs/heads/${neu}`)) out.push({ old, new: neu, action: 'done' }); continue; }
    const b = { old, new: neu, local, remote: rOld };
    if (failed[old]) { out.push({ ...b, action: 'failed', why: failed[old] }); continue; }
    const pr = openPr(old);
    if (pr === true) { out.push({ ...b, action: 'keep-pr', why: 'open PR: keeps its name until it merges' }); continue; }
    if (pr === null) { out.push({ ...b, action: 'keep-unknown', why: 'the PR state is unknown (gh failed): kept' }); continue; }
    const src = local || rOld;
    if (local && rOld && rOld !== local && !g(root, ['merge-base', '--is-ancestor', rOld, local]).ok)
      { out.push({ ...b, action: 'refused', why: `origin's ${old} (${rOld.slice(0, 10)}) is not this home's: another home may claim the name - the owner sorts it` }); continue; }
    if (rNew && rNew !== src) { out.push({ ...b, action: 'refused', why: `origin already has ${neu} at another commit` }); continue; }
    out.push({ ...b, action: 'rename' });
  }
  return out;
}
function worktrees(root) {
  const m = new Map();
  let cur = null;
  for (const l of g(root, ['worktree', 'list', '--porcelain']).out.split('\n')) {
    if (l.startsWith('worktree ')) cur = l.slice(9);
    else if (l.startsWith('branch refs/heads/') && cur) m.set(l.slice(18), cur);
  }
  return m;
}
function renamesOf(state, home) {
  const out = [];
  for (const d of fs.readdirSync(state, { withFileTypes: true })) {
    if (!d.isDirectory() || NO_RENAME.has(d.name)) continue;
    for (const e of fs.readdirSync(path.join(state, d.name))) {
      const m = FILE_ID.exec(e);
      if (m) out.push([`${d.name}/${e}`, `${d.name}/${m[1]}-${home}-${m[2]}${e.slice(m[0].length)}`]);
    }
  }
  return out;
}
const runJsons = state => { try { return fs.readdirSync(path.join(state, 'runs')).filter(f => f.endsWith('.json')).map(f => 'runs/' + f); } catch { return []; } };
/** a lane branch's added lines vs origin/main citing legacy ids (the joiner fixes those by hand, one commit each) */
function citesOf(root, branches) {
  const base = sha(root, 'refs/remotes/origin/main') ? 'origin/main' : 'main', out = [];
  for (const b of branches) {
    const ref = b.local ? `refs/heads/${b.old}` : b.action === 'done' ? `refs/heads/${b.new}` : null;
    if (!ref) continue;
    const add = g(root, ['diff', `${base}...${ref}`]).out.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    const tokens = [...new Set(add.match(new RegExp(ID_RE.source, 'g')) || [])];
    if (tokens.length) out.push({ branch: ['rename', 'done'].includes(b.action) ? b.new : b.old, tokens });
  }
  return out;
}

/**
 * The cut of one project on one home. o: { state, project (loadProject: name, root, subdir), home, bare, apply, ledger (ledgerConfig),
 * machineFile, openPr (branch -> true | false | null; default gh), ledgerOpts (commitLedger's o), now, pausing (the caller pauses the project
 * for the apply: sync join - no "not paused" refusal) }.
 * -> { refused: [why], noop?, applied, plan: { ids, lanes, files, logs, branches, cites, bare_home } }
 */
export function syncCut(o) {
  const { state, project, home, bare = false, apply = false, ledger: cfg, machineFile, ledgerOpts = {}, now = Date.now() } = o;
  const refused = [], plan = { ids: [], lanes: [], files: [], logs: [], branches: [], cites: [], bare_home: bare ? home : null };
  const done = r => ({ refused, applied: false, plan, ...r });
  if (!HOME_RE.test(home || '')) return done({ refused: [`home id ${JSON.stringify(home)}: want [a-z][a-z0-9]{0,7}`] });
  const cur = homeOf(state);
  if (cur) return cur.id === home ? done({ noop: true, why: `${project.name} is already cut as home ${home}` }) : done({ refused: [`${project.name} is already cut as home ${cur.id}`] });
  const machine = readJson(machineFile) || {}, mine = machine.ledger?.home_id;
  if (mine && mine !== home) refused.push(`this machine is home ${mine} (machine.json ledger.home_id), not ${home}`);
  if (!o.pausing && !fs.existsSync(path.join(state, 'PAUSED'))) refused.push(`${project.name} is not paused: norn pause --project ${project.name} first`);
  for (const r of Object.values(fold(readEvents(recordsFile(state, 'run'))).items)) if (LIVE.includes(r.state)) refused.push(`${r.id} is ${r.state}: let it end or withdraw it`);
  const fe = fedOf(cfg);
  if (!fe) return done({ refused: [...refused, 'the cut needs the ledger with a remote (machine.json ledger.remote): the backup point and the claims branch'] });
  const root = project.root, origin = g(root, ['remote', 'get-url', 'origin']);
  if (!origin.ok) return done({ refused: [...refused, `${fwd(root)}: no git origin`] });
  const repo = ghSlug(origin.out) || fwd(origin.out);
  // registration (SPEC 6 step 3), checked on the fetched claims tip before anything is written
  let claims;
  try { claims = listClaims(fe); } catch (e) { return done({ refused: [...refused, `claims branch: ${e.message}`] }); }
  if (claims[homeKey(home)] && mine !== home) refused.push(`home id ${home} is taken (claims homes/${home}.json): pick another id`);
  const pj = claims[projectKey(project.name)];
  if (bare) { if (pj && (pj.bare_home !== home || pj.repo !== repo)) refused.push(`projects/${project.name}.json names bare home ${pj.bare_home} and repo ${pj.repo}`); }
  else if (!pj) refused.push(`no projects/${project.name}.json on the claims branch: the bare home cuts first (--bare)`);
  else {
    if (pj.repo !== repo) refused.push(`projects/${project.name}.json names repo ${pj.repo}; this project's origin is ${repo}`);
    if (pj.bare_home === home) refused.push(`${home} is the bare home of ${project.name}: cut with --bare`);
    plan.bare_home = pj.bare_home;
  }
  // lane branches (SPEC 6 step 6)
  const mono = subdirOf(project) ? project.name + '/' : '', prefix = `norn/${mono}`, newPrefix = `norn/${home}/${mono}`, names = lanesOf(state, prefix);
  g(root, ['fetch', '-q', '--prune', 'origin']);
  const remote = new Map(g(root, ['ls-remote', '--heads', 'origin']).out.split('\n').filter(Boolean).map(l => { const [s, r] = l.split('\t'); return [r.replace(/^refs\/heads\//, ''), s]; }));
  plan.branches = planBranches({ root, prefix, newPrefix, names, openPr: o.openPr || ghOpenPr(root), remote, failed: o.failed });
  const wts = worktrees(root);
  for (const b of plan.branches) if (b.action === 'rename' && wts.has(b.old) && g(wts.get(b.old), ['status', '--porcelain']).out) refused.push(`the worktree of ${b.old} (${fwd(wts.get(b.old))}) is not clean`);
  if (!bare) plan.cites = citesOf(root, plan.branches);
  // the log rewrite + file renames (SPEC 6 steps 4, 5)
  const branchMap = Object.fromEntries(plan.branches.filter(b => ['rename', 'done'].includes(b.action)).map(b => [b.old, b.new]));
  const rw = rewriter({ home, bare, lanes: names, branchMap }), texts = {};
  for (const f of [...LOG_FILES, ...runJsons(state)]) {
    const p = path.join(state, f);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    let n = 0, text;
    if (f.endsWith('.jsonl')) text = raw.split('\n').map(l => { let e; try { e = JSON.parse(l); } catch { return l; } const x = JSON.stringify(rw.deep(e)); if (x === JSON.stringify(e)) return l; n++; return x; }).join('\n');
    else { const j = readJson(p); if (j === null) continue; const x = rw.deep(j); if (JSON.stringify(x) !== JSON.stringify(j)) { n = 1; text = JSON.stringify(x, null, /\n/.test(raw) ? 2 : 0) + (raw.endsWith('\n') ? '\n' : ''); } }
    if (n) { texts[f] = text; plan.logs.push([f, n]); }
  }
  plan.ids = [...rw.seen];
  plan.lanes = [...names].map(n => [`L:${n}`, `L:${home}/${n}`]);
  plan.files = bare ? [] : renamesOf(state, home);
  if (refused.length || !apply) return done();

  // ---------- apply ----------
  const backup = commitLedger(cfg, `sync cut ${project.name}: backup before home ${home}`, ledgerOpts);
  if (backup.error || backup.refused) return done({ refused: [`the backup ledger commit failed: ${backup.error || 'a secret in ' + backup.refused.join(', ')}`] });
  const reg = registerHome(fe, { id: home, projects: [project.name], now });
  if (reg.exists && mine !== home) return done({ refused: [`home id ${home} was taken meanwhile`] });
  machine.ledger = { ...machine.ledger, home_id: home };   // right after the registration: a re-run after a crash knows the id is its own
  writeAtomic(machineFile, JSON.stringify(machine, null, 2) + '\n');
  if (bare) { const r = registerProject(fe, { project: project.name, repo, bare_home: home }); if (r.exists && (r.claim.bare_home !== home || r.claim.repo !== repo)) return done({ refused: [`projects/${project.name}.json was created meanwhile by home ${r.claim.bare_home}`] }); }
  for (const b of plan.branches.filter(x => x.action === 'rename')) {
    const step = (args, what) => { const r = g(root, args); if (!r.ok) throw new Error(`${what}: ${r.err.split('\n').pop()}`); };
    try {
      if (b.local) step(['branch', '-m', b.old, b.new], 'git branch -m');
      step(['push', '-q', 'origin', `${b.local ? 'refs/heads/' + b.new : b.remote}:refs/heads/${b.new}`], 'push');
      if (b.remote) step(['push', '-q', 'origin', '--delete', b.old], 'push --delete');
      if (b.local && g(root, ['config', `branch.${b.new}.remote`]).ok) step(['config', `branch.${b.new}.merge`, `refs/heads/${b.new}`], 'git config');
    } catch (e) { b.action = 'failed'; b.why = e.message; }
  }
  const failed = plan.branches.filter(b => b.action === 'failed');   // the logs name a branch only once it moved: re-plan without the failed ones
  if (failed.length) return syncCut({ ...o, failed: { ...o.failed, ...Object.fromEntries(failed.map(b => [b.old, b.why])) } });
  for (const [f, text] of Object.entries(texts)) writeAtomic(path.join(state, f), text);
  for (const [a, b] of plan.files) renameRetry(path.join(state, a), path.join(state, b));
  writeAtomic(path.join(state, 'home.json'), JSON.stringify({ id: home, bare_home: plan.bare_home, cut_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') }) + '\n');
  writeAtomic(path.join(state, 'ID-MAP.md'), idMap(project.name, home, plan, now));
  const views = [];
  try { writeViews(state, loadState(state)); views.push('records'); } catch (e) { views.push('records views failed: ' + e.message); }
  try { writeRoadmapView(state, buildTree({ stateDir: state, project }), roadmapViewPath(state, project)); views.push('roadmap'); } catch (e) { views.push('roadmap view failed: ' + e.message); }
  const after = commitLedger(cfg, `sync cut ${project.name}: home ${home}`, ledgerOpts);
  return done({ applied: true, views, ledger: after.sha || (after.noop ? 'noop' : after.error || 'refused') });
}

const branchLine = b => (['rename', 'done'].includes(b.action) ? `${b.old} -> ${b.new}` : `${b.old} ${b.action}: ${b.why}`);
function idMap(name, home, plan, now) {
  const L = [`# ID-MAP: ${name} cut as home ${home} (${new Date(now).toISOString().slice(0, 10)})`, '',
    'Written by norn sync cut (RM-46). It maps each id, lane and branch of this home before the cut to its name after it, for people reading NOTES, briefs and commit messages written before the cut; no code reads it.', '',
    `Bare home of the project: ${plan.bare_home}.`, ''];
  const sec = (h, rows) => { L.push(`## ${h}`, ''); L.push(...(rows.length ? rows.map(r => '- ' + r) : ['- none'])); L.push(''); };
  sec('Ids', plan.ids.map(([a, b]) => `${a} -> ${b}`));
  sec('Lanes', plan.lanes.map(([a, b]) => `${a} -> ${b}`));
  sec('Branches', plan.branches.map(branchLine));
  sec('Files', plan.files.map(([a, b]) => `${a} -> ${b}`));
  sec('Lane branches citing legacy ids in added lines (one fix commit each)', plan.cites.map(c => `${c.branch}: ${c.tokens.join(', ')}`));
  return L.join('\n');
}

/** the plan as lines for the CLI (every rename); next: false drops the closing "next: publish" line (sync join publishes itself) */
export function cutLines(r, { project, home, apply, next = true }) {
  const p = r.plan, L = [];
  if (r.noop) return [`${r.why}: nothing to do`];
  L.push(`sync cut ${project}: home ${home}${p.bare_home === home ? ' (bare: keeps its ids)' : p.bare_home ? ` (joiner; bare home ${p.bare_home})` : ''} - ${apply ? (r.applied ? 'APPLIED' : 'NOT APPLIED') : 'DRY RUN (nothing written; --apply cuts)'}`);
  for (const [a, b] of p.ids) L.push(`id ${a} -> ${b}`);
  for (const [a, b] of p.lanes) L.push(`lane ${a} -> ${b}`);
  for (const [f, n] of p.logs) L.push(`log ${f}: ${n} line(s) rewritten`);
  for (const [a, b] of p.files) L.push(`file ${a} -> ${b}`);
  for (const b of p.branches) L.push(`branch ${branchLine(b)}`);
  for (const c of p.cites) L.push(`cite ${c.branch}: ${c.tokens.join(', ')} in added lines - one fix commit by hand`);
  for (const w of r.refused) L.push(`refused: ${w}`);
  if (r.applied) L.push(`views: ${r.views.join(', ')}; ledger: ${r.ledger}`, ...(next ? ['next: publish home/<id> (norn sync publish, S1c), then norn resume --project ' + project] : []));
  return L;
}
