-- Members can be marked "Distant" (prisma/schema.prisma, enum
-- MembershipStatus). Additive and safe to run twice; run it on production
-- before deploying the code that uses it.
--
-- Either paste the ALTER TYPE line below into the Neon console's SQL Editor
-- (on the production branch), or, with psql installed, run from the repo:
--   psql "$DATABASE_URL" -f scripts/add-member-status-distant.sql
-- Check: SELECT unnest(enum_range(NULL::"MembershipStatus"));  -- lists DISTANT
ALTER TYPE "MembershipStatus" ADD VALUE IF NOT EXISTS 'DISTANT' AFTER 'MEMBER';
