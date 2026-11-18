// Gap #7: the shared monorepo fixture. One git repo, two sibling projects (apps/alpha = THE project, apps/beta = its neighbour),
// each with its own CLAUDE.md, code, tests and docs, plus the shared root chain (CLAUDE.md at the top and in apps/, the CI workflow).
// The neighbour is deliberately bigger and noisier, so a count or a list that leaks across the folder line shows. Every dir is mkTmp's.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkTmp } from './tmp.mjs';

export const SUB = 'apps/alpha', OTHER = 'apps/beta';
const fwd = p => String(p).split(path.sep).join('/');

/** the files of the fixture's first commit (repo-relative -> text) */
export const MONO_FILES = {
  'CLAUDE.md': '# Monorepo rules\nShared by every project.\n',
  'apps/CLAUDE.md': '# apps\nEvery app keeps its tests beside it.\n',
  '.github/workflows/ci.yml': 'name: ci\njobs:\n  test:\n    steps:\n      - run: eslint .\n',
  [`${SUB}/CLAUDE.md`]: '# alpha\nRun `tests/alpha.test.mjs` before a merge.\n',
  [`${SUB}/src/alpha.mjs`]: 'export const a = 1;\nexport const b = 2;\n',
  [`${SUB}/tests/alpha.test.mjs`]: "import test from 'node:test';\ntest('alpha', () => {});\n",
  [`${SUB}/docs/GUIDE.md`]: '# Alpha guide\n',
  [`${OTHER}/CLAUDE.md`]: '# beta\nNever touch alpha.\nRun `tests/beta.test.mjs` before a merge.\n',
  [`${OTHER}/src/beta.mjs`]: Array.from({ length: 40 }, (_, i) => `export const b${i} = ${i};`).join('\n') + '\n',
  [`${OTHER}/tests/beta.test.mjs`]: "import test from 'node:test';\ntest('beta 1', () => {});\ntest('beta 2', () => {});\ntest('beta 3', () => {});\n",
  [`${OTHER}/docs/BETA.md`]: '# Beta notes\n',
};

/**
 * monorepo(prefix) -> { root (the repo's top level), sub, other, home (alpha's folder), state (alpha's state dir), git(...args) (in root),
 * put(files) (write, repo-relative), commit(files, msg) (write + add + commit on the current branch -> sha), project(extra) (the project
 * object of alpha: name, root, subdir, state, ...extra), neighbour(extra) (beta's) }
 */
export function monorepo(prefix = 'meta-mono-') {
  const root = mkTmp(prefix, 'repo'), state = mkTmp(prefix + 'st-', 'alpha'), otherState = mkTmp(prefix + 'st-', 'beta');
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  const put = files => { for (const [rel, text] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); } };
  const commit = (files, msg = 'change') => { put(files); git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'mono@example.invalid'); git('config', 'user.name', 'mono'); git('config', 'core.autocrlf', 'false');
  commit(MONO_FILES, 'two projects');
  const project = (extra = {}) => ({ name: 'alpha', root: fwd(root), subdir: SUB, state, project_dir: fwd(path.join(state, '..', '..', 'proj-alpha')), ...extra });
  const neighbour = (extra = {}) => ({ name: 'beta', root: fwd(root), subdir: OTHER, state: otherState, ...extra });
  return { root: fwd(root), sub: SUB, other: OTHER, home: fwd(path.join(root, SUB)), state, git, put, commit, project, neighbour };
}
