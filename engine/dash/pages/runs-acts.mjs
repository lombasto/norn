// The Runs page's handlers: data-act -> fn(el, c), dispatched by index.html's one registry (see pages/lanes-acts.mjs for c).
// The chips and the folded check-ins repaint from the last data; Close shuts the run drawer (the focus back on its row); Follow
// opens the next run of a hand-off; Copy link copies the run URL.
const P = f => (b, c) => f(b.dataset, c);
/** close the run drawer: drop the &run= (a URL step, so Back reopens it) and give the focus back to the run's row */
export async function runsClose({ S, render, tabUrl }) {
  const run = S.run; S.run = null; history.pushState(null, '', tabUrl()); await render(); document.getElementById(`node-${run}`)?.focus();
}
export const acts = {
  'runs-show': P((d, { S, runsRepaint }) => { const s = S.runsView[d.group]; if (s.has(d.show)) s.delete(d.show); else s.add(d.show); runsRepaint(); }),
  'runs-window': P((d, { S, render, tabUrl }) => { S.runsView.window = d.window; history.replaceState(null, '', tabUrl()); render(); }),
  'runs-checkins': P((d, { S, runsRepaint }) => { S.runsView.ck = !S.runsView.ck; runsRepaint(); }),
  'runs-close': (b, c) => runsClose(c),
  'run-open': P((d, { S, render, tabUrl }) => { S.run = d.run; history.pushState(null, '', tabUrl()); render(); }),
  'run-link': (b, { S, tabUrl }) => { const run = S.run; S.run = b.dataset.run; const u = new URL(tabUrl(), location.href).href; S.run = run;
    Promise.resolve(navigator.clipboard?.writeText(u)).then(() => { b.textContent = 'Copied'; }, () => { b.textContent = 'Copy failed'; }); },
};
