# CLAUDE.md

Operational guide for AI coding agents (and any new contributor) working on
**FINANCE_OS** — a self-hosted personal/family budget tracker.

> Read this top-to-bottom on first session. Refer back when in doubt.
> Update it whenever you discover a non-obvious convention or learn a
> hard-won lesson — that's how it stays useful.

---

## 1. What this is

A Next.js 15 app that projects daily cash-flow from paychecks, recurring bills,
one-time expenses, and credit card statements. SQLite-backed, single-binary
deployable. Lives at https://budget.bluefalls.home behind Caddy on a home LAN.

**Mental model:**
- **Bills** = fixed recurring (rent, insurance, subscriptions) — same amount each cycle
- **Paychecks** = scheduled income with optional reconciliation against actual
- **One-time expenses** = known future non-recurring spends (concert, gift)
- **Credit cards** = variable monthly bills with two dates (statement close + due)
- **Projection engine** = pure function that combines the above into a daily virtual ledger

The headline feature for credit cards is *"how much is due to avoid interest."*
Everything in the UI orbits that question.

---

## 2. Quickstart

```bash
# install
npm install

# dev (uses .env which must point at a local SQLite file)
cp .env.example .env       # edit AUTH_SECRET, AUTH_URL=http://localhost:3000, NODE_ENV=development
npm run dev                # http://localhost:3000

# verification before any commit or deploy
npm run check              # typecheck + lint + vitest + build (run this religiously)

# individual checks
npm run typecheck
npm run lint
npm run test               # vitest
npm run build
npx playwright test        # E2E happy-path (rare; spins its own server on :3217)
```

**Always `npm run check` before committing.** It catches everything CI would.

---

## 3. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15 App Router** | Server components for data, RSC streaming, simple deploy |
| Language | **TypeScript strict** | Catch shape mistakes early |
| DB | **SQLite (better-sqlite3)** + **Drizzle ORM** | Single-file backups, no separate process, perfect for self-host |
| Auth | **Auth.js v5** (Credentials + Argon2id) | First-party, edge-safe with `auth.config.ts` split |
| Validation | **Zod** | Schemas live in `lib/validation.ts`, shared between API + UI |
| Styles | **Tailwind v4** (`@theme` syntax) | Atomic, paired with shadcn-style primitives |
| Charts | **Recharts** | Composable, restyled with mint palette |
| Testing | **Vitest** (engine) + **Playwright** (E2E) | Pure functions get unit; happy paths get E2E |
| Runtime | **Node 20** in Alpine, served by **tini** | Standalone Next build for minimal image |
| Reverse proxy | **Caddy 2** with `tls internal` | Auto-cert from internal CA for the LAN domain |

---

## 4. Project structure

```
app/
  (app)/                   ← authenticated pages, share AppShell layout
    layout.tsx             ← runs migrations, gates auth, wraps with AppShell
    page.tsx               ← dashboard
    accounts/              ← linked-bank accounts (Plaid) + draft transaction review
    bills/
    credit-cards/
    extras/
    paychecks/
    projection/
    settings/
  api/                     ← REST endpoints, all server-only
    {entity}/route.ts      ← list (GET) + create (POST)
    {entity}/[id]/route.ts ← read/update/delete
    plaid/                 ← link-token, exchange, items, accounts, sync, drafts (see §17)
  login/
  setup/
  layout.tsx               ← root: imports JetBrains Mono, applies dark class
  globals.css              ← FINANCE_OS theme tokens (dark-only, mint palette)

components/
  ui/                      ← shadcn-style primitives (button, card, input, dialog, sheet, …)
  app-shell.tsx            ← topbar + sidebar wrapper
  sidebar.tsx              ← nav with `g d/b/a/c/p/e/x/s` shortcuts
  projection-chart.tsx     ← Recharts area chart
  money.tsx, date-label.tsx, money-input.tsx
  category-dialog.tsx      ← shared "add new category" dialog (used in 2 places)
  plaid-draft-approve-dialog.tsx ← approve a Plaid draft into a real expense

lib/
  db/
    schema.ts              ← Drizzle table definitions (single source of truth)
    client.ts              ← getDb() singleton + runMigrations() with self-heal
    migrations/            ← SQL files + meta/_journal.json (HAND-WRITTEN, see §7)
  projection.ts            ← PURE function — never imports server-only stuff
  projection.test.ts       ← 13 vitest cases — keep passing
  projection-server.ts     ← thin shim that fetches from DB and calls projection.ts
  repos.ts                 ← every DB query goes through here (NEVER raw SQL in routes)
  validation.ts            ← every Zod schema lives here
  auth.ts                  ← NextAuth instance + requireUserId/requireAdmin helpers
  api.ts                   ← ensureUser, readJson, jsonError helpers for routes
  credit-cards.ts          ← cycle date math (clamp Feb 31 → 28, etc.)
  plaid-client.ts          ← lazy `PlaidApi` singleton (reads PLAID_* env)
  plaid-crypto.ts          ← AES-256-GCM encrypt/decrypt for access tokens (+ test)
  plaid-sync.ts            ← cursor-based `transactions/sync` polling + link-token creation
  dates.ts, money.ts, ids.ts, cn.ts, log.ts, rate-limit.ts

scripts/
  backup.{js,sh}           ← nightly SQLite VACUUM INTO + 14-day prune
  migrate.ts, seed.ts      ← dev-only

tests/
  e2e/                     ← Playwright (one happy-path spec)
```

