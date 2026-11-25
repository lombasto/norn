// RM-a-58 decision-links: lib/declinks.mjs over a synthetic repo + records - each in-force DEC / active DIR linked to the paths it governs
// from stated paths (--paths), else the files its named runs changed (--on-runs), else its lane's landings on main within the window;
// stale = a governed path changed on main after it by a commit that is not its own source; `norn code why` lists a file's records
// (newest first, capped); the digest lists decisions gone stale in its window. Sandbox only (mkTmp), synthetic names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkTmp, cleanTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';
import { buildLinks, refreshLinks, readLinks, whyOf, staleRows, linksSummary, LINKS } from '../engine/lib/declinks.mjs';
import { codeCmd, tickCode } from '../engine/lib/codecli.mjs';
import { digest, WINDOW_H } from '../engine/lib/digest.mjs';

test.after(cleanTmp);
const T = s => `2026-11-${s}:00Z`, ms = s => Date.parse(T(s));
const NORN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');

function world() {
  const d = mkTmp('meta-declinks-'), repo = path.join(d, 'repo'), state = path.join(d, 'state', 'kestrel');
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(state, { recursive: true });
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
  const g = (args, at) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...(at ? { GIT_AUTHOR_DATE: T(at), GIT_COMMITTER_DATE: T(at) } : {}) } }).trim();
  const commit = (files, msg, at) => { for (const [f, t] of Object.entries(files)) w(f, t); g(['add', '-A']); g(['commit', '-q', '-m', msg], at); return g(['rev-parse', 'HEAD']); };
  const land = (branch, n, at) => { g(['checkout', '-q', 'main']); g(['merge', '-q', '--no-ff', '-m', `Merge pull request #${n} from octo/${branch}`, branch], at); return g(['rev-parse', 'HEAD']); };
  g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']); g(['config', 'core.autocrlf', 'false']);
  commit({ 'engine/a.mjs': 'a\n', 'engine/b.mjs': 'b\n', 'docs/x.md': 'x\n', 'engine/c.mjs': 'c\n' }, 'base', '01T10:00');
  g(['checkout', '-q', '-b', 'norn/b/alpha']);
  const tip = commit({ 'engine/a.mjs': 'a2\n' }, 'feat: alpha', '02T10:00');
  const alpha = land('norn/b/alpha', 1, '03T10:00');
  g(['checkout', '-q', '-b', 'norn/beta']); commit({ 'engine/b.mjs': 'b2\n' }, 'feat: beta', '04T10:00');
  const beta = land('norn/beta', 2, '04T12:00');
  const hotfix = commit({ 'engine/a.mjs': 'a3\n' }, 'fix: hot', '06T10:00');
  g(['checkout', '-q', '-b', 'norn/delta']); commit({ 'docs/x.md': 'x2\n' }, 'docs: delta', '07T09:00');
  const delta = land('norn/delta', 3, '07T10:00');
  const at = s => () => new Date(T(s)), rec = (ev, s) => record(state, ev, { now: at(s), views: false });
  const run = rec({ kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'alpha' } }, '02T09:00').id;
  rec({ kind: 'run', ev: 'end', id: run, by: 'launcher', data: { outcome: 'done', exit: 0, branch: 'norn/b/alpha', head: tip } }, '02T11:00');
  const dec = (s, data) => rec({ kind: 'decision', ev: 'create', by: 'controller', data: { question: 'q?', choice: 'c', why: 'w', ...data } }, s).id;
  const ids = {
    runs: dec('02T12:00', { lane: 'alpha', question: 'alpha shape?', on_runs: [run] }),
    landing: dec('04T13:00', { lane: 'beta', question: 'beta shape?' }),
    dir: rec({ kind: 'directive', ev: 'create', by: 'owner', data: { text: 'beta stays small', via: 'chat', scope: ['beta'] } }, '05T09:00').id,
    stated: dec('05T10:00', { lane: 'alpha', question: 'docs rule?', paths: ['docs/x.md'], on_runs: [run] }),
    none: dec('05T11:00', { lane: 'gamma' }),
    gone: dec('05T12:00', { lane: 'beta' }),
    missing: dec('05T13:00', { lane: 'gamma', on_runs: ['RUN-99'] }),
  };
  rec({ kind: 'decision', ev: 'overrule', id: ids.gone, by: 'owner', data: { text: 'no' } }, '05T14:00');
  return { repo, state, g, commit, ids, run, sha: { tip, alpha, beta, hotfix, delta } };
}
const byId = ix => Object.fromEntries(ix.records.map(r => [r.id, r]));

