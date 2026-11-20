// The Runs page's handlers: data-act -> fn(el, c), dispatched by index.html's one registry (see pages/lanes-acts.mjs for c).
// The filters, the legend and the folded check-ins repaint from the last data; the run screen (narrow) goes back to the list with
// the focus on the run it showed; Follow opens the next run of a hand-off; Copy link copies the run URL.
const P = f => (b, c) => f(b.dataset, c);
const flip = k => P((d, { S, runsRepaint }) => { S.runsView[k] = !S.runsView[k]; runsRepaint(); });
export const acts = {
  'runs-show': P((d, { S, runsRepaint }) => { const s = S.runsView[d.group]; if (s.has(d.show)) s.delete(d.show); else s.add(d.show); runsRepaint(); }),
  'runs-window': P((d, { S, render, tabUrl }) => { S.runsView.window = d.window; history.replaceState(null, '', tabUrl()); render(); }),
  'runs-filters': flip('open'),
  'runs-help': flip('help'),
  'runs-checkins': flip('ck'),
  'runs-back': P(async (d, { S, render, tabUrl }) => { S.run = null; history.pushState(null, '', tabUrl()); await render(); document.getElementById(`node-${d.run}`)?.focus(); }),
  'run-open': P((d, { S, render, tabUrl }) => { S.run = d.run; history.pushState(null, '', tabUrl()); render(); }),
  'run-link': (b, { S, tabUrl }) => { const run = S.run; S.run = b.dataset.run; const u = new URL(tabUrl(), location.href).href; S.run = run;
    Promise.resolve(navigator.clipboard?.writeText(u)).then(() => { b.textContent = 'Copied'; }, () => { b.textContent = 'Copy failed'; }); },
};
