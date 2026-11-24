// `norn code map [--refresh]` (task NORN-FLOORPLAN-MAP, Code > Map): the project's architecture map drawn by Floorplan, the pinned tool
// of tools/floorplan (manifest tool.json + lock.json). Install: the tag archive checked against the lock's sha256, unpacked, its
// CHECKSUMS.txt checked against the lock and every file it lists against it, then renamed into <meta root>/state/tools/floorplan/<lock
// hash> (never a worktree; the engine never imports it: its scripts run as children and its serve.mjs never runs, so Ask stays off).
// Draw: Floorplan's unattended way (docs/unattended.md, the spike's driver): a clone of the project under <state>/code/map/work at the
// home's HEAD, seeded with the committed, reviewed docs/architecture.json, its workflow.json followed with each model job one read-only
// `claude -p`; the derived index.html + map.json land in <state>/code/map (never committed). A refresh (the tick's on-merge start) is
// metered: its jobs are counted by the scripts first (no model) and one that would pass MAP_REFRESH_MAX_PCT of the plan is skipped with
// one tick-log line. GET /code-map/ serves the file under its own sandboxed CSP (codeMapPage).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { which, resolveShim } from './paths.mjs';
import { readJsonS } from './fsnap.mjs';
import { atomicWrite } from './policy.mjs';
import { fromUsage } from './cost.mjs';
import { toolCache } from './slop/tools.mjs';
import { machineBudgetFile } from './runs.mjs';
import { sha as sha256 } from './views.mjs';
import { tickLog } from './tick.mjs';   // the skip's one line in the tick's own log

const PIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'floorplan');
export const MAP_REFRESH_MAX_PCT = 0.05;
const CALL_W = 0.6e6;   // weighted tokens per model job before a draw measured its own (the spike: 19.34 M over 32 calls)
const CONC = 4, LOCK_STALE_MS = 2 * 3600e3, START_GAP_MS = 10 * 60e3;
export const mapDir = state => path.join(state, 'code', 'map');
const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---- the pinned tool ----
/** tools/floorplan's manifest + lock -> { manifest, lock } */
export function readPin(dir = PIN_DIR) {
  return { manifest: JSON.parse(fs.readFileSync(path.join(dir, 'tool.json'), 'utf8')), lock: JSON.parse(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8')) };
}
/** CHECKSUMS.txt text + the unpacked root -> the files whose sha256 differs or that are missing (by the list's own paths) */
function badSums(root, text) {
  const rows = text.split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => /^([0-9a-f]{64}) [ *](.+)$/.exec(l));
  if (rows.some(r => !r)) throw new Error('CHECKSUMS.txt has a line that is not "<sha256>  <file>"');
  return { n: rows.length, bad: rows.filter(([, h, f]) => { try { return sha256(fs.readFileSync(path.join(root, f))) !== h; } catch { return true; } }).map(r => r[2]) };
}
const fetchSync = url => {   // the one network read: Node's fetch in a child, the bytes back on stdout
  const r = spawnSync(process.execPath, ['-e', 'fetch(process.argv[1]).then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); process.stdout.write(Buffer.from(await r.arrayBuffer())); }).catch(e => { console.error(e.message); process.exit(1); })', url],
    { maxBuffer: 1 << 28, windowsHide: true, timeout: 300000 });
  if (r.status !== 0) throw new Error(`download of ${url} failed: ${String(r.stderr).trim() || r.error?.message}`);
  return r.stdout;
};
/**
 * The Floorplan skill folder, installed on first use into <cache>/floorplan/<first 12 of the lock's sha256>: the archive checked against
 * the lock, unpacked in a fresh folder, CHECKSUMS.txt checked against the lock and every file against it, then renamed into place (a
 * half or refused install never shows as a home). o: { env, pin (readPin()), fetchArchive(url) -> Buffer } -> the skill dir
 */
export function floorplanHome({ env = process.env, pin = readPin(), fetchArchive = fetchSync } = {}) {
  const { manifest: m, lock } = pin, hash = sha256(JSON.stringify(lock)).slice(0, 12), base = path.join(toolCache(env), 'floorplan'), home = path.join(base, hash);
  const skill = path.join(home, m.root, m.skill);
  if (fs.existsSync(path.join(home, 'verified.json'))) return skill;
  const archive = fetchArchive(m.archive), got = sha256(archive);
  if (got !== lock.archive_sha256) throw new Error(`floorplan ${m.version}: archive sha256 ${got} is not the lock's ${lock.archive_sha256} (${m.archive})`);
  const tmp = `${home}.${process.pid}-${Date.now()}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    fs.writeFileSync(path.join(tmp, 'a.tgz'), archive);
    const t = spawnSync('tar', ['-xzf', 'a.tgz'], { cwd: tmp, encoding: 'utf8', windowsHide: true });   // relative: GNU and bsd tar alike
    if (t.status !== 0) throw new Error(`floorplan ${m.version}: tar failed: ${String(t.stderr || t.error?.message).trim()}`);
    fs.rmSync(path.join(tmp, 'a.tgz'));
    const root = path.join(tmp, m.root), sums = fs.readFileSync(path.join(root, 'CHECKSUMS.txt'));
    if (sha256(sums) !== lock.checksums_sha256) throw new Error(`floorplan ${m.version}: CHECKSUMS.txt sha256 ${sha256(sums)} is not the lock's ${lock.checksums_sha256}`);
    const { n, bad } = badSums(root, sums.toString('utf8'));
    if (bad.length) throw new Error(`floorplan ${m.version}: checksum mismatch: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ` (+${bad.length - 5})` : ''}`);
    if (lock.checksums_files !== n) throw new Error(`floorplan ${m.version}: CHECKSUMS.txt lists ${n} files, the lock ${lock.checksums_files}`);
    fs.writeFileSync(path.join(tmp, 'verified.json'), JSON.stringify({ version: m.version, tag: m.tag ?? null, files: n, archive_sha256: got }));
    try { fs.renameSync(tmp, home); } catch (e) { if (!fs.existsSync(path.join(home, 'verified.json'))) throw e; }   // a second install won the race: the same lock
    return skill;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---- the driver: workflow.json followed, adapted from Floorplan's tests/unattended.test.mjs (as the spike's driver/drive.mjs) ----
const tryJson = s => { try { return JSON.parse(s); } catch { return undefined; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
function validate(schema, value, at = '$') {
  const t = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
  if (schema.type && ![].concat(schema.type).some(x => x === t || (x === 'number' && t === 'integer'))) return [`${at}: expected ${schema.type}, got ${t}`];
  const errs = [];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (t === 'string') { if (schema.minLength && value.length < schema.minLength) errs.push(`${at}: too short`); if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${at}: doesn't match ${schema.pattern}`); }
  if (t === 'array') { if (schema.minItems && value.length < schema.minItems) errs.push(`${at}: needs at least ${schema.minItems} item(s)`); if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`))); }
  if (t === 'object') {
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${at}: missing "${k}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected "${k}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errs.push(...validate(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  return errs;
}
function changedOutside(was, answer, fields) {
  const blank = doc => { const c = structuredClone(doc); for (const f of fields) { const m = /^(\w+)\[\]\.(\w+)$/.exec(f); if (m && Array.isArray(c[m[1]])) for (const it of c[m[1]]) if (it && typeof it === 'object') delete it[m[2]]; } return c; };
  const a = blank(was), b = blank(answer), p = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) p.push(`"${k}" changed, but only ${fields.join(', ')} may change`);
  return p;
}
/** the default model job: one `claude -p` in the work clone, read-only tools, no MCP, no user settings, the job's schema -> { answer, usage } */
export function claudeAsk(root) {
  return (prompt, schema, label) => new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep', '--permission-mode', 'dontAsk', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project', '--json-schema', JSON.stringify(schema, (k, v) => (k === '$schema' ? undefined : v))];
    const exe = which('claude');
    if (!exe) return reject(new Error('claude not found on PATH: the map\'s model jobs cannot run'));
    const s = resolveShim(exe, args), p = spawn(s.exe, s.args, { cwd: root, env: { ...process.env, FLOORPLAN_NO_PROMPTS: '1' }, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d)); p.on('error', reject);
    p.on('close', code => {
      const j = tryJson(out) || {};
      if (code !== 0 && !j.structured_output && !j.result) return reject(new Error(`claude ${label} failed (${code}): ${err.slice(0, 300)} ${out.slice(0, 300)}`));
      resolve({ answer: j.structured_output ?? tryJson(String(j.result || '').replace(/^```(json)?\s*|\s*```$/g, '')), usage: j.usage ?? {} });
    });
    p.stdin.end(prompt);
  });
}
/**
 * One Floorplan workflow run in root: { skill, root, ask(prompt, schema, label) -> { answer, usage }, conc, log, seeded (architecture.json
 * is the reviewed seed: the first map builds it before the architecture job, which then runs only when that build fails its check) }
 * -> { workflow, done, calls, tokens: fromUsage sums }
 */
export async function runWorkflow({ skill, root, ask, conc = CONC, log = () => {}, seeded = false }) {
  const W = JSON.parse(fs.readFileSync(path.join(skill, 'workflow.json'), 'utf8')), env = { ...process.env, ...W.conventions.environment, FLOORPLAN_NO_PROMPTS: '1' };
  const results = {}, tokens = { cache_read: 0, cache_create: 0, input: 0, output: 0, weighted: 0 };
  let calls = 0;
  const get = (p, scope) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), { ...results, ...scope });
  const holds = (conds, scope) => conds.every(c => { const v = get(c.path, scope); if (v === undefined) return false;
    return { equals: v === c.value, notEquals: v !== c.value, lessThan: v < c.value, atMost: v <= c.value, greaterThan: v > c.value, in: c.value?.includes?.(v) }[c.op]; });
  const fill = (s, scope) => s.replace(/\{([\w.]+)\}/g, (m, p) => (p === 'now' ? new Date().toISOString() : String(get(p, scope))));
  const fillDeep = (v, scope) => JSON.parse(JSON.stringify(v), (k, x) => (typeof x === 'string' ? fill(x, scope) : x));
  const stepsOf = n => W.procedures[n] || W.workflows[n]?.steps;
  const runScript = step => {
    let r;
    try { const out = execFileSync(process.execPath, [path.join(skill, 'scripts', step.run), root, ...step.args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 1 << 28, windowsHide: true }); r = { code: 0, out, json: tryJson(out) }; }
    catch (e) { if (e.status == null) throw e; r = { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || ''), json: tryJson(String(e.stdout || '')) }; }
    log(`run ${step.run} -> ${r.code}`);
    if (!r.json) throw new Error(`${step.run}: no JSON. ${r.out.slice(0, 300)} ${String(r.err ?? '').slice(0, 300)}`);
    if (r.code !== 0 && !step.allowFailure) throw new Error(`step ${step.id} (${step.run}) exit ${r.code}: ${JSON.stringify(r.json.errors)}`);
    if (step.save) results[step.save] = r.json;
    for (const [n, f] of Object.entries(step.saveFields || {})) results[n] = r.json[f];
    return r.json;
  };
  const NOTE = 'Tools: your read_file, list_files and grep tools are Read, Glob and Grep here (read-only, inside the codebase root, which is the current directory). There is no submit tool: your final structured output IS the answer; it must match the schema exactly. Do not read anything under floorplan/ except the inputs given below.';
  const runJob = async (name, scope) => {
    const job = W.jobs[name], refs = job.read.map(r => `### ${r}\n\n${fs.readFileSync(path.join(skill, r), 'utf8')}`).join('\n\n'), inputs = [];
    for (const inp of job.input) {
      let v; if (inp.from) v = get(inp.from, scope); else { const f = path.join(root, fill(inp.file, scope)); v = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined; }
      if (v === undefined) { if (!inp.optional) throw new Error(`job ${name}: input ${inp.name} missing`); continue; }
      inputs.push(`### ${inp.name}\n\n${typeof v === 'string' ? v : JSON.stringify(v, null, 1)}`);
    }
    const schema = W.schemas[job.schema], instr = Array.isArray(job.instructions) ? job.instructions.join('\n\n') : job.instructions;
    const base = `${instr}\n\n${NOTE} Suggested budget: about ${job.toolCalls} tool calls.\n\n## Reference files\n\n${refs}\n\n## Inputs\n\n${inputs.join('\n\n')}`;
    const was = job.onlyChange ? JSON.parse(fs.readFileSync(path.join(root, fill(job.onlyChange.file, scope)), 'utf8')) : null;
    const label = `${name}${scope.worksheet ? ':' + scope.worksheet.key : scope.item ? ':' + scope.item.code : ''}`;
    let answer, problems = [];
    for (let a = 0; ; a++) {
      const prompt = problems.length ? `${base}\n\n## Your previous answer was sent back\n\nProblems:\n- ${problems.join('\n- ')}\n\nPrevious answer:\n${JSON.stringify(answer)}` : base;
      const r = await ask(prompt, schema, `${label}#${a}`);
      calls++; const u = fromUsage(r.usage); for (const k of Object.keys(tokens)) tokens[k] += u[k];
      answer = r.answer;
      problems = answer && typeof answer === 'object' ? [...validate(schema, answer), ...(was ? changedOutside(was, answer, job.onlyChange.fields) : [])] : ['no JSON object answer'];
      if (!problems.length) break;
      log(`job ${label}: sent back (${problems.length}): ${problems.slice(0, 3).join('; ')}`);
      if (a >= W.conventions.answerRetries) throw new Error(`job ${label} gave no valid answer`);
    }
    Object.assign(answer, fillDeep(job.set || {}, scope));
    writeJson(path.join(root, fill(job.writes, scope)), answer);
  };
  const pool = async (items, n, fn) => { const q = [...items]; await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); })); };
  const runStep = async (step, scope) => {
    if (step.when && !holds(step.when, scope)) { log(`skip ${step.id}`); return; }
    if (!step.optional) return runRequired(step, scope);
    const kept = (step.restore || []).map(p => { const f = path.join(root, fill(p, scope)); return [f, fs.existsSync(f) ? fs.readFileSync(f) : null]; });
    try { await runRequired(step, scope); } catch (e) {
      for (const [f, d] of kept) { if (d == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, d); }
      log(`optional ${step.id} failed (${e.message}); restored`);
      for (const s of step.onFail || []) await runStep(s, scope);
    }
  };
  const runRequired = async (step, scope) => {
    if (step.run) return void runScript(step);
    if (step.job) { if (!step.forEach) return runJob(step.job, scope); return pool(get(step.forEach, scope) || [], step.parallel ? conc : 1, it => runJob(step.job, { ...scope, [step.as]: it })); }
    if (step.write) { writeJson(path.join(root, fill(step.write, scope)), fillDeep(step.value, scope)); log(`write ${step.write}`); return; }
    if (step.repeat) {
      // the seed: its own build first, so the repeat's until holds before a model ever rewrites the reviewed architecture.json
      if (seeded && step.id === 'architecture') { const b = step.repeat.find(s => s.run === 'build.mjs'); if (b) runScript({ ...b, allowFailure: true }); }
      for (let i = 0; ; i++) { if (i >= (step.minAttempts || 0) && holds(step.until, scope)) return; if (i >= step.maxAttempts) throw new Error(`${step.id}: ${step.failMessage}`); for (const s of step.repeat) await runStep(s, scope); }
    }
    if (step.use) { for (const s of stepsOf(step.use)) await runStep(s, scope); return; }
    if (step.next) {
      for (const item of get(step.next, scope) || []) { const h = step.handlers[item.code]; if (!h) throw new Error(`no handler for NEXT ${item.code}`); if (h.fail) throw new Error(h.fail); if (h.skip) continue; log(`next ${item.code}`); for (const s of stepsOf(h)) await runStep(s, { ...scope, item }); }
      return;
    }
    throw new Error(`unknown step ${JSON.stringify(step)}`);
  };
  runScript({ id: 'start', ...W.start });
  const pick = W.start.choose.find(c => holds(c.when, {}));
  if (!pick || pick.fail) throw new Error(`start: ${pick?.fail || 'no workflow'}`);
  log(`workflow ${pick.workflow}`);
  const wf = W.workflows[pick.workflow];
  for (const s of wf.steps) await runStep(s, {});
  return { workflow: pick.workflow, done: holds(wf.done, {}), calls, tokens };
}

