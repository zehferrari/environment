CREATE TABLE "AgentSessionBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "openclawSessionKey" TEXT NOT NULL,
    "openclawSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "AgentSessionBinding_openclawSessionKey_key" ON "AgentSessionBinding"("openclawSessionKey");
CREATE UNIQUE INDEX "AgentSessionBinding_scopeType_scopeId_agentSlug_key" ON "AgentSessionBinding"("scopeType", "scopeId", "agentSlug");
CREATE INDEX "AgentSessionBinding_agentSlug_idx" ON "AgentSessionBinding"("agentSlug");
CREATE INDEX "AgentSessionBinding_openclawSessionId_idx" ON "AgentSessionBinding"("openclawSessionId");
