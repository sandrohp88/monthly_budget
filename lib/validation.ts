import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const cents = z.number().int();

export const billCreateSchema = z.object({
  name: z.string().min(1).max(80),
  category: z.string().min(1).max(50),
  amountCents: cents.refine((n) => n >= 0, "Amount must be non-negative"),
  /** Cycle length in months. 1=monthly, 3=quarterly, 12=annual, etc. */
  intervalMonths: z.number().int().min(1).max(120),
  /** One known occurrence; the engine generates the rest from this. */
  anchorDate: isoDate,
  autoPay: z.boolean().default(false),
  paidViaCardId: z.string().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const billUpdateSchema = billCreateSchema.and(
  z.object({ isActive: z.boolean().optional() }),
);

export const billPaymentOverrideSchema = z.object({
  dueDate: isoDate,
  amountCents: cents.refine((n) => n >= 0, "Amount must be non-negative"),
  notes: z.string().max(500).nullable().optional(),
});

export const variableBillCreateSchema = z.object({
  name: z.string().min(1).max(80),
  category: z.string().min(1).max(50),
  amountCents: cents.refine((n) => n >= 0, "Amount must be non-negative"),
  intervalMonths: z.number().int().min(1).max(120),
  anchorDate: isoDate,
  cardIds: z.array(z.string().min(1)).min(1, "Pick at least one card").max(12),
  notes: z.string().max(500).nullable().optional(),
});

export const variableBillUpdateSchema = variableBillCreateSchema.and(
  z.object({ isActive: z.boolean().optional() }),
);

export const variableBillAverageSchema = z.object({
  name: z.string().max(80).optional(),
  category: z.string().max(50).optional(),
  cardIds: z.array(z.string().min(1)).max(12).default([]),
  lookbackMonths: z.number().int().min(1).max(24).default(6),
});

export const creditCardPaymentOverrideSchema = z.object({
  dueDate: isoDate,
  amountCents: cents.refine((n) => n >= 0, "Amount must be non-negative"),
  notes: z.string().max(500).nullable().optional(),
});

export const paycheckCreateSchema = z.object({
  payDate: isoDate,
  amountCents: cents,
  note: z.string().max(120).nullable().optional(),
});

export const paycheckUpdateSchema = paycheckCreateSchema.extend({
  actualReceived: z.boolean().optional(),
  actualAmountCents: cents.nullable().optional(),
});

export const extraCreateSchema = z.object({
  date: isoDate,
  description: z.string().min(1).max(120),
  amountCents: cents,
  category: z.string().min(1).max(50),
  paidViaCardId: z.string().nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const extraUpdateSchema = extraCreateSchema;

export const settingsUpdateSchema = z.object({
  startingBalanceCents: cents,
  /** Date the starting balance was true. See settings.startingBalanceAsOf in schema.ts. */
  startingBalanceAsOf: isoDate,
  defaultPaycheckCents: cents,
  firstPaydayDate: isoDate,
  payFrequencyDays: z.number().int().min(1).max(60),
  projectionMonths: z.number().int().min(1).max(36),
  currency: z.string().length(3),
  timezone: z.string().min(1),
});

export const setupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(80),
  startingBalanceCents: cents,
  startingBalanceAsOf: isoDate,
  defaultPaycheckCents: cents,
  firstPaydayDate: isoDate,
  payFrequencyDays: z.number().int().min(1).max(60),
  projectionMonths: z.number().int().min(1).max(36),
  currency: z.string().length(3),
  timezone: z.string().min(1),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
  role: z.enum(["admin", "member"]).default("member"),
});

export const updateUserSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  role: z.enum(["admin", "member"]).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export const categoryCreateSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be hex like #4ade80"),
  kind: z.enum(["expense", "income"]).default("expense"),
  budgetAmountCents: cents.optional(),
});

export const categoryUpdateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be hex like #4ade80").optional(),
  kind: z.enum(["expense", "income"]).optional(),
  budgetAmountCents: cents.optional(),
});

// ── Assets ────────────────────────────────────────────────────────────────────

const assetCategory = z.enum([
  "real_estate",
  "vehicle",
  "investment",
  "savings",
  "retirement",
  "crypto",
  "other",
]);

export const assetCreateSchema = z.object({
  name: z.string().min(1).max(80),
  valueCents: cents,
  category: assetCategory.default("other"),
  notes: z.string().max(500).nullable().optional(),
  asOfDate: isoDate,
});

export const assetUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  valueCents: cents.optional(),
  category: assetCategory.optional(),
  notes: z.string().max(500).nullable().optional(),
  asOfDate: isoDate.optional(),
  isActive: z.boolean().optional(),
});

