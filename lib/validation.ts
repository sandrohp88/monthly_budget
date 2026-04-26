import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const cents = z.number().int();

export const billCreateSchema = z
  .object({
    name: z.string().min(1).max(80),
    category: z.string().min(1).max(50),
    amountCents: cents.refine((n) => n >= 0, "Amount must be non-negative"),
    frequency: z.enum(["monthly", "annual"]),
    dueDay: z.number().int().min(1).max(31),
    dueMonth: z.number().int().min(1).max(12).nullable().optional(),
    autoPay: z.boolean().default(false),
    notes: z.string().max(500).nullable().optional(),
  })
  .refine(
    (b) => b.frequency === "monthly" || (typeof b.dueMonth === "number" && b.dueMonth >= 1 && b.dueMonth <= 12),
    { message: "Annual bills require a due month", path: ["dueMonth"] },
  );

export const billUpdateSchema = billCreateSchema.and(
  z.object({ isActive: z.boolean().optional() }),
);

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
  notes: z.string().max(500).nullable().optional(),
});

export const extraUpdateSchema = extraCreateSchema;

export const settingsUpdateSchema = z.object({
  startingBalanceCents: cents,
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
});

export const creditCardCreateSchema = z.object({
  name: z.string().min(1).max(80),
  statementDay: z.number().int().min(1).max(31),
  dueDay: z.number().int().min(1).max(31),
  autoPay: z.boolean().default(false),
  notes: z.string().max(500).nullable().optional(),
});

export const creditCardUpdateSchema = creditCardCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const statementCreateSchema = z.object({
  statementDate: isoDate,
  dueDate: isoDate,
  statementBalanceCents: cents.refine((n) => n >= 0, "Balance must be non-negative"),
  notes: z.string().max(500).nullable().optional(),
});

export const statementUpdateSchema = z.object({
  statementDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  statementBalanceCents: cents.optional(),
  paidAmountCents: cents.nullable().optional(),
  paidDate: isoDate.nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export type BillCreateInput = z.infer<typeof billCreateSchema>;
export type BillUpdateInput = z.infer<typeof billUpdateSchema>;
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
