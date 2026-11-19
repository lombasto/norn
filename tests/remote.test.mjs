// META-CONTROLLER C6 (SPEC sec. 5 + 8 C6 row, DEC-140): reach Norn from your phone through a private network you run (Tailscale
// Serve first, Cloudflare Access second). dash.remote (off by default = today's behaviour bit for bit), the Host / Origin allow-list,
// the identity header (none = 403), device pairing (a single-use code shown on the desktop; the device remembered, revocable), every
// remote write stamped via remote:<device>, tier-2 taps from a phone only on a paired device, `norn remote setup` (checks, prints,
// runs `tailscale serve` only with --apply), doctor rows, ntfy "view" links. Sandbox only: temp roots, a FAKE identity header and a
// FAKE tailscale (a node script that logs its argv); no real tailscale, no network change, never the live dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { remoteOf, classify, createPairing, remoteUrl } from '../engine/lib/remote.mjs';
import { notify } from '../engine/lib/notify.mjs';
import { validate, MACHINE_SCHEMA } from '../engine/lib/config.mjs';
import { readEvents, recordsFile } from '../engine/lib/records.mjs';
import { context, handle } from '../engine/lib/mcp.mjs';
import { approvalsDir, threadFile } from '../engine/lib/chatact.mjs';
import { readThread } from '../engine/lib/chat.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const HOST = 'pc.tail1234.ts.net', LOGIN = 'owner@example.com';
const REMOTE = { enabled: true, trust: 'tailscale', hosts: [HOST], logins: [LOGIN] };
const machineWith = remote => ({ home: '/h', dash: { port: 0, bind: '127.0.0.1', ...(remote ? { remote } : {}) } });

// raw HTTP: fetch cannot set Host (a forbidden header); the tests must
function raw(url, { method = 'GET', route = '/', headers = {}, body } = {}) {
  const u = new URL(url);
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: u.port, method, path: route, headers: { host: u.host, ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } }, x => {
      let b = ''; x.setEncoding('utf8'); x.on('data', c => { b += c; });
      x.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { /* html */ } res({ status: x.statusCode, headers: x.headers, body: b, json }); });
    });
    r.on('error', rej);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const tail = (h = {}) => ({ host: HOST, 'tailscale-user-login': LOGIN, ...h });   // what Tailscale Serve sends (faked)
const cookieOf = r => String(r.headers['set-cookie']?.[0] ?? '').split(';')[0];

test('remoteOf: off unless dash.remote.enabled is true; the trust source names its identity header; the schema takes the block', () => {
  assert.equal(remoteOf({}), null); assert.equal(remoteOf({ dash: { port: 1, bind: '127.0.0.1' } }), null);
  assert.equal(remoteOf({ dash: { remote: { ...REMOTE, enabled: false } } }), null);
  const r = remoteOf({ dash: { remote: { ...REMOTE, hosts: ['PC.Tail1234.ts.net'] } } });
  assert.equal(r.header, 'tailscale-user-login'); assert.deepEqual(r.hosts, [HOST]); assert.equal(remoteUrl({ dash: { remote: REMOTE } }), `https://${HOST}/`);
  assert.equal(remoteOf({ dash: { remote: { ...REMOTE, trust: 'cloudflare-access' } } }).header, 'cf-access-authenticated-user-email');
  assert.equal(remoteUrl({ dash: { remote: { ...REMOTE, enabled: false } } }), null);
  const m = { schema: 1, home: '/h', claude: { exe: 'c', config_dir: 'd', projects_dir: 'p' }, node: 'n', scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, projects: [] };
  assert.deepEqual(validate(MACHINE_SCHEMA, { ...m, dash: { port: 8737, bind: '127.0.0.1', remote: REMOTE } }), []);
  assert.ok(validate(MACHINE_SCHEMA, { ...m, dash: { port: 8737, bind: '127.0.0.1', remote: { ...REMOTE, trust: 'funnel' } } }).length, 'no public trust source exists');
  assert.ok(validate(MACHINE_SCHEMA, { ...m, dash: { port: 8737, bind: '127.0.0.1', remote: { ...REMOTE, hosts: ['evil.com/x'] } } }).length, 'a host is a host name');
});

