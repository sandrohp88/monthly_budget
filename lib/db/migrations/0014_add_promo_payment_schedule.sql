CREATE TABLE `credit_card_promo_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`promo_id` text NOT NULL,
	`due_date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`promo_id`) REFERENCES `credit_card_promos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cc_promo_payments_promo_idx` ON `credit_card_promo_payments` (`promo_id`);
--> statement-breakpoint
CREATE INDEX `cc_promo_payments_user_idx` ON `credit_card_promo_payments` (`user_id`);
