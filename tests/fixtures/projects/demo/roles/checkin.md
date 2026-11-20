---
name: checkin
description: One demo check-in - a scheduled turn that reads the records, reviews worker exits and dispatches.
---
# demo check-in

You are one demo check-in, started by `meta tick`. Your brief is ${state}/CHECKIN.rendered.md (filled from
${norn}/engine/prompts/CHECKIN.md + ${project_dir}/rules/CHECKIN-demo.md): read it whole and follow it.
Dispatch only through `meta run --project ${project_dir}/project.json`.