---

## 5. Conventions (non-negotiable)

### Money
- **Always integer cents** in the DB and across the wire
- Use `<Money cents={n} />` to render — never inline `(n/100).toFixed(2)`
- Use `<MoneyInput valueCents={n} onChangeCents={fn} />` in forms
- Helper: `formatCents(cents, currency)` from `lib/money.ts`

### Dates
- **Always ISO `YYYY-MM-DD` strings** in the DB and across the wire (NOT `Date` objects)
- All date math in UTC — see `lib/dates.ts` (`addDaysIso`, `todayIso`)
- Render with `<DateLabel iso={s} format="short|long" />`
- Day-of-month math (statement day 31 in February) must clamp — see `clampDay` in `lib/credit-cards.ts`

### IDs
- All primary keys are nanoid-style strings via `lib/ids.ts` `newId()` — never autoincrement integers

### Repos vs API routes
- **Routes never run raw SQL.** They call `lib/repos.ts` functions.
- Repos are user-scoped: `listBills(userId, ...)`, `createBill(userId, data)`, etc.
- The `userId` argument enforces tenant isolation at the query level.

### Validation
- Every API endpoint that accepts a body uses a Zod schema from `lib/validation.ts`
- Use `readJson(req, schema)` from `lib/api.ts` — returns `NextResponse` on validation error or the parsed data on success

### Components
- shadcn-style: copy/own primitives, no big component library dependency
- Each primitive is small (~50 lines), accepts `className`, forwards refs
- Page-level components live next to their route as `*-client.tsx`

---

## 6. UI conventions (Home Apps design system)

The look is intentional — **cyberpunk × military × sci-fi**: tactical-black
backgrounds, electric-cyan primary, phosphor-green accent, sharp 1px borders,
no shadows for elevation. Stay consistent so new pages feel native.

### Typography (3 families, distinct roles)
- **Orbitron** (`var(--font-display)`) — h1–h3, HUD callouts, hero numbers. Geometric, sci-fi.
- **Rajdhani** (`var(--font-ui)`) — body/UI text. Slightly condensed, quasi-military.
- **JetBrains Mono** (`var(--font-mono)`) — money, dates, terminal output. Anything `.tabular`.

Defaults are wired in `app/layout.tsx` via `next/font` and applied through
the base CSS in `globals.css`. **Don't import other fonts.**

### Color tokens (use the var, not the hex)
| Token | Use |
|---|---|
| `var(--cyan)` (alias: `--mint`) | Primary — interactive, focus, "live" markers |
| `var(--phosphor)` | Accent — terminal-style success, "OK", live data |
| `var(--olive)` | Structural / secondary actions, maps |
| `var(--amber)` | Warning |
| `var(--red)` | Danger / abort |
| `var(--text-0/1/2/3)` | Text hierarchy (high → tertiary) |
| `var(--bg-0/1/2/3)` | Backgrounds (deepest → elevated) |
| `var(--border-raw)` / `var(--border-2)` | Default border / hover-active |

