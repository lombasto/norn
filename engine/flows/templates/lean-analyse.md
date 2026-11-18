# task {{epic}} analyse - lean tests: {{scope}} (flow {{flow}}, step {{step}}; written by `norn flow start`)

You are the analyst of flow {{epic}} (project {{project}}; owner DIR-19 + DIR-47: never-failing and duplicate tests are MEASURED,
not judged). Norn: {{norn}}. Worktree {{worktree}}, branch {{branch}} (`git merge {{base}}` first). NOTES {{notes_dir}}/ANALYSE-NOTES.md
(durable); end with `norn done` (or `norn done --outcome stopped --why "<why>"` / `norn done --outcome handoff --handoff-file F`): your outcome. You change no code and no test.

1. Measure the base: `{{norn}} tests measure --project {{project}}` (per-test time + line coverage per test file), then
   `{{norn}} tests history --project {{project}}`.
2. Mutation evidence for the files in scope (outside the repo - the engine keeps no npm deps): a scratch copy with StrykerJS's
   command runner logging the failing tests per mutant; import each trial with `{{norn}} tests mutation --report R --kills K --tests a,b`.
3. `{{norn}} tests lean --project {{project}}`: the slowest list (with causes), never-failing and duplicate candidates. In NOTES,
   list the wave: ONLY tests the measures name (kills 0 or a kill set inside another test's), each with its evidence, plus any
   slow test whose time comes from setup the wave can share. Nothing else: the wave cuts what the numbers prove.
