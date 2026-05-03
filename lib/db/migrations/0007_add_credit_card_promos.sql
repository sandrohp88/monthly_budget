CREATE TABLE `credit_card_promos` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`card_id` text NOT NULL,
	`description` text NOT NULL,
	`original_amount_cents` integer NOT NULL,
	`remaining_amount_cents` integer NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`monthly_payment_cents` integer,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cc_promos_user_active_idx` ON `credit_card_promos` (`user_id`,`is_active`);
--> statement-breakpoint
CREATE INDEX `cc_promos_card_idx` ON `credit_card_promos` (`card_id`);
