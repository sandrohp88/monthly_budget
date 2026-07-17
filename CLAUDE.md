# CLAUDE.md

Operational guide for AI coding agents (and any new contributor) working on
**FINANCE_OS** — a self-hosted personal/family budget tracker.

> Read this top-to-bottom on first session. Refer back when in doubt.
> Update it whenever you discover a non-obvious convention or learn a
> hard-won lesson — that's how it stays useful.

> **External knowledge base:** this project is also documented in a persistent LLM-wiki at
> `Z:\llm-wiki` — see `Z:\llm-wiki\wiki\projects\monthly-budget\index.md` (links README /
> ARCHITECTURE / DATA_MODEL / CHANGELOG / log.md and the **`proxmox-cluster`** host entity). It
> tracks the *committed* repo, so verify anything load-bearing against current code / the live host
> (since 2026-06-23 the budget app runs in **LXC 125** on the proxmox cluster, tunnel-only at
> `https://budget.sherrera.dev`). After a meaningful change, append a dated entry to the wiki's
> `monthly-budget/log.md` and `Z:\llm-wiki\logs\session_log.md`. (This file, `CLAUDE.md`, remains
> the primary in-repo agent guide.)

---

## 1. What this is

A Next.js 15 app that projects daily cash-flow from paychecks, recurring bills,
one-time expenses, and credit card statements. SQLite-backed, single-binary
deployable. Served tunnel-only at https://budget.sherrera.dev (Cloudflare
Tunnel → loopback app in LXC 125 on the proxmox cluster; the old
`budget.bluefalls.home` LAN vhost was dropped by design on 2026-06-23).

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
npx playwright test        # E2E happy-path (rare; builds + spins localhost:3000)
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
    accounts/              ← linked-bank accounts (Plaid) + link-card chooser
    assets/                ← manual net-worth line items
    bills/                 ← recurring + variable bills, payment overrides
    calendar/              ← month-grid of projection events; day click adds a bill
    credit-cards/          ← wallet view: official card art grid (balance + last digits only);
                             card-dialogs.tsx holds the shared card/statement/promo dialogs
      [id]/                ← per-card detail page: current statement, history, cycle
                             estimate, promos, what-if sheets, edit/archive
    extras/
    ledger/                ← KPIs + projection insights + ledger table
    paychecks/
    projection/            ← filterable projection event table
    reports/               ← category / spend analytics
    settings/
    transactions/          ← Plaid draft review (approve / dismiss / promo) + auto-matched "paid bill" markers
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
  sidebar.tsx              ← nav with `g` + `d/b/a/t/c/p/e/l/j/x/w/r/s` shortcuts (hint auto-generated from NAV);
                             two sections: Core (dashboard/calendar/bills/transactions/accounts) and More (the rest)
  projection-chart.tsx     ← Recharts area chart
  credit-card-visual.tsx   ← wallet card face: official art from public/cards/ (via
                             lib/card-art.ts registry) or a brand-gradient fallback
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
  card-art.ts              ← card-name → official art (public/cards/) + brand fallback
                             + display-name/mask helpers for the wallet UI
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

### Themes
The app ships **6 themes**, registered in `lib/themes.ts` and mirrored as
`[data-theme="<id>"]` blocks in `app/globals.css`. Switched at runtime by
`next-themes` via `<ThemeToggle />` in the topbar; persisted to
localStorage. `lib/themes.test.ts` enforces token exhaustiveness — adding a
new `TokenName` requires every theme to define it.

| ID | Label | Vibe |
|---|---|---|
| `dark` | Tactical Dark | Cyan + phosphor-green on tactical black (default) |
| `light` | Field Manual | Cool field-manual paper, navy-teal + forest |
| `phosphor` | Phosphor CRT | Single-accent amber monochrome — terminal nostalgia |
| `daylight` | Daylight | Warm cream paper for outdoor / glossy-screen reading |
| `olive` | Olive Drab | Field-tactical khaki + mustard accent |
| `high-contrast` | High Contrast | Pure black/white, WCAG-AAA targeting |

