// issue #104: `norn setup` and every other writer of local/machine.json do a read-modify-write: the keys a writer does not own (ledger with
// its doorbell secret, usage, fed, any unknown one - top level or nested in a block it owns) are carried over byte-equal. Temp meta root,
// temp home, fake PATH; synthetic values only (the doorbell topic is made up).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateMachine } from '../engine/lib/config.mjs';
import { mkTmp } from './helpers/tmp.mjs';
import { rustReady } from './helpers/rust.mjs';

test.before(rustReady);   // norn setup builds norn-hook and norn-code: a cold build runs here, never inside a step's time limit

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const WIN = process.platform === 'win32';
const KEPT = {
  ledger: { remote: 'https://example.invalid/synthetic/ledger.git', home_id: 'a', doorbell: { topic: 'synthetic-doorbell-0000' } },
  usage: { checkin: ['five_hour'], chat: ['seven_day'] },
  fed: { host: 'host-a', labels: ['win'] },
};
// keys the schema does not know: every command refuses such a file (loadMachine), but setup - the repair step - must not lose them either
const UNKNOWN = { zz_future: { any: ['thing', 1, null] } };

function sandbox() {
  const t = mkTmp('meta-keepkeys-');
  const d = { root: path.join(t, 'meta'), home: path.join(t, 'home'), bin: path.join(t, 'bin'), cfg: path.join(t, 'claude-cfg') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  for (const n of ['git', 'claude']) fs.writeFileSync(path.join(d.bin, WIN ? n + '.exe' : n), '');
  const env = { ...process.env, PATH: d.bin, HOME: d.home, USERPROFILE: d.home, CLAUDE_CONFIG_DIR: d.cfg,
    LOCALAPPDATA: path.join(d.home, 'AppData', 'Local'), APPDATA: path.join(d.home, 'AppData', 'Roaming'), META_ROOT: d.root };
  delete env.NPM_CONFIG_PREFIX; delete env.npm_config_prefix;
  const mf = path.join(d.root, 'local', 'machine.json');
  const run = (...a) => { const r = spawnSync(process.execPath, [META, ...a], { env, encoding: 'utf8', windowsHide: true }); return { code: r.status, out: r.stdout + r.stderr }; };
  return { ...d, mf, run, text: () => fs.readFileSync(mf, 'utf8'), json: () => JSON.parse(fs.readFileSync(mf, 'utf8')) };
}
/** a machine.json setup wrote, plus the keys setup does not own (unknown: also keys the schema lacks, one nested in its claude block) */
function seeded({ unknown = false } = {}) {
  const sb = sandbox(), r = sb.run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(r.code, 0, r.out);
  const m = sb.json(); Object.assign(m, KEPT, unknown ? UNKNOWN : {}); if (unknown) m.claude.zz_note = 'kept';
  fs.writeFileSync(sb.mf, JSON.stringify(m, null, 1) + '\n');
  return sb;
}
const keeps = (sb, why, { unknown = false } = {}) => {
  const m = sb.json(), text = sb.text();
  for (const [k, v] of Object.entries({ ...KEPT, ...(unknown ? UNKNOWN : {}) })) {
    assert.equal(JSON.stringify(m[k]), JSON.stringify(v), `${why}: ${k} kept`);
    assert.ok(text.includes(`"${k}": ${JSON.stringify(v, null, 1).split('\n').join('\n ')}`), `${why}: ${k} byte-equal`);
  }
  if (unknown) assert.equal(m.claude.zz_note, 'kept', `${why}: an unknown key nested in a block setup owns`);
};

test('setup keeps ledger (its doorbell topic), usage, fed and unknown keys byte-equal; a second setup is a no-op on the file', () => {
  const sb = seeded({ unknown: true });
  const r = sb.run('setup', '--non-interactive', '--no-scheduler');
  assert.match(r.out, /wrote .*machine\.json/);
  keeps(sb, 'setup', { unknown: true });
  const once = sb.text();
  sb.run('setup', '--non-interactive', '--no-scheduler');
  assert.equal(sb.text(), once, 'a second setup run writes the same bytes');
});

test('project add and project remove keep the keys they do not own', () => {
  const sb = seeded(), pd = path.join(sb.root, 'projects', 'demo'), f = path.join(pd, 'project.json');
  fs.mkdirSync(pd, { recursive: true }); fs.mkdirSync(path.join(sb.home, 'dev', 'demo'), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'demo', title: 'demo', root: '${home}/dev/demo' }));
  const a = sb.run('project', 'add', f);
  assert.deepEqual(sb.json().projects.map(p => p.name), ['demo'], a.out);
  keeps(sb, 'project add');
  sb.run('project', 'remove', 'demo');
  assert.deepEqual(sb.json().projects, []);
  keeps(sb, 'project remove');
});

test('updateMachine: the returned keys replace, an undefined one is dropped on purpose, the rest is carried in place', () => {
  const f = path.join(mkTmp('meta-keepkeys-'), 'local', 'machine.json');
  assert.deepEqual(updateMachine(f, raw => ({ schema: 1, n: raw.n ?? 0 })), { schema: 1, n: 0 }, 'no file = an empty start');
  fs.writeFileSync(f, '\uFEFF' + JSON.stringify({ schema: 1, ...KEPT, notify: { backend: 'toast' }, ...UNKNOWN }, null, 1) + '\n');
  const w = updateMachine(f, raw => ({ ledger: { ...raw.ledger, home_id: 'b' }, notify: undefined }));
  assert.deepEqual(Object.keys(w), ['schema', 'ledger', 'usage', 'fed', 'zz_future']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), w);
  assert.equal(w.ledger.doorbell.topic, KEPT.ledger.doorbell.topic); assert.equal(w.ledger.home_id, 'b');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['machine.json'], 'no tmp file left');
});
