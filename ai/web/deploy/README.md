# PM deployment notes (HOMELAB-43, Stage 1)

This directory carries the deploy-side artefacts for the PM walking skeleton.
It does not auto-apply — the bootstrap is intentionally manual for Stage 1 so
zeh sees exactly what changes on the host.

## Files

| File | Lands at | Owner | Notes |
| --- | --- | --- | --- |
| `pm.service` | `/etc/systemd/system/pm.service` | root | systemd unit; runs the one host-wide standalone Next server as the PM app user (`karen` on x1). |
| `pm-consumer.service` | `/etc/systemd/system/pm-consumer.service` | root | systemd unit; runs as the PM consumer user (`karen` on x1), drains `/var/lib/pm/drop`, and wakes agent gateways. |
| `pm.env.example` | copy -> `/etc/default/pm` | `root:<pm-user-group>`, `0640` | secrets file; not committed. |
| `/etc/openclaw/pm-consumer-tokens.json` | host-created | `root:<pm-consumer-group>`, `0640` | per-agent `/hooks/wake` Bearer map; never commit. |
| `/etc/openclaw/pm-channel-tokens.json` | host-created | `root:<pm-user-group>`, `0640` | per-agent native PM channel Bearer map; never commit. |
| `nginx-agents.vixi.au.conf` | `/etc/nginx/sites-available/agents.vixi.au` (+ symlink in `sites-enabled/`) | root | TLS via Let's Encrypt. |
| `rebuild-and-restart.sh` | run in place | — | coupled build + restart of the *currently-served* worktree. |
| `pm-switch.sh` | `-> /usr/local/sbin/pm-switch` | root | build a chosen worktree + flip `pm.service` to it (`pm-switch <wt>` / `pm-switch status`). |
| `pm-apply-worktree` | `-> /usr/local/sbin/pm-apply-worktree` | root | the one privileged step (drop-in + daemon-reload + restart), path-validated. |
| `pm-switch-runner` | `-> /usr/local/sbin/pm-switch-runner` | root | monitor-run runner behind `pm-switch-runner.service`; watches the spool, runs `pm-switch`. |
| `systemd/pm-switch-runner.service` | `/etc/systemd/system/` | root | runner unit (`User=<monitor>`, templated). |
| `sudoers.d/pm-switch` | `/etc/sudoers.d/pm-switch`, `0440` | root | one NOPASSWD rule: monitor -> `pm-apply-worktree`. |
| `install-pm-switch.sh` | run as root | — | idempotent installer for the switcher (scripts, unit, sudoers, spool, RW drop-in). |

## Worktree switcher (live preview)

Lets the monitor agent build any git worktree and flip which one `pm.service`
serves — from the CLI (`pm-switch <wt>`) or, in the PM webapp, a
git/worktree-exposed project's **Settings → Worktree live preview** panel
(admin only). Install with
`sudo PM_MONITOR_USER=karen ai/web/deploy/install-pm-switch.sh` (after
`code-tree-perms` has made `/srv/Code` group-collaborative). Full design,
mechanism, and caveats: [`MULTI_AGENT_WORKTREES.md`](./MULTI_AGENT_WORKTREES.md).

## Service Model

`pm.service` is one host-wide web service for `agents.vixi.au`. It is
not started once per agent. The single PM process owns the UI, DB,
task/comment persistence, and native `pm` channel callbacks, then
routes work to each agent through that agent's loopback OpenClaw
gateway.

On x1 the service user is `karen`, because Karen is the monitor agent
with host-level visibility into the local agent fleet. A future
dedicated `pm` Unix user is still the cleaner long-term option; set
`PM_APP_USER` / `PM_APP_GROUP` when running `openclaw/install.sh` to
render the units for a different service account.

The PM units are host-wide system services. Their unit files are
root-owned under `/etc/systemd/system`, while the runtime processes use
`User=karen` / `Group=karen` on x1. Do not install or enable
`pm.service` or `pm-consumer.service` under
`/home/<agent>/.config/systemd/user`; `openclaw/install.sh` removes
those stale per-agent user units during PM reconciliation.

`pm-consumer.service` keeps `ProtectHome=true`. To avoid `pnpm`
probing hidden `/home/karen` config files, the unit points `HOME`,
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `PNPM_HOME`, and
`NPM_CONFIG_USERCONFIG` at service-private directories under
`/var/lib/pm`.

## First-time install (x1)

