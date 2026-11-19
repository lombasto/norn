// META-GTP-FLOW (GT-PARITY-PLAN sec. 2.9; Gas Town formulas - cited, not ported: `[[steps]]` id / title / needs,
// internal/formula/formulas/mol-dog-checkpoint.formula.toml:43-58; ReadySteps skips closed steps, internal/formula/parser.go:363-383;
// the checkpoint file, internal/checkpoint/checkpoint.go:19-28,163-168; docs/concepts/molecules.md:22-24).
// A flow = engine/flows/<name>.json (JSON: zero deps): vars + steps. `norn flow start` instantiates it as an EPIC of queued runs
// chained by after: (needs -> run:RUN-n:done | merged, or a q: / dir: / run: / dlv: term). The run records ARE the checkpoint.
//
// Schema (validateFlow refuses anything else):
//   name, title (the epic title; placeholders allowed), priority? (P0-P3, default P2), vars: { <name>: { doc?, default?, required? } }
//   (a var with a default is optional; else required), defaults: { any step field }, steps: [{
//     id, title, needs: [<step id> | "<kind>:<id>[:<state>]" after term | "{{var}}" holding terms; a term whose placeholder renders empty is dropped],
//     need_state: done | merged (what this step waits for of its step needs; default done),
//     class (CLASSES) | executor (+ model, effort), agent?, budget_min, stage?, lane, worktree, notes,
//     brief_template: "<file relative to the flow dir>" | { builtin: "merge", args: { <renderMergeBrief option>: "<template>" } },
//     ask?: <optional var> - the step may end STOPPED on an owner Q; `norn flow resume --var <ask>=Q-n` then passes the step and
//            its successors wait for q:Q-n:answered instead of the step's run }]
// Placeholders {{x}}: a declared var or a builtin (BUILTIN_VARS). One schema for every flow: no code branch names a flow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAfter, AfterError, checkRefs, makeEval } from './after.mjs';
import { record, loadState, RecordError, idNum } from './records.mjs';
import { loadEpics } from './epics.mjs';
import { renderMergeBrief } from './mergebrief.mjs';

export class FlowError extends Error {}
export const FLOWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'flows');
// executor classes (a project dispatch skill's executor ladder as data); model = the norn run default of the executor
export const CLASSES = {
  planner: { executor: 'claude', effort: 'high' },
  implementer: { executor: 'claude', effort: 'medium' },
  runner: { executor: 'claude', effort: 'low' },
  sol: { executor: 'codex-sol', effort: 'medium' },
  astra: { executor: 'codex-astra', effort: 'medium' },
};
export const BUILTIN_VARS = ['flow', 'epic', 'step', 'briefs_dir', 'norn', 'meta', 'project', 'state'];   // meta = the old name of norn (META-NAME-W3)
const BUILTINS = {
  // wraps `norn merge-brief` (mergebrief.mjs): the MERGE stage brief of a lane
  merge: (p, a) => renderMergeBrief(p, { lane: a.lane, branch: a.branch, worktree: a.worktree || undefined, notes: a.notes, ui: !!a.ui && !/^(0|no|false)$/i.test(a.ui), sha: a.sha || undefined }),
};
const STEP_FIELDS = ['id', 'title', 'needs', 'need_state', 'class', 'executor', 'model', 'effort', 'agent', 'budget_min', 'stage', 'lane', 'worktree', 'notes', 'brief_template', 'ask'];
const NEED_STATES = ['done', 'merged'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const ID_RE = /^[a-z][a-z0-9-]*$/;
const PH_RE = /\{\{(\w+)\}\}/g;
const TERM_RE = /^((q|dir|run|dlv):|\{\{\w+\}\}$)/;   // a term, or one var holding term(s) ("run:RUN-5:done,q:Q-2"; empty = no need)
const placeholders = s => [...String(s ?? '').matchAll(PH_RE)].map(m => m[1]);

/** loadFlow(name, { dir }) -> the validated flow (dir default engine/flows); a name with a path separator / .json is a file */
export function loadFlow(name, { dir = FLOWS_DIR } = {}) {
  const file = /[\\/]|\.json$/.test(name) ? path.resolve(name) : path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) throw new FlowError(`no flow ${name} (${file.replace(/\\/g, '/')})`);
  let def;
  try { def = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new FlowError(`${name}: not JSON: ${e.message}`); }
  return validateFlow(def, { dir: path.dirname(file) });
}

