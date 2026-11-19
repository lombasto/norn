// META-ADOPT A1 (meta-adopt SPEC sec. 2-6): starting a project, or adopting an existing repo.
//   scan(root)              -> FACTS: what the engine knows about a repo for free (git + tracked files only, read-only, no model)
//   importPlan(text, o)     -> a `norn road apply` plan from a hand-kept planning file (the ONE importer: roadmap S4a; adopt and S4b share it)
// Only tracked files are read (git ls-tree / git show <branch>:path): an untracked or ignored file (.env, node_modules) is never opened.
// The engine names no project: every project fact comes from the repo or project.json.
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, readEvents, recordsFile, fold, loadState, withLock, withLockAsync, idPrefix } from './records.mjs';
import { loadRoadmap, world, goneLinks, planEvents, checkLinks, buildTree, writeRoadmapView, writeRoadmapViewAsync, roadmapViewPath } from './roadmap.mjs';
import { laneSteps, LANE_IO } from './lanenew.mjs';
import { runSteps, runStepsAsync } from './steps.mjs';
import { writeBudget, writeBudgetAsync, withDefaults } from './policy.mjs';
import { startRun } from './runs.mjs';
import { normSubdir, subdirOf } from './monorepo.mjs';
import { floorOf } from './floor.mjs';
import { lineAt } from './slop/scan.mjs';

export class AdoptError extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }
// META-DASH-ASYNC R1 (option a): the review's writes (decide / close / rule / apply) are yielded effects (lib/steps.mjs): the CLI and the
// MCP run them on the sync io, the dash server on fs.promises (+ the lane's git as an async child). Their reads stay sync (named).
const SYNC_IO = { ...LANE_IO.sync, write: (f, t) => fs.writeFileSync(f, t), roadmapView: (s, tree, f) => writeRoadmapView(s, tree, f), budget: writeBudget };
const ASYNC_IO = { ...LANE_IO.async, write: (f, t) => fs.promises.writeFile(f, t), roadmapView: (s, tree, f) => writeRoadmapViewAsync(s, tree, f), budget: writeBudgetAsync };

const fwd = p => String(p).replace(/\\/g, '/');
const sh = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout.replace(/\r\n/g, '\n').trimEnd() : null;
};
export const slugOf = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.windsurfrules', '.clinerules', '.github/copilot-instructions.md', 'CONVENTIONS.md'];
const PLAN_RE = /^(?:docs\/)?(?:ROADMAP|TODO|BACKLOG|PLAN|MILESTONES)[^/]*\.(?:md|txt)$|^TODO$/i;
const MANIFEST_RE = /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/;
const CI_FILES = [[/^\.github\/workflows\/[^/]+\.ya?ml$/, 'github-actions'], [/^\.gitlab-ci\.yml$/, 'gitlab-ci'], [/^\.circleci\/config\.yml$/, 'circleci'],
  [/^azure-pipelines\.yml$/, 'azure'], [/^Jenkinsfile$/, 'jenkins']];

