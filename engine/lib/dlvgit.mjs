// Git facts for deliverables (the Norn project's design/DELIVERABLES-SPEC.md 1): branch tips, merged / installed sets, commits behind main,
// native-touching paths. Read-only git, batched: a warm scan is ONE `for-each-ref`; everything else is cached by commit ids
// (merged sets by main sha, behind counts by tip + main, native paths by tip). Node built-ins only; no records import.
import { boundedSync } from './jobguard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// proc-hygiene: every call is bounded (GIT_TIMEOUT_MS) and its timeout kills the whole tree (jobguard boundedSync), never a lone
// git.exe orphaned under Git's cmd launcher
export const GIT_TIMEOUT_MS = 120000;
// exec wrapper that counts calls (the cost gate); null on a non-zero exit when allowFail; status: { code, out } whatever the exit
// (merge-tree exits 1 on a conflict with its answer on stdout); env: extra variables for this call; input: stdin for this call
export function makeGit(exec = null) {
  const run = exec || ((repo, args, env, input) => {
    const r = boundedSync('git', ['-C', repo, ...args], { timeout: GIT_TIMEOUT_MS, input, maxBuffer: 64 << 20, ...(env ? { env: { ...process.env, ...env } } : {}) });
    if (r.error || r.status !== 0) throw Object.assign(r.error || new Error(`git ${args[0]} exited ${r.status}: ${String(r.stderr || '').trim().slice(0, 200)}`), { status: r.status, stdout: r.stdout, stderr: r.stderr });
    return r.stdout;
  });
  const git = (repo, args, { allowFail = false, status = false, env = null, input = undefined } = {}) => {
    git.calls++;
    try { const out = input === undefined ? run(repo, args, env) : run(repo, args, env, input); return status ? { code: 0, out } : out; } catch (e) {
      if (status && typeof e.status === 'number') return { code: e.status, out: String(e.stdout ?? '') };
      if (allowFail) return null;
      throw e;
    }
  };
  git.calls = 0;
  return git;
}

