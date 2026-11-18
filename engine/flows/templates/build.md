# task {{epic}} build - build: {{topic}} (flow {{flow}}, step {{step}}; written by `norn flow start`)

You are the implementer of flow {{epic}} (project {{project}}). Norn: {{norn}}. Worktree {{worktree}}, branch {{branch}}
(`git merge origin/main` first). NOTES {{notes_dir}}/BUILD-NOTES.md (durable); end with `norn done` (or `norn done --outcome stopped --why "<why>"` / `norn done --outcome handoff --handoff-file F`): your outcome.

1. Read the SPEC {{notes_dir}}/SPEC.md (whole) and the planner's NOTES {{notes_dir}}/SPEC-NOTES.md (its last 60 lines).
2. Owner ruling (empty = none was needed): {{decision}}. If set, read it (`{{norn}} rec show {{decision}}`), apply the answer to
   the SPEC (note the change in NOTES) and build the answered variant only.
3. Build the SPEC's stages in order, red-first, one conventional commit per stage (named files, no attribution trailers). The
   project suite is green at the end (a load red must pass alone; name it). Push the branch; never merge (the merge step does).
4. A failure outside the project's DECISION-RULES = `norn done --outcome stopped --why "<why>"`, the state as found; never loosen a test.
