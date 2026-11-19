// Shared dashboard fixture (S6 tests + S7 UI tests): two projects on temp-dir state, trimmed transcripts, fake platform.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboard } from '../../engine/dash/server.mjs';
import { loadProject } from '../../engine/lib/config.mjs';
import { record } from '../../engine/lib/records.mjs';
import { mkTmp } from './tmp.mjs';
import { watchServer } from './loopwatch.mjs';
export const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE = path.join(HERE, '..', 'engine');
export const FIX = path.join(HERE, 'fixtures', 'agents');
export const SID = '11111111-2222-4333-8444-555555555555';
export const CSID = '01a18ee7-ebab-72f0-8d34-66a0b62f4a01';
export const budget0 = { max_claude_workers: 2, max_codex: 5, max_astra: 5, max_sol: 5, usage_rate_cap_pct_per_h: 0.43, claude_model: 'claude-opus-5-5',
  claude_effort: 'medium', checkin_model: 'claude-opus-5-5', checkin_effort: 'medium', codex_astra_effort: 'xhigh', codex_sol_effort: 'medium',
  calib_pct: 54, cacheR_per_pct: 40900000, weekly_stop_pct: 95, reset: '2026-11-04T08:00 local' };

export function walkFiles(d, out = []) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walkFiles(p, out); else out.push(p); } return out; }

export function projectFile(root, name, extra = {}) {
  const f = path.join(root, 'projects', name + '.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ schema: 1, name, title: name.toUpperCase(), root: path.join(root, 'repo-' + name).replace(/\\/g, '/'),
    ledger: '${root}/progress.md', docs: [{ tab: 'Plan', path: '${root}/PLAN.md' }, { tab: 'Missing', path: '${root}/nope.md' }], policy: { lanes: {} }, ...extra }, null, 2) + '\n');
  fs.mkdirSync(path.join(root, 'repo-' + name), { recursive: true });
  return f;
}

