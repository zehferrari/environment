# Environment

Unified settings and documentation for the hosts in this network. One folder per host or host role:

| Folder | Subject |
|---|---|
| [`ai/`](./ai) | OpenClaw multi-agent stack on **thinkpad** — host doc + shared agent docs/skills + dashboard frontend |
| [`ha/`](./ha) | Home Assistant configuration (hostname `homeassistant`) |
| [`p16s/`](./p16s) | Hyprland/Wayland desktop config for the **thinkpad** AI host (Lenovo P16s Gen 2) |
| [`zeus/`](./zeus) | Hyprland/Wayland desktop config for the **fedora** workstation |

Host inventory below covers the networked roles (where they live, what they do); per-host deep docs live in the folders above.

## Document index

Every Markdown doc in the tree, grouped by folder. Agent-facing files (copied into each agent's workspace by `openclaw-manage-user`) are marked **(agent-facing)** — edits to those reach running agents on the next worktree reconcile, so change them with care.

### Root

| File | Purpose |
|---|---|
| [`README.md`](./README.md) | This file. Network host inventory, deployment model, branch workflow. `CLAUDE.md` and `AGENTS.md` are symlinks to it. |

### `ai/` — thinkpad host + agent runtime

| File | Purpose |
|---|---|
| [`ai/README.md`](./ai/README.md) | thinkpad host doc: identity, disk, network, power, web/DB stack, Hyprland, OpenClaw architecture, Gmail automation, Ollama, monitoring/recovery, dashboard, yoga510 duplication guide. |
| [`ai/THINKPAD.md`](./ai/THINKPAD.md) | thinkpad OpenClaw agents: runtime layout, agent lifecycle management, Gmail/Google watchers, models/providers, Jira/webhooks, services, validation, monitor-agent replication runbook. |
| [`ai/CHANGELOG.md`](./ai/CHANGELOG.md) | Historical change notes for the thinkpad stack (dated 2026-05-08 → 2026-05-20). Frozen as-of each date. |
| [`ai/host/README.md`](./ai/host/README.md) | Repo-managed thinkpad OS configuration: power policy, memory/PSI safeguards, temporary-file retention, nginx log rotation, and Tumbleweed updates. |

### `ai/openclaw/` — shared agent operating rules + skills

| File | Copied to agents? | Purpose |
|---|---|---|
| [`AGENTS.md`](./ai/openclaw/AGENTS.md) | **Yes (all)** | Operating baseline every agent reads: always-on rules, PM context, session/heartbeat/memory/tools. |
| [`ROLES.md`](./ai/openclaw/guides/ROLES.md) | **Yes (all)** | Task-role behaviour (manager/coordinator, implementer, monitor). |
| [`WORKFLOW.md`](./ai/openclaw/WORKFLOW.md) | **Yes (all)** | Action-indexed playbook: outbound, mentions, next-task, working/reviewing, email, Telegram, escalation. |
| [`CODE_REPOS.md`](./ai/openclaw/guides/CODE_REPOS.md) | **Yes (all)** | Shared `/srv/Code` checkout mechanics, `claim-branch`, git identity, PR boundary. |
| [`USER.md`](./ai/openclaw/USER.md) | **Yes (all)** | About the human operator (Zeh). |
| [`INCIDENT_HANDLING.md`](./ai/openclaw/guides/INCIDENT_HANDLING.md) | **Yes (monitor)** | The monitor agent's incident triage protocol: tier framework, action playbook by kind. |
| [`MONITORING.md`](./ai/openclaw/guides/MONITORING.md) | **Yes (monitor)** | Monitoring topology: what gets watched, registry-driven probes, tier framework, dashboard. |
| [`SERVICES.md`](./ai/openclaw/guides/SERVICES.md) | **Yes (monitor)** | Service catalog: system timers, system/user services, operational commands. |
| `ENVIRONMENT.md` | No | "Where things live" map + policy. |
| `AGENT_FILES.md` | No | Per-agent unique files (not in repo) and what each is for. |
| [`JIRA.md`](./ai/openclaw/guides/JIRA.md) | No | Jira-specific workflow (comments, mentions, queue, assignment, working a ticket). |
| [`BITBUCKET.md`](./ai/openclaw/guides/BITBUCKET.md) | No | Bitbucket-specific workflow (branches, commits, Smart Commits, review, PR boundary). |
| [`MISSION_CONTROL.md`](./ai/openclaw/guides/MISSION_CONTROL.md) | No | Mission Control / `ai/web` PM **interface guide** (routes, tabs, fields, agent runtime contract). Workflow behaviour is in `WORKFLOW.md`. |
| `YOGA510.md` | No | yoga510 agent host install notes. |
| `README.md` | No | Folder overview, layout, editing/host-install notes. |
| `install.sh` | No | Host bootstrap/reconcile script for OpenClaw services + PM hooks. |
| `agent-defaults.json` | No | Derived service/capability defaults schema (`core`/`byRole`/`byIntegration`). |
| `index.example.json` | No | Single-record agent registry template. |

### `ai/web/` — PM webapp (Mission Control)

| File | Purpose |
|---|---|
| [`ai/web/README.md`](./ai/web/README.md) | PM workspace: stack, routes, library layout, agent fleet, capability map, agent runtime contract, schema, env vars, deployment. |
| [`ai/web/deploy/README.md`](./ai/web/deploy/README.md) | PM deployment notes: files, worktree switcher, branch verifier, service model, first-time install. |
| [`ai/web/deploy/MULTI_AGENT_WORKTREES.md`](./ai/web/deploy/MULTI_AGENT_WORKTREES.md) | Multi-agent worktree + monitor-driven live-preview design. |
| `ai/web/docs/agent-pm-api.md` | Agent-facing PM read API reference (on-demand; native task turns carry their operating contract). |
| [`ai/web/docs/task-thinking.md`](./ai/web/docs/task-thinking.md) | Task Thinking history, explicit concise notes, provider contracts, access and deployment. |
| [`ai/web/docs/pm-task-runtime.md`](./ai/web/docs/pm-task-runtime.md) | Compact task runtime: active thinkpad configuration, native tools, session budgets, measurements and rollback. |
| [`ai/web/docs/agent-model-upgrades.md`](./ai/web/docs/agent-model-upgrades.md) | Model promotion UI/CLI, provider fallback rotation, role-based effort and Ollama mapping limits. |
| [`ai/web/docs/audits/openclaw-openai-upgrade-2026-09-10.md`](./ai/web/docs/audits/openclaw-openai-upgrade-2026-09-10.md) | OpenClaw 2026.9.3 upgrade: Codex dependency, OAuth route, PM compatibility, verified backups and recovery. |
| [`ai/web/docs/audits/pm-autonomy-2026-09-23.md`](./ai/web/docs/audits/pm-autonomy-2026-09-23.md) | Active plan revision, scoped development publication, explicit owner acceptance, durable dispatch and runtime tuning. |
| [`ai/web/docs/audits/v23-43-reviewer-permissions-2026-09-23.md`](./ai/web/docs/audits/v23-43-reviewer-permissions-2026-09-23.md) | Scoped reviewer permission decisions, escalation, single-use checkpoint grants and runtime rollout. |
| [`ai/web/docs/audits/wdt-9-planning-workflow-2026-09-22.md`](./ai/web/docs/audits/wdt-9-planning-workflow-2026-09-22.md) | WDT-9 planning loop, explicit review decisions, revision-scoped delegation, attachments and capacity recovery. |
| [`ai/web/docs/audits/ph-192-contract-blocker-2026-09-14.md`](./ai/web/docs/audits/ph-192-contract-blocker-2026-09-14.md) | PH-192 transaction-ID rejection and deterministic blocker recovery. |
| [`ai/web/docs/audits/ph-193-standalone-publication-2026-09-14.md`](./ai/web/docs/audits/ph-193-standalone-publication-2026-09-14.md) | PH-193 origin-publication recovery and standalone remote-verification checkpoints. |
| [`ai/web/docs/audits/ph-193-preview-stall-2026-09-14.md`](./ai/web/docs/audits/ph-193-preview-stall-2026-09-14.md) | PH-193 preview-access stall, owner-authorized test staging and initial deployment. |
| [`ai/web/docs/audits/pm-channel-admission-2026-09-10.md`](./ai/web/docs/audits/pm-channel-admission-2026-09-10.md) | PH-193 / V23-39: expired HTTP admission, PM ingress regression test and truthful recovery status. |
| [`ai/web/docs/audits/ph-193-reviewer-handoff-2026-09-10.md`](./ai/web/docs/audits/ph-193-reviewer-handoff-2026-09-10.md) | PH-193 reviewer audit: silence conflict, unnecessary wake and terminal model boundary. |
| [`ai/web/docs/audits/v23-38-workflow-2026-09-08.md`](./ai/web/docs/audits/v23-38-workflow-2026-09-08.md) | V23-38 workflow audit, fixes, deployment and runtime activation record. |
| [`ai/web/docs/audits/v23-43-review-findings-2026-09-23.md`](./ai/web/docs/audits/v23-43-review-findings-2026-09-23.md) | Structured review corrections, atomic subtask handoff, evidence and supersession. |
| [`ai/web/docs/audits/editor-save-navigation-2026-09-10.md`](./ai/web/docs/audits/editor-save-navigation-2026-09-10.md) | Task/Epic save, dirty-state and stale-deployment audit; regression checks and limits. |
| `ai/web/docs/agent-interaction.md` | Agent-facing PM interaction contract (chat/comment/proposal). |
| `ai/web/lib/pm-dispatch/README.md` | Dispatch seam emitter side. |
| `ai/web/lib/pm-consumer/README.md` | Consumer/dispatcher (OpenClaw-side) service. |

### Desktop configs

| File | Purpose |
|---|---|
| [`p16s/README.md`](./p16s/README.md) | ThinkPad P16s Gen 2 Hyprland/Wayland config — now the AI host (thinkpad). |
| [`zeus/README.md`](./zeus/README.md) | Fedora workstation Hyprland config + ComfyUI/Confy image service (zeus, `10.0.0.17`). |
| [`ha/README.md`](./ha/README.md) | Home Assistant configuration notes (homeassistant). |

## thinkpad

- Host/IP: `thinkpad`, `10.0.0.105`
- OS: openSUSE Tumbleweed
- Role: OpenClaw multi-agent host, Development playground, local service host.
- Active users and their roles are listed in `/etc/openclaw/agents.json`
  (historically also exposed at `/srv/agents/index.json`). UIDs start at 1001
  for agents.

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
- Bootstrap: users who do not yet exist in Samba should run `passwd` once on `thinkpad`; after that, SMB login uses the same username and password as Linux.
- Verification commands:
  - `sudo /usr/sbin/pam-config --verify`
  - `sudo pdbedit -L`
  - `sudo testparm -s /etc/samba/smb.conf`
  - `systemctl is-active smb nmb sync-samba-password-queue.timer`

## moonlight

- Host/IP: `moonlight`, `10.0.0.10`
- Role: public nginx ingress for `vixi.au` routes.
- Webhook path: `https://dev.vixi.au/webhooks/*` proxies to thinkpad.
- Ollama is also proxied externally through moonlight as documented in root operations notes.

## x1

- Host/IP: `x1`, `10.0.0.108`
- Role: openSUSE Tumbleweed Hyprland/Wayland laptop (zeh's personal laptop).
- Current status: no longer the AI agent host; OpenClaw user services and linger are disabled.
- Desktop config: the x1 Hyprland config was previously documented in `ai/README.md` §9–12 (now applies to thinkpad). For the x1 personal-laptop desktop config, see the historical notes in `ai/README.md` or adapt from the thinkpad/p16s config.

## Working in this repo (humans & AI assistants)

> `CLAUDE.md` and `AGENTS.md` in this directory are symlinks to this file, so
> Claude Code and other agentic CLIs load the same single source of truth. Edit
> `README.md` — never the symlinks — and keep facts here reconciled with the live
> host, not from memory.

This repo is **documentation + config that is applied to live hosts**, not a
buildable product — with one exception, the `ai/web` PM webapp. Read the
deeper docs before acting:

- **thinkpad host + agent runtime:** [`ai/README.md`](./ai), [`ai/THINKPAD.md`](./ai/THINKPAD.md)
- **Agent operating rules (the OpenClaw fleet reads these):**
  [`ai/openclaw/`](./ai/openclaw) — `AGENTS.md`, `guides/ROLES.md`,
  `WORKFLOW.md` (single workflow authority for Jira + PM),
  `guides/CODE_REPOS.md`, `guides/SERVICES.md`, `guides/MONITORING.md`,
  `guides/BITBUCKET.md`, `guides/INCIDENT_HANDLING.md`, `guides/JIRA.md`
  (Jira-specific workflow), `guides/MISSION_CONTROL.md`
  (the `ai/web` PM interface guide).
- **PM webapp deploy:** [`ai/web/deploy/README.md`](./ai/web/deploy/README.md)

### Deployment model

- **`thinkpad` is production.** There is no separate dev tier yet; changes go live on
  `thinkpad`.
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
- **Do not edit or deploy through the primary checkout
  (`/srv/Code/environment/`).** It is the stable base checkout only; all PM and
  OpenClaw changes are made in `/srv/Code/environment.worktrees/<branch>/` and
  promoted with git + `pm-switch`.
- **Build and restart are one step.** `next build` wipes `.next/standalone`; a
  still-running process then serves stale HTML and 404s its own hashed assets.
  Never build without an immediate restart.
- **Prisma migrations are separate** and easy to forget — a `P2022: column does
  not exist` at runtime means the live DB is missing `prisma migrate deploy`.
- **Agents are provisioned from the PM webapp.** The Agents page (admin only)
  drives `/api/agents/{add,edit,remove}`, which delegate every privileged step
  to the root `openclaw-manage-user` helper via tightly-scoped sudo —
  `agent-dashboard` no longer mutates the registry. Full flow, privilege model,
  and a fresh-host replication runbook: [`ai/THINKPAD.md`](./ai/THINKPAD.md) § Agent
  Lifecycle Management and [`ai/web/README.md`](./ai/web/README.md) § Agent
  lifecycle.

### Multi-agent / branch workflow

- Several agents share `/srv/Code` on `thinkpad` (group `code-agents`, setgid + ACLs).
  All commits are attributed to `Zeh Ferrari` by design — `git log` can't tell
  which agent committed.
- The **primary checkout (`/srv/Code/<repo>/`) never carries feature commits.**
  All ticket work happens in per-branch worktrees created with
  **`claim-branch <repo> <branch>`** (one implementer per branch; every new
  branch is created from freshly fetched `origin/main`; Git hooks enforce the
  worktree boundary and block publication of registered local-only Epic-child
  branches). For Mission Control code tasks, Action Plan approval provisions
  and validates that linked worktree through the repository runner; every
  In Progress entry revalidates it. The primary checkout is never the task
  workspace, and ordinary/copied directories under `*.worktrees/` are rejected.
- **Agents never create or merge pull requests — humans (zeh) only.** A
  standalone task ends at "branch pushed, ready for review"; an Epic-child
  task stays local and PM merges it into the Epic branch.
- **Agent-facing docs propagate through the active OpenClaw install:** each
  agent's workspace docs are content copies of `ai/openclaw/*.md` from the
  validated deployed worktree (`openclaw-manage-user` overwrites a copy only
  when content differs). A doc change reaches agents once it lands in git
  and the active PM/OpenClaw worktree is reconciled.
