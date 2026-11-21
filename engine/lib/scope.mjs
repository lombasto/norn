// META-DOD 2 (owner DIR-68): what a claude run may touch, enforced while it runs. Claude Code docs read 2026-11-14
// (code.claude.com/docs/en/permissions, permission-modes, hooks; CLI 2.1.314): deny rules block in every mode, bypassPermissions
// included, but a Bash rule matches the command text only (`git -C . push --force` slips past `Bash(git push --force*)`);
// permissions.blockWritesOutsideWorkingDirectories makes Write / Edit / NotebookEdit refuse paths outside the working directories in
// every mode; a PreToolUse hook sees the whole call first and its `deny` + permissionDecisionReason reaches the model as the reason.
// So a guarded run gets, in its one --settings: the deny rules (the fixed spellings: a backstop if the hook itself is gone), the
// write block, and this file's hook `norn scope check` for the rest: Scope narrowing, any spelling of a refused command and every
// cwd-dependent rule. Every refusal is recorded (<state>/scope/refusals.jsonl): the run's feed and the Slop list read it.
// TEST-GOVERNANCE S1 (DIR-23, owner Q-26 / Q-28) + test-diet S1: the same hook applies policy.tests (testpolicy.mjs testsCheck) in every
// claude run - a worker, a MERGE, a check-in, a resumed run whose hand-off says "then one full suite": no full suite, no test past the
// run's test budget, no browser test, node tests through `norn tests run`. A run whose project has the scope guard off still gets the
// hook for those checks (guardSettings) unless policy.tests leaves nothing to check (testsFree). The full suite runs in CI (GitHub) and
// `norn tests measure`, neither of which is a claude run, so no run kind needs an exemption.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readText } from './fsnap.mjs';
import { spawnSync } from 'node:child_process';
import { parseReady, inScope } from './ready.mjs';
import { feedFiles, oneLine } from './harness/common.mjs';
import { hookEntry } from './hookbin.mjs';
import { isTest } from './testcmd.mjs';
import { testsPolicy, testsFree, testsCheck, readTestMs } from './testpolicy.mjs';
import { specPolicy } from './ctxlimit.mjs';

export const SCOPE_TOOLS = 'Bash|PowerShell|Edit|Write|NotebookEdit';
/** a refusal stays in the Slop list this long: the Slop trend window (guardView days) */
export const REFUSAL_DAYS = 30;
const WIN = process.platform === 'win32';
const fwd = p => String(p).replace(/\\/g, '/');
// a path's identity for every comparison here: Windows paths are case-insensitive (README.md and readme.md are one file), so BOTH
// sides fold there - the run's paths (norm) and the brief's Scope entries (fold); POSIX keeps case (they are two files)
const fold = s => WIN ? s.toLowerCase() : s;
const norm = p => fold(fwd(path.resolve(p)).replace(/\/+$/, ''));
const under = (p, root) => p === root || p.startsWith(root + '/');
// a check-in works in the main checkout and may push main; a MERGE stage opens a PR (norn merge-land) and a lane run never pushes main
const mayPushMain = spec => spec.kind === 'checkin';

export const refusalsFile = state => path.join(state, 'scope', 'refusals.jsonl');
/** the PreToolUse hook: norn-hook, which passes the calls this file surely allows and hands the rest to `norn scope check` */
export const scopeHook = state => hookEntry('scope', state);
/** the hook of a run whose executor runs Claude Code hooks (the claude family; a write run with a state dir), else undefined */
export function scopeHookOf(o) {
  return o.state && o.mode !== 'read-only' && o.mode !== 'no-tools' && o.readonly !== true ? scopeHook(o.state) : undefined;
}

/** ROUND 2: the project switch policy.dod.scope (off | on, default off) - off = a run gets no scope part at all */
export const scopeOn = policy => policy?.dod?.scope === 'on';
/** scopeOn for one run: a monorepo project's run (o.subdir) is guarded unless policy.dod.scope says off */
export const scopeOnFor = (policy, o = {}) => scopeOn(policy) || (!!o.subdir && policy?.dod?.scope !== 'off');

