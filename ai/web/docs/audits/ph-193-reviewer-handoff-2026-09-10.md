# PH-193 reviewer handoff audit — 10 September 2026

Task: [PH-193](https://agents.vixi.au/projects/patricia/tasks/cmtuwol5u0zjmovg65fyc6b3i).
Audit sources: read-only live PM records and Carmen's task-specific OpenClaw
transcript. The deployed website was main `df2c9ec`, with plugin 0.1.5.

## What happened

Carmen received the compact contract, her reviewer identity and the current
plan. Tool discovery and plan handoff worked: run
`322675d5-be3f-4c0c-8d7a-7ae6fa4a6c59` successfully invoked
`pm_approve_plan` at 02:31:01 UTC. PM moved the task to To Do and returned
`turnComplete: true`, `actionEffect: finish`, and `nextAction: none`.

Three gaps remained:

1. PM woke the reviewer on assignment even though Asdrubal was assigned and
   no plan existed. That unnecessary call generated 1,989 output tokens.
2. The PM contract instructed `PM_SILENT_NO_CONTRIBUTION`, while OpenClaw's
   group-chat instructions used `NO_REPLY`. Carmen repeatedly debated the
   conflict instead of ending the turn.
3. A terminal tool result was an instruction, not an enforced model boundary.
   After approval, the same run made another inference call and generated
   9,675 output tokens. It mistook the repeated runtime metadata for a new
   message with missing content. The transcript contains no new user message
   between the approval result and that response.

The review inference itself used 7,944 output tokens. Higher effort did not
resolve the conflicting instructions and cannot guarantee concise reasoning.
The missing-body diagnosis is the model's interpretation, not evidence that
PM dropped a new message. No owner/task reply was sent by this audit.

## Repair

- Skip Backlog reviewer-assignment wakes when an implementer exists and no
  Action Plan exists. Unassigned tasks still wake their reviewer, and plan
  submission retains its revision-specific review notification.
- Use `NO_REPLY` consistently in PM prompts and agent-facing documentation;
  retain recognition of the old token for existing sessions.
- Plugin 0.1.6 stops native model execution after an accepted terminal PM
  mutation, fences later tools, and reports successful completion rather than
  a cancellation error. Delayed old-generation responses cannot abort a
  successor. Denied actions and read-only context cannot terminate execution.
- Explain that repeated runtime sender metadata is not another request.

Tests exercise the real notification/compact-contract path with a disposable
SQLite database, native tool outcomes and cancellation fencing, silent-reply
recognition and stream processing. An isolated process using the installed
OpenClaw harness also registered a test run, resolved its session and verified
that the same stop helper invoked its abort callback. TypeScript and lint pass. This repair does not reset PH-193, alter its
approved plan, or interfere with its active Patricia implementation.

The changes require a feature-branch merge, managed PM deployment and plugin
0.1.6 reconciliation before they affect running agents. The deterministic stop
covers native PM tools; the CLI HTTP route retains its response-based terminal
contract. The audit does not claim to constrain a provider's internal review
reasoning or prove end-to-end token savings before activation.