test('classify: the Host / Origin matrix (local, allowed remote, unknown host, proxied local, wrong origin, no / foreign identity, Funnel)', () => {
  const cfg = remoteOf({ dash: { remote: REMOTE } }), local = '127.0.0.1:8737';
  const ok = (h, want) => assert.deepEqual(classify(h, cfg, local).remote, want, JSON.stringify(h));
  const no = (h, re) => assert.throws(() => classify(h, cfg, local), e => e.status === 403 && re.test(e.message), JSON.stringify(h));
  ok({ host: local }, false);
  ok({ host: local, origin: `http://${local}` }, false);   // the server keeps today's local origin check
  ok(tail(), true); ok(tail({ host: HOST + ':443' }), true); ok(tail({ host: HOST.toUpperCase() }), true);
  ok(tail({ origin: `https://${HOST}` }), true);
  no({ host: 'evil.example.com', 'tailscale-user-login': LOGIN }, /host/i);   // DNS rebinding / another name
  no({ host: 'localhost:8737' }, /host/i);
  no({ host: local, 'x-forwarded-for': '100.64.0.2' }, /proxied/i);   // a proxy that rewrote Host never passes as the desktop
  no({ host: local, 'tailscale-user-login': LOGIN }, /proxied/i);
  no({ host: HOST }, /identity/i);   // no identity header = 403
  no(tail({ 'tailscale-user-login': '' }), /identity/i);
  no(tail({ 'tailscale-user-login': 'someone@else.org' }), /login/i);
  no(tail({ origin: 'https://evil.example.com' }), /origin/i);
  no(tail({ origin: `http://${HOST}` }), /origin/i);   // the remote page is https (Serve terminates TLS)
  no(tail({ 'tailscale-funnel-request': '?1' }), /funnel/i);   // public internet: refused by the code, header or not
  no({ host: HOST, 'tailscale-funnel-request': '?1' }, /funnel/i);
  const anyLogin = remoteOf({ dash: { remote: { ...REMOTE, logins: [] } } });
  assert.equal(classify(tail({ 'tailscale-user-login': 'x@y.z' }), anyLogin, local).login, 'x@y.z', 'no logins listed = any login the tailnet vouches for');
});

