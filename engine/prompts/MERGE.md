# task MERGE {{lane}} - merge {{branch}} into {{main}} in its own merge worktree (NORN-WATCH S2 MERGE stage; written by `norn merge-brief`)

You are the merge worker for lane {{lane}} of project {{project}}. The check-in never merges; you do, on evidence.
Branch {{branch}}, worktree {{worktree}}. YOUR merge worktree: {{merge_wt}} (detached at {{main}}; Norn made it for this run and
removes it when the run ends). Other merges run beside you in their own worktrees: never write in {{main_checkout}} (the owner's
checkout). {{main}} only takes a pull request the owner approves: `norn merge-land` opens it, you never merge or push {{main}}.
Norn: {{norn}}. NOTES {{notes}} (durable, outside every worktree); end with `{{norn}} done` (or `{{norn}} done --outcome stopped --why "<why>"` / `{{norn}} done --outcome handoff --handoff-file F`): your outcome.
Never force-push {{main}}, never push {{main}} by hand, never rewrite {{main}}, never loosen a test. A conflict you cannot resolve
with the lane's intent = STOPPED.

1. `git -C {{worktree}} fetch origin` and `git -C {{worktree}} rebase origin/{{main}}` (conflicts: resolve keeping both sides'
   intent; else STOPPED). Push the rebased branch (`git -C {{worktree}} push --force-with-lease origin {{branch}}` is the ONE
   allowed lease push: the lane's own feat/* branch, never {{main}}).
2. {{suite}}
3. {{shots}}
4. `git -C {{merge_wt}} fetch origin`, `git -C {{merge_wt}} checkout --quiet --detach origin/{{main}}`, then
   `git -C {{merge_wt}} merge --no-ff -m "merge: {{branch}} ({{lane}})" origin/{{branch}}`, then `{{norn}} smoke` in {{merge_wt}}.
   A conflict you cannot resolve = `git -C {{merge_wt}} merge --abort`, STOPPED; a red smoke =
   `{{norn}} done --outcome stopped --why "smoke red, no PR opened"` ({{main}} was never touched).
5. Green smoke: open the PR - `{{land}}`. It pushes nothing to {{main}}: it opens (or finds open) the pull request of the lane
   branch to {{main}} and records it on the deliverable.
   - exit 0 `PR OPENED <url>` / `PR ALREADY OPEN <url>` (one line per branch): done.
   - exit 3 `NOT OPENED <branch>: <why>`: `{{norn}} done --outcome stopped --why "<its words>"`.
   The owner approves and merges the PR; never merge or push {{main}} yourself.
6. Notify the owner (`{{norn}} notify --class merge --title "PR {{branch}}" --body "<PR url>, {{suite_ran}} + smoke green"`{{shot_flag}}).
   Write NOTES: the PR url, the tested merge sha, the merge-land line, {{suite_ran}} counts + named reds, smoke result, shots paths; end with `{{norn}} done`.