Adding a new theme:
1. Append a `<ID>_TOKENS` block + `THEMES` entry in `lib/themes.ts`.
2. Mirror it as a `[data-theme="<id>"]` CSS block in `app/globals.css`,
   defining both the raw palette vars (`--bg-0`, `--cyan`, etc.) AND the
   shadcn HSL bridge (`--background`, `--primary`, etc.) so Button/Dialog
   inherit the new look without per-component edits.
3. The picker auto-renders the new option; `THEME_IDS` flows into
   `<NextThemes themes={...}>` automatically.

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
- `0006_flexible_bill_intervals` — replaces `bills.frequency` / `due_day` / `due_month` with `interval_months` (any positive int: 1=monthly, 3=quarterly, 12=annual, etc.) + `anchor_date` (one ISO occurrence; the projection engine generates the rest from there). Table-rebuild migration; backfills monthly→`(1, '2024-01-DD')` and annual→`(12, '2024-MM-DD')` with day clamped to month length.
- `0007_add_credit_card_promos` — `credit_card_promos` table for promotional financing on credit cards (description, original/remaining cents, start/end dates, optional monthly payment override). See §17a.
- `0008_credit_card_statement_cycles` — `statement_cycle_mode` (`calendar_day | interval_days`) + anchor date + interval days on `credit_cards` for rolling statement cycles.
- `0009_bill_payment_overrides` — `bill_payment_overrides` table, unique `(bill_id, due_date)`: per-occurrence planned amounts.
- `0010_credit_card_payment_overrides` — `credit_card_payment_overrides` table, unique `(card_id, due_date)`.
- `0011_manual_card_balances_and_extra_links` — `credit_cards.current_balance_cents` + `one_time_expenses.paid_via_card_id`.
- `0012_link_plaid_drafts_to_promos` — `plaid_transaction_drafts.linked_promo_id`.
- `0013_auto_approve_plaid_transactions` — synced drafts land `approved` instead of `pending_review`.
- `0014_add_promo_payment_schedule` — `credit_card_promo_payments` table (manual promo schedule; overrides auto-spread in the projection).
- `0015_classify_draft_kind` — `plaid_transaction_drafts.kind` (`expense | card_payment`).
- `0016_archive_expired_promos` — data fix: archive promos past their end date.
- `0017_statement_minimum_payment` — `credit_card_statements.minimum_payment_cents` (PayPal $0-balance statements with a required minimum).
- `0018_authoritative_promo_source` — adds `authoritative_source` (nullable enum: `paypal_promo_list | manual_reconciliation`) to `credit_card_promos`. Replaces the legacy `"PayPal authoritative promo data"` magic string in `notes` with a typed column the sync logic checks. Backfills existing rows from the sentinel substring.
- `0019_add_variable_bills` — `variable_bills` + `variable_bill_cards` (forecast spend landed on card due dates).
- `0020_starting_balance_as_of` — `settings.starting_balance_as_of` (projection anchor; backfilled from `first_payday_date`).
- `0021_add_category_budget` — `categories.budget_amount_cents`.
- `0022_soft_delete_extras_paychecks` — `is_active` on `paychecks` + `one_time_expenses`.
- `0023_add_assets` — `assets` table (manual net-worth lines; not part of the cash projection).
- `0024_settled_by_draft_id` / `0025_settled_by_draft_unique` — `credit_card_statements.settled_by_draft_id` + partial unique index (card-payment reconciliation, PRs #57–59).
- `0026_link_drafts_to_bills` — `plaid_transaction_drafts.linked_bill_id` (manual transaction→bill link; reconciliation treats the draft as paying that bill and learns its descriptor as an alias for future months). No DB-level FK — SQLite ALTER TABLE can't add one; bills are archived, never deleted.
- `0027_statement_due_date_override` — `credit_card_statements.due_date_user_override` (set when the user edits a due date by hand; Plaid liability syncs then stop overwriting it — manual wins, same principle as paid records).
- `0028_card_grace_period_days` — `credit_cards.grace_period_days` (per-card statement→due grace, default 14; feeds `dueDateFromStatement` everywhere instead of the old hardcoded floor).
- `0029_paycheck_settled_by_draft` — `paychecks.settled_by_draft_id` + partial unique index (deposit-to-paycheck auto-reconciliation; a deposit draft settles at most one paycheck, ever — mirror of 0025).

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

### Where it lives (since the 2026-06-23 cluster consolidation)
- **Server**: **LXC 125 `budget`** (`10.10.88.25`) on the proxmox cluster (pve-7050) — migrated off `plex`
- **Deploy directory**: `/opt/budget`
- **Public URL**: **`https://budget.sherrera.dev`** via the **`bluefalls-public` Cloudflare Tunnel**, whose connector moved to **LXC 139 `bluefalls-edge`** on 2026-07-06 (it originally ran in LXC 125). Path: tunnel (LXC 139) → `https://10.10.88.25` (LXC 125 Caddy) → loopback app. **Tunnel-only**: the loopback app rejects other Host headers, so the old `budget.bluefalls.home` LAN vhost was dropped by design. See `Z:\llm-wiki\wiki\projects\bluefalls-edge\index.md`.
- **Containers**: `budget-app` (loopback `:3000`, healthcheck `/api/health`) + `budget-backup` (VACUUM cron). The LXC-125 Caddy at `/opt/budget/Caddyfile` fronts budget for the tunnel hop AND the other `*.bluefalls.home` LAN vhosts — never rebuild/restart it casually.
- Full host detail: `Z:\llm-wiki\wiki\entities\proxmox-cluster.md`

### How to deploy
The deploy script is `scripts/redeploy.py` (gitignored; rewritten 2026-07-07 for
LXC 125). It packages **committed HEAD** with `git archive`, ships it via
`scp` to `pve7050` (root, key auth from `~/.ssh/config`), `pct push`es into
LXC 125, extracts over `/opt/budget`, then builds and recreates the app.
**Always `npm run check` first** so you don't ship broken code.

```bash
python scripts/redeploy.py   # no paramiko/passwords — uses the pve7050 ssh alias
```

Two hard-won gotchas baked into the script:
- The compose file's `app` service is `image: budget-app:latest` with **no
  `build:` section**, so `docker compose up --build` is a **silent no-op**.
  The image must be built explicitly: `docker build -t budget-app:latest .`
  then `docker compose up -d app`.
- Never rebuild/restart the `caddy` service in that compose project — it's the
  shared front door for other `*.bluefalls.home` vhosts.

After deploying, confirm `https://budget.sherrera.dev/api/health` returns 200.
(A plain `127.0.0.1:3000` check on the host returns the host-guard response —
use the public hostname.)

### Container UID mismatch (the lesson)
The container runs as the `node` user (UID 1000) so it can read/write the
volume-mounted `/opt/budget/data` directory which is owned by `sandrohp88`
(also UID 1000). **Don't change this** — see the comment in `Dockerfile`.
If you switch base images, verify the user UID still matches the host owner.

### Backups
The `budget-backup` container runs `scripts/backup.sh` via crond at 03:00
local time. It does `VACUUM INTO` to `/backups/budget-YYYYMMDD-HHMM.db` and
prunes anything older than 14 days. Pull a backup off LXC 125 with `scp`
from `/opt/budget/backups/`. Note: the backup container is read-only —
one-off prod data fixes go through the `budget-app` container's node +
better-sqlite3 instead.

**Offsite copies**: `scripts/pull-backups.ps1` (committed, no secrets — uses
the `pve7050` ssh alias) mirrors the server's backups to
`Z:\backups\monthly-budget` with 60-day retention, so a dead LXC no longer
takes the app and every backup with it. Schedule it on the workstation
(one-time, run as the user):
`schtasks /Create /TN "MonthlyBudget backup pull" /TR "pwsh -NoProfile -File E:\code\monthly_budget\scripts\pull-backups.ps1" /SC DAILY /ST 07:00`

### TLS / trust
Budget is served through the Cloudflare Tunnel with a public cert — no local
CA trust is needed for `budget.sherrera.dev`. (The old `tls internal` +
`caddy-root.crt` flow only applies to the remaining `*.bluefalls.home`
vhosts on the shared LXC-125 Caddy.)

---

## 11a. Web push (interest alerts)

Installed PWAs get a push when a card due date inside 14 days has no (or
partial) scheduled-payment coverage — the same detector as the dashboard
INTEREST AlertBar (`findUncoveredCardDues`). Moving parts:

- **Env (all three or push stays off):** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT` — generate with `npx web-push generate-vapid-keys`. Keys are
  read at runtime (never baked into the client bundle); rotating them
  invalidates every stored subscription, so devices must re-enable.
- **Storage:** `push_subscriptions` (migration `0031`) — one row per device,
  with `lastDigest`/`lastNotifiedAt` for dedupe.
- **Dispatch:** `lib/push.ts` (I/O) + `lib/push-payload.ts` (pure payload,
  digest, quiet-hours + 24h re-nag decision — unit-tested). Dead
  subscriptions (push service 404/410) are pruned on send.
- **Trigger:** `instrumentation.ts` → `lib/push-scheduler.ts`, an in-process
  hourly timer. The `NEXT_RUNTIME === "nodejs"` check in instrumentation.ts
  must keep its exact form — Next inlines it so the edge build DCEs the
  import chain (web-push/better-sqlite3 don't compile for edge).
- **Client:** `public/sw.js` `push`/`notificationclick` handlers +
  `components/push-notifications-card.tsx` on /settings (enable / disable /
  send test per device).

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
18. **Never infer promo allocation from a statement payment** — PayPal/Plaid payment rows do not identify which deferred-interest purchase received principal. Promo remaining changes only through issuer-list reconciliation or an explicit manual balance edit. See §17a.
19. **Promo chunks never get added to a cycle that has a recorded statement** — the statement balance entered by the user is assumed to already include any promo principal billed in that cycle. `projectPromoSchedule` takes a `skipDueDates` set fed from `recordedDueDatesByCard` in `projection-server.ts`. Skip the skip-set and you double-count.
20. **Plaid promo detection needs raw transaction text at sync time** — drafts only persist a small subset of Plaid's transaction payload. If you need issuer-specific promo clues, inspect nested fields from the live Transaction object (`payment_meta`, `counterparties`, category, location, etc.) before storing the draft; don't infer a promo from generic PayPal `LOAN_PAYMENTS` rows.
21. **PayPal Credit special financing is split across two Plaid accounts** — qualifying purchases appear on the PayPal wallet account (`depository/paypal`), while payments appear on the linked PayPal Credit account (`credit/paypal`) as `LOAN_PAYMENTS`. Purchases at or above `PAYPAL_SPECIAL_FINANCING_THRESHOLD_CENTS` (`lib/paypal-special-financing.ts`, currently PayPal's published $149 minimum) can seed promo rows, but Plaid payment rows do not expose PayPal's targeted promo allocation.
22. **PayPal's promo list beats transaction FIFO** — PayPal's issuer UI exposes actual promotional balances, payoff dates, and targeted paid-off promos that Plaid transaction history does not. When a promo row's `authoritativeSource` column is non-null (introduced in migration `0018`), do not overwrite its amount/date from transaction FIFO; an inactive zero-balance PayPal promo must also stay paid off on later syncs. Legacy rows used a sentinel string `"PayPal authoritative promo data"` in `notes` — `0018` backfills the typed column from that and the sync logic now reads only `authoritativeSource`.
23. **Playwright must use a host allowed by `AUTH_URL`** — middleware rejects unknown `Host` headers with 421. The E2E config builds and serves on `localhost:3000` to match local `.env`; `playwright.config.ts` derives `AUTH_URL` from the port, so on machines where 3000 is unusable (Windows WinNAT excluded port range) run `E2E_PORT=3200 npx playwright test`.
24. **Chase flexible financing: statement rows carry the Interest Saving Balance.** The
    Prime Visa (****9873) runs 0% "Equal Pay" plans, so Chase's pay-to-avoid-interest amount
    (ISB = new balance − flex-plan outstanding + this cycle's plan payments) is far below the
    statement's New Balance. Convention (reconciled 2026-07-11 from real statements): statement
    rows store the **ISB** as `statementBalanceCents` (New Balance goes in `notes`), each Equal
    Pay plan is an authoritative `credit_card_promos` row (`monthlyPaymentCents` = plan payment,
    `endDate` = plan expiration), and the open due-date slot gets a payment override pinned to
    the ISB because a Plaid liabilities sync overwrites the open statement's balance with the
    New Balance (see `upsertCreditCardStatementByDate` — only paid records and due-date
    overrides survive). After each new statement: re-enter the ISB, decrement promo remainings
    from the QUALIFIED PROMOTIONAL FINANCING table, and refresh the slot override. A
    `statement_balance_user_override` column (mirroring 0027's due-date override) would remove
    the monthly manual step — candidate migration 0030.
25. **E2E specs share one test DB per suite run** (wiped once in `global-setup.ts`) — most specs are order-independent, but `credit-card-statement.spec.ts` still assumes a lone card; run it standalone until specs are fully scoped. Keep spec dates relative to today (hardcoded dates rot once the calendar passes them).

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

Every linked card also tracks the Plaid account's non-negative current balance in
`credit_cards.current_balance_cents`. This cached value refreshes on sync and is
initialized immediately when a card is created or linked. The linked card uses
an `interval_days` statement cycle once history can support an inference:

- Prefer the median 26–35-day gap between stored issuer statement dates.
- Otherwise require at least three posted `card_payment` transactions and use
  the median 26–35-day payment gap.
- Anchor to the latest issuer statement. If none exists, estimate the statement
  anchor by subtracting the configured grace period from the latest payment.
- Ignore shorter partial-payment gaps and longer missing-history gaps rather
  than manufacturing an unreliable cycle.

If the bank doesn't support Liabilities (most non-credit-card-issuing banks),
`liabilitiesGet` errors and we log + continue — the link still exists, the
cached balance still refreshes, and transaction history can still infer the
cycle once enough recurring payments have posted.

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

### Bill reconciliation (auto + manual links)
`lib/bill-reconciliation.ts` (pure) matches posted drafts on starting-balance
accounts to generated bill occurrences so paid bills render as PAID markers
instead of pending debits (linked mode only — see the wiring in
`lib/projection-server.ts`). Matching is name-based and conservative; when the
heuristic can't see a match (e.g. two same-utility bills whose names don't
appear in the bank descriptor), the user can **manually link** a transaction
to a bill on `/transactions` (`plaid_transaction_drafts.linked_bill_id`,
PATCH action `link_bill`). Manual links bypass the name gate, win their
occurrence over heuristic candidates, and every linked draft's descriptor
becomes a **learned alias** for that bill (`listBillLinkDescriptors`) so
future months' identically-worded transactions match automatically. The
settle threshold (`SETTLE_MIN_FRACTION`) still applies to linked drafts — a
tiny linked payment won't mark a large bill paid.

### Paycheck reconciliation (deposits → paychecks)
The income-side analog. `lib/paycheck-reconciliation.ts` (pure) matches
approved deposit drafts (negative `amountCents`) on starting-balance accounts
to scheduled paychecks: ±5 days of `payDate`, deposit within 70%–200% of the
planned amount, best-amount-fit one-to-one assignment (two same-day earners
split by amount; the paycheck note is a priority-only text signal). Unlike
bills this PERSISTS: `reconcilePaycheckDeposits` in `lib/plaid-sync.ts` runs
once per sync and calls `settlePaycheckWithDraft` (repos), which sets
`actualReceived` + `actualAmountCents` + `settledByDraftId`. It fires ONLY on
the not-received→received edge (manual reconciliation wins; re-syncs are
no-ops) and consumes each draft at most once — enforced by the partial unique
index from migration 0029. Un-marking received on `/paychecks` (or archiving
the row) clears `settledByDraftId` so the deposit can re-settle — same
release contract as the statements PATCH route. Auto-reconciled rows show an
AUTO pill next to RECEIVED.

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

## 17a. Credit-card deferred-interest promotional financing

A `credit_card_promos` row models a promotional balance with a payoff deadline.
PayPal's "No interest if paid in full" offer is deferred interest, not a true
0% APR installment plan: missing the deadline can cause interest to be charged
back to the purchase date. The projection spreads principal across the remaining
window, and a what-if comparison visualises pay-off-now vs. schedule timing.

### Authoritative-statement rule (READ BEFORE TOUCHING THE PROJECTION)
The whole design hinges on this. **Recorded statements are authoritative for the
cycle they cover.** When the user enters a statement balance, they enter the
full balance reported by the issuer (which already includes any promo chunk
billed in that cycle). The projection therefore:

- Treats unpaid recorded statements as cash debits on their due date for the
  full statement balance — same as before promos existed.
- Adds promo monthly chunks ONLY to **future cycles that don't yet have a
  recorded statement**. Cycles with a recorded statement are skipped via
  `projectPromoSchedule(..., skipDueDates)` to avoid double-counting.
- Subtracts each card's total active promo `remainingAmountCents` from the
  Plaid open-cycle estimate (`liveBalance - unpaidStatements - promoRemaining`)
  so the unbilled promo principal isn't projected as one big lump on the next
  due date.

The math is in `projectPromoSchedule()` and `promoMonthlyChunkAt()` (both in
`lib/credit-cards.ts`); the projection wiring is in `lib/projection-server.ts`
right after the open-cycle-estimate block.

### Interest Saving Balance (the "due to avoid interest" number)
For a card whose issuer statement balance **contains** outstanding 0%-promo
principal (Chase-style Equal Pay/flex plans), the cash needed by the due date
to avoid interest is NOT the full balance — it's

```
ISB = statementBalance − Σ active promo remaining + Σ plan payments billed this cycle
```

floored at the minimum payment (Chase's own rule) and capped at the full cash
due. `interestSavingCashDueCents(statement, promos)` in `lib/credit-cards.ts`
owns this; the due markers, dashboard/wallet/detail dues, `paidWithoutInterest`,
`looksLikePaid`, and `settleStatementWithDraft` matching all run through it, so
paying the ISB reads as "paid, no interest" and auto-reconciles.

**The adjustment only fires when `statementBalance ≥ Σ promo remaining`** — the
tell that the balance embeds the principal. PayPal-style statements (which bill
only the cycle's cash while promo principal lives outside the statement) and
stale unreconciled promo rows fail that check and fall back to the full cash
due. Keep promo `remainingAmountCents` reconciled from the issuer's promo list
(paste flow / manual edit) or the ISB will silently degrade to the full balance.
The open-cycle estimate applies the same guard before subtracting
`promoRemaining` so promo principal isn't subtracted twice (once inside the
unpaid statement, once on its own).

### Authoritative promo balances
Statement payments never decrement `remainingAmountCents`. PayPal controls
payment allocation, and Plaid does not expose the amount applied to each
promotional purchase. The only trustworthy balance mutations are:

- The PayPal Promotional Purchases paste/reconcile flow
  (`authoritativeSource = paypal_promo_list`).
- The Chase flex-plan paste/reconcile flow — a statement's "Qualified
  Promotional Financing" table or chase.com plan list
  (`authoritativeSource = chase_flex_plan_list`). Chase rows also carry the
  purchase total and the fixed plan payment, and are matched to existing
  promos by **expiration date** (statement rows all share one description) —
  parser/matcher in `lib/chase-flex-plan-list.ts`, shared reconcile route +
  dialog with the PayPal flow (format auto-detected from the paste).
- An explicit user edit (`authoritativeSource = manual_reconciliation`).
- Archiving after issuer reconciliation confirms the promo is gone.

Expired promos remain active with their last known balance until one of those
actions occurs. The projection places an expired unreconciled balance on today
instead of deleting it. Never restore an automatic expiration sweep.

### Monthly chunk math
`promoMonthlyChunkAt(promo, asOfIso)` returns the cash amount due in the cycle
containing `asOfIso`:

1. If `monthlyPaymentCents` is set → use it (clamped to `remainingAmountCents`).
2. Otherwise → `ceil(remainingAmountCents / monthsBetweenInclusive(asOfIso, endDate))`.
3. If `asOfIso > endDate` → return the full `remainingAmountCents` (last-chance
   lump so the projection visualises the deadline cliff).

The ceil + clamp combination guarantees that walking the schedule one cycle at
a time decrements `virtualRemaining` to exactly zero by the deadline (no
overshoot, no shortfall). There's a unit test for this in
`lib/credit-cards.test.ts` ("converges to zero by the deadline").

Manual schedules must total the current remaining balance exactly and every
payment must be on or before `endDate`; the payments API enforces both rules.
The projection also ignores post-deadline legacy rows and adds a deadline/today
catch-up for any uncovered legacy balance.

The promo schedule sheet exposes two presets: one full-balance payment on the
issuer payoff deadline, or card-cycle payments through the promotional window.
Both are planning inputs and must still total the issuer-reconciled remaining
balance.

### Calendar card-payment planning
Calendar credit-card events surface `paymentDueCents` as the statement amount
needed to avoid interest, while estimated and deferred-interest events are
labeled as such. Future card events open a payment planner backed by
`credit_card_payment_overrides`; a payment may move earlier but the calendar
flow will not save it after the issuer due date. Moved plans use paired
`moved-to:YYYY-MM-DD` / `moved-from:YYYY-MM-DD` notes, matching the ledger
planner. This only changes Finance_OS cash-flow projections — it never submits
a payment to PayPal or another issuer.

**Scheduled paydowns (`pays-down:` notes).** Any calendar day can also open
PLAN CARD PAYMENT: pick a card + amount + date, saved as an override row whose
notes carry `pays-down:YYYY-MM-DD` (the card's next projected due date).
Unlike a slot override, a paydown is never a replacement: it always debits its
own date as a planned payment, and `projectCardPayments` subtracts it from
whatever the projection charges at the target date (statement, open-cycle
estimate, promo chunk), consumed once per `(card, dueDate)` across generators
so colliding sources never double-subtract. Only paydowns dated **today or
later** reduce their target — once the date passes, reality (posted payments,
statement paid amounts, live balances) is expected to carry the effect, so a
stale plan can't discount a due date forever. Partial amounts split the
obligation: the remainder stays on the due date.

A stored target can also go **stale**: statement reconciliation or cycle-config
edits shift every projected due date after the note is written. A paydown whose
target no longer matches any statement marker, estimated cycle due, or
promo/variable chunk on its card falls back to plain scheduled-payment
coverage (statements earliest-first, then the estimate balance, then promo
prepay) instead of covering nothing. The PLAN dialog also keeps an edited
plan's existing target while that slot still resolves — recomputing it
unconditionally used to retarget the plan away from its due date, because the
next-slot scan saw the plan's own coverage and skipped the marker it was aimed
at (the Prime Visa 9873 bug, 2026-07-15).

### Card-charged bills on the calendar
Bills/extras with `paidViaCardId` pointing at an ACTIVE card are still skipped
as cash, but the projection now emits them as **zero-cash markers**
(`chargedToCardName` on the event, amount 0, original amount preserved) so the
calendar/ledger can show "this lands on card X today" without double-counting.
The dashboard agenda filters them out (cash-in-motion only). Don't give these
events a nonzero `amountCents` — the card's statement payment carries the cash.

### What-if helpers
`promoWhatIf(promo, card, today)` and `cardPromoWhatIf(promos, card, today)`
both return `{ payOffNow, continueSchedule }`. Both totals **always equal the
remaining principal** — interest is zero either way when paid by the deadline.
The difference is cash-flow timing only; that's exactly what the UI sheet
spells out. **Do not turn these into recommendations** ("you should pay X")
— financial advice is off-limits per the action policy. Keep it to the math.

### Don't
- ❌ Don't infer or auto-decrement promo remaining from statement/card payments.
  Reconcile from the issuer list or an explicit user-entered actual balance.
- ❌ Don't archive or zero a promo merely because its deadline passed.
- ❌ Don't add a promo's monthly chunk to the projection for a cycle that
  already has a recorded statement. The statement is authoritative.
- ❌ Don't render prescriptive advice ("pay this off now to save $X") in the
  what-if sheet — only show the cash-flow numbers and let the user decide.
- ❌ Don't compute the promo chunk by raw division — use `Math.ceil` so the
  schedule converges to zero on the last cycle. Plain rounding leaves
  fractional remainders that never go away.

---

## 18. Updating this file

When you discover a non-obvious thing — a gotcha, a convention, a recipe —
**add it here** in the appropriate section. The next session (you, or another
agent) will thank you. Keep it concise: a line or two per gotcha, a
numbered checklist for recipes.

Bias toward the specific and actionable. Generic advice ("write good code")
helps no one. Concrete patterns ("always use `<Money cents={n} />`") do.
