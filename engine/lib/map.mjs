// A run's status chip: the one piece left of the retired Map page, read by the lane board (lanes.mjs).

/** run -> [chip class, word] (status = text + colour) */
export function runWord(r) {
  if (r.state === 'running') return ['running', 'running'];
  if (r.state === 'lost') return ['lost', 'lost'];
  if (r.state === 'killed') return ['bad', 'killed'];
  const o = r.end?.outcome;
  return { done: ['done', 'DONE'], stopped: ['stopped', 'STOPPED'], handoff: ['handoff', 'HANDOFF'], crash: ['bad', 'crash'] }[o] ?? ['no-result', o ?? 'no-result'];
}
