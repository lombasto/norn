// The Inbox page (UI redesign 2026-11-20, owner: "an actual inbox from agents/controller to answer questions"): only what the owner
// must answer - the open questions agents and the controller ask (options, thread, answer box) and the owner cards that wait on a tap
// (a hold, a login, a hand-edited file, a drafted setup, an audit hunk, a fixer result, a correction to enforce). Lanes shows finished,
// parked and unreviewed work; a lane's plan goes ahead inside its lane (no Decisions queue). One filter-chip row picks the groups
// (Questions, Cards, Resolved); every text goes through the one prose renderer (prose.mjs). ui.mjs keeps the dispatch line.
import { renderProse } from '../prose.mjs';
import { esc, int, fmtMin, plural, chip, projTag, homeChip, pendingChips, fmtTime, filterChips } from '../cells.mjs';
import { art, minsSince, holdRow, loginRow, editRow, setupRow, auditCard, enforceCard, fxSection } from '../ui.mjs';

// the groups the chip row shows; the view lives in this module (one per page: the acts flip it, a stream repaint keeps it)
export const INBOX_SHOW = [['questions', 'Questions'], ['cards', 'Cards'], ['resolved', 'Resolved']];
const CARD_TYPES = ['hold', 'login', 'handedit', 'setup', 'audit', 'fixresult', 'enforce'];
export const inboxView = { show: new Set(['questions', 'cards']) };

// RM-30 S1: the Inbox's text goes through the one prose renderer (prose.mjs) with its project's lanes / repo / Docs keys (/api/inbox prose)
const proseCx = (d, ctx, project, key) => ({ ...(d.prose?.[project] || {}), project, sanitize: ctx.sanitize, ...(key ? { clamp: true, key } : {}) });
const line = (t, px) => renderProse(t ?? '', { ...px, inline: true });
// an option = a small card: its key, its text, its cost; the recommended one is marked and carries its why
function optCard(o, rk, q, px) {
  const k = o.key ?? o.k, rec = k === rk, cost = o.cost ?? o.c;
  return `<div class="opt${rec ? ' rec' : ''}" data-key="${esc(k)}"><div class="ohead"><b class="okey">${esc(k)}</b>${rec ? ` ${chip('needs', `recommended${recFrom(q.recommend) ? ` · ${recFrom(q.recommend)}` : ''}`)}` : ''}${o.added_by ? ` <span class="small mute qadded">added by ${esc(o.added_by)}</span>` : ''}</div>${renderProse(o.text ?? o.t, px)}
    ${cost ? `<div class="ocost"><span class="olab">cost</span>${renderProse(cost, px)}</div>` : ''}${rec && q.recommend.why ? `<div class="owhy"><span class="olab">why</span>${renderProse(q.recommend.why, px)}</div>` : ''}</div>`;
}

