// A real headless browser page for dashboard tests (norn shot's launcher, engine/lib/shot.mjs; the Chrome DevTools protocol over
// the built-in WebSocket): open(size) -> { go(url) (waits for body data-ready), ev(expr), until(expr), close() } - a timeout throws with the page's state. browser null = skip.
import path from 'node:path';
import { mkTmp } from './tmp.mjs';
import { timed } from './race.mjs';

let shotLib = null;
try { shotLib = await import('../../engine/lib/shot.mjs'); } catch { /* norn shot not on this branch */ }
export const browser = shotLib?.findBrowser?.() ?? null;
const installed = browser;
// test-diet S1: `norn tests run` in a lane run sets META_TEST_BROWSER=skip while policy.tests.browser = ci (the default) - CI runs them
export const skipWhy = process.env.META_TEST_BROWSER === 'skip' ? 'browser tests run in CI, not in a lane run (policy.tests.browser = ci)'
  : !shotLib ? 'engine/lib/shot.mjs (norn shot) is not on this branch' : !browser ? 'no Edge / Chrome / Chromium installed' : false;

/** o.browser: another { kind, exe, prefix? } than the installed one (a test of the launch failure path) */
export async function openPage(size = [1440, 900], { browser = installed } = {}) {
  const profile = mkTmp('meta-shot-'), child = shotLib.launchBrowser({ browser, profile, size });
  // CI 43999056272: a browser that never came up was left running - its handle held the test file open to the 600 s cap (HANG).
  // A launch that fails ends the browser before the error (with its stderr) goes to the test.
  let ws;
  try {
    const port = await shotLib.waitDevToolsPort({ browser, profile, child });
    let page = null;
    for (let i = 0; i < 100 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not yet */ } if (!page) await new Promise(r => setTimeout(r, 100)); }
    if (!page) throw new Error(`the browser (${browser.exe}) is up on port ${port} but has no page target after 10 s; its stderr ends:\n${shotLib.stderrTail(profile)}`);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`the DevTools WebSocket of ${browser.exe} failed`)); });
  } catch (e) { await shotLib.closeBrowser(child, profile, { dir: path.dirname(path.dirname(profile)) }); throw e; }
  let id = 0; const pend = new Map(), on = new Map();
  // a timeout's message tells why the page stalled: console errors, uncaught exceptions / unhandled rejections, browser log errors
  // (a failed module load) and the requests still in flight
  const story = { errors: [], net: new Map() }, note = t => { story.errors.push(t.slice(0, 300)); if (story.errors.length > 20) story.errors.shift(); };
  const watch = {
    'Runtime.consoleAPICalled': p => { if (p.type === 'error' || p.type === 'warning' || p.type === 'assert') note(`console.${p.type}: ${p.args.map(a => a.value ?? a.description ?? a.type).join(' ')}`); },
    'Runtime.exceptionThrown': p => note(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`),
    'Log.entryAdded': p => { if (p.entry.level === 'error') note(`log: ${p.entry.text} ${p.entry.url ?? ''}`); },
    'Network.requestWillBeSent': p => story.net.set(p.requestId, { url: p.request.url, t0: Date.now() }),
    'Network.loadingFinished': p => story.net.delete(p.requestId),
    'Network.loadingFailed': p => { const r = story.net.get(p.requestId); if (r) note(`request failed: ${r.url} ${p.errorText}`); story.net.delete(p.requestId); },
  };
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? { error: m.error }); pend.delete(m.id); return; }
    if (m.method && watch[m.method]) watch[m.method](m.params);
    if (m.method && on.has(m.method)) { on.get(m.method)(m.params); on.delete(m.method); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
  const pageState = async () => {
    const st = await timed(ev(`JSON.stringify({ href: location.href, readyState: document.readyState, dataset: { ...document.body?.dataset }, error: document.querySelector('#error')?.textContent || null })`),
      5000, '(the page did not answer Runtime.evaluate in 5 s: its main thread is blocked)');
    const now = Date.now(), pending = [...story.net.values()].map(r => `${r.url.replace(/^https?:\/\/[^/]+/, '')} (${now - r.t0} ms)`);
    return `page: ${st}
pending: ${pending.join(', ') || 'none'}
errors: ${story.errors.join(' | ') || 'none'}`;
  };
  // a timeout FAILS with the page's state (the limit is the caller's; nothing here retries or waits longer)
  const until = async (expr, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await ev(expr); if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`until(${expr}) still falsy after ${ms} ms (last value ${JSON.stringify(v)})
${await pageState()}`); await new Promise(r => setTimeout(r, 100)); } };
  const pg = {
    send, ev, until,
    async go(url, ms = 15000) {
      const t0 = Date.now(), loaded = new Promise(r => on.set('Page.loadEventFired', () => r(true)));
      story.net.clear(); story.errors.length = 0; await send('Page.navigate', { url });
      if (!await timed(loaded, ms, false)) throw new Error(`go(${url}): no load event in ${ms} ms
${await pageState()}`);
      try { return await until('document.body.dataset.ready', Math.max(0, ms - (Date.now() - t0))); }
      catch (e) { throw new Error(`go(${url}): body.dataset.ready not set in ${ms} ms
${e.message}`); }
    },
    async close() { try { ws.close(); } catch { /* the socket is already closed: nothing to do, the browser is closed next */ } return shotLib.closeBrowser(child, profile, { dir: path.dirname(path.dirname(profile)) }); },
  };
  return pg;
}
