CREATE TABLE `credit_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`statement_day` integer NOT NULL,
	`due_day` integer NOT NULL,
	`auto_pay` integer DEFAULT false NOT NULL,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `credit_cards_user_active_idx` ON `credit_cards` (`user_id`,`is_active`);
--> statement-breakpoint
CREATE TABLE `credit_card_statements` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`statement_date` text NOT NULL,
	`due_date` text NOT NULL,
	`statement_balance_cents` integer NOT NULL,
	`paid_amount_cents` integer,
	`paid_date` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cc_statements_card_due_idx` ON `credit_card_statements` (`card_id`,`due_date`);
