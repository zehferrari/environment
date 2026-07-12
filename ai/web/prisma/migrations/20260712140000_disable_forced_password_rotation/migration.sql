-- Passwords are active immediately. Retain the legacy column for compatibility,
-- but clear existing rotation flags and make all future defaults false.
--
-- SQLite requires a table rebuild to change a column default. This definition
-- is generated from the current User model and preserves every column, foreign
-- key, unique constraint, and index.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "avatar" BLOB,
    "avatarUpdatedAt" DATETIME,
    "passwordHash" TEXT,
    "passwordSetAt" DATETIME,
    "mustRotatePassword" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "is_owner" BOOLEAN NOT NULL DEFAULT false,
    "rolePermissionId" TEXT,
    "agentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_rolePermissionId_fkey" FOREIGN KEY ("rolePermissionId") REFERENCES "RolePermission" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "User_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_User" ("agentId", "avatar", "avatarUpdatedAt", "createdAt", "email", "id", "is_owner", "kind", "mustRotatePassword", "name", "passwordHash", "passwordSetAt", "rolePermissionId", "status", "updatedAt", "username") SELECT "agentId", "avatar", "avatarUpdatedAt", "createdAt", "email", "id", "is_owner", "kind", false AS "mustRotatePassword", "name", "passwordHash", "passwordSetAt", "rolePermissionId", "status", "updatedAt", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_agentId_key" ON "User"("agentId");
CREATE INDEX "User_kind_idx" ON "User"("kind");
CREATE INDEX "User_status_idx" ON "User"("status");
CREATE INDEX "User_is_owner_idx" ON "User"("is_owner");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
