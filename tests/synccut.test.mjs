// RM-46 S1b (SPEC sec. 6, sec. 8 S1b): norn sync cut - one cut per home, no compatibility layer. A synthetic two-home state: homes a
// (bare) and b (joiner) share one bare git "origin" and one bare ledger remote (the claims branch); each has its own meta root, state
// dir, clone and a lane worktree. gh is a fake (openPr); no test sleeps. Synthetic project `demo` only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncCut, ID_RE } from '../engine/lib/synccut.mjs';
import { ledgerConfig } from '../engine/lib/ledger.mjs';
import { KINDS, loadState, readEvents, recordsFile, homeOf, idPrefix } from '../engine/lib/records.mjs';
import { listClaims } from '../engine/lib/claims.mjs';
import { fedOf } from '../engine/lib/claimsref.mjs';
import { main } from '../engine/bin/norn.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const git = (cwd, ...a) => { const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true }); if (r.status) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const gitOk = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true }).status === 0;
const TS = '2026-11-20T10:00:00Z';
let seq = 0;
const ev = (id, kind, e, by, data = {}, run = null) => JSON.stringify({ v: 1, seq: ++seq, ts: TS, id, kind, ev: e, by, run, data });
const put = (state, file, lines) => fs.writeFileSync(path.join(state, file + '.jsonl'), lines.map(l => l + '\n').join(''));
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@x'];

