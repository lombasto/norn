// Render-on-change scheduling and the motion policy (DEC-683, CONCEPTS "Kept rules"): the dash costs ~nothing when nothing
// changes. No free-running timer or requestAnimationFrame loop: a frame / refetch happens only after a poke (a stream event,
// a click), coalesced; a hidden tab defers it until visible (one catch-up render); QUIET holds a static frame; the user's
// prefers-reduced-motion means no travel / motes. Pure (timers and visibility are injected) so node tests drive it.

// may anything move? (the root gets class "motion" only when this is true; every animation in norn.css is scoped under it)
export const motionAllowed = ({ quiet = false, reduced = false, hidden = false } = {}) => !quiet && !reduced && !hidden;

/**
 * createScheduler({ render, hidden, coalesceMs = 120, setTimer, clearTimer }) -> { poke(reason), visible(), drop(), stats() }
 * render: async () => void (one refetch + paint); hidden: () => bool. poke() during a render queues exactly one more. drop(): a direct
 * render (a click) refetches everything after the waiting pokes arrived, so they are covered: no second strip / page fetch behind it.
 */
export function createScheduler({ render, hidden = () => false, coalesceMs = 120, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null, busy = false, again = false, deferred = false, renders = 0;
  const reasons = new Set();
  async function run() {
    timer = null;
    if (hidden()) { deferred = true; return; }
    if (busy) { again = true; return; }
    busy = true; renders++; const why = [...reasons]; reasons.clear();
    try { await render(why); } finally {
      busy = false;
      if (again) { again = false; poke('again'); }
    }
  }
  function poke(reason = 'change') {
    reasons.add(reason);
    if (hidden()) { deferred = true; return; }
    if (timer !== null) return;
    timer = setTimer(run, coalesceMs);
  }
  // the tab became visible: render once if anything arrived while hidden
  function visible() { if (deferred) { deferred = false; poke('visible'); } }
  function drop() { if (timer !== null) { clearTimer(timer); timer = null; } reasons.clear(); }
  return { poke, visible, drop, stats: () => ({ renders, pending: timer !== null || deferred, busy }) };
}
