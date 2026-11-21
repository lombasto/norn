// The Slop page (moved from ui.mjs, ui-spend-slop): every open finding of every check in one list (/api/guard; guardparts.mjs cuts the
// parts), its sub-views To fix / Per type / Rules / By age, the Fix all sheet and the fixer's result cards (the Inbox shows the same cards).
import { esc, int, plural, chip, goAttrs, filterChips } from '../cells.mjs';
import { bars, stack, lines } from '../widgets.mjs';
import { subviewPage, subMore } from '../subviews.mjs';
import { GUARD_SUBS } from '../guardparts.mjs';
import { renderProse } from '../prose.mjs';
import { diffBlock } from '../diffview.mjs';

const G_TAB = { context: 'Context', tests: 'Tests', spend: 'Spend', runs: 'Runs', docs: 'Docs', slop: 'Slop' };
const G_SEV = { high: 'bad', medium: 'warn', low: 'idle', count: 'idle' };
const shortPath = p => String(p).replace(/\\/g, '/').split('/').slice(-2).join('/');
// a finding the fixer declined with a reason (fixer.mjs markDeclines): the reason, and the owner's two answers - accept the decline (the
// finding closes) or re-scope it (a new fix sentence, e.g. "trim in place" for "move to an on-demand file": Fix all offers it again)
const declinedLine = r => `<div class="small gdecl">${chip('idle', 'declined')} declined by ${esc(r.declined.run)}: ${esc(r.declined.why)}
    <div class="fxbtns"><button data-act="fixdecline" data-verdict="accept" data-id="${esc(r.id)}">Accept the decline</button> <input class="gscope" id="gscope-${esc(r.id)}" aria-label="the new fix" placeholder="the new fix, e.g. trim it in place" value="">
    <button data-act="fixdecline" data-verdict="rescope" data-id="${esc(r.id)}">Re-scope</button></div></div>`;
// RM-27: a SloppaChoppa finding explains itself - its rule's what / why / what to do and the waiver path, folded under the row
const slopExplain = x => `<details class="sexplain"><summary class="small">what this is, why it matters, what to do</summary><dl class="small">
    <dt>What</dt><dd>${esc(x.what)}</dd><dt>Why</dt><dd>${esc(x.why)}</dd><dt>What to do</dt><dd>${esc(x.fix)}</dd>${x.waiver ? `<dt>If it must stay</dt><dd>only the owner or the controller waives it: <code>${esc(x.waiver)}</code></dd>` : ''}</dl></details>`;
const guardRow = (r, labels) => `<li class="grow" id="slop-${esc(r.id)}"><div>${chip(G_SEV[r.severity] ?? 'idle', r.severity)} ${chip('idle', labels[r.type] ?? r.type)}${r.new ? ' ' + chip('needs', 'new') : ''}
    <span>${esc(r.why)}</span></div><div class="small mute">${r.sent ? chip('prov', `sent ${esc(r.sent)}`) + ' ' : ''}${esc(r.surface ?? '')}${r.path ? ` · ${esc(shortPath(r.path))}${r.line ? ':' + esc(r.line) : ''}` : ''} <button class="lnk" ${goAttrs(r.go)}>fix in ${esc(G_TAB[r.go?.tab] ?? r.go?.tab)}</button></div>${r.explain ? slopExplain(r.explain) : ''}${r.declined ? declinedLine(r) : ''}${r.apply ? `<details><summary class="small">patch (norn instructions apply ${esc(r.apply)})</summary>${typeof r.patch === 'string' ? `<pre class="inspatch">${esc(r.patch)}</pre>` : ''}</details>` : ''}</li>`;
