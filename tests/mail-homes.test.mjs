// Mail between two synced homes (RM-46): a home-less role / lane address means the writer's OWN home. Both homes carry
// bare_home 'a' (the cut), so before this fix home b's `--to role:controller` was home a's controller and home b's controller never
// matched the role:controller@b mail home a sent. Temp state dirs only; a sync is a copy of the other home's mail.jsonl into
// homes/<h>/mail.jsonl (what the ledger pull writes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sendMail, checkMail, listMail, qualify, arrivalNotices, waitMail } from '../engine/lib/mail.mjs';
import { mkTmp } from './helpers/tmp.mjs';

function homes() {
  const t = mkTmp('meta-mail-homes-'), dir = id => {
    const s = path.join(t, id); fs.mkdirSync(s, { recursive: true });
    fs.writeFileSync(path.join(s, 'home.json'), JSON.stringify({ id, bare_home: 'a' }));
    return s;
  };
  const a = dir('a'), b = dir('b');
  // the ledger sync: each home's own mail.jsonl lands under the other's homes/<h>/
  const sync = () => {
    for (const [from, to, h] of [[a, b, 'a'], [b, a, 'b']]) {
      const src = path.join(from, 'mail.jsonl'); if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.join(to, 'homes', h), { recursive: true });
      fs.copyFileSync(src, path.join(to, 'homes', h, 'mail.jsonl'));
    }
  };
  return { a, b, sync };
}

test('qualify: a bare role / lane address takes the home; run ids, named homes and no home pass unchanged', () => {
  assert.equal(qualify('role:controller', 'b'), 'role:controller@b');
  assert.equal(qualify('role:checkin', 'a'), 'role:checkin@a');
  assert.equal(qualify('lane:demo', 'b'), 'lane:b/demo');
  assert.equal(qualify('role:controller@a', 'b'), 'role:controller@a');
  assert.equal(qualify('lane:a/demo', 'b'), 'lane:a/demo');
  assert.equal(qualify('RUN-b-7', 'a'), 'RUN-b-7');
  assert.equal(qualify('role:controller', null), 'role:controller');
});

test('home b: its check-in mails bare role:controller -> home b\'s controller gets it, home a\'s does not', () => {
  const { a, b, sync } = homes();
  const m = sendMail(b, { by: 'checkin', to: 'role:controller', subject: 'b internal', body: 'x' });
  assert.equal(m.data.to, 'role:controller@b', 'stored with the writer\'s home');
  sync();
  assert.deepEqual(listMail(b, { to: 'role:controller', open: true }).map(r => r.id), [m.id]);
  assert.deepEqual(listMail(a, { to: 'role:controller', open: true }), [], 'not in home a\'s box');
  assert.deepEqual(checkMail(b, { by: 'controller', to: 'role:controller', via: 'cli' }).map(r => r.id), [m.id]);
});

test('home a mails role:controller@b -> home b\'s controller lists and takes delivery of it', () => {
  const { a, b, sync } = homes();
  const m = sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'from a', body: 'y' });
  sync();
  assert.deepEqual(listMail(b, { to: 'role:controller', open: true }).map(r => r.id), [m.id]);
  assert.deepEqual(listMail(b, { to: 'role:controller@b', open: true }).map(r => r.id), [m.id], 'the explicit form reads the same box');
  assert.deepEqual(checkMail(b, { by: 'controller', to: 'role:controller', via: 'cli' }).map(r => r.id), [m.id]);
});

test('legacy bare mail already in a log keeps its meaning (bare_home a): home a still sees it, home b does not claim it', () => {
  const { a, b, sync } = homes();
  // a pre-fix record: the stored address has no home
  fs.appendFileSync(path.join(a, 'mail.jsonl'), JSON.stringify({ v: 1, seq: 1, ts: '2026-11-20T00:00:00Z', id: 'MAIL-a-1', kind: 'mail', ev: 'create', to: 'queued', by: 'checkin', run: null,
    data: { from: 'role:checkin@a', to: 'role:controller', subject: 'old', body: 'z' } }) + '\n');
  sync();
  assert.deepEqual(listMail(a, { to: 'role:controller', open: true }).map(r => r.id), ['MAIL-a-1']);
  assert.deepEqual(listMail(a, { to: 'role:controller@a', open: true }).map(r => r.id), ['MAIL-a-1']);
  assert.deepEqual(listMail(b, { to: 'role:controller', open: true }), []);
});

