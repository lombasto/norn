// META-CONTROLLER C6 (SPEC sec. 5, DEC-140): reach the dashboard from your phone through a private network YOU run - Tailscale Serve
// first (your own tailnet; Serve sets the Tailscale-User-Login identity header), Cloudflare Access second (documented in SETUP.md).
// The dashboard keeps listening on 127.0.0.1 only: the tunnel agent connects locally. Norn never installs, embeds or starts a
// tunnel by itself; `norn remote setup` prints the commands and runs `tailscale serve` only with --apply. Tailscale FUNNEL (the
// public internet) is refused: its requests carry no identity header and are marked Tailscale-Funnel-Request.
// machine.json dash.remote = { enabled, trust: tailscale | cloudflare-access, hosts: [host names], logins: [allowed logins] }.
// Off (absent or enabled false) = the dashboard behaves exactly as before C6.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { which } from './paths.mjs';
import { updateMachine } from './config.mjs';

export class RemoteError extends Error { constructor(msg, status = 403) { super(msg); this.status = status; } }
const deny = msg => new RemoteError(msg, 403);

/** trust source -> the identity header the proxy sets (lower case, as node reads it) */
export const TRUST = {
  tailscale: { header: 'tailscale-user-login', label: 'Tailscale Serve' },
  'cloudflare-access': { header: 'cf-access-authenticated-user-email', label: 'Cloudflare Access' },
};
export const COOKIE = 'norn_device';
export const CODE_TTL_MS = 10 * 60000, CLAIM_TRIES = 5, POSTS_PER_MIN = 120;
const COOKIE_AGE_S = 365 * 24 * 3600;
// headers a reverse proxy adds: on the local address they mean "a proxy that rewrote Host" - never the desktop
const PROXY_MARKERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-real-ip', 'tailscale-user-login', 'tailscale-user-name',
  'tailscale-funnel-request', 'cf-access-authenticated-user-email', 'cf-access-jwt-assertion', 'cf-connecting-ip'];

/** machine -> { trust, header, label, hosts, logins, url } when dash.remote.enabled is true, else null (remote off). An unknown trust
 * source throws: remote silently off would read as "enabled is false" in doctor. */
export function remoteOf(machine) {
  const r = machine?.dash?.remote;
  if (!r || r.enabled !== true) return null;
  const trust = r.trust ?? 'tailscale', t = TRUST[trust];
  if (!t) throw new Error(`dash.remote.trust ${trust}: not one of ${Object.keys(TRUST).join(', ')}`);
  const hosts = (r.hosts || []).map(h => String(h).toLowerCase().replace(/:443$/, ''));
  return { trust, header: t.header, label: t.label, hosts, logins: (r.logins || []).map(l => String(l).toLowerCase()), url: hosts.length ? `https://${hosts[0]}/` : null };
}
/** The dashboard's remote address (https://<first host>/) when remote is on, else null - the ntfy "view" link. */
export const remoteUrl = machine => remoteOf(machine)?.url ?? null;

/**
 * Where a request comes from. headers (node, lower-case names), cfg = remoteOf(machine), localHost = '127.0.0.1:<port>'.
 * -> { remote: false } (the desktop: the caller keeps today's origin check) | { remote: true, host, origin, login }; throws RemoteError 403.
 */
export function classify(h, cfg, localHost) {
  const host = String(h.host ?? '').toLowerCase();
  if (host === localHost) {
    if (PROXY_MARKERS.some(k => h[k] !== undefined)) throw deny('A proxied request on the local address is refused: a remote device comes in by its host name (dash.remote.hosts)');
    return { remote: false };
  }
  const bare = host.replace(/:443$/, '');
  if (!bare || !cfg.hosts.includes(bare)) throw deny('Host not allowed: use the 127.0.0.1 dashboard address, or a host name in dash.remote.hosts');
  if (h['tailscale-funnel-request'] !== undefined) throw deny('Tailscale Funnel (the public internet) is refused: Norn serves your own tailnet only (tailscale serve)');
  const login = String(h[cfg.header] ?? '').trim();
  if (!login) throw deny(`No identity header (${cfg.header}): remote access goes through ${cfg.label} only`);
  if (cfg.logins.length && !cfg.logins.includes(login.toLowerCase())) throw deny('This login is not allowed (dash.remote.logins)');
  const origin = `https://${bare}`;
  if (h.origin !== undefined && h.origin !== origin) throw deny('Cross-origin request refused');
  return { remote: true, host: bare, origin, login };
}

