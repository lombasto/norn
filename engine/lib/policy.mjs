// ONE HOME for every efficiency setting (OWNER a14 ADDENDUM), split per design D11: account-wide keys live in the MACHINE
// budget (local/budget.json, top level), rules live in the PROJECT policy (project.json `policy`). Settings work on the merged
// view {...budget, policy}; a key starting "policy." is project scope, every other key is machine scope (split() undoes the merge).
// Prompt files that must carry a number get a GENERATED line marked `<!-- policy:<key> -->` (rewriteMarked), never a hand copy.
// META-EXEC-S1: configured claude-compatible executors (extra.providers = their names) join the executor dropdowns; every executor has
// allowed work classes (policy.allowed_classes.<name>, the rank) and a class -> executor pairing it does not allow is refused (400).
import { PROVIDER_CLASSES, PROVIDER_CAP_DEFAULT, capKey, BUILTIN } from './executors.mjs';
import { ADAPTERS } from './harness/index.mjs';
import { FLOOR_MODELS, floorOf, floorText, modelBelow, effortBelow, claudeRank } from './floor.mjs';
import { BILLING_NAMES, isApi, usdCap } from './billing.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const EFFORTS=['low','medium','high','xhigh'];
const MODELS=['claude-opus-5-5','claude-sonnet-5-5'];
// CHECKIN-V2 piece 4: the check-in executors = the built-ins whose harness adapter attaches the meta MCP server (caps.mcp); a
// non-claude one runs only under checkin_executor_trial (auto-fallback to claude). The chat on adapters is H5: claude only.
export const HARNESS_EXECUTORS=Object.keys(BUILTIN).filter(n=>n!=='fake'&&(ADAPTERS[BUILTIN[n].harness]?.caps?.mcp??'none')!=='none');
export const CHAT_EXECUTORS=['claude'];
// META-OOTB F-2: the engine ships GENERIC role agents (engine/agents/<role>.md, installed by `project new`); a project's own agent
// names come in as extra.agents (executors.mjs roleAgents: its agent files + the names its policy routes to) and replace these.
export const ROLE_AGENTS=['implementer','planner','runner'];
const rolesOf=extra=>(extra?.agents?.length?extra.agents:ROLE_AGENTS);
const executorsOf=extra=>['auto','codex-astra','codex-sol',...rolesOf(extra),'fable'];   // + the project's configured typed executors (extra.providers)
const fallbacksOf=extra=>['codex-astra','codex-sol',...rolesOf(extra).filter(a=>/(^|-)implementer$/.test(a)),'opus-xhigh','wait'];   // the implementer role takes fallback work
const EXECUTORS=executorsOf(),FALLBACK=fallbacksOf();
const ANY_MODELS=['','claude-opus-5-5','claude-sonnet-5-5','gpt-6-astra','gpt-6.1-sol','fable'];
export const POLICY_MODELS=ANY_MODELS;   // META-PRACTICE-P1 check 18: the model names policy knows
const ESCALATE=['raise effort','switch to Fable','re-scope','ask owner'];
const fail=m=>Object.assign(new Error(m),{status:400});

export const WORK_CLASSES={implementation:'Implementation',critical_implementation:'Critical-path implementation',review:'Review',diagnosis:'Diagnosis',
  planning:'Planning',chores:'Chores',passfail:'Pass/fail runs',images:'Images',docs:'Docs'};
const ex=(executor,model,effort)=>({executor,model,effort});
export const POLICY_DEFAULTS={
  agents:{max_lane_writers:1},
  delegate:{max_per_parent:4},
  ask:{max_per_day:10},
  fixer:{batch:40},   // META-UX-BUILD S7: the findings one fixer run (docs class) takes; a Send approves ceil(n / batch) runs (fixer.mjs)
  mail:{nudge_after_min:10},   // META-GTP-MAIL: an urgent mail not acked this long nudges the run (0 = off)
  executors:{implementation:ex('auto','',''),critical_implementation:ex('implementer','claude-opus-5-5','high'),review:ex('codex-sol','gpt-6.1-sol','medium'),
    diagnosis:ex('codex-sol','gpt-6.1-sol','medium'),planning:ex('planner','claude-opus-5-5','xhigh'),chores:ex('auto','',''),passfail:ex('auto','',''),
    images:ex('codex-sol','gpt-6.1-sol','medium'),docs:ex('runner','claude-sonnet-5-5','medium')},
  allowed_classes:{},
  critical_lanes:[],critical_effort:'high',
  fallbacks:{claude_over_guard:'codex-astra',codex_down:'implementer',fable_unavailable:'opus-xhigh'},
  context:{implementer:{no_new_step_k:90,handoff_k:110,hard_max_k:150},planner:{no_new_step_k:90,handoff_k:150,hard_max_k:150},
    runner:{no_new_step_k:90,handoff_k:110,hard_max_k:150},controller:{no_new_step_k:90,handoff_k:110,hard_max_k:150},
    checkin:{no_new_step_k:90,handoff_k:110,hard_max_k:150}},   // META-CTX-ENFORCE R1: a check-in's own row (ctxlimit.mjs ctxRole)
  iteration:{round_estimate_default:2,escalation_multiplier:2,escalation_action:'raise effort',escalation_effort:'xhigh',wall_time_multiplier:2},   // escalation_effort: META-TEND P2 (owner Q3) - the effort 'raise effort' goes to
  cadence:{checkin_interval_min:15,trigger_on_exit:true},
  // META-CHECKIN-DIET R1 (checkins.mjs): routine ends handled by code, the end debounce, per-lane check-in levels, the staged-merge run
  checkin:{routine:['merge_done','worker_done_stage'],debounce_min:5,auto_stage:[],none_lanes:[],on_end_lanes:[],merge_agent:'',merge_model:'claude-sonnet-5-5',merge_effort:'medium'},
  speed_mode:{A:true,B:true,C:true,D:true},
  instructions:{stale_days:30},
  dod:{ready:'off',scope:'off',critique:'off',critique_filter:'',test_cmd:'',timeout_min:20},   // META-DOD 1 (DIR-68): the Ready gate of norn run (off | warn | refuse) + the Done check's test runner (dod.mjs); META-DOD 2: the scope guard (off | on, scope.mjs); META-DOD 3: the plan review (off | on, critique.mjs)
  slop:{enabled:true},   // META-BETA-PREP (DIR-52): ONE switch for all of SloppaChoppa (slopOn)
  overlap:{enabled:true},   // GAP-12: the overlap check of running lanes against the remote's branches and open PRs (overlap.mjs overlapOn)
  voice:{popups:'off',daily_cap:3},   // META-TEND P6 (DEC-264, DIR-36): SloppaChoppa's pop-ups ship OFF until the owner's 11-21 review; the badge works from day one
  launch:{roles:{worker:'full',merge:'full',checkin:'full',chat:'full'},profiles:{}},
  // META-GUARD R1 (DIR-23): the live usage guard (guard.mjs) - runaway = k x the peers' median above floor_m M cache reads; over the hand-off line for N calls; tool spam
  guard:{k:3,floor_m:5,min_peers:3,peer_days:14,over_handoff_turns:5,tool_result_k:20,tool_share_pct:40,tool_share_floor_m:2,push:false},
  // GAP-1 (holds.mjs): ALL queued work held on one machine-level hold this long = one needs-you item, one digest row, one notice
  holds:{notice_min:60},
  // META-CATCH S1 (stuck.mjs): an item past one threshold since its last merge is STUCK - a MAJOR wake, one notice, further rounds refused until an approach review; 0 = that threshold off
  stuck:{stopped_rounds:3,runs_without_merge:8,days_without_merge:3},
  // META-CATCH S2 (look.mjs): a look item's brief needs a Look: line from this round on and in every brief of these stages (first word, any case)
  look:{stages:['MERGE','INSTALL'],min_round:2}};   // META-STANDING-CONTEXT R1: launch profile per role (standing.mjs)   // META-STANDING-CONTEXT R1: a paragraph older than this, never confirmed = STALE

