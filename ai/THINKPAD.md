# thinkpad OpenClaw Agents

Installed on 2026-05-06 for host `thinkpad` (`10.0.0.105`).

> **Environment:** `thinkpad` is the **production** environment for this repository.
> There is no separate dev tier yet — every code change is deployed to `thinkpad`
> via `ai/web/deploy/rebuild-and-restart.sh` (or the PM Worktree-switcher
> when changing which worktree is served). A dedicated dev environment
> will be set up once the project matures enough to justify the split.

## Local Users

| thinkpad user | Role | UID |
|---|---|---|
| coding-agent | coding | `<per-agent UID>` |
| monitor-agent | monitor | `<monitor UID>` |

## Runtime Layout

- **Unified Environment Repository**: `/srv/Code/environment` is the stable
  primary checkout and must not be edited for feature work; working tree
  checkouts live in `/srv/Code/environment.worktrees/...` and are the only
  place PM/OpenClaw code changes should be made.
- **Shared OpenClaw Docs and Skills**: `ai/openclaw` from the active validated
  worktree used by PM/OpenClaw provisioning.
- **Repository Access**: All agent accounts belong to the `code-agents` group and access code files under the `/srv/Code` directory.
- **Shared-Tree Permissions**: `/srv/Code` is group-owned by `code-agents`, group-writable with **setgid + default ACLs**, so any code-agent (including the monitor agent) can build any worktree — not just whoever created `node_modules`. Enforced/repaired by the idempotent `/usr/local/sbin/code-tree-perms` (source: `ai/openclaw/bin/code-tree-perms`, installed by `install.sh`).
- **Runtime Secrets (monitor-owned)**: The PM webapp's live secrets/data are owned by the monitor-agent user and locked away from the coding agents — `ai/web/.env.local` (`600 monitor-agent`) and the SQLite DB dir `ai/web/prisma/prisma/` (`0700 monitor-agent`, which also protects its `-wal`/`-shm`). The surrounding source tree stays group-collaborative.
- **Agent Registry**: `/etc/openclaw/agents.json` is the canonical live
  registry file kept outside of git; historical installs may expose the same
  file through `/srv/agents/index.json`.
