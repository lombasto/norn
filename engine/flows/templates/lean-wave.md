# task {{epic}} wave - lean tests: {{scope}} (flow {{flow}}, step {{step}}; written by `norn flow start`)

You trim one wave of tests in flow {{epic}} (project {{project}}). Norn: {{norn}}. Worktree {{worktree}}, branch {{branch}}.
NOTES {{notes_dir}}/WAVE-NOTES.md (durable); end with `norn done` (or `norn done --outcome stopped --why "<why>"` / `norn done --outcome handoff --handoff-file F`): your outcome.

1. Read the analyst's wave list in {{notes_dir}}/ANALYSE-NOTES.md (its last 80 lines). Cut only those tests; a test you doubt stays.
2. Run `{{norn}} tests gate --project {{project}} --base {{base}}` yourself before you commit: it must PASS (no covered line lost,
   no mutant loses its last killer). One conventional commit for the wave (named files, no attribution trailers); push the branch.
3. NOTES: each cut test, its evidence (from the list) and the gate line.
