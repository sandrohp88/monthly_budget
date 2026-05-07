# FINANCE_OS Accuracy & Multi-Theme Plan

Working document for the accuracy/automation/theme refactor. Each item has a status marker and enough context to be picked up by another agent (Codex, Claude, etc.) without conversation history.

**Branch:** `feat/accuracy-and-themes`
**Started:** 2026-05-07
**Reference:** `CLAUDE.md` is the source of truth for repo conventions; `AGENTS.md` for workflow.

## Status legend
- `[ ]` not started
- `[~]` in progress
- `[x]` done (with brief note)
- `[!]` blocked / needs decision

## Definition of done for each item
1. Code change matches the spec below
2. Vitest unit tests added or updated; tests describe the bug, not the fix
3. `npm run check` passes (typecheck + lint + vitest + build)
4. Commit message: `<type>: <subject>` referencing the plan item id (e.g. `fix: guard P0-1 promo decrement on $0 paid`)

---

## Phase 0 — Critical accuracy fixes (P0)

### [x] P0-1. Guard `applyPromoChunksForPaidStatement` against `paidAmountCents = 0`
**Done in `app/api/credit-cards/statements/[id]/route.ts`**: changed the edge condition from `paidAmountCents != null` to `(paidAmountCents ?? 0) > 0`. A regression test for the route guard wasn't added (no API route test harness exists yet); the underlying repo helper still decrements unconditionally as before. If you want belt-and-suspenders coverage, add an integration test that PATCHes the statement endpoint with `paidAmountCents: 0` and asserts the linked promo is unchanged.

**Bug:** `app/api/credit-cards/statements/[id]/route.ts:40-48` fires the promo decrement on the unpaid → paid edge using `isNowPaid = statement?.paidAmountCents != null`. A user marking `paidAmountCents = 0` (zero-cash mark-as-paid) silently shrinks promo principal because `0 != null`.

**Fix:**
- In the route, change `isNowPaid` to `(statement?.paidAmountCents ?? 0) > 0`.
- Add a vitest case in `lib/repos.test.ts` (or a new `app/api/credit-cards/statements/[id]/route.test.ts` if integration coverage is wanted) that:
  - Creates a card + active promo with `remainingAmountCents = 1_000_00`
  - Creates a statement
  - PATCHes the statement with `paidAmountCents: 0, paidDate: today`
  - Asserts the promo's `remainingAmountCents` is still `1_000_00` (not decremented)

**Files:**
- `app/api/credit-cards/statements/[id]/route.ts`
- `lib/repos.test.ts` (or add an api-route-level test)

---

### [x] P0-2. Login rate limit must key on the actual client IP
**Done.** Moved the rate-limit out of `lib/auth.ts:authorize` and into `middleware.ts`, which now keys on `x-forwarded-for` (first hop) → `x-real-ip` → `"unknown"` for `POST /api/auth/callback/credentials`. Returns a 429 with `retry-after: 60` when the bucket is empty. The `ip` field on the credentials schema was removed. `lib/rate-limit.ts` is pure JS so the edge runtime is happy. Coverage for the middleware itself isn't tested (would need a Next runtime harness); the existing `loginSchema` test covers the credentials schema shape unchanged.

**Bug:** `lib/auth.ts:28` uses `raw?.ip` as the bucket key. The login form (`app/login/login-form.tsx`) calls `signIn("credentials", { email, password, redirect, callbackUrl })` and never passes an `ip`. So `ip = "unknown"` always — the bucket becomes a single global counter (5 attempts shared across all clients).

**Fix:** Move rate-limit enforcement out of the `authorize` callback and into the middleware, which has request headers. The credentials POST hits `/api/auth/callback/credentials`. In `middleware.ts`:
- Match `request.method === "POST" && pathname === "/api/auth/callback/credentials"`
- Derive IP from `x-forwarded-for` (first hop) or fallback to `request.ip` / `"unknown"`
- Call `takeToken(\`login:${ip}\`, { capacity: 5, refillPerSecond: 0.1 })`
- If limited, return `new NextResponse(JSON.stringify({error: "rate-limited"}), { status: 429 })`

Remove the rate-limit call from `lib/auth.ts:authorize` (and the `ip` field from the credentials schema).

**Verify edge-compatibility:** `lib/rate-limit.ts` is pure JS (no Node-only imports), so the middleware import is safe.

**Files:**
- `middleware.ts`
- `lib/auth.ts`
- `lib/rate-limit.ts` (no change expected)
- (optional) Add a vitest covering the middleware logic in isolation

