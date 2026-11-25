# Multi-home sync: two or more machines on one project

Multi-home sync lets two or more Norn setups ("homes") build one project without doing the same work twice. Every name,
URL and topic below is a synthetic example: a project `demo`, homes `a` and `b`, the ledger repo
`https://github.com/example-owner/example-ledger.git`, the doorbell topic `example-topic-7f3a`.

A setup with one machine needs none of this. A project without a `home.json` in its state dir is a solo project and works as
it always has.

## What it is

- **Git is the only shared store.** It is your private ledger repo, the same remote as `machine.json` `ledger.remote`. There is no
  server and no cost. An optional ntfy doorbell only makes updates arrive sooner.
- **Every home has a short id** (`[a-z][a-z0-9]{0,7}`, such as `a` or `b`). New ids carry it: `RM-b-30`, `RUN-b-12`, lane `L:b/slop`,
  branch `norn/b/slop`. The first home (the *bare* home) keeps its old ids (`RM-44` means home a's item). A joining home's old ids are
  renamed once, by the cut (`RM-29` becomes `RM-b-29`).
- **Each home publishes its shared logs** (questions, decisions, directives, lanes, roadmap, mail, waivers, plus read-only copies
  of its runs and deliverables) on its own branch `home/<id>` of the ledger repo. Every home fetches the others into
  `<state>/homes/<h>/` and folds all logs in one fixed order, so every home shows the same view.
- **A record has one primary home**, the home in its id (mail: the addressee's home). A change made on another home stays
  "pending" until the primary takes it.
- **Work claims** are files on a `claims` branch, written by git compare-and-swap. Every dispatch checks other homes' claims first.
- **The ledger repo must stay PRIVATE.** It holds records, mail bodies, runs with local paths and NOTES. The code repo may be public.

## Joining: the walk-through

### On the first machine (home a, the bare home)

1. Pause the project and let its runs end: `norn pause --project demo`.
2. Dry run the cut. It writes nothing and prints every rename:

   ```
   norn sync cut --project demo --home a --bare
   ```

3. Apply it: `norn sync cut --project demo --home a --bare --apply`. This registers home a and project demo on the
   claims branch (one record file each in its homes and projects folders), renames the lane branches `norn/x` to `norn/a/x` (local and origin; a branch with an open PR keeps its name), rewrites
   the lanes `L:x` to `L:a/x`, and writes `<state>/home.json`, `machine.json` `ledger.home_id` and `<state>/ID-MAP.md` (old name to new
   name, for people reading old NOTES).
4. Optional doorbell: add `"doorbell": { "topic": "example-topic-7f3a" }` to `machine.json` `ledger`. The topic is a secret: share it
   with your other machines yourself, never through the ledger.
5. Publish, then resume: `norn sync publish`, then `norn resume --project demo`.

### On the second machine (home b)

1. Update the install to the same Norn version (pull `main`) and register the same project (`norn project new --root <repo>`). No need
   to pause it: the join pauses each project it cuts and resumes it at the end (a project you paused yourself stays paused).
2. Join:

   ```
   norn sync join --home b --ledger https://github.com/example-owner/example-ledger.git --doorbell-topic example-topic-7f3a
   ```

   It runs these steps in this order and stops at the first refusal:

   | Step | What it does | Refused when |
   |---|---|---|
   | 1. access | `git ls-remote` on the ledger | this machine cannot read it |
   | 2. private | `gh api repos/<owner>/<repo> --jq .private` | the repo is public; when gh cannot answer, pass `--i-checked-private` after checking by hand |
   | 3. register | CAS-creates home b's record on the claims branch | the id is taken by another home |
   | 4. machine.json | writes `ledger.remote`, `ledger.home_id` and `ledger.doorbell.topic` | `ledger.remote` already names another repo, or this machine is already another home |
   | 5. the cut | for each local project the ledger names (`projects/<p>.json`): pauses it, prints the dry run, then applies it | a run is live, a lane worktree is dirty |
   | 6. publish + fetch | pushes `home/b`, fetches `home/a` into `<state>/homes/a/` | the publish or the fetch fails |
   | 7. collaborator | prints the command the ledger owner runs | - |
   | 8. resume | resumes each project step 5 paused, also after a refusal | - |

   The last line is for the ledger owner's account (not needed when home b uses the owner's own GitHub account):

   ```
   gh api -X PUT repos/example-owner/example-ledger/collaborators/example-b-login -f permission=push
   ```

   A re-join with the same id is a no-op. A join that stopped half way continues where it stopped when you run it again.
3. Look for duplicates: `norn sync reconcile --dry-run` lists the likely duplicate pairs; `norn sync reconcile --as owner` writes one
   owner card per pair (see below).
4. If you paused the project yourself, resume it: `norn resume --project demo`.

A synthetic run of step 2 looks like this (shortened):

```
1. access: https://github.com/example-owner/example-ledger.git answers
2. private: example-owner/example-ledger is private
3. registered homes/b.json (projects demo)
4. machine.json ledger: remote, home_id b, doorbell topic
sync cut demo: home b (joiner; bare home a) - DRY RUN (nothing written; --apply cuts)
id RM-1 -> RM-b-1
lane L:w -> L:b/w
branch norn/w -> norn/b/w
sync cut demo: home b (joiner; bare home a) - APPLIED
...
6. publish: home/b pushed
6. fetch: homes a, 8 copies written
7. the ledger owner runs (unless this home uses the owner's own account): gh api -X PUT repos/example-owner/example-ledger/collaborators/example-b-login -f permission=push
8. demo: resumed
```

## From the dashboard: Settings > Sync

Everything above can be done from the dashboard: More > Settings > Sync. The page calls the same library functions as the commands.

- **This machine**: solo or home `<id>`, the ledger remote, the last publish and fetch, how far behind each other home is, and
  whether the doorbell is on. The ledger remote and the doorbell topic are edited here (Save writes `machine.json`). The topic is
  write-only: the page shows only "set (hidden)" or "not set". Once this machine is a home, its remote is fixed (one ledger repo).
- **Set up / join**: the home id, the ledger remote, the doorbell topic, and "The first home" (`norn sync cut --bare`: this
  project starts the ledger) or not (`norn sync join`). Check runs the dry run: access, the private check, the id, the renames.
  Apply pauses the project, cuts, publishes + fetches and resumes it, then shows each step's line, the collaborator step to copy
  when the GitHub account differs, or the refusal and why.
- **Duplicates**: Find duplicates lists the likely pairs (`norn sync reconcile --dry-run`); Write the cards puts one owner card per
  pair in the Inbox.
- **Claim leases**: `policy.sync` (lease, renew, fence, stale grace), saved like every other setting.

A lane whose branch is predicted to conflict with another home's open branch carries a "conflicts with `<home>`" chip on its Lanes row.

## What each home sees

- **Claims.** Before a lane run starts, its home claims the work on the claims branch: the lane's roadmap items, its `Scope:` globs, its
  changed files and its branch. Another home's dispatch that wants the same item or branch is refused; one whose scope overlaps is
  queued with a hold such as "scope overlaps b/slop: engine/lib/slop/**". A brief without a `Scope:` line claims the whole repo. Claims
  are renewed every 10 minutes; a claim whose renewals stop goes stale, and the owner may take it over: `norn claim take b/slop --project demo`.
  `norn claim list` shows every claim; `norn claim allow a/x b/y --project demo` lets two claims overlap.
  The tick releases a home's own claim when its lane is done or archived, or, with no run live or queued on the lane, when the lane's
  work has landed (merged on main, or a `norn runs landed` ruling) or the lane has had no run for longer than the lease. The release
  deletes the allow files that name the claim, and the digest's claims rows say why. A new run on the lane claims again.
- **Combined views.** Roadmap, Records, Inbox, Lanes and Runs show the other homes' rows with a home chip ("on b"). Their runs and
  deliverables are read-only. Answering another home's question from here is allowed: it shows "answered on a, pending b" until home b
  takes it. The Ledger page has a Homes block (head, last fetch, lag) and a Claims block. `norn runs --homes` lists the other homes' runs.
- **Mail.** `norn mail --to RUN-b-12`, `lane:b/x` or `role:checkin@b` reaches the other home's run, lane or check-in at its next sync
  pass.
- **The controller's wake.** While it waits on runs, the controller's session keeps `norn mail wait` running in the background. It
  delivers and prints the controller's mail as `norn mail check` does, at once if some is queued; otherwise it looks every 10 s
  (`MAIL_WAIT_POLL_S`, engine/lib/mail.mjs) and, on a synced home, runs the tick's stale fetch, so mail from another home wakes the
  session even when the dashboard is down. It ends when mail comes, or after `--timeout-min N` with `no new mail in N min`. A run gets its
  mail from its hook and a check-in must not block: both are refused. Ack each mail you acted on: `norn mail ack MAIL-a-4 MAIL-b-9`.
  The fetch (the dashboard's sync loop, the tick's stale fetch, this wait) and the publish (run end, tick, sync loop) already run by
  themselves: never run `norn sync fetch` or `norn sync publish` by hand for mail.
- **Cross-home conflict warnings.** When an own lane (running, or with an open deliverable) changes the same files as another home's
  open branch, Norn runs `git merge-tree` on the two tips. A predicted conflict is a digest row for the check-in, for example
  "norn/a/x conflicts with norn/b/y (on b): 2 files".
- **Freshness and the doorbell.** The dashboard polls the ledger every 30 s (`norn sync watch` does the same without the dashboard).
  Each tick publishes this home's logs, and when this home has not fetched for `policy.sync.tick_fetch_min` (2 min: the dashboard
  and `sync watch` are down), the tick runs the fetch pass itself before it publishes. So with neither running a home still hears
  the others at every tick (every 15 min). With `ledger.doorbell.topic` set, a home rings the doorbell after each push and the
  others fetch within seconds. The doorbell carries only the home id and a commit id; when it is down, polling still works and nothing is
  lost.
