-- Converts every money column from double precision to numeric(14,2).
--
-- RUN THIS BEFORE deploying the code that expects Decimal columns, and run
-- scripts/check-money-precision.sql first (it should report zero rows).
-- Take a backup first (scripts/pg-backup.sh). One transaction: all or nothing.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrate-money-to-decimal.sql
--
-- USING round(col::numeric, 2) converts each stored double to the nearest
-- pesewa. Defaults (e.g. DEFAULT 0) are preserved. Each ALTER briefly takes an
-- exclusive lock on its table while it is rewritten; these tables are small.

BEGIN;

ALTER TABLE contributions ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE welfare_cases ALTER COLUMN amount_disbursed TYPE numeric(14,2) USING round(amount_disbursed::numeric, 2);
ALTER TABLE funds ALTER COLUMN opening_balance TYPE numeric(14,2) USING round(opening_balance::numeric, 2);
ALTER TABLE journal_lines ALTER COLUMN debit TYPE numeric(14,2) USING round(debit::numeric, 2);
ALTER TABLE journal_lines ALTER COLUMN credit TYPE numeric(14,2) USING round(credit::numeric, 2);
ALTER TABLE expenses ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE finance_projects ALTER COLUMN target_amount TYPE numeric(14,2) USING round(target_amount::numeric, 2);
ALTER TABLE finance_budget_lines ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE finance_settings ALTER COLUMN small_expense_max TYPE numeric(14,2) USING round(small_expense_max::numeric, 2);
ALTER TABLE finance_settings ALTER COLUMN medium_expense_max TYPE numeric(14,2) USING round(medium_expense_max::numeric, 2);
ALTER TABLE income_records ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE day_born_collections ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE finance_receipts ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE tithes ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE services ALTER COLUMN total_amount TYPE numeric(14,2) USING round(total_amount::numeric, 2);
ALTER TABLE harvests ALTER COLUMN total_collected TYPE numeric(14,2) USING round(total_collected::numeric, 2);
ALTER TABLE day_born_splits ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE special_offerings ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE pledges ALTER COLUMN pledged_amount TYPE numeric(14,2) USING round(pledged_amount::numeric, 2);
ALTER TABLE pledges ALTER COLUMN paid_amount TYPE numeric(14,2) USING round(paid_amount::numeric, 2);
ALTER TABLE pledge_payments ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE cash_count_sheets ALTER COLUMN expected_amount TYPE numeric(14,2) USING round(expected_amount::numeric, 2);
ALTER TABLE cash_count_sheets ALTER COLUMN counted_amount TYPE numeric(14,2) USING round(counted_amount::numeric, 2);
ALTER TABLE cash_count_lines ALTER COLUMN denomination TYPE numeric(14,2) USING round(denomination::numeric, 2);
ALTER TABLE cash_count_lines ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);
ALTER TABLE bank_deposits ALTER COLUMN amount TYPE numeric(14,2) USING round(amount::numeric, 2);

COMMIT;
