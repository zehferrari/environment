ALTER TABLE "ActionPlan" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ActionPlan" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "ActionPlan" ADD COLUMN "authorId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ActionPlan" ADD COLUMN "sourceRunId" TEXT;
ALTER TABLE "ActionPlan" ADD COLUMN "sourceMessageId" TEXT;
ALTER TABLE "ActionPlan" ADD COLUMN "contentHash" TEXT NOT NULL DEFAULT '';

ALTER TABLE "SubTask" ADD COLUMN "action_plan_step_id" TEXT REFERENCES "ActionPlanStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Reconcile exact legacy duplicates before enforcing idempotent checklist
-- materialization. Prefer a completed row, then the earliest surviving row.
DELETE FROM "SubTask"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "taskId", "kind", "text"
        ORDER BY CASE WHEN "completedAt" IS NOT NULL THEN 0 ELSE 1 END, "createdAt", "id"
      ) AS rn
    FROM "SubTask"
  )
  WHERE rn > 1
);

CREATE UNIQUE INDEX "SubTask_taskId_kind_text_key" ON "SubTask"("taskId", "kind", "text");
CREATE UNIQUE INDEX "SubTask_action_plan_step_id_key" ON "SubTask"("action_plan_step_id");
CREATE INDEX "ActionPlan_authorId_idx" ON "ActionPlan"("authorId");
CREATE INDEX "ActionPlan_sourceRunId_idx" ON "ActionPlan"("sourceRunId");

CREATE TABLE "ActionPlanRevision" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actionPlanId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "summary" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "authorId" TEXT,
  "sourceRunId" TEXT,
  "sourceMessageId" TEXT,
  "contentHash" TEXT NOT NULL,
  "approvedOn" DATETIME,
  "approvedById" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActionPlanRevision_actionPlanId_fkey" FOREIGN KEY ("actionPlanId") REFERENCES "ActionPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ActionPlanRevision_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ActionPlanRevision_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "ActionPlanRevision_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ActionPlanRevisionStep" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "revisionId" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "acceptanceCriteria" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'sequential',
  "assigneeId" TEXT,
  "rank" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActionPlanRevisionStep_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "ActionPlanRevision" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ActionPlanRevisionStep_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ActionPlanRevision_taskId_version_key" ON "ActionPlanRevision"("taskId", "version");
CREATE UNIQUE INDEX "ActionPlanRevision_actionPlanId_version_key" ON "ActionPlanRevision"("actionPlanId", "version");
CREATE INDEX "ActionPlanRevision_authorId_idx" ON "ActionPlanRevision"("authorId");
CREATE INDEX "ActionPlanRevision_approvedById_idx" ON "ActionPlanRevision"("approvedById");
CREATE INDEX "ActionPlanRevision_sourceRunId_idx" ON "ActionPlanRevision"("sourceRunId");
CREATE UNIQUE INDEX "ActionPlanRevisionStep_revisionId_stepId_key" ON "ActionPlanRevisionStep"("revisionId", "stepId");
CREATE INDEX "ActionPlanRevisionStep_revisionId_rank_idx" ON "ActionPlanRevisionStep"("revisionId", "rank");
CREATE INDEX "ActionPlanRevisionStep_assigneeId_idx" ON "ActionPlanRevisionStep"("assigneeId");

-- Preserve the content of plans created before revision tracking. Their
-- content hash is intentionally marked legacy rather than fabricated.
INSERT INTO "ActionPlanRevision" (
  "id", "actionPlanId", "taskId", "version", "summary", "status",
  "authorId", "sourceRunId", "sourceMessageId", "contentHash",
  "approvedOn", "approvedById", "createdAt"
)
SELECT
  'legacy-' || "id", "id", "taskId", 1, "summary",
  CASE WHEN "approvedOn" IS NULL THEN 'draft' ELSE 'approved' END,
  NULL, NULL, NULL, 'legacy', "approvedOn", "approvedById", "createdAt"
FROM "ActionPlan";

INSERT INTO "ActionPlanRevisionStep" (
  "id", "revisionId", "stepId", "title", "acceptanceCriteria", "kind",
  "assigneeId", "rank", "createdAt"
)
SELECT
  'legacy-' || s."id", 'legacy-' || s."actionPlanId", s."stepId", s."title",
  s."acceptanceCriteria", s."kind", s."assigneeId", s."rank", s."createdAt"
FROM "ActionPlanStep" s;

UPDATE "ActionPlan"
SET "status" = CASE WHEN "approvedOn" IS NULL THEN 'draft' ELSE 'approved' END,
    "contentHash" = 'legacy';
