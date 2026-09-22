# WDT-11 recovery interrupted by ai-monitor

Task: `cmuax8g42v81vovule6nykn57`.

After the browser repair, the recovery turn entered execution. At 14:04:17
Brisbane on 22 September, the host monitor invoked `openclaw-control
restart-services asdrubal 'ai-monitor PM channel no-start'`. The gateway closed
the Codex app-server client before the turn completed; its incomplete-turn log
recorded ten tool actions. The original browser blocker therefore remained.
A subsequent WDT-11 retry waited for capacity behind a WDT-9 turn.

Both `auto_wake_stalled_agents` and `restart_and_wake_stalled_agents` previously
trusted incident categories from an earlier probe. Neither checked for execution
that began after that probe, including another task on the same gateway.

The shared preflight now reads the live PM DB immediately before intervention:

- Admitted/streaming execution and unexpired reserved/admitted/running leases
  protect the whole agent. Accepted turns retain grace; another accepted turn
  also protects the gateway.
- A channel incident needs its exact message/run, current task owner and status,
  stale activity, and no newer replacement. Settled runs and capacity waits
  cannot authorize restarts. Missing/unreadable evidence defers intervention.
- Both recovery tiers, including mixed PM/legacy queue buckets, use the guard.
  Deferred checks are recorded without advancing the recovery attempt ladder.
- The ordinary live-run probe recognizes `admitted` and `waiting_capacity`;
  confirmation recognizes fresh admission, but never counts capacity waiting
  as successful execution.

This is a fresh-state check, not an atomic lock across SQLite and systemd.
The PM execution watchdog owns expired execution/lease settlement. ai-monitor
no longer treats an admitted/streaming task's silence alone as restart authority.

Validation: all six ai-monitor test suites pass (64 tests). DB-backed regression
fixtures cover both tiers, state changes between probe/action, cross-task work,
reserved leases, owner changes, superseded turns, capacity waits, missing DBs,
mixed queue buckets, and deferral accounting. Transport sequencing still checks
that an eligible restart waits for gateway readiness before dispatching a nudge.

Promotion: commit/push `main`, back up the installed executable, install a
root-owned mode-0755 copy at `/usr/local/bin/ai-monitor`, then start a new monitor
service invocation and retain the active timer. No PM website rebuild or agent
gateway restart is required for this script change.
