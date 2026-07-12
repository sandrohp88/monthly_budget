/**
 * Card-art registry for the credit-cards wallet view.
 *
 * Official issuer card art lives in `public/cards/` (sourced from each
 * issuer's own marketing assets). Matching is by case-insensitive pattern on
 * the card name — first match wins, so more specific patterns come first
 * (e.g. "blue cash everyday" before the generic Amex "everyday").
 *
 * Cards without official art get a designed fallback face driven by
 * `cardBrand()` — a brand-colored gradient with wordmark, chip, and network
 * mark rendered by `<CreditCardVisual />`.
 */

export type CardBrand = {
  /** CSS background (usually a gradient) for the fallback card face. */
  background: string;
  /** Text color on the fallback face. */
  foreground: string;
  /** Wordmark rendered top-left on the fallback face. */
  wordmark: string;
  /** Lowercase wordmarks (e.g. "sam's club") skip the uppercase transform. */
  preserveCase?: boolean;
};

const ART_RULES: Array<{ match: RegExp; src: string }> = [
  { match: /unlimited cash rewards/i, src: "/cards/bofa-unlimited-cash-rewards.png" },
  { match: /customized cash rewards/i, src: "/cards/bofa-customized-cash-rewards.png" },
  { match: /strata/i, src: "/cards/citi-strata.webp" },
  { match: /aadvantage/i, src: "/cards/citi-aadvantage-platinum-select.png" },
  { match: /double cash/i, src: "/cards/citi-double-cash.webp" },
  { match: /costco/i, src: "/cards/citi-costco-anywhere.webp" },
  { match: /blue cash/i, src: "/cards/amex-blue-cash-everyday.png" },
  { match: /everyday/i, src: "/cards/amex-everyday.png" },
  { match: /discover/i, src: "/cards/discover-it.png" },
  { match: /prime store/i, src: "/cards/amazon-prime-store-card.png" },
];

/** Path under /public for this card's official art, or null when we have none. */
export function cardArtSrc(name: string): string | null {
  for (const rule of ART_RULES) {
    if (rule.match.test(name)) return rule.src;
  }
  return null;
}

const BRAND_RULES: Array<{ match: RegExp; brand: CardBrand }> = [
  {
    match: /paypal/i,
    brand: {
      background: "linear-gradient(125deg, #001c64 0%, #113984 55%, #0070e0 130%)",
      foreground: "#ffffff",
      wordmark: "PayPal Credit",
      preserveCase: true,
    },
  },
  {
    match: /sam['’]?s club/i,
    brand: {
      background: "linear-gradient(125deg, #101114 0%, #26282e 70%, #3a3d45 130%)",
      foreground: "#ffffff",
      wordmark: "sam's club",
      preserveCase: true,
    },
  },
  {
    match: /carecredit/i,
    brand: {
      background: "linear-gradient(125deg, #0e3b24 0%, #1d6b3f 60%, #66a944 130%)",
      foreground: "#ffffff",
      wordmark: "CareCredit",
      preserveCase: true,
    },
  },
  {
    match: /chase/i,
    brand: {
      background: "linear-gradient(125deg, #0a1e3f 0%, #11336b 65%, #1a4fa0 130%)",
      foreground: "#ffffff",
      wordmark: "CHASE",
    },
  },
  {
    match: /capital one/i,
    brand: {
      background: "linear-gradient(125deg, #10233e 0%, #1c3a63 60%, #a12d33 145%)",
      foreground: "#ffffff",
      wordmark: "Capital One",
      preserveCase: true,
    },
  },
  {
    match: /u\.?s\.? ?bank/i,
    brand: {
      background: "linear-gradient(125deg, #0a1f4e 0%, #123072 60%, #274ea3 130%)",
      foreground: "#ffffff",
      wordmark: "US BANK",
    },
  },
];

const DEFAULT_BRAND: CardBrand = {
  background: "linear-gradient(125deg, #23282f 0%, #343b45 65%, #48505c 130%)",
  foreground: "#ffffff",
  wordmark: "",
};

/**
 * Fallback-face styling for a card without official art. The institution
 * (from the linked Plaid item) covers generic issuer names like Chase's
 * "CREDIT CARD ****1154".
 */
export function cardBrand(name: string, institution?: string | null): CardBrand {
  const haystack = `${name} ${institution ?? ""}`;
  for (const rule of BRAND_RULES) {
    if (rule.match.test(haystack)) return rule.brand;
  }
  return { ...DEFAULT_BRAND, wordmark: cardDisplayName(name, institution) };
}

/**
 * Human display name: strips mask suffixes ("****2559", "- 0560", trailing
 * "5885") and rewrites generic issuer names ("CREDIT CARD") to
 * "<Institution> Credit Card" when the institution is known.
 */
export function cardDisplayName(name: string, institution?: string | null): string {
  let cleaned = name
    .replace(/\s*[*•·x]{2,}\s*\d{2,5}\s*$/gi, "")
    .replace(/\s*[-–—]\s*\d{3,5}\s*$/g, "")
    .replace(/\s+\d{4,5}\s*$/g, "")
    .trim();
  if (!cleaned) cleaned = name.trim();
  if (/^credit (card|account)$/i.test(cleaned) && institution) {
    return `${institution} Credit Card`;
  }
  return cleaned;
}

/** Last digits for the "•••• 2559" line: Plaid mask first, then the name. */
export function cardMaskDigits(name: string, plaidMask?: string | null): string | null {
  if (plaidMask) return plaidMask;
  const starred = name.match(/[*•·x]{2,}\s*(\d{2,5})/i);
  if (starred) return starred[1] ?? null;
  const trailing = name.match(/(\d{4,5})\s*$/);
  return trailing ? (trailing[1] ?? null) : null;
}

/** Payment-network mark for the fallback face, when the name reveals it. */
export function cardNetwork(name: string): string | null {
  if (/visa/i.test(name)) return "VISA";
  if (/mastercard|master card/i.test(name)) return "mastercard";
  if (/american express|amex/i.test(name)) return "AMEX";
  if (/discover/i.test(name)) return "DISCOVER";
  return null;
}