/** the shared origin + ledger remote (in a's temp root) */
function world() {
  const sa = mkTmp('meta-cut-a-', 'demo'), root = path.dirname(path.dirname(sa));
  const origin = path.join(root, 'origin.git'), ledgerRemote = path.join(root, 'ledger-remote.git');
  for (const d of [origin, ledgerRemote]) spawnSync('git', ['init', '-q', '--bare', '-b', 'main', d], { windowsHide: true });
  const seed = path.join(root, 'seed');
  spawnSync('git', ['init', '-q', '-b', 'main', seed], { windowsHide: true });
  fs.writeFileSync(path.join(seed, 'README.md'), 'demo\n');
  git(seed, 'add', '.'); git(seed, ...ident, 'commit', '-qm', 'init'); git(seed, 'remote', 'add', 'origin', origin); git(seed, 'push', '-q', 'origin', 'main');
  return { sa, origin, ledgerRemote };
}
/** one home: meta root, state dir, ledger config, clone of origin with lane branches (+ a worktree on the first) */
function homeRig(w, name, state = mkTmp(`meta-cut-${name}-`, 'demo'), lanes = []) {
  const meta = path.dirname(path.dirname(state)), mf = path.join(meta, 'local', 'machine.json');
  fs.mkdirSync(path.dirname(mf), { recursive: true }); fs.mkdirSync(path.join(meta, 'reviews'), { recursive: true });
  const machine = { ledger: { dir: path.join(meta, 'ledger.git'), state_root: path.join(meta, 'state'), reviews: path.join(meta, 'reviews'), remote: w.ledgerRemote }, fed: { host: 'host-' + name } };
  fs.writeFileSync(mf, JSON.stringify(machine, null, 2) + '\n');
  const cfg = ledgerConfig(machine, { metaRoot: meta, machineFile: mf });
  const repo = path.join(meta, 'repo');
  spawnSync('git', ['clone', '-q', w.origin, repo], { windowsHide: true });
  const wts = {};
  for (const [i, l] of lanes.entries()) {
    git(repo, 'branch', `norn/${l}`, 'main');
    if (i === 0) { wts[l] = path.join(meta, 'wt-' + l); git(repo, 'worktree', 'add', '-q', wts[l], `norn/${l}`); }
    const cwd = wts[l] || repo;
    if (!wts[l]) git(repo, 'checkout', '-q', `norn/${l}`);
    fs.writeFileSync(path.join(cwd, `${l}.txt`), `${l} RM-3 work\n`);
    git(cwd, 'add', '.'); git(cwd, ...ident, 'commit', '-qm', `${l}: RM-3`);
    if (!wts[l]) git(repo, 'checkout', '-q', 'main');
    git(repo, 'push', '-q', '-u', 'origin', `norn/${l}`);
  }
  fs.writeFileSync(path.join(state, 'PAUSED'), JSON.stringify({ mode: 'drain', by: 'owner', at: TS }) + '\n');
  return { state, meta, mf, cfg, repo, wts, project: { name: 'demo', root: repo } };
}
function seedA(s) {
  put(s, 'records', [ev('L:x', 'lane', 'create', 'checkin', { name: 'x' }), ev('L:pr', 'lane', 'create', 'checkin', { name: 'pr' }),
    ev('Q-1', 'question', 'create', 'checkin', { text: 'ask about RM-1 for lane L:x', links: ['RM-1'] })]);
  put(s, 'roadmap', [ev('RM-1', 'item', 'create', 'owner', { title: 'first', links: ['lane:x'] })]);
  put(s, 'runs', [ev('RUN-1', 'run', 'start', 'launcher', { lane: 'x', branch: 'norn/x', worktree: 'wt' }), ev('RUN-1', 'run', 'end', 'launcher', { outcome: 'done' })]);
  put(s, 'mail', [ev('MAIL-1', 'mail', 'create', 'checkin', { to: 'role:checkin', subject: 'hi', body: 'see RUN-1' })]);
}
function seedB(s) {
  put(s, 'records', [ev('L:slop', 'lane', 'create', 'checkin', { name: 'slop' }), ev('L:w', 'lane', 'create', 'checkin', { name: 'w' }),
    ev('Q-1', 'question', 'create', 'checkin', { text: 'RM-3 and RUN-2 vs RUN-wsl-3, RM-x, UTF-8, not RM-30x; L:slop', links: ['RM-3', 'RUN-2'] }),
    ev('Q-1', 'question', 'answer', 'owner', { text: 'yes, after Q-1' }), ev('DEC-4', 'decision', 'create', 'checkin', { text: 'per Q-1', refs: { 'RM-3': 'parent' } })]);
  put(s, 'roadmap', [ev('RM-3', 'item', 'create', 'owner', { title: 'third', parent: 'RM-1x', after: ['RM-2'] })]);
  put(s, 'runs', [ev('RUN-2', 'run', 'start', 'launcher', { lane: 'slop', branch: 'norn/slop', results: 'results/RUN-2/out.json', resume_of: 'RUN-1' }), ev('RUN-2', 'run', 'end', 'launcher', { outcome: 'done' })]);
  put(s, 'mail', [ev('MAIL-5', 'mail', 'create', 'checkin', { to: 'lane:slop', subject: 'RUN-2 done', body: 'role:checkin please' })]);
  for (const [d, f, body] of [['runs', 'RUN-2.spec.json', JSON.stringify({ id: 'RUN-2', lane: 'slop', resume_of: 'RUN-1' })], ['hb', 'RUN-2.hb', '1'], ['results/RUN-2', 'out.json', '{}'], ['logs', 'RUN-2-dod-gate.log', 'ok']]) {
    fs.mkdirSync(path.join(s, d), { recursive: true }); fs.writeFileSync(path.join(s, d, f), body);
  }
}
const cutA = (A, o = {}) => syncCut({ state: A.state, project: A.project, home: 'a', bare: true, ledger: A.cfg, machineFile: A.mf, openPr: b => b === 'norn/pr', ledgerOpts: { push: false, gc: false }, ...o });
const cutB = (B, o = {}) => syncCut({ state: B.state, project: B.project, home: 'b', bare: false, ledger: B.cfg, machineFile: B.mf, openPr: () => false, ledgerOpts: { push: false, gc: false }, ...o });
function bothHomes() {
  const w = world();
  const A = homeRig(w, 'a', w.sa, ['x', 'pr']); seedA(A.state);
  const B = homeRig(w, 'b', undefined, ['slop']); seedB(B.state);
  return { w, A, B };
}
const remoteHeads = origin => spawnSync('git', ['--git-dir', origin, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8', windowsHide: true }).stdout;
const tree = dir => { const o = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else o[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } }; walk(dir); return o; };

test('the bare home: ids stay, lanes become L:a/x, the branch moves locally (checked out in a worktree) and on origin; an open PR keeps its branch', () => {
  const { w, A } = bothHomes();
  const r = cutA(A, { apply: true });
  assert.deepEqual(r.refused, []);
  assert.equal(r.applied, true);
  const st = loadState(A.state);
  assert.ok(st.items['Q-1'] && st.items['L:a/x'] && st.items['L:a/pr'] && !st.items['L:x']);
  assert.equal(st.items['Q-1'].data.text, 'ask about RM-1 for lane L:a/x');
  assert.deepEqual(readEvents(recordsFile(A.state, 'item'))[0].data.links, ['lane:a/x']);
  assert.equal(readEvents(recordsFile(A.state, 'mail'))[0].data.to, 'role:checkin@a');
  const run = readEvents(recordsFile(A.state, 'run'))[0];
  assert.equal(run.id, 'RUN-1');
  assert.equal(run.data.branch, 'norn/a/x');
  assert.ok(gitOk(A.repo, 'rev-parse', '--verify', 'refs/heads/norn/a/x') && !gitOk(A.repo, 'rev-parse', '--verify', 'refs/heads/norn/x'));
  assert.equal(git(A.wts.x, 'rev-parse', '--abbrev-ref', 'HEAD'), 'norn/a/x', 'git 2.53 renames a branch checked out in a worktree');
  const heads = remoteHeads(w.origin);
  assert.match(heads, /refs\/heads\/norn\/a\/x /); assert.doesNotMatch(heads, /refs\/heads\/norn\/x /);
  assert.match(heads, /refs\/heads\/norn\/pr /, 'an open PR keeps its branch'); assert.doesNotMatch(heads, /norn\/a\/pr/);
  assert.equal(git(A.repo, 'config', 'branch.norn/a/x.merge'), 'refs/heads/norn/a/x');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(A.state, 'home.json'), 'utf8')).id, 'a');
  assert.deepEqual(homeOf(A.state), { id: 'a', bare_home: 'a' });
  assert.equal(JSON.parse(fs.readFileSync(A.mf, 'utf8')).ledger.home_id, 'a');
  const map = fs.readFileSync(path.join(A.state, 'ID-MAP.md'), 'utf8');
  assert.match(map, /L:x -> L:a\/x/); assert.match(map, /norn\/x -> norn\/a\/x/); assert.match(map, /norn\/pr .*open PR/);
  const c = listClaims(fedOf(A.cfg));
  assert.equal(c['homes/a.json'].id, 'a');
  assert.deepEqual([c['projects/demo.json'].bare_home, c['projects/demo.json'].repo], ['a', w.origin.replace(/\\/g, '/')]);
  assert.ok(fs.existsSync(path.join(A.state, 'views', 'OWNER-QUESTIONS.md')));
});