// repo-relative path globs: ** = any number of directories, * = inside one segment, ? = one character
export function globToRe(glob) {
  let re = '';
  const s = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' && s[i + 1] === '*') { i++; if (s[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const branchRe = globs => globs.map(globToRe);

/**
 * scanRepo(repo, { main, remote, cache, git, native, installed, history }) -> { mainSha, refs, branches(globs), tipOf(branch), info(branch, fallbackTip), onBase(commit, base),
 *   rehearse(tip), rehearseMany(tips) (one merge-tree for every uncached tip; then rehearse() reads the cache), installed, history }
 * cache: a plain object (persisted by the caller), mutated in place. native: path globs (null = unknown). installed: commit ids.
 * history: commit-ish of EARLIER main lines (a repo whose main was restarted, e.g. moved to a new repo without its old history): a
 * tip on one of them counts as merged, as on main.
 */
export function scanRepo(repo, { main = 'main', remote = 'origin', cache = {}, git = makeGit(), native = null, installed = [], history = [] } = {}) {
  // ENGINE-GIT (DEC-88): the one listing also carries every ref's ahead / behind against main (`%(ahead-behind:<main>)`, git 2.41;
  // one commit walk for all refs): merged-on-main is ahead == 0 and the behind counts need no rev-list per branch. main is the local
  // branch, else the remote's (scanRepo's order); a repo with neither lists without the counts (they are then asked per tip below).
  const list = mainRef => git(repo, ['for-each-ref', `--format=%(objectname)%09%(refname)%09%(committerdate:unix)%09${mainRef ? `%(ahead-behind:${mainRef})` : '-'}%09%(subject)`,
    'refs/heads', `refs/remotes/${remote}`], { allowFail: !!mainRef });
  let mainRef = 'refs/heads/' + main, raw = list(mainRef);
  if (raw === null) { mainRef = `refs/remotes/${remote}/${main}`; raw = list(mainRef); }
  if (raw === null) { mainRef = null; raw = list(null) || ''; }
  const refs = new Map(), ab = new Map();
  for (const l of raw.split('\n')) {
    if (!l) continue;
    const [sha, ref, date, abs, ...subj] = l.split('\t');
    refs.set(ref, { sha, date: Number(date) * 1000, subject: subj.join('\t') });
    if (mainRef) { const [ahead, behind] = abs.split(' ').map(Number); ab.set(sha, [behind, ahead]); }
  }
  const mainSha = refs.get('refs/heads/' + main)?.sha || refs.get(`refs/remotes/${remote}/${main}`)?.sha || null;
  const c = cache;
  c.merged ||= {}; c.counts ||= {}; c.native ||= {}; c.anc ||= {}; c.full ||= {}; c.rehearse ||= {};
  const allShas = [...new Set([...refs.values()].map(r => r.sha))];
  if (mainRef && mainSha) {
    c.merged[mainSha] = { seen: allShas, on: allShas.filter(s => ab.get(s)[1] === 0) };
    for (const [s, n] of ab) if (n[1] > 0) c.counts[`${s}:${mainSha}`] = n;
  }
  // one batched `for-each-ref --merged=<base>` answers "is this ref's tip on <base>" for every ref; re-run only when a tip is new
  const mergedSet = base => {
    let e = c.merged[base];
    if (!e || allShas.some(s => !e.seen.includes(s))) {
      const out = git(repo, ['for-each-ref', `--merged=${base}`, '--format=%(objectname)', 'refs/heads', `refs/remotes/${remote}`], { allowFail: true });
      e = c.merged[base] = { seen: allShas, on: out === null ? [] : [...new Set(out.split('\n').filter(Boolean))] };
    }
    return e;
  };
  const onBase = (tip, base) => {
    if (!tip || !base) return false;
    if (allShas.includes(tip)) return mergedSet(base).on.includes(tip);
    const k = `${tip}:${base}`;   // a tip that is no ref any more (branch deleted): one is-ancestor, cached
    if (!(k in c.anc)) c.anc[k] = git(repo, ['merge-base', '--is-ancestor', tip, base], { allowFail: true }) !== null;
    return c.anc[k];
  };
  // receipts carry short ids: resolve once (immutable), cache
  const full = id => {
    if (!id) return null;
    if (!(id in c.full)) c.full[id] = (git(repo, ['rev-parse', '--verify', '--quiet', id + '^{commit}'], { allowFail: true }) || '').trim() || null;
    return c.full[id];
  };
  const inst = installed.map(full).filter(Boolean), hist = history.map(full).filter(Boolean);
  const tipOf = branch => refs.get(`refs/remotes/${remote}/${branch}`)?.sha || refs.get('refs/heads/' + branch)?.sha || null;
  const nativeRe = native ? native.map(globToRe) : null;
  const info = (branch, fallbackTip = null) => {
    const ref = refs.get(`refs/remotes/${remote}/${branch}`) || refs.get('refs/heads/' + branch) || null;
    const tip = ref?.sha || fallbackTip || null;
    const merged = onBase(tip, mainSha) || hist.some(h => onBase(tip, h));
    const installedHit = inst.some(s => onBase(tip, s));
    const r = { branch, tip, ref_date: ref?.date ?? null, subject: ref?.subject ?? null, exists: !!ref, merged, installed: installedHit, behind: null, ahead: null, native: null, native_files: [] };
    if (tip && mainSha && !merged) {
      const k = `${tip}:${mainSha}`;
      if (!c.counts[k]) {
        const out = git(repo, ['rev-list', '--left-right', '--count', `${mainSha}...${tip}`], { allowFail: true });
        c.counts[k] = out ? out.trim().split(/\s+/).map(Number) : [null, null];
      }
      [r.behind, r.ahead] = c.counts[k];
    } else if (merged) { r.ahead = 0; }
    if (nativeRe && tip && mainSha) {
      if (!(tip in c.native)) {
        const out = merged ? null : git(repo, ['diff', '--name-only', `${mainSha}...${tip}`], { allowFail: true });
        c.native[tip] = out === null ? null : out.split('\n').filter(Boolean);
      }
      const files = c.native[tip];
      if (files) { r.native_files = files.filter(f => nativeRe.some(re => re.test(f))).slice(0, 5); r.native = r.native_files.length > 0; }
    }
    return r;
  };
  // merge rehearsal (META-DLV-R2): `git merge-tree --write-tree main <tip>` -> { clean, files (the conflicting paths) } | null (git
  // failed). Cached by the (tip, main) pair. Its tree / blob objects go to a throw-away object dir (the repo's objects are only read
  // through GIT_ALTERNATE_OBJECT_DIRECTORIES), so the rehearsal leaves the repo's object store as it was.
  // -z: the conflicting paths come NUL-separated and unquoted (the real path, also for names core.quotePath would quote).
  const odb = () => (c.odb ||= path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'objects']).trim()));
  const scratchEnv = fn => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-dlv-mt-'));
    try { return fn({ GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: odb() }); } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  };
  const rehearse = tip => {
    if (!tip || !mainSha) return null;
    const k = `${tip}:${mainSha}`;
    if (!(k in c.rehearse)) {
      try {
        const r = scratchEnv(env => git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', mainSha, tip], { status: true, env }));
        c.rehearse[k] = r.code === 0 ? { clean: true, files: [] } : r.code === 1 ? { clean: false, files: [...new Set(r.out.split('\0').slice(1).filter(Boolean))] } : null;
      } catch { c.rehearse[k] = null; }
    }
    return c.rehearse[k];
  };
  // ENGINE-GIT (DEC-88): every uncached (main, tip) pair in ONE `merge-tree --stdin` (git 2.40): per merge "<1 clean | 0 conflict>\0<tree>\0
  // [<path>\0...]\0". A pair git cannot merge (a tip that is gone) fails the whole run: nothing is cached and rehearse() asks each alone.
  const rehearseMany = tips => {
    if (!mainSha) return;
    const todo = [...new Set(tips.filter(t => t && !(`${t}:${mainSha}` in c.rehearse)))];
    if (todo.length < 2) return;   // one pair: rehearse() is the same one spawn
    let r;
    try { r = scratchEnv(env => git(repo, ['merge-tree', '--stdin', '--write-tree', '--name-only', '--no-messages'], { status: true, env, input: todo.map(t => `${mainSha} ${t}\n`).join('') })); } catch { return; }
    if (r.code !== 0) return;
    const parts = r.out.split('\0'), got = {};
    let i = 0;
    for (const t of todo) {
      const st = parts[i++], tree = parts[i++], files = [];
      if ((st !== '0' && st !== '1') || !tree) return;   // not the documented shape: cache nothing
      while (i < parts.length && parts[i] !== '') files.push(parts[i++]);
      i++;
      got[`${t}:${mainSha}`] = st === '1' ? { clean: true, files: [] } : { clean: false, files: [...new Set(files)] };
    }
    Object.assign(c.rehearse, got);
  };
  const branches = globs => {
    const res = branchRe(globs), pre = `refs/remotes/${remote}/`;
    return [...refs.keys()].filter(k => k.startsWith(pre)).map(k => k.slice(pre.length)).filter(b => res.some(re => re.test(b))).sort();
  };
  return { mainSha, refs, branches, tipOf, info, onBase, rehearse, rehearseMany, installed: inst, history: hist };
}