```bash
# 1. Build the standalone bundle (uses pnpm; runs prisma generate + next build).
cd /srv/Code/environment/ai/web
pnpm install
pnpm build
# Standalone output: .next/standalone/server.js
# pnpm build copies .next/static and public into .next/standalone.

# 2. Apply DB migrations. Schema lives in prisma/schema.prisma; the v1 initial
#    migration is committed under prisma/migrations/. Use `migrate deploy` on
#    every host — never `db push` against a real DB (no history, no rollback).
pnpm prisma migrate deploy

# 3. Drop the env file into /etc/default and edit host secrets/paths.
sudo install -o root -g karen -m 0640 deploy/pm.env.example /etc/default/pm
sudo $EDITOR /etc/default/pm

# 4. Install/reconcile PM units, PM token files, OpenClaw gateway hooks,
#    and the native OpenClaw pm channel plugin.
sudo PM_WEB_ROOT="$PWD" /srv/Code/environment.worktrees/feature_HOMELAB-41-local-project-manager-webapp-/ai/openclaw/install.sh

# Equivalent manual unit install, if you are not using openclaw/install.sh:
sudo install -o root -g root -m 0644 deploy/pm.service /etc/systemd/system/pm.service
sudo install -o root -g root -m 0644 deploy/pm-consumer.service /etc/systemd/system/pm-consumer.service
sudo systemctl daemon-reload

# 4a. Create directories used by PM and the consumer when doing manual unit install.
sudo install -d -o karen -g karen -m 0700 /etc/openclaw/pm-agent-credentials
sudo install -d -o karen -g karen -m 0700 /var/lib/pm/drop
sudo install -d -o karen -g karen -m 0700 /var/lib/pm/pnpm-home /var/lib/pm/pnpm-config /var/lib/pm/pnpm-cache
sudo install -d -o karen -g karen -m 0700 /var/lib/pm/pnpm-config/pnpm
sudo install -o karen -g karen -m 0600 /dev/null /var/lib/pm/pnpm-home/.npmrc
sudo install -o karen -g karen -m 0600 /dev/null /var/lib/pm/pnpm-config/pnpm/rc
sudo install -d -o karen -g karen -m 0700 /srv/Data/projects
sudo install -d -o root -g root -m 0755 /srv/samba/shared
sudo find /srv/samba/shared -type d -exec setfacl -m u:karen:rwx,d:u:karen:rwx {} +
sudo find /srv/samba/shared -type f -exec setfacl -m u:karen:rw {} +
sudo test -f /etc/openclaw/pm-consumer-tokens.json || echo '{}' | sudo tee /etc/openclaw/pm-consumer-tokens.json >/dev/null
sudo chown root:karen /etc/openclaw/pm-consumer-tokens.json
sudo chmod 0640 /etc/openclaw/pm-consumer-tokens.json
sudo test -f /etc/openclaw/pm-channel-tokens.json || echo '{}' | sudo tee /etc/openclaw/pm-channel-tokens.json >/dev/null
sudo chown root:karen /etc/openclaw/pm-channel-tokens.json
sudo chmod 0640 /etc/openclaw/pm-channel-tokens.json

# Remove stale per-agent PM user units if they were ever installed.
sudo rm -rf /home/*/.config/systemd/user/pm.service \
            /home/*/.config/systemd/user/pm-consumer.service \
            /home/*/.config/systemd/user/pm.service.d \
            /home/*/.config/systemd/user/pm-consumer.service.d \
            /home/*/.config/systemd/user/default.target.wants/pm.service \
            /home/*/.config/systemd/user/default.target.wants/pm-consumer.service

# 4b. Reconcile local OpenClaw gateway hooks when doing manual unit install.
#     This populates each agent's hooks.token and mirrors the values into
#     /etc/openclaw/pm-consumer-tokens.json for the PM consumer.
sudo PM_WEB_ROOT=/srv/Code/environment/ai/web /srv/Code/environment/ai/openclaw/install.sh

# 4c. Install/configure the native PM channel plugin for local agents.
#     The helper stages a root-owned plugin copy at
#     /usr/local/share/openclaw/plugins/pm-channel, links that copy into
#     each enabled registry agent's OpenClaw config, writes per-agent PM channel tokens,
#     keeps the token file readable by the PM web service group, and
#     removes stale worktree plugin paths from plugins.load.paths.
sudo node deploy/install-openclaw-pm-channel.mjs --registry /etc/openclaw/agents.json --restart

# 5. Bring up the nginx vhost (cert assumed already issued; certbot --nginx -d agents.vixi.au if not).
sudo install -o root -g root -m 0644 deploy/nginx-agents.vixi.au.conf /etc/nginx/sites-available/agents.vixi.au
sudo ln -sf /etc/nginx/sites-available/agents.vixi.au /etc/nginx/sites-enabled/agents.vixi.au
sudo nginx -t && sudo systemctl reload nginx

# 7. Start.
sudo systemctl enable --now pm.service pm-consumer.service
journalctl -u pm.service -f
journalctl -u pm-consumer.service -f
```

## Subsequent migrations

For schema changes after Stage 1: generate the migration locally with
`pnpm prisma migrate dev --name <change>`, commit the new directory under
`prisma/migrations/`, and roll it forward on the host with
`pnpm prisma migrate deploy`. Same command, idempotent — applies only what
hasn't been applied yet.

`pnpm prisma db push` is dev-only (rapid prototyping without a migration
history) and **must not** be used against the production DB.

## Native OpenClaw PM channel

PM direct chat, task chat, task-comment, and Epic chat replies use the
native OpenClaw `pm` channel. Each enabled local agent gateway must load the staged plugin
at `/usr/local/share/openclaw/plugins/pm-channel` and have a channel
config similar to:

