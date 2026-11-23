// Mail between two synced homes (RM-46): a home-less role / lane address means the writer's OWN home. Both homes carry
// bare_home 'a' (the cut), so before this fix home b's `--to role:controller` was home a's controller and home b's controller never
// matched the role:controller@b mail home a sent. Temp state dirs only; a sync is a copy of the other home's mail.jsonl into
// homes/<h>/mail.jsonl (what the ledger pull writes).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sendMail, checkMail, listMail, qualify } from '../engine/lib/mail.mjs';
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