// keep the cache small: merged sets of the current main + installed / history bases, behind counts of the current main, native by live tips
export function pruneCache(c, { mainSha, keepBases = [], tips = [] }) {
  const keep = new Set([mainSha, ...keepBases].filter(Boolean));
  for (const k of Object.keys(c.merged || {})) if (!keep.has(k)) delete c.merged[k];
  for (const k of Object.keys(c.counts || {})) if (!k.endsWith(':' + mainSha)) delete c.counts[k];
  for (const k of Object.keys(c.rehearse || {})) if (!k.endsWith(':' + mainSha)) delete c.rehearse[k];
  for (const k of Object.keys(c.work || {})) if (k.split(':')[1] !== mainSha) delete c.work[k];   // META-DLV-LANDED workOnMain answers
  const live = new Set(tips);
  for (const k of Object.keys(c.native || {})) if (!live.has(k)) delete c.native[k];
  for (const k of Object.keys(c.hist || {})) if (!live.has(k.split(':')[0])) delete c.hist[k];   // workOnMain answers against deliverables.history lines
  for (const k of Object.keys(c.anc || {})) if (!keep.has(k.split(':')[1])) delete c.anc[k];
  for (const k of Object.keys(c.equiv || {})) if (!keep.has(k.split(':')[1]) || !live.has(k.split(':')[0])) delete c.equiv[k];   // contentOnMain answers
  return c;
}

