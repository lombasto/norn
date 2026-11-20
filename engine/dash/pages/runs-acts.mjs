// The Runs page's handlers (moved verbatim from index.html, stage NAV): data-act -> fn(el, c), dispatched by index.html's one registry
// (see pages/lanes-acts.mjs for c).
const P = f => (b, c) => f(b.dataset, c);
export const acts = {
  'runs-show': P((d, { S, runsRepaint }) => { const s = S.runsView[d.group]; if (s.has(d.show)) s.delete(d.show); else s.add(d.show); runsRepaint(); }),
  'runs-window': P((d, { S, render, tabUrl }) => { S.runsView.window = d.window; history.replaceState(null, '', tabUrl()); render(); }),
};
