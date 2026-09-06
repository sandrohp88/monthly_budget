ALTER TABLE `credit_card_payment_overrides` ADD COLUMN `track_posting` INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
-- Preserve pre-feature history. Only the recent 12-day window (the existing
-- bill-reconciliation window) opts in at rollout; once opted in, holds NEVER
-- expire merely because time passes. New and edited plans always opt in.
UPDATE `credit_card_payment_overrides`
SET `track_posting` = 0
WHERE `due_date` < date('now', '-12 days');
