// META-DASH-ASYNC R1 (DEC-338): the dash server does no sync I/O on its request / stream paths - a stalled fs read delays only its
// own request, never the event loop that serves every other request (the Windows-CI stall: readFileSync in openCards via
// /api/projects blocked the loop 1041 ms). Node docs (fs): the sync forms block the event loop; fs.promises runs on the threadpool.
// Toy: the read of one file is stalled 1 s (sync form = the thread blocks, promise form = the promise waits); a concurrent request
// to another route must answer in < 100 ms. Sandbox only: the shared dash fixture (temp dirs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers/dash-fixture.mjs';
import { record } from '../engine/lib/records.mjs';

const STALL_MS = 1000;
/** stall every read (sync or promise) of a path for which hit(path) is true; returns the undo */
function stallReads(hit) {
  const sync = fs.readFileSync, prom = fs.promises.readFile, n = { sync: 0, async: 0 };
  const is = p => typeof p === 'string' && hit(path.resolve(p));
  fs.readFileSync = function (p, ...a) {
    if (is(p)) { n.sync++; const end = Date.now() + STALL_MS; while (Date.now() < end) { /* a blocked syscall */ } }
    return sync.call(this, p, ...a);
  };
  fs.promises.readFile = async function (p, ...a) {
    if (is(p)) { n.async++; await new Promise(r => setTimeout(r, STALL_MS)); }
    return prom.call(this, p, ...a);
  };
  return { n, undo: () => { fs.readFileSync = sync; fs.promises.readFile = prom; } };
}

const CASES = [
  // [the stalled route, the file whose read stalls (under the kestrel state), the concurrent route]
  ['/api/projects', s => path.join(s, 'instructions', 'rules.json'), '/ui.mjs'],
  ['/api/inbox?project=kestrel', s => path.join(s, 'records.jsonl'), '/api/timing'],
  ['/api/inbox?project=kestrel', s => path.join(s, 'records.jsonl'), '/ui.mjs'],
];

for (const [slow, fileOf, fast] of CASES) {
  test(`a stalled read in ${slow} does not delay a concurrent ${fast}`, async () => {
    const f = await fixture();
    const rules = path.join(f.pa.state, 'instructions', 'rules.json');
    fs.mkdirSync(path.dirname(rules), { recursive: true });
    fs.writeFileSync(rules, JSON.stringify({ at: new Date().toISOString(), rules: [], retired: [], cards: [] }));
    const target = path.resolve(fileOf(f.pa.state));
    assert.ok(fs.existsSync(target), `fixture has ${target}`);
    try {
      await fetch(f.url + slow).then(r => r.text()); await fetch(f.url + fast).then(r => r.text());   // warm (module / JIT)
      // a new record: the server's cached fold is stale, so the stalled request must read the records file again
      record(f.pa.state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'a fresh record', via: 'chat' } });
      const s = stallReads(p => p.toLowerCase() === target.toLowerCase());
      try {
        const t0 = Date.now();
        const a = fetch(f.url + slow).then(async r => ({ status: r.status, ms: Date.now() - t0, body: await r.text() }));
        await new Promise(r => setTimeout(r, 50));   // the slow request is inside its stalled read now
        const t1 = Date.now(), b = await fetch(f.url + fast), bms = Date.now() - t1, bAt = Date.now() - t0;   // a blocked loop also delays this timer: bAt catches it
        assert.equal(b.status, 200); await b.text();
        const ra = await a;
        assert.equal(ra.status, 200, ra.body.slice(0, 300));
        assert.ok(s.n.sync + s.n.async >= 1, `the stalled file was read by ${slow}`);
        assert.ok(ra.ms >= STALL_MS - 50, `${slow} did wait on its own stalled read (${ra.ms} ms)`);
        assert.ok(bms < 100 && bAt < 400, `${fast} answered in ${bms} ms (${bAt} ms after ${slow} started) while ${slow} was stalled ${STALL_MS} ms (sync reads ${s.n.sync}, async ${s.n.async})`);
      } finally { s.undo(); }
    } finally { await f.done(); }
  });
}
