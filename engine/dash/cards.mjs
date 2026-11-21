// The owner cards (UI redesign 2026-11-20): the rows only the owner can settle - a login to redo, a machine-level hold, a hand-edited
// generated file, a drafted setup - and the vendor-audit hunk and enforce cards, shown on the Inbox (pages/inbox.mjs) and the Context
// page's checks (pages/context.mjs; the Docs reader takes SEV_CHIP). Their own module so those pages share them without an import cycle.
import { esc, int, fmtMin, chip, projTag, minsSince } from './cells.mjs';
import { renderProse } from './prose.mjs';
import { diffBlock } from './diffview.mjs';

export const SEV_CHIP = { high: 'bad', medium: 'warn', low: 'idle', count: 'idle' };
export const baseName = p => String(p ?? '').split('/').pop();
// RM-30 S1: the day an enforce card was asked, in the owner's own clock ("Fri 11-20 05:41 local")
const fmtLocal = iso => { const t = Date.parse(iso ?? ''); if (!Number.isFinite(t)) return '-';
  const d = new Date(t); return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} local`; };
// OOTB-R2 N-5: runs held for a login (the command to type, the held runs, the failing line)
export const loginRow = (i, ctx) => `<div class="item">${chip('needs', i.id)}<div><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}${i.cls === 'vendor' ? 'nothing to do - a vendor outage, not your login' : `open a terminal and run <span class="mono">${esc(i.command)}</span>`}; held: ${esc((i.runs || []).join(', '))} - they resume by themselves${i.line ? ` · "${esc(i.line)}"` : ''}</div></div></div>`;
// GAP-1 (lib/holds.mjs): ALL queued work held on one machine-level hold - what, since when, why in plain words and the fix (Settings /
// the command / Resume); it leaves by itself when the hold clears
export const holdRow = (i, ctx) => `<div class="item" id="hold-${esc(i.project)}">${chip('bad', 'all held')}<div style="flex:1;min-width:0"><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}held ${fmtMin(i.minutes)} · ${esc((i.runs || []).join(', '))}</div>
  <div class="small">Fix: ${esc(i.fix)}${i.command ? ` <span class="mono">${esc(i.command)}</span>` : ''}${i.clears ? ` <span class="mute">- or it clears ${esc(i.clears)}</span>` : ''}</div></div>
  <span class="spacer"></span><div style="display:flex;gap:6px;flex-wrap:wrap">${i.setting ? `<button class="primary" data-tab="settings" title="${esc(i.setting)}">Open Settings</button>` : ''}${i.resume ? `<button class="primary" data-act="hold-resume" data-project="${esc(i.project)}">Resume</button>` : ''}</div></div>`;
// GAP-8 (lib/handedits.mjs): a generated file edited by hand is no longer regenerated - take it back (a .bak keeps the hand text) or keep it
// the words say what Norn saw and what each button does. RM-35: then what changed and who probably did it (handedits.mjs explain: the
// write record's lines, plain text), "View diff" (last written by Norn vs now in the diff viewer) and, when the text is clearly Norn's
// own (an older copy, or its last text with a lost hash), the recommendation to take it back with the reason
export const editRow = (i, ctx, px = { project: i.project, sanitize: ctx.sanitize }) => `<div class="item" id="${esc(i.id)}">${chip('warn', 'changed outside Norn')}<div style="flex:1;min-width:0"><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}${renderProse('`' + i.file + '`', px)}${i.created ? ` · changed ${fmtMin(minsSince(i.created, ctx.now))} ago` : ''}</div>
  <div class="small">Norn writes this file itself, and its text no longer matches what Norn last wrote, so Norn leaves it alone rather than overwrite someone's edit.</div>
  ${i.lines?.length ? `<ul class="small hedwho">${i.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : i.generated ? '<div class="small">It still carries Norn\'s GENERATED header, so it was most likely not edited by a person.</div>' : ''}
  ${i.recommend === 'takeback' ? `<div class="small"><b>Recommended: Let Norn take it back</b> - ${esc(i.why)}.</div>` : ''}
  <div class="small mute"><b>Let Norn take it back</b>: the current text is saved beside it as .bak and Norn updates the file again. <b>Keep my version</b>: Norn never updates this file again, until you take it back.</div></div>
  <span class="spacer"></span><div style="display:flex;gap:6px;flex-wrap:wrap">${i.diff ? `<button class="ghost" data-act="diff-open" data-dv-url="/api/handedit/diff?project=${encodeURIComponent(i.project ?? '')}&amp;file=${encodeURIComponent(i.file)}" data-dv-title="${esc(i.file.split('/').pop())}" data-dv-sub="last written by Norn vs now">View diff</button>` : ''}<button class="primary" data-act="handedit" data-choice="takeback" data-project="${esc(i.project)}" data-file="${esc(i.file)}">Let Norn take it back</button><button class="ghost" data-act="handedit" data-choice="keep" data-project="${esc(i.project)}" data-file="${esc(i.file)}">Keep my version</button></div></div>`;
// META-ADOPT A3: ONE needs-you row while a drafted setup waits (Review / Not now = a close with the reason)
export const setupRow = (i, ctx) => `<div class="item">${chip('open', i.id)}<div><b>${esc(i.title)}</b><div class="small mute">${projTag(ctx, i.project)}drafted ${fmtMin(minsSince(i.created, ctx.now))} ago · nothing is applied before you approve it</div></div><span class="spacer"></span><button class="primary" data-act="adopt-review" data-project="${esc(i.project)}">Review</button><button data-act="adopt-notnow" data-project="${esc(i.project)}">Not now</button></div>`;
// META-TEND P5 (REPORT 3.3): one vendor-audit hunk = one card; accept = a decision + a directive (the check-in applies it), decline = a decision
export function auditCard(c, project) {
  const pj = project ? ` data-project="${esc(project)}"` : '';
  return `<li class="insfind" id="aud-${esc(c.id)}">${chip(SEV_CHIP[c.severity] ?? 'idle', c.severity)} <b>${esc(baseName(c.path))}:${esc(c.line)}</b> ${esc(c.why)} <span class="small mute">${esc(c.run)} · ${esc(c.id)}</span>
    ${diffBlock({ patch: c.fix.patch ?? '' }, { title: `${baseName(c.path)}:${c.line}`, sub: 'vendor audit hunk' })}
    <button class="primary" data-act="audit-accept"${pj} data-id="${esc(c.id)}">Accept: apply it</button> <button data-act="audit-decline"${pj} data-id="${esc(c.id)}">Decline: keep the text</button></li>`;
}
// META-TEND P3 (REPORT 3.6): the repeat detector's cards - one per cluster, ranked; approve = a directive (the one approvals path)
// RM-30 S1: a card its directive already asks for (rules.mjs askedBy) reads "Asked as DIR-n (state) - date" with a link and has no
// Approve; Approve is one tap (the directive is the record and can be revoked) and sends the card id, which the directive keeps
export function enforceCard(c, project, px = { project }) {
  const a = c.asked;
  return `<li class="insfind${a ? ' asked' : ''}" id="enf-${esc(c.id)}">${chip(a ? 'ok' : c.severity === 'medium' ? 'warn' : 'idle', a ? 'asked' : c.severity)} <div class="enf-why">${renderProse(c.why, px)}</div>
    <details><summary class="small">${int((c.items || []).length)} corrections · the draft</summary><ul class="small">${(c.items || []).map(x => `<li>${renderProse(x.text, px)}</li>`).join('')}</ul>${diffBlock({ patch: c.fix.patch ?? '' }, { title: 'the draft', sub: 'repeat detector draft' })}</details>
    ${a ? `<div class="small enf-asked">Asked as <a class="rid r-dir" href="#" data-rid="${esc(a.id)}"${project ? ` data-project="${esc(project)}"` : ''}>${esc(a.id)}</a> (${esc(a.state)}) - ${esc(fmtLocal(a.at))}</div>`
    : `<div class="small mute">${esc(c.fix.action)}</div>
    <button class="primary" data-act="adv-approve"${project ? ` data-project="${esc(project)}"` : ''} data-id="${esc(c.id)}" data-text="${esc(c.approve)}">Approve: ask for a brief</button>`}</li>`;
}
