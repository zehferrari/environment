# Multi-agent worktrees + monitor-driven live preview

Several actors edit this repo on one host at once — the coding agents, the human
(zeh / Claude Code), and the monitor agent (karen). This documents how they
share the tree safely and how the **monitor** can build any worktree and flip
which one the live PM site serves, including from the browser.

## 1. One writer per branch worktree

The worktree workflow itself is the existing `claim-branch` model — see
[`ai/openclaw/CODE_REPOS.md`](../../openclaw/CODE_REPOS.md): every ticket gets
its own worktree under `/srv/Code/<repo>.worktrees/<branch>/`, **one implementer
per branch**, reviewers on detached-HEAD worktrees, enforced by the `/srv/Code`
pre-commit hook. Two agents must never both *write* the same branch worktree —
that produces entangled diffs and broken builds.

## 2. Collaborative permissions (any code-agent can build)

`/srv/Code` is group-owned by `code-agents`, group-writable, **setgid** on dirs
with **default ACLs**, so files created by anyone stay group-writable. This is
what lets *any* code-agent (including the monitor) build a worktree — not just
whoever first ran `pnpm install`.

Enforced/repaired by the reusable, idempotent tool
[`ai/openclaw/bin/code-tree-perms`](../../openclaw/bin/code-tree-perms)
(installed to `/usr/local/sbin`):

```bash
sudo code-tree-perms --tree /srv/Code --group code-agents --monitor karen \
  --secret     /srv/Code/environment.worktrees/<wt>/ai/web/.env.local \
  --secret-dir /srv/Code/environment.worktrees/<wt>/ai/web/prisma/prisma
```

- Grants group access (never revokes `other`, so co-hosted apps don't break).
- Removes any leftover `user:<monitor>` named-ACL **cap** — a named-user ACL
  overrides the group and is what once limited the monitor to read-only
  (the "only zeh can build" symptom).
- Locks each `--secret` file to the monitor (`chmod 600`) and each
  `--secret-dir` to the monitor (`0700`) — so the PM runtime secrets
  (`.env.local`) and the SQLite DB dir (`prisma/prisma/`, incl. its `-wal`/`-shm`)
  are **not** readable by the coders. The monitor runs `pm.service`, so it owns
  the runtime data.

> **Cross-user build note:** `prisma generate` copies files and `fchmod`s the
> destination; only the *owner* may chmod, so overwriting a prior builder's
> `.prisma` fails with `EPERM`. `pm-switch.sh` removes `.prisma` before building
> (it's regenerated), so any builder produces fresh, owned files. `next build`
> recreates `.next` itself, so it's unaffected.

## 3. Switchable single site

`pm.service` serves exactly **one** worktree at a time. All worktrees share the
same DB + env (`/etc/default/pm`, absolute `DATABASE_URL`), so switching changes
only the served **code**.

### From the browser (monitor-driven)

A git/worktree-exposed project's **Settings → Worktree live preview** (admin
only). Lists that project's **own** repo worktrees, marks the live one, and a
**Serve live** button builds + switches. It is shown only when the project's
`repositoryPath` is a git checkout exposed to the worktree approach
(`lib/projects/worktree.ts`) **and** that repo has worktrees to choose from —
otherwise the block is hidden. Options are scoped by repo identity
(`lib/deploy/repo-key.ts`).

> **TODO (later):** switching still routes through the single shared
> `pm.service`, so today the panel only resolves to real options for the repo
> that service serves (the `environment` repo). The full per-project solution —
> a dedicated service per project repo so each can be built + served
> independently — is not yet implemented.

The web app (runs as the monitor) is **unprivileged** here: it only writes a
request into the spool and polls a state file. A separate **runner service**
does the real work, decoupled from `pm.service` so the restart can't kill it:

```
browser ─▶ POST action ─▶ /var/lib/pm/switch/request.json   (web app, as monitor)
                                   │
        pm-switch-runner (systemd, User=monitor) ──watches──┘
                                   │ runs
                          /usr/local/sbin/pm-switch <wt>      (build, as monitor)
                                   │ sudo (one NOPASSWD rule)
                          /usr/local/sbin/pm-apply-worktree   (root: drop-in + restart)
                                   │ writes
                          /var/lib/pm/switch/state.json  ◀── browser polls
```

### From the CLI

```bash
pm-switch <worktree-name | path>    # build + flip + verify (as monitor or any code-agent w/ the sudoers rule)
pm-switch status                    # which worktree/branch is live
```

### Mechanism

- A drop-in `/etc/systemd/system/pm.service.d/20-active-worktree.conf` overrides
  `WorkingDirectory` to the chosen worktree's **literal** `.next/standalone`
  (a *symlinked* WorkingDirectory fails `CHDIR` under the unit's
  `ProtectSystem=strict` sandbox). Only `pm-apply-worktree` (root) writes it,
  after validating the path is a real worktree build under
  `$PM_WORKTREES_ROOT`.
- `30-switch-spool.conf` adds the spool to pm.service's `ReadWritePaths` so the
  web app can drop a request.

## 4. Files & install

Versioned under `ai/web/deploy/` (PM-specific) and `ai/openclaw/` (generic):

| Path | Role |
| --- | --- |
| `ai/openclaw/bin/code-tree-perms` | generic: collaborative perms + monitor secret-lock (any host) |
| `ai/web/deploy/pm-switch.sh` | build a worktree + delegate the privileged flip |
| `ai/web/deploy/pm-apply-worktree` | **root** helper: write drop-in + daemon-reload + restart (path-validated) |
| `ai/web/deploy/pm-switch-runner` | monitor-run runner: watch spool, run pm-switch, publish state |
| `ai/web/deploy/systemd/pm-switch-runner.service` | runner unit (`User=<monitor>`, templated) |
| `ai/web/deploy/sudoers.d/pm-switch` | one NOPASSWD rule: monitor → `pm-apply-worktree` |
| `ai/web/deploy/install-pm-switch.sh` | idempotent installer (scripts, unit, sudoers, spool, RW drop-in) |
| `ai/web/lib/deploy/{worktrees.ts,actions.ts}` · `app/api/system/worktree-switch/status` · `components/worktree-switcher.tsx` | the browser UI |

Install on a host (after `code-tree-perms` has run):

```bash
sudo PM_MONITOR_USER=karen ai/web/deploy/install-pm-switch.sh
```

Everything is parameterized (`PM_MONITOR_USER`, `PM_WORKTREES_ROOT`,
`PM_SWITCH_DIR`) — nothing is hardcoded to a specific host or worktree.

## 5. Caveats

- **Shared DB across branches.** Switching to a branch with *unapplied*
  migrations can throw `P2022`. `pm-switch.sh` **warns** but never auto-migrates
  (it could break other worktrees on an older schema). Apply deliberately:
  `cd <ai/web> && set -a && . /etc/default/pm && set +a && pnpm exec prisma migrate deploy`.
- **Shared DB outside worktrees.** Production SQLite should live at a neutral
  path such as `/srv/Data/pm/pm.db`, not under any branch checkout. Use
  `ai/web/deploy/move-sqlite-db.sh` for the controlled backup + `VACUUM INTO`
  move, then keep `/etc/default/pm` pointed at the neutral `DATABASE_URL`.
- **The switcher rides in the app it switches.** Switching to a worktree whose
  branch predates this feature lands you on a build without the UI — switch back
  with the CLI `pm-switch`. Resolved once this is merged to `main`.
- Only one worktree is live at a time — switching off a worktree takes its
  preview offline until you switch back.
