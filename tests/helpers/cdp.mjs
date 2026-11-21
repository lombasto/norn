// A real headless browser page for dashboard tests (norn shot's launcher, engine/lib/shot.mjs; the Chrome DevTools protocol over
// the built-in WebSocket): open(size) -> { go(url) (waits for body data-ready), ev(expr), until(expr), close() } - a timeout throws with the page's state and the test process's loop (loopwatch.mjs). browser null = skip.
import fs from 'node:fs';
import path from 'node:path';
import { mkTmp } from './tmp.mjs';
import { mark, slowStep, loopReport } from './loopwatch.mjs';

// META-CI-FIX CI-RED-ADFF31D R2 (DEC-364): the browser's side of a gap. A CDP trace runs from the page's open (a ring buffer); each
// step drops a clock-sync marker; on the BROWSER target (a page target's trace has no network-service process); a slow / timed-out step ends the trace, summarises the events after its marker (the longest renderer
// main-thread tasks with the JS / work inside, the requests in flight, the network service's longest tasks) and starts a new one
export const TRACE_CATS = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'netlog', 'disabled-by-default-netlog', 'net', 'toplevel'];
const TASK = new Set(['RunTask', 'ThreadControllerImpl::RunTask']), isTask = n => /RunTask/.test(n);
const what = e => { const d = e.args?.data ?? {}, u = String(d.url || '').replace(/^https?:\/\/[^/]+/, '');
  return d.functionName ? `${e.name} ${d.functionName}${u ? ` ${u}:${(d.lineNumber ?? 0) + 1}` : ''}` : u ? `${e.name} ${u}` : e.name; };
