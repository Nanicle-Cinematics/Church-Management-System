-- Staff can sign in with a phone number instead of an email (see
-- prisma/schema.prisma, User.phone). Additive and safe to run twice; run it
-- on production before deploying the code that uses it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_key ON users (phone);
