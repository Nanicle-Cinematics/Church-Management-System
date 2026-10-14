-- Members > Import holds an uploaded file here while the admin checks the
-- preview (see prisma/schema.prisma, MemberImport). Additive and safe to run
-- twice; run it on production before deploying the code that uses it.
CREATE TABLE IF NOT EXISTS member_imports (
  member_import_id SERIAL PRIMARY KEY,
  church_id TEXT NOT NULL REFERENCES churches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  user_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  headers JSONB NOT NULL,
  rows JSONB NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS member_imports_church_id_idx ON member_imports (church_id);
