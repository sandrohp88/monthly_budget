CREATE TABLE `credit_card_payment_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`card_id` text NOT NULL,
	`due_date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cc_payment_overrides_user_date_idx` ON `credit_card_payment_overrides` (`user_id`,`due_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `cc_payment_overrides_card_date_unique_idx` ON `credit_card_payment_overrides` (`card_id`,`due_date`);
