# Project deployment config

Projects can declare a `deployment` settings block that the Monitor Agent reads when a human moves an Epic or top-level Task to `Deployment Approved`.

## Shape

The PM database stores the block on `Project` and surfaces it in Project Settings:

- `provider`: currently `bitbucket`.
- `productionBranch`: canonical production branch, usually `main`.
- `prTargetBranch`: destination branch for deployment PRs; defaults to `productionBranch`.
- `mode`: `pr-only`, `script`, `pipeline`, or `manual`.
- `onMerge`: shell command/path run from the project repository root when `mode = script`.
- `pipelineName`: provider pipeline selector when `mode = pipeline`.
- `host`: deployment host label.
- `environment`: deployment environment name, for example `production`.
- `bitbucketWorkspace` / `bitbucketRepoSlug`: optional overrides; otherwise Monitor infers them from `origin`.
- `agentChangeBlockedBranches`: JSON string array of branch names where agents must not submit code-changing work for review.

Project Settings renders the block read-only for non-owners. Owners can edit it alongside the other project settings. The protected agent branch combobox accepts multiple branch names and suggests the production branch, PR target branch, and known task branches.

## Modes

- `pr-only`: Monitor opens and watches PRs, then records merge state without running a deploy command.
- `script`: after merge, Monitor runs `deployment.onMerge` in the repository root and records stdout, stderr, and exit code.
- `pipeline`: Monitor treats provider pipeline state as the deployment result.
- `manual`: Monitor records the PR lifecycle but expects deployment to happen outside PM.

## `environment` reference implementation

The `environment` project is configured as:

```json
{
  "deployment": {
    "provider": "bitbucket",
    "productionBranch": "main",
    "prTargetBranch": "main",
    "mode": "script",
    "onMerge": "./ai/openclaw/bin/deploy-on-merge",
    "host": "thinkpad",
    "environment": "production"
  }
}
```

`ai/openclaw/bin/deploy-on-merge` fetches and fast-forwards `main`, then restarts the OpenClaw gateway service. Set `DRY_RUN=1` (or `DEPLOY_DRY_RUN=1`) to print the exact commands without changing branches, pulling, or restarting services:

```sh
DRY_RUN=1 ./ai/openclaw/bin/deploy-on-merge
```

The Monitor Agent runs this after Bitbucket reports the deployment PR as merged. A zero exit status becomes `Successfully Deployed`; a non-zero status becomes `Deployment Error` with a captured log excerpt.

## Protected agent branches

Protected agent branches are a workflow guard for branches such as `main` or `production` that must not receive direct agent implementation work. When an assignee calls `ready_for_review` with `repoTouched: true`, PM rejects the transition if the task branch matches the protected list. The monitor verifier also reports a `pm.repo.verify.fail` with a protected-branch reason if a queued verification job encounters a protected branch.

Agents should resume the task, move code-changing work to an allowed task branch, push it, and call `ready_for_review` again. Reviewers should treat protected-branch failures as workflow blockers, not as missing commits or credential issues.

## Approval flow

When deployment is approved, Monitor checks the project repository for uncommitted local changes before pushing or opening a PR. A clean worktree is pushed and opened as a deployment PR immediately. A dirty worktree creates a pending row in the Epic/Task Development tab; an authorized human must approve the local commit before Monitor commits the changes as the reporter, pushes the branch, and opens the PR.

The Development tab lets the reporter, or the reviewer when project policy allows it, approve the local commit and approve/merge an open deployment PR. Provider reviewer assignment is not automatic yet because Bitbucket reviewer assignment requires the provider account UUID; PM currently stores only the reporter's PM user id and email.
