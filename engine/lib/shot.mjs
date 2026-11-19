// META-SHOT R1: `norn shot` - the ONE way a Norn worker takes a browser screenshot or walks the dashboard. A worker that starts
// Edge by hand with a fresh profile can be signed into the owner's Microsoft account by Edge itself (RUN-454, 11-13: implicit
// sign-in, sync on). Safe by construction: a temp --user-data-dir (deleted after), private mode, no first run, sync and the
// implicit / web-to-browser sign-in features off, every host but 127.0.0.1 and the given URL's unresolvable, page requests to
// another origin failed, and the browser's own process tree killed on exit. DevTools protocol over node's built-in WebSocket:
// no npm dependency.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { listProcs } from './strays.mjs';

export class ShotError extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }

/** the browsers per OS, first found wins: data rows (Windows: env-relative; macOS: app bundles; Linux: names on PATH) */
export const BROWSERS = [
  { os: 'win32', kind: 'edge', path: '%ProgramFiles(x86)%/Microsoft/Edge/Application/msedge.exe' },
  { os: 'win32', kind: 'edge', path: '%ProgramFiles%/Microsoft/Edge/Application/msedge.exe' },
  { os: 'win32', kind: 'chrome', path: '%ProgramFiles%/Google/Chrome/Application/chrome.exe' },
  { os: 'win32', kind: 'chrome', path: '%ProgramFiles(x86)%/Google/Chrome/Application/chrome.exe' },
  { os: 'win32', kind: 'chrome', path: '%LOCALAPPDATA%/Google/Chrome/Application/chrome.exe' },
  { os: 'win32', kind: 'chromium', path: '%LOCALAPPDATA%/Chromium/Application/chrome.exe' },
  { os: 'darwin', kind: 'edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  { os: 'darwin', kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { os: 'darwin', kind: 'chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
  { os: 'linux', kind: 'edge', path: 'microsoft-edge' },
  { os: 'linux', kind: 'edge', path: 'microsoft-edge-stable' },
  { os: 'linux', kind: 'chrome', path: 'google-chrome' },
  { os: 'linux', kind: 'chrome', path: 'google-chrome-stable' },
  { os: 'linux', kind: 'chromium', path: 'chromium' },
  { os: 'linux', kind: 'chromium', path: 'chromium-browser' },
];

const expand = (p, env) => p.replace(/%([^%]+)%/g, (m, k) => {
  const hit = Object.keys(env).find(x => x.toLowerCase() === k.toLowerCase());
  return hit ? env[hit] : m;
});
const onPath = (name, env, exists) => {
  const key = Object.keys(env).find(x => x.toLowerCase() === 'path');
  for (const d of String(key ? env[key] : '').split(path.delimiter).filter(Boolean)) { const f = path.join(d, name); if (exists(f)) return f; }
  return null;
};

/** { kind, exe } of the first installed browser for platform, or null */
export function findBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  for (const r of BROWSERS.filter(b => b.os === platform)) {
    if (r.path.includes('/') || r.path.includes('%')) { const f = expand(r.path, env); if (!f.includes('%') && exists(f)) return { kind: r.kind, exe: f }; }
    else { const f = onPath(r.path, env, exists); if (f) return { kind: r.kind, exe: f }; }
  }
  return null;
}
/** the kind of a browser named by --browser: edge by its file name, else chrome-family flags */
export const kindOf = exe => /msedge|microsoft[ -]edge/i.test(path.basename(exe)) ? 'edge' : 'chrome';

// Edge's own sign-in features (names from msedge.dll 157): msImplicitSignin signs a new profile in with the Windows account
export const EDGE_SIGNIN_FEATURES = ['msImplicitSignin', 'msSeamlessWebToBrowserSignIn', 'msEnableWebToBrowserSignIn', 'msEnableAADWebToBrowserSignIn', 'msQuickAuthToBrowserSignIn'];

