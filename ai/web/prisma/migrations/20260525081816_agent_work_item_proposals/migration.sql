-- CreateTable
CREATE TABLE "WorkItemProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "grantMessageId" TEXT,
    "proposedByUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "summary" TEXT,
    "operations" TEXT NOT NULL,
    "validation" TEXT,
    "appliedById" TEXT,
    "appliedAt" DATETIME,
    "rejectedById" TEXT,
    "rejectedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkItemProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkItemProposal_proposedByUserId_fkey" FOREIGN KEY ("proposedByUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkItemProposal_appliedById_fkey" FOREIGN KEY ("appliedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "WorkItemProposal_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentSessionBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "openclawSessionKey" TEXT NOT NULL,
    "openclawSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AgentSessionBinding" ("agentSlug", "createdAt", "id", "openclawSessionId", "openclawSessionKey", "scopeId", "scopeType", "updatedAt") SELECT "agentSlug", "createdAt", "id", "openclawSessionId", "openclawSessionKey", "scopeId", "scopeType", "updatedAt" FROM "AgentSessionBinding";
DROP TABLE "AgentSessionBinding";
ALTER TABLE "new_AgentSessionBinding" RENAME TO "AgentSessionBinding";
CREATE UNIQUE INDEX "AgentSessionBinding_openclawSessionKey_key" ON "AgentSessionBinding"("openclawSessionKey");
CREATE INDEX "AgentSessionBinding_agentSlug_idx" ON "AgentSessionBinding"("agentSlug");
CREATE INDEX "AgentSessionBinding_openclawSessionId_idx" ON "AgentSessionBinding"("openclawSessionId");
CREATE UNIQUE INDEX "AgentSessionBinding_scopeType_scopeId_agentSlug_key" ON "AgentSessionBinding"("scopeType", "scopeId", "agentSlug");
CREATE TABLE "new_AttachmentExtract" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceAttachmentId" TEXT,
    "sha256" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "text" TEXT,
    "summary" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AttachmentExtract" ("createdAt", "error", "extractorVersion", "id", "sha256", "sourceAttachmentId", "status", "summary", "text", "updatedAt") SELECT "createdAt", "error", "extractorVersion", "id", "sha256", "sourceAttachmentId", "status", "summary", "text", "updatedAt" FROM "AttachmentExtract";
DROP TABLE "AttachmentExtract";
ALTER TABLE "new_AttachmentExtract" RENAME TO "AttachmentExtract";
CREATE INDEX "AttachmentExtract_sourceAttachmentId_idx" ON "AttachmentExtract"("sourceAttachmentId");
CREATE INDEX "AttachmentExtract_status_idx" ON "AttachmentExtract"("status");
CREATE UNIQUE INDEX "AttachmentExtract_sha256_extractorVersion_key" ON "AttachmentExtract"("sha256", "extractorVersion");
CREATE TABLE "new_DirectAgentChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentSlug" TEXT NOT NULL,
    "senderUserId" TEXT NOT NULL,
    "archiveId" TEXT,
    "baseArchiveId" TEXT,
    "body" TEXT NOT NULL,
    "projectId" TEXT,
    "allowWorkItemManagement" BOOLEAN NOT NULL DEFAULT false,
    "workItemGrantUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DirectAgentChatMessage_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DirectAgentChatMessage_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "DirectAgentChatArchive" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DirectAgentChatMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DirectAgentChatMessage" ("agentSlug", "archiveId", "baseArchiveId", "body", "createdAt", "id", "senderUserId") SELECT "agentSlug", "archiveId", "baseArchiveId", "body", "createdAt", "id", "senderUserId" FROM "DirectAgentChatMessage";
DROP TABLE "DirectAgentChatMessage";
ALTER TABLE "new_DirectAgentChatMessage" RENAME TO "DirectAgentChatMessage";
CREATE INDEX "DirectAgentChatMessage_agentSlug_createdAt_idx" ON "DirectAgentChatMessage"("agentSlug", "createdAt");
CREATE INDEX "DirectAgentChatMessage_agentSlug_archiveId_createdAt_idx" ON "DirectAgentChatMessage"("agentSlug", "archiveId", "createdAt");
CREATE INDEX "DirectAgentChatMessage_agentSlug_baseArchiveId_createdAt_idx" ON "DirectAgentChatMessage"("agentSlug", "baseArchiveId", "createdAt");
CREATE INDEX "DirectAgentChatMessage_archiveId_createdAt_idx" ON "DirectAgentChatMessage"("archiveId", "createdAt");
CREATE INDEX "DirectAgentChatMessage_senderUserId_idx" ON "DirectAgentChatMessage"("senderUserId");
CREATE INDEX "DirectAgentChatMessage_projectId_idx" ON "DirectAgentChatMessage"("projectId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "WorkItemProposal_planId_key" ON "WorkItemProposal"("planId");

-- CreateIndex
CREATE INDEX "WorkItemProposal_projectId_status_idx" ON "WorkItemProposal"("projectId", "status");

-- CreateIndex
CREATE INDEX "WorkItemProposal_agentSlug_idx" ON "WorkItemProposal"("agentSlug");

-- CreateIndex
CREATE INDEX "WorkItemProposal_grantMessageId_idx" ON "WorkItemProposal"("grantMessageId");
