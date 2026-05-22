-- HOMELAB-46 Slice 4: consumer-side delivery log.
-- UNIQUE(dedupeKey) implements the replay-test acceptance criterion:
-- firing the same envelope twice yields exactly one downstream wake.

CREATE TABLE "PmEventDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "dedupeKey" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "projectKey" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "targetAgentSlug" TEXT,
    "targetGatewayPort" INTEGER,
    "envelope" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" DATETIME,
    "deliveryStatus" TEXT,
    "gatewayStatus" INTEGER,
    "error" TEXT
);

CREATE UNIQUE INDEX "PmEventDelivery_dedupeKey_key" ON "PmEventDelivery"("dedupeKey");
CREATE INDEX "PmEventDelivery_eventId_idx" ON "PmEventDelivery"("eventId");
CREATE INDEX "PmEventDelivery_taskId_idx" ON "PmEventDelivery"("taskId");
CREATE INDEX "PmEventDelivery_targetAgentSlug_idx" ON "PmEventDelivery"("targetAgentSlug");
CREATE INDEX "PmEventDelivery_deliveryStatus_idx" ON "PmEventDelivery"("deliveryStatus");
CREATE INDEX "PmEventDelivery_receivedAt_idx" ON "PmEventDelivery"("receivedAt");