/** the browser command line (golden-tested per OS row). hosts: the hostnames that may resolve besides 127.0.0.1 */
export function browserArgs({ kind, profile, size = [1440, 900], hosts = [] }) {
  const resolve = ['MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1', ...hosts.filter(h => h && h !== '127.0.0.1').map(h => `EXCLUDE ${h}`)].join(', ');
  return [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    kind === 'edge' ? '--inprivate' : '--incognito',
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--metrics-recording-only', '--no-pings',
    ...(kind === 'edge' ? [`--disable-features=${EDGE_SIGNIN_FEATURES.join(',')}`] : []),
    `--host-resolver-rules=${resolve}`, `--window-size=${size[0]},${size[1]}`, 'about:blank',
  ];
}

/** may the browser load url? 127.0.0.1, file:, about:/data:/blob:, or the given URL's origin */
/** the browser's env. Windows: its own USERPROFILE <profile>/home with AppData/Local + Roaming - Edge resolves the LocalAppData
 * known folder under USERPROFILE and, in a sandbox USERPROFILE without it, never brings DevTools up ("Unable to get local app data path") */
export function browserEnv({ profile, env = process.env, platform = process.platform }) {
  if (platform !== 'win32') return env;
  const home = path.join(profile, 'home');
  for (const d of ['Local', 'Roaming']) fs.mkdirSync(path.join(home, 'AppData', d), { recursive: true });
  const key = Object.keys(env).find(k => k.toUpperCase() === 'USERPROFILE') || 'USERPROFILE';
  return { ...env, [key]: home };
}
/** the browser's stderr, kept in its temp profile: a browser that never brings DevTools up says why there (CI-RED-702D70D) */
export const STDERR_LOG = 'browser-stderr.log';
/** start the browser on the temp profile: the ONE launch path (norn shot and the dashboard browser tests) */
export function launchBrowser({ browser, profile, size, hosts = [], platform = process.platform, env = process.env }) {
  const err = fs.openSync(path.join(profile, STDERR_LOG), 'a');
  try {
    return spawn(browser.exe, [...(browser.prefix || []), ...browserArgs({ kind: browser.kind, profile, size, hosts })],
      { stdio: ['ignore', 'ignore', err], detached: platform !== 'win32', windowsHide: true, env: browserEnv({ profile, env, platform }) });
  } finally { fs.closeSync(err); }
}
/** the last lines of the browser's stderr (at most chars), '' when it wrote none */
export function stderrTail(profile, chars = 1500) {
  let s = ''; try { s = fs.readFileSync(path.join(profile, STDERR_LOG), 'utf8'); } catch { return ''; }
  s = s.trimEnd();
  return s.length <= chars ? s : s.slice(s.indexOf('\n', s.length - chars) + 1 || s.length - chars);
}
/** a known cause named from the browser's stderr, '' when none: Chromium's Linux SUID sandbox helper not root-owned mode 4755
 * (setuid_sandbox_host.cc aborts rather than run unsandboxed; https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md) */
export function stderrHint(stderr) {
  const m = /SUID sandbox helper binary was found, but is not configured correctly[\s\S]*?make sure that (\S+) is owned by root and has mode 4755/.exec(stderr || '');
  return m ? `SUID sandbox misconfigured: ${m[1]} (must be owned by root, mode 4755)` : '';
}
/** Chromium's own fatal log line ("[pid:tid:date:FATAL:file.cc:line] ..."): the browser gave up, whether or not its process (a
 * wrapper script, the crashpad handler) exits. ERROR / WARNING lines are routine noise on a headless Linux runner. */
export const fatalLine = stderr => /^\[[^\]\n]*:FATAL:[^\]\n]*\].*$/m.exec(stderr || '')?.[0] ?? '';
/** wait for the DevTools port the browser writes into its profile; none within ms (or a failing exit first: Edge's Windows launcher
 * hands off and exits 0; or a FATAL line on its stderr: CI 43999056272, the SUID abort with the process still alive) = an Error
 * naming the binary, its exit and the tail of its stderr. The caller ends the browser (closeBrowser): it may still run. */
