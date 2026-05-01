ALTER TABLE `credit_cards` ADD COLUMN `plaid_account_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `credit_cards_plaid_account_unique_idx` ON `credit_cards` (`plaid_account_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `cc_statements_card_date_unique_idx` ON `credit_card_statements` (`card_id`, `statement_date`);
