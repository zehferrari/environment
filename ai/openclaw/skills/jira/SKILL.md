# Jira

Use this skill for Jira issue, comment, mention, status, and assignment
work. The Atlassian API token is read from `~/.ssh/jiraToken.txt`; the
`jira_account_id` is resolved at runtime via `../agent-self.js` (reads
`/etc/openclaw/agents.json`) so the helpers work for every registered
coding agent without per-agent forks.

## Configuration

Set `JIRA_BASE_URL` to the Jira instance URL, for example
`https://your-team.atlassian.net`. `JIRA_URL` and `JIRA_HOST` remain
accepted as compatibility aliases; `JIRA_BASE_URL` takes precedence.

`bitbucket-check.js` additionally requires these environment variables:

- `BITBUCKET_WORKSPACE`
- `BITBUCKET_REPO_SLUG`
- `BITBUCKET_USERNAME`

It reads the token from `BITBUCKET_TOKEN_PATH` when set, otherwise from
`~/.ssh/bitbucketToken.txt`. The helper stops before making a request
when a required value is absent or the token file is empty.

Workflow rules (picking Jira work, working a ticket, @-mentions,
assignment, the Jira/code boundary) live in `../WORKFLOW.md` and
`../guides/JIRA.md`. Helpers below are the mechanical surface; the
*behaviour* rules are there, not here.

Backlog Jira tickets are not actionable. No queue, transition, comment,
or work — even if assigned or mentioned. Override only on an explicit owner
instruction for that specific ticket.

Commands:

- `node jira-my-issues.js` — list issues assigned to the running agent
  that are not done/closed. First-line source for the next-task queue
  (see `../WORKFLOW.md` § *Picking your next task*).
- `node jira-comment.js <issueKey> <comment>` — add a comment to a Jira
  issue. Converts markdown to Atlassian Document Format (ADF): paragraphs,
  ATX headings (1–3), bullet/numbered lists, fenced code blocks, pipe
  tables, inline `**bold**` / `*italic*` / `` `code` `` / `[text](url)`.
  A trailing `--` / `<first name>` / `<provider>/<model>` signature is
  detected and the provider/model line rendered subdued. Sign every
  Jira comment per the signature rule.
- `node jira-transition.js <issueKey> <newStatus>` — change the status
  of a Jira issue (e.g. `Selected for Development` → `In Progress` →
  `Wait for Review` / `In Review`). Never self-assign; do not transition
  a ticket you don't own or have explicit handoff for.
- `node jira-check-devtools.js` — quick connectivity + token probe.
- `node jira-test.js` — scratch harness; do not use for real work.
- `node bitbucket-check.js` — verify Bitbucket repo/workspace access for
  the configured token.
- `node create-roadmap-tickets.js` — one-shot Epic/task scaffolding;
  run only when the owner asks.

Jira keys are project-agnostic. Treat any `PROJECT-123` form as valid
(`HOMELAB-3`, `WDT-47`, etc.). If a lookup says not-found/no-access but a
webhook or email names the ticket, re-check with these helpers before
declaring no action — if lookups disagree, tell the owner you're blocked.

See `skills/jira/skill.json` for the OpenClaw tool-manifest subset
exposed to the agent runtime.
