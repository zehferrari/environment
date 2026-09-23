ALTER TABLE "SubTask" ADD COLUMN "groupKey" TEXT NOT NULL DEFAULT 'initial';
-- Existing correction history identifies its source feedback unambiguously.
UPDATE "SubTask" SET "groupKey" = 'feedback:' || (
 SELECT "reviewRunId" FROM "ReviewFinding" WHERE "subTaskId" = "SubTask"."id"
) WHERE EXISTS (SELECT 1 FROM "ReviewFinding" WHERE "subTaskId" = "SubTask"."id");
-- Ordinary review topics belong to the review that existed when created.
-- Deferred plan checks remain in the initial acceptance group.
UPDATE "SubTask" SET "groupKey" = 'review:' || (
 SELECT "id" FROM "review_runs" WHERE "task_id" = "SubTask"."taskId" AND "created_at" <= "SubTask"."createdAt"
 ORDER BY "created_at" DESC, "id" DESC LIMIT 1
) WHERE "kind" = 'review' AND "groupKey" = 'initial' AND "action_plan_step_id" IS NULL
 AND EXISTS (SELECT 1 FROM "review_runs" WHERE "task_id" = "SubTask"."taskId" AND "created_at" <= "SubTask"."createdAt");
DROP INDEX "SubTask_taskId_kind_text_key";
CREATE UNIQUE INDEX "SubTask_taskId_kind_groupKey_text_key" ON "SubTask"("taskId", "kind", "groupKey", "text");
-- A group supplies context, so correction titles need no global numbering.
UPDATE "SubTask" SET "text" = (SELECT "title" FROM "ReviewFinding" WHERE "subTaskId" = "SubTask"."id")
WHERE EXISTS (SELECT 1 FROM "ReviewFinding" WHERE "subTaskId" = "SubTask"."id");