test('each link names its source: stated paths win, else the named runs\' files, else the lane\'s landings in the window', () => {
  const W = world(), ix = buildLinks({ state: W.state, repo: W.repo, now: ms('08T00:00') }), r = byId(ix);
  assert.equal(ix.sha, W.sha.delta.slice(0, 12)); assert.equal(ix.main, 'main');
  assert.deepEqual(r[W.ids.runs].links.map(l => [l.path, l.source, l.from]), [['engine/a.mjs', 'runs', [W.run]]]);
  assert.deepEqual(r[W.ids.landing].links.map(l => [l.path, l.source, l.from]), [['engine/b.mjs', 'landings', [W.sha.beta.slice(0, 12)]]]);
  assert.deepEqual(r[W.ids.dir].links.map(l => [l.path, l.source]), [['engine/b.mjs', 'landings']], 'a directive: the landings of its scope lanes');
  assert.deepEqual(r[W.ids.stated].links.map(l => [l.path, l.source, l.from]), [['docs/x.md', 'stated', []]], 'stated wins over --on-runs');
  assert.equal(r[W.ids.landing].links[0].inferred, true); assert.equal(r[W.ids.stated].links[0].inferred, false);
  assert.deepEqual(r[W.ids.none].links, []); assert.match(r[W.ids.none].na.join(' '), /gamma: no landing/);
  assert.match(r[W.ids.missing].na.join(' '), /RUN-99: no such run/);
  assert.equal(r[W.ids.gone], undefined, 'an overruled decision governs nothing');
  assert.deepEqual(linksSummary(ix), { records: 6, linked: 4, by_source: { stated: 1, runs: 1, landings: 2 }, unlinked: 2, links: 4 });
});

test('stale: a governed path changed on main after the record, by a commit that is not its own source; the record itself is never written', () => {
  const W = world(), before = fs.readFileSync(path.join(W.state, 'records.jsonl'), 'utf8'), r = byId(buildLinks({ state: W.state, repo: W.repo, now: ms('08T00:00') }));
  assert.deepEqual(r[W.ids.runs].links[0].stale, { sha: W.sha.hotfix.slice(0, 12), at: T('06T10:00') }, 'the run\'s own landing (03T10) is not a change after it');
  assert.equal(r[W.ids.runs].stale_at, T('06T10:00'));
  assert.equal(r[W.ids.landing].links[0].stale, null, 'its own landing is its source, not a change');
  assert.deepEqual(r[W.ids.stated].links[0].stale, { sha: W.sha.delta.slice(0, 12), at: T('07T10:00') });
  assert.equal(fs.readFileSync(path.join(W.state, 'records.jsonl'), 'utf8'), before, 'records are append-only: the index never writes them');
});

test('a landing outside the window is no source: a lane landing 8 days later links nothing to an older decision', () => {
  const W = world();
  const late = record(W.state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'beta', question: 'q', choice: 'c', why: 'w' } }, { now: () => new Date(ms('04T12:00') + (LINKS.landing_before_h + 1) * 3600e3), views: false }).id;
  assert.deepEqual(byId(buildLinks({ state: W.state, repo: W.repo, now: ms('09T00:00') }))[late].links, []);
});

test('whyOf: a file\'s governing records newest first, with age, source and stale; capped at ten', () => {
  const W = world(), now = ms('08T00:00'), ix = buildLinks({ state: W.state, repo: W.repo, now });
  assert.deepEqual(whyOf(ix, 'engine/b.mjs', now).rows.map(x => [x.id, x.source, x.stale]), [[W.ids.dir, 'landings', null], [W.ids.landing, 'landings', null]]);
  const a = whyOf(ix, './engine/a.mjs', now).rows[0];
  assert.equal(a.id, W.ids.runs); assert.equal(a.title, 'alpha shape? -> c'); assert.equal(a.age_d, 5.5); assert.equal(a.stale.sha, W.sha.hotfix.slice(0, 12));
  for (let i = 0; i < 12; i++) record(W.state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'z', question: `q${i}`, choice: 'c', why: 'w', paths: ['engine/c.mjs'] } }, { now: () => new Date(ms('07T00:00') + i * 60e3), views: false });
  const c = whyOf(buildLinks({ state: W.state, repo: W.repo, now }), 'engine/c.mjs', now);
  assert.equal(c.rows.length, LINKS.why_cap); assert.equal(c.matched, 12); assert.equal(c.rows[0].title, 'q11 -> c', 'newest first');
});

