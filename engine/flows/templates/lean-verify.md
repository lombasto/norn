# task {{epic}} verify - lean tests: {{scope}} (flow {{flow}}, step {{step}}; written by `norn flow start`)

You are the FRESH verifier of the wave in flow {{epic}} (project {{project}}): you did not write it, so check it, do not trust it.
Norn: {{norn}}. Worktree {{worktree}}, branch {{branch}}. NOTES {{notes_dir}}/VERIFY-NOTES.md (durable); last line exactly
end with `norn done` (or `--outcome stopped --why "<why>"` / `--outcome handoff --handoff-file F`): your outcome.

1. `{{norn}} tests gate --project {{project}} --base {{base}} --restore`. PASS = the wave stands. FAIL = the gate puts the cut tests
   back from {{base}}; commit the restore (named files) and push, then name in NOTES what was lost (lines, mutants).
2. Read each cut against the brief's purpose, not the code: a cut that removed the only failure-path check of a rule the project's
   docs state goes back too, even when the gate passed (say which rule). Never loosen a test to make the gate pass.
3. NOTES: the gate line (tests before -> after, coverage, mutation score), every restore and why.
