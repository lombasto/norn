// The Spend page's handlers: data-act -> fn(el, c), dispatched by index.html's one registry (see pages/lanes-acts.mjs for c).
// Clear all = Keep as is on every open advice card (POST /api/advice verdict keep, one decision record each; no Settings change), one
// card after the other so a refused one (409: the numbers changed) stops the rest; the page repaints once at the end.
export const acts = {
  'advice-clear': (b, { act, post }) => { const p = b.dataset.project, keys = String(b.dataset.keys || '').split(',').filter(Boolean); b.disabled = true;
    act(async () => { for (const key of keys) await post('/api/advice', { project: p, key, verdict: 'keep' }); }).finally(() => { b.disabled = false; }); },
};
