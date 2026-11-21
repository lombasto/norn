// The Inbox page's handlers: data-act -> fn(el, c), dispatched by index.html's one registry (see pages/lanes-acts.mjs for c).
// A chip shows or hides its group (Questions, Cards, Resolved); the view stays in pages/inbox.mjs through stream repaints.
import { inboxView } from './inbox.mjs';
export const acts = {
  'inbox-show': (b, { render }) => { const s = inboxView.show, k = b.dataset.show; if (s.has(k)) s.delete(k); else s.add(k); render(); },
};