/** the device cookie of a request (or '') */
export function cookieOf(h) {
  for (const part of String(h.cookie ?? '').split(';')) { const [k, ...v] = part.trim().split('='); if (k === COOKIE) return v.join('='); }
  return '';
}
export const setCookie = value => `${COOKIE}=${value}; Max-Age=${COOKIE_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Strict`;

// ---------- device pairing ----------
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no I L O 0 1: read off a screen, typed on a phone
function newCode(rand) {
  let s = '';
  while (s.length < 8) for (const b of rand(16)) if (b < 248 && s.length < 8) s += ALPHA[b % ALPHA.length];   // 248 = 31 * 8: unbiased
  return s;
}
const norm = c => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const sha = s => createHash('sha256').update(s).digest('hex');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const PUBLIC = d => ({ id: d.id, name: d.name, login: d.login, created: d.created, last_seen: d.last_seen });

/**
 * The paired devices (file = <meta>/local/remote-devices.json: ids, names, logins, sha256 of the secret - never the secret) and the
 * one open pairing code (memory only: a dashboard restart drops it). -> { open, pending, claim, verify, touch, list, revoke }
 */
export function createPairing({ file, now = Date.now, rand = randomBytes }) {
  let code = null;
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).devices ?? []; } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  let devices = load();
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ schema: 1, devices }, null, 1) + '\n'); fs.renameSync(tmp, file);
  };
  const iso = t => new Date(t).toISOString();
  return {
    /** a new single-use code (replaces an open one): { code: 'ABCD-EFGH', expires } */
    open() { code = { code: newCode(rand), expires: now() + CODE_TTL_MS, tries: 0 }; return { code: `${code.code.slice(0, 4)}-${code.code.slice(4)}`, expires: iso(code.expires) }; },
    pending() { return code && now() < code.expires ? { expires: iso(code.expires) } : null; },
    /** a phone's claim: the code once, within its 10 min; 5 wrong tries burn it. -> { device, cookie } */
    claim(input, { name, login }) {
      if (!code || now() >= code.expires) { code = null; throw deny('No pairing code is open: press "Pair a device" on the desktop dashboard'); }
      if (!eq(norm(input), code.code)) { if (++code.tries >= CLAIM_TRIES) code = null; throw deny('Wrong pairing code'); }
      code = null;
      const id = 'dev-' + rand(4).toString('hex'), secret = rand(32).toString('base64url'), t = iso(now());
      const d = { id, name: String(name ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 40) || 'phone', login: String(login).toLowerCase(), created: t, last_seen: t, hash: sha(secret) };
      devices = [...load().filter(x => x.id !== id), d]; save();
      return { device: PUBLIC(d), cookie: `${id}.${secret}` };
    },
    /** cookie value + the request's login -> the device, or null (unknown, revoked, wrong secret, another login) */
    verify(value, login) {
      const m = /^(dev-[0-9a-f]{8})\.([A-Za-z0-9_-]{43})$/.exec(String(value ?? ''));
      if (!m) return null;
      const d = devices.find(x => x.id === m[1]);
      if (!d || !eq(sha(m[2]), d.hash) || d.login !== String(login ?? '').toLowerCase()) return null;
      return PUBLIC(d);
    },
    /** last seen, written at most every 10 min per device */
    touch(id) {
      const d = devices.find(x => x.id === id);
      if (d && now() - Date.parse(d.last_seen) > 10 * 60000) { d.last_seen = iso(now()); save(); }
    },
    list() { return devices.map(PUBLIC); },
    revoke(id) { const n = devices.length; devices = devices.filter(x => x.id !== id); if (devices.length === n) return false; save(); return true; },
  };
}
export const devicesFile = meta => path.join(meta, 'local', 'remote-devices.json');
export function deviceCount(meta) { try { return (JSON.parse(fs.readFileSync(devicesFile(meta), 'utf8')).devices ?? []).length; } catch { return 0; } }

