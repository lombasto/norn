// NORN-WATCH S1 (DIR-83, DEC-684): `norn digest` - the level-triggered resume digest. A row is in the digest while its STATE needs
// action and leaves only when the target state is reached, never because someone looked at it. Temp state dirs + fake git only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, recordsFile } from '../engine/lib/records.mjs';
import { digest, tryDigest } from '../engine/lib/digest.mjs';
import { renderDigest } from '../engine/lib/views.mjs';
import { sendMail, checkMail, ackMail } from '../engine/lib/mail.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META = path.join(HERE, '..', 'engine', 'bin', 'norn.mjs');
const tmp = p => mkTmp(p);
const T0 = Date.parse('2026-11-09T00:00:00Z');
const at = min => () => new Date(T0 + min * 60000);
const fwd = p => String(p).replace(/\\/g, '/').toLowerCase();

// fake git: rev-parse --abbrev-ref HEAD in a worktree -> its branch; merge-base --is-ancestor <branch> main -> ok when merged
function fakeGit({ branches = {}, merged = new Set() } = {}) {
  const g = (repo, args, { allowFail = false } = {}) => {
    g.calls++;
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) { const b = branches[fwd(repo)]; if (b) return b + '\n'; }
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor' && merged.has(args[2])) return '';
    if (allowFail) return null;
    throw new Error('fake git: ' + args.join(' '));
  };
  g.calls = 0;
  return g;
}
const start = (state, min, data = {}) => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'meta-x', ...data } }, { now: at(min), run: null });
const end = (state, id, min, data = {}) => record(state, { kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome: 'done', exit: 0, ...data } }, { now: at(min), run: null });
const review = (state, id, min, by, refs) => record(state, { kind: 'run', ev: 'review', id, by: 'checkin', data: { refs } }, { now: at(min), run: by });
const ids = rows => rows.map(r => r.id);
// the CLI reads the real clock: a CLI test derives its record times from it (minutes since T0, ending ~5 min ago), never T0 itself
const nowMin = () => Math.floor((Date.now() - T0) / 60000) - 10;
const dg = (state, o = {}) => digest(state, {}, { now: T0 + (o.min ?? 120) * 60000, git: o.git || fakeGit(), dlv: o.dlv ?? [] });

test('digest sec 1: a DONE run with an empty review (refs = its reviewer) whose branch is not on main is listed; gone after the merge', () => {
  const state = path.join(tmp('meta-dg1-'), 'state', 'demo');
  const wt = 'C:/wt/ops';
  const w = start(state, 0, { lane: 'meta-ops', worktree: wt });
  end(state, w.id, 30);
  const ck = start(state, 40, { kind: 'checkin', lane: 'checkin' });
  review(state, w.id, 41, ck.id, [ck.id]);
  const real = start(state, 0, { lane: 'meta-y', worktree: 'C:/wt/y' });
  end(state, real.id, 30);
  review(state, real.id, 41, ck.id, ['DEC-1']);   // a review that acted: not "acknowledged, not acted"
  const branches = { [fwd(wt)]: 'feat/meta-ops', 'c:/wt/y': 'feat/y' };
  const d = dg(state, { git: fakeGit({ branches }) });
  assert.deepEqual(ids(d.sections.finished), [w.id]);
  assert.equal(d.sections.finished[0].branch, 'feat/meta-ops');
  assert.equal(d.sections.finished[0].review, 'empty');
  assert.deepEqual(ids(dg(state, { git: fakeGit({ branches, merged: new Set(['feat/meta-ops']) }) }).sections.finished), []);
  assert.deepEqual(ids(dg(state, { min: 30 + 73 * 60, git: fakeGit({ branches }) }).sections.finished), [], 'older than 72 h: out of the run window');
});

test('digest sec 1: every done deliverable (any age) is listed; merged or parked (not expired) -> not listed; a run its DLV covers is not doubled', () => {
  const state = path.join(tmp('meta-dg2-'), 'state', 'demo');
  const w = start(state, 0, { lane: 'meta-visual', worktree: 'C:/wt/vis' });
  end(state, w.id, 30);
  const row = (id, o = {}) => ({ id, state: 'done', record_state: 'open', park: null, lane: 'meta-visual', branch: 'feat/dash-visual', run: w.id, delivers: 'mocks', days: 30, ...o });
  const git = fakeGit({ branches: { 'c:/wt/vis': 'feat/dash-visual' } });
  assert.deepEqual(ids(dg(state, { git, dlv: [row('DLV-19')] }).sections.finished), ['DLV-19']);
  assert.deepEqual(ids(dg(state, { git, dlv: [row('DLV-19', { state: 'merged' })] }).sections.finished), []);
  assert.deepEqual(ids(dg(state, { git, dlv: [row('DLV-19', { record_state: 'parked', park: { why: 'owner', expired: false } })] }).sections.finished), []);
  assert.deepEqual(ids(dg(state, { git, dlv: [row('DLV-19', { record_state: 'parked', park: { why: 'owner', expired: true } })] }).sections.finished), ['DLV-19']);
});

