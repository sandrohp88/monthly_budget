CREATE UNIQUE INDEX `cc_statements_settled_by_draft_unique_idx` ON `credit_card_statements` (`settled_by_draft_id`) WHERE `settled_by_draft_id` IS NOT NULL;