test('refreshLinks writes <state>/code/declinks.json and rebuilds only when main or the records moved', () => {
  const W = world(), now = ms('08T00:00');
  const a = refreshLinks({ state: W.state, repo: W.repo, now }); assert.equal(a.built, true);
  assert.equal(readLinks(W.state).sha, W.sha.delta.slice(0, 12));
  assert.equal(refreshLinks({ state: W.state, repo: W.repo, now }).built, false, 'nothing moved');
  W.commit({ 'engine/c.mjs': 'c2\n' }, 'chore: c', '08T01:00');
  assert.equal(refreshLinks({ state: W.state, repo: W.repo, now }).built, true, 'main moved');
  record(W.state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'z', question: 'q', choice: 'c', why: 'w', paths: ['engine/c.mjs'] } }, { now: () => new Date(now), views: false });
  assert.equal(refreshLinks({ state: W.state, repo: W.repo, now }).built, true, 'a new decision');
});

test('staleRows: decisions gone stale in the digest window, newest first, capped; the digest shows them from the stored index', () => {
  const W = world(), ix = buildLinks({ state: W.state, repo: W.repo, now: ms('08T00:00') });
  assert.deepEqual(staleRows(ix, ms('08T00:00'), { window_h: WINDOW_H }).map(x => x.id), [W.ids.stated, W.ids.runs]);
  assert.deepEqual(staleRows(ix, ms('09T12:00'), { window_h: WINDOW_H }).map(x => x.id), [W.ids.stated], '06T10 is past the 72 h window at 09T12');
  assert.equal(staleRows(ix, ms('08T00:00'), { window_h: WINDOW_H, cap: 1 }).length, 1);
  assert.deepEqual(Object.keys(staleRows(ix, ms('08T00:00'), { window_h: WINDOW_H })[0]).sort(), ['age_h', 'id', 'lane', 'path', 'sha', 'stale_at', 'title']);
  assert.equal(digest(W.state, {}, { now: ms('08T00:00'), dlv: [] }).sections.stale_decisions, undefined, 'no stored index: no section');
  refreshLinks({ state: W.state, repo: W.repo, now: ms('08T00:00') });
  assert.deepEqual(digest(W.state, {}, { now: ms('08T00:00'), dlv: [] }).sections.stale_decisions.map(x => x.id), [W.ids.stated, W.ids.runs]);
});

test('norn code why <file> [--json] and norn code links: the CLI over the index', async () => {
  const W = world(), outs = [], errs = [], o = { out: s => outs.push(s), err: s => errs.push(s), where: () => ({ project: null, state: W.state }), now: ms('08T00:00') };
  assert.equal(await codeCmd(['why', 'engine/a.mjs', '--repo', W.repo, '--json'], o), 0, errs.join('\n'));
  const j = JSON.parse(outs.pop());
  assert.equal(j.file, 'engine/a.mjs'); assert.equal(j.sha, W.sha.delta.slice(0, 12)); assert.deepEqual(j.rows.map(x => x.id), [W.ids.runs]);
  assert.equal(await codeCmd(['why', 'engine/b.mjs', '--repo', W.repo], o), 0);
  assert.match(outs.pop(), new RegExp(`^code why engine/b\\.mjs: 2 records at ${W.sha.delta.slice(0, 12)}`));
  assert.equal(await codeCmd(['links', '--repo', W.repo, '--json'], o), 0);
  assert.deepEqual(JSON.parse(outs.pop()).by_source, { stated: 1, runs: 1, landings: 2 });
  assert.equal(await codeCmd(['why', '--repo', W.repo], o), 2, 'why needs a file'); assert.match(errs.join('\n'), /why needs a file/);
});

test('tickCode starts `norn code links` when the stored index is behind main or the records, not again within 10 min, not once fresh', () => {
  const W = world(), calls = [], spawnFn = (exe, args) => { calls.push(args); return { pid: 7 }; }, p = { file: path.join(W.repo, 'kestrel.json'), root: W.repo };
  for (const f of ['index.json']) { fs.mkdirSync(path.join(W.state, 'code'), { recursive: true }); fs.writeFileSync(path.join(W.state, 'code', f), JSON.stringify({ sha: W.sha.delta.slice(0, 12), files: [] })); }
  fs.mkdirSync(path.join(W.state, 'code', 'map'), { recursive: true });
  const links = () => calls.filter(a => a[2] === 'links');
  tickCode(p, W.state, { metaCmd: 'norn.mjs', spawnFn, now: ms('08T00:00') });
  assert.deepEqual(links(), [['norn.mjs', 'code', 'links', '--project', p.file, '--state', W.state]]);
  tickCode(p, W.state, { metaCmd: 'norn.mjs', spawnFn, now: ms('08T00:05') }); assert.equal(links().length, 1, 'one started 5 min ago');
  refreshLinks({ state: W.state, repo: W.repo, now: ms('08T00:00') });
  tickCode(p, W.state, { metaCmd: 'norn.mjs', spawnFn, now: ms('08T01:00') }); assert.equal(links().length, 1, 'the index is fresh');
});

