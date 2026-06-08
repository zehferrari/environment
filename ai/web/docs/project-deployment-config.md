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

Project Settings renders the block read-only for non-owners. Owners can edit it alongside the other project settings.

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
    "host": "x1",
    "environment": "production"
  }
}
```

`ai/openclaw/bin/deploy-on-merge` fetches and fast-forwards `main`, then restarts the OpenClaw gateway service. Set `DRY_RUN=1` (or `DEPLOY_DRY_RUN=1`) to print the exact commands without changing branches, pulling, or restarting services:

```sh
DRY_RUN=1 ./ai/openclaw/bin/deploy-on-merge
```

The Monitor Agent runs this after Bitbucket reports the deployment PR as merged. A zero exit status becomes `Successfully Deployed`; a non-zero status becomes `Deployment Error` with a captured log excerpt.
