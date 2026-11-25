// RM-a-66 (Code > Map from the code graph, no model): lib/codemapgraph.mjs over a SYNTHETIC Graph (the reader's shape, docs/code-graph.md) -
// the area rule (folders first), the layered layout (importers above what they import), bands as wide as the import edges between two
// areas, the click's dependents (direct + transitive) shipped as data, the drawn file under <state>/code/graphmap with its CSP hashes, an
// n/a graph stored as n/a (never a guess), and GET /code-map/?map=graph served under codemap.mjs's mapCsp with an ETag. Sandbox only (mkTmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { areaOf, layoutMap, renderMap, drawGraphMap, graphMapAt, graphMapPage, MAP_GRAPH } from '../engine/lib/codemapgraph.mjs';

test.after(cleanTmp);
const C = 'c0ffee'.padEnd(40, '0');
const FILES = ['README.js', 'app/cli/main.mjs', 'app/cli/args.mjs', 'app/lib/core.mjs', 'app/lib/util.mjs', 'app/lib/deep/x.mjs', 'tests/core.test.mjs', 'vendor/v.js', 'Cargo.toml'];
const e = (from, to, kind = 'import') => ({ from, to, line: 1, col: 1, kind, how: 'exact', spec: to, trust: 'unmeasured' });
const graph = (o = {}) => ({ ok: true, stamp: { commit: C, tree: 'f'.repeat(40), indexed_at: '2026-11-24T10:00:00Z', age_s: 5, asked: 'HEAD', exact: true, worktree: false }, root: '/r', prefix: '',
  files: new Map(FILES.map(f => [f, { lang: f.endsWith('.toml') ? null : 'javascript', excluded: f.startsWith('vendor/') ? 'vendored' : null }])),
  edges: [e('app/cli/main.mjs', 'app/cli/args.mjs'), e('app/cli/main.mjs', 'app/lib/core.mjs'), e('app/cli/args.mjs', 'app/lib/util.mjs'), e('app/cli/main.mjs', 'app/lib/util.mjs', 'dynamic'),
    e('app/lib/core.mjs', 'app/lib/util.mjs'), e('app/lib/deep/x.mjs', 'app/lib/util.mjs'), e('tests/core.test.mjs', 'app/lib/core.mjs'), e('app/lib/core.mjs', 'vendor/v.js'),
    e('app/lib/core.mjs', 'app/lib/core.mjs'), e('app/lib/util.mjs', 'app/lib/core.mjs', 'package-init')], unresolved: [], indexed: null, ...o });

test('areaOf: folders first - a file\'s folder cut to MAP_GRAPH.area_depth segments; a file at the project root is the "(root)" area', () => {
  assert.equal(MAP_GRAPH.area_depth, 2);
  assert.equal(areaOf('app/lib/deep/x.mjs'), 'app/lib'); assert.equal(areaOf('app/cli/main.mjs'), 'app/cli'); assert.equal(areaOf('tests/core.test.mjs'), 'tests'); assert.equal(areaOf('README.js'), '(root)');
});

test('layoutMap: graph-language, non-excluded files of the project in areas; bands = distinct import edges between two areas; importers above', () => {
  const m = layoutMap(graph());
  assert.equal(m.commit, C);
  assert.deepEqual(m.areas.map(a => [a.id, a.files.map(i => m.files[i])]).sort(), [['(root)', ['README.js']], ['app/cli', ['app/cli/args.mjs', 'app/cli/main.mjs']], ['app/lib', ['app/lib/core.mjs', 'app/lib/deep/x.mjs', 'app/lib/util.mjs']], ['tests', ['tests/core.test.mjs']]]);
  assert.ok(!m.files.includes('vendor/v.js') && !m.files.includes('Cargo.toml'), 'excluded files and manifests are not drawn');
  const band = (a, b) => m.bands.find(x => x.from === a && x.to === b)?.n ?? 0;
  assert.equal(band('app/cli', 'app/lib'), 3, 'main->core, args->util, main->util (dynamic counts: FAN_KINDS)');
  assert.equal(band('tests', 'app/lib'), 1); assert.equal(m.bands.length, 2, 'no band inside one area, none to an excluded file');
  const w = Object.fromEntries(m.bands.map(b => [b.from, b.w]));
  assert.ok(w['app/cli'] > w.tests && w.tests >= MAP_GRAPH.band_min_px && w['app/cli'] <= MAP_GRAPH.band_max_px, 'band width grows with its edges');
  const at = id => m.areas.find(a => a.id === id);
  assert.ok(at('app/cli').y < at('app/lib').y && at('tests').y < at('app/lib').y, 'an importer sits above the area it imports');
  for (const a of m.areas) for (const b of m.areas) if (a !== b && a.y === b.y) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x, 'boxes of one layer do not overlap');
  const dep = f => m.dependents[m.files.indexOf(f)].map(i => m.files[i]).sort();
  assert.deepEqual(dep('app/lib/util.mjs'), ['app/cli/args.mjs', 'app/cli/main.mjs', 'app/lib/core.mjs', 'app/lib/deep/x.mjs'], 'direct importers; no package-init edge, no self-edge');
  assert.deepEqual(dep('README.js'), []);
  assert.deepEqual(layoutMap(graph()), m, 'deterministic');
});

