// H4 `norn notify` (HARNESS-DESIGN sec. 6): an outbound-only owner alert (DIR-8). The backend is data in machine.json `notify`:
//   absent | { backend: 'none' }                                  -> nothing sent (the default: no outward publish without opt-in)
//   { backend: 'ntfy', topic, server? }                           -> ntfy JSON publish (POST <server>/; default https://ntfy.sh)
//   { backend: 'pushover', token_env?, user_env? }                -> Pushover messages API; token + user key from env vars only
//   { backend: 'toast' }                                          -> a Windows toast (PowerShell, WinRT ToastNotificationManager)
//   { backend: 'desktop' }                                        -> this computer's own notification (DESKTOP rows: Windows toast,
//                                                                    macOS osascript, Linux notify-send)
// Every send (none included) appends one line to <state>/notify.jsonl: no topic, server, token or user key. The transport is
// injectable ({ post(url, { headers, body }) -> { status, text }, run(cmd, args, { env }) -> { status } }) so tests stay offline.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { remoteUrl } from './remote.mjs';

export class NotifyError extends Error { constructor(msg, code = 2) { super(msg); this.code = code; } }

export const PRIORITIES = ['low', 'default', 'high', 'urgent'];
// NORN-WATCH notice policy: ask / merge / alert (kills, crashes) go out at once; fyi (rulings, other FYI - each naming its record
// id) waits in <state>/notify-batch.jsonl and leaves as ONE digest notice once the oldest is batch_h old (project policy
// notify.batch_h, default 3), on the next notice or `meta notify --flush`. No class = immediate, as before.
// META-GUARD R1: usage (a GRD alarm: runaway / over the hand-off line / tool spam) is batched like fyi - off for the owner's phone -
// unless the caller passes push (policy guard.push): then one low-priority notice at once.
export const CLASSES = ['ask', 'merge', 'alert', 'fyi', 'usage'];
const CLASS_PRIO = { alert: 'high', usage: 'low' };
const RECORD_ID = /\b(?:Q|DEC|DIR|RUN|DLV|GRD)-\d+\b/;
export function batchHours(project) {
  const h = project?.policy?.notify?.batch_h ?? 3;
  if (!(typeof h === 'number' && h > 0)) throw new NotifyError(`${project?.name ?? 'project'}: policy.notify.batch_h must be a number > 0 (got ${h})`);
  return h;
}
const NTFY_PRIO = { low: 2, default: 3, high: 4, urgent: 5 };      // ntfy 1..5 (docs.ntfy.sh/publish/#message-priority)
const PUSHOVER_PRIO = { low: -1, default: 0, high: 1, urgent: 1 }; // 2 (emergency) needs retry/expire acks: not used
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const TOAST_PS = [
  "$ErrorActionPreference = 'Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$t = $x.GetElementsByTagName('text')",
  '$t.Item(0).AppendChild($x.CreateTextNode($env:META_NOTIFY_TITLE)) > $null',
  '$t.Item(1).AppendChild($x.CreateTextNode($env:META_NOTIFY_BODY)) > $null',
  `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${PS_AUMID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
].join('; ');

// META-NOTIFY-SETUP R1: the desktop notification of each OS as data: [cmd, args(title, body)]. Title / body ride in env vars
// (META_NOTIFY_TITLE / _BODY) or as separate argv entries - never quoted into a script.
const DESKTOP = {
  win32: () => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TOAST_PS]],
  darwin: () => ['osascript', ['-e', 'display notification (system attribute "META_NOTIFY_BODY") with title (system attribute "META_NOTIFY_TITLE")']],
  linux: (title, body) => ['notify-send', ['--app-name=Norn', '--', title, body]],
};
export const BACKENDS = ['ntfy', 'pushover', 'toast', 'desktop', 'none'];

/** A private, unguessable ntfy topic: 'norn-' + 18 random bytes url-safe (144 bits; ntfy topics are [-_A-Za-z0-9]{1,64}). */
export function newTopic(rand = randomBytes) { return 'norn-' + Buffer.from(rand(18)).toString('base64url'); }
/** The link a phone subscribes to (the ntfy app: + / subscribe, or open it in a browser). */
export function subscribeLink(n) { return ntfyServer(n.server) + n.topic; }

export const defaultTransport = {
  post: async (url, { headers, body }) => { const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) }); return { status: r.status, text: await r.text() }; },
  put: async (url, { headers, body }) => { const r = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(60000) }); return { status: r.status, text: await r.text() }; },
  // RM-46 S4: a long-lived GET read line by line (ntfy's JSON stream); ends when the server drops it, throws on a refusal or the abort
  stream: async function* (url, { signal }) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`answered ${r.status}`);
    const dec = new TextDecoder(); let buf = '';
    for await (const c of r.body) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); } }
  },
  // META-DASH-ASYNC R1: a child on its own (the dashboard's test ping is a request path): { status, stderr, error } like spawnSync's, never blocking the loop
  run: (cmd, args, { env }) => new Promise(ok => execFile(cmd, args, { env, windowsHide: true, encoding: 'utf8', timeout: 15000 }, (e, _out, stderr) =>
    ok({ status: e ? (Number.isInteger(e.code) ? e.code : null) : 0, stderr, error: e && !Number.isInteger(e.code) ? e : undefined }))),
};

export function ntfyServer(s = 'https://ntfy.sh') {
  let u;
  try { u = new URL(s); } catch { throw new NotifyError(`notify.server ${JSON.stringify(s)} is not a URL`); }
  const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) throw new NotifyError(`notify.server must be https (http only on loopback): ${u.origin}`);
  return u.origin + '/';
}

/** Send one alert through machine.notify and record it. Returns { backend, sent, ok, status? }; throws NotifyError (2 = config /
 * usage, nothing recorded unless the backend was tried; 1 = the backend refused / failed, recorded ok: false). */
export async function notify(o) {
  const { title, body, cls, machine, state, now = () => new Date(), batchH = 3 } = o;
  if (cls !== undefined && !CLASSES.includes(cls)) throw new NotifyError(`--class must be ${CLASSES.join('|')}`);
  const batched = cls === 'fyi' || (cls === 'usage' && !o.push);
  if (o.file !== undefined && batched) throw new NotifyError('--file goes with an immediate notice (ask|merge|alert), not a batched fyi');
  if (!batched) {
    const r = await send({ ...o, priority: o.priority ?? CLASS_PRIO[cls] ?? 'default' });
    await flushNotices({ ...o, force: false }).catch(() => {});   // a due batch rides along; its failure never fails this notice
    return r;
  }
  if (!title || typeof title !== 'string') throw new NotifyError('--title is required');
  if (typeof body !== 'string') throw new NotifyError('--body is required');
  if (!RECORD_ID.test(title + ' ' + body)) throw new NotifyError(`a --class ${cls} notice names its record id (DEC-n, Q-n, DIR-n, RUN-n, DLV-n, GRD-n) in --title or --body`);
  if (!state) throw new NotifyError('no state dir: every send is recorded (pass --project / --state)');
  fs.mkdirSync(state, { recursive: true });
  const ts = now().toISOString();
  fs.appendFileSync(path.join(state, 'notify-batch.jsonl'), JSON.stringify({ ts, title, body }) + '\n');
  fs.appendFileSync(path.join(state, 'notify.jsonl'), JSON.stringify({ ts, backend: machine?.notify?.backend ?? 'none', title, body, priority: 'low', class: cls, batched: true, sent: false, ok: true }) + '\n');
  const f = await flushNotices({ ...o, force: false });
  return f.sent ? { ...f.result, batched: true, flushed: f.count } : { backend: machine?.notify?.backend ?? 'none', sent: false, ok: true, batched: true };
}

/** Send the pending fyi batch as ONE notice (one line per notice) when its oldest is batchH hours old, or at once with force.
 * Returns { sent, count, result? }. The batch is claimed by a rename, so two callers never send it twice; a failed send puts it back. */
export async function flushNotices({ state, batchH = 3, force = false, now = () => new Date(), ...rest }) {
  if (!state) throw new NotifyError('no state dir: every send is recorded (pass --project / --state)');
  const file = path.join(state, 'notify-batch.jsonl');
  const read = f => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  const rows = read(file);
  if (!rows.length) return { sent: false, count: 0 };
  if (!force && now() - new Date(rows[0].ts) < batchH * 3600e3) return { sent: false, count: rows.length };
  const claim = file + '.sending-' + process.pid;
  try { fs.renameSync(file, claim); } catch (e) { if (e.code === 'ENOENT') return { sent: false, count: 0 }; throw e; }
  fs.writeFileSync(file, '', { flag: 'a' });
  const got = read(claim), hhmm = t => t.slice(11, 16) + 'Z';
  const body = got.map(r => `${r.title}: ${r.body.split('\n')[0]}`.slice(0, 200)).join('\n');
  try {
    const result = await send({ ...rest, state, now, title: `${got.length} FYI since ${hhmm(got[0].ts)}`, body, priority: 'low', cls: 'digest' });
    fs.unlinkSync(claim);
    return { sent: true, count: got.length, result };
  } catch (e) {
    fs.appendFileSync(file, fs.readFileSync(claim, 'utf8')); fs.unlinkSync(claim);
    throw e;
  }
}

async function send({ title, body, priority = 'default', cls, file, machine, state, env = process.env, transport = defaultTransport, platform = process.platform, now = () => new Date() }) {
  if (!title || typeof title !== 'string') throw new NotifyError('--title is required');
  if (typeof body !== 'string') throw new NotifyError('--body is required');
  if (!PRIORITIES.includes(priority)) throw new NotifyError(`--priority must be ${PRIORITIES.join('|')}`);
  if (!state) throw new NotifyError('no state dir: every send is recorded (pass --project / --state)');
  // S5 --file: an attachment (ntfy PUT / pushover multipart); toast / none name the path. Read before any send: a missing file sends nothing
  let bytes = null;
  if (file !== undefined) {
    if (!file || typeof file !== 'string') throw new NotifyError('--file needs a path');
    try { bytes = fs.readFileSync(file); } catch (e) { throw new NotifyError(`--file ${file}: ${e.code || e.message}`); }
  }
  const n = machine?.notify ?? { backend: 'none' }, backend = n.backend;
  const rec = o => { fs.mkdirSync(state, { recursive: true }); fs.appendFileSync(path.join(state, 'notify.jsonl'), JSON.stringify({ ts: now().toISOString(), backend, title, body, priority, ...(cls ? { class: cls } : {}), ...(bytes ? { file: path.resolve(file).replace(/\\/g, '/') } : {}), ...o }) + '\n'); };
  let send;
  if (backend === 'none') { rec({ sent: false, ok: true }); return { backend, sent: false, ok: true }; }
  if (backend === 'ntfy') {
    if (!n.topic) throw new NotifyError('notify.topic is required for ntfy');
    const url = ntfyServer(n.server);
    // C6: remote on = a tap opens the dashboard through your private network (docs.ntfy.sh/publish/#click-action, #action-buttons). A link only:
    // ntfy stays notify-only, never a command channel (SPEC sec. 5, P5)
    const view = remoteUrl(machine);
    if (bytes) {
      // ntfy attachment = PUT the bytes to <server>/<topic>; title / message / priority / filename as query (no non-ASCII header issue)
      const q = new URLSearchParams({ title, message: body, priority: String(NTFY_PRIO[priority]), filename: path.basename(file), ...(view ? { click: view, actions: `view, Open Norn, ${view}` } : {}) });
      send = () => transport.put(`${url}${encodeURIComponent(n.topic)}?${q}`, { headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    } else send = () => transport.post(url, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: n.topic, title, message: body, priority: NTFY_PRIO[priority], ...(view ? { click: view, actions: [{ action: 'view', label: 'Open Norn', url: view }] } : {}) }) });
  } else if (backend === 'pushover') {
    const te = n.token_env || 'PUSHOVER_TOKEN', ue = n.user_env || 'PUSHOVER_USER';
    for (const k of [te, ue]) if (!env[k]) throw new NotifyError(`pushover needs the env var ${k} (the key is never stored in machine.json)`);
    const fields = { token: env[te], user: env[ue], title, message: body, priority: String(PUSHOVER_PRIO[priority]) };
    const form = new URLSearchParams(fields);
    if (bytes) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      fd.append('attachment', new Blob([bytes]), path.basename(file));
      send = () => transport.post('https://api.pushover.net/1/messages.json', { headers: {}, body: fd });
    } else send = () => transport.post('https://api.pushover.net/1/messages.json', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  } else if (backend === 'toast' || backend === 'desktop') {
    if (backend === 'toast' && platform !== 'win32') throw new NotifyError('the toast backend is Windows only');
    if (!DESKTOP[platform]) throw new NotifyError(`the desktop backend knows macOS, Linux and Windows (not ${platform})`);
    const text = bytes ? `${body}\nfile: ${path.resolve(file)}` : body, [cmd, args] = DESKTOP[platform](title, text);
    send = async () => {
      const r = await transport.run(cmd, args, { env: { ...env, META_NOTIFY_TITLE: title, META_NOTIFY_BODY: text } });
      return { status: r.status === 0 ? 200 : 500, text: String(r.stderr || r.error?.message || '') };
    };
  } else throw new NotifyError(`unknown notify backend ${JSON.stringify(backend)} (${BACKENDS.join('|')})`);
  let r;
  try { r = await send(); } catch (e) { rec({ sent: false, ok: false, error: String(e.message).slice(0, 200) }); throw new NotifyError(`${backend}: ${e.message}`, 1); }
  const ok = r.status >= 200 && r.status < 300;
  rec({ sent: ok, ok, status: r.status });
  if (!ok) throw new NotifyError(`${backend} answered ${r.status}`, 1);
  return { backend, sent: true, ok: true, status: r.status };
}

// RM-46 S4 (multi-home SPEC 4.3, 7): the doorbell - machine.json ledger.doorbell { server?, topic }, a topic of its own (DEC-421), never in the
// ledger (secretsOf scans the topic key). It carries no data: a ring is { h, sha } at ntfy priority min, and git stays the truth.
const DOORBELL_PRIO = 1;   // ntfy "min": no sound, no phone banner
/** ring the doorbell once: POST { topic, message: '{"h","sha"}', priority: 1 }; throws NotifyError (2 = config, 1 = the server failed) */
export async function ringDoorbell(d, { h, sha }, { transport = defaultTransport } = {}) {
  if (!d?.topic) throw new NotifyError('ledger.doorbell.topic is required');
  const r = await transport.post(ntfyServer(d.server), { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: d.topic, message: JSON.stringify({ h, sha }), priority: DOORBELL_PRIO }) });
  if (!(r.status >= 200 && r.status < 300)) throw new NotifyError(`doorbell answered ${r.status}`, 1);
  return { status: r.status };
}
/** the doorbell's ntfy JSON stream (GET <server>/<topic>/json): an async iterable of its lines */
export const doorbellStream = (d, { signal, transport = defaultTransport } = {}) => transport.stream(`${ntfyServer(d.server)}${encodeURIComponent(d.topic)}/json`, { signal });
