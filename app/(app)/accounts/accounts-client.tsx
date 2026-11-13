"use client";

import * as React from "react";
import {
  Building2,
  Link2,
  RefreshCw,
  Trash2,
  Unlink,
} from "lucide-react";
import { toast } from "sonner";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHead } from "@/components/ui/page-head";
import { Tile, TileGrid } from "@/components/ui/tile";
import { StatusPill } from "@/components/ui/status-pill";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import { PlaidLinkCardDialog } from "@/components/plaid-link-card-dialog";
import { cn } from "@/lib/cn";
import { interestSavingCashDueCents } from "@/lib/credit-cards";
import { useRefreshAfterMutation } from "@/lib/refresh-after-mutation";
import { isoDateInTimeZone } from "@/lib/dates";
import {
  assessBankHealth,
  bankHealthAction,
  bankHealthLastSyncLabel,
  bankHealthReason,
  bankHealthShortLabel,
  syncFailureMessage,
  type BankItemHealth,
} from "@/lib/plaid-item-health";
import type { SyncItemError } from "@/lib/plaid-sync";
import type {
  PlaidItemRow,
  PlaidAccountRow,
  CreditCardRow,
  CreditCardPromoRow,
  CreditCardStatementRow,
} from "@/lib/db/schema";

type ItemWithAccounts = PlaidItemRow & { accounts: PlaidAccountRow[] };
type CardWithStatements = {
  card: CreditCardRow;
  statements: CreditCardStatementRow[];
  promos: CreditCardPromoRow[];
};

