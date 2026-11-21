// RM-44 stage B (audit section 4, row "Admin merge / direct push"): an admin merge or a direct push to main cannot be stopped from
// here, so it is detected. A first-parent landing on main is CHECKED when a stored check (checks.jsonl) names its head: the merged
// branch's tip (a merge's second parent) or the landing itself. Every other landing is "landed unchecked" and is checked now, its
// own diff (first parent..landing), without the machine rules (they read today's machine, not that landing). The daily lists them.
import { gitRun, slopCheck } from './check.mjs';
import { slopChecks } from './host.mjs';
import { projectSlop, mainTip } from './runend.mjs';
import { makeTool } from './tools.mjs';

/**
 * landedUnchecked({ repo, state, to (main's sha), since (a sha: only landings after it; null = since the first stored check, the
 * day checks began to be stored), own ({ subdir }: a monorepo project's own landings), rules (default: the project's, projectSlop), tool, projectDir })
 * -> [{ sha, subject, at, findings (the new ones of every level) }], oldest first.
 */
export function landedUnchecked({ repo, state, main = 'main', remote = 'origin', to = mainTip(repo, { main, remote }), since = null, own = null,
  projectDir = null, rules = null, tool = makeTool() }) {
  const checks = slopChecks(state);
  if (!to || (!since && !checks.length)) return [];
  const from = since ? null : Date.parse(checks[0].at), heads = new Set(checks.map(c => c.head));
  const log = gitRun(repo, ['log', '--first-parent', '--reverse', '--format=%H%x00%P%x00%cI%x00%s', since ? `${since}..${to}` : to, ...(own ? ['--', own.subdir] : [])]);
  const ps = projectSlop({ state, projectDir });
  return log.split('\n').filter(Boolean).map(l => { const [sha, parents, at, subject] = l.split('\0'); return { sha, parents: parents.split(' ').filter(Boolean), at, subject }; })
    .filter(c => c.parents.length && (from === null || Date.parse(c.at) > from) && !heads.has(c.sha) && !c.parents.slice(1).some(p => heads.has(p)))
    .map(c => {
      const r = slopCheck({ repo, base: c.parents[0], head: c.sha, rules: rules || ps.rules, tool, resolve: ps.resolve, machine: false });
      return { sha: c.sha, subject: c.subject, at: c.at, findings: r.findings.filter(f => f.new && !f.shadow) };
    });
}

const count = (l, level) => l.findings.filter(f => f.level === level).length;
/** the digest words of one landing: "1 BLOCK, 2 WARN" | "clean" */
export const landedWords = (l, { full = false } = {}) => {
  const b = count(l, 'BLOCK'), w = count(l, 'WARN');
  return !b && !w ? 'clean' : full ? `${b} BLOCK, ${w} WARN` : [b && `${b} BLOCK`, w && `${w} WARN`].filter(Boolean).join(', ');
};
