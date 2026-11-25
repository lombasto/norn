// Code > Map drawn from the code graph (RM-a-66): no model, deterministic, free. Read ONLY through the graph's reader (codegraph.mjs,
// docs/code-graph.md). Areas, folders first: a file's folder cut to MAP_GRAPH.area_depth segments of its project path (a file at the
// project root is the area "(root)"); the drawn files are the project's own graph-language files that are not excluded (no manifest,
// no vendored / generated file; an edge leaving the project folder is not drawn). A band between two areas is as wide as the distinct
// file-to-file import edges between them (FAN_KINDS, no self-edge). Layout: our own layered one (no dependency; a few hundred boxes):
// back edges of a DFS in id order dropped, each area's layer the longest path to an area that imports nothing, importers drawn above
// what they import, the order inside a row by barycenter sweeps. A click on a file lights the files that import it (direct, then the
// rest transitively) and lists them. `norn code history` (the tick's start when HEAD moves) redraws it from the graph it already read;
// the page lands in <state>/code/graphmap and GET /code-map/?map=graph serves it under codemap.mjs's mapCsp (sandboxed, no network).
import fs from 'node:fs';
import path from 'node:path';
import { FAN_KINDS, LANGS, graphAt } from './codegraph.mjs';
import { readJsonS } from './fsnap.mjs';
import { atomicWrite } from './policy.mjs';
import { mapCsp } from './codemap.mjs';
import { sha } from './views.mjs';
import crypto from 'node:crypto';