test('digest sec 4: a crash (exit 143) with no successor is listed with its evidence; gone once a run on the same lane + stage starts', () => {
  const state = path.join(tmp('meta-dg3-'), 'state', 'demo');
  const w = start(state, 0, { lane: 'meta-ckgate', stage: 'GT-1' });
  end(state, w.id, 30, { outcome: 'crash', exit: 143, dirty: 4, external_term: true });
  const other = start(state, 40, { lane: 'meta-ckgate', stage: 'GT-2' });   // another stage is not a successor
  end(state, other.id, 50);
  const d = dg(state);
  assert.deepEqual(ids(d.sections.ended), [w.id]);
  assert.equal(d.sections.ended[0].exit, 143);
  assert.equal(d.sections.ended[0].dirty, 4);
  assert.equal(d.sections.ended[0].external_term, true);
  start(state, 60, { lane: 'meta-ckgate', stage: 'GT-1' });
  assert.deepEqual(ids(dg(state).sections.ended), []);
});

test('digest sec 3 + 5: owner_only open questions first (oldest first), then open, then answered; a young directive no DEC / RUN cites', () => {
  const state = path.join(tmp('meta-dg4-'), 'state', 'demo');
  const q = (min, title, data = {}) => record(state, { kind: 'question', ev: 'create', by: 'controller', data: { title, lane: 'x', ...data } }, { now: at(min), run: null });
  const a = q(0, 'plain old');
  const b = q(10, 'owner young', { owner_only: true });
  const c = q(5, 'owner old', { owner_only: true });
  const e = q(1, 'answered');
  record(state, { kind: 'question', ev: 'answer', id: e.id, by: 'owner', data: { text: 'yes', via: 'chat' } }, { now: at(20), run: null });
  assert.deepEqual(ids(dg(state).sections.questions), [c.id, b.id, a.id, e.id]);
  assert.equal(dg(state).sections.questions[0].owner_only, true);
  const dir = record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'make sure Norn keeps work', via: 'chat' } }, { now: at(30), run: null });
  assert.deepEqual(ids(dg(state).sections.directives), [dir.id]);
  record(state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'x', question: `${dir.id} how`, choice: 'a', why: '-' } }, { now: at(40), run: null });
  assert.deepEqual(ids(dg(state).sections.directives), []);
});

test('digest sec 2: a queued run is listed with its after / inputs; renderDigest names every section and row', () => {
  const state = path.join(tmp('meta-dg5-'), 'state', 'demo');
  const qd = record(state, { kind: 'run', ev: 'queue', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'meta-b', not_before: null, after: [{ kind: 'q', id: 'Q-9', state: 'answered' }], inputs: ['DLV-3'] } }, { now: at(0), run: null });
  const d = dg(state);
  assert.deepEqual(ids(d.sections.queued), [qd.id]);
  assert.deepEqual(d.sections.queued[0].inputs, ['DLV-3']);
  const text = renderDigest(d);
  for (const h of ['Finished, not on main', 'Queued + triggers', 'Questions', 'Ended without a clean successor', 'Directives with no action']) assert.match(text, new RegExp(h.replace(/[+]/g, '\\+')));
  assert.match(text, new RegExp(qd.id));
});

test('digest replay: the 11-09 records (anonymised replay fixture: synthetic prose, real shape / ids / times) list RUN-1604/1636/1637/1638/1640 and DLV-19 as finished, not on main', () => {
  const state = path.join(tmp('meta-dgr-'), 'state', 'kestrel');
  fs.mkdirSync(state, { recursive: true });
  for (const f of ['runs.jsonl', 'records.jsonl', 'deliverables.jsonl']) fs.copyFileSync(path.join(HERE, 'fixtures', 'digest-1109', f), path.join(state, f));
  // as of 11-09 08:32Z nothing of these lanes was merged: every worktree is on a feature branch, nothing is an ancestor of main
  const git = (repo, args, { allowFail = false } = {}) => {
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return 'feat/' + path.basename(repo) + '\n';
    if (allowFail) return null;
    throw new Error('offline');
  };
  git.calls = 0;
  const d = digest(state, { root: 'D:/ws/dev/kestrel-mono' }, { now: Date.parse('2026-11-09T08:32:31Z'), git });
  const got = ids(d.sections.finished);
  for (const id of ['RUN-1604', 'RUN-1636', 'RUN-1637', 'RUN-1638', 'RUN-1640', 'DLV-19']) assert.ok(got.includes(id), `${id} missing from ${got.join(' ')}`);
});

