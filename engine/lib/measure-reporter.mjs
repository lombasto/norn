// META-TEND TESTS: a node:test reporter for `ci-suite --measure` - one JSON line per test ({ t: 'test', file, name, nesting, line, ms, ok }),
// per describe() suite ({ t: 'suite', name, nesting, line, ms }: the Tests tab groups by it) and, under --experimental-test-coverage, one
// per covered source file ({ t: 'cov', path, total, lines: [covered line numbers] }).
export default async function* measureReporter(source) {
  for await (const e of source) {
    if (e.type === 'test:pass' || e.type === 'test:fail') {
      const suite = e.data.details?.type === 'suite', ms = Math.round((e.data.details?.duration_ms ?? 0) * 10) / 10;
      yield JSON.stringify(suite ? { t: 'suite', name: e.data.name, nesting: e.data.nesting, line: e.data.line ?? null, ms }
        : { t: 'test', file: e.data.file ?? null, name: e.data.name, nesting: e.data.nesting, line: e.data.line ?? null, ms, ok: e.type === 'test:pass' }) + '\n';
    } else if (e.type === 'test:coverage') {
      for (const f of e.data.summary?.files ?? []) {
        yield JSON.stringify({ t: 'cov', path: f.path, total: f.totalLineCount, lines: (f.lines ?? []).filter(l => l.count > 0).map(l => l.line) }) + '\n';
      }
    }
  }
}