test('the joiner: every bare id token becomes <P>b-n exactly, the files keyed by id are renamed and open, a foreign-tip branch is refused', () => {
  const { w, A, B } = bothHomes();
  // a branch name two homes both claim: origin's norn/w is not an ancestor of b's local norn/w
  git(B.repo, 'branch', 'norn/w', 'main'); git(B.repo, 'checkout', '-q', 'norn/w'); fs.writeFileSync(path.join(B.repo, 'w.txt'), 'b\n'); git(B.repo, 'add', '.'); git(B.repo, ...ident, 'commit', '-qm', 'b w'); git(B.repo, 'checkout', '-q', 'main');
  git(A.repo, 'branch', 'norn/w', 'main'); git(A.repo, 'checkout', '-q', 'norn/w'); fs.writeFileSync(path.join(A.repo, 'w.txt'), 'a\n'); git(A.repo, 'add', '.'); git(A.repo, ...ident, 'commit', '-qm', 'a w'); git(A.repo, 'checkout', '-q', 'main'); git(A.repo, 'push', '-q', 'origin', 'norn/w');
  assert.deepEqual(cutA(A, { apply: true }).refused, []);
  const r = cutB(B, { apply: true });
  assert.deepEqual(r.refused, []);
  const recs = fs.readFileSync(path.join(B.state, 'records.jsonl'), 'utf8');
  const q = readEvents(recordsFile(B.state)).find(e => e.id === 'Q-b-1' && e.ev === 'create');
  assert.equal(q.data.text, 'RM-b-3 and RUN-b-2 vs RUN-wsl-3, RM-x, UTF-8, not RM-30x; L:b/slop');
  assert.deepEqual(q.data.links, ['RM-b-3', 'RUN-b-2']);
  assert.doesNotMatch(recs, /"Q-1"|"DEC-4"/);
  assert.deepEqual(readEvents(recordsFile(B.state)).find(e => e.id === 'DEC-b-4').data, { text: 'per Q-b-1', refs: { 'RM-b-3': 'parent' } });
  const item = readEvents(recordsFile(B.state, 'item'))[0];
  assert.deepEqual([item.id, item.data.parent, item.data.after], ['RM-b-3', 'RM-1x', ['RM-b-2']]);
  const run = readEvents(recordsFile(B.state, 'run'))[0];
  assert.deepEqual([run.id, run.data.branch, run.data.results, run.data.resume_of], ['RUN-b-2', 'norn/b/slop', 'results/RUN-b-2/out.json', 'RUN-b-1']);
  const mail = readEvents(recordsFile(B.state, 'mail'))[0];
  assert.deepEqual([mail.id, mail.data.to, mail.data.subject, mail.data.body], ['MAIL-b-5', 'lane:b/slop', 'RUN-b-2 done', 'role:checkin@b please']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(B.state, 'runs', 'RUN-b-2.spec.json'), 'utf8')), { id: 'RUN-b-2', lane: 'slop', resume_of: 'RUN-b-1' });
  for (const f of ['hb/RUN-b-2.hb', 'results/RUN-b-2/out.json', 'logs/RUN-b-2-dod-gate.log']) assert.ok(fs.existsSync(path.join(B.state, f)), f);
  for (const f of ['runs/RUN-2.spec.json', 'hb/RUN-2.hb', 'results/RUN-2']) assert.ok(!fs.existsSync(path.join(B.state, f)), f);
  assert.deepEqual(homeOf(B.state), { id: 'b', bare_home: 'a' });
  assert.equal(idPrefix(B.state), 'b');
  const st = loadState(B.state);
  assert.equal(st.items['Q-b-1'].state, 'answered');
  assert.ok(st.items['L:b/slop'] && st.items['L:b/w']);
  // the shared origin: b's norn/slop moved; norn/w (a's tip) untouched and listed for the owner
  const heads = remoteHeads(w.origin);
  assert.match(heads, /refs\/heads\/norn\/b\/slop /); assert.doesNotMatch(heads, /refs\/heads\/norn\/slop /);
  assert.ok(gitOk(B.repo, 'rev-parse', '--verify', 'refs/heads/norn/w') && !gitOk(B.repo, 'rev-parse', '--verify', 'refs/heads/norn/b/w'));
  assert.equal(r.plan.branches.find(b => b.old === 'norn/w').action, 'refused');
  // b's open lane branches citing legacy ids in added lines get listed (one fix commit each, by hand)
  assert.deepEqual(r.plan.cites.find(c => c.branch === 'norn/b/slop')?.tokens, ['RM-3']);
  const map = fs.readFileSync(path.join(B.state, 'ID-MAP.md'), 'utf8');
  assert.match(map, /RM-3 -> RM-b-3/); assert.match(map, /norn\/w .*refused/);
  assert.equal(listClaims(fedOf(B.cfg))['homes/b.json'].id, 'b');
});

