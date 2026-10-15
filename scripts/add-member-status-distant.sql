-- Members can be marked "Distant" (prisma/schema.prisma, enum
-- MembershipStatus). Additive and safe to run twice; run it on production
-- before deploying the code that uses it.
--
-- ADD VALUE cannot run inside a transaction block on older Postgres, so run
-- this file on its own (psql "$DATABASE_URL" -f scripts/add-member-status-distant.sql).
ALTER TYPE "MembershipStatus" ADD VALUE IF NOT EXISTS 'DISTANT' AFTER 'MEMBER';
