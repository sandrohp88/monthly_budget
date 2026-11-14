/**
 * Read-only bank history for calendar days BEFORE the projection window.
 *
 * Does not touch balances or the projection engine. Items dated on or after
 * `projectionStartDate` are excluded so a day is never shown by both layers.
 *
 * Amount sign matches Plaid / starting-balance drafts: positive = money out,
 * negative = money in.
 */

export type CalendarHistoryItem = {
  id: string;
  date: string;
  description: string;
  amountCents: number;
};

export type CalendarHistoryDay = {
  date: string;
  items: CalendarHistoryItem[];
  /** Sum of credits (absolute value of negative amountCents). */
  moneyInCents: number;
  /** Sum of debits (positive amountCents). */
  moneyOutCents: number;
};

function sortItems(a: CalendarHistoryItem, b: CalendarHistoryItem): number {
  const byAbs = Math.abs(b.amountCents) - Math.abs(a.amountCents);
  if (byAbs !== 0) return byAbs;
  return a.description.localeCompare(b.description);
}

/**
 * Group posted history items by date for days strictly before
 * `projectionStartDate`. Returns an empty Map when there is nothing to show.
 */
export function groupCalendarHistory(
  items: ReadonlyArray<CalendarHistoryItem>,
  projectionStartDate: string,
): Map<string, CalendarHistoryDay> {
  const byDate = new Map<string, CalendarHistoryItem[]>();
  for (const item of items) {
    if (item.date >= projectionStartDate) continue;
    const list = byDate.get(item.date);
    if (list) list.push(item);
    else byDate.set(item.date, [item]);
  }

  const out = new Map<string, CalendarHistoryDay>();
  for (const [date, dayItems] of byDate) {
    const sorted = [...dayItems].sort(sortItems);
    let moneyInCents = 0;
    let moneyOutCents = 0;
    for (const item of sorted) {
      if (item.amountCents < 0) moneyInCents += -item.amountCents;
      else if (item.amountCents > 0) moneyOutCents += item.amountCents;
    }
    out.set(date, { date, items: sorted, moneyInCents, moneyOutCents });
  }
  return out;
}
