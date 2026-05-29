# Services

Use `/etc/openclaw/agents.json` for the machine-readable monitoring roster.

## System Timers

- `openclaw-integrity.timer`: runs `/usr/local/bin/openclaw-integrity-check` every 2 minutes.
- `ai-monitor.timer`: runs `/usr/local/bin/ai-monitor` every 2 minutes, offset from integrity. Checks service health, Jira stalls/queues, pending mentions, and Gmail-derived `~/tasks/current.md` items still marked `Status: QUEUED`.
- `openclaw-backup.timer`: runs `/usr/local/bin/openclaw-backup` daily at 04:20 with up to 20 minutes randomized delay for small critical OpenClaw state.
- `zypper-dup.timer`: runs weekly Tumbleweed updates.

x1 uses systemd timers for active automation. Cron references in old migration notes are historical, not the active scheduler.

## System Services

- `ollama.service`: local Ollama API on `0.0.0.0:11434`; firewalld permits raw access only from moonlight (`10.0.0.10`). Agent configs use the moonlight proxy at `http://ollama.local`.
- `nginx.service`: local reverse proxy/static serving on x1.
- `mariadb.service`: local DB.
- `php-fpm.service`: local PHP runtime.
- `agent-dashboard.service`: real-time per-agent dashboard backend on `127.0.0.1:3013` (HTTP + SSE). Front-end at `https://dev.vixi.au/agents.html` behind nginx basic auth.
- `pm.service`: one host-wide PM web app for `agents.vixi.au`, normally
  running as Karen on x1. This is a system unit under
  `/etc/systemd/system` with `User=karen`, not a per-agent user unit. It
  serves the Next.js standalone app, persists PM tasks/comments/chats,
  sends chat/comment turns into each agent's native OpenClaw `pm`
  channel, receives partial reply streams at
  `/api/openclaw/pm-channel/stream`, and persists final replies from
  `/api/openclaw/pm-channel/reply`. Native-channel turns are tracked in
  `PmChannelRun` so browser reconnects use durable accepted/streaming/
  complete/failed state instead of polling. The service needs read access to the
  PM checkout/bundle and write access to `prisma/`, `.data`,
  `/etc/openclaw/pm-agent-credentials`, `/var/lib/pm/drop`,
  `/srv/Data/projects`, and `/srv/samba/shared`.
- `pm-consumer.service`: PM event consumer for non-chat automation. Reads
  `/var/lib/pm/drop` and wakes local agent gateways through `/hooks/wake`
  for assignment/ack-style events. It is also a system unit running as
  Karen on x1. It keeps `ProtectHome=true`; `pnpm` config/cache/home are
  redirected to `/var/lib/pm/pnpm-{home,config,cache}` to avoid probing
  hidden `/home/karen` paths. Stale per-agent user units named
  `pm.service` or `pm-consumer.service` should be removed.
- `pm-switch-runner.service`: monitor-driven worktree switch runner (system
  unit, `User=karen` on x1). Watches `/var/lib/pm/switch/request.json`, builds
  the requested worktree with `pm-switch`, and flips `pm.service` to serve it via
  the root helper `pm-apply-worktree` (one NOPASSWD sudoers rule). Deliberately
  decoupled from `pm.service` so the restart at the end of a switch can't kill
  it. Publishes `state.json` for the project-settings "Worktree live preview"
  panel to poll. Installed by `ai/web/deploy/install-pm-switch.sh`; full design in
  `ai/web/deploy/MULTI_AGENT_WORKTREES.md`.
- `pm-verify-runner.service`: monitor-driven branch verification runner (system
  unit, `User=karen` on x1). Watches `/var/lib/pm/branch-verify/*.json` job
  files dropped by the PM workflow endpoint when an assignee moves a
  code-touching task to Review (with `repoTouched: true`). For each job runs
  `git -C <repositoryPath> fetch origin <branchName>` then `git log
  origin/<branchName>` on the already-cloned local repo, looks for commits
  whose subject starts with the task/epic `commitPrefix`, and writes a Karen-
  authored task `Comment` plus a `pm.repo.verify.ok` or `pm.repo.verify.fail`
  `ActivityLog` row. No sudo / no privileged step — DB writes go through
  `DATABASE_URL` from `/etc/default/pm`. Decoupled from `pm.service` like the
  switch runner. Installed by `ai/web/deploy/install-pm-verify.sh`.
