-- Canonical human roles. Fixed ids make clean installs deterministic; the
-- name-based lookup below also preserves a pre-existing canonical row.
INSERT OR IGNORE INTO "RolePermission" ("id", "name", "description", "createdAt", "updatedAt")
VALUES
  ('human-role-owner', 'owner', 'Mission Control Owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('human-role-admin', 'admin', 'Scoped human administrator', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('human-role-customer', 'customer', 'Customer-facing project member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Ownership remains authoritative. Every other human fails closed to Customer;
-- browser-authenticated agent accounts stay outside human-role authority.
UPDATE "User"
SET "rolePermissionId" = (SELECT "id" FROM "RolePermission" WHERE "name" = 'owner')
WHERE "kind" = 'human' AND "is_owner" = 1;

UPDATE "User"
SET "rolePermissionId" = (SELECT "id" FROM "RolePermission" WHERE "name" = 'customer')
WHERE "kind" = 'human' AND "is_owner" = 0;

UPDATE "User"
SET "rolePermissionId" = NULL
WHERE "kind" <> 'human';

-- Legacy placeholder roles are no longer authority-bearing after the backfill.
DELETE FROM "RolePermission"
WHERE "name" NOT IN ('owner', 'admin', 'customer');

CREATE INDEX "User_rolePermissionId_idx" ON "User"("rolePermissionId");
