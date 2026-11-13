/**
 * Which existing card, if any, is the SAME real account as a credit account
 * that a new Plaid link reports (review 2026-11-10 PLAID-3). Pure.
 *
 * Plaid Link update mode is not built, so a broken login is fixed by unlink +
 * link again. Unlinking (`deactivatePlaidItem`) keeps the card active with its
 * statements, promos and overrides but nulls `plaid_account_id`; the new link
 * gets NEW account_ids. Without this match the exchange auto-creates a second
 * card and the liabilities pre-fetch gives it the same open statement, so that
 * statement is owed twice.
 *
 * A wrong re-link attaches one account's statements and balance to another
 * card, which is worse than a duplicate. So the match is conservative: when
 * anything is ambiguous it returns nothing and the caller creates a card as
 * before (the user can then fix it on /accounts).
 *
 * Evidence that a card WAS a given former account (on a deactivated item):
 *   - tie: one of the card's statements was settled by a card_payment draft of
 *     that account (`settled_by_draft_id`; only `reconcileCardPaymentDraft`
 *     stamps it, and only for the card linked to the draft's account);
 *   - name: the card's name is that account's name plus its mask, as the
 *     exchange auto-creates it ("Prime Visa ****9873"; the mask format is the
 *     one `cardMaskDigits`/`cardDisplayName` read), and no other card is tied
 *     to that account.
 * A card qualifies for a new account only when all of its evidence names ONE
 * (institution, mask) pair, that pair equals the new account's, and a mask in
 * the card's name does not say otherwise. The re-link happens only when
 * exactly one card qualifies for the account AND that card qualifies for no
 * other new account.
 */
import { cardDisplayName, cardMaskDigits } from "./card-art";

/** A credit account on one of the user's DEACTIVATED Plaid items. */
export type FormerCreditAccount = {
  id: string;
  name: string;
  mask: string | null;
  institutionId: string;
  /** Cards with a statement settled by a draft of this account. */
  settledCardIds: readonly string[];
};

/** An ACTIVE card of the user with no Plaid link (`plaid_account_id` null). */
export type UnlinkedCard = { id: string; name: string };

export type NewCreditAccount = { id: string; mask: string | null };

const sameName = (a: string, b: string) =>
  cardDisplayName(a).trim().toLowerCase() === cardDisplayName(b).trim().toLowerCase();

/** The one (institution, mask) a card provably was, or null. */
function cardIdentity(
  card: UnlinkedCard,
  former: readonly FormerCreditAccount[],
): { institutionId: string; mask: string } | null {
  const nameMask = cardMaskDigits(card.name, null);
  const evidence: FormerCreditAccount[] = [];
  for (const acct of former) {
    if (acct.mask == null) continue;
    const tied = acct.settledCardIds.includes(card.id);
    const named =
      nameMask === acct.mask &&
      sameName(card.name, acct.name) &&
      acct.settledCardIds.every((id) => id === card.id);
    if (tied || named) evidence.push(acct);
  }
  const keys = new Set(evidence.map((a) => `${a.institutionId}\u0000${a.mask}`));
  if (keys.size !== 1) return null;
  const { institutionId, mask } = evidence[0]!;
  if (nameMask != null && nameMask !== mask) return null;
  return { institutionId, mask: mask! };
}

/**
 * New account id → id of the existing card to re-link. Accounts absent from
 * the map get a new card as before.
 */
export function matchRelinkCards(input: {
  institutionId: string;
  newAccounts: readonly NewCreditAccount[];
  unlinkedCards: readonly UnlinkedCard[];
  formerAccounts: readonly FormerCreditAccount[];
}): Map<string, string> {
  const identities = new Map<string, { institutionId: string; mask: string }>();
  for (const card of input.unlinkedCards) {
    const id = cardIdentity(card, input.formerAccounts);
    if (id) identities.set(card.id, id);
  }
  const qualifies = (cardId: string, acct: NewCreditAccount) => {
    const id = identities.get(cardId);
    return (
      id != null &&
      acct.mask != null &&
      id.institutionId === input.institutionId &&
      id.mask === acct.mask
    );
  };

  const out = new Map<string, string>();
  for (const acct of input.newAccounts) {
    const candidates = [...identities.keys()].filter((cardId) => qualifies(cardId, acct));
    if (candidates.length !== 1) continue;
    const cardId = candidates[0]!;
    const accountsForCard = input.newAccounts.filter((a) => qualifies(cardId, a));
    if (accountsForCard.length !== 1) continue;
    out.set(acct.id, cardId);
  }
  return out;
}
