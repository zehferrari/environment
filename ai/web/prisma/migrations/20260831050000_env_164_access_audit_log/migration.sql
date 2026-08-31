-- CreateAccessAuditLog
CREATE TABLE "AccessAuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorUserId" TEXT NOT NULL,
    "affectedUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "oldRole" TEXT,
    "newRole" TEXT,
    "oldProjectIds" TEXT NOT NULL DEFAULT '[]',
    "newProjectIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AccessAuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AccessAuditLog_affectedUserId_fkey" FOREIGN KEY ("affectedUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AccessAuditLog_actorUserId_idx" ON "AccessAuditLog"("actorUserId");

-- CreateIndex
CREATE INDEX "AccessAuditLog_affectedUserId_idx" ON "AccessAuditLog"("affectedUserId");

-- CreateIndex
CREATE INDEX "AccessAuditLog_createdAt_idx" ON "AccessAuditLog"("createdAt");
