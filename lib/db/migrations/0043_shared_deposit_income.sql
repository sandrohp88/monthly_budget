-- One posted deposit can be a paycheck and a one-time bonus together.
-- Migration 0029 let a draft settle only one paycheck, so the other income
-- stayed projected after the money had already landed. Drop that unique
-- index. This does not rewrite any row: existing settlements still point at
-- one paycheck. New settlements may share a draft; each row stores its own
-- share, and settlePaycheckSharesWithDraft refuses shares that sum past the
-- deposit.
DROP INDEX `paychecks_settled_by_draft_unique_idx`;
