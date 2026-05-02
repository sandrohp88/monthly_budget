CREATE TABLE `__new_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`interval_months` integer NOT NULL,
	`anchor_date` text NOT NULL,
	`auto_pay` integer DEFAULT false NOT NULL,
	`paid_via_card_id` text,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_bills` (
	`id`, `user_id`, `name`, `category`, `amount_cents`,
	`interval_months`, `anchor_date`,
	`auto_pay`, `paid_via_card_id`, `notes`, `is_active`,
	`created_at`, `updated_at`
)
SELECT
	`id`, `user_id`, `name`, `category`, `amount_cents`,
	CASE WHEN `frequency` = 'annual' THEN 12 ELSE 1 END,
	CASE
		WHEN `frequency` = 'monthly' THEN '2024-01-' || printf('%02d', `due_day`)
		ELSE '2024-' || printf('%02d', COALESCE(`due_month`, 1)) || '-' || printf('%02d',
			MIN(`due_day`,
				CASE COALESCE(`due_month`, 1)
					WHEN 2 THEN 29
					WHEN 4 THEN 30
					WHEN 6 THEN 30
					WHEN 9 THEN 30
					WHEN 11 THEN 30
					ELSE 31
				END))
	END,
	`auto_pay`, `paid_via_card_id`, `notes`, `is_active`,
	`created_at`, `updated_at`
FROM `bills`;
--> statement-breakpoint
DROP TABLE `bills`;
--> statement-breakpoint
ALTER TABLE `__new_bills` RENAME TO `bills`;
--> statement-breakpoint
CREATE INDEX `bills_user_active_idx` ON `bills` (`user_id`,`is_active`);
