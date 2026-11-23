// SPEC dash-owner-1123 s.1.1: a node:test reporter for testcache.mjs runNode - one JSON line per finished test case
// { name, nesting, line, ms, ok }. node emits a subtest's end before its parent's, so testcache caseIds rebuilds each title path from the order.
export default async function* caseReporter(source) {
  for await (const e of source) {
    if (e.type !== 'test:pass' && e.type !== 'test:fail') continue;
    const d = e.data, ms = d.details?.duration_ms;
    yield JSON.stringify({ name: d.name, nesting: d.nesting, line: d.line ?? null, ms: Number.isFinite(ms) ? Math.round(ms * 10) / 10 : null, ok: e.type === 'test:pass' }) + '\n';
  }
}
