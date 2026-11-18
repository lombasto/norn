#!/usr/bin/env node
// The cli adapter's EXIT WATCH (META-RUNTIME 3): `exit-watch.mjs --after S --result F -- <exe> <args...>`.
// Some headless CLIs finish their work but never exit (grok RUN-1616: its final answer 23:58Z, its session_end logged 00:04Z,
// stdin NUL, then the process sat idle until the controller stopped it 00:55Z - the hang is inside the CLI's own teardown).
// The watch runs the CLI with the same stdio (stdin / stdout = the final file / stderr = the log, all inherited) and ends the
// CLI's process tree once BOTH hold: the run's result file (gap #3: `norn done`, F = <state>/results/RUN-n/result.json) was written
// after the start and the CLI wrote nothing to stdout / stderr for S seconds. Then it exits 0, so the run ends by its result.
// Otherwise it exits with the CLI's own code. Node built-ins only.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { killTree } from '../lib/runs.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opt = n => { const i = argv.indexOf('--' + n); return i >= 0 && i < sep ? argv[i + 1] : undefined; };
const after = Number(opt('after'));
const result = opt('result');
const [exe, ...args] = argv.slice(sep + 1);
if (sep < 0 || !exe || !(after > 0) || !result) { process.stderr.write('usage: exit-watch.mjs --after S --result F -- <exe> <args...>\n'); process.exit(2); }

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const size = fd => { try { return fs.fstatSync(fd).size; } catch { return 0; } };
const before = read(result);
const child = spawn(exe, args, { stdio: 'inherit', windowsHide: true });
let ended = false;
let out = [size(1), size(2)];
// idle runs on the monotonic clock (META-GTP-CI-FILLWAKE F1): a wall-clock step (the WSL runner's ~16 s) never ends a quiet CLI early
const mono = () => performance.now();
let quietSince = mono();
const tickMs = Math.max(100, Math.min(1000, (after * 1000) / 4));
const timer = setInterval(() => {
  const now = [size(1), size(2)];
  if (now[0] !== out[0] || now[1] !== out[1]) { out = now; quietSince = mono(); return; }
  const res = read(result);
  if (res === null || res === before) return;                      // no result written since the start: nothing finished yet
  let outcome = null;
  try { outcome = JSON.parse(res)?.outcome ?? null; } catch { /* half written */ }
  if (!outcome) return;
  const idle = (mono() - quietSince) / 1000;
  if (idle < after) return;
  ended = true;
  clearInterval(timer);
  process.stderr.write(`exit watch: result ${outcome} written, ${exe} idle ${after} s - ended its process tree\n`);
  killTree(child.pid);
}, tickMs);
child.on('error', e => { clearInterval(timer); process.stderr.write(`exit watch: ${e.message}\n`); process.exit(127); });
child.on('exit', (code, signal) => {
  clearInterval(timer);
  if (ended) process.exit(0);
  process.exit(Number.isInteger(code) ? code : signal ? 1 : 0);
});