export function traceSummary(evs, syncId) {
  const thread = new Map(), proc = new Map();
  for (const e of evs) if (e.ph === 'M') { if (e.name === 'thread_name') thread.set(`${e.pid}:${e.tid}`, e.args?.name); if (e.name === 'process_name') proc.set(e.pid, e.args?.name); }
  const sync = evs.find(e => e.name === 'clock_sync' && e.args?.sync_id === syncId), timed = evs.filter(e => e.ts > 0);
  let lo = Infinity, end = 0; for (const e of timed) { lo = Math.min(lo, e.ts); end = Math.max(end, e.ts + (e.dur || 0)); }   // no spread: a trace is 100k+ events
  const base = sync?.ts ?? lo;
  const at = ts => `+${Math.round((ts - base) / 1000)}`, ms = us => Math.round(us / 1000), win = timed.filter(e => e.ts + (e.dur || 0) >= base);
  const seen = new Set(), tasks = win.filter(e => e.ph === 'X' && TASK.has(e.name) && thread.get(`${e.pid}:${e.tid}`) === 'CrRendererMain').sort((a, b) => b.dur - a.dur)
    .filter(t => { if ([...seen].some(o => o.pid === t.pid && o.tid === t.tid && t.ts >= o.ts && t.ts < o.ts + o.dur)) return false; seen.add(t); return true; }).slice(0, 3);   // RunTask nests ThreadControllerImpl::RunTask
  const inner = t => win.filter(e => e.ph === 'X' && e.pid === t.pid && e.tid === t.tid && !isTask(e.name) && e.ts >= t.ts && e.ts < t.ts + t.dur)
    .sort((a, b) => (b.name === 'FunctionCall') - (a.name === 'FunctionCall') || b.dur - a.dur)[0];
  const req = new Map();
  for (const e of win) { const d = e.args?.data; if (!d?.requestId) continue;
    if (e.name === 'ResourceSendRequest') req.set(d.requestId, { url: String(d.url || '').replace(/^https?:\/\/[^/]+/, ''), t0: e.ts, t1: null });
    else if (e.name === 'ResourceFinish' && req.has(d.requestId)) req.get(d.requestId).t1 = e.ts; }
  const reqs = [...req.values()].map(r => ({ ...r, us: (r.t1 ?? end) - r.t0 })).sort((a, b) => b.us - a.us).slice(0, 4);
  const net = win.filter(e => e.ph === 'X' && /network/i.test(proc.get(e.pid) || '') && !isTask(e.name)).sort((a, b) => b.dur - a.dur).slice(0, 3);
  const open = new Map(), spans = [];   // netlog events are async begin / end pairs: the longest spans (a resolver / connect / cache stall)
  for (const e of timed) if (/netlog/.test(e.cat)) { const k = `${e.pid}:${e.id ?? e.id2?.local ?? e.id2?.global}:${e.name}`;
    if (e.ph === 'b') open.set(k, e); else if (e.ph === 'e' && open.has(k)) { const b = open.get(k); open.delete(k); if (e.ts >= base) spans.push({ name: e.name, t0: b.ts, us: e.ts - b.ts }); } }
  const lifetime = /_ALIVE$|ENTRY_IMPL$/, closed = spans.filter(x => !lifetime.test(x.name)), opened = [...open.values()].filter(b => !lifetime.test(b.name)).map(b => ({ name: `${b.name} (open)`, t0: b.ts, us: end - b.ts }));
  const netlog = [...closed.sort((a, b) => b.us - a.us).slice(0, 3), ...opened.sort((a, b) => b.us - a.us).slice(0, 2)];   // object-lifetime spans are always open: not a stall
  return `trace: renderer tasks: ${tasks.map(t => { const i = inner(t); return `${ms(t.dur)} ms at ${at(t.ts)}${i ? ` (${what(i)} ${ms(i.dur)} ms)` : ''}`; }).join(', ') || 'none'}${sync ? '' : ' (no clock sync: the whole trace)'}; ${ms(end - base)} ms traced
trace: network: ${reqs.map(r => `${r.url} ${ms(r.us)} ms at ${at(r.t0)}${r.t1 ? '' : ' unfinished'}`).join(', ') || 'no request sent'}; network service: ${net.map(e => `${e.name} ${ms(e.dur)} ms at ${at(e.ts)}`).join(', ') || 'no task'}; netlog: ${netlog.map(x => `${x.name} ${ms(x.us)} ms at ${at(x.t0)}`).join(', ') || 'none'}`;
}

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
  let port, ws;
  try {
    port = await shotLib.waitDevToolsPort({ browser, profile, child });
    let page = null;
    for (let i = 0; i < 100 && !page; i++) { try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { /* not yet */ } if (!page) await new Promise(r => setTimeout(r, 100)); }
    if (!page) throw new Error(`the browser (${browser.exe}) is up on port ${port} but has no page target after 10 s; its stderr ends:\n${shotLib.stderrTail(profile)}`);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`the DevTools WebSocket of ${browser.exe} failed`)); });
  } catch (e) { await shotLib.closeBrowser(child, profile, { dir: path.dirname(path.dirname(profile)) }); throw e; }
  let id = 0; const pend = new Map(), on = new Map();
  // META-CI-WORKCLASS R2 (DEC-332): the page's own story, kept for a timeout's message - console errors, uncaught exceptions /
  // unhandled rejections (Runtime.exceptionThrown), browser log errors (a failed module load) and the requests still in flight
  const story = { errors: [], net: new Map() }, note = t => { story.errors.push(t.slice(0, 300)); if (story.errors.length > 20) story.errors.shift(); };
  const watch = {
    'Runtime.consoleAPICalled': p => { if (p.type === 'error' || p.type === 'warning' || p.type === 'assert') note(`console.${p.type}: ${p.args.map(a => a.value ?? a.description ?? a.type).join(' ')}`); },
    'Runtime.exceptionThrown': p => note(`exception: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`),
    'Log.entryAdded': p => { if (p.entry.level === 'error') note(`log: ${p.entry.text} ${p.entry.url ?? ''}`); },
    'Network.requestWillBeSent': p => story.net.set(p.requestId, { url: p.request.url, t0: Date.now() }),
    'Network.loadingFinished': p => story.net.delete(p.requestId),
    'Network.loadingFailed': p => { const r = story.net.get(p.requestId); if (r) note(`request failed: ${r.url} ${p.errorText}`); story.net.delete(p.requestId); },
  };
  // the trace's own socket: the browser target
  const trace = { on: false, evs: [], done: null }, bws = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
  let bid = 0; const bpend = new Map();
  bws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && bpend.has(m.id)) { bpend.get(m.id)(m.result ?? { error: m.error }); bpend.delete(m.id); return; }
    if (m.method === 'Tracing.dataCollected') trace.evs.push(...m.params.value); else if (m.method === 'Tracing.tracingComplete') trace.done?.(); };
  const bsend = (method, params = {}) => new Promise(r => { const i = ++bid; bpend.set(i, r); bws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? { error: m.error }); pend.delete(m.id); return; }
    if (m.method && watch[m.method]) watch[m.method](m.params);
    if (m.method && on.has(m.method)) { on.get(m.method)(m.params); on.delete(m.method); } };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.value;
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
  const traceStart = async () => { trace.evs = []; const r = await bsend('Tracing.start', { transferMode: 'ReportEvents',
    traceConfig: { recordMode: 'recordContinuously', includedCategories: TRACE_CATS, excludedCategories: ['*'] } }); trace.on = !r?.error; trace.why = r?.error?.message; };
  await traceStart();
  const step = () => { const m = mark(); m.sync = `step-${m.t}`; if (trace.on) bsend('Tracing.recordClockSyncMarker', { syncId: m.sync }); return m; };
  // the slow path only: end the trace, wait for its events (10 s cap: a blocked renderer flushes late), summarise, record again
  const traceReport = async m => {
    if (!trace.on) return `trace: not recording (${trace.why || 'Tracing.start failed'})`;
    const ended = new Promise(r => { trace.done = r; }); trace.on = false; const r = await bsend('Tracing.end');
    const ok = await Promise.race([ended.then(() => true), new Promise(r => setTimeout(() => r(false), 10000))]);
    let s; try { s = traceSummary(trace.evs, m.sync); } catch (e) { s = `trace: no summary (${e.message})`; }
    await traceStart(); return ok ? s : `${s}
trace: (incomplete: no tracingComplete in 10 s${r?.error ? `; Tracing.end: ${r.error.message}` : ''})`;
  };
  const pageState = async m => {
    const st = await Promise.race([ev(`JSON.stringify({ href: location.href, readyState: document.readyState, dataset: { ...document.body?.dataset }, error: document.querySelector('#error')?.textContent || null })`),
      new Promise(r => setTimeout(() => r('(the page did not answer Runtime.evaluate in 5 s: its main thread is blocked)'), 5000))]);
    const now = Date.now(), pending = [...story.net.values()].map(r => `${r.url.replace(/^https?:\/\/[^/]+/, '')} (${now - r.t0} ms)`);
    return `page: ${st}
pending: ${pending.join(', ') || 'none'}
errors: ${story.errors.join(' | ') || 'none'}
${await loopReport(m)}
${await traceReport(m)}`;
  };
  // a timeout FAILS with the page's state (the limit is the caller's; nothing here retries or waits longer)
  const until = async (expr, ms = 15000, m = step()) => { const t0 = Date.now(); for (;;) { const v = await ev(expr); if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`until(${expr}) still falsy after ${ms} ms (last value ${JSON.stringify(v)})
${await pageState(m)}`); await new Promise(r => setTimeout(r, 100)); } };
  const pg = {
    send, ev, until, slow: null,
    async go(url, ms = 15000) {
      pg.slow = null; const m = step(), t0 = Date.now(), loaded = new Promise(r => on.set('Page.loadEventFired', () => r(true)));
      story.net.clear(); story.errors.length = 0; await send('Page.navigate', { url });
      if (!await Promise.race([loaded, new Promise(r => setTimeout(() => r(false), ms))])) throw new Error(`go(${url}): no load event in ${ms} ms
${await pageState(m)}`);
      // META-CI-WORKCLASS R3: the stall is intermittent - a slow go() (> 2 s, or a loop gap > 500 ms) that still made it also says whose time it was (stderr, CI log)
      try { const v = await until('document.body.dataset.ready', Math.max(0, ms - (Date.now() - t0)), m);
        const r = await slowStep(m, `go(${url})`, { log: () => {} });
        if (r) { pg.slow = `${r}${await traceReport(m)}
`; process.stderr.write(pg.slow); } return v; }
      catch (e) { throw new Error(`go(${url}): body.dataset.ready not set in ${ms} ms
${e.message}`); }
    },
    async close() { try { ws.close(); bws.close(); } catch { /* the socket is already closed: nothing to do, the browser is closed next */ } return shotLib.closeBrowser(child, profile, { dir: path.dirname(path.dirname(profile)) }); },
  };
  return pg;
}
