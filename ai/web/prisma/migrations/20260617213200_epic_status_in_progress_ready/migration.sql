-- Rename Epic status Open to In Progress and introduce Ready to Deploy.
-- Epic statuses remain stored as text, so existing rows need a data backfill.
UPDATE "Epic"
SET "status" = 'In Progress'
WHERE "status" = 'Open';