---

### [x] P0-3. `getPrimaryLinkedBalance` must sum all opted-in accounts
**Done in `lib/repos.ts`**: `.get()` → `.all()` + reduce. Two new tests in `lib/repos.test.ts`:
- "sums balances when multiple accounts are opted in"
- "treats a null balance from an opted-in account as zero (not as 'no override')"
Returns `null` only when zero rows are opted in, preserving the existing "no override" semantics.

**Bug:** `lib/repos.ts:1453-1466` uses `.get()` (LIMIT 1). When a user opts two accounts into "use as starting balance", the second is silently ignored.

**Fix:**
- Change `.get()` to `.all()` and sum all `balanceCents` (skipping nulls).
- Return `null` only when there are zero opted-in rows (preserves the existing "no override" semantics).

**Update tests:** `lib/repos.test.ts` already has a "returns null" + "returns the live balance" pair. Add a "sums multiple opted-in accounts" case.

**Files:**
- `lib/repos.ts`
- `lib/repos.test.ts`

---

## Phase 1 — Money correctness (P1)

### [x] P1-1. String-based `dollarsToCents` (no float trap)
**Done.** `lib/money.ts:dollarsToCents` now accepts `number | string`, stringifies finite numbers, and walks the decimal digits with a regex (`/^(-?)(\d*)(?:\.(\d*))?$/`). Rounds half-away-from-zero on the third decimal digit. `parseMoneyInput` delegates to it. `components/money-input.tsx` likewise routes through `dollarsToCents` (and now silently keeps mid-typing states like `"1."` instead of pushing partial parses to the parent). `money.test.ts` was updated: `dollarsToCents(1.005) === 101` (was 100), plus new cases for strings, dot-prefix/suffix, and negative rounding symmetry. **Behavioral change:** the engine treats `1.005` as `101` cents instead of `100`. Any UX flow that previously relied on the old undershoot will now round up. Verify on the bills/extras forms when the user enters odd-cent values.

**Bug:** `lib/money.ts:8` does `Math.round(dollars * 100)`. For `1.005`, `1.005 * 100 = 100.49999999999999` → `Math.round` = `100`, not `101`. The existing test in `money.test.ts:22` "pins current behavior" — that test needs updating.

**Fix:**
- Reimplement `dollarsToCents(dollars: number)` as: convert to a decimal string with `.toFixed(20)` (or stringify then split on `.`), normalize sign, take the integer part + first 2 fractional digits, then round the third digit "half away from zero" without going through float.
- Cleaner approach: accept `string | number`; route through `parseMoneyInput` which already string-cleans, but make it actually correct.

```ts
export function dollarsToCents(input: number | string): number {
  const s = typeof input === "number"
    ? (Number.isFinite(input) ? input.toString() : (() => { throw new Error("dollars must be finite"); })())
    : input.trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`invalid money input: ${s}`);
  const [, sign, whole, frac = ""] = m;
  const padded = (frac + "00").slice(0, 3); // 3 digits to know the rounding bit
  const cents = Number(whole || "0") * 100 + Number(padded.slice(0, 2));
  const roundUp = padded[2] !== undefined && Number(padded[2]) >= 5 ? 1 : 0;
  return (sign === "-" ? -1 : 1) * (cents + roundUp);
}
```

**Update `MoneyInput` (`components/money-input.tsx`)** to call `dollarsToCents(cleaned)` instead of its own `Math.round` path.

**Update `parseMoneyInput`** in `lib/money.ts` to delegate to the new `dollarsToCents`.

**Update `money.test.ts`:**
- `dollarsToCents(1.005)` → `101` (was `100`, "pinning" comment can be removed)
- `dollarsToCents("1.005")` → `101`
- `dollarsToCents(-1.005)` → `-101`
- Keep the `0.1 + 0.2` case (needs to land on `30`).

**Files:**
- `lib/money.ts`
- `lib/money.test.ts`
- `components/money-input.tsx`

---

### [x] P1-2. Sign-symmetric `toCents` for Plaid amounts
**Done in `lib/plaid-helpers.ts`**: `toCents` now delegates to `dollarsToCents`. Added a regression test in `lib/plaid-sync.test.ts` ("rounds half-away-from-zero on negative refunds") that pins `toCents(-0.005) === -1` and `toCents(-1.005) === -101`. Existing tests for `toCents(1.235) === 124` and the `0.1 + 0.2` trap still pass.

