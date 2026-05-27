-- Add archive/bin support for Task and Epic scoped multi-agent chat rooms.
-- Active room messages keep archiveId NULL; archiving creates a room snapshot
-- row and attaches the current active messages to it.

CREATE TABLE "AgentChatRoomArchive" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "epicId" TEXT,
    "archivedById" TEXT NOT NULL,
    "deletedById" TEXT,
    "summary" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME NOT NULL,
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentChatRoomArchive_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentChatRoomArchive_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentChatRoomArchive_epicId_fkey" FOREIGN KEY ("epicId") REFERENCES "Epic" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentChatRoomArchive_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AgentChatRoomArchive_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "AgentChatMessage" ADD COLUMN "archiveId" TEXT;

CREATE INDEX "AgentChatRoomArchive_projectId_taskId_deletedAt_createdAt_idx" ON "AgentChatRoomArchive"("projectId", "taskId", "deletedAt", "createdAt");
CREATE INDEX "AgentChatRoomArchive_projectId_epicId_deletedAt_createdAt_idx" ON "AgentChatRoomArchive"("projectId", "epicId", "deletedAt", "createdAt");
CREATE INDEX "AgentChatRoomArchive_taskId_createdAt_idx" ON "AgentChatRoomArchive"("taskId", "createdAt");
CREATE INDEX "AgentChatRoomArchive_epicId_createdAt_idx" ON "AgentChatRoomArchive"("epicId", "createdAt");
CREATE INDEX "AgentChatRoomArchive_archivedById_idx" ON "AgentChatRoomArchive"("archivedById");
CREATE INDEX "AgentChatRoomArchive_deletedById_idx" ON "AgentChatRoomArchive"("deletedById");

CREATE INDEX "AgentChatMessage_taskId_archiveId_createdAt_idx" ON "AgentChatMessage"("taskId", "archiveId", "createdAt");
CREATE INDEX "AgentChatMessage_epicId_archiveId_createdAt_idx" ON "AgentChatMessage"("epicId", "archiveId", "createdAt");
CREATE INDEX "AgentChatMessage_archiveId_createdAt_idx" ON "AgentChatMessage"("archiveId", "createdAt");
