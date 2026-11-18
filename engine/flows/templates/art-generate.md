# task {{epic}} generate - {{count}} candidates: {{subject}} (flow {{flow}}, step {{step}}; written by `norn flow start`)

You generate one art round for project {{project}}. Norn: {{norn}}. Worktree {{worktree}} (scratch only; nothing is committed
in this step). NOTES {{out_dir}}/GENERATE-NOTES.md (durable); end with `norn done` (or `norn done --outcome stopped --why "<why>"` / `norn done --outcome handoff --handoff-file F`): your outcome.
References (empty = none): {{refs}}.

1. Generate {{count}} distinct candidates for: {{subject}}. Write them to {{out_dir}}/candidates/ as c1..c{{count}}, each with
   its recipe (prompt / parameters / seed) beside it so the pick can be rebuilt exactly.
2. Offscreen captures only (the project's GPU lock and QUIET rules apply unchanged); one contact sheet {{out_dir}}/sheet.png with
   every candidate labelled.
3. NOTES: the candidate list (one line each: what it tries), the sheet path, and end with `norn done`.