/** validateFlow(def, { dir }) -> { ...def, vars, steps (defaults applied, class resolved), order (topological), dir }; throws FlowError */
export function validateFlow(def, { dir }) {
  const bad = m => { throw new FlowError(`flow ${def?.name ?? '?'}: ${m}`); };
  if (!def || typeof def !== 'object') bad('not an object');
  if (typeof def.name !== 'string' || !ID_RE.test(def.name)) bad('name must match ' + ID_RE);
  if (typeof def.title !== 'string' || !def.title) bad('title is required');
  if (def.priority !== undefined && !PRIORITIES.includes(def.priority)) bad(`priority is ${PRIORITIES.join(' | ')}`);
  const vars = def.vars ?? {};
  if (typeof vars !== 'object' || Array.isArray(vars)) bad('vars must be an object');
  for (const [k, v] of Object.entries(vars)) {
    if (!/^\w+$/.test(k) || BUILTIN_VARS.includes(k)) bad(`var ${k}: a word, not a builtin (${BUILTIN_VARS.join(', ')})`);
    if (!v || typeof v !== 'object') bad(`var ${k}: want { doc?, default?, required? }`);
    if (v.default !== undefined && typeof v.default !== 'string') bad(`var ${k}: default must be a string`);
  }
  const required = k => vars[k].required ?? vars[k].default === undefined;
  if (!Array.isArray(def.steps) || !def.steps.length) bad('at least one step');
  const defaults = def.defaults ?? {};
  for (const k of Object.keys(defaults)) if (!STEP_FIELDS.includes(k) || ['id', 'title', 'needs'].includes(k)) bad(`defaults.${k}: not a default-able step field`);
  const ids = new Set();
  const steps = def.steps.map(raw => {
    const s = { ...defaults, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) };
    const sb = m => bad(`step ${s.id ?? '?'}: ${m}`);
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) sb('id must match ' + ID_RE);
    if (ids.has(s.id)) bad(`duplicate step id ${s.id}`);
    ids.add(s.id);
    for (const k of Object.keys(s)) if (!STEP_FIELDS.includes(k)) sb(`unknown field ${k}`);
    if (typeof s.title !== 'string' || !s.title) sb('title is required');
    s.needs = s.needs ?? [];
    if (!Array.isArray(s.needs) || s.needs.some(n => typeof n !== 'string')) sb('needs must be a list of strings');
    s.need_state = s.need_state ?? 'done';
    if (!NEED_STATES.includes(s.need_state)) sb(`need_state is ${NEED_STATES.join(' | ')}`);
    if (s.class !== undefined && s.executor !== undefined) sb('a class or executor, not both');
    if (s.class === undefined && s.executor === undefined) sb('a class or an executor is required');
    if (s.class !== undefined) {
      const c = CLASSES[s.class];
      if (!c) sb(`unknown class ${JSON.stringify(s.class)} (${Object.keys(CLASSES).join(' | ')})`);
      if (s.model !== undefined) sb('model goes with an executor, not a class');
      s.executor = c.executor; s.effort = s.effort ?? c.effort;
    }
    if (typeof s.budget_min !== 'number' || !(s.budget_min > 0)) sb('budget_min must be a positive number');
    for (const k of ['lane', 'worktree', 'notes']) if (typeof s[k] !== 'string' || !s[k]) sb(`${k} is required (step or defaults)`);
    for (const k of ['executor', 'model', 'effort', 'agent', 'stage']) if (s[k] !== undefined && (typeof s[k] !== 'string' || !s[k])) sb(`${k} must be a string`);
    const bt = s.brief_template;
    let tplText = '';
    if (typeof bt === 'string') {
      const f = path.resolve(dir, bt);
      if (!fs.existsSync(f)) sb(`brief_template ${bt} does not exist (${f.replace(/\\/g, '/')})`);
      tplText = fs.readFileSync(f, 'utf8');
      s.brief_file = f;
    } else if (bt && typeof bt === 'object') {
      if (!BUILTINS[bt.builtin]) sb(`unknown builtin ${JSON.stringify(bt.builtin)} (${Object.keys(BUILTINS).join(' | ')})`);
      if (!bt.args || typeof bt.args !== 'object' || Object.values(bt.args).some(v => typeof v !== 'string')) sb('builtin args must be an object of strings');
      tplText = Object.values(bt.args).join('\n');
    } else sb('brief_template is required (a template file or { builtin, args })');
    if (s.ask !== undefined) {
      if (!vars[s.ask]) sb(`ask var ${s.ask} is not declared`);
      if (required(s.ask)) sb(`ask var ${s.ask} must not be required (give it a default)`);
    }
    // every placeholder of every field + the template text is a declared var or a builtin
    const texts = [s.title, ...s.needs, s.need_state, s.executor, s.model, s.effort, s.agent, s.stage, s.lane, s.worktree, s.notes, tplText];
    for (const p of texts.flatMap(placeholders)) if (!vars[p] && !BUILTIN_VARS.includes(p)) sb(`missing var {{${p}}} (declare it in vars)`);
    return s;
  });
  for (const p of placeholders(def.title)) if (!vars[p] && !BUILTIN_VARS.includes(p)) bad(`title: missing var {{${p}}}`);
  for (const s of steps) for (const n of s.needs) {
    if (n === s.id) bad(`step ${s.id}: needs itself`);
    if (!ids.has(n) && !TERM_RE.test(n)) bad(`step ${s.id}: unknown need ${JSON.stringify(n)} (a step id, a q: / dir: / run: / dlv: term or a {{var}} of terms)`);
  }
  return { ...def, vars, steps, order: topo(steps, bad), dir };
}