```json
{
  "channels": {
    "pm": {
      "enabled": true,
      "token": "env:PM_OPENCLAW_CHANNEL_TOKEN",
      "callbackToken": "env:PM_OPENCLAW_CHANNEL_TOKEN",
      "callbackUrl": "http://127.0.0.1:3000/api/openclaw/pm-channel/reply",
      "agentId": "main"
    }
  }
}
```

PM posts accepted turns to:

```text
POST http://127.0.0.1:<gateway_port>/pm-channel/ingest
Authorization: Bearer <PM_OPENCLAW_CHANNEL_TOKEN>
```

The route uses `auth: "plugin"` and performs its own Bearer check, so
it does not require gateway operator credentials. Keep gateways bound to
loopback and do not expose `/pm-channel/ingest` through nginx.

For live chat UX, PM includes a stream callback URL in each turn. The
plugin posts partial reply chunks to
`http://127.0.0.1:3000/api/openclaw/pm-channel/stream`; browsers subscribe
to PM over same-origin SSE while final durable replies still land at
`/api/openclaw/pm-channel/reply`.

PM resolves channel tokens in this order:
`PM_OPENCLAW_CHANNEL_TOKEN_<AGENT_SLUG>`,
`/etc/openclaw/pm-channel-tokens.json`, then
`PM_OPENCLAW_CHANNEL_TOKEN`. The installer writes the per-agent token
file and mirrors those values into the gateway configs. When no
`--agents` override is passed, the installer discovers enabled agents
from `/etc/openclaw/agents.json`; `openclaw/install.sh` passes that
registry explicitly.

`openclaw/install.sh` also applies the host runtime patch
`openclaw-patch-session-fence`. Without it, an OpenClaw provider timeout
can append an empty assistant error record, trip the embedded session
takeover guard, and bypass configured model fallbacks. Re-run the
OpenClaw installer after any global `openclaw` package update.

## Local OpenClaw wake hooks

The PM consumer should wake agents through each local gateway's external
hook:

```text
POST http://127.0.0.1:<gateway_port>/hooks/wake
Authorization: Bearer <agent hooks.token>
```

`openclaw/install.sh` is responsible for enabling this on the host. For
every enabled agent with an `openclaw-gateway` listener in
`/etc/openclaw/agents.json`, it should bind the gateway to loopback,
preserve the existing `hooks.internal` config, and set:

```json
{
  "gateway": {
    "bind": "loopback",
    "trustedProxies": ["127.0.0.1", "::1"]
  },
  "hooks": {
    "enabled": true,
    "path": "/hooks",
    "token": "<per-agent secret>",
    "allowRequestSessionKey": true,
    "allowedSessionKeyPrefixes": ["hook:", "pm:"]
  }
}
```

The same token must be mirrored into
`/etc/openclaw/pm-consumer-tokens.json` under that agent's slug. The
token file should be `0640` and owned by `root:<pm-consumer-group>`
(`root:karen` on x1 when using the default installer settings). The
committed service file is only a template; `openclaw/install.sh` renders
the installed unit with `PM_CONSUMER_USER` / `PM_CONSUMER_GROUP` or the
PM app user/group defaults.
OpenClaw requires `hook:` in the allowed session-key prefixes when no
default hook session key is configured; PM chat/comment routing uses
`pm:` keys created in `AgentSessionBinding`.

After hook changes, restart the affected `openclaw-gateway.service`.
Expected checks per gateway are: `GET /health` returns 200,
`GET /hooks` returns 405, unauthenticated `POST /hooks/wake` returns
401, and authenticated `POST /hooks/wake` returns 200. `ss -ltnp`
should show `127.0.0.1:<gateway_port>`, not
`0.0.0.0:<gateway_port>`. If the OpenClaw dashboard is exposed through
nginx, proxy it to `127.0.0.1:<gateway_port>` and explicitly block the
prefixed hook path (`/<agent>/hooks`), because the dashboard proxy strips
the public prefix before forwarding to the gateway.
Karen's `pm-karen-wake-agent` helper remains only as a fallback for old
hosts or temporary hook failures.

## Seeded credentials

- **zeh (human)** — password `password1`, `must_rotate_password=1`. First login forces rotation.
- **Each co-located agent** — random password written to
  `/etc/openclaw/pm-agent-credentials/<agent>.json` (mode `0600`, owner
  `<pm-app-user>`, `karen` on x1). The credential is host-private, never
  logged, and used only for the agent's first login + forced rotation flow.

The boot-time sync (in `instrumentation.node.ts`) reads `/srv/agents/index.json`,
reconciles the `Agent` table, and seeds the user rows + credential files. The
same path also runs on a 5-minute interval — see `AGENT_SYNC_INTERVAL_MIN`.

## Acceptance check (Stage 1)

After install:

1. `curl -I https://agents.vixi.au/login` → `200 OK`.
2. Sign in as `zeh` / `password1` → forced to `/rotate-password`.
3. `/agents` lists asdrubal, barekbaal, karen.
4. Create a project → /projects/<slug> board loads with 5 columns.
5. Add a task → drag across columns → reload, position persisted.
6. `journalctl -u pm.service` shows one `[pm] boot sync` log line and then a
   `[pm] periodic sync` line every 5 min.
