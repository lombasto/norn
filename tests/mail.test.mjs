// META-GTP-MAIL (GT-PARITY-PLAN sec. 2.7): agent mail + nudge for headless workers. Temp dirs + the FAKE executor only.
// Gas Town (cited, not ported): mail = a bead with an assignee (internal/mail/router.go:214-225,1113-1179); delivery by a hook
// `gt mail check --inject` (internal/hooks/config.go:1085-1092; internal/cmd/mail_check.go:75-99); nudge (internal/cmd/nudge.go).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, loadState, readEvents, recordsFile, fold, RecordError, kindOfId } from '../engine/lib/records.mjs';
import { mkTmp } from './helpers/tmp.mjs';

const META = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'bin', 'norn.mjs');

const tmp = () => mkTmp('meta-mail-');
const rec = (s, e, run = null) => record(s, e, { run });
const startRun = (s, data = {}) => rec(s, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'fake', lane: 'demo', ...data } }).id;
const mails = s => fold(readEvents(recordsFile(s, 'mail'))).items;
const send = (s, by, data, run = null) => rec(s, { kind: 'mail', ev: 'create', by, data: { subject: 'S', body: 'hello', ...data } }, run);
const refused = (fn, re) => assert.throws(fn, e => e instanceof RecordError && e.code === 2 && (!re || re.test(e.message)), String(re));

// ---------- piece 1: the record kind ----------
test('mail: MAIL-n in its own file mail.jsonl; create -> queued, deliver -> delivered, ack -> acked', () => {
  const s = tmp();
  const r = startRun(s);
  const m = send(s, 'controller', { from: 'role:controller', to: r, urgent: true });
  assert.equal(m.id, 'MAIL-1');
  assert.equal(kindOfId('MAIL-1'), 'mail');
  assert.ok(fs.existsSync(path.join(s, 'mail.jsonl')));
  assert.ok(!fs.existsSync(path.join(s, 'records.jsonl')), 'records.jsonl untouched');
  assert.equal(mails(s)['MAIL-1'].state, 'queued');
  rec(s, { kind: 'mail', ev: 'deliver', id: 'MAIL-1', by: 'worker', data: { run: r, via: 'hook' } }, r);
  assert.equal(mails(s)['MAIL-1'].state, 'delivered');
  rec(s, { kind: 'mail', ev: 'ack', id: 'MAIL-1', by: 'worker', data: {} }, r);
  assert.equal(mails(s)['MAIL-1'].state, 'acked');
  assert.equal(loadState(s).items['MAIL-1'], undefined, 'loadState (records + runs) stays as it was');
});

test('mail: the shape - subject, body <= 2 KB xor body_file, to = RUN-n | lane:L | role:checkin|controller, urgent boolean', () => {
  const s = tmp();
  const r = startRun(s);
  const ctl = d => () => send(s, 'controller', { from: 'role:controller', to: r, ...d });
  refused(ctl({ body: 'x'.repeat(2049) }), /2 KB|2048/);
  assert.doesNotThrow(ctl({ body: 'x'.repeat(2048) }));
  refused(ctl({ body: 'é'.repeat(1025) }), /2 KB|2048/);   // bytes, not characters
  refused(ctl({ body: undefined }), /body/);
  refused(ctl({ body_file: path.join(s, 'b.md') }), /body/);   // both
  assert.doesNotThrow(ctl({ body: undefined, body_file: path.join(s, 'b.md') }));
  refused(ctl({ subject: '' }), /subject/);
  refused(ctl({ urgent: 'yes' }), /urgent/);
  for (const to of ['RUN-x', 'lane:', 'role:owner', 'bob', 'RUN-99']) refused(ctl({ to }), /to/);
  for (const to of ['lane:demo', 'role:checkin', 'role:controller']) assert.doesNotThrow(ctl({ to }));
  refused(ctl({ from: 'role:checkin' }), /from/);   // the controller sends as role:controller
});

