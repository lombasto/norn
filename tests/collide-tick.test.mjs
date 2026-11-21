// lane-collide S1c (SPEC 3.4 every tick, 4A.1, 4A.5): the tick's collidePass on temp git repos and records (made-up lanes: map-base and
// map-paint change one file; board is DONE and not merged). Two running lanes of one home that change the same files get a `same-files`
// row, a predicted merge conflict a `conflict` row (overlap.mjs's merge-tree), and the later run one mail per pair and grade. A run whose
// Scope covers a DONE deliverable's files waits up to land_wait_min for it to land. The digest's `collisions` rows come from collide.json
// and leave when the other lane's work is merged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkTmp } from './helpers/tmp.mjs';
import { record } from '../engine/lib/records.mjs';
import { loadMail } from '../engine/lib/mail.mjs';
import { collidePass } from '../engine/lib/tick.mjs';
import { casesOf, actionsOf, readCollide } from '../engine/lib/intents.mjs';
import { collisions, holdsOf, holdTerm } from '../engine/lib/collide.mjs';
import { digest } from '../engine/lib/digest.mjs';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_TERMINAL_PROMPT: '0' };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
const put = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const fwd = p => p.split(path.sep).join('/');
const FILES = ['map/tiles.mjs', 'map/paint.mjs', 'ui/board.mjs', 'docs/guide.md'];
// eight lines, so an edit of the first line and a line appended at the end merge cleanly (same files, no conflict)
const BASE = f => `// ${f}\n${[2, 3, 4, 5, 6, 7, 8].map(n => `line ${n}`).join('\n')}\n`;

function fixture() {
  const t = mkTmp('meta-ctick-'), origin = path.join(t, 'origin.git'), home = path.join(t, 'home'), state = path.join(t, 'state', 'k');
  git(t, 'init', '-q', '--bare', '-b', 'main', origin);
  git(t, 'clone', '-q', origin, home);
  git(home, 'checkout', '-q', '-b', 'main');
  for (const f of FILES) put(path.join(home, f), BASE(f));
  git(home, 'add', '-A'); git(home, 'commit', '-qm', 'base'); git(home, 'push', '-q', 'origin', 'main');
  fs.mkdirSync(state, { recursive: true });
  const f = { t, home, state, p: { name: 'k', root: fwd(home), state, policy: {} } };
  f.lane = (lane, edits = {}) => {
    const wt = path.join(t, 'wt', lane);
    git(home, 'worktree', 'add', '-q', '-b', `norn/${lane}`, wt, 'origin/main');
    for (const [file, s] of Object.entries(edits)) { put(path.join(wt, file), s); git(wt, 'add', '-A'); git(wt, 'commit', '-qm', `${lane}: ${file}`); }
    return fwd(wt);
  };
  f.brief = (name, text) => { const p = path.join(t, 'briefs', `${name}.md`); put(p, text); return p; };
  f.running = (lane, wt, brief) => record(state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'fake', lane, stage: 'S1', worktree: wt, brief } }).id;
  f.unlanded = (lane, wt, brief) => {
    const run = f.running(lane, wt, brief);
    record(state, { kind: 'run', ev: 'end', id: run, by: 'launcher', data: { outcome: 'done', exit: 0 } });
    const tip = git(home, 'rev-parse', `norn/${lane}`);
    return record(state, { kind: 'deliverable', ev: 'create', by: 'launcher', data: { repo: fwd(home), branch: `norn/${lane}`, tip, lane, run, delivers: lane, source: 'run', done_utc: new Date().toISOString() } }).id;
  };
  f.land = lane => { git(home, 'push', '-q', 'origin', `norn/${lane}:main`); git(home, 'fetch', '-q', 'origin'); };
  f.mails = () => Object.values(loadMail(state));
  return f;
}

