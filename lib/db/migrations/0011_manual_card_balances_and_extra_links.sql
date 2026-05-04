ALTER TABLE `credit_cards` ADD `current_balance_cents` integer;
--> statement-breakpoint
ALTER TABLE `one_time_expenses` ADD `paid_via_card_id` text;