- OpenClaw Control UIs: per-agent gateway dashboards exposed through nginx behind basic auth. x1 exposes primary, secondary, and monitoring gateway dashboards through role-based nginx routes. OpenClaw uses trusted-proxy auth with `X-Forwarded-User` from nginx, so nginx basic auth is the browser login. Gateway ports bind to LAN but remain blocked from direct network access by firewalld. This is an admin surface; do not expose without auth.
  - OpenClaw 2026.5.7 dashboard note: nginx also sends X-OpenClaw-Scopes: operator.admin. Coding agents set gateway.controlUi.dangerouslyDisableDeviceAuth=true so trusted-proxy WebSocket sessions keep operator scope; this depends on nginx basic auth and firewalld remaining in place.
  - No-slash dashboard paths redirect to trailing-slash paths. Do not proxy exact no-slash paths directly, or OpenClaw emits root-relative assets (/assets/...) that 404.
  - Chrome fetches some OpenClaw bootstrap endpoints (control-ui-config.json, manifest.webmanifest, avatar metadata) without Basic auth. nginx leaves only those bootstrap endpoints auth_basic off and forwards trusted admin headers; the dashboard HTML, API, and WebSocket routes remain behind basic auth.
  - The monitoring gateway uses loopback trusted-proxy auth only: gateway.bind=loopback, gateway.trustedProxies=[127.0.0.1, ::1], allowLoopback=true. Previous OPENCLAW_GATEWAY_TOKEN values should be preserved in timestamped backups next to openclaw-secrets.env when migrating.
- Local PM wake hooks: every enabled agent gateway should expose
  `POST /hooks/wake` on its loopback gateway port with a per-agent
  Bearer token for generic PM events. `install.sh` reconciles
  `/srv/agents/openclaw/<agent>/openclaw.json` so
  `gateway.bind="loopback"`, loopback trusted-proxy config, and
  `hooks.enabled=true`, `hooks.path="/hooks"`, and `hooks.token` are
  present, then verifies `/home/<agent>/.openclaw/openclaw.json` is a
  symlink to that canonical file. If a different regular home config
  exists, the installer leaves it in place and warns instead of replacing
  possibly newer runtime settings. It also sets
  `hooks.allowRequestSessionKey=true` and
  `hooks.allowedSessionKeyPrefixes=["hook:","pm:"]`; `hook:` is
  required by OpenClaw when no default hook session key is configured,
  and PM-owned session keys use the `pm:` prefix. Direct chat keeps a
  stable `pm:` key; Discussion, Epic chat, and task-comment turns use
  per-message `pm:` keys derived from the PM binding. It then mirrors
  those tokens into `/etc/openclaw/pm-consumer-tokens.json` for the PM
  consumer. Direct chat, Discussion, Epic chat, and task-comment turns use the
  native `POST /pm-channel/ingest` route instead; `install.sh` stages that
  plugin for every enabled registry agent and mirrors per-agent channel tokens into
  `/etc/openclaw/pm-channel-tokens.json`. Keep both surfaces local; nginx
  should not proxy `/hooks` or `/pm-channel`, and any nginx dashboard
  proxy must use `127.0.0.1:<gateway_port>` as the upstream and block
  prefixed paths such as `/<agent>/hooks` and `/<agent>/pm-channel`.
  Healthy checks are
  `GET /health` → 200, `GET /hooks` → 405, unauthenticated
  `POST /hooks/wake` → 401, authenticated `POST /hooks/wake` → 200, and
  `HEAD /pm-channel/ingest` → 405.
- `openclaw-typing-keepalive.service`: Telegram typing-indicator sidecar for the openclaw `claude-cli` provider (`/usr/local/bin/openclaw-typing-keepalive`). The cli-backend is non-streaming, so openclaw's built-in typing keepalive (60 s TTL refreshed by stream events) lapses mid-turn on long opus runs. This service polls every registered agent's `~/.openclaw/agents/main/sessions/sessions.json` and re-fires `sendChatAction("typing")` every 4 s for any telegram conversation key currently `status=running` on `modelProvider=claude-cli`. Auto-discovers agents from `/etc/openclaw/agents.json`; no per-agent install. Runs as root because each agent's `sessions.json` and `~/.config/openclaw/openclaw-secrets.env` (where `TELEGRAM_BOT_TOKEN` lives) are mode `0600` per-user. Agents on `ollama` / `openai-codex` / other providers are skipped — they emit native streaming events that drive the in-process typing pipeline correctly.
- `gmail-watch-renew.timer` → `gmail-watch-renew.service`: daily (04:00 ±10 min) auto-renewal of every per-agent Gmail push watch. Runs `/usr/local/sbin/gmail-watch-renew-all`, which discovers `/home/*/.openclaw/workspace/google/watch-state.json`, reads the topic and labels recorded there, and re-runs the per-user `gmail-watch.js` as the affected agent. Gmail watches expire in 7 days; daily renewal stays well inside the window. Without this timer, `openclaw-integrity-check` raises `gmail-watch-expiring` at <24 h, which used to escalate to Karen and then to Telegram for a known-recurring, deterministic issue.
- `openclaw-monitor-sync.path` → `openclaw-monitor-sync.service`: watches every per-agent `~/.local/openclaw/monitor.json`; on change (within ~1 s), runs `/usr/local/sbin/openclaw-monitor-sync` which reconciles per-agent project resources — `enabled: true` resources get `systemctl --user enable --now`, `enabled: false` resources get `systemctl --user stop`. Companion `openclaw-monitor-sync.timer` runs every 5 min for drift correction. Triggered manually with `sudo /usr/local/sbin/openclaw-monitor-sync [<user>]`.

