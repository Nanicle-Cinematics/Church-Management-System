-- A church can turn off the welcome animation after sign-in (see prisma/schema.prisma:
-- Church.welcomeAnimation). On by default, so nothing changes until an admin turns it off.
-- Additive and safe to run twice; run it on production, as the database owner, BEFORE
-- deploying the code that uses it.

ALTER TABLE churches ADD COLUMN IF NOT EXISTS welcome_animation BOOLEAN NOT NULL DEFAULT TRUE;