test('mail send rights: check-in / controller -> any run; a run -> its parent, the check-in, the controller, runs of its own epic', () => {
  const s = tmp();
  const parent = startRun(s), child = startRun(s, { parent }), other = startRun(s);
  const peer = startRun(s, { epic: 'EP-1' }), me = startRun(s, { epic: 'EP-1', parent });
  rec(s, { kind: 'epic', ev: 'create', by: 'controller', data: { title: 'E', priority: 'P1', members: [peer] } });
  rec(s, { kind: 'epic', ev: 'add', id: 'EP-1', by: 'launcher', data: { members: [me] } });
  const ep2 = startRun(s);
  rec(s, { kind: 'epic', ev: 'create', by: 'controller', data: { title: 'E2', priority: 'P1', members: [ep2] } });
  for (const by of ['checkin', 'controller']) for (const to of [parent, child, other, 'lane:demo', 'role:checkin'])
    assert.doesNotThrow(() => send(s, by, { from: `role:${by}`, to }), `${by} -> ${to}`);
  const w = (to, run = me, from = run) => () => send(s, 'worker', { from, to }, run);
  for (const to of [parent, 'role:checkin', 'role:controller', peer]) assert.doesNotThrow(w(to), `run -> ${to}`);
  assert.doesNotThrow(w(parent, child), 'child -> parent (no epic)');
  refused(w(other), /may not mail/);
  refused(w(ep2), /may not mail/);   // another epic
  refused(w(child), /may not mail/);   // not its parent
  refused(w('lane:demo'), /may not mail/);
  refused(w(me), /may not mail/);   // itself
  refused(w(parent, null, me), /META_RUN_ID/);   // a worker without its run id
  refused(w(parent, me, other), /from/);   // a run sends as itself
  refused(w(parent, 'RUN-99'), /RUN-99/);
});

test('mail deliver is one compare-and-set: a second deliver is refused; only a recipient delivers / acks it (a run: its chain or lane)', () => {
  const s = tmp();
  const a = startRun(s), b = startRun(s), c = startRun(s, { lane: 'other' });
  const a2 = startRun(s, { resume_of: a });   // a's auto-resume: a's mail is its mail
  send(s, 'controller', { from: 'role:controller', to: a });
  refused(() => rec(s, { kind: 'mail', ev: 'deliver', id: 'MAIL-1', by: 'worker', data: { run: b, via: 'hook' } }, b), /not addressed/);
  rec(s, { kind: 'mail', ev: 'deliver', id: 'MAIL-1', by: 'worker', data: { run: a2, via: 'mcp' } }, a2);
  refused(() => rec(s, { kind: 'mail', ev: 'deliver', id: 'MAIL-1', by: 'worker', data: { run: a2, via: 'hook' } }, a2), /is delivered/);
  refused(() => rec(s, { kind: 'mail', ev: 'deliver', id: 'MAIL-1', by: 'worker', data: { run: a2, via: 'pigeon' } }, a2));
  refused(() => rec(s, { kind: 'mail', ev: 'ack', id: 'MAIL-1', by: 'worker', data: {} }, b), /not addressed/);
  rec(s, { kind: 'mail', ev: 'ack', id: 'MAIL-1', by: 'worker', data: {} }, a2);
  refused(() => rec(s, { kind: 'mail', ev: 'ack', id: 'MAIL-1', by: 'worker', data: {} }, a2), /is acked/);
  send(s, 'checkin', { from: 'role:checkin', to: 'lane:demo' });
  refused(() => rec(s, { kind: 'mail', ev: 'deliver', id: 'MAIL-2', by: 'worker', data: { run: c, via: 'hook' } }, c), /not addressed/);
  rec(s, { kind: 'mail', ev: 'deliver', id: 'MAIL-2', by: 'worker', data: { run: b, via: 'hook' } }, b);
  refused(() => rec(s, { kind: 'mail', ev: 'deliver', id: 'MAIL-2', by: 'worker', data: { run: c, via: 'hook' } }, b), /run/);   // delivers to itself only
});

test('mail nudge: the launcher claims an unacked mail once (queued | delivered -> delivered); never twice, never an acked one', () => {
  const s = tmp();
  const a = startRun(s);
  send(s, 'controller', { from: 'role:controller', to: a, urgent: true });
  refused(() => rec(s, { kind: 'mail', ev: 'nudge', id: 'MAIL-1', by: 'controller', data: { run: a } }), /role/);
  rec(s, { kind: 'mail', ev: 'nudge', id: 'MAIL-1', by: 'launcher', data: { run: a } });
  assert.equal(mails(s)['MAIL-1'].state, 'delivered');
  refused(() => rec(s, { kind: 'mail', ev: 'nudge', id: 'MAIL-1', by: 'launcher', data: { run: a } }), /already nudged/);
  send(s, 'controller', { from: 'role:controller', to: a, urgent: true });
  rec(s, { kind: 'mail', ev: 'ack', id: 'MAIL-2', by: 'controller', data: {} });
  refused(() => rec(s, { kind: 'mail', ev: 'nudge', id: 'MAIL-2', by: 'launcher', data: { run: a } }), /is acked/);
});

