UPDATE `credit_card_statements` SET `settled_by_draft_id` = NULL
WHERE `settled_by_draft_id` IS NOT NULL
  AND `id` NOT IN (
    SELECT MIN(`id`) FROM `credit_card_statements`
    WHERE `settled_by_draft_id` IS NOT NULL
    GROUP BY `settled_by_draft_id`
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `cc_statements_settled_by_draft_unique_idx` ON `credit_card_statements` (`settled_by_draft_id`) WHERE `settled_by_draft_id` IS NOT NULL;