test('pairing: a single-use code (10 min), 5 wrong tries burn it, the device secret is stored hashed and bound to its login, revocable', () => {
  const dir = mkTmp('meta-remote-'), file = path.join(dir, 'remote-devices.json');
  let t = Date.parse('2026-11-13T10:00:00Z');
  const pr = createPairing({ file, now: () => t });
  assert.throws(() => pr.claim('ABCD-EFGH', { name: 'phone', login: LOGIN }), e => e.status === 403 && /no pairing code/i.test(e.message));
  const c = pr.open();
  assert.match(c.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const d = pr.claim(c.code.toLowerCase().replace('-', ' '), { name: 'Pixel', login: LOGIN });
  assert.match(d.device.id, /^dev-[0-9a-f]{8}$/); assert.match(d.cookie, /^dev-[0-9a-f]{8}\.[A-Za-z0-9_-]{43}$/);
  assert.throws(() => pr.claim(c.code, { name: 'again', login: LOGIN }), e => e.status === 403, 'single use');
  const stored = fs.readFileSync(file, 'utf8');
  assert.ok(!stored.includes(d.cookie.split('.')[1]), 'the secret is never stored, only its hash');
  assert.equal(pr.verify(d.cookie, LOGIN)?.id, d.device.id);
  assert.equal(pr.verify(d.cookie, 'someone@else.org'), null, 'a cookie works only with the login it was paired under');
  assert.equal(pr.verify(d.cookie.slice(0, -2) + 'xx', LOGIN), null); assert.equal(pr.verify('', LOGIN), null); assert.equal(pr.verify('junk', LOGIN), null);
  assert.equal(createPairing({ file }).verify(d.cookie, LOGIN)?.name, 'Pixel', 'remembered across a dashboard restart');
  // wrong tries burn the code; an expired code is gone
  const c2 = pr.open();
  for (let i = 0; i < 5; i++) assert.throws(() => pr.claim('AAAA-AAAA', { name: 'x', login: LOGIN }), e => e.status === 403);
  assert.throws(() => pr.claim(c2.code, { name: 'x', login: LOGIN }), e => /no pairing code/i.test(e.message), 'burned after 5 wrong tries');
  const c3 = pr.open(); t += 10 * 60000 + 1;
  assert.throws(() => pr.claim(c3.code, { name: 'x', login: LOGIN }), e => /no pairing code/i.test(e.message), 'expired');
  assert.deepEqual(pr.list().map(x => Object.keys(x).sort()), [['created', 'id', 'last_seen', 'login', 'name']], 'the list never carries the hash');
  assert.equal(pr.revoke(d.device.id), true); assert.equal(pr.revoke(d.device.id), false);
  assert.equal(pr.verify(d.cookie, LOGIN), null, 'revoked');
});

test('dash, remote on: unpaired phone sees only the pairing page; the desktop makes the code; claim sets a Secure HttpOnly SameSite=Strict cookie', async () => {
  const f = await fixture({ dash: { machine: machineWith(REMOTE) } });
  try {
    const T = { 'x-dash-token': f.app.token };
    // the desktop: as today
    assert.equal((await raw(f.url, { route: '/api/projects' })).status, 200);
    // the phone, not paired: the pairing page (no token in it), every API 403
    const page = await raw(f.url, { headers: tail() });
    assert.equal(page.status, 200); assert.match(page.body, /id="pair-code"/); assert.ok(!page.body.includes(f.app.token), 'no page token before pairing');
    for (const route of ['/api/projects', '/api/inbox', '/api/remote', '/ui.mjs', '/api/chat?project=kestrel']) {
      const r = await raw(f.url, { route, headers: tail() }); assert.equal(r.status, 403, route); assert.match(r.json?.error ?? '', /pair this device/i, route);
    }
    assert.equal((await raw(f.url, { route: '/api/projects', headers: { host: HOST } })).status, 403, 'no identity header = 403');
    assert.equal((await raw(f.url, { method: 'POST', route: '/api/remote/pair', headers: tail({ ...T, origin: `https://${HOST}` }), body: {} })).status, 403, 'a code is made on the desktop only');
    const claim = (code, h = {}) => raw(f.url, { method: 'POST', route: '/api/remote/claim', headers: tail({ origin: `https://${HOST}`, ...h }), body: { code, name: 'Pixel 9' } });
    assert.equal((await claim('AAAA-AAAA')).status, 403, 'no code open');
    const code = (await raw(f.url, { method: 'POST', route: '/api/remote/pair', headers: T, body: {} })).json.code;
    assert.equal((await claim(code, { origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await raw(f.url, { method: 'POST', route: '/api/remote/claim', headers: tail(), body: { code, name: 'x' } })).status, 403, 'a claim needs its Origin');
    const ok = await claim(code);
    assert.equal(ok.status, 200, ok.body);
    const sc = ok.headers['set-cookie']?.[0] ?? '';
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(sc.includes(flag), `${flag} in ${sc}`);
    assert.equal((await claim(code)).status, 403, 'single use');
    const C = { cookie: cookieOf(ok) };
    // paired: the dashboard, with the token and a "remote" marker
    const home = await raw(f.url, { headers: tail(C) });
    assert.equal(home.status, 200); assert.ok(home.body.includes(f.app.token)); assert.match(home.body, /"device":"dev-[0-9a-f]{8}"/);
    assert.equal((await raw(f.url, { route: '/api/projects', headers: tail(C) })).status, 200);
    assert.equal((await raw(f.url, { route: '/api/projects', headers: tail({ ...C, 'tailscale-user-login': 'someone@else.org' }) })).status, 403);
    // the desktop lists and revokes it
    const list = (await raw(f.url, { route: '/api/remote' })).json;
    assert.equal(list.devices.length, 1); assert.equal(list.devices[0].name, 'Pixel 9'); assert.equal(list.url, `https://${HOST}/`);
    assert.equal((await raw(f.url, { method: 'POST', route: '/api/remote/revoke', headers: T, body: { id: list.devices[0].id } })).status, 200);
    assert.equal((await raw(f.url, { route: '/api/projects', headers: tail(C) })).status, 403, 'revoked = unpaired');
  } finally { await f.done(); }
});

test('dash, remote on: every remote write needs the pairing + token + Origin and is stamped via remote:<device>; a tier-2 tap too', async () => {
  const f = await fixture({ dash: { machine: machineWith(REMOTE) } });
  try {
    const T = { 'x-dash-token': f.app.token }, O = { origin: `https://${HOST}` };
    const code = (await raw(f.url, { method: 'POST', route: '/api/remote/pair', headers: T, body: {} })).json.code;
    const ok = await raw(f.url, { method: 'POST', route: '/api/remote/claim', headers: tail(O), body: { code, name: 'Pixel' } });
    const C = { cookie: cookieOf(ok) }, dev = ok.json.device.id;
    const dir = text => raw(f.url, { method: 'POST', route: '/api/directive', headers: tail({ ...T, ...O, ...C }), body: { project: 'kestrel', text } });
    assert.equal((await raw(f.url, { method: 'POST', route: '/api/directive', headers: tail({ ...T, ...O }), body: { project: 'kestrel', text: 'x' } })).status, 403, 'unpaired, even with the token');
    assert.equal((await raw(f.url, { method: 'POST', route: '/api/directive', headers: tail({ ...T, ...C }), body: { project: 'kestrel', text: 'x' } })).status, 403, 'a remote POST names its Origin');
    assert.equal((await raw(f.url, { method: 'POST', route: '/api/directive', headers: tail({ ...O, ...C }), body: { project: 'kestrel', text: 'x' } })).status, 403, 'and carries the token');
    const w = await dir('from the phone'); assert.equal(w.status, 200, w.body);
    const evs = readEvents(recordsFile(f.pa.state, 'directive'));
    assert.equal(evs.at(-1).via, `remote:${dev}`, 'stamped');
    // the desktop's own write stays as today: no via on the envelope
    assert.equal((await raw(f.url, { method: 'POST', route: '/api/directive', headers: T, body: { project: 'kestrel', text: 'from the desk' } })).status, 200);
    assert.deepEqual(Object.keys(readEvents(recordsFile(f.pa.state, 'directive')).at(-1)), ['v', 'seq', 'ts', 'id', 'kind', 'ev', 'by', 'run', 'data']);
    // a tier-2 approval card: unpaired = 403; the paired phone's tap counts and is stamped
    const s = f.pa.state;
    fs.mkdirSync(path.dirname(threadFile(s)), { recursive: true });
    fs.appendFileSync(threadFile(s), JSON.stringify({ ts: new Date().toISOString(), seg: 1, kind: 'owner', text: 'keep the night quiet' }) + '\n');
    const ctx = context({ state: s, project: null, profile: 'chat', client: 'chat', env: {}, cli: () => 0, approvalMs: 60000, pollMs: 10, notifyFn: () => {} });
    const pending = handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'norn_pause', arguments: { on: true } } }, ctx);
    let id = null;
    for (let i = 0; i < 500 && !id; i++) { id = fs.existsSync(approvalsDir(s)) && fs.readdirSync(approvalsDir(s)).find(x => /^AP-[0-9a-f]{8}\.json$/.test(x))?.slice(0, 11); if (!id) await new Promise(r => setTimeout(r, 10)); }
    assert.ok(id, 'an approval card is open');
    const tap = h => raw(f.url, { method: 'POST', route: '/api/chat/approve', headers: tail({ ...T, ...O, ...h }), body: { project: 'kestrel', id, verdict: 'approve' } });
    assert.equal((await tap({})).status, 403, 'a tap from an unpaired phone does not count');
    const t = await tap(C); assert.equal(t.status, 200, t.body);
    assert.ok(!(await pending).result.isError);
    assert.equal(readThread(s).items.filter(l => l.kind === 'verdict').at(-1).via, `remote:${dev}`);
  } finally { await f.done(); }
});

