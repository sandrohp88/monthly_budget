-- Anchor the starting balance to a specific date so the projection knows
-- when the snapshot was taken. Backfills with `first_payday_date` for
-- existing rows — that's the closest-to-correct fallback we have for users
-- who set up before this column existed (the projection used it implicitly
-- as the start date when it was in the past).
ALTER TABLE `settings` ADD COLUMN `starting_balance_as_of` text NOT NULL DEFAULT '1970-01-01';
--> statement-breakpoint
UPDATE `settings` SET `starting_balance_as_of` = `first_payday_date` WHERE `starting_balance_as_of` = '1970-01-01';
