-- ENV-121 (third review) — the successor half of the rollover seal, made durable.
--
-- Sealing a barrier consumed `barrier_released_at` in one transaction and then
-- scheduled the successor continuation in another. If the scheduling half threw,
-- the process died between the two, or no run row matched the fenced message,
-- the barrier was permanently consumed with no successor armed — and the
-- unsealed-barrier sweeper only looks for `barrier_released_at IS NULL`, so it
-- could not see, let alone repair, that state. The task stalled.
--
-- `successor_scheduled_at` records the scheduling half explicitly, so
-- "consumed but unscheduled" is an observable, recoverable row rather than an
-- invisible dead end. The attempt counter bounds the retry so a row that can
-- never be scheduled does not spin in every worker pass.

ALTER TABLE "task_execution_episodes" ADD COLUMN "successor_scheduled_at" DATETIME;
ALTER TABLE "task_execution_episodes" ADD COLUMN "successor_schedule_attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "task_execution_episodes_successor_scheduled_at_idx" ON "task_execution_episodes"("successor_scheduled_at");
