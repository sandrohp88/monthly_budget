"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertBar } from "@/components/ui/alert-bar";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import type { UnpaidRecentOccurrence } from "@/lib/bill-reconciliation";

type Answered = {
  billId: string;
  billName: string;
  dueDate: string;
  state: "sent" | "paid_externally";
  amountCents: number;
};

/**
 * Everything about money that has moved but hasn't posted, in one place.
 *
 * Three bands, in the order they matter:
 *   1. Open questions — occurrences past due with nothing confirming them.
 *      Each is holding real cash out of the projected balance, so the useful
 *      thing is not the warning but the answer. Two buttons, two facts the
 *      user knows and the app can't:
 *        SENT           — money is out, waiting to post. Keeps holding the
 *                         cash, stops asking, clears itself when it posts.
 *        PAID ELSEWHERE — paid from an account this app can't see. Releases
 *                         the cash and settles the occurrence.
 *      Deliberately no "mark paid" that guesses.
 *   2. Answered — reversible, because answering removes an occurrence from
 *      band 1 and band 1 is the only place it was reachable.
 *   3. The total held, including whatever pending float the bank reports that
 *      no bill or planned payment accounts for.
 */
export function PendingPostingAlert({
  occurrences,
  cardPayments,
  answered,
  totalHeldCents,
  unattributedCents,
  today,
}: {
  occurrences: UnpaidRecentOccurrence[];
  cardPayments: Array<{ cardId: string; cardName: string; date: string; amountCents: number }>;
  answered: Answered[];
  totalHeldCents: number;
  unattributedCents: number;
  today: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);

  async function send(
    billId: string,
    dueDate: string,
    body: { state: "sent" | "paid_externally" } | null,
    successMessage: string,
  ) {
    const key = `${billId}:${dueDate}`;
    setBusy(key);
    try {
      const res = body
        ? await fetch(`/api/bills/${billId}/payment-state`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              dueDate,
              state: body.state,
              amountCents: null,
              // Best guess at when the money left: the due date, unless that
              // is still ahead, in which case it left today. The bill's
              // occurrence dialog can refine it.
              markedDate: dueDate > today ? today : dueDate,
            }),
          })
        : await fetch(`/api/bills/${billId}/payment-state?dueDate=${encodeURIComponent(dueDate)}`, {
            method: "DELETE",
          });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Could not save");
      }
      toast.success(successMessage);
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function cancelCardPlan(cardId: string, date: string) {
    const key = `${cardId}:${date}`;
    setBusy(key);
    try {
      const res = await fetch(
        `/api/credit-cards/${cardId}/payment-overrides?dueDate=${encodeURIComponent(date)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Could not cancel the plan");
      toast.success("Payment plan cancelled — reserved cash released");
      router.refresh();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {occurrences.length > 0 ? (
        <AlertBar tag="Unposted" variant="amber">
          <div className="flex flex-col gap-2">
            <div>
              No matching payment has posted for these, so their cash is still held out of your
              balance. Which is it?
            </div>
            <ul className="flex flex-col gap-1.5">
              {occurrences.slice(0, 5).map((o) => {
                const key = `${o.billId}:${o.dueDate}`;
                return (
                  <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                      <strong className="text-[var(--amber)]">{o.billName}</strong> (due{" "}
                      <DateLabel iso={o.dueDate} format="short" /> ·{" "}
                      <Money cents={o.expectedCents} />)
                    </span>
                    <span className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === key}
                        onClick={() =>
                          send(
                            o.billId,
                            o.dueDate,
                            { state: "sent" },
                            `${o.billName} marked sent — holding the cash until it posts`,
                          )
                        }
                      >
                        It&apos;s sent
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy === key}
                        onClick={() =>
                          send(
                            o.billId,
                            o.dueDate,
                            { state: "paid_externally" },
                            `${o.billName} settled — paid outside your linked accounts`,
                          )
                        }
                      >
                        Paid elsewhere
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
            {occurrences.length > 5 ? (
              <div className="text-[var(--text-2)]">and {occurrences.length - 5} more</div>
            ) : null}
            <div className="text-[var(--text-2)]">
              If a payment posted under different wording,{" "}
              <Link href="/transactions" className="text-[var(--mint)] hover:underline">
                link it to the bill
              </Link>{" "}
              instead — that teaches every future month.
            </div>
          </div>
        </AlertBar>
      ) : null}

      {/* Also renders on answered-with-nothing-held, which is exactly the
          `paid elsewhere` case: it releases the cash, so keying only on
          totalHeldCents would strand its Undo. */}
      {totalHeldCents > 0 || answered.length > 0 ? (
        <AlertBar tag="In flight" variant="mint">
          <div className="flex flex-col gap-2">
            {totalHeldCents > 0 ? (
              <div>
                <Money cents={totalHeldCents} /> has left your account (or is due to) without
                posting yet, and is already held out of every balance below
                {unattributedCents > 0 ? (
                  <>
                    {" "}
                    — including <Money cents={unattributedCents} /> your bank reports as pending
                    that no bill or planned payment accounts for
                  </>
                ) : null}
                . Each piece clears itself as its transaction posts.
              </div>
            ) : null}
            {cardPayments.length > 0 ? (
              <div className="flex flex-col gap-2">
                <ul className="flex flex-col gap-1">
                  {cardPayments.map((p) => (
                    <li key={`${p.cardId}:${p.date}`} className="flex flex-wrap items-center gap-2">
                      {p.cardName} · planned <DateLabel iso={p.date} format="short" /> ·{" "}
                      <Money cents={p.amountCents} /> reserved
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === `${p.cardId}:${p.date}`}
                        onClick={() => cancelCardPlan(p.cardId, p.date)}
                      >
                        Cancel plan
                      </Button>
                    </li>
                  ))}
                </ul>
                <div>
                  Card payments stay reserved until a posted checking transaction matches. If one
                  already posted under different wording, use{" "}
                  <Link href="/transactions" className="text-[var(--mint)] hover:underline">
                    Split on the transaction
                  </Link>{" "}
                  to link its planned payment. Review plans in{" "}
                  <Link href="/calendar" className="text-[var(--mint)] hover:underline">
                    Calendar
                  </Link>
                  .
                </div>
              </div>
            ) : null}
            {answered.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {answered.map((a) => {
                  const key = `${a.billId}:${a.dueDate}`;
                  return (
                    <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[var(--text-2)]">
                        {a.billName} (due <DateLabel iso={a.dueDate} format="short" /> ·{" "}
                        <Money cents={a.amountCents} />) —{" "}
                        {a.state === "sent" ? "sent, awaiting post" : "paid elsewhere"}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy === key}
                        onClick={() =>
                          send(a.billId, a.dueDate, null, `Undid the mark on ${a.billName}`)
                        }
                      >
                        Undo
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </AlertBar>
      ) : null}
    </>
  );
}
