-- Attendance by day-born or organization (see prisma/schema.prisma: Event.attendanceDayBorn, Event.attendanceOrgId).
-- Additive and safe to run twice; run it on production, as the database owner,
-- BEFORE deploying the code that uses it.

ALTER TABLE events ADD COLUMN IF NOT EXISTS attendance_day_born "DayBorn";
ALTER TABLE events ADD COLUMN IF NOT EXISTS attendance_org_id INTEGER REFERENCES organizations(org_id) ON DELETE SET NULL ON UPDATE CASCADE;