export function isAncestor(repo, tip, base, git = makeGit()) {
  return git(repo, ['merge-base', '--is-ancestor', tip, base], { allowFail: true }) !== null;
}
export function refTip(repo, branch, { remote = 'origin', git = makeGit() } = {}) {
  for (const r of [`refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`]) {
    const out = git(repo, ['rev-parse', '--verify', '--quiet', r], { allowFail: true });
    if (out && out.trim()) return out.trim();
  }
  return null;
}

/**
 * META-AUTONOMY R1 cause 1: is the WORK of `head` on main (local main, else origin's)? The one home of "merged" for run conditions.
 * Industry standard, as git itself decides it (git rebase / `git cherry` / `git log --cherry-pick` skip a commit whose patch is already
 * upstream; squash detection as git-trim / git-delete-merged-branches do it):
 *  1. head is an ancestor of main (a fast-forward or a merge commit);
 *  2. else every commit of merge-base..head has a patch-id equal to a commit on main (`git cherry`: all '-') - a rebase, a merge-queue
 *     rebase, a cherry-pick, a rebase + --no-ff merge;
 *  3. else the branch's WHOLE diff (one synthetic commit: head's tree on the merge-base, `git commit-tree`) has the patch-id of a commit
 *     on main - a squash merge;
 *  4. (META-DLV-LANDED) else head's tree IS its merge-base's tree: the branch adds nothing to main - merged, then the merge queue's update
 *     step merged main into it (a merge commit that no patch-id matches; DLV-45 11-13);
 *  5. else every commit of main..head is a merge and each one is CLEAN (its tree = git's own merge of its parents: no edits of its
 *     own) - the branch landed, then the merge queue merged main into it, and main has moved on since (so 4's trees differ).
 * A rebase that resolved a conflict changes that commit's patch: git cannot see it, so the condition is held for a ruling (norn runs
 * landed). Not used: "a merge commit naming the branch" (a branch name is reused across rounds - R1 / R2 of meta-plan - so it would
 * count an older round's merge).
 */
// rule 5: main..head holds merge commits only, each with exactly the tree git's merge of its two parents gives (no conflict, no edit)
function onlyCleanMerges(repo, head, base, git) {
  const own = git(repo, ['rev-list', '--no-merges', '--count', `${base}..${head}`], { allowFail: true });
  if (own === null || Number(own.trim()) !== 0) return false;
  const merges = String(git(repo, ['rev-list', '--merges', '--parents', `${base}..${head}`], { allowFail: true }) ?? '').split('\n').filter(Boolean);
  if (!merges.length) return false;
  return merges.every(l => {
    const [m, ...ps] = l.trim().split(/\s+/);
    if (ps.length !== 2) return false;   // an octopus: not judged
    const r = git(repo, ['merge-tree', '--write-tree', ps[0], ps[1]], { status: true });
    return r.code === 0 && r.out.split('\n')[0].trim() === git(repo, ['rev-parse', `${m}^{tree}`], { allowFail: true })?.trim();
  });
}