test('dash, remote on: a paired phone is rate-limited on writes (429), never on reads', async () => {
  const f = await fixture({ dash: { machine: machineWith(REMOTE), remotePostsPerMin: 3 } });
  try {
    const T = { 'x-dash-token': f.app.token }, O = { origin: `https://${HOST}` };
    const code = (await raw(f.url, { method: 'POST', route: '/api/remote/pair', headers: T, body: {} })).json.code;
    const C = { cookie: cookieOf(await raw(f.url, { method: 'POST', route: '/api/remote/claim', headers: tail(O), body: { code, name: 'P' } })) };
    const st = [];
    for (let i = 0; i < 4; i++) st.push((await raw(f.url, { method: 'POST', route: '/api/directive', headers: tail({ ...T, ...O, ...C }), body: { project: 'kestrel', text: 'd' + i } })).status);
    assert.deepEqual(st, [200, 200, 200, 429]);
    assert.equal((await raw(f.url, { route: '/api/projects', headers: tail(C) })).status, 200);
  } finally { await f.done(); }
});

test('remote off = today\'s behaviour bit for bit (no dash.remote vs enabled: false; the identity header and the new routes change nothing)', async () => {
  const a = await fixture({ dash: { machine: machineWith(null) } }), b = await fixture({ dash: { machine: machineWith({ ...REMOTE, enabled: false }) } });
  try {
    const matrix = f => [
      ['local GET', { route: '/api/projects' }],
      ['remote host', { route: '/api/projects', headers: tail() }],
      ['remote host /', { headers: tail() }],
      ['remote host + port', { route: '/api/projects', headers: tail({ host: HOST + ':443' }) }],
      ['evil host', { route: '/api/projects', headers: { host: 'evil.example.com' } }],
      ['local + proxy headers', { route: '/api/projects', headers: { 'x-forwarded-for': '100.64.0.2', 'tailscale-user-login': LOGIN } }],
      ['local + evil origin', { route: '/api/projects', headers: { origin: 'https://evil.example.com' } }],
      ['GET /api/remote', { route: '/api/remote' }],
      ['POST /api/remote/pair', { method: 'POST', route: '/api/remote/pair', headers: { 'x-dash-token': f.app.token }, body: {} }],
      ['POST /api/remote/claim, no token', { method: 'POST', route: '/api/remote/claim', headers: tail({ origin: `https://${HOST}` }), body: { code: 'AAAA-AAAA' } }],
      ['POST /api/remote/claim local', { method: 'POST', route: '/api/remote/claim', headers: { 'x-dash-token': f.app.token }, body: { code: 'AAAA-AAAA' } }],
      ['GET / local', {}],
    ];
    const run = async f => { const out = []; for (const [k, o] of matrix(f)) { const r = await raw(f.url, o); out.push([k, r.status, r.body.split(f.app.token).join('TOKEN'), 'set-cookie' in r.headers]); } return out; };
    const ra = await run(a), rb = await run(b);
    assert.deepEqual(rb, ra);
    const st = Object.fromEntries(ra.map(([k, s, body, ck]) => [k, [s, body.slice(0, 80), ck]]));
    assert.equal(st['local GET'][0], 200);
    for (const k of ['remote host', 'remote host /', 'remote host + port', 'evil host']) assert.deepEqual(st[k], [403, JSON.stringify({ error: 'Use the 127.0.0.1 dashboard address' }), false], k);
    assert.equal(st['local + proxy headers'][0], 200, 'today ignores proxy / identity headers on the local address');
    assert.deepEqual(st['local + evil origin'], [403, JSON.stringify({ error: 'Cross-origin request refused' }), false]);
    assert.deepEqual(st['GET /api/remote'], [404, JSON.stringify({ error: 'Not found' }), false]);
    assert.deepEqual(st['POST /api/remote/pair'], [404, JSON.stringify({ error: 'Not found' }), false]);
    assert.deepEqual(st['POST /api/remote/claim, no token'], [403, JSON.stringify({ error: 'Use the 127.0.0.1 dashboard address' }), false]);
    assert.deepEqual(st['POST /api/remote/claim local'], [404, JSON.stringify({ error: 'Not found' }), false]);
    assert.ok(!ra.some(r => r[3]), 'no cookie is ever set');
    assert.ok(!fs.existsSync(path.join(a.root, 'local', 'remote-devices.json')) && !fs.existsSync(path.join(b.root, 'local', 'remote-devices.json')));
  } finally { await a.done(); await b.done(); }
});

