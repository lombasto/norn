// A project's merge settings (project.json `merge` over the defaults): their own module, below mergeq.mjs and mergeland.mjs, so
// merge-land can read them without importing the merge queue (mergeq -> landing -> mergeland -> mergeq was a K10 cycle).
import { deliverableConfig, fwd } from './deliverables.mjs';
import { subdirOf } from './monorepo.mjs';

const MQ_DEFAULTS = { batch_max: 4 };

/** project.json `merge` over the defaults: { gate {cmd, timeout_min, fast} | null, batch_max, scratch (the batch worktree), ui (path globs) } */
// a monorepo project (project.subdir): the gate runs from that folder (gate.dir, unless set) and the scratch is the project's own
export function mergeConfig(project = {}) {
  const m = project.merge || {}, d = deliverableConfig(project), sub = subdirOf(project);
  const gate = m.gate ? { ...m.gate, ...(m.gate.dir === undefined && sub ? { dir: sub } : {}) } : null;
  return { ...MQ_DEFAULTS, ...m, gate, ui: m.ui || [], scratch: fwd(m.scratch || (sub ? `${d.repo}-mq-${project.name}` : `${d.repo}-mq`)), repo: d.repo, main: d.main, remote: d.remote, native: d.native };
}
