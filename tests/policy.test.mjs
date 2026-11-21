// Port of meta/dash/tests/policy.test.mjs onto the engine policy (machine budget vs project policy, design D11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_DEFAULTS, SETTINGS, settingsView, applySettings, generatedLines, rewriteMarked, merged, split, scopeOf } from '../engine/lib/policy.mjs';

const budget=()=>({max_claude_workers:8,max_codex:5,max_astra:5,max_sol:5,usage_rate_cap_pct_per_h:0.43,reset:'2026-11-04T08:00 local',
  calib_time_utc:'2026-10-30T19:45:00Z',calib_pct:64,cacheR_per_pct:40900000,checkin_model:'claude-opus-5-5',checkin_effort:'medium',
  claude_model:'claude-opus-5-5',claude_effort:'medium',codex_astra_effort:'xhigh',codex_sol_effort:'medium',weekly_stop_pct:95});
const policy=()=>({dispatch_window:{max:8,order:['x']},lanes:{}});

test('every setting has one home, help text, recommended value and cost line; scope = machine | project',()=>{
  const keys=new Set();
  for(const s of SETTINGS) {
    assert.ok(!keys.has(s.key),'duplicate '+s.key);keys.add(s.key);
    for(const f of ['label','help','recommended','cost','group'])assert.ok(s[f]!==undefined&&s[f]!=='',s.key+' '+f);
    assert.ok(Array.isArray(s.readers)&&s.readers.length,s.key+' readers');
  }
  for(const g of ['agents','executors','context','iteration','budget','cadence','speed'])assert.ok(SETTINGS.some(s=>s.group===g),g);
  const v=settingsView(merged(budget(),policy()),{quietFile:'/x/common-rules.txt'});
  assert.equal(v.find(s=>s.key==='policy.context.implementer.handoff_k').value,110,'defaults fill a missing policy block');
  assert.equal(v.find(s=>s.key==='weekly_stop_pct').value,95);
  assert.equal(v.find(s=>s.key==='reserve_pct_for_doors').value,5,'machine default');
  assert.equal(v.find(s=>s.key==='policy.cadence.checkin_interval_min').home,'project.json policy.cadence.checkin_interval_min');
  assert.equal(v.find(s=>s.key==='max_codex').home,'machine budget.json max_codex');
  assert.equal(v.find(s=>s.key==='rules.quiet_gpu').home,'/x/common-rules.txt');
  assert.equal(v.find(s=>s.key==='rules.quiet_gpu').readonly,true,'the house rule line (QUIET / GPU lock) shown read-only');
  // D11: account-wide limits are machine scope, rules are project scope
  for(const k of ['max_claude_workers','max_codex','weekly_stop_pct','calib_pct','checkin_model','desired_burn_pct_per_h'])assert.equal(scopeOf(k),'machine',k);
  for(const k of ['policy.speed_mode.A','policy.context.runner.handoff_k','policy.dispatch_window.max'])assert.equal(scopeOf(k),'project',k);
});

test('applySettings validates (400) and changes only the named keys; split returns the two files',()=>{
  const b=merged(budget(),policy());
  const out=applySettings(b,{'policy.context.implementer.handoff_k':100,'max_sol':4,'policy.speed_mode.D':false,'policy.executors.review.executor':'kestrel-implementer'},{agents:['kestrel-implementer','kestrel-planner','kestrel-runner']});   // a project's own agents (META-OOTB F-2: extra.agents)
  assert.equal(out.policy.context.implementer.handoff_k,100);assert.equal(out.max_sol,4);assert.equal(out.policy.speed_mode.D,false);
  assert.equal(out.policy.executors.review.executor,'kestrel-implementer');assert.equal(out.policy.dispatch_window.order[0],'x','untouched keys survive');
  assert.equal(b.max_sol,5,'input not mutated');
  const s=split(out);assert.equal(s.budget.max_sol,4);assert.equal(s.budget.policy,undefined);assert.equal(s.policy.speed_mode.D,false);
  const bad=[{'nope':1},{'max_codex':99},{'policy.context.implementer.handoff_k':95,'policy.context.implementer.no_new_step_k':100},
    {'policy.speed_mode.A':'yes'},{'policy.executors.review.effort':'max'},{'policy.agents.max_lane_writers':2},
    {'policy.cadence.checkin_interval_min':3},{'policy.critical_lanes':'gen'},{'max_astra':6},{'calib_pct':101}];
  for(const c of bad)assert.throws(()=>applySettings(b,c),e=>e.status===400,JSON.stringify(c));
});

