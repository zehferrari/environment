-- Track the last PM-channel turn sent on a stable agent session so
-- follow-up chat turns can reuse the existing OpenClaw transcript and
-- send only the current message plus the hot-path delta.
ALTER TABLE "AgentSessionBinding"
ADD COLUMN "lastDispatchedMessageId" TEXT,
ADD COLUMN "lastDispatchedAt" TIMESTAMP(3);