// every threshold of this module (px are the SVG's own units; the page scales the drawing to its frame's width)
export const MAP_GRAPH = { area_depth: 2, band_min_px: 2, band_max_px: 26, cell: 10, cols_max: 16, pad: 8, head: 22, gap_x: 28, gap_y: 90, sweeps: 6, char_px: 7.5 };
export const graphMapDir = state => path.join(state, 'code', 'graphmap');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const XML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }, xe = s => String(s).replace(/[&<>"']/g, c => XML[c]);   // SVG text + attributes: XML's own entity for '
const r1 = n => Math.round(n * 10) / 10;

/** a project path -> its area: the folder cut to MAP_GRAPH.area_depth segments; '(root)' for a file in the project root */
export function areaOf(file) {
  const d = file.split('/').slice(0, -1);
  return d.length ? d.slice(0, MAP_GRAPH.area_depth).join('/') : '(root)';
}

/** g (graphAt's Graph) -> the drawing's model: { commit, indexed_at, files, areas: [{ id, files, x, y, w, h, cols }], bands: [{ from, to, n, w, d }],
 *  dependents: [[file index]] (the direct importers of each file), W, H } */
export function layoutMap(g) {
  const P = MAP_GRAPH, pre = g.prefix || '', kinds = new Set(FAN_KINDS);
  const files = [...g.files].filter(([f, r]) => f.startsWith(pre) && LANGS.includes(r.lang) && !r.excluded).map(([f]) => f.slice(pre.length)).sort(cmp);
  const ix = new Map(files.map((f, i) => [f, i])), seen = new Set(), dependents = files.map(() => []), bandN = new Map();
  for (const e of g.edges) {
    if (!kinds.has(e.kind) || !e.from.startsWith(pre) || !e.to.startsWith(pre)) continue;
    const a = ix.get(e.from.slice(pre.length)), b = ix.get(e.to.slice(pre.length)), k = `${a} ${b}`;
    if (a === undefined || b === undefined || a === b || seen.has(k)) continue;
    seen.add(k); dependents[b].push(a);
    const A = areaOf(files[a]), B = areaOf(files[b]);
    if (A !== B) bandN.set(`${A}\n${B}`, (bandN.get(`${A}\n${B}`) ?? 0) + 1);
  }
  for (const d of dependents) d.sort((x, y) => x - y);
  const byArea = new Map();
  files.forEach((f, i) => { const a = areaOf(f); if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(i); });
  const ids = [...byArea.keys()].sort(cmp), out = new Map(ids.map(a => [a, []]));
  const pairs = [...bandN].map(([k, n]) => { const [from, to] = k.split('\n'); return { from, to, n }; }).sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to));
  for (const b of pairs) out.get(b.from).push(b.to);
  // cycle break: a DFS in id order; an edge to an area still on the stack is a back edge and does not order the layers
  const state = new Map(), fwd = new Map(ids.map(a => [a, []]));
  const dfs = a => { state.set(a, 1); for (const b of out.get(a)) { if (state.get(b) === 1) continue; fwd.get(a).push(b); if (!state.has(b)) dfs(b); } state.set(a, 2); };
  for (const a of ids) if (!state.has(a)) dfs(a);
  const layer = new Map(), lay = a => { if (!layer.has(a)) layer.set(a, fwd.get(a).reduce((m, b) => Math.max(m, lay(b) + 1), 0)); return layer.get(a); };
  ids.forEach(lay);
  const top = Math.max(0, ...layer.values()), rows = Array.from({ length: top + 1 }, (_, i) => ids.filter(a => layer.get(a) === top - i));
  const nb = new Map(ids.map(a => [a, new Set()]));
  for (const b of pairs) { nb.get(b.from).add(b.to); nb.get(b.to).add(b.from); }
  const pos = new Map();
  const place = () => rows.forEach(r => r.forEach((a, i) => pos.set(a, (i + 0.5) / r.length)));
  place();
  for (let s = 0; s < P.sweeps; s++) {
    const order = s % 2 ? [...rows.keys()].reverse() : [...rows.keys()];
    for (const ri of order) {
      const bary = a => { const xs = [...nb.get(a)].filter(b => layer.get(b) !== layer.get(a)).map(b => pos.get(b)); return xs.length ? xs.reduce((m, x) => m + x, 0) / xs.length : pos.get(a); };
      const bc = new Map(rows[ri].map(a => [a, bary(a)]));
      rows[ri].sort((x, y) => bc.get(x) - bc.get(y) || cmp(x, y));
      rows[ri].forEach((a, i) => pos.set(a, (i + 0.5) / rows[ri].length));
    }
  }
  const box = new Map();
  for (const a of ids) {
    const n = byArea.get(a).length, cols = Math.max(1, Math.min(P.cols_max, Math.ceil(Math.sqrt(n * 1.6)))), nr = Math.ceil(n / cols);
    box.set(a, { id: a, files: byArea.get(a), cols, w: Math.max(cols * P.cell + 2 * P.pad, `${a} ${n}`.length * P.char_px + 2 * P.pad), h: P.head + nr * P.cell + P.pad, x: 0, y: 0 });
  }
  const rowW = rows.map(r => r.reduce((m, a) => m + box.get(a).w, 0) + P.gap_x * Math.max(0, r.length - 1)), W = Math.max(1, ...rowW) + 2 * P.gap_x;
  let y = P.gap_x;
  rows.forEach((r, i) => {
    let x = (W - rowW[i]) / 2;
    for (const a of r) { const b = box.get(a); b.x = r1(x); b.y = y; x += b.w + P.gap_x; }
    y += Math.max(0, ...r.map(a => box.get(a).h)) + P.gap_y;
  });
  const H = y - P.gap_y + P.gap_x, maxN = Math.max(1, ...pairs.map(b => b.n));
  // band ends spread along a box's edge, ordered by the other end's x so bands cross less
  const ends = new Map(), endKey = (a, side) => `${a}\n${side}`, cx = a => box.get(a).x + box.get(a).w / 2;
  const sideOf = b => { const d = box.get(b.to).y - box.get(b.from).y; return d > 0 ? ['bottom', 'top'] : d < 0 ? ['top', 'bottom'] : ['top', 'top']; };   // same row: an arc over the top
  for (const b of pairs) { const [s, t] = sideOf(b); for (const [a, side, other] of [[b.from, s, b.to], [b.to, t, b.from]]) { const k = endKey(a, side); if (!ends.has(k)) ends.set(k, []); ends.get(k).push({ b, other }); } }
  for (const l of ends.values()) l.sort((p, q) => cx(p.other) - cx(q.other) || cmp(p.other, q.other));
  const at = (a, side, b) => { const l = ends.get(endKey(a, side)), k = l.findIndex(e => e.b === b), B = box.get(a); return [r1(B.x + B.w * (k + 1) / (l.length + 1)), side === 'bottom' ? B.y + B.h : B.y]; };
  const bands = pairs.map(b => {
    const [s, t] = sideOf(b), [x1, y1] = at(b.from, s, b), [x2, y2] = at(b.to, t, b);
    const c = s === t ? -P.gap_y / 2 : (y2 - y1) / 2, c2 = s === t ? c : -c;   // the control points: away from each box, along the flow
    const d = `M${x1} ${y1}C${x1} ${r1(y1 + c)} ${x2} ${r1(y2 + c2)} ${x2} ${y2}`;
    return { ...b, w: r1(P.band_min_px + (P.band_max_px - P.band_min_px) * b.n / maxN), d };
  });
  return { commit: g.stamp.commit, indexed_at: g.stamp.indexed_at, files, areas: ids.map(a => box.get(a)), bands, dependents, W: r1(W), H: r1(H) };
}

