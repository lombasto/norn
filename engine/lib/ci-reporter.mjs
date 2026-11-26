// META-GTP-CI 1: a node:test reporter for engine/bin/ci-suite.mjs - one JSON line per failing test ({ file, name, nesting, type }).
// A parent that failed only because a subtest did (failureType subtestsFailed) is skipped: the subtest is the red.
export default async function* ciReporter(source) {
  for await (const e of source) {
    if (e.type !== 'test:fail') continue;
    const type = e.data.details?.error?.failureType ?? null;
    if (type === 'subtestsFailed') continue;
    yield JSON.stringify({ file: e.data.file ?? null, name: e.data.name, nesting: e.data.nesting, type }) + '\n';
  }
}
