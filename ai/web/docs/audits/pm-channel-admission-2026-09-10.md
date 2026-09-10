# PM admission failure — 10 September 2026

Affected tasks: [PH-193](https://agents.vixi.au/projects/patricia/tasks/cmtuwol5u0zjmovg65fyc6b3i)
and [V23-39](https://agents.vixi.au/projects/v23/tasks/cmtuxijxo2uq9ovg6qdrgwsj0).

## Evidence and cause

PM accepted their HTTP deliveries, but OpenClaw rejected execution with
`GatewayDrainingError: Gateway is draining; new tasks are not accepted`.
The failed runs had no model and no admission timestamp. Asdrubal, Carmen
and Barekbaal were affected. Restarting a healthy gateway did not fix it.

OpenClaw 2026.9 tracks HTTP work with an AsyncLocalStorage admission lease.
PM's handler launched `runPmTurn` in `setImmediate`, wrote HTTP 202 and returned.
The router released its lease when the handler resolved. The delayed turn
inherited that released lease, so subordinate session work was rejected even
though the gateway was accepting new requests. This was a PM channel lifecycle
bug, not an OpenAI login or model outage.

The previous upgrade verified provider probes, gateway CLI turns, capabilities
and website assets. Those checks did not exercise `/pm-channel/ingest` through
its asynchronous dispatch and callback path; they therefore missed this defect.

## Repair

Plugin 0.1.8 writes HTTP 202 immediately and awaits the accepted turn inside the
handler. The HTTP client receives its receipt promptly while OpenClaw retains
admission through context preparation, model execution and callbacks. The
existing generation fencing, cancellation and error cleanup remain in force.
No internal admission flags are changed or bypassed.

The PM recovery endpoint had a second defect: it treated a created notification
as proof of dispatch, even when the channel circuit breaker suppressed delivery.
It now returns HTTP 503 with `dispatched: false` on failure and records
`task.workflow.turn_request_failed`. Failed delivery does not consume the
five-minute successful-request cooldown. Successful delivery and active-run
protection retain their existing behavior. This web change awaits normal merge
and deployment; the runtime plugin repair can be applied independently.

The breaker itself remains enabled: repeated failures permit one probe per
10 minutes. It protects against expensive retry loops. Task recovery must check
actual run admission, not only a notification ID or HTTP acknowledgement.

## Verification

`pm-channel-admission-test.mjs` runs the actual ingress handler under the installed
OpenClaw admission implementation, using a local HTTP server and a gated fake
model. It verifies immediate receipt, asynchronous admission lifetime, same-session
409 fencing, release on success/failure and a subsequent turn. The old handler
fails the admission assertion; 0.1.8 passes. No provider requests or live PM writes
are made by this regression test.

Run from `ai/web`:

```sh
OPENCLAW_DIST=/usr/local/lib/node_modules/openclaw/dist pnpm test:pm-channel-admission
pnpm test:pm-workflow-recovery-response
pnpm test:pm-channel-runtime-compat
pnpm test:pm-task-tools
```

The recovery-response test exercises the actual route with isolated dependencies:
suppressed delivery, truthful audit, successful retry, rate limiting and active-run
protection. TypeScript checking also passes.

A live tool-free diagnostic through Asdrubal's PM ingress received HTTP 202 in
0.04 seconds and a `PM_CONNECTION_OK` callback in 6.73 seconds, using
`openai/gpt-6-astra` with High effort. Its callbacks went to a temporary loopback
sink, so it created no task comment or external message.

## Runtime activation and rollback

The installed plugin is `/usr/local/share/openclaw/plugins/pm-channel`.
Previous files are privately backed up at
`/var/backups/openclaw/pm-channel-before-admission-fix-20260910/`.
Asdrubal, Barekbaal and Carmen were restarted one at a time to load 0.1.8.
Karen's running gateway was left untouched because a PM record still claimed
an active run; automatic approval review rejected cancelling that unrelated
record and conditionally restarting her. The staged fix loads on her next restart.

The two reported tasks retain their plans, reviewer feedback and completed work.
Recovery uses PM's existing workflow-turn endpoint with current task context.
Do not reset the tasks or rewrite failure records merely to reopen the circuit
breaker. A bounded operator replay must retain its original failure in the audit. Reverting the plugin on OpenClaw 2026.9 restores the admission bug;
coordinate any rollback with the earlier core/runtime recovery procedure.


## Recovered task outcomes and follow-up delivery repair

PH-193 completed its first repaired turn on Astra and posted a response, but the
attachment table still contained only the original screenshot. OpenClaw logged
that the PM outbound adapter lacked `sendMedia` and discarded the media URLs.
A textual success claim was therefore not proof of delivered files.

Plugin **0.1.9** adds task-scoped media uploads through the existing attachment
API. It uses OpenClaw's outbound media loader/access policy, retains the active
message grant outside the prompt, enforces a 10 MiB cap, checks generation
ownership around asynchronous work, and posts a link only after the API confirms
storage. Upload failures propagate as errors instead of dropping the files.
The installer stages the new helper with the rest of the plugin. The current
SDK's `replyOptions.turnAdoptionLifecycle.onAdopted` also reports execution
admission; the obsolete top-level callback alone did not populate admission
and could provoke unnecessary recovery/supersession.

A delivery-only recovery through Asdrubal's real PM ingress uploaded his existing
files without regenerating them. It emitted `turn:admitted`, selected Astra, and
completed in 7.76 seconds. Durable attachment records verify:

- `PH-193-affected-orders.csv`: 61,670 bytes, attachment `cmtv7pqf826daovk8ojj9zra5`.
- `PH-193-affected-orders-summary.csv`: 102,489 bytes, attachment `cmtv7pqg126deovk89bqoauu6`.

This verifies transport/storage, not the business correctness of the CSV values;
the task's normal reviewer still owns acceptance.

V23-39 was recovered with one operator-controlled replay of the original owner
instruction, proven to have failed before model execution. Its fresh scoped
context went through the normal durable enqueue/capacity/fencing helpers; the
global breaker was not disabled. `pm.channel.operator_recovery` preserves the
original failure evidence. After intermediate fallback/recovery turns, Astra
completed run `47d27100-0f2d-4123-abeb-faeb32be78d1` with `flag_blocker` and a
visible response. The agent reports working AWS credentials and passing checks,
but says step 5 requires PM/operator deployment under the current operating
contract. No deployment was performed by this incident repair.

Asdrubal is running 0.1.9; Carmen and Barekbaal loaded 0.1.8's admission fix.
The shared installed files are 0.1.9 and apply to other gateways on their next
restart. Karen was not restarted. Previous 0.1.8 files are privately backed up
under `/var/backups/openclaw/pm-channel-before-attachments-fix-20260910/`.

Additional regression coverage: `pnpm test:pm-task-attachments` verifies exact
multipart bytes, scoped token/message, stale-generation refusal, explicit API
errors, size limits and loopback endpoint validation. The runtime compatibility,
admission, native task tool and recovery-response checks pass. The website's
truthful-recovery response change remains pending human merge/deployment.
