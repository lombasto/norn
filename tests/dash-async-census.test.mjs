// META-DASH-ASYNC R1 (DEC-338): census - no GET route of the dash server makes a sync fs syscall (each one blocks the event loop:
// on the Windows runner any of them sporadically takes 0.5-2.4 s). Every sync fs call made while a warmed GET is in flight is
// counted, with the first engine frame of its stack; the expected count is 0 per route. Sandbox only: the shared dash fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './helpers/dash-fixture.mjs';
import { record } from '../engine/lib/records.mjs';

const SYNC = ['readFileSync', 'statSync', 'lstatSync', 'existsSync', 'readdirSync', 'openSync', 'readSync', 'fstatSync', 'closeSync',
  'writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'renameSync', 'fsyncSync', 'accessSync', 'rmSync'];
const CP_SYNC = ['spawnSync', 'execFileSync', 'execSync'];   // a sync child process blocks the loop for its whole run
/** count every sync fs / child_process call until undo(); each as "<fn> <first engine frame>" */
function census() {
  const seen = new Map(), orig = {};
  for (const [mod, k] of [...SYNC.map(k => [fs, k]), ...CP_SYNC.map(k => [cp, k])]) {
    orig[k] = mod[k];
    mod[k] = function (...a) {
      const fr = new Error().stack.split('\n').slice(2).filter(l => /engine[\\/]/.test(l) && !/fsnap\.mjs/.test(l)).slice(0, 3)   // the call < its callers
        .map(l => l.trim().replace(/^at /, '').replace(/\(?(file:\/+)?[A-Z]:.*?[\\/](engine[\\/])/i, '$2').replace(/\)$/, '')).join(' < ') || '?';
      const key = k + ' ' + fr; seen.set(key, (seen.get(key) || 0) + 1);
      return orig[k].apply(this, a);
    };
  }
  syncBuiltinESMExports();   // the engine's named imports see the patched forms
  return { seen, undo: () => { for (const k of SYNC) fs[k] = orig[k]; for (const k of CP_SYNC) cp[k] = orig[k]; syncBuiltinESMExports(); } };
}

const ROUTES = ['/', '/ui.mjs', '/norn/assets.json', '/api/projects', '/api/inbox', '/api/lanes', '/api/agents',
  '/api/map?project=kestrel', '/api/branches?project=kestrel', '/api/deliverables?project=kestrel', '/api/records?project=kestrel', '/api/roadmap?project=kestrel',
  '/api/usage', '/api/plan', '/api/docs?project=kestrel', '/api/instructions?project=kestrel', '/api/guard?project=kestrel',
  '/api/tests?project=kestrel', '/api/ledger?project=kestrel', '/api/settings?project=kestrel',
  '/api/home?project=kestrel', '/api/adopt?project=kestrel', '/api/adopt/repos', '/api/timing'];

test('no warmed GET route makes a sync fs call', async () => {
  const f = await fixture();
  const out = [];
  try {
    for (const r of ROUTES) {
      await fetch(f.url + r).then(x => x.text());   // warm: module loads, first folds
      const c = census();
      let st; try { st = (await fetch(f.url + r)).status; } finally { c.undo(); }
      const n = [...c.seen.values()].reduce((a, b) => a + b, 0);
      if (n) out.push(`${r} (${st}): ${n} sync calls\n    ` + [...c.seen].map(([k, v]) => `${v}x ${k}`).join('\n    '));
    }
  } finally { await f.done(); }
  assert.equal(out.length, 0, out.join('\n'));
});

// the stream / chat / file routes: an SSE route is held open for a window of its own polls (the
// feed / stream hubs' timers, the stream's kick of the derived caches) and then aborted - every sync call in the window counts
const SSE = ['/api/feed?project=kestrel&run=RUN-1', '/api/feed?project=kestrel&run=RUN-2', '/api/stream?project=kestrel', '/api/chat?project=kestrel&live=1'];
test('no stream / chat / file route makes a sync fs call', async () => {
  const f = await fixture({ dash: { feedPollMs: 50, feedLingerMs: 100, streamPollMs: 50, streamPulseMs: 100, streamLingerMs: 100, deliverablesTtlMs: 100 } });
  fs.writeFileSync(path.join(f.pa.root, 'shot.png'), Buffer.from([137, 80, 78, 71]));
  const plain = [`/api/file?project=kestrel&path=${encodeURIComponent(path.join(f.pa.root, 'shot.png'))}`];
  const hold = async r => {   // read the stream for 600 ms (its first events + a dozen polls), then abort
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 600);   // a stream with nothing to replay sends no header until its first line
    let st = 'open';
    try { const x = await fetch(f.url + r, { signal: ac.signal }); st = x.status; const rd = x.body.getReader(); for (;;) { const { done } = await rd.read(); if (done) break; } } catch { /* aborted */ } finally { clearTimeout(t); }
    return st;
  };
  const out = [];
  try {
    for (const r of [...plain, ...SSE]) {
      const sse = SSE.includes(r);
      if (sse) await hold(r); else await fetch(f.url + r).then(x => x.text());   // warm
      await new Promise(ok => setTimeout(ok, 250));   // the warm-up's tailers / hubs linger out
      const c = census();
      let st; try { st = sse ? await hold(r) : (await fetch(f.url + r).then(async x => (await x.text(), x.status))); } finally { c.undo(); }
      const n = [...c.seen.values()].reduce((a, b) => a + b, 0);
      if (n) out.push(`${r} (${st}): ${n} sync calls\n    ` + [...c.seen].map(([k, v]) => `${v}x ${k}`).join('\n    '));
    }
  } finally { await f.done(); }
  assert.equal(out.length, 0, out.join('\n'));
});

