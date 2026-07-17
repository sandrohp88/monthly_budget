ALTER TABLE `plaid_items` ADD `plaid_item_id` text;
--> statement-breakpoint
CREATE INDEX `plaid_items_plaid_item_idx` ON `plaid_items` (`plaid_item_id`);