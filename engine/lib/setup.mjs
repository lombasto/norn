// `norn setup` / `norn project add` / `norn doctor` (META-GENERAL-DESIGN 4.2 / 8). machine.json = discovered values only;
// project agents / skills are copied into the Claude config dir with a sha manifest (local/install-manifest.json) so doctor can
// report drift. A target meta did not install (or one edited after install) is never overwritten.
// The scheduler (engine/lib/sched/*): setup records the discovered kind and installs nothing; `norn sched install` does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { discover, resolveShim, which } from './paths.mjs';
import { PREREQS, hint, nodeOk } from './prereqs.mjs';
import { loadState } from './records.mjs';
import { adapterFor as schedAdapter, realIo as schedIo, schedName, schedState, normDir, liveName } from './sched/index.mjs';
import { spawnSync } from 'node:child_process';
import { loadMachine, loadProject, validate, portable, metaRoot, fwd, ConfigError, MACHINE_SCHEMA, PROJECT_SCHEMA, updateMachine } from './config.mjs';
import { fileURLToPath } from 'node:url';
import { providersOf, keySet, isCli, capKey, capDefault } from './executors.mjs';
import { ADAPTERS } from './harness/index.mjs';
import { listProcs, runFacts, strays, strayLine, derelicts, derelictLine } from './strays.mjs';
import { readDash, dashRows } from './dashlive.mjs';
import { starterPolicy, allowedExecutors, ROLE_AGENTS, slopOn } from './policy.mjs';
import { HEADLESS_SLOP } from './harness/common.mjs';
import { getProfile, checkChoice, profileBudget, profilePolicy } from './profiles.mjs';
import { floorOf } from './floor.mjs';
import { newTopic, subscribeLink, ntfyServer } from './notify.mjs';
import { remoteDoctor } from './remote.mjs';
import { authDoctorLines } from './authguard.mjs';
import { profileDoctorLines } from './standing.mjs';
import { checkinDoctorLines } from './checkins.mjs';
import { limitLines } from './limitgate.mjs';
import { splitRepo, normSubdir } from './monorepo.mjs';
import { RUST_PARTS, ensurePart, partProblem, binOf, buildOf } from './rustbin.mjs';
import { frontOf } from './instrchecks.mjs';
import { repoFacts } from './gitfacts.mjs';
import { githubRepo } from './overlap.mjs';
const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export class SetupError extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }

const shaBuf = b => crypto.createHash('sha256').update(b).digest('hex');
const sha = f => shaBuf(fs.readFileSync(f));
const machineFile = meta => path.join(meta, 'local', 'machine.json');
const manifestFile = meta => path.join(meta, 'local', 'install-manifest.json');
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 1) + '\n'); fs.renameSync(f + '.tmp', f); };
const readManifest = meta => (fs.existsSync(manifestFile(meta)) ? JSON.parse(fs.readFileSync(manifestFile(meta), 'utf8')) : { schema: 1, entries: [] });
// FOLLOWUP R1: a target can be managed by several projects (the generic role agents share ~/.claude/agents/<role>.md): the entry's
// `projects` lists them all (`project` = the last writer; an old entry without `projects` is managed by `project` alone)
const owners = e => e.projects ?? [e.project];
const expandNorn = (s, meta) => s.split('${norn}').join(fwd(meta));
const exists = p => fs.existsSync(p);
const key = p => { const a = fwd(path.resolve(p)); return process.platform === 'win32' ? a.toLowerCase() : a; };

function filesUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p)); else if (e.isFile()) out.push(p);
  }
  return out;
}

