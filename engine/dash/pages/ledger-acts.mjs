// The Records and Ledger pages' handlers: data-act -> fn(el, c), dispatched by index.html's one registry (see pages/lanes-acts.mjs for c).
// A chip flips its view (pages/ledger.mjs recView / ledgerView, kept through stream repaints) and the page renders again; an id opens
// the record in the dashboard's drawer (#srcview, the code viewer's: the head and body are the record's).
import DOMPurify from '/vendor/purify.es.mjs';
import { recView, ledgerView, recordHead, renderRecord } from './ledger.mjs';
const flip = (set, k) => { if (set.has(k)) set.delete(k); else set.add(k); };
const V = f => (b, { render }) => { f(b.dataset.show ?? ''); render(); };
export const acts = {
  'rec-kind': V(k => flip(recView.kinds, k)),
  'rec-state': V(k => flip(recView.states, k)),
  'rec-age': V(k => { recView.age = k; }),
  'rec-lane': V(k => { recView.lane = k; }),
  'rec-sort': V(k => { recView.sort = k; }),
  'ledger-kind': V(k => flip(ledgerView.kinds, k)),
  'rec-open': (b, { S, $ }) => {
    const d = S.last || {}, r = [...(d.directives || []), ...(d.decisions || [])].find(x => x.id === b.dataset.id);
    $('#dlv').hidden = true; $('#rmed').hidden = true; $('#srcview').hidden = false;
    $('#srcview-head').innerHTML = r ? DOMPurify.sanitize(recordHead(r)) : '';
    $('#srcview-body').innerHTML = DOMPurify.sanitize(renderRecord(r, d, { project: S.project, now: Date.now() }));
  },
};