test('same-files: two running lanes of one home that change one file get the row, and the later run one mail per pair and grade', () => {
  const f = fixture();
  const a = f.running('map-base', f.lane('map-base', { 'map/tiles.mjs': `${BASE('map/tiles.mjs')}more tiles\n` }), f.brief('a', '# map-base S1\nScope: map/tiles.mjs\n'));
  const b = f.running('map-paint', f.lane('map-paint', { 'map/tiles.mjs': BASE('map/tiles.mjs').replace('// map/tiles.mjs', '// tiles paint') }), f.brief('b', '# map-paint S1\nScope: map/paint.mjs\n'));
  collidePass(f.state, f.p);
  const rows = readCollide(f.state).rows;
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.deepEqual([rows[0].kind, rows[0].grade, rows[0].lane, rows[0].other, rows[0].files], ['territory', 'same-files', 'map-paint', 'map-base', ['map/tiles.mjs']]);
  assert.match(rows[0].col, /^COL-\d+$/);
  const m = f.mails();
  assert.equal(m.length, 1);
  assert.equal(m[0].data.to, b, 'the later of the two running runs is told');
  assert.match(m[0].text ?? m[0].data.body, /norn\/map-base[\s\S]*map\/tiles\.mjs[\s\S]*merge main into your branch after it lands/);
  assert.ok(actionsOf(casesOf(f.state)[rows[0].col]).some(x => x.action === 'told' && x.args.mail === m[0].id));
  collidePass(f.state, f.p);
  assert.equal(f.mails().length, 1, 'one mail per pair and grade');
  assert.ok(a);
});

test('conflict: merge-tree predicts a conflict between two running lanes - the row says conflict and the later run is told', () => {
  const f = fixture();
  f.running('map-base', f.lane('map-base', { 'map/tiles.mjs': '// tiles\nTILES\nline 3\n' }), f.brief('a', '# map-base S1\nScope: map/**\n'));
  const b = f.running('map-paint', f.lane('map-paint', { 'map/tiles.mjs': '// tiles\nPAINT\nline 3\n' }), f.brief('b', '# map-paint S1\nScope: map/**\n'));
  collidePass(f.state, f.p);
  const [row] = readCollide(f.state).rows;
  assert.deepEqual([row.grade, row.lane, row.files], ['conflict', 'map-paint', ['map/tiles.mjs']]);
  assert.deepEqual(f.mails().map(x => x.data.to), [b]);
  assert.match(f.mails()[0].data.subject, /conflict/);
});

test('land-first wait: a run whose Scope covers a DONE deliverable\'s files is held up to land_wait_min, then starts with the warn', () => {
  const T = Date.UTC(2026, 10, 20, 12), board = { lane: 'board', state: 'unlanded', since: T - 6e5, role: 'work', dlv: 'DLV-7', run: 'RUN-3', scope: null, exclusive: [], touched: ['ui/board.mjs'], items: [] };
  const me = { lane: 'ui-kit', state: 'queued', run: 'RUN-9', since: T, role: 'work', scope: ['ui/**'], exclusive: [], touched: [], items: [] };
  const [h] = collisions(me, [board], { now: T + 10 * 6e4 });
  assert.deepEqual([h.kind, h.grade, h.verdict], ['territory', 'covers', 'hold']);
  assert.deepEqual(holdsOf([h]), [h]);
  assert.match(holdTerm(h), /land-first: waits up to 45 min for DLV-7 of lane board/);
  assert.equal(collisions(me, [board], { now: T + 46 * 6e4 })[0].verdict, 'warn', 'past the wait it starts');
  assert.equal(collisions(me, [board], { now: T, policy: { auto: { land_wait_min: 0 } } })[0].verdict, 'warn', 'switched off');
  assert.equal(collisions({ ...me, state: 'running' }, [board], { now: T })[0].verdict, 'warn', 'a running run is never held');
  assert.equal(collisions(me, [{ ...board, dlv: null }], { now: T })[0].verdict, 'warn', 'paused work with commits is no DONE deliverable');
});

test('digest: the collisions section lists the open row with SloppaChoppa\'s pick, and the row leaves when the other lane\'s work is merged', () => {
  const f = fixture();
  f.unlanded('board', f.lane('board', { 'ui/board.mjs': '// new board\n' }), f.brief('board', '# board S1\nScope: ui/board.mjs\n'));
  f.running('ui-kit', f.lane('ui-kit', { 'map/paint.mjs': '// kit\n' }), f.brief('kit', '# ui-kit S1\nScope: ui/** map/paint.mjs\nTests: t\nDone: d\n'));
  collidePass(f.state, f.p);
  const s = digest(f.state, f.p).sections.collisions;
  assert.equal(s?.length, 1, JSON.stringify(s));
  assert.deepEqual([s[0].kind, s[0].grade, s[0].lane, s[0].other, s[0].pick.remedy], ['territory', 'covers', 'ui-kit', 'board', 'wait']);
  assert.match(s[0].id, /^COL-\d+$/);
  f.land('board');
  collidePass(f.state, f.p);
  assert.equal(digest(f.state, f.p).sections.collisions, undefined, 'the cause is gone, so is the row');
});
