-- ENV-121 (review) — the rollover barrier and the tool-cycle budget.
--
-- Exhausting an episode budget used to open episode N+1 and nothing more: the
-- same PM turn kept calling workflow actions and they were happily counted
-- against the successor, so one stable conversation could span arbitrarily
-- many nominal episodes. `exhausted_by_message_id` fences that message; it may
-- write exactly one final checkpoint, which sets `barrier_released_at`.
--
-- `tool_cycle_*` ties the budget to the finer PM-visible unit: `tool:call`
-- stream events, which is what actually grows a turn's context.

ALTER TABLE "task_execution_episodes" ADD COLUMN "tool_cycle_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "task_execution_episodes" ADD COLUMN "tool_cycle_budget" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "task_execution_episodes" ADD COLUMN "exhausted_by_message_id" TEXT;
ALTER TABLE "task_execution_episodes" ADD COLUMN "barrier_released_at" DATETIME;

-- CreateIndex
CREATE INDEX "task_execution_episodes_exhausted_by_message_id_idx" ON "task_execution_episodes"("exhausted_by_message_id");