// project sources hold ${...} forms only (S3 lint); text files are installed with the project's builtin vars rendered (S8).
// ${var:win} = the same value with backslashes (Windows-form paths in today's hand-kept targets, H3). Unknown ${...} (shell vars,
// the late ${lane}) stay as written. Binary files (NUL byte) are copied as they are.
function renderText(s, p, home) {
  const v = { norn: p.meta, meta: p.meta, home: fwd(home), root: p.root, dev: p.dev, name: p.name, state: p.state, project_dir: p.project_dir };
  return s.replace(/\$\{(norn|meta|home|root|dev|name|state|project_dir)(:win)?\}/g, (all, k, w) => (v[k] == null ? all : w ? String(v[k]).replace(/\//g, '\\') : v[k]));
}
function rendered(src, p, home) {
  const b = fs.readFileSync(src);
  if (b.includes(0)) return b;
  return Buffer.from(renderText(b.toString('utf8'), p, home));
}

/** Claude-style frontmatter: `key: value` lines (the first colon splits), `[a, b]` = list. { meta, body }. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const l of m[1].split(/\r?\n/)) {
    const i = l.indexOf(':');
    if (i <= 0 || /^\s/.test(l)) continue;
    const k = l.slice(0, i).trim(), v = l.slice(i + 1).trim();
    meta[k] = /^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean) : v;
  }
  return { meta, body: text.slice(m[0].length) };
}

// families that get packs (HARNESS-DESIGN sec. 5): codex when the machine has it, and every enabled cli executor of the project
// (named after the executor, the cli adapter's headless snippet); not claude (native agents) or fake (the claude test double).
// norn-lifecycle item 6: never for an executor whose cap in force is 0 (local/budget.json: the Codex total / both Codex models,
// max_<name> of a cli executor) - no run can use the pack, and a pack written before is removed by installProject (orphan packs).
const packTargets = (p, machine, caps = capsInForce(p.meta)) => [...(machine.codex && allowedExecutors(CODEX_EXECUTORS, caps).length ? [['codex', ADAPTERS.codex]] : []),
  ...Object.entries(providersOf(p)).filter(([n, x]) => isCli(x) && x.enabled !== false && (Number.isInteger(caps[capKey(n)]) ? caps[capKey(n)] : capDefault(x)) > 0).map(([n]) => [n, ADAPTERS.cli])];
// skill dirs per family: claude = today's target; codex = <home>/.codex/skills (MEASURED: exists, holds .system), opt-in per skill
// via `harnesses: [...]` in its SKILL.md (default [claude] = today). Other families: no known dir (GUESS paths are not written).
const skillDir = (family, machine, home) => ({ claude: `${machine.claude.config_dir}/skills`, codex: machine.codex ? `${fwd(home)}/.codex/skills` : null })[family] || null;
const mdFiles = d => fs.readdirSync(d).filter(x => x.endsWith('.md') && fs.statSync(path.join(d, x)).isFile()).sort();

/** Every generated target of project p: { items: [{ kind, source, target, body }], problems } (problems = unrenderable sources). */
export function plan(p, machine, { out = () => {} } = {}) {
  const cfg = machine.claude.config_dir, home = machine.home || os.homedir(), items = [], problems = [];
  const add = (kind, source, target, body) => items.push({ kind, source, target, body: Buffer.isBuffer(body) ? body : Buffer.from(body) });
  const dirOk = (k, d) => { if (!d) return false; if (exists(d)) return true; out(`note: ${p.name}: ${k} dir ${d} does not exist - nothing installed`); return false; };
  const port = f => portable(f, { meta: p.meta });
  const agents = dirOk('agents', p.install?.agents) ? mdFiles(p.install.agents).map(f => path.join(p.install.agents, f)) : [];
  for (const f of agents) add('agent', f, `${cfg}/agents/${path.basename(f)}`, rendered(f, p, home));
  // skills: every file of a skill dir goes to each family the skill names (default claude)
  const skills = [];
  if (dirOk('skills', p.install?.skills)) {
    for (const f of filesUnder(p.install.skills)) {
      const rel = fwd(path.relative(p.install.skills, f)), name = rel.split('/')[0];
      const sk = path.join(p.install.skills, name, 'SKILL.md'), fm = exists(sk) ? frontOf(fs.readFileSync(sk, 'utf8')).meta : {};
      const fams = Array.isArray(fm.harnesses) ? fm.harnesses : ['claude'];
      if (rel === `${name}/SKILL.md`) skills.push({ name, description: fm.description || '', fams });
      for (const fam of fams) { const d = skillDir(fam, machine, home); if (d) add('skill', f, `${d}/${rel}`, rendered(f, p, home)); }
    }
  }
  // roles = agents/*.md + roles/*.md -> one pack per family the machine has (narrowed by `harnesses:`); the role with `resume:` = the
  // Claude SessionStart resume hook JSON (install.resume_hook)
  const roles = [...agents, ...(dirOk('roles', p.install?.roles) ? mdFiles(p.install.roles).map(f => path.join(p.install.roles, f)) : [])];
  let hook = null;
  for (const f of roles) {
    const { meta: fm, body } = frontOf(fs.readFileSync(f, 'utf8')), name = fm.name || path.basename(f, '.md');
    if (fm.resume && p.install?.resume_hook) {
      if (hook) problems.push(`${p.name}: roles ${hook} and ${port(f)} both set resume: (one hook)`);
      else {
        hook = port(f);
        const j = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: renderText(fm.resume, p, home) } };
        if (fm.resume_message) j.systemMessage = renderText(fm.resume_message, p, home);
        add('hook', f, p.install.resume_hook, JSON.stringify(j) + '\n');
      }
    }
    const incs = [];
    let bad = false;
    for (const inc of fm.include || []) {
      const abs = renderText(inc, p, home);
      if (!exists(abs)) { problems.push(`${p.name}: ${port(f)} includes ${inc}, which does not exist`); bad = true; continue; }
      incs.push(`\n<!-- include ${inc} -->\n${renderText(frontOf(fs.readFileSync(abs, 'utf8')).body, p, home).trimEnd()}\n`);
    }
    if (bad) continue;
    for (const [fam, ad] of packTargets(p, machine)) {
      if (Array.isArray(fm.harnesses) && !fm.harnesses.includes(fam)) continue;
      const listed = ad.caps.skills === 'claude' ? [] : skills.filter(s => !(s.fams.includes(fam) && skillDir(fam, machine, home)));
      const sk = listed.length ? `\n## Skills (instructions for you: read the file when its trigger fits)\n`
        + listed.map(s => `- ${s.name}: read ${cfg}/skills/${s.name}/SKILL.md when ${s.description}`).join('\n') + '\n' : '';
      add('pack', f, `${p.state}/packs/${name}.${fam}.md`, `<!-- generated by norn gen from ${port(f)} for the ${fam} harness: edit the source, not this file -->\n`
        + `${renderText(body, p, home).trimEnd()}\n${incs.join('')}${sk}\n## Headless\n${slopOn(p.policy) ? ad.headless : ad.headless.replace(HEADLESS_SLOP, '')}\n`);
    }
  }
  // harness-global.md -> each family's global instruction file: codex <home>/.codex/AGENTS.md (MEASURED); others GUESS -> not written
  if (p.install?.harness_global) {
    if (!exists(p.install.harness_global)) problems.push(`${p.name}: install.harness_global ${p.install.harness_global} does not exist`);
    else if (machine.codex) add('global', p.install.harness_global, `${fwd(home)}/.codex/AGENTS.md`, rendered(p.install.harness_global, p, home));
  }
  return { items, problems };
}

// writes every planned target; manifest sha256 = the generated bytes, source_sha256 = the source bytes (doctor's stale check).
// A target meta did not generate (and that differs) or one edited after generation is reported, never overwritten; an unmanaged
// target with the same bytes is adopted (today's hand-kept files).
export function installProject(p, machine, { meta, out }) {
  const man = readManifest(meta), { items, problems } = plan(p, machine, { out });
  let n = 0, kept = 0;
  for (const { kind, source, target, body } of items) {
    const s = shaBuf(body), entry = man.entries.find(e => e.target === target);
    if (exists(target)) {
      const t = sha(target);
      if (t !== s && !entry) { problems.push(`${target} exists and is not managed by meta: not overwritten`); continue; }
      if (t !== s && entry.sha256 !== t) { problems.push(`${target} was edited after install (drift): not overwritten`); continue; }
    }
    if (!exists(target) || sha(target) !== s) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body); n++; }
    kept++;
    const e = { project: p.name, projects: [...new Set([...(entry ? owners(entry) : []), p.name])], kind, source: portable(source, { meta }), target, sha256: s, source_sha256: sha(source) };
    man.entries = man.entries.filter(x => x.target !== target).concat(e);
  }
  let gone = 0;
  for (const o of orphanPacks(p, man, items)) {
    if (o.state === 'drift') { problems.push(orphanLine(o)); continue; }
    fs.rmSync(o.e.target, { force: true }); gone++;
    man.entries = man.entries.filter(x => x !== o.e);
  }
  if (items.length || gone) writeJson(manifestFile(meta), man);
  out(`${p.name}: ${kept} generated file(s) managed, ${n} written${gone ? `, ${gone} pack(s) no longer generated removed` : ''}${problems.length ? `, ${problems.length} problem(s)` : ''}`);
  return problems;
}

// norn-lifecycle item 6 (K14 held DLV-6 on packs gen wrote itself): a manifest pack of p alone that p's plan no longer generates.
// state ok = unedited since gen wrote it (or gone) - gen's own file: gen removes it, never a K14 finding; drift = hand-edited (kept, a problem)
function orphanPacks(p, man, items) {
  const planned = new Set(items.map(i => i.target));
  return man.entries.filter(e => e.kind === 'pack' && owners(e).length === 1 && owners(e)[0] === p.name && !planned.has(e.target))
    .map(e => ({ e, state: !exists(e.target) || sha(e.target) === e.sha256 ? 'ok' : 'drift' }));
}
const orphanLine = o => `${o.e.target}: orphan pack edited after generation (no source generates it any more; never removed)`;
/** `norn gen --check`: the drift doctor for every target of p - writes nothing; returns problem lines (target first). */
/** The drift state of one planned target against the manifest: ok | missing | adoptable (same bytes, not recorded yet) | unmanaged |
 * same (edited to the generated bytes) | drift (edited after generation) | stale (sources changed since generation). */
export function targetState({ target, body }, man) {
  const s = shaBuf(body), entry = man.entries.find(e => e.target === target);
  if (!exists(target)) return 'missing';
  const t = sha(target);
  if (!entry) return t === s ? 'adoptable' : 'unmanaged';
  if (t !== entry.sha256) return t === s ? 'same' : 'drift';
  return t !== s ? 'stale' : 'ok';
}
/** META-INSTRUCTIONS R1: every planned target of p with its drift state (writes nothing): [{ kind, source, target, body, state }]. */
export function genStates(p, machine, { meta = p.meta } = {}) {
  const man = readManifest(meta);
  return plan(p, machine).items.map(i => ({ ...i, state: targetState(i, man) }));
}

