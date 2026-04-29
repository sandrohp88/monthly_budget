CREATE TABLE `plaid_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`institution_id` text NOT NULL,
	`institution_name` text NOT NULL,
	`access_token_enc` text NOT NULL,
	`access_token_iv` text NOT NULL,
	`access_token_tag` text NOT NULL,
	`cursor` text,
	`last_synced_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plaid_items_user_active_idx` ON `plaid_items` (`user_id`,`is_active`);
--> statement-breakpoint
CREATE TABLE `plaid_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`mask` text,
	`type` text NOT NULL,
	`subtype` text,
	`balance_cents` integer,
	`use_as_starting_balance` integer DEFAULT false NOT NULL,
	`sync_enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `plaid_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plaid_accounts_item_idx` ON `plaid_accounts` (`item_id`);
--> statement-breakpoint
CREATE INDEX `plaid_accounts_user_idx` ON `plaid_accounts` (`user_id`);
--> statement-breakpoint
CREATE TABLE `plaid_transaction_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`plaid_category` text,
	`merchant_name` text,
	`pending` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`linked_expense_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `plaid_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plaid_drafts_user_status_idx` ON `plaid_transaction_drafts` (`user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `plaid_drafts_account_idx` ON `plaid_transaction_drafts` (`account_id`);
