CREATE TABLE `bill_payment_states` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `bill_id` TEXT NOT NULL REFERENCES `bills`(`id`) ON DELETE CASCADE,
  `due_date` TEXT NOT NULL,
  `state` TEXT NOT NULL,
  `amount_cents` INTEGER,
  `marked_date` TEXT NOT NULL,
  `notes` TEXT,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bill_payment_states_bill_date_unique_idx` ON `bill_payment_states`(`bill_id`,`due_date`);
--> statement-breakpoint
CREATE INDEX `bill_payment_states_user_date_idx` ON `bill_payment_states`(`user_id`,`due_date`);
