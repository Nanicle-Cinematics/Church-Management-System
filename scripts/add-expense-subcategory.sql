-- Expenses can name a subcategory within their category (e.g. Electricity under Utilities).
-- Additive and safe to run twice; run it on production, as the database owner, BEFORE
-- deploying the code that uses it.

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS subcategory TEXT;