test('Settings: the "Reach Norn from your phone" pane - off says how to start; on lists the URL, devices (Revoke) and a Pair button on the desktop only', () => {
  const base = { project: 'kestrel', version: 'v', settings: [], profiles: [], files: { machine: 'm', project: 'p' }, targets: [], notify: { backend: 'none' },
    sections: [{ id: 'notify', label: 'Notifications', help: 'h', info: true, subs: [{ id: 'ping', label: 'Phone / desktop ping' }, { id: 'remote', label: 'Reach Norn from your phone' }] }] };
  const off = renderTab('settings', { ...base, remote: null }, { setCat: 'notify' });
  assert.match(off, /id="sub-notify-remote"/); assert.match(off, /norn remote setup/); assert.ok(!off.includes('data-act="remote-pair"'));
  const on = { on: true, trust: 'tailscale', url: `https://${HOST}/`, hosts: [HOST], logins: [LOGIN], viewer: null,
    devices: [{ id: 'dev-0a1b2c3d', name: 'Pixel 9', login: LOGIN, created: '2026-11-13T10:00:00Z', last_seen: '2026-11-13T11:00:00Z' }] };
  const desk = renderTab('settings', { ...base, remote: on }, { setCat: 'notify' });
  assert.match(desk, /data-act="remote-pair"/); assert.match(desk, /data-act="remote-revoke" data-id="dev-0a1b2c3d"/); assert.ok(desk.includes(`https://${HOST}/`)); assert.match(desk, /Pixel 9/);
  const phone = renderTab('settings', { ...base, remote: { ...on, viewer: 'dev-0a1b2c3d' } }, { setCat: 'notify' });
  assert.ok(!phone.includes('data-act="remote-pair"'), 'a phone cannot make a pairing code'); assert.match(phone, /this device/i);
});