// ---------- tailscale (found, version, this PC's name + login; `serve` only on --apply) ----------
const DEFAULT_EXE = { win32: 'C:/Program Files/Tailscale/tailscale.exe', darwin: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' };
/** the tailscale CLI: META_TAILSCALE (tests: a fake), else PATH, else the installer's default place; null = not found */
export function findTailscale(env = process.env, platform = process.platform) {
  if (env.META_TAILSCALE) return fs.existsSync(env.META_TAILSCALE) ? env.META_TAILSCALE : null;
  return which('tailscale', { env, platform }) ?? (DEFAULT_EXE[platform] && fs.existsSync(DEFAULT_EXE[platform]) ? DEFAULT_EXE[platform] : null);
}
export function runTailscale(exe, args, env = process.env) {
  const [cmd, argv] = /\.m?js$/.test(exe) ? [process.execPath, [exe, ...args]] : [exe, args];
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 30000, windowsHide: true, env });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? (r.error?.message ?? '') };
}
/** read-only facts: { version, host, login, running } (`tailscale version`, `tailscale status --json`) */
export function tailscaleFacts(exe, env) {
  const v = runTailscale(exe, ['version'], env), version = v.status === 0 ? v.out.trim().split(/\r?\n/)[0] : null;
  let host = null, login = null, running = false;
  const s = runTailscale(exe, ['status', '--json'], env);
  try {
    const j = JSON.parse(s.out);
    running = j.BackendState === 'Running';
    host = String(j.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase() || null;
    login = j.User?.[String(j.Self?.UserID)]?.LoginName ?? null;
  } catch { /* not signed in / not running */ }
  return { version, host, login, running };
}
export const serveCmd = port => ['serve', '--bg', `http://127.0.0.1:${port}`];
export const serveOffCmd = () => ['serve', '--https=443', 'off'];

/**
 * norn remote setup [--apply] [--host H] [--login L]: check for tailscale, print the plan (each command + what it does); with --apply
 * run `tailscale serve --bg http://127.0.0.1:<port>` and write dash.remote. -> exit code (0 ok, 1 not ready, 2 usage).
 */
export function remoteSetup({ machineFile, machine, apply = false, host = null, login = null, env = process.env, out }) {
  const port = machine.dash?.port ?? 8737;
  out('remote setup: Tailscale Serve - your own private tailnet, never the public internet');
  const exe = findTailscale(env);
  if (!exe) {
    out('tailscale not found - install it yourself from https://tailscale.com/download on this PC and on your phone, sign in with the same account, then run this again.');
    out('(Norn never installs network software; the second option, Cloudflare Access, is in SETUP.md "Reach Norn from your phone".)');
    return 1;
  }
  const f = tailscaleFacts(exe, env);
  out(`ok tailscale ${f.version ?? '(version unknown)'} (${exe.replace(/\\/g, '/')})`);
  const H = (host ?? f.host)?.toLowerCase().replace(/\.$/, '') ?? null, L = login ?? f.login;
  if (f.running && H) out(`ok tailnet: signed in${L ? ` as ${L}` : ''}; this PC is ${H}`);
  else out('note tailnet: not signed in or not running - open Tailscale and sign in (or pass --host <pc>.<tailnet>.ts.net --login <you>)');
  const remote = { enabled: true, trust: 'tailscale', hosts: H ? [H] : [], logins: L ? [L] : [] };
  const ts = a => `tailscale ${a.join(' ')}`;
  out(`The plan${apply ? '' : ' - nothing runs and nothing is written until you add --apply'}:`);
  out(`  1. ${ts(serveCmd(port))}`);
  out(`     serves the dashboard at ${H ? `https://${H}/` : 'https://<pc>.<tailnet>.ts.net/'} to devices signed in to YOUR tailnet only (--bg: it stays on after a restart).`);
  out('     The dashboard itself keeps listening on 127.0.0.1; Serve adds the Tailscale-User-Login header Norn checks.');
  out(`  2. machine.json dash.remote = ${JSON.stringify(remote)}`);
  out(`     Norn then answers that host name only, for ${L ? L : 'any login of your tailnet'} only; every page but the pairing page needs a paired device.`);
  out('  3. norn dash restart        (the dashboard reads dash.remote when it starts)');
  out('Then: Settings > Notifications > Reach Norn from your phone > Pair a device (a single-use code), open the address on your phone, enter it.');
  out(`Check: ${ts(['serve', 'status'])}    Undo: ${ts(serveOffCmd())} and norn remote off --apply`);
  out('Never: tailscale funnel - that is the public internet; Norn refuses Funnel requests.');
  if (!apply) return 0;
  if (!H) { out('not applied: no host name (sign in to Tailscale, or pass --host)'); return 1; }
  const r = runTailscale(exe, serveCmd(port), env);
  if (r.status !== 0) { out(`not applied: ${ts(serveCmd(port))} failed (exit ${r.status}): ${(r.err || r.out).trim().split(/\r?\n/)[0] ?? ''}`); return 1; }
  out(`ran: ${ts(serveCmd(port))}`);
  updateMachine(machineFile, raw => ({ dash: { ...(raw.dash ?? { port, bind: '127.0.0.1' }), remote } }));
  out(`wrote ${machineFile.replace(/\\/g, '/')} (dash.remote) - now run: norn dash restart`);
  return 0;
}

/** norn remote off [--apply]: `tailscale serve --https=443 off` + dash.remote.enabled = false (only with --apply). */
export function remoteOff({ machineFile, machine, apply = false, env = process.env, out }) {
  const on = !!remoteOf(machine), exe = findTailscale(env), ts = a => `tailscale ${a.join(' ')}`;
  out(`remote access is ${on ? 'on' : 'off'}. The plan${apply ? '' : ' - nothing runs until you add --apply'}:`);
  out(`  1. ${ts(serveOffCmd())}    (stops serving the dashboard to your tailnet)`);
  out('  2. machine.json dash.remote.enabled = false, then norn dash restart');
  if (!apply) return 0;
  if (exe) { const r = runTailscale(exe, serveOffCmd(), env); out(r.status === 0 ? `ran: ${ts(serveOffCmd())}` : `note ${ts(serveOffCmd())} failed (exit ${r.status}) - run it yourself`); }
  else out('note tailscale not found - nothing to stop there');
  if (machine.dash?.remote) { updateMachine(machineFile, raw => ({ dash: { ...raw.dash, remote: { ...raw.dash.remote, enabled: false } } })); out(`wrote ${machineFile.replace(/\\/g, '/')} (dash.remote.enabled = false) - now run: norn dash restart`); }
  return 0;
}

/** doctor rows: [kind ('ok' | 'note' | 'PROBLEM'), text] */
export function remoteDoctor({ machine, meta, env = process.env }) {
  const raw = machine?.dash?.remote, cfg = remoteOf(machine);
  if (!cfg) return [['note', `remote access: off${raw ? ' (dash.remote.enabled is false)' : ''} - reach Norn from your phone: norn remote setup (SETUP.md "Reach Norn from your phone")`]];
  const rows = [];
  if (!cfg.hosts.length) rows.push(['PROBLEM', 'remote access: no hosts in dash.remote.hosts - nothing can reach it (norn remote setup)']);
  else { const n = deviceCount(meta), k = cfg.logins.length;
    rows.push(['ok', `remote access: on (${cfg.trust}, ${cfg.hosts.join(' ')}, ${k ? `${k} login${k === 1 ? '' : 's'}` : 'any login'}, ${n} paired device${n === 1 ? '' : 's'})`]); }
  if ((machine.dash?.bind || '127.0.0.1') !== '127.0.0.1') rows.push(['PROBLEM', `remote access: dash.bind is ${machine.dash.bind} - keep 127.0.0.1 (the tunnel connects locally)`]);
  if (cfg.trust === 'tailscale') {
    const exe = findTailscale(env);
    if (!exe) rows.push(['PROBLEM', 'remote access: tailscale not found - install it from https://tailscale.com/download (Norn never installs it) or norn remote off --apply']);
    else { const v = runTailscale(exe, ['version'], env); rows.push(v.status === 0 ? ['ok', `tailscale ${v.out.trim().split(/\r?\n/)[0]}`] : ['PROBLEM', `remote access: tailscale version failed (exit ${v.status})`]); }
  }
  return rows;
}
