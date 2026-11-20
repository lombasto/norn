// The dashboard fixture's own contract: its get / post reach the in-process server however long the test process stalls between them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/dash-fixture.mjs';

// CI-44593815866: the server shares this process's event loop; a step that stalls it past the server's keep-alive timeout (5 s; a
// sync record on a starved Windows runner) left fetch's pooled socket due for the server's close, so the next request was reset
// (ECONNRESET). Two stalled rounds: the race hits the round whose socket was reused.
test('the fixture: requests after the loop stalled past the server keep-alive timeout still reach the server (no pooled socket)', async () => {
  const f = await fixture(), stall = () => { const t = Date.now(); while (Date.now() - t < f.app.server.keepAliveTimeout + 1000) { /* a stalled loop */ } };
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.get(`/api/home?project=${f.pa.name}`)).status, 200);
      stall();
      assert.equal((await f.post('/api/chat/approve', { project: f.pa.name, id: 'AP-00000000', verdict: 'approve' })).status, 404);
    }
  } finally { await f.done(); }
});
