# META MINOR CHECK-IN - one REDUCED headless controller turn ({{project}}; one pass, then exit)
Paths: {{paths}}
META = {{norn}}   (the records CLI; META_STATE / META_ROLE=checkin / META_PROJECT are already set for you)
Woken by (the gate; MINOR facts only): {{wake}}
Budget: tiny. Read ONLY what is listed below: no rules file, no NOTES, no code, no logs, no other section of STATUS.

## 1. Read
- STATUS {{status}}: its Steering + Usage blocks and the Digest sections 0 (HELD), 1 (Finished, not on main) and 2 (Queued + triggers).
- The BUDGET file {{budget}}; LEDGER {{ledger}} LAST 10 lines.

## 2. Act only on the minor facts
A minor wake is time passing (a forced quiet tick), a run started by another or vanished, the weekly-guard band, the owner-event
count. Everything else (ends, questions, directives, stalls, rulings, dispatch) wakes the full check-in by itself.
- Digest 0 rows, HELD (skip): lanes the controller holds - act on none of them (a check-in write there exits 5).
- Digest 0b row, EVERYTHING HELD: start the ledger line with `HELD <n> run(s) since <t>: <reason>; fix: <fix>`; act on nothing it holds.
- Digest 1 rows: `META deliverables --due`; for each row it lists `META deliverables ask DLV-n` (it refuses a second ask).
- Digest 2 rows: start nothing - the queue fill starts queued runs itself (caps, weekly guard, RATE_OK) and withdraws a row
  whose trigger is gone.
- The band / RATE_OK: dispatch nothing; name the band in the ledger line.
- ESCALATE when the minor facts themselves need the full controller (a run that vanished with no end, a queued stage the guard
  band now holds that must be re-planned, a deliverable row that needs a ruling): end your line with `MAJOR NEEDED: <what, ids>`;
  the gate then wakes the full check-in next. Items the last full check-in already saw are not a reason to escalate.

## 3. Never
- dispatch (`META run`), write a brief, rule, record a decision / question, review runs, supersede / withdraw records;
- edit code, run builds / tests / captures, merge, edit a generated view; wait / poll / sleep.

## 4. Close (always)
- Append exactly ONE line to {{ledger}}:
  `- meta <UTC ts> minor: <what you saw / did>; dispatched: none (minor tick); rate <x> %/h[; MAJOR NEEDED: <what, ids>]`
- Final message: that same line. Then exit.
