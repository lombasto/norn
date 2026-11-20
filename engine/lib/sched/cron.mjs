// cron fallback (D13, Linux without a systemd user manager): one crontab line tagged "# norn:<name>"; foreign lines are kept.
import { tickArgv, realIo, ownerOf } from './common.mjs';

const sh = s => (/^[\w@%+=:,./-]+$/.test(s) ? String(s) : "'" + String(s).split("'").join("'\\''") + "'");
export function line(o) {
  const n = o.interval_min, when = n < 60 ? `*/${n} * * * *` : n % 60 === 0 && n < 1440 ? `0 */${n / 60} * * *` : null;
  if (!when) throw new Error(`cron cannot express every ${n} min (use < 60 or whole hours)`);
  return `${when} cd ${sh(o.meta)} && ${tickArgv(o).map(sh).join(' ')} >/dev/null 2>&1 # norn:${o.name}`;
}
const ours = (l, n) => { const t = l.trimEnd(); return t.endsWith(` # norn:${n}`); };
export function plan(o) {
  return { files: [{ path: 'crontab', content: line(o) + '\n' }], install: [['crontab', '-l'], ['crontab', '-']], remove: [['crontab', '-l'], ['crontab', '-']] };
}
function edit(o, io, add) {
  const cur = io.run('crontab', ['-l']);
  const keep = (cur.status === 0 ? String(cur.stdout || '') : '').split('\n').filter(l => l && !ours(l, o.name));
  if (add) keep.push(line(o));
  const r = io.run('crontab', ['-'], keep.length ? keep.join('\n') + '\n' : '');
  if (r.status !== 0) throw new Error(`crontab - -> exit ${r.status}: ${String(r.stderr || '').trim()}`);
  return plan(o);
}
function installed(o, io = realIo) {
  const cur = io.run('crontab', ['-l']);
  return cur.status === 0 && String(cur.stdout || '').split('\n').some(l => ours(l, o.name));
}
// OOTB F-4: the install dir this name's line runs (its `cd <dir> &&`), or null
function owner(o, io = realIo) {
  const cur = io.run('crontab', ['-l']);
  return cur.status === 0 ? ownerOf(String(cur.stdout || '').split('\n').find(l => ours(l, o.name)) || '') : null;
}
export default { plan, installed, owner, install: (o, io = realIo) => edit(o, io, true), remove: (o, io = realIo) => edit(o, io, false) };
