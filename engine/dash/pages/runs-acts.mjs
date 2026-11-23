// The Runs page's handlers: data-act -> fn(el, c), dispatched by index.html's one registry (see pages/lanes-acts.mjs for c).
// The chips and the folded check-ins repaint from the last data; Close shuts the run drawer (the focus back on its row); a row (or
// Follow) opens a run on its Summary, a count on its Feed with that kind alone; the view buttons switch the drawer's view (a repaint:
// the feed section is remounted, never reopened); Copy link copies the run URL.
import { runView, openRunView } from './runs.mjs';
const P = f => (b, c) => f(b.dataset, c);
// a tap on a control inside a run-open row (a link, a button, the lane card) is that control's, not the row's
const inner = b => { const x = b.tagName === 'TR' && globalThis.event?.target?.closest?.('a,button,input,select,.lcard,details'); return !!x && x !== b && b.contains(x); };
// Enter / Space on a focused row opens it (index.html's key path covers data-feed rows only)
globalThis.document?.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('tr.rrow[data-act="run-open"]')) { e.preventDefault(); e.target.click(); } });
/** close the run drawer: drop the &run= (a URL step, so Back reopens it) and give the focus back to the run's row */
export async function runsClose({ S, render, tabUrl }) {
  const run = S.run; S.run = null; runView.run = null; history.pushState(null, '', tabUrl()); await render(); document.getElementById(`node-${run}`)?.focus();
}
export const acts = {
  'runs-show': P((d, { S, runsRepaint }) => { const s = S.runsView[d.group]; if (s.has(d.show)) s.delete(d.show); else s.add(d.show); runsRepaint(); }),
  'runs-window': P((d, { S, render, tabUrl }) => { S.runsView.window = d.window; history.replaceState(null, '', tabUrl()); render(); }),
  'runs-checkins': P((d, { S, runsRepaint }) => { S.runsView.ck = !S.runsView.ck; runsRepaint(); }),
  'runs-close': (b, c) => runsClose(c),
  'run-open': (b, c) => { if (inner(b)) return; openRunView(b.dataset.run, 'summary'); c.feedGo(b.dataset.project, b.dataset.run); },
  'run-feed': P((d, c) => { openRunView(d.run, 'feed', d.kind); c.feedGo(d.project, d.run); }),
  'run-view': P((d, { S, runsRepaint }) => { if (runView.run !== S.run) Object.assign(runView, { run: S.run, kind: 'tools' }); runView.view = d.view; runsRepaint(); }),
  'run-link': (b, { S, tabUrl }) => { const run = S.run; S.run = b.dataset.run; const u = new URL(tabUrl(), location.href).href; S.run = run;
    Promise.resolve(navigator.clipboard?.writeText(u)).then(() => { b.textContent = 'Copied'; }, () => { b.textContent = 'Copy failed'; }); },
};