export async function waitDevToolsPort({ browser, profile, child, ms = 30000, fatalGraceMs = 2000 }) {
  const end = Date.now() + ms;
  let fatalAt = null;   // a FATAL of a child process (GPU) the browser survives: the port may still come within the grace
  for (;;) {
    try { const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); if (port) return port; } catch { /* not yet */ }
    const failed = child && child.exitCode !== null && child.exitCode !== 0;
    if (!failed && fatalAt === null && fatalLine(stderrTail(profile, Infinity))) fatalAt = Date.now();
    const fatal = !failed && fatalAt !== null && Date.now() - fatalAt >= fatalGraceMs;
    if (failed || fatal || Date.now() > end) {
      const how = failed ? `exit ${child.exitCode}` : fatal ? 'FATAL on stderr, still running' : `no exit, ${Math.round(ms / 1000)} s`;
      const tail = stderrTail(profile), hint = stderrHint(stderrTail(profile, Infinity));
      throw new Error(`no DevTools port from ${browser.exe} (${how})${hint ? `: ${hint}` : ''}; its stderr ${tail ? `ends:\n${tail}` : 'is empty'}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }
}

export function allowedUrl(url, origin) {
  let u; try { u = new URL(url); } catch { return false; }
  if (['about:', 'data:', 'blob:', 'file:'].includes(u.protocol)) return true;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return false;
  if (u.hostname === '127.0.0.1') return true;
  if (!origin) return false;
  const o = new URL(origin), wsAlias = { 'ws:': 'http:', 'wss:': 'https:' }[u.protocol] || u.protocol;
  return o.protocol === wsAlias && o.host === u.host;
}

export const PHONE = [390, 844];
export const STEP_KEYS = ['go', 'size', 'shot', 'click', 'type', 'wait', 'text'];
/** the steps, checked before any browser starts: known keys only, every go inside the allowed origins */
export function checkSteps(steps, origin) {
  if (!Array.isArray(steps)) throw new ShotError('--steps must be a JSON array of steps (' + STEP_KEYS.join(' / ') + ')');
  steps.forEach((s, i) => {
    const k = s && typeof s === 'object' ? Object.keys(s).filter(x => STEP_KEYS.includes(x)) : [];
    if (!k.length) throw new ShotError(`step ${i + 1}: needs one of ${STEP_KEYS.join(' / ')}`);
    if (s.go !== undefined && !allowedUrl(s.go, origin)) throw new ShotError(`step ${i + 1}: refused navigation to ${s.go} (only 127.0.0.1, file: and ${origin || 'the given URL'}'s origin)`);
    if (s.size !== undefined && !(Array.isArray(s.size) && s.size.length >= 2 && s.size.slice(0, 2).every(n => Number.isInteger(n) && n > 0))) throw new ShotError(`step ${i + 1}: size is [width, height, mobile?]`);
    if (s.type !== undefined && !(Array.isArray(s.type) && s.type.length === 2)) throw new ShotError(`step ${i + 1}: type is [selector, text]`);
  });
  return steps;
}
export function parseSize(s) {
  const m = /^(\d+)x(\d+)$/.exec(String(s || ''));
  if (!m || +m[1] < 1 || +m[2] < 1) throw new ShotError(`--size wants WIDTHxHEIGHT (e.g. 1440x900), got ${s}`);
  return [+m[1], +m[2]];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new ShotError(`timed out waiting for ${what}`, 1); await sleep(100); }
}

/** gone = no such process (ESRCH): a killed process stays visible until its parent (or, orphaned, init) reaps it */
const exists = (pid, probe = p => process.kill(p, 0)) => { try { probe(pid); return true; } catch (e) { return e.code !== 'ESRCH'; } };
/** kill the browser's whole process tree (Windows: taskkill /T; else its process group) and wait for its exit - outside Windows
 * for the whole group's: the leader's exit says nothing of its children, which an init reaps on its own time */
