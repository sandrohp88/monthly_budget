ALTER TABLE plaid_transaction_drafts ADD COLUMN original_description text;
--> statement-breakpoint
UPDATE plaid_transaction_drafts
SET status = 'approved'
WHERE status = 'pending_review';
