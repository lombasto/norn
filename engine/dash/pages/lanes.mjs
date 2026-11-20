// The Lanes page (moved verbatim from ui.mjs, stage NAV): the lane table, its filter chips and helpers, and the Map (classic SVG + the norn view).
import { esc, fin, dash, aname, chip, exClass, stateOf, projTag, homeChip, pendingChips, pauseAct, progLine, laneCard, backlogLine, cut } from '../ui.mjs';
import { hoChip, critiqueWord } from '../widgets.mjs';

// GAP-12: a running lane whose changed files overlap upstream work (a remote branch or an open PR; overlap.mjs) - one small chip each,
// a PR one links to the PR; the shared files are its tooltip
const overlapWords = o => `overlaps upstream: ${o.kind === 'pr' ? `PR #${o.number}` : o.ref} (${o.n} file${o.n === 1 ? '' : 's'})`;
const overlapChip = o => {
  const files = o.files || [], tip = esc([...(o.kind === 'pr' ? [`${o.ref}: ${o.title ?? ''}`] : []), ...files, ...(o.n > files.length ? [`+${o.n - files.length} more`] : [])].join('\n'));
  return o.kind === 'pr' && /^https:\/\//.test(o.url || '') ? `<a class="chip warn" href="${esc(o.url)}" target="_blank" rel="noopener" title="${tip}">${esc(overlapWords(o))}</a>`
    : `<span class="chip warn" title="${tip}">${esc(overlapWords(o))}</span>`; };
// owner 2026-11-18: one chip per overlap stacked 2-3 lines under busy lanes and broke the table's rhythm - two or more fold into ONE
// summary chip that opens (a native <details>: keyboard and phone work, no script) to the same per-branch chips
const overlapChips = os => !(os || []).length ? '' : os.length === 1 ? `<div class="lane-overlap">${overlapChip(os[0])}</div>`
  : `<details class="lane-overlap"><summary class="chip warn" title="this lane's changed files overlap ${os.length} other branches / PRs">overlaps ${os.length} upstream: ${os.reduce((n, o) => n + (o.n || 0), 0)} files</summary><div class="lane-overlap-list">${os.map(overlapChip).join(' ')}</div></details>`;
// RM-19 S1: the Lanes filter chips (index.html keeps the pick in S.laneShow and the URL as &lanes=active,done); a row's chip from its
// lanesView group: Active = running + needs you + queued, Done recently / Old = done younger / older than policy.done_lanes.old_days
export const LANE_SHOW = [['active', 'Active'], ['done', 'Done recently'], ['old', 'Old'], ['archived', 'Archived']];
export const LANE_SHOW_DEFAULT = ['active', 'done'];
export const laneShowOf = l => l.group === 'archived' ? 'archived' : l.group === 'done' ? (l.old ? 'old' : 'done') : 'active';
export const laneKey = (project, lane) => `${project}:${lane}`;
// RM-34: why the lane exists (purpose.mjs laneDriver): the objective in one line under the name - a tap opens it in full with every
// source and its title - and the sources as small links (RM / DIR / DEC / Q open the record where it lives, a brief or doc the Docs
// reader). No source = the finding as a chip. Plain text (lane readable-text's renderer, RM-30, is not on main yet).
const SRC_WORD = { brief: 'brief', doc: 'doc' };
export const laneSrcLink = s => s.doc ? `<button class="lnk lane-src" data-go="docs" data-goins="${esc(s.doc)}" title="${esc(`${s.id}: ${s.title}`)}">${esc(SRC_WORD[s.kind])}</button>`
  : `<a class="lane-src" data-rid="${esc(s.id)}" href="${esc(s.href)}" title="${esc(s.title)}">${esc(s.id)}</a>`;
export const laneWhy = d => !d ? '' : !d.sources.length ? `<div class="lane-why">${chip('warn', d.finding)}</div>`
  : `<details class="lane-why"><summary title="${esc(d.objective)}">${esc(d.objective)}</summary><ul class="small">${d.sources.map(s => `<li>${laneSrcLink(s)} ${esc(s.title)}</li>`).join('')}</ul></details>
    <div class="lane-srcs small">${d.sources.map(laneSrcLink).join(' ')}</div>`;