test('norn digest --state D [--json]: the CLI prints the digest (read-only: no record written)', () => {
  const state = path.join(tmp('meta-dgc-'), 'state', 'demo');
  const m = nowMin();
  const w = start(state, m, { lane: 'meta-z', stage: 'S1' });
  end(state, w.id, m + 5, { outcome: 'crash', exit: 143 });
  const before = fs.readFileSync(path.join(state, 'runs.jsonl'), 'utf8');
  const env = { ...process.env, META_ROLE: '', META_PROJECT: '', META_RUN_ID: '' };
  const r = spawnSync(process.execPath, [META, 'digest', '--state', state, '--json'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).sections.ended.map(x => x.id), [w.id]);
  const t = spawnSync(process.execPath, [META, 'digest', '--state', state], { encoding: 'utf8', env });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /Ended without a clean successor/);
  const h = spawnSync(process.execPath, [META, 'digest', '--state', state, '--hook'], { encoding: 'utf8', env });
  assert.equal(h.status, 0, h.stderr);
  assert.equal(JSON.parse(h.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(JSON.parse(h.stdout).hookSpecificOutput.additionalContext, new RegExp(w.id));
  // a supervised run (worker / MERGE stage / check-in) started in the main checkout gets no digest injected: interactive only
  for (const extra of [{ META_RUN_ID: 'RUN-9' }, { META_ROLE: 'checkin' }]) {
    const q = spawnSync(process.execPath, [META, 'digest', '--state', state, '--hook'], { encoding: 'utf8', env: { ...env, ...extra } });
    assert.equal(q.status, 0, q.stderr);
    assert.equal(q.stdout, '', JSON.stringify(extra));
  }
  assert.equal(fs.readFileSync(path.join(state, 'runs.jsonl'), 'utf8'), before);
});

test('norn status: STATUS.md carries a ## Digest block and <state>/DIGEST.md is the generated view of the same digest', () => {
  const state = path.join(tmp('meta-dgs-'), 'state', 'demo');
  const m = nowMin();
  const w = start(state, m, { lane: 'meta-s', stage: 'S1' });
  end(state, w.id, m + 5, { outcome: 'crash', exit: 143 });
  const env = { ...process.env, META_ROLE: '', META_PROJECT: '' };
  const r = spawnSync(process.execPath, [META, 'status', '--state', state, '--budget', path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), '--machine', path.join(state, 'none.json')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const st = fs.readFileSync(path.join(state, 'STATUS.md'), 'utf8');
  assert.match(st, /## Digest/); assert.match(st, new RegExp(`- ${w.id} meta-s S1`));
  assert.match(fs.readFileSync(path.join(state, 'DIGEST.md'), 'utf8'), new RegExp(`${w.id} meta-s S1 exited crash exit=143`));
});

// NORN-WATCH S5 (brief DIGEST GAP): a DEC whose on_runs, or a DEC / DIR whose refs, name the run = acted (no new record kind)
test('S5 digest sec 1: a DONE run with an empty review leaves once a DEC on_runs or a DIR done refs name it', () => {
  const state = path.join(tmp('meta-dg5-'), 'state', 'demo');
  const mk = (lane) => { const w = start(state, 0, { lane, worktree: `C:/wt/${lane}` }); end(state, w.id, 30); return w; };
  const a = mk('meta-a'), b = mk('meta-b'), c = mk('meta-c');
  const ck = start(state, 40, { kind: 'checkin', lane: 'checkin' });
  for (const w of [a, b, c]) review(state, w.id, 41, ck.id, [ck.id]);
  const branches = { 'c:/wt/meta-a': 'feat/a', 'c:/wt/meta-b': 'feat/b', 'c:/wt/meta-c': 'feat/c' };
  assert.deepEqual(ids(dg(state, { git: fakeGit({ branches }) }).sections.finished), [a.id, b.id, c.id]);
  record(state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'x', question: 'merge?', choice: 'yes', why: '-', on_runs: [a.id] } }, { now: at(50), run: null });
  const dir = record(state, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'do b', via: 'chat' } }, { now: at(50), run: null });
  record(state, { kind: 'directive', ev: 'done', id: dir.id, by: 'controller', data: { refs: [b.id] } }, { now: at(55), run: null });
  assert.deepEqual(ids(dg(state, { git: fakeGit({ branches }) }).sections.finished), [c.id]);
  // the live 11-09 DECs name their runs in the text (DEC-646: "round 2 RUN-1627 fixed review RUN-1623"): the same cite rule as sec. 5
  record(state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'x', question: `merged (${c.id}0 is another run)`, choice: 'ok', why: '-' } }, { now: at(60), run: null });
  assert.deepEqual(ids(dg(state, { git: fakeGit({ branches }) }).sections.finished), [c.id], 'RUN-n0 does not cite RUN-n');
  record(state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'x', question: `merged: round 2 ${c.id} fixed it`, choice: 'ok', why: '-' } }, { now: at(61), run: null });
  assert.deepEqual(ids(dg(state, { git: fakeGit({ branches }) }).sections.finished), []);
});