/** the model jobs a refresh would run, counted by the scripts alone (refresh.mjs, then describe.mjs for its describe item) -> n */
function refreshJobs(skill, root) {
  const W = JSON.parse(fs.readFileSync(path.join(skill, 'workflow.json'), 'utf8')), env = { ...process.env, ...W.conventions.environment, FLOORPLAN_NO_PROMPTS: '1' };
  const run = (s, args) => { try { return tryJson(execFileSync(process.execPath, [path.join(skill, 'scripts', s), root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env, maxBuffer: 1 << 28, windowsHide: true })); }
    catch (e) { if (e.status == null) throw e; return tryJson(String(e.stdout || '')); } };
  const r = run('refresh.mjs', ['--json']);
  if (!r) throw new Error('refresh.mjs gave no JSON');
  return (r.next || []).reduce((n, x) => n + (x.code === 'describe' ? (run('describe.mjs', ['--json'])?.worksheets?.length ?? 0) : x.code === 'blueprint' ? 0 : 1), 0);
}

// ---- the map's own CSP ----
const META = /<meta http-equiv="Content-Security-Policy"[^>]*\bcontent="([^"]*)"/i;
/** the map's meta policy -> the /code-map/ header: that policy, no network (connect-src 'none'), no forms or base, framed only by the
 *  dashboard, sandboxed with scripts only (an opaque origin: no dashboard cookie, token or API) */
