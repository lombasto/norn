# task {{epic}} critique - judge the candidates and ask the owner to pick: {{subject}} (flow {{flow}}, step {{step}})

You critique one art round for project {{project}}. Norn: {{norn}}. NOTES {{out_dir}}/CRITIQUE-NOTES.md (durable); last line exactly
end with `norn done` (or `--outcome stopped --why "<why>"` / `--outcome handoff --handoff-file F`): your outcome. Read the generator's NOTES {{out_dir}}/GENERATE-NOTES.md and {{out_dir}}/sheet.png.
References (empty = none): {{refs}}.

1. Judge every candidate in {{out_dir}}/candidates/ against the subject and the references by eye: a written verdict per
   candidate (what works, what fails), then a shortlist of at most 4 with your recommendation.
2. The pick is the owner's (owner_only: no check-in or controller rules it). Raise it:
   `{{norn}} rec add question --owner-only --lane {{lane}} --title "art pick: {{subject}}" --option "c<n>|<one line>|-" ...
   --recommend "c<n>|<why>"`, send the sheet (`{{norn}} notify --title "art pick Q-n" --file {{out_dir}}/sheet.png`).
3. End `norn done --outcome stopped --why "owner pick Q-n"`. The controller runs `{{norn}} flow resume {{epic}} --var pick=Q-n`; the vendor step waits
   for the owner's answer. Never pick for the owner.
