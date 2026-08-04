CREATE TABLE `draft_allocations` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `draft_id` TEXT NOT NULL REFERENCES `plaid_transaction_drafts`(`id`) ON DELETE CASCADE,
  `target_kind` TEXT NOT NULL,
  `target_id` TEXT NOT NULL,
  `target_date` TEXT NOT NULL,
  `amount_cents` INTEGER NOT NULL,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_allocations_unique_target_idx` ON `draft_allocations`(`draft_id`,`target_kind`,`target_id`,`target_date`);
--> statement-breakpoint
CREATE INDEX `draft_allocations_user_draft_idx` ON `draft_allocations`(`user_id`,`draft_id`);
