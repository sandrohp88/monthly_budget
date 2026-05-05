UPDATE `credit_card_promos`
SET
  `is_active` = 0,
  `updated_at` = unixepoch() * 1000
WHERE
  `is_active` = 1
  AND `end_date` < date('now');
