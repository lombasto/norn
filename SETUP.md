# Setting up Norn

The one setup path for a human or a coding agent, on Windows, Linux or macOS. Every command below runs as written in
PowerShell and in sh, from the root of this clone. Each step says what you should see; anything else is a named failure that
tells you what to do. `tests/guide.test.mjs` walks this file verbatim on every OS.

Agents: follow the steps in order. Do not skip a check. Where a step says "ask the human", ask and wait for the answer.

## 0. What you get, and what it never does

You get a controller for YOUR repo: a scheduler tick runs a check-in agent every N minutes. The agent reads the project's
records, starts or resumes worker runs in git worktrees, and keeps the decision and question records. A local dashboard shows
it all.

Norn never installs software. When a prerequisite is missing, it prints the vendor's install command and stops. It never writes
into your repo's main tree (workers use worktrees on their own branches). It never stores API keys: a project names environment
variables only. The scheduler is the only thing it puts on your machine, and only when you run `norn sched install`.

## 1. Prerequisites and setup

You need node >= 22, git and the claude CLI, signed in to your Claude account. codex and gh are optional. Check node first:

<!-- guide:run expect=/v(2[2-9]|[3-9]\d)\./ -->
```
node --version
```

If that prints an error or a version below 22, install node with your OS's line (the vendor's own command; agents: only with
the human's consent), open a new terminal and check again. Setup below names the line for git and claude the same way.

| OS | Install node 22 |
|---|---|
| Windows | `winget install OpenJS.NodeJS.LTS` |
| macOS | `brew install node` |
| Linux | `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh \| bash`, then in a new terminal `nvm install 22` |

Sign in to claude once before your first real run: `claude auth login` (or start `claude` and follow its prompt). Until then
step 5's `doctor` prints `PROBLEM claude: not logged in`; the free rehearsal in step 6 does not need it.

Then run setup. It finds every prerequisite and writes `local/machine.json` (your machine's discovered values, never typed by
hand) and, when it has none yet, `local/budget.json` with the starter caps of the `try-it` profile: 1 Claude worker, no Codex,
weekly stop 50 %, rate cap 0.3 %/h (change them in the dashboard Settings; an existing budget.json is changed only when you name
`--profile` or `--cost`, and then a `.pre-profile` backup is kept). The weekly stop needs your weekly
usage: until Norn can estimate it (`norn calib --pct <N>` with the % from your claude.ai usage page, or Settings > Usage
calibration) it holds back hand-off auto-resumes and queued runs on the Claude account (it fails closed); a run you start by
hand still starts:

<!-- guide:run expect=/wrote .*machine\.json/ -->
```
node engine/bin/norn.mjs setup --non-interactive
```

If a prerequisite is missing, setup prints `error: <tool> not found` and, under it, `install: <command>   (<source page>)` for
your OS, then stops with nothing written. Agents: show the human that line, run it only if they agree, in their shell, then run
setup again. Setup also puts the `norn` launcher in `~/.local/bin`; it never points it at a linked git worktree unless you pass `--force`. Until that dir is on PATH, keep typing
`node engine/bin/norn.mjs`.