export function mapCsp(meta) {
  const d = new Map(String(meta).split(';').map(s => s.trim()).filter(Boolean).map(s => { const i = s.search(/\s/); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1).trim()]; }));
  if (!d.has('default-src')) d.set('default-src', "'none'");
  for (const [k, v] of [['connect-src', "'none'"], ['form-action', "'none'"], ['base-uri', "'none'"], ['frame-ancestors', "'self'"], ['sandbox', 'allow-scripts']]) { d.delete(k); d.set(k, v); }
  return [...d].map(([k, v]) => (v ? `${k} ${v}` : k)).join('; ');
}

// ---- the draw ----
/**
 * Draw or refresh the map. o: { state, repo (the project home), refresh (the metered tick path: only an existing map, skipped over
 * MAP_REFRESH_MAX_PCT), skill (floorplanHome()), ask (claudeAsk), budget (the machine budget: cacheR_per_pct), env, log }
 * -> { drawn, sha, skipped?, why?, file? }; a failed workflow throws (the map on disk stays as it was)
 */
export async function drawMap({ state, repo, refresh = false, skill, ask, budget, env = process.env, log } = {}) {
  const dir = mapDir(state), work = path.join(dir, 'work'), mapFile = path.join(dir, 'map.json'), lock = path.join(dir, 'draw.lock');
  fs.mkdirSync(dir, { recursive: true });
  const say = log ?? (s => { try { fs.appendFileSync(path.join(dir, 'draw.log'), `${new Date().toISOString()} ${s}\n`); } catch { /* log only */ } });
  try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }); } catch { /* no lock */ }
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch { return { drawn: false, why: 'a map draw is already running' }; }
  try {
    const prev = readJsonS(mapFile), head = git(repo, ['rev-parse', '--short=12', 'HEAD']), full = git(repo, ['rev-parse', 'HEAD']);
    if (refresh && !prev?.sha) return { drawn: false, why: 'no map yet: `norn code map` draws the first one' };
    if (refresh && prev.sha === head) return { drawn: false, sha: head, why: `the map is at ${head}` };
    const skip = why => { atomicWrite(mapFile, JSON.stringify({ ...prev, skipped: { at: new Date().toISOString(), sha: head, why } }));
      tickLog(state, `code map: refresh skipped at ${head}: ${why}; \`norn code map\` draws it`); return { drawn: false, sha: head, skipped: why }; };
    const per = Number((budget ?? readJsonS(machineBudgetFile(env)) ?? {}).cacheR_per_pct);
    if (refresh && !(per > 0)) return skip('no plan calibration (budget cacheR_per_pct) to meter it by');
    skill ??= floorplanHome({ env });
    if (!fs.existsSync(path.join(work, '.git'))) git(dir, ['clone', '-q', '--no-checkout', '-c', 'core.longpaths=true', repo, 'work']);   // a deep state dir + deep fixtures pass 260 on Windows
    git(work, ['fetch', '-q', 'origin', 'HEAD']); git(work, ['checkout', '-q', '-f', '--detach', full]);
    const fp = path.join(work, 'floorplan'), seedFile = path.join(work, 'docs', 'architecture.json'), seed = fs.existsSync(seedFile) ? sha256(fs.readFileSync(seedFile)) : null;
    const first = !fs.existsSync(path.join(fp, 'index.html'));
    if (seed && (first || seed !== prev?.seed)) { fs.mkdirSync(fp, { recursive: true }); fs.copyFileSync(seedFile, path.join(fp, 'architecture.json')); }
    if (refresh) {   // the meter: the scripts count the jobs (no model) on a copy of the map's folder, put back before the real run
      const keep = path.join(dir, 'floorplan.before');
      fs.rmSync(keep, { recursive: true, force: true }); fs.cpSync(fp, keep, { recursive: true });
      let jobs;
      try { jobs = refreshJobs(skill, work); } finally { fs.rmSync(fp, { recursive: true, force: true }); fs.renameSync(keep, fp); }
      const pct = jobs * (prev.calls ? prev.weighted / prev.calls : CALL_W) / per;
      say(`refresh at ${head}: ${jobs} model jobs, ~${pct.toFixed(3)} % of plan`);
      if (pct > MAP_REFRESH_MAX_PCT) return skip(`~${+pct.toFixed(3)} % > ${MAP_REFRESH_MAX_PCT} % of plan (${jobs} model jobs)`);
    }
    const t0 = Date.now(), r = await runWorkflow({ skill, root: work, ask: ask ?? claudeAsk(work), log: say, seeded: Boolean(seed) });
    if (!r.done) throw new Error(`floorplan ${r.workflow} ended without a clean build (see ${path.join(dir, 'draw.log')})`);
    const html = fs.readFileSync(path.join(fp, 'index.html')), out = path.join(dir, 'index.html');
    fs.writeFileSync(`${out}.tmp`, html); fs.renameSync(`${out}.tmp`, out);
    const tool = JSON.parse(fs.readFileSync(path.join(skill, '..', '..', '..', 'verified.json'), 'utf8')).version;
    const m = { at: new Date().toISOString(), sha: head, tool, workflow: r.workflow, seed, calls: r.calls, weighted: r.tokens.weighted, tokens: r.tokens,
      pct: per > 0 ? r.tokens.weighted / per : null, ms: Date.now() - t0, bytes: html.length, etag: `"${sha256(html).slice(0, 16)}"`, csp: META.exec(html.toString('utf8'))?.[1] ?? '', skipped: null };
    atomicWrite(mapFile, JSON.stringify(m));
    say(`drew ${r.workflow} at ${head}: ${r.calls} model jobs, ${Math.round(r.tokens.weighted)} weighted tokens`);
    return { drawn: true, sha: head, file: out, workflow: r.workflow, calls: r.calls, pct: m.pct };
  } finally { fs.rmSync(lock, { force: true }); }
}