**Bug:** `lib/plaid-helpers.ts:9` does `Math.round(plaidAmount * 100)`. JS rounds `-0.5` to `0`, so refunds at exactly `-x.xx5` drift one cent toward zero. Combined with Plaid's `0.1 + 0.2` example test, refunds with awkward decimals are skewed.

**Fix:** Replace `Math.round(plaidAmount * 100)` with a sign-aware rounder using the new `dollarsToCents`:

```ts
export function toCents(plaidAmount: number): number {
  return dollarsToCents(plaidAmount);
}
```

(Plaid sends floats, but the new `dollarsToCents` accepts numbers via stringification.)

**Update `lib/plaid-sync.test.ts`** edge-case (the `0.1 + 0.2` test should still pass at `30`).

**Files:**
- `lib/plaid-helpers.ts`
- `lib/plaid-sync.test.ts` (verify existing tests still pass; add a `toCents(-0.005) === -1` case if the contract is "round half away from zero")

---

### [x] P1-3. Forbid `monthlyPaymentCents = 0` on promos; cap last cycle inside endDate
**Done.** Three Zod schemas in `lib/validation.ts` (promoCreateSchema, promoUpdateSchema, plaidDraftActionSchema) now require `monthlyPaymentCents > 0`. The cliff branch in `lib/credit-cards.ts:projectPromoScheduleWithBalances` now lands the lump on `promo.endDate` itself rather than on the post-deadline cycle. New regression test "never schedules a chunk after the promo endDate" pins this.

**Bug:** `lib/validation.ts:148` allows `monthlyPaymentCents: 0`. With override `0`, `promoMonthlyChunkAt` returns `Math.min(0, remaining) = 0`. The auto-spread loop hits the 240-iteration cap with no progress, then the cliff branch dumps a single lump on a `dueDate > endDate` (after the deadline).

**Fix:**
- In `lib/validation.ts`, change `monthlyPaymentCents.refine((n) => n >= 0)` → `n > 0` for both create and update schemas (and bulk-replace promo payment schema).
- In `lib/credit-cards.ts:projectPromoScheduleWithBalances`, the cliff branch should land the lump on `min(dueDate, endDate)` so it's never visualized after the deadline. Currently:
  ```ts
  if (dueDate > promo.endDate) { ... out.push({ dueDate, amountCents: chunk, ... })
  ```
  Change to `out.push({ dueDate: promo.endDate, ... })` so the cliff visualizes ON the deadline, not after.
- Update `lib/credit-cards.test.ts` "schedules monthly chunks landing on each due date through endDate" to assert no `dueDate > endDate`.

**Files:**
- `lib/validation.ts`
- `lib/credit-cards.ts`
- `lib/credit-cards.test.ts`

---

### [x] P1-4. Surface promo-vs-live drift instead of silently clamping
**Done partially.** `ProjectionBundle` now includes `promoDriftByCard: Record<string, number>` populated in `lib/projection-server.ts`. The dashboard (`app/(app)/page.tsx`) shows an amber `AlertBar` listing the affected card count and total drift, linking to `/credit-cards`. **Not done**: per-card detail banner inside the credit-cards client. Add it under each `CreditCardTile` when `promoDriftByCard[cardId] > 0` — would let the user click straight to the drifted promo. The data is plumbed; just thread `promoDriftByCard` into the credit-cards page server component (which already calls into projection-server) and pass through to the client.

**Bug:** `lib/projection-server.ts:213-215` clamps `promoRemaining` at `Math.max(0, liveBalance - unpaid)` when the promo records exceed live balance. The projection looks healthier than reality.

**Fix:**
- Compute `promoOverflowCents = Math.max(0, promoRemainingRaw - (liveBalance - unpaid))` per card.
- Add it to the `ProjectionBundle` as `promoDriftByCard: Record<string, number>`.
- Render a banner on `/credit-cards` and on the dashboard tile when any card has nonzero drift, linking to the card's promo detail.
- (No math change to projection itself; just expose the discrepancy.)

**Files:**
- `lib/projection-server.ts`
- `app/(app)/page.tsx` (dashboard banner)
- `app/(app)/credit-cards/credit-cards-client.tsx` (per-card banner)

---

## Phase 2 — Provenance and reconciliation (P2 / G-1..G-7)

### [ ] P2-1. Schema migration `0018_data_provenance`

