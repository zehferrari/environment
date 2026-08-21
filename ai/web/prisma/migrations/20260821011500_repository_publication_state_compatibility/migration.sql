-- ENV-155 deployment compatibility.
--
-- 20260819070000_phase_e_repo_correlation originally added
-- publication_state/replay_count. Databases that applied that migration
-- before the later-added ENV-159 lifecycle migration subsequently lost those
-- physical columns when ENV-159 rebuilt task_repository_runs, while Prisma's
-- migration ledger still correctly recorded both migrations as applied.
--
-- Fresh physical names make this forward-only repair safe for both affected
-- databases and clean installations; the Prisma field names stay unchanged.

ALTER TABLE "task_repository_runs" ADD COLUMN "publication_state_v2" TEXT;
ALTER TABLE "task_repository_runs" ADD COLUMN "replay_count_v2" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "task_repository_runs_publication_state_v2_idx"
  ON "task_repository_runs"("publication_state_v2");
