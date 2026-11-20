#!/usr/bin/env node
// The FAKE executor (`norn run --executor fake`): stands in for a headless claude worker in tests and `norn smoke`.
// The brief drives it, one "key: value" per line: on_pause (1: obey the owner's pause order - poll mail, end HANDOFF), mode (done | stopped | handoff | handoff-once | no-result | crash | sleep | term | orphan),
// say (a line on stderr = the run log), cache_read (the final's cache_read_input_tokens, default 20), ms (wait before finishing), read (files read at the end, logged in NOTES; one missing = STOPPED), until (file: finish once it exists - no clock; a test releases it), pids (file: {pid, grandchild} - sleep mode spawns a grandchild so a tree kill can be checked), done_via (cli: end through the real `norn done` CLI, not result.mjs).
// It appends a NOTES block (its free-form log), writes the run's result as `norn done` does (gap #3: done | stopped | handoff, with a
// hand-off text; no-result / crash / term write none) and prints a claude-like `--output-format json` result on stdout.
// FAKE_RESULT=<file> (env): a read-only agent's answer - its text is the final `result`, no NOTES block nor result is written (META-ADOPT A2: a canned draft).
// FAKE_RO_RESULT=<file> (env): the same for a read-only launch only (--read-only; META-DOD 3: a plan review beside its writing plan run).
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { writeResult } from '../lib/result.mjs';

const NORN = fileURLToPath(new URL('./norn.mjs', import.meta.url));

