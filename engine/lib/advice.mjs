// META-TEND P4 (REPORT 4.4 "Advise"): model advice over the class cost table (classcost.mjs) and the vendor guidance DATA
// (engine/presets/advice/models.json: one row per model / harness, each with its source and the day it was read). Every finding is
// ADVISORY: the P1 finding shape { key, check, title, severity, path, line, id, text, fix } plus `change` (the Settings keys and
// values one tap writes through the Settings save path), `source` (ref, url, read, age_d, stale) and `trial`. Nothing changes a
// policy by itself: the Inbox card applies or keeps it, and that choice is a decision record (data.advice = key) that hides it.
// Rules (REPORT 4.4 "Rules worth shipping as data"):
//   mechanical-top-xhigh  chores / pass-fail / docs / merges on a top model (Opus, Fable) at xhigh or max
//   effort-above-start    a class set above the vendor's starting effort for its model with no measured gain (no lower-effort row
//                         of the same class + model that finished less often)
//   coordinator-priciest  a long-lived coordinator (check-in, chat) on the priciest model
//   effort-spread         one class + model whose effort levels differ > 1.5x in cost per finished task, the dearer one not finishing
//                         more often, while the setting is the dearer one
// Plus the digest's ONE line (advice.json: the last computed open cards, a cache beside the state, never a record).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WORK_CLASSES } from './policy.mjs';
import { CLASS_LABELS } from './workclass.mjs';

const DAY = 86400000;
export const ADVICE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'presets', 'advice', 'models.json');
export const MECHANICAL = ['chores', 'passfail', 'docs', 'merge'];
export const COORDINATORS = ['checkin_major', 'checkin_minor', 'chat'];
export const SPREAD = 1.5;
export const TRIAL_RUNS = 5;
const CHEAP = { model: 'claude-sonnet-5-5', effort: 'medium' }, DEFAULT_MODEL = 'claude-opus-5-5';

export const loadAdviceData = (file = ADVICE_FILE) => JSON.parse(fs.readFileSync(file, 'utf8'));
/** META-DASH-ASYNC R1: the advice table on fs.promises (the dash passes it to advise() as o.data) */
export const loadAdviceDataAsync = async (file = ADVICE_FILE) => JSON.parse(await fs.promises.readFile(file, 'utf8'));

// META-UX-BUILD S5: the kind of fix of a model advice card (advisory.mjs FIX_KINDS) - a Settings change the owner takes or leaves
export const ADVICE_FIX = { kind: 'call', ways: ['Try the change', 'Keep the current setting'] };

/** The Settings keys that set class `cls`'s model / effort, or null (no setting routes it). */
export function settingKeys(cls) {
  const coord = { checkin_major: ['checkin_model', 'checkin_effort'], checkin_minor: ['checkin_minor_model', 'checkin_minor_effort'],
    merge: ['policy.checkin.merge_model', 'policy.checkin.merge_effort'], chat: ['chat_model', 'chat_effort'] }[cls];
  if (coord) return { model: coord[0], effort: coord[1] };
  return Object.hasOwn(WORK_CLASSES, cls) ? { model: `policy.executors.${cls}.model`, effort: `policy.executors.${cls}.effort` } : null;
}
const getPath = (o, k) => k.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o);

/** The vendor row of a model name (lower-case substring match), or null. */
export const rowOf = (data, model) => (model ? data.rows.find(r => r.match && String(model).toLowerCase().includes(r.match)) ?? null : null);

/** Each source of each row with its age and stale flag (stale = read more than data.stale_days ago). */
export function sourcesOf(data, now = Date.now()) {
  return data.rows.flatMap(r => (r.sources || []).map(s => {
    const age = Math.floor((now - Date.parse(s.read + 'T00:00:00Z')) / DAY);
    return { row: r.id, ...s, age_d: Number.isFinite(age) ? age : null, stale: !Number.isFinite(age) || age > data.stale_days };
  }));
}

const fmtM = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));
const pc = x => Math.round(100 * x) + ' %';

/**
 * classes: classCost() of ONE project (rows with project, class, src, model, effort, stages, done_rate, cost_per_done);
 * settings: withDefaults(merged(budget, policy)) of that project; o: { project, data (models.json), now, decided (Set of keys) }
 * -> { cards (open, newest rule order), decided (count hidden), sources (dated), stale (sources past stale_days) }
 */
