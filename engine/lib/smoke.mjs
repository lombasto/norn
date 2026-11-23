// `norn smoke` (META-GENERAL-DESIGN section 8): an end-to-end check of a fresh install in a temp dir, also run by CI on
// windows / ubuntu / macos. Clone (git clone --depth 1 file://) -> setup --non-interactive --no-scheduler with the example project ->
// records add / answer / apply / supersede -> views vs tests/golden/smoke -> fake run handoff -> auto-resume -> done ->
// second writer refused (exit 3) -> scheduler files (dry, nothing installed) -> dashboard on a random 127.0.0.1 port whose
// /api/strip + /api/agents show the running fake run -> project new / list / remove on a temp repo with a GitHub origin (an
// edited installed agent is kept) -> doctor names an install line for each missing optional tool (META-ONBOARD S5). Sandbox: temp HOME / CLAUDE_CONFIG_DIR (real RUSTUP_HOME / CARGO_HOME), a placeholder `claude` file
// first on PATH (setup needs one; the smoke never starts claude), META_NO_TICK (no check-in is ever launched).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState } from './records.mjs';

const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VIEWS = ['OWNER-QUESTIONS.md', 'DECISIONS-LOG.md', 'DIRECTIVES.md'];
export const normalize = t => t.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?Z/g, '<ts>').replace(/\r\n/g, '\n');
class SmokeError extends Error {}
/** git args to clone the committed HEAD of src into dst: a shallow clone (--depth 1) over file:// - a pack transfer of HEAD's
 *  objects only (smoke needs no history; META-SMOKE-CLONE R1), never hardlinks, so a dst on another filesystem than src (Linux
 *  /tmp on tmpfs or its own partition, a clone on /mnt/c, a second Windows drive) works (OOTB-R2 B-1); --local hardlinks and dies
 *  there, and --no-hardlinks copies the whole, ever-growing object store. */
export function cloneArgs(src, dst) {
  const abs = path.resolve(src).split(path.sep).join('/');
  return ['clone', '--depth', '1', '--quiet', 'file://' + (abs.startsWith('/') ? '' : '/') + abs, dst];
}
export function cloneCommitted(src, dst) {
  execFileSync('git', cloneArgs(src, dst), { stdio: ['ignore', 'ignore', 'pipe'] });
}
const fwdS = p => p.split(path.sep).join('/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(what, fn, ms = 30000) {
  const end = performance.now() + ms;   // monotonic (CLOCK-1)
  for (;;) { const v = fn(); if (v) return v; if (performance.now() > end) throw new SmokeError('timeout waiting for ' + what); await sleep(100); }
}

/** the env of the smoke's sandbox: temp HOME / USERPROFILE / AppData / CLAUDE_CONFIG_DIR / META_ROOT, the placeholder bin first on
 *  PATH. RUSTUP_HOME / CARGO_HOME stay the real ones (rustup and cargo default to <HOME>/.rustup and <HOME>/.cargo, which the temp
 *  home lacks: "rustup has no default toolchain", and setup could not build norn-hook; SMOKE-RUSTUP R1). */
export function sandboxEnv({ home, bin, cfg, root }, base = process.env) {
  const real = base.USERPROFILE || base.HOME || os.homedir();
  const env = { ...base, PATH: bin + path.delimiter + (base.PATH || ''), HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'), META_ROOT: root, META_NO_TICK: '1',
    META_FILL_SAMPLE: '{"free_gb":64,"cpu_pct":0}',   // the fill's resource gate is not under the smoke's test: a busy runner held RUN-2 queued (CI-45087248853)
    RUSTUP_HOME: base.RUSTUP_HOME || path.join(real, '.rustup'), CARGO_HOME: base.CARGO_HOME || path.join(real, '.cargo') };
  for (const k of ['META_STATE', 'META_PROJECT', 'META_ROLE', 'META_RUN_ID', 'NPM_CONFIG_PREFIX', 'npm_config_prefix', 'META_HB_MS']) delete env[k];
  return env;
}

