# Services

Use `/etc/openclaw/agents.json` for the machine-readable monitoring roster.

## System Timers

- `openclaw-integrity.timer`: runs `/usr/local/bin/openclaw-integrity-check` every 2 minutes.
- `ai-monitor.timer`: runs `/usr/local/bin/ai-monitor` every 2 minutes, offset from integrity.
- `openclaw-backup.timer`: runs `/usr/local/bin/openclaw-backup` daily at 04:20 with up to 20 minutes randomized delay for small critical OpenClaw state.
- `zypper-dup.timer`: runs weekly Tumbleweed updates.

x1 uses systemd timers for active automation. Cron references in old migration notes are historical, not the active scheduler.

## System Services

- `ollama.service`: local Ollama API on `127.0.0.1:11434`.
- `nginx.service`: local reverse proxy/static serving on x1.
- `mariadb.service`: local DB.
- `php-fpm.service`: local PHP runtime.
- `agent-dashboard.service`: real-time per-agent dashboard backend on `127.0.0.1:3013` (HTTP + SSE). Front-end at `https://dev.vixi.au/agents.html` behind nginx basic auth.
- OpenClaw Control UIs: per-agent gateway dashboards exposed through nginx behind basic auth. `https://dev.vixi.au/asdrubal/` proxies to Asdrubal on `10.0.0.108:18789`; `https://dev.vixi.au/barekbaal/` proxies to Barekbaal on `10.0.0.108:18790`. Legacy `/openclaw` redirects to `/asdrubal/`. OpenClaw uses trusted-proxy auth with `X-Forwarded-User` from nginx, so nginx basic auth is the browser login. Gateway ports bind to LAN but remain blocked from direct network access by firewalld. This is an admin surface; do not expose without auth.
- `openclaw-typing-keepalive.service`: Telegram typing-indicator sidecar for the openclaw `claude-cli` provider (`/usr/local/bin/openclaw-typing-keepalive`). The cli-backend is non-streaming, so openclaw's built-in typing keepalive (60 s TTL refreshed by stream events) lapses mid-turn on long opus runs. This service polls every registered agent's `~/.openclaw/agents/main/sessions/sessions.json` and re-fires `sendChatAction("typing")` every 4 s for any telegram conversation key currently `status=running` on `modelProvider=claude-cli`. Auto-discovers agents from `/etc/openclaw/agents.json`; no per-agent install. Runs as root because each agent's `sessions.json` and `~/.config/openclaw/openclaw-secrets.env` (where `TELEGRAM_BOT_TOKEN` lives) are mode `0600` per-user. Agents on `ollama` / `openai-codex` / other providers are skipped — they emit native streaming events that drive the in-process typing pipeline correctly.

## Operational Commands

- `/usr/local/bin/openclaw-registry-check`: validates `/etc/openclaw/agents.json` against users, shared docs, ai-monitor config, and webhook routing.
- `/usr/local/bin/openclaw-registry-check --runtime`: also validates declared user services and listener ports.
- `/usr/local/bin/openclaw-boot-readiness`: post-reboot readiness check; runs registry runtime validation, linger checks, integrity check, and ai-monitor probe.
- `/usr/local/bin/openclaw-backup`: creates a root-only tarball of critical OpenClaw state under `/var/backups/openclaw`.

## Agent Services

Per-agent systemd user services follow a fixed pattern; the canonical list for each registered agent is in `/etc/openclaw/agents.json` under `services`.

### Coding agents (`role: manager` / `role: developer`)

- `openclaw-gateway.service` — OpenClaw runtime gateway
- `openclaw-gmail-listener.service` — Gmail Pub/Sub listener
- `openclaw-webhook-receiver.service` — per-agent webhook receiver (loopback)
- `wdt-<user>.service` — WDT Next.js standalone (port per agent in `agents.json` `listeners`)

`wdt-branch-control.service` is retired and removed. WDT branch switching is not an active systemd service on x1; do not recreate it. The only supported WDT runtime units are the per-agent `wdt-<user>.service` units declared in `/etc/openclaw/agents.json`.

### Monitoring agent (`role: monitoring agent`, runs as user `karen`)

- `openclaw-gateway.service`
- `openclaw-webhook-receiver.service`
- `ai-monitor.service` / `ai-monitor.timer` are **system** units (not per-user); the monitoring agent is the Telegram persona used for monitor alerts.

The monitoring agent does not run Gmail/Jira/Bitbucket task intake yet.
