# Shared code repositories on x1

Project repositories that any coding agent may modify live under
`/srv/Code/`. They are **shared work trees** owned by `zeh` and
group-writable by the `code-agents` group (currently the manager and
developer roles). All commits made under `/srv/Code/` are attributed to
`Zeh Ferrari <e@zeh.me>` and pushed using zeh's Bitbucket key — agents
work on them, but the *changes* on Bitbucket appear as zeh's.

`/home/zeh/Code` is a symlink to `/srv/Code` so muscle memory still works.

## Layout

```
/srv/Code/
├── <repo>/                              # primary worktree (default branch)
├── <repo>.worktrees/<branch>/           # per-branch worktrees (one per ticket)
└── .gitconfig-zeh                       # zeh identity + ssh key, auto-included
                                         # by every gitdir under /srv/Code/
```

The `[includeIf "gitdir:/srv/Code/"]` block in each agent's `~/.gitconfig`
pulls in `.gitconfig-zeh` automatically — agents never set their own
identity here, and never need to remember to.

System-wide `safe.directory = /srv/Code/*` lets agents (different uid
than the directory owner) operate on the trees.

## Mandatory branch workflow

Every Jira ticket that touches a shared repo **must** designate a
target Bitbucket branch in the ticket description. Without an
explicit branch, the ticket is not actionable — do not start.

The primary worktree at `/srv/Code/<repo>/` is **not** for ticket
work. It tracks the integration branch (master / main / etc.) and
should never carry feature commits directly. All ticket work happens
in a per-branch worktree under `/srv/Code/<repo>.worktrees/<branch>/`,
created via `claim-branch`.

The implementer flow is:

1. Read the Jira ticket, note the designated branch (e.g. `feature/HOMELAB-12-foo`).
2. `claim-branch <repo> <branch>` — checks the branch exists on origin,
   creates a worktree on it, prints the worktree path.
3. `cd "$(claim-branch <repo> <branch>)"` and work there.
4. Make your changes; `git add` + `git commit` as normal. Identity is
   already wired (`Zeh Ferrari <e@zeh.me>`).
5. **Push the branch to origin** — `git push` works as-is on a freshly
   claimed branch (the worktree was created with upstream tracking).
   For a brand-new branch from `--from`, the helper has already done
   the initial `git push -u origin <branch>` for you. Auth resolves
   as zeh via `bbZeh` — no flags or env needed.
6. Stop. Do **not** create a pull request. Report the branch, commit, tests,
   and residual risk in the source channel so zeh can create the PR.
7. After zeh confirms the PR has landed, `claim-branch --release <repo>
   <branch>` to tear down the worktree. The remote branch is cleaned up on
   Bitbucket separately by whoever lands the PR.

> Pushing is **not optional**. Until the branch is pushed, no one else can
> review it (a reviewer's `claim-branch <repo> <branch>` only sees what's on
> origin). Push as often as you'd commit on a normal machine — at minimum once
> per logical step before reporting the branch ready, and again after every
> fix-up that responds to review feedback.

## Review flow — sequential or concurrent

A different agent reviews the changes. Pick one:

**Sequential** (the default — implementer is done iterating):
1. Implementer pushes, reports the branch ready, and runs
   `claim-branch --release <repo> <branch>`.
2. Reviewer runs `claim-branch <repo> <branch>` — same command. The
   helper fetches origin first and lands the reviewer on the latest
   pushed tip.
3. Reviewer reads code, runs tests, reports findings in Jira/email, then
   `claim-branch --release <repo> <branch>`.

**Concurrent** (implementer is still iterating, reviewer wants to read in parallel):

Git allows only one worktree per branch ref, so the reviewer attaches
a *detached HEAD* worktree at `origin/<branch>` instead — same code,
no shared branch ref:

1. Reviewer runs `claim-branch <repo> <branch> --review` — creates
   `/srv/Code/<repo>.worktrees/<branch>__review/` with detached HEAD
   at the latest pushed commit.
2. They read / grep / run tests there. The implementer keeps
   committing on the branch worktree without conflict.
3. If the reviewer wants to propose fixups, they cut a sibling branch
   (`claim-branch <repo> <branch>-review-fixes --from origin/<branch>`).
   The helper already did the initial `git push -u origin` for the new
   branch on creation, so the branch exists on Bitbucket immediately.
   Subsequent commits still need an explicit `git push` to land on
   origin where the implementer and zeh can see them.
   Detached HEAD itself doesn't accept commits without checking out
   a branch first — that's the point.