// ---------- piece 2: norn mail send | check [--inject] | ack | list; delivery (a) hook, (b) MCP norn_mail + the headless line ----------
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, META_NO_TICK: '1', ...extra };
  for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID', 'META_NOTES', 'META_SESSION_ID', 'META_RESUMES', 'META_JOB']) if (!(k in extra)) delete env[k];
  return env;
};
const meta = (args, extra = {}) => spawnSync(process.execPath, [META, ...args], { encoding: 'utf8', env: cleanEnv(extra), timeout: 30000 });
const metaAsync = (args, extra = {}) => new Promise(res => {
  const p = spawn(process.execPath, [META, ...args], { env: cleanEnv(extra) });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  p.on('exit', status => res({ status, stdout: out, stderr: err }));
});
function mcpServer(state, extra) {
  const p = spawn(process.execPath, [META, 'mcp', '--state', state, '--profile', 'worker'], { env: cleanEnv(extra), stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0;
  const waiting = new Map();
  p.stdout.on('data', d => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); } }
  });
  p.stdin.on('error', () => {});
  const call = (method, params = {}) => new Promise(res => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const tool = async (name, a = {}) => (await call('tools/call', { name, arguments: a })).result;
  const init = () => call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  const close = () => new Promise(res => { if (p.exitCode !== null) return res(); p.on('exit', res); p.stdin.end(); });
  return { call, tool, init, close };
}

test('norn mail send / check / ack / list: the controller (no run) and a run (META_RUN_ID) as themselves; check delivers once', () => {
  const s = tmp();
  const parent = startRun(s), r = startRun(s, { parent });
  const a = meta(['mail', 'send', '--state', s, '--to', r, '--subject', 'rebase', '--body', 'rebase on main first', '--urgent']);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /^MAIL-1 queued -> RUN-2/);
  assert.equal(mails(s)['MAIL-1'].by, 'controller');
  assert.equal(mails(s)['MAIL-1'].data.from, 'role:controller');
  const env = { META_RUN_ID: r };
  assert.equal(meta(['mail', 'send', '--state', s, '--to', parent, '--subject', 'x', '--body', 'y', '--as', 'controller'], env).status, 2, 'a run sends as itself');
  const up = meta(['mail', 'send', '--state', s, '--to', parent, '--subject', 'done?', '--body', 'step 2 done'], env);
  assert.equal(up.status, 0, up.stderr);
  assert.equal(mails(s)['MAIL-2'].data.from, r);
  assert.equal(meta(['mail', 'send', '--state', s, '--to', 'lane:demo', '--subject', 'x', '--body', 'y'], env).status, 2, 'a run may not mail a lane');
  const c1 = meta(['mail', 'check', '--state', s, '--run', r], env);
  assert.equal(c1.status, 0, c1.stderr);
  assert.match(c1.stdout, /MAIL-1 from role:controller URGENT: rebase/);
  assert.match(c1.stdout, /rebase on main first/);
  assert.match(c1.stdout, /norn mail ack MAIL-1/);
  assert.equal(mails(s)['MAIL-1'].state, 'delivered');
  assert.equal(mails(s)['MAIL-1'].deliver.via, 'cli');
  assert.equal(meta(['mail', 'check', '--state', s, '--run', r], env).stdout.trim(), 'no new mail');
  assert.equal(meta(['mail', 'check', '--state', s, '--run', parent], env).status, 2, "another run's mail is read with list, never taken");
  assert.equal(meta(['mail', 'ack', 'MAIL-1', '--state', s], env).status, 0);
  assert.equal(mails(s)['MAIL-1'].state, 'acked');
  const l = meta(['mail', 'list', '--state', s, '--json']);
  assert.deepEqual(JSON.parse(l.stdout).map(m => [m.id, m.state, m.to]), [['MAIL-1', 'acked', r], ['MAIL-2', 'queued', parent]]);
  assert.match(meta(['mail', 'list', '--state', s, '--open']).stdout, /^MAIL-2 queued RUN-2 -> RUN-1 done\?$/m);
  // the controller's session has no run: its address is role:controller
  meta(['mail', 'send', '--state', s, '--to', 'role:controller', '--subject', 'hi', '--body', 'b'], env);
  assert.match(meta(['mail', 'check', '--state', s, '--to', 'role:controller']).stdout, /MAIL-3 from RUN-2: hi/);
});

