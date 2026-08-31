-- ENV-168 — access-policy epoch on User.
-- Bumped in-transaction by every access-management mutation
-- (invite/grant/revoke/promote/demote). Viewer-scoped policy streams compare
-- it against the database value to detect missed changes; see
-- ai/web/lib/users/access-change-hub.ts for the propagation contract.
ALTER TABLE "User" ADD COLUMN "policyVersion" INTEGER NOT NULL DEFAULT 0;
