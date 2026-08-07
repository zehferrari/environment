-- Normalize legacy PmChannelRun status vocabulary (data-only).
--
-- ENV-117 renamed the run terminal statuses ("complete" -> "completed",
-- "canceled" -> "cancelled") and removed "retryable" from the run status set
-- (retryability now lives on PmChannelJob). Rows written before the rename
-- keep the old spellings, so they match neither the new queries (chat reply
-- gating, invariant checks, UI labels) nor the terminal-status guards. This
-- migration rewrites them in place; schema.prisma is untouched.

-- Renamed terminal statuses: adopt the new spelling and stamp finishedAt where
-- it was never recorded (mirrors the lease migration's COALESCE pattern).
UPDATE "PmChannelRun" SET
  status = 'completed',
  "finishedAt" = COALESCE("finishedAt", datetime('now'))
WHERE status = 'complete';

UPDATE "PmChannelRun" SET
  status = 'cancelled',
  "finishedAt" = COALESCE("finishedAt", datetime('now'))
WHERE status = 'canceled';

-- Legacy "retryable" runs: the status no longer exists on runs, and mapping
-- them to an active status (queued/accepted/streaming) could both violate the
-- partial unique index PmChannelRun_active_task_agent_unique and resurrect a
-- lane a newer run already owns. They fail terminally instead, with the same
-- failure timestamps failRun would have written.
UPDATE "PmChannelRun" SET
  status = 'failed',
  "failedAt" = COALESCE("failedAt", datetime('now')),
  "finishedAt" = COALESCE("finishedAt", datetime('now')),
  "finishedReason" = 'legacy_retryable_normalized'
WHERE status = 'retryable';