test('norn mail check --inject = the PostToolUse hook: unread mail as additionalContext (marked delivered via hook); nothing = no output; never fails', () => {
  const s = tmp();
  const r = startRun(s);
  fs.writeFileSync(path.join(s, 'long.md'), 'the long body\nline 2\n');
  send(s, 'controller', { from: 'role:controller', to: r, subject: 'read this', body: undefined, body_file: path.join(s, 'long.md') });
  const h = meta(['mail', 'check', '--inject', '--run', r, '--state', s], { META_RUN_ID: r });
  assert.equal(h.status, 0, h.stderr);
  const j = JSON.parse(h.stdout);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(j.hookSpecificOutput.additionalContext, /MAIL-1 from role:controller: read this/);
  assert.match(j.hookSpecificOutput.additionalContext, /the long body\nline 2/);
  assert.equal(mails(s)['MAIL-1'].deliver.via, 'hook');
  const none = meta(['mail', 'check', '--inject', '--run', r, '--state', s], { META_RUN_ID: r });
  assert.equal(none.status, 0); assert.equal(none.stdout, '');
  // an unexpanded $META_RUN_ID (a shell without POSIX expansion) falls back to the env; a broken state never fails the tool call
  send(s, 'controller', { from: 'role:controller', to: r });
  assert.match(JSON.parse(meta(['mail', 'check', '--inject', '--run', '$META_RUN_ID', '--state', s], { META_RUN_ID: r }).stdout).hookSpecificOutput.additionalContext, /MAIL-2/);
  fs.appendFileSync(path.join(s, 'mail.jsonl'), '{torn');
  const bad = meta(['mail', 'check', '--inject', '--run', r, '--state', s], { META_RUN_ID: r });
  assert.equal(bad.status, 0); assert.equal(bad.stdout, ''); assert.match(bad.stderr, /mail check/);
});

// proc-hygiene (D): two hooks hung a day each, orphaned when Claude Code's timeout killed only their shell. A torn lock file (no ts:
// never stale) makes record() wait 60 s with the event loop blocked - the hook's watchdog thread ends it at META_HOOK_MAX_MS anyway.
test('norn mail check --inject ends in bounded time even when a lock wait blocks its event loop', () => {
  const s = tmp();
  const r = startRun(s);
  send(s, 'controller', { from: 'role:controller', to: r });
  fs.writeFileSync(path.join(s, 'mail.lock'), '{torn');
  const t0 = Date.now();
  const h = meta(['mail', 'check', '--inject', '--run', r, '--state', s], { META_RUN_ID: r, META_HOOK_MAX_MS: '1500' });
  const ms = Date.now() - t0;
  assert.ok(ms < 15000, `the hook took ${ms} ms`);
  assert.equal(h.error, undefined, 'not the test\'s own spawn timeout');
  assert.equal(h.stdout, '');
  assert.match(h.stderr, /no answer in 1500 ms, ended/);
});

test('the launcher adds the mail hook to executors that run hooks (claude: --settings PostToolUse); the others get the headless mail line', async () => {
  const { buildCommand, mailHookOf } = await import('../engine/lib/runs.mjs');
  const { ADAPTERS } = await import('../engine/lib/harness/index.mjs');
  const s = tmp();
  const hook = mailHookOf({ executor: 'claude', state: s });
  assert.match(hook, /mail check --inject --run \$META_RUN_ID --state "[^"]+"$/);
  assert.equal(mailHookOf({ executor: 'codex-sol', state: s }), undefined);
  assert.equal(mailHookOf({ executor: 'fake', state: s }), undefined);
  const base = { executor: 'claude', exe: '/x/claude', brief: 'B', worktree: 'W', notes: 'N', model: 'm', effort: 'e', session_id: 'sid', lane: 'l' };
  assert.ok(!buildCommand(base).args.includes('--settings'), 'no hook = the command line as before');
  const args = buildCommand({ ...base, mail_hook: hook }).args;
  const set = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(set.hooks.PostToolUse.map(x => x.hooks[0].command), [hook]);
  for (const f of ['codex', 'cli']) assert.match(ADAPTERS[f].headless, /check your mail between steps/, f);
  assert.doesNotMatch(ADAPTERS.claude.headless, /mail/);
});