export function AccountsClient({
  initialItems,
  initialCards,
  nowMs,
  timeZone,
}: {
  initialItems: ItemWithAccounts[];
  initialCards: CardWithStatements[];
  /** Server render time — the clock item health is judged against. */
  nowMs: number;
  /** settings.timezone: sync dates are shown as the user's calendar date. */
  timeZone: string;
}) {
  const refreshAfterMutation = useRefreshAfterMutation();
  const [items, setItems] = React.useState<ItemWithAccounts[]>(initialItems);
  const [cards, setCards] = React.useState<CardWithStatements[]>(initialCards);
  const [syncing, setSyncing] = React.useState(false);
  const [linkingCardFor, setLinkingCardFor] = React.useState<PlaidAccountRow | null>(null);
  const [unlinkingId, setUnlinkingId] = React.useState<string | null>(null);

  // ── derived: map plaidAccountId → linked card (with latest statement) ────
  const linkByPlaidAccount = React.useMemo(() => {
    const m = new Map<string, CardWithStatements>();
    for (const cs of cards) {
      if (cs.card.plaidAccountId) m.set(cs.card.plaidAccountId, cs);
    }
    return m;
  }, [cards]);

  // ── derived ──────────────────────────────────────────────────────────────
  const totalAccounts = items.reduce((n, i) => n + i.accounts.length, 0);
  const lastSynced = items
    .map((i) => i.lastSyncedAt)
    .filter((t): t is number => t != null)
    .sort((a, b) => a - b)
    .at(-1);
  const health = assessBankHealth({
    items,
    accounts: items.flatMap((i) =>
      i.accounts.map((a) => ({ itemId: i.id, useAsStartingBalance: a.useAsStartingBalance })),
    ),
    now: nowMs,
  });
  const healthById = new Map(health.items.map((h) => [h.itemId, h] as const));
  // One healthy item must not hide a broken one: while any item is unhealthy
  // the tile shows the oldest last success among unhealthy items and names
  // that bank.
  const oldest = health.oldestUnhealthy;
  const othersNeedingAttention = oldest
    ? health.unhealthy.filter((h) => h.itemId !== oldest.itemId).length
    : 0;

  // ── data fetches ─────────────────────────────────────────────────────────
  const refreshItems = async () => {
    const res = await fetch("/api/plaid/items");
    if (!res.ok) return;
    const json = await res.json() as { items: ItemWithAccounts[] };
    setItems(json.items);
  };

  const refreshCards = async () => {
    const res = await fetch("/api/credit-cards");
    if (!res.ok) return;
    const json = await res.json() as { cards: CardWithStatements[] };
    setCards(json.cards);
  };

  // ── handlers ─────────────────────────────────────────────────────────────
  const syncAll = async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/plaid/sync", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json() as {
        added?: number;
        modified?: number;
        cardsUpdated?: number;
        statementsCreated?: number;
        statementsReconciled?: number;
        paychecksReconciled?: number;
        itemErrors?: SyncItemError[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      const failedPart =
        (json.itemErrors?.length ?? 0) > 0 ? syncFailureMessage(json.itemErrors!) : null;
      const txnPart = `${json.added ?? 0} new, ${json.modified ?? 0} updated`;
      const cardPart =
        (json.cardsUpdated ?? 0) > 0 || (json.statementsCreated ?? 0) > 0
          ? ` · ${json.cardsUpdated ?? 0} card${(json.cardsUpdated ?? 0) === 1 ? "" : "s"}, ${json.statementsCreated ?? 0} statement${(json.statementsCreated ?? 0) === 1 ? "" : "s"}`
          : "";
      const reconciledPart =
        (json.statementsReconciled ?? 0) > 0
          ? ` · ${json.statementsReconciled} payment${json.statementsReconciled === 1 ? "" : "s"} reconciled`
          : "";
      const paycheckPart =
        (json.paychecksReconciled ?? 0) > 0
          ? ` · ${json.paychecksReconciled} paycheck${json.paychecksReconciled === 1 ? "" : "s"} received`
          : "";
      if (failedPart) toast.error(failedPart);
      else toast.success(`Sync complete — ${txnPart}${cardPart}${reconciledPart}${paycheckPart}`);
      await Promise.all([refreshItems(), refreshCards()]);
      // Plaid changes data consumed throughout the app. Clear Next's client
      // route cache so pages visited before this sync render fresh server data
      // the next time the user opens them.
      refreshAfterMutation();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const unlinkItem = async (id: string, name: string) => {
    if (!(await confirmDialog({ title: `Unlink ${name}?`, description: "This cannot be undone.", confirmText: "Unlink", tone: "danger" }))) return;
    const res = await fetch(`/api/plaid/items/${id}`, { method: "DELETE" });
    if (!res.ok) { toast.error("Unlink failed"); return; }
    toast.success(`${name} unlinked`);
    await Promise.all([refreshItems(), refreshCards()]);
    // Its balances, transactions and linked cards leave every projection.
    refreshAfterMutation();
  };

  const unlinkCardFromPlaid = async (plaidAccountId: string) => {
    setUnlinkingId(plaidAccountId);
    try {
      const res = await fetch(`/api/plaid/accounts/${plaidAccountId}/link-card`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creditCardId: null }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { error?: string };
        throw new Error(j.error ?? "Unlink failed");
      }
      toast.success("Card unlinked from Plaid account");
      await refreshCards();
      refreshAfterMutation();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setUnlinkingId(null);
    }
  };

  const toggleAccountPref = async (
    accountId: string,
    field: "useAsStartingBalance" | "syncEnabled",
    value: boolean,
  ) => {
    const res = await fetch(`/api/plaid/accounts/${accountId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    if (!res.ok) { toast.error("Update failed"); return; }
    await refreshItems();
    // useAsStartingBalance replaces the projection's starting balance (the
    // sidebar and dashboard); syncEnabled changes what the next sync imports.
    refreshAfterMutation();
  };

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 fade-in">
      <PageHead
        title="Accounts"
        subtitle="Link bank accounts and credit cards via Plaid to automate transaction import"
        actions={
          <div className="flex gap-2">
            <Button
              id="sync-all-button"
              variant="outline"
              onClick={syncAll}
              disabled={syncing || items.length === 0}
            >
              <RefreshCw className={cn("h-3 w-3", syncing && "animate-spin")} />
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
            <PlaidLinkButton
              onLinked={async () => {
                await refreshItems();
                toast.success("Account linked — click Sync Now to import transactions");
                refreshAfterMutation();
              }}
            />
          </div>
        }
      />

      <TileGrid cols="auto">
        <Tile label="Linked institutions" value={items.length} delta={`${totalAccounts} account${totalAccounts !== 1 ? "s" : ""}`} />
        <Tile
          label="Transaction import"
          value="AUTO"
          variant="mint"
          delta="approved on sync"
          badge={<Badge variant="success">ON</Badge>}
        />
        {oldest ? (
          <Tile
            label="Last sync"
            variant={health.unhealthy.some((h) => h.status === "failing") ? "red" : "amber"}
            value={
              oldest.lastSuccessAt != null ? (
                <DateLabel iso={isoDateInTimeZone(oldest.lastSuccessAt, timeZone)} format="short" />
              ) : (
                "Never"
              )
            }
            delta={
              <>
                {oldest.institutionName} {bankHealthShortLabel(oldest)}
                {othersNeedingAttention > 0
                  ? ` · ${othersNeedingAttention} more need${othersNeedingAttention === 1 ? "s" : ""} attention`
                  : ""}
              </>
            }
          />
        ) : (
          <Tile
            label="Last sync"
            value={lastSynced ? <DateLabel iso={isoDateInTimeZone(lastSynced, timeZone)} format="short" /> : "—"}
            delta={lastSynced ? "all banks syncing" : "never synced"}
          />
        )}
      </TileGrid>

      <div className="space-y-4">
        {items.length === 0 ? (
          <Card>
            <CardHeader><CardTitle>No linked accounts</CardTitle></CardHeader>
            <div className="px-4 py-8 text-center space-y-3">
              <p className="text-[11px] tracking-wide text-[var(--text-2)]">
                Link a bank account or credit card to start importing transactions automatically.
              </p>
              <PlaidLinkButton
                onLinked={async () => {
                  await refreshItems();
                  refreshAfterMutation();
                }}
              />
            </div>
          </Card>
        ) : (
          items.map((item) => (
            <InstitutionCard
              key={item.id}
              item={item}
              health={healthById.get(item.id)!}
              timeZone={timeZone}
              linkByPlaidAccount={linkByPlaidAccount}
              onUnlink={() => unlinkItem(item.id, item.institutionName)}
              onToggle={toggleAccountPref}
              onLinkCard={(acct) => setLinkingCardFor(acct)}
              onUnlinkCard={unlinkCardFromPlaid}
              unlinkingId={unlinkingId}
            />
          ))
        )}
      </div>

      {/* Link-card chooser dialog */}
      {linkingCardFor && (
        <PlaidLinkCardDialog
          account={linkingCardFor}
          cards={cards.map((c) => c.card)}
          onClose={() => setLinkingCardFor(null)}
          onLinked={async () => {
            setLinkingCardFor(null);
            await refreshCards();
          }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Institution card
// ─────────────────────────────────────────────────────────────────────────────

function InstitutionCard({
  item,
  health,
  timeZone,
  linkByPlaidAccount,
  onUnlink,
  onToggle,
  onLinkCard,
  onUnlinkCard,
  unlinkingId,
}: {
  item: ItemWithAccounts;
  health: BankItemHealth;
  timeZone: string;
  linkByPlaidAccount: Map<string, CardWithStatements>;
  onUnlink: () => void;
  onToggle: (id: string, field: "useAsStartingBalance" | "syncEnabled", value: boolean) => void;
  onLinkCard: (acct: PlaidAccountRow) => void;
  onUnlinkCard: (plaidAccountId: string) => void;
  unlinkingId: string | null;
}) {
  const unhealthy = health.status !== "ok";
  const severe = health.status === "failing";
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-sm border bg-[var(--bg-card)] p-4",
        !unhealthy && "border-[var(--border-2)]",
        unhealthy && !severe && "border-[color-mix(in_oklch,var(--amber)_45%,transparent)]",
        severe && "border-[color-mix(in_oklch,var(--red)_45%,transparent)]",
      )}
    >
      <span className="absolute right-2 top-2 h-2 w-2 border-r border-t border-[var(--mint-dim)]" />
      <span className="absolute bottom-2 left-2 h-2 w-2 border-b border-l border-[var(--mint-dim)]" />

      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-sm border border-[var(--mint-dim)] bg-[var(--bg-2)] text-[var(--mint)]">
            <Building2 className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[13px] font-bold text-[var(--text-0)]">
              {item.institutionName}
            </div>
            <div className="text-2xs text-[var(--text-3)]">
              {item.accounts.length} account{item.accounts.length !== 1 ? "s" : ""}
              {item.lastSyncedAt ? (
                <> · {bankHealthLastSyncLabel(health)} <DateLabel iso={isoDateInTimeZone(item.lastSyncedAt, timeZone)} format="short" /></>
              ) : (
                " · Never synced"
              )}
            </div>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onUnlink} aria-label="Unlink institution">
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {unhealthy ? (
        <div
          role="group"
          aria-label={`${item.institutionName} connection problem`}
          className={cn(
            "mb-4 rounded-sm border px-3 py-2.5 text-2xs text-[var(--text-1)]",
            severe
              ? "border-[color-mix(in_oklch,var(--red)_30%,transparent)] bg-[var(--red-glow)]"
              : "border-[color-mix(in_oklch,var(--amber)_25%,transparent)] bg-[color-mix(in_oklch,var(--amber)_8%,transparent)]",
          )}
        >
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <StatusPill variant={severe ? "danger" : "warn"}>
              {bankHealthShortLabel(health)}
            </StatusPill>
            <span className="font-semibold text-[var(--text-0)]">{bankHealthReason(health)}</span>
          </div>
          <p className="leading-snug">
            {health.lastSuccessAt != null ? (
              <>
                {bankHealthLastSyncLabel(health)}{" "}
                <DateLabel iso={isoDateInTimeZone(health.lastSuccessAt, timeZone)} format="long" />.{" "}
              </>
            ) : (
              "This bank has never synced. "
            )}
            {bankHealthAction(health)}
          </p>
        </div>
      ) : null}

      <div className="space-y-2">
        {item.accounts.map((acct) => (
          <AccountRow
            key={acct.id}
            account={acct}
            link={linkByPlaidAccount.get(acct.id)}
            onToggle={onToggle}
            onLinkCard={onLinkCard}
            onUnlinkCard={onUnlinkCard}
            unlinking={unlinkingId === acct.id}
          />
        ))}
      </div>
    </div>
  );
}

function AccountRow({
  account,
  link,
  onToggle,
  onLinkCard,
  onUnlinkCard,
  unlinking,
}: {
  account: PlaidAccountRow;
  link: CardWithStatements | undefined;
  onToggle: (id: string, field: "useAsStartingBalance" | "syncEnabled", value: boolean) => void;
  onLinkCard: (acct: PlaidAccountRow) => void;
  onUnlinkCard: (plaidAccountId: string) => void;
  unlinking: boolean;
}) {
  const typeLabel = [account.subtype ?? account.type].join(" ").toUpperCase();
  const isCredit = account.type === "credit";
  const balanceColor =
    isCredit && account.balanceCents != null && account.balanceCents > 0
      ? "text-[var(--amber)]"
      : "text-[var(--mint)]";

  // Most recent statement on the linked card, if any.
  const latestStatement = link?.statements[0];

  // Horizontal strip: identity grows on the left, controls and balance sit
  // in fixed columns on the right. Stacks vertically below md.
  return (
    <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] px-3 py-2.5">
      <div className="flex flex-col gap-2.5 md:flex-row md:items-center md:gap-4">
        {/* identity + card linkage */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold text-[var(--text-0)] truncate">
              {account.name}
            </span>
            {account.mask && (
              <span className="text-2xs text-[var(--text-3)] shrink-0">
                ****{account.mask}
              </span>
            )}
            <StatusPill variant="default">{typeLabel}</StatusPill>
          </div>
          {isCredit && (
            <div className="mt-1.5">
              {link ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-[var(--text-2)]">
                  <span className="flex items-center gap-1 font-bold text-[var(--mint)]">
                    <Link2 className="h-2.5 w-2.5" />
                    {link.card.name}
                  </span>
                  <span>
                    {link.card.statementCycleMode === "interval_days"
                      ? `${link.card.statementCycleIntervalDays}D CYCLE`
                      : `Stmt day ${link.card.statementDay}`}{" "}
                    · Due day {link.card.dueDay}
                    {latestStatement && (
                      <>
                        {" · Next due "}
                        <DateLabel iso={latestStatement.dueDate} format="short" />
                        {" · "}
                        <Money cents={interestSavingCashDueCents(latestStatement, link.promos)} />
                      </>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onUnlinkCard(account.id)}
                    disabled={unlinking}
                    aria-label="Unlink card"
                    title="Unlink from credit card"
                  >
                    <Unlink className="h-3 w-3" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-2xs text-[var(--text-3)]">
                    Not linked to a credit card
                  </span>
                  <Button
                    id={`link-card-${account.id}`}
                    size="sm"
                    variant="outline"
                    onClick={() => onLinkCard(account)}
                  >
                    <Link2 className="h-3 w-3" />
                    Link card
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* toggles */}
        <div className="flex shrink-0 items-center gap-4 text-2xs text-[var(--text-2)]">
          <label
            className="flex cursor-pointer items-center gap-1.5"
            title="Use this account's live balance as the projection's starting balance"
          >
            <span>Balance source</span>
            <Switch
              id={`starting-balance-${account.id}`}
              checked={account.useAsStartingBalance}
              onCheckedChange={(v) => onToggle(account.id, "useAsStartingBalance", v)}
            />
          </label>
          <label
            className="flex cursor-pointer items-center gap-1.5"
            title="Include this account in transaction sync"
          >
            <span>Sync</span>
            <Switch
              id={`sync-enabled-${account.id}`}
              checked={account.syncEnabled}
              onCheckedChange={(v) => onToggle(account.id, "syncEnabled", v)}
            />
          </label>
        </div>

        {/* balance */}
        <div className={cn("shrink-0 text-[15px] font-bold tabular md:w-28 md:text-right", balanceColor)}>
          {account.balanceCents != null ? <Money cents={account.balanceCents} /> : <span className="text-[var(--text-3)] text-[11px]">—</span>}
        </div>
      </div>
    </div>
  );
}

