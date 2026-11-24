// The Spend page (was Usage; ui-spend-slop, owner 2026-11-20): ONE screen - the last 24 h, the window's total, the runs, the guard,
// the top 5 spenders and the check-ins in one line - and the details drawer (the dashboard's .drawer, its view in the URL as &sub=,
// so Back closes it) with every breakdown: by lane, lane and stage, agent CLI, day, kind of work, check-ins, tokens, the forecast
// (/api/plan) and the advice cards. "Where the tokens went", "what each kind of work costs" and "API spend" are views of it, not pages
// of their own. The advice icon at the top counts the open cards and opens them; Clear all keeps every setting (one decision each).
// Data: /api/usage (engine/lib/cost.mjs per project) + the status strip (ctx.strip.usage: billing and the guard, machine-wide).
import { esc, fin, dash, int, mTok, pct, plural, chip, exClass, projTag, guardChip, filterChips, fmtTime } from '../cells.mjs';
import { bars, stack, meter } from '../widgets.mjs';
import { closeBtn } from '../norn/assets.mjs';

/** the drawer's views [id, label]: one breakdown at a time (&sub=<id>); no sub = the drawer is closed */
export const SPEND_VIEWS = [['lane', 'By lane'], ['stage', 'Lane and stage'], ['cli', 'Agent CLI'], ['day', 'By day'], ['work', 'Kind of work'],
  ['checkins', 'Check-ins'], ['tokens', 'Tokens'], ['forecast', 'Forecast'], ['advice', 'Advice']];
export const spendView = sub => (SPEND_VIEWS.some(([k]) => k === sub) ? sub : null);

