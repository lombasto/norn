// META-CI-FIX CI-RED-ADFF31D R2 (DEC-364): a slow / timed-out pg.go() or pg.until() names what the BROWSER did in the gap - a CDP
// trace (devtools.timeline + netlog) started with the page, summarised on the slow path only. Toys: a page script that busy-loops
// in a named function, and a fetch the server answers late; the report must name each.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { openPage, skipWhy } from './helpers/cdp.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const PAGE = {
  '/busy': `<!doctype html><body><script>function stallHere() { const t = Date.now(); while (Date.now() - t < 2500) { /* the stall */ } document.body.dataset.ready = 'busy'; }
setTimeout(stallHere, 50);</script></body>`,
  '/quick': `<!doctype html><body><script>document.body.dataset.ready = 'quick';</script></body>`,
  '/late': `<!doctype html><body><script>fetch('/api/late-one').then(r => r.text()).then(() => { document.body.dataset.ready = 'late'; });</script></body>`,
};

async function serve() {
  const s = http.createServer((q, r) => {
    if (q.url === '/api/late-one') return setTimeout(() => r.end('ok'), 2500);
    if (PAGE[q.url]) { r.setHeader('content-type', 'text/html'); return r.end(PAGE[q.url]); }
    r.statusCode = 404; r.end();
  });
  await new Promise(res => s.listen(0, '127.0.0.1', res));
  return { url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(res => { s.closeAllConnections(); s.close(res); }) };
}

// CI 44335427788 (ubuntu, HANG RED): openPage threw (no DevTools port in 30 s) before the try, so the server made before it
// stayed open and held the file to the 600 s cap. openPage runs inside the try; the finally closes what was made.
test('a slow go() report carries the browser trace of the gap: a page busy-loop is named as a long renderer task with its function', { skip: skipWhy, timeout: 120000 }, async () => {
  const srv = await serve(); let pg;
  try {
    pg = await openPage([800, 600]);
    assert.equal(await pg.go(`${srv.url}/busy`), 'busy');
    assert.match(pg.slow ?? '', /slow go\(/, 'the step was slow, so it reported');
    assert.match(pg.slow, /trace: renderer tasks: \d+ ms/, pg.slow);
    const ms = Number(pg.slow.match(/trace: renderer tasks: (\d+) ms/)[1]);
    assert.ok(ms >= 2000, `the longest renderer task covers the 2.5 s busy loop (${ms} ms)\n${pg.slow}`);
    assert.match(pg.slow, /trace: renderer tasks: \d+ ms [^\n]*stallHere/, 'the task is named by its JS function');
  } finally { await pg?.close(); await srv.close(); }
});

test('a slow go() whose page waits on a late fetch: the trace names the request in flight, the renderer idle', { skip: skipWhy, timeout: 120000 }, async () => {
  const srv = await serve(); let pg;
  try {
    pg = await openPage([800, 600]);
    assert.equal(await pg.go(`${srv.url}/late`), 'late');
    assert.match(pg.slow ?? '', /slow go\(/);
    assert.match(pg.slow, /trace: network: [^\n]*\/api\/late-one \d+ ms/, pg.slow);
    const ms = Number(pg.slow.match(/\/api\/late-one (\d+) ms/)[1]);
    assert.ok(ms >= 2000, `the request spans the server's 2.5 s (${ms} ms)\n${pg.slow}`);
  } finally { await pg?.close(); await srv.close(); }
});

test('an until() timeout carries the trace too; a quick go() reports nothing', { skip: skipWhy, timeout: 120000 }, async () => {
  const srv = await serve(); let pg;
  try {
    pg = await openPage([800, 600]);
    await assert.rejects(pg.until(`(() => { const t = Date.now(); while (Date.now() - t < 1200) {} return false; })()`, 1500),
      e => /still falsy/.test(e.message) && /trace: renderer tasks: \d+ ms/.test(e.message));
    assert.equal(await pg.go(`${srv.url}/quick`), 'quick'); assert.equal(pg.slow, null, 'a quick step: no report, no trace');
  } finally { await pg?.close(); await srv.close(); }
});

// CI 43999056272 (ubuntu, SUID sandbox): a browser that aborted with a FATAL line but did not exit cost every browser test 30 s, then
// kept its test file alive to the 600 s cap (HANG). openPage fails within seconds with the browser's stderr and ends the browser.
test('openPage: a browser that aborts on launch (FATAL, process still alive) fails fast with its stderr and is not left running', { timeout: 60000 }, async () => {
  const dir = mkTmp('meta-cdp-fatal-'), pidf = path.join(dir, 'pid'), fixture = path.join(import.meta.dirname, 'fixtures', 'edge-suid-sandbox-stderr.txt');
  const hang = `require("fs").writeFileSync(${JSON.stringify(pidf)}, String(process.pid)); process.stderr.write(require("fs").readFileSync(${JSON.stringify(fixture)}, "utf8")); setInterval(() => {}, 1e6)`;
  await assert.rejects(openPage([800, 600], { browser: { kind: 'edge', exe: process.execPath, prefix: ['-e', hang, '--'] } }), e => {
    assert.match(e.message, /no DevTools port .*FATAL on stderr, still running.*SUID sandbox misconfigured/s, 'failed on the FATAL line, not on the 30 s port wait');
    assert.match(e.message, /setuid_sandbox_host\.cc/, 'the browser\'s stderr is in the message');
    return true;
  });
  const pid = Number(fs.readFileSync(pidf, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the browser process was ended');
});