// INBOX-REPLIES: a question's thread - the owner's messages, the controller's replies (each options revision shown), the ruling it
// proposed from the owner's words (one tap confirms it). (6b) where the options came from and whose recommendation it is.
const recFrom = r => (!r?.from ? '' : r.from === 'source' ? 'plan default' : r.from === 'checkin' || r.from === 'controller' ? "the controller's own" : `${r.from}'s own`);
const optsHead = q => `<div class="small mute qsrc" id="qsrc-${esc(q.id)}">${plural((q.options || []).length, 'option')}${q.origin ? ` · from <button class="lnk" data-ins="${esc(`path:${q.origin.file}`)}"${q.origin.line ? ` data-line="${esc(q.origin.line)}"` : ''} title="${esc(q.origin.file)}">${esc(`${String(q.origin.file).split(/[\\/]/).pop()}#${q.origin.section}`)}</button>` : ''}</div>`;
const tmsg = (x, q, now, px) => {
  const who = x.ev === 'reply' ? esc(x.who === 'checkin' ? 'controller (check-in)' : x.who) : 'you';
  const body = x.ev === 'answer' ? `answered${x.choice ? ` <b>(${esc(x.choice)})</b>` : ''}${x.ruling ? ' - confirmed the ruling' : ''}: ${line(x.text, px)}` : x.ev === 'reopen' ? 'reopened' : renderProse(x.text, px);
  const rev = x.options ? `<div class="small qrev">revised the options: ${x.options.map(o => `<b>(${esc(o.key)})</b> ${line(o.text, px)}`).join(' · ')}</div>` : '';
  const prop = x.propose ? `<div class="small qprop">Rule: ${x.propose.key ? `<b>(${esc(x.propose.key)})</b> ` : ''}${line(x.propose.text, px)}?</div>` : '';
  return `<li class="qmsg ${x.ev === 'reply' ? 'ctl' : 'own'}" id="qm-${esc(q.id)}-${esc(x.seq)}"><span class="small mute">${who} · ${esc(fmtTime(x.ts, now))}</span><div>${body}</div>${rev}${prop}</li>`;
};
function qThread(q, now, px) {
  const t = q.thread || [], P = q.proposal;
  if (!t.length) return '';
  const wait = q.waiting ? `<li class="small mute qwait">${chip('run', 'replying')} the controller answers here</li>` : '';
  const conf = P ? `<div class="card needs qconfirm" id="qconfirm-${esc(q.id)}"><span>Rule: ${P.key ? `<b>(${esc(P.key)})</b> ` : ''}${line(P.text, px)}?</span> <button class="primary" data-act="rule" data-project="${esc(q.project)}" data-id="${esc(q.id)}" data-ruling="${esc(P.seq)}">Yes, rule it</button></div>` : '';
  return `<ol class="qthread" id="qt-${esc(q.id)}">${t.map(x => tmsg(x, q, now, px)).join('')}${wait}</ol>${conf}`;
}
// one open question: its head, body, options, thread and the answer row (a Choose button per option, or words to the controller)
function question(q, d, ctx) {
  const rk = q.recommend ? q.recommend.key ?? q.recommend.k : null, opts = q.options || [], px = proseCx(d, ctx, q.project);
  const answered = (q.pending || []).some(e => e.ev === 'answer');   // RM-46 S3: answered here, its home relays it - no second answer (SPEC 3.8)
  return `<article class="q openq" id="q-${esc(q.id)}"><div class="qhead">${chip('open', q.id + ' open')}${homeChip(q)}${pendingChips(q)}<b class="qtitle">${line(q.title, px)}</b><span class="spacer"></span><span class="small mute">${projTag(ctx, q.project)}${esc(q.lane ?? '-')} · ${fmtMin(minsSince(q.created, ctx.now))} ago${q.class ? ` · class ${esc(q.class)}` : ''}</span></div>
    ${q.body ? `<div class="qbody">${renderProse(q.body, proseCx(d, ctx, q.project, `${q.project}:${q.id}`))}</div>` : ''}
    ${opts.length ? `${optsHead(q)}<div class="opts">${opts.map(o => optCard(o, rk, q, px)).join('')}</div>` : ''}
    ${rk && !opts.some(o => (o.key ?? o.k) === rk) ? `<div class="small owhy"><b>Recommendation (${esc(rk)}${recFrom(q.recommend) ? `, ${esc(recFrom(q.recommend))}` : ''}):</b> ${line(q.recommend.why, px)}</div>` : ''}
    ${qThread(q, ctx.now, px)}
    ${q.answered_by ? `<div class="card needs qmaybe"><span class="small">Possibly answered in <b class="mono">${esc(q.answered_by.id)}</b>${q.answered_by.words ? `: <q>${line(q.answered_by.words, px)}</q>` : ` (${line(q.answered_by.why, px)})`}</span>
      ${q.answered_by.words ? `<button class="primary" data-act="answer-from" data-project="${esc(q.project)}" data-id="${esc(q.id)}" data-from="${esc(q.answered_by.id)}">Yes - already answered in ${esc(q.answered_by.id)}</button>` : ''}</div>` : ''}
    ${answered ? `<div class="small mute qpending">Answer sent: home ${esc(q.home)} applies it at its next sync.</div>` : `<div class="qanswer">${opts.map(o => { const k = o.key ?? o.k; return `<button class="${k === rk ? 'primary' : ''}" data-act="answer" data-project="${esc(q.project)}" data-id="${esc(q.id)}" data-choice="${esc(k)}" data-text="${esc(`(${k}) ${o.text ?? o.t ?? ''}`)}">Choose (${esc(k)})${k === rk ? ' - recommended' : ''}</button>`; }).join('')}
    <textarea id="ans-${esc(q.id)}" rows="2" placeholder="or write to the controller ..." aria-label="Answer ${esc(q.id)} in your words"></textarea><button data-act="answer-text" data-project="${esc(q.project)}" data-id="${esc(q.id)}">Send</button></div>`}</article>`;
}
// a resolved (answered / applied) question, newest first, its thread kept
function resolved(r, d, ctx) {
  const px = proseCx(d, ctx, r.project);
  return `<article class="q" id="qr-${esc(r.id)}"><div class="qhead">${chip(r.state, `${r.id} ${r.state}`)}<b class="qtitle">${line(r.title, px)}</b><span class="spacer"></span><span class="small mute">${projTag(ctx, r.project)}${esc(r.lane ?? '-')} · ${fmtTime(r.updated, ctx.now)}</span></div>
    ${r.origin || r.options.length ? optsHead(r) : ''}${r.answer ? `<p class="small qans">${r.answer.choice ? `<b>(${esc(r.answer.choice)})</b> ` : ''}${line(r.answer.text, px)}</p>` : ''}${(r.thread || []).some(x => x.ev !== 'answer') ? qThread({ ...r, waiting: 0, proposal: null }, ctx.now, px) : ''}</article>`;
}
// the owner cards: the machine rows (hold, login, hand edit, setup) in one card, then the audit hunks, fixer results and enforce cards
function cards(items, d, ctx) {
  const of = t => items.filter(i => i.type === t), px = i => proseCx(d, ctx, i.project);
  const rows = [...of('hold').map(i => holdRow(i, ctx)), ...of('login').map(i => loginRow(i, ctx)), ...of('handedit').map(i => editRow(i, ctx, px(i))), ...of('setup').map(i => setupRow(i, ctx))].join('');
  const aud = of('audit'), enf = of('enforce');
  return (rows ? `<section class="card needs" id="inbox-machine">${rows}</section>` : '')
    + (aud.length ? `<section class="tablecard" id="inbox-audit"><h3>Audit hunks <b>${int(aud.length)}</b></h3><ul>${aud.map(i => auditCard(i.card, i.project)).join('')}</ul></section>` : '')
    + fxSection(of('fixresult').map(i => [i.card, i.project, px(i)]), 'inbox-fixer', 'tablecard')
    + (enf.length ? `<section class="tablecard" id="inbox-enforce"><h3>Make it enforced? <b>${int(enf.length)}</b></h3><ul>${enf.map(i => enforceCard({ ...i.card, approve: i.approve, asked: i.asked }, i.project, px(i))).join('')}</ul></section>` : '');
}
const HELP = `<details class="lhelp"><summary aria-label="How answering works">?</summary><div class="small">A <b>Choose</b> button answers the question; the next tick applies it and unparks its lane.
  Words you send go to the controller, who replies in the thread: the question stays open until you pick an option or confirm a ruling (a bare key such as <span class="mono">b</span> picks it).
  <b>Cards</b> are the other things only you can settle: a hold, a login, a hand-edited file, a drafted setup, an audit hunk, a fixer result, a correction to enforce.</div></details>`;