test('a body_file that fits 2 KB goes in as the body, so the other home reads the text, not a path on this machine', () => {
  const { a, b, sync } = homes(), f = path.join(a, 'note.txt');
  fs.writeFileSync(f, 'the whole message');
  const m = sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'S', body_file: f });
  assert.equal(m.data.body, 'the whole message');
  assert.equal(m.data.body_file, undefined);
  sync();
  assert.equal(checkMail(b, { by: 'controller', to: 'role:controller', via: 'cli' })[0].text, 'the whole message');
});

test('a body_file over 2 KB: kept as a path for this home, refused for another home', () => {
  const { a } = homes(), f = path.join(a, 'long.txt');
  fs.writeFileSync(f, 'x'.repeat(3000));
  assert.equal(sendMail(a, { by: 'controller', to: 'role:controller', subject: 'S', body_file: f }).data.body_file, f);
  assert.throws(() => sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'S', body_file: f }), /another home carries its body inline/);
});

// HOME-MAIL S1: a list row says where the mail is (the sender reads the addressee home's seen.json copy) and carries body + age_min
test('mail list rows carry body, where and age_min; where: sent / at b from the receipt of b, the state once b took it, the state for local mail', () => {
  const { a, b, sync } = homes();
  const m = sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'S', body: 'the body' });
  const local = sendMail(a, { by: 'controller', to: 'role:controller', subject: 'L', body: 'mine' });
  const now = Date.parse(m.ts) + 7 * 60000 + 5000;
  let rows = listMail(a, { now });
  assert.deepEqual(rows.map(r => [r.id, r.body, r.where, r.age_min]), [[m.id, 'the body', 'sent, b unknown', 7], [local.id, 'mine', 'queued', 7]]);
  fs.mkdirSync(path.join(a, 'homes', 'b'), { recursive: true });
  const seen = held => fs.writeFileSync(path.join(a, 'homes', 'b', 'seen.json'), JSON.stringify({ polled_at: '2026-11-20T10:05:00Z', held: { a: { 'mail.jsonl': held } } }));
  seen(m.seq - 1);
  assert.equal(listMail(a, { now })[0].where, 'sent, b last polled 2026-11-20T10:05:00Z');
  seen(m.seq);
  assert.equal(listMail(a, { now })[0].where, 'at b, b last polled 2026-11-20T10:05:00Z');
  sync(); checkMail(b, { by: 'controller', to: 'role:controller', via: 'cli' }); sync();
  assert.equal(listMail(a, { now })[0].where, 'delivered');
  const r = spawnSync(process.execPath, [path.resolve('engine/bin/norn.mjs'), 'mail', 'list', '--state', a, '--json'], { env: { ...process.env, META_RUN_ID: '' }, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout)[0];
  assert.equal(j.body, 'the body'); assert.equal(j.where, 'delivered'); assert.ok(Number.isInteger(j.age_min), r.stdout);
});

// HOME-MAIL S2 (REPORT 3.2): pickup - the receiving home puts the mail in front of a reader
const NORN = path.resolve('engine/bin/norn.mjs');
const cli = (state, args, env = {}) => spawnSync(process.execPath, [NORN, 'mail', ...args, '--state', state], { env: { ...process.env, META_RUN_ID: '', META_ROLE: '', ...env }, encoding: 'utf8', windowsHide: true });
// a mail home a wrote `min` minutes ago (the CLI reads the real clock), in a's own log
const oldMail = (a, n, min, data = {}) => fs.appendFileSync(path.join(a, 'mail.jsonl'), JSON.stringify({ v: 1, seq: n, ts: new Date(Date.now() - min * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z'), id: `MAIL-a-${n}`, kind: 'mail', ev: 'create', to: 'queued', by: 'controller', run: null,
  data: { from: 'role:controller@a', to: 'role:controller@b', subject: `S${n}`, body: 'b', ...data } }) + '\n');

test('home b: `norn mail check` with no flag and with the bare --to role:controller both deliver home a\'s mail', () => {
  const { a, b, sync } = homes();
  const m1 = sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'one', body: 'x' });
  sync();
  let r = cli(b, ['check']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, new RegExp(`${m1.id} from role:controller@a`));
  const m2 = sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'two', body: 'y' });
  sync();
  r = cli(b, ['check', '--to', 'role:controller']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, new RegExp(m2.id));
  r = cli(b, ['check', '--to', 'role:controller@b']);
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'no new mail');
});