export async function fixture(extra = {}) {
  const root = mkTmp('meta-dash-');
  const pa = loadProject(projectFile(root, 'kestrel', extra.project || {}), { home: root, meta: root });
  const pb = loadProject(projectFile(root, 'other'), { home: root, meta: root });
  fs.writeFileSync(path.join(pa.root, 'progress.md'), Array.from({ length: 30 }, (_, i) => `p${i + 1}`).join('\n') + '\n');
  fs.writeFileSync(path.join(pa.root, 'PLAN.md'), '# Plan\n- step one\n');
  const budgetFile = path.join(root, 'local', 'budget.json');
  fs.mkdirSync(path.dirname(budgetFile), { recursive: true });
  fs.writeFileSync(budgetFile, JSON.stringify(budget0, null, 2) + '\n');
  const projectsDir = path.join(root, 'claude-projects'), codexDir = path.join(root, 'codex-sessions', '2026', '10', '30');
  fs.cpSync(path.join(FIX, 'claude'), path.join(projectsDir, 'C--fx-wt'), { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(FIX, 'codex'))) fs.copyFileSync(path.join(FIX, 'codex', f), path.join(codexDir, f));
  // records: kestrel has a question blocking lane gen, a lane render whose latest run is codex, a STOPPED unreviewed run, DEC + DIR
  const S = pa.state;
  for (const n of ['gen', 'render', 'seabed']) record(S, { kind: 'lane', ev: 'create', by: 'controller', data: { name: n } });
  record(S, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'choose a relief model', lane: 'gen', options: [{ key: 'a', text: 'wait' }, { key: 'b', text: 'go' }], recommend: { key: 'a', why: 'cheap' }, blocks: ['gen'] } });
  record(S, { kind: 'decision', ev: 'create', by: 'controller', data: { lane: 'render', question: 'q', choice: 'c', why: 'w' } });
  record(S, { kind: 'directive', ev: 'create', by: 'owner', data: { text: 'keep going', via: 'chat' } });
  fs.mkdirSync(path.join(S, 'logs'), { recursive: true });
  const log = path.join(S, 'logs', 'seabed.log');
  fs.writeFileSync(log, Array.from({ length: 230 }, (_, i) => `line ${i + 1}`).join('\n'));
  const clog = path.join(S, 'logs', 'render.log');
  fs.writeFileSync(clog, ['OpenAI Codex', '--------', 'model: gpt-5.4', 'reasoning effort: high', `session id: ${CSID}`, '--------'].join('\n'));
  record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'worker', executor: 'claude', lane: 'seabed', log, session_id: SID } });
  record(S, { kind: 'run', ev: 'end', id: 'RUN-1', by: 'launcher', data: { exit: 0, outcome: 'stopped', why: 'red test' } });
  record(S, { kind: 'run', ev: 'start', by: 'launcher', data: { kind: 'codex', executor: 'codex-sol', lane: 'render', log: clog, budget_min: 90 } });
  fs.mkdirSync(path.join(S, 'hb'), { recursive: true }); fs.writeFileSync(path.join(S, 'hb', 'RUN-2.hb'), '{}');
  fs.writeFileSync(path.join(S, 'STATUS.md'), '- since CALIB x: 0.1 % over 1 h = 0.10 %/h vs cap 0.43 -> ok\n- estimated weekly now ~60.0 %\nRATE_OK=1\n');
  record(pb.state, { kind: 'question', ev: 'create', by: 'controller', data: { title: 'other project question', lane: 'x' } });
  const liveUsage = path.join(root, 'live-usage.json');
  fs.writeFileSync(liveUsage, JSON.stringify({ seven_day_pct: 96, at_utc: new Date().toISOString() }));
  const target = path.join(root, 'kestrel-implementer.md'), rules = path.join(root, 'DECISION-RULES.md');
  fs.writeFileSync(target, 'a\nHANDOFF: old <!-- policy:context.implementer -->\nb\n'); fs.writeFileSync(rules, 'D. old <!-- policy:iteration -->\n');
  pa.policy_targets = [target, rules, path.join(root, 'missing.md')];
  const counts = { ticks: 0, asks: 0, intervals: [] };
  const platform = { tick: async () => ({ pid: ++counts.ticks }), setInterval: async m => { counts.intervals.push(m); return { ok: true, interval: 'PT' + m + 'M' }; },
    ask: async () => { counts.asks++; return { result: 'DIRECTIVE: Wait for the owner.\nIt was saved.', usage: {} }; } };
  const quietFile = path.join(root, 'common-rules.txt'); fs.writeFileSync(quietFile, 'QUIET: no GPU while the owner plays\n');
  const app = createDashboard({ projects: [pa, pb], machine: { home: root }, budgetFile, platform, projectsDir, codexDir: path.join(root, 'codex-sessions'),
    liveUsage, quietFile, sessionsDir: path.join(root, 'sessions'), spawnFn: extra.spawnFn, ...(extra.dash || {}) });
  watchServer(app.server);   // META-CI-WORKCLASS R3: a page timeout names when this server received / answered each request
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  // CI-44593815866: one connection per request (agent: false), never a pooled one - this server shares the test's event loop, so a
  // step that stalls it past the server's keep-alive timeout (5 s) left fetch's idle socket due for the server's close: the next request was reset
  const req = (r, o = {}) => new Promise((res, rej) => { const q = http.request(url + r, { agent: false, method: o.method ?? 'GET', headers: o.headers }, x => {
    let t = ''; x.setEncoding('utf8'); x.on('data', c => { t += c; }); x.on('end', () => { try { res({ status: x.statusCode, data: JSON.parse(t) }); } catch (e) { rej(e); } }); x.on('error', rej); });
    q.on('error', rej); q.end(o.body); });
  const get = r => req(r);
  const post = (r, b, headers = {}) => req(r, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dash-token': app.token, ...headers }, body: JSON.stringify(b) });
  return { app, root, pa, pb, url, get, post, counts, budgetFile, target, rules, done: async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