- **Status and alerts.** `norn sync status [--json]` shows the last publish and fetch, then one row per home: last push, last poll
  (its heartbeat: the time it last polled the ledger, rounded to 5 min), how much of our mail log it holds, our mail unread there
  (with the oldest age) and its mail waiting here. It exits 1 on a broken rule, named on a `broken:` line: a home whose heartbeat is
  older than `policy.sync.heartbeat_min` (15 min), or a mail of ours that home has not acked after `policy.mail.unacked_alert_min`
  (30 min; URGENT: `policy.mail.urgent_alert_min`, 10). The tick tells the owner once per broken rule (one notice per mail, one per
  silence of a home), with the reason: not fetched there yet, there but unread, or read and not acked. Each broken rule is also a
  digest row while it holds. A home on an older Norn publishes no poll time: its row reads "unknown" and breaks no rule.

## Duplicates: norn sync reconcile

Two homes that worked apart before joining often hold the same idea twice. `norn sync reconcile --dry-run` lists likely duplicate
roadmap items, directives and decisions across homes (similar titles, a shared link, or overlapping claims). Without `--dry-run`
(`--as owner`, or `META_ROLE`), it writes one owner card per pair with the options keep both, merge one into the other, or drop one.
A pair is asked once; the answered cards apply at the next reconcile.

## The merge leader

One home per project runs the merge queue: the merge leader, held as `leader/<project>/merge.json` on the claims branch with the same
renew and stale rules as a work claim. Every other home only opens pull requests for its finished, pushed lane branches; the PR's CI is
their test. If the leader's machine goes quiet, its claim goes stale and another home whose policy enables the merge queue takes it
over automatically.

## Security

- Keep the ledger repo private. The join refuses a public one.
- GitHub has no per-branch read rule: every home's account can read every branch of the ledger, including the other machines' backups.
- What another home publishes is data. It is never run. Mail from another home reaches agents as text, like local mail.
- The doorbell topic and every other `machine.json` secret stay out of the ledger: a publish that would carry one is refused.