// MAIL-29: the lane's type as a chip (its tooltip = the signal that decided it; purpose.mjs laneType), a landing run in flight beside it
// (MERGE is what the lane does now, not its type), and where the output goes in words (laneOutput: a PR and its state, or the notes)
export const laneKind = l => { const t = l.lane_type, o = l.output; if (!t && !o) return '';
  const out = !o ? '' : o.href ? `<a class="lane-out" href="${esc(o.href)}" target="_blank" rel="noopener">${esc(o.text)}</a>` : `<span class="lane-out">${esc(o.text)}</span>`;
  return `<div class="lane-kind small"><span class="chip ${t?.type ? 'idle' : 'warn'}" title="${esc(`type from ${t?.signal ?? '-'}`)}">${esc(t?.type ?? 'no type')}</span>${t?.now ? ` ${chip('running', t.now)}` : ''} ${out}</div>`; };
export const laneAge = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
export function lanes(d, ctx) {
  const show = new Set(ctx.laneShow ?? LANE_SHOW_DEFAULT), hide = ctx.archiving ?? new Set(), refused = ctx.laneRefused ?? {}, undo = ctx.laneUndo;
  const all = (d.lanes || []).filter(l => !hide.has(laneKey(l.project, l.name))), n = k => all.filter(l => laneShowOf(l) === k).length;
  const usd = all.some(l => l.usd);   // gap #9: API billing - each lane's $ to date (its runs; a running one counted live, an estimate)
  const usdCell = l => !usd ? '' : `<td class="mono lane-usd">${l.usd?.runs ? `${l.usd.live ? '~' : ''}$${l.usd.total.toFixed(2)}` : dash}</td>`;
  // a done lane says how long ago it ended; an old one reads stopped (its row is faded); lifecycle.mjs: then which rule acts on it and
  // when ("archives in 3 days", "stopped: needs a check-in decision") unless the text already says it (idle)
  const ruleText = l => !l.rule || l.text === l.rule.text ? '' : ` · ${l.rule.text}`;
  const nowText = l => (l.group !== 'done' || !l.ended ? l.text : `${l.old ? 'stopped' : l.text} · done ${laneAge(ctx.now - Date.parse(l.ended))} ago`) + ruleText(l);
  // MAIL-29: the type filter - one type at a time (none = all); its chips are the types of the rows the state chips leave, counted
  const kind = ctx.laneType ?? null, typeOf = l => l.lane_type?.type ?? 'no type', shown = all.filter(l => show.has(laneShowOf(l)));
  const kinds = [...new Set([...shown.map(typeOf), ...(kind ? [kind] : [])])].sort();
  const rows = shown.filter(l => !kind || typeOf(l) === kind).map(l => {
    // the lane's run opens in the live feed drawer (as a Runs row does), not the supervisor's plain-text tail in a new browser tab
    const [cls, word] = stateOf(l.text), log = l.run ? `<button data-act="lane-feed" data-project="${esc(l.project)}" data-run="${esc(l.run)}" title="Open ${esc(l.run)} in the live feed">Feed</button>` : '';
    const pa = pauseAct(l.pause, l.project, l.run), act = (pa ? pa + ' ' : '') + (cls === 'running' ? `${log} <button data-act="stop" data-project="${esc(l.project)}" data-run="${esc(l.run)}">Stop</button>`
      : l.state === 'parked' ? `<button data-tab="inbox">Open Q</button>` : l.state !== 'archived' ? `${log} <button class="ghost" data-act="archive" data-project="${esc(l.project)}" data-lane="${esc(l.name)}">Archive</button>`
      : `${log} <button class="ghost" data-act="lane-undo" data-project="${esc(l.project)}" data-lane="${esc(l.name)}">Unarchive</button>`);   // an archive by the tick (lifecycle.mjs) is undone here too; RM-37: Pause / pausing / Resume first
    const why = refused[laneKey(l.project, l.name)];   // a refused Archive keeps its reason here: S, not err(), so a live re-render keeps it
    return `<tr id="lane-${esc(l.name)}"${l.old ? ' class="old"' : ''}><td>${laneCard(l.card, `<button class="lnk lname" aria-haspopup="dialog"><b>${projTag(ctx, l.project)}${esc(l.name)}</b></button>`)} ${homeChip(l)}${pendingChips(l)}<div class="id">${esc(l.id)}</div>${laneKind(l)}${laneWhy(l.driver)}${overlapChips(l.overlap)}${why ? `<div class="lane-refused small">${esc(why)}</div>` : ''}</td><td>${chip(l.state)}</td><td>${chip(cls, word)}${hoChip(l.handoff, l.run)}</td>
      <td>${l.executor ? chip(exClass(l.executor), l.executor) : dash}</td><td>${esc(nowText(l))}${l.path ? ` · ${l.path.red ? chip('bad', l.path.text) : esc(l.path.text)}` : ''}${progLine(l.progress)}</td><td><span class="id">${esc(l.run ?? '-')}</span>${l.run_name ? `<div>${aname(l.run_name)}</div>` : ''}</td>${usdCell(l)}<td><div class="rowacts">${act}</div></td></tr>`;
  }).join('') || `<tr><td colspan="${usd ? 8 : 7}" class="mute">${all.length ? 'No lanes under these filters.' : 'No LANE records.'}</td></tr>`;
  const chips = LANE_SHOW.map(([k, t]) => `<button class="hf" data-act="lane-show" data-show="${k}" aria-pressed="${show.has(k)}">${esc(t)} <b>${n(k)}</b></button>`).join('');
  return `<div class="banner">Lanes come from LANE records only (no folder scan); state = the latest run on the lane, whatever executor owns the tree.</div>${backlogLine(d.backlog)}
   ${undo ? `<div class="banner lane-undo" id="lane-undo">Archived ${esc(undo.lane)}. <button data-act="lane-undo" data-project="${esc(undo.project)}" data-lane="${esc(undo.lane)}">Undo</button></div>` : ''}
   <div class="filters"><input type="search" data-filter="lanes" placeholder="filter lanes"><span class="lane-show" role="group" aria-label="Show lanes">${chips}</span><span class="lane-show lane-types" role="group" aria-label="Lane type">${kinds.map(k => `<button class="hf" data-act="lane-type" data-type="${esc(k)}" aria-pressed="${k === kind}">${esc(k)} <b>${shown.filter(l => typeOf(l) === k).length}</b></button>`).join('')}</span></div>
   <div class="tablecard"><table data-rows="lanes"><thead><tr><th>lane</th><th>record</th><th>run state</th><th>executor</th><th>now</th><th>latest run</th>${usd ? '<th title="every run of the lane; ~ = one is still running (an estimate)">$ to date</th>' : ''}<th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- Map (LANE-MAP-DESIGN 1): the server's graph + layout drawn as inline SVG; pan = scroll, zoom = 3 fixed steps ----------
export const ZOOMS = [0.75, 1, 1.25];
const MAP_LEGEND = [['owns', 'lane -> run'], ['resumes', 'HANDOFF -> next run (dashed)'], ['delegates', 'run -> helper / subagent'],
  ['dispatched', 'check-in started it'], ['reviewed', 'check-in reviewed it'], ['asks', 'open question parks the lane']];
function edgePath(a, b, kind) {
  const ya = a.y + a.h / 2, yb = b.y + b.h / 2;
  if (a.x === b.x && kind === 'resumes') { const x = a.x, k = 18 + Math.min(30, Math.abs(yb - ya) / 8); return `M${x} ${ya} C${x - k} ${ya} ${x - k} ${yb} ${x} ${yb}`; }
  if (a.x === b.x) { const x = a.x + a.w, k = 14 + Math.min(44, Math.abs(yb - ya) / 12); return `M${x} ${ya} C${x + k} ${ya} ${x + k} ${yb} ${x} ${yb}`; }
  const x1 = a.x + a.w, x2 = b.x, m = (x1 + x2) / 2;
  return `M${x1} ${ya} C${m} ${ya} ${m} ${yb} ${x2} ${yb}`;
}
function mapNode(n, project) {
  if (n.critique) n = { ...n, sub: `${n.id} · ${critiqueWord(n.critique)[1]}` };   // META-DOD 3: a plan run shows its review
  // the live hand-off state (lanes.mjs handoffOf): its words take the sub line, a pulsing dot sits before them
  const ho = n.handoff?.text ? `<circle class="pulse ho-${n.handoff.phase === 'resumed' ? 'resumed' : 'pending'}" cx="18" cy="${n.h - (n.h < 46 ? 11 : 16)}" r="4"/>` : '';
  if (ho) n = { ...n, sub: n.handoff.short ?? n.handoff.text, hoX: 26, hoTip: n.handoff.text };
  const small = n.h < 46, feed = n.feed ? ` data-feed="${esc(n.feed)}" data-project="${esc(project)}" role="button" tabindex="0"` : '';
  const tip = [n.label, n.hoTip ?? n.sub, n.word, n.feed ? 'click: live feed' : ''].filter(Boolean).join(' · ');
  const more = n.type === 'lane' && (n.more > 0 || n.expanded)
    ? `<text class="more" x="12" y="${n.h + 14}" data-act="map-more" data-lane="${esc(n.lane)}">${n.expanded ? `${n.capped ? 'latest 30 · ' : ''}show last 3` : `+${n.more} more`}</text>` : '';
  const room = Math.max(6, Math.floor((n.w - 30 - String(n.word ?? '').length * 7) / 7.6)); // label chars beside the state word
  return `<g class="mn t-${n.type} c-${esc(n.cls)}${n.faded ? ' faded' : ''}${n.needs ? ' needs' : ''}" id="mn-${esc(n.id)}" transform="translate(${n.x} ${n.y})"${feed}><title>${esc(tip)}</title>
    <rect class="box" width="${n.w}" height="${n.h}" rx="8"/><rect class="st" width="5" height="${n.h}" rx="2"/>
    <text class="nl" x="14" y="${small ? 16 : 22}">${esc(cut(n.label, Math.min(room, small ? 22 : 24)))}</text><text class="nw" x="${n.w - 10}" y="${small ? 16 : 22}" text-anchor="end">${esc(n.word)}</text>
    ${ho}<text class="ns${ho ? ' ho-w' : ''}" x="${n.hoX ?? 14}" y="${n.h - (small ? 8 : 12)}">${esc(cut(n.sub, 40))}</text>${more}</g>`;
}
// ---------- Map in the Norn look (META-VISUAL-B S2): the Well (default) or the Tapestry (the dense view) - a three.js stage the
// page mounts into #map-host (norn/mapview.mjs), live from the state stream. This is only its frame: view switch, archived-lanes
// toggle, zoom, legend. The classic look keeps the SVG map below. ----------
export const MAP_VIEWS = [['well', 'The Well'], ['tapestry', 'The Tapestry']];
const MAP_STATES = [['running', 'running'], ['done', 'DONE'], ['handoff', 'HANDOFF'], ['stopped', 'STOPPED'], ['parked', 'parked'], ['needs', 'needs you'], ['idle', 'idle']];
function nornMap(d, ctx) {
  const view = MAP_VIEWS.some(v => v[0] === ctx.mapView) ? ctx.mapView : 'well', nz = ctx.nornZoom || 1;
  const views = MAP_VIEWS.map(([k, w]) => `<button data-act="map-view" data-view="${k}" aria-pressed="${k === view}"${k === view ? ' class="strong"' : ''}>${w}</button>`).join('');
  const zoom = [1, 1.5, 2].map(z => `<button data-act="map-nz" data-z="${z}" aria-pressed="${z === nz}"${z === nz ? ' class="strong"' : ''}>${z}x</button>`).join('');
  const lanes = (d.nodes || []).filter(n => n.type === 'lane' && n.lane !== 'checkin').length;
  const say = view === 'well' ? 'Every lane is a thread spun from the Well of Urd to its stake (running lanes face you); runs are beads, the newest by the well; the Norns hold the check-ins.'
    : 'Every lane is a weft row, its runs are knots along it (the newest at the right edge); the band of the Norns holds the check-ins.';
  return `<div class="filters"><span class="small mute">${say} Click a bead or its label for the live feed.</span>
    <span class="spacer"></span><span class="views" role="group" aria-label="Map view">${views}</span><label class="small"><input type="checkbox" data-act="map-all"${ctx.mapAll ? ' checked' : ''}> done / archived lanes</label><span class="zoom">${zoom}</span></div>
   <div class="norn-map" data-view="${view}" role="img" aria-label="${esc(MAP_VIEWS.find(v => v[0] === view)[1])}: ${lanes} lanes"><div class="map-host" id="map-host"></div><div class="map-hud small" id="map-hud"></div></div>
   <div class="legend small">${MAP_STATES.map(([c, w]) => chip(c, w)).join(' ')} <span class="mute">· pulse + motes = a record from the run · shuttle = dispatch / review / delegation · a bright thread = its run just acted</span></div>`;
}
export function map(d, ctx) {
  if (ctx.look === 'norn') return nornMap(d, ctx);
  const z = ZOOMS.includes(ctx.mapZoom) ? ctx.mapZoom : 1, N = Object.fromEntries((d.nodes || []).map(n => [n.id, n]));
  const bands = (d.bands || []).map((b, i) => `<rect class="band${i % 2 ? ' alt' : ''}" x="0" y="${b.y}" width="${d.width}" height="${b.h}" rx="6"/>`).join('');
  const edges = (d.edges || []).filter(e => N[e.from] && N[e.to]).map(e => `<path class="me e-${e.kind}" d="${edgePath(N[e.from], N[e.to], e.kind)}" marker-end="url(#arr)"><title>${esc(`${e.word}: ${e.from} -> ${e.to}`)}</title></path>`).join('');
  const nodes = (d.nodes || []).map(n => mapNode(n, d.project)).join('');
  const pills = (d.bands || []).map(b => dlvPill(b, d.project)).join('');
  const zoom = ZOOMS.map(v => `<button data-act="map-zoom" data-z="${v}"${v === z ? ' class="strong" aria-pressed="true"' : ''}>${Math.round(v * 100)} %</button>`).join('');
  const legend = MAP_LEGEND.map(([k, w]) => `<span><svg width="34" height="10" aria-hidden="true"><path class="me e-${k}" d="M2 5 L32 5"/></svg> <b>${k}</b> ${esc(w)}</span>`).join('');
  const states = [['running', 'running'], ['done', 'DONE'], ['handoff', 'HANDOFF'], ['stopped', 'STOPPED'], ['parked', 'parked'], ['needs', 'needs you'], ['idle', 'idle']].map(([c, w]) => chip(c, w)).join(' ');
  return `<div class="filters"><span class="small mute">Lanes as bands (running > parked > idle), the controller's check-ins on top; last 3 runs per lane (latest large). Click a run, helper or check-in for its live feed.</span>
    <span class="spacer"></span><label class="small"><input type="checkbox" data-act="map-all"${ctx.mapAll ? ' checked' : ''}> done / archived lanes</label><span class="zoom">${zoom}</span></div>
   <div class="mapwrap"><svg class="map" xmlns="http://www.w3.org/2000/svg" width="${Math.round(d.width * z)}" height="${Math.round(d.height * z)}" viewBox="0 0 ${d.width} ${d.height}" role="img" aria-label="Lane to agent map">
    <defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>${bands}${edges}${nodes}${pills}</svg></div>
   <div class="legend small mute">${legend}</div><div class="legend small">${states}</div>`;
}

// ---------- deliverables (DELIVERABLES-SPEC 3): "Done, not installed" card (Overview + Inbox), the drawer, the Map band pill ----------
function dlvPill(b, project) {
  const r = b.deliverables?.[0];
  if (!r) return '';
  const word = r.record_state === 'parked' ? 'parked' : r.state;
  const txt = `${r.id} ${word} ${fin(r.days) ? r.days.toFixed(1) + ' d' : ''}${fin(r.behind) ? ` · ${r.behind} behind` : ''}${r.native ? ' · native' : ''}${b.deliverables.length > 1 ? ` · +${b.deliverables.length - 1}` : ''}`;
  const tip = `${r.branch}: ${word}${r.park_why ? ` (${r.park_why})` : ''}${r.due ? ' · question due' : ''} · click: open the deliverable`;
  return `<g class="dlv ${esc(r.state)}${r.record_state === 'parked' ? ' parked' : ''}${r.due ? ' due' : ''}" data-dlv="${esc(r.id)}" data-project="${esc(r.project ?? project)}" role="button" tabindex="0" transform="translate(16 ${b.y + b.h - 32})"><title>${esc(tip)}</title>
    <rect width="${Math.min(260, 16 + txt.length * 6.6).toFixed(0)}" height="20" rx="10"/><text x="9" y="14">${esc(txt)}</text></g>`;
}

// ---------- live feed drawer (LANE-MAP-DESIGN 2): head + one line per normalised event; index.html streams /api/feed into it ----------
