# Norn dashboard

Start: `norn dash` (serves http://127.0.0.1:8737 - machine.json `dash.port` / `dash.bind` - and opens the browser; `--port 0` picks a
random port, `--no-open` skips the browser, `--project <project.json>` limits it to named projects). Ctrl+C stops it. Node built-ins
only, bound to 127.0.0.1. Every POST needs the per-start token embedded in the page (a fresh random token each start).

## Where things are (stage NAV: 5 destinations, plain names, both looks)
The bar is **Talk · Lanes · Runs · Inbox · More** (`shell.mjs` `BAR`), the same on a desktop and a phone (at the bottom there),
as link nav (`<nav>` + `aria-current`). Lanes is the landing page. **More** is a menu, not a page: a popover on a desktop, a
bottom sheet on a phone (`MORE`): **Health** = Spend, Slop, Tests, Context; **History** = Records, Ledger, Docs; **Plan** =
Roadmap. Settings is no page of the bar or More: the cog at the top right of the header opens it over the page (`#setview`),
Close (Esc) puts the page back. When one of the More pages is open, More is marked current; a
Health page in a bad state puts a dot on More. Every page's label, tab id and URL are the same word (`?tab=runs` is Runs); an
unknown or retired id (`overview`, `work`, `health`, `history`, `home`) opens Lanes - there is no alias or redirect table.
The Inbox link carries the one needs-you count. A page with views (Slop, Context, Tests) shows its view switch on its own title
line, never as a row under the bar. One run URL: `?tab=runs&run=RUN-n` opens that run's feed; every Feed link goes there.
The status strip under the header (`renderStatus`, from `GET /api/strip`: the run records, never the run tree) shows running /
cap, usage vs the weekly guard and the hourly cap, the next check-in and the needs-you count; in the norn look as the three Norns.
The bar paints from the static page list before any fetch. Each page declares the stream keys it reads (`PAGE_KEYS`): a `pulse`
refreshes the strip only, a record refetches the open page only when the page reads that file.

## What you see (from records, runs, heartbeats and transcripts - never from an LLM; re-renders on change via `/api/stream`, no timer)
- Header: project switcher (one project or All projects); the worker pool, machine-wide (Claude workers in use of the cap, the
  other Claude Code sessions on this computer, the Codex sessions: `widgets.mjs` `poolLine`, `engine/lib/agentprocs.mjs`); the
  Check-ins box (status time in local time, check-ins on / paused, tick running, live; Pause / Resume, Run tick now); the cog
  (Settings, with Look and Theme inside). On a phone the pool and the Check-ins box sit behind More. Every time on the dashboard
  is the browser's local time (`cells.mjs` `fmtTime` / `fmtDate`). The tab title shows `(n)` when something needs you.
- Talk: the controller chat and the check-in thread.
- Inbox: open questions with their options as small cards (key, text, cost; the recommended one marked, with its why) and a
  free-text answer; answered-not-applied questions, parked lanes, unreviewed runs. Its text goes through the one prose renderer
  (`prose.mjs`, on the Docs markdown stack): ids, lanes, PRs and commits as chips, file paths shortened (full path in the title, a
  copy button, the Docs reader when it can show the file), measurements, before -> after pairs, ranges and >= <= != ~ as symbols; a long
  body is a 3-line preview + "more" on the phone. A repeat-detector card its directive already asks for reads "Asked as DIR-n".
- Plan (`norn plan`): up next (every queued run in start order, what it waits for, its time estimate and start), the chains
  of runs that wait for other runs, landing next (finished work heading to main, in merge order).
- Spend: one screen - the last 24 h, the window total, runs, the guard and the top 5 spenders; Details opens the drawer with every
  breakdown (by lane, lane and stage, agent CLI, day, kind of work, check-ins, tokens) and the forecast (from `norn plan`). The
  advice icon shows the open model-advice cards. With API billing, the last 24 h of spend against the daily cap.
- Roadmap (`norn road`): themes and items with a status derived from the linked lanes, runs and records (never typed); a tree
  or a board, filters, and the unplaced work that has no item yet.
