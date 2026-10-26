-- The welcome animation can be one of several styles, in a colour the church chooses (see
-- prisma/schema.prisma: Church.welcomeStyle, welcomeColour). 'pop' is what every church has now;
-- no colour means "use the colours of the church's logo". Additive and safe to run twice; run it
-- on production, as the database owner, BEFORE deploying the code that uses it.

ALTER TABLE churches ADD COLUMN IF NOT EXISTS welcome_style TEXT NOT NULL DEFAULT 'pop';
ALTER TABLE churches ADD COLUMN IF NOT EXISTS welcome_colour TEXT;
