// The Docs page (moved from ui.mjs, ui-context-docs): the one reader - the side list of every file the agents read and the project's
// own docs (docparts.mjs), and the open file Rendered or Source with its paragraph strip and its findings. ui.mjs keeps the dispatch line.
import { renderMarkdown } from '../docs.mjs';
import { esc, int, chip, fmtTime } from '../cells.mjs';
import { subMore } from '../subviews.mjs';
import { placeFindings, findingsByLine } from '../docparts.mjs';
import { tk, INS_LOAD, INS_CHIP, SEV_CHIP, memGauge } from './context.mjs';

// META-UX-BUILD S3 (REPORT s.2): Docs = the one reader. A side list of every file the agents read + the project's own docs, grouped by
// who loads it (docparts.mjs; each group capped, "show more"); the Memory group is headed by its gauge. The open file is its own part:
// Rendered (each paragraph with its age badge and its findings beside it) or Source (each finding beside its line). A wide screen shows
// list + reader; a phone shows the list, a tap opens the reader with Back (index.html: the file is in the URL, &doc=).
export function docs(d, ctx) {
  const now = ctx.now ?? Date.now(), sel = d.doc?.key ?? d.file;
  const wait = d.pending ? `<div class="small" id="docs-pending" style="margin:0 0 6px">${chip('run', 'refreshing')} <span class="mute">the first scan of the instruction files is running: they join this list when it lands</span></div>`
    : d.error ? `<div class="small" style="margin:0 0 6px">${chip('bad', 'scan failed')} <span class="mute">${esc(d.error)}</span></div>` : '';
  const row = r => `<li><button class="docfile${r.key === sel ? ' sel' : ''}" id="docf-${esc(r.key)}" data-docfile="${esc(r.key)}" aria-current="${r.key === sel}" title="${esc(r.path)}"${r.exists ? '' : ' disabled'}>
    <span class="dfname">${esc(r.name)}${r.note ? ` <span class="mute small">(${esc(r.note)})</span>` : ''}${r.linked === 0 ? ` ${chip('warn', 'in no index')}` : ''}${r.exists ? '' : ` ${chip('bad', 'missing')}`}</span>
    ${r.findings ? `<span class="gchip" title="${esc(`${r.findings} finding${r.findings === 1 ? '' : 's'} on this file`)}">${chip('warn', `${int(r.findings)} finding${r.findings === 1 ? '' : 's'}`)}</span>` : ''}<span class="mute small dftk">${r.tokens === null || r.tokens === undefined ? '' : tk(r.tokens)}</span></button></li>`;
  const grp = g => `<div class="docgrp" id="docs-g-${esc(g.id)}"><h4 class="small"><span>${esc(g.label)}</span><span class="mute">${int(g.n)}</span></h4>${g.id === 'memory' && d.memory ? memGauge(d.memory, 'docs-memory') : ''}
    <ul>${g.rows.map(row).join('')}</ul>${subMore(g.rows.length, g.n)}</div>`;
  const list = `<div class="card doclist" id="docs-list" role="navigation" aria-label="Files">${(d.groups || []).map(grp).join('') || '<p class="small mute">no files yet</p>'}</div>`;
  const reader = !d.file ? '<p class="small mute" id="docs-none">Pick a file on the left.</p>' : d.parts_loading ? `<p class="small mute" id="docs-loading">${chip('idle', 'loading')} the file ...</p>` : d.doc ? docReader(d.doc, { ...ctx, now }, d) : '';
  return `<div class="dochead"><b>Docs</b> <span class="small mute">every file the agents read, and the project's own docs · ${int(d.files ?? 0)} files · rendered · findings beside the text</span></div>${wait}
   <div class="docsplit${d.picked ? ' picked' : ''}" id="docs-split">${list}<section class="docread" id="docs-reader">${reader}</section></div>`;
}

// META-TEND P5 (REPORT 5.3 view 4): per file - a strip of its paragraphs (width = tokens) coloured by age, with read and cite marks
const AGE_BANDS = [[7, 'age-new', 'under 7 d'], [30, 'age-mid', '7-30 d'], [Infinity, 'age-old', 'over 30 d']];
function insStrip(f) {
  if (!f.paras?.length) return '';
  const tot = f.paras.reduce((n, p) => n + Math.max(1, p.tokens), 0), ev = f.evidence;
  const segs = f.paras.map(p => {
    const cls = p.age_days === null || p.age_days === undefined ? 'age-unk' : AGE_BANDS.find(([d]) => p.age_days < d)[1], cited = p.cited || [];
    return `<a class="psg ${cls}${p.stale ? ' stale' : ''}" href="#ins-${esc(p.anchor)}" style="flex-basis:${(100 * Math.max(1, p.tokens) / tot).toFixed(2)}%" title="${esc(`L${p.line}-${p.end} · ${p.age_days ?? '?'} d · ~${p.tokens} tokens · read ${p.read ?? 0}x${cited.length ? ` · cited by ${cited.join(', ')}` : ''}${p.stale ? ' · STALE' : ''}`)}">${p.read ? '<i class="pread"></i>' : ''}${cited.length ? '<i class="pcite"></i>' : ''}</a>`;
  }).join('');
  const cites = [...new Set((ev?.cites || []).map(c => c.id))];
  const said = ev ? `read ${int(ev.reads)}x in ${int(f.read_days ?? 30)} days${ev.last ? ` (last ${fmtTime(ev.last)})` : ''} · ${cites.length ? `cited by ${cites.join(', ')}` : 'cited by no decision'}` : 'no read evidence';
  return `<div id="ins-strip" class="small" style="margin:0 0 8px"><div class="pstrip" role="img" aria-label="${esc(`${f.paras.length} paragraphs by age; ${said}`)}">${segs}</div>
    <div class="stklegend">${AGE_BANDS.map(([, c, w]) => `<span><i class="stkdot ${c}"></i>${esc(w)}</span>`).join('')}<span><i class="pread inl"></i>read</span><span><i class="pcite inl"></i>cited (its line)</span><b>${esc(said)}</b></div></div>`;
}