// the steps in dependency order (declaration order among the ready ones); a cycle is refused with its path
function topo(steps, bad) {
  const by = Object.fromEntries(steps.map(s => [s.id, s]));
  const deps = s => s.needs.filter(n => by[n]);
  const out = [], mark = {};
  const visit = (id, trail) => {
    if (mark[id] === 'done') return;
    if (mark[id] === 'open') bad(`cycle: ${[...trail.slice(trail.indexOf(id)), id].join(' -> ')}`);
    mark[id] = 'open';
    for (const d of deps(by[id])) visit(d, [...trail, id]);
    mark[id] = 'done';
    out.push(id);
  };
  for (const s of steps) visit(s.id, []);
  return out;
}

/** the var values of a start: defaults + given; unknown or missing required -> FlowError */
export function flowVars(f, given = {}) {
  for (const k of Object.keys(given)) if (!f.vars[k]) throw new FlowError(`flow ${f.name}: unknown var ${k} (vars: ${Object.keys(f.vars).join(', ') || 'none'})`);
  const v = {};
  for (const [k, d] of Object.entries(f.vars)) {
    const x = given[k] ?? d.default;
    if (x === undefined || ((d.required ?? d.default === undefined) && x === '')) throw new FlowError(`flow ${f.name}: missing var ${k}${d.doc ? ` (${d.doc})` : ''}`);
    v[k] = String(x);
  }
  return v;
}

const fill = (s, v) => String(s).replace(PH_RE, (_, k) => v[k] ?? '');

/**
 * renderFlow(f, given, ctx) -> { title, priority, vars, steps: [{ ...step fields rendered, needs: [{ step, state } | { term }], brief }] }
 * in dependency order. ctx: { epic, briefs_dir, norn (meta = its old name), project (a loaded project.json or null), state } = the builtin vars.
 */
