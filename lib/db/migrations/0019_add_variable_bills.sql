CREATE TABLE `variable_bills` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `name` text NOT NULL,
  `category` text NOT NULL,
  `amount_cents` integer NOT NULL,
  `interval_months` integer NOT NULL,
  `anchor_date` text NOT NULL,
  `notes` text,
  `is_active` integer DEFAULT true NOT NULL,
  `created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  `updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `variable_bills_user_active_idx` ON `variable_bills` (`user_id`, `is_active`);
--> statement-breakpoint
CREATE TABLE `variable_bill_cards` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `variable_bill_id` text NOT NULL,
  `card_id` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`variable_bill_id`) REFERENCES `variable_bills`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`card_id`) REFERENCES `credit_cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `variable_bill_cards_user_idx` ON `variable_bill_cards` (`user_id`);
--> statement-breakpoint
CREATE INDEX `variable_bill_cards_bill_idx` ON `variable_bill_cards` (`variable_bill_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `variable_bill_cards_bill_card_unique_idx` ON `variable_bill_cards` (`variable_bill_id`, `card_id`);
