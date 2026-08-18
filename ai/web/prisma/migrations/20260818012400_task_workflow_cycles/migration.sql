-- TaskWorkflowCycle: one implementation attempt from start through validation
-- and review. Cycle identity replaces the legacy ReviewRun(taskId, candidateSha)
-- uniqueness as the durable review-attempt boundary.

CREATE TABLE "task_workflow_cycles" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "outcome" TEXT,
  "opened_workflow_version" INTEGER NOT NULL,
  "closed_workflow_version" INTEGER,
  "opened_by_transition_id" TEXT,
  "closed_by_transition_id" TEXT,
  "base_sha" TEXT,
  "candidate_sha" TEXT,
  "opened_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" DATETIME,
  "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" DATETIME NOT NULL,
  CONSTRAINT "task_workflow_cycles_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "task_workflow_cycles_task_id_sequence_key" ON "task_workflow_cycles"("task_id", "sequence");
CREATE INDEX "task_workflow_cycles_task_id_status_idx" ON "task_workflow_cycles"("task_id", "status");
CREATE INDEX "task_workflow_cycles_status_updated_at_idx" ON "task_workflow_cycles"("status", "updated_at");

ALTER TABLE "Task" ADD COLUMN "active_workflow_cycle_id" TEXT;

ALTER TABLE "task_repository_runs" ADD COLUMN "workflow_cycle_id" TEXT;
ALTER TABLE "review_runs" ADD COLUMN "workflow_cycle_id" TEXT;
ALTER TABLE "workflow_transitions" ADD COLUMN "workflow_cycle_id" TEXT;
ALTER TABLE "workflow_outbox" ADD COLUMN "workflow_cycle_id" TEXT;

CREATE UNIQUE INDEX "task_repository_runs_workflow_cycle_id_key" ON "task_repository_runs"("workflow_cycle_id");
CREATE UNIQUE INDEX "review_runs_workflow_cycle_id_key" ON "review_runs"("workflow_cycle_id");
CREATE INDEX "workflow_transitions_workflow_cycle_id_idx" ON "workflow_transitions"("workflow_cycle_id");
CREATE INDEX "workflow_outbox_workflow_cycle_id_idx" ON "workflow_outbox"("workflow_cycle_id");

-- Backfill (expand phase). Derive one synthetic legacy cycle per task that has
-- any workflow transition, repository run, or review run. Sequence is derived
-- from the chronological order of workflow transitions; tasks with no
-- transitions use sequence 1. Status is closed for tasks whose latest
-- transition moved to a terminal state (Done/cancel/Backlog), open otherwise.
-- This is deterministic and idempotent: re-running the migration on an
-- already-backfilled DB produces the same rows because the cycle id is the
-- task id + a fixed sequence-derived suffix, and the unique(task_id, sequence)
-- index prevents duplicates.
--
-- Uses a CTE with row_number() window function to pick the latest transition
-- per task; avoids LATERAL which is not portable across SQLite versions.

WITH latest_transition AS (
  SELECT
    "task_id",
    "workflow_version",
    "id",
    "intent",
    "created_at",
    row_number() OVER (PARTITION BY "task_id" ORDER BY "workflow_version" DESC) AS rn
  FROM "workflow_transitions"
),
first_transition AS (
  SELECT
    "task_id",
    MIN("workflow_version") AS workflow_version,
    MIN("id") AS id,
    MIN("created_at") AS created_at
  FROM "workflow_transitions"
  GROUP BY "task_id"
)
INSERT INTO "task_workflow_cycles" (
  "id", "task_id", "sequence", "status", "outcome",
  "opened_workflow_version", "closed_workflow_version",
  "opened_by_transition_id", "closed_by_transition_id",
  "base_sha", "candidate_sha",
  "opened_at", "closed_at", "created_at", "updated_at"
)
SELECT
  'cycle_legacy_' || t.id || '_1' AS id,
  t.id AS task_id,
  1 AS sequence,
  CASE
    WHEN t.status IN ('Done') THEN 'closed'
    WHEN t.status IN ('Backlog') AND lt.intent IN ('cancel') THEN 'closed'
    ELSE 'open'
  END AS status,
  CASE
    WHEN t.status IN ('Done') THEN 'completed'
    WHEN t.status IN ('Backlog') AND lt.intent IN ('cancel') THEN 'cancelled'
    ELSE NULL
  END AS outcome,
  COALESCE(ft.workflow_version, 0) AS opened_workflow_version,
  CASE
    WHEN t.status IN ('Done') THEN COALESCE(lt.workflow_version, 0)
    WHEN lt.intent IN ('cancel') THEN lt.workflow_version
    ELSE NULL
  END AS closed_workflow_version,
  ft.id AS opened_by_transition_id,
  CASE
    WHEN t.status IN ('Done') THEN lt.id
    WHEN lt.intent IN ('cancel') THEN lt.id
    ELSE NULL
  END AS closed_by_transition_id,
  trr.base_sha AS base_sha,
  trr.candidate_sha AS candidate_sha,
  COALESCE(ft.created_at, t.createdAt) AS opened_at,
  CASE
    WHEN t.status IN ('Done') THEN COALESCE(lt.created_at, t.updatedAt)
    WHEN lt.intent IN ('cancel') THEN lt.created_at
    ELSE NULL
  END AS closed_at,
  COALESCE(ft.created_at, t.createdAt) AS created_at,
  COALESCE(lt.created_at, t.updatedAt) AS updated_at
