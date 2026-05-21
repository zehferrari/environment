# ai/web — PM workspace

Stage 1 walking skeleton from
[HOMELAB-43](https://zeh-ferrari.atlassian.net/browse/HOMELAB-43). Next.js App
Router + Tailwind + Prisma/SQLite + NextAuth credentials + argon2id.

The static `agents.html` next to this README is the legacy mission-control
page from HOMELAB-42; it stays in place until HOMELAB-52 deletes it. PM is
served by a long-lived Node process at `agents.vixi.au` — see
[deploy/README.md](./deploy/README.md).

## Local dev

```bash
pnpm install
cp .env.example .env
# edit DATABASE_URL / AUTH_SECRET as needed
pnpm prisma migrate dev   # applies committed migrations, regenerates client
pnpm dev
```

The Next.js app boots → `instrumentation.node.ts` seeds the `zeh` user and
runs the first agent sync against `$AGENT_INDEX_PATH` (default
`/srv/agents/index.json`). On a dev box where that file is absent, the boot
sync logs an error and continues — log in as `zeh` / `password1` and rotate
the password, then visit `/agents` to see the (empty) table.

## Layout

| Path | Purpose |
| --- | --- |
| `app/login`, `app/rotate-password` | unauthenticated routes. |
| `app/(app)/projects` | projects list + kanban board. |
| `app/(app)/agents` | agents registry view (sourced from `/srv/agents/index.json`). |
| `app/api/auth/[...nextauth]` | NextAuth route. |
| `app/api/debug/sync` | manual trigger for the agent sync (auth-only). |
| `lib/auth.ts` | NextAuth credentials + JWT callbacks. |
| `lib/auth/rate-limit.ts` | in-process login rate limit (per-IP + per-username). |
| `lib/agents/sync.ts` | the canonical agent sync — boot + 5-min interval. |
| `lib/agents/credentials.ts` | per-agent host-private credential seeding. |
| `instrumentation.node.ts` | boot hook (runs only on the Node runtime). |
| `middleware.ts` | auth gate + `must_rotate_password` redirect. |
| `prisma/schema.prisma` | full v1 schema. |
| `prisma/migrations/` | committed migration history; applied via `prisma migrate deploy`. |
| `deploy/` | systemd unit, nginx vhost, env file template. |

## Stage 1 scope

- Auth: password-only (Credentials provider + argon2id). No NextAuth Google
  provider in v1; Google SSO deferred to v1.1+ per the live ticket
  description.
- DB: SQLite + Prisma migrations. Same schema can move to Postgres without
  changes.
- Login rate limit: in-process sliding-fixed-window, 10/5min per IP +
  5/5min per username. Adequate for single-host v1; revisit if PM goes
  multi-host.
- Permissions: stub `RolePermission` table; enforcement lands in HOMELAB-44.
- Agents: only those whose `codeOwner` matches this host's
  `/srv/agents/index.json` `codeOwner` are seeded as PM users. Remote-host
  agents are out of scope until v1.1+.

## Known follow-ups

- Email send for `password_reset_tokens` (schema exists; sender is v1.1
  polish per the description).
- Comments + activity-log UI (Stage 2 / HOMELAB-44).
- Per-agent profile editor (HOMELAB-52).