test('ntfy notices carry a "view" link to the remote URL when remote is on; off = the same body as today', async () => {
  const s = mkTmp('meta-rnotify-'), got = [];
  const t = { post: async (url, o) => { got.push(JSON.parse(o.body)); return { status: 200, text: '{}' }; }, put: async (url) => { got.push(url); return { status: 200, text: '{}' }; } };
  const n = { backend: 'ntfy', topic: 'norn-topic' };
  await notify({ title: 'T', body: 'B', cls: 'ask', machine: { notify: n }, state: s, transport: t });
  assert.deepEqual(Object.keys(got[0]).sort(), ['message', 'priority', 'title', 'topic']);
  await notify({ title: 'T', body: 'B', cls: 'ask', machine: { notify: n, dash: { port: 1, bind: '127.0.0.1', remote: { ...REMOTE, enabled: false } } }, state: s, transport: t });
  assert.deepEqual(Object.keys(got[1]).sort(), ['message', 'priority', 'title', 'topic']);
  await notify({ title: 'T', body: 'B', cls: 'ask', machine: { notify: n, dash: { port: 1, bind: '127.0.0.1', remote: REMOTE } }, state: s, transport: t });
  assert.equal(got[2].click, `https://${HOST}/`);
  assert.deepEqual(got[2].actions, [{ action: 'view', label: 'Open Norn', url: `https://${HOST}/` }]);
  const png = path.join(s, 'a.png'); fs.writeFileSync(png, 'x');
  await notify({ title: 'T', body: 'B', cls: 'ask', file: png, machine: { notify: n, dash: { port: 1, bind: '127.0.0.1', remote: REMOTE } }, state: s, transport: t });
  const q = new URL(got[3]).searchParams;
  assert.equal(q.get('click'), `https://${HOST}/`); assert.equal(q.get('actions'), `view, Open Norn, https://${HOST}/`);
});

