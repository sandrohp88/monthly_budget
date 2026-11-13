import { describe, expect, it } from "vitest";
import { matchRelinkCards, type FormerCreditAccount } from "./plaid-relink";

const former = (over: Partial<FormerCreditAccount> = {}): FormerCreditAccount => ({
  id: "acct_old",
  name: "Prime Visa",
  mask: "9873",
  institutionId: "ins_3",
  settledCardIds: [],
  ...over,
});

const match = (
  unlinkedCards: Array<{ id: string; name: string }>,
  formerAccounts: FormerCreditAccount[],
  newAccounts = [{ id: "acct_new", mask: "9873" as string | null }],
) =>
  Object.fromEntries(
    matchRelinkCards({ institutionId: "ins_3", newAccounts, unlinkedCards, formerAccounts }),
  );

// Route-level cases live in plaid-exchange-relink.integration.test.ts; these
// pin the evidence rules that decide "same real account" (PLAID-3).
describe("matchRelinkCards evidence rules", () => {
  it("matches a card tied by a settled statement, whatever its name", () => {
    expect(match([{ id: "c1", name: "My travel card" }], [former({ settledCardIds: ["c1"] })])).toEqual({
      acct_new: "c1",
    });
  });

  it("matches an auto-created name only when the base name and mask both agree", () => {
    expect(match([{ id: "c1", name: "Prime Visa ****9873" }], [former()])).toEqual({ acct_new: "c1" });
    expect(match([{ id: "c1", name: "Freedom ****9873" }], [former()])).toEqual({});
    expect(match([{ id: "c1", name: "Prime Visa" }], [former()])).toEqual({});
  });

  it("ignores name evidence for an account that is tied to a different card", () => {
    expect(
      match([{ id: "c1", name: "Prime Visa ****9873" }], [former({ settledCardIds: ["c2"] })]),
    ).toEqual({});
  });

  it("rejects a card whose name mask contradicts its tie", () => {
    expect(
      match([{ id: "c1", name: "Chase card ****1154" }], [former({ settledCardIds: ["c1"] })]),
    ).toEqual({});
  });

  it("rejects a card tied to two different former accounts", () => {
    expect(
      match(
        [{ id: "c1", name: "Chase card" }],
        [
          former({ settledCardIds: ["c1"] }),
          former({ id: "acct_old_2", mask: "1154", settledCardIds: ["c1"] }),
        ],
        [
          { id: "acct_new", mask: "9873" },
          { id: "acct_new_2", mask: "1154" },
        ],
      ),
    ).toEqual({});
  });

  it("ignores a former account with no mask", () => {
    expect(match([{ id: "c1", name: "Chase card" }], [former({ mask: null, settledCardIds: ["c1"] })])).toEqual({});
  });
});
