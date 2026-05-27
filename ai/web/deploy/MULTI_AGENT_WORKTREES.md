# Previewing a worktree's PM webapp live (switchable single site)

> **The worktree workflow itself is not described here.** Multiple agents
> already share this repo via the established per-branch worktree model —
> `claim-branch <repo> <branch>`, one implementer per branch, reviewers on
> detached-HEAD worktrees, enforced by the `/srv/Code` pre-commit hook. See
> [`ai/openclaw/CODE_REPOS.md`](../../openclaw/CODE_REPOS.md). This file only
> covers the one thing that *is* new: running a chosen worktree's build of the
> PM webapp on the live host so you can see it in the browser.

## The rule (recap)

One writer per branch worktree. Two agents must **not** both implement in the
same branch's worktree — that produces the entangled diffs / broken builds we
hit on `feature/HOMELAB-41`. Split into separate branches (each its own
`claim-branch` worktree) or have the second agent use `claim-branch --review`.

## Switchable single site

`pm.service` (agents.vixi.au) serves exactly **one** worktree's build at a time.
Switch which one with:

```bash
ai/web/deploy/pm-switch.sh <worktree-name | path>   # build that worktree, point pm.service at it, restart, verify
ai/web/deploy/pm-switch.sh status                    # which worktree/branch is live now
```

Run it as **zeh** (owns `node_modules`, has passwordless sudo to `karen` +
systemctl). For the *currently-served* worktree, `rebuild-and-restart.sh` still
works unchanged.

### How it works / what it touches

- A systemd drop-in `/etc/systemd/system/pm.service.d/20-active-worktree.conf`
  overrides `WorkingDirectory` to the chosen worktree's **literal**
  `ai/web/.next/standalone`. (A *symlinked* WorkingDirectory fails `CHDIR`
  under the unit's `ProtectSystem=strict` sandbox — confirmed — so the path
  must be literal; the switcher rewrites it + `daemon-reload`s each switch.)
- `ReadWritePaths` are **not** touched. `DATABASE_URL` is an absolute path and
  the full runtime env (incl. `AUTH_SECRET`) lives in `/etc/default/pm`, so
  switching changes only the **code** served — same database, same secrets,
  no per-worktree `.env.local` seeding.
- Each worktree needs its own `node_modules` (gitignored, not shared) — run
  `pnpm install` in its `ai/web` before the first switch.

### Caveats

- **Shared DB across branches.** Switching to a worktree whose branch has
  *unapplied* migrations can throw `P2022` at runtime. `pm-switch.sh` runs
  `prisma migrate status` and **warns** but does **not** auto-migrate
  (auto-migrating could break other worktrees on an older schema). Apply
  deliberately when you mean to:
  `sudo -u karen bash -c 'cd <ai/web> && set -a && . /etc/default/pm && set +a && pnpm exec prisma migrate deploy'`.
- **DB location is load-bearing.** The live SQLite DB currently sits *inside*
  the HOMELAB-41 worktree (`…/feature_HOMELAB-41…/ai/web/prisma/prisma/dev.db`,
  the absolute `DATABASE_URL`). Don't release that worktree, and consider
  relocating the DB to a neutral path (e.g. `/srv/Data/pm/dev.db`) +
  updating `DATABASE_URL` in `/etc/default/pm` so no single worktree owns the data.
- Only one worktree is live at a time — switching off a worktree takes its
  in-progress preview offline until you switch back.
