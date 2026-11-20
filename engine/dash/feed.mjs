// Live feed hub (LANE-MAP-DESIGN 3): GET /api/feed = Server-Sent Events per run. One tailer per run, shared by its clients
// (refcounted; it stops lingerMs after the last client leaves); it polls the run's files every pollMs through the run's harness
// adapter feed() (the hub never parses a CLI format). SSE id = the cursor after a record, so a reconnect (Last-Event-ID)
// resumes without repeats. Cost per tailer and poll: a stat + the appended bytes of 1-2 files (KBs), no LLM, no git beyond the
// caller's cached `git log -1`. At most `max` live clients per dashboard (browsers allow ~6 connections per host).

export const encodeCursor = c => Buffer.from(JSON.stringify(c)).toString('base64url');
export function decodeCursor(s) {
  if (typeof s !== 'string' || !s || s.length > 2048) return null;
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
    return Object.values(c).every(v => Number.isSafeInteger(v) && v >= 0) ? c : null;
  } catch { return null; }
}
// an event is covered by a cursor when the cursor is at or past it in every file
const covered = (at, cur) => !!cur && Object.entries(at).every(([k, v]) => (cur[k] ?? -1) >= v);
const advance = (cur, at) => { const o = { ...(cur || {}) }; for (const [k, v] of Object.entries(at)) o[k] = Math.max(o[k] ?? 0, v); return o; };

/**
 * o: { pollMs = 2000, lingerMs = 10000, max = 4 }. join(key, open, res, cursor): open() -> source { poll(cursor) -> { events, cursor },
 * head(ctx) -> object, ended() -> bool } or throws ({ status }); res = the http response. -> false when the cap is reached.
 * o.full (RM-36, a fresh drawer): the catch-up reads the run from its start (poll(cursor, true)), not the backlog window.
 */
export function createFeeds({ pollMs = 2000, lingerMs = 10000, max = 4 } = {}) {
  const tailers = new Map();
  let clients = 0;

  const write = (res, event, data, id) => { try { res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } };
  // send the events a client has not seen; the id rides on the last event of each record (events of one record share `at`)
  function deliver(t, c, events) {
    // usage records only feed the head (context), they are not lines of the feed
    const base = c.cursor, fresh = events.filter(e => !covered(e.at, base)), out = fresh.filter(e => e.kind !== 'usage');
    out.forEach(({ at, ...ev }, i) => {
      const last = i === out.length - 1 || JSON.stringify(out[i + 1].at) !== JSON.stringify(at);
      write(c.res, 'ev', ev, last ? encodeCursor(advance(base, at)) : null);
    });
    for (const e of fresh) c.cursor = advance(c.cursor, e.at);
  }
  const noteCtx = (t, events) => { for (const e of events) if (e.kind === 'usage') { t.ctx = e.ctx; t.peak = Math.max(t.peak ?? 0, e.ctx ?? 0) || null; if (Number.isFinite(e.window)) t.window = e.window; } };
  // META-DASH-ASYNC R1 (DEC-338): the source's poll / head / ended may be async (the dash server's are: fs.promises) - awaited here
  const headOf = async t => { try { return await t.source.head({ ctx: t.ctx ?? null, peak: t.peak ?? null, window: t.window ?? null }); } catch { return null; } };
  async function sendHead(t, only) {
    const h = await headOf(t); if (!h) return;
    const s = JSON.stringify(h);
    if (only) { write(only.res, 'head', h); if (!t.head) t.head = s; return; }
    if (s === t.head) return;
    t.head = s; for (const c of t.clients) write(c.res, 'head', h);
  }
  function finish(t, c) { write(c.res, 'end', { run: t.key }); try { c.res.end(); } catch { /* gone */ } }
  function stop(t) { clearInterval(t.timer); clearTimeout(t.linger); tailers.delete(t.key); }
  const isEnded = async t => { try { return await t.source.ended(); } catch { return false; } };
  async function tick(t) {
    if (t.busy) return;   // one poll at a time per tailer: a slow one is skipped over, never queued
    t.busy = true;
    try {
      const ended = await isEnded(t);   // asked BEFORE the poll: every line written before the run's end record is read first
      let r; try { r = await t.source.poll(t.cursor); } catch { return; }
      t.cursor = r.cursor; noteCtx(t, r.events);
      for (const c of t.clients) deliver(t, c, r.events);
      await sendHead(t);
      if (ended) { for (const c of [...t.clients]) finish(t, c); }
    } finally { t.busy = false; }
  }
  function leave(t, c) {
    if (!t.clients.delete(c)) return;
    clients--;
    if (!t.clients.size) { clearTimeout(t.linger); t.linger = setTimeout(() => { if (!t.clients.size) stop(t); }, lingerMs); t.linger.unref?.(); }
  }

  /** -> Promise<false at the cap | true> */
  async function join(key, open, res, cursor = null, { full = false } = {}) {
    if (clients >= max) return false;
    let t = tailers.get(key);
    if (!t) {
      t = { key, source: open(), clients: new Set(), cursor: null, head: null, ctx: null, timer: null, linger: null, busy: false };
      tailers.set(key, t);
    }
    clearTimeout(t.linger);
    const c = { res, cursor: cursor || null };
    t.clients.add(c); clients++;   // the seat is taken before the first await (the cap holds for clients joining at once)
    res.on('close', () => leave(t, c));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    // catch-up from the client's own cursor (null = the backlog window, or the start with full); a fresh tailer continues from there.
    // One poll reads at most FEED_MAX bytes: it polls again until the cursor stops moving, so a long run (or an old Last-Event-ID)
    // is caught up whole - the shared tailer polls from ITS cursor, so a gap left here would never be filled
    const ended = await isEnded(t);
    let r;
    for (let i = 0, first = !c.cursor && full; i < 64; i++, first = false) {
      const before = JSON.stringify(c.cursor);
      try { r = await t.source.poll(c.cursor, first); } catch { r = { events: [], cursor: c.cursor || {} }; }
      noteCtx(t, r.events); deliver(t, c, r.events); c.cursor = advance(c.cursor, r.cursor);
      if (JSON.stringify(c.cursor) === before) break;
    }
    if (!t.timer && tailers.get(key) === t) { t.cursor = r.cursor; t.timer = setInterval(() => tick(t), pollMs); t.timer.unref?.(); }
    await sendHead(t, c);
    if (ended) finish(t, c);
    return true;
  }
  const close = () => { for (const t of [...tailers.values()]) { for (const c of t.clients) { try { c.res.end(); } catch { /* gone */ } } stop(t); } };
  return { join, close, tailers: () => tailers.size, clients: () => clients };
}