Note: `--mint*` is kept as an alias of `--cyan*` so the 26 existing files
that already use `text-[var(--mint)]` etc. inherit the new color
automatically. **Prefer `--cyan` / `--phosphor` for new code** — the names
are semantically accurate.

### Building blocks (use these, don't reinvent)
| Component | When |
|---|---|
| `<PageHead module="MODULE_NN" title="…" subtitle="…" actions={…} />` | Top of every page |
| `<CardSubTag>TABLE_XX</CardSubTag>` | Inside `CardHeader` above the title |
| `<TileGrid cols={3|4|"auto"}><Tile … /></TileGrid>` | KPI rows |
| `<StatusPill variant="default|warn|off|danger|amber">` | Inline state markers |
| `<Badge variant="default|secondary|destructive|warning|muted">` | Counts, role tags |
| `<AlertBar tag="ALERT" variant="amber|mint|red" onDismiss={…}>` | Inline notices |
| `.bracketed` utility class | Adds tactical L-corner brackets to a positioned container |

### Visual rules
- **Sharp corners by default** — `--radius` is `0px`. Only badges/chips get `2px` (`--radius-chip`).
- **1px solid borders** for elevation — never drop shadows. Active borders use `var(--cyan)`.
- **All UI labels are uppercase + letter-spaced** (`tracking-[0.12em]` for labels, `[0.2em]` for hero/page heads).
- **Body prose stays sentence-case Rajdhani.** Headings (`<h1>`–`<h3>`) auto-render in Orbitron uppercase via base CSS.
- **Numbers use `.tabular`** — auto-applies JetBrains Mono + tabular-nums.
- **State telegraphs in color, not just copy** — variant badges/borders carry the meaning.
- Pages animate in with `fade-in` class on the root.

### Dark only
The app forces `dark` class in `app/layout.tsx`. There is no light mode. The
theme tokens in `globals.css` map shadcn HSL vars onto the Home Apps palette
so existing primitives (Button, Dialog, etc.) inherit automatically — no
per-component edit needed for the rebrand.

---

## 7. Database & migrations — read this twice

This is the most foot-gun-heavy area. Lessons learned the hard way:

### Adding a new column or table

1. **Edit `lib/db/schema.ts`** — add the column/table.
2. **Hand-write the SQL** as the next-numbered file in `lib/db/migrations/NNNN_description.sql`.
   - Prefix with the next zero-padded index (look at existing files).
   - Use the same SQL style as `0000_moaning_madrox.sql` (backticks around identifiers, `--> statement-breakpoint` between statements).
3. **Update `lib/db/migrations/meta/_journal.json`** — append a new entry with the next `idx` and the `tag` matching the filename (without `.sql`).
4. Run `npm run check` to confirm types.
5. Restart `npm run dev` (or rebuild Docker). On boot, `runMigrations()` will apply the new file.

### What NEVER to do

- ❌ **Never run `npx drizzle-kit generate`** as part of the Docker build.
  It auto-creates spurious migrations whenever the snapshot drifts from
  the schema. The Dockerfile has a comment forbidding this — leave it.
- ❌ **Never write raw SQL in API routes** — go through `lib/repos.ts`.
- ❌ **Never modify an existing migration file** — it's already been applied
  on the live DB. Create a new migration that fixes things instead.
- ❌ **Never delete `_journal.json` entries** — Drizzle uses them to know
  what's been applied.

### Self-heal in `runMigrations()`

`lib/db/client.ts` wraps `migrate()` in a try/catch that handles the one
recoverable error — `duplicate column name`. If a migration tries to add a
column that already exists (because a prior boot applied it but didn't durably
record the tracking row), the catch handler reads the journal, computes the
proper SHA-256 hash for each entry, and inserts any missing rows into
`__drizzle_migrations`. This makes redeploys idempotent.