export async function killTree(child, platform = process.platform, { probe } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise(r => child.once('exit', r)), end = Date.now() + 10000;
  try {
    if (platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  await Promise.race([gone, new Promise(r => setTimeout(r, 10000).unref())]);
  if (platform !== 'win32') while (exists(-child.pid, probe) && Date.now() < end) await sleep(50);
}
/** kill every process whose command line names the (unique) temp profile: the browser a launcher handed off is outside its tree.
 * Their descendants too: a browser child need not name the profile, and outside Windows (libuv's kill-on-close job) it outlives its parent */
export async function killProfileProcs(profile, { platform = process.platform, list = listProcs, kill = pid => process.kill(pid, 'SIGKILL'), probe } = {}) {
  const norm = s => String(s || '').replace(/\\/g, '/').toLowerCase(), key = norm(profile);
  const mine = () => {
    const all = list({ platform }).filter(p => p.pid !== process.pid);
    const hit = new Set(all.filter(p => norm(p.cmd).includes(key)).map(p => p.pid));
    for (let grew = true; grew;) { grew = false; for (const p of all) if (!hit.has(p.pid) && hit.has(p.ppid)) { hit.add(p.pid); grew = true; } }
    return all.filter(p => hit.has(p.pid));
  };
  // a killed one counts until it is gone: orphaned, it loses its cmd / parent link in the list long before init reaps it
  const killed = new Set(), left = () => { const l = mine(); for (const pid of killed) if (!l.some(p => p.pid === pid) && exists(pid, probe)) l.push({ pid }); return l; };
  // a listed one that has exited (kill(pid, 0): ESRCH) is not a survivor: on Windows it stays in the process list, its files still
  // open, until its rundown ends (CI 43766573125: Edge's network service for > 10 s). Wait for it while it makes that progress;
  // only a live one that 5 kill rounds did not end is a survivor. RUNDOWN_GUARD_MS is a hang guard, never a result.
  const t0 = performance.now();
  for (let round = 0; ;) {
    const l = left(), live = l.filter(p => exists(p.pid, probe));
    if (!l.length) return 0;
    if (live.length ? round++ >= 5 : performance.now() - t0 > RUNDOWN_GUARD_MS) return l.length;
    for (const p of live) { killed.add(p.pid); try { kill(p.pid); } catch { /* gone */ } }
    await sleep(300);
  }
}
const RUNDOWN_GUARD_MS = 5 * 60000;
/** remove the temp profile (or a dir holding it). A process still holding a file in it (EPERM / EBUSY on Windows) is the
 * browser tree: wait for every process naming the dir (and its descendants) to exit - killProfileProcs kills and re-lists until
 * none is left - then try once more. Never throws: { ok, why } (why names the survivors, or the error once no holder is left) */
export async function removeProfile(dir, { platform = process.platform, list = listProcs, kill } = {}) {
  const rm = () => { try { fs.rmSync(dir, { recursive: true, force: true }); return null; } catch (e) { return e; } };
  let err = rm();
  if (err && ['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(err.code)) {
    const procs = () => { const key = String(dir).replace(/\\/g, '/').toLowerCase(); return list({ platform }).filter(p => String(p.cmd || '').replace(/\\/g, '/').toLowerCase().includes(key)); };
    const left = await killProfileProcs(dir, { platform, list, ...(kill ? { kill } : {}) });
    if (left) return { ok: false, why: `${left} process(es) on ${dir} survived the kill (${procs().map(p => p.pid).join(', ')}): ${err.code}` };
    err = rm();
  }
  return err ? { ok: false, why: `${err.code || err.message} removing ${dir} with no process on it left` } : { ok: true, why: null };
}
/** the browser's whole teardown, one path for norn shot and the tests: its tree killed and waited for, every process on the profile
 * gone, then the profile (or dir, its parent) removed. Never throws, so a caller's finally always reaches its own cleanup and the
 * body's result stands: { ok, why } to report after */
export async function closeBrowser(child, profile, { dir = profile, platform = process.platform, list = listProcs, kill } = {}) {
  try {
    await killTree(child, platform);
    const left = await killProfileProcs(profile, { platform, list, ...(kill ? { kill } : {}) });
    const r = await removeProfile(dir, { platform, list, kill });
    return left && !r.ok ? { ok: false, why: `${left} browser process(es) on ${profile} survived the kill; ${r.why}` } : r;
  } catch (e) { return { ok: false, why: `teardown: ${e.message}` }; }
}
/** CI 44335427788: on a fresh ubuntu runner the FIRST browser launch is slow (the first browser test of a file 25-36 s, later ones
 * 8-10 s; two cold launches at once passed waitDevToolsPort's 30 s). One launch to the DevTools port and down, before the tests:
 * the one-time cost is paid off any test's clock and measured. { ms, stderr (the browser's own, timestamped lines), error } */
export async function warmBrowser({ browser, tmp = os.tmpdir(), platform = process.platform }) {
  const profile = fs.mkdtempSync(path.join(tmp, 'meta-shot-')), t0 = Date.now(), child = launchBrowser({ browser, profile, platform });
  let error = null;
  try { await waitDevToolsPort({ browser, profile, child }); } catch (e) { error = e.message; }
  const ms = Date.now() - t0, stderr = stderrTail(profile);
  await closeBrowser(child, profile, { platform });
  return { ms, stderr, error };
}

const CLICKABLE = 'button,a,[role=button],[role=tab],summary,label,input[type=submit]';
/**
 * Take the shot(s). o: { url, out, size [w,h], phone, theme dark|light, steps [], browser { kind, exe, prefix? }, log (line =>),
 * timeoutMs, tmp (the parent of the temp profile; default the OS temp dir), onProfile (dir => before deletion; tests / the proof read it) }. Returns { shots, blocked, logs }.
 */
export async function shot(o) {
  const log = o.log || (() => {});
  if (!o.url || !/^(https?|file):/i.test(o.url)) throw new ShotError('the URL must be http(s):// or file:');
  const target = new URL(o.url);
  const origin = /^https?:$/.test(target.protocol) ? target.origin : null;
  const steps = checkSteps(o.steps || [], origin);
  const size = o.phone ? PHONE : (o.size || [1440, 900]);
  const br = o.browser || findBrowser();
  if (!br) throw new ShotError('no Edge / Chrome / Chromium found (pass --browser <exe>)', 1);
  const profile = fs.mkdtempSync(path.join(o.tmp || os.tmpdir(), 'meta-shot-'));
  const platform = o.platform || process.platform;
  const child = launchBrowser({ browser: br, profile, size, hosts: origin ? [target.hostname] : [], platform });
  const onExit = () => { try { if (platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
  process.once('exit', onExit);
  let ws = null;
  const shots = [], blocked = [], logs = [];
  try {
    const deadline = o.timeoutMs || 120000;
    const port = await waitDevToolsPort({ browser: br, profile, child }).catch(e => { throw new ShotError(e.message, 1); });
    const base = `http://127.0.0.1:${port}`;
    const page = await until(async () => {
      try { return (await (await fetch(`${base}/json/list`)).json()).find(t => t.type === 'page') || null; } catch { return null; }
    }, 15000, 'a page target');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new ShotError('DevTools WebSocket failed', 1)), { once: true }); });
    let id = 0; const pend = new Map(), waiters = [];
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new ShotError(`${method}: no answer`, 1)); }, deadline);
      pend.set(i, m => { clearTimeout(t); m.error ? rej(new ShotError(`${method}: ${m.error.message}`, 1)) : res(m.result); });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const event = (method, ms) => new Promise(res => { const w = { method, res }; waiters.push(w); setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) waiters.splice(k, 1); res(null); }, ms).unref(); });
    ws.addEventListener('message', e => {
      const m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString());
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
      for (const w of waiters.filter(x => x.method === m.method)) { waiters.splice(waiters.indexOf(w), 1); w.res(m.params); }
      if (m.method === 'Fetch.requestPaused') {
        const { requestId, request } = m.params;
        if (allowedUrl(request.url, origin)) send('Fetch.continueRequest', { requestId }).catch(() => {});
        else { blocked.push(request.url); log(`blocked ${request.url}`); send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {}); }
      } else if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text).slice(0, 300));
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push('error ' + m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300));
    });
    const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r?.exceptionDetails ? 'JSERR ' + String(r.exceptionDetails.text).slice(0, 300) : r?.result?.value; };
    const setSize = ([w, h, mobile]) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile });
    const go = async (url, wait) => {
      if (!allowedUrl(url, origin)) throw new ShotError(`refused navigation to ${url}`);
      const loaded = event('Page.loadEventFired', 15000);
      await send('Page.navigate', { url });
      await loaded; await sleep(wait ?? 800);
    };
    const capture = async file => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64')); shots.push(file); log(`shot ${file}`);
    };
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await send('Page.enable'); await send('Runtime.enable');
    await setSize(o.phone ? [...PHONE, true] : size);
    if (o.theme) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.theme }] });
    await go(o.url);
    for (const s of steps) {
      if (s.go !== undefined) await go(s.go, s.wait);
      else if (s.size) await setSize(s.size);
      else if (s.shot) await capture(s.shot);
      else if (s.click !== undefined) log(`click ${s.click} ` + await ev(`(()=>{const t=${JSON.stringify(String(s.click).toLowerCase())};const els=[...document.querySelectorAll(${JSON.stringify(CLICKABLE)})].filter(e=>e.offsetParent!==null&&(e.innerText||e.value||'').trim().toLowerCase().includes(t));if(!els.length)return 'NOT FOUND';const e=els[${Number(s.nth) || 0}]||els[0];e.click();return 'ok ('+els.length+' match)'})()`));
      else if (s.type) log(`type ${s.type[0]} ` + await ev(`(()=>{const e=document.querySelector(${JSON.stringify(s.type[0])});if(!e)return 'NOT FOUND';e.focus();const d=Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value');d.set.call(e,${JSON.stringify(String(s.type[1]))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return 'ok'})()`));
      else if (s.text !== undefined) log('text> ' + String(await ev(`(document.querySelector(${JSON.stringify(s.text)})||{}).innerText||'NOT FOUND'`) || '').replace(/\n{2,}/g, '\n').slice(0, Number(s.max) || 2500));
      if (s.wait && s.go === undefined) await sleep(s.wait);
    }
    if (o.out) await capture(o.out);
    if (logs.length) log('PAGE LOGS:\n' + [...new Set(logs)].slice(0, 15).join('\n'));
    return { shots, blocked, logs };
  } finally {
    try { ws?.close(); } catch { /* closed */ }
    await killTree(child, platform);
    const left = await killProfileProcs(profile, { platform });
    if (left) log(`warning: ${left} browser process(es) on ${profile} survived the kill`);
    process.removeListener('exit', onExit);
    if (o.onProfile) { try { await o.onProfile(profile); } catch { /* the reader's problem */ } }
    const rm = await removeProfile(profile, { platform });
    if (!rm.ok) log(`warning: the temp profile ${profile} could not be removed: ${rm.why}`);
  }
}

