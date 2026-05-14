ALTER TABLE `one_time_expenses` ADD COLUMN `is_active` INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `paychecks` ADD COLUMN `is_active` INTEGER NOT NULL DEFAULT 1;
