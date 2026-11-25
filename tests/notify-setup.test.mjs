// META-NOTIFY-SETUP R1: setup offers a phone / desktop ping when Norn needs you. `norn setup --notify ntfy|toast|desktop|pushover|none
// [--ntfy-server URL] [--no-test-ping]` (scripted) or the interactive question; a private unguessable ntfy topic (>= 128 bits), the
// subscribe link, a test ping, "did it arrive?"; desktop rows for macOS (osascript) / Linux (notify-send); `project new` reuses the
// step; doctor reports it (off = a note); the dashboard Settings has a Notifications row with a "send a test" button.
// Sandbox only: temp META_ROOT / HOME / USERPROFILE / CLAUDE_CONFIG_DIR, PATH = a fake bin (+ git); every ntfy ping goes to a
// loopback fake server (never ntfy.sh); no toast is shown (fake transport or --no-test-ping).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newTopic, subscribeLink, notify } from '../engine/lib/notify.mjs';
import { validate, MACHINE_SCHEMA } from '../engine/lib/config.mjs';
import { which } from '../engine/lib/paths.mjs';
import { renderTab, loadTab } from '../engine/dash/ui.mjs';
import { fixture } from './helpers/dash-fixture.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { rustReady } from './helpers/rust.mjs';

test.before(rustReady);   // norn setup builds norn-hook and norn-code: a cold build runs here, never inside a step's time limit

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const GIT_DIR = path.dirname(which('git'));