// META-OOTB F-2 + FOLLOWUP R1: the routing `project new` writes, derived in ONE place from the executors setup found AND the caps in
// force (local/budget.json; an unset cap = no limit). A Codex executor is allowed only when the Codex total and its own cap
// (max_sol / max_astra) are not 0. Every class routed to an executor that is not allowed goes to its Claude stand-in role
// (read-only analysis -> planner, the rest -> implementer); every fallback naming one becomes wait. Never a route the caps forbid.
const CODEX_CAP={'codex-sol':'max_sol','codex-astra':'max_astra'};
const capOpen=(caps,k)=>!(Number.isFinite(caps?.[k])&&caps[k]<=0);
export const allowedExecutors=(found=['claude'],caps={})=>found.filter(x=>!CODEX_CAP[x]||(capOpen(caps,'max_codex')&&capOpen(caps,CODEX_CAP[x])));
// META-PROFILE-BUG R1: a RETIRED executor = a Codex executor whose own cap is 0 while the Codex total is open (the owner closed that
// one on purpose, e.g. codex-astra with max_astra 0); with the Codex total at 0 Codex is simply not on yet (the starter caps).
export const retiredExecutors=(caps={})=>capOpen(caps,'max_codex')?Object.keys(CODEX_CAP).filter(x=>!capOpen(caps,CODEX_CAP[x])):[];
export const capOfExecutor=x=>CODEX_CAP[x]??null;
const STAND_IN_ROLE={review:'planner',diagnosis:'planner'};   // read-only classes; any other class -> implementer
const CLAUDE_SIDE=new Set(['auto','wait','opus-xhigh','fable',...ROLE_AGENTS]);
// the starter caps = the try-it profile's caps (engine/presets/profiles/try-it.json; tests/ootb-polish pins the two equal). norn setup
// writes the profile; this stays the starter routing input (starterPolicy found x caps).
export const STARTER_CAPS={max_claude_workers:1,max_codex:0,max_astra:0,max_sol:0,weekly_stop_pct:50,usage_rate_cap_pct_per_h:0.3,desired_burn_pct_per_h:0.25};
export function starterPolicy(found=['claude'],caps={}){
  const ok=new Set([...CLAUDE_SIDE,...allowedExecutors(found,caps)]);
  const executors=Object.fromEntries(Object.entries(POLICY_DEFAULTS.executors).map(([k,e])=>
    [k,ok.has(e.executor)?{...e}:ex(STAND_IN_ROLE[k]||'implementer','claude-sonnet-5-5','medium')]));
  const fallbacks=Object.fromEntries(Object.entries(POLICY_DEFAULTS.fallbacks).map(([k,v])=>[k,ok.has(v)?v:'wait']));
  return {executors,fallbacks};}

