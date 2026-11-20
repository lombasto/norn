# task lane-purpose S1 (RM-34) - every lane shows its objective and where it is documented; the Runs page names each run's lane

You are a worker for lane lane-purpose of project norn. Read CLAUDE.md whole first (tests one file at a time with META_ROOT, never `node --test tests/`, no git stash, no compatibility shims, dashboard rules: 390 px no sideways scroll, no fifth subview, one name per page; small conventional commits).

## The owner's words (2026-11-18)
"in the lanes tab, i want every lane to be tied to a doc/roadmap item or whatever is actually driving that lane, what objective it is fulfilling and where that objective is documented. likewise for the runs tab, we have a column of 'session' where we just blab a bunch of stuff - i think another column like lane or something like that is warranted that makes the lane it is a part of more readable/obvious."

## Build
1. **A lane's driver**, derived from the records (no new hand-kept field where the records already know it), in this order: the roadmap item(s) its runs carry (`--item RM-n`, roadmap `links` lane:/run:/dlv:), the directive(s) that created or name it (DIR-n, incl. owner `lane new --task`), the open question / decision it serves, the brief it runs (first heading = the objective in one line), else "no recorded driver" shown as a finding (feeds lane norn-lifecycle's idle/orphan rules - do not duplicate them). Return `{ objective (one line), sources: [{kind: rm|dir|q|dec|brief|doc, id, title, href}] }` from one pure function in engine/lib (lanes.mjs or a small new module), unit-tested on real record shapes from state/norn and state/solve-shack fixtures (e.g. solve-shack run-efficiency: RM-33 + its brief; queue-watchdog: owner lane + its brief; docs-fixer-2: none -> finding; norn capacity-ux: brief only).
2. **Lanes page**: each row shows the objective line under the lane name and the sources as small links (RM item -> the roadmap item, DIR/Q/DEC -> the record, brief/doc -> the Docs viewer); the lane's detail shows them in full. Phone: objective line truncates with the full text on tap; links wrap.
3. **Runs page**: add a **Lane** column (lane name, linked to the lane row; stage beside it, e.g. "run-efficiency · MERGE") and shorten the Session column to what identifies the session (its short name/id), with the long text moved to the run's detail / title. Check-in runs show "check-in" in the Lane column. Keep the table within 390 px (columns that do not fit move into the row's second line on the phone).
4. If lane readable-text's shared renderer (RM-30) has landed on main when you start, render the objective with it; if not, plain text - do not wait for it.
Coordinate: lane capacity-ux designs the lane row's live state (workers, waiting reason); lane ui-audit will measure the pages later - keep the row's structure simple so both can build on it. Do not change lane states or archive rules (lane norn-lifecycle).
Tests: the driver function's unit tests above; dash fixture render tests for a lane row with an RM source, a DIR source, and none; the Runs table with the Lane column for a worker, a MERGE and a check-in run; a 390 px browser check on both pages (no sideways scroll); existing lanes/runs tests pass.
Run each touched test file alone with META_ROOT; then the full suite once (`node engine/bin/ci-suite.mjs`). Commit small, push the branch, `norn done`; the merge step opens the PR.
Stop rule: if a driver cannot be derived for a common lane shape without new records, say which and record it as a finding instead of guessing. Time budget 120 min; hand off at the policy's hand-off mark.
NOTES end marker: `## DONE` / `## STOPPED: <why>` / `## HANDOFF`.
Scope: engine/dash/**, engine/lib/**, tests/**
Tests: the touched tests/*.test.mjs, each alone; then node engine/bin/ci-suite.mjs
Done: ## DONE