/** o: { out, err, keep, update (re-record the goldens into this repo) } -> exit code */
export async function smoke({ out = s => process.stdout.write(s + '\n'), err = s => process.stderr.write(s + '\n'), keep = false, update = false } = {}) {
  const t0 = Date.now(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-smoke-'));
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
  const ok = (step, detail) => out(`ok ${step} - ${detail} (${secs()} s)`);
  const M = path.join(tmp, 'meta'), home = path.join(tmp, 'home'), bin = path.join(tmp, 'bin'), cfg = path.join(tmp, 'claude');
  let dash = null, holder = null, meta = null;
  try {
    // 1. clone (committed HEAD only - what a user gets)
    cloneCommitted(ENGINE_ROOT, M);
    ok('clone', 'git clone --depth 1 file://');

    // 2. setup in a sandbox
    for (const d of [home, bin, cfg]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
    const env = sandboxEnv({ home, bin, cfg, root: M });
    const cli = path.join(M, 'engine', 'bin', 'norn.mjs'), PJ = path.join(M, 'projects', 'example', 'project.json');
    meta = (args, extra = {}) => {
      const r = spawnSync(process.execPath, [cli, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30000 });
      return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
    };
    const must = (args, extra, code = 0) => {
      const r = meta(args, extra);
      if (r.code !== code) throw new SmokeError(`norn ${args.join(' ')} -> exit ${r.code} (want ${code})\n${r.out}\n${r.err}`);
      return r.out;
    };
    // META-OOTB F-3: setup keeps an existing budget.json, so the smoke's mechanism checks (hand-off -> auto-resume) run with no caps,
    // as before; the starter caps' weekly stop fails closed until usage is calibrated (no STATUS here), which would hold the resume
    fs.mkdirSync(path.join(M, 'local'), { recursive: true }); fs.writeFileSync(path.join(M, 'local', 'budget.json'), '{}\n');
    const su = meta(['setup', '--non-interactive', '--no-scheduler', '--project', PJ]), mf = path.join(M, 'local', 'machine.json');
    // META-ONBOARD S1: a step whose expected file is missing prints what the step said (macOS: exit 0 and no machine.json)
    if (su.code !== 0 || !fs.existsSync(mf)) throw new SmokeError(`setup -> exit ${su.code}, ${mf} ${fs.existsSync(mf) ? 'exists' : 'MISSING'}\nstdout:\n${su.out}\nstderr:\n${su.err}`);
    const machine = JSON.parse(fs.readFileSync(mf, 'utf8'));
    if (!machine.projects.some(p => p.name === 'example')) throw new SmokeError('setup did not register the example project');
    ok('setup', `machine.json written, scheduler kind ${machine.scheduler.kind} (not installed)`);

    // 3. records round trip
    const state = path.join(M, 'state', 'example'), S = { META_STATE: state };
    const rec = (as, ...args) => must(['rec', ...args, '--as', as], S);
    rec('controller', 'add', 'lane', '--name', 'smoke');
    const q = rec('controller', 'add', 'question', '--lane', 'smoke', '--title', 'Pick the smoke colour', '--body', 'Two options; green costs nothing.',
      '--option', 'a|green|none', '--option', 'b|red|one repaint', '--recommend', 'a|cheaper', '--class', 'i', '--blocks', 'smoke');
    rec('owner', 'answer', q, '--choice', 'a', '--text', 'green, as recommended', '--via', 'chat');
    const dec = rec('controller', 'add', 'decision', '--lane', 'smoke', '--question', 'smoke colour', '--choice', 'green', '--why', 'owner answer ' + q,
      '--cost', 'none', '--source', q, '--answers', q);
    rec('controller', 'apply', q, '--refs', dec);
    const d1 = rec('owner', 'add', 'directive', '--text', 'Keep the smoke small.', '--via', 'chat');
    const d2 = rec('owner', 'add', 'directive', '--text', 'Keep the smoke under a minute (supersedes the line above).', '--via', 'dashboard');
    rec('controller', 'supersede', d1, '--by', d2, '--why', 'its own text: supersedes the line above');
    const items = loadState(state).items;
    const want = { [q]: 'applied', [dec]: 'in-force', [d1]: 'superseded', [d2]: 'active' };
    for (const [id, s] of Object.entries(want)) if (items[id]?.state !== s) throw new SmokeError(`${id} is ${items[id]?.state}, want ${s}`);
    ok('records', `${q} applied, ${dec} in-force, ${d1} superseded by ${d2}`);

    // 4. generated views vs goldens (timestamps normalised)
    must(['rec', 'views'], S);
    const gold = path.join(update ? ENGINE_ROOT : M, 'tests', 'golden', 'smoke');
    for (const f of VIEWS) {
      const got = normalize(fs.readFileSync(path.join(state, 'views', f), 'utf8'));
      if (update) { fs.mkdirSync(gold, { recursive: true }); fs.writeFileSync(path.join(gold, f), got); continue; }
      const exp = fs.readFileSync(path.join(gold, f), 'utf8').replace(/\r\n/g, '\n');
      if (got !== exp) throw new SmokeError(`view ${f} differs from tests/golden/smoke/${f}:\n${got}`);
    }
    ok('views', update ? 'goldens re-recorded (review the diff)' : `${VIEWS.length} views = goldens`);

    // 5. fake run: running -> exited handoff -> auto-resumed -> done
    for (const d of ['wt/smoke', 'notes/smoke', 'wt/hold', 'notes/hold']) fs.mkdirSync(path.join(state, d), { recursive: true });
    const brief = path.join(tmp, 'brief-handoff.md');
    fs.writeFileSync(brief, 'mode: handoff-once\nms: 1500\n');
    const started = must(['run', '--executor', 'fake', '--lane', 'smoke', '--stage', 'S1', '--round', '1', '--budget-min', '5', '--brief', brief, '--project', PJ, '--no-tick']);
    const r1 = (started.match(/STARTED (RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+)/) || [])[1];
    if (!r1) throw new SmokeError('no RUN id in: ' + started);
    const run = id => loadState(state).items[id];
    // META-ONBOARD S1: a run that never exits names its record and its supervisor log (the hosted Windows red: RUN-2 never exited)
    const runWait = (id, what, fn) => until(what, fn, 30000).catch(e => {
      const r = run(id), log = r?.data?.log, tail = f => { try { return fs.readFileSync(f, 'utf8').trimEnd().split(/\r?\n/).slice(-30).join('\n'); } catch (x) { return `(${x.code || x.message})`; } };
      const logs = path.join(state, 'logs'), sup = fs.existsSync(logs) ? fs.readdirSync(logs).filter(f => f.includes(id)) : [];
      const prev = r?.data?.resume_of && run(r.data.resume_of)?.data?.log;   // K3: the starter's log says breakaway / inside / plain
      throw new SmokeError(`${e.message}\nrecord ${id}: ${JSON.stringify(r)?.slice(0, 600)}\nlog ${log}:\n${log ? tail(log) : '-'}${sup.map(f => `\n${f}:\n${tail(path.join(logs, f))}`).join('')}${prev ? `\nstarter log ${prev}:\n${tail(prev)}` : ''}`);
    });
    await until(`${r1} running`, () => run(r1)?.state === 'running' || run(r1)?.state === 'exited');
    const seen = run(r1).state;
    await runWait(r1, `${r1} exited`, () => run(r1)?.state === 'exited');
    if (run(r1).end?.outcome !== 'handoff') throw new SmokeError(`${r1} outcome ${run(r1).end?.outcome}, want handoff`);
    ok('run', `${r1} ${seen} -> exited handoff`);
    const next = await until(`auto-resume of ${r1}`, () => Object.values(loadState(state).items).find(i => i.kind === 'run' && i.data.resume_of === r1), 30000);
    await runWait(next.id, `${next.id} exited`, () => run(next.id)?.state === 'exited');
    if (run(next.id).end?.outcome !== 'done') throw new SmokeError(`${next.id} outcome ${run(next.id).end?.outcome}, want done`);
    const hand = run(r1).end?.handoff;
    if (!hand || !fs.existsSync(hand)) throw new SmokeError(`${r1} names no hand-off file (${hand})`);
    ok('auto-resume', `${next.id} (resume_of ${r1}, its hand-off ${path.basename(hand)}) -> done`);

    // 6. second writer in the same worktree is refused (exit 3)
    const hold = path.join(tmp, 'brief-sleep.md'), wt = path.join(state, 'wt', 'hold');
    fs.writeFileSync(hold, 'mode: sleep\nms: 30000\n');
    holder = (must(['run', '--executor', 'fake', '--lane', 'hold', '--worktree', wt, '--brief', hold, '--project', PJ, '--no-tick']).match(/STARTED (RUN-(?:[a-z][a-z0-9]{0,15}-)?\d+)/) || [])[1];
    await until(`${holder} running`, () => run(holder)?.state === 'running');
    const refused = must(['run', '--executor', 'fake', '--lane', 'hold2', '--worktree', wt, '--brief', hold, '--project', PJ, '--no-tick'], {}, 3);
    if (!/REFUSED: worktree .* is held by/.test(refused)) throw new SmokeError('second writer: ' + refused);
    ok('writer', `second writer refused (exit 3) while ${holder} holds the worktree`);

    // 7. scheduler files, dry
    const sched = must(['sched', 'show']);
    if (!sched.includes('=== ') || !/tick/.test(sched)) throw new SmokeError('sched show printed no files: ' + sched.slice(0, 200));
    ok('scheduler', `${machine.scheduler.kind} files generated (dry, nothing installed)`);

    // 8. dashboard on a random port shows the running fake run
    dash = spawn(process.execPath, [cli, 'dash', '--port', '0', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    dash.stdout.on('data', d => { buf += d; }); dash.stderr.on('data', d => { buf += d; });
    const url = (await until('dashboard URL', () => buf.match(/DASH (http:\/\/127\.0\.0\.1:\d+\/)/), 15000))[1];
    const get = async p => { const r = await fetch(url + p); if (r.status !== 200) throw new SmokeError(`GET ${p} -> ${r.status}`); return r.json(); };
    const sp = await get('api/strip?project=example'), ag = await get('api/agents?project=example');
    if (!JSON.stringify(ag).includes(`"${holder}"`)) throw new SmokeError(`/api/agents lacks ${holder}: ${JSON.stringify(ag).slice(0, 300)}`);
    if (!(sp.running?.claude?.n >= 1)) throw new SmokeError(`/api/strip running.claude.n = ${sp.running?.claude?.n}, want >= 1`);
    ok('dashboard', `${url} /api/strip (running ${sp.running.claude.n}) + /api/agents contain ${holder}`);
    must(['stop', holder, '--as', 'owner', '--project', PJ]);
    holder = null;

    // 9. META-ONBOARD: a user's repo with a GitHub origin -> project new -> list -> remove (an edited installed file is kept)
    const repo = path.join(tmp, 'my-app');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/someone/my-app.git'], { cwd: repo });
    const made = must(['project', 'new', '--root', repo, '--non-interactive']);
    const pf = (made.match(/project my-app: OK \((.+)\)$/m) || [])[1];
    if (!pf) throw new SmokeError('project new printed no OK line:\n' + made);
    const pj = JSON.parse(fs.readFileSync(pf, 'utf8'));
    if (pj.ci?.repo !== 'someone/my-app') throw new SmokeError(`project new: ci ${JSON.stringify(pj.ci)}, want someone/my-app`);
    const pd = path.dirname(pf);
    fs.mkdirSync(path.join(pd, 'agents'), { recursive: true });   // project new made it (META-OOTB F-2: the generic role agents)
    fs.writeFileSync(path.join(pd, 'agents', 'my-app-impl.md'), '# impl of ${name}\n'); fs.writeFileSync(path.join(pd, 'agents', 'my-app-plan.md'), '# plan\n');
    fs.writeFileSync(pf, JSON.stringify({ ...pj, install: { agents: '${project_dir}/agents' } }, null, 1));
    must(['project', 'add', pf]);
    const listed = must(['project', 'list']), managed = Number((listed.match(/^my-app .* root ok .* managed (\d+) /m) || [])[1]);
    if (!(managed >= 2)) throw new SmokeError('project list: ' + listed);
    ok('project new', `my-app (ci someone/my-app) written to ${fwdS(pf)}, listed with ${managed} managed files`);
    const edited = path.join(cfg, 'agents', 'my-app-plan.md');
    fs.appendFileSync(edited, 'my own line\n');
    const rm = must(['project', 'remove', 'my-app']);
    if (!rm.includes(`kept ${fwdS(edited)}: edited since install`) || fs.existsSync(path.join(cfg, 'agents', 'my-app-impl.md')) || !fs.existsSync(edited))
      throw new SmokeError('project remove:\n' + rm);
    if (/^my-app /m.test(must(['project', 'list']))) throw new SmokeError('my-app still listed after remove');
    ok('project remove', 'unedited agent deleted, the edited one kept and reported, unregistered');

    // 10. doctor names an install line for every missing optional tool on this OS
    const doc = meta(['doctor']);
    const optNotes = doc.out.split(/\r?\n/).filter(l => /^note \S+ not found \(optional\)/.test(l));
    if (optNotes.some(l => !/ - install: /.test(l))) throw new SmokeError('doctor note without an install line:\n' + doc.out);
    ok('doctor', `exit ${doc.code}, ${optNotes.length} optional tool(s) missing, each with its install line`);
    out(`SMOKE OK ${secs()} s`);
    return 0;
  } catch (e) {
    err(`SMOKE FAILED (${secs()} s): ${e instanceof SmokeError ? e.message : e.stack}`);
    keep = true;
    return 1;
  } finally {
    if (dash) dash.kill();
    if (holder && meta) meta(['stop', holder, '--as', 'owner', '--project', path.join(M, 'projects', 'example', 'project.json')]);
    if (keep) err(`smoke dir kept: ${tmp}`);
    else { await sleep(300); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { err(`note: could not remove ${tmp}`); } }
  }
}
