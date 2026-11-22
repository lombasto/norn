// A project can be one folder of a git repo (a monorepo): project.json `subdir` names that folder, relative to `root` (the repo's
// top level). Several projects can then share one repo, each with its own rules, roadmap, gate and lanes:
// - norn project new / norn init given a folder below the top level set root = the top level and subdir = that folder;
// - the adopt scan and read look only at files and commits under subdir;
// - the merge gate (and the DoD gate job) runs from <tree>/<subdir>;
// - a run whose brief names no Scope: is kept inside subdir by the scope guard (on by default for such a project);
// - lanes branch as norn/<project>/<lane>, so two projects on one repo never share a branch;
// - the merge queue's scratch worktree is per project (<repo>-mq-<project>).
// A leaf module: git and path only.
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const fwd = p => String(p).replace(/\\/g, '/');

export class SubdirError extends Error {}

/** a subdir as stored: repo-relative, forward slashes, no leading ./ or trailing /; '' = the repo itself. Throws on .. or an absolute path. */
export function normSubdir(s) {
  if (s === undefined || s === null) return '';
  const t = fwd(String(s).trim()).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (t === '' || t === '.') return '';
  if (path.isAbsolute(t) || /^[A-Za-z]:/.test(t) || t.split('/').some(x => x === '..' || x === '')) throw new SubdirError(`subdir ${JSON.stringify(s)}: a folder inside the repo, relative to its top level (no .., not absolute)`);
  return t;
}

/** the project's subdir ('' when it is the whole repo); a bad one throws (config refuses it at load) */
export const subdirOf = p => normSubdir(p?.subdir);

/**
 * dir (inside a git work tree) -> { root: the repo's top level, subdir: dir relative to it ('' at the top) }, or null when not a git
 * repo. root is dir with the prefix's segments walked up, not git's --show-toplevel: that one is the long form of a path given in
 * its Windows 8.3 short form (or through a symlink), and the root stays the spelling the caller gave.
 */
export function splitRepo(dir) {
  const abs = path.resolve(dir);
  const r = spawnSync('git', ['-C', abs, 'rev-parse', '--show-prefix'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (r.status !== 0) return null;
  const subdir = normSubdir((r.stdout || '').replace(/\r\n/g, '\n').split('\n')[0]);
  const up = subdir ? subdir.split('/').length : 0;
  let root = abs;
  for (let i = 0; i < up; i++) root = path.dirname(root);
  return { root: fwd(root), subdir };
}

/** the folder a project is about: root, or root/subdir */
export const projectHome = p => fwd(path.join(path.resolve(p.root), subdirOf(p)));

/** the folder a command runs in inside a tree (a lane worktree, the merge scratch, the main checkout) for a gate with dir */
export const inDir = (tree, dir) => (dir ? path.join(tree, normSubdir(dir)) : tree);

/** how a gate reads in a brief: `cmd`, or `cd <dir> && cmd` when it runs from a subdir */
export const gateText = gate => (gate?.dir ? `cd ${normSubdir(gate.dir)} && ${gate.cmd}` : gate?.cmd);