const RULES = ['git push --force*', 'git push -f*', 'git push * --force*', 'git push * -f*', 'git push --mirror*', 'git push * --mirror*', 'gh repo edit*', 'gh repo delete*'];
const MAIN_RULES = ['git push * main', 'git push * master', 'git push * main *', 'git push * master *', 'git push *:main*', 'git push *:master*', 'git push *refs/heads/main*', 'git push *refs/heads/master*'];
/** the --settings part of a guarded run: deny rules (Bash + PowerShell spellings), the write block, the PreToolUse hook */
export function scopeSettings(spec, hook) {
  const rules = [...RULES, ...(mayPushMain(spec) ? [] : MAIN_RULES)];
  return { permissions: { deny: ['Bash', 'PowerShell'].flatMap(t => rules.map(r => `${t}(${r})`)), blockWritesOutsideWorkingDirectories: true },
    hooks: { PreToolUse: [{ matcher: SCOPE_TOOLS, hooks: [hook] }] } };
}
/** the guard part of a run's --settings from its project's CURRENT policy: the whole scope guard (scopeOnFor), else the hook alone for
 *  policy.tests (shell tools only) unless it leaves nothing to check, else undefined */
export function guardSettings(policy, spec, hook) {
  if (scopeOnFor(policy, spec)) return scopeSettings(spec, hook);
  return testsFree(testsPolicy(policy)) ? undefined : { hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [hook] }] } };
}
/** a shell call against policy.tests (testpolicy.mjs testsCheck) -> the refusal reason, else null. The run's test time is read from
 *  its transcript (the payload's transcript_path) only for a test command under a budget. */
export function testsHook(p, policy, worktree) {
  const t = p?.tool_name, cmd = p?.tool_input?.command;
  if ((t !== 'Bash' && t !== 'PowerShell') || typeof cmd !== 'string') return null;
  const tp = testsPolicy(policy);
  return testsCheck(cmd, tp, { testMs: tp.run_budget_min > 0 && isTest(cmd) ? readTestMs(p.transcript_path) : null, cwd: p.cwd || worktree || '.' });
}
/** the working directories a guarded run gets beyond its worktree and addDirs: the NOTES folder (its shots sit there too) */
export const notesDir = spec => (spec.notes ? path.dirname(path.resolve(spec.notes)) : null);

/** what one run may touch: { worktree, roots (normalised: worktree, addDirs, NOTES folder), scope (the brief's Scope: or []), pushMain }.
 *  A brief that cannot be read throws: its Scope is unknown, never "no Scope" (scopeCheck refuses with the reason) */
export function scopeOf(spec) {
  const text = spec.brief && spec.brief !== '-' ? fs.readFileSync(spec.brief, 'utf8') : null;
  const free = [...(spec.addDirs || []), ...(notesDir(spec) ? [notesDir(spec)] : [])].map(norm);
  // a monorepo project's run (spec.subdir) whose brief names no Scope: stays inside the project's folder
  const scope = parseReady(text).scope, own = scope.length ? scope : spec.subdir ? [spec.subdir] : [];
  return { worktree: norm(spec.worktree), free, scope: own, pushMain: mayPushMain(spec), shown: [spec.worktree, ...(spec.addDirs || []), ...(notesDir(spec) ? [notesDir(spec)] : [])].map(fwd) };
}

