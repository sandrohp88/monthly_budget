"use client";

import * as React from "react";
import {
  Building2,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Link2,
  RefreshCw,
  Trash2,
  Inbox,
  Unlink,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { CardSubTag, PageHead } from "@/components/ui/page-head";
import { Tile, TileGrid } from "@/components/ui/tile";
import { StatusPill } from "@/components/ui/status-pill";
import { Badge } from "@/components/ui/badge";
import { AlertBar } from "@/components/ui/alert-bar";
import { Switch } from "@/components/ui/switch";
import { Money } from "@/components/money";
import { DateLabel } from "@/components/date-label";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import { PlaidDraftApproveDialog } from "@/components/plaid-draft-approve-dialog";
import { PlaidLinkCardDialog } from "@/components/plaid-link-card-dialog";
import { cn } from "@/lib/cn";
import type {
  PlaidItemRow,
  PlaidAccountRow,
  CreditCardRow,
  CreditCardStatementRow,
} from "@/lib/db/schema";
import type { DraftWithAccount } from "@/app/api/plaid/drafts/route";

type ItemWithAccounts = PlaidItemRow & { accounts: PlaidAccountRow[] };
type CardWithStatements = { card: CreditCardRow; statements: CreditCardStatementRow[] };

export function AccountsClient({
  initialItems,
  initialPendingCount,
  initialCards,
  categoryNames,
}: {
  initialItems: ItemWithAccounts[];
  initialPendingCount: number;
  initialCards: CardWithStatements[];
  categoryNames: string[];
}) {
  const [items, setItems] = React.useState<ItemWithAccounts[]>(initialItems);
  const [cards, setCards] = React.useState<CardWithStatements[]>(initialCards);
  const [pendingCount, setPendingCount] = React.useState(initialPendingCount);
  const [tab, setTab] = React.useState<"accounts" | "inbox">("accounts");
  const [syncing, setSyncing] = React.useState(false);
  const [drafts, setDrafts] = React.useState<DraftWithAccount[] | null>(null);
  const [historyDrafts, setHistoryDrafts] = React.useState<DraftWithAccount[] | null>(null);
  const [showHistory, setShowHistory] = React.useState(false);
  const [approvingDraft, setApprovingDraft] = React.useState<DraftWithAccount | null>(null);
  const [dismissingId, setDismissingId] = React.useState<string | null>(null);
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
    .filter(Boolean)
    .sort()
    .at(-1);

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

  const fetchDrafts = React.useCallback(async () => {
    const res = await fetch("/api/plaid/drafts?status=pending_review");
    if (!res.ok) return;
    const json = await res.json() as { drafts: DraftWithAccount[] };
    setDrafts(json.drafts);
    setPendingCount(json.drafts.length);
  }, []);

  const fetchHistory = async () => {
    const res = await fetch("/api/plaid/drafts?status=all");
    if (!res.ok) return;
    const json = await res.json() as { drafts: DraftWithAccount[] };
    setHistoryDrafts(json.drafts.filter((d) => d.status !== "pending_review"));
  };

  // Load drafts when switching to inbox tab.
  React.useEffect(() => {
    if (tab === "inbox" && drafts === null) {
      fetchDrafts();
    }
  }, [tab, drafts, fetchDrafts]);

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
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Sync failed");
      const txnPart = `${json.added ?? 0} new, ${json.modified ?? 0} updated`;
      const cardPart =
        (json.cardsUpdated ?? 0) > 0 || (json.statementsCreated ?? 0) > 0
          ? ` · ${json.cardsUpdated ?? 0} card${(json.cardsUpdated ?? 0) === 1 ? "" : "s"}, ${json.statementsCreated ?? 0} statement${(json.statementsCreated ?? 0) === 1 ? "" : "s"}`
          : "";
      toast.success(`Sync complete — ${txnPart}${cardPart}`);
      await Promise.all([refreshItems(), refreshCards(), fetchDrafts()]);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  const unlinkItem = async (id: string, name: string) => {
    if (!confirm(`Unlink ${name}? This cannot be undone.`)) return;
    const res = await fetch(`/api/plaid/items/${id}`, { method: "DELETE" });
    if (!res.ok) { toast.error("Unlink failed"); return; }
    toast.success(`${name} unlinked`);
    await Promise.all([refreshItems(), refreshCards()]);
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
  };

  const dismissDraft = async (id: string) => {
    setDismissingId(id);
    try {
      const res = await fetch(`/api/plaid/drafts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "dismiss" }),
      });
      if (!res.ok) throw new Error("Dismiss failed");
      toast.success("Transaction dismissed");
      await fetchDrafts();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDismissingId(null);
    }
  };

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 fade-in">
      <PageHead
        module="MODULE_08"
        title="ACCOUNTS"
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
              {syncing ? "SYNCING…" : "SYNC NOW"}
            </Button>
            <PlaidLinkButton
              onLinked={async () => {
                await refreshItems();
                toast.success("Account linked — click Sync Now to import transactions");
              }}
            />
          </div>
        }
      />

      <TileGrid cols="auto">
        <Tile label="LINKED INSTITUTIONS" value={items.length} delta={`${totalAccounts} account${totalAccounts !== 1 ? "s" : ""}`} />
        <Tile
          label="PENDING REVIEW"
          value={pendingCount}
          variant={pendingCount > 0 ? "amber" : "default"}
          delta={pendingCount > 0 ? "transactions awaiting review" : "inbox clear"}
          badge={pendingCount > 0 ? <Badge variant="warning">{pendingCount}</Badge> : undefined}
        />
        <Tile
          label="LAST SYNC"
          value={lastSynced ? <DateLabel iso={new Date(lastSynced).toISOString().slice(0, 10)} format="short" /> : "—"}
          delta={lastSynced ? `${new Date().toLocaleTimeString()}` : "never synced"}
        />
      </TileGrid>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-[var(--border-raw)]">
        {(["accounts", "inbox"] as const).map((t) => (
          <button
            key={t}
            id={`tab-${t}`}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-[10px] uppercase tracking-[0.15em] border-b-2 -mb-px transition-colors",
              tab === t
                ? "border-[var(--mint)] text-[var(--mint)]"
                : "border-transparent text-[var(--text-2)] hover:text-[var(--text-1)]",
            )}
          >
            {t === "inbox" ? `INBOX${pendingCount > 0 ? ` (${pendingCount})` : ""}` : "ACCOUNTS"}
          </button>
        ))}
      </div>

      {/* ── ACCOUNTS TAB ── */}
      {tab === "accounts" && (
        <div className="space-y-4">
          {items.length === 0 ? (
            <Card>
              <CardHeader><CardTitle>NO LINKED ACCOUNTS</CardTitle></CardHeader>
              <div className="px-4 py-8 text-center space-y-3">
                <p className="text-[11px] tracking-wide text-[var(--text-2)]">
                  Link a bank account or credit card to start importing transactions automatically.
                </p>
                <PlaidLinkButton onLinked={async () => { await refreshItems(); }} />
              </div>
            </Card>
          ) : (
            items.map((item) => (
              <InstitutionCard
                key={item.id}
                item={item}
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
      )}

      {/* ── INBOX TAB ── */}
      {tab === "inbox" && (
        <div className="space-y-4">
          {pendingCount > 0 && (
            <AlertBar
              tag="PENDING"
              variant="amber"
            >
              {pendingCount} transaction{pendingCount !== 1 ? "s" : ""} awaiting your review
            </AlertBar>
          )}

          {drafts === null ? (
            <div className="text-[11px] uppercase tracking-wide text-[var(--text-3)] py-8 text-center">
              LOADING…
            </div>
          ) : drafts.length === 0 ? (
            <Card>
              <div className="flex flex-col items-center gap-2 py-10 text-[var(--text-2)]">
                <Inbox className="h-8 w-8 opacity-30" />
                <p className="text-[11px] uppercase tracking-[0.15em]">Inbox clear</p>
                <p className="text-[10px] tracking-wide text-[var(--text-3)]">
                  Click &quot;Sync Now&quot; to pull the latest transactions from your linked accounts.
                </p>
              </div>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardSubTag>TRANSACTION_INBOX</CardSubTag>
                <CardTitle>PENDING REVIEW</CardTitle>
              </CardHeader>
              <div className="divide-y divide-[var(--border-raw)]">
                {drafts.map((draft) => (
                  <DraftRow
                    key={draft.id}
                    draft={draft}
                    onApprove={() => setApprovingDraft(draft)}
                    onDismiss={() => dismissDraft(draft.id)}
                    dismissing={dismissingId === draft.id}
                  />
                ))}
              </div>
            </Card>
          )}

          {/* History section */}
          <div>
            <button
              onClick={async () => {
                if (!showHistory) await fetchHistory();
                setShowHistory((s) => !s);
              }}
              className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.15em] text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors"
            >
              {showHistory ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {"// HISTORY"}
            </button>
            {showHistory && historyDrafts && historyDrafts.length > 0 && (
              <Card className="mt-2">
                <div className="divide-y divide-[var(--border-raw)]">
                  {historyDrafts.map((draft) => (
                    <HistoryRow key={draft.id} draft={draft} />
                  ))}
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Approve dialog */}
      {approvingDraft && (
        <PlaidDraftApproveDialog
          draft={approvingDraft}
          categories={categoryNames}
          onClose={() => setApprovingDraft(null)}
          onApproved={async () => {
            setApprovingDraft(null);
            await fetchDrafts();
          }}
        />
      )}

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
  linkByPlaidAccount,
  onUnlink,
  onToggle,
  onLinkCard,
  onUnlinkCard,
  unlinkingId,
}: {
  item: ItemWithAccounts;
  linkByPlaidAccount: Map<string, CardWithStatements>;
  onUnlink: () => void;
  onToggle: (id: string, field: "useAsStartingBalance" | "syncEnabled", value: boolean) => void;
  onLinkCard: (acct: PlaidAccountRow) => void;
  onUnlinkCard: (plaidAccountId: string) => void;
  unlinkingId: string | null;
}) {
  return (
    <div className="relative overflow-hidden rounded-sm border border-[var(--border-2)] bg-[var(--bg-card)] p-4">
      <span className="absolute right-2 top-2 h-2 w-2 border-r border-t border-[var(--mint-dim)]" />
      <span className="absolute bottom-2 left-2 h-2 w-2 border-b border-l border-[var(--mint-dim)]" />

      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <div className="grid h-8 w-8 place-items-center rounded-sm border border-[var(--mint-dim)] bg-[var(--bg-2)] text-[var(--mint)]">
            <Building2 className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[13px] font-bold uppercase tracking-[0.1em] text-[var(--text-0)]">
              {item.institutionName}
            </div>
            <div className="text-[9px] uppercase tracking-[0.15em] text-[var(--text-3)]">
              {item.accounts.length} ACCOUNT{item.accounts.length !== 1 ? "S" : ""}
              {item.lastSyncedAt ? (
                <> · LAST SYNC <DateLabel iso={new Date(item.lastSyncedAt).toISOString().slice(0, 10)} format="short" /></>
              ) : (
                " · NEVER SYNCED"
              )}
            </div>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onUnlink} aria-label="Unlink institution">
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

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

  return (
    <div className="rounded-sm border border-[var(--border-raw)] bg-[var(--bg-1)] px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-0)] truncate">
              {account.name}
            </span>
            {account.mask && (
              <span className="text-[9px] text-[var(--text-3)] shrink-0">
                ****{account.mask}
              </span>
            )}
            <StatusPill variant="default">{typeLabel}</StatusPill>
          </div>
        </div>
        <div className={cn("text-[15px] font-bold tabular shrink-0", balanceColor)}>
          {account.balanceCents != null ? <Money cents={account.balanceCents} /> : <span className="text-[var(--text-3)] text-[11px]">—</span>}
        </div>
      </div>

      {/* Credit-card linkage section */}
      {isCredit && (
        <div className="mt-2">
          {link ? (
            <div className="rounded-sm border border-[var(--mint-dim)] bg-[var(--bg-2)] px-2.5 py-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.15em] text-[var(--mint)]">
                    <Link2 className="h-2.5 w-2.5" />
                    LINKED CARD
                  </div>
                  <div className="mt-0.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--text-0)] truncate">
                    {link.card.name}
                  </div>
                  <div className="mt-0.5 text-[9px] uppercase tracking-[0.12em] text-[var(--text-2)]">
                    {link.card.statementCycleMode === "interval_days"
                      ? `${link.card.statementCycleIntervalDays}D CYCLE`
                      : `STMT DAY ${link.card.statementDay}`}{" "}
                    · DUE DAY {link.card.dueDay}
                    {latestStatement && (
                      <>
                        {" · NEXT DUE "}
                        <DateLabel iso={latestStatement.dueDate} format="short" />
                        {" · "}
                        <Money cents={latestStatement.statementBalanceCents} />
                      </>
                    )}
                  </div>
                </div>
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
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 rounded-sm border border-dashed border-[var(--border-raw)] bg-[var(--bg-2)] px-2.5 py-1.5">
              <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-3)]">
                NOT LINKED TO A CREDIT CARD
              </span>
              <Button
                id={`link-card-${account.id}`}
                size="sm"
                variant="outline"
                onClick={() => onLinkCard(account)}
              >
                <Link2 className="h-3 w-3" />
                LINK CARD
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Toggles */}
      <div className="mt-2 flex flex-col gap-1.5 text-[9px] uppercase tracking-[0.12em] text-[var(--text-2)]">
        <label className="flex cursor-pointer items-center justify-between">
          <span>USE AS STARTING BALANCE IN PROJECTION</span>
          <Switch
            id={`starting-balance-${account.id}`}
            checked={account.useAsStartingBalance}
            onCheckedChange={(v) => onToggle(account.id, "useAsStartingBalance", v)}
          />
        </label>
        <label className="flex cursor-pointer items-center justify-between">
          <span>INCLUDE IN TRANSACTION SYNC</span>
          <Switch
            id={`sync-enabled-${account.id}`}
            checked={account.syncEnabled}
            onCheckedChange={(v) => onToggle(account.id, "syncEnabled", v)}
          />
        </label>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Draft inbox rows
// ─────────────────────────────────────────────────────────────────────────────

function DraftRow({
  draft,
  onApprove,
  onDismiss,
  dismissing,
}: {
  draft: DraftWithAccount;
  onApprove: () => void;
  onDismiss: () => void;
  dismissing: boolean;
}) {
  const isCredit = draft.amountCents < 0;

  return (
    <div className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--bg-2)] transition-colors">
      <div className="shrink-0 w-20 text-[10px] uppercase tracking-[0.08em] text-[var(--text-2)]">
        <DateLabel iso={draft.date} format="short" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-0)]">
          {draft.merchantName ?? draft.description}
        </div>
        <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.1em] text-[var(--text-3)]">
          {draft.accountName}
          {draft.accountMask && <> ****{draft.accountMask}</>}
          {draft.plaidCategory && (
            <span className="text-[var(--text-3)] ml-1">· {draft.plaidCategory}</span>
          )}
        </div>
      </div>
      <div className={cn("shrink-0 text-[15px] font-bold tabular", isCredit ? "text-[var(--mint)]" : "text-[var(--red)]")}>
        {isCredit ? "+" : "-"}<Money cents={Math.abs(draft.amountCents)} />
      </div>
      <div className="flex gap-1 shrink-0">
        <Button id={`approve-draft-${draft.id}`} size="sm" variant="primary" onClick={onApprove}>
          <CheckCircle2 className="h-3 w-3" /> APPROVE
        </Button>
        <Button
          id={`dismiss-draft-${draft.id}`}
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          disabled={dismissing}
          aria-label="Dismiss"
        >
          <XCircle className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

function HistoryRow({ draft }: { draft: DraftWithAccount }) {
  const isApproved = draft.status === "approved";
  const isCredit = draft.amountCents < 0;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 opacity-60">
      <div className="shrink-0 w-20 text-[10px] uppercase tracking-[0.08em] text-[var(--text-2)]">
        <DateLabel iso={draft.date} format="short" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="truncate text-[11px] uppercase tracking-[0.08em] text-[var(--text-1)]">
          {draft.merchantName ?? draft.description}
        </div>
      </div>
      <div className={cn("shrink-0 text-[13px] font-bold tabular", isCredit ? "text-[var(--mint)]" : "text-[var(--text-1)]")}>
        {isCredit ? "+" : ""}<Money cents={Math.abs(draft.amountCents)} />
      </div>
      <StatusPill variant={isApproved ? "default" : "off"}>
        {isApproved ? "APPROVED" : "DISMISSED"}
      </StatusPill>
    </div>
  );
}
