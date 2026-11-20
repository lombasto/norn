// META-ADOPT A3 (SPEC meta-adopt sec. 5): the dashboard front end of `norn adopt` - five screens drawn from ONE object, GET /api/adopt
// (the proposal record folded + the facts it saw + the read run + the setup gaps), or for Add a project { project: null, repos }.
// The step is DERIVED from that data (adoptStep), never stored: close the page, come back next week, it opens where you were.
// Pure render (no fetch, no DOM): index.html wires the data-act buttons to the POST /api/adopt/* routes. Node built-ins only.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const chip = (cls, txt) => `<span class="chip ${esc(cls)}">${esc(txt)}</span>`;
const src = s => (s ? `<span class="adp-src" title="where this line comes from">${esc(s)}</span>` : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : /(ch|sh|s|x)$/.test(w) ? 'es' : 's'}`;
const day = s => String(s ?? '').slice(0, 10);
const proj = d => esc(d.project ?? d.facts?.name ?? 'this repository');

export const ADOPT_STEPS = [['add', 'Repository'], ['scan', 'What is there'], ['progress', 'Reading'], ['review', 'Review'], ['done', 'Set up']];
// the part titles as the reviewer reads them (the record keeps its own; these are the page's words)
export const PART_LABEL = { profile: 'Caps profile', commands: 'Test, lint and build commands', rules: 'Project rules', instructions: 'Agent instructions (AGENTS.md etc.)',
  roadmap: 'Roadmap', first: 'First task' };
const PART_LEAD = {
  profile: 'Money: never drafted as decided. The default is shown; pick one. The scheduler is never installed by Apply: it stays its own step.',
  commands: 'The test command becomes the merge gate; every command goes into the Commands block of the rules. Unverified = nothing in the repository backs it.',
  rules: 'Written to rules/RULES.md beside project.json (never into the repository). Every worker reads it whole.',
  instructions: 'The repository\'s own instruction files are kept as they are. Norn never writes into the repository.',
  roadmap: 'Status is derived from the linked branches and lanes, never typed. A status word the file claims is kept as a claim.',
  first: 'One task becomes a lane with its own worktree and branch. Pick one; the others stay on the roadmap.' };
const PAST = /^(done|shipped|complete|completed|merged|closed|finished)$/i;

/** the screen for this data: add -> scan -> progress -> review -> done; `ask` = a step the human asked for (Draft again) */
export function adoptStep(d, ask = null) {
  if (!d || (!d.project && !d.facts)) return 'add';
  if (ask) return ask;
  const P = d.proposal;
  if (!P || P.state === 'closed') return 'scan';
  if (P.state === 'applied') return 'done';
  if (d.read && d.read.state === 'running' && !d.read.ingested) return 'progress';
  if (!P.draft) return d.read ? 'progress' : 'scan';
  return 'review';
}

export const ADOPT_CSS = `
.adp{max-width:1180px;margin:0 auto}.adp h1{font-size:20px;margin:0 0 4px}.adp .lead{color:var(--mute);margin:0 0 16px;max-width:760px}
.adp-steps{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 16px;padding:0;list-style:none}
.adp-steps li{padding:3px 10px;border:1px solid var(--line);border-radius:14px;font-size:12px;color:var(--mute);background:var(--panel)}
.adp-steps li.done{color:var(--ok);border-color:var(--ok)}.adp-steps li.now{color:var(--ink);border-color:var(--ink);font-weight:600}
.adp-two{display:grid;grid-template-columns:260px minmax(0,1fr);gap:16px;align-items:start}.adp-two>*{min-width:0}.adp-rail{position:sticky;top:64px}
.adp-half{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start}
.adp-rail .item{align-items:center}.adp-rail .item b{flex:1}
.adp-part{margin-bottom:14px}.adp-part>header{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.adp-part>header h3{margin:0;font-size:15px}.adp-part>header .why{flex-basis:100%;margin:0}.adp-acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.adp-row{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line)}.adp-row>div{flex:1;min-width:0;overflow-wrap:anywhere}
.adp-row input{margin-top:3px;flex:none;width:16px;height:16px;accent-color:var(--accent)}.adp-row.already{opacity:.6}
.adp-row .chip{white-space:normal;max-width:100%}
.adp-src{display:inline-block;max-width:100%;overflow-wrap:anywhere;font:11.5px ui-monospace,Consolas,monospace;color:var(--mute);background:var(--soft);border-radius:4px;padding:0 5px;margin:2px 4px 0 0}
.adp-cmd{font:13px ui-monospace,Consolas,monospace;background:var(--soft);border-radius:5px;padding:1px 7px;overflow-wrap:anywhere}
.adp-theme{margin-top:12px;padding-top:6px;border-top:2px solid var(--line)}.adp-theme h4{margin:0 0 2px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--mute)}
.chip.hollow{background:transparent;border:1px dashed var(--mute);color:var(--mute)}.chip.hz{background:var(--soft);color:var(--ink)}
.adp-bar{position:sticky;bottom:0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:8px;padding:10px 14px;background:var(--panel);border:1px solid var(--line);border-radius:10px;box-shadow:0 -4px 14px var(--shadow)}
.adp-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.adp-facts .card{overflow-wrap:anywhere}.adp-facts .card b{display:block;font-size:20px;margin-bottom:2px}
.adp-path{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-bottom:14px}.adp-path .card.on{border-color:var(--accent);box-shadow:inset 3px 0 0 var(--accent)}
.adp input[type=text]{width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 10px;font:inherit;color:inherit}
.adp-sug{display:flex;gap:10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}.adp-sug>div{flex:1;min-width:0}.adp-sug .mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.adp .card h2{overflow-wrap:anywhere}.adp .item>button{flex:none;white-space:nowrap}
@media (max-width:900px){.adp-two,.adp-half,.adp-path{grid-template-columns:minmax(0,1fr)}.adp-rail{position:static}.adp-rail .items{display:flex;gap:6px;overflow-x:auto}
  .adp-rail .item{border:0;padding:0;flex:none}.adp-rail .item b{display:none}.adp-facts{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.adp-bar{border-radius:0}}
@media (max-width:480px){.adp-facts{grid-template-columns:minmax(0,1fr)}}
`;

const steps = now => {
  const at = ADOPT_STEPS.findIndex(s => s[0] === now);
  return `<ol class="adp-steps">${ADOPT_STEPS.map(([, t], i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}">${i < at ? '&#10003; ' : `${i + 1}. `}${esc(t)}</li>`).join('')}</ol>`;
};
const wrap = (step, title, lead, body) => `<style>${ADOPT_CSS}</style><div class="adp" id="adopt-${step}">${steps(step)}<h1>${title}</h1><p class="lead">${lead}</p>${body}</div>`;

// 1. Add a project: a path (a browser cannot hand a folder path to a local server) + the git repos found beside the known ones
function add(d) {
  const repos = d.repos || [], none = !(d.projects || []).length;
  const sug = repos.map(r => `<div class="adp-sug"><div><b>${esc(r.name)}</b> ${r.registered ? chip('ok', 'already a project') : ''}<span class="mono mute">${esc(r.path)}</span></div>${r.registered
    ? `<button class="ghost" data-act="adopt-goto" data-project="${esc(r.registered)}">Open</button>` : `<button data-act="adopt-use" data-root="${esc(r.path)}">Use</button>`}</div>`).join('')
    || '<p class="small mute">No git repository found beside your projects. Type the folder above.</p>';
  return wrap('add', 'Add a project', `${none ? '<b>No project yet.</b> ' : ''}Point Norn at a git repository on this computer. It looks first and writes nothing into your repository: workers get their own worktrees and branches.`,
    `<div class="adp-half"><section class="card"><h2>Repository folder</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" data-adopt="root" value="${esc(d.root ?? '')}" placeholder="C:/code/my-app or ~/code/my-app" style="flex:1;min-width:200px" aria-label="Repository folder"><button class="primary" data-act="adopt-scan">Look at it</button></div>
      <p class="small mute" style="margin:8px 0 4px">Type or paste the folder. Or pick one found beside your other projects:</p>${sug}</section>
     <section class="card"><h2>What happens next</h2>
      <div class="item">${chip('ok', '1')}<div><b>Look</b> <span class="small mute">a few seconds, free</span><div class="small mute">Git and tracked files only: test commands, CI, plans, branches in flight. No model; nothing leaves this computer.</div></div></div>
      <div class="item">${chip('ok', '2')}<div><b>Draft</b> <span class="small mute">your choice</span><div class="small mute">A read-only agent run turns what is there into a roadmap, rules and a first task. Or skip the read and start from the facts.</div></div></div>
      <div class="item">${chip('ok', '3')}<div><b>You approve</b><div class="small mute">Nothing is applied until you approve it, part by part. You can stop and come back.</div></div></div></section></div>`);
}

const factCards = f => {
  const live = (f.branches || []).filter(b => !b.merged), planned = (f.plans || []).reduce((n, p) => n + p.items, 0), h = f.history || {};
  return `<div class="adp-facts">
   <div class="card"><h2>History</h2><b>${plural(h.commits ?? 0, 'commit')}</b><span class="small mute">${h.first ? `${esc(day(h.first))} to ${esc(day(h.last))} · ` : ''}${plural(h.authors ?? 0, 'author')} · ${plural(f.size?.files ?? 0, 'file')}</span></div>
   <div class="card"><h2>Tests and CI</h2><b>${(f.commands || []).length ? f.commands.map(c => `<span class="adp-cmd">${esc(c.cmd)}</span>`).join(' ') : 'none found'}</b><span class="small mute">${(f.ci || []).map(c => esc(c.file)).join(', ') || 'no CI file'} · ${plural(f.size?.tests ?? 0, 'test file')}</span></div>
   <div class="card"><h2>Plans</h2><b>${planned} planned lines</b><span class="small mute">${(f.plans || []).map(p => `${esc(p.file)} ${p.items}`).join(' · ') || 'no ROADMAP / TODO file'}</span></div>
   <div class="card"><h2>In flight</h2><b>${plural(live.length, 'branch')}</b><span class="small mute">${live.slice(0, 6).map(b => `${esc(b.name)}${b.ahead !== undefined ? ` (${b.ahead} ahead${b.days !== undefined ? `, ${b.days} d` : ''})` : ''}`).join(' · ') || 'none'}${live.length > 6 ? ` · ${live.length - 6} more` : ''}</span></div></div>`;
};

// 2. What is there: the scan + the one choice that costs something + the optional questions
function scan(d) {
  const f = d.facts || {}, c = d.consent || {}, isNew = f.path === 'new';
  const qs = (d.interview || []).map(q => `<div style="margin-bottom:10px"><b>${esc(q.text)}</b><input type="text" data-answer="${esc(q.id)}" value="${esc(d.proposal?.answers?.[q.id] ?? '')}" aria-label="${esc(q.text)}" style="margin-top:4px"></div>`).join('');
  const reg = d.project ? '' : `<p class="small mute" style="margin:0 0 12px">Choosing a draft registers it as project <b>${esc(f.name)}</b>: a project.json beside your other projects, outside the repository.</p>`;
  return wrap('scan', `What Norn found in ${proj(d)}`, `${isNew ? `<b>This looks like a new project</b> (${esc(f.path_why)}): three optional questions draft its roadmap. ` : `${esc(f.path_why ?? '')}. `}Looked at ${plural(f.size?.files ?? 0, 'tracked file')} in ${((f.scan_ms ?? 0) / 1000).toFixed(1)} s. Nothing was sent anywhere and nothing was written.`,
    `${d.scan_error ? `<div class="card" style="margin-bottom:14px">${chip('bad', 'scan failed')} ${esc(d.scan_error)}</div>` : ''}${factCards(f)}
     <div class="item card" style="margin-bottom:14px">${chip('ok', 'instructions')}<div><b>${(f.agent_files || []).map(a => esc(a.file)).join(', ') || 'No agent instruction file'}</b> <span class="small mute">${(f.agent_files || []).length ? 'is in the repository. Workers start inside a worktree of it, so their own tool reads it. Norn keeps it as it is.' : 'Norn will offer to write one as a first task (a branch you merge).'}</span></div></div>${reg}
     <div class="adp-path"><section class="card on"><h2>Read it and draft</h2>
       <p style="margin:0 0 8px">One read-only agent run reads the plans, design docs and a few source files, and drafts a roadmap, project rules and a first task.</p>
       <div class="kv small"><span class="mute">runs as</span><span>${chip('claude', c.executor ?? 'claude')} read-only: no edits, no shell; your tests are not run</span>
        <span class="mute">cost</span><span>${esc(c.line ?? '')}</span></div>
       <div style="margin-top:12px"><button class="primary" data-act="adopt-read">Read and draft</button></div></section>
      <section class="card"><h2>Draft from the facts only</h2>
       <p style="margin:0 0 8px">Free and instant. Norn imports ${(f.plans || []).map(p => esc(p.file)).join(' and ') || 'your answers'} line by line and links the branches it can match. Themes and duplicates are left for you.</p>
       <div class="small mute">Good when the repository must not leave this computer. You can run the read later: decisions on parts that did not change are kept.</div>
       <div style="margin-top:12px"><button data-act="adopt-facts">Draft without a read</button></div></section></div>
     ${qs ? `<section class="card" id="adopt-questions"><h2>${isNew ? 'Three questions' : 'Questions the repository cannot answer'} <span class="small mute" style="text-transform:none;letter-spacing:0">(optional: skip them and Norn asks nothing more)</span></h2>${qs}</section>` : ''}`);
}

// 3. Reading: the read is an ordinary recorded run - its live feed is the progress, and closing the page loses nothing
function progress(d) {
  const r = d.read || {}, f = d.facts || {}, mins = r.started ? Math.max(0, Math.round((Date.now() - Date.parse(r.started)) / 60000)) : null;
  const rows = [['done', 'Registered', `${d.project ?? f.name}: project.json beside your other projects, outside the repository`], ['done', 'Looked', `${plural(f.size?.files ?? 0, 'tracked file')}, ${((f.scan_ms ?? 0) / 1000).toFixed(1)} s`],
    ['running', 'Reading', `${r.id ?? 'starting'}${r.name ? ' ' + r.name : ''}${r.attempt > 1 ? ` (retry ${r.attempt})` : ''}${mins !== null ? ` · ${mins} min of ${d.consent?.cap_min ?? 15}` : ''}`],
    ['idle', 'Draft checked', 'every command and link is checked against the facts'], ['idle', 'Your review', 'nothing is applied before it']];
  return wrap('progress', `Reading ${proj(d)}`, 'You can close this page. The read is a recorded run; the draft waits for you in Needs you when it is ready.',
    `<div class="adp-half"><section class="card"><h2>Progress</h2>${rows.map(([s, t, x]) => `<div class="item">${chip(s, s === 'done' ? 'done' : s === 'running' ? 'now' : 'next')}<div><b>${esc(t)}</b><div class="small mute">${esc(x)}</div></div></div>`).join('')}
       <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">${r.id && r.state === 'running' ? `<button data-act="stop" data-run="${esc(r.id)}" data-project="${esc(d.project)}">Stop the read</button>` : ''}<button class="ghost" data-act="adopt-facts">Use the facts-only draft instead</button></div></section>
      <section class="card"><h2>${esc(r.id ?? 'the read')} ${chip('running', r.state ?? 'starting')} ${r.executor ? chip('claude', r.executor) : ''}</h2>
       ${r.id ? `<p style="margin:0 0 8px"><button class="primary" data-feed="${esc(r.id)}" data-project="${esc(d.project)}">Open its live feed</button></p>` : ''}
       <p class="small mute" style="margin:0">Read-only: it opens tracked files and writes one answer. When it ends, the engine checks the draft (a command nothing backs is shown unverified; a link to nothing is dropped) and the review opens.</p></section></div>`);
}

// the derived status of an imported line from the facts (the roadmap derives the same from its links once applied)
function derived(l, facts) {
  const br = (l.links || []).filter(x => x.startsWith('branch:')).map(x => (facts?.branches || []).find(b => b.name === x.slice(7))).filter(Boolean);
  if (!br.length) return null;
  return br.every(b => b.merged) ? 'shipped' : 'in flight';
}
function lineRow(p, l, ctx) {
  const off = p.decision?.off || [], on = p.decision?.on || [], ed = ctx.edits?.[p.id]?.[l.id] ?? p.decision?.edits?.[l.id];
  const checked = !l.already && !off.includes(l.id) && (!l.unverified || on.includes(l.id));
  const pickOn = p.decision ? !off.includes(l.id) : (p.type === 'profile' ? !!l.default : l.id === p.lines.find(x => !x.already)?.id);
  const input = l.already ? '<input type="checkbox" disabled checked aria-label="already there">'
    : p.pick ? `<input type="radio" name="pick-${esc(p.id)}" data-line="${esc(l.id)}"${pickOn ? ' checked' : ''} aria-label="${esc(l.text)}">`
    : `<input type="checkbox" data-line="${esc(l.id)}"${checked ? ' checked' : ''}${l.unverified ? ' data-unverified="1"' : ''} aria-label="${esc(l.text)}">`;
  const st = derived(l, ctx.facts), word = l.legacy?.word;
  const chips = [l.horizon ? chip('hz', l.horizon) : '', st ? chip(st === 'shipped' ? 'ok' : 'running', st) : '', word ? chip('hollow', `claimed: ${word}`) : '',
    word && st === 'shipped' && !PAST.test(word) ? chip('bad', 'drift') : '', l.already ? chip('idle', 'already there') : '', l.unverified ? chip('warn', 'unverified') : '',
    l.default ? chip('idle', 'default') : '', ed ? chip('needs', 'edited') : ''].filter(Boolean).join(' ');
  const text = p.type === 'commands' ? `<b>${esc(l.id)}</b> <span class="adp-cmd">${esc(ed ?? l.text)}</span>` : `<b style="font-weight:500">${esc(ed ?? l.text)}</b>`;
  const edit = l.already || p.type === 'profile' ? '' : `<button class="ghost small" data-act="adopt-edit" data-part="${esc(p.id)}" data-line="${esc(l.id)}" data-text="${esc(ed ?? l.text)}">Edit</button>`;
  return `<div class="adp-row${l.already ? ' already' : ''}">${input}<div>${text} ${chips}${ed ? `<div class="small mute">drafted: ${esc(l.text)}</div>` : ''}<div>${src(l.source)}${(l.links || []).map(x => src(x)).join('')}${(l.stages || []).map(x => chip('idle', x)).join(' ')}</div>${l.note ? `<div class="small mute">${esc(l.note)}</div>` : ''}</div>${edit}</div>`;
}
const statusChip = p => (p.applied ? chip('ok', 'applied') : p.status === 'approved' ? chip('ok', 'approved') : p.status === 'skipped' ? chip('idle', 'skipped') : p.pick && p.type === 'profile' ? chip('needs', 'your pick') : chip('warn', 'to review'));
function partCard(p, ctx) {
  const title = PART_LABEL[p.type] ?? p.title ?? p.id;
  let body;
  if (p.type === 'roadmap') {
    const themes = [];
    for (const l of p.lines) { let t = themes.find(x => x.title === (l.theme ?? '')); if (!t) themes.push(t = { title: l.theme ?? '', lines: [] }); t.lines.push(l); }
    body = themes.map(t => `<div class="adp-theme"><h4>${esc(t.title || 'Items')}</h4>${t.lines.map(l => lineRow(p, l, ctx)).join('')}</div>`).join('');
  } else body = p.lines.map(l => lineRow(p, l, ctx)).join('');
  const acts = p.applied ? '' : `<button class="primary" data-act="adopt-decide" data-verdict="approve" data-part="${esc(p.id)}">${p.pick ? 'Choose' : 'Approve'}</button><button data-act="adopt-decide" data-verdict="skip" data-part="${esc(p.id)}">Skip</button>`;
  return `<section class="card adp-part" id="part-${esc(p.id)}" data-part="${esc(p.id)}" data-sha="${esc(p.sha)}"><header><h3>${esc(title)}</h3><span class="small mute">${plural(p.lines.length, 'line')}${p.pick ? ' · pick one' : ''}</span>${statusChip(p)}<span class="spacer"></span><span class="adp-acts">${acts}</span><p class="small mute why">${esc(PART_LEAD[p.type] ?? '')}${p.empty ? ` <b>${esc(p.empty)}</b>` : ''}</p></header>${body || '<p class="small mute">Nothing drafted for this part.</p>'}</section>`;
}

// 4. Review: one page; a rail of the parts, a card per part (Approve / Skip, a row per line: tick, text, source, Edit), one Apply
function review(d, ctx = {}) {
  const P = d.proposal, parts = P.parts || [], todo = parts.filter(p => p.status === 'approved' && !p.applied).length;
  const approved = parts.filter(p => p.status === 'approved').length, open = parts.filter(p => p.status === 'to review').length, dr = P.draft || {};
  const rail = `<aside class="adp-rail"><div class="card"><h2>${esc(P.id)} <span class="small mute" style="text-transform:none;letter-spacing:0">${/^RUN-/.test(dr.source ?? '') ? `drafted by the read ${esc(dr.source)}` : 'drafted from the facts'}</span></h2><div class="items">${parts.map(p => `<div class="item"><b>${esc(PART_LABEL[p.type] ?? p.title)}</b>${statusChip(p)}</div>`).join('')}</div></div>
    ${dr.summary ? `<p class="small mute" style="margin:10px 2px">${esc(dr.summary)}</p>` : ''}${dr.note ? `<p class="small" style="margin:10px 2px">${chip('warn', 'note')} ${esc(dr.note)}</p>` : ''}</aside>`;
  return wrap('review', `Review the draft for ${proj(d)}`, 'Every line says where it came from. Untick what is wrong, approve what is right. Nothing below exists in Norn until you press Apply; each decision is saved as you make it.',
    `<div class="adp-two">${rail}<div>${parts.map(p => partCard(p, { ...ctx, facts: d.facts || dr.facts })).join('')}
      <div class="adp-bar"><b>${approved} of ${parts.length} parts approved</b><span class="small mute">${open ? `${open} still to review` : 'every part decided'}</span><span class="spacer"></span><button class="ghost" data-act="adopt-later">Save and finish later</button><button class="ghost" data-act="adopt-notnow" data-project="${esc(d.project)}">Not now</button><button class="primary" data-act="adopt-apply"${todo ? '' : ' disabled'}>Apply ${plural(todo, 'approved part')}</button></div></div></div>`);
}

const HOME = { roadmap: ['roadmap', 'Open the roadmap'], first: ['lanes', 'Open the lane'], profile: ['settings', 'Open Settings'], commands: ['settings', 'Open Settings'], rules: ['docs', 'Open the docs'], instructions: ['docs', 'Open the docs'] };
// 5. Set up: what was applied (each line names its home), the first lane ready to start, what is left for later
function done(d) {
  const P = d.proposal, parts = P.parts || [], l = d.lane;
  const rows = parts.filter(p => p.applied).map(p => `<div class="item">${chip('ok', PART_LABEL[p.type] ?? p.id)}<div>${(p.applied.wrote || []).map(w => `<div class="small">${esc(w)}</div>`).join('') || '<div class="small mute">nothing new to write</div>'}</div><span class="spacer"></span><button class="ghost small" data-tab="${HOME[p.type]?.[0] ?? 'records'}">${esc(HOME[p.type]?.[1] ?? 'Open')}</button></div>`).join('')
    || '<p class="small mute">Nothing was applied.</p>';
  const later = [...parts.filter(p => p.status !== 'approved').map(p => [p.status === 'skipped' ? 'skipped' : 'not decided', PART_LABEL[p.type] ?? p.id, 'Draft again any time: Add a project or the Overview setup card.']),
    ['when it repeats', 'Decision rules', 'Grow from the rulings you repeat; nothing to write today.'], ['after the first runs', 'Known-red tests', 'A baseline lane runs the tests once on the main branch.']];
  const lane = l ? `<section class="card needs"><h2>Your first lane is ready</h2><p style="margin:0 0 6px"><b>${esc(l.task)}</b></p>
       <div class="kv small"><span class="mute">lane</span><span class="mono">${esc(l.name)}</span><span class="mute">worktree</span><span class="mono">${esc(l.worktree)}</span><span class="mute">branch</span><span class="mono">${esc(l.branch)}</span><span class="mute">brief</span><span class="mono">${esc(l.brief)}</span></div>
       <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button class="primary" data-act="adopt-start" data-lane="${esc(l.name)}">Start the run</button><button data-act="adopt-rehearse" data-lane="${esc(l.name)}">Rehearse first (free)</button><button class="ghost" data-tab="roadmap">Open the roadmap</button></div>
       <p class="small mute" style="margin:10px 0 0">Start the run starts a check-in now: it dispatches the lane inside your caps. Rehearse runs the fake executor: it spends nothing and shows the whole path.</p></section>`
    : `<section class="card"><h2>No first lane</h2><p class="small mute">No first task was applied. Give Norn one on Lanes, or <button class="ghost small" data-tab="roadmap">open the roadmap</button>.</p></section>`;
  return wrap('done', `${proj(d)} is set up`, 'Everything below is a record or a file beside your project.json. Your repository was not touched.',
    `<div class="adp-half"><section class="card"><h2>What was applied</h2>${rows}</section>${lane}</div>
     <section class="card" style="margin-top:14px"><h2>Left for later <span class="small mute" style="text-transform:none;letter-spacing:0">Norn brings each one up when it matters, never as a form</span></h2>${later.map(([w, t, x]) => `<div class="item">${chip('idle', w)}<div><b>${esc(t)}</b><div class="small mute">${esc(x)}</div></div></div>`).join('')}
     <div style="margin-top:10px"><button class="ghost" data-act="adopt-again">Draft again</button></div></section>`);
}

export function renderAdopt(step, d, ctx = {}) {
  const f = ({ add, scan, progress, review, done })[step];
  return f ? f(d || {}, ctx) : `<div class="card">unknown setup step ${esc(step)}</div>`;
}