export function renderFlow(f, given = {}, ctx = {}) {
  const vars = flowVars(f, given);
  const base = { flow: f.name, epic: ctx.epic ?? '', briefs_dir: ctx.briefs_dir ?? '', norn: ctx.norn ?? ctx.meta ?? '', meta: ctx.norn ?? ctx.meta ?? '', project: ctx.project?.name ?? '', state: ctx.state ?? '', ...vars };
  const by = Object.fromEntries(f.steps.map(s => [s.id, s]));
  const steps = f.order.map(id => {
    const s = by[id], v = { ...base, step: id };
    const needs = s.needs.flatMap(n => {
      if (by[n]) return [{ step: n, state: s.need_state }];
      if (placeholders(n).some(p => v[p] === '')) return [];   // an optional var left empty = no such need
      const t = fill(n, v);
      try { return parseAfter(t).map(term => ({ term })); } catch (e) { if (e instanceof AfterError) throw new FlowError(`flow ${f.name}: step ${id}: need ${JSON.stringify(t)}: ${e.message}`); throw e; }
    });
    const r = { id, title: fill(s.title, v), needs, need_state: s.need_state, ask: s.ask };
    for (const k of ['executor', 'model', 'effort', 'agent', 'stage', 'lane', 'worktree', 'notes']) if (s[k] !== undefined) r[k] = fill(s[k], v);
    r.budget_min = s.budget_min;
    const bt = s.brief_template;
    if (typeof bt === 'string') r.brief = fill(fs.readFileSync(s.brief_file, 'utf8'), v);
    else {
      const args = Object.fromEntries(Object.entries(bt.args).map(([k, x]) => [k, fill(x, v)]));
      // the flow's state dir is the project's for the builtin: a merge's worktree lives under the state its run records in (GAP-6)
      const p = { ...(ctx.project || { name: base.project || 'project' }), ...(ctx.state ? { state: ctx.state } : {}) };
      try { r.brief = BUILTINS[bt.builtin](p, args); } catch (e) { throw new FlowError(`flow ${f.name}: step ${id}: ${bt.builtin}: ${e.message}`); }
    }
    return r;
  });
  return { title: fill(f.title, base), priority: f.priority ?? 'P2', vars, steps };
}

// ---------- piece 2: start / status / resume. The run records ARE the checkpoint (a run's data.flow = { name, step, vars }) ----------
const briefPath = (dir, ep, step, attempt) => path.join(dir, `flow-${ep}-${step}${attempt > 1 ? `-r${attempt}` : ''}-brief.md`);
function writeBrief(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, text, { flag: 'wx' }); } catch (e) { if (e.code === 'EEXIST') throw new FlowError(`${file.replace(/\\/g, '/')} exists already (never overwritten)`); throw e; }
  return file;
}
const termsOf = steps => steps.flatMap(s => s.needs.filter(n => n.term).map(n => n.term));
const refsOk = (f, state, terms) => {
  try { checkRefs(state, terms); } catch (e) { if (e instanceof AfterError) throw new FlowError(`flow ${f.name}: ${e.message.replace(/^--after /, 'need ')}`); throw e; }
};

/**
 * startFlow(f, given, o) - o: { state, by, ctx (renderFlow builtins: briefs_dir, norn, project), priority?, dryRun?, launch }.
 * launch(step, { after, brief, epic, flow }) -> { run, queued, why } queues / starts ONE run (norn.mjs: runSpec + startRun).
 * Everything is checked before the first record (vars, need terms exist); a dry run writes nothing.
 * Returns { epic, title, priority, steps: [{ id, run, queued, why, after, brief }] } (dry: epic null, run null, text = the brief).
 */