// ---------- norn remote setup / off + doctor rows (CLI, sandbox META_ROOT, a fake tailscale) ----------
function sandbox({ tailscale = true } = {}) {
  const t = mkTmp('meta-rsetup-'), root = path.join(t, 'meta'), log = path.join(t, 'ts.log');
  fs.mkdirSync(path.join(root, 'local'), { recursive: true });
  const fake = path.join(t, 'tailscale.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs';
const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[0] === 'version') { console.log('1.88.1\\n  tailscale commit: x'); process.exit(0); }
if (a[0] === 'status' && a[1] === '--json') { console.log(JSON.stringify({ BackendState: 'Running', Self: { DNSName: '${HOST}.', UserID: 7 }, User: { 7: { LoginName: '${LOGIN}' } } })); process.exit(0); }
if (a[0] === 'serve') { console.log('Available within your tailnet: https://${HOST}/'); process.exit(0); }
process.exit(3);\n`);
  const mf = path.join(root, 'local', 'machine.json');
  fs.writeFileSync(mf, JSON.stringify({ schema: 1, home: t.replace(/\\/g, '/'), claude: { exe: 'c', config_dir: 'd', projects_dir: 'p' }, node: process.execPath.replace(/\\/g, '/'),
    scheduler: { kind: 'cron', name: 'x', interval_min: 15 }, dash: { port: 8737, bind: '127.0.0.1' }, projects: [] }, null, 2) + '\n');
  const env = { ...process.env, META_ROOT: root, META_TAILSCALE: tailscale ? fake : path.join(t, 'missing-tailscale.exe'), PATH: path.dirname(process.execPath) };
  for (const k of ['META_STATE', 'META_PROJECT', 'META_INTERACTIVE']) delete env[k];
  const run = args => new Promise(res => {
    const c = spawn(process.execPath, [META, ...args], { env });
    let out = '', err = ''; c.stdout.on('data', b => { out += b; }); c.stderr.on('data', b => { err += b; });
    c.on('close', code => res({ code, out, err }));
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  return { root, mf, run, calls, machine: () => JSON.parse(fs.readFileSync(mf, 'utf8')), text: () => fs.readFileSync(mf, 'utf8') };
}

test('norn remote setup: checks for tailscale, prints the exact commands and what each does; without --apply it runs nothing and writes nothing', async () => {
  const sb = sandbox(), before = sb.text();
  const r = await sb.run(['remote', 'setup']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /^ok tailscale 1\.88\.1/m);
  assert.ok(r.out.includes(`tailscale serve --bg http://127.0.0.1:8737`), r.out);
  assert.ok(r.out.includes(`https://${HOST}/`)); assert.ok(r.out.includes(LOGIN));
  assert.match(r.out, /tailscale serve --https=443 off/); assert.match(r.out, /funnel/i); assert.match(r.out, /--apply/);
  assert.ok(sb.calls().every(a => !a.includes('serve') && !a.includes('funnel')), JSON.stringify(sb.calls()));
  assert.equal(sb.text(), before, 'machine.json untouched');
  // no tailscale: says so (install it yourself), runs nothing, exit 1
  const sb2 = sandbox({ tailscale: false }), before2 = sb2.text(), r2 = await sb2.run(['remote', 'setup']);
  assert.equal(r2.code, 1); assert.match(r2.out, /tailscale not found/); assert.match(r2.out, /tailscale\.com\/download/); assert.match(r2.out, /never installs/i);
  assert.equal((await sb2.run(['remote', 'setup', '--apply'])).code, 1); assert.equal(sb2.text(), before2);
  // Funnel is refused by the code
  const f = await sb.run(['remote', 'setup', '--funnel']);
  assert.equal(f.code, 2); assert.match(f.err, /funnel/i); assert.equal(sb.text(), before);
});

