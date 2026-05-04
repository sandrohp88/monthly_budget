ALTER TABLE `credit_cards` ADD COLUMN `statement_cycle_mode` text NOT NULL DEFAULT 'calendar_day';--> statement-breakpoint
ALTER TABLE `credit_cards` ADD COLUMN `statement_cycle_anchor_date` text;--> statement-breakpoint
ALTER TABLE `credit_cards` ADD COLUMN `statement_cycle_interval_days` integer NOT NULL DEFAULT 31;