test('--paths on rec add decision / directive: stored as repo-relative paths; an absolute or .. path is refused', () => {
  const W = world(), cli = (role, ...a) => { const env = { ...process.env, META_STATE: W.state, META_ROLE: role }; delete env.META_RUN_ID; delete env.META_PROJECT;
    const r = spawnSync(process.execPath, [NORN, 'rec', 'add', ...a], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }; };
  const d = cli('controller', 'decision', '--lane', 'z', '--question', 'q', '--choice', 'c', '--why', 'w', '--paths', 'engine\\a.mjs, ./docs/x.md');
  assert.equal(d.code, 0, d.err);
  const dir = cli('owner', 'directive', '--text', 'keep docs short', '--via', 'chat', '--paths', 'docs/x.md', '--new');
  assert.equal(dir.code, 0, dir.err);
  const last = id => fs.readFileSync(path.join(W.state, 'records.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find(e => e.id === id && e.ev === 'create').data.paths;
  assert.deepEqual(last(d.out), ['engine/a.mjs', 'docs/x.md']); assert.deepEqual(last(dir.out), ['docs/x.md']);
  for (const bad of ['/etc/x', 'C:/x', '../x', 'a/../../x']) assert.throws(() => record(W.state, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'z', question: 'q', choice: 'c', why: 'w', paths: [bad] } }, { views: false }), /paths/, bad);
});

test('stale counts only the measured sources (LINKS.stale_sources: stated, runs): a landings link is never stale, never a digest row', () => {
  const W = world(); W.commit({ 'engine/b.mjs': 'b3\n' }, 'fix: b elsewhere', '07T12:00');
  const now = ms('08T00:00'), ix = buildLinks({ state: W.state, repo: W.repo, now }), r = byId(ix);
  assert.deepEqual(LINKS.stale_sources, ['stated', 'runs']);
  for (const id of [W.ids.landing, W.ids.dir]) { assert.equal(r[id].links[0].source, 'landings'); assert.equal(r[id].links[0].stale, null, id); assert.equal(r[id].stale_at, null, id); }
  assert.equal(r[W.ids.runs].stale_at, T('06T10:00'), 'a runs link still goes stale');
  assert.deepEqual(staleRows(ix, now, { window_h: WINDOW_H }).map(x => x.id), [W.ids.stated, W.ids.runs], 'the landings decision changed at 07T12 is no row');
  assert.deepEqual(whyOf(ix, 'engine/b.mjs', now).rows.map(x => [x.id, x.status]), [[W.ids.dir, 'inferred'], [W.ids.landing, 'inferred']], 'why still lists landings links, as inferred');
  assert.deepEqual(whyOf(ix, 'engine/a.mjs', now).rows.map(x => x.status), ['stale']);
  assert.deepEqual(whyOf(ix, 'docs/x.md', now).rows.map(x => [x.id, x.status]), [[W.ids.stated, 'stale']]);
});

test('an index stored before the stale sources were what they are now is rebuilt, though main and the records did not move', () => {
  const W = world(), now = ms('08T00:00'); refreshLinks({ state: W.state, repo: W.repo, now });
  const f = path.join(W.state, 'code', 'declinks.json'), ix = JSON.parse(fs.readFileSync(f, 'utf8')); delete ix.stale_sources; fs.writeFileSync(f, JSON.stringify(ix));
  assert.equal(refreshLinks({ state: W.state, repo: W.repo, now }).built, true);
  assert.deepEqual(readLinks(W.state).stale_sources, LINKS.stale_sources);
});

test('norn code why prints a landings row as inferred, the others as STALE / current; --json carries it as status', async () => {
  const W = world(), outs = [], errs = [], o = { out: s => outs.push(s), err: s => errs.push(s), where: () => ({ project: null, state: W.state }), now: ms('08T00:00') };
  assert.equal(await codeCmd(['why', 'engine/b.mjs', '--repo', W.repo], o), 0, errs.join('\n'));
  const rows = outs.pop().split('\n').slice(1);
  assert.equal(rows.length, 2); for (const l of rows) assert.match(l, /\blandings \(\w+\)  inferred  /);
  assert.equal(await codeCmd(['why', 'engine/a.mjs', '--repo', W.repo], o), 0); assert.match(outs.pop(), /\bruns \(\S+\)  STALE: changed in /);
  assert.equal(await codeCmd(['why', 'engine/b.mjs', '--repo', W.repo, '--json'], o), 0);
  assert.deepEqual(JSON.parse(outs.pop()).rows.map(x => x.status), ['inferred', 'inferred']);
  assert.equal(await codeCmd(['links', '--repo', W.repo], o), 0); assert.match(outs.pop(), /^code links: 4 of 6 records linked \(stated 1, runs 1, landings 2\)/);
});