test('MCP norn_mail (worker profile): check delivers, send as the run, ack; a worker without META_RUN_ID is refused', async () => {
  const s = tmp();
  const parent = startRun(s), r = startRun(s, { parent });
  send(s, 'checkin', { from: 'role:checkin', to: r, subject: 'stop at step 3' });
  const m = mcpServer(s, { META_RUN_ID: r }); await m.init();
  const names = (await m.call('tools/list')).result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['norn_mail', 'norn_run_show', 'norn_status']);
  const c = await m.tool('norn_mail', { action: 'check' });
  assert.ok(!c.isError, JSON.stringify(c));
  assert.deepEqual(c.structuredContent.mail.map(x => x.id), ['MAIL-1']);
  assert.equal(mails(s)['MAIL-1'].deliver.via, 'mcp');
  assert.deepEqual((await m.tool('norn_mail', { action: 'check' })).structuredContent.mail, []);
  const snd = await m.tool('norn_mail', { action: 'send', to: 'role:checkin', subject: 'ok', body: 'stopping at 3' });
  assert.ok(!snd.isError, JSON.stringify(snd)); assert.equal(mails(s)['MAIL-2'].data.from, r);
  assert.equal((await m.tool('norn_mail', { action: 'send', to: 'lane:demo', subject: 'x', body: 'y' })).structuredContent.code, 2);
  assert.ok(!(await m.tool('norn_mail', { action: 'ack', id: 'MAIL-1' })).isError);
  assert.equal(mails(s)['MAIL-1'].state, 'acked');
  await m.close();
  const nobody = mcpServer(s, {}); await nobody.init();
  assert.equal((await nobody.tool('norn_mail', { action: 'check' })).structuredContent.code, 2);
  await nobody.close();
});

async function mailRace({ hooksLate = false } = {}) {
  const s = tmp(), locks = s + '-locks', wt = mkTmp('meta-mail-wt-');
  const until = path.join(wt, 'release'), brief = path.join(wt, 'brief.md');
  fs.writeFileSync(brief, `mode: done\nuntil: ${until}\n`);
  const { startRun: launch } = await import('../engine/lib/runs.mjs');
  const r = launch({ state: s, locksDir: locks, executor: 'fake', lane: 'demo', worktree: wt, brief, hbMs: 150, staleMs: 3000, policy: { auto_resume_max: 0 }, budget: {}, tick: null }).run;
  try {
    const N = 24;
    const ids = text => text.match(/MAIL-\d+(?= from)/g) || [];
    const seen = [];
    const m = mcpServer(s, { META_RUN_ID: r }); await m.init();
    const hook = async () => { const h = await metaAsync(['mail', 'check', '--inject', '--run', r, '--state', s], { META_RUN_ID: r });
      assert.equal(h.status, 0, h.stderr); const got = h.stdout ? ids(JSON.parse(h.stdout).hookSpecificOutput.additionalContext) : []; seen.push(...got); return got; };
    const mcpCheck = async () => { const c = await m.tool('norn_mail', { action: 'check' }); assert.ok(!c.isError, JSON.stringify(c)); const got = c.structuredContent.mail.map(x => x.id); seen.push(...got); return got; };
    const hooks = async () => { for (let k = 0; k < 6; k++) await hook(); };
    const mcp = async () => { for (let k = 0; k < 12; k++) { await mcpCheck(); await new Promise(res => setTimeout(res, 30)); } };
    // Both paths take part by construction, not by the runner's scheduling (CI 43182791620: on a loaded Windows runner the MCP
    // reader took all 24 before the first hook process read): MAIL-1 is swept by a lone hook reader before the race, MAIL-N is
    // sent after it and swept by the MCP reader first. MAIL-2..N-1 are the free race of three hook processes and the MCP reader.
    send(s, 'controller', { from: 'role:controller', to: r, subject: 'm0' });
    assert.deepEqual(await hook(), ['MAIL-1'], 'a lone hook reader delivers the queued mail');
    const sends = (async () => { for (let i = 1; i < N - 1; i++) {
      if (i % 3) send(s, 'controller', { from: 'role:controller', to: r, subject: `m${i}` }); else send(s, 'checkin', { from: 'role:checkin', to: 'lane:demo', subject: `m${i}` });
      await new Promise(res => setTimeout(res, 15)); } })();
    // hooksLate: the hook processes read only after the MCP reader drained the box (the order a loaded runner produced)
    const lagged = async () => { if (hooksLate) { await sends; await mcpCheck(); } await Promise.all([hooks(), hooks(), hooks()]); };
    await Promise.all([sends, lagged(), mcp()]);
    send(s, 'controller', { from: 'role:controller', to: r, subject: `m${N - 1}` });
    // a final sweep from each side picks up the rest: the MCP reader first (it delivers MAIL-N), then a hook reader
    assert.ok((await mcpCheck()).includes(`MAIL-${N}`), 'the MCP reader delivers the mail sent after the race');
    await hook();
    await m.close();
    const all = Array.from({ length: N }, (_, i) => `MAIL-${i + 1}`);
    assert.deepEqual([...seen].sort(), [...all].sort(), 'every mail delivered exactly once across hook + MCP readers');
    const delivers = readEvents(recordsFile(s, 'mail')).filter(e => e.ev === 'deliver');
    assert.equal(delivers.length, N, 'one deliver event per mail');
    assert.ok(delivers.some(e => e.data.via === 'hook') && delivers.some(e => e.data.via === 'mcp'), 'both paths delivered some');
  } finally { fs.writeFileSync(until, ''); }
}
test('KILL CRITERION (e2e): hook readers and an MCP reader racing on a live fake run deliver every mail exactly once', () => mailRace());
// a loaded runner (CI 43182791620, Windows): the hook processes started after the MCP reader had taken all 24 - both paths must still deliver
test('KILL CRITERION (e2e) under load: the hook readers start after the MCP reader drained the box; every mail exactly once, both paths deliver', () => mailRace({ hooksLate: true }));

