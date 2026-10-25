-- Each church can choose its own member ID prefix (prisma/schema.prisma,
-- FinanceSetting.memberPrefix). Additive and safe to run twice; run it on
-- production before deploying the code that uses it.
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS member_prefix TEXT NOT NULL DEFAULT 'MBR';
