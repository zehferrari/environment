# PM deployment notes (HOMELAB-43, Stage 1)

This directory carries the deploy-side artefacts for the PM walking skeleton.
It does not auto-apply — the bootstrap is intentionally manual for Stage 1 so
zeh sees exactly what changes on the host.

## Files

| File | Lands at | Owner | Notes |
| --- | --- | --- | --- |
| `pm.service` | `/etc/systemd/system/pm.service` | root | systemd unit; runs as `zeh`. |
| `pm-consumer.service` | `/etc/systemd/system/pm-consumer.service` | root | drains `/var/lib/pm/drop` and wakes agent gateways. |
| `pm.env.example` | copy → `/etc/default/pm` | `root:zeh`, `0640` | secrets file; not committed. |
| `nginx-agents.vixi.au.conf` | `/etc/nginx/sites-available/agents.vixi.au` (+ symlink in `sites-enabled/`) | root | TLS via Let's Encrypt. |

## First-time install (x1)

```bash
# 1. Build the standalone bundle (uses pnpm; runs prisma generate + next build).
cd /srv/Code/environment/ai/web
pnpm install
pnpm build
# Standalone output: .next/standalone/server.js
# Copy assets the standalone server expects but doesn't bundle.
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public

# 2. Apply DB migrations. Schema lives in prisma/schema.prisma; the v1 initial
#    migration is committed under prisma/migrations/. Use `migrate deploy` on
#    every host — never `db push` against a real DB (no history, no rollback).
pnpm prisma migrate deploy

# 3. Drop the env file into /etc/default and the unit into systemd.
sudo install -o root -g zeh -m 0640 deploy/pm.env.example /etc/default/pm
sudo install -o root -g root -m 0644 deploy/pm.service /etc/systemd/system/pm.service
sudo install -o root -g root -m 0644 deploy/pm-consumer.service /etc/systemd/system/pm-consumer.service
sudo systemctl daemon-reload

# 4. Create directories used by PM and the consumer.
sudo install -d -o zeh -g zeh -m 0700 /etc/openclaw/pm-agent-credentials
sudo install -d -o zeh -g zeh -m 0700 /var/lib/pm/drop
sudo test -f /etc/openclaw/pm-consumer-tokens.json || echo '{}' | sudo tee /etc/openclaw/pm-consumer-tokens.json >/dev/null
sudo chown root:zeh /etc/openclaw/pm-consumer-tokens.json
sudo chmod 0640 /etc/openclaw/pm-consumer-tokens.json

# 5. Bring up the nginx vhost (cert assumed already issued; certbot --nginx -d agents.vixi.au if not).
sudo install -o root -g root -m 0644 deploy/nginx-agents.vixi.au.conf /etc/nginx/sites-available/agents.vixi.au
sudo ln -sf /etc/nginx/sites-available/agents.vixi.au /etc/nginx/sites-enabled/agents.vixi.au
sudo nginx -t && sudo systemctl reload nginx

# 6. Edit /etc/default/pm — generate AUTH_SECRET and confirm DATABASE_URL.
sudo $EDITOR /etc/default/pm

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

## Seeded credentials

- **zeh (human)** — password `password1`, `must_rotate_password=1`. First login forces rotation.
- **Each co-located agent** — random password written to
  `/etc/openclaw/pm-agent-credentials/<agent>.json` (mode `0600`, owner `zeh`).
  The agent process reads that file out-of-band, signs in once, and is forced
  to rotate.

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