const creditCardBaseSchema = z.object({
  name: z.string().min(1).max(80),
  statementDay: z.number().int().min(1).max(31),
  statementCycleMode: z.enum(["calendar_day", "interval_days"]).default("calendar_day"),
  statementCycleAnchorDate: isoDate.nullable().optional(),
  statementCycleIntervalDays: z.number().int().min(1).max(366).default(31),
  dueDay: z.number().int().min(1).max(31),
  /** Days between statement close and payment due (issuer grace period). */
  gracePeriodDays: z.number().int().min(0).max(60).default(14),
  currentBalanceCents: cents.refine((n) => n >= 0, "Balance must be non-negative").nullable().optional(),
  autoPay: z.boolean().default(false),
  notes: z.string().max(500).nullable().optional(),
});

export const creditCardCreateSchema = creditCardBaseSchema.superRefine((v, ctx) => {
  if (v.statementCycleMode === "interval_days" && !v.statementCycleAnchorDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["statementCycleAnchorDate"],
      message: "Anchor date is required for interval cycles",
    });
  }
});

export const creditCardUpdateSchema = creditCardBaseSchema
  .partial()
  .extend({
    isActive: z.boolean().optional(),
  });

const authoritativeSource = z
  .enum(["paypal_promo_list", "chase_flex_plan_list", "manual_reconciliation"])
  .nullable()
  .optional();

export const promoCreateSchema = z
  .object({
    description: z.string().min(1).max(120),
    originalAmountCents: cents.refine((n) => n > 0, "Original amount must be positive"),
    /** Optional on create — defaults to originalAmountCents in the route. */
    remainingAmountCents: cents.refine((n) => n >= 0, "Remaining cannot be negative").optional(),
    startDate: isoDate,
    endDate: isoDate,
    /**
     * When set, used as-is each cycle. When null, projection computes
     * remaining/months_left. Must be > 0 — a 0 override would loop forever
     * making no progress, and a negative override has no meaning.
     */
    monthlyPaymentCents: cents.refine((n) => n > 0, "Monthly payment must be positive").nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    /** When non-null, Plaid sync will not rewrite this row's amounts/dates. */
    authoritativeSource,
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "endDate must be on or after startDate",
    path: ["endDate"],
  });

export const promoUpdateSchema = z
  .object({
    description: z.string().min(1).max(120).optional(),
    originalAmountCents: cents.refine((n) => n > 0).optional(),
    remainingAmountCents: cents.refine((n) => n >= 0).optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    monthlyPaymentCents: cents.refine((n) => n > 0, "Monthly payment must be positive").nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
    authoritativeSource,
  })
  .refine(
    (v) => v.startDate == null || v.endDate == null || v.endDate >= v.startDate,
    { message: "endDate must be on or after startDate", path: ["endDate"] },
  );

