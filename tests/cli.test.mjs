// S1 `norn rec` CLI: the agents' only writer. Invalid input -> exit 2 + usage line; ids on stdout; views regenerated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');
const tmp = () => mkTmp('meta-cli-');
const run = (state, role, ...args) => {
  const env = { ...process.env, META_STATE: state, META_ROLE: role };
  delete env.META_RUN_ID; delete env.META_PROJECT;   // a run's META_PROJECT would win over META_STATE (norn.mjs:734)
  const r = spawnSync(process.execPath, [META, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

test('norn slop with a project that does not exist: exit 2 and one error line, no stack trace (cli-C11)', () => {
  const r = run(tmp(), 'owner', 'slop', 'check', '--project', 'nosuch');
  assert.equal(r.code, 2, r.err); assert.match(r.err, /^error: nosuch: not found/); assert.doesNotMatch(r.err, /at main|ConfigError/);
});

test('norn size takes the run of a home (RUN-b-3) as a run id: an unknown one is "no run", not "unexpected" (L-02)', () => {
  const r = run(tmp(), 'owner', 'size', 'RUN-b-3');
  assert.equal(r.code, 2); assert.match(r.err, /^error: no run RUN-b-3$/m);
});

test('norn collide plan reads the project policy as the tick does: collide.kinds.stale off lists no stale caveat (C14)', () => {
  const t = tmp(), repo = path.join(t, 'repo'), state = path.join(t, 'state'), pf = path.join(t, 'project.json');
  const env = { ...process.env, META_ROOT: t, META_STATE: '', META_PROJECT: '', META_NO_TICK: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  fs.mkdirSync(repo); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']]) spawnSync('git', a, { cwd: repo, env });
  fs.writeFileSync(pf, JSON.stringify({ schema: 1, name: 'k', title: 'k', root: repo.split(path.sep).join('/'), ledger: '${root}/L.md', briefs_dir: '${root}',
    policy: { slop: { enabled: false }, collide: { kinds: { stale: 'off' } } } }));
  const gone = record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane: 'banks', stage: 'S2' } }).id;
  record(state, { kind: 'run', ev: 'end', id: gone, by: 'launcher', data: { outcome: 'stopped', exit: 0 } });
  const theme = record(state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'theme', title: 'Theme' } }).id;
  const rm = record(state, { kind: 'item', ev: 'create', by: 'owner', data: { kind: 'item', title: 'Banks hold', parent: theme, links: ['lane:banks'] } }).id;
  record(state, { kind: 'item', ev: 'edit', id: rm, by: 'owner', data: { caveat: `${gone} running the edge pass` } });
  const r = spawnSync(process.execPath, [META, 'collide', 'plan', '--project', pf, '--state', state, '--json'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).stale, []);
});

