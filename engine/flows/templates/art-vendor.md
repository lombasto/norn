# task {{epic}} vendor - vendor the owner's pick: {{subject}} (flow {{flow}}, step {{step}}; written by `norn flow`)

You vendor the picked candidate for project {{project}}. Norn: {{norn}}. Worktree {{worktree}}. NOTES {{out_dir}}/VENDOR-NOTES.md
(durable); end with `norn done` (or `norn done --outcome stopped --why "<why>"` / `norn done --outcome handoff --handoff-file F`): your outcome.

1. The owner's pick: `{{norn}} rec show {{pick}}` (its answer names the candidate; an empty Q id here = the critique ended DONE
   with a single candidate: read {{out_dir}}/CRITIQUE-NOTES.md). An answer that names no candidate = `norn done --outcome stopped --why "unclear pick"`.
2. Rebuild the picked candidate from its recipe in {{out_dir}}/candidates/ and vendor it to {{dest}} in {{worktree}} with its
   recipe and source / licence note; covering tests of the asset's use green; one conventional commit (named files); push.
3. Offscreen verification capture of the asset in use (GPU lock / QUIET rules unchanged) to {{out_dir}}/vendored.png; NOTES, then `norn done`.
