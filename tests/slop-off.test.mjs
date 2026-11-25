// META-BETA-PREP (DIR-52): ONE per-project switch turns all of SloppaChoppa off - no run-end check, no merge hold, no code rows in
// the Guard, no orc in the header / Guard / pop-ups (the Guard stays a plain list with a plain count). The old hidden
// policy.slop.run_end folds into it. Temp git repos, sandboxed HOME, the fake executor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SETTINGS, settingsView, applySettings, withDefaults, slopOn, sectionOf } from '../engine/lib/policy.mjs';
import { loadState } from '../engine/lib/records.mjs';
import { mergeQueue } from '../engine/lib/mergeq.mjs';
import { tickSlop } from '../engine/lib/slop/daily.mjs';
import { digest } from '../engine/lib/digest.mjs';
import { renderTab } from '../engine/dash/ui.mjs';
import { GUARD_SUBS, guardSummary, guardPart } from '../engine/dash/guardparts.mjs';
// META-UX-BUILD S2: the Guard page = the summary + one sub-view's part at a time; all sub-views together = what the one page showed
const guardPage = (g, ctx) => GUARD_SUBS.map(([sub]) => renderTab('slop', { ...guardSummary(g), sub, limit: 40, ...guardPart(g, sub), parts_loading: false }, ctx)).join('');
import { fixture } from './helpers/dash-fixture.mjs';
import { settled } from './helpers/settled.mjs';
import { waitFor } from './helpers/wait.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const NORN = path.join(import.meta.dirname, '..', 'engine', 'bin', 'norn.mjs');
const fwd = p => p.split(path.sep).join('/');
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const HOLD = { 'feat/x': { lane: 'x', run: 'RUN-1', base: 'a', head: 'b', at: new Date().toISOString(), blocks: [{ rule: 'K15', level: 'BLOCK', file: 'a.txt.orig', line: 1, msg: 'merge debris', fp: 'fp1' }] } };
const writeHold = state => { fs.mkdirSync(path.join(state, 'slop'), { recursive: true }); fs.writeFileSync(path.join(state, 'slop', 'holds.json'), JSON.stringify(HOLD)); };

/** a repo on main + a lane worktree feat/x whose one commit leaves merge debris (K15 BLOCKs it) */
function laneRepo(root) {
  const repo = path.join(root, 'repo'), wt = path.join(root, 'wt');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'a');
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  fs.writeFileSync(path.join(wt, 'a.txt.orig'), 'left by a merge\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'oops');
  return { repo, wt };
}
const projectJson = (root, repo, policy) => {
  const f = path.join(root, 'project.json');
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'kestrel', title: 'k', root: fwd(repo), ledger: '${root}/L.md', briefs_dir: '${root}', policy }));
  return f;
};

test('Settings: ONE row "SloppaChoppa" on / off per project, default on, beside the pop-ups row; the old run_end key folds into it', () => {
  const row = SETTINGS.find(s => s.key === 'policy.slop.enabled');
  assert.ok(row, 'the row exists');
  assert.deepEqual([row.label, row.type, row.recommended, sectionOf(row).join('/')], ['SloppaChoppa', 'bool', 'on', 'voice/onoff']);
  assert.equal(SETTINGS.filter(s => s.type === 'bool' && /^policy\.slop\./.test(s.key)).length, 1, 'no second switch');   // on/off rows only: a cap (voice_reads_per_day) is not a switch
  assert.equal(SETTINGS.find(s => s.key === 'policy.voice.popups').recommended, 'off', 'pop-ups stay their own row, default off');
  const v = settingsView({}).find(s => s.key === 'policy.slop.enabled');
  assert.deepEqual([v.value, v.scope, v.modified], [true, 'project', false]);
  assert.equal(slopOn({}), true); assert.equal(slopOn(undefined), true);
  assert.equal(slopOn({ slop: { enabled: false } }), false);
  assert.equal(slopOn({ slop: { run_end: false } }), false, 'a project.json with the old key keeps meaning off');
  assert.equal(withDefaults({ policy: { slop: { run_end: false } } }).policy.slop.enabled, false);
  assert.equal(settingsView({ policy: { slop: { run_end: false } } }).find(s => s.key === 'policy.slop.enabled').value, false, 'Settings shows it off');
  const saved = applySettings({ policy: { slop: { run_end: false } } }, { 'policy.slop.enabled': true });
  assert.deepEqual([saved.policy.slop.enabled, Object.hasOwn(saved.policy.slop, 'run_end')], [true, false], 'a save writes the one switch; run_end leaves project.json');   // a save also writes the defaults (voice_reads_per_day)
  assert.equal(applySettings({ policy: { slop: { run_end: false } } }, { 'policy.voice.popups': 'on' }).policy.slop.enabled, false, 'another save keeps it off');
});

