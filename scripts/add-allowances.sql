-- Monthly allowances (Finance > Allowances) and device notifications (Web
-- Push). See prisma/schema.prisma: Allowance, AllowanceRun, PushSubscription,
-- and the new Expense / FinanceSetting columns. Additive and safe to run
-- twice; run it on production before deploying the code that uses it.

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS allowance_id INTEGER;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS allowance_run_id INTEGER;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS allowance_due_day INTEGER;
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS allowance_alert_phones TEXT;

CREATE TABLE IF NOT EXISTS allowances (
  allowance_id SERIAL PRIMARY KEY,
  church_id TEXT NOT NULL REFERENCES churches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  member_id INTEGER REFERENCES members(member_id) ON DELETE SET NULL ON UPDATE CASCADE,
  payee_name TEXT NOT NULL,
  role TEXT,
  amount DECIMAL(12,2) NOT NULL,
  fund_id INTEGER REFERENCES funds(fund_id) ON DELETE SET NULL ON UPDATE CASCADE,
  expense_cat_id INTEGER REFERENCES expense_categories(expense_cat_id) ON DELETE SET NULL ON UPDATE CASCADE,
  active BOOLEAN NOT NULL DEFAULT true,
  notes TEXT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS allowances_church_id_idx ON allowances (church_id);

CREATE TABLE IF NOT EXISTS allowance_runs (
  allowance_run_id SERIAL PRIMARY KEY,
  church_id TEXT NOT NULL REFERENCES churches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  period TEXT NOT NULL,
  worker_count INTEGER NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  created_by INTEGER,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reminded_at TIMESTAMP(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS allowance_runs_church_id_period_key ON allowance_runs (church_id, period);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  push_subscription_id SERIAL PRIMARY KEY,
  church_id TEXT NOT NULL REFERENCES churches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_key ON push_subscriptions (endpoint);
CREATE INDEX IF NOT EXISTS push_subscriptions_church_id_idx ON push_subscriptions (church_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_id_idx ON push_subscriptions (user_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_allowance_id_fkey') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_allowance_id_fkey FOREIGN KEY (allowance_id) REFERENCES allowances(allowance_id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_allowance_run_id_fkey') THEN
    ALTER TABLE expenses ADD CONSTRAINT expenses_allowance_run_id_fkey FOREIGN KEY (allowance_run_id) REFERENCES allowance_runs(allowance_run_id) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
