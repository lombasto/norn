// The Context and Docs pages' handlers: data-act -> fn(el, c), dispatched by index.html's one registry (pages/*-acts.mjs `acts`).
// ctx-show: Per file's filter chips pick the group (pages/context.mjs ctxView) - the map and the table repaint from the same rows.
// doc-fix: a Docs gutter popover's button sends that one finding to the fixer (POST /api/fixall { id, way? }: the Fix all sheet's
// decision + directive); the popover then says what was sent - the fixer's card is where its change is applied.
import { ctxView } from './context.mjs';
import { esc } from '../cells.mjs';
export const acts = {
  'ctx-show': (b, { S, render }) => { ctxView.show = b.dataset.show; S.subLimit = null; render(); },
  'doc-fix': (b, { S, post, err }) => { const box = b.closest('.dfix'); b.disabled = true;
    post('/api/fixall', { project: S.project, id: b.dataset.id, ...(b.dataset.way ? { way: b.dataset.way } : {}) })
      .then(r => { if (box) box.innerHTML = `<span class="chip ok">sent</span> <span class="small">${esc(r.id)} + ${esc(r.directive)}${r.again ? ' (sent already)' : ''}: the check-in starts the fixer; apply its change from the fixer's card in Slop</span>`; },
        e => { b.disabled = false; err(e.message); }); },
};