export function inbox(d, ctx) {
  const items = d.items || [], show = ctx.inboxShow ?? inboxView.show;
  const qs = items.filter(i => i.type === 'question'), cs = items.filter(i => CARD_TYPES.includes(i.type)), rs = items.filter(i => i.type === 'resolved');
  const n = { questions: qs.length, cards: cs.length, resolved: rs.length };
  const chips = filterChips('Show in the Inbox', INBOX_SHOW.map(([k, t]) => ({ act: 'inbox-show', data: { show: k }, text: t, n: n[k], on: show.has(k) })));
  const clear = !qs.length && !cs.length ? `<div class="card" id="inbox-clear">${art(ctx, 'empty-no-questions', 'empty')}${chip('ok', 'all clear')} <span>Nothing needs you.</span></div>` : '';
  const body = [show.has('questions') ? qs.map(q => question(q, d, ctx)).join('') : '', show.has('cards') ? cards(cs, d, ctx) : '',
    show.has('resolved') && rs.length ? `<section id="inbox-resolved">${rs.map(r => resolved(r, d, ctx)).join('')}</section>` : ''].join('');
  return `<div class="phead pagehead" id="inbox-needs"><h2 class="ptitle">Inbox</h2>${chips}${HELP}</div>${clear}${body}`;
}
