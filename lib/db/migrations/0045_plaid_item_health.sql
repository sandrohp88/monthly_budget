ALTER TABLE `plaid_items` ADD `last_error_code` text;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `last_error_at` integer;--> statement-breakpoint
ALTER TABLE `plaid_items` ADD `first_error_at` integer;
