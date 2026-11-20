// INBOX-REPLIES: the thread on an owner question, read from its history (records.mjs say / reply / answer events). The owner's typed
// words are a message to the controller (say), not a ruling: the Q stays open until the owner picks an option or confirms a ruling the
// controller proposed from their words. Pure; the dashboard, the views, STATUS and the CLI share it. Node built-ins only.

/** the thread: the owner's messages, the controller's replies (with each options revision and proposed ruling) and the closing answer */
export function threadOf(q) {
  const out = [];
  for (const h of q?.history || []) {
    if (h.ev === 'say') out.push({ seq: h.seq, ts: h.ts, who: 'owner', ev: 'say', text: h.data.text, via: h.data.via ?? null });
    else if (h.ev === 'reply') out.push({ seq: h.seq, ts: h.ts, who: h.by, run: h.run ?? null, ev: 'reply', text: h.data.text,
      ...(h.data.options ? { options: h.data.options } : {}), ...(h.data.recommend ? { recommend: h.data.recommend } : {}), ...(h.data.propose ? { propose: h.data.propose } : {}) });
    else if (h.ev === 'answer') out.push({ seq: h.seq, ts: h.ts, who: 'owner', ev: 'answer', text: h.data.text, choice: h.data.choice ?? null, ruling: h.data.ruling ?? null });
    else if (h.ev === 'reopen') out.push({ seq: h.seq, ts: h.ts, who: 'owner', ev: 'reopen', text: 'reopened' });
  }
  return out;
}
/** the owner's messages the controller has not replied to yet (newest last); empty = nothing waits on the controller */
export function unanswered(q) {
  const t = threadOf(q), i = t.findLastIndex(x => x.ev !== 'say');
  return q?.state === 'open' ? t.slice(i + 1) : [];
}
/** the ruling the controller proposed and the owner may confirm with one tap: the latest reply's propose, unless the owner wrote since */
export function rulingOf(q) {
  if (q?.state !== 'open') return null;
  const t = threadOf(q), last = t.at(-1);
  return last?.ev === 'reply' && last.propose ? { seq: last.seq, key: last.propose.key ?? null, text: last.propose.text } : null;
}
/** a typed reply that clearly picks an option: the bare key ("b", "(b)", "option b", "b."); anything else is a message */
export function pickOf(text, options = []) {
  const m = /^\s*(?:option\s+)?\(?([A-Za-z0-9_-]+)\)?\s*[.!]?\s*$/i.exec(String(text ?? ''));
  if (!m) return null;
  const o = options.find(x => x.key.toLowerCase() === m[1].toLowerCase());
  return o ? o.key : null;
}
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
/** STATUS.md lines under an open Q: the owner's words still waiting on the controller (the check-in replies in the thread), or the
 * ruling the controller proposed that waits on the owner's tap. Empty when the thread waits on nobody. */
export function threadStatus(q) {
  const w = unanswered(q), p = rulingOf(q);
  if (w.length) return [`  - owner wrote (${w.length}, ${w.at(-1).via ?? 'dashboard'}): "${clip(w.map(x => x.text).join(' / '), 300)}" -> reply in the thread: META rec reply ${q.id} --text T (not a ruling: the Q stays open)`];
  if (p) return [`  - proposed ruling waits on the owner's tap: ${p.key ? `(${p.key}) ` : ''}${clip(p.text, 160)}`];
  return [];
}
/** markdown lines of the thread (QUESTIONS.md, the Resolved view's text): one line per message, revision and proposal */
export function threadLines(q) {
  return threadOf(q).map(x => x.ev === 'say' ? `- owner (${x.ts}): "${x.text}"`
    : x.ev === 'reply' ? `- ${x.who} (${x.ts}): ${x.text}${x.options ? ` [options revised: ${x.options.map(o => `${o.key}) ${o.text}`).join('; ')}]` : ''}${x.propose ? ` [Rule: ${x.propose.key ? `(${x.propose.key}) ` : ''}${x.propose.text}?]` : ''}`
    : x.ev === 'answer' ? `- owner (${x.ts}) answered${x.choice ? ` **${x.choice}**` : ''}${x.ruling ? ' (confirmed the proposed ruling)' : ''}: "${x.text}"`
    : `- owner (${x.ts}) reopened`);
}
