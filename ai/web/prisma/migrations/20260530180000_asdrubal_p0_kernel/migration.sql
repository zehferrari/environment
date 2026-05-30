-- Durable P0 kernel for native PM-channel dispatch, replayable streams,
-- and prompt-safe context grants.

ALTER TABLE "PmChannelRun" ADD COLUMN "streamSeq" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PmChannelJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedBy" TEXT,
    "claimedAt" DATETIME,
    "acceptedAt" DATETIME,
    "completedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PmChannelJob_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PmChannelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PmChannelStreamEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PmChannelStreamEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PmChannelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ContextGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "runId" TEXT,
    "agentSlug" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "includes" TEXT NOT NULL,
    "maxBytes" INTEGER NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContextGrant_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PmChannelRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PmChannelJob_runId_key" ON "PmChannelJob"("runId");
CREATE INDEX "PmChannelJob_agentSlug_idx" ON "PmChannelJob"("agentSlug");
CREATE INDEX "PmChannelJob_status_availableAt_idx" ON "PmChannelJob"("status", "availableAt");
CREATE INDEX "PmChannelJob_claimedAt_idx" ON "PmChannelJob"("claimedAt");
CREATE INDEX "PmChannelJob_createdAt_idx" ON "PmChannelJob"("createdAt");

CREATE UNIQUE INDEX "PmChannelStreamEvent_runId_seq_key" ON "PmChannelStreamEvent"("runId", "seq");
CREATE INDEX "PmChannelStreamEvent_runId_createdAt_idx" ON "PmChannelStreamEvent"("runId", "createdAt");
CREATE INDEX "PmChannelStreamEvent_kind_idx" ON "PmChannelStreamEvent"("kind");
CREATE INDEX "PmChannelStreamEvent_createdAt_idx" ON "PmChannelStreamEvent"("createdAt");

CREATE UNIQUE INDEX "ContextGrant_tokenHash_key" ON "ContextGrant"("tokenHash");
CREATE INDEX "ContextGrant_agentSlug_idx" ON "ContextGrant"("agentSlug");
CREATE INDEX "ContextGrant_scopeType_scopeId_idx" ON "ContextGrant"("scopeType", "scopeId");
CREATE INDEX "ContextGrant_runId_idx" ON "ContextGrant"("runId");
CREATE INDEX "ContextGrant_expiresAt_idx" ON "ContextGrant"("expiresAt");