**Billing.** Tell Norn how your Claude account is paid for, so it applies the right usage guard. On a plan (`pro`, `max-5x`,
`max-20x`, `ultra`) the account has a weekly limit. The mode then also sets the worker cap, weekly stop and rate cap that fit the
plan, and the weekly stop needs the calibration above. On API billing (`api`, pay per token) there is no weekly limit, so the
weekly stop and the rate cap are off and no calibration is asked for. Set a daily cap in dollars instead: Norn starts no new
Claude work once the Claude runs of the last 24 hours cost that much (each run's cost as the Claude CLI reports it). Run
`norn billing` to see the mode in force, or set it with `norn billing max-20x` or `norn billing api --usd-per-day 50`. You can
also set it in the dashboard (Settings > Billing). Runs already queued pick up the change. With no mode set, Norn treats the
account as a plan.

## 2. Check the install

This runs a fresh copy end to end in a temp dir (records, a fake run with hand-off and auto-resume, the scheduler files, the
dashboard API). Nothing real starts. It takes 10 to 40 seconds:

<!-- guide:run expect=/SMOKE OK/ -->
```
node engine/bin/norn.mjs smoke
```

## 3. Ask the human, in this order

1. Which repo should Norn work on? Ask for the path to a git clone on this machine. It is written below as `<repo>`.
2. Which profile? It sets the starting limits and who does which work. It is the one money choice, so it is always the human's:
   it goes to `init` as `--profile`. `--cost cheap|balanced|quality` changes only the models and effort (cheap: Sonnet, one effort
   step lower; quality: Opus, one step higher).

   | Profile | Claude workers | Codex runs | Check-in | Weekly stop | Scheduler |
   |---|---|---|---|---|---|
   | `try-it` (default) | 1 | 0 | Sonnet, medium | 50 % | off: run `norn tick` by hand |
   | `solo` | 2 | 1 if Codex was found | Sonnet, medium, every 15 min | 80 % | on |
   | `heavy` | 3 | 5 if Codex was found | Opus, medium, every 15 min | 95 % | on |

3. Should Norn read the repo with an agent to draft its setup? `--read` is one read-only agent run on the human's account (at most
   15 minutes; the text of the files it reads goes to that model's provider, the same one their workers use). `--no-read` drafts
   from what git shows (free, nothing leaves the machine). Use `--read` only on a clear yes.
4. A few optional questions. For a new or nearly empty repo: what is the project for (`--answer "goal=..."`), what should exist in a
   month (`--answer "month=..."`) and the first small thing to do (`--answer "first=..."`). For a repo with history: which piece of
   work matters most now (`priority`) and anything a worker must never do in it (`never`). A blank answer is fine.
5. Should the scheduler be installed? It starts a headless agent on the human's account every 15 minutes. That spends their
   usage. Install it only on a clear yes (step 7).

Executors: setup listed what it found (claude always, codex only if found). Others (an API model, another agent CLI) are added by
hand later in the project's `project.json` `executors` (see `projects/example/project.json`). A key is always an environment
variable name, never the key itself.

## 4. Set up the project and review the draft

One command adds the repo and drafts its setup. With the answers from step 3:

<!-- guide:run expect=/^review: norn adopt show --project / -->
```
node engine/bin/norn.mjs init <repo> --non-interactive --profile try-it --no-read --answer "goal=A small command-line app" --answer "first=Add a usage section to the README"
```

`init` runs setup when this machine has none yet, then `project new` (unless the repo is a project already). `project new` detects
the name (from the folder), the GitHub repo and branch (from `origin`) and the executors. It writes the project's config to
`~/.norn/projects/<name>/project.json` (outside this clone, so a re-clone keeps it) and registers it. `init --name <n>` names it;
for the other answers (`--title`, `--branch`, `--ci owner/repo` or `--ci none`, `--executors <names>` from `norn executors --caps`, `--dir <folder>`)
run `node engine/bin/norn.mjs project new --root <repo> --non-interactive` with them first, and `init` reuses that project.
The project's own files (rules, agents, skills) live next to its project.json and are referenced as `${project_dir}/...`.

Then `init` looks at the repo through git (tracked files only; it never writes into your repo) and drafts six parts: the caps
profile, the test / lint / build commands, project rules, the agent instructions, a roadmap and a first task. Every line names its
source (`file:line` or "your answer"). Nothing is applied until the human approves it. In a terminal, a human can simply run
`node engine/bin/norn.mjs init <repo>`: it asks these questions one at a time and walks each part.

Show the draft to the human. `<project>` is the project.json path `init` printed:

<!-- guide:run expect=/^to review: commands, rules, instructions, roadmap, first/ -->
```
node engine/bin/norn.mjs adopt show --project <project>
```

The profile is approved already: the human named it. For each other part ask the human: approve it, approve it with some lines
off (`--off <id,id>`), or skip it. The first task is a pick of one line (`--pick <id>`). Agents: record what the human said with
`--as owner`; never decide a part for them. Here: the roadmap, the rules and the first task are approved, the agent instructions
are skipped (writing an AGENTS.md is offered as a task instead), and so is the empty commands part (no test command was found):

<!-- guide:run expect=/^ADP-1 first: approved$/ -->
```
node engine/bin/norn.mjs adopt approve roadmap --project <project> --as owner
node engine/bin/norn.mjs adopt approve rules --project <project> --as owner
node engine/bin/norn.mjs adopt skip instructions --project <project> --as owner
node engine/bin/norn.mjs adopt skip commands --project <project> --as owner
node engine/bin/norn.mjs adopt approve first --pick f1 --project <project> --as owner
```

Apply writes only what was approved: roadmap records, `rules/RULES.md` next to project.json (every worker reads it), the merge
gate command, the caps of the profile (the scheduler is never installed by it) and the first lane. `--dry-run` lists every write
first:

<!-- guide:run expect=/^ADP-1 applied$/ -->
```
node engine/bin/norn.mjs adopt apply --project <project> --as owner
```

The dashboard shows the same draft (Overview: "Review the draft setup") with a tick box per line, and a chat in Claude Code or
Codex can walk it through `norn mcp --profile setup`. A part left for later stays in the draft; `norn adopt <repo>` resumes it.

## 5. Check everything

<!-- guide:run expect=/doctor: ok/ -->
```
node engine/bin/norn.mjs doctor
```

`doctor: ok` is the goal. A `PROBLEM` line says what is wrong and, for a missing tool, how to install it. A `note` (a missing
optional tool) is fine.

## 6. Your first task

Work enters Norn as a task for a lane. A lane is one line of work with its own git worktree and branch (`norn/<lane>`), so it
never touches your main tree. Apply opened the lane of the first task: its worktree, the task as your directive (`DIR-1`) and its
first brief (`<brief>` below: `.../briefs/<lane>.md`, edit it if you like). The lane is named after the task: `<lane>` below is
`add-a-usage-section-to-the-readme`.

Rehearse the run with the fake executor first. It spends nothing and only writes the lane's notes; `--wait` blocks until it ends:

<!-- guide:run expect=/^RUN-1 exited: DONE$/ -->
```
node engine/bin/norn.mjs run --executor fake --lane <lane> --brief <brief> --project <project> --wait
```

The real run starts a headless agent on the human's account (agents: ask first). Without the scheduler, start it by hand:

<!-- guide:skip reason=starts a real agent on the human's account -->
```
node engine/bin/norn.mjs run --executor claude --lane <lane> --brief <brief> --project <project>
```

More tasks: `node engine/bin/norn.mjs lane new docs --task "..." --project <project>` opens another lane (here `docs`) the same way.
`norn run` on a lane whose worktree does not exist stops with one line naming the `norn lane new` command to run.

## 7. The scheduler (only on a yes from step 3)

<!-- guide:skip reason=installs an OS scheduled task / timer / cron line on the real machine -->
```
node engine/bin/norn.mjs sched install
```

It refuses while a cap in `local/budget.json` is unset (one line says how to set them). `node engine/bin/norn.mjs sched show`
prints the files it would install and `installed: yes|no`. `sched remove` takes it out
again.

## 8. The dashboard

<!-- guide:skip reason=serves until stopped and opens a browser -->
```
node engine/bin/norn.mjs dash
```

It serves on http://127.0.0.1:8737 (`dash.port` in machine.json; `--port 0` picks a free port) and opens your browser when started
from a terminal; from a script it prints the URL only (`--open` / `--no-open` decide). It runs in that terminal until you stop it.
To keep it running without a window, start it with `node engine/bin/norn.mjs dash --background`. That starts the dashboard
detached and hidden, or reports the one already running. `norn dash restart` restarts it the same way.

### Get a ping when Norn needs you

Ask the human: "Get a ping on your phone or desktop when Norn needs you (a question for you, work finished, CI red on main)?"
Without it, questions can sit unseen for hours. Interactive `setup` asks this itself; scripted:

<!-- guide:skip reason=sends a real test ping to ntfy.sh -->
```
node engine/bin/norn.mjs setup --non-interactive --notify ntfy
```

`ntfy` (recommended): the free, open-source ntfy phone app, no account. Setup makes a private topic, prints its subscribe link
(open it on the phone, or tap + in the app and enter the topic) and sends a test ping. `--ntfy-server <url>` uses your own ntfy
server. `--notify toast` = a desktop notification on this computer, nothing to install. `--notify none` = not now; doctor and
the dashboard Settings (Notifications, with a "Send a test" button) say how to turn it on later.

### Reach Norn from your phone

Optional. Ask the human first, because it changes their network setup. The dashboard keeps listening on 127.0.0.1. A private
network that the human runs carries it to their own devices, and Norn never installs or starts one itself. A remote device sees
only a pairing page until it is paired with a single-use code from the desktop (Settings > Notifications > Reach Norn from your
phone). Every write from it, approvals included, is stamped with that device.

1. **Tailscale Serve** (recommended): free Personal plan, about 10 minutes. Install Tailscale on the PC and the phone and sign in
   to both with the same account. Then:

<!-- guide:skip reason=needs Tailscale installed; prints the plan and changes nothing without --apply -->
```
node engine/bin/norn.mjs remote setup
```

   It checks for tailscale and prints each command with what it does. Nothing runs until the human adds `--apply`, which runs
   `tailscale serve --bg http://127.0.0.1:8737` (your tailnet only) and writes `dash.remote` in machine.json. Then run
   `norn dash restart`, pair the phone, and open `https://<pc>.<tailnet>.ts.net/` on it. `norn remote off --apply` undoes it.
   Never use `tailscale funnel`, which is the public internet: Norn refuses Funnel requests.
2. **Cloudflare Tunnel + Cloudflare Access**: free plans, about 30-45 minutes, and it needs a domain on Cloudflare. It works in
   any phone browser without a VPN app, but the hostname is public (guarded by Access) and Cloudflare sees the traffic. Run
   `cloudflared` to `http://127.0.0.1:8737`, put an Access policy for the human's e-mail on the whole hostname, then set
   `"remote": { "enabled": true, "trust": "cloudflare-access", "hosts": ["norn.example.com"], "logins": ["you@example.com"] }`
   under `dash` in local/machine.json and run `norn dash restart`. Norn checks the e-mail header that Access sets, but it does
   not verify Access's signed token, so the Access policy must cover the whole hostname. The device pairing is the second lock.

`norn doctor` shows whether remote access is on, its host, logins and paired devices. ntfy notices then carry an "Open Norn"
link to the remote address.

## 9. More projects

<!-- guide:run expect=/^<name> .* root ok / -->
```
node engine/bin/norn.mjs project list
```

<!-- guide:run expect=/project <name>: would be removed/ -->
```
node engine/bin/norn.mjs project remove <name> --dry-run
```

`init <repo>` (or `project new`) adds another project. `project remove <name>` refuses while one of its runs is running. It deletes the agent and
skill files it installed, but keeps any you edited (and says so), and unregisters the project. It removes the scheduler only
with the last project. It keeps the project's state unless you pass `--purge-state`, and it never deletes your project.json.

### A monorepo: one project per folder

When one repo holds several separate things, make each folder its own project. Give `init` (or `project new --root`) the folder,
not the repo: `node engine/bin/norn.mjs init <repo>/<folder>`. `project new --root <repo> --subdir <folder>` does the same. The
project.json then has `root` = the repo's top level and `subdir` = the folder, and the project is named after the folder. Each
project has its own rules, roadmap, merge gate, lanes and check-ins, and several can share one repo:

- The adopt scan and read look only at the folder's files and commits. Its README, CLAUDE.md and manifests count as the
  project's own, and every source stays repo-relative (`<folder>/README.md:3`). The draft's first rule keeps workers in the folder.
- The merge gate runs from the folder, so `merge.gate.cmd` is written as it runs there. Set `merge.gate.dir` to run it from
  another folder, or `""` for the top level.
- A run whose brief has no `Scope:` line may change files only under the folder. The scope guard is on for such a project
  unless `policy.dod.scope` is `off`.
- Lanes branch as `norn/<project>/<lane>`, and the merge queue keeps its own scratch worktree (`<repo>-mq-<project>`), so two
  projects on one repo never share a branch or a scratch worktree.

Workers still get a worktree of the whole repo, and Claude Code still loads the top-level CLAUDE.md as well as the folder's.

### Two or more machines on one project

To let a second machine build the same project without duplicate work, set up multi-home sync: the first machine cuts as the bare
home (`norn sync cut --bare`), each other machine joins with `norn sync join --home <id> --ledger <remote>`. The ledger repo must
be private. [docs/MULTI-HOME.md](docs/MULTI-HOME.md) walks it end to end.

## 10. Never

- Run an install command without the human's consent.
- Hand-edit the records (`norn rec` is the interface) or the generated views (OWNER-QUESTIONS.md, DECISIONS-LOG.md,
  DIRECTIVES.md).
- Put a project.json inside this clone (`project new` refuses; `local/` is the exception).
- Store a key in project.json. Use an environment variable NAME.
- Use `--purge-state` without asking.
- Start a browser by hand for a screenshot (a fresh Edge profile can sign itself into the human's account). Use `norn shot`.
- Edit an installed agent or skill file in the Claude config dir. Edit its source next to the project.json, then run
  `norn gen`.

## Beta feedback

Norn is in beta. When the human is done (or stuck), point them at this repository's **Issues** tab: **New issue**, then
**Beta feedback** (what they tried, what went wrong or felt confusing, their OS, keep SloppaChoppa or not, and why). If
SloppaChoppa bothers them, Settings, Guard voice, SloppaChoppa: off turns him off for that project.
