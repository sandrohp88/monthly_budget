CREATE TABLE `assets` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `user_id` TEXT NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
  `name` TEXT NOT NULL,
  `value_cents` INTEGER NOT NULL,
  `category` TEXT NOT NULL DEFAULT 'other',
  `notes` TEXT,
  `as_of_date` TEXT NOT NULL,
  `is_active` INTEGER NOT NULL DEFAULT 1,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE INDEX `assets_user_idx` ON `assets`(`user_id`);
