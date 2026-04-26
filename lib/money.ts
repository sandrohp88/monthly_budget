/**
 * Money helpers. Money is always stored and passed around as integer cents.
 * Display-side formatting honors the user's currency setting.
 */

export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new Error("dollars must be finite");
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

export function parseMoneyInput(input: string): number {
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`invalid money input: ${input}`);
  return dollarsToCents(n);
}

export function formatCents(cents: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function sumCents(values: ReadonlyArray<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}
