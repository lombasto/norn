# task MERGE {{batch}} - open the PRs of the gated merge-queue batch to {{main}} ({{count}} branches; written by `norn mergeq`, META-GTP-MERGEQ)

You are the merge worker for merge-queue {{batch}} of project {{project}}. The check-in never merges; you do, on evidence.
{{suite}} the batch tip {{tip}} = {{main}} {{base_short}} + one `--no-ff` merge commit per branch below
(gate log {{gate_log}}; batch worktree {{scratch}}). YOUR merge worktree: {{merge_wt}} (Norn made it for this run and removes it
when the run ends). Other merges run beside you in their own worktrees: never write in {{main_checkout}} (the owner's checkout).
{{main}} only takes pull requests the owner approves: `norn merge-land` opens one per branch, you never merge or push {{main}}.
Norn: {{norn}}. NOTES {{notes}} (durable, outside every worktree); end with `{{norn}} done` (or `{{norn}} done --outcome stopped --why "<why>"` / `{{norn}} done --outcome handoff --handoff-file F`): your outcome.
STAGED: the PRs rest on exactly that tested tip. NEVER touch a lane worktree (no fetch, rebase, merge, checkout, commit or push there).
Never force-push, never push {{main}} by hand, never rewrite {{main}}, never loosen a test.

Branches (each its own merge commit in the tip and its own PR):
{{members}}

1. `git -C {{merge_wt}} fetch origin`, `git -C {{merge_wt}} checkout --quiet --detach {{tip}}`; then
   `git -C {{merge_wt}} merge-base --is-ancestor origin/{{main}} {{tip}}` must succeed. Else
   `{{norn}} done --outcome stopped --why "{{main}} moved since the batch was gated"` - no PR opened (`norn mergeq` rebuilds the batch on the new {{main}}).
2. {{shots}}
3. `{{norn}} smoke` in {{merge_wt}}. A red smoke = `{{norn}} done --outcome stopped --why "smoke red, no PR opened"` ({{main}} was never touched).
4. Green smoke: open the PR - `{{land}}`. It pushes nothing to {{main}}: it opens (or finds open) the pull request of each lane
   branch above to {{main}} and records it on the deliverable.
   - exit 0 `PR OPENED <url>` / `PR ALREADY OPEN <url>` (one line per branch): done.
   - exit 3 `NOT OPENED <branch>: <why>` (some branch has no PR; the others keep theirs): `{{norn}} done --outcome stopped --why "<its words>"`.
   The owner approves and merges the PR; never merge or push {{main}} yourself.
5. Notify the owner (`{{norn}} notify --class merge --title "PRs {{batch}}: {{count}} branches" --body "<one PR url per branch>, {{suite_ran}} + smoke green"`{{shot_flag}}).
   Write NOTES: the PR urls, the tested tip, the merge-land lines, the gate log, smoke result, shots paths; end with `{{norn}} done`.