function sandbox() {
  const t = mkTmp('meta-nset-');
  const d = { t, root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg') };
  for (const x of [d.root, d.home, d.bin, d.cfg]) fs.mkdirSync(x, { recursive: true });
  fs.writeFileSync(path.join(d.bin, WIN ? 'claude.exe' : 'claude'), '');
  const env = { ...process.env, PATH: d.bin + path.delimiter + GIT_DIR, HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming'), META_ROOT: d.root };
  for (const k of ['NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_STATE', 'META_PROJECT', 'META_INTERACTIVE']) delete env[k];
  // async spawn: the test's own loopback ntfy server must keep answering while the CLI runs
  const run = (args, { input = '', extra = {} } = {}) => new Promise(res => {
    const c = spawn(process.execPath, [META, ...args], { env: { ...env, ...extra } });
    let out = '', err = '';
    c.stdout.on('data', b => { out += b; }); c.stderr.on('data', b => { err += b; });
    c.on('close', code => res({ code, out, err }));
    c.stdin.end(input);
  });
  const mf = path.join(d.root, 'local', 'machine.json');
  return { ...d, run, mf, machine: () => JSON.parse(fs.readFileSync(mf, 'utf8')) };
}

async function fakeNtfy() {
  const got = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { got.push({ method: req.method, url: req.url, body: b ? JSON.parse(b) : null }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"x"}'); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

test('newTopic: a private ntfy topic of >= 128 random bits, url-safe, prefixed; never the same twice', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const t = newTopic();
    assert.match(t, /^norn-[A-Za-z0-9_-]{22,59}$/, t);   // ntfy topic charset, <= 64 characters
    seen.add(t);
  }
  assert.equal(seen.size, 2000);
  // the entropy comes from the random source: 6 bits per url-safe character, >= 128 in all
  let asked = 0; const t = newTopic(n => { asked = n; return Buffer.alloc(n, 0xab); });
  assert.ok(asked * 8 >= 128, `asked ${asked} random bytes`);
  assert.ok((t.length - 'norn-'.length) * 6 >= 128);
  assert.equal(subscribeLink({ backend: 'ntfy', topic: 'norn-abc' }), 'https://ntfy.sh/norn-abc');
  assert.equal(subscribeLink({ backend: 'ntfy', topic: 'norn-abc', server: 'https://ntfy.example.org/x' }), 'https://ntfy.example.org/norn-abc');
});

test('setup --notify ntfy --ntfy-server <loopback>: writes the block with a fresh topic, prints the subscribe link, the fake server gets the test ping', async () => {
  const sb = sandbox(), srv = await fakeNtfy();
  try {
    const r = await sb.run(['setup', '--non-interactive', '--no-scheduler', '--notify', 'ntfy', '--ntfy-server', srv.url]);
    assert.equal(r.code, 0, r.err + r.out);
    const n = sb.machine().notify;
    assert.equal(n.backend, 'ntfy'); assert.equal(n.server, srv.url); assert.match(n.topic, /^norn-[A-Za-z0-9_-]{22,}$/);
    assert.ok(r.out.includes(`${srv.url}/${n.topic}`), 'subscribe link printed:\n' + r.out);
    assert.equal(srv.got.length, 1, 'one test ping');
    assert.equal(srv.got[0].body.topic, n.topic); assert.match(srv.got[0].body.title, /test/i);
    assert.match(r.out, /test ping sent/i);
    // a re-run with the same choice keeps the topic (the phone stays subscribed); no flag keeps the block byte for byte
    const r2 = await sb.run(['setup', '--non-interactive', '--no-scheduler', '--notify', 'ntfy', '--ntfy-server', srv.url, '--no-test-ping']);
    assert.equal(r2.code, 0, r2.err); assert.equal(sb.machine().notify.topic, n.topic); assert.equal(srv.got.length, 1);
    const before = JSON.stringify(sb.machine().notify);
    const r3 = await sb.run(['setup', '--non-interactive', '--no-scheduler']);
    assert.equal(r3.code, 0, r3.err); assert.equal(JSON.stringify(sb.machine().notify), before);
    assert.match(r3.out, /notifications: ntfy \(kept/);
  } finally { await srv.close(); }
});

test('setup flags: none / toast / desktop / pushover write their block; no flag + no block = off with the turn-on hint; a bad flag writes nothing', async () => {
  const sb = sandbox();
  let r = await sb.run(['setup', '--non-interactive', '--no-scheduler']);
  assert.equal(r.code, 0, r.err); assert.equal(sb.machine().notify, undefined);
  assert.match(r.out, /notifications: off .*norn setup --notify ntfy/);
  r = await sb.run(['setup', '--non-interactive', '--no-scheduler', '--notify', 'none']);
  assert.equal(r.code, 0, r.err); assert.deepEqual(sb.machine().notify, { backend: 'none' });
  r = await sb.run(['setup', '--non-interactive', '--no-scheduler', '--notify', 'toast', '--no-test-ping']);
  assert.equal(r.code, 0, r.err); assert.deepEqual(sb.machine().notify, { backend: WIN ? 'toast' : 'desktop' });
  r = await sb.run(['setup', '--non-interactive', '--no-scheduler', '--notify', 'desktop', '--no-test-ping']);
  assert.equal(r.code, 0, r.err); assert.deepEqual(sb.machine().notify, { backend: 'desktop' });
  r = await sb.run(['setup', '--non-interactive', '--no-scheduler', '--notify', 'pushover', '--no-test-ping']);
  assert.equal(r.code, 0, r.err); assert.deepEqual(sb.machine().notify, { backend: 'pushover' });
  assert.match(r.out, /PUSHOVER_TOKEN/);
  const was = fs.readFileSync(sb.mf, 'utf8');
  r = await sb.run(['setup', '--non-interactive', '--no-scheduler', '--notify', 'pigeon']);
  assert.equal(r.code, 2); assert.match(r.err, /--notify must be/); assert.equal(fs.readFileSync(sb.mf, 'utf8'), was);
  r = await sb.run(['setup', '--non-interactive', '--no-scheduler', '--notify', 'ntfy', '--ntfy-server', 'http://example.org']);
  assert.equal(r.code, 2); assert.match(r.err, /https/); assert.equal(fs.readFileSync(sb.mf, 'utf8'), was);
});

test('interactive setup: "Get a ping?" - own ntfy server, test ping, "did it arrive?"; "not now" writes nothing and says how to turn it on', async () => {
  const sb = sandbox(), srv = await fakeNtfy(), I = { META_INTERACTIVE: '1' };
  try {
    let r = await sb.run(['setup', '--no-scheduler'], { input: `3\n${srv.url}\ny\n`, extra: I });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /Get a ping when Norn needs you\?/); assert.match(r.out, /ntfy.*recommended/i); assert.match(r.out, /not now/i);
    assert.match(r.out, /did it arrive\?/i);
    const n = sb.machine().notify;
    assert.equal(n.backend, 'ntfy'); assert.equal(n.server, srv.url); assert.equal(srv.got.length, 1); assert.equal(srv.got[0].body.topic, n.topic);
    // an existing block is not asked about again
    r = await sb.run(['setup', '--no-scheduler'], { input: '', extra: I });
    assert.equal(r.code, 0, r.err); assert.doesNotMatch(r.out, /Get a ping/); assert.equal(sb.machine().notify.topic, n.topic);
    const sb2 = sandbox();
    r = await sb2.run(['setup', '--no-scheduler'], { input: '4\n', extra: I });
    assert.equal(r.code, 0, r.err); assert.equal(sb2.machine().notify, undefined);
    assert.match(r.out, /norn setup --notify ntfy/);
    // "no, it did not arrive": the block stays (the topic is still right) and the out says what to check
    const sb3 = sandbox();
    r = await sb3.run(['setup', '--no-scheduler'], { input: `3\n${srv.url}\nn\n`, extra: I });
    assert.equal(r.code, 0, r.err); assert.equal(sb3.machine().notify.backend, 'ntfy'); assert.match(r.out, /norn notify --title/);
  } finally { await srv.close(); }
});

test('project new reuses the step: --notify writes the machine block; interactive asks when the machine has none', async () => {
  const sb = sandbox();
  assert.equal((await sb.run(['setup', '--non-interactive', '--no-scheduler'])).code, 0);
  const repo = n => { const r = path.join(sb.t, n); fs.mkdirSync(r); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: r }); return r; };
  let r = await sb.run(['project', 'new', '--root', repo('a'), '--non-interactive', '--notify', 'none']);
  assert.equal(r.code, 0, r.err + r.out); assert.deepEqual(sb.machine().notify, { backend: 'none' });
  const sb2 = sandbox();
  assert.equal((await sb2.run(['setup', '--non-interactive', '--no-scheduler'])).code, 0);
  const r2dir = path.join(sb2.t, 'b'); fs.mkdirSync(r2dir); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: r2dir });
  r = await sb2.run(['project', 'new', '--root', r2dir], { input: '\n\n\n\n\n4\n', extra: { META_INTERACTIVE: '1' } });
  assert.equal(r.code, 0, r.err + r.out); assert.match(r.out, /Get a ping when Norn needs you\?/); assert.equal(sb2.machine().notify, undefined);
});