const STYLE = `html,body{margin:0;overflow-x:hidden;background:#fff;color:#1d2433;font:13px/1.4 system-ui,sans-serif}
main{max-width:100%;padding:8px;box-sizing:border-box}header{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;margin-bottom:6px}
.mute{color:#5b6475}.mono{font-family:ui-monospace,monospace}select{max-width:100%;min-width:0;font:inherit}
svg{display:block;width:100%;height:auto;max-width:100%;max-height:calc(100vh - 90px)}.area rect.box{fill:#f4f6fa;stroke:#9aa4b6}.area text{font:12px ui-monospace,monospace;fill:#1d2433}
.band{fill:none;stroke:#5a7bd6;stroke-opacity:.28}.band:hover{stroke-opacity:.6}rect.f{fill:#c9d1e0;cursor:pointer}rect.f:hover{fill:#7d8bab}
rect.f.h0{fill:#d6452b}rect.f.h1{fill:#e8a33c}rect.f.h2{fill:#f3d79a}#deps{margin-top:8px;overflow-wrap:anywhere}#deps ol{margin:4px 0;padding-left:20px}
@media (prefers-color-scheme:dark){html,body{background:#14171f;color:#dfe4ee}.mute{color:#9aa4b6}.area rect.box{fill:#1d2230;stroke:#465068}.area text{fill:#dfe4ee}rect.f{fill:#3a4358}}`;
// the click: the picked file, its direct importers, then everything that reaches it, lit and listed (BFS over the shipped dependents); #file=<path> picks one on load (a link to a file's map)
const SCRIPT = `(()=>{const D=JSON.parse(document.getElementById('mapdata').textContent),R=[...document.querySelectorAll('rect.f')],by=[];R.forEach(r=>by[+r.dataset.i]=r);
const out=document.getElementById('deps'),sel=document.getElementById('pick');
function pick(i){R.forEach(r=>r.classList.remove('h0','h1','h2'));out.textContent='';if(!(i>=0))return;const depth=new Map([[i,0]]),q=[i];
for(let k=0;k<q.length;k++)for(const j of D.dep[q[k]])if(!depth.has(j)){depth.set(j,depth.get(q[k])+1);q.push(j);}
for(const [j,d] of depth)by[j]&&by[j].classList.add(d===0?'h0':d===1?'h1':'h2');
const rows=q.slice(1),direct=rows.filter(j=>depth.get(j)===1).length,h=document.createElement('div');
h.textContent=D.files[i]+': '+direct+' direct importer'+(direct===1?'':'s')+', '+rows.length+' file'+(rows.length===1?'':'s')+' depend on it in all';out.append(h);
if(rows.length){const ol=document.createElement('ol');for(const j of rows){const li=document.createElement('li');li.className='mono';li.textContent=D.files[j]+(depth.get(j)>1?'  (depth '+depth.get(j)+')':'');ol.append(li);}out.append(ol);}
if(sel)sel.value=String(i);}
document.getElementById('map').addEventListener('click',e=>{const r=e.target.closest&&e.target.closest('rect.f');if(r)pick(+r.dataset.i);});
if(sel)sel.addEventListener('change',()=>pick(sel.value===''?-1:+sel.value));
const h=/^#file=(.+)$/.exec(location.hash);if(h)pick(D.files.indexOf(decodeURIComponent(h[1])));})();`;
const h256 = s => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;

