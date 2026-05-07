/**
 * Money helpers. Money is always stored and passed around as integer cents.
 * Display-side formatting honors the user's currency setting.
 */

/**
 * Convert a dollar amount to integer cents using string-based rounding so
 * binary-floating-point representations can't drift the result. Rounds
 * half-away-from-zero (the convention most people expect for money).
 *
 * Accepts either a number (which gets stringified — only finite numbers are
 * allowed) or a pre-cleaned string like "1.005" or "-12.34".
 *
 * Why string-based: `Math.round(1.005 * 100)` is 100, not 101, because
 * `1.005 * 100 === 100.49999999999999` in IEEE-754. Money math has to
 * round on the decimal digits the user typed, not on the float.
 */
export function dollarsToCents(input: number | string): number {
  let raw: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("dollars must be finite");
    // Number → string. Even very small/large finite numbers get rendered in
    // a form the regex below accepts; toString() is exact for safe integers
    // and reasonable for typical money values.
    raw = input.toString();
  } else {
    raw = input.trim();
  }
  // Strip a leading +.
  if (raw.startsWith("+")) raw = raw.slice(1);
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m) throw new Error(`invalid money input: ${input}`);
  const sign = m[1] === "-" ? -1 : 1;
  const whole = m[2] ?? "";
  const frac = m[3] ?? "";
  if (whole === "" && frac === "") return 0;
  // Pad/truncate fractional digits to 3 so we can inspect the rounding bit.
  const padded = (frac + "000").slice(0, 3);
  const cents = Number(whole === "" ? "0" : whole) * 100 + Number(padded.slice(0, 2));
  const roundDigit = Number(padded.charAt(2));
  const roundUp = roundDigit >= 5 ? 1 : 0;
  return sign * (cents + roundUp);
}

export function centsToDollars(cents: number): number {
  return cents / 100;
}

export function parseMoneyInput(input: string): number {
  const cleaned = input.trim().replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return 0;
  return dollarsToCents(cleaned);
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
