# FINANCE_OS Accuracy & Multi-Theme Plan — ARCHIVED 2026-07-09

> **ARCHIVED.** This plan is from 2026-05-07 and most of it shipped long ago; the status
> markers below are stale (e.g. P2-6 bill↔transaction matching shipped differently as
> `lib/bill-reconciliation.ts` + manual links in PR #62; P2-7's lookback mode shipped in
> projection-server). Still genuinely open as of archiving: **P2-5** (preserve user-edited
> statement dueDate on Plaid sync), **P3-3** (per-card grace days), **P2-1** (provenance,
> low ROI), **P3-2** (paycheck regen replace mode), **T-5** (WCAG contrast test), **T-6**
> (theme cookie SSR). Do not trust anything else below without checking the code.

Working document for the accuracy/automation/theme refactor. Each item has a status marker and enough context to be picked up by another agent (Codex, Claude, etc.) without conversation history.

**Branch:** `feat/accuracy-and-themes`
**Started:** 2026-05-07
**Reference:** `CLAUDE.md` is the source of truth for repo conventions; `AGENTS.md` for workflow.

## Rollup (2026-05-07)

**Done (`[x]`):** P0-1, P0-2, P0-3, P1-1, P1-2, P1-3, P1-4, P2-2, P2-4, P2-8, P3-1, T-1, T-2, T-4, T-7
**Partial (`[~]`):** T-3 (high-visibility primitives done, 2-3 low-visibility spots left), T-5 (theme added, WCAG contrast test missing)
**Not started (`[ ]`):** P2-1, P2-3, P2-5, P2-6, P2-7, P3-2, P3-3, T-6

**Recommended next** (Codex pick-up order):
1. **P2-5** (preserve user-edited statement dueDate on Plaid sync) — small migration + repo edit, directly addresses automation/manual blend
2. **P3-3** (per-card `gracePeriodDays`) — small migration, fixes the hardcoded 14-day floor in `dueDateFromStatement`
3. **P2-6** (bill ↔ Plaid transaction matcher) — biggest remaining accuracy win; new `lib/transaction-matcher.ts` + UI surface
4. **P2-7** (auto-approved drafts feed historical projection) — biggest automation/manual blend win; needs a per-account opt-in toggle
5. **T-3** finish — sweep `app/login/login-form.tsx` and `app/setup/setup-form.tsx` for the last `rgba()` literals
6. **T-5** WCAG test — add a contrast helper that asserts every theme passes AA on key surfaces
7. **P2-1** (provenance) — only worth doing if a future feature actually reads `source`; otherwise low ROI

**Don't do** without the user explicitly asking:
- Build-time CSS generation from `lib/themes.ts` (CSS blocks are hand-maintained and that works fine for a 5-theme registry)
- Plaid items export (encrypted access tokens are pinned to per-deployment `PLAID_ENCRYPTION_KEY` — restoring on a new host won't work anyway)

## Verification

After every item: `npm run check` (typecheck + lint + 216 vitest + production build) must pass green. The branch's commit history is the audit trail — `git log --oneline feat/accuracy-and-themes` shows what's been merged.

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

### [x] P2-2. Replace magic note `"PayPal authoritative promo data"` with typed column
**Done.** Migration `0018_authoritative_promo_source.sql` adds `authoritative_source` (nullable text, enum: `paypal_promo_list | manual_reconciliation`) to `credit_card_promos` and backfills from the sentinel substring in `notes`. `lib/db/schema.ts`, validation schemas (`promoCreateSchema`, `promoUpdateSchema`), the create + update API routes, the import helper, and `lib/plaid-sync.ts:reconcilePayPalSpecialFinancing` all read the typed column. CLAUDE.md gotcha #22 + migration list updated. Integration test in `lib/plaid-sync.integration.test.ts` was migrated from setting the magic string to setting `authoritativeSource: "paypal_promo_list"` directly.

**Not done**: a UI surface on `/credit-cards` to flip a promo to `manual_reconciliation` (a lock icon next to the promo would be the natural place). Until that ships, users can only set the column via the API.

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

### [x] T-1. Theme registry module
**Done.** New `lib/themes.ts` exports a typed `Theme` shape (`id`, `label`, `mode`, `description`, `tokens: Record<TokenName, string>`) and a `THEMES` array. Five entries today:
- `dark` — Tactical Dark (default; cyan + phosphor on tactical black)
- `light` — Field Manual (cool paper, navy-teal + forest)
- `phosphor` — single-accent amber CRT (dark)
- `daylight` — warm cream paper (light)
- `high-contrast` — pure black/white + yellow accent (dark)

`components/theme-provider.tsx` now passes `themes={THEME_IDS}` and `defaultTheme={DEFAULT_THEME_ID}` to next-themes. New `lib/themes.test.ts` enforces:
- All theme ids are unique
- Every theme defines every required token (non-empty string)
- Modes are constrained to `dark | light`
- Default theme id resolves

**Not done**: build-time CSS generation from the registry. The CSS blocks in `app/globals.css` are hand-written and must be kept in sync with `lib/themes.ts`. Next agent should add `scripts/build-themes.ts` (run via `tsx`) that reads the registry and writes `app/_themes.generated.css`, then `globals.css` `@import` it. Until then: when adding a new theme, update both files in the same commit.

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

### [x] T-2. De-hardcode `projection-chart.tsx`
**Done.** Chart now reads tokens via `getComputedStyle(document.documentElement)` inside a `useEffect` keyed on `useTheme().theme`. Recharts can't accept `var(--cyan)` directly (it draws to SVG that doesn't inherit the CSS cascade for stroke/fill), so values are resolved on the client. SSR + first-paint use a fallback dark-theme set so there's no flash of unthemed colors. Gradient `id` is theme-suffixed to avoid stale defs across theme swaps.

