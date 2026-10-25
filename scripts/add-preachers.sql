-- The preacher roster (see prisma/schema.prisma: Preacher, PreachingPlan.preacher_id).
-- Additive and safe to run twice; run it on production, as the database owner,
-- BEFORE deploying the code that uses it.

CREATE TABLE IF NOT EXISTS preachers (
  preacher_id SERIAL PRIMARY KEY,
  church_id TEXT NOT NULL REFERENCES churches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  member_id INTEGER REFERENCES members(member_id) ON DELETE SET NULL ON UPDATE CASCADE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS preachers_church_id_code_key ON preachers (church_id, code);
CREATE INDEX IF NOT EXISTS preachers_church_id_idx ON preachers (church_id);

ALTER TABLE preaching_plan ADD COLUMN IF NOT EXISTS preacher_id INTEGER REFERENCES preachers(preacher_id) ON DELETE SET NULL ON UPDATE CASCADE;