test('resume in the same session: claude --resume <sid> instead of --session-id; the fake takes --resume + --prompt', async () => {
  const { buildCommand } = await import('../engine/lib/runs.mjs');
  const base = { executor: 'claude', exe: '/x/claude', brief: 'B', worktree: 'W', notes: 'N', model: 'm', effort: 'e', session_id: 'sid-1', lane: 'l' };
  const a = buildCommand({ ...base, resumeSid: 'sid-1', promptText: 'NUDGE x' }).args;
  assert.ok(!a.includes('--session-id'));
  assert.deepEqual(a.slice(a.indexOf('--resume'), a.indexOf('--resume') + 2), ['--resume', 'sid-1']);
  assert.equal(a[a.indexOf('-p') + 1], 'NUDGE x');
  const f = buildCommand({ executor: 'fake', brief: 'B', notes: 'N', resumeSid: 'sid-1', promptText: 'NUDGE x' }).args;
  assert.deepEqual(f.slice(f.indexOf('--resume'), f.indexOf('--resume') + 4), ['--resume', 'sid-1', '--prompt', 'NUDGE x']);
  assert.ok(!buildCommand({ executor: 'fake', brief: 'B', promptText: 'helper q' }).args.includes('--prompt'), 'a helper prompt stays as it was');
});

function liveRun(s, extra = {}, brief = '') {
  const locks = s + '-locks', wt = mkTmp('meta-mail-wt-');
  const until = path.join(wt, 'release'), b = path.join(wt, 'brief.md'), notes = path.join(wt, 'NOTES.md');
  fs.writeFileSync(b, `mode: done\nuntil: ${until}\n${brief}`);
  return { until, notes, wt, spec: { state: s, locksDir: locks, executor: 'fake', lane: 'demo', worktree: wt, brief: b, notes, hbMs: 100, staleMs: 3000, budget: {}, tick: null, ...extra } };
}
const sleep = ms => new Promise(res => setTimeout(res, ms));
const logOf = (s, r) => { try { return fs.readFileSync(loadState(s).items[r].data.log, 'utf8'); } catch { return ''; } };   // the supervisor creates it
async function waitFor(fn, ms = 20000) {
  const t0 = performance.now();   // monotonic: a wall-clock step (the WSL runner, CI 43116967024) never trips the deadline
  for (;;) { const v = fn(); if (v) return v; if (performance.now() - t0 > ms) throw new Error('timeout waiting'); await sleep(50); }
}

test('NUDGE e2e: an urgent unacked mail stops the fake run (outcome nudged) and resumes its session with the mail as the prompt', async () => {
  const { startRun: launch } = await import('../engine/lib/runs.mjs');
  const s = tmp();
  const L = liveRun(s, { policy: { auto_resume_max: 0, mail: { nudge_after_min: 0.005 } } });   // 0.3 s
  const r = launch(L.spec).run;
  try {
    const sid = loadState(s).items[r].data.session_id;
    send(s, 'checkin', { from: 'role:checkin', to: r, urgent: true, subject: 'stop: main moved', body: 'rebase first' });
    const ended = await waitFor(() => { const it = loadState(s).items[r]; return it?.resume && it; });
    assert.equal(ended.state, 'exited');
    assert.equal(ended.end.outcome, 'nudged');
    assert.equal(ended.end.nudge, 'MAIL-1');
    const next = ended.resume.next;
    assert.ok(next, JSON.stringify(ended.resume));
    assert.equal(ended.resume.nudge, 'MAIL-1');
    const nx = await waitFor(() => { const it = loadState(s).items[next]; return it?.state === 'exited' && it; });
    assert.equal(nx.data.resume_of, r);
    assert.equal(nx.data.session_id, sid, 'the same session, resumed');
    assert.equal(nx.data.nudge, 'MAIL-1');
    assert.equal(nx.end.outcome, 'done');
    assert.match(fs.readFileSync(L.notes, 'utf8'), /resumed session .* prompt: NUDGE[\s\S]*stop: main moved/);
    const m = mails(s)['MAIL-1'];
    assert.equal(m.state, 'delivered');
    assert.equal(m.nudge.run, r);
    assert.equal(readEvents(recordsFile(s, 'mail')).filter(e => e.ev === 'nudge' || e.ev === 'deliver').length, 1, 'the nudge is its one delivery');
  } finally { fs.writeFileSync(L.until, ''); }
});

