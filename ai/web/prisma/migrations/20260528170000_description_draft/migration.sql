-- DescriptionDraft (HOMELAB-41 / item 4) — replaces the filesystem-based
-- .data/drafts store with a requester-bound, heartbeat-reaped table.

CREATE TABLE "DescriptionDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "DescriptionDraft_scope_targetId_requesterUserId_key"
  ON "DescriptionDraft"("scope", "targetId", "requesterUserId");

CREATE INDEX "DescriptionDraft_expiresAt_idx"
  ON "DescriptionDraft"("expiresAt");

CREATE INDEX "DescriptionDraft_lastSeenAt_idx"
  ON "DescriptionDraft"("lastSeenAt");
