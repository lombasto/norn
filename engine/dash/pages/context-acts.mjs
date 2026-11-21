// The Context and Docs pages' handlers: data-act -> fn(el, c), dispatched by index.html's one registry (pages/*-acts.mjs `acts`).
// ctx-show: Per file's filter chips pick the group (pages/context.mjs ctxView) - the map and the table repaint from the same rows.
import { ctxView } from './context.mjs';
export const acts = {
  'ctx-show': (b, { S, render }) => { ctxView.show = b.dataset.show; S.subLimit = null; render(); },
};
