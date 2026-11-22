// Shared scheduler-adapter pieces: the real io, the scheduled argv, plan step runner, generic install / remove.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const realIo = {
  run: (cmd, args, input) => spawnSync(cmd, args, { input, encoding: 'utf8', windowsHide: true, timeout: 60000 }),
  write: (f, c, encoding) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, encoding === 'utf16le' ? '﻿' + c : c, encoding || 'utf8'); },
  rm: f => { try { fs.unlinkSync(f); } catch { /* gone */ } },
  exists: f => fs.existsSync(f),
  read: f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
};
// OOTB F-4: two installs on one machine. The task name of an install = `norn-tick-` + a short hash of its dir (setup records it in
// machine.json; an install that recorded a name keeps it). A Windows drive path compares case- and slash-insensitively.
export const TICK_NAME = 'norn-tick';
export const normDir = p => { const s = String(p).replace(/\\/g, '/').replace(/\/+$/, ''); return /^[a-z]:\//i.test(s) ? s.toLowerCase() : s; };
const dirHash = meta => createHash('sha1').update(normDir(meta)).digest('hex').slice(0, 8);
export const schedName = meta => `${TICK_NAME}-${dirHash(meta)}`;
// the name to use: the recorded one, else this install's own
export const liveName = (recorded, meta) => recorded || schedName(meta);
// the install dir an installed task's text runs: its working dir (XML / unit / plist / `cd X &&`), else the dir of the norn.mjs it starts
const unx = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export function ownerOf(text) {
  if (!text) return null;
  const m = text.match(/<WorkingDirectory>([^<]+)<\/WorkingDirectory>/) || text.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/)
    || text.match(/^WorkingDirectory=(.+)$/m) || text.match(/\bcd ('(?:[^']|'\\'')*'|\S+) &&/) || text.match(/([^'"\s;&]+)\/engine\/bin\/norn\.mjs/);
  return m ? unx(m[1].trim()).replace(/^'(.*)'$/, '$1').replace(/'\\''/g, "'") : null;
}
// { installed, owner, foreign }: foreign = installed AND it runs ANOTHER install; an owner the adapter cannot read is never foreign
export function schedState(a, o, io = realIo) {
  const installed = !!a.installed(o, io), owner = installed && a.owner ? a.owner(o, io) : null;
  return { installed, owner, foreign: !!owner && normDir(owner) !== normDir(o.meta) };
}
const readOwner = f => (o, io = realIo) => ownerOf(io.read ? io.read(f(o)) : null);   // file-based adapters (systemd / launchd)
export { readOwner };
// the scheduled command: one tick over every project in machine.json
export const tickArgv = o => [o.node, `${o.meta}/engine/bin/norn.mjs`, 'tick', '--reason', 'schedule'];
export function steps(list, io) {
  for (const c of list) {
    if (c[0] === 'rm') { io.rm(c[1]); continue; }
    const r = io.run(c[0], c.slice(1));
    if (r.status !== 0) throw new Error(`${c.join(' ')} -> exit ${r.status}: ${String(r.stderr || '').trim()}`);
  }
}
// default install = write the files, run the install steps; remove = the remove steps
// installed(o, io) -> bool: asks the OS (META-ONBOARD 3.4), never a recorded flag that can drift
export const generic = (plan, installed) => ({
  plan, installed,
  install(o, io = realIo) { const p = plan(o); for (const f of p.files) io.write(f.path, f.content, f.encoding); steps(p.install, io); return p; },
  remove(o, io = realIo) { const p = plan(o); steps(p.remove, io); return p; },
});