const arg = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const brief = Object.fromEntries(fs.readFileSync(arg('brief'), 'utf8').split(/\r?\n/).map(l => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
// writes: F = the worker writes its NOTES to F, the file its brief names, whatever --notes the launcher read (META-MERGE-MARKER)
const notes = brief.writes || arg('notes');
const resumes = Number(arg('resumes') || 0);
// a nudge (META-GTP-MAIL): --resume <sid> --prompt <mail> = the same session resumed; it follows brief.resumed_mode (default done), no until
// --prompt-stdin: a long prompt comes on stdin, as claude -p reads one (harness/common.mjs PROMPT_ARG_MAX)
const resumeSid = arg('resume'), resumePrompt = process.argv.includes('--prompt-stdin') ? fs.readFileSync(0, 'utf8') : arg('prompt');
let mode = resumeSid ? (brief.resumed_mode || 'done') : (brief.mode || 'done');
if (mode === 'handoff-once') mode = resumes === 0 ? 'handoff' : 'done';
const ms = Number(brief.ms || process.env.FAKE_MS || (mode === 'sleep' ? 60000 : 0));

// NORN-WATCH S5: orphan = a short-lived parent starts a detached sleeper and exits first (a shot tool's headless browser)
if (mode === 'orphan' && brief.pids) {
  const inner = `const g = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' }); g.unref(); require('fs').writeFileSync(${JSON.stringify(brief.pids)}, JSON.stringify({ orphan: g.pid, parent: process.pid }));`;
  spawnSync(process.execPath, ['-e', inner], { stdio: 'ignore', windowsHide: true });
}
if (mode === 'sleep' && brief.pids) {
  const g = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' });
  // atomic: a test reads the file the moment it exists, and a stop can kill this process mid-write (an empty pids file)
  fs.writeFileSync(brief.pids + '.tmp', JSON.stringify({ pid: process.pid, grandchild: g.pid }));
  fs.renameSync(brief.pids + '.tmp', brief.pids);
}

// a provider run (META-EXEC-S1): say which endpoint reached the child, never the key itself
if (process.env.ANTHROPIC_BASE_URL) process.stderr.write(`fake: provider base_url=${process.env.ANTHROPIC_BASE_URL} model=${process.env.ANTHROPIC_MODEL ?? '-'} token=${process.env.ANTHROPIC_AUTH_TOKEN ? 'set' : 'unset'}\n`);

if (brief.say) process.stderr.write(brief.say + '\n');   // a log line (e.g. a usage-limit message)
// META-CTX-ENFORCE R1: ctx_dir + ctx_steps (contexts, comma-separated) [+ ctx_ms]: a claude-shaped transcript <ctx_dir>/<META_SESSION_ID>.jsonl
// gains one assistant request per step, every ctx_ms (default 100) - its context = input + cache read + cache creation of that request
if (brief.ctx_dir && brief.ctx_steps && process.env.META_SESSION_ID) {
  const file = `${brief.ctx_dir}/${process.env.META_SESSION_ID}.jsonl`, steps = brief.ctx_steps.split(',').map(Number);
  fs.mkdirSync(brief.ctx_dir, { recursive: true });
  steps.forEach((c, i) => setTimeout(() => fs.appendFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), requestId: `fake-${i}`,
    message: { id: `fake-msg-${i}`, model: 'fake', role: 'assistant', content: [{ type: 'text', text: 'step' }],
      usage: { input_tokens: 4, cache_read_input_tokens: c - 1004, cache_creation_input_tokens: 1000, output_tokens: 5 } } }) + '\n'), (i + 1) * Number(brief.ctx_ms || 100)));
}
// env: NAME,.. = log those env vars as the run saw them (OOTB-R2 N-16: what the supervisor hands the agent)
for (const k of (brief.env || '').split(',').map(x => x.trim()).filter(Boolean)) process.stderr.write(`fake env ${k}=${process.env[k] ?? ''}\n`);
const finishRun = () => {
  // `read`: files (comma-separated) the worker reads at its end, as a live worker reads its rules late (META-ONBOARD cut-over test);
  // each is logged in NOTES, one that does not resolve = STOPPED
  const reads = (brief.read || '').split(',').map(x => x.trim()).filter(Boolean).map(r => { try { return `read ${r}: ${fs.readFileSync(r).length} bytes`; } catch (e) { return `read ${r}: FAILED ${e.code}`; } });
  if (reads.some(r => r.includes(': FAILED '))) mode = 'stopped';
  if (notes && reads.length) fs.appendFileSync(notes, reads.join('\n') + '\n');
  const end = { done: { outcome: 'done' }, sleep: { outcome: 'done' }, orphan: { outcome: 'done' }, stopped: { outcome: 'stopped', why: 'c - fixture says so' },
    handoff: { outcome: 'handoff', handoff: 'next: the fake step' } }[mode];
  const resumed = resumeSid ? `resumed session ${resumeSid} prompt: ${resumePrompt}\n` : '';
  const cannedFile = process.env.FAKE_RESULT || (process.argv.includes('--read-only') ? process.env.FAKE_RO_RESULT : undefined);
  const canned = cannedFile ? fs.readFileSync(cannedFile, 'utf8') : null;
  if (notes && canned === null && mode !== 'crash') fs.appendFileSync(notes, `## fake ${process.env.META_RUN_ID || ''} (resumes ${resumes})\n${resumed}work: ${mode}\n`);
  // the run's end, as a worker ends it: `norn done` (done_via: cli = through the real CLI)
  if (end && canned === null && process.env.META_RESULT_DIR) {
    if (brief.done_via === 'cli') {
      const r = spawnSync(process.execPath, [NORN, 'done', '--outcome', end.outcome, ...(end.why ? ['--why', end.why] : []), ...(end.handoff ? ['--handoff', end.handoff] : [])], { encoding: 'utf8', windowsHide: true });
      process.stderr.write(`fake: norn done exit ${r.status}: ${(r.stdout || r.stderr || '').trim()}\n`);
    } else writeResult(process.env.META_RESULT_DIR, { run: process.env.META_RUN_ID, ...end });
  }
  process.stdout.write(JSON.stringify({ type: 'result', is_error: mode === 'crash', result: canned ?? `fake ${mode}`, session_id: process.env.META_SESSION_ID || null,
    total_cost_usd: 0, usage: { input_tokens: 10, cache_read_input_tokens: Number(brief.cache_read ?? 20), cache_creation_input_tokens: 30, output_tokens: 5 } }));
  process.exitCode = mode === 'crash' ? 3 : mode === 'term' ? 143 : 0;   // term: an external SIGTERM's exit code (S5)
};
// `until`: live until the test releases the run (or stops it) - event-based, so a loaded machine cannot outrun a fixed clock
let main;
if (brief.until && !resumeSid) { main = setInterval(() => { if (fs.existsSync(brief.until)) { clearInterval(main); finishRun(); } }, 50); }
else main = setTimeout(finishRun, ms);
// on_pause: a worker that obeys the owner's pause order (RM-37): it takes its mail as the PostToolUse hook would, between steps, and
// on the PAUSE order acks it and ends HANDOFF at once (its "clean point")
if (brief.on_pause && process.env.META_RUN_ID && process.env.META_RUN_STATE) {
  const { checkMail, ackMail } = await import('../lib/mail.mjs');
  const run = process.env.META_RUN_ID, state = process.env.META_RUN_STATE;
  const poll = setInterval(() => {
    let got = []; try { got = checkMail(state, { by: 'worker', run, via: 'hook' }); } catch { /* the log is busy: next poll */ }
    const m = got.find(x => /^PAUSE/.test(x.data.subject));
    if (!m) return;
    clearInterval(poll); clearInterval(main); clearTimeout(main);
    ackMail(state, { by: 'worker', run, id: m.id });
    mode = 'handoff'; finishRun();
  }, 100);
  poll.unref();   // the run lives as long as its own timer; the poll never keeps it alive
}