export const SHOT_USAGE = 'usage: norn shot <url> --out <png> [--size 1440x900 | --phone] [--theme dark|light] [--steps <json | file>] [--browser <exe>]    (headless Edge / Chrome / Chromium, private, signed out, a temp profile deleted after; only 127.0.0.1, file: and <url>\'s origin load. steps: go / size / shot / click / type / wait / text)';
/** argv -> shot options (throws ShotError on a usage error) */
export function parseShotArgs(argv) {
  const o = { steps: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new ShotError(`${a} needs a value`); return argv[++i]; };
    if (a === '--out') o.out = next();
    else if (a === '--size') o.size = parseSize(next());
    else if (a === '--phone') o.phone = true;
    else if (a === '--theme') { o.theme = next(); if (!['dark', 'light'].includes(o.theme)) throw new ShotError('--theme is dark or light'); }
    else if (a === '--steps') {
      const v = next(); let txt = v;
      if (!/^\s*\[/.test(v)) { if (!fs.existsSync(v)) throw new ShotError(`--steps: no such file ${v}`); txt = fs.readFileSync(v, 'utf8'); }
      try { o.steps = JSON.parse(txt); } catch (e) { throw new ShotError(`--steps is not JSON: ${e.message}`); }
    } else if (a === '--browser') { const exe = next(); o.browser = /\.m?js$/i.test(exe) ? { kind: kindOf(exe), exe: process.execPath, prefix: [path.resolve(exe)] } : { kind: kindOf(exe), exe }; }
    else if (a.startsWith('-')) throw new ShotError(`unknown flag ${a}`);
    else if (!o.url) o.url = a;
    else throw new ShotError(`unexpected ${a}`);
  }
  if (!o.url) throw new ShotError('missing <url>');
  if (!o.out) throw new ShotError('--out <png> is required');
  if (o.phone && o.size) throw new ShotError('--size and --phone exclude each other');
  return o;
}
