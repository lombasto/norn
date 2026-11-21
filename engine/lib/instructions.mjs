// META-INSTRUCTIONS R1: the ONE home of "what steers the agents" - every file a session of a project loads (per harness), its load
// class, its size in ~tokens, its last change, generated or hand-written, what it cost today, and read-only lint hints.
// Front ends: the dashboard's Instructions tab (/api/instructions), `norn instructions [--json]`, the MCP read (norn_status view
// instructions). Which files a harness loads by itself is DATA in the harness adapters (harness/<family>.mjs `instructions`).
// Writes nothing. Node built-ins only.
//
// One row per file (META-STANDING-CONTEXT R2 extends this shape): { id, path, name, where, kind, harness [families], load (the
// strongest class), role?, loads [specs { class, families?, role?, tick?, part? }], tokens, standing_tokens, lines, chars, changed,
// changed_by, generated, source?, drift?, feeds?, machine_only, exists }.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, harnessOf } from './harness/index.mjs';
import { genStates, frontmatter } from './setup.mjs';
import { loadState } from './records.mjs';
import { threadFile } from './chatact.mjs';
import { standingRuns, standingSummary } from './standing.mjs';
import { profileOf, PROFILE_ROLES } from './launchpolicy.mjs';
import { checkinDays } from './checkins.mjs';
import { staticChecks, CHECKS, memoryDir, rulePaths, frontOf, memoryMap, memoryOpened } from './instrchecks.mjs';
import { memoryOf, roleOfSpec } from './launchpolicy.mjs';
import { ruleLedger, rowCounts } from './rules.mjs';
import { readEvidence } from './readev.mjs';
import { auditsView } from './audit.mjs';
import { subdirOf } from './monorepo.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ENGINE = path.join(HERE, '..');
const fwd = p => String(p).replace(/\\/g, '/');
const key = p => { const a = fwd(path.resolve(p)); return process.platform === 'win32' ? a.toLowerCase() : a; };
const under = (p, dir) => !!dir && (key(p) + '/').startsWith(key(dir).replace(/\/+$/, '') + '/');
const isFile = f => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// ---------- size ----------
export const TOKEN_METHOD = 'tokens ~ ceil(chars / 4): the common rule of thumb of about 4 characters per token for English prose and code '
  + '(no tokenizer dependency); every size is an estimate, shown with "~"';
export const estTokens = text => Math.ceil(String(text ?? '').length / 4);

// ---------- the harness data rows (adapters) ----------
/** [{ family, label, repo [names], user [templates], imports, agents?, skills? }] - Claude Code first, Codex, then the cli presets. */
export function harnessRows() {
  // src = the adapter file that holds the row (check 23 pins its finding there); the cli presets live in cli.mjs
  const src = n => fileURLToPath(new URL(`./harness/${n}.mjs`, import.meta.url)).replace(/\\/g, '/');
  return [[ADAPTERS.claude.instructions, 'claude'], [ADAPTERS.codex.instructions, 'codex'], ...Object.values(ADAPTERS.cli.instructions || {}).map(h => [h, 'cli'])]
    .filter(([h]) => h).map(([h, n]) => ({ ...h, src: src(n) }));
}
/** a lint hint's Slop row id (guardview.mjs guardRows uses it; Context links a file's first hint to it) */
export const hintSlopId = h => 'H-' + createHash('sha1').update(`${h.kind}|${fwd(h.path ?? '').toLowerCase()}|${h.line}|${h.text}`).digest('hex').slice(0, 10);

// load classes, strongest first; a row's `load` is its strongest spec
export const LOADS = ['session', 'checkin', 'chat', 'role', 'on-demand', 'source'];
export const LOAD_LABEL = { session: 'every session', checkin: 'check-ins', chat: 'chat', role: 'workers of a role', 'on-demand': 'on demand', source: 'source (norn gen)' };

// ---------- discovery ----------
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__']);
/** repo-relative paths of the instruction files under root: git ls-files (tracked + untracked, not ignored), else a bounded walk */
function repoFiles(root, names) {
  const want = f => names.includes(path.posix.basename(f)) || /^\.claude\/agents\/[^/]+\.md$/.test(f) || /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f) || /^\.claude\/rules\/.+\.md$/.test(f);
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...names.map(n => `*${n}`), '.claude/agents/*.md', '.claude/skills/*/SKILL.md', '.claude/rules/*.md'],
    { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return [...new Set(r.stdout.split('\0').filter(Boolean).map(fwd).filter(want))].sort();
  const out = [];
  let seen = 0;
  const walk = (d, rel, depth) => {
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (++seen > 50000) return;
      const r2 = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (depth < 6 && !SKIP_DIRS.has(e.name) && (!e.name.startsWith('.') || e.name === '.claude')) walk(path.join(d, e.name), r2, depth + 1); }
      else if (e.isFile() && want(r2)) out.push(r2);
    }
  };
  walk(root, '', 0);
  return out.sort();
}

/** the repo-relative files that can enforce a project's rule (its tests, the CI workflows): git ls-files of the repo; a monorepo
 * project (p.subdir) = its own folder + the shared .github only - another project's test never counts as this project's enforcement */