test('doctor: notifications off = a note with the turn-on line (exit 0); on = ok + backend, never the topic', async () => {
  const sb = sandbox();
  assert.equal((await sb.run(['setup', '--non-interactive', '--no-scheduler'])).code, 0);
  let r = await sb.run(['doctor']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /^note notifications: off .*norn setup --notify ntfy/m);
  const m = sb.machine(); m.notify = { backend: 'ntfy', topic: 'norn-secretsecretsecretsecret' }; fs.writeFileSync(sb.mf, JSON.stringify(m));
  r = await sb.run(['doctor']);
  assert.equal(r.code, 0, r.out); assert.match(r.out, /^ok notifications: ntfy \(https:\/\/ntfy\.sh, topic set\)/m);
  assert.ok(!r.out.includes('secretsecret'), 'the topic is never printed');
});

test('dashboard Settings: a Notifications row - backend, which events ping, batching, a "send a test" button that sends', async () => {
  const sent = [];
  const transport = { post: async (url, o) => { sent.push({ url, body: JSON.parse(o.body) }); return { status: 200, text: 'ok' }; } };
  const f = await fixture({ project: { policy: { lanes: {}, notify: { batch_h: 2 } } }, dash: { machine: { home: '/h', notify: { backend: 'ntfy', topic: 'norn-dashsecretdashsecret', server: 'http://127.0.0.1:9' } }, notifyTransport: transport } });
  try {
    const d = await loadTab('settings', 'kestrel', async r => (await f.get(r)).data);
    assert.equal(d.notify.backend, 'ntfy'); assert.equal(d.notify.batch_h, 2);
    assert.ok(!JSON.stringify(d).includes('dashsecret'), 'the topic never leaves the server');
    const html = renderTab('settings', d, { project: 'kestrel', setCat: 'notify' });
    assert.match(html, /id="cat-notify"/); assert.match(html, /Notifications/);
    assert.match(html, /data-act="notify-test"/);
    // shown in the default Basic view too (an info section with no setting rows would be hidden there)
    assert.match(html, /id="nav-notify" data-setcat="notify" data-basic="1"/); assert.match(html, /id="set-notify" data-basic="1"/);
    for (const w of [/questions to you/i, /work finished/i, /CI red on main/i, /every 2 h/]) assert.match(html, w);
    const r = await f.post('/api/notify-test', { project: 'kestrel' });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.sent, true);
    assert.equal(sent.length, 1); assert.equal(sent[0].body.topic, 'norn-dashsecretdashsecret'); assert.match(sent[0].body.title, /test/i);
  } finally { await f.done(); }
  const g = await fixture();
  try {
    const d = await loadTab('settings', 'kestrel', async r => (await g.get(r)).data);
    assert.equal(d.notify.backend, 'none');
    const html = renderTab('settings', d, { project: 'kestrel', setCat: 'notify' });
    assert.match(html, /norn setup --notify ntfy/);
    const r = await g.post('/api/notify-test', { project: 'kestrel' });
    assert.equal(r.status, 409); assert.match(r.data.error, /off/);
  } finally { await g.done(); }
});
