-- A project's work mode governs every Epic and Task below it. Existing
-- projects remain repository-backed unless explicitly changed.
ALTER TABLE "Project" ADD COLUMN "work_mode" TEXT NOT NULL DEFAULT 'repository';

-- Tasks can require attachment evidence before entering Review.
ALTER TABLE "Task" ADD COLUMN "review_attachment_required" BOOLEAN NOT NULL DEFAULT false;

-- Preserve the exact attachment evidence presented to a reviewer.
ALTER TABLE "review_runs" ADD COLUMN "attachment_snapshot" TEXT;

-- Personal is the first artifact/research project. Repository state is
-- deliberately cleared so legacy repo-path inference cannot provision Git.
UPDATE "Project"
SET "work_mode" = 'general', "repositoryPath" = NULL
WHERE "slug" = 'personal';

-- The active Trip to Brazil Epic requires deliverables on every task.
UPDATE "Task"
SET "review_attachment_required" = true
WHERE "epicId" = 'cmtm8w19d18acovei1dpvqfvm';
