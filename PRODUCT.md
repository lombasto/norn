# Product

<!-- impeccable:product-schema 1 -->

<!-- Written by `impeccable init` in a headless run: no interview was possible, so every fact below comes from the repository
     (README.md, engine/dash/README.md, the dashboard code) or from the owner's written brief for the dashboard redesign.
     Facts taken from the brief and not yet confirmed in an interview are marked "(brief)". Examples are synthetic. -->

## Platform

web

## Users

- **The owner.** One person runs Norn for their own projects. Norn runs many agent lanes at once (Claude Code, Codex or any
  command-line agent), usually across one to three projects. They are the only user of the dashboard. There are no teams,
  roles or accounts.
- **Where they are.** At a desk with a wide screen for long stretches, and often on a phone away from the desk (brief). On the
  phone they check whether work is moving and answer what Norn cannot decide. At the desk they also read run feeds and steer.
- **What they actually use.** Nearly all their time goes to the Lanes and Runs pages (brief, owner 2026-11-20). They also
  answer questions in the Inbox and talk to the controller on the Controller page. The other pages are visited rarely or not yet trusted
  (brief).

## Product Purpose

Norn runs coding agents on the owner's machine and keeps long work going while the owner is away. Each agent hands off to a
fresh session at a set context size. Check-ins and a controller pick the next step. The owner answers only the questions Norn
cannot decide. Norn also guards the project against drift, bloat and slop.

The dashboard is the window onto that machine and its steering wheel. Success means three things:
- The owner sees in a few seconds what is running, what is stuck and what needs them.
- They answer a question or stop a run in one or two taps, on a phone as well as at a desk.
- They never have to open a terminal or a log file to find out what happened.

## Positioning

- **Facts, not a model's opinion.** Everything the dashboard shows comes from records, run events, heartbeats and
  transcripts on the owner's own disk. No model writes or summarises it. A page shows what the records can prove and says
  "unknown" when they can't.
- **Every button writes a record.** Answers, directives, overrules, stops and archives all go through the same records library
  the agents use. The dashboard has no private state of its own.
- **Local and private.** The server listens only on 127.0.0.1, uses Node built-ins only, and needs a fresh token for every
  write.

## Operating Context

- **Live without polling.** One server-sent state stream drives the page. It re-renders when a record, flag or run changes,
  and never on a timer. While the machine is under a quiet hold, motion stops and one static frame is drawn per change.
- **Projects.** The header switches between one project and "All projects". Some pages only make sense for one project
  (records, docs, settings).
- **Sharing links.** The owner shares and reloads deep links (`?project=<name>&tab=<page>&...`). A link should land on the same
  view after any redesign (brief).
- **A second setup edits the dashboard too.** Another Norn setup also changes `engine/dash/`. Structural changes are
  coordinated through the repository's issue tracker (brief).
- **Words.** The dashboard uses one name per thing:
  - **Lane**: one line of work with its own branch and worktree.
  - **Run**: one agent session on a lane.
  - **Needs you**: an item waiting for the owner. There is one count, and every place shows the same number.
  - **Finding**: one open problem a check reports.
  - **Hunk**: one proposed edit to one file.
  - **Directive / Decision / Question**: the record kinds.

## Capabilities and Constraints

What the owner can do today:
- **Watch lanes.** See every lane's state, latest run, progress and type. Filter them, archive or unarchive, pause or stop.
- **Watch runs.** See every running, queued and recent run as a tree with subagents, with tokens, context size, time run and
  time since it ended. Open a run's live feed.
- **Answer the Inbox.** Pick an option on a question (each has a cost and a recommended option), apply a fixer's result, or
  approve a card.
- **Steer.** Talk to the controller, add or revoke a directive, overrule a decision, pause or resume check-ins, run a tick.
- **Check health.** See usage against the weekly guard and the hourly cap, open findings (Slop), test cost and context cost.
- **Read history.** Records, the ledger, the project's docs.
- **Change settings.** Edit machine and project policy, see what changed before saving, and get a refusal if someone else
  saved first.

Constraints:
- **No dependencies.** Vanilla ES modules in the browser and Node built-ins on the server. No framework and no build step.
  The pure renderers also run under `node --test`.
- **Phone width.** Every page works at 390 px wide with no sideways scrolling. Tests check this.
- **Two looks.** Both looks (norn and classic) keep working, in both light and dark.
- **Status icons.** They are universal shapes, and each one must pass a blind-label test.

Open product facts (undecided, do not invent):
- Whether Roadmap, Plan and the health pages earn a place in the main navigation, or live one level down (brief: "can be
  combined").
- Whether the Map view's ambient art (the Well) is kept anywhere once the Map page goes (brief: "pure fluff").

## Brand Commitments

- **The name is Norn.** The three Norns carry meaning across the dashboard: Urd is what was (history, landed), Verdandi is what
  is (running, parked), Skuld is what shall be (questions, queued, next check-in).
- **Two looks are binding.** "norn" is the default: a pixel kit locked to one 32-colour palette, a pixel wordmark and state
  tokens. "classic" is a plain system-UI look. A look is chosen per browser.
- **The theme lives in the frame and style only** (brief). Structure, words, ids and URLs are the same in both looks.
- **SloppaChoppa** is an orc character who presents the code findings. The owner can switch him off per project.
- **Voice.** Plain, short words. A status always carries its word as well as its colour. Times carry their units and their zone.

## Evidence on Hand

- The art the owner picked is in `engine/dash/norn/art/`: logo, favicons, wordmark, 7 state tokens, 4 empty states and the
  SloppaChoppa strips. The palette is `engine/dash/norn/palette.hex`.
- README screenshots are in `docs/img/`.
- There are no testimonials, user counts or benchmarks. Do not invent them.
- The repository is public. Examples in committed docs must be synthetic: no real project names, lane names, paths, people
  or state.

## Product Principles

1. **Lanes and Runs are the product.** Every other page supports watching and steering lanes and runs, or it moves out of the
   way (brief).
2. **The owner's attention is the scarce resource.** "Needs you" comes first and stays one tap away on every page and at
   every width.
3. **Show the truth or say "unknown".** Never guess, never pad, never use a model to describe state.
4. **Calm while live.** Change on events, never on a timer. No motion without a reason, and none under a quiet hold or
   reduced motion.
5. **A phone is a full client.** Anything the owner does at the desk, they can do at 390 px.

## Accessibility & Inclusion

- Every chip's text meets WCAG AA contrast on its background, in both looks and both grounds. Tests check this.
- Status is never colour alone: each state is a shape plus a word.
- No sideways scrolling at 390 px. Touch targets are at least 44 px on a phone.
- Motion respects `prefers-reduced-motion` and the quiet hold.
