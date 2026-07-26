-- "Ready to Deploy" moves off the Epic WORKFLOW status onto the separate
-- deployment field. The epic workflow lifecycle is now Backlog -> To Do ->
-- In Progress -> Done (mirroring Tasks); deployment is an optional post-Done
-- step expressed through deployment_status.
--
-- Backfill existing epics parked in the old "Ready to Deploy" workflow status:
-- they are Done (all their work is complete) and opted into the deploy step.
-- Epic statuses are stored as free text, so this is a data-only migration.
UPDATE "Epic"
SET "deployment_status" = 'Ready to Deploy',
    "status" = 'Done'
WHERE "status" = 'Ready to Deploy';