FROM "Task" t
LEFT JOIN first_transition ft ON ft.task_id = t.id
LEFT JOIN latest_transition lt ON lt.task_id = t.id AND lt.rn = 1
LEFT JOIN "task_repository_runs" trr ON trr.task_id = t.id
WHERE t.id IN (
  SELECT DISTINCT "task_id" FROM "workflow_transitions"
  UNION
  SELECT DISTINCT "task_id" FROM "task_repository_runs"
  UNION
  SELECT DISTINCT "task_id" FROM "review_runs"
);

-- Set Task.active_workflow_cycle_id for tasks whose backfilled cycle is open.
UPDATE "Task"
SET "active_workflow_cycle_id" = 'cycle_legacy_' || "Task"."id" || '_1'
WHERE "Task"."active_workflow_cycle_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "task_workflow_cycles" c
    WHERE c.task_id = "Task"."id" AND c.status = 'open'
  );

-- Attach the backfilled cycle to existing rows. repository_runs get the latest
-- backfilled cycle for that task; review_runs get the cycle of the task
-- (candidate identity is preserved; cycle identity is what we are adding).
-- CRITICAL: only the LATEST review run per task gets the cycle id, because
-- the @@unique on review_runs.workflow_cycle_id allows only one lease per
-- cycle. Tasks with multiple historical review runs (e.g. V23-36 has 7)
-- leave older runs with workflow_cycle_id = NULL — they are historical,
-- pre-cycle rows that do not map to the synthetic legacy cycle.
UPDATE "task_repository_runs"
SET "workflow_cycle_id" = 'cycle_legacy_' || "task_repository_runs"."task_id" || '_1'
WHERE "workflow_cycle_id" IS NULL
  AND EXISTS (SELECT 1 FROM "task_workflow_cycles" c WHERE c.task_id = "task_repository_runs"."task_id");

-- Assign only the latest review run per task to the cycle. Uses a CTE with
-- row_number() to pick the most recent run by created_at.
WITH latest_review_run AS (
  SELECT
    "id",
    "task_id",
    row_number() OVER (PARTITION BY "task_id" ORDER BY "created_at" DESC) AS rn
  FROM "review_runs"
)
UPDATE "review_runs"
SET "workflow_cycle_id" = 'cycle_legacy_' || "review_runs"."task_id" || '_1'
WHERE "review_runs"."id" IN (
  SELECT "id" FROM latest_review_run WHERE rn = 1
)
  AND "review_runs"."workflow_cycle_id" IS NULL
  AND EXISTS (SELECT 1 FROM "task_workflow_cycles" c WHERE c.task_id = "review_runs"."task_id");

UPDATE "workflow_transitions"
SET "workflow_cycle_id" = 'cycle_legacy_' || "workflow_transitions"."task_id" || '_1'
WHERE "workflow_cycle_id" IS NULL
  AND EXISTS (SELECT 1 FROM "task_workflow_cycles" c WHERE c.task_id = "workflow_transitions"."task_id");

UPDATE "workflow_outbox"
SET "workflow_cycle_id" = 'cycle_legacy_' || "workflow_outbox"."task_id" || '_1'
WHERE "workflow_cycle_id" IS NULL
  AND EXISTS (SELECT 1 FROM "task_workflow_cycles" c WHERE c.task_id = "workflow_outbox"."task_id");

-- Add foreign key constraints where SQLite allows (deferred is not supported
-- on SQLite for ADD CONSTRAINT; the relations are enforced at the Prisma
-- layer via SetNull onDelete). The @unique indexes above already enforce the
-- 1:1 cycle->reviewRun and cycle->repositoryRun invariant.