export const statementCreateSchema = z.object({
  statementDate: isoDate,
  dueDate: isoDate,
  statementBalanceCents: cents.refine((n) => n >= 0, "Balance must be non-negative"),
  minimumPaymentCents: cents.refine((n) => n >= 0).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const statementUpdateSchema = z.object({
  statementDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  statementBalanceCents: cents.optional(),
  minimumPaymentCents: cents.refine((n) => n >= 0).nullable().optional(),
  paidAmountCents: cents.nullable().optional(),
  paidDate: isoDate.nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export type BillCreateInput = z.infer<typeof billCreateSchema>;
export type BillUpdateInput = z.infer<typeof billUpdateSchema>;
export type VariableBillCreateInput = z.infer<typeof variableBillCreateSchema>;
export type VariableBillUpdateInput = z.infer<typeof variableBillUpdateSchema>;
export type VariableBillAverageInput = z.infer<typeof variableBillAverageSchema>;
export type PaycheckCreateInput = z.infer<typeof paycheckCreateSchema>;
export type PaycheckUpdateInput = z.infer<typeof paycheckUpdateSchema>;
export type ExtraCreateInput = z.infer<typeof extraCreateSchema>;
export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;
export type SetupInput = z.infer<typeof setupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type CategoryCreateInput = z.infer<typeof categoryCreateSchema>;
export type CreditCardCreateInput = z.infer<typeof creditCardCreateSchema>;
export type CreditCardUpdateInput = z.infer<typeof creditCardUpdateSchema>;
export type StatementCreateInput = z.infer<typeof statementCreateSchema>;
export type StatementUpdateInput = z.infer<typeof statementUpdateSchema>;
export type PromoCreateInput = z.infer<typeof promoCreateSchema>;
export type PromoUpdateInput = z.infer<typeof promoUpdateSchema>;

/**
 * Body for POST /api/credit-cards/[id]/promos/reconcile — rows parsed from a
 * pasted issuer promo list (PayPal "Promotional purchases" or a Chase
 * flex-plan table). Applying sets `authoritativeSource` to the source so sync
 * never rewrites the reconciled values. The optional per-row fields only come
 * from the Chase table (Total Qualified / Promo Min Pay columns).
 */
export const promoReconcileSchema = z.object({
  source: z.enum(["paypal_promo_list", "chase_flex_plan_list"]).default("paypal_promo_list"),
  rows: z
    .array(
      z.object({
        description: z.string().min(1).max(120),
        remainingCents: cents.refine((n) => n >= 0, "Remaining cannot be negative"),
        endDate: isoDate,
        originalCents: cents
          .refine((n) => n > 0, "Original amount must be positive")
          .nullable()
          .optional(),
        monthlyPaymentCents: cents
          .refine((n) => n > 0, "Monthly payment must be positive")
          .nullable()
          .optional(),
      }),
    )
    .min(1)
    .max(100),
  /** Archive active promos that are absent from the pasted list. */
  archiveMissing: z.boolean().default(true),
});
export type PromoReconcileInput = z.infer<typeof promoReconcileSchema>;

export const promoPaymentBaseSchema = z.object({
  dueDate: isoDate,
  amountCents: cents.refine((n) => n > 0, "Amount must be positive"),
  note: z.string().max(500).nullable().optional(),
});
export const promoPaymentCreateSchema = promoPaymentBaseSchema;
export const promoPaymentUpdateSchema = promoPaymentBaseSchema.partial();
/** Bulk replace: write the entire schedule for a promo in one call. */
export const promoPaymentBulkReplaceSchema = z.object({
  payments: z.array(promoPaymentBaseSchema).max(120),
});
export type PromoPaymentCreateInput = z.infer<typeof promoPaymentCreateSchema>;
export type PromoPaymentUpdateInput = z.infer<typeof promoPaymentUpdateSchema>;
export type PromoPaymentBulkReplaceInput = z.infer<typeof promoPaymentBulkReplaceSchema>;

// ── Plaid ───────────────────────────────────────────────────────────────────

/** Body sent after Plaid Link completes: public_token + institution metadata. */
export const plaidExchangeSchema = z.object({
  publicToken: z.string().min(1),
  institutionId: z.string().min(1),
  institutionName: z.string().min(1).max(120),
});

/** User action on a single transaction draft. */
export const plaidDraftActionSchema = z
  .object({
    action: z.enum(["approve", "dismiss", "create_promo", "update_transaction", "link_bill"]),
    // approve path — user may override these before confirming
    date: isoDate.optional(),
    description: z.string().min(1).max(120).optional(),
    amountCents: cents.optional(),
    category: z.string().min(1).max(50).optional(),
    notes: z.string().max(500).nullable().optional(),
    // create_promo path — turns an imported linked-card purchase into a promo
    cardId: z.string().optional(),
    originalAmountCents: cents.refine((n) => n > 0, "Original amount must be positive").optional(),
    remainingAmountCents: cents.refine((n) => n >= 0, "Remaining cannot be negative").optional(),
    startDate: isoDate.optional(),
    endDate: isoDate.optional(),
    monthlyPaymentCents: cents.refine((n) => n > 0, "Monthly payment must be positive").nullable().optional(),
    // link_bill path — null clears the link
    billId: z.string().min(1).max(64).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "link_bill") {
      if (v.billId === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["billId"], message: "billId is required (null to unlink)" });
      }
      return;
    }
    if (v.action === "update_transaction") {
      if (!v.description) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["description"], message: "Description is required" });
      }
      if (!v.date) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["date"], message: "Date is required" });
      }
      if (v.amountCents == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountCents"], message: "Amount is required" });
      }
      return;
    }
    if (v.action !== "create_promo") return;
    if (!v.description) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["description"], message: "Description is required" });
    }
    if (!v.cardId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cardId"], message: "Card is required" });
    }
    if (v.originalAmountCents == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["originalAmountCents"], message: "Original amount is required" });
    }
    if (!v.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["startDate"], message: "Start date is required" });
    }
    if (!v.endDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "Payoff date is required" });
    }
    if (v.startDate && v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endDate"], message: "Payoff date must be on or after purchase date" });
    }
    if (v.monthlyPaymentCents != null && v.monthlyPaymentCents <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["monthlyPaymentCents"], message: "Desired payment must be positive" });
    }
    if (
      v.originalAmountCents != null &&
      v.remainingAmountCents != null &&
      v.remainingAmountCents > v.originalAmountCents
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remainingAmountCents"], message: "Remaining cannot exceed original amount" });
    }
  });