export function advise(classes, settings, o = {}) {
  const data = o.data || loadAdviceData(), now = o.now ?? Date.now(), project = o.project ?? null, decided = o.decided || new Set();
  const E = data.efforts, eff = x => E.indexOf(x), srcs = sourcesOf(data, now);
  const top = Math.max(...data.rows.map(r => r.tier ?? 0));
  const src = (rowId, ref) => srcs.find(s => s.row === rowId && (!ref || s.ref === ref)) ?? null;
  const rows = (classes?.rows || []).filter(r => !project || r.project === project);
  const cards = [], seen = new Set();
  const now_ = cls => { const k = settingKeys(cls); return k ? { model: getPath(settings, k.model) || '', effort: getPath(settings, k.effort) || '' } : null; };
  const add = (check, cls, severity, title, text, fix, change, source) => {
    const key = crypto.createHash('sha1').update(JSON.stringify([project, check, cls, change])).digest('hex').slice(0, 12);
    if (seen.has(key)) return;
    seen.add(key);
    cards.push({ key, check, title, severity, path: 'Settings', line: null, id: cls, text, fix, change, source, project,
      trial: `test for ${TRIAL_RUNS} runs, then keep or revert (Settings)`, decided: decided.has(key) });
  };
  const label = cls => CLASS_LABELS[cls] || cls;
  const evidence = rs => rs.map(r => `${r.model} ${r.effort}: ${r.stages} stage${r.stages === 1 ? '' : 's'}, ${pc(r.done_rate)} done${r.cost_per_done ? `, ${fmtM(r.cost_per_done)} per finished task` : ''}`).join('; ');

  // 1. a mechanical class on a top model at xhigh / max (measured runs, or the setting routes it there)
  for (const cls of MECHANICAL) {
    const k = settingKeys(cls), cur = now_(cls), heavy = r => (rowOf(data, r.model)?.tier ?? 0) >= 3 && eff(r.effort) >= eff('xhigh');
    const hit = rows.filter(r => r.class === cls && heavy(r)), set = cur && heavy(cur);
    if (!k || (!hit.length && !set)) continue;
    add('mechanical-top-xhigh', cls, 'medium', `${label(cls)} on a top model at xhigh`,
      `${hit.length ? 'Measured: ' + evidence(hit) + '.' : ''}${set ? ` The setting routes it to ${cur.model} ${cur.effort}.` : ''} Mechanical work; the vendor keeps xhigh for the hardest long-running work where a gain has been measured, and says Sonnet handles most coding tasks well.`.trim(),
      `set ${label(cls)} to ${CHEAP.model} ${CHEAP.effort}`, { [k.model]: CHEAP.model, [k.effort]: CHEAP.effort }, src('opus-5-5', 'MM'));
  }
  // 2. a class set above the vendor's starting effort for its model, no measured gain
  for (const cls of [...Object.keys(WORK_CLASSES), 'merge', ...COORDINATORS]) {
    const k = settingKeys(cls), cur = now_(cls), vr = rowOf(data, cur?.model);
    if (!k || !vr?.start_effort || eff(cur.effort) <= eff(vr.start_effort) || cards.some(c => c.id === cls)) continue;
    const same = rows.filter(r => r.class === cls && rowOf(data, r.model)?.id === vr.id), at = same.filter(r => r.effort === cur.effort);
    const lower = same.filter(r => eff(r.effort) >= 0 && eff(r.effort) < eff(cur.effort));
    const gain = at.length && lower.some(l => l.stages >= 3 && at.some(a => a.done_rate > l.done_rate));
    if (gain) continue;
    add('effort-above-start', cls, 'low', `${label(cls)} above the vendor's starting effort`,
      `The setting is ${cur.model} ${cur.effort}; the vendor's start for this model is ${vr.start_effort} (${vr.start_effort_from || vr.quote}). ${same.length ? 'Measured: ' + evidence(same) + '.' : 'No run of this class on this model in the window.'} No measured gain from the higher effort.`,
      `set ${label(cls)} effort to ${vr.start_effort}`, { [k.effort]: vr.start_effort }, src(vr.id, 'MM') ?? src(vr.id));
  }
  // 3. a long-lived coordinator on the priciest model
  for (const cls of COORDINATORS) {
    const k = settingKeys(cls), cur = now_(cls), priciest = m => (rowOf(data, m)?.tier ?? 0) === top;
    const hit = rows.filter(r => r.class === cls && priciest(r.model)), set = cur && priciest(cur.model);
    if (!k || (!hit.length && !set)) continue;
    add('coordinator-priciest', cls, 'medium', `${label(cls)} on the priciest model`,
      `${hit.length ? 'Measured: ' + evidence(hit) + '.' : ''}${set ? ` The setting is ${cur.model}.` : ''} A coordinator runs many short turns; the vendor: Opus 5.5 stays the default for most workloads, and Fable at high thinks before almost every reply.`.trim(),
      `set ${label(cls)} to ${DEFAULT_MODEL}`, { [k.model]: DEFAULT_MODEL }, src('fable', 'MM'));
  }
  // 4. one class + model whose effort levels differ > 1.5x in cost per finished task, the dearer not finishing more often
  const byCm = new Map();
  for (const r of rows.filter(r => r.cost_per_done && eff(r.effort) >= 0)) { const g = `${r.class}|${r.model}|${r.src}`; if (!byCm.has(g)) byCm.set(g, []); byCm.get(g).push(r); }
  for (const rs of byCm.values()) {
    const efforts = new Map();
    for (const r of rs) { const e = efforts.get(r.effort) || { effort: r.effort, stages: 0, done: 0, weighted: 0 }; e.stages += r.stages; e.done += r.done; e.weighted += r.cost_per_done * r.done; efforts.set(r.effort, e); }
    const es = [...efforts.values()].filter(e => e.done >= 2).map(e => ({ ...e, cost: e.weighted / e.done, rate: e.done / e.stages })).sort((a, b) => a.cost - b.cost);
    if (es.length < 2) continue;
    const cheap = es[0], dear = es[es.length - 1], cls = rs[0].class, k = settingKeys(cls), cur = now_(cls);
    if (dear.cost / cheap.cost <= SPREAD || dear.rate > cheap.rate || !k || cur?.effort !== dear.effort) continue;
    add('effort-spread', cls, 'medium', `${label(cls)}: ${dear.effort} costs ${(dear.cost / cheap.cost).toFixed(1)}x ${cheap.effort}`,
      `${rs[0].model}: ${dear.effort} ${fmtM(dear.cost)} per finished task (${dear.done} of ${dear.stages} done, ${pc(dear.rate)}) vs ${cheap.effort} ${fmtM(cheap.cost)} (${cheap.done} of ${cheap.stages}, ${pc(cheap.rate)}). The dearer level does not finish more often.`,
      `set ${label(cls)} effort to ${cheap.effort}`, { [k.effort]: cheap.effort }, src(rowOf(data, rs[0].model)?.id, 'MM') ?? src(rowOf(data, rs[0].model)?.id));
  }
  const open = cards.filter(c => !c.decided);
  return { project, at: new Date(now).toISOString(), cards: open, decided: cards.length - open.length, sources: srcs, stale: srcs.filter(s => s.stale) };
}