// the Docs reader (META-UX-BUILD S3): head (name, load, size, path) + Rendered / Source; the paragraph strip (META-TEND P5); findings
// about the whole file on top; each other finding beside its paragraph (Rendered) or its line (Source). ctx.sanitize = DOMPurify.
const docFind = x => `<div class="insfind">${chip(SEV_CHIP[x.severity] ?? 'idle', x.severity ?? 'note')} <span class="mute">${x.check ? `C${esc(x.check)} ` : ''}${x.line ? `L${esc(x.line)}` : 'whole file'}${x.surface ? ` · ${esc(x.surface)}` : ''}</span> ${esc(x.why)}${x.fix?.action ? `<div class="small mute">fix: ${esc(x.fix.action)}</div>` : ''}</div>`;
const docAside = xs => (xs?.length ? `<aside class="docfind">${xs.map(docFind).join('')}</aside>` : '');
const ageBadge = p => ((p.age_days !== null && p.age_days !== undefined) || p.changed || p.stated ?`<span class="agebadge chip ${p.stale ? 'warn' : p.confirmed ? 'ok' : 'idle'}" title="${esc([p.stated ? `stated ${p.stated}` : '', p.changed ? `changed ${p.changed.slice(0, 10)}` : '', p.confirmed ? 'confirmed' : '', p.why].filter(Boolean).join(' · '))}">${p.age_days ?? '?'} d${p.stale ? ' · STALE' : p.confirmed ? ' · confirmed' : ''}</span> ` : '');
// a JSON file, or a source file a run touched (f.code: its language, RM-36), is one code block; the fence outruns any ``` inside it
function docReader(f, ctx, d = {}) {
  const lang = /\.json$/i.test(f.path) ? 'json' : f.code ?? null, text = f.text ?? '', lines = text.split(/\r?\n/);
  const fence = lang ? '`'.repeat([...text.matchAll(/`{3,}/g)].reduce((n, m) => Math.max(n, m[0].length + 1), 3)) : '', src = lang ? `${fence}${lang}\n${text}\n${fence}` : text, json = !!lang;
  const findings = f.findings || [], L = d.line, foc = (a, b) => (L && a <= L && L <= b ? ' focus" data-focus="1' : '');
  let body, whole, toc = [];
  if (d.src) {   // Source: every line numbered, its findings beside it
    const by = findingsByLine(findings, lines.length); whole = by.whole;
    body = `<div class="card docsrc" id="doc-src"><table><tbody>${lines.map((t, i) => `<tr id="docl-${i + 1}" class="${foc(i + 1, i + 1)}"><td class="ln mute">${i + 1}</td><td class="lt"><code>${esc(t)}</code></td><td>${docAside(by.at.get(i + 1))}</td></tr>`).join('')}</tbody></table></div>`;
  } else {
    const r = renderMarkdown(src, { sanitize: ctx.sanitize }); toc = r.toc;
    if (f.paras?.length && !json) {   // each paragraph rendered on its own, its age badge + its findings beside it
      const at = placeFindings(f.paras, findings); whole = at.whole;
      body = f.paras.map(p => `<div class="inspara docpara${p.stale ? ' stale' : ''}${at.at.has(p.anchor) ? ' hasfind' : ''}${foc(p.line, p.end)}" id="ins-${esc(p.anchor)}"><div class="docptext">${ageBadge(p)}<span class="small mute">L${esc(p.line)}</span>${renderMarkdown(lines.slice(p.line - 1, p.end).join('\n'), { sanitize: ctx.sanitize }).html}</div>${docAside(at.at.get(p.anchor))}</div>`).join('');
    } else { whole = findings; body = r.html; }
    body = `<article class="card md" id="doc-body">${body}</article>`;
  }
  const links = toc.map(t => `<a class="toc${t.depth}" href="#${esc(t.id)}">${esc(t.text)}</a>`).join('');
  const load = f.load ? ` ${chip(INS_CHIP[f.load] ?? 'idle', f.load === 'role' ? `role ${f.role}` : INS_LOAD[f.load] ?? f.load)}` : '';
  const on = v => (v === 'src') === !!d.src;
  const btn = (v, label) => `<button data-act="doc-view" data-view="${v}" aria-pressed="${on(v)}" class="${on(v) ? 'strong' : ''}">${label}</button>`;
  return `<div class="dochd" id="docs-head"><button class="docback" data-act="doc-back">&larr; Back</button> <b class="dfname">${esc(f.name ?? f.tab)}</b>${load}
    <span class="small mute">${f.tokens ? `${tk(f.tokens)} tokens · ` : ''}${int(f.lines ?? lines.length)} lines${f.changed ? ` · changed ${esc(fmtTime(f.changed, ctx.now))}` : ''} · <span class="inspath">${esc(f.path)}</span></span></div>
   <div class="filters" id="docs-mode">${btn('md', 'Rendered')}${btn('src', 'Source')}<span class="small mute">${findings.length ? `${int(findings.length)} finding${findings.length === 1 ? '' : 's'} beside the text` : 'no findings on this file'}</span></div>
   ${insStrip(f)}${whole.length ? `<div class="card small" id="doc-file-findings"><b>About the whole file</b>${whole.map(docFind).join('')}</div>` : ''}
   ${d.src ? body : `<div class="docwrap"><nav class="doctoc" id="doc-toc" aria-label="Contents"><b class="small">Contents</b>${links || '<span class="small mute">no headings</span>'}</nav>${body}</div>`}`;
}
