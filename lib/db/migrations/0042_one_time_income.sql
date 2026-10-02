-- One-time income (bonuses, tax refunds, gifts). Lives on `paychecks` so it
-- projects as income and auto-reconciles against deposits exactly like a
-- paycheck, but is excluded from schedule inference and schedule edits: a
-- schedule edit would otherwise move a bonus onto a payday and restate its
-- amount. Existing rows are all scheduled paychecks.
ALTER TABLE `paychecks` ADD COLUMN `is_one_time` INTEGER NOT NULL DEFAULT 0;