test('add question -> Q-1 on stdout, envelope written, questions view generated', () => {
  const s = tmp();
  fs.writeFileSync(path.join(s, 'body.md'), 'Seed 7: 3 sinks.\n');
  const r = run(s, 'checkin', 'rec', 'add', 'question', '--lane', 'gen', '--title', 'Carve or fill?', '--body-file', path.join(s, 'body.md'),
    '--option', 'a|carve|1 round', '--option', 'b|fill', '--recommend', 'a|keeps relief', '--class', 'ii', '--blocks', 'gen', '--source', 'NOTES.md:4');
  assert.equal(r.code, 0, r.err); assert.equal(r.out, 'Q-1');
  const e = JSON.parse(fs.readFileSync(path.join(s, 'records.jsonl'), 'utf8'));
  assert.equal(e.by, 'checkin'); assert.equal(e.run, null);
  assert.deepEqual(e.data.options, [{ key: 'a', text: 'carve', cost: '1 round' }, { key: 'b', text: 'fill', cost: '' }]);
  assert.deepEqual(e.data.recommend, { key: 'a', why: 'keeps relief', from: 'checkin' });   // a recommendation names its source: the writer
  assert.deepEqual(e.data.blocks, ['gen']); assert.equal(e.data.body, 'Seed 7: 3 sinks.\n');
  assert.match(fs.readFileSync(path.join(s, 'views', 'OWNER-QUESTIONS.md'), 'utf8'), /### Q-1 · Carve or fill\?/);
});

test('checkin add waiver keeps --q: refuses an open question, records the owner answer', () => {
  const s = tmp();
  const q = run(s, 'checkin', 'rec', 'add', 'question', '--lane', 'gen', '--title', 'Waive K9?');
  assert.equal(q.code, 0, q.err); assert.equal(q.out, 'Q-1');
  const args = ['rec', 'add', 'waiver', '--rule', 'K9', '--scope', 'abc', '--why', 'w', '--q', 'Q-1'];
  const open = run(s, 'checkin', ...args);
  assert.equal(open.code, 2, open.err);
  assert.equal(fs.existsSync(path.join(s, 'waivers.jsonl')), false);
  const answer = run(s, 'owner', 'rec', 'answer', 'Q-1', '--text', 'Waive K9 for abc', '--via', 'chat');
  assert.equal(answer.code, 0, answer.err);
  const waived = run(s, 'checkin', ...args);
  assert.equal(waived.code, 0, waived.err); assert.equal(waived.out, 'WVR-1');
  const e = JSON.parse(fs.readFileSync(path.join(s, 'waivers.jsonl'), 'utf8'));
  assert.equal(e.by, 'checkin'); assert.equal(e.kind, 'waiver'); assert.equal(e.ev, 'create');
  assert.deepEqual(e.data, { rule: 'K9', scope: 'abc', why: 'w', q: 'Q-1' });
  assert.match(open.err, /Q-1 is open, not answered/);
});

test('answer / apply / supersede / list / show round trip', () => {
  const s = tmp();
  assert.equal(run(s, 'checkin', 'rec', 'add', 'question', '--lane', 'gen', '--title', 'T', '--option', 'a|A', '--option', 'b|B').out, 'Q-1');
  assert.equal(run(s, 'owner', 'rec', 'answer', 'Q-1', '--choice', 'b', '--text', 'b, because', '--via', 'chat').code, 0);
  const d = run(s, 'checkin', 'rec', 'add', 'decision', '--lane', 'gen', '--question', 'T', '--choice', 'b', '--why', 'owner', '--answers', 'Q-1', '--notify');
  assert.equal(d.out, 'DEC-1', d.err);
  const ap = run(s, 'checkin', 'rec', 'apply', 'Q-1', '--refs', 'DEC-1,RUN-3');
  assert.equal(ap.code, 0, ap.err); assert.equal(ap.out, 'Q-1 applied');
  assert.equal(run(s, 'owner', 'rec', 'add', 'directive', '--text', 'cap 4', '--via', 'chat').out, 'DIR-1');
  assert.equal(run(s, 'owner', 'rec', 'add', 'directive', '--text', 'cap 2', '--via', 'chat').out, 'DIR-2');
  const sp = run(s, 'checkin', 'rec', 'supersede', 'DIR-1', '--by', 'DIR-2', '--why', 'its own text');
  assert.equal(sp.code, 0, sp.err); assert.equal(sp.out, 'DIR-1 superseded');
  assert.equal(run(s, 'controller', 'rec', 'add', 'lane', '--name', 'gen', '--worktree', 'C:/w').out, 'L:gen');
  assert.equal(run(s, 'controller', 'rec', 'park', 'L:gen', '--why', 'waits').out, 'L:gen parked');
  const open = JSON.parse(run(s, 'checkin', 'rec', 'list', '--open', '--json').out);
  assert.deepEqual(open.map(i => i.id), ['DIR-2', 'L:gen']);
  const all = run(s, 'checkin', 'rec', 'list', '--kind', 'Q');
  assert.match(all.out, /^Q-1\s+applied\s+gen\s+T$/);
  const show = JSON.parse(run(s, 'checkin', 'rec', 'show', 'Q-1', '--json').out);
  assert.deepEqual(show.history.map(h => h.ev), ['create', 'answer', 'apply']);
  assert.match(run(s, 'checkin', 'rec', 'show', 'Q-1').out, /answer by owner/);
});

test('list --open includes answered-not-applied Q and unreviewed ended runs', () => {
  const s = tmp();
  run(s, 'checkin', 'rec', 'add', 'question', '--lane', 'gen', '--title', 'A');
  run(s, 'checkin', 'rec', 'add', 'question', '--lane', 'gen', '--title', 'B');
  run(s, 'owner', 'rec', 'answer', 'Q-2', '--text', 'yes', '--via', 'dashboard');
  fs.writeFileSync(path.join(s, 'runs.jsonl'), [
    { v: 1, seq: 1, ts: '2026-10-31T00:00:00Z', id: 'RUN-1', kind: 'run', ev: 'start', by: 'launcher', run: null, data: { kind: 'fake' } },
    { v: 1, seq: 2, ts: '2026-10-31T00:01:00Z', id: 'RUN-1', kind: 'run', ev: 'end', by: 'launcher', run: null, data: { exit: 0, outcome: 'stopped' } },
    { v: 1, seq: 3, ts: '2026-10-31T00:02:00Z', id: 'RUN-2', kind: 'run', ev: 'start', by: 'launcher', run: null, data: { kind: 'fake' } },
  ].map(e => JSON.stringify(e) + '\n').join(''));
  const open = JSON.parse(run(s, 'checkin', 'rec', 'list', '--open', '--json').out);
  assert.deepEqual(open.map(i => `${i.id}:${i.state}`), ['Q-1:open', 'Q-2:answered', 'RUN-1:exited']);
});

test('invalid input exits 2 with an error and a usage line; nothing is written', () => {
  const s = tmp();
  const cases = [
    ['checkin', 'rec', 'add', 'question', '--lane', 'gen'],                                   // missing title
    ['checkin', 'rec', 'add', 'question', '--lane', 'gen', '--title', 'T', '--bogus', 'x'],    // unknown flag
    ['checkin', 'rec', 'add', 'directive', '--text', 'x', '--via', 'chat'],                    // role
    ['checkin', 'rec', 'answer', 'Q-1', '--text', 'x', '--via', 'chat'],                       // role + missing id
    ['owner', 'rec', 'answer', 'Q-9', '--text', 'x', '--via', 'chat'],                         // unknown id
    ['nobody', 'rec', 'add', 'question', '--lane', 'gen', '--title', 'T'],                     // unknown role
    ['checkin', 'rec', 'add', 'question', '--lane', 'gen', '--title', 'T', '--option', 'nokey'], // option grammar
    ['checkin', 'rec', 'frobnicate'],
    ['checkin', 'rec'],
  ];
  for (const c of cases) {
    const r = run(s, ...c);
    assert.equal(r.code, 2, c.join(' ') + '\n' + r.err);
    assert.match(r.err, /^error: /m, c.join(' '));
    assert.match(r.err, /^usage: norn rec/m, c.join(' '));
  }
  assert.equal(fs.existsSync(path.join(s, 'records.jsonl')), false);
  const noState = spawnSync(process.execPath, [META, 'rec', 'list'], { env: { ...process.env, META_STATE: '', META_PROJECT: '', META_ROLE: 'checkin' }, encoding: 'utf8' });
  assert.equal(noState.status, 2); assert.match(noState.stderr, /META_STATE|--state/);
});

test('--as and --state flags override the env; META_RUN_ID lands in the envelope', () => {
  const s = tmp();
  const r = spawnSync(process.execPath, [META, 'rec', 'add', 'question', '--state', s, '--as', 'controller', '--lane', 'x', '--title', 'T'],
    { env: { ...process.env, META_STATE: '', META_PROJECT: '', META_ROLE: 'owner', META_RUN_ID: 'RUN-44' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const e = JSON.parse(fs.readFileSync(path.join(s, 'records.jsonl'), 'utf8'));
  assert.equal(e.by, 'controller'); assert.equal(e.run, 'RUN-44');
});

test('a hand-edited view: the record is still written, stderr warns, `rec views` exits 1 until reverted', () => {
  const s = tmp();
  run(s, 'checkin', 'rec', 'add', 'question', '--lane', 'gen', '--title', 'A');
  const qv = path.join(s, 'views', 'OWNER-QUESTIONS.md');
  const gen = fs.readFileSync(qv, 'utf8');
  fs.appendFileSync(qv, 'my note\n');
  const r = run(s, 'checkin', 'rec', 'add', 'question', '--lane', 'gen', '--title', 'B');
  assert.equal(r.code, 0); assert.equal(r.out, 'Q-2');
  assert.match(r.err, /hand-edited view.*OWNER-QUESTIONS\.md.*NOT regenerated.*Inbox.*revert it/);
  assert.equal(run(s, 'checkin', 'rec', 'views').code, 1);
  fs.writeFileSync(qv, gen);
  assert.equal(run(s, 'checkin', 'rec', 'views').code, 0);
  assert.match(fs.readFileSync(qv, 'utf8'), /Q-2 · B/);
});

test('rec with --project / META_PROJECT writes the project.json views (one copy), not <state>/views (S9)', () => {
  const root = tmp();
  const pj = path.join(root, 'p.json');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 'pv', title: 'pv', root: '${norn}',
    views: { questions: '${state}/out/Q.md', directives: '${state}/out/DIR.md', decisions: '${state}/out/DEC.md' } }));
  const env = { ...process.env, META_ROOT: root, META_PROJECT: pj, META_ROLE: 'owner' };
  delete env.META_STATE; delete env.META_RUN_ID;
  const r = spawnSync(process.execPath, [META, 'rec', 'add', 'directive', '--text', 'keep it', '--via', 'chat'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'DIR-1');
  const state = path.join(root, 'state', 'pv');
  assert.match(fs.readFileSync(path.join(state, 'out', 'DIR.md'), 'utf8'), /DIR-1/);
  const md = () => fs.existsSync(path.join(state, 'views')) ? fs.readdirSync(path.join(state, 'views')).filter(f => f.endsWith('.md')) : [];
  assert.deepEqual(md(), []);  // views/ keeps only hashes.json
  fs.rmSync(path.join(state, 'out'), { recursive: true });
  const v = spawnSync(process.execPath, [META, 'rec', 'views', '--project', pj], { env: { ...env, META_PROJECT: '' }, encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.ok(fs.existsSync(path.join(state, 'out', 'Q.md'))); assert.deepEqual(md(), []);
});

test('rec --project P --state D: --state wins (one rule with run / stop / delegate / deliverables); the project views stay its own state', () => {
  const root = tmp();
  const pj = path.join(root, 'p.json');
  fs.writeFileSync(pj, JSON.stringify({ schema: 1, name: 'pv', title: 'pv', root: '${norn}', views: { directives: '${state}/out/DIR.md' } }));
  const env = { ...process.env, META_ROOT: root, META_ROLE: 'owner' };
  delete env.META_STATE; delete env.META_RUN_ID; delete env.META_PROJECT;
  const other = path.join(root, 'state', 'other');
  const r = spawnSync(process.execPath, [META, 'rec', 'add', 'directive', '--text', 'here', '--via', 'chat', '--project', pj, '--state', other], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), 'DIR-1');
  const own = path.join(root, 'state', 'pv');
  assert.ok(fs.existsSync(path.join(other, 'records.jsonl')), 'the record lands in --state');
  assert.ok(!fs.existsSync(path.join(own, 'records.jsonl')), "not in the project's state");
  assert.ok(!fs.existsSync(path.join(own, 'out', 'DIR.md')) && !fs.existsSync(path.join(other, 'out', 'DIR.md')), "D's records never overwrite the project's views");
  const l = spawnSync(process.execPath, [META, 'rec', 'list', '--project', pj, '--state', other], { env, encoding: 'utf8' });
  assert.equal(l.status, 0, l.stderr); assert.match(l.stdout, /DIR-1/);
});

// META-USAGE-WEEK: norn calib records an owner's claude.ai reading (temp META_ROOT / budget / projects; never the live files)
test('norn calib: writes calib_time_utc + calib_pct, re-derives cacheR_per_pct from the week start, appends the CALIB line; refuses bad pct', async () => {
  const { parseReset } = await import('../engine/lib/cost.mjs');
  const t = tmp(), root = path.join(t, 'meta'), cfg = path.join(t, 'claude'), bf = path.join(t, 'budget.json');
  const R = Date.parse(parseReset('2026-11-04T08:00 local')), H = 3600000, at = new Date(R + 5 * 24 * H);
  const atIso = at.toISOString().slice(0, 16) + 'Z';
  const f = path.join(cfg, 'projects', 'C--w', 'w.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const recs = [[R - H, 999e6], [R + H, 300e6], [R + 2 * 24 * H, 200e6], [at.getTime() + H, 70e6]];   // before the week / inside / after --at
  fs.writeFileSync(f, recs.map(([ms, cr], i) => JSON.stringify({ type: 'assistant', timestamp: new Date(ms).toISOString(), requestId: 'r' + i, message: { id: 'm' + i, usage: { cache_read_input_tokens: cr } } })).join('\n') + '\n');
  fs.mkdirSync(path.join(root, 'usage'), { recursive: true });
  fs.writeFileSync(path.join(root, 'usage', 'CALIB.txt'), 'CALIBRATION 9 2026-11-08T23:05Z: owner reports 71% weekly.\n\nCALIBRATION 10 2026-11-09T18:47Z: owner reports 90% weekly.\n');
  const budget0 = { reset: '2026-11-04T08:00 local', calib_time_utc: '2026-11-01T00:00Z', calib_pct: 3, cacheR_per_pct: 41000000, weekly_stop_pct: 98, lanes: { x: { note: 'kept' } } };
  fs.writeFileSync(bf, JSON.stringify(budget0, null, 2));
  const calib = (...a) => {
    const env = { ...process.env, META_ROOT: root, CLAUDE_CONFIG_DIR: cfg }; delete env.META_RUN_ID; delete env.META_PROJECT; delete env.META_STATE;
    const r = spawnSync(process.execPath, [META, 'calib', ...a], { env, encoding: 'utf8' });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const r = calib('--pct', '50', '--at', atIso, '--budget', bf, '--machine', path.join(t, 'none.json'));
  assert.equal(r.code, 0, r.err);
  const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
  assert.deepEqual([b.calib_time_utc, b.calib_pct, b.cacheR_per_pct], [atIso, 50, 10000000]);   // 500M since the week start / 50
  assert.deepEqual(b.lanes, budget0.lanes, 'the rest of the budget is kept');
  assert.match(r.out, /cacheR_per_pct 41,000,000 -> 10,000,000/);
  assert.match(r.out, /estimated weekly now ~[\d.]+ %/);
  assert.equal(fs.readFileSync(path.join(root, 'usage', 'CALIB.txt'), 'utf8').trimEnd().split('\n').at(-1).slice(0, 52), `CALIBRATION 11 ${atIso}: owner reports 50% weekly`.slice(0, 52));
  // under 10 %: the reading is recorded, cacheR_per_pct is kept (too little data to re-derive)
  const r2 = calib('--pct', '5', '--at', atIso, '--budget', bf, '--machine', path.join(t, 'none.json'));
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(['calib_pct', 'cacheR_per_pct'].map(k => JSON.parse(fs.readFileSync(bf, 'utf8'))[k]), [5, 10000000]);
  const before = fs.readFileSync(bf, 'utf8');
  for (const bad of [['--pct', '101'], ['--pct', '-1'], ['--pct', 'x'], [], ['--pct', '50', '--at', 'yesterday']]) {
    const x = calib(...bad, '--budget', bf, '--machine', path.join(t, 'none.json'));
    assert.equal(x.code, 2, `${bad.join(' ')}: ${x.out} ${x.err}`);
    assert.match(x.err, /usage: norn calib/);
  }
  assert.equal(fs.readFileSync(bf, 'utf8'), before, 'a refused calib writes nothing');
});
