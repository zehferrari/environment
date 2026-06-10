# Environment

Unified settings and documentation for the hosts in this network. One folder per host or host role:

| Folder | Subject |
|---|---|
| [`ai/`](./ai) | OpenClaw multi-agent stack on **x1** — host doc + shared agent docs/skills + dashboard frontend |
| [`ha/`](./ha) | Home Assistant configuration (hostname `homeassistant`) |
| [`p16s/`](./p16s) | Hyprland/Wayland desktop config for the **thinkpad** laptop (Lenovo P16s Gen 2) |
| [`zeus/`](./zeus) | Hyprland/Wayland desktop config for the **fedora** workstation |

Host inventory below covers the networked roles (where they live, what they do); per-host deep docs live in the folders above.

## x1

- Host/IP: `x1`, `10.0.0.108`
- OS: openSUSE Tumbleweed
- Role: OpenClaw multi-agent host, WDT playground host, local service host.
- Active users and their roles are listed in `/etc/openclaw/agents.json` (symlinked from `/srv/agents/index.json`). UIDs start at 1001 for agents.

### Samba Private Shared Folders

- Samba service: `smb` and `nmb`, enabled and active through systemd.
- Share name: `Shared`.
- Share path in Samba: `/srv/samba/shared/%U`, so each authenticated user lands in their own private folder.
- Per-user folders: one folder per Linux account at `/srv/samba/shared/<username>` (one for the operator account, one for each entry in the agent registry).
- Home symlinks: each user has `~/Shared -> /srv/samba/shared/<username>` so the same folder is reachable from inside the home dir.
- Permissions: each private folder is owned by the matching Linux user and set to mode `0700`; users cannot read or write each other's shared folder.
- Firewall: `firewalld` permanently allows the `samba` service.
- Samba config: `/etc/samba/smb.conf`, section `[Shared]`.
- SELinux: `/srv/samba/shared(/.*)?` is permanently labeled `samba_share_t` through local file contexts.

### Samba Password Sync

- PAM hook: `/usr/local/sbin/sync-samba-password`, registered from `/etc/pam.d/common-password` through `pam_exec.so`.
- Queue worker: `/usr/local/sbin/sync-samba-password-queue`, run by `sync-samba-password-queue.service`.
- Queue trigger: `sync-samba-password-queue.timer` runs every 5 seconds as a fallback. `sync-samba-password-queue.path` is also enabled, but the timer is the reliable trigger on this host.
- Queue inbox: `/tmp/samba-password-sync/<username>/password.pw`; the parent is root-owned `0711`, and each user subdirectory is owned by the matching Linux account with mode `0700`.
- Scope: the operator account plus every active user in the agent registry.
- Behavior: when one of those users changes their Linux password with `passwd`, the hook creates or updates the matching Samba credential with the same password.
- Bootstrap: users who do not yet exist in Samba should run `passwd` once on `x1`; after that, SMB login uses the same username and password as Linux.
- Verification commands:
  - `sudo /usr/sbin/pam-config --verify`
  - `sudo pdbedit -L`
  - `sudo testparm -s /etc/samba/smb.conf`
  - `systemctl is-active smb nmb sync-samba-password-queue.timer`

## moonlight

- Host/IP: `moonlight`, `10.0.0.10`
- Role: public nginx ingress for `vixi.au` routes.
- Webhook path: `https://dev.vixi.au/webhooks/*` proxies to x1.
- Ollama is also proxied externally through moonlight as documented in root operations notes.

## thinkpad

- Host/IP: `thinkpad`, `10.0.0.105`
- Role: previous OpenClaw agent host; current portable Hyprland/Wayland laptop.
- Current status: migrated user services and linger are disabled; source homes remain intact for reference only.
- Desktop config: [`p16s/`](./p16s).

## Working in this repo (humans & AI assistants)

> `CLAUDE.md` and `AGENTS.md` in this directory are symlinks to this file, so
> Claude Code and other agentic CLIs load the same single source of truth. Edit
> `README.md` — never the symlinks — and keep facts here reconciled with the live
> host, not from memory.

This repo is **documentation + config that is applied to live hosts**, not a
buildable product — with one exception, the `ai/web` PM webapp. Read the
deeper docs before acting:

- **x1 host + agent runtime:** [`ai/README.md`](./ai), [`ai/X1.md`](./ai/X1.md)
- **Agent operating rules (the OpenClaw fleet reads these):**
  [`ai/openclaw/`](./ai/openclaw) — `AGENTS.md`, `ROLES.md`, `TEAM_WORKFLOW.md`,
  `CODE_REPOS.md`, `SERVICES.md`, `MONITORING.md`, `JIRA.md`, `BITBUCKET.md`,
  `INCIDENT_HANDLING.md`
- **PM webapp deploy:** [`ai/web/deploy/README.md`](./ai/web/deploy/README.md)

### Deployment model

- **`x1` is production.** There is no separate dev tier yet; changes go live on
  `x1`.
- The **PM webapp** (`ai/web`) is served at **`agents.vixi.au`**: nginx → one
  host-wide `pm.service` running the standalone Next.js server as the **monitor
  agent (`karen`)**, bound to `127.0.0.1:3000`. The Node process serves all
  assets (nginx can't read the `code-agents` build tree), so a restart is the
  whole deploy.
- **Worktree deployments use `pm-switch`** (the live-site deployment boundary):
  build a chosen worktree and flip `pm.service`/`pm-consumer.service` to it, via
  the CLI (`pm-switch <wt>`) or the PM webapp's Settings → live-preview panel.
  `rebuild-and-restart.sh` is the legacy single-checkout path and now delegates
  to `pm-switch` when pointed at a managed worktree.
- **Build and restart are one step.** `next build` wipes `.next/standalone`; a
  still-running process then serves stale HTML and 404s its own hashed assets.
  Never build without an immediate restart.
- **Prisma migrations are separate** and easy to forget — a `P2022: column does
  not exist` at runtime means the live DB is missing `prisma migrate deploy`.

### Multi-agent / branch workflow

- Several agents share `/srv/Code` on `x1` (group `code-agents`, setgid + ACLs).
  All commits are attributed to `Zeh Ferrari` by design — `git log` can't tell
  which agent committed.
- The **primary checkout (`/srv/Code/<repo>/`) never carries feature commits.**
  All ticket work happens in per-branch worktrees created with
  **`claim-branch <repo> <branch>`** (one implementer per branch; a pre-commit
  hook enforces this).
- **Agents never create or merge pull requests — humans (zeh) only.** An agent's
  job ends at "branch pushed, ready for review."
- **Agent-facing docs propagate from `main`:** each agent's workspace docs are
  symlinks to `ai/openclaw/*.md` in the **main** checkout, so a doc change only
  reaches agents once it lands on `main`.