You generally don't need to think about this — but if you see weird migration
errors on the server, check `__drizzle_migrations` against the journal and
the file hashes (`sha256sum lib/db/migrations/*.sql`).

### Snapshot files
Drizzle stores `meta/NNNN_snapshot.json` next to each migration so
`drizzle-kit` can compute future diffs. We don't currently keep these in sync
because we don't run `drizzle-kit generate` (see above). If you ever need to
use it locally, regenerate snapshots in a dev branch and verify nothing
weird gets emitted before merging.

### Current migrations (in order)
- `0000_moaning_madrox` — initial schema (users, settings, categories, paychecks, bills, one-time expenses)
- `0001_add_user_role` — `users.role` column
- `0002_add_credit_cards` — `credit_cards` + `credit_card_statements` tables
- `0003_add_bill_paid_via_card` — `bills.paid_via_card_id` (nullable FK to a credit card; see §17)
- `0004_add_plaid` — `plaid_items`, `plaid_accounts`, `plaid_transaction_drafts` (see §17)
- `0005_link_card_to_plaid` — `credit_cards.plaid_account_id` (nullable, unique) + unique index on `(card_id, statement_date)` for idempotent statement upsert

---

## 8. Authentication & users

- **Auth.js v5** with the **Credentials provider** (email + password)
- Passwords hashed with **Argon2id** (`memoryCost: 19_456, timeCost: 2`)
- **JWT sessions** (no DB session table) — 30-day max age
- Login is **rate-limited** with a leaky bucket: 5 attempts per 15 minutes per IP

### Edge vs node split
- `auth.config.ts` — edge-safe (no `argon2`, no `better-sqlite3`). Used by middleware.
- `lib/auth.ts` — full config with the Credentials provider. Used by API routes and server components.
- The middleware imports `auth.config.ts` only — keep it that way or it'll fail to bundle.

### Roles
- `users.role` is `"admin" | "member"`
- The first user (created via `/setup`) is `admin`
- Use `requireAdmin()` from `lib/auth.ts` to gate admin-only routes
- The session callback in `auth.config.ts` propagates `role` from JWT → session
- Family-member CRUD lives in `app/api/users/*`

### When you need the current user in a server component or route
```ts
import { requireUserId } from "@/lib/auth";
const userId = await requireUserId();   // throws if not authenticated
```

---

## 9. The verification pipeline

Run **before every commit and every deploy**:

```bash
npm run check
```

This is `typecheck && lint && test && build` chained. If any step fails, **stop
and fix** — never push past a red check.

### Common breakages and what they mean
| Symptom | Likely cause |
|---|---|
| `Object is possibly 'undefined'` after Zod `safeParse` | Use `parsed.error?.issues[0]?.message ?? "fallback"` |
| `Comments inside children section of tag` | JSX literal `// FOO` outside braces — wrap in `{"// FOO"}` |
| `'X' is defined but never used` | ESLint with `@typescript-eslint/no-unused-vars` — actually remove the import or rename to `_X` |
| Build fails: `/app/public not found` | `public/` directory is missing — keep at least `public/.gitkeep` |
| Drizzle "duplicate column name" at runtime | Old `__drizzle_migrations` rows are stale — see §7 self-heal section |

---

## 10. Git workflow

The repo lives on GitHub. The local main branch tracks `origin/main`.

### Commit hygiene
- **Conventional commit-ish style**, lowercase: `feat: …`, `fix: …`, `refactor: …`, `chore: …`, `docs: …`. Past-tense okay.
- **Subject ≤ 72 chars.** Body explains *why*, not *what* (the diff already shows what).
- **One logical change per commit.** If your message has "and" in it, split it.
- **Always create a NEW commit** — don't `--amend` unless explicitly asked.
- **Never `git push --force`** to `main`. To `main`, never. To a feature branch you own, with caution.

### Branching
- For non-trivial work: `git checkout -b feat/credit-cards-statements` (or `fix/...`, `refactor/...`)
- Merge via PR with a clean squash so `main` history stays linear
- Trivial typo/comment fixes can land directly on `main` if `npm run check` passes