export function startFlow(f, given, { state, by, ctx = {}, priority, dryRun = false, launch }) {
  if (priority !== undefined && !PRIORITIES.includes(priority)) throw new FlowError(`--priority ${priority}: want ${PRIORITIES.join(' | ')}`);
  const pre = renderFlow(f, given, { ...ctx, state, epic: 'EP-?' });
  refsOk(f, state, termsOf(pre.steps));
  if (!ctx.briefs_dir) throw new FlowError('no briefs dir (project briefs_dir or --briefs-dir)');
  const prio = priority ?? pre.priority;
  if (dryRun) {
    return { epic: null, title: pre.title, priority: prio, steps: pre.steps.map(s => ({ id: s.id, run: null, executor: s.executor, lane: s.lane, stage: s.stage,
      after: s.needs.map(n => (n.step ? `run:<${n.step}>:${n.state}` : `${n.term.kind}:${n.term.id}:${n.term.state}`)), brief: briefPath(ctx.briefs_dir, 'EP-?', s.id, 1), text: s.brief })) };
  }
  const epic = record(state, { kind: 'epic', ev: 'create', by, data: { title: pre.title.slice(0, 200), priority: prio, members: [] } }, { views: false }).id;
  const r = renderFlow(f, given, { ...ctx, state, epic });
  return { epic, title: r.title, priority: prio, steps: launchSteps(f, r, r.steps, { epic, ctx, launch, runs: {}, attempts: {} }) };
}

// queue the rendered steps `todo` (dependency order); runs: step -> the run a step need points at; passed: step -> Q-n (ask)
function launchSteps(f, r, todo, { epic, ctx, launch, runs, attempts, passed = {} }) {
  const out = [];
  for (const s of todo) {
    const after = s.needs.map(n => (n.term ? n.term : passed[n.step] ? { kind: 'q', id: passed[n.step], state: 'answered' } : { kind: 'run', id: runs[n.step], state: n.state }));
    const brief = writeBrief(briefPath(ctx.briefs_dir, epic, s.id, (attempts[s.id] ?? 0) + 1), s.brief);
    const res = launch(s, { after, brief, epic, flow: { name: f.name, step: s.id, vars: r.vars } });
    runs[s.id] = res.run;
    out.push({ id: s.id, run: res.run, queued: !!res.queued, why: res.why, after: after.map(c => `${c.kind}:${c.id}:${c.state}`), brief });
  }
  return out;
}


// a launch = a run the flow queued (not the fill / HANDOFF resume / limit re-queue of one: those carry the same data.flow)
const isLaunch = r => !r.data.from_queue && !r.data.resume_of && !r.data.requeue_of;
// where a launch is now: through its fill (fill.next) and HANDOFF auto-resumes (resume.next), as after.mjs follows them
function current(items, r, seen = new Set()) {
  while (r && !seen.has(r.id)) {
    seen.add(r.id);
    const next = r.state === 'filled' ? r.fill?.next : r.state === 'exited' && r.end?.outcome === 'handoff' ? r.resume?.next : null;
    if (!next || !items[next]) return r;
    r = items[next];
  }
  return r;
}
// a step's state from its latest launch: done | queued | running | gone (why) | passed (ask: ended STOPPED, its ask var names the Q) | none
function stepRow(s, mine, vars, ev, items) {
  const launches = mine.filter(isLaunch), r = launches[launches.length - 1];
  const row = { id: s.id, title: s.title, run: r?.id ?? null, runs: launches.map(x => x.id), state: 'none', why: null, ask_q: null };
  if (!r) return row;
  const cur = current(items, r), e = ev({ kind: 'run', id: r.id, state: 'done' });
  row.now = cur.id;   // the run the launch is now (its fill / HANDOFF successor)
  // META-AUTONOMY R1: a queued step whose own condition can no longer be met is held (never withdrawn) - for the flow it is gone
  const held = !e.met && !e.gone && cur.state === 'queued' ? (cur.data.after || []).map(c => ev(c).gone).find(Boolean) : null;
  if (held) row.held = true;
  if (e.met) row.state = 'done';
  else if (e.gone || held) {
    row.state = 'gone'; row.why = e.gone || held;
    if (s.ask && vars[s.ask] && cur.state === 'exited' && cur.end?.outcome === 'stopped') { row.state = 'passed'; row.ask_q = vars[s.ask]; }
  } else row.state = cur.state;
  return row;
}