test('norn remote setup --apply: runs tailscale serve (the one change command) and writes dash.remote; norn remote off --apply undoes both', async () => {
  const sb = sandbox();
  const r = await sb.run(['remote', 'setup', '--apply']);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(sb.calls().filter(a => a[0] === 'serve'), [['serve', '--bg', 'http://127.0.0.1:8737']]);
  assert.deepEqual(sb.machine().dash.remote, { enabled: true, trust: 'tailscale', hosts: [HOST], logins: [LOGIN] });
  assert.equal(sb.machine().dash.port, 8737); assert.match(r.out, /norn dash restart/);
  const o = await sb.run(['remote', 'off']);
  assert.equal(o.code, 0); assert.equal(sb.machine().dash.remote.enabled, true, 'off without --apply changes nothing');
  assert.equal(sb.calls().filter(a => a[0] === 'serve').length, 1);
  const o2 = await sb.run(['remote', 'off', '--apply']);
  assert.equal(o2.code, 0, o2.err); assert.equal(sb.machine().dash.remote.enabled, false);
  assert.deepEqual(sb.calls().filter(a => a[0] === 'serve').at(-1), ['serve', '--https=443', 'off']);
});

test('doctor: remote off = a note; on = ok rows (trust, hosts, paired devices, tailscale); on without tailscale = PROBLEM', async () => {
  const sb = sandbox();
  let r = await sb.run(['doctor']);
  assert.match(r.out, /^note remote access: off/m);
  const m = sb.machine(); m.dash.remote = REMOTE; fs.writeFileSync(sb.mf, JSON.stringify(m));
  r = await sb.run(['doctor']);
  assert.match(r.out, new RegExp(`^ok remote access: on \\(tailscale, ${HOST.replace(/\./g, '\\.')}, 1 login, 0 paired devices\\)`, 'm'));
  assert.match(r.out, /^ok tailscale 1\.88\.1/m);
  assert.ok(sb.calls().every(a => !a.includes('serve')), 'doctor never runs serve');
  const sb2 = sandbox({ tailscale: false }), m2 = sb2.machine(); m2.dash.remote = REMOTE; fs.writeFileSync(sb2.mf, JSON.stringify(m2));
  r = await sb2.run(['doctor']);
  assert.match(r.out, /^PROBLEM remote access: tailscale not found/m);
  const m3 = sb.machine(); m3.dash.remote = { ...REMOTE, hosts: [] }; fs.writeFileSync(sb.mf, JSON.stringify(m3));
  r = await sb.run(['doctor']);
  assert.match(r.out, /^PROBLEM remote access: no hosts/m);
});