// NORN-WATCH S5 (brief DIGEST BUG): the end record's branch / head win over the worktree's CURRENT branch (a reused worktree)
test('S5 digest sec 1: the branch + head recorded at the end are preferred; the worktree is the fallback for older runs', () => {
  const state = path.join(tmp('meta-dg6-'), 'state', 'demo');
  const w = start(state, 0, { lane: 'meta-a', worktree: 'C:/wt/reused' });
  end(state, w.id, 30, { branch: 'feat/a', head: 'a1b2c3d' });
  const old = start(state, 0, { lane: 'meta-o', worktree: 'C:/wt/old' });
  end(state, old.id, 30);
  const branches = { 'c:/wt/reused': 'feat/norn-visual', 'c:/wt/old': 'feat/o' };
  let d = dg(state, { git: fakeGit({ branches }) });
  assert.deepEqual(d.sections.finished.map(r => [r.id, r.branch]), [[w.id, 'feat/a'], [old.id, 'feat/o']]);
  d = dg(state, { git: fakeGit({ branches, merged: new Set(['a1b2c3d']) }) });
  assert.deepEqual(ids(d.sections.finished), [old.id], 'the recorded head on main = merged, whatever the branch name is now');
});

test('L-21: a digest that cannot be built is an {error} STATUS prints; a corrupt deliverables or roadmap log is never "nothing to do"', () => {
  const state = path.join(tmp('meta-dge-'), 'state', 'demo'), m = nowMin();
  const w = start(state, m, { lane: 'meta-e', stage: 'S1' });
  end(state, w.id, m + 5, { outcome: 'crash', exit: 143 });
  for (const kind of ['deliverable', 'item']) {
    const f = recordsFile(state, kind);
    fs.writeFileSync(f, '{ torn\n');
    const re = new RegExp(path.basename(f).replace('.', '\.'));
    assert.throws(() => digest(state, {}, { git: fakeGit() }), re, `${kind}: a records error, not an empty section`);
    assert.match(tryDigest(state, {}).error, re);
    fs.rmSync(f);
  }
  fs.writeFileSync(recordsFile(state, 'deliverable'), '{ torn\n');
  const env = { ...process.env, META_ROLE: '', META_PROJECT: '' };
  const r = spawnSync(process.execPath, [META, 'status', '--state', state, '--budget', path.join(HERE, 'fixtures', 'status', 'BUDGET.json'), '--machine', path.join(state, 'none.json')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(state, 'STATUS.md'), 'utf8'), /## Digest\r\n- could not be built: .*deliverables\.jsonl/);
});

test('digest collisions: each open row carries the real command - the remedy when a check-in may apply it, else an ask for it', () => {
  const d = tmp('meta-digest-col-');
  const row = (col, kind, grade, remedy) => ({ col, kind, grade, verdict: 'warn', lane: 'web-runs', run: null, other: 'web-nav', why: 'synthetic', files: [], files_n: 0, pick: { remedy, why: 'w' } });
  fs.writeFileSync(path.join(d, 'collide.json'), JSON.stringify({ at: new Date().toISOString(), rows: [row('COL-1', 'territory', 'covers', 'narrow'), row('COL-2', 'territory', 'exclusive', 'narrow'), row('COL-3', 'item', null, 'fold'), row('COL-4', 'item', null, 'part')], handled: [], wide: [] }));
  const dos = p => digest(d, p).sections.collisions.map(r => r.do);
  assert.deepEqual(dos({}), ['META collide narrow COL-1 --as checkin --why W', 'META collide ask COL-2 --want narrow --as checkin --why W',
    'META collide ask COL-3 --want fold --as checkin --why W', 'META collide part COL-4 --as checkin --why W']);
  assert.equal(dos({ policy: { collide: { apply_by: { exclusive: { narrow: 'checkin' } } } } })[1], 'META collide narrow COL-2 --as checkin --why W', 'apply_by lowers the cell');
});

// HOME-MAIL S2 (REPORT 3.2): mail waiting for this home's controller is a row with its age until the ack
test('digest mail: each unacked mail for role:controller@<own home> is a row with its age; it stays at the delivery and leaves at the ack', () => {
  const t = tmp('meta-digest-mail-'), dir = id => { const s = path.join(t, id); fs.mkdirSync(s, { recursive: true }); fs.writeFileSync(path.join(s, 'home.json'), JSON.stringify({ id, bare_home: 'a' })); return s; };
  const a = dir('a'), b = dir('b');
  const sync = () => { fs.mkdirSync(path.join(b, 'homes', 'a'), { recursive: true }); fs.copyFileSync(path.join(a, 'mail.jsonl'), path.join(b, 'homes', 'a', 'mail.jsonl')); };
  const m = sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'for b', body: 'x', urgent: true });
  sendMail(a, { by: 'controller', to: 'role:checkin@b', subject: 'not the controller', body: 'y' });
  sync();
  const now = Date.parse(m.ts) + 12 * 60000 + 3000, mailRows = () => digest(b, {}, { now, git: fakeGit(), dlv: [] }).sections.mail;
  assert.deepEqual(mailRows().map(r => [r.id, r.state, r.age_min, r.urgent, r.from]), [[m.id, 'queued', 12, true, 'role:controller@a']]);
  assert.equal(digest(a, {}, { now, git: fakeGit(), dlv: [] }).sections.mail, undefined, 'not a row on the sending home');
  const out = renderDigest(digest(b, {}, { now, git: fakeGit(), dlv: [] }));
  assert.match(out, /Mail for role:controller@b \(1\)/);
  assert.ok(out.includes(`- ${m.id} queued URGENT from role:controller@a (12 min): for b - norn mail check`), out);
  checkMail(b, { by: 'controller', to: 'role:controller', via: 'cli' });
  assert.deepEqual(mailRows().map(r => [r.id, r.state]), [[m.id, 'delivered']], 'delivered, not acked: still a row');
  ackMail(b, { by: 'controller', id: m.id });
  assert.equal(mailRows(), undefined, 'the row leaves at the ack');
});