// META-UX-BUILD S5 (REPORT s.2-3): To fix = ONE list in batches (check + the kind of fix the check declares), the kinds apart:
// ready (the exact text is known), to draft (a worker writes the text), your call (two ways), and the rows that only count (folded).
// A batch shows its first rows; "all n" opens it (one batch at a time, every row, capped + show more). The two ways are named here;
// picking one is the Fix all sheet (slice 6).
const KIND_HEAD = { ready: 'Ready', drafts: 'To draft', call: 'Your call' };
function slopBatch(b, labels, open) {
  const paths = b.rows.filter(r => r.path).map(r => `${shortPath(r.path)}${r.line ? ':' + r.line : ''}`);
  const all = b.n > b.rows.length ? ` <button class="lnk" data-act="slop-batch" data-batch="${esc(b.key)}">all ${int(b.n)}</button>` : '';
  return `<li class="sbatch" id="slop-b-${esc(b.key.replace(/[^\w-]/g, '_'))}"><div><b>${esc(b.title)}</b> <span class="mute">× ${int(b.n)}</span> ${chip(G_SEV[b.severity] ?? 'idle', b.severity)}${b.new ? ' ' + chip('needs', `${int(b.new)} new`) : ''}</div>
    ${open ? '' : `<div class="small mute sbpaths">${esc(paths.join(' · '))}${b.n > paths.length && paths.length ? ` +${int(b.n - paths.length)}` : ''}</div>`}
    ${b.action ? `<div class="small"><i>fix: ${esc(b.action)}</i></div>` : ''}${b.ways ? `<div class="small sbways">${b.ways.map(w => chip('prov', w)).join(' ')}</div>` : ''}
    ${open ? `<ol class="glist">${b.rows.map(r => guardRow(r, labels)).join('')}</ol>${subMore(b.rows.length, b.n)} <button class="lnk" data-act="slop-batch" data-batch="">close</button>`
      : `<details class="sbrows"><summary class="small">the first ${int(b.rows.length)}</summary><ol class="glist">${b.rows.map(r => guardRow(r, labels)).join('')}</ol></details>${all}`}</li>`;
}
// ui-spend-slop: one filter-chip row - Open (every kind) / Ready (only the rows whose exact text is known); the pick is &kind=ready in
// the URL (pages/slop-acts.mjs), a filter on what this view already holds (no refetch)
function slopFix(P, d, labels) {
  const only = d.kind === 'ready' ? 'ready' : null;
  const of = k => P.batches.filter(b => b.kind === k), rows = k => of(k).reduce((n, b) => n + b.n, 0);
  const sec = k => !of(k).length || (only && k !== only) ? '' : `<section class="card slopkind" id="slop-${k}" data-kind="${k}"><h2>${KIND_HEAD[k]} <span class="mute small">${int(rows(k))}</span></h2>
    <ul class="sblist">${of(k).map(b => slopBatch(b, labels, P.open === b.key)).join('')}</ul></section>`;
  const counts = only ? [] : of('count'), nc = rows('count');
  const fold = counts.length ? `<details class="small" id="slop-count"${P.open && counts.some(b => b.key === P.open) ? ' open' : ''}><summary>${plural(nc, 'more row')} only count something (${esc(counts.map(b => b.title).join(', '))}): nothing to fix</summary>
    <ul class="sblist">${counts.map(b => slopBatch(b, labels, P.open === b.key)).join('')}</ul></details>` : '';
  const empty = P.n && !(only && !of(only).length) ? '' : `<p class="mute">${chip('ok', 'all clear')} nothing ${only ? 'ready' : 'open'}</p>`;
  const more = P.nb > P.batches.length ? subMore(P.batches.length, P.nb) : '';
  const chips = filterChips('Show', [{ act: 'slop-kind', data: { kind: '' }, text: 'Open', n: d.total ?? P.n, on: !only }, { act: 'slop-kind', data: { kind: 'ready' }, text: 'Ready', n: d.kinds?.ready ?? 0, on: !!only }], 'slop-show');
  return `${chips}${sec('ready')}${sec('drafts')}${sec('call')}${fold}${empty}${more}`;
}
// META-UX-BUILD S6 (REPORT s.3 "End to end" 1-2, DIR-65 Q2 A): the Fix all sheet - ready + to draft ticked, your call as its two ways
// (a pick adds it), the owner's own files offered unticked; Send the fixer (n) = one decision + one directive (POST /api/fixall). Nothing
// is edited and no run starts on this tap; the fixer's one result card (slice 7) is where a change lands, on Apply.
const FX_HEAD = { ready: 'Ready now · the exact text is known', drafts: 'The fixer drafts these', call: 'Your call · not included until you pick' };
function fixItem(i, sel) {
  const head = `<b>${esc(i.title)}</b> <span class="mute">× ${int(i.n)}</span> ${chip(G_SEV[i.severity] ?? 'idle', i.severity)}${i.new ? ' ' + chip('needs', `${int(i.new)} new`) : ''}${i.own ? ' ' + chip('parked', 'your own file: not ticked for you') : ''}`;
  const more = `<div class="small mute">${esc(i.paths.join(' · '))}${i.n > i.paths.length && i.paths.length ? ` +${int(i.n - i.paths.length)}` : ''}</div>${i.action ? `<div class="small"><i>fix: ${esc(i.action)}</i></div>` : ''}`;
  if (i.kind === 'call') return `<li class="fxitem fxcall"><div class="fxbody"><span class="fxq" aria-hidden="true">?</span> ${head}${more}</div>
    <div class="fxways">${i.ways.map(w => `<button class="ghost" data-act="fx-way" data-key="${esc(i.key)}" data-way="${esc(w)}" data-n="${i.n}" aria-pressed="${sel?.picks?.[i.key] === w}">${esc(w)}</button>`).join('')}</div></li>`;
  return `<li class="fxitem"><label class="fxbody"><input type="checkbox" data-fx-key="${esc(i.key)}" data-n="${i.n}"${(sel?.keys ? sel.keys.has(i.key) : i.tick) ? ' checked' : ''}> ${head}${more}</label></li>`;
}
// META-UX-BUILD S7 (REPORT s.3 step 4): the fixer's ONE result card per run - every file (Skip this file), every hunk as a diff, Apply all n
// (minus skipped files) / Discard = POST /api/fixresult (one decision + one directive: the audit accept path); the rest = a new tap.
// A run with no parsable hunk is failed: Discard only. A run that skipped every finding with a reason is declined (not failed): Close
// only; each decline stands on its finding on the Slop page. Each hunk is the shared diff component (diffview.mjs; RM-35), Open = the diff viewer.
export function fixResultCard(c, project, px = { project }) {
  const pj = ` data-project="${esc(project)}" data-run="${esc(c.run)}"`, failed = c.state === 'failed', declined = c.state === 'declined', st = c.status || [];
  const count = ['drafted', 'skipped', 'missing'].map(k => [k, st.filter(x => x.state === k).length]).filter(([, n]) => n).map(([k, n]) => `${int(n)} ${k}`).join(' · ');
  const why = st.filter(x => x.state !== 'drafted'), fn = f => f.n ?? f.hunks.filter(h => h.applies !== false).length;
  const files = (c.files || []).map(f => `<div class="fxfile" data-file="${esc(f.file)}" data-n="${int(fn(f))}"><div class="fxfilehead"><span class="mono">${esc(f.file)}</span> <span class="small mute">${plural(f.hunks.length, 'hunk')}</span><span class="spacer"></span>${fn(f) ? `<button class="ghost" data-act="fx-skip" data-file="${esc(f.file)}"${pj} aria-pressed="false">Skip this file</button>` : ''}</div>
    ${f.hunks.map(h => `${h.applies === false ? `<p class="small fxmisfit">${chip('bad', 'does not apply')} ${renderProse(h.why ?? '', { ...px, inline: true })} · not in Apply all; its finding stays open</p>` : ''}${diffBlock({ patch: h.patch }, { title: f.file + (h.line ? ':' + h.line : ''), sub: 'fixer hunk', cls: 'fxdiff' })}`).join('')}</div>`).join('');
  const rest = c.more ? `<p class="small"><button class="lnk" data-act="fixall-rest" data-dir="${esc(c.directive)}" data-project="${esc(project)}">${int(c.left)} left: send the fixer for the rest (${plural(c.more, 'run')})</button></p>` : '';
  return `<li class="fxcard" id="fxcard-${esc(c.run)}"><div class="fxtop">${failed ? chip('bad', `failed: ${c.fail || 'no parsable hunk'}`) : declined ? chip('idle', 'declined') : chip('needs', 'to apply')} <b>Fixer result ${esc(c.run)}</b> <span class="small mute">${esc(c.directive)} · ${esc(c.dec ?? '')} · ${plural(c.n, 'hunk')} in ${plural((c.files || []).length, 'file')}</span></div>
    ${count || c.bad ? `<p class="small">${[count, c.bad ? `${plural(c.bad, 'hunk')} ${c.bad === 1 ? 'does' : 'do'} not apply` : ''].filter(Boolean).join(' · ')}</p>` : ''}${why.length && !declined ? `<details><summary class="small">not drafted (${int(why.length)})</summary><ul class="small">${why.map(x => `<li><span class="mono">${esc(x.id)}</span> ${esc(x.state)}${x.why ? ': ' + renderProse(x.why, { ...px, inline: true }) : ''}</li>`).join('')}</ul></details>` : ''}
    ${declined ? `<p class="small">The fixer declined every finding, each with a reason: nothing to apply. The reasons stand on the findings (Slop page): accept a decline or re-scope it; the fixer is not offered them again until the finding or its file changes.</p><ul class="small fxdecl">${st.map(x => `<li><span class="mono">${esc(x.id)}</span>: ${esc(x.why ?? '')}</li>`).join('')}</ul>` : failed ? `<p class="small">${c.fail === 'no hunk applies' ? 'No hunk applies to the files as they are: nothing to apply. Discard it; the findings stay open.' : 'The run ended without one hunk in the audit format: nothing to apply. Discard it; the findings stay open.'}</p>${c.fail === 'no hunk applies' ? files : ''}` : files}
    <div class="fxbtns">${failed || declined ? '' : `<button class="primary" data-act="fixresult" data-choice="apply"${pj}>Apply all <span class="fx-kept">${int(c.n)}</span></button> `}<button data-act="fixresult" data-choice="discard"${pj}>${declined ? 'Close' : 'Discard'}</button></div>${rest}</li>`;
}
export const fxSection = (cards, id, wrap) => (cards.length ? `<section class="${wrap}" id="${id}" style="margin-bottom:12px"><h3>Fixer results <span class="mute small">${plural(cards.length, 'run')} to decide · Apply = the check-in applies the hunks; Norn edits nothing</span></h3><ul class="fxres">${cards.map(([c, p, px]) => fixResultCard(c, p, px)).join('')}</ul></section>` : '');
// where a sent Fix all is (server.mjs fixSent: fixer.at); a failed run never reads "with the fixer"
function fixerWords(x) {
  const f = x.fixer || {}, run = esc(f.run ?? '');
  const w = { queued: [chip('prov', 'with the fixer'), `fixer ${run} queued`], running: [chip('prov', 'with the fixer'), `fixer ${run} running`], card: [chip('needs', 'to apply'), `${run} drafted: apply on its card`],
    failed: [chip('bad', 'failed'), `${run} failed: no parsable hunk (Discard it on its card)`], declined: [chip('idle', 'declined'), `${run} declined every finding with a reason (Close its card; accept or re-scope each on its row)`], starting: [chip('prov', 'with the fixer'), 'the engine starts the fixer'], rest: [chip('needs', 'to send'), `${int(f.left)} left: send the fixer for the rest`] }[f.at];
  return w ? `${w[0]} ${esc(x.id)} + ${esc(x.directive)}: ${int(x.open)} finding(s), ${w[1]}` : `${chip('ok', 'sent')} ${esc(x.id)} + ${esc(x.directive)}: ${int(x.open)} finding(s)`;
}
function fixAll(sh, sent, sel = null) {
  const of = k => sh.items.filter(i => i.kind === k), n = k => of(k).reduce((a, i) => a + i.n, 0);
  const on = sh.items.reduce((a, i) => a + ((i.kind === 'call' ? sel?.picks?.[i.key] : sel?.keys ? sel.keys.has(i.key) : i.tick) ? i.n : 0), 0);
  const sec = k => (of(k).length ? `<h3 class="fxhead" id="fixall-${k}">${FX_HEAD[k]} <span class="mute small">${int(n(k))}</span></h3><ul class="fxlist">${of(k).map(i => fixItem(i, sel)).join('')}</ul>` : '');
  const done = sent ? `<p class="small" id="fixall-sent">${chip('ok', 'sent')} ${esc(sent.id)} + ${esc(sent.directive)}: ${int(sent.n)} finding(s)${sent.again ? ' (sent already: no second record)' : ''}. Nothing is edited; the check-in starts the one fixer run, and its card is where you apply.</p>` : '';
  return `<section class="card fixall" id="fixall"><h2>Fix all <span class="mute small">${int(sh.ticked)} ticked of ${int(n('ready') + n('drafts') + n('call'))} · nothing is edited when you tap</span></h2>
    <p class="small">The fixer drafts every change. You get <b>one card</b> with the exact text, and you apply it there.</p>
    ${sec('ready')}${sec('drafts')}${sec('call')}${sh.items.length ? '' : `<p class="mute">${chip('ok', 'all clear')} nothing to fix or decide</p>`}
    ${done}<div class="fxfoot"><span class="small mute" id="fixall-usage">${sh.usage?.batch ? `<b id="fx-runs" data-batch="${int(sh.usage.batch)}">${plural(Math.ceil(on / sh.usage.batch), 'fixer run')}</b> of at most ${int(sh.usage.batch)} findings ${esc(sh.usage.run ?? '')}` : esc(sh.usage?.line ?? '')}</span><span class="fxbtns"><button class="ghost" data-act="fixall-close">${sent ? 'Close' : 'Cancel'}</button>
    <button class="strong" data-act="fixall-send" data-sig="${esc(sh.sig)}"${sent || !on ? ' disabled' : ''}>Send the fixer (<span id="fx-n">${int(on)}</span>)</button></span></div></section>`;
}
// ui-spend-slop: Per type = the open count per type, and from the closed store (lib/slophist.mjs) what each type closed, what came and
// went in the last 7 days, the types that never caught anything since the store began and the ones growing fastest
const hday = iso => String(iso ?? '').slice(0, 10);
function slopTypes(P, total, fresh) {
  const H = P.hist?.types || {}, h = t => H[t.type] || { closed: 0, opened7: 0, closed7: 0, net7: 0 };
  const quiet = P.hist ? P.rows.filter(t => !t.open && !h(t).closed).map(t => t.label) : [];
  const grow = P.rows.filter(t => h(t).net7 > 0).sort((a, b) => h(b).net7 - h(a).net7).slice(0, 3).map(t => `${t.label} +${int(h(t).net7)}`);
  const past = t => (P.hist ? ` <span class="small mute">${int(h(t).closed)} closed · 7 days: +${int(h(t).opened7)} / -${int(h(t).closed7)}</span>` : '');
  const sum = P.hist ? `<p class="small" id="slop-type-sum">${quiet.length ? `Nothing caught since ${esc(hday(P.hist.since))}: ${esc(quiet.join(', '))}.` : `Every type caught something since ${esc(hday(P.hist.since))}.`} ${grow.length ? `Growing fastest (7 days, opened minus closed): ${esc(grow.join(', '))}.` : 'Nothing grew in the last 7 days.'}</p>`
    : '<p class="small mute" id="slop-type-sum">Closed findings are counted from the next full scan.</p>';
  return `<section class="card" id="slop-count-types"><h2>Open per type <span class="mute small">${plural(total, 'open finding')} · ${fresh} new at warn level</span></h2>${sum}${bars(P.rows.map(t => ({ label: t.label, value: t.open, cls: t.warn ? 'hot' : '',
    note: `${t.warn ? chip('warn', `${t.warn} warn`) : chip('ok', 'no warning')}${t.new ? ' ' + chip('needs', `${t.new} new`) : ''}${past(t)} <button class="lnk" ${goAttrs({ tab: t.tab })}>fix in ${esc(G_TAB[t.tab] ?? t.tab)}</button>` })), { id: 'slop-types', fmt: n => `${n} open` })}</section>`;
}
const AGE_HELP = '<details class="lhelp" id="slop-trend-help"><summary aria-label="About this chart">?</summary><div class="small">Each line climbs on the day a finding still open today was first seen. Fixed findings are not in it, so it is not the open count over time: a flat line means nothing still open is that old.</div></details>';
// META-UX-BUILD S2: the sub-view pattern (subviews.mjs): To fix / Per type / Rules / By age, the chosen part; the lead holds only what
// is acted on (the errors, Fix all, the sent line, the fixer's cards). d = the summary (guardparts.mjs) + d[d.sub] once its part is here.
// META-UX-BUILD S5 (DIR-64): the tab is Slop (the route /api/guard stays). ui-spend-slop: no banner, no counter row, no footer.
export function slopPage(d) {
  const fresh = d.new || 0, total = d.total ?? 0, labels = d.labels || {}, K = d.kinds || {};
  const offer = d.offer ?? (K.ready ?? 0) + (K.drafts ?? 0) + (K.call ?? 0), sentL = d.sent || [];
  const fixBtn = offer ? `<button class="primary" data-act="fixall-open" id="slop-fixall">Fix all (${int(d.fixable ?? 0)})</button>` : '';
  // findings already sent (an active Fix all directive): said here, so a Send is not lost when the tab is left; Fix all leaves them out
  const sentLine = sentL.length ? `<div class="small" id="slop-sent">${sentL.map(fixerWords).join(' · ')}. The engine starts the fixer by code; its card is where you apply. ${offer ? 'Fix all offers only the rest.' : 'Nothing else to send.'}</div>` : '';
  const cards = fxSection((d.fixcards || []).map(c => [c, d.project]), 'slop-fixcards', 'card');
  const P = d[d.sub];
  const body = !P ? '' : d.sub === 'fix' ? `<div id="slop-rows">${slopFix(P, d, labels)}</div>`
    : d.sub === 'types' ? slopTypes(P, total, fresh)
    : d.sub === 'rules' ? `<section class="card" id="slop-ledger-card"><h2>The rule ledger <span class="mute small">every must / never rule by how it is enforced</span></h2>${P.ledger ? `${stack([['prose', 'prose only'], ['repeated', 'repeated'], ['enforced', 'enforced'], ['retired', 'retired']].map(([key, label]) => ({ key: 'rl-' + key, label, value: P.ledger[key] ?? 0 })), { id: 'slop-ledger' })}
    <div class="small">${chip(P.ledger.prose ? 'warn' : 'ok', `${P.ledger.prose ?? 0} prose only`)} rules that no hook, test or gate enforces · <button class="lnk" ${goAttrs({ tab: 'context', sub: 'checks', jump: 'ins-ladder' })}>the ladder (Context › checks)</button></div>` : '<p class="small mute">The rule ledger is not scanned yet.</p>'}
    <h3>Open rule findings <span class="mute small">${int(P.n)}</span></h3><ol class="glist" id="slop-rule-rows">${P.rows.map(r => guardRow(r, labels)).join('') || `<li class="mute">${chip('ok', 'all clear')} no rule finding open</li>`}</ol>${subMore(P.rows.length, P.n)}</section>`
    : `<section class="card" id="slop-trend-card"><h2>Open findings by age <span class="mute small">the findings open now, per type, counted from the day each was first seen · last ${int(P.trend?.days?.length ?? 30)} days</span> ${AGE_HELP}</h2>
    ${P.trend?.series?.length ? lines(P.trend.series, { days: P.trend.days, id: 'slop-trend', title: 'findings open now, by the day first seen', unit: 'findings' }) : '<p class="small mute">No open finding.</p>'}</section>`;
  if (d.sheet) return fixAll(d.sheet, d.sheet_sent, d.sheet_sel);
  const act = fixBtn || sentLine ? `<div class="slop-act" id="slop-act">${fixBtn}${sentLine}</div>` : '';
  return subviewPage('slop', { title: 'Slop', lead: `${(d.errors || []).length ? `<div class="small mute" id="slop-errors">${d.errors.map(esc).join(' · ')}</div>` : ''}${act}${cards}`, views: GUARD_SUBS.map(([k, label]) => [k, label, d.counts?.[k]]), active: d.sub, body, loading: d.parts_loading || !P });
}