test('the usage text names a check address a home accepts', () => {
  const { b } = homes();
  const r = cli(b, ['check', '--to', 'role:checkin']);
  assert.equal(r.status, 2);
  const addr = r.stderr.match(/norn mail check .*?--to (role:[a-z]+)/)?.[1];
  assert.ok(addr, r.stderr);
  assert.equal(cli(b, ['check', '--to', addr]).status, 0);
});

test('DEC-a-581: a check-in takes delivery of controller mail older than 15 min, and is refused before that', () => {
  const { a, b, sync } = homes();
  oldMail(a, 1, 5);
  sync();
  let r = cli(b, ['check', '--to', 'role:controller', '--as', 'checkin']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /MAIL-a-1 is 5 min old: a check-in takes controller mail after 15 min/);
  assert.equal(listMail(b, { to: 'role:controller' })[0].state, 'queued', 'left for the controller');
  oldMail(a, 2, 16);
  sync();
  r = cli(b, ['check', '--as', 'checkin', '--to', 'role:controller']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MAIL-a-2 from/); assert.doesNotMatch(r.stdout, /MAIL-a-1 from/);
  assert.match(r.stdout, /left for the controller: MAIL-a-1 \(5 min\)/);
  assert.deepEqual(listMail(b, { to: 'role:controller' }).map(x => [x.id, x.state]), [['MAIL-a-1', 'queued'], ['MAIL-a-2', 'delivered']]);
  // the controller itself takes its mail at any age
  assert.deepEqual(checkMail(b, { by: 'controller', to: 'role:controller', via: 'cli' }).map(x => x.id), ['MAIL-a-1']);
});

test('an urgent arrival for the controller returns exactly one notice; plain mail and mail for another box none', () => {
  const { a, b, sync } = homes();
  const u = sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'now', body: 'x', urgent: true });
  sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'later', body: 'y' });
  sendMail(a, { by: 'controller', to: 'role:checkin@b', subject: 'ci', body: 'z', urgent: true });
  assert.deepEqual(arrivalNotices(b), [], 'nothing arrived yet');
  sync();
  const n = arrivalNotices(b);
  assert.equal(n.length, 1);
  assert.match(n[0].title, new RegExp(`URGENT mail ${u.id} for role:controller@b`));
  assert.match(n[0].body, /now/); assert.match(n[0].body, /norn mail check/);
  assert.deepEqual(arrivalNotices(b), [], 'once');
  sync();
  assert.deepEqual(arrivalNotices(b), [], 'a second fetch of the same mail: still once');
});

// NORN-MAIL-WAIT: home b's controller session waits; its fetch (here the fixture's sync, in the CLI the tick's stale fetch) brings home a's mail
test('home a mails role:controller@b -> home b\'s wait gets it through the fetch, delivers it; home a\'s list: at b, then delivered', async () => {
  const { a, b, sync } = homes();
  const m = sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'wake', body: 'from a' });
  let t = Date.parse('2026-11-25T10:00:00Z'), fetches = 0;
  // the fetch: b pulls a's log, and b's receipt (it holds a's mail up to m) reaches a, as b's next publish carries it
  const fetch = () => {
    fetches++;
    if (fetches < 2) return;   // the first round's fetch finds nothing new yet
    sync();
    fs.mkdirSync(path.join(a, 'homes', 'b'), { recursive: true });
    fs.writeFileSync(path.join(a, 'homes', 'b', 'seen.json'), JSON.stringify({ polled_at: '2026-11-25T10:00:00Z', held: { a: { 'mail.jsonl': m.seq } } }));
  };
  const got = await waitMail(b, { by: 'controller', to: 'role:controller', timeoutMin: 5, now: () => t, sleep: async ms => { t += ms; }, fetch });
  assert.deepEqual(got.map(x => [x.id, x.text]), [[m.id, 'from a']]);
  assert.equal(fetches, 2);
  assert.match(listMail(a)[0].where, /^at b, b last polled /, 'before b\'s log comes back: at b, from the receipt');
  sync();
  assert.equal(listMail(a)[0].where, 'delivered');
  assert.equal(listMail(b, { to: 'role:controller' })[0].state, 'delivered');
});