### What NEVER goes in the repo
The `.gitignore` already blocks these — but be paranoid:
- `.env` (real secrets)
- `data/`, `backups/`, `*.db`, `*.sqlite` (the live database)
- `caddy-root.crt` (server-issued)
- `scripts/deploy*.py`, `scripts/probe_*.py`, `scripts/_db_fix.py`,
  `scripts/redeploy.py`, `scripts/fix_migration.py`, `scripts/verify_deploy.py`,
  `scripts/inner_check.py`, `scripts/cleanup_server.py`, `scripts/diag.py`,
  `scripts/check_migrations.py`, `scripts/get_logs.py`
  — these contain hard-coded server credentials
- `.claude/` (per-machine Claude Code settings)
- `node_modules`, `.next`, `*.tsbuildinfo`, `test-results`, `playwright-report`

If in doubt, run `git status` after staging and look hard at the list.

### Sensitive value audit
Before any commit:
```bash
git diff --cached | grep -iE "(password|secret|token|api[_-]?key|Sandro)"
```
If anything matches that isn't intentional (`.env.example` placeholders are OK), unstage it.

---

## 11. Deployment

### Where it lives
- **Server**: `plex.bluefalls.home` (10.10.88.6 on the LAN), Ubuntu 24.04
- **Server user**: `sandrohp88` (UID 1000 — must match container `node` user)
- **Deploy directory**: `/opt/budget`
- **Domain**: `budget.bluefalls.home` (resolved by UDM at 10.10.88.1)
- **TLS**: Caddy `tls internal` → root CA at `/opt/budget/caddy-root.crt`
- **Containers**: `budget-app`, `budget-caddy`, `budget-backup` (on the same Compose project)

### How to deploy
The deploy script is `scripts/redeploy.py` (gitignored, contains the SSH password).
It uploads changed source files via SFTP and runs `docker compose up --build -d`
on the server. **Always `npm run check` first** so you don't ship broken code.

```bash
# from a Windows shell with python+paramiko available
python scripts/redeploy.py
```

The script also chowns `/opt/budget/data` to UID 1000 each run because of an
old quirk we hit early on.

### Container UID mismatch (the lesson)
The container runs as the `node` user (UID 1000) so it can read/write the
volume-mounted `/opt/budget/data` directory which is owned by `sandrohp88`
(also UID 1000). **Don't change this** — see the comment in `Dockerfile`.
If you switch base images, verify the user UID still matches the host owner.

### Backups
The `budget-backup` container runs `scripts/backup.sh` via crond at 03:00
local time. It does `VACUUM INTO` to `/backups/budget-YYYYMMDD-HHMM.db` and
prunes anything older than 14 days. To pull a backup off the server:
```bash
scp sandrohp88@plex.bluefalls.home:/opt/budget/backups/budget-*.db .
```

### Trust the local CA on a new device
1. Get the cert: `scp sandrohp88@plex.bluefalls.home:/opt/budget/caddy-root.crt .`
2. Install to the OS trust store (per-OS instructions in the README)

---

## 12. Security

- Never log passwords, tokens, or full auth headers
- Argon2id parameters live in `lib/auth.ts` — don't weaken them
- Login rate limiting is in `lib/rate-limit.ts` — don't disable for "convenience"
- All DB queries go through repos that take a `userId` — preserve that boundary
- The middleware (`middleware.ts`) gates the `(app)` group; new routes inherit it
- When adding admin-only endpoints: `await requireAdmin()` first thing
- Caddy adds HSTS, X-Content-Type-Options, X-Frame-Options DENY — leave the headers in place

---

## 13. Recipes

### Add a new entity (e.g. "Investments")
1. **Schema** — add table in `lib/db/schema.ts`, plus inferred types `XxxRow`, `NewXxx`
2. **Migration** — write SQL file, add entry to `_journal.json` (see §7)
3. **Validation** — add `xxxCreateSchema`, `xxxUpdateSchema` in `lib/validation.ts`
4. **Repos** — `listXxx`, `getXxx`, `createXxx`, `updateXxx`, `archiveXxx` in `lib/repos.ts` (always user-scoped)
5. **API** — `app/api/xxx/route.ts` (GET, POST) + `app/api/xxx/[id]/route.ts` (PATCH, DELETE)
6. **Page** — `app/(app)/xxx/page.tsx` (server) + `xxx-client.tsx` (client)
7. **Sidebar** — add nav entry in `components/sidebar.tsx` with a unique shortcut
8. **Crumb** — add to `ROUTE_TO_CRUMB` in `components/app-shell.tsx`
9. **Projection** — if it affects cash flow, inject as `extras` in `lib/projection-server.ts`
10. **Export/import** — extend `exportAll()` and `importAll()` in `lib/repos.ts`, bump `schemaVersion`
11. **README** — update the deploy guide if needed
12. `npm run check` then commit