- **Dashboard Configuration**: [/etc/agent-dashboard/config.json](file:///etc/agent-dashboard/config.json).
- **Dashboard Source Files and Nginx Web Root**: served from the active PM
  worktree selected by `pm-switch`, not from manual edits to
  `/srv/Code/environment`.
- **Nginx Web Server**: Terminates TLS and proxies the PM hostname to the
  standalone Next.js process; PM static assets are served by Node from the
  active worktree build.
- **Agent Workspaces**:
  - `coding-agent`: `/home/<coding-agent>/workspace`
  - `monitor-agent`: `/home/<monitor-agent>/.openclaw/workspace` (no user-facing standard workspace)
- **Shared Documents Symlinks**: The shared documents (`AGENTS.md`,
  `guides/ROLES.md`, `WORKFLOW.md`, `guides/CODE_REPOS.md`, `USER.md`) are symlinked
  from the active OpenClaw worktree to both `~/workspace/` and
  `~/.openclaw/workspace/` for the coding agents. For the monitor agent, they
  are symlinked only to `~/.openclaw/workspace/`.
- **Per-Agent Files**: Per-agent files (`SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `MEMORY.md`, `HEARTBEAT.md`) live canonically in `~/workspace/<file>` with a symlink in `~/.openclaw/workspace/<file>` pointing to it.
- **Agent State Directories**: `/home/{<coding-agent>,<monitor-agent>}/.openclaw`.

## Agent Lifecycle Management

`zeh` creates, edits, and removes agents from the PM webapp **Agents** page
(`agents.vixi.au` → `Add Agent` / per-card `Edit` → `Delete`). The flow is
**route-centric** with a single privileged boundary:

- **`/api/agents/{add,edit,remove}`** (Next.js route handlers, run as the
  `monitor-agent` user via `pm.service`) validate the request, allocate the next
  free UID (≥ 1001), allocate a verified gateway/browser-sidecar port pair,
  render the agent's file content,
  reconcile the PM database with `syncAgents()`, and write an
  `agent.registry.{add,edit,remove}` audit row. They perform **no** privileged
  I/O themselves — `pm.service` runs `NoNewPrivileges=true` and *cannot* `sudo`.
  Instead they spool a request into `/var/lib/pm/agent-provision/` and poll for a
  result file (so the route still resolves synchronously).
- **`openclaw-agent-runner.service`** (source `ai/openclaw/bin/openclaw-agent-runner`)
  is the deterministic executor: the monitor agent's **system identity** (runs as
  the monitor user, `NoNewPrivileges=no`, decoupled from `pm.service`), it watches
  the spool, runs `sudo -n openclaw-manage-user …`, and writes the result back. The
  monitor **LLM is not in the loop** — it only ever runs that one command. (Modeled
  on `pm-switch-runner`.)
- **`/usr/local/sbin/openclaw-manage-user`** (source
  `ai/openclaw/bin/openclaw-manage-user`, installed by `install.sh`) is the
  **only** component that runs as root for lifecycle changes:
  - `add <user> <uid> <role> [payload.json]` — Linux user/group, home + Samba
    private folder + password-sync queue, self-wake sudoers, runtime dir,
    per-agent files, doc symlinks to the validated active OpenClaw worktree,
    gateway + PM-channel install, and the registry entry. PM add/edit payloads
    include a validated `repoRoot` under
    `/srv/Code/environment.worktrees/<name>` so the helper does not stage
    lifecycle changes through `/srv/Code/environment`. Without a payload, `add`
    only creates the system-user skeleton (used by the sandbox test).
  - `update <user> <payload.json>` — re-render files + registry for an existing
    agent; reinstalls the gateway only when the role changed (never destroys the
    home directory).
  - `delete <user>` — terminate sessions, `userdel -r`, remove
    Samba/sudoers/runtime state and the registry entry, then reconcile via
    `install.sh`.
- **Privilege model.** The monitor sudoers fragment
  (`/etc/sudoers.d/<monitor-agent>-openclaw-control`, regenerated by the helper)
  grants `monitor-agent` NOPASSWD on `openclaw-manage-user *` and `install.sh` —
  used by `openclaw-agent-runner`, **not** by the hardened web service. The spool
  dir is owned by the monitor user (`0700`), so both the web app and the runner
  (same user) can use it without widening any other access.
  `agent-dashboard.service` is **read-only** with respect to the registry — it
  watches `agents.json` and re-broadcasts changes over SSE, but no longer
  mutates it.
- **Model providers.** The form selects one or more providers — **OpenAI Codex**,
  **Claude CLI** (openclaw provider `anthropic`, `api: claude-cli` OAuth),
  **Ollama**, **OpenRouter** (`api: openai-completions` against the
  OpenRouter OpenAI-compatible endpoint) — catalogued in
  `ai/web/lib/agents/providers.ts`. The "Refresh" action lists each provider's
  live models (Ollama `/api/tags` + popular, OpenRouter `/api/v1/models`
  free/popular, Anthropic if keyed, Codex curated); the admin ticks which models
  the agent may use, picks a default, and drag-orders fallbacks. Only the chosen
  providers/models are written to the agent's `openclaw.json`. Per-agent model
  effort is stored as registry field `thinking` and rendered as OpenClaw
  `agents.defaults.thinkingDefault`; it is distinct from `reasoning`, which
  controls reasoning-output visibility. Agent edits preserve that host policy.
  (`google-gravity` was retired.)
- **Profile images.** The Add Agent form stores a `profileImages.theme` in the
  registry entry. `Manually Uploaded` enables authenticated upload/remove
  controls on the agent profile page for
  `/srv/agents/Pictures/<Username>/{profile,avatar}.png`; other themes queue a
  PM-channel request to the first active agent with an OpenAI/Codex/ChatGPT
  model to generate a photoreal profile image plus plush avatar. The helper
  creates `/srv/agents/Pictures/<Username>` with `code-agents` group-write
  permissions.
- **Telegram & server mail.** Enabling Telegram captures the bot token, written
  by the helper to `~/.config/openclaw/telegram-token` + `TELEGRAM_BOT_TOKEN`
  (pair via DM afterwards). The `maildir` integration provisions
  `~/Maildir/{new,cur,tmp}` + `~/.openclaw/mail` — the MTA (Postfix/Dovecot) and
  `openclaw-mail-listener` remain host prerequisites (present on yoga510, not thinkpad).
- **Guards.** Protected accounts (`root`, `zeh`, the monitor, system users,
  `code-agents`) cannot be added, edited, or removed from this surface —
  enforced in both the route and the helper. A failed create is rolled back
  (the helper's `delete` is invoked).
- **Ports.** PM treats each OpenClaw gateway as a two-port allocation:
  `gatewayPort` plus the browser/control sidecar at `gatewayPort + 2`. The
  allocator rejects ports already reserved in the registry and actively probes
  both `127.0.0.1` and `::1` before the helper writes the registry. If no pair
  is available, add/edit returns `port_allocation_failed`.
- **Managed browser runtime.** All enabled agents use the system Chromium at
  `/usr/bin/chromium`, headless by default with the Chromium sandbox retained.
  Agent creation/edit renders that policy into `openclaw.json`; `install.sh`
  also reconciles existing agents. Each Linux user owns an independent
  `~/.openclaw/browser/openclaw/user-data` profile. A browser/control sidecar is
  not itself a browser binary and another agent's Playwright cache/profile must
  never be reused.
- **Gateway verification.** The PM-channel installer restarts
  `openclaw-gateway.service` after lifecycle changes and waits for systemd to
  report `active`; a failed restart fails the provisioning request instead of
  silently leaving the agent unreachable.
- **Sandbox test.** `scripts/test-user-lifecycle.sh` exercises the helper's
  validation + add/delete in a `/tmp` sandbox (`OPENCLAW_SANDBOX_TESTING=true`)
  without touching the live system.

### Compact PM task runtime

Enabled on thinkpad on **2026-09-08** with PM channel plugin **0.1.2** on all
enabled agents and `PM_TASK_RUNTIME_V2=1` in both the website and consumer.
Native task tools remove per-turn HTTP/credential reconstruction; the compact
snapshot and durable checkpoint carry current task context. Planning/review
sessions persist, while execution episodes own bounded work and handoffs.

Both `/etc/default/pm` and `/etc/default/pm-active-worktree` retain the enabled
flag. `openclaw-doc-sync` propagates the deployed startup/workflow instructions.
All four gateways advertised runtime version 1 and 15 native PM tools after
restart; tool availability still depends on the recipient's task role. Coding
task notifications without a required review attachment use the compact path;
other surfaces retain their existing contracts. See
[runtime configuration and rollback](web/docs/pm-task-runtime.md).

### Replicating agent lifecycle management on another host

Everything needed to stand the feature up on a fresh server. Adjust the
path/identity constants below if your host doesn't use the `thinkpad` layout.

**1. Packages / binaries** (must resolve on `root`'s `PATH` and under sudo's
`secure_path`):

- `jq` (helper parses the JSON payload + registry with it)
- `nodejs` — the helper resolves it via `command -v node`; also runs the PM
  webapp and the PM-channel installer
- `chromium` — system-maintained browser at `/usr/bin/chromium`; required for
  every agent's local managed browser session
- the `openclaw` CLI at `/usr/local/bin/openclaw` (gateway install)
- `useradd`/`groupadd`/`userdel`, `passwd`, `loginctl`, `visudo`
- Samba + the password-sync hooks (see the root [`README.md`](../README.md) §
  *Samba Password Sync*) for SMB access to provisioned users

**2. Groups & service identity:**

- A shared `code-agents` group (`OPENCLAW_SHARED_GROUP`); the PM webapp's run
  user (the **monitor** agent) must be a member.
- `pm.service` runs as that monitor user, bound to `127.0.0.1:3000`. The route
  layer shells out to the helper as this user, so it needs the sudoers grant
  below.

**3. Filesystem prerequisites:**

- Registry: `/etc/openclaw/agents.json` (`{ "version": 1, "codeOwner": "<owner>",
  "agents": [] }`). Historical installs may symlink it to
  `/srv/agents/index.json`. Root-writable (the helper owns lifecycle writes).
  PM reads it via `AGENT_INDEX_PATH` (defaults `/etc/openclaw/agents.json`).
- Runtime root: `/srv/agents/openclaw/` (group `code-agents`), containing
  `_shared/USER.md` — the shared file every agent's `USER.md` symlinks to.
- Optional profile images: `/srv/agents/Pictures/<Capitalised-user>/profile.png`
  and `/srv/agents/Pictures/<Capitalised-user>/avatar.png`; parent and
  per-agent directories should be group-writable by `code-agents`.
- Repo checkouts under `/srv/Code/environment.worktrees/<name>` for PM/OpenClaw
  changes. The primary `/srv/Code/environment` checkout is a stable base and
  must not be edited for lifecycle changes. PM add/edit sends the active
  worktree as `repoRoot`, so doc symlinks and PM-channel scripts resolve
  against the deployed worktree.
- Samba share root `/srv/samba/shared` and the password-sync queue dir.

**4. Install + sudoers wiring:**

- `ai/openclaw/install.sh` copies `ai/openclaw/bin/openclaw-manage-user` →
  `/usr/local/sbin/openclaw-manage-user` (`0755`) and adds
  `/srv/agents/openclaw` plus `/srv/agents/Pictures` to `pm.service`'s
  `ReadWritePaths`.
- The monitor sudoers fragment (`/etc/sudoers.d/<monitor>-openclaw-control`)
  grants the monitor user NOPASSWD on `openclaw-manage-user *` and `install.sh`.
  The helper **regenerates** this file on every `add`/`update`/`delete`, but
  `install.sh` does **not** lay it down automatically (sudoers are
  hand-reviewed). **Bootstrap** on a new host by running the first `add` once
  as root (which writes the registry skeleton + regenerates the monitor
  sudoers); after that the PM web layer can drive it via sudo.

**5. Host-specific constants.** The helper reads these from the environment
(set them in the unit or a drop-in if your layout differs):

| Variable | Default |
|---|---|
| `OPENCLAW_AGENTS_JSON` | `/etc/openclaw/agents.json` |
| `OPENCLAW_SUDOERS_D` | `/etc/sudoers.d` |
| `OPENCLAW_SHARED_GROUP` | `code-agents` |
| `OPENCLAW_SAMBA_SHARED_ROOT` | `/srv/samba/shared` |
| `OPENCLAW_SAMBA_PASSWORD_SYNC_DIR` | `/tmp/samba-password-sync` |
| `OPENCLAW_REPO_ROOT` | `/srv/Code/environment` for legacy/manual helper calls; PM add/edit overrides it with the active `/srv/Code/environment.worktrees/<name>` payload `repoRoot` |
| `AGENT_INDEX_PATH` (PM web) | `/etc/openclaw/agents.json` |

These are **hardcoded in source** and require an edit to relocate: the
`REPO_ROOT` validation regex accepts `/srv/Code/environment` and
`/srv/Code/environment.worktrees/<name>`, and the runtime dir remains
`/srv/agents/openclaw/<user>` (`ai/openclaw/bin/openclaw-manage-user`); the
gateway base port `18789`, UID floor `1001`, home base `/home/<user>`, and the
avatar path (`ai/web/lib/agents/provisioning.ts`).

**6. Verify:**

```bash
# Helper validation + add/delete in a throwaway sandbox (no real changes):
sudo scripts/test-user-lifecycle.sh

# Then create + remove a real agent from the PM webapp Agents page, and confirm
# the registry, the per-user gateway service, and the audit row all appear.
```

## Monitor Agent Full Service Set

The monitor agent (e.g. `karen` on thinkpad) is not just a triage/alert agent —
she is the **service identity** behind the entire PM webapp, the webhook
receivers, the worktree switcher, the branch verifier, and the
agent-provisioning runner. Replicating the monitor on another host
requires every service below to be installed and enabled.

### System services running as the monitor user

| Service | Source in repo | Purpose |
|---|---|---|
| `pm.service` | `ai/web/deploy/pm.service` (rendered by `install.sh`) | The PM webapp (Next.js standalone, `agents.vixi.au`) |
| `pm-consumer.service` | `ai/web/deploy/pm-consumer.service` (rendered by `install.sh`) | PM event consumer — drains `/var/lib/pm/drop` and wakes agent gateways |
| `pm-switch-runner.service` | `ai/web/deploy/systemd/pm-switch-runner.service` (installed by `install-pm-switch.sh`) | Worktree switch runner — builds a chosen worktree and flips `pm.service` |
| `pm-verify-runner.service` | `ai/web/deploy/systemd/pm-verify-runner.service` (installed by `install-pm-verify.sh`) | Branch-verify runner — verifies repo state before waking reviewer |
| `pm-epic-merge-runner.service` | `ai/web/deploy/systemd/pm-epic-merge-runner.service` (installed by `install-pm-verify.sh`) | Repository runner — provisions/validates task worktrees on Action Plan approval and integrates/finalizes Epic branches |
| `openclaw-agent-runner.service` | `ai/openclaw/systemd/openclaw-agent-runner.service` (rendered by `install.sh`) | Agent provisioning runner — runs privileged `openclaw-manage-user` |

### Monitor per-user services

| Service | Source in repo | Purpose |
|---|---|---|
| `openclaw-gateway.service` | OpenClaw runtime (gateway install) | Monitor agent's own OpenClaw gateway (loopback port) |
| `openclaw-jira-receiver.service` | `ai/openclaw/systemd/user/openclaw-jira-receiver.service` | Inbound Jira webhook receiver |
| `openclaw-bitbucket-receiver.service` | `ai/openclaw/systemd/user/openclaw-bitbucket-receiver.service` | Inbound Bitbucket webhook receiver |

### Root system services the monitor depends on

| Service | Source in repo | Purpose |
|---|---|---|
| `agent-dashboard.service` | `ai/openclaw/systemd/agent-dashboard.service` | Real-time dashboard backend (port 3013) |
| `ai-monitor.service` + `ai-monitor.timer` | `ai/openclaw/systemd/ai-monitor.{service,timer}` | AI judgment layer — runs every 2 min |
| `openclaw-integrity.service` + `openclaw-integrity.timer` | `ai/openclaw/systemd/openclaw-integrity.{service,timer}` | Integrity check — runs every 2 min |
| `openclaw-backup.service` + `openclaw-backup.timer` | `ai/openclaw/systemd/openclaw-backup.{service,timer}` | Daily state backup at 04:20 |
| `openclaw-typing-keepalive.service` | `ai/openclaw/systemd/openclaw-typing-keepalive.service` | Telegram typing sidecar for `claude-cli` agents |
| `openclaw-monitor-sync.{service,timer,path}` | `ai/openclaw/systemd/openclaw-monitor-sync.{service,timer,path.in}` | Per-agent project-resource reconciliation |
| `gmail-watch-renew.{service,timer}` | `ai/openclaw/systemd/gmail-watch-renew.{service,timer}` | Daily Gmail watch renewal (04:00) |

### Sudoers files

| File | Source | Generated? |
|---|---|---|
| `<monitor>-openclaw-control` | `ai/openclaw/sudoers.d/monitor-openclaw-control.in` (reference) | Yes — by `openclaw-manage-user::regenerate_monitor_sudoers` from registry + `$REPO_ROOT` |
| `openclaw-wake-<coding-user>` (one per coding agent) | `ai/openclaw/sudoers.d/openclaw-mail-self-wake.in` (reference) | Yes — by `openclaw-manage-user` step 5 during `add`/`update` |
| `pm-switch` | `ai/web/deploy/sudoers.d/pm-switch` (installed by `install-pm-switch.sh`) | No (static, templated by installer) |
| `pm-monitor-wake-agent` | `ai/openclaw/sudoers.d/pm-monitor-wake-agent` (reference) | No (static, hand-installed) |
| `openclaw-agent-anotheragent` | `ai/openclaw/sudoers.d/openclaw-agent-anotheragent` (reference) | No (static, hand-installed) |

### Config and state files

| Path | Source | Notes |
|---|---|---|
| `/etc/openclaw/agents.json` | `ai/openclaw/index.example.json` (template) | Live registry, NOT in repo. `openclaw-manage-user` writes lifecycle changes. |
| `/etc/openclaw/agent-defaults.json` | `ai/openclaw/agent-defaults.json` | Symlinked to `/etc/openclaw/`. |
| `/etc/ai-monitor/config.json` | `ai/openclaw/config/ai-monitor.config.json.example` | Host-specific; copy template and fill. |
| `/var/lib/ai-monitor/mode.json` | managed by `/usr/local/sbin/ai-monitor-mode` | Durable `active` / `observe-only` switch for controlled deployments. Observe-only preserves probes and logs without interventions. |
| `/etc/agent-dashboard/config.json` | `ai/openclaw/config/agent-dashboard.config.json.example` | Host-specific; copy template and fill. |
| `/etc/default/pm` | `ai/web/deploy/pm.env.example` | Host-specific env; copy and edit. |
| `/etc/default/pm-active-worktree` | Generated by `pm-switch` | Active worktree DB URL override. |
| `/etc/openclaw/pm-consumer-tokens.json` | Generated by `install.sh` | Per-agent `/hooks/wake` Bearer map. |
| `/etc/openclaw/pm-channel-tokens.json` | Generated by `install.sh` | Per-agent native PM channel Bearer map. |
| `/srv/agents/openclaw/<monitor>/openclaw.json` | Rendered by `openclaw-manage-user` | Monitor agent's OpenClaw runtime config. |
| `/etc/tlp.d/30-charge-thresholds.conf` | `ai/host/tlp/30-charge-thresholds.conf` | ThinkPad AMD power policy and charge thresholds. |
| `/etc/logrotate.d/nginx` | `ai/host/logrotate/nginx` | Host-specific nginx log ownership policy. |
| `/etc/systemd/system/nginx.service.d/10-runtime-paths.conf` | `ai/host/systemd/nginx.service.d/10-runtime-paths.conf` | Reconciles nginx request/proxy spool ownership before each service start. |
| `/etc/systemd/system/zypper-dup.{service,timer}` | `ai/host/systemd/zypper-dup.{service,timer}` | Weekly Tumbleweed rolling update. |
| `/etc/tmpfiles.d/fs-tmp.conf` | `ai/host/tmpfiles/fs-tmp.conf` | Three-day retention for RAM-backed `/tmp`. |
| `/etc/systemd/user/openclaw-gateway.service.d/30-memory-policy.conf` | `ai/host/systemd/user/openclaw-gateway.service.d/30-memory-policy.conf` | Shared per-gateway memory limits (8G high / 10G max / no swap) + Node heap cap. |
| `/etc/systemd/system/user@<uid>.service.d/80-openclaw-resource-controllers.conf` | `ai/host/systemd/user-manager/80-openclaw-resource-controllers.conf` | Per-agent memory-controller delegation. |
| `/etc/kernel/cmdline` option `psi=1` | `ai/host/kernel/required-cmdline` (merged by installer) | Kernel pressure telemetry after reboot. |

### Monitor home directory layout

```
/home/<monitor>/
├── .openclaw/
│   ├── workspace/          # agent-facing docs (copied by openclaw-manage-user)
│   │   ├── AGENTS.md
│   │   ├── WORKFLOW.md
│   │   ├── ROLES.md
│   │   ├── CODE_REPOS.md
│   │   ├── USER.md
│   │   ├── INCIDENT_HANDLING.md  # monitor-only
│   │   ├── MONITORING.md        # monitor-only
│   │   └── SERVICES.md          # monitor-only
│   ├── agents/main/        # OpenClaw session state
│   └── skills/             # symlinked skill helpers
├── webhooks/               # symlinked webhook receiver scripts
│   ├── jira-receiver.js -> <repo>/ai/openclaw/webhooks/jira-receiver.js
│   ├── bitbucket-receiver.js -> <repo>/ai/openclaw/webhooks/bitbucket-receiver.js
│   └── common.js -> <repo>/ai/openclaw/webhooks/common.js
└── .config/openclaw/       # OpenClaw config (telegram-token, secrets)
```

### Replication checklist for the monitor agent

To bring up the monitor on a fresh host:

1. **Packages**: `jq`, `nodejs`, `chromium`, `openclaw` CLI, `useradd`/`groupadd`,
   Samba + password-sync hooks, `sqlite3` (for PM).
2. **Groups**: shared `code-agents` group; monitor user must be a member.
3. **Registry**: create `/etc/openclaw/agents.json` from `index.example.json`,
   add the monitor entry (`role: monitor`).
4. **Install scripts**: `sudo OPENCLAW_REPO_ROOT=<checkout> ai/openclaw/install.sh`
   — installs bin scripts, system units (including the 3 timer pairs), user
   units, generates `openclaw-monitor-sync.path`, reconciles PM services.
5. **Sudoers**: run `openclaw-manage-user add <monitor> <uid> monitor` once
   as root — generates `/etc/sudoers.d/<monitor>-openclaw-control`. Hand-install
   `pm-monitor-wake-agent` + `openclaw-agent-anotheragent` if needed. Validate
   with `visudo -c`.
6. **PM webapp**: `cd <checkout>/ai/web && pnpm install && pnpm build && pnpm prisma migrate deploy`,
   then `sudo PM_WEB_ROOT=<checkout>/ai/web <checkout>/ai/openclaw/install.sh`
   to render + install `pm.service` + `pm-consumer.service` + PM channel.
7. **PM switcher + verifier**: `sudo PM_MONITOR_USER=<monitor> ai/web/deploy/install-pm-switch.sh`
   and `sudo PM_MONITOR_USER=<monitor> PM_VERIFY_RUN_USER=<repo-fetch-user> ai/web/deploy/install-pm-verify.sh`.
8. **Config files**: copy `ai/openclaw/config/ai-monitor.config.json.example`
   → `/etc/ai-monitor/config.json` and fill host values. Copy
   `ai/web/deploy/pm.env.example` → `/etc/default/pm` and edit.
9. **Enable timers**: `sudo systemctl enable --now ai-monitor.timer
   openclaw-integrity.timer openclaw-backup.timer openclaw-monitor-sync.path
   openclaw-monitor-sync.timer gmail-watch-renew.timer`.
10. **Enable services**: `sudo systemctl enable --now agent-dashboard.service
    openclaw-typing-keepalive.service pm.service pm-consumer.service
    openclaw-agent-runner.service pm-switch-runner.service pm-verify-runner.service`.
11. **Webhook receivers**: enabled by `install.sh` step 7 reconcile based on
    the monitor agent's registry role.
12. **Verify**: `openclaw-registry-check --runtime`, `openclaw-integrity-check`,
    `ai-monitor --probe-only`, `openclaw-boot-readiness`, then run
    `sudo -u <agent> env HOME=/home/<agent> openclaw browser doctor --deep` for
    each enabled registry agent.

## Gmail and Google Watchers

Host `thinkpad` uses Google Workspace/Gmail watchers rather than local Maildir. Gmail polling runs per coding agent to preserve security isolation and prevent mailbox confusion:

- **Listener Service**: `openclaw-gmail-listener.service` is enabled for each coding agent user.
- **Pub/Sub Subscriptions**:
  - per coding agent: `gmail-inbox-watch-<coding-agent>-sub`
- **Shared Topic**: Both subscriptions attach to the shared GCP Pub/Sub topic `projects/<gcp-project>/topics/gmail-inbox-watch`.
- **Ingestion & Wake**:
  - The push listener script (`gmail-push-worker.js`) fetches messages when notified, writes events to `~/.openclaw/mail/events.jsonl`, marks the email as read immediately, and wakes the agent via:
    ```bash
    sudo -n /usr/local/sbin/openclaw-control wake-agent <self>
    ```
- **Sudoers**: `/etc/sudoers.d/openclaw-mail-self-wake` gives coding agents permissions to run only their own `wake-agent` commands without a password.

## Models and Providers

As of May 2026, host `thinkpad` relies dynamically on **OpenAI OAuth**, **Claude CLI**, and **Ollama** (running locally on `thinkpad` and bridging `:cloud` models to `https://ollama.com` for the agents) to provision the models in use. Model configurations and fallback paths are managed dynamically per-user in each agent's private `~/.openclaw/openclaw.json` configuration file rather than being hardcoded in central host documentation.

- **Ollama endpoint**: each agent's `models.providers.ollama.baseUrl` points at `http://127.0.0.1:11434` — the local Ollama on `thinkpad` (managed by `ollama.service`, `OLLAMA_HOST=0.0.0.0:11434`). The previous `http://ollama.local` indirection through `moonlight` is **deprecated** — moonlight's nginx upstream pointed at `10.0.0.17` (a different LAN host) which doesn't actually serve the agents' `:cloud` models, so requests were either silently mis-routed or going to thinkpad's local Ollama anyway. Agents now hit the local instance directly.
- **Local Fallback Model**: `qwen2.5:3b-instruct` (~2 GB q4_K_M) is installed locally on the `thinkpad` CPU as a last-resort offline fallback.

### Login renewal (who renews what)

Model logins renew themselves: each owner refreshes its short-lived access
token on next use. There is deliberately **no** separate renewal script or
timer — OpenAI and Claude refresh tokens rotate on every refresh, so a second
refresher invalidates the login (barekbaal's copied OpenAI profile logged
`refresh_token_reused` this way in 2026-09).

| Login | Owner / file | Human action needed when |
|---|---|---|
| Claude CLI (`anthropic/*` on the `claude-cli` runtime) | `~/.claude/.credentials.json` | Refresh token nears its recorded expiry (warned 7 days ahead) or a refresh fails. |
| Codex CLI (`openai/*` when `plugins.entries.codex.config.appServer.homeScope` is `user`) | `~/.codex/auth.json` | A refresh fails. `openclaw models status` still names the OpenClaw store as the route; with `homeScope: user` it is not. |
| OpenClaw OAuth profile | `~/.openclaw/state/openclaw.sqlite` (`authProfiles.store`) | The profile has no refresh token, or a refresh fails. |

`openclaw-integrity-check` reports these as `model-auth <provider>` lines:
renewability of the active chain's logins plus authentication failures from
any gateway consumer in the last 15 minutes (model fallbacks, memory sync).
`ai-monitor` routes them deterministically — not through its LLM judge and not
through the monitor agent — and sends one Telegram per episode with the fix
command (`model_auth_renotify_s`, default 6 h, quiets recurrences).

## Telegram

Each agent is integrated with a dedicated Telegram bot:

- **Bots**:
  - `coding-agent`: `<telegram-bot-for-coding-agent>`
  - `monitor-agent`: `<telegram-bot-for-monitor-agent>`
- **Config**: Configured under a single top-level `channels.telegram` object with `enabled: true`, `dmPolicy: "pairing"`, `groupPolicy: "allowlist"`, and `streaming.mode: "partial"`.
- **Tokens**: Token files are owned by their respective users, set to mode `0600`, and stored at `/home/<user>/.config/openclaw/telegram-token`.

## Jira and Webhooks

Jira routing uses a central monitor-owned webhook dispatcher:

- **Receivers**: `/home/<monitor-agent>/webhooks/jira-receiver.js` (port `3014`) and `/home/<monitor-agent>/webhooks/bitbucket-receiver.js` (port `3015`), running under the monitor-agent user.
- **Routing Rules**: Derived from `/etc/openclaw/agents.json`. Webhooks route
  only to enabled coding agents with the matching integration enabled, using
  `jira_account_id` for Jira @-mentions.
- **Wake Action**: Incoming events queue a task inside `/home/<user>/tasks/current.md` and trigger a wake via:
  ```bash
  sudo /usr/local/sbin/openclaw-control wake-agent <agent-user>
  ```
- **Sudoers**: `/etc/sudoers.d/<monitor-agent>-openclaw-control` allows the monitor-agent user to execute `openclaw-control` commands (`restart-services`, `wake-agent`, `restart-and-wake`) for target coding agents.
- **Pending Mention Queue**: `/var/lib/ai-monitor/pending-mentions/` tracks unresolved mentions that are periodically audited by `ai-monitor`.

## Services

### Per-User Services

| User | Unit File | Port | Purpose |
|---|---|---|---|
| coding-agent | `openclaw-gateway.service` | `<gateway-port>` | OpenClaw runtime gateway |
| | `openclaw-gmail-listener.service` | | Gmail watcher |
| monitor-agent | `openclaw-gateway.service` | `18793` | OpenClaw runtime gateway |
| | `openclaw-jira-receiver.service` | `3014` | Inbound Jira webhook receiver |
| | `openclaw-bitbucket-receiver.service` | `3015` | Inbound Bitbucket webhook receiver |

### Host Services

| Service | Port | Run User | Purpose |
|---|---|---|---|
| `pm.service` | `3000` | `monitor-agent` | Standalone Next.js web application (Mission Control) |
| `pm-consumer.service` | | `monitor-agent` | Queue consumer triggering loopback wake events |
| `pm-switch-runner.service` | | `monitor-agent` | Builds a chosen worktree and flips which one `pm.service` serves (monitor-driven live preview); decoupled from `pm.service`. Drives the per-project "Worktree live preview" panel. |
| `pm-verify-runner.service` | | `monitor-agent` | Watches `/var/lib/pm/branch-verify/` for jobs dropped by the PM workflow endpoint on `ready_for_review` (when the task touched the repo), fetches `origin/main` plus the task branch, verifies the task branch contains the current `origin/main`, then runs `git log` and posts a `pm.repo.verify.{ok,fail}` task comment so the reviewer sees whether `origin/<branch>` reflects the work. Decoupled from `pm.service`. |
| `pm-epic-merge-runner.service` | | repo-push user | Unsandboxed repository runner. Creates and validates the exact linked task worktree on Action Plan approval, reuses the same spool for local Epic-child merge/finalization, and returns `worktreePath` to PM. |
| `openclaw-agent-runner.service` | | `monitor-agent` | Deterministic agent provisioning executor: watches `/var/lib/pm/agent-provision/`, runs `sudo openclaw-manage-user` for the web app's add/edit/remove (pm.service can't sudo). `NoNewPrivileges=no`. |
| `agent-dashboard.service` | `3013` | `root` | System activity dashboard (HTTP + SSE) |
| `openclaw-typing-keepalive.service` | | `root` | Telegram typing status manager |
| `openclaw-monitor-sync.path` | | `root` | Watches for per-agent `monitor.json` edits |
| `openclaw-monitor-sync.timer` | | `root` | Regular sync check for per-agent `monitor.json` |
| `openclaw-integrity.timer` | | `root` | Regular OpenClaw health validation check |
| `ai-monitor.timer` | | `root` | Runs the AI triage/escalation monitor (every 2m) |
| `openclaw-backup.timer` | | `root` | Daily local critical state backups |

## Validation

Verify host health and agent status using these tools:

```bash
# Check registry configuration validity
/usr/local/bin/openclaw-registry-check --runtime

# Check OpenClaw health
/usr/local/bin/openclaw-integrity-check

# Full boot readiness check
/usr/local/bin/openclaw-boot-readiness
```

## Rotating agent models

Use the PM agent Models tab or the two-argument
[`rotate-agent-model.sh`](web/scripts/rotate-agent-model.sh) command. Both share
provider-specific fallback rotation and guard against stale configurations and
active PM work. See the [model upgrade runbook](web/docs/agent-model-upgrades.md).

## OpenClaw runtime upgrade (2026-09-10)

All four agent gateways use OpenClaw 2026.9.3. Asdrubal uses the separately
managed Codex plugin 2026.9.3 (bundled Codex 0.153.4); the host CLI is 0.154.0.
Keep both layers current. See the [upgrade audit and recovery procedure](web/docs/audits/openclaw-openai-upgrade-2026-09-10.md) for the OAuth routing repair,
SQLite migration backups, plugin verification, and PM schema compatibility.
