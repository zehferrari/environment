# BITBUCKET.md

Bitbucket-specific workflow for OpenClaw agents working in shared code
repositories. Use this with [`../WORKFLOW.md`](../WORKFLOW.md)
(the single workflow authority for both Jira and Mission Control / PM) and
[`./CODE_REPOS.md`](./CODE_REPOS.md). For the PM webapp interface, see
[`./MISSION_CONTROL.md`](./MISSION_CONTROL.md).

## Scope

- Shared repos under `/srv/Code/` are Bitbucket-backed unless zeh says
  otherwise.
- All commits made under `/srv/Code/` are attributed to the git identity
  defined in the project settings, falling back to `Zeh Ferrari <e@zeh.me>`
  if no project identity is configured. They are pushed using zeh's
  Bitbucket key.
- The primary `/srv/Code/<repo>/` checkout is not for task work. Use
  `claim-branch` worktrees.

Full host checkout mechanics are in [`CODE_REPOS.md`](./CODE_REPOS.md).

---

## Mandatory branch workflow

Every tracked code task touching a shared repo **must** designate a
target branch before implementation starts.

- For Jira tasks, the target Bitbucket branch must be named in the Jira
  ticket.
- For Mission Control tasks, use the resolved branch supplied by PM: an
  explicit Task branch, then the Epic's explicit branch or lowercased Epic
  work-item key, then the lowercased Task work-item key. Never use the Task or
  Epic database ID.
- A Mission Control task is blocked for branch naming only when neither an
  explicit branch nor a human work-item key is available.

Workflow:

1. Read the source work item and note the designated branch
   (for example `feature/HOMELAB-12-foo`).
2. Run `claim-branch <repo> <branch>` to check out the branch locally.
   The helper first fetches `origin/main`, or `origin/master` when main is
   absent. If the branch does not exist on origin, it cuts it from that
   freshly fetched integration ref, pushes it, and sets up upstream tracking.
   It rejects caller-supplied `--from` refs.
3. Work inside the path printed by `claim-branch`. Never edit the
   primary `/srv/Code/<repo>/` tree directly for task work. You MUST configure
   the local worktree's git identity (user.name and user.email) to match the
   project settings (refer to [`CODE_REPOS.md`](./CODE_REPOS.md) for how to
   use `git config --worktree` and `expected-identity`).
4. Make focused commits with the required work item key or commit prefix.
5. Push the branch to origin. On a freshly claimed branch, `git push`
   works as-is because upstream tracking is already configured.
6. Stop. Do **not** create a pull request. Report the branch, commit,
   tests, and residual risk in the source channel so zeh can create the
   PR.
7. After zeh confirms the PR has landed, run
   `claim-branch --release <repo> <branch>` to tear down the worktree.
   The remote branch is cleaned up on Bitbucket separately by whoever
   lands the PR.

Pushing is **not optional**. Until the branch is pushed, no one else can
review it. Push at least once before reporting the branch ready, and
again after every fix requested during review.

---

## Commits

- Keep commit messages concise and traceable.
- Include the work item key or source-system commit prefix.
- For Jira, include the Jira key (`PROJECT-123`) in every commit message.
- For Mission Control, prepend the resolved prefix: the Task's explicit
  `commitPrefix`, then its Epic's explicit `commitPrefix`, then the Task
  work-item key. Never combine Epic and Task keys unless that compound value
  was explicitly configured, and never use a database ID.
- Do not include secrets, tokens, private logs, or irrelevant terminal
  transcripts in commit messages.

---

## Smart Commits

Atlassian documents Bitbucket/Jira Smart Commits here:
<https://support.atlassian.com/bitbucket-cloud/docs/use-smart-commits/>.

Smart Commits are special commands in commit messages that can act on
Jira work items when Bitbucket and Jira are connected. The documented
basic shape is:

```text
<ignored text> <WORK_ITEM_KEY> <ignored text> #<COMMAND> <optional COMMAND_ARGUMENTS>
```

