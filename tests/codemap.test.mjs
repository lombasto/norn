// task NORN-FLOORPLAN-MAP (Code > Map): lib/codemap.mjs over SYNTHETIC parts only - the pinned tool (tools/floorplan: manifest + lock),
// its install from a synthetic tag archive checked against the lock and its CHECKSUMS.txt (a tampered file, archive or list refused),
// `norn code map` drawing a map with a synthetic Floorplan skill (the workflow.json driver; a fake model; the seed architecture.json from
// docs/ skips the architecture job) into <state>/code/map, a refresh under the meter redrawn and one over it skipped with one tick-log
// line, GET /code-map/'s own sandboxed CSP + ETag, the tick's on-merge start and codeAt's map part. Sandbox only (mkTmp).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { readPin, floorplanHome, drawMap, codeMapPage, mapCsp, tickMap, MAP_REFRESH_MAX_PCT } from '../engine/lib/codemap.mjs';
import { codeCmd, codeAt } from '../engine/lib/codecli.mjs';

test.after(cleanTmp);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const put = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

test('the pinned tool: tools/floorplan holds the manifest (v0.11.0, the tag archive) and the lock (archive + CHECKSUMS.txt hashes)', () => {
  const { manifest, lock } = readPin();
  assert.equal(manifest.version, '0.11.0');
  assert.equal(manifest.archive, `https://github.com/haydenschmitty/floorplan/archive/refs/tags/${manifest.tag}.tar.gz`);
  assert.equal(lock.tag, manifest.tag);
  for (const k of ['archive_sha256', 'checksums_sha256']) assert.match(lock[k], /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(path.join(REPO, 'docs', 'architecture.json')), 'the reviewed seed is committed in docs/');
  const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'architecture.json'), 'utf8'));
  assert.equal(seed.audience, 'developers');
  assert.ok(seed.nodes.some(n => /^Sync/.test(n.label)), 'Sync is a part of its own, not Merging');
  assert.ok(seed.edges.some(e => e.from === 'dash.pages' && e.to === 'dash.server' && e.kind === 'http'), 'the /api router is the endpoints');
});

// ---- a synthetic release: <root>/skills/floorplan + CHECKSUMS.txt, packed with tar ----
const WORKFLOW = {
  conventions: { environment: { FLOORPLAN_UNATTENDED: '1' }, answerRetries: 1 },
  start: { run: 'status.mjs', args: ['--json'], save: 'status', choose: [{ when: [{ path: 'status.state', op: 'in', value: ['map'] }], workflow: 'refresh' },
    { when: [{ path: 'status.state', op: 'in', value: ['none', 'unbuilt'] }], workflow: 'first_map' }] },
  workflows: {
    first_map: { steps: [{ id: 'scan', run: 'scan.mjs', args: ['--json'], save: 'scan' },
      { id: 'architecture', repeat: [{ id: 'write-architecture', job: 'architecture' }, { id: 'build', run: 'build.mjs', args: ['--json'], save: 'build', allowFailure: true }],
        until: [{ path: 'build.ok', op: 'equals', value: true }], maxAttempts: 2, failMessage: 'no build' },
      { id: 'describe', use: 'describe' }], done: [{ path: 'build.ok', op: 'equals', value: true }] },
    refresh: { steps: [{ id: 'refresh', run: 'refresh.mjs', args: ['--json'], save: 'refresh', saveFields: { build: 'build' }, allowFailure: true },
      { id: 'next', next: 'refresh.next', handlers: { describe: 'describe', recent_work: { skip: true } } }], done: [{ path: 'build.ok', op: 'equals', value: true }] },
  },
  procedures: { describe: [{ id: 'list', run: 'describe.mjs', args: ['--json'], save: 'describe' },
    { id: 'fill', job: 'descriptions', forEach: 'describe.worksheets', as: 'worksheet', parallel: true }, { id: 'rebuild', run: 'build.mjs', args: ['--json'], save: 'build' }] },
  jobs: { architecture: { read: [], input: [], instructions: 'map it', schema: 'arch', writes: 'floorplan/architecture.json', toolCalls: 1 },
    descriptions: { read: [], input: [{ name: 'worksheet', from: 'worksheet' }], instructions: 'describe it', schema: 'desc', writes: 'floorplan/descriptions/{worksheet.key}.json', toolCalls: 1 } },
  schemas: { arch: { type: 'object', required: ['nodes'] }, desc: { type: 'object', required: ['files'] } },
};
const HEAD = "const fs = require('fs'), path = require('path'), R = process.argv[2], F = (...p) => path.join(R, 'floorplan', ...p), say = o => process.stdout.write(JSON.stringify(o));\n"
  + "const sheets = () => Number(fs.readFileSync(path.join(R, 'sheets.txt'), 'utf8'));\n";