4. When done, `claim-branch --release <repo> <branch> --review`.

## Pull Requests — Humans Only

Agents do **not** create or merge pull requests. Ever. Regardless of role
(manager, developer, monitor), regardless of how clean the diff looks,
regardless of whether a review has signed off, regardless of how long the
branch has been ready. PR creation and landing are reserved exclusively for
the human operator (`zeh`).

This applies to every form of merge that lands the PR:

- Bitbucket REST API calls that create PRs (`/pullrequests`).
- The "Create pull request" button on Bitbucket.
- The "Merge pull request" button on Bitbucket.
- `git push origin master` / `git push origin main` (or any other
  integration branch).
- `git merge <feature> && git push` from a worktree on the
  integration branch.
- Bitbucket REST API calls that land the PR (`/pullrequests/<id>/merge`).

Agents **may** freely:

- Merge or rebase the integration branch *into their own feature
  branch* to resolve conflicts (`git merge origin/master` from a
  feature-branch worktree, then push the feature branch). This is
  preparing the change, not landing it.
- Push and force-push to their own feature branch.
- Comment on Jira, transition the Jira ticket to `Wait for Review` /
  `In Review`, and report that the branch is ready.

If a branch appears ready and a PR feels overdue, the agent's only move is to
flag it in the source channel and wait. Do not attempt to "help" by creating
or merging a PR — even if the agent has the technical permission to do so via
`bbZeh` or an API token. The rule is a policy boundary, not a permission
boundary.

## `claim-branch` reference

```
# attach an existing origin branch (implementer; common case)
claim-branch <repo> <branch>

# create a brand-new branch off a known ref (only when the ticket
# explicitly says "create branch X off Y" rather than naming an existing one)
claim-branch <repo> <branch> --from <ref>
   # e.g. claim-branch v23 HOMELAB-12-bug --from origin/master

# attach a detached-HEAD review worktree (concurrent with implementer)
claim-branch <repo> <branch> --review

# list every worktree currently attached to the repo
claim-branch --list <repo>

# tear down a worktree after zeh lands the PR / review is done
claim-branch --release <repo> <branch>            # implementer worktree
claim-branch --release <repo> <branch> --review   # reviewer worktree
```

The script lives at `/usr/local/bin/claim-branch`. It writes the
worktree path to **stdout** and progress messages to stderr, so it
composes cleanly with `cd "$(...)"`.

A repeated `claim-branch <repo> <branch>` is a no-op — it just prints
the existing worktree's path. So agents can run it freely to find
where their tree is.

## What does NOT belong under `/srv/Code/`

- Per-agent scratch / experimental code with no Bitbucket origin.
  Use `~/Code/` or `~/workspace/` for that.
- Repos that the agent owns under their own Bitbucket identity.
  Those should stay in the agent's home (different SSH key, different
  commit attribution).
- Anything that needs to be writable only by *one* agent. The
  shared-tree model assumes any code-agent may edit any file.

## Adding a new repo

1. From `/srv/Code/`, clone the repo as `zeh`:
   ```
   sudo -u zeh git -C /srv/Code clone git@bitbucket.org:<workspace>/<repo>.git
   ```
2. Apply the shared-tree perms recursively:
   ```
   sudo chown -R zeh:code-agents /srv/Code/<repo>
   sudo find /srv/Code/<repo> -type d -exec chmod 2775 {} +
   sudo find /srv/Code/<repo> -type f -exec chmod g+rw {} +
   sudo setfacl -R -m g:code-agents:rwX,o::- /srv/Code/<repo>
   sudo setfacl -R -d -m g:code-agents:rwx,o::- /srv/Code/<repo>
   sudo -u zeh git -C /srv/Code/<repo> config core.sharedRepository group
   ```
3. Done — agents can claim a branch with `claim-branch <repo> <branch>`.

## Identity sanity check

```
# Inside any /srv/Code/* tree:
git config user.email          # → e@zeh.me
git config core.sshCommand     # → ssh -i $HOME/.ssh/bbZeh -o IdentitiesOnly=yes

# Outside /srv/Code:
git config user.email          # → agent's own (a@zeh.me / b@zeh.me)
```