export function genCheck(p, machine, { meta, out }) {
  const man = readManifest(meta), { items, problems } = plan(p, machine);
  for (const it of items) {
    // a problem names its source: the slop gate's K14 counts it only when a branch's diff touches that source (audit D3)
    const { target } = it, st = targetState(it, man), src = ` [source ${fwd(it.source)}]`;
    if (st === 'missing') problems.push(`${target}: missing (run norn gen)${src}`);
    else if (st === 'adoptable') out(`note ${target}: not in the manifest yet, same bytes (norn gen adopts it)`);
    else if (st === 'unmanaged') problems.push(`${target} exists and is not managed by meta (norn gen will not overwrite it)${src}`);
    else if (st === 'same') out(`note ${target}: edited to the same bytes as generated (norn gen re-records it, writes nothing)`);
    else if (st === 'drift') problems.push(`${target}: drift (edited after generation; never overwritten)${src}`);
    else if (st === 'stale') problems.push(`${target}: stale (sources changed since generation; run norn gen)${src}`);
  }
  const planned = new Set(items.map(i => i.target)), packs = orphanPacks(p, man, items);
  for (const o of packs) if (o.state === 'drift') problems.push(orphanLine(o)); else out(`note ${o.e.target}: no longer generated (its executor is capped at 0 or gone) - norn gen removes it`);
  for (const e of man.entries) if (owners(e).includes(p.name) && !planned.has(e.target) && !packs.some(o => o.e === e)) problems.push(`${e.target}: orphan (no source of ${p.name} generates it any more)`);
  return problems;
}

/** DEC-362: after a policy save rewrote the marked lines in p's generator sources, regenerate p's harness targets (norn gen for that
 * project). Runs only when p is registered in its meta root's machine.json; a hand-edited target stays a problem (never overwritten).
 * { ran, why?, problems, lines }. */
export function genAfterPolicy(p, { meta = p.meta } = {}) {
  const g = genWhyNot(p, { meta }); if (g.not) return g.not;
  const lines = [], problems = installProject(p, g.m, { meta, out: s => lines.push(s) });
  return { ran: true, problems, lines };
}
/** genAfterPolicy's precondition (shared with the dash server, which runs `norn gen --project` as a child - META-DASH-ASYNC R1):
 * { not: the { ran: false, why } reply } or { m: the machine } */
export function genWhyNot(p, { meta = p.meta } = {}) {
  if (!exists(machineFile(meta))) return { not: { ran: false, why: `no machine.json under ${fwd(meta)}: norn gen not run`, problems: [], lines: [] } };
  const m = loadMachine(machineFile(meta), { meta });
  if (!m.projects.some(pr => key(expandNorn(pr.config, meta)) === key(p.file))) return { not: { ran: false, why: `${p.name} is not registered in machine.json: norn gen not run`, problems: [], lines: [] } };
  return { m };
}

const rawMachine = meta => JSON.parse(fs.readFileSync(machineFile(meta), 'utf8'));

export function projectAdd(file, { env = process.env, out, err }) {
  const meta = metaRoot(env);
  if (!exists(machineFile(meta))) throw new SetupError('no machine.json: run norn setup first');
  const machine = loadMachine(machineFile(meta), { meta });
  let p;
  try { p = loadProject(file, { home: machine.home, meta }); } catch (e) { throw new SetupError(e.message); }
  const raw = rawMachine(meta), config = portable(file, { meta });
  const same = raw.projects.find(x => x.name === p.name);
  if (same && key(expandNorn(same.config, meta)) !== key(p.file)) throw new SetupError(`a project named ${p.name} is already registered (${same.config})`);
  if (!same) updateMachine(machineFile(meta), r => ({ projects: [...r.projects, { name: p.name, config }] }));
  out(`${p.name} ${same ? 'already registered' : 'added'} (${config})`);
  const problems = installProject(p, machine, { meta, out });
  for (const x of problems) err('error: ' + x);
  return problems.length ? 1 : 0;
}

// ---------- META-ONBOARD S3: `norn project new` (SPEC 3.3) ----------
const CODEX_EXECUTORS = ['codex-sol', 'codex-astra'];
const choose = o => { try { checkChoice(o); return getProfile(o.profile); } catch (e) { throw new SetupError(e.message); } };
const under = (p, dir) => { const a = key(p), d = key(dir).replace(/\/+$/, ''); return a === d || a.startsWith(d + '/'); };