export function projectFiles(p) {
  if (!p?.root) return [];
  const sub = subdirOf(p);
  const r = spawnSync('git', ['-C', p.root, 'ls-files', '--cached', '--others', '--exclude-standard', ...(sub ? ['--', sub, '.github'] : [])],
    { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}

/** the last change of each file: the git commit time (one `git log` per repository), else the file's mtime (changed_by says which).
 * files [abs] -> Map key(file) -> { changed, changed_by } */
function changedOf(files, git) {
  const out = new Map(), tops = [], byTop = new Map(), noRepo = new Set();
  const topOf = d => {
    const hit = tops.find(t => under(d, t));
    if (hit) return hit;
    if (noRepo.has(key(d))) return null;
    const r = spawnSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const t = r.status === 0 ? r.stdout.trim() : '';
    if (!t) { noRepo.add(key(d)); return null; }
    tops.push(t); return t;
  };
  if (git) for (const f of files) { const t = topOf(path.dirname(f)); if (t) { if (!byTop.has(t)) byTop.set(t, []); byTop.get(t).push(f); } }
  for (const [t, fs2] of byTop) {
    const lc = x => (process.platform === 'win32' ? x.toLowerCase() : x), rel = new Map(fs2.map(f => [fwd(path.relative(t, f)), f]));
    const look = new Map([...rel].map(([r2, f]) => [lc(r2), f]));
    const r = spawnSync('git', ['-C', t, 'log', '--format=@%cI', '--name-only', '--no-renames', '--', ...rel.keys()], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    let when = null;
    for (const l of r.status === 0 ? r.stdout.split('\n') : []) {
      if (l.startsWith('@')) { when = l.slice(1).trim(); continue; }
      const f = look.get(lc(l.trim()));
      if (f && when && !out.has(key(f))) out.set(key(f), { changed: new Date(when).toISOString(), changed_by: 'git' });
    }
  }
  for (const f of files) if (!out.has(key(f))) { try { out.set(key(f), { changed: fs.statSync(f).mtime.toISOString(), changed_by: 'mtime' }); } catch { out.set(key(f), { changed: null, changed_by: null }); } }
  return out;
}

// `@path` imports (Claude Code / Gemini CLI): a token starting with @ at a line start or after a space, outside fenced code
function importsOf(text, file, home) {
  const out = [];
  let fence = false;
  for (const l of String(text).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    for (const m of l.matchAll(/(?:^|\s)@([^\s`'"()<>]+)/g)) {
      const t = m[1].replace(/[.,;:]+$/, '');
      if (!/\.[A-Za-z0-9]{1,8}$/.test(t)) continue;
      const abs = t.startsWith('~/') ? path.join(home, t.slice(2)) : path.isAbsolute(t) ? t : path.join(path.dirname(file), t);
      if (isFile(abs)) out.push(abs);
    }
  }
  return out;
}

/**
 * Every file that steers an agent of project p. o: { home (the user's home: a fixture in tests), machine (loadMachine object; gives
 * the norn gen targets + the Claude config dir; none = no gen rows), git (default true: last change from git) }.
 */
export function discover(p, { home, machine = null, git = true } = {}) {
  home = fwd(home || machine?.home || process.env.USERPROFILE || process.env.HOME || '');
  const rows = new Map();
  const add = (file, base, specs) => {
    const k = key(file);
    const r = rows.get(k);
    if (r) {
      r.loads.push(...specs);
      if (base.generated) Object.assign(r, { generated: true, source: base.source, drift: base.drift, gen_kind: base.gen_kind });
      return r;
    }
    const n = { path: fwd(path.resolve(file)), kind: base.kind, generated: !!base.generated, loads: [...specs], ...base };
    rows.set(k, n);
    return n;
  };
  const hs = harnessRows();
  const vars = { home, claude_config: fwd(machine?.claude?.config_dir || path.join(home, '.claude')) };
  const tmpl = s => s.replace(/\$\{(\w+)\}/g, (a, v) => vars[v] ?? a);

  // 1. the repo: root files every session of the family, nested ones on demand; repo agents (role) and skills (their description)
  // A monorepo project (p.subdir): its runs work inside the subdir, so the files of every folder from the repo root down to it load
  // every session; files nested under the subdir load on demand; the other folders of the repo are other projects' and are left out
  // (their CLAUDE.md was scanned, flagged and sent to the fixer as this project's).
  const root = p.root, sub = subdirOf(p), inSub = rel => !sub || rel === sub || rel.startsWith(sub + '/');
  const upTo = sub ? sub.split('/').map((_, i, a) => a.slice(0, i + 1).join('/')) : [];
  if (root && fs.existsSync(root)) {
    for (const h of hs) for (const n of h.repo) { const f = path.join(root, n); if (isFile(f)) add(f, { kind: 'repo', harness0: h.family }, [{ class: 'session', families: [h.family] }]); }
    for (const d of upTo) for (const h of hs) for (const n of h.repo) { const f = path.join(root, d, n); if (isFile(f)) add(f, { kind: 'repo', harness0: h.family }, [{ class: 'session', families: [h.family] }]); }
    const names = [...new Set(hs.flatMap(h => h.repo.map(n => path.posix.basename(n))))];
    for (const rel of repoFiles(root, names)) {
      const f = path.join(root, rel), base = path.posix.basename(rel);
      if (rows.has(key(f))) continue;
      if (!inSub(rel) && !/^\.claude\//.test(rel)) continue;   // another folder of the monorepo: not this project's
      if (/^\.claude\/agents\//.test(rel)) { add(f, { kind: 'agent' }, [{ class: 'role', role: path.basename(rel, '.md'), families: ['claude'] }]); continue; }
      if (/^\.claude\/rules\//.test(rel)) { add(f, { kind: 'rule' }, [ruleLoad(f)]); continue; }   // META-PRACTICE-P1: no (parsable) paths = every session
      if (/^\.claude\/skills\//.test(rel)) { add(f, { kind: 'skill' }, [{ class: 'session', families: ['claude'], part: 'description' }]); continue; }
      const fams = hs.filter(h => h.repo.some(n => path.posix.basename(n) === base)).map(h => h.family);
      add(f, { kind: 'repo' }, [{ class: 'on-demand', families: fams }]);
    }
  }
  // 2. the user's own files (this machine only, read-only)
  for (const h of hs) for (const t of h.user || []) { const f = tmpl(t); if (isFile(f)) add(f, { kind: 'user' }, [{ class: 'session', families: [h.family] }]); }
  // 2b. META-PRACTICE-P1: the user's .claude/rules and the auto-memory folder (MEMORY.md: every Claude session that keeps memory - the
  // launch key policy.launch.memory per role; the topic files on demand). machine_only: the owner's files, read-only.
  { let es = []; try { es = fs.readdirSync(path.join(vars.claude_config, 'rules')).sort(); } catch { /* none */ }
    for (const n of es) { const f = path.join(vars.claude_config, 'rules', n); if (/\.md$/i.test(n) && isFile(f)) add(f, { kind: 'rule' }, [ruleLoad(f)]); } }
  const mem = root ? memoryDir(root, vars.claude_config) : null;
  if (mem && isFile(path.join(mem, 'MEMORY.md'))) {
    add(path.join(mem, 'MEMORY.md'), { kind: 'memory' }, [{ class: 'session', families: ['claude'], memory: true }]);
    let es = []; try { es = fs.readdirSync(mem).sort(); } catch { /* unreadable memory folder: only MEMORY.md is listed, no topic rows */ }
    for (const n of es) { const f = path.join(mem, n); if (/\.md$/i.test(n) && n !== 'MEMORY.md' && isFile(f)) add(f, { kind: 'memory-topic' }, [{ class: 'on-demand', families: ['claude'], memory: true }]); }
  }
  // 3. the project's rules: rules_read_whole + checkin_extra every check-in, the rest of the rules folder on demand
  for (const f of p.rules_read_whole || []) if (isFile(f)) add(f, { kind: 'rules' }, [{ class: 'checkin' }]);
  if (p.checkin_extra && isFile(p.checkin_extra)) add(p.checkin_extra, { kind: 'checkin_extra' }, [{ class: 'checkin' }]);
  const ruleDirs = new Set([...(p.rules_read_whole || []), p.checkin_extra].filter(Boolean).map(f => path.dirname(f)));
  if (p.project_dir) ruleDirs.add(path.join(p.project_dir, 'rules'));
  for (const d of ruleDirs) {
    let es = []; try { es = fs.readdirSync(d); } catch { /* rules folder absent: it adds no rows, the next folder is scanned */ }
    for (const n of es.sort()) { const f = path.join(d, n); if (/\.(md|txt)$/i.test(n) && isFile(f) && !rows.has(key(f))) add(f, { kind: 'rules' }, [{ class: 'on-demand' }]); }
  }
  // 4. Norn's own prompts: the check-in template (major / minor tick) and the chat's system prompt
  const pr = path.join(ENGINE, 'prompts');
  for (const [n, spec] of [['CHECKIN.md', { class: 'checkin', tick: 'major' }], ['CHECKIN-MINOR.md', { class: 'checkin', tick: 'minor' }], ['CHAT.md', { class: 'chat' }]])
    if (isFile(path.join(pr, n))) add(path.join(pr, n), { kind: 'prompt' }, [spec]);
  // 5. norn gen targets (with their drift state) and their sources
  if (machine?.claude) {
    let items = [];
    try { items = genStates(p, machine); } catch { items = []; }
    const cfg = vars.claude_config;
    for (const it of items) {
      if (!/\.(md|json|txt)$/i.test(it.target)) continue;
      const b = path.basename(it.target), fam = under(it.target, cfg) ? 'claude' : 'codex';
      const specs = it.kind === 'agent' ? [{ class: 'role', role: path.basename(b, '.md'), families: ['claude'] }]
        : it.kind === 'skill' ? [b === 'SKILL.md' ? { class: 'session', families: [fam], part: 'description' } : { class: 'on-demand', families: [fam] }]
        : it.kind === 'pack' ? [{ class: 'role', role: b.split('.')[0], families: [b.split('.').slice(-2, -1)[0]] }]
        : it.kind === 'global' ? [{ class: 'session', families: ['codex'] }] : [{ class: 'on-demand', families: ['claude'] }];
      const t = add(it.target, { kind: it.kind, generated: true, gen_kind: it.kind, source: fwd(it.source), drift: it.state, planned: it.body.toString('utf8') }, specs);
      const s = add(it.source, { kind: `${it.kind}-source` }, [{ class: 'source' }]);
      t.id = idOf(t.path); (s.feeds ||= []).includes(t.id) || s.feeds.push(t.id);
    }
  }
  // 6. imports (`@file`) of every harness that has them: the imported file is loaded with its importer (5 hops, as Claude Code)
  const importing = new Set(hs.filter(h => h.imports).map(h => h.family));
  const queue = [...rows.values()].map(r => [r, 0]);
  while (queue.length) {
    const [r, depth] = queue.shift();
    const fams = new Set(r.loads.flatMap(s => s.families || [])), via = ['repo', 'user', 'import', 'rule'].includes(r.kind);
    if (depth >= 5 || !via || ![...fams].some(f => importing.has(f))) continue;
    const text = readText(r.path);
    if (text == null) continue;
    for (const f of importsOf(text, r.path, home)) {
      const specs = r.loads.filter(s => s.class !== 'source').map(s => ({ ...s, families: (s.families || []).filter(x => importing.has(x)), via: r.path }));
      const had = rows.has(key(f)), n = add(f, { kind: 'import' }, specs);
      if (!had) { Object.assign(n, { import_depth: depth + 1, importer: fwd(r.path) }); queue.push([n, depth + 1]); }
    }
  }
  // finish: size, lines, change, where, the strongest load, families
  const out = [], when = changedOf([...rows.values()].filter(r => isFile(r.path)).map(r => r.path), git);
  for (const r of rows.values()) {
    const disk = readText(r.path), exists = disk != null, text = disk ?? r.planned ?? null;   // a missing gen target: the size it will have
    const fm = text != null && /SKILL\.md$/i.test(r.path) ? frontmatter(text).meta : null;
    const tokens = estTokens(text ?? ''), desc = fm ? estTokens(`${fm.name || ''}: ${fm.description || ''}`) : tokens;
    const load = LOADS.find(c => r.loads.some(s => s.class === c)) || 'on-demand';
    const full = r.loads.some(s => ['session', 'checkin', 'chat', 'role'].includes(s.class) && s.part !== 'description');
    const where = under(r.path, p.root) ? 'repo' : under(r.path, ENGINE) ? 'engine' : under(r.path, p.project_dir) ? 'project' : under(r.path, p.state) ? 'state' : under(r.path, home) ? 'home' : 'other';
    const role = r.loads.find(s => s.class === 'role')?.role;
    const { harness0, planned, ...rest } = r;
    out.push({ ...rest, id: r.id || idOf(r.path), name: path.basename(r.path), where, harness: [...new Set([harness0, ...r.loads.flatMap(s => s.families || [])].filter(Boolean))],
      load, ...(role ? { role } : {}), tokens, desc_tokens: desc, standing_tokens: full ? tokens : desc, lines: text != null ? text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0) : 0,
      chars: text != null ? text.length : 0, ...(when.get(key(r.path)) || { changed: null, changed_by: null }), machine_only: where === 'home', ...(where === 'engine' ? { norn_file: true } : {}), exists });
  }
  const order = r => [LOADS.indexOf(r.load), r.where, r.path];
  return out.sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1].localeCompare(y[1]) || x[2].localeCompare(y[2]); });
}
/** a .claude/rules file's load spec: parsable `paths` = on demand (when a matching file is read), else every Claude session */
function ruleLoad(f) { const t = readText(f) || '', ps = rulePaths(t); return frontOf(t).ok && ps.length ? { class: 'on-demand', families: ['claude'], paths: ps } : { class: 'session', families: ['claude'] }; }
const idOf = p => createHash('sha1').update(key(p)).digest('hex').slice(0, 10);

// ---------- sessions + daily cost ----------
/** the sessions of project p on UTC day (YYYY-MM-DD) from runs.jsonl (every run that started) + the chat thread's process starts:
 * [{ run?, kind: worker | checkin | chat, family, executor, agent, tick }] */
export function sessionsOn(state, p, day = new Date().toISOString().slice(0, 10)) {
  const out = [];
  let items = {};
  try { items = loadState(state).items; } catch { items = {}; }
  const cliFam = ADAPTERS.cli.instructions || {};
  for (const it of Object.values(items)) {
    if (it.kind !== 'run' || it.history?.[0]?.ev !== 'start' || String(it.created).slice(0, 10) !== day) continue;
    const d = it.data || {}, ex = d.executor || 'claude', entry = p?.executors?.[ex];
    let fam = harnessOf(ex, entry) ?? (entry?.preset || entry?.exe ? 'cli' : null);
    if (fam === 'fake' || !fam) continue;   // the test double loads nothing
    if (fam === 'cli') fam = cliFam[entry?.preset || ex]?.family ?? ex;
    out.push({ run: it.id, kind: d.kind === 'checkin' ? 'checkin' : 'worker', family: fam, executor: ex, agent: d.agent ?? null, tick: d.tick_class || 'major', role: d.kind === 'checkin' ? 'checkin' : roleOfSpec({ lane: d.lane }), memory: d.memory !== 'off' });
  }
  for (const l of (readText(threadFile(state)) || '').split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j?.kind === 'start' && String(j.ts).slice(0, 10) === day) out.push({ kind: 'chat', family: 'claude', executor: 'claude', agent: null, tick: null });
  }
  return out;
}

/** does load spec sp load in session s */
export function matches(sp, s) {
  const fam = sp.families?.length ? sp.families.includes(s.family) || sp.families.includes(s.executor) : true;
  if (sp.memory && s.memory === false) return false;   // META-PRACTICE-P1: a launch with auto memory off loads no memory file
  if (sp.class === 'session') return fam;
  if (sp.class === 'checkin') return s.kind === 'checkin' && (!sp.tick || sp.tick === s.tick) && (!sp.families?.length || fam);
  if (sp.class === 'chat') return s.kind === 'chat';
  if (sp.class === 'role') return s.kind === 'worker' && s.agent === sp.role && fam;
  return false;
}
const tokensFor = (r, sp) => (sp.part === 'description' ? r.desc_tokens : r.tokens);
const perSession = (r, s) => Math.max(0, ...r.loads.filter(sp => matches(sp, s)).map(sp => tokensFor(r, sp)));
export const profileKey = s => (s.kind === 'checkin' ? `checkin:${s.tick || 'major'}` : s.kind === 'chat' ? 'chat' : `worker:${s.family}${s.agent ? ':' + s.agent : ''}`);
const profileLabel = s => (s.kind === 'checkin' ? `check-in (${s.tick || 'major'})` : s.kind === 'chat' ? 'chat' : `worker${s.agent ? ' ' + s.agent : ''} (${s.family})`);

/** rows + sessions -> { rows (+ loads_today, cost_today; a source: its targets' sum, via), standing [{ key, label, sessions, tokens }], total } */
export function dailyCost(rows, sessions, { policy = null } = {}) {
  const memOn = role => memoryOf(policy, role) === 'on';
  const out = rows.map(r => {
    const hit = sessions.filter(s => r.loads.some(sp => matches(sp, s)));
    return { ...r, loads_today: hit.length, cost_today: hit.reduce((n, s) => n + perSession(r, s), 0) };
  });
  const byId = new Map(out.map(r => [r.id, r]));
  for (const r of out) if (r.load === 'source' && r.feeds?.length) {
    const t = r.feeds.map(i => byId.get(i)).filter(Boolean);
    Object.assign(r, { loads_today: t.reduce((n, x) => n + x.loads_today, 0), cost_today: t.reduce((n, x) => n + x.cost_today, 0), via: true });
  }
  const profiles = new Map();
  const prof = s => { const k = profileKey(s); if (!profiles.has(k)) profiles.set(k, { s, n: 0 }); return profiles.get(k); };
  for (const s of sessions) prof(s).n++;
  prof({ kind: 'checkin', tick: 'major', family: 'claude', executor: 'claude', memory: memOn('checkin') });
  for (const r of rows) for (const sp of r.loads) if (sp.class === 'role') for (const f of sp.families || ['claude']) prof({ kind: 'worker', family: f, executor: f, agent: sp.role, memory: memOn('worker') });
  const loaded = out.filter(r => r.load !== 'source');
  const standing = [...profiles.entries()].map(([k, { s, n }]) => ({ key: k, label: profileLabel(s), sessions: n, tokens: loaded.reduce((t, r) => t + perSession(r, s), 0) }))
    .sort((a, b) => b.sessions - a.sessions || b.tokens - a.tokens || a.key.localeCompare(b.key));
  return { rows: out, standing, total: loaded.reduce((n, r) => n + r.cost_today, 0) };
}

// ---------- lint (read-only hints) ----------
// META-UX-BUILD S5: each hint kind's kind of fix (advisory.mjs FIX_KINDS) and its batch title on the Slop page
export const HINT_FIX = {
  'missing-path': { kind: 'drafts', title: 'Names a path that does not exist' }, 'unknown-command': { kind: 'drafts', title: 'Names a norn command that does not exist' },
  'stale-citation': { kind: 'drafts', title: 'Cites a revoked or superseded record' }, duplicate: { kind: 'drafts', title: 'The same paragraph twice' },
  'directive-clash': { kind: 'call', ways: ['Follow the newer directive', 'Keep this line'], title: 'Says the opposite of a newer directive' },
};
/** the top-level norn commands: the HELP list + the dispatch of engine/bin/norn.mjs */
export function knownCommands() {
  const src = readText(path.join(ENGINE, 'bin', 'norn.mjs')) || '';
  const set = new Set([...src.matchAll(/^ {2}(?:norn|meta) ([a-z][a-z-]*)\s/gm)].map(m => m[1]));
  for (const m of src.matchAll(/argv\[0\] === '([a-z-]+)'/g)) set.add(m[1]);
  for (const m of src.matchAll(/\[((?:'[a-z-]+',?\s*)+)\]\.includes\(argv\[0\]\)/g)) for (const n of m[1].matchAll(/'([a-z-]+)'/g)) set.add(n[1]);
  return set;
}

const NEG = /\b(never|no longer|don'?t|do not|stop|not|without|forbid(?:den)?|ban(?:ned)?|instead of)\b/i;
const paraNorm = s => s.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '').replace(/\s+/g, ' ').trim().toLowerCase();
/** the lines of text outside fenced code: [{ n (1-based), text }] */
const proseLines = text => { let fence = false; return String(text).split(/\r?\n/).map((t, i) => ({ n: i + 1, t })).filter(({ t }) => { if (/^\s*(```|~~~)/.test(t)) { fence = !fence; return false; } return !fence; }).map(({ n, t }) => ({ n, text: t })); };

function pathCandidate(tok, vars) {
  let t = tok.replace(/^[('"]+/, '').replace(/[.,:;)!'"]+$/, '').replace(/:\d+(?:-\d+)?$/, '').replace(/\\/g, '/');
  if (t.startsWith('/')) return null;   // a literal /token (a URL path, a flag); a POSIX root reached through ${root} / ~/ is checked below
  t = t.replace(/\$\{(\w+)\}/g, (a, v) => vars[v] ?? a);
  if (!t || /[*?<>{}|$%]|\.\.\.|:\/\/|^-|^@/.test(t)) return null;
  if (t.startsWith('~/')) t = vars.home + t.slice(1);
  const abs = /^[A-Za-z]:\//.test(t) || t.startsWith('/');
  if (!abs && !(t.includes('/') && /\.[A-Za-z0-9]{1,8}$/.test(t.split('/').pop()))) return null;
  return { t, abs };
}

/**
 * Read-only hints over the hand-written rows (a generated target is linted through its source): missing-path, unknown-command,
 * duplicate (a paragraph of >= 120 chars in two files), stale-citation (a DIR- / DEC- id that was revoked / superseded / overruled),
 * directive-clash (an active directive newer than the file shares a `term` with a line of opposite polarity - never / always).
 * o: { project, commands (Set), home } -> [{ id, path, kind, line, text }]
 */
export function lint(rows, { project: p = {}, commands = knownCommands(), home } = {}) {
  const hints = [], files = rows.filter(r => r.exists && !r.generated && r.chars <= 2_000_000);
  home = fwd(home || process.env.USERPROFILE || process.env.HOME || '');
  const vars = { home, root: p.root, meta: p.meta, project_dir: p.project_dir, state: p.state, dev: p.dev, name: p.name };
  const bases = [p.root, p.project_dir, p.meta, p.dev, home].filter(Boolean);
  let items = {};
  try { if (p.state) items = loadState(p.state).items; } catch { items = {}; }
  const directives = Object.values(items).filter(i => i.kind === 'directive' && i.state === 'active');
  const paras = new Map();
  for (const r of files) {
    const text = readText(r.path) || '', lines = proseLines(text), hint = (kind, line, t, x = {}) => hints.push({ id: r.id, path: r.path, kind, line, text: t, ...x });
    const seen = new Set();
    for (const { n, text: l } of lines) {
      const spans = [...l.matchAll(/`([^`\n]+)`/g)].map(m => m[1]);
      const bare = l.replace(/`[^`\n]*`/g, ' ').match(/(?<![\w/])(?:[A-Za-z]:[\\/]|~\/|\$\{(?:home|root|meta|project_dir|state|dev)\}\/)[^\s`'"<>|*?,;()[\]]+/g) || [];
      for (const s of spans) {
        const c = s.trim().match(/^(norn|meta) ([a-z][\w-]*)/);
        if (c && commands.size && !commands.has(c[2])) hint('unknown-command', n, `\`${c[1]} ${c[2]}\` is not a norn command`);
      }
      for (const tok of [...spans.filter(s => !/^(?:norn|meta)\s/.test(s.trim())).flatMap(s => s.split(/\s+/)), ...bare]) {
        const c = pathCandidate(tok, vars);
        if (!c || seen.has(c.t)) continue;
        seen.add(c.t);
        const cands = c.abs ? [c.t] : [path.dirname(r.path), ...bases].map(b => fwd(path.join(b, c.t)));
        if (!cands.some(x => fs.existsSync(x))) hint('missing-path', n, `${c.t} does not exist`, { cands }); // cands: where it was looked for
      }
      for (const m of l.matchAll(/\b((?:DIR|DEC)-\d+)\b/g)) {
        const it = items[m[1]];
        if (it && ['revoked', 'superseded', 'overruled'].includes(it.state)) hint('stale-citation', n, `cites ${m[1]}, which is ${it.state}${it.superseded_by ? ` (by ${it.superseded_by})` : ''}`);
      }
      const ts = Date.parse(r.changed ?? '');
      for (const d of directives) {
        if (!Number.isFinite(ts) || !(Date.parse(d.created) > ts)) continue;
        const terms = [...String(d.data?.text || '').matchAll(/`([^`\n]{3,})`|"([^"\n]{3,})"/g)].map(m => (m[1] || m[2]).toLowerCase());
        const t = terms.find(x => l.toLowerCase().includes(x));
        if (t && NEG.test(d.data.text) !== NEG.test(l)) hint('directive-clash', n, `"${l.trim().slice(0, 120)}" vs the newer ${d.id} (${String(d.created).slice(0, 10)}): ${String(d.data.text).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    // paragraphs (blank-line separated, outside fences) for the duplicate check
    let start = null, buf = [];
    const flush = () => { const t = paraNorm(buf.join('\n')); if (t.length >= 120) { if (!paras.has(t)) paras.set(t, []); paras.get(t).push({ r, line: start }); } buf = []; start = null; };
    for (const { n, text: l } of lines) { if (!l.trim()) { flush(); continue; } if (start === null) start = n; buf.push(l); }
    flush();
  }
  for (const [t, at] of paras) {
    const distinct = [...new Map(at.map(a => [a.r.id, a])).values()];
    if (distinct.length < 2) continue;
    for (const a of distinct) hints.push({ id: a.r.id, path: a.r.path, kind: 'duplicate', line: a.line,
      text: `paragraph "${t.slice(0, 60)}..." also in ${distinct.filter(b => b !== a).map(b => `${b.r.name} (${b.r.path})`).join(', ')}` });
  }
  return hints;
}

// ---------- the view (dashboard / CLI / MCP) ----------
/** the mean loads per day of each row over the 7 UTC days before now's day: Map id -> { loads, byRole { worker | checkin | chat: n } } */
export function loadsPerDay(rows, p, now = Date.now(), days = 7) {
  const out = new Map(rows.map(r => [r.id, { loads: 0, byRole: {} }]));
  if (!p.state) return out;
  for (let d = 1; d <= days; d++) {
    const ss = sessionsOn(p.state, p, new Date(now - d * DAY_MS).toISOString().slice(0, 10));
    for (const r of rows) for (const s of ss) if (r.loads.some(sp => matches(sp, s))) {
      const x = out.get(r.id), role = s.kind === 'checkin' ? 'checkin' : s.kind === 'chat' ? 'chat' : 'worker';
      x.loads += 1 / days; x.byRole[role] = (x.byRole[role] || 0) + 1 / days;
    }
  }
  for (const x of out.values()) { x.loads = Math.round(x.loads * 100) / 100; for (const k in x.byRole) x.byRole[k] = Math.round(x.byRole[k] * 100) / 100; }
  return out;
}
const tailCache = new Map();
export const TREND_DAYS = 30;
/** the measured standing context of project p (standing.mjs) over the last `days` days, + window_days */
export function measuredStanding(p, { machine = null, home, now = Date.now(), days = 7 } = {}) {
  if (!p.state) return null;
  const h = home || machine?.home || '';
  const runs = standingRuns(p.state, p, { projectsDir: machine?.claude?.projects_dir || path.join(h, '.claude', 'projects'),
    codexDir: machine?.codex?.sessions_dir || path.join(h, '.codex', 'sessions'), now, days: Math.max(days, TREND_DAYS), cache: tailCache });
  const since = now - days * 86400000;
  // META-TEND P5 (REPORT 5.3 view 1): "is it growing forever?" - the median standing context per session, per role and day, 30 days
  return { ...standingSummary(runs.filter(r => Date.parse(r.created) >= since)), window_days: days, trend: { days: TREND_DAYS, rows: standingSummary(runs).days } };
}

/** { project, day, method, sessions, total, rows (+ loads_today, cost_today, hints, stale, oldest_days), standing, hints, measured, suggest, stale_days }
 * (+ a non-enumerable `paras`: Map id -> paragraphs, for the file view). o.standing: a measured summary (tests); else measured here. */
export function instructionsView(p, { home, machine = null, now = Date.now(), day = new Date(now).toISOString().slice(0, 10), git = true, ages = true, standing, remember = false } = {}) {
  const rows = discover(p, { home, machine, git });
  const sessions = p.state ? sessionsOn(p.state, p, day) : [];
  const c = dailyCost(rows, sessions, { policy: p.policy });
  const hints = lint(rows, { project: p, home: home || machine?.home });
  const count = new Map();
  for (const h of hints) count.set(h.id, (count.get(h.id) || 0) + 1);
  const measured = standing !== undefined ? standing : measuredStanding(p, { machine, home, now });
  const staleDays = p.policy?.instructions?.stale_days ?? 30, paras = new Map(), perDay = loadsPerDay(rows, p, now);
  let sug = [];
  if (ages) {
    let items = {};
    try { if (p.state) items = loadState(p.state).items; } catch { items = {}; }
    const dated = rows.filter(r => r.exists && !r.generated && r.chars <= 2_000_000), confirms = confirmations(p.state);
    const dates = lineDates(dated, { state: p.state, now, git });
    for (const r of dated) paras.set(r.id, paragraphs(readText(r.path) || '', dates.get(r.id), { items, now, staleDays, confirms, file: r.path }));
    const profiles = Object.fromEntries([...PROFILE_ROLES.map(k => [k, profileOf(p.policy, k)]), ['lean', profileOf({ launch: { ...(p.policy?.launch || {}), roles: { x: 'lean' } } }, 'x')]]);
    sug = suggest({ rows: dated, hints, paras, perDay, standing: measured, profiles });
  }
  const v = { project: p.name, day, method: TOKEN_METHOD, sessions: sessions.length, total: c.total,
    rows: c.rows.map(r => { const ps = paras.get(r.id); return { ...r, hints: count.get(r.id) || 0, loads_day: perDay.get(r.id)?.loads ?? 0, ...(ps ? { stale: ps.filter(x => x.stale).length, oldest_days: Math.max(0, ...ps.map(x => x.age_days ?? 0)) } : {}) }; }),
    standing: c.standing, hints, measured, suggest: sug, stale_days: staleDays,
    checkins: p.state ? checkinDays(p.state, { now }) : [] };   // META-CHECKIN-DIET R1: per day check-ins: n (m mechanical, k minor, j full)
  // META-PRACTICE-P1: the static checks (free, no model call) + the one-line "managed" summary; remember = keep the last scan's keys
  let items = {};
  try { if (p.state) items = loadState(p.state).items; } catch { items = {}; }
  v.findings = staticChecks(rows, { project: p, home: fwd(home || machine?.home || process.env.USERPROFILE || process.env.HOME || ''), items, harness: harnessRows(), versions: { claude: machine?.claude?.version } });
  const fc = new Map();
  for (const f of v.findings) if (f.row) fc.set(f.row, (fc.get(f.row) || 0) + 1);
  for (const r of v.rows) r.findings = fc.get(r.id) || 0;
  // META-TEND P1-VISUAL: the file map's colour per file + the memory map (REPORT 5.3 views 3 and 5)
  const conflict = new Set();
  for (const f of v.findings) { if (CONFLICT_CHECKS.has(f.check)) conflict.add(f.path.toLowerCase()); if (f.other) conflict.add(f.other.toLowerCase()); }
  for (const r of v.rows) r.map_state = mapState(r, conflict);
  const memRow = rows.find(r => r.kind === 'memory');
  v.memory_map = memoryMap(rows, { opened: memRow ? memoryOpened(path.dirname(memRow.path), { now }) : new Map() });
  // META-TEND P3: the rule ledger (every must / never rule, its one home, its enforcement, when it last fired) + the repeat cards
  v.rules = ruleLedger(rows, { project: p, items, hints, home: fwd(home || machine?.home || process.env.USERPROFILE || process.env.HOME || ''), files: projectFiles(p), remember, now });
  const rc = rowCounts(v.rules.rules);
  for (const r of v.rows) r.rules = rc.get(r.id) || { total: 0, prose: 0, repeated: 0, enforced: 0 };
  // META-TEND P5: check 20 (read evidence: opened / cited per file; never read + never cited = a prune advisory) + the audit runs
  if (p.state) {
    const h = home || machine?.home || '';
    v.evidence = readEvidence(v.rows, p, { items, projectsDir: machine?.claude?.projects_dir || path.join(h, '.claude', 'projects'), now });
    for (const r of v.rows) { const e = v.evidence.files[r.id]; if (e) { r.reads = e.reads; r.read_last = e.last; r.cites = e.cites.length; } }
    v.audits = auditsView(p, items, { rows: v.rows, cards: v.rules.cards, machine });
    v.findings.push(...v.evidence.advisories, ...v.audits.advisories);
    for (const a of [...v.evidence.advisories, ...v.audits.advisories]) { const r = v.rows.find(x => x.id === a.row || fwd(x.path).toLowerCase() === fwd(a.path ?? '').toLowerCase()); if (r) r.findings = (r.findings || 0) + 1; }
  }
  // the Slop rows a file's advice links to (Context's "in Slop" opens Slop at &finding=<id>): its worst finding, its first hint, its
  // first stale paragraph (a tightening row)
  const rowAt = new Map(v.rows.map(r => [fwd(r.path).toLowerCase(), r.id])), slop = new Map(v.rows.map(r => [r.id, {}]));
  const put = (id, k, sid) => { const s = id && slop.get(id); if (s && !s[k]) s[k] = sid; };
  for (const f of v.findings) put(f.row || rowAt.get(fwd(f.path ?? '').toLowerCase()), 'finding', f.id);
  for (const h of hints) put(h.id, 'hint', hintSlopId(h));
  for (const x of sug) if (x.class === 'stale' && x.path) put(rowAt.get(fwd(x.path).toLowerCase()), 'stale', 'T-' + x.id);
  for (const r of v.rows) r.slop = slop.get(r.id);
  v.managed = managedLine(p, v, { remember, now });
  Object.defineProperty(v, 'paras', { value: paras, enumerable: false });
  return v;
}

// conflict = two files say the same thing or point past each other: a memory line restating a repo file (6, both sides), twin
// AGENTS.md / CLAUDE.md (11), a pointer to a Moved: stub (13). A generated file not in sync with its source wins over the rest.
const CONFLICT_CHECKS = new Set([6, 11, 13]);
const mapState = (r, conflict) => (r.generated && !['ok', 'same'].includes(r.drift) ? 'generated-stale' : conflict.has(fwd(r.path).toLowerCase()) ? 'conflict' : r.stale ? 'stale' : 'fresh');
/** { files, open, by_severity, fixed, since, memory { role: on | off } }; remember: keep the scan's finding keys in <state>/instructions-scan.json
 * (a cache, not a record): "fixed" = the keys of the last scan that changed and are gone now */
function managedLine(p, v, { remember, now }) {
  const keys = [...new Set(v.findings.map(f => f.id))].sort(), sev = {};
  for (const f of v.findings) sev[f.severity] = (sev[f.severity] || 0) + 1;
  const file = p.state ? path.join(p.state, 'instructions-scan.json') : null;
  let last = null;
  try { last = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { last = null; }
  let fixed = last?.fixed || 0, since = last?.since || null;
  if (last?.keys && last.keys.join() !== keys.join()) { const now2 = new Set(keys); fixed = last.keys.filter(x => !now2.has(x)).length; since = last.at; }
  if (remember && file && last?.keys?.join() !== keys.join()) { try { fs.writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), keys, fixed, since })); } catch { /* read-only state */ } }
  return { files: v.rows.length, open: v.findings.length, by_severity: sev, fixed, since, memory: Object.fromEntries(PROFILE_ROLES.map(r => [r, memoryOf(p.policy, r)])) };
}
const k = n => (n >= 1000 ? `~${(n / 1000).toFixed(1)}k` : `~${n}`);
const loadText = r => (r.load === 'role' ? `role ${r.role}` : r.load === 'session' && r.standing_tokens < r.tokens ? 'every session (description)' : LOAD_LABEL[r.load] || r.load);
/** the view as text (norn instructions) */
export function formatInstructions(v) {
  const rows = [['load', 'harness', 'size', 'today', 'changed', 'gen', 'hints', 'file'],
    ...v.rows.map(r => [loadText(r), r.harness.join(',') || 'any', k(r.tokens), r.cost_today ? k(r.cost_today) + (r.via ? ' via' : '') : '-', (r.changed || '-').slice(0, 10),
      r.generated ? (r.drift || 'yes') : '-', String(r.hints || '-'), r.path])];
  const w = rows[0].map((_, i) => Math.max(...rows.map(c => c[i].length)));
  const table = rows.map(c => c.map((s, i) => (i === c.length - 1 ? s : s.padEnd(w[i]))).join('  ').trimEnd());
  return [`Instructions of ${v.project} - ${v.day}: ${v.rows.length} files, ${k(v.total)} tokens loaded today by ${v.sessions} session(s)`,
    `(${v.method})`, '', ...formatMeasured(v.measured), ...table, '', 'Standing context per role from the files alone (tokens one session of it loads before any work):',
    ...v.standing.map(s => `  ${s.label.padEnd(32)} ${k(s.tokens).padStart(8)}   ${s.sessions} session(s) today`), '',
    `Hints (${v.hints.length}, read-only - nothing is edited):`, ...v.hints.map(h => `  ${h.kind.padEnd(16)} ${h.path}:${h.line}  ${h.text}`), '',
    ...(v.managed ? [`Managed: ${v.managed.files} files scanned, ${v.managed.open} findings open, ${v.managed.fixed} fixed since the last scan; memory: ${Object.entries(v.managed.memory).map(([r, m]) => `${r} ${m}`).join(', ')}`] : []),
    ...(v.findings || []).map(f => `  C${String(f.check).padEnd(3)} ${f.severity.padEnd(6)} ${f.path}:${f.line}  ${f.why}  -> ${f.fix.action}`)].join('\n');
}

// ---------- META-STANDING-CONTEXT R1: dated lines, STALE, confirm, suggest ----------
const DAY_MS = 86400000;
const sha = s => createHash('sha1').update(s).digest('hex');
const gitOut = (cwd, args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null; };
/** git blame of one file -> [iso per line] (an uncommitted line: now), or null (not in a repo / not tracked) */
function blame(file, nowIso) {
  const out = gitOut(path.dirname(file), ['blame', '--line-porcelain', '--', path.basename(file)]);
  if (out == null) return null;
  const dates = [];
  let sha0 = null, when = null;
  for (const l of out.split('\n')) {
    if (/^[0-9a-f]{40} \d+ \d+/.test(l)) { sha0 = l.slice(0, 40); when = null; continue; }
    if (l.startsWith('committer-time ')) { when = Number(l.slice(15)) * 1000; continue; }
    if (l.startsWith('\t')) dates.push(/^0+$/.test(sha0 || '') || !when ? nowIso : new Date(when).toISOString());
  }
  return dates;
}
/** Norn's first-seen snapshot of a file outside git: <state>/instructions/seen/<id>.json { path, lines { sha1(line): iso } } */
function seenDates(r, lines, state, nowIso) {
  if (!state) return lines.map(() => r.changed || nowIso);
  const f = path.join(state, 'instructions', 'seen', `${r.id}.json`);
  let snap; try { snap = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { snap = { path: r.path, lines: {} }; }
  let dirty = false;
  const dates = lines.map(l => { const h = sha(l); if (!snap.lines[h]) { snap.lines[h] = nowIso; dirty = true; } return snap.lines[h]; });
  if (dirty) { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(snap)); fs.renameSync(tmp, f); }
  return dates;
}
/** rows -> Map id -> { by: git | seen, dates [iso per line] }. o: { state (snapshots), now, git (default true) } */
export function lineDates(rows, { state = null, now = Date.now(), git = true } = {}) {
  const out = new Map(), nowIso = new Date(now).toISOString();
  for (const r of rows) {
    const text = readText(r.path);
    if (text == null) continue;
    const lines = text.split(/\r?\n/);
    if (text.endsWith('\n')) lines.pop();
    const b = git ? blame(r.path, nowIso) : null;
    out.set(r.id, b && b.length === lines.length ? { by: 'git', dates: b } : { by: 'seen', dates: seenDates(r, lines, state, nowIso) });
  }
  return out;
}

/** the dates a line states: ISO dates, MM-DD (the year of the line's own date; never after it), DIR- / DEC- ids (their record date) */
export function statedDates(line, lineIso, items = {}) {
  const out = [], ref = Date.parse(lineIso), y = Number.isFinite(ref) ? new Date(ref).getUTCFullYear() : new Date().getUTCFullYear();
  const ok = (Y, M, D) => { const t = Date.UTC(Y, M - 1, D); const d = new Date(t); return d.getUTCMonth() === M - 1 && d.getUTCDate() === D ? t : null; };
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const taken = [];
  for (const m of line.matchAll(/(?<![\w-])(20\d\d)-(\d\d)-(\d\d)(?![\w-])/g)) { const t = ok(+m[1], +m[2], +m[3]); taken.push([m.index, m.index + m[0].length]); if (t !== null) out.push({ date: iso(t), from: m[0] }); }
  for (const m of line.matchAll(/(?<![\w.-])(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?![\w.-])/g)) {
    if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue;
    let t = ok(y, +m[1], +m[2]);
    if (t !== null && Number.isFinite(ref) && t > ref + DAY_MS) t = ok(y - 1, +m[1], +m[2]);
    if (t !== null) out.push({ date: iso(t), from: m[0] });
  }
  for (const m of line.matchAll(/\b((?:DIR|DEC)-\d+)\b/g)) { const c = items[m[1]]?.created; if (c) out.push({ date: String(c).slice(0, 10), from: m[1] }); }
  return out;
}

/** confirm records (norn instructions confirm): Map `${key(file)}#${anchor}` -> latest ISO */
export function confirmations(state) {
  const out = new Map();
  if (!state) return out;
  for (const l of (readText(path.join(state, 'instructions.jsonl')) || '').split('\n')) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e?.kind !== 'confirm' || !e.data?.file || !e.data?.anchor) continue;
    const k = `${key(e.data.file)}#${e.data.anchor}`;
    if (!out.has(k) || out.get(k) < e.ts) out.set(k, e.ts);
  }
  return out;
}

const SUPERSEDED = ['revoked', 'superseded', 'overruled'];
const FENCE = /^\s*(```|~~~)/;
/**
 * The paragraphs of a file (blank-line separated; a fenced block stays whole) with their age:
 * [{ anchor (p<sha8> of the text), line, end, tokens, head, changed (newest line date), stated (newest stated date), since, age_days,
 *   confirmed, cites [{ id, state, by }], stale, why }]. o: { items, now, staleDays, confirms, file }
 */
export function paragraphs(text, dates, { items = {}, now = Date.now(), staleDays = 30, confirms = new Map(), file = null } = {}) {
  const lines = String(text).split(/\r?\n/), ds = dates?.dates || [], out = [];
  let start = null, fence = false;
  const flush = end => {
    if (start === null) return;
    const body = lines.slice(start, end), t = body.join('\n');
    const changed = body.map((_, i) => ds[start + i]).filter(Boolean).sort().pop() || null;
    const stated = body.flatMap((l, i) => statedDates(l, ds[start + i] || changed, items)).map(x => x.date).sort().pop() || null;
    const anchor = 'p' + sha(paraNorm(t)).slice(0, 8), conf = file ? confirms.get(`${key(file)}#${anchor}`) || null : null;
    const base = stated ? `${stated}T00:00:00.000Z` : changed, since = [base, conf].filter(Boolean).sort().pop() || null;
    const age = since ? Math.max(0, Math.floor((now - Date.parse(since)) / DAY_MS)) : null;
    const cites = [...new Set([...t.matchAll(/\b((?:DIR|DEC)-\d+)\b/g)].map(m => m[1]))].map(id => items[id]).filter(it => it && SUPERSEDED.includes(it.state))
      .map(it => ({ id: it.id, state: it.state, by: it.superseded_by ?? null }));
    const old = age !== null && age > staleDays;
    const src = stated ? 'its stated date' : conf ? 'its confirmation' : dates?.by === 'git' ? 'its last commit' : 'first seen';
    const why = [...cites.map(c => `cites ${c.id}, which is ${c.state}${c.by ? ` (by ${c.by})` : ''}`), ...(old ? [`older than ${staleDays} d (${age} d since ${src}), never confirmed`] : [])];
    out.push({ anchor, line: start + 1, end, tokens: estTokens(t), head: t.trim().replace(/\s+/g, ' ').slice(0, 100), changed, stated, since, age_days: age,
      confirmed: !!conf, cites, stale: why.length > 0, why: why.join('; ') });
    start = null;
  };
  lines.forEach((l, i) => {
    const f = FENCE.test(l);
    if (f) fence = !fence;
    if (!fence && !f && !l.trim()) { flush(i); return; }
    if (start === null) start = i;
  });
  flush(lines.length);
  return out;
}

// the role a paragraph addresses by its first words ("Check-ins: ...", "Workers ..."), else null
const ROLE_LEAD = [[/^(?:[-*]\s*)?(?:\*\*)?check-?ins?\b/i, 'checkin'], [/^(?:[-*]\s*)?(?:\*\*)?(?:workers?|implementers?)\b/i, 'worker'], [/^(?:[-*]\s*)?(?:\*\*)?merge(?: runs?)?\b/i, 'merge'], [/^(?:[-*]\s*)?(?:\*\*)?(?:the )?chat\b/i, 'chat']];
const roleOfPara = head => ROLE_LEAD.find(([re]) => re.test(head))?.[1] ?? null;
/** the unified diff that deletes a paragraph (and the blank line after it) */
function deletePatch(r, text, p) {
  const lines = text.split(/\r?\n/), n = p.end - p.line + 1 + (lines[p.end] !== undefined && !lines[p.end].trim() && p.end < lines.length - 1 ? 1 : 0);
  const gone = lines.slice(p.line - 1, p.line - 1 + n);
  return `--- a/${r.path}\n+++ b/${r.path}\n@@ -${p.line},${n} +${p.line - 1},0 @@\n${gone.map(l => '-' + l).join('\n')}\n`;
}
export const LARGE_TOKENS = 400;
// META-UX-BUILD S5: each tightening class's kind of fix (advisory.mjs FIX_KINDS) and its batch title on the Slop page. Stale paragraphs carry
// a patch too, but it deletes old text of the owner's: your call, never ticked for him (REPORT s.3).
export const TIGHTEN_FIX = {
  superseded: { kind: 'ready', title: 'Tighten: cites a record no longer in force' }, duplicate: { kind: 'ready', title: 'Tighten: a duplicate paragraph' },
  stale: { kind: 'call', ways: ['Delete it', 'Confirm it'], title: 'Tighten: a stale paragraph' },
  'one-role': { kind: 'drafts', title: 'Tighten: a one-role paragraph every session loads' }, large: { kind: 'drafts', title: 'Tighten: a large block loaded every time' },
  lean: { kind: 'call', ways: ['Switch the role to lean', 'Keep the full profile'], title: 'Tighten: a lean launch profile' },
};
// A block never moves out of a file that says it is read whole ("Every worker reads this file whole") nor out of a hard-stop or safety
// section: a pointer there is a rule a worker may skip (solve-shack RUN-180 declined both moves, rightly). Such a block is trimmed in place.
const READ_WHOLE = /\bread(?:s|ing)?\s+(?:this\s+(?:file|document)\s+|it\s+)?(?:whole|in\s+full|end\s+to\s+end)\b|\bmust\s+be\s+read\s+(?:whole|in\s+full)\b/i;
const SAFETY = /\bhard[\s-]?stops?\b|\bsafety\b/i;
/** why paragraph p stays in its file (null = it may move): the file is read whole, or p sits in a hard-stop / safety section */
function keepIn(text, p, whole) {
  if (whole) return 'the file says it is read whole';
  const head = text.split(/\r?\n/).slice(0, p.line).reverse().find(l => /^#{1,6}\s/.test(l));
  return SAFETY.test(head ?? '') || SAFETY.test(p.head) ? `it is in a hard-stop / safety section${head ? ` (${head.replace(/^#+\s*/, '').trim().slice(0, 60)})` : ''}` : null;
}
const trimAction = why => `trim it in place: shorten the wording, keep it in this file (${why}: never move it out)`;
const LEAN_DROPS = { skills: s => s.skills === false, plugins: s => s.user_setup === false || s.skills === false, hooks: s => s.user_setup === false, mcp: s => s.mcp === 'norn' || s.mcp === 'none' };

/**
 * Ranked tightening candidates (read-only): [{ id, class, path, file, anchor, line, head, tokens, loads_per_day, saved_per_day, why, action,
 * patch?, role?, owner_file }]. Classes: superseded, duplicate, stale (paragraphs), one-role (a paragraph addressed to one role in a file
 * every session loads), large (>= LARGE_TOKENS in a loaded file), lean (the standing parts a lean launch profile drops, per role).
 * o: { rows, hints, paras (Map id -> paragraphs), perDay (Map id -> { loads, byRole }), standing (+ window_days), profiles { role: profile, lean } }
 */
export function suggest({ rows, hints = [], paras, perDay, standing = null, profiles = {} }) {
  const out = [], dupAt = new Map();
  for (const h of hints) if (h.kind === 'duplicate') dupAt.set(`${h.id}#${h.line}`, h.text);
  for (const r of rows) {
    const ps = paras.get(r.id);
    if (!ps) continue;
    const text = readText(r.path) || '', pd = perDay.get(r.id) || { loads: 0, byRole: {} }, owner = !!r.machine_only;
    const every = r.loads.some(sp => sp.class === 'session' && sp.part !== 'description'), whole = READ_WHOLE.test(text);
    const add = (cls, p, saved, why, action, patch, extra = {}) => out.push({ id: 'S-' + sha(`${cls}|${key(r.path)}|${p.anchor}`).slice(0, 8), class: cls, path: r.path, file: r.name,
      anchor: p.anchor, line: p.line, head: p.head, tokens: p.tokens, loads_per_day: pd.loads, saved_per_day: Math.round(saved), why, action, ...(patch ? { patch } : {}), owner_file: owner, ...extra });
    for (const p of ps) {
      const dup = dupAt.get(`${r.id}#${p.line}`);
      if (p.cites.length) add('superseded', p, p.tokens * pd.loads, p.why, 'delete it (or cite the record in force)', deletePatch(r, text, p));
      else if (dup) add('duplicate', p, p.tokens * pd.loads, dup, 'keep one copy, delete this one', deletePatch(r, text, p));
      else if (p.stale) add('stale', p, p.tokens * pd.loads, p.why, `delete it, or confirm it: norn instructions confirm ${r.path}#${p.anchor}`, deletePatch(r, text, p));
      else if (every && roleOfPara(p.head)) {
        const role = roleOfPara(p.head), others = Object.entries(pd.byRole).filter(([k]) => k !== role).reduce((n, [, v]) => n + v, 0), stay = keepIn(text, p, whole);
        add('one-role', p, p.tokens * others, `addressed to ${role} only, loaded by every session`, stay ? trimAction(stay) : `move it to the ${role} prompt / an on-demand file`, null, { role, ...(stay ? { keep: stay } : {}) });
      } else if (p.tokens >= LARGE_TOKENS && pd.loads > 0) {
        const stay = keepIn(text, p, whole);
        add('large', p, p.tokens * pd.loads, `~${p.tokens} tokens in one block, loaded ${pd.loads.toFixed(1)}x a day`, stay ? trimAction(stay) : 'move it to an on-demand file and leave a one-line pointer', null, stay ? { keep: stay } : {});
      }
    }
  }
  // lean: what a lean launch profile drops from each role's measured standing context (only where the role runs "full" today)
  const win = standing?.window_days || 7, lean = profiles.lean || profileOf({ launch: { roles: { x: 'lean' } } }, 'x');
  for (const g of standing?.roles || []) {
    const sp = standing.parts?.[g.key], cur = profiles[g.role]?.name ?? 'full';
    if (!sp || cur !== 'full' || g.family !== 'claude') continue;
    const tools = new Set((lean.disallowed_tools || []).map(t => `tool ${t}`));
    const drop = [...(sp.parts || []).filter(x => LEAN_DROPS[x.key]?.(lean) && x.tokens > 0),
      ...(sp.parts || []).flatMap(x => (x.items || []).filter(i => tools.has(i.name) && i.tokens > 0).map(i => ({ key: i.name, tokens: i.tokens })))];
    const tok = drop.reduce((n, x) => n + x.tokens, 0), per = g.runs / win;
    if (!tok) continue;
    out.push({ id: 'S-' + sha(`lean|${g.key}`).slice(0, 8), class: 'lean', role: g.role, key: g.key, path: null, file: `launch profile (${g.key})`, anchor: null, line: null,
      head: `${g.key}: ${drop.map(x => `${x.key} ~${x.tokens}`).join(', ')}`, tokens: tok, loads_per_day: per, saved_per_day: Math.round(tok * per),
      why: `the lean profile drops ${drop.map(x => x.key).join(' + ')} from each ${g.key} session (measured turn 1)`, action: `policy.launch.roles.${g.role} = "lean" (after the calibration in NOTES)`, owner_file: false });
  }
  return out.sort((a, b) => b.saved_per_day - a.saved_per_day || b.tokens - a.tokens || String(a.id).localeCompare(String(b.id)));
}

/** apply one suggestion's patch (the controller chat's tap tier / the owner): the paragraph must be unchanged; user files: the owner only */
export function applySuggestion(v, id, { role = 'controller', dryRun = false } = {}) {
  const s = (v.suggest || []).find(x => x.id === id);
  if (!s) throw new Error(`${id}: no such suggestion (norn instructions suggest lists them)`);
  if (!s.patch) throw new Error(`${id} (${s.class}) has no patch: ${s.action}`);
  if (s.owner_file && role !== 'owner') throw new Error(`${s.path} is the owner's user-level file: only the owner applies it (--as owner)`);
  const text = readText(s.path);
  if (text == null) throw new Error(`${s.path} is gone`);
  const p = paragraphs(text, null).find(x => x.anchor === s.anchor);
  if (!p) throw new Error(`${id}: the paragraph ${s.anchor} is no longer in ${s.path} (changed since the suggestion) - run suggest again`);
  if (p.line !== s.line) throw new Error(`${id}: the paragraph moved (line ${s.line} -> ${p.line}) - run suggest again`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n', lines = text.split(/\r?\n/), drop = Number(s.patch.match(/^@@ -\d+,(\d+)/m)[1]);
  lines.splice(p.line - 1, drop);
  if (!dryRun) { const tmp = `${s.path}.${process.pid}.tmp`; fs.writeFileSync(tmp, lines.join(eol)); fs.renameSync(tmp, s.path); }
  return { applied: !dryRun, id, path: s.path, removed: drop };
}

/** the measured standing context as text lines (empty when nothing was measured) */
export function formatMeasured(m) {
  if (!m?.roles?.length) return [];
  const M = n => (n === null || n === undefined ? '-' : k(Math.round(n)));
  const rows = m.roles.map(r => `  ${r.key.padEnd(18)} ${String(r.runs).padStart(5)} runs  turn 1 ${M(r.median_turn1).padStart(7)}  create ${M(r.median_create1).padStart(7)}  turns ${String(r.median_turns ?? '-').padStart(5)}  cache reads ${M(r.cache_read).padStart(8)}`);
  const parts = Object.entries(m.parts || {}).map(([key, s]) => `  ${key.padEnd(18)} ${s.parts.filter(x => x.tokens).map(x => `${x.key} ${k(x.tokens)}`).join(' · ')}  (${s.run}, ${s.method})`);
  return [`Measured standing context, last ${m.window_days ?? 7} days (median per session; ${m.method}):`, ...rows, '', 'Where it goes (the latest run of each role):', ...parts, ''];
}
/** norn instructions suggest (text): the ranked list with the exact patch where there is one */
export function formatSuggest(v) {
  const s = v.suggest || [];
  const out = [`Tightening candidates for ${v.project} - ${s.length}, ranked by ~tokens saved / day (read-only: nothing is edited; apply = norn instructions apply <S-id>, the owner's tap)`, ''];
  for (const x of s) {
    out.push(`${x.id}  ${x.class.padEnd(10)} ~${x.saved_per_day} saved / day  (~${x.tokens} tokens x ${x.loads_per_day} loads / day)${x.owner_file ? '  [owner file]' : ''}`,
      `    ${x.path ? `${x.path}:${x.line} #${x.anchor}` : x.file}  "${x.head.slice(0, 90)}"`, `    why: ${x.why}`, `    do:  ${x.action}`);
    if (x.patch) out.push(x.patch.trimEnd());
    out.push('');
  }
  return out.join('\n');
}