// hook-fast S1: what norn-hook needs to pass a call without Node (<state>/runs/<run>.scope.json, written at launch beside the spec):
// scopeOf's paths normalised and folded as checkFile compares them, the Scope entries as inScope reads them, and the brief's mtime -
// scopeOf reads the brief at every call, so a brief edited since launch makes norn-hook hand every file call to Node
export const scopeFile = (state, run) => path.join(state, 'runs', `${run}.scope.json`);
// test-diet S1: tests_free = policy.tests at launch leaves nothing to check on a test command, so norn-hook passes those without Node
export function writeScopeFile(state, run, spec) {
  const c = scopeOf(spec), brief = spec.brief && spec.brief !== '-' ? path.resolve(spec.brief) : null;
  let ms = null;
  try { ms = brief ? String(Math.floor(fs.statSync(brief).mtimeMs)) : null; } catch { ms = null; }
  fs.writeFileSync(scopeFile(state, run), JSON.stringify({ worktree: c.worktree, free: c.free, scope: c.scope.map(x => fold(fwd(x).replace(/^\.\//, '').replace(/\/+$/, ''))), brief, brief_ms: ms,
    tests_free: testsFree(testsPolicy(spec.ctx_from ? specPolicy(spec) : null)) }));
}

// ---------- paths ----------
/** a shell word as a path: ~ / $HOME / $VAR / $env:VAR expanded from the hook's environment (Claude Code's own); null = cannot tell */
function expand(word, env) {
  let unknown = false;
  const v = String(word).replace(/^~(?=$|[\\/])/, () => os.homedir())
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b, c) => {
      const k = a || b || c, x = env[k] ?? (WIN ? Object.entries(env).find(([n]) => n.toUpperCase() === k.toUpperCase())?.[1] : undefined);
      if (x === undefined || x === '') unknown = true;
      return x ?? '';
    });
  if (unknown || /[`$]/.test(v)) return null;
  // Git Bash spellings on Windows: /c/x = C:/x, /tmp = the temp dir
  if (WIN) { const d = v.match(/^\/([a-zA-Z])(\/.*)?$/); if (d) return `${d[1]}:${d[2] || '/'}`; if (/^\/tmp(\/|$)/.test(v)) return path.join(os.tmpdir(), v.slice(4)); }
  return v;
}
const at = (cwd, word, env) => { const v = expand(word, env); if (v === null || cwd === null) return null; const g = v.search(/[*?[]/); return norm(path.resolve(cwd, g >= 0 ? v.slice(0, g) || '.' : v)); };

// ---------- the file tools ----------
function checkFile(file, cwd, c) {
  const abs = path.resolve(cwd || c.worktree, file), p = norm(abs);
  if (c.free.some(r => under(p, r))) return null;
  if (!under(p, c.worktree)) return `${fwd(file)} is outside this run's working directories (${c.shown.join(', ')}): write inside the worktree, or put the need in your NOTES`;
  const rel = fwd(abs).slice(c.worktree.length + 1);   // as written (the message); the match folds both sides
  if (c.scope.length && !inScope(fold(rel), c.scope.map(fold))) return `${rel} is outside the brief's Scope (${c.scope.join(', ')}): stay inside Scope, or say in your NOTES why the file must change`;
  return null;
}

// ---------- the shell: words, segments, wrappers ----------
/** a command line -> segments (arrays of words) split at && || ; | & and newlines; quotes kept out of the words */
export function segments(cmd) {
  const out = [];
  let seg = [], w = '', has = false, q = null;
  const word = () => { if (has) seg.push(w); w = ''; has = false; };
  const cut = () => { word(); if (seg.length) out.push(seg); seg = []; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) { if (ch === q) q = null; else if (ch === '\\' && q === '"' && /["\\$`]/.test(cmd[i + 1] ?? '')) w += cmd[++i]; else w += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (ch === '\\' && !WIN && i + 1 < cmd.length) { w += cmd[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (ch === '\n') cut(); else word(); continue; }
    if (ch === ';' || ch === '|' || ch === '&') { if (ch === '&' && /[0-9>]$/.test(w) ) { w += ch; continue; } cut(); if (cmd[i + 1] === ch) i++; continue; }
    w += ch; has = true;
  }
  cut();
  return out;
}
const WRAP = new Set(['sudo', 'command', 'nohup', 'time', 'exec', 'env', 'builtin', 'xargs', 'nice']);
const SHELLS = /^(sh|bash|zsh|dash|powershell|pwsh)(\.exe)?$/i;
const base = w => path.basename(fwd(w)).replace(/\.exe$/i, '').toLowerCase();

/** one shell command line -> the first refusal reason, or null */
function checkShell(cmd, cwd0, c, env, depth = 0) {
  let cwd = cwd0 ? path.resolve(cwd0) : null;
  for (let ws of segments(String(cmd))) {
    while (ws.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0]) || WRAP.has(base(ws[0])))) ws = ws.slice(1);
    if (!ws.length) continue;
    const name = base(ws[0]);
    if (['cd', 'pushd', 'set-location', 'sl', 'chdir'].includes(name)) {
      const d = ws.slice(1).find(x => !x.startsWith('-'));
      const v = d === undefined ? os.homedir() : expand(d, env);
      cwd = v === null || cwd === null ? null : path.resolve(cwd, v);
      continue;
    }
    if (SHELLS.test(name) && depth < 4) {
      const i = ws.findIndex((x, k) => k > 0 && /^-(c|command)$/i.test(x));
      if (i > 0 && ws[i + 1] !== undefined) { const r = checkShell(ws.slice(i + 1).join(' '), cwd, c, env, depth + 1); if (r) return r; }
      continue;
    }
    const r = name === 'git' ? checkGit(ws.slice(1), cwd, c, env) : name === 'gh' ? checkGh(ws.slice(1))
      : ['rm', 'remove-item', 'ri', 'del', 'erase', 'rmdir', 'rd'].includes(name) ? checkRm(ws, cwd, c, env) : null;
    if (r) return r;
  }
  return null;
}

const where = (cwd, c) => (cwd === null ? 'a directory Norn cannot tell' : norm(cwd) === c.worktree || under(norm(cwd), c.worktree) ? null : fwd(cwd));
function checkGit(a, cwd, c, env) {
  let dir = cwd, i = 0;
  for (; i < a.length && a[i].startsWith('-'); i++) {
    const o = a[i];
    if (o === '-C') { const v = expand(a[++i] ?? '', env); dir = v === null || dir === null ? null : path.resolve(dir, v); }
    else if (o === '-c' || o === '--git-dir' || o === '--namespace') i++;
    else if (o.startsWith('--work-tree=')) { const v = expand(o.slice(12), env); dir = v === null || dir === null ? null : path.resolve(dir, v); }
    else if (o === '--work-tree') { const v = expand(a[++i] ?? '', env); dir = v === null || dir === null ? null : path.resolve(dir, v); }
  }
  const sub = a[i], args = a.slice(i + 1), flags = args.filter(x => x.startsWith('-')), short = flags.filter(x => /^-[^-]/.test(x)).join('');
  const off = where(dir, c);
  if (sub === 'push') {
    if (flags.some(f => /^--(force|force-with-lease|force-if-includes)(=|$)/.test(f)) || /f/.test(short.replace(/-/g, ''))) return 'a force push rewrites the remote branch: push without --force (merge or rebase locally, then a plain push)';
    if (flags.includes('--mirror')) return 'git push --mirror overwrites every remote ref (a force push): push your own branch';
    const pos = args.filter(x => !x.startsWith('-')).slice(1);   // the remote, then the refspecs
    if (pos.some(r => r.startsWith('+'))) return `a +refspec (${pos.find(r => r.startsWith('+'))}) is a force push: push without the +`;
    if (flags.includes('--delete') || /d/.test(short.replace(/-/g, '')) || pos.some(r => r.startsWith(':'))) return 'deleting a remote branch is the owner\'s call: leave it, and name it in your NOTES';
    if (!c.pushMain) {
      if (flags.includes('--all') || flags.includes('--branches')) return 'git push --all pushes every branch, main too: push your own branch only';
      const dst = pos.map(r => r.split(':').pop().replace(/^refs\/heads\//, ''));
      if (dst.some(b => b === 'main' || b === 'master')) return `a push to ${dst.find(b => b === 'main' || b === 'master')} is the merge's job: push your feat/* branch`;
      if (!pos.length && dir !== null) {
        const b = spawnSync('git', ['-C', dir, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).stdout?.trim();
        if (b === 'main' || b === 'master') return `this checkout is on ${b}: a bare git push pushes ${b}, the merge's job - push your feat/* branch`;
      }
    }
    return null;
  }
  if (sub === 'reset' && args.includes('--hard') && off) return `git reset --hard in ${off} is outside this run's worktree ${fwd(c.worktree)}: reset only your own worktree`;
  if (sub === 'clean' && (flags.includes('--force') || /f/.test(short)) && off) return `git clean -f in ${off} is outside this run's worktree ${fwd(c.worktree)}: clean only your own worktree`;
  if (sub === 'branch' && (flags.includes('--delete') || /[dD]/.test(short.replace(/^-/, '')))) {
    if (off) return `deleting a branch from ${off} is outside this run's worktree ${fwd(c.worktree)}: delete only your own temporary branches, from your worktree`;
    const hit = args.filter(x => !x.startsWith('-')).find(b => b === 'main' || b === 'master');
    if (hit) return `deleting ${hit} is the owner's call: leave it`;
  }
  if (sub === 'worktree' && args[0] === 'remove') {
    const t = args.slice(1).find(x => !x.startsWith('-')), p = t === undefined ? null : at(dir, t, env);
    if (p !== c.worktree) return `git worktree remove ${t ?? ''} is not this run's worktree ${fwd(c.worktree)}: removing another worktree is the owner's call`;
  }
  return null;
}
function checkGh(a) {
  if (a[0] === 'repo' && (a[1] === 'edit' || a[1] === 'delete')) return `gh repo ${a[1]} changes the repository itself (settings, visibility, existence): the owner's call`;
  if (a[0] === 'api') {
    const m = a.findIndex(x => x === '-X' || x === '--method'), method = m >= 0 ? String(a[m + 1]).toUpperCase() : (a.find(x => /^--method=/.test(x))?.slice(9).toUpperCase() ?? null);
    if (a.some(x => /visibility/i.test(x))) return 'gh api with visibility changes the repository\'s visibility: the owner\'s call';
    if (method === 'DELETE' && a.some(x => /(^|\/)repos\/[^/]+\/[^/]+\/?$/.test(x))) return 'gh api DELETE on a repository deletes it: the owner\'s call';
  }
  return null;
}
function checkRm(ws, cwd, c, env) {
  const ps = !['rm', 'rmdir'].includes(base(ws[0])) || ws.some(x => /^-(recurse|force|path|literalpath)$/i.test(x));
  const flags = ws.slice(1).filter(x => x.startsWith('-')), rec = ps ? flags.some(x => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(x))
    : flags.some(x => x === '--recursive' || (/^-[^-]/.test(x) && /r/i.test(x)));
  if (!rec) return null;
  const targets = [];
  for (let i = 1; i < ws.length; i++) {
    if (ps && /^-(path|literalpath)$/i.test(ws[i])) { targets.push(ws[++i]); continue; }
    if (!ws[i].startsWith('-')) targets.push(ws[i]);
  }
  const ok = [c.worktree, ...c.free];
  for (const t of targets) {
    for (const one of ps ? t.split(',') : [t]) {
      const p = at(cwd, one, env);
      if (p === null) return `rm -r ${one}: Norn cannot tell where that is (an unknown variable or directory): write the path out`;
      if (!ok.some(r => under(p, r))) return `rm -r ${one} is outside this run's working directories (${c.shown.join(', ')}): delete only inside your worktree`;
    }
  }
  return null;
}

/** one PreToolUse payload { tool_name, tool_input, cwd } against scopeOf(spec) -> the refusal reason, or null */
export function checkTool(p, c, env = process.env) {
  const t = p?.tool_name, i = p?.tool_input || {};
  if (t === 'Edit' || t === 'Write' || t === 'NotebookEdit') { const f = i.file_path ?? i.notebook_path; return f ? checkFile(f, p.cwd, c) : null; }
  if (t === 'Bash' || t === 'PowerShell') return typeof i.command === 'string' ? checkShell(i.command, p.cwd || c.worktree, c, env) : null;
  return null;
}

// ---------- the hook, the record, the readers ----------
const readSpec = (state, run) => JSON.parse(fs.readFileSync(path.join(state, 'runs', run + '.spec.json'), 'utf8'));
/** norn scope check: payload -> { deny: reason | null }; a refusal is appended to refusals.jsonl. A spec or brief that cannot be read refuses
 * (the guard fails closed): the run then has no known worktree to keep it in. The project's CURRENT policy (spec.ctx_from) says
 * which test rules (policy.tests) and whether the scope guard apply; a spec with no project file gets the test defaults and the guard. */
export function scopeCheck({ state, run, payload, env = process.env }) {
  let why, spec = null;
  try {
    spec = readSpec(state, run);
    const pol = spec.ctx_from ? specPolicy(spec) : null;
    why = testsHook(payload, pol, spec.worktree) ?? (pol === null || scopeOnFor(pol, spec) ? checkTool(payload, scopeOf(spec), env) : null);
  }
  catch (e) {
    const what = !spec ? 'spec' : e.path && spec.brief && path.resolve(e.path) === path.resolve(spec.brief) ? 'brief' : 'brief or policy';
    why = `Norn's scope hook cannot read this run's ${what} (${what === 'spec' ? run : fwd(e.path || run)}: ${e.code || e.message}), so it cannot tell what you may touch: end with \`norn done --outcome stopped --why "scope hook cannot read the run ${what}"\``;
  }
  if (!why) return { deny: null };
  const tool = String(payload?.tool_name ?? '?'), target = oneLine(payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path ?? payload?.tool_input?.command ?? '', 200);
  fs.mkdirSync(path.dirname(refusalsFile(state)), { recursive: true });
  fs.appendFileSync(refusalsFile(state), JSON.stringify({ at: new Date().toISOString(), run, lane: spec?.lane ?? null, tool, target, why }) + '\n');
  return { deny: `Norn refused this ${tool} call: ${why}.` };
}
export const denyJson = reason => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

/** every recorded refusal (oldest first); since = ms: only those at or after it */
export function refusals(state, { since = 0 } = {}) {
  const text = readText(refusalsFile(state)) ?? '';   // META-DASH-ASYNC R1: snapshot-aware (lib/fsnap.mjs)
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && Date.parse(r.at) >= since);
}
/** the run feed's refusal events (kind error, no tool id: a line of its own), incremental by the cursor key `scope` (a Promise: fs.promises) */
export function refusalFeed(state, run, cursor) {
  return feedFiles([['scope', refusalsFile(state)]], cursor, text => { const r = JSON.parse(text); return r.run === run ? [{ ts: r.at, kind: 'error', name: r.tool, summary: oneLine(`refused by Norn: ${r.why}`) }] : []; });
}
/** an adapter's feed poll { events, cursor } (or its promise) + the run's refusals; each event's `at` carries both cursor keys */
export async function withRefusals(r0, state, run, cur) {
  const r = await r0, f = await refusalFeed(state, run, { ...(cur || {}), ...r.cursor }), keep = cur?.scope !== undefined ? { scope: cur.scope } : {};
  return { ...r, events: [...r.events.map(e => ({ ...e, at: { ...keep, ...e.at } })), ...f.events], cursor: { ...r.cursor, ...f.cursor } };
}
