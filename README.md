# Budget — self-hosted personal budget app

A single-user (with optional household) personal budget web app you run on your
own Ubuntu home server. SQLite for storage, Caddy for HTTPS, and an automatic
nightly backup container — built to be left alone for months at a time.

## What's inside

- **Next.js 15** (App Router, Server Components, TypeScript strict)
- **SQLite** via `better-sqlite3`, schema/migrations via Drizzle ORM
- **Auth.js (NextAuth v5)** with Credentials + Argon2id, JWT sessions
- **Tailwind v4 + shadcn-style UI**, dark mode, sidebar nav, keyboard shortcuts
- **Recharts** projection chart, daily ledger with sticky header
- **Pure projection engine** in `lib/projection.ts` — fully unit-tested
- **Vitest** unit tests, **Playwright** happy-path e2e
- **Docker Compose**: app + Caddy reverse proxy + nightly backup cron

## Project layout

```
budget-app/
  app/
    (app)/                  authenticated app routes (dashboard, bills, …)
    api/                    route handlers (health, auth, CRUD, backup)
    login/  setup/          unauthenticated entry points
  components/
    ui/                     shadcn-style primitives
    money.tsx, sidebar.tsx, projection-chart.tsx, …
  lib/
    db/                     drizzle schema + client + migrations
    projection.ts           pure engine (heart of the app)
    projection-server.ts    server-only wrapper that loads input
    repos.ts                data-access helpers
    auth.ts                 full NextAuth config (server only)
    validation.ts           Zod schemas shared client/server
    money.ts dates.ts log.ts cn.ts ids.ts api.ts rate-limit.ts
  scripts/
    seed.ts migrate.ts backup.sh backup.js
  tests/e2e/                Playwright e2e
  Dockerfile docker-compose.yml Caddyfile
  drizzle.config.ts vitest.config.ts playwright.config.ts
```

## Local development

Prereqs: Node 20+ and a working C/C++ toolchain (for `better-sqlite3` and
`argon2`). On Windows, install build tools via `npm install --global windows-build-tools`
or VS C++ workload.

```bash
cp .env.example .env
# Generate a real AUTH_SECRET: openssl rand -base64 32

npm install
npm run db:generate     # generate Drizzle SQL migrations (already committed)
npm run dev             # http://localhost:3000
```

On first run, browse to `http://localhost:3000`. You'll be redirected to
`/setup` to create the owner account and seed default categories. Subsequent
visits land on `/login`.

### Useful commands

| Command            | What it does                                     |
| ------------------ | ------------------------------------------------ |
| `npm run dev`      | Next dev server                                  |
| `npm run check`    | Typecheck + lint + unit tests + production build |
| `npm test`         | Vitest (engine tests)                            |
| `npm run test:e2e` | Playwright happy path (boots `npm start`)        |
| `npm run db:generate` | Regenerate Drizzle migrations from schema     |
| `npm run db:migrate`  | Apply pending migrations to current DB        |
| `npm run backup`   | One-off SQLite backup via `scripts/backup.js`    |

## Deploying on Ubuntu (or any Docker host)

Requirements: Docker 24+, docker-compose plugin, Ubuntu 22.04+ recommended.

```bash
git clone <this repo> budget && cd budget
cp .env.example .env
# Edit .env: set AUTH_SECRET (required), TZ, and either leave DOMAIN blank
# (LAN mode, https://budget.local) or set it to a real domain for Let's Encrypt.

docker compose up -d --build
```

First-run setup:

1. Browse to `https://<your-host>/setup` (LAN mode: `https://budget.local`).
2. Create the owner account and seed categories.
3. Done — log out and log back in via `/login` next time.

To upgrade later:

```bash
git pull && docker compose up -d --build
```

### LAN mode and the Caddy internal CA

When `DOMAIN` is blank, Caddy serves `https://budget.local` with its internal
CA. To trust it on LAN devices, copy `caddy_data/caddy/pki/authorities/local/root.crt`
(inside the named Docker volume) and import it as a trusted root on each
device. On Linux: `sudo cp root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates`.

You also need a DNS or hosts entry pointing `budget.local` → your server's
LAN IP. Easiest options: add it to `/etc/hosts` on each device, or set up a
DNS rewrite in your router / Pi-hole / Adguard.

### Domain mode (Let's Encrypt)

Set `DOMAIN=budget.example.com` in `.env`, point an A record at the server,
ensure ports 80/443 are reachable, then `docker compose up -d --build`. Caddy
will automatically issue and renew a certificate.

### Backups

The `backup` container runs a cron job nightly at **03:00 local time** (uses
`TZ` from `.env`). It runs `sqlite3 budget.db "VACUUM INTO …"` into the
`./backups` host directory, naming files `budget-YYYYMMDD-HHMMSS.db`, and
prunes anything older than the last 14 keeps.

To restore: stop the app, replace `data/budget.db` with the chosen backup,
start the app:

```bash
docker compose stop app
cp backups/budget-20260101-030001.db data/budget.db
docker compose start app
```

There's also an in-app **export/import** under `/settings` that produces a
single JSON file of all your data — handy for cross-machine restores or
splitting a household.

### Exposing to the internet

**Recommended: Tailscale.** Install on the server and on devices that should
reach the budget app. Use `https://<server-tailscale-name>` from any node.
No port forwarding, no public exposure.

**Discouraged: port forwarding.** If you must, forward 80/443 to your server,
set `DOMAIN` to a real domain, and accept that your login page is exposed
to the world. The built-in rate limiter is a leaky bucket per IP — fine for
deterring drive-by guessing, **not** a substitute for keeping the URL private.

## Environment variables

All read from `.env` (see `.env.example`):

| Var            | Required | Default                          | Notes                                          |
| -------------- | -------- | -------------------------------- | ---------------------------------------------- |
| `DATABASE_URL` | yes      | `file:./data/budget.db`          | In Docker the path is `/data/budget.db`        |
| `AUTH_SECRET`  | yes      | —                                | 32+ byte random string for JWT signing         |
| `AUTH_URL`     | yes      | `https://budget.local`           | Set to your real URL — used by NextAuth        |
| `DOMAIN`       | no       | blank                            | Blank = LAN mode; set for Let's Encrypt        |
| `TZ`           | no       | `America/New_York`               | Used for backup cron and projection day calc   |
| `NODE_ENV`     | no       | `production`                     | Set automatically in Docker                    |

## Architecture notes

- **Money is integer cents** everywhere. There is no float math in the engine.
- **Dates are ISO `YYYY-MM-DD` strings**. Day arithmetic in `lib/projection.ts`
  is done in UTC so DST in display zones can't shift day boundaries.
- **The projection engine is pure.** No I/O. `lib/projection-server.ts` is the
  only thing that knows how to load inputs from the DB.
- **Server Components do the heavy reads.** Client components only mount for
  forms and interactive tables. No client-side fetching of data that could be
  rendered server-side.
- **Auth split**: `auth.config.ts` is edge-compatible (no DB / no argon2) and
  used by the middleware. `lib/auth.ts` extends it with the Credentials
  provider for the route handlers.

## License

MIT (do whatever you want).