test('layoutMap: a monorepo project draws only its own folder (Graph.prefix), paths shown project-relative', () => {
  const m = layoutMap(graph({ prefix: 'app/' }));
  assert.deepEqual([...m.files].sort(), ['cli/args.mjs', 'cli/main.mjs', 'lib/core.mjs', 'lib/deep/x.mjs', 'lib/util.mjs']);
  assert.deepEqual(m.bands.map(b => [b.from, b.to, b.n]), [['cli', 'lib', 3], ['lib/deep', 'lib', 1]], 'the area depth counts from the project folder');
});

test('renderMap: one self-contained page - SVG areas + bands, the dependents as data, the click script; CSP meta hashes its one style and script', () => {
  const { html, csp } = renderMap(layoutMap(graph()));
  const h = s => `'sha256-${crypto.createHash('sha256').update(s).digest('base64')}'`;
  const style = /<style>([^]*?)<\/style>/.exec(html)[1], script = /<script>([^]*?)<\/script>/.exec(html)[1];
  assert.match(csp, new RegExp(`style-src ${h(style).replace(/[+/]/g, '\\$&')}`)); assert.match(csp, new RegExp(`script-src ${h(script).replace(/[+/]/g, '\\$&')}`));
  assert.ok(html.includes(`content="${csp}"`), 'the CSP is in the page\'s meta (mapCsp keeps it, adds the sandbox)');
  assert.doesNotMatch(html, /\sstyle="/, 'no inline style attribute: the hashed style-src would refuse it');
  assert.doesNotMatch(html, /https?:\/\//, 'nothing loads from the network');
  assert.match(html, /<g class="area" data-a="app\/lib"/); assert.match(html, /<path class="band"[^>]*stroke-width="[\d.]+"[^>]*><title>app\/cli → app\/lib: 3 imports<\/title>/);
  assert.match(html, /<rect class="f" data-i="\d+"[^>]*><title>app\/lib\/util\.mjs<\/title>/);
  assert.match(html, /<script type="application\/json" id="mapdata">/); assert.match(html, /id="deps"/);
  assert.match(html, new RegExp(`${C.slice(0, 12)}`), 'the stamp: the indexed commit');
  assert.match(html, /measured[^<]*norn-code/i, 'says the imports are measured by the extractor');
  assert.match(html, /overflow-x:hidden/, 'phone-safe: the frame never scrolls sideways');
  assert.equal(renderMap(layoutMap(graph())).html, html, 'deterministic');
});

test('drawGraphMap: stores index.html + map.json under <state>/code/graphmap; an n/a graph is stored as n/a; GET /code-map/?map=graph under mapCsp with an ETag', () => {
  const state = path.join(mkTmp('cmg-'), 'state');
  assert.equal(graphMapAt(state), null); assert.equal(graphMapPage(state).status, 404);
  const r = drawGraphMap({ state, graph: graph() });
  assert.equal(r.drawn, true); assert.equal(r.sha, C.slice(0, 12));
  assert.ok(fs.existsSync(path.join(state, 'code', 'graphmap', 'index.html')));
  const at = graphMapAt(state);
  assert.deepEqual([at.sha, at.commit, at.files, at.areas, at.bands, at.na], [C.slice(0, 12), C, 7, 4, 2, null]);
  const p = graphMapPage(state), csp = p.headers['Content-Security-Policy'];
  assert.equal(p.status, 200); assert.equal(p.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'sha256-/); assert.match(csp, /connect-src 'none'/); assert.match(csp, /frame-ancestors 'self'/); assert.match(csp, /sandbox allow-scripts/);
  assert.doesNotMatch(csp, /unsafe/);
  assert.match(p.headers.ETag, /^"[0-9a-f]{16}"$/); assert.equal(graphMapPage(state, p.headers.ETag).status, 304);
  const n = drawGraphMap({ state, graph: { ok: false, why: 'norn-code not built' } });
  assert.equal(n.drawn, false); assert.equal(graphMapAt(state).na, 'norn-code not built');
  assert.equal(graphMapPage(state).status, 404, 'n/a: no stale page served as current');
});
