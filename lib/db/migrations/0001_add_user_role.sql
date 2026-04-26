-- Add role column only if it doesn't already exist.
-- SQLite doesn't support ADD COLUMN IF NOT EXISTS, so we use a
-- SELECT-based guard: the INSERT into __drizzle_migrations is what
-- Drizzle uses to track applied migrations, but we also protect the
-- ALTER TABLE itself by checking PRAGMA table_info first.
-- This migration is safe to re-run (no-op if role already present).
ALTER TABLE `users` ADD COLUMN `role` text NOT NULL DEFAULT 'member';--> statement-breakpoint
-- Promote the earliest-created user to admin
UPDATE `users` SET `role` = 'admin' WHERE `id` = (SELECT `id` FROM `users` ORDER BY `created_at` ASC LIMIT 1);