## Operational Commands

- `/usr/local/bin/openclaw-registry-check`: validates `/etc/openclaw/agents.json` against users, shared docs, ai-monitor config, and webhook routing.
- `/usr/local/bin/openclaw-registry-check --runtime`: also validates declared user services and listener ports.
- `/usr/local/bin/openclaw-boot-readiness`: post-reboot readiness check; runs registry runtime validation, linger checks, integrity check, and ai-monitor probe.
- `/usr/local/bin/openclaw-backup`: creates a root-only tarball of critical OpenClaw state under `/var/backups/openclaw`.
- `/usr/local/sbin/openclaw-patch-session-fence`: idempotent OpenClaw
  runtime patch applied by `install.sh`. It prevents provider timeout
  transcript markers from being treated as external session takeovers,
  preserving normal model fallback behavior for PM channel turns after
  a primary model stalls.
- `/usr/local/sbin/openclaw-control`: restart/wake helper used by ai-monitor,
  the monitor agent, and mail intake listeners. Before every wake it clears
  stale non-running `pendingFinalDelivery*` state and quarantines a broken
  `agent:main:main` entry whose session file is missing, so a successful wake
  means a task turn can actually start. Mail listeners should use
  `sudo -n /usr/local/sbin/openclaw-control wake-agent <self> <prompt>` with a
  narrow per-user sudoers grant instead of calling `openclaw` directly. PM
  callers may pass `--session-key <pm:...>` before the prompt to route the
  wake into a PM-owned OpenClaw session.
- `/usr/local/sbin/pm-workflow-nudge`: PM workflow recovery helper used by
  ai-monitor for Mission Control drift. It runs the PM TS script as the PM app
  user and sends a native `pm` channel task-comment turn with the full context
  packet, rather than a generic OpenClaw heartbeat reminder.

## Agent Services

Per-agent systemd user services follow a fixed pattern; the canonical list for each registered agent is in `/etc/openclaw/agents.json` under `services`.

### Coding agents (`role: coding`)

Core (always present on every enabled agent — from `agent-defaults.json` `core.services`):

- `openclaw-gateway.service` — OpenClaw runtime gateway

Derived from enabled integrations (`agent-defaults.json` `byIntegration[k]`):

- `openclaw-gmail-listener.service` — Gmail Pub/Sub listener (`integrations.gmail: true`)
- `openclaw-mail-listener.service` — Maildir/local-mail listener (`integrations.maildir: true`)

Per-agent project resources (services that come from a side project the agent has installed) live in `~/<user>/.local/openclaw/monitor.json`. Each resource declares `services[]` and a single `enabled` flag — when `enabled: true`, `openclaw-monitor-sync` keeps the services running and the loaders add them to the monitoring sweep. When `enabled: false`, the services are stopped and dropped from the sweep. See `MONITORING.md` → *Per-agent project resources* for the schema.

### Monitoring agent (`role: monitoring agent`, runs as user `karen`)

- `openclaw-gateway.service`
- `openclaw-jira-receiver.service` — Jira webhook receiver (`integrations.monitor: true` & `integrations.jira: true` on coding agents)
- `openclaw-bitbucket-receiver.service` — Bitbucket webhook receiver (`integrations.monitor: true` & `integrations.bitbucket: true` on coding agents)
- `ai-monitor.service` / `ai-monitor.timer` are **system** units (not per-user); the monitoring agent is the Telegram persona used for monitor alerts.

The monitoring agent does not run Gmail/Jira/Bitbucket task intake yet.
