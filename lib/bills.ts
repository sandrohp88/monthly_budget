import type { BillRow } from "@/lib/db/schema";

function daysInMonthUtc(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Next occurrence of this bill on or after `today`, derived by walking
 * forward from the anchor in `intervalMonths` steps and clamping the
 * day-of-month to each target month's length.
 */
export function nextBillOccurrence(
  bill: Pick<BillRow, "anchorDate" | "intervalMonths">,
  today: string,
): string {
  const anchorMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bill.anchorDate);
  if (!anchorMatch) return bill.anchorDate;
  const todayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!todayMatch) return bill.anchorDate;

  const aY = Number(anchorMatch[1]);
  const aM = Number(anchorMatch[2]);
  const aD = Number(anchorMatch[3]);
  const tY = Number(todayMatch[1]);
  const tM = Number(todayMatch[2]);
  const intervalMonths = Math.max(1, bill.intervalMonths);
  const monthsDiff = (tY - aY) * 12 + (tM - aM);
  let k = Math.floor(monthsDiff / intervalMonths) - 1;

  for (let i = 0; i < 4096; i++) {
    const total = aY * 12 + (aM - 1) + k * intervalMonths;
    const year = Math.floor(total / 12);
    const month = ((total % 12) + 12) % 12 + 1;
    const day = Math.min(aD, daysInMonthUtc(year, month));
    const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (iso >= today) return iso;
    k++;
  }

  return bill.anchorDate;
}
