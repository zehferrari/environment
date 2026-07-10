# Multi-agent worktrees + monitor-driven live preview

Several actors edit this repo on one host at once — coding agents, the human
operator, and the monitor agent. This documents how they
share the tree safely and how the **monitor** can build any worktree and flip
which one the live PM site serves, including from the browser.

## 1. One writer per branch worktree

The worktree workflow itself is the existing `claim-branch` model — see
[`ai/openclaw/guides/CODE_REPOS.md`](../../openclaw/guides/CODE_REPOS.md): every ticket gets
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
sudo code-tree-perms --tree /srv/Code --group code-agents --monitor <monitor-user> \
  --secret     /srv/Code/environment.worktrees/<wt>/ai/web/.env.local \
  --secret-dir /srv/Code/environment.worktrees/<wt>/ai/web/prisma/prisma
```

- Grants group access (never revokes `other`, so co-hosted apps don't break).
- Removes any leftover `user:<monitor>` named-ACL **cap** — a named-user ACL
  overrides the group and is what once limited the monitor to read-only
  (the "only one local account can build" symptom).
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

`pm.service` serves exactly **one** worktree at a time. Each branch uses an
isolated SQLite fork under `/srv/Data/pm/wt-<branch>.db`, while `/etc/default/pm`
remains the base environment. Switching changes both the served code and the
active `DATABASE_URL`, so Prisma schema changes are kept with the branch that
introduced them.

### From the browser (monitor-driven)

A git/worktree-exposed project's **Settings → Worktree live preview** (human
sessions only; agents are rejected — a stricter admin-only gate is still
pending). Lists that project's **own** repo worktrees, marks the live one, and a
**Serve live** button builds + switches. The live row exposes **Rebuild live**,
which rebuilds and restarts the same worktree without changing the served
branch. It is shown only when the project's
`repositoryPath` is a git checkout exposed to the worktree approach
(`lib/projects/worktree.ts`) **and** that repo has worktrees to choose from —
otherwise the block is hidden. Options are scoped by repo identity
(`lib/deploy/repo-key.ts`).

> **Status (ENV-107):** the per-project solution now exists as the generic
> switcher stack — a registry entry in `lib/deploy/switch-registry.ts`, a
> per-project spool at `/var/lib/worktree-switch/<key>` consumed by
> `worktree-switch-runner@<key>.service`, an env contract at
> `/etc/worktree-preview/<key>.env`, and one of two drivers:
> `node-service` (build → fork DB → flip `worktree-preview@<key>` — WDT)
> or `nginx-docroot` (repoint docroot symlink + reload — Patricia). The
> generic runner also understands an `on`/`off` lifecycle
> (`lifecycleControl` in the registry). PM (`environment`) itself still
> rides the original `pm-switch` pipeline below; its supervised migration
> onto the generic runner (WS6) is deliberately gated pending an operator
> decision.

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
pm-switch <worktree-name | path>    # build + flip PM web + PM consumer + verify
pm-switch status                    # which worktree/branch is live for both services
```

Do not run the legacy direct rebuild path against a managed worktree. In this
model `pm-switch` is the deployment boundary because it prepares generated
Prisma artifacts, migrates the worktree database fork, flips both services, and
verifies hashed assets. `rebuild-and-restart.sh` delegates to `pm-switch` when
pointed at `/srv/Code/environment.worktrees/.../ai/web`.

### Mechanism

- Drop-ins under `/etc/systemd/system/pm.service.d/` and
  `/etc/systemd/system/pm-consumer.service.d/` move the web server and PM
  consumer together. The web server `WorkingDirectory` points to the chosen
  worktree's **literal** `.next/standalone`; the consumer `WorkingDirectory`
  points to the same worktree's `ai/web` directory. A *symlinked*
  `WorkingDirectory` fails `CHDIR` under the units' `ProtectSystem=strict`
  sandbox. Only `pm-apply-worktree` (root) writes these drop-ins, after
  validating the path is a real worktree build under `$PM_WORKTREES_ROOT`.
- `pm-consumer.service` must switch with `pm.service`; otherwise the web UI
  can serve new workflow rules while the consumer still wakes agents with
  stale code from an older worktree.
- `30-switch-spool.conf` adds the spool to pm.service's `ReadWritePaths` so the
  web app can drop a request.
- `pm-switch.sh` creates `/srv/Data/pm/wt-<branch>.db` from the canonical DB
  when the branch DB does not exist, enables WAL, runs `prisma migrate deploy`
  against that branch DB only, then builds and delegates the service flip to
  `pm-apply-worktree`.