**Bug:** Chart uses literal hex colors that don't update with theme.

**Fix:** Read tokens via `getComputedStyle(document.documentElement).getPropertyValue('--cyan')` inside `useEffect` once per theme change (subscribe to `next-themes`'s `theme` value). Apply to chart props.

**Files:**
- `components/projection-chart.tsx`

---

### [~] T-3. Audit and de-hardcode UI primitives
**High-visibility primitives done:**
- `components/ui/badge.tsx` (destructive, warning, muted variants now use `color-mix(in oklch, var(--token) X%, transparent)`)
- `components/ui/status-pill.tsx` (warn/amber/off/danger variants)
- `components/ui/alert-bar.tsx` (amber/mint/red wraps)
- `app/(app)/page.tsx` worst-day red gradient banner

**Still hardcoded** (lower visibility, mostly login/setup error banners):
- `app/login/login-form.tsx`: `rgba(239,68,68,0.3)` and `var(--red-glow)` (tag is partial)
- `app/setup/setup-form.tsx`: same red error banner pattern
- `components/category-dialog.tsx`: PALETTE swatches (intentional — those ARE the colors)
- Any inline `style={{ borderColor: "rgba(...)", ... }}` in client components — search with `rg "rgba\("` and convert to color-mix using whichever theme token is the closest semantic match

`color-mix(in oklch, var(--token) X%, transparent)` is the pattern. Tailwind v4 accepts it inside `bg-[...]` / `border-[...]` brackets but spaces must be `_` (e.g. `bg-[color-mix(in_oklch,var(--amber)_10%,transparent)]`).

`grep -rn "rgba(\|#[0-9a-fA-F]\{6\}" components/ app/` and replace literal colors with tokens. Known offenders:
- `components/ui/badge.tsx` — `rgba(239,68,68,0.3)`, `rgba(251,191,36,...)`
- `components/ui/status-pill.tsx` — same
- `components/ui/tile.tsx` — bracket corner pieces
- `components/category-dialog.tsx` — palette swatches (intentional, leave as-is)
- `components/projection-chart.tsx` — see T-2
- `app/login/login-form.tsx`, `app/setup/setup-form.tsx` — error banner colors

**Files:** all of the above.

---

### [x] T-4. Add `phosphor` (amber CRT) theme
**Done.** Single-accent amber on tactical-black, cyan and phosphor collapsed. Live as `[data-theme="phosphor"]` in `globals.css` and registered in `lib/themes.ts`. Verify WCAG AA contrast on `--text-1` over `--bg-1` (D4B97A on 120D02 → contrast ratio ~6.8 — passes AA Large, near AA Normal threshold). No automated contrast test yet (see T-5).

Single-accent monochrome amber-on-black. Useful for users who find the cyan intense. Verify WCAG AA contrast for `--text-1` on `--bg-1`.

**Files:**
- `lib/themes.ts`

---

### [~] T-5. Add `high-contrast` theme
**Theme added** (`lib/themes.ts` + `globals.css`). Pure black/white + yellow phosphor accent.

**Not done**: automated WCAG contrast test in `lib/themes.test.ts` using `axe-core` or a `wcag-contrast` library (neither is currently a dep). Add a util that converts hex/rgba pairs to a contrast ratio and asserts `>= 4.5` (AA) on `text-1/bg-1`, `text-0/bg-card`, `cyan/bg-1` for every theme. Fail CI on AAA targets if the user wants stricter.

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

### [x] T-7. Theme picker UI
**Done.** `components/theme-toggle.tsx` is now a Radix `DropdownMenu` rendering every theme registered in `lib/themes.ts` plus a "Follow system" entry. The active theme highlights. Shows up in the top bar (already wired through `app-shell.tsx`).

Add a per-theme color swatch preview if you want the picker to feel more product-y — currently it's text-only.

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