test('ID_RE is the spec token: bare numeric ids of every numeric kind in KINDS (C4: COL- too) only', () => {
  const hits = s => (s.match(new RegExp(ID_RE.source, 'g')) || []);
  assert.deepEqual(hits('Q-1 DEC-2 DIR-3 RUN-4 DLV-5 EP-6 MAIL-7 RM-8 ADP-9 ICF-10 GRD-11 WVR-12 COL-13'), ['Q-1', 'DEC-2', 'DIR-3', 'RUN-4', 'DLV-5', 'EP-6', 'MAIL-7', 'RM-8', 'ADP-9', 'ICF-10', 'GRD-11', 'WVR-12', 'COL-13']);
  const numeric = Object.values(KINDS).map(k => k.prefix).filter(p => p.endsWith('-'));
  assert.deepEqual(numeric.filter(p => hits(`${p}7`).length !== 1), [], 'a kind added to KINDS is cut too');
  assert.deepEqual(hits('RM-a-3 RUN-wsl-3 UTF-8 L:x RM-30x XRM-3'), []);
});

test('pre-conditions: refused while a run is live, a lane worktree is dirty, the project is not paused, or b cuts before the bare home', () => {
  const { A, B } = bothHomes();
  fs.appendFileSync(path.join(A.state, 'runs.jsonl'), ev('RUN-9', 'run', 'start', 'launcher', { lane: 'x' }) + '\n' + ev('RUN-10', 'run', 'queue', 'launcher', { lane: 'x' }) + '\n');
  fs.writeFileSync(path.join(A.wts.x, 'dirty.txt'), 'x');
  fs.rmSync(path.join(A.state, 'PAUSED'));
  const before = tree(A.state);
  const r = cutA(A, { apply: true });
  assert.equal(r.applied, false);
  const why = r.refused.join('\n');
  assert.match(why, /RUN-9 is running/); assert.match(why, /RUN-10 is queued/); assert.match(why, /not paused/); assert.match(why, /norn\/x.*not clean/);
  assert.deepEqual(tree(A.state), before);
  const rb = cutB(B, { apply: true });
  assert.match(rb.refused.join('\n'), /no projects\/demo\.json.*bare home cuts first/);
  assert.equal(fs.existsSync(path.join(B.state, 'home.json')), false);
});