const SCRIPTS = {
  'status.cjs': "say({ ok: true, state: fs.existsSync(F('index.html')) ? 'map' : fs.existsSync(F('architecture.json')) ? 'unbuilt' : 'none' });",
  'scan.cjs': "say({ ok: true, summary: 'two files' });",
  'build.cjs': "if (!fs.existsSync(F('architecture.json'))) { say({ ok: false, errors: ['no architecture.json'] }); process.exit(1); }\n"
    + "const d = fs.existsSync(F('descriptions')) ? fs.readdirSync(F('descriptions')).length : 0;\n"
    + "fs.writeFileSync(F('index.html'), `<!doctype html><meta http-equiv=\"Content-Security-Policy\" data-floorplan-policy=\"local\" content=\"default-src 'none'; script-src 'sha256-AAAA'; connect-src 'self'; img-src data:\"><p>sheets ${sheets()} described ${d}</p>`);\n"
    + "say({ ok: true, files: { unassignedPercent: 0 }, descriptions: { complete: true } });",
  'describe.cjs': "const w = []; for (let i = 0; i < sheets(); i++) if (!fs.existsSync(F('descriptions', `s${i}.json`))) w.push({ key: `s${i}`, descriptions: `floorplan/descriptions/s${i}.json` });\n"
    + "say({ ok: true, nothingToDo: !w.length, worksheets: w });",
  'refresh.cjs': "fs.rmSync(F('descriptions'), { recursive: true, force: true }); say({ ok: true, map: true, build: { ok: true }, next: [{ code: 'describe' }, { code: 'recent_work' }] });",
};
function release(d, { tamper = false } = {}) {
  const root = path.join(d, 'rel', 'fp-9.9.9'), files = { 'skills/floorplan/workflow.json': JSON.stringify(WORKFLOW), 'skills/floorplan/scripts/serve.mjs': 'throw new Error("never")\n' };
  for (const [f, t] of Object.entries(SCRIPTS)) files[`skills/floorplan/scripts/${f.replace('.cjs', '.mjs')}`] = `// synthetic\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n${HEAD}${t}\n`;
  for (const [f, t] of Object.entries(files)) put(path.join(root, f), t);
  const sums = `# synthetic\n${Object.entries(files).map(([f, t]) => `${sha256(t)}  ${f}`).join('\n')}\n`;
  put(path.join(root, 'CHECKSUMS.txt'), sums);
  if (tamper) fs.appendFileSync(path.join(root, 'skills/floorplan/workflow.json'), ' ');
  execFileSync('tar', ['-czf', 'a.tgz', 'fp-9.9.9'], { cwd: path.join(d, 'rel') });
  const archive = fs.readFileSync(path.join(d, 'rel', 'a.tgz'));
  return { archive, pin: { manifest: { name: 'floorplan', version: '9.9.9', archive: 'https://example.invalid/fp.tgz', root: 'fp-9.9.9', skill: 'skills/floorplan' },
    lock: { archive_sha256: sha256(archive), checksums_sha256: sha256(sums), checksums_files: Object.keys(files).length } } };
}

test('floorplanHome: the archive checked against the lock, every file against CHECKSUMS.txt, unpacked once into the meta root cache', () => {
  const d = mkTmp('meta-fp-'), env = { META_ROOT: path.join(d, 'meta') }, { archive, pin } = release(d);
  let fetched = 0;
  const home = floorplanHome({ env, pin, fetchArchive: () => { fetched++; return archive; } });
  assert.ok(home.startsWith(path.join(d, 'meta', 'state', 'tools', 'floorplan')), home);
  assert.ok(fs.existsSync(path.join(home, 'workflow.json')), 'the home is the skill folder');
  assert.equal(floorplanHome({ env, pin, fetchArchive: () => { fetched++; return archive; } }), home);
  assert.equal(fetched, 1, 'a verified home is reused');
  const e2 = { META_ROOT: path.join(d, 'meta2') };
  assert.throws(() => floorplanHome({ env: e2, pin: { ...pin, lock: { ...pin.lock, archive_sha256: '0'.repeat(64) } }, fetchArchive: () => archive }), /archive sha256/);
  assert.throws(() => floorplanHome({ env: e2, pin: { ...pin, lock: { ...pin.lock, checksums_sha256: '0'.repeat(64) } }, fetchArchive: () => archive }), /CHECKSUMS\.txt/);
  const bad = release(mkTmp('meta-fp-bad-'), { tamper: true });
  assert.throws(() => floorplanHome({ env: e2, pin: bad.pin, fetchArchive: () => bad.archive }), /checksum mismatch: skills\/floorplan\/workflow\.json/);
  assert.equal(fs.existsSync(path.join(d, 'meta2', 'state', 'tools', 'floorplan')) && fs.readdirSync(path.join(d, 'meta2', 'state', 'tools', 'floorplan')).filter(x => !x.startsWith('dl')).length, 0, 'a refused archive leaves no home');
});

