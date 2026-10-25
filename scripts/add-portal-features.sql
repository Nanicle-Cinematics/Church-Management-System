-- Everything the operator portal's new features need, in one go (see
-- prisma/schema.prisma): Pro renewal reminders, the payment log, the SMS
-- balance alert and usage/allowances, trial-enquiry follow-up, churches at
-- risk (last sign-in), announcements, error triage and "view as church".
-- Additive and safe to run twice; run it on production before deploying the
-- code that uses it. Columns and tables the deployed code doesn't use yet
-- are simply left alone until their feature arrives.
--
-- Paste the whole file into the Neon console's SQL Editor (production branch).
-- Check: SELECT table_name FROM information_schema.tables
--          WHERE table_name IN ('platform_payments', 'sms_usage', 'platform_settings', 'platform_announcements');
--        (four rows)

ALTER TABLE churches ADD COLUMN IF NOT EXISTS pro_reminder_stage TEXT;
ALTER TABLE churches ADD COLUMN IF NOT EXISTS pro_reminder_for TIMESTAMP(3);
ALTER TABLE churches ADD COLUMN IF NOT EXISTS sms_monthly_allowance INTEGER;
ALTER TABLE churches ADD COLUMN IF NOT EXISTS support_access_until TIMESTAMP(3);
ALTER TABLE churches ADD COLUMN IF NOT EXISTS support_access_granted_by INTEGER;

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP(3);

ALTER TABLE trial_signups ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMP(3);
ALTER TABLE trial_signups ADD COLUMN IF NOT EXISTS converted_church_id TEXT;
ALTER TABLE trial_signups ADD COLUMN IF NOT EXISTS operator_note TEXT;

ALTER TABLE error_log ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP(3);
ALTER TABLE error_log ADD COLUMN IF NOT EXISTS resolved_by TEXT;

CREATE TABLE IF NOT EXISTS platform_payments (
  payment_id SERIAL PRIMARY KEY,
  payer_church_id TEXT REFERENCES churches(id) ON DELETE SET NULL ON UPDATE CASCADE,
  church_name TEXT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  months INTEGER,
  paid_on DATE NOT NULL,
  note TEXT,
  recorded_by TEXT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS platform_payments_payer_church_id_idx ON platform_payments (payer_church_id);
CREATE INDEX IF NOT EXISTS platform_payments_paid_on_idx ON platform_payments (paid_on);

CREATE TABLE IF NOT EXISTS sms_usage (
  church_id TEXT NOT NULL REFERENCES churches(id) ON DELETE CASCADE ON UPDATE CASCADE,
  month TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  segments INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(3) NOT NULL,
  CONSTRAINT sms_usage_pkey PRIMARY KEY (church_id, month)
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_announcements (
  announcement_id SERIAL PRIMARY KEY,
  message TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  starts_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ends_at TIMESTAMP(3),
  created_by TEXT,
  emailed_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