test('NUDGE waits while QUIET exists or the GPU lock is held, then fires; an acked mail never nudges', async () => {
  const { startRun: launch } = await import('../engine/lib/runs.mjs');
  const s = tmp();
  const quiet = path.join(s, 'QUIET'), gpu = path.join(s, 'GPU.lock');
  fs.writeFileSync(quiet, '');
  const L = liveRun(s, { quiet, gpu_lock: gpu, policy: { auto_resume_max: 0, mail: { nudge_after_min: 0.002 } } });
  const r = launch(L.spec).run;
  try {
    send(s, 'controller', { from: 'role:controller', to: r, urgent: true, subject: 'acked in time' });
    rec(s, { kind: 'mail', ev: 'ack', id: 'MAIL-1', by: 'controller', data: {} });
    send(s, 'controller', { from: 'role:controller', to: r, urgent: true, subject: 'urgent' });
    await waitFor(() => /nudge waits: QUIET/.test(logOf(s, r)));
    fs.writeFileSync(gpu, 'someone 2026-11-09\n'); fs.rmSync(quiet);
    await waitFor(() => /nudge waits: GPU lock/.test(logOf(s, r)));
    assert.equal(loadState(s).items[r].state, 'running');
    assert.equal(mails(s)['MAIL-2'].state, 'queued');
    fs.rmSync(gpu);
    const ended = await waitFor(() => { const it = loadState(s).items[r]; return it?.resume && it; });
    assert.equal(ended.end.nudge, 'MAIL-2');
    assert.equal(mails(s)['MAIL-1'].nudge, undefined);
    await waitFor(() => loadState(s).items[ended.resume.next]?.state === 'exited');
  } finally { fs.writeFileSync(L.until, ''); }
});

test('NUDGE then HANDOFF: the HANDOFF auto-resume after a nudged resume starts a FRESH session (no --resume, no mail prompt)', async () => {
  const { startRun: launch } = await import('../engine/lib/runs.mjs');
  const s = tmp();
  const L = liveRun(s, { policy: { auto_resume_max: 1, mail: { nudge_after_min: 0.002 } } }, 'resumed_mode: handoff\n');
  const r = launch(L.spec).run;
  try {
    const sid = loadState(s).items[r].data.session_id;
    send(s, 'controller', { from: 'role:controller', to: r, urgent: true });
    const a = await waitFor(() => loadState(s).items[r]?.resume?.next);
    const b = await waitFor(() => loadState(s).items[a]?.resume?.next);
    fs.writeFileSync(L.until, '');   // the fresh run follows its brief (until), as a new agent would
    const it = await waitFor(() => { const x = loadState(s).items[b]; return x?.state === 'exited' && x; });
    assert.equal(loadState(s).items[a].end.outcome, 'handoff');
    assert.notEqual(it.data.session_id, sid);
    assert.equal(it.data.nudge, undefined);
    assert.equal(it.end.outcome, 'done');
  } finally { fs.writeFileSync(L.until, ''); }
});

