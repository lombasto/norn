// META-CTX-ENFORCE R1 (owner DIR-56): the context limits of policy.context, ONE copy for every claude run Norn launches and the chat.
// The measure: a run's CURRENT context = its last request's input + cache read + cache creation (never a sum over requests); its
// peak is kept beside it. The levels (no_new_step_k / handoff_k / hard_max_k of the run's role, read from the CURRENT project policy):
// the PostToolUse hook (norn mail check --inject) tells a run once "no new step" and once the hand-off order; at the hard max the
// supervisor ends the run as HANDOFF (auto-resume as for any HANDOFF). The chat (chat.mjs) runs the same levels between its turns.
import fs from 'node:fs';
import path from 'node:path';
import { POLICY_DEFAULTS, withDefaults, merged } from './policy.mjs';
import { loadProject, compatTarget } from './config.mjs';
import { usageCtx, findTranscript } from './harness/claude.mjs';

export { usageCtx };
export const CTX_ROLES = Object.keys(POLICY_DEFAULTS.context);
const kTok = n => `${Math.round(n / 1000)}k`;

/** the policy.context row of a run (its start data or launch spec): check-ins their own row, the chat the controller's, else by agent name */
export function ctxRole(d = {}) {
  const a = String(d.agent || '');
  return d.kind === 'checkin' ? 'checkin' : d.kind === 'chat' ? 'controller' : /planner/.test(a) ? 'planner' : /runner/.test(a) ? 'runner' : 'implementer';
}
/** { role, no_new_step_k, handoff_k, hard_max_k } of `role` under `policy` (a project policy, defaults filled in) */
export function ctxLimits(policy, role) {
  const c = withDefaults(merged({}, policy || {})).policy.context;
  return { role, ...POLICY_DEFAULTS.context[role], ...(c[role] || {}) };
}
/** the context lines of a run as the dashboard shows them (bytes, not k): its role, hand-off line, hard max, no-new-step mark */
export function ctxView(d, policy) {
  const c = ctxLimits(policy, ctxRole(d));
  return { ctx_role: c.role, ctx_limit: c.handoff_k * 1000, ctx_hard: c.hard_max_k * 1000, ctx_no_step: c.no_new_step_k * 1000 };
}
/** the level a context has reached: null | 'no_new_step' | 'handoff' | 'hard_max' */
export function ctxLevel(ctx, c) {
  if (!Number.isFinite(ctx)) return null;
  return ctx >= c.hard_max_k * 1000 ? 'hard_max' : ctx >= c.handoff_k * 1000 ? 'handoff' : ctx >= c.no_new_step_k * 1000 ? 'no_new_step' : null;
}

/** a transcript's CURRENT context: the usage of its last assistant line (the tail first, the whole file when the tail has none) */
export function transcriptCtx(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    for (const n of [Math.min(size, 256 * 1024), size]) {
      const b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, size - n);
      const rows = b.toString('utf8').split(/\r?\n/);
      for (let i = rows.length - 1; i >= (n < size ? 1 : 0); i--) {   // a cut first row is no JSON line
        const r = rows[i];
        if (!r.includes('"usage"') || !r.includes('"assistant"')) continue;
        try { const j = JSON.parse(r); if (j.type === 'assistant' && j.message?.usage) return usageCtx(j.message.usage); } catch { /* not a line */ }
      }
      if (n === size) break;
    }
    return null;
  } finally { fs.closeSync(fd); }
}

/** the CURRENT context policy of a launch spec: its project.json (spec.ctx_from) read now; none (no ctx_from, or no such file) = the
 *  defaults. A launch with no project file (a check-in, a test) still starts and records its marks (RUN-188); a broken file still throws */
export function specPolicy(spec) {
  if (!spec?.ctx_from || !fs.existsSync(compatTarget(spec.ctx_from))) return {};
  return loadProject(spec.ctx_from).policy || {};
}

// ---------- the orders (the hand-off head is ONE copy: the chat's turn and a run's order start with it) ----------
const head = (ctx, limit) => `NORN HAND-OFF (from Norn, not the owner): this session's context is ${ctx}, past the hand-off point (${limit}).`;
export const handoffHead = (ctx, c) => head(kTok(ctx), `${c.handoff_k}k`);
/** the chat's hand-off turn ({ctx} / {limit} filled in by chat.mjs). Its reply goes to chat/handoff-<n>.md, not into the thread. */
export const HANDOFF_PROMPT = `${head('{ctx}', '{limit}')} After this turn Norn ends
this session and continues the thread in a fresh one that starts from what you write now.
Reply with the hand-off ONLY - no tool calls, no other text - in markdown with exactly these four headings:
## Open threads
- one line per thing the owner asked for that is not finished (with record ids: DIR- / DEC- / Q- / RUN-), or "- none"
## Promises to the owner
- what you said you would do or report, or "- none"
## Holds
- the lanes you hold and why (Norn lists the live holds itself too), or "- none"
## Next step
- the one next thing to do
The records are the memory: name their ids, do not restate them.`;
/** the order a launched run gets at `level` (the hook's additionalContext) */
export function runOrder(level, ctx, c) {
  if (level === 'no_new_step') return `NORN CONTEXT (from Norn, not the owner): this session's context is ${kTok(ctx)}, past the no-new-step mark (${c.no_new_step_k}k). `
    + `Start no new step: finish the step you are in and commit it. At ${c.handoff_k}k you hand off; at ${c.hard_max_k}k Norn ends this run.`;
  return `${handoffHead(ctx, c)} Hand off NOW: start no new step, commit your work (named files), write the hand-off (state, commits, `
    + `exact next step, open questions, verified vs not) to a file and run \`norn done --outcome handoff --handoff-file <it>\`, then end your turn. `
    + `At ${c.hard_max_k}k (hard max) Norn ends this run as HANDOFF whatever its state; a fresh run picks the brief up from the hand-off.`;
}

// ---------- the hook side: each order once per run (state/ctx/<run>.json { sent: [level] }) ----------
const sentFile = (state, run) => path.join(state, 'ctx', `${run}.json`);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
/**
 * The context order for run `run` of `state` after a tool call (its transcript found as the supervisor finds it: the launch spec's
 * projectsDir + session_id) - null when none is due. -> { text, level, ctx, limits } | null
 */
export function ctxOrder(state, run) {
  const spec = run ? readJson(path.join(state, 'runs', `${run}.spec.json`)) : null;
  const transcript = spec ? findTranscript(spec.projectsDir, spec.session_id) : null;
  if (!transcript) return null;
  const ctx = transcriptCtx(transcript), c = ctxLimits(specPolicy(spec), ctxRole(spec));
  const level = ctxLevel(ctx, c);
  if (!level) return null;
  const order = level === 'no_new_step' ? 'no_new_step' : 'handoff';   // past the hard max the hand-off order still goes (the supervisor ends it)
  const f = sentFile(state, run), sent = readJson(f)?.sent || [];
  if (sent.includes(order)) return null;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const { role: _r, ...marks } = c;   // WORK-SIZING S1: the marks this order went out under (the live policy may change after it)
  fs.writeFileSync(f, JSON.stringify({ sent: [...sent, order], marks, ctx, at: new Date().toISOString() }));
  return { text: runOrder(order, ctx, c), level: order, ctx, limits: c };
}