const int=(min,max)=>({type:'int',min,max}),num=(min,max)=>({type:'num',min,max}),en=options=>({type:'enum',options}),bool={type:'bool'};
const S=(group,key,label,kind,help,recommended,cost,readers,extra={})=>({group,key,label,...kind,help,recommended,cost,readers,...extra});
const CHECKIN='CHECKIN.md (check-in prompt, generated line policy:checkin)';
export const SETTINGS=[
  S('agents','max_claude_workers','Max Claude workers',int(0,12),'Claude worker lanes the check-in may keep alive at once.','8 overnight, 2-3 by day','Each worker burns weekly usage in parallel; more = faster stages, faster to the guard.',['worker.ps1 (refuses past the cap)',CHECKIN]),
  S('agents','policy.dispatch_window.max','Overnight Claude slot max',int(0,12),'Workers allowed during the overnight slot window.','8','Same as above, only inside the overnight window.',[CHECKIN]),
  S('agents','max_codex','Max Codex total',int(0,8),'All concurrent Codex runs (codex-astra + codex-sol).','5','Codex has its own plan limits; more runs = more merge work for the controller.',[CHECKIN]),
  S('agents','max_astra','Max codex-astra runs',int(0,8),'Runs of codex-astra (the deeper, slower Codex model) inside the Codex total.','5','Its xhigh runs are slow and heavy on the Codex plan.',[CHECKIN]),
  S('agents','max_sol','Max codex-sol runs',int(0,8),'Runs of codex-sol (the faster, cheaper Codex model) inside the Codex total.','5','Cheap; mainly costs merge attention.',[CHECKIN]),
  S('agents','policy.delegate.max_per_parent','Max helpers per run',int(0,8),'Read-only meta delegate helpers one worker may have running at once.','4','More = more parallel questions per worker; each helper is one executor run.',['meta delegate (exit 4 past the cap)']),
  S('agents','policy.ask.max_per_day','Max meta asks per day',int(0,100),'Questions to ENDED runs (meta ask: a read-only fork of the session, else a cold helper) per UTC day.','10','Each ask is one helper run; a fork re-reads the whole session (~150-250k tokens of cache creation).',['meta ask (exit 4 past the cap)']),
  S('agents','policy.dod.ready','Ready gate (brief Scope / Tests / Done)',en(['off','warn','refuse']),'A brief must carry three plain lines: Scope: (the paths the run may change), Tests: (the test files or a `command` that prove it), Done: (what done means). refuse: norn run refuses a brief without them (exit 6); warn: it starts and says so; off: no check. With the lines, Norn checks the run itself when it ends DONE: a clean tree, every changed path in Scope, the Tests + the merge gate run by Norn. A red check sends the run back once with the evidence; a second red is STOPPED for the check-in.','refuse','Refuse = every brief needs the three lines; the run-end check runs the brief tests and the merge gate (minutes per run).',['norn run (exit 6)','the run supervisor (Done check)',CHECKIN]),
  S('agents','policy.dod.scope','Scope guard (what a run may touch)',en(['off','on']),'on: while a claude run works, Norn refuses its edits outside the worktree, its extra folders and its NOTES folder (and outside the brief Scope: line when there is one), force pushes, pushes to main / master (merge runs and check-ins excepted), hard resets and branch or worktree deletes outside its own worktree, gh repo edit / delete and rm -r outside the worktree. The run is told why and can carry on; each refusal shows in the run feed and the Slop list. off: none of this. Read when a run starts.','on','No cost: one quick check per tool call.',['the run launch (norn run, the queue fill)',CHECKIN]),
  S('agents','policy.dod.critique','Plan review (fresh eyes before the build)',en(['off','on']),'on: when a planning run ends DONE, Norn queues ONE review run itself: the review executor of the policy table, a fresh session, read-only, given the plan (the run NOTES) and the request it answers (its brief and the directive ids in it), asked for real problems only (the filter below). The findings sit beside the plan (<plan>-CRITIQUE.md). A build run whose brief names the plan waits for the review: a clean review releases it, findings wait until the check-in has read them (it reviews the review run). off: no review.','on','One review run per plan (the review executor, read-only).',['the run supervisor (a planning run end)','norn run (the build waits)',CHECKIN]),
  S('agents','policy.dod.critique_filter','Plan review filter file',{type:'text'},'The file the review is held to (what counts as a real problem). Blank = the built-in filter: a concrete scenario on real data giving wrong output, a crash, nondeterminism, a test that passes while broken, a contract that forces a breaking change, a measurable performance bug, or over-engineering.','the project review filter file','—',['norn critique (the review brief)']),
  S('agents','policy.mail.nudge_after_min','Nudge after (min)',int(0,240),'An URGENT mail (meta mail send --urgent) a running run has not acked within this many minutes stops its tree and resumes its session with the mail as the prompt. Never while the project quiet flag is set or its machine lock is held. 0 = off.','10','A nudge cuts the run at its current tool call; shorter = faster replies, more cut work.',['the run supervisor (engine/lib/supervisor.mjs nudge)']),
  S('workers','policy.guard.k','Runaway alarm at (x the median of its peers)',num(1.5,20),'A live run whose cache reads (or turns) pass this many times the median of its peers (ended runs of the same kind + agent + effort, last 14 days, at least 3) raises a GRD alarm the check-in rules: let it run, mail it, stop it. Norn never stops a run by itself.','3','Lower = earlier alarms, more false ones; higher = a runaway burns longer unseen.',['norn guard','the tick (digest row 8)','dashboard Agents chip']),
  S('workers','policy.guard.floor_m','Runaway alarm floor (M cache reads)',num(0,1000),'No runaway alarm below this many million cache reads, whatever the ratio.','5','Lower = small runs alarm too.',['norn guard']),
  S('workers','policy.guard.tool_share_pct','Tool-spam hint at (% of the cache reads of a run)',int(5,100),'A live run whose tool output (test logs, file reads, greps) causes this share of its cache reads (above 2M) gets a tool-spam hint; so does one tool result over 20k tokens.','40','Lower = more hints.',['norn guard','norn guard sources']),
  S('workers','policy.guard.push','Push usage alarms to the phone',bool,'Off: usage alarms go into the FYI digest notice (batched). On: one low-priority notice per alarm at once.','false','On = more pings.',['norn tick (notify class usage)']),
  S('agents','policy.stuck.stopped_rounds','Stuck: stopped rounds in a row',int(0,50),'A roadmap item whose rounds end STOPPED this many times in a row (no DONE, no merge between) is stuck: the check-in wakes with the last three stop reasons, you get one notice, and norn run refuses a further round on the item until an approach review is recorded (by you, or by a run of another executor or model). A merge resets it. 0 = off.','3','Lower = an earlier alarm, more reviews for items that would have converged.',['norn tick (stuck.mjs)','norn run (refuses a stuck item)','norn road show',CHECKIN]),
  S('agents','policy.stuck.runs_without_merge','Stuck: runs without a merge',int(0,200),'A roadmap item that has started this many runs since its last merge is stuck (same alarm and refusal as above). 0 = off.','8','Lower = an earlier alarm on long items.',['norn tick (stuck.mjs)','norn run (refuses a stuck item)','norn road show',CHECKIN]),
  S('agents','policy.stuck.days_without_merge','Stuck: days without a merge',int(0,90),'A roadmap item whose first run since its last merge is this many days old, with no merge since, is stuck (same alarm and refusal as above). 0 = off.','3','Lower = an earlier alarm; long planned items may need a higher value.',['norn tick (stuck.mjs)','norn run (refuses a stuck item)','norn road show',CHECKIN]),
  S('workers','policy.holds.notice_min','Tell me when everything is held (min)',int(0,1440),'When every queued run (or every queued Claude run) has waited this long on the same machine-level hold - the usage guard (weekly usage unknown or at the stop, the hourly rate cap, the API daily cap) or a PAUSED file - Norn puts ONE item in the Inbox with the fix, one row in the check-in digest and sends one notice. It leaves by itself when the hold clears.','60','Lower = earlier word of a stall, more items for short holds (the hourly rate cap often clears within 2 h).',['norn tick (holds.mjs)','dashboard Inbox',CHECKIN]),
  S('voice','policy.slop.enabled','SloppaChoppa',bool,'On: SloppaChoppa checks a lane branch when its run ends DONE, holds its merge while a BLOCK finding is open, lists his findings in the Guard and sits in the header. Off: all of that stops for this project - no run-end check, no merge hold, no code rows in the Guard, no SloppaChoppa in the header, the Guard or a pop-up (the Guard stays a plain list with a count). Turn him back on and his findings show again from the next check; nothing recorded is lost while off.','on','Off = a lane branch merges without the slop check: leftovers (merge debris, empty catches) can reach main unseen.',['the run supervisor (run-end check)','norn merge-brief + the merge queue (the hold)','dashboard header + Guard page']),
  S('voice','policy.voice.popups','SloppaChoppa pop-ups',en(['off','on','quiet']),'He pops up bottom-right by himself only for a NEW finding at warn level or above, once per finding: on = animated, quiet = still frames, off = never (the header badge and the Guard page work either way; a click on him always calls him up).','off','On = an interruption per new finding, up to the daily cap; never while you type, never over Send.',['dashboard header + Guard page']),
  S('voice','policy.voice.daily_cap','SloppaChoppa pop-ups per day',int(0,10),'At most this many unprompted appearances a day (this browser); 0 = none.','3','Higher = more interruptions.',['dashboard header']),
  S('agents','policy.instructions.stale_days','Instruction paragraph stale after (days)',int(1,365),'An instruction paragraph older than this (its stated date, else its last commit / first-seen date) and never confirmed (meta instructions confirm) is flagged STALE on the Instructions tab and in meta instructions suggest.','30','Shorter = more paragraphs to re-read or confirm; longer = old rules linger.',['meta instructions suggest','dashboard Instructions']),
  ...['worker','merge','checkin','chat'].map(r=>S('agents',`policy.launch.roles.${r}`,`Launch profile: ${{worker:'workers',merge:'merge runs',checkin:'check-ins',chat:'the chat'}[r]}`,en(['full','lean']),"full = today's launch (everything the user setup loads). lean = only Norn's MCP server, no user-level settings (plugins with their hooks and skills; ~/.claude/skills stay), no dynamic system-prompt sections, no Artifact / Workflow / ScheduleWakeup / ReportFindings tools (Claude Code flags; never --bare; calibrated 46.6k -> 20.5k turn 1). The doctor lists what lean drops that a brief or agent file names.",'full','lean cuts the standing context every turn re-reads (see NOTES / meta instructions suggest); a role that needs a skill or MCP server it drops loses it.',['meta run / meta tick / the chat (harness adapter flags)'])),
  S('agents','policy.overlap.enabled','Overlap check (upstream work on the same files)',bool,'On: when a lane starts and at each check-in, Norn fetches the project origin (at most every 10 min; offline = the last fetched refs) and lists the remote branches and open pull requests (gh, GitHub only) that change the same files as a running lane: a row in the check-in digest and a chip on the lane in Lanes. Off: no fetch, no gh call, no rows.','on','One git fetch and one gh call per 10 min per project, plus a git diff per new remote branch tip; nothing while no lane runs.',['the run supervisor (lane start)','norn tick (digest row overlap)','norn overlap','dashboard Lanes']),
  S('agents','policy.agents.max_lane_writers','Max writers per lane',int(1,1),'One writer per worktree; meta run refuses a second.','1','Fixed at 1: two writers in one tree corrupt each other.',['worker.ps1 (worktree refusal)'],{readonly:true}),
  ...Object.entries(WORK_CLASSES).flatMap(([k,label])=>[
    S('executors',`policy.executors.${k}.executor`,`${label}: executor`,en(EXECUTORS),`Who does ${label.toLowerCase()} work (auto = by load).`,POLICY_DEFAULTS.executors[k].executor,'A stronger executor costs more usage per task.',['the dispatch skill (policy:executors)',CHECKIN]),
    S('executors',`policy.executors.${k}.model`,`${label}: model`,en(ANY_MODELS),'Model for that executor (blank = its default).',POLICY_DEFAULTS.executors[k].model||'(default)','Opus costs several times Sonnet; gpt-6-astra several times gpt-6.1-sol.',['the dispatch skill (policy:executors)']),
    S('executors',`policy.executors.${k}.effort`,`${label}: effort`,en(['',...EFFORTS]),'Reasoning effort (blank = executor default).',POLICY_DEFAULTS.executors[k].effort||'(default)','Each effort step roughly doubles thinking tokens.',['the dispatch skill (policy:executors)'])]),
  S('executors','policy.critical_lanes','Critical lanes',{type:'list'},'Lanes on the critical path: they get the critical effort.','the lanes blocking the next release','Every critical lane runs at the higher effort.',[CHECKIN,'the dispatch skill (policy:executors)']),
  S('executors','policy.critical_effort','Critical-lane effort',en(EFFORTS),'Effort for critical lanes.','high','xhigh roughly doubles a round\'s usage over high.',[CHECKIN]),
  S('executors','policy.fallbacks.claude_over_guard','Fallback: Claude over the weekly guard',en(FALLBACK),'Who takes Claude work once the weekly guard trips.','codex-astra','"wait" stalls lanes until reset.',[CHECKIN]),
  S('executors','policy.fallbacks.codex_down','Fallback: Codex down',en(FALLBACK),'Who takes Codex work when Codex is unavailable.','implementer','Moves load onto Claude weekly usage.',[CHECKIN]),
  S('executors','policy.fallbacks.fable_unavailable','Fallback: fable executor unavailable',en(FALLBACK),'Who takes the work routed to the fable executor when it is unavailable.','opus-xhigh','Opus xhigh is slower on genuinely hard proofs.',[CHECKIN]),
  ...Object.keys(POLICY_DEFAULTS.context).flatMap(a=>[
    S('context',`policy.context.${a}.no_new_step_k`,`${a}: no new step past (k tokens)`,int(30,400),'Past this context the agent starts no new step.',String(POLICY_DEFAULTS.context[a].no_new_step_k),'Higher = fewer hand-offs but costlier, less reliable late turns.',[`the ${a} agent file (policy:context.${a})`]),
    S('context',`policy.context.${a}.handoff_k`,`${a}: hand-off at (k tokens)`,int(30,400),'At this context the agent stops at a clean point and hands off (norn done --outcome handoff).',String(POLICY_DEFAULTS.context[a].handoff_k),'Higher = each turn re-reads a bigger context (cost grows per turn).',[`the ${a} agent file (policy:context.${a})`]),
    S('context',`policy.context.${a}.hard_max_k`,`${a}: hard max (k tokens)`,int(30,400),'Never run past this context.','150','Near the window limit quality drops and compaction may kick in.',[`the ${a} agent file (policy:context.${a})`])]),
  S('iteration','policy.iteration.round_estimate_default','Default round estimate per stage',int(1,10),'Rounds a stage is expected to take when its plan gives none.','2','Higher hides grinding stages longer.',[CHECKIN]),
  S('iteration','policy.iteration.escalation_multiplier','Escalate past (x round estimate)',num(1,5),'A stage past this multiple of its round estimate is escalated (rule switch D).','2','Higher = more rounds burned before escalation.',['DECISION-RULES.md (policy:iteration)',CHECKIN]),
  S('iteration','policy.iteration.escalation_action','Escalation does',en(ESCALATE),'What escalation does first.','raise effort','A stronger model / higher effort costs more per round; re-scope costs planning time.',['DECISION-RULES.md (policy:iteration)']),
  S('iteration','policy.iteration.escalation_effort','Raise effort to',en(EFFORTS),'The effort a "raise effort" escalation runs the stage at (the named escalation step).','xhigh','xhigh costs the most per round; a measured gain should back it (REPORT 4.1).',['DECISION-RULES.md (policy:iteration)',CHECKIN]),
  S('iteration','policy.iteration.wall_time_multiplier','Stop a run at (x its time budget)',num(1,5),'A run past this multiple of its brief\'s time budget stops and reports.','2','Higher lets stuck runs burn longer.',[CHECKIN]),
  S('budget','desired_burn_pct_per_h','Desired burn (%/h)',num(0,5),'Target weekly-usage burn rate the controller steers to.','0.40','Higher finishes sooner but reaches the guard before reset.',[CHECKIN]),
  S('budget','usage_rate_cap_pct_per_h','Rate cap (%/h)',num(0,5),'Above this rate STATUS says RATE_OK=0 and check-ins start nothing new.','0.43','Higher lets bursts through.',['status.ps1 (RATE_OK)']),
  S('budget','billing','Billing',en(BILLING_NAMES),'How the Claude account is paid for. A plan (pro, max-5x, max-20x, ultra) has a weekly limit: the weekly guard and the rate cap apply. api = pay per token: no weekly limit, no calibration; the daily $ cap below is the only usage hold.','your plan','A plan mode on an API account holds work for a calibration that never comes; api on a plan account lets the week run out.',[CHECKIN,'usage guard (queue fill)','dashboard Usage']),
  S('budget','api_usd_per_day','API daily cap ($)',num(0,100000),'API billing only: no new Claude work once the Claude runs of the last 24 h cost this much (the CLI\'s own cost of each ended run). 0 = no cap.','set one','No cap = nothing stops the spend but the worker cap.',['usage guard (queue fill)','dashboard Usage']),
  S('budget','weekly_stop_pct','Weekly guard (%)',num(0,100),'No new Claude worker once weekly usage reaches this.','95','Higher leaves no room for owner sessions before reset.',[CHECKIN,'dashboard Usage tab']),
  S('budget','reserve_pct_for_doors','Reserve for your own sessions (%)',num(0,50),'Weekly usage kept back for work you run yourself (installs, merges).','5','Higher idles workers earlier in the week.',[CHECKIN]),
  S('budget','reset','Weekly reset',{type:'text',pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2} local$'},'When the weekly window resets (local time).','from claude.ai usage page','—',['status.ps1','dashboard countdown']),
  S('budget','calib_pct','Calibration: weekly % at calib time',num(0,100),'Real weekly % read from the usage page at the calibration time.','re-read daily','Stale calibration makes the estimate drift.',['status.ps1 (estimate)']),
  S('budget','calib_time_utc','Calibration time (UTC)',{type:'text',pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?Z$'},'When calib_pct was read.','—','—',['status.ps1 (estimate)']),
  S('budget','cacheR_per_pct','Calibration: cache-read tokens per 1 %',int(1000000,1000000000),'Converts logged cache-read tokens to weekly %.','~41M','Wrong value skews the estimate and RATE_OK.',['status.ps1 (estimate)']),
  S('cadence','policy.cadence.checkin_interval_min','Check-in interval (min)',int(5,120),'Repetition of the scheduled tick (norn sched); Save updates the scheduler.','15','Each check-in is one Opus turn; shorter = more usage, faster reaction.',['the scheduled tick (norn sched)']),
  S('cadence','policy.cadence.trigger_on_exit','Check-in on worker / Codex exit',bool,'A finished worker or Codex run triggers a check-in at once.','on','Off = idle lanes wait for the next scheduled check-in.',['worker-run.ps1','codex-impl.sh']),
  // META-CHECKIN-DIET R1: no model for a routine end; ends folded; a check-in level per lane (engine/lib/checkins.mjs)
  S('cadence','policy.checkin.routine','Routine ends handled by code',{type:'classes',options:['merge_done','worker_done_stage']},'Run ends the tick handles itself, no check-in: merge_done = a MERGE run ended DONE (its NOTES marker) is reviewed; worker_done_stage = a worker DONE with a pushed head on an auto-stage lane gets the standard staged merge (merge-brief --sha, queued in the merge line). Each is a run review record by the launcher with its why. STOPPED, HANDOFF, no marker, an unpushed head or a question still wake a check-in.','merge_done, worker_done_stage','Empty = every end wakes a check-in (one Opus turn each, ~0.6M cache reads).',['norn tick (engine/lib/checkins.mjs)']),
  S('cadence','policy.checkin.debounce_min','Fold run ends within (min)',int(0,60),'Run ends within this window wake ONE check-in, at the oldest new end + the window; a question, owner words, a stall or a forced tick still wake at once. 0 = every end at once.','5','Higher = fewer check-ins on busy hours; a slower reaction to an end.',['norn tick (engine/lib/checkins.mjs)']),
  S('cadence','policy.checkin.auto_stage','Auto-stage lanes (worker DONE = merge)',{type:'list',glob:true},'Lanes (globs: meta-*) whose worker DONE with a pushed head is staged for merge by code (routine worker_done_stage) instead of a check-in.','none (lanes whose every DONE is the last stage)','A lane with more stages here would be merged before its next stage is ruled.',['norn tick (engine/lib/checkins.mjs)']),
  S('cadence','policy.checkin.on_end_lanes','Check-in level on-end (lanes)',{type:'list',glob:true},'Lanes (globs) whose runs wake a check-in only when they end or pass their time budget: no wake on start or on a progress stall while they run.','long design / planning lanes','A run that hangs inside its budget is seen at its budget, not after 30 idle min.',['norn tick (engine/lib/gate.mjs)']),
  S('cadence','policy.checkin.none_lanes','Check-in level none (lanes)',{type:'list',glob:true},'Lanes (globs) whose runs never wake a check-in (merge-line-only lanes: the merge queue drives them). Forced quiet check-ins still read STATUS.','none','A STOPPED run there waits for the next forced check-in.',['norn tick (engine/lib/gate.mjs)']),
  S('cadence','policy.checkin.merge_model','Staged-merge run model',en(MODELS),'Model of the MERGE run a routine worker_done_stage queues.','claude-sonnet-5-5','Opus costs ~5x Sonnet per merge run.',['norn tick (engine/lib/checkins.mjs)']),
  S('cadence','policy.checkin.merge_effort','Staged-merge run effort',en(EFFORTS),'Effort of that MERGE run.','medium','Higher effort per merge multiplies with merges.',['norn tick (engine/lib/checkins.mjs)']),
  S('cadence','policy.checkin.merge_agent','Staged-merge run agent',{type:'text',pattern:'^[A-Za-z0-9._-]{0,60}$'},'Agent of that MERGE run (blank = none).','the project runner agent','—',['norn tick (engine/lib/checkins.mjs)']),
  S('cadence','checkin_model','Check-in model',en(MODELS),'Model of the scheduled check-in and the Talk controller.','claude-opus-5-5','Opus costs ~5x Sonnet per check-in.',['checkin.ps1','dashboard Talk']),
  // CHECKIN-V2 piece 2 (GT-3 ruling): a MINOR wake (gate.mjs wakeClass) runs this model / effort on the reduced prompt CHECKIN-MINOR.md
  S('cadence','checkin_minor_model','Minor check-in model',en(['',...MODELS]),'Model of a MINOR check-in (a forced quiet tick, a run start by another, the guard band): the reduced prompt engine/prompts/CHECKIN-MINOR.md; it escalates with MAJOR NEEDED. Empty = every tick is the full check-in.','claude-sonnet-5-5','Opus on minor ticks costs ~5x Sonnet for ticks that mostly act on nothing.',['norn tick (engine/lib/tick.mjs)']),
  S('cadence','checkin_minor_effort','Minor check-in effort',en(EFFORTS),'Effort of a MINOR check-in.','medium','Higher effort per minor tick multiplies with their count.',['norn tick (engine/lib/tick.mjs)']),
  S('cadence','checkin_effort','Check-in effort',en(EFFORTS),'Effort of the check-in.','medium','Higher effort per check-in multiplies with the interval.',['checkin.ps1','dashboard Talk']),
  // META-CHECKIN-GATE: norn tick wakes the LLM check-in only on a material change (engine/lib/gate.mjs); a slow forced check-in stays
  S('cadence','checkin_gate','Check-in gate (wake on change only)',bool,'A tick (scheduled or run exit) starts the LLM check-in only when the material state changed since the last one: run starts / ends / kills / stalls, owner records, questions, ready lanes, guard band, quiet flag / pause. No change = a logged skip.','on','Off = every tick is one Opus check-in (~0.9M cache-read tokens each), about half of them with nothing to do.',['norn tick (engine/lib/gate.mjs)']),
  S('cadence','checkin_max_quiet_min','Forced check-in after (min quiet)',int(15,1440),'With the gate on, a check-in still runs once the last real one is older than this, change or not.','60','Lower = more no-change check-ins (one Opus turn each); higher = slower reaction to what the gate does not see (time-only rules).',['norn tick (engine/lib/gate.mjs)']),
  // CHECKIN-V2 piece 3: quiet backoff (Gas Town await-signal min(base * 2^idle, max)): an idle forced check-in doubles the next window up to this
  S('cadence','checkin_quiet_max_min','Quiet backoff cap (min)',int(15,1440),'A forced quiet check-in that acted on nothing doubles the next forced window (from checkin_max_quiet_min) up to this; any change resets it. At or below the forced window = no backoff.','240','Higher = fewer idle check-ins on a quiet day; slower reaction to time-only rules when nothing at all changes.',['norn tick (engine/lib/gate.mjs)']),
  // H2: the check-in and the dashboard chat are executors too; only claude is wired today (other families: H7 trial / H5 chat)
  S('cadence','checkin_executor','Check-in executor',en(HARNESS_EXECUTORS),'Executor (harness) of the scheduled check-in.','claude','Other harnesses open with the H7 trial (auto-fallback to claude).',['norn tick']),
  S('cadence','checkin_executor_trial','Check-in executor trial (H7)',bool,'On: a check-in executor other than claude runs the check-in; a tick that ends non-DONE (crash, limit, no final) is re-run on claude at once (recorded as fallback_of). Off: only claude runs check-ins.','off','A failed trial tick costs its own run plus the claude re-run.',['norn tick','supervisor (fallback)']),
  // META-CONTROLLER C5 (SPEC sec. 4 + 8 C5 row): the controller chat's rows - read live by the dashboard (the next message) and the MCP server
  // (every call); no restart. A model / effort / raw-shell change restarts an idle chat process on the next message (same session, resumed).
  S('cadence','chat_executor','Chat harness',en(CHAT_EXECUTORS),'Executor (harness) of the controller chat (the Home thread) and the Ask box.','claude','Other harnesses open with C7 (chat on adapters).',['dashboard Home chat']),
  S('cadence','chat_model','Chat model',en(['',...MODELS]),'Model of the controller chat. Blank = the check-in model.','(the check-in model)','Opus costs ~5x Sonnet per turn; the chat is lazy, so an idle day costs nothing.',['dashboard Home chat']),
  S('cadence','chat_effort','Chat effort',en(['',...EFFORTS]),'Effort of the controller chat. Blank = the check-in effort.','(the check-in effort)','Higher effort = more thinking tokens per turn.',['dashboard Home chat']),
  S('cadence','chat_idle_min','Chat idle stop (min)',int(1,240),'The chat process is stopped after this many idle minutes; the next message resumes the session.','15','Longer keeps the prompt cache warm between messages; an idle process holds ~200-400 MB RAM.',['dashboard Home chat']),
  S('cadence','chat_hold_min','Lane hold length (min)',int(5,240),'A controller act on a lane holds it this long (check-ins skip a held lane, exit 5); each act extends it.','30','Longer = check-ins stay off a lane the chat touched for longer.',['norn mcp (chat / controller profiles)']),
  S('cadence','chat_raw_shell','Chat raw shell and file edits',en(['off','ask','on']),'Shell (Bash / PowerShell) and file-edit tools in the chat: off = refused; ask = an approval card each time; on = allowed.','off','On lets the chat change files and run commands with no tap - off by default (SPEC sec. 3 tier 3).',['dashboard Home chat','norn mcp (chat profile)']),
  S('agents','claude_model','Claude worker model (default)',en(MODELS),'Worker default when the check-in passes no model.','claude-opus-5-5','Opus costs ~5x Sonnet.',['worker.ps1 (default)']),
  // the worker floor (floor.mjs): no worker run below it; a worker setting below it is refused, raising it raises the ones below
  S('agents','worker_min_model','Minimum worker model',en(['',...FLOOR_MODELS]),'The lowest Claude model any worker run may use (merges, helpers and reviews included; check-ins and the chat keep their own model). A run asked for less is raised to it; a worker model setting below it is refused, and raising it raises the settings below it in the same save. Blank = no minimum.','(blank)','A stronger minimum costs more per run (Opus ~5x Sonnet).',['norn run / the queue fill (raises the run)','Settings save (refuses / raises)',CHECKIN]),
  S('agents','worker_min_effort','Minimum worker effort',en(['',...EFFORTS]),'The lowest effort any Claude worker run may use; same rules as the minimum model. Blank = no minimum.','(blank)','Each effort step roughly doubles thinking tokens.',['norn run / the queue fill (raises the run)','Settings save (refuses / raises)',CHECKIN]),
  S('agents','claude_effort','Claude worker effort (default)',en(EFFORTS),'Worker default when the check-in passes no effort.','medium','Each step up roughly doubles thinking.',['worker.ps1 (default)']),
  S('agents','codex_astra_effort','codex-astra effort (default)',en(EFFORTS),'Default effort of codex-astra runs.','xhigh','xhigh is slow; medium misses hard cases.',['codex-impl.sh (default)']),
  S('agents','codex_sol_effort','codex-sol effort (default)',en(EFFORTS),'Default effort of codex-sol runs.','medium','—',[CHECKIN]),
  ...['A','B','C','D'].map(k=>S('speed',`policy.speed_mode.${k}`,`Rule switch ${k}`,bool,{A:'Decide, don\'t stop (rules 7 + a + c).',B:'Determinism proofs at merges + installs only.',C:'Speed / RAM budgets measured at merges + installs.',D:'Escalate a stage past the escalation multiplier.'}[k],'on','Off = slower stages (more stops / proofs per round).',['DECISION-RULES.md (policy:speed_mode)',CHECKIN])),
  S('speed','rules.quiet_gpu','House rule line',{type:'text'},'Shown read-only: edit the rules file line 1 by hand (owner rule, not a dial).','as written','—',['${project rules}/common-rules.txt line 1'],{readonly:true})];
// META-UX-R1 information architecture: the Settings tab's categories -> sub-categories (-> sub-sub-categories only where a
// setting family repeats per work class / role). UI placement only: a key's name, file and meaning never depend on its section.
// SECTION_RULES map every key (first match wins; `$1` = the key's captured family name) - tests/settings-ia proves no orphan.
const ROLES={implementer:'Implementer',planner:'Planner',runner:'Runner',controller:'Controller',checkin:'Check-in'};
export const SECTIONS=[
  {id:'workers',label:'Workers & budget',help:'How much runs at once and how fast the weekly usage may burn.',subs:[
    {id:'usage',label:'Weekly usage guard',help:'The guard every check-in obeys before it starts a Claude worker.'},
    {id:'calibration',label:'Usage calibration',help:'Re-read from the claude.ai usage page; STATUS turns logged tokens into weekly %.'},
    {id:'claude',label:'Claude workers',help:'Claude worker lanes alive at once (norn run refuses past the cap).'},
    {id:'codex',label:'Codex runs',help:'Concurrent Codex runs; codex-astra + codex-sol fit inside the total.'},
    {id:'helpers',label:'Own-account executors & helpers',help:'Own-account executors (configured in project.json) and norn delegate helpers.'}]},
  {id:'executors',label:'Executors & models',help:'Who does which kind of work, with which model and effort.',subs:[
    {id:'routing',label:'Work-class routing',help:'One line per work class: executor, model, effort (blank = the executor default).',inline:true,
      subs:Object.entries(WORK_CLASSES).map(([id,label])=>({id,label}))},
    {id:'defaults',label:'Default model & effort',help:'Launcher defaults when the check-in passes none.'},
    {id:'floor',label:'Minimum for workers',help:'No worker run below this model and effort: lower settings are refused, lower runs are raised.'},
    {id:'critical',label:'Critical path',help:'Lanes blocking the next release get the critical effort.'},
    {id:'fallbacks',label:'Fallbacks',help:'Who takes the work when an executor is unavailable or over its guard.'}]},
  {id:'agents',label:'Agents & context',help:'Context hand-off limits per agent role, rounds and escalation.',subs:[
    {id:'context',label:'Context limits (k tokens)',help:'No new step past / hand-off at / hard max - generated into each agent file.',inline:true,
      subs:Object.entries(ROLES).map(([id,label])=>({id,label}))},
    {id:'iteration',label:'Rounds & escalation',help:'When a stage counts as grinding and what happens then.'}]},
  {id:'checkins',label:'Check-ins & scheduling',help:'When the scheduled check-in runs and on which model.',subs:[
    {id:'schedule',label:'Schedule',help:'Task Scheduler repetition and exit triggers.'},
    {id:'model',label:'Check-in model',help:'The check-in and the dashboard Talk controller.'}]},
  {id:'chat',label:'Controller chat',help:'The controller chat on the Home tab: its harness, model, idle stop, lane holds and raw shell. Read live - no restart.',subs:[
    {id:'session',label:'Session',help:'Harness, model, effort and idle stop of the chat process (the next message obeys a change).'},
    {id:'acting',label:'Acting',help:'How long a chat act holds a lane, and whether shell / file edits are off, ask, or on.'}]},
  {id:'rules',label:'Rule switches',help:'Project rule switches (DECISION-RULES) and the house rule line.',subs:[
    {id:'speed',label:'Rule switches A-D',help:'An OFF item does not apply (generated into DECISION-RULES.md).'},
    {id:'gpu',label:'House rule line (read-only)',help:'Line 1 of the project rules file, edited by hand.'}]},
  {id:'advanced',label:'Advanced',help:'Rarely changed: executor permissions, harness wiring, fixed and dangerous values.',subs:[
    {id:'ranks',label:'Allowed work classes',help:'Which classes each executor may be given; routing offers only allowed executors.'},
    {id:'harness',label:'Harness',help:'Only claude is wired today (H5 / H7 open the others).'},
    {id:'danger',label:'Danger zone',help:'A wrong value here skews the usage gate or breaks the one-writer rule.',danger:true}]},
  {id:'voice',label:'Slop voice',help:'SloppaChoppa on the Slop page: his pop-ups and how often (DEC-264).',subs:[
    {id:'switch',label:'On / off',help:'One switch for all of SloppaChoppa in this project (DIR-52); his pop-ups are the row below.'},
    {id:'popups',label:'Pop-ups',help:'Off by default until the owner review of SloppaChoppa (DIR-36).'}]},
  {id:'notify',label:'Notifications',basic:true,help:'A phone or desktop ping when Norn needs you (machine.json notify; norn setup --notify).',info:true,subs:[
    {id:'ping',label:'Phone / desktop ping'},{id:'remote',label:'Reach Norn from your phone'}]},
  {id:'files',label:'Project & files',help:'Where each setting is stored and the generated policy lines.',info:true,subs:[
    {id:'sources',label:'Source files'},{id:'targets',label:'Policy targets'}]}];
export const SECTION_RULES=[
  [/^(billing|api_usd_per_day|desired_burn_pct_per_h|usage_rate_cap_pct_per_h|weekly_stop_pct|reserve_pct_for_doors|reset)$/,'workers/usage'],
  [/^(calib_pct|calib_time_utc)$/,'workers/calibration'],
  [/^(cacheR_per_pct|policy\.agents\.max_lane_writers)$/,'advanced/danger'],
  [/^(max_claude_workers|policy\.dispatch_window\.max)$/,'workers/claude'],
  [/^max_(codex|astra|sol)$/,'workers/codex'],
  [/^(max_[a-z0-9_-]+|policy\.delegate\.max_per_parent|policy\.ask\.max_per_day)$/,'workers/helpers'],
  [/^policy\.executors\.([a-z_]+)\.(executor|model|effort)$/,'executors/routing/$1'],
  [/^(claude_model|claude_effort|codex_astra_effort|codex_sol_effort)$/,'executors/defaults'],
  [/^worker_min_(model|effort)$/,'executors/floor'],
  [/^policy\.critical_(lanes|effort)$/,'executors/critical'],
  [/^policy\.fallbacks\./,'executors/fallbacks'],
  [/^policy\.context\.([a-z]+)\.[a-z_]+$/,'agents/context/$1'],
  [/^policy\.iteration\./,'agents/iteration'],
  [/^policy\.stuck\./,'agents/iteration'],
  [/^policy\.mail\./,'agents/iteration'],
  [/^policy\.dod\./,'agents/iteration'],
  [/^policy\.overlap\./,'agents/iteration'],
  [/^policy\.instructions\./,'agents/iteration'],
  [/^policy\.slop\./,'voice/switch'],
  [/^policy\.voice\./,'voice/popups'],
  [/^policy\.guard\./,'workers/usage'],
  [/^policy\.holds\./,'workers/usage'],
  [/^policy\.holds\./,'workers/usage'],
  [/^policy\.launch\./,'advanced/harness'],
  [/^policy\.cadence\./,'checkins/schedule'],
  [/^policy\.checkin\./,'checkins/schedule'],
  [/^(checkin_gate|checkin_max_quiet_min|checkin_quiet_max_min)$/,'checkins/schedule'],
  [/^(checkin_model|checkin_effort|checkin_minor_model|checkin_minor_effort)$/,'checkins/model'],
  [/^(checkin_executor|checkin_executor_trial)$/,'advanced/harness'],
  [/^chat_(executor|model|effort|idle_min)$/,'chat/session'],
  [/^chat_(hold_min|raw_shell)$/,'chat/acting'],
  [/^policy\.speed_mode\./,'rules/speed'],
  [/^rules\./,'rules/gpu'],
  [/^policy\.allowed_classes\./,'advanced/ranks']];
/** [category, sub-category(, sub-sub-category)] of a setting row, or null (an orphan: tests/settings-ia fails). */
export function sectionOf(s){for(const [re,at] of SECTION_RULES){const m=s.key.match(re);if(m)return at.replace('$1',m[1]??'').split('/');}return null;}
const ALL_CLASSES=Object.keys(WORK_CLASSES);
/** Work classes executor `name` may do: policy.allowed_classes.<name>, else a configured typed executor -> chores + passfail, else all. */
export function allowedClasses(policy,name,providers=[]){
  if(name==='auto')return ALL_CLASSES;
  const a=policy?.allowed_classes?.[name];if(Array.isArray(a))return a;
  return providers.includes(name)?[...PROVIDER_CLASSES]:ALL_CLASSES;}
const rankNames=(providers,extra)=>{const ex=executorsOf(extra);return [...ex.filter(e=>e!=='auto'),...providers.filter(p=>!ex.includes(p))];};
// SETTINGS + the per-project dynamic part: the project's role agents and provider names in the executor dropdowns, its implementer
// in the fallback dropdowns, one allowed-classes row per executor
export function settingsFor(extra={}){const pv=extra.providers||[],ex=executorsOf(extra),fb=fallbacksOf(extra);
  const base=SETTINGS.map(s=>s.group==='executors'&&s.key.endsWith('.executor')?{...s,options:[...ex,...pv.filter(p=>!ex.includes(p))]}
    :s.key.startsWith('policy.fallbacks.')?{...s,options:fb}:s);
  if(!pv.length&&!extra.ranks)return [...base,...rankRows([],extra)];
  const at=base.map(s=>s.group).lastIndexOf('agents')+1;
  return [...base.slice(0,at),...capRows(pv,extra.caps),...base.slice(at),...rankRows(pv,extra)];}
// metaexec X1: one cap row per configured typed executor = the machine budget key norn run enforces (max_<name>; unset = the
// entry's cap, else 1 - extra.caps)
const capOf=(caps,n)=>caps?.[n]??PROVIDER_CAP_DEFAULT;
const capRows=(pv,caps)=>pv.map(n=>[n,capKey(n)]).filter(([,k])=>!SETTINGS.some(s=>s.key===k)).map(([n,k])=>S('agents',k,`Max ${n} runs`,int(0,12),
  `Concurrent ${n} runs machine-wide (own-account executor, lane runs + norn delegate helpers); unset = ${capOf(caps,n)}.`,String(capOf(caps,n)),'Its own account\'s rate limits; more = more parallel provider runs.',['norn run (exit 4 past the cap)']));
const isCapRow=(k,pv)=>pv.some(n=>capKey(n)===k)&&!SETTINGS.some(s=>s.key===k);
const rankRows=(pv,extra)=>rankNames(pv,extra).map(n=>S('ranks',`policy.allowed_classes.${n}`,`${n}: allowed work classes`,{type:'classes',options:ALL_CLASSES},
  `Work classes ${n} may be given (comma list; hover the field for the names). Class dropdowns offer only allowed executors.`,
  pv.includes(n)?'chores, passfail':'all','Wider = cheaper executors take harder work; a class -> executor pairing outside this list is refused.',['the dispatch skill (policy:executors)',CHECKIN]));
export const MACHINE_DEFAULTS={desired_burn_pct_per_h:0.4,reserve_pct_for_doors:5,checkin_executor:'claude',checkin_executor_trial:false,chat_executor:'claude',chat_idle_min:15,chat_hold_min:30,chat_raw_shell:'off',checkin_gate:true,checkin_max_quiet_min:60,checkin_quiet_max_min:240,checkin_minor_model:'claude-sonnet-5-5',checkin_minor_effort:'medium'};
// META-OOTB F-3: the starter caps `norn setup` writes when local/budget.json is absent = the default profile's budget
// (META-OOTB-POLISH F-6: engine/presets/profiles/try-it.json, engine/lib/profiles.mjs)
// the caps the scheduler needs before it may start check-ins unattended (`norn sched install` refuses while one is unset)
export const REQUIRED_CAPS=['max_claude_workers','max_codex','weekly_stop_pct','usage_rate_cap_pct_per_h'];
// API billing (billing.mjs) has no weekly limit: its weekly guard and rate cap are not needed
export const API_FREE_CAPS=['weekly_stop_pct','usage_rate_cap_pct_per_h'];
export const capsMissing=b=>REQUIRED_CAPS.filter(k=>!Number.isFinite(b?.[k])&&!(isApi(b)&&API_FREE_CAPS.includes(k)));
// a cap as text: an unset cap is no limit (runs.mjs capFull) and says so - never an empty string
export const capText=v=>(v===undefined||v===null||v===''?'unset (no limit)':String(v));
// META-OOTB-POLISH F-6: the Settings keys a newcomer decides first (the Settings "basic" view): caps, weekly stop, check-in model /
// effort, check-in interval
export const BASIC_KEYS=['billing','max_claude_workers','max_codex','weekly_stop_pct','usage_rate_cap_pct_per_h','checkin_model','checkin_effort','policy.cadence.checkin_interval_min'];
export const scopeOf=k=>k.startsWith('rules.')?'file':k.startsWith('policy.')?'project':'machine';
// merged view <-> the two files: budget = machine keys only, policy = the project policy object
export const merged=(budget,policy)=>({...budget,policy:policy??{}});
export function split(m){const {policy,...budget}=m;return {budget,policy};}
export function atomicWrite(p,contents){const tmp=p+'.dash-'+randomUUID()+'.tmp';
  try{fs.writeFileSync(tmp,contents,{encoding:'utf8',flag:'wx'});fs.renameSync(tmp,p);}finally{try{fs.unlinkSync(tmp);}catch{/* renamed */}}}
// the ONE writer of the machine budget (dash Settings save, norn calib): `updated` = applySettings' validated merged view; its machine part
// goes over the file's budget (keys no setting names are kept), atomically. false = nothing changed, nothing written.
export function writeBudget(file,budget,updated){const next=split(updated).budget;if(JSON.stringify(next)===JSON.stringify(budget))return false;
  fs.mkdirSync(path.dirname(file),{recursive:true});atomicWrite(file,JSON.stringify({...budget,...next},null,2)+'\n');return true;}
// META-DASH-ASYNC R1 (option a): the dash server's forms on fs.promises (a sync write blocks the event loop); the CLI keeps the sync ones
export async function atomicWriteAsync(p,contents){const fp=fs.promises,tmp=p+'.dash-'+randomUUID()+'.tmp';
  try{await fp.writeFile(tmp,contents,{encoding:'utf8',flag:'wx'});await fp.rename(tmp,p);}finally{await fp.unlink(tmp).catch(()=>{/* renamed */});}}
export async function writeBudgetAsync(file,budget,updated){const next=split(updated).budget;if(JSON.stringify(next)===JSON.stringify(budget))return false;
  await fs.promises.mkdir(path.dirname(file),{recursive:true});await atomicWriteAsync(file,JSON.stringify({...budget,...next},null,2)+'\n');return true;}

const parts=k=>k.split('.');
export function getPath(o,k){let x=o;for(const p of parts(k)){if(x===null||typeof x!=='object')return undefined;x=x[p];}return x;}
function setPath(o,k,v){const ps=parts(k);let x=o;for(const p of ps.slice(0,-1)){if(x[p]===null||typeof x[p]!=='object'||Array.isArray(x[p]))x[p]={};x=x[p];}x[ps.at(-1)]=v;}
function merge(d,v){if(d===null||typeof d!=='object'||Array.isArray(d))return v===undefined?structuredClone(d):v;const o={...structuredClone(d)};for(const [k,x] of Object.entries(v??{}))o[k]=merge(d[k],x);return o;}
// META-BETA-PREP (DIR-52): the old hidden policy.slop.run_end folds into policy.slop.enabled on every read (an explicit enabled wins);
// a Settings save writes the folded policy, so run_end leaves project.json. slopOn = the ONE reader of the switch.
const foldSlop=pol=>{const s=pol?.slop;if(!s||typeof s!=='object'||!('run_end' in s))return pol;const {run_end,...rest}=s;return {...pol,slop:{enabled:run_end!==false,...rest}};};
export const slopOn=pol=>foldSlop(pol)?.slop?.enabled!==false;
export function withDefaults(b){return {...MACHINE_DEFAULTS,...b,policy:merge(POLICY_DEFAULTS,foldSlop(b.policy))};}

export function settingsView(b,extra={}){const f=withDefaults(b),pv=extra.providers||[];
  // the machinery default = the value the same key takes with no budget / policy entry (UI marker only; never written)
  const dflt=extra.noDefaults?{}:Object.fromEntries(settingsView({},{...extra,noDefaults:true}).filter(s=>s.scope!=='file').map(s=>[s.key,s.value]));
  return settingsFor(extra).map(s=>{const scope=scopeOf(s.key);const value=s.key.startsWith('policy.allowed_classes.')?allowedClasses(f.policy,s.key.slice(23),pv)
      :isCapRow(s.key,pv)?(getPath(f,s.key)??capOf(extra.caps,s.key.slice(4)))
      :s.key==='rules.quiet_gpu'?(extra.quietRule??'(see file)'):getPath(f,s.key);
    const m=s.key.match(/^policy\.executors\.([a-z_]+)\.executor$/);
    const fl=floorOf(f),wk=fl&&workerKind(s.key);   // the worker floor: options below it are not offered (the value in force stays shown)
    const opts=m?{options:s.options.filter(o=>o===value||allowedClasses(f.policy,o,pv).includes(m[1]))}
      :wk?{options:s.options.filter(o=>o===value||!(wk==='model'?modelBelow(o,fl.model):effortBelow(o,fl.effort)))}:{};
    const dv=dflt[s.key],modified=dv!==undefined&&value!==undefined&&JSON.stringify(dv)!==JSON.stringify(value);
    return {...s,...opts,scope,value,section:sectionOf(s),default:dv,modified,basic:BASIC_KEYS.includes(s.key),
    home:scope==='file'?(extra.quietFile??'(rules file)'):scope==='project'?'project.json '+s.key:'machine budget.json '+s.key};});}

function check(s,v){
  if(s.readonly&&s.type!=='int')throw fail(`${s.key} is read-only`);
  if(s.type==='int'||s.type==='num'){if(typeof v!=='number'||!Number.isFinite(v)||(s.type==='int'&&!Number.isInteger(v))||v<s.min||v>s.max)throw fail(`${s.key} must be ${s.type==='int'?'an integer':'a number'} ${s.min}-${s.max}`);}
  else if(s.type==='bool'){if(typeof v!=='boolean')throw fail(`${s.key} must be true or false`);}
  else if(s.type==='enum'){if(!s.options.includes(v))throw fail(`${s.key} must be one of ${s.options.map(o=>o||'(blank)').join(', ')}`);}
  else if(s.type==='classes'){if(!Array.isArray(v)||v.some(x=>!s.options.includes(x))||new Set(v).size!==v.length)throw fail(`${s.key} must be a list of distinct work classes (${s.options.join(', ')})`);}
  else if(s.type==='list'){if(!Array.isArray(v)||v.some(x=>typeof x!=='string'||!(s.glob?/^[a-z0-9*][a-z0-9*-]{0,40}$/:/^[a-z0-9][a-z0-9-]{0,40}$/).test(x)))throw fail(`${s.key} must be a list of lane names${s.glob?' (globs: meta-*)':''}`);}
  else if(s.type==='text'){if(typeof v!=='string'||(s.pattern&&!new RegExp(s.pattern).test(v)))throw fail(`${s.key} has an invalid format`);}
}
// META-PROFILE-BUG R1: what a save writes = the raw {...budget, policy} with ONLY the changed keys set (value as validated in `updated`,
// skipped when it equals the value in force): defaults are never written out over the project's own values.
export function onlyChanged(b,changes,updated){const f=withDefaults(b),out={...structuredClone(b),policy:structuredClone(foldSlop(b.policy)??{})};
  for(const k of Object.keys(changes)){const v=getPath(updated,k);if(JSON.stringify(getPath(f,k))===JSON.stringify(v))continue;setPath(out,k,v);}
  return out;}
// Returns the new merged {...budget, policy} object (input untouched); 400 on unknown key, bad value or broken cross-field rule.
// The worker floor: a worker setting this save sets below the floor in force after it is refused (the keys it leaves alone are raised by
// floorChanges, which every save path runs first; a key left below by a caller that did not is raised at launch anyway).
export function applySettings(b,changes,extra={}){const out=applySettingsRaw(b,changes,extra);
  const low=belowFloor(out).filter(r=>Object.hasOwn(changes,r.key));
  if(low.length)throw fail(`${low.map(r=>`${r.key} = ${r.value}`).join(', ')}: below the worker minimum (${floorText(floorOf(out))}) - pick ${low.length>1?'values':'a value'} at or above it, or lower worker_min_model / worker_min_effort first`);
  return out;}
function applySettingsRaw(b,changes,extra={}){const all=settingsFor(extra),pv=extra.providers||[];
  if(changes===null||typeof changes!=='object'||Array.isArray(changes)||!Object.keys(changes).length)throw fail('changes must be a non-empty object');
  const out=structuredClone(b);out.policy=merge(POLICY_DEFAULTS,foldSlop(out.policy));
  for(const [k,v] of Object.entries(changes)){const s=all.find(x=>x.key===k);if(!s)throw fail('Unknown setting '+k);check(s,v);setPath(out,k,v);}
  if(out.max_astra>out.max_codex||out.max_sol>out.max_codex)throw fail('Astra and Sol caps must fit inside the Codex total');
  for(const [k,e] of Object.entries(out.policy.executors)){const ok=allowedClasses(out.policy,e.executor,pv);
    if(!ok.includes(k))throw fail(`${e.executor} is not allowed to do ${(WORK_CLASSES[k]??k).toLowerCase()} work (its allowed classes: ${ok.join(', ')||'none'}) - pick another executor or widen ${e.executor}'s allowed classes first`);}
  for(const [a,c] of Object.entries(out.policy.context))if(!(c.no_new_step_k<=c.handoff_k&&c.handoff_k<=c.hard_max_k))throw fail(`context.${a}: no-new-step <= hand-off <= hard max`);
  return out;
}
// ---------- the worker floor (floor.mjs) in Settings ----------
const WORKER_MODEL_KEYS=/^(claude_model|policy\.checkin\.merge_model|policy\.executors\.[a-z_]+\.model)$/;
const WORKER_EFFORT_KEYS=/^(claude_effort|policy\.checkin\.merge_effort|policy\.executors\.[a-z_]+\.effort|policy\.critical_effort|policy\.iteration\.escalation_effort)$/;
/** 'model' | 'effort' when setting `key` chooses a worker model / effort the floor binds, else null */
export const workerKind=key=>WORKER_MODEL_KEYS.test(key)?'model':WORKER_EFFORT_KEYS.test(key)?'effort':null;
/** the worker settings of merged view `m` (withDefaults applied) below its floor: [{ key, kind, value, to }] */
export function belowFloor(m){const f=floorOf(m);if(!f)return [];const v=withDefaults(m),out=[],p=v.policy;
  const model=(key,val)=>{if(f.model&&modelBelow(val,f.model))out.push({key,kind:'model',value:val,to:f.model});};
  // an effort counts only where the model is a Claude one (or blank on a Claude-side executor): a codex effort is not Claude's scale
  const effort=(key,val,mod,exr)=>{const claude=mod?!!claudeRank(mod):!exr||CLAUDE_SIDE.has(exr)||!/^codex-|^gpt/.test(String(exr));
    if(claude&&f.effort&&effortBelow(val,f.effort))out.push({key,kind:'effort',value:val,to:f.effort});};
  model('claude_model',v.claude_model);effort('claude_effort',v.claude_effort,v.claude_model);
  model('policy.checkin.merge_model',p.checkin.merge_model);effort('policy.checkin.merge_effort',p.checkin.merge_effort,p.checkin.merge_model);
  for(const [k,e] of Object.entries(p.executors)){model(`policy.executors.${k}.model`,e.model);effort(`policy.executors.${k}.effort`,e.effort,e.model,e.executor);}
  effort('policy.critical_effort',p.critical_effort);effort('policy.iteration.escalation_effort',p.iteration.escalation_effort);
  return out;}
/**
 * The changes of a Settings save with the floor's raises added: every worker setting the save leaves below the floor in force after it
 * (a new or raised floor) is raised to the floor, unless the save sets that key itself (then applySettings refuses it, naming it).
 * -> { changes (the input + the raises), raised: [{ key, from, to }] }
 */
export function floorChanges(b,changes,extra={}){
  let trial;try{trial=applySettingsRaw(b,changes,extra);}catch{return {changes,raised:[]};}   // a bad change: applySettings says why
  const raised=belowFloor(trial).filter(r=>!Object.hasOwn(changes,r.key)).map(r=>({key:r.key,from:r.value,to:r.to}));
  return {changes:{...changes,...Object.fromEntries(raised.map(r=>[r.key,r.to]))},raised};}

const onoff=v=>v?'on':'OFF';
export function generatedLines(b,extra={}){const f=withDefaults(b),p=f.policy,c=p.context,it=p.iteration,pv=extra.providers||[];
  const narrow=rankNames(pv,extra).map(n=>[n,allowedClasses(p,n,pv)]).filter(([,a])=>a.length!==ALL_CLASSES.length||!ALL_CLASSES.every(x=>a.includes(x)));
  const ranks=` Allowed classes: ${narrow.map(([n,a])=>`${n} ${a.join('+')||'none'}`).join('; ')}${narrow.length?'; others all':'all executors all'}.`;
  const exs=Object.entries(p.executors).map(([k,e])=>`${k} -> ${[e.executor,e.model,e.effort].filter(Boolean).join(' ')}`).join('; ');
  return {
    'context.implementer':`HANDOFF: start NO new step past ~${c.implementer.no_new_step_k}k; at ~${c.implementer.handoff_k}k (even mid-wait) stop at a clean point (work committed), hand off: \`norn done --outcome handoff --handoff-file F\``,
    'context.planner':`HANDOFF (OWNER 2026-10-29): start NO new step (probe, bake, investigation) past ~${c.planner.no_new_step_k}k. Past ${c.planner.no_new_step_k}k you MAY run to ~${c.planner.handoff_k}k to FINISH`,
    'context.runner':`- Long runs via run_in_background; read log tails, never whole logs. HANDOFF at ~${c.runner.handoff_k}k: clean point, then \`norn done --outcome handoff --handoff-file F\`.`,
    'context.controller':`Controller hand-off: start no new step past ~${c.controller.no_new_step_k}k; hand off at ~${c.controller.handoff_k}k; never past ~${c.controller.hard_max_k}k.`,
    'iteration':`D. Controller: a stage past ~${it.escalation_multiplier}x its round estimate is escalated (first: ${it.escalation_action}${it.escalation_action==='raise effort'?` to ${it.escalation_effort}`:''}; Opus xhigh / Fable) or re-scoped, never left to grind.`,
    'speed_mode':`SPEED MODE switches (dashboard Settings): A ${onoff(p.speed_mode.A)}, B ${onoff(p.speed_mode.B)}, C ${onoff(p.speed_mode.C)}, D ${onoff(p.speed_mode.D)} - an OFF item does not apply.`,
    'executors':`POLICY (dashboard Settings, project policy.executors; wins over the table): ${exs}. Critical lanes [${p.critical_lanes.join(', ')}] at ${p.critical_effort}. Own-account executors on: ${(extra.enabled||[]).join(', ')||'none'}.${ranks}${floorOf(f)?` Worker minimum: ${floorText(floorOf(f))} (lower routes are raised at launch).`:''}`,
    'checkin':`POLICY (generated from the machine budget + project policy on Save): caps ${capText(f.max_claude_workers)} Claude / ${capText(f.max_codex)} Codex (${capText(f.max_astra)} Astra, ${capText(f.max_sol)} Sol), 1 writer per lane; ${isApi(f)?`API billing: no weekly limit, ${usdCap(f)===null?'no daily $ cap':`daily cap $${usdCap(f)}`}`:`weekly guard ${capText(f.weekly_stop_pct)} %`}, reserve ${f.reserve_pct_for_doors} % for doors, desired burn ${f.desired_burn_pct_per_h} %/h (cap ${capText(f.usage_rate_cap_pct_per_h)}); default round estimate ${it.round_estimate_default}, escalate past ${it.escalation_multiplier}x (${it.escalation_action}); stop runs at ${it.wall_time_multiplier}x their time budget; critical lanes [${p.critical_lanes.join(', ')}] at ${p.critical_effort}; fallbacks: Claude over guard -> ${p.fallbacks.claude_over_guard}, Codex down -> ${p.fallbacks.codex_down}, Fable unavailable -> ${p.fallbacks.fable_unavailable}; own-account executors on: ${(extra.enabled||[]).join(", ")||"none"}; SPEED MODE A ${onoff(p.speed_mode.A)} B ${onoff(p.speed_mode.B)} C ${onoff(p.speed_mode.C)} D ${onoff(p.speed_mode.D)}.`};
}
const MARK=/<!-- policy:([a-z_.]+) -->\s*$/;
export function rewriteMarked(text,lines){const eol=text.includes('\r\n')?'\r\n':'\n',changed=[],unknown=[];
  const out=text.split(eol).map(l=>{const m=l.match(MARK);if(!m)return l;const g=lines[m[1]];if(g===undefined){unknown.push(m[1]);return l;}
    const n=`${g} <!-- policy:${m[1]} -->`;if(n!==l)changed.push(m[1]);return n;});
  return {text:out.join(eol),changed,unknown};}
/** Executors (not 'auto') allowed to do work class `cls` - for code that picks a helper by class (e.g. a future `norn delegate`). */
export function executorsFor(policy,cls,providers=[],agents){return rankNames(providers,{agents}).filter(n=>allowedClasses(policy,n,providers).includes(cls));}