test('off: a lane run started by `norn run` that ends DONE with a BLOCK finding is not checked, held or resumed', async () => {
  const root = mkTmp('meta-slopoff-run-'), state = path.join(root, 'state', 'kestrel');
  const { repo, wt } = laneRepo(root);
  const pf = projectJson(root, repo, { slop: { run_end: false } });   // the old key: still means off
  const brief = path.join(root, 'brief.md'); fs.writeFileSync(brief, 'mode: done\n');
  const env = { ...process.env, META_ROOT: root, HOME: root, USERPROFILE: root, META_HB_MS: '150' };
  const r = spawnSync(process.execPath, [NORN, 'run', '--executor', 'fake', '--project', pf, '--state', state, '--locks', path.join(root, 'locks'), '--lane', 'x',
    '--brief', brief, '--worktree', wt, '--notes', path.join(root, 'NOTES.md'), '--no-tick'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const id = Object.keys(loadState(state).items).find(k => /^RUN-/.test(k));
  await waitFor(() => settled(loadState(state).items[id]), { what: 'the run ends' });
  assert.equal(loadState(state).items[id].resume, undefined, 'no slop resume');
  assert.ok(!fs.existsSync(path.join(state, 'slop', 'holds.json')), 'no check ran, nothing held');
});

test('off: norn merge-brief and the merge queue do not check; on again, the door checks the head and its stored check binds', () => {
  const root = mkTmp('meta-slopoff-mb-'), state = path.join(root, 'state', 'kestrel');
  const { repo, wt } = laneRepo(root), head = git(wt, 'rev-parse', 'HEAD');
  const mb = policy => spawnSync(process.execPath, [NORN, 'merge-brief', '--project', projectJson(root, repo, policy), '--lane', 'x', '--branch', 'feat/x', '--worktree', wt,
    '--notes', path.join(root, 'NOTES.md'), '--out', path.join(root, 'MB.md'), '--sha', head], { encoding: 'utf8', env: { ...process.env, META_ROOT: root, HOME: root, USERPROFILE: root } });
  const view = { rows: [{ id: 'DLV-1', state: 'done', record_state: 'open', branch: 'feat/x', lane: 'x', done_utc: new Date().toISOString(), tip: head }] };
  const q = policy => mergeQueue({ stateDir: state, project: { name: 'kestrel', root: fwd(repo), policy }, view }).rows[0].slop;
  let r = mb({ slop: { enabled: false } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(path.join(state, 'slop', 'checks.jsonl')), 'off: nothing was checked');
  assert.equal(q({}), null, 'on, never checked: the queue shows the head unchecked (its pick runs the check)');
  r = mb({});
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.match(r.stdout, /REFUSED: merge-brief feat\/x: 1 open slop BLOCK/);
  assert.equal(q({ slop: { enabled: false } }), 0, 'off: no hold in the queue');
  assert.equal(q({}), 1, 'on: the stored check of the head binds');
});

test('off: no daily slop report from the tick and no SloppaChoppa line in the digest', () => {
  const state = mkTmp('meta-slopoff-day-'), root = path.dirname(path.dirname(state));
  const p = { name: 'kestrel', file: path.join(root, 'project.json'), root, policy: { slop: { enabled: false } } };
  const spawned = [];
  assert.equal(tickSlop(p, state, { metaCmd: NORN, spawnFn: (exe, args) => { spawned.push(args); return { pid: 42 }; }, now: Date.now() }), null);
  assert.deepEqual(spawned, []);
  writeHold(state);
  assert.equal(digest(state, p, { now: Date.now(), dlv: [] }).sections.slop, undefined);
  assert.ok(digest(state, { ...p, policy: {} }, { now: Date.now(), dlv: [] }).sections.slop, 'on: the hold line is there');
});

test('off: /api/guard has no code rows and says slop off; the Guard page is a plain list with a plain count, no SloppaChoppa', { timeout: 60000 }, async () => {
  const f = await fixture({ project: { policy: { lanes: {}, slop: { run_end: false } } } });
  try {
    writeHold(f.pa.state);
    let g = (await f.get('/api/guard?project=kestrel')).data;
    assert.equal(g.slop, false);
    assert.ok(!g.rows.some(r => r.type === 'code'), 'no slop rows');
    assert.ok(!g.types.some(t => t.type === 'code'), 'no code type in the counts either');
    const html = guardPage(g, { project: 'kestrel', look: 'norn', art: true });
    assert.ok(!/SloppaChoppa|orc-|slop-popups/.test(html), 'no orc, no pop-up line, no SloppaChoppa words');
    // bddb2b4c (ui-spend-slop): the page has no banner (slop-orc) and no plain-list card (slop-plain), on or off; the count is Per type's
    for (const id of ['slop-count-types', 'slop-rows']) assert.ok(html.includes(`id="${id}"`), id);
    assert.match(html, /id="slop-count-types"><h2>Open per type <span class="mute small">1 open finding · /, 'a plain count: the hold is not counted');
    const v = (await f.get('/api/settings?project=kestrel')).data;
    const r = await f.post('/api/settings', { project: 'kestrel', version: v.version, changes: { 'policy.slop.enabled': true } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(JSON.parse(fs.readFileSync(f.pa.file, 'utf8')).policy.slop.run_end, undefined, 'the old key folded away on save');
    g = (await f.get('/api/guard?project=kestrel')).data;
    assert.equal(g.slop, true);
    assert.ok(g.rows.some(r => r.type === 'code'), 'on again: the recorded finding shows');
    assert.equal(g.types.find(t => t.type === 'code').open, 1);
    assert.match(guardPage(g, { project: 'kestrel' }), /id="slop-S-fp1"[^]*id="slop-count-types"><h2>Open per type <span class="mute small">2 open findings · /, 'on again: the finding has its row and its count');
  } finally { await f.done(); }
});

test('off: the header orc and every pop-up stay away (index.html reads the one switch from /api/guard)', () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, '..', 'engine', 'dash', 'index.html'), 'utf8');
  assert.match(html, /function paintOrc\(\) \{[^}]*b\.hidden = !g \|\| g\.slop === false/, 'the header orc hides when off');
  assert.match(html, /function popUp\(\) \{\s*const g = S\.guard; if \(!g \|\| g\.slop === false\) return;/, 'no pop-up when off');
  assert.match(html, /function callUp\(\) \{\s*if \(S\.guard\?\.slop === false\) return;/, 'no call-up when off');
});
