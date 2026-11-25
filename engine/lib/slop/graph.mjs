// SloppaChoppa 2 S4 (SPEC 4.4 U2, U4): the import graph of a tree, read by the language packs (JS, Python, Rust) - K10's layers and
// cycles (check.mjs) and the daily fan-in / fan-out (measure.mjs) build the same edges here. Text in, edges out: no git, no check.
import { packOf } from './lang/index.mjs';

/** the edges of files (each read by its pack; a target is any file of tree) -> Map(file -> [{ to, line, text, order? }]) */
export function importGraph(files, texts, tree) {
  const has = new Set(tree), at = { has: f => has.has(f), tree, memo: {} };
  return new Map(files.map((f, k) => [f, packOf(f).imports(f, texts[k] || '', at)]));
}
// Tarjan's strongly connected components; a component of 2+ files (or a self-import) is a cycle. A layer-only edge (order: false,
// Rust's `use` inside a crate) is no load order
export function cycles(edges) {
  let n = 0; const idx = new Map(), low = new Map(), on = new Set(), stack = [], out = [];
  const visit = v => {
    idx.set(v, n); low.set(v, n); n++; stack.push(v); on.add(v);
    for (const { to } of (edges.get(v) || []).filter(e => e.order !== false && edges.has(e.to))) {
      if (!idx.has(to)) { visit(to); low.set(v, Math.min(low.get(v), low.get(to))); }
      else if (on.has(to)) low.set(v, Math.min(low.get(v), idx.get(to)));
    }
    if (low.get(v) === idx.get(v)) {
      const c = []; let w;
      do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
      if (c.length > 1 || (edges.get(v) || []).some(e => e.to === v)) out.push(c.sort());
    }
  };
  for (const v of edges.keys()) if (!idx.has(v)) visit(v);
  return out;
}
/** U2: per module of the graph its distinct importers (in) and distinct imports (out) -> Map(file -> { in, out }) */
export function fans(edges) {
  const out = new Map([...edges.keys()].map(f => [f, { in: 0, out: 0 }]));
  for (const [f, es] of edges) for (const to of new Set(es.map(e => e.to).filter(t => t !== f))) { out.get(f).out++; (out.get(to) || out.set(to, { in: 0, out: 0 }).get(to)).in++; }
  return out;
}
