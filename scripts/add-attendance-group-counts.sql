-- Attendance counts per day-born and per organization at each service
-- (see prisma/schema.prisma: EventGroupAttendance). Additive and safe to run twice;
-- run it on production, as the database owner, BEFORE deploying the code that uses it.

CREATE TABLE IF NOT EXISTS event_group_attendance (
  id SERIAL PRIMARY KEY,
  church_id TEXT NOT NULL REFERENCES churches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(event_id) ON DELETE CASCADE ON UPDATE CASCADE,
  day_born "DayBorn",
  org_id INTEGER REFERENCES organizations(org_id) ON DELETE CASCADE ON UPDATE CASCADE,
  count INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS event_group_attendance_event_id_day_born_key ON event_group_attendance (event_id, day_born);
CREATE UNIQUE INDEX IF NOT EXISTS event_group_attendance_event_id_org_id_key ON event_group_attendance (event_id, org_id);
CREATE INDEX IF NOT EXISTS event_group_attendance_church_id_idx ON event_group_attendance (church_id);
