ALTER TABLE plaid_transaction_drafts ADD COLUMN kind text DEFAULT 'expense' NOT NULL;
--> statement-breakpoint
UPDATE plaid_transaction_drafts
SET kind = 'card_payment'
WHERE amount_cents > 0
  AND plaid_category = 'LOAN_PAYMENTS'
  AND account_id IN (SELECT id FROM plaid_accounts WHERE type = 'credit');