- If the target worktree or DB is already live, `pm-switch.sh` first asks
  `pm-apply-worktree --stop-live` to stop `pm-consumer.service` and
  `pm.service`. This prevents `prisma migrate deploy` from failing with
  `database is locked`, and avoids rebuilding `.next/standalone` while the
  running Next process still has that tree as its working directory.
- Before building, `pm-switch.sh` asks `pm-apply-worktree --prepare-build` to
  remove generated `.next` and Prisma client artifacts and recreate the
  `.prisma` output directory for the actual builder user. This keeps
  browser-triggered rebuilds working when the previous build was made by a
  different local account.

## 4. Files & install

Versioned under `ai/web/deploy/` (PM-specific) and `ai/openclaw/` (generic):

| Path | Role |
| --- | --- |
| `ai/openclaw/bin/code-tree-perms` | generic: collaborative perms + monitor secret-lock (any host) |
| `ai/web/deploy/pm-switch.sh` | build a worktree + delegate the privileged web/consumer flip |
| `ai/web/deploy/pm-apply-worktree` | **root** helper: write pm.service + pm-consumer.service drop-ins, daemon-reload, restart (path-validated) |
| `ai/web/deploy/pm-switch-runner` | monitor-run runner: watch spool, run pm-switch, publish state |
| `ai/web/deploy/systemd/pm-switch-runner.service` | runner unit (`User=<monitor>`, templated) |
| `ai/web/deploy/sudoers.d/pm-switch` | one NOPASSWD rule: monitor → `pm-apply-worktree` |
| `ai/web/deploy/install-pm-switch.sh` | idempotent installer (scripts, unit, sudoers, spool, RW drop-in) |
| `ai/web/lib/deploy/{worktrees.ts,actions.ts,switch-registry.ts,repo-key.ts}` · `app/api/system/worktree-switch/status` · `components/worktree-switcher.tsx` | the browser UI + project registry |
| `ai/web/deploy/worktree-switch.sh` | generic build-and-flip driver for registered non-PM projects |
| `ai/web/deploy/worktree-switch-runner` · `systemd/worktree-switch-runner@.service` | generic per-project spool runner (`switch`/`on`/`off`/`remove`) |
| `ai/web/deploy/worktree-remove` | monitor-run clean local worktree/branch cleanup helper; never deletes remote refs |
| `ai/web/deploy/worktree-preview-apply` · `worktree-docroot-apply` | **root** apply helpers for the `node-service` / `nginx-docroot` drivers |
| `ai/web/deploy/worktree-preview-serve` · `systemd/worktree-preview@.service` | templated preview service for `node-service` projects |
| `ai/web/deploy/sudoers.d/worktree-preview` · `worktree-preview-install.sh` · `worktree-preview.env.example` | generic-stack sudoers, installer, and per-project env contract |

Install on a host (after `code-tree-perms` has run):

```bash
# Required by pm-switch.sh and move-sqlite-db.sh for safe SQLite backups/forks.
# openSUSE:
sudo zypper --non-interactive install sqlite3
# Debian/Ubuntu:
# sudo apt-get install sqlite3

sudo PM_MONITOR_USER=<monitor-user> ai/web/deploy/install-pm-switch.sh
```

Everything is parameterized (`PM_MONITOR_USER`, `PM_WORKTREES_ROOT`,
`PM_SWITCH_DIR`) — nothing is hardcoded to a specific host or worktree.

## 5. Caveats

- **Branch DB freshness.** If a branch DB already exists, `pm-switch.sh` keeps
  using it. When production data has changed in another live DB and you need
  that latest state in the branch preview, refresh the branch DB deliberately
  first, for example with `sqlite3 /srv/Data/pm/<source>.db ".backup
  '/srv/Data/pm/wt-<branch>.db'"`, then run `pm-switch <branch>`.
- **Canonical DB outside worktrees.** The canonical SQLite source should live at
  a neutral path such as `/srv/Data/pm/pm.db`, not under any branch checkout.
  Use `ai/web/deploy/move-sqlite-db.sh` for the controlled backup + `VACUUM
  INTO` move before enabling worktree forks.
- **The switcher rides in the app it switches.** Switching to a worktree whose
  branch predates this feature lands you on a build without the UI — switch back
  with the CLI `pm-switch`. (Merged to `main` long since, so this only bites on
  very old branches.)
- Only one worktree is live at a time — switching off a worktree takes its
  preview offline until you switch back.
