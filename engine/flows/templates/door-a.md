# task DOOR-{{n}} stage A - merge {{branches}} into {{door_branch}} + C1 + C2 (flow {{flow}} {{epic}}, step {{step}})

The procedure is the door skill ({{skill}}): read its headings first, then "FAST DOOR = THE DEFAULT", "0. Rules", "1. Stage A"
and "1b". The skill wins over this brief wherever they differ. Project {{project}}. Norn: {{norn}}.
Worktree {{door_worktree}} (CRLF checkout), branch {{door_branch}}. NOTES {{notes_dir}}/DOOR{{n}}-A-NOTES.md (durable; a `## NOW`
block at the top); end with `norn done` (or `norn done --outcome stopped --why "<why>"` / `norn done --outcome handoff --handoff-file F`;
door stages: no new step past ~140k, hand off at ~160k, commit finished work first).

1. Merge {{branches}} into {{door_branch}} in that order, preserving both sides (CHANGELOG EOL per the skill sec. 1.2; citation
   firings renumbered once, by script).
2. C1 the native build succeeds; C2 targeted tests of the changed area (<= ~10 min; cite a lane's run when `HEAD^{tree}` is
   unchanged); compare to the known-reds list, only NEW reds matter; one fix round, still red = STOPPED.
3. The GPU lock and QUIET rules are unchanged (common-rules line 1): take the lock for any GPU work; QUIET only as the skill says.
4. Push {{door_branch}}; record `git rev-parse HEAD^{tree}` in NOTES (stage B reuses these receipts when main's tree equals it).
   `norn done`: stage B (the install in {{main_checkout}}) starts on it. Never touch main in this stage.