/**
 * flowStatus(state, epic, { dir, ev, given }) -> { epic, flow, title, state, vars, done, f, steps: [{ id, title, run, runs, state, why, ask_q }] }
 * vars = the latest run's (a resume may add some) + given (a resume's overrides, checked).
 */
export function flowStatus(state, epic, { dir = FLOWS_DIR, ev = makeEval(state), given = {} } = {}) {
  const ep = loadEpics(state)[epic];
  if (!ep) throw new FlowError(`${epic} does not exist in ${state}`);
  const items = loadState(state).items;
  const runs = Object.values(items).filter(i => i.kind === 'run' && i.data.epic === epic && i.data.flow).sort((a, b) => idNum(a.id) - idNum(b.id));
  if (!runs.length) throw new FlowError(`${epic} is not a flow epic (no run of it carries a flow step)`);
  const last = runs[runs.length - 1].data.flow;
  const f = loadFlow(last.name, { dir });
  const vars = flowVars(f, { ...last.vars, ...given });
  const steps = f.order.map(id => stepRow(f.steps.find(s => s.id === id), runs.filter(x => x.data.flow.step === id), vars, ev, items));
  return { epic, flow: f.name, title: ep.data.title, state: ep.state, vars, f, steps, done: steps.every(s => ['done', 'passed'].includes(s.state)) };
}

/**
 * resumeFlow(state, epic, given, o): re-queue the FIRST gone step (dependency order) that is not passed, with every successor of it
 * that is not done (a still-queued successor is withdrawn first: its after names the gone run). Done steps never re-run. given =
 * var overrides (an ask var passes its STOPPED step). o: { dir, ctx, launch, dryRun }. Returns { epic, target, steps }; target null =
 * nothing to resume.
 */
export function resumeFlow(state, epic, given = {}, { dir = FLOWS_DIR, ctx = {}, launch, dryRun = false } = {}) {
  const st = flowStatus(state, epic, { dir, given });
  if (st.state !== 'open') throw new FlowError(`${epic} is ${st.state}`);
  const f = st.f, rows = Object.fromEntries(st.steps.map(s => [s.id, s]));
  const target = f.order.find(id => ['gone', 'none'].includes(rows[id].state));
  if (!target) return { epic, target: null, steps: [] };
  const set = new Set([target]);
  for (const s of f.order.map(id => f.steps.find(x => x.id === id))) if (!set.has(s.id) && s.needs.some(n => set.has(n)) && !['done', 'passed'].includes(rows[s.id].state)) set.add(s.id);
  const running = [...set].filter(id => rows[id].state === 'running');
  if (running.length) throw new FlowError(`${epic}: ${running.map(id => `${id} (${rows[id].run})`).join(', ')} still running - stop it first`);
  const r = renderFlow(f, st.vars, { ...ctx, state, epic });
  const todo = r.steps.filter(s => set.has(s.id));
  const passed = Object.fromEntries(st.steps.filter(s => s.state === 'passed').map(s => [s.id, s.ask_q]));
  refsOk(f, state, [...termsOf(todo), ...todo.flatMap(s => s.needs.filter(n => n.step && passed[n.step]).map(n => ({ kind: 'q', id: passed[n.step], state: 'answered' })))]);
  if (dryRun) return { epic, target, dry: true, steps: todo.map(s => ({ id: s.id, run: null })) };
  for (const id of set) if (rows[id].state === 'queued' || rows[id].held) {
    try { record(state, { kind: 'run', ev: 'withdraw', id: rows[id].now, by: 'launcher', data: { why: `flow resume ${epic} re-queues step ${id}` } }); } catch (e) { if (!(e instanceof RecordError)) throw e; }
  }
  const runs = Object.fromEntries(st.steps.filter(s => s.run).map(s => [s.id, s.run]));
  const attempts = Object.fromEntries(st.steps.map(s => [s.id, s.runs.length]));
  return { epic, target, steps: launchSteps(f, r, todo, { epic, ctx, launch, runs, attempts, passed }) };
}