- Lanes: the attention board (stage LANES), one list grouped by what the owner must do: Needs you (an Inbox row names the lane),
  Running, Stopped, Waiting, To land; Parked and Done today folded; Old and Archived as links with counts. The group buttons are the
  filter (`&show=`), a type filter beside them. A row: the state tile, name + type, the now line, progress and pace (the elapsed-vs-budget
  bar is a CSS animation, no timer), the run strip (the retired Map's lane band as beads: hand-offs joined, helpers, the open question),
  the PR track (done -> PR -> merged -> installed) and at most 3 actions. The chevron opens the lane in place (its flow of runs, the
  brief checklist, why slow, the goal and its links); Esc closes it. One strip legend under the list. Under 700 px a row is a card.
  A new project's first task and setup gaps on top.
- Runs: every running, queued and recent run as a tree (main session + subagents, Codex runs), tokens and context from the transcripts.
  Running first (newest start first), then queued, then ended (latest end first). Columns `ran` (start to end, or to now while it
  runs; `queued for` on a queued run) and `ended` (how long ago). Chips filter by state (running / queued / finished / failed),
  kind (worker / check-in / helper / talk) and project, a box by lane, and the window of ended runs (2 h / 12 h / 24 h / all today);
  the view lives in the URL (`&state=`, `&kind=`, `&proj=`, `&lane=`, `&window=`).
- Records: directives and decisions with their history; Add / Revoke directive, Overrule decision.
- Docs: the project's `docs` list rendered as markdown (docs.mjs + pinned vendor/ libs, contents sidebar, record-id chips).
  Ledger: the project ledger, one row per entry, newest first (`ledger.mjs` parses check-in / minor / auto / controller lines into a headline + labelled sub-lines, record ids link to where they live, headings / prose as markdown), search + kind filter, 100 lines then "Show older" (`/api/ledger?count=&offset=`). Settings: categories from the schema (policy.mjs `SECTIONS`) with left nav, search (`@modified`),
  per-row file tag (machine `local/budget.json` | project `project.json` `policy`), modified marker + reset; Review changes shows
  a diff, Save writes atomically and refuses a stale version (409).

## Words (UX review 4: one name per thing, one count per thing)
The dashboard says these words and only these; a count of the same thing comes from one function, so every place agrees.
- **Lane** (`L:<name>`): one line of work with its own branch and worktree (a LANE record). Not "thread", not "task".
- **Run** (`RUN-n`): one session of an agent on a lane, from start to end. The Runs page lists them; the Overview's "Running" counts
  runs in flight against the caps. **Worker** appears only in the cap names (`max_claude_workers`): the most runs at once.
- **Needs you**: an Inbox row that waits for you - an open question, a fixer result to apply, an approval card, a login or setup to do,
  a parked lane, an unreviewed run. Answered questions (waiting for the next check-in), model advice and an enforce card already
  asked for (its directive exists) are listed in the Inbox for information but are not counted. ONE count: `terms.mjs` `needsYou` - the Overview card, the Inbox head, the Inbox badge, the page
  title, the Home filter and the project picker all show it (`tests/dash-counts.test.mjs`). Pending chat approvals in the Home thread
  are counted beside it by name ("+ n to approve").
- **Finding**: one open problem a check reports (instruction files, memory, rules, docs, tests, models, code checks). The **Slop** page
  lists every open finding; "slop" names the page, never a count. A **new finding** is one at warn level (medium or high) first seen
  since the last baseline - the Slop count, SloppaChoppa's line and his badge all say "new finding". A code finding explains
  itself (RM-27): under its row, what was found, why the rule exists, what to do, and the waiver path (`norn rec add waiver`). The text
  is the rule's `explain` in `engine/lib/slop/rules/<id>.json`, the same text `norn slop check` prints; a rule without it does not load.
- **Hunk**: one proposed edit to one file, shown as a diff (a fixer result or an audit card). A finding can need several hunks; Apply
  counts hunks, the Slop counts count findings.
- **Directive / Decision / Question** (`DIR-n` / `DEC-n` / `Q-n`): the record kinds; the Records page lists the first two.

## Status colours (UX review 3)
ok = green, warn = amber, bad = red, run (in progress) = blue, accent = needs you (cyan; Norn look: teal / mint). The accent is never the
bad colour, so an error never reads as a highlight; every chip's text is WCAG AA on its background in both looks and grounds
(`tests/dash-colours.test.mjs`). The Norn look picks the nearest palette.hex entries (palette lock).

## Writes
Every button writes through the records library (`engine/lib/records.mjs`, rules in `engine/prompts/RECORDS.md`): answers,
directives, overrules and stops become events; the generated views are re-rendered. Talk to the controller (prompt
`engine/dash/ASK.md`): a reply line `DIRECTIVE: ...` becomes a directive record (via talk). Settings writes `local/budget.json`
and the project's `project.json` and regenerates the marked policy lines (`<!-- policy:<key> -->`) in `project.policy_targets`.

## API (GET, `?project=<name>`; overview / inbox / lanes / agents also take `all`)
`/api/overview`, `/api/inbox`, `/api/lanes`, `/api/agents` (`&window=2h|12h|24h|today`: ended runs kept; default 2h), `/api/records`, `/api/docs`, `/api/ledger`, `/api/settings`,
`/log?run=RUN-n` (last 200 lines of that run's log), `/api/feed?run=RUN-n` (SSE live feed of one run), `/api/stream` (SSE state stream: record appends, flag flips, heartbeat pulse, derived changes - the page re-renders from it).
`/api/timing`: the server's own timings - requests slower than 1 s and event-loop stalls over 250 ms (with the requests that ran in
the stall), the last 100 of each; also appended to `local/dash-timing-<port>.jsonl` (one file per port). Every answer carries `Server-Timing` (`app` = ms in
the server, `prime` = the snapshot read of a GET), shown in the browser's network panel.

## Look
Norn (default; `engine/dash/norn/`: pixel kit, 9-slice panels, palette lock to `palette.hex`, integer art scale, state tokens and art behind one asset map `norn/assets.mjs`, drop-in folder `norn/art/`) or classic: Settings > Look, `?look=classic`, remembered per browser.
Norn vocabulary (display only; tab ids, routes, record kinds, paths and the CLI are unchanged): the bar is the same plain bar as
classic (the Norn group frames left the bar in UX review 2); the title says Norn and the header shows the wordmark; empty lists show
the empty-state art. Both looks open the Overview with the strip of the three Norns (RM-18 S2), each part a link in its colour: Urd
(landed today, last landed) to History, Verdandi (running, parked) to Work, Skuld (open questions, queued, next check-in) to Inbox. The picked art is vendored in `norn/art/` (source + name map in
its README). The classic look keeps the plain "norn" title and no art.

## Tests
`node --test tests/dashboard.test.mjs tests/ui.test.mjs tests/dash-counts.test.mjs tests/dash-colours.test.mjs tests/norn-look.test.mjs tests/norn-vocab.test.mjs tests/lanes-page.test.mjs` (fixture server on a random port, temp state).
