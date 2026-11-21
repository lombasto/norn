// The Slop page's handlers: data-act -> fn(el, c), dispatched by index.html's one registry (see pages/lanes-acts.mjs for c).
// The To fix chips (Open / Ready) = S.slopKind, kept in the URL (&kind=ready) so Back, a reload and a shared link land on it; a
// repaint of what is already fetched (the filter is in slop.mjs slopFix, no new part).
export const acts = {
  'slop-kind': (b, { S, render, tabUrl }) => { S.slopKind = b.dataset.kind === 'ready' ? 'ready' : null; history.replaceState(null, '', tabUrl()); render(); },
};
