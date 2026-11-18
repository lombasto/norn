// State stream (META-VISUAL-B S1; META-QUEUE "Queued" 4, the #4 push channel): GET /api/stream?project=<name|all> = ONE
// Server-Sent-Events stream per dashboard tab, replacing the page's 15 s full refetch. It sends what changed, when it changes:
//   state  {project, paused, quiet, tick_locked}       on connect, then on every flip (PAUSED / QUIET / tick.lock files)
//   rec    {project, file, records: [...]}            each complete line appended to a records file (records / runs /
//                                                     deliverables .jsonl), in file order; id = the byte cursor after it
//   pulse  {project, ts}                              the heartbeat dir changed (a run beat): at most one per pulseMs
//   derived {project, ts}                             something the tabs show that is not a record changed: a watched file
//                                                     (ledger, STATUS.md, live usage, docs) or an async cache the server
//                                                     refreshes (deliverables from git, account usage) - sig() differs;
//                                                     at most one per pulseMs. kick() runs every deriveMs while watched.
//                                                     DEC-341: urgent() differs (the end of a rebuild a page shows as
//                                                     refreshing) -> sent at once, outside that window; it carries any
//                                                     pending sig change. Bounded by its source (one per rebuild).
//   reset  {project, file}                            a records file shrank (rewritten): the page refetches everything
// One poller per watched set, shared by its clients (refcounted, stops lingerMs after the last leaves). Cost per poll: one
// stat per records file + flag + the hb dir, and the appended bytes - nothing when nothing changed (DEC-683: idle ~ free).
// Read-only: it never writes a record or a file (DIR-72 strictly additive).
import fs from 'node:fs';
import { encodeCursor } from './feed.mjs';

const MAX_CATCHUP = 1 << 20;   // a resume further back than 1 MB per file is a reset (the page refetches)
const CHUNK = 200;             // records per rec event

/**
 * o: { pollMs = 1000, pulseMs = 15000, deriveMs = 60000, lingerMs = 10000, max = 16 }.
 * join(key, sources, res, cursor): sources = [{ project, files: {name: path}, flags: () => object, hbDir, sig?: () => string,
 *   urgent?: () => string, kick?: () => void }] -> false at the cap.
 */