/** The advice keys a decision record already ruled (data.advice), from fold items. */
export const decidedKeys = items => new Set(items.filter(i => i.kind === 'decision' && i.data?.advice).map(i => i.data.advice));

export const adviceCacheFile = state => path.join(state, 'advice.json');
/** Write the last computed advice beside the state (a cache for the digest line; never a record). */
export function writeAdviceCache(state, a) {
  try { fs.writeFileSync(adviceCacheFile(state), JSON.stringify({ at: a.at, cards: a.cards.map(({ key, check, title, severity }) => ({ key, check, title, severity })), stale: a.stale.length }) + '\n'); } catch { /* a cache */ }
}
/** The digest's ONE line from the cache, or null when no card is open and no source is stale. */
export function adviceDigestRow(state) {
  let c;
  try { c = JSON.parse(fs.readFileSync(adviceCacheFile(state), 'utf8')); } catch { return null; }
  if (!c.cards?.length && !c.stale) return null;
  const top = c.cards?.[0];
  return { id: 'advice', line: `advice: ${c.cards.length} open on the Spend page${top ? ` (first: ${top.title})` : ''}${c.stale ? `; ${c.stale} vendor source${c.stale === 1 ? '' : 's'} past the re-read date` : ''} - counted ${c.at}` };
}
