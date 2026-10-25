-- The Almanac and the liturgical colour (see prisma/schema.prisma: AlmanacEntry,
-- ChurchColour). Additive and safe to run twice; run it on production, as the
-- database owner, BEFORE deploying the code that uses it.

CREATE TABLE IF NOT EXISTS almanac_entries (
  almanac_id SERIAL PRIMARY KEY,
  service_date DATE NOT NULL,
  service_label TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  colour TEXT NOT NULL,
  theme TEXT,
  old_testament TEXT,
  psalm TEXT,
  epistle TEXT,
  gospel TEXT,
  hymns TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  teaching_service BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS almanac_entries_service_date_service_label_key ON almanac_entries (service_date, service_label);
CREATE INDEX IF NOT EXISTS almanac_entries_service_date_idx ON almanac_entries (service_date);

CREATE TABLE IF NOT EXISTS church_colours (
  colour_id SERIAL PRIMARY KEY,
  church_id TEXT NOT NULL REFERENCES churches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  colour TEXT NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  scope TEXT NOT NULL,
  almanac_id INTEGER,
  set_by INTEGER,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS church_colours_church_id_starts_on_ends_on_idx ON church_colours (church_id, starts_on, ends_on);
