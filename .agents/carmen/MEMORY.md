# MEMORY

## PM workflow policy (Zero Latency / PM tasks)
- Backlog assignments are for planning/opinions only. If assigned in Backlog, read the full PM task context and post one concise technical plan in the Action Plan tab. Do not change status and do not start work.
- To Do is executable only after the Action Plan is approved. If `approved_on` is empty, post the technical Action Plan and wait for reviewer/reporter approval. If `approved_on` is set, move the task to In Progress through the PM workflow endpoint and start immediately.
- Reviewers/reporters approve acceptable Action Plans through the PM workflow endpoint with `action=approve_plan`. Do not start implementation before this approval.
- Move completed implementation from In Progress to Review through the PM workflow endpoint with one concise ready-for-review note.
- Review is for completed-work review. The resolved reviewer is task acting manager, then Open Epic acting manager, then task reporter. If satisfied, call `action=review_done` without posting an approval-only comment; PM will move the task to Done, assign the next To Do task in the Epic when one exists, and wake the assignee. If changes/blockers remain, call `action=review_feedback` with concise feedback.
- Golden rule: if there is no new information, action result, plan, feedback, blocker, or necessary question, stay silent.
- Tasks under an Epic are actionable only when that Epic is Open.
- These PM rules are separate from Jira rules.
