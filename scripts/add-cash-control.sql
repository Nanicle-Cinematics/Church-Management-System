-- Cash count sheets and bank deposits (finance → Cash control).
--
-- Apply to every long-lived database BEFORE the code that uses it is merged:
-- the new code selects these tables and the deposit_id columns, and fails on
-- a database without them. Old code ignores them, so applying first is safe.
--
-- Additive and idempotent: running it twice changes nothing the second time.
-- Every statement matches what `prisma migrate diff` generates for the schema,
-- so `prisma migrate diff --from-url ... --exit-code` agrees afterwards.
-- Do not use a bare `prisma db push` instead: the unmanaged `session` table
-- makes it unsafe on this project.

BEGIN;

DO $$ BEGIN
  CREATE TYPE "CashCountStatus" AS ENUM ('COUNTED', 'VERIFIED', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "BankDepositStatus" AS ENUM ('PENDING', 'DEPOSITED', 'VERIFIED', 'VOIDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Which deposit banked a collection (null until it is banked).
ALTER TABLE income_records       ADD COLUMN IF NOT EXISTS deposit_id INTEGER;
ALTER TABLE day_born_collections ADD COLUMN IF NOT EXISTS deposit_id INTEGER;
ALTER TABLE tithes               ADD COLUMN IF NOT EXISTS deposit_id INTEGER;
ALTER TABLE services             ADD COLUMN IF NOT EXISTS deposit_id INTEGER;

CREATE TABLE IF NOT EXISTS cash_count_sheets (
  sheet_id        SERIAL NOT NULL,
  church_id       TEXT NOT NULL,
  sheet_no        TEXT NOT NULL,
  service_date    DATE NOT NULL,
  service_label   TEXT,
  collection      TEXT NOT NULL,
  fund_id         INTEGER,
  expected_amount DOUBLE PRECISION,
  counted_amount  DOUBLE PRECISION NOT NULL,
  counted_by      TEXT NOT NULL,
  witnessed_by    TEXT,
  received_by     TEXT,
  notes           TEXT,
  status          "CashCountStatus" NOT NULL DEFAULT 'COUNTED',
  entered_by      INTEGER,
  verified_by     INTEGER,
  verified_at     TIMESTAMP(3),
  voided_by       INTEGER,
  voided_at       TIMESTAMP(3),
  void_reason     TEXT,
  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT cash_count_sheets_pkey PRIMARY KEY (sheet_id),
  CONSTRAINT cash_count_sheets_church_id_fkey FOREIGN KEY (church_id)
    REFERENCES churches(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS cash_count_lines (
  line_id      SERIAL NOT NULL,
  church_id    TEXT NOT NULL,
  sheet_id     INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  denomination DOUBLE PRECISION NOT NULL,
  quantity     INTEGER NOT NULL,
  amount       DOUBLE PRECISION NOT NULL,
  CONSTRAINT cash_count_lines_pkey PRIMARY KEY (line_id),
  CONSTRAINT cash_count_lines_church_id_fkey FOREIGN KEY (church_id)
    REFERENCES churches(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT cash_count_lines_sheet_id_fkey FOREIGN KEY (sheet_id)
    REFERENCES cash_count_sheets(sheet_id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS bank_deposits (
  deposit_id           SERIAL NOT NULL,
  church_id            TEXT NOT NULL,
  deposit_no           TEXT NOT NULL,
  deposit_date         DATE NOT NULL,
  amount               DOUBLE PRECISION NOT NULL,
  bank_name            TEXT NOT NULL,
  account_number       TEXT,
  slip_no              TEXT,
  deposited_by         TEXT NOT NULL,
  collections_included TEXT,
  fund_id              INTEGER,
  notes                TEXT,
  status               "BankDepositStatus" NOT NULL DEFAULT 'PENDING',
  recorded_by          INTEGER,
  verified_by          INTEGER,
  verified_at          TIMESTAMP(3),
  journal_entry_id     INTEGER,
  voided_by            INTEGER,
  voided_at            TIMESTAMP(3),
  void_reason          TEXT,
  created_at           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT bank_deposits_pkey PRIMARY KEY (deposit_id),
  CONSTRAINT bank_deposits_church_id_fkey FOREIGN KEY (church_id)
    REFERENCES churches(id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS cash_count_sheets_church_id_idx    ON cash_count_sheets(church_id);
CREATE INDEX IF NOT EXISTS cash_count_sheets_service_date_idx ON cash_count_sheets(service_date);
CREATE UNIQUE INDEX IF NOT EXISTS cash_count_sheets_church_id_sheet_no_key ON cash_count_sheets(church_id, sheet_no);
CREATE INDEX IF NOT EXISTS cash_count_lines_church_id_idx     ON cash_count_lines(church_id);
CREATE INDEX IF NOT EXISTS cash_count_lines_sheet_id_idx      ON cash_count_lines(sheet_id);
CREATE INDEX IF NOT EXISTS bank_deposits_church_id_idx        ON bank_deposits(church_id);
CREATE INDEX IF NOT EXISTS bank_deposits_deposit_date_idx     ON bank_deposits(deposit_date);
CREATE UNIQUE INDEX IF NOT EXISTS bank_deposits_church_id_deposit_no_key ON bank_deposits(church_id, deposit_no);
CREATE INDEX IF NOT EXISTS income_records_deposit_id_idx       ON income_records(deposit_id);
CREATE INDEX IF NOT EXISTS day_born_collections_deposit_id_idx ON day_born_collections(deposit_id);
CREATE INDEX IF NOT EXISTS tithes_deposit_id_idx               ON tithes(deposit_id);
CREATE INDEX IF NOT EXISTS services_deposit_id_idx             ON services(deposit_id);

COMMIT;
