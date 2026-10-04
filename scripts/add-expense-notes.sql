-- Free-text notes on an expense (the create/edit forms, list and JSON API read it).
-- Additive and nullable: old code keeps working against a database that has it,
-- so APPLY THIS TO EACH DATABASE BEFORE DEPLOYING the code that selects it,
-- otherwise every expense query fails with 'column "notes" does not exist'.
-- Safe to run more than once.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS notes TEXT;
