// META-OOTB F-1: creating a lane creates its worktree and branch. `norn lane new <name> [--task "<text>"]` and the dashboard's
// first-task box both land here: the worktree goes where the project's lane_defaults.worktree says (the same path `norn run` uses),
// on branch norn/<lane> from the project root repo's HEAD (an existing branch is checked out, never reset); the LANE record
// carries worktree / branch / notes. With a task: an owner DIRECTIVE scoped to the lane + the lane's first brief
// (<briefs_dir>/<lane>.md, never overwritten). Idempotent: an existing record, worktree or brief is kept and reported.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { expandLate } from './config.mjs';
import { record, recordAsync, loadState } from './records.mjs';
import { runSteps, runStepsAsync } from './steps.mjs';
import { subdirOf } from './monorepo.mjs';

export class LaneError extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }
export const LANE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// a project that is one folder of a monorepo (project.subdir) branches as norn/<project>/<lane>: projects sharing a repo never share a branch
export const laneBranch = (name, p) => (p && subdirOf(p) ? `norn/${p.name}/${name}` : `norn/${name}`);
const fwd = p => String(p).replace(/\\/g, '/');

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim() };
}
const gitA = (cwd, args) => new Promise(ok => execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 }, (e, out, err) =>
  ok({ ok: !e, out: String(out || '').trim(), err: String(err || e?.message || '').trim() })));
const fp = fs.promises;
const SYNC_IO = { git, exists: f => fs.existsSync(f), mkdir: d => fs.mkdirSync(d, { recursive: true }), state: s => (fs.existsSync(s) ? loadState(s) : { items: {} }),
  record: (s, ev, o) => record(s, ev, o), create: (f, t) => fs.writeFileSync(f, t, { flag: 'wx' }) };
const ASYNC_IO = { git: gitA, exists: f => fp.access(f).then(() => true, () => false), mkdir: d => fp.mkdir(d, { recursive: true }),
  state: async s => ((await ASYNC_IO.exists(s)) ? loadState(s) : { items: {} }), record: (s, ev, o) => recordAsync(s, ev, o), create: (f, t) => fp.writeFile(f, t, { flag: 'wx' }) };

/** Where lane `name` of project p lives: { worktree, notes, branch, brief } (absolute paths; brief = <briefs_dir>/<name>.md). */
export function lanePaths(p, name) {
  if (!LANE_RE.test(name || '')) throw new LaneError(`lane name ${JSON.stringify(name)}: letters, digits, _ . - (starting with a letter or digit)`);
  const late = s => (s ? path.resolve(expandLate(s, { lane: name })) : null);
  const worktree = late(p.lane_defaults?.worktree);
  if (!worktree) throw new LaneError(`${p.name} has no lane_defaults.worktree in its project.json: add one (e.g. "\${state}/wt/\${lane}")`);
  return { worktree, notes: late(p.lane_defaults?.notes), branch: laneBranch(name, p), brief: path.join(path.resolve(p.briefs_dir || path.join(p.state, 'briefs')), `${name}.md`) };
}

/**
 * newLane(p, { name, task, by, views }) -> { lane, created, worktree, worktree_created, branch, base, notes, directive, brief, brief_created }.
 * p = a loaded project (root, state, lane_defaults, briefs_dir, views). by = the role recording the lane (owner | dashboard | controller | checkin);
 * the directive is always the owner's (by owner, or dashboard when the dashboard acts for the owner).
 */
export const newLane = (p, o) => runSteps(laneSteps(p, o), SYNC_IO);
/** newLane for the dash server (first-task box, adopt apply): the same steps, git as an async child, the writes on fs.promises */
export const newLaneAsync = (p, o) => runStepsAsync(laneSteps(p, o), ASYNC_IO);
/** the lane steps and their two io (adopt apply yields them inside its own steps) */
export const LANE_IO = { sync: SYNC_IO, async: ASYNC_IO };
export function* laneSteps(p, { name, task, by = 'owner', now } = {}) {
  const at = lanePaths(p, name);
  const taskText = typeof task === 'string' ? task.trim() : '';
  if (task !== undefined && !taskText) throw new LaneError('--task is empty: say what the lane should do');
  if (!p.root || !(yield ['git', p.root, ['rev-parse', '--is-inside-work-tree']]).ok) throw new LaneError(`${p.name}: root ${fwd(p.root)} is not a git repo`);
  const views = p.views || undefined, opts = { ...(views ? { views } : {}), ...(now ? { now } : {}) };
  // 1. the worktree + branch (kept when the path exists: one writer per tree, never a reset)
  let worktree_created = false, base = null;
  if (!(yield ['exists', at.worktree])) {
    base = (yield ['git', p.root, ['rev-parse', '--abbrev-ref', 'HEAD']]).out || 'HEAD';
    const has = (yield ['git', p.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${at.branch}`]]).ok;
    yield ['mkdir', path.dirname(at.worktree)];
    const r = yield ['git', p.root, has ? ['worktree', 'add', at.worktree, at.branch] : ['worktree', 'add', '-b', at.branch, at.worktree]];
    if (!r.ok) throw new LaneError(`git worktree add ${fwd(at.worktree)} (${at.branch}) failed: ${r.err.split(/\r?\n/)[0]}`, 1);
    worktree_created = true;
    if (has) base = null;
  }
  if (at.notes) yield ['mkdir', path.dirname(at.notes)];   // the notes file's folder (the worker appends to it)
  // 2. the LANE record (kept when it exists)
  const id = `L:${name}`, st = yield ['state', p.state];
  let created = false;
  if (!st.items[id]) {
    yield ['record', p.state, { kind: 'lane', ev: 'create', by, data: { name, worktree: fwd(at.worktree), branch: at.branch, ...(at.notes ? { notes: fwd(at.notes) } : {}) } }, opts];
    created = true;
  }
  // 3. the task: an owner directive scoped to the lane + the lane's first brief
  let directive = null, brief_created = false;
  if (taskText) {
    const owner = by === 'dashboard' ? 'dashboard' : 'owner';
    directive = (yield ['record', p.state, { kind: 'directive', ev: 'create', by: owner, data: { text: taskText, scope: [name], via: by === 'dashboard' ? 'dashboard' : 'cli' } }, opts]).id;
    if (!(yield ['exists', at.brief])) {
      yield ['mkdir', path.dirname(at.brief)];
      yield ['create', at.brief, `# ${name}\n\n${taskText}\n\nWork in your worktree on branch ${at.branch}. ${at.notes ? `Write your notes to ${fwd(at.notes)}. ` : ''}End with \`norn done\` (or \`norn done --outcome stopped --why "<why>"\` / \`--outcome handoff --handoff-file F\`).\n`];
      brief_created = true;
    }
  }
  return { lane: id, created, worktree: fwd(at.worktree), worktree_created, branch: at.branch, base, notes: at.notes ? fwd(at.notes) : null, directive, brief: fwd(at.brief), brief_created: taskText ? brief_created : false };
}