// ---- a synthetic project repo + the fake model ----
function world() {
  const d = mkTmp('meta-map-'), repo = path.join(d, 'repo'), state = path.join(d, 'state', 'kestrel'), env = { META_ROOT: path.join(d, 'meta') };
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  fs.mkdirSync(repo, { recursive: true }); g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  put(path.join(repo, 'a.mjs'), 'export const a = 1;\n'); put(path.join(repo, 'sheets.txt'), '1');
  put(path.join(repo, 'docs', 'architecture.json'), JSON.stringify({ audience: 'developers', project: { name: 'kestrel' }, nodes: [{ id: 'app', label: 'App', kind: 'library', paths: ['**'] }] }));
  g('add', '-A'); g('commit', '-q', '-m', 'one');
  const { archive, pin } = release(d), skill = floorplanHome({ env, pin, fetchArchive: () => archive });
  const asked = [], ask = async (prompt, schema, label) => { asked.push(label.replace(/#\d+$/, ''));
    return { answer: label.startsWith('descriptions') ? { files: {} } : { nodes: [] }, usage: { cache_read_input_tokens: 1000, output_tokens: 100 } }; };   // 6,000 weighted a call
  const budget = { cacheR_per_pct: 1e6 };   // 1 % = 1 M: a job = 0.006 %
  const commit = (sheets) => { put(path.join(repo, 'sheets.txt'), String(sheets)); g('commit', '-q', '-am', `sheets ${sheets}`); return g('rev-parse', '--short=12', 'HEAD'); };
  return { d, repo, state, env, skill, ask, asked, budget, commit, head: () => g('rev-parse', '--short=12', 'HEAD') };
}
const mapDir = state => path.join(state, 'code', 'map');
const tickLog = state => { try { return fs.readFileSync(path.join(state, 'tick.log'), 'utf8'); } catch { return ''; } };

test('drawMap: the first map from the seed (no architecture job), the descriptions asked, index.html + map.json in <state>/code/map, never in the repo', async () => {
  const w = world();
  const r = await drawMap({ state: w.state, repo: w.repo, skill: w.skill, ask: w.ask, budget: w.budget, env: w.env });
  assert.equal(r.drawn, true, JSON.stringify(r));
  assert.deepEqual(w.asked, ['descriptions:s0'], 'the seed built: no architecture job');
  const html = fs.readFileSync(path.join(mapDir(w.state), 'index.html'), 'utf8'), m = JSON.parse(fs.readFileSync(path.join(mapDir(w.state), 'map.json'), 'utf8'));
  assert.match(html, /sheets 1 described 1/);
  assert.equal(m.sha, w.head()); assert.equal(m.workflow, 'first_map'); assert.equal(m.tool, '9.9.9');
  assert.deepEqual([m.calls, m.weighted], [1, 6000]); assert.match(m.etag, /^"[0-9a-f]{16}"$/);
  assert.match(m.csp, /script-src 'sha256-AAAA'/, 'the map\'s own meta policy kept');
  assert.equal(fs.existsSync(path.join(w.repo, 'floorplan')), false, 'nothing written in the project repo');
  assert.equal(execFileSync('git', ['-C', w.repo, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});

test('drawMap refresh: metered - under 0.05 % it redraws at the new sha; over it the refresh is skipped with one tick-log line and the map kept', async () => {
  const w = world();
  await drawMap({ state: w.state, repo: w.repo, skill: w.skill, ask: w.ask, budget: w.budget, env: w.env });
  assert.equal(MAP_REFRESH_MAX_PCT, 0.05);
  const s2 = w.commit(2); w.asked.length = 0;   // 2 worksheets + recent work = 3 jobs x 6,000 = 0.018 %
  const r = await drawMap({ state: w.state, repo: w.repo, skill: w.skill, ask: w.ask, budget: w.budget, env: w.env, refresh: true });
  assert.equal(r.drawn, true, JSON.stringify(r)); assert.deepEqual(w.asked.sort(), ['descriptions:s0', 'descriptions:s1']);
  let m = JSON.parse(fs.readFileSync(path.join(mapDir(w.state), 'map.json'), 'utf8'));
  assert.deepEqual([m.sha, m.workflow], [s2, 'refresh']); assert.match(fs.readFileSync(path.join(mapDir(w.state), 'index.html'), 'utf8'), /sheets 2 described 2/);
  const s3 = w.commit(9); w.asked.length = 0;   // 9 + 1 = 10 jobs x 6,000 = 0.06 % > 0.05 %
  const k = await drawMap({ state: w.state, repo: w.repo, skill: w.skill, ask: w.ask, budget: w.budget, env: w.env, refresh: true });
  assert.equal(k.drawn, false); assert.match(k.skipped, /0\.06 % > 0\.05 %/);
  assert.deepEqual(w.asked, [], 'no model call for a skipped refresh');
  m = JSON.parse(fs.readFileSync(path.join(mapDir(w.state), 'map.json'), 'utf8'));
  assert.equal(m.sha, s2, 'the drawn map stays'); assert.equal(m.skipped.sha, s3);
  assert.match(fs.readFileSync(path.join(mapDir(w.state), 'index.html'), 'utf8'), /sheets 2 described 2/);
  const lines = tickLog(w.state).trim().split('\n').filter(l => l.includes('code map'));
  assert.equal(lines.length, 1); assert.match(lines[0], new RegExp(`code map: refresh skipped at ${s3}: ~0\\.06 % > 0\\.05 % of plan \\(10 model jobs\\); \`norn code map\` draws it`));
  const owner = await drawMap({ state: w.state, repo: w.repo, skill: w.skill, ask: w.ask, budget: w.budget, env: w.env });   // the owner's draw: unmetered
  assert.equal(owner.drawn, true); assert.equal(JSON.parse(fs.readFileSync(path.join(mapDir(w.state), 'map.json'), 'utf8')).sha, s3);
  w.commit(1);
  const nc = await drawMap({ state: w.state, repo: w.repo, skill: w.skill, ask: w.ask, budget: {}, env: w.env, refresh: true });
  assert.equal(nc.drawn, false); assert.match(nc.skipped, /no plan calibration/, 'no calibration: no metered refresh');
});

test('codeMapPage: GET /code-map/ serves the map under its own sandboxed CSP (no network, frame-ancestors self) with an ETag; 304 on a match', async () => {
  const w = world();
  assert.equal(codeMapPage(w.state).status, 404);
  await drawMap({ state: w.state, repo: w.repo, skill: w.skill, ask: w.ask, budget: w.budget, env: w.env });
  const r = codeMapPage(w.state), csp = r.headers['Content-Security-Policy'];
  assert.equal(r.status, 200); assert.match(String(r.body), /sheets 1/);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(csp, /script-src 'sha256-AAAA'/); assert.match(csp, /connect-src 'none'/); assert.doesNotMatch(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'self'/); assert.match(csp, /sandbox allow-scripts/); assert.match(csp, /form-action 'none'/);
  assert.equal(r.headers['Cache-Control'], 'no-cache'); assert.match(r.headers.ETag, /^"[0-9a-f]{16}"$/);
  assert.equal(codeMapPage(w.state, r.headers.ETag).status, 304);
  assert.equal(mapCsp(''), "default-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts");
});

test('tickMap: on a merge (HEAD past the map) it starts `norn code map --refresh` once per sha; no map yet = the owner\'s first draw, never the tick', async () => {
  const w = world(), p = { file: 'kestrel.json', root: w.repo }, spawned = [], spawnFn = (exe, args) => { spawned.push(args.slice(1)); return { pid: 7 }; };
  assert.equal(tickMap(p, w.state, { metaCmd: 'norn.mjs', spawnFn, head: w.head() }), null, 'no map: nothing');
  await drawMap({ state: w.state, repo: w.repo, skill: w.skill, ask: w.ask, budget: w.budget, env: w.env });
  assert.equal(tickMap(p, w.state, { metaCmd: 'norn.mjs', spawnFn, head: w.head() }), null, 'the map is at HEAD');
  const s2 = w.commit(2);
  assert.equal(tickMap(p, w.state, { metaCmd: 'norn.mjs', spawnFn, head: s2 }), 'code map: refresh started pid 7');
  assert.deepEqual(spawned, [['code', 'map', '--refresh', '--project', 'kestrel.json', '--state', w.state]]);
  assert.equal(tickMap(p, w.state, { metaCmd: 'norn.mjs', spawnFn, head: s2 }), null, 'once per sha');
});

test('norn code map: the verb\'s flags; codeAt\'s map part says what is drawn', async () => {
  const w = world(), errs = [];
  assert.equal(await codeCmd(['map', '--bogus'], { out: () => {}, err: s => errs.push(s), where: () => ({ state: w.state }) }), 2);
  assert.match(errs.join('\n'), /norn code map \[--refresh\]/);
  assert.deepEqual(await codeAt({ name: 'kestrel', state: w.state }, new URL('http://x/api/code?part=map')), { map: null });
  await drawMap({ state: w.state, repo: w.repo, skill: w.skill, ask: w.ask, budget: w.budget, env: w.env });
  const { map } = await codeAt({ name: 'kestrel', state: w.state }, new URL('http://x/api/code?part=map'));
  assert.deepEqual([map.sha, map.tool, map.calls, map.skipped], [w.head(), '9.9.9', 1, null]);
});
