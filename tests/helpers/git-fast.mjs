// RM-26 S3 (lean suite): synthetic git histories without a git spawn per step (Windows: ~230 ms per spawn under suite load,
// git-template.mjs). The empty repo is a copy of one `git init` per process (fromTemplate) whose config already holds the identity
// (t <t@t>) and, when asked, core.autocrlf false - written into the template's config file, no `git config` spawns. The commits go in
// as one `git fast-import` stream, then one `git reset --hard` fills the index and the worktree: 2 spawns for any history.
// Every commit is by t <t@t>; a ref is a branch name or a full ref.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fromTemplate } from './git-template.mjs';

const git = (cwd, args, input) => { const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`); return r.stdout; };
const ref = r => (r.startsWith('refs/') ? r : `refs/heads/${r}`);
// fast-import's path syntax: a path with a quote, a backslash, a newline or a leading space goes C-quoted
const quote = p => (/["\\\n]|^\s/.test(p) ? JSON.stringify(p) : p);

/** dest (made if missing) as an empty repo on main, user t <t@t>; autocrlf: false writes core.autocrlf false */
export function emptyRepo(dest, { autocrlf } = {}) {
  const lf = autocrlf === false;
  fromTemplate(`git-fast-init${lf ? '-lf' : ''}`, root => {
    git(root, ['init', '-q', '-b', 'main']);
    fs.appendFileSync(path.join(root, '.git', 'config'), `[user]\n\temail = t@t\n\tname = t\n${lf ? '[core]\n\tautocrlf = false\n' : ''}`);
  }, dest);
  return dest;
}

/** the commits, in order, into repo as one fast-import stream. A commit: { ref, msg, files: { path: text }, from, merge: [..], deleteall,
 *  at }; from / merge name a parent by its index in commits (or a ref); no from on a ref's first commit is a root commit; the tree starts
 *  from the first parent's (deleteall: empty). at: epoch seconds (default: one second apart, the last now). Returns the commit SHAs. */
export function fastImport(repo, commits) {
  const now = Math.floor(Date.now() / 1000), parts = [], marks = path.join(repo, '.git', 'fast-marks');
  const par = p => (typeof p === 'number' ? `:${p + 1}` : ref(p));
  commits.forEach((c, i) => {
    const when = `${c.at ?? now - commits.length + 1 + i} +0000`, msg = Buffer.from(`${c.msg}\n`);
    parts.push(`commit ${ref(c.ref)}\nmark :${i + 1}\nauthor t <t@t> ${when}\ncommitter t <t@t> ${when}\ndata ${msg.length}\n`, msg, '\n');
    if (c.from !== undefined) parts.push(`from ${par(c.from)}\n`);
    for (const m of c.merge || []) parts.push(`merge ${par(m)}\n`);
    if (c.deleteall) parts.push('deleteall\n');
    for (const [f, text] of Object.entries(c.files || {})) { const b = Buffer.from(text); parts.push(`M 100644 inline ${quote(f)}\ndata ${b.length}\n`, b, '\n'); }
    parts.push('\n');
  });
  git(repo, ['fast-import', '--quiet', `--export-marks=${marks.split(path.sep).join('/')}`], Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p) : p))));
  const sha = Object.fromEntries(fs.readFileSync(marks, 'utf8').trim().split('\n').map(l => l.split(' ')));
  fs.rmSync(marks);
  return commits.map((_, i) => sha[`:${i + 1}`]);
}

/** emptyRepo + fastImport + HEAD on head with its index and worktree: a repo as if built commit by commit. Returns the commit SHAs. */
export function fastRepo(dest, commits, { head = 'main', autocrlf } = {}) {
  emptyRepo(dest, { autocrlf });
  const shas = fastImport(dest, commits);
  fs.writeFileSync(path.join(dest, '.git', 'HEAD'), `ref: ${ref(head)}\n`);
  git(dest, ['-c', 'core.autocrlf=false', 'reset', '-q', '--hard']);   // the worktree holds the bytes as given, as a test's own writes did
  return shas;
}
