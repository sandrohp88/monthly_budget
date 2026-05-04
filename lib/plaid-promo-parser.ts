const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function iso(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

export function detectPromoPayoffDate(texts: ReadonlyArray<string | null | undefined>): string | null {
  const text = texts.filter(Boolean).join(" | ");
  if (!text) return null;

  const lowered = text.toLowerCase();
  const hasPromoSignal =
    /promo|promotion|promotional|deferred|interest|no interest|avoid interest|paid in full|pay in full/.test(
      lowered,
    );
  if (!hasPromoSignal) return null;

  const numeric = lowered.match(
    /(?:by|until|through|before|exp(?:ires|iration)?(?: date)?|deferred interest date|pay(?:ment)? due)\D{0,24}(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/,
  );
  if (numeric) {
    return iso(
      normalizeYear(Number(numeric[3])),
      Number(numeric[1]),
      Number(numeric[2]),
    );
  }

  const named = lowered.match(
    /(?:by|until|through|before|exp(?:ires|iration)?(?: date)?|deferred interest date|pay(?:ment)? due)\D{0,24}(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{2,4})/,
  );
  if (named) {
    const monthName = named[1];
    if (!monthName) return null;
    const month = MONTHS[monthName];
    if (!month) return null;
    return iso(normalizeYear(Number(named[3])), month, Number(named[2]));
  }

  return null;
}
