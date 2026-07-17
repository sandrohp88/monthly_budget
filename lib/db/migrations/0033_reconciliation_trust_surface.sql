ALTER TABLE `bills` ADD `match_alias` text;
--> statement-breakpoint
ALTER TABLE `plaid_transaction_drafts` ADD `bill_match_excluded` integer DEFAULT 0 NOT NULL;