export function workOnMain(repo, head, main = 'main', { git = makeGit() } = {}) {
  const lines = out => String(out ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const base of [main, `refs/remotes/origin/${main}`]) {
    if (isAncestor(repo, head, base, git)) return true;
    if (onlyCleanMerges(repo, head, base, git)) return true;
    const mb = git(repo, ['merge-base', base, head], { allowFail: true })?.trim();
    if (!mb) continue;
    const tree = git(repo, ['rev-parse', `${head}^{tree}`], { allowFail: true })?.trim();
    if (tree && tree === git(repo, ['rev-parse', `${mb}^{tree}`], { allowFail: true })?.trim()) return true;
    const own = lines(git(repo, ['cherry', base, head, mb], { allowFail: true }));
    if (own.length && own.every(l => l.startsWith('-'))) return true;
    const synth = tree && git(repo, ['commit-tree', tree, '-p', mb, '-m', 'norn: the branch as one patch (squash check)'], { allowFail: true,
      env: { GIT_AUTHOR_NAME: 'norn', GIT_AUTHOR_EMAIL: 'norn@localhost', GIT_COMMITTER_NAME: 'norn', GIT_COMMITTER_EMAIL: 'norn@localhost' } })?.trim();
    const sq = synth ? lines(git(repo, ['cherry', base, synth, mb], { allowFail: true })) : [];
    if (sq.length === 1 && sq[0].startsWith('-')) return true;
  }
  return false;
}

/**
 * DLV-MERGED-TRUTH: is the deliverable's own CHANGE on main, whatever happened to its commits? For a landing git's rules above cannot
 * see: a rebase that resolved a conflict (new patch-ids), a squash of a branch that later took more commits, a hand landing.
 * The change = the diff merge-base(main, tip)..tip. It is on main when, for every file it touched, main's file equals the tip's, or
 * (a text file) every line it added is on main at least as many times as it added it (blank lines aside; line ends ignored). A file
 * the branch deleted must be gone from main; a binary file must equal main's.
 * -> { on: true | false, why } | { on: null, why } (cannot tell: the tip is gone from the repo)
 */
export function contentOnMain(repo, tip, main = 'main', { git = makeGit(), maxFiles = 200 } = {}) {
  const short = String(tip).slice(0, 9);
  if (git(repo, ['cat-file', '-e', `${tip}^{commit}`], { allowFail: true }) === null) return { on: null, why: `the tip ${short} recorded at DONE is gone from the repo` };
  const show = (rev, f) => git(repo, ['show', `${rev}:${f}`], { allowFail: true });
  const count = text => { const m = new Map(); for (const l of String(text).split('\n')) { const k = l.trimEnd(); if (k.trim()) m.set(k, (m.get(k) || 0) + 1); } return m; };
  let seen = false;
  for (const base of [main, `refs/remotes/origin/${main}`]) {
    const b = git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowFail: true })?.trim();
    const mb = b && git(repo, ['merge-base', b, tip], { allowFail: true })?.trim();
    if (!mb) continue;
    seen = true;
    const st = String(git(repo, ['diff', '--no-renames', '--name-status', '-z', mb, tip], { allowFail: true }) ?? '').split('\0').filter(Boolean);
    const touched = new Map();
    for (let i = 0; i + 1 < st.length; i += 2) touched.set(st[i + 1], st[i][0]);
    if (!touched.size) return { on: true, why: 'the branch changes nothing against main' };
    const differ = String(git(repo, ['diff', '--no-renames', '--name-only', '-z', b, tip, '--', ...touched.keys()], { allowFail: true }) ?? '').split('\0').filter(Boolean);
    if (differ.length > maxFiles) continue;
    const bin = new Set(String(git(repo, ['diff', '--no-renames', '--numstat', '-z', mb, tip], { allowFail: true }) ?? '').split('\0').filter(l => /^-\t-\t/.test(l)).map(l => l.slice(4)));
    const fileOn = f => {
      if (touched.get(f) === 'D' || bin.has(f)) return false;   // differs from main: the deletion / the binary is not there
      const onMain = show(b, f), atTip = show(tip, f);
      if (onMain === null || atTip === null) return false;
      const was = count(show(mb, f) ?? ''), now = count(atTip), have = count(onMain);
      for (const [l, n] of now) { const added = n - (was.get(l) || 0); if (added > 0 && (have.get(l) || 0) < added) return false; }
      return true;
    };
    if (differ.every(fileOn)) return { on: true, why: differ.length ? `every line it added is on ${base}` : `its files equal ${base}'s` };
  }
  return { on: false, why: seen ? 'its change is not on main' : 'it shares no history with main' };
}