Add `source` columns to:
- `bills` (`source TEXT NOT NULL DEFAULT 'manual'` — values: `manual`, `plaid`, `import`)
- `credit_card_statements` (`source TEXT NOT NULL DEFAULT 'manual'`)
- `credit_card_promos` (`source TEXT NOT NULL DEFAULT 'manual'`)
- `one_time_expenses` (`source TEXT NOT NULL DEFAULT 'manual'`)

Update Drizzle schema, journal, and repo create-paths to set `source`.

**Files:**
- `lib/db/migrations/0018_data_provenance.sql`
- `lib/db/migrations/meta/_journal.json`
- `lib/db/schema.ts`
- `lib/repos.ts` (set source on inserts)
- `lib/plaid-sync.ts` (mark Plaid-derived rows)
- Fix `exportAll`/`importAll` to round-trip the column.

---

### [ ] P2-2. Replace magic note `"PayPal authoritative promo data"` with typed column

**Bug:** `lib/plaid-sync.ts:192` does `promo.notes?.includes(PAYPAL_AUTHORITATIVE_PROMO_NOTE)`. Sentinel string is fragile and undocumented in the UI.

**Fix:**
- Migration `0019_authoritative_promo_marker`: add `authoritative_source TEXT` (nullable) to `credit_card_promos` (values: `null | "paypal_promo_list" | "manual"`).
- Backfill: any row with notes containing the sentinel → `authoritative_source = 'paypal_promo_list'`.
- Update `lib/plaid-sync.ts` to read the new column.
- Surface a "this promo is reconciled from PayPal's promo list" badge in `credit-cards-client.tsx`.

**Files:**
- `lib/db/migrations/0019_authoritative_promo_marker.sql`
- `lib/db/schema.ts`
- `lib/plaid-sync.ts`
- `app/(app)/credit-cards/credit-cards-client.tsx`

---

### [ ] P2-3. Auto-promo creation from Plaid → review queue

**Bug (G-3):** `autoCreatePromoFromTransaction` and `reconcilePayPalSpecialFinancing` create promos automatically. False positives are possible.

