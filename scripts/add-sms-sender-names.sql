-- Each church can ask for its own SMS sender name (Settings › SMS sender
-- name); the platform operator approves it after registering it with the SMS
-- provider (/platform). Additive and safe to run twice; run it on production
-- before deploying the code that uses it.
--
-- Paste these lines into the Neon console's SQL Editor (production branch).
-- Check: SELECT column_name FROM information_schema.columns
--          WHERE table_name = 'churches' AND column_name LIKE 'sms_sender%';
ALTER TABLE churches ADD COLUMN IF NOT EXISTS sms_sender_id TEXT;
ALTER TABLE churches ADD COLUMN IF NOT EXISTS sms_sender_status TEXT;
ALTER TABLE churches ADD COLUMN IF NOT EXISTS sms_sender_note TEXT;
