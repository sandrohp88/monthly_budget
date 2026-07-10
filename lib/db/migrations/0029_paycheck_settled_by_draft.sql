ALTER TABLE `paychecks` ADD `settled_by_draft_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `paychecks_settled_by_draft_unique_idx` ON `paychecks` (`settled_by_draft_id`) WHERE `settled_by_draft_id` IS NOT NULL;