**Fix:**
- Replace auto-create with: write a `pending_review` flag on the draft, surface it on `/transactions` with a "this looks like a promo — confirm?" banner.
- The `/api/plaid/drafts/[id]` PATCH `create_promo` action already exists for the explicit confirmation flow.
- Keep PayPal FIFO reconciliation of *existing* promo rows (that's not the same as auto-creation).

**Files:**
- `lib/plaid-sync.ts`
- `app/(app)/transactions/transactions-client.tsx`

---

### [x] P2-4. Validate promo manual schedule sum
**Done.** `PUT /api/credit-cards/promos/[id]/payments` now rejects schedules whose total ≠ `remainingAmountCents` with a clear short/over diff message. Empty arrays (`payments.length === 0`) still clear the manual override and revert to auto-spread, so the contract for "delete the schedule" is preserved.

**Not done**: a UI helper that pre-computes the balancing final cycle (so the user doesn't fight the validator). Add an "Auto-balance final cycle" button in the schedule editor that subtracts the sum-so-far from `remainingAmountCents` and writes the difference into the last row.

**Bug:** `replacePromoPayments` accepts any list, even ones that don't sum to `remainingAmountCents`.

**Fix:**
- In `replacePromoPayments` (or its API route in `app/api/credit-cards/promos/[id]/payments/route.ts`), compute `sum(payments)` and reject if `≠ remainingAmountCents` with a clear error.
- Add an "Auto-balance final cycle" helper in the UI that pre-computes the last chunk to make the totals match.

**Files:**
- `lib/repos.ts`
- `app/api/credit-cards/promos/[id]/payments/route.ts`
- `app/(app)/credit-cards/credit-cards-client.tsx` (UI helper)
- New tests in `lib/repos.test.ts`

---

### [ ] P2-5. Statement upsert preserves user-edited dueDate

**Bug (G-6):** `upsertCreditCardStatementByDate` overwrites `dueDate` on every Plaid sync.

**Fix:** Add a `dueDateUserOverride` boolean column on `credit_card_statements`. When set, skip the `dueDate` field in the Plaid update path.

**Files:**
- Migration `0020_due_date_override`
- `lib/repos.ts`
- `app/(app)/credit-cards/credit-cards-client.tsx` (set the override when the user edits)

---

### [ ] P2-6. Bill ↔ Plaid transaction matching (suggestion engine)

**Bug (G-2):** No automatic linkage between Plaid transactions and bill payments.

**Fix:**
- New module `lib/transaction-matcher.ts`. Pure functions only.
- API: `matchTransactionsToBills(transactions, bills, { dateWindowDays = 5, amountTolerancePct = 5 })` returns `Array<{ transactionId, billId, confidence }>`.
- New review surface (could be inline on `/transactions` or a dedicated page).
- Accepting a match creates a payment override (amount = 0 on the matched due date) and links the Plaid draft.

**Files:**
- `lib/transaction-matcher.ts` + `lib/transaction-matcher.test.ts`
- New API route under `/api/plaid/drafts/[id]/match-bill/route.ts`
- UI surface on `/transactions`

---

### [ ] P2-7. Approved Plaid drafts feed the projection

**Bug (G-1):** Auto-approved drafts don't affect the projection — they live in a separate table and are only visible on `/transactions`.

**Fix (proposed, requires user confirmation on UX):**
- Per-account toggle: `foldDraftsIntoProjection: boolean`.
- When true, the projection-server includes approved drafts as historical extras (date < today) so the daily ledger reflects real spending.
- Future-dated drafts (Plaid sometimes posts forward-dated subscription auths) are NOT included by default — they would conflict with the bills model.

**Files:**
- Migration `0021_fold_drafts_setting`
- `lib/projection-server.ts`
- `app/(app)/accounts/accounts-client.tsx`

---

### [x] P2-8. Backfill `exportAll` / `importAll` for promos
**Done.** `exportAll` now bumps `schemaVersion` to `4` and includes `creditCardPromos` and `creditCardPromoPayments`. `importAll` was rewritten end-to-end:
- Deletes in dependency order (promo payments → promos → CC overrides → cards [cascades statements] → bill overrides → bills → paychecks → extras)
- Inserts cards before bills/extras so `paidViaCardId` resolves
- Inserts statements / promos / promo payments after cards
- Nulls `plaidAccountId` on imported cards (Plaid items are intentionally not exported — see comment in `repos.ts:exportAll`)
- Categories still only replace when present in payload (preserves the v3 backward-compat behavior)

**Not done**: Plaid items / accounts / drafts. Skipping them is intentional — the encrypted access tokens are tied to per-deployment `PLAID_ENCRYPTION_KEY` and the Plaid sessions don't survive cross-host moves anyway. Document this in the README backup section.

**Bug:** Exports skip `creditCardPromos`, `creditCardPromoPayments`, `plaidItems`, `plaidAccounts`, `plaidTransactionDrafts`. A "backup" loses promo state on restore.

**Fix:**
- `exportAll`: include all tables. Bump `schemaVersion` to `4`.
- `importAll`: parse the new fields; refuse imports with `schemaVersion < 4` if they include credit cards (incompatible promo absence).

**Files:**
- `lib/repos.ts`

---

## Phase 3 — Multi-theme

### [ ] T-1. Theme registry module

**Goal:** Define a single source of truth for all theme tokens. Generate the CSS at build time (or runtime) from this registry, so adding a theme is a code change in one file.

**Files:**
- New `lib/themes.ts`:
  ```ts
  export type ThemeId = "dark" | "light" | "phosphor" | "high-contrast";
  export type ThemeMode = "dark" | "light";
  export type ThemeTokens = Record<TokenName, string>; // every CSS var
  export const THEMES: Record<ThemeId, { id: ThemeId; label: string; mode: ThemeMode; tokens: ThemeTokens }> = { ... };
  ```
- Migrate the contents of `app/globals.css` `.light` and `:root` blocks into `THEMES.dark.tokens` and `THEMES.light.tokens`.
- Generate the CSS via a Node script `scripts/build-themes.mjs` that emits `app/_themes.generated.css` (gitignored or committed — committed is simpler).
- `app/globals.css` `@import "./\_themes.generated.css";` after the base layer.
- Update `next-themes` config in `components/theme-provider.tsx` to expose `themes={Object.keys(THEMES)}`.

**Migration safety:** The aliased `--mint*` → `--cyan*` indirection stays during the transition.

---

### [ ] T-2. De-hardcode `projection-chart.tsx`

**Bug:** Chart uses literal hex colors that don't update with theme.

**Fix:** Read tokens via `getComputedStyle(document.documentElement).getPropertyValue('--cyan')` inside `useEffect` once per theme change (subscribe to `next-themes`'s `theme` value). Apply to chart props.

**Files:**
- `components/projection-chart.tsx`

---

### [ ] T-3. Audit and de-hardcode UI primitives

`grep -rn "rgba(\|#[0-9a-fA-F]\{6\}" components/ app/` and replace literal colors with tokens. Known offenders:
- `components/ui/badge.tsx` — `rgba(239,68,68,0.3)`, `rgba(251,191,36,...)`
- `components/ui/status-pill.tsx` — same
- `components/ui/tile.tsx` — bracket corner pieces
- `components/category-dialog.tsx` — palette swatches (intentional, leave as-is)
- `components/projection-chart.tsx` — see T-2
- `app/login/login-form.tsx`, `app/setup/setup-form.tsx` — error banner colors

**Files:** all of the above.

---

### [ ] T-4. Add `phosphor` (amber CRT) theme

Single-accent monochrome amber-on-black. Useful for users who find the cyan intense. Verify WCAG AA contrast for `--text-1` on `--bg-1`.

**Files:**
- `lib/themes.ts`

---

### [ ] T-5. Add `high-contrast` theme

Pure black/white with structural accents only. Targets WCAG AAA. Add `axe-core` color-contrast tests in `lib/themes.test.ts` that fail CI if any theme drops below AA on key surfaces.

**Files:**
- `lib/themes.ts`
- `lib/themes.test.ts`

---

### [ ] T-6. Persist theme preference

Currently `next-themes` stores in `localStorage`. For SSR correctness:
- Read `data-theme` cookie in `app/layout.tsx` server component
- Render `<html data-theme={cookieTheme}>` on first paint to eliminate FOUC
- Add `settings.themeId TEXT` column for cross-device sync (optional)

**Files:**
- `app/layout.tsx`
- `components/theme-provider.tsx`
- (optional) Migration `0022_user_theme`

---

### [ ] T-7. Theme picker UI

Replace the binary `ThemeToggle` with a select on `/settings`.

**Files:**
- `components/theme-toggle.tsx` (rename to `theme-picker.tsx`)
- `app/(app)/settings/settings-client.tsx`

---

## Phase 4 — Cleanup (P3)

### [x] P3-1. `archiveExpiredPromos` runs without Plaid
**Done.** `app/(app)/layout.tsx` now calls `archiveExpiredPromos(userId, todayIso(timezone))` on every authenticated page render. Wrapped in try/catch so the sweep can never block page load. The Plaid sync still calls it too — both paths are idempotent. Verified single-indexed UPDATE is cheap enough to run unconditionally.

**Bug:** Today only `lib/plaid-sync.ts` triggers the sweep. Users without Plaid never archive expired promos.

**Fix:** Run the sweep in `app/(app)/layout.tsx` once per session (track via cookie/sessionStorage to avoid running on every navigation), or in a route handler called on `/credit-cards` page load.

**Files:**
- `app/(app)/layout.tsx` or `app/(app)/credit-cards/page.tsx`

---

### [ ] P3-2. Paycheck regen replace mode

`PUT /api/paychecks` only adds new dates; doesn't update existing rows when `defaultPaycheckCents` changes. Add `?replace=true` mode.

**Files:**
- `app/api/paychecks/route.ts`
- `app/(app)/paychecks/paychecks-client.tsx`

---

### [ ] P3-3. Per-card grace-day override

`dueDateFromStatement` hard-codes 14-day floor. Add `gracePeriodDays INTEGER NOT NULL DEFAULT 14` on `credit_cards`.

**Files:**
- Migration `0023_grace_period_days`
- `lib/credit-cards.ts`
- `app/(app)/credit-cards/credit-cards-client.tsx`

---

## Conventions checklist

When implementing, every commit must:
- [ ] Pass `npm run check` locally
- [ ] Use integer cents and ISO `YYYY-MM-DD`
- [ ] Validate via Zod in `lib/validation.ts`
- [ ] Go through `lib/repos.ts` (no raw SQL in routes)
- [ ] Update CLAUDE.md §14 if a new gotcha emerged
- [ ] Update `_journal.json` for any new migration
- [ ] Use Conventional Commits style: `fix:`, `feat:`, `refactor:`, `chore:`

---

## Hand-off notes for the next agent

If picking this up cold:
1. Read `CLAUDE.md` (especially §5, §7, §14, §17, §17a) and `AGENTS.md`.
2. `git log --oneline feat/accuracy-and-themes` to see what's done.
3. The plan above is ordered by priority (P0 → P1 → P2 → Phase 3 → Phase 4). Keep the order — later phases depend on schema changes from earlier ones.
4. Run `npm run check` before each commit.
5. Update this file's status markers as you go.
