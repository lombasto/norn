# task DOOR-{{n}} stage B - install {{door_branch}} in main + C3 boot + C4 sheet (flow {{flow}} {{epic}}, step {{step}})

The procedure is the door skill ({{skill}}): read its headings first, then "FAST DOOR = THE DEFAULT", "0. Rules", "1b" and
"2. Stage B". The skill wins over this brief wherever they differ. Project {{project}}. Norn: {{norn}}.
Main checkout {{main_checkout}}. Stage A's NOTES: {{notes_dir}}/DOOR{{n}}-A-NOTES.md (its `## NOW` block and the tested tree).
NOTES {{notes_dir}}/DOOR{{n}}-B-NOTES.md (durable; a `## NOW` block at the top); end with `norn done` (or `norn done --outcome stopped --why "<why>"` /
`norn done --outcome handoff --handoff-file F`; door stages: no new step past ~140k, hand off at ~160k, commit finished work first).

1. DOWNTIME: tell the owner when the install starts and when the game is playable again; START / END in {{notes_dir}}/DOWNTIME.txt.
2. Merge {{door_branch}} into main `--no-ff`; reuse stage A's receipts when `main^{tree}` equals its tested tree. The ONE install
   sync, prebake, pins / CHANGELOG / docs counts by script only, exactly as the skill's sec. 2 says (never hand-edit a pin).
3. C3 cold boot of the default world (playable, stderr empty, HARD counters 0); C4 one judged look sheet (<= 8 stills) to {{notes_dir}}.
4. The GPU lock and QUIET rules are unchanged (common-rules line 1): the lock for every capture / boot, QUIET only as the skill says.
5. PLAYABLE.txt (launch line, fps, rollback recipe) in {{notes_dir}}; push main; worktree clean-up per sec. 2.8b; end with `norn done`.