### Add a new API route to an existing entity
1. Add a Zod schema in `lib/validation.ts` for the request body
2. Add the repo function in `lib/repos.ts`
3. `app/api/{entity}/{action}/route.ts` — start with `ensureUser()`, parse with `readJson(req, schema)`, return `NextResponse.json(...)` or `jsonError(...)`
4. Hook the UI to it via `fetch("/api/...")` with proper error handling and a `toast` notification

### Add a new dialog
1. Create a new component or extend an existing one
2. Use the `<Dialog>` primitive from `components/ui/dialog.tsx`
3. Header pattern:
   ```tsx
   <DialogHeader>
     <CardSubTag>NEW_THING</CardSubTag>
     <DialogTitle>ADD THING</DialogTitle>
   </DialogHeader>
   ```
4. Footer with `<Button variant="outline">CANCEL</Button>` + `<Button variant="primary" type="submit">SAVE</Button>`
5. Form labels uppercase, letter-spaced — `<Label>` already does this

---

## 14. Critical gotchas (the highlight reel)

These bit us before. Don't repeat:

1. **Do not run `drizzle-kit generate` in the Dockerfile** — it auto-creates spurious migrations
2. **Container must run as `node` user** (UID 1000) to write the bind-mounted SQLite file
3. **Migration journal must list every migration file** — Drizzle won't apply unjournaled files
4. **Drizzle stores SHA-256 of the raw migration file content** in `__drizzle_migrations.hash`, not the tag name
5. **Never embed live secrets in committed code** — deploy scripts with credentials are gitignored
6. **`public/` directory must exist** even if empty (keep `.gitkeep`) — Docker COPY will fail otherwise
7. **The `.home` TLD requires `tls internal`** in Caddy — Let's Encrypt can't validate it
8. **Breaking the auth config edge/node split** breaks the middleware bundle — keep `auth.config.ts` import-pure
9. **Statement day = due day** is invalid for credit cards (would mean cycle and grace overlap) — API rejects it
10. **JSX literal `//`** is parsed as a comment by ESLint — wrap in `{"// FOO"}`
11. **`PLAID_ENCRYPTION_KEY` must be exactly 64 hex chars** — `lib/plaid-crypto.ts` throws otherwise. App boots fine; first Plaid action fails loudly.
12. **Never store a plaintext Plaid access token in the DB** — encrypt with `encryptToken()` *before* inserting the row (see `app/api/plaid/exchange/route.ts` for the pattern).
13. **A bill with `paidViaCardId` falls back to cash if the card is archived** — that's intentional (see §17), but means archiving a card silently changes the projection. Watch for it during card cleanup.
14. **Plaid amounts are dollars (float), not cents** — always `Math.round(amount * 100)` when persisting.
15. **Re-linking required to enable Liabilities on existing items** — Plaid bakes products into the access token. Items linked before `Liabilities` was added to `optional_products` won't return liability data. To fix, the user removes and re-adds the institution.
16. **`credit_cards.plaid_account_id` has no DB-level FK** — SQLite ALTER TABLE can't add foreign keys, so referential cleanup is enforced in `deactivatePlaidItem` (nulls the column on linked cards before deactivating). If you add another path that deletes Plaid accounts, mirror that null-out logic.
17. **Statement upsert preserves manual paid records** — `upsertCreditCardStatementByDate` will not overwrite `paidAmountCents`/`paidDate` when Plaid returns no payment data. Cycle date updates still apply. Don't "simplify" this away.

---

## 15. Useful one-liners