export function createStreams({ pollMs = 1000, pulseMs = 15000, deriveMs = 60000, lingerMs = 10000, max = 16 } = {}) {
  const hubs = new Map();
  let clients = 0;
  const write = (res, event, data, id) => { try { res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } };
  // META-DASH-ASYNC R1: every poll's stat / read / flag / sig is on fs.promises - a stalled syscall delays this hub's tick only
  const size = async f => { try { return (await fs.promises.stat(f)).size; } catch { return 0; } };
  const mtime = async d => { try { return (await fs.promises.stat(d)).mtimeMs; } catch { return 0; } };
  const flagsOf = async s => { try { return { project: s.project, ...(await s.flags()) }; } catch { return { project: s.project }; } };

  // complete lines in [from, to) of f -> { records, end } (end = the byte after the last newline; a partial line waits)
  async function readLines(f, from, to) {
    if (to <= from) return { records: [], end: from };
    const fh = await fs.promises.open(f, 'r');
    try {
      const b = Buffer.alloc(to - from); await fh.read(b, 0, b.length, from);
      const nl = b.lastIndexOf(10); if (nl < 0) return { records: [], end: from };
      const records = [];
      for (const l of b.subarray(0, nl).toString('utf8').split('\n')) { const t = l.trim(); if (!t) continue; try { records.push(JSON.parse(t)); } catch { /* torn line: skip */ } }
      return { records, end: from + nl + 1 };
    } finally { await fh.close(); }
  }
  const fileKey = (s, name) => `${s.project}/${name}`;
  const sigOf = async s => { try { return s.sig ? String(await s.sig()) : ''; } catch { return ''; } };
  const urgentOf = async s => { try { return s.urgent ? String(await s.urgent()) : ''; } catch { return ''; } };

  // send the appended lines of every file past the cursor `cur` to one client (or all: c = null); advance `cur` in place
  async function sendRecs(h, cur, targets) {
    for (const s of h.sources) for (const [name, f] of Object.entries(s.files)) {
      const k = fileKey(s, name), at = cur[k] ?? 0, n = await size(f);
      if (n < at) { cur[k] = n; for (const c of targets) write(c.res, 'reset', { project: s.project, file: name }); continue; }
      if (n === at) continue;
      let r; try { r = await readLines(f, at, n); } catch { continue; }
      cur[k] = r.end;
      for (let i = 0; i < r.records.length; i += CHUNK) {
        const last = i + CHUNK >= r.records.length, id = last ? encodeCursor(cur) : null;
        for (const c of targets) write(c.res, 'rec', { project: s.project, file: name, records: r.records.slice(i, i + CHUNK) }, id);
      }
    }
  }
  // one poll or join catch-up at a time per hub (h.busy = the promise of the one running). A poll takes its client list, then
  // awaits the files; a tab resuming inside those awaits read the not-yet-advanced cursor and was not in the list: the append
  // reached it by neither path (CI 43999056272). A join waits for the running poll and holds the next one off while it catches up.
  async function exclusive(h, fn) {
    while (h.busy) await h.busy;
    let done; h.busy = new Promise(r => { done = r; });
    try { return await fn(); } finally { h.busy = null; done(); }
  }
  async function tick(h) {
    if (h.busy) return;   // a slow poll is skipped over, never queued
    try { await exclusive(h, () => poll(h)); } catch { /* the next poll retries */ }
  }
  async function poll(h) {
    const all = [...h.clients];
    await sendRecs(h, h.cursor, all);
    for (const s of h.sources) {
      const fl = JSON.stringify(await flagsOf(s));
      if (fl !== h.flags.get(s.project)) { h.flags.set(s.project, fl); for (const c of all) write(c.res, 'state', JSON.parse(fl)); }
      const m = await mtime(s.hbDir), p = h.pulse.get(s.project);
      if (m !== p.m) { p.m = m; p.due = true; }
      // a pulse's ts is its window start (p.at): consecutive pulses are >= pulseMs apart by construction, the same ts for every client
      if (p.due && Date.now() - p.at >= pulseMs) { p.due = false; p.at = Date.now(); const ts = new Date(p.at).toISOString(); for (const c of all) write(c.res, 'pulse', { project: s.project, ts }); }
      const d = h.derived.get(s.project);
      if (s.kick && Date.now() - d.kicked >= deriveMs) { d.kicked = Date.now(); try { s.kick(); } catch { /* the next kick retries */ } }
      const g = await sigOf(s);
      if (g !== d.sig) { d.sig = g; d.due = true; }
      const u = await urgentOf(s);
      if (u !== d.urgent) { d.urgent = u; d.due = false; for (const c of all) write(c.res, 'derived', { project: s.project, ts: new Date().toISOString() }); }   // DEC-341: at once
      else if (d.due && Date.now() - d.at >= pulseMs) { d.due = false; d.at = Date.now(); for (const c of all) write(c.res, 'derived', { project: s.project, ts: new Date().toISOString() }); }
    }
  }
  function stop(h) { clearInterval(h.timer); clearTimeout(h.linger); hubs.delete(h.key); }
  function leave(h, c) {
    if (!h.clients.delete(c)) return;
    clients--;
    if (!h.clients.size) { clearTimeout(h.linger); h.linger = setTimeout(() => { if (!h.clients.size) stop(h); }, lingerMs); h.linger.unref?.(); }
  }

  const opening = new Map();   // key -> the hub being built (two tabs joining at once share one)
  async function open(key, sources) {
    const cur = {};
    for (const s of sources) for (const [name, f] of Object.entries(s.files)) cur[fileKey(s, name)] = await size(f);
    const pulse = new Map(), derived = new Map(), flags = new Map();
    for (const s of sources) {
      pulse.set(s.project, { m: await mtime(s.hbDir), at: 0, due: false });
      derived.set(s.project, { sig: await sigOf(s), urgent: await urgentOf(s), at: 0, due: false, kicked: Date.now() });
      flags.set(s.project, JSON.stringify(await flagsOf(s)));
    }
    const h = { key, sources, clients: new Set(), cursor: cur, flags, pulse, derived, timer: null, linger: null, busy: false };
    hubs.set(key, h);
    return h;
  }
  /** -> Promise<false at the cap | true> */
  async function join(key, sources, res, cursor = null) {
    if (clients >= max) return false;
    clients++;   // the seat is taken before the first await (the cap holds for tabs joining at once)
    let h;
    try {
      h = hubs.get(key);
      if (!h) {
        if (!opening.has(key)) opening.set(key, open(key, sources).finally(() => opening.delete(key)));
        h = await opening.get(key);
      }
    } catch (e) { clients--; throw e; }
    clearTimeout(h.linger);
    const c = { res };
    h.clients.add(c);
    if (res.destroyed) { leave(h, c); return true; }   // the tab went away while the hub opened
    res.on('close', () => leave(h, c));
    await exclusive(h, () => greet(h, c, sources, cursor));
    if (!h.timer) { h.timer = setInterval(() => tick(h), pollMs); h.timer.unref?.(); }
    return true;
  }
  // the new tab's first events: flags, then (a resume) the lines between its cursor and the hub's, then hello with the hub's cursor
  async function greet(h, c, sources, cursor) {
    const { res } = c;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    for (const s of sources) write(res, 'state', JSON.parse(h.flags.get(s.project)));
    // a resume: the lines between the client's cursor and the hub's, to this client only (too far back = reset)
    if (cursor) {
      const mine = {};
      for (const k of Object.keys(h.cursor)) mine[k] = Math.min(cursor[k] ?? h.cursor[k], h.cursor[k]);
      const far = Object.keys(mine).some(k => h.cursor[k] - mine[k] > MAX_CATCHUP);
      if (far) for (const s of sources) write(res, 'reset', { project: s.project, file: '*' });
      else {
        const hub = h.cursor;
        for (const s of h.sources) for (const [name, f] of Object.entries(s.files)) {
          const k = fileKey(s, name);
          if (mine[k] >= hub[k]) continue;
          const r = await readLines(f, mine[k], hub[k]);
          if (r.records.length) write(res, 'rec', { project: s.project, file: name, records: r.records }, null);
        }
        write(res, 'hello', { at: new Date().toISOString() }, encodeCursor({ ...hub }));
      }
    } else write(res, 'hello', { at: new Date().toISOString() }, encodeCursor({ ...h.cursor }));
  }
  const close = () => { for (const h of [...hubs.values()]) { for (const c of h.clients) { try { c.res.end(); } catch { /* gone */ } } stop(h); } };
  return { join, close, hubs: () => hubs.size, clients: () => clients };
}