Common commands include:

- `#comment <comment>` to add a Jira comment.
- `#time <value>w <value>d <value>h <value>m <comment>` to log work.
- `#<transition_name>` to run a Jira workflow transition.

Important constraints:

- A Smart Commit command must stay on one line. Multiple commands can
  be on one line, but commands split across lines may be ignored or only
  partly applied.
- The commit's author email must match exactly one Jira user with the
  required permission. A mismatch can make the Smart Commit fail while
  the Git commit itself still succeeds.
- Smart Commits only understand the default Jira key shape: two or more
  uppercase letters, a hyphen, then the work item number.

Local OpenClaw policy:

- Default to plain traceability: include the issue key/prefix, but do
  **not** use Smart Commit commands for comments, time logging, or
  transitions.
- Use Jira helpers and Jira comments for human-visible status.
- Use Smart Commit commands only when zeh explicitly asks for that side
  effect on that commit.

---

## Review flow

For shared repos under `/srv/Code/`, attach a worktree on the branch
under review.

Sequential review:

1. Implementer pushes, reports the branch ready, and runs
   `claim-branch --release <repo> <branch>`.
2. Reviewer runs `claim-branch <repo> <branch>`.
3. Reviewer reads code, runs tests, reports findings in the source
   channel, then runs `claim-branch --release <repo> <branch>`.

Concurrent review while the implementer is still iterating:

1. Reviewer runs `claim-branch <repo> <branch> --review`.
2. The helper creates a detached-HEAD review worktree at
   `/srv/Code/<repo>.worktrees/<branch>__review/` using the latest pushed
   commit.
3. If the reviewer wants to propose fixups, they create a sibling branch
   from the current integration branch, for example:

```bash
claim-branch <repo> <branch>-review-fixes
```

4. When done, release with
   `claim-branch --release <repo> <branch> --review`.

Detached HEAD itself is for review, not direct commits.

---

## Pull requests: humans only

Agents do **not** create or merge pull requests. Ever. Regardless of role
(implementer, reviewer, manager), approval state, user-visible urgency,
technical permission, or how long the branch has been ready, PR creation
and landing are reserved for zeh / human operators.

This applies to every form of PR creation or landing:

- Bitbucket REST API calls that create PRs.
- The "Create pull request" button on Bitbucket.
- The "Merge pull request" button on Bitbucket.
- GitHub/GitLab-style connector tools if a repo is mirrored elsewhere.
- Direct pushes, squashes, rebases, or force-pushes that land work onto
  the integration branch.
- Bitbucket REST API calls that land the PR.

Agents may:

- Merge or rebase the integration branch **into their own feature
  branch** to resolve conflicts, then push the feature branch.
- Push or force-push to their own feature branch when needed.
- Report in the source channel that the branch is ready for human PR
  creation/landing.

If a branch appears ready and a PR feels overdue, the only agent move is
to report that in the source channel or escalate to zeh. Do not create or
merge the PR.

---

## `claim-branch` reference

```bash
# attach an existing origin branch (implementer; common case)
claim-branch <repo> <branch>

# create a brand-new branch from the freshly fetched integration branch
claim-branch <repo> <branch>

# attach a detached-HEAD review worktree
claim-branch <repo> <branch> --review

# list every worktree currently attached to the repo
claim-branch --list <repo>

# tear down a worktree after zeh lands the PR / review is done
claim-branch --release <repo> <branch>
claim-branch --release <repo> <branch> --review
```

The script lives at `/usr/local/bin/claim-branch`. It writes worktrees
under `/srv/Code/<repo>.worktrees/`. A repeated
`claim-branch <repo> <branch>` is a no-op: it just prints the existing
path.

New branches are always created from freshly fetched `origin/main`, or
`origin/master` when main is absent. Existing origin branches are attached at
their remote tip; they are not silently rebased. Do not use raw
`git worktree add -b` or a local integration-branch checkout for task branches.
