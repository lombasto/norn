# Environment switches

The one table of the environment variables Norn's engine reads (you set none of them for normal use). A new switch is named `NORN_*` and gets a row in this table (engine/lib/slop/env.md) in the
same change: the slop rule K21 holds a branch that reads a new name without both. The `META_*` names predate the rename to
Norn; renaming them is its own change (every caller, test and doc at once).

| Name | Read by | What it does |
|---|---|---|
| `META_ROOT` | `engine/lib/config.mjs` | Norn's root folder (state, tool cache, machine file); default: the folder above `engine/`. Tests point it at an empty folder |
| `META_STATE` | `engine/bin/norn.mjs` | the state folder a command uses when no `--state` / `--project` is given |
| `META_PROJECT` | `engine/bin/norn.mjs` | the project a command uses when no `--project` is given |
| `META_RUN_ID` | runs, the fake executor | the id of the run a process belongs to (set by the supervisor) |
| `META_RUN_STATE` | `engine/bin/norn.mjs` | the state folder of that run (set by the supervisor) |
| `META_ROLE` | `engine/bin/norn.mjs` | the role a run acts as (`--as` wins) |
| `META_PARENT_RUN` | `engine/lib/delegate.mjs` | set in a helper run: helpers do not delegate again |
| `META_SESSION_ID` | the fake executor | the session id of a run (tests) |
| `META_RESULT_DIR` | the fake executor | where a run writes its result file |
| `META_JOB` | runs, the merge queue | set inside a run's job object: a child that must outlive the run breaks away |
| `META_HB_MS` | `engine/bin/norn.mjs` | the supervisor heartbeat in ms (tests) |
| `META_NO_TICK` | `engine/bin/norn.mjs` | no tick and no overlap check when a run ends (tests) |
| `META_INTERACTIVE` | setup | `1`: treat stdin as a terminal (guided setup without a TTY) |
| `META_TAILSCALE` | `engine/lib/remote.mjs` | the path of the tailscale binary |
| `META_FILL_SAMPLE` | `engine/lib/runs.mjs` | a pinned resource sample for the fill gate (tests) |
| `META_TEST_PROBE_DELAY_MS` | `engine/lib/supervisor.mjs` | a slow probe, in ms (tests) |
