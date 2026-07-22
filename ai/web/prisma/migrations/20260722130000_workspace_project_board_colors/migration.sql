-- Unified workspaces board colours: workspace border + project background
-- tint. Nullable columns; existing rows are backfilled with a random pick
-- from the same palette the app uses (lib/board-colors.ts).

ALTER TABLE "Workspace" ADD COLUMN "border_color" TEXT;
ALTER TABLE "Project" ADD COLUMN "background_color" TEXT;

UPDATE "Workspace"
SET "border_color" = CASE (abs(random()) % 12)
  WHEN 0 THEN '#e11d48'
  WHEN 1 THEN '#db2777'
  WHEN 2 THEN '#9333ea'
  WHEN 3 THEN '#7c3aed'
  WHEN 4 THEN '#4f46e5'
  WHEN 5 THEN '#2563eb'
  WHEN 6 THEN '#0891b2'
  WHEN 7 THEN '#059669'
  WHEN 8 THEN '#16a34a'
  WHEN 9 THEN '#ca8a04'
  WHEN 10 THEN '#ea580c'
  ELSE '#dc2626'
END
WHERE "border_color" IS NULL;

UPDATE "Project"
SET "background_color" = CASE (abs(random()) % 12)
  WHEN 0 THEN '#e11d48'
  WHEN 1 THEN '#db2777'
  WHEN 2 THEN '#9333ea'
  WHEN 3 THEN '#7c3aed'
  WHEN 4 THEN '#4f46e5'
  WHEN 5 THEN '#2563eb'
  WHEN 6 THEN '#0891b2'
  WHEN 7 THEN '#059669'
  WHEN 8 THEN '#16a34a'
  WHEN 9 THEN '#ca8a04'
  WHEN 10 THEN '#ea580c'
  ELSE '#dc2626'
END
WHERE "background_color" IS NULL;