// META-TEND P4: one model-advice card - what, why (the measured numbers), the vendor source and the day it was read (stale = past the
// re-read date), the proposed Settings change and one tap: apply it, or keep the setting. Both write a decision record; nothing is automatic.
export function adviceRow(i, ctx) {
  const s = i.source || {}, ch = Object.entries(i.change || {}).map(([k, v]) => `${k} = ${v}`).join(', ');
  return `<div class="item advice" id="adv-${esc(i.key ?? i.id)}">${chip(i.severity === 'low' ? 'idle' : 'warn', 'advice')}<div style="flex:1;min-width:0"><b>${esc(i.title)}</b>
    <div class="small">${esc(i.text)}</div>
    <div class="small mute">${projTag(ctx, i.project)}source <b>${esc(s.ref ?? '-')}</b> ${esc(s.title ?? '')} · read <span class="mono">${esc(s.read ?? '-')}</span>${s.stale ? ' ' + chip('warn', 'stale: re-read it') : ` (${s.age_d ?? '-'} d ago)`}</div>
    <div class="small">Change: <span class="mono">${esc(ch)}</span> <span class="mute">- ${esc(i.trial ?? '')}</span></div></div>
    <span class="spacer"></span><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="primary" data-act="advice-apply" data-project="${esc(i.project)}" data-key="${esc(i.key ?? i.id)}">Apply</button><button class="ghost" data-act="advice-keep" data-project="${esc(i.project)}" data-key="${esc(i.key ?? i.id)}">Keep as is</button></div></div>`;
}
// API billing (lib/billing.mjs): no weekly limit - the Tokens view shows the last 24 h of spend against the daily $ cap instead
// OVERVIEW-TRUTH (4): every figure names its scope - this spend is the whole machine's (every project; billing.mjs spendUsd), the
// By lane view's API spend is one project's by lane (spendBreakdown), today = since local midnight
function apiBurn(b) {
  const $ = v => `$${(Number(v) || 0).toFixed(2)}`, cap = fin(b.cap) && b.cap > 0 ? b.cap : null, over = cap !== null && b.usd >= cap;
  const c = over ? chip('bad', 'daily cap reached: no new Claude work') : cap === null ? chip('warn', 'no daily cap') : chip('ok', 'under the daily cap');
  return `<div class="kv" id="burn-api"><span class="mute small">last 24 h, this machine (every project)</span><div><span class="big">${$(b.usd)}</span> <span class="mute">${cap === null ? 'spent' : `of the ${$(cap)} daily cap`}</span> ${c}${cap === null ? '' : meter(b.usd, cap, null, over || b.usd > cap * 0.8 ? 'hot' : '')}</div>
     <span class="mute small">runs</span><div class="small" id="burn-api-parts">${$(b.ended_usd ?? b.usd)} from ${plural(b.runs, 'Claude run')} ended in the last 24 h (every project) · ${$(b.live_usd)} running${b.live_runs ? ` (${plural(b.live_runs, 'run')}, estimate)` : ''}${b.chat_turns ? ` · ${$(b.chat_usd)} dashboard chats` : ''}</div>
     <span class="mute small">guard</span><div class="small mute">none weekly: API billing has no weekly limit${cap === null ? '. Set a daily cap in Settings (API daily cap) to stop spend past it' : ''}</div></div>`;
}
// ---------- spend (META-OPS-R1 #7): cost per lane / stage / executor / day from /api/usage (engine/lib/cost.mjs) ----------
/** Group roll-up rows by keys: Claude token types + % summed, Codex / provider tokens apart; sorted by % then Codex tokens. */
export function spendGroup(rows, keys) {
  const m = new Map();
  for (const r of rows) {
    const k = keys.map(x => r[x]).join('|');
    let g = m.get(k);
    if (!g) m.set(k, g = { ...Object.fromEntries(keys.map(x => [x, r[x]])), runs: 0, running: 0, cache_read: 0, cache_create: 0, input: 0, output: 0,
      pct: null, codex: 0, provider: 0, executors: [] });
    g.runs += r.runs; g.running += r.running;
    if (!g.executors.includes(r.executor)) g.executors.push(r.executor);
    if (r.family === 'claude') { for (const t of ['cache_read', 'cache_create', 'input', 'output']) g[t] += r[t] || 0; if (fin(r.pct)) g.pct = (g.pct ?? 0) + r.pct; }
    else if (r.family === 'codex') g.codex += r.tokens || 0;
    else if (r.family === 'provider') g.provider += r.tokens || 0;
  }
  return [...m.values()].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.codex - a.codex || String(keys.map(x => a[x])).localeCompare(String(keys.map(x => b[x]))));
}
const pct2 = n => (fin(n) ? `${n < 0.1 && n > 0 ? n.toFixed(3) : n.toFixed(2)} %` : '-');
const ofWeek = n => (fin(n) ? `${pct2(n)} of week` : '% of week not known');
const fmtS = s => (fin(s) ? (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`) : '-');
function spendTable(id, title, note, rows, keys, maxPct) {
  const head = keys.map(k => `<th>${esc(k === 'executor' ? 'agent CLI' : k)}</th>`).join('');
  const body = rows.map(g => `<tr>${keys.map((k, i) => `<td>${i ? esc(g[k]) : `<b>${esc(g[k])}</b>`}</td>`).join('')}
    <td class="mono">${g.runs}${g.running ? ' ' + chip('running', g.running + ' live') : ''}</td>
    <td class="small">${g.executors.map(e => chip(exClass(e), e)).join(' ')}</td>
    <td class="mono">${mTok(g.cache_read)}</td><td class="mono">${mTok(g.cache_create)}</td><td class="mono">${mTok(g.input)}</td><td class="mono">${mTok(g.output)}</td>
    <td style="width:16%">${fin(g.pct) ? `<span class="mono">${pct2(g.pct)}</span>${meter(g.pct, maxPct)}` : dash}</td>
    <td class="mono">${g.codex ? mTok(g.codex) : dash}</td><td class="mono">${g.provider ? mTok(g.provider) : dash}</td></tr>`).join('')
    || `<tr><td colspan="${keys.length + 9}" class="mute">No runs in the window.</td></tr>`;
  return `<div class="tablecard" id="${esc(id)}"><h3>${esc(title)} <span class="mute small">${esc(note)}</span></h3><table><thead><tr>${head}<th>runs</th><th>agent CLIs</th>
    <th>cache read</th><th>cache write</th><th>input</th><th>output</th><th>% of weekly Claude limit</th><th>Codex tokens</th><th>other-provider tokens</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
const $usd = v => `$${(Number(v) || 0).toFixed(2)}`;
// gap #9: API billing - the project's $ per lane today / last 7 days, the dashboard chats on their own line (ended runs = the CLI's
// figure, running = a live estimate from tokens at list price, marked ~)
function apiSpend(s) {
  if (!s) return '';
  if (s.error) return `<div class="tablecard" id="spend-spend"><h3>API spend</h3><div class="small mute">${esc(s.error)}</div></div>`;
  const lanes = (s.lanes || []).filter(g => g.week > 0 || g.live), tot = k => lanes.reduce((a, g) => a + g[k], 0) + (s.chats?.[k] || 0);
  const rows = lanes.map(g => `<tr><td><b>${esc(g.lane)}</b>${g.live ? ' ' + chip('running', 'live') : ''}</td><td class="mono">${g.live ? '~' : ''}${$usd(g.today)}</td><td class="mono">${g.live ? '~' : ''}${$usd(g.week)}</td></tr>`).join('');
  const chat = s.chats && (s.chats.week > 0) ? `<tr id="spend-spend-chats"><td><b>dashboard chats</b></td><td class="mono">${$usd(s.chats.today)}</td><td class="mono">${$usd(s.chats.week)}</td></tr>` : '';
  return `<div class="tablecard" id="spend-spend"><h3>API spend <b>${$usd(tot('today'))}</b> today <span class="mute small">${$usd(tot('week'))} in 7 days · this project (${esc(s.project ?? '-')}) · ~ = still running</span></h3>
   <table><thead><tr><th>lane</th><th>today</th><th>7 days</th></tr></thead><tbody>${rows + chat || '<tr><td colspan="3" class="mute">No spend in 7 days.</td></tr>'}</tbody></table></div>`;
}
const winWords = p => (p.window === 'week' ? 'since the weekly reset' : `last ${p.days} days`);
const pcA = x => (fin(x) ? '~' + pct2(x) : dash);
// the four tiles. API billing: dollars (the last 24 h is the strip's, every project) against the daily cap; a plan: % of the week
function tiles(p, u) {
  const api = u?.billing?.type === 'api', b = u?.billing || {}, cap = fin(b.cap) && b.cap > 0 ? b.cap : null, t = p.totals, l24 = p.secondary?.last24h, hp = p.headline ? p.headline.pct : t.claude.pct;
  const live = (p.rows || []).reduce((n, r) => n + (r.running || 0), 0), wk = (p.spend?.lanes || []).reduce((a, g) => a + g.week, 0) + (p.spend?.chats?.week || 0);
  const day = api ? { n: $usd(b.usd), label: `last 24 h · every project${cap ? ` · cap ${$usd(cap)}` : ''}`, cls: cap && b.usd >= cap ? 'warn' : '' }
    : { n: fin(l24?.pct) ? pct2(l24.pct) : mTok(l24?.cache_read ?? 0), label: `last 24 h · ${fin(l24?.pct) ? 'of the week' : 'cache read'} · ${plural(l24?.runs ?? 0, 'run')}` };
  const total = api && p.spend && !p.spend.error ? { n: $usd(wk), label: 'last 7 days · this project' }
    : { n: fin(hp) ? pct2(hp) : mTok(t.claude.cache_read), label: `${fin(hp) ? 'of the week' : 'cache read'} · ${p.account ? 'whole account' : 'Norn runs'} · ${winWords(p)}` };
  const g = u?.guard, guard = { n: g === 'STOP' ? 'stop' : g === 'ok' ? 'ok' : '-', cls: g === 'STOP' ? 'warn' : g === 'ok' ? 'ok' : '',
    label: api ? (cap ? `guard · daily cap ${$usd(cap)}` : 'guard · no daily cap') : fin(u?.weeklyStopPct) ? `guard · ${fin(u?.weeklyUsed) ? `${u.weeklyUsed.toFixed(1)} %` : '-'} of the ${u.weeklyStopPct} % stop` : 'guard · weekly stop not set' };
  const runs = { n: int(t.claude.runs + t.codex.runs + t.provider.runs), label: `runs · ${winWords(p)}${live ? ` · ${live} live` : ''}${t.codex.runs ? ` · ${t.codex.runs} Codex` : ''}` };
  return [['24h', day], ['total', total], ['runs', runs], ['guard', guard]].map(([k, x]) => `<div class="subnum ${x.cls ?? ''}" id="spend-${k}"><b class="mono">${esc(x.n)}</b><span class="small mute">${esc(x.label)}</span></div>`).join('');
}
// META-GUARD R1 item 2: the top 5 spenders of the week (why = turns x average context size, its tooltip); a run id opens its run
function topList(w, project) {
  if (!w || w.error) return `<p class="small mute">${esc(w?.error ?? 'not counted yet')}</p>`;
  const top = (w.top || []).map(t => `<li title="${esc(t.why)}"><span class="id" role="button" tabindex="0" data-feed="${esc(t.id)}" data-project="${esc(project)}">${esc(t.id)}</span> <b>${esc(t.lane)}</b> ${esc(t.stage)} ${chip(t.outcome === 'done' ? 'done' : t.state === 'running' ? 'running' : 'idle', t.outcome ?? t.state)} <span class="mono">${pcA(t.pct)}</span> · ${mTok(t.cache_read)} cache read</li>`).join('');
  return `<ol id="spend-top" class="small">${top || '<li class="mute">none</li>'}</ol>`;
}
const ckLine = c => (c.ticks ? `<b>${int(c.last24h.ticks)}</b> in 24 h · ${ofWeek(c.last24h.pct)} · ${c.ticks_per_day.toFixed(1)} a day · ${fmtS(c.mean_s)} each · ${pct2(c.pct_per_day)} of the week a day`
  : '<span class="mute">none measured in this window</span>');
function checkinsView(p) {
  const c = p.checkins, pt = c.per_tick, l24 = c.last24h;
  return `<section class="card" id="spend-ck"><h2>Check-ins</h2>${c.ticks ? `<div class="kv">
     <span class="mute small">last 24 h</span><div><span class="big">${l24.ticks}</span> check-ins · ${mTok(l24.cache_read)} cache read · ${mTok(l24.cache_create)} cache write · <b>${ofWeek(l24.pct)}</b></div>
     <span class="mute small">check-ins per day</span><div><b>${c.ticks_per_day.toFixed(1)}</b> <span class="mute">(${c.ticks} in ${(c.days ?? p.days).toFixed(1)} days)</span> · ${fmtS(c.mean_s)} each on average</div>
     <span class="mute small">per check-in, on average</span><div class="mono">${mTok(pt.cache_read)} cache read · ${mTok(pt.cache_create)} cache write · ${int(pt.input)} input · ${mTok(pt.output)} output · ${ofWeek(pt.pct)}</div>
     <span class="mute small">% of week per day</span><div><b>${pct2(c.pct_per_day)}</b></div></div>` : '<div class="small mute">No check-in with measured usage in this window.</div>'}</section>`;
}
// the tokens behind the numbers: the account (every Claude session since the reset) vs the runs Norn started, the rolling and 24 h
// windows, the four token types, Codex and other providers apart, the scale (cache reads per 1 % of the week) and what was counted
function tokensView(p, ctx, u) {
  const t = p.totals, k = p.calib, sec = p.secondary, A = p.account, hp = p.headline ? p.headline.pct : t.claude.pct, rf = ctx.refresh || {}, out = A ? A.outside : null;
  const acctRows = A ? `<span class="mute small">account, since the weekly reset</span><div class="mono"><b>${ofWeek(A.pct)}</b> <span class="small mute">every Claude session on your account</span> · ${int(A.messages)} messages · ${mTok(A.cache_read)} cache read · <span class="mute">cache age ${fmtS(A.age_s)}: counted ${esc(fmtTime(A.at, ctx.now))}${rf.running ? ', refreshing' : ''}</span></div>
     <span class="mute small">runs Norn started</span><div class="mono">${ofWeek(t.claude.pct)} · ${plural(t.claude.runs, 'run')}</div>
     <span class="mute small">outside runs (interactive)</span><div class="mono"><b>${ofWeek(out.pct)}</b> · ${mTok(out.cache_read)} cache read${out.clamped ? ` <span class="small">(reads 0: Norn's runs count ${out.raw_pct.toFixed(2)} % more than the account shows)</span>` : ''}</div>`
    : `<span class="mute small">account: n/a</span><div class="small mute">${rf.running ? 'counting your whole account (the first count reads every Claude session file: minutes)' : 'this provider has no account-wide count'}</div>`;
  const secRows = sec ? `<span class="mute small">rolling ${sec.rolling.days} days</span><div class="mono" id="spend-rolling">${ofWeek(sec.rolling.pct)} · ${plural(sec.rolling.runs, 'run')} · ${mTok(sec.rolling.cache_read)} cache read</div>
     <span class="mute small">last 24 h</span><div class="mono" id="spend-24h-tok">${ofWeek(sec.last24h.pct)} · ${plural(sec.last24h.runs, 'run')} · ${mTok(sec.last24h.cache_read)} cache read</div>` : '';
  return `${u?.billing?.type === 'api' ? `<section class="card" id="spend-burn"><h2>Last 24 h <span class="mute small">API billing, against the daily cap</span></h2>${apiBurn(u.billing)}</section>` : ''}
   <section class="card" id="spend-summary"><h2>${fin(hp) ? `<b>${pct2(hp)}</b> of your weekly Claude limit` : 'Weekly share not known: set it in Settings > Usage calibration'} <span class="mute small">${A ? 'your whole Claude account' : 'the runs Norn started'}, ${esc(p.window === 'week' ? `since the weekly reset ${fmtTime(p.since, ctx.now)}` : `the last ${p.days} days`)}${p.next_reset ? ` · next reset ${esc(fmtTime(p.next_reset, ctx.now))}` : ''}</span></h2>
     <div class="kv" id="spend-account">${acctRows}</div><div class="kv">${secRows}<span class="mute small">Claude tokens</span><div class="mono">${plural(t.claude.runs, 'run')} · ${mTok(t.claude.cache_read)} cache read · ${mTok(t.claude.cache_create)} cache write · ${mTok(t.claude.input)} input · ${mTok(t.claude.output)} output</div>
     <span class="mute small">Codex tokens</span><div class="mono">${plural(t.codex.runs, 'run')} · ${mTok(t.codex.tokens)} tokens <span class="small mute">(own plan: not in the Claude %)</span></div>
     <span class="mute small">other providers</span><div class="mono">${plural(t.provider.runs, 'run')} · ${mTok(t.provider.tokens)} tokens <span class="small mute">(your own API keys: not in the Claude %)</span></div>
     <span class="mute small">not measured</span><div class="small">${plural(t.unmeasured, 'run')}</div>
     <span class="mute small">scale</span><div class="small">${fin(k.cacheR_per_pct) ? `${mTok(k.cacheR_per_pct)} cache-read tokens = 1 % of your week` : 'not set: enter the % from your claude.ai usage page in Settings > Usage calibration (or norn calib --pct N)'}
       <div class="mute">in cache reads: 1 input = ${k.weights.input}, 1 output = ${k.weights.output}, 1 cache write = ${k.weights.cache_create_1h} (1 h) / ${k.weights.cache_create_5m} (5 min)${fin(k.mix) ? ` · this window: 1 token = ${k.mix.toFixed(3)} cache reads` : ''}</div></div>
     <span class="mute small">counted</span><div class="small mute">${plural(p.cost.runs, 'run')} in ${p.cost.ms.toFixed(1)} ms · ${mTok(p.cost.bytesRead)} bytes of session files read</div></div></section>`;
}
// META-GUARD R1 item 2: where the week's tokens went - per lane + stage, how the runs ended, merged, tokens per merged branch
function stageCard(w) {
  if (!w || w.error) return w?.error ? `<div class="tablecard" id="spend-stage"><h3>Lane and stage</h3><div class="small mute">${esc(w.error)}</div></div>` : '';
  const body = (w.rows || []).map(r => `<tr><td><b>${esc(r.lane)}</b></td><td>${esc(r.stage)}</td><td class="mono">${r.runs}${r.running ? ' ' + chip('running', r.running + ' live') : ''}</td>
    <td class="mono">${mTok(r.tokens.input)}</td><td class="mono">${mTok(r.tokens.cache_create)}</td><td class="mono">${mTok(r.tokens.cache_read)}</td><td class="mono">${mTok(r.tokens.output)}</td>
    <td class="mono">${pcA(r.pct)}</td><td class="small">${r.outcomes.done} done · ${r.outcomes.stopped} stopped · ${r.outcomes.handoff} handoff</td><td class="mono">${r.merged}</td>
    <td class="mono small">${r.per_merged ? `${mTok(r.per_merged.cache_read)} cache read · ${mTok(r.per_merged.output)} out${fin(r.per_merged.pct) ? ' · ' + pcA(r.per_merged.pct) : ''}` : dash}</td></tr>`).join('')
    || '<tr><td colspan="11" class="mute">No runs in the window.</td></tr>';
  return `<div class="tablecard" id="spend-stage"><h3>Lane and stage <span class="mute small">${w.window === 'week' ? 'since the weekly reset' : 'last 7 days'} · ${plural(w.totals.runs, 'run')} · ${fin(w.totals.pct) ? pcA(w.totals.pct) + ' of the week' : '% of the week not known'} · ${w.totals.merged} merged into main</span></h3>
   ${w.counts ? `<p class="small" id="spend-counts" style="padding:0 12px">${esc(w.counts.text)}</p>` : ''}
   <table><thead><tr><th>lane</th><th>stage</th><th>runs</th><th>input</th><th>cache write</th><th>cache read</th><th>output</th><th>~% of week</th><th>how the runs ended</th><th>merged</th><th>tokens per merged branch</th></tr></thead><tbody>${body}</tbody></table></div>`;
}
// META-TEND P2 (REPORT 4.3): what each kind of work costs - per FINISHED task (a stage that reached DONE; its resumes, hand-offs and
// fix rounds counted in), by kind of work, by model, and the full class x executor x model x effort grid; the week's Fable runs (Q4).
// On the shared widgets (META-TEND P6, REPORT 5.3): per kind and per model = `bars`, the grid's cells = `meter`. cost = weighted tokens in cache-read units.
const rate = x => (fin(x) ? Math.round(100 * x) + ' %' : '-');
const srcChip = r => (r.src === 'inferred' ? ' ' + chip('idle', 'inferred') : '');
function classCard(c, adv = null) {
  const advOn = cls => guardChip((adv?.cards || []).filter(x => x.id === cls && !x.decided).map(x => ({ severity: x.severity, why: x.title })), { tab: 'spend', sub: 'advice' });   // META-TEND P6: the chip in place
  if (!c) return '';
  if (c.error) return `<div class="tablecard" id="spend-class"><h3>What each kind of work costs</h3><div class="small mute">${esc(c.error)}</div></div>`;
  const maxCost = Math.max(1, ...c.byClass.map(r => r.cost_per_done ?? 0), ...c.byClassModel.map(r => r.cost_per_done ?? 0));
  const ended = r => `${r.done} of ${r.stages} done · ${rate(r.stop_rate)} stopped · ${rate(r.merged_rate)} merged`;
  const none = n => `<tr><td colspan="${n}" class="mute">No finished stage in the window.</td></tr>`;
  const noneP = '<p class="small mute" style="padding:0 12px">No finished stage in the window.</p>';
  const kind = c.byClass.length ? bars(c.byClass.map(r => ({ label: r.label, value: r.cost_per_done ?? 0,
    note: `${ended(r)} · ${fin(r.runs_per_done) ? r.runs_per_done.toFixed(1) : '-'} runs per finished task${srcChip(r)}${advOn(r.class)}` })), { id: 'spend-class-kind', max: maxCost, fmt: v => v ? mTok(v) : '-' }) : noneP;
  const model = c.byClassModel.length ? bars(c.byClassModel.map(r => ({ label: `${r.label} · ${r.model}`, value: r.cost_per_done ?? 0, note: `${ended(r)}${srcChip(r)}` })),
    { id: 'spend-class-model', max: maxCost, fmt: v => v ? mTok(v) : '-' }) : noneP;
  const maxCr = Math.max(1, ...c.rows.map(r => r.cache_read.p90 ?? 0));
  const grid = c.rows.map(r => `<tr><td><b>${esc(r.label)}</b>${srcChip(r)}</td><td>${esc(r.executor)}</td><td>${esc(r.model)}</td><td>${esc(r.effort)}</td>
    <td class="mono">${r.stages}</td><td class="mono">${r.runs}</td><td class="mono">${rate(r.done_rate)}</td><td class="mono">${rate(r.stop_rate)}</td><td class="mono">${rate(r.merged_rate)}</td>
    <td style="width:14%">${fin(r.cache_read.median) ? `<span class="mono">${mTok(r.cache_read.median)} / ${mTok(r.cache_read.p90)}</span>${meter(r.cache_read.median, maxCr, r.cache_read.p90)}` : dash}</td>
    <td class="mono">${fin(r.output.median) ? mTok(r.output.median) : dash}</td><td class="mono">${fin(r.cost_per_done) ? mTok(r.cost_per_done) : dash}</td>
    <td class="small mute">${esc(r.basis.join(', '))}</td></tr>`).join('') || none(13);
  const f = c.fable || { count: 0, runs: [] };
  const fable = `<div class="small" id="spend-fable" style="padding:6px 12px">${chip(f.count ? 'warn' : 'idle', plural(f.count, 'Fable run'))} this window${f.count ? ` <span class="mute">${f.runs.map(esc).join(', ')}</span>` : ''}</div>`;
  const help = `<details class="lhelp"><summary aria-label="About this table">?</summary><div class="small">A finished task = a stage that reached DONE, its resumes, hand-offs and fix rounds counted in. Cost = weighted tokens in cache-read units (all its stages, finished or not, / finished ones). ${plural(c.open, 'stage')} still open left out.${c.inferred_runs ? ` ${plural(c.inferred_runs, 'run')} from before the class stamp: class inferred, kept in their own rows.` : ''}</div></details>`;
  return `<div class="tablecard" id="spend-class"><h3>What each kind of work costs <span class="mute small">per finished task</span>${help}</h3>
   ${fable}
   <h3 style="margin-top:6px">Per kind of work <span class="mute small">cost per finished task</span></h3>${kind}
   <h3 style="margin-top:10px">By model <span class="mute small">cost per finished task</span></h3>${model}
   <h3 style="margin-top:10px">Class x agent x model x effort <span class="mute small">cache reads per finished task: median / p90 (the bar's tick)</span></h3>
   <table id="spend-class-grid"><thead><tr><th>kind of work</th><th>agent</th><th>model</th><th>effort</th><th>stages</th><th>runs</th><th>done</th><th>stopped</th><th>merged</th><th>cache read</th><th>output</th><th>cost</th><th>class from</th></tr></thead><tbody>${grid}</tbody></table></div>`;
}
// META-TEND P4: the Advice view - the open cards (the Inbox shows the same), the vendor sources with the day each was read. Clear all =
// Keep as is on every open card (pages/spend-acts.mjs: one decision each, nothing changes in Settings); an applied or kept card leaves.
function adviceStrip(a, ctx) {
  if (!a) return '';
  if (a.error) return `<section class="card" id="spend-advice"><h2>Advice</h2><div class="small mute">${esc(a.error)}</div></section>`;
  const srcs = [...new Map((a.sources || []).map(s => [s.ref + s.read, s])).values()];
  const dated = srcs.map(s => `${esc(s.ref)} ${esc(s.read)}${s.stale ? ' ' + chip('warn', 'stale') : ''}`).join(' · ');
  const cards = (a.cards || []).map(c => adviceRow({ ...c, project: a.project }, { ...ctx, project: a.project })).join('');
  const keys = (a.cards || []).map(c => c.key ?? c.id), clear = keys.length ? `<button type="button" class="ghost" id="spend-advice-clear" data-act="advice-clear" data-project="${esc(a.project)}" data-keys="${esc(keys.join(','))}" title="keep every setting as it is: each card is decided and leaves">Clear all ${int(keys.length)}</button>` : '';
  return `<section class="card" id="spend-advice"><h2>Advice <span class="mute small">${plural(keys.length, 'open card')}${a.decided ? ` · ${a.decided} decided` : ''}</span> ${clear}</h2>
   ${cards || `<div class="small">${chip('ok', 'all clear')} <span class="mute">no open advice</span></div>`}
   <div class="small mute" id="spend-advice-sources" style="margin-top:6px">Vendor guidance (engine/presets/advice/models.json), read: ${dated || '-'}${a.stale?.length ? ` - ${plural(a.stale.length, 'source')} past the re-read date` : ''}</div></section>`;
}
// META-TEND P4 (owner Q2): the replay test - recorded check-in rulings vs cheaper models on the same frozen inputs (norn eval report)
const VERDICT = { agree: 'ok', harmless: 'idle', refused: 'refused', recoverable: 'warn', harmful: 'bad', error: 'bad' };
// META-CHECKIN-GUARDS R1: a tick's verdicts as one split bar (the shared stack widget; refused = a guard refused the move in code)
const VERDICT_PARTS = [['agree', 'agree'], ['harmless', 'harmless'], ['refused', 'refused by a guard'], ['recoverable', 'recoverable'], ['harmful', 'harmful'], ['errors', 'error']];
const verdictStack = (t, id) => stack(VERDICT_PARTS.map(([k, label]) => ({ key: 'v-' + k, label, value: t[k] ?? 0 })), { id });
function guardsBlock(r, short) {
  if (!r.before) return '';
  const g = r.guard_history, rows = r.arms.map((a, i) => { const b = r.before.arms_total.find(t => t.arm === a), t = r.arms_total.find(x => x.arm === a);
    return `<tr><td><b>${esc(short(a))}</b></td><td data-label="before">${b ? verdictStack(b, `spend-replay-before-${i}`) : dash}</td><td data-label="after">${t ? verdictStack(t, `spend-replay-after-${i}`) : dash}</td></tr>`; }).join('');
  return `<h3 style="margin-top:8px">Before / after the check-in guards <span class="mute small">the same stored moves graded again: a move a guard refuses in code never happens (exit 6 lane busy, exit 2 owner-only ask)</span></h3>
   <table id="spend-replay-guards"><thead><tr><th>model</th><th>before</th><th>after</th></tr></thead><tbody>${rows}</tbody></table>
   ${g ? `<div class="small mute" id="spend-replay-history">Guard check on the recorded history: ${g.dispatches} check-in dispatches, ${g.busy.length} refused by "lane busy"${g.dup.length ? ` (${g.dup.length} more meet the older duplicate check first)` : ''}; ${g.rulings} check-in rulings of a question, ${g.owner_only.length} refused by "owner-only ask".</div>` : ''}`;
}
function replayCard(r) {
  if (!r || !r.arms?.length) return '';
  const short = a => a.replace(/^claude:claude-/, '').replace(/:/g, ' ');
  const tot = bars(r.arms_total.map(t => ({ label: `${short(t.arm)} (${t.ticks} ticks)`, value: t.agree, note: `${t.harmless} harmless · ${t.refused ?? 0} refused · ${t.recoverable} recoverable · ${t.harmful} harmful · ${t.errors} errors · ${mTok(t.tokens)} tokens` })),
    { id: 'spend-replay-arms', max: Math.max(1, ...r.arms_total.map(t => t.ticks)), fmt: v => `${v} agree` });
  const clsNames = [...new Set(r.classes.map(c => c.cls))];
  const per = clsNames.map(k => `<tr><td><b>${esc(k)}</b></td>${r.arms.map(a => { const c = r.classes.find(x => x.arm === a && x.cls === k);
    const off = c ? ['refused', 'harmful'].filter(x => c[x]).map(x => `${c[x]} ${x}`).join(' · ') : '';
    return `<td style="width:30%">${c ? `<span class="mono">${c.agree} of ${c.recorded}</span>${meter(c.agree, Math.max(1, c.recorded))}${off ? `<div class="small mute">${esc(off)}</div>` : ''}` : dash}</td>`; }).join('')}</tr>`).join('');
  const cell = x => (x ? `${chip(VERDICT[x.verdict] || 'idle', x.verdict)}<div class="small">${x.cand.map(esc).join('<br>')}</div>${x.verdict !== 'agree' && x.why?.length ? `<div class="small mute">${x.why.slice(0, 4).map(esc).join('<br>')}${x.why.length > 4 ? `<br>+${x.why.length - 4} more` : ''}</div>` : ''}` : dash);
  const side = r.ticks.map(t => `<tr><td class="id">${esc(t.tick)}</td><td class="small">${esc(t.stratum)}</td><td data-label="recorded" class="small">${t.recorded.length ? t.recorded.map(esc).join('<br>') : '<span class="mute">nothing</span>'}</td>${r.arms.map(a => `<td data-label="${esc(short(a))}">${cell(t.arms[a])}</td>`).join('')}</tr>`).join('');
  return `<div class="tablecard" id="spend-replay"><h3>Cheaper check-ins: the replay test <span class="mute small">recorded check-ins re-run offline on the same inputs · ${esc(r.project ?? '')} · ${esc(String(r.at ?? '').slice(0, 16))}</span></h3>
   <h3 style="margin-top:4px">Ticks that agree, per model</h3>${tot}
   ${guardsBlock(r, short)}
   <h3 style="margin-top:8px">Agreement per class of ruling</h3><table id="spend-replay-class"><thead><tr><th>ruling</th>${r.arms.map(a => `<th>${esc(short(a))}</th>`).join('')}</tr></thead><tbody>${per}</tbody></table>
   <h3 style="margin-top:8px">Side by side <span class="mute small">the recorded ruling vs each cheaper model; ${plural(r.choices?.length ?? 0, 'same-lane ruling')} with a different choice</span></h3>
   <table id="spend-replay-side"><thead><tr><th>tick</th><th>class</th><th>recorded</th>${r.arms.map(a => `<th>${esc(short(a))}</th>`).join('')}</tr></thead><tbody>${side}</tbody></table></div>`;
}
// the usage forecast (/api/plan forecast = engine/lib/plan.mjs forecastOf; folded in from the retired pages/plan.mjs): the rate now
// against the hourly cap, the week against the stop, the reset and when the stop is reached at this rate; '' when the project has none
export function forecastCard(f, now = Date.now()) {
  if (!f) return '';
  const fc = f.api ? `<div class="spend-fc" id="spend-fc-api"><p><b>${esc(f.line)}</b><br><span class="small mute">API billing: no weekly limit to run out of.</span></p></div>`
    : !fin(f.weekly) ? '<p class="spend-fc-empty mute">Usage not measured yet.</p>' : `<div class="spend-fc"><div class="kv">
    <span class="small mute">rate now</span><span>${meter(f.rate, Math.max(f.cap ?? 0, f.rate ?? 0) || 1, f.cap, f.over ? 'hot' : '')} <span class="small">${pct(f.rate, 2)}/h of the ${pct(f.cap, 1)}/h cap</span></span>
    <span class="small mute">this week</span><span>${meter(f.weekly, 100, f.stop, fin(f.stop) && f.weekly >= f.stop ? 'hot' : '')} <span class="small">~${pct(f.weekly)}${fin(f.stop) ? ` of the ${pct(f.stop, 0)} stop` : ''}</span></span>
    <span class="small mute">reset</span><span class="small">${f.reset ? esc(fmtTime(f.reset, now)) : '-'}</span></div>
    <p><b>${esc(f.lineAt ? `${f.linePre}${fmtTime(f.lineAt, now)}${f.linePost}` : f.line)}</b>${f.costLine ? `<br><span class="small">${esc(f.costLine)}</span>` : ''}</p></div>`;
  return `<div class="tablecard" id="spend-forecast"><h3>Forecast</h3>${fc}</div>`;
}
// the drawer's one view per project (maxPct: the lane table's bar scale, the window's biggest lane)
const maxPct = rows => Math.max(0.01, ...spendGroup(rows, ['lane']).map(g => g.pct ?? 0));
const VIEW = {
  lane: p => apiSpend(p.spend) + spendTable('spend-lane', 'By lane', `each line of work, ${winWords(p)}`, spendGroup(p.rows || [], ['lane']), ['lane'], maxPct(p.rows || [])),
  stage: p => stageCard(p.week),
  cli: p => spendTable('spend-executor', 'By agent CLI', 'claude, codex, or fake (the free rehearsal)', spendGroup(p.rows || [], ['executor']), ['executor'], maxPct(p.rows || [])),
  day: p => spendTable('spend-day', 'By day', 'the day the run started', spendGroup(p.rows || [], ['day']).sort((a, b) => String(b.day).localeCompare(String(a.day))), ['day'], maxPct(p.rows || [])),
  work: p => classCard(p.classes, p.advice),
  checkins: p => checkinsView(p) + replayCard(p.replay),
  tokens: (p, ctx) => tokensView(p, ctx, ctx.strip?.usage),
  forecast: (p, ctx, d) => forecastCard((d.forecasts || {})[p.project], ctx.now) || '<p class="small mute" id="spend-noforecast">No forecast for this project.</p>',
  advice: (p, ctx) => adviceStrip(p.advice, ctx),
};
const HELP = `<details class="lhelp"><summary aria-label="About these numbers">?</summary><div class="small">"% of week" = the share of your weekly Claude usage limit, estimated from token counts (Tokens: the scale). Token types: input (new text sent), output (text written), cache write (context stored for reuse), cache read (stored context re-read on every turn, usually the biggest). k = thousand, M = million tokens. Codex and other providers have their own plans: token totals only.</div></details>`;
function drawer(parts, open, d, ctx) {
  const n = parts.reduce((a, p) => a + (p.advice?.cards?.length || 0), 0), multi = ctx.project === 'all';
  const chips = filterChips('Breakdown', SPEND_VIEWS.map(([k, text]) => ({ act: 'sub', data: { sub: k }, text, on: k === open, ...(k === 'advice' ? { n } : {}) })), 'spend-views');
  return `<aside class="drawer spend-drawer" id="spend-drawer" aria-label="Spend details"><div class="dh"><b>Spend details</b>${HELP}<span class="spacer"></span>${closeBtn('type="button" id="spend-close" data-act="sub" data-sub=""')}</div>
   ${chips}<div class="spend-dbody" id="spend-view-${esc(open)}">${parts.map(p => (multi ? `<h3>${esc(p.project)}</h3>` : '') + VIEW[open](p, ctx, d)).join('') || '<p class="mute">No project.</p>'}</div></aside>`;
}
const BULB = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.7.6 1.2v.6h4v-.6c0-.5.2-.9.6-1.2A4.5 4.5 0 0 0 8 1.5zM6 13.6h4M6.6 15h2.8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>';
/** the page: the title line (Spend, the advice icon, Details), per project the tiles, the top 5 and the check-ins line; the drawer when d.sub is a view */
export function spend(d, ctx) {
  const parts = d.parts || [], open = spendView(d.sub), u = ctx.strip?.usage ?? null, c = { ...ctx, refresh: d.account_refresh }, multi = ctx.project === 'all';
  const cards = parts.flatMap(p => p.advice?.cards || []), hot = cards.some(x => x.severity && x.severity !== 'low');
  const icon = `<button type="button" class="ghost spend-adv" id="spend-adv" data-act="sub" data-sub="advice" aria-pressed="${open === 'advice'}" title="${esc(plural(cards.length, 'open advice card'))}" aria-label="Advice: ${cards.length} open">${BULB}<span class="obadge${hot ? ' hot' : ''}">${int(cards.length)}</span></button>`;
  const head = `<div class="phead pagehead" id="spend-head"><h2 class="ptitle">Spend</h2>${icon}<span class="spacer"></span><button type="button" id="spend-more" data-act="sub" data-sub="${open ? '' : 'lane'}" aria-expanded="${!!open}" aria-controls="spend-drawer">Details</button></div>`;
  const part = p => `<section class="spend-part" id="spend-p-${esc(p.project)}">${multi ? `<h3>${esc(p.project)}</h3>` : ''}<div class="subsum spend-sum">${tiles(p, u)}</div>
   <div class="grid2 spend-grid"><section class="card" id="spend-topcard"><h2>Top 5 spenders <span class="mute small">${esc(p.week?.window === 'week' ? 'since the weekly reset' : 'last 7 days')}</span></h2>${topList(p.week, p.project)}</section>
   <section class="card" id="spend-checkins"><h2>Check-ins <button type="button" class="lnk small" data-act="sub" data-sub="checkins">details</button></h2><div class="small">${ckLine(p.checkins)}</div></section></div></section>`;
  return head + (parts.map(part).join('') || '<p class="mute">No project.</p>') + (open ? drawer(parts, open, d, c) : '');
}