test('a taken home id is refused', () => {
  const { A, B } = bothHomes();
  assert.deepEqual(cutA(A, { apply: true }).refused, []);
  const r = syncCut({ state: B.state, project: B.project, home: 'a', bare: false, ledger: B.cfg, machineFile: B.mf, openPr: () => false, apply: true, ledgerOpts: { push: false, gc: false } });
  assert.match(r.refused.join('\n'), /home id a is taken/);
  assert.equal(fs.existsSync(path.join(B.state, 'home.json')), false);
});

test('the dry run writes nothing (state, origin, claims) and lists every rename; a second --apply is a no-op', () => {
  const { w, A, B } = bothHomes();
  assert.deepEqual(cutA(A, { apply: true }).refused, []);
  const sb = tree(B.state), heads = remoteHeads(w.origin), led = remoteHeads(w.ledgerRemote), mf = fs.readFileSync(B.mf, 'utf8');
  const d = cutB(B);
  assert.deepEqual(d.refused, []);
  assert.equal(d.applied, false);
  assert.deepEqual(tree(B.state), sb); assert.equal(remoteHeads(w.origin), heads); assert.equal(remoteHeads(w.ledgerRemote), led); assert.equal(fs.readFileSync(B.mf, 'utf8'), mf);
  assert.deepEqual(d.plan.ids.find(([o]) => o === 'RM-3'), ['RM-3', 'RM-b-3']);
  assert.deepEqual(d.plan.lanes, [['L:slop', 'L:b/slop'], ['L:w', 'L:b/w']]);
  assert.ok(d.plan.files.some(([o, n]) => o === 'runs/RUN-2.spec.json' && n === 'runs/RUN-b-2.spec.json'));
  assert.equal(d.plan.branches.find(b => b.old === 'norn/slop').action, 'rename');
  assert.deepEqual(cutB(B, { apply: true }).refused, []);
  const after = tree(B.state), heads2 = remoteHeads(w.origin);
  const again = cutB(B, { apply: true });
  assert.equal(again.noop, true);
  assert.deepEqual(tree(B.state), after); assert.equal(remoteHeads(w.origin), heads2);
});

test('cli: norn sync cut needs --home; --home must be a valid id', () => {
  const lines = [], out = s => lines.push(s);
  assert.equal(main(['sync', 'cut', '--project', 'demo'], { META_ROOT: mkTmp('meta-cut-cli-') }, out, out), 2);
  assert.match(lines.join('\n'), /--home/);
  assert.equal(main(['sync', 'cut', '--project', 'demo', '--home', 'B-1'], { META_ROOT: mkTmp('meta-cut-cli-') }, out, out), 2);
  assert.equal(main(['sync', 'nope'], { META_ROOT: mkTmp('meta-cut-cli-') }, out, out), 2);
});

test('machine.json takes the ledger.home_id the cut writes (SPEC 3.1); a malformed id is refused', async () => {
  const { loadMachine } = await import('../engine/lib/config.mjs');
  const t = path.dirname(path.dirname(mkTmp('meta-cut-mf-'))), mf = path.join(t, 'machine.json');
  const m = home_id => ({ schema: 1, home: t, claude: { exe: 'claude', config_dir: t, projects_dir: t }, node: process.execPath,
    scheduler: { kind: 'cron', name: 'x', interval_min: 5 }, dash: { port: 0, bind: '127.0.0.1' }, projects: [], ledger: { dir: path.join(t, 'l.git'), home_id } });
  fs.writeFileSync(mf, JSON.stringify(m('a')));
  assert.equal(loadMachine(mf, { meta: t }).ledger.home_id, 'a');
  fs.writeFileSync(mf, JSON.stringify(m('B-1')));
  assert.throws(() => loadMachine(mf, { meta: t }), /home_id/);
});