test('generated prompt lines come from the policy and rewrite only marked lines',()=>{
  const p=merged(budget(),structuredClone(POLICY_DEFAULTS));p.policy.context.implementer.handoff_k=100;p.policy.iteration.escalation_multiplier=3;
  const lines=generatedLines(p);
  assert.match(lines['context.implementer'],/past ~90k; at ~100k/);assert.match(lines['iteration'],/~3x its round estimate/);
  assert.match(lines['checkin'],/weekly guard 95 %, reserve 5 % for doors, desired burn 0.4 %\/h/,'machine keys feed the check-in line');
  const doc='keep 1\nHANDOFF: old ~90k ~110k <!-- policy:context.implementer -->\nkeep 2 <!-- policy:unknown -->\n';
  const r=rewriteMarked(doc,lines);
  assert.equal(r.text.split('\n')[0],'keep 1');assert.match(r.text.split('\n')[1],/~100k.*<!-- policy:context\.implementer -->$/);
  assert.deepEqual(r.changed,['context.implementer']);assert.deepEqual(r.unknown,['unknown']);
  assert.equal(rewriteMarked('a\r\nb <!-- policy:iteration -->\r\n',lines).text.split('\r\n').length,3,'CRLF kept');
});

// META-TEND P2 (owner Q3): "raise effort" names its step - policy.iteration.escalation_effort (default xhigh), in the generated rule line
test('escalation_effort: default xhigh, settable to an effort, named in the generated iteration line',()=>{
  assert.equal(POLICY_DEFAULTS.iteration.escalation_effort,'xhigh');
  const p=merged(budget(),structuredClone(POLICY_DEFAULTS));
  assert.match(generatedLines(p)['iteration'],/first: raise effort to xhigh/);
  const r=applySettings(p,{'policy.iteration.escalation_effort':'high'});
  assert.equal(r.policy.iteration.escalation_effort,'high');
  assert.throws(()=>applySettings(p,{'policy.iteration.escalation_effort':'max'}),e=>e.status===400);
});

test('NORN-CTX-1M: a _1m context row takes up to 1000k, a plain row keeps its 400k cap',()=>{
  const b=merged(budget(),policy());
  assert.equal(applySettings(b,{'policy.context.implementer_1m.hard_max_k':950}).policy.context.implementer_1m.hard_max_k,950);
  assert.throws(()=>applySettings(b,{'policy.context.implementer.hard_max_k':450}),e=>e.status===400);
  assert.throws(()=>applySettings(b,{'policy.context.planner_1m.hard_max_k':1001}),e=>e.status===400);
});

test('lane-collide S1b: policy.collide ships the SPEC 4.3 defaults; collide.mjs judges with them and a project overrides one kind',async()=>{
  const c=POLICY_DEFAULTS.collide;
  assert.equal(c.enabled,true);
  assert.deepEqual(c.kinds,{item:'warn',lead:'warn',goal:'shadow',territory:'warn',exclusive:'hold',resource:'hold',order:'hold',order_named:'warn',stale:'warn'});
  assert.deepEqual(c.commons,['tests/**','docs/**']);
  assert.equal(c.narrow_files,25); assert.equal(c.recent_days,3);
  assert.deepEqual(c.auto,{hold_exclusive:true,land_early:true,order_after:true,stale_fix:true,tell_worker:true,land_wait_min:45,remedies:[]});
  const { collidePolicy }=await import('../engine/lib/collide.mjs');
  assert.deepEqual(collidePolicy({collide:{kinds:{exclusive:'warn'}}}).kinds,{...c.kinds,exclusive:'warn'});
  assert.deepEqual(collidePolicy({collide:{auto:{land_early:false}}}).auto,{...c.auto,land_early:false});
  assert.deepEqual(collidePolicy(undefined),c);
});
