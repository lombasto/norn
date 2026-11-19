# lane-purpose S1 (RM-34) - notes

## What was built
- `engine/lib/purpose.mjs` `laneDriver(name, { items, roadmap, briefTitle, briefsDir, project })` -> `{ objective, sources: [{ kind, id, title, href[, doc] }], finding }`.
  Source order (the first names the objective): rm (roadmap items linking `lane:<name>` or `run:<a lane run>`, plus RM-n named in a brief heading),
  dir (live directives scoped to the lane or named in a brief heading; superseded / revoked skipped), q/dec (only when no rm/dir: open questions,
  decisions on the lane), brief (newest brief of a non-landing run - MERGE*, resolve skipped - else `<briefs_dir>/<lane>.md`), doc (the
  driving items' `doc:` links). No source = `finding: 'no recorded driver'` (for lane norn-lifecycle to read; no rule duplicated here).
- Lanes page: under the lane name a `<details class="lane-why">` - the objective truncated (title = full), a tap opens it with every source
  and its title; below, the sources as small links (RM/DIR/DEC/Q -> `a[data-rid]`, brief/doc -> the Docs reader). None -> a warn chip.
- Docs reader: two new keys `brief:<file>` (project briefs_dir) and `doc:<path>` (under project root); anything leaving those folders 404s.
- Runs page: a Lane column (lane linked to its row via `L:<lane>`, stage beside it; check-in -> "check-in"; talk -> dash). Session = id + agent
  name only; class / question / lane·stage / outcome / helpers moved to its title. Phone (<=1100 px): the Lane cell is the row's second line.
- RM-30's shared renderer is not on main: the objective is plain text.

## Findings (records vs the brief's examples)
- The brief expected solve-shack docs-fixer-2 -> none and norn capacity-ux -> brief only. Today's records link both: RM-26 links
  `lane:docs-fixer-2` (seq 48, the same second the check-in created the lane) and RM-21 links capacity-ux (19:42). The tests use the real
  record lines as they stood before those links (docs-fixer-2: roadmap seq < 48; capacity-ux: the fixture leaves RM-21 out) and assert today's
  answer for docs-fixer-2 too.
- No lane in state/norn or state/solve-shack derives to "no recorded driver" today: every common shape (check-in lane linked by an item,
  owner `lane new --task` with a scoped DIR, a brief naming RM-n) resolves without new records.
- `isMergeStage` treats only `MERGE` as a merge: a re-staged `MERGE2` run and a deliverable `resolve` run are not merge runs to
  checkins.mjs. purpose.mjs skips them itself (its `landing` test); whether checkins should too is for the owner / lane norn-lifecycle.

## Session 2 (RUN-148): MAIL-29 - the lane's type, its output, a type filter
- `purpose.mjs laneType(name, { items, roadmap, briefTitle, commits })` -> `{ type, signal, now }`. The type is the CURRENT stage's (the
  newest non-landing run): capacity-ux reads design while it plans, build once S1 starts. Signal order, first answer wins (the chip's
  tooltip): (1) the run - a check-in; agent planner or stage plan/guide/design = design; stage red-main or a ci-fix* lane = CI fix;
  (2) words in the current brief's heading (bugs/broken/regression = bug fix; refactor/tech debt/legacy; docs/documentation; audit/
  investigate); (3) the same words in the driving roadmap items' titles, then their theme's; (4) the conventional-commit types of the
  lane's branch tips (majority); (5) stage S<n>/build or agent implementer = build. Else `type: null` ("no type" chip, warn).
  A MERGE / MERGE2 / resolve run that is queued or running is `now` (a chip beside the type), never the type.
- `laneOutput(type, { deliverables, notes, repo })`: a deliverable row (or any non-design type) -> "code → PR to <owner/repo from the PR
  url, else the repo folder> · no PR yet | PR #n open | merged" (the PR link opens it); a design / audit lane with no deliverable ->
  "documents → <notes folder of its newest run, relative to the project root> (not in git; backed up only if the ledger is on)".
  Check-in / no type and no deliverable -> nothing.
- Server: PR state from `deliverablesOf(p)` (the cached child process; never git in a GET). Commit types: the deliverables rows now carry
  `subject` (the tip's subject, already in the one for-each-ref listing - zero extra git calls; DEC-88 keeps a cold scan at ONE git call,
  so a per-branch `git log` was not added). So the commit signal reads the tip commit of each of the lane's deliverable branches.
- Lanes page: a `.lane-kind` line under the lane id (type chip + MERGE chip + output words), then the objective (session 1). A type filter
  group beside Active / Done / Old / Archived: one type at a time (tap again = all), chips = the types of the rows the state chips leave,
  with counts; the URL keeps it as `&type=<type>`; a lane link (`L:<lane>`) clears it so the row shows.
- Real shapes (tests/purpose.test.mjs, real run lines added to tests/fixtures/purpose/norn): dwarves = design (RUN-67 agent planner),
  norn-bugs-1118 = bug fix (brief "bugs"), ci-fix4 = CI fix (RUN-46 red-main), lane-purpose = build (S1; with its feat commits: commits).
- Findings: the roadmap has no theme field - a theme is a `kind: theme` item; its titles ("A quiet, fast CI") would mislabel build lanes
  as CI fix, so CI fix comes only from the run (red-main / ci-fix lane), never from words. norn-lifecycle's brief names a "CI-fix lane"
  and stays build for the same reason.
- Tests (each alone, META_ROOT): purpose 11/11, lane-purpose-dash 4/4 (incl. the 390 px browser check with the type line + filter),
  dash-lanes 4/4, deliverables 17/17, deliverables-ui 4/4, dlv-landed 3/3, dash-async-census 3/3. Full suite: see below.

## Suite (session 2, one full run: `node engine/bin/ci-suite.mjs`, 176 files, ~44 min)
`0 listed red(s), 13 new, 0 leak(s), 0 hang(s)`. The reds, each checked alone:
- tests/lint.test.mjs: mine - the laneOutput test used a repo path under a user's home folder (a home path to the lint). Fixed (f0cf5a5); lint 2/2.
- tests/gen.test.mjs (7) and tests/policy-gen.test.mjs (3): `project.json: not found: <tmp>/state/kestrel/hx/dev/sdd-codex/...`.
  They fail in ANY checkout that lives under `state/<project>/wt/` (this lane worktree) and pass from a %TEMP% worktree of the same
  HEAD (gen 8/8, policy-gen 3/3) and on origin/main. Location-dependent, not this change. Finding: a lane worktree under state/ breaks
  the demo-sandbox tests (for the owner / lane norn-lifecycle).
- tests/probe.test.mjs (2): `PROBE FAILED fake` (exit 1). Fails the same on the lane's base (ab296e2) and on origin/main (44384db) when
  run from a worker shell; passes 5/5 with the worker's META_* variables unset (META_RESULT, META_RUN_ID, ...). Finding: the probe's
  child inherits the running worker's env - a test-isolation gap, not this change.

## DONE
RM-34 S1 items 1-4 (session 1) and MAIL-29 (type chip, output words, type filter) built, tested, committed and pushed on norn/lane-purpose.