/** the /api/code map part: what is drawn (null = no map yet) */
export function mapAt(state) {
  const m = readJsonS(path.join(mapDir(state), 'map.json'));
  return m?.sha ? { at: m.at, sha: m.sha, tool: m.tool, workflow: m.workflow, calls: m.calls, pct: m.pct, bytes: m.bytes, skipped: m.skipped ?? null } : null;
}
/** GET /code-map/: the drawn index.html under its own CSP, revalidated by ETag (the file is ~3 MB) -> { status, headers, body } */
export function codeMapPage(state, ifNoneMatch) {
  const m = readJsonS(path.join(mapDir(state), 'map.json')), file = path.join(mapDir(state), 'index.html');
  if (!m?.sha || !fs.existsSync(file)) return { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'No map yet: `norn code map` draws it.' };
  const headers = { 'content-type': 'text/html; charset=utf-8', 'Content-Security-Policy': mapCsp(m.csp), 'Cache-Control': 'no-cache', ETag: m.etag };
  if (ifNoneMatch && ifNoneMatch === m.etag) return { status: 304, headers, body: '' };
  return { status: 200, headers, body: fs.readFileSync(file) };
}

/** the tick's on-merge start: `norn code map --refresh` detached when HEAD moved past the drawn map, once per sha (the mark holds the
 *  sha tried and when); no map yet = nothing (the first map is the owner's) -> the tick-log words | null */
export function tickMap(p, state, { metaCmd, spawnFn, head, now = Date.now() } = {}) {
  const m = readJsonS(path.join(mapDir(state), 'map.json'));
  if (!m?.sha || !head || head === m.sha || head === m.skipped?.sha) return null;
  const mark = path.join(mapDir(state), 'refresh.started'), [was, at] = (() => { try { return fs.readFileSync(mark, 'utf8').split(' '); } catch { return []; } })();
  if (was === head || now - Number(at) < START_GAP_MS) return null;
  fs.writeFileSync(mark, `${head} ${now}`);
  const args = [metaCmd, 'code', 'map', '--refresh', '--project', p.file, '--state', state];
  let r = spawnFn ? spawnFn(process.execPath, args) : null;
  if (!r) { const c = spawn(process.execPath, args, { cwd: p.root, detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); r = { pid: c.pid }; }
  return `code map: refresh started pid ${r?.pid ?? '?'}`;
}
