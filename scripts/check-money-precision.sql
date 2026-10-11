-- Read-only pre-flight for scripts/migrate-money-to-decimal.sql.
-- Money columns are about to change from double precision to numeric(14,2).
-- Any stored value with more than 2 decimal places will be ROUNDED to the
-- pesewa by the migration; this lists how many rows per column that affects,
-- plus values too large for numeric(14,2). Expect zero everywhere. Run with:
--   psql "$DATABASE_URL" -f scripts/check-money-precision.sql

SELECT 'contributions.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM contributions
UNION ALL
SELECT 'welfare_cases.amount_disbursed' AS column_name, count(*) FILTER (WHERE amount_disbursed IS NOT NULL AND round(amount_disbursed::numeric, 2) <> amount_disbursed::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount_disbursed) >= 1e12) AS too_large FROM welfare_cases
UNION ALL
SELECT 'funds.opening_balance' AS column_name, count(*) FILTER (WHERE opening_balance IS NOT NULL AND round(opening_balance::numeric, 2) <> opening_balance::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(opening_balance) >= 1e12) AS too_large FROM funds
UNION ALL
SELECT 'journal_lines.debit' AS column_name, count(*) FILTER (WHERE debit IS NOT NULL AND round(debit::numeric, 2) <> debit::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(debit) >= 1e12) AS too_large FROM journal_lines
UNION ALL
SELECT 'journal_lines.credit' AS column_name, count(*) FILTER (WHERE credit IS NOT NULL AND round(credit::numeric, 2) <> credit::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(credit) >= 1e12) AS too_large FROM journal_lines
UNION ALL
SELECT 'expenses.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM expenses
UNION ALL
SELECT 'finance_projects.target_amount' AS column_name, count(*) FILTER (WHERE target_amount IS NOT NULL AND round(target_amount::numeric, 2) <> target_amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(target_amount) >= 1e12) AS too_large FROM finance_projects
UNION ALL
SELECT 'finance_budget_lines.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM finance_budget_lines
UNION ALL
SELECT 'finance_settings.small_expense_max' AS column_name, count(*) FILTER (WHERE small_expense_max IS NOT NULL AND round(small_expense_max::numeric, 2) <> small_expense_max::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(small_expense_max) >= 1e12) AS too_large FROM finance_settings
UNION ALL
SELECT 'finance_settings.medium_expense_max' AS column_name, count(*) FILTER (WHERE medium_expense_max IS NOT NULL AND round(medium_expense_max::numeric, 2) <> medium_expense_max::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(medium_expense_max) >= 1e12) AS too_large FROM finance_settings
UNION ALL
SELECT 'income_records.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM income_records
UNION ALL
SELECT 'day_born_collections.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM day_born_collections
UNION ALL
SELECT 'finance_receipts.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM finance_receipts
UNION ALL
SELECT 'tithes.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM tithes
UNION ALL
SELECT 'services.total_amount' AS column_name, count(*) FILTER (WHERE total_amount IS NOT NULL AND round(total_amount::numeric, 2) <> total_amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(total_amount) >= 1e12) AS too_large FROM services
UNION ALL
SELECT 'harvests.total_collected' AS column_name, count(*) FILTER (WHERE total_collected IS NOT NULL AND round(total_collected::numeric, 2) <> total_collected::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(total_collected) >= 1e12) AS too_large FROM harvests
UNION ALL
SELECT 'day_born_splits.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM day_born_splits
UNION ALL
SELECT 'special_offerings.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM special_offerings
UNION ALL
SELECT 'pledges.pledged_amount' AS column_name, count(*) FILTER (WHERE pledged_amount IS NOT NULL AND round(pledged_amount::numeric, 2) <> pledged_amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(pledged_amount) >= 1e12) AS too_large FROM pledges
UNION ALL
SELECT 'pledges.paid_amount' AS column_name, count(*) FILTER (WHERE paid_amount IS NOT NULL AND round(paid_amount::numeric, 2) <> paid_amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(paid_amount) >= 1e12) AS too_large FROM pledges
UNION ALL
SELECT 'pledge_payments.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM pledge_payments
UNION ALL
SELECT 'cash_count_sheets.expected_amount' AS column_name, count(*) FILTER (WHERE expected_amount IS NOT NULL AND round(expected_amount::numeric, 2) <> expected_amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(expected_amount) >= 1e12) AS too_large FROM cash_count_sheets
UNION ALL
SELECT 'cash_count_sheets.counted_amount' AS column_name, count(*) FILTER (WHERE counted_amount IS NOT NULL AND round(counted_amount::numeric, 2) <> counted_amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(counted_amount) >= 1e12) AS too_large FROM cash_count_sheets
UNION ALL
SELECT 'cash_count_lines.denomination' AS column_name, count(*) FILTER (WHERE denomination IS NOT NULL AND round(denomination::numeric, 2) <> denomination::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(denomination) >= 1e12) AS too_large FROM cash_count_lines
UNION ALL
SELECT 'cash_count_lines.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM cash_count_lines
UNION ALL
SELECT 'bank_deposits.amount' AS column_name, count(*) FILTER (WHERE amount IS NOT NULL AND round(amount::numeric, 2) <> amount::numeric) AS would_be_rounded, count(*) FILTER (WHERE abs(amount) >= 1e12) AS too_large FROM bank_deposits
ORDER BY 1;