// HANDOFF R1 step 2 (option a): the POST write paths - a warmed POST (its route's module loads + first folds done by a first tap)
// makes no sync fs WRITE and no sync child process: a record write, its views, the PAUSED flag. Sync reads on a POST are not
// counted here (the GET census holds the reads). Each POST is valid and lands (2xx).
const WRITES = new Set(['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'renameSync', 'fsyncSync', 'rmSync', 'openSync', ...CP_SYNC]);
test('no warmed POST write route makes a sync fs write or a sync child process', async () => {
  const f = await fixture({ project: { lane_defaults: { worktree: '${state}/wt/${lane}', notes: '${state}/notes/${lane}/NOTES.md' } } });
  // resume 3 step 3: two running runs to stop (warm + counted) and a git root for the first-task lane's worktree
  const runs = [0, 1].map(() => record(f.pa.state, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'seabed' } }).id);
  for (const a of [['init', '-q'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root']]) cp.execFileSync('git', ['-C', f.pa.root, ...a]);
  const taps = [
    ['/api/directive', () => ({ project: 'kestrel', text: 'census directive' })],
    ['/api/directive/revoke', async () => ({ project: 'kestrel', id: (await f.post('/api/directive', { project: 'kestrel', text: 'to revoke' })).data.id })],
    ['/api/lane/archive', warm => ({ project: 'kestrel', lane: 'seabed', unarchive: !warm })],   // archive (warm), then unarchive
    ['/api/pause', () => ({ project: 'kestrel', mode: 'queue' })],
    ['/api/pause', () => ({ project: 'kestrel', resume: 'all' })],
    // HANDOFF R1 resume 3 step 1: Settings saves (machine budget, project policy + its marked lines, a caps-profile decision) and a roadmap add
    ['/api/settings', async warm => ({ project: 'kestrel', version: (await f.get('/api/settings?project=kestrel')).data.version, changes: { max_claude_workers: warm ? 3 : 2 } })],
    ['/api/settings', async warm => ({ project: 'kestrel', version: (await f.get('/api/settings?project=kestrel')).data.version, changes: { 'policy.context.implementer.handoff_k': warm ? 100 : 120 } })],
    ['/api/settings', async warm => { const g = (await f.get('/api/settings?project=kestrel')).data;
      const cost = warm ? 'balanced' : 'cheap';
      return { project: 'kestrel', version: g.version, changes: g.profiles.find(x => x.name === 'heavy').changes[cost], profile: { name: 'heavy', cost } }; }],
    // step 2: a chat thread line (the picker appends a pick line to the thread)
    ['/api/chat/pick', warm => ({ project: 'kestrel', model: warm ? 'claude-sonnet-5-5' : null })],
    ['/api/roadmap/add', warm => ({ project: 'kestrel', title: warm ? 'census theme' : 'census theme 2', kind: 'theme' })],
    // step 3: a stop of a running run (record, kill, heartbeat + lock freed) and the first-task lane (git worktree, LANE + DIR, brief)
    ['/api/stop', warm => ({ project: 'kestrel', run: runs[warm ? 0 : 1], confirm: true })],
    ['/api/first-task', warm => ({ project: 'kestrel', lane: warm ? 'census-a' : 'census-b', text: 'census task' })],
    // resume 4 step 2: the adopt review of the fixture repo (a facts-only draft; a tap decides the parts it needs before it is counted)
    ['/api/adopt/decide', async () => decideBody((await adopt()).parts.find(y => y.status === 'to review' && !y.pick).id)],
    ['/api/adopt/rule', warm => ({ project: 'kestrel', text: warm ? 'Census rule one.' : 'Census rule two.' })],
    ['/api/adopt/apply', async warm => { if (!warm) await approveRest(); return { project: 'kestrel' }; }],   // a part, then the rest
    ['/api/adopt/close', async () => { await draft(); return { project: 'kestrel', why: 'census' }; }],
  ];
  const adopt = async () => (await f.get('/api/adopt?project=kestrel')).data.proposal;
  const draft = async () => { const r = await f.post('/api/adopt/draft', { project: 'kestrel', read: false }); assert.equal(r.status, 200, JSON.stringify(r.data)); };
  const decideBody = async part => { const x = (await adopt()).parts.find(y => y.id === part);
    return { project: 'kestrel', part, sha: x.sha, verdict: 'approve', ...(x.pick ? { pick: x.lines[0].id } : {}) }; };
  const approveRest = async () => { for (const x of (await adopt()).parts.filter(y => y.status === 'to review')) assert.equal((await f.post('/api/adopt/decide', await decideBody(x.id))).status, 200, x.id); };
  const out = [];
  try {
    await draft();
    for (const [r, mk] of taps) {
      const w0 = await f.post(r, await mk(true));   // warm
      assert.ok(w0.status < 300, `${r} warm: ${w0.status} ${JSON.stringify(w0.data)}`);
      const b = await mk(false), c = census();
      let st; try { st = (await f.post(r, b)).status; } finally { c.undo(); }
      const w = [...c.seen].filter(([k]) => WRITES.has(k.split(' ')[0]));
      if (w.length || st >= 300) out.push(`${r} (${st}): ${w.reduce((a, [, v]) => a + v, 0)} sync writes\n    ` + w.map(([k, v]) => `${v}x ${k}`).join('\n    '));
    }
  } finally { await f.done(); }
  assert.equal(out.length, 0, out.join('\n'));
});