/** the model -> { html, csp }: one self-contained page (no network; the CSP meta hashes its one style and its one script) */
export function renderMap(m) {
  const P = MAP_GRAPH, csp = `default-src 'none'; style-src ${h256(STYLE)}; script-src ${h256(SCRIPT)}`;
  const bands = m.bands.map(b => `<path class="band" d="${b.d}" stroke-width="${b.w}"><title>${xe(b.from)} → ${xe(b.to)}: ${b.n} import${b.n === 1 ? '' : 's'}</title></path>`).join('');
  const areas = m.areas.map(a => `<g class="area" data-a="${xe(a.id)}"><rect class="box" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="4"/><text x="${r1(a.x + P.pad)}" y="${a.y + 15}">${xe(a.id)} <tspan class="mute">${a.files.length}</tspan></text>`
    + a.files.map((i, k) => `<rect class="f" data-i="${i}" x="${r1(a.x + P.pad + (k % a.cols) * P.cell)}" y="${a.y + P.head + Math.floor(k / a.cols) * P.cell}" width="${P.cell - 2}" height="${P.cell - 2}"><title>${xe(m.files[i])}</title></rect>`).join('') + '</g>').join('');
  const data = JSON.stringify({ files: m.files, dep: m.dependents }).replace(/</g, '\\u003c');
  const opts = m.files.map((f, i) => `<option value="${i}">${xe(f)}</option>`).join('');
  const edges = m.dependents.reduce((n, d) => n + d.length, 0);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code map (import graph)</title><style>${STYLE}</style></head><body><main>
<header><span class="mute">imports measured by norn-code at <span class="mono">${xe(String(m.commit).slice(0, 12))}</span> · ${m.files.length} files in ${m.areas.length} areas, ${edges} imports · area = the folder, ${P.area_depth} levels deep · band width = imports between two areas · importers above</span>
<select id="pick" aria-label="file"><option value="">pick a file (or click one)</option>${opts}</select></header>
<svg id="map" viewBox="0 0 ${m.W} ${m.H}" role="img" aria-label="Areas of the code and the imports between them">${bands}${areas}</svg>
<div id="deps" class="small"></div></main><script type="application/json" id="mapdata">${data}</script><script>${SCRIPT}</script></body></html>`;
  return { html, csp };
}

/** draw and store the map. o: { state, repo, graph (graphAt's answer; read here when not given) } -> { drawn, sha?, why?, file? }.
 *  A graph that cannot be had is stored as n/a with its reason (the page served nothing until the next draw), never a guess. */
export function drawGraphMap({ state, repo, graph } = {}) {
  const g = graph ?? graphAt({ state, repo }), dir = graphMapDir(state), file = path.join(dir, 'index.html');
  fs.mkdirSync(dir, { recursive: true });
  if (!g.ok) { fs.rmSync(file, { force: true }); atomicWrite(path.join(dir, 'map.json'), JSON.stringify({ at: new Date().toISOString(), sha: null, na: g.why })); return { drawn: false, why: g.why }; }
  const m = layoutMap(g), { html, csp } = renderMap(m), short = m.commit.slice(0, 12);
  atomicWrite(file, html);
  atomicWrite(path.join(dir, 'map.json'), JSON.stringify({ at: new Date().toISOString(), sha: short, commit: m.commit, indexed_at: m.indexed_at, files: m.files.length, areas: m.areas.length, bands: m.bands.length,
    edges: m.dependents.reduce((n, d) => n + d.length, 0), bytes: Buffer.byteLength(html), etag: `"${sha(html).slice(0, 16)}"`, csp, na: null }));
  return { drawn: true, sha: short, file };
}

/** the Map view's line: { at, sha, commit, files, areas, bands, edges, na } | null (never drawn) */
export function graphMapAt(state) {
  const m = readJsonS(path.join(graphMapDir(state), 'map.json'));
  return m ? { at: m.at, sha: m.sha, commit: m.commit ?? null, files: m.files ?? null, areas: m.areas ?? null, bands: m.bands ?? null, edges: m.edges ?? null, na: m.na ?? null } : null;
}
/** GET /code-map/?map=graph: the drawn page under codemap.mjs's mapCsp, revalidated by ETag -> { status, headers, body } */
export function graphMapPage(state, ifNoneMatch) {
  const m = readJsonS(path.join(graphMapDir(state), 'map.json')), file = path.join(graphMapDir(state), 'index.html');
  if (!m?.sha || !fs.existsSync(file)) return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: m?.na ? `Graph map n/a: ${m.na}` : 'No graph map yet: `norn code history` draws it (the tick starts it when HEAD moves).' };
  const headers = { 'content-type': 'text/html; charset=utf-8', 'Content-Security-Policy': mapCsp(m.csp), 'Cache-Control': 'no-cache', ETag: m.etag };
  if (ifNoneMatch && ifNoneMatch === m.etag) return { status: 304, headers, body: '' };
  return { status: 200, headers, body: fs.readFileSync(file) };
}