/** candidate commands from the ROOT manifests, each with the line that backs it (a sub-folder manifest is named in facts.manifests, never guessed from) */
function commandsOf(files, read) {
  const out = [], has = f => files.includes(f), add = (id, cmd, source) => { if (!out.some(c => c.id === id)) out.push({ id, cmd, source }); };
  if (has('package.json')) {
    let pj = {};
    try { pj = JSON.parse(read('package.json')); } catch { /* an unreadable manifest gives no command */ }
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    for (const k of ['test', 'lint', 'typecheck', 'build'])
      if (pj.scripts?.[k] && !/no test specified/.test(pj.scripts[k])) add(k, k === 'test' ? `${pm} test` : `${pm} run ${k}`, `package.json scripts.${k} ("${pj.scripts[k]}")`);
  }
  if (has('Cargo.toml')) { add('test', 'cargo test', 'Cargo.toml'); add('lint', 'cargo clippy --all-targets -- -D warnings', 'Cargo.toml (the cargo convention)'); }
  if (has('go.mod')) { add('test', 'go test ./...', 'go.mod'); add('lint', 'go vet ./...', 'go.mod (the go convention)'); }
  if (has('pyproject.toml')) {
    const t = read('pyproject.toml') || '', run = has('uv.lock') ? 'uv run ' : has('poetry.lock') ? 'poetry run ' : '';
    const pt = /\[tool\.pytest/.test(t);
    if (pt || files.some(f => /^tests?\/.*\.py$/.test(f))) add('test', `${run}pytest`, 'pyproject.toml' + (pt ? ' [tool.pytest]' : ' + tests/'));
    if (/\[tool\.ruff/.test(t)) add('lint', `${run}ruff check .`, 'pyproject.toml [tool.ruff]');
  }
  for (const mk of ['Makefile', 'justfile']) if (has(mk)) {
    const text = read(mk) || '';
    for (const m of text.matchAll(/^(test|lint|check|build):/gm)) add(m[1] === 'check' ? 'test' : m[1], `${mk === 'Makefile' ? 'make' : 'just'} ${m[1]}`, `${mk}:${lineAt(text, m.index)} (target ${m[1]})`);
  }
  return out;
}

/**
 * FACTS about a repo (read-only; writes nothing anywhere). o.now = the clock for branch ages; o.forge = parsed forge answers (A6).
 * o.subdir = a monorepo project's folder (project.subdir): only the files, commits and TODO markers under it count, matched as if it
 * were the top level (its README, CLAUDE.md, manifests); every path FACTS names stays repo-relative (<subdir>/...).
 */
export function scan(root, o = {}) {
  const t0 = Date.now();
  root = path.resolve(root);
  if (sh(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') throw new AdoptError(`${fwd(root)} is not a git repo`);
  let sub;
  try { sub = normSubdir(o.subdir); } catch (e) { throw new AdoptError(e.message); }
  const pre = sub ? sub + '/' : '', only = sub ? ['--', sub] : [];
  const head = sh(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '') || sh(root, ['symbolic-ref', '--short', 'HEAD']) || 'main';
  const files = (sh(root, ['ls-tree', '-r', '--name-only', head, ...only]) || '').split('\n').filter(Boolean)
    .filter(f => f.startsWith(pre)).map(f => f.slice(pre.length));
  if (sub && !files.length) throw new AdoptError(`subdir ${sub}: no tracked file under it on ${head}`);
  const read = f => sh(root, ['show', `${head}:${pre}${f}`]);
  const ext = {};
  for (const f of files) { const e = path.extname(f).toLowerCase() || '(none)'; ext[e] = (ext[e] || 0) + 1; }
  const origin = sh(root, ['remote', 'get-url', 'origin']);
  const gh = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(origin || '');
  const commits = Number(sh(root, ['rev-list', '--count', head, ...only]) || 0);
  const dates = (sh(root, ['log', '--format=%cI', head, ...only]) || '').split('\n').filter(Boolean);
  const authors = new Set((sh(root, ['log', '--format=%ae', head, ...only]) || '').split('\n').filter(Boolean)).size;
  // one spawn for every branch: %(ahead-behind:<base>) (git >= 2.41); an older git answers nothing and each branch costs one rev-list
  const SEP = '\t', branches = [], fmt = ['%(refname:short)', '%(committerdate:iso-strict)', '%(refname)'];
  const hasHead = sub ? sh(root, ['rev-parse', '--verify', '--quiet', head]) !== null : commits > 0;
  const refs = (hasHead ? sh(root, ['for-each-ref', '--format=' + [...fmt, '%(ahead-behind:' + head + ')'].join(SEP), 'refs/heads', 'refs/remotes']) : null)
    ?? sh(root, ['for-each-ref', '--format=' + fmt.join(SEP), 'refs/heads', 'refs/remotes']) ?? '';
  for (const l of refs.split('\n').filter(Boolean)) {
    const [name, date, ref, ab] = l.split(SEP);
    if (/^refs\/remotes\/[^/]+\/HEAD$/.test(ref)) continue;   // a clone's origin/HEAD names the default branch, it is no branch (its short name is "origin")
    const short = ref.startsWith('refs/remotes/') ? name.replace(/^[^/]+\//, '') : name;
    if (short === head || short === 'HEAD' || !short || branches.some(b => b.name === short)) continue;
    const [ahead, behind] = ab ? ab.split(' ').map(Number) : (sh(root, ['rev-list', '--left-right', '--count', ref + '...' + head]) || '0 0').split(/\s+/).map(Number);
    branches.push({ name: short, last: date, ahead, behind, merged: ahead === 0, days: Math.round((Date.parse(o.now || new Date()) - Date.parse(date)) / 864e5) });
  }
  const ci = [];
  for (const f of files) for (const [re, kind] of CI_FILES) if (re.test(f)) {
    const text = (read(f) || '').replace(/\r\n/g, '\n');
    ci.push({ file: f, kind, runs: [...text.matchAll(/^[ \t]*-?[ \t]*run:[ \t]*(.+)$/gm)].map(m => ({ cmd: m[1].trim(), line: lineAt(text, m.index) })) });
  }
  const ciRuns = ci.flatMap(x => x.runs.map(r => ({ ...r, file: x.file })));
  const commands = commandsOf(files, read);
  if (!commands.some(c => c.id === 'test')) {
    const r = ciRuns.find(x => /(test|pytest|ctest)/.test(x.cmd) && !/install|setup/.test(x.cmd));
    if (r) commands.push({ id: 'test', cmd: r.cmd, source: `${r.file}:${r.line} (a CI step; no manifest names a test command)` });
  }
  for (const c of commands) { const hit = ciRuns.find(r => r.cmd === c.cmd); if (hit) c.ci = `${hit.file}:${hit.line}`; }
  const agent_files = AGENT_FILES.filter(f => files.includes(f)).concat(files.filter(f => /^\.cursor\/rules\//.test(f)))
    .map(f => ({ file: f, lines: (read(f) || '').split('\n').length }));
  const design = files.filter(f => /^docs?\/.*\.md$/i.test(f));
  // each planning file through the ONE importer, its links checked against what exists (branch names, tracked docs)
  const docFiles = files.filter(f => /.md$/i.test(f)), names = branches.map(b => b.name);
  const imported = files.filter(f => PLAN_RE.test(f)).map(f => ({ file: f, ...importPlan(read(f) || '', { file: f, branches: names, docs: docFiles }) }));
  const plans = imported.map(p => ({ file: p.file, items: p.count, themes: p.themes.length }));
  const todo = (hasHead ? sh(root, ['grep', '-c', '-I', '-E', 'TODO|FIXME', head, '--', sub || '.', ':!*.md']) || '' : '').split('\n').filter(Boolean)
    .reduce((s, l) => s + Number(l.split(':').pop()), 0);
  const forge = gh ? { kind: 'github', repo: `${gh[1]}/${gh[2]}`, ...(o.forge ? { linked: true, issues: o.forge.issues || [], prs: o.forge.prs || [] } : { linked: false }) } : null;
  const tests = files.filter(f => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$/.test(f)).length;
  const planItems = plans.reduce((s, p) => s + p.items, 0), issues = forge?.issues?.length || 0, live = branches.filter(b => !b.merged).length;
  // NEW = nothing to read yet: the interview fills the draft. ADOPT = the repo answers most of it (SPEC sec. 2)
  const young = commits < 20 && planItems === 0 && issues === 0 && live === 0;
  // a subdir scan matched paths as if the folder were the top level: FACTS names them repo-relative again (a source "file:line" too)
  const P = f => (f && pre ? pre + f : f), Psrc = s => (pre && s ? pre + s : s);
  const docs = { readme: files.find(f => /^README(\.md|\.rst|\.txt)?$/i.test(f)) || null, contributing: files.find(f => /^(\.github\/)?CONTRIBUTING\.md$/i.test(f)) || null,
    changelog: files.find(f => /^(CHANGELOG|CHANGES|HISTORY)(\.md)?$/i.test(f)) || null, license: files.find(f => /^LICEN[SC]E/i.test(f)) || null, design };
  return { schema: 1, root: fwd(root), ...(sub ? { subdir: sub } : {}), name: slugOf(path.basename(sub || root)), default_branch: head, origin, forge,
    history: { commits, first: dates.at(-1) || null, last: dates[0] || null, authors, tags: (sh(root, ['tag']) || '').split('\n').filter(Boolean).length },
    size: { files: files.length, by_ext: Object.fromEntries(Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 8)), tests, todo_markers: todo },
    docs: pre ? { readme: P(docs.readme), contributing: P(docs.contributing), changelog: P(docs.changelog), license: P(docs.license), design: design.map(P) } : docs,
    manifests: files.filter(f => MANIFEST_RE.test(f)).sort().map(P),
    agent_files: agent_files.map(a => ({ ...a, file: P(a.file) })), plans: plans.map(p => ({ ...p, file: P(p.file) })),
    imported: imported.map(({ file, themes }) => ({ file: P(file), themes })),
    commands: commands.map(c => ({ ...c, source: Psrc(c.source), ...(c.ci ? { ci: Psrc(c.ci) } : {}) })),
    ci: ci.map(c => ({ ...c, file: P(c.file) })), branches,
    path: young ? 'new' : 'adopt',
    path_why: young ? `${commits} commit(s), no planning file, no open issue, no branch in flight`
      : `${commits} commits, ${planItems} planning item(s) in ${plans.length} file(s), ${issues} open issue(s), ${live} branch(es) in flight`,
    scan_ms: Date.now() - t0 };
}

// ---------- the ONE importer (roadmap S4a) ----------
const HORIZON = [[/^(now|current|in progress|doing|this (week|month|quarter))\b/i, 'now'], [/^(next|soon|up next|planned)\b/i, 'next'],
  [/^(later|future|someday|ideas?|backlog|maybe)\b/i, 'later']];
const DONE_HEAD = /^(done|shipped|released|completed|changelog)\b/i;
// the typed status words a hand-kept file uses (longest first); each is kept as legacy.word = a CLAIM, never a status
const WORDS = ['MERGED DEFAULT OFF', 'BUILT NOT WIRED', 'IN PROGRESS', 'REQUESTED', 'SHIPPED', 'BUILDING', 'PLANNED', 'BLOCKED', 'DROPPED', "SPEC'D",
  'DONE', 'IDEA', 'TODO', 'WIP'];
const WORD_RE = new RegExp(`^\\[?\\s*(${WORDS.map(w => w.replace(/'/g, "['’]")).join('|')})(?![A-Za-z])\\s*\\]?`, 'i');
const wordOf = s => { const m = WORD_RE.exec(s.trim()); return m ? { word: m[1].toUpperCase().replace('’', "'"), rest: s.trim().slice(m[0].length).replace(/^[\s:;,/-]+/, '').trim() } : null; };
const PAST = ['DONE', 'SHIPPED', 'DROPPED'];   // a claim of the past carries no horizon
const unnumber = t => t.replace(/^(?:sec(?:tion)?\.?\s*)?\d+[a-z]?[.)]?\s+/i, '');

/**
 * A hand-kept planning file -> { themes: [{ title, items: [node] }], count } in the `norn road apply` plan shape.
 * Shapes read: "## heading" sections; "- [x] / - [ ] text" check lists; "- [STATUS] text" and "- text" bullets; markdown table rows with a
 * cell that starts with a status word. A heading naming a horizon (Now / Next / Later, numbered or not) sets `horizon` and is no theme;
 * a Done heading or a ticked box is the claim DONE. Each item keeps legacy { word, text, line, file } and the links found in its line:
 * o.branches (exact names) and o.docs (tracked paths). A trailing "(branch ..)" / "(docs/..)" / "(#n)" is cut from the title; #n goes in the note.
 */
export function importPlan(text, o = {}) {
  if (o.legacy) return catalogueOf(text, o);
  const { file = 'ROADMAP.md', branches = [], docs = [] } = o;
  const themes = [], lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let theme = null, horizon = null, done = false, count = 0;
  const themeOf = title => { let t = themes.find(x => x.title === title); if (!t) themes.push(t = { title, items: [] }); return t; };
  const has = (raw, name) => new RegExp(`(^|[\\s\`'"(,])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s\`'"),;:])`).test(raw);
  const push = (rawTitle, line, word, raw, extra = '') => {
    let title = rawTitle.replace(/\s+/g, ' ').trim();
    if (!title) return;
    const links = [...branches.filter(b => has(raw, b)).map(b => 'branch:' + b), ...docs.filter(d => has(raw, d)).map(d => 'doc:' + d)];
    const refs = [...title.matchAll(/#(\d+)/g)].map(m => '#' + m[1]);
    title = title.replace(/\s*\((?:[^()]*(?:branch |docs?\/|#\d+)[^()]*)\)\s*$/, '').replace(/`/g, '').trim();
    const note = [extra, refs.join(' ')].filter(Boolean).join(' ');
    themeOf(theme || path.basename(file).replace(/\.\w+$/, '')).items.push({ title: title.slice(0, 200),
      ...(horizon && !done && !PAST.includes(word) ? { horizon } : {}), ...(note ? { note: note.slice(0, 4000) } : {}),
      links: [...new Set(links)], legacy: { word: word || null, text: raw.trim().slice(0, 300), line, file } });
    count++;
  };
  lines.forEach((l, i) => {
    const h = /^#{2,4}\s+(.*)$/.exec(l);
    if (h) {
      const t = unnumber(h[1].trim()), hz = HORIZON.find(([re]) => re.test(t));
      done = DONE_HEAD.test(t); horizon = hz ? hz[1] : null;
      if (!hz && !done) theme = t;
      return;
    }
    const box = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(l);
    if (box) return push(box[2], i + 1, box[1] === ' ' ? (done ? 'DONE' : null) : 'DONE', l);
    const b = /^\s*[-*]\s+(.*)$/.exec(l);
    if (b) { const w = /^\[/.test(b[1]) || /^[A-Z' ]+:/.test(b[1]) ? wordOf(b[1]) : null; return push(w ? w.rest : b[1], i + 1, w ? w.word : done ? 'DONE' : null, l); }
    const row = /^\|(.+)\|\s*$/.exec(l);
    if (row && !/^[\s|:-]+$/.test(row[1])) {
      const cells = row[1].split('|').map(c => c.trim()), si = cells.findIndex(c => wordOf(c));
      if (si < 0) return;
      const w = wordOf(cells[si]);
      push(cells.find((c, j) => j !== si && c.length > 3) || '', i + 1, w.word, l, w.rest);
    }
  });
  return { themes: themes.filter(t => t.items.length), count };
}

// ---------- the legacy catalogue mode (META-ROADMAP S4, SPEC sec. 5: `norn road import --legacy`) ----------
// A long-kept catalogue: "## N. Title" sections, each with tables whose header names a Status column. Only those table rows are
// items (bullets, numbered lists and dated notes are prose; a table with no Status column is an inventory, not items). A section
// whose title starts with an archive word is skipped unless o.sections names it. Links are only what resolves (o.ids, o.branches,
// o.shas, o.docs, o.lanes: lists, maps or functions); what does not resolve is listed per item as `unresolved` for the review.
const ARCHIVE = /^(superseded|archive|archived|old\b|history)/i;
const LINK_OF = { DIR: 'dir', DEC: 'dec', Q: 'q', RUN: 'run', DLV: 'dlv', EP: 'ep' };
const BRANCH_PREFIXES = ['feat', 'feature', 'fix', 'bugfix', 'hotfix', 'release'];
const resolver = v => (typeof v === 'function' ? v : Array.isArray(v) ? (x => (v.includes(x) ? x : null)) : v ? (x => v[x] ?? null) : (() => null));
const cleanCell = s => String(s).replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
/** a row's typed word: at the cell start, else the first ladder word written in capitals in the cell's first 160 chars */
const ladderWord = cell => {
  const w = wordOf(cell);
  if (w) return w.word;
  const m = new RegExp(`(?<![A-Za-z])(${WORDS.map(x => x.replace(/'/g, "['’]")).join('|')})(?![A-Za-z])`).exec(cell.slice(0, 160));
  return m ? m[1].replace('’', "'") : null;
};
/** a short title: the item cell up to its first " (", ": ", " - ", " = ", "; " (when that leaves 4+ chars; a one-word head before
 *  ": " / " = " keeps the next clause: "LIGHTING = one path"), at most 78 chars */
const SEPS = [' (', ': ', ' - ', ' = ', '; '];
const cutAt = (t, from) => SEPS.map(s => [t.indexOf(s, from), s]).filter(([i]) => i >= from).sort((a, b) => a[0] - b[0])[0];
const shortTitle = cell => {
  let t = cell;
  const c = cutAt(t, 4);
  if (c) {
    const [i, s] = c, head = t.slice(0, i), more = !/\s/.test(head) && (s === ': ' || s === ' = ') ? cutAt(t, i + s.length + 1) : null;
    t = more ? t.slice(0, more[0]) : c && !/\s/.test(head) && (s === ': ' || s === ' = ') ? t : head;
  }
  return t.length > 78 ? t.slice(0, 75).replace(/\s+\S*$/, '') + ' ...' : t;
};
const sectionKey = h => { const m = /^(\d+[a-z]?)[.)]?\s+(.*)$/i.exec(h); return m ? { num: m[1].toLowerCase(), title: m[2] } : { num: null, title: h }; };

function catalogueOf(text, o) {
  const file = o.file || 'ROADMAP.md';
  const ids = resolver(o.ids), branch = resolver(o.branches), sha = resolver(o.shas), doc = resolver(o.docs), lane = resolver(o.lanes);
  const known = Array.isArray(o.branches) ? o.branches : o.knownBranches || [];
  const prefixes = [...new Set([...BRANCH_PREFIXES, ...known.filter(b => b.includes('/')).map(b => b.split('/')[0])])];
  const BR = new RegExp(`(?<![\\w/.-])(?:${prefixes.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\/[A-Za-z0-9][\\w.\\/-]*[A-Za-z0-9]`, 'g');
  const want = (o.sections || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const themes = [], misses = [], lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let theme = null, cols = null, count = 0;
  const linksOf = (raw, statusCell) => {
    const links = [], unresolved = [], add = (t, ok) => { const L = ok ? links : unresolved; if (!links.includes(t) && !unresolved.includes(t)) L.push(t); };
    for (const m of raw.matchAll(/(?<![\w-])(DIR|DEC|Q|RUN|DLV|EP)-(\d+)(?![\w-])/g)) { const id = `${m[1]}-${m[2]}`; add(`${LINK_OF[m[1]]}:${id}`, !!ids(id)); }
    for (const m of raw.matchAll(BR)) {
      const b = m[0].replace(/[.]+$/, ''), ok = !!branch(b);
      add('branch:' + b, ok);
      const l = ok ? lane(b) : null;
      if (l) add('lane:' + l, true);
    }
    for (const m of raw.matchAll(/(?<![\w-])[0-9a-f]{7,40}(?![\w-])/g)) if (/\d/.test(m[0]) && /[a-f]/.test(m[0]) && sha(m[0])) add('sha:' + m[0], true);
    for (const m of raw.matchAll(/(?<![\w.\/-])(?:[\w.-]+\/)*[\w.-]+\.md(?![\w-])/g)) { const p = doc(m[0]); add('doc:' + (p || m[0]), !!p); }
    const ref = [...statusCell.matchAll(/(?<![\w-])(DIR|DEC)-\d+(?![\w-])/g), ...raw.matchAll(/(?<![\w-])(DIR|DEC)-\d+(?![\w-])/g)].map(m => m[0]).find(id => ids(id));
    return { links, unresolved, ref };
  };
  lines.forEach((l, i) => {
    const h = /^(#{2,4})\s+(.*)$/.exec(l);
    if (h) {
      cols = null;
      if (h[1] !== '##') return;   // a ### sub-heading stays in its section
      const { num, title } = sectionKey(h[2].trim());
      const short = shortTitle(title.replace(/\s+\(.*$/, '').trim()) || title;
      const take = want.length ? want.includes(num ?? '\u0000') || want.some(w => short.toLowerCase() === w || title.toLowerCase().startsWith(w)) : !ARCHIVE.test(title);
      theme = take ? { title: short, ...(short !== title ? { note: title.slice(0, 4000) } : {}), items: [] } : null;
      if (theme) themes.push(theme);
      return;
    }
    const row = /^\s*\|(.*)\|\s*$/.exec(l);
    if (!row) { cols = null; return; }   // a table ends at the first line that is not a row
    const cells = row[1].split('|').map(c => c.trim());
    if (/^[\s|:-]+$/.test(row[1])) return;   // the header separator
    const next = lines[i + 1] || '';
    if (/^\s*\|[\s|:-]+\|\s*$/.test(next)) {   // a header row
      const si = cells.findIndex(c => /^status$/i.test(cleanCell(c)));
      cols = si < 0 ? { status: -1 } : { status: si, title: cells.findIndex((c, j) => j !== si) };
      return;
    }
    if (!theme || !cols || cols.status < 0) return;
    const titleCell = cleanCell(cells[cols.title] ?? ''), statusCell = cleanCell(cells[cols.status] ?? '');
    if (!titleCell) { misses.push({ line: i + 1, theme: theme.title, why: 'no item text' }); return; }
    const word = ladderWord(statusCell);
    const { links, unresolved, ref } = linksOf(l, statusCell);
    const title = shortTitle(titleCell);
    const note = [titleCell !== title ? titleCell : '', statusCell ? 'Status: ' + statusCell : '',
      ...cells.filter((c, j) => j !== cols.title && j !== cols.status && cleanCell(c) && cleanCell(c) !== '-').map(cleanCell)].filter(Boolean).join('\n');
    theme.items.push({ title: title.slice(0, 200), ...(note ? { note: note.slice(0, 4000) } : {}), links,
      ...(unresolved.length ? { unresolved } : {}), legacy: { word: word || null, text: l.trim().slice(0, 2000), line: i + 1, file },
      ...(word === 'DROPPED' && ref ? { dropped: { why: ('legacy row: ' + statusCell).slice(0, 300), ref } } : {}) });
    count++;
  });
  return { themes: themes.filter(t => t.items.length), count, misses };
}

/**
 * `norn road import --legacy <file>` (IO): the catalogue plan of a project's hand-kept file, every link resolved the way `norn road
 * apply` checks it (roadmap goneLinks over the state, the deliverables and the project's repo); docs found under the project root,
 * beside the file or beside the root. Each item that shares work (lane / branch / run / DLV / epic) with an existing open item names it in `overlaps`
 * (the review merges or keeps both). A dry run: writes no record.
 */
export function importLegacy(stateDir, { project = {}, file, sections = [], git } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  const W = world({ stateDir, project, ...(git ? { git } : {}) });
  const ok = term => !goneLinks([term], W).length;
  let refs = [];
  if (W.repo) {
    const r = spawnSync('git', ['-C', W.repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    refs = [...new Set(String(r.stdout || '').split(/\r?\n/).map(s => s.trim().replace(/^origin\//, '')).filter(s => s && !/HEAD$/.test(s)))];
  }
  // a doc is looked up under the root, beside the file, then beside the root (notes kept in sibling dirs of the checkout)
  const root = project.root ? path.resolve(project.root) : null, here = path.dirname(path.resolve(file));
  const docOf = tok => {
    for (const base of [root, here, root && path.dirname(root)].filter(Boolean)) {
      const p = path.resolve(base, tok);
      if (!fs.existsSync(p)) continue;
      const rel = root ? path.relative(root, p) : null;
      return (rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p).replace(/\\/g, '/');
    }
    return null;
  };
  const laneOf = b => {
    const s = b.split('/').pop();
    if (ok('lane:' + s)) return s;
    return (W.dlvByBranch[b] || []).map(d => d.lane).find(Boolean) || null;
  };
  const plan = importPlan(text, { file: path.basename(file), legacy: true, sections, ids: id => ok(`${LINK_OF[id.split('-')[0]]}:${id}`),
    branches: b => ok('branch:' + b), shas: x => ok('sha:' + x), docs: docOf, lanes: laneOf, knownBranches: refs });
  const R = loadRoadmap(stateDir), WORK = /^(lane|branch|run|dlv|ep):/;
  const open = Object.values(R.items).filter(i => i.state === 'open' && i.kind === 'item');
  for (const t of plan.themes) for (const it of t.items) {
    const hits = open.filter(i => i.links.some(x => WORK.test(x) && it.links.includes(x))).map(i => i.id);
    if (hits.length) it.overlaps = hits;
  }
  return plan;
}

/** the review summary `norn road import --legacy` prints (one line per item: line, word, title, links, unresolved, overlaps) */
export function renderImport(plan) {
  const rows = plan.count + plan.misses.length, pct = rows ? Math.round((plan.count / rows) * 1000) / 10 : 0;
  const out = [`placed ${plan.count} of ${rows} rows (${pct} %); ${plan.themes.length} theme${plan.themes.length === 1 ? '' : 's'}; ${plan.misses.length} not placed`];
  for (const t of plan.themes) {
    out.push('', `## ${t.title} (${t.items.length})`);
    for (const it of t.items) out.push(`L${it.legacy.line}  ${(it.legacy.word || '-').padEnd(18)}  ${it.title}  links: ${it.links.join(', ') || '-'}`
      + (it.unresolved?.length ? `; unresolved: ${it.unresolved.join(', ')}` : '') + (it.overlaps?.length ? `; overlaps: ${it.overlaps.join(', ')}` : '')
      + (it.dropped ? `; drop (${it.dropped.ref})` : ''));
  }
  if (plan.misses.length) out.push('', ...plan.misses.map(m => `not placed: L${m.line} (${m.theme}): ${m.why}`));
  return out.join('\n');
}

// ---------- the draft: six parts (SPEC sec. 2) ----------
export const PARTS = ['profile', 'commands', 'rules', 'instructions', 'roadmap', 'first'];
const PART_TITLE = { profile: 'Caps profile', commands: 'Test, lint and build commands', rules: 'Project rules', instructions: 'Agent instructions (AGENTS.md etc.)',
  roadmap: 'Roadmap', first: 'First task' };
const PROFILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'profiles');
/** the caps profiles as DATA (engine/presets/profiles, F-6); none installed -> the names only: the pick is recorded, caps are not written */
function profileLines() {
  let all = [];
  try { all = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8').replace(/^﻿/, ''))); } catch { /* not installed */ }
  const ps = all.filter(x => x.kind === 'profile').sort((a, b) => a.order - b.order);
  if (ps.length) return ps.map(x => ({ id: x.name, text: `${x.label || x.name}: ${x.summary || ''}`.trim(), source: `profile data ${x.name}.json`, ...(x.default ? { default: true } : {}) }));
  return ['try-it', 'solo', 'heavy'].map((n, i) => ({ id: n, text: `${n} (the profile data is not installed: the pick is recorded, the caps are not written)`, source: 'profile names', ...(i ? {} : { default: true }) }));
}
export const RULES_FILE = 'rules/RULES.md';
const RULES_HEAD = '# Project rules\n\nEvery worker reads this file whole. Drafted from the repository; it is yours to edit.\n\n';
/**
 * META-ADOPT A3 (SPEC sec. 5, "rules empty: Write one rule"): one owner rule appended to RULES.md beside project.json (created with the
 * same head as an applied rules part) + rules_read_whole. Never the repo. -> { file, added (false = the rule is there already) }
 */
// META-DASH-ASYNC R1: the dash server is the only caller - the writes on fs.promises (no sync form: no CLI calls it)
export const addRuleAsync = (project, text) => runStepsAsync(ruleSteps(project, text), ASYNC_IO);
function* ruleSteps(project, text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 400 || /[\r\n]/.test(t)) throw new AdoptError('a rule is one line of 1-400 characters');
  const rf = rulesPath(project);
  let had = null; try { had = fs.readFileSync(rf, 'utf8'); } catch { /* none yet */ }
  const added = !had?.split(/\r?\n/).includes(`- ${t}`);
  if (added) { yield ['mkdir', path.dirname(rf)]; yield ['write', rf, (had ?? RULES_HEAD).replace(/\n*$/, '\n') + `- ${t}\n`]; }
  const raw = JSON.parse(fs.readFileSync(project.file, 'utf8').replace(/^\uFEFF/, '')), ref = '${project_dir}/' + RULES_FILE;
  if (!(raw.rules_read_whole || []).includes(ref)) { raw.rules_read_whole = [...(raw.rules_read_whole || []), ref]; yield ['write', project.file, JSON.stringify(raw, null, 1) + '\n']; }
  return { file: fwd(rf), added };
}
const rulesPath = project => path.join(project.project_dir || path.dirname(project.file), RULES_FILE);
const sameLinks = (a = [], b = []) => a.length === b.length && a.every(x => b.includes(x));
/** an existing roadmap item that IS this imported line: the same legacy (file, line, text), or the same title + links */
const itemMatch = (items, l) => items.find(i => i.kind === 'item' && ((i.legacy && i.legacy.file === l.legacy?.file && i.legacy.line === l.legacy?.line && i.legacy.text === l.legacy?.text)
  || (i.title === l.text && sameLinks(i.links, l.links))));
// at most 40 chars, cut at a word boundary (SHIP-READY W7); one word longer than that is cut as it is
export const laneNameOf = text => { const s = slugOf(text), k = s.slice(0, 41).lastIndexOf('-'); return (s.length <= 40 ? s : k > 0 ? s.slice(0, k) : s.slice(0, 40)) || 'first-task'; };

/** what is already on record for this project: { items (roadmap), rules (RULES.md text | null), gate, lanes } */
export function existingOf(stateDir, project) {
  let rules = null;
  try { rules = project ? fs.readFileSync(rulesPath(project), 'utf8') : null; } catch { /* none yet */ }
  const st = fs.existsSync(stateDir) ? loadState(stateDir) : { items: {} };
  return { items: Object.values(loadRoadmap(stateDir).items).filter(i => i.state === 'open'), rules, gate: project?.merge?.gate?.cmd || null,
    lanes: Object.values(st.items).filter(i => i.kind === 'lane').map(i => i.data.name) };
}

/**
 * The facts-only draft (free, no model): facts (a scan) + answers { never, first } + existing (existingOf) -> { source, parts }.
 * part = { id, type, title, pick? (exactly one line is approved), empty? (why it has no line), lines: [{ id, text, source, already?, ... }] }.
 * A line already on record is marked `already` and is never written again. The profile is never drafted as decided.
 */
export function draftFacts(facts, { answers = {}, existing = {} } = {}) {
  const ex = { items: [], rules: null, gate: null, lanes: [], ...existing };
  const inRules = t => !!ex.rules && ex.rules.includes(t);
  const parts = [];
  const part = (id, lines, o = {}) => parts.push({ id, type: id, title: PART_TITLE[id], ...o, lines });
  part('profile', profileLines(), { pick: true });
  const cmds = [...facts.commands.map(c => ({ ...c, source: c.source + (c.ci ? `; CI ${c.ci}` : '') })),
    ...(answers.tests && !facts.commands.some(c => c.id === 'test') ? [{ id: 'test', cmd: answers.tests, source: 'your answer (tests)' }] : [])];
  part('commands', cmds.map(c => ({ id: c.id, text: c.cmd, source: c.source,
    ...((c.id === 'test' ? ex.gate === c.cmd : inRules('`' + c.cmd + '`')) ? { already: true } : {}) })),
    cmds.length ? {} : { empty: `no test command found (${facts.manifests.length ? 'manifests only in sub-folders: ' + facts.manifests.join(', ') : 'no manifest, no CI test step'}): merges are not gated until you name your test command as merge.gate.cmd in project.json` });
  const rules = [], sub = facts.subdir, inSub = cmd => (sub ? `cd ${sub} && ${cmd}` : cmd);
  // a monorepo project: the one folder it is about comes first (the scope guard holds a run without Scope: inside it as well)
  if (sub) rules.push({ text: `This project is the ${sub}/ folder of the repository: change files only under ${sub}/, unless the brief's Scope names another path. Run its commands from ${sub}/.`, source: `project.json subdir ${sub}` });
  for (const a of facts.agent_files) rules.push({ text: `Read ${a.file} before you change anything: it is the repository's own instruction file.`, source: `${a.file} (${a.lines} lines)` });
  if (facts.docs.contributing) rules.push({ text: `Follow ${facts.docs.contributing} for branches, commits and reviews.`, source: facts.docs.contributing });
  const test = cmds.find(c => c.id === 'test');
  if (test) rules.push({ text: `Run \`${inSub(test.cmd)}\` before you report DONE; never loosen or skip a test to make it pass.`, source: test.source });
  rules.push({ text: `Work only in your lane's worktree and branch; never push to ${facts.default_branch}.`, source: `scan: default branch ${facts.default_branch}` });
  if (answers.never) rules.push({ text: `Never: ${answers.never}`, source: 'your answer (never)' });
  part('rules', rules.map((r, i) => ({ id: 'u' + (i + 1), ...r, ...(inRules(r.text) ? { already: true } : {}) })));
  part('instructions', facts.agent_files.length
    ? facts.agent_files.map((a, i) => ({ id: 'i' + (i + 1), text: `keep ${a.file} as it is (${a.lines} lines): it is never edited`, source: a.file }))
    : [{ id: 'i1', text: 'no agent instructions file (AGENTS.md or similar): writing one is offered as a first task', source: 'scan: agent files' }]);
  const road = [];
  // NEW (SPEC sec. 2): the interview drafts the roadmap - the goal names the theme, the first small thing is "now", the month is "next"
  const theme = answers.goal ? String(answers.goal).slice(0, 200) : facts.name;
  for (const [k, horizon] of [['first', 'now'], ['month', 'next']]) if (answers[k])
    road.push({ id: 'r' + (road.length + 1), text: String(answers[k]).slice(0, 200), source: `your answer (${k})`, theme, horizon, links: [] });
  for (const f of facts.imported || []) for (const t of f.themes) for (const it of t.items)
    road.push({ id: 'r' + (road.length + 1), text: it.title, source: `${it.legacy.file}:${it.legacy.line}`, theme: t.title, ...(it.horizon ? { horizon: it.horizon } : {}),
      ...(it.note ? { note: it.note } : {}), links: it.links, legacy: it.legacy });
  for (const l of road) if (itemMatch(ex.items, l)) l.already = true;
  part('roadmap', road, road.length ? {} : { empty: 'no planning file (ROADMAP / TODO / BACKLOG / PLAN) on the default branch: add items with norn road add' });
  const first = [];
  if (answers.first) first.push({ text: answers.first, source: 'your answer (first)', item: road.find(l => l.source === 'your answer (first)').id });
  const open = road.filter(l => l.legacy && !PAST.includes(l.legacy.word));
  for (const l of [...open.filter(l => l.horizon === 'now'), ...open.filter(l => l.horizon !== 'now')]) first.push({ text: l.text, source: l.source, item: l.id });
  if (!facts.agent_files.length) first.splice(1, 0, { text: 'Write an AGENTS.md for this repository: how to build, test and lay out a change', source: 'scan: no agent file' });
  if (!test) first.push({ text: 'Find out how the tests run and write the command down', source: 'scan: no test command' });
  part('first', first.slice(0, 3).map((f, i) => ({ id: 'f' + (i + 1), ...f, ...(ex.lanes.includes(laneNameOf(f.text)) ? { already: true } : {}) })), { pick: true });
  return { source: 'facts', parts };
}

// ---------- the proposal (record kind proposal, ADP-n; SPEC sec. 4) ----------
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const partSha = p => sha256(JSON.stringify(p.lines));
const rel = (stateDir, f) => fwd(path.relative(stateDir, f));
const readJson = (stateDir, f) => JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8'));
const proposals = stateDir => Object.values(fold(readEvents(recordsFile(stateDir, 'proposal'))).items);
const num = id => Number(String(id).split('-').pop());
// an unverified line (checkDraft: nothing backs it) is OFF unless the decider turned it on
const onLines = (p, off = [], on = []) => p.lines.filter(l => !l.already && !off.includes(l.id) && (!l.unverified || on.includes(l.id)));

/**
 * The latest proposal of a project, folded: { id, state, path, why, answers, draft: { file, source, n, facts }, parts: [part + { sha,
 * status: to review | approved | skipped, decision, applied }], undecided } | null. A decision holds only while the part's sha is the
 * one the decider saw (the saved-plan rule).
 */
export function proposalOf(stateDir, id = null) {
  const all = proposals(stateDir).sort((a, b) => num(a.id) - num(b.id));
  const it = id ? all.find(x => x.id === id) : all.at(-1);
  if (!it) return null;
  const h = it.history, drafts = h.filter(x => x.ev === 'draft'), last = drafts.at(-1);
  const answers = Object.assign({}, ...h.filter(x => x.ev === 'answer').map(x => x.data.answers));
  let draft = null;
  try { draft = last ? readJson(stateDir, last.data.file) : null; } catch { /* a missing bulk file: no parts to show */ }
  const applied = h.filter(x => x.ev === 'apply').flatMap(x => x.data.parts || []);
  const parts = (draft?.parts || []).map(p => {
    const sha = partSha(p), dec = [...h].reverse().find(x => x.ev === 'decide' && x.data.part === p.id && x.data.sha === sha) || null;
    const app = applied.find(a => a.part === p.id && a.sha === sha) || null;
    return { ...p, sha, status: dec ? (dec.data.verdict === 'approve' ? 'approved' : 'skipped') : 'to review', decision: dec ? { ...dec.data, by: dec.by, ts: dec.ts } : null, applied: app };
  });
  return { id: it.id, state: it.state, path: it.data.path, why: it.data.why, created: it.created, answers, facts_file: it.data.facts,
    draft: last ? { file: last.data.file, source: last.data.source, n: drafts.length, facts: draft?.facts || null,
      ...Object.fromEntries(['summary', 'goals', 'questions', 'unsure', 'problems', 'note'].filter(k => draft?.[k] !== undefined).map(k => [k, draft[k]])) } : null,
    parts, undecided: parts.filter(p => p.status === 'to review').map(p => p.id) };
}

/**
 * norn adopt draft (facts only): scan the project's repo; open ADP-n when none is open (create), record the answers, then draft.
 * A re-draft of an open proposal keeps every decision whose part did not change. -> { id, created, parts }
 */
export function adoptStart(stateDir, { project, by, answers = {} } = {}) {
  const { p, facts, created } = openFor(stateDir, { project, by, answers });
  const d = draftFacts(facts, { answers: { ...p.answers, ...answers }, existing: existingOf(stateDir, project) });
  writeDraft(stateDir, p, d, facts, { by });
  return { id: p.id, created, parts: proposalOf(stateDir, p.id).parts };
}

/** the open proposal of a project (created when none is open: the facts file + create) with the answers recorded -> { p, facts, created } */
function openFor(stateDir, { project, by, answers = {} }) {
  if (!project?.root) throw new AdoptError('adopt needs a project (its root is the repo to read)');
  const bad = Object.keys(answers).filter(k => !ANSWER_KEYS.includes(k));
  if (bad.length) throw new AdoptError(`unknown answer ${bad.join(', ')} (answers: ${ANSWER_KEYS.join(', ')})`);
  const facts = scan(project.root, { subdir: subdirOf(project) });
  fs.mkdirSync(stateDir, { recursive: true });
  let p = proposalOf(stateDir), created = false;
  if (!p || p.state !== 'open') {
    const pfx = idPrefix(stateDir), n = Math.max(0, ...proposals(stateDir).map(x => num(x.id))) + 1;
    const dir = path.join(stateDir, 'adopt', `ADP-${pfx ? pfx + '-' : ''}${n}`);
    fs.mkdirSync(dir, { recursive: true });
    const text = JSON.stringify(facts, null, 1) + '\n', file = path.join(dir, 'facts.json');
    fs.writeFileSync(file, text);
    const e = record(stateDir, { kind: 'proposal', ev: 'create', by, data: { facts: rel(stateDir, file), sha: sha256(text), path: facts.path, why: facts.path_why } });
    if (e.id !== path.basename(dir)) throw new AdoptError(`internal: ${e.id} was recorded for ${fwd(dir)}`, 1);
    created = true;
    p = proposalOf(stateDir, e.id);
  }
  if (Object.keys(answers).length) { record(stateDir, { kind: 'proposal', ev: 'answer', id: p.id, by, data: { answers } }); p = proposalOf(stateDir, p.id); }
  return { p, facts, created };
}

/** draft-<n>.json beside the proposal + its draft event (data.run: the read it came from, also for a fallback) */
function writeDraft(stateDir, p, d, facts, { by, run } = {}) {
  const n = (proposalOf(stateDir, p.id).draft?.n || 0) + 1;
  const file = path.join(stateDir, 'adopt', p.id, `draft-${n}.json`), text = JSON.stringify({ ...d, facts }, null, 1) + '\n';
  fs.writeFileSync(file, text);
  record(stateDir, { kind: 'proposal', ev: 'draft', id: p.id, by, data: { file: rel(stateDir, file), sha: sha256(text), source: d.source, ...(run ? { run } : {}),
    parts: d.parts.map(x => ({ id: x.id, type: x.type, lines: x.lines.length, sha: partSha(x) })) } });
}

const openOf = stateDir => {
  const p = proposalOf(stateDir);
  if (!p || p.state !== 'open') throw new AdoptError(p ? `${p.id} is ${p.state}: start a new one with norn adopt draft` : 'no proposal yet: norn adopt draft');
  return p;
};

/**
 * approve | skip one part of the open proposal, as seen (its sha). pick = the one line of a pick part (profile, first task).
 * edits = { <line id>: <the reviewer's text> } (META-ADOPT A3: the review's Edit): applied in place of the drafted text; the draft keeps
 * the original (its sha, its source), so a re-draft still recognises the line.
 * extra: more event data from a front end (META-ADOPT A4 MCP: owner_words verbatim, via)
 */
export const adoptDecide = (stateDir, o) => runSteps(decideSteps(stateDir, o), SYNC_IO);
/** adoptDecide for the dash server (its record on fs.promises) */
export const adoptDecideAsync = (stateDir, o) => runStepsAsync(decideSteps(stateDir, o), ASYNC_IO);
function* decideSteps(stateDir, { part, verdict, off = [], on = [], pick, edits = {}, by, extra = {} } = {}) {
  const p = openOf(stateDir), x = p.parts.find(y => y.id === part);
  if (!x) throw new AdoptError(`${p.id} has no part ${part} (${p.parts.map(y => y.id).join(' | ')})`);
  if (edits === null || typeof edits !== 'object' || Array.isArray(edits)) throw new AdoptError('edits: an object { <line id>: <text> }');
  for (const [id, t] of Object.entries(edits)) {
    if (!x.lines.some(l => l.id === id)) throw new AdoptError(`${part} has no line ${id} (${x.lines.map(l => l.id).join(' | ')})`);
    if (typeof t !== 'string' || !t.trim() || t.length > 400 || /[\r\n]/.test(t)) throw new AdoptError(`edit of ${id}: one line of 1-400 characters`);
    if (x.pick && x.type === 'profile') throw new AdoptError('the profile is picked, not edited');
  }
  if (pick !== undefined) {
    if (!x.pick) throw new AdoptError(`--pick is for a pick part (${p.parts.filter(y => y.pick).map(y => y.id).join(', ')})`);
    if (!x.lines.some(l => l.id === pick)) throw new AdoptError(`${part} has no line ${pick} (${x.lines.map(l => l.id).join(' | ')})`);
    off = x.lines.filter(l => l.id !== pick).map(l => l.id);
    if (x.lines.find(l => l.id === pick).unverified) on = [pick];
  }
  for (const o of on) if (!x.lines.some(l => l.id === o)) throw new AdoptError(`${part} has no line ${o} (${x.lines.map(l => l.id).join(' | ')})`);
  for (const o of off) if (!x.lines.some(l => l.id === o)) throw new AdoptError(`${part} has no line ${o} (${x.lines.map(l => l.id).join(' | ')})`);
  if (verdict === 'approve' && x.pick && onLines(x, off, on).length !== 1)
    throw new AdoptError(`${part}: pick one line (--pick ${x.lines.map(l => l.id).join(' | ')}); it is never decided for you`);
  const ed = Object.fromEntries(Object.entries(edits).map(([k, t]) => [k, t.trim()]));
  yield ['record', stateDir, { kind: 'proposal', ev: 'decide', id: p.id, by, data: { ...extra, part, verdict, off, ...(on.length ? { on } : {}), ...(Object.keys(ed).length ? { edits: ed } : {}), sha: x.sha } }];
  return { id: p.id, part, verdict };
}

export const adoptClose = (stateDir, o) => runSteps(closeSteps(stateDir, o), SYNC_IO);
export const adoptCloseAsync = (stateDir, o) => runStepsAsync(closeSteps(stateDir, o), ASYNC_IO);
function* closeSteps(stateDir, { why, by } = {}) {
  const p = openOf(stateDir);
  yield ['record', stateDir, { kind: 'proposal', ev: 'close', id: p.id, by, data: { why } }];
  return { id: p.id };
}

/**
 * Apply every approved part not applied yet (one lock). Roadmap lines -> item records by role migration with legacy_by = the
 * approver; rules -> RULES.md beside project.json (written once, then only additions) + rules_read_whole; commands -> merge.gate.cmd
 * + the Commands block of RULES.md; profile -> a decision record of the pick + the caps through the profile data when installed;
 * first task -> a lane (newLane) linked from its roadmap item; instructions -> nothing (the repo is never written).
 * -> { id, lines (what was / would be written), complete }. dryRun writes nothing.
 */
export async function adoptApply(stateDir, { project, by, dryRun = false, metaRoot, extra = {} } = {}) {
  const profiles = await profileData();
  return withLock(path.join(stateDir, 'adopt-apply.lock'), () => runSteps(applySteps(stateDir, { project, by, dryRun, metaRoot, profiles, extra }), SYNC_IO));
}
/** adoptApply for the dash server: the same steps under the same lock file, the writes on fs.promises, the lane's git as an async child */
export async function adoptApplyAsync(stateDir, { project, by, dryRun = false, metaRoot, extra = {} } = {}) {
  const profiles = await profileData();
  return withLockAsync(path.join(stateDir, 'adopt-apply.lock'), () => runStepsAsync(applySteps(stateDir, { project, by, dryRun, metaRoot, profiles, extra }), ASYNC_IO));
}
async function profileData() { try { return await import('./profiles.mjs'); } catch { return null; /* the profile data is not installed (F-6) */ } }

function* applySteps(stateDir, { project, by, dryRun, metaRoot, profiles, extra = {} }) {
  const p = openOf(stateDir), lines = [], done = [], wrote = {};
  const todo = p.parts.filter(x => x.status === 'approved' && !x.applied);
  const P = id => todo.find(x => x.id === id);
  const sel = x => (x ? onLines(x, x.decision.off, x.decision.on).map(l => (x.decision.edits?.[l.id] ? { ...l, text: x.decision.edits[l.id], edited: true } : l)) : []);
  const say = (part, l) => { lines.push(`${part}: ${l}`); (wrote[part] ||= []).push(l); };
  const ex = existingOf(stateDir, project);
  // roadmap: one batch (one lock), the importer's claims kept as legacy
  const rm = {};
  const road = sel(P('roadmap')).filter(l => !itemMatch(ex.items, l));
  if (road.length) {
    const themes = [];
    for (const l of road) {
      let t = themes.find(x => x.title === l.theme);
      if (!t) { const old = ex.items.find(i => i.kind === 'theme' && i.title === l.theme); themes.push(t = { title: l.theme, ...(old ? { id: old.id } : {}), items: [] }); }
      t.items.push({ title: l.text, ...(l.horizon ? { horizon: l.horizon } : {}), ...(l.stages?.length ? { stages: l.stages } : {}), ...(l.note ? { note: l.note } : {}), links: l.links, legacy: l.legacy, line: l.id });
    }
    const { events, links, counts } = planEvents({ themes }, 'migration', { legacy_by: by });
    checkLinks(stateDir, links, { project });
    say('roadmap', `${counts.item} item(s) in ${themes.length} theme(s) (${counts.theme} new) -> roadmap.jsonl`);
    if (!dryRun) {
      const out = yield ['record', stateDir, events, { views: false }];
      let k = 0;
      for (const t of themes) { if (!t.id) k++; for (const it of t.items) rm[it.line] = out[k++].id; }
      try { yield ['roadmapView', stateDir, buildTree({ stateDir, project }), roadmapViewPath(stateDir, project)]; } catch { /* the next norn road writes it */ }
    }
  }
  if (P('roadmap')) done.push('roadmap');
  // commands + rules: project.json and RULES.md beside it (never the repo)
  const cmds = sel(P('commands')), test = cmds.find(c => c.id === 'test'), rules = sel(P('rules'));
  const raw = JSON.parse(fs.readFileSync(project.file, 'utf8').replace(/^﻿/, ''));
  let pj = false;
  if (test && raw.merge?.gate?.cmd !== test.text) { raw.merge = { ...(raw.merge || {}), gate: { ...(raw.merge?.gate || {}), cmd: test.text } }; pj = true; say('commands', `merge.gate.cmd = ${test.text} -> project.json`); }
  if (P('commands')) done.push('commands');
  if (P('rules')) {
    const rf = rulesPath(project), had = ex.rules;
    const body = rules.filter(r => !had?.includes(r.text)).map(r => `- ${r.text}`);
    const block = cmds.filter(c => !had?.includes('`' + c.text + '`')).map(c => `- ${c.id}: \`${c.text}\` (${c.source})`);
    let text = had ?? RULES_HEAD;
    if (body.length) text += body.join('\n') + '\n';
    if (block.length) text += `\n## Commands\n${block.join('\n')}\n`;
    if (text !== had) {
      say('rules', `${body.length} rule(s)${block.length ? ` + ${block.length} command(s)` : ''} -> ${fwd(rf)}`);
      if (!dryRun) { yield ['mkdir', path.dirname(rf)]; yield ['write', rf, text]; }
    }
    const ref = '${project_dir}/' + RULES_FILE;
    if (!(raw.rules_read_whole || []).includes(ref)) { raw.rules_read_whole = [...(raw.rules_read_whole || []), ref]; pj = true; say('rules', `rules_read_whole += ${ref} -> project.json`); }
    done.push('rules');
  }
  if (pj && !dryRun) yield ['write', project.file, JSON.stringify(raw, null, 1) + '\n'];
  if (P('instructions')) { for (const l of sel(P('instructions'))) say('instructions', `${l.text} (nothing written)`); done.push('instructions'); }
  // profile: the pick is a decision record; the caps go through the profile data when it is installed
  const prof = sel(P('profile'))[0];
  if (prof) {
    say('profile', `decision: caps profile ${prof.id}`);
    if (profiles?.getProfile && profiles?.profileBudget && metaRoot) {
      const bf = path.join(metaRoot, 'local', 'budget.json');
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(bf, 'utf8').replace(/^﻿/, '')); } catch { /* none yet */ }
      say('profile', `caps of ${prof.id} -> ${fwd(bf)} (the scheduler is never installed by apply)`);
      if (!dryRun) { yield ['mkdir', path.dirname(bf)]; yield ['budget', bf, cur, { ...cur, ...profiles.profileBudget(profiles.getProfile(prof.id), { floor: floorOf(cur) }) }]; }
    } else say('profile', 'caps not written: the profile data is not installed (the pick is recorded; the starter caps stay in force)');
    if (!dryRun) yield ['record', stateDir, { kind: 'decision', ev: 'create', by, data: { lane: 'adopt', question: `${p.id} caps profile`, choice: prof.id, why: `picked in ${p.id} (norn adopt)` } }, project.views ? { views: project.views } : {}];
  }
  if (P('profile')) done.push('profile');
  // the first task: a lane (worktree, the owner's directive, its first brief), linked from its roadmap item
  const first = sel(P('first'))[0];
  if (first) {
    const name = laneNameOf(first.text);
    say('first', `lane ${name}: "${first.text}" (worktree + branch + directive + brief)`);
    if (!dryRun) {
      yield* laneSteps(project, { name, task: `${first.text}\n\nSource: ${first.source} (drafted in ${p.id}).`, by });
      const line = p.parts.find(x => x.id === 'roadmap')?.lines.find(l => l.id === first.item);
      const rmId = line && (rm[line.id] || itemMatch(Object.values(loadRoadmap(stateDir).items), line)?.id);
      if (rmId) yield ['record', stateDir, { kind: 'item', ev: 'link', id: rmId, by, data: { links: ['lane:' + name] } }, { views: false }];
    }
  }
  if (P('first')) done.push('first');
  const complete = p.parts.every(x => x.status !== 'to review');
  if (!dryRun && (done.length || complete))
    yield ['record', stateDir, { kind: 'proposal', ev: 'apply', id: p.id, by, data: { ...extra, parts: done.map(id => ({ part: id, sha: P(id).sha, wrote: wrote[id] || [] })), complete } }];
  if (!lines.length) lines.push('nothing new to write');
  return { id: p.id, lines, complete, dryRun };
}

// ---------- META-ADOPT A2: the NEW interview and the read (SPEC sec. 2-3) ----------
/** the interview answers a draft takes: NEW goal / month / first (+ tests), ADOPT priority / never */
export const ANSWER_KEYS = ['goal', 'month', 'first', 'tests', 'priority', 'never'];
const DOC_EXT = ['.md', '.txt', '.rst', '(none)'];
/**
 * The questions for this repo, all optional (SPEC sec. 2). NEW (nothing to read yet): what it is for, what should exist in a month, the
 * first small thing; a 4th, how the tests run, only when the repo has files beyond docs but no test command. ADOPT: at most 2.
 * -> [{ id, text, why }]
 */
export function interviewOf(facts) {
  if (facts.path === 'adopt') return [
    { id: 'priority', text: 'Which piece of work matters most right now?', why: 'it orders the roadmap and picks the first task' },
    { id: 'never', text: 'Is there anything a worker must never do in this repository?', why: 'it becomes a project rule every worker reads' }];
  const q = [
    { id: 'goal', text: 'What is this project for?', why: 'it names the roadmap theme' },
    { id: 'month', text: 'What should exist in a month?', why: 'it becomes the "next" roadmap item' },
    { id: 'first', text: 'What is the first small thing to do?', why: 'it becomes the "now" item and the first task' }];
  const code = Object.keys(facts.size?.by_ext || {}).some(e => !DOC_EXT.includes(e));
  if (code && !facts.commands.some(c => c.id === 'test')) q.push({ id: 'tests', text: 'How do you run the tests?', why: 'it becomes the merge gate (the scan found none)' });
  return q;
}

const ADOPT_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'ADOPT.md');
/** the read's brief: engine/prompts/ADOPT.md with the repo, the facts and the answers filled in; a retry says why the last answer failed */
export function readBrief(facts, answers = {}, { retry } = {}) {
  const fill = { root: facts.root, branch: facts.default_branch, facts: JSON.stringify(facts, null, 1), answers: JSON.stringify(answers, null, 1),
    focus: facts.subdir ? `\n- FOCUS: this project is only the folder ${facts.subdir}/ of the repository (a monorepo). Read files under ${facts.root}/${facts.subdir}/;\n  outside it read only a top-level README or agent file that applies to the whole repo. Every goal, command, rule, roadmap item\n  and first task is about ${facts.subdir}/ alone: leave out the other folders' work. A command runs from ${facts.subdir}/ (write it as\n  run there, without a cd). Sources stay repo-relative (${facts.subdir}/README.md:3).` : '',
    retry: retry ? `\nRETRY: your last answer was not one valid JSON object (${String(retry).slice(0, 300)}). Answer again: the JSON object only.\n` : '' };
  return fs.readFileSync(ADOPT_MD, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in fill ? fill[k] : m));
}

/** the read's final -> its JSON object (a code fence or prose around it are tolerated) or AdoptError */
export function parseRead(text) {
  const t = String(text || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new AdoptError('no JSON object in the answer');
  let j;
  try { j = JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new AdoptError(`not valid JSON: ${e.message}`); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new AdoptError('the answer is not one JSON object');
  return j;
}

const arr = v => (Array.isArray(v) ? v : []);
const RUNNER = /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+([\w:.-]+)/;
const linkWhy = k => (k === 'branch' ? 'no such branch' : k === 'doc' ? 'not a tracked file' : 'only branch: and doc: links are drafted');
/**
 * The engine's check of a read before anyone sees it (SPEC sec. 3). -> { read (cleaned), problems [one line each] }.
 * - a command is backed when the scan found it, a CI line runs it, or its cited line states it (a package.json line naming its script):
 *   else it is `unverified` (shown, off until the decider turns it on). An invented command never passes as backed.
 * - every cited source must be a tracked file:line that is not empty; a rule / item with none that resolves is unverified.
 * - a link to a branch the scan does not list, or to a file that is not tracked, is dropped; a typed status is dropped (claims only).
 * - over the brief's caps (10 rules, 6 themes, 3 first tasks, 5 goals, 3 questions) the rest is dropped.
 */
export function checkDraft(read, facts, { readFile } = {}) {
  const problems = [], head = facts.default_branch, cache = new Map();
  const get = readFile || (f => sh(facts.root, ['show', `${head}:${f}`]));
  const lines = f => { if (!cache.has(f)) { const t = get(f); cache.set(f, t == null ? null : t.replace(/\r\n/g, '\n').split('\n')); } return cache.get(f); };
  const resolve = src => {
    const m = /^(?:\.\/)?(.+?):(\d+)(?:-(\d+))?$/.exec(String(src ?? '').trim());
    if (!m) return null;
    const ls = lines(m[1]), a = Number(m[2]), b = Number(m[3] || m[2]);
    if (!ls || a < 1 || b < a || b > ls.length) return null;
    const text = ls.slice(a - 1, b).join('\n');
    return text.trim() ? { file: m[1], line: a, text } : null;
  };
  const out = { ...read };
  const known = new Set([...facts.commands.map(c => c.cmd), ...facts.ci.flatMap(c => c.runs.map(r => r.cmd))]);
  out.commands = arr(read.commands).filter(c => c && typeof c.cmd === 'string' && c.cmd.trim()).map(c => {
    const x = { ...c, id: slugOf(c.id || 'cmd') || 'cmd', cmd: c.cmd.trim() }, r = resolve(c.source);
    const script = RUNNER.exec(x.cmd)?.[1];
    const stated = r && (r.text.includes(x.cmd) || (/(^|\/)package\.json$/.test(r.file) && script && r.text.includes(`"${script}"`)));
    if (!known.has(x.cmd) && !stated) { x.unverified = true; problems.push(`commands.${x.id}: "${x.cmd}" - no manifest, CI line or cited line (${c.source ?? 'none'}) states it: unverified, off`); }
    return x;
  });
  const sourced = (x, what) => {
    if (resolve(x.source)) return x;
    problems.push(`${what}: its source ${x.source ?? '(none)'} is not a line of a tracked file: unverified, off`);
    return { ...x, unverified: true };
  };
  const cap = (list, n, what) => { if (list.length > n) problems.push(`${what}: ${list.length} drafted, the brief allows ${n}: the rest dropped`); return list.slice(0, n); };
  out.goals = cap(arr(read.goals).filter(g => g?.text), 5, 'goals');
  for (const g of out.goals) if (!resolve(g.source)) problems.push(`goal "${g.text}": its source ${g.source ?? '(none)'} does not resolve`);
  out.rules = cap(arr(read.rules).filter(r => r && typeof r.text === 'string' && r.text.trim()), 10, 'rules').map(r => sourced(r, `rule "${r.text}"`));
  const branches = new Set(facts.branches.map(b => b.name));
  const themes = cap(arr(read.roadmap?.themes).filter(t => t?.title), 6, 'roadmap themes');
  const item = (t, i) => {
    const x = { ...i };
    for (const k of ['status', 'state']) if (k in x) { problems.push(`roadmap "${x.title}": a typed ${k} (${JSON.stringify(x[k])}) is never drafted (claims only): dropped`); delete x[k]; }
    x.links = arr(i.links).map(String).filter(l => {
      const k = l.slice(0, l.indexOf(':')), id = l.slice(l.indexOf(':') + 1);
      const ok = k === 'branch' ? branches.has(id) : k === 'doc' ? !!lines(id) : false;
      if (!ok) problems.push(`roadmap "${x.title}": link ${l} dropped (${linkWhy(k)})`);
      return ok;
    });
    const srcs = arr(i.sources).map(String), good = srcs.filter(s => resolve(s));
    if (srcs.length > good.length) problems.push(`roadmap "${x.title}": source(s) ${srcs.filter(s => !good.includes(s)).join(', ')} do not resolve`);
    x.sources = good;
    if (!good.length && !x.links.some(l => l.startsWith('branch:'))) { x.unverified = true; problems.push(`roadmap "${x.title}": no source or branch backs it: unverified, off`); }
    return x;
  };
  out.roadmap = { themes: themes.map(t => ({ ...t, items: arr(t.items).filter(i => {
    if (i?.title) return true;
    problems.push(`roadmap "${t.title}": an item with no title dropped`);
    return false;
  }).map(i => item(t, i)) })) };
  out.first_tasks = cap(arr(read.first_tasks).filter(f => f && typeof f.task === 'string' && f.task.trim()), 3, 'first tasks');
  out.questions = cap(arr(read.questions).filter(q => q?.text), 3, 'questions');
  out.unsure = arr(read.unsure).map(String);
  return { read: out, problems };
}

/**
 * A checked read -> a draft { source, parts, summary, goals, questions, unsure, problems } of the same six parts as draftFacts (so review
 * and apply are one path). The profile and the instructions stay the engine's; the scan's commands stay the baseline; a part the read
 * left empty falls back to the facts. Lines on record are `already`, as in draftFacts.
 */
export function draftRead(facts, { read, problems = [] }, { answers = {}, existing = {}, run } = {}) {
  const base = draftFacts(facts, { answers, existing }), P = id => base.parts.find(p => p.id === id);
  const ex = { items: [], rules: null, gate: null, lanes: [], ...existing }, inRules = t => !!ex.rules && ex.rules.includes(t);
  const parts = [];
  const put = (id, lines) => parts.push(lines.length ? { ...P(id), lines, empty: undefined } : P(id));
  put('profile', []);
  const cmds = [...P('commands').lines];
  for (const c of read.commands || []) {
    if (cmds.some(l => l.text === c.cmd)) continue;
    let id = c.id;
    for (let k = 2; cmds.some(l => l.id === id); k++) id = `${c.id}${k}`;
    cmds.push({ id, text: c.cmd, source: String(c.source ?? 'the read'), ...(c.unverified ? { unverified: true } : {}),
      ...((id === 'test' ? ex.gate === c.cmd : inRules('`' + c.cmd + '`')) ? { already: true } : {}) });
  }
  put('commands', cmds);
  const rules = (read.rules || []).map(r => ({ text: r.text.trim(), source: String(r.source ?? 'the read'), ...(r.unverified ? { unverified: true } : {}) }));
  if (rules.length && answers.never) rules.push({ text: `Never: ${answers.never}`, source: 'your answer (never)' });
  // a monorepo project: the facts draft's folder rule leads the read's rules too
  const own = facts.subdir ? P('rules').lines.find(l => l.source === `project.json subdir ${facts.subdir}`) : null;
  if (own && !rules.some(r => r.text === own.text)) rules.unshift({ text: own.text, source: own.source });
  put('rules', rules.map((r, i) => ({ id: 'u' + (i + 1), ...r, ...(inRules(r.text) ? { already: true } : {}) })));
  put('instructions', []);
  const road = [];
  for (const t of read.roadmap?.themes || []) for (const it of t.items) {
    const src = it.sources?.[0], m = src ? /^(?:\.\/)?(.+?):(\d+)/.exec(src) : null;
    const claim = it.claim ? String(it.claim).trim().toUpperCase().slice(0, 40) : null;
    const title = String(it.title).trim().slice(0, 200), stages = arr(it.stages).map(s => String(s).slice(0, 120)).slice(0, 10);
    const l = { id: 'r' + (road.length + 1), text: title, source: src || (it.links[0] ? `git ${it.links[0]}` : 'the read'), theme: String(t.title).slice(0, 200),
      ...(['now', 'next', 'later'].includes(it.horizon) ? { horizon: it.horizon } : {}), ...(it.note ? { note: String(it.note).slice(0, 4000) } : {}),
      links: it.links, ...(stages.length ? { stages } : {}),
      ...(claim ? { legacy: { word: claim, text: title, line: m ? Number(m[2]) : null, file: m ? m[1] : null } } : {}),
      ...(it.unverified ? { unverified: true } : {}) };
    if (itemMatch(ex.items, l)) l.already = true;
    road.push(l);
  }
  put('roadmap', road);
  const first = [];
  const itemOf = title => road.find(l => l.text === String(title ?? '').trim())?.id;
  if (answers.first) first.push({ text: answers.first, source: 'your answer (first)' });
  for (const f of read.first_tasks || []) {
    const it = itemOf(f.item);
    first.push({ text: f.task.trim().slice(0, 400), source: String(f.source ?? (it ? road.find(l => l.id === it).source : 'the read')), ...(it ? { item: it } : {}) });
  }
  put('first', first.slice(0, 3).map((f, i) => ({ id: 'f' + (i + 1), ...f, ...(ex.lanes.includes(laneNameOf(f.text)) ? { already: true } : {}) })));
  for (const p of parts) if (p.empty === undefined) delete p.empty;
  return { source: run || 'read', parts, ...(read.summary ? { summary: String(read.summary).slice(0, 1000) } : {}), goals: read.goals || [],
    questions: read.questions || [], unsure: read.unsure || [], problems };
}

export const READ_CAP_MIN = 15;
const BUILTIN_EXECUTORS = ['claude', 'codex-sol', 'codex-astra'];
/** the read's executor when none is named: the project's planning class (policy.executors.planning); an agent name there runs on claude */
export function readExecutor(project) {
  const pl = withDefaults({ policy: project?.policy }).policy.executors.planning || {};
  const named = Object.hasOwn(project?.executors || {}, pl.executor) || BUILTIN_EXECUTORS.includes(pl.executor);
  return { executor: named ? pl.executor : 'claude', ...(pl.model ? { model: pl.model } : {}), ...(pl.effort ? { effort: pl.effort } : {}) };
}
/** who sees the file text the read sends (the consent line) */
export function readProvider(executor, provider) {
  if (executor === 'fake') return 'nobody (the fake executor sends nothing)';
  if (provider) { try { return new URL(provider.base_url).host; } catch { return `the provider of ${provider.preset || executor}`; } }
  return /^codex/.test(executor) ? 'OpenAI' : 'Anthropic';
}
export const consentLine = ({ executor, model, provider }) =>
  `the read is one read-only run of ${executor}${model ? ` (${model})` : ''}, capped at ${READ_CAP_MIN} min, costing one run of tokens (GUESS 40-120k on a small repo, `
  + `150-400k on a large one); file text goes to ${readProvider(executor, provider)}. Choose --read to start it, or --no-read for the free facts-only draft (no model)`;

const projectSnap = p => ({ name: p.name, file: p.file, project_dir: p.project_dir, root: p.root, ...(p.merge ? { merge: p.merge } : {}) });
/**
 * Start the read: open (or reuse) the proposal, write the brief (ADOPT.md + the scan) beside it, start ONE read-only run on lane adopt
 * in the repo (a helper with no parent: no worktree lock, no write tools), capped at READ_CAP_MIN. The run's end ingests its final
 * (supervisor -> ingestRead). launch = the startRun options of the executor (state, locksDir, executor, model, budget, ...).
 * -> { id, run, brief, out, attempt }
 */
export function readStart(stateDir, { project, by, answers = {}, launch, attempt = 1, retry } = {}) {
  if (!launch?.executor) throw new AdoptError('the read needs an executor');
  const { p, facts } = openFor(stateDir, { project, by, answers });
  const dir = path.join(stateDir, 'adopt', p.id);
  const k = fs.readdirSync(dir).filter(f => /^read-\d+\.md$/.test(f)).length + 1;
  const brief = path.join(dir, `read-${k}.md`), out = path.join(dir, `read-${k}.out.md`), ff = path.join(dir, `read-${k}.facts.json`);
  fs.writeFileSync(ff, JSON.stringify(facts, null, 1) + '\n');
  fs.writeFileSync(brief, readBrief(facts, { ...p.answers, ...answers }, { retry }));
  const capMs = launch.capMs ?? READ_CAP_MIN * 60000;
  const r = startRun({ ...launch, lane: 'adopt', brief, notes: out, worktree: project.root, role: 'helper', readonly: true, lock: false, via: 'adopt',
    q: `${p.id} read ${attempt}`, budgetMin: Math.ceil(capMs / 60000), capMs, tick: null,
    policy: { ...(launch.policy || {}), auto_resume_handoff: false, trigger_on_exit: false },
    adopt: { id: p.id, attempt, facts: rel(stateDir, ff), project: projectSnap(project), by, launch } });
  return { id: p.id, run: r.run, brief, out, attempt };
}

/**
 * At the read's end (the supervisor, beside onRunDone): its final -> parseRead -> checkDraft -> draftRead -> a draft event by the
 * launcher (source RUN-n). An answer that is not one JSON object gets ONE retry run (its brief says why); a second failure, or the time
 * cap, records the facts-only draft with the reason. A proposal no longer open gets nothing.
 * -> { ev: draft | retry | fallback | skipped, id, run?, why? }
 */
export function ingestRead(stateDir, spec, { capped = false } = {}) {
  const a = spec.adopt, p = proposalOf(stateDir, a.id);
  if (!p || p.state !== 'open') return { ev: 'skipped', id: a.id, why: p ? `${p.id} is ${p.state}` : 'no such proposal' };
  const facts = readJson(stateDir, a.facts || p.facts_file), project = a.project || null;
  const existing = existingOf(stateDir, project), attempt = a.attempt || 1;
  let read = null, why;
  if (capped) why = `the read hit its time cap (${Math.round((spec.capMs || READ_CAP_MIN * 60000) / 60000)} min)`;
  else { try { read = parseRead(fs.readFileSync(spec.notes, 'utf8')); } catch (e) { why = e.code === 'ENOENT' ? 'the run left no answer' : e.message; } }
  if (read) {
    const d = draftRead(facts, checkDraft(read, facts), { answers: p.answers, existing, run: spec.run });
    writeDraft(stateDir, p, d, facts, { by: 'launcher', run: spec.run });
    return { ev: 'draft', id: p.id, run: spec.run };
  }
  if (!capped && attempt < 2 && a.launch && project) {
    try {
      const r = readStart(stateDir, { project, by: a.by, launch: a.launch, attempt: attempt + 1, retry: why });
      return { ev: 'retry', id: p.id, run: r.run, why };
    } catch (e) { why += `; the retry did not start: ${e.message}`; }   // a full cap / a refused start: the facts-only draft, never a hang
  }
  const d = draftFacts(facts, { answers: p.answers, existing });
  d.note = `the read gave no valid draft${attempt > 1 ? ` in ${attempt} runs` : ''} (${why}): this is the facts-only draft`;
  writeDraft(stateDir, p, d, facts, { by: 'launcher', run: spec.run });
  return { ev: 'fallback', id: p.id, run: spec.run, why };
}

/** block until the read `run` of proposal `id` (or its retry) has been ingested -> { source (RUN-n | facts) | null (still running), run } */
export function readWait(stateDir, { id, run, maxS = READ_CAP_MIN * 120, pollMs = 200 } = {}) {
  const end = performance.now() + maxS * 1000;
  for (let cur = run; ;) {
    const it = fold(readEvents(recordsFile(stateDir, 'proposal'))).items[id];
    const d = it?.history.findLast(h => h.ev === 'draft' && h.data.run === cur);
    if (d) return { source: d.data.source, run: cur };
    if (!it || it.state !== 'open') return { source: null, run: cur, why: `${id} is ${it?.state ?? 'gone'}` };
    const runs = Object.values(fold(readEvents(recordsFile(stateDir, 'run'))).items);
    const n = Number(/ read (\d+)$/.exec(runs.find(r => r.id === cur)?.data.q || '')?.[1] || 0);
    const next = runs.find(r => r.data.lane === 'adopt' && r.data.q === `${id} read ${n + 1}`);
    if (next) { cur = next.id; continue; }
    if (performance.now() >= end) return { source: null, run: cur };
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
}

/** the proposal as text (norn adopt show): one row per part, then its lines ([x] on, [ ] off, [=] already there) with their source */
export function renderProposal(p, { part } = {}) {
  if (!p) return ['no proposal yet: norn adopt draft --no-read'];
  const d = p.draft || {};
  const o = [`${p.id} ${p.state} - ${p.path}: ${p.why}${p.draft ? ` (draft ${d.n} from ${/^RUN-/.test(d.source) ? 'the read ' + d.source : 'the facts'})` : ''}`];
  if (d.note) o.push(`  note: ${d.note}`);
  if (d.summary) o.push(`  summary: ${d.summary}`);
  for (const g of d.goals || []) o.push(`  goal: ${g.text}  (${g.source})`);
  for (const x of d.problems || []) o.push(`  checked: ${x}`);
  for (const x of p.parts.filter(y => !part || y.id === part)) {
    o.push(`  ${x.id.padEnd(13)} ${x.applied ? 'applied' : x.status}${x.pick ? ' (pick one)' : ''} - ${x.lines.length} line(s)${x.empty ? ': ' + x.empty : ''}`);
    // a pick part not yet decided has no line on: [x] on all of them read as "all picked" (SHIP-READY R1)
    const off = x.pick && !x.decision ? x.lines.map(l => l.id) : x.decision?.off || [], on = x.decision?.on || [];
    for (const l of x.lines) o.push(`    ${l.id.padEnd(8)} [${l.already ? '=' : off.includes(l.id) || (l.unverified && !on.includes(l.id)) ? ' ' : 'x'}] ${l.text}  (${l.source})${l.theme ? ` [${[l.theme, l.horizon, ...(l.links || []), l.legacy?.word ? 'claims ' + l.legacy.word : null].filter(Boolean).join(', ')}]` : ''}${l.unverified ? ' - unverified' : ''}${l.default ? ' - default' : ''}`);
  }
  for (const q of d.questions || []) o.push(`  question ${q.id}: ${q.text}${q.options?.length ? ` (${q.options.join(' / ')})` : ''}`);
  for (const u of d.unsure || []) o.push(`  unsure: ${u}`);
  if (p.state === 'open') o.push(p.undecided.length ? `to review: ${p.undecided.join(', ')} (norn adopt approve | skip <part>)` : 'every part is decided: norn adopt apply');
  return o;
}