/** User-editable per-account settings (toggles). */
export const plaidAccountUpdateSchema = z.object({
  useAsStartingBalance: z.boolean().optional(),
  syncEnabled: z.boolean().optional(),
});

/** Optional item filter for a manual sync request. */
export const plaidSyncSchema = z.object({
  itemId: z.string().optional(),
});

/**
 * Body for POST /api/plaid/accounts/[id]/link-card.
 * - `creditCardId: string` — link to existing card
 * - `creditCardId: null` — unlink the Plaid account from any card
 * - `createNew: { name }` — create a brand new card and link it
 * Exactly one of (creditCardId, createNew) must be provided.
 */
export const plaidLinkCardSchema = z
  .object({
    creditCardId: z.string().nullable().optional(),
    createNew: z
      .object({
        name: z.string().min(1).max(80),
      })
      .optional(),
  })
  .refine(
    (v) => (v.creditCardId !== undefined) !== (v.createNew !== undefined),
    { message: "Provide exactly one of creditCardId or createNew" },
  );

export type PlaidExchangeInput = z.infer<typeof plaidExchangeSchema>;
export type PlaidDraftActionInput = z.infer<typeof plaidDraftActionSchema>;
export type PlaidAccountUpdateInput = z.infer<typeof plaidAccountUpdateSchema>;
export type PlaidSyncInput = z.infer<typeof plaidSyncSchema>;
export type PlaidLinkCardInput = z.infer<typeof plaidLinkCardSchema>;

// ── Backup import ──────────────────────────────────────────────────────────
//
// Strict shape of `/api/backup/import` request bodies. Every entity is
// modeled top-to-bottom so we reject unknown fields, malformed types, and
// dangerous values (e.g. negative amounts, non-ISO dates, oversized notes)
// at the boundary instead of trusting the runtime to coerce them. The
// import path additionally validates the *graph* — every cardId/billId/
// promoId referenced by a child row must point to a row in the same
// payload — see `validateImportGraph` in lib/repos.ts.

const id = z.string().min(1).max(64);
const optionalNotes = z.string().max(500).nullable().optional();

const importBillSchema = z.object({
  id: id.optional(),
  name: z.string().min(1).max(80),
  category: z.string().min(1).max(50).optional(),
  amountCents: cents.refine((n) => n >= 0, "Amount must be non-negative"),
  intervalMonths: z.number().int().min(1).max(120).optional(),
  anchorDate: isoDate.optional(),
  // Legacy fields tolerated for old backups (see migration 0006).
  frequency: z.enum(["monthly", "annual"]).optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  dueMonth: z.number().int().min(1).max(12).nullable().optional(),
  autoPay: z.boolean().optional(),
  paidViaCardId: id.nullable().optional(),
  notes: optionalNotes,
  isActive: z.boolean().optional(),
});

const importBillOverrideSchema = z.object({
  id: id.optional(),
  billId: id,
  dueDate: isoDate,
  amountCents: cents.refine((n) => n >= 0, "Amount must be non-negative"),
  notes: optionalNotes,
});

const importVariableBillSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  category: z.string().min(1).max(50).optional(),
  amountCents: cents.refine((n) => n >= 0, "Amount must be non-negative"),
  intervalMonths: z.number().int().min(1).max(120),
  anchorDate: isoDate,
  notes: optionalNotes,
  isActive: z.boolean().optional(),
});

const importVariableBillCardSchema = z.object({
  id: id.optional(),
  variableBillId: id,
  cardId: id,
});

const importCreditCardPaymentOverrideSchema = z.object({
  id: id.optional(),
  cardId: id,
  dueDate: isoDate,
  amountCents: cents.refine((n) => n >= 0, "Amount must be non-negative"),
  notes: optionalNotes,
});

const importPaycheckSchema = z.object({
  id: id.optional(),
  payDate: isoDate,
  amountCents: cents,
  note: z.string().max(120).nullable().optional(),
  actualReceived: z.boolean().optional(),
  actualAmountCents: cents.nullable().optional(),
  // Plaid transaction_id of the deposit that settled this paycheck. Must
  // round-trip through backup/restore or every deposit becomes re-spendable
  // after an import (same rule as the statement settledByDraftId below).
  settledByDraftId: z.string().min(1).max(128).nullable().optional(),
  isActive: z.boolean().optional(),
});