```bash
# typecheck just one file
npx tsc --noEmit --project tsconfig.json | grep "path/to/file"

# inspect the live SQLite (read-only safer)
sqlite3 -readonly data/budget.db ".tables"
sqlite3 -readonly data/budget.db "SELECT * FROM users;"

# pull server logs (Python paramiko script)
python scripts/get_logs.py    # (gitignored)

# trigger a manual backup on the server
ssh sandrohp88@plex.bluefalls.home "docker exec budget-backup /usr/local/bin/backup.sh"

# count uncovered checks before committing
npm run check 2>&1 | tail -5

# find every TODO in your changes
git diff main --unified=0 | grep -E "^\+.*TODO"
```

---

## 16. When you're stuck

In rough order of "what to try":

1. **Re-read the relevant section of this file.** Most repeat questions are answered above.
2. **Look at how a similar feature was built.** Credit cards (`app/(app)/credit-cards/`) is the most recent and complete reference for "new entity end-to-end."
3. **Run `npm run check`.** Compiler/lint errors usually point at the exact problem.
4. **Check `app/api/health/route.ts`** to confirm the server is at least booting in dev.
5. **`docker logs budget-app --tail=50`** on the server for production runtime errors.
6. **Search the codebase**: every convention has at least one example. `grep` aggressively.

---

## 17. Plaid integration (bank linking)

Optional add-on that links real bank accounts via **Plaid** so the app can
import transactions and use a live balance as the projection's starting point.
The flow is polling-only — no webhook endpoint, no public callback URL needed.

### Required env vars
```
PLAID_CLIENT_ID         from https://dashboard.plaid.com
PLAID_SECRET            ditto (per-environment)
PLAID_ENV               sandbox | development | production
PLAID_ENCRYPTION_KEY    exactly 64 hex chars; generate with `openssl rand -hex 32`
```
If `PLAID_ENCRYPTION_KEY` is missing or the wrong length, **`encryptToken` /
`decryptToken` throw at first use** — the app boots, but any Plaid action fails
loudly. That's intentional: never silently store unencrypted tokens.

### Token storage
Access tokens are AES-256-GCM encrypted at rest. The `plaid_items` row stores
three hex strings — `access_token_enc`, `access_token_iv` (12 bytes),
`access_token_tag` (16 bytes GCM auth tag). **Plaintext never touches the DB.**
All encrypt/decrypt happens through `lib/plaid-crypto.ts`.

### Tables (see `lib/db/schema.ts`)
- **`plaid_items`** — one row per institution login. Holds the encrypted access token + a `cursor` for incremental sync.
- **`plaid_accounts`** — one row per account under an item (Chase Checking ****4242, etc.). `useAsStartingBalance` opts that account's live balance into the projection.
- **`plaid_transaction_drafts`** — imported transactions awaiting review. `status` flow: `pending_review → approved | dismissed`. `id` = Plaid's `transaction_id` so upserts are idempotent.

### Routes (`app/api/plaid/`)
- `POST link-token` — creates a short-lived (~30 min) Link token for the frontend widget. Requests `Transactions` (required) + `Liabilities` (optional, see "credit card linkage" below).
- `POST exchange` — swaps the public token for a permanent access token, encrypts it, fetches initial accounts
- `GET/PATCH/DELETE items[/id]` — manage connected institutions. DELETE first nulls `credit_cards.plaid_account_id` for any cards linked to this item's accounts (so manual cards survive the unlink).
- `GET/PATCH accounts/[id]` — toggle `syncEnabled` / `useAsStartingBalance`
- `POST accounts/[id]/link-card` — map a Plaid credit-type account to a manual `credit_cards` row. Body: `{ creditCardId }` (link existing), `{ creditCardId: null }` (unlink), or `{ createNew: { name } }` (create + link). On success, immediately runs Liabilities for the parent item so the card has real cycle days + statement before the response returns.
- `POST sync` — pulls new/modified transactions for active items (cursor-based) AND credit-card liabilities for items whose bank supports it
- `GET drafts` + `PATCH drafts/[id]` — list / approve / dismiss

