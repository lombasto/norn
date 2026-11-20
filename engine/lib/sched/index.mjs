// Scheduler adapters (META-GENERAL-DESIGN D13): each turns { name, interval_min, node, meta, home, user?, command? } into a plan
// { files [{path, content, encoding?}], install [argv], remove [argv] } and runs it through an injectable io { run, write, rm }
// (tests / WSL proofs inject; the default io touches the real machine). `rm <file>` steps go to io.rm, not a process.
import { realIo, TICK_NAME, schedName, liveName, schedState, normDir } from './common.mjs';
import win from './win.mjs';
import systemd from './systemd.mjs';
import cron from './cron.mjs';
import launchd from './launchd.mjs';

export { realIo, TICK_NAME, schedName, liveName, schedState, normDir };
export const ADAPTERS = { 'windows-task': win, systemd, cron, launchd };
export function adapterFor(kind) {
  const a = ADAPTERS[kind];
  if (!a) throw new Error(`no scheduler adapter for ${JSON.stringify(kind)} (${Object.keys(ADAPTERS).join(' | ')}): set machine.json scheduler.kind to one of them, or run "norn tick --reason schedule" every <interval_min> min from your own scheduler`);
  return a;
}
// `norn sched install | remove`: the task of THIS name -> the lines to print
export function schedApply(op, a, o, kind, io = realIo) {
  const lines = [];
  if (op === 'install') { a.install(o, io); lines.push(`scheduler ${kind} '${o.name}' installed (every ${o.interval_min} min)`); }
  else if (schedState(a, o, io).installed) { a.remove(o, io); lines.push(`scheduler ${kind} '${o.name}' removed`); }
  else lines.push(`scheduler ${kind} '${o.name}': not installed`);
  return lines;
}
