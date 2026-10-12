-- Platform operators: separate from church users (see prisma/schema.prisma).
-- Additive only, safe to run before the code that uses it is deployed, and
-- safe to run twice.
CREATE TABLE IF NOT EXISTS platform_operators (
  operator_id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_recovery_codes TEXT,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMP(3),
  last_login_at TIMESTAMP(3),
  disabled_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_audit_log (
  audit_id SERIAL PRIMARY KEY,
  occurred_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operator_id INTEGER,
  operator_email TEXT,
  church_id TEXT,
  event TEXT NOT NULL,
  subject TEXT,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS platform_audit_log_occurred_at_idx ON platform_audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS platform_audit_log_church_id_idx ON platform_audit_log (church_id);