// the caps in force (local/budget.json; none yet = no limit set). One that does not parse throws: read as {} it lifted every cap, and
// the starter routing and the packs went to an executor the owner capped at 0
function capsInForce(meta) {
  if (!meta) return {};
  const f = path.join(meta, 'local', 'budget.json');
  let t; try { t = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  try { return JSON.parse(t.replace(/^﻿/, '')); } catch (e) { throw new SetupError(`${fwd(f)}: ${e.message}`, 1); }
}
/** a caps profile on this machine (setup and adopt both apply one through here) -> { cur, next }: the caps in force and them with the
 *  profile's keys merged in - Codex caps only when machine.json has a Codex (else 0), the worker raised to the floor in force */
export function profileCaps(meta, prof, cost) {
  const cur = capsInForce(meta), codex = exists(machineFile(meta)) && !!rawMachine(meta).codex?.exe;
  return { cur, next: { ...cur, ...profileBudget(prof, { found: ['claude', ...(codex ? CODEX_EXECUTORS : [])], cost, floor: floorOf(cur) }) } };
}

/** o: { root, name, title, branch, ci, executors, dir, nonInteractive, register, print, env, out, err, ask } -> exit code */
export function projectNew(o) {
  const { env = process.env, out, err } = o;
  const meta = metaRoot(env);
  if (!exists(machineFile(meta))) throw new SetupError('no machine.json: run norn setup first');
  const machine = loadMachine(machineFile(meta), { meta });
  const given = path.resolve(o.root || process.cwd());
  // a monorepo: a folder below the repo's top level (or --subdir) = a project of that folder (project.subdir); root = the top level
  const split = splitRepo(given);
  if (!split) throw new SetupError(`${fwd(given)} is not a git repo (git rev-parse --show-prefix)`);
  let subdir;
  try { subdir = o.subdir !== undefined ? normSubdir(o.subdir) : split.subdir; } catch (e) { throw new SetupError(e.message); }
  if (o.subdir !== undefined && split.subdir && subdir !== split.subdir) throw new SetupError(`--root ${fwd(given)} is the folder ${split.subdir} of its repo, --subdir says ${subdir}: give one of them`);
  const root = path.resolve(split.root);
  if (subdir && !exists(path.join(root, subdir))) throw new SetupError(`subdir ${subdir}: no such folder in ${fwd(root)}`);
  const facts = repoFacts(root, subdir), detected = { name: facts.name, branch: facts.default_branch, ci: githubRepo(facts.origin) || 'none' };
  const hasCodex = !!machine.codex?.exe, have = ['claude', ...(hasCodex ? CODEX_EXECUTORS : [])];
  detected.executors = have.join(',');
  const interactive = !o.nonInteractive && (process.stdin.isTTY || env.META_INTERACTIVE === '1');
  const ask = (label, def) => {
    if (!interactive) return def;
    out(`${label} [${def}]:`);
    const l = (o.ask || readLineSync)();
    return l && l.trim() ? l.trim() : def;
  };
  const name = ask('name', o.name ?? detected.name);
  const title = ask('title', o.title ?? name);
  const ciRepo = ask('ci', o.ci ?? detected.ci);
  const branch = ask('branch', o.branch ?? detected.branch);
  // META-OOTB-POLISH F-6: --profile / --cost (a cost alone = the default profile); refused before any question is asked
  const prof = o.profile !== undefined || o.cost !== undefined ? choose(o) : null;
  const exList = ask('executors', o.executors ?? detected.executors).split(',').map(s => s.trim()).filter(Boolean);
  for (const x of exList) {
    if (!['claude', ...CODEX_EXECUTORS].includes(x)) throw new SetupError(`unknown executor ${x} (project new knows: claude, ${CODEX_EXECUTORS.join(', ')}; others are added by hand - SETUP.md)`);
    if (!have.includes(x)) throw new SetupError(`executor ${x} not detected on this machine (codex not found: run norn setup after installing it)`);
  }
  const draft = {
    schema: 1, name, title, root: fwd(root), ...(subdir ? { subdir } : {}),
    ledger: '${state}/progress.md', briefs_dir: '${state}/briefs',
    views: { questions: '${state}/views/OWNER-QUESTIONS.md', directives: '${state}/views/DIRECTIVES.md', decisions: '${state}/views/DECISIONS-LOG.md' },
    lane_defaults: { worktree: '${state}/wt/${lane}', notes: '${state}/notes/${lane}/NOTES.md' },
    ...(ciRepo && ciRepo !== 'none' ? { ci: { repo: ciRepo, branch } } : {}),
    executors: Object.fromEntries(CODEX_EXECUTORS.map(x => [x, { enabled: exList.includes(x) }])),
    // META-OOTB F-2: the engine's generic role agents, copied next to project.json (yours to edit) and installed from there
    install: { agents: '${project_dir}/agents' },
    policy: prof
      ? { ...profilePolicy(prof, { found: allowedExecutors(exList, capsInForce(meta)), cost: o.cost, floor: floorOf(capsInForce(meta)) }), cadence: { auto_resume_handoff: true, auto_resume_max: 2, trigger_on_exit: false, checkin_interval_min: prof.scheduler.interval_min } }
      : { ...starterPolicy(exList, capsInForce(meta)), cadence: { auto_resume_handoff: true, auto_resume_max: 2, trigger_on_exit: false } },
  };
  const errs = validate(PROJECT_SCHEMA, draft);
  if (errs.length) throw new SetupError(`project.json draft invalid, nothing written: ${errs.join('; ')}`);
  if (o.print) { out(JSON.stringify(draft, null, 1)); return 0; }
  // META-NOTIFY-SETUP R1: the same step as setup - asked only when the machine has no notify block (or named with --notify)
  const nOld = rawMachine(meta).notify, nr = o.notify !== undefined || (interactive && !nOld && o.askNotify !== false)   // A5: init asked it in setup already
    ? notifyChoice({ old: nOld, choice: o.notify, server: o['ntfy-server'], interactive, ask: o.ask, out }) : null;
  const home = machine.projects_home || fwd(path.join(machine.home, '.norn', 'projects'));
  const dir = path.resolve(o.dir || path.join(home, name)), file = path.join(dir, 'project.json');
  if (under(dir, meta) && !under(dir, path.join(meta, 'local'))) throw new SetupError(`${fwd(dir)} is inside the engine tree (${fwd(meta)}): a project lives outside it (projects_home ${home}, or --dir; ${fwd(meta)}/local/ is allowed)`);
  if (o.register !== false && rawMachine(meta).projects.some(x => x.name === name)) throw new SetupError(`a project named ${name} is already registered (norn project list)`);
  if (exists(file)) throw new SetupError(`${fwd(file)} exists: never overwritten`);
  fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  for (const n of ROLE_AGENTS) { const t = path.join(dir, 'agents', n + '.md'); if (!exists(t)) fs.copyFileSync(path.join(ENGINE, 'agents', n + '.md'), t); }
  fs.writeFileSync(file, JSON.stringify(draft, null, 1) + '\n', { flag: 'wx' });
  out(`wrote ${fwd(file)}${subdir ? ` (the folder ${subdir} of ${fwd(root)}: its own rules, roadmap, gate and lanes)` : ''}`);
  if (o.register !== false && projectAdd(file, { env, out, err })) return 1;
  out(`project ${name}: OK (${fwd(file)})`);
  if (nr) {
    if (nr.block && !nr.kept) {
      const errs = validate(MACHINE_SCHEMA.properties.notify, nr.block, '$.notify');
      if (errs.length) throw new ConfigError('machine.json: ' + errs.join('; '));
      updateMachine(machineFile(meta), () => ({ notify: nr.block })); out(`wrote ${fwd(machineFile(meta))} (notify)`);
    }
    notifyFinish(nr, { meta, env, interactive, ask: o.ask, out, noPing: !!o.noTestPing });
  }
  return 0;
}

// ---------- META-ONBOARD S4: `norn project list` / `norn project remove` (SPEC 3.4) ----------
function projectFacts(meta, machine, pr) {
  const file = expandNorn(pr.config, meta);
  let p = null;
  try { p = loadProject(file, { home: machine.home, meta }); } catch { /* reported as config error */ }
  const state = p?.state || fwd(path.join(meta, 'state', pr.name));
  let running = [];
  try { if (exists(state)) running = Object.values(loadState(state).items).filter(i => i.kind === 'run' && i.state === 'running').map(i => i.id); } catch { /* no records */ }
  return { name: pr.name, config: fwd(file), config_ok: !!p, root: p?.root ?? null, root_exists: !!(p?.root && exists(p.root)),
    managed: readManifest(meta).entries.filter(e => owners(e).includes(pr.name)).length, state, running };
}

export function projectList({ json = false, env = process.env, out }) {
  const meta = metaRoot(env);
  if (!exists(machineFile(meta))) throw new SetupError('no machine.json: run norn setup first');
  const machine = loadMachine(machineFile(meta), { meta });
  const rows = machine.projects.map(pr => projectFacts(meta, machine, pr));
  if (json) { out(JSON.stringify(rows, null, 1)); return 0; }
  if (!rows.length) { out('no projects registered'); return 0; }
  for (const r of rows) out(`${r.name} ${r.config}${r.config_ok ? '' : ' (UNREADABLE)'} root ${r.root_exists ? 'ok' : 'MISSING'} ${r.root ?? '-'} managed ${r.managed} state ${r.state} running ${r.running.length}${r.running.length ? ' ' + r.running.join(',') : ''}`);
  return 0;
}

/** o: { name, purgeState, dryRun, env, out, err, io (scheduler io, injectable) } -> exit code; throws SetupError 2 / 3 */
export function projectRemove({ name, purgeState = false, dryRun = false, env = process.env, out, io = schedIo }) {
  const meta = metaRoot(env);
  if (!exists(machineFile(meta))) throw new SetupError('no machine.json: run norn setup first');
  const machine = loadMachine(machineFile(meta), { meta });
  const pr = machine.projects.find(x => x.name === name);
  if (!pr) throw new SetupError(`no project named ${name} (norn project list)`);
  const f = projectFacts(meta, machine, pr);
  if (f.running.length) throw new SetupError(`${name} has running run(s): ${f.running.join(', ')} - stop them first (norn stop <RUN>); nothing changed`, 3);
  const W = dryRun ? 'would ' : '';
  if (dryRun) out(`dry run: nothing is changed`);
  // 2. installed files: unedited -> deleted; edited -> kept (now the user's); missing -> dropped; meta-made empty skill dirs removed
  const man = readManifest(meta), mine = man.entries.filter(e => owners(e).includes(name));
  const dirs = new Set(), shared = new Map();
  for (const e of mine) {
    // FOLLOWUP R1: a file another project still manages stays (that project drops out of its owners only)
    const others = owners(e).filter(x => x !== name);
    if (others.length) { out(`kept ${fwd(e.target)}: still used by ${others.join(', ')}`); shared.set(e, others); continue; }
    if (!exists(e.target)) { out(`${W}drop ${fwd(e.target)}: already gone`); continue; }
    if (sha(e.target) !== e.sha256) { out(`kept ${fwd(e.target)}: edited since install (now yours, not managed)`); continue; }
    out(`${W}delete ${fwd(e.target)}`);
    if (!dryRun) fs.rmSync(e.target, { force: true });
    dirs.add(path.dirname(e.target));
  }
  if (!dryRun) {
    // a dir is meta-made when it lies BELOW a `skills` dir (a skill's own folder and its sub-folders); the skills dir itself stays
    const belowSkills = d => { const parts = fwd(path.resolve(d)).split('/'); const i = parts.lastIndexOf('skills'); return i >= 0 && i < parts.length - 1; };
    for (let d of [...dirs].sort((a, b) => b.length - a.length)) {
      while (belowSkills(d) && exists(d) && !fs.readdirSync(d).length) { fs.rmdirSync(d); out(`removed empty dir ${fwd(d)}`); d = path.dirname(d); }
    }
    for (const [e, others] of shared) Object.assign(e, { project: others[others.length - 1], projects: others });
    man.entries = man.entries.filter(e => shared.has(e) || !owners(e).includes(name));
    writeJson(manifestFile(meta), man);
  }
  // 3. unregister
  out(`${W}unregister ${name} from ${fwd(machineFile(meta))}`);
  if (!dryRun) updateMachine(machineFile(meta), r => ({ projects: r.projects.filter(x => x.name !== name) }));
  // 4. the scheduler goes with the last project, and only when the OS says it is installed
  const left = machine.projects.filter(x => x.name !== name).length, sc = machine.scheduler;
  if (!left) {
    let a = null;
    try { a = schedAdapter(sc.kind); } catch (e) { out(`scheduler: ${e.message}`); }
    const o = { name: sc.name, interval_min: sc.interval_min, node: machine.node, meta: fwd(meta), home: machine.home };
    const ss = a ? schedState(a, o, io) : null;   // OOTB F-4: the task of ANOTHER install is never removed
    if (ss?.foreign) out(`scheduler ${sc.kind} '${sc.name}': belongs to the install at ${ss.owner} - kept`);
    else if (ss?.installed) { out(`${W}remove scheduler ${sc.kind} '${sc.name}'`); if (!dryRun) { a.remove(o, io); out(`scheduler ${sc.kind} '${sc.name}' removed (no project left)`); } }
    else if (a) out(`scheduler ${sc.kind} '${sc.name}': not installed`);
  } else out(`scheduler: kept (${left} project(s) left)`);
  // 5. state
  if (purgeState) { out(`${W}delete state ${f.state}`); if (!dryRun) fs.rmSync(f.state, { recursive: true, force: true }); }
  else out(`state kept: ${f.state} (--purge-state deletes it)`);
  out(`${dryRun ? 'dry run: ' : ''}project ${name}: ${dryRun ? 'would be removed' : 'removed'} (${f.config} itself is yours: kept)`);
  return 0;
}

export function readLineSync() {
  const buf = Buffer.alloc(1); let s = '';
  for (;;) { let n; try { n = fs.readSync(0, buf, 0, 1, null); } catch { return null; } if (!n) return s || null; const c = buf.toString(); if (c === '\n') return s.replace(/\r$/, ''); s += c; }
}

// META-NOTIFY-SETUP R1: "Get a ping when Norn needs you?" - setup / project new offer the machine.json `notify` block (notify.mjs).
// notifyChoice decides the block (before anything is written: a bad choice writes nothing); notifyFinish runs after the write:
// the subscribe link, a test ping through `norn notify` (a child: setup stays synchronous) and, interactive, "did it arrive?".
export const NOTIFY_CHOICES = ['ntfy', 'toast', 'desktop', 'pushover', 'none'];
export const NOTIFY_OFF = 'notifications: off - get a phone ping when Norn needs you: norn setup --notify ntfy (SETUP.md "Get a ping when Norn needs you")';
const RETEST = 'norn notify --title test --body hello';
export function notifyChoice({ old, choice, server, interactive = false, ask = readLineSync, out, platform = process.platform, rand }) {
  if (choice !== undefined && !NOTIFY_CHOICES.includes(choice)) throw new SetupError(`--notify must be ${NOTIFY_CHOICES.join('|')}`);
  if (server !== undefined && choice !== 'ntfy') throw new SetupError('--ntfy-server goes with --notify ntfy');
  if (choice === undefined) {
    if (old) return { block: old, kept: true };
    if (!interactive) return { block: undefined };
    out('Get a ping when Norn needs you? (a question for you, work finished, CI red on main)');
    out('  1) phone: the ntfy app - recommended (free, open source, no account; Norn makes a private topic)');
    out('  2) a desktop notification on this computer (nothing to install)');
    out('  3) phone: ntfy on your own server');
    out('  4) not now');
    out('choice [1]:');
    const a = (ask() ?? '').trim() || '1';
    if (a === '3') { out('ntfy server URL (https://...):'); server = (ask() ?? '').trim(); if (!server) throw new SetupError('no ntfy server given: nothing written'); }
    if (a === '4') return { block: undefined, notNow: true };
    choice = { 1: 'ntfy', 2: 'toast', 3: 'ntfy' }[a];
    if (!choice) throw new SetupError(`choice ${a}: answer 1-4 (nothing written)`);
  }
  if (choice === 'ntfy') {
    const srv = server ?? (old?.backend === 'ntfy' ? old.server : undefined);
    try { ntfyServer(srv); } catch (e) { throw new SetupError(e.message); }
    const same = old?.backend === 'ntfy' && old.topic && (old.server ?? '') === (srv ?? '');   // a re-run keeps the phone subscribed
    return { block: { backend: 'ntfy', topic: same ? old.topic : newTopic(rand), ...(srv ? { server: srv } : {}) } };
  }
  return { block: { backend: choice === 'toast' && platform !== 'win32' ? 'desktop' : choice } };
}
export function notifyFinish(r, { meta, env = process.env, interactive = false, ask = readLineSync, out, noPing = false }) {
  const b = r.block;
  if (r.kept) return out(`notifications: ${b.backend} (kept; change it: norn setup --notify ${NOTIFY_CHOICES.join('|')})`);
  if (!b) return out(r.notNow ? 'not now - ' + NOTIFY_OFF.replace(/^notifications: off - /, '') : NOTIFY_OFF);
  if (b.backend === 'none') return out('notifications: none (turn them on later: norn setup --notify ntfy)');
  if (b.backend === 'ntfy') {
    out(`notifications: ntfy - on your phone install the ntfy app (ntfy.sh: Play Store, App Store, F-Droid), tap + and subscribe to topic ${b.topic}${b.server ? ` on server ${b.server}` : ''}`);
    out(`  subscribe link (private - anyone with it can read your pings): ${subscribeLink(b)}`);
  } else if (b.backend === 'pushover') out('notifications: pushover - set the env vars PUSHOVER_TOKEN and PUSHOVER_USER (the keys are never stored in machine.json)');
  else out(`notifications: ${b.backend} - a desktop notification on this computer`);
  if (noPing) return out('test ping: skipped (--no-test-ping)');
  if (b.backend === 'pushover' && !(env.PUSHOVER_TOKEN && env.PUSHOVER_USER)) return out(`test ping: not sent (keys not set) - once set: ${RETEST}`);
  const p = spawnSync(process.execPath, [path.join(ENGINE, 'bin', 'norn.mjs'), 'notify', '--state', path.join(meta, 'local'), '--title', 'Norn test ping',
    '--body', 'Norn will ping you here when it needs you.'], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (p.status !== 0) return out(`test ping failed: ${String(p.stderr || p.error?.message || '').trim().split(/\r?\n/)[0]} - the setting is saved; retry: ${RETEST}`);
  out('test ping sent');
  if (!interactive) return;
  out('did it arrive? [Y/n]:');
  if (/^n/i.test((ask() ?? '').trim())) {
    out(b.backend === 'ntfy' ? `  check: the ntfy app is subscribed to the link above and may notify; then retry: ${RETEST}` : `  check: notifications for this app are allowed in the OS settings; then retry: ${RETEST}`);
    out('  the setting is saved; switch it: norn setup --notify <backend>');
  } else out('notifications: on');
}

/** OOTB F-4: { old (machine.json scheduler or null), meta, adapter, io, node, home } -> { name, notes }. The recorded name stays unless
 *  ANOTHER install owns its task (then this install's derived name); a fresh install derives its own. Read-only: it only asks the OS
 *  scheduler. */
export function schedChoice({ old, meta, adapter, io = schedIo, node, home }) {
  const own = schedName(meta), notes = [], o = name => ({ name, interval_min: 15, node, meta: fwd(meta), home });
  const theirs = n => { const s = schedState(adapter, o(n), io); if (s.foreign) notes.push(`scheduled task '${n}' belongs to the install at ${s.owner} - not this one (this install's task: '${own}')`); return s.foreign; };
  const name = old?.name && !theirs(old.name) ? old.name : own;
  return { name, notes };
}

export function setup({ force = false, nonInteractive = false, projects = [], askProjects = true, noScheduler = false, profile, cost, notify, ntfyServer: server, noTestPing = false, ask, env = process.env, out, err }) {
  const meta = metaRoot(env), home = os.homedir();
  const prof = choose({ profile, cost }), chosen = profile !== undefined || cost !== undefined;   // F-6: refused before anything is written
  const d = discover({ env, home });
  out(`node: ${d.node.exe} (${d.node.version})`);
  out(`git: ${d.git ? d.git.exe : 'NOT FOUND'}`);
  out(`claude: ${d.claude ? `${d.claude.exe} (${d.claude.version ?? 'version unknown'}), config ${d.claude.config_dir}` : 'NOT FOUND'}`);
  out(`codex: ${d.codex ? d.codex.exe : 'not found (optional, disabled)'}`);
  if (d.problems.length) { for (const x of d.problems) { err('error: ' + x.msg); err('  ' + hint(x.tool)); } err('setup: nothing written'); return 1; }
  // Norn's Rust parts (rustbin.mjs): norn-hook (every claude run's hooks) and norn-code (the code graph), each built here with --locked
  // when missing or stale; no build = no setup
  for (const p of Object.keys(RUST_PARTS)) {
    const b = ensurePart(p, { err });
    if (!b.ok) { err('error: ' + b.why); err('setup: nothing written'); return 1; }
    out(`${RUST_PARTS[p].bin}: ${fwd(binOf(p))}${b.built ? ' (built)' : ''}`);
  }

  // issue #104: the stored file as it is, valid or not (a key the schema does not know must not reset projects, dash, notify)
  let old = null; try { if (exists(machineFile(meta))) old = JSON.parse(fs.readFileSync(machineFile(meta), 'utf8').replace(/^\uFEFF/, '')); } catch { /* unreadable: the write below refuses */ }
  // META-NOTIFY-SETUP R1: decided before anything is written (a bad --notify writes nothing); no flag keeps an existing block as is
  const interactive = !nonInteractive && (!!process.stdin.isTTY || env.META_INTERACTIVE === '1');
  const nr = notifyChoice({ old: old?.notify, choice: notify, server, interactive, ask, out });
  // OOTB F-4: the task name of THIS install (a recorded name stays unless another install owns its task); --no-scheduler asks no OS
  let sc = { name: liveName(old?.scheduler?.name, meta), notes: [] };
  if (!noScheduler) {
    try { sc = schedChoice({ old: old?.scheduler, meta, adapter: schedAdapter(d.scheduler.kind), node: d.node.exe, home: fwd(home) }); }
    catch (e) { sc.notes.push(`scheduler: ${e.message}`); }
  }
  const m = {
    schema: 1, home: fwd(home), claude: d.claude, git: d.git, codex: d.codex, node: d.node.exe,
    scheduler: { ...d.scheduler, name: sc.name, interval_min: old?.scheduler?.interval_min ?? (chosen ? prof.scheduler.interval_min : d.scheduler.interval_min) },
    dash: old?.dash ?? { port: 8737, bind: '127.0.0.1' }, projects_home: old?.projects_home ?? '${home}/.norn/projects', projects: old?.projects ?? [],
    ...(nr.block ? { notify: nr.block } : {}),   // H4: the owner's opt-in backend survives a re-setup (nr.kept)
  };
  const errs = validate(MACHINE_SCHEMA, m);
  if (errs.length) throw new ConfigError('machine.json: ' + errs.join('; '));
  // issue #104: setup writes only the keys of m; every other key (ledger, usage, fed, unknown) is kept by updateMachine, and so is an unknown
  // key nested in a block setup owns (discovered values win). Dropped on purpose: codex when not found (null), notify when turned off / not
  // now (nr.block undefined), and a notify block replaced whole (an old topic never leaks into a new backend).
  const nested = (o, n) => (o && n && typeof o === 'object' && typeof n === 'object' && !Array.isArray(n) ? { ...o, ...n } : n);
  const own = raw => ({ ...m, ...Object.fromEntries(['claude', 'git', 'codex', 'scheduler', 'dash'].map(k => [k, nested(raw[k], m[k])])), notify: nr.block });
  // META-ONBOARD S1: the write is verified by reading it back from the path reported; anything else is a loud failure, never a 0
  const mf = machineFile(meta);
  try { const w = updateMachine(mf, own); if (JSON.stringify(JSON.parse(fs.readFileSync(mf, 'utf8'))) !== JSON.stringify(w)) throw new Error('read back differs'); }
  catch (e) { err(`error: could not write ${fwd(mf)}: ${e.code || e.message}`); err('setup: machine.json not written'); return 1; }
  out(`wrote ${fwd(mf)}`);
  notifyFinish(nr, { meta, env, interactive, ask, out, noPing: noTestPing });
  // META-OOTB F-3 / F-6: caps before the scheduler - a machine with no budget gets the profile's caps (default try-it); an existing
  // budget.json is touched only when the human names --profile / --cost (the profile keys merged in, a .pre-profile backup kept)
  const bf = path.join(meta, 'local', 'budget.json'), { cur, next } = profileCaps(meta, prof, cost), named = `profile ${prof.name}, cost ${cost ?? 'balanced'}`;
  let applied = true;
  if (!exists(bf)) {
    fs.writeFileSync(bf, JSON.stringify(next, null, 2) + '\n', { flag: 'wx' });
    out(`wrote ${fwd(bf)} (starter caps: ${next.max_claude_workers} Claude worker, ${next.max_codex} Codex, weekly stop ${next.weekly_stop_pct} %, rate cap ${next.usage_rate_cap_pct_per_h} %/h; ${named} - change them in the dashboard Settings)`);
  } else if (!chosen) { out(`${fwd(bf)}: kept (existing caps)`); applied = false; }
  else {
    const diff = Object.keys(next).filter(k => JSON.stringify(cur[k]) !== JSON.stringify(next[k]));
    if (!diff.length) out(`${fwd(bf)}: kept (already ${named})`);
    else {
      fs.copyFileSync(bf, bf + '.pre-profile');
      fs.writeFileSync(bf, JSON.stringify(next, null, 2) + '\n');
      out(`wrote ${fwd(bf)} (${named}; backup ${fwd(bf)}.pre-profile):`);
      for (const k of diff) out(`  ${k} ${cur[k] === undefined ? 'unset' : JSON.stringify(cur[k])} -> ${JSON.stringify(next[k])}`);
    }
  }
  if (applied) out(prof.scheduler.on ? `profile ${prof.name}: check-ins every ${prof.scheduler.interval_min} min - install the scheduler with: norn sched install`
    : `profile ${prof.name}: no scheduled check-ins - run \`norn tick\` by hand (norn sched install later runs them unattended)`);

  if (!nonInteractive && askProjects && process.stdin.isTTY) {   // META-ADOPT A5: init adds its repo itself
    for (;;) { out('project.json to add (blank = done):'); const l = readLineSync(); if (!l || !l.trim()) break; projects.push(l.trim()); }
  }
  let rc = 0;
  const added = new Set();
  for (const f of projects) {
    try { if (projectAdd(f, { env, out, err })) rc = 1; added.add(key(f)); } catch (e) { err('error: ' + e.message); rc = Math.max(rc, e.code || 1); }
  }
  // re-install the projects registered before (idempotent; picks up changed sources)
  for (const pr of m.projects) {
    const f = expandNorn(pr.config, meta);
    if (added.has(key(f))) continue;
    try { if (installProject(loadProject(f, { home: m.home, meta }), m, { meta, out }).map(x => err('error: ' + x)).length) rc = 1; }
    catch (e) { err(`error: ${pr.name}: ${e.message}`); rc = 1; }
  }
  installShim({ home, env, force, out });
  for (const n of sc.notes) out('note: ' + n);
  out(noScheduler ? 'scheduler: skipped (--no-scheduler)' : `scheduler: ${m.scheduler.kind} '${m.scheduler.name}' every ${m.scheduler.interval_min} min - install it with: norn sched install`);
  return rc;
}

// proc-hygiene (8): an installed Windows task still on the PowerShell action opens an empty Terminal window for every tick (and
// closing it kills the tick) - a warning with the one command that rewrites it to the hidden wscript action
export function windowedSchedLines({ machine, meta, io = schedIo }) {
  let a; try { a = schedAdapter(machine.scheduler.kind); } catch { return []; }
  if (!a.windowed) return [];
  const sc = machine.scheduler, o = { name: sc.name, interval_min: sc.interval_min, node: machine.node, meta: fwd(meta), home: machine.home };
  return a.windowed(o, io) ? [`scheduler: task '${sc.name}' still starts the tick through powershell.exe, which opens an empty Terminal window each tick - run: norn sched install`] : [];
}

export function doctor({ env = process.env, out }) {
  const meta = metaRoot(env), problems = [];
  const bad = s => { problems.push(s); out('PROBLEM ' + s); };
  if (!exists(machineFile(meta))) { out('no machine.json: run norn setup'); return 1; }
  let m;
  try { m = loadMachine(machineFile(meta), { meta }); } catch (e) { bad(e.message); out(`doctor: ${problems.length} problem(s)`); return 1; }
  // META-ONBOARD S2: a missing required tool = PROBLEM + this OS's install line; a missing optional one = a note (never a non-zero exit)
  if (!nodeOk(process.versions.node)) { bad(`node ${process.versions.node} < 22 (required)`); out('  ' + hint('node')); }
  for (const [k, exe] of [['node', m.node], ['git', m.git?.exe], ['claude', m.claude.exe], ['codex', m.codex?.exe]]) {
    if (!exe) continue;
    if (exists(exe)) out(`ok ${k} ${exe}`); else { bad(`${k}: ${exe} does not exist (rerun norn setup)`); if (PREREQS[k]?.required) out('  ' + hint(k)); }
  }
  if (!m.codex?.exe) out(`note codex not found (optional) - ${hint('codex')}`);
  for (const p of Object.keys(RUST_PARTS)) {   // every claude run's hooks and the code graph are these binaries
    const pp = partProblem(p);
    if (pp) { bad(pp); out(`  build: ${buildOf(p)} (norn setup does it)`); } else out(`ok ${RUST_PARTS[p].bin} ${fwd(binOf(p))}`);
  }
  if (!which('gh', { env })) out(`note gh not found (optional) - ${hint('gh')}`);
  // META-NOTIFY-SETUP R1: notifications off = a hint, never a problem; on = the backend (+ the ntfy server; the topic is never shown)
  const nb = m.notify;
  if (!nb || nb.backend === 'none') out('note ' + NOTIFY_OFF);
  else if (nb.backend === 'ntfy') {
    let srv = null; try { srv = ntfyServer(nb.server).replace(/\/$/, ''); } catch (e) { bad(`notify: ${e.message}`); }
    if (srv) { if (nb.topic) out(`ok notifications: ntfy (${srv}, topic set)`); else bad('notify: ntfy needs a topic (norn setup --notify ntfy makes one)'); }
  } else out(`ok notifications: ${nb.backend}`);
  // META-CONTROLLER C6: remote access off = a note; on = what answers (trust, hosts, logins, paired devices) + tailscale found (never serve)
  for (const [k, t] of remoteDoctor({ machine: m, meta, env })) { if (k === 'PROBLEM') bad(t); else out(`${k} ${t}`); }
  // the command the supervisor really spawns for Codex (npm .cmd shim -> node + JS entry, S10) + a --version through it
  if (m.codex?.exe && exists(m.codex.exe)) {
    try {
      const sp = resolveShim(m.codex.exe, ['--version']);
      const r = spawnSync(sp.exe, sp.args, { encoding: 'utf8', timeout: 30000, windowsHide: true });
      const cmd = [sp.exe, ...sp.args.slice(0, -1)].map(fwd).join(' ');
      if (r.status === 0) out(`ok codex command ${cmd} (${(r.stdout || '').trim().split(/\r?\n/)[0]})`);
      else bad(`codex: ${cmd} --version failed (exit ${r.status}${r.error ? ' ' + r.error.message : ''})`);
    } catch (e) { bad(`codex: ${e.message}`); }
  }
  // OOTB F-14: one cheap auth probe of the found claude (`claude auth status --json`, local, no turn): logged in or not + the method
  // only - never the account fields; no answer (an old claude, offline, a hang) = a note, never a problem
  if (m.claude?.exe && exists(m.claude.exe)) {
    let a = null, why = null;
    try {
      const sp = resolveShim(m.claude.exe, ['auth', 'status', '--json']);
      const r = spawnSync(sp.exe, sp.args, { encoding: 'utf8', timeout: 20000, windowsHide: true, env });
      try { a = JSON.parse(r.stdout || ''); } catch { why = r.error ? r.error.code || r.error.message : `exit ${r.status}, no status answer`; }
    } catch (e) { why = e.message; }
    if (a?.loggedIn === true) out(`ok claude auth: logged in (${String(a.authMethod || 'unknown method').replace(/[^\w .-]/g, '')})`);
    else if (a?.loggedIn === false) bad('claude: not logged in - run: claude auth login');
    else out(`note claude auth: not checked (${why || 'no status answer'})`);
  }
  const states = [];
  for (const pr of m.projects) {
    let p;
    try { p = loadProject(pr.config, { home: m.home, meta }); } catch (e) { bad(`${pr.name}: ${e.message}`); continue; }
    if (p.state) states.push(p.state);
    const need = [['root', p.root], ...(p.rules_read_whole || []).map(r => ['rules_read_whole', r]), ['checkin_extra', p.checkin_extra],
      ['install.agents', p.install?.agents], ['install.skills', p.install?.skills]].filter(([, v]) => v);
    let okp = true;
    for (const [k, v] of need) if (!exists(v)) { bad(`${p.name}: ${k} ${v} does not exist`); okp = false; }
    if (okp) out(`ok project ${p.name} (${pr.config})`);
    // configured typed executors: a cli entry's exe (from the data); an API entry's endpoint, model and whether its key env var
    // is set (never its value)
    for (const [n, x] of Object.entries(providersOf(p))) {
      if (isCli(x)) {
        const line = `${p.name}: executor ${n} (cli ${x.exe} model ${x.model}${x.enabled === false ? ', disabled' : ''})`;
        if (x.enabled !== false && !exists(x.exe)) bad(`${line}: exe does not exist`); else out('ok ' + line);
        continue;
      }
      const line = `${p.name}: executor ${n} (${x.type} ${x.base_url} model ${x.model}${x.enabled === false ? ', disabled' : ''}) key env ${x.api_key_env} ${keySet(x, env) ? 'set' : 'NOT set'}`;
      if (x.enabled !== false && !keySet(x, env)) bad(line); else out('ok ' + line);
    }
    // META-STANDING-CONTEXT R1: what a lean launch profile drops that a role's agent files / rules / briefs name (a warning: opt-in)
    for (const l of profileDoctorLines(p, { home: m.home, claudeDir: m.claude?.config_dir })) out('warn launch profile: ' + l);
    for (const l of checkinDoctorLines(p)) out(`${l.level} ${l.text}`);   // META-CHECKIN-DIET R1
  }
  // NORN-WATCH S5: what ended runs left running (a warning, not a problem: it names them, the owner / Norn stops them)
  const procs = listProcs();
  const facts = states.length ? runFacts(states) : { live: new Set(), ended: [] };
  if (states.length) for (const s of strays(procs, facts)) out('warn ' + strayLine(s));
  for (const d of derelicts(procs, facts)) out('warn ' + derelictLine(d));   // proc-hygiene (5): watchers, git, scans, hooks left behind
  if (m.scheduler?.name) for (const l of windowedSchedLines({ machine: m, meta })) out('warn ' + l);
  // META-AUTH-VENDOR: an open auth episode (per state home): a login one is a problem (log in), a vendor one a note (no login needed)
  for (const s of [...new Map(states.map(x => [path.dirname(path.resolve(x)), x])).values()])
    for (const l of authDoctorLines(s)) (l.level === 'bad' ? bad : x => out(`note ${x}`))(l.text);
  // META-LIMIT-GATE: an executor family out of quota (a note: it opens by itself at the reset; norn run refuses it until then)
  for (const s of states) for (const l of limitLines(s)) out(`note ${path.basename(path.resolve(s))}: ${l}`);
  // META-DASH-LIVE: the live dashboard on its configured port / not running / another port + stray `norn dash` processes
  for (const r of dashRows({ rec: readDash(meta), port: m.dash?.port ?? 8737, procs })) out(r);
  for (const e of readManifest(meta).entries) {
    const src = expandNorn(e.source, meta);
    if (!exists(e.target)) { bad(`${e.target}: missing (installed from ${e.source}; run norn project add)`); continue; }
    if (sha(e.target) !== e.sha256) { bad(`${e.target}: drift (edited after install)`); continue; }
    if (!exists(src)) bad(`${e.target}: source ${e.source} is gone`);
    else if (sha(src) !== (e.source_sha256 ?? e.sha256)) bad(`${e.target}: stale (source changed since install; run norn project add)`);
  }
  out(problems.length ? `doctor: ${problems.length} problem(s)` : 'doctor: ok');
  return problems.length ? 1 : 0;
}

// the git checkout an install root is: a linked worktree has a .git FILE ("gitdir: <main>/.git/worktrees/<name>"); its main checkout
// is the dir above that .git. A main checkout, a plain clone or a copy without .git is its own main.
export function checkoutOf(root) {
  let g = null;
  try { const p = path.join(root, '.git'); if (fs.statSync(p).isFile()) g = fs.readFileSync(p, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1]; } catch { /* no .git */ }
  const wt = g && path.resolve(root, g);
  if (!wt || path.basename(path.dirname(wt)) !== 'worktrees') return { root, main: root, worktree: false };
  return { root, main: path.resolve(wt, '..', '..', '..'), worktree: true };
}

// `norn` on PATH (design 3.5): launchers in ~/.local/bin (the pipx / uv tool convention) that run THIS engine's norn.mjs with this
// node: `norn` (+ `norn.cmd` on Windows). Written when absent or already ours (it names engine/bin/norn.mjs); a foreign file is kept. Warns when the dir is not on PATH.
// META-RENAME R1: never pointed at a linked git worktree (a worker's checkout: it goes away, and its code is not the owner's) unless
// force - the line names the main checkout to run setup from.
export function installShim({ home, root = path.resolve(ENGINE, '..'), force = false, node = process.execPath, env = process.env, platform = process.platform, out }) {
  const bin = path.join(home, '.local', 'bin'), cli = path.join(root, 'engine', 'bin', 'norn.mjs'), here = checkoutOf(root);
  if (here.worktree && !force) {
    out(`norn launcher: not written - ${fwd(root)} is a linked git worktree; its main checkout is ${fwd(here.main)} (run setup there, or --force to point ${fwd(bin)}/norn at this worktree)`);
    return;
  }
  const files = { norn: `#!/bin/sh\nexec "${fwd(node)}" "${fwd(cli)}" "$@"\n` };
  if (platform === 'win32') files['norn.cmd'] = `@"${node}" "${cli}" %*\r\n`;
  fs.mkdirSync(bin, { recursive: true });
  for (const [n, text] of Object.entries(files)) {
    const f = path.join(bin, n);
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    if (cur !== null && !/engine[\\/]bin[\\/]norn\.mjs/.test(cur)) { out(`note: ${fwd(f)} exists and is not a Norn launcher - kept`); continue; }
    // OOTB F-4: the launcher of ANOTHER install (its entry still exists) is kept and named - never silently taken over; one of THIS
    // repo (the same main checkout, a worker worktree's) is ours
    const theirs = cur?.match(/"([^"]*engine[\\/]bin[\\/]norn\.mjs)"/)?.[1], troot = theirs && path.resolve(theirs, '..', '..', '..');
    if (theirs && fs.existsSync(theirs) && normDir(checkoutOf(troot).main) !== normDir(here.main)) { out(`note: ${fwd(f)} runs the install at ${fwd(troot)} - kept (this install: node ${fwd(cli)})`); continue; }
    if (cur !== text) fs.writeFileSync(f, text, { mode: 0o755 });
    // writeFileSync sets the mode only when it CREATES the file: an existing launcher keeps its old bits, so a 0644 launcher
    // rewritten here stayed unrunnable (CI 43556561887 Linux: spawn EACCES). Every launcher this install owns is made executable.
    if (platform !== 'win32') fs.chmodSync(f, 0o755);
  }
  const sep = platform === 'win32' ? ';' : ':', norm = p => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '');
  const on = (env.PATH || env.Path || '').split(sep).filter(Boolean).some(p => norm(p) === norm(bin));
  // the stop-gap in the user's own shell: PowerShell's Set-Alias cannot carry arguments, so Windows gets a function
  const stopgap = platform === 'win32' ? `in PowerShell: function norn { node "${fwd(cli)}" @args }` : `alias norn='node ${fwd(cli)}'`;
  out(`norn launcher: ${fwd(bin)}/norn${on ? '' : ` - ${fwd(bin)} is not on PATH: add it (or ${stopgap})`}`);
}

// `norn gen [--check] [--project <project.json>]` (H3): regenerate (or, with --check, only drift-check) every harness target of the
// registered projects (or the one named). A hand edit is reported as drift and never overwritten.
export function gen({ check = false, project = null, env = process.env, out, err }) {
  const meta = metaRoot(env);
  if (!exists(machineFile(meta))) throw new SetupError('no machine.json: run norn setup first');
  const m = loadMachine(machineFile(meta), { meta });
  const files = project ? [project] : m.projects.map(pr => expandNorn(pr.config, meta));
  let n = 0;
  for (const f of files) {
    let p;
    try { p = loadProject(f, { home: m.home, meta }); } catch (e) { err('error: ' + e.message); n++; continue; }
    const probs = check ? genCheck(p, m, { meta, out }) : installProject(p, m, { meta, out });
    for (const x of probs) (check ? out('PROBLEM ' + x) : err('error: ' + x));
    n += probs.length;
  }
  if (check) out(n ? `gen --check: ${n} problem(s)` : 'gen --check: ok');
  return n ? 1 : 0;
}