// HOME-MAIL S3 (REPORT 3.3): a broken sync rule (a home's heartbeat past 15 min, our mail unacked past 30) is a row while it holds
test('digest sync: a stale heartbeat of home b and our mail unacked there are rows; a fresh receipt clears its row', () => {
  const t = tmp('meta-digest-sync-'), a = path.join(t, 'a');
  fs.mkdirSync(path.join(a, 'homes', 'b'), { recursive: true }); fs.writeFileSync(path.join(a, 'home.json'), JSON.stringify({ id: 'a', bare_home: 'a' }));
  const m = sendMail(a, { by: 'controller', to: 'role:controller@b', subject: 'ping', body: 'x' }), T = Date.parse(m.ts) + 40 * 60000;
  const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const seen = (ms, held = {}) => fs.writeFileSync(path.join(a, 'homes', 'b', 'seen.json'), JSON.stringify({ polled_at: iso(ms), held }));
  fs.writeFileSync(path.join(a, 'seen.json'), JSON.stringify({ polled_at: iso(T), held: {} }));
  seen(T - 20 * 60000);
  const rows = () => digest(a, {}, { now: T, git: fakeGit(), dlv: [] }).sections.sync;
  assert.deepEqual(rows().map(r => [r.rule, r.home, r.id ?? null]), [['heartbeat', 'b', null], ['mail', 'b', m.id]]);
  const [hb, ml] = rows();
  assert.match(hb.why, /^home b: heartbeat 20 min old/);
  assert.ok(ml.what === `${m.id} to role:controller@b unacked 40 min`, ml.what);
  seen(T, { a: { 'mail.jsonl': m.seq } });
  assert.deepEqual(rows().map(r => r.rule), ['mail'], 'fresh heartbeat: that row leaves');
  assert.match(rows()[0].why, /b holds it/);
  fs.rmSync(path.join(a, 'homes', 'b', 'seen.json'));
  assert.match(rows()[0].why, /b sends no receipts/);
});