const importExtraSchema = z.object({
  id: id.optional(),
  date: isoDate,
  description: z.string().min(1).max(120),
  amountCents: cents,
  category: z.string().min(1).max(50).optional(),
  paidViaCardId: id.nullable().optional(),
  notes: optionalNotes,
  isActive: z.boolean().optional(),
});

const importCategorySchema = z.object({
  id: id.optional(),
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color must be hex"),
  kind: z.enum(["expense", "income"]),
  budgetAmountCents: cents.optional(),
});

const importCreditCardSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  statementDay: z.number().int().min(1).max(31),
  statementCycleMode: z.enum(["calendar_day", "interval_days"]).optional(),
  statementCycleAnchorDate: isoDate.nullable().optional(),
  statementCycleIntervalDays: z.number().int().min(1).max(366).optional(),
  dueDay: z.number().int().min(1).max(31),
  currentBalanceCents: cents.nullable().optional(),
  autoPay: z.boolean().optional(),
  notes: optionalNotes,
  isActive: z.boolean().optional(),
});

const importCreditCardStatementSchema = z.object({
  id: id.optional(),
  cardId: id,
  statementDate: isoDate,
  dueDate: isoDate,
  statementBalanceCents: cents.refine((n) => n >= 0, "Balance must be non-negative"),
  minimumPaymentCents: cents.nullable().optional(),
  paidAmountCents: cents.nullable().optional(),
  paidDate: isoDate.nullable().optional(),
  notes: optionalNotes,
  // Plaid transaction_id of the draft that settled this statement. Must
  // round-trip through backup/restore or every draft becomes re-spendable
  // after an import (the settle-once gate reopens).
  settledByDraftId: z.string().min(1).max(128).nullable().optional(),
});

const importCreditCardPromoSchema = z.object({
  id: id.optional(),
  cardId: id,
  description: z.string().min(1).max(120),
  originalAmountCents: cents.refine((n) => n > 0, "Original amount must be positive"),
  remainingAmountCents: cents.refine((n) => n >= 0, "Remaining cannot be negative"),
  startDate: isoDate,
  endDate: isoDate,
  monthlyPaymentCents: cents.refine((n) => n > 0).nullable().optional(),
  notes: optionalNotes,
  isActive: z.boolean().optional(),
  authoritativeSource,
});

const importCreditCardPromoPaymentSchema = z.object({
  id: id.optional(),
  promoId: id,
  dueDate: isoDate,
  amountCents: cents.refine((n) => n > 0, "Amount must be positive"),
  note: z.string().max(500).nullable().optional(),
});

const importAssetSchema = z.object({
  id: id.optional(),
  name: z.string().min(1).max(80),
  valueCents: cents,
  category: z.string().min(1).max(50).optional(),
  notes: z.string().max(500).nullable().optional(),
  asOfDate: isoDate,
  isActive: z.boolean().optional(),
});

/**
 * Top-level shape of a backup payload. Every collection is bounded so a
 * pathological backup can't OOM the server. Ordering of inserts is enforced
 * by `importAll` (parents before children); validation here is shape-only.
 */
export const backupImportSchema = z.object({
  schemaVersion: z.number().int().nonnegative().optional(),
  exportedAt: z.string().optional(),
  settings: z.unknown().optional(),
  bills: z.array(importBillSchema).max(1000).optional(),
  billPaymentOverrides: z.array(importBillOverrideSchema).max(10000).optional(),
  variableBills: z.array(importVariableBillSchema).max(1000).optional(),
  variableBillCards: z.array(importVariableBillCardSchema).max(10000).optional(),
  creditCardPaymentOverrides: z.array(importCreditCardPaymentOverrideSchema).max(10000).optional(),
  paychecks: z.array(importPaycheckSchema).max(10000).optional(),
  extras: z.array(importExtraSchema).max(10000).optional(),
  categories: z.array(importCategorySchema).max(500).optional(),
  creditCards: z.array(importCreditCardSchema).max(200).optional(),
  creditCardStatements: z.array(importCreditCardStatementSchema).max(20000).optional(),
  creditCardPromos: z.array(importCreditCardPromoSchema).max(2000).optional(),
  creditCardPromoPayments: z.array(importCreditCardPromoPaymentSchema).max(20000).optional(),
  assets: z.array(importAssetSchema).max(1000).optional(),
});

export type BackupImportInput = z.infer<typeof backupImportSchema>;