test('norn run hands the nudge its inputs: policy mail.nudge_after_min (default 10, a Settings row), the QUIET flag, the project gpu_lock_file', async () => {
  const { main } = await import('../engine/bin/norn.mjs');
  const { POLICY_DEFAULTS, SETTINGS } = await import('../engine/lib/policy.mjs');
  assert.equal(POLICY_DEFAULTS.mail.nudge_after_min, 10);
  const row = SETTINGS.find(x => x.key === 'policy.mail.nudge_after_min');
  assert.ok(row && row.min === 0 && row.recommended === '10', 'a Settings row (0 = off)');
  const d = tmp(), root = d.split(path.sep).join('/');
  fs.writeFileSync(path.join(d, 'b.md'), 'mode: done\n');
  const spec = (pj, n) => {
    const f = path.join(d, `project-${n}.json`), st = path.join(d, `state-${n}`), wt = path.join(d, `wt${n}`);   // one writer per worktree
    fs.mkdirSync(wt);
    fs.writeFileSync(f, JSON.stringify({ schema: 1, name: 'p', title: 'P', root, ...pj }));
    const errs = [];
    const code = main(['run', '--executor', 'fake', '--project', f, '--state', st, '--lane', 'l', '--brief', path.join(d, 'b.md'), '--worktree', wt, '--notes', path.join(d, `n${n}.md`), '--no-tick'],
      { META_ROOT: d }, () => {}, x => errs.push(x));
    assert.equal(code, 0, errs.join('\n'));
    return { st, spec: JSON.parse(fs.readFileSync(path.join(st, 'runs', 'RUN-1.spec.json'), 'utf8')) };
  };
  const a = spec({ gpu_lock_file: `${root}/gpu/GPU.lock`, policy: { mail: { nudge_after_min: 3 } } }, 1);
  assert.equal(a.spec.policy.mail.nudge_after_min, 3);
  assert.equal(a.spec.gpu_lock, `${root}/gpu/GPU.lock`);
  assert.equal(path.resolve(a.spec.quiet), path.resolve(d, '.superpowers', 'QUIET'));
  const b = spec({}, 2);
  assert.equal(b.spec.policy.mail.nudge_after_min, 10);
  assert.equal(b.spec.gpu_lock, undefined);
  for (const x of [a, b]) await waitFor(() => ['exited', 'lost', 'killed'].includes(loadState(x.st).items['RUN-1']?.state));
});

// ---------- piece 4: the gate fact mail:MAIL-n (a reply addressed to the check-in) = a MAJOR wake ----------
test('gate fact mail:MAIL-n: mail to role:checkin wakes the check-in (MAJOR) once; mail to a run and any ack are not news', async () => {
  const { checkinGate, noteCheckin, facts } = await import('../engine/lib/gate.mjs');
  const T0 = Date.parse('2026-11-08T10:00:00Z'), at = min => () => new Date(T0 + min * 60000);
  const s = tmp();
  const R = (e, min, run = null) => record(s, e, { now: at(min), run });
  const checkin = (min, end) => {
    const id = R({ kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'checkin', executor: 'fake', lane: 'checkin' } }, min).id;
    noteCheckin(s, { run: id, start: at(min)().toISOString(), live: {}, budget: {} });
    return { id, end: () => R({ kind: 'run', ev: 'end', id, by: 'launcher', data: { outcome: 'done', exit: 0 } }, end) };
  };
  const gate = min => checkinGate({ state: s, budget: {}, live: {}, now: at(min)() });
  const c1 = checkin(0, 5);
  const w = R({ kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'a' } }, 2, c1.id).id;   // its own dispatch
  c1.end();
  assert.equal(gate(20).run, false, gate(20).why);
  R({ kind: 'mail', ev: 'create', by: 'controller', data: { from: 'role:controller', to: w, subject: 'x', body: 'y' } }, 21);
  assert.equal(gate(22).run, false, "mail to a run is not the check-in's news");
  R({ kind: 'mail', ev: 'create', by: 'worker', data: { from: w, to: 'role:checkin', subject: 'reply', body: 'step 2 done' } }, 30, w);
  const g = gate(31);
  assert.equal(g.run, true); assert.match(g.why, /mail:MAIL-2/); assert.equal(g.cls, 'major');
  assert.ok(facts([], [], { at: T0, mailEvs: readEvents(recordsFile(s, 'mail')) }).has('mail:MAIL-2'));
  // the next check-in saw it and acks it: no self-wake
  const c2 = checkin(40, 45);
  R({ kind: 'mail', ev: 'ack', id: 'MAIL-2', by: 'checkin', data: {} }, 41, c2.id);
  c2.end();
  assert.equal(gate(50).run, false, gate(50).why);
  // a reply the check-in saw, acked later by the controller: the fact going away is not news
  R({ kind: 'mail', ev: 'create', by: 'worker', data: { from: w, to: 'role:checkin', subject: 'again', body: 'b' } }, 51, w);
  assert.equal(gate(52).run, true);
  const c3 = checkin(55, 56); c3.end();
  R({ kind: 'mail', ev: 'ack', id: 'MAIL-3', by: 'controller', data: {} }, 60);
  assert.equal(gate(61).run, false, gate(61).why);
});