### Sync semantics (`lib/plaid-sync.ts`)
- Uses Plaid's `transactions/sync` cursor API — paginates until `has_more = false`, then persists the cursor.
- **Pending transactions are skipped on add** (we re-pick them up when they post). Modified ones are upserted (preserve idempotency).
- Account balances are refreshed on every sync from the same response.
- Amount sign convention: **positive = expense/debit, negative = refund/credit** (matches Plaid's convention; multiply by 100 and round).

### Credit card linkage (Plaid → `credit_cards`)
A Plaid credit-type account can be **explicitly linked** to one of the user's
manual `credit_cards` rows (or to a freshly-created card) via the
`/accounts` page. The link lives in `credit_cards.plaid_account_id` (nullable,
UNIQUE — one card per Plaid account, one Plaid account per card).

What populates from Plaid Liabilities (`liabilitiesGet`) on every sync:
- **`statementDay` / `dueDay`** — derived from `last_statement_issue_date` and `next_payment_due_date` (just the day-of-month). `updateCardCycleDays` is a no-op when nothing changed.
- **Most recent statement** — upserted into `credit_card_statements` keyed by `(cardId, statementDate)` (unique index from migration 0005). If `last_payment_date >= last_statement_issue_date` and the payment amount covers the statement, it's marked paid.
- A statement that already has `paidAmountCents` set manually is NEVER overwritten by a Plaid sync — manual reconciliation wins. Cycle dates are still updated.

If the bank doesn't support Liabilities (most non-credit-card-issuing banks),
`liabilitiesGet` errors and we log + continue — the link still exists, the
user just keeps editing cycle days manually.

### Why we DON'T auto-create a card on link
Earlier versions auto-created a `credit_cards` row whenever a credit-type
Plaid account appeared, deduping by name. That broke when users had existing
manual cards (silent duplicates) or when banks reported generic names ("Apple
Card"). Now nothing gets auto-created — the user explicitly picks "link to
existing" or "create new" via the `/accounts` page chooser.

### "Use as starting balance" opt-in
In `lib/projection-server.ts`, if any of the user's accounts has
`useAsStartingBalance = true`, `getPrimaryLinkedBalance(userId)` returns its
live balance and that **overrides** `settings.startingBalanceCents` for the
projection. If none is set, the manual setting wins. The override is
all-or-nothing — there's no partial blend.

### Bills paid via credit card (`bills.paidViaCardId`)
Independent of Plaid but landed in the same release. A bill can be flagged as
"paid by credit card X" — the projection then **skips it as cash** because
the card's statement payment will carry it (avoids double-counting). If the
linked card is later archived, the bill **falls back to cash** in the
projection so a recurring obligation never disappears silently. See the filter
in `lib/projection-server.ts` (`cashBills`).

### Adding Plaid features — recipe
1. New repo function in `lib/repos.ts` (always user-scoped).
2. New Zod schema in `lib/validation.ts`.
3. New route under `app/api/plaid/...` — `ensureUser()`, `readJson(req, schema)`, then call into `lib/plaid-sync.ts` or `lib/repos.ts`. Never construct a `PlaidApi` directly — go through `getPlaidClient()`.
4. If a new field needs storing → schema + migration + journal entry per §7.
5. UI hook in `app/(app)/accounts/accounts-client.tsx`.

### Don't
- ❌ Don't log access tokens (encrypted or plaintext) — `lib/log.ts` is fine for everything else.
- ❌ Don't store the plaintext access token even briefly in the DB — encrypt before insert in the same function.
- ❌ Don't bypass `getPlaidClient()` — it lazy-validates env vars and surfaces clear errors.
- ❌ Don't add a webhook endpoint without explicit need — sync-on-load is enough for a single-family deploy and avoids exposing a public ingress.

---

## 18. Updating this file

When you discover a non-obvious thing — a gotcha, a convention, a recipe —
**add it here** in the appropriate section. The next session (you, or another
agent) will thank you. Keep it concise: a line or two per gotcha, a
numbered checklist for recipes.

Bias toward the specific and actionable. Generic advice ("write good code")
helps no one. Concrete patterns ("always use `<Money cents={n} />`") do.
