-- Replaces the magic-string sentinel "PayPal authoritative promo data" stored
-- in credit_card_promos.notes with a typed column. The string match was
-- fragile: any user editing notes (or normalizing whitespace) silently
-- dropped the FIFO short-circuit that protects PayPal's authoritative promo
-- list from being overwritten by transaction-history heuristics on the next
-- sync.
ALTER TABLE `credit_card_promos` ADD COLUMN `authoritative_source` text;
--> statement-breakpoint
-- Backfill: any existing row with the old sentinel string in notes is the
-- PayPal authoritative source. Strip the sentinel substring out of notes so
-- the typed column is the source of truth going forward.
UPDATE `credit_card_promos`
SET `authoritative_source` = 'paypal_promo_list',
    `updated_at` = unixepoch() * 1000
WHERE `authoritative_source` IS NULL
  AND `notes` LIKE '%PayPal authoritative promo data%